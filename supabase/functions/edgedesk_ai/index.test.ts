// supabase/functions/edgedesk_ai/index.test.ts
// ============================================================================
// Regression suite for the localized-integrity redesign (r4).
//
// Run under Node 22.18+ (type stripping is on by default):
//     node --test supabase/functions/edgedesk_ai/index.test.ts
// or under Deno 2 (node:test compat):
//     deno test --allow-env supabase/functions/edgedesk_ai/index.test.ts
//
// Everything here exercises the PURE pipeline — classification, integrity,
// quarantine, coverage, answerability, gate, prompt assembly — with synthetic
// evidence packets. No network, no database, no model call.
//
// The one behaviour this suite exists to pin down: a localized data fault
// excludes its own entities and NOTHING else. "8 of 37 starters have broken
// joins" must produce a ranking of the clean 29 plus one sentence about the 8
// — never a slate-wide refusal.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classify, rankingAxis, sportOfIntent, detectSport,
  resolveTeamIdentity, canonTeamKey, sameClub,
  ev, normalizeEvidence, evidenceIntegrity, quarantineEvidence,
  semanticCoverage, requirementsFor, buildAnswerability, completenessGate,
  budgetEvidence, enforceNoLeakage, etDay, personKey,
  buildUserContent,
} from "./index.ts";
import type { Evidence, CoverageUniverse, Integrity, Answerability } from "./index.ts";

const TODAY = etDay(0);
const YESTERDAY = etDay(-1);

/* ---------------------------------------------------------------- fixtures */

interface StarterSpec {
  name: string;
  team: string;
  opp: string;
  /** A second, conflicting team on another row — the broken-join shape. */
  conflictTeam?: string;
  /** Bind the matchup rows to this date instead of today. */
  gameDate?: string;
  eventId?: string;
  era?: number;
  /** Omit the per-game pitcher_quality row entirely. */
  noQuality?: boolean;
}

/** Build a normalized MLB packet: game + probable_starter + pitcher_quality
    (+ opponent_offense) per starter, with per-starter fault injection. */
function mlbPacket(specs: StarterSpec[], extra: Evidence[] = []): Evidence[] {
  const out: Evidence[] = [];
  const seenGames = new Set<string>();
  const NOW_ISO = new Date().toISOString();
  specs.forEach((s, i) => {
    const game = `${s.team} @ ${s.opp}`;
    const date = s.gameDate ?? TODAY;
    const eid = s.eventId ?? `EV-${s.team}-${s.opp}`;
    if (!seenGames.has(game + date + eid)) {
      seenGames.add(game + date + eid);
      out.push(ev({
        source: "mlb_game_cards", entity: game, field: "game", relevance: "schedule",
        event_id: eid, source_timestamp: NOW_ISO,
        value: { date, start: `${date}T23:00:00Z`, venue: "Park", status: "Scheduled",
          game, game_date: date, doubleheader: null, game_number: 1 },
        status: "VERIFIED", freshness: "CURRENT",
      }));
    }
    out.push(ev({
      source: "mlb_game_cards", entity: s.name, field: "probable_starter",
      source_timestamp: NOW_ISO,
      value: { name: s.name, throws: "R", team: s.team, game, side: "away",
        game_date: date, status: "Scheduled" },
      status: "PROBABLE", freshness: "CURRENT",
    }));
    if (!s.noQuality) {
      out.push(ev({
        source: "pitcher_features", entity: s.name, field: "pitcher_quality",
        event_id: eid, source_timestamp: NOW_ISO,
        value: {
          name: s.name, team: s.conflictTeam ?? s.team, game, game_date: date,
          opponent: s.opp, side: "away",
          era: s.era ?? 3 + i * 0.31, fip: 3.1 + i * 0.29, whip: 1.1 + i * 0.03,
          xera: 3.2 + i * 0.27, k_pct: 0.20 + i * 0.011,
        },
        status: "VERIFIED", freshness: "CURRENT",
      }));
      out.push(ev({
        source: "offense_features", entity: s.name, field: "opponent_offense",
        source_timestamp: NOW_ISO,
        value: { opponent: s.opp, faces_side: "home", game_date: date,
          obp: 0.310 + i * 0.004, iso: 0.150 + i * 0.003, k_pct: 0.22 - i * 0.002,
          runs_per_game: 4.2 + i * 0.11 },
        status: "VERIFIED", freshness: "CURRENT",
      }));
    }
  });
  return normalizeEvidence([...out, ...extra]);
}

