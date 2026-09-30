#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — the REGIME-CHANGE prior curve, fitted walk-forward.

   THE DEFECT (audit 2026-09-30). The production pricing state blends a
   long-run rating (trained through 2025, carried into 2026) with a
   this-season-only track on ONE learned curve: 100% long-run through 3 games
   played, 80% at 4-5, 60% at 6+. Iowa State (Matt Campbell out, Jimmy Rogers
   in, most of the roster out with Campbell) and North Texas (Eric Morris and
   most of the roster to Oklahoma State) were priced 12+ points off the market
   because 80% of their number at four games was describing the team that left.

   THE FIX THIS FILE EARNS. A separate, steeper prior-weight curve for
   team-seasons whose programme turned over (research/build_regime_history.py
   builds the signal per team-season from public data). The curve is not
   chosen: it is FITTED, and only on seasons before the one it is scored on.

     for each test season S (2014..2025):
        fit the curve on regime team-games in [FIT_FROM, S-1]  (MAE vs result)
        score it on regime team-games in S, against the standard curve
     pooled held-out record = the answer

   The curve family nests the standard curve exactly (w0 = 1, lambda = 0 is
   the standard curve), is capped by it (a regime curve can only CUT long-run
   weight), and has two parameters:

        w_regime(g) = min( w_standard(g), w0 * exp(-lambda * g) )

   WHY THE COUNTERFACTUAL IS EXACT. The engine's fair margin is a plain sum of
   nine terms, the rating gap among them at coefficient 1 (engine.js
   projectGame), and the margin calibration is not promoted. A team's rating
   term is  w * long_run + (1 - w) * this_season, so moving one team from the
   standard weight to the regime weight moves the fair margin by exactly
   (w_regime - w_standard) * (long_run - this_season) for that side. The replay
   records both tracks and the games played at every kickoff, so every curve
   is scored on the engine's own number without re-running it. A sample of
   games is ALSO re-projected through engine.js with the regime supplied, and
   the two must agree to 1e-9 (the self-check at the end).

   THE SIGNAL (declared before any held-out season was scored, and identical
   to what football/coaching/build_regime.js applies to 2026):
     regime change = a NEW HEAD COACH (tenure began this season)
                     AND the roster turned over more than a typical programme
                     that season: returning roster share or returning
                     production at or below the season's FBS median, or
                     transfers out at or above its 75th percentile.
                     A coach change with NO continuity measurement fires on
                     the coach change alone (the conservative direction: the
                     flag blocks research labels, it never creates one).

   N (games before a regime team may carry WORTH RESEARCHING / VERIFIED
   MAJOR) is read off the HELD-OUT rows (each season scored with the curve
   fitted before it): in two-game buckets of games played, how often does the
   side EdgeDesk's number favours against the close actually cover, when the
   two disagree by 2+ points? N is the first bucket start from which regime
   games cover within 2.5 percentage points of every other game at EVERY
   later bucket. A research label is a claim that the disagreement is worth
   an analyst's time; until N it measurably is not, for these teams.

     node football/cfb_p4/research/regime_backtest.js --data .cache
     node football/cfb_p4/research/regime_backtest.js --data .cache --write
                   (--write regenerates ../regime_curve.js and report/regime_backtest.json)
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = path.resolve(String(arg('data', path.join(HERE, '.cache'))));
var REPLAY_FROM = parseInt(arg('replay-from', 2004), 10);
var FIT_FROM = parseInt(arg('fit-from', 2007), 10);
var TEST_FROM = parseInt(arg('test-from', 2014), 10);
var TEST_TO = parseInt(arg('test-to', 2025), 10);
var WRITE = !!arg('write', false);
var DUMP = arg('dump', null);

/* the signal: ONE definition, shared with the 2026 builder and the tests */
var RS = require(path.join(HERE, '..', '..', 'coaching', 'regime_signal.js'));
var SIGNAL = RS.DEFAULT;
var N_RULE = { disagreement_pts: 2, bucket_games: 2, tolerance_pp: 2.5, last_bucket_from: 8 };

