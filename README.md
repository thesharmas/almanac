# Almanac

A bootstrap toolkit for **channel-scoped analytics bots**: an assistant that
answers questions about your warehouse data in a Slack channel — and, if you
want one, posts a scheduled digest into that channel unprompted.

The everyday use is people asking:

```
@almanac  how much did we do last month?
@almanac  which of those was Contoso?
@almanac  and the month before?
```

The digest is one feature on top of that, not the point of it. A tenant with
reports and no schedule is a complete deployment.

Almanac is not a product you run. It is a repo you clone, an interview you sit
through, and a set of Claude Code skills that turn your answers into a deployed
bot. The interesting part is not that it queries a warehouse — it is that a
channel can only ever see its own data, and that this stays true as the config
changes every week.

## Quick start

```bash
git clone https://github.com/thesharmas/almanac.git && cd almanac
npm install
claude   # then: /almanac-init
```

The interview asks about your tenancy model, your warehouse, your Slack
workspace and your domain vocabulary, writes `deployment.yaml`, and then — if
it can reach your warehouse — drafts your first report against your own schema
and shows you the rows.

Getting to your own numbers in one session is the goal. A config that validates
but has never touched your warehouse has not proved anything.

## What it gives you

```
  Slack channel                     Your GCP project
  ┌──────────────┐                  ┌──────────────────────────────────┐
  │ #data-acme   │◄──Socket Mode───►│  OpenClaw Gateway (container)    │
  │              │                  │   ├── agent: acme  ──┐           │
  │ @bot …?      │                  │   ├── agent: …       │ bound 1:1 │
  └──────────────┘                  │   └── agent: quarantine          │
                                    │                      │           │
                                    │   almanac plugin     │           │
                                    │   ├── run_report     │           │
                                    │   └── post_digest    │           │
                                    └──────────────────────┼───────────┘
                                                           │ SQL, tenant-scoped
                                                           ▼
                                              Snowflake, or your MCP
```

**One agent per tenant, bound to exactly one channel.** The binding is
generated, never hand-written, so an agent has no way to speak in a channel
other than its own. Tenant resolution happens at the tool boundary on every
invocation, from a value the host sets — never a tool parameter, never inferred
from the message.

**The model never writes SQL.** It picks a report id and a date range from
closed enums. The plugin owns the query template and substitutes encoded
literals. A new report cannot introduce an injection surface, because the
contract checker gives it nowhere to put one.

**The plugin returns rows; the model summarises them.** That is the whole
reason a language model is in the picture — a pre-rendered summary answers one
question, and the follow-up has nowhere to go. But anything requiring
arithmetic is computed in the plugin, because a model doing arithmetic in a
customer-facing money message gets it wrong in ways that look right.

**Drift fails the build, not the customer.** Every allowlisted channel has
exactly one binding, every binding has a tenant, every schedule names a report
its tenant is entitled to. All of it checked before anything ships.

