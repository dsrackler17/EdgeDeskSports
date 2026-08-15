// ============================================================================
// The single-file build must be the same program as the module tree.
//
// A generated artifact that drifts from its source is worse than no artifact:
// it deploys, it runs, and it is quietly a different model. These tests make
// drift a build failure — the bundle is regenerated and compared, and the same
// slate under the same seed must produce byte-identical rows from both.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { runAll as runAllModules } from "../supabase/functions/model_predict/core/runner.ts";
import { runAll as runAllBundled, MODEL_REGISTRY as REG_BUNDLED } from "../supabase/functions/model_predict/bundled.index.ts";
import { MODEL_REGISTRY as REG_MODULES } from "../supabase/functions/model_predict/core/registry.ts";
import { makeRng } from "../supabase/functions/model_predict/core/rng.ts";
import { eventRows, makeFakeDeps, mlbSchedule, mlbTeamPayloads } from "./helpers.ts";

function deps(seed: number) {
  const t = mlbTeamPayloads();
  const signals = [
    ...eventRows("mlb-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5, sharpHome: 0.55 }),
    ...eventRows("mlb-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.5, sharpHome: 0.52 }),
  ];
  const d = makeFakeDeps({
    tables: { "signals?": signals, "model_parameters?": [] },
    http: {
      "/teams?sportId=1": t.teams,
      "group=hitting": t.hitting,
      "group=pitching&season": t.pitching,
      "/schedule?sportId=1": mlbSchedule([
        { gamePk: 1, gameDate: "2026-08-15T17:10:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 1 },
        { gamePk: 2, gameDate: "2026-08-15T23:40:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 2 },
      ]),
      "/people/": { stats: [{ splits: [{ stat: { inningsPitched: "150.1", strikeOuts: 170, baseOnBalls: 42, hitByPitch: 5, homeRuns: 17, gamesStarted: 25 } }] }] },
    },
  });
  d.rng = makeRng(seed);
  return d;
}

test("the committed single-file build is not stale", () => {
  // Regenerating and comparing is the only check that cannot be forgotten.
  execFileSync("node", ["scripts/bundle.mjs", "--check"], { stdio: "pipe" });
});

test("the bundle carries no import or re-export statements", () => {
  const src = fs.readFileSync("supabase/functions/model_predict/bundled.index.ts", "utf8");
  assert.equal(/^import\s/m.test(src), false, "a surviving import would fail to resolve in Deno");
  assert.equal(/^export\s*\{/m.test(src), false, "a surviving re-export would be a duplicate export");
});

test("the bundle registers the same six sports with the same versions", () => {
  const a = Object.keys(REG_MODULES).sort();
  const b = Object.keys(REG_BUNDLED as Record<string, unknown>).sort();
  assert.deepEqual(b, a);
  for (const k of a) {
    assert.equal(
      (REG_BUNDLED as any)[k].modelVersion,
      (REG_MODULES as any)[k].modelVersion,
      `${k} model version matches`,
    );
    assert.equal((REG_BUNDLED as any)[k].uiLabel, (REG_MODULES as any)[k].uiLabel);
  }
});

test("the same slate under the same seed produces identical rows from both builds", async () => {
  const fromModules = await runAllModules(deps(4242), { dry: true, upsert: async () => 0 });
  const fromBundle = await (runAllBundled as typeof runAllModules)(deps(4242), { dry: true, upsert: async () => 0 });

  assert.equal(fromBundle.rowsBuilt, fromModules.rowsBuilt);
  assert.equal(fromBundle.errors.length, 0);

  const key = (r: any) => `${r.model_version}|${r.event_id}|${r.market}|${r.selection}|${r.point}`;
  const mod = fromModules.samples.map((r) => [key(r), r.model_prob, r.model_fair_american, r.model_edge, r.model_ev]);
  const bun = fromBundle.samples.map((r) => [key(r), r.model_prob, r.model_fair_american, r.model_edge, r.model_ev]);
  assert.deepEqual(bun, mod, "probabilities, fair prices, gaps and EVs all match");

  for (const k of Object.keys(fromModules.sports)) {
    const m = fromModules.sports[k];
    const b = fromBundle.sports[k];
    assert.equal(b.status, m.status, `${k} status`);
    assert.equal(b.rows_built, m.rows_built, `${k} rows_built`);
    assert.equal(b.predicted, m.predicted, `${k} predicted`);
    assert.equal(b.skipped.length, m.skipped.length, `${k} skipped`);
  }
});

test("the bundle does not start a server on import", () => {
  // index.ts guards Deno.serve behind optional chaining precisely so importing
  // the bundle in a test runner is inert. If that guard is ever removed, every
  // test file importing it would hang instead of failing loudly.
  const src = fs.readFileSync("supabase/functions/model_predict/bundled.index.ts", "utf8");
  assert.match(src, /Deno\?\.serve\?\.\(/, "the Deno.serve call stays optional-chained");
});
