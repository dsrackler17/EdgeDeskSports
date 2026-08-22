#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB Power 4 — CSV export.

   Produces the same one-row-per-game sheet the NFL board exports, for College
   Football. The first 43 columns are IDENTICAL to the NFL export in name and
   order, so a spreadsheet built from either source lines up; the Power 4
   model's extra outputs (confidence, volatility, roster and QB stability,
   injury uncertainty, rivalry, scheme fit, schedule stress, the outcome
   distribution) are APPENDED after them rather than interleaved.

   Usage
     node football/cfb_p4/export_csv.js --season 2026 --week 1
     node football/cfb_p4/export_csv.js --season 2025 --upcoming
     node football/cfb_p4/export_csv.js --season 2025 --all --out slate.csv
     node football/cfb_p4/export_csv.js --season 2026 --week 1 \
          --schedule ./my_2026_schedule.csv --lines ./my_lines.csv

   Options
     --season N      season to export (default: current, Jan/Feb -> prior year)
     --week N        one week
     --upcoming      games kicking off in the next 10 days (default)
     --all           the whole season
     --p4-only       restrict to games involving a Power 4 team (default on;
                     pass --all-fbs to include every FBS game)
     --schedule PATH a local schedules CSV or URL, for a season the public
                     mirror has not published yet
     --lines PATH    a local CSV of book numbers, columns:
                     game_id,spread,over_under,home_moneyline,away_moneyline
                     where `spread` is the HOME team's book line (home -7 = -7)
     --out PATH      output file (default: edgedesk_cfb_p4_<season>_<scope>.csv)
     --replay-from N first season of the cold-start replay used when the target
                     season is at or before the season the parameters were
                     trained through (default: target season minus 8)

   Two state paths, because they are not the same thing:
     * A FUTURE season (after trained_through_season) starts from the shipped
       seeds, applies the learned season carry-over, and absorbs results as
       they arrive. This is the live path.
     * A PAST season is replayed COLD: the ratings are zeroed and rebuilt by
       absorbing whole seasons in kickoff order up to the target. The shipped
       seeds already contain that season's results, so using them would let
       the export see the games it is projecting. The replay costs a few
       seconds of downloads and is the only honest way to look backwards.

   HONESTY: the model does not beat the closing line (see
   research/report/BACKTEST.md). Every row carries unproven=true and a
   recommendation_basis saying so, and completed games are graded from the
   PREGAME snapshot taken before that game was absorbed — never a number
   recomputed with hindsight.
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, 'params.js'));
var E = require(path.join(HERE, 'engine.js'));
var P = global.window.EDCfbP4Params;

var SCHED_URL = function (y) {
  return 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/'
    + 'schedules/csv/cfb_schedules_' + y + '.csv';
};
var LOOKAHEAD_DAYS = 10;

