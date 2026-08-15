// ============================================================================
// ATP / WTA: rating construction, surface handling, participant matching,
// duplicate-event protection, and the closed-form scoring model.
//
// The two tours are exercised through the SAME assertions on DIFFERENT data, so
// a regression that silently made one tour read the other's rows would fail.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { ATPModel, ATP_PARAMS } from "../supabase/functions/model_predict/models/atp.ts";
import { WTAModel, WTA_PARAMS } from "../supabase/functions/model_predict/models/wta.ts";
import {
  buildTennisRatings,
  gameWinProb,
  inferSurface,
  matchWinProb,
  normSurface,
  setWinProb,
  strengthOf,
  TENNIS_FIT_FEATURES,
  tiebreakWinProb,
  type TennisCtxData,
  type TennisMatchRow,
} from "../supabase/functions/model_predict/models/tennis_engine.ts";
import { matchesOf, ratingOf } from "../supabase/functions/model_predict/core/elo.ts";
import { eventRows, makeFakeDeps } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SURFACES = ["Hard", "Clay", "Grass"];
const TOURNEYS = ["Cincinnati Open", "Roland Garros", "Wimbledon"];

/** N players, a deterministic strength order, and a match history that reflects
 *  it. Player 1 is strongest and beats everyone below more often than not. */
function history(nPlayers: number, nMatches: number, prefix: string): TennisMatchRow[] {
  const rows: TennisMatchRow[] = [];
  let day = 0;
  for (let i = 0; i < nMatches; i++) {
    const a = (i * 7) % nPlayers;
    const b = (i * 13 + 3) % nPlayers;
    if (a === b) continue;
    // lower index = stronger; the stronger player wins ~72% of the time,
    // deterministically patterned so the fixture is reproducible.
    const strongerFirst = a < b;
    const upset = i % 7 === 0;
    const winner = strongerFirst === !upset ? a : b;
    const loser = winner === a ? b : a;
    if (i % 3 === 0) day++;
    const si = i % 3;
    rows.push({
      match_id: `${prefix}-m${i}`,
      match_date: new Date(Date.UTC(2022, 0, 1 + day)).toISOString().slice(0, 10),
      tourney_name: TOURNEYS[si],
      surface: SURFACES[si],
      level: "A",
      round: "R32",
      winner_id: `${prefix}${winner}`,
      loser_id: `${prefix}${loser}`,
      minutes: 95 + (i % 40),
    });
  }
  return rows;
}

function players(n: number, prefix: string, names: string[]) {
  return Array.from({ length: n }, (_, i) => ({
    player_id: `${prefix}${i}`,
    full_name: names[i] ?? `${prefix} Player ${i}`,
    plays: i % 5 === 0 ? "L" : "R",
    birth_date: "1997-04-02",
  }));
}

const ATP_NAMES = ["Carlos Alcaraz", "Jannik Sinner", "Novak Djokovic", "Daniil Medvedev", "Alexander Zverev", "Andrey Rublev", "Casper Ruud", "Holger Rune", "Taylor Fritz", "Grigor Dimitrov"];
const WTA_NAMES = ["Iga Swiatek", "Aryna Sabalenka", "Coco Gauff", "Elena Rybakina", "Jessica Pegula", "Ons Jabeur", "Maria Sakkari", "Qinwen Zheng", "Barbora Krejcikova", "Beatriz Haddad Maia"];

function tennisDeps(tour: "ATP" | "WTA", opts: { matches?: number; signals?: any[]; missingSchema?: boolean } = {}) {
  const prefix = tour === "ATP" ? "a" : "w";
  const names = tour === "ATP" ? ATP_NAMES : WTA_NAMES;
  const hist = history(10, opts.matches ?? 900, prefix);
  return makeFakeDeps({
    tables: { "signals?": opts.signals ?? [], "model_parameters?": [] },
    schemas: opts.missingSchema ? {} : {
      [`tennis:players?select=`]: players(10, prefix, names),
      [`tennis:matches?select=*`]: hist.slice(0, 1),
      [`tennis:matches?select=match_id`]: hist,
      [`tennis:rankings_current?select=`]: names.map((_, i) => ({ player_id: `${prefix}${i}`, rank: i + 1, points: 9000 - i * 700 })),
    },
    missing: opts.missingSchema ? ["tennis:"] : [],
  });
}

// ---------------------------------------------------------------------------
// Rating construction
// ---------------------------------------------------------------------------

