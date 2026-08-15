// ============================================================================
// UFC: rating construction from the bout history (including the two-rows-per-
// bout shape and the two `winner` conventions), fighter matching, matchup
// features, and the refusal to model markets the data cannot support.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFighterElo,
  matchupFeatures,
  UFCModel,
  UFC_FEATURES,
  UFC_FIT_FEATURES,
  type UfcCtxData,
} from "../supabase/functions/model_predict/models/ufc.ts";
import { matchesOf, ratingOf } from "../supabase/functions/model_predict/core/elo.ts";
import { eventRows, makeFakeDeps } from "./helpers.ts";

const FIGHTERS = [
  "Jon Jones", "Islam Makhachev", "Alexander Volkanovski", "Leon Edwards",
  "Sean O'Malley", "Alex Pereira", "Israel Adesanya", "Charles Oliveira",
  "Dustin Poirier", "Max Holloway", "Tom Aspinall", "Ilia Topuria",
];

/** Bouts written the way ufc.fighter_fights stores them: ONE ROW PER CORNER,
 *  so every bout appears twice. */
function bouts(n: number, semantics: "winner_id" | "result_string") {
  const rows: any[] = [];
  for (let i = 0; i < n; i++) {
    const a = i % FIGHTERS.length;
    const b = (i * 5 + 3) % FIGHTERS.length;
    if (a === b) continue;
    const upset = i % 6 === 0;
    const winnerIdx = (a < b) === !upset ? a : b;
    const loserIdx = winnerIdx === a ? b : a;
    const date = new Date(Date.UTC(2018, 0, 1 + Math.floor(i / 2))).toISOString().slice(0, 10);
    const mk = (self: number, opp: number) => ({
      fighter_id: `f${self}`,
      opponent_id: `f${opp}`,
      date,
      winner: semantics === "winner_id" ? `f${winnerIdx}` : (self === winnerIdx ? "win" : "loss"),
      method: i % 3 === 0 ? "KO/TKO" : "Decision",
      round: 3,
      went_distance: i % 3 !== 0,
    });
    rows.push(mk(winnerIdx, loserIdx), mk(loserIdx, winnerIdx));
  }
  return rows;
}

function ufcDeps(opts: {
  signals?: any[];
  semantics?: "winner_id" | "result_string";
  n?: number;
  missingSchema?: boolean;
  noCareerStats?: boolean;
} = {}) {
  const sem = opts.semantics ?? "winner_id";
  return makeFakeDeps({
    tables: { "signals?": opts.signals ?? [], "model_parameters?": [] },
    schemas: opts.missingSchema ? {} : {
      "ufc:fighters?select=fighter_id,full_name": FIGHTERS.map((n, i) => ({
        fighter_id: `f${i}`,
        full_name: n,
        division: "Lightweight",
        stance: i % 4 === 0 ? "Southpaw" : "Orthodox",
        height_inches: 70 + (i % 5),
        reach_inches: 72 + (i % 7),
        age: 28 + (i % 8),
        wins: 20 - i, losses: 2 + i, draws: 0,
      })),
      "ufc:fighters?select=fighter_id,stance": FIGHTERS.map((_, i) => ({
        fighter_id: `f${i}`,
        stance: i % 4 === 0 ? "Southpaw" : "Orthodox",
        reach_inches: 72 + (i % 7),
        age: 28 + (i % 8),
      })),
      "ufc:fighter_fights?select=": bouts(opts.n ?? 700, sem),
      ...(opts.noCareerStats ? {} : {
        "ufc:fighter_career_stats?select=": FIGHTERS.map((_, i) => ({
          fighter_id: `f${i}`,
          slpm: 3.5 + i * 0.2, sapm: 3.0 + (i % 4) * 0.3,
          striking_accuracy: 45 + i, striking_defense: 55 + (i % 10),
          takedown_avg: 1.2 + (i % 5) * 0.4, takedown_accuracy: 40 + i,
          takedown_defense: 60 + (i % 9) * 2, submission_avg: 0.5 + (i % 3) * 0.3,
          knockdown_avg: 0.4 + (i % 4) * 0.2, control_time_avg: 90 + i * 5,
        })),
      }),
      "ufc:fighter_style_metrics?select=": FIGHTERS.map((_, i) => ({
        fighter_id: `f${i}`,
        primary_style: i % 2 === 0 ? "striker" : "wrestler",
        distance_striker: i % 2, pressure_striker: (i + 1) % 2, counter_striker: i % 3 === 0 ? 1 : 0,
        wrestler: (i + 1) % 2, submission_specialist: i % 5 === 0 ? 1 : 0, grappler: (i + 1) % 2,
        high_output: i % 2, power_striker: i % 3 === 0 ? 1 : 0,
        durability_score: 0.5 + (i % 5) * 0.08, finisher: i % 2,
      })),
      "ufc:fighter_derived_metrics?select=": FIGHTERS.map((_, i) => ({
        fighter_id: `f${i}`,
        finish_rate: 0.4 + (i % 5) * 0.05, finish_rate_last5: 0.4,
        win_streak: i % 4, loss_streak: 0,
        days_since_last_fight: 120 + i * 10, activity_last365: 2,
        title_fight_experience: i < 3 ? 3 : 0,
        opponent_average_win_pct: 0.55 + (i % 4) * 0.03,
        average_fight_time: 700,
      })),
    },
    missing: opts.missingSchema ? ["ufc:"] : [],
  });
}