function seasonRollup(names: string[]): Evidence {
  return ev({
    source: "pitcher_season", entity: "MLB 2026", field: "season_pitching",
    source_timestamp: new Date().toISOString(),
    value: {
      season: 2026, starters: names.length, ordered: "worst FIP first",
      rows: names.map((n, i) => ({ name: n, team: "?", gs: 20, ip: 110, era: 5.5 - i * 0.2, fip: 5.2 - i * 0.19, whip: 1.4 })),
      basis: "season-to-date",
    },
    status: "VERIFIED", freshness: "CURRENT",
  });
}

function universeOf(evd: Evidence[], expectedGames?: number): CoverageUniverse {
  const starters = [...new Set(evd.filter((e) => e.field === "probable_starter" && e.status !== "UNAVAILABLE")
    .map((e) => String(e.entity)))];
  const games = [...new Set(evd.filter((e) => e.field === "game" && e.status !== "UNAVAILABLE")
    .map((e) => String(e.entity)))];
  return { entities: starters, games, hasFocus: false, expectedGames: expectedGames ?? games.length };
}

/** Run the full deterministic pipeline the way runResearch does. */
function pipeline(intent: string, evd: Evidence[], opts: {
  focusPlayers?: any[]; expectedGames?: number;
} = {}) {
  const integrity = evidenceIntegrity(evd, {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: evd.filter((e) => e.status !== "UNAVAILABLE").length, withheld: 0 },
  });
  const q = quarantineEvidence(evd, integrity);
  const universe = universeOf(evd, opts.expectedGames);
  const excludedKeys = new Set(integrity.exclusions.map((x) => personKey(x.entity)));
  const cleanUniverse: CoverageUniverse = {
    ...universe, entities: universe.entities.filter((e) => !excludedKeys.has(personKey(e))),
  };
  const reqs = requirementsFor(intent, (opts.focusPlayers ?? []).some((p) => p.status === "RESOLVED"));
  const coverage = semanticCoverage(intent, q.kept, reqs, cleanUniverse, "baseball_mlb");
  const answerability = buildAnswerability({
    intent, requirements: reqs, integrity, coverage, universe,
    focusPlayers: opts.focusPlayers,
  });
  const gate = completenessGate(coverage, integrity, null, { answerability });
  return { integrity, quarantine: q, coverage, answerability, gate, universe, reqs };
}

/* ============================== 1. LOCALIZATION ========================== */

test("1: broken team joins exclude only the affected pitchers; clean ones still rank", () => {
  const specs: StarterSpec[] = [];
  for (let i = 0; i < 29; i++) specs.push({ name: `Clean Arm${i}`, team: `Home${i} Club`, opp: `Away${i} Club`, eventId: `E${i}` });
  // 8 broken: pitcher_quality says a club that is NOT in the game
  for (let i = 0; i < 8; i++) specs.push({ name: `Broken Arm${i}`, team: `HomeB${i} Club`, opp: `AwayB${i} Club`, conflictTeam: `Imposter${i} FC`, eventId: `E${29 + i}` });
  const evd = mlbPacket(specs);
  const r = pipeline("worst_pitchers", evd);

  assert.equal(r.integrity.verdict, "LOCALIZED");
  assert.equal(r.integrity.exclusions.length, 8);
  assert.equal(r.integrity.clean_subjects.length, 29);
  assert.equal(r.answerability.answer_mode, "CLEAN_SUBSET");
  assert.equal(r.answerability.question_answerable, true);
  assert.equal(r.answerability.clean_entities.length, 29);
  assert.ok(r.answerability.excluded_entities.some((x) => x.entity.startsWith("Broken Arm")));
  assert.ok(!r.answerability.clean_entities.some((x: string) => x.startsWith("Broken Arm")));
  // the gate does NOT invalidate the slate
  assert.notEqual(r.gate.state, "INVALID");
  assert.equal(r.gate.safe_to_rank, true);
  // the broken pitchers' matchup rows are physically gone
  const keptNames = new Set(r.quarantine.kept.filter((e) => e.field === "pitcher_quality").map((e) => e.entity));
  assert.ok(!keptNames.has("Broken Arm0"));
  assert.ok(keptNames.has("Clean Arm0"));
});