**It runs on [OpenClaw](https://github.com/openclaw/openclaw)**, and the
deciding property was one thing: the Gateway hands a plugin the calling agent's
identity on a trusted context, out of band from the conversation. Tenant
identity that arrives from the host rather than from a parameter is what the
whole isolation model rests on — [why.md §0](docs/why.md) covers what else the
runtime brings, what it costs, and what a replacement would have to provide.

All of the above, and why each part resists the obvious simplification, is in
**[docs/why.md](docs/why.md)** — the most useful thing in this repo and the
easiest to skip.

## What it can answer

Every report a channel is entitled to, across every window that report
supports, with follow-ups resolving in-thread. Adding a report widens what the
bot can answer **without touching a prompt** — the capability list and the
"what can you do" reply are generated from the catalog, so a new report shows
up in every entitled channel the day it ships.

It is **not text-to-SQL**, deliberately. The model picks a report id and a date
range from closed enums; a new capability is a reviewed SQL template, not a
generated query. So it answers what the catalog covers and says so plainly when
a question falls outside it, rather than offering an adjacent number as though
it were the answer. That is a real limitation, and
[why.md §2](docs/why.md) is the argument for accepting it.

Growing the catalog is the loop: out-of-scope questions escalate with reason
`out_of_scope`, which is demand signal in the customer's own words. Read it,
then run `/almanac-add-report`. The bot gets more useful over time without any
control being loosened — widening the catalog and widening the attack surface
are, by construction, different actions.

## How it is configured

Three catalogs, and nothing is configured in more than one:

| File | What it says |
|---|---|
| `deployment.yaml` | The org: branding, cloud, Slack, warehouse, tenancy model, domain vocabulary |
| `reports/<id>/` | What the bot can compute — `report.yaml`, `query.sql`, and `digest.md` only if it will be scheduled |
| `tenants.yaml` | Who gets what (`reports:`), and when (`schedules:`, optional) |

A generator turns the three into the Gateway config, the agent prompts, the
tenant map and the scheduled jobs. Nothing about a tenant is configured in more
than one place, so nothing about a tenant can drift out of step with itself.

The real files are gitignored — only the `.example` versions are tracked, and
`npm run check` includes a leak gate that refuses to let a live channel id,
tenant id or token into a tracked file.

## The skills

| Skill | What it does |
|---|---|
| `/almanac-init` | The bootstrap interview, ending at a report that returns your own rows |
| `/almanac-connect` | Proves the role **cannot write** and the tenant predicate isolates |
| `/almanac-add-report` | Drafts SQL against your schema, runs it, proves totals survive row caps |
| `/almanac-add-tenant` | Onboards a tenant: id, channel, entitlements, schedule |
| `/almanac-provision` | Walks the GCP scripts, stopping where a human must act |
| `/almanac-go-live` | The cross-tenant isolation check and the pre-launch checklist |

They interview one question at a time, verify by execution rather than
assertion, and **stop at a pull request**. See [docs/skills.md](docs/skills.md).

## Repo layout

| Path | What it is |
|---|---|
| `src/config/` | The `deployment.yaml` schema and loader |
| `src/catalog/` | Schemas and loaders for reports and tenants |
| `src/reports/` | The SQL contract, literal encoding, calendar arithmetic, payload shaping |
| `src/warehouse/` | The one-method adapter seam: Snowflake direct, or MCP |
| `src/plugin/` | The tools: `run_report`, `post_digest`, `announce`; tenant resolution, audit, escalation |
| `src/generator/` | Catalogs → Gateway config, prompts, tenant map, cron jobs, plus the build invariants |
| `reports/_archetypes/` | The two report shapes, to copy |
| `infra/` | Provisioning, release, deploy, monitoring, and the leak gate |
| `docs/why.md` | Why each control exists |

## Working in it

```bash
npm install
npm run check      # lint + typecheck + 189 tests + leak check + build + generate
npm run generate   # catalogs -> generated/
```

`npm run check` is the gate. `infra/build-release.sh` runs it and refuses to
build a bundle if it fails, so a broken checkout cannot reach a host.

Node 22.22.3+, 24.15.0+ or 25.9.0+ — pinned in `package.json` and
`.node-version`.

## Shipping

The two GitHub Actions workflows ship as **templates** in
[`infra/github/`](infra/github/README.md) — `/almanac-init` installs them into
your repo. They are not live here, because the toolkit repo has no deployment
to build.

**Merging to `main` deploys.** There is no promote step, so the PR review is
the gate — turn on branch protection before you turn on the poller.

```
  PR ──▶ ci.yml: npm run check + generated/ is in sync
          │
  merge ──▶ release.yml: build, publish bundle, write DESIRED_VERSION
                                        │
                                        ▼  (GCS)
                      the VM's poller, every 60s: fetch, verify, deploy
```

CI never touches the VM. It writes to one bucket and the host pulls from it, so
no inbound path is opened to a machine that deliberately has no external IP.
The VM writes its result to a *second* bucket it cannot publish releases from,
so compromising the customer-facing host gives no route to shipping code.

## What's next

Not scheduled, and not promises. The scoping notes are the useful part — each
one is what you would actually hit on day one.

- **Other clouds, AWS first.** The application is already portable: a container
  plus environment variables. What is GCP-shaped is `infra/` — Secret Manager,
  GCS, IAP SSH, Cloud NAT, Workload Identity Federation. Every AWS parallel
  exists (Secrets Manager, S3, SSM Session Manager, NAT Gateway, OIDC to an IAM
  role), and `infra/env.sh` already reads everything from `deployment.yaml`, so
  the shape is an `aws:` block beside `gcp:`. Bounded work, no open design
  questions.

- **Other warehouses.** `WarehouseAdapter` is one method, so BigQuery, Postgres,
  Databricks and Redshift are each a file. The harder half is dialect, and there
  are two concrete blockers today: the contract checker requires
  `CURRENT_DATE()` **with parentheses** (Postgres wants it bare), and both
  archetypes use Snowflake's `TO_VARCHAR`. So the real shape is *adapter +
  per-dialect archetypes + a dialect-aware contract check* — without the last
  two, the first Postgres adopter meets a confusing build failure.

- **A local demo.** Today you need a real warehouse *and* a Slack app before you
  see anything work. A seeded fixture database plus a local Gateway would let
  someone evaluate the whole thing before committing to either. For a bootstrap
  toolkit this is probably the highest-value item here.

- **End-to-end tests.** The 189 tests are all unit-level. Nothing automatically
  proves the whole path — Slack in, tenant resolved, SQL rendered, rows shaped,
  answer out — actually works, because that needs a live warehouse and Gateway.
  `/almanac-connect` and `/almanac-go-live` cover the same ground interactively,
  which is the right shape for a toolkit but is not a regression test.

- **`/almanac-check-digest`.** Nothing verifies a digest was *correct* — only
  that it posted. A skill that reads back the last one and ties its numbers to a
  control query would close that.

- **Rate limiting and a query budget.** `rate_anomaly` exists in the escalation
  enum and nothing ever emits it. Nothing bounds warehouse spend either: a
  channel repeatedly asking `all_time` on a large tenant simply costs money.

- **A period-comparison archetype.** *"Is that up or down?"* is the most natural
  follow-up to any digest, and there is no report shape for period-over-period.
  Cheap — a third archetype, no platform change.

- **A worked single-tenant example.** `tenancy.mode: single` is supported and
  tested but has no example config, and "internal company metrics bot" is
  probably a common way in.

### Needs a design decision first

These are not scheduled work. Each changes a property the current design relies
on, so the decision comes before the code.

- **Other chat surfaces** (Teams, Discord, Google Chat). Not simply another
  channel plugin: Socket Mode is *why* the host can run with no external IP and
  no inbound path. Teams needs an inbound webhook, which trades that away. The
  exposure model has to be decided before the adapter is worth writing.

- **Column-level entitlement.** Today a channel sees a whole report or none of
  it. "This channel sees revenue but not margin" means the tenant map carries
  more than an id, and the capability list, the prompts and the shaper all have
  to agree about it — a design change, not a config one.

- **Secret rotation.** `infra/05-secrets.sh` adds versions, but there is no
  rotation runbook and no expiry story for the Slack tokens or the warehouse
  key.

## Licence

MIT. See [LICENSE](LICENSE).
