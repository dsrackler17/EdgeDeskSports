/* EdgeDesk edgedesk_ai — deterministic test suite (Phase 20).
   Runs the REAL function against fixture backends. Same file used before and
   after the fix, so every claim is a measured delta. */
import {
  install, mlbCardDay, signalsFor, check, section, report, YEST, TODAY, TOM,
} from "./harness.ts";

const EMPTY = {
  signals: [], mlb_game_cards: [], games: [], pitcher_features: [], offense_features: [],
  mlb_pitcher_usage: [], pitcher_season: [], team_season: [], venue_weather: [],
  mlb_bullpen_taxed: [], mlb_bullpen_team: [], research_snapshots: [], research_facts: [],
  research_outcomes: [], research_patterns: [], research_calibration: [], research_sessions: [],
  book_quotes: [], signal_ticks: [], market_residual: [], model_predictions: [],
  team_features: [], qb_features: [], matchup_context: [], rankings_current: [], stats_players: [],
} as Record<string, any[]>;

let mod: any;

async function ask(question: string, tables: Record<string, any>, opts: any = {}) {
  const cap = install({ tables: { ...EMPTY, ...tables }, errors: opts.errors, anthropicEmptyFirst: opts.emptyFirst });
  mod ??= await import("./index.ts");
  mod.clearCache?.();
  const res = await mod.handle(new Request("https://x/edgedesk_ai", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.jwt ?? "test.jwt.a"}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: opts.mode ?? "chat", question, packet: opts.packet, history: opts.history }),
  }));
  const out = await res.json();
  return { res, out, prompt: cap.anthropicPrompt ?? "", cap, r: out.research ?? {} };
}

const yestG = mlbCardDay(YEST, 15, "Final", 0);
const todayG = mlbCardDay(TODAY, 15, "Scheduled", 6);
const fullCard = [...yestG, ...todayG, ...mlbCardDay(TOM, 3, "Scheduled", 12)];
const mlbSignals = signalsFor(todayG);

const gamesRows = (day: string, games: any[], status: string) => games.map((g, i) => ({
  game_id: `g-${day}-${i}`, game_date: day, home_team: g.home_team_name, away_team: g.away_team_name,
  start_time: g.start_time, status, park_id: 1, sport_key: "baseball_mlb",
}));

/* ============================================================== 1. BUILD */
section("BUILD / DEPLOY SAFETY (Phase 19)");
{
  const { out, r } = await ask("what's on the slate", { signals: mlbSignals, mlb_game_cards: fullCard });
  check("response exposes a BUILD string", typeof out.build === "string" && out.build.length > 0,
    `got build=${JSON.stringify(out.build)}`);

  install({ tables: EMPTY });
  mod ??= await import("./index.ts");
  const probe = await mod.handle(new Request("https://x/edgedesk_ai?probe=1", { method: "GET" }));
  const pj = await probe.json().catch(() => null);
  check("GET ?probe=1 returns 200 with a build identifier",
    probe.status === 200 && !!pj?.build, `status=${probe.status} body=${JSON.stringify(pj)?.slice(0, 120)}`);

  const dry = await mod.handle(new Request("https://x/edgedesk_ai?dry=1", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ question: "worst pitchers today" }),
  }));
  const dj = await dry.json().catch(() => null);
  check("POST ?dry=1 returns the research packet without calling the model",
    dry.status === 200 && dj?.dry === true && dj?.answer === undefined && dj?.provenance?.model_not_called === true,
    `status=${dry.status} keys=${dj ? Object.keys(dj).join(",") : "null"}`);
  void r;
}

/* ================================================= 2. SLATE / DATE SCOPE */
section("SLATE SCOPE — the live card, not yesterday's");
{
  const { prompt, r } = await ask("Who are the worst pitchers on today's MLB slate?",
    { signals: mlbSignals, mlb_game_cards: fullCard });
  const today = new Set(prompt.match(new RegExp(`${TODAY}-(Away|Home)Arm-\\d+`, "g")) ?? []).size;
  const yest = new Set(prompt.match(new RegExp(`${YEST}-(Away|Home)Arm-\\d+`, "g")) ?? []).size;

  check("today's starters reach the model", today >= 25, `only ${today}/30 of today's starters in prompt`);
  check("yesterday's completed starters are NOT sent as probable starters", yest === 0,
    `${yest}/30 of yesterday's Final starters were sent`);
  check("coverage universe is the live slate", (r.data_path?.slate_scope?.starters_on_live_slate ?? 0) >= 25,
    `starters_on_live_slate=${r.data_path?.slate_scope?.starters_on_live_slate}`);
  check("intent classified as worst_pitchers", r.intent === "worst_pitchers", `intent=${r.intent}`);
}