test("1b: a team abbreviation is NOT a conflicting join (CIN == Cincinnati Reds)", () => {
  assert.equal(canonTeamKey("CIN", "baseball_mlb"), "cincinnati reds");
  assert.ok(sameClub("Cincinnati Reds", "CIN", "baseball_mlb"));
  assert.ok(sameClub("Chicago White Sox", "CWS", "baseball_mlb"));
  assert.ok(!sameClub("Cincinnati Reds", "Chicago White Sox", "baseball_mlb"));

  // One pitcher carried with the full club name on one row and the
  // abbreviation on another: the exact false positive that failed a live slate.
  const evd = mlbPacket([{ name: "Andrew Abbott", team: "Cincinnati Reds", opp: "Washington Nationals" }]);
  // add an extra row asserting the ABBREVIATED team
  const withAbbr = normalizeEvidence([...evd, ev({
    source: "mlb_pitcher_usage", entity: "Andrew Abbott", field: "workload",
    value: { team: "CIN", last_start: YESTERDAY, pitches: 95, game_date: TODAY },
    status: "VERIFIED", freshness: "CURRENT",
  })]);
  const integ = evidenceIntegrity(withAbbr, {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: withAbbr.length, withheld: 0 },
  });
  const stc = integ.checks.find((c) => c.name === "subject_team_consistency")!;
  assert.equal(stc.status, "PASS");
  assert.equal(integ.exclusions.length, 0);
});

test("18/11: a player with two genuinely different team joins is excluded; 29 clean remain usable", () => {
  const specs: StarterSpec[] = [{ name: "Davis Martin", team: "Chicago White Sox", opp: "Cleveland Guardians", conflictTeam: "Miami Marlins" }];
  for (let i = 0; i < 29; i++) specs.push({ name: `Fine Arm${i}`, team: `Fine${i} Club`, opp: `Foe${i} Club`, eventId: `Y${i}` });
  const r = pipeline("worst_pitchers", mlbPacket(specs));
  assert.equal(r.integrity.verdict, "LOCALIZED");
  assert.deepEqual(r.integrity.exclusions.map((x) => x.entity), ["Davis Martin"]);
  assert.equal(r.answerability.clean_entities.length, 29);
  assert.equal(r.answerability.answer_mode, "CLEAN_SUBSET");
});

/* ====================== 2/3. AXIS AND INTENT ROUTING ===================== */

test("2: 'best pitchers on today's slate' ranks BEST, never exploitable", () => {
  const plan = classify("best pitchers on today's slate");
  assert.equal(plan.intent, "best_pitchers");
  const axis = rankingAxis(plan.intent)!;
  assert.match(axis, /BEST/);
  assert.match(axis, /do not reorder by attackability/);
});

test("3: 'most exploitable pitchers tonight' routes to the matchup-first intent", () => {
  const plan = classify("most exploitable pitchers tonight");
  assert.equal(plan.intent, "exploitable_pitchers");
  assert.ok(plan.steps.includes("pitcher_features"));
  assert.ok(plan.steps.includes("opponent_offense"));
});

