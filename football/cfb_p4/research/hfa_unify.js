#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB Power 4 — ONE home-field value, learned and projected alike.

   The diagnosis (research/disagreement_forensics.js, docs/cfb-calibration):
   the JS rating recursion learns every home result against
   params.rating.hyperparams.hfa (3.2), but projections add
   params.venue.league_hfa (4.082). The python reference (train_p4.py `run`)
   uses ONE value for both: its final pass learns and predicts with
   league_hfa. The JS engine diverged from it, so every projected home game
   carries the 0.88-point gap on top of whatever the 4.082 constant itself
   overstates.

   This replays the SHIPPED engine cold (as research/backtest_engine.js does)
   once per variant:

     current     learn 3.2, project 4.082   (what production does)
     same_<h>    learn h,   project h       for every h on a grid
     walkfwd     season S uses the h whose replay had the lowest spread MAE on
                 the seasons before S (trailing window, chronological only)

   Each replay projects every FBS-vs-FBS game from the PREGAME state and only
   then absorbs it. A same_<h> replay used h for its whole history, so its
   pregame state for season S is exactly the state production would have
   held had it run with h; picking h from earlier seasons' results is the
   only choice made, and it uses only results that were final before S.
   Nothing here reads a market number to make a prediction: the close is
   used to score, never to fit.

     node football/cfb_p4/research/hfa_unify.js --data DIR [--write FILE]

   DIR is the cfbfastR-data layout research/fetch_data.sh writes, with
   out/market.csv from research/build_market.py. Writes nothing unless
   --write is given.
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
/* every variant sets its own home field, so the generated one-home-field
   file (football/cfb_p4/home_field.js, which this script writes) must not
   reach the engine here: a stand-in the engine reads as "not promoted" */
global.window.EDCfbP4HomeField = { promoted: false, note: 'hfa_unify.js replays set the home field per variant' };
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = String(arg('data', '/home/user/cfbdata'));
var REPLAY_FROM = parseInt(arg('replay-from', 2001), 10);
var SCORE_FROM = parseInt(arg('score-from', 2006), 10);
var TEST_FROM = parseInt(arg('test-from', 2014), 10);   /* the Layer-A firewall */
var MARKET_FROM = 2022;                                  /* the headline market window */
var TO = parseInt(arg('to', 2025), 10);
var TRAIL = parseInt(arg('trail', 4), 10);
var WRITE = arg('write', null);
var GRID = [2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8, 4.082];
var SHIPPED = { learn: P.rating.hyperparams.hfa, project: P.venue.league_hfa };

/* ---------- inputs (the same reader and order as backtest_engine.js) ------ */
function readCsv(file) {
  var text = fs.readFileSync(file, 'utf8');
  var rows = [], row = [], cell = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  var head = rows.shift(), out = [], j;
  for (i = 0; i < rows.length; i++) {
    if (rows[i].length < 2) continue;
    var o = {};
    for (j = 0; j < head.length; j++) o[head[j]] = rows[i][j];
    out.push(o);
  }
  return out;
}
function num(v) {
  if (v == null || v === '' || v === 'NA' || v === 'NaN') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}

var games = [];
for (var y = REPLAY_FROM; y <= TO; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) { console.error('[warn] no schedule for ' + y); continue; }
  readCsv(f).forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    games.push({
      game_id: r.game_id, season: num(r.season), week: num(r.week),
      season_type: r.season_type, kick: Date.parse(r.start_date) || 0,
      home: r.home_team, away: r.away_team,
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
      home_conference: r.home_conference, away_conference: r.away_conference,
      neutral_site: String(r.neutral_site).toLowerCase() === 'true',
      home_points: hp, away_points: ap,
      completed: hp != null && ap != null
    });
  });
}
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week); });

var market = {};
(function () {
  var mf = path.join(DATA, 'out', 'market.csv');
  if (!fs.existsSync(mf)) { console.error('[warn] no market.csv — market comparison skipped'); return; }
  readCsv(mf).forEach(function (r) { market[r.game_id] = num(r.spread_close); });
})();

