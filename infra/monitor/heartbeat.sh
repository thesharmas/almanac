#!/usr/bin/env bash
# Daily heartbeat: post one line to the error channel saying the whole path
# still works.
#
# A monitoring channel that is silent when everything is fine is also silent
# when the monitoring itself has broken. One deliberate message a day is what
# distinguishes "nothing is wrong" from "nothing is watching".

set -euo pipefail

NAME="${ALMANAC_NAME:?ALMANAC_NAME is not set}"
WEBHOOK="$(gcloud secrets versions access latest --secret="${SECRET_PREFIX}-escalation-webhook" 2>/dev/null || true)"
[[ -n "${WEBHOOK}" ]] || exit 0

VERSION="$(cat "/opt/${NAME}/current/VERSION" 2>/dev/null || echo unknown)"
AGENTS="$(node -e "
  const map = require('/opt/${NAME}/current/generated/tenant-map.json');
  console.log(Object.keys(map).length);
" 2>/dev/null || echo '?')"

if curl -fsS --max-time 10 http://127.0.0.1:18789/health >/dev/null 2>&1; then
  STATUS="up"
else
  STATUS="DOWN"
fi

curl -fsS -X POST -H 'Content-Type: application/json' \
  --data "{\"text\":\"· heartbeat\ngateway ${STATUS} · version \`${VERSION}\` · ${AGENTS} tenant agent(s)\"}" \
  "${WEBHOOK}" >/dev/null || true