test("ratings are built chronologically and rank the fixture's players correctly", () => {
  const built = buildTennisRatings(history(10, 900, "a"), ATP_PARAMS);
  const best = ratingOf(built.overall, "a0");
  const worst = ratingOf(built.overall, "a9");
  assert.ok(best > worst, `strongest ${best.toFixed(0)} should out-rate weakest ${worst.toFixed(0)}`);
  assert.ok(matchesOf(built.overall, "a0") > 50, "career match counts accumulate");
});

test("surface ratings are separate from the overall rating", () => {
  const built = buildTennisRatings(history(10, 900, "a"), ATP_PARAMS);
  assert.ok(built.bySurface["hard"], "hard is rated");
  assert.ok(built.bySurface["clay"], "clay is rated");
  assert.ok(built.bySurface["grass"], "grass is rated");
  assert.equal(built.bySurface["unknown"], undefined, "an unknown surface is never rated as a surface");
  const overall = ratingOf(built.overall, "a0");
  const clay = ratingOf(built.bySurface["clay"], "a0");
  assert.notEqual(overall, clay, "the two are computed on different samples");
});

test("surface normalisation keeps indoor hard distinct and refuses to guess", () => {
  assert.equal(normSurface("Clay"), "clay");
  assert.equal(normSurface("Grass"), "grass");
  assert.equal(normSurface("Hard"), "hard");
  assert.equal(normSurface("Indoor Hard"), "indoor_hard");
  assert.equal(normSurface("Carpet"), "carpet");
  assert.equal(normSurface(null), "unknown");
  assert.equal(normSurface("Astroturf"), "unknown", "an unrecognised surface is unknown, not hard");
});

test("the surface of a captured event is recovered from the tour's own history", () => {
  const built = buildTennisRatings(history(10, 900, "a"), ATP_PARAMS);
  assert.equal(inferSurface(built.tourneySurfaces, "ATP Roland Garros"), "clay");
  assert.equal(inferSurface(built.tourneySurfaces, "ATP Wimbledon"), "grass");
  assert.equal(inferSurface(built.tourneySurfaces, "ATP Cincinnati Open"), "hard");
  assert.equal(inferSurface(built.tourneySurfaces, "ATP Some Exhibition Nobody Has Played"), "unknown");
});

test("the surface blend weight rises with the smaller surface sample", async () => {
  const deps = tennisDeps("ATP");
  const ctx = await ATPModel.loadContext(deps, []);
  assert.equal(ctx.status, "ok", ctx.detail);
  const d = ctx.data as unknown as TennisCtxData;
  const onSurface = strengthOf(d, "a0", "clay");
  const offSurface = strengthOf(d, "a0", "unknown");
  assert.ok(onSurface.surfaceWeight > 0, "a rated surface contributes");
  assert.equal(offSurface.surfaceWeight, 0, "an unknown surface contributes nothing");
  assert.equal(offSurface.rating, offSurface.overallRating, "and falls back to the overall rating");
});

test("a player with too little history is rank-anchored, and flagged as such", async () => {
  const deps = tennisDeps("ATP");
  const ctx = await ATPModel.loadContext(deps, []);
  const d = ctx.data as unknown as TennisCtxData;
  // an unrated newcomer who is nevertheless ranked
  d.rank.set("newbie", { rank: 40, points: 900 });
  const s = strengthOf(d, "newbie", "hard");
  assert.equal(s.basis, "rank_prior");
  assert.ok(d.rankPrior, "the rank -> rating line was fitted on this tour's own players");
  const unranked = strengthOf(d, "ghost", "hard");
  assert.equal(unranked.basis, "none", "no matches and no ranking is not a strength");
});

// ---------------------------------------------------------------------------
// Closed-form scoring model
// ---------------------------------------------------------------------------

test("the game model matches the published closed form", () => {
  assert.ok(Math.abs(gameWinProb(0.5) - 0.5) < 1e-12, "an even server holds half the time");
  assert.ok(Math.abs(gameWinProb(0.6) - 0.735729) < 1e-5, `got ${gameWinProb(0.6)}`);
  assert.ok(gameWinProb(0.7) > gameWinProb(0.6), "monotone in the point probability");
  assert.equal(gameWinProb(1), 1);
  assert.equal(gameWinProb(0), 0);
});

