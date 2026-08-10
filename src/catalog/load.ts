import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import { parse as parseYaml } from "yaml";

import type { Deployment } from "../config/load.js";
import { CatalogError, issue, type CatalogIssue } from "./errors.js";
import { OpsSchema, type OpsDefinition } from "./ops-schema.js";
import {
  QUARANTINE_AGENT_ID,
  ReportSchema,
  SINGLE_TENANT_ID,
  buildTenantSchema,
  buildTenantsFileSchema,
  type ReportDefinition,
  type TenantDefinition,
} from "./schema.js";

/**
 * Loads and validates the report catalog and `tenants.yaml`.
 *
 * Scope: this layer validates *structure* and *referential integrity* —
 * everything knowable from the catalogs themselves. Checks needing the
 * generated artifacts live in the generator's invariants: cron semantics,
 * schedule spacing, and channel↔binding↔tenant↔agent lockstep.
 *
 * Timezone validity is checked here rather than there — it is a field-level
 * format question about a value this loader is already holding, and deferring
 * it would mean a typo in an IANA name survives until artifact generation.
 */

export interface Report extends ReportDefinition {
  /** Absolute path to the report directory, for reading query.sql / digest.md. */
  readonly dir: string;
}

export interface Tenant extends TenantDefinition {
  readonly agentId: string;
  /** Explicit timezone, defaulted from the deployment's reporting zone. */
  readonly resolvedTimezone: string;
  /** Always present; the sentinel in single-tenant mode. */
  readonly resolvedTenantId: string;
}

export interface Catalog {
  readonly reports: ReadonlyMap<string, Report>;
  readonly tenants: readonly Tenant[];
  /** Absent when there is no ops.yaml, which means no ops agent at all. */
  readonly ops?: OpsDefinition;
}

export interface LoadOptions {
  readonly deployment: Deployment;
  readonly tenantsPath: string;
  /** Optional. A missing file means no ops agent, not an error. */
  readonly opsPath?: string;
  readonly reportsDir: string;
}

/**
 * Directories the report loader ignores.
 *
 * `_archetypes/` ships with the toolkit as templates to copy. They are not
 * reports: their SQL is deliberately incomplete, so loading them would fail
 * the contract on a fresh clone before anyone had done anything wrong.
 */
function isTemplateDir(name: string): boolean {
  return name.startsWith("_");
}