/* ---------- csv ------------------------------------------------------------ */
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
  if (v == null || v === '' || v === 'NA' || v === 'NaN' || v === 'nan') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}
function bool(v) { var s = String(v).toLowerCase(); return s === 'true' ? true : (s === 'false' ? false : null); }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

/* ---------- the signal ----------------------------------------------------- */
function signalFires(x) { return RS.fires(x, SIGNAL); }

/* ---------- the curve ------------------------------------------------------ */
function stdWeight(g) {
  var pw = E._internal.priorWeight(null, g);
  return typeof pw.w === 'number' ? Math.max(0, Math.min(1, pw.w)) : 1;
}
function regimeWeight(g, c) { return RS.weight(g, stdWeight(g), c); }
function curveTable(c) {
  var t = {}, g;
  for (g = 0; g <= 15; g++) t[String(g)] = r4(regimeWeight(g, c));
  return t;
}

if (require.main !== module) { module.exports = { signalFires: signalFires, SIGNAL: SIGNAL, regimeWeight: regimeWeight }; return; }

/* ---------- inputs ---------------------------------------------------------- */
var games = [];
for (var y = REPLAY_FROM; y <= TEST_TO; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) { console.error('[warn] missing ' + f); continue; }
  readCsv(f).forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    games.push({
      game_id: r.game_id, season: num(r.season), week: num(r.week),
      kick: Date.parse(r.start_date) || 0, home: r.home_team, away: r.away_team,
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
      home_conference: r.home_conference, away_conference: r.away_conference,
      neutral_site: String(r.neutral_site).toLowerCase() === 'true',
      home_points: hp, away_points: ap, completed: hp != null && ap != null
    });
  });
}
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week) || String(a.game_id).localeCompare(String(b.game_id)); });

var market = {};
(function () {
  var fm = path.join(DATA, 'out', 'market.csv');
  if (!fs.existsSync(fm)) { console.error('[warn] no market.csv — closing-line diagnostics skipped (run build_market.py)'); return; }
  readCsv(fm).forEach(function (r) { market[r.game_id] = num(r.spread_close); });
})();

var regime = {}, regimeRows = 0;
(function () {
  var fr = path.join(DATA, 'out', 'regime_history.csv');
  if (!fs.existsSync(fr)) throw new Error('missing ' + fr + ' — run build_regime_history.py first');
  readCsv(fr).forEach(function (r) {
    if (String(r.fbs).toLowerCase() !== 'true' || !r.team) return;
    var k = E.normKey(r.team);
    regime[r.season + '|' + k] = {
      team: r.team, season: num(r.season), new_hc: bool(r.new_hc), new_hc_basis: r.new_hc_basis || null,
      coach: r.coach || null, prev_coach: r.prev_coach || null,
      returning_share: num(r.returning_share), transfers_out: num(r.transfers_out), returning_production: num(r.returning_production),
      returning_share_pct: num(r.returning_share_pct), transfers_out_pct: num(r.transfers_out_pct),
      returning_production_pct: num(r.returning_production_pct)
    };
    regimeRows++;
  });
})();

/* ---------- cold replay of the shipped engine ------------------------------- */
var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var rows = [], season = REPLAY_FROM, t0 = Date.now(), refused = 0, missingRegime = 0;
/* engine-parity probes: a fixed, deliberately steep curve, supplied the way the
   production request supplies a regime (teams.<side>.regime) */
