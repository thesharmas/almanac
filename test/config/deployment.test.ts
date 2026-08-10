import { describe, expect, it } from "vitest";

import { CatalogError } from "../../src/catalog/errors.js";
import { parseDeployment } from "../../src/config/load.js";
import { deploymentInput, testDeployment } from "../helpers.js";

/** Collect the issue paths from a CatalogError thrown by `run`. */
function issuePaths(run: () => unknown): string[] {
  try {
    run();
  } catch (e) {
    if (e instanceof CatalogError) return e.issues.map((i) => i.path);
    throw e;
  }
  throw new Error("expected a CatalogError, but nothing was thrown");
}

describe("deployment config", () => {
  it("accepts a well-formed multi-tenant deployment", () => {
    const deployment = testDeployment();
    expect(deployment.resolved.tenantScoped).toBe(true);
    expect(deployment.resolved.tenantIdFormat).toBe("uuid");
  });

  it("applies defaults for model and maxDays", () => {
    const deployment = testDeployment((d) => ({
      ...d,
      reporting: { timezone: d.reporting.timezone, allTimeFloor: d.reporting.allTimeFloor },
    }));
    expect(deployment.resolved.model).toBe("anthropic/claude-sonnet-5");
    expect(deployment.resolved.defaultMaxDays).toBe(366);
  });

  // The whole point of additionalProperties:false — a control that was
  // deliberately removed must fail loudly rather than look honoured.
  it("rejects an unknown key and names it", () => {
    const paths = issuePaths(() =>
      parseDeployment(
        { ...deploymentInput(), users: ["someone@example.com"] },
        "deployment.yaml",
      ),
    );
    expect(paths).toContain("users");
  });

  describe("tenancy coherence", () => {
    it("requires a predicate in multi-tenant mode", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            tenancy: { mode: "multi", idFormat: "uuid" },
          },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("tenancy.predicate");
    });

    it("requires an idFormat in multi-tenant mode", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            tenancy: { mode: "multi", predicate: "f.T = {{tenant_id}}" },
          },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("tenancy.idFormat");
    });

    // A predicate without the placeholder passes the verbatim check and
    // scopes nothing — every channel would read the whole dataset.
    it("rejects a predicate that does not bind the tenant placeholder", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            tenancy: { mode: "multi", idFormat: "uuid", predicate: "f.TENANT_ID = 42" },
          },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("tenancy.predicate");
    });

    it("rejects an entityPredicate that does not bind {{entity}}", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            tenancy: {
              mode: "multi",
              idFormat: "uuid",
              predicate: "f.TENANT_ID = {{tenant_id}}",
              entityPredicate: "f.NAME LIKE '%x%'",
            },
          },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("tenancy.entityPredicate");
    });

    it("allows single-tenant mode with no predicate", () => {
      const deployment = parseDeployment(
        { ...deploymentInput(), tenancy: { mode: "single" } },
        "deployment.yaml",
      );
      expect(deployment.resolved.tenantScoped).toBe(false);
    });
  });

  describe("warehouse coherence", () => {
    it("requires the snowflake block when the adapter is snowflake", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          { ...deploymentInput(), warehouse: { adapter: "snowflake" } },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("warehouse.snowflake");
    });

    it("requires the mcp block when the adapter is mcp", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          { ...deploymentInput(), warehouse: { adapter: "mcp" } },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("warehouse.mcp");
    });
  });

  describe("reporting", () => {
    it("rejects an invalid IANA timezone", () => {
      const paths = issuePaths(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            reporting: { timezone: "Mars/Olympus", allTimeFloor: "2019-01-01" },
          },
          "deployment.yaml",
        ),
      );
      expect(paths).toContain("reporting.timezone");
    });

    it("rejects a malformed allTimeFloor", () => {
      expect(() =>
        parseDeployment(
          {
            ...deploymentInput(),
            reporting: { timezone: "UTC", allTimeFloor: "January 2019" },
          },
          "deployment.yaml",
        ),
      ).toThrow(CatalogError);
    });
  });
});
