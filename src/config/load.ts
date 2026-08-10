import { readFileSync } from "node:fs";

import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import { parse as parseYaml } from "yaml";

import { CatalogError, issue, type CatalogIssue } from "../catalog/errors.js";
import {
  DEFAULT_MAX_DAYS,
  DEFAULT_MODEL,
  DeploymentSchema,
  type DeploymentDefinition,
  type TenantIdFormat,
} from "./schema.js";

/**
 * Load and validate `deployment.yaml`.
 *
 * Two layers, in this order:
 *
 *  1. **Structure**, from the TypeBox schema — types, patterns, unknown keys.
 *  2. **Coherence**, below — the checks that need more than one field at once.
 *     A multi-tenant deployment without a tenant predicate, an adapter with no
 *     matching block, a predicate that does not contain the placeholder it
 *     exists to bind. Each of these is a config that would typecheck and then
 *     fail in a way nobody would connect back to this file.
 *
 * Everything here is reported as a list rather than thrown at the first
 * problem, so someone fixing a fresh config sees the whole thing at once.
 */

/** The tenant placeholder. The only one a predicate may bind. */
export const TENANT_PLACEHOLDER = "tenant_id";

/** The entity-filter placeholder — the one model-chosen value that reaches SQL. */
export const ENTITY_PLACEHOLDER = "entity";

export interface Deployment extends DeploymentDefinition {
  /** Defaults applied, so downstream code never re-derives them. */
  readonly resolved: {
    readonly model: string;
    readonly defaultMaxDays: number;
    readonly tenantIdFormat: TenantIdFormat;
    /** True when the tenant predicate is mandatory in every template. */
    readonly tenantScoped: boolean;
  };
}

function typeboxIssues(schema: TSchema, value: unknown): CatalogIssue[] {
  return [...Errors(schema, value)].map((e) =>
    issue(e.instancePath.replace(/^\//, "").replace(/\//g, "."), e.message),
  );
}

/**
 * Name unknown keys explicitly.
 *
 * TypeBox reports an additionalProperties violation as "must not have
 * additional properties" without saying which key offended. For a config file
 * that is the difference between a fix and a hunt — and naming the key is the
 * whole point of the check.
 */
function unknownKeyIssues(
  schema: TSchema & { properties?: Record<string, unknown> },
  value: unknown,
  prefix: string,
): CatalogIssue[] {
  const allowed = Object.keys(schema.properties ?? {});
  if (allowed.length === 0 || typeof value !== "object" || value === null) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => !allowed.includes(key))
    .map((key) =>
      issue(
        prefix === "" ? key : `${prefix}.${key}`,
        `unknown key "${key}" — allowed keys are: ${allowed.join(", ")}`,
      ),
    );
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Checks that need more than one field to evaluate. */
function coherenceIssues(config: DeploymentDefinition): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const { tenancy, warehouse, reporting } = config;

  if (tenancy.mode === "multi") {
    if (tenancy.predicate === undefined || tenancy.predicate.trim() === "") {
      issues.push(
        issue(
          "tenancy.predicate",
          "is required when tenancy.mode is \"multi\" — without it no report is scoped to a tenant, and every channel would read the whole dataset",
        ),
      );
    }
    if (tenancy.idFormat === undefined) {
      issues.push(
        issue(
          "tenancy.idFormat",
          "is required when tenancy.mode is \"multi\" — the literal encoder validates a tenant id against this before quoting it into SQL",
        ),
      );
    }
  }

  // A predicate that does not carry the placeholder binds nothing: the
  // template would pass the verbatim check and still filter on a constant.
  if (
    tenancy.predicate !== undefined &&
    !tenancy.predicate.includes(`{{${TENANT_PLACEHOLDER}}}`)
  ) {
    issues.push(
      issue(
        "tenancy.predicate",
        `must contain {{${TENANT_PLACEHOLDER}}} — a predicate without it filters on a fixed value and scopes nothing`,
      ),
    );
  }

  if (
    tenancy.entityPredicate !== undefined &&
    !tenancy.entityPredicate.includes(`{{${ENTITY_PLACEHOLDER}}}`)
  ) {
    issues.push(
      issue(
        "tenancy.entityPredicate",
        `must contain {{${ENTITY_PLACEHOLDER}}} — otherwise a drill-down report has no way to bind the name the customer typed`,
      ),
    );
  }

  // The adapter names a block; the block has to be there. Getting this wrong
  // produces a plugin that starts and then fails on the first question.
  if (warehouse.adapter === "snowflake" && warehouse.snowflake === undefined) {
    issues.push(
      issue("warehouse.snowflake", 'is required when warehouse.adapter is "snowflake"'),
    );
  }
  if (warehouse.adapter === "mcp" && warehouse.mcp === undefined) {
    issues.push(issue("warehouse.mcp", 'is required when warehouse.adapter is "mcp"'));
  }

  if (!isValidTimezone(reporting.timezone)) {
    issues.push(
      issue("reporting.timezone", `"${reporting.timezone}" is not a valid IANA timezone`),
    );
  }

  const floor = new Date(`${reporting.allTimeFloor}T00:00:00Z`);
  if (Number.isNaN(floor.getTime())) {
    issues.push(
      issue("reporting.allTimeFloor", `"${reporting.allTimeFloor}" is not a real date`),
    );
  }

  return issues;
}

export function parseDeployment(parsed: unknown, source: string): Deployment {
  const issues = [
    ...unknownKeyIssues(DeploymentSchema, parsed, ""),
    ...typeboxIssues(DeploymentSchema, parsed),
  ];
  if (issues.length > 0) throw new CatalogError(source, issues);

  const config = parsed as DeploymentDefinition;

  const coherence = coherenceIssues(config);
  if (coherence.length > 0) throw new CatalogError(source, coherence);

  return {
    ...config,
    resolved: {
      model: config.model ?? DEFAULT_MODEL,
      defaultMaxDays: config.reporting.defaultMaxDays ?? DEFAULT_MAX_DAYS,
      tenantIdFormat: config.tenancy.idFormat ?? "uuid",
      tenantScoped: config.tenancy.mode === "multi",
    },
  };
}

export function loadDeployment(path: string): Deployment {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CatalogError("deployment.yaml", [
      issue(
        "",
        `cannot read ${path} — copy deployment.yaml.example and fill it in, or run /almanac-init`,
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new CatalogError("deployment.yaml", [
      issue("", `invalid YAML: ${e instanceof Error ? e.message : String(e)}`),
    ]);
  }

  return parseDeployment(parsed, "deployment.yaml");
}
