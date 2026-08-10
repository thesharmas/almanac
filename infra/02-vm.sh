#!/usr/bin/env bash
# 02 — the VM. Runs on your laptop. First billable resource.
#
# Refuses to run if the network is missing rather than creating one. Two VPCs
# whose names differ by a character is a genuinely bad afternoon, and the
# failure mode is silent: everything comes up, nothing can talk to anything.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
require_project

say "Checking the network exists"
for check in \
  "networks describe ${NETWORK}" \
  "networks subnets describe ${SUBNET} --region=${REGION}" \
  "routers describe ${ROUTER} --region=${REGION}"
do
  # shellcheck disable=SC2086
  gcloud compute ${check} >/dev/null 2>&1 || die \
    "missing network resource (${check}). Run infra/00-network.sh first, or point
    gcp.network / gcp.subnet in deployment.yaml at the VPC you mean to use."
done
note "ok"

say "VM: ${VM_NAME} (${MACHINE_TYPE}, no external IP)"
if gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" >/dev/null 2>&1; then
  note "already exists — nothing to do"
  exit 0
fi

# --no-address is the important flag. Everything else is sizing.
gcloud compute instances create "${VM_NAME}" \
  --zone="${ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --subnet="${SUBNET}" \
  --no-address \
  --boot-disk-size="${BOOT_DISK_GB}GB" \
  --boot-disk-type="${BOOT_DISK_TYPE}" \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --service-account="${SA_EMAIL}" \
  --scopes=cloud-platform \
  --shielded-secure-boot \
  --shielded-vtpm \
  --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE \
  --labels="app=${NAME}"

say "Done"
note "ssh in with:  gcloud compute ssh ${VM_NAME} --zone=${ZONE} --tunnel-through-iap"
note "next: copy infra/ to the VM and run 03-host-setup.sh there"
