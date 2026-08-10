import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";

import { loadReports, type Report } from "../catalog/load.js";
import { OPS_AGENT_ID } from "../catalog/ops-schema.js";
import { loadDeployment } from "../config/load.js";
import { createWarehouse } from "../warehouse/index.js";
import { ANNOUNCE_TOOL_NAME, createAnnounceTool } from "./announce-tool.js";
import { JsonAuditLogger } from "./audit.js";
import { createPostDigestTool, DIGEST_TOOL_NAME } from "./digest-tool.js";
import { WebhookEscalator, type Escalator } from "./escalate.js";
import { WebApiSlackPoster } from "./slack.js";
import type { TenantMap } from "./tenant.js";
import { createRunReportTool, TOOL_NAME } from "./tool.js";

/**
 * The Almanac plugin entry point.
 *
 * `registerTool` is given a **factory**, not a tool. That is what makes tenant
 * resolution possible: the Gateway invokes the factory with a trusted
 * `OpenClawPluginToolContext` carrying `agentId`, and the tool closes over that
 * `ctx` and reads it at execute time.
 *
 * Residual assumption, and the reason `/almanac-go-live` exists: the Gateway
 * must invoke this factory **per agent**. If it invoked once and shared the
 * tool, `ctx.agentId` would be either absent — caught by the fail-closed check
 * — or pinned to one agent, which is the dangerous case. A second staging
 * channel bound to a *different* tenant is what detects that, and it is a
 * go-live gate rather than a thing to assume.
 *
 * Deliberately absent: any registered tool that can send a message freely.
 * Escalation is a plugin-internal function; giving the model cross-channel
 * messaging would undo the "only speaks in its bound channel" property.
 */

export interface RuntimeConfig {
  readonly reportsDir: string;
  readonly tenantMap: TenantMap;
  readonly deploymentPath: string;
}

function loadTemplates(reports: ReadonlyMap<string, Report>): Map<string, string> {
  const templates = new Map<string, string>();
  for (const [id, report] of reports) {
    templates.set(id, readFileSync(join(report.dir, "query.sql"), "utf8"));
  }
  return templates;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const tenantMapPath = required(env, "ALMANAC_TENANT_MAP");
  return {
    reportsDir: required(env, "ALMANAC_REPORTS_DIR"),
    deploymentPath: required(env, "ALMANAC_DEPLOYMENT"),
    tenantMap: JSON.parse(readFileSync(tenantMapPath, "utf8")) as TenantMap,
  };
}

function buildEscalator(env: NodeJS.ProcessEnv): Escalator {
  return new WebhookEscalator({
    webhookUrl: required(env, "ALMANAC_ESCALATION_WEBHOOK"),
    // Escalation must never take down the turn that is reporting a problem.
    onFailure: (error) => {
      console.error("[almanac] escalation webhook failed", error);
    },
  });
}

export function register(api: OpenClawPluginApi): void {
  const env = process.env;
  const { reportsDir, tenantMap, deploymentPath } = loadRuntimeConfig(env);

  const deployment = loadDeployment(deploymentPath);
  const reports = loadReports(reportsDir);
  const templates = loadTemplates(reports);
  const warehouse = createWarehouse(deployment, env);
  const escalator = buildEscalator(env);
  const audit = new JsonAuditLogger();

  api.registerTool(
    (ctx) =>
      createRunReportTool(ctx, {
        deployment,
        reports,
        tenantMap,
        templates,
        executeSql: (sql) => warehouse.executeSql(sql),
        escalator,
        audit,
      }),
    // The name has to be declared twice over: here, and in `contracts.tools`
    // in almanac.plugin.json. Without the manifest entry the host rejects the
    // registration outright; without this option the registry records the
    // factory under no name, and a `tools.allow` allowlist naming the tool
    // logs "unknown entries" at every turn.
    { name: TOOL_NAME },
  );

  // The digest poster. Registered separately so it is visible in the tool
  // registry as its own capability rather than hidden inside the data tool.
  const slack = new WebApiSlackPoster({ botToken: required(env, "SLACK_BOT_TOKEN") });

  api.registerTool(
    (ctx) => createPostDigestTool(ctx, { tenantMap, slack, escalator, audit }),
    { name: DIGEST_TOOL_NAME },
  );

  // The operator broadcast, registered for the OPS AGENT ONLY.
  //
  // The factory returns null for every other agent, so a tenant agent does not
  // have this tool in its toolset at all. That is what keeps "an agent only
  // speaks in its own channel" true for every tenant agent while giving one
  // internal channel the ability to write outward.
  //
  // Read from a generated file rather than an env var, the same way the tenant
  // map is, so the deployed value is inspectable on the host. Absent or empty
  // means there is no ops channel and the tool is never registered.
  const opsChannelId = loadOpsChannel(env);
  if (opsChannelId !== "") {
    api.registerTool(
      (ctx) =>
        ctx.agentId === OPS_AGENT_ID
          ? createAnnounceTool(ctx, {
              tenantMap,
              opsChannelId,
              slack,
              escalator,
              audit,
            })
          : null,
      { name: ANNOUNCE_TOOL_NAME, optional: true },
    );
  }
}

/** The ops channel id, or "" when the feature is not configured. */
function loadOpsChannel(env: NodeJS.ProcessEnv): string {
  const path = env["ALMANAC_OPS_FILE"];
  if (path === undefined || path === "") return "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { channelId?: string };
    return (parsed.channelId ?? "").trim();
  } catch {
    // Absent is the normal case before ops.yaml exists. Failing the whole
    // plugin over an optional feature would take the data path down with it.
    return "";
  }
}

const plugin: OpenClawPluginDefinition = {
  id: "almanac",
  name: "Almanac",
  description: `Provides ${TOOL_NAME}, the only data path for Almanac tenant agents.`,
  register,
};

export default plugin;
