---
name: almanac-add-report
description: Add a new report to Almanac, or change an existing one. Asks which first, then either drafts SQL against the real warehouse and iterates on actual rows, or walks the versioned-change path with a live v1-vs-v2 diff. Checks the contract, writes report.yaml and the digest prompt, entitles staging, and opens a PR. Use when adding a report or metric, changing what a report returns, or adding a column to one.
---

# Adding or changing a report

Ask which first — the two paths differ completely:

- **A new capability** → the drafting path below.
- **Changing what an existing report returns** → the versioned path. Editing a
  report in place changes what every entitled tenant sees on the next deploy,
  with no way to compare old against new.

Read `reports/_archetypes/README.md` for the two shapes and the contract.

**Verify, do not narrate.** A drafted query that looks right is worth nothing.
Run it, show the rows, re-run after every edit, and ask the user to tie one
number to something they already trust. If the warehouse cannot be reached from
this session, say plainly which checks you could not run and hand them over.

---

# Path A — a new report

## Step 1 — The overlap check

**Before writing any SQL**, read every existing `reports/*/report.yaml` and
compare the request against them: source table, date basis, columns, and the
customer-facing description.

If an existing report nearly answers this question, **recommend extending it
instead**. Say why: every entitled report appears in the capability list, and
the model chooses between them on title and description alone. Two reports that
nearly answer the same question is how a customer gets two different numbers
for it — and neither is wrong, which is what makes it hard to notice.

Only proceed once the user has heard that and still wants a new report.

## Step 2 — Which shape

Decide from the shape of the answer, not the wording of the request:

- **"How much, in total?" or "which of ours was biggest?"** → the aggregate
  archetype. One row per entity, `GROUP BY` in SQL, safe at any window
  including `all_time`.
- **"What made up X's number?"** → the detail archetype. One row per record,
  scoped to one entity the customer names, and no `all_time`.

If they want both, that is two reports, and it is the normal answer.

## Step 3 — Draft, run, show

Copy the archetype into `reports/<id>/`. Fill in their tables and columns.

**Then run it** against a real tenant and a narrow window, and show the rows
next to the SQL. Iterate with them. Re-run after every edit — a query you
changed and did not re-run is a query you have not seen.

Ask them to tie one figure to something they already trust. This is the step
that catches a wrong join, and nothing else does.

## Step 4 — Prove the two properties that matter

Both by execution, not by reading:

**Totals stay exact when rows are capped.** Run the query with its real
`LIMIT`, then run the totals CTE alone with no limit. The `TOTAL_*` values must
be identical. If they are not, the totals are computed after the limit and
every truncated answer will understate.

**Real volume fits under `rowCap`.** Measure the actual row count at the
report's own grain, over the widest window it offers, for the busiest tenant:

```sql
SELECT COUNT(*) FROM ( <the query without its LIMIT> )
```

Compare like with like — an aggregate report's rows are *entities*, not
records, so comparing a record count to its cap raises a false alarm. If real
volume exceeds the cap on a window customers will plausibly ask for, say so:
totals stay exact and the model is told to say the breakdown is incomplete, but
the honest fix is an aggregate-shaped report, not a bigger cap.

## Step 5 — Wire it up

- `report.yaml`: id matching the directory, customer-facing title and
  description, `dateRanges`, `rowCap` equal to the SQL's `LIMIT`, columns with
  the right formats (`cents` for minor units, `id` for anything that must not
  become a number), and `totals`.
- `digest.md`, if it will be scheduled. Every number copied, never derived; and
  say what to do when there is nothing to report, because silence is
  indistinguishable from an outage.
- Entitle **staging only** in `tenants.yaml`. A new report goes to a real
  tenant in a later, separate PR, after it has been watched.

Then:

```bash
npm run check
```

The contract runs as part of this. If it fails, read the message — each rule
exists for a reason in `reports/_archetypes/README.md`, and the fix is
essentially never to relax the rule.

## Step 6 — PR

Open it. The body should carry: what the report answers, the shape and why,
the measured row count against the cap, and the number the user tied to
something they trust.

---

# Path B — changing an existing report

## Step 1 — Version it, do not edit it

Copy `reports/<id>/` to `reports/<id>_v2/`, set `id` to the new value and
`supersedes` to the old one.

The link is load-bearing. It is what lets the build detect the one dangerous
state: a tenant entitled to both versions at once. Their prompt would list two
capabilities with identical titles and the model would pick between them
arbitrarily — both real, both entitled, both returning correct numbers for
whichever question it decided to answer.

**Leave `title` and `description` alone** unless the capability genuinely
changed. A more accurate number under the same description is a correction;
churning the description reads to a customer as a new feature.

## Step 2 — Diff the versions on real data

Run **both** versions over the same tenant and the same window, and show the
delta per total.

Then ask the user to account for it. Two answers are both failures:

- **An unexplained difference** is not ready. Something changed that neither of
  you predicted.
- **No difference at all** means either the change did nothing, or the window
  does not exercise it. Find a window that does — or a tenant that does — and
  re-run. Shipping a change you could not observe is shipping a change you
  cannot verify.

Try at least two windows and, if the deployment has more than one tenant, at
least two tenants.

## Step 3 — Move staging first

Entitle `staging` to the new version and **remove the old id from that stanza**
in the same edit. Adding without removing is exactly the failure the family
check exists to catch, and it will fail the build.

Real tenants move later, one reviewed PR at a time, after the new version has
been watched in staging. Both versions run side by side in the meantime — that
is the whole reason for versioning, and the build will remind you on every run
that a migration is in flight.

## Step 4 — Check and PR

```bash
npm run check
```

The PR body carries the measured delta per total, the windows and tenants
tested, and the user's explanation of the difference.

---

## Where this stops

**At the pull request.** It does not merge and does not deploy.

Merging to `main` deploys within about a minute, so the PR review is the only
gate in front of a customer-facing system reading production data. A skill that
merged its own work would remove the one check the whole pipeline is built
around.
