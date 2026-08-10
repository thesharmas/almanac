import type { Catalog, Tenant } from "../catalog/load.js";
import { OPS_AGENT_ID } from "../catalog/ops-schema.js";
import { QUARANTINE_AGENT_ID } from "../catalog/schema.js";
import type { Deployment } from "../config/load.js";
import { ANNOUNCE_TOOL_NAME } from "../plugin/announce-tool.js";
import { DIGEST_TOOL_NAME } from "../plugin/digest-tool.js";
import type { TenantMap } from "../plugin/tenant.js";
import { TOOL_NAME } from "../plugin/tool.js";
import { buildOpsPrompt } from "./ops-prompt.js";
import { buildSystemPrompt } from "./prompt.js";

/**
 * Render the coupled artifacts from the three catalogs.
 *
 * Everything a tenant touches is derived from one stanza in `tenants.yaml`, so
 * onboarding is one reviewed PR and offboarding is a deletion. Nothing here is
 * hand-editable: `generated/` is checked in so the diff is reviewable, but it
 * is always rewritten wholesale.
 */

/**
 * Slack peer kind for channel bindings.
 *
 * The wrong value produces a binding that silently never matches, which falls
 * through to `quarantine` — so if a channel is reaching the fallback agent
 * despite correct-looking config, try the other value first.
 */
export type SlackPeerKind = "group" | "channel";
export const DEFAULT_PEER_KIND: SlackPeerKind = "group";

export interface GenerateOptions {
  readonly deployment: Deployment;
  readonly catalog: Catalog;
  /** Absolute base path for per-agent workspace/agentDir. */
  readonly agentRoot: string;
  readonly peerKind?: SlackPeerKind;
}

/** Placeholder replaced at deploy time from Secret Manager; never a real token. */
export const GATEWAY_TOKEN_PLACEHOLDER = "__ALMANAC_GATEWAY_TOKEN__";

export interface AgentEntry {
  readonly id: string;
  readonly default?: true;
  readonly workspace: string;
  readonly agentDir: string;
  readonly tools: Record<string, unknown>;
  /** Ensure the workspace bootstrap file reaches the system prompt every turn. */
  readonly contextInjection: "always";
}

export interface Binding {
  /** Explicit rather than relying on a legacy default. */
  readonly type: "route";
  readonly agentId: string;
  readonly match: {
    readonly channel: "slack";
    readonly peer: { readonly kind: SlackPeerKind; readonly id: string };
  };
}

export interface AutomationJob {
  /** Deterministic, so the reconciler's diff is stable. */
  readonly name: string;
  readonly agentId: string;
  readonly cron: string;
  readonly tz: string;
  readonly report: string;
  readonly dateRange: string;
  readonly promptPath: string;
  readonly session: "isolated";
  readonly deliver: { readonly mode: "announce" | "none"; readonly to: string };
}

export interface GeneratedArtifacts {
  readonly openclaw: {
    readonly agents: {
      /**
       * Model pinned with no fallback chain. A silent fallback to a weaker
       * model would silently reduce injection resistance in a customer-facing
       * system; a model failure should be loud, not quietly degraded.
       */
      readonly defaults: { readonly model: string };
      readonly list: readonly AgentEntry[];
    };
    readonly gateway: {
      readonly mode: "local";
      /**
       * `bind: "lan"` is required and is not the exposure it looks like:
       * Docker port publishing cannot reach a process bound to the container's
       * own loopback. Host-side publishing stays on 127.0.0.1, so nothing is
       * exposed to the VPC.
       */
      readonly bind: "lan";
      readonly port: number;
      /** Placeholder here; deploy.sh substitutes the real token from Secret Manager. */
      readonly auth: { readonly mode: "token"; readonly token: string };
      readonly controlUi: {
        readonly enabled: true;
        readonly allowedOrigins: readonly string[];
      };
      readonly trustedProxies: readonly string[];
    };
    readonly bindings: readonly Binding[];
    /**
     * Trusted plugin allowlist. Without it the Gateway warns that discovered
     * plugins "may auto-load" — naming the ones expected means an unexpected
     * extension on the box does not silently join the tool registry.
     */
    readonly plugins: { readonly allow: readonly string[] };
    /** Global tool policy; some settings are not expressible per-agent. */
    readonly tools: {
      readonly agentToAgent: { readonly enabled: false };
      readonly sessions: { readonly visibility: "self" };
    };
    readonly channels: {
      readonly slack: {
        readonly enabled: true;
        /** Outbound WebSocket only: no public Request URL, no inbound path. */
        readonly mode: "socket";
        /** SecretRef form, so no token is ever written into git. */
        readonly botToken: {
          readonly source: "env";
          readonly provider: "default";
          readonly id: string;
        };
        readonly appToken: {
          readonly source: "env";
          readonly provider: "default";
          readonly id: string;
        };
        readonly groupPolicy: "allowlist";
        readonly dmPolicy: "disabled";
        readonly dm: { readonly groupEnabled: false };
        readonly requireMention: true;
        /**
         * Every reply goes in a thread under the message that prompted it.
         *
         * The default is off — replies land top-level, so a busy day reads as
         * a wall of unrelated bot messages with no visible link to who asked
         * what. "all" also improves follow-ups: the Gateway seeds the root
         * message and its thread replies into one session, so "and last week?"
         * resolves against the question above it rather than whatever was said
         * in the channel most recently.
         */
        readonly replyToMode: "all";
        readonly contextVisibility: "allowlist";
        readonly channels: Record<string, Record<string, unknown>>;
      };
    };
  };
  readonly tenantMap: TenantMap;
  /** `{}` when there is no ops.yaml, so the plugin registers no announce tool. */
  readonly ops: { readonly channelId?: string };
  readonly automations: readonly AutomationJob[];
  readonly prompts: Record<string, string>;
}

