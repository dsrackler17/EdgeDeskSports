/* ===========================================================================
   EdgeDesk Intelligence — THE MLB OFFENSIVE ARCHIVE, 2016–2025.

   The sibling of _mlbhist.js, for hitters. Same four jobs:

     1. ROUTE      decide whether a turn is a historical HITTING question, and
                   which kind. Conservative: a question that merely names a
                   hitter while asking about tonight is not a history question,
                   and routing it here would answer "how is he hitting" with a
                   2019 line.
     2. RETRIEVE   run the deterministic reads that question needs, through the
                   shared query layer, against the database. Numbers are never
                   asked of the model.
     3. PROMPT     hand the model a bounded, labelled block: what was read,
                   over which seasons, at what sample size, and the sentence
                   that keeps it out of tonight.
     4. CRITIC     check the answer the model produced against what was
                   actually retrieved.

   Plus the tools themselves, registered into the shared research tool
   registry so the model can call them mid-turn.

   THE RULE THIS FILE EXISTS TO ENFORCE. This archive ends in 2025. It is
   never current-season data and it is NEVER A LINEUP. Every block it writes
   says so, every tool description says so, and the critic checks the answer
   for the claim it must not make.
   =========================================================================== */
/* The shared offensive query layer, inlined from lib/mlb_offense_history.js by
   tools/presentation/inline.js. It is the SAME file the browser loads with a
   <script> tag and the pipeline requires under Node, so a hitter's K% is
   computed once and reads the same on a profile page, in a chat answer and in
   the feature build. Do not edit it here. */
