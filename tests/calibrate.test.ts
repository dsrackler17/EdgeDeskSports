// ============================================================================
// Fitting and calibration.
//
// The point of these tests is not that the numbers are good — it is that the
// numbers are HONEST: the holdout is chronological, the leaky features are
// refused, the frozen model cannot be refitted in place, and a dry run stores
// nothing.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyFit, fitLine, fitLogistic, metrics, reliability } from "../supabase/functions/model_predict/core/fit.ts";
import { calibrate } from "../supabase/functions/model_predict/core/calibrate.ts";
import { MODEL_REGISTRY } from "../supabase/functions/model_predict/core/registry.ts";
import { TENNIS_FIT_FEATURES } from "../supabase/functions/model_predict/models/tennis_engine.ts";
import { UFC_FIT_FEATURES } from "../supabase/functions/model_predict/models/ufc.ts";
import { sigmoid } from "../supabase/functions/model_predict/core/odds.ts";
import { makeFakeDeps } from "./helpers.ts";

// ---------------------------------------------------------------------------
// fit.ts
// ---------------------------------------------------------------------------

/** A deterministic pseudo-random stream so the fixtures are reproducible
 *  without importing the model's RNG into a test of the fitter. */
function stream(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("the fitter recovers a signal it was given", () => {
  const rnd = stream(7);
  const rows: number[][] = [];
  const labels: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const x1 = (rnd() - 0.5) * 4;
    const x2 = (rnd() - 0.5) * 4;
    const p = sigmoid(1.5 * x1 - 0.8 * x2);
    rows.push([x1, x2]);
    labels.push(rnd() < p ? 1 : 0);
  }
  const fit = fitLogistic(["x1", "x2"], rows, labels, { l2: 0.5, iterations: 6000, learningRate: 0.3 })!;
  assert.ok(fit, "a 3000-row sample fits");
  assert.ok(fit.weights[0] > 0, "the positive coefficient is positive");
  assert.ok(fit.weights[1] < 0, "the negative coefficient is negative");
  assert.ok(fit.test.brier < 0.25, `holdout Brier ${fit.test.brier.toFixed(4)} beats a coin flip`);
  assert.ok(Math.abs(fit.test.calibrationError) < 0.05, "and it is roughly calibrated");
});

test("the holdout is the chronological tail, never a random sample", () => {
  const rows: number[][] = [];
  const labels: number[] = [];
  // first half: x predicts 1. second half: x predicts 0. A random split would
  // hide the regime change; a tail split cannot.
  for (let i = 0; i < 2000; i++) {
    const x = i % 2 === 0 ? 1 : -1;
    rows.push([x]);
    labels.push(i < 1000 ? (x > 0 ? 1 : 0) : (x > 0 ? 0 : 1));
  }
  const fit = fitLogistic(["x"], rows, labels, { holdout: 0.2, iterations: 3000 })!;
  assert.equal(fit.nTest, 400);
  assert.equal(fit.nTrain, 1600);
  assert.ok(fit.test.accuracy < 0.5, "the regime change in the tail is visible, as it should be");
});

test("the fitter refuses a sample too small to support its own dimensions", () => {
  assert.equal(fitLogistic(["a", "b"], [[1, 1], [0, 0]], [1, 0]), null);
  assert.equal(fitLogistic([], [], []), null);
});

test("applyFit reuses the training standardisation", () => {
  const fit = { weights: [2], intercept: 0, mean: [10], sd: [5] };
  assert.ok(Math.abs(applyFit(fit, [10]) - 0.5) < 1e-12, "at the mean the score is the intercept");
  assert.ok(applyFit(fit, [15]) > 0.5);
  assert.ok(applyFit(fit, [5]) < 0.5);
});

test("metrics are the ones the spec asks for", () => {
  const m = metrics([0.9, 0.1, 0.8, 0.2], [1, 0, 1, 0]);
  assert.equal(m.n, 4);
  assert.ok(Math.abs(m.brier - 0.025) < 1e-9);
  assert.equal(m.accuracy, 1);
  assert.ok(m.logLoss > 0 && m.logLoss < 0.3);
  const perfect = metrics([1, 0], [1, 0]);
  assert.ok(Number.isFinite(perfect.logLoss), "log loss is clamped, not infinite");
});

test("reliability buckets predicted against realised", () => {
  const r = reliability([0.05, 0.15, 0.95, 0.95], [0, 0, 1, 1]);
  assert.equal(r.length, 10);
  assert.equal(r[0].n, 1);
  assert.equal(r[9].n, 2);
  assert.equal(r[9].realised, 1);
  assert.equal(r[0].realised, 0);
});