test("5: 'best offenses today' does not trigger pitcher-specific retrieval", () => {
  const plan = classify("best offenses today");
  assert.ok(!plan.steps.includes("pitcher_features"));
  assert.ok(!plan.steps.includes("pitchers"));
});

test("6: 'best NFL defenses' is NFL only", () => {
  const plan = classify("best NFL defenses");
  assert.equal(plan.sport, "americanfootball_nfl");
  assert.equal(plan.intent, "nfl_best_defenses");
});

test("7: 'best MLB pitchers' is MLB only", () => {
  const plan = classify("best MLB pitchers");
  assert.equal(plan.intent, "best_pitchers");
  assert.equal(sportOfIntent(plan.intent), "baseball_mlb");
});

test("8: 'Giants' with no sport context stays ambiguous — never a guess", () => {
  const matches = resolveTeamIdentity("how do the Giants look tonight", null);
  const giants = matches.filter((m) => m.query.includes("giants"));
  assert.ok(giants.length > 0);
  assert.ok(giants.every((m) => m.status !== "RESOLVED"));
  const det = detectSport("how do the Giants look tonight");
  assert.equal(det.sport, null);
});

/* ==================== 4/10. SEASON vs MATCHUP LAYERS ===================== */

test("4: season layer satisfies a worst-pitchers question when the matchup layer is missing", () => {
  const names = ["Max Scherzer", "Cade Cavalli", "Aaron Nola"];
  const clubs: [string, string][] = [
    ["Toronto Blue Jays", "Boston Red Sox"],
    ["Washington Nationals", "Chicago Cubs"],
    ["Philadelphia Phillies", "Minnesota Twins"],
  ];
  const specs: StarterSpec[] = names.map((n, i) => ({
    name: n, team: clubs[i][0], opp: clubs[i][1], eventId: `S${i}`, noQuality: true,
  }));
  const evd = normalizeEvidence([...mlbPacket(specs), seasonRollup(names)]);
  const r = pipeline("worst_pitchers", evd);

  const cell = r.coverage.required.pitcher_quality;
  assert.ok(cell, "pitcher_quality requirement present");
  assert.equal(cell.via, "season_pitching");
  assert.equal(cell.available, 3);
  assert.equal(r.answerability.primary_evidence_layer, "season");
  assert.notEqual(r.gate.state, "INVALID");
  assert.notEqual(r.gate.state, "INSUFFICIENT");
  assert.equal(r.gate.safe_to_rank, true);
});

test("10: stale matchup rows are excluded but the current season layer keeps the question rankable", () => {
  const names = ["George Klassen", "Daniel Lynch", "Eric Lauer"];
  // matchup rows bound to YESTERDAY — wrong-day records for a question about today
  const specs: StarterSpec[] = names.map((n, i) => ({
    name: n, team: "Milwaukee Brewers", opp: "Chicago Cubs", eventId: `T${i}`, gameDate: YESTERDAY,
  }));
  const evd = normalizeEvidence([...mlbPacket(specs), seasonRollup(names)]);
  const r = pipeline("worst_pitchers", evd);

  const temporal = r.integrity.checks.find((c) => c.name === "temporal")!;
  assert.equal(temporal.status, "WARNING");
  assert.equal(temporal.scope, "LOCAL");
  // wrong-day matchup rows are gone; the season roll-up survives
  assert.ok(r.quarantine.excluded.some((e) => e.field === "pitcher_quality"));
  assert.ok(r.quarantine.kept.some((e) => e.field === "season_pitching"));
  assert.equal(r.answerability.question_answerable, true);
  assert.notEqual(r.gate.state, "INVALID");
});

