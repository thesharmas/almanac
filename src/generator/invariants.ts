import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CronExpressionParser } from "cron-parser";

import { issue, type CatalogIssue } from "../catalog/errors.js";
import { resolveFamilies, supersededIds } from "../catalog/families.js";
import type { Catalog } from "../catalog/load.js";
import { OPS_AGENT_ID } from "../catalog/ops-schema.js";
import { QUARANTINE_AGENT_ID } from "../catalog/schema.js";
import type { Deployment } from "../config/load.js";
import { checkTemplateContract } from "../reports/contract.js";
import type { GeneratedArtifacts } from "./artifacts.js";

/**
 * Build-time invariants.
 *
 * The lockstep check is the primary drift defence: an allowlisted channel with
 * no binding falls through to the default agent silently, which is the single
 * most likely way a message reaches something that was not meant to answer it.
 *
 * Everything here fails the build rather than warning, because a warning in CI
 * is a warning nobody reads.
 *
 * Catalog-internal checks (schema, referential integrity, timezone validity)
 * already ran in the loader. These are the ones needing the *generated
 * artifacts*, plus cron semantics and the SQL contract.
 */

/** Minimum gap between two schedules for the same tenant. */
export const MIN_SCHEDULE_GAP_MINUTES = 30;

/** How far ahead to look when checking for colliding fire times. */
const COLLISION_HORIZON_DAYS = 400;
const MAX_OCCURRENCES = 600;

export function checkInvariants(
  deployment: Deployment,
  catalog: Catalog,
  artifacts: GeneratedArtifacts,
): CatalogIssue[] {
  return [
    ...checkLockstep(artifacts),
    ...checkTemplates(deployment, catalog),
    ...checkCronExpressions(catalog),
    ...checkScheduleSpacing(catalog),
    ...checkReportFamilies(catalog),
  ];
}

/**
 * Every report's SQL against the contract.
 *
 * Run here as well as at render time on purpose. Here it is a build gate, so a
 * bad template cannot reach a VM; there it is a runtime gate, because a file
 * that changed after CI passed must not be executed.
 */
function checkTemplates(deployment: Deployment, catalog: Catalog): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  for (const report of catalog.reports.values()) {
    let sql: string;
    try {
      sql = readFileSync(join(report.dir, "query.sql"), "utf8");
    } catch {
      issues.push(issue(`reports.${report.id}`, "has no query.sql"));
      continue;
    }

    const found = checkTemplateContract(sql, deployment, {
      rowCap: report.rowCap,
      totals: (report.totals ?? []).map((t) => t.as),
      dateRanges: report.dateRanges,
    });
    for (const problem of found) {
      issues.push(issue(`reports.${report.id}.${problem.path}`, problem.message));
    }
  }

  return issues;
}

/**
 * Versioned reports.
 *
 * Three failures, all build-stopping:
 *
 *  1. `supersedes` naming a report that does not exist — the link is the only
 *     thing tying a version to its predecessor, so a typo silently splits one
 *     family into two and disables check 3 for both.
 *  2. A cycle, which would otherwise hang the walk.
 *  3. **A tenant entitled to two reports in the same family.** This is the one
 *     that matters. Their prompt would list two capabilities with the same
 *     title and description, and the model would choose between them
 *     arbitrarily — both real, both entitled, both returning correct numbers
 *     for whichever question it decided to answer. Nothing downstream can see
 *     it, which is why it has to fail here.
 */
