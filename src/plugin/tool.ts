import { Type } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

import type { Report } from "../catalog/load.js";
import { DATE_RANGES, type DateRange } from "../catalog/schema.js";
import type { Deployment } from "../config/load.js";
import { MAX_LAST_N_DAYS } from "../config/schema.js";
import { expectedReportedDate, resolveDateRange, timezoneLabel } from "../reports/date-range.js";
import { renderTemplate } from "../reports/render.js";
import { shapeResult, type ReportPayload } from "../reports/shape.js";
import { WarehouseError, type QueryResult } from "../warehouse/types.js";
import { buildAuditRecord, type AuditLogger } from "./audit.js";
import type { Escalator } from "./escalate.js";
import { isEntitled, resolveTenant, type TenantMap } from "./tenant.js";

export const TOOL_NAME = "run_report";

/**
 * The only data tool a tenant agent is given.
 *
 * Registered as a **factory**, so `agentId` arrives on the trusted
 * `OpenClawPluginToolContext`. `ctx` is read inside `execute`, never captured
 * at factory time — otherwise every tenant would see whichever tenant happened
 * to be resolved when the factory first ran.
 *
 * Every failure path does the same three things: audit, escalate, and return a
 * calm sentence that reveals nothing. The customer never sees an error class,
 * a tenant id, a SQL fragment, or an acknowledgement that other tenants exist.
 */

export interface ToolDeps {
  readonly deployment: Deployment;
  readonly reports: ReadonlyMap<string, Report>;
  readonly tenantMap: TenantMap;
  readonly templates: ReadonlyMap<string, string>;
  readonly executeSql: (sql: string) => Promise<QueryResult>;
  readonly escalator: Escalator;
  readonly audit: AuditLogger;
  readonly now?: () => Date;
}

export interface RefusalDetails {
  readonly refused: true;
  readonly reason: string;
}

/**
 * Matches OpenClaw's `AgentToolResult`, where `details` is **required**.
 *
 * OpenClaw documents "throw on failure instead of encoding errors in content".
 * Almanac deliberately does the opposite for both refusals and tool failures:
 * the customer-facing sentence must be one we chose exactly. Throwing would
 * hand the model an exception to paraphrase, and a model improvising around a
 * failed data call is precisely how an invented number reaches a customer.
 */
export interface ToolResult {
  readonly content: { type: "text"; text: string }[];
  readonly details: ReportPayload | RefusalDetails;
}

