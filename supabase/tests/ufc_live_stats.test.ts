// ============================================================================
//  FILE:  supabase/tests/ufc_live_stats.test.ts
//  RUN:   deno test --allow-env --allow-net supabase/tests/ufc_live_stats.test.ts
//
//  The canonical runner. Imports the REAL module — not an extract — so it
//  covers the module exactly as deployed, including the parts the Node runner
//  cannot reach (the https import, the adapters, Deno.serve wiring).
//
//  The assertions themselves live in ufc_live_stats.cases.ts and are shared
//  with supabase/tests/run_node.mjs, so the two runners can never disagree
//  about what correct looks like.
//
//  UFC_LIVE_STATS_NO_SERVE stops the module starting an HTTP server on import,
//  which would otherwise hold the test process open forever.
// ============================================================================

Deno.env.set("UFC_LIVE_STATS_NO_SERVE", "1");

import { assertEquals, assert as denoAssert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as core from "../functions/ufc_live_stats/index.ts";
import { defineCases, type Assert } from "./ufc_live_stats.cases.ts";

const assert: Assert = {
  eq(actual, expected, msg) { assertEquals(actual as any, expected as any, msg); },
  is(actual, expected, msg) { assertEquals(actual as any, expected as any, msg); },
  ok(v, msg) { denoAssert(!!v, msg); },
};

for (const c of defineCases(core)) {
  Deno.test(c.name, async () => { await c.fn(assert); });
}

/* ---- coverage the Node extract cannot reach ----------------------------- */

Deno.test("BUILD is exported and stable", () => {
  denoAssert(typeof core.BUILD === "string" && core.BUILD.length > 0);
});

Deno.test("the canonical stat contract has not silently shrunk", () => {
  // A field quietly dropped from STAT_FIELDS would stop being snapshotted,
  // stop being hashed, and stop being written — without any error anywhere.
  const required = [
    "sig_strikes_landed", "sig_strikes_attempted",
    "total_strikes_landed", "total_strikes_attempted",
    "head_strikes_landed", "body_strikes_landed", "leg_strikes_landed",
    "distance_strikes_landed", "clinch_strikes_landed", "ground_strikes_landed",
    "takedowns_landed", "takedowns_attempted", "takedowns_pct",
    "submission_attempts", "reversals", "control_seconds", "knockdowns",
  ];
  for (const f of required) {
    denoAssert(core.STAT_FIELDS.includes(f as any), `${f} is missing from STAT_FIELDS`);
  }
});

Deno.test("every alias resolves to a real canonical field", () => {
  // A typo on the right-hand side of STAT_ALIASES would map a source key onto a
  // column that does not exist, and the value would vanish with no error.
  for (const [alias, slot] of Object.entries(core.STAT_ALIASES)) {
    const s = core.canonicalStatSlot(alias);
    denoAssert(s !== null, `alias ${alias} did not resolve`);
    if (s && s.kind === "field") {
      denoAssert(core.STAT_FIELDS.includes(s.field), `alias ${alias} -> unknown field ${s.field}`);
    } else if (s && s.kind === "pair") {
      denoAssert(core.STAT_FIELDS.includes(`${s.base}_landed` as any), `alias ${alias} -> unknown ${s.base}_landed`);
      denoAssert(core.STAT_FIELDS.includes(`${s.base}_attempted` as any), `alias ${alias} -> unknown ${s.base}_attempted`);
    }
    void slot;
  }
});
