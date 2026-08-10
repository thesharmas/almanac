#!/usr/bin/env bash
# Converge the Gateway's cron jobs onto the generated desired state.
# Runs ON THE VM, after a restart.
#
# WHY THIS EXISTS AT ALL. Automation jobs are not config: they live in the
# Gateway's own state and are managed through its CLI. A file-only generator
# would create a tenant's schedule and never remove it, so deleting a stanza
# from tenants.yaml would revoke their access while leaving a job that still
# fires into a channel nobody is entitled to any more.
#
# AND IT FAILS ON ANY JOB IT DID NOT CREATE. A hand-made job is drift by
# definition: nothing reviewed it, and nothing will ever remove it. Refusing to
# proceed is the only response that keeps "everything a tenant touches is
# derived from one reviewed stanza" true.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DESIRED="$(dirname "${BASH_SOURCE[0]}")/../generated/automations.json"
[[ -f "${DESIRED}" ]] || die "no generated/automations.json in this release"

# Every job this system owns carries the deployment slug as its prefix. That is
# what makes "ours" and "not ours" decidable.
PREFIX="${NAME}:"

say "Reading the desired state"
mapfile -t desired_names < <(node -e "
  const jobs = require('${DESIRED}');
  for (const job of jobs) console.log(job.name);
")
note "${#desired_names[@]} job(s) desired"

say "Reading what the Gateway currently has"
mapfile -t existing < <(openclaw cron list --json 2>/dev/null | node -e "
  let raw = '';
  process.stdin.on('data', c => raw += c);
  process.stdin.on('end', () => {
    const jobs = JSON.parse(raw || '[]');
    for (const job of jobs) console.log(job.name);
  });
")

# Anything without our prefix is a job we did not create.
foreign=()
for name in "${existing[@]}"; do
  [[ "${name}" == "${PREFIX}"* ]] || foreign+=("${name}")
done

if [[ ${#foreign[@]} -gt 0 ]]; then
  die "the Gateway has ${#foreign[@]} job(s) this deployment did not create:
    ${foreign[*]}

    Nothing reviewed them and nothing will ever remove them, so they are drift
    by definition. Delete them by hand (openclaw cron delete <name>) and re-run,
    or add them to tenants.yaml so they are generated like everything else."
fi

say "Removing jobs no longer desired"
for name in "${existing[@]}"; do
  wanted=false
  for want in "${desired_names[@]}"; do
    [[ "${name}" == "${want}" ]] && wanted=true && break
  done
  if [[ "${wanted}" == false ]]; then
    note "delete ${name}"
    openclaw cron delete "${name}"
  fi
done

say "Applying the desired state"
node -e "
  const jobs = require('${DESIRED}');
  console.log(JSON.stringify(jobs));
" | node -e "
  let raw = '';
  process.stdin.on('data', c => raw += c);
  process.stdin.on('end', () => {
    for (const job of JSON.parse(raw)) {
      // Printed as a shell line so the reconcile log shows exactly what ran.
      console.log([
        'openclaw', 'cron', 'upsert', JSON.stringify(job.name),
        '--agent', JSON.stringify(job.agentId),
        '--cron', JSON.stringify(job.cron),
        '--tz', JSON.stringify(job.tz),
        '--session', job.session,
        '--prompt-file', JSON.stringify('/app/' + job.promptPath),
        '--deliver', job.deliver.mode,
      ].join(' '));
    }
  });
" | while read -r line; do
  note "${line}"
  eval "${line}"
done

say "Reconciled"
note "${#desired_names[@]} job(s) now match the generated desired state"
