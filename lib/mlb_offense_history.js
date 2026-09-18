/* ===========================================================================
   EdgeDesk — the MLB OFFENSIVE history query layer, 2016–2025.

   ONE implementation of every offensive question, used by the browser
   (app.html) and by EdgeDesk Intelligence (supabase/functions/edgedesk_ai).
   The two used to be able to disagree about what a rate meant; they cannot
   now, because they both call this.

   It is the sibling of lib/mlb_pitcher_history.js and deliberately mirrors
   it: same envelope, same outcome codes, same coverage discipline, same
   refusal to answer a question the data cannot answer. The two archives share
   MLB player ids, team ids and seasons, which is what makes a two-way player
   one identity instead of two.

   WHAT IT WILL NOT DO:
     - It will not average rates. A team average is hits over at-bats, summed
       first; averaging player batting averages is a different and wrong
       number, and no function here does it.
     - It will not add the two grains. batter_seasons (teams combined) and
       batter_team_seasons (split by club) are the SAME performance described
       twice. Adding them double-counts, and nothing here adds them.
     - It will not substitute zero for undefined. A hitter with no at-bats has
       no batting average — not .000. A hitter with walks and no at-bats has an
       OBP and no SLG, no OPS and no rating.
     - It will not treat a hitting record as evidence of being a hitter. Every
       pitcher who batted is in this archive. Plate appearances and the
       source-reported position are carried on every row so a caller can tell
       the difference.
     - It will not convert offensive_index into a probability, a fair price, a
       total or a player prop. It is a descriptive index, and the rating
       version travels with it everywhere.
     - It will not claim today's lineup. The most recent season a hitter
       appears in is a fact about 2016–2025, not about tonight.
   =========================================================================== */
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
    NOT_INSTALLED: 'NOT_INSTALLED',
    NOT_EXPOSED: 'NOT_EXPOSED'   // installed, but PostgREST is not serving the schema
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
      /* PGRST106 means the schema is not exposed, not that it is missing. See
         the same split in lib/mlb_pitcher_history.js for why conflating them
         is worse than useless: it prescribes SQL that cannot help. */
      if (/PGRST106|Invalid schema|unknown schema|3F000/i.test(s + ' ' + body)) {
        return OUTCOMES.NOT_EXPOSED;
      }
      if (/PGRST205|PGRST202|42P01|schema cache|does not exist/i.test(s + ' ' + body)) {
        return OUTCOMES.NOT_INSTALLED;
      }
      return OUTCOMES.QUERY_UNAVAILABLE;
    }
    function reason(err) {
      var s = String((err && err.message) || err || 'the read failed');
      var c = classify(err);
      if (c === OUTCOMES.NOT_EXPOSED) {
        return 'the mlbhist tables exist but the API is not serving them — add mlbhist to '
          + 'Supabase > Settings > API > Exposed schemas. Running the SQL again will not change this';
      }
      if (c === OUTCOMES.NOT_INSTALLED) {
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