/* ---------- one cold replay ----------------------------------------------- */
function coldState(hLearn) {
  var st = E.strength.newState();
  st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
  st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
  st.lmeanPts = P.rating.league_mean_pts;
  st.season = REPLAY_FROM;
  st.hp.hfa = hLearn;
  return st;
}

function replay(hLearn, hProject) {
  var saved = P.venue.league_hfa;
  P.venue.league_hfa = hProject;
  var st = coldState(hLearn), season = REPLAY_FROM, rows = {};
  try {
    games.forEach(function (g) {
      if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
      if (!g.completed) return;
      if (g.season >= SCORE_FROM && g.home_fbs && g.away_fbs) {
        var out = E.projectGame({
          season: g.season, week: g.week, state: st,
          game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
          teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } }
        });
        if (out.status === 'PREDICTED') rows[g.game_id] = { m: out.model.fair_spread, p: out.model.home_win_prob };
      }
      E.ingest.absorbGame(st, {
        home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
        neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points
      });
    });
  } finally { P.venue.league_hfa = saved; }
  return { rows: rows, state: st };
}

/* ---------- scoring helpers ----------------------------------------------- */
function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : null; }
function clip(p) { return Math.min(1 - 1e-6, Math.max(1e-6, p)); }
function ll(p, y) { p = clip(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); }
function r4(x) { return x == null ? null : +x.toFixed(4); }
function mulberry32(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* cluster bootstrap over season-weeks: games in one week share the same
   rating state, so they are not independent draws */
function clusterCI(items, key, val, B) {
  var by = {}, ks = [], i, b;
  items.forEach(function (it) { var k = key(it); if (!by[k]) { by[k] = []; ks.push(k); } by[k].push(val(it)); });
  var sums = ks.map(function (k) { return by[k].reduce(function (a, x) { return a + x; }, 0); });
  var ns = ks.map(function (k) { return by[k].length; });
  var rnd = mulberry32(20261019), v = [];
  for (b = 0; b < B; b++) {
    var s = 0, n = 0;
    for (i = 0; i < ks.length; i++) { var j = Math.floor(rnd() * ks.length); s += sums[j]; n += ns[j]; }
    v.push(s / n);
  }
  v.sort(function (a, c) { return a - c; });
  return [r4(v[Math.floor(0.025 * B)]), r4(v[Math.floor(0.975 * B)])];
}

/* ---------- run every variant --------------------------------------------- */
var t0 = Date.now();
var variants = { current: replay(SHIPPED.learn, SHIPPED.project) };
GRID.forEach(function (h) { variants['same_' + h] = replay(h, h); });
console.error('[replay] ' + Object.keys(variants).length + ' cold replays in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

/* the scored universe: games every variant projected */
var scoredGames = games.filter(function (g) {
  if (!g.completed || g.season < SCORE_FROM || !g.home_fbs || !g.away_fbs) return false;
  for (var k in variants) if (!variants[k].rows[g.game_id]) return false;
  return true;
});
var seasons = [];
scoredGames.forEach(function (g) { if (seasons.indexOf(g.season) < 0) seasons.push(g.season); });

/* walk-forward: season S takes the grid h with the lowest spread MAE over the
   TRAIL seasons before it (games final before S kicked off) */
var seasonMae = {};
GRID.forEach(function (h) {
  var k = 'same_' + h; seasonMae[k] = {};
  seasons.forEach(function (s) {
    var e = scoredGames.filter(function (g) { return g.season === s; }).map(function (g) {
      return Math.abs(g.home_points - g.away_points - variants[k].rows[g.game_id].m);
    });
    seasonMae[k][s] = { sum: e.reduce(function (a, x) { return a + x; }, 0), n: e.length };
  });
});
var chosen = {};
seasons.forEach(function (s) {
  if (s < SCORE_FROM + TRAIL) return;
  var best = null;
  GRID.forEach(function (h) {
    var k = 'same_' + h, sum = 0, n = 0;
    for (var t = s - TRAIL; t < s; t++) if (seasonMae[k][t]) { sum += seasonMae[k][t].sum; n += seasonMae[k][t].n; }
    if (n && (!best || sum / n < best.mae)) best = { h: h, mae: sum / n };
  });
  chosen[s] = best.h;
});
var wfRows = {};
scoredGames.forEach(function (g) { if (chosen[g.season] != null) wfRows[g.game_id] = variants['same_' + chosen[g.season]].rows[g.game_id]; });
variants.walkfwd = { rows: wfRows };

/* the value production would ship today: the same rule applied to the TRAIL
   seasons ending with the last completed one */
var shipNext = (function () {
  var best = null, last = seasons[seasons.length - 1];
  GRID.forEach(function (h) {
    var k = 'same_' + h, sum = 0, n = 0;
    for (var t = last - TRAIL + 1; t <= last; t++) if (seasonMae[k][t]) { sum += seasonMae[k][t].sum; n += seasonMae[k][t].n; }
    if (!best || sum / n < best.mae) best = { h: h, mae: sum / n, seasons: (last - TRAIL + 1) + '-' + last };
  });
  return best;
})();

/* ---------- metrics ------------------------------------------------------- */
function gameRow(g, k) {
  var v = variants[k].rows[g.game_id];
  if (!v) return null;
  var margin = g.home_points - g.away_points, close = market[g.game_id];
  return {
    g: g, m: v.m, p: v.p, margin: margin, close: close == null ? null : close,
    ae: Math.abs(margin - v.m),
    brier: margin === 0 ? null : Math.pow(v.p - (margin > 0 ? 1 : 0), 2),
    ll: margin === 0 ? null : ll(v.p, margin > 0 ? 1 : 0)
  };
}
function summarize(k, sel) {
  var rs = scoredGames.filter(sel).map(function (g) { return gameRow(g, k); }).filter(Boolean);
  var home = rs.filter(function (r) { return !r.g.neutral_site; });
  var mk = home.filter(function (r) { return r.close != null; });
  var wp = rs.filter(function (r) { return r.brier != null; });
  return {
    n: rs.length,
    spread_mae: r4(mean(rs.map(function (r) { return r.ae; }))),
    brier: r4(mean(wp.map(function (r) { return r.brier; }))),
    log_loss: r4(mean(wp.map(function (r) { return r.ll; }))),
    home_games: home.length,
    home_bias_actual_minus_model: r4(mean(home.map(function (r) { return r.margin - r.m; }))),
    home_lean_vs_close: mk.length ? r4(mean(mk.map(function (r) { return r.m - r.close; }))) : null,
    neutral_bias_actual_minus_model: r4(mean(rs.filter(function (r) { return r.g.neutral_site; }).map(function (r) { return r.margin - r.m; })))
  };
}
function paired(k, base, sel) {
  var items = scoredGames.filter(sel).map(function (g) {
    var a = gameRow(g, k), b = gameRow(g, base);
    return a && b ? { g: g, dae: a.ae - b.ae, dbr: a.brier == null ? null : a.brier - b.brier, dll: a.ll == null ? null : a.ll - b.ll } : null;
  }).filter(Boolean);
  var wp = items.filter(function (i) { return i.dll != null; });
  var key = function (i) { return i.g.season + ':' + i.g.week + ':' + i.g.season_type; };
  return {
    n: items.length,
    d_spread_mae: r4(mean(items.map(function (i) { return i.dae; }))),
    d_spread_mae_ci: clusterCI(items, key, function (i) { return i.dae; }, 2000),
    d_brier: r4(mean(wp.map(function (i) { return i.dbr; }))),
    d_brier_ci: clusterCI(wp, key, function (i) { return i.dbr; }, 2000),
    d_log_loss: r4(mean(wp.map(function (i) { return i.dll; }))),
    d_log_loss_ci: clusterCI(wp, key, function (i) { return i.dll; }, 2000)
  };
}

var inTest = function (g) { return g.season >= TEST_FROM && g.season <= TO; };
var inMkt = function (g) { return g.season >= MARKET_FROM && g.season <= TO; };
var inTune = function (g) { return g.season >= SCORE_FROM + TRAIL && g.season < TEST_FROM; };

var report = {
  what: 'cold replays of the shipped CFB engine with one home-field value for learning and projection',
  shipped: SHIPPED, grid: GRID, trail_seasons: TRAIL,
  windows: { replay_from: REPLAY_FROM, scored_from: SCORE_FROM, test: TEST_FROM + '-' + TO, market: MARKET_FROM + '-' + TO },
  walk_forward_choice_by_season: chosen,
  value_for_next_season: shipNext,
  variants: {}, vs_current: {}, by_season: {}, segments: {}
};
/* the whole surface the walk-forward choice read: spread MAE by season for
   the current engine and every consistent h */
report.grid_mae_by_season = {};
seasons.forEach(function (s) {
  var row = { current: summarize('current', function (g) { return g.season === s; }).spread_mae };
  GRID.forEach(function (h) { var c = seasonMae['same_' + h][s]; row[h] = r4(c.sum / c.n); });
  report.grid_mae_by_season[s] = row;
});
Object.keys(variants).forEach(function (k) {
  report.variants[k] = { tune: summarize(k, inTune), test: summarize(k, inTest), market: summarize(k, inMkt) };
  if (k !== 'current') report.vs_current[k] = { test: paired(k, 'current', inTest), market: paired(k, 'current', inMkt) };
});

/* stability of the walk-forward variant: every season, and the segments the
   decision has to hold in */
function seg(name, sel) { report.segments[name] = paired('walkfwd', 'current', function (g) { return inTest(g) && sel(g); }); }
seasons.forEach(function (s) {
  if (s < TEST_FROM) return;
  var sel = function (g) { return g.season === s; };
  report.by_season[s] = { h: chosen[s], d: paired('walkfwd', 'current', sel), current: summarize('current', sel), walkfwd: summarize('walkfwd', sel) };
});
var P4 = ['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'];
seg('home_site', function (g) { return !g.neutral_site; });
seg('neutral_site', function (g) { return g.neutral_site; });
seg('weeks_1_4', function (g) { return g.season_type !== 'postseason' && g.week <= 4; });
seg('weeks_5_9', function (g) { return g.season_type !== 'postseason' && g.week >= 5 && g.week <= 9; });
seg('weeks_10_plus', function (g) { return g.season_type !== 'postseason' && g.week >= 10; });
seg('postseason', function (g) { return g.season_type === 'postseason'; });
seg('home_power_conf', function (g) { return P4.indexOf(g.home_conference) >= 0; });
seg('home_group_of_5', function (g) { return P4.indexOf(g.home_conference) < 0; });
seg('conference_game', function (g) { return g.home_conference && g.home_conference === g.away_conference; });
seg('non_conference', function (g) { return !(g.home_conference && g.home_conference === g.away_conference); });
function curAbs(g) { return Math.abs(variants.current.rows[g.game_id].m); }
seg('margin_0_3', function (g) { return curAbs(g) < 3; });
seg('margin_3_7', function (g) { var a = curAbs(g); return a >= 3 && a < 7; });
seg('margin_7_14', function (g) { var a = curAbs(g); return a >= 7 && a < 14; });
seg('margin_14_21', function (g) { var a = curAbs(g); return a >= 14 && a < 21; });
seg('margin_21_plus', function (g) { return curAbs(g) >= 21; });

/* ---------- parity: which home field built the shipped seeds? -------------
   The shipped seed ratings were written by train_p4.py's final pass. A cold
   JS replay to the end of the trained window under each home-field rule says
   which one the python reference used, which is the one the JS should match. */
function seedParity(st) {
  var seeds = P.rating.seed_ratings, d = [], t;
  for (t in seeds) if (Object.prototype.hasOwnProperty.call(seeds, t) && st.r[t] != null) d.push(st.r[t] - seeds[t]);
  var ad = d.map(Math.abs);
  return { teams: d.length, mean_abs_diff: r4(mean(ad)), max_abs_diff: r4(Math.max.apply(null, ad)), mean_diff: r4(mean(d)) };
}
if (TO === P.trained_through_season) {
  report.seed_parity = {
    'learn 3.2 (JS today)': seedParity(variants.current.state),
    'learn 4.082 (python reference)': seedParity(variants['same_4.082'].state)
  };
}

/* ---------- the season no choice above has seen, in PRODUCTION's frame -----
   --live-sched FILE (the cfbfastR schedule of the season after the trained
   window) and optionally --live-record FILE (record/football/cfb_<season>.json,
   for its closing lines). Production seeds from params.js and absorbs the
   season in kickoff order (football/fbs/build_coverage.js buildState); the
   fixed engine does the same from seeds rebuilt under its own home field.
   Both project every completed FBS-vs-FBS game from its pregame state. */
var LIVE_SCHED = arg('live-sched', null), LIVE_RECORD = arg('live-record', null);
function rebuiltSeeds(h) {
  var r = variants['same_' + h].state.r, out = {}, t;
  for (t in P.rating.seed_ratings) if (Object.prototype.hasOwnProperty.call(P.rating.seed_ratings, t) && r[t] != null) out[t] = +r[t].toFixed(4);
  return out;
}
if (LIVE_SCHED && TO === P.trained_through_season) {
  var FBS = require(path.join(HERE, '..', '..', 'fbs', 'fbs.js'));
  var liveRows = readCsv(String(LIVE_SCHED)).map(function (r) {
    return { game_id: r.game_id, season: num(r.season), week: num(r.week), season_type: r.season_type, start_date: r.start_date,
      completed: /^(true|1|t|yes)$/i.test(String(r.completed || '')), neutral_site: /^(true|1|t|yes)$/i.test(String(r.neutral_site || '')),
      home: r.home_team, away: r.away_team, home_conference: r.home_conference, away_conference: r.away_conference,
      home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: P.rating.seed_ratings }),
      away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: P.rating.seed_ratings }),
      home_points: num(r.home_points), away_points: num(r.away_points) };
  }).sort(function (a, b) { return String(a.start_date).localeCompare(String(b.start_date)) || String(a.game_id).localeCompare(String(b.game_id)); });
  var liveClose = {};
  if (LIVE_RECORD) {
    var rec = JSON.parse(fs.readFileSync(String(LIVE_RECORD), 'utf8'));
    /* the record states the HOME line as a book prints it; the engine states
       the home margin, so the close crosses with its sign flipped */
    Object.keys(rec.games || {}).forEach(function (k) {
      var g = rec.games[k];
      if (g && g.close && isFinite(g.close.home_line)) liveClose[String(g.game_id)] = -g.close.home_line;
    });
  }
  var liveRun = function (hLearn, hProject, seeds) {
    var saved = P.venue.league_hfa, out = {};
    P.venue.league_hfa = hProject;
    try {
      var st = E.strength.newState();
      if (seeds) st.r = JSON.parse(JSON.stringify(seeds));
      st.hp.hfa = hLearn;
      E.ingest.seasonBreak(st);
      liveRows.forEach(function (g) {
        if (!g.completed || g.home_points == null || g.away_points == null) return;
        if (g.home_fbs && g.away_fbs) {
          var o = E.projectGame({ season: g.season, week: g.week, state: st,
            game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
            teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } } });
          if (o.status === 'PREDICTED') out[g.game_id] = { m: o.model.fair_spread, p: o.model.home_win_prob };
        }
        E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
          neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points });
      });
    } finally { P.venue.league_hfa = saved; }
    return out;
  };
  var liveH = shipNext.h;
  var liveVariants = { production: liveRun(SHIPPED.learn, SHIPPED.project, null) };
  liveVariants['fixed_' + liveH] = liveRun(liveH, liveH, rebuiltSeeds(liveH));
  var liveGames = liveRows.filter(function (g) {
    for (var k in liveVariants) if (!liveVariants[k][g.game_id]) return false;
    return true;
  });
  var liveRow = function (g, k) {
    var v = liveVariants[k][g.game_id], margin = g.home_points - g.away_points;
    return { g: g, m: v.m, ae: Math.abs(margin - v.m), margin: margin, close: liveClose[String(g.game_id)],
      brier: margin === 0 ? null : Math.pow(v.p - (margin > 0 ? 1 : 0), 2), ll: margin === 0 ? null : ll(v.p, margin > 0 ? 1 : 0) };
  };
  var liveSum = function (k) {
    var rs = liveGames.map(function (g) { return liveRow(g, k); });
    var home = rs.filter(function (r) { return !r.g.neutral_site; }), mk = home.filter(function (r) { return r.close != null; });
    var wp = rs.filter(function (r) { return r.brier != null; });
    return { n: rs.length, spread_mae: r4(mean(rs.map(function (r) { return r.ae; }))),
      brier: r4(mean(wp.map(function (r) { return r.brier; }))), log_loss: r4(mean(wp.map(function (r) { return r.ll; }))),
      home_games: home.length, home_bias_actual_minus_model: r4(mean(home.map(function (r) { return r.margin - r.m; }))),
      home_games_with_close: mk.length, home_lean_vs_close: mk.length ? r4(mean(mk.map(function (r) { return r.m - r.close; }))) : null };
  };
  var items = liveGames.map(function (g) {
    var a = liveRow(g, 'fixed_' + liveH), b = liveRow(g, 'production');
    return { g: g, dae: a.ae - b.ae, dbr: a.brier == null ? null : a.brier - b.brier, dll: a.ll == null ? null : a.ll - b.ll };
  });
  var wk = function (i) { return i.g.week + ':' + i.g.season_type; }, wpi = items.filter(function (i) { return i.dll != null; });
  var lastFinal = liveRows.filter(function (g) { return g.completed; }).map(function (g) { return g.start_date; }).sort().pop();
  report.live_season = {
    season: P.trained_through_season + 1, through: lastFinal, h: liveH,
    frame: 'production: shipped seeds, learn ' + SHIPPED.learn + ', project ' + SHIPPED.project
      + ' | fixed: seeds rebuilt under ' + liveH + ', learn ' + liveH + ', project ' + liveH,
    production: liveSum('production'), fixed: liveSum('fixed_' + liveH),
    paired: { n: items.length,
      d_spread_mae: r4(mean(items.map(function (i) { return i.dae; }))), d_spread_mae_ci: clusterCI(items, wk, function (i) { return i.dae; }, 2000),
      d_brier: r4(mean(wpi.map(function (i) { return i.dbr; }))), d_brier_ci: clusterCI(wpi, wk, function (i) { return i.dbr; }, 2000),
      d_log_loss: r4(mean(wpi.map(function (i) { return i.dll; }))), d_log_loss_ci: clusterCI(wpi, wk, function (i) { return i.dll; }, 2000) }
  };
}