function mmaSignals(pairs: Array<[string, string, string, string]>) {
  return pairs.flatMap(([id, red, blue, when]) => {
    const rows = eventRows(id, red, blue, when, { sportKey: "mma_mixed_martial_arts" });
    for (const r of rows) r.sport_title = "MMA";
    return rows;
  });
}

// ---------------------------------------------------------------------------

test("both `winner` conventions are detected rather than assumed", () => {
  const byId = buildFighterElo(bouts(400, "winner_id"));
  const byResult = buildFighterElo(bouts(400, "result_string"));
  assert.equal(byId.semantics, "winner_id");
  assert.equal(byResult.semantics, "result_string");
  // the same fixture read two ways must produce the same ratings
  for (const id of ["f0", "f5", "f11"]) {
    assert.ok(Math.abs(ratingOf(byId.elo, id) - ratingOf(byResult.elo, id)) < 1e-9, `${id} rates the same either way`);
  }
});

test("the two corner rows of one bout update the rating once", () => {
  const raw = bouts(200, "winner_id");
  const built = buildFighterElo(raw);
  assert.equal(raw.length, built.used * 2, "every bout arrived twice and was counted once");
  let total = 0;
  for (const [, n] of built.elo.matches) total += n;
  assert.equal(total, built.used * 2, "each bout moved exactly two fighters");
});

test("an uninterpretable winner column produces no rating at all", () => {
  const built = buildFighterElo([{ fighter_id: "a", opponent_id: "b", date: "2020-01-01", winner: "somebody else" }]);
  assert.equal(built.semantics, "unknown");
  assert.equal(built.used, 0);
});

test("draws and no-contests move nobody's rating", () => {
  const rows = [
    { fighter_id: "a", opponent_id: "b", date: "2020-01-01", winner: "a" },
    { fighter_id: "b", opponent_id: "a", date: "2020-01-01", winner: "a" },
    { fighter_id: "a", opponent_id: "c", date: "2020-02-01", winner: "draw" },
    { fighter_id: "c", opponent_id: "a", date: "2020-02-01", winner: "draw" },
  ];
  const built = buildFighterElo(rows);
  assert.equal(built.used, 1, "only the decisive bout counts");
  assert.equal(matchesOf(built.elo, "c"), 0, "the drawn fighter is unrated");
});

test("matchup features are interactions, not averages", async () => {
  const deps = ufcDeps();
  const ctx = await UFCModel.loadContext(deps, []);
  assert.equal(ctx.status, "ok", ctx.detail);
  const d = ctx.data as unknown as UfcCtxData;

  const { values, missing } = matchupFeatures(d, "f0", "f5", "2026-09-01T02:00:00Z");
  assert.equal(values.length, UFC_FEATURES.length);
  assert.equal(missing.length, 0, "the fixture carries every optional table");

  const iStrike = UFC_FEATURES.indexOf("strike_output_edge");
  const iStance = UFC_FEATURES.indexOf("stance_mismatch");
  const iTd = UFC_FEATURES.indexOf("takedown_pressure_edge");

  // f0 is southpaw, f5 orthodox -> the mismatch is coded from f0's side
  assert.equal(values[iStance], 1);
  const flipped = matchupFeatures(d, "f5", "f0", "2026-09-01T02:00:00Z");
  assert.equal(flipped.values[iStance], -1, "the coding is antisymmetric");
  assert.ok(Math.abs(values[iStrike] + flipped.values[iStrike]) < 1e-9, "striking edge is antisymmetric");
  assert.ok(Math.abs(values[iTd] + flipped.values[iTd]) < 1e-9, "takedown pressure is antisymmetric");

  /* The interaction, not the average: raising the opponent's takedown DEFENCE
     must lower A's takedown pressure even though A's own numbers are untouched. */
  const base = matchupFeatures(d, "f0", "f5", null).values[iTd];
  d.career.set("f5", { ...d.career.get("f5"), takedown_defense: 95 });
  const stiffer = matchupFeatures(d, "f0", "f5", null).values[iTd];
  assert.ok(stiffer < base, "a better takedown defence blunts the same offence");
});

test("missing fighter statistics are reported, not defaulted silently", async () => {
  const deps = ufcDeps({ noCareerStats: true });
  const ctx = await UFCModel.loadContext(deps, []);
  assert.equal(ctx.status, "ok", "the rating still works without the optional tables");
  const d = ctx.data as unknown as UfcCtxData;
  assert.equal(d.career.size, 0);
  const { missing } = matchupFeatures(d, "f0", "f5", null);
  assert.ok(missing.indexOf("career_striking_grappling_stats") >= 0);
});

