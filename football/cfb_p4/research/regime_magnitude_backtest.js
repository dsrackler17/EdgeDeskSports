#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — the REGIME MAGNITUDE, fitted walk-forward on 2021+ only.

   WHAT v1 LEFT OPEN (regime_backtest.js). The first fix gave every programme
   whose binary REGIME CHANGE flag fired ONE steeper prior curve: Iowa State
   (4th-percentile returning production, its QB gone, 128% of its production
   imported through the portal) and Virginia Tech (36th percentile) both got
   69% long-run weight at four games, and West Virginia (3rd-percentile
   returning roster, no coach change) got none. It was fitted from 2007, and
   the curve it ships was fitted on seasons through 2025.

   v2 replaces the yes/no with a CONTINUOUS turnover magnitude over four
   measured inputs (football/coaching/regime_signal.js magnitudeFeatures):

        f_coach = 1 if the head coach's tenure began this season
        f_prod  = max(0, 1 − 2·returning production pct)   (0 at the median)
        f_qb    = 1 if the QB who started the team's last completed game is
                  not last season's primary QB (before game 1: the roster)
        f_port  = max(0, 2·incoming production pct − 1)    (0 at the median)

   Every input is known before kickoff. THREE FAMILIES carry it into a price:
        w_raw      w = w_std(g)·exp(−a·f); the cut weight moves onto the
                   this-season track as the engine blends it (as v1 does)
        w_centred  the same, onto the CENTRED this-season track: that track
                   starts every programme at −12 and its FBS mean stays ~8.6
                   pts under the long-run track's, so a per-team weight cut on
                   the raw track also docks the team ~Δw·8.6 pts for no
                   football reason (engine.js trackCentres)
        shift      the long-run rating shifted by a SIGNED b·f points (turnover
                   docks it, imported production adds back), fading exp(−λg)

   THE PROTOCOL
     A  SELECTION, fit years only: each family fitted on 2021-2022 and scored
        on 2023; the lowest 2023 MAE is chosen.
     B  HOLDOUT 2024-2025, once: every family refitted on 2021-2023 (the table
        is complete) and scored against the standard curve and the shipped v1
        curve. Neither season enters any fit scored on it.
        DISCLOSURE: w_raw and w_centred were each scored on this holdout once
        while the family list was being built; shift was added after those two
        looks. The choice among the three is made on 2023 alone, but read the
        holdout intervals as optimistic.
     C  SHIP: the chosen family refitted on 2021-2025, PROMOTED only if on the
        holdout it is no worse than the standard curve and than v1, on all
        games and on the regime subset (point estimates). Otherwise it is a
        CANDIDATE: published as research, and v1 keeps pricing.
   Objective: MAE of the engine fair margin against the final margin, every
   FBS-vs-FBS game — the market is never an input (closing lines feed only the
   gap diagnostic). Coarse grid then a fine grid around its best point, ties
   to the smaller total |parameter|.

   Subsets (defined on the INPUTS, never on a fitted coefficient): all games;
   the v1 REGIME subset (a flagged team in the game); heavy turnover (a side
   with a new coach and returning production at or under the 25th
   percentile); stable (both sides: same coach, same QB, returning production
   at or over the median). Bias is the mean signed error of the fair margin,
   oriented so + means the model rated the flagged (turned-over) team too high.

   SELF-CHECK. Each family's counterfactual is exact, and a sample of games is
   re-projected through engine.js with the regime supplied the way the
   production request supplies it (both v2 forms); both must agree to 1e-9.

     CFB_P4_DATA=D python3 build_regime_history.py D/out      (regime_history.csv, qb_starts.csv)
     node football/cfb_p4/research/regime_magnitude_backtest.js --data D
     node football/cfb_p4/research/regime_magnitude_backtest.js --data D --write
          (--write regenerates ../regime_magnitude.js and report/regime_magnitude_backtest.json;
           the v1 curve, ../regime_curve.js, is never touched here)
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;
var RS = require(path.join(HERE, '..', '..', 'coaching', 'regime_signal.js'));
var RC_V1 = require(path.join(HERE, '..', 'regime_curve.js'));   /* v1, read only */

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = path.resolve(String(arg('data', path.join(HERE, '.cache'))));
var REPLAY_FROM = 2004, FIT_FROM = 2021, FIT_TO = 2023, HOLD = [2024, 2025], LAST = 2025;
var WRITE = !!arg('write', false);
/* v1's shipped binary curve, as the file carries it */
var V1_SHIPPED = { w0: 0.75, lambda: 0.02 };
if (RC_V1 && RC_V1.curve && typeof RC_V1.curve.w0 === 'number') V1_SHIPPED = { w0: RC_V1.curve.w0, lambda: RC_V1.curve.lambda };

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
  if (v == null || v === '' || v === 'NA' || v === 'NaN' || v === 'nan' || v === '<NA>') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}
