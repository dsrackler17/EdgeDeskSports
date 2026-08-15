// ============================================================================
// NFL and WNBA.
//
// Two things are being proven here at once:
//
//   1. THE MODELS ARE REAL. Given the team-feature rows they declare, they
//      produce moneyline, spread and total probabilities from sport-appropriate
//      score distributions — NFL from touchdown/field-goal counts (so the key
//      numbers exist), WNBA from per-possession scoring.
//
//   2. THEY REFUSE TO RUN WITHOUT THEM. On the database as it stands today
//      neither table exists, and the models return insufficient_data with the
//      missing columns named rather than a plausible probability.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { drawScore, expectedPoints, NFLModel, NFL_REQUIRED_COLUMNS, type NflCtxData } from "../supabase/functions/model_predict/models/nfl.ts";
import { drawTeamPoints, gameShape, WNBAModel, WNBA_REQUIRED_COLUMNS, type WnbaCtxData } from "../supabase/functions/model_predict/models/wnba.ts";
import { makeRng } from "../supabase/functions/model_predict/core/rng.ts";
import { nrm } from "../supabase/functions/model_predict/core/names.ts";
import { eventRows, makeFakeDeps } from "./helpers.ts";

// ---------------------------------------------------------------------------
// NFL
// ---------------------------------------------------------------------------

const NFL_TEAMS = [
  { team: "Kansas City Chiefs", off: 0.14, def: -0.06 },
  { team: "Denver Broncos", off: -0.05, def: 0.02 },
  { team: "Buffalo Bills", off: 0.11, def: -0.04 },
  { team: "New York Jets", off: -0.09, def: -0.03 },
  { team: "San Francisco 49ers", off: 0.09, def: -0.07 },
  { team: "Arizona Cardinals", off: -0.02, def: 0.05 },
];

function nflRows() {
  return NFL_TEAMS.map((t) => ({
    team: t.team,
    team_norm: nrm(t.team),
    off_epa_play: t.off,
    def_epa_play: t.def,
    plays_per_game: 63,
    points_for_pg: 22.5 + t.off * 60,
    updated_at: "2026-09-10T12:00:00Z",
  }));
}

function nflDeps(opts: { signals?: any[]; withTable?: boolean } = {}) {
  return makeFakeDeps({
    tables: {
      "signals?": opts.signals ?? [],
      ...(opts.withTable ? { "nfl_team_features?": nflRows() } : {}),
    },
    missing: opts.withTable ? [] : ["nfl_team_features", "game_stats"],
  });
}

function nflSignals() {
  const rows = eventRows("evt-nfl", "Kansas City Chiefs", "Denver Broncos", "2026-09-14T17:00:00Z", {
    sportKey: "americanfootball_nfl",
    total: 44.5,
    spread: -6.5,
    sharpHome: 0.72,
  });
  for (const r of rows) r.sport_title = "NFL";
  return rows;
}

test("NFL: without a team-features table the model writes nothing and names what is missing", async () => {
  const ctx = await NFLModel.loadContext(nflDeps({ signals: nflSignals() }), []);
  assert.equal(ctx.status, "insufficient_data");
  assert.deepEqual(ctx.missing, NFL_REQUIRED_COLUMNS);
  assert.match(ctx.detail ?? "", /nfl_team_features/);
});

test("NFL: a captured slate with no context is still reported, event by event", async () => {
  const signals = nflSignals();
  const deps = nflDeps({ signals });
  const ctx = await NFLModel.loadContext(deps, signals);
  const built = await NFLModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.scheduled, 1, "the game is visible even though it cannot be predicted");
  assert.equal(built.skipped[0].reason, "model_context_failed");
});

test("NFL: with the table populated, expected points reflect the specific opponent", async () => {
  const deps = nflDeps({ withTable: true });
  const ctx = await NFLModel.loadContext(deps, []);
  assert.equal(ctx.status, "ok", ctx.detail);
  const d = ctx.data as unknown as NflCtxData;

  const strongVsWeak = expectedPoints(d, nrm("Kansas City Chiefs"), nrm("New York Jets"))!;
  const weakVsStrong = expectedPoints(d, nrm("New York Jets"), nrm("Kansas City Chiefs"))!;
  assert.ok(strongVsWeak.home > strongVsWeak.away, "the better team is expected to score more");
  assert.ok(strongVsWeak.home > weakVsStrong.away, "home field is worth something");

  /* The opponent's DEFENCE has to matter, not just the offence's own rating. */
  const vsGoodD = expectedPoints(d, nrm("Kansas City Chiefs"), nrm("San Francisco 49ers"))!;
  const vsBadD = expectedPoints(d, nrm("Kansas City Chiefs"), nrm("Arizona Cardinals"))!;
  assert.ok(vsGoodD.home < vsBadD.home, "the same offence scores less against a better defence");
});

