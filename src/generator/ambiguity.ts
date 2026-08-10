/**
 * Phrases that must trigger a clarifying question before any tool call.
 *
 * Deterministic and enumerated rather than left to model judgment. The failure
 * this prevents is a *confident* mis-map — a correct number answering the
 * wrong question — and a confidently wrong mapping is exactly the case that
 * would never flag itself as uncertain.
 *
 * A mis-map on a phrase not listed here is still silently wrong. Grow this
 * table from real transcripts: every observed mis-map becomes an entry. Watch
 * it in the other direction too — if clarification starts firing on routine
 * phrasing, trim it rather than accept friction on daily use.
 */

export interface AmbiguousPhrase {
  readonly phrase: string;
  readonly between: readonly string[];
}

export const AMBIGUOUS_PHRASES: readonly AmbiguousPhrase[] = [
  { phrase: "this quarter", between: ["quarter-to-date", "the last 90 days"] },
  { phrase: "this year", between: ["year-to-date", "the last 90 days"] },
  { phrase: "this month", between: ["month-to-date", "the last 30 days"] },
  // The most treacherous: early in a month, "last month" and "the last 30
  // days" sound identical in English and differ by about a third of the data.
  { phrase: "last month", between: ["last calendar month", "the last 30 days"] },
  {
    phrase: "recently",
    between: ["the last 7 days", "the last 30 days", "the last 90 days"],
  },
  {
    phrase: "lately",
    between: ["the last 7 days", "the last 30 days", "the last 90 days"],
  },
];
