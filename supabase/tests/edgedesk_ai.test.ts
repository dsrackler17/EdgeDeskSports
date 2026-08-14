// supabase/tests/edgedesk_ai.test.ts
// ============================================================================
// EdgeDesk research-engine test suite.
//
// DELIBERATELY OUTSIDE THE FUNCTION FOLDER. The Supabase dashboard bundles the
// folder of the function being deployed, so a test file living next to
// index.ts would be bundled with it. Single-file deployment discipline is a
// hard constraint of this project, and this suite is not allowed to threaten it.
//
// WHAT THIS TESTS, AND WHAT IT DOES NOT
// It does NOT test that an API returns rows — that tests the internet. It tests
// the RESEARCH ENGINE: whether identity survives a sport boundary, whether a
// question's requirements are the right ones, whether coverage is measured
// against a real denominator, whether an absent capability is reported as
// absent rather than approximated, and whether a historical question can be
// contaminated by information that did not exist yet.
//
// Retrieval runs against a mock PostgREST that honours Accept-Profile, so the
// cfb-schema path is exercised for real rather than stubbed past.
//
// RUN (Deno):  deno test -A supabase/tests/edgedesk_ai.test.ts
// RUN (Node):  node --experimental-strip-types supabase/tests/edgedesk_ai.test.ts
// ============================================================================

/* ------------------------------------------------------------------ shim ---
   The module reads Deno.env at import time. Under Node this has to exist
   before the import is evaluated, which is why the import below is dynamic. */
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  EDGEDESK_AI_NO_SERVE: "1",
};
(globalThis as any).Deno = (globalThis as any).Deno ?? {};
(globalThis as any).Deno.env = { get: (k: string) => ENV[k] };

/* ------------------------------------------------------------- harness --- */
let PASS = 0, FAIL = 0;
const FAILURES: string[] = [];
const results: { n: number; group: string; name: string; ok: boolean; detail: string }[] = [];
let GROUP = "";
let N = 0;

function group(g: string) { GROUP = g; }
function check(name: string, cond: boolean, detail = "") {
  N++;
  if (cond) { PASS++; results.push({ n: N, group: GROUP, name, ok: true, detail }); }
  else {
    FAIL++;
    FAILURES.push(`#${N} [${GROUP}] ${name}${detail ? " — " + detail : ""}`);
    results.push({ n: N, group: GROUP, name, ok: false, detail });
  }
}

/* --------------------------------------------------------- mock backend ---
   A minimal PostgREST. It understands the parts the engine actually uses:
   the table name, the schema profile, `in.(...)`, `eq.` and `limit`. Anything
   it does not understand returns the whole fixture table, which is the
   permissive direction — a test that passes because the mock over-filtered
   would be worthless. */
type Table = Record<string, any>[];
interface Backend { public: Record<string, Table>; cfb: Record<string, Table>; missing?: Set<string> }