test("NFL: the score distribution puts real mass on the key numbers", () => {
  const rng = makeRng(7);
  const margins = new Map<number, number>();
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const h = drawScore(rng, 24, 0.62, 1.15);
    const a = drawScore(rng, 21, 0.62, 1.15);
    const m = h - a;
    margins.set(m, (margins.get(m) ?? 0) + 1);
  }
  const at = (m: number) => (margins.get(m) ?? 0) / N;
  assert.ok(at(3) > at(2), "3 is more likely than 2");
  assert.ok(at(3) > at(4), "3 is more likely than 4");
  assert.ok(at(7) > at(6), "7 is more likely than 6");
  assert.ok(at(7) > at(8), "7 is more likely than 8");
  assert.ok(at(0) > 0.015, "ties are a live outcome");
});

test("NFL: moneyline, spread and total are all produced, with pushes removed from the denominator", async () => {
  const signals = nflSignals();
  const deps = nflDeps({ withTable: true, signals });
  const ctx = await NFLModel.loadContext(deps, signals);
  const built = await NFLModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 1, JSON.stringify(built.skipped));
  const preds = await NFLModel.predict(built.events[0].event, built.events[0].market, ctx, deps);

  const byMarket = (m: string) => preds.filter((p) => p.market === m);
  assert.equal(byMarket("h2h").length, 2);
  assert.equal(byMarket("totals").length, 2);
  assert.equal(byMarket("spreads").length, 2);

  for (const m of ["h2h", "totals", "spreads"]) {
    const pair = byMarket(m);
    assert.ok(Math.abs(pair[0].model_prob + pair[1].model_prob - 1) < 1e-9, `${m} sides sum to one`);
  }
  const spreads = byMarket("spreads");
  assert.equal(spreads[0].point, -6.5, "home carries the home handicap");
  assert.equal(spreads[1].point, 6.5, "away carries its own sign");
  assert.equal(byMarket("totals")[0].point, 44.5);

  const detail = preds[0].detail as any;
  assert.ok(detail.expected_home_points > 0 && detail.expected_away_points > 0);
  assert.ok(detail.p_tie > 0, "the tie rate is reported");
  assert.equal(detail.basis, "epa_efficiency");
});

test("NFL: quarterback and injury status are reported as missing, never invented", async () => {
  const signals = nflSignals();
  const deps = nflDeps({ withTable: true, signals });
  const ctx = await NFLModel.loadContext(deps, signals);
  const built = await NFLModel.buildEvents(deps, signals, ctx);
  const preds = await NFLModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  assert.ok(preds[0].missing_features.indexOf("qb_status") >= 0);
  assert.ok(preds[0].missing_features.indexOf("injury_report") >= 0);
  assert.ok(preds[0].missing_features.some((m) => m.indexOf("home_field_advantage") >= 0), "the unfitted parameter is declared");
  assert.notEqual(preds[0].context_quality, "HIGH", "a model missing QB status is not high quality");

  const qb = NFLModel.dataContract.find((c) => c.feature === "quarterback status")!;
  assert.equal(qb.sourceClass, "NOT_AVAILABLE");
  assert.match(qb.source, /NEVER inferred/);
});

test("NFL: a team absent from the features table is skipped by name", async () => {
  const rows = eventRows("evt-x", "Seattle Seahawks", "Denver Broncos", "2026-09-14T17:00:00Z", { sportKey: "americanfootball_nfl" });
  const deps = nflDeps({ withTable: true, signals: rows });
  const ctx = await NFLModel.loadContext(deps, rows);
  const built = await NFLModel.buildEvents(deps, rows, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.skipped[0].reason, "missing_team_stats");
  assert.match(built.skipped[0].detail ?? "", /Seattle Seahawks/);
});

// ---------------------------------------------------------------------------
// WNBA
// ---------------------------------------------------------------------------

const WNBA_TEAMS = [
  { team: "Las Vegas Aces", off: 110, def: 98, pace: 82 },
  { team: "New York Liberty", off: 112, def: 97, pace: 80 },
  { team: "Connecticut Sun", off: 104, def: 96, pace: 78 },
  { team: "Chicago Sky", off: 98, def: 106, pace: 84 },
];

function wnbaRows() {
  return WNBA_TEAMS.map((t) => ({
    team: t.team,
    team_norm: nrm(t.team),
    off_rating: t.off,
    def_rating: t.def,
    pace: t.pace,
    three_rate: 0.31,
    efg_pct: 0.5,
    updated_at: "2026-08-14T12:00:00Z",
  }));
}

function wnbaDeps(opts: { signals?: any[]; withTable?: boolean } = {}) {
  return makeFakeDeps({
    tables: {
      "signals?": opts.signals ?? [],
      ...(opts.withTable ? { "wnba_team_features?": wnbaRows() } : {}),
    },
    missing: opts.withTable ? [] : ["wnba_team_features", "game_stats"],
  });
}

