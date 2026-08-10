import { Type, type Static, type TSchema } from "typebox";

import type { TenantIdFormat } from "../config/schema.js";

/**
 * Catalog schemas: `reports/<id>/report.yaml` (what the bot can compute) and
 * `tenants.yaml` (who gets what, and when).
 *
 * Every object is `additionalProperties: false`, for the same reason it is in
 * `deployment.yaml`: it makes a removed field a build failure rather than a
 * silent no-op.
 */

/** The closed dateRange enum. No free-form dates, ever. */
export const DATE_RANGES = [
  "today",
  "last_7d",
  "last_30d",
  "last_90d",
  "mtd",
  "qtd",
  "ytd",
  "prior_month",
  /**
   * An arbitrary number of days back, ending today. Carries a `days` parameter
   * rather than encoding the count in the name.
   *
   * The closed enum exists so no model-supplied *date string* can reach SQL.
   * An integer preserves that exactly: the plugin still computes both dates
   * with its own calendar arithmetic and the SQL still receives encoded
   * literals. What changes is how many windows a customer can name, not who
   * does the arithmetic.
   */
  "last_n_days",
  /**
   * Everything the tenant has, ending today.
   *
   * Not expressible as `last_n_days`: a tenant with more history than
   * `maxDays` would either be refused or — the real risk — silently narrowed
   * to a window that answers a different question and reads as final.
   */
  "all_time",
] as const;

export type DateRange = (typeof DATE_RANGES)[number];

/** Ranges containing the current date, so answers must be qualified as-of. */
export const IN_PROGRESS_RANGES: readonly DateRange[] = [
  "today",
  "last_n_days",
  "last_7d",
  "last_30d",
  "last_90d",
  "mtd",
  "qtd",
  "ytd",
  // Ends today, so today's activity is still accruing inside it.
  "all_time",
];

// An explicit tuple rather than DATE_RANGES.map(): mapping produces
// TLiteral<union>[] and Static<> collapses that to never[], which silently
// breaks every downstream `.includes()`. The assertion below keeps them in step.
const DateRangeSchema = Type.Union(
  [
    Type.Literal("today"),
    Type.Literal("last_7d"),
    Type.Literal("last_30d"),
    Type.Literal("last_90d"),
    Type.Literal("mtd"),
    Type.Literal("qtd"),
    Type.Literal("ytd"),
    Type.Literal("prior_month"),
    Type.Literal("last_n_days"),
    Type.Literal("all_time"),
  ],
  { description: "Closed dateRange enum" },
);

/** Compile-time proof that the schema and the DATE_RANGES tuple cannot drift. */
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _dateRangesMatchSchema: AssertSame<Static<typeof DateRangeSchema>, DateRange> = true;
void _dateRangesMatchSchema;

/** Lowercase snake identifier: report ids, agent ids, schedule ids. */
const IDENTIFIER_PATTERN = "^[a-z][a-z0-9_]*$";

/** Slack channel ids only. A name key silently never matches. */
const CHANNEL_ID_PATTERN = "^C[A-Z0-9]+$";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const INTEGER_ID_PATTERN = "^[0-9]{1,20}$";
const SLUG_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

/** The pattern a tenant id must match, per `deployment.yaml`'s `idFormat`. */
export function tenantIdPattern(format: TenantIdFormat): string {
  switch (format) {
    case "uuid":
      return UUID_PATTERN;
    case "integer":
      return INTEGER_ID_PATTERN;
    case "slug":
      return SLUG_ID_PATTERN;
  }
}

export const ColumnSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    format: Type.Union([
      Type.Literal("date"),
      Type.Literal("text"),
      /** Minor units — the shaper divides by 100 so the model never has to. */
      Type.Literal("cents"),
      Type.Literal("amount"),
      Type.Literal("number"),
      /**
       * An identifier that must never be parsed as a number. External ids are
       * routinely long enough to overflow int64 and float64, and a silently
       * truncated id still looks plausible.
       */
      Type.Literal("id"),
    ]),
  },
  { additionalProperties: false },
);

export const TotalSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    as: Type.String({ minLength: 1 }),
    agg: Type.Union([
      Type.Literal("sum"),
      Type.Literal("count"),
      Type.Literal("count_distinct"),
    ]),
  },
  { additionalProperties: false },
);

