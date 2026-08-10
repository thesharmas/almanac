# Reaching the Control UI

The VM has no external IP. That is deliberate and it is the single most
valuable property of this setup — there is no inbound path from the internet to
the box, so an entire category of exposure is absent rather than defended
against.

It also means the Control UI needs a way in that is not a port.

## `serve`, never `funnel`

```bash
tailscale serve --bg 18789
```

`tailscale serve` publishes to your **tailnet**. `tailscale funnel` publishes to
the **public internet**. The commands differ by one word and the exposure model
differs completely — funnel would put an authenticated admin surface for a
customer-facing system on the open web, reachable by anyone who learns the
hostname.

There is no case in this deployment where funnel is the right answer.

## Tag the node, do not attach it to a person

Join with an auth key carrying a tag:

```bash
tailscale up --authkey=tskey-auth-... --advertise-tags=tag:almanac
```

A node joined under someone's personal account inherits that person's ACLs and
disappears from the tailnet when they leave the company. A tagged node is
governed by policy, which is what you want for a server.

## A minimal ACL

In the tailnet policy file:

```jsonc
{
  "tagOwners": {
    // Who may create nodes with this tag.
    "tag:almanac": ["group:platform"],
  },
  "acls": [
    // Only the platform group reaches the Control UI, and only on its port.
    {
      "action": "accept",
      "src": ["group:platform"],
      "dst": ["tag:almanac:18789"],
    },
  ],
  "ssh": [
    // Tailscale SSH is deliberately NOT enabled for this node. Admin access is
    // IAP SSH, which is authenticated by IAM and logged by Cloud Audit Logs.
    // Two admin paths means two things to review and two to revoke.
  ],
}
```

## Admin access is IAP, not Tailscale SSH

```bash
gcloud compute ssh <vm> --zone=<zone> --tunnel-through-iap
```

IAM decides who can do this, and Cloud Audit Logs record that they did. Adding
Tailscale SSH alongside it would create a second admin path with a different
access list — one more thing to keep in step, and one more to remember to
revoke.
