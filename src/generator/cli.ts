import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CatalogError } from "../catalog/errors.js";
import { build, reportFamilyWarnings, writeArtifacts } from "./index.js";

/**
 * `npm run generate` — the CI gate and the deploy-time build.
 *
 * Exits non-zero with the full issue list on any failure, so a broken config
 * cannot produce artifacts that reach a VM.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main(): void {
  const outDir = join(REPO_ROOT, "generated");
  const deploymentPath = join(REPO_ROOT, "deployment.yaml");

  // A fresh clone has no deployment.yaml — the file is gitignored, so its
  // absence is the *normal* state of a toolkit checkout rather than an error.
  // Say what to do and exit clean, so `npm run check` passes before the
  // interview has been run.
  //
  // This is not a hole in the deploy path: `infra/build-release.sh` refuses to
  // build a bundle when `generated/openclaw.json` is missing, so a deployment
  // that lost its config fails there, loudly, rather than shipping nothing.
  if (!existsSync(deploymentPath)) {
    console.error(
      "No deployment.yaml — nothing to generate.\n\n" +
        "  Run /almanac-init to write one by interview, or copy\n" +
        "  deployment.yaml.example and fill it in by hand.\n",
    );
    return;
  }

  try {
    const { catalog, artifacts } = build({
      deploymentPath,
      tenantsPath: join(REPO_ROOT, "tenants.yaml"),
      reportsDir: join(REPO_ROOT, "reports"),
      // Optional. A missing ops.yaml means no ops agent at all.
      opsPath: join(REPO_ROOT, "ops.yaml"),
      // Matches the container layout; OPENCLAW_HOME is /data on the VM.
      agentRoot: "/data/agents",
    });

    // Warnings, not failures: the intermediate state of a report migration is
    // correct by design, so it must not stop a build. But an unfinished one is
    // easy to forget, so the stragglers are named on every build.
    for (const warning of reportFamilyWarnings(catalog)) {
      console.error(`warning: ${warning}`);
    }

    const written = writeArtifacts(outDir, artifacts);
    console.error(
      `generated ${String(written.length)} files for ${String(catalog.tenants.length)} tenant(s), ${String(artifacts.automations.length)} scheduled job(s)`,
    );
  } catch (error) {
    if (error instanceof CatalogError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

main();