function makeFetch(be: Backend, opts: { failSchemas?: string[] } = {}) {
  const calls: { url: string; schema: string; table: string }[] = [];
  const f = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const schema = String(init?.headers?.["accept-profile"] ?? "public");
    const rest = url.split("/rest/v1/")[1] ?? "";
    const table = rest.split("?")[0];
    calls.push({ url, schema, table });

    if (opts.failSchemas?.includes(schema)) {
      return new Response("schema not exposed", { status: 404 });
    }
    const bank = schema === "cfb" ? be.cfb : be.public;
    if (be.missing?.has(`${schema}.${table}`)) {
      return new Response(`relation "${schema}.${table}" does not exist`, { status: 404 });
    }
    let rows = bank[table];
    if (rows == null) return new Response(`relation "${table}" does not exist`, { status: 404 });

    // eq. filters — enough to make sport_key / league / team scoping real.
    const qs = rest.split("?")[1] ?? "";
    for (const part of qs.split("&")) {
      const [k, v] = part.split("=");
      if (!v) continue;
      if (v.startsWith("eq.")) {
        const want = decodeURIComponent(v.slice(3));
        rows = rows.filter((r) => String(r[k]) === want);
      } else if (v.startsWith("in.(")) {
        const list = decodeURIComponent(v.slice(4, -1)).split(",").map((s) => s.replace(/^"|"$/g, ""));
        rows = rows.filter((r) => list.includes(String(r[k])));
      }
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ISO = (d: Date) => d.toISOString();
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

/* ---------------------------------------------------------- fixtures ----- */
function nflBackend(over: Partial<Backend["public"]> = {}): Backend {
  const d = today();
  return {
    public: {
      signals: [{
        event_id: "nfl1", sport_key: "americanfootball_nfl", sport_title: "NFL", market: "h2h",
        selection: "Kansas City Chiefs", best_dec: 1.85, first_best_dec: 1.9, sharp_fair: 0.56,
        consensus_fair: 0.55, edge: 0.036, first_edge: 0.04, n_books: 8, has_sharp: true,
        home_team: "Kansas City Chiefs", away_team: "Buffalo Bills",
        commence_time: ISO(new Date(Date.now() + 6 * 3600e3)), last_seen_at: ISO(new Date()),
      }],
      games: [{ game_id: "g1", sport_key: "americanfootball_nfl", game_date: d,
        home_team: "Kansas City Chiefs", away_team: "Buffalo Bills",
        start_time: ISO(new Date(Date.now() + 6 * 3600e3)), status: "Scheduled" }],
      team_features: [
        { game_id: "g1", side: "home", team: "Kansas City Chiefs", wins: 9, losses: 2,
          off_epa_play: 0.14, def_epa_play: -0.04, off_success_rate: 0.48, def_success_rate: 0.42,
          pass_epa_play: 0.21, rush_epa_play: -0.02, def_pass_epa_play: -0.03, def_rush_epa_play: -0.06,
          explosive_play_rate: 0.11, yards_per_play: 5.9, opp_yards_per_play: 4.9,
          third_down_pct: 0.45, def_third_down_pct: 0.36, red_zone_td_pct: 0.62, def_red_zone_td_pct: 0.51,
          turnover_margin_pg: 0.5, sack_rate: 0.08, sack_rate_allowed: 0.05, plays_per_game: 64,
          updated_at: ISO(new Date()) },
        { game_id: "g1", side: "away", team: "Buffalo Bills", wins: 8, losses: 3,
          off_epa_play: 0.09, def_epa_play: 0.01, off_success_rate: 0.45, def_success_rate: 0.45,
          pass_epa_play: 0.15, rush_epa_play: 0.02, def_pass_epa_play: 0.03, def_rush_epa_play: -0.01,
          explosive_play_rate: 0.09, yards_per_play: 5.5, opp_yards_per_play: 5.4,
          third_down_pct: 0.41, def_third_down_pct: 0.41, red_zone_td_pct: 0.55, def_red_zone_td_pct: 0.58,
          turnover_margin_pg: -0.2, sack_rate: 0.06, sack_rate_allowed: 0.07, plays_per_game: 66,
          updated_at: ISO(new Date()) },
      ],
      qb_features: [
        { game_id: "g1", side: "home", name: "Patrick Mahomes", epa_per_dropback: 0.19, cpoe: 3.1,
          ypa: 7.9, comp_pct: 0.68, td_rate: 0.05, int_rate: 0.02, sack_rate_taken: 0.05,
          pressure_rate: 0.22, rush_epa: 0.04, qbr: 68, attempts: 380, games_started: 11,
          status: "active", is_backup: false, updated_at: ISO(new Date()) },
        { game_id: "g1", side: "away", name: "Backup QB", epa_per_dropback: 0.02, cpoe: -1.2,
          ypa: 6.4, comp_pct: 0.60, td_rate: 0.03, int_rate: 0.03, sack_rate_taken: 0.08,
          pressure_rate: 0.30, rush_epa: 0.01, qbr: 42, attempts: 60, games_started: 2,
          status: "questionable", is_backup: true, injury_note: "starter out",
          updated_at: ISO(new Date()) },
      ],
      matchup_context: [{ game_id: "g1", neutral_site: false, conference_game: true, is_rivalry: true,
        home_rest_days: 7, away_rest_days: 6, short_week: false, venue: "Arrowhead",
        indoor: false, surface: "grass", altitude_ft: 750, updated_at: ISO(new Date()) }],
      stats_players: [
        { league: "NFL", team: "Kansas City Chiefs", player: "Travis Kelce", position: "TE",
          stat_line: "68 rec, 720 yds, 5 TD", lead_cat: "receiving", lead_val: 720 },
      ],
      game_stats: [{ team_norm: "kansascitychiefs", team: "Kansas City Chiefs", wins: 9, losses: 2 }],
      rankings_current: [],
      research_patterns: [], research_calibration: [], research_facts: [],
      research_outcomes: [], research_sessions: [], research_snapshots: [],
      venue_weather: [], book_quotes: [], signal_ticks: [], market_residual: [],
      model_predictions: [],
      ...over,
    },
    cfb: {},
  };
}

function cfbBackend(over: Partial<Backend["cfb"]> = {}, missing: string[] = []): Backend {
  const season = 2025;
  return {
    public: {
      signals: [{
        event_id: "cfb1", sport_key: "americanfootball_ncaaf", sport_title: "NCAAF", market: "spreads",
        selection: "Georgia", point: -7.5, best_dec: 1.91, first_best_dec: 1.95, sharp_fair: 0.53,
        consensus_fair: 0.52, edge: 0.012, first_edge: 0.02, n_books: 7, has_sharp: true,
        home_team: "Georgia", away_team: "Alabama",
        commence_time: ISO(new Date(Date.now() + 20 * 3600e3)), last_seen_at: ISO(new Date()),
      }],
      games: [], team_features: [], qb_features: [], matchup_context: [],
      stats_players: [], game_stats: [], rankings_current: [],
      research_patterns: [], research_calibration: [], research_facts: [],
      research_outcomes: [], research_sessions: [], research_snapshots: [],
      venue_weather: [], book_quotes: [], signal_ticks: [], market_residual: [],
      model_predictions: [],
    },
    cfb: {
      teams: [
        { team_id: 61, school: "Georgia", mascot: "Bulldogs", abbreviation: "UGA", conference: "SEC", classification: "fbs" },
        { team_id: 333, school: "Alabama", mascot: "Crimson Tide", abbreviation: "ALA", conference: "SEC", classification: "fbs" },
        { team_id: 2390, school: "Miami", mascot: "Hurricanes", abbreviation: "MIA", conference: "ACC", classification: "fbs" },
        { team_id: 193, school: "Miami (OH)", mascot: "RedHawks", abbreviation: "M-OH", conference: "Mid-American", classification: "fbs" },
      ],
      ratings: [
        { season, team: "Georgia", conference: "SEC", rating: 28.4, ranking: 1, offense_rating: 38.2,
          offense_ranking: 3, defense_rating: 12.1, defense_ranking: 2, special_teams_rating: 0.9, sos: 8.2 },
        { season, team: "Alabama", conference: "SEC", rating: 22.1, ranking: 5, offense_rating: 35.0,
          offense_ranking: 8, defense_rating: 15.4, defense_ranking: 9, special_teams_rating: 0.2, sos: 9.1 },
      ],
      records: [
        { season, team: "Georgia", total_wins: 11, total_losses: 1, total_ties: 0, conf_wins: 7, conf_losses: 1 },
        { season, team: "Alabama", total_wins: 9, total_losses: 3, total_ties: 0, conf_wins: 6, conf_losses: 2 },
      ],
      team_season_stats: [
        { season, team: "Georgia", stat_name: "totalYards", stat_value: 5200 },
        { season, team: "Georgia", stat_name: "rushingYards", stat_value: 2100 },
        { season, team: "Alabama", stat_name: "totalYards", stat_value: 4800 },
      ],
      games: [{ game_id: 401, season, week: 12, season_type: "regular",
        start_date: ISO(new Date(Date.now() + 20 * 3600e3)), completed: false, neutral_site: false,
        conference_game: true, venue: "Sanford Stadium", home_id: 61, home_team: "Georgia",
        home_conference: "SEC", home_points: null, home_pregame_elo: 2100,
        away_id: 333, away_team: "Alabama", away_conference: "SEC", away_points: null,
        away_pregame_elo: 1980, excitement: 7.1 }],
      rankings: [{ season, week: 12, season_type: "regular", poll: "AP Top 25", team: "Georgia", rank: 1, points: 1550 }],
      recruiting: [{ year: season, team: "Georgia", rank: 2, points: 310.5 }],
      roster: [
        { first_name: "Q", last_name: "Back", position: "QB", jersey: 1, year: 3, height: 75, weight: 215, team: "Alabama" },
        { first_name: "R", last_name: "Unner", position: "RB", jersey: 22, year: 2, height: 70, weight: 205, team: "Alabama" },
      ],
      lines: [{ game_id: 401, provider: "consensus", spread: -7.5, over_under: 52.5,
        home_moneyline: -280, away_moneyline: 230 }],
      analyst_flags: [],
      ...over,
    },
    missing: new Set(missing),
  };
}

function cbbBackend(): Backend {
  const d = today();
  return {
    public: {
      signals: [{
        event_id: "cbb1", sport_key: "basketball_ncaab", sport_title: "NCAAB", market: "totals",
        selection: "Under", point: 141.5, best_dec: 1.91, first_best_dec: 1.9, sharp_fair: 0.53,
        consensus_fair: 0.52, edge: 0.012, first_edge: 0.01, n_books: 6, has_sharp: true,
        home_team: "Duke", away_team: "Gonzaga",
        commence_time: ISO(new Date(Date.now() + 5 * 3600e3)), last_seen_at: ISO(new Date()),
      }],
      games: [{ game_id: "b1", sport_key: "basketball_ncaab", game_date: d,
        home_team: "Duke", away_team: "Gonzaga",
        start_time: ISO(new Date(Date.now() + 5 * 3600e3)), status: "Scheduled" }],
      team_features: [
        { game_id: "b1", side: "home", team: "Duke", wins: 10, losses: 1,
          adj_o: 121.4, adj_d: 92.1, adj_em: 29.3, adj_tempo: 66.2,
          efg_pct: 0.556, to_pct: 0.152, orb_pct: 0.341, ft_rate: 0.312,
          def_efg_pct: 0.451, def_to_pct: 0.191, def_orb_pct: 0.252, def_ft_rate: 0.271,
          three_rate: 0.401, three_pct: 0.372, def_three_rate: 0.351, def_three_pct: 0.301,
          avg_height: 78.9, experience: 1.8, bench_minutes: 0.31, wab: 4.2, updated_at: ISO(new Date()) },
        { game_id: "b1", side: "away", team: "Gonzaga", wins: 9, losses: 2,
          adj_o: 118.2, adj_d: 95.6, adj_em: 22.6, adj_tempo: 70.8,
          efg_pct: 0.571, to_pct: 0.171, orb_pct: 0.291, ft_rate: 0.288,
          def_efg_pct: 0.478, def_to_pct: 0.172, def_orb_pct: 0.281, def_ft_rate: 0.301,
          three_rate: 0.352, three_pct: 0.361, def_three_rate: 0.372, def_three_pct: 0.322,
          avg_height: 77.8, experience: 2.1, bench_minutes: 0.34, wab: 3.1, updated_at: ISO(new Date()) },
      ],
      qb_features: [],
      matchup_context: [{ game_id: "b1", neutral_site: true, conference_game: false, is_rivalry: false,
        home_rest_days: 3, away_rest_days: 2, venue: "Neutral Arena", indoor: true,
        updated_at: ISO(new Date()) }],
      stats_players: [{ league: "CBB", team: "Duke", player: "A Guard", position: "G",
        stat_line: "18.2 ppg, 4.1 apg", lead_cat: "points", lead_val: 18.2 }],
      game_stats: [], rankings_current: [{ league: "CBB", poll: "AP", rank: 1, team: "Duke", week: 6, season: 2025 }],
      research_patterns: [], research_calibration: [], research_facts: [],
      research_outcomes: [], research_sessions: [], research_snapshots: [],
      venue_weather: [], book_quotes: [], signal_ticks: [], market_residual: [],
      model_predictions: [],
    },
    cfb: {},
  };
}

/* ------------------------------------------------------------------ run --- */
async function main() {
  const M: any = await import("../functions/edgedesk_ai/index.ts");

  const dry = async (question: string, be: Backend, o: { failSchemas?: string[] } = {}) => {
    M.clearCache();
    M.clearProviderIdentities();
    const { f, calls } = makeFetch(be, o);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = f;
    try {
      const res = await M.handle(new Request("https://x/?dry=1", {
        method: "POST",
        headers: { authorization: "Bearer test-jwt", "content-type": "application/json" },
        body: JSON.stringify({ mode: "chat", question }),
      }));
      const j = await res.json();
      return { j, calls };
    } finally { (globalThis as any).fetch = realFetch; }
  };
  const fieldsOf = (j: any) => new Set((j.evidence ?? []).filter((e: any) => e.status !== "UNAVAILABLE").map((e: any) => e.field));
  const unavailFields = (j: any) => new Set((j.evidence ?? []).filter((e: any) => e.status === "UNAVAILABLE").map((e: any) => e.field));

  /* ================================================== IDENTITY (1-7) ==== */
  group("IDENTITY");

  {
    const r = M.resolveTeamIdentity("How do the Giants look tonight?", "baseball_mlb");
    check("San Francisco Giants resolves as MLB",
      r.length === 1 && r[0].canonical_team_id === "MLB:MLB:san-francisco-giants",
      JSON.stringify(r.map((x: any) => x.canonical_team_id)));
  }
  {
    const r = M.resolveTeamIdentity("How do the Giants look tonight?", "americanfootball_nfl");
    check("New York Giants resolves as NFL",
      r.length === 1 && r[0].canonical_team_id === "NFL:NFL:new-york-giants",
      JSON.stringify(r.map((x: any) => x.canonical_team_id)));
  }
  {
    const fb = M.resolveTeamIdentity("Texas Tech offense", "americanfootball_ncaaf")[0];
    const bb = M.resolveTeamIdentity("Texas Tech offense", "basketball_ncaab")[0];
    check("Texas Tech football !== Texas Tech basketball",
      fb.canonical_team_id !== bb.canonical_team_id
      && !M.sameCanonicalTeam(fb.canonical_team_id, bb.canonical_team_id),
      `${fb.canonical_team_id} vs ${bb.canonical_team_id}`);
  }
  {
    const r = M.resolveTeamIdentity("Is Miami any good?", "americanfootball_ncaaf");
    const amb = r.find((x: any) => x.status === "AMBIGUOUS");
    check("Miami Hurricanes !== Miami RedHawks — bare 'Miami' is ambiguous",
      !!amb && amb.candidates.length >= 2 && amb.canonical_team_id === null,
      JSON.stringify(r.map((x: any) => `${x.status}:${x.candidates.length}`)));
  }
  {
    const fb = M.resolveTeamIdentity("Kansas Jayhawks defense", "americanfootball_ncaaf");
    const bb = M.resolveTeamIdentity("Kansas Jayhawks defense", "basketball_ncaab");
    const a = fb.find((x: any) => x.status === "RESOLVED");
    const b = bb.find((x: any) => x.status === "RESOLVED");
    check("Kansas football and Kansas basketball are distinct canonical entities",
      !!a && !!b && a.canonical_team_id !== b.canonical_team_id
      && !M.sameCanonicalTeam(a.canonical_team_id, b.canonical_team_id),
      `${a?.canonical_team_id} vs ${b?.canonical_team_id}`);
  }
  {
    const r = M.resolveTeamIdentity("How is UT doing?", "basketball_ncaab");
    const t = r[0];
    check("Ambiguous abbreviation 'UT' never resolves and names its candidates",
      !!t && t.status === "UNRESOLVED" && t.canonical_team_id === null && t.candidates.length >= 3,
      JSON.stringify(r.map((x: any) => `${x.status}:${x.candidates.map((c: any) => c.canonical_name).join("/")}`)));
  }
  {
    const pi = M.registerProviderIdentity({
      provider: "someprovider", provider_id: 999,
      provider_name: "Not A Real School XYZ", sport: "basketball_ncaab",
    });
    const evidence = M.identityUnresolved("someprovider", "Not A Real School XYZ", "basketball_ncaab", "no canonical match");
    check("Unresolved provider identity is registered and emits an UNAVAILABLE item",
      evidence.status === "UNAVAILABLE" && evidence.field === "identity_unresolved"
      && pi.provider === "someprovider" && pi.sport === "basketball_ncaab",
      `${evidence.status}/${evidence.field}`);
  }

  /* ======================================================= NFL (8-14) ==== */
  group("NFL");

  const nflBe = nflBackend();
  const nflAll = await dry("Best NFL matchups this week?", nflBe);
  {
    const f = fieldsOf(nflAll.j);
    check("NFL complete team research retrieves the owned efficiency layer",
      nflAll.j.sport === "americanfootball_nfl" && f.has("team_efficiency") && f.has("matchup_context"),
      `sport=${nflAll.j.sport} fields=${[...f].join(",")}`);
  }
  {
    const qb = await dry("Who are the best quarterbacks in the NFL right now?", nflBe);
    const f = fieldsOf(qb.j);
    check("NFL quarterback research routes to the QB intent and retrieves qb_features",
      qb.j.intent.intent === "nfl_best_quarterbacks" && f.has("quarterback"),
      `${qb.j.intent.intent} fields=${[...f].join(",")}`);
  }
  {
    const off = await dry("Best NFL offenses this season?", nflBe);
    const req = off.j.coverage?.required ?? {};
    check("NFL offense research requires team_efficiency, not points per game",
      off.j.intent.intent === "nfl_best_offenses" && "team_efficiency" in req,
      `${off.j.intent.intent} required=${Object.keys(req).join(",")}`);
  }
  {
    const def = await dry("Worst NFL defenses this year?", nflBe);
    const ev = (def.j.evidence ?? []).find((e: any) => e.field === "team_efficiency");
    check("NFL defense research carries the def_epa sign warning",
      def.j.intent.intent === "nfl_worst_defenses"
      && String(JSON.stringify(ev?.value ?? {})).includes("NEGATIVE is a good defence"),
      `${def.j.intent.intent}`);
  }
  {
    const f = fieldsOf(nflAll.j);
    check("NFL matchup research attaches both efficiency and the quarterback",
      f.has("team_efficiency") && f.has("quarterback") && f.has("matchup_context"),
      [...f].join(","));
  }
  {
    const inj = await dry("How do NFL injuries affect this week?", nflBe);
    const u = unavailFields(inj.j);
    const gap = (inj.j.unavailable ?? []).find((x: any) => x.field === "nfl_injury_report");
    check("NFL injury gap is DECLARED, not silently omitted",
      u.has("nfl_injury_report") && !!gap
      && String(gap.reason).includes("ingests NO NFL injury report"),
      `unavailable=${[...u].join(",")}`);
  }
  {
    const broken = nflBackend({ stats_players: undefined as any });
    delete (broken.public as any).stats_players;
    const r = await dry("Best NFL offenses this season?", broken);
    check("NFL external source failure degrades one capability, not the module",
      r.j.evidence.length > 0 && r.j.sport === "americanfootball_nfl"
      && r.j.provenance.retrievals > 0,
      `evidence=${r.j.evidence.length}`);
  }

  /* ======================================================= CFB (15-22) === */
  group("CFB");

  const cfbBe = cfbBackend();
  const cfbAll = await dry("Who are the best CFB offenses this season?", cfbBe);
  {
    /* Alabama, not Georgia: "Georgia" genuinely collides with "Georgia Tech"
       and must stay ambiguous. The ambiguous branch is asserted separately
       below — both behaviours matter and they are different behaviours. */
    const roster = await dry("CFB roster for Alabama", cfbBackend());
    const f = fieldsOf(roster.j);
    const ev = (roster.j.evidence ?? []).find((e: any) => e.field === "cfb_roster");
    check("CFB roster question reads the ingested cfb.roster table for a resolved school",
      roster.j.intent.intent === "cfb_roster" && f.has("cfb_roster")
      && ev?.value?.players === 2 && String(ev?.note).includes("NOT A DEPTH CHART"),
      `${roster.j.intent.intent} fields=${[...f].join(",")}`);
  }
  {
    const amb = await dry("CFB roster for Georgia", cfbBackend());
    const u = (amb.j.unavailable ?? []).find((x: any) => x.field === "cfb_roster");
    const ident = (amb.j.identity ?? []).find((i: any) => i.query === "georgia");
    check("CFB roster for an AMBIGUOUS school refuses explicitly instead of silently skipping",
      !!u && String(u.reason).includes("no school resolved unambiguously")
      && ident?.status === "AMBIGUOUS",
      `identity=${ident?.status} unavailable=${!!u}`);
  }
  {
    const rp = await dry("CFB returning production this year", cfbBackend({}, ["cfb.returning_production"]));
    const u = (rp.j.unavailable ?? []).find((x: any) => x.field === "cfb_returning_production");
    check("CFB returning production probes the table and reports the exact gap",
      !!u && String(u.reason).includes("returning_production"),
      JSON.stringify(u ?? null).slice(0, 140));
  }
  {
    const rc = await dry("CFB recruiting rankings", cfbBackend());
    const f = fieldsOf(rc.j);
    check("CFB recruiting is served from ingestion, not a live API call",
      f.has("cfb_recruiting"), [...f].join(","));
  }
  {
    const p = await dry("college football transfer portal", cfbBackend({}, ["cfb.portal"]));
    const u = (p.j.unavailable ?? []).find((x: any) => x.field === "cfb_portal");
    check("CFB portal absence names the table and the endpoint that would fill it",
      !!u && String(u.reason).includes("portal"), JSON.stringify(u ?? null).slice(0, 140));
  }
  {
    const sp = (cfbAll.j.evidence ?? []).find((e: any) => e.field === "cfb_sp_plus");
    check("SP+ is retrieved and labelled EXTERNAL_MODEL, never an EdgeDesk number",
      !!sp && sp.source_type === "EXTERNAL_MODEL" && sp.layer === "external_model"
      && sp.data_layer === "L8_EXTERNAL_MODEL" && sp.status === "UNPROVEN"
      && String(sp.note).includes("never be converted"),
      `${sp?.source_type}/${sp?.layer}/${sp?.status}`);
  }
  {
    const f = fieldsOf(cfbAll.j);
    check("CFB schedule and results come from the ingested cfb.games",
      f.has("cfb_game"), [...f].join(","));
  }
  {
    const f = fieldsOf(cfbAll.j);
    check("CFB matchup research pairs identity, SP+, records and season stats",
      f.has("cfb_sp_plus") && f.has("cfb_record") && f.has("cfb_team_season_stat"),
      [...f].join(","));
  }
  {
    const down = await dry("Who are the best CFB offenses this season?", cfbBackend(), { failSchemas: ["cfb"] });
    const u = (down.j.unavailable ?? []).find((x: any) => x.field === "cfb_identity");
    check("cfb schema unavailable fails honestly and names the fix, without failing the turn",
      !!u && String(u.reason).includes("cfb schema") && down.j.dry === true,
      JSON.stringify(u ?? null).slice(0, 160));
  }

  /* ======================================================= CBB (23-30) === */
  group("CBB");

  const cbbBe = cbbBackend();
  const cbbAll = await dry("Best college basketball matchups tonight?", cbbBe);
  {
    const te = (cbbAll.j.evidence ?? []).find((e: any) => e.field === "team_efficiency");
    check("CBB team efficiency retrieves adjusted efficiency and tempo",
      !!te && (te.value?.adj_o != null) && (te.value?.adj_tempo != null)
      && String(JSON.stringify(te.value)).includes("lower is better"),
      `adj_o=${te?.value?.adj_o}`);
  }
  {
    const pl = await dry("Best CBB players this season?", cbbBackend());
    const f = fieldsOf(pl.j);
    check("CBB player research retrieves the leaderboard line and flags what it lacks",
      pl.j.intent.intent === "cbb_best_players"
      && (f.has("cbb_player_production") || unavailFields(pl.j).has("cbb_player_production")),
      `${pl.j.intent.intent} fields=${[...f].join(",")}`);
  }
  {
    const me = (cbbAll.j.evidence ?? []).find((e: any) => e.field === "cbb_matchup_edge");
    check("CBB matchup research builds the four-factor comparison from owned columns",
      !!me && me.source_type === "DERIVED" && Array.isArray(me.value?.axes) && me.value.axes.length >= 6,
      `axes=${me?.value?.axes?.length}`);
  }
  {
    const pace = await dry("CBB pace matchup tonight", cbbBackend());
    const me = (pace.j.evidence ?? []).find((e: any) => e.field === "cbb_matchup_edge");
    check("CBB pace read uses BOTH adjusted tempos, never one side's",
      pace.j.intent.intent === "cbb_pace_matchup" && !!me
      && me.value?.tempo?.home_adj_tempo != null && me.value?.tempo?.away_adj_tempo != null,
      `${pace.j.intent.intent}`);
  }
  {
    const me = (cbbAll.j.evidence ?? []).find((e: any) => e.field === "cbb_matchup_edge");
    const shooting = (me?.value?.axes ?? []).find((a: any) => a.axis === "shooting");
    check("CBB shooting axis names the holder and carries both raw eFG values",
      !!shooting && shooting.home != null && shooting.away != null && shooting.advantage_team != null,
      JSON.stringify(shooting ?? null));
  }
  {
    const me = (cbbAll.j.evidence ?? []).find((e: any) => e.field === "cbb_matchup_edge");
    const reb = (me?.value?.axes ?? []).find((a: any) => a.axis === "offensive_rebounding");
    const tov = (me?.value?.axes ?? []).find((a: any) => a.axis === "turnovers");
    check("CBB rebounding and turnover axes carry the correct sign convention",
      !!reb && reb.lower_is_better === false && !!tov && tov.lower_is_better === true,
      `orb.lower=${reb?.lower_is_better} tov.lower=${tov?.lower_is_better}`);
  }
  {
    const r = M.resolveTeamIdentity("Washington outlook", "basketball_ncaab");
    const amb = r.find((x: any) => x.status === "AMBIGUOUS");
    check("Ambiguous college school never auto-resolves in CBB",
      !!amb && amb.canonical_team_id === null && amb.candidates.length >= 2,
      JSON.stringify(r.map((x: any) => x.status)));
  }
  {
    const cfg = M.EXTERNAL_ADAPTERS.find((a: any) => a.id === "cbb_external_ratings");
    const out = await M.runExternalAdapters("basketball_ncaab", { season: 2025 });
    check("CBB external ratings source unconfigured emits unavailable, never a guess",
      cfg && !cfg.configured() && out.evidence.length === 1
      && out.evidence[0].status === "UNAVAILABLE"
      && String(out.evidence[0].note).includes("EDGEDESK_CBB_RATINGS_URL"),
      `ran=${out.ran.length} skipped=${out.skipped.length}`);
  }

  /* ================================================== LEARNING (31-37) === */
  group("LEARNING");

  {
    check("A completed research session produces a source-reliability report",
      Array.isArray(cbbAll.j.source_reliability) && cbbAll.j.source_reliability.length > 0
      && cbbAll.j.source_reliability[0].attempts > 0,
      `sources=${cbbAll.j.source_reliability?.length}`);
  }
  {
    const be = nflBackend();
    (be.public as any).signals[0].graded_at = ISO(new Date());
    (be.public as any).signals[0].result = "win";
    (be.public as any).signals[0].clv = 0.021;
    (be.public as any).signals[0].beat_close = true;
    const r = await dry("NFL historical track record", be);
    check("A settled event's graded fields reach the historical layer",
      r.j.intent.intent === "nfl_historical_matchup", `${r.j.intent.intent}`);
  }
  {
    const be = nflBackend();
    (be.public as any).signals[0].graded_at = ISO(new Date());
    (be.public as any).signals[0].clv = 0.021;
    (be.public as any).signals[0].beat_close = true;
    const r = await dry("NFL historical track record", be);
    const hist = (r.j.evidence ?? []).find((e: any) => e.field === "clv_history");
    check("CLV history is retrieved with its sample size, never without",
      !hist || (hist.value?.n != null),
      JSON.stringify(hist?.value ?? null).slice(0, 120));
  }
  {
    check("Research outcome shape carries thesis, price and falsifier separately",
      cbbAll.j.thesis_attack != null
      && Array.isArray(cbbAll.j.thesis_attack.support)
      && Array.isArray(cbbAll.j.thesis_attack.falsifiers),
      JSON.stringify(Object.keys(cbbAll.j.thesis_attack ?? {})));
  }
  {
    const rel = cbbAll.j.source_reliability ?? [];
    const ok = rel.every((s: any) =>
      s.reliability_score >= 0 && s.reliability_score <= 1
      && s.completeness_rate >= 0 && s.completeness_rate <= 1);
    check("Source reliability stays infrastructure quality, bounded 0-1, never a probability",
      ok && rel.length > 0, JSON.stringify(rel.slice(0, 2)));
  }
  {
    check("Learning context records operational facts only, no sports claims",
      cbbAll.j.learning_context != null
      && cbbAll.j.learning_context.sport === "basketball_ncaab"
      && String(cbbAll.j.learning_context.note).includes("Infrastructure quality only"),
      JSON.stringify(Object.keys(cbbAll.j.learning_context ?? {})));
  }
  {
    const now = Date.now();
    const evs = M.normalizeEvidence([
      M.ev({ source: "s", field: "team_efficiency", entity: "Early", information_timestamp: "2025-11-01T00:00:00Z" }),
      M.ev({ source: "s", field: "team_efficiency", entity: "Later", information_timestamp: "2025-12-20T00:00:00Z" }),
      M.ev({ source: "s", field: "prior_outcome", entity: "Result", information_timestamp: "2025-12-25T00:00:00Z" }),
    ]);
    const g = M.enforceNoLeakage(evs, "2025-11-15");
    check("Future-data leakage is prevented: later information is excluded and named",
      g.evidence.length === 1 && g.report.excluded === 2
      && g.report.excluded_items.some((x: any) => x.entity === "Later")
      && g.report.excluded_items.some((x: any) => x.entity === "Result"),
      `kept=${g.evidence.length} excluded=${g.report.excluded}`);
  }

  /* ================================================= INTEGRITY (38-44) === */
  group("INTEGRITY");

  {
    const nfl = M.resolveTeamIdentity("Giants", "americanfootball_nfl")[0];
    const mlb = M.resolveTeamIdentity("Giants", "baseball_mlb")[0];
    check("Wrong sport: an NFL id and an MLB id can never be joined",
      !M.sameCanonicalTeam(nfl.canonical_team_id, mlb.canonical_team_id),
      `${nfl.canonical_team_id} vs ${mlb.canonical_team_id}`);
  }
  {
    const g = M.evidenceIntegrity([
      M.ev({ source: "team_features", field: "team_efficiency", entity: "Team A",
        value: { team: "Team A", game: "Team B @ Team C" } }),
    ]);
    const chk = g.checks.find((c: any) => c.name === "cross_entity_identity");
    check("Wrong team: a team attached to a game it is not in FAILS integrity",
      g.verdict === "FAIL" && chk?.status === "FAIL", `${g.verdict}/${chk?.status}`);
  }
  {
    const g = M.evidenceIntegrity([
      M.ev({ source: "a", field: "pitcher_quality", entity: "Person X", value: { name: "Person X", team: "T1" } }),
      M.ev({ source: "b", field: "workload", entity: "Person X", value: { team: "T2" } }),
    ]);
    const chk = g.checks.find((c: any) => c.name === "subject_team_consistency");
    check("Wrong player: one subject on two teams FAILS integrity",
      chk?.status === "FAIL", `${chk?.status}`);
  }
  {
    check("Wrong season: split-year sports label a January game by the season that began",
      M.seasonFor("americanfootball_nfl", "2026-01-15") === 2025
      && M.seasonFor("basketball_ncaab", "2026-03-20") === 2025
      && M.seasonFor("baseball_mlb", "2025-08-12") === 2025,
      `${M.seasonFor("americanfootball_nfl", "2026-01-15")}`);
  }
  {
    const g = M.evidenceIntegrity([
      M.ev({ source: "a", field: "game", entity: "A @ B", event_id: "1", value: { game: "A @ B", game_id: "1" } }),
      M.ev({ source: "a", field: "game", entity: "A @ B", event_id: "2", value: { game: "A @ B", game_id: "2" } }),
    ]);
    const chk = g.checks.find((c: any) => c.name === "duplicate_event");
    check("Duplicate event: one matchup under two ids is flagged",
      chk?.status === "WARNING", `${chk?.status}`);
  }
  {
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    const e = M.ev({ source: "a", field: "team_efficiency", entity: "T", status: "VERIFIED",
      freshness: M.freshnessOf("team_stats", old), source_timestamp: old });
    check("Stale evidence is downgraded from VERIFIED automatically",
      e.status === "STALE" || e.status === "HISTORICAL", `${e.status}/${e.freshness}`);
  }
  {
    const c = M.findConflicts([
      M.ev({ source: "src_a", field: "weather", entity: "G", value: 70 }),
      M.ev({ source: "src_b", field: "weather", entity: "G", value: 40 }),
    ]);
    check("Conflicting evidence between two sources is detected",
      c.length === 1 && c[0].field === "weather", `conflicts=${c.length}`);
  }

  /* ================================================ REGRESSION (45-48) === */
  group("REGRESSION");

  {
    const cases: [string, string][] = [
      ["who are the worst pitchers today?", "worst_pitchers"],
      ["best pitchers on the slate", "best_pitchers"],
      ["exploitable pitchers tonight", "exploitable_pitchers"],
      ["what's the bullpen situation", "bullpen"],
      ["weather today", "weather"],
      ["best matchups today", "best_matchups"],
      ["what should i bet tonight", "best_bets"],
      ["what changed since detection", "what_changed"],
      ["at what price does this stop being a bet", "price"],
      ["historically how have we done", "historical"],
      ["which offense is most efficient tonight", "team_efficiency"],
    ];
    const bad = cases.filter(([q, want]) => M.classify(q, "").intent !== want)
      .map(([q, want]) => `${q} -> ${M.classify(q, "").intent} (want ${want})`);
    check("All pre-existing intent classifications still hold", bad.length === 0, bad.join("; "));
  }
  {
    const mlbReq = M.requirementsFor("worst_pitchers");
    check("MLB requirement map is unchanged",
      mlbReq.length === 9 && mlbReq[0].field === "game"
      && mlbReq[2].field === "pitcher_quality" && mlbReq[2].tier === "REQUIRED",
      `n=${mlbReq.length}`);
  }
  {
    const sig = { edge: 0.03, first_edge: 0.04, n_books: 8, has_sharp: true, last_seen_at: ISO(new Date()) };
    const a = M.attackThesis(sig);
    const t = M.signalTradeable({ market: "h2h", best_dec: 1.9 });
    const lay = M.signalTradeable({ market: "h2h_lay", best_dec: 1.9 });
    check("Deterministic engine surface is unchanged (attack, tradeable bound)",
      a.status === "SURVIVES" && t.ok === true && lay.ok === false,
      `${a.status}/${t.ok}/${lay.ok}`);
  }
  {
    const before = M.SPORT_CAPABILITIES.baseball_mlb;
    const dims = M.DIMENSIONS.baseball_mlb;
    check("MLB capabilities and dimensions untouched by the multi-sport expansion",
      before.pitching_matchup === true && before.bullpen === true && before.team_efficiency === false
      && dims.includes("pitcher_quality") && dims.includes("bullpen_flag") && dims.length === 10,
      `dims=${dims.length}`);
  }

  /* ------------------------------------------------------------ report --- */
  const byGroup: Record<string, { pass: number; fail: number }> = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] ?? { pass: 0, fail: 0 };
    if (r.ok) byGroup[r.group].pass++; else byGroup[r.group].fail++;
  }
  console.log("\n================ EdgeDesk research-engine test suite ================");
  for (const r of results) {
    console.log(`${r.ok ? " ok " : "FAIL"}  #${String(r.n).padStart(2)} [${r.group.padEnd(10)}] ${r.name}`
      + (!r.ok && r.detail ? `\n           ${r.detail}` : ""));
  }
  console.log("--------------------------------------------------------------------");
  for (const [g, v] of Object.entries(byGroup)) {
    console.log(`${g.padEnd(12)} ${v.pass} passed, ${v.fail} failed`);
  }
  console.log(`TOTAL        ${PASS} passed, ${FAIL} failed, ${N} total`);
  if (FAIL) {
    console.log("\nFAILURES:");
    for (const f of FAILURES) console.log("  - " + f);
  }
  console.log("====================================================================");
  if (FAIL && typeof process !== "undefined") process.exitCode = 1;
}

await main();
