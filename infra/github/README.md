# GitHub Actions templates

Two workflows for **your** deployment repo. They are deliberately **not**
installed in the Almanac toolkit repo — a toolkit checkout has no deployment to
build, so a live `release` workflow there could only ever be inert or red, and a
permanently red workflow teaches you to ignore the Actions tab.

`/almanac-init` offers to install them. By hand it is:

```bash
mkdir -p .github/workflows
cp infra/github/ci.yml      .github/workflows/
cp infra/github/release.yml .github/workflows/
```

Nothing in them needs editing — every deployment-specific value is read from
`deployment.yaml` at run time.

## `ci.yml`

Runs `npm run check` on every pull request and push to `main`: lint, typecheck,
tests, the leak check, build, generate. Then it verifies `generated/` matches
what the catalogs produce, because that directory is committed so the diff is
reviewable — if it is out of date, either someone edited it by hand or forgot to
regenerate, and in both cases the deployed config would not be the reviewed one.

**Make this a required status check** on `main`. It is the only thing standing
between a broken catalog and a customer-facing host.

## `release.yml`

On a push to `main`: builds a release bundle, publishes it to your releases
bucket, and writes `DESIRED_VERSION`. The VM's poller picks it up within a
minute.

It needs two repository **variables** (not secrets — neither is a credential,
which is the point of Workload Identity Federation). `infra/07-ci-setup.sh`
prints both:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

Both workflows skip cleanly when there is no `deployment.yaml`, so installing
them before finishing `/almanac-init` is harmless.

## Before you enable the poller

**Merging to `main` deploys. There is no promote step, so PR review is the
gate.** Turn on branch protection first:

- require a pull request, with at least one review
- require the `check` workflow to pass, and to be up to date with `main`
- keep history linear
- no direct pushes to `main`, including from administrators

Enabling `infra/08-autodeploy.sh` without that means any push to `main` reaches
a host reading production data with nothing having reviewed it.

## Why CI never touches the VM

CI writes a bundle to one bucket; the host polls and pulls. Nothing connects
inward to a machine that deliberately has no external IP.

The VM reports its result to a *second* bucket that it cannot use to publish a
release — so compromising the customer-facing host gives no route to shipping
code, and compromising CI gives no route to the host.