/**
 * Hardened tool policy, applied to every tenant agent.
 *
 * Deny-listed beyond `minimal` because the profile is a floor, not a ceiling:
 * `gateway` and `cron` would let the model read config or create jobs, and
 * `sessions_spawn`/`sessions_send` would give it reach beyond its own turn.
 */
function tenantToolPolicy(): Record<string, unknown> {
  return {
    profile: "minimal",
    alsoAllow: [TOOL_NAME, DIGEST_TOOL_NAME],
    deny: [
      "group:fs",
      "group:runtime",
      "group:automation",
      "exec",
      "process",
      "browser",
      "web_search",
      "web_fetch",
      "gateway",
      "cron",
      "sessions_spawn",
      "sessions_send",
    ],
    elevated: { enabled: false },
    // Belt and braces: the same denials regardless of who is asking.
    toolsBySender: { "*": { deny: ["group:fs", "group:runtime", "exec"] } },
  };
}

/**
 * The ops agent's policy: the same hardened denials as a tenant agent, with
 * `announce` in place of the data tools.
 *
 * Derived from `tenantToolPolicy()` rather than written out, so a denial added
 * for tenants is never accidentally missing here.
 */
function opsToolPolicy(): Record<string, unknown> {
  return { ...tenantToolPolicy(), alsoAllow: [ANNOUNCE_TOOL_NAME] };
}

function quarantineEntry(agentRoot: string): AgentEntry {
  return {
    id: QUARANTINE_AGENT_ID,
    default: true,
    workspace: `${agentRoot}/${QUARANTINE_AGENT_ID}/workspace`,
    agentDir: `${agentRoot}/${QUARANTINE_AGENT_ID}/agent`,
    tools: { profile: "minimal", deny: ["group:fs", "group:runtime", "exec"] },
    contextInjection: "always",
  };
}

/**
 * The fallback agent's instructions.
 *
 * Delivered as a workspace bootstrap file like every other agent's: there is no
 * per-agent `systemPrompt` field, and `quarantine` has no channel to hang a
 * per-channel prompt on.
 */
export const QUARANTINE_PROMPT = [
  "You are a fallback agent that must never answer questions.",
  "",
  "Any message reaching you means a routing or configuration error, not a",
  "legitimate request. Reply with exactly one sentence saying you cannot help",
  "and that the team has been notified. Never mention data, tenants, reports,",
  "or what any other agent can do. Never call a tool.",
].join("\n");

