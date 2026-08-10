import { CatalogError } from "../catalog/errors.js";
import { tenantIdPattern } from "../catalog/schema.js";
import type { Deployment } from "../config/load.js";
import { ENTITY_PLACEHOLDER, TENANT_PLACEHOLDER } from "../config/load.js";
import { ALLOWED_PLACEHOLDERS, checkTemplateContract } from "./contract.js";

/**
 * Render a report template to executable SQL.
 *
 * Warehouse adapters here have no bind-parameter path, so the plugin renders
 * the final SQL itself. That is only safe because of what the values are: the
 * tenant id is resolved by the host from `ctx.agentId`, and the dates are
 * derived from the closed `dateRange` enum. No model-authored string reaches
 * here except the entity filter, which is discussed below.
 *
 * The literal encoder is the last line of that argument rather than the first.
 * Each value is validated against a narrow pattern before it is quoted, so a
 * bug elsewhere that let an unexpected value through fails loudly instead of
 * producing SQL.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An entity name fragment the customer typed.
 *
 * Both a permit-list AND correct escaping, because neither alone is right.
 *
 * The permit-list excludes backslash, semicolon, quotation mark and comment
 * markers outright — characters with no place in a trading name and every
 * place in an injection attempt. The apostrophe is the one exception: real
 * names contain them ("SMACKIN' Seeds"), and refusing a customer's largest
 * account is not a security posture, it is a bug. So apostrophes are permitted
 * and then doubled, which is the standard SQL escape and the only one needed
 * once everything else is excluded.
 *
 * This value is safe for a second, independent reason: the tenant predicate is
 * mandatory and ANDed, so an entity filter can only ever narrow a result that
 * is already scoped to one tenant. A hostile or hallucinated value returns
 * zero rows — never another tenant's.
 */
const ENTITY_RE = /^[A-Za-z0-9 .,&()\-_/+']{1,120}$/;

export class UnsafeValueError extends Error {
  readonly code = "unsafe_value";
  constructor(placeholder: string, value: string) {
    super(
      `refusing to render {{${placeholder}}}: ${JSON.stringify(value)} does not match the permitted pattern`,
    );
    this.name = "UnsafeValueError";
  }
}

export interface RenderValues {
  readonly tenant_id?: string;
  readonly start_date: string;
  readonly end_date: string;
  /** Only for templates that declare {{entity}}. Matched with LIKE. */
  readonly entity?: string;
}

function quote(value: string): string {
  return `'${value}'`;
}

function encode(placeholder: string, value: string, deployment: Deployment): string {
  switch (placeholder) {
    case TENANT_PLACEHOLDER: {
      const pattern = new RegExp(tenantIdPattern(deployment.resolved.tenantIdFormat));
      if (!pattern.test(value)) throw new UnsafeValueError(placeholder, value);
      // Integer tenant keys are still quoted. Every warehouse this targets
      // coerces a quoted numeric literal in a comparison, and quoting keeps
      // one encoding path rather than a branch that has to stay correct.
      return quote(value);
    }
    case "start_date":
    case "end_date":
      if (!DATE_RE.test(value)) throw new UnsafeValueError(placeholder, value);
      return quote(value);
    case ENTITY_PLACEHOLDER: {
      if (!ENTITY_RE.test(value)) throw new UnsafeValueError(placeholder, value);
      // Double the apostrophes, then wrap for LIKE here rather than in the
      // template — so a report cannot choose a different matching strategy.
      const escaped = value.replaceAll("'", "''");
      return quote(`%${escaped}%`);
    }
    default:
      throw new UnsafeValueError(placeholder, value);
  }
}

export interface RenderOptions {
  readonly rowCap: number;
  /** Identifies the template in error messages. */
  readonly source: string;
}

/**
 * Validate the template against the contract, then substitute values.
 *
 * The contract is re-checked at render time, not only in CI: a template is
 * read from disk at runtime, and a file that changed after CI passed must not
 * be executed.
 */
export function renderTemplate(
  sql: string,
  values: RenderValues,
  deployment: Deployment,
  options: RenderOptions,
): string {
  const issues = checkTemplateContract(sql, deployment, { rowCap: options.rowCap });
  if (issues.length > 0) throw new CatalogError(options.source, issues);

  let out = sql;
  for (const placeholder of ALLOWED_PLACEHOLDERS) {
    const raw = values[placeholder];
    if (raw === undefined) {
      // A template using a placeholder with no value would otherwise render
      // with the placeholder still in it — a broken query rather than an
      // unsafe one, but worth failing on explicitly.
      if (sql.includes(`{{${placeholder}}}`)) {
        throw new UnsafeValueError(placeholder, "(missing)");
      }
      continue;
    }
    const encoded = encode(placeholder, raw, deployment);
    out = out.replaceAll(
      new RegExp(`\\{\\{\\s*${placeholder}\\s*\\}\\}`, "g"),
      // replaceAll with a string treats `$` specially; a function does not.
      () => encoded,
    );
  }

  // Belt and braces: nothing that looks like a placeholder may survive.
  const leftover = /\{\{\s*[a-z_]+\s*\}\}/.exec(out);
  if (leftover !== null) {
    throw new UnsafeValueError("unsubstituted", leftover[0]);
  }

  return out;
}
