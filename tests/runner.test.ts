// ============================================================================
// The unified runner: dry-run safety, sport isolation, per-sport telemetry,
// the sport filter, and reproducibility under a seed.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAll, runSport, windowFor } from "../supabase/functions/model_predict/core/runner.ts";
import { MODEL_REGISTRY } from "../supabase/functions/model_predict/core/registry.ts";
import { makeRng } from "../supabase/functions/model_predict/core/rng.ts";
import { eventRows, makeFakeDeps, mlbSchedule, mlbTeamPayloads, type FakeDeps } from "./helpers.ts";

const MLB_SIGNALS = [
  ...eventRows("evt-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5, sharpHome: 0.55 }),
  ...eventRows("evt-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.5, sharpHome: 0.52 }),
];

const TENNIS_SIGNALS = (() => {
  const rows = eventRows("evt-atp", "Carlos Alcaraz", "Casper Ruud", "2026-08-16T15:00:00Z", { sportKey: "tennis_atp_cincinnati_open" });
  for (const r of rows) r.sport_title = "ATP Cincinnati Open";
  return rows;
})();

const WNBA_SIGNALS = (() => {
  const rows = eventRows("evt-wnba", "Las Vegas Aces", "Chicago Sky", "2026-08-16T00:00:00Z", { sportKey: "basketball_wnba", total: 165.5 });
  for (const r of rows) r.sport_title = "WNBA";
  return rows;
})();

function fullDeps(extra: { failSport?: string } = {}): FakeDeps {
  const t = mlbTeamPayloads();
  const deps = makeFakeDeps({
    tables: {
      "signals?": [...MLB_SIGNALS, ...TENNIS_SIGNALS, ...WNBA_SIGNALS],
      "model_parameters?": [],
    },
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
  if (extra.failSport) {
    const inner = deps.sbGet;
    deps.sbGet = async (path: string) => {
      if (path.indexOf(`sport_key=like.${encodeURIComponent(extra.failSport!)}`) >= 0) {
        throw new Error("simulated PostgREST outage");
      }
      return inner(path);
    };
  }
  return deps;
}

test("a dry run performs every calculation and writes nothing", async () => {
  const deps = fullDeps();
  let upsertCalls = 0;
  const out = await runAll(deps, {
    dry: true,
    upsert: async (rows) => {
      upsertCalls++;
      return rows.length;
    },
  });
  assert.equal(upsertCalls, 0, "the writer was never called");
  assert.equal(out.rowsWritten, 0);
  assert.ok(out.rowsBuilt > 0, "but rows were still built");
  assert.ok(out.samples.length > 0, "and samples are available for inspection");
  assert.ok(deps.calls.some((c) => c.indexOf("jget:https://statsapi.mlb.com") === 0), "MLB data was really fetched");
});

test("a live run writes exactly the rows it built", async () => {
  const deps = fullDeps();
  let written: unknown[] = [];
  const out = await runAll(deps, {
    dry: false,
    upsert: async (rows) => {
      written = written.concat(rows);
      return rows.length;
    },
  });
  assert.equal(written.length, out.rowsBuilt);
  assert.equal(out.rowsWritten, out.rowsBuilt);
});

test("every sport reports, and one sport's failure does not stop the others", async () => {
  const out = await runAll(fullDeps({ failSport: "tennis_atp" }), { dry: true, upsert: async () => 0 });
  assert.deepEqual(Object.keys(out.sports).sort(), [
    "americanfootball_nfl", "baseball_mlb", "basketball_wnba",
    "mma_mixed_martial_arts", "tennis_atp", "tennis_wta",
  ]);
  assert.equal(out.sports["tennis_atp"].status, "error");
  assert.match(out.sports["tennis_atp"].error ?? "", /simulated PostgREST outage/);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].sport, "tennis_atp");
  assert.equal(out.sports["baseball_mlb"].status, "ok", "MLB is unaffected");
  assert.ok(out.sports["baseball_mlb"].rows_built > 0);
});

test("a sport with no usable context reports insufficient_data and every event it could not predict", async () => {
  const out = await runAll(fullDeps(), { dry: true, upsert: async () => 0 });
  const wnba = out.sports["basketball_wnba"];
  assert.equal(wnba.status, "insufficient_data");
  assert.equal(wnba.rows_built, 0);
  assert.equal(wnba.market_events, 1, "the captured game is still counted");
  assert.equal(wnba.skipped[0].reason, "model_context_failed");
  assert.ok(wnba.data_quality.missing?.length, "the missing columns are named");
  assert.ok(wnba.data_quality.contract?.length, "and the full data contract rides along");
});

test("telemetry carries the fields the spec requires, per sport", async () => {
  const out = await runAll(fullDeps(), { dry: true, upsert: async () => 0 });
  for (const key of Object.keys(out.sports)) {
    const t = out.sports[key];
    for (const f of ["model_version", "ui_label", "status", "scheduled", "eligible", "predicted", "rows_built", "rows_written", "market_events", "matched_events"]) {
      assert.ok(f in t, `${key} telemetry has ${f}`);
    }
    assert.ok(Array.isArray(t.skipped));
    assert.ok(Array.isArray(t.unmatched_events));
  }
  const mlb = out.sports["baseball_mlb"];
  assert.equal(mlb.matched_events, 2, "both doubleheader games are matched");
  assert.equal(mlb.predicted, 2);
  assert.ok((mlb.extra as any).doubleheaders.dh_market_events >= 2, "MLB keeps its doubleheader telemetry");
});

test("a market event that produced no row is named in unmatched_events", async () => {
  const deps = fullDeps();
  const out = await runSport(deps, "tennis_atp", MODEL_REGISTRY["tennis_atp"]);
  assert.equal(out.telemetry.market_events, 1);
  assert.equal(out.telemetry.rows_built, 0, "no tennis schema in this fixture");
  assert.equal(out.telemetry.unmatched_events[0].event_id, "evt-atp");
});

test("the sport filter runs exactly one model", async () => {
  const out = await runAll(fullDeps(), { dry: true, sportFilter: "baseball_mlb", upsert: async () => 0 });
  assert.deepEqual(Object.keys(out.sports), ["baseball_mlb"]);
  assert.ok(out.rowsBuilt > 0);
});

test("each sport reads only its own captured rows", async () => {
  const deps = fullDeps();
  await runSport(deps, "baseball_mlb", MODEL_REGISTRY["baseball_mlb"]);
  const signalReads = deps.calls.filter((c) => c.indexOf("sbGet:signals?") === 0);
  assert.ok(signalReads.length > 0);
  assert.ok(
    signalReads.every((c) => c.indexOf("sport_key=like.baseball_mlb") >= 0),
    "the MLB run never asked for another sport's rows",
  );
});

test("the run window is per sport, so a weekly league is not invisible", () => {
  assert.equal(windowFor("baseball_mlb").aheadHours, 30, "MLB keeps the v1.2 window");
  assert.ok(windowFor("americanfootball_nfl").aheadHours >= 168, "a week of NFL is in view");
  assert.ok(windowFor("mma_mixed_martial_arts").aheadHours >= 168);
  assert.ok(windowFor("tennis_atp").aheadHours >= 48);
});

test("the same seed reproduces the same probabilities end to end", async () => {
  const run = async (seed: number) => {
    const deps = fullDeps();
    deps.rng = makeRng(seed);
    const out = await runSport(deps, "baseball_mlb", MODEL_REGISTRY["baseball_mlb"]);
    return out.rows.map((r) => `${r.event_id}|${r.market}|${r.selection}|${r.model_prob}`);
  };
  const a = await run(4242);
  const b = await run(4242);
  const c = await run(999);
  assert.deepEqual(a, b, "identical seed, identical output");
  assert.notDeepEqual(a, c, "a different seed explores a different stream");
});

test("every written row carries the audit fields a reader needs months later", async () => {
  const deps = fullDeps();
  const out = await runSport(deps, "baseball_mlb", MODEL_REGISTRY["baseball_mlb"]);
  assert.ok(out.rows.length > 0);
  for (const r of out.rows) {
    assert.equal(r.model_version, "mlb_runs_v1.2_nbinom_dh");
    assert.equal(r.sport_key, "baseball_mlb");
    assert.ok(r.event_id);
    assert.ok(r.commence_time);
    assert.ok(r.model_prob > 0 && r.model_prob < 1);
    assert.ok(Number.isFinite(r.model_fair_american));
    assert.ok(["HIGH", "MEDIUM", "LOW"].indexOf(r.context_quality) >= 0);
    assert.ok(Array.isArray(r.missing_features));
    assert.ok(r.feature_snapshot_id, "the exact input set is identified");
    assert.ok(r.data_as_of, "and timestamped");
    assert.ok(r.model_detail, "with the model's own diagnostics attached");
  }
  const ids = new Set(out.rows.map((r) => r.event_id));
  assert.equal(ids.size, 2, "the doubleheader's two games stay separate all the way to the row");
});
