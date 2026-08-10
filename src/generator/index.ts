import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CatalogError } from "../catalog/errors.js";
import { loadCatalog } from "../catalog/load.js";
import { loadDeployment } from "../config/load.js";
import { generateArtifacts, type GenerateOptions } from "./artifacts.js";
import { checkInvariants } from "./invariants.js";

export { generateArtifacts } from "./artifacts.js";
export {
  checkInvariants,
  reportFamilyWarnings,
  MIN_SCHEDULE_GAP_MINUTES,
} from "./invariants.js";
export { buildSystemPrompt } from "./prompt.js";
export { buildOpsPrompt } from "./ops-prompt.js";
export { AMBIGUOUS_PHRASES } from "./ambiguity.js";

export interface BuildOptions {
  readonly deploymentPath: string;
  readonly tenantsPath: string;
  readonly reportsDir: string;
  /** Optional; a missing file means no ops agent. */
  readonly opsPath?: string;
  readonly agentRoot: string;
  readonly peerKind?: GenerateOptions["peerKind"];
}

/**
 * Load, generate, and verify. Throws `CatalogError` if any invariant fails, so
 * the same call is usable as a CI gate and as the deploy-time build.
 */
export function build(options: BuildOptions) {
  const deployment = loadDeployment(options.deploymentPath);

  const catalog = loadCatalog({
    deployment,
    tenantsPath: options.tenantsPath,
    reportsDir: options.reportsDir,
    ...(options.opsPath === undefined ? {} : { opsPath: options.opsPath }),
  });

  const artifacts = generateArtifacts({
    deployment,
    catalog,
    agentRoot: options.agentRoot,
    ...(options.peerKind === undefined ? {} : { peerKind: options.peerKind }),
  });

  const issues = checkInvariants(deployment, catalog, artifacts);
  if (issues.length > 0) throw new CatalogError("generated config", issues);

  return { deployment, catalog, artifacts };
}

/** Write artifacts to `outDir`. Always rewritten wholesale; never hand-edited. */
export function writeArtifacts(
  outDir: string,
  artifacts: ReturnType<typeof build>["artifacts"],
): string[] {
  mkdirSync(outDir, { recursive: true });
  // Clear prompts before writing. Without this, removing a tenant leaves their
  // prompt behind and the next deploy installs instructions for an agent that
  // no longer exists — the same class of residue the automations reconciler
  // exists to prevent.
  rmSync(join(outDir, "prompts"), { recursive: true, force: true });
  mkdirSync(join(outDir, "prompts"), { recursive: true });

  const written: string[] = [];
  const write = (relative: string, contents: string): void => {
    const path = join(outDir, relative);
    writeFileSync(path, contents);
    written.push(path);
  };

  write("openclaw.json", `${JSON.stringify(artifacts.openclaw, null, 2)}\n`);
  write("tenant-map.json", `${JSON.stringify(artifacts.tenantMap, null, 2)}\n`);
  write("ops.json", `${JSON.stringify(artifacts.ops, null, 2)}\n`);
  write("automations.json", `${JSON.stringify(artifacts.automations, null, 2)}\n`);

  for (const [agentId, prompt] of Object.entries(artifacts.prompts)) {
    write(join("prompts", `${agentId}.md`), prompt);
  }
  return written;
}
