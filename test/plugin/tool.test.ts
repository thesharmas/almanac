import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { loadReports } from "../../src/catalog/load.js";
import { RecordingAuditLogger } from "../../src/plugin/audit.js";
import { RecordingEscalator } from "../../src/plugin/escalate.js";
import type { TenantMap } from "../../src/plugin/tenant.js";
import { createRunReportTool } from "../../src/plugin/tool.js";
import type { QueryResult } from "../../src/warehouse/types.js";
import { REPORTS_DIR, testDeployment } from "../helpers.js";

/**
 * The tool boundary end to end.
 *
 * Every refusal must do the same three things — audit, escalate, and return a
 * calm sentence revealing nothing — because the sentence a customer sees is
 * the one place all these failures become visible.
 */

const deployment = testDeployment();
const reports = loadReports(REPORTS_DIR);
const templates = new Map(
  [...reports].map(([id, r]) => [id, readFileSync(join(r.dir, "query.sql"), "utf8")]),
);

const NORTHWIND = "11111111-1111-1111-1111-111111111111";

const tenantMap: TenantMap = {
  northwind: {
    tenantId: NORTHWIND,
    channelId: "C0NWIND",
    reports: ["totals_by_entity"],
  },
  contoso: {
    tenantId: "22222222-2222-2222-2222-222222222222",
    channelId: "C0CONTOSO",
    reports: ["totals_by_entity", "records_by_entity"],
  },
};

const NOW = new Date("2026-08-10T17:00:00Z");

function okResult(): QueryResult {
  return {
    rows: [
      {
        REPORTED_DATE: "2026-08-10",
        ENTITY_NAME: "Northwind Traders",
        ENTITY_ID: "900000000000000000000001",
        RECORDS: 3,
        AMOUNT_CENTS: 120000,
        TOTAL_ROWS: 1,
        TOTAL_AMOUNT: 120000,
        TOTAL_RECORDS: 3,
        TOTAL_ENTITIES: 1,
        FIRST_DATE: "2024-01-02",
      },
    ],
    rowCount: 1,
    columns: [],
  };
}

let audit: RecordingAuditLogger;
let escalator: RecordingEscalator;
let executed: string[];

function build(
  ctxOverrides: Record<string, unknown> = {},
  executeSql: (sql: string) => Promise<QueryResult> = (sql) => {
    executed.push(sql);
    return Promise.resolve(okResult());
  },
) {
  const ctx = {
    agentId: "northwind",
    messageChannel: "slack",
    requesterSenderId: "U123",
    sessionKey: "s1",
    deliveryContext: { to: "channel:C0NWIND" },
    ...ctxOverrides,
  } as Parameters<typeof createRunReportTool>[0];

  return createRunReportTool(ctx, {
    deployment,
    reports,
    tenantMap,
    templates,
    executeSql,
    escalator,
    audit,
    now: () => NOW,
  });
}

beforeEach(() => {
  audit = new RecordingAuditLogger();
  escalator = new RecordingEscalator();
  executed = [];
});