function bool(v) { var s = String(v).toLowerCase(); return s === 'true' ? true : (s === 'false' ? false : null); }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

/* ---------- inputs ---------------------------------------------------------- */
var games = [];
for (var y = REPLAY_FROM; y <= LAST; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) { console.error('[warn] missing ' + f); continue; }
  readCsv(f).forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    games.push({
      game_id: String(r.game_id), season: num(r.season), week: num(r.week),
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
  if (!fs.existsSync(fm)) { console.error('[warn] no market.csv — closing-line diagnostics skipped'); return; }
  readCsv(fm).forEach(function (r) { market[r.game_id] = num(r.spread_close); });
})();

var hist = {}, histRows = 0;
(function () {
  var fr = path.join(DATA, 'out', 'regime_history.csv');
  if (!fs.existsSync(fr)) throw new Error('missing ' + fr + ' — run build_regime_history.py first');
  readCsv(fr).forEach(function (r) {
    if (String(r.fbs).toLowerCase() !== 'true' || !r.team) return;
    hist[r.season + '|' + E.normKey(r.team)] = {
      new_hc: bool(r.new_hc),
      returning_share_pct: num(r.returning_share_pct), transfers_out_pct: num(r.transfers_out_pct),
      returning_production_pct: num(r.returning_production_pct),
      incoming_production_pct: num(r.incoming_production_pct),
      prev_primary_qb_id: r.prev_primary_qb_id && num(r.prev_primary_qb_id) != null ? String(num(r.prev_primary_qb_id)) : null,
      returning_qb: bool(r.returning_qb)
    };
    histRows++;
  });
})();
if (!Object.keys(hist).some(function (k) { return hist[k].incoming_production_pct != null; }))
  throw new Error('regime_history.csv has no incoming_production_pct — rebuild it with the current build_regime_history.py');

var starter = {};                 /* season|game_id|team_key -> starter athlete id */
(function () {
  var fq = path.join(DATA, 'out', 'qb_starts.csv');
  if (!fs.existsSync(fq)) throw new Error('missing ' + fq + ' — run build_regime_history.py first');
  readCsv(fq).forEach(function (r) { starter[r.season + '|' + String(r.game_id) + '|' + r.team_key] = String(num(r.starter_id)); });
})();

/* ---------- cold replay of the shipped engine ------------------------------- */
var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var lastStarter = {};             /* season|team_key -> starter of its last completed game */
var PROBE_FAMILIES = { w_centred: { coach: 0.6, prod: 0.9, qb: 0.4, port: 0.7 },
  shift: { coach: -2, prod: -2.5, qb: -0.5, port: 2, lambda: 0.1 } }, PROBES = [], probeSeen = 0;
var rows = [], season = REPLAY_FROM, refused = 0;

