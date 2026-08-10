import type { Report } from "../catalog/load.js";
import type { QueryResult } from "../warehouse/types.js";
import {
  FIRST_DATE_COLUMN,
  REPORTED_DATE_COLUMN,
  TOTAL_ROWS_COLUMN,
  totalColumnFor,
} from "./contract.js";
import { formatLocalTime, type ResolvedRange } from "./date-range.js";

/**
 * Shape a raw warehouse result into the tool payload.
 *
 * The tool returns **raw rows**; the model does the summarising. Pre-rendering
 * here would reduce the agent to a string formatter and kill the ability to
 * ask follow-up questions over what was fetched — which is the reason to run
 * a language model at all. So this layer reshapes and guards; it does not
 * summarise.
 *
 * What it does guarantee:
 *
 *  - `totals` are the SQL's own full-range aggregates, unaffected by the row
 *    cap. The model never needs to sum anything to state a headline.
 *  - Ids are strings. External ids routinely overflow int64 and float64, and a
 *    silently truncated id still looks plausible, so anything typed `id` is
 *    required to arrive as text.
 *  - `reported_date` is checked against the expected local date. A session
 *    timezone is an unpinned default on most shared warehouses, so drift fails
 *    closed here rather than producing a confidently wrong day.
 */

export class ReportedDateMismatchError extends Error {
  readonly code = "reported_date_mismatch";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `the warehouse reported ${JSON.stringify(actual)} but the expected date is ${JSON.stringify(expected)} — the session timezone may have drifted`,
    );
    this.name = "ReportedDateMismatchError";
  }
}

export class MalformedResultError extends Error {
  readonly code = "malformed_result";
  constructor(message: string) {
    super(message);
    this.name = "MalformedResultError";
  }
}

export type CellValue = string | number | boolean | null;

export interface ReportPayload {
  readonly report: string;
  readonly date_range: {
    readonly name: string;
    readonly start: string;
    readonly end: string;
    /** True when the window contains today, so the answer must be stated as-of. */
    readonly in_progress: boolean;
  };
  readonly reported_date: string;
  /** When the query ran, in UTC. For the audit trail, not for display. */
  readonly query_timestamp: string;
  /**
   * The same instant, preformatted in the reporting zone and ready to print —
   * e.g. "5:00 PM PT". The model must never derive this itself.
   */
  readonly as_of_local: string;
  readonly totals: Readonly<Record<string, number>>;
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
  readonly truncated: boolean;
  readonly row_cap: number;
}

export interface ShapeOptions {
  readonly report: Report;
  readonly range: ResolvedRange;
  /** Expected local date, from `expectedReportedDate(now, timezone)`. */
  readonly expectedReportedDate: string;
  readonly now: Date;
  readonly timezone: string;
  /** Short zone label for `as_of_local`, e.g. "PT". */
  readonly timezoneLabel: string;
}

/**
 * Convert a minor-unit (cents) value to major units.
 *
 * Handing the model a raw cents integer makes it the model's job to divide by
 * 100 in a customer-facing financial message — and it does not reliably do so:
 * 36205622 rendered as "$36,205,622" rather than "$362,056.22". A 100x error
 * in a number a customer will read is not a formatting nit.
 *
 * The plugin computes and the model formats. Unit conversion is computation.
 */
function centsToMajor(value: number): number {
  return Math.round(value) / 100;
}

function requireNumber(row: Record<string, unknown>, column: string): number {
  const raw = row[column];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MalformedResultError(
      `expected a numeric ${column}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Coerce a cell for the payload.
 *
 * `id` columns must arrive as text. Coercing a number here would be coercing a
 * value that has already lost precision, which is worse than failing.
 */
function coerce(value: unknown, format: string, column: string): CellValue {
  if (value === null || value === undefined) return null;

  if (format === "id") {
    if (typeof value === "number") {
      throw new MalformedResultError(
        `${column} arrived as a number (${String(value)}); ids must stay text or precision is lost`,
      );
    }
    if (typeof value !== "string") {
      throw new MalformedResultError(
        `${column} was ${typeof value}, expected text — ids must not be coerced`,
      );
    }
    if (value === "") throw new MalformedResultError(`${column} was an empty id`);
    return value;
  }

  if (format === "cents") {
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      throw new MalformedResultError(
        `${column} is declared cents but arrived as ${JSON.stringify(value)}`,
      );
    }
    return centsToMajor(numeric);
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  // Dates and numerics arrive as strings over JSON; anything structured is
  // unexpected, so serialise it rather than stringifying to "[object Object]".
  return JSON.stringify(value);
}

export function shapeResult(result: QueryResult, options: ShapeOptions): ReportPayload {
  const { report, range } = options;
  const asOf = formatLocalTime(options.now, options.timezone, options.timezoneLabel);

  const first = result.rows[0];

  // An empty result is legitimate — a quiet day, or a question asked before
  // the day's first row lands. Totals are zero, not unknown.
  if (first === undefined) {
    return {
      report: report.id,
      date_range: {
        name: range.name,
        start: range.start,
        end: range.end,
        in_progress: range.inProgress,
      },
      reported_date: options.expectedReportedDate,
      query_timestamp: options.now.toISOString(),
      as_of_local: asOf,
      totals: Object.fromEntries((report.totals ?? []).map((t) => [t.as, 0])),
      rows: [],
      truncated: false,
      row_cap: report.rowCap,
    };
  }

  const reportedDate = first[REPORTED_DATE_COLUMN];
  const actual = typeof reportedDate === "string" ? reportedDate : String(reportedDate);
  if (actual !== options.expectedReportedDate) {
    throw new ReportedDateMismatchError(options.expectedReportedDate, actual);
  }

  // `all_time` is queried from a synthetic floor, so reporting it would tell
  // the customer their programme began years before it did. The query returns
  // the real first date over the full range — computed before the LIMIT, so
  // truncation cannot move it — and it stands in as the window start. The
  // contract guarantees the column is present for any report offering
  // `all_time`; this guard is here so a malformed value degrades to the floor
  // rather than printing nonsense.
  const firstDate = first[FIRST_DATE_COLUMN];
  const start =
    range.name === "all_time" &&
    typeof firstDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(firstDate)
      ? firstDate
      : range.start;

  const totalRows = requireNumber(first, TOTAL_ROWS_COLUMN);
  // A total inherits the unit of the column it aggregates, so a sum over a
  // cents column is itself cents and must be converted the same way.
  const columnFormat = new Map(report.columns.map((c) => [c.name, c.format]));
  const totals: Record<string, number> = {};
  for (const total of report.totals ?? []) {
    const raw = requireNumber(first, totalColumnFor(total.as));
    const isCents = total.agg === "sum" && columnFormat.get(total.name) === "cents";
    totals[total.as] = isCents ? centsToMajor(raw) : raw;
  }

  const rows = result.rows.map((row) => {
    const shaped: Record<string, CellValue> = {};
    for (const column of report.columns) {
      shaped[column.name] = coerce(row[column.name], column.format, column.name);
    }
    return shaped;
  });

  // Truncation is a property of the full-range count versus what came back,
  // not of the cap alone: a range of exactly rowCap rows is complete.
  const truncated = totalRows > rows.length;

  return {
    report: report.id,
    date_range: {
      name: range.name,
      start,
      end: range.end,
      in_progress: range.inProgress,
    },
    reported_date: actual,
    query_timestamp: options.now.toISOString(),
    as_of_local: asOf,
    totals,
    rows,
    truncated,
    row_cap: report.rowCap,
  };
}
