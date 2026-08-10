import { IN_PROGRESS_RANGES, type DateRange } from "../catalog/schema.js";
import { MAX_LAST_N_DAYS } from "../config/schema.js";

/**
 * Resolve a `dateRange` enum value to explicit calendar dates in the
 * deployment's reporting timezone.
 *
 * Every tenant's dates are reporting-zone dates, not tenant-local ones. A
 * tenant's `timezone` controls *when the digest fires*, not *which date it
 * reports* — firing at end-of-day in the reporting zone over a reporting-zone
 * date is the coherent pairing.
 *
 * The plugin computes the window and the SQL receives literals, rather than
 * the template doing CURRENT_DATE() arithmetic. Two reasons:
 *
 *  1. The plugin asserts that the warehouse's CURRENT_DATE() equals the
 *     expected reporting-zone date. That guard needs an independently computed
 *     expectation — if the SQL derived the window from CURRENT_DATE() too,
 *     there would be nothing to compare against and session-timezone drift
 *     would be invisible.
 *  2. Calendar arithmetic here is unit-testable with a frozen clock, including
 *     the DST transitions and month/quarter/year boundaries where it is
 *     easiest to be wrong.
 *
 * All arithmetic is on civil dates. Once the local Y-M-D is known, "30 days
 * ago" is calendar subtraction with no timezone involved — which is why DST
 * transitions do not shift these windows.
 */

export { MAX_LAST_N_DAYS };

/** A calendar date with no time and no zone. */
export interface CivilDate {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
}

export interface ResolvedRange {
  readonly name: DateRange;
  /** Inclusive, `YYYY-MM-DD`. */
  readonly start: string;
  /** Inclusive, `YYYY-MM-DD`. */
  readonly end: string;
  /** True when the window contains the current date, so answers must be as-of. */
  readonly inProgress: boolean;
}

/** The slice of `deployment.yaml` this module needs. */
export interface RangeConfig {
  readonly timezone: string;
  /** `YYYY-MM-DD`, earlier than the first row the warehouse holds. */
  readonly allTimeFloor: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached !== undefined) return cached;
  // en-CA gives ISO-ordered parts, which keeps `formatToParts` reading simple.
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatters.set(timezone, created);
  return created;
}

/** The calendar date in `timezone` at a given instant. */
export function localDate(now: Date, timezone: string): CivilDate {
  const parts = formatterFor(timezone).formatToParts(now);
  const get = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`could not read ${type} from date`);
    return Number(value);
  };
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function formatCivil(date: CivilDate): string {
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${String(date.year)}-${mm}-${dd}`;
}

export function parseCivil(iso: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new RangeError(`not a YYYY-MM-DD date: ${iso}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** Civil-date arithmetic via UTC epoch days, so no local timezone is involved. */
function toEpochDay(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

function fromEpochDay(days: number): CivilDate {
  const d = new Date(days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addDays(date: CivilDate, delta: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + delta);
}

function firstOfMonth(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: 1 };
}

function lastOfMonth(date: CivilDate): CivilDate {
  // Day 0 of the next month is the last day of this one.
  const d = new Date(Date.UTC(date.year, date.month, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function firstOfQuarter(date: CivilDate): CivilDate {
  const quarterStartMonth = Math.floor((date.month - 1) / 3) * 3 + 1;
  return { year: date.year, month: quarterStartMonth, day: 1 };
}

function previousMonth(date: CivilDate): CivilDate {
  return date.month === 1
    ? { year: date.year - 1, month: 12, day: 1 }
    : { year: date.year, month: date.month - 1, day: 1 };
}

/**
 * Resolve a window to explicit calendar dates.
 *
 * Trailing windows are inclusive of today: `last_7d` is the seven days ending
 * today, not the seven complete days before it. That matches how the ranges
 * are classified as in-progress — if today were excluded they would be closed
 * windows and would need no as-of qualifier.
 *
 * `days` is required for `last_n_days` and ignored otherwise. It is validated
 * here as well as at the tool boundary: this function is the only thing that
 * turns a request into the two literals the SQL receives, so it is the right
 * place for the last word on what is a legal window.
 */
export function resolveDateRange(
  name: DateRange,
  now: Date,
  config: RangeConfig,
  days?: number,
): ResolvedRange {
  const today = localDate(now, config.timezone);
  const inProgress = IN_PROGRESS_RANGES.includes(name);

  if (name === "last_n_days") {
    if (
      days === undefined ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_LAST_N_DAYS
    ) {
      throw new RangeError(
        `last_n_days needs an integer days between 1 and ${String(MAX_LAST_N_DAYS)}, got ${String(days)}`,
      );
    }
  }

  const window = ((): { start: CivilDate; end: CivilDate } => {
    switch (name) {
      case "today":
        return { start: today, end: today };
      case "last_7d":
        return { start: addDays(today, -6), end: today };
      case "last_30d":
        return { start: addDays(today, -29), end: today };
      case "last_90d":
        return { start: addDays(today, -89), end: today };
      case "mtd":
        return { start: firstOfMonth(today), end: today };
      case "qtd":
        return { start: firstOfQuarter(today), end: today };
      case "ytd":
        return { start: { year: today.year, month: 1, day: 1 }, end: today };
      case "prior_month": {
        const prior = previousMonth(today);
        return { start: prior, end: lastOfMonth(prior) };
      }
      case "last_n_days":
        // `days` is validated above. Inclusive of today, so N days means today
        // plus the N-1 before it — the same convention as last_7d.
        return { start: addDays(today, -((days ?? 1) - 1)), end: today };
      case "all_time":
        return { start: parseCivil(config.allTimeFloor), end: today };
    }
  })();

  return {
    name,
    start: formatCivil(window.start),
    end: formatCivil(window.end),
    inProgress,
  };
}

/** The date the report should report on, for the drift guard. */
export function expectedReportedDate(now: Date, timezone: string): string {
  return formatCivil(localDate(now, timezone));
}

/**
 * Format an instant as a wall-clock time in the reporting zone, e.g.
 * "5:00 PM PT".
 *
 * The model must never convert a timezone itself. Handed only a UTC timestamp
 * and asked to render it locally, it reads the clock face and appends the
 * label — which for a 17:00 Pacific digest (00:00 UTC the next day) produces
 * "12:00 AM PT": both wrong and entirely plausible. Same principle as cents
 * and as the date ranges — anything requiring arithmetic is computed here, and
 * the model only ever copies it.
 */
export function formatLocalTime(now: Date, timezone: string, label: string): string {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return `${time} ${label}`;
}

/**
 * A short label for a timezone, e.g. "PT" for America/Los_Angeles.
 *
 * Derived from the zone rather than configured separately, so it cannot drift
 * from the zone it labels. Falls back to the short offset ("GMT+5:30") where
 * the platform has no abbreviation, which is still unambiguous.
 */
export function timezoneLabel(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortGeneric",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value;
  return name ?? timezone;
}
