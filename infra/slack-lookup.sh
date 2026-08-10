#!/usr/bin/env bash
# Resolve a Slack channel by name, or verify membership of one by id.
#
#   ./slack-lookup.sh channel "Northwind Traders"
#   ./slack-lookup.sh verify C0000000000
#
# Used during onboarding, and by /almanac-add-tenant.
#
# The name search squashes case and separators, so "Northwind Traders" finds
# "#ext-customer-northwind-traders". That matters because the person onboarding
# knows the partner's name, not the channel's.
#
# Exit codes are the interface — do not skim the output for a C… and move on:
#
#   0  exactly one match
#   3  several matched; the caller must choose, never guess
#   4  nothing matched
#   1  could not ask Slack
#
# THE BOT DOES NOT NEED TO BE IN THE CHANNEL YET, and usually should not be.
# Inviting it is a customer-visible act, and a bot that joins before the config
# entitles it answers mentions with the fallback agent in front of that
# customer. The invite is the last step of go-live. Membership is reported as a
# field so you can see it; "not a member" is the expected state here.

set -euo pipefail

TOKEN="${SLACK_BOT_TOKEN:-}"
if [[ -z "${TOKEN}" ]]; then
  PREFIX="${SECRET_PREFIX:-almanac}"
  TOKEN="$(gcloud secrets versions access latest --secret="${PREFIX}-slack-bot-token" 2>/dev/null || true)"
fi
[[ -n "${TOKEN}" ]] || { echo "no SLACK_BOT_TOKEN, and none in Secret Manager" >&2; exit 1; }

api() {
  curl -fsS -H "Authorization: Bearer ${TOKEN}" "https://slack.com/api/$1" 2>/dev/null
}

case "${1:-}" in
  verify)
    ID="${2:?usage: slack-lookup.sh verify <channel-id>}"
    RESPONSE="$(api "conversations.info?channel=${ID}")" || { echo "could not reach Slack" >&2; exit 1; }
    node -e "
      const r = JSON.parse(process.argv[1]);
      if (!r.ok) { console.error('slack said: ' + r.error); process.exit(4); }
      const c = r.channel;
      console.log([
        c.name ? '#' + c.name : '(no name)',
        c.id,
        c.is_private ? 'private' : 'PUBLIC',
        c.is_ext_shared ? 'slack-connect' : 'internal',
        c.is_member ? 'member' : 'NOT a member',
      ].join('  '));
    " "${RESPONSE}"
    ;;

  channel)
    QUERY="${2:?usage: slack-lookup.sh channel <name>}"
    RESPONSE="$(api "conversations.list?types=public_channel,private_channel&limit=1000&exclude_archived=true")" \
      || { echo "could not reach Slack" >&2; exit 1; }

    node -e "
      const r = JSON.parse(process.argv[1]);
      if (!r.ok) { console.error('slack said: ' + r.error); process.exit(1); }
      // Squash case and separators on both sides, so a partner name finds a
      // channel named after them however it was punctuated.
      const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const needle = squash(process.argv[2]);
      const matches = r.channels.filter((c) => squash(c.name).includes(needle));

      for (const c of matches) {
        console.log([
          '#' + c.name,
          c.id,
          c.is_private ? 'private' : 'PUBLIC',
          c.is_ext_shared ? 'slack-connect' : 'internal',
          c.is_member ? 'member' : 'NOT a member',
        ].join('  '));
      }

      if (matches.length === 0) { console.error('no channel matched'); process.exit(4); }
      if (matches.length > 1) { console.error(matches.length + ' matched — choose one'); process.exit(3); }
    " "${RESPONSE}" "${QUERY}"
    ;;

  *)
    echo "usage: slack-lookup.sh channel <name> | verify <channel-id>" >&2
    exit 1
    ;;
esac
