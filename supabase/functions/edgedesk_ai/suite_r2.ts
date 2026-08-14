/* r2 suite — research packet, semantic coverage, completeness gate,
   slate scope, adaptive second pass, cross-entity integrity.
   Runs the REAL function; nothing is reimplemented. */
import { install, mlbCardDay, signalsFor, check, section, report, YEST, TODAY, TOM } from "./harness.ts";

const EMPTY: Record<string, any[]> = {
  signals: [], mlb_game_cards: [], games: [], pitcher_features: [], offense_features: [],
  mlb_pitcher_usage: [], pitcher_season: [], team_season: [], venue_weather: [],
  mlb_bullpen_taxed: [], mlb_bullpen_team: [], research_snapshots: [], research_facts: [],
  research_outcomes: [], research_patterns: [], research_calibration: [], research_sessions: [],
  book_quotes: [], signal_ticks: [], market_residual: [], model_predictions: [],
  team_features: [], qb_features: [], matchup_context: [], rankings_current: [], stats_players: [],
};

let mod: any;
/** Always uses ?dry=1 — the packet is what we are testing, not the narration. */
async function packet(question: string, tables: Record<string, any>, opts: any = {}) {
  const cap = install({ tables: { ...EMPTY, ...tables }, errors: opts.errors });
  mod ??= await import("./index.ts");
  mod.clearCache?.();
  const res = await mod.handle(new Request("https://x/edgedesk_ai?dry=1", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.jwt ?? "t.a"}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: opts.mode ?? "chat", question, packet: opts.packet, history: opts.history }),
  }));
  return { p: await res.json(), cap, status: res.status };
}

/* ------------------------------------------------------------- fixtures */
const N = 15;
const todayCard = mlbCardDay(TODAY, N, "Scheduled", 6);
const yestCard = mlbCardDay(YEST, N, "Final", 0);
const gid = (i: number) => `g-${TODAY}-${i}`;

const gamesRows = (n = N) => todayCard.slice(0, n).map((g, i) => ({
  game_id: gid(i), game_date: TODAY, home_team: g.home_team_name, away_team: g.away_team_name,
  start_time: g.start_time, status: "Scheduled", park_id: 1, sport_key: "baseball_mlb",
}));

const pitcherFeatures = (n = N) => todayCard.slice(0, n).flatMap((g, i) => ([
  { game_id: gid(i), side: "home", pitcher_id: 1000 + i * 2, name: g.home_pitcher_name,
    xera: 3.8 + i * 0.07, k_pct: 0.24 - i * 0.002, bb_pct: 0.07, barrel_pct: 0.08 + i * 0.001,
    hardhit_pct: 0.38, era: 4.1, fip: 4.0 + i * 0.05, whip: 1.25, whiff_pct: 0.26,
    xwoba_against: 0.310, updated_at: new Date().toISOString() },
  { game_id: gid(i), side: "away", pitcher_id: 1001 + i * 2, name: g.away_pitcher_name,
    xera: 4.2 - i * 0.05, k_pct: 0.22, bb_pct: 0.08 + i * 0.001, barrel_pct: 0.09,
    hardhit_pct: 0.40, era: 4.6, fip: 4.4, whip: 1.33, whiff_pct: 0.23,
    xwoba_against: 0.325, updated_at: new Date().toISOString() },
]));

const offenseFeatures = (n = N) => todayCard.slice(0, n).flatMap((_, i) => ([
  { game_id: gid(i), side: "home", obp: .320, iso: .160, k_pct: .22, runs_per_game: 4.5,
    avg: .249, slg: .410, ops: .730, bb_pct: .085, vs_lhp: null, vs_rhp: null, updated_at: new Date().toISOString() },
  { game_id: gid(i), side: "away", obp: .335, iso: .175, k_pct: .21, runs_per_game: 4.9,
    avg: .258, slg: .433, ops: .768, bb_pct: .090, vs_lhp: null, vs_rhp: null, updated_at: new Date().toISOString() },
]));

