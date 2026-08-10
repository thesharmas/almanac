#!/usr/bin/env bash
# Shared settings for the Almanac infrastructure scripts.
#
# Source this; do not run it.
#
# EVERY VALUE HERE IS READ FROM deployment.yaml. That is the point: the config
# a reviewer reads and the config the scripts act on are the same file, so a
# project or bucket named in one place cannot drift from the other.
#
# If you find yourself wanting to hardcode a value here, add it to
# deployment.yaml's `gcp:` block instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT_FILE="${REPO_ROOT}/deployment.yaml"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "${DEPLOYMENT_FILE}" ]] || die \
  "no deployment.yaml — run /almanac-init, or copy deployment.yaml.example and fill it in"

# Read one dotted path out of deployment.yaml. Node is already a dependency of
# this repo, and shelling out to it beats asking every operator to install yq.
cfg() {
  local path="$1" default="${2-}"
  local value
  value="$(node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { parse } from 'yaml';
    const doc = parse(readFileSync('${DEPLOYMENT_FILE}', 'utf8'));
    const value = '${path}'.split('.').reduce((o, k) => (o ?? {})[k], doc);
    process.stdout.write(value === undefined || value === null ? '' : String(value));
  " 2>/dev/null || true)"
  if [[ -z "${value}" ]]; then
    if [[ -n "${default}" ]]; then printf '%s' "${default}"; return 0; fi
    die "deployment.yaml has no ${path}, and it is required for this script"
  fi
  printf '%s' "${value}"
}

NAME="$(cfg name)"
BOT_NAME="$(cfg branding.botName)"

PROJECT="$(cfg gcp.project)"
REGION="$(cfg gcp.region)"
ZONE="$(cfg gcp.zone)"

VM_NAME="$(cfg gcp.vmName "${NAME}-vm")"
# e2-medium rather than e2-small: a Gateway with several agents runs comfortably
# under 1 GB, but Node heap plus sessions plus SQLite page cache leaves little
# headroom in 2 GB. An OOM kill in a customer-facing channel is a bad way to
# learn a limit, and the delta is single-digit dollars a month.
MACHINE_TYPE="$(cfg gcp.machineType "e2-medium")"
BOOT_DISK_GB="50"
BOOT_DISK_TYPE="pd-balanced"

NETWORK="$(cfg gcp.network "${NAME}-vpc")"
SUBNET="$(cfg gcp.subnet "${NAME}-subnet")"
ROUTER="${NAME}-router"
NAT="${NAME}-nat"

# Dedicated identity. Sharing the default compute service account means any
# other host in the project can read this one's secrets, which defeats the
# point of separating hosts at all.
SA_NAME="${NAME}-vm"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

RELEASES_BUCKET="$(cfg gcp.releasesBucket)"
# Written by the VM, read by CI. Separate from the releases bucket so the
# customer-facing host cannot publish a release to itself: compromising the box
# gives no route to shipping code.
STATUS_BUCKET="$(cfg gcp.statusBucket)"

# Secrets share a prefix so `secretAccessor` can be bound PER SECRET. A
# project-wide grant behaves identically on day one and silently widens every
# time anyone adds a secret to the project.
SECRET_PREFIX="$(cfg gcp.secretPrefix "${NAME}")"
SECRETS=(
  "${SECRET_PREFIX}-slack-bot-token"
  "${SECRET_PREFIX}-slack-app-token"
  "${SECRET_PREFIX}-gateway-token"
  "${SECRET_PREFIX}-escalation-webhook"
  "${SECRET_PREFIX}-anthropic-api-key"
)

# The warehouse credential depends on which adapter is configured.
WAREHOUSE_ADAPTER="$(cfg warehouse.adapter)"
case "${WAREHOUSE_ADAPTER}" in
  snowflake) SECRETS+=("$(cfg warehouse.snowflake.privateKeySecret)") ;;
  mcp)       SECRETS+=("${SECRET_PREFIX}-mcp-api-key") ;;
  *)         die "unknown warehouse.adapter: ${WAREHOUSE_ADAPTER}" ;;
esac

# Pinned by digest, never by tag. A moving `:latest` is how a host ends up
# running an image nobody chose, on a restart nobody connected to the change.
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw}"
OPENCLAW_IMAGE_TAG="${OPENCLAW_IMAGE_TAG:-}"

require_project() {
  local active
  active="$(gcloud config get-value project 2>/dev/null || true)"
  if [[ "${active}" != "${PROJECT}" ]]; then
    note "setting active project to ${PROJECT} (was ${active:-unset})"
    gcloud config set project "${PROJECT}" >/dev/null
  fi
}

# Refuse a project-wide secret grant wherever we check for one. This is
# asserted rather than assumed because it is the kind of thing that gets added
# under time pressure and never removed.
assert_no_project_wide_secret_role() {
  local bindings
  bindings="$(gcloud projects get-iam-policy "${PROJECT}" \
    --flatten="bindings[].members" \
    --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:${SA_EMAIL}" \
    --format="value(bindings.role)" 2>/dev/null || true)"
  if [[ -n "${bindings}" ]]; then
    die "${SA_EMAIL} holds roles/secretmanager.secretAccessor at PROJECT level.
    That grant widens silently every time anyone adds a secret to this project.
    Remove it and re-run; these scripts bind the role per secret."
  fi
}
