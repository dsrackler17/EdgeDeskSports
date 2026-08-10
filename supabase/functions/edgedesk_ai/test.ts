// supabase/functions/edgedesk_ai/test.ts
// ============================================================================
// Research-engine test suite.
//
//   deno test --allow-env supabase/functions/edgedesk_ai/test.ts
//   node --experimental-strip-types supabase/functions/edgedesk_ai/test.ts
//
// These exercise the real classifier, the real Dal, and the real evidence /
// conflict / completeness / attack logic against a mocked Supabase REST layer.
// No API key and no network are required — the Anthropic call is not part of
// the research engine and is not under test here.
//
// The point of the suite is the honesty contract: every case that could tempt
// the system into inventing data asserts that it reports the gap instead.
// ============================================================================

import {
  Dal, classify, deriveState, attackThesis, findConflicts, completeness, coverage,
  freshnessOf, ev, resolveTeams, personKey, etDay, clearCache,
  buildSnapshot, diffSnapshots, extractFindings, scout, MODE_OF_INTENT,
  crossMarketFlags, movementRead,
} from "./_lib.ts";

/* ------------------------------------------------------------ harness */

let passed = 0, failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
function section(s: string) { console.log(`\n${s}`); }

/* --------------------------------------------------- mock database */

const TODAY = etDay(0);

interface Fixture { [table: string]: any[] | "error" | "rls" | undefined }

