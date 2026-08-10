#!/usr/bin/env bash
# 01 — service account and buckets. Runs on your laptop.
#
# Idempotent; safe to re-run.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
require_project

say "Service account: ${SA_EMAIL}"
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="${BOT_NAME} VM" \
    --description="Runs the ${BOT_NAME} Gateway. Deliberately not the default compute SA."
fi

# Asserted here as well as in 05, because this is where somebody would add it.
assert_no_project_wide_secret_role

say "Releases bucket: gs://${RELEASES_BUCKET}"
if gcloud storage buckets describe "gs://${RELEASES_BUCKET}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud storage buckets create "gs://${RELEASES_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi

say "Deploy-status bucket: gs://${STATUS_BUCKET}"
if gcloud storage buckets describe "gs://${STATUS_BUCKET}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud storage buckets create "gs://${STATUS_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi

# The VM READS releases and WRITES status. Never the other way round: if it
# could write to the releases bucket, compromising the customer-facing host
# would give an attacker a way to publish a release to itself.
say "Bucket IAM — the VM reads releases and writes status, never the reverse"
gcloud storage buckets add-iam-policy-binding "gs://${RELEASES_BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectViewer" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${STATUS_BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectCreator" >/dev/null

say "Log writing"
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/logging.logWriter" \
  --condition=None >/dev/null

say "Done"
note "next: infra/02-vm.sh"
