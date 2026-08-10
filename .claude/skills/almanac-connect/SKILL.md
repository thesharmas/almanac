---
name: almanac-connect
description: Prove an Almanac warehouse configuration is real by execution — connect, run a query, prove the role cannot write, and prove the tenant predicate actually isolates one tenant from another. Use after /almanac-init, after changing warehouse credentials or the tenant predicate, or when someone asks whether the connection or the isolation is set up correctly.
---

# Proving the connection

This skill exists because a role that was *meant* to be read-only and a role
that *is* read-only are different claims, and only one of them can be checked.

Everything here is proved by running something. If a check cannot be run, say
so plainly and hand it to the user — a skill that quietly does less than it
claims is worse than one that refuses.

Read `docs/why.md` §"The role is the containment boundary" first.

---

## Step 1 — Read the config

Read `deployment.yaml`. Note the adapter, the role, and the tenant predicate.
If there is no `deployment.yaml`, stop and point at `/almanac-init`.

## Step 2 — Connect and read

Run the simplest possible query through the configured adapter:

```sql
SELECT CURRENT_DATE() AS REPORTED_DATE, CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WH
```

Report what came back. Three things to check, and say each one explicitly:

- **The role is the one `deployment.yaml` names.** If the connection silently
  fell back to a default role, every permission conclusion below is about the
  wrong role.
- **`REPORTED_DATE` matches today's date in the reporting timezone.** If it
  does not, the session timezone has drifted and every window will be a day
  out. The shaper refuses in this case at runtime, which is correct — but
  finding out here is better than finding out in a channel.
- **The warehouse is the one configured**, so cost lands where they expect.

## Step 3 — Prove the role cannot write

**This is the check the skill exists for.** Attempt a write and require it to
fail:

```sql
CREATE TABLE ALMANAC_WRITE_PROBE_DELETE_ME (x INT)
```

- **It failed with a permission error** → the role is genuinely read-only. Say
  so, and quote the error.
- **It succeeded** → stop everything else and report it as the finding. The
  role has write access to the analytics schema, which means the containment
  boundary this deployment relies on does not exist. Drop the probe table
  immediately, tell them exactly which role, and do not continue until it is
  fixed.

Then try a second shape, because `CREATE` and `INSERT` can be granted
separately:

```sql
INSERT INTO <their fact table> SELECT * FROM <their fact table> WHERE 1=0
```

A permission error is the pass. Anything else is the finding.

If the adapter is `mcp`, run the same probes through it — the MCP server may
refuse them itself, which is also a pass, but say which layer refused so they
know what they are relying on.

## Step 4 — Prove the tenant predicate isolates

A predicate that parses is not a predicate that scopes.

Find two real tenant ids:

```sql
SELECT <tenant_column>, COUNT(*) AS N
FROM <table>
GROUP BY 1
ORDER BY 2 DESC
LIMIT 5
```

If there is only one tenant id in the data, say so — isolation cannot be
demonstrated on a single-tenant dataset, and that is a finding worth stating
rather than a check to skip.

Take the top two. Run the same aggregate for each, substituting only the tenant
id, and show the two results side by side:

```sql
SELECT COUNT(*) AS N, SUM(<amount_column>) AS TOTAL
FROM <table>
WHERE <tenant_predicate with tenant A>
  AND <date_column> BETWEEN <start> AND <end>
```

Three things must hold, and you must state each:

1. **The two results differ.** Identical totals for two tenants means the
   predicate is not filtering — check the column and the alias.
2. **Each is smaller than the unfiltered total.** Run the query with no tenant
   predicate and compare. If a scoped result equals the unscoped one, the
   predicate matched everything.
3. **They sum to no more than the unfiltered total.** If they exceed it, the
   tenant column is not what it appears to be — rows are being counted under
   more than one tenant, and a "tenant" here may be a grouping rather than a
   boundary.

## Step 5 — Prove a hostile entity value returns nothing

Only if `tenancy.entityPredicate` is configured.

The entity filter is the one value a model chooses. Its safety rests on the
tenant predicate still being ANDed, so demonstrate that:

```sql
-- with tenant A's id, and an entity name that belongs to tenant B
SELECT COUNT(*) AS N
FROM <table>
WHERE <tenant_predicate with tenant A>
  AND UPPER(<name_column>) LIKE UPPER('%<a name from tenant B>%')
```

**The answer must be 0.** If it is not, the entity predicate is reaching
outside the tenant scope, which is the one thing it must never do.

## Step 6 — Report

Write a short summary. For each check: what was run, what came back, pass or
fail. Do not soften a failure — the whole value of this skill is that it says
"this role can write" when the role can write.

If any check could not be run — no MCP connected, no second tenant, no
credentials to hand — list it explicitly under "not checked", with what the
user needs to do to check it themselves. Never let an unrun check read like a
passed one.

## Where this stops

At a report. It changes no config and fixes nothing. If it finds a role with
write access, the fix is a `GRANT`/`REVOKE` conversation with whoever
administers the warehouse — not something to do from here.
