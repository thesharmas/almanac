import { type CatalogIssue, issue } from "../catalog/errors.js";
import type { Deployment } from "../config/load.js";
import { ENTITY_PLACEHOLDER, TENANT_PLACEHOLDER } from "../config/load.js";

/**
 * The SQL template contract.
 *
 * This is the mechanism behind the guarantee that no model-derived value ever
 * reaches a SQL string, and behind that guarantee *holding as the catalog
 * grows*. A new report cannot introduce a new injection surface because there
 * is nowhere to put one: only four placeholders exist, and the tenant
 * predicate is not a convention to remember but a build failure when absent.
 *
 * These checks are deliberately textual rather than a SQL parse. A parser
 * would accept many spellings of the tenant filter; the point here is that
 * every report filters the tenant in *one* reviewed form, so a reviewer
 * diffing a new report knows exactly what to look for.
 *
 * @see docs/why.md §"The model never writes SQL"
 */

/** The only substitutions permitted in any report template. */
export const ALLOWED_PLACEHOLDERS = [
  TENANT_PLACEHOLDER,
  "start_date",
  "end_date",
  ENTITY_PLACEHOLDER,
] as const;

export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Full-range row count, required in every template — truncation math needs it. */
export const TOTAL_ROWS_COLUMN = "TOTAL_ROWS";

/**
 * The tenant's earliest date over the full range, required only of reports
 * offering `all_time`.
 *
 * `all_time` queries from a fixed floor that predates every row. Showing that
 * floor as the window start would tell a customer their programme began years
 * before it did, so the query computes the real first date — over the full
 * range, before the LIMIT, so truncation cannot move it — and the shaper
 * reports that instead.
 */
export const FIRST_DATE_COLUMN = "FIRST_DATE";

/** The column the timezone-drift guard compares against. */
export const REPORTED_DATE_COLUMN = "REPORTED_DATE";

/** The SQL alias a declared total must be exposed under. */
export function totalColumnFor(as: string): string {
  return `TOTAL_${as.toUpperCase()}`;
}

/** Strip `--` line comments so contract checks read code, not prose about code. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

export interface ContractOptions {
  /** report.yaml's rowCap; the template's LIMIT must equal it. */
  readonly rowCap: number;
  /**
   * The `as` names from report.yaml's `totals`. Each must appear in the SQL as
   * `AS TOTAL_<AS>` (uppercased), so the shaper maps totals mechanically
   * rather than every report needing bespoke wiring.
   *
   * Optional so contract fixtures can be checked in isolation; the shipped
   * catalog always passes them.
   */
  readonly totals?: readonly string[];
  /**
   * report.yaml's `dateRanges`. Only `all_time` imposes a requirement — its
   * start is a synthetic floor, so the query must return the tenant's real
   * first date for the shaper to substitute in.
   */
  readonly dateRanges?: readonly string[];
}

/** Statements that may never appear in a report template. */
const FORBIDDEN = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "CALL",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
] as const;

/**
 * Check a template against the contract. Returns every violation rather than
 * the first, so an author fixing a new report sees the whole list at once.
 */
