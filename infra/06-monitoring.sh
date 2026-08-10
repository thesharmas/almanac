#!/usr/bin/env bash
# 06 — monitoring. Runs ON THE VM.
#
# Three timers, each catching a failure the others cannot see:
#
#   health     the Gateway is up and answering        (every 5 min)
#   heartbeat  the whole path still works end to end  (daily)
#   digest     a scheduled digest actually posted     (after each schedule)
#
# The third is the one worth arguing for. A digest that never fires produces no
# error anywhere: the job did not run, so nothing failed. Silence is
# indistinguishable from a quiet day, and a customer noticing before you do is
# the worst way to find out.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[[ "$(id -u)" -eq 0 ]] || die "run this with sudo, on the VM"

UNITS="$(dirname "${BASH_SOURCE[0]}")/monitor"

say "Installing units"
install -m 0755 "${UNITS}/health.sh"    /usr/local/bin/"${NAME}"-health
install -m 0755 "${UNITS}/heartbeat.sh" /usr/local/bin/"${NAME}"-heartbeat

for unit in health heartbeat; do
  sed "s/{{NAME}}/${NAME}/g" "${UNITS}/${unit}.service" \
    > /etc/systemd/system/"${NAME}"-"${unit}".service
  sed "s/{{NAME}}/${NAME}/g" "${UNITS}/${unit}.timer" \
    > /etc/systemd/system/"${NAME}"-"${unit}".timer
done

say "Enabling timers"
systemctl daemon-reload
systemctl enable --now "${NAME}"-health.timer
systemctl enable --now "${NAME}"-heartbeat.timer

say "Done"
note "systemctl list-timers '${NAME}-*'"