function checkReportFamilies(catalog: Catalog): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const { rootOf, danglingSupersedes, cycles } = resolveFamilies(catalog.reports);

  for (const { id, target } of danglingSupersedes) {
    issues.push(
      issue(
        `reports.${id}.supersedes`,
        `names "${target}", which is not a report in the catalog. Either the id is wrong, or the report it replaces was deleted before every tenant had moved off it.`,
      ),
    );
  }

  for (const id of cycles) {
    issues.push(
      issue(
        `reports.${id}.supersedes`,
        "forms a cycle — a report cannot supersede itself",
      ),
    );
  }

  for (const tenant of catalog.tenants) {
    const byFamily = new Map<string, string[]>();
    for (const reportId of tenant.reports) {
      const root = rootOf.get(reportId);
      if (root === undefined) continue;
      byFamily.set(root, [...(byFamily.get(root) ?? []), reportId]);
    }
    for (const [root, members] of byFamily) {
      if (members.length < 2) continue;
      issues.push(
        issue(
          `${tenant.agentId}.reports`,
          `entitled to ${members.map((m) => `"${m}"`).join(" and ")}, which are versions of the same report (family "${root}"). Their prompt would offer both under the same title and the model would pick between them arbitrarily. Entitle exactly one — moving a tenant to a new version means replacing the old id, not adding to it.`,
        ),
      );
    }
  }

  return issues;
}

/**
 * Migrations in flight: a superseded report tenants are still on.
 *
 * Deliberately a warning and not a failure. The intermediate state is
 * *correct* — staging moves to the new version first and tenants follow one PR
 * at a time — so failing here would make the safe path impossible. But an
 * unfinished migration is easy to forget, and the residue is two reports whose
 * SQL has to be kept in step forever. Naming the stragglers on every build is
 * what keeps it visible.
 */
export function reportFamilyWarnings(catalog: Catalog): string[] {
  const superseded = supersededIds(catalog.reports);
  const warnings: string[] = [];

  for (const oldId of [...superseded].sort()) {
    const replacements = [...catalog.reports.values()]
      .filter((r) => r.supersedes === oldId)
      .map((r) => r.id);
    const stillOn = catalog.tenants
      .filter((t) => t.reports.includes(oldId))
      .map((t) => t.agentId);

    if (stillOn.length > 0) {
      warnings.push(
        `migration in flight: ${String(stillOn.length)} tenant(s) still on "${oldId}" (${stillOn.join(", ")}) — superseded by ${replacements.map((r) => `"${r}"`).join(", ")}`,
      );
    } else {
      warnings.push(
        `"${oldId}" is superseded by ${replacements.map((r) => `"${r}"`).join(", ")} and no tenant is entitled to it — delete reports/${oldId}/`,
      );
    }
  }

  return warnings;
}

/**
 * Every allowlisted channel has exactly one binding; every binding has a
 * tenant map entry; every map entry has an agent entry. All four must agree.
 */
function checkLockstep(artifacts: GeneratedArtifacts): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  const allowlisted = new Set(Object.keys(artifacts.openclaw.channels.slack.channels));
  const agentIds = new Set(artifacts.openclaw.agents.list.map((a) => a.id));
  const tenantAgents = new Set(Object.keys(artifacts.tenantMap));

  const boundChannels = new Map<string, string[]>();
  for (const binding of artifacts.openclaw.bindings) {
    const list = boundChannels.get(binding.match.peer.id) ?? [];
    list.push(binding.agentId);
    boundChannels.set(binding.match.peer.id, list);

    if (!agentIds.has(binding.agentId)) {
      issues.push(
        issue(
          `bindings.${binding.agentId}`,
          "binds an agent that has no agents.list entry",
        ),
      );
    }
    // Every check applies to ops EXCEPT the tenant one. It is bound to a
    // channel and must have an agent entry and an allowlist entry like anyone
    // else, but it has no tenant on purpose: it never reads tenant data, so
    // `run_report` refuses for it by the same fail-closed check that protects
    // everyone else. Requiring a tenant here would mean inventing an id, and a
    // fake tenant id in the map is the kind of value that looks harmless until
    // something joins on it.
    if (binding.agentId !== OPS_AGENT_ID && !tenantAgents.has(binding.agentId)) {
      issues.push(
        issue(`bindings.${binding.agentId}`, "binds an agent that has no tenant map entry"),
      );
    }
    if (!allowlisted.has(binding.match.peer.id)) {
      issues.push(
        issue(
          `bindings.${binding.agentId}`,
          `binds channel ${binding.match.peer.id}, which is not in the Slack allowlist`,
        ),
      );
    }
  }

  for (const channelId of allowlisted) {
    const bound = boundChannels.get(channelId) ?? [];
    if (bound.length === 0) {
      issues.push(
        issue(
          `channels.${channelId}`,
          "is allowlisted but has no binding — messages would fall through to the default agent silently",
        ),
      );
    } else if (bound.length > 1) {
      issues.push(
        issue(
          `channels.${channelId}`,
          `has ${String(bound.length)} bindings (${bound.join(", ")}); a channel must bind to exactly one agent`,
        ),
      );
    }
  }

  for (const agentId of tenantAgents) {
    if (!agentIds.has(agentId)) {
      issues.push(issue(`tenantMap.${agentId}`, "has no agents.list entry"));
    }
  }

  // The fallback must exist and must not be a tenant.
  if (!agentIds.has(QUARANTINE_AGENT_ID)) {
    issues.push(
      issue(
        "agents.list",
        `no ${QUARANTINE_AGENT_ID} agent — the fallback would land on a tenant agent`,
      ),
    );
  }
  if (tenantAgents.has(QUARANTINE_AGENT_ID)) {
    issues.push(
      issue(`tenantMap.${QUARANTINE_AGENT_ID}`, "the fallback agent must have no tenant"),
    );
  }

  return issues;
}