test("temporal: a season row retrieved yesterday is NOT a wrong-day fault", () => {
  const evd = normalizeEvidence([
    ...mlbPacket([{ name: "Kevin Gausman", team: "Toronto Blue Jays", opp: "Boston Red Sox" }]),
    ev({
      source: "team_season", entity: "MLB 2026", field: "season_offense",
      source_timestamp: `${YESTERDAY}T18:00:00Z`,
      value: { season: 2026, rows: [{ team: "Boston Red Sox", runs_per_game: 4.4, ops: 0.71, k_pct: 0.21, woba: 0.315 }] },
      status: "VERIFIED", freshness: "CURRENT",
    }),
  ]);
  const integ = evidenceIntegrity(evd, {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: evd.length, withheld: 0 },
  });
  const temporal = integ.checks.find((c) => c.name === "temporal")!;
  assert.equal(temporal.status, "PASS");
});

/* ========================== 9. DUPLICATE EVENTS ========================== */

test("9: a same-day duplicate event excludes only that game; a doubleheader is not flagged", () => {
  // duplicate: same matchup, same date, two ids, no doubleheader marker
  const dup = mlbPacket([
    { name: "Dup Arm A", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "MLB-823994" },
    { name: "Dup Arm B", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "MLB-823995" },
    { name: "Other Arm", team: "San Diego Padres", opp: "Colorado Rockies", eventId: "MLB-9" },
  ]);
  const integ = evidenceIntegrity(dup, {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: dup.length, withheld: 0 },
  });
  const dupCheck = integ.checks.find((c) => c.name === "duplicate_event")!;
  assert.equal(dupCheck.status, "WARNING");
  assert.equal(dupCheck.scope, "LOCAL");
  assert.deepEqual([...(dupCheck.affected_event_ids ?? [])].sort(), ["MLB-823994", "MLB-823995"]);
  // quarantine drops the duplicated game's rows, keeps the other game
  const q = quarantineEvidence(dup, integ);
  assert.ok(q.excluded.length > 0);
  assert.ok(q.kept.some((e) => e.event_id === "MLB-9"));
  assert.ok(!q.kept.some((e) => e.event_id === "MLB-823994" || e.event_id === "MLB-823995"));

  // doubleheader: same shape but game_number marks two real games
  const dh = normalizeEvidence(mlbPacket([
    { name: "DH Arm A", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "G1" },
  ]).concat(normalizeEvidence([ev({
    source: "mlb_game_cards", entity: "Texas Rangers @ Los Angeles Angels", field: "game",
    event_id: "G2",
    value: { date: TODAY, game: "Texas Rangers @ Los Angeles Angels", game_date: TODAY,
      status: "Scheduled", doubleheader: "Y", game_number: 2 },
    status: "VERIFIED", freshness: "CURRENT",
  })])));
  const integ2 = evidenceIntegrity(normalizeEvidence(dh), {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: dh.length, withheld: 0 },
  });
  assert.equal(integ2.checks.find((c) => c.name === "duplicate_event")!.status, "PASS");

  // series: same matchup today and tomorrow under two ids is not a duplicate
  const series = mlbPacket([
    { name: "Srs Arm A", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "D1" },
    { name: "Srs Arm B", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "D2", gameDate: etDay(1) },
  ]);
  const integ3 = evidenceIntegrity(series, {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: series.length, withheld: 0 },
  });
  assert.equal(integ3.checks.find((c) => c.name === "duplicate_event")!.status, "PASS");
});

/* ==================== 12/13/14/15. GATE CALIBRATION ====================== */

test("12: fully clean data produces PASS with no exclusions and FULL mode", () => {
  const r = pipeline("worst_pitchers", mlbPacket([
    { name: "Jacob deGrom", team: "Texas Rangers", opp: "Los Angeles Angels", eventId: "C1" },
    { name: "Taj Bradley", team: "Tampa Bay Rays", opp: "Baltimore Orioles", eventId: "C2" },
  ], [seasonRollup(["Jacob deGrom", "Taj Bradley"])]));
  assert.equal(r.integrity.verdict, "PASS");
  assert.equal(r.integrity.exclusions.length, 0);
  assert.ok(["FULL", "PARTIAL"].includes(r.answerability.answer_mode));
  // no exclusion machinery engaged
  assert.equal(r.answerability.excluded_entities.length, 0);
  assert.equal(r.quarantine.excluded.length, 0);
  assert.notEqual(r.gate.state, "INVALID");
});

