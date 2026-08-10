#!/usr/bin/env bash
# Container entrypoint. Fetches secrets into the process environment and
# substitutes the gateway token into the generated config.
#
# NOTHING SECRET IS WRITTEN TO DISK. Secrets are fetched at start-up and live
# in the process environment only, so a snapshot of the container filesystem —
# or an image someone exports — carries no credentials.
#
# The one exception is the gateway token, which the Gateway can only read from
# its config file. It is substituted into a copy under /run (tmpfs), never back
# into the bundle, so it does not survive a restart and never reaches git.

set -euo pipefail

: "${ALMANAC_NAME:?ALMANAC_NAME is not set}"
: "${SECRET_PREFIX:?SECRET_PREFIX is not set}"

fetch() {
  gcloud secrets versions access latest --secret="$1" 2>/dev/null
}

export SLACK_BOT_TOKEN="$(fetch "${SECRET_PREFIX}-slack-bot-token")"
export SLACK_APP_TOKEN="$(fetch "${SECRET_PREFIX}-slack-app-token")"
export ANTHROPIC_API_KEY="$(fetch "${SECRET_PREFIX}-anthropic-api-key")"
export ALMANAC_ESCALATION_WEBHOOK="$(fetch "${SECRET_PREFIX}-escalation-webhook")"

GATEWAY_TOKEN="$(fetch "${SECRET_PREFIX}-gateway-token")"

# The warehouse credential, per adapter.
case "${WAREHOUSE_ADAPTER:-}" in
  snowflake)
    : "${SNOWFLAKE_KEY_SECRET:?SNOWFLAKE_KEY_SECRET is not set}"
    export ALMANAC_SNOWFLAKE_PRIVATE_KEY="$(fetch "${SNOWFLAKE_KEY_SECRET}")"
    ;;
  mcp)
    export ALMANAC_MCP_API_KEY="$(fetch "${SECRET_PREFIX}-mcp-api-key")"
    ;;
  *)
    echo "entrypoint: unknown WAREHOUSE_ADAPTER '${WAREHOUSE_ADAPTER:-}'" >&2
    exit 1
    ;;
esac

for var in SLACK_BOT_TOKEN SLACK_APP_TOKEN ANTHROPIC_API_KEY ALMANAC_ESCALATION_WEBHOOK; do
  if [[ -z "${!var}" ]]; then
    echo "entrypoint: ${var} came back empty from Secret Manager" >&2
    exit 1
  fi
done

# Substitute the gateway token into a copy on tmpfs.
mkdir -p /run/almanac
sed "s|__ALMANAC_GATEWAY_TOKEN__|${GATEWAY_TOKEN}|" \
  /app/generated/openclaw.json > /run/almanac/openclaw.json
unset GATEWAY_TOKEN

export ALMANAC_REPORTS_DIR="/app/reports"
export ALMANAC_TENANT_MAP="/app/generated/tenant-map.json"
export ALMANAC_OPS_FILE="/app/generated/ops.json"
export ALMANAC_DEPLOYMENT="/app/deployment.yaml"

exec openclaw gateway --config /run/almanac/openclaw.json "$@"