function checkCronExpressions(catalog: Catalog): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  for (const tenant of catalog.tenants) {
    for (const [i, schedule] of (tenant.schedules ?? []).entries()) {
      try {
        CronExpressionParser.parse(schedule.cron, { tz: tenant.resolvedTimezone });
      } catch (e) {
        issues.push(
          issue(
            `${tenant.agentId}.schedules[${String(i)}].cron`,
            `is not a valid cron expression: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    }
  }
  return issues;
}

function occurrences(cron: string, tz: string, from: Date): number[] {
  const horizon = from.getTime() + COLLISION_HORIZON_DAYS * 86_400_000;
  const iterator = CronExpressionParser.parse(cron, { tz, currentDate: from });
  const times: number[] = [];
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const next = iterator.next().toDate().getTime();
    if (next > horizon) break;
    times.push(next);
  }
  return times;
}

/**
 * No two schedules for one tenant may fire within 30 minutes.
 *
 * Without this, the 1st of a month can deliver a daily digest plus two monthly
 * reports into a channel within seconds of each other. Checked against real
 * fire times rather than by comparing cron strings, because "0 9 1 * *" and
 * "0 9 * * 1-5" collide only on some dates.
 */
function checkScheduleSpacing(catalog: Catalog): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const gapMs = MIN_SCHEDULE_GAP_MINUTES * 60_000;
  // Fixed origin so the check is deterministic across CI runs.
  const from = new Date("2026-01-01T00:00:00Z");

  for (const tenant of catalog.tenants) {
    const schedules = tenant.schedules ?? [];
    const fired = schedules.map((s) => {
      try {
        return occurrences(s.cron, tenant.resolvedTimezone, from);
      } catch {
        return []; // Invalid cron is already reported by checkCronExpressions.
      }
    });

    for (let a = 0; a < schedules.length; a++) {
      for (let b = a + 1; b < schedules.length; b++) {
        const clash = findClash(fired[a] ?? [], fired[b] ?? [], gapMs);
        if (clash !== null) {
          const first = schedules[a];
          const second = schedules[b];
          if (first === undefined || second === undefined) continue;
          issues.push(
            issue(
              `${tenant.agentId}.schedules`,
              `"${first.id}" and "${second.id}" both fire around ${new Date(clash).toISOString()}, within ${String(MIN_SCHEDULE_GAP_MINUTES)} minutes — space them apart so one channel does not receive several unprompted posts at once`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

/** First timestamp where two sorted occurrence lists come within `gapMs`. */
function findClash(
  a: readonly number[],
  b: readonly number[],
  gapMs: number,
): number | null {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) break;
    if (Math.abs(left - right) < gapMs) return Math.min(left, right);
    if (left < right) i++;
    else j++;
  }
  return null;
}
