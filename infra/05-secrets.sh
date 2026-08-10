#!/usr/bin/env bash
# 05 — secrets. Runs on your laptop.
#
# Creates the Secret Manager entries and binds secretAccessor PER SECRET.
#
# Never project-wide. A project-level grant behaves identically on day one and
# silently widens every time anyone adds a secret to the project — including
# secrets belonging to systems that have nothing to do with this one. Both this
# script and 01 assert that no such grant exists and refuse to continue if one
# appears.
#
# Values are prompted for, never passed as arguments: an argument lands in your
# shell history and in the process table.
#
# Idempotent; safe to re-run. Re-running adds a new version to an existing
# secret rather than replacing it, so rollback stays possible.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
require_project

assert_no_project_wide_secret_role

say "Secrets for ${BOT_NAME}"
for secret in "${SECRETS[@]}"; do
  if gcloud secrets describe "${secret}" >/dev/null 2>&1; then
    note "${secret} — exists"
  else
    note "${secret} — creating"
    gcloud secrets create "${secret}" --replication-policy=automatic >/dev/null
  fi

  # Bind the accessor role for this secret alone.
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  if gcloud secrets versions list "${secret}" --limit=1 --format="value(name)" 2>/dev/null | grep -q .; then
    continue
  fi

  printf '    no value yet. Paste it now, or press enter to skip: '
  read -rs value
  printf '\n'
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}" | gcloud secrets versions add "${secret}" --data-file=- >/dev/null
    note "stored"
  else
    note "skipped — the deploy will fail until this has a value"
  fi
  unset value
done

say "Done"
note "secretAccessor is bound per secret. Verify with:"
note "  gcloud secrets get-iam-policy ${SECRETS[0]}"