function mockFetch(fx: Fixture): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("statsapi.mlb.com")) {
      if (fx.__statsapi === "error") return new Response("nope", { status: 503 });
      if (u.includes("/schedule")) return new Response(JSON.stringify(STATSAPI_SCHED), { status: 200 });
      if (u.includes("/people")) return new Response(JSON.stringify(STATSAPI_PEOPLE), { status: 200 });
      if (u.includes("/teams/stats")) {
        if (u.includes("group=pitching")) return new Response(JSON.stringify(STATSAPI_LEAGUE_PITCHING), { status: 200 });
        if (u.includes("sitCodes=vl")) return new Response(JSON.stringify(STATSAPI_HIT_VL), { status: 200 });
        if (u.includes("sitCodes=vr")) return new Response(JSON.stringify(STATSAPI_HIT_VR), { status: 200 });
        return new Response(JSON.stringify(STATSAPI_TEAMS), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }
    const table = u.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    const rows = fx[table];
    if (rows === "error") return new Response("boom", { status: 500 });
    if (rows === "rls") return new Response(JSON.stringify({ message: "permission denied for table " + table }), { status: 403 });
    if (rows === undefined) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });

    let out = rows as any[];
    // Honour the two filters the engine actually relies on, so join bugs surface.
    const q = u.split("?")[1] ?? "";
    const gid = q.match(/game_id=in\.\(([^)]*)\)/);
    if (gid) {
      const ids = gid[1].split(",").map((s) => decodeURIComponent(s.replace(/^"|"$/g, "")));
      out = out.filter((r) => ids.includes(String(r.game_id)));
    }
    const gdate = q.match(/game_date=in\.\(([^)]*)\)/);
    if (gdate) {
      const days = gdate[1].split(",");
      out = out.filter((r) => days.includes(String(r.game_date)));
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function dal(fx: Fixture, budget = 24) {
  clearCache();   // one fixture must never bleed into the next
  return new Dal({
    supabaseUrl: "https://x.supabase.co", apikey: "anon", authorization: "Bearer jwt",
    fetchImpl: mockFetch(fx), budget,
  });
}

/* ------------------------------------------------------- fixtures */

const SIGNAL_LIVE = {
  event_id: "ev1", sport_key: "baseball_mlb", sport_title: "MLB", market: "h2h",
  selection: "New York Yankees", point: null, best_dec: 1.85, first_best_dec: 1.91,
  best_book: "DraftKings", sharp_fair: 0.57, consensus_fair: 0.56, edge: 0.041, first_edge: 0.048,
  n_books: 7, n_books_eff: 7, has_sharp: true, corrob_n: 2, pin_dec: 1.79, pin_opp_dec: 2.12,
  home_team: "Boston Red Sox", away_team: "New York Yankees",
  commence_time: new Date(Date.now() + 4 * 3600e3).toISOString(),
  first_seen_at: new Date(Date.now() - 90 * 60e3).toISOString(),
  last_seen_at: new Date(Date.now() - 5 * 60e3).toISOString(),
  clv: null, beat_close: null, result: null, graded_at: null, closing_sharp_fair: null,
};
const SIGNAL_PRICE_KILLED = {
  ...SIGNAL_LIVE, event_id: "ev2", selection: "Chicago Cubs", edge: 0.004, first_edge: 0.052,
  home_team: "Chicago Cubs", away_team: "Milwaukee Brewers",
};
const SIGNAL_STALE = {
  ...SIGNAL_LIVE, event_id: "ev3", selection: "Seattle Mariners", edge: 0.038,
  home_team: "Seattle Mariners", away_team: "Oakland Athletics",
  last_seen_at: new Date(Date.now() - 90 * 60e3).toISOString(),
};
const SIGNAL_NO_SHARP = {
  ...SIGNAL_LIVE, event_id: "ev4", selection: "Miami Marlins", has_sharp: false, n_books: 3,
  sharp_fair: null, home_team: "Miami Marlins", away_team: "Atlanta Braves",
};

const CARD = [{
  game_date: TODAY, start_time: new Date(Date.now() + 4 * 3600e3).toISOString(), start_time_local: "7:10 PM",
  venue: "Fenway Park", status: "Scheduled", doubleheader: "N", game_number: 1,
  away_team_id: 147, away_team_name: "New York Yankees", away_record: "62-50", away_streak: "W3",
  away_pitcher_name: "Carlos Rodón", away_pitcher_throws: "L",
  home_team_id: 111, home_team_name: "Boston Red Sox", home_record: "55-57", home_streak: "L2",
  home_pitcher_name: "Kutter Crawford", home_pitcher_throws: "R",
  park_factor: 1.08, hr_factor: 1.02, run_factor: 1.06, roof_type: "Open", is_dome: false,
  temp_f: 78, humidity: 55, precip_prob: 5, wind_mph: 11, wind_dir: "SW", wind_rel: "out",
}, {
  game_date: TODAY, start_time: new Date(Date.now() + 6 * 3600e3).toISOString(), start_time_local: "9:40 PM",
  venue: "T-Mobile Park", status: "Scheduled", doubleheader: "N", game_number: 1,
  away_team_id: 133, away_team_name: "Oakland Athletics", away_record: "48-64", away_streak: "L1",
  away_pitcher_name: "JP Sears", away_pitcher_throws: "L",
  home_team_id: 136, home_team_name: "Seattle Mariners", home_record: "60-52", home_streak: "W1",
  home_pitcher_name: null, home_pitcher_throws: null,      // starter NOT announced
  park_factor: 0.94, hr_factor: 0.9, run_factor: 0.93, roof_type: "Retractable", is_dome: false,
  temp_f: 66, humidity: 70, precip_prob: 10, wind_mph: 5, wind_dir: "N", wind_rel: "in",
}];

const GAMES = [
  { game_id: "g1", game_date: TODAY, home_team: "Boston Red Sox", away_team: "New York Yankees", start_time: CARD[0].start_time, status: "scheduled", park_id: "BOS" },
  { game_id: "g2", game_date: TODAY, home_team: "Seattle Mariners", away_team: "Oakland Athletics", start_time: CARD[1].start_time, status: "scheduled", park_id: "SEA" },
];
// g1 has pitcher quality; g2 deliberately does NOT — partial coverage is the
// case the old system collapsed into "nothing is on file".
const PITCHER_FEATURES = [
  { game_id: "g1", side: "away", pitcher_id: 9001, name: "Rodón, Carlos", xera: 5.41, k_pct: 0.212, bb_pct: 0.101, barrel_pct: 0.099, hardhit_pct: 0.443 },
  { game_id: "g1", side: "home", pitcher_id: 9002, name: "Kutter Crawford", xera: 3.72, k_pct: 0.248, bb_pct: 0.055, barrel_pct: 0.081, hardhit_pct: 0.401 },
];
const OFFENSE_FEATURES = [
  { game_id: "g1", side: "home", obp: 0.331, iso: 0.181, k_pct: 0.203, runs_per_game: 5.1 },
  { game_id: "g1", side: "away", obp: 0.342, iso: 0.196, k_pct: 0.219, runs_per_game: 5.4 },
];
const USAGE = [
  { pitcher_id: 9001, game_date: etDay(-5), pitches: 96, outs: 16, started: true },
  { pitcher_id: 9002, game_date: etDay(-4), pitches: 88, outs: 18, started: true },
];

const STATSAPI_SCHED = { dates: [{ games: [{
  teams: {
    away: { team: { id: 147, name: "New York Yankees" }, probablePitcher: { id: 9001, fullName: "Carlos Rodón" } },
    home: { team: { id: 111, name: "Boston Red Sox" },   probablePitcher: { id: 9002, fullName: "Kutter Crawford" } },
  },
}] }] };
const STATSAPI_LEAGUE_PITCHING = { stats: [{ splits: Array.from({ length: 30 }, () => ({
  stat: { inningsPitched: "1000.0", homeRuns: 110, baseOnBalls: 330, hitBatsmen: 40, strikeOuts: 900, earnedRuns: 440 },
})) }] };
const STATSAPI_HIT_VL = { stats: [{ splits: [
  { team: { id: 111 }, stat: { avg: ".240", obp: ".310", slg: ".390", ops: ".700", runs: 140, gamesPlayed: 112, strikeOuts: 230, baseOnBalls: 95, plateAppearances: 1000, homeRuns: 34 } },
  { team: { id: 147 }, stat: { avg: ".270", obp: ".360", slg: ".480", ops: ".840", runs: 190, gamesPlayed: 112, strikeOuts: 200, baseOnBalls: 120, plateAppearances: 1000, homeRuns: 52 } },
] }] };
const STATSAPI_HIT_VR = { stats: [{ splits: [
  { team: { id: 111 }, stat: { avg: ".262", obp: ".338", slg: ".442", ops: ".780", runs: 430, gamesPlayed: 112, strikeOuts: 660, baseOnBalls: 300, plateAppearances: 3000, homeRuns: 114 } },
  { team: { id: 147 }, stat: { avg: ".246", obp: ".330", slg: ".430", ops: ".760", runs: 410, gamesPlayed: 112, strikeOuts: 740, baseOnBalls: 330, plateAppearances: 3000, homeRuns: 126 } },
] }] };

const STATSAPI_PEOPLE = { people: [
  { id: 9001, fullName: "Carlos Rodón", pitchHand: { code: "L" }, stats: [
    { group: { displayName: "pitching" }, type: { displayName: "season" }, splits: [{ stat: {
      era: "5.41", whip: "1.48", strikeoutsPer9Inn: "8.12", walksPer9Inn: "4.02", strikeoutWalkRatio: "2.04",
      inningsPitched: "121.2", strikeOuts: 110, baseOnBalls: 54, hitBatsmen: 6, homeRuns: 22,
      gamesStarted: 22, battersFaced: 540, groundOutsToAirouts: "0.78",
      strikePercentage: ".620", pitchesPerInning: "16.8" } }] },
    { group: { displayName: "pitching" }, type: { displayName: "gameLog" }, splits: [
      { date: "2026-08-05", stat: { gamesStarted: 1, inningsPitched: "5.1", numberOfPitches: 96, earnedRuns: 4, strikeOuts: 6, baseOnBalls: 3 } },
      { date: "2026-07-30", stat: { gamesStarted: 1, inningsPitched: "6.0", numberOfPitches: 101, earnedRuns: 2, strikeOuts: 8, baseOnBalls: 1 } },
      { date: "2026-07-24", stat: { gamesStarted: 1, inningsPitched: "4.2", numberOfPitches: 88, earnedRuns: 5, strikeOuts: 4, baseOnBalls: 4 } },
      { date: "2026-07-19", stat: { gamesStarted: 0, inningsPitched: "1.0", numberOfPitches: 15 } },
    ] },
  ] },
  { id: 9002, fullName: "Kutter Crawford", pitchHand: { code: "R" }, stats: [
    { group: { displayName: "pitching" }, type: { displayName: "season" }, splits: [{ stat: {
      era: "3.72", whip: "1.11", strikeoutsPer9Inn: "9.44", walksPer9Inn: "2.10", strikeoutWalkRatio: "4.52",
      inningsPitched: "134.0", strikeOuts: 140, baseOnBalls: 31, hitBatsmen: 4, homeRuns: 18,
      gamesStarted: 23, battersFaced: 545, groundOutsToAirouts: "1.42",
      strikePercentage: ".660", pitchesPerInning: "15.1" } }] },
  ] },
] };
const STATSAPI_TEAMS = { stats: [{ splits: [
  { team: { id: 111, name: "Boston Red Sox" },   stat: { obp: ".331", slg: ".428", ops: ".759", avg: ".256", runs: 571, gamesPlayed: 112, strikeOuts: 890, baseOnBalls: 401, homeRuns: 148 } },
  { team: { id: 147, name: "New York Yankees" }, stat: { obp: ".342", slg: ".451", ops: ".793", avg: ".251", runs: 604, gamesPlayed: 112, strikeOuts: 940, baseOnBalls: 452, homeRuns: 178 } },
] }] };

const FULL: Fixture = {
  signals: [SIGNAL_LIVE, SIGNAL_PRICE_KILLED, SIGNAL_STALE, SIGNAL_NO_SHARP],
  mlb_game_cards: CARD, games: GAMES, pitcher_features: PITCHER_FEATURES,
  offense_features: OFFENSE_FEATURES, mlb_pitcher_usage: USAGE,
  mlb_bullpen_taxed: [{ team_id: 111, full_name: "Chris Martin", flag: "b2b", pitches_yesterday: 22, severity: 2 }],
  mlb_bullpen_team: [{ team_id: 111, closer_name: "Kenley Jansen", closer_flag: "fresh" }],
  venue_weather: [{ event_id: "ev1", temp_f: 78, wind_mph: 11, wind_component_out: 6, precip_prob: 5, is_dome: false, fetched_at: new Date(Date.now() - 20 * 60e3).toISOString() }],
  research_facts: [], research_outcomes: [], research_patterns: [], research_sessions: [],
};

/* ===================================================================== */
/* 1–8  intent classification -> the right research workflow             */
/* ===================================================================== */

section("Intent classification");
eq("1  worst pitcher -> slate pitcher research", classify("Who's the worst pitcher on today's slate?").intent, "worst_pitchers");
ok("1b worst pitcher retrieves opponent offense too", classify("Who's the worst pitcher today?").steps.includes("opponent_offense"));
eq("2  best matchup", classify("What are the best pitching matchups today?").intent, "best_matchups");
eq("3  best MLB bet", classify("Find me the best MLB moneyline edges.").intent, "best_bets");
eq("4  why this bet", classify("Why does EdgeDesk like this?").intent, "why");
eq("5  attack", classify("Attack this bet.").intent, "attack");
ok("5b attack runs DEEP", classify("Convince me not to bet it.").depth === "DEEP");
eq("6  what changed", classify("What changed since this signal was detected?").intent, "what_changed");
eq("7  compare", classify("Compare Yankees vs Red Sox and Dodgers vs Giants.").intent, "compare");
eq("8  historical similarity", classify("What happened the last time this type of setup appeared?").intent, "historical");
eq("8b exploitable is NOT the same intent as worst", classify("Which pitcher is most exploitable?").intent, "exploitable_pitchers");
eq("8c market disagreement", classify("What does Pinnacle disagree with?").intent, "market_disagreement");
eq("8d price question stays QUICK", classify("Is this line still playable?").depth, "QUICK");
eq("8e entity resolution", resolveTeams("Research Dodgers vs Diamondbacks."), ["Arizona Diamondbacks", "Los Angeles Dodgers"]);
eq("8f accented + reversed name keys collapse", personKey("Rodón, Carlos"), personKey("Carlos Rodon"));

/* ===================================================================== */
/* 9  missing pitcher data is reported as PARTIAL COVERAGE, not "nothing" */
/* ===================================================================== */

section("Partial coverage (the reported bug)");
{
  const d = dal(FULL);
  const pf = await d.getPitcherFeatures();
  const starters = ["Carlos Rodón", "Kutter Crawford", "JP Sears"];
  const cov = coverage(pf.ev, "pitcher_quality", starters);
  eq("9  quality usable for 2 of 3 starters", [cov.have_n, cov.total_n], [2, 3]);
  ok("9b names the starter that lacks it", cov.missing.includes("JP Sears"), cov.missing);
  ok("9c does not claim the field is globally unavailable", cov.have_n > 0);
  ok("9d opponent offense joined via the OPPOSITE side", (() => {
    const e = pf.ev.find((x) => x.field === "opponent_offense" && String(x.entity).includes("Rod"));
    return (e?.value as any)?.obp === 0.331;   // away pitcher faces the home offense
  })());
  ok("9e workload attached from usage", pf.ev.some((x) => x.field === "workload" && (x.value as any).pitches === 96));
}

/* ===================================================================== */
/* 10–12  data-path diagnosis when the join genuinely fails              */
/* ===================================================================== */

section("Data-path diagnosis");
{
  // Table holds rows, but under game_ids that today's `games` never produces.
  const d = dal({ ...FULL, pitcher_features: [{ game_id: "SOMETHING_ELSE", name: "X", xera: 4 }] });
  const pf = await d.getPitcherFeatures();
  const diag = String((pf.path.pitcher_features_probe as any)?.diagnosis ?? "");
  ok("10 join mismatch diagnosed as B", diag.startsWith("B"), diag);
}
{
  const d = dal({ ...FULL, pitcher_features: [] });
  const pf = await d.getPitcherFeatures();
  const diag = String((pf.path.pitcher_features_probe as any)?.diagnosis ?? "");
  ok("11 genuinely empty table diagnosed as A", diag.startsWith("A"), diag);
}
{
  const d = dal({ ...FULL, games: "rls" });
  const pf = await d.getPitcherFeatures();
  const diag = String((pf.path.games_probe as any)?.diagnosis ?? "");
  ok("12 RLS denial diagnosed as E, not as missing data", diag.startsWith("E"), diag);
}
{
  const d = dal({ ...FULL, games: [{ ...GAMES[0], game_date: etDay(-30) }] });
  const pf = await d.getPitcherFeatures();
  const diag = String((pf.path.games_probe as any)?.diagnosis ?? "");
  ok("12b stale ingestion diagnosed as C with the latest date", diag.startsWith("C") && diag.includes(etDay(-30)), diag);
}

/* ===================================================================== */
/* 13–17  deterministic verdict discipline (attack runs on owned fields)  */
/* ===================================================================== */

section("Thesis attack on owned numbers");
eq("13 price past the floor -> INVALIDATED", attackThesis(SIGNAL_PRICE_KILLED).status, "INVALIDATED");
eq("14 stale capture -> WEAKENED (a WAIT condition, not a PASS)", attackThesis(SIGNAL_STALE).status, "WEAKENED");
eq("15 no sharp + thin books -> WEAKENED", attackThesis(SIGNAL_NO_SHARP).status, "WEAKENED");
eq("16 healthy signal -> SURVIVES", attackThesis(SIGNAL_LIVE).status, "SURVIVES");
eq("17 no fair price -> PENDING, never PASS", attackThesis({ ...SIGNAL_LIVE, edge: null }).status, "PENDING");
ok("17b suspiciously large edge is flagged as a falsifier",
  attackThesis({ ...SIGNAL_LIVE, edge: 0.09 }).falsifiers.some((f) => /stale or bad price/.test(f)));
ok("17c decayed edge is flagged",
  attackThesis({ ...SIGNAL_LIVE, edge: 0.012, first_edge: 0.05 }).falsifiers.some((f) => /decayed/.test(f)));

/* ===================================================================== */
/* 18  empty research source degrades honestly                           */
/* ===================================================================== */

section("Empty and broken sources");
{
  const d = dal({});
  const s = await d.getSlate();
  eq("18 empty board yields UNAVAILABLE, not a fabricated slate", s.ev[0].status, "UNAVAILABLE");
  ok("18b names the table", s.ev[0].source === "signals");
}
{
  const d = dal({ signals: "error" });
  const s = await d.getSlate();
  ok("18c a 500 is reported, never swallowed", String(s.ev[0].note).includes("HTTP 500"), s.ev[0].note);
}
{
  const d = dal({ ...FULL, research_facts: "rls" });
  const m = await d.getResearchMemory(["New York Yankees"], "baseball_mlb");
  ok("18d missing memory tables tell you to run the migration",
    m.ev.some((e) => e.status === "UNAVAILABLE" && String(e.note).includes("migration")));
}

/* ===================================================================== */
/* 19  contradictory sources are surfaced, never silently collapsed      */
/* ===================================================================== */

section("Conflict detection");
{
  const list = [
    ev({ source: "mlb_game_cards", entity: "NYY @ BOS", field: "probable_starter", value: "Carlos Rodón", status: "PROBABLE" }),
    ev({ source: "pitcher_features", entity: "NYY @ BOS", field: "probable_starter", value: "Nestor Cortes", status: "VERIFIED" }),
  ];
  const c = findConflicts(list);
  eq("19 disagreement detected", c.length, 1);
  eq("19b resolved to the trusted source for that field", c[0].resolution, "mlb_game_cards");

  const unresolved = findConflicts([
    ev({ source: "srcA", entity: "g", field: "attendance", value: 100, status: "VERIFIED" }),
    ev({ source: "srcB", entity: "g", field: "attendance", value: 900, status: "VERIFIED" }),
  ]);
  eq("19c unlisted field stays contested", unresolved[0].resolution, null);

  eq("19d agreement is not a conflict", findConflicts([
    ev({ source: "a", entity: "g", field: "temp", value: 78, status: "VERIFIED" }),
    ev({ source: "b", entity: "g", field: "temp", value: 78, status: "VERIFIED" }),
  ]).length, 0);
}

/* ===================================================================== */
/* 20  repeated research is cached; budget is enforced                    */
/* ===================================================================== */

section("Cost control");
{
  const d = dal(FULL);
  await d.getMlbCard();
  const first = d.calls;
  await d.getMlbCard();
  eq("20 repeated schedule read is served from cache", d.calls, first);
}
{
  const d = dal(FULL, 2);
  await d.getSlate(); await d.getMlbCard(); const r = await d.getSlate("baseball_mlb");
  ok("20b budget stops runaway retrieval", String(r.ev[0].note ?? "").includes("budget")
    || d.calls <= 2, { calls: d.calls });
}

/* ===================================================================== */
/* freshness + staleness never masquerade as current                      */
/* ===================================================================== */

section("Freshness");
eq("F1 fresh odds are CURRENT", freshnessOf("odds", Date.now() - 60e3), "CURRENT");
eq("F2 20-minute-old odds are RECENT", freshnessOf("odds", Date.now() - 20 * 60e3), "RECENT");
eq("F3 day-old odds are STALE", freshnessOf("odds", Date.now() - 26 * 3600e3), "STALE");
eq("F4 no timestamp is UNKNOWN, not CURRENT", freshnessOf("odds", null), "UNKNOWN");
ok("F5 a stale fact cannot be VERIFIED",
  ev({ source: "s", field: "f", value: 1, status: "VERIFIED", freshness: "STALE" }).status === "STALE");
{
  const d = dal({
    ...FULL,
    venue_weather: [{ event_id: "ev1", temp_f: 70, wind_mph: 4, is_dome: false, fetched_at: new Date(Date.now() - 30 * 3600e3).toISOString() }],
  });
  const w = await d.getWeather(["ev1"]);
  eq("F6 stale weather is downgraded, not presented as current", w[0].status, "STALE");
}

/* ===================================================================== */
/* probable vs confirmed, and model output stays UNPROVEN                 */
/* ===================================================================== */

section("Status discipline");
{
  const d = dal(FULL);
  const card = await d.getMlbCard();
  const starters = card.ev.filter((e) => e.field === "probable_starter");
  ok("S1 announced starters are PROBABLE, never VERIFIED",
    starters.filter((s) => s.status !== "UNAVAILABLE").every((s) => s.status === "PROBABLE"));
  ok("S2 an unannounced starter is UNAVAILABLE with a reason",
    starters.some((s) => s.status === "UNAVAILABLE" && String(s.note).includes("not announced")));
}
{
  const d = dal({ ...FULL, model_predictions: [{ market: "h2h", selection: "New York Yankees", model_prob: 0.58, model_edge: 0.03, model_version: "v3" }] });
  const m = await d.getModel("ev1");
  eq("S3 model output is UNPROVEN", m[0].status, "UNPROVEN");
  ok("S4 and is labelled as feeding no edge math", String(m[0].note).includes("feeds no edge math"));
}
{
  const d = dal({ ...FULL, signals: [{ clv: 0.01, beat_close: true, result: "win", first_edge: 0.03 }] });
  const h = await d.getCLVHistory("baseball_mlb", "h2h", 0.03);
  ok("S5 a 1-row sample refuses to be a read", String(h[0].value && (h[0].value as any).note).includes("too small"));
}
{
  const rows = Array.from({ length: 60 }, (_, i) => ({ clv: 0.005, beat_close: i % 2 === 0, result: "win", first_edge: 0.03 }));
  const d = dal({ ...FULL, signals: rows });
  const h = await d.getCLVHistory("baseball_mlb", "h2h", 0.03);
  eq("S6 a real sample reports N", (h[0].value as any).n, 60);
  eq("S7 and stays HISTORICAL, never proof", h[0].status, "HISTORICAL");
}

/* ===================================================================== */
/* completeness scoring                                                   */
/* ===================================================================== */

section("Research completeness");
{
  const d = dal(FULL);
  const card = await d.getMlbCard();
  const pf = await d.getPitcherFeatures();
  const slate = await d.getSlate();
  const all = [...slate.ev, ...card.ev, ...pf.ev];
  const c = completeness(all, "baseball_mlb");
  ok("C1 completeness is a real percentage", c.pct > 40 && c.pct <= 100, c);
  ok("C2 it names what is missing", Array.isArray(c.missing));
  const bare = completeness([], "baseball_mlb");
  eq("C3 nothing retrieved scores 0", bare.pct, 0);
  ok("C4 and lists every dimension as missing", bare.missing.length >= 8);
}

/* ===================================================================== */
/* conversation state carries the subject forward                         */
/* ===================================================================== */

section("Conversation state");
{
  const p1 = classify("Research Dodgers vs Diamondbacks.");
  const s1 = deriveState([], p1, null, null);
  ok("V1 first turn resolves both clubs", s1.teams.length === 2, s1.teams);

  const p2 = classify("What about the bullpen?");
  const s2 = deriveState([{ role: "user", content: "Research Dodgers vs Diamondbacks." }], p2, null, s1);
  ok("V2 follow-up keeps the same subject without repeating it", s2.teams.length === 2, s2.teams);

  const p3 = classify("Now attack both.");
  const s3 = deriveState([], p3, null, s2);
  eq("V3 subject survives another hop", s3.teams, s2.teams);

  const s4 = deriveState([], classify("What changed?"), { game: { matchup: "Seattle Mariners @ Oakland Athletics" }, sport_key: "baseball_mlb" }, s3);
  ok("V4 an open signal overrides the carried subject", s4.teams.includes("Seattle Mariners"), s4.teams);
}

/* ===================================================================== */

/* ===================================================================== */
/* research packet versioning (§14, §21)                                  */
/* ===================================================================== */

section("Research packet versioning");
{
  clearCache();
  const d = dal(FULL);
  const card = await d.getMlbCard();
  const pf = await d.getPitcherFeatures();
  const all = [...card.ev, ...pf.ev];

  const v1 = buildSnapshot("ev1", all, SIGNAL_LIVE, 1);
  ok("P1 snapshot captures market + matchup scalars",
    v1.facts.edge === 0.041 && v1.facts.away_starter != null, v1.facts);

  eq("P2 first look reports no earlier packet",
    diffSnapshots(null, v1).note.includes("version 1"), true);

  // price improves, starter gets scratched, wind picks up
  const later = { ...SIGNAL_LIVE, best_dec: 1.95, edge: 0.061 };
  const v2 = buildSnapshot("ev1", all.filter((e) => !(e.field === "probable_starter" && String(e.entity).includes("Rod"))), later, 2);
  const diff = diffSnapshots(v1, v2);
  ok("P3 price movement detected with direction",
    diff.changed.some((c) => c.field === "current_price" && c.direction === "up"), diff.changed);
  ok("P4 edge movement detected", diff.changed.some((c) => c.field === "edge"));
  ok("P5 a lost starter is reported as lost, not silently dropped",
    diff.changed.some((c) => c.field === "away_starter" && c.direction === "lost"), diff.changed);
  ok("P6 unchanged fields are listed, not invented", Array.isArray(diff.unchanged));

  const same = diffSnapshots(v1, buildSnapshot("ev1", all, SIGNAL_LIVE, 2));
  eq("P7 nothing changed says so plainly", same.changed.length, 0);
}

/* ===================================================================== */
/* structured findings — no knowledge contamination (§3, §15)             */
/* ===================================================================== */

section("Findings extraction");
{
  clearCache();
  const d = dal(FULL);
  const pf = await d.getPitcherFeatures();
  const card = await d.getMlbCard();
  const f = extractFindings([...pf.ev, ...card.ev]);

  ok("K1 findings are produced from evidence", f.length > 0);
  ok("K2 every finding names its source table", f.every((x) => !!x.source));
  ok("K3 every finding carries the record it came from", f.every((x) => x.fact_value != null));
  ok("K4 every finding expires", f.every((x) => !!x.valid_until));
  const q = f.find((x) => x.fact_type === "pitcher_quality");
  ok("K5 the claim quotes the actual number, not an adjective",
    !!q && /xERA 5\.41/.test(q.claim) && !/terrible|bad|elite/i.test(q.claim), q?.claim);
  const ps = f.find((x) => x.fact_type === "probable_starter");
  ok("K6 probable starters are stored as probable, never verified",
    !!ps && ps.verification_status === "PROBABLE" && /not confirmed/.test(ps.claim), ps?.claim);
  ok("K7 weather expires faster than park factors", (() => {
    const w = f.find((x) => x.fact_type === "weather"), p = f.find((x) => x.fact_type === "park");
    if (!w || !p) return true;
    return Date.parse(w.valid_until!) < Date.parse(p.valid_until!);
  })());
  eq("K8 UNAVAILABLE evidence never becomes a finding",
    extractFindings([ev({ source: "pitcher_features", field: "pitcher_quality", entity: "X", value: null, status: "UNAVAILABLE" })]).length, 0);
}

/* ===================================================================== */
/* proactive research scout + research-vs-betting separation (§10, §11)   */
/* ===================================================================== */

section("Research queue");
{
  const q = scout([SIGNAL_LIVE, SIGNAL_PRICE_KILLED, SIGNAL_STALE, SIGNAL_NO_SHARP]);
  ok("Q1 the scout flags something", q.length > 0);
  ok("Q2 a stale playable number is flagged",
    q.some((i) => i.flags.some((f) => /stale capture/.test(f))), q.map((i) => i.flags));
  ok("Q3 a thin, unconfirmed edge is flagged",
    q.some((i) => i.flags.some((f) => /Pinnacle print|weak confirmation/.test(f))));
  ok("Q4 a decayed edge is flagged",
    q.some((i) => i.flags.some((f) => /decayed/.test(f))));
  ok("Q5 research interest is kept separate from betting action",
    q.every((i) => !!i.research_interest && !!i.betting_action));
  ok("Q6 a sub-floor game is never presented as a bet",
    q.filter((i) => i.event_id === "ev2").every((i) => /not a bet/.test(i.betting_action)),
    q.filter((i) => i.event_id === "ev2").map((i) => i.betting_action));
  eq("Q7 a clean board produces an empty queue, not invented flags",
    scout([{ ...SIGNAL_LIVE, edge: 0.03, first_edge: 0.03, n_books: 8, has_sharp: true, pin_dec: 1.84 }]).length, 0);
}

/* ===================================================================== */
/* named research modes (§8)                                              */
/* ===================================================================== */

section("Research modes");
eq("M1 attack question -> ATTACK", classify("Attack this bet.").mode, "ATTACK");
eq("M2 comparison -> COMPARE", classify("Compare these three games.").mode, "COMPARE");
eq("M3 history -> HISTORICAL", classify("Have we seen this setup before?").mode, "HISTORICAL");
eq("M4 pricing -> MARKET", classify("Is this line still playable?").mode, "MARKET");
eq("M5 pitcher matchup -> MATCHUP", classify("Which pitcher is most exploitable?").mode, "MATCHUP");
eq("M6 slate sweep -> SLATE", classify("Find me the best MLB moneyline edges.").mode, "SLATE");
eq("M7 triage -> SCOUT", classify("What should I research next?").mode, "SCOUT");
eq("M8 postmortem -> POSTMORTEM", classify("Why did EdgeDesk get that one wrong?").mode, "POSTMORTEM");
ok("M9 postmortem retrieves the closing line and CLV, not today's card",
  classify("Why did EdgeDesk get that one wrong?").steps.includes("closing_line"));
eq("M10 a plain why stays FAST", classify("Why do you like this?").mode, "FAST");
ok("M11 every intent maps to a mode", Object.values(MODE_OF_INTENT).every((m) => typeof m === "string"));

/* ===================================================================== */
/* live fallback when the owned feature pipeline is stale                 */
/* ===================================================================== */

section("Official-feed fallback (stale ingestion)");
{
  // Reproduces the reported failure: games are current, pitcher_features is not.
  const d = dal({ ...FULL, pitcher_features: [], offense_features: [] });
  const pf = await d.getPitcherFeatures();

  ok("L1 the fallback fires when the owned table is empty",
    !!pf.path.live_fallback, Object.keys(pf.path));
  ok("L2 and says why, naming the repair",
    /repair ingest_mlb/.test(String(pf.path.live_fallback_reason)), pf.path.live_fallback_reason);

  const q = pf.ev.filter((e) => e.field === "pitcher_quality" && e.status !== "UNAVAILABLE");
  eq("L3 both starters now carry a usable line", q.length, 2);
  ok("L4 the line is the official ERA, not an invented xERA",
    (q.find((e) => String(e.entity).includes("Rod"))!.value as any).era === 5.41);
  ok("L5 Statcast fields stay declared missing, never approximated",
    q.every((e) => (e.value as any).missing_fields.includes("xera")
                && (e.value as any).missing_fields.includes("barrel_pct")));
  ok("L6 every fallback fact is attributed to the MLB feed",
    q.every((e) => e.source === "MLB Stats API" && /Statcast-derived/.test(String(e.note))));

  const off = pf.ev.filter((e) => e.field === "opponent_offense" && e.status !== "UNAVAILABLE");
  eq("L7 opponent offense comes with it", off.length, 2);
  ok("L8 and each starter faces the OTHER team's bats",
    (off.find((e) => String(e.entity).includes("Rod"))!.value as any).opponent === "Boston Red Sox",
    (off.find((e) => String(e.entity).includes("Rod"))!.value as any).opponent);
  ok("L9 offense gaps are named too",
    off.every((e) => (e.value as any).applicable.missing_fields.includes("wrc_plus")));

  const cov = coverage(pf.ev, "pitcher_quality", ["Carlos Rodón", "Kutter Crawford"]);
  eq("L10 coverage recovers from 0/2 to 2/2", [cov.have_n, cov.total_n], [2, 2]);
}
{
  // The owned tables are healthy — the fallback must stay out of the way.
  const d = dal(FULL);
  const pf = await d.getPitcherFeatures();
  ok("L11 healthy owned tables do NOT trigger the fallback", !pf.path.live_fallback);
  ok("L12 and the owned Statcast fields are used",
    pf.ev.some((e) => e.field === "pitcher_quality" && (e.value as any).xera === 5.41
      && e.source === "pitcher_features"));
}
{
  const d = new Dal({
    supabaseUrl: "https://x.supabase.co", apikey: "anon", authorization: "Bearer jwt",
    fetchImpl: mockFetch({ ...FULL, pitcher_features: [] }), budget: 24, mlbFallback: false,
  });
  clearCache();
  const pf = await d.getPitcherFeatures();
  ok("L13 the fallback can be switched off entirely", !pf.path.live_fallback);
  ok("L14 and then it reports the gap rather than filling it",
    pf.ev.some((e) => e.status === "UNAVAILABLE"));
}
{
  const d = dal({ ...FULL, pitcher_features: [], __statsapi: "error" } as any);
  const pf = await d.getPitcherFeatures();
  ok("L15 an unreachable feed degrades honestly, it does not throw",
    pf.ev.some((e) => e.status === "UNAVAILABLE"));
}

/* ===================================================================== */
/* cross-market structure — the spots a per-signal board cannot show      */
/* ===================================================================== */

section("Cross-market structure");

const G = { home_team: "Boston Red Sox", away_team: "New York Yankees" };
const mk = (market: string, selection: string, edge: number, over: any = {}) =>
  ({ ...G, market, selection, edge, first_edge: edge, n_books: 7, has_sharp: true, best_dec: 1.9, ...over });

{
  // moneyline AND run line on the same team
  const f = crossMarketFlags([mk("h2h", "New York Yankees", 0.04), mk("spreads", "New York Yankees", 0.035)]);
  ok("X1 two markets on the same side is flagged",
    f.some((x) => x.kind === "multi_market_same_side"), f.map((x) => x.kind));
  ok("X2 ...as high research interest",
    f.find((x) => x.kind === "multi_market_same_side")?.research_interest === "HIGH");
  ok("X3 ...and says why a single verdict cannot show it",
    /not in any single verdict/.test(f.find((x) => x.kind === "multi_market_same_side")!.detail));
}
{
  // nickname on one side must still resolve, or the whole flag is missed
  const f = crossMarketFlags([mk("h2h", "Yankees", 0.04), mk("spreads", "New York Yankees", 0.035)]);
  ok("X4 a nickname still resolves to the same side",
    f.some((x) => x.kind === "multi_market_same_side"), f.map((x) => x.kind));
}
{
  // edges on BOTH teams across markets — they cannot both be right
  const f = crossMarketFlags([mk("h2h", "New York Yankees", 0.04), mk("spreads", "Boston Red Sox", 0.03)]);
  const c = f.find((x) => x.kind === "cross_market_conflict");
  ok("X5 opposite sides of one game is flagged as a conflict", !!c, f.map((x) => x.kind));
  ok("X6 ...and refuses to present it as two bets", /not two bets/.test(c!.detail));
}
{
  // the moneyline is efficient but the total is not — the classic overlooked spot
  const f = crossMarketFlags([mk("h2h", "New York Yankees", 0.001), mk("totals", "Over 8.5", 0.045)]);
  const d = f.find((x) => x.kind === "derivative_only_edge");
  ok("X7 an edge only on a derivative market is surfaced", !!d, f.map((x) => x.kind));
  ok("X8 ...with the reason it is overlooked", /less sharp money/.test(d!.detail));
}
{
  const f = crossMarketFlags([
    mk("h2h", "New York Yankees", 0.04, { has_sharp: true }),
    mk("totals", "Over 8.5", 0.04, { has_sharp: false }),
  ]);
  ok("X9 uneven sharp confirmation across markets is flagged",
    f.some((x) => x.kind === "uneven_sharp_confirmation"), f.map((x) => x.kind));
}
{
  const f = crossMarketFlags([
    mk("h2h", "New York Yankees", 0.04, { n_books: 9 }),
    mk("spreads", "New York Yankees", 0.04, { n_books: 2 }),
  ]);
  ok("X10 a thin market on an otherwise liquid game is flagged",
    f.some((x) => x.kind === "thin_market_on_liquid_game"), f.map((x) => x.kind));
}
{
  eq("X11 a single market has no structure to read", crossMarketFlags([mk("h2h", "New York Yankees", 0.04)]).length, 0);
  eq("X12 an empty board invents nothing", crossMarketFlags([]).length, 0);
  eq("X13 sub-floor edges are not treated as edges",
    crossMarketFlags([mk("h2h", "New York Yankees", 0.001), mk("spreads", "New York Yankees", 0.001)])
      .filter((x) => x.kind === "multi_market_same_side").length, 0);
}

/* ===================================================================== */
/* market movement direction                                             */
/* ===================================================================== */

section("Market movement");

const ticks = (prices: number[]) => prices.map((p, i) => ({ best_dec: p, edge: 0.03, created_at: new Date(Date.now() - (prices.length - i) * 6e5).toISOString() }));

eq("V20 a shortening price is movement TOWARD the side",
  movementRead(2.00, ticks([2.00, 1.95, 1.90])).direction, "toward");
eq("V21 a drifting price is movement AWAY",
  movementRead(2.00, ticks([2.00, 2.05, 2.15])).direction, "away");
eq("V22 a small wobble is flat, not a signal",
  movementRead(2.00, ticks([2.00, 2.00, 2.005])).direction, "flat");
eq("V23 no ticks means unknown, never a guess",
  movementRead(2.00, []).direction, "unknown");
eq("V24 no entry price means unknown", movementRead(null, ticks([2.0, 1.9])).direction, "unknown");
ok("V25 magnitude is reported",
  Math.abs(movementRead(2.00, ticks([2.00, 1.80]))!.moved_pct! - 0.10) < 1e-9);
ok("V26 movement is explicitly NOT called CLV",
  /not CLV/.test(movementRead(2.00, ticks([2.00, 1.90])).note));
ok("V27 drift is not spun as good news",
  /market knows something/.test(movementRead(2.00, ticks([2.00, 2.20])).note));

/* ===================================================================== */
/* the expanded MLB statistical layer                                    */
/* ===================================================================== */

section("MLB stats layer — rate stats, FIP, platoon, workload");
{
  const d = dal({ ...FULL, pitcher_features: [], offense_features: [] });
  const pf = await d.getPitcherFeatures();
  const q = pf.ev.filter((e) => e.field === "pitcher_quality" && e.status !== "UNAVAILABLE");
  const rodon = q.find((e) => String(e.entity).includes("Rod"))!.value as any;
  const craw = q.find((e) => String(e.entity).includes("Crawford"))!.value as any;

  // "121.2" is 121 innings and TWO OUTS. Reading it as 121.2 corrupts every rate.
  ok("N1 innings-pitched thirds are parsed, not read as a decimal",
    Math.abs(rodon.innings_num - 121.7) < 0.05, rodon.innings_num);

  eq("N2 K% is strikeouts over batters faced, not per nine", rodon.k_pct, +(110 / 540).toFixed(3));
  eq("N3 BB% likewise", rodon.bb_pct, +(54 / 540).toFixed(3));
  ok("N4 HR/9 is computed from innings", Math.abs(rodon.hr_per_9 - (9 * 22 / 121.667)) < 0.02, rodon.hr_per_9);

  // FIP with the constant solved from league totals in the same response.
  ok("N5 FIP is computed", rodon.fip != null, rodon.fip);
  ok("N6 ...and the constant is derived, not assumed",
    /solved from this season's league totals, not assumed/.test(rodon.fip_note), rodon.fip_note);
  ok("N7 the league constant is in the data path",
    (pf.path.live_fallback as any)?.fip_constant?.cFIP != null, (pf.path.live_fallback as any)?.fip_constant);
  ok("N8 the worse arm has the worse FIP", rodon.fip > craw.fip, { rodon: rodon.fip, craw: craw.fip });

  eq("N9 batted-ball lean is read from ground-to-air", rodon.batted_ball_lean, "fly-ball");
  eq("N10 ...and the other way for a ground-baller", craw.batted_ball_lean, "ground-ball");
  eq("N11 throwing hand is captured", [rodon.throws, craw.throws], ["L", "R"]);
  ok("N12 strike% and pitches/inning come through", rodon.strike_pct != null && rodon.pitches_per_inning != null);
  ok("N13 Statcast fields are still declared missing, never approximated",
    rodon.missing_fields.includes("xera") && rodon.missing_fields.includes("barrel_pct")
    && rodon.missing_fields.includes("csw_pct"));

  // platoon split — the single most matchup-relevant field
  const off = pf.ev.filter((e) => e.field === "opponent_offense" && e.status !== "UNAVAILABLE");
  const rodonOpp = off.find((e) => String(e.entity).includes("Rod"))!.value as any;
  eq("N14 a lefty gets the opponent's vs-LHP split, not the overall line",
    rodonOpp.applicable.split, "vs LHP");
  eq("N15 ...and it is the RIGHT team's split (he faces Boston)", rodonOpp.applicable.obp, 0.310);
  ok("N16 the season overall line is kept for contrast",
    rodonOpp.season_overall != null && rodonOpp.season_overall.split === "season overall");
  const crawOpp = off.find((e) => String(e.entity).includes("Crawford"))!.value as any;
  eq("N17 a righty gets the vs-RHP split", crawOpp.applicable.split, "vs RHP");
  ok("N18 ISO is derived from SLG minus AVG",
    Math.abs(rodonOpp.applicable.iso - (0.390 - 0.240)) < 1e-9, rodonOpp.applicable.iso);
  ok("N19 opponent K% is over plate appearances", rodonOpp.applicable.k_pct === +(230 / 1000).toFixed(3));
  ok("N20 wOBA and wRC+ are declared missing rather than faked",
    rodonOpp.applicable.missing_fields.includes("wrc_plus") && rodonOpp.applicable.missing_fields.includes("woba"));

  // workload from the game log
  const wl = pf.ev.filter((e) => e.field === "workload" && e.status !== "UNAVAILABLE");
  const rw = wl.find((e) => String(e.entity).includes("Rod"))!.value as any;
  eq("N21 only actual STARTS count toward recent workload", rw.recent_starts.length, 3);
  eq("N22 the most recent start is first", rw.recent_starts[0].date, "2026-08-05");
  eq("N23 pitch counts come through", rw.recent_starts[0].pitches, 96);
  ok("N24 days rest is computed from the last start", rw.days_rest >= 0, rw.days_rest);
  ok("N25 a relief appearance is excluded from starts",
    !rw.recent_starts.some((g: any) => g.date === "2026-07-19"));

  ok("N26 coverage now reports the platoon-aware offense as present",
    coverage(pf.ev, "opponent_offense", ["Carlos Rodón", "Kutter Crawford"]).have_n === 2);
  ok("N27 the whole layer stays inside its call ceiling",
    ((pf.path.live_fallback as any)?.api_calls ?? 99) <= 8, (pf.path.live_fallback as any)?.api_calls);
}
{
  // league totals unavailable -> FIP is omitted, not guessed
  const d = dal({ ...FULL, pitcher_features: [], offense_features: [] });
  const orig = mockFetch({ ...FULL, pitcher_features: [] });
  (d as any).f = async (url: string, init: any) => {
    if (String(url).includes("group=pitching")) return new Response("{}", { status: 200 });
    return orig(url as any, init);
  };
  const pf = await d.getPitcherFeatures();
  const q = pf.ev.find((e) => e.field === "pitcher_quality" && e.status !== "UNAVAILABLE")!.value as any;
  eq("N28 no league totals means NO FIP, not an assumed constant", q.fip, null);
  ok("N29 ...and it says why", /league constant unavailable/.test(q.fip_note), q.fip_note);
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
