import { describe, expect, it } from "vitest";

import { renderTemplate, UnsafeValueError } from "../../src/reports/render.js";
import { testDeployment, VALID_TEMPLATE } from "../helpers.js";

/**
 * The literal encoder is the last line of the "no model-derived value reaches
 * SQL" argument, not the first. These tests are what make it a line.
 */

const deployment = testDeployment();
const TENANT = "11111111-1111-1111-1111-111111111111";

const base = {
  tenant_id: TENANT,
  start_date: "2026-08-01",
  end_date: "2026-08-10",
};

function render(values: Parameters<typeof renderTemplate>[1], sql = VALID_TEMPLATE) {
  return renderTemplate(sql, values, deployment, { rowCap: 500, source: "test.sql" });
}

describe("template rendering", () => {
  it("substitutes quoted literals", () => {
    const sql = render(base);
    expect(sql).toContain(`f.TENANT_ID = '${TENANT}'`);
    expect(sql).toContain("'2026-08-01'");
    expect(sql).toContain("'2026-08-10'");
  });

  it("leaves no placeholder behind", () => {
    expect(render(base)).not.toMatch(/\{\{/);
  });

  describe("tenant id", () => {
    it.each([
      ["not a uuid", "'; DROP TABLE facts; --"],
      ["a uuid with a trailing quote", `${TENANT}'`],
      ["an empty string", ""],
      ["a wildcard", "%"],
    ])("refuses %s", (_label, value) => {
      expect(() => render({ ...base, tenant_id: value })).toThrow(UnsafeValueError);
    });

    it("accepts an integer id when the deployment declares that format", () => {
      const intDeployment = testDeployment((d) => ({
        ...d,
        tenancy: { ...d.tenancy, idFormat: "integer" },
      }));
      const sql = renderTemplate(
        VALID_TEMPLATE,
        { ...base, tenant_id: "40219" },
        intDeployment,
        { rowCap: 500, source: "test.sql" },
      );
      expect(sql).toContain("f.TENANT_ID = '40219'");
    });

    it("refuses a uuid when the deployment declares integer ids", () => {
      const intDeployment = testDeployment((d) => ({
        ...d,
        tenancy: { ...d.tenancy, idFormat: "integer" },
      }));
      expect(() =>
        renderTemplate(VALID_TEMPLATE, base, intDeployment, {
          rowCap: 500,
          source: "test.sql",
        }),
      ).toThrow(UnsafeValueError);
    });
  });

  describe("dates", () => {
    it.each(["2026-8-1", "August 1", "2026-08-01 OR 1=1", ""])(
      "refuses %s",
      (value) => {
        expect(() => render({ ...base, start_date: value })).toThrow(UnsafeValueError);
      },
    );
  });

  describe("entity — the one model-chosen value", () => {
    const entitySql = VALID_TEMPLATE.replace(
      "LIMIT 500",
      "AND UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}}) LIMIT 500",
    );

    it("wraps the value in LIKE wildcards itself", () => {
      const sql = render({ ...base, entity: "Northwind" }, entitySql);
      expect(sql).toContain("UPPER('%Northwind%')");
    });

    // Excluding apostrophes would refuse real trading names. Permitting and
    // doubling them is the correct answer; refusing a customer's largest
    // account is not a security posture.
    it("permits apostrophes and doubles them", () => {
      const sql = render({ ...base, entity: "O'Brien Supply" }, entitySql);
      expect(sql).toContain("'%O''Brien Supply%'");
    });

    it.each([
      ["a quote-and-comment escape", `x' OR '1'='1' --`],
      ["a semicolon", "acme; DROP TABLE facts"],
      ["a backslash", "acme\\"],
      ["a double quote", 'acme"'],
      ["a block comment", "acme /* x */"],
      ["an over-long name", "a".repeat(121)],
    ])("refuses %s", (_label, value) => {
      expect(() => render({ ...base, entity: value }, entitySql)).toThrow(
        UnsafeValueError,
      );
    });

    it("refuses to render a template that needs an entity without one", () => {
      expect(() => render(base, entitySql)).toThrow(UnsafeValueError);
    });

    it("ignores a stray entity value when the template does not use one", () => {
      const sql = render({ ...base, entity: "Northwind" });
      expect(sql).not.toContain("Northwind");
    });
  });

  // The contract is re-checked at render time, not only in CI: a template is
  // read from disk at runtime, and a file that changed after CI passed must
  // not be executed.
  it("refuses to render a template that violates the contract", () => {
    const tampered = VALID_TEMPLATE.replace(
      "f.TENANT_ID = {{tenant_id}}",
      "1 = 1 AND {{tenant_id}} IS NOT NULL",
    );
    expect(() => render(base, tampered)).toThrow(/tenant predicate/);
  });

  it("does not let a $ in a value corrupt the substitution", () => {
    const entitySql = VALID_TEMPLATE.replace(
      "LIMIT 500",
      "AND UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}}) LIMIT 500",
    );
    const sql = render({ ...base, entity: "A & B (Holdings)" }, entitySql);
    expect(sql).toContain("'%A & B (Holdings)%'");
  });
});