test("13: a missing OPTIONAL field (weather) never blocks the question", () => {
  const r = pipeline("worst_pitchers", mlbPacket([
    { name: "Roki Sasaki", team: "Los Angeles Dodgers", opp: "San Francisco Giants" },
  ]));
  // weather is OPTIONAL for worst_pitchers; its absence may appear as an
  // optional gap but never gates
  assert.equal(r.answerability.question_answerable, true);
  assert.notEqual(r.gate.state, "INVALID");
  assert.notEqual(r.gate.state, "INSUFFICIENT");
});

test("14: a missing REQUIRED field with no fallback yields INSUFFICIENT — a partial answer, not a refusal-to-speak", () => {
  const specs: StarterSpec[] = [
    { name: "Mystery Arm", team: "Athletics", opp: "Houston Astros", noQuality: true },
  ];
  const r = pipeline("worst_pitchers", mlbPacket(specs));  // no season rollup either
  assert.equal(r.gate.state, "INSUFFICIENT");
  assert.match(r.gate.reason, /Answer only what the present evidence supports/);
  assert.equal(r.answerability.answer_mode, "PARTIAL");
  assert.equal(r.answerability.question_answerable, true);
});

test("15: globally corrupted data (every subject implicated) correctly refuses", () => {
  const specs: StarterSpec[] = [];
  for (let i = 0; i < 6; i++) specs.push({ name: `Bad Arm${i}`, team: `BadHome${i} Club`, opp: `BadAway${i} Club`, conflictTeam: `Wrong${i} FC`, eventId: `B${i}` });
  const r = pipeline("worst_pitchers", mlbPacket(specs));
  assert.equal(r.integrity.verdict, "FAIL");
  assert.equal(r.answerability.answer_mode, "UNSAFE");
  assert.equal(r.answerability.question_answerable, false);
  assert.equal(r.gate.state, "INVALID");
  assert.equal(r.gate.safe_to_rank, false);
});

test("bug#6: an irrelevant failing check (market) does not gate a pitching question", () => {
  const badPrice = ev({
    source: "signals", entity: "Texas Rangers @ Los Angeles Angels", field: "signal",
    value: { best_dec: 0.90, sharp_fair: 0.55, edge: 0.03 },  // decimal <= 1: incoherent
    status: "VERIFIED", freshness: "CURRENT",
  });
  const evd = normalizeEvidence([...mlbPacket([
    { name: "Framber Valdez", team: "Houston Astros", opp: "Seattle Mariners" },
  ]), badPrice]);
  const r = pipeline("worst_pitchers", evd);
  const market = r.integrity.checks.find((c) => c.name === "market")!;
  assert.equal(market.status, "FAIL");
  assert.equal(market.scope, "LOCAL");
  // the check is noted but does not gate a worst-pitchers question
  assert.ok(r.answerability.ignored_checks.some((c) => c.name === "market"));
  assert.ok(!r.answerability.failed_checks.includes("market"));
  assert.equal(r.answerability.question_answerable, true);
  assert.notEqual(r.gate.state, "INVALID");
});

/* ===================== 16/17. BUDGET AND LEAKAGE ========================= */

test("16: evidence budgeting never truncates mid-object and names what it withheld", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    entity: `Pitcher ${i}`, field: "pitcher_quality",
    value: { era: 3 + i * 0.1, filler: "x".repeat(200) },
  }));
  const b = budgetEvidence(items, 3000);
  assert.doesNotThrow(() => JSON.parse(b.text));
  assert.ok(b.included > 0);
  assert.ok(b.dropped > 0);
  assert.equal(b.included + b.dropped, 40);
  assert.match(b.droppedNote ?? "", /withheld/);
  assert.match(b.droppedNote ?? "", /Pitcher /);
});