export function generateArtifacts(options: GenerateOptions): GeneratedArtifacts {
  const { catalog, agentRoot, deployment } = options;
  const peerKind = options.peerKind ?? DEFAULT_PEER_KIND;

  const agentList: AgentEntry[] = [quarantineEntry(agentRoot)];
  const bindings: Binding[] = [];
  const channels: Record<string, Record<string, unknown>> = {};
  const tenantMap: Record<string, TenantMap[string]> = {};
  const automations: AutomationJob[] = [];
  const prompts: Record<string, string> = { [QUARANTINE_AGENT_ID]: QUARANTINE_PROMPT };

  /**
   * The ops agent, when ops.yaml exists.
   *
   * Deliberately NOT in the tenant map: it has no tenant and never reads
   * tenant data, so `run_report` refuses for it by the same fail-closed check
   * that protects everything else. Its only tool is `announce`, registered for
   * this agent alone.
   */
  const ops = catalog.ops;
  if (ops !== undefined) {
    agentList.push({
      id: OPS_AGENT_ID,
      workspace: `${agentRoot}/${OPS_AGENT_ID}/workspace`,
      agentDir: `${agentRoot}/${OPS_AGENT_ID}/agent`,
      tools: opsToolPolicy(),
      contextInjection: "always",
    });
    prompts[OPS_AGENT_ID] = buildOpsPrompt(
      deployment,
      catalog.tenants.map((t) => t.agentId),
    );
    // Same shape as a tenant channel. `agentId` does NOT belong here — the
    // Slack plugin rejects it as an unknown property, and routing is the
    // binding's job, not the channel entry's.
    channels[ops.channelId] = {
      requireMention: true,
      allowBots: false,
      systemPrompt: prompts[OPS_AGENT_ID] ?? "",
    };
    bindings.push({
      type: "route",
      agentId: OPS_AGENT_ID,
      match: { channel: "slack", peer: { kind: peerKind, id: ops.channelId } },
    });
  }

  const sorted = [...catalog.tenants].sort((a, b) => a.agentId.localeCompare(b.agentId));

  for (const tenant of sorted) {
    const prompt = buildSystemPrompt(deployment, tenant, catalog.reports);
    prompts[tenant.agentId] = prompt;

    agentList.push({
      id: tenant.agentId,
      // Unique per agent — reuse causes state collisions between tenants.
      workspace: `${agentRoot}/${tenant.agentId}/workspace`,
      agentDir: `${agentRoot}/${tenant.agentId}/agent`,
      tools: tenantToolPolicy(),
      contextInjection: "always",
    });

    bindings.push({
      type: "route",
      agentId: tenant.agentId,
      match: { channel: "slack", peer: { kind: peerKind, id: tenant.channelId } },
    });

    channels[tenant.channelId] = {
      requireMention: true,
      allowBots: false,
      // `users` is deliberately absent: channel membership is the perimeter.
      systemPrompt: prompt,
    };

    tenantMap[tenant.agentId] = {
      tenantId: tenant.resolvedTenantId,
      channelId: tenant.channelId,
      reports: [...tenant.reports].sort(),
    };

    automations.push(...automationsFor(deployment, tenant));
  }

  return {
    openclaw: {
      agents: {
        defaults: { model: deployment.resolved.model },
        list: agentList,
      },
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: GATEWAY_TOKEN_PLACEHOLDER },
        controlUi: {
          enabled: true,
          allowedOrigins: [
            deployment.gcp?.controlUiOrigin ?? "http://127.0.0.1:18789",
          ],
        },
        // Tailscale CGNAT range; `tailscale serve` is the only proxy in front.
        trustedProxies: ["100.64.0.0/10"],
      },
      bindings,
      // All three are required. The model provider plugin has to be named even
      // though the Gateway auto-enables it from the API key: `openclaw agent
      // --local` honours the allowlist strictly and fails with "Unknown model"
      // without it, which makes local behavioural testing impossible.
      plugins: { allow: ["anthropic", "almanac", "slack"] },
      tools: {
        agentToAgent: { enabled: false },
        // Never "all": that would break cross-agent isolation.
        sessions: { visibility: "self" },
      },
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          groupPolicy: "allowlist",
          dmPolicy: "disabled",
          dm: { groupEnabled: false },
          requireMention: true,
          replyToMode: "all",
          contextVisibility: "allowlist",
          channels,
        },
      },
    },
    tenantMap,
    ops: catalog.ops === undefined ? {} : { channelId: catalog.ops.channelId },
    automations,
    prompts,
  };
}

function automationsFor(deployment: Deployment, tenant: Tenant): AutomationJob[] {
  return [...(tenant.schedules ?? [])].map((schedule) => ({
    name: `${deployment.name}:${tenant.agentId}:${schedule.id}`,
    // Explicit agent is mandatory: without it an isolated job falls back to
    // the default agent, which here is `quarantine`.
    agentId: tenant.agentId,
    cron: schedule.cron,
    tz: tenant.resolvedTimezone,
    report: schedule.report,
    dateRange: schedule.dateRange,
    promptPath: schedule.promptOverride ?? `reports/${schedule.report}/digest.md`,
    session: "isolated" as const,
    // The digest posts itself via post_digest, because a headline plus a
    // threaded reply is two messages and announce delivers one. Announce is
    // therefore OFF — leaving it on would double-post the headline.
    //
    // The trade: if post_digest fails there is no fallback delivery. That is
    // deliberate, and it is why the tool escalates on every failure path and
    // why the missed-digest alarm exists — a silent half-post is worse than a
    // loud absence.
    deliver: { mode: "none" as const, to: `channel:${tenant.channelId}` },
  }));
}
