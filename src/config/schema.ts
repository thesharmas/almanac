// typebox v1 (package `typebox`), matching the version openclaw depends on.
// `@sinclair/typebox` (v0) is a *different package* with a structurally
// incompatible TSchema, so a schema built with it is not assignable to
// openclaw's AnyAgentTool. One schema library across config, catalog and
// plugin keeps that mismatch impossible.
import { Type, type Static } from "typebox";

/**
 * `deployment.yaml` — the org-level catalog.
 *
 * Almanac has three catalogs and nothing is configured in more than one:
 *
 *   deployment.yaml   the org: branding, tenancy, warehouse, Slack, cloud
 *   reports/<id>/     what the bot can compute
 *   tenants.yaml      who gets what, and when
 *
 * This is the first, and it is the one the other two are interpreted against.
 * The tenant predicate, the reporting timezone, the noun for a row and the
 * word for a measure all live here, so a report template and a generated
 * prompt cannot disagree about what the system is for.
 *
 * Every object is `additionalProperties: false`. That is load-bearing rather
 * than tidy: it makes a *removed* field a build failure instead of a silent
 * no-op. A config still carrying a control that was deliberately deleted must
 * fail loudly rather than look like it is being honoured.
 */

const IDENTIFIER_PATTERN = "^[a-z][a-z0-9_]*$";
const SLUG_PATTERN = "^[a-z][a-z0-9-]*$";

/** Slack channel ids only. A name key silently never matches. */
export const CHANNEL_ID_PATTERN = "^C[A-Z0-9]+$";

/**
 * How a tenant id is shaped, and therefore what the literal encoder will
 * accept before it will quote a value into SQL.
 *
 * This is not cosmetic. The encoder validates against the pattern this names
 * *before* quoting, so a bug elsewhere that let an unexpected value through
 * fails loudly instead of producing SQL. Picking `string` widens that gate,
 * which is why the interview asks and does not assume.
 */
export const TENANT_ID_FORMATS = ["uuid", "integer", "slug"] as const;
export type TenantIdFormat = (typeof TENANT_ID_FORMATS)[number];