/** The closed parameter schema. Nothing free-form. */
export function buildParameters(reportIds: readonly string[], deployment: Deployment) {
  const entity = deployment.lexicon.entity;
  return Type.Object(
    {
      report: Type.Union(
        reportIds.map((id) => Type.Literal(id)),
        { description: "Which report to run." },
      ),
      dateRange: Type.Union(
        DATE_RANGES.map((r) => Type.Literal(r)),
        {
          description:
            `Which window to report on. Dates are ${deployment.reporting.timezone}. ` +
            "Use last_n_days with `days` for anything the named windows do not cover.",
        },
      ),
      entity: Type.Optional(
        Type.String({
          minLength: 2,
          maxLength: 120,
          description:
            `Name, or part of a name, of one of this channel's own ${deployment.lexicon.entityPlural}. ` +
            `Only for reports that ask for a ${entity}. Matching is case-insensitive ` +
            "and partial, so a distinctive word is enough.",
        }),
      ),
      days: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LAST_N_DAYS,
          description:
            "Number of days back, inclusive of today. Required for last_n_days " +
            "and ignored otherwise.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

/** Capability list for the agent prompt, generated from the catalog. */
export function describeCapabilities(
  reports: ReadonlyMap<string, Report>,
  entitled: readonly string[],
): string {
  return entitled
    .map((id) => reports.get(id))
    .filter((r): r is Report => r !== undefined)
    .map((r) => `- ${r.title}: ${r.description}`)
    .join("\n");
}

interface Params {
  readonly report: string;
  readonly dateRange: DateRange;
  readonly days?: number;
  readonly entity?: string;
}

export function createRunReportTool(
  ctx: Pick<
    OpenClawPluginToolContext,
    "agentId" | "messageChannel" | "requesterSenderId" | "sessionKey" | "deliveryContext"
  >,
  deps: ToolDeps,
) {
  const clock = deps.now ?? (() => new Date());
  const reportIds = [...deps.reports.keys()].sort();
  const { deployment } = deps;
  const timezone = deployment.reporting.timezone;

  /** What a refusal says to the customer. Deliberately uninformative. */
  const refusalText = `Something went wrong on my side, so I can't answer that right now. I've flagged it for the ${deployment.branding.org} team.`;

  return {
    name: TOOL_NAME,
    /** Required by AgentTool; shown in UI and progress output. */
    label: "Run report",
    description:
      "Retrieve this channel's own data. Returns raw rows plus exact totals. " +
      "Monetary values are already in major units. Summarise from what it returns " +
      "and never state a figure it did not return.",
    parameters: buildParameters(reportIds, deployment),

    async execute(_toolCallId: string, rawParams: unknown): Promise<ToolResult> {
      const started = clock();
      // OpenClaw validates against `parameters` before calling, but the cast
      // would be a lie if it ever did not: treat the arguments as possibly
      // absent and check, rather than assume and read through undefined.
      const params = (rawParams ?? {}) as Partial<Params>;

      const finish = (
        outcome: "success" | "refused" | "error",
        extra: {
          agentId?: string | undefined;
          tenant?: string | undefined;
          rowCount?: number | undefined;
          truncated?: boolean | undefined;
          errorClass?: string | undefined;
        },
      ): void => {
        deps.audit.record(
          buildAuditRecord({
            outcome,
            agentId: extra.agentId,
            tenant: extra.tenant,
            // The conversation id, not the provider — `messageChannel` is
            // "slack"/"webchat" and is recorded separately.
            channel: ctx.deliveryContext?.to,
            channelProvider: ctx.messageChannel,
            senderId: ctx.requesterSenderId,
            report: params.report,
            dateRange: params.dateRange,
            ...(params.entity === undefined ? {} : { entity: params.entity }),
            rowCount: extra.rowCount,
            truncated: extra.truncated,
            errorClass: extra.errorClass,
            durationMs: clock().getTime() - started.getTime(),
            now: started,
          }),
        );
      };

      const refuse = async (
        reason: "tenant_resolution_failure" | "tool_failure",
        errorClass: string,
        detail: string,
        agentId?: string,
        tenant?: string,
      ): Promise<ToolResult> => {
        finish(reason === "tool_failure" ? "error" : "refused", {
          agentId,
          tenant,
          errorClass,
        });
        await deps.escalator.escalate({
          reason,
          detail,
          agentId,
          tenant,
          channel: ctx.deliveryContext?.to,
          senderId: ctx.requesterSenderId,
        });
        return {
          content: [{ type: "text", text: refusalText }],
          details: { refused: true, reason: errorClass },
        };
      };

      // 0. Arguments. A malformed call is a bug or an injection artefact, not
      //    a customer question — refuse before touching tenant state.
      if (params.report === undefined || params.dateRange === undefined) {
        return await refuse(
          "tool_failure",
          "malformed_params",
          `${TOOL_NAME} called without report/dateRange: ${JSON.stringify(rawParams)}`,
        );
      }

      // 1. Tenant. Fail closed; never default.
      const resolution = resolveTenant(ctx, deps.tenantMap);
      if (!resolution.ok) {
        return await refuse(
          "tenant_resolution_failure",
          resolution.reason,
          resolution.detail,
          resolution.agentId,
        );
      }
      const { agentId, tenant } = resolution;

      // 2. Entitlement. The enum is global; entitlement is enforced here.
      const report = deps.reports.get(params.report);
      if (report === undefined || !isEntitled(tenant, params.report)) {
        return await refuse(
          "tenant_resolution_failure",
          "not_entitled",
          `agent ${agentId} requested ${JSON.stringify(params.report)}, which it is not entitled to`,
          agentId,
          tenant.tenantId,
        );
      }

      // 3. The report must support the requested window.
      // `days` is bounded twice: by the tool schema, and here against what the
      // report itself declares it is correct for. The schema stops a wild
      // value; this stops a value that is legal in general but wrong here.
      if (params.dateRange === "last_n_days") {
        const maxDays = report.maxDays ?? deployment.resolved.defaultMaxDays;
        const days = params.days;
        if (days === undefined || !Number.isInteger(days) || days < 1 || days > maxDays) {
          return await refuse(
            "tenant_resolution_failure",
            "bad_days",
            `report ${report.id} accepts 1..${String(maxDays)} days, got ${String(days)}`,
            agentId,
            tenant.tenantId,
          );
        }
      }

      if (!report.dateRanges.includes(params.dateRange)) {
        return await refuse(
          "tenant_resolution_failure",
          "unsupported_date_range",
          `report ${report.id} does not support ${params.dateRange}`,
          agentId,
          tenant.tenantId,
        );
      }

      const template = deps.templates.get(report.id);
      if (template === undefined) {
        return await refuse(
          "tool_failure",
          "template_missing",
          `no SQL template loaded for report ${report.id}`,
          agentId,
          tenant.tenantId,
        );
      }

      // 4. Render, execute, shape.
      // Whether an entity is needed is a property of the TEMPLATE, not of a
      // separate flag that could disagree with it. A report whose SQL declares
      // {{entity}} cannot run without one; a report that does not declare it
      // ignores the parameter entirely, so a stray value cannot reach any SQL.
      const needsEntity = template.includes("{{entity}}");
      if (needsEntity && (params.entity === undefined || params.entity.trim() === "")) {
        return await refuse(
          "tenant_resolution_failure",
          "entity_required",
          `report ${report.id} requires a ${deployment.lexicon.entity} name`,
          agentId,
          tenant.tenantId,
        );
      }

      const now = clock();
      const range = resolveDateRange(
        params.dateRange,
        now,
        {
          timezone,
          allTimeFloor: deployment.reporting.allTimeFloor,
        },
        params.days,
      );

      try {
        const sql = renderTemplate(
          template,
          {
            ...(deployment.resolved.tenantScoped ? { tenant_id: tenant.tenantId } : {}),
            ...(needsEntity && params.entity !== undefined
              ? { entity: params.entity }
              : {}),
            start_date: range.start,
            end_date: range.end,
          },
          deployment,
          { rowCap: report.rowCap, source: `reports/${report.id}/query.sql` },
        );

        const result = await deps.executeSql(sql);
        const payload = shapeResult(result, {
          report,
          range,
          expectedReportedDate: expectedReportedDate(now, timezone),
          now,
          timezone,
          timezoneLabel: timezoneLabel(timezone, now),
        });

        finish("success", {
          agentId,
          tenant: tenant.tenantId,
          rowCount: payload.rows.length,
          truncated: payload.truncated,
        });

        return {
          content: [{ type: "text", text: summariseForModel(payload) }],
          details: payload,
        };
      } catch (error) {
        const errorClass =
          error instanceof WarehouseError
            ? error.code
            : ((error as { code?: string }).code ?? "unexpected_error");
        const detail = error instanceof Error ? error.message : String(error);
        return await refuse("tool_failure", errorClass, detail, agentId, tenant.tenantId);
      }
    },
  };
}

/**
 * The tool result the model actually reads.
 *
 * The rows have to be HERE, in `content`, not only in `details`. `details` is
 * structured metadata for the host — the model does not see it. With rows only
 * there, a digest agent reports "row-level data was not returned, only totals"
 * and posts a table with nothing but a total line; worse, it may produce a row
 * label anyway, which is a value it could not have read and therefore invented.
 *
 * A header of essential facts (window, exactness, truncation, as-of) comes
 * first so they are impossible to miss, then the raw rows. The plugin still
 * does no summarising — that is the model's job — but it has to hand over the
 * material to summarise.
 */
function summariseForModel(payload: ReportPayload): string {
  const parts = [
    `report=${payload.report}`,
    `range=${payload.date_range.name} (${payload.date_range.start}..${payload.date_range.end})`,
    `rows_returned=${String(payload.rows.length)}`,
    `truncated=${String(payload.truncated)}`,
    `totals=${JSON.stringify(payload.totals)} (exact, over the full range)`,
  ];
  if (payload.date_range.in_progress) {
    parts.push(
      `IN PROGRESS: this window includes today. State the figure as of ${payload.as_of_local}, not as final.`,
    );
  }
  if (payload.truncated) {
    parts.push(
      "TRUNCATED: rows are the largest subset by the report's ordering. State totals (exact) but do not characterise distribution or composition across the full range.",
    );
  }
  // One object per row, one row per line: compact enough for `rowCap` rows and
  // far easier for a model to group correctly than a single nested blob.
  parts.push(
    payload.rows.length === 0
      ? "rows: none"
      : `rows (one JSON object per line):\n${payload.rows
          .map((row) => JSON.stringify(row))
          .join("\n")}`,
  );
  return parts.join("\n");
}
