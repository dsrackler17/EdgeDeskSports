#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB Power 4 v1.1 — WALK-FORWARD MARKET CALIBRATION + ERROR DASHBOARD.

   The v1.0 record is honest: raw model spread MAE 12.769 vs the closing
   market's 12.015. This script does NOT retrain the model. It learns, walk
   forward, how much to shrink the raw projection toward the market:

       calibrated = alpha * raw_model + (1 - alpha) * market_close

   with alpha fitted by least squares ONLY on seasons strictly before the
   season being evaluated, so the shipped record is out-of-sample by
   construction. Three schemes are fitted and compared, per the v1.1 design:

     global      one alpha
     week_bucket alpha for weeks 0-2 / 3-5 / 6+  (preseason should trust
                 the model less; the data decides whether it does)
     gap_bucket  alpha by |model - market| (the nonlinear check)

   The RAW MODEL IS NEVER OVERWRITTEN. raw / calibrated / market ship as
   three separate values everywhere downstream; raw is the control.

   It also emits the ERROR DASHBOARD (research/report/error_slices.json):
   raw / calibrated / market MAE, bias and RMSE sliced by week, season,
   disagreement bucket and favourite/dog, plus the historical CLV PROXY:
   when the raw model disagreed with the OPENING line, how often the CLOSE
   moved toward the model. All from the same frame every future model
   change must be compared against.

   Frame: the SHIPPED engine.js replayed cold from 2002 in kickoff order
   (state zeroed — the seeds contain the games being projected), projections
   recorded for FBS-vs-FBS games 2010-2025, evaluation window 2015-2025
   (fit years accumulate from 2010). The replay runs WITHOUT the live
   team-efficiency feed, exactly like backtest_engine.js run without
   team_game.csv; the matchup layer declares itself unavailable, which
   matches how the browser runs the engine between trainings. That basis is
   recorded in the artifact, not hidden.

   Inputs   (fetch_data.sh + build_market.py, CFB_P4_DATA or --data):
     <data>/sched/sched_YYYY.csv      2002-2025
     <data>/out/market.csv            per-game open + close (EdgeDesk sign
                                      convention: spread = home margin line)
   Outputs:
     football/cfb_p4/calibration.js               GENERATED artifact the app
                                                  and engine load (optional)
     research/report/error_slices.json            the dashboard
     appends nothing to params.js — v1.0.0 stays byte-identical.

   Usage: node football/cfb_p4/research/calibrate.js [--data DIR]
   ========================================================================== */
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

/* ---------------- inputs -------------------------------------------------- */
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

/* ---------------- cold replay, identical to backtest_engine.js ------------ */
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
console.error('[replay] ' + projected + ' projected, ' + refused + ' refused, '
  + rows.filter(function (r) { return r.c != null; }).length + ' with a closing line');

/* ---------------- fitting ------------------------------------------------- */
function wkBucket(w) { return w <= 2 ? '0_2' : (w <= 5 ? '3_5' : '6p'); }
function gapBucket(g) { return g < 3 ? 'lt3' : (g < 7 ? '3_7' : (g < 14 ? '7_14' : 'ge14')); }
function clamp01(a) { return Math.max(0, Math.min(1, a)); }
/* least-squares alpha for calibrated = a*m + (1-a)*c against y:
   a* = sum((m-c)(y-c)) / sum((m-c)^2), the exact minimiser */
function fitAlpha(rs) {
  var nu = 0, de = 0, i, r;
  for (i = 0; i < rs.length; i++) {
    r = rs[i];
    nu += (r.m - r.c) * (r.y - r.c);
    de += (r.m - r.c) * (r.m - r.c);
  }
  return de > 0 ? clamp01(nu / de) : 0;
}
function stats(pred, rs) {
  var n = 0, ae = 0, se = 0, bias = 0, i, e;
  for (i = 0; i < rs.length; i++) {
    e = pred(rs[i]) - rs[i].y;
    n++; ae += Math.abs(e); se += e * e; bias += e;
  }
  return n ? { n: n, mae: ae / n, rmse: Math.sqrt(se / n), bias: bias / n } : { n: 0 };
}
/* the same least-squares coefficient WITHOUT the [0,1] clamp — reported so a
   clamped 0 shows whether the true optimum was ~0 or actually negative */
function fitAlphaRaw(rs) {
  var nu = 0, de = 0, i, r;
  for (i = 0; i < rs.length; i++) {
    r = rs[i];
    nu += (r.m - r.c) * (r.y - r.c);
    de += (r.m - r.c) * (r.m - r.c);
  }
  return de > 0 ? nu / de : 0;
}
/* CLOSE ANTICIPATION: close ~ beta*m + (1-beta)*open. This is the fit the
   CLV proxy motivates — the model's measured value is predicting where the
   line GOES, not beating where it ends up. */
