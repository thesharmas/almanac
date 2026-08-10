import {
  SqlExecutionError,
  WarehouseAuthError,
  WarehouseProtocolError,
  WarehouseTransportError,
  withSingleRetry,
  type QueryResult,
  type ResultRow,
  type WarehouseAdapter,
} from "./types.js";

/**
 * The direct Snowflake adapter.
 *
 * This is the default for a new deployment, and it is worth being clear that
 * connecting directly is *more* to get right than going through an MCP, not
 * less. With no server in front, three things become this deployment's job:
 *
 *  1. **The role is the containment boundary.** Grant it SELECT on the
 *     analytics schema and nothing else. Nothing in this file can stop a
 *     statement the role is permitted to run, and the contract checker only
 *     governs templates in this repo — not a hand-run query, not a future
 *     code path. `/almanac-connect` proves by execution that the role cannot
 *     write, because a role that was *meant* to be read-only and a role that
 *     *is* read-only are different claims.
 *  2. **Key-pair, not a password.** A password is replayable by anything that
 *     reads it once. The key lives in Secret Manager and is fetched into
 *     process memory at container start; it is never written to disk.
 *  3. **The session timezone is an unpinned default.** It is set explicitly on
 *     every connection below, and the shaper still asserts the date the
 *     warehouse reports against the one Almanac computed — belt and braces,
 *     because a wrong date is invisible in the answer.
 *
 * `snowflake-sdk` is an optional dependency, imported dynamically. A
 * deployment using the MCP adapter should not have to install a driver it will
 * never call.
 */

export interface SnowflakeOptions {
  readonly account: string;
  readonly username: string;
  readonly role: string;
  readonly warehouse: string;
  readonly database: string;
  readonly schema: string;
  /** PEM contents, not a path. Read from Secret Manager at start-up. */
  readonly privateKey: string;
  /** Session timezone, pinned so CURRENT_DATE() is not a shared default. */
  readonly timezone: string;
  readonly timeoutMs?: number;
}

/** The slice of `snowflake-sdk` this adapter uses. */
interface SnowflakeConnection {
  connect(cb: (err: unknown, conn: unknown) => void): void;
  destroy(cb: (err: unknown) => void): void;
  execute(options: {
    sqlText: string;
    complete: (err: unknown, stmt: unknown, rows: ResultRow[] | undefined) => void;
  }): void;
}

interface SnowflakeSdk {
  createConnection(options: Record<string, unknown>): SnowflakeConnection;
  configure?(options: Record<string, unknown>): void;
}

/**
 * Classify a driver error.
 *
 * Only genuine transport problems are retryable. A syntax error, a missing
 * table or a permission denial is deterministic — retrying costs a customer
 * another timeout and changes nothing.
 */
function classify(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code) : "";

  if (/incorrect username or password|JWT token is invalid|authentication/i.test(message)) {
    return new WarehouseAuthError(message);
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return new WarehouseTransportError(message);
  }
  if (codeText.startsWith("4") || codeText.startsWith("5")) {
    return new SqlExecutionError(message);
  }
  return new SqlExecutionError(message);
}

export class SnowflakeWarehouse implements WarehouseAdapter {
  readonly #options: SnowflakeOptions;
  #connection: SnowflakeConnection | undefined;
  #connecting: Promise<SnowflakeConnection> | undefined;

  constructor(options: SnowflakeOptions) {
    this.#options = options;
  }

  async #connect(): Promise<SnowflakeConnection> {
    if (this.#connection !== undefined) return this.#connection;
    // Concurrent turns must share one in-flight connect rather than opening a
    // connection each; a digest and a question can arrive together.
    this.#connecting ??= this.#openConnection();
    try {
      this.#connection = await this.#connecting;
      return this.#connection;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #openConnection(): Promise<SnowflakeConnection> {
    let sdk: SnowflakeSdk;
    try {
      // Typed through `unknown` rather than trusting the driver's own types:
      // `SnowflakeSdk` above is the narrow slice this adapter actually calls,
      // which is what keeps the seam small enough to swap.
      const loaded: unknown = await import("snowflake-sdk");
      sdk = loaded as SnowflakeSdk;
    } catch {
      throw new WarehouseProtocolError(
        'warehouse.adapter is "snowflake" but snowflake-sdk is not installed — run `npm install snowflake-sdk`',
      );
    }

    // The driver logs statements at info level by default, and a statement
    // here contains the tenant id.
    sdk.configure?.({ logLevel: "ERROR" });

    const connection = sdk.createConnection({
      account: this.#options.account,
      username: this.#options.username,
      role: this.#options.role,
      warehouse: this.#options.warehouse,
      database: this.#options.database,
      schema: this.#options.schema,
      authenticator: "SNOWFLAKE_JWT",
      privateKey: this.#options.privateKey,
      timezone: this.#options.timezone,
      clientSessionKeepAlive: true,
    });

    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err !== null && err !== undefined) reject(classify(err));
        else resolve();
      });
    });

    return connection;
  }

  async executeSql(sql: string): Promise<QueryResult> {
    return await withSingleRetry(async () => {
      const connection = await this.#connect();
      const rows = await new Promise<ResultRow[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new WarehouseTransportError("statement timed out"));
        }, this.#options.timeoutMs ?? 120_000);

        connection.execute({
          sqlText: sql,
          complete: (err, _stmt, returned) => {
            clearTimeout(timer);
            if (err !== null && err !== undefined) {
              const classified = classify(err);
              // A dropped connection must not be reused by the retry.
              if (classified instanceof WarehouseTransportError) {
                this.#connection = undefined;
              }
              reject(classified);
              return;
            }
            resolve(returned ?? []);
          },
        });
      });

      return {
        rows,
        rowCount: rows.length,
        columns: Object.keys(rows[0] ?? {}),
      };
    });
  }

  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection === undefined) return;
    await new Promise<void>((resolve) => {
      connection.destroy(() => {
        resolve();
      });
    });
  }
}
