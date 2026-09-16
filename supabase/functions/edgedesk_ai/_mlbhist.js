// deno-lint-ignore-file
/* ============================================================================
   EdgeDesk MLB HISTORY — the desk's access to the 2016–2025 pitching record.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   It carries the shared query layer (lib/mlb_pitcher_history.js, copied in
   between the EDMLBQ markers below) so the number a chat answer quotes is
   produced by the same code the pitcher profile page renders and the feature
   build reads. Three implementations of "what is his K-BB%" is three answers.

   WHAT THIS GIVES THE MODEL

     Seven tools over real rows, with typed inputs, a budget and an allowlist,
     registered into the SAME EDRESEARCH.TOOLS registry every other tool lives
     in — so runTool's envelope, budget and allowlist govern them unchanged:

       resolve_mlb_player           name or id -> one MLB id, or the candidates
       get_pitcher_overview         the career window and the latest season in it
       get_pitcher_season_history   season by season, with year-over-year change
       get_pitcher_team_history     performance for each club, and the gaps
       compare_pitchers             two to four, on one named season or range
       search_pitcher_leaderboard   a season board with role and workload filters
       get_game_pitcher_context     the starters on a card, with their history

     AND a deterministic retrieval pass that runs WITHOUT the model's tool
     loop. The loop is off by default in this project, so a historical question
     would otherwise reach the model with nothing retrieved at all. The router
     below reads the question, resolves the pitchers, fetches exactly the
     records that question needs and attaches them to the turn as evidence.
     The model explains rows it was handed; it never produces them.

   THE RULES THIS FILE ENFORCES

     - Deterministic first. Every ranking, difference, filter and aggregate is
       computed in code. The model's job is to say what the rows mean.
     - Never the current season. This archive ends where the dataset ends and
       every block says so. The most recent club in it is not tonight's club,
       and nothing here upgrades a probable starter to a confirmed one.
     - Four nothings, four answers. An unresolvable name, an ambiguous name, a
       player with no rows in the window and a genuinely undefined value are
       different sentences, and the critic checks the prose kept them apart.
     - The rating is descriptive. performance_index is ED_PITCH_PERF_V1 with
       100 as league average; it is never converted to a probability, a fair
       price or an edge, and the critic rejects prose that does.
     - Follow-ups carry ids, not names. "Now compare him to the other starter"
       resolves against the ids this conversation already established.
   ============================================================================ */
