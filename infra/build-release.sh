#!/usr/bin/env bash
# Build a release bundle. Runs on your laptop or in CI.
#
# Runs the full gate first and REFUSES to build if it fails, so a broken
# checkout cannot become a bundle. That is the point of doing it here rather
# than trusting CI to have run: the bundle is what reaches the VM, so the thing
# that produces the bundle is the right place for the last word.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VERSION="${1:-$(date -u +%Y%m%d-%H%M%S)}"
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

say "Gate: npm run check"
( cd "${REPO_ROOT}" && npm run check )

# The generator exits clean when there is no deployment.yaml, because that is
# the normal state of a fresh toolkit clone. Here it is not normal: a bundle
# with no generated config would deploy a Gateway with no agents and no
# bindings, and every channel would fall through to the fallback agent.
say "Checking the generated config exists"
[[ -f "${REPO_ROOT}/generated/openclaw.json" ]] || die \
  "generated/openclaw.json is missing. Run npm run generate — and if it said
    'no deployment.yaml', that is the real problem."
[[ -f "${REPO_ROOT}/generated/tenant-map.json" ]] || die "generated/tenant-map.json is missing"

say "Staging the bundle"
mkdir -p "${STAGING}/bundle"
cp -R "${REPO_ROOT}/dist"          "${STAGING}/bundle/dist"
cp -R "${REPO_ROOT}/generated"     "${STAGING}/bundle/generated"
cp -R "${REPO_ROOT}/reports"       "${STAGING}/bundle/reports"
cp    "${REPO_ROOT}/deployment.yaml" "${STAGING}/bundle/deployment.yaml"
cp    "${REPO_ROOT}/almanac.plugin.json" "${STAGING}/bundle/"
cp    "${REPO_ROOT}/package.json"  "${STAGING}/bundle/"
cp -R "${REPO_ROOT}/infra"         "${STAGING}/bundle/infra"

# The archetypes are templates with deliberately incomplete SQL. They are not
# reports and must never reach a host that might try to load one.
rm -rf "${STAGING}/bundle/reports/_archetypes"

printf '%s\n' "${VERSION}" > "${STAGING}/bundle/VERSION"

say "Packing"
BUNDLE="${STAGING}/${NAME}-${VERSION}.tar.gz"
tar -C "${STAGING}/bundle" -czf "${BUNDLE}" .
CHECKSUM="$(shasum -a 256 "${BUNDLE}" | awk '{print $1}')"
printf '%s\n' "${CHECKSUM}" > "${BUNDLE}.sha256"

say "Publishing to gs://${RELEASES_BUCKET}"
gcloud storage cp "${BUNDLE}"        "gs://${RELEASES_BUCKET}/releases/"
gcloud storage cp "${BUNDLE}.sha256" "gs://${RELEASES_BUCKET}/releases/"

# Written LAST. The poller reads this file to decide what to deploy, so
# publishing it before the bundle would point the VM at something that is not
# there yet.
printf '%s\n' "${VERSION}" | gcloud storage cp - "gs://${RELEASES_BUCKET}/DESIRED_VERSION"

say "Published ${VERSION}"
note "sha256 ${CHECKSUM}"
note "the VM's poller will pick this up within a minute"
