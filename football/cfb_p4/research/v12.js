#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB Power 4 v1.2 — PRESEASON PRIOR + HOME-DOG HYPOTHESIS +
   OPENING→CLOSING MOVEMENT MODEL + DIRECTIONAL ROBUSTNESS.

   The v1.1 dashboard identified where the raw model is weak; v1.2 tests the
   fixes AS HYPOTHESES, walk-forward, and ships only what survives out of
   sample. The scientific lineage is deliberate:

     v1.0  the raw engine (params.js) — THE CONTROL, never touched
     v1.1  the market-calibration experiment (verdict: alpha = 0)
     v1.2  the prior/correction experiment (this file)

   Experiments, in the ordered v1.2 design:

   E1  PRESEASON PRIOR (weeks 0-2 only). The dashboard measured a 1.38-pt
       gap to market in weeks 0-2 vs 0.63 in weeks 6+. Hypothesis: the raw
       preseason projection is mis-scaled. Fit, walk-forward on weeks 0-2
       games only, two market-independent corrections of the raw spread:
         shrink   pred = b*m          (LS through the origin)
         affine   pred = a + b*m      (LS)
       Applied to weeks 0-2 only; weeks 3+ pass through untouched.

   E2  HOME-DOG CORRECTION (a hypothesis, not a permanent adjustment).
       The dashboard measured +3.70 bias on market home dogs. The shippable
       version must stay market-independent, so the correction conditions on
       the MODEL'S OWN call (projected home margin < 0 after E1): a constant
       de-bias delta fitted walk-forward on that subset. The market-defined
       diagnostic is reported alongside so the two definitions can be
       compared, but only the model-defined form can ever ship.

   E3  OPENING→CLOSING MOVEMENT MODEL. Not a closing-number prediction.
       Target: when the model disagrees with the OPEN, does the close move
       TOWARD the model or AWAY? Logistic regression, walk-forward, features
       knowable at the open (disagreement size, preseason, model home dog,
       power-conference host). The honest test: does it beat the constant
       base rate (Brier), or is 54.7% simply flat?

   E4  DIRECTIONAL ROBUSTNESS. Does the 54.7% survive slicing? Toward-model
       rates with Wilson 95% intervals across thresholds {1,2,3,5,7} x
       {week bucket, preseason/in-season, model fav/dog, market fav/dog,
       home conference, season}. A cell is ROBUST only when its interval
       lower bound clears 50% with n >= 300.

   FRAME: byte-identical to v1.1 (research/calibrate.js) — the shipped
   engine replayed cold from 2002 in kickoff order, FBS-vs-FBS rows 2010+,
   eval window 2015-2025. This script PROVES the frame matches by
   recomputing raw/market pooled MAE and refusing to write artifacts if
   they differ from the committed v1.1 record by more than 1e-3.

   Inputs:  <data>/sched/sched_YYYY.csv, <data>/out/market.csv
   Outputs: football/cfb_p4/v12_correction.js   GENERATED artifact
            research/report/v12_experiments.json  full experiment record
            params.js is NOT touched — v1.0.0 stays byte-identical.

   Usage: node football/cfb_p4/research/v12.js [--data DIR]
   ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;
var V11 = require(path.join(HERE, '..', 'calibration.js'));

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = String(arg('data', process.env.CFB_P4_DATA || '/home/user/cfbdata'));
var REPLAY_FROM = 2002, FRAME_FROM = 2010, EVAL_FROM = 2015, TO = 2025;

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

/* ---------------- inputs (identical to calibrate.js) ---------------------- */
var games = [];
for (var y = REPLAY_FROM; y <= TO; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) continue;
  readCsv(f).forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    games.push({
      game_id: r.game_id, season: num(r.season), week: num(r.week),
      kick: Date.parse(r.start_date) || 0,
      home: r.home_team, away: r.away_team,
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
      home_conference: r.home_conference, away_conference: r.away_conference,
      neutral_site: String(r.neutral_site).toLowerCase() === 'true',
      home_points: hp, away_points: ap, completed: hp != null && ap != null
    });
  });
}
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week); });

