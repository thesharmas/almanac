#!/usr/bin/env bash
# Deploy poller. Installed by infra/08-autodeploy.sh; runs every 60 seconds.
#
# Reads DESIRED_VERSION from the releases bucket and deploys it if it differs
# from what is running. Rolls back and reports on failure.

set -euo pipefail

NAME="{{NAME}}"
BUCKET="{{BUCKET}}"
ROOT="/opt/${NAME}"
CURRENT="${ROOT}/current"

log() { printf '%s poll: %s\n' "$(date -u +%H:%M:%S)" "$*"; }

DESIRED="$(gcloud storage cat "gs://${BUCKET}/DESIRED_VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
[[ -n "${DESIRED}" ]] || { log "no DESIRED_VERSION; nothing to do"; exit 0; }

RUNNING="$(cat "${CURRENT}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo none)"
[[ "${DESIRED}" != "${RUNNING}" ]] || exit 0

log "desired ${DESIRED}, running ${RUNNING}"

# Hold off near a scheduled digest. Restarting the Gateway underneath one
# produces a half-posted message in a customer channel; waiting produces a
# deploy that lands fifteen minutes later, which nobody notices.
if [[ -f "${CURRENT}/generated/automations.json" ]]; then
  MINUTES_AWAY="$(node -e "
    const { CronExpressionParser } = require('${CURRENT}/node_modules/cron-parser');
    const jobs = require('${CURRENT}/generated/automations.json');
    const now = Date.now();
    let soonest = Infinity;
    for (const job of jobs) {
      try {
        const next = CronExpressionParser.parse(job.cron, { tz: job.tz }).next().toDate().getTime();
        soonest = Math.min(soonest, (next - now) / 60000);
      } catch {}
    }
    console.log(Number.isFinite(soonest) ? Math.round(soonest) : 9999);
  " 2>/dev/null || echo 9999)"

  if [[ "${MINUTES_AWAY}" -lt 15 ]]; then
    log "a digest fires in ${MINUTES_AWAY} min; holding off"
    exit 0
  fi
fi

log "deploying ${DESIRED}"
if "${CURRENT}/infra/deploy.sh" "${DESIRED}"; then
  log "deployed ${DESIRED}"
else
  log "DEPLOY FAILED; rolling back"
  "${CURRENT}/infra/deploy.sh" --rollback || log "rollback ALSO failed"

  WEBHOOK="$(gcloud secrets versions access latest --secret="${NAME}-escalation-webhook" 2>/dev/null || true)"
  [[ -n "${WEBHOOK}" ]] && curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "{\"text\":\"🔴 *tool_failure*\ndeploy of \`${DESIRED}\` failed on \`$(hostname)\`; rolled back to \`${RUNNING}\`\"}" \
    "${WEBHOOK}" >/dev/null || true
  exit 1
fi