function qbChange(seasonY, k) {
  var h = hist[seasonY + '|' + k];
  if (!h || !h.prev_primary_qb_id) return null;
  var last = lastStarter[seasonY + '|' + k];
  if (last) return last !== h.prev_primary_qb_id;
  return h.returning_qb == null ? null : !h.returning_qb;
}
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
      var centres = E.strength.trackCentres(st);
      var side = function (name) {
        var k = E.normKey(name), bl = E.strength.blendedRating(st, k, true, g.week), h = hist[g.season + '|' + k] || null;
        var x = h ? { new_hc: h.new_hc, returning_production_pct: h.returning_production_pct,
          incoming_production_pct: h.incoming_production_pct, qb_change: qbChange(g.season, k) } : {};
        return { key: k, carried: bl.carried, fresh: bl.this_season, gp: bl.games_played, w_std: bl.prior_weight,
          d: bl.carried - bl.this_season, o: centres.available ? centres.offset : 0, v1: RS.fires(h ? { new_hc: h.new_hc, returning_share_pct: h.returning_share_pct,
            returning_production_pct: h.returning_production_pct, transfers_out_pct: h.transfers_out_pct } : null).fires,
          x: x, f: RS.magnitudeFeatures(x), measured: !!h };
      };
      var row = { game_id: g.game_id, season: g.season, week: g.week, fair_std: out.model.fair_spread,
        margin: g.home_points - g.away_points, close: market[g.game_id] != null ? market[g.game_id] : null,
        home: side(g.home), away: side(g.away), home_name: g.home, away_name: g.away };
      rows.push(row);
      /* engine parity: every 25th game with any turnover, re-projected with
         the regime supplied the way the production request supplies it */
      var anyTurn = RS.MAGNITUDE_INPUTS.some(function (k) { return row.home.f[k] > 0 || row.away.f[k] > 0; });
      if (anyTurn && (probeSeen++ % 25) === 0) {
        Object.keys(PROBE_FAMILIES).forEach(function (fam) {
          var pc = PROBE_FAMILIES[fam];
          var reg = function (sd) {
            var o = { regime_change: sd.v1, reason: 'probe' };
            if (fam === 'shift') { o.prior_shift = RS.MAGNITUDE_INPUTS.reduce(function (v, k) { return v + pc[k] * sd.f[k]; }, 0); o.shift_decay = pc.lambda; }
            else o.magnitude = Math.max(0, RS.MAGNITUDE_INPUTS.reduce(function (v, k) { return v + pc[k] * sd.f[k]; }, 0));
            return o;
          };
          var pr = E.projectGame({
            season: g.season, week: g.week, state: st,
            game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
            teams: { home: { conference: g.home_conference, regime: reg(row.home) },
                     away: { conference: g.away_conference, regime: reg(row.away) } }
          });
          if (pr.status === 'PREDICTED') PROBES.push({ row: row, family: fam, params: pc, engine_fair: pr.model.fair_spread });
        });
      }
    } else refused++;
  }
  E.ingest.absorbGame(st, {
    home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
    neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points
  });
  /* the game is played: its starters are now known for the next kickoff */
  [g.home, g.away].forEach(function (nm) {
    var k = E.normKey(nm), s = starter[g.season + '|' + g.game_id + '|' + k];
    if (s) lastStarter[g.season + '|' + k] = s;
  });
});
console.error('[replay] ' + rows.length + ' FBS games projected ' + FIT_FROM + '-' + LAST + '; refused ' + refused
  + '; team-games without a history row ' + rows.reduce(function (n, r) { return n + (r.home.measured ? 0 : 1) + (r.away.measured ? 0 : 1); }, 0));

/* ---------- the families ----------------------------------------------------- */
/* Every family is a per-side change to the standard fair margin; the engine
   computes the same number (self-check below).
     standard     no change
     v1           the binary curve on flagged teams, cut weight onto the RAW
                  this-season track (what ships today)
     w_raw        magnitude weight cut, onto the RAW track        params a >= 0
     w_centred    magnitude weight cut, onto the CENTRED track    params a >= 0
     shift        a signed level shift on the long-run rating, weighted by the
                  standard weight and fading exp(−λg)             params b, λ */
var K = RS.MAGNITUDE_INPUTS;
function mOf(sd, a) { var m = 0; K.forEach(function (k) { m += (a[k] || 0) * sd.f[k]; }); return Math.max(0, m); }
function sOf(sd, b) { var v = 0; K.forEach(function (k) { v += (b[k] || 0) * sd.f[k]; }); return v; }
var FAM = {
  standard: function () { return function () { return 0; }; },
  v1: function (c) { return function (sd) { return sd.v1 ? (RS.weight(sd.gp, sd.w_std, c) - sd.w_std) * sd.d : 0; }; },
  w_raw: function (a) { return function (sd) { var m = mOf(sd, a); return m > 0 ? sd.w_std * (Math.exp(-m) - 1) * sd.d : 0; }; },
  w_centred: function (a) { return function (sd) { var m = mOf(sd, a); return m > 0 ? sd.w_std * (Math.exp(-m) - 1) * (sd.d - sd.o) : 0; }; },
  shift: function (b) { var lam = b.lambda || 0; return function (sd) { return sd.w_std * sOf(sd, b) * Math.exp(-lam * sd.gp); }; }
};
function fairWith(row, df) { return row.fair_std + df(row.home) - df(row.away); }
function mae(list, df) { var s = 0; list.forEach(function (r) { s += Math.abs(fairWith(r, df) - r.margin); }); return list.length ? s / list.length : null; }