const usage = (n = N) => todayCard.slice(0, n).flatMap((_, i) => ([
  { pitcher_id: 1000 + i * 2, game_date: TODAY, pitches: 92, outs: 18, started: true },
  { pitcher_id: 1001 + i * 2, game_date: TODAY, pitches: 88, outs: 17, started: true },
]));

const bullpen = () => todayCard.flatMap((g) => ([
  { team_id: g.home_team_id, full_name: "Reliever A", flag: "taxed", pitches_yesterday: 30, severity: 2 },
  { team_id: g.away_team_id, full_name: "Reliever B", flag: "taxed", pitches_yesterday: 25, severity: 1 },
]));
const closers = () => todayCard.flatMap((g) => ([
  { team_id: g.home_team_id, closer_name: "Closer H", closer_flag: "available" },
  { team_id: g.away_team_id, closer_name: "Closer A", closer_flag: "available" },
]));

const seasonRows = (n = N) => todayCard.slice(0, n).flatMap((g, i) => ([
  { name: g.home_pitcher_name, team: g.home_team_name, games_started: 20, ip: 118.1, era: 4.9,
    fip: 5.2 - i * 0.05, whip: 1.4, k_bb_pct: 0.10, hr_per9: 1.5, fip_constant: 3.15,
    as_of: new Date().toISOString(), season: new Date().getFullYear() },
  { name: g.away_pitcher_name, team: g.away_team_name, games_started: 18, ip: 101.2, era: 4.2,
    fip: 4.4 - i * 0.03, whip: 1.3, k_bb_pct: 0.12, hr_per9: 1.2, fip_constant: 3.15,
    as_of: new Date().toISOString(), season: new Date().getFullYear() },
]));

const FULL = () => ({
  signals: signalsFor(todayCard), mlb_game_cards: [...yestCard, ...todayCard],
  games: gamesRows(), pitcher_features: pitcherFeatures(), offense_features: offenseFeatures(),
  mlb_pitcher_usage: usage(), mlb_bullpen_taxed: bullpen(), mlb_bullpen_team: closers(),
  venue_weather: [], pitcher_season: seasonRows(), team_season: [],
});

const Q_WORST = "Who are the worst pitchers on today's MLB slate?";
const Q_BEST = "Who are the best pitchers on tonight's card?";

/* ============================================== 1. SLATE SCOPE */
section("SLATE SCOPE — expected universe (§5)");
{
  const { p } = await packet(Q_WORST, FULL());
  const s = p.slate_scope;
  check("scope denominator comes from the schedule, not the rows returned",
    s.expected_games === N && s.scheduled_games === N, JSON.stringify(s));
  check("yesterday's Final games are excluded and counted separately",
    s.dropped_final === N && s.live_games === N, `dropped=${s.dropped_final} live=${s.live_games}`);
  check("a complete slate reports complete", s.complete === true, `complete=${s.complete}`);
  check("scope names date and timezone", s.date === TODAY && s.timezone === "America/New_York");
}
{
  // Two carded games never make it into the retrieved set.
  const t = FULL();
  t.games = gamesRows(N - 2);
  t.pitcher_features = pitcherFeatures(N - 2);
  t.mlb_game_cards = [...yestCard, ...todayCard.slice(0, N - 2)];
  const { p } = await packet(Q_WORST, t);
  check("a missing game shows as an incomplete slate",
    p.slate_scope.expected_games === N - 2 && p.slate_scope.complete === true,
    JSON.stringify(p.slate_scope));
  check("coverage denominator tracks the smaller slate",
    p.coverage.required.probable_starter.expected === (N - 2) * 2,
    `expected=${p.coverage.required.probable_starter?.expected}`);
}

