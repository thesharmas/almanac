import { describe, expect, it } from "vitest";

import { loadReports, type Report } from "../../src/catalog/load.js";
import type { ResolvedRange } from "../../src/reports/date-range.js";
import {
  MalformedResultError,
  ReportedDateMismatchError,
  shapeResult,
} from "../../src/reports/shape.js";
import type { QueryResult } from "../../src/warehouse/types.js";
import { REPORTS_DIR } from "../helpers.js";

const reports = loadReports(REPORTS_DIR);

function report(id: string): Report {
  const found = reports.get(id);
  if (found === undefined) throw new Error(`fixture report ${id} missing`);
  return found;
}

const NOW = new Date("2026-08-10T17:00:00Z");

const range: ResolvedRange = {
  name: "today",
  start: "2026-08-10",
  end: "2026-08-10",
  inProgress: true,
};

function options(overrides: Partial<Parameters<typeof shapeResult>[1]> = {}) {
  return {
    report: report("totals_by_entity"),
    range,
    expectedReportedDate: "2026-08-10",
    now: NOW,
    timezone: "America/Los_Angeles",
    timezoneLabel: "PT",
    ...overrides,
  };
}

function result(rows: Record<string, unknown>[]): QueryResult {
  return { rows, rowCount: rows.length, columns: Object.keys(rows[0] ?? {}) };
}

const ROW = {
  REPORTED_DATE: "2026-08-10",
  ENTITY_NAME: "Northwind Traders",
  ENTITY_ID: "900000000000000000000000000000000001",
  RECORDS: 10,
  AMOUNT_CENTS: 4018555,
  TOTAL_ROWS: 1,
  TOTAL_AMOUNT: 4018555,
  TOTAL_RECORDS: 10,
  TOTAL_ENTITIES: 1,
  FIRST_DATE: "2023-12-11",
};

describe("shaping a result", () => {
  it("converts cents to major units", () => {
    const payload = shapeResult(result([ROW]), options());
    expect(payload.rows[0]?.["AMOUNT_CENTS"]).toBe(40185.55);
    expect(payload.totals["amount"]).toBe(40185.55);
  });

  it("does not convert a count that happens to be a sum", () => {
    const payload = shapeResult(result([ROW]), options());
    expect(payload.totals["records"]).toBe(10);
    expect(payload.totals["entities"]).toBe(1);
  });

  // A 36-digit id overflows both int64 and float64, and a silently truncated
  // id still looks plausible to whoever reads it.
  it("keeps wide ids as strings", () => {
    const payload = shapeResult(result([ROW]), options());
    expect(payload.rows[0]?.["ENTITY_ID"]).toBe(
      "900000000000000000000000000000000001",
    );
  });

  it("refuses an id that arrived as a number", () => {
    const bad = { ...ROW, ENTITY_ID: 9000000000000000000000 };
    expect(() => shapeResult(result([bad]), options())).toThrow(MalformedResultError);
  });

  it("refuses an empty id", () => {
    expect(() => shapeResult(result([{ ...ROW, ENTITY_ID: "" }]), options())).toThrow(
      MalformedResultError,
    );
  });

  // The session timezone is an unpinned default on most shared warehouses, so
  // drift has to fail closed rather than produce a confidently wrong day.
  it("refuses when the warehouse reports a different date", () => {
    const drifted = { ...ROW, REPORTED_DATE: "2026-08-11" };
    expect(() => shapeResult(result([drifted]), options())).toThrow(
      ReportedDateMismatchError,
    );
  });

  describe("truncation", () => {
    it("is false when every row came back", () => {
      const payload = shapeResult(result([ROW]), options());
      expect(payload.truncated).toBe(false);
    });

    // Truncation is a property of the full-range count versus what came back,
    // not of the cap alone: exactly rowCap rows is complete.
    it("is true when the full-range count exceeds the rows returned", () => {
      const payload = shapeResult(result([{ ...ROW, TOTAL_ROWS: 900 }]), options());
      expect(payload.truncated).toBe(true);
    });

    it("keeps totals exact when rows are truncated", () => {
      const payload = shapeResult(
        result([{ ...ROW, TOTAL_ROWS: 900, TOTAL_AMOUNT: 99999999 }]),
        options(),
      );
      expect(payload.totals["amount"]).toBe(999999.99);
      expect(payload.rows).toHaveLength(1);
    });
  });

  describe("empty results", () => {
    it("returns zero totals rather than unknown ones", () => {
      const payload = shapeResult(result([]), options());
      expect(payload.totals).toEqual({ amount: 0, records: 0, entities: 0 });
      expect(payload.rows).toEqual([]);
      expect(payload.truncated).toBe(false);
    });

    it("still reports the expected date", () => {
      expect(shapeResult(result([]), options()).reported_date).toBe("2026-08-10");
    });
  });

  describe("all_time", () => {
    const allTime: ResolvedRange = {
      name: "all_time",
      start: "2019-01-01",
      end: "2026-08-10",
      inProgress: true,
    };

    // Showing the synthetic floor would tell a customer their programme began
    // years before it did.
    it("reports the real first date, not the synthetic floor", () => {
      const payload = shapeResult(result([ROW]), options({ range: allTime }));
      expect(payload.date_range.start).toBe("2023-12-11");
    });

    it("falls back to the floor when FIRST_DATE is malformed", () => {
      const payload = shapeResult(
        result([{ ...ROW, FIRST_DATE: "not a date" }]),
        options({ range: allTime }),
      );
      expect(payload.date_range.start).toBe("2019-01-01");
    });
  });

  it("preformats the as-of time so the model never converts a zone", () => {
    const fivePm = new Date("2026-08-11T00:00:00Z");
    const payload = shapeResult(
      result([{ ...ROW, REPORTED_DATE: "2026-08-10" }]),
      options({ now: fivePm }),
    );
    expect(payload.as_of_local).toBe("5:00 PM PT");
    // The raw UTC stamp is still there for the audit trail, and its clock face
    // reads midnight — which is exactly why the model must use as_of_local.
    expect(payload.query_timestamp).toBe("2026-08-11T00:00:00.000Z");
  });

  it("only projects columns the report declares", () => {
    const withExtra = { ...ROW, SECRET_INTERNAL_FLAG: "do-not-leak" };
    const payload = shapeResult(result([withExtra]), options());
    expect(Object.keys(payload.rows[0] ?? {})).toEqual([
      "ENTITY_NAME",
      "ENTITY_ID",
      "RECORDS",
      "AMOUNT_CENTS",
    ]);
  });
});