test("a fight resolves both corners and predicts both sides", async () => {
  const signals = mmaSignals([["evt-1", "Jon Jones", "Alex Pereira", "2026-09-01T02:00:00Z"]]);
  const deps = ufcDeps({ signals });
  const ctx = await UFCModel.loadContext(deps, signals);
  const built = await UFCModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 1, JSON.stringify(built.skipped));
  const preds = await UFCModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  assert.equal(preds.length, 2);
  assert.ok(Math.abs(preds[0].model_prob + preds[1].model_prob - 1) < 1e-12);
  const detail = preds[0].detail as any;
  assert.equal(detail.basis, "fighter_elo");
  assert.ok(detail.matchup.strike_output_edge != null, "the full matchup is stored for audit");
});

test("an unknown fighter is skipped rather than matched to the nearest name", async () => {
  const signals = mmaSignals([["evt-1", "Some Regional Prospect", "Alex Pereira", "2026-09-01T02:00:00Z"]]);
  const deps = ufcDeps({ signals });
  const ctx = await UFCModel.loadContext(deps, signals);
  const built = await UFCModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.skipped[0].reason, "missing_participant");
});

test("a fighter with too few rated bouts is skipped with insufficient_sample", async () => {
  const signals = mmaSignals([["evt-1", "Jon Jones", "Alex Pereira", "2026-09-01T02:00:00Z"]]);
  const deps = ufcDeps({ signals });
  const ctx = await UFCModel.loadContext(deps, signals);
  const built = await UFCModel.buildEvents(deps, signals, ctx);
  const d = ctx.data as unknown as UfcCtxData;
  d.elo.matches.set((built.events[0].event.extra as any).homeId, 1);
  const v = UFCModel.validateContext(built.events[0].event, ctx);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "insufficient_sample");
});

test("a rematch is a separate event and both are predicted", async () => {
  const signals = mmaSignals([
    ["evt-1", "Jon Jones", "Alex Pereira", "2026-09-01T02:00:00Z"],
    ["evt-2", "Jon Jones", "Alex Pereira", "2027-03-01T02:00:00Z"],
  ]);
  const deps = ufcDeps({ signals });
  const ctx = await UFCModel.loadContext(deps, signals);
  const built = await UFCModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 2);
  assert.deepEqual(built.events.map((e) => e.event.event_id).sort(), ["evt-1", "evt-2"]);
});

test("an unreadable ufc schema yields insufficient_data", async () => {
  const signals = mmaSignals([["evt-1", "Jon Jones", "Alex Pereira", "2026-09-01T02:00:00Z"]]);
  const deps = ufcDeps({ signals, missingSchema: true });
  const ctx = await UFCModel.loadContext(deps, signals);
  assert.equal(ctx.status, "insufficient_data");
  assert.match(ctx.detail ?? "", /Exposed schemas|unreadable/);
});

test("a thin bout history yields insufficient_data rather than a rating built on nothing", async () => {
  const deps = ufcDeps({ n: 40 });
  const ctx = await UFCModel.loadContext(deps, []);
  assert.equal(ctx.status, "insufficient_data");
  assert.ok((ctx.missing ?? []).some((m) => m.indexOf("fighter_fights") >= 0));
});

test("method, round, distance and prop markets are refused", () => {
  for (const m of ["totals", "spreads", "method", "rounds", "sig_strikes"]) {
    assert.equal(UFCModel.supportsMarket(m), false, `${m} must be unsupported_by_model`);
  }
  assert.equal(UFCModel.supportsMarket("h2h"), true);
});

test("career averages are computed for audit but excluded from the fitted set", () => {
  assert.deepEqual(UFC_FIT_FEATURES, ["elo_diff", "reach_diff", "age_diff", "layoff_diff", "stance_mismatch"]);
  for (const leaky of ["strike_output_edge", "takedown_pressure_edge", "power_vs_durability", "opponent_quality_diff"]) {
    assert.ok(UFC_FEATURES.indexOf(leaky) >= 0, `${leaky} is computed`);
    assert.equal(UFC_FIT_FEATURES.indexOf(leaky), -1, `${leaky} must never be fitted on career-to-date values`);
  }
});

test("a prediction records that the unapplied features are unapplied", async () => {
  const signals = mmaSignals([["evt-1", "Jon Jones", "Alex Pereira", "2026-09-01T02:00:00Z"]]);
  const deps = ufcDeps({ signals });
  const ctx = await UFCModel.loadContext(deps, signals);
  const built = await UFCModel.buildEvents(deps, signals, ctx);
  const preds = await UFCModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  const detail = preds[0].detail as any;
  assert.ok(detail.features_computed_not_applied.indexOf("strike_output_edge") >= 0);
  assert.ok(preds[0].missing_features.some((m) => m.indexOf("as_of_date_career_stats") >= 0));
  assert.ok(preds[0].missing_features.indexOf("short_notice_flag") >= 0);
});
