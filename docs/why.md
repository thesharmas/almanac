# Why it is built this way

Almanac is a small system with an unusual number of constraints in it. Most of
them look removable. This document is why they are not.

Read it before deleting something. Each section below is a control that has
either caught a real failure or exists because the failure it prevents is
invisible in the output — and invisible failures are the ones worth spending
complexity on.

The whole design follows from three facts:

1. **It is customer-facing.** Someone outside your organisation is in the
   channel and can type anything they like at it.
2. **The data it can reach is multi-tenant.** One wrong identifier is a leak.
3. **The config changes every week.** Onboarding, entitlements, schedules. Most
   controls have to survive ordinary drift, not just attack.

---

## The threat is not who you think

It is not an attacker on the network. The VM has no external IP and no inbound
path, so that category is mostly absent rather than defended.

It is a **customer in their own channel** — possibly curious, possibly hostile,
usually neither — plus the ordinary drift of a config that ships weekly. The
controls below are ordered by how much they actually carry.

---

## 1. One agent, one channel, one tenant

Each tenant gets its own agent, bound 1:1 to one Slack channel. The binding is
generated from one stanza, never hand-written. An agent has no way to speak in
a channel other than its own.

Tenant resolution happens **at the tool boundary, on every single invocation**,
from `ctx.agentId` — a value the Gateway sets on the trusted plugin tool
context. It is never a tool parameter, never inferred from the message, and
never captured when the tool factory ran.

Two independent checks, both fail-closed:

1. `agentId` must be present *and* present in the generated tenant map. **There
   is no default tenant and no "if there is only one, use it."** Those two
   shortcuts are how a config mistake becomes a cross-tenant read.
2. The conversation the turn arrived from must match the tenant's configured
   channel. Config or routing drift that bound a channel to the wrong agent
   becomes a loud refusal plus an escalation, rather than a quiet wrong answer.

Anything failing either check gets a generic refusal, an audit record with a
machine-readable `errorClass`, and a post to the error channel.

### The residual assumption

All of this rests on the Gateway invoking the plugin's tool factory **per
agent**. If it invoked once and shared the tool, `ctx.agentId` would be either
absent — caught by the fail-closed check — or *pinned to one agent*, which is
the dangerous case: every channel would return one tenant's numbers, correctly
formatted, from a working query.

Nothing in the code can detect that. It is why `tenants.yaml.example` ships two
staging channels bound to **different** tenants, and why `/almanac-go-live`
asks both the same question and requires different answers. That check is not
ceremony; it is the only instrument that sees this failure.

### Fail closed, in the type system

`tsconfig` sets `noUncheckedIndexedAccess`, so every map lookup is typed
`T | undefined`. That is deliberate: the refusal path should be impossible to
forget rather than merely conventional. `src/shared/fail-closed.ts` exists so
"I could not resolve this" is always an explicit, typed outcome instead of
`undefined` leaking onward as a usable value.

---

## 2. The model never writes SQL

The model picks a **report id** and a **date range** from closed enums. The
plugin owns the query template, substitutes encoded literals, and sends the
statement. That is the entire data path.

`src/reports/contract.ts` enforces, at build time *and* again at render time,
that every template:

- has **only known placeholders** — `{{tenant_id}}`, `{{start_date}}`,
  `{{end_date}}`, and optionally `{{entity}}`. An unknown one fails the build.
- contains the **tenant predicate verbatim**, in the one form
  `deployment.yaml` declares