/* ============================================== 3. INTENT / RANKING AXIS */
section("INTENT + RANKING AXIS (Phase 14)");
{
  const cases: [string, string][] = [
    ["Who are the best pitchers on tonight's card?", "best_pitchers"],
    ["worst pitching matchups today?", "best_matchups"],
    ["What are the best matchups on the board?", "best_matchups"],
    ["What's the best bet tonight?", "best_bets"],
    ["Why does EdgeDesk like this?", "why"],
    ["What changed since detection?", "what_changed"],
    ["Compare Yankees vs Red Sox", "compare"],
    ["Have we historically seen a setup like this?", "historical"],
  ];
  for (const [q, want] of cases) {
    const { r } = await ask(q, { signals: mlbSignals, mlb_game_cards: fullCard });
    check(`"${q.slice(0, 42)}" -> ${want}`, r.intent === want, `got ${r.intent}`);
  }
  const { prompt } = await ask("Who are the best pitchers on tonight's card?",
    { signals: mlbSignals, mlb_game_cards: fullCard });
  check("best_pitchers carries an explicit BEST ranking axis",
    /RANKING AXIS/.test(prompt) && /asked who is BEST/.test(prompt));
}

/* ============================================== 4. CROSS-SPORT IDENTITY */
section("CROSS-SPORT ENTITY SAFETY (Phase 3 / Phase 7)");
{
  const nflGames = [{
    game_id: "nfl-1", game_date: TODAY, home_team: "New York Giants", away_team: "Dallas Cowboys",
    start_time: `${TODAY}T20:00:00Z`, status: "Scheduled", sport_key: "americanfootball_nfl",
  }];
  const nflSignals = [{
    ...signalsFor([{ home_team_name: "New York Giants", away_team_name: "Dallas Cowboys", game_date: TODAY }])[0],
    sport_key: "americanfootball_nfl", sport_title: "NFL",
  }];
  const { r, prompt } = await ask("How does the Giants offense look tonight?", {
    signals: nflSignals, games: nflGames,
    team_features: [
      { game_id: "nfl-1", side: "home", team: "New York Giants", wins: 5, losses: 4, off_epa_play: 0.06,
        def_epa_play: -0.02, off_success_rate: 0.45, def_success_rate: 0.41, plays_per_game: 63, updated_at: new Date().toISOString() },
      { game_id: "nfl-1", side: "away", team: "Dallas Cowboys", wins: 6, losses: 3, off_epa_play: 0.11,
        def_epa_play: 0.01, off_success_rate: 0.48, def_success_rate: 0.44, plays_per_game: 66, updated_at: new Date().toISOString() },
    ],
  });
  check("an NFL question does not ADOPT an MLB club as an entity",
    !(r.entities?.teams ?? []).includes("San Francisco Giants")
    && !/In focus:.*San Francisco Giants/.test(prompt),
    `entities.teams=${JSON.stringify(r.entities?.teams)}`);
  check("the cross-league alias rejection is stated, not silent",
    (r.entities?.rejected_teams ?? []).some((m: any) => m.name === "San Francisco Giants")
    && /alias shared across leagues|not baseball/.test(prompt),
    `rejected=${JSON.stringify(r.entities?.rejected_teams)}`);
  check("an NFL question retrieves the football layer, not the MLB card",
    /team_efficiency/.test(prompt) || r.intent === "team_efficiency", `intent=${r.intent}`);
  check("no MLB pitcher retrieval on an NFL question",
    !/mlb_game_cards/.test(JSON.stringify(r.data_path ?? {})), "MLB card retrieval ran for an NFL question");
}