function typeboxIssues(schema: TSchema, value: unknown): CatalogIssue[] {
  return [...Errors(schema, value)].map((e) =>
    // TypeBox paths are JSON-pointer-ish (`/acme/schedules/0`); dotted reads better.
    issue(e.instancePath.replace(/^\//, "").replace(/\//g, "."), e.message),
  );
}

/**
 * Name unknown keys explicitly.
 *
 * TypeBox reports additionalProperties violations without saying which key
 * offended. For a config file that is the difference between a fix and a hunt,
 * and naming the key is the whole point of the check.
 */
function unknownKeyIssues(
  schema: TSchema & { properties?: Record<string, unknown> },
  value: unknown,
  pathPrefix: string,
): CatalogIssue[] {
  const allowed = Object.keys(schema.properties ?? {});
  if (allowed.length === 0 || typeof value !== "object" || value === null) return [];

  return Object.keys(value as Record<string, unknown>)
    .filter((key) => !allowed.includes(key))
    .map((key) =>
      issue(
        pathPrefix === "" ? key : `${pathPrefix}.${key}`,
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

function readYaml(path: string, source: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CatalogError(source, [issue("", `cannot read file at ${path}`)]);
  }
  try {
    return parseYaml(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CatalogError(source, [issue("", `invalid YAML: ${message}`)]);
  }
}

/** Load every `reports/<id>/report.yaml`. */
export function loadReports(reportsDir: string): Map<string, Report> {
  let entries: string[];
  try {
    entries = readdirSync(reportsDir).filter((name) => {
      if (name.startsWith(".") || isTemplateDir(name)) return false;
      return statSync(join(reportsDir, name)).isDirectory();
    });
  } catch {
    throw new CatalogError("reports/", [
      issue("", `cannot read reports directory at ${reportsDir}`),
    ]);
  }

  const reports = new Map<string, Report>();
  const issues: CatalogIssue[] = [];

  for (const dirName of entries.sort()) {
    const dir = join(reportsDir, dirName);
    const parsed = readYaml(join(dir, "report.yaml"), `reports/${dirName}/report.yaml`);

    const schemaIssues = typeboxIssues(ReportSchema, parsed).map((i) =>
      issue(`${dirName}.${i.path}`, i.message),
    );
    if (schemaIssues.length > 0) {
      issues.push(...unknownKeyIssues(ReportSchema, parsed, dirName), ...schemaIssues);
      continue;
    }

    const report = parsed as ReportDefinition;

    // The directory name is what tenants.yaml references, so a mismatch would
    // make a report addressable under a name its own metadata denies.
    if (report.id !== dirName) {
      issues.push(
        issue(
          `${dirName}.id`,
          `is "${report.id}" but the directory is "${dirName}" — they must match`,
        ),
      );
    }

    const columnNames = new Set(report.columns.map((c) => c.name));
    for (const [i, total] of (report.totals ?? []).entries()) {
      if (!columnNames.has(total.name)) {
        issues.push(
          issue(
            `${dirName}.totals[${i}].name`,
            `references column "${total.name}", which is not declared in columns`,
          ),
        );
      }
    }

    const seenColumns = new Set<string>();
    for (const [i, col] of report.columns.entries()) {
      if (seenColumns.has(col.name)) {
        issues.push(
          issue(`${dirName}.columns[${i}].name`, `duplicate column "${col.name}"`),
        );
      }
      seenColumns.add(col.name);
    }

    reports.set(report.id, { ...report, dir });
  }

  if (issues.length > 0) throw new CatalogError("reports/", issues);
  return reports;
}

/** Load `tenants.yaml` and check it against the report catalog. */
export function loadTenants(
  tenantsPath: string,
  reports: ReadonlyMap<string, Report>,
  deployment: Deployment,
): Tenant[] {
  const parsed = readYaml(tenantsPath, "tenants.yaml");

  const shape = {
    idFormat: deployment.resolved.tenantIdFormat,
    tenantScoped: deployment.resolved.tenantScoped,
  };
  const fileSchema = buildTenantsFileSchema(shape);
  const tenantSchema = buildTenantSchema(shape);

  const schemaIssues = typeboxIssues(fileSchema, parsed);
  if (schemaIssues.length > 0) {
    const named =
      typeof parsed === "object" && parsed !== null
        ? Object.entries(parsed as Record<string, unknown>).flatMap(([agentId, def]) =>
            unknownKeyIssues(
              tenantSchema as TSchema & { properties?: Record<string, unknown> },
              def,
              agentId,
            ),
          )
        : [];
    throw new CatalogError("tenants.yaml", [...named, ...schemaIssues]);
  }

  const byAgent = parsed as Record<string, TenantDefinition>;
  const issues: CatalogIssue[] = [];
  const tenants: Tenant[] = [];

  const tenantIds = new Map<string, string>();
  const channelIds = new Map<string, string>();

  for (const agentId of Object.keys(byAgent).sort()) {
    const def = byAgent[agentId];
    if (def === undefined) continue;

    if (agentId === QUARANTINE_AGENT_ID) {
      issues.push(
        issue(
          agentId,
          `"${QUARANTINE_AGENT_ID}" is reserved for the fallback agent and cannot be a tenant`,
        ),
      );
    }

    const resolvedTenantId = def.tenantId ?? SINGLE_TENANT_ID;

    // Only meaningful when tenants are actually scoped. In single-tenant mode
    // every agent shares the sentinel by construction, so the check would fire
    // on every stanza after the first and mean nothing.
    if (deployment.resolved.tenantScoped) {
      const prior = tenantIds.get(resolvedTenantId);
      if (prior !== undefined && def.allowSharedTenant !== true) {
        issues.push(
          issue(
            `${agentId}.tenantId`,
            `duplicates "${prior}" — two agents resolving to one tenant breaks isolation. If this is deliberate (a staging agent previewing a real tenant), set allowSharedTenant: true on this stanza.`,
          ),
        );
      } else if (prior === undefined) {
        tenantIds.set(resolvedTenantId, agentId);
      }
    }

    const priorChannel = channelIds.get(def.channelId);
    if (priorChannel !== undefined) {
      issues.push(
        issue(
          `${agentId}.channelId`,
          `duplicates "${priorChannel}" — a channel must bind to exactly one agent`,
        ),
      );
    } else {
      channelIds.set(def.channelId, agentId);
    }

    const timezone = def.timezone ?? deployment.reporting.timezone;
    if (!isValidTimezone(timezone)) {
      issues.push(
        issue(`${agentId}.timezone`, `"${timezone}" is not a valid IANA timezone`),
      );
    }

    for (const [i, reportId] of def.reports.entries()) {
      if (!reports.has(reportId)) {
        issues.push(
          issue(
            `${agentId}.reports[${i}]`,
            `references report "${reportId}", which has no reports/${reportId}/ directory`,
          ),
        );
      }
    }

    const entitled = new Set(def.reports);
    const scheduleIds = new Set<string>();

    for (const [i, schedule] of (def.schedules ?? []).entries()) {
      const at = `${agentId}.schedules[${i}]`;

      if (scheduleIds.has(schedule.id)) {
        issues.push(issue(`${at}.id`, `duplicate schedule id "${schedule.id}"`));
      }
      scheduleIds.add(schedule.id);

      if (!entitled.has(schedule.report)) {
        issues.push(
          issue(
            `${at}.report`,
            `schedules "${schedule.report}" but it is not in this tenant's reports[] — a report may be entitled without being scheduled, never the reverse`,
          ),
        );
        continue;
      }

      const report = reports.get(schedule.report);
      if (report !== undefined && !report.dateRanges.includes(schedule.dateRange)) {
        issues.push(
          issue(
            `${at}.dateRange`,
            `"${schedule.dateRange}" is not supported by report "${schedule.report}" (supports: ${report.dateRanges.join(", ")})`,
          ),
        );
      }
    }

    tenants.push({ ...def, agentId, resolvedTimezone: timezone, resolvedTenantId });
  }

  if (issues.length > 0) throw new CatalogError("tenants.yaml", issues);
  return tenants;
}

export function loadCatalog(options: LoadOptions): Catalog {
  const reports = loadReports(options.reportsDir);
  const tenants = loadTenants(options.tenantsPath, reports, options.deployment);
  const ops = options.opsPath === undefined ? undefined : loadOps(options.opsPath);
  return { reports, tenants, ...(ops === undefined ? {} : { ops }) };
}

/**
 * Load `ops.yaml`, or return undefined when the file is simply absent.
 *
 * A missing file is not an error: with no ops config there is no ops agent, no
 * ops channel and no announce tool. A file that exists but is malformed IS an
 * error — that is someone configuring the feature and getting it wrong, and
 * quietly ignoring it would leave them believing it works.
 */
export function loadOps(path: string): OpsDefinition | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseYaml(raw) as unknown;
  const issues = [
    ...typeboxIssues(OpsSchema, parsed),
    ...unknownKeyIssues(OpsSchema, parsed, ""),
  ];
  if (issues.length > 0) throw new CatalogError(path, issues);
  return parsed as OpsDefinition;
}
