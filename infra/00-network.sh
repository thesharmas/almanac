#!/usr/bin/env bash
# 00 — the network. Runs on your laptop.
#
# Creates the VPC, subnet, Cloud NAT and IAP SSH rule the VM needs. Every later
# script REFUSES to run if any of these is missing, rather than helpfully
# creating a second network under a name it guessed — two VPCs that differ by a
# character is a bad afternoon.
#
# Skip this entirely if your org already has a VPC you should be using: set
# `gcp.network` and `gcp.subnet` in deployment.yaml to the existing names and
# go straight to 01.
#
# THE VM HAS NO EXTERNAL IP. That is the single most valuable thing here.
# Egress goes through Cloud NAT, admin access through IAP SSH, and the Control
# UI over the tailnet. There is no inbound path from the internet to the box at
# all, which removes an entire category of exposure rather than defending
# against it.
#
# Idempotent; safe to re-run.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
require_project

SUBNET_RANGE="${SUBNET_RANGE:-10.10.0.0/24}"

say "Enabling the APIs these scripts need"
gcloud services enable \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  iap.googleapis.com \
  storage.googleapis.com

say "VPC: ${NETWORK}"
if gcloud compute networks describe "${NETWORK}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud compute networks create "${NETWORK}" --subnet-mode=custom
fi

say "Subnet: ${SUBNET} (${SUBNET_RANGE} in ${REGION})"
if gcloud compute networks subnets describe "${SUBNET}" --region="${REGION}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud compute networks subnets create "${SUBNET}" \
    --network="${NETWORK}" \
    --region="${REGION}" \
    --range="${SUBNET_RANGE}" \
    --enable-private-ip-google-access
fi

say "Cloud Router and NAT — the only egress path"
if gcloud compute routers describe "${ROUTER}" --region="${REGION}" >/dev/null 2>&1; then
  note "router already exists"
else
  gcloud compute routers create "${ROUTER}" \
    --network="${NETWORK}" \
    --region="${REGION}"
fi

if gcloud compute routers nats describe "${NAT}" --router="${ROUTER}" --region="${REGION}" >/dev/null 2>&1; then
  note "nat already exists"
else
  gcloud compute routers nats create "${NAT}" \
    --router="${ROUTER}" \
    --region="${REGION}" \
    --auto-allocate-nat-external-ips \
    --nat-all-subnet-ip-ranges
fi

# 35.235.240.0/20 is Google's IAP forwarding range. Allowing SSH from there and
# nowhere else means admin access is authenticated by IAM rather than by
# knowing an IP.
say "Firewall: IAP SSH only"
if gcloud compute firewall-rules describe "allow-iap-ssh-${NAME}" >/dev/null 2>&1; then
  note "already exists"
else
  gcloud compute firewall-rules create "allow-iap-ssh-${NAME}" \
    --network="${NETWORK}" \
    --allow=tcp:22 \
    --source-ranges=35.235.240.0/20 \
    --description="SSH via IAP only; the VM has no external IP"
fi

say "Done"
note "network ${NETWORK}, subnet ${SUBNET}, NAT ${NAT}"
note "next: infra/01-project-prereqs.sh"
