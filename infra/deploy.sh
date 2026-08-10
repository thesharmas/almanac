#!/usr/bin/env bash
# Deploy a release bundle. Runs ON THE VM.
#
#   ./deploy.sh <version>     deploy a named version
#   ./deploy.sh --rollback    go back to the previous release
#
# Order matters, and the order is:
#
#   fetch -> VERIFY CHECKSUM -> unpack -> swap -> restart -> reconcile
#
# The checksum is verified BEFORE unpacking. Unpacking first and checking
# afterwards means a corrupt or tampered bundle has already written files to
# the host by the time you find out.
#
# Automations are reconciled AFTER the restart, because the reconciler talks to
# the running Gateway — reconciling against the old process would write jobs
# referencing agents the new config may not have.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROOT="/opt/${NAME}"
CURRENT="${ROOT}/current"
RELEASES="${ROOT}/releases"
PREVIOUS_FILE="${ROOT}/previous-version"

restart_gateway() {
  say "Restarting the Gateway"
  ( cd "${CURRENT}" && docker compose up -d --force-recreate )
  # Give it a moment to bind before anything talks to it.
  sleep 5
}

reconcile() {
  say "Reconciling automations"
  "${CURRENT}/infra/reconcile-automations.sh"
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -f "${PREVIOUS_FILE}" ]] || die "no previous version recorded; nothing to roll back to"
  VERSION="$(cat "${PREVIOUS_FILE}")"
  say "Rolling back to ${VERSION}"
  [[ -d "${RELEASES}/${VERSION}" ]] || die "release ${VERSION} is no longer on disk"
  ln -sfn "${RELEASES}/${VERSION}" "${CURRENT}"
  restart_gateway
  reconcile
  say "Rolled back to ${VERSION}"
  exit 0
fi

VERSION="${1:-}"
[[ -n "${VERSION}" ]] || die "usage: deploy.sh <version> | --rollback"

if [[ -d "${RELEASES}/${VERSION}" ]]; then
  note "release ${VERSION} is already unpacked; re-swapping to it"
else
  say "Fetching ${VERSION}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  gcloud storage cp "gs://${RELEASES_BUCKET}/releases/${NAME}-${VERSION}.tar.gz" "${TMP}/"
  gcloud storage cp "gs://${RELEASES_BUCKET}/releases/${NAME}-${VERSION}.tar.gz.sha256" "${TMP}/"

  say "Verifying the checksum BEFORE unpacking"
  EXPECTED="$(cat "${TMP}/${NAME}-${VERSION}.tar.gz.sha256")"
  ACTUAL="$(shasum -a 256 "${TMP}/${NAME}-${VERSION}.tar.gz" | awk '{print $1}')"
  [[ "${EXPECTED}" == "${ACTUAL}" ]] || die \
    "checksum mismatch. expected ${EXPECTED}, got ${ACTUAL}. NOTHING has been unpacked."
  note "ok"

  say "Unpacking"
  mkdir -p "${RELEASES}/${VERSION}"
  tar -C "${RELEASES}/${VERSION}" -xzf "${TMP}/${NAME}-${VERSION}.tar.gz"
fi

# Record where we are before moving, so rollback has somewhere to go.
if [[ -L "${CURRENT}" ]]; then
  basename "$(readlink -f "${CURRENT}")" > "${PREVIOUS_FILE}"
fi

say "Swapping ${CURRENT} -> ${VERSION}"
ln -sfn "${RELEASES}/${VERSION}" "${CURRENT}"

restart_gateway
reconcile

# Report outward, to the bucket CI reads. The VM cannot write to the releases
# bucket, so this is a one-way channel by construction.
printf '{"version":"%s","at":"%s","ok":true}\n' \
  "${VERSION}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | gcloud storage cp - "gs://${STATUS_BUCKET}/last-deploy.json"

say "Deployed ${VERSION}"
note "roll back with: ./deploy.sh --rollback"
