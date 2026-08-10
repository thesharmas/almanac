# Almanac

A bootstrap toolkit for **channel-scoped analytics bots**: an assistant that
answers questions about your warehouse data in a Slack channel, and posts a
scheduled digest into that channel unprompted.

Almanac is not a product you run. It is a repo you clone, an interview you sit
through, and a set of Claude Code skills that turn your answers into a deployed
bot. The interesting part is not that it queries a warehouse — it is that a
channel can only ever see its own data, and that this stays true as the config
changes every week.

> **Status: scaffolding.** The design is settled; the code is being extracted
> from a production deployment. Nothing here is usable yet. See
> [Roadmap](#roadmap).

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
                                    └──────────────────────┼───────────┘
                                                           │ SQL, tenant-scoped
                                                           ▼
                                                     Your warehouse
```

**One agent per tenant, bound to exactly one channel.** The binding is
generated, never hand-written, so an agent has no way to speak in a channel
other than its own.

**The model never writes SQL.** It picks a report id and a date range from
closed enums. The plugin owns the query template and substitutes encoded
literals. A new report cannot introduce an injection surface, because the
contract checker gives it nowhere to put one.

**The plugin returns rows; the model summarises them.** That is the whole reason
a language model is in the picture — a pre-rendered summary answers one
question, and the follow-up has nowhere to go.

**Drift fails the build, not the customer.** Every allowlisted channel has
exactly one binding, every binding has a tenant, every schedule names a report
its tenant is entitled to. All of it is checked before anything ships.

## How it is configured

Three catalogs, and nothing is configured in more than one of them:

| File | What it says |
|---|---|
| `deployment.yaml` | The org: branding, cloud, Slack, warehouse, tenancy model, domain vocabulary |
| `reports/<id>/` | What the bot can compute — shape, query template, digest prompt |
| `tenants.yaml` | Who gets what, and when |

A generator turns the three into the Gateway config, the agent prompts, the
tenant map and the scheduled jobs.

## The skills

Almanac's real surface is a set of Claude Code skills. They interview you one
question at a time, verify what they can by execution rather than assertion, and
stop at a pull request.

| Skill | What it does |
|---|---|
| `/almanac-init` | The bootstrap interview. Emits `deployment.yaml`, picks a warehouse adapter, writes your Slack app manifest, and drafts a first report against your own schema |
| `/almanac-connect` | Proves the warehouse config is real: connects, proves the role cannot write, proves the tenant predicate isolates |
| `/almanac-add-report` | Drafts SQL against your schema, runs it, shows the rows, proves totals survive row caps |
| `/almanac-add-tenant` | Onboards a tenant: channel, tenant id, entitlements, schedule |
| `/almanac-provision` | Walks the GCP provisioning scripts, stopping where a human must act |
| `/almanac-go-live` | The cross-tenant isolation check and the pre-launch checklist |

## Roadmap

- [ ] `deployment.yaml` schema — the config surface everything else derives from
- [ ] Core extraction: catalog schemas, contract checker, date arithmetic, payload shaping, generator, invariants
- [ ] Warehouse adapters: direct Snowflake (key-pair auth, read-only role) and MCP `execute_sql`
- [ ] Report archetypes: aggregate-by-entity and detail-by-entity
- [ ] Infra scripts: network, VM, image, secrets, monitoring, CI, autodeploy
- [ ] The skills
- [ ] `docs/why.md` — the reasoning behind each control, which is the part most
      likely to be deleted by someone who thinks it is redundant

## Licence

MIT. See [LICENSE](LICENSE).