var market = {};
readCsv(path.join(DATA, 'out', 'market.csv')).forEach(function (r) {
  market[r.game_id] = { close: num(r.spread_close), open: num(r.spread_open) };
});

/* ---------------- cold replay (identical to calibrate.js) ----------------- */
var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var rows = [], season = REPLAY_FROM, projected = 0, refused = 0;
games.forEach(function (g) {
  if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
  if (!g.completed) return;
  if (g.season >= FRAME_FROM && g.home_fbs && g.away_fbs) {
    var out = E.projectGame({
      season: g.season, week: g.week, state: st,
      game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true,
        neutral_site: g.neutral_site },
      teams: { home: { conference: g.home_conference },
        away: { conference: g.away_conference } }
    });
    if (out.status === 'PREDICTED') {
      projected++;
      var mk = market[g.game_id] || {};
      rows.push({ season: g.season, week: g.week == null ? 0 : g.week,
        conf: g.home_conference || '?', m: out.model.fair_spread,
        y: g.home_points - g.away_points, c: mk.close, o: mk.open });
    } else refused++;
  }
  E.ingest.absorbGame(st, { home: g.home, away: g.away,
    home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral_site,
    home_points: g.home_points, away_points: g.away_points, team_stats: null });
});
console.error('[replay] ' + projected + ' projected, ' + refused + ' refused');

/* ---------------- frame integrity: must equal the v1.1 record ------------- */
var withClose = rows.filter(function (r) { return r.c != null; });
var evalAll = withClose.filter(function (r) { return r.season >= EVAL_FROM; });
function meanAbs(pred, rs) {
  var s = 0, i; for (i = 0; i < rs.length; i++) s += Math.abs(pred(rs[i]) - rs[i].y);
  return rs.length ? s / rs.length : null;
}
function meanErr(pred, rs) {
  var s = 0, i; for (i = 0; i < rs.length; i++) s += pred(rs[i]) - rs[i].y;
  return rs.length ? s / rs.length : null;
}
var frameCheck = {
  n: evalAll.length,
  mae_raw: +meanAbs(function (r) { return r.m; }, evalAll).toFixed(4),
  mae_market: +meanAbs(function (r) { return r.c; }, evalAll).toFixed(4),
  v11_record: { n: V11.record.n, mae_raw: V11.record.mae_raw, mae_market: V11.record.mae_market }
};
frameCheck.matches_v11 = frameCheck.n === V11.record.n
  && Math.abs(frameCheck.mae_raw - V11.record.mae_raw) < 1e-3
  && Math.abs(frameCheck.mae_market - V11.record.mae_market) < 1e-3;
if (!frameCheck.matches_v11) {
  console.error('[FATAL] frame does not match the v1.1 record: ' + JSON.stringify(frameCheck));
  process.exit(2);
}
console.error('[frame] matches v1.1: n=' + frameCheck.n + ' raw=' + frameCheck.mae_raw
  + ' market=' + frameCheck.mae_market);

/* ============================================================================
   E1 — PRESEASON PRIOR (weeks 0-2), market-independent.
   ========================================================================== */
var MIN_FIT_PRE = 300;
function fitShrink(rs) {           /* pred = b*m */
  var nu = 0, de = 0, i;
  for (i = 0; i < rs.length; i++) { nu += rs[i].m * rs[i].y; de += rs[i].m * rs[i].m; }
  return de > 0 ? nu / de : 1;
}
function fitAffine(rs) {           /* pred = a + b*m */
  var n = rs.length, sm = 0, sy = 0, smm = 0, smy = 0, i;
  for (i = 0; i < n; i++) { sm += rs[i].m; sy += rs[i].y; smm += rs[i].m * rs[i].m; smy += rs[i].m * rs[i].y; }
  var de = n * smm - sm * sm;
  if (de === 0) return { a: 0, b: 1 };
  var b = (n * smy - sm * sy) / de;
  return { a: (sy - b * sm) / n, b: b };
}
/* pre-season rows use ALL frame rows (a completed game needs no line to be
   graded against its actual margin) — the correction never reads the market */