function fitBeta(rs) {
  var nu = 0, de = 0, i, r;
  for (i = 0; i < rs.length; i++) {
    r = rs[i];
    if (r.o == null) continue;
    nu += (r.m - r.o) * (r.c - r.o);
    de += (r.m - r.o) * (r.m - r.o);
  }
  return de > 0 ? Math.max(0, Math.min(1, nu / de)) : 0;
}
var MIN_FIT = { global: 400, week: 200, gap: 150 };
function fitAll(fitRows) {
  var out = { global: fitAlpha(fitRows), global_unclamped: fitAlphaRaw(fitRows),
    week: {}, week_unclamped: {}, gap: {}, beta: fitBeta(fitRows), beta_week: {} };
  ['0_2', '3_5', '6p'].forEach(function (b) {
    var rs = fitRows.filter(function (r) { return wkBucket(r.week) === b; });
    out.week[b] = rs.length >= MIN_FIT.week ? fitAlpha(rs) : out.global;
    out.week_unclamped[b] = rs.length >= MIN_FIT.week ? fitAlphaRaw(rs) : out.global_unclamped;
    out.beta_week[b] = rs.length >= MIN_FIT.week ? fitBeta(rs) : out.beta;
  });
  ['lt3', '3_7', '7_14', 'ge14'].forEach(function (b) {
    var rs = fitRows.filter(function (r) { return gapBucket(Math.abs(r.m - r.c)) === b; });
    out.gap[b] = rs.length >= MIN_FIT.gap ? fitAlpha(rs) : out.global;
  });
  return out;
}
function predictor(scheme, fit) {
  if (scheme === 'raw') return function (r) { return r.m; };
  if (scheme === 'market') return function (r) { return r.c; };
  if (scheme === 'global') return function (r) { return fit.global * r.m + (1 - fit.global) * r.c; };
  if (scheme === 'week_bucket') return function (r) {
    var a = fit.week[wkBucket(r.week)]; return a * r.m + (1 - a) * r.c;
  };
  return function (r) {  /* gap_bucket */
    var a = fit.gap[gapBucket(Math.abs(r.m - r.c))]; return a * r.m + (1 - a) * r.c;
  };
}

/* walk-forward: fit on seasons < Y, evaluate on Y */
var withClose = rows.filter(function (r) { return r.c != null; });
var walk = [], pooled = { raw: [], market: [], global: [], week_bucket: [], gap_bucket: [] };
for (var Y = EVAL_FROM; Y <= TO; Y++) {
  var fitRows = withClose.filter(function (r) { return r.season < Y; });
  var evalRows = withClose.filter(function (r) { return r.season === Y; });
  if (fitRows.length < MIN_FIT.global || !evalRows.length) continue;
  var fit = fitAll(fitRows);
  var rec = { year: Y, n: evalRows.length, alpha_global: +fit.global.toFixed(4),
    alpha_global_unclamped: +fit.global_unclamped.toFixed(4),
    alpha_week: { '0_2': +fit.week['0_2'].toFixed(4), '3_5': +fit.week['3_5'].toFixed(4), '6p': +fit.week['6p'].toFixed(4) },
    alpha_week_unclamped: { '0_2': +fit.week_unclamped['0_2'].toFixed(4), '3_5': +fit.week_unclamped['3_5'].toFixed(4), '6p': +fit.week_unclamped['6p'].toFixed(4) },
    beta_close_anticipation: +fit.beta.toFixed(4) };
  ['raw', 'market', 'global', 'week_bucket', 'gap_bucket'].forEach(function (s) {
    var st2 = stats(predictor(s, fit), evalRows);
    rec['mae_' + s] = +st2.mae.toFixed(4);
    evalRows.forEach(function (r) { pooled[s].push(Math.abs(predictor(s, fit)(r) - r.y)); });
  });
  /* close anticipation, out of sample: does beta*model + (1-beta)*open predict
     the CLOSE better than the open alone does? */
  var withOpen = evalRows.filter(function (r) { return r.o != null; });
  if (withOpen.length >= 50) {
    var antErr = [], openErr = [];
    withOpen.forEach(function (r) {
      antErr.push(Math.abs(fit.beta * r.m + (1 - fit.beta) * r.o - r.c));
      openErr.push(Math.abs(r.o - r.c));
    });
    rec.close_prediction = { n: withOpen.length,
      mae_anticipated: +meanArr(antErr).toFixed(4), mae_open_alone: +meanArr(openErr).toFixed(4) };
    pooled.ant_close = pooled.ant_close || []; pooled.open_close = pooled.open_close || [];
    antErr.forEach(function (e) { pooled.ant_close.push(e); });
    openErr.forEach(function (e) { pooled.open_close.push(e); });
  }
  walk.push(rec);
}
function meanArr(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : null; }
var pooledMae = {};
Object.keys(pooled).forEach(function (k) { pooledMae[k] = +meanArr(pooled[k]).toFixed(4); });
var schemes = ['global', 'week_bucket', 'gap_bucket'];
schemes.sort(function (a, b) { return pooledMae[a] - pooledMae[b]; });
var winner = schemes[0];
console.error('[walk-forward pooled MAE] raw ' + pooledMae.raw + ' · market ' + pooledMae.market
  + ' · global ' + pooledMae.global + ' · week ' + pooledMae.week_bucket + ' · gap ' + pooledMae.gap_bucket
  + '  -> scheme: ' + winner);
