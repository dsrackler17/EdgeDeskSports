// ============================================================================
// Shared-layer tests: event identity, market grouping, snapshot immutability,
// probability validation, unsupported markets, the registry, sport isolation.
//
// These are the guarantees every sport inherits. If one of them breaks, six
// models break at once, which is why they are pinned separately from any
// model's mathematics.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMarketIndex, eventsInStartOrder } from "../supabase/functions/model_predict/core/market.ts";
import { claimById, claimEvent, duplicatePairEventCount, unmatchedEvents } from "../supabase/functions/model_predict/core/identity.ts";
import { buildRow, dedupeRows, snapshotFor } from "../supabase/functions/model_predict/core/validate.ts";
import { decToAm, expectedValue, probabilityGap, toAm } from "../supabase/functions/model_predict/core/odds.ts";
import { buildNameIndex, pairKey, personKey, resolveName } from "../supabase/functions/model_predict/core/names.ts";
import { describe, MODEL_REGISTRY, resolveFilter, resolveModel } from "../supabase/functions/model_predict/core/registry.ts";
import type { EventContext, ModelPrediction } from "../supabase/functions/model_predict/core/types.ts";
import { eventRows } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Event identity
// ---------------------------------------------------------------------------

test("market index is keyed by event_id, not by the team pair", () => {
  const rows = [
    ...eventRows("evt-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5 }),
    ...eventRows("evt-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.0 }),
  ];
  const idx = buildMarketIndex(rows);
  assert.equal(Object.keys(idx.byEvent).length, 2, "two same-day meetings are two events");
  assert.equal(idx.byEvent["evt-g1"].mainTotal?.point, 8.5);
  assert.equal(idx.byEvent["evt-g2"].mainTotal?.point, 9.0, "game 2 keeps its own line");
  const pk = pairKey("Chicago Cubs", "Milwaukee Brewers");
  assert.equal(idx.pairs[pk].length, 2, "the pair is a bucket holding both");
  assert.equal(idx.pairs[pk][0].event_id, "evt-g1", "bucket is sorted earliest first");
});

test("claimEvent hands each game its own event and consumes it", () => {
  const idx = buildMarketIndex([
    ...eventRows("evt-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5 }),
    ...eventRows("evt-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.0 }),
  ]);
  const g1 = claimEvent(idx.pairs, "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z");
  const g2 = claimEvent(idx.pairs, "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z");
  assert.equal(g1?.event_id, "evt-g1");
  assert.equal(g2?.event_id, "evt-g2");
  const third = claimEvent(idx.pairs, "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z");
  assert.equal(third, null, "a consumed event cannot be claimed twice");
});

test("claimEvent refuses an event outside the match window rather than taking the nearest", () => {
  const idx = buildMarketIndex(eventRows("evt-x", "Boston Red Sox", "New York Yankees", "2026-08-15T23:10:00Z"));
  const far = claimEvent(idx.pairs, "Boston Red Sox", "New York Yankees", "2026-08-12T23:10:00Z", 240 * 60000);
  assert.equal(far, null, "three days apart is a different game");
  assert.equal(idx.byEvent["evt-x"].claimed, undefined, "and the event stays unclaimed");
});

test("claimEvent falls back to an undated event only, never to a contradicting one", () => {
  const rows = [
    ...eventRows("evt-dated", "Athletics", "Seattle Mariners", "2026-08-15T02:05:00Z"),
    ...eventRows("evt-undated", "Athletics", "Seattle Mariners", "2026-08-15T02:05:00Z"),
  ];
  for (const r of rows) if (r.event_id === "evt-undated") r.commence_time = null;
  const idx = buildMarketIndex(rows);
  const got = claimEvent(idx.pairs, "Athletics", "Seattle Mariners", "2026-08-20T02:05:00Z", 60 * 60000);
  assert.equal(got?.event_id, "evt-undated");
});

test("claimById cannot hand the same event out twice", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "A", "B", "2026-08-15T18:00:00Z"));
  assert.ok(claimById(idx, "evt-1"));
  assert.equal(claimById(idx, "evt-1"), null);
});

test("unmatched and duplicate-pair telemetry sees a broken join", () => {
  const idx = buildMarketIndex([
    ...eventRows("evt-g1", "Cubs", "Brewers", "2026-08-15T17:10:00Z"),
    ...eventRows("evt-g2", "Cubs", "Brewers", "2026-08-15T23:40:00Z"),
    ...eventRows("evt-solo", "Reds", "Pirates", "2026-08-15T22:40:00Z"),
  ]);
  assert.equal(duplicatePairEventCount(idx), 2);
  claimById(idx, "evt-g1");
  const un = unmatchedEvents(idx);
  assert.equal(un.length, 2);
  assert.ok(un.some((u) => u.event_id === "evt-g2"), "the unclaimed second game is named");
});

test("events are ordered by start time", () => {
  const idx = buildMarketIndex([
    ...eventRows("late", "A", "B", "2026-08-15T23:40:00Z"),
    ...eventRows("early", "C", "D", "2026-08-15T17:10:00Z"),
  ]);
  assert.deepEqual(eventsInStartOrder(idx).map((e) => e.event_id), ["early", "late"]);
});

// ---------------------------------------------------------------------------
// Market grouping
// ---------------------------------------------------------------------------

test("main total is the point the most books quote", () => {
  const rows = [
    ...eventRows("e1", "Home", "Away", "2026-08-15T18:00:00Z", { total: 8.5 }),
    ...eventRows("e1", "Home", "Away", "2026-08-15T18:00:00Z", { total: 9.0 }),
  ];
  // give 9.0 more books
  for (const r of rows) if (r.market === "totals" && r.point === 9.0) r.n_books = 20;
  const idx = buildMarketIndex(rows);
  assert.equal(idx.byEvent["e1"].mainTotal?.point, 9.0);
});

test("spread sides are paired on the absolute line and reported as the home handicap", () => {
  const idx = buildMarketIndex(
    eventRows("e1", "Kansas City Chiefs", "Denver Broncos", "2026-09-14T17:00:00Z", { sportKey: "americanfootball_nfl", spread: -6.5 }),
  );
  const ms = idx.byEvent["e1"].mainSpread;
  assert.equal(ms?.point, -6.5, "point is the home side's handicap");
  assert.equal(ms?.home?.selection, "Kansas City Chiefs");
  assert.equal(ms?.away?.selection, "Denver Broncos");
});

// ---------------------------------------------------------------------------
// Snapshot + validation
// ---------------------------------------------------------------------------

const ev: EventContext = {
  event_id: "evt-1",
  sport_key: "baseball_mlb",
  commence_time: "2026-08-15T23:05:00Z",
  home_team: "Home",
  away_team: "Away",
};

function pred(over: Partial<ModelPrediction> = {}): ModelPrediction {
  return {
    market: "h2h",
    selection: "Home",
    point: null,
    model_prob: 0.6,
    context_quality: "HIGH",
    missing_features: [],
    ...over,
  };
}

test("the market snapshot is taken from the matching signals row", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z", { total: 8.5, sharpHome: 0.55 }));
  const me = idx.byEvent["evt-1"];
  assert.equal(snapshotFor(me, "h2h", "Home", null)?.sharp_fair, 0.55);
  assert.equal(snapshotFor(me, "totals", "Over", 8.5)?.selection, "Over");
  assert.equal(snapshotFor(me, "totals", "Over", 9.5), undefined, "a different line is not this line");
});