/*__EDMLBHIST_START__*/
/*__EDMLBQ_START__*/
(function (root, factory) {
  var api = factory();
  root.EDMlbPitchers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'mlb-pitcher-history-1.0';
  var SCHEMA = 'mlbhist';
  var RATING_VERSION = 'ED_PITCH_PERF_V1';
  var SOURCE = 'MLB Stats API (statsapi.mlb.com/api/v1), regular season, sport 1, game type R';

  /* The rating, in the terms the package states it in. Everything that shows a
     performance_index is expected to show this alongside; the AI prints it and
     the profile page renders it under the number. */
  var RATING = {
    version: RATING_VERSION,
    scale: '100 = MLB league average for that season; higher is better.',
    formula: 'performance_index = 100 + 100 * (IP/(IP+40)) * (1 - (0.70*FIP + 0.30*ERA) / league_ERA)',
    shrinkage: 'IP/(IP+40). A one-inning score near 100 is shrinkage, not evidence of average ability.',
    is_not: ['a percentile', 'a 0-100 grade', 'WAR', 'ERA+', 'a win probability', 'a validated forecast'],
    caveats: [
      'Not park-adjusted and not opponent-adjusted.',
      'One common MLB baseline for every role; starters and relievers are not rated against separate baselines.',
      'The weights (0.70 FIP / 0.30 ERA) are explicit design choices, not fitted.',
      'All walks, intentional included, enter the FIP used here.'
    ]
  };

  /* Four different nothings. A caller that cannot tell them apart says "no
     data" to a user whose question was answerable, or invents a reason. */
  var OUTCOMES = {
    OK: 'OK',
    UNRESOLVED_PLAYER: 'UNRESOLVED_PLAYER',       // the name matched nobody in the archive
    AMBIGUOUS_PLAYER: 'AMBIGUOUS_PLAYER',         // the name matched more than one MLB id
    NO_RECORDS_IN_WINDOW: 'NO_RECORDS_IN_WINDOW', // resolved, but no appearances inside coverage
    EMPTY_RESULT: 'EMPTY_RESULT',                 // the filter excluded everything
    QUERY_UNAVAILABLE: 'QUERY_UNAVAILABLE',       // the read failed or the contract is not installed
    NOT_INSTALLED: 'NOT_INSTALLED'                // supabase/mlb_pitcher_history.sql has not been run
  };

  /* Hard caps. A question can never ask for the database: the archive is
     8,233 pitcher-seasons and 9,212 team-seasons, and neither a prompt nor a
     phone gets to receive them. */
  var LIMITS = {
    search: 12,
    resolve_candidates: 8,
    seasons: 20,          // ten seasons of history, with headroom for a wider window
    team_seasons: 40,
    team_history: 30,
    runs: 30,
    compare_players: 4,
    leaderboard: 200,
    leaderboard_default: 25,
    team_roster: 60
  };

  /* The metrics a leaderboard or a comparison may sort on, and which direction
     is better. A metric that is not on this list cannot be ordered by, so a
     caller cannot invent a ranking the data does not support. */
  var METRICS = {
    performance_index: { label: 'Performance index', better: 'higher', digits: 1, kind: 'rating' },
    era:               { label: 'ERA',               better: 'lower',  digits: 2, kind: 'rate' },
    fip:               { label: 'FIP',               better: 'lower',  digits: 2, kind: 'rate' },
    whip:              { label: 'WHIP',              better: 'lower',  digits: 2, kind: 'rate' },
    k_pct:             { label: 'K%',                better: 'higher', digits: 1, kind: 'pct' },
    bb_pct:            { label: 'BB%',               better: 'lower',  digits: 1, kind: 'pct' },
    k_minus_bb_pct:    { label: 'K-BB%',             better: 'higher', digits: 1, kind: 'pct' },
    k_per_9:           { label: 'K/9',               better: 'higher', digits: 2, kind: 'rate' },
    bb_per_9:          { label: 'BB/9',              better: 'lower',  digits: 2, kind: 'rate' },
    hr_per_9:          { label: 'HR/9',              better: 'lower',  digits: 2, kind: 'rate' },
    innings_decimal:   { label: 'Innings',           better: 'higher', digits: 1, kind: 'workload' },
    outs:              { label: 'Outs',              better: 'higher', digits: 0, kind: 'workload' },
    strikeouts:        { label: 'Strikeouts',        better: 'higher', digits: 0, kind: 'count' },
    walks:             { label: 'Walks',             better: 'lower',  digits: 0, kind: 'count' },
    games:             { label: 'Appearances',       better: 'higher', digits: 0, kind: 'count' },
    starts:            { label: 'Starts',            better: 'higher', digits: 0, kind: 'count' },
    saves:             { label: 'Saves',             better: 'higher', digits: 0, kind: 'count' },
    holds:             { label: 'Holds',             better: 'higher', digits: 0, kind: 'count' }
  };

  var ROLES = ['starter', 'reliever', 'mixed'];
  var SAMPLE_FLAGS = ['zero_outs', 'under_10_IP', '10_to_39_IP', '40_plus_IP'];

  /* ───────────────────────────── arithmetic ──────────────────────────────
     OUTS is the canonical workload measure. Baseball's innings notation is a
     display string: 6.2 is six innings and two outs, so 6.2 + 6.2 is thirteen
     innings and one out, not 12.4. Nothing in EdgeDesk adds innings_display. */

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function str(v) { return v == null ? '' : String(v); }
  function rnd(v, d) { var n = num(v); if (n == null) return null; var m = Math.pow(10, d == null ? 3 : d); return Math.round(n * m) / m; }

  /** outs -> decimal innings (outs/3). Null in, null out; never a zero. */
  function outsToInnings(outs) { var o = num(outs); return o == null ? null : rnd(o / 3, 6); }

  /** outs -> baseball notation: 20 outs is "6.2". */
  function inningsDisplay(outs) {
    var o = int(outs);
    if (o == null) return null;
    var whole = Math.floor(o / 3), rem = o % 3;
    return String(whole) + '.' + String(rem);
  }

  /** "6.2" -> 20 outs. Refuses a third digit, because .3 is not a thing. */
  function displayToOuts(display) {
    var s = str(display).trim();
    if (!s) return null;
    var m = /^(\d+)(?:\.(\d))?$/.exec(s);
    if (!m) return null;
    var frac = m[2] == null ? 0 : Number(m[2]);
    if (frac > 2) return null;
    return Number(m[1]) * 3 + frac;
  }

  /* Rates, each from outs and counting stats, each undefined at zero outs.
     A pitcher who recorded no outs has an infinite ERA in the arithmetic and
     no ERA in the record; the record is right. */
  function perOuts(count, outs, per) {
    var c = num(count), o = num(outs);
    if (c == null || o == null || o === 0) return null;
    return rnd(per * c / o, 6);
  }
  function eraOf(earnedRuns, outs) { return perOuts(earnedRuns, outs, 27); }
  function whipOf(walks, hits, outs) {
    var w = num(walks), h = num(hits), o = num(outs);
    if (w == null || h == null || o == null || o === 0) return null;
    return rnd(3 * (w + h) / o, 6);
  }
  function kPer9(k, outs) { return perOuts(k, outs, 27); }
  function bbPer9(bb, outs) { return perOuts(bb, outs, 27); }
  function hrPer9(hr, outs) { return perOuts(hr, outs, 27); }
  function ofFaced(count, faced) {
    var c = num(count), f = num(faced);
    if (c == null || f == null || f === 0) return null;
    return rnd(c / f, 6);
  }
  function kPct(k, faced) { return ofFaced(k, faced); }
  function bbPct(bb, faced) { return ofFaced(bb, faced); }
  function kMinusBbPct(k, bb, faced) {
    var a = num(k), b = num(bb), f = num(faced);
    if (a == null || b == null || f == null || f === 0) return null;
    return rnd((a - b) / f, 6);
  }

  /** FIP on the package's annual constant. Undefined at zero outs. */
  function fipOf(row, fipConstant) {
    var hr = num(row && row.home_runs), bb = num(row && row.walks),
        hbp = num(row && row.hit_batters), k = num(row && row.strikeouts),
        outs = num(row && row.outs), c = num(fipConstant);
    if (hr == null || bb == null || hbp == null || k == null || outs == null || c == null || outs === 0) return null;
    var ip = outs / 3;
    return rnd((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + c, 6);
  }

  /** The shrinkage weight, IP/(IP+40). Not a confidence probability. */
  function sampleWeight(outs) {
    var o = num(outs);
    if (o == null) return null;
    var ip = o / 3;
    return rnd(ip / (ip + 40), 6);
  }

  /** ED_PITCH_PERF_V1. Undefined wherever ERA, FIP or the league baseline is. */
  function performanceIndex(o) {
    var fip = num(o && o.fip), era = num(o && o.era), lg = num(o && o.league_era), outs = num(o && o.outs);
    if (fip == null || era == null || lg == null || outs == null || outs === 0 || lg === 0) return null;
    var w = outs / 3 / (outs / 3 + 40);
    return rnd(100 + 100 * w * (1 - (0.70 * fip + 0.30 * era) / lg), 6);
  }

  /** Descriptive role label, exactly as the package defines it. */
  function roleOf(games, starts) {
    var g = num(games), s = num(starts);
    if (g == null || s == null || g === 0) return null;
    if (s === 0) return 'reliever';
    return (s / g) >= 0.5 ? 'starter' : 'mixed';
  }

  /** Workload band. Told from outs, so it agrees with everything else here. */
  function sampleFlagOf(outs) {
    var o = num(outs);
    if (o == null) return null;
    if (o === 0) return 'zero_outs';
    var ip = o / 3;
    if (ip < 10) return 'under_10_IP';
    if (ip < 40) return '10_to_39_IP';
    return '40_plus_IP';
  }

  /* ───────────────────────────── identity ────────────────────────────────
     MLB player ids are the join key; names are for finding one. Accents are
     everywhere in this record (García, Peña, Sánchez, Jiménez) and a reader
     types them inconsistently, so folding is load-bearing rather than
     cosmetic. Jr./Sr./III are dropped from the key but kept in the name. */

  function nameKey(n) {
    var s = str(n);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* older runtime */ }
    return s.toLowerCase()
      .replace(/[‘’']/g, '')
      .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim().replace(/\s+/g, ' ');
  }
  function nameTokens(n) { var k = nameKey(n); return k ? k.split(' ') : []; }
  function surnameKey(n) { var t = nameTokens(n); return t.length ? t[t.length - 1] : ''; }
  /** A short display form: "G. Cole" for tight table cells. */
  function shortName(n) {
    var parts = str(n).trim().split(/\s+/);
    if (parts.length < 2) return str(n);
    return parts[0].charAt(0) + '. ' + parts.slice(1).join(' ');
  }

  /* ───────────────────────────── formatting ──────────────────────────────
     Shared so the page, the chat answer and a test all print a number the
     same way. A null is an em dash, never a zero and never "0.00". */

  function fmt(value, metric) {
    var n = num(value);
    if (n == null) return '—';
    var m = METRICS[metric];
    if (!m) return String(rnd(n, 2));
    if (m.kind === 'pct') return (n * 100).toFixed(m.digits) + '%';
    if (metric === 'innings_decimal') return n.toFixed(1);
    return n.toFixed(m.digits);
  }
  function fmtDelta(value, metric) {
    var n = num(value);
    if (n == null) return '—';
    var m = METRICS[metric];
    var body = m && m.kind === 'pct' ? (Math.abs(n) * 100).toFixed(m.digits) + 'pp'
      : Math.abs(n).toFixed(m ? m.digits : 2);
    if (n === 0) return '±0';
    return (n > 0 ? '+' : '−') + body;
  }
  /** Did this move the right way? null when the metric has no direction or a side is missing. */
  function improved(metric, from, to) {
    var m = METRICS[metric], a = num(from), b = num(to);
    if (!m || a == null || b == null || a === b) return null;
    if (m.better === 'higher') return b > a;
    if (m.better === 'lower') return b < a;
    return null;
  }

  /* ─────────────────────────── ERA against FIP ───────────────────────────
     The question is "was the ERA supported by the FIP underneath it", and the
     honest answer is a gap with a sample beside it, not a verdict. The bands
     are stated here once so the page and the desk use the same ones. */
  function eraFipGap(row) {
    var era = num(row && row.era), fip = num(row && row.fip);
    if (era == null || fip == null) return { gap: null, label: null, reason: 'ERA or FIP is undefined for this record' };
    var gap = rnd(era - fip, 3);
    var mag = Math.abs(gap);
    var band = mag < 0.25 ? 'in line' : mag < 0.75 ? 'moderate' : 'large';
    return {
      gap: gap,
      band: band,
      /* Direction in plain terms, and deliberately descriptive: a gap is a
         difference between two computed numbers, not a proven cause. */
      label: mag < 0.25 ? 'ERA and FIP agree'
        : gap > 0 ? 'ERA ran above FIP' : 'ERA ran below FIP',
      note: mag < 0.25
        ? 'The run prevention and the strikeout/walk/home-run profile point the same way.'
        : gap > 0
          ? 'Runs scored at a higher rate than the strikeout, walk and home-run profile alone implies. Fielding, sequencing and the balls in play are not separated here.'
          : 'Runs scored at a lower rate than the strikeout, walk and home-run profile alone implies. Fielding, sequencing and the balls in play are not separated here.'
    };
  }

  /* ─────────────────────────── query building ────────────────────────────
     Every read below is a PostgREST path against the mlbhist schema with an
     explicit column list and an explicit limit. Column lists matter as much as
     limits: `select=*` on pitcher_seasons is fifty columns of counting stats
     into a prompt, most of which the question never asked for. */

  function clampLimit(n, cap, dflt) {
    var v = int(n);
    if (v == null || v <= 0) return dflt;
    return Math.min(v, cap);
  }
  function enc(v) { return encodeURIComponent(String(v)); }
  /** PostgREST `in.(...)` with every value quoted, so a comma cannot split it. */
  function inList(values) {
    return '(' + (values || []).map(function (v) { return '"' + String(v).replace(/"/g, '') + '"'; }).join(',') + ')';
  }

  var COLS = {
    season: 'player_id,player_name,season,age,position_reported,team_count,team_ids,teams,'
      + 'games,starts,outs,wins,losses,saves,holds,blown_saves,hits,runs,earned_runs,home_runs,'
      + 'strikeouts,walks,intentional_walks,hit_batters,batters_faced,pitches,complete_games,shutouts,'
      + 'innings_display,innings_decimal,era,whip,k_per_9,bb_per_9,hr_per_9,k_pct,bb_pct,k_minus_bb_pct,'
      + 'role,sample_flag,league_era,fip_constant,fip,performance_index,rating_version,rating_sample_weight,provisional',
    /* The board is read for dozens of rows at a time, so it carries what a
       ranking needs and nothing else. */
    board: 'player_id,player_name,season,team_count,teams,games,starts,outs,innings_display,innings_decimal,'
      + 'era,fip,whip,k_pct,bb_pct,k_minus_bb_pct,k_per_9,bb_per_9,hr_per_9,saves,holds,strikeouts,walks,'
      + 'role,sample_flag,performance_index,rating_version,rating_sample_weight,provisional',
    teamSeason: 'player_id,player_name,season,team_id,team_name,position_reported,age,games,starts,outs,'
      + 'saves,holds,hits,runs,earned_runs,home_runs,strikeouts,walks,hit_batters,batters_faced,'
      + 'innings_display,innings_decimal,era,whip,k_per_9,bb_per_9,hr_per_9,k_pct,bb_pct,k_minus_bb_pct,'
      + 'role,sample_flag,fip,performance_index,rating_version,rating_sample_weight,source_url,provisional',
    overview: 'player_id,player_name,games,starts,outs,wins,losses,saves,holds,hits,earned_runs,home_runs,'
      + 'strikeouts,walks,hit_batters,batters_faced,innings_display,innings_decimal,era,whip,k_per_9,bb_per_9,'
      + 'hr_per_9,k_pct,bb_pct,k_minus_bb_pct,role,sample_flag,first_observed_season,last_observed_season,'
      + 'seasons_with_appearances,observed_seasons,boundary_start,boundary_end,weighted_performance_index,'
      + 'latest_observed_performance_index,latest_observed_role,best_season_by_index,team_count,teams,rating_version',
    teamHistory: 'player_id,player_name,team_id,team_names_observed,games,starts,outs,saves,holds,'
      + 'earned_runs,strikeouts,walks,batters_faced,innings_display,innings_decimal,era,whip,k_per_9,bb_per_9,'
      + 'hr_per_9,k_pct,bb_pct,k_minus_bb_pct,role,sample_flag,first_observed_season,last_observed_season,'
      + 'seasons_with_appearances,observed_seasons,boundary_start,boundary_end,weighted_performance_index',
    runs: 'player_id,player_name,team_id,observed_run_number,team_names_observed,games,starts,outs,'
      + 'innings_display,innings_decimal,era,whip,role,sample_flag,first_observed_season,last_observed_season,'
      + 'seasons_with_appearances,observed_seasons,weighted_performance_index',
    league: 'season,games,starts,outs,earned_runs,home_runs,strikeouts,walks,hit_batters,batters_faced,'
      + 'league_era,fip_constant,rating_version,provisional',
    teams: 'season,team_id,team_name,abbreviation,league,division',
    search: 'player_id,player_name,name_key,teams,team_count,first_observed_season,last_observed_season,'
      + 'seasons_with_appearances,outs,innings_display,role,latest_observed_role,weighted_performance_index'
  };

  /** Every query the layer can issue, as data. A test can read this list. */
  var QUERIES = {
    status: function () {
      return { rel: 'dataset_status', query: 'select=*&limit=1' };
    },
    playerByName: function (o) {
      var key = nameKey(o.name);
      var lim = clampLimit(o.limit, LIMITS.search, LIMITS.resolve_candidates);
      /* Exact fold first; the caller falls back to contains only when this is
         empty, so "Luis Garcia" does not drag in "Luis Garcia Jr" style noise
         before the exact match has had its chance. */
      return { rel: 'pitcher_overview', query: 'select=' + COLS.search + '&name_key=eq.' + enc(key)
        + '&order=outs.desc&limit=' + lim };
    },
    playerSearch: function (o) {
      var key = nameKey(o.q);
      var lim = clampLimit(o.limit, LIMITS.search, LIMITS.search);
      return { rel: 'pitcher_overview', query: 'select=' + COLS.search + '&name_key=ilike.' + enc('*' + key + '*')
        + '&order=outs.desc&limit=' + lim };
    },
    playersByIds: function (o) {
      var ids = (o.player_ids || []).slice(0, LIMITS.compare_players).map(int).filter(function (x) { return x != null; });
      return { rel: 'pitcher_overview', query: 'select=' + COLS.overview + '&player_id=in.(' + ids.join(',') + ')&limit=' + ids.length };
    },
    overview: function (o) {
      return { rel: 'pitcher_overview', query: 'select=' + COLS.overview + '&player_id=eq.' + int(o.player_id) + '&limit=1' };
    },
    seasons: function (o) {
      var q = 'select=' + COLS.season + '&player_id=eq.' + int(o.player_id);
      if (o.from != null) q += '&season=gte.' + int(o.from);
      if (o.to != null) q += '&season=lte.' + int(o.to);
      return { rel: 'pitcher_seasons', query: q + '&order=season.asc&limit=' + clampLimit(o.limit, LIMITS.seasons, LIMITS.seasons) };
    },
    seasonsForPlayers: function (o) {
      var ids = (o.player_ids || []).slice(0, LIMITS.compare_players).map(int).filter(function (x) { return x != null; });
      var q = 'select=' + COLS.season + '&player_id=in.(' + ids.join(',') + ')';
      if (o.from != null) q += '&season=gte.' + int(o.from);
      if (o.to != null) q += '&season=lte.' + int(o.to);
      return { rel: 'pitcher_seasons', query: q + '&order=player_id.asc,season.asc&limit=' + (LIMITS.seasons * Math.max(1, ids.length)) };
    },
    teamSeasons: function (o) {
      var q = 'select=' + COLS.teamSeason + '&player_id=eq.' + int(o.player_id);
      if (o.team_id != null) q += '&team_id=eq.' + int(o.team_id);
      return { rel: 'pitcher_team_seasons', query: q + '&order=season.asc,team_id.asc&limit=' + clampLimit(o.limit, LIMITS.team_seasons, LIMITS.team_seasons) };
    },
    teamHistory: function (o) {
      var q = 'select=' + COLS.teamHistory;
      if (o.player_id != null) q += '&player_id=eq.' + int(o.player_id);
      if (o.team_id != null) q += '&team_id=eq.' + int(o.team_id);
      var order = o.team_id != null ? 'outs.desc' : 'last_observed_season.desc,outs.desc';
      return { rel: 'pitcher_team_history', query: q + '&order=' + order + '&limit='
        + clampLimit(o.limit, LIMITS.team_roster, o.team_id != null ? LIMITS.team_roster : LIMITS.team_history) };
    },
    observedRuns: function (o) {
      var q = 'select=' + COLS.runs + '&player_id=eq.' + int(o.player_id);
      return { rel: 'observed_team_runs', query: q + '&order=first_observed_season.asc,observed_run_number.asc&limit=' + LIMITS.runs };
    },
    leaderboard: function (o) {
      var metric = METRICS[o.metric] ? o.metric : 'performance_index';
      var dir = o.order === 'asc' || (o.order == null && METRICS[metric].better === 'lower') ? 'asc' : 'desc';
      var q = 'select=' + COLS.board + '&season=eq.' + int(o.season);
      if (o.role && ROLES.indexOf(o.role) >= 0) q += '&role=eq.' + enc(o.role);
      var minOuts = minOutsFrom(o);
      if (minOuts != null) q += '&outs=gte.' + minOuts;
      if (o.exclude_position_players !== false) q += '&position_reported=eq.P';
      /* nullslast on both directions: an undefined ERA is not the best ERA. */
      return { rel: 'pitcher_seasons', query: q + '&' + metric + '=not.is.null&order=' + metric + '.' + dir + '.nullslast'
        + '&limit=' + clampLimit(o.limit, LIMITS.leaderboard, LIMITS.leaderboard_default) };
    },
    teamSeasonBoard: function (o) {
      var q = 'select=' + COLS.teamSeason + '&team_id=eq.' + int(o.team_id);
      if (o.season != null) q += '&season=eq.' + int(o.season);
      if (o.role && ROLES.indexOf(o.role) >= 0) q += '&role=eq.' + enc(o.role);
      var minOuts = minOutsFrom(o);
      if (minOuts != null) q += '&outs=gte.' + minOuts;
      return { rel: 'pitcher_team_seasons', query: q + '&order=season.desc,outs.desc&limit=' + clampLimit(o.limit, LIMITS.team_roster, LIMITS.team_roster) };
    },
    leagueSeasons: function (o) {
      var q = 'select=' + COLS.league;
      if (o && o.season != null) q += '&season=eq.' + int(o.season);
      return { rel: 'league_seasons', query: q + '&order=season.asc&limit=' + LIMITS.seasons };
    },
    teamsForSeason: function (o) {
      var q = 'select=' + COLS.teams;
      if (o && o.season != null) q += '&season=eq.' + int(o.season);
      if (o && o.team_id != null) q += '&team_id=eq.' + int(o.team_id);
      return { rel: 'teams', query: q + '&order=season.desc,team_name.asc&limit=' + (o && o.team_id != null ? LIMITS.seasons : 40) };
    },
    sourceRepairs: function (o) {
      var q = 'select=season,player_id,previous_team_rows,replacement_team_rows,source_url';
      if (o && o.player_id != null) q += '&player_id=eq.' + int(o.player_id);
      return { rel: 'source_repairs', query: q + '&order=season.asc&limit=100' };
    }
  };

  /** Minimum workload, expressed in innings by callers and in OUTS to the database. */
  function minOutsFrom(o) {
    if (o == null) return null;
    if (o.min_outs != null) { var mo = int(o.min_outs); return mo != null && mo > 0 ? mo : null; }
    var ip = num(o.min_innings);
    if (ip == null || ip <= 0) return null;
    return Math.ceil(ip * 3);
  }

  /* ─────────────────────────────── shaping ───────────────────────────────
     Rows in, structured answer out. Every shaper here is pure: give it the
     same rows and it returns the same object, which is what lets a test assert
     on a number the page renders and the desk quotes. */

  /** One season row, trimmed to what a reader or a prompt actually reads. */
  function shapeSeason(r) {
    if (!r) return null;
    return {
      player_id: int(r.player_id), player_name: str(r.player_name), season: int(r.season),
      age: int(r.age), position_reported: r.position_reported || null,
      teams: r.teams || null, team_count: int(r.team_count),
      team_ids: Array.isArray(r.team_ids) ? r.team_ids.map(int) : parseIdList(r.team_ids),
      games: int(r.games), starts: int(r.starts), outs: int(r.outs),
      innings: str(r.innings_display) || inningsDisplay(r.outs),
      innings_decimal: num(r.innings_decimal) != null ? rnd(r.innings_decimal, 2) : outsToInnings(r.outs),
      era: num(r.era), fip: num(r.fip), whip: num(r.whip),
      k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), k_minus_bb_pct: num(r.k_minus_bb_pct),
      k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9), hr_per_9: num(r.hr_per_9),
      strikeouts: int(r.strikeouts), walks: int(r.walks), home_runs: int(r.home_runs),
      hits: int(r.hits), earned_runs: int(r.earned_runs), batters_faced: int(r.batters_faced),
      saves: int(r.saves), holds: int(r.holds), wins: int(r.wins), losses: int(r.losses),
      role: r.role || null, sample_flag: r.sample_flag || null,
      performance_index: num(r.performance_index),
      rating_version: r.rating_version || RATING_VERSION,
      rating_sample_weight: num(r.rating_sample_weight),
      league_era: num(r.league_era), fip_constant: num(r.fip_constant),
      provisional: r.provisional === true,
      era_vs_fip: eraFipGap(r)
    };
  }

  function parseIdList(v) {
    if (v == null || v === '') return null;
    if (Array.isArray(v)) return v.map(int);
    var s = String(v).replace(/^[{[]|[}\]]$/g, '');
    if (!s) return null;
    return s.split(/[;,]/).map(function (x) { return int(x.trim()); }).filter(function (x) { return x != null; });
  }
  function parseSeasonList(v) {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) return v.map(int).filter(function (x) { return x != null; });
    return String(v).split(/[;,]/).map(function (x) { return int(x.trim()); }).filter(function (x) { return x != null; });
  }

  function shapeTeamSeason(r) {
    if (!r) return null;
    return {
      player_id: int(r.player_id), player_name: str(r.player_name), season: int(r.season),
      team_id: int(r.team_id), team_name: r.team_name || null,
      games: int(r.games), starts: int(r.starts), outs: int(r.outs),
      innings: str(r.innings_display) || inningsDisplay(r.outs),
      innings_decimal: num(r.innings_decimal) != null ? rnd(r.innings_decimal, 2) : outsToInnings(r.outs),
      era: num(r.era), fip: num(r.fip), whip: num(r.whip),
      k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), k_minus_bb_pct: num(r.k_minus_bb_pct),
      k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9), hr_per_9: num(r.hr_per_9),
      strikeouts: int(r.strikeouts), walks: int(r.walks), saves: int(r.saves), holds: int(r.holds),
      role: r.role || null, sample_flag: r.sample_flag || null,
      performance_index: num(r.performance_index),
      rating_sample_weight: num(r.rating_sample_weight),
      provisional: r.provisional === true,
      source_url: r.source_url || null,
      era_vs_fip: eraFipGap(r)
    };
  }

  function shapeOverview(r) {
    if (!r) return null;
    var seasons = parseSeasonList(r.observed_seasons);
    return {
      player_id: int(r.player_id), player_name: str(r.player_name),
      games: int(r.games), starts: int(r.starts), outs: int(r.outs),
      innings: str(r.innings_display) || inningsDisplay(r.outs),
      innings_decimal: num(r.innings_decimal) != null ? rnd(r.innings_decimal, 2) : outsToInnings(r.outs),
      era: num(r.era), fip: null, whip: num(r.whip),
      k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), k_minus_bb_pct: num(r.k_minus_bb_pct),
      k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9), hr_per_9: num(r.hr_per_9),
      strikeouts: int(r.strikeouts), walks: int(r.walks), saves: int(r.saves), holds: int(r.holds),
      wins: int(r.wins), losses: int(r.losses),
      role: r.role || null, sample_flag: r.sample_flag || null,
      first_observed_season: int(r.first_observed_season),
      last_observed_season: int(r.last_observed_season),
      seasons_with_appearances: int(r.seasons_with_appearances),
      observed_seasons: seasons,
      /* The years inside the observed span with NO appearance. A missed season
         is a fact the reader should see, not a gap silently closed. */
      missed_seasons: missedSeasons(seasons),
      boundary_start: r.boundary_start === true, boundary_end: r.boundary_end === true,
      weighted_performance_index: num(r.weighted_performance_index),
      latest_observed_performance_index: num(r.latest_observed_performance_index),
      latest_observed_role: r.latest_observed_role || null,
      best_season_by_index: int(r.best_season_by_index),
      team_count: int(r.team_count), teams: r.teams || null,
      rating_version: r.rating_version || RATING_VERSION
    };
  }

  function missedSeasons(seasons) {
    var s = (seasons || []).slice().sort(function (a, b) { return a - b; });
    if (s.length < 2) return [];
    var out = [];
    for (var y = s[0] + 1; y < s[s.length - 1]; y++) if (s.indexOf(y) < 0) out.push(y);
    return out;
  }

  function shapeTeamHistory(r) {
    if (!r) return null;
    var seasons = parseSeasonList(r.observed_seasons);
    return {
      player_id: int(r.player_id), player_name: str(r.player_name),
      team_id: int(r.team_id),
      team_names_observed: r.team_names_observed || null,
      games: int(r.games), starts: int(r.starts), outs: int(r.outs),
      innings: str(r.innings_display) || inningsDisplay(r.outs),
      innings_decimal: num(r.innings_decimal) != null ? rnd(r.innings_decimal, 2) : outsToInnings(r.outs),
      era: num(r.era), whip: num(r.whip),
      k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), k_minus_bb_pct: num(r.k_minus_bb_pct),
      k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9), hr_per_9: num(r.hr_per_9),
      strikeouts: int(r.strikeouts), walks: int(r.walks), saves: int(r.saves), holds: int(r.holds),
      role: r.role || null, sample_flag: r.sample_flag || null,
      first_observed_season: int(r.first_observed_season),
      last_observed_season: int(r.last_observed_season),
      seasons_with_appearances: int(r.seasons_with_appearances),
      observed_seasons: seasons,
      missed_seasons: missedSeasons(seasons),
      boundary_start: r.boundary_start === true, boundary_end: r.boundary_end === true,
      weighted_performance_index: num(r.weighted_performance_index),
      /* Stated every time this shape is produced, because "four seasons with
         the Yankees" reads like a contract and is not one. */
      tenure_note: 'Seasons with a recorded MLB pitching appearance for this club, not verified contract or roster dates.'
    };
  }

  /* Year-over-year change on the metrics the brief asks for. Consecutive
     OBSERVED seasons, not consecutive calendar years: a pitcher who missed
     2023 gets a 2022 -> 2024 comparison labelled with the gap rather than a
     silent one-year delta that never happened. */
  var YOY_METRICS = ['era', 'fip', 'whip', 'k_pct', 'bb_pct', 'k_minus_bb_pct', 'innings_decimal', 'performance_index'];

  function yearOverYear(seasonRows) {
    var rows = (seasonRows || []).slice().sort(function (a, b) { return int(a.season) - int(b.season); });
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1], cur = rows[i];
      var gap = int(cur.season) - int(prev.season);
      var changes = {};
      YOY_METRICS.forEach(function (m) {
        var a = num(prev[m]), b = num(cur[m]);
        changes[m] = {
          from: a, to: b,
          delta: (a == null || b == null) ? null : rnd(b - a, 4),
          improved: improved(m, a, b),
          undefined_reason: (a == null || b == null)
            ? (a == null && b == null ? 'undefined in both seasons'
              : a == null ? 'undefined in ' + int(prev.season) : 'undefined in ' + int(cur.season))
            : null
        };
      });
      out.push({
        from_season: int(prev.season), to_season: int(cur.season),
        consecutive: gap === 1,
        gap_seasons: gap > 1 ? gap - 1 : 0,
        note: gap > 1 ? 'No MLB pitching appearance in ' + missedBetween(prev.season, cur.season).join(', ')
          + '; this compares the two observed seasons either side of that gap.' : null,
        role_from: prev.role || null, role_to: cur.role || null,
        role_changed: !!(prev.role && cur.role && prev.role !== cur.role),
        teams_from: prev.teams || null, teams_to: cur.teams || null,
        team_changed: !!(prev.teams && cur.teams && String(prev.teams) !== String(cur.teams)),
        workload_outs_delta: (int(prev.outs) == null || int(cur.outs) == null) ? null : int(cur.outs) - int(prev.outs),
        shortened_season_involved: int(prev.season) === 2020 || int(cur.season) === 2020,
        changes: changes
      });
    }
    return out;
  }
  function missedBetween(a, b) {
    var out = [];
    for (var y = int(a) + 1; y < int(b); y++) out.push(y);
    return out;
  }

  /* A pitcher-versus-pitcher comparison on one explicitly named scope. The
     scope is part of the answer: "compare these two" is meaningless until the
     season or the range is said out loud. */
  var COMPARE_METRICS = ['innings_decimal', 'era', 'fip', 'whip', 'k_pct', 'bb_pct', 'k_minus_bb_pct',
    'k_per_9', 'bb_per_9', 'hr_per_9', 'performance_index'];

  function comparePitchers(sides, o) {
    o = o || {};
    var rows = (sides || []).filter(Boolean);
    var metrics = (o.metrics && o.metrics.length ? o.metrics : COMPARE_METRICS)
      .filter(function (m) { return METRICS[m]; });
    var table = metrics.map(function (m) {
      var values = rows.map(function (r) { return num(r[m]); });
      var defined = values.filter(function (v) { return v != null; });
      var best = null;
      if (defined.length === rows.length && rows.length > 1) {
        var dir = METRICS[m].better;
        var pick = dir === 'lower' ? Math.min.apply(null, values) : Math.max.apply(null, values);
        var winners = [];
        values.forEach(function (v, i) { if (v === pick) winners.push(i); });
        best = winners.length === 1 ? winners[0] : null;   // a tie has no winner
      }
      return {
        metric: m, label: METRICS[m].label, better: METRICS[m].better,
        values: values,
        formatted: values.map(function (v) { return fmt(v, m); }),
        better_index: best,
        /* Missing is named, never scored. Two pitchers cannot be compared on a
           metric one of them does not have. */
        comparable: defined.length === rows.length && rows.length > 1,
        note: defined.length === rows.length ? null : 'undefined for ' + rows.filter(function (r, i) { return values[i] == null; })
          .map(function (r) { return r.player_name; }).join(' and ')
      };
    });
    var samples = rows.map(function (r) {
      return { player_id: r.player_id, player_name: r.player_name, innings: r.innings,
        outs: r.outs, sample_flag: r.sample_flag, role: r.role,
        rating_sample_weight: r.rating_sample_weight != null ? r.rating_sample_weight : sampleWeight(r.outs) };
    });
    return {
      scope: o.scope || null,
      sides: rows.map(function (r) {
        return { player_id: r.player_id, player_name: r.player_name, season: r.season == null ? null : int(r.season),
          teams: r.teams || r.team_name || null, role: r.role, innings: r.innings, outs: r.outs,
          sample_flag: r.sample_flag, performance_index: num(r.performance_index),
          era_vs_fip: r.era_vs_fip || eraFipGap(r) };
      }),
      metrics: table,
      samples: samples,
      /* The comparison is descriptive. Saying which pitcher had the better
         number is arithmetic; saying which pitcher is better is not. */
      note: 'A side-by-side of recorded results over the scope named above. A better number in this table is a '
        + 'description of what happened, not a projection and not a statement about who is better now.',
      rating: RATING
    };
  }

  /* ─────────────────────────── envelope helpers ──────────────────────────
     Every service call answers with the same envelope: what it found, what
     window it found it in, how big the sample was, which rating version
     produced any index in it, and where the numbers came from. */

  function envelope(o) {
    o = o || {};
    return {
      ok: o.ok !== false,
      code: o.code || OUTCOMES.OK,
      coverage: o.coverage || null,
      rating_version: o.rating_version || RATING_VERSION,
      rating: o.rating === false ? undefined : RATING,
      sources: o.sources || [SOURCE],
      retrieved_at: o.retrieved_at || new Date().toISOString(),
      scope: o.scope || null,
      sample: o.sample || null,
      notes: o.notes || [],
      data: o.data === undefined ? null : o.data,
      error: o.error || null
    };
  }
  function failure(code, message, extra) {
    var e = envelope(Object.assign({ ok: false, code: code, data: null }, extra || {}));
    e.error = message;
    return e;
  }

  /* The sentence that has to travel with every historical answer. It is not
     decoration: the single most damaging thing this archive could do is be
     read as tonight's data. */
  function coverageNote(cov) {
    if (!cov) return 'Historical MLB regular-season record. Coverage window unknown until an import has been promoted.';
    var s = 'Historical MLB regular-season record, ' + cov.start + '–' + cov.end + '. ';
    s += 'This is not current-season data and says nothing about tonight’s club, availability or start assignment.';
    if (cov.provisional_seasons && cov.provisional_seasons.length) {
      s += ' ' + cov.provisional_seasons.join(', ') + ' ' + (cov.provisional_seasons.length === 1 ? 'is' : 'are')
        + ' provisional: imported before the regular season completed, so the ratings will change.';
    }
    return s;
  }

  /* ──────────────────────────────── service ──────────────────────────────
     A service is built over ONE injected read function, so the browser passes
     its authenticated fetch, the edge function passes its own reader and a
     test passes a fixture. Nothing here knows how the rows arrive.

       read(rel, query) -> Promise<Array<row>>   (throws on failure)

     An optional cache is used for the reads that repeat across a session: the
     coverage status, league baselines and the club table. Nothing player- or
     question-specific is cached here; the hosts have their own caches with
     their own lifetimes.  */

  function createService(opts) {
    opts = opts || {};
    var read = opts.read;
    if (typeof read !== 'function') throw new Error('createService needs a read(rel, query) function');
    var cache = opts.cache || simpleCache(opts.ttlMs || 10 * 60 * 1000);
    var statusTtl = opts.statusTtlMs || 5 * 60 * 1000;

    function classify(err) {
      var s = String((err && err.message) || err || '');
      var body = String((err && err.body) || '');
      if (/PGRST205|PGRST106|PGRST202|42P01|3F000|schema cache|does not exist|unknown schema/i.test(s + ' ' + body)) {
        return OUTCOMES.NOT_INSTALLED;
      }
      return OUTCOMES.QUERY_UNAVAILABLE;
    }
    function reason(err) {
      var s = String((err && err.message) || err || 'the read failed');
      if (classify(err) === OUTCOMES.NOT_INSTALLED) {
        return 'the mlb_pitcher_history contract is not installed in this database — run supabase/mlb_pitcher_history.sql '
          + 'once in the Supabase SQL editor and check that every row of its report reads ok';
      }
      return s;
    }
    async function q(spec) {
      var rows = await read(spec.rel, spec.query);
      return Array.isArray(rows) ? rows : [];
    }

    /* Coverage, read once and reused. Everything else depends on it, so a
       failure here is reported rather than swallowed: an answer with no
       coverage window is exactly the answer that gets mistaken for current. */
    async function status(force) {
      var hit = !force && cache.get('status');
      if (hit) return hit;
      try {
        var rows = await q(QUERIES.status());
        var r = rows[0];
        if (!r) {
          var none = { ok: false, code: OUTCOMES.NO_RECORDS_IN_WINDOW, coverage: null,
            detail: 'the schema is installed but no import has been promoted yet' };
          cache.set('status', none, 30 * 1000);
          return none;
        }
        var out = {
          ok: true, code: OUTCOMES.OK,
          coverage: {
            start: int(r.coverage_start), end: int(r.coverage_end),
            provisional_seasons: Array.isArray(r.provisional_seasons) ? r.provisional_seasons.map(int) : parseSeasonList(r.provisional_seasons),
            import_id: r.import_id || null,
            promoted_at: r.promoted_at || null,
            dataset_built_at: r.dataset_built_at || null,
            rating_version: r.rating_version || RATING_VERSION,
            source: r.source || SOURCE
          },
          counts: {
            pitcher_seasons: int(r.live_pitcher_seasons),
            pitcher_team_seasons: int(r.live_pitcher_team_seasons),
            pitchers: int(r.live_pitchers)
          },
          validation: r.validation || null,
          source_repairs: int(r.source_repairs),
          transformations: r.transformations || []
        };
        cache.set('status', out, statusTtl);
        return out;
      } catch (e) {
        return { ok: false, code: classify(e), coverage: null, detail: reason(e) };
      }
    }

    function withCoverage(st, o) {
      return Object.assign({ coverage: st && st.coverage ? st.coverage : null }, o || {});
    }
    function covNotes(st, extra) {
      var n = [coverageNote(st && st.coverage)];
      return extra && extra.length ? n.concat(extra) : n;
    }

    /* ---- identity ------------------------------------------------------- */

    /**
     * Resolve a player to one MLB id, or say honestly why not.
     * An explicit player_id wins. A name is folded and matched exactly first,
     * then by containment; two matches is AMBIGUOUS and the candidates come
     * back so the caller can ask rather than guess.
     */
    async function resolvePlayer(input) {
      input = input || {};
      var st = await status();
      if (st.code === OUTCOMES.NOT_INSTALLED || st.code === OUTCOMES.QUERY_UNAVAILABLE) {
        return failure(st.code, st.detail, { scope: 'resolve' });
      }
      try {
        if (input.player_id != null) {
          var byId = await q(QUERIES.overview({ player_id: input.player_id }));
          if (!byId.length) {
            return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
              'MLB id ' + int(input.player_id) + ' has no pitching appearance inside ' + covText(st),
              withCoverage(st, { scope: 'resolve', notes: covNotes(st) }));
          }
          return envelope(withCoverage(st, {
            scope: 'resolve', data: { resolved: shapeOverview(byId[0]), candidates: [], matched_on: 'player_id' },
            notes: covNotes(st)
          }));
        }
        var name = str(input.name).trim();
        if (!name) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'no name or MLB id was supplied', withCoverage(st, { scope: 'resolve' }));

        var exact = await q(QUERIES.playerByName({ name: name, limit: LIMITS.resolve_candidates }));
        var rows = exact, matchedOn = 'exact name';
        if (!rows.length) {
          rows = await q(QUERIES.playerSearch({ q: name, limit: LIMITS.resolve_candidates }));
          matchedOn = 'partial name';
        }
        if (!rows.length) {
          /* Last resort: a surname alone, which is what a reader usually types
             in a matchup question. Still never a silent pick. */
          var sn = surnameKey(name);
          if (sn && sn !== nameKey(name)) {
            rows = await q(QUERIES.playerSearch({ q: sn, limit: LIMITS.resolve_candidates }));
            matchedOn = 'surname';
          }
        }
        if (!rows.length) {
          return failure(OUTCOMES.UNRESOLVED_PLAYER,
            '“' + name + '” does not match any pitcher in the ' + covText(st) + ' archive',
            withCoverage(st, { scope: 'resolve',
              notes: covNotes(st, ['A pitcher who has never recorded an MLB pitching appearance in this window is '
                + 'absent by design; so is anyone whose only appearances fall outside it.']) }));
        }

        var narrowed = rows;
        /* A season or a club narrows an ambiguous name without guessing: both
           are facts the asker supplied, not inferences from the record. */
        if (rows.length > 1 && input.season != null) {
          var ids = rows.map(function (r) { return int(r.player_id); });
          var inSeason = await q({ rel: 'pitcher_seasons',
            query: 'select=player_id&season=eq.' + int(input.season) + '&player_id=in.(' + ids.join(',') + ')&limit=' + ids.length });
          var keep = {};
          inSeason.forEach(function (r) { keep[int(r.player_id)] = 1; });
          var f = rows.filter(function (r) { return keep[int(r.player_id)]; });
          if (f.length) { narrowed = f; matchedOn += ' + season ' + int(input.season); }
        }
        if (narrowed.length > 1 && input.team_id != null) {
          var ids2 = narrowed.map(function (r) { return int(r.player_id); });
          var onTeam = await q({ rel: 'pitcher_team_history',
            query: 'select=player_id&team_id=eq.' + int(input.team_id) + '&player_id=in.(' + ids2.join(',') + ')&limit=' + ids2.length });
          var keep2 = {};
          onTeam.forEach(function (r) { keep2[int(r.player_id)] = 1; });
          var f2 = narrowed.filter(function (r) { return keep2[int(r.player_id)]; });
          if (f2.length) { narrowed = f2; matchedOn += ' + club'; }
        }

        var candidates = narrowed.slice(0, LIMITS.resolve_candidates).map(function (r) {
          return {
            player_id: int(r.player_id), player_name: str(r.player_name),
            teams: r.teams || null, team_count: int(r.team_count),
            first_observed_season: int(r.first_observed_season),
            last_observed_season: int(r.last_observed_season),
            seasons_with_appearances: int(r.seasons_with_appearances),
            innings: r.innings_display || inningsDisplay(r.outs),
            outs: int(r.outs),
            role: r.latest_observed_role || r.role || null,
            weighted_performance_index: num(r.weighted_performance_index)
          };
        });

        if (candidates.length > 1) {
          return envelope(withCoverage(st, {
            ok: false, code: OUTCOMES.AMBIGUOUS_PLAYER, scope: 'resolve',
            error: '“' + name + '” matches ' + candidates.length + ' pitchers in this archive',
            data: { resolved: null, candidates: candidates, matched_on: matchedOn },
            notes: covNotes(st, ['MLB ids are the join key. Ask which one is meant, or supply a season or club; '
              + 'the busier pitcher is not automatically the intended one.'])
          }));
        }
        var full = await q(QUERIES.overview({ player_id: candidates[0].player_id }));
        return envelope(withCoverage(st, {
          scope: 'resolve',
          data: { resolved: shapeOverview(full[0] || narrowed[0]), candidates: [], matched_on: matchedOn },
          notes: covNotes(st)
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'resolve' }));
      }
    }

    function covText(st) {
      return st && st.coverage ? st.coverage.start + '–' + st.coverage.end : 'historical';
    }

    /** Free-text search for the pitcher pickers on the page. */
    async function search(input) {
      input = input || {};
      var st = await status();
      var term = str(input.q).trim();
      if (term.length < 2) return failure(OUTCOMES.EMPTY_RESULT, 'type at least two characters', withCoverage(st, { scope: 'search' }));
      try {
        var rows = await q(QUERIES.playerSearch({ q: term, limit: input.limit }));
        return envelope(withCoverage(st, {
          scope: 'search', code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          sample: { rows: rows.length },
          data: rows.map(function (r) {
            return {
              player_id: int(r.player_id), player_name: str(r.player_name), teams: r.teams || null,
              first_observed_season: int(r.first_observed_season), last_observed_season: int(r.last_observed_season),
              seasons_with_appearances: int(r.seasons_with_appearances),
              innings: r.innings_display || inningsDisplay(r.outs), outs: int(r.outs),
              role: r.latest_observed_role || r.role || null,
              weighted_performance_index: num(r.weighted_performance_index)
            };
          }),
          notes: covNotes(st)
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'search' }));
      }
    }

    /* ---- the record ----------------------------------------------------- */

    /** Career-window overview plus the latest observed season, in one read set. */
    async function pitcherOverview(input) {
      input = input || {};
      var st = await status();
      var id = int(input.player_id);
      if (id == null) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'a player_id is required', withCoverage(st, { scope: 'overview' }));
      try {
        var rows = await q(QUERIES.overview({ player_id: id }));
        if (!rows.length) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'MLB id ' + id + ' has no pitching appearance inside ' + covText(st),
            withCoverage(st, { scope: 'overview', notes: covNotes(st) }));
        }
        var ov = shapeOverview(rows[0]);
        var seasons = (await q(QUERIES.seasons({ player_id: id }))).map(shapeSeason);
        var latest = seasons.length ? seasons[seasons.length - 1] : null;
        var teams = (await q(QUERIES.teamHistory({ player_id: id }))).map(shapeTeamHistory);
        return envelope(withCoverage(st, {
          scope: 'career ' + (ov.first_observed_season || covText(st)) + '–' + (ov.last_observed_season || ''),
          sample: { seasons: seasons.length, innings: ov.innings, outs: ov.outs, sample_flag: ov.sample_flag,
            clubs: teams.length },
          data: {
            overview: ov,
            latest_observed_season: latest,
            teams: teams,
            /* Named explicitly so no caller has to derive it and get it wrong. */
            position_player_appearance: ov.starts === 0 && ov.outs != null && ov.outs < 30 && seasons.some(function (s) {
              return s.position_reported && s.position_reported !== 'P' && s.position_reported !== 'TWP';
            })
          },
          notes: covNotes(st, [
            latest ? 'Latest observed season is ' + latest.season + '. That is the last season in this archive with a '
              + 'recorded appearance — not a statement about his current club or role.' : null,
            ov.missed_seasons.length ? 'No MLB pitching appearance in ' + ov.missed_seasons.join(', ')
              + '. A missed season may be injury, the minors, another club or inactivity; this record does not say which.' : null
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'overview' }));
      }
    }

    /** Season-by-season history with the year-over-year change already computed. */
    async function seasonHistory(input) {
      input = input || {};
      var st = await status();
      var id = int(input.player_id);
      if (id == null) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'a player_id is required', withCoverage(st, { scope: 'season_history' }));
      try {
        var rows = (await q(QUERIES.seasons({ player_id: id, from: input.from, to: input.to }))).map(shapeSeason);
        if (!rows.length) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'no pitching appearance for MLB id ' + id + (input.from != null || input.to != null
              ? ' between ' + (int(input.from) || covText(st)) + ' and ' + (int(input.to) || covText(st)) : ' inside ' + covText(st)),
            withCoverage(st, { scope: 'season_history', notes: covNotes(st) }));
        }
        var yoy = yearOverYear(rows);
        var totalOuts = rows.reduce(function (a, r) { return a + (r.outs || 0); }, 0);
        return envelope(withCoverage(st, {
          scope: rows[0].season + '–' + rows[rows.length - 1].season,
          sample: { seasons: rows.length, outs: totalOuts, innings: inningsDisplay(totalOuts) },
          data: {
            player: { player_id: id, player_name: rows[0].player_name },
            seasons: rows,
            year_over_year: yoy,
            trend: trendSummary(rows)
          },
          notes: covNotes(st, [
            rows.some(function (r) { return r.season === 2020; })
              ? '2020 was a 60-game season. Its workload is not comparable with a full year and its rates sit on a smaller sample.' : null,
            yoy.some(function (y) { return !y.consecutive; })
              ? 'Some comparisons span a season with no appearance; each one says so.' : null
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'season_history' }));
      }
    }

    /** Performance for each club, with the observed runs that show the gaps. */
    async function teamHistory(input) {
      input = input || {};
      var st = await status();
      var id = int(input.player_id);
      if (id == null) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'a player_id is required', withCoverage(st, { scope: 'team_history' }));
      try {
        var clubs = (await q(QUERIES.teamHistory({ player_id: id }))).map(shapeTeamHistory);
        if (!clubs.length) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'no club record for MLB id ' + id + ' inside ' + covText(st),
            withCoverage(st, { scope: 'team_history', notes: covNotes(st) }));
        }
        var splits = (await q(QUERIES.teamSeasons({ player_id: id }))).map(shapeTeamSeason);
        var runs = (await q(QUERIES.observedRuns({ player_id: id }))).map(function (r) {
          return {
            team_id: int(r.team_id), run: int(r.observed_run_number),
            team_names_observed: r.team_names_observed || null,
            first_observed_season: int(r.first_observed_season),
            last_observed_season: int(r.last_observed_season),
            observed_seasons: parseSeasonList(r.observed_seasons),
            seasons_with_appearances: int(r.seasons_with_appearances),
            innings: r.innings_display || inningsDisplay(r.outs), outs: int(r.outs),
            era: num(r.era), whip: num(r.whip), role: r.role || null,
            weighted_performance_index: num(r.weighted_performance_index)
          };
        });
        /* Seasons split across two clubs, made explicit: this is the shape a
           traded pitcher has, and it is exactly the shape a naive sum ruins. */
        var traded = {};
        splits.forEach(function (s) { traded[s.season] = (traded[s.season] || 0) + 1; });
        var tradedSeasons = Object.keys(traded).filter(function (k) { return traded[k] > 1; }).map(Number).sort();
        return envelope(withCoverage(st, {
          scope: 'clubs ' + covText(st),
          sample: { clubs: clubs.length, club_seasons: splits.length, runs: runs.length },
          data: {
            player: { player_id: id, player_name: clubs[0].player_name },
            clubs: clubs, club_seasons: splits, observed_runs: runs,
            multi_club_seasons: tradedSeasons,
            repeat_clubs: runs.reduce(function (a, r) {
              var n = runs.filter(function (x) { return x.team_id === r.team_id; }).length;
              if (n > 1 && a.indexOf(r.team_id) < 0) a.push(r.team_id);
              return a;
            }, [])
          },
          notes: covNotes(st, [
            'Team duration here means seasons with a recorded MLB pitching appearance, not verified contract or roster dates.',
            tradedSeasons.length ? 'Split ' + (tradedSeasons.length === 1 ? 'season' : 'seasons') + ': ' + tradedSeasons.join(', ')
              + '. The club rows are that season’s parts; the season row is their sum. Never add the two together.' : null
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'team_history' }));
      }
    }

    /** Pitcher versus pitcher, on one named season or one named range. */
    async function compare(input) {
      input = input || {};
      var st = await status();
      var ids = (input.player_ids || []).map(int).filter(function (x) { return x != null; }).slice(0, LIMITS.compare_players);
      if (ids.length < 2) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'at least two player_ids are required',
        withCoverage(st, { scope: 'compare' }));
      try {
        var season = int(input.season);
        var from = int(input.from), to = int(input.to);
        var rows = await q(QUERIES.seasonsForPlayers({ player_ids: ids, from: season != null ? season : from, to: season != null ? season : to }));
        var byPlayer = {};
        rows.map(shapeSeason).forEach(function (r) { (byPlayer[r.player_id] = byPlayer[r.player_id] || []).push(r); });

        var missingIds = ids.filter(function (id) { return !byPlayer[id] || !byPlayer[id].length; });
        var sides = [], perSide = [];
        ids.forEach(function (id) {
          var list = byPlayer[id] || [];
          if (!list.length) return;
          perSide.push({ player_id: id, seasons: list });
          sides.push(season != null ? list[0] : aggregateSeasons(list));
        });
        if (sides.length < 2) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'fewer than two of these pitchers have a record for that scope'
            + (missingIds.length ? ' (no rows for MLB id ' + missingIds.join(', ') + ')' : ''),
            withCoverage(st, { scope: 'compare', notes: covNotes(st) }));
        }
        var scopeLabel = season != null ? String(season)
          : (from != null || to != null)
            ? (from != null ? from : covText(st).split('–')[0]) + '–' + (to != null ? to : covText(st).split('–')[1])
            : covText(st) + ' combined';
        var cmp = comparePitchers(sides, { scope: scopeLabel, metrics: input.metrics });
        return envelope(withCoverage(st, {
          scope: scopeLabel,
          sample: { sides: sides.length, seasons_each: perSide.map(function (p) { return { player_id: p.player_id, seasons: p.seasons.length }; }) },
          data: {
            comparison: cmp,
            per_side_seasons: perSide,
            missing_player_ids: missingIds
          },
          notes: covNotes(st, [
            'Compared scope: ' + scopeLabel + '.',
            season == null ? 'Multi-season sides are recomputed from summed counting statistics and OUTS; rates are not '
              + 'averages of season rates, and the index shown is the innings-weighted mean of the season ratings.' : null,
            missingIds.length ? 'No record inside the scope for MLB id ' + missingIds.join(', ') + '.' : null
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'compare' }));
      }
    }

    /** Season leaderboard, with role and minimum-workload filters. */
    async function leaderboard(input) {
      input = input || {};
      var st = await status();
      var season = int(input.season);
      if (season == null) return failure(OUTCOMES.EMPTY_RESULT, 'a season is required', withCoverage(st, { scope: 'leaderboard' }));
      if (st.coverage && (season < st.coverage.start || season > st.coverage.end)) {
        return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
          season + ' is outside the archive, which covers ' + covText(st),
          withCoverage(st, { scope: 'leaderboard', notes: covNotes(st) }));
      }
      var metric = METRICS[input.metric] ? input.metric : 'performance_index';
      var minOuts = minOutsFrom(input);
      try {
        var rows = (await q(QUERIES.leaderboard({
          season: season, role: input.role, metric: metric, order: input.order,
          min_outs: minOuts, limit: input.limit,
          exclude_position_players: input.exclude_position_players
        }))).map(shapeSeason);
        var lg = (await q(QUERIES.leagueSeasons({ season: season })))[0] || null;
        return envelope(withCoverage(st, {
          scope: String(season),
          code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          sample: { rows: rows.length, season: season, role: input.role || 'any',
            min_innings: minOuts == null ? null : rnd(minOuts / 3, 1) },
          data: {
            season: season, metric: metric, metric_label: METRICS[metric].label,
            better: METRICS[metric].better,
            order: input.order || (METRICS[metric].better === 'lower' ? 'asc' : 'desc'),
            role: input.role || null,
            min_innings: minOuts == null ? null : rnd(minOuts / 3, 1),
            min_outs: minOuts,
            rows: rows.map(function (r, i) { return Object.assign({ rank: i + 1 }, r); }),
            league_baseline: lg ? { season: int(lg.season), league_era: num(lg.league_era),
              fip_constant: num(lg.fip_constant), outs: int(lg.outs), provisional: lg.provisional === true } : null,
            truncated: rows.length >= clampLimit(input.limit, LIMITS.leaderboard, LIMITS.leaderboard_default)
          },
          notes: covNotes(st, [
            minOuts == null ? 'No minimum workload was applied, so short samples sit beside full seasons. The index is '
              + 'shrunk toward 100 by IP/(IP+40), which suppresses but does not remove small-sample extremes.'
              : 'Minimum ' + rnd(minOuts / 3, 1) + ' innings (' + minOuts + ' outs) applied.',
            season === 2020 ? '2020 was a 60-game season; a workload filter meant for a full year excludes most of it.' : null,
            input.exclude_position_players === false
              ? 'Position players who pitched are INCLUDED in this board.'
              : 'Position players who pitched are excluded (position_reported = P only). That field is the source-reported '
                + 'position, not a reconstructed historical roster classification.'
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'leaderboard' }));
      }
    }

    /** One club's pitching history: who threw for it, and how they did. */
    async function teamPitching(input) {
      input = input || {};
      var st = await status();
      var teamId = int(input.team_id);
      if (teamId == null) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'a team_id is required', withCoverage(st, { scope: 'team_pitching' }));
      try {
        var names = await q(QUERIES.teamsForSeason({ team_id: teamId }));
        var seasonRows = input.season != null || input.role || input.min_innings != null || input.min_outs != null
          ? (await q(QUERIES.teamSeasonBoard({ team_id: teamId, season: input.season, role: input.role,
              min_innings: input.min_innings, min_outs: input.min_outs, limit: input.limit }))).map(shapeTeamSeason)
          : [];
        var career = (await q(QUERIES.teamHistory({ team_id: teamId, limit: input.limit }))).map(shapeTeamHistory);
        if (!career.length && !seasonRows.length) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'no pitching record for club ' + teamId + ' inside ' + covText(st),
            withCoverage(st, { scope: 'team_pitching', notes: covNotes(st) }));
        }
        var seasonNames = {};
        names.forEach(function (t) { seasonNames[int(t.season)] = { team_name: t.team_name, abbreviation: t.abbreviation,
          league: t.league, division: t.division }; });
        var renamed = uniqueNames(names);
        return envelope(withCoverage(st, {
          scope: input.season != null ? String(int(input.season)) : covText(st),
          sample: { pitchers: career.length, club_seasons: seasonRows.length },
          data: {
            team_id: teamId,
            names_by_season: seasonNames,
            names_observed: renamed,
            season: input.season != null ? int(input.season) : null,
            role: input.role || null,
            min_innings: input.min_innings != null ? num(input.min_innings) : null,
            pitchers: career,
            club_seasons: seasonRows
          },
          notes: covNotes(st, [
            renamed.length > 1 ? 'This club appears under ' + renamed.length + ' names in the window ('
              + renamed.join(', ') + '); the MLB team id is stable across the change.' : null,
            'Contributions are the innings recorded FOR THIS CLUB. A pitcher traded mid-season appears here with his '
              + 'club portion only, never his combined season line.'
          ].filter(Boolean))
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'team_pitching' }));
      }
    }

    /**
     * Historical context for pitchers already attached to an upcoming game.
     *
     * The caller supplies who the card says is starting and WHAT THAT CLAIM IS
     * (confirmed / probable / projected). This never upgrades that status, and
     * it never reads a club assignment out of the archive: the most recent
     * historical club is a 2016-2025 fact and tonight's is not in this data.
     */
    async function gamePitcherContext(input) {
      input = input || {};
      var st = await status();
      var starters = (input.starters || []).slice(0, 4);
      if (!starters.length) {
        return failure(OUTCOMES.EMPTY_RESULT, 'no starters were supplied for this game',
          withCoverage(st, { scope: 'game_context' }));
      }
      var out = [];
      for (var i = 0; i < starters.length; i++) {
        var s = starters[i] || {};
        var declared = normaliseStarterStatus(s.status);
        var res = await resolvePlayer({ player_id: s.player_id, name: s.name, season: s.season, team_id: s.team_id });
        var entry = {
          side: s.side || null,
          named: str(s.name) || null,
          club_on_card: s.team || null,
          starter_status: declared.status,
          starter_status_note: declared.note,
          resolution: { code: res.code, matched_on: res.data && res.data.matched_on, candidates: (res.data && res.data.candidates) || [] },
          history: null
        };
        if (res.ok && res.data && res.data.resolved) {
          var id = res.data.resolved.player_id;
          var seasons = (await q(QUERIES.seasons({ player_id: id }))).map(shapeSeason);
          var recent = seasons.slice(-3);
          var clubs = (await q(QUERIES.teamHistory({ player_id: id }))).map(shapeTeamHistory);
          entry.history = {
            player_id: id, player_name: res.data.resolved.player_name,
            overview: res.data.resolved,
            recent_seasons: recent,
            latest_observed_season: seasons.length ? seasons[seasons.length - 1] : null,
            clubs: clubs.map(function (c) {
              return { team_id: c.team_id, team_names_observed: c.team_names_observed,
                seasons_with_appearances: c.seasons_with_appearances, observed_seasons: c.observed_seasons,
                innings: c.innings, era: c.era, weighted_performance_index: c.weighted_performance_index };
            }),
            year_over_year: yearOverYear(recent),
            profile_link: profileLink(id)
          };
        }
        out.push(entry);
      }
      var both = out.filter(function (e) { return e.history; });
      var comparison = null;
      if (both.length === 2) {
        var scopeSeason = int(input.compare_season);
        var sides = both.map(function (e) {
          if (scopeSeason != null) {
            var hit = (e.history.recent_seasons || []).filter(function (r) { return r.season === scopeSeason; })[0];
            return hit || null;
          }
          return e.history.latest_observed_season;
        });
        if (sides[0] && sides[1]) {
          var scopeLabel = scopeSeason != null ? String(scopeSeason)
            : sides[0].season === sides[1].season ? String(sides[0].season)
              : sides[0].season + ' and ' + sides[1].season + ' — latest observed season for each, which are NOT the same year';
          comparison = comparePitchers(sides, { scope: scopeLabel });
        }
      }
      return envelope(withCoverage(st, {
        scope: 'game context',
        sample: { starters: out.length, resolved: both.length },
        data: {
          game: input.game || null,
          starters: out,
          comparison: comparison
        },
        notes: covNotes(st, [
          'Starter status is carried from the card exactly as the card states it. This archive cannot confirm a start, '
            + 'a club or availability, and a pitcher’s most recent historical club is not evidence of tonight’s.',
          comparison ? 'The side-by-side above covers ' + comparison.scope + '.' : null,
          both.length < out.length ? 'Not every named starter resolved to the archive; each unresolved one says why.' : null
        ].filter(Boolean))
      }));
    }

    /** Year-over-year change alone, for the "how has he changed" question. */
    async function changes(input) {
      input = input || {};
      var hist = await seasonHistory(input);
      if (!hist.ok) return hist;
      var seasons = hist.data.seasons;
      var last = int(input.last_n_seasons);
      var used = last != null && last > 0 ? seasons.slice(-last) : seasons;
      var yoy = yearOverYear(used);
      return envelope({
        coverage: hist.coverage, scope: used.length ? used[0].season + '–' + used[used.length - 1].season : hist.scope,
        sample: { seasons: used.length },
        data: {
          player: hist.data.player,
          seasons: used,
          year_over_year: yoy,
          first: used[0] || null, last: used[used.length - 1] || null,
          net_change: netChange(used),
          trend: trendSummary(used)
        },
        notes: hist.notes
      });
    }

    async function leagueBaselines(input) {
      var st = await status();
      try {
        var rows = await q(QUERIES.leagueSeasons(input || {}));
        return envelope(withCoverage(st, {
          scope: covText(st), sample: { seasons: rows.length },
          data: rows.map(function (r) {
            return { season: int(r.season), league_era: num(r.league_era), fip_constant: num(r.fip_constant),
              outs: int(r.outs), innings: inningsDisplay(r.outs), strikeouts: int(r.strikeouts),
              walks: int(r.walks), batters_faced: int(r.batters_faced), provisional: r.provisional === true };
          }),
          notes: covNotes(st, ['The baseline includes position players who pitched, exactly as the rating formula requires.'])
        }));
      } catch (e) {
        return failure(classify(e), reason(e), withCoverage(st, { scope: 'league' }));
      }
    }

    return {
      VERSION: VERSION,
      status: status, resolvePlayer: resolvePlayer, search: search,
      pitcherOverview: pitcherOverview, seasonHistory: seasonHistory, teamHistory: teamHistory,
      compare: compare, leaderboard: leaderboard, teamPitching: teamPitching,
      gamePitcherContext: gamePitcherContext, changes: changes, leagueBaselines: leagueBaselines,
      /* exposed for the hosts' own diagnostics */
      _cache: cache, _read: read
    };
  }

  /* A starter's status is the card's claim, normalised but never promoted. */
  function normaliseStarterStatus(s) {
    var v = str(s).toLowerCase().trim();
    if (/confirm/.test(v)) return { status: 'CONFIRMED', note: 'The card reports this start as confirmed.' };
    if (/probable|listed|announced/.test(v)) return { status: 'PROBABLE', note: 'Probable, not confirmed. It can change up to first pitch.' };
    if (/project|expect|likely|tbd/.test(v)) return { status: 'PROJECTED', note: 'Projected, not announced by the club.' };
    if (!v) return { status: 'UNKNOWN', note: 'The card did not say whether this start is confirmed, probable or projected. Unknown is not confirmed.' };
    return { status: 'UNKNOWN', note: 'Unrecognised starter status “' + str(s) + '”; treated as unknown rather than confirmed.' };
  }

  /* Sum several season rows into one comparable side. Counting stats add; rates
     are recomputed from the sums; the index is innings-weighted, exactly as the
     package's own multi-year summaries define it. */
  function aggregateSeasons(rows) {
    var list = (rows || []).filter(Boolean);
    if (!list.length) return null;
    var sum = { outs: 0, games: 0, starts: 0, hits: 0, earned_runs: 0, home_runs: 0, strikeouts: 0,
      walks: 0, hit_batters: 0, batters_faced: 0, saves: 0, holds: 0 };
    var wIdx = 0, wOuts = 0;
    list.forEach(function (r) {
      Object.keys(sum).forEach(function (k) { var v = num(r[k]); if (v != null) sum[k] += v; });
      var pi = num(r.performance_index), o = num(r.outs);
      if (pi != null && o != null && o > 0) { wIdx += pi * o; wOuts += o; }
    });
    var seasons = list.map(function (r) { return int(r.season); }).sort(function (a, b) { return a - b; });
    var startsShare = sum.games ? sum.starts / sum.games : null;
    return {
      player_id: int(list[0].player_id), player_name: list[0].player_name,
      season: null, seasons: seasons,
      teams: uniqueJoin(list.map(function (r) { return r.teams; })),
      games: sum.games, starts: sum.starts, outs: sum.outs,
      innings: inningsDisplay(sum.outs), innings_decimal: outsToInnings(sum.outs),
      era: eraOf(sum.earned_runs, sum.outs), whip: whipOf(sum.walks, sum.hits, sum.outs),
      k_per_9: kPer9(sum.strikeouts, sum.outs), bb_per_9: bbPer9(sum.walks, sum.outs),
      hr_per_9: hrPer9(sum.home_runs, sum.outs),
      k_pct: kPct(sum.strikeouts, sum.batters_faced), bb_pct: bbPct(sum.walks, sum.batters_faced),
      k_minus_bb_pct: kMinusBbPct(sum.strikeouts, sum.walks, sum.batters_faced),
      strikeouts: sum.strikeouts, walks: sum.walks, home_runs: sum.home_runs,
      earned_runs: sum.earned_runs, hits: sum.hits, batters_faced: sum.batters_faced,
      saves: sum.saves, holds: sum.holds,
      /* FIP over a multi-season span would need one constant across several
         annual baselines, which is not a thing this package defines. Left
         undefined rather than invented. */
      fip: null,
      fip_note: 'FIP uses an ANNUAL league constant, so a multi-season FIP is not defined by this dataset. Compare FIP season by season.',
      role: startsShare == null ? null : sum.starts === 0 ? 'reliever' : startsShare >= 0.5 ? 'starter' : 'mixed',
      sample_flag: sampleFlagOf(sum.outs),
      performance_index: wOuts ? rnd(wIdx / wOuts, 3) : null,
      performance_index_basis: 'innings-weighted mean of the season ratings',
      rating_sample_weight: sampleWeight(sum.outs),
      era_vs_fip: { gap: null, label: null, reason: 'FIP is season-scoped; an ERA-FIP gap is reported per season.' }
    };
  }
  function uniqueJoin(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (v) {
      String(v == null ? '' : v).split(/\s*[;,/]\s*/).forEach(function (p) {
        p = p.trim(); if (p && !seen[p]) { seen[p] = 1; out.push(p); }
      });
    });
    return out.length ? out.join(', ') : null;
  }
  function uniqueNames(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) { var n = str(r.team_name); if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
    return out;
  }

  /** First-to-last change across the rows given. Descriptive, no extrapolation. */
  function netChange(rows) {
    var list = (rows || []).slice().sort(function (a, b) { return int(a.season) - int(b.season); });
    if (list.length < 2) return null;
    var a = list[0], b = list[list.length - 1], out = {};
    YOY_METRICS.forEach(function (m) {
      var x = num(a[m]), y = num(b[m]);
      out[m] = { from: x, to: y, delta: (x == null || y == null) ? null : rnd(y - x, 4), improved: improved(m, x, y) };
    });
    return { from_season: int(a.season), to_season: int(b.season), span_seasons: list.length, changes: out,
      role_from: a.role || null, role_to: b.role || null };
  }

  /** A direction per metric across the window, by first-to-last sign only. */
  function trendSummary(rows) {
    var nc = netChange(rows);
    if (!nc) return null;
    var moved = [], flat = [], unknown = [];
    YOY_METRICS.forEach(function (m) {
      var c = nc.changes[m];
      if (c.delta == null) { unknown.push(m); return; }
      if (c.improved == null) { flat.push(m); return; }
      moved.push({ metric: m, label: METRICS[m].label, delta: c.delta, improved: c.improved,
        from: c.from, to: c.to, formatted: fmtDelta(c.delta, m) });
    });
    return { from_season: nc.from_season, to_season: nc.to_season, span_seasons: nc.span_seasons,
      moved: moved, unchanged: flat, undefined_metrics: unknown,
      note: 'First observed season against last observed season in the window read. It is a description of two endpoints, '
        + 'not a fitted trend and not a projection.' };
  }

  /** Where a pitcher's profile lives in the app. Used in answers so a reader can open it. */
  function profileLink(playerId, o) {
    var base = (o && o.base) || '';
    var id = int(playerId);
    return id == null ? null : base + '/app.html#research/baseball/pitcher/' + id;
  }
  function matchupLink(aId, bId, o) {
    var base = (o && o.base) || '';
    var a = int(aId), b = int(bId);
    return (a == null || b == null) ? null : base + '/app.html#research/baseball/compare/' + a + '-' + b;
  }

  /** A tiny TTL cache, so a host that has none still gets one. */
  function simpleCache(defaultTtl) {
    var m = {};
    return {
      get: function (k) {
        var h = m[k];
        if (!h) return null;
        if (Date.now() > h.until) { delete m[k]; return null; }
        return h.value;
      },
      set: function (k, v, ttl) { m[k] = { value: v, until: Date.now() + (ttl || defaultTtl || 60000) }; },
      clear: function () { m = {}; }
    };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, RATING_VERSION: RATING_VERSION, RATING: RATING, SOURCE: SOURCE,
    OUTCOMES: OUTCOMES, LIMITS: LIMITS, METRICS: METRICS, ROLES: ROLES, SAMPLE_FLAGS: SAMPLE_FLAGS,
    COLS: COLS, QUERIES: QUERIES, YOY_METRICS: YOY_METRICS, COMPARE_METRICS: COMPARE_METRICS,
    /* arithmetic */
    outsToInnings: outsToInnings, inningsDisplay: inningsDisplay, displayToOuts: displayToOuts,
    eraOf: eraOf, whipOf: whipOf, kPer9: kPer9, bbPer9: bbPer9, hrPer9: hrPer9,
    kPct: kPct, bbPct: bbPct, kMinusBbPct: kMinusBbPct, fipOf: fipOf,
    sampleWeight: sampleWeight, performanceIndex: performanceIndex, roleOf: roleOf, sampleFlagOf: sampleFlagOf,
    /* identity */
    nameKey: nameKey, nameTokens: nameTokens, surnameKey: surnameKey, shortName: shortName,
    /* shaping */
    shapeSeason: shapeSeason, shapeTeamSeason: shapeTeamSeason, shapeOverview: shapeOverview,
    shapeTeamHistory: shapeTeamHistory, aggregateSeasons: aggregateSeasons,
    yearOverYear: yearOverYear, netChange: netChange, trendSummary: trendSummary,
    comparePitchers: comparePitchers, eraFipGap: eraFipGap, missedSeasons: missedSeasons,
    parseSeasonList: parseSeasonList, parseIdList: parseIdList,
    normaliseStarterStatus: normaliseStarterStatus,
    /* presentation */
    fmt: fmt, fmtDelta: fmtDelta, improved: improved, coverageNote: coverageNote,
    profileLink: profileLink, matchupLink: matchupLink,
    /* plumbing */
    minOutsFrom: minOutsFrom, inList: inList, envelope: envelope, failure: failure,
    simpleCache: simpleCache, createService: createService
  };
});
/*__EDMLBQ_END__*/

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDMLBHIST = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_mlb_history_v1';

  function Q() {
    return (root && root.EDMlbPitchers) || (typeof module === 'object' && module && module.exports
      ? tryRequire() : null);
  }
  function tryRequire() {
    try { return require('../../../lib/mlb_pitcher_history.js'); } catch (_) { return null; }
  }
  function R() { return root && root.EDRESEARCH ? root.EDRESEARCH : null; }

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (x) { var k = String(x); if (!s[k]) { s[k] = 1; o.push(x); } }); return o; }

  /* ====================================================================== */
  /* 1. THE ROUTER — is this a historical pitcher question, and which one?   */
  /*                                                                        */
  /* Deterministic and conservative. A question that merely mentions a       */
  /* pitcher's name while asking about tonight is NOT a history question,    */
  /* and routing it here would answer "how is he pitching" with a 2019 line. */
  /* ====================================================================== */

  /* Words that put a question in the past, inside this archive. */
  var HISTORY_WORDS = /\b(hist(ory|orical(ly)?)|career|over the (last|past)|past (three|four|five|six|seven|eight|nine|ten|\d+) (season|year)s?|last (three|four|five|six|seven|eight|nine|ten|\d+) (season|year)s?|since \d{4}|in \d{4}|back in|used to|previously|track record|year[- ]over[- ]year|season by season|each season|every season|trend(s|ed|ing)?|develop(ed|ment)|progress(ed|ion)?|changed?|improv(ed|ement|ing)|declin(ed|e|ing)|regress(ed|ion))\b/i;
  /* Words that make it about pitching specifically. */
  var PITCH_WORDS = /\b(pitch(er|ers|ing)?|starter(s)?|reliever(s)?|bullpen|rotation|era|fip|whip|k[- ]?bb|strikeout(s)?|walk(s)?|k\/9|bb\/9|hr\/9|k%|bb%|innings|ip\b|workload|saves?|holds?|quality start)\b/i;
  /* Words that are explicitly about right now — these VETO the history route
     unless a history word is also present, in which case both are answered and
     kept apart. */
  var CURRENT_WORDS = /\b(tonight|today|tomorrow|this (evening|afternoon)|right now|currently|current (season|form|year)|so far this (season|year)|latest start|last start|next start|is he (starting|pitching)|who('s| is) (pitching|starting))\b/i;

  var INTENTS = {
    pitcher_history: /\b(how (has|have).*(chang|develop|progress|improv|declin|look)|career|track record|season by season|year[- ]over[- ]year|over the (last|past)|history)\b/i,
    pitcher_team_history: /\b(which (teams?|clubs?)|what (teams?|clubs?)|(each|every|all|both) (of (his|their) )?(teams?|clubs?)|(teams?|clubs?) (he|they|each of them) (play|pitch|threw|thrown|pitched|played)|(play|pitch|threw|pitched|played) for|team history|club history|with each (team|club)|for each (team|club)|traded|moved to)\b/i,
    compare_pitchers: /\b(compar(e|ing|ison)|versus|vs\.?|against each other|better (than|of the two)|head to head|side by side|both starters|two starters|either starter)\b/i,
    era_vs_fip: /\b(era\s*(vs|versus|against|compared (with|to))\s*fip|supported by (his|the)? ?fip|deserved|fip\s*(vs|versus)\s*era|luck(y|ier)?|unlucky|peripheral)\b/i,
    leaderboard: /\b(who (had|has|were|was) the (best|worst|strongest|weakest|top|highest|lowest)|best|worst|strongest|weakest|top \d+|leader(s|board)?|rank(ed|ing)?|league leaders?|most|fewest)\b/i,
    improvement: /\b(improv(ed|ement)|declin(ed|e)|better|worse|gain(ed)?|lost|from \d{4} to \d{4}|between \d{4} and \d{4})\b/i,
    game_context: /\b(matchup|this (game|matchup)|tonight'?s (game|starters?)|what does the (historical|history).*(add|say)|both starters|starting pitchers)\b/i
  };

  var ROLE_WORDS = { starter: /\b(starter|starting pitcher|rotation|sp\b)/i, reliever: /\b(reliever|relief|bullpen|closer|rp\b)/i };

  /**
   * Decide whether this turn is about the historical pitching record, and what
   * it is asking for. Returns null when it is not — the caller then does
   * nothing at all, which is the correct behaviour for a football question.
   */
  function route(o) {
    o = o || {};
    var text = str(o.question);
    if (!text.trim()) return null;
    var sport = str(o.sport);
    /* A sport that is named and is not baseball is a hard no. An unnamed sport
       is allowed through only when the wording is unmistakably about pitching. */
    if (sport && sport !== 'baseball_mlb') return null;

    var hist = HISTORY_WORDS.test(text);
    var pitch = PITCH_WORDS.test(text);
    var current = CURRENT_WORDS.test(text);
    var carried = sanitizeState(o.state);
    var followUp = isFollowUp(text, carried);

    var names = pitcherNamesIn(text);
    var shape = INTENTS.leaderboard.test(text) || INTENTS.compare_pitchers.test(text)
      || INTENTS.pitcher_team_history.test(text) || INTENTS.era_vs_fip.test(text);

    /* THE GATE, and the one case where a keyword list is the wrong judge.

       "How has Gerrit Cole changed over the last five seasons?" contains no
       pitching word at all. What makes it a pitching question is that Gerrit
       Cole is a pitcher — a fact in the archive, not in a regular expression.
       So a question pairing a person-shaped name with history wording is
       routed as a PROBE: resolution is attempted, and if the name is not a
       pitcher in this archive the whole block is dropped and the turn proceeds
       as though this file had never run. A probe costs one indexed read on a
       2,450-row table and buys the questions a keyword list cannot reach.

       Everything else needs pitching wording. A bare "who's pitching tonight"
       is a live question and is left to the live layers. */
    var probeOnly = false;
    if (!followUp) {
      if (!pitch) {
        if (!(hist && names.length)) return null;
        probeOnly = true;
      }
      if (!hist && !shape && !probeOnly) return null;
      if (current && !hist && !INTENTS.compare_pitchers.test(text) && !INTENTS.era_vs_fip.test(text)) return null;
      /* A subject is required unless the question is about a population.
         "Now compare him to the other starter" is a real question with a
         carried conversation behind it and nonsense without one: routed with
         no name and no carried id, it retrieves nothing and attaches a block
         whose only content is that nothing resolved. */
      if (!names.length && !POPULATION.test(text) && !INTENTS.leaderboard.test(text)
        && !INTENTS.game_context.test(text)) return null;
    }

    var intents = [];
    Object.keys(INTENTS).forEach(function (k) { if (INTENTS[k].test(text)) intents.push(k); });
    if (!intents.length) intents.push(followUp ? (carried && carried.last_intent) || 'pitcher_history' : 'pitcher_history');

    var role = null;
    Object.keys(ROLE_WORDS).forEach(function (k) { if (ROLE_WORDS[k].test(text)) role = k; });

    var seasons = seasonsIn(text);
    var lastN = lastNSeasons(text);
    var minIp = minInningsIn(text);

    return {
      is_history: true,
      /* The question itself travels with the plan: metricFor() reads it to
         decide which column a leaderboard is actually ordering on, and a plan
         that lost its own text would silently rank everything by the default. */
      question_text: text,
      /* True when only a name and history wording put us here. The archive
         decides: nothing resolves, nothing is attached. */
      probe_only: probeOnly,
      follow_up: followUp,
      intents: uniq(intents),
      primary_intent: pickPrimary(intents, text, names, carried),
      names: names,
      carried_player_ids: carried ? carried.player_ids : [],
      seasons: seasons,
      season: seasons.length === 1 ? seasons[0] : null,
      season_range: seasons.length >= 2 ? { from: Math.min.apply(null, seasons), to: Math.max.apply(null, seasons) } : null,
      last_n_seasons: lastN,
      role: role,
      min_innings: minIp,
      mentions_current: current,
      /* A question that asks about BOTH the archive and the current season is
         answered as two labelled things, never as one blended number. */
      wants_current_too: current && hist
    };
  }

  /* A question about a POPULATION — "which relievers improved", "who had the
     best 2025" — is a board with a deterministic join over it, never a
     per-player history. It is told apart by asking about a group of pitchers
     while naming none of them. */
  var POPULATION = /\b(which|who|what|name the|list the|show me the)\b[^?]{0,40}\b(pitchers?|starters?|relievers?|arms|closers?)\b/i;

  function pickPrimary(intents, text, names, carried) {
    var hasSubject = (names && names.length) || (carried && carried.player_ids && carried.player_ids.length);
    var population = POPULATION.test(str(text)) || (!hasSubject && intents.indexOf('leaderboard') >= 0);
    /* "Which relievers improved their K-BB% from 2024 to 2025" trips
       `improvement` and nothing else, but it is a board question: without this
       it falls through to the per-player branch with no player to read. */
    if (population && (intents.indexOf('improvement') >= 0 || intents.indexOf('leaderboard') >= 0)) return 'leaderboard';
    /* Order matters: a question can trip several patterns and only one of them
       decides what is retrieved. Comparison and leaderboard are the most
       specific shapes, so they win over the generic "history". */
    var order = ['game_context', 'compare_pitchers', 'leaderboard', 'pitcher_team_history', 'era_vs_fip', 'improvement', 'pitcher_history'];
    for (var i = 0; i < order.length; i++) if (intents.indexOf(order[i]) >= 0) return order[i];
    return 'pitcher_history';
  }

  /** Four-digit seasons named in the question, inside a plausible range. */
  function seasonsIn(text) {
    var out = [], m, re = /\b(19[89]\d|20[0-4]\d)\b/g;
    while ((m = re.exec(str(text)))) { var y = Number(m[1]); if (y >= 1980 && y <= 2049) out.push(y); }
    return uniq(out).sort(function (a, b) { return a - b; });
  }
  var WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  function lastNSeasons(text) {
    var m = /\b(?:last|past)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:season|year)s?\b/i.exec(str(text));
    if (!m) return null;
    var v = WORD_N[String(m[1]).toLowerCase()] != null ? WORD_N[String(m[1]).toLowerCase()] : Number(m[1]);
    return Number.isFinite(v) && v > 0 && v <= 20 ? v : null;
  }
  function minInningsIn(text) {
    var m = /\b(?:at least|minimum(?: of)?|min\.?|≥|>=)\s*(\d{1,3})\s*(?:\+\s*)?(?:innings|ip)\b/i.exec(str(text))
      || /\b(\d{2,3})\s*(?:\+|or more)?\s*(?:innings|ip)\b/i.exec(str(text));
    return m ? Number(m[1]) : null;
  }

  /* Capitalised name-shaped runs, minus the words that are capitalised for
     other reasons. Names are a HINT: every one is resolved against the archive
     and an ambiguous one is reported, never picked. */
  var NOT_A_NAME = new RegExp('^(?:' + [
    /* sentence furniture */
    'The|A|An|And|But|Or|How|What|Which|Who|Whose|Why|When|Where|Is|Was|Are|Were|Did|Does|Do|Has|Have|Had',
    'Can|Could|Should|Would|Will|Now|Also|Then|If|In|On|At|For|From|To|With|About|Between|Versus|Vs',
    'Compare|Show|Tell|Give|List|Find|Rank|Explain|Look|Check|Consider',
    /* the vocabulary of the question itself */
    'MLB|ERA|FIP|WHIP|IP|K|BB|HR|WAR|AL|NL|East|West|Central|League|Division|Season|Seasons|Year|Years',
    'Best|Worst|Top|Bottom|Him|His|He|Them|Their|Both|Either|Starter|Starters|Pitcher|Pitchers|Reliever',
    'Relievers|Closer|Closers|Rotation|Bullpen|Team|Teams|Club|Clubs|Innings|Strikeouts|Walks|EdgeDesk',
    /* MLB club nicknames AND city tokens. Without the city tokens "the New
       York Yankees rotation" yields the name "New York", which is then
       reported as an unresolved pitcher on every such question. */
    'Yankees|Red|Sox|Dodgers|Mets|Cubs|Giants|Angels|Astros|Braves|Padres|Phillies|Guardians|Indians',
    'Rangers|Mariners|Twins|Royals|Tigers|Brewers|Cardinals|Pirates|Reds|Marlins|Nationals|Orioles',
    'Rays|Blue|Jays|White|Athletics|Rockies|Diamondbacks|Backs',
    'New|York|Los|Angeles|San|Francisco|Diego|St|Saint|Louis|Kansas|City|Tampa|Bay|Toronto|Boston',
    'Chicago|Cleveland|Detroit|Minnesota|Houston|Seattle|Texas|Oakland|Colorado|Arizona|Atlanta|Miami',
    'Philadelphia|Washington|Milwaukee|Pittsburgh|Cincinnati|Baltimore|Sacramento|Anaheim|Denver|Phoenix'
  ].join('|') + ')\\.?$');

  var SUFFIX = /^(Jr\.?|Sr\.?|II|III|IV)$/;

  /**
   * Capitalised runs that look like people.
   *
   * Written as a scan rather than one regex because the obvious regex loses
   * names: "Compare Gerrit Cole and Zack Wheeler" opens with a capitalised
   * verb, and a pattern that discards any candidate containing a stop word
   * throws away "Gerrit Cole" along with "Compare". Here a stop word simply
   * ENDS the current run, so both names survive.
   */
  function pitcherNamesIn(text) {
    var runs = [], run = [];
    function flush() {
      while (run.length && SUFFIX.test(run[run.length - 1])) run.pop();
      if (run.length >= 2) runs.push(run.slice(0, 3).join(' '));
      run = [];
    }
    str(text).split(/\s+/).forEach(function (raw) {
      var t = raw.replace(/^[^\wÀ-ÿ]+/, '').replace(/[^\w'À-ÿ.-]+$/, '').replace(/['’]s$/, '');
      if (!t) { flush(); return; }
      if (!/^[A-ZÀ-Ü]/.test(t) || NOT_A_NAME.test(t)) { flush(); return; }
      run.push(t);
      /* Four capitalised tokens in a row is a title or an organisation, not a
         person; the run is closed at three and restarted. */
      if (run.length >= 3) flush();
    });
    flush();
    return uniq(runs).slice(0, 4);
  }

  /* A follow-up is a question that leans on what was already resolved: a bare
     pronoun, "the other starter", "now compare them". It only counts when this
     conversation actually carries resolved ids. */
  var FOLLOW_WORDS = /\b(he|him|his|they|them|their|the other (starter|pitcher|guy|one)|both of them|that (pitcher|starter)|same (pitcher|starter)|now (compare|show|what about)|what about|and (him|his|them)|compare (them|him|the two))\b/i;
  function isFollowUp(text, carried) {
    if (!carried || !carried.player_ids || !carried.player_ids.length) return false;
    return FOLLOW_WORDS.test(str(text)) || /^\s*(and|also|what about|now)\b/i.test(str(text));
  }

  /* ====================================================================== */
  /* 2. CARRIED STATE — ids and scope, never numbers                        */
  /*                                                                        */
  /* The client hands this back on the next turn. It carries MLB ids and a   */
  /* season scope so "now compare him to the other starter" resolves without */
  /* a name; it carries NO statistics, because every number is re-read from  */
  /* the database each turn rather than believed from a client.              */
  /* ====================================================================== */

  function sanitizeState(s) {
    if (!s || typeof s !== 'object') return null;
    var ids = (Array.isArray(s.player_ids) ? s.player_ids : []).map(int)
      .filter(function (x) { return x != null && x > 0; }).slice(0, 6);
    if (!ids.length) return null;
    var names = {};
    if (s.player_names && typeof s.player_names === 'object') {
      Object.keys(s.player_names).slice(0, 6).forEach(function (k) {
        if (int(k) != null) names[int(k)] = str(s.player_names[k]).slice(0, 80);
      });
    }
    return {
      schema: SCHEMA,
      player_ids: ids,
      player_names: names,
      season: int(s.season),
      from_season: int(s.from_season),
      to_season: int(s.to_season),
      last_intent: str(s.last_intent).slice(0, 40) || null,
      role: ROLE_LIST.indexOf(str(s.role)) >= 0 ? str(s.role) : null,
      turns: (int(s.turns) || 0) + 0
    };
  }
  var ROLE_LIST = ['starter', 'reliever', 'mixed'];

  function conversationState(o) {
    o = o || {};
    var prev = sanitizeState(o.previous);
    var res = o.result || null;
    var ids = [];
    var names = {};
    if (res && res.players) {
      res.players.forEach(function (p) {
        if (p && p.player_id != null) { ids.push(int(p.player_id)); names[int(p.player_id)] = str(p.player_name); }
      });
    }
    if (!ids.length && prev) { ids = prev.player_ids; names = prev.player_names || {}; }
    if (!ids.length) return null;
    var plan = o.plan || {};
    return {
      schema: SCHEMA,
      player_ids: ids.slice(0, 6),
      player_names: names,
      season: plan.season != null ? plan.season : (prev ? prev.season : null),
      from_season: plan.season_range ? plan.season_range.from : (prev ? prev.from_season : null),
      to_season: plan.season_range ? plan.season_range.to : (prev ? prev.to_season : null),
      last_intent: plan.primary_intent || (prev ? prev.last_intent : null),
      role: plan.role || (prev ? prev.role : null),
      turns: (prev && prev.turns ? prev.turns : 0) + 1,
      coverage: res && res.coverage ? res.coverage : null,
      note: 'MLB ids and the season scope this conversation is on. No statistic is carried: every number is re-read '
        + 'from the archive each turn, so a follow-up cannot quote a figure the server did not just retrieve.'
    };
  }

  /* ====================================================================== */
  /* 3. RETRIEVAL — deterministic, and it runs whether or not the model has  */
  /*    a tool loop                                                         */
  /* ====================================================================== */

  /**
   * Run the plan against the archive.
   *
   * o.plan      from route()
   * o.service   a lib/mlb_pitcher_history.js service
   * o.game      optional {starters:[…]} from the live card, for game context
   * Returns a structured result the prompt block, the evidence array, the
   * critic and the conversation state are all built from. Never throws.
   */
  async function retrieve(o) {
    o = o || {};
    var plan = o.plan, svc = o.service;
    var out = {
      schema: SCHEMA, version: VERSION,
      intent: plan ? plan.primary_intent : null,
      requested: plan || null,
      coverage: null, rating: null, rating_version: null,
      players: [], resolution: [], sections: [], notes: [], errors: [],
      unavailable: null
    };
    if (!plan || !svc) { out.unavailable = 'no plan or no service'; return out; }

    var st = await svc.status();
    out.coverage = st && st.coverage ? st.coverage : null;
    if (!st || st.ok !== true) {
      out.unavailable = (st && st.detail) || 'the historical pitching archive could not be read';
      out.code = (st && st.code) || 'QUERY_UNAVAILABLE';
      return out;
    }
    var QL = Q();
    out.rating = QL ? QL.RATING : null;
    out.rating_version = out.coverage.rating_version;
    out.notes.push(QL ? QL.coverageNote(out.coverage) : '');

    /* ---- who is being asked about ---------------------------------------- */
    var resolved = [];
    var wanted = [];
    (plan.names || []).forEach(function (n) { wanted.push({ name: n }); });
    if (!wanted.length && plan.carried_player_ids && plan.carried_player_ids.length) {
      plan.carried_player_ids.forEach(function (id) { wanted.push({ player_id: id }); });
    }
    /* Game context supplies its starters directly from the card. */
    if (plan.primary_intent === 'game_context' && o.game && o.game.starters && o.game.starters.length) {
      wanted = o.game.starters.map(function (s) { return { name: s.name, player_id: s.player_id, side: s.side, team: s.team, status: s.status }; });
    }

    for (var i = 0; i < wanted.length && i < 4; i++) {
      var w = wanted[i];
      var r = await svc.resolvePlayer({ name: w.name, player_id: w.player_id, season: plan.season, team_id: w.team_id });
      out.resolution.push({
        asked: w.name || ('MLB id ' + w.player_id),
        code: r.code, ok: r.ok,
        matched_on: r.data && r.data.matched_on,
        candidates: (r.data && r.data.candidates) || [],
        error: r.error || null
      });
      if (r.ok && r.data && r.data.resolved) resolved.push(r.data.resolved);
    }
    out.players = resolved.map(function (p) { return { player_id: p.player_id, player_name: p.player_name }; });

    /* A leaderboard needs no player at all; everything else does. */
    var needsPlayer = plan.primary_intent !== 'leaderboard';
    if (needsPlayer && !resolved.length) {
      out.unavailable = out.resolution.length
        ? 'none of the named pitchers resolved to the archive'
        : 'the question named no pitcher this archive could resolve';
      out.code = out.resolution.length ? out.resolution[0].code : 'UNRESOLVED_PLAYER';
      return out;
    }

    /* ---- what the question needs ----------------------------------------- */
    var seasonScope = plan.season != null ? { season: plan.season }
      : plan.season_range ? { from: plan.season_range.from, to: plan.season_range.to }
        : {};

    try {
      if (plan.primary_intent === 'leaderboard') {
        var season = plan.season != null ? plan.season : (plan.season_range ? plan.season_range.to : out.coverage.end);
        var metric = metricFor(plan);
        var lb = await svc.leaderboard({
          season: season, role: plan.role, metric: metric.metric, order: metric.order,
          min_innings: plan.min_innings, limit: 15
        });
        out.sections.push({ kind: 'leaderboard', ok: lb.ok, code: lb.code, scope: lb.scope,
          sample: lb.sample, data: lb.data, notes: lb.notes });
        if (plan.intents.indexOf('improvement') >= 0 && season > out.coverage.start) {
          /* "who improved from 2024 to 2025" is two boards and a deterministic
             join, not a model comparing two lists in prose. */
          var prev = await svc.leaderboard({
            season: season - 1, role: plan.role, metric: metric.metric, order: metric.order,
            min_innings: plan.min_innings, limit: 200
          });
          out.sections.push({ kind: 'improvement', ok: lb.ok && prev.ok,
            scope: (season - 1) + '→' + season,
            data: improvementJoin(prev.data && prev.data.rows, lb.data && lb.data.rows, metric.metric, plan),
            notes: ['Both seasons carry the same role and workload filter. A pitcher missing from either season is '
              + 'listed as such rather than treated as a zero.'] });
        }
      } else if (plan.primary_intent === 'compare_pitchers' && resolved.length >= 2) {
        var cmp = await svc.compare({
          player_ids: resolved.map(function (p) { return p.player_id; }),
          season: seasonScope.season, from: seasonScope.from, to: seasonScope.to
        });
        out.sections.push({ kind: 'comparison', ok: cmp.ok, code: cmp.code, scope: cmp.scope,
          sample: cmp.sample, data: cmp.data, notes: cmp.notes });
        for (var c = 0; c < resolved.length; c++) {
          var h = await svc.seasonHistory({ player_id: resolved[c].player_id });
          out.sections.push({ kind: 'season_history', player_id: resolved[c].player_id,
            player_name: resolved[c].player_name, ok: h.ok, code: h.code, scope: h.scope,
            sample: h.sample, data: trimHistory(h.data, plan), notes: h.notes });
        }
      } else if (plan.primary_intent === 'pitcher_team_history') {
        for (var t = 0; t < resolved.length; t++) {
          var th = await svc.teamHistory({ player_id: resolved[t].player_id });
          out.sections.push({ kind: 'team_history', player_id: resolved[t].player_id,
            player_name: resolved[t].player_name, ok: th.ok, code: th.code, scope: th.scope,
            sample: th.sample, data: th.data, notes: th.notes });
        }
      } else if (plan.primary_intent === 'game_context') {
        var gc = await svc.gamePitcherContext({
          game: o.game && o.game.label, compare_season: plan.season,
          starters: (o.game && o.game.starters) || []
        });
        out.sections.push({ kind: 'game_context', ok: gc.ok, code: gc.code, scope: gc.scope,
          sample: gc.sample, data: gc.data, notes: gc.notes });
      } else {
        /* pitcher_history, era_vs_fip and improvement for a named pitcher all
           want the same rows: the seasons, the change between them, and the
           clubs. Fetched once, read differently. */
        for (var p2 = 0; p2 < resolved.length; p2++) {
          var id = resolved[p2].player_id;
          var ov = await svc.pitcherOverview({ player_id: id });
          out.sections.push({ kind: 'overview', player_id: id, player_name: resolved[p2].player_name,
            ok: ov.ok, code: ov.code, scope: ov.scope, sample: ov.sample, data: ov.data, notes: ov.notes });
          var ch = await svc.changes({ player_id: id, from: seasonScope.from, to: seasonScope.to,
            last_n_seasons: plan.last_n_seasons });
          out.sections.push({ kind: 'changes', player_id: id, player_name: resolved[p2].player_name,
            ok: ch.ok, code: ch.code, scope: ch.scope, sample: ch.sample, data: ch.data, notes: ch.notes });
          if (plan.intents.indexOf('era_vs_fip') >= 0 || plan.intents.indexOf('pitcher_team_history') >= 0) {
            var th2 = await svc.teamHistory({ player_id: id });
            out.sections.push({ kind: 'team_history', player_id: id, player_name: resolved[p2].player_name,
              ok: th2.ok, code: th2.code, scope: th2.scope, sample: th2.sample, data: th2.data, notes: th2.notes });
          }
        }
      }
    } catch (e) {
      out.errors.push(str(e && e.message || e).slice(0, 200));
    }

    /* Links, so an answer can send the reader to the page carrying the rows. */
    out.links = {};
    if (QL) {
      resolved.forEach(function (p) { out.links['pitcher:' + p.player_id] = QL.profileLink(p.player_id); });
      if (resolved.length === 2) out.links.comparison = QL.matchupLink(resolved[0].player_id, resolved[1].player_id);
    }
    return out;
  }

  /* The minimum-workload clause, removed before a metric is chosen.

     "Who had the strongest 2025 ratings among starters with AT LEAST 120
     INNINGS" asks for a rating board with a workload FILTER. Matching "innings"
     anywhere in the question ranked it by innings instead — the filter was read
     as the sort key and the board came back listing the busiest arms, under a
     heading that said "strongest ratings". The filter phrase is consumed here
     so it can never be mistaken for the subject. */
  var MIN_CLAUSE = /\b(?:at least|minimum(?: of)?|min\.?|≥|>=)\s*\d{1,3}\s*(?:\+\s*)?(?:innings|ip)\b|\b\d{2,3}\s*(?:\+|or more)\s*(?:innings|ip)\b/gi;

  /** Which column a leaderboard question is actually ordering on. */
  function metricFor(plan) {
    var t = str(plan && plan.question_text).replace(MIN_CLAUSE, ' ');
    var intents = (plan && plan.intents) || [];
    var worst = /\b(worst|weakest|lowest|fewest|bottom)\b/i.test(t);
    if (/\bk[- ]?bb|strikeout.minus.walk\b/i.test(t)) return { metric: 'k_minus_bb_pct', order: worst ? 'asc' : 'desc' };
    if (/\bstrikeout|k%|k\/9\b/i.test(t)) return { metric: 'k_pct', order: worst ? 'asc' : 'desc' };
    if (/\bwalk|bb%|bb\/9\b/i.test(t)) return { metric: 'bb_pct', order: worst ? 'desc' : 'asc' };
    if (/\bera\b/i.test(t)) return { metric: 'era', order: worst ? 'desc' : 'asc' };
    if (/\bfip\b/i.test(t)) return { metric: 'fip', order: worst ? 'desc' : 'asc' };
    if (/\bwhip\b/i.test(t)) return { metric: 'whip', order: worst ? 'desc' : 'asc' };
    /* Innings only when the WORKLOAD is what is being ranked, not merely
       mentioned: "most innings", "the biggest workload", "innings leaders". */
    if (/\b(most|fewest|biggest|largest|smallest|heaviest|lightest|top|bottom|leaders? in|ranked by|sorted by)\s+(?:\w+\s+){0,2}(innings|workload)\b/i.test(t)
      || /\b(innings|workload)\s+(leaders?|leaderboard|ranking)\b/i.test(t)) {
      return { metric: 'innings_decimal', order: worst ? 'asc' : 'desc' };
    }
    if (/\bsaves?\b/i.test(t)) return { metric: 'saves', order: worst ? 'asc' : 'desc' };
    if (intents.indexOf('era_vs_fip') >= 0) return { metric: 'fip', order: worst ? 'desc' : 'asc' };
    return { metric: 'performance_index', order: worst ? 'asc' : 'desc' };
  }

  /** Two boards, joined on player id, ranked by the deterministic change. */
  function improvementJoin(prevRows, curRows, metric, plan) {
    var byId = {};
    (prevRows || []).forEach(function (r) { byId[r.player_id] = r; });
    var QL = Q();
    var rows = (curRows || []).map(function (cur) {
      var prev = byId[cur.player_id] || null;
      var a = prev ? num(prev[metric]) : null, b = num(cur[metric]);
      return {
        player_id: cur.player_id, player_name: cur.player_name,
        from: a, to: b,
        delta: (a == null || b == null) ? null : Math.round((b - a) * 10000) / 10000,
        improved: QL ? QL.improved(metric, a, b) : null,
        from_innings: prev ? prev.innings : null, to_innings: cur.innings,
        from_role: prev ? prev.role : null, to_role: cur.role,
        status: prev ? 'both seasons' : 'no qualifying season in the earlier year'
      };
    });
    var better = QL && QL.METRICS[metric] ? QL.METRICS[metric].better : 'higher';
    var scored = rows.filter(function (r) { return r.delta != null; });
    scored.sort(function (x, y) { return better === 'lower' ? x.delta - y.delta : y.delta - x.delta; });
    return {
      metric: metric, better: better,
      improved: scored.filter(function (r) { return r.improved === true; }).slice(0, 15),
      declined: scored.filter(function (r) { return r.improved === false; }).slice(0, 5),
      unmatched: rows.filter(function (r) { return r.delta == null; }).slice(0, 10),
      role: plan && plan.role ? plan.role : null,
      min_innings: plan ? plan.min_innings : null
    };
  }

  /** Keep a season history inside the window the question asked for. */
  function trimHistory(data, plan) {
    if (!data || !data.seasons) return data;
    var rows = data.seasons;
    if (plan && plan.last_n_seasons) rows = rows.slice(-plan.last_n_seasons);
    if (rows === data.seasons) return data;
    var QL = Q();
    return Object.assign({}, data, { seasons: rows, year_over_year: QL ? QL.yearOverYear(rows) : data.year_over_year });
  }

  /* ====================================================================== */
  /* 4. THE PROMPT BLOCK — rows, plainly, with the terms attached            */
  /* ====================================================================== */

  function promptBlock(res) {
    if (!res) return '';
    var QL = Q();
    var L = [];
    L.push('=== MLB HISTORICAL PITCHING RECORD (retrieved this turn, from EdgeDesk’s own database) ===');
    if (res.unavailable) {
      L.push('RETRIEVAL FAILED: ' + res.unavailable);
      L.push('Say exactly this and do not substitute anything for it. Do not answer the historical question from memory.');
      if (res.resolution && res.resolution.length) {
        res.resolution.forEach(function (r) {
          L.push('  ' + r.asked + ' -> ' + r.code + (r.error ? ' (' + r.error + ')' : ''));
          if (r.candidates && r.candidates.length) {
            L.push('    candidates: ' + r.candidates.map(function (c) {
              return c.player_name + ' (MLB id ' + c.player_id + ', ' + c.first_observed_season + '–'
                + c.last_observed_season + ', ' + (c.teams || 'club unknown') + ')';
            }).join(' | '));
            L.push('    ASK WHICH ONE IS MEANT. Do not pick one.');
          }
        });
      }
      return L.join('\n');
    }
    var cov = res.coverage || {};
    L.push('Coverage: ' + cov.start + '–' + cov.end + ' MLB regular seasons. Rating: ' + (res.rating_version || 'ED_PITCH_PERF_V1') + '.');
    L.push('THIS IS NOT CURRENT-SEASON DATA. It ends in ' + cov.end + '. It cannot say who is pitching tonight, which club a '
      + 'pitcher is on now, whether he is healthy, his velocity, his pitch mix, his platoon splits or any batter-versus-pitcher record.');
    if (cov.provisional_seasons && cov.provisional_seasons.length) {
      L.push('Provisional (imported before the season finished, so ratings will change): ' + cov.provisional_seasons.join(', ') + '.');
    }
    if (res.rating) {
      L.push('performance_index: ' + res.rating.scale + ' ' + res.rating.formula
        + ' It is NOT ' + res.rating.is_not.join(', ') + '. Never convert it to a probability, a fair price or an edge.');
    }
    (res.resolution || []).forEach(function (r) {
      if (r.ok) return;
      L.push('UNRESOLVED: ' + r.asked + ' -> ' + r.code + (r.error ? ' — ' + r.error : ''));
      if (r.candidates && r.candidates.length) {
        L.push('  candidates: ' + r.candidates.map(function (c) { return c.player_name + ' (id ' + c.player_id + ', ' + (c.teams || '?') + ')'; }).join(' | ')
          + ' — ASK WHICH ONE. Do not choose.');
      }
    });

    (res.sections || []).forEach(function (s) {
      L.push('');
      L.push('--- ' + s.kind.toUpperCase().replace(/_/g, ' ')
        + (s.player_name ? ': ' + s.player_name + ' (MLB id ' + s.player_id + ')' : '')
        + (s.scope ? ' [' + s.scope + ']' : '') + ' ---');
      if (!s.ok) { L.push('not available: ' + (s.code || 'unknown') + (s.notes && s.notes.length ? ' — ' + s.notes[0] : '')); return; }
      L.push(renderSection(s, QL));
      (s.notes || []).slice(0, 3).forEach(function (n) { if (n) L.push('note: ' + n); });
    });

    if (res.links) {
      var ln = Object.keys(res.links).filter(function (k) { return res.links[k]; });
      if (ln.length) L.push('\nLinks to the pages carrying these rows: '
        + ln.map(function (k) { return k + ' ' + res.links[k]; }).join('  '));
    }
    L.push('');
    L.push('HOW TO USE THIS. Answer the question directly first, then support it with these rows. Name the seasons and the '
      + 'innings behind every number you quote. Every figure in your answer must appear above; do not compute a new one and '
      + 'do not recall one. Where a value is undefined, say it is undefined and why, rather than omitting the pitcher. '
      + 'Keep description ("his ERA was 3.41 over 174 innings") apart from interpretation ("that is a good season").');
    return L.join('\n');
  }

  function renderSection(s, QL) {
    var d = s.data || {};
    var f = function (v, m) { return QL ? QL.fmt(v, m) : (v == null ? '—' : String(v)); };
    var lines = [];
    if (s.kind === 'overview') {
      var o = d.overview || {};
      lines.push('career window ' + o.first_observed_season + '–' + o.last_observed_season
        + ': ' + o.seasons_with_appearances + ' seasons with appearances, ' + o.games + ' G / ' + o.starts + ' GS, '
        + o.innings + ' IP, ERA ' + f(o.era, 'era') + ', WHIP ' + f(o.whip, 'whip')
        + ', K% ' + f(o.k_pct, 'k_pct') + ', BB% ' + f(o.bb_pct, 'bb_pct') + ', K-BB% ' + f(o.k_minus_bb_pct, 'k_minus_bb_pct')
        + ', innings-weighted index ' + f(o.weighted_performance_index, 'performance_index'));
      lines.push('observed seasons: ' + (o.observed_seasons || []).join(', ')
        + (o.missed_seasons && o.missed_seasons.length ? '  |  NO appearance in: ' + o.missed_seasons.join(', ') : ''));
      lines.push('clubs: ' + (o.teams || '—') + ' (' + o.team_count + ')');
      if (d.latest_observed_season) {
        var l = d.latest_observed_season;
        lines.push('latest observed season ' + l.season + ': ' + l.innings + ' IP, ERA ' + f(l.era, 'era')
          + ', FIP ' + f(l.fip, 'fip') + ', index ' + f(l.performance_index, 'performance_index')
          + ', role ' + (l.role || '—') + ', clubs ' + (l.teams || '—')
          + '  [LATEST IN THE ARCHIVE — not his current club or role]');
      }
    } else if (s.kind === 'changes' || s.kind === 'season_history') {
      (d.seasons || []).forEach(function (r) {
        lines.push('  ' + r.season + '  ' + pad(r.role || '?', 9) + ' ' + pad(r.teams || '?', 34)
          + ' ' + pad(r.innings + ' IP', 10)
          + ' ERA ' + pad(f(r.era, 'era'), 6) + ' FIP ' + pad(f(r.fip, 'fip'), 6) + ' WHIP ' + pad(f(r.whip, 'whip'), 6)
          + ' K% ' + pad(f(r.k_pct, 'k_pct'), 6) + ' BB% ' + pad(f(r.bb_pct, 'bb_pct'), 6)
          + ' K-BB% ' + pad(f(r.k_minus_bb_pct, 'k_minus_bb_pct'), 6)
          + ' index ' + pad(f(r.performance_index, 'performance_index'), 6)
          + ' [' + (r.sample_flag || '?') + ']'
          + (r.era_vs_fip && r.era_vs_fip.gap != null ? '  ERA−FIP ' + r.era_vs_fip.gap.toFixed(2) + ' (' + r.era_vs_fip.label + ')' : ''));
      });
      (d.year_over_year || []).forEach(function (y) {
        var parts = [];
        ['era', 'fip', 'whip', 'k_pct', 'bb_pct', 'k_minus_bb_pct', 'innings_decimal', 'performance_index'].forEach(function (m) {
          var c = y.changes[m];
          if (!c) return;
          parts.push(m + ' ' + (c.delta == null ? 'undefined (' + c.undefined_reason + ')'
            : (QL ? QL.fmtDelta(c.delta, m) : c.delta) + (c.improved == null ? '' : c.improved ? ' better' : ' worse')));
        });
        lines.push('  ' + y.from_season + '→' + y.to_season + (y.consecutive ? '' : ' (GAP: ' + y.gap_seasons + ' season(s) with no appearance)')
          + (y.role_changed ? ' ROLE ' + y.role_from + '→' + y.role_to : '')
          + (y.team_changed ? ' CLUB ' + y.teams_from + '→' + y.teams_to : '')
          + '  ' + parts.join('; '));
      });
      if (d.trend) {
        lines.push('  net ' + d.trend.from_season + '→' + d.trend.to_season + ': '
          + d.trend.moved.map(function (m) { return m.label + ' ' + m.formatted + (m.improved ? ' better' : ' worse'); }).join(', ')
          + (d.trend.undefined_metrics.length ? '  undefined: ' + d.trend.undefined_metrics.join(', ') : ''));
      }
    } else if (s.kind === 'team_history') {
      (d.clubs || []).forEach(function (c) {
        lines.push('  club ' + c.team_id + ' ' + pad(c.team_names_observed || '?', 26)
          + ' seasons ' + (c.observed_seasons || []).join('/') + (c.missed_seasons && c.missed_seasons.length ? ' [gap: ' + c.missed_seasons.join(',') + ']' : '')
          + '  ' + pad(c.innings + ' IP', 10) + ' ' + c.games + 'G/' + c.starts + 'GS'
          + ' ERA ' + pad(f(c.era, 'era'), 6) + ' K-BB% ' + pad(f(c.k_minus_bb_pct, 'k_minus_bb_pct'), 6)
          + ' weighted index ' + f(c.weighted_performance_index, 'performance_index'));
      });
      if (d.multi_club_seasons && d.multi_club_seasons.length) {
        lines.push('  split seasons (traded): ' + d.multi_club_seasons.join(', ')
          + ' — the club rows for those years are PARTS of the season; never add them to the season line.');
        (d.club_seasons || []).filter(function (cs) { return d.multi_club_seasons.indexOf(cs.season) >= 0; })
          .forEach(function (cs) {
            lines.push('    ' + cs.season + ' ' + pad(cs.team_name || '?', 24) + ' ' + pad(cs.innings + ' IP', 10)
              + ' ERA ' + pad(f(cs.era, 'era'), 6) + ' FIP ' + pad(f(cs.fip, 'fip'), 6)
              + ' index ' + f(cs.performance_index, 'performance_index'));
          });
      }
      lines.push('  TENURE MEANS: seasons with a recorded MLB pitching appearance for that club. Not contract or roster dates.');
    } else if (s.kind === 'leaderboard') {
      lines.push('  season ' + d.season + ', ordered by ' + d.metric_label + ' (' + d.better + ' is better), '
        + (d.role ? 'role ' + d.role : 'any role')
        + (d.min_innings ? ', minimum ' + d.min_innings + ' IP' : ', NO minimum workload')
        + (d.league_baseline ? ', league ERA ' + f(d.league_baseline.league_era, 'era') : ''));
      (d.rows || []).forEach(function (r) {
        lines.push('  ' + pad('#' + r.rank, 4) + pad(r.player_name, 24) + pad(r.teams || '?', 28)
          + pad(r.innings + ' IP', 10) + ' ERA ' + pad(f(r.era, 'era'), 6) + ' FIP ' + pad(f(r.fip, 'fip'), 6)
          + ' K-BB% ' + pad(f(r.k_minus_bb_pct, 'k_minus_bb_pct'), 6)
          + ' index ' + pad(f(r.performance_index, 'performance_index'), 6) + ' [' + (r.sample_flag || '?') + ']');
      });
      if (d.truncated) lines.push('  (cut at ' + (d.rows || []).length + ' rows; there are more below this line)');
    } else if (s.kind === 'improvement') {
      lines.push('  ' + d.metric + ', ' + d.better + ' is better'
        + (d.role ? ', role ' + d.role : '') + (d.min_innings ? ', minimum ' + d.min_innings + ' IP' : ''));
      (d.improved || []).forEach(function (r) {
        lines.push('  + ' + pad(r.player_name, 24) + ' ' + (QL ? QL.fmt(r.from, d.metric) : r.from) + ' → '
          + (QL ? QL.fmt(r.to, d.metric) : r.to) + '  (' + (QL ? QL.fmtDelta(r.delta, d.metric) : r.delta) + ')  '
          + r.from_innings + ' → ' + r.to_innings + ' IP'
          + (r.from_role !== r.to_role ? '  ROLE ' + r.from_role + '→' + r.to_role : ''));
      });
      if (d.unmatched && d.unmatched.length) {
        lines.push('  no comparison possible for: ' + d.unmatched.map(function (r) { return r.player_name + ' (' + r.status + ')'; }).join(', '));
      }
    } else if (s.kind === 'comparison') {
      var c2 = d.comparison || {};
      lines.push('  scope: ' + c2.scope);
      lines.push('  ' + pad('', 16) + (c2.sides || []).map(function (x) { return pad(x.player_name + (x.season ? ' ' + x.season : ''), 26); }).join(''));
      lines.push('  ' + pad('innings', 16) + (c2.sides || []).map(function (x) { return pad(String(x.innings) + ' IP (' + (x.sample_flag || '?') + ')', 26); }).join(''));
      lines.push('  ' + pad('role', 16) + (c2.sides || []).map(function (x) { return pad(String(x.role || '?'), 26); }).join(''));
      (c2.metrics || []).forEach(function (m) {
        lines.push('  ' + pad(m.label, 16) + m.formatted.map(function (v, i) {
          return pad(v + (m.better_index === i ? '  <' : ''), 26);
        }).join('') + (m.comparable ? '' : '  [' + m.note + ']'));
      });
      lines.push('  "<" marks the better recorded number on that row. It describes what happened; it is not a projection.');
    } else if (s.kind === 'game_context') {
      lines.push('  game: ' + (d.game || 'unnamed'));
      (d.starters || []).forEach(function (x) {
        lines.push('  ' + (x.side || '?') + ': ' + (x.named || '?') + ' — card says ' + x.starter_status
          + ' (' + x.starter_status_note + ')');
        if (!x.history) { lines.push('    no archive record: ' + x.resolution.code); return; }
        var h = x.history, ov = h.overview;
        lines.push('    archive ' + ov.first_observed_season + '–' + ov.last_observed_season + ': '
          + ov.innings + ' IP, ERA ' + f(ov.era, 'era') + ', K-BB% ' + f(ov.k_minus_bb_pct, 'k_minus_bb_pct')
          + ', weighted index ' + f(ov.weighted_performance_index, 'performance_index'));
        (h.recent_seasons || []).forEach(function (r) {
          lines.push('      ' + r.season + '  ' + pad(r.teams || '?', 28) + pad(r.innings + ' IP', 10)
            + ' ERA ' + pad(f(r.era, 'era'), 6) + ' FIP ' + pad(f(r.fip, 'fip'), 6)
            + ' index ' + f(r.performance_index, 'performance_index'));
        });
        lines.push('      profile: ' + h.profile_link);
      });
      if (d.comparison) {
        lines.push('  side by side [' + d.comparison.scope + ']:');
        (d.comparison.metrics || []).forEach(function (m) {
          lines.push('    ' + pad(m.label, 16) + m.formatted.map(function (v, i) { return pad(v + (m.better_index === i ? '  <' : ''), 22); }).join(''));
        });
      }
    } else {
      lines.push('  ' + JSON.stringify(d).slice(0, 1500));
    }
    return lines.join('\n');
  }
  function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + new Array(n - s.length + 1).join(' '); }

  /* ====================================================================== */
  /* 5. THE CRITIC'S EXTRA CHECKS                                            */
  /*                                                                        */
  /* The prose is checked against the rows that were retrieved. These are    */
  /* the four ways an answer about this archive goes wrong.                  */
  /* ====================================================================== */

  var CURRENT_CLAIM = /\b(this season|current season|so far this year|right now he|currently (he|pitching)|tonight he|his current (era|fip|whip|form))\b/i;
  var INVENTED_DETAIL = /\b(velocity|fastball|slider|changeup|curveball|sinker|cutter|splitter|pitch mix|spin rate|release point|platoon split|versus (lefties|righties)|vs\.? (lhb|rhb)|batter[- ]versus[- ]pitcher|career (against|vs)\.? (the )?[A-Z])/i;
  var RATING_AS_PROBABILITY = /\b(performance index|index of \d)[^.]{0,60}\b(probability|chance|odds|edge|expected value|ev\b|win(s| probability)|implies? a)\b/i;
  var TENURE_AS_CONTRACT = /\b(signed|contract|under contract|free agen|traded to .* in (january|february|march|november|december)|joined .* in \d{4} on)\b/i;

  function criticExtras(o) {
    o = o || {};
    var res = o.result, answer = str(o.answer);
    var findings = [];
    if (!res || !answer) return findings;

    if (res.unavailable && !/could not|unavailable|not (installed|on file|available)|no record|does not (carry|hold)/i.test(answer)) {
      findings.push({ code: 'MLBHIST_INVENTED_ON_FAILURE', severity: 'FAIL',
        detail: 'the historical archive could not be read this turn (' + res.unavailable + ') and the answer does not say so' });
    }
    if (CURRENT_CLAIM.test(answer) && res.coverage) {
      findings.push({ code: 'MLBHIST_ARCHIVE_AS_CURRENT', severity: 'FAIL',
        detail: 'the answer speaks about the current season from an archive that ends in ' + res.coverage.end });
    }
    if (INVENTED_DETAIL.test(answer)) {
      findings.push({ code: 'MLBHIST_INVENTED_DETAIL', severity: 'FAIL',
        detail: 'the answer names velocity, pitch mix, handedness splits or a batter-versus-pitcher record; this archive '
          + 'holds season and team totals only and none of those are in it' });
    }
    if (RATING_AS_PROBABILITY.test(answer)) {
      findings.push({ code: 'MLBHIST_RATING_AS_PROBABILITY', severity: 'FAIL',
        detail: 'performance_index is a descriptive index, not a probability, price or edge' });
    }
    if (TENURE_AS_CONTRACT.test(answer)) {
      findings.push({ code: 'MLBHIST_TENURE_AS_CONTRACT', severity: 'WARN',
        detail: 'the archive records seasons with appearances, not signing, trade or roster dates' });
    }
    /* An ambiguous name the retrieval refused to resolve must not be resolved
       in prose instead. */
    (res.resolution || []).forEach(function (r) {
      if (r.code !== 'AMBIGUOUS_PLAYER') return;
      var picked = (r.candidates || []).filter(function (c) {
        return new RegExp('\\b' + String(c.player_id) + '\\b').test(answer);
      });
      if (!picked.length && !/which|ambiguous|more than one|two pitchers|clarify|do you mean/i.test(answer)) {
        findings.push({ code: 'MLBHIST_AMBIGUITY_RESOLVED_IN_PROSE', severity: 'FAIL',
          detail: '"' + r.asked + '" matches ' + (r.candidates || []).length + ' MLB ids and the answer does not ask which' });
      }
    });
    /* Numbers in the prose that are nowhere in the retrieved rows. Deliberately
       narrow: rates with two decimals and percentages, which is what these
       answers quote and what a model recalls wrongly. */
    var allowed = numbersIn(JSON.stringify(res.sections || []));
    var quoted = (answer.match(/\b\d+\.\d{1,3}\b|\b\d{1,2}\.\d%|\b\d{1,3}%/g) || []);
    var strays = quoted.filter(function (q) {
      var v = parseFloat(q);
      if (!Number.isFinite(v)) return false;
      return !allowed.some(function (a) { return Math.abs(a - v) < 0.011 || Math.abs(a * 100 - v) < 0.11; });
    });
    if (strays.length) {
      findings.push({ code: 'MLBHIST_NUMBER_NOT_RETRIEVED', severity: 'WARN',
        detail: 'the answer quotes ' + strays.slice(0, 4).join(', ') + ' which does not appear in the rows retrieved this turn' });
    }
    return findings;
  }
  function numbersIn(s) {
    var out = [], m, re = /-?\d+(?:\.\d+)?/g;
    while ((m = re.exec(String(s)))) { var v = parseFloat(m[0]); if (Number.isFinite(v)) out.push(v); }
    return out;
  }

  /* ====================================================================== */
  /* 6. TOOLS — registered into EDRESEARCH.TOOLS so the same runTool,        */
  /*    budget and allowlist govern them                                     */
  /*                                                                        */
  /* These are ASYNC: they read a database. runTool awaits a thenable result, */
  /* so a tool that returns a promise is handled exactly like one that does   */
  /* not — the envelope, the validation and the budget are unchanged.         */
  /* ====================================================================== */

  var TOOL_NAMES = ['resolve_mlb_player', 'get_pitcher_overview', 'get_pitcher_season_history',
    'get_pitcher_team_history', 'compare_pitchers', 'search_pitcher_leaderboard', 'get_game_pitcher_context'];

  function registerTools() {
    var Rk = R();
    if (!Rk || !Rk.TOOLS || !Rk.T) return false;
    var T = Rk.T;
    var QL = Q();
    var COV = 'EdgeDesk’s own MLB historical pitching archive (regular seasons only). It is NOT current-season data and '
      + 'cannot say who is pitching tonight, a pitcher’s present club, health, velocity, pitch mix or platoon splits.';

    function tool(name, description, input, run) {
      Rk.TOOLS[name] = { name: name, llm: true, category: 'data', description: description, input: input, output: T.any(), run: run };
    }
    function svcOf(ctx) {
      var s = ctx && ctx.mlb_history;
      return s && typeof s.resolvePlayer === 'function' ? s : null;
    }
    /** Turn the query layer's envelope into the tool layer's, keeping the code. */
    function envOut(env) {
      if (!env) return { ok: false, error: 'the archive returned nothing', missing: ['mlb_history'] };
      if (env.ok === false) {
        return { ok: false, code: env.code, error: env.error || env.code,
          missing: [env.code === 'AMBIGUOUS_PLAYER' ? 'player_choice' : 'records'],
          candidates: (env.data && env.data.candidates) || undefined };
      }
      return {
        ok: true, code: env.code, coverage: env.coverage, rating_version: env.rating_version,
        rating: env.rating, scope: env.scope, sample: env.sample, sources: env.sources,
        notes: env.notes, data: env.data, freshness: 'STALE',
        quality_flags: env.coverage && env.coverage.provisional_seasons && env.coverage.provisional_seasons.length
          ? ['provisional_seasons:' + env.coverage.provisional_seasons.join(',')] : []
      };
    }
    function noService() {
      return { ok: false, error: 'the MLB historical archive is not attached to this turn', missing: ['mlb_history'] };
    }

    tool('resolve_mlb_player',
      'Resolve a pitcher name to one MLB player id inside ' + COV + ' Supply name, or player_id to confirm one. A name '
      + 'matching more than one pitcher comes back AMBIGUOUS_PLAYER with the candidates — ask which is meant, never pick. '
      + 'Optional season or team_id narrow an ambiguous name using what the asker said, not by guessing.',
      T.obj({ name: T.opt(T.str({ max: 80 })), player_id: T.opt(T.int()), season: T.opt(T.int()), team_id: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.resolvePlayer(i).then(envOut) : noService(); });

    tool('get_pitcher_overview',
      'The career window for one pitcher inside ' + COV + ' Totals across the window, the seasons he appeared in, the '
      + 'seasons he did NOT, every club, and his latest observed season. The latest observed season is the last one in '
      + 'the archive, not his current club or role.',
      T.obj({ player_id: T.int() }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.pitcherOverview(i).then(envOut) : noService(); });

    tool('get_pitcher_season_history',
      'Season by season for one pitcher inside ' + COV + ' Each season carries innings, ERA, FIP, WHIP, K%, BB%, K-BB%, '
      + 'role, workload band, the ED_PITCH_PERF_V1 index and the ERA-minus-FIP gap. The year-over-year change between '
      + 'consecutive OBSERVED seasons is computed for you; a comparison spanning a missed season says so. Optional from/to '
      + 'bound the window.',
      T.obj({ player_id: T.int(), from: T.opt(T.int()), to: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.seasonHistory(i).then(envOut) : noService(); });

    tool('get_pitcher_team_history',
      'Performance for each club one pitcher threw for inside ' + COV + ' Includes the season splits for a traded year '
      + '(the club rows are PARTS of that season and must never be added to the season line), the consecutive observed '
      + 'runs with each club, and the gap years. Team duration means seasons with a recorded appearance, not contract dates.',
      T.obj({ player_id: T.int() }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.teamHistory(i).then(envOut) : noService(); });

    tool('compare_pitchers',
      'Compare two to four pitchers inside ' + COV + ' on ONE explicitly named scope: pass season for a single year, or '
      + 'from/to for a range, or neither for the whole window combined. Multi-season sides are recomputed from summed '
      + 'counting statistics and outs, never averaged rates. The better recorded number per metric is marked; that is a '
      + 'description of what happened, not a projection.',
      T.obj({ player_ids: T.arr(T.int(), { max: 4 }), season: T.opt(T.int()), from: T.opt(T.int()), to: T.opt(T.int()),
        metrics: T.opt(T.arr(T.str({ max: 32 }), { max: 12 })) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.compare(i).then(envOut) : noService(); });

    tool('search_pitcher_leaderboard',
      'A season leaderboard inside ' + COV + ' Filter by role (starter / reliever / mixed) and a minimum innings '
      + 'workload, and order by any of: performance_index, era, fip, whip, k_pct, bb_pct, k_minus_bb_pct, k_per_9, '
      + 'bb_per_9, hr_per_9, innings_decimal, saves, holds, strikeouts, walks, games, starts. Position players who '
      + 'pitched are excluded unless exclude_position_players is false. With no minimum workload, short samples sit '
      + 'beside full seasons and the index shrinkage only partly suppresses that — say so if you quote one.',
      T.obj({ season: T.int(), role: T.opt(T.enm(['starter', 'reliever', 'mixed'])), min_innings: T.opt(T.num({ min: 0 })),
        metric: T.opt(T.str({ max: 32 })), order: T.opt(T.enm(['asc', 'desc'])), limit: T.opt(T.int({ min: 1, max: 200 })),
        exclude_position_players: T.opt(T.bool()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.leaderboard(i).then(envOut) : noService(); });

    tool('get_game_pitcher_context',
      'Historical context from ' + COV + ' for the pitchers already attached to an upcoming game. Pass the starters '
      + 'exactly as the card states them, INCLUDING whether each is confirmed, probable or projected — this tool never '
      + 'upgrades that status and never infers tonight’s club from the archive. Returns each starter’s career '
      + 'window, recent seasons and a side-by-side on a scope it names.',
      T.obj({ game: T.opt(T.str({ max: 120 })), compare_season: T.opt(T.int()),
        starters: T.arr(T.obj({ name: T.opt(T.str({ max: 80 })), player_id: T.opt(T.int()), side: T.opt(T.str({ max: 8 })),
          team: T.opt(T.str({ max: 60 })), status: T.opt(T.nul(T.str({ max: 40 }))) }, { open: true }), { max: 4 }) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.gamePitcherContext(i).then(envOut) : noService(); });

    /* Also expose the team board, which the website uses and a question about a
       club's rotation history needs. Not in the brief's seven, but the same
       query layer and the same rules. */
    tool('get_team_pitching_history',
      'One MLB club’s pitching record inside ' + COV + ' Every pitcher who threw for it in the window with his '
      + 'contribution FOR THAT CLUB, optionally narrowed to one season, a role and a minimum workload. A club that '
      + 'changed its name keeps one team id and both names are returned.',
      T.obj({ team_id: T.int(), season: T.opt(T.int()), role: T.opt(T.enm(['starter', 'reliever', 'mixed'])),
        min_innings: T.opt(T.num({ min: 0 })), limit: T.opt(T.int({ min: 1, max: 60 })) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.teamPitching(i).then(envOut) : noService(); });

    return true;
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, TOOL_NAMES: TOOL_NAMES.concat(['get_team_pitching_history']),
    HISTORY_WORDS: HISTORY_WORDS, PITCH_WORDS: PITCH_WORDS, CURRENT_WORDS: CURRENT_WORDS, INTENTS: INTENTS,
    route: route, seasonsIn: seasonsIn, lastNSeasons: lastNSeasons, minInningsIn: minInningsIn,
    pitcherNamesIn: pitcherNamesIn, isFollowUp: isFollowUp, metricFor: metricFor, improvementJoin: improvementJoin,
    sanitizeState: sanitizeState, conversationState: conversationState,
    retrieve: retrieve, promptBlock: promptBlock, renderSection: renderSection,
    criticExtras: criticExtras, registerTools: registerTools
  };
});
/*__EDMLBHIST_END__*/