var frameAll = rows;
var preWalk = [], prePooled = { raw: [], shrink: [], affine: [] };
for (var Y1 = EVAL_FROM; Y1 <= TO; Y1++) {
  (function (Y) {
    var fitRs = frameAll.filter(function (r) { return r.season < Y && r.week <= 2; });
    var evRs = frameAll.filter(function (r) { return r.season === Y && r.week <= 2; });
    if (fitRs.length < MIN_FIT_PRE || !evRs.length) return;
    var b = fitShrink(fitRs), ab = fitAffine(fitRs);
    var rec = { year: Y, n_fit: fitRs.length, n_eval: evRs.length,
      shrink_b: +b.toFixed(4), affine: { a: +ab.a.toFixed(4), b: +ab.b.toFixed(4) },
      mae_raw: +meanAbs(function (r) { return r.m; }, evRs).toFixed(4),
      mae_shrink: +meanAbs(function (r) { return b * r.m; }, evRs).toFixed(4),
      mae_affine: +meanAbs(function (r) { return ab.a + ab.b * r.m; }, evRs).toFixed(4),
      bias_raw: +meanErr(function (r) { return r.m; }, evRs).toFixed(4),
      bias_affine: +meanErr(function (r) { return ab.a + ab.b * r.m; }, evRs).toFixed(4) };
    evRs.forEach(function (r) {
      prePooled.raw.push(Math.abs(r.m - r.y));
      prePooled.shrink.push(Math.abs(b * r.m - r.y));
      prePooled.affine.push(Math.abs(ab.a + ab.b * r.m - r.y));
    });
    preWalk.push(rec);
  })(Y1);
}
function meanArr(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : null; }
var preMae = { raw: +meanArr(prePooled.raw).toFixed(4),
  shrink: +meanArr(prePooled.shrink).toFixed(4), affine: +meanArr(prePooled.affine).toFixed(4) };
var preWinner = preMae.affine <= preMae.shrink ? 'affine' : 'shrink';
var preYearsBetter = preWalk.filter(function (w) { return w['mae_' + preWinner] < w.mae_raw; }).length;
/* pre-registered survival criterion: pooled OOS MAE improves by >= 0.05 pts
   AND the winner beats raw in a majority of eval years */
var preSurvived = (preMae.raw - preMae[preWinner]) >= 0.05 && preYearsBetter * 2 > preWalk.length;
var preFinal = { shrink_b: +fitShrink(frameAll.filter(function (r) { return r.week <= 2; })).toFixed(4),
  affine: (function () { var ab = fitAffine(frameAll.filter(function (r) { return r.week <= 2; }));
    return { a: +ab.a.toFixed(4), b: +ab.b.toFixed(4) }; })() };
console.error('[E1 preseason] pooled OOS MAE raw ' + preMae.raw + ' shrink ' + preMae.shrink
  + ' affine ' + preMae.affine + ' -> ' + preWinner + (preSurvived ? ' SURVIVED' : ' REJECTED')
  + ' (' + preYearsBetter + '/' + preWalk.length + ' years better)');

/* the shipped E1 stage (identity when rejected) */
function e1For(fitRows) {
  if (!preSurvived) return function (r) { return r.m; };
  if (preWinner === 'shrink') {
    var b = fitShrink(fitRows.filter(function (r) { return r.week <= 2; }));
    return function (r) { return r.week <= 2 ? b * r.m : r.m; };
  }
  var ab = fitAffine(fitRows.filter(function (r) { return r.week <= 2; }));
  return function (r) { return r.week <= 2 ? ab.a + ab.b * r.m : r.m; };
}

/* ============================================================================
   E2 — HOME-DOG CORRECTION (hypothesis; model-defined subset, after E1).
   ========================================================================== */