test("model_edge is a probability gap and model_ev is an expected value, in separate columns", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z", { sharpHome: 0.55 }));
  const r = buildRow("m_v1", ev, idx.byEvent["evt-1"], pred({ model_prob: 0.6 }), { dataAsOf: null, featureSnapshotId: null });
  assert.ok(r.ok && r.row);
  assert.equal(r.row!.market_prob_at_pred, 0.55);
  assert.equal(r.row!.model_edge, 0.05, "0.60 - 0.55 = a five point gap");
  // best_dec for the home side in the fixture is 1.9
  assert.equal(r.row!.model_ev, +(0.6 * 1.9 - 1).toFixed(4));
  assert.notEqual(r.row!.model_edge, r.row!.model_ev, "the two are never the same number by accident");
  assert.equal(probabilityGap(0.6, 0.55), 0.6 - 0.55);
  assert.equal(expectedValue(0.6, 1.9), 0.6 * 1.9 - 1);
});

test("a captured market with no matching row leaves the snapshot null rather than borrowing one", () => {
  const rows = eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z");
  const idx = buildMarketIndex(rows.filter((r) => r.selection !== "Home"));
  const r = buildRow("m_v1", ev, idx.byEvent["evt-1"], pred(), { dataAsOf: null, featureSnapshotId: null });
  assert.ok(r.ok && r.row);
  assert.equal(r.row!.market_prob_at_pred, null);
  assert.equal(r.row!.model_edge, null);
  assert.equal(r.row!.model_ev, null);
  assert.equal(r.row!.model_prob, 0.6, "the model still has an opinion");
});

