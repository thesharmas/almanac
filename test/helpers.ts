import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDeployment, type Deployment } from "../src/config/load.js";
import type { DeploymentDefinition } from "../src/config/schema.js";

export const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export const REPORTS_DIR = join(FIXTURES, "reports");

/** A valid multi-tenant deployment, as a plain object tests can override. */
export function deploymentInput(): DeploymentDefinition {
  return {
    name: "test",
    branding: {
      botName: "Almanac",
      org: "Testco",
      persona: "an automated assistant from Testco",
    },
    tenancy: {
      mode: "multi",
      predicate: "f.TENANT_ID = {{tenant_id}}",
      idFormat: "uuid",
      entityPredicate: "UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}})",
    },
    lexicon: {
      entity: "business",
      entityPlural: "businesses",
      measure: "funding",
      measurePlural: "fundings",
      verbPast: "funded",
    },
    reporting: {
      timezone: "America/Los_Angeles",
      allTimeFloor: "2019-01-01",
      defaultMaxDays: 366,
    },
    warehouse: {
      adapter: "mcp",
      mcp: { urlEnv: "TEST_MCP_URL", apiKeyEnv: "TEST_MCP_KEY" },
    },
    slack: { errorChannelId: "C0ERRORS" },
  };
}

/** Build a `Deployment` for tests, applying `patch` before validation. */
export function testDeployment(
  patch: (input: DeploymentDefinition) => DeploymentDefinition = (d) => d,
): Deployment {
  return parseDeployment(patch(deploymentInput()), "deployment.yaml");
}

/** A single-tenant deployment: no predicate, no tenant id. */
export function singleTenantDeployment(): Deployment {
  return testDeployment((d) => ({
    ...d,
    tenancy: { mode: "single" },
  }));
}

/** A contract-satisfying aggregate template, for tests that need a valid one. */
export const VALID_TEMPLATE = `
WITH scoped AS (
  SELECT f.ENTITY_NAME, f.AMOUNT_CENTS
  FROM ANALYTICS.FACTS f
  WHERE f.TENANT_ID = {{tenant_id}}
    AND f.EVENT_DATE BETWEEN {{start_date}} AND {{end_date}}
)
SELECT
  CURRENT_DATE() AS REPORTED_DATE,
  s.ENTITY_NAME,
  s.AMOUNT_CENTS,
  COUNT(*) OVER () AS TOTAL_ROWS,
  SUM(s.AMOUNT_CENTS) OVER () AS TOTAL_AMOUNT,
  '2020-01-01' AS FIRST_DATE
FROM scoped s
ORDER BY s.AMOUNT_CENTS DESC, s.ENTITY_NAME
LIMIT 500
`;