describe("run_report", () => {
  it("returns rows and totals for an entitled report", async () => {
    const tool = build();
    const result = await tool.execute("call-1", {
      report: "totals_by_entity",
      dateRange: "today",
    });

    expect("refused" in result.details).toBe(false);
    expect(result.content[0]?.text).toContain("Northwind Traders");
    expect(result.content[0]?.text).toContain('"amount":1200');
    expect(audit.records[0]?.outcome).toBe("success");
    expect(escalator.sent).toHaveLength(0);
  });

  // The rows have to be in `content`. `details` is host metadata the model
  // never sees, and a model told only the totals will either say the rows are
  // missing or invent them.
  it("puts the rows where the model can read them", async () => {
    const tool = build();
    const result = await tool.execute("call-1", {
      report: "totals_by_entity",
      dateRange: "today",
    });
    expect(result.content[0]?.text).toMatch(/rows \(one JSON object per line\)/);
  });

  it("scopes the SQL to the resolved tenant, not a parameter", async () => {
    const tool = build();
    await tool.execute("call-1", { report: "totals_by_entity", dateRange: "today" });
    expect(executed[0]).toContain(`f.TENANT_ID = '${NORTHWIND}'`);
  });

  describe("refusals", () => {
    async function expectRefusal(
      params: unknown,
      errorClass: string,
      ctxOverrides: Record<string, unknown> = {},
    ) {
      const tool = build(ctxOverrides);
      const result = await tool.execute("call-1", params);

      expect(result.details).toMatchObject({ refused: true, reason: errorClass });
      // Nothing about the failure reaches the customer.
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain(errorClass);
      expect(text).not.toContain(NORTHWIND);
      expect(text).not.toContain("SELECT");
      // Every refusal is both recorded and escalated.
      expect(audit.records).toHaveLength(1);
      expect(escalator.sent).toHaveLength(1);
      expect(audit.records[0]?.errorClass).toBe(errorClass);
      return result;
    }

    it("refuses a malformed call", async () => {
      await expectRefusal({ dateRange: "today" }, "malformed_params");
    });

    it("refuses when the agent id is missing", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "today" },
        "no_agent_id",
        { agentId: undefined },
      );
    });

    it("refuses an unknown agent", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "today" },
        "unknown_agent",
        { agentId: "ghost" },
      );
    });

    it("refuses a turn from another tenant's channel", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "today" },
        "channel_mismatch",
        { deliveryContext: { to: "channel:C0CONTOSO" } },
      );
    });

    // The report exists and is real; this tenant simply may not ask for it.
    it("refuses a report this tenant is not entitled to", async () => {
      await expectRefusal(
        { report: "records_by_entity", dateRange: "today" },
        "not_entitled",
      );
    });

    it("refuses a window the report does not support", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "qtd" },
        "unsupported_date_range",
      );
    });

    it("refuses last_n_days without a day count", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "last_n_days" },
        "bad_days",
      );
    });

    it("refuses last_n_days beyond the report's maxDays", async () => {
      await expectRefusal(
        { report: "totals_by_entity", dateRange: "last_n_days", days: 900 },
        "bad_days",
      );
    });

    it("refuses a drill-down with no entity named", async () => {
      const tool = build({ agentId: "contoso", deliveryContext: { to: "channel:C0CONTOSO" } });
      const result = await tool.execute("call-1", {
        report: "records_by_entity",
        dateRange: "today",
      });
      expect(result.details).toMatchObject({ reason: "entity_required" });
    });

    it("surfaces a warehouse failure as a calm sentence, never a number", async () => {
      const tool = build({}, () => Promise.reject(new Error("connection reset")));
      const result = await tool.execute("call-1", {
        report: "totals_by_entity",
        dateRange: "today",
      });
      expect(result.details).toMatchObject({ refused: true });
      expect(result.content[0]?.text).not.toContain("connection reset");
      expect(audit.records[0]?.outcome).toBe("error");
    });
  });

  describe("the audit record", () => {
    it("records what was asked and what happened", async () => {
      const tool = build();
      await tool.execute("call-1", { report: "totals_by_entity", dateRange: "today" });
      const record = audit.records[0];
      expect(record).toMatchObject({
        event: "run_report",
        outcome: "success",
        agentId: "northwind",
        tenant: NORTHWIND,
        channel: "channel:C0NWIND",
        channelProvider: "slack",
        senderId: "U123",
        report: "totals_by_entity",
        dateRange: "today",
        rowCount: 1,
        truncated: false,
      });
    });

    // The log records that a question was put and what happened, never the
    // answer.
    it("records no row contents and no SQL", async () => {
      const tool = build();
      await tool.execute("call-1", { report: "totals_by_entity", dateRange: "today" });
      const serialised = JSON.stringify(audit.records[0]);
      expect(serialised).not.toContain("Northwind Traders");
      expect(serialised).not.toContain("SELECT");
    });
  });
});
