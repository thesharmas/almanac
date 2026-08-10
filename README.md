# Almanac

A bootstrap toolkit for **channel-scoped analytics bots**: an assistant that
answers questions about your warehouse data in a Slack channel, and posts a
scheduled digest into that channel unprompted.

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

All of the above, and why each part resists the obvious simplification, is in
**[docs/why.md](docs/why.md)** — the most useful thing in this repo and the
easiest to skip.

## How it is configured

Three catalogs, and nothing is configured in more than one:

| File | What it says |
|---|---|
| `deployment.yaml` | The org: branding, cloud, Slack, warehouse, tenancy model, domain vocabulary |
| `reports/<id>/` | What the bot can compute — `report.yaml`, `query.sql`, `digest.md` |
| `tenants.yaml` | Who gets what, and when |

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

## Licence

MIT. See [LICENSE](LICENSE).