test("17: a historical question never sees information published after the as-of date", () => {
  const evd = normalizeEvidence([
    ev({ source: "signals", entity: "A @ B", field: "signal",
      information_timestamp: "2026-05-01T00:00:00Z", value: { edge: 0.03 },
      status: "VERIFIED", freshness: "CURRENT" }),
    ev({ source: "signals", entity: "A @ B", field: "closing_line",
      information_timestamp: "2026-06-09T00:00:00Z", value: { clv: 0.01 },
      status: "VERIFIED", freshness: "CURRENT" }),
  ]);
  const { evidence, report } = enforceNoLeakage(evd, "2026-06-01");
  assert.equal(report.excluded, 1);
  assert.ok(evidence.every((e) => e.field !== "closing_line"));
});

/* ==================== 19. SINGLE-PLAYER ISOLATION ======================== */

test("19: broken strangers never block a question about one clean player", () => {
  const specs: StarterSpec[] = [
    { name: "Aaron Nola", team: "Philadelphia Phillies", opp: "Minnesota Twins", eventId: "N1" },
    { name: "Broken Stranger", team: "Cincinnati Reds", opp: "Washington Nationals", conflictTeam: "Seattle Mariners", eventId: "N2" },
  ];
  const r = pipeline("unknown", mlbPacket(specs), {
    focusPlayers: [{ query: "Nola", resolved: "Aaron Nola", candidates: ["Aaron Nola"], status: "RESOLVED" }],
  });
  assert.equal(r.answerability.question_answerable, true);
  assert.deepEqual(r.answerability.clean_entities, ["Aaron Nola"]);
  // the stranger's exclusion does not attach to this question
  assert.equal(r.answerability.excluded_entities.length, 0);
  assert.notEqual(r.answerability.answer_mode, "UNSAFE");
  assert.notEqual(r.gate.state, "INVALID");
});

test("19b: the same question about the BROKEN player is the one case that refuses", () => {
  const specs: StarterSpec[] = [
    { name: "Aaron Nola", team: "Philadelphia Phillies", opp: "Minnesota Twins", eventId: "N1" },
    { name: "Broken Stranger", team: "Cincinnati Reds", opp: "Washington Nationals", conflictTeam: "Seattle Mariners", eventId: "N2" },
  ];
  const r = pipeline("unknown", mlbPacket(specs), {
    focusPlayers: [{ query: "Stranger", resolved: "Broken Stranger", candidates: ["Broken Stranger"], status: "RESOLVED" }],
  });
  assert.equal(r.answerability.answer_mode, "UNSAFE");
  assert.ok(r.answerability.excluded_entities.some((x) => x.entity === "Broken Stranger"));
});

/* ==================== 20. PROMPT SHAPE / VERBOSITY ======================= */

function fakeResearch(intent: string, evd: Evidence[], extras: Partial<Record<string, unknown>> = {}) {
  const p = pipeline(intent, evd);
  return {
    plan: { intent, mode: "MATCHUP", depth: "SLATE", sport: "baseball_mlb",
      steps: ["slate"], entities: { teams: [], players: [], date: null, eventId: null, rank: null, team_matches: [], player_hints: [] },
      budget: 12, why: "test" },
    state: { teams: [], sport: "baseball_mlb", eventId: null, lastIntent: intent },
    evidence: p.quarantine.kept,
    conflicts: [], unavailable: [], attack: null,
    memory: { facts: [], outcomes: [], patterns: [], prior: [] },
    data_path: {}, focus: null, calls: 3, ms: 5, log: [],
    completeness: { pct: 90, available: ["pitcher_quality"], partial: [], stale: [], missing: [], note: "" },
    integrity: p.integrity,
    coverage: [], snapshot: null, changed: null, findings: [], queue: [],
    cross: [], movement: null,
    entities: { teams: [], rejected_teams: [], players: [] },
    semantic: p.coverage,
    research_completeness: p.gate,
    slate_scope: { sport: "baseball_mlb", date: TODAY, timezone: "America/New_York",
      expected_games: p.universe.games.length, retrieved_games: p.universe.games.length,
      live_games: p.universe.games.length, scheduled_games: p.universe.games.length,
      final_games: 0, postponed_games: 0, missing_games: 0, dropped_final: 0,
      complete: true, note: "" },
    requirements: p.reqs,
    fallback_retrievals: [],
    thesis_attack: { support: [], contradictions: [], unresolved_questions: [], falsifiers: [] },
    deterministic_context: null,
    answerability: p.answerability,
    excluded_evidence: p.quarantine.excluded,
    sport: "baseball_mlb", sport_module: null, identity: [],
    source_reliability: [], leakage: { as_of: null, checked: 0, excluded: 0, undated: 0, excluded_items: [], note: "" },
    capabilities: [], learning_context: null,
    ...extras,
  } as any;
}

