#!/usr/bin/env node
/**
 * The leak check — part of `npm run check`.
 *
 * Almanac is a public toolkit assembled from a private deployment, so the
 * failure worth engineering against is a real tenant id, channel id, warehouse
 * object or customer name drifting back into a tracked file. Grepping by hand
 * catches it once; a build gate catches it every time.
 *
 * Two rules:
 *
 *  1. **Real config is never tracked.** deployment.yaml, tenants.yaml and
 *     ops.yaml are gitignored. If one is staged, something is wrong.
 *  2. **Nothing in a tracked file looks like a live identifier.** Slack channel
 *     ids, UUIDs and Slack tokens all have recognisable shapes.
 *
 * Placeholders that are obviously fake — C00000ERRORS, an all-zeroes UUID, the
 * fixture ids under test/ — are allowed by name. That list is deliberately
 * short: an exception you have to add by hand is an exception somebody looks at.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const IGNORED_FILES = [
  // The example files exist to show the shape of a real config, so they carry
  // placeholder-shaped values on purpose.
  "deployment.yaml.example",
  "tenants.yaml.example",
  "ops.yaml.example",
  // The leak check itself contains the patterns it looks for.
  "infra/leakcheck.mjs",
];

/** Files that must never be tracked, because they hold a real deployment. */
const NEVER_TRACKED = ["deployment.yaml", "tenants.yaml", "ops.yaml"];

const PATTERNS = [
  {
    name: "Slack channel id",
    // The lookahead requiring a digit is load-bearing: without it this matches
    // any long uppercase word, and "COPYRIGHT" in a licence file is not a
    // channel. Real ids are base-32-ish and effectively always carry one.
    re: /\bC(?=[A-Z0-9]*[0-9])[A-Z0-9]{8,}\b/g,
    // Fixture and example ids. Every one is visibly not a real channel.
    allow: /^C0(?:ERRORS|STAGING|STGALT|NWIND|CONTOSO|OPSPRIV|INTERNAL|ENG|FIN)$|^C00000/,
  },
  {
    name: "UUID",
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    // Repeated-digit uuids only: 1111...,  2222..., 0000...
    allow: /^([0-9a-f])\1{7}-\1{4}-\1{4}-\1{4}-\1{12}$/i,
  },
  {
    name: "Slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    allow: /^$/,
  },
  {
    name: "private key block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    allow: /^$/,
  },
];

function tracked() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "");
}

/**
 * Files present on disk that git is ignoring, under `pathspec`.
 *
 * The pathspec is not a convenience: without it this enumerates every file in
 * node_modules and overflows execFileSync's default 1 MB buffer.
 */
function ignored(pathspec) {
  return execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", pathspec],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((f) => f !== "");
}

const files = tracked();
const problems = [];

/**
 * No test fixture may be gitignored.
 *
 * This check exists because the opposite happened: `.gitignore` carried a bare
 * `tenants.yaml`, which matches at every depth, so `test/fixtures/tenants.yaml`
 * was silently excluded. The suite passed locally against a file that had never
 * been committed and failed on a fresh clone — the one failure mode a green
 * local run cannot show you.
 */
for (const file of ignored("test/")) {
  problems.push(
    `${file} is gitignored but lives under test/. The suite would pass here and fail on a fresh clone — anchor the .gitignore pattern with a leading slash so it only matches the repo root.`,
  );
}

for (const forbidden of NEVER_TRACKED) {
  if (files.includes(forbidden)) {
    problems.push(
      `${forbidden} is tracked by git. It holds a real deployment and is gitignored for that reason — remove it with \`git rm --cached ${forbidden}\`.`,
    );
  }
}

for (const file of files) {
  if (IGNORED_FILES.includes(file)) continue;
  if (file.endsWith(".png") || file.endsWith(".jpg") || file.endsWith(".ico")) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable; nothing to scan
  }

  for (const { name, re, allow } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[0];
      if (allow.test(value)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line} looks like a live ${name}: ${value}`);
    }
  }
}

if (problems.length > 0) {
  console.error("leak check failed:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nIf one of these is genuinely a placeholder, widen the allow pattern in" +
      "\ninfra/leakcheck.mjs — deliberately, and in a reviewed diff.\n",
  );
  process.exit(1);
}

console.error(`leak check passed (${String(files.length)} tracked files)`);
