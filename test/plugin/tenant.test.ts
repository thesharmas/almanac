import { describe, expect, it } from "vitest";

import {
  conversationId,
  isEntitled,
  resolveTenant,
  type TenantMap,
} from "../../src/plugin/tenant.js";

/**
 * The isolation boundary. Every test here is a way a wrong answer could reach
 * the wrong channel if resolution defaulted instead of refusing.
 */

const MAP: TenantMap = {
  northwind: {
    tenantId: "11111111-1111-1111-1111-111111111111",
    channelId: "C0NWIND",
    reports: ["totals_by_entity"],
  },
  contoso: {
    tenantId: "22222222-2222-2222-2222-222222222222",
    channelId: "C0CONTOSO",
    reports: ["totals_by_entity", "records_by_entity"],
  },
};

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "northwind",
    messageChannel: "slack",
    deliveryContext: { to: "channel:C0NWIND" },
    ...overrides,
  } as Parameters<typeof resolveTenant>[0];
}

describe("tenant resolution", () => {
  it("resolves an agent bound to its own channel", () => {
    const result = resolveTenant(ctx(), MAP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tenant.tenantId).toBe("11111111-1111-1111-1111-111111111111");
    }
  });

  // No default tenant, and no "if there is only one, use it".
  it("refuses when agentId is absent", () => {
    const result = resolveTenant(ctx({ agentId: undefined }), MAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_agent_id");
  });

  it("refuses when agentId is empty", () => {
    const result = resolveTenant(ctx({ agentId: "" }), MAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_agent_id");
  });

  it("refuses an agent not in the map", () => {
    const result = resolveTenant(ctx({ agentId: "unknown" }), MAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_agent");
  });

  it("refuses even when the map has exactly one entry", () => {
    const single: TenantMap = { northwind: MAP["northwind"] as TenantMap[string] };
    const result = resolveTenant(ctx({ agentId: "somebody_else" }), single);
    expect(result.ok).toBe(false);
  });

  // A prototype key must not resolve to a usable value.
  it.each(["constructor", "__proto__", "toString"])("refuses the prototype key %s", (key) => {
    const result = resolveTenant(ctx({ agentId: key }), MAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_agent");
  });

  describe("channel binding", () => {
    // Config or routing drift that bound a channel to the wrong agent becomes
    // a loud refusal rather than a quiet cross-tenant read.
    it("refuses a turn from a channel the agent is not bound to", () => {
      const result = resolveTenant(
        ctx({ deliveryContext: { to: "channel:C0CONTOSO" } }),
        MAP,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("channel_mismatch");
    });

    // The prefix has to come off before comparing, or every real Slack turn is
    // refused for arriving from the very channel it is bound to.
    it("strips the provider prefix before comparing", () => {
      expect(resolveTenant(ctx({ deliveryContext: { to: "channel:C0NWIND" } }), MAP).ok).toBe(
        true,
      );
      expect(resolveTenant(ctx({ deliveryContext: { to: "C0NWIND" } }), MAP).ok).toBe(true);
    });

    // Some surfaces supply no conversation id. A secondary check that cannot
    // be evaluated must not veto a turn the primary control already permitted.
    it("permits a turn with no conversation id", () => {
      expect(resolveTenant(ctx({ deliveryContext: undefined }), MAP).ok).toBe(true);
      expect(resolveTenant(ctx({ deliveryContext: { to: "" } }), MAP).ok).toBe(true);
    });
  });
});

describe("conversationId", () => {
  it.each([
    ["channel:C123", "C123"],
    ["user:U123", "U123"],
    ["C123", "C123"],
    // Matrix room ids contain further colons; splitting on the last would
    // corrupt them.
    ["room:!abc:server.example", "!abc:server.example"],
  ])("%s -> %s", (input, expected) => {
    expect(conversationId(input)).toBe(expected);
  });

  it("returns undefined for absent or empty targets", () => {
    expect(conversationId(undefined)).toBeUndefined();
    expect(conversationId("")).toBeUndefined();
  });
});

describe("entitlement", () => {
  it("permits an entitled report", () => {
    const tenant = MAP["northwind"] as TenantMap[string];
    expect(isEntitled(tenant, "totals_by_entity")).toBe(true);
  });

  // The parameter enum is global; entitlement is per tenant. A report existing
  // is not a report this channel may ask for.
  it("refuses a report this tenant is not entitled to", () => {
    const tenant = MAP["northwind"] as TenantMap[string];
    expect(isEntitled(tenant, "records_by_entity")).toBe(false);
  });
});