test("the tiebreak and set models are symmetric when the players are equal", () => {
  assert.ok(Math.abs(tiebreakWinProb(0.6, 0.6) - 0.5) < 1e-9);
  const hold = gameWinProb(0.62);
  assert.ok(Math.abs(setWinProb(hold, hold, 0.62, 0.62) - 0.5) < 1e-9);
});

test("a stronger server wins more sets and more matches, and five sets amplify it", () => {
  const strong = gameWinProb(0.68);
  const weak = gameWinProb(0.60);
  const s = setWinProb(strong, weak, 0.68, 0.60);
  assert.ok(s > 0.5, `set prob ${s.toFixed(4)}`);
  const bo3 = matchWinProb(s, 3);
  const bo5 = matchWinProb(s, 5);
  assert.ok(bo3 > s, "winning a match is easier than winning any one set for the favourite");
  assert.ok(bo5 > bo3, "the longer format favours the better player");
  assert.ok(Math.abs(matchWinProb(0.5, 3) - 0.5) < 1e-12);
  assert.ok(Math.abs(matchWinProb(0.5, 5) - 0.5) < 1e-12);
});

// ---------------------------------------------------------------------------
// Event assembly
// ---------------------------------------------------------------------------

function tennisSignals(tour: "ATP" | "WTA", pairs: Array<[string, string, string, string]>) {
  const key = tour === "ATP" ? "tennis_atp_cincinnati_open" : "tennis_wta_cincinnati_open";
  return pairs.flatMap(([id, home, away, when]) => {
    const rows = eventRows(id, home, away, when, { sportKey: key });
    for (const r of rows) r.sport_title = `${tour} Cincinnati Open`;
    return rows;
  });
}

for (const tour of ["ATP", "WTA"] as const) {
  const model = tour === "ATP" ? ATPModel : WTAModel;
  const names = tour === "ATP" ? ATP_NAMES : WTA_NAMES;

  test(`${tour}: a two-player event resolves both participants and predicts both sides`, async () => {
    const signals = tennisSignals(tour, [["evt-1", names[0], names[3], "2026-08-16T15:00:00Z"]]);
    const deps = tennisDeps(tour, { signals });
    const ctx = await model.loadContext(deps, signals);
    assert.equal(ctx.status, "ok", ctx.detail);
    const built = await model.buildEvents(deps, signals, ctx);
    assert.equal(built.events.length, 1, JSON.stringify(built.skipped));
    const preds = await model.predict(built.events[0].event, built.events[0].market, ctx, deps);
    assert.equal(preds.length, 2, "both sides of the match winner");
    assert.ok(Math.abs(preds[0].model_prob + preds[1].model_prob - 1) < 1e-12, "the two sides sum to one");
    assert.ok(preds[0].model_prob > 0 && preds[0].model_prob < 1);
    const detail = preds[0].detail as any;
    assert.equal(detail.tour, tour, "the row records which tour produced it");
    assert.equal(detail.surface_used, "hard", "surface recovered from the tournament name");
  });

  test(`${tour}: an unknown player is skipped with missing_participant, never guessed`, async () => {
    const signals = tennisSignals(tour, [["evt-1", "Someone Not In The Database", names[3], "2026-08-16T15:00:00Z"]]);
    const deps = tennisDeps(tour, { signals });
    const ctx = await model.loadContext(deps, signals);
    const built = await model.buildEvents(deps, signals, ctx);
    assert.equal(built.events.length, 0);
    assert.equal(built.skipped[0].reason, "missing_participant");
    assert.match(built.skipped[0].detail ?? "", /tennis\.players/);
  });

  test(`${tour}: the same two players meeting twice are two independent events`, async () => {
    const signals = tennisSignals(tour, [
      ["evt-r16", names[0], names[3], "2026-08-16T15:00:00Z"],
      ["evt-final", names[0], names[3], "2026-08-23T15:00:00Z"],
    ]);
    const deps = tennisDeps(tour, { signals });
    const ctx = await model.loadContext(deps, signals);
    const built = await model.buildEvents(deps, signals, ctx);
    assert.equal(built.events.length, 2, "a rematch is not a duplicate");
    assert.deepEqual(built.events.map((e) => e.event.event_id).sort(), ["evt-final", "evt-r16"]);
  });

  test(`${tour}: an unreadable tennis schema yields insufficient_data, not predictions`, async () => {
    const signals = tennisSignals(tour, [["evt-1", names[0], names[3], "2026-08-16T15:00:00Z"]]);
    const deps = tennisDeps(tour, { signals, missingSchema: true });
    const ctx = await model.loadContext(deps, signals);
    assert.equal(ctx.status, "insufficient_data");
    assert.match(ctx.detail ?? "", /Exposed schemas|unreadable/);
    const built = await model.buildEvents(deps, signals, ctx);
    assert.equal(built.events.length, 0);
    assert.equal(built.skipped[0].reason, "model_context_failed");
  });

  test(`${tour}: a thin match history yields insufficient_data rather than a rating built on nothing`, async () => {
    const signals = tennisSignals(tour, [["evt-1", names[0], names[3], "2026-08-16T15:00:00Z"]]);
    const deps = tennisDeps(tour, { signals, matches: 120 });
    const ctx = await model.loadContext(deps, signals);
    assert.equal(ctx.status, "insufficient_data");
    assert.ok((ctx.missing ?? []).some((m) => m.indexOf("tennis.matches") >= 0));
  });

  test(`${tour}: spreads and totals are refused because EdgeDesk cannot grade them`, () => {
    assert.equal(model.supportsMarket("spreads"), false);
    assert.equal(model.supportsMarket("totals"), false);
    assert.equal(model.supportsMarket("h2h"), true);
  });
}