/* ---------- fitting ---------------------------------------------------------- */
/* Each family is scored on typed arrays (the grids run to ~10^5 points). A
   coarse grid, then a fine one around its best point; ties go to the smaller
   total |parameter| (the conservative end). Axes: [lo, hi, coarse step, fine step]. */
function packed(list) {
  var n = list.length, P4 = new Float64Array(n * 4), Q4 = new Float64Array(n * 4), o = {
    n: n, fh: P4, fa: Q4, wh: new Float64Array(n), wa: new Float64Array(n), gh: new Float64Array(n), ga: new Float64Array(n),
    dh: new Float64Array(n), da: new Float64Array(n), ch: new Float64Array(n), ca: new Float64Array(n),
    base: new Float64Array(n), mg: new Float64Array(n) };
  list.forEach(function (r, i) {
    K.forEach(function (k, j) { P4[i * 4 + j] = r.home.f[k]; Q4[i * 4 + j] = r.away.f[k]; });
    o.wh[i] = r.home.w_std; o.wa[i] = r.away.w_std; o.gh[i] = r.home.gp; o.ga[i] = r.away.gp;
    o.dh[i] = r.home.d; o.da[i] = r.away.d; o.ch[i] = r.home.d - r.home.o; o.ca[i] = r.away.d - r.away.o;
    o.base[i] = r.fair_std; o.mg[i] = r.margin;
  });
  return o;
}
function scorer(family, pk) {
  var n = pk.n, fh = pk.fh, fa = pk.fa;
  if (family === 'shift') {
    var cacheL = null, Xh = new Float64Array(n), Xa = new Float64Array(n);
    return function (v) {                        /* v = [coach, prod, qb, port, lambda] */
      if (cacheL !== v[4]) {
        for (var i = 0; i < n; i++) { Xh[i] = pk.wh[i] * Math.exp(-v[4] * pk.gh[i]); Xa[i] = pk.wa[i] * Math.exp(-v[4] * pk.ga[i]); }
        cacheL = v[4];
      }
      var s = 0, j;
      for (j = 0; j < n; j++) {
        var sh = v[0] * fh[j * 4] + v[1] * fh[j * 4 + 1] + v[2] * fh[j * 4 + 2] + v[3] * fh[j * 4 + 3];
        var sa = v[0] * fa[j * 4] + v[1] * fa[j * 4 + 1] + v[2] * fa[j * 4 + 2] + v[3] * fa[j * 4 + 3];
        s += Math.abs(pk.base[j] + Xh[j] * sh - Xa[j] * sa - pk.mg[j]);
      }
      return s / n;
    };
  }
  var DH = family === 'w_centred' ? pk.ch : pk.dh, DA = family === 'w_centred' ? pk.ca : pk.da;
  return function (v) {                          /* v = [coach, prod, qb, port] */
    var s = 0, j;
    for (j = 0; j < n; j++) {
      var mh = v[0] * fh[j * 4] + v[1] * fh[j * 4 + 1] + v[2] * fh[j * 4 + 2] + v[3] * fh[j * 4 + 3];
      var ma = v[0] * fa[j * 4] + v[1] * fa[j * 4 + 1] + v[2] * fa[j * 4 + 2] + v[3] * fa[j * 4 + 3];
      s += Math.abs(pk.base[j] + (mh > 0 ? pk.wh[j] * (Math.exp(-mh) - 1) * DH[j] : 0) - (ma > 0 ? pk.wa[j] * (Math.exp(-ma) - 1) * DA[j] : 0) - pk.mg[j]);
    }
    return s / n;
  };
}
function gridFit(list, family) {
  var axes = AXES[family], names = Object.keys(axes), score = scorer(family, packed(list));
  function tot(v) { return v.reduce(function (a, x) { return a + Math.abs(x); }, 0); }
  function range(lo, hi, st) { var out = [], x; for (x = lo; x <= hi + 1e-9; x += st) out.push(Math.round(x * 1000) / 1000); return out; }
  function search(ranges) {
    /* the LAST axis varies slowest (λ for the shift, which the scorer caches) */
    var best = null, bestE = Infinity, idx = ranges.map(function () { return 0; });
    for (;;) {
      var v = idx.map(function (j, i) { return ranges[i][j]; }), e = score(v);
      if (e < bestE - 1e-12 || (Math.abs(e - bestE) <= 1e-12 && best && tot(v) < tot(best))) { best = v; bestE = e; }
      var i = 0; while (i < idx.length && ++idx[i] >= ranges[i].length) { idx[i] = 0; i++; }
      if (i === idx.length) break;
    }
    return { v: best, e: bestE };
  }
  var coarse = search(names.map(function (k) { return range(axes[k][0], axes[k][1], axes[k][2]); }));
  var fine = search(names.map(function (k, i) {
    var c = coarse.v[i];
    return range(Math.max(axes[k][0], c - axes[k][2]), Math.min(axes[k][1], c + axes[k][2]), axes[k][3]);
  }));
  var p = {}; names.forEach(function (k, i) { p[k] = fine.v[i]; });
  return { params: p, mae: fine.e };
}
var AXES = {
  w_raw: { coach: [0, 2.5, 0.25, 0.05], prod: [0, 2.5, 0.25, 0.05], qb: [0, 2.5, 0.25, 0.05], port: [0, 2.5, 0.25, 0.05] },
  w_centred: { coach: [0, 2.5, 0.25, 0.05], prod: [0, 2.5, 0.25, 0.05], qb: [0, 2.5, 0.25, 0.05], port: [0, 2.5, 0.25, 0.05] },
  /* the level shift is SIGNED: turnover may dock a rating, imported production
     may add to it; λ (the fade per game played) on its own grid */
  shift: { coach: [-5, 1, 0.5, 0.1], prod: [-5, 1, 0.5, 0.1], qb: [-3, 1, 0.5, 0.1], port: [-2, 4, 0.5, 0.1], lambda: [0, 0.3, 0.1, 0.1] }
};
function fitFamily(family, list) { return gridFit(list, family); }