test("20: the prompt orders answer-first and keeps a clean packet's integrity block to one line", () => {
  const evd = mlbPacket([
    { name: "Jacob deGrom", team: "Texas Rangers", opp: "Los Angeles Angels" },
  ], [seasonRollup(["Jacob deGrom"])]);
  const research = fakeResearch("worst_pitchers", evd);
  const prompt = buildUserContent({ mode: "chat", question: "worst pitchers today" }, research);

  assert.match(prompt, /ANSWERABILITY — computed deterministically/);
  assert.match(prompt, /ANSWER FIRST\./);
  // clean packet: one-line integrity, no per-check essay
  assert.match(prompt, /All integrity checks passed\. No caveat is needed/);
  // the answerability block precedes the evidence block
  assert.ok(prompt.indexOf("ANSWERABILITY") < prompt.indexOf("EVIDENCE —"));
});

test("20b: a clean-subset prompt names clean and excluded entities and forbids opening with diagnostics", () => {
  const specs: StarterSpec[] = [
    { name: "Good Arm", team: "Boston Red Sox", opp: "New York Yankees", eventId: "P1" },
    { name: "Bad Join", team: "Cincinnati Reds", opp: "Washington Nationals", conflictTeam: "Seattle Mariners", eventId: "P2" },
  ];
  const research = fakeResearch("worst_pitchers", mlbPacket(specs));
  const prompt = buildUserContent({ mode: "chat", question: "worst pitchers today" }, research);

  assert.match(prompt, /answer_mode=CLEAN_SUBSET/);
  assert.match(prompt, /CLEAN ENTITIES/);
  assert.match(prompt, /Good Arm/);
  assert.match(prompt, /EXCLUDED ENTITIES/);
  assert.match(prompt, /Bad Join/);
  assert.match(prompt, /Do not open with the data problem/);
  // the excluded pitcher's matchup numbers are NOT in the evidence payload
  const evidenceBlock = prompt.slice(prompt.indexOf("EVIDENCE —"));
  assert.ok(!/"field":"pitcher_quality"[^\n]*Bad Join/.test(evidenceBlock));
});

test("verdict vocabulary: LOCALIZED exists and FAIL is reserved for global damage", () => {
  // a packet with one broken join out of three is LOCALIZED, not FAIL
  const specs: StarterSpec[] = [
    { name: "A One", team: "Boston Red Sox", opp: "New York Yankees", eventId: "V1" },
    { name: "B Two", team: "San Diego Padres", opp: "Colorado Rockies", eventId: "V2" },
    { name: "C Three", team: "Cincinnati Reds", opp: "Washington Nationals", conflictTeam: "Seattle Mariners", eventId: "V3" },
  ];
  const integ = evidenceIntegrity(mlbPacket(specs), {
    slateDays: [TODAY, etDay(1)], sport: "baseball_mlb",
    delivered: { included: 12, withheld: 0 },
  });
  assert.equal(integ.verdict, "LOCALIZED");
  assert.match(integ.summary, /1 of 3 subjects excluded|LOCALIZED/);
});