/* ---------- the decision, by the repo's pre-declared bar -------------------
   v12_correction.js criteria: a correction survives only if pooled
   walk-forward OOS MAE improves by >= 0.05 pts AND it beats the raw engine in
   a majority of evaluated seasons. Applied here to the walk-forward variant on
   the test window, never to a hindsight-best fixed value. */
var wfTest = report.vs_current.walkfwd.test, seasonsBetter = 0, seasonsScored = 0;
Object.keys(report.by_season).forEach(function (s) { seasonsScored++; if (report.by_season[s].d.d_spread_mae < 0) seasonsBetter++; });
report.decision = {
  rule: 'pooled walk-forward OOS spread MAE must improve by >= 0.05 pts AND beat the current engine in a majority of evaluated seasons (football/cfb_p4/v12_correction.js criteria)',
  d_spread_mae: wfTest.d_spread_mae, d_spread_mae_ci: wfTest.d_spread_mae_ci,
  seasons_better: seasonsBetter + '/' + seasonsScored,
  passes: wfTest.d_spread_mae <= -0.05 && seasonsBetter * 2 > seasonsScored,
  value_for_next_season: shipNext.h
};

/* ---------- the generated home-field file ----------------------------------
   --write-home-field FILE writes football/cfb_p4/home_field.js: the one value,
   the seed ratings rebuilt under it by the same recursion (seed_parity shows
   that recursion reproduces the shipped seeds exactly under the trainer's own
   value), and the record above. It is promoted only when a person passes
   --promote AND the decision passes; either alone writes a shadow file the
   engine ignores. */