export function checkTemplateContract(
  sql: string,
  deployment: Deployment,
  options: ContractOptions,
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const code = stripComments(sql);

  const tenantPredicate = deployment.tenancy.predicate;
  const entityPredicate = deployment.tenancy.entityPredicate;
  const required: string[] = ["start_date", "end_date"];
  if (deployment.resolved.tenantScoped) required.unshift(TENANT_PLACEHOLDER);

  // 1. Only known placeholders. An unknown one means someone is trying to
  //    parameterize something the contract does not allow.
  const found = new Set<string>();
  for (const match of code.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  for (const name of [...found].sort()) {
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name)) {
      issues.push(
        issue(
          "placeholders",
          `unknown placeholder {{${name}}} — only ${ALLOWED_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")} are permitted`,
        ),
      );
    }
  }
  for (const name of required) {
    if (!found.has(name)) {
      issues.push(issue("placeholders", `missing required placeholder {{${name}}}`));
    }
  }

  // 2. The tenant predicate, verbatim. This is the isolation boundary.
  if (deployment.resolved.tenantScoped && tenantPredicate !== undefined) {
    if (!code.includes(tenantPredicate)) {
      issues.push(
        issue(
          "tenant",
          `missing the tenant predicate — every template must filter with exactly "${tenantPredicate}" (deployment.yaml tenancy.predicate)`,
        ),
      );
    }
  }

  // An entity filter is optional, but if present it must be the reviewed form.
  // Checked textually for the same reason the tenant predicate is: one
  // spelling means a reviewer knows exactly what to look for, and a template
  // cannot quietly compare the model's value against a different column.
  if (found.has(ENTITY_PLACEHOLDER)) {
    if (entityPredicate === undefined) {
      issues.push(
        issue(
          "entity",
          `uses {{${ENTITY_PLACEHOLDER}}} but deployment.yaml declares no tenancy.entityPredicate — there is no reviewed form for it to take`,
        ),
      );
    } else if (!code.includes(entityPredicate)) {
      issues.push(
        issue(
          "entity",
          `uses {{${ENTITY_PLACEHOLDER}}} but not in the permitted form — it must appear exactly as "${entityPredicate}", ANDed with the tenant predicate`,
        ),
      );
    }
  }

  // 3. One statement. Most warehouses reject stacked statements anyway, but
  //    failing here means it is caught in review rather than at runtime.
  const withoutTrailing = code.trimEnd().replace(/;+$/, "");
  if (withoutTrailing.includes(";")) {
    issues.push(
      issue("statement", "contains more than one statement — only one is permitted"),
    );
  }

  // 4. Read-only. A report may never mutate.
  const firstWord = withoutTrailing.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    issues.push(
      issue("statement", `must start with SELECT or WITH, found "${firstWord}"`),
    );
  }
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(code)) {
      issues.push(issue("statement", `contains forbidden keyword ${word}`));
    }
  }

  // 5. CURRENT_DATE() selected back, for the session-timezone drift guard.
  if (!new RegExp(`CURRENT_DATE\\(\\)\\s+AS\\s+${REPORTED_DATE_COLUMN}`, "i").test(code)) {
    issues.push(
      issue(
        "reported_date",
        `must select CURRENT_DATE() AS ${REPORTED_DATE_COLUMN} so the session-timezone guard has something to assert against`,
      ),
    );
  }

  // 6. Deterministic ORDER BY. With a LIMIT, ordering decides which rows
  //    survive truncation; without it the retained subset is arbitrary.
  if (!/\bORDER\s+BY\b/i.test(code)) {
    issues.push(
      issue(
        "order_by",
        "missing ORDER BY — with a LIMIT, ordering decides which rows survive truncation",
      ),
    );
  }

  // 7. Totals. TOTAL_ROWS is the full-range row count truncation is computed
  //    from, and every declared total must be exposed under a predictable
  //    alias so the shaper needs no per-report wiring.
  if (!new RegExp(`\\bAS\\s+${TOTAL_ROWS_COLUMN}\\b`, "i").test(code)) {
    issues.push(
      issue(
        "totals",
        `must select the full-range row count AS ${TOTAL_ROWS_COLUMN} — truncation is derived from it`,
      ),
    );
  }
  for (const as of options.totals ?? []) {
    const column = totalColumnFor(as);
    if (!new RegExp(`\\bAS\\s+${column}\\b`, "i").test(code)) {
      issues.push(
        issue(
          "totals",
          `report.yaml declares total "${as}" but the SQL selects no ${column}`,
        ),
      );
    }
  }

  // 7a. A report offering `all_time` must return the real first date, or the
  //     shaper falls back to the synthetic floor and the customer is shown a
  //     start date years before their first row.
  if (
    (options.dateRanges ?? []).includes("all_time") &&
    !new RegExp(`\\bAS\\s+${FIRST_DATE_COLUMN}\\b`, "i").test(code)
  ) {
    issues.push(
      issue(
        "totals",
        `report.yaml offers all_time but the SQL selects no ${FIRST_DATE_COLUMN} — the window start would show the synthetic floor`,
      ),
    );
  }

  // 8. LIMIT must exist and agree with report.yaml's rowCap.
  const limitMatch = /\bLIMIT\s+(\d+)/i.exec(code);
  if (limitMatch === null) {
    issues.push(issue("limit", `missing LIMIT — expected LIMIT ${String(options.rowCap)}`));
  } else {
    const limit = Number(limitMatch[1]);
    if (limit !== options.rowCap) {
      issues.push(
        issue(
          "limit",
          `LIMIT ${String(limit)} disagrees with report.yaml rowCap ${String(options.rowCap)}`,
        ),
      );
    }
  }

  return issues;
}