test("invalid probabilities never become rows", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z"));
  const me = idx.byEvent["evt-1"];
  const meta = { dataAsOf: null, featureSnapshotId: null };
  for (const bad of [NaN, Infinity, -Infinity, -0.1, 0, 1, 1.4]) {
    const r = buildRow("m_v1", ev, me, pred({ model_prob: bad }), meta);
    assert.equal(r.ok, false, `probability ${bad} must be rejected`);
    assert.equal(r.reason, "invalid_probability");
  }
});

test("a totals or spreads row without a line is rejected", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z", { total: 8.5 }));
  const r = buildRow("m_v1", ev, idx.byEvent["evt-1"], pred({ market: "totals", selection: "Over", point: null }), { dataAsOf: null, featureSnapshotId: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_market_line");
});

test("a missing event_id or model version is refused", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z"));
  const me = idx.byEvent["evt-1"];
  assert.equal(buildRow("", ev, me, pred(), { dataAsOf: null, featureSnapshotId: null }).ok, false);
  assert.equal(buildRow("m_v1", { ...ev, event_id: "" }, me, pred(), { dataAsOf: null, featureSnapshotId: null }).ok, false);
});

test("two rows for the same conflict key cannot both survive one run", () => {
  const idx = buildMarketIndex(eventRows("evt-1", "Home", "Away", "2026-08-15T23:05:00Z"));
  const me = idx.byEvent["evt-1"];
  const meta = { dataAsOf: null, featureSnapshotId: null };
  const a = buildRow("m_v1", ev, me, pred({ model_prob: 0.6 }), meta).row!;
  const b = buildRow("m_v1", ev, me, pred({ model_prob: 0.4 }), meta).row!;
  const { kept, dropped } = dedupeRows([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(kept[0].model_prob, 0.6, "the first one produced wins, matching ignore-duplicates");
});

test("price conversions round-trip the way v1.2 did", () => {
  assert.equal(toAm(0.5), -100);
  assert.equal(toAm(0.6), -150);
  assert.equal(toAm(0.4), 150);
  assert.equal(decToAm(2.0), 100);
  assert.equal(decToAm(1.5), -200);
  assert.equal(toAm(0), toAm(0.001), "clamped, never infinite");
  assert.equal(toAm(1), toAm(0.999));
});

// ---------------------------------------------------------------------------
// Participant resolution
// ---------------------------------------------------------------------------

test("a name resolves to one entity or to nothing — never to the closest guess", () => {
  const idx = buildNameIndex([
    { id: "p1", name: "Carlos Alcaraz" },
    { id: "p2", name: "Novak Djokovic" },
    { id: "p3", name: "Félix Auger-Aliassime" },
    { id: "p4", name: "Alexander Zverev" },
    { id: "p5", name: "Mischa Zverev" },
  ]);
  assert.deepEqual(resolveName(idx, "Carlos Alcaraz"), { ok: true, id: "p1", how: "exact" });
  assert.deepEqual(resolveName(idx, "Novak Đoković"), { ok: true, id: "p2", how: "exact" }, "accents fold");
  assert.deepEqual(resolveName(idx, "Felix Auger Aliassime"), { ok: true, id: "p3", how: "exact" });
  assert.deepEqual(resolveName(idx, "C. Alcaraz"), { ok: true, id: "p1", how: "initial" });
  const amb = resolveName(idx, "Zverev");
  assert.equal(amb.ok, false);
  assert.equal((amb as { reason: string }).reason, "ambiguous", "two Zverevs must not be guessed between");
  assert.equal(resolveName(idx, "Someone Unknown").ok, false);
});

test("personKey is stable across punctuation and case", () => {
  assert.equal(personKey("Jon Jones"), personKey("JON  JONES"));
  assert.equal(personKey("Israel Adesanya"), "israeladesanya");
});

// ---------------------------------------------------------------------------
// Registry / sport isolation
// ---------------------------------------------------------------------------

test("every sport routes to its own model by prefix", () => {
  assert.equal(resolveModel("baseball_mlb")?.modelVersion, "mlb_runs_v1.2_nbinom_dh");
  assert.equal(resolveModel("tennis_atp_cincinnati_open")?.modelVersion, "atp_match_v1");
  assert.equal(resolveModel("tennis_wta_wimbledon")?.modelVersion, "wta_match_v1");
  assert.equal(resolveModel("mma_mixed_martial_arts")?.modelVersion, "ufc_fight_v1");
  assert.equal(resolveModel("americanfootball_nfl_preseason")?.modelVersion, "nfl_game_v1");
  assert.equal(resolveModel("basketball_wnba")?.modelVersion, "wnba_game_v1");
});

test("sports that are not registered route nowhere rather than to a default", () => {
  assert.equal(resolveModel("americanfootball_ncaaf"), null);
  assert.equal(resolveModel("basketball_nba"), null);
  assert.equal(resolveModel("icehockey_nhl"), null);
  assert.equal(resolveModel(""), null);
});

test("ATP and WTA are separate models with separate versions", () => {
  const atp = resolveModel("tennis_atp");
  const wta = resolveModel("tennis_wta");
  assert.notEqual(atp, wta, "not the same object");
  assert.notEqual(atp?.modelVersion, wta?.modelVersion);
  assert.equal(atp?.uiLabel, "ATP");
  assert.equal(wta?.uiLabel, "WTA");
});

test("the UI labels match the taxonomy app.html already uses", () => {
  const labels = Object.keys(MODEL_REGISTRY).map((k) => MODEL_REGISTRY[k].uiLabel).sort();
  assert.deepEqual(labels, ["ATP", "MLB", "MMA", "NFL", "WNBA", "WTA"]);
});

test("the sport filter accepts a key, a captured key or a UI label", () => {
  assert.equal(resolveFilter("baseball_mlb")?.uiLabel, "MLB");
  assert.equal(resolveFilter("tennis_atp_us_open")?.uiLabel, "ATP");
  assert.equal(resolveFilter("mma")?.uiLabel, "MMA");
  assert.equal(resolveFilter("WNBA")?.uiLabel, "WNBA");
  assert.equal(resolveFilter("cricket"), null);
});

test("unsupported markets are rejected per sport, not globally", () => {
  assert.equal(resolveModel("tennis_atp")!.supportsMarket("totals"), false, "tennis totals are not gradeable in EdgeDesk");
  assert.equal(resolveModel("tennis_atp")!.supportsMarket("spreads"), false);
  assert.equal(resolveModel("tennis_atp")!.supportsMarket("h2h"), true);
  assert.equal(resolveModel("mma_mixed_martial_arts")!.supportsMarket("totals"), false);
  assert.equal(resolveModel("baseball_mlb")!.supportsMarket("spreads"), false, "v1.2 never emitted run lines");
  assert.equal(resolveModel("baseball_mlb")!.supportsMarket("totals"), true);
  assert.equal(resolveModel("americanfootball_nfl")!.supportsMarket("spreads"), true);
  assert.equal(resolveModel("basketball_wnba")!.supportsMarket("totals"), true);
});

test("the registry publishes a data contract for every sport", () => {
  const d = describe();
  assert.equal(d.length, 6);
  for (const s of d) {
    assert.ok(s.model_version, `${s.sport_key} has a version`);
    assert.ok(s.supported_markets.length, `${s.sport_key} declares markets`);
    assert.ok(s.data_contract.length, `${s.sport_key} declares a data contract`);
    assert.ok(s.data_contract.every((c) => c.source && c.sourceClass), "every contract entry names a source and a class");
  }
});