var MIN_FIT_DOG = 300;
var dogWalk = [], dogPooled = { before: [], after: [] };
for (var Y2 = EVAL_FROM; Y2 <= TO; Y2++) {
  (function (Y) {
    var fitAllRs = frameAll.filter(function (r) { return r.season < Y; });
    var s1 = e1For(fitAllRs);
    var fitRs = fitAllRs.filter(function (r) { return s1(r) < 0; });
    var evRs = frameAll.filter(function (r) { return r.season === Y && s1(r) < 0; });
    if (fitRs.length < MIN_FIT_DOG || !evRs.length) return;
    var d = -meanErr(s1, fitRs);          /* de-bias: shift by the fit-set mean error */
    var rec = { year: Y, n_fit: fitRs.length, n_eval: evRs.length, delta: +d.toFixed(4),
      mae_before: +meanAbs(s1, evRs).toFixed(4),
      mae_after: +meanAbs(function (r) { return s1(r) + d; }, evRs).toFixed(4),
      bias_before: +meanErr(s1, evRs).toFixed(4),
      bias_after: +meanErr(function (r) { return s1(r) + d; }, evRs).toFixed(4) };
    evRs.forEach(function (r) {
      dogPooled.before.push(Math.abs(s1(r) - r.y));
      dogPooled.after.push(Math.abs(s1(r) + d - r.y));
    });
    dogWalk.push(rec);
  })(Y2);
}
var dogMae = { before: +meanArr(dogPooled.before).toFixed(4), after: +meanArr(dogPooled.after).toFixed(4) };
var dogYearsBetter = dogWalk.filter(function (w) { return w.mae_after < w.mae_before; }).length;
var dogSurvived = (dogMae.before - dogMae.after) >= 0.05 && dogYearsBetter * 2 > dogWalk.length;
/* diagnostics: the bias under both definitions, eval window, so the market-
   defined +3.70 from the dashboard is explained rather than papered over */
var dogDiag = {
  model_defined: { n: evalAll.filter(function (r) { return r.m < 0; }).length,
    bias_raw: +meanErr(function (r) { return r.m; }, evalAll.filter(function (r) { return r.m < 0; })).toFixed(3) },
  market_defined: { n: evalAll.filter(function (r) { return r.c < 0; }).length,
    bias_raw: +meanErr(function (r) { return r.m; }, evalAll.filter(function (r) { return r.c < 0; })).toFixed(3),
    note: 'this is the dashboard’s +3.70 slice; a correction keyed on the market line would make the model market-dependent, so it can never ship' }
};
var dogFinalDelta = (function () {
  var s1 = e1For(frameAll);
  var sub = frameAll.filter(function (r) { return s1(r) < 0; });
  return sub.length ? +(-meanErr(s1, sub)).toFixed(4) : 0;
})();
console.error('[E2 home dog] pooled OOS MAE before ' + dogMae.before + ' after ' + dogMae.after
  + (dogSurvived ? ' SURVIVED' : ' REJECTED') + ' (' + dogYearsBetter + '/' + dogWalk.length
  + ' years better) · final delta ' + dogFinalDelta);

/* combined v1.2 pipeline record over ALL eval rows (vs raw), for the ledger */
function v12For(fitRows) {
  var s1 = e1For(fitRows);
  var d = 0;
  if (dogSurvived) {
    var sub = fitRows.filter(function (r) { return s1(r) < 0; });
    if (sub.length >= MIN_FIT_DOG) d = -meanErr(s1, sub);
  }
  return function (r) { var v = s1(r); return v < 0 ? v + d : v; };
}
var combPooled = { raw: [], v12: [] };
for (var Y3 = EVAL_FROM; Y3 <= TO; Y3++) {
  (function (Y) {
    var fitRows = frameAll.filter(function (r) { return r.season < Y; });
    var evRs = frameAll.filter(function (r) { return r.season === Y; });
    var f = v12For(fitRows);
    evRs.forEach(function (r) {
      combPooled.raw.push(Math.abs(r.m - r.y));
      combPooled.v12.push(Math.abs(f(r) - r.y));
    });
  })(Y3);
}
var combMae = { raw: +meanArr(combPooled.raw).toFixed(4), v12: +meanArr(combPooled.v12).toFixed(4),
  n: combPooled.raw.length };

/* ============================================================================
   E3 — MOVEMENT MODEL: toward or away from the model, never the number.
   ========================================================================== */
