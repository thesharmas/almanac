import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadCatalog, type Catalog } from "../../src/catalog/load.js";
import { QUARANTINE_AGENT_ID } from "../../src/catalog/schema.js";
import { generateArtifacts } from "../../src/generator/artifacts.js";
import { checkInvariants, reportFamilyWarnings } from "../../src/generator/invariants.js";
import { FIXTURES, REPORTS_DIR, testDeployment } from "../helpers.js";

const deployment = testDeployment();

function catalog(opsPath?: string): Catalog {
  return loadCatalog({
    deployment,
    tenantsPath: join(FIXTURES, "tenants.yaml"),
    reportsDir: REPORTS_DIR,
    ...(opsPath === undefined ? {} : { opsPath }),
  });
}

function generate(c: Catalog = catalog()) {
  return generateArtifacts({ deployment, catalog: c, agentRoot: "/data/agents" });
}

describe("generated artifacts", () => {
  it("emits one agent per tenant, plus the fallback", () => {
    const ids = generate().openclaw.agents.list.map((a) => a.id);
    expect(ids).toContain(QUARANTINE_AGENT_ID);
    expect(ids).toContain("northwind");
    expect(ids).toContain("staging");
    expect(ids).toContain("staging_alt");
  });

  // Reaching the fallback at all means allowlist or binding drift, so it must
  // exist, must be the default, and must have nothing.
  it("makes the fallback the default agent with no tenant", () => {
    const artifacts = generate();
    const fallback = artifacts.openclaw.agents.list.find(
      (a) => a.id === QUARANTINE_AGENT_ID,
    );
    expect(fallback?.default).toBe(true);
    expect(artifacts.tenantMap[QUARANTINE_AGENT_ID]).toBeUndefined();
  });

  it("binds every channel by id, never by name", () => {
    for (const binding of generate().openclaw.bindings) {
      expect(binding.match.peer.id).toMatch(/^C[A-Z0-9]+$/);
    }
  });

  it("gives each agent its own workspace", () => {
    const workspaces = generate().openclaw.agents.list.map((a) => a.workspace);
    expect(new Set(workspaces).size).toBe(workspaces.length);
  });

  it("locks down the Slack channel policy", () => {
    const slack = generate().openclaw.channels.slack;
    expect(slack.mode).toBe("socket");
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.dmPolicy).toBe("disabled");
    expect(slack.contextVisibility).toBe("allowlist");
    expect(slack.requireMention).toBe(true);
  });

  it("denies the dangerous tool groups on every tenant agent", () => {
    for (const agent of generate().openclaw.agents.list) {
      const deny = (agent.tools["deny"] ?? []) as string[];
      expect(deny).toContain("group:fs");
      expect(deny).toContain("group:runtime");
      expect(deny).toContain("exec");
    }
  });

  it("pins the model with no fallback chain", () => {
    expect(generate().openclaw.agents.defaults.model).toBe("anthropic/claude-sonnet-5");
  });

  it("never writes a real gateway token into the config", () => {
    expect(generate().openclaw.gateway.auth.token).toBe("__ALMANAC_GATEWAY_TOKEN__");
  });

  describe("prompts", () => {
    it("lists exactly the reports a tenant is entitled to", () => {
      const prompt = generate().prompts["staging_alt"] ?? "";
      expect(prompt).toContain("Totals by business");
      expect(prompt).not.toContain("Fundings for a business");
    });

    it("names the tenant so its own name is not read as an entity", () => {
      const prompt = generate().prompts["northwind"] ?? "";
      expect(prompt).toContain("Northwind Traders");
    });

    it("uses the deployment's lexicon", () => {
      const prompt = generate().prompts["northwind"] ?? "";
      expect(prompt).toContain("businesses");
      expect(prompt).toContain("fundings");
    });

    it("tells the fallback agent to answer nothing", () => {
      expect(generate().prompts[QUARANTINE_AGENT_ID]).toContain("never answer questions");
    });
  });

  describe("automations", () => {
    it("names an explicit agent for every job", () => {
      for (const job of generate().automations) {
        expect(job.agentId).not.toBe(QUARANTINE_AGENT_ID);
        expect(job.agentId).not.toBe("");
      }
    });

    // The digest posts itself via post_digest, because a headline plus a
    // threaded reply is two messages. Leaving announce on would double-post.
    it("disables announce delivery", () => {
      for (const job of generate().automations) {
        expect(job.deliver.mode).toBe("none");
      }
    });

    it("prefixes job names with the deployment slug", () => {
      for (const job of generate().automations) {
        expect(job.name.startsWith("test:")).toBe(true);
      }
    });
  });

  describe("the ops agent", () => {
    it("is absent without ops.yaml", () => {
      const artifacts = generate();
      expect(artifacts.openclaw.agents.list.map((a) => a.id)).not.toContain("ops");
      expect(artifacts.ops).toEqual({});
    });

    it("appears with ops.yaml, and has no tenant", () => {
      const artifacts = generate(catalog(join(FIXTURES, "ops.yaml")));
      expect(artifacts.openclaw.agents.list.map((a) => a.id)).toContain("ops");
      expect(artifacts.tenantMap["ops"]).toBeUndefined();
      expect(artifacts.ops.channelId).toBe("C0OPSPRIV");
    });

    it("gets announce instead of the data tools", () => {
      const artifacts = generate(catalog(join(FIXTURES, "ops.yaml")));
      const ops = artifacts.openclaw.agents.list.find((a) => a.id === "ops");
      expect(ops?.tools["alsoAllow"]).toEqual(["announce"]);
    });
  });
});