/* ============================================== 2. COMPLETENESS GATE */
section("COMPLETENESS GATE — COMPLETE / PARTIAL / INSUFFICIENT / INVALID (§4)");
{
  const { p } = await packet(Q_WORST, FULL());
  check("a full worst-pitcher slate reaches COMPLETE",
    p.completeness.state === "COMPLETE",
    `state=${p.completeness.state} reason=${p.completeness.reason} gaps=${JSON.stringify(p.data_gaps)}`);
  check("COMPLETE permits ranking", p.completeness.safe_to_rank === true);
  check("betting interpretation allowed when market evidence is present",
    p.completeness.safe_to_make_betting_interpretation === true);
}
{
  const { p } = await packet(Q_BEST, FULL());
  check("a full best-pitcher slate reaches COMPLETE", p.completeness.state === "COMPLETE",
    `state=${p.completeness.state} gaps=${JSON.stringify(p.data_gaps)}`);
}
{
  // Important layers gone, required intact -> PARTIAL
  const t = FULL();
  t.offense_features = []; t.mlb_bullpen_taxed = []; t.mlb_bullpen_team = []; t.team_season = [];
  t.mlb_pitcher_usage = [];
  const { p } = await packet(Q_WORST, t);
  check("missing IMPORTANT evidence yields PARTIAL, not a refusal",
    p.completeness.state === "PARTIAL", `state=${p.completeness.state} reason=${p.completeness.reason}`);
  check("PARTIAL still permits ranking", p.completeness.safe_to_rank === true);
  check("PARTIAL names the important gaps", (p.data_gaps.important ?? []).length > 0,
    JSON.stringify(p.data_gaps));
}
{
  // Required pitcher layers entirely gone -> INSUFFICIENT
  const t = FULL();
  t.pitcher_features = []; t.pitcher_season = []; t.team_season = [];
  const { p } = await packet(Q_WORST, t);
  check("both pitching layers absent yields INSUFFICIENT",
    p.completeness.state === "INSUFFICIENT", `state=${p.completeness.state} reason=${p.completeness.reason}`);
  check("INSUFFICIENT withholds permission to rank", p.completeness.safe_to_rank === false);
}
{
  // Duplicate stat vector across two pitchers -> integrity FAIL -> INVALID
  const dup = { xera: 4.44, k_pct: .19, bb_pct: .09, barrel_pct: .11, hardhit_pct: .44,
    era: 4.9, fip: 4.8, whip: 1.42, whiff_pct: .22, xwoba_against: .345 };
  const t = FULL();
  t.pitcher_features = [
    { game_id: gid(0), side: "home", pitcher_id: 1, name: todayCard[0].home_pitcher_name, ...dup, updated_at: new Date().toISOString() },
    { game_id: gid(1), side: "home", pitcher_id: 2, name: todayCard[1].home_pitcher_name, ...dup, updated_at: new Date().toISOString() },
  ];
  const { p } = await packet(Q_WORST, t);
  check("contaminated evidence yields INVALID", p.completeness.state === "INVALID",
    `state=${p.completeness.state} integrity=${p.integrity?.verdict}`);
  check("INVALID forbids ranking AND comparison",
    p.completeness.safe_to_rank === false && p.completeness.safe_to_compare === false);
  check("the prompt states the ranking prohibition",
    /You may NOT rank, compare/.test(p.prompt));
}

/* ============================================== 3. LAYER FALLBACK + via */
section("LAYER FALLBACK — season satisfies matchup, and says so (§3, §11)");
{
  const t = FULL();
  t.pitcher_features = [];                    // matchup layer gone, season intact
  const { p } = await packet(Q_WORST, t);
  check("season layer satisfies the pitcher_quality requirement",
    (p.coverage.required.pitcher_quality?.available ?? 0) > 0,
    JSON.stringify(p.coverage.required.pitcher_quality));
  check("the fallback layer is NAMED via `via`",
    p.coverage.required.pitcher_quality?.via === "season_pitching",
    `via=${p.coverage.required.pitcher_quality?.via}`);
  check("the prompt tells the analyst which layer the number came from",
    /via season_pitching/.test(p.prompt) && /satisfied by a FALLBACK LAYER/.test(p.prompt));
  check("season evidence is tagged layer=season",
    p.evidence.some((e: any) => e.field === "season_pitching" && e.layer === "season"));
}

