---
name: almanac-init
description: Bootstrap an Almanac deployment by interview. Asks about the tenancy model, the tenant predicate, the warehouse, Slack, GCP and the domain vocabulary, then writes deployment.yaml, picks a warehouse adapter, generates the Slack app manifest, and drafts a first report against the user's own schema. Use when setting up Almanac for the first time, initialising a new deployment, or when someone has just cloned the repo.
---

# Bootstrapping a deployment

You are turning an empty checkout into a working `deployment.yaml`, and then
into a report that returns the user's own numbers. Getting to real rows in one
session is the goal — a config that validates but has never touched their
warehouse has not proved anything.

**Ask one question at a time and wait for the answer.** Later questions depend
on earlier ones, and a wall of questions is how people skip the one that
matters. Use `AskUserQuestion` where the options are known; plain prose where
they are not.

Read `docs/why.md` before you start. When this skill and that document
disagree, that document is right and this skill needs fixing.

## Three things this skill must never do

- **Never write a customer-facing deployment in `single` tenancy mode.** Single
  mode removes the tenant predicate, which is the only thing separating one
  customer's data from another's. If they say the bot is customer-facing and
  then choose single, stop and explain the consequence. If they are certain
  after that, they can edit the file by hand — but you do not write it.
- **Never invent a tenant predicate, a table name or a column.** If you cannot
  look it up, ask. A predicate that names a column that does not exist fails
  loudly; a predicate that names the *wrong* column fails silently, forever.
- **Never put a secret in `deployment.yaml`.** It is committed and reviewable.
  Credentials come from Secret Manager via the environment, and the schema has
  nowhere to put one.

---

## Step 1 — Who is this for?

Ask whether the bot will be used by **customers outside the organisation**, or
**only internally**.

This is first because it changes the schema, not just the values.

- **Customer-facing** → `tenancy.mode: multi`. Every isolation control is live.
- **Internal, one shared dataset** → `tenancy.mode: single` is available, but
  say plainly what it removes: no tenant predicate, so any channel that can ask
  a question can see everything the reports cover. That is correct for a
  company-wide metrics bot and wrong for anything else.
- **Internal, but teams must not see each other's data** → this is `multi`.
  "Internal" is not the same question as "one dataset".

## Step 2 — The warehouse connection

Ask which they have:

- **Direct Snowflake** (the default) — account, role, warehouse, database,
  schema, username.
- **An existing MCP server** exposing read-only SQL — the env var names for its
  URL and API key.

If direct, be explicit about what changes: **the role becomes the containment
boundary.** With no server in front, nothing in Almanac can stop a statement
the role is permitted to run. Tell them to create a role with SELECT on the
analytics schema and nothing else, and that `/almanac-connect` will prove by
execution that it cannot write.

Also tell them key-pair, not password. A password is replayable by anything
that reads it once.

## Step 3 — The fact table and the tenant column

Ask what table the reports will read, and which column identifies the tenant.

**If a warehouse MCP is connected in this session, look it up rather than
asking them to type it.** Run something like:

```sql
SHOW TABLES IN SCHEMA <database>.<schema>
```

then, for the table they pick:

```sql
DESCRIBE TABLE <database>.<schema>.<table>
```

Offer the plausible tenant columns from the real column list with
`AskUserQuestion` — a name they pick from their own schema beats a name they
typed from memory.

Then confirm the id format by looking at actual values:

```sql
SELECT DISTINCT <tenant_column> FROM <table> LIMIT 5
```

- 36-character hyphenated → `uuid`
- all digits → `integer`
- anything else → `slug`

**If no MCP is connected**, say so plainly and ask. Validate what they give
you: a tenant id that does not match the format they chose will fail the build
later, and finding that out now is cheaper.

Compose the predicate as `<alias>.<COLUMN> = {{tenant_id}}` and **show it to
them for confirmation**, explaining that this exact string must appear
character-for-character in every report template, and that the build enforces
it.

## Step 4 — Drill-down

Ask whether customers should be able to name one entity and see its individual
records.

If yes, you need `tenancy.entityPredicate`. Find the name column the same way
you found the tenant column, and compose:

