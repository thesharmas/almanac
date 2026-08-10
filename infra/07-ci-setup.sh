#!/usr/bin/env bash
# 07 — CI identity. Runs on your laptop.
#
# Creates a service account for GitHub Actions with Workload Identity
# Federation, so CI holds no long-lived key.
#
# CI CAN WRITE RELEASES AND READ STATUS. It cannot touch the VM at all — there
# is no SSH, no deploy permission, and nothing to connect to. The VM pulls.
# That asymmetry is the whole design: compromising CI gets you the ability to
# publish a release (which is bad, and is what PR review guards), and
# compromising the VM gets you no route to shipping code at all.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
require_project

REPO="${1:-}"
[[ -n "${REPO}" ]] || die "usage: 07-ci-setup.sh <github-owner/repo>"

CI_SA="${NAME}-ci"
CI_EMAIL="${CI_SA}@${PROJECT}.iam.gserviceaccount.com"
POOL="${NAME}-github"
PROVIDER="github"

say "CI service account: ${CI_EMAIL}"
if gcloud iam service-accounts describe "${CI_EMAIL}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud iam service-accounts create "${CI_SA}" \
    --display-name="${BOT_NAME} CI" \
    --description="Publishes release bundles. Deliberately has no access to the VM."
fi

say "Workload identity pool"
if gcloud iam workload-identity-pools describe "${POOL}" --location=global >/dev/null 2>&1; then
  note "already exists"
else
  gcloud iam workload-identity-pools create "${POOL}" \
    --location=global \
    --display-name="GitHub Actions"
fi

say "Provider"
if gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
     --location=global --workload-identity-pool="${POOL}" >/dev/null 2>&1; then
  note "already exists"
else
  # The attribute condition is not optional. Without it, ANY GitHub repository
  # in the world can mint a token for this pool.
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --location=global \
    --workload-identity-pool="${POOL}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${REPO}'"
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

say "Letting ${REPO} impersonate the CI account"
gcloud iam service-accounts add-iam-policy-binding "${CI_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${PRINCIPAL}" >/dev/null

say "Bucket access — write releases, read status, nothing else"
gcloud storage buckets add-iam-policy-binding "gs://${RELEASES_BUCKET}" \
  --member="serviceAccount:${CI_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${STATUS_BUCKET}" \
  --member="serviceAccount:${CI_EMAIL}" \
  --role="roles/storage.objectViewer" >/dev/null

say "Done"
note "add these to the repo's GitHub Actions variables:"
note "  GCP_WORKLOAD_IDENTITY_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
note "  GCP_SERVICE_ACCOUNT            = ${CI_EMAIL}"
