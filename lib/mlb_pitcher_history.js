/* ===========================================================================
   EdgeDesk MLB — the historical pitching query layer, shared by the page, the
   pipeline and the desk.

   ONE implementation of every rule the historical record depends on, loaded by
   tools/mlb/*.js under Node (where it is tested), by app.html in the browser
   (where it is displayed) and by supabase/functions/edgedesk_ai (where the AI
   retrieves through it). If the three ever disagreed, a pitcher's rating would
   read one way on a profile page, another in a chat answer, and a third in the
   feature build — which is the failure this file exists to prevent.

   WHAT LIVES HERE, and the rule each part obeys:

     identity    name folding and player resolution. A name matching two MLB
                 ids is AMBIGUOUS and is never silently collapsed onto the
                 busier of the two — the candidates come back and the caller
                 asks. An id is always preferred to a name.
     arithmetic  innings from OUTS, never from the 6.2 display string; every
                 rate recomputed from counting stats so a screen can be checked
                 against the database rather than trusted.
     rating      ED_PITCH_PERF_V1 exactly as the package defines it, with its
                 shrinkage weight and its terms carried beside every number.
     queries     bounded PostgREST reads against the mlbhist schema. Every one
                 has a hard row cap; none of them can ask for the table.
     shaping     season history, team history, comparisons, leaderboards and
                 year-over-year change, computed deterministically here so the
                 model explains numbers rather than producing them.
     outcomes    four different nothings, told apart: a player who cannot be
                 resolved, a player with no record in this window, a query that
                 could not run, and a field that is genuinely undefined.

   WHAT THIS FILE WILL NOT DO
     - It will not turn performance_index into a probability, a fair price or
       an edge. It is a descriptive index; 100 is league average and that is
       the whole claim.
     - It will not add a season row to its own team splits. They are the same
       innings at two grains.
     - It will not present this archive as current-season data. Coverage
       travels on every envelope and ends where the dataset ends.
     - It will not infer today's club, availability or start assignment from
       the last historical row. The most recent season a pitcher appears in is
       a fact about 2016–2025, not about tonight.
   =========================================================================== */
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
