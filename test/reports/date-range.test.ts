import { describe, expect, it } from "vitest";

import {
  expectedReportedDate,
  formatLocalTime,
  resolveDateRange,
  type RangeConfig,
} from "../../src/reports/date-range.js";

/**
 * Calendar arithmetic, frozen. The DST transitions and the month/quarter/year
 * boundaries are where this is easiest to be wrong, and a window that is one
 * day out produces a real number answering a slightly different question.
 */

const PT: RangeConfig = {
  timezone: "America/Los_Angeles",
  allTimeFloor: "2019-01-01",
};

/** 2026-08-10 10:00 PT (17:00 UTC). */
const AUG_10 = new Date("2026-08-10T17:00:00Z");

describe("date ranges", () => {
  it.each([
    ["today", "2026-08-10", "2026-08-10"],
    // Trailing windows are inclusive of today: 7 days ending today, not the 7
    // complete days before it.
    ["last_7d", "2026-08-04", "2026-08-10"],
    ["last_30d", "2026-07-12", "2026-08-10"],
    ["last_90d", "2026-05-13", "2026-08-10"],
    ["mtd", "2026-08-01", "2026-08-10"],
    ["qtd", "2026-07-01", "2026-08-10"],
    ["ytd", "2026-01-01", "2026-08-10"],
    ["prior_month", "2026-07-01", "2026-07-31"],
    ["all_time", "2019-01-01", "2026-08-10"],
  ] as const)("%s resolves to %s..%s", (name, start, end) => {
    const range = resolveDateRange(name, AUG_10, PT);
    expect(range.start).toBe(start);
    expect(range.end).toBe(end);
  });

  it("marks windows containing today as in progress", () => {
    expect(resolveDateRange("today", AUG_10, PT).inProgress).toBe(true);
    expect(resolveDateRange("all_time", AUG_10, PT).inProgress).toBe(true);
    expect(resolveDateRange("prior_month", AUG_10, PT).inProgress).toBe(false);
  });

  describe("boundaries", () => {
    it("handles prior_month across a year boundary", () => {
      const jan = new Date("2026-01-05T18:00:00Z");
      const range = resolveDateRange("prior_month", jan, PT);
      expect(range.start).toBe("2025-12-01");
      expect(range.end).toBe("2025-12-31");
    });

    it("handles prior_month landing on February in a leap year", () => {
      const mar = new Date("2028-03-10T18:00:00Z");
      const range = resolveDateRange("prior_month", mar, PT);
      expect(range.start).toBe("2028-02-01");
      expect(range.end).toBe("2028-02-29");
    });

    it.each([
      ["2026-01-15", "2026-01-01"],
      ["2026-04-15", "2026-04-01"],
      ["2026-07-15", "2026-07-01"],
      ["2026-10-15", "2026-10-01"],
    ])("qtd on %s starts at %s", (day, expected) => {
      const now = new Date(`${day}T18:00:00Z`);
      expect(resolveDateRange("qtd", now, PT).start).toBe(expected);
    });
  });

  // The arithmetic is on civil dates, so once the local Y-M-D is known "30
  // days ago" involves no timezone at all. These pin that.
  describe("DST", () => {
    it("does not shift last_7d across the spring transition", () => {
      // 2026-03-08 is the US spring-forward date.
      const now = new Date("2026-03-10T19:00:00Z");
      const range = resolveDateRange("last_7d", now, PT);
      expect(range.start).toBe("2026-03-04");
      expect(range.end).toBe("2026-03-10");
    });

    it("does not shift last_7d across the autumn transition", () => {
      const now = new Date("2026-11-03T19:00:00Z");
      const range = resolveDateRange("last_7d", now, PT);
      expect(range.start).toBe("2026-10-28");
      expect(range.end).toBe("2026-11-03");
    });
  });

  describe("timezone sensitivity", () => {
    // 2026-08-11 00:30 UTC is still 2026-08-10 in Pacific. Reading the UTC
    // clock face would report the wrong day.
    it("uses the reporting zone's date, not UTC's", () => {
      const justAfterUtcMidnight = new Date("2026-08-11T00:30:00Z");
      expect(resolveDateRange("today", justAfterUtcMidnight, PT).start).toBe("2026-08-10");
      expect(
        resolveDateRange("today", justAfterUtcMidnight, {
          timezone: "UTC",
          allTimeFloor: "2019-01-01",
        }).start,
      ).toBe("2026-08-11");
    });

    it("expectedReportedDate agrees with the window", () => {
      expect(expectedReportedDate(AUG_10, PT.timezone)).toBe("2026-08-10");
    });
  });

  describe("last_n_days", () => {
    it("is inclusive of today", () => {
      const range = resolveDateRange("last_n_days", AUG_10, PT, 3);
      expect(range.start).toBe("2026-08-08");
      expect(range.end).toBe("2026-08-10");
    });

    it("of 1 day is today", () => {
      expect(resolveDateRange("last_n_days", AUG_10, PT, 1).start).toBe("2026-08-10");
    });

    it.each([undefined, 0, -1, 1.5, 5000])("refuses days=%s", (days) => {
      expect(() => resolveDateRange("last_n_days", AUG_10, PT, days)).toThrow(RangeError);
    });
  });

  describe("formatLocalTime", () => {
    // The failure this prevents: 17:00 Pacific is 00:00 UTC the next day, so
    // reading the UTC clock face and appending "PT" gives "12:00 AM PT" —
    // wrong, and entirely plausible.
    it("renders the wall clock in the reporting zone", () => {
      const fivePm = new Date("2026-08-11T00:00:00Z");
      expect(formatLocalTime(fivePm, "America/Los_Angeles", "PT")).toBe("5:00 PM PT");
    });
  });
});
