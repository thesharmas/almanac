import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CatalogError } from "../../src/catalog/errors.js";
import { loadReports, loadTenants } from "../../src/catalog/load.js";
import { REPORTS_DIR, singleTenantDeployment, testDeployment } from "../helpers.js";

const deployment = testDeployment();
const reports = loadReports(REPORTS_DIR);

/** Write a tenants.yaml into a temp dir and load it. */
function loadYaml(yaml: string, config = deployment) {
  const dir = mkdtempSync(join(tmpdir(), "almanac-"));
  const path = join(dir, "tenants.yaml");
  writeFileSync(path, yaml);
  return loadTenants(path, reports, config);
}

function issuesFrom(yaml: string, config = deployment): string[] {
  try {
    loadYaml(yaml, config);
  } catch (e) {
    if (e instanceof CatalogError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  throw new Error("expected a CatalogError");
}

const VALID = `
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  displayName: Northwind Traders
  reports: [totals_by_entity]
`;

describe("loading the report catalog", () => {
  it("loads the fixture reports", () => {
    expect([...reports.keys()].sort()).toEqual(["records_by_entity", "totals_by_entity"]);
  });

  // `_archetypes/` ships as templates whose SQL is deliberately incomplete.
  // Loading them would fail a fresh clone before anyone did anything wrong.
  it("skips underscore-prefixed directories", () => {
    const shipped = loadReports(join(process.cwd(), "reports"));
    expect(shipped.size).toBe(0);
  });
});

describe("loading tenants", () => {
  it("accepts a well-formed stanza", () => {
    const tenants = loadYaml(VALID);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.agentId).toBe("northwind");
    expect(tenants[0]?.resolvedTimezone).toBe("America/Los_Angeles");
  });

  it("defaults the timezone from the deployment", () => {
    const utc = testDeployment((d) => ({
      ...d,
      reporting: { ...d.reporting, timezone: "UTC" },
    }));
    expect(loadYaml(VALID, utc)[0]?.resolvedTimezone).toBe("UTC");
  });

  // The whole point of additionalProperties:false at the catalog layer.
  it("names an unknown key", () => {
    const issues = issuesFrom(`${VALID}  users: [someone]\n`);
    expect(issues.join()).toContain("users");
  });

  it("rejects a channel id that is a name rather than an id", () => {
    const issues = issuesFrom(`
northwind:
  channelId: "#almanac-northwind"
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("channelId");
  });

  it("rejects a tenant id that does not match the declared format", () => {
    const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "not-a-uuid"
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("tenantId");
  });

  // Two agents on one tenant is normally an isolation bug.
  it("rejects two agents sharing a tenant without the explicit flag", () => {
    const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
staging:
  channelId: C0STAGING
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("allowSharedTenant");
  });

  it("permits a shared tenant when the intent is declared", () => {
    const tenants = loadYaml(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
staging:
  channelId: C0STAGING
  tenantId: "11111111-1111-1111-1111-111111111111"
  allowSharedTenant: true
  reports: [totals_by_entity]
`);
    expect(tenants).toHaveLength(2);
  });

  it("rejects two agents bound to one channel", () => {
    const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
contoso:
  channelId: C0NWIND
  tenantId: "22222222-2222-2222-2222-222222222222"
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("must bind to exactly one agent");
  });

  it("rejects the reserved fallback agent id", () => {
    const issues = issuesFrom(`
quarantine:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("reserved");
  });

  it("rejects a report with no directory", () => {
    const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [no_such_report]
`);
    expect(issues.join()).toContain("no_such_report");
  });

  it("rejects an invalid timezone", () => {
    const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  timezone: Mars/Olympus
  reports: [totals_by_entity]
`);
    expect(issues.join()).toContain("timezone");
  });

  describe("schedules", () => {
    // A report may be entitled without being scheduled; never the reverse.
    it("rejects scheduling a report the tenant is not entitled to", () => {
      const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
  schedules:
    - id: daily
      report: records_by_entity
      dateRange: today
      cron: "0 17 * * 1-5"
`);
      expect(issues.join()).toContain("never the reverse");
    });

    it("rejects a window the scheduled report does not support", () => {
      const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
  schedules:
    - id: daily
      report: totals_by_entity
      dateRange: qtd
      cron: "0 17 * * 1-5"
`);
      expect(issues.join()).toContain("qtd");
    });

    // The parameterised windows are interactive-only: a scheduled wide window
    // would truncate every morning with nobody present to narrow it.
    it("rejects a parameterised window in a schedule", () => {
      const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
  schedules:
    - id: daily
      report: totals_by_entity
      dateRange: all_time
      cron: "0 17 * * 1-5"
`);
      expect(issues.join()).toContain("dateRange");
    });

    it("rejects duplicate schedule ids", () => {
      const issues = issuesFrom(`
northwind:
  channelId: C0NWIND
  tenantId: "11111111-1111-1111-1111-111111111111"
  reports: [totals_by_entity]
  schedules:
    - id: daily
      report: totals_by_entity
      dateRange: today
      cron: "0 17 * * 1-5"
    - id: daily
      report: totals_by_entity
      dateRange: mtd
      cron: "0 9 * * 1"
`);
      expect(issues.join()).toContain("duplicate schedule id");
    });
  });

  describe("single-tenant mode", () => {
    const single = singleTenantDeployment();

    it("permits a stanza with no tenantId", () => {
      const tenants = loadYaml(
        `
internal:
  channelId: C0INTERNAL
  reports: [totals_by_entity]
`,
        single,
      );
      expect(tenants[0]?.resolvedTenantId).toBe("__single__");
    });

    // Every agent shares the sentinel by construction, so the shared-tenant
    // check would fire on every stanza after the first and mean nothing.
    it("does not complain about two agents sharing the sentinel", () => {
      const tenants = loadYaml(
        `
engineering:
  channelId: C0ENG
  reports: [totals_by_entity]
finance:
  channelId: C0FIN
  reports: [totals_by_entity]
`,
        single,
      );
      expect(tenants).toHaveLength(2);
    });
  });
});
