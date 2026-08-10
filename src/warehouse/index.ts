import type { Deployment } from "../config/load.js";
import { McpWarehouse } from "./mcp.js";
import { SnowflakeWarehouse } from "./snowflake.js";
import type { WarehouseAdapter } from "./types.js";

export { McpWarehouse } from "./mcp.js";
export { SnowflakeWarehouse } from "./snowflake.js";
export {
  RecordingWarehouse,
  SqlExecutionError,
  WarehouseAuthError,
  WarehouseError,
  WarehouseProtocolError,
  WarehouseTransportError,
  withSingleRetry,
  type QueryResult,
  type ResultRow,
  type WarehouseAdapter,
} from "./types.js";

/** Env var holding the Snowflake private key PEM, populated at container start. */
export const SNOWFLAKE_KEY_ENV = "ALMANAC_SNOWFLAKE_PRIVATE_KEY";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Build the adapter `deployment.yaml` names.
 *
 * Credentials come from the environment, never from the config file: the
 * config is committed and reviewable, and the moment a secret can live in it
 * somebody will put one there.
 */
export function createWarehouse(
  deployment: Deployment,
  env: NodeJS.ProcessEnv = process.env,
): WarehouseAdapter {
  const { warehouse } = deployment;
  const timeoutMs = warehouse.timeoutMs ?? 120_000;

  if (warehouse.adapter === "mcp") {
    const mcp = warehouse.mcp;
    if (mcp === undefined) {
      throw new Error('warehouse.adapter is "mcp" but warehouse.mcp is missing');
    }
    return new McpWarehouse({
      url: required(env, mcp.urlEnv),
      apiKey: required(env, mcp.apiKeyEnv),
      ...(mcp.toolName === undefined ? {} : { toolName: mcp.toolName }),
      timeoutMs,
    });
  }

  const snowflake = warehouse.snowflake;
  if (snowflake === undefined) {
    throw new Error('warehouse.adapter is "snowflake" but warehouse.snowflake is missing');
  }
  return new SnowflakeWarehouse({
    account: snowflake.account,
    username: snowflake.username,
    role: snowflake.role,
    warehouse: snowflake.warehouse,
    database: snowflake.database,
    schema: snowflake.schema,
    privateKey: required(env, SNOWFLAKE_KEY_ENV),
    // Pinned, so CURRENT_DATE() is not whatever the account default happens
    // to be. The shaper still asserts the returned date against the expected
    // one — this makes drift unlikely, that makes it loud.
    timezone: deployment.reporting.timezone,
    timeoutMs,
  });
}