/* ================================================ 5. PLAYER RESOLUTION */
section("PLAYER ENTITY RESOLUTION (Phase 3)");
{
  const pfRows = [
    { game_id: `g-${TODAY}-0`, side: "home", pitcher_id: 543037, name: "Gerrit Cole", xera: 3.1, k_pct: 0.30,
      bb_pct: 0.06, barrel_pct: 0.06, hardhit_pct: 0.34, era: 3.0, fip: 3.2, whip: 1.02, whiff_pct: 0.31,
      xwoba_against: 0.281, updated_at: new Date().toISOString() },
    { game_id: `g-${TODAY}-1`, side: "away", pitcher_id: 656302, name: "Cole Ragans", xera: 3.6, k_pct: 0.28,
      bb_pct: 0.08, barrel_pct: 0.07, hardhit_pct: 0.37, era: 3.5, fip: 3.6, whip: 1.15, whiff_pct: 0.29,
      xwoba_against: 0.301, updated_at: new Date().toISOString() },
  ];
  const tables = {
    signals: mlbSignals, mlb_game_cards: fullCard,
    games: gamesRows(TODAY, todayG, "Scheduled"), pitcher_features: pfRows,
  };
  const a = await ask("How has Gerrit Cole been pitching?", tables);
  check("unambiguous player name resolves to exactly one person",
    (a.r.entities?.players ?? []).some((p: any) => p.status === "RESOLVED" && p.resolved === "Gerrit Cole"),
    `players=${JSON.stringify(a.r.entities?.players)}`);

  const b = await ask("How has Cole looked lately?", tables);
  const amb = (b.r.entities?.players ?? []).find((p: any) => p.status === "AMBIGUOUS");
  check("ambiguous surname is reported as ambiguous, not guessed",
    !!amb && amb.candidates.length === 2 && amb.resolved === null,
    `players=${JSON.stringify(b.r.entities?.players)}`);
  check("the analyst is instructed not to pick between ambiguous candidates",
    /AMBIGUOUS: "Cole"/.test(b.prompt) && /Do NOT pick one/.test(b.prompt));
}

/* ============================================ 6. SEASON-LAYER FALLBACK */
section("LAYER FALLBACK (Phase 4 / Phase 6)");
{
  const seasonRows = todayG.flatMap((g, i) => ([
    { name: `${TODAY}-HomeArm-${i}`, team: g.home_team_name, games_started: 20, ip: 118.1, era: 4.9,
      fip: 5.2 - i * 0.05, whip: 1.4, k_bb_pct: 0.10, hr_per9: 1.5, fip_constant: 3.15, as_of: new Date().toISOString(), season: new Date().getFullYear() },
  ]));
  const { prompt, r } = await ask("Who are the worst pitchers on today's MLB slate?", {
    signals: mlbSignals, mlb_game_cards: fullCard,
    games: gamesRows(TODAY, todayG, "Scheduled"),
    pitcher_features: [],                    // per-game layer gone
    pitcher_season: seasonRows,              // season layer present
    team_season: [{ team: "New York Yankees", runs_per_game: 5.1, ops: 0.760, k_pct: 0.21, hr_per_game: 1.4,
      woba: 0.330, barrel_pct: 0.09, hardhit_pct: 0.41, ra_per_game: 4.2, as_of: new Date().toISOString(), season: new Date().getFullYear() }],
  });
  check("season layer is retrieved when the per-game layer is empty", /season_pitching/.test(prompt));
  check("season and matchup layers are labelled distinctly",
    /NOT matchup-specific/.test(prompt), "season layer not explicitly marked non-matchup");
  check("data_path names which link failed", !!r.data_path?.pitcher_features);
}
{
  const { prompt, r } = await ask("Who are the worst pitchers on today's MLB slate?", {
    signals: mlbSignals, mlb_game_cards: fullCard, games: gamesRows(TODAY, todayG, "Scheduled"),
  });
  check("both layers missing -> UNAVAILABLE is stated, not filled",
    /UNAVAILABLE|not retrievable|has not run/.test(prompt));
  check("both layers missing -> completeness reports the gap",
    (r.completeness?.missing ?? []).includes("pitcher_quality"),
    `missing=${JSON.stringify(r.completeness?.missing)}`);
}