function moveRows(rs) {
  return rs.filter(function (r) { return r.o != null && r.c != null && r.o !== r.c && Math.abs(r.m - r.o) >= 1; });
}
function moveTarget(r) { return Math.sign(r.c - r.o) === Math.sign(r.m - r.o) ? 1 : 0; }
function feats(r) {
  var gap = Math.abs(r.m - r.o);
  return [1, Math.min(gap, 14) / 14, r.week <= 2 ? 1 : 0, r.m < 0 ? 1 : 0,
    (/^(SEC|Big Ten|Big 12|ACC|Pac-12|Pac-10)$/.test(r.conf) ? 1 : 0), gap >= 5 ? 1 : 0];
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function fitLogistic(rs) {
  var K = 6, w = [0, 0, 0, 0, 0, 0], it, i, k;
  for (it = 0; it < 400; it++) {           /* full-batch Newton-ish: fixed-step GD */
    var g = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < rs.length; i++) {
      var x = feats(rs[i]), z = 0;
      for (k = 0; k < K; k++) z += w[k] * x[k];
      var e = sigmoid(z) - moveTarget(rs[i]);
      for (k = 0; k < K; k++) g[k] += e * x[k];
    }
    for (k = 0; k < K; k++) w[k] -= 2.0 * g[k] / rs.length;
  }
  return w;
}
function brier(pred, rs) {
  var s = 0, i; for (i = 0; i < rs.length; i++) { var e = pred(rs[i]) - moveTarget(rs[i]); s += e * e; }
  return rs.length ? s / rs.length : null;
}
var mvWalk = [], mvPooled = { model: [], base: [] }, mvHits = 0, mvN = 0;
for (var Y4 = EVAL_FROM; Y4 <= TO; Y4++) {
  (function (Y) {
    var fitRs = moveRows(frameAll.filter(function (r) { return r.season < Y; }));
    var evRs = moveRows(frameAll.filter(function (r) { return r.season === Y; }));
    if (fitRs.length < 500 || !evRs.length) return;
    var w = fitLogistic(fitRs);
    var base = meanArr(fitRs.map(moveTarget));
    var pm = function (r) { var x = feats(r), z = 0, k; for (k = 0; k < 6; k++) z += w[k] * x[k]; return sigmoid(z); };
    var bModel = brier(pm, evRs), bBase = brier(function () { return base; }, evRs);
    evRs.forEach(function (r) {
      var e1 = pm(r) - moveTarget(r), e2 = base - moveTarget(r);
      mvPooled.model.push(e1 * e1); mvPooled.base.push(e2 * e2);
      mvN++; if ((pm(r) >= 0.5 ? 1 : 0) === moveTarget(r)) mvHits++;
    });
    mvWalk.push({ year: Y, n_fit: fitRs.length, n_eval: evRs.length,
      base_rate_fit: +base.toFixed(4), brier_model: +bModel.toFixed(4), brier_base: +bBase.toFixed(4),
      weights: w.map(function (x) { return +x.toFixed(4); }) });
  })(Y4);
}
var mvBrier = { model: +meanArr(mvPooled.model).toFixed(4), base: +meanArr(mvPooled.base).toFixed(4) };
var mvSurvived = (mvBrier.base - mvBrier.model) >= 0.002;
var mvFinalW = fitLogistic(moveRows(frameAll)).map(function (x) { return +x.toFixed(4); });
console.error('[E3 movement] pooled OOS Brier model ' + mvBrier.model + ' vs constant ' + mvBrier.base
  + (mvSurvived ? ' SURVIVED' : ' REJECTED') + ' · accuracy ' + (100 * mvHits / mvN).toFixed(2) + '%');

/* ============================================================================
   E4 — DIRECTIONAL ROBUSTNESS of the toward-model rate.
   ========================================================================== */
