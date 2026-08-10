---
name: almanac-add-tenant
description: Onboard a tenant to Almanac. Interviews for the tenant name, resolves its warehouse tenant id, searches Slack for its channel id via infra/slack-lookup.sh offering every match for selection, then offers the report catalog and a schedule — writes the tenants.yaml stanza, regenerates, and opens a PR. Use when adding a tenant or customer, onboarding a partner, or giving someone their own channel.
---

# Adding a tenant

One agent, bound to one Slack channel, scoped to one tenant id.

The change itself is small — a stanza in `tenants.yaml` — because everything
else is generated from it. Most of the work is the checking either side of that
stanza, since the moment it deploys, someone outside the organisation can type
at a system that reads production data.

**Ask one question at a time.** Several answers depend on earlier ones.

## Two things this skill must never do quietly

- **Never invent or guess a tenant id.** A wrong id is a cross-tenant data leak
  that every other control will faithfully enforce, because nothing downstream
  can tell the id was wrong — only that it was applied consistently.
- **Never add `allowSharedTenant` to silence a build failure.** If the build
  complains that two agents share a tenant, stop and tell the user. That flag
  exists so a staging agent can deliberately preview a real tenant's channel;
  using it to quiet an error removes the check that catches a real isolation
  bug.

---

## Step 1 — Who

Ask which tenant this is for. Free text — the name they would use in
conversation.

## Step 2 — The tenant id

**Try the warehouse first.** If an MCP or warehouse connection is available in
this session, look it up rather than asking:

```sql
SELECT <tenant_column> AS TENANT_ID,
       COUNT(*)        AS RECORDS_90D
FROM <fact table>
WHERE <date_column> >= DATEADD('day', -90, CURRENT_DATE())
GROUP BY 1
ORDER BY 2 DESC
```

If there is a tenants or accounts dimension table with display names, join it —
an id beside a recognisable name is far easier to confirm than an id alone.

- **One match** → show the id, the name and the 90-day volume, and ask the user
  to confirm. **Do not skip the confirmation just because there was one row.**
- **Several** → present them with `AskUserQuestion`, one option per tenant.
- **None** → say so and offer a broader search. Never fall back to inventing
  one.

**If the warehouse is not reachable**, say so and ask for the id directly.
Validate it against the format `deployment.yaml` declares (`tenancy.idFormat`)
and re-ask if it does not match — the generator enforces the same pattern, so a
malformed id fails the build anyway.

**Then check the volume against the caps**, comparing like with like. Read
`rowCap` and the row grain from each `report.yaml` and count *that grain*:

- An **aggregate** report's rows are entities. Count distinct entities over its
  widest window — a tenant with 1,500 records across 45 entities is nowhere
  near a 500-entity cap, and comparing 1,500 to 500 would raise a false alarm.
- A **detail** report's rows are records, but scoped to one entity. Compare
  against the busiest single entity's record count, not the tenant total.

If a report would genuinely exceed its cap on a window they will plausibly ask
for, mention it: totals stay exact and the model says the breakdown is
incomplete, but the real answer is a purpose-built aggregate report.

## Step 3 — The channel

**Search before you ask.** You have the confirmed name from step 2, and the
channel usually exists already:

```bash
infra/slack-lookup.sh channel "Northwind Traders"
```

It matches with case and separators squashed, so a partner name finds
`#ext-customer-northwind-traders`.

**The bot does not need to be in the channel yet, and should not be.** Inviting
it is a customer-visible act, and a bot that joins before the config entitles
it answers mentions with the fallback agent in front of that customer. The
invite is the last step of go-live. `NOT a member` is the expected state here.

**Branch on the exit code** — do not skim the output for a `C…` and move on:

- **0, one match** → show the name, id and the private / slack-connect /
  membership flags, and ask the user to confirm. Confirm even with one row, for
  the same reason as the tenant id.
- **3, several matched** → offer them with `AskUserQuestion`, one option per
  channel. **Never choose for them, and never offer a channel the script did
  not return.** `#ext-customer-acme` and `#ext-customer-acme-eu` are plausibly
  two different customers.
- **4, nothing matched** → the channel may be private, and Slack does not
  reveal a private channel to a bot that is not in it. Ask them to get the id
  from the Slack UI (channel name → About → bottom of the panel). Note in the
  stanza that it came from the UI and has not been verified against the API,
  and that `infra/slack-lookup.sh verify <id>` should be re-run once the bot is
  invited.
- **1** → Slack could not be reached. Say so; do not guess.

**Then say the thing about membership out loud**, because it is the most
important sentence in this process:

> Channel membership is the perimeter. There is no user list in the config —
> access is granted and revoked by adding to and removing from the channel. On
> a Slack Connect channel **the customer controls who they add**, and anyone
> they add can ask anything the channel is entitled to ask. That is the
> intended design, but it must be a decision someone made knowingly rather than
> discovered later.

## Step 4 — Entitlements

Offer the report catalog — read every `reports/*/report.yaml` and present them
by title and description, multi-select.

Recommend the aggregate report as a floor. A tenant entitled only to a
drill-down cannot answer "how much in total?", which is the first thing anyone
asks.

Watch for two versions of the same report in the selection. The build will
reject it, but explaining it here is better than a failed build: their prompt
would offer both under the same title and the model would pick arbitrarily.

## Step 5 — Schedule, or deliberately not

Ask whether they want an unprompted digest — and present **no schedule as a
real option, not a fallback.**

A stanza with entitlements and no schedule is a complete deployment: the
channel answers whenever anyone asks, across every entitled report and every
window it supports, and posts nothing on its own. For a lot of tenants that is
the right shape, and it is much easier to add a schedule later than to withdraw
one. An unprompted daily post is a commitment — people notice when it stops,
and removing it reads as a feature being taken away.

If they do want one:

- Only reports with a `digest.md` can be scheduled.
- The window must be one the report supports, and cannot be `all_time` or
  `last_n_days` — those are interactive only, because a scheduled wide window
  truncates every morning with nobody present to narrow it.
- Two schedules for one tenant must be at least 30 minutes apart. The build
  checks real fire times, not cron strings, because `0 9 1 * *` and
  `0 9 * * 1-5` collide only on some dates.
- Ask about their timezone, and be clear it controls **when the digest fires**,
  never **which date it reports**.

## Step 6 — Write, generate, PR

Write the stanza. Comment it with anything a future reader would need: why a
shared tenant is deliberate, where a channel id came from if not the API.

```bash
npm run generate && npm run check
```

Show the generated diff — particularly the new agent, its binding, and its
tenant map entry. Those three plus the channel allowlist must all agree, and
the build enforces it.

Open the PR.

## Where this stops

**At the pull request.** Merging deploys, so the review is the gate.

Tell them plainly what is left:

1. Merge, and wait for the deploy
2. `/almanac-go-live` — the isolation check, in the staging channels
3. Test in the channel with the bot invited but the customer not yet watching
4. Invite the customer

Step 2 is not optional for the first tenant on a deployment, and it is not
optional for any tenant if the tenant predicate has changed since the last one.
