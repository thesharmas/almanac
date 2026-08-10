import { Type } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

import { buildAuditRecord, type AuditLogger } from "./audit.js";
import type { Escalator } from "./escalate.js";
import type { SlackPoster } from "./slack.js";
import { resolveTenant, type TenantMap } from "./tenant.js";

export const DIGEST_TOOL_NAME = "post_digest";

/**
 * Posts the scheduled digest as a headline with the detail in a thread.
 *
 * Why a tool at all: a scheduled job delivers one message, and a thread is two
 * posts. The Gateway's thread settings govern how the bot *reads* thread
 * history, not self-threading a scheduled post — so the plugin makes both
 * calls itself.
 *
 * The security boundary, stated precisely because this is the first tool that
 * writes anywhere:
 *
 *  - The channel is NOT a parameter. It is resolved from the tenant map via
 *    the host-trusted `ctx.agentId`, exactly like the tenant id. The model
 *    chooses the words; it cannot choose the destination.
 *  - This therefore grants no reach the agent lacks — its ordinary reply
 *    already lands in that same channel. The concern is *cross-channel*
 *    messaging, which remains impossible.
 *  - Fail-closed on tenant resolution, same as `run_report`.
 */

export interface DigestToolDeps {
  readonly tenantMap: TenantMap;
  readonly slack: SlackPoster;
  readonly escalator: Escalator;
  readonly audit: AuditLogger;
  readonly now?: () => Date;
}

export const DigestParameters = Type.Object(
  {
    headline: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "The message posted to the channel. Keep it to the headline lines.",
    }),
    detail: Type.String({
      minLength: 1,
      maxLength: 30000,
      description: "Posted as a threaded reply under the headline. The table.",
    }),
  },
  { additionalProperties: false },
);

interface DigestParams {
  readonly headline: string;
  readonly detail: string;
}

export function createPostDigestTool(
  ctx: Pick<OpenClawPluginToolContext, "agentId" | "messageChannel" | "deliveryContext">,
  deps: DigestToolDeps,
) {
  const clock = deps.now ?? (() => new Date());

  return {
    name: DIGEST_TOOL_NAME,
    label: "Post digest",
    description:
      "Post the scheduled digest to this channel: `headline` as the message, `detail` " +
      "as a threaded reply beneath it. The channel is fixed to this agent's own " +
      "channel and cannot be chosen. Call this exactly once per digest.",
    parameters: DigestParameters,

    async execute(_toolCallId: string, rawParams: unknown) {
      const started = clock();
      const params = (rawParams ?? {}) as Partial<DigestParams>;

      const record = (outcome: "success" | "refused" | "error", errorClass?: string) => {
        deps.audit.record(
          buildAuditRecord({
            event: DIGEST_TOOL_NAME,
            outcome,
            agentId: ctx.agentId,
            channel: ctx.deliveryContext?.to,
            channelProvider: ctx.messageChannel,
            durationMs: clock().getTime() - started.getTime(),
            ...(errorClass === undefined ? {} : { errorClass }),
            now: started,
          }),
        );
      };

      const fail = async (errorClass: string, detail: string) => {
        record("error", errorClass);
        await deps.escalator.escalate({
          reason: "tool_failure",
          detail,
          agentId: ctx.agentId,
          channel: ctx.deliveryContext?.to,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "The digest could not be posted. The team has been notified.",
            },
          ],
          details: { posted: false, reason: errorClass },
        };
      };

      if (params.headline === undefined || params.detail === undefined) {
        return await fail(
          "malformed_params",
          `${DIGEST_TOOL_NAME} called without headline/detail`,
        );
      }

      // Same fail-closed tenant resolution as run_report. The channel comes
      // from here, never from the model.
      const resolution = resolveTenant(ctx, deps.tenantMap);
      if (!resolution.ok) {
        record("refused", resolution.reason);
        await deps.escalator.escalate({
          reason: "tenant_resolution_failure",
          detail: resolution.detail,
          agentId: resolution.agentId,
          channel: ctx.deliveryContext?.to,
        });
        return {
          content: [{ type: "text" as const, text: "The digest could not be posted." }],
          details: { posted: false, reason: resolution.reason },
        };
      }

      const channel = resolution.tenant.channelId;

      const parent = await deps.slack.post(channel, params.headline);
      if (!parent.ok || parent.ts === undefined) {
        return await fail(
          "slack_post_failed",
          `headline post failed: ${parent.error ?? "no ts"}`,
        );
      }

      const reply = await deps.slack.post(channel, params.detail, parent.ts);
      if (!reply.ok) {
        // The headline is already visible, so this is a partial post rather
        // than a silent failure: say so plainly instead of pretending it
        // worked.
        record("error", "slack_thread_failed");
        await deps.escalator.escalate({
          reason: "tool_failure",
          detail: `digest headline posted to ${channel} but the threaded detail failed: ${reply.error ?? "unknown"}`,
          agentId: resolution.agentId,
          tenant: resolution.tenant.tenantId,
          channel,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Headline posted, but the threaded detail failed. The team has been notified.",
            },
          ],
          details: { posted: true, threaded: false, reason: "slack_thread_failed" },
        };
      }

      record("success");
      return {
        content: [{ type: "text" as const, text: "Digest posted." }],
        details: { posted: true, threaded: true, channel },
      };
    },
  };
}