export const ReportSchema = Type.Object(
  {
    id: Type.String({ pattern: IDENTIFIER_PATTERN }),
    title: Type.String({ minLength: 1 }),
    /** Feeds the generated capability list, so prompt and catalog cannot drift. */
    description: Type.String({ minLength: 1 }),
    dateRanges: Type.Array(DateRangeSchema, { minItems: 1, uniqueItems: true }),
    rowCap: Type.Integer({ minimum: 1, maximum: 10000 }),
    /**
     * Widest `last_n_days` window this report is correct for.
     *
     * A correctness bound, NOT a truncation bound. A row-grain report will
     * usually exceed `rowCap` long before it exceeds `maxDays`; wide windows
     * return exact totals with an incomplete breakdown and the model is
     * required to say so. If a wide-window breakdown is what somebody actually
     * needs, the answer is an aggregate-shaped report.
     */
    maxDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 1100 })),
    /**
     * The report this one replaces, if any.
     *
     * Editing a report in place changes what every entitled tenant sees on the
     * next deploy, with no way to compare old against new. A new version lets
     * both run side by side against the same tenant while tenants move over one
     * reviewed PR at a time.
     *
     * Naming the predecessor explicitly, rather than inferring a family from a
     * `_v2` suffix, is what lets the build detect the one dangerous state: a
     * tenant entitled to two versions at once.
     */
    supersedes: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
    columns: Type.Array(ColumnSchema, { minItems: 1 }),
    totals: Type.Optional(Type.Array(TotalSchema)),
  },
  { additionalProperties: false },
);

export type ReportDefinition = Static<typeof ReportSchema>;

/**
 * Windows a schedule may use — the closed enum WITHOUT `last_n_days` or
 * `all_time`.
 *
 * Interactive only, deliberately. A scheduled wide window would truncate every
 * morning on a large tenant and quietly deliver an incomplete breakdown nobody
 * asked for and nobody is present to narrow. It would also defeat the
 * scheduled-fit build gate, which cannot check a window chosen at question time.
 */
const ScheduledDateRangeSchema = Type.Union(
  [
    Type.Literal("today"),
    Type.Literal("last_7d"),
    Type.Literal("last_30d"),
    Type.Literal("last_90d"),
    Type.Literal("mtd"),
    Type.Literal("qtd"),
    Type.Literal("ytd"),
    Type.Literal("prior_month"),
  ],
  { description: "Closed dateRange enum, minus the parameterised windows" },
);

export const ScheduleSchema = Type.Object(
  {
    id: Type.String({ pattern: IDENTIFIER_PATTERN }),
    report: Type.String({ minLength: 1 }),
    dateRange: ScheduledDateRangeSchema,
    cron: Type.String({ minLength: 1 }),
    promptOverride: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ScheduleDefinition = Static<typeof ScheduleSchema>;

/**
 * One tenant's stanza.
 *
 * Built as a function of the deployment so `tenantId` is validated against the
 * id format this warehouse actually uses, and is optional in single-tenant
 * mode where there is nothing to scope.
 *
 * There is deliberately no `users` key. **Channel membership is the
 * perimeter**: access is granted and revoked by adding to or removing from the
 * Slack channel — one control rather than two that drift apart.
 */
export function buildTenantSchema(options: {
  readonly idFormat: TenantIdFormat;
  readonly tenantScoped: boolean;
}): TSchema {
  const idSchema = Type.String({ pattern: tenantIdPattern(options.idFormat) });

  return Type.Object(
    {
      channelId: Type.String({ pattern: CHANNEL_ID_PATTERN }),
      tenantId: options.tenantScoped ? idSchema : Type.Optional(idSchema),
      /**
       * What the tenant calls themselves — "Acme Corp", not an agent id.
       *
       * Compiled into the prompt so the model can tell the tenant's own name
       * from an entity name. Without it, "how much has the Acme program done"
       * reads "Acme" as an entity filter and the drill-down finds nothing:
       * the prompt says "this channel's own data" without ever saying whose
       * channel it is.
       */
      displayName: Type.Optional(Type.String({ minLength: 1 })),
      /** Controls when a digest fires, never which date it reports. */
      timezone: Type.Optional(Type.String({ minLength: 1 })),
      /**
       * Opt in to sharing a tenant id with another agent.
       *
       * Two agents on one tenant id is normally an isolation bug, so it is a
       * build failure. A staging agent deliberately bound to a real tenant so
       * its channel previews exactly what production will post is the
       * legitimate exception. Requiring an explicit flag keeps the check
       * meaningful — it still catches the accident, and the intent is visible
       * in the diff.
       */
      allowSharedTenant: Type.Optional(Type.Boolean()),
      /** Entitlement: what this tenant may ask for. */
      reports: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
      }),
      /** What arrives unprompted. Separate from entitlement by design. */
      schedules: Type.Optional(Type.Array(ScheduleSchema)),
    },
    { additionalProperties: false },
  );
}

export interface TenantDefinition {
  readonly channelId: string;
  readonly tenantId?: string;
  readonly displayName?: string;
  readonly timezone?: string;
  readonly allowSharedTenant?: boolean;
  readonly reports: readonly string[];
  readonly schedules?: readonly ScheduleDefinition[];
}

export function buildTenantsFileSchema(options: {
  readonly idFormat: TenantIdFormat;
  readonly tenantScoped: boolean;
}): TSchema {
  return Type.Record(
    Type.String({ pattern: IDENTIFIER_PATTERN }),
    buildTenantSchema(options),
  );
}

/** Reserved agent id — the fallback agent, never a tenant. */
export const QUARANTINE_AGENT_ID = "quarantine";

/** The tenant id recorded for a single-tenant deployment. */
export const SINGLE_TENANT_ID = "__single__";
