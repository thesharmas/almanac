#!/usr/bin/env bash
# 08 — the deploy poller. Runs ON THE VM.
#
# THE VM PULLS; CI NEVER PUSHES. CI writes a bundle and a DESIRED_VERSION file
# to a bucket, and this timer notices. That is what lets the host keep no
# external IP and no inbound path: there is nothing for CI to connect to.
#
# The poller holds off within 15 minutes of a scheduled digest rather than
# restarting the Gateway underneath one. A digest interrupted mid-flight is a
# half-posted message in a customer channel, which is worse than a deploy that
# waits a quarter of an hour.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[[ "$(id -u)" -eq 0 ]] || die "run this with sudo, on the VM"

UNITS="$(dirname "${BASH_SOURCE[0]}")/autodeploy"

say "Installing the poller"
sed "s/{{NAME}}/${NAME}/g; s|{{BUCKET}}|${RELEASES_BUCKET}|g" "${UNITS}/poll.sh" \
  > /usr/local/bin/"${NAME}"-poll
chmod 0755 /usr/local/bin/"${NAME}"-poll

sed "s/{{NAME}}/${NAME}/g" "${UNITS}/poll.service" > /etc/systemd/system/"${NAME}"-poll.service
sed "s/{{NAME}}/${NAME}/g" "${UNITS}/poll.timer"   > /etc/systemd/system/"${NAME}"-poll.timer

systemctl daemon-reload
systemctl enable --now "${NAME}"-poll.timer

say "Done"
note "merging to main now deploys within about a minute"
note "watch it: journalctl -u ${NAME}-poll -f"
