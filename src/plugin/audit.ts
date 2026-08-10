/**
 * The audit log.
 *
 * One structured line per tool invocation, **including refusals**. A refused
 * call is as interesting as a successful one: a fail-closed tenant resolution
 * or an unentitled report request is exactly what an investigation would want
 * to find.
 *
 * `senderId` is recorded even though every channel member is permitted —
 * making membership the perimeter removed a control, not accountability.
 *
 * What is deliberately absent: row contents, the rendered SQL, and any
 * credential. The log records that a tenant asked for a report and what
 * happened, never the answer.
 */

export type AuditOutcome = "success" | "refused" | "error";

/**
 * Which tool produced the record. Kept separate from `report` so a query for
 * "who asked for daily_totals" is not polluted by digest posts, which have no
 * report of their own.
 */
export type AuditEvent = "run_report" | "post_digest" | "announce";

export interface AuditRecord {
  readonly timestamp: string;
  readonly event: AuditEvent;
  readonly outcome: AuditOutcome;
  readonly agentId: string | null;
  readonly tenant: string | null;
  /** Conversation id, e.g. a Slack channel id. What an investigation searches by. */
  readonly channel: string | null;
  /** Channel provider, e.g. "slack". Distinct from the conversation. */
  readonly channelProvider: string | null;
  readonly senderId: string | null;
  readonly report: string | null;
  readonly dateRange: string | null;
  /**
   * The entity filter, when the report took one.
   *
   * Part of what was asked, so it belongs in the record of what was asked. It
   * is the customer's own entity name, not row data — the log still records
   * that a question was put and what happened, never the answer.
   */
  readonly entity: string | null;
  readonly rowCount: number | null;
  /** Full-range totals may exceed rowCount. */
  readonly truncated: boolean | null;
  readonly durationMs: number;
  /** Machine-readable failure class, e.g. `unknown_agent`, `warehouse_transport`. */
  readonly errorClass: string | null;
}

export interface AuditLogger {
  record(entry: AuditRecord): void;
}

/** Emits newline-delimited JSON to stdout, for the log pipeline to pick up. */
export class JsonAuditLogger implements AuditLogger {
  readonly #write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => process.stdout.write(line)) {
    this.#write = write;
  }

  record(entry: AuditRecord): void {
    this.#write(`${JSON.stringify(entry)}\n`);
  }
}

/** Collects records in memory. Used by tests and the local Gateway. */
export class RecordingAuditLogger implements AuditLogger {
  readonly records: AuditRecord[] = [];

  record(entry: AuditRecord): void {
    this.records.push(entry);
  }
}

export interface AuditDraft {
  readonly event?: AuditEvent | undefined;
  readonly outcome: AuditOutcome;
  readonly agentId?: string | undefined;
  readonly tenant?: string | undefined;
  readonly channel?: string | undefined;
  readonly channelProvider?: string | undefined;
  readonly senderId?: string | undefined;
  readonly report?: string | undefined;
  readonly dateRange?: string | undefined;
  readonly entity?: string | undefined;
  readonly rowCount?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly durationMs: number;
  readonly errorClass?: string | undefined;
  readonly now: Date;
}

export function buildAuditRecord(draft: AuditDraft): AuditRecord {
  return {
    timestamp: draft.now.toISOString(),
    event: draft.event ?? "run_report",
    outcome: draft.outcome,
    agentId: draft.agentId ?? null,
    tenant: draft.tenant ?? null,
    channel: draft.channel ?? null,
    channelProvider: draft.channelProvider ?? null,
    senderId: draft.senderId ?? null,
    report: draft.report ?? null,
    dateRange: draft.dateRange ?? null,
    entity: draft.entity ?? null,
    rowCount: draft.rowCount ?? null,
    truncated: draft.truncated ?? null,
    durationMs: draft.durationMs,
    errorClass: draft.errorClass ?? null,
  };
}
