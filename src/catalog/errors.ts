/**
 * Catalog validation errors.
 *
 * Every issue carries a `path` (where in the file) and a `message` (what is
 * wrong and, where useful, what to do). A build failure here is read by
 * whoever is onboarding a tenant, often under time pressure, and a bare schema
 * dump costs more time than the mistake did.
 */

export interface CatalogIssue {
  /** Dotted path into the source file, e.g. `acme.schedules[0].dateRange`. */
  readonly path: string;
  readonly message: string;
}

export class CatalogError extends Error {
  readonly issues: readonly CatalogIssue[];

  constructor(source: string, issues: readonly CatalogIssue[]) {
    const rendered = issues
      .map((i) => `  ${i.path === "" ? "(root)" : i.path}: ${i.message}`)
      .join("\n");
    super(`${source} is invalid:\n${rendered}`);
    this.name = "CatalogError";
    this.issues = issues;
  }
}

export function issue(path: string, message: string): CatalogIssue {
  return { path, message };
}