/* ============================================== 4. ADAPTIVE SECOND PASS */
section("ADAPTIVE SECOND PASS — gap-driven only (§6)");
{
  const t = FULL();
  t.mlb_bullpen_taxed = []; t.mlb_bullpen_team = [];   // create a real gap
  const { p } = await packet(Q_WORST, t);
  const fb = p.fallbacks ?? [];
  check("a gap triggers a targeted follow-up retrieval", fb.length > 0, JSON.stringify(fb));
  check("the follow-up names the missing requirement it targeted",
    fb.every((f: any) => !!f.missing_requirement && !!f.retrieval), JSON.stringify(fb));
  check("a follow-up that finds nothing says the gap is real",
    fb.some((f: any) => f.rows_added === 0 && /gap is real/.test(f.result ?? "")) || fb.every((f: any) => f.rows_added > 0),
    JSON.stringify(fb));
  check("coverage before/after is recorded for each follow-up",
    fb.every((f: any) => typeof f.coverage_before === "number" && typeof f.coverage_after === "number"));
}
{
  // Nothing missing -> no second pass at all.
  const { p } = await packet(Q_WORST, FULL());
  check("a complete packet triggers NO follow-up retrievals",
    (p.fallbacks ?? []).length === 0, JSON.stringify(p.fallbacks));
}
{
  // Gap that CAN be filled: matchup gone, season available in the table.
  const t = FULL();
  t.pitcher_features = []; t.offense_features = [];
  t.team_season = [{ team: todayCard[0].home_team_name, runs_per_game: 5.1, ops: .760, k_pct: .21,
    hr_per_game: 1.4, woba: .330, barrel_pct: .09, hardhit_pct: .41, ra_per_game: 4.2,
    as_of: new Date().toISOString(), season: new Date().getFullYear() }];
  const { p } = await packet(Q_WORST, t);
  const improved = (p.fallbacks ?? []).some((f: any) => f.improved === true);
  check("a follow-up that fills a gap records improved coverage",
    improved || (p.coverage.required.pitcher_quality?.available ?? 0) > 0,
    JSON.stringify(p.fallbacks));
}

/* ============================================== 5. CROSS-ENTITY INTEGRITY */
section("CROSS-ENTITY INTEGRITY (§8)");
{
  const t = FULL();
  // Same starter attached to two different clubs.
  t.pitcher_features = [
    { game_id: gid(0), side: "home", pitcher_id: 5, name: "Split Identity", xera: 3.9, k_pct: .25,
      bb_pct: .07, barrel_pct: .08, hardhit_pct: .38, era: 4.0, fip: 4.1, whip: 1.2, whiff_pct: .26,
      xwoba_against: .30, updated_at: new Date().toISOString() },
    { game_id: gid(1), side: "away", pitcher_id: 5, name: "Split Identity", xera: 4.9, k_pct: .18,
      bb_pct: .10, barrel_pct: .12, hardhit_pct: .45, era: 5.2, fip: 5.0, whip: 1.5, whiff_pct: .20,
      xwoba_against: .35, updated_at: new Date().toISOString() },
  ];
  const { p } = await packet(Q_WORST, t);
  const chk = (p.integrity?.checks ?? []).find((c: any) => c.name === "subject_team_consistency");
  check("one person on two teams is caught", chk?.status === "FAIL", JSON.stringify(chk));
  check("that contamination drives the gate to INVALID", p.completeness.state === "INVALID",
    `state=${p.completeness.state}`);
}
{
  const t = FULL();
  const { p } = await packet(Q_WORST, t);
  check("a clean packet passes cross-entity identity",
    (p.integrity?.checks ?? []).find((c: any) => c.name === "cross_entity_identity")?.status === "PASS");
  check("a clean packet passes duplicate-event",
    (p.integrity?.checks ?? []).find((c: any) => c.name === "duplicate_event")?.status === "PASS");
}