/* ---------- metrics ---------------------------------------------------------- */
function bootCI(diffs, reps) {
  if (!diffs.length) return null;
  var seed = 20260930;
  /* a 32-bit LCG in exact integer arithmetic (Math.imul, >>> 0). The earlier
     (seed * 1103515245 + 12345) % 2^31 overflowed 2^53 in doubles, lost its low
     bits and cycled after ~10,466 draws, so every resample of a few thousand
     games re-read nearly the same sequence and the CI came out far too narrow */
  function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  var means = [], i, j, s;
  for (i = 0; i < (reps || 2000); i++) {
    s = 0; for (j = 0; j < diffs.length; j++) s += diffs[Math.floor(rnd() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort(function (a, b) { return a - b; });
  return [r3(means[Math.floor(0.025 * means.length)]), r3(means[Math.floor(0.975 * means.length)])];
}
/* the subsets are defined on the INPUTS, never on a fitted coefficient */
function turnover(sd) { return sd.x.new_hc === true && sd.x.returning_production_pct != null && sd.x.returning_production_pct <= 0.25; }
function stableSide(sd) { return sd.x.new_hc === false && sd.x.qb_change === false && sd.x.returning_production_pct != null && sd.x.returning_production_pct >= 0.5; }
var SUBSETS = {
  all: { pick: function () { return true; }, orient: null },
  regime_subset: { pick: function (r) { return r.home.v1 || r.away.v1; }, orient: function (r) { return r.home.v1 === r.away.v1 ? 0 : (r.home.v1 ? 1 : -1); } },
  heavy_turnover: { pick: function (r) { return turnover(r.home) || turnover(r.away); }, orient: function (r) { return turnover(r.home) === turnover(r.away) ? 0 : (turnover(r.home) ? 1 : -1); } },
  stable: { pick: function (r) { return stableSide(r.home) && stableSide(r.away); }, orient: null }
};
function subsetStats(list, arms, sub) {
  var S = SUBSETS[sub], L = list.filter(S.pick), out = { games: L.length, arms: {} };
  Object.keys(arms).forEach(function (a) {
    var df = arms[a], se = 0, sb = 0, nb = 0, sg = 0, ng = 0;
    L.forEach(function (r) {
      var fr = fairWith(r, df), e = fr - r.margin, o = S.orient ? S.orient(r) : 1;
      se += Math.abs(e); if (o) { sb += o * e; nb++; }
      if (r.close != null) { sg += Math.abs(fr - r.close); ng++; }
    });
    out.arms[a] = { mae: L.length ? r3(se / L.length) : null, bias: nb ? r3(sb / nb) : null,
      bias_se: nb ? r3(16 / Math.sqrt(nb)) : null, mean_abs_gap_to_close: ng ? r3(sg / ng) : null };
  });
  out.deltas = {};
  Object.keys(arms).filter(function (a) { return a !== 'standard'; }).forEach(function (a) {
    ['standard', 'v1'].filter(function (b) { return b !== a && arms[b]; }).forEach(function (b) {
      var d = L.map(function (r) { return Math.abs(fairWith(r, arms[a]) - r.margin) - Math.abs(fairWith(r, arms[b]) - r.margin); });
      var m = d.length ? d.reduce(function (x, y) { return x + y; }, 0) / d.length : null, ci = bootCI(d);
      out.deltas[a + '_vs_' + b] = { delta_mae: r3(m), ci95: ci, significant: !!(ci && (ci[1] < 0 || ci[0] > 0)) };
    });
  });
  return out;
}

/* ---------- the protocol ----------------------------------------------------- */
function seasons(lo, hi) { return rows.filter(function (r) { return r.season >= lo && r.season <= hi; }); }
var CANDIDATES = ['w_raw', 'w_centred', 'shift'];
/* STAGE A — SELECTION, on the fit years only: fit 2021-2022, score 2023 */
var selection = CANDIDATES.map(function (fam) {
  var ft = fitFamily(fam, seasons(FIT_FROM, FIT_TO - 1)), te = seasons(FIT_TO, FIT_TO);
  return { family: fam, fitted_on: FIT_FROM + '-' + (FIT_TO - 1), params: ft.params, validated_on: FIT_TO,
    mae: r3(mae(te, FAM[fam](ft.params))), mae_standard: r3(mae(te, FAM.standard())) };
});
var chosen = selection.slice().sort(function (a, b) { return a.mae - b.mae; })[0].family;
/* STAGE B — the HOLDOUT, once: every candidate refitted on 2021-2023 (so the
   table is complete), the chosen one named */
var fitRows = seasons(FIT_FROM, FIT_TO), holdRows = rows.filter(function (r) { return HOLD.indexOf(r.season) >= 0; });
var FITS = { v1: { params: V1_SHIPPED } };
CANDIDATES.forEach(function (fam) { FITS[fam] = fitFamily(fam, fitRows); });
var ARMS = { standard: FAM.standard(), v1: FAM.v1(V1_SHIPPED) };
CANDIDATES.forEach(function (fam) { ARMS[fam] = FAM[fam](FITS[fam].params); });
var holdout = {}; Object.keys(SUBSETS).forEach(function (sub) { holdout[sub] = subsetStats(holdRows, ARMS, sub); });
var bySeason = HOLD.map(function (S) {
  var L = holdRows.filter(function (r) { return r.season === S; }), R = L.filter(SUBSETS.regime_subset.pick), o = { season: S, games: L.length, regime_games: R.length };
  Object.keys(ARMS).forEach(function (a) { o['mae_' + a] = r3(mae(L, ARMS[a])); o['regime_mae_' + a] = r3(mae(R, ARMS[a])); });
  return o;
});
/* the expanding window for the chosen family: each holdout season fitted on the seasons before it */
var expanding = HOLD.map(function (S) {
  var ft = fitFamily(chosen, seasons(FIT_FROM, S - 1)), te = seasons(S, S), R = te.filter(SUBSETS.regime_subset.pick);
  return { season: S, fitted_on: FIT_FROM + '-' + (S - 1), params: ft.params, games: te.length,
    mae_standard: r3(mae(te, FAM.standard())), mae_chosen: r3(mae(te, FAM[chosen](ft.params))), mae_v1: r3(mae(te, ARMS.v1)),
    regime_games: R.length, regime_mae_standard: r3(mae(R, FAM.standard())), regime_mae_chosen: r3(mae(R, FAM[chosen](ft.params))), regime_mae_v1: r3(mae(R, ARMS.v1)) };
});
/* STAGE C — SHIP: the chosen family refitted on every completed 2021+ season */
var shipRows = seasons(FIT_FROM, LAST), SHIP = fitFamily(chosen, shipRows);

/* ---------- self-check -------------------------------------------------------- */
var selfCheck = (function () {
  var worst = 0;
  PROBES.forEach(function (pr) { worst = Math.max(worst, Math.abs(fairWith(pr.row, FAM[pr.family](pr.params)) - pr.engine_fair)); });
  return { probes: PROBES.length, families: PROBE_FAMILIES, max_abs_difference: worst, ok: PROBES.length > 0 && worst < 1e-9 };
})();
if (!selfCheck.ok) { console.error('[FAIL] analytic regime counterfactual disagrees with engine.js: ' + JSON.stringify(selfCheck)); process.exitCode = 1; }

var H = holdout;
var verdict = (function () {
  var d = H.all.deltas[chosen + '_vs_standard'], dv = H.all.deltas[chosen + '_vs_v1'], dr = H.regime_subset.deltas[chosen + '_vs_v1'];
  var promote = d.delta_mae <= 0 && dv.delta_mae <= 0 && dr.delta_mae <= 0;
  return { chosen: chosen, promote: promote,
    rule: 'promote only if, on the 2024-2025 holdout, the chosen family is no worse than the standard curve AND no worse than the shipped v1 curve on all games and on the regime subset (point estimates); significance is reported, not required, because v1 itself is the incumbent',
    all_vs_standard: d, all_vs_v1: dv, regime_vs_v1: dr };
})();
var report = {
  schema: 'edgedesk_cfb_regime_magnitude_backtest_v1',
  generated_at: new Date().toISOString(),
  engine_model_version: P.model_version,
  protocol: { selection: 'fit ' + FIT_FROM + '-' + (FIT_TO - 1) + ', validate ' + FIT_TO + ' (fit years only)',
    holdout: HOLD, holdout_fit: FIT_FROM + '-' + FIT_TO, holdout_never_fitted: true, ship_fit: FIT_FROM + '-' + LAST,
    disclosure: 'w_raw and w_centred were each scored on the 2024-2025 holdout once while this family list was being built; shift was added after those two looks. The selection among the three is made on 2023 alone, but the holdout is not pristine for the family list: read its confidence intervals as optimistic.',
    objective: 'MAE of the engine fair margin vs the final margin, every FBS-vs-FBS game', market_is_an_input: false,
    closing_line_use: 'diagnostic only (mean |fair − close|)' },
  data: { replay_from: REPLAY_FROM, games_projected: rows.length, fit_games: fitRows.length, holdout_games: holdRows.length,
    regime_history_rows: histRows,
    sources: ['cfbfastR-data schedules', 'cfbfastR-cfb-data coach_tendencies', 'cfbfastR-data rosters (athlete_id continuity, portal)',
      'cfbfastR-data player_stats (returning production, production-weighted portal inflow, QB starts)',
      'cfbfastR-data betting archive (closing spreads, diagnostics only)'] },
  features: 'football/coaching/regime_signal.js magnitudeFeatures: coach 0/1; prod = max(0, 1 − 2·returning production pct); qb 0/1; port = max(0, 2·incoming production pct − 1)',
  families: { w_raw: 'w = w_std·exp(−a·f), cut weight onto the raw this-season track', w_centred: 'w = w_std·exp(−a·f), cut weight onto the centred track (engine.js trackCentres)',
    shift: 'long-run rating + (b·f)·exp(−λg), standard weight', v1: 'binary curve as shipped (w0 ' + V1_SHIPPED.w0 + ', λ ' + V1_SHIPPED.lambda + ')' },
  stage_a_selection: selection, chosen: chosen,
  stage_b_fits: FITS, holdout: holdout, holdout_by_season: bySeason, expanding_window: expanding,
  shipped: { family: chosen, fitted_on: FIT_FROM + '-' + LAST, games: shipRows.length, params: SHIP.params, in_sample_mae: r3(SHIP.mae),
    in_sample_mae_standard: r3(mae(shipRows, FAM.standard())) },
  verdict: verdict, self_check: selfCheck
};
console.log(JSON.stringify({ selection: selection, chosen: chosen, fits: FITS, holdout: holdout, by_season: bySeason, expanding: expanding,
  shipped: report.shipped, verdict: verdict, self_check: selfCheck }, null, 1));

if (WRITE) {
  var rep = path.join(HERE, 'report', 'regime_magnitude_backtest.json');
  fs.writeFileSync(rep, JSON.stringify(report, null, 1) + '\n');
  /* A SEPARATE artifact: the v1 curve (regime_curve.js, regime_backtest.js)
     keeps pricing unless this one says promoted. football/coaching/
     build_regime.js publishes every programme's v2 inputs and magnitude from
     it, and forwards a magnitude to the engine ONLY when promoted is true. */
  var A = holdout.all, Rg = holdout.regime_subset;
  var art = {
    version: 'cfb_regime_magnitude_v2',
    generated_by: 'football/cfb_p4/research/regime_magnitude_backtest.js',
    generated_at: report.generated_at,
    engine_model_version: P.model_version,
    status: verdict.promote ? 'PROMOTED' : 'CANDIDATE',
    promoted: verdict.promote,
    family: chosen, form: report.families[chosen], features: report.features,
    params: SHIP.params, fitted_on: report.shipped.fitted_on,
    evaluation_params: FITS[chosen].params, evaluation_fitted_on: report.protocol.holdout_fit,
    verdict: verdict,
    record: { holdout: HOLD.join('-'), chosen: chosen,
      all_games: { games: A.games, mae_standard: A.arms.standard.mae, mae_v1: A.arms.v1.mae, mae_v2: A.arms[chosen].mae,
        v2_vs_standard: A.deltas[chosen + '_vs_standard'], v2_vs_v1: A.deltas[chosen + '_vs_v1'] },
      regime_subset: { games: Rg.games, mae_standard: Rg.arms.standard.mae, mae_v1: Rg.arms.v1.mae, mae_v2: Rg.arms[chosen].mae,
        bias_standard: Rg.arms.standard.bias, bias_v1: Rg.arms.v1.bias, bias_v2: Rg.arms[chosen].bias,
        v1_vs_standard: Rg.deltas.v1_vs_standard, v2_vs_standard: Rg.deltas[chosen + '_vs_standard'], v2_vs_v1: Rg.deltas[chosen + '_vs_v1'] } },
    report: 'football/cfb_p4/research/report/regime_magnitude_backtest.json'
  };
  var js = '/* GENERATED by football/cfb_p4/research/regime_magnitude_backtest.js --write. Do not edit by hand.\n'
    + '   The v2 regime prior: a continuous turnover MAGNITUDE (coach change, returning production, QB\n'
    + '   change, production-weighted portal inflow; football/coaching/regime_signal.js), fitted walk-forward\n'
    + '   on 2021+ seasons and scored on a 2024-2025 holdout it never saw. It prices ONLY when promoted is\n'
    + '   true; otherwise football/coaching/build_regime.js publishes it as research and the v1 curve\n'
    + '   (regime_curve.js) keeps pricing. */\n'
    + '(function (root) {\n  var R = ' + JSON.stringify(art, null, 1).replace(/\n/g, '\n  ') + ';\n'
    + '  root.EDCfbP4RegimeMagnitude = R;\n  if (typeof module !== \'undefined\' && module.exports) module.exports = R;\n'
    + '})(typeof window !== \'undefined\' ? window : globalThis);\n';
  fs.writeFileSync(path.join(HERE, '..', 'regime_magnitude.js'), js);
  console.error('[write] ' + rep + ' and football/cfb_p4/regime_magnitude.js');
}