describe("invariants", () => {
  it("pass for the fixture catalog", () => {
    const c = catalog();
    expect(checkInvariants(deployment, c, generate(c))).toEqual([]);
  });

  it("pass with the ops agent present", () => {
    const c = catalog(join(FIXTURES, "ops.yaml"));
    expect(checkInvariants(deployment, c, generate(c))).toEqual([]);
  });

  // An allowlisted channel with no binding falls through to the default agent
  // silently. This is the single most likely way a message reaches something
  // that was not meant to answer it.
  it("catch an allowlisted channel with no binding", () => {
    const c = catalog();
    const artifacts = generate(c);
    const broken = {
      ...artifacts,
      openclaw: {
        ...artifacts.openclaw,
        bindings: artifacts.openclaw.bindings.filter((b) => b.agentId !== "northwind"),
      },
    };
    const issues = checkInvariants(deployment, c, broken);
    expect(issues.map((i) => i.message).join()).toContain("no binding");
  });

  it("catch a binding to an agent with no tenant map entry", () => {
    const c = catalog();
    const artifacts = generate(c);
    const { northwind: _dropped, ...rest } = artifacts.tenantMap;
    const issues = checkInvariants(deployment, c, { ...artifacts, tenantMap: rest });
    expect(issues.map((i) => i.message).join()).toContain("no tenant map entry");
  });

  it("catch two bindings on one channel", () => {
    const c = catalog();
    const artifacts = generate(c);
    const first = artifacts.openclaw.bindings[0];
    if (first === undefined) throw new Error("fixture has no bindings");
    const issues = checkInvariants(deployment, c, {
      ...artifacts,
      openclaw: {
        ...artifacts.openclaw,
        bindings: [...artifacts.openclaw.bindings, { ...first, agentId: "staging" }],
      },
    });
    expect(issues.map((i) => i.message).join()).toContain("must bind to exactly one agent");
  });

  it("catch a missing fallback agent", () => {
    const c = catalog();
    const artifacts = generate(c);
    const issues = checkInvariants(deployment, c, {
      ...artifacts,
      openclaw: {
        ...artifacts.openclaw,
        agents: {
          ...artifacts.openclaw.agents,
          list: artifacts.openclaw.agents.list.filter(
            (a) => a.id !== QUARANTINE_AGENT_ID,
          ),
        },
      },
    });
    expect(issues.map((i) => i.message).join()).toContain("fallback");
  });

  it("check every report's SQL against the contract", () => {
    const c = catalog();
    // The fixture reports satisfy the contract, which is what makes the
    // negative cases in contract.test.ts meaningful.
    expect(checkInvariants(deployment, c, generate(c))).toEqual([]);
  });
});

describe("report families", () => {
  it("produce no warnings when nothing is superseded", () => {
    expect(reportFamilyWarnings(catalog())).toEqual([]);
  });
});
