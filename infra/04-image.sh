#!/usr/bin/env bash
# 04 — pin the container image. Runs ON THE VM.
#
# Pulls the OpenClaw image, resolves it to a DIGEST, and writes that digest
# where the deploy path reads it. Also saves a rescue tarball to the releases
# bucket.
#
# Pinning by digest rather than tag is the whole job. A moving `:latest` means
# an unrelated restart — an OOM kill, a host reboot at 3 a.m. — silently
# upgrades a customer-facing system to an image nobody chose and nobody
# reviewed. The rescue tarball exists because a pinned digest is only useful
# while the registry still has it.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

TAG="${1:-${OPENCLAW_IMAGE_TAG}}"
[[ -n "${TAG}" ]] || die "usage: 04-image.sh <tag>   (e.g. 2026.7.1-2)
    Pass an explicit version. Never 'latest' — that is the thing this script exists to prevent."
[[ "${TAG}" != "latest" ]] || die "refusing to pin 'latest'; pass a real version"

say "Pulling ${OPENCLAW_IMAGE}:${TAG}"
docker pull "${OPENCLAW_IMAGE}:${TAG}"

DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${OPENCLAW_IMAGE}:${TAG}")"
[[ -n "${DIGEST}" ]] || die "could not resolve a digest for ${OPENCLAW_IMAGE}:${TAG}"

say "Pinned"
note "${DIGEST}"
printf '%s\n' "${DIGEST}" > /opt/"${NAME}"/image-digest
printf '%s\n' "${TAG}" > /opt/"${NAME}"/image-tag

say "Rescue tarball -> gs://${RELEASES_BUCKET}/images/"
TARBALL="/tmp/openclaw-${TAG}.tar"
docker save "${OPENCLAW_IMAGE}:${TAG}" -o "${TARBALL}"
gzip -f "${TARBALL}"
gcloud storage cp "${TARBALL}.gz" "gs://${RELEASES_BUCKET}/images/openclaw-${TAG}.tar.gz"
rm -f "${TARBALL}.gz"

say "Done"
note "record OPENCLAW_IMAGE_TAG=${TAG} in deployment.yaml or the environment"
note "next: infra/05-secrets.sh, on your laptop"
