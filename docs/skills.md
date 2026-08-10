# The skills

Skills in `.claude/skills/` turn a runbook into something you can invoke. They
are checked into the repo, so they version with the code they drive and
everyone working on a deployment gets the same one.

A skill is not a replacement for its reasoning. [why.md](why.md) explains why
each control exists; a skill walks the steps and does the mechanical parts.
When they disagree, why.md is right and the skill needs fixing.

## The six

| Skill | What it does |
|---|---|
| `/almanac-init` | The bootstrap interview. Tenancy model → predicate → warehouse → Slack → GCP → vocabulary. Writes `deployment.yaml`, then drafts a first report against your own schema and runs it |
| `/almanac-connect` | Proves the warehouse config is real: connects, proves the role **cannot write**, proves the tenant predicate isolates |
| `/almanac-add-report` | Adds a capability, or changes one. Drafts SQL against real data and iterates on rows; on a change, walks the versioned path with a live v1-vs-v2 diff |
| `/almanac-add-tenant` | Onboards a tenant: tenant id, channel, entitlements, schedule |
| `/almanac-provision` | Walks `infra/00`–`08`, checking each step and stopping where a human must act |
| `/almanac-go-live` | The cross-tenant isolation check and the pre-launch checklist |

## Using one

Type `/almanac-init` in Claude Code. Skills are also matched automatically
against the `description` in their frontmatter, so "let's onboard Northwind"
finds `/almanac-add-tenant` without the slash command.

They interview **one question at a time**. That is deliberate: several answers
depend on earlier ones, and a wall of questions is how people skip the one that
matters.

## The order, for a new deployment

```
/almanac-init       →  a validated config and a report returning your own rows
/almanac-connect    →  proof the role is read-only and the predicate isolates
/almanac-add-tenant →  the first channel (staging)
/almanac-provision  →  the infrastructure
/almanac-go-live    →  the checks before anyone outside can see it
```

`/almanac-add-report` slots in whenever a new capability is needed.

## Where a skill stops

**Every skill that changes config stops at the pull request.** None of them
merges, and none of them deploys.

That is not caution for its own sake. Merging to `main` deploys within about a
minute, so the PR review is the only gate in front of a customer-facing system
that reads production data. A skill that merged its own work would remove the
one check the whole pipeline is built around. Branch protection should enforce
this independently — a skill could not push to `main` even if it tried.

The steps after the PR — the isolation check, testing in the channel, inviting
the customer — stay with a person for the same reason.

## What makes a good one here

- **Interview, do not assume.** One question at a time, and confirm anything
  that came from a lookup rather than from the user. `/almanac-add-tenant`
  confirms the tenant id even when the search returns exactly one match,
  because a wrong tenant id is a cross-tenant leak that every other control
  will faithfully enforce.
- **Name the shortcuts it must refuse.** Write them in as explicit rules —
  "never guess a tenant id", "never add `allowSharedTenant` to silence a build
  failure", "never write a customer-facing deployment in single-tenant mode" —
  because the failure mode of an automated helper is being helpfully wrong at
  2 a.m.
- **Verify by execution, not by reading.** `/almanac-connect` does not read the
  role's grants; it attempts a write and requires it to fail.
  `/almanac-add-report` does not review the SQL it drafted; it runs it, shows
  the rows, and asks the user to tie one number to something they already
  trust.
- **Degrade honestly.** When the warehouse is not reachable, say plainly which
  checks could not run and hand them to the user. **A skill that quietly does
  less is worse than one that refuses**, because an unrun check reads exactly
  like a passed one.
- **Stop at the PR**, and say plainly what is left.

## Adding one

Create `.claude/skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: almanac-do-the-thing
description: One or two sentences on what it does and when to use it. This is
  what Claude matches against, so write it the way someone would ask.
---

# Doing the thing

Instructions...
```

Then add a row to the table above — a skill nobody knows about is a skill
nobody uses — and point at [why.md](why.md) from inside it, so the reasoning
keeps one home rather than slowly becoming a second, diverging copy.

## Not a skill, deliberately

**Operator announcements** are driven from Slack by the ops agent, not from a
skill. The action writes into customer channels, so it belongs behind
membership of a private ops channel and a preview-and-confirm step in the
running system, where an operator can see exactly what will go out. A skill on
someone's laptop is the wrong place for that.
