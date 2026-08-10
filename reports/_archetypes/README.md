# Report archetypes

Two shapes. Copy one into `reports/<your_id>/`, rename it, and fill in the SQL
— `/almanac-add-report` does this as an interview and, more usefully, runs the
result against your warehouse and shows you the rows.

`_archetypes/` is skipped by the loader (any directory starting with `_` is),
so these templates never have to satisfy the contract checker. They are not
reports.

## Why there are exactly two

This split is the one piece of design here worth stealing wholesale. It is
what makes wide windows answerable at all.

**`aggregate_by_entity`** returns one row per entity, whatever the window. The
`GROUP BY` happens in SQL, so a full year is a few hundred rows and nothing
truncates. This is the report that answers "how much, in total?" and "which of
ours was biggest?" — at any window from a single day to all time.

**`detail_by_entity`** returns one row per record, for a single entity the
customer names. This is the drill-down: "what made up Northwind's number?"

The temptation is to ship only the detail report and let the model aggregate.
Do not. At row grain a 90-day window on a busy tenant is thousands of rows
against a cap in the hundreds, so the breakdown truncates *exactly* when
someone asks a broad question — and truncation is invisible in a well-formatted
answer. The aggregate is not an optimisation; it is what makes the broad
question answerable at all.

The reverse also holds: an aggregate alone cannot answer "which records?", and
a model asked to guess will happily produce plausible ones.

## What every template must satisfy

The contract checker enforces all of this at build time, and again at render
time. See `src/reports/contract.ts` and `docs/why.md`.

| Requirement | Why |
|---|---|
| Only `{{tenant_id}}`, `{{start_date}}`, `{{end_date}}`, `{{entity}}` | There is nowhere to put an injection |
| The tenant predicate, **verbatim** | One reviewed spelling; a reviewer knows what to look for |
| One statement, `SELECT`/`WITH` only | A report may never mutate |
| `CURRENT_DATE() AS REPORTED_DATE` | The session-timezone drift guard needs something to assert |
| Deterministic `ORDER BY` | With a LIMIT, ordering decides which rows survive truncation |
| `AS TOTAL_ROWS` | Truncation is computed from the full-range count, not the cap |
| `AS TOTAL_<NAME>` per declared total | Totals stay exact when rows are capped |
| `AS FIRST_DATE`, if the report offers `all_time` | Otherwise the window start shows the synthetic floor |
| `LIMIT` equal to `rowCap` | The cap in the YAML and the cap in the SQL cannot disagree |
