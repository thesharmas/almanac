---
name: almanac-provision
description: Walk the Almanac GCP provisioning scripts in order, checking the state of each step before running it and stopping where a human must act (creating the Slack app, pasting secret values, joining the tailnet). Use when setting up the infrastructure for a deployment, provisioning the VM, or when someone asks what infrastructure step comes next.
---

# Provisioning

Walk `infra/00` through `infra/08` in order, checking what already exists
before running anything. Several scripts are idempotent; several are not; and
three of them need a human.

Read `infra/README.md` first. Everything the scripts use comes from
`deployment.yaml`, so if a value looks wrong, the fix is there and not in a
script.

**Say which machine each step runs on.** Half of these run on the laptop and
half on the VM, and running one in the wrong place is the most common way this
goes sideways.

## Before anything

Check `deployment.yaml` has a `gcp:` block. If it does not, they are
provisioning elsewhere or by hand — say so and stop rather than inventing
values.

Then confirm the basics:

```bash
gcloud auth list
gcloud config get-value project
```

If the active project is not the one in `deployment.yaml`, say so. Do not
silently switch it — a script that provisions into the wrong project is a bad
afternoon and a confusing bill.

## The walk

For each step: **check whether it has already been done**, report what you
found, then run it or skip it.

### 00 — network (laptop)

Ask first whether the org already has a VPC that should be used. If so, set
`gcp.network` and `gcp.subnet` in `deployment.yaml` to the existing names and
**skip this script entirely** — creating a second VPC beside an existing one is
worse than not having one.

Otherwise check and run:

```bash
gcloud compute networks describe "$(...network)" 2>/dev/null
```

### 01 — service account and buckets (laptop)

Idempotent. Check the service account and both buckets exist afterwards.

Note the asymmetry out loud, because it is the point: the VM **reads**
releases and **writes** status, never the reverse. If it could write releases,
compromising the customer-facing host would give a route to publishing code to
itself.

### 02 — the VM (laptop)

**The first billable resource.** Say so, and give the rough monthly cost of the
machine type in `deployment.yaml` before running it.

It refuses if the network is missing rather than creating one. If it refuses,
that is 00 not having run, or `gcp.network` naming something that does not
exist — do not work around it.

### 03 — host setup (VM)

They need to SSH in:

```bash
gcloud compute ssh <vm> --zone=<zone> --tunnel-through-iap
```

**This step needs a human.** Tailscale wants an auth key, and it must carry a
tag — a node joined under someone's personal account inherits their ACLs and
vanishes from the tailnet when they leave. Point at `infra/tailscale-acl.md`
and wait.

Say the `serve` / `funnel` thing explicitly. One word apart; one is the tailnet
and the other is the public internet.

### 04 — pin the image (VM)

Needs a version. **Never `latest`** — the script refuses it, and the reason is
that an unrelated 3 a.m. restart must not silently upgrade a customer-facing
system to an image nobody chose.

### 05 — secrets (laptop)

**This step needs a human**: it prompts for each value, and values are typed
rather than passed as arguments so they do not land in shell history.

Before running, check they have all of them to hand:

- Slack bot token (`xoxb-`) and app token (`xapp-`)
- an Anthropic API key
- a Slack incoming webhook for the error channel
- the warehouse credential — a Snowflake private key, or an MCP API key

If they have not created the Slack app yet, stop here and do that first:
`infra/slack-app-manifest.yaml`, pasted into "From an app manifest". The two
things worth pointing out are Socket Mode with no request URL, and no history
scopes.

Afterwards, verify the grant is per-secret:

```bash
gcloud secrets get-iam-policy <prefix>-slack-bot-token
```

### 06 — monitoring (VM)

Check the timers are actually enabled afterwards, not just installed:

```bash
systemctl list-timers '<name>-*'
```

### 07 — CI identity (laptop)

Takes the GitHub `owner/repo`. Afterwards, the two printed values go into the
repo's Actions **variables** — say that they are variables, not secrets, and
that neither is a credential: that is the point of Workload Identity
Federation.

Check the workflows are actually installed before moving on:

```bash
ls .github/workflows/
```

If they are not there, copy them from `infra/github/` — they ship as templates,
so a clone that skipped that step in `/almanac-init` has no CI at all.

### 08 — the poller (VM)

After this, merging to `main` deploys. Say that plainly, and check branch
protection is on before enabling it: with no promote step, PR review is the
only gate in front of a customer-facing system.

## Afterwards

Run one deploy end to end and watch it:

```bash
# laptop
./infra/build-release.sh
# VM
journalctl -u <name>-poll -f
```

Then confirm the Gateway is answering and the timers are live. If the first
deploy fails, the poller rolls back on its own and reports to the error channel
— check that the rollback happened rather than assuming it did.

## Where this stops

At infrastructure that is up. It does not invite the bot to any channel and
does not go live. `/almanac-go-live` is next, and it is not optional for the
first tenant.
