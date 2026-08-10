import {
  SqlExecutionError,
  WarehouseAuthError,
  WarehouseProtocolError,
  WarehouseTransportError,
  withSingleRetry,
  type QueryResult,
  type WarehouseAdapter,
} from "./types.js";

/**
 * The MCP adapter: read-only SQL through an existing MCP server.
 *
 * For an org that already runs a warehouse MCP with an `execute_sql` tool,
 * this is the shortest path to a working deployment — the server is already
 * holding the credentials and already scoping the role, so Almanac needs no
 * warehouse secret of its own.
 *
 * A deliberately small, purpose-built client rather than the official SDK:
 *
 *  1. Almanac calls exactly one method. Servers of this shape are stateless
 *     (they accept `tools/call` with no `initialize` handshake), so the SDK's
 *     session negotiation is machinery with nothing to do.
 *  2. Only transport failures may be retried, exactly once. Owning the request
 *     loop makes that a property of the code rather than a hope about a
 *     dependency's defaults.
 *  3. The MCP server must **never** be registered under the Gateway's
 *     `mcp.servers`. Calling it through our own client keeps that separation
 *     visible in the code rather than implied — if the model could reach the
 *     server directly, every closed enum in this repo would be decoration.
 *
 * The API key is held in memory and never logged. Errors deliberately carry no
 * request body, because the SQL contains the tenant id.
 */

/**
 * Statuses where the request plausibly never reached the application.
 * 500 is excluded on purpose: it means the server ran and failed, so a retry
 * would just repeat a deterministic failure.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const JSONRPC_VERSION = "2.0";

export interface McpWarehouseOptions {
  readonly url: string;
  readonly apiKey: string;
  /** The tool name the server exposes for read-only SQL. */
  readonly toolName?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

/** Parse an SSE body, returning the last `data:` payload. */
function parseSse(body: string): string {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  const last = dataLines.at(-1);
  if (last === undefined) {
    throw new WarehouseProtocolError("response contained no SSE data frame");
  }
  return last;
}

export class McpWarehouse implements WarehouseAdapter {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #toolName: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: McpWarehouseOptions) {
    if (options.url === "") throw new Error("mcp url is required");
    if (options.apiKey === "") throw new Error("mcp api key is required");
    this.#url = options.url;
    this.#apiKey = options.apiKey;
    this.#toolName = options.toolName ?? "execute_sql";
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Execute one read-only statement.
   *
   * No write flag is ever sent. Templates are SELECT/WITH only and the
   * contract checker rejects anything else, so there is no code path that
   * should be able to request a write — omitting the parameter entirely means
   * there is also no argument to get wrong.
   */
  async executeSql(sql: string): Promise<QueryResult> {
    return await withSingleRetry(() => this.#callTool({ sql }));
  }

  async #callTool(args: Record<string, unknown>): Promise<QueryResult> {
    const body = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: this.#nextId++,
      method: "tools/call",
      params: { name: this.#toolName, arguments: args },
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Streamable HTTP requires both; these servers reply in SSE framing.
          Accept: "application/json, text/event-stream",
          "X-API-Key": this.#apiKey,
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new WarehouseTransportError(`mcp request failed: ${reason}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new WarehouseAuthError();
    }
    if (RETRYABLE_STATUSES.has(response.status)) {
      throw new WarehouseTransportError(
        `mcp returned ${String(response.status)}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new WarehouseProtocolError(`mcp returned ${String(response.status)}`);
    }

    const text = await response.text();
    const payload = text.includes("data:") ? parseSse(text) : text;

    let envelope: unknown;
    try {
      envelope = JSON.parse(payload);
    } catch {
      throw new WarehouseProtocolError("response was not valid JSON");
    }

    return extractResult(envelope);
  }
}

function extractResult(envelope: unknown): QueryResult {
  if (typeof envelope !== "object" || envelope === null) {
    throw new WarehouseProtocolError("response envelope was not an object");
  }
  const record = envelope as Record<string, unknown>;

  if ("error" in record && record["error"] !== undefined) {
    const err = record["error"] as { message?: unknown };
    const message =
      typeof err.message === "string" ? err.message : "unknown JSON-RPC error";
    throw new WarehouseProtocolError(`mcp returned a JSON-RPC error: ${message}`);
  }

  const result = record["result"];
  if (typeof result !== "object" || result === null) {
    throw new WarehouseProtocolError("response had no result object");
  }
  const resultRecord = result as Record<string, unknown>;

  const structured = resultRecord["structuredContent"];
  if (typeof structured !== "object" || structured === null) {
    throw new WarehouseProtocolError("response had no structuredContent");
  }

  const s = structured as Record<string, unknown>;
  if (typeof s["success"] !== "boolean" || !Array.isArray(s["rows"])) {
    throw new WarehouseProtocolError("structuredContent was not an execute_sql result");
  }

  const error = typeof s["error"] === "string" ? s["error"] : null;
  if (s["success"] !== true || error !== null) {
    // The server's message describes the statement, not the data, so it is
    // safe to surface to an operator. It is still never shown to a customer.
    throw new SqlExecutionError(error ?? "statement failed without a message");
  }

  const rows = s["rows"] as Record<string, unknown>[];
  return {
    rows,
    rowCount: typeof s["row_count"] === "number" ? s["row_count"] : rows.length,
    columns: Array.isArray(s["columns"]) ? (s["columns"] as string[]) : [],
  };
}
