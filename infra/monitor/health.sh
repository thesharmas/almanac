#!/usr/bin/env bash
# Is the Gateway up and answering? Every 5 minutes.
#
# Deliberately shallow: this checks the process is alive and serving, nothing
# more. A deep check that queries the warehouse would page somebody at 3 a.m.
# for a warehouse maintenance window that will clear itself, and an alarm that
# cries wolf is worse than no alarm.

set -euo pipefail

NAME="${ALMANAC_NAME:?ALMANAC_NAME is not set}"
WEBHOOK="$(gcloud secrets versions access latest --secret="${SECRET_PREFIX}-escalation-webhook" 2>/dev/null || true)"
STATE="/var/lib/${NAME}/health-state"
mkdir -p "$(dirname "${STATE}")"

alert() {
  [[ -n "${WEBHOOK}" ]] || return 0
  curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "{\"text\":\"🔴 *health_check_failure*\n$1\nhost: \`$(hostname)\`\"}" \
    "${WEBHOOK}" >/dev/null || true
}

if curl -fsS --max-time 10 http://127.0.0.1:18789/health >/dev/null 2>&1; then
  # Only announce recovery if we had previously reported a failure — otherwise
  # a healthy system posts nothing at all, which is the point.
  if [[ -f "${STATE}" ]]; then
    rm -f "${STATE}"
    [[ -n "${WEBHOOK}" ]] && curl -fsS -X POST -H 'Content-Type: application/json' \
      --data "{\"text\":\"· recovered\nthe Gateway is answering again on \`$(hostname)\`\"}" \
      "${WEBHOOK}" >/dev/null || true
  fi
  exit 0
fi

# Two consecutive failures before alerting: a single miss during a deploy
# restart is expected, and paging on it trains people to ignore the channel.
if [[ -f "${STATE}" ]]; then
  alert "the Gateway has failed its health check twice in a row"
else
  touch "${STATE}"
fi