function wnbaSignals() {
  const rows = eventRows("evt-wnba", "Las Vegas Aces", "Chicago Sky", "2026-08-16T23:00:00Z", {
    sportKey: "basketball_wnba",
    total: 165.5,
    spread: -8.5,
    sharpHome: 0.76,
  });
  for (const r of rows) r.sport_title = "WNBA";
  return rows;
}

test("WNBA: without a team-features table the model writes nothing and names what is missing", async () => {
  const ctx = await WNBAModel.loadContext(wnbaDeps({ signals: wnbaSignals() }), []);
  assert.equal(ctx.status, "insufficient_data");
  assert.deepEqual(ctx.missing, WNBA_REQUIRED_COLUMNS);
  assert.match(ctx.detail ?? "", /wnba_team_features/);
});

test("WNBA: pace interacts and efficiency is opponent-relative", async () => {
  const deps = wnbaDeps({ withTable: true });
  const ctx = await WNBAModel.loadContext(deps, []);
  assert.equal(ctx.status, "ok", ctx.detail);
  const d = ctx.data as unknown as WnbaCtxData;

  const fastVsFast = gameShape(d, nrm("Chicago Sky"), nrm("Las Vegas Aces"))!;
  const slowVsSlow = gameShape(d, nrm("Connecticut Sun"), nrm("New York Liberty"))!;
  assert.ok(fastVsFast.possessions > slowVsSlow.possessions, "two fast teams play a faster game");

  const vsGoodD = gameShape(d, nrm("Las Vegas Aces"), nrm("Connecticut Sun"))!;
  const vsBadD = gameShape(d, nrm("Las Vegas Aces"), nrm("Chicago Sky"))!;
  assert.ok(vsGoodD.pppHome < vsBadD.pppHome, "the same offence is less efficient against a better defence");
});

test("WNBA: every league baseline comes from the loaded WNBA rows", async () => {
  const deps = wnbaDeps({ withTable: true });
  const ctx = await WNBAModel.loadContext(deps, []);
  const d = ctx.data as unknown as WnbaCtxData;
  const meanPace = WNBA_TEAMS.reduce((a, t) => a + t.pace, 0) / WNBA_TEAMS.length;
  assert.ok(Math.abs(d.lgPace - meanPace) < 1e-9, "pace baseline is the fixture's own mean");
  const meanRating = WNBA_TEAMS.reduce((a, t) => a + t.off + t.def, 0) / (WNBA_TEAMS.length * 2);
  assert.ok(Math.abs(d.lgRating - meanRating) < 1e-9, "rating baseline is the fixture's own mean");
});

test("WNBA: per-possession scoring reproduces the mean it was given", () => {
  const rng = makeRng(11);
  let total = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) total += drawTeamPoints(rng, 80, 1.05, 0.31);
  const mean = total / N;
  assert.ok(Math.abs(mean - 84) < 1.0, `mean points ${mean.toFixed(2)} should track 80 possessions x 1.05`);
});

test("WNBA: moneyline, spread and total are produced and the sides sum to one", async () => {
  const signals = wnbaSignals();
  const deps = wnbaDeps({ withTable: true, signals });
  const ctx = await WNBAModel.loadContext(deps, signals);
  const built = await WNBAModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 1, JSON.stringify(built.skipped));
  const preds = await WNBAModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  for (const m of ["h2h", "totals", "spreads"]) {
    const pair = preds.filter((p) => p.market === m);
    assert.equal(pair.length, 2, `${m} has both sides`);
    assert.ok(Math.abs(pair[0].model_prob + pair[1].model_prob - 1) < 1e-9);
  }
  const home = preds.find((p) => p.market === "h2h" && p.selection === "Las Vegas Aces")!;
  assert.ok(home.model_prob > 0.5, "the far better team is favoured");
  const detail = preds[0].detail as any;
  assert.equal(detail.basis, "possession_efficiency");
  assert.ok(detail.possessions > 60 && detail.possessions < 110);
});

test("WNBA: player availability is reported missing, and the row is never marked HIGH quality", async () => {
  const signals = wnbaSignals();
  const deps = wnbaDeps({ withTable: true, signals });
  const ctx = await WNBAModel.loadContext(deps, signals);
  const built = await WNBAModel.buildEvents(deps, signals, ctx);
  const preds = await WNBAModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  assert.ok(preds[0].missing_features.indexOf("player_availability") >= 0);
  assert.ok(preds[0].missing_features.indexOf("injury_report") >= 0);
  assert.ok(preds[0].missing_features.indexOf("minutes_usage") >= 0);
  assert.notEqual(preds[0].context_quality, "HIGH");
});

test("WNBA: the model carries no NBA constants", async () => {
  const deps = wnbaDeps({ withTable: true });
  const ctx = await WNBAModel.loadContext(deps, []);
  const extra = WNBAModel.telemetryExtra!([], ctx) as any;
  assert.match(extra.note, /no NBA prior/);
  const contract = WNBAModel.dataContract.map((c) => c.source).join(" ");
  assert.equal(/nba/i.test(contract.replace(/wnba/gi, "")), false, "no NBA source appears in the contract");
});