test("fitLine needs a real sample and a real spread", () => {
  assert.equal(fitLine([1, 2], [1, 2]), null, "two points is not a fit");
  assert.equal(fitLine(new Array(20).fill(3), new Array(20).fill(1)), null, "no variance, no slope");
  const line = fitLine([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25])!;
  assert.ok(Math.abs(line.b - 2) < 1e-9);
  assert.ok(Math.abs(line.a - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// calibrate.ts
// ---------------------------------------------------------------------------

test("the frozen MLB baseline cannot be refitted in place", async () => {
  const res = await calibrate(makeFakeDeps(), "baseball_mlb", MODEL_REGISTRY["baseball_mlb"], { dry: true });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /frozen baseline/);
});

test("NFL and WNBA have nothing to calibrate against and say so", async () => {
  for (const k of ["americanfootball_nfl", "basketball_wnba"]) {
    const res = await calibrate(makeFakeDeps(), k, MODEL_REGISTRY[k], { dry: true });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /No owned historical result table/);
  }
});

test("tennis calibration is walk-forward and reports against the plain-Elo baseline", async () => {
  const matches: any[] = [];
  const rnd = stream(21);
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const a = i % 24;
    let b = (i * 7 + 5) % 24;
    if (a === b) b = (b + 1) % 24;
    // lower index is stronger; the stronger side wins ~70% of the time
    const strongerIsA = a < b;
    const strongerWins = rnd() < 0.7;
    const winner = strongerIsA === strongerWins ? a : b;
    matches.push({
      match_id: `m${i}`,
      match_date: new Date(Date.UTC(2020, 0, 1 + Math.floor(i / 6))).toISOString().slice(0, 10),
      tourney_name: "Test Open",
      surface: ["Hard", "Clay", "Grass"][i % 3],
      level: "A", round: "R32",
      winner_id: `p${winner}`,
      loser_id: `p${winner === a ? b : a}`,
      minutes: 100,
    });
  }
  const stored: any[] = [];
  const deps = makeFakeDeps({ schemas: { "tennis:matches?select=match_id": matches } });
  const res = await calibrate(deps, "tennis_atp", MODEL_REGISTRY["tennis_atp"], {
    dry: false,
    upsert: async (table, rows) => {
      stored.push({ table, rows });
      return rows.length;
    },
  });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.fit?.features, TENNIS_FIT_FEATURES);
  assert.ok((res.fit?.n_train ?? 0) > 500);
  assert.ok(res.baseline, "the Elo baseline is scored on the same holdout");
  assert.ok(res.reliability, "and reliability by bucket is reported");
  assert.ok(res.note, "whether the fit actually beat the baseline is stated");

  assert.equal(stored.length, 1);
  assert.equal(stored[0].table, "model_parameters");
  assert.equal(stored[0].rows[0].model_version, "atp_match_v1");
  assert.equal(stored[0].rows[0].params.blend.weights.length, TENNIS_FIT_FEATURES.length);
  assert.ok(stored[0].rows[0].metrics.test, "the metrics that justified the weights are stored with them");
});

test("a dry calibration computes everything and stores nothing", async () => {
  const matches: any[] = [];
  for (let i = 0; i < 3000; i++) {
    const a = i % 20;
    let b = (i * 3 + 7) % 20;
    if (a === b) b = (b + 1) % 20;
    const winner = a < b ? (i % 5 === 0 ? b : a) : (i % 5 === 0 ? a : b);
    matches.push({
      match_id: `m${i}`,
      match_date: new Date(Date.UTC(2021, 0, 1 + Math.floor(i / 8))).toISOString().slice(0, 10),
      tourney_name: "Test Open", surface: "Hard", level: "A", round: "R32",
      winner_id: `q${winner}`, loser_id: `q${winner === a ? b : a}`, minutes: 100,
    });
  }
  let wrote = 0;
  const res = await calibrate(
    makeFakeDeps({ schemas: { "tennis:matches?select=match_id": matches } }),
    "tennis_wta",
    MODEL_REGISTRY["tennis_wta"],
    { dry: true, upsert: async () => { wrote++; return 0; } },
  );
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.written, false);
  assert.equal(wrote, 0);
  assert.equal(res.model_version, "wta_match_v1", "the WTA row is written under the WTA version");
});

test("calibration refuses a history too thin to hold out a tail", async () => {
  const res = await calibrate(
    makeFakeDeps({ schemas: { "tennis:matches?select=match_id": [] } }),
    "tennis_atp",
    MODEL_REGISTRY["tennis_atp"],
    { dry: true },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /matches in the last/);
});

test("the UFC fit uses only features that can be reconstructed as of the bout", () => {
  assert.deepEqual(UFC_FIT_FEATURES, ["elo_diff", "reach_diff", "age_diff", "layoff_diff", "stance_mismatch"]);
});
