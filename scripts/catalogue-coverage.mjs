#!/usr/bin/env node
/**
 * Catalogue traceability report.
 *
 * Reads SILVERLINE_BUSINESS_TEST_CATALOGUE.md as the source of truth, then
 * scans every test file in the workspace for the catalogue IDs. A catalogue is
 * only useful if you can tell, mechanically, which of its rows are actually
 * executed — otherwise "we implemented the catalogue" is an unverifiable claim.
 *
 * Exits non-zero when a P0 row has no test, matching the catalogue's own exit
 * criteria ("All P0 tests must pass"). P1 gaps are reported but do not fail the
 * run; the catalogue asks for those to carry a documented decision instead.
 *
 *   node scripts/catalogue-coverage.mjs           # human-readable report
 *   node scripts/catalogue-coverage.mjs --json    # machine-readable
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CATALOGUE = join(ROOT, "SILVERLINE_BUSINESS_TEST_CATALOGUE.md");

/** Directories that hold executable tests. */
const TEST_ROOTS = [
  "apps/api/test",
  "apps/web/tests",
  "apps/mobile/test",
  "packages/shared/src",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".expo", "build"]);

/** `| UT-AUTH-01 | P0 | ... |` — id and priority from a catalogue table row. */
const ROW = /^\|\s*((?:UT|E2E)-[A-Z0-9]+(?:-\d+)?)\s*\|\s*(P\d)\s*\|(.*)$/;

function parseCatalogue(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = ROW.exec(line.trim());
    if (!match) continue;
    const [, id, priority, rest] = match;
    const cells = rest.split("|").map((c) => c.trim());
    rows.push({
      id,
      priority,
      // E2E tables read `| id | priority | workflow | outcome | requirement |`
      // and unit tables `| id | priority | test | expected | requirement |`;
      // either way the first two cells after the priority are the description.
      title: cells[0] ?? "",
      expected: cells[1] ?? "",
      requirement: cells[2] ?? "",
    });
  }
  return rows;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (/\.test\.(ts|tsx|mts|js|mjs)$/.test(entry)) {
      yield full;
    }
  }
}

function collectReferences() {
  /** id → Set of repo-relative files naming it. */
  const found = new Map();
  for (const testRoot of TEST_ROOTS) {
    for (const file of walk(join(ROOT, testRoot))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\b((?:UT|E2E)-[A-Z0-9]+(?:-\d+)?)\b/g)) {
        const id = match[1];
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(relative(ROOT, file));
      }
    }
  }
  return found;
}

const rows = parseCatalogue(readFileSync(CATALOGUE, "utf8"));
const references = collectReferences();

const results = rows.map((row) => ({
  ...row,
  files: [...(references.get(row.id) ?? [])].sort(),
  covered: references.has(row.id),
}));

const missing = results.filter((r) => !r.covered);
const missingP0 = missing.filter((r) => r.priority === "P0");
const unknown = [...references.keys()].filter(
  (id) => !rows.some((row) => row.id === id),
);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        total: results.length,
        covered: results.length - missing.length,
        missing: missing.map((r) => ({ id: r.id, priority: r.priority })),
        unknown,
        rows: results,
      },
      null,
      2,
    ),
  );
} else {
  const byPriority = new Map();
  for (const row of results) {
    const bucket = byPriority.get(row.priority) ?? { total: 0, covered: 0 };
    bucket.total += 1;
    if (row.covered) bucket.covered += 1;
    byPriority.set(row.priority, bucket);
  }

  console.log("Silverline business test catalogue — traceability\n");
  for (const [priority, bucket] of [...byPriority].sort()) {
    const pct = ((bucket.covered / bucket.total) * 100).toFixed(0);
    console.log(`  ${priority}  ${bucket.covered}/${bucket.total} covered (${pct}%)`);
  }
  const pct = (((results.length - missing.length) / results.length) * 100).toFixed(0);
  console.log(
    `  all ${results.length - missing.length}/${results.length} covered (${pct}%)\n`,
  );

  if (missing.length > 0) {
    console.log("Not covered by any test:");
    for (const row of missing) {
      console.log(`  ${row.priority}  ${row.id}  ${row.title}`);
    }
    console.log("");
  }
  if (unknown.length > 0) {
    console.log(`Referenced but not in the catalogue: ${unknown.sort().join(", ")}\n`);
  }
}

if (missingP0.length > 0) {
  console.error(
    `catalogue-coverage: ${missingP0.length} P0 row(s) have no test: ` +
      missingP0.map((r) => r.id).join(", "),
  );
  process.exit(1);
}
