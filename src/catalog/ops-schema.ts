import { Type, type Static } from "typebox";

/**
 * `ops.yaml` — the operations channel and who may broadcast from it.
 *
 * Deliberately a separate file and schema from `tenants.yaml`, because the ops
 * agent is not a tenant: it has no dataset, no reports, and never reads tenant
 * data. Modelling it as a tenant with an empty entitlement would put a fake
 * tenant id in the tenant map, which is the kind of value that looks harmless
 * until something joins on it.
 *
 * Optional. With no `ops.yaml` there is no ops agent, no ops channel and no
 * announce tool — the feature is absent rather than half-present.
 *
 * Authorisation is **channel membership**, not a list of user ids. Same
 * reasoning as tenant channels: one control rather than two that drift apart,
 * and adding an operator is a Slack invite rather than a config change and a
 * deploy. A named list also goes stale silently the day somebody leaves.
 *
 * It only works because the channel is private, which the tool verifies with
 * Slack on every call rather than assuming from config — privacy is a setting
 * somebody can change without touching this repo.
 */

const CHANNEL_ID_PATTERN = "^C[A-Z0-9]+$";

export const OpsSchema = Type.Object(
  {
    /**
     * The internal channel the ops agent is bound to.
     *
     * **This channel MUST be private.** Membership is the authorisation:
     * anyone in it can broadcast to tenant channels. In a public channel
     * joining is one click, so membership would grant nothing.
     */
    channelId: Type.String({ pattern: CHANNEL_ID_PATTERN }),
  },
  { additionalProperties: false },
);

export type OpsDefinition = Static<typeof OpsSchema>;

/** Reserved agent id for the ops agent. Never a tenant. */
export const OPS_AGENT_ID = "ops";
