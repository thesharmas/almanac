Post the daily summary for this channel.

<!--
This file is the scheduled digest's prompt. It is read by the model at fire
time, with no human present — so it is written as instructions, not as prose
about instructions.

Two things make a good one:

  1. EVERY NUMBER IS COPIED, NEVER DERIVED. `totals` is computed in SQL over
     the full range precisely so the headline figures never have to be
     calculated by a model at 5 PM with nobody watching.

  2. IT SAYS WHAT TO DO WHEN THERE IS NOTHING. Silence is indistinguishable
     from an outage, so the empty case still posts.

This is also the right home for domain reasoning — a rule that picks between
two words based on the numbers in front of it, for example. Keep it here, next
to the totals it branches on, rather than pushing it up into deployment.yaml:
the vocabulary is shared, but this judgement belongs to this report.
-->

## Fetch

One call: `run_report` with `report: "aggregate_by_entity"` and
`dateRange: "today"`. Nothing else.

## Post

Then call `post_digest` exactly once, with two arguments. It posts `headline`
to the channel and `detail` as a threaded reply beneath it. You cannot choose
the channel — it is fixed to this one.

Do not write the digest as your reply. `post_digest` is what puts it in the
channel; your reply goes nowhere. Call the tool.

Two parts and nothing more. No preamble, no commentary, no averages, no
comparisons to other days, no observations about the day being "still early".

### `headline`

Two lines. First, bold, exactly this shape:

    *Total funded on <Month D, YYYY> — $<amount>*

`<amount>` is `totals.amount`, already in dollars. `<Month D, YYYY>` is
`date_range.start` written out, e.g. "Aug 5, 2026".

Then the count, plain text:

    <N> fundings across <M> businesses · as of <as_of_local>

`N` is `totals.records` and `M` is `totals.entities`. `as_of_local` is already
formatted — "5:00 PM PT" — so copy it exactly. Do **not** build it from
`query_timestamp`: that field is UTC, and reading its clock face and appending
a zone label gives a time that is wrong and looks right.

### `detail`

**`rows` is already one row per business.** Do not group anything and do not
add anything up: each row carries `ENTITY_NAME`, `RECORDS` and `AMOUNT_CENTS`
(already in dollars) for exactly one business. Print them in the order given,
which is largest first.

A Slack code block, so the columns line up in a monospace font — the only
reliable way to align columns in Slack:

    ```
    Business                    Fundings        Amount
    ─────────────────────────────────────────────────────
    Northwind Traders                 11    $17,842.55
    Contoso Ltd                        1   $299,520.00
    ─────────────────────────────────────────────────────
    Total                             12   $317,362.55
    ```

Rules for the table:

- One line per row in `rows`. Every row appears; none is merged or omitted.
- Right-align the numbers; pad so the columns line up. Amounts with thousands
  separators and two decimals.
- Include the total row. It must equal `totals.amount` exactly, and the
  per-business lines must add up to it. If they do not, something was mistyped.
- If a name is longer than ~28 characters, truncate with an ellipsis so the
  table does not wrap. A wrapped table is worse than a shortened name.

## Rules

- **Only numbers from the tool result.** `totals` is exact — prefer it over
  adding up rows. Never carry a number over from a previous day.
- **Amounts are already in dollars.** Never multiply or divide them.
- **One business is still a table.** Do not replace it with a sentence, and do
  not remark on there being only one. The format should be identical every day
  so it is scannable at a glance.
- **Zero businesses**: still call `post_digest`. `headline` is
  `No fundings on <Month D, YYYY>.` and `detail` is a single line saying there
  is nothing to break down. Do not stay silent; silence is indistinguishable
  from an outage.
- **If `run_report` fails**: do not call `post_digest`. Say something went
  wrong and that the team has been notified. Never estimate.
- **If `post_digest` reports a failure**, do not retry it — it has already
  escalated, and a retry risks posting the headline twice.
- No greeting, no sign-off, no offer of further help, no emoji. This is a
  scheduled post, not a conversation opener.