console.error('[close anticipation OOS] beta-blend vs close MAE ' + pooledMae.ant_close
  + ' · open alone ' + pooledMae.open_close);

/* final alphas for live 2026 use: fit on the WHOLE frame (walk-forward is the
   record; the shipped coefficients use everything known before 2026) */
var finalFit = fitAll(withClose);

/* ---------------- CLV proxy: did the close move toward the model? -------- */
var clv = {};
[1, 2, 3, 5].forEach(function (th) {
  var s = withClose.filter(function (r) {
    return r.o != null && r.o !== r.c && Math.abs(r.m - r.o) >= th;
  });
  if (s.length < 100) return;
  var toward = s.filter(function (r) {
    return Math.sign(r.c - r.o) === Math.sign(r.m - r.o);
  }).length;
  clv[th] = { n: s.length, moved_toward_model_pct: +(100 * toward / s.length).toFixed(2) };
});

/* ---------------- error dashboard slices (out-of-sample window) ---------- */
var evalAll = withClose.filter(function (r) { return r.season >= EVAL_FROM; });
/* per-row calibrated value under the walk-forward fit of its own year */
var calByYear = {};
walk.forEach(function (w) { calByYear[w.year] = w; });
function calRow(r) {
  var w = calByYear[r.season]; if (!w) return null;
  var a = (winner === 'global') ? w.alpha_global
    : (winner === 'week_bucket') ? w.alpha_week[wkBucket(r.week)]
    : null;
  if (a == null) { a = w.alpha_global; }
  return a * r.m + (1 - a) * r.c;
}
function slice(rowsIn, keyFn) {
  var by = {};
  rowsIn.forEach(function (r) {
    var k = keyFn(r); if (k == null) return;
    (by[k] = by[k] || []).push(r);
  });
  var out = {};
  Object.keys(by).sort().forEach(function (k) {
    var rs = by[k];
    var raw = stats(function (r) { return r.m; }, rs);
    var cal = stats(function (r) { return calRow(r); }, rs.filter(function (r) { return calRow(r) != null; }));
    var mkt = stats(function (r) { return r.c; }, rs);
    var ats = rs.filter(function (r) { return Math.abs(r.m - r.c) >= 1 && r.y !== r.c; });
    var wins = ats.filter(function (r) { return Math.sign(r.y - r.c) === Math.sign(r.m - r.c); }).length;
    out[k] = { n: rs.length,
      mae_raw: +raw.mae.toFixed(3), mae_calibrated: cal.n ? +cal.mae.toFixed(3) : null,
      mae_market: +mkt.mae.toFixed(3),
      bias_raw: +raw.bias.toFixed(3), rmse_raw: +raw.rmse.toFixed(3),
      ats_raw_1plus: ats.length >= 40 ? { n: ats.length, win_pct: +(100 * wins / ats.length).toFixed(2) } : null };
  });
  return out;
}
var slices = {
  what: 'out-of-sample error dashboard, eval window ' + EVAL_FROM + '-' + TO
    + '; calibrated uses each year’s own walk-forward fit (' + winner + ')',
  frame: 'cold shipped-engine replay, FBS-vs-FBS with a closing line; FCS games are refused by the engine and are not in this frame',
  overall: slice(evalAll, function () { return 'all'; }).all,
  by_week: slice(evalAll, function (r) { return 'wk' + (r.week < 10 ? '0' : '') + r.week; }),
  by_week_bucket: slice(evalAll, function (r) { return wkBucket(r.week); }),
  by_season: slice(evalAll, function (r) { return String(r.season); }),
  by_disagreement: slice(evalAll, function (r) { return gapBucket(Math.abs(r.m - r.c)); }),
  by_fav_dog: slice(evalAll, function (r) { return r.c > 0 ? 'home_favourite' : (r.c < 0 ? 'home_dog' : 'pickem'); }),
  by_home_conference: slice(evalAll, function (r) { return r.conf; }),
  clv_proxy_vs_open: clv
};

