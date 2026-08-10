import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

/**
 * Tenant resolution — the isolation boundary.
 *
 * `agentId` arrives on the trusted `OpenClawPluginToolContext`, which the
 * Gateway passes to plugin tool *factories*. It is typed optional, so absence
 * is a real runtime case and the fail-closed check is mandatory rather than
 * defensive.
 *
 * Two independent checks, deliberately:
 *
 *  1. `agentId` must be present and in the generated tenant map. Never default
 *     to a tenant, never fall back to "the only one". There is no default
 *     tenant and no "if there is only one, use it" — those are the two
 *     shortcuts that turn a config mistake into a cross-tenant read.
 *  2. The conversation the turn arrived from must match the tenant's
 *     configured channel. This turns routing or config drift — a channel bound
 *     to the wrong agent — from undetectable into a loud, fail-closed
 *     escalation at the tool boundary.
 *
 * Neither check consults anything the model can influence. `agentId` is never
 * a tool parameter, never inferred from the message, and never captured when
 * the factory ran.
 *
 * @see docs/why.md §"One agent, one channel, one tenant"
 */

export interface TenantEntry {
  /** Warehouse tenant key. The sentinel in single-tenant mode. */
  readonly tenantId: string;
  /** The one Slack channel this agent is bound to. */
  readonly channelId: string;
  /** Reports this tenant is entitled to ask for. */
  readonly reports: readonly string[];
}

/** Generated from tenants.yaml. Never hand-written. */
export type TenantMap = Readonly<Record<string, TenantEntry>>;

export type TenantRefusalReason = "no_agent_id" | "unknown_agent" | "channel_mismatch";

export type TenantResolution =
  | { readonly ok: true; readonly agentId: string; readonly tenant: TenantEntry }
  | {
      readonly ok: false;
      readonly reason: TenantRefusalReason;
      /** Operator-facing detail for the escalation. Never shown to a customer. */
      readonly detail: string;
      readonly agentId?: string;
    };

/**
 * Resolve the tenant for a tool invocation.
 *
 * Called on every invocation, reading `ctx` at execute time rather than
 * capturing values when the factory ran.
 */
export function resolveTenant(
  ctx: Pick<OpenClawPluginToolContext, "agentId" | "messageChannel" | "deliveryContext">,
  map: TenantMap,
): TenantResolution {
  const agentId = ctx.agentId;

  if (agentId === undefined || agentId === "") {
    return {
      ok: false,
      reason: "no_agent_id",
      detail:
        "toolContext carried no agentId; refusing rather than defaulting to a tenant",
    };
  }

  // Own-property check: a prototype key like "constructor" must not resolve.
  if (!Object.prototype.hasOwnProperty.call(map, agentId)) {
    return {
      ok: false,
      reason: "unknown_agent",
      agentId,
      detail: `agentId ${JSON.stringify(agentId)} has no entry in the tenant map`,
    };
  }

  const tenant = map[agentId];
  if (tenant === undefined) {
    return {
      ok: false,
      reason: "unknown_agent",
      agentId,
      detail: `tenant map entry for ${JSON.stringify(agentId)} is undefined`,
    };
  }

  // Belt and braces on routing: a turn arriving from a channel the agent is
  // not bound to is drift, not a user error.
  //
  // The conversation id lives on `deliveryContext.to` — NOT on
  // `messageChannel`, which is the channel *provider* ("slack", "webchat").
  // Comparing the provider to a Slack channel id never matches and refuses
  // every turn, including real traffic.
  //
  // Deliberately fail-open when no conversation id is present: some surfaces
  // (CLI, webchat) supply none, and the primary control is agentId → tenant. A
  // secondary check that cannot be evaluated must not veto a turn the primary
  // control already permitted.
  const conversation = conversationId(ctx.deliveryContext?.to);
  if (
    conversation !== undefined &&
    conversation !== "" &&
    conversation !== tenant.channelId
  ) {
    return {
      ok: false,
      reason: "channel_mismatch",
      agentId,
      detail: `agent ${agentId} is bound to ${tenant.channelId} but the turn arrived from ${conversation}`,
    };
  }

  return { ok: true, agentId, tenant };
}

/**
 * Strip the provider prefix from a delivery target.
 *
 * `deliveryContext.to` is prefixed by target kind — `channel:C123`, `user:U1`,
 * `room:!x:server`. The tenant map stores the bare channel id, so the prefix
 * must come off before comparing, or every turn is refused for arriving from
 * the very channel it is bound to.
 *
 * Only a leading `<word>:` is removed. Matrix room ids contain further colons,
 * so splitting on the last colon would corrupt them.
 */
export function conversationId(target: string | undefined): string | undefined {
  if (target === undefined || target === "") return undefined;
  const match = /^[a-z]+:(.+)$/.exec(target);
  return match?.[1] ?? target;
}

/** Whether this tenant may ask for this report. */
export function isEntitled(tenant: TenantEntry, report: string): boolean {
  return tenant.reports.includes(report);
}
