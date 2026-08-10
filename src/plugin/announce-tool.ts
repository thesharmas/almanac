import { Type } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

import { buildAuditRecord, type AuditLogger } from "./audit.js";
import type { Escalator } from "./escalate.js";
import type { SlackPoster } from "./slack.js";
import { conversationId, type TenantMap } from "./tenant.js";

export const ANNOUNCE_TOOL_NAME = "announce";

/**
 * Operator broadcast: one message, verbatim, to tenant channels.
 *
 * This is the only tool that can write outside its own agent's channel, so the
 * reasoning matters more than the code.
 *
 * **It is not registered for tenant agents at all.** The factory returns
 * `null` unless `ctx.agentId` is the ops agent, so a tenant agent does not
 * have it in its toolset — a customer cannot talk their way into something
 * that is not there. That is a stronger guarantee than refusing.
 *
 * **Authorisation is membership of the ops channel**, verified two ways: the
 * turn must have arrived from that exact channel, and the channel must
 * actually be private. The second check is what makes the first mean anything
 * — in a public channel joining is one click, so membership would grant
 * nothing. Slack is asked on every call rather than trusted from config,
 * because privacy is a setting somebody can change without touching this repo.
 *
 * If Slack cannot be reached to answer, the tool refuses. That costs nothing
 * real: an announcement it could not verify is one it could not have delivered
 * either.
 *
 * **Destinations come from the tenant map**, never from the model. "everyone"
 * expands to configured channels; a named target resolves to one. There is no
 * way to express a channel the deployment is not already configured for.
 *
 * **Nothing sends on the first call.** A model in the path may reword what it
 * was told, so the first call returns a preview of the exact bytes and the
 * exact channel list, plus a one-time token. Only a second call carrying that
 * token sends. The operator approves what will actually go out, rather than
 * what they meant.
 */

export interface AnnounceDeps {
  readonly tenantMap: TenantMap;
  /** The ops channel. A turn from anywhere else is refused. */
  readonly opsChannelId: string;
  readonly slack: SlackPoster;
  readonly escalator: Escalator;
  readonly audit: AuditLogger;
  readonly now?: () => Date;
  /** Overridable so tests are deterministic. */
  readonly makeToken?: () => string;
}

