/**
 * The warehouse seam.
 *
 * **Keep this interface exactly this narrow.** One method, taking a finished
 * SQL string and returning rows. A Snowflake driver and an MCP endpoint both
 * fit behind it, and so will the next one — but only while it stays a pipe.
 *
 * The temptation, once two adapters exist, is to grow this into a query
 * builder so that reports can be written once and dialected per warehouse.
 * Resist it. The contract checker's guarantees are all properties of a
 * *literal template on disk* that a human reviewed: the tenant predicate
 * appears verbatim, the placeholders are the only substitutions, the LIMIT
 * agrees with the row cap. A builder that assembles SQL at runtime has none of
 * those properties, and no amount of care in the builder gets them back.
 *
 * @see docs/why.md §"The model never writes SQL"
 */

/** One row, keyed by column name as the warehouse returned it. */
export type ResultRow = Record<string, unknown>;

export interface QueryResult {
  readonly rows: readonly ResultRow[];
  readonly rowCount: number;
  readonly columns: readonly string[];
}

export interface WarehouseAdapter {
  /**
   * Execute one read-only statement.
   *
   * Implementations must never offer a write path — not a parameter, not an
   * option, not a second method. A report template cannot express a mutation
   * (the contract rejects one at build time), so an adapter that *could*
   * write only adds a way for a future bug to matter.
   */
  executeSql(sql: string): Promise<QueryResult>;
  /** Release any pooled connection. Called on shutdown; safe to call twice. */
  close?(): Promise<void>;
}

/**
 * Typed warehouse failures.
 *
 * Only *transport* failures are ever retried, and the distinction is encoded
 * in the error class rather than decided at each call site: `retryable` is a
 * property of the failure mode, so "should this be retried" has exactly one
 * answer per mode.
 *
 * Retrying anything else is actively harmful. A SQL error is deterministic and
 * would fail identically; an auth failure would burn a second request against
 * a shared credential; and both would double the latency of a customer waiting
 * in Slack for an answer that is not coming.
 */
export abstract class WarehouseError extends Error {
  /** Whether a second attempt could plausibly succeed. */
  abstract readonly retryable: boolean;
  /** Short code for the audit log and escalation payload. */
  abstract readonly code: string;
}

/** Network failure, timeout, or a status indicating the request never landed. */
export class WarehouseTransportError extends WarehouseError {
  readonly retryable = true;
  readonly code = "warehouse_transport";

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WarehouseTransportError";
  }
}

/** Credentials rejected. Never retried — the key will not improve. */
export class WarehouseAuthError extends WarehouseError {
  readonly retryable = false;
  readonly code = "warehouse_auth";

  constructor(message = "the warehouse rejected our credentials") {
    super(message);
    this.name = "WarehouseAuthError";
  }
}

/** Response was not the shape the protocol promises. */
export class WarehouseProtocolError extends WarehouseError {
  readonly retryable = false;
  readonly code = "warehouse_protocol";

  constructor(message: string) {
    super(message);
    this.name = "WarehouseProtocolError";
  }
}

/** The statement ran and the warehouse rejected it. */
export class SqlExecutionError extends WarehouseError {
  readonly retryable = false;
  readonly code = "sql_error";

  constructor(message: string) {
    super(message);
    this.name = "SqlExecutionError";
  }
}

/**
 * Run `attempt`, retrying exactly once and only on a transport failure.
 *
 * Shared by every adapter so the retry policy is one decision in one place
 * rather than a convention each implementation is trusted to follow.
 */
export async function withSingleRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof WarehouseError && e.retryable) {
      return await attempt();
    }
    throw e;
  }
}

/** Collects statements in memory and replays canned rows. For tests. */
export class RecordingWarehouse implements WarehouseAdapter {
  readonly statements: string[] = [];
  constructor(private readonly result: QueryResult = { rows: [], rowCount: 0, columns: [] }) {}

  executeSql(sql: string): Promise<QueryResult> {
    this.statements.push(sql);
    return Promise.resolve(this.result);
  }
}