var PROBE_CURVE = { w0: 0.5, lambda: 0.1 }, PROBES = [], regimeSeen = 0;
games.forEach(function (g) {
  if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
  if (!g.completed) return;
  if (g.season >= FIT_FROM && g.home_fbs && g.away_fbs) {
    var out = E.projectGame({
      season: g.season, week: g.week, state: st,
      game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
      teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } }
    });
    if (out.status === 'PREDICTED') {
      var hk = E.normKey(g.home), ak = E.normKey(g.away);
      function side(k) {
        var bl = E.strength.blendedRating(st, k, true, g.week);
        var rg = regime[g.season + '|' + k] || null;
        if (!rg) missingRegime++;
        var sf = signalFires(rg);
        var all = rg && rg.new_hc === true;
        return { key: k, carried: bl.carried, fresh: bl.this_season, gp: bl.games_played, w_std: bl.prior_weight,
          regime: sf.fires, new_hc: !!all };
      }
      var row = { game_id: g.game_id, season: g.season, week: g.week,
        fair_std: out.model.fair_spread, margin: g.home_points - g.away_points,
        close: market[g.game_id] != null ? market[g.game_id] : null,
        home: side(hk), away: side(ak), neutral: g.neutral_site,
        home_name: g.home, away_name: g.away, home_conference: g.home_conference, away_conference: g.away_conference };
      rows.push(row);
      if ((row.home.regime || row.away.regime) && (regimeSeen++ % 25) === 0) {
        function rgOf(sd) { return sd.regime ? { regime_change: true, reason: 'probe', curve_override: PROBE_CURVE } : null; }
        var pr = E.projectGame({
          season: g.season, week: g.week, state: st,
          game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
          teams: { home: { conference: g.home_conference, regime: rgOf(row.home) },
                   away: { conference: g.away_conference, regime: rgOf(row.away) } }
        });
        if (pr.status === 'PREDICTED') PROBES.push({ row: row, engine_fair: pr.model.fair_spread });
      }
    } else refused++;
  }
  E.ingest.absorbGame(st, {
    home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
    neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points
  });
});
console.error('[replay] ' + rows.length + ' FBS games projected ' + FIT_FROM + '-' + TEST_TO + ' in '
  + ((Date.now() - t0) / 1000).toFixed(1) + 's; refused ' + refused + '; team-games without a regime row ' + missingRegime);

if (DUMP) { fs.writeFileSync(String(DUMP), JSON.stringify(rows)); console.error('[dump] ' + rows.length + ' rows -> ' + DUMP); }

