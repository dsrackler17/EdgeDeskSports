#!/usr/bin/env node
// ============================================================================
//  FILE:  supabase/tests/run_node.mjs
//  RUN:   node --experimental-strip-types supabase/tests/run_node.mjs
//
//  Runs the UFC live-capture test cases under Node, so the logic can be
//  verified on a machine with no Deno installed — which is most machines, and
//  was the machine this was built on.
//
//  HOW IT WORKS, AND WHY IT IS NOT A SECOND COPY OF THE CODE.
//
//  supabase/functions/ufc_live_stats/index.ts must stay deployable exactly as
//  it is: one file, top-level `import ... from "https://esm.sh/..."`, the same
//  proven shape as capture/index.ts. Node cannot import an https specifier, so
//  it cannot import that module directly.
//
//  So this runner EXTRACTS the two marked regions from the real file —
//
//      PURE CORE START      ... PURE CORE END
//      TRANSPORT CORE START ... TRANSPORT CORE END
//
//  — writes them to a temporary module, and imports that. The code under test
//  is the real code, read off disk at run time. If someone edits the function,
//  this runs the edit. If someone moves logic out of the marked regions, the
//  extraction fails loudly rather than silently testing less.
// ============================================================================

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../functions/ufc_live_stats/index.ts");

function extract(src, label) {
  const start = src.indexOf(`${label} START`);
  const end = src.indexOf(`${label} END`);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Could not find the "${label}" markers in ${SRC}.\n` +
      `The runner extracts logic between these markers; if they were removed or ` +
      `reordered, the tests would silently cover less code, so this is a hard failure.`,
    );
  }
  // Content runs from the end of the START marker's comment block to the
  // start of the END marker's comment block. Anchoring on the comment
  // delimiters (rather than scanning for a blank line) keeps block comments
  // INSIDE the region intact — an earlier version cut at the first `/*` it
  // found and silently extracted only the first few functions.
  const from = src.indexOf("*/", start) + 2;
  const to = src.lastIndexOf("/*", end);
  if (from < 2 || to <= from) throw new Error(`Malformed "${label}" marker block in ${SRC}.`);
  return src.slice(from, to);
}

const src = readFileSync(SRC, "utf8");
const module = [
  "// AUTO-EXTRACTED from supabase/functions/ufc_live_stats/index.ts — do not edit.",
  extract(src, "PURE CORE"),
  extract(src, "TRANSPORT CORE"),
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "ufc-core-"));
const modPath = join(dir, "core.ts");
writeFileSync(modPath, module, "utf8");

const core = await import(pathToFileURL(modPath).href);
const { defineCases } = await import(pathToFileURL(resolve(here, "ufc_live_stats.cases.ts")).href);

/* ---- assertions ---------------------------------------------------------- */
const deepEq = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq(a[k], b[k]));
};
const show = (v) => {
  if (typeof v === "string") return JSON.stringify(v);
  try { return JSON.stringify(v); } catch { return String(v); }
};

class Failure extends Error {}
const assert = {
  eq(actual, expected, msg) {
    if (!deepEq(actual, expected)) {
      throw new Failure(`${msg ? msg + "\n      " : ""}expected ${show(expected)}\n      actual   ${show(actual)}`);
    }
  },
  is(actual, expected, msg) {
    if (actual !== expected) {
      throw new Failure(`${msg ? msg + "\n      " : ""}expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  ok(v, msg) { if (!v) throw new Failure(msg || `expected truthy, got ${show(v)}`); },
};

/* ---- run ----------------------------------------------------------------- */
const cases = defineCases(core);
let pass = 0;
const failures = [];

for (const c of cases) {
  try {
    await c.fn(assert);
    pass++;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${c.name}\n`);
  } catch (e) {
    failures.push({ name: c.name, err: e });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${c.name}\n      ${String(e.message).replace(/\n/g, "\n      ")}\n`);
  }
}

console.log(`\n${pass}/${cases.length} passed`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mall green\x1b[0m");