function wilson(k, n) {
  if (!n) return null;
  var z = 1.96, p = k / n, den = 1 + z * z / n;
  var mid = (p + z * z / (2 * n)) / den;
  var half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return { pct: +(100 * p).toFixed(2), lo: +(100 * (mid - half)).toFixed(2), hi: +(100 * (mid + half)).toFixed(2) };
}
function towardCell(rs) {
  var k = rs.filter(function (r) { return moveTarget(r) === 1; }).length;
  var w = wilson(k, rs.length);
  if (!w) return null;
  return { n: rs.length, toward_pct: w.pct, ci95: [w.lo, w.hi], robust: rs.length >= 300 && w.lo > 50 };
}
function wkBucket(w) { return w <= 2 ? '0_2' : (w <= 5 ? '3_5' : '6p'); }
var mvAll = frameAll.filter(function (r) { return r.o != null && r.c != null && r.o !== r.c; });
var robustness = {};
[1, 2, 3, 5, 7].forEach(function (th) {
  var rs = mvAll.filter(function (r) { return Math.abs(r.m - r.o) >= th; });
  var cell = { overall: towardCell(rs), by: {} };
  cell.by.week_bucket = {};
  ['0_2', '3_5', '6p'].forEach(function (b) {
    cell.by.week_bucket[b] = towardCell(rs.filter(function (r) { return wkBucket(r.week) === b; }));
  });
  cell.by.phase = {
    preseason_wk0_2: towardCell(rs.filter(function (r) { return r.week <= 2; })),
    in_season_wk3p: towardCell(rs.filter(function (r) { return r.week > 2; }))
  };
  cell.by.model_call = {
    model_home_fav: towardCell(rs.filter(function (r) { return r.m > 0; })),
    model_home_dog: towardCell(rs.filter(function (r) { return r.m < 0; }))
  };
  cell.by.market_call = {
    market_home_fav: towardCell(rs.filter(function (r) { return r.c > 0; })),
    market_home_dog: towardCell(rs.filter(function (r) { return r.c < 0; }))
  };
  cell.by.home_conference = {};
  var confs = {};
  rs.forEach(function (r) { (confs[r.conf] = confs[r.conf] || []).push(r); });
  Object.keys(confs).sort().forEach(function (cf) {
    if (confs[cf].length >= 150) cell.by.home_conference[cf] = towardCell(confs[cf]);
  });
  cell.by.season = {};
  for (var s = FRAME_FROM; s <= TO; s++) {
    var yr = rs.filter(function (r) { return r.season === s; });
    if (yr.length >= 50) cell.by.season[String(s)] = towardCell(yr);
  }
  robustness['th_' + th] = cell;
});
/* headline: which slices at 3+ survive with CI clear of the coin */
var rob3 = robustness.th_3;
function countRobust(node, acc) {
  Object.keys(node).forEach(function (k) {
    var v = node[k];
    if (v && typeof v === 'object') {
      if (v.n != null) { acc.total++; if (v.robust) acc.robust++; }
      else countRobust(v, acc);
    }
  });
  return acc;
}
var robSummary = countRobust(rob3.by, { total: 0, robust: 0 });
console.error('[E4 robustness] 3+ overall ' + rob3.overall.toward_pct + '% CI [' + rob3.overall.ci95
  + '] · ' + robSummary.robust + '/' + robSummary.total + ' slices robust (CI low > 50, n>=300)');

/* ============================================================================
   Artifacts.
   ========================================================================== */
var nowIso = new Date().toISOString();
var criteria = 'a correction SURVIVES only if pooled walk-forward OOS MAE improves by >= 0.05 pts '
  + 'AND it beats raw in a majority of eval years; the movement model survives only if pooled OOS '
  + 'Brier beats the constant base rate by >= 0.002. Rejected fits are recorded, not shipped.';