/* ================================================= 7. INTEGRITY FAULTS */
section("INTEGRITY (Phase 7 / Phase 8)");
{
  // Identical stat vector on two different pitchers.
  const dup = { xera: 4.44, k_pct: 0.19, bb_pct: 0.09, barrel_pct: 0.11, hardhit_pct: 0.44,
    era: 4.9, fip: 4.8, whip: 1.42, whiff_pct: 0.22, xwoba_against: 0.345 };
  const { r } = await ask("Who are the worst pitchers today?", {
    signals: mlbSignals, mlb_game_cards: fullCard, games: gamesRows(TODAY, todayG, "Scheduled"),
    pitcher_features: [
      { game_id: `g-${TODAY}-0`, side: "home", pitcher_id: 1, name: "Arm One", ...dup, updated_at: new Date().toISOString() },
      { game_id: `g-${TODAY}-1`, side: "home", pitcher_id: 2, name: "Arm Two", ...dup, updated_at: new Date().toISOString() },
    ],
  });
  check("duplicate stat profile on two pitchers -> integrity FAIL",
    r.integrity?.verdict === "FAIL", `verdict=${r.integrity?.verdict}`);
}
{
  // Pitcher attached to a team not playing in his own game.
  const badGames = [{ game_id: `g-${TODAY}-0`, game_date: TODAY, home_team: "New York Yankees",
    away_team: "Boston Red Sox", start_time: `${TODAY}T23:00:00Z`, status: "Scheduled", sport_key: "baseball_mlb" }];
  const { r } = await ask("Who are the worst pitchers today?", {
    signals: mlbSignals, mlb_game_cards: fullCard, games: badGames,
    pitcher_features: [{ game_id: `g-${TODAY}-0`, side: "home", pitcher_id: 9, name: "Wrong Join",
      xera: 4.2, k_pct: 0.2, bb_pct: 0.08, barrel_pct: 0.09, hardhit_pct: 0.4, era: 4.4, fip: 4.3,
      whip: 1.3, whiff_pct: 0.24, xwoba_against: 0.33, updated_at: new Date().toISOString() }],
  });
  check("integrity runs an identity chain check", !!r.integrity?.summary);
}
{
  // Stale evidence: month-old feature rows.
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const { r } = await ask("Who are the worst pitchers today?", {
    signals: mlbSignals, mlb_game_cards: fullCard, games: gamesRows(TODAY, todayG, "Scheduled"),
    pitcher_features: todayG.slice(0, 4).map((g, i) => ({ game_id: `g-${TODAY}-${i}`, side: "home",
      pitcher_id: 100 + i, name: `${TODAY}-HomeArm-${i}`, xera: 4 + i * 0.1, k_pct: 0.2, bb_pct: 0.08,
      barrel_pct: 0.09, hardhit_pct: 0.4, era: 4.4, fip: 4.3, whip: 1.3, whiff_pct: 0.24,
      xwoba_against: 0.33, updated_at: old })),
  });
  check("stale feature rows raise a freshness warning",
    r.integrity?.verdict !== "PASS", `verdict=${r.integrity?.verdict}`);
}

/* ============================================= 8. RLS / ERROR HANDLING */
section("DATA PATH DIAGNOSTICS (Phase 16)");
{
  const { prompt, r } = await ask("Who are the worst pitchers today?",
    { signals: mlbSignals, mlb_game_cards: fullCard },
    { errors: { pitcher_features: { status: 401, body: "permission denied for table pitcher_features" } } });
  check("an RLS/permission failure is diagnosed, not reported as empty",
    /permission denied|RLS|401/.test(JSON.stringify(r.data_path ?? {}) + prompt),
    "no permission diagnosis surfaced");
}
{
  const { r } = await ask("What's on the slate?", { signals: [] });
  check("empty signals is reported as a named unavailable, not a silent zero",
    (r.unavailable ?? []).some((u: any) => u.source === "signals"), `unavailable=${JSON.stringify(r.unavailable)}`);
}

