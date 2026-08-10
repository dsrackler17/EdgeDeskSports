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

interface Fixture { [table: string]: any[] | "error" | "rls" }

function mockFetch(fx: Fixture): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
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

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