var HF_OUT = arg('write-home-field', null);
if (HF_OUT) {
  if (TO !== P.trained_through_season) throw new Error('--write-home-field needs --to ' + P.trained_through_season + ' (the seeds must end where params.js ends)');
  var h = shipNext.h, switchOn = arg('promote', false) === true;
  var promoted = switchOn && report.decision.passes;
  var HFV = {
    schema: 'edgedesk_cfb_home_field_v1',
    version: 'cfb_hfa_unified_v1',
    model_version: 'edgedesk_cfb_p4_v1.0.1',
    base_model_version: P.model_version,
    generated_at: String(arg('now', new Date().toISOString())),
    generated_by: 'football/cfb_p4/research/hfa_unify.js',
    for_params_built_at: P.built_at,
    trained_through_season: P.trained_through_season,
    hfa: h,
    replaces: { learned_in_rating_recursion: SHIPPED.learn, added_in_projection: SHIPPED.project },
    form: 'one home field: the rating recursion learns every home result against hfa and every projection adds the same hfa; 0 at a neutral site',
    rule: 'the grid value with the lowest spread MAE over the ' + TRAIL + ' seasons before the season priced (' + shipNext.seasons + '), from cold replays that used that value for learning and projection alike',
    grid: GRID,
    seed_ratings: rebuiltSeeds(h),
    seed_basis: 'end-of-' + P.trained_through_season + ' ratings from a cold replay of this engine from ' + REPLAY_FROM + ' with hfa ' + h + '; params.js seed_ngames and seed_scoring do not depend on the home field and are unchanged',
    seed_parity: report.seed_parity || null,
    record: {
      test_window: report.windows.test, n: wfTest.n,
      d_spread_mae: wfTest.d_spread_mae, d_spread_mae_ci: wfTest.d_spread_mae_ci,
      d_brier: wfTest.d_brier, d_brier_ci: wfTest.d_brier_ci,
      d_log_loss: wfTest.d_log_loss, d_log_loss_ci: wfTest.d_log_loss_ci,
      seasons_better: report.decision.seasons_better,
      home_lean_vs_close: { current: report.variants.current.test.home_lean_vs_close, unified: report.variants.walkfwd.test.home_lean_vs_close },
      market_window: Object.assign({ window: report.windows.market }, report.vs_current.walkfwd.market),
      live_season: report.live_season ? { season: report.live_season.season, through: report.live_season.through,
        paired: report.live_season.paired,
        home_lean_vs_close: { production: report.live_season.production.home_lean_vs_close, unified: report.live_season.fixed.home_lean_vs_close } } : null
    },
    promotion_rule: report.decision.rule,
    passes_rule: report.decision.passes,
    switch: switchOn,
    promoted: promoted,
    decision: promoted
      ? 'PROMOTED: a person asked for it and the walk-forward record passed the bar. New projections learn and project one ' + h + '-point home field under edgedesk_cfb_p4_v1.0.1; every number published before this file changed stays exactly as it was shown.'
      : 'NOT PROMOTED (' + (report.decision.passes ? 'the switch is off' : 'the walk-forward record did not pass the bar') + '). The engine ignores this file and keeps learning ' + SHIPPED.learn + ' and projecting ' + SHIPPED.project + '.'
  };
  var body = "if(typeof window==='undefined'){globalThis.window=globalThis;}\n"
    + '/* EdgeDesk CFB P4: one home field for the rating recursion and the projection. GENERATED FILE —\n'
    + '   produced by football/cfb_p4/research/hfa_unify.js --write-home-field; never edit by hand.\n'
    + '   Report: docs/cfb-calibration/README.md. */\n'
    + 'window.EDCfbP4HomeField = ' + JSON.stringify(HFV) + ';\n'
    + "if(typeof module!=='undefined'&&module.exports){module.exports=window.EDCfbP4HomeField;}\n";
  fs.writeFileSync(String(HF_OUT), body);
  console.error('[write] ' + HF_OUT + ' (hfa ' + h + ', promoted ' + promoted + ')');
}

console.log(JSON.stringify(report, null, 2));
if (WRITE) { fs.writeFileSync(String(WRITE), JSON.stringify(report, null, 2) + '\n'); console.error('[write] ' + WRITE); }
