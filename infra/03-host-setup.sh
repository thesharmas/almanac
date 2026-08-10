#!/usr/bin/env bash
# 03 — host setup. Runs ON THE VM.
#
#   gcloud compute ssh <vm> --zone=<zone> --tunnel-through-iap
#
# Installs Docker, joins the tailnet, and lays out the deployment directories.
#
# Tailscale is how you reach the Control UI on a box with no external IP. Use
# `tailscale serve` (tailnet-only), never `tailscale funnel` (public internet).
# The difference is one word and the whole exposure model.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[[ "$(id -u)" -eq 0 ]] || die "run this with sudo, on the VM"

say "Docker"
if command -v docker >/dev/null 2>&1; then
  note "already installed"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

say "Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  note "already installed"
else
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if tailscale status >/dev/null 2>&1; then
  note "already joined the tailnet"
else
  note "join with an auth key that has a TAG, so this node's ACL is a policy"
  note "rather than a person's account:"
  note ""
  note "  tailscale up --authkey=tskey-auth-... --advertise-tags=tag:${NAME}"
  note ""
  note "then re-run this script. See infra/tailscale-acl.md."
fi

say "Deployment directories"
install -d -m 0755 /opt/"${NAME}"
install -d -m 0755 /opt/"${NAME}"/releases
install -d -m 0755 /opt/"${NAME}"/current
# The Gateway's state: sessions, SQLite, per-agent workspaces.
install -d -m 0700 /data
install -d -m 0700 /data/agents

say "Done"
note "next: infra/04-image.sh, on this VM"