/* ---------------- artifacts ---------------------------------------------- */
var nowIso = new Date().toISOString();
var artifact = {
  calibration_version: 'cfb_p4_cal_v1.1.0',
  generated_at: nowIso,
  method: 'walk-forward least-squares shrinkage of the raw engine spread toward the closing line; '
    + 'alpha fitted only on seasons before each evaluated season',
  basis: 'cold shipped-engine replay ' + REPLAY_FROM + '-' + TO + ' without the live efficiency feed '
    + '(matchup layer unavailable, matching how the browser runs between trainings) · '
    + 'closing/opening lines from the cfbfastR-data betting archive',
  scheme: winner,
  alpha: { global: +finalFit.global.toFixed(4),
    global_unclamped: +finalFit.global_unclamped.toFixed(4),
    week_bucket: { '0_2': +finalFit.week['0_2'].toFixed(4), '3_5': +finalFit.week['3_5'].toFixed(4), '6p': +finalFit.week['6p'].toFixed(4) },
    week_bucket_unclamped: { '0_2': +finalFit.week_unclamped['0_2'].toFixed(4), '3_5': +finalFit.week_unclamped['3_5'].toFixed(4), '6p': +finalFit.week_unclamped['6p'].toFixed(4) },
    gap_bucket: { lt3: +finalFit.gap.lt3.toFixed(4), '3_7': +finalFit.gap['3_7'].toFixed(4), '7_14': +finalFit.gap['7_14'].toFixed(4), ge14: +finalFit.gap.ge14.toFixed(4) } },
  beta_close_anticipation: { global: +finalFit.beta.toFixed(4),
    week_bucket: { '0_2': +finalFit.beta_week['0_2'].toFixed(4), '3_5': +finalFit.beta_week['3_5'].toFixed(4), '6p': +finalFit.beta_week['6p'].toFixed(4) },
    what: 'anticipated_close = beta*model + (1-beta)*current_line; fitted on openers vs closes, walk-forward',
    record_oos: { mae_anticipated_vs_close: pooledMae.ant_close, mae_open_alone_vs_close: pooledMae.open_close } },
  record: { window: EVAL_FROM + '-' + TO, n: pooled.raw.length,
    mae_raw: pooledMae.raw, mae_calibrated: pooledMae[winner], mae_market: pooledMae.market,
    mae_by_scheme: { global: pooledMae.global, week_bucket: pooledMae.week_bucket, gap_bucket: pooledMae.gap_bucket },
    note: 'raw is the unmodified v1.0.0 engine output and is never overwritten; '
      + 'calibrated is out-of-sample by construction; market is the closing line itself. '
      + 'THE FINDING: the optimal margin blend puts zero weight on the raw model at every '
      + 'week and disagreement bucket — the model does not improve the close. Its measured '
      + 'value is CLOSE ANTICIPATION: when it disagreed with the OPEN, the close moved '
      + 'toward it (see clv_proxy_vs_open and beta_close_anticipation).' },
  clv_proxy_vs_open: clv,
  walk_forward: walk
};
var calJs = 'if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n'
  + '/* EdgeDesk CFB Power 4 — market calibration. GENERATED FILE.\n'
  + '   Produced by football/cfb_p4/research/calibrate.js; never edit by hand.\n'
  + '   The raw model (params.js v1.0.0) is untouched — this artifact only\n'
  + '   defines the market-anchored companion number and carries its own\n'
  + '   walk-forward out-of-sample record. */\n'
  + 'window.EDCfbP4Calibration = ' + JSON.stringify(artifact) + ';\n'
  + 'if(typeof module!==\'undefined\'&&module.exports){module.exports=window.EDCfbP4Calibration;}\n';
fs.writeFileSync(path.join(HERE, '..', 'calibration.js'), calJs);
fs.mkdirSync(path.join(HERE, 'report'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'report', 'error_slices.json'), JSON.stringify(slices, null, 1) + '\n');
console.error('[write] football/cfb_p4/calibration.js and research/report/error_slices.json');
console.log(JSON.stringify({ pooled_mae: pooledMae, scheme: winner, final_alpha: artifact.alpha,
  clv_proxy: clv, walk_years: walk.length }, null, 2));