/* ---------- scoring ---------------------------------------------------------- */
function delta(sd, c, key) {
  if (!sd[key]) return 0;
  var wr = regimeWeight(sd.gp, c);
  return (wr - sd.w_std) * (sd.carried - sd.fresh);
}
function fairWith(row, c, key) { return row.fair_std + delta(row.home, c, key) - delta(row.away, c, key); }
function involves(row, key) { return row.home[key] || row.away[key]; }
function maeOf(list, c, key) {
  var s = 0; list.forEach(function (row) { s += Math.abs(fairWith(row, c, key) - row.margin); });
  return list.length ? s / list.length : null;
}
var STD = { w0: 1, lambda: 0 };
var GRID = [];
(function () {
  var w0, l;
  for (w0 = 0.2; w0 <= 1.0001; w0 += 0.05) for (l = 0; l <= 0.6001; l += 0.02) GRID.push({ w0: r3(w0), lambda: r3(l) });
})();
function fit(list, key) {
  var best = STD, bestE = maeOf(list, STD, key);
  GRID.forEach(function (c) { var e = maeOf(list, c, key); if (e < bestE - 1e-12) { best = c; bestE = e; } });
  return { curve: best, mae: bestE };
}
function bootCI(diffs, reps) {
  if (!diffs.length) return null;
  var seed = 20260930;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  var means = [], i, j, s;
  for (i = 0; i < (reps || 2000); i++) {
    s = 0; for (j = 0; j < diffs.length; j++) s += diffs[Math.floor(rnd() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort(function (a, b) { return a - b; });
  return [r3(means[Math.floor(0.025 * means.length)]), r3(means[Math.floor(0.975 * means.length)])];
}
function atsOf(list, fairFn, th) {
  var n = 0, w = 0;
  list.forEach(function (row) {
    if (row.close == null || row.margin === row.close) return;
    var f = fairFn(row);
    if (Math.abs(f - row.close) < th) return;
    n++;
    if (Math.sign(row.margin - row.close) === Math.sign(f - row.close)) w++;
  });
  return { n: n, win_pct: n ? r3(100 * w / n) : null };
}

function walkForward(key) {
  var bySeason = [], heldOut = [];
  for (var S = TEST_FROM; S <= TEST_TO; S++) {
    var train = rows.filter(function (r) { return r.season >= FIT_FROM && r.season < S && involves(r, key); });
    var test = rows.filter(function (r) { return r.season === S && involves(r, key); });
    if (!train.length || !test.length) continue;
    var ft = fit(train, key);
    var mStd = maeOf(test, STD, key), mReg = maeOf(test, ft.curve, key);
    test.forEach(function (row) { heldOut.push({ row: row, curve: ft.curve }); });
    var withClose = test.filter(function (r) { return r.close != null; });
    var gapStd = 0, gapReg = 0, mkt = 0;
    withClose.forEach(function (r) {
      gapStd += Math.abs(r.fair_std - r.close); gapReg += Math.abs(fairWith(r, ft.curve, key) - r.close); mkt += Math.abs(r.close - r.margin);
    });
    bySeason.push({ season: S, train_games: train.length, test_games: test.length, curve: ft.curve,
      mae_standard: r3(mStd), mae_regime: r3(mReg), delta: r3(mReg - mStd),
      mean_abs_gap_to_close_standard: withClose.length ? r3(gapStd / withClose.length) : null,
      mean_abs_gap_to_close_regime: withClose.length ? r3(gapReg / withClose.length) : null,
      mae_close: withClose.length ? r3(mkt / withClose.length) : null });
  }
  var diffs = heldOut.map(function (h) { return Math.abs(fairWith(h.row, h.curve, key) - h.row.margin) - Math.abs(h.row.fair_std - h.row.margin); });
  var sStd = 0, sReg = 0;
  heldOut.forEach(function (h) { sStd += Math.abs(h.row.fair_std - h.row.margin); sReg += Math.abs(fairWith(h.row, h.curve, key) - h.row.margin); });
  var wc = heldOut.filter(function (h) { return h.row.close != null; });
  var gS = 0, gR = 0, mk = 0;
  wc.forEach(function (h) { gS += Math.abs(h.row.fair_std - h.row.close); gR += Math.abs(fairWith(h.row, h.curve, key) - h.row.close); mk += Math.abs(h.row.close - h.row.margin); });
  var curveFor = {}; heldOut.forEach(function (h) { curveFor[h.row.game_id] = h.curve; });
  return {
    by_season: bySeason, held_out: heldOut,
    pooled: { games: heldOut.length,
      mae_standard: r3(sStd / heldOut.length), mae_regime: r3(sReg / heldOut.length),
      delta: r3((sReg - sStd) / heldOut.length), delta_ci95: bootCI(diffs),
      improved_seasons: bySeason.filter(function (s) { return s.delta < 0; }).length, seasons: bySeason.length,
      with_close: wc.length,
      mean_abs_gap_to_close_standard: wc.length ? r3(gS / wc.length) : null,
      mean_abs_gap_to_close_regime: wc.length ? r3(gR / wc.length) : null,
      mae_close: wc.length ? r3(mk / wc.length) : null,
      ats_vs_close_at_2pts: {
        standard: atsOf(wc.map(function (h) { return h.row; }), function (r) { return r.fair_std; }, 2),
        regime: atsOf(wc.map(function (h) { return h.row; }), function (r) { return fairWith(r, curveFor[r.game_id], key); }, 2) } }
  };
}

var WF = walkForward('regime');
var WF_ALL = walkForward('new_hc');           /* sensitivity: every coach change, continuity ignored */

/* the curve that ships: fitted on EVERY season through the last completed one */
var shipTrain = rows.filter(function (r) { return r.season >= FIT_FROM && r.season <= TEST_TO && involves(r, 'regime'); });
var SHIP = fit(shipTrain, 'regime');

/* ---------- N: games before a regime team may carry a research label -------- */
/* HELD-OUT only: every row below was priced by the curve fitted on the seasons
   before its own. A game is bucketed by the regime side's games played (the
   fewer, when both sides are regime teams); the comparison games are every
   other held-out-window game, bucketed by the fewer games played of the two. */
function bucketOf(g) { var b = Math.floor(g / N_RULE.bucket_games) * N_RULE.bucket_games; return Math.min(b, N_RULE.last_bucket_from); }
var coverRegime = {}, coverOther = {};
function tally(acc, g, f, row) {
  if (row.close == null || row.margin === row.close) return;
  if (Math.abs(f - row.close) < N_RULE.disagreement_pts) return;
  var b = acc[bucketOf(g)] || (acc[bucketOf(g)] = { n: 0, w: 0 });
  b.n++; if (Math.sign(row.margin - row.close) === Math.sign(f - row.close)) b.w++;
}
WF.held_out.forEach(function (h) {
  var row = h.row, sides = [row.home, row.away].filter(function (sd) { return sd.regime; });
  tally(coverRegime, Math.min.apply(null, sides.map(function (sd) { return sd.gp; })), fairWith(row, h.curve, 'regime'), row);
});
rows.forEach(function (row) {
  if (row.season < TEST_FROM || row.season > TEST_TO || row.home.regime || row.away.regime) return;
  tally(coverOther, Math.min(row.home.gp, row.away.gp), row.fair_std, row);
});
var nTable = [], N = null, bstart;
for (bstart = 0; bstart <= N_RULE.last_bucket_from; bstart += N_RULE.bucket_games) {
  var rb = coverRegime[bstart] || { n: 0, w: 0 }, ob = coverOther[bstart] || { n: 0, w: 0 };
  var rp = rb.n ? 100 * rb.w / rb.n : null, op = ob.n ? 100 * ob.w / ob.n : null;
  nTable.push({ games_played_from: bstart, games_played_to: bstart >= N_RULE.last_bucket_from ? null : bstart + N_RULE.bucket_games - 1,
    regime_games: rb.n, regime_cover_pct: r3(rp), other_games: ob.n, other_cover_pct: r3(op),
    difference_pp: rp != null && op != null ? r3(rp - op) : null });
}
for (var i0 = 0; i0 < nTable.length && N == null; i0++) {
  var okAll = true;
  for (var i1 = i0; i1 < nTable.length; i1++) {
    var dpp = nTable[i1].difference_pp;
    if (dpp == null || dpp < -N_RULE.tolerance_pp) { okAll = false; break; }
  }
  if (okAll) N = nTable[i0].games_played_from;
}
if (N == null) N = N_RULE.last_bucket_from + N_RULE.bucket_games;

/* ---------- self-check: the analytic counterfactual IS the engine ------------ */
/* During the replay a sample of regime games was re-projected through
   engine.js with the regime supplied the way the production request supplies
   it and a fixed probe curve; the analytic shift must reproduce the engine's
   own fair margin exactly. If it does not, every number above is fiction. */
var selfCheck = (function () {
  var worst = 0;
  PROBES.forEach(function (pr) {
    var f = fairWith(pr.row, PROBE_CURVE, 'regime');
    worst = Math.max(worst, Math.abs(f - pr.engine_fair));
  });
  return { probes: PROBES.length, probe_curve: PROBE_CURVE, max_abs_difference: worst, ok: PROBES.length > 0 && worst < 1e-9 };
})();
if (!selfCheck.ok) { console.error('[FAIL] analytic regime counterfactual disagrees with engine.js: ' + JSON.stringify(selfCheck)); process.exitCode = 1; }

var report = {
  schema: 'edgedesk_cfb_regime_backtest_v1',
  generated_at: new Date().toISOString(),
  engine_model_version: P.model_version,
  data: { replay_from: REPLAY_FROM, fit_from: FIT_FROM, test_window: TEST_FROM + '-' + TEST_TO,
    games_projected: rows.length, regime_history_rows: regimeRows,
    sources: ['cfbfastR-data schedules', 'cfbfastR-cfb-data coach_tendencies (head coaches, 2005+)',
      'cfbfastR-data rosters (athlete_id continuity)', 'cfbfastR-data player_stats (returning production, 2015+)',
      'cfbfastR-data betting archive (closing spreads, diagnostics only)'] },
  signal: SIGNAL,
  curve_family: 'w_regime(g) = min(w_standard(g), w0 * exp(-lambda * g)); w0 = 1, lambda = 0 is the standard curve',
  objective: 'mean absolute error of the engine fair margin against the final margin, on games involving a regime team',
  standard_curve: curveTable(STD),
  walk_forward: { by_season: WF.by_season, pooled: WF.pooled },
  sensitivity_every_coach_change: { note: 'the same fit on every new head coach, continuity ignored (not shipped)',
    by_season: WF_ALL.by_season, pooled: WF_ALL.pooled },
  shipped: { fitted_on: FIT_FROM + '-' + TEST_TO, games: shipTrain.length, curve: SHIP.curve, table: curveTable(SHIP.curve),
    in_sample_mae_regime: r3(SHIP.mae), in_sample_mae_standard: r3(maeOf(shipTrain, STD, 'regime')) },
  min_games: { N: N, rule: 'held-out, regime curve applied: when EdgeDesk and the close disagree by '
      + N_RULE.disagreement_pts + '+ points, the share of games in which EdgeDesk\u2019s side covers, in ' + N_RULE.bucket_games
      + '-game buckets of the regime side\u2019s games played; N is the first bucket start from which regime games cover '
      + 'within ' + N_RULE.tolerance_pp + ' percentage points of every other game at every later bucket',
    rule_params: N_RULE, table: nTable },
  self_check: selfCheck
};

console.log(JSON.stringify({ signal: SIGNAL.id, walk_forward: WF.pooled, sensitivity_every_coach_change: WF_ALL.pooled,
  shipped: report.shipped, N: N, n_table: nTable, self_check: selfCheck, by_season: WF.by_season }, null, 1));

if (WRITE) {
  var rep = path.join(HERE, 'report', 'regime_backtest.json');
  fs.writeFileSync(rep, JSON.stringify(report, null, 1) + '\n');
  var art = {
    version: 'cfb_regime_curve_v1',
    generated_by: 'football/cfb_p4/research/regime_backtest.js',
    generated_at: report.generated_at,
    engine_model_version: P.model_version,
    signal: SIGNAL,
    curve: { w0: SHIP.curve.w0, lambda: SHIP.curve.lambda, family: report.curve_family, table: report.shipped.table },
    min_games_for_research: N,
    record: { walk_forward_window: report.data.test_window, games: WF.pooled.games,
      mae_standard: WF.pooled.mae_standard, mae_regime: WF.pooled.mae_regime, delta: WF.pooled.delta,
      delta_ci95: WF.pooled.delta_ci95, improved_seasons: WF.pooled.improved_seasons, seasons: WF.pooled.seasons,
      mean_abs_gap_to_close_standard: WF.pooled.mean_abs_gap_to_close_standard,
      mean_abs_gap_to_close_regime: WF.pooled.mean_abs_gap_to_close_regime },
    report: 'football/cfb_p4/research/report/regime_backtest.json'
  };
  var js = '/* GENERATED by football/cfb_p4/research/regime_backtest.js --write. Do not edit by hand.\n'
    + '   The regime-change prior-weight curve: fitted walk-forward on past FBS team-seasons with a new head\n'
    + '   coach and below-median roster continuity; read by football/cfb_p4/engine.js (blendedRating) and\n'
    + '   by football/coaching/build_regime.js (the signal). See the report for the held-out record. */\n'
    + '(function (root) {\n  var R = ' + JSON.stringify(art, null, 1).replace(/\n/g, '\n  ') + ';\n'
    + '  root.EDCfbP4RegimeCurve = R;\n  if (typeof module !== \'undefined\' && module.exports) module.exports = R;\n'
    + '})(typeof window !== \'undefined\' ? window : globalThis);\n';
  fs.writeFileSync(path.join(HERE, '..', 'regime_curve.js'), js);
  console.error('[write] ' + rep + ' and football/cfb_p4/regime_curve.js');
}