/* ------------------------------------------------------------------ args */
function parseArgs(argv) {
  var a = { scope: 'upcoming', p4Only: true };
  for (var i = 2; i < argv.length; i++) {
    var k = argv[i];
    if (k === '--season') a.season = parseInt(argv[++i], 10);
    else if (k === '--week') { a.week = parseInt(argv[++i], 10); a.scope = 'week'; }
    else if (k === '--upcoming') a.scope = 'upcoming';
    else if (k === '--all') a.scope = 'all';
    else if (k === '--schedule') a.schedule = argv[++i];
    else if (k === '--lines') a.lines = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--replay-from') a.replayFrom = parseInt(argv[++i], 10);
    else if (k === '--p4-only') a.p4Only = true;
    else if (k === '--all-fbs') a.p4Only = false;
    else if (k === '--help' || k === '-h') a.help = true;
    else { console.error('unknown option: ' + k); a.help = true; }
  }
  if (!a.season) {
    var d = new Date();
    a.season = (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear();
  }
  return a;
}

/* -------------------------------------------------------------- csv i/o */
function parseCsv(text) {
  var rows = [], row = [], cur = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  var hd = rows[0], out = [], j, k;
  for (j = 1; j < rows.length; j++) {
    var o = {};
    for (k = 0; k < hd.length; k++) o[hd[k]] = (rows[j][k] === '' || rows[j][k] === 'NA') ? null : rows[j][k];
    out.push(o);
  }
  return out;
}
function q(s) {
  s = String(s == null ? '' : s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function num(x) { if (x == null || x === '') return null; var v = +x; return isFinite(v) ? v : null; }
function r2(v) { return v == null ? '' : Math.round(v * 100) / 100; }
function r1(v) { return v == null ? '' : Math.round(v * 10) / 10; }
function pc(v) { return v == null ? '' : Math.round(v * 1000) / 10; }
function r0(v) { return v == null ? '' : Math.round(v); }

async function readSource(src) {
  if (/^https?:/.test(src)) {
    var r = await fetch(src);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + src);
    return r.text();
  }
  return fs.readFileSync(src, 'utf8');
}

/* ----------------------------------------------------------- the columns */
/* first 43: byte-identical in name and order to the NFL export */
var NFL_HEAD = ['season', 'week', 'game_id', 'kickoff_local', 'away_team', 'home_team',
  'model_version', 'feature_version', 'ratings_basis',
  'model_home_margin', 'model_home_line', 'model_fair_total', 'home_win_prob_pct',
  'model_fair_home_ml', 'model_fair_away_ml',
  'ref_home_line', 'ref_total', 'ref_home_ml', 'ref_away_ml', 'ref_source',
  'spread_gap_pts', 'total_gap_pts',
  'spread_pick', 'p_spread_pick_pct', 'spread_push_pct',
  'total_pick', 'p_total_pick_pct', 'total_push_pct',
  'ml_pick', 'p_ml_pick_pct',
  'recommendation_spread', 'recommendation_total', 'recommendation_basis',
  'qb_status', 'data_status', 'unproven', 'generated_at',
  'home_score', 'away_score', 'final_margin', 'final_total',
  'spread_result', 'total_result', 'ml_result'];

/* everything the Power 4 model produces that the NFL model does not */
var P4_HEAD = ['kickoff_tz', 'neutral_site', 'venue', 'home_conference', 'away_conference',
  'confidence', 'volatility', 'roster_stability', 'qb_stability_home', 'qb_stability_away',
  'injury_uncertainty', 'rivalry_intensity', 'scheme_fit',
  'schedule_stress_home', 'schedule_stress_away',
  'sigma_margin', 'p10_margin', 'median_margin', 'p90_margin',
  'preseason_share_pct', 'games_played_min',
  'contrib_rating', 'contrib_hfa', 'contrib_qb', 'contrib_matchup',
  'contrib_conference', 'contrib_travel', 'contrib_schedule', 'contrib_injury', 'contrib_rivalry',
  'primary_driver_1', 'primary_driver_2', 'primary_driver_3',
  'counterargument_1', 'unavailable_inputs', 'data_quality_notes'];

var HEAD = NFL_HEAD.concat(P4_HEAD);

var BASIS = (function () {
  var m = P.validation_summary && P.validation_summary.market;
  if (!m) return 'UNPROVEN: no validation record loaded';
  return 'UNPROVEN: held-out ' + m.window + ' spread MAE ' + m.spread_mae_model
    + ' vs closing market ' + m.spread_mae_market + '; '
    + (m.beats_closing_line ? 'beats the close at the flagged thresholds'
      : 'does NOT beat the close (best ATS ' + (m.best_ats || 'n/a') + ')')
    + '; research only, counted nowhere until graded CLV';
})();

/* ------------------------------------------------------------- schedule */
function normRow(r) {
  return {
    game_id: r.game_id,
    season: num(r.season),
    week: num(r.week),
    season_type: r.season_type || 'regular',
    start_date: r.start_date,
    completed: String(r.completed).toUpperCase() === 'TRUE',
    neutral_site: String(r.neutral_site).toUpperCase() === 'TRUE',
    venue: r.venue || '',
    venue_id: num(r.venue_id),
    home_team: r.home_team, home_conference: r.home_conference, home_division: r.home_division,
    away_team: r.away_team, away_conference: r.away_conference, away_division: r.away_division,
    home_points: num(r.home_points), away_points: num(r.away_points)
  };
}

function isP4(conf) {
  var list = (P.universe && P.universe.p4_conferences) || ['SEC', 'Big Ten', 'Big 12', 'ACC'];
  return list.indexOf(conf) >= 0;
}

/* ------------------------------------------------------------- grading */
function grade(g, p) {
  var out = { done: g.home_points != null && g.away_points != null,
    margin: null, total: null, spread: null, total_ou: null, ml: null };
  if (!out.done || !p || p.status !== 'PREDICTED') return out;
  out.margin = g.home_points - g.away_points;
  out.total = g.home_points + g.away_points;
  var sGap = p.market.spread_gap, tGap = p.market.total_gap;
  if (sGap != null && p.market.spread_line != null && Math.abs(sGap) > 1e-9) {
    var d = out.margin - p.market.spread_line;
    out.spread = d === 0 ? 'push' : ((d > 0) === (sGap > 0) ? 'win' : 'loss');
  }
  if (tGap != null && p.market.total_line != null && Math.abs(tGap) > 1e-9) {
    var dt = out.total - p.market.total_line;
    out.total_ou = dt === 0 ? 'push' : ((dt > 0) === (tGap > 0) ? 'win' : 'loss');
  }
  if (p.model.home_win_prob != null) {
    out.ml = out.margin === 0 ? 'push'
      : ((out.margin > 0) === (p.model.home_win_prob >= 0.5) ? 'win' : 'loss');
  }
  return out;
}

/* ---------------------------------------------------------------- build */
function buildRequest(state, g, mkt, season) {
  var V = (P.universe && P.universe.venues) || {};
  var hk = E.normKey(g.home_team), ak = E.normKey(g.away_team);
  return {
    season: season, week: g.week, state: state,
    game: { home: g.home_team, away: g.away_team, neutral_site: g.neutral_site,
      venue_id: g.venue_id, kickoff: g.start_date,
      home_fbs: g.home_division === 'fbs', away_fbs: g.away_division === 'fbs' },
    teams: {
      home: { conference: g.home_conference, roster: null, qb: null,
        injuries: null, news: null, coaching: null, schedule: null },
      away: { conference: g.away_conference, roster: null, qb: null,
        injuries: null, news: null, coaching: null, schedule: null }
    },
    venue: { home: V[hk] || null, away: V[ak] || null },
    weather: null,
    market: mkt || {}
  };
}

function contrib(p, key) {
  var c = (p.contributions || []).filter(function (x) { return x.key === key; })[0];
  return c ? r2(c.points) : '';
}

function csvRow(g, p, mkt, refSource, basis) {
  var kick = String(g.start_date || '');
  var kickFmt = kick ? kick.slice(0, 10) + ' ' + kick.slice(11, 16) : '';
  var base = [g.season, g.week, g.game_id, kickFmt, g.away_team, g.home_team];

  if (!p || p.status !== 'PREDICTED') {
    var row = base.slice();
    while (row.length < HEAD.length) row.push('');
    row[6] = (p && p.model_version) || P.model_version;
    row[7] = (p && p.feature_version) || P.feature_version;
    row[34] = p ? p.status : 'NO_PREDICTION';
    row[35] = 'true';
    row[36] = new Date().toISOString();
    row[37] = g.home_points == null ? '' : g.home_points;
    row[38] = g.away_points == null ? '' : g.away_points;
    row[NFL_HEAD.length + 0] = 'UTC';
    row[NFL_HEAD.length + 1] = g.neutral_site ? 'true' : 'false';
    row[NFL_HEAD.length + 2] = g.venue || '';
    row[NFL_HEAD.length + 3] = g.home_conference || '';
    row[NFL_HEAD.length + 4] = g.away_conference || '';
    row[HEAD.length - 1] = (p && (p.reason || (p.missing || []).join('; '))) || '';
    return row.map(q).join(',');
  }

  var m = p.model, sc = p.scores, cov = p.cover, ov = p.over;
  var sGap = p.market.spread_gap, tGap = p.market.total_gap;
  var sPick = (sGap != null && Math.abs(sGap) > 1e-9) ? (sGap > 0 ? g.home_team : g.away_team) : '';
  var tPick = (tGap != null && Math.abs(tGap) > 1e-9) ? (tGap > 0 ? 'Over' : 'Under') : '';
  var mlPick = m.home_win_prob >= 0.5 ? g.home_team : g.away_team;
  var G = grade(g, p);
  var ex = p.explanation || { primary_drivers: [], counterarguments: [],
    unpredictable_variables: [], data_quality: [] };
  var pb = p.layers.strength.preseason_blend || {};

  return base.concat([
    p.model_version, p.feature_version, basis,
    r2(m.fair_spread), r2(-m.fair_spread), r1(m.fair_total), pc(m.home_win_prob),
    m.fair_home_ml, m.fair_away_ml,
    mkt.spread_line == null ? '' : r1(-mkt.spread_line),
    mkt.total_line == null ? '' : r1(mkt.total_line),
    mkt.home_ml == null ? '' : mkt.home_ml,
    mkt.away_ml == null ? '' : mkt.away_ml,
    refSource,
    r2(sGap), r2(tGap),
    sPick, cov ? pc(sGap > 0 ? cov.win : cov.lose) : '', cov ? pc(cov.push) : '',
    tPick, ov ? pc(tGap > 0 ? ov.win : ov.lose) : '', ov ? pc(ov.push) : '',
    mlPick, pc(m.home_win_prob >= 0.5 ? m.home_win_prob : 1 - m.home_win_prob),
    p.edge.spread.recommendation, p.edge.total.recommendation, BASIS,
    (p.layers.qb.home.value.available ? '' : 'home QB unknown; ')
      + (p.layers.qb.away.value.available ? '' : 'away QB unknown'),
    p.status, String(!!p.unproven), new Date().toISOString(),
    g.home_points == null ? '' : g.home_points,
    g.away_points == null ? '' : g.away_points,
    G.margin == null ? '' : G.margin, G.total == null ? '' : G.total,
    G.spread || '', G.total_ou || '', G.ml || '',
    /* ---- Power 4 extras ---- */
    'UTC', g.neutral_site ? 'true' : 'false', g.venue || '',
    g.home_conference || '', g.away_conference || '',
    r0(sc.confidence), r0(sc.volatility), r0(sc.roster_stability),
    r0(sc.qb_stability_home), r0(sc.qb_stability_away),
    r0(sc.injury_uncertainty), r0(sc.rivalry_intensity), r0(sc.scheme_fit),
    r0(sc.schedule_stress_home), r0(sc.schedule_stress_away),
    r1(m.sigma_margin), r1(m.p10_margin), r1(m.median_margin), r1(m.p90_margin),
    pb.preseason_share == null ? '' : Math.round(pb.preseason_share * 100),
    pb.games_played == null ? '' : pb.games_played,
    contrib(p, 'rating'), contrib(p, 'hfa'), contrib(p, 'qb'), contrib(p, 'matchup'),
    contrib(p, 'conference'), contrib(p, 'travel'), contrib(p, 'schedule'),
    contrib(p, 'injury'), contrib(p, 'rivalry'),
    (ex.primary_drivers[0] || {}).text || '',
    (ex.primary_drivers[1] || {}).text || '',
    (ex.primary_drivers[2] || {}).text || '',
    (ex.counterarguments[0] || {}).text || '',
    ex.unpredictable_variables.map(function (u) { return u.item; }).join('; '),
    ex.data_quality.map(function (d) { return d.text; }).join('; ')
  ]).map(q).join(',');
}

/* ----------------------------------------------------------------- main */
async function main() {
  var a = parseArgs(process.argv);
  if (a.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n')
      .filter(function (l) { return !/^\/\*|^\s*=+$/.test(l); }).join('\n'));
    process.exit(a.help === true ? 0 : 1);
  }
  if (a.season > P.trained_through_season + 1) {
    console.error('Season ' + a.season + ' is beyond the trained window ('
      + P.trained_through_season + '). Regenerate params before exporting; '
      + 'the engine refuses to project this far out rather than going stale.');
    process.exit(2);
  }

  /* state: seeded, then advanced season by season on real results */
  var state = E.newState();
  var seededThrough = state.seededThrough;
  var absorbed = 0, snapshots = {}, slate = [];
  var replay = a.season <= seededThrough;
  var firstSeason = seededThrough + 1;

  if (replay) {
    /* COLD REPLAY. The shipped seeds were trained THROUGH season
       `seededThrough`, so for any season at or before that they already
       contain the results this export would be projecting. Zero the ratings
       and rebuild them from scratch instead — slower, and the only version
       of this that means anything. */
    firstSeason = a.replayFrom || (a.season - 8);
    state.r = {}; state.r0 = {}; state.rf = {}; state.n = {};
    state.scoring = {}; state.gamesThisSeason = {};
    state.eff = {}; state.effMean = {};
    state.lmeanPts = P.rating.league_mean_pts;
    console.error('[replay] season ' + a.season + ' is at or before the trained window ('
      + seededThrough + '), so the ratings are rebuilt COLD from ' + firstSeason
      + ' rather than read from the shipped seeds — otherwise the export would '
      + 'see the games it is projecting.');
  }

  for (var y = firstSeason; y <= a.season; y++) {
    if (!(replay && y === firstSeason)) E.ingest.seasonBreak(state);
    var text;
    try {
      text = (a.schedule && y === a.season)
        ? await readSource(a.schedule)
        : await readSource(SCHED_URL(y));
    } catch (err) {
      if (y === a.season) {
        console.error('Could not load the ' + y + ' schedule: ' + err.message);
        console.error('The public mirror does not publish a season until it is under way. '
          + 'Pass --schedule with a local CSV (same columns as cfbfastR-data '
          + 'schedules) to export before then.');
        process.exit(3);
      }
      console.error('[warn] ' + y + ' schedule unavailable; its results are not absorbed');
      continue;
    }
    var rows = parseCsv(text).map(normRow)
      .filter(function (r) { return r.home_division === 'fbs' || r.away_division === 'fbs'; });
    rows.sort(function (x, z) { return String(x.start_date).localeCompare(String(z.start_date)); });

    for (var i = 0; i < rows.length; i++) {
      var g = rows[i];
      var played = g.completed && g.home_points != null && g.away_points != null;
      if (y === a.season) {
        slate.push(g);
        /* PREGAME SNAPSHOT, LEAK-FREE BY ORDER: projected from the state
           BEFORE this game and after everything that kicked off earlier. */
        if (played && (!a.p4Only || isP4(g.home_conference) || isP4(g.away_conference))) {
          try { snapshots[g.game_id] = E.projectGame(buildRequest(state, g, {}, y)); } catch (e) { /* skip */ }
        }
      }
      if (played) {
        E.ingest.absorbGame(state, {
          home: g.home_team, away: g.away_team,
          home_fbs: g.home_division === 'fbs', away_fbs: g.away_division === 'fbs',
          neutral_site: g.neutral_site,
          home_points: g.home_points, away_points: g.away_points
        });
        if (y === a.season) absorbed++;
      }
    }
  }

  /* optional book numbers */
  var lines = {};
  if (a.lines) {
    parseCsv(await readSource(a.lines)).forEach(function (r) {
      var id = r.game_id;
      if (!id) return;
      lines[id] = { spread: num(r.spread), over_under: num(r.over_under),
        home_moneyline: num(r.home_moneyline), away_moneyline: num(r.away_moneyline) };
    });
    console.error('[lines] ' + Object.keys(lines).length + ' games carry book numbers');
  }

  /* scope */
  var now = Date.now(), hi = now + LOOKAHEAD_DAYS * 864e5;
  var items = slate.filter(function (g) {
    if (a.p4Only && !isP4(g.home_conference) && !isP4(g.away_conference)) return false;
    if (a.scope === 'all') return true;
    if (a.scope === 'week') return g.week === a.week;
    var t = Date.parse(g.start_date);
    return !g.completed && isFinite(t) && t >= now - 6 * 3600e3 && t <= hi;
  });
  if (!items.length) {
    console.error('No games matched that scope. Season ' + a.season
      + ' has ' + slate.length + ' FBS games loaded'
      + (a.scope === 'upcoming' ? '; nothing kicks off in the next '
        + LOOKAHEAD_DAYS + ' days — try --week N or --all.' : '.'));
    process.exit(4);
  }

  var basis = replay
    ? ('COLD REPLAY from ' + firstSeason + ': ratings rebuilt from scratch, '
       + absorbed + ' ' + a.season + ' games absorbed in kickoff order; the shipped '
       + 'seeds were NOT used because they already contain this season')
    : absorbed
      ? ('trained seeds + ' + absorbed + ' absorbed ' + a.season + ' games '
         + '(as of now; later weeks update as results absorb)')
      : ('trained seeds through ' + seededThrough + ' + learned season carry-over '
         + '(no ' + a.season + ' games played yet)');

  var out = [HEAD.join(',')];
  items.forEach(function (g) {
    var lg = lines[g.game_id];
    var mkt = {};
    var refSource = 'none joined — no book number available for this game';
    if (lg) {
      if (lg.spread != null) mkt.spread_line = -lg.spread;   /* home -7 -> +7 */
      if (lg.over_under != null) mkt.total_line = lg.over_under;
      mkt.home_ml = lg.home_moneyline;
      mkt.away_ml = lg.away_moneyline;
      refSource = 'supplied --lines file (reference, not a live bettable quote)';
    }
    var played = g.completed && g.home_points != null;
    var p = played && snapshots[g.game_id]
      ? snapshots[g.game_id]
      : E.projectGame(buildRequest(state, g, mkt, a.season));
    if (played && snapshots[g.game_id] && lg) {
      /* re-price the frozen snapshot against the book number without
         recomputing the model's own number */
      p = E.projectGame(buildRequest(state, g, mkt, a.season));
      p.model = snapshots[g.game_id].model;
      p.market.spread_gap = mkt.spread_line == null ? null : p.model.fair_spread - mkt.spread_line;
      p.market.total_gap = mkt.total_line == null || p.model.fair_total == null
        ? null : p.model.fair_total - mkt.total_line;
    }
    out.push(csvRow(g, p, mkt, played ? (refSource + ' — graded from the pregame snapshot')
      : refSource, played ? 'pregame snapshot (state before kickoff, earlier results only)' : basis));
  });

  var scopeLabel = a.scope === 'all' ? 'season' : a.scope === 'week' ? ('week' + a.week) : 'upcoming';
  var name = a.out || ('edgedesk_cfb_p4_' + a.season + '_' + scopeLabel + '.csv');
  fs.writeFileSync(name, out.join('\n') + '\n');
  console.error('[write] ' + name + '  ' + items.length + ' games, '
    + HEAD.length + ' columns');
  console.error('[basis] ' + basis);
  console.error('[record] ' + BASIS);
}

main().catch(function (e) { console.error(e.stack || e.message); process.exit(1); });