export const AnnounceParameters = Type.Object(
  {
    target: Type.String({
      minLength: 1,
      description:
        'Who to post to: "everyone" for every configured tenant channel, or a ' +
        "single agent id.",
    }),
    message: Type.String({
      minLength: 1,
      maxLength: 3000,
      description:
        "The exact text to post, verbatim. Do not summarise or rephrase what the " +
        "operator asked to send.",
    }),
    confirm: Type.Optional(
      Type.String({
        description: "The token from the preview. Omit to preview; supply it to send.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface Pending {
  readonly target: string;
  readonly message: string;
  readonly channels: readonly { agentId: string; channelId: string }[];
  readonly senderId: string;
  readonly expiresAt: number;
}

/** Pending previews live in memory only: a restart forgets them, which is correct. */
const PENDING = new Map<string, Pending>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

function defaultToken(): string {
  return Math.random().toString(16).slice(2, 6);
}

export function createAnnounceTool(
  ctx: Pick<
    OpenClawPluginToolContext,
    "agentId" | "messageChannel" | "requesterSenderId" | "deliveryContext"
  >,
  deps: AnnounceDeps,
) {
  const clock = deps.now ?? (() => new Date());
  const makeToken = deps.makeToken ?? defaultToken;

  return {
    name: ANNOUNCE_TOOL_NAME,
    label: "Announce",
    description:
      "Post an operations message to tenant channels. Call once without `confirm` " +
      "to preview it, then again with the token to send. Never reword what you " +
      "were asked to send.",
    parameters: AnnounceParameters,

    async execute(_toolCallId: string, rawParams: unknown) {
      const started = clock();
      const params = (rawParams ?? {}) as {
        target?: string;
        message?: string;
        confirm?: string;
      };
      const senderId = ctx.requesterSenderId ?? null;

      const record = (
        outcome: "success" | "refused" | "error",
        errorClass?: string,
        detail?: string,
      ) => {
        deps.audit.record(
          buildAuditRecord({
            event: "announce",
            outcome,
            agentId: ctx.agentId,
            channel: ctx.deliveryContext?.to,
            channelProvider: ctx.messageChannel,
            ...(senderId === null ? {} : { senderId }),
            ...(detail === undefined ? {} : { report: detail }),
            durationMs: clock().getTime() - started.getTime(),
            ...(errorClass === undefined ? {} : { errorClass }),
            now: started,
          }),
        );
      };

      const deny = async (errorClass: string, detail: string, reply: string) => {
        record("refused", errorClass);
        await deps.escalator.escalate({
          reason: "tenant_resolution_failure",
          detail: `announce refused (${errorClass}): ${detail}`,
          agentId: ctx.agentId,
          channel: ctx.deliveryContext?.to,
          ...(senderId === null ? {} : { senderId }),
        });
        return {
          content: [{ type: "text" as const, text: reply }],
          details: { sent: false, reason: errorClass },
        };
      };

      // Authorisation, before anything else is even parsed.
      // Two checks, and the second is what makes the first mean anything.
      const from = conversationId(ctx.deliveryContext?.to);
      if (from !== deps.opsChannelId) {
        return await deny(
          "wrong_channel",
          `announce reached from ${String(from)}, not the ops channel`,
          "Announcements can only be sent from the operations channel.",
        );
      }

      const isPrivate = await deps.slack.isPrivateChannel(deps.opsChannelId);
      if (isPrivate !== true) {
        return await deny(
          isPrivate === false ? "ops_channel_public" : "privacy_unverifiable",
          isPrivate === false
            ? `${deps.opsChannelId} is a public channel; membership authorises nothing`
            : `could not confirm ${deps.opsChannelId} is private`,
          isPrivate === false
            ? "I can't send announcements from a public channel — anyone could join it. Make this channel private and try again."
            : "I couldn't confirm this channel is private, so I haven't sent anything.",
        );
      }

      if (params.message === undefined || params.message.trim() === "") {
        return await deny(
          "empty_message",
          "no message supplied",
          "I need the exact text to send.",
        );
      }

      // ---- confirm path ----
      if (params.confirm !== undefined && params.confirm.trim() !== "") {
        const token = params.confirm.trim().toLowerCase();
        const pending = PENDING.get(token);
        if (pending === undefined) {
          return await deny(
            "unknown_token",
            `no pending announcement for ${token}`,
            "That confirmation code is not one I am holding. Ask me to preview the announcement again.",
          );
        }
        if (pending.expiresAt < clock().getTime()) {
          PENDING.delete(token);
          return await deny(
            "expired_token",
            `token ${token} expired`,
            "That confirmation has expired. Ask me to preview it again.",
          );
        }
        // The person confirming must be the person who proposed it. With
        // several people in the channel, two announcements can be in flight at
        // once and this is what keeps them apart.
        if (pending.senderId !== (senderId ?? "")) {
          return await deny(
            "wrong_confirmer",
            `token ${token} belongs to ${pending.senderId}`,
            "That confirmation belongs to someone else's announcement.",
          );
        }

        PENDING.delete(token);
        const sent: string[] = [];
        const failed: string[] = [];
        for (const channel of pending.channels) {
          const result = await deps.slack.post(channel.channelId, pending.message);
          (result.ok ? sent : failed).push(channel.agentId);
        }

        if (failed.length > 0) {
          record("error", "partial_send", pending.target);
          await deps.escalator.escalate({
            reason: "tool_failure",
            detail: `announcement sent to ${sent.join(", ") || "nothing"}; FAILED for ${failed.join(", ")}`,
            agentId: ctx.agentId,
            channel: ctx.deliveryContext?.to,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Sent to ${String(sent.length)} channel(s). FAILED for: ${failed.join(", ")}. The team has been notified.`,
              },
            ],
            details: { sent: true, delivered: sent, failed },
          };
        }

        record("success", undefined, pending.target);
        await deps.escalator.escalate({
          reason: "announcement",
          detail: `announcement sent by ${String(senderId)} to ${sent.join(", ")}: ${pending.message}`,
          agentId: ctx.agentId,
          channel: ctx.deliveryContext?.to,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent to ${String(sent.length)} channel(s): ${sent.join(", ")}.`,
            },
          ],
          details: { sent: true, delivered: sent },
        };
      }

      // ---- preview path ----
      const target = (params.target ?? "").trim();
      if (target === "") {
        return await deny(
          "no_target",
          "no target supplied",
          'Who should this go to — "everyone", or a specific channel?',
        );
      }

      const all = Object.entries(deps.tenantMap).map(([agentId, entry]) => ({
        agentId,
        channelId: entry.channelId,
      }));
      const channels =
        target.toLowerCase() === "everyone"
          ? all
          : all.filter((c) => c.agentId === target);

      if (channels.length === 0) {
        return await deny(
          "unknown_target",
          `no channel for target ${target}`,
          `I have no channel called "${target}". I can post to: everyone, ${all.map((c) => c.agentId).join(", ")}.`,
        );
      }

      const token = makeToken();
      PENDING.set(token, {
        target,
        message: params.message,
        channels,
        senderId: senderId ?? "",
        expiresAt: clock().getTime() + TOKEN_TTL_MS,
      });
      record("refused", "preview", target);

      const scope =
        target.toLowerCase() === "everyone"
          ? `*every tenant channel* (${String(channels.length)})`
          : `${String(channels.length)} channel`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `This will post to ${scope} — ${channels.map((c) => c.agentId).join(", ")}:\n\n` +
              `>>> ${params.message}\n\n` +
              `Reply \`confirm ${token}\` within 5 minutes to send. Nothing has been sent yet.`,
          },
        ],
        details: {
          sent: false,
          preview: true,
          token,
          channels: channels.map((c) => c.agentId),
        },
      };
    },
  };
}