- is a single statement starting with `SELECT` or `WITH`, with no `INSERT`,
  `UPDATE`, `DELETE`, `MERGE`, `CALL`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE`,
  `GRANT` or `REVOKE` anywhere in it
- selects `CURRENT_DATE() AS REPORTED_DATE` for the timezone drift guard
- has a deterministic `ORDER BY` — with a `LIMIT`, ordering decides which rows
  survive truncation
- has a `LIMIT` equal to `report.yaml`'s `rowCap`

**A new report cannot introduce a new injection surface, because the contract
gives it nowhere to introduce one.** That is the property worth protecting, and
it is why the checks are textual rather than a SQL parse: a parser would accept
many spellings of the tenant filter, and the point is that every report filters
the tenant in *one reviewed form* a human can diff.

### Why the tenant predicate must not become a regex

The single most tempting change in this repo is to let `tenancy.predicate`
accept several forms — a pattern, a list, a normaliser that ignores whitespace.

Don't. The moment several spellings are legal, "every report is scoped the same
way" stops being a fact the build can check and becomes a habit reviewers are
asked to keep. A verbatim string is a weak-looking check that is actually
total.

### The one model-chosen value

`{{entity}}` carries a name the customer typed and the model passed along. It
is safe for two reasons, both checked rather than trusted:

1. The tenant predicate is still **mandatory and ANDed**, so an entity filter
   can only narrow a result that is already scoped to one tenant. A hostile or
   hallucinated name returns zero rows — never another tenant's.
2. The filter must appear in exactly the declared form, so a template cannot
   compare the model's value against some other column.

The encoder permit-lists characters and doubles apostrophes. Apostrophes are
permitted deliberately: excluding them would refuse real trading names, and
refusing a customer's largest account is not a security posture, it is a bug.

### Keep the warehouse seam narrow

`WarehouseAdapter` is one method: a finished SQL string in, rows out. Once two
adapters exist there is a pull toward growing it into a query builder so
reports can be dialected per warehouse.

Resist it. Every guarantee above is a property of *a literal template on disk
that a human reviewed*. A builder that assembles SQL at runtime has none of
them, and no amount of care inside the builder gets them back.

---

## 3. The role is the containment boundary

For a deployment connecting directly to the warehouse — no MCP server in front
— the database role is the last line, and it is the only one that holds if
something in this code is wrong.

Grant SELECT on the analytics schema and nothing else. `/almanac-connect`
proves it by attempting a write and requiring failure, because **a role that
was meant to be read-only and a role that is read-only are different claims**.

Use key-pair authentication, not a password: a password is replayable by
anything that reads it once.

Going direct is *more* to get right than going through an MCP, not less. The
MCP adapter exists because an org that already runs one has already solved this
— the server holds the credentials and scopes the role, and Almanac needs no
warehouse secret of its own.

Whichever adapter is used, the warehouse must **never** be registered under the
Gateway's `mcp.servers`. If the model could reach it directly, every closed
enum in this repo would be decoration.

---

## 4. Drift fails the build, not the customer

`src/generator/invariants.ts` refuses to emit artifacts unless:

- every allowlisted channel has **exactly one** binding
- every binding has a tenant map entry
- every tenant map entry has an agent entry
- every schedule names a report its tenant is entitled to

All four must agree. **An allowlisted channel with no binding falls through to
the default agent silently** — which is the single most likely way a message
reaches something that was not meant to answer it.

The reconciler (`infra/reconcile-automations.sh`) converges the Gateway's cron
jobs onto the generated desired state and **fails the deploy on any job it did
not create**. A hand-made job is drift by definition: nothing reviewed it and
nothing will ever remove it.

Every catalog schema is `additionalProperties: false`. That is load-bearing
rather than tidy: it makes a *removed* control a build failure rather than a
silent no-op. A config still carrying a key that was deliberately deleted must
fail loudly rather than look like it is being honoured.

### Versioned reports

Editing a report in place changes what every entitled tenant sees on the next
deploy, with no way to compare old against new. So a change is a new report
naming its predecessor in `supersedes`, and both run side by side while tenants
move over one reviewed PR at a time.

That same property creates exactly one dangerous state: **a tenant entitled to
two versions at once.** Their prompt would list two capabilities with identical
titles and descriptions, and the model would pick between them arbitrarily —
both real, both entitled, both returning correct numbers for whichever question
it decided to answer. Nothing downstream can see it. That is why the family
check fails the build.

---

## 5. Channel membership is the perimeter

There is deliberately no `users` key anywhere in the config.

Access is granted and revoked by adding to and removing from the Slack channel
— **one control rather than two that drift apart.** A named list in config goes
stale silently the day somebody leaves, and now there are two answers to "who
can see this" and no way to tell which one is being enforced.

The consequence has to be stated out loud during onboarding, because it is
real: on a Slack Connect channel **the customer controls who they add**, and
anyone they add can ask anything the channel is entitled to ask. That is the
intended design. It must be a decision someone made knowingly rather than
discovered later.

The same reasoning governs the ops channel — which is why that channel **must
be private**, and why the announce tool asks Slack on every call rather than
trusting config. In a public channel joining is one click, and membership would
authorise nothing.

---

## 6. One tool can write outside its own channel, and only one

`announce` lets operators broadcast into tenant channels. It is the single
exception to §1, and it is fenced accordingly:

- **Registered for the ops agent alone.** The factory returns `null` for every
  other `agentId`, so a tenant agent does not have it in its toolset at all — a
  stronger guarantee than refusing, because there is nothing to reach.
- **Destinations come from the tenant map**, never from the model.
- **Nothing sends on the first call.** The preview shows the exact bytes and
  the exact channels with a one-time token, and the text sent is the text
  *previewed* — so a model that reworded on the way in cannot deliver something
  unseen.

Tenant agents are also told what an announcement is *not*: they may repeat one
verbatim and may add nothing to it, because it is the one thing in the channel
they cannot look up. Treating it as a fact they know is how a customer ends up
with a maintenance window nobody scheduled.

---

## 7. The plugin computes; the model formats

The tool returns **raw rows** plus exact totals. It does not summarise.

Pre-rendering would reduce the agent to a string formatter and kill follow-up
questions — which is the only reason to run a language model here at all. A
pre-rendered summary answers one question, and "which of those was Contoso?"
has nowhere to go.

But **anything requiring arithmetic is computed in the plugin**, because the
model does not reliably do arithmetic in a customer-facing message:

- **Minor units are converted.** Handed raw cents, a model renders 36205622 as
  "$36,205,622" rather than "$362,056.22". A 100x error in a number a customer
  reads is not a formatting nit.
- **Totals come from SQL**, over the full range, so they stay exact when rows
  are capped and the model never has to sum anything to state a headline.
- **The as-of time is preformatted.** Given only a UTC timestamp and asked to
  render it locally, a model reads the clock face and appends the label — so a
  17:00 Pacific digest becomes "12:00 AM PT". Wrong, and entirely plausible.
- **Ids stay strings.** External ids routinely overflow int64 and float64, and
  a silently truncated id still looks plausible.

Rows go in the tool result's `content`, not only in `details`. `details` is
host metadata the model never sees; with rows only there, a digest agent
reports that no row data was returned — or, worse, produces a row label anyway,
which is a value it could not have read and therefore invented.

---

## 8. Two report shapes, and why the split matters

**`aggregate_by_entity`** returns one row per entity, whatever the window. The
`GROUP BY` happens in SQL, so a full year is a few hundred rows and nothing
truncates.

**`detail_by_entity`** returns one row per record, for a single entity the
customer names.

The temptation is to ship only the detail report and let the model aggregate.
Don't. At row grain a wide window is thousands of rows against a cap in the
hundreds, so the breakdown truncates **exactly when someone asks a broad
question** — and truncation is invisible in a well-formatted answer.

The aggregate is not an optimisation. It is what makes the broad question
answerable at all.

---

## 9. Silence is indistinguishable from an outage

A digest that never fires produces no error anywhere: the job did not run, so
nothing failed.

Hence: the empty case still posts. The heartbeat posts once a day even when
everything is fine, because a monitoring channel that is silent when things
work is also silent when the monitoring has broken. And the missed-digest alarm
exists because nobody notices an absence.

The same instinct runs through the failure paths. If the data call fails, the
digest does **not** post and does not estimate. If the headline posted but the
threaded detail failed, it says so — a partial post announced is recoverable, a
partial post concealed is not.

---

## 10. Prompts are not controls

Everything in a generated system prompt governs **phrasing**. Not one line of
it is a security control.

Tenant scoping, entitlement, the closed enums, the SQL contract — all enforced
in code, and all hold even if the model ignores every word of its prompt. That
separation is deliberate: a control you can talk someone out of is not a
control.

What prompts *are* good for is the class of failure where the model is
confidently wrong. The ambiguity table (`src/generator/ambiguity.ts`) is the
clearest case: "last month" and "the last 30 days" sound identical in English
early in a month and differ by a third of the data. A confident mis-map never
flags itself as uncertain, so the phrases are enumerated rather than left to
judgment.

And the capability list is **generated from the catalog**, including the worked
example. A hand-written example that names a report keeps naming it after that
report is deleted — and the model copies the example in preference to the list
above it.

---

## What this design does not give you

Worth knowing before you rely on it:

- **The digest depends on an unattended model call.** Totals are computed in
  SQL precisely so headline numbers are never derived by the model — but a
  model or provider outage means no digest. The heartbeat and the missed-digest
  alarm are what catch it.
- **A mis-mapped phrase not in the ambiguity table is still silently wrong.**
  Grow that table from real transcripts.
- **`single` tenancy mode removes the isolation boundary entirely.** It is
  correct for a company-wide internal metrics bot and wrong for anything a
  customer touches. `/almanac-init` refuses to write the combination.
- **Channel membership as the perimeter means the customer controls their own
  access list** on a Slack Connect channel. Intended, but only safe if it was a
  decision rather than a discovery.
