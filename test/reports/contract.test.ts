import { describe, expect, it } from "vitest";

import { checkTemplateContract } from "../../src/reports/contract.js";
import { singleTenantDeployment, testDeployment, VALID_TEMPLATE } from "../helpers.js";

/**
 * The contract is the mechanism behind "a new report cannot introduce a new
 * injection surface". Each test below is one way somebody could, without it.
 */

const deployment = testDeployment();

function check(sql: string, options: Parameters<typeof checkTemplateContract>[2] = { rowCap: 500 }) {
  return checkTemplateContract(sql, deployment, options).map((i) => i.path);
}

describe("template contract", () => {
  it("accepts a template that satisfies every rule", () => {
    expect(check(VALID_TEMPLATE)).toEqual([]);
  });

  it("rejects an unknown placeholder", () => {
    const sql = VALID_TEMPLATE.replace("LIMIT 500", "AND f.X = {{table_name}} LIMIT 500");
    expect(check(sql)).toContain("placeholders");
  });

  it("rejects a missing required placeholder", () => {
    const sql = VALID_TEMPLATE.replace("{{start_date}}", "'2026-01-01'");
    expect(check(sql)).toContain("placeholders");
  });

  // The isolation boundary. Without the predicate the query returns every
  // tenant's rows, and every other control in the system would faithfully
  // deliver them.
  it("rejects a template missing the tenant predicate", () => {
    const sql = VALID_TEMPLATE.replace(
      "f.TENANT_ID = {{tenant_id}}",
      "f.SOMETHING_ELSE = {{tenant_id}}",
    );
    expect(check(sql)).toContain("tenant");
  });

  it("rejects an entity filter written in an unreviewed form", () => {
    const sql = VALID_TEMPLATE.replace(
      "LIMIT 500",
      "AND f.NOTES LIKE {{entity}} LIMIT 500",
    );
    expect(check(sql)).toContain("entity");
  });

  it("accepts the entity filter in exactly the declared form", () => {
    const sql = VALID_TEMPLATE.replace(
      "LIMIT 500",
      "AND UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}}) LIMIT 500",
    );
    expect(check(sql)).toEqual([]);
  });

  it("rejects {{entity}} when the deployment declares no entityPredicate", () => {
    const noEntity = testDeployment((d) => ({
      ...d,
      tenancy: {
        mode: "multi",
        idFormat: "uuid",
        predicate: "f.TENANT_ID = {{tenant_id}}",
      },
    }));
    const sql = VALID_TEMPLATE.replace(
      "LIMIT 500",
      "AND UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}}) LIMIT 500",
    );
    const paths = checkTemplateContract(sql, noEntity, { rowCap: 500 }).map((i) => i.path);
    expect(paths).toContain("entity");
  });

  it("rejects stacked statements", () => {
    const sql = `${VALID_TEMPLATE}; SELECT 1`;
    expect(check(sql)).toContain("statement");
  });

  it.each([
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "DROP",
    "CREATE",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "CALL",
  ])("rejects a template containing %s", (keyword) => {
    const sql = VALID_TEMPLATE.replace("SELECT\n", `SELECT ${keyword}_MARKER,\n`).replace(
      "FROM scoped s",
      `FROM scoped s /* ${keyword} */`,
    );
    // The keyword appears inside a block comment, which the checker does not
    // strip — only `--` line comments are. Deliberate: a keyword anywhere in
    // the text is worth failing on rather than reasoning about SQL comments.
    const withKeyword = `${sql}\n${keyword} something`;
    expect(check(withKeyword)).toContain("statement");
  });

  it("does not trip on a forbidden keyword inside a -- comment", () => {
    const sql = VALID_TEMPLATE.replace(
      "WITH scoped AS (",
      "-- We never DELETE from this table.\nWITH scoped AS (",
    );
    expect(check(sql)).toEqual([]);
  });

  it("requires the statement to start with SELECT or WITH", () => {
    expect(check("EXPLAIN SELECT 1")).toContain("statement");
  });

  it("requires CURRENT_DATE() AS REPORTED_DATE", () => {
    const sql = VALID_TEMPLATE.replace("CURRENT_DATE() AS REPORTED_DATE", "'x' AS OTHER");
    expect(check(sql)).toContain("reported_date");
  });

  it("requires a deterministic ORDER BY", () => {
    const sql = VALID_TEMPLATE.replace(
      "ORDER BY s.AMOUNT_CENTS DESC, s.ENTITY_NAME",
      "",
    );
    expect(check(sql)).toContain("order_by");
  });

  it("requires TOTAL_ROWS", () => {
    const sql = VALID_TEMPLATE.replace("AS TOTAL_ROWS", "AS ROW_COUNT");
    expect(check(sql)).toContain("totals");
  });

  it("requires a TOTAL_ column for every declared total", () => {
    expect(check(VALID_TEMPLATE, { rowCap: 500, totals: ["amount", "records"] })).toContain(
      "totals",
    );
  });

  it("requires FIRST_DATE when the report offers all_time", () => {
    const sql = VALID_TEMPLATE.replace("AS FIRST_DATE", "AS SOMETHING");
    expect(check(sql, { rowCap: 500, dateRanges: ["all_time"] })).toContain("totals");
  });

  it("does not require FIRST_DATE when all_time is not offered", () => {
    const sql = VALID_TEMPLATE.replace("AS FIRST_DATE", "AS SOMETHING");
    expect(check(sql, { rowCap: 500, dateRanges: ["today"] })).toEqual([]);
  });

  it("requires a LIMIT", () => {
    const sql = VALID_TEMPLATE.replace("LIMIT 500", "");
    expect(check(sql)).toContain("limit");
  });

  // The cap in the YAML and the cap in the SQL cannot disagree, because
  // truncation is computed from one and enforced by the other.
  it("rejects a LIMIT that disagrees with rowCap", () => {
    expect(check(VALID_TEMPLATE, { rowCap: 1500 })).toContain("limit");
  });

  it("reports every violation at once, not just the first", () => {
    const broken = "SELECT 1";
    const paths = check(broken);
    expect(paths.length).toBeGreaterThan(4);
  });

  describe("single-tenant mode", () => {
    const single = singleTenantDeployment();

    it("does not require the tenant placeholder or predicate", () => {
      const sql = VALID_TEMPLATE.replace(
        "WHERE f.TENANT_ID = {{tenant_id}}\n    AND",
        "WHERE",
      );
      const paths = checkTemplateContract(sql, single, { rowCap: 500 }).map((i) => i.path);
      expect(paths).toEqual([]);
    });

    it("still requires the date placeholders", () => {
      const sql = VALID_TEMPLATE.replace("{{end_date}}", "CURRENT_DATE()");
      const paths = checkTemplateContract(sql, single, { rowCap: 500 }).map((i) => i.path);
      expect(paths).toContain("placeholders");
    });
  });
});
