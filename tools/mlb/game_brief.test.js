#!/usr/bin/env node
/* ===========================================================================
   Tests for the MLB GAMES BOARD and the MLB GAME BRIEF.

   Baseball now has what college football and the NFL already had: a board of
   every game on the card, and a full research brief behind each one. Nothing
   here is a mock of that path. The SHIPPED loader in app.html reads stubbed
   PostgREST responses, the SHIPPED builder turns them into a payload, and the
   SHIPPED renderer in _presentation.js draws it — so a change that breaks the
   contract between the three fails here rather than in a browser.

   What these tests hold, and each one is a rule that would quietly turn a
   research page back into a tip sheet:

     1  THE PROJECTION IS PUBLISHED AND LABELLED, NEVER SOLD. The brief now
        carries the run model's own numbers — the same object the board row
        rendered, found by key rather than recomputed — and every one of them
        travels with EXPERIMENTAL, "never graded against a closing line" and
        "counted nowhere". A separate server-side model_predictions row is
        named as a DIFFERENT estimate and never as this one.
     2  A PROBABLE STARTER IS NEVER PROMOTED. The card has no confirmed state,
        so neither does the brief.
     3  THE ARCHIVE IS NEVER BLENDED WITH THIS SEASON. The 2016–2025 career
        line and the season-to-date line are separate rows with separate
        labels, and the archive is never described as current form.
     4  AN AMBIGUOUS NAME IS REFUSED, NOT GUESSED. Two pitchers sharing a
        folded name leave the career line off, with the reason printed.
     5  A GAP IS NAMED, NEVER FILLED. A missing starter, a missing team row, a
        missing bullpen flag and a missing weather reading each appear in
        "What EdgeDesk could not measure".
     6  THE BOARD DOES NOT DEPEND ON THE ARCHIVE. A database with no mlbhist
        installed still lists every game and still opens every brief.
     7  PERFORMANCE_INDEX IS NEVER A PRICE. It is never converted to a
        probability, a fair line or an edge anywhere on the page.
     8  THE RENDERER'S CONTRACT IS MET. Every key researchHTML reads without
        checking is present, so no shape throws.

   Run: node tools/mlb/game_brief.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const EDMlbPitchers = require(path.join(ROOT, 'lib', 'mlb_pitcher_history.js'));
/* The run model the board now draws a projection from. Required, not stubbed:
   a stub would let the board pass this suite while shipping a different
   number than the engine actually produces. */