/*__EDMLBOFF_START__*/
(function (root, factory) {
  var api = factory();
  root.EDMlbBatters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'mlb-offense-history-1.0';
  var SCHEMA = 'mlbhist';
  var RATING_VERSION = 'ED_BAT_PERF_V1';
  var SOURCE = 'MLB Stats API (statsapi.mlb.com/api/v1), regular season, sport 1, game type R, player pool ALL';

  /* The terms the rating was computed under. Carried on every rated answer so
     no screen and no model can print the number without them. */
  var RATING = {
    version: RATING_VERSION,
    scale: '100 is the MLB average for that season; higher is better',
    formula: 'offensive_index = 100 + 100 * PA/(PA+200) * (OBP/league_OBP + SLG/league_SLG - 2)',
    shrinkage: 'PA/(PA+200). The 200-PA constant is a stated design choice, not a fitted one.',
    baseline: 'Every MLB hitter that season, pitchers included.',
    is_not: ['OPS+', 'wRC+', 'WAR', 'a percentile', 'a 0–100 grade', 'park- or opponent-adjusted',
      'a measure of defence', 'a measure of baserunning value', 'a probability', 'a forecast'],
    caveat: 'A rating near 100 over a handful of plate appearances does not establish average true talent. '
      + 'Read it with plate_appearances and sample_flag, which travel with it.'
  };

  var OUTCOMES = {
    OK: 'OK',
    UNRESOLVED_PLAYER: 'UNRESOLVED_PLAYER',
    AMBIGUOUS_PLAYER: 'AMBIGUOUS_PLAYER',
    NO_RECORDS_IN_WINDOW: 'NO_RECORDS_IN_WINDOW',
    EMPTY_RESULT: 'EMPTY_RESULT',
    QUERY_UNAVAILABLE: 'QUERY_UNAVAILABLE',
    NOT_INSTALLED: 'NOT_INSTALLED'
  };

  /* Bounded, because an unbounded read of this archive is 10,098 rows into a
     browser or a model prompt. */
  var LIMITS = {
    search: 25,
    resolve_candidates: 12,
    leaderboard: 100,
    leaderboard_default: 25,
    seasons: 20,
    team_seasons: 60,
    compare_players: 6,
    lineup: 12,
    team_offense: 40,
    /* A full season of qualifying hitters. At a 200-PA screen the archive has
       roughly 350 in a full year, so this is the whole population and not a
       sample of it — bounded, but not so tight that it truncates the answer. */
    season_slice: 800
  };

  /* Every metric the product can rank, compare or trend by, with the direction
     that counts as better. Ranking by a metric whose direction is unknown is
     how a leaderboard silently inverts. */
  var METRICS = {
    offensive_index:  { label: 'Offensive index', better: 'higher', dp: 1, kind: 'index' },
    avg:              { label: 'Batting average', better: 'higher', dp: 3, kind: 'rate3' },
    obp:              { label: 'On-base percentage', better: 'higher', dp: 3, kind: 'rate3' },
    slg:              { label: 'Slugging', better: 'higher', dp: 3, kind: 'rate3' },
    ops:              { label: 'OPS', better: 'higher', dp: 3, kind: 'rate3' },
    iso:              { label: 'Isolated power', better: 'higher', dp: 3, kind: 'rate3' },
    babip:            { label: 'BABIP', better: 'higher', dp: 3, kind: 'rate3' },
    k_pct:            { label: 'Strikeout rate', better: 'lower', dp: 1, kind: 'pct' },
    bb_pct:           { label: 'Walk rate', better: 'higher', dp: 1, kind: 'pct' },
    hr_pct:           { label: 'Home-run rate', better: 'higher', dp: 1, kind: 'pct' },
    sb_success_pct:   { label: 'Stolen-base success', better: 'higher', dp: 1, kind: 'pct' },
    home_runs:        { label: 'Home runs', better: 'higher', dp: 0, kind: 'count' },
    extra_base_hits:  { label: 'Extra-base hits', better: 'higher', dp: 0, kind: 'count' },
    hits:             { label: 'Hits', better: 'higher', dp: 0, kind: 'count' },
    doubles:          { label: 'Doubles', better: 'higher', dp: 0, kind: 'count' },
    triples:          { label: 'Triples', better: 'higher', dp: 0, kind: 'count' },
    runs:             { label: 'Runs', better: 'higher', dp: 0, kind: 'count' },
    rbi:              { label: 'RBI', better: 'higher', dp: 0, kind: 'count' },
    walks:            { label: 'Walks', better: 'higher', dp: 0, kind: 'count' },
    strikeouts:       { label: 'Strikeouts', better: 'lower', dp: 0, kind: 'count' },
    stolen_bases:     { label: 'Stolen bases', better: 'higher', dp: 0, kind: 'count' },
    total_bases:      { label: 'Total bases', better: 'higher', dp: 0, kind: 'count' },
    plate_appearances:{ label: 'Plate appearances', better: 'higher', dp: 0, kind: 'count' },
    at_bats:          { label: 'At-bats', better: 'higher', dp: 0, kind: 'count' },
    games:            { label: 'Games', better: 'higher', dp: 0, kind: 'count' },
    runs_per_game:    { label: 'Runs per game', better: 'higher', dp: 2, kind: 'rate2' }
  };

  var SAMPLE_FLAGS = ['zero_PA', 'under_50_PA', '50_to_199_PA', '200_plus_PA'];

  /* MLB's own qualification rule, not a round number someone liked: 3.1 plate
     appearances per club game. It is a FUNCTION OF THE SEASON because 2020 was
     60 games — applying a 502-PA screen to 2020 silently erases that season,
     which is the single easiest way to get a ten-year leaderboard wrong. */
  var QUALIFIED_PA_PER_GAME = 3.1;
  function qualifiedPA(teamGames) {
    var g = num(teamGames);
    if (g == null || g <= 0) return null;
    return Math.ceil(QUALIFIED_PA_PER_GAME * g);
  }

  /* ───────────────────────────── arithmetic ─────────────────────────────
     Every rate is recomputed here from aggregate numerators and denominators,
     never averaged from component rates, and every one returns null rather
     than a zero when its denominator is empty. */

  function num(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : null;
  }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function str(v) { return v == null ? '' : String(v); }
  function rnd(v, d) { var n = num(v); if (n == null) return null; var m = Math.pow(10, d == null ? 6 : d); return Math.round(n * m) / m; }

  function ratio(top, bottom) {
    var t = num(top), b = num(bottom);
    if (t == null || b == null || b <= 0) return null;
    return t / b;
  }
  function avgOf(hits, atBats) { return rnd(ratio(hits, atBats), 6); }
  function obpOf(o) {
    var h = num(o.hits), bb = num(o.walks), hbp = num(o.hit_by_pitch),
        ab = num(o.at_bats), sf = num(o.sacrifice_flies);
    if (h == null || bb == null || hbp == null || ab == null) return null;
    var den = ab + bb + hbp + (sf == null ? 0 : sf);
    if (den <= 0) return null;
    return rnd((h + bb + hbp) / den, 6);
  }
  function slgOf(totalBases, atBats) { return rnd(ratio(totalBases, atBats), 6); }
  /* OPS is computed from the UNROUNDED components, which is why it is not
     simply obp + slg of the rounded fields. Either component undefined leaves
     OPS undefined — a walk-only line has an on-base percentage and no OPS. */
  function opsOf(o) {
    var ob = obpOf(o), sl = slgOf(o.total_bases, o.at_bats);
    if (ob == null || sl == null) return null;
    return rnd(ob + sl, 6);
  }
  function isoOf(totalBases, hits, atBats) {
    var tb = num(totalBases), h = num(hits), ab = num(atBats);
    if (tb == null || h == null || ab == null || ab <= 0) return null;
    return rnd((tb - h) / ab, 6);
  }
  function babipOf(o) {
    var h = num(o.hits), hr = num(o.home_runs), ab = num(o.at_bats),
        k = num(o.strikeouts), sf = num(o.sacrifice_flies);
    if (h == null || hr == null || ab == null || k == null) return null;
    var den = ab - k - hr + (sf == null ? 0 : sf);
    if (den <= 0) return null;
    return rnd((h - hr) / den, 6);
  }
  function kPct(k, pa) { return rnd(ratio(k, pa), 6); }
  function bbPct(bb, pa) { return rnd(ratio(bb, pa), 6); }
  function hrPct(hr, pa) { return rnd(ratio(hr, pa), 6); }
  function sbSuccess(sb, cs) {
    var s = num(sb), c = num(cs);
    if (s == null || c == null) return null;
    if (s + c <= 0) return null;          /* no attempts is not 0% success */
    return rnd(s / (s + c), 6);
  }
  function extraBaseHits(o) {
    var d = num(o.doubles), t = num(o.triples), hr = num(o.home_runs);
    if (d == null || t == null || hr == null) return null;
    return d + t + hr;
  }
  function singlesOf(o) {
    var h = num(o.hits), d = num(o.doubles), t = num(o.triples), hr = num(o.home_runs);
    if (h == null || d == null || t == null || hr == null) return null;
    return h - d - t - hr;
  }
  function totalBasesOf(o) {
    var s = singlesOf(o), d = num(o.doubles), t = num(o.triples), hr = num(o.home_runs);
    if (s == null || d == null || t == null || hr == null) return null;
    return s + 2 * d + 3 * t + 4 * hr;
  }

  var SHRINK_PA = 200;
  function sampleWeight(pa) {
    var p = num(pa);
    if (p == null || p < 0) return null;
    return rnd(p / (p + SHRINK_PA), 6);
  }
  /* The rating. Undefined whenever either component rate is undefined or the
     league baseline is missing — never coerced to 100. */
  function offensiveIndex(o) {
    var pa = num(o.plate_appearances);
    var obp = o.obp !== undefined ? num(o.obp) : obpOf(o);
    var slg = o.slg !== undefined ? num(o.slg) : slgOf(o.total_bases, o.at_bats);
    var lo = num(o.league_obp), ls = num(o.league_slg);
    if (pa == null || obp == null || slg == null || lo == null || ls == null || lo <= 0 || ls <= 0) return null;
    var w = sampleWeight(pa);
    if (w == null) return null;
    return rnd(100 + 100 * w * (obp / lo + slg / ls - 2), 3);
  }
  function sampleFlagOf(pa) {
    var p = num(pa);
    if (p == null) return null;
    if (p === 0) return 'zero_PA';
    if (p < 50) return 'under_50_PA';
    if (p < 200) return '50_to_199_PA';
    return '200_plus_PA';
  }
  /* Plain-language for a sample flag, because "50_to_199_PA" on a screen is a
     column name rather than a warning. */
  function sampleNote(flag, pa) {
    switch (flag) {
      case 'zero_PA': return 'No plate appearances — every rate and the rating are undefined, not zero.';
      case 'under_50_PA': return 'Fewer than 50 plate appearances' + (pa != null ? ' (' + pa + ')' : '')
        + '. Rates over a sample this small describe what happened, not ability.';
      case '50_to_199_PA': return (pa != null ? pa + ' plate appearances' : 'Under 200 plate appearances')
        + '. The rating is shrunk hard toward 100 at this workload.';
      case '200_plus_PA': return (pa != null ? pa + ' plate appearances' : '200 or more plate appearances') + '.';
      default: return '';
    }
  }
  /* Is a hitting record a HITTER's record? Plate appearances and the
     source-reported position both get a say, and neither is treated as proof.
     Every pitcher who ever batted is in this archive. */
  function battingRole(o) {
    var pa = num(o.plate_appearances);
    var pos = str(o.position_reported).toUpperCase();
    if (pa == null || pa === 0) return 'no_plate_appearances';
    if (pos === 'P' && pa < 50) return 'pitcher_batting';
    if (pa < 50) return 'incidental';
    if (pa < 200) return 'part_time';
    return 'regular';
  }

  /* ───────────────────────────── identity ───────────────────────────── */

  function nameKey(n) {
    return str(n).normalize ? str(n).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
      : str(n).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function nameTokens(n) { var k = nameKey(n); return k ? k.split(' ') : []; }
  function surnameKey(n) { var t = nameTokens(n); return t.length ? t[t.length - 1] : ''; }
  function shortName(n) {
    var t = str(n).trim().split(/\s+/);
    if (t.length < 2) return str(n);
    return t[0].charAt(0) + '. ' + t.slice(1).join(' ');
  }

  /* ───────────────────────────── presentation ───────────────────────────── */

  function fmt(value, metric) {
    var v = num(value);
    if (v == null) return '—';
    var m = METRICS[metric];
    if (!m) return String(v);
    if (m.kind === 'pct') return (v <= 1 ? v * 100 : v).toFixed(m.dp) + '%';
    if (m.kind === 'rate3') return v.toFixed(3).replace(/^0\./, '.');
    if (m.kind === 'rate2') return v.toFixed(2);
    if (m.kind === 'index') return v.toFixed(m.dp);
    return String(Math.round(v));
  }
  function fmtDelta(value, metric) {
    var v = num(value);
    if (v == null) return '—';
    var m = METRICS[metric] || { kind: 'count', dp: 0 };
    var s = v > 0 ? '+' : '';
    if (m.kind === 'pct') return s + (Math.abs(v) <= 1 ? v * 100 : v).toFixed(m.dp) + ' pts';
    if (m.kind === 'rate3') return s + v.toFixed(3);
    if (m.kind === 'rate2') return s + v.toFixed(2);
    if (m.kind === 'index') return s + v.toFixed(m.dp);
    return s + Math.round(v);
  }
  function improved(metric, from, to) {
    var a = num(from), b = num(to);
    if (a == null || b == null) return null;
    var m = METRICS[metric];
    if (!m) return null;
    if (a === b) return false;
    return m.better === 'lower' ? b < a : b > a;
  }
  function coverageNote(cov) {
    if (!cov) return 'Historical MLB regular-season offensive record. Coverage window unknown until an import has been promoted.';
    var s = 'Historical MLB regular-season offensive record, ' + cov.start + '–' + cov.end + '. ';
    s += 'This is not current-season data and it is never a lineup: it cannot say who is batting tonight.';
    if (cov.provisional_seasons && cov.provisional_seasons.length) {
      s += ' ' + cov.provisional_seasons.join(', ') + ' ' + (cov.provisional_seasons.length === 1 ? 'is' : 'are')
        + ' provisional: imported before the regular season completed, so the league baseline and every rating '
        + 'computed against it will change.';
    }
    return s;
  }
  function profileLink(playerId) { return playerId == null ? null : '#research/baseball/b' + playerId; }
  function teamLink(teamId) { return teamId == null ? null : '#research/baseball/t' + teamId; }

  /* ───────────────────────────── columns and queries ───────────────────── */

  var COUNTS = 'games,plate_appearances,at_bats,runs,hits,singles,doubles,triples,home_runs,rbi,'
    + 'walks,intentional_walks,strikeouts,hit_by_pitch,stolen_bases,caught_stealing,total_bases,'
    + 'sacrifice_bunts,sacrifice_flies,grounded_into_double_play,catcher_interference,pitches_seen';
  var RATES = 'avg,obp,slg,ops,iso,babip,k_pct,bb_pct,hr_pct,sb_success_pct,sample_flag';
  var WINDOW_COLS = 'first_observed_season,last_observed_season,seasons_with_records,seasons_with_pa,'
    + 'observed_seasons,boundary_start,boundary_end,rated_plate_appearances,weighted_offensive_index';

  var COLS = {
    season: 'player_id,player_name,season,age,position_reported,team_count,team_ids,teams,'
      + 'team_split_games_sum,' + COUNTS + ',' + RATES
      + ',league_obp,league_slg,rating_sample_weight,rating_version,offensive_index,provisional',
    teamSeason: 'player_id,player_name,season,team_id,team_name,position_reported,age,' + COUNTS + ',' + RATES
      + ',league_obp,league_slg,rating_sample_weight,rating_version,offensive_index,provisional',
    overview: 'player_id,player_name,' + COUNTS + ',' + RATES + ',' + WINDOW_COLS
      + ',team_count,teams,latest_observed_offensive_index,best_season_by_index,rating_version',
    search: 'player_id,player_name,plate_appearances,games,home_runs,ops,' + WINDOW_COLS + ',team_count,teams',
    teamHistory: 'player_id,player_name,team_id,' + COUNTS + ',' + RATES + ',' + WINDOW_COLS + ',team_names_observed',
    runs: 'player_id,player_name,team_id,observed_run_number,' + COUNTS + ',' + RATES + ',' + WINDOW_COLS
      + ',team_names_observed',
    teamOffense: 'season,team_id,team_name,' + COUNTS.replace('games,', '') + ',' + RATES
      + ',league_obp,league_slg,rating_sample_weight,rating_version,offensive_index,'
      + 'player_games_sum,players_with_records,team_games,runs_per_game',
    teamOffenseOverview: 'team_id,' + COUNTS.replace('games,', '') + ',' + RATES + ',' + WINDOW_COLS
      + ',team_names_observed,player_games_sum,team_games,runs_per_game',
    league: 'season,' + COUNTS.replace('games,', '') + ',' + RATES + ',player_games_sum',
    twoWay: 'player_id,player_name,name_key,batting_plate_appearances,batting_games,batting_home_runs,'
      + 'batting_ops,batting_index,batting_first_season,batting_last_season,batting_seasons_with_pa,'
      + 'pitching_outs,pitching_innings,pitching_starts,pitching_era,pitching_index,'
      + 'pitching_first_season,pitching_last_season,pitching_role'
  };

  function clampLimit(n, cap, dflt) {
    var v = int(n);
    if (v == null || v <= 0) return dflt == null ? cap : dflt;
    return Math.min(v, cap);
  }
  function enc(v) { return encodeURIComponent(String(v)); }
  function inList(values) {
    return '(' + (values || []).map(function (v) { return String(v); }).join(',') + ')';
  }

  /* Every filter this layer supports, turned into PostgREST. The ORDER and the
     FILTERING are the database's, not JavaScript's and never a model's: a
     leaderboard computed by ranking text is a leaderboard that can be wrong
     without anyone noticing. */
  function seasonFilters(o) {
    var q = [];
    if (o.season != null) q.push('season=eq.' + int(o.season));
    else {
      if (o.season_from != null) q.push('season=gte.' + int(o.season_from));
      if (o.season_to != null) q.push('season=lte.' + int(o.season_to));
    }
    if (o.min_pa != null) q.push('plate_appearances=gte.' + int(o.min_pa));
    if (o.min_ab != null) q.push('at_bats=gte.' + int(o.min_ab));
    if (o.position) q.push('position_reported=eq.' + enc(o.position));
    if (o.team_id != null) q.push('team_id=eq.' + int(o.team_id));
    if (o.regulars_only) q.push('sample_flag=eq.200_plus_PA');
    else if (o.sample_flag) q.push('sample_flag=eq.' + enc(o.sample_flag));
    if (o.exclude_zero_pa) q.push('plate_appearances=gt.0');
    return q;
  }
  function orderFor(metric, dir) {
    var m = METRICS[metric] ? metric : 'offensive_index';
    var better = METRICS[m].better;
    var d = dir || (better === 'lower' ? 'asc' : 'desc');
    /* nullslast on every ordering: an undefined rate must never lead a board. */
    return 'order=' + m + '.' + d + '.nullslast';
  }

  var QUERIES = {
    status: function () { return { rel: 'offense_status', query: 'select=*&limit=1' }; },
    playerByName: function (o) {
      var key = nameKey(o.name);
      var lim = clampLimit(o.limit, LIMITS.search, LIMITS.resolve_candidates);
      return { rel: 'batter_overview', query: 'select=' + COLS.search + '&name_key=eq.' + enc(key)
        + '&order=plate_appearances.desc&limit=' + lim };
    },
    playerSearch: function (o) {
      var key = nameKey(o.q);
      var lim = clampLimit(o.limit, LIMITS.search, LIMITS.search);
      return { rel: 'batter_overview', query: 'select=' + COLS.search + '&name_key=ilike.' + enc('*' + key + '*')
        + '&order=plate_appearances.desc&limit=' + lim };
    },
    playersByIds: function (o) {
      /* Capped at the LINEUP limit, not the comparison limit: the same query
         serves both, and a nine-hitter lineup is larger than a comparison. */
      var ids = (o.player_ids || []).slice(0, LIMITS.lineup).map(int).filter(function (x) { return x != null; });
      return { rel: 'batter_overview', query: 'select=' + COLS.overview + '&player_id=in.' + inList(ids)
        + '&limit=' + Math.max(ids.length, 1) };
    },
    overview: function (o) {
      return { rel: 'batter_overview', query: 'select=' + COLS.overview + '&player_id=eq.' + int(o.player_id) + '&limit=1' };
    },
    seasons: function (o) {
      var q = ['select=' + COLS.season, 'player_id=eq.' + int(o.player_id)];
      if (o.season != null) q.push('season=eq.' + int(o.season));
      if (o.season_from != null) q.push('season=gte.' + int(o.season_from));
      if (o.season_to != null) q.push('season=lte.' + int(o.season_to));
      q.push('order=season.asc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.seasons, LIMITS.seasons));
      return { rel: 'batter_seasons', query: q.join('&') };
    },
    teamSeasons: function (o) {
      var q = ['select=' + COLS.teamSeason, 'player_id=eq.' + int(o.player_id)];
      if (o.team_id != null) q.push('team_id=eq.' + int(o.team_id));
      if (o.season != null) q.push('season=eq.' + int(o.season));
      q.push('order=season.asc,plate_appearances.desc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.team_seasons, LIMITS.team_seasons));
      return { rel: 'batter_team_seasons', query: q.join('&') };
    },
    teamHistory: function (o) {
      var q = ['select=' + COLS.teamHistory, 'player_id=eq.' + int(o.player_id)];
      q.push('order=plate_appearances.desc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.team_seasons, LIMITS.team_seasons));
      return { rel: 'batter_team_history', query: q.join('&') };
    },
    leaderboard: function (o) {
      var q = ['select=' + COLS.season].concat(seasonFilters(o));
      q.push(orderFor(o.metric, o.direction));
      q.push('limit=' + clampLimit(o.limit, LIMITS.leaderboard, LIMITS.leaderboard_default));
      return { rel: 'batter_seasons', query: q.join('&') };
    },
    /* EVERY hitter in one season who clears a workload screen, ordered by id
       rather than by any metric. A year-over-year comparison intersects two of
       these, and ordering by the metric first would silently drop anyone
       outside the top of either season — which is exactly where the biggest
       movers live. */
    seasonSlice: function (o) {
      var q = ['select=' + COLS.season, 'season=eq.' + int(o.season)];
      if (o.min_pa != null) q.push('plate_appearances=gte.' + int(o.min_pa));
      if (o.metric && METRICS[o.metric]) q.push(o.metric + '=not.is.null');
      q.push('order=player_id.asc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.season_slice, LIMITS.season_slice));
      return { rel: 'batter_seasons', query: q.join('&') };
    },
    teamRoster: function (o) {
      var q = ['select=' + COLS.teamSeason, 'team_id=eq.' + int(o.team_id), 'season=eq.' + int(o.season)];
      if (o.min_pa != null) q.push('plate_appearances=gte.' + int(o.min_pa));
      q.push(orderFor(o.metric || 'plate_appearances', o.direction));
      q.push('limit=' + clampLimit(o.limit, LIMITS.leaderboard, 40));
      return { rel: 'batter_team_seasons', query: q.join('&') };
    },
    teamOffense: function (o) {
      var q = ['select=' + COLS.teamOffense];
      if (o.team_id != null) q.push('team_id=eq.' + int(o.team_id));
      if (o.season != null) q.push('season=eq.' + int(o.season));
      if (o.season_from != null) q.push('season=gte.' + int(o.season_from));
      if (o.season_to != null) q.push('season=lte.' + int(o.season_to));
      q.push(o.season != null ? orderFor(o.metric || 'offensive_index', o.direction) : 'order=season.asc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.team_offense, LIMITS.team_offense));
      return { rel: 'team_offense_seasons', query: q.join('&') };
    },
    teamOffenseOverview: function (o) {
      var q = ['select=' + COLS.teamOffenseOverview];
      if (o.team_id != null) q.push('team_id=eq.' + int(o.team_id));
      q.push('order=runs_per_game.desc.nullslast');
      q.push('limit=' + clampLimit(o.limit, LIMITS.team_offense, LIMITS.team_offense));
      return { rel: 'team_offense_overview', query: q.join('&') };
    },
    league: function (o) {
      var q = ['select=' + COLS.league];
      if (o.season != null) q.push('season=eq.' + int(o.season));
      q.push('order=season.asc&limit=' + LIMITS.seasons);
      return { rel: 'league_offense_seasons', query: q.join('&') };
    },
    twoWay: function (o) {
      var q = ['select=' + COLS.twoWay];
      if (o.player_id != null) q.push('player_id=eq.' + int(o.player_id));
      else if (o.player_ids && o.player_ids.length) q.push('player_id=in.' + inList(o.player_ids.map(int)));
      if (o.min_pa != null) q.push('batting_plate_appearances=gte.' + int(o.min_pa));
      if (o.min_outs != null) q.push('pitching_outs=gte.' + int(o.min_outs));
      q.push('order=batting_plate_appearances.desc');
      q.push('limit=' + clampLimit(o.limit, LIMITS.leaderboard, LIMITS.leaderboard_default));
      return { rel: 'two_way_players', query: q.join('&') };
    }
  };

  /* ───────────────────────────── shaping ───────────────────────────── */

  function parseIdList(v) {
    if (Array.isArray(v)) return v.map(int).filter(function (x) { return x != null; });
    var s = str(v).replace(/[{}]/g, '');
    if (!s) return [];
    return s.split(/[;,]/).map(function (x) { return int(x.trim()); }).filter(function (x) { return x != null; });
  }
  function parseSeasonList(v) {
    if (Array.isArray(v)) return v.map(int).filter(function (x) { return x != null; });
    var s = str(v);
    if (!s) return [];
    return s.split(/[;,]/).map(function (x) { return int(x.trim()); }).filter(function (x) { return x != null; });
  }
  function counts(r) {
    return {
      games: int(r.games), plate_appearances: int(r.plate_appearances), at_bats: int(r.at_bats),
      runs: int(r.runs), hits: int(r.hits), singles: int(r.singles), doubles: int(r.doubles),
      triples: int(r.triples), home_runs: int(r.home_runs), rbi: int(r.rbi),
      walks: int(r.walks), intentional_walks: int(r.intentional_walks), strikeouts: int(r.strikeouts),
      hit_by_pitch: int(r.hit_by_pitch), stolen_bases: int(r.stolen_bases), caught_stealing: int(r.caught_stealing),
      total_bases: int(r.total_bases), sacrifice_bunts: int(r.sacrifice_bunts),
      sacrifice_flies: int(r.sacrifice_flies), grounded_into_double_play: int(r.grounded_into_double_play),
      catcher_interference: int(r.catcher_interference), pitches_seen: int(r.pitches_seen)
    };
  }
  function rates(r) {
    return {
      avg: num(r.avg), obp: num(r.obp), slg: num(r.slg), ops: num(r.ops),
      iso: num(r.iso), babip: num(r.babip),
      k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), hr_pct: num(r.hr_pct),
      sb_success_pct: num(r.sb_success_pct),
      sample_flag: r.sample_flag || null
    };
  }
  function windowFields(r) {
    var seasons = parseSeasonList(r.observed_seasons);
    return {
      first_observed_season: int(r.first_observed_season),
      last_observed_season: int(r.last_observed_season),
      seasons_with_records: int(r.seasons_with_records),
      seasons_with_pa: int(r.seasons_with_pa),
      observed_seasons: seasons,
      missed_seasons: missedSeasons(seasons),
      boundary_start: r.boundary_start === true || r.boundary_start === 'true' || r.boundary_start === 1,
      boundary_end: r.boundary_end === true || r.boundary_end === 'true' || r.boundary_end === 1,
      rated_plate_appearances: int(r.rated_plate_appearances),
      weighted_offensive_index: num(r.weighted_offensive_index)
    };
  }
  /* The years inside an observed span with no record at all. A gap is a fact a
     reader should see — injury, the minors, inactivity or another club — not a
     hole quietly closed by drawing a line across it. */
  function missedSeasons(seasons) {
    if (!seasons || seasons.length < 2) return [];
    var out = [], lo = Math.min.apply(null, seasons), hi = Math.max.apply(null, seasons);
    for (var y = lo; y <= hi; y++) if (seasons.indexOf(y) < 0) out.push(y);
    return out;
  }

  function shapeSeason(r) {
    if (!r) return null;
    var o = Object.assign({
      player_id: int(r.player_id), player_name: str(r.player_name), season: int(r.season),
      age: int(r.age), position_reported: r.position_reported || null,
      team_count: int(r.team_count), team_ids: parseIdList(r.team_ids), teams: str(r.teams),
      team_split_games_sum: int(r.team_split_games_sum)
    }, counts(r), rates(r));
    o.extra_base_hits = extraBaseHits(o);
    o.league_obp = num(r.league_obp);
    o.league_slg = num(r.league_slg);
    o.rating_sample_weight = num(r.rating_sample_weight);
    o.rating_version = r.rating_version || RATING_VERSION;
    o.offensive_index = num(r.offensive_index);
    o.provisional = r.provisional === true || r.provisional === 'true';
    o.batting_role = battingRole(o);
    o.sample_note = sampleNote(o.sample_flag, o.plate_appearances);
    return o;
  }
  function shapeTeamSeason(r) {
    if (!r) return null;
    var o = Object.assign({
      player_id: int(r.player_id), player_name: str(r.player_name), season: int(r.season),
      team_id: int(r.team_id), team_name: str(r.team_name),
      age: int(r.age), position_reported: r.position_reported || null
    }, counts(r), rates(r));
    o.extra_base_hits = extraBaseHits(o);
    o.league_obp = num(r.league_obp);
    o.league_slg = num(r.league_slg);
    o.rating_sample_weight = num(r.rating_sample_weight);
    o.rating_version = r.rating_version || RATING_VERSION;
    o.offensive_index = num(r.offensive_index);
    o.provisional = r.provisional === true || r.provisional === 'true';
    o.batting_role = battingRole(o);
    o.sample_note = sampleNote(o.sample_flag, o.plate_appearances);
    return o;
  }
  function shapeOverview(r) {
    if (!r) return null;
    var o = Object.assign({
      player_id: int(r.player_id), player_name: str(r.player_name)
    }, counts(r), rates(r), windowFields(r));
    o.extra_base_hits = extraBaseHits(o);
    o.team_count = int(r.team_count);
    o.teams = str(r.teams);
    o.latest_observed_offensive_index = num(r.latest_observed_offensive_index);
    o.best_season_by_index = int(r.best_season_by_index);
    o.rating_version = r.rating_version || RATING_VERSION;
    o.batting_role = battingRole(o);
    o.sample_note = sampleNote(o.sample_flag, o.plate_appearances);
    return o;
  }
  function shapeTeamHistory(r) {
    if (!r) return null;
    var o = Object.assign({
      player_id: int(r.player_id), player_name: str(r.player_name), team_id: int(r.team_id)
    }, counts(r), rates(r), windowFields(r));
    o.extra_base_hits = extraBaseHits(o);
    o.team_names_observed = str(r.team_names_observed);
    o.observed_run_number = int(r.observed_run_number);
    return o;
  }
  function shapeTeamOffense(r) {
    if (!r) return null;
    var o = Object.assign({
      season: int(r.season), team_id: int(r.team_id), team_name: str(r.team_name)
    }, counts(r), rates(r));
    delete o.games;                      /* a club-season has team_games, not player games */
    o.extra_base_hits = extraBaseHits(o);
    o.league_obp = num(r.league_obp);
    o.league_slg = num(r.league_slg);
    o.rating_sample_weight = num(r.rating_sample_weight);
    o.rating_version = r.rating_version || RATING_VERSION;
    o.offensive_index = num(r.offensive_index);
    o.player_games_sum = int(r.player_games_sum);
    o.players_with_records = int(r.players_with_records);
    o.team_games = int(r.team_games);
    o.runs_per_game = num(r.runs_per_game);
    o.qualified_pa = qualifiedPA(o.team_games);
    return o;
  }
  function shapeTeamOffenseOverview(r) {
    if (!r) return null;
    var o = Object.assign({ team_id: int(r.team_id) }, counts(r), rates(r), windowFields(r));
    delete o.games;
    o.extra_base_hits = extraBaseHits(o);
    o.team_names_observed = str(r.team_names_observed);
    o.player_games_sum = int(r.player_games_sum);
    o.team_games = int(r.team_games);
    o.runs_per_game = num(r.runs_per_game);
    return o;
  }
  function shapeTwoWay(r) {
    if (!r) return null;
    return {
      player_id: int(r.player_id), player_name: str(r.player_name),
      batting: {
        plate_appearances: int(r.batting_plate_appearances), games: int(r.batting_games),
        home_runs: int(r.batting_home_runs), ops: num(r.batting_ops),
        offensive_index: num(r.batting_index),
        first_observed_season: int(r.batting_first_season),
        last_observed_season: int(r.batting_last_season),
        seasons_with_pa: int(r.batting_seasons_with_pa),
        rating_version: RATING_VERSION
      },
      pitching: {
        outs: int(r.pitching_outs), innings: str(r.pitching_innings), starts: int(r.pitching_starts),
        era: num(r.pitching_era), performance_index: num(r.pitching_index),
        first_observed_season: int(r.pitching_first_season),
        last_observed_season: int(r.pitching_last_season),
        role: r.pitching_role || null,
        rating_version: 'ED_PITCH_PERF_V1'
      },
      note: 'Both sides are the same MLB person id in two archives. The two ratings are different indexes on '
        + 'different scales and are never combined into one number.'
    };
  }

  /* ───────────────────────── aggregation and trends ───────────────────── */

  /* Sum a set of season rows into one line. Counting fields add; EVERY RATE IS
     RECOMPUTED from the summed numerators and denominators, which is the only
     correct way and the reason this function exists rather than a reduce in
     three different files. */
  function aggregateSeasons(rows, leagueBy) {
    var list = (rows || []).filter(Boolean);
    if (!list.length) return null;
    var out = { seasons: [], team_ids: [] };
    var fields = ['games', 'plate_appearances', 'at_bats', 'runs', 'hits', 'singles', 'doubles', 'triples',
      'home_runs', 'rbi', 'walks', 'intentional_walks', 'strikeouts', 'hit_by_pitch', 'stolen_bases',
      'caught_stealing', 'total_bases', 'sacrifice_bunts', 'sacrifice_flies', 'grounded_into_double_play',
      'catcher_interference', 'pitches_seen'];
    fields.forEach(function (f) { out[f] = 0; });
    var anyBy = {};
    list.forEach(function (r) {
      if (r.season != null && out.seasons.indexOf(r.season) < 0) out.seasons.push(r.season);
      (r.team_ids || []).forEach(function (t) { if (out.team_ids.indexOf(t) < 0) out.team_ids.push(t); });
      if (r.team_id != null && out.team_ids.indexOf(r.team_id) < 0) out.team_ids.push(r.team_id);
      fields.forEach(function (f) {
        var v = num(r[f]);
        if (v == null) { anyBy[f] = true; return; }
        out[f] += v;
      });
    });
    fields.forEach(function (f) { if (anyBy[f] && out[f] === 0) out[f] = null; });
    out.seasons.sort(function (a, b) { return a - b; });
    out.avg = avgOf(out.hits, out.at_bats);
    out.obp = obpOf(out);
    out.slg = slgOf(out.total_bases, out.at_bats);
    out.ops = opsOf(out);
    out.iso = isoOf(out.total_bases, out.hits, out.at_bats);
    out.babip = babipOf(out);
    out.k_pct = kPct(out.strikeouts, out.plate_appearances);
    out.bb_pct = bbPct(out.walks, out.plate_appearances);
    out.hr_pct = hrPct(out.home_runs, out.plate_appearances);
    out.sb_success_pct = sbSuccess(out.stolen_bases, out.caught_stealing);
    out.extra_base_hits = extraBaseHits(out);
    out.sample_flag = sampleFlagOf(out.plate_appearances);
    out.sample_note = sampleNote(out.sample_flag, out.plate_appearances);
    /* A multi-season index is the PA-WEIGHTED MEAN of the annual ratings, not
       a rating of the summed line: the league baseline moved between those
       seasons, and one aggregate rate measured against one year's baseline
       would be a different and unstated quantity. */
    var wsum = 0, wpa = 0;
    list.forEach(function (r) {
      var idx = num(r.offensive_index), pa = num(r.plate_appearances);
      if (idx == null || pa == null || pa <= 0) return;
      wsum += idx * pa; wpa += pa;
    });
    out.weighted_offensive_index = wpa > 0 ? rnd(wsum / wpa, 3) : null;
    out.rated_plate_appearances = wpa || 0;
    out.rating_version = RATING_VERSION;
    out.rating_note = 'PA-weighted mean of the annual ratings, each computed against its own season’s league '
      + 'baseline. It is not a rating of the summed line.';
    if (leagueBy) out.league_note = 'League baselines differ by season; see league_offense_seasons.';
    return out;
  }

  var YOY_METRICS = ['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'k_pct', 'bb_pct', 'hr_pct',
    'home_runs', 'plate_appearances', 'stolen_bases', 'offensive_index'];

  function yearOverYear(seasonRows) {
    var rows = (seasonRows || []).slice().sort(function (a, b) { return a.season - b.season; });
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var a = rows[i - 1], b = rows[i];
      var step = { from: a.season, to: b.season, gap: b.season - a.season - 1, metrics: {} };
      YOY_METRICS.forEach(function (m) {
        var x = num(a[m]), y = num(b[m]);
        step.metrics[m] = {
          from: x, to: y,
          delta: (x == null || y == null) ? null : rnd(y - x, 6),
          improved: improved(m, x, y)
        };
      });
      /* A gap year is not a trend. Two seasons two years apart are compared
         because that is what the reader asked for, and the gap is stated. */
      if (step.gap > 0) step.note = step.gap + ' season' + (step.gap === 1 ? '' : 's')
        + ' with no record between these two.';
      out.push(step);
    }
    return out;
  }
  function netChange(rows, metric) {
    var list = (rows || []).filter(function (r) { return num(r[metric]) != null; })
      .sort(function (a, b) { return a.season - b.season; });
    if (list.length < 2) return null;
    var a = list[0], b = list[list.length - 1];
    return { metric: metric, from_season: a.season, to_season: b.season,
      from: num(a[metric]), to: num(b[metric]), delta: rnd(num(b[metric]) - num(a[metric]), 6),
      improved: improved(metric, a[metric], b[metric]) };
  }

  var COMPARE_METRICS = ['plate_appearances', 'games', 'avg', 'obp', 'slg', 'ops', 'iso', 'babip',
    'k_pct', 'bb_pct', 'hr_pct', 'home_runs', 'extra_base_hits', 'stolen_bases', 'sb_success_pct',
    'offensive_index'];

  /* A comparison is a table plus an explicit statement of what is NOT
     comparable. Two hitters measured over different seasons are compared
     against different league baselines, and this says so rather than letting a
     reader assume otherwise. */
  function compareBatters(sides, o) {
    o = o || {};
    var list = (sides || []).filter(Boolean);
    if (list.length < 2) return null;
    var metrics = (o.metrics && o.metrics.length ? o.metrics : COMPARE_METRICS).filter(function (m) { return METRICS[m]; });
    var rows = metrics.map(function (m) {
      var values = list.map(function (s) { return num(s[m]); });
      var defined = values.filter(function (v) { return v != null; });
      var lead = null;
      if (defined.length === list.length && list.length > 1) {
        var best = METRICS[m].better === 'lower' ? Math.min.apply(null, values) : Math.max.apply(null, values);
        var winners = [];
        values.forEach(function (v, i) { if (v === best) winners.push(i); });
        lead = winners.length === 1 ? winners[0] : null;
      }
      return { metric: m, label: METRICS[m].label, better: METRICS[m].better,
        values: values, lead: lead,
        incomparable: defined.length !== list.length
          ? 'not published for every hitter here' : null };
    });
    var spans = list.map(function (s) {
      return s.seasons && s.seasons.length ? (Math.min.apply(null, s.seasons) + '–' + Math.max.apply(null, s.seasons))
        : (s.first_observed_season != null ? s.first_observed_season + '–' + s.last_observed_season
          : (s.season != null ? String(s.season) : null));
    });
    var sameSpan = spans.every(function (x) { return x === spans[0]; });
    return {
      players: list.map(function (s) {
        return { player_id: s.player_id, player_name: s.player_name,
          plate_appearances: s.plate_appearances, sample_flag: s.sample_flag,
          link: profileLink(s.player_id) };
      }),
      spans: spans,
      rows: rows,
      rating_version: RATING_VERSION,
      note: (sameSpan
        ? 'Both lines cover the same seasons, so the league baseline behind each rating is the same.'
        : 'These lines cover DIFFERENT seasons (' + spans.join(' vs ') + '). Each rating was computed against its '
          + 'own season’s league baseline, so the ratings are comparable only in the sense that each says where '
          + 'that hitter stood in the years he played.')
        + ' Plate appearances are shown because a rate over a small sample is not a smaller version of the same '
        + 'fact — it is a less certain one.'
    };
  }

  /* Was an OPS driven by reaching base or by power? The question the desk is
     actually asked, answered by putting each component against its own league
     baseline rather than against the other. */
  function opsDecomposition(row, league) {
    var obp = num(row.obp), slg = num(row.slg);
    var lo = num(league && league.obp), ls = num(league && league.slg);
    if (obp == null || slg == null) {
      return { available: false,
        reason: obp == null && slg == null ? 'neither on-base percentage nor slugging is defined for this line'
          : (obp == null ? 'on-base percentage is not defined for this line'
            : 'slugging is not defined for this line — a hitter with walks and no at-bats has an OBP and no SLG') };
    }
    if (lo == null || ls == null || lo <= 0 || ls <= 0) {
      return { available: false, obp: obp, slg: slg,
        reason: 'no league baseline on file for this season, so neither half can be placed against the league' };
    }
    var obpRel = obp / lo, slgRel = slg / ls;
    var lead = Math.abs(obpRel - slgRel) < 0.02 ? 'balanced' : (obpRel > slgRel ? 'on_base' : 'power');
    return {
      available: true,
      obp: obp, slg: slg, league_obp: lo, league_slg: ls,
      obp_vs_league: rnd(obpRel, 4), slg_vs_league: rnd(slgRel, 4),
      obp_pct_above_league: rnd((obpRel - 1) * 100, 1),
      slg_pct_above_league: rnd((slgRel - 1) * 100, 1),
      lead: lead,
      text: lead === 'balanced'
        ? 'On-base and power stand almost equally far from the league baseline, so the OPS is not driven by one half.'
        : (lead === 'on_base'
          ? 'Reaching base is further above the league baseline than the power is, so this OPS is led by on-base.'
          : 'Power is further above the league baseline than the on-base is, so this OPS is led by slugging.'),
      note: 'Each half is measured against the same season’s league rate. OPS adds two rates with different '
        + 'denominators, which is why it is read this way rather than split by arithmetic.'
    };
  }

  /* ───────────────────────────── envelope ───────────────────────────── */

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
      historical: o.historical === false ? false : true,
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

  function simpleCache(ttlMs) {
    var m = {};
    return {
      get: function (k) {
        var hit = m[k];
        if (!hit) return null;
        if (Date.now() - hit.at > ttlMs) { delete m[k]; return null; }
        return hit.v;
      },
      set: function (k, v) { m[k] = { at: Date.now(), v: v }; return v; },
      clear: function () { m = {}; }
    };
  }

  /* ───────────────────────────── service ─────────────────────────────
     Built over ONE injected read function, so the browser passes its
     authenticated fetch, the edge function passes its own reader and a test
     passes a real database. Nothing here knows how the rows arrive.

       read(rel, query) -> Promise<Array<row>>   (throws on failure)
   */
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
        return 'the mlb_offense_history contract is not installed in this database — run '
          + 'supabase/mlb_offense_history.sql once in the Supabase SQL editor and check that every row of its '
          + 'report reads ok';
      }
      return s;
    }
    async function q(spec) {
      var rows = await read(spec.rel, spec.query);
      return Array.isArray(rows) ? rows : [];
    }

    async function status(force) {
      var hit = !force && cache.get('status');
      if (hit) return hit;
      try {
        var rows = await q(QUERIES.status());
        if (!rows.length) {
          return failure(OUTCOMES.NO_RECORDS_IN_WINDOW,
            'the offensive archive schema is installed but no import has been promoted yet');
        }
        var r = rows[0];
        var cov = {
          start: int(r.coverage_start), end: int(r.coverage_end),
          provisional_seasons: parseSeasonList(r.provisional_seasons),
          rating_version: r.rating_version || RATING_VERSION,
          built_at: r.dataset_built_at || null,
          promoted_at: r.promoted_at || null,
          source: r.source || SOURCE,
          rows: {
            batter_seasons: int(r.live_batter_seasons),
            batter_team_seasons: int(r.live_batter_team_seasons),
            batters: int(r.live_batters),
            batters_with_pa: int(r.live_batters_with_pa),
            team_offense_seasons: int(r.live_team_offense_seasons)
          },
          validation: r.validation || null,
          source_repairs: int(r.source_repairs),
          transformations: r.transformations || null
        };
        var env = envelope({ coverage: cov, data: cov, notes: [coverageNote(cov)] });
        cache.set('status', env);
        setTimeout(function () { try { cache.set('status', null); } catch (e) { /* no-op */ } }, statusTtl);
        return env;
      } catch (e) {
        return failure(classify(e), reason(e));
      }
    }
    async function coverage() {
      var st = await status();
      return st.ok ? st.coverage : null;
    }

    /* League baselines, read once and reused: every rating on screen is
       relative to one of these, and a screen that cannot name the baseline
       cannot explain the rating. */
    async function leagueBaselines(force) {
      var hit = !force && cache.get('league');
      if (hit) return hit;
      try {
        var rows = await q(QUERIES.league({}));
        var by = {};
        rows.forEach(function (r) { by[int(r.season)] = Object.assign({ season: int(r.season) }, counts(r), rates(r)); });
        var env = envelope({ data: by, coverage: await coverage() });
        cache.set('league', env);
        return env;
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* AMBIGUITY IS NEVER RESOLVED BY PICKING THE BUSIER PLAYER. MLB ids are the
       join key; two hitters who fold to one name are returned as candidates
       for the caller to choose between. */
    async function resolveHitter(o) {
      o = o || {};
      var cov = await coverage();
      if (o.player_id != null) {
        try {
          var rows = await q(QUERIES.overview({ player_id: o.player_id }));
          if (!rows.length) {
            return failure(OUTCOMES.UNRESOLVED_PLAYER,
              'no hitting record for MLB id ' + o.player_id + ' inside ' + (cov ? cov.start + '–' + cov.end : 'this window'),
              { coverage: cov });
          }
          return envelope({ coverage: cov, data: { resolved: shapeOverview(rows[0]), candidates: [] } });
        } catch (e) { return failure(classify(e), reason(e)); }
      }
      if (!o.name) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'no name or MLB id was given');
      try {
        var exact = await q(QUERIES.playerByName({ name: o.name }));
        var pool = exact;
        if (!pool.length) pool = await q(QUERIES.playerSearch({ q: o.name }));
        var shaped = pool.map(shapeOverview);
        if (!shaped.length) {
          return failure(OUTCOMES.UNRESOLVED_PLAYER,
            'no hitter matching “' + o.name + '” has a record inside '
            + (cov ? cov.start + '–' + cov.end : 'this window')
            + '. A player with no MLB plate appearance in this window is absent by design.',
            { coverage: cov });
        }
        if (shaped.length === 1) {
          return envelope({ coverage: cov, data: { resolved: shaped[0], candidates: [] } });
        }
        return failure(OUTCOMES.AMBIGUOUS_PLAYER,
          shaped.length + ' hitters match “' + o.name + '” in this archive. MLB ids are the join key, not names, '
          + 'so EdgeDesk will not pick one.',
          { coverage: cov, data: { resolved: null, candidates: shaped } });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function search(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = await q(QUERIES.playerSearch({ q: o.q, limit: o.limit }));
        var shaped = rows.map(shapeOverview);
        return envelope({ coverage: cov, code: shaped.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          data: shaped, scope: { query: o.q } });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function hitterOverview(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var res = o.player_id != null ? { ok: true, data: { resolved: null } } : await resolveHitter(o);
        var pid = o.player_id != null ? int(o.player_id) : (res.ok && res.data.resolved ? res.data.resolved.player_id : null);
        if (pid == null) return res;
        var ovRows = await q(QUERIES.overview({ player_id: pid }));
        if (!ovRows.length) {
          return failure(OUTCOMES.UNRESOLVED_PLAYER, 'no hitting record for MLB id ' + pid + ' in this window',
            { coverage: cov });
        }
        var ov = shapeOverview(ovRows[0]);
        var seasons = (await q(QUERIES.seasons({ player_id: pid }))).map(shapeSeason);
        var teams = (await q(QUERIES.teamHistory({ player_id: pid }))).map(shapeTeamHistory);
        var lg = await leagueBaselines();
        var last = seasons.filter(function (s) { return s.plate_appearances > 0; }).slice(-1)[0] || null;
        var decomposition = last && lg.ok ? opsDecomposition(last, lg.data[last.season]) : null;
        return envelope({
          coverage: cov,
          scope: { player_id: pid, seasons: ov.observed_seasons },
          sample: { plate_appearances: ov.plate_appearances, sample_flag: ov.sample_flag,
            batting_role: ov.batting_role, note: ov.sample_note },
          data: {
            overview: ov,
            seasons: seasons,
            teams: teams,
            year_over_year: yearOverYear(seasons.filter(function (s) { return s.plate_appearances > 0; })),
            latest_ops_decomposition: decomposition,
            link: profileLink(pid)
          },
          notes: [coverageNote(cov)]
        });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function seasonHistory(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = (await q(QUERIES.seasons(o))).map(shapeSeason);
        return envelope({ coverage: cov, code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { player_id: int(o.player_id), season_from: o.season_from, season_to: o.season_to },
          data: rows, notes: [coverageNote(cov)] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function teamHistory(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var history = (await q(QUERIES.teamHistory(o))).map(shapeTeamHistory);
        var splits = (await q(QUERIES.teamSeasons(o))).map(shapeTeamSeason);
        return envelope({ coverage: cov, code: history.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { player_id: int(o.player_id) },
          data: { by_team: history, by_team_season: splits },
          notes: [coverageNote(cov),
            'Club rows are seasons with a recorded MLB hitting appearance, not verified contract, trade or roster '
            + 'dates. The per-club lines are the SAME performance as the combined season lines, split — never add '
            + 'the two together.'] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function compare(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var ids = (o.player_ids || []).map(int).filter(function (x) { return x != null; }).slice(0, LIMITS.compare_players);
        if (ids.length < 2) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'a comparison needs at least two MLB ids');
        var sides;
        if (o.season != null || o.season_from != null || o.season_to != null) {
          sides = [];
          for (var i = 0; i < ids.length; i++) {
            var rows = (await q(QUERIES.seasons({ player_id: ids[i], season: o.season,
              season_from: o.season_from, season_to: o.season_to }))).map(shapeSeason);
            var agg = aggregateSeasons(rows);
            if (agg) { agg.player_id = ids[i]; agg.player_name = rows.length ? rows[0].player_name : String(ids[i]); }
            sides.push(agg || { player_id: ids[i], player_name: String(ids[i]), plate_appearances: null });
          }
        } else {
          sides = (await q(QUERIES.playersByIds({ player_ids: ids }))).map(shapeOverview);
        }
        var table = compareBatters(sides, { metrics: o.metrics });
        if (!table) return failure(OUTCOMES.EMPTY_RESULT, 'not enough hitters resolved to compare');
        return envelope({ coverage: cov, scope: { player_ids: ids, season: o.season,
          season_from: o.season_from, season_to: o.season_to },
          data: table, notes: [coverageNote(cov)] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* The leaderboard. Ordered and filtered BY THE DATABASE. The only thing
       this function adds is the qualification note, because a leaderboard with
       no workload screen and one with a 502-PA screen are different questions
       and a reader has to be told which one they are looking at. */
    async function leaderboard(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = (await q(QUERIES.leaderboard(o))).map(shapeSeason);
        var metric = METRICS[o.metric] ? o.metric : 'offensive_index';
        var notes = [coverageNote(cov)];
        if (o.season != null) {
          var tg = await teamGamesFor(o.season);
          var qual = qualifiedPA(tg);
          if (qual != null) {
            notes.push(o.min_pa != null
              ? 'Workload screen: ' + o.min_pa + '+ plate appearances. MLB’s own qualification for '
                + o.season + ' is ' + qual + ' PA (3.1 per club game across ' + tg + ' games).'
              : 'No workload screen was applied. MLB’s own qualification for ' + o.season + ' is ' + qual
                + ' PA (3.1 per club game across ' + tg + ' games), and small samples are ranked here beside '
                + 'full seasons.');
            if (o.season === 2020) {
              notes.push('2020 was a 60-game season. A 502-PA screen borrowed from a full year would erase it '
                + 'entirely, which is why the qualification above is computed from that season’s actual club games.');
            }
          }
        }
        return envelope({ coverage: cov, code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { season: o.season, season_from: o.season_from, season_to: o.season_to,
            metric: metric, min_pa: o.min_pa, min_ab: o.min_ab, position: o.position,
            team_id: o.team_id, regulars_only: !!o.regulars_only, ordered_by: 'database' },
          data: rows, notes: notes });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function teamGamesFor(season) {
      var key = 'tg:' + season;
      var hit = cache.get(key);
      if (hit != null) return hit;
      try {
        var rows = await q({ rel: 'team_offense_seasons',
          query: 'select=team_games&season=eq.' + int(season) + '&order=team_games.desc&limit=1' });
        var g = rows.length ? int(rows[0].team_games) : null;
        cache.set(key, g);
        return g;
      } catch (e) { return null; }
    }

    async function teamOffense(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = (await q(QUERIES.teamOffense(o))).map(shapeTeamOffense);
        var roster = null;
        if (o.team_id != null && o.season != null && o.with_roster !== false) {
          roster = (await q(QUERIES.teamRoster({ team_id: o.team_id, season: o.season,
            min_pa: o.roster_min_pa, metric: o.roster_metric || 'plate_appearances',
            limit: o.roster_limit }))).map(shapeTeamSeason);
        }
        return envelope({ coverage: cov, code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { team_id: o.team_id, season: o.season, season_from: o.season_from, season_to: o.season_to },
          data: { seasons: rows, roster: roster },
          notes: [coverageNote(cov),
            'runs_per_game uses the club’s ACTUAL games from MLB’s team endpoint. player_games_sum is the sum of '
            + 'player games and is not a club’s games.'] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    async function teamOffenseHistory(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = (await q(QUERIES.teamOffenseOverview(o))).map(shapeTeamOffenseOverview);
        return envelope({ coverage: cov, code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { team_id: o.team_id }, data: rows, notes: [coverageNote(cov)] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* HISTORICAL context for a set of hitters a CURRENT source says are in a
       lineup. This function is given the names; it never produces them. That
       separation is the whole point: the archive can say what these hitters
       have done, and nothing anywhere can make it say who is playing tonight. */
    async function lineupContext(o) {
      o = o || {};
      var names = (o.names || []).slice(0, LIMITS.lineup);
      var ids = (o.player_ids || []).map(int).filter(function (x) { return x != null; }).slice(0, LIMITS.lineup);
      if (!names.length && !ids.length) {
        return failure(OUTCOMES.EMPTY_RESULT,
          'no hitters were supplied. This function adds history to a lineup a CURRENT source has already '
          + 'established; it cannot produce the lineup.');
      }
      try {
        var cov = await coverage();
        var unresolved = [], ambiguous = [], wanted = ids.slice();
        for (var i = 0; i < names.length; i++) {
          var r = await resolveHitter({ name: names[i] });
          if (r.ok && r.data.resolved) wanted.push(r.data.resolved.player_id);
          else if (r.code === OUTCOMES.AMBIGUOUS_PLAYER) {
            ambiguous.push({ name: names[i], candidates: (r.data && r.data.candidates) || [] });
          } else unresolved.push({ name: names[i], reason: r.error });
        }
        wanted = wanted.filter(function (v, ix, a) { return v != null && a.indexOf(v) === ix; });
        /* THE FULL ROWS, RE-READ BY ID. resolveHitter answers from the search
           projection, which carries identity and workload but not the counting
           fields — enough to name a hitter, not enough to add one up. The
           combined line below sums those counting fields, so it reads them
           explicitly rather than quietly aggregating a row full of holes. One
           bounded query for the whole lineup. */
        var resolved = wanted.length
          ? (await q(QUERIES.playersByIds({ player_ids: wanted }))).map(shapeOverview) : [];
        wanted.forEach(function (id) {
          if (!resolved.some(function (p) { return p.player_id === id; })) {
            unresolved.push({ player_id: id, reason: 'no hitting record in this window' });
          }
        });
        /* The lineup's profile is the SUM of its hitters' lines, with every
           rate recomputed from the summed numerators — never the mean of nine
           batting averages. */
        var agg = aggregateSeasons(resolved.filter(function (p) { return p.plate_appearances > 0; }));
        return envelope({
          coverage: cov,
          historical: true,
          scope: { requested: names.length + ids.length, resolved: resolved.length },
          data: {
            hitters: resolved.map(function (p) {
              return { player_id: p.player_id, player_name: p.player_name,
                plate_appearances: p.plate_appearances, sample_flag: p.sample_flag,
                batting_role: p.batting_role,
                avg: p.avg, obp: p.obp, slg: p.slg, ops: p.ops, iso: p.iso,
                k_pct: p.k_pct, bb_pct: p.bb_pct, hr_pct: p.hr_pct,
                home_runs: p.home_runs, stolen_bases: p.stolen_bases,
                weighted_offensive_index: p.weighted_offensive_index,
                first_observed_season: p.first_observed_season,
                last_observed_season: p.last_observed_season,
                link: profileLink(p.player_id) };
            }),
            combined: agg,
            unresolved: unresolved,
            ambiguous: ambiguous
          },
          notes: [coverageNote(cov),
            'THIS IS NOT A LINEUP. It is the 2016–2025 record of hitters a current source named. Who bats tonight, '
            + 'and in what order, comes from the live lineup feed and from nowhere else.',
            'The combined line sums each hitter’s counting totals and recomputes every rate from those sums. '
            + 'Averaging nine batting averages would be a different and wrong number.',
            'This archive holds no handedness splits, no batter-versus-pitcher history and no pitch-type data, '
            + 'so none of those appear here.'] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* Ohtani and everyone like him: ONE MLB id, both archives. */
    async function twoWay(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var rows = (await q(QUERIES.twoWay(o))).map(shapeTwoWay);
        return envelope({ coverage: cov, code: rows.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { player_id: o.player_id, min_pa: o.min_pa, min_outs: o.min_outs },
          data: rows,
          notes: [coverageNote(cov),
            'Every pitcher who batted is in the hitting archive, so a hitting record alone does not make a player '
            + 'two-way. Plate appearances and innings are both shown so the caller can decide what counts.',
            'The two ratings are different indexes on different scales (ED_BAT_PERF_V1 and ED_PITCH_PERF_V1) and '
            + 'are never combined into one number.'] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* A current-season line against the completed-season baseline. The two are
       returned side by side and LABELLED; they are never merged, because one
       is a season in progress measured by a live table and the other is a
       finished record measured by this archive. */
    async function currentVsBaseline(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var pid = int(o.player_id);
        if (pid == null) return failure(OUTCOMES.UNRESOLVED_PLAYER, 'an MLB id is required');
        var seasons = (await q(QUERIES.seasons({ player_id: pid }))).map(shapeSeason);
        var withPa = seasons.filter(function (s) { return s.plate_appearances > 0; });
        var recent = o.baseline_seasons ? withPa.filter(function (s) {
          return s.season >= (cov.end - int(o.baseline_seasons) + 1);
        }) : withPa;
        var baseline = aggregateSeasons(recent);
        return envelope({
          coverage: cov,
          scope: { player_id: pid, baseline_seasons: recent.map(function (s) { return s.season; }) },
          data: {
            historical_baseline: baseline,
            historical_seasons: recent,
            current: o.current || null,
            comparable: !!o.current,
            note: o.current
              ? 'The current line and the historical baseline are DIFFERENT MEASUREMENTS: one is a season in '
                + 'progress from EdgeDesk’s live tables, the other a completed ' + (recent.length || 0)
                + '-season record from this archive. They are shown side by side and never averaged together.'
              : 'No current-season line was supplied, so only the completed-season baseline is shown. EdgeDesk’s '
                + 'live tables are the only source for a season in progress.'
          },
          notes: [coverageNote(cov)] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    /* Who moved, between two completed seasons. Deterministic: both seasons are
       read from the database, the delta is arithmetic, and the ordering is the
       delta's — no model is asked to rank anything. */
    async function changes(o) {
      o = o || {};
      try {
        var cov = await coverage();
        var from = int(o.from_season), to = int(o.to_season);
        var metric = METRICS[o.metric] ? o.metric : 'bb_pct';
        if (from == null || to == null) {
          return failure(OUTCOMES.EMPTY_RESULT, 'two completed seasons are required');
        }
        var minPa = o.min_pa != null ? int(o.min_pa) : 200;
        var a = (await q(QUERIES.seasonSlice({ season: from, min_pa: minPa, metric: metric }))).map(shapeSeason);
        var b = (await q(QUERIES.seasonSlice({ season: to, min_pa: minPa, metric: metric }))).map(shapeSeason);
        var byId = {};
        a.forEach(function (r) { byId[r.player_id] = { from: r }; });
        b.forEach(function (r) { (byId[r.player_id] = byId[r.player_id] || {}).to = r; });
        var both = [];
        Object.keys(byId).forEach(function (k) {
          var p = byId[k];
          if (!p.from || !p.to) return;
          var x = num(p.from[metric]), y = num(p.to[metric]);
          if (x == null || y == null) return;
          both.push({
            player_id: p.to.player_id, player_name: p.to.player_name,
            from_season: from, to_season: to,
            from: x, to: y, delta: rnd(y - x, 6),
            improved: improved(metric, x, y),
            from_plate_appearances: p.from.plate_appearances,
            to_plate_appearances: p.to.plate_appearances,
            link: profileLink(p.to.player_id)
          });
        });
        /* MOST IMPROVED FIRST, whichever direction "improved" runs in. For a
           higher-is-better metric that is the largest positive delta; for a
           lower-is-better one it is the largest drop, which is the most
           negative delta. Getting this backwards puts the hitters who
           regressed at the top of a board headed "most improved". */
        var dir = METRICS[metric].better === 'lower' ? -1 : 1;
        both.sort(function (x, y) { return dir * (y.delta - x.delta); });
        var lim = clampLimit(o.limit, LIMITS.leaderboard, LIMITS.leaderboard_default);
        return envelope({
          coverage: cov, code: both.length ? OUTCOMES.OK : OUTCOMES.EMPTY_RESULT,
          scope: { from_season: from, to_season: to, metric: metric, min_pa: minPa,
            qualifying_both_seasons: both.length },
          data: both.slice(0, lim),
          notes: [coverageNote(cov),
            'Only hitters who cleared ' + minPa + ' plate appearances in BOTH seasons are here. A hitter who '
            + 'missed one of the two cannot have a change measured and is absent rather than shown at zero.'] });
      } catch (e) { return failure(classify(e), reason(e)); }
    }

    return {
      status: status, coverage: coverage, leagueBaselines: leagueBaselines,
      resolveHitter: resolveHitter, search: search,
      hitterOverview: hitterOverview, seasonHistory: seasonHistory, teamHistory: teamHistory,
      compare: compare, leaderboard: leaderboard,
      teamOffense: teamOffense, teamOffenseHistory: teamOffenseHistory,
      lineupContext: lineupContext, twoWay: twoWay,
      currentVsBaseline: currentVsBaseline, changes: changes,
      cache: cache
    };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, RATING_VERSION: RATING_VERSION, RATING: RATING, SOURCE: SOURCE,
    OUTCOMES: OUTCOMES, LIMITS: LIMITS, METRICS: METRICS, SAMPLE_FLAGS: SAMPLE_FLAGS,
    COLS: COLS, QUERIES: QUERIES,
    /* arithmetic */
    num: num, int: int, rnd: rnd, ratio: ratio,
    avgOf: avgOf, obpOf: obpOf, slgOf: slgOf, opsOf: opsOf, isoOf: isoOf, babipOf: babipOf,
    kPct: kPct, bbPct: bbPct, hrPct: hrPct, sbSuccess: sbSuccess,
    extraBaseHits: extraBaseHits, singlesOf: singlesOf, totalBasesOf: totalBasesOf,
    sampleWeight: sampleWeight, offensiveIndex: offensiveIndex, sampleFlagOf: sampleFlagOf,
    sampleNote: sampleNote, battingRole: battingRole,
    qualifiedPA: qualifiedPA, QUALIFIED_PA_PER_GAME: QUALIFIED_PA_PER_GAME, SHRINK_PA: SHRINK_PA,
    /* identity */
    nameKey: nameKey, surnameKey: surnameKey, shortName: shortName,
    /* shaping */
    shapeSeason: shapeSeason, shapeTeamSeason: shapeTeamSeason, shapeOverview: shapeOverview,
    shapeTeamHistory: shapeTeamHistory, shapeTeamOffense: shapeTeamOffense,
    shapeTeamOffenseOverview: shapeTeamOffenseOverview, shapeTwoWay: shapeTwoWay,
    aggregateSeasons: aggregateSeasons, yearOverYear: yearOverYear, netChange: netChange,
    compareBatters: compareBatters, opsDecomposition: opsDecomposition, missedSeasons: missedSeasons,
    parseIdList: parseIdList, parseSeasonList: parseSeasonList,
    /* presentation */
    fmt: fmt, fmtDelta: fmtDelta, improved: improved, coverageNote: coverageNote,
    profileLink: profileLink, teamLink: teamLink,
    /* plumbing */
    envelope: envelope, failure: failure, simpleCache: simpleCache, createService: createService,
    COMPARE_METRICS: COMPARE_METRICS, YOY_METRICS: YOY_METRICS
  };
});
/*__EDMLBOFF_END__*/

/*__EDMLBOFF_AI_START__*/
(function (root, factory) {
  var api = factory(root);
  root.EDMLBOFF = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_mlb_offense_v1';

  function Q() {
    return (root && root.EDMlbBatters) || (typeof module === 'object' && module && module.exports
      ? tryRequire() : null);
  }
  function tryRequire() {
    try { return require('../../../lib/mlb_offense_history.js'); } catch (_) { return null; }
  }
  function R() { return root && root.EDRESEARCH ? root.EDRESEARCH : null; }

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (x) { var k = String(x); if (!s[k]) { s[k] = 1; o.push(x); } }); return o; }

  /* ====================================================================== */
  /* 1. THE ROUTER                                                          */
  /* ====================================================================== */

  var HISTORY_WORDS = /\b(hist(ory|orical(ly)?)|career|over the (last|past)|past (three|four|five|six|seven|eight|nine|ten|\d+) (season|year)s?|last (three|four|five|six|seven|eight|nine|ten|\d+) (season|year)s?|since \d{4}|in \d{4}|back in|used to|previously|track record|year[- ]over[- ]year|season by season|each season|every season|trend(s|ed|ing)?|develop(ed|ment)|progress(ed|ion)?|changed?|improv(ed|ement|ing)|declin(ed|e|ing)|regress(ed|ion)|baseline|completed seasons?)\b/i;

  /* Words that make a question about HITTING rather than pitching. The two
     archives sit side by side and a question routed to the wrong one comes
     back confidently wrong. */
  var BAT_WORDS = /\b(hit(s|ter|ters|ting)?|bat(s|ter|ters|ting)?|offen[cs]e|offensive|lineup|line[- ]?up|slugg(er|ing)|power|on[- ]base|obp|slg|ops|avg|batting average|iso\b|babip|home ?runs?|hr\b|rbi|runs? (scored|batted)|walk(s|ed)? rate|bb%|strikeout rate|k%|plate appearance|pa\b|at[- ]bats?|ab\b|extra[- ]base|doubles?|triples?|stolen bases?|sb\b|caught stealing|baserunning|plate discipline|contact|swing)\b/i;

  /* Words about right now. These VETO the history route unless a history word
     is also present, in which case both are answered and kept apart. */
  var CURRENT_WORDS = /\b(tonight|today|tomorrow|this (evening|afternoon)|right now|currently|current (season|form|year)|so far this (season|year)|latest game|last game|next game|who('s| is) (batting|playing|starting)|in the lineup|today'?s lineup|tonight'?s lineup)\b/i;

  /* A question that is explicitly about WHO IS PLAYING is never answerable
     from here, and saying so is more useful than a career line. */
  var LINEUP_CLAIM = /\b(who('s| is| are)? (batting|hitting|playing|in the lineup)|today'?s lineup|tonight'?s lineup|starting lineup|lineup card|batting order|who bats)\b/i;

  var INTENTS = {
    hitter_history: /\b(how (has|have).*(chang|develop|progress|improv|declin|look|hit|perform)|career|track record|season by season|year[- ]over[- ]year|over the (last|past)|history|performed)\b/i,
    hitter_team_history: /\b(which (teams?|clubs?)|what (teams?|clubs?)|(each|every|all|both) (of (his|their) )?(teams?|clubs?)|(teams?|clubs?) (he|they) (play|played|hit|batted)|(play|played|hit|batted) for|team history|club history|with each (team|club)|traded|moved to)\b/i,
    compare_hitters: /\b(compar(e|ing|ison)|versus|vs\.?|against each other|better (than|of the two)|head to head|side by side|both hitters|two hitters)\b/i,
    ops_decomposition: /\b((driven|led) (more )?by|reaching base or power|on[- ]base or (slugging|power)|power or (on[- ]base|contact)|where (does|did) (the|his) (ops|production) come from|what('s| is) behind (his|the) ops)\b/i,
    leaderboard: /\b(who (had|has|led|leads|were|was) the (best|worst|highest|lowest|top|most|fewest)|led the|leader(s|board)?|best|worst|top \d+|rank(ed|ing)?|league leaders?|most|fewest)\b/i,
    improvement: /\b(improv(ed|ement)|declin(ed|e)|better|worse|gain(ed)?|lost|from \d{4} to \d{4}|between \d{4} and \d{4})\b/i,
    team_offense: /\b(team offen[cs]e|teams? (had|have) the (strongest|best|worst|weakest)|club offen[cs]e|offensive team|runs per game|team (ops|obp|slg)|which teams?)\b/i,
    lineup_context: /\b(this lineup|the lineup|lineup'?s (historical|power|strikeout|profile)|these hitters|the hitters (in|on)|opposing lineup|their lineup)\b/i,
    two_way: /\b(two[- ]way|both (hitting and pitching|sides)|hitting and pitching|pitching and hitting|as a (hitter and|pitcher and))\b/i,
    current_vs_baseline: /\b((current|this) season.{0,40}(compare[sd]?|compare with|versus|vs\.?|against|stack(s|ed)? up).{0,40}(baseline|career|history|prior|archive)|(baseline|career|history|archive).{0,40}(compare[sd]?|versus|vs\.?|against).{0,40}(current|this) season|compare[sd]? .{0,40}(current|this) season .{0,30}(baseline|history|career|prior|archive))\b/i
  };

  /**
   * Decide whether this turn is about the historical offensive record.
   * Returns null when it is not — the caller then does nothing at all.
   */
  function route(o) {
    o = o || {};
    var text = str(o.question);
    if (!text.trim()) return null;
    var sport = str(o.sport);
    if (sport && sport.indexOf('baseball') !== 0) return null;

    var hist = HISTORY_WORDS.test(text);
    var bat = BAT_WORDS.test(text);
    var current = CURRENT_WORDS.test(text);
    var names = hitterNamesIn(text);
    var carried = (o.carried && o.carried.player_ids) || [];

    /* A pure "who is in the lineup" question routes here ONLY so the answer
       can say this archive cannot answer it. That is worth a turn: the
       alternative is a career line presented as a lineup. */
    var lineupOnly = LINEUP_CLAIM.test(text) && !hist;
    if (lineupOnly) {
      return { sport: 'baseball_mlb', intents: ['lineup_refusal'], primary: 'lineup_refusal',
        names: names, player_ids: carried, seasons: seasonsIn(text), text: text,
        current_also: true, reason: 'asks who is playing, which this archive cannot answer' };
    }

    /* Otherwise: it has to be about hitting AND about the past (or carry ids
       from a previous historical turn). */
    var population = /\b(hitters?|batters?|players?|teams?|clubs?|everyone|anybody|who)\b/i.test(text);
    var intents = [];
    Object.keys(INTENTS).forEach(function (k) { if (INTENTS[k].test(text)) intents.push(k); });

    /* A LINEUP IS ITS OWN SUBJECT, and so is a league-wide board. "Compare this
       lineup's power profile" names no player and asks about a specific set of
       them; requiring a name would drop the question entirely. */
    var hasSubject = names.length > 0 || carried.length > 0 || population
      || INTENTS.leaderboard.test(text) || INTENTS.team_offense.test(text)
      || INTENTS.lineup_context.test(text) || INTENTS.two_way.test(text);
    if (!hasSubject) return null;
    /* A HITTING WORD, A NAME, OR A CARRIED IDENTITY. A question that names a
       player and asks about the past carries no hitting noun of its own —
       "how has he performed over the last five seasons" — and both archives
       should look, because only the data knows which one he is in. */
    if (!bat && !carried.length && !names.length) return null;
    /* A follow-up inherits the historical frame the previous turn established;
       that is what carrying the ids is for. Requiring the word "career" again
       would break "and his walk rate?" one turn after it was set up. */
    if (!hist && !intents.length && !carried.length) return null;
    if (current && !hist && !intents.length && !carried.length) return null;

    var primary = pickPrimary(intents, text, names, carried);
    if (!primary) return null;

    return {
      sport: 'baseball_mlb',
      intents: uniq(intents),
      primary: primary,
      names: names,
      player_ids: carried,
      seasons: seasonsIn(text),
      teams: teamWordsIn(text),
      min_pa: minPaIn(text),
      metric: metricFor(text),
      text: text,
      /* Both halves are answered and KEPT APART when a turn asks about now and
         about history in the same breath. */
      current_also: current,
      reason: 'historical offensive question'
    };
  }

  function pickPrimary(intents, text, names, carried) {
    if (!intents.length) return names.length || carried.length ? 'hitter_history' : null;
    var subject = names.length > 0 || carried.length > 0;
    /* "WHICH TEAMS" IS TWO QUESTIONS. "Which teams did this hitter play for"
       is a club history; "which teams had the strongest offense" is a club
       leaderboard. The words are the same and the SUBJECT decides: with a
       hitter in hand it is his clubs, without one it is the league's. */
    if (intents.indexOf('team_offense') >= 0 && intents.indexOf('hitter_team_history') >= 0) {
      intents = intents.filter(function (x) {
        return x !== (subject ? 'team_offense' : 'hitter_team_history');
      });
    }
    /* Order matters: the most specific reading wins. */
    var order = ['two_way', 'current_vs_baseline', 'lineup_context', 'ops_decomposition',
      'compare_hitters', 'hitter_team_history', 'team_offense', 'improvement', 'leaderboard',
      'hitter_history'];
    for (var i = 0; i < order.length; i++) {
      if (intents.indexOf(order[i]) >= 0) {
        /* A leaderboard or an improvement question about ONE named hitter is
           really a question about that hitter. */
        if ((order[i] === 'leaderboard' || order[i] === 'improvement')
          && (names.length === 1 || carried.length === 1)
          && !/\b(who|which|leader|top \d+|best|worst|most|fewest)\b/i.test(text)) {
          continue;
        }
        return order[i];
      }
    }
    return intents[0];
  }

  function seasonsIn(text) {
    var out = [];
    var re = /\b(20(1[6-9]|2[0-5]))\b/g, m;
    while ((m = re.exec(str(text)))) out.push(Number(m[1]));
    return uniq(out).sort();
  }
  function minPaIn(text) {
    var m = /\b(?:at least|minimum(?: of)?|min\.?|with)\s+(\d{2,4})\s*(?:\+\s*)?(?:pa|plate appearances)\b/i.exec(str(text));
    if (m) return Number(m[1]);
    var m2 = /\b(\d{3,4})\s*\+?\s*(?:pa|plate appearances)\b/i.exec(str(text));
    return m2 ? Number(m2[1]) : null;
  }
  function teamWordsIn(text) {
    var out = [];
    var re = /\b(Yankees|Mets|Dodgers|Giants|Red Sox|Orioles|Blue Jays|Rays|Guardians|Indians|Tigers|Twins|White Sox|Royals|Astros|Angels|Athletics|Mariners|Rangers|Braves|Marlins|Phillies|Nationals|Cubs|Reds|Brewers|Pirates|Cardinals|Diamondbacks|Rockies|Padres)\b/gi, m;
    while ((m = re.exec(str(text)))) out.push(m[1]);
    return uniq(out);
  }

  /* Which metric a leaderboard or change question is ABOUT. The filter phrase
     is stripped first: "hitters with at least 500 PA" names a screen, not the
     thing being ranked, and ranking by it silently answers a different
     question. */
  var MIN_CLAUSE = /\b(?:at least|minimum(?: of)?|min\.?|with|over|above|more than)\s+\d{2,4}\s*\+?\s*(?:pa|plate appearances|ab|at[- ]bats)\b/ig;
  function metricFor(text) {
    var t = str(text).replace(MIN_CLAUSE, ' ');
    if (/\bwalk(s|ed)? ?rate|bb%|base on balls rate\b/i.test(t)) return 'bb_pct';
    if (/\bstrikeout ?rate|k%\b/i.test(t)) return 'k_pct';
    if (/\bhome ?run ?rate|hr%\b/i.test(t)) return 'hr_pct';
    if (/\b(home ?runs?|hr\b|power|slug)\b/i.test(t) && !/\brate\b/i.test(t)) {
      return /\bslug|slg\b/i.test(t) ? 'slg' : 'home_runs';
    }
    if (/\bops\b/i.test(t)) return 'ops';
    if (/\bon[- ]base|obp\b/i.test(t)) return 'obp';
    if (/\bslugging|slg\b/i.test(t)) return 'slg';
    if (/\biso|isolated power\b/i.test(t)) return 'iso';
    if (/\bbabip\b/i.test(t)) return 'babip';
    if (/\bbatting average|avg\b/i.test(t)) return 'avg';
    if (/\bstolen bases?|sb\b|steal/i.test(t)) return 'stolen_bases';
    if (/\brbi\b/i.test(t)) return 'rbi';
    if (/\bruns? scored\b/i.test(t)) return 'runs';
    if (/\bdoubles?\b/i.test(t)) return 'doubles';
    if (/\bextra[- ]base\b/i.test(t)) return 'extra_base_hits';
    if (/\bruns per game\b/i.test(t)) return 'runs_per_game';
    if (/\bplate appearances?\b/i.test(t)) return 'plate_appearances';
    return 'offensive_index';
  }

  /* Names in free text. A token scan where a stop word ENDS a run rather than
     discarding it, so "Compare Judge and Ohtani" keeps both. */
  var NOT_A_NAME = {
    compare: 1, versus: 1, vs: 1, and: 1, or: 1, with: 1, against: 1, between: 1, the: 1, a: 1, an: 1,
    how: 1, has: 1, have: 1, his: 1, her: 1, their: 1, who: 1, which: 1, what: 1, when: 1, did: 1, does: 1,
    is: 1, was: 1, were: 1, are: 1, in: 1, on: 1, for: 1, of: 1, to: 1, from: 1, over: 1, last: 1, past: 1,
    season: 1, seasons: 1, year: 1, years: 1, career: 1, history: 1, historical: 1, hitting: 1, hitter: 1,
    hitters: 1, batting: 1, batter: 1, power: 1, discipline: 1, plate: 1, walk: 1, walks: 1, rate: 1,
    strikeout: 1, strikeouts: 1, ops: 1, obp: 1, slg: 1, avg: 1, iso: 1, babip: 1, hr: 1, rbi: 1, pa: 1,
    show: 1, tell: 1, me: 1, about: 1, five: 1, completed: 1, baseline: 1, lineup: 1, team: 1, teams: 1,
    club: 1, clubs: 1, offense: 1, offence: 1, offensive: 1, index: 1, rating: 1, best: 1, worst: 1,
    most: 1, least: 1, top: 1, led: 1, leads: 1, leader: 1, leaders: 1, improved: 1, declined: 1,
    strongest: 1, weakest: 1, at: 1, by: 1, more: 1, than: 1, this: 1, that: 1, both: 1, each: 1, all: 1,
    played: 1, play: 1, did_he: 1, he: 1, she: 1, they: 1, it: 1, do: 1, please: 1, compared: 1,
    january: 1, new: 1, york: 1, los: 1, angeles: 1, san: 1, francisco: 1, kansas: 1, city: 1, st: 1,
    louis: 1, tampa: 1, bay: 1, chicago: 1, boston: 1, houston: 1, seattle: 1, texas: 1, atlanta: 1,
    miami: 1, philadelphia: 1, washington: 1, cincinnati: 1, milwaukee: 1, pittsburgh: 1, arizona: 1,
    colorado: 1, diego: 1, detroit: 1, minnesota: 1, cleveland: 1, baltimore: 1, toronto: 1, oakland: 1,
    /* Club nicknames. Now that a single capitalised token counts as a name,
       "Which Yankees hitters led in 2025" would otherwise try to resolve a
       hitter called Yankees. */
    yankees: 1, mets: 1, dodgers: 1, giants: 1, sox: 1, orioles: 1, jays: 1, rays: 1, guardians: 1,
    indians: 1, tigers: 1, twins: 1, royals: 1, astros: 1, angels: 1, athletics: 1, mariners: 1,
    rangers: 1, braves: 1, marlins: 1, phillies: 1, nationals: 1, cubs: 1, reds: 1, brewers: 1,
    pirates: 1, cardinals: 1, diamondbacks: 1, rockies: 1, padres: 1, mlb: 1, al: 1, nl: 1,
    east: 1, west: 1, central: 1, league: 1, american: 1, national: 1, edgedesk: 1
  };
  function hitterNamesIn(text) {
    var words = str(text).replace(/[?!.,;:]/g, ' ').split(/\s+/).filter(Boolean);
    var out = [], run = [];
    function flush() {
      /* One token is enough: "Judge", "Ohtani", "Trout" are how people write
         these names. A token that matches nobody resolves to UNRESOLVED and
         costs one bounded read; a name silently dropped costs the answer. */
      if (run.length) out.push(run.join(' '));
      run = [];
    }
    words.forEach(function (w) {
      var bare = w.replace(/['’]s$/, '');
      var low = bare.toLowerCase();
      var capital = /^[A-ZÁÉÍÓÚÑÜ]/.test(bare) && bare.length > 1;
      if (capital && !NOT_A_NAME[low]) { run.push(bare); return; }
      flush();
    });
    flush();
    return uniq(out).slice(0, 6);
  }

  /* ====================================================================== */
  /* 2. RETRIEVAL                                                           */
  /* ====================================================================== */

  async function retrieve(o) {
    o = o || {};
    var svc = o.service;
    var plan = o.plan;
    if (!svc || !plan) return null;
    var QL = Q();
    var out = {
      plan: plan, coverage: null, rating_version: QL ? QL.RATING_VERSION : 'ED_BAT_PERF_V1',
      resolved: [], ambiguous: [], unresolved: [],
      overviews: [], seasons: {}, teams: {}, compare: null, leaderboard: null,
      changes: null, team_offense: null, lineup: null, two_way: null, baseline: null,
      decomposition: null, notes: [], errors: []
    };

    try {
      var st = await svc.status();
      if (!st.ok) { out.errors.push({ code: st.code, error: st.error }); return out; }
      out.coverage = st.coverage;
      out.notes.push(QL ? QL.coverageNote(st.coverage) : '');
    } catch (e) { out.errors.push({ code: 'QUERY_UNAVAILABLE', error: String(e && e.message || e) }); return out; }

    if (plan.primary === 'lineup_refusal') {
      out.notes.push('This archive cannot say who is playing. It holds completed seasons, not lineups.');
      return out;
    }

    /* ---- resolve the subjects, refusing ambiguity ---- */
    var ids = (plan.player_ids || []).slice(0, 6);
    for (var i = 0; i < (plan.names || []).length && ids.length < 6; i++) {
      try {
        var r = await svc.resolveHitter({ name: plan.names[i] });
        if (r.ok && r.data.resolved) { ids.push(r.data.resolved.player_id); out.resolved.push(r.data.resolved); }
        else if (r.code === 'AMBIGUOUS_PLAYER') {
          out.ambiguous.push({ name: plan.names[i], candidates: (r.data && r.data.candidates) || [] });
        } else out.unresolved.push({ name: plan.names[i], reason: r.error });
      } catch (e) { out.errors.push({ code: 'QUERY_UNAVAILABLE', error: String(e && e.message || e) }); }
    }
    ids = uniq(ids);
    out.player_ids = ids;

    /* An ambiguous name is a question for the reader, not a coin flip. When
       nothing else resolved there is nothing more to retrieve. */
    if (!ids.length && out.ambiguous.length) return out;

    var season = (plan.seasons || []).length === 1 ? plan.seasons[0] : null;
    var from = (plan.seasons || []).length >= 2 ? plan.seasons[0] : null;
    var to = (plan.seasons || []).length >= 2 ? plan.seasons[plan.seasons.length - 1] : null;

    try {
      switch (plan.primary) {
        case 'compare_hitters':
          if (ids.length >= 2) {
            out.compare = await svc.compare({ player_ids: ids, season: season, season_from: from, season_to: to });
          }
          break;
        case 'hitter_team_history':
          for (var t = 0; t < ids.length; t++) out.teams[ids[t]] = await svc.teamHistory({ player_id: ids[t] });
          break;
        case 'leaderboard':
          out.leaderboard = await svc.leaderboard({
            season: season || (out.coverage ? out.coverage.end : null),
            metric: plan.metric, min_pa: plan.min_pa, limit: 15 });
          break;
        case 'improvement':
          out.changes = await svc.changes({
            from_season: from || (out.coverage ? out.coverage.end - 1 : null),
            to_season: to || (out.coverage ? out.coverage.end : null),
            metric: plan.metric, min_pa: plan.min_pa || 300, limit: 15 });
          break;
        case 'team_offense':
          out.team_offense = await svc.teamOffense({
            season: season || (out.coverage ? out.coverage.end : null),
            with_roster: false, limit: 30 });
          break;
        case 'lineup_context':
          out.lineup = await svc.lineupContext({ names: plan.names, player_ids: plan.player_ids });
          break;
        case 'two_way':
          for (var w = 0; w < ids.length; w++) {
            var tw = await svc.twoWay({ player_id: ids[w] });
            if (tw.ok && tw.data.length) out.two_way = tw;
          }
          if (!out.two_way && !ids.length) out.two_way = await svc.twoWay({ min_pa: 200, min_outs: 150, limit: 15 });
          break;
        case 'current_vs_baseline':
          if (ids.length) out.baseline = await svc.currentVsBaseline({ player_id: ids[0], baseline_seasons: 5 });
          break;
        default:
          break;
      }

      /* The per-hitter record every intent benefits from. Bounded to the
         hitters actually asked about. */
      for (var k = 0; k < ids.length && k < 4; k++) {
        var ov = await svc.hitterOverview({ player_id: ids[k] });
        if (ov.ok) {
          out.overviews.push(ov.data.overview);
          out.seasons[ids[k]] = ov.data.seasons;
          if (!out.decomposition && ov.data.latest_ops_decomposition) {
            out.decomposition = { player_id: ids[k], player_name: ov.data.overview.player_name,
              result: ov.data.latest_ops_decomposition };
          }
          if (plan.primary === 'hitter_history' || plan.primary === 'ops_decomposition') {
            out.teams[ids[k]] = out.teams[ids[k]] || await svc.teamHistory({ player_id: ids[k] });
          }
        }
      }
    } catch (e) {
      out.errors.push({ code: 'QUERY_UNAVAILABLE', error: String(e && e.message || e) });
    }
    return out;
  }

  /* ====================================================================== */
  /* 3. THE PROMPT BLOCK                                                    */
  /* ====================================================================== */

  var COV_LINE = 'HISTORICAL MLB OFFENSIVE RECORD. Completed regular seasons only. It is NOT current-season data, '
    + 'and it is NEVER A LINEUP: it cannot say who is batting tonight or in what order.';

  function fmt(v, metric) { var QL = Q(); return QL ? QL.fmt(v, metric) : (v == null ? '—' : String(v)); }

  function promptBlock(res) {
    if (!res) return '';
    var QL = Q();
    var L = [];
    L.push('MLB OFFENSIVE ARCHIVE' + (res.coverage ? ' (' + res.coverage.start + '–' + res.coverage.end + ')' : ''));
    L.push(COV_LINE);
    if (res.coverage && res.coverage.provisional_seasons && res.coverage.provisional_seasons.length) {
      L.push('PROVISIONAL: ' + res.coverage.provisional_seasons.join(', ')
        + ' were imported before the season finished; the league baseline and every rating against it will change.');
    }
    L.push('RATING: ' + (res.rating_version || 'ED_BAT_PERF_V1')
      + ' — 100 is that season’s MLB average, shrunk by PA/(PA+200). NOT OPS+, NOT wRC+, NOT WAR, not a percentile, '
      + 'not park-adjusted, not a probability. Always quote it with plate appearances.');

    if (res.errors && res.errors.length) {
      L.push('READ FAILED: ' + res.errors.map(function (e) { return e.code + ' ' + (e.error || ''); }).join('; ')
        + '. Say what could not be read rather than answering from memory.');
      return L.join('\n');
    }

    if (res.plan && res.plan.primary === 'lineup_refusal') {
      L.push('THE QUESTION ASKS WHO IS PLAYING. This archive cannot answer that at any sample size. Say so plainly, '
        + 'name the live lineup source as the only place that answer comes from, and offer the historical record of '
        + 'any hitter named instead.');
      return L.join('\n');
    }

    if (res.ambiguous && res.ambiguous.length) {
      res.ambiguous.forEach(function (a) {
        L.push('AMBIGUOUS NAME "' + a.name + '": ' + a.candidates.length + ' hitters match. '
          + a.candidates.slice(0, 6).map(function (c) {
            return c.player_name + ' (id ' + c.player_id + ', ' + c.first_observed_season + '–'
              + c.last_observed_season + ', ' + c.plate_appearances + ' PA'
              + (c.teams ? ', ' + c.teams : '') + ')';
          }).join('; ')
          + '. ASK WHICH ONE. Do not pick.');
      });
    }
    (res.unresolved || []).forEach(function (u) {
      L.push('NOT IN THE ARCHIVE: "' + u.name + '" — ' + (u.reason || 'no record in this window') + '.');
    });

    (res.overviews || []).forEach(function (p) {
      var line = 'HITTER ' + p.player_name + ' (id ' + p.player_id + '): '
        + p.first_observed_season + '–' + p.last_observed_season + ', '
        + p.seasons_with_pa + ' season' + (p.seasons_with_pa === 1 ? '' : 's') + ' with a PA, '
        + p.plate_appearances + ' PA, ' + p.games + ' G, '
        + p.hits + ' H, ' + p.home_runs + ' HR, ' + (p.extra_base_hits != null ? p.extra_base_hits + ' XBH, ' : '')
        + 'AVG ' + fmt(p.avg, 'avg') + ', OBP ' + fmt(p.obp, 'obp') + ', SLG ' + fmt(p.slg, 'slg')
        + ', OPS ' + fmt(p.ops, 'ops') + ', ISO ' + fmt(p.iso, 'iso') + ', BABIP ' + fmt(p.babip, 'babip')
        + ', K% ' + fmt(p.k_pct, 'k_pct') + ', BB% ' + fmt(p.bb_pct, 'bb_pct')
        + ', SB ' + p.stolen_bases + (p.sb_success_pct != null ? ' (' + fmt(p.sb_success_pct, 'sb_success_pct') + ')' : '')
        + ', index ' + fmt(p.weighted_offensive_index, 'offensive_index')
        + ' over ' + p.rated_plate_appearances + ' rated PA'
        + (p.teams ? ' · clubs: ' + p.teams : '')
        + ' · sample ' + p.sample_flag;
      if (p.missed_seasons && p.missed_seasons.length) {
        line += ' · NO RECORD in ' + p.missed_seasons.join(', ');
      }
      L.push(line);
      L.push('  profile link: ' + (QL ? QL.profileLink(p.player_id) : '#research/baseball/b' + p.player_id));

      var ss = (res.seasons && res.seasons[p.player_id]) || [];
      ss.filter(function (s) { return s.plate_appearances > 0; }).forEach(function (s) {
        L.push('  ' + s.season + ': ' + s.plate_appearances + ' PA, ' + s.games + ' G, '
          + s.hits + ' H, ' + s.home_runs + ' HR, AVG ' + fmt(s.avg, 'avg')
          + ', OBP ' + fmt(s.obp, 'obp') + ', SLG ' + fmt(s.slg, 'slg') + ', OPS ' + fmt(s.ops, 'ops')
          + ', ISO ' + fmt(s.iso, 'iso') + ', K% ' + fmt(s.k_pct, 'k_pct') + ', BB% ' + fmt(s.bb_pct, 'bb_pct')
          + ', SB ' + s.stolen_bases + '/' + (s.stolen_bases + s.caught_stealing)
          + ', index ' + fmt(s.offensive_index, 'offensive_index')
          + (s.teams ? ' [' + s.teams + ']' : '')
          + ' · ' + s.sample_flag + (s.provisional ? ' · PROVISIONAL' : ''));
      });
    });

    Object.keys(res.teams || {}).forEach(function (pid) {
      var th = res.teams[pid];
      if (!th || !th.ok) return;
      var by = th.data.by_team || [];
      if (!by.length) return;
      L.push('CLUBS for id ' + pid + ' (seasons with a recorded appearance, NOT contract or trade dates):');
      by.forEach(function (c) {
        L.push('  ' + c.team_names_observed + ': ' + c.first_observed_season + '–' + c.last_observed_season
          + ', ' + c.plate_appearances + ' PA, ' + c.home_runs + ' HR, OPS ' + fmt(c.ops, 'ops')
          + ', index ' + fmt(c.weighted_offensive_index, 'offensive_index'));
      });
      L.push('  The per-club lines are the SAME performance as the season lines, split. Never add the two together.');
    });

    if (res.decomposition && res.decomposition.result) {
      var d = res.decomposition.result;
      if (d.available) {
        L.push('OPS SHAPE for ' + res.decomposition.player_name + ': OBP ' + fmt(d.obp, 'obp')
          + ' is ' + d.obp_pct_above_league + '% off the league baseline; SLG ' + fmt(d.slg, 'slg')
          + ' is ' + d.slg_pct_above_league + '% off it. ' + d.text);
      } else {
        L.push('OPS SHAPE unavailable: ' + d.reason + '.');
      }
    }

    if (res.compare && res.compare.ok) {
      var c = res.compare.data;
      L.push('COMPARISON (' + c.players.map(function (p) {
        return p.player_name + ' ' + (p.plate_appearances != null ? p.plate_appearances + ' PA' : 'PA unknown');
      }).join(' vs ') + '), spans ' + c.spans.join(' vs ') + ':');
      c.rows.forEach(function (r) {
        L.push('  ' + r.label + ': ' + r.values.map(function (v) { return fmt(v, r.metric); }).join(' vs ')
          + (r.incomparable ? '  [' + r.incomparable + ']'
            : (r.lead != null ? '  → ' + c.players[r.lead].player_name : '  → even')));
      });
      L.push('  ' + c.note);
    }

    if (res.leaderboard && res.leaderboard.ok) {
      var lb = res.leaderboard;
      L.push('LEADERBOARD ' + (lb.scope.season || '') + ' by ' + lb.scope.metric
        + (lb.scope.min_pa ? ' (min ' + lb.scope.min_pa + ' PA)' : ' (no workload screen)')
        + ' — ordered by the database:');
      lb.data.slice(0, 15).forEach(function (r, i) {
        L.push('  ' + (i + 1) + '. ' + r.player_name + ' (id ' + r.player_id + ') '
          + fmt(r[lb.scope.metric], lb.scope.metric) + ' · ' + r.plate_appearances + ' PA · ' + r.sample_flag);
      });
      (lb.notes || []).forEach(function (n) { if (!/Historical MLB/.test(n)) L.push('  ' + n); });
    }

    if (res.changes && res.changes.ok) {
      var ch = res.changes;
      L.push('CHANGE ' + ch.scope.from_season + ' → ' + ch.scope.to_season + ' in ' + ch.scope.metric
        + ' (min ' + ch.scope.min_pa + ' PA in BOTH seasons; ' + ch.scope.qualifying_both_seasons
        + ' hitters qualify) — most improved first:');
      ch.data.slice(0, 15).forEach(function (r, i) {
        L.push('  ' + (i + 1) + '. ' + r.player_name + ' (id ' + r.player_id + ') '
          + fmt(r.from, ch.scope.metric) + ' → ' + fmt(r.to, ch.scope.metric)
          + ' (' + (QL ? QL.fmtDelta(r.delta, ch.scope.metric) : r.delta) + ') · '
          + r.from_plate_appearances + ' → ' + r.to_plate_appearances + ' PA');
      });
      (ch.notes || []).forEach(function (n) { if (!/Historical MLB/.test(n)) L.push('  ' + n); });
    }

    if (res.team_offense && res.team_offense.ok) {
      var ts = res.team_offense.data.seasons || [];
      L.push('TEAM OFFENSE ' + (res.team_offense.scope.season || '') + ':');
      ts.slice(0, 30).forEach(function (t, i) {
        L.push('  ' + (i + 1) + '. ' + t.team_name + ' (id ' + t.team_id + ') '
          + t.runs + ' R in ' + t.team_games + ' G = ' + fmt(t.runs_per_game, 'runs_per_game') + ' R/G, '
          + 'OPS ' + fmt(t.ops, 'ops') + ', HR ' + t.home_runs + ', K% ' + fmt(t.k_pct, 'k_pct')
          + ', BB% ' + fmt(t.bb_pct, 'bb_pct') + ', index ' + fmt(t.offensive_index, 'offensive_index'));
      });
      L.push('  Runs per game uses the club’s ACTUAL games. player_games_sum is the sum of player games and is NOT a club’s games.');
    }

    if (res.lineup && res.lineup.ok) {
      var lu = res.lineup.data;
      L.push('LINEUP HISTORY (' + lu.hitters.length + ' hitters a CURRENT source named; this archive did not produce the lineup):');
      lu.hitters.forEach(function (h) {
        L.push('  ' + h.player_name + ' (id ' + h.player_id + ') ' + h.plate_appearances + ' PA, '
          + 'OPS ' + fmt(h.ops, 'ops') + ', ISO ' + fmt(h.iso, 'iso') + ', K% ' + fmt(h.k_pct, 'k_pct')
          + ', BB% ' + fmt(h.bb_pct, 'bb_pct') + ', HR ' + h.home_runs
          + ', index ' + fmt(h.weighted_offensive_index, 'offensive_index') + ' · ' + h.sample_flag);
      });
      if (lu.combined) {
        L.push('  COMBINED (counting totals summed, every rate recomputed from those sums — never a mean of means): '
          + lu.combined.plate_appearances + ' PA, AVG ' + fmt(lu.combined.avg, 'avg')
          + ', OBP ' + fmt(lu.combined.obp, 'obp') + ', SLG ' + fmt(lu.combined.slg, 'slg')
          + ', K% ' + fmt(lu.combined.k_pct, 'k_pct') + ', BB% ' + fmt(lu.combined.bb_pct, 'bb_pct')
          + ', HR ' + lu.combined.home_runs);
      }
      (lu.unresolved || []).forEach(function (u) {
        L.push('  NOT IN THE ARCHIVE: ' + (u.name || u.player_id) + ' — ' + u.reason);
      });
      (lu.ambiguous || []).forEach(function (a) {
        L.push('  AMBIGUOUS: ' + a.name + ' matches ' + a.candidates.length + ' hitters; ask which.');
      });
      L.push('  THIS IS NOT TONIGHT’S LINEUP. It is the completed-season record of hitters a live source named.');
    }

    if (res.two_way && res.two_way.ok) {
      L.push('TWO-WAY RECORD (one MLB person id, both archives):');
      res.two_way.data.slice(0, 10).forEach(function (p) {
        L.push('  ' + p.player_name + ' (id ' + p.player_id + ')');
        L.push('    hitting: ' + p.batting.plate_appearances + ' PA, ' + p.batting.home_runs + ' HR, OPS '
          + fmt(p.batting.ops, 'ops') + ', index ' + fmt(p.batting.offensive_index, 'offensive_index')
          + ' (' + p.batting.rating_version + '), ' + p.batting.first_observed_season + '–' + p.batting.last_observed_season);
        L.push('    pitching: ' + p.pitching.innings + ' IP, ERA ' + (p.pitching.era == null ? '—' : p.pitching.era.toFixed(2))
          + ', index ' + (p.pitching.performance_index == null ? '—' : p.pitching.performance_index.toFixed(1))
          + ' (' + p.pitching.rating_version + '), ' + p.pitching.first_observed_season + '–' + p.pitching.last_observed_season);
        L.push('    ' + p.note);
      });
    }

    if (res.baseline && res.baseline.ok) {
      var b = res.baseline.data;
      if (b.historical_baseline) {
        L.push('COMPLETED-SEASON BASELINE (' + (res.baseline.scope.baseline_seasons || []).join(', ') + '): '
          + b.historical_baseline.plate_appearances + ' PA, AVG ' + fmt(b.historical_baseline.avg, 'avg')
          + ', OBP ' + fmt(b.historical_baseline.obp, 'obp') + ', SLG ' + fmt(b.historical_baseline.slg, 'slg')
          + ', OPS ' + fmt(b.historical_baseline.ops, 'ops')
          + ', K% ' + fmt(b.historical_baseline.k_pct, 'k_pct') + ', BB% ' + fmt(b.historical_baseline.bb_pct, 'bb_pct')
          + ', index ' + fmt(b.historical_baseline.weighted_offensive_index, 'offensive_index'));
      }
      L.push('  ' + b.note);
    }

    L.push('HOW TO ANSWER: give the number, name the seasons it covers, show the plate appearances behind it, and keep '
      + 'anything historical visibly separate from anything current. Link the player or team page. If a name was '
      + 'ambiguous, resolve it before answering. If something was missing, say exactly what and still answer the rest.');
    L.push('NOT IN THIS ARCHIVE AT ALL, so never claim them: daily lineups, lineup slots, batting order, '
      + 'handedness splits, batter-versus-pitcher history, pitch-type data, Statcast expected statistics, exit '
      + 'velocity, injuries, defensive value, baserunning value beyond stolen-base outcomes, and contract, trade or '
      + 'roster dates.');
    return L.join('\n');
  }

  /* ====================================================================== */
  /* 4. THE CRITIC                                                          */
  /* ====================================================================== */

  function criticExtras(o) {
    o = o || {};
    var res = o.result, answer = str(o.answer);
    if (!res || !answer) return [];
    var out = [];

    /* THE ONE THAT MATTERS MOST: a completed-season record presented as
       tonight's lineup or tonight's form. */
    if (/\b(tonight|today'?s lineup|is batting|will bat|starting lineup|batting (first|second|third|cleanup|\d))\b/i.test(answer)
      && !/\b(not|cannot|can’t|does not|doesn’t|no )\b/i.test(answer.slice(0, 400))) {
      out.push({ severity: 'high', code: 'HISTORY_AS_LINEUP',
        detail: 'The answer appears to state who is playing or batting. The offensive archive is completed seasons '
          + 'and holds no lineup at all; that claim cannot come from it.' });
    }
    if (/\b(current(ly)?|this season|so far this year)\b/i.test(answer)
      && res.coverage && !new RegExp('\\b' + res.coverage.end + '\\b').test(answer)
      && !/\barchive|historical|completed season/i.test(answer)) {
      out.push({ severity: 'medium', code: 'CURRENT_FROM_HISTORY',
        detail: 'The answer speaks about the current season. This block ends in ' + res.coverage.end
          + '; anything about a season in progress must come from the live tables and be labelled.' });
    }
    /* An ambiguous name answered anyway. */
    (res.ambiguous || []).forEach(function (a) {
      var picked = (a.candidates || []).filter(function (c) {
        return answer.indexOf(String(c.player_id)) >= 0;
      });
      if (picked.length === 1 && !/which|ambiguous|more than one|two (players|hitters)|clarif/i.test(answer)) {
        out.push({ severity: 'high', code: 'AMBIGUITY_RESOLVED_SILENTLY',
          detail: '"' + a.name + '" matches ' + a.candidates.length + ' hitters and the answer picked one without saying so.' });
      }
    });
    /* The rating explained as something it is not. */
    if (/(\bOPS\+|\bwRC\+|\bWAR\b|\bpercentile\b|\bwin probability\b)/i.test(answer)
      && /\b(index|rating)\b/i.test(answer)) {
      out.push({ severity: 'high', code: 'RATING_MISDESCRIBED',
        detail: 'ED_BAT_PERF_V1 is a custom descriptive index. It is not OPS+, wRC+, WAR, a percentile or a probability.' });
    }
    /* A rating quoted without its sample. */
    if (/\bindex\b/i.test(answer) && !/\b(PA|plate appearance)/i.test(answer)) {
      out.push({ severity: 'medium', code: 'RATING_WITHOUT_SAMPLE',
        detail: 'The offensive index is quoted without the plate appearances behind it. A rating near 100 over a '
          + 'handful of plate appearances does not establish average ability.' });
    }
    /* Claims this archive cannot support. */
    if (/\b(versus (left|right)-hand|vs\.? (lhp|rhp)|platoon split|against (lefties|righties)|batter[- ]versus[- ]pitcher|career (numbers )?against (him|this pitcher)|exit velocity|barrel rate|expected (woba|slugging))\b/i.test(answer)) {
      out.push({ severity: 'high', code: 'UNAVAILABLE_CLAIM',
        detail: 'The answer claims handedness splits, batter-versus-pitcher history or Statcast results. This archive '
          + 'holds none of those.' });
    }
    /* The grains added together. */
    if (/\b(combined|total).{0,40}(team splits|club rows|per-club)/i.test(answer)) {
      out.push({ severity: 'medium', code: 'GRAIN_ADDED',
        detail: 'The season line and the per-club lines are the same performance at two levels of detail. Adding them '
          + 'double-counts.' });
    }
    return out;
  }

  /* ====================================================================== */
  /* 5. CONVERSATION STATE                                                  */
  /* ====================================================================== */

  /* Player ids carried across turns so "and his walk rate?" does not have to
     re-resolve a name — and so a follow-up cannot silently drift to a
     different hitter. */
  function conversationState(o) {
    o = o || {};
    var prev = o.previous || {};
    var res = o.result;
    var plan = o.plan;
    if (!res) return prev && prev.player_ids ? prev : null;
    var ids = uniq(((res.player_ids || [])).concat(prev.player_ids || [])).slice(0, 6);
    var names = {};
    (res.overviews || []).forEach(function (p) { names[p.player_id] = p.player_name; });
    Object.keys(prev.names || {}).forEach(function (k) { if (!names[k]) names[k] = prev.names[k]; });
    return {
      player_ids: ids,
      names: names,
      seasons: (plan && plan.seasons && plan.seasons.length) ? plan.seasons : (prev.seasons || []),
      metric: (plan && plan.metric) || prev.metric || null,
      coverage: res.coverage || prev.coverage || null,
      at: new Date().toISOString()
    };
  }
  function sanitizeState(v) {
    if (!v || typeof v !== 'object') return null;
    var ids = (v.player_ids || []).map(int).filter(function (x) { return x != null && x > 0; }).slice(0, 6);
    if (!ids.length) return null;
    var names = {};
    Object.keys(v.names || {}).slice(0, 6).forEach(function (k) {
      var id = int(k); if (id != null) names[id] = str(v.names[k]).slice(0, 80);
    });
    return {
      player_ids: ids, names: names,
      seasons: (v.seasons || []).map(int).filter(function (x) { return x != null && x > 1900 && x < 2100; }).slice(0, 12),
      metric: v.metric ? str(v.metric).slice(0, 40) : null,
      coverage: v.coverage && typeof v.coverage === 'object'
        ? { start: int(v.coverage.start), end: int(v.coverage.end) } : null
    };
  }

  /* ====================================================================== */
  /* 6. THE TOOLS                                                           */
  /* ====================================================================== */

  var TOOL_NAMES = ['resolve_mlb_hitter', 'get_hitter_overview', 'get_hitter_season_history',
    'get_hitter_team_history', 'compare_hitters', 'search_offensive_leaderboard',
    'search_offensive_changes', 'get_team_offense_history', 'get_game_lineup_context',
    'get_two_way_player_history', 'get_hitter_current_vs_baseline'];

  function registerTools() {
    var Rk = R();
    if (!Rk || !Rk.TOOLS || !Rk.T) return false;
    var T = Rk.T;
    var COV = 'EdgeDesk’s own MLB historical OFFENSIVE archive (completed regular seasons only). It is NOT '
      + 'current-season data and it is NEVER a lineup: it cannot say who is batting tonight, in what order, a '
      + 'hitter’s present club, health, handedness splits, batter-versus-pitcher history or any Statcast result.';

    function tool(name, description, input, run) {
      Rk.TOOLS[name] = { name: name, llm: true, category: 'data', description: description, input: input, output: T.any(), run: run };
    }
    function svcOf(ctx) {
      var s = ctx && ctx.mlb_offense;
      return s && typeof s.resolveHitter === 'function' ? s : null;
    }
    function envOut(env) {
      if (!env) return { ok: false, error: 'the archive returned nothing', missing: ['mlb_offense'] };
      if (env.ok === false) {
        return { ok: false, code: env.code, error: env.error || env.code,
          missing: [env.code === 'AMBIGUOUS_PLAYER' ? 'player_choice' : 'records'],
          candidates: (env.data && env.data.candidates) || undefined };
      }
      return {
        ok: true, code: env.code, coverage: env.coverage, rating_version: env.rating_version,
        rating: env.rating, scope: env.scope, sample: env.sample, sources: env.sources,
        historical: true, notes: env.notes, data: env.data, freshness: 'STALE',
        quality_flags: env.coverage && env.coverage.provisional_seasons && env.coverage.provisional_seasons.length
          ? ['provisional_seasons:' + env.coverage.provisional_seasons.join(',')] : []
      };
    }
    function noService() {
      return { ok: false, error: 'the MLB offensive archive is not attached to this turn', missing: ['mlb_offense'] };
    }

    tool('resolve_mlb_hitter',
      'Resolve a hitter name to one MLB player id inside ' + COV + ' Supply name, or player_id to confirm one. A name '
      + 'matching more than one hitter comes back AMBIGUOUS_PLAYER with the candidates — ask which is meant, never pick. '
      + 'Call this FIRST for any question about a named hitter, and reuse the id for every follow-up in the turn.',
      T.obj({ name: T.opt(T.str({ max: 80 })), player_id: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.resolveHitter(i).then(envOut) : noService(); });

    tool('get_hitter_overview',
      'The career window for one hitter inside ' + COV + ' Totals across the window, every rate, the seasons he '
      + 'appeared in, the seasons he did NOT, his clubs, his best season by index, and a breakdown of whether his OPS '
      + 'is led by reaching base or by power. Plate appearances and the sample flag come with it and must be quoted '
      + 'alongside any rating.',
      T.obj({ player_id: T.int() }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.hitterOverview(i).then(envOut) : noService(); });

    tool('get_hitter_season_history',
      'Season by season for one hitter inside ' + COV + ' Each season carries PA, games, the full slash line, ISO, '
      + 'BABIP, K%, BB%, HR%, stolen-base outcomes, the ED_BAT_PERF_V1 index and the workload band. A season with no '
      + 'plate appearances keeps its counting fields and has NO rates and NO rating — that is undefined, not zero. '
      + 'Optional from/to bound the window.',
      T.obj({ player_id: T.int(), from: T.opt(T.int()), to: T.opt(T.int()) }),
      function (i, ctx) {
        var s = svcOf(ctx);
        return s ? s.seasonHistory({ player_id: i.player_id, season_from: i.from, season_to: i.to }).then(envOut) : noService();
      });

    tool('get_hitter_team_history',
      'Performance for each club one hitter played for inside ' + COV + ' Includes the season splits for a traded year. '
      + 'THE CLUB ROWS ARE PARTS OF THAT SEASON and must never be added to the season line — they are the same '
      + 'performance at two levels of detail. Club duration means seasons with a recorded hitting appearance, not '
      + 'contract, trade or roster dates.',
      T.obj({ player_id: T.int() }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.teamHistory(i).then(envOut) : noService(); });

    tool('compare_hitters',
      'Compare two to six hitters inside ' + COV + ' on ONE explicitly named scope: pass season for a single year, '
      + 'season_from/season_to for a range, or neither for each hitter’s whole career window. The result says whether '
      + 'the spans are the same; when they are not, each rating was computed against a different league baseline and '
      + 'the comparison says so. Plate appearances travel with every line.',
      T.obj({ player_ids: T.arr(T.int(), { max: 6 }), season: T.opt(T.int()),
        season_from: T.opt(T.int()), season_to: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.compare(i).then(envOut) : noService(); });

    tool('search_offensive_leaderboard',
      'Rank hitters inside ' + COV + ' THE DATABASE ORDERS AND FILTERS THIS — never rank from text yourself. metric is '
      + 'one of offensive_index, avg, obp, slg, ops, iso, babip, k_pct, bb_pct, hr_pct, home_runs, extra_base_hits, '
      + 'stolen_bases, rbi, runs, doubles, plate_appearances. Filters: season or season_from/season_to, min_pa, '
      + 'min_ab, position, team_id, regulars_only. The result names MLB’s own qualification for that season, computed '
      + 'from that season’s actual club games — which for 2020 is 186 PA, not 502.',
      T.obj({ metric: T.opt(T.str({ max: 32 })), season: T.opt(T.int()), season_from: T.opt(T.int()),
        season_to: T.opt(T.int()), min_pa: T.opt(T.int()), min_ab: T.opt(T.int()),
        position: T.opt(T.str({ max: 4 })), team_id: T.opt(T.int()),
        regulars_only: T.opt(T.bool()), limit: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.leaderboard(i).then(envOut) : noService(); });

    tool('search_offensive_changes',
      'Who moved between two COMPLETED seasons inside ' + COV + ' Both seasons are read from the database and the '
      + 'delta is arithmetic; the ordering is the delta’s, most improved first. Only hitters who cleared min_pa in '
      + 'BOTH seasons are included — a hitter who missed one of the two cannot have a change measured and is absent '
      + 'rather than shown at zero. Use this for "who improved their walk rate from 2024 to 2025".',
      T.obj({ from_season: T.int(), to_season: T.int(), metric: T.opt(T.str({ max: 32 })),
        min_pa: T.opt(T.int()), limit: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.changes(i).then(envOut) : noService(); });

    tool('get_team_offense_history',
      'Club offense inside ' + COV + ' Pass season for one year across all 30 clubs (ranked), team_id for one club '
      + 'across the window, or both for one club-season with its roster. Runs per game uses the club’s ACTUAL games '
      + 'from MLB’s own team endpoint; player_games_sum is the sum of player games and is NOT a club’s games. A club '
      + 'rate is computed from summed numerators and denominators, never by averaging player rates.',
      T.obj({ team_id: T.opt(T.int()), season: T.opt(T.int()), season_from: T.opt(T.int()),
        season_to: T.opt(T.int()), with_roster: T.opt(T.bool()), roster_min_pa: T.opt(T.int()),
        limit: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.teamOffense(i).then(envOut) : noService(); });

    tool('get_game_lineup_context',
      'The COMPLETED-SEASON record of hitters a CURRENT source has already named. ' + COV + ' THIS TOOL DOES NOT '
      + 'PRODUCE A LINEUP AND CANNOT: pass the names or ids the live lineup feed gave you, and it returns each '
      + 'hitter’s history plus a combined line whose counting totals are summed and whose rates are recomputed from '
      + 'those sums. If you have no current lineup, say so — do not use a historical roster in its place.',
      T.obj({ names: T.opt(T.arr(T.str({ max: 80 }), { max: 12 })),
        player_ids: T.opt(T.arr(T.int(), { max: 12 })) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.lineupContext(i).then(envOut) : noService(); });

    tool('get_two_way_player_history',
      'Hitters who also pitched inside the archive window, joined on the single MLB person id the two archives share. '
      + COV + ' Pass player_id for one player, or min_pa/min_outs to list them. EVERY PITCHER WHO BATTED is in the '
      + 'hitting archive, so a hitting record alone does not make someone two-way — both workloads are returned so '
      + 'you can say which is meaningful. The two ratings are different indexes on different scales and are never '
      + 'combined into one number.',
      T.obj({ player_id: T.opt(T.int()), min_pa: T.opt(T.int()), min_outs: T.opt(T.int()),
        limit: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.twoWay(i).then(envOut) : noService(); });

    tool('get_hitter_current_vs_baseline',
      'One hitter’s COMPLETED-SEASON baseline inside ' + COV + ' returned so it can be set beside a current-season '
      + 'line from the live tables. Pass baseline_seasons to use only the most recent N completed seasons. The two '
      + 'are returned separately and labelled; they are never averaged together, because one is a season in progress '
      + 'and the other is a finished record.',
      T.obj({ player_id: T.int(), baseline_seasons: T.opt(T.int()) }),
      function (i, ctx) { var s = svcOf(ctx); return s ? s.currentVsBaseline(i).then(envOut) : noService(); });

    return true;
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, TOOL_NAMES: TOOL_NAMES,
    route: route, retrieve: retrieve, promptBlock: promptBlock, criticExtras: criticExtras,
    registerTools: registerTools, conversationState: conversationState, sanitizeState: sanitizeState,
    /* exported for the tests that hold the routing honest */
    hitterNamesIn: hitterNamesIn, metricFor: metricFor, seasonsIn: seasonsIn, minPaIn: minPaIn,
    pickPrimary: pickPrimary, INTENTS: INTENTS
  };
});
/*__EDMLBOFF_AI_END__*/