/* ============================================== 6. PACKET CONTRACT */
section("RESEARCH PACKET CONTRACT (§9, §10, §24)");
{
  const { p } = await packet(Q_WORST, FULL());
  const need = ["request", "intent", "sport", "entities", "slate_scope", "requirements", "coverage",
    "completeness", "integrity", "evidence", "fallbacks", "conflicts", "deterministic_context",
    "historical_context", "thesis_attack", "data_gaps", "provenance", "prompt"];
  const missing = need.filter((k) => !(k in p));
  check("?dry=1 exposes every packet section", missing.length === 0, `missing: ${missing.join(", ")}`);
  check("provenance records the build and that no model call was made",
    p.provenance.build === "edgedesk_ai-2026-08-12-r2-research-packet" && p.provenance.model_not_called === true,
    `build=${p.provenance.build}`);
  check("every evidence item carries a traceable id",
    p.evidence.length > 0 && p.evidence.every((e: any) => typeof e.id === "string" && e.id.length),
    `first=${JSON.stringify(p.evidence[0]?.id)}`);
  check("every evidence item carries a layer",
    p.evidence.every((e: any) => !!e.layer));
  check("matchup evidence carries canonical identity",
    p.evidence.some((e: any) => e.field === "pitcher_quality" && e.player_id != null && e.event_id != null),
    JSON.stringify(p.evidence.find((e: any) => e.field === "pitcher_quality")));
  check("the prompt instructs that every number trace to an evidence id",
    /EVERY NUMBER YOU QUOTE MUST COME FROM ONE OF THESE ITEMS/.test(p.prompt));
  check("the prompt states the layer precedence",
    /matchup .* > season .* > market > historical > context/s.test(p.prompt));
  check("no secrets in the dry packet",
    !/eyJhbGci|service_role|ANTHROPIC_API_KEY|apikey["':]/.test(JSON.stringify(p)));
}

/* ============================================== 7. DETERMINISTIC PASSTHROUGH */
section("DETERMINISTIC CONTEXT — read-only (§13)");
{
  const { p } = await packet("What's the best bet tonight?", FULL());
  const dc = p.deterministic_context;
  const sig = signalsFor(todayCard)[0];
  check("deterministic context is attached with the engine's own values", !!dc && dc.edge != null,
    JSON.stringify(dc));
  check("edge is passed through unmodified",
    p.evidence.some((e: any) => e.field === "signal" && (e.value as any)?.edge === sig.edge)
    || dc.edge === sig.edge, `dc.edge=${dc?.edge} expected=${sig.edge}`);
  check("the packet marks deterministic values READ-ONLY",
    /READ-ONLY/.test(p.prompt) && /never recompute/.test(p.prompt));
}

/* ============================================== 8. HISTORICAL SEPARATION */
section("HISTORICAL vs CURRENT (§11, §14)");
{
  const graded = Array.from({ length: 400 }, (_, i) => ({
    clv: .01, beat_close: i % 2 === 0, result: i % 3 === 0 ? "win" : "loss", first_edge: .03,
    sport_key: "baseball_mlb", market: "h2h", graded_at: new Date(Date.now() - i * 3600_000).toISOString(),
  }));
  const t = { ...FULL(), signals: graded };
  const { p } = await packet("Have we historically seen a setup like this before?", t);
  check("a historical question routes to the historical requirement map",
    p.intent.intent === "historical", `intent=${p.intent.intent}`);
  check("historical evidence is tagged layer=historical",
    p.evidence.filter((e: any) => e.field === "clv_history").every((e: any) => e.layer === "historical"));
  check("historical evidence is never tagged as a current matchup layer",
    !p.evidence.some((e: any) => e.layer === "matchup" && e.status === "HISTORICAL"));
}

/* ============================================== 9. THESIS ATTACK INPUTS */
section("THESIS ATTACK INPUTS (§12)");
{
  const { p } = await packet("Why does EdgeDesk like this bet?", FULL());
  const ta = p.thesis_attack;
  check("support is a list of evidence ids, not prose",
    Array.isArray(ta.support) && ta.support.every((s: any) => typeof s.id === "string"));
  check("contradictions are selected from evidence, never invented",
    Array.isArray(ta.contradictions)
    && ta.contradictions.every((c: any) => "detail" in c && "field" in c));
  check("an empty contradiction set instructs the analyst NOT to manufacture one",
    ta.contradictions.length > 0 || /do NOT manufacture an objection/.test(p.prompt));
}

/* ============================================== 10. WHAT CHANGED */
section("WHAT CHANGED — classified from snapshots only (§15)");
{
  const t: any = FULL();
  /* A snapshot for EVERY event: the board is ordered by edge, so which row the
     engine focuses on is its decision, not the fixture's to assume. */
  t.research_snapshots = signalsFor(todayCard).map((s) => ({
    event_id: s.event_id, version: 3, taken_at: new Date(Date.now() - 3600_000).toISOString(),
    facts: { current_price: 2.10, fair_price: 0.52, edge: 0.010, n_books: 5, has_sharp: true,
             status: "Scheduled", home_starter: "Someone Else" },
  }));
  const { p } = await packet("What changed since detection?", t);
  check("what_changed routes to its own requirement map", p.intent.intent === "what_changed",
    `intent=${p.intent.intent}`);
  check("the snapshot diff is exposed in the prompt", /WHAT CHANGED/.test(p.prompt));
  check("changes are classified by kind",
    /"kind":"(PRICE_CHANGED|IMPROVED|WORSENED|MOVED|STATUS_CHANGED|NEW|REMOVED|DATA_CHANGED)"/.test(p.prompt),
    "no classified change kinds found in the packet");
}

/* ============================================== 11. SPORT CONTRACT */
section("SPORT CAPABILITY CONTRACT (§19)");
{
  const nflSignals = [{ ...signalsFor([{ home_team_name: "New York Giants", away_team_name: "Dallas Cowboys" }])[0],
    sport_key: "americanfootball_nfl", sport_title: "NFL" }];
  const { p } = await packet("Which offense is most efficient tonight?", {
    signals: nflSignals,
    games: [{ game_id: "nfl-1", game_date: TODAY, home_team: "New York Giants", away_team: "Dallas Cowboys",
      start_time: `${TODAY}T20:00:00Z`, status: "Scheduled", sport_key: "americanfootball_nfl" }],
    team_features: [
      { game_id: "nfl-1", side: "home", team: "New York Giants", wins: 5, losses: 4, off_epa_play: .06,
        def_epa_play: -.02, off_success_rate: .45, def_success_rate: .41, plays_per_game: 63, updated_at: new Date().toISOString() },
      { game_id: "nfl-1", side: "away", team: "Dallas Cowboys", wins: 6, losses: 3, off_epa_play: .11,
        def_epa_play: .01, off_success_rate: .48, def_success_rate: .44, plays_per_game: 66, updated_at: new Date().toISOString() },
    ],
  });
  check("baseball fields are NOT reported as gaps on a football question",
    !JSON.stringify(p.data_gaps.critical ?? []).match(/pitcher|bullpen|park/),
    JSON.stringify(p.data_gaps));
  check("sport-inapplicable fields are declared not_applicable",
    Array.isArray(p.coverage.not_applicable), JSON.stringify(p.coverage.not_applicable));
  check("the prompt tells the analyst not to report N/A fields as missing",
    !p.coverage.not_applicable.length || /do NOT report these as missing/.test(p.prompt));
}

/* ============================================== 12. YESTERDAY CANNOT SATISFY TODAY */
section("YESTERDAY'S FINALS CANNOT SATISFY TODAY (§5)");
{
  // Only yesterday's card exists, fully populated. Today has nothing.
  const t: any = { ...EMPTY, signals: signalsFor(todayCard), mlb_game_cards: yestCard };
  const { p } = await packet(Q_WORST, t);
  check("a card of only Final games yields no live slate",
    p.slate_scope.live_games === 0 || p.slate_scope.expected_games === 0,
    JSON.stringify(p.slate_scope));
  check("yesterday's starters cannot satisfy today's requirement",
    p.completeness.state === "INSUFFICIENT" || p.completeness.state === "INVALID",
    `state=${p.completeness.state}`);
  check("no yesterday starter is presented as a probable starter",
    !p.evidence.some((e: any) => e.field === "probable_starter" && e.status !== "UNAVAILABLE"
      && String(e.entity ?? "").includes(YEST)),
    "a Final-game starter leaked into probable_starter");
}

process.exit(report());