```
UPPER(<alias>.<NAME_COLUMN>) LIKE UPPER({{entity}})
```

Explain why the form is fixed: `{{entity}}` is the only placeholder carrying a
value the model chose, and pinning the spelling is what stops a template
comparing it against some other column.

If no, omit the key entirely. A capability that is absent cannot be misused.

## Step 5 — Vocabulary

Ask what one row is about and what is being counted. Two nouns, singular and
plural each, plus an optional past-tense verb:

- lending → business/businesses, funding/fundings, funded
- logistics → carrier/carriers, shipment/shipments, shipped
- SaaS → account/accounts, signup/signups, signed up

This lands in every generated prompt, so it is the difference between a bot
that sounds like it belongs to their business and one that reads like a
database manual.

## Step 6 — Reporting timezone and floor

- **Timezone**: the zone all dates resolve in. Say clearly that a tenant's own
  timezone controls when a digest *fires*, never which date it *reports*.
- **allTimeFloor**: earlier than their first row. If the MCP is connected, look
  it up rather than guessing:

  ```sql
  SELECT MIN(<date_column>) FROM <table>
  ```

  Then pick a floor comfortably before that.

## Step 7 — Slack

- The **error channel** id — where refusals, drift and failures are posted. Not
  a customer channel, not the ops channel.
- Whether they want an **ops channel** for operator announcements. If yes, tell
  them it must be **private**, because membership is the authorisation, and the
  tool verifies privacy with Slack on every call.

If they have not created the Slack app yet, generate the manifest from
`infra/slack-app-manifest.yaml` with their bot name filled in, and point out
the two load-bearing parts: Socket Mode with no request URL, and no history
scopes.

## Step 8 — GCP

Optional. If they are provisioning elsewhere or by hand, skip the whole block.

If they want the scripts: project, region, zone, the two bucket names. Ask
whether a VPC already exists — if it does, take its name and subnet and tell
them to skip `00-network.sh`; if not, `00-network.sh` creates one.

## Step 9 — Write it

Write `deployment.yaml`. Then:

```bash
npm run generate
```

There are no tenants yet, so expect it to complain that `tenants.yaml` is
missing — that is correct and is the next skill's job. What you are checking
here is that `deployment.yaml` itself validates.

Show them the file and walk the three fields that matter most: the predicate,
the timezone, and the warehouse role.

## Step 10 — Install the CI workflows

Almanac ships GitHub Actions as **templates** rather than live workflows,
because the toolkit repo has no deployment to build. Their repo does, so offer
to install them:

```bash
mkdir -p .github/workflows
cp infra/github/ci.yml      .github/workflows/
cp infra/github/release.yml .github/workflows/
```

Nothing needs editing — every deployment-specific value is read from
`deployment.yaml` at run time. `release.yml` also needs two repository
variables, which `infra/07-ci-setup.sh` prints later.

Say the thing that matters while you are here: **merging to `main` deploys, so
PR review is the gate.** Branch protection is not optional — require a review,
require `check`, keep history linear, and no direct pushes. Enabling the deploy
poller without that means any push reaches a host reading production data with
nothing having reviewed it.

## Step 11 — A first report, against their own data

**Do not stop at a valid config.** Offer to draft their first report now.

Copy `reports/_archetypes/aggregate_by_entity/` to a real id, substitute their
table and column names, and — if the MCP is connected — run it:

```sql
-- with a real tenant id and a narrow window
```

Show them the rows. Ask them to tie one number to something they already trust:
a dashboard, a report they run monthly, anything. **A query that looks right is
worth nothing; a query whose total matches a number they already believe is
worth the whole session.**

Then hand off to `/almanac-add-tenant` for their first channel.

## Where this stops

At a validated config and a report that returns real rows. It does not
provision anything, does not create the Slack app, and does not merge. Say
plainly what is left:

1. `/almanac-connect` — prove the role cannot write, and prove isolation
2. `/almanac-add-tenant` — the first channel
3. `/almanac-provision` — the infrastructure
4. `/almanac-go-live` — the checks before a customer sees it
