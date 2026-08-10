# Infrastructure

Every value these scripts use comes from `deployment.yaml`. There is nothing to
edit here — if you want to change the project, the region or a bucket name,
change it there and re-run.

`/almanac-provision` walks this list, checks each step, and stops where a human
must act.

## Order

| Script | Runs on | Creates |
|---|---|---|
| `00-network.sh` | laptop | VPC, subnet, Cloud NAT, IAP SSH rule. **Skip if you already have a VPC** — set `gcp.network`/`gcp.subnet` instead |
| `01-project-prereqs.sh` | laptop | Service account, releases + status buckets, bucket IAM |
| `02-vm.sh` | laptop | The VM. First billable resource. Refuses to run if the network is missing |
| `03-host-setup.sh` | **VM** | Docker, Tailscale, deployment directories |
| `04-image.sh` | **VM** | Pins the container image by digest; saves a rescue tarball |
| `05-secrets.sh` | laptop | Secret Manager entries + per-secret IAM |
| `06-monitoring.sh` | **VM** | Health check and daily heartbeat timers |
| `07-ci-setup.sh` | laptop | GitHub Actions identity via Workload Identity Federation |
| `08-autodeploy.sh` | **VM** | The release poller |

`00`, `01` and `05` are idempotent and safe to re-run.

Then, in normal operation:

| Script | Runs on | Does |
|---|---|---|
| `build-release.sh` | laptop / CI | Runs the gate, packs a bundle, publishes it |
| `deploy.sh` | VM | Fetches, verifies, swaps, restarts, reconciles. `--rollback` |
| `reconcile-automations.sh` | VM | Converges cron jobs onto the generated desired state |
| `slack-lookup.sh` | laptop | Resolves a channel by name; verifies membership by id |
| `leakcheck.mjs` | laptop / CI | Refuses to let a live identifier into a tracked file |

`github/` holds the two GitHub Actions workflows as **templates**, to copy into
`.github/workflows/` in your own repo — see [github/README.md](github/README.md).
They are not live here: the toolkit repo has no deployment to build, so a
`release` workflow in it could only ever be inert or red.

## Five things that are easy to get wrong

**Secret access is granted per secret, never project-wide.** A project-level
`secretAccessor` behaves identically on day one and silently widens every time
anyone adds a secret to the project. `01` and `05` both assert that no such
grant exists and refuse to continue if one appears.

**The VM has its own service account.** Sharing the default compute service
account means any other host in the project can read this one's secrets, which
defeats the point of separating hosts at all.

**The image is pinned by digest, never by tag.** A moving `:latest` means an
unrelated restart — an OOM kill, a host reboot at 3 a.m. — silently upgrades a
customer-facing system to an image nobody chose. `04-image.sh` refuses to pin
`latest`.

**`tailscale serve`, never `tailscale funnel`.** One word apart; one is your
tailnet and the other is the public internet. See
[tailscale-acl.md](tailscale-acl.md).

**The checksum is verified before unpacking.** Unpacking first and checking
afterwards means a tampered bundle has already written to the host by the time
you find out.

## The deploy model

```
  PR ──▶ ci.yml: npm run check + generated/ is in sync + leak check
          │
  merge ──▶ release.yml: build, publish bundle, write DESIRED_VERSION
                                        │
                                        ▼  (GCS)
                      the VM's poller, every 60s: fetch, verify, deploy
```

**CI never touches the VM.** It writes to one bucket and the host pulls from
it, so no inbound path is opened to a machine that deliberately has no external
IP. The VM writes its result to a *second* bucket it cannot use to publish a
release — so compromising the customer-facing host gives no route to shipping
code.

The poller holds off within 15 minutes of a scheduled digest rather than
restarting the Gateway underneath one, and rolls back and reports on failure.

## Why the reconciler refuses on a foreign job

Automation jobs are not config: they live in the Gateway's own state and are
managed through its CLI. A file-only generator would create a tenant's schedule
and never remove it, so deleting a stanza would revoke access while leaving a
job that still fires into a channel nobody is entitled to.

And a job the reconciler did not create is drift by definition — nothing
reviewed it, and nothing will ever remove it. Failing the deploy is the only
response that keeps "everything a tenant touches comes from one reviewed
stanza" true.