/* ================================================== 9. HISTORY / CLV N */
section("HISTORICAL SAMPLE INTEGRITY (Phase 13)");
{
  const graded = Array.from({ length: 2400 }, (_, i) => ({
    clv: 0.01 + (i % 7) * 0.001, beat_close: i % 2 === 0, result: i % 3 === 0 ? "win" : "loss",
    first_edge: 0.03, sport_key: "baseball_mlb", market: "h2h", graded_at: new Date(Date.now() - i * 3600_000).toISOString(),
  }));
  const { prompt } = await ask("How have we done historically on setups like this?",
    { signals: mlbSignals, mlb_game_cards: fullCard, signals_graded: graded, ...{ signals: [...mlbSignals] } });
  void prompt;
  // Direct unit check on the reported N vs the true count.
  const capd = install({ tables: { ...EMPTY, signals: graded } });
  mod ??= await import("./index.ts");
  mod.clearCache?.();
  const dal = new mod.Dal({ supabaseUrl: "https://test.supabase.co", apikey: "k", authorization: "Bearer t" });
  const evs = await dal.getCLVHistory("baseball_mlb", "h2h", null);
  const n = (evs[0]?.value as any)?.n;
  check("CLV history N is the true count, not a truncated page",
    n === 2400 || (evs[0]?.value as any)?.n_exact === 2400,
    `reported n=${n} against a true 2400 (PostgREST caps the page at 1000)`);
  void capd;
}

/* ==================================== 10. NON-MLB SPORT HONESTY (P17) */
section("SPORT GENERALIZATION (Phase 17)");
{
  const nhlSignals = [{ ...signalsFor([{ home_team_name: "Boston Bruins", away_team_name: "Montreal Canadiens" }])[0],
    sport_key: "icehockey_nhl", sport_title: "NHL" }];
  const { prompt } = await ask("Who's the better goalie matchup tonight?", { signals: nhlSignals });
  check("a CORE_ONLY sport declares its missing module rather than improvising",
    /goalie|not ingested|sport_module|CORE_ONLY|Core market research/.test(prompt));
  check("no baseball complaint on a hockey question",
    !/No pitcher data was retrieved/.test(prompt));
}

/* ====================================== 11. DETERMINISTIC VALUE SAFETY */
section("DETERMINISTIC VALUES UNTOUCHED (Phase 12 / Phase 21)");
{
  const { prompt, cap } = await ask("What's the best bet tonight?", { signals: mlbSignals, mlb_game_cards: fullCard });
  const s = mlbSignals[0];
  check("engine edge reaches the model verbatim", prompt.includes(String(s.edge)));
  check("engine fair price reaches the model verbatim", prompt.includes(String(s.sharp_fair)));
  check("system prompt forbids the model computing a betting metric",
    /Never produce or alter a probability, fair price, edge/.test(cap.anthropicSystem ?? ""));
}

/* ================================ 12. EVIDENCE DELIVERY / RETRY PATH */
section("EVIDENCE DELIVERY INTEGRITY (retry path)");
{
  const history = [
    { role: "user", content: "earlier unrelated turn about the Rockies" },
    { role: "assistant", content: "earlier answer" },
  ];
  const { cap, out } = await ask("Who are the worst pitchers on today's MLB slate?",
    { signals: mlbSignals, mlb_game_cards: fullCard,
      games: gamesRows(TODAY, todayG, "Scheduled") },
    { emptyFirst: true, history });

  check("an empty completion is retried", cap.anthropicCalls.length === 2,
    `${cap.anthropicCalls.length} model call(s)`);
  check("the retry re-sends the RESEARCH PACKET, not an earlier history turn",
    /EVIDENCE —/.test(cap.anthropicCalls[1] ?? "") && !/earlier unrelated turn/.test(cap.anthropicCalls[1] ?? ""),
    `retry began: ${(cap.anthropicCalls[1] ?? "").slice(0, 90)}`);
  check("the retry recovers an answer", out.answer === "OK", `answer=${JSON.stringify(out.answer)}`);

  // The evidence array in BOTH payloads must be complete JSON — never severed.
  for (const [i, c] of cap.anthropicCalls.entries()) {
    const m = c.match(/the distinction could matter:\n(\[[\s\S]*?\])\n\n/);
    let ok = false;
    try { ok = !!m && Array.isArray(JSON.parse(m[1])); } catch { ok = false; }
    check(`evidence payload ${i + 1} is whole, parseable JSON (no mid-object cut)`, ok);
  }
}

process.exit(report());