test("ATP and WTA read their own tour's rows and produce different ratings", async () => {
  const atpDeps = tennisDeps("ATP");
  const wtaDeps = tennisDeps("WTA");
  const atpCtx = await ATPModel.loadContext(atpDeps, []);
  const wtaCtx = await WTAModel.loadContext(wtaDeps, []);
  const a = atpCtx.data as unknown as TennisCtxData;
  const w = wtaCtx.data as unknown as TennisCtxData;
  assert.ok(atpDeps.calls.every((c) => c.indexOf("tour=eq.WTA") < 0), "the ATP model never queried WTA rows");
  assert.ok(wtaDeps.calls.every((c) => c.indexOf("tour=eq.ATP") < 0), "the WTA model never queried ATP rows");
  assert.equal(a.params.tour, "ATP");
  assert.equal(w.params.tour, "WTA");
  assert.ok(a.overall.rating.has("a0"), "ATP ratings are keyed by ATP player ids");
  assert.ok(w.overall.rating.has("w0"), "WTA ratings are keyed by WTA player ids");
  assert.equal(a.overall.rating.has("w0"), false, "and the two rating sets do not overlap");
});

test("the two tours have independent parameter objects and versions", () => {
  assert.notEqual(ATP_PARAMS, WTA_PARAMS);
  assert.notEqual(ATP_PARAMS.elo, WTA_PARAMS.elo, "separate literals, not a shared reference");
  assert.equal(ATP_PARAMS.modelVersion, "atp_match_v1");
  assert.equal(WTA_PARAMS.modelVersion, "wta_match_v1");
  // mutating one must not touch the other
  const before = WTA_PARAMS.elo.kFactor;
  ATP_PARAMS.elo.kFactor = 999;
  assert.equal(WTA_PARAMS.elo.kFactor, before);
  ATP_PARAMS.elo.kFactor = 250;
});

test("ranking is excluded from the fitted feature set", () => {
  assert.equal(TENNIS_FIT_FEATURES.indexOf("log_rank_diff"), -1);
  assert.deepEqual(TENNIS_FIT_FEATURES, ["elo_diff", "surface_elo_diff", "rest_diff", "load14_diff", "form10_diff", "h2h_diff"]);
});

test("without stored calibration the probability is pure Elo and says so", async () => {
  const signals = tennisSignals("ATP", [["evt-1", ATP_NAMES[0], ATP_NAMES[6], "2026-08-16T15:00:00Z"]]);
  const deps = tennisDeps("ATP", { signals });
  const ctx = await ATPModel.loadContext(deps, signals);
  const built = await ATPModel.buildEvents(deps, signals, ctx);
  const preds = await ATPModel.predict(built.events[0].event, built.events[0].market, ctx, deps);
  const detail = preds[0].detail as any;
  assert.equal(detail.basis, "surface_blended_elo");
  assert.ok(preds[0].missing_features.some((m) => m.indexOf("fitted_feature_weights") >= 0));
  assert.deepEqual(detail.features_computed_not_applied, ["rest_diff", "load14_diff", "form10_diff", "h2h_diff"]);
});
