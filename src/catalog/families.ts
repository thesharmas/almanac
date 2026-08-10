import type { Report } from "./load.js";

/**
 * Report families — the machinery behind versioned report changes.
 *
 * A family is a report and everything that has replaced it, linked by
 * `supersedes`. `daily_totals_v2 supersedes daily_totals` puts both in the
 * family rooted at `daily_totals`.
 *
 * Why this exists: versioning is safe *because* both versions can be deployed
 * at once, so a change can be compared against the thing it replaces on the
 * same tenant. That same property creates exactly one dangerous state — a
 * tenant entitled to two versions simultaneously. Their prompt would list two
 * capabilities with the same title and description, and the model would pick
 * between them arbitrarily. Nothing downstream could detect it: both reports
 * are real, both entitled, both returning correct numbers for whichever
 * question the model decided to answer.
 *
 * So the family is computed here and asserted in the generator's invariants.
 */

export interface FamilyResolution {
  /** Family root id for every report in the catalog. */
  readonly rootOf: ReadonlyMap<string, string>;
  /** Reports naming a `supersedes` target that is not in the catalog. */
  readonly danglingSupersedes: readonly { readonly id: string; readonly target: string }[];
  /** Reports whose `supersedes` chain loops back on itself. */
  readonly cycles: readonly string[];
}

/**
 * Resolve every report to its family root.
 *
 * A report with no `supersedes` is its own root. A dangling or cyclic link is
 * reported rather than thrown, so the caller can present every problem at once
 * — an author fixing a catalog should see the whole list, not one per run.
 * Reports involved in either are treated as their own root so the rest of the
 * analysis still produces useful output.
 */
export function resolveFamilies(reports: ReadonlyMap<string, Report>): FamilyResolution {
  const rootOf = new Map<string, string>();
  const dangling: { id: string; target: string }[] = [];
  const cycles: string[] = [];

  for (const [id, report] of reports) {
    const seen = new Set<string>([id]);
    let current = report;
    let root = id;
    let broken = false;

    while (current.supersedes !== undefined) {
      const target: string = current.supersedes;
      if (!reports.has(target)) {
        dangling.push({ id, target });
        broken = true;
        break;
      }
      if (seen.has(target)) {
        cycles.push(id);
        broken = true;
        break;
      }
      seen.add(target);
      root = target;
      const next = reports.get(target);
      if (next === undefined) break;
      current = next;
    }

    rootOf.set(id, broken ? id : root);
  }

  return { rootOf, danglingSupersedes: dangling, cycles };
}

/** Report ids that something else supersedes — i.e. old versions. */
export function supersededIds(reports: ReadonlyMap<string, Report>): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const report of reports.values()) {
    if (report.supersedes !== undefined) superseded.add(report.supersedes);
  }
  return superseded;
}