const TenancySchema = Type.Object(
  {
    /**
     * `multi` — several tenants, one agent and one channel each. Every
     * isolation control is live: the tenant predicate is mandatory and
     * verbatim, two agents may not share a tenant id, and a turn arriving
     * from the wrong channel is refused.
     *
     * `single` — one dataset, no per-tenant scoping. The tenant predicate
     * becomes optional and `tenantId` may be omitted from tenants.yaml.
     * Everything else is unchanged: agents are still bound 1:1 to channels,
     * entitlement is still enforced, the enums are still closed.
     *
     * Choose `single` only for an internal deployment where every reader is
     * entitled to the whole dataset. A customer-facing bot in `single` mode
     * has deleted the control that separates one customer from another, and
     * `/almanac-init` will refuse to write that combination.
     */
    mode: Type.Union([Type.Literal("multi"), Type.Literal("single")]),
    /**
     * The tenant predicate, required **verbatim** in every report template.
     *
     * One reviewed spelling, checked textually rather than by parsing SQL. A
     * parser would accept many equivalent forms; the point of this check is
     * that a reviewer diffing a new report knows exactly what to look for,
     * and that no template can invent its own way of scoping a tenant.
     *
     * It must contain `{{tenant_id}}`, and nothing else may.
     *
     * Do not be tempted to make this a regex or a list of accepted forms.
     * The moment several spellings are legal, "every report is scoped the
     * same way" stops being a fact the build can check and becomes a habit
     * reviewers are asked to keep.
     */
    predicate: Type.Optional(Type.String({ minLength: 1 })),
    idFormat: Type.Optional(
      Type.Union([Type.Literal("uuid"), Type.Literal("integer"), Type.Literal("slug")]),
    ),
    /**
     * The one permitted form of an entity filter, if reports offer drill-down.
     *
     * `{{entity}}` is the only placeholder carrying a value the *model* chose,
     * so unlike the tenant id and the dates it is not derived from something
     * the host controls. Two things make that safe, and both are checked
     * rather than left to review: the tenant predicate is still mandatory and
     * ANDed, so an entity filter can only narrow a result that is already
     * scoped to one tenant; and the filter must appear in exactly this form,
     * so a template cannot compare the model's value against a different
     * column.
     */
    entityPredicate: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const BrandingSchema = Type.Object(
  {
    /** What the bot calls itself, e.g. "Almanac". */
    botName: Type.String({ minLength: 1 }),
    /** The organisation it speaks for, e.g. "Acme Corp". */
    org: Type.String({ minLength: 1 }),
    /**
     * One clause completing "You are <botName>, ...". Compiled into every
     * agent prompt, so it is how a reader learns whose bot this is.
     */
    persona: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * The domain vocabulary, injected into generated prompts and digests.
 *
 * Without this the prompts would have to say "records" and "values" and read
 * like a database manual to the customer in the channel. With it, a lending
 * deployment says "fundings across businesses" and a logistics one says
 * "shipments across carriers", from the same generator.
 *
 * It is deliberately *only* vocabulary. Domain reasoning — the sort of rule
 * that says which of two words is honest for a given day's numbers — belongs
 * in the report's own `digest.md`, next to the totals it branches on.
 */
const LexiconSchema = Type.Object(
  {
    /** What one row is about: "business", "carrier", "region". */
    entity: Type.String({ minLength: 1 }),
    entityPlural: Type.String({ minLength: 1 }),
    /** What is being counted: "funding", "shipment", "signup". */
    measure: Type.String({ minLength: 1 }),
    measurePlural: Type.String({ minLength: 1 }),
    /**
     * The verb in a headline — "funded" gives "Total funded on Aug 5".
     * Omit for a deployment where a bare noun reads better.
     */
    verbPast: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const ReportingSchema = Type.Object(
  {
    /**
     * The reporting timezone. Every date range resolves to calendar dates in
     * this zone, whatever a tenant's own timezone is.
     *
     * A tenant's `timezone` controls *when a digest fires*, not *which date it
     * reports*. Firing at end-of-day in the reporting zone over a reporting-zone
     * date is the coherent pairing; mixing them produces a digest that is a day
     * out for half the year and nobody can say which half.
     */
    timezone: Type.String({ minLength: 1 }),
    /**
     * Floor for the `all_time` window — earlier than the first row the
     * warehouse holds.
     *
     * A constant rather than a per-tenant MIN() lookup: the tenant predicate
     * already scopes the rows, so the floor only has to be early enough, and a
     * constant keeps the date arithmetic testable against a frozen clock. It is
     * never shown — the query returns the tenant's real first date and the
     * shaper substitutes that for this value.
     */
    allTimeFloor: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    /** Widest `last_n_days` window a report allows when it does not say. */
    defaultMaxDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 1100 })),
  },
  { additionalProperties: false },
);

const SnowflakeSchema = Type.Object(
  {
    account: Type.String({ minLength: 1 }),
    /**
     * **This role is the containment boundary.** Grant it SELECT on the
     * analytics schema and nothing else — no write, no other database.
     *
     * A deployment reaching the warehouse directly has no proxy in front of it
     * doing that job, so the role is the only thing standing between a bug in
     * this code and a mutation. `/almanac-connect` proves by execution that it
     * cannot write.
     */
    role: Type.String({ minLength: 1 }),
    warehouse: Type.String({ minLength: 1 }),
    database: Type.String({ minLength: 1 }),
    schema: Type.String({ minLength: 1 }),
    username: Type.String({ minLength: 1 }),
    /**
     * Secret Manager entry holding the PEM private key.
     *
     * Key-pair, not a password: a password is replayable by anything that
     * reads it once, and Snowflake supports key-pair precisely so an unattended
     * service does not have to hold one.
     */
    privateKeySecret: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const McpSchema = Type.Object(
  {
    /** Env var holding the MCP endpoint URL. */
    urlEnv: Type.String({ minLength: 1 }),
    /** Env var holding the API key. */
    apiKeyEnv: Type.String({ minLength: 1 }),
    /** The tool the server exposes for read-only SQL. */
    toolName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const WarehouseSchema = Type.Object(
  {
    adapter: Type.Union([Type.Literal("snowflake"), Type.Literal("mcp")]),
    snowflake: Type.Optional(SnowflakeSchema),
    mcp: Type.Optional(McpSchema),
    /** Per-attempt statement timeout. */
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  },
  { additionalProperties: false },
);

const SlackSchema = Type.Object(
  {
    /**
     * Where refusals, drift and tool failures are posted.
     *
     * Not a customer channel and not the ops channel. Everything the system
     * cannot handle lands here, which is what makes a quiet failure visible.
     */
    errorChannelId: Type.String({ pattern: CHANNEL_ID_PATTERN }),
    /** Display name of the Slack app, for the generated manifest. */
    appName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const GcpSchema = Type.Object(
  {
    project: Type.String({ minLength: 1 }),
    region: Type.String({ minLength: 1 }),
    zone: Type.String({ minLength: 1 }),
    vmName: Type.Optional(Type.String({ minLength: 1 })),
    machineType: Type.Optional(Type.String({ minLength: 1 })),
    /**
     * VPC and subnet. `infra/00-network.sh` creates them when absent; every
     * later script refuses to run rather than helpfully creating a second
     * network under a name it guessed.
     */
    network: Type.Optional(Type.String({ minLength: 1 })),
    subnet: Type.Optional(Type.String({ minLength: 1 })),
    releasesBucket: Type.String({ minLength: 1 }),
    /**
     * Written by the VM, read by CI. Separate from the releases bucket so the
     * customer-facing host cannot publish a release to itself — compromising
     * the box gives no route to shipping code.
     */
    statusBucket: Type.String({ minLength: 1 }),
    /**
     * Secrets are named with this prefix so `secretAccessor` can be bound
     * per-secret. A project-wide grant behaves identically on day one and
     * silently widens every time anyone adds a secret.
     */
    secretPrefix: Type.Optional(Type.String({ minLength: 1 })),
    /** Origin allowed to load the Control UI, on the tailnet. */
    controlUiOrigin: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const DeploymentSchema = Type.Object(
  {
    /** Slug for this deployment. Prefixes generated job names and secrets. */
    name: Type.String({ pattern: SLUG_PATTERN }),
    branding: BrandingSchema,
    tenancy: TenancySchema,
    lexicon: LexiconSchema,
    reporting: ReportingSchema,
    warehouse: WarehouseSchema,
    slack: SlackSchema,
    gcp: Type.Optional(GcpSchema),
    /**
     * Model id, pinned with no fallback chain.
     *
     * A silent fallback to a weaker model would silently reduce injection
     * resistance in a customer-facing system. A model failure should be loud,
     * not quietly degraded.
     */
    model: Type.Optional(Type.String({ minLength: 1 })),
    /** Reserved for a future per-deployment agent id prefix. */
    agentIdPattern: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
  },
  { additionalProperties: false },
);

export type DeploymentDefinition = Static<typeof DeploymentSchema>;

/** Model used when `deployment.yaml` does not pin one. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** Widest `last_n_days` window when the deployment does not say. */
export const DEFAULT_MAX_DAYS = 366;

/** Absolute ceiling on `last_n_days`, whatever a report or deployment declares. */
export const MAX_LAST_N_DAYS = 1100;