require(path.join(ROOT, 'mlb', 'params.js'));
const EDBaseball = require(path.join(ROOT, 'mlb', 'engine.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

/* ---- the module, sliced out of the page that ships it ------------------- */
const START = APP.indexOf('/* ═══ baseball: THE GAMES BOARD AND THE GAME BRIEF');
const END = APP.indexOf("researchRegister({id:'baseball'", START);
if (START < 0 || END < 0) {
  console.log('FAIL | app.html no longer carries the MLB board module where this test slices it');
  process.exit(1);
}
const SRC = APP.slice(START, END);

/* The two helpers the module calls that live further up the same page. In a
   browser they are simply in scope; stubbing them would make the test pass
   while testing nothing, so the REAL ones are sliced out by name. */
function fnSrc(name) {
  const at = APP.indexOf('function ' + name + '(');
  if (at < 0) { console.log('FAIL | app.html no longer defines ' + name); process.exit(1); }
  const end = APP.indexOf('\n}\n', at);
  return end < 0 ? APP.slice(at, APP.indexOf('\n', at) + 1) : APP.slice(at, end + 3);
}
const MLBNORM = APP.match(/function mlbNorm\(x\)\{[^\n]*\n/)[0];
const MLBORD = APP.match(/function mlbOrd\(n\)\{[^\n]*\n/)[0];

/* ---- the stub database ------------------------------------------------- */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const SEASON = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date()));

/* Three games, each built to exercise one rule:
     1  COMPLETE   — both starters, both team rows, both bullpens, an archive
                     line on each: the brief at full strength.
     2  HALF       — one starter posted, one club missing from team_season,
                     no bullpen flags, an outdoor park with no wind.
     3  AMBIGUOUS  — a starter whose folded name matches two archive rows. */
const CARDS = [
  { game_date: TODAY, start_time: TODAY + 'T23:10:00Z', start_time_local: '7:10 PM', away_team_id: 147, home_team_id: 121,
    venue: 'Citi Field', status: 'Scheduled', doubleheader: 'N', game_number: 1, series_game_number: 2, games_in_series: 3,
    away_team_name: 'New York Yankees', away_record: '90-60', away_division: 'AL East', away_division_rank: 1,
    away_games_back: '-', away_road_record: '44-31', away_streak: 'W3',
    away_pitcher_name: 'Gerrit Cole', away_pitcher_throws: 'R',
    home_team_name: 'New York Mets', home_record: '84-66', home_division: 'NL East', home_division_rank: 2,
    home_games_back: '4.0', home_home_record: '46-29', home_streak: 'L1',
    home_pitcher_name: 'Zack Wheeler', home_pitcher_throws: 'R',
    park_factor: 0.98, hr_factor: 0.95, run_factor: 0.96, roof_type: 'Open', is_dome: false,
    temp_f: 71, humidity: 58, precip_prob: 10, wind_mph: 9, wind_dir: 'NE', wind_rel: 'in from left' },
  { game_date: TODAY, start_time: TODAY + 'T20:05:00Z', start_time_local: '4:05 PM', away_team_id: 111, home_team_id: 110,
    venue: 'Oriole Park at Camden Yards', status: 'Scheduled', doubleheader: 'N', game_number: 1,
    away_team_name: 'Boston Red Sox', away_record: '78-72', away_division: 'AL East', away_division_rank: 3,
    away_games_back: '12.0', away_road_record: '36-39', away_streak: 'W1',
    away_pitcher_name: 'Brayan Bello', away_pitcher_throws: 'R',
    home_team_name: 'Baltimore Orioles', home_record: '80-70', home_division: 'AL East', home_division_rank: 2,
    home_games_back: '10.0', home_home_record: '43-32', home_streak: 'L2',
    home_pitcher_name: null, home_pitcher_throws: null,
    park_factor: 1.07, hr_factor: 1.12, run_factor: 1.06, roof_type: 'Open', is_dome: false,
    temp_f: 78, humidity: 64, precip_prob: 20, wind_mph: null, wind_dir: null, wind_rel: null },
  { game_date: TODAY, start_time: TODAY + 'T02:10:00Z', start_time_local: '10:10 PM', away_team_id: 119, home_team_id: 137,
    venue: 'Oracle Park', status: 'Scheduled', doubleheader: 'N', game_number: 1,
    away_team_name: 'Los Angeles Dodgers', away_record: '95-55', away_division: 'NL West', away_division_rank: 1,
    away_games_back: '-', away_road_record: '48-27', away_streak: 'W5',
    away_pitcher_name: 'Luis Garcia', away_pitcher_throws: 'R',
    home_team_name: 'San Francisco Giants', home_record: '76-74', home_division: 'NL West', home_division_rank: 3,
    home_games_back: '19.0', home_home_record: '41-34', home_streak: 'W2',
    home_pitcher_name: 'Logan Webb', home_pitcher_throws: 'R',
    park_factor: 0.92, hr_factor: 0.81, run_factor: 0.93, roof_type: 'Open', is_dome: false,
    temp_f: 58, humidity: 76, precip_prob: 0, wind_mph: 14, wind_dir: 'W', wind_rel: 'in from right' }
];
const GAMES = [
  { game_id: 'g1', game_date: TODAY, away_team: 'New York Yankees', home_team: 'New York Mets', start_time: CARDS[0].start_time, status: 'Scheduled', park_id: 'NYM' },
  { game_id: 'g2', game_date: TODAY, away_team: 'Boston Red Sox', home_team: 'Baltimore Orioles', start_time: CARDS[1].start_time, status: 'Scheduled', park_id: 'BAL' }
  /* GAME 3 HAS NO games ROW ON PURPOSE: the per-game feature join misses, and
     the brief must say so rather than silently showing a thinner page. */
];
const PITCHER_FEATURES = [
  { game_id: 'g1', side: 'away', pitcher_id: 543037, name: 'Gerrit Cole', xera: 3.21, k_pct: 0.298, bb_pct: 0.061, barrel_pct: 0.072, hardhit_pct: 0.383, era: 3.41, whip: 1.06, fip: 3.12, hr_per_9: 1.05, whiff_pct: 0.311, xwoba_against: 0.279 },
  { game_id: 'g1', side: 'home', pitcher_id: 554430, name: 'Zack Wheeler', xera: 2.94, k_pct: 0.284, bb_pct: 0.052, barrel_pct: 0.061, hardhit_pct: 0.361, era: 2.88, whip: 0.98, fip: 2.91, hr_per_9: 0.84, whiff_pct: 0.296, xwoba_against: 0.262 }
];
const OFFENSE_FEATURES = [
  { game_id: 'g1', side: 'away', obp: 0.331, iso: 0.191, k_pct: 0.221, runs_per_game: 4.82, avg: 0.251, slg: 0.442, ops: 0.773, bb_pct: 0.091 },
  { game_id: 'g1', side: 'home', obp: 0.318, iso: 0.164, k_pct: 0.243, runs_per_game: 4.31, avg: 0.244, slg: 0.408, ops: 0.726, bb_pct: 0.082 }
];
const TEAM_SEASON = [
  { team: 'New York Yankees', runs_per_game: 4.82, ops: 0.773, k_pct: 0.221, hr_per_game: 1.41, woba: 0.327, barrel_pct: 0.091, hardhit_pct: 0.421, ra_per_game: 3.98, as_of: TODAY },
  { team: 'New York Mets', runs_per_game: 4.31, ops: 0.726, k_pct: 0.243, hr_per_game: 1.18, woba: 0.312, barrel_pct: 0.081, hardhit_pct: 0.398, ra_per_game: 4.12, as_of: TODAY },
  { team: 'Boston Red Sox', runs_per_game: 4.55, ops: 0.751, k_pct: 0.232, hr_per_game: 1.24, woba: 0.319, barrel_pct: 0.086, hardhit_pct: 0.411, ra_per_game: 4.41, as_of: TODAY },
  /* BALTIMORE IS ABSENT ON PURPOSE — the one-sided table must say so. */
  { team: 'Los Angeles Dodgers', runs_per_game: 5.11, ops: 0.798, k_pct: 0.214, hr_per_game: 1.52, woba: 0.338, barrel_pct: 0.098, hardhit_pct: 0.433, ra_per_game: 3.71, as_of: TODAY },
  { team: 'San Francisco Giants', runs_per_game: 4.02, ops: 0.698, k_pct: 0.248, hr_per_game: 1.02, woba: 0.301, barrel_pct: 0.074, hardhit_pct: 0.385, ra_per_game: 4.05, as_of: TODAY }
];
const PITCHER_SEASON = [
  /* A DOWN YEAR AGAINST A STRONG CAREER. Cole's archive ERA is 3.08 across
     2016-2025 and he is at 4.35 this season. That is the exact shape a reader
     is most tempted to average, so the brief must print both and say in words
     that they are two separately measured periods. */
  { name: 'Gerrit Cole', team: 'NYY', games_started: 28, ip: 172.1, era: 4.35, fip: 3.55, whip: 1.28, k_bb_pct: 0.198, hr_per9: 1.41, as_of: TODAY },
  { name: 'Zack Wheeler', team: 'NYM', games_started: 30, ip: 189.2, era: 2.88, fip: 2.91, whip: 0.98, k_bb_pct: 0.232, hr_per9: 0.84, as_of: TODAY },
  /* BRAYAN BELLO carries an ERA far above his FIP: the panel must call that a
     gap between two computed numbers, not a skill claim. */
  { name: 'Brayan Bello', team: 'BOS', games_started: 26, ip: 148.0, era: 4.78, fip: 3.79, whip: 1.34, k_bb_pct: 0.121, hr_per9: 1.22, as_of: TODAY },
  { name: 'Logan Webb', team: 'SF', games_started: 31, ip: 198.1, era: 3.02, fip: 3.18, whip: 1.11, k_bb_pct: 0.178, hr_per9: 0.71, as_of: TODAY },
  { name: 'Luis Garcia', team: 'LAD', games_started: 22, ip: 121.2, era: 4.10, fip: 4.02, whip: 1.25, k_bb_pct: 0.145, hr_per9: 1.31, as_of: TODAY }
];
/* The archive's rows are built from their own totals rather than typed out,
   because the published columns ARE derived that way: a fixture with a
   hand-written ERA could disagree with its own innings and the test would
   still pass. `era`, `whip` and the rate columns here are the same arithmetic
   the importer publishes. */
function ovInn(outs) { return Math.floor(outs / 3) + '.' + (outs % 3); }
function ov(id, name, teams, s0, s1, g, gs, outs, h, er, hr, k, bb, bf, wpi) {
  const ip = outs / 3, seasons = [];
  for (let y = s0; y <= s1; y++) seasons.push(y);
  return { player_id: id, player_name: name, name_key: EDMlbPitchers.nameKey(name),
    games: g, starts: gs, outs: outs, wins: 0, losses: 0, saves: 0, holds: 0,
    hits: h, earned_runs: er, home_runs: hr, strikeouts: k, walks: bb, hit_batters: 0, batters_faced: bf,
    innings_display: ovInn(outs), innings_decimal: Math.round(ip * 100) / 100,
    era: Math.round(9 * er / ip * 100) / 100, whip: Math.round((h + bb) / ip * 100) / 100,
    k_per_9: Math.round(9 * k / ip * 100) / 100, bb_per_9: Math.round(9 * bb / ip * 100) / 100,
    hr_per_9: Math.round(9 * hr / ip * 100) / 100,
    k_pct: Math.round(k / bf * 10000) / 10000, bb_pct: Math.round(bb / bf * 10000) / 10000,
    k_minus_bb_pct: Math.round((k - bb) / bf * 10000) / 10000,
    role: gs > g / 2 ? 'starter' : 'reliever', sample_flag: null,
    first_observed_season: s0, last_observed_season: s1, seasons_with_appearances: seasons.length,
    observed_seasons: seasons.join(','), boundary_start: s0 === 2016, boundary_end: s1 === 2025,
    weighted_performance_index: wpi, latest_observed_performance_index: wpi,
    latest_observed_role: gs > g / 2 ? 'starter' : 'reliever', best_season_by_index: s1,
    team_count: teams.split(',').length, teams: teams, rating_version: 'ED_PITCH_PERF_V1' };
}
function sn(id, name, season, g, gs, outs, h, er, hr, k, bb, bf, idx) {
  const ip = outs / 3;
  return { player_id: id, player_name: name, season: season, age: null, position_reported: 'P',
    team_count: 1, team_ids: '', teams: '', games: g, starts: gs, outs: outs, wins: 0, losses: 0,
    saves: 0, holds: 0, blown_saves: 0, hits: h, runs: er, earned_runs: er, home_runs: hr,
    strikeouts: k, walks: bb, intentional_walks: 0, hit_batters: 0, batters_faced: bf, pitches: null,
    complete_games: 0, shutouts: 0,
    innings_display: ovInn(outs), innings_decimal: Math.round(ip * 100) / 100,
    era: Math.round(9 * er / ip * 100) / 100, whip: Math.round((h + bb) / ip * 100) / 100,
    k_per_9: Math.round(9 * k / ip * 100) / 100, bb_per_9: Math.round(9 * bb / ip * 100) / 100,
    hr_per_9: Math.round(9 * hr / ip * 100) / 100,
    k_pct: Math.round(k / bf * 10000) / 10000, bb_pct: Math.round(bb / bf * 10000) / 10000,
    k_minus_bb_pct: Math.round((k - bb) / bf * 10000) / 10000,
    role: 'starter', sample_flag: null, league_era: 4.12, fip_constant: 3.15,
    fip: Math.round((13 * hr + 3 * bb - 2 * k) / ip * 100) / 100 + 3.15,
    performance_index: idx, rating_version: 'ED_PITCH_PERF_V1', rating_sample_weight: 0.8, provisional: false };
}
/* The archive: a completed 2016\u20132025 record. */
const HIST_OVERVIEW = [
  ov(543037, 'Gerrit Cole', 'PIT, HOU, NYY', 2016, 2025, 265, 263, 5121, 1382, 585, 218, 2015, 460, 6980, 122.4),
  ov(554430, 'Zack Wheeler', 'NYM, PHI', 2016, 2025, 238, 236, 4380, 1268, 510, 148, 1512, 371, 5980, 118.1),
  /* LUIS GARCIA APPEARS TWICE under one folded name — the real ambiguity in
     this dataset, an accent apart. It must be refused, not collapsed. */
  ov(605488, 'Luis Garcia', 'HOU', 2020, 2025, 92, 84, 1410, 402, 196, 61, 480, 141, 1940, 104.2),
  ov(472610, 'Luis Garc\u00eda', 'PHI, LAA, SD', 2016, 2023, 310, 0, 900, 271, 128, 33, 305, 118, 1290, 98.7),
  ov(657277, 'Logan Webb', 'SF', 2019, 2025, 175, 170, 3153, 991, 391, 78, 942, 251, 4280, 111.6),
  ov(686668, 'Brayan Bello', 'BOS', 2022, 2025, 82, 80, 1281, 448, 202, 48, 361, 141, 1870, 95.3)
];
const HIST_SEASONS = [
  sn(543037, 'Gerrit Cole', 2025, 26, 26, 480, 133, 62, 22, 170, 44, 655, 116.8),
  sn(554430, 'Zack Wheeler', 2025, 28, 28, 531, 141, 57, 16, 195, 40, 706, 124.2),
  sn(657277, 'Logan Webb', 2025, 32, 32, 612, 190, 72, 14, 178, 47, 826, 112.9),
  sn(686668, 'Brayan Bello', 2025, 27, 27, 441, 156, 74, 17, 124, 48, 641, 92.1)
];

/* ---- one sandbox, built the way the browser builds it ------------------ */
function build(opts) {
  opts = opts || {};
  const reads = [];
  function rows(rel) {
    reads.push(rel);
    const t = rel.split('?')[0];
    if (t === 'mlb_game_cards') return opts.noCards ? [] : CARDS.map(c => Object.assign({}, c));
    if (t === 'games') return GAMES.map(c => Object.assign({}, c));
    if (t === 'pitcher_features') return PITCHER_FEATURES.map(c => Object.assign({}, c));
    if (t === 'offense_features') return OFFENSE_FEATURES.map(c => Object.assign({}, c));
    if (t === 'team_season') return TEAM_SEASON.map(c => Object.assign({}, c));
    if (t === 'pitcher_season') return PITCHER_SEASON.map(c => Object.assign({}, c));
    return [];
  }
  const ctx = {
    console,
    Intl, Date, Math, JSON, Promise, String, Number, Object, Array, isFinite, parseFloat, parseInt, encodeURIComponent,
    setTimeout,
    sbGet: async rel => rows(rel),
    sbGetMlbHist: async rel => {
      reads.push('mlbhist:' + rel);
      if (opts.noArchive) { const e = new Error('PGRST106'); throw e; }
      const t = rel.split('?')[0];
      /* The promoted-import row the query layer reads its coverage from. It is
         the real view's shape, not a convenient subset: the layer refuses a
         window it cannot establish, and a stub that skipped this would hide
         that refusal. */
      if (t === 'dataset_status') return [{
        import_id: 'imp_test', status: 'promoted', coverage_start: 2016, coverage_end: 2025,
        provisional_seasons: [], rating_version: 'ED_PITCH_PERF_V1',
        dataset_built_at: '2026-01-05T00:00:00Z', source: 'MLB Stats API',
        promoted_at: '2026-01-05T00:10:00Z',
        promoted_counts: { pitcher_seasons: 8233 }, validation: null, source_repairs: null, transformations: null,
        live_pitcher_seasons: 8233, live_pitcher_team_seasons: 9212, live_pitchers: 2450
      }];
      if (t === 'meta') return [{ key: 'coverage_start', value: '2016' }, { key: 'coverage_end', value: '2025' }];
      if (t === 'pitcher_overview') return HIST_OVERVIEW.map(c => Object.assign({}, c));
      if (t === 'pitcher_seasons') return HIST_SEASONS.map(c => Object.assign({}, c));
      if (t === 'pitcher_team_seasons') return [];
      return [];
    },
    loadMlbSched: async () => {
      ctx.window.MLBPEN = opts.noBullpen ? {} : {
        147: [{ team_id: 147, full_name: 'Clay Holmes', flag: 'back-to-back', pitches_yesterday: 22, severity: 2 },
              { team_id: 147, full_name: 'Tommy Kahnle', flag: 'heavy', pitches_yesterday: 31, severity: 1 }],
        121: [{ team_id: 121, full_name: 'Edwin Diaz', flag: 'back-to-back', pitches_yesterday: 18, severity: 2 }]
      };
      ctx.window.MLBCL = opts.noBullpen ? {} : {
        147: { team_id: 147, closer_name: 'Luke Weaver', closer_flag: 'available' },
        121: { team_id: 121, closer_name: 'Edwin Diaz', closer_flag: 'back-to-back' }
      };
    }
  };
  /* IN A BROWSER `window` IS THE GLOBAL OBJECT, so `window.MLBB = {...}` also
     binds the bare identifier `MLBB` that the rest of the module reads. A
     sandbox whose `window` is a separate plain object does not, and the module
     would fail on its own first line. Pointing `window` at the context itself
     reproduces the browser's binding exactly, which is the only way this suite
     can run the SHIPPED source rather than a rewritten copy of it. */
  ctx.window = ctx;
  ctx.window.EDMlbPitchers = opts.noEngine ? null : EDMlbPitchers;
  ctx.window.EDBaseballParams = opts.noModel ? null : global.EDBaseballParams;
  ctx.window.EDBaseball = opts.noModel ? null : EDBaseball;
  ctx.window.EDGES = opts.noMarket ? [] : [
    { sport_key: 'baseball_mlb', event_id: 'ev1', away_team: 'New York Yankees', home_team: 'New York Mets',
      market: 'h2h', selection: 'New York Yankees', point: null, best_dec: 1.87, best_book: 'Pinnacle',
      n_books: 8, last_seen_at: new Date(Date.now() - 6 * 60000).toISOString(), commence_time: CARDS[0].start_time }
  ];
  ctx.window.D5_POOL = [];
  ctx.window.CONS_POOL = [];
  ctx.window.MODELP = opts.withModel ? {
    'ev1|h2h|nyy': { event_id: 'ev1', market: 'h2h', selection: 'New York Yankees', point: null,
      model_prob: 0.547, model_fair_american: -121, model_edge: 0.021, model_version: 'mlb_v0_research' }
  } : {};
  vm.createContext(ctx);
  vm.runInContext(MLBNORM + MLBORD + 'function stEsc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}\nfunction mlbhEsc(s){return stEsc(s==null?"":String(s));}\n' + SRC, ctx);
  return { ctx, reads };
}

/* =========================================================================
   1 — THE FULL-STRENGTH BRIEF
   ========================================================================= */
(async function () {
  const { ctx } = build({ withModel: true });
  await ctx.window.mlbBriefEnsure();
  const MLBB = ctx.window.MLBB;

  chk('the card loaded every game', MLBB.cards.length === 3, 'got ' + MLBB.cards.length);
  eq('the archive coverage was read', MLBB.coverage && MLBB.coverage.end, 2025);
  chk('the games join stamped a game_id where one exists', MLBB.cards[0].__game_id != null || MLBB.cards.some(c => c.__game_id != null));

  const res = ctx.window.fbMlbBriefGame({ away: 'New York Yankees', home: 'New York Mets' });
  chk('the brief was built', !!res, 'builder returned null');
  if (!res) { report(); return; }

  eq('it is an MLB payload', res.kind, 'MLB_GAME');

  /* --- the renderer's contract: every key it reads without checking --- */
  chk('advantages carries away', Array.isArray(res.advantages.away));
  chk('advantages carries home', Array.isArray(res.advantages.home));
  chk('advantages carries measured', Array.isArray(res.advantages.measured));
  chk('advantages carries unproven', Array.isArray(res.advantages.unproven));
  chk('notes is an array', Array.isArray(res.notes));
  chk('missing is an array', Array.isArray(res.missing));
  chk('uncertainty carries items and unmeasured',
    Array.isArray(res.uncertainty.items) && Array.isArray(res.uncertainty.unmeasured));
  chk('every panel carries cols, rows and reads',
    res.panels.every(p => Array.isArray(p.cols) && p.cols.length === 2 && Array.isArray(p.rows) && Array.isArray(p.reads)));
  chk('every compare cell is a value object or null',
    res.compare.groups.every(g => g.rows.every(r =>
      (r.a === null || (r.a && typeof r.a.v === 'string')) && (r.h === null || (r.h && typeof r.h.v === 'string')))));
  chk('every panel row value is a string or null, never an object',
    res.panels.every(p => p.rows.every(r => r.span
      ? typeof r.v === 'string'
      : ((r.a === null || typeof r.a === 'string') && (r.h === null || typeof r.h === 'string')))));

  /* --- IT RENDERS. The real renderer, not a reimplementation of it. --- */
  let html = '';
  chk('the shipped renderer draws it without throwing', () => { html = P.researchHTML(res); return html.length > 2000; });

  /* --- RULE 1: the projection is published and labelled, never sold --- */
  eq('the projection is published', res.projection.priced, true);
  chk('and it is the same object the board row rendered', () => {
    const row = ctx.window.mlbxRows().filter((r) => r.away === 'New York Yankees')[0];
    return row && row.ok
      && row.p.model.fair_total.toFixed(2) === res.projection.total
      && row.p.model.home_runs.toFixed(2) === res.projection.score.home.points;
  });
  has(html, 'EXPERIMENTAL', 'the projection is badged experimental');
  has(html, 'never graded against a closing line', 'and says it has never been graded');
  has(html, 'counted nowhere', 'and that it is counted nowhere');
  has(html, 'Projected score', 'the projected runs are shown');
  has(html, 'EdgeDesk fair total', 'the fair total is shown');
  has(html, 'Fair moneyline', 'the fair price is shown');
  has(html, 'Outcome range', 'and the distribution behind it');
  has(html, 'no game has ever ended', 'expected runs are not passed off as a predicted score');
  has(html, 'This model publishes no confidence score',
    'a confidence tile is never filled with a number nobody computed');
  has(html, 'mlb_v0_research', 'a separate server-side model row is still attributed');
  has(html, 'NOT the number shown above', 'and it is distinguished from the projection above it');
  chk('the model probability is never turned into an edge',
    html.indexOf('model_edge') < 0 && html.indexOf('+2.1%') < 0);
  {
    /* The same rule the board is held to. "Where each team has the edge" is a
       descriptive section about the two clubs and has always been there; what
       may never appear is a claim that THIS PROJECTION is an edge, so every
       "an edge" in the brief has to be a denial. */
    const denials = (html.match(/never an edge|rather than an edge|not an edge/g) || []).length;
    chk('the brief never claims an edge', (html.match(/\ban edge\b/g) || []).length === denials,
      JSON.stringify((html.match(/.{0,36}an edge.{0,16}/g) || []).slice(0, 4)));
  }

  /* --- RULE 2: a probable starter is never promoted --- */
  has(html, 'Probable, never confirmed', 'the starter row says probable');
  has(html, 'has no confirmed state', 'the panel note says the card has no confirmed state');
  has(html, 'Both are PROBABLE, not confirmed', 'the lede says probable');
  lacks(html, 'confirmed starter', 'nothing claims a confirmed starter');

  /* --- RULE 3: the archive is never blended with this season --- */
  has(html, 'This season', 'the season-to-date row is its own row');
  has(html, 'Career in the archive', 'the archive row is its own row');
  has(html, 'a completed record, not this season', 'the archive row is labelled as not current');
  has(html, '2016–2025', 'the archive window is stated');
  chk('the archive line and the season line are different rows',
    html.indexOf('This season') !== html.indexOf('Career in the archive'));
  /* Cole: 3.41 this season against 2.75 across the archive — the gap must be
     described as two separately measured periods, never as a trend. */
  has(html, 'Two different periods measured separately', 'a season-vs-archive gap is called two periods');
  has(html, 'the archive is not a forecast of the current season', 'the archive is not sold as a forecast');

  /* --- RULE 7: performance_index is never a price --- */
  has(html, 'where 100 is league', 'the index is explained as a descriptive scale');
  chk('the index never becomes a probability or a price',
    !/index[^<]{0,40}(implied|probability|fair|edge|%\s*to win)/i.test(html));

  /* --- the sections a baseball brief exists for --- */
  has(html, 'Starting pitching', 'the starting-pitching panel is drawn');
  has(html, 'Bullpen', 'the bullpen panel is drawn');
  has(html, 'Ballpark and weather', 'the park panel is drawn');
  has(html, 'Where the clubs are', 'the situation panel is drawn');
  has(html, 'flagged arms', 'the bullpen note says flagged arms only');
  has(html, 'not known to be fresh', 'an unflagged reliever is not called rested');
  has(html, 'applies NO park or weather adjustment', 'no park adjustment is claimed');
  has(html, 'Runs per game', 'the offense comparison is drawn');
  has(html, 'Runs allowed per game', 'run prevention is drawn');
  has(html, 'The matchups that matter', 'the matchups section is drawn');
  has(html, 'The case for New York Yankees', 'a case is built for the away club');
  has(html, 'The case for New York Mets', 'a case is built for the home club');
  has(html, 'Why the number could be wrong', 'uncertainty is drawn');
  has(html, 'Not measured at all', 'the unmeasured list is drawn');
  has(html, 'lineups', 'lineups are named as unmeasured');
  has(html, 'Batter-versus-pitcher history', 'BvP is named as unmeasured');
  has(html, 'Pitch mix, velocity', 'pitch mix is named as unmeasured');
  has(html, 'RESEARCH ONLY', 'the research state says research only');
  has(html, 'has never been graded against a closing line', 'the state says the model is ungraded');

  /* --- the market is last, and the comparison is the engine's own --- */
  has(html, 'Pinnacle', 'the captured book is named');
  chk('the market section classifies the comparison rather than declining it',
    /Research lean|Inside the review threshold|Data fault|Nothing joined to compare/.test(html),
    html.slice(html.indexOf('Pinnacle'), html.indexOf('Pinnacle') + 600));

  /* --- the sources are named --- */
  has(html, 'mlb_game_cards', 'the schedule source is named');
  has(html, 'pitcher_features', 'the per-game source is named');
  has(html, 'mlbhist archive', 'the archive source is named');
  has(html, 'nothing on this page was estimated', 'the source line claims no estimate');

  /* =======================================================================
     2 — THE HALF-STRENGTH BRIEF: gaps are named, never filled
     ======================================================================= */
  const half = ctx.window.fbMlbBriefGame({ away: 'Boston Red Sox', home: 'Baltimore Orioles' });
  chk('the half-strength brief was built', !!half);
  if (half) {
    const h2 = P.researchHTML(half);
    has(h2, 'have not posted a probable starter', 'a missing starter is named');
    has(h2, 'does not guess one', 'a missing starter is not guessed');
    has(h2, 'starter not posted', 'a missing starter is a HIGH uncertainty');
    has(h2, 'No Baltimore Orioles row in team_season', 'a missing club row is named');
    has(h2, 'this table is one-sided', 'the one-sided table says so');
    has(h2, 'No wind on file', 'a missing wind reading is named');
    has(h2, 'What EdgeDesk could not measure', 'the missing list is drawn');
    /* Bello: a 4.78 ERA against a 3.79 FIP. */
    has(h2, 'above', 'the ERA-FIP gap direction is stated');
    has(h2, 'fielding, sequencing and the balls in play are not separated',
      'the ERA-FIP gap is not sold as a skill claim');
    chk('a one-sided category is a measurement, never an edge',
      half.advantages.measured.length > 0 && half.advantages.away.length === 0 && half.advantages.home.length === 0);
    has(h2, 'measurement of one side rather than a comparison', 'the one-sided read says so');
    has(h2, 'the SIZE of any gap is not established', 'the unproven size is named');
    /* Camden with a 1.06 run factor: context, never an adjustment. */
    has(h2, 'not an adjustment EdgeDesk has applied', 'the park factor is context only');
  }

  /* =======================================================================
     3 — AN AMBIGUOUS NAME IS REFUSED, NOT GUESSED
     ======================================================================= */
  const amb = ctx.window.fbMlbBriefGame({ away: 'Los Angeles Dodgers', home: 'San Francisco Giants' });
  chk('the ambiguous brief was built', !!amb);
  if (amb) {
    const h3 = P.researchHTML(amb);
    has(h3, 'matches 2 pitchers', 'the ambiguity is counted');
    has(h3, 'EdgeDesk will not pick one', 'the ambiguity is refused');
    has(h3, 'shares a folded name', 'the refusal is explained in the panel');
    lacks(h3, 'Luis García', 'neither candidate is silently chosen');
    chk('no career line is attached to the ambiguous starter',
      amb.panels[0].rows.filter(r => r.k === 'Career in the archive').every(r => r.a === null));
    /* Webb is unambiguous and still gets his line in the same table. */
    chk('the unambiguous starter in the same game keeps his career line',
      amb.panels[0].rows.some(r => r.k === 'Career in the archive' && typeof r.h === 'string' && r.h.indexOf('2019') >= 0));
    /* This game has no games row, so the per-game join misses by design. */
    has(h3, 'could not be joined to a row in games', 'a missed per-game join is named');
  }

  /* =======================================================================
     4 — NO MARKET AND NO MODEL
     ======================================================================= */
  {
    const b = build({ noMarket: true });
    await b.ctx.window.mlbBriefEnsure();
    const r = b.ctx.window.fbMlbBriefGame({ away: 'New York Yankees', home: 'New York Mets' });
    const h = P.researchHTML(r);
    eq('with no capture the market is unavailable', r.market.available, false);
    has(h, 'No sportsbook price is joined', 'an unpriced game says so');
    has(h, 'does not depend on a price', 'the research is not gated on a book');
    /* THE PROJECTION IS NOT GATED ON A BOOK EITHER. It is the research; the
       price is what it would be compared against if one existed. */
    eq('an unpriced game still gets its projection', r.projection.priced, true);
    has(h, 'the projection stands without one', 'and the market section says the projection stands without a price');
    chk('but no comparison is claimed',
      r.market.difference == null || r.market.difference === '\u2014');
    chk('a model row is never claimed without a joined event id',
      (r.projection.status_note || '').indexOf('model probability is also on file') < 0);
    /* THE RESEARCH IS STILL THERE. This is the whole point of the change. */
    has(h, 'Starting pitching', 'an unpriced game still gets the pitching panel');
    has(h, 'Runs per game', 'an unpriced game still gets the offense comparison');
  }

  /* =======================================================================
     5 — THE BOARD DOES NOT DEPEND ON THE ARCHIVE
     ======================================================================= */
  {
    const b = build({ noArchive: true });
    await b.ctx.window.mlbBriefEnsure();
    const M = b.ctx.window.MLBB;
    eq('with no archive the card still loaded', M.cards.length, 3);
    /* PGRST106 is PostgREST's "schema not exposed" refusal, and the query layer
       names it NOT_INSTALLED rather than flattening it to a generic failure —
       the two send a reader to different fixes. */
    eq('the archive read is reported as not installed', M.read.mlbhist, 'NOT_INSTALLED');
    const r = b.ctx.window.fbMlbBriefGame({ away: 'New York Yankees', home: 'New York Mets' });
    chk('with no archive the brief is still built', !!r);
    const h = P.researchHTML(r);
    has(h, 'Starting pitching', 'the pitching panel survives a missing archive');
    has(h, 'This season', 'the season line survives a missing archive');
    lacks(h, 'Career in the archive', 'no career row is drawn when there is no archive');
    const board = b.ctx.window.mlbhGamesHTML();
    has(board, 'New York Yankees', 'the board lists a game with no archive installed');
    has(board, 'Game brief', 'the board still offers the brief');
  }
  {
    const b = build({ noEngine: true });
    await b.ctx.window.mlbBriefEnsure();
    eq('with no query layer at all the card still loaded', b.ctx.window.MLBB.cards.length, 3);
    eq('the archive is reported as not installed', b.ctx.window.MLBB.read.mlbhist, 'NOT_INSTALLED');
    const r = b.ctx.window.fbMlbBriefGame({ away: 'New York Yankees', home: 'New York Mets' });
    chk('with no query layer the brief is still built', !!r);
    chk('the board still renders', () => b.ctx.window.mlbhGamesHTML().indexOf('Game brief') >= 0);
  }

  /* =======================================================================
     6 — NO BULLPEN FLAGS IS NOT "BOTH STAFFS RESTED"
     ======================================================================= */
  {
    const b = build({ noBullpen: true });
    await b.ctx.window.mlbBriefEnsure();
    const r = b.ctx.window.fbMlbBriefGame({ away: 'New York Yankees', home: 'New York Mets' });
    const h = P.researchHTML(r);
    chk('no bullpen panel is drawn when nothing is flagged', !r.panels.some(p => p.title === 'Bullpen'));
    has(h, 'it is not a statement that both staffs are rested', 'an empty bullpen read is not read as rested');
  }

  /* =======================================================================
     7 — THE BOARD ITSELF
     ======================================================================= */
  {
    const board = ctx.window.mlbhGamesHTML();
    has(board, 'New York Yankees', 'the board lists the first game');
    has(board, 'Boston Red Sox', 'the board lists the second game');
    has(board, 'Los Angeles Dodgers', 'the board lists the third game');
    chk('every game on the card gets a row', (board.match(/class="mlbb-row"/g) || []).length === 3);
    has(board, 'Gerrit Cole', 'a probable starter is shown on the row');
    has(board, 'starter not posted', 'an unposted starter says so rather than being guessed');
    has(board, 'never been graded against a closing line',
      'the board says its projection is unvalidated');
    has(board, 'priced', 'a game with a capture is chipped as priced');
    has(board, 'no price', 'a game with no capture is chipped as unpriced');
    chk('every row opens a brief', (board.match(/mlbbOpenBrief\(/g) || []).length === 3);
    /* THE INVARIANT HAS NOT MOVED, ONLY THE WORDING AROUND IT. The board now
       carries a projection and a fair price, which it did not before; what it
       still must never do is call any of it an edge. The only lowercase
       "edge" allowed on this board is the sentence denying one. */
    chk('the board never prints a win probability as a claim',
      !/\d+(\.\d+)?%\s*to win/i.test(board));
    {
      /* the engine's own version identifier is lowercase and is not a claim */
      const words = board.replace(/edgedesk_baseball_v[\d.]+/g, '');
      chk('the board never claims an edge',
        (words.match(/edge/g) || []).length === (words.match(/never an edge/g) || []).length,
        'lowercase "edge" occurrences: ' + JSON.stringify((words.match(/.{0,40}edge.{0,20}/g) || []).slice(0, 4)));
    }

    /* ---- the projection the board exists to carry ---- */
    has(board, 'class="nm"', 'every row carries the numbers column');
    has(board, '>Model<', 'the row labels the model total');
    has(board, '>Market<', 'the row labels the market total');
    has(board, '>Gap<', 'the row labels the difference between them');
    has(board, 'mlbxSetFilter', 'the board can be filtered');
    has(board, 'mlbxSetSort', 'the board can be reordered');
    chk('a projection was produced for every game on the card',
      (board.match(/class="v mdl"/g) || []).length >= 3);
    has(board, 'fallback baseline',
      'a projection running on the published fallback baseline says so');

    const noModel = build({ noModel: true });
    await noModel.ctx.window.mlbBriefEnsure();
    const nb = noModel.ctx.window.mlbhGamesHTML();
    has(nb, 'The run model did not load', 'a page without the engine says so');
    has(nb, 'New York Yankees', 'and still lists every game');
    chk('and invents no projection in its place', (nb.match(/class="v mdl"/g) || []).length === 0);
    has(board, '90-60', 'records are carried on the row');
    has(board, 'Citi Field', 'the venue is carried on the row');

    const empty = build({ noCards: true });
    await empty.ctx.window.mlbBriefEnsure();
    const eb = empty.ctx.window.mlbhGamesHTML();
    has(eb, 'No MLB games on the card', 'an empty card says so');
    has(eb, 'that\nis the correct answer'.replace('\n', ' '), 'an empty card is not called an error');
  }

  /* =======================================================================
     8 — THE WIRING IN THE PAGE
     ======================================================================= */
  has(APP, "key.indexOf('baseball_mlb')===0 ? (window.fbMlbBriefGame||window.fbMlbBriefResearch)",
    'researchFor dispatches baseball to the MLB builder');
  has(APP, "if(String(q.sport_key||'').indexOf('baseball_mlb')===0 && window.mlbBriefEnsure",
    'openGame waits for the MLB card before drawing the brief');
  has(APP, "if(MLBH.seg==='games'){ host.innerHTML=mlbhGamesHTML(); return; }",
    'the games board is drawn before the archive gates');
  has(APP, "seg:'games'", 'the games board is the default segment');
  has(APP, 'onclick="mlbhSetSeg(\'games\')"><b>MLB card</b>', 'the panel offers the MLB card as a segment');
  has(APP, 'onclick="mlbhSetSeg(\'cbb\')"><b>College</b>', 'and the college card beside it');
  has(APP, 'mlbBriefBtn(e)', 'a priced MLB card carries a Game brief button');
  has(APP, 'key:(q&&q.key)||null', 'the board key travels with the brief request');
  chk('the brief builder is exported for the dispatch',
    APP.indexOf('window.fbMlbBriefGame=fbMlbBriefGame;') > 0);

  report();
})().catch(e => { console.log('FAIL | the suite threw: ' + (e && e.stack || e)); process.exit(1); });

function report() {
  if (fail) {
    console.log('\nFAIL | MLB game brief: ' + pass + ' passed, ' + fail + ' failed\n');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('MLB games board and game brief: ' + pass + ' passed, 0 failed');
  console.log('PASS | mlb games board and game brief | ' + pass + ' assertions');
}