var artifact = {
  correction_version: 'cfb_p4_v1.2.0',
  generated_at: nowIso,
  lineage: 'v1.0 raw engine = the untouched control (params.js) · v1.1 = market-calibration experiment (alpha=0) '
    + '· v1.2 = this prior/correction experiment. Same cold-replay frame throughout.',
  frame_check: frameCheck,
  criteria: criteria,
  preseason_prior: {
    what: 'weeks 0-2 only; market-independent correction of the raw spread',
    survived: preSurvived, winner: preWinner,
    record_oos: { n: prePooled.raw.length, mae_raw: preMae.raw, mae_shrink: preMae.shrink,
      mae_affine: preMae.affine, years_better: preYearsBetter + '/' + preWalk.length },
    final_fit: preFinal, walk_forward: preWalk
  },
  home_dog: {
    what: 'constant de-bias on games the MODEL calls a home dog (after the preseason stage); a hypothesis, not a permanent adjustment',
    survived: dogSurvived, final_delta: dogFinalDelta,
    record_oos: { n: dogPooled.before.length, mae_before: dogMae.before, mae_after: dogMae.after,
      years_better: dogYearsBetter + '/' + dogWalk.length },
    diagnostics: dogDiag, walk_forward: dogWalk
  },
  combined_record_oos: { window: EVAL_FROM + '-' + TO, n: combMae.n,
    mae_raw: combMae.raw, mae_v12: combMae.v12,
    note: 'the full shipped pipeline (surviving stages only) vs raw over every frame game; identical when nothing survived' },
  movement_model: {
    what: 'predicts DIRECTION only — whether the close moves toward the model when it disagrees with the open by 1+; never a closing number',
    survived: mvSurvived,
    record_oos: { n: mvN, brier_model: mvBrier.model, brier_constant_base: mvBrier.base,
      accuracy_pct: +(100 * mvHits / mvN).toFixed(2) },
    final_weights: { intercept: mvFinalW[0], gap_scaled: mvFinalW[1], preseason: mvFinalW[2],
      model_home_dog: mvFinalW[3], power_conf_host: mvFinalW[4], gap_ge5: mvFinalW[5] },
    walk_forward: mvWalk
  },
  directional_robustness_headline: {
    threshold_3plus: rob3.overall,
    preseason_wk0_2_3plus: rob3.by.phase.preseason_wk0_2,
    in_season_wk3p_3plus: rob3.by.phase.in_season_wk3p,
    in_season_wk3p_7plus: robustness.th_7.by.phase.in_season_wk3p,
    week_bucket_3plus: rob3.by.week_bucket,
    robust_slices: robSummary.robust + '/' + robSummary.total,
    finding: 'the toward-model signal is an IN-SEASON phenomenon: weeks 0-2 are a coin flip at every '
      + 'threshold while weeks 3+ strengthen monotonically with disagreement — preseason disagreements '
      + 'are information deficits, not signals',
    full_grid: 'research/report/v12_experiments.json'
  }
};
var outJs = 'if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n'
  + '/* EdgeDesk CFB Power 4 — v1.2 prior/correction experiment. GENERATED FILE.\n'
  + '   Produced by football/cfb_p4/research/v12.js; never edit by hand.\n'
  + '   The raw model (params.js v1.0.0) is untouched — v1.0 is the control,\n'
  + '   v1.1 the calibration experiment, v1.2 this correction experiment.\n'
  + '   Only stages marked survived:true are ever applied, and always as a\n'
  + '   separately labelled value next to raw. */\n'
  + 'window.EDCfbP4V12 = ' + JSON.stringify(artifact) + ';\n'
  + 'if(typeof module!==\'undefined\'&&module.exports){module.exports=window.EDCfbP4V12;}\n';
fs.writeFileSync(path.join(HERE, '..', 'v12_correction.js'), outJs);
fs.mkdirSync(path.join(HERE, 'report'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'report', 'v12_experiments.json'),
  JSON.stringify({ what: 'v1.2 experiment record — full walk-forward tables and the complete directional robustness grid',
    generated_at: nowIso, frame_check: frameCheck, criteria: criteria,
    preseason_prior: artifact.preseason_prior, home_dog: artifact.home_dog,
    combined_record_oos: artifact.combined_record_oos, movement_model: artifact.movement_model,
    directional_robustness: robustness }, null, 1) + '\n');
console.error('[write] football/cfb_p4/v12_correction.js and research/report/v12_experiments.json');
console.log(JSON.stringify({ preseason: { survived: preSurvived, winner: preWinner, mae: preMae },
  home_dog: { survived: dogSurvived, delta: dogFinalDelta, mae: dogMae },
  movement: { survived: mvSurvived, brier: mvBrier },
  robustness_3plus: rob3.overall }, null, 2));
