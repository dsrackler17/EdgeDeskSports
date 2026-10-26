#!/usr/bin/env node
/* ===========================================================================
   THE CALIBRATION AND ACCURACY AUDIT, reproduced from committed data
   (docs/system-integrity/MODEL_INTEGRITY.md §6 is the narrative).

     node tools/model_integrity/calibration_report.js            the text report
     node tools/model_integrity/calibration_report.js --write    also writes
                                     docs/system-integrity/model_calibration_audit.json
     node tools/model_integrity/calibration_report.js --check    the committed JSON reproduces

   Read-only over the records. Nothing is fitted on a season it is then
   scored on: every model number is the one published (or replayed cold)
   before its game, and the one comparison that fits anything — a margin
   shrink and a win-probability recalibration for college football — is
   ROLLING-ORIGIN: fitted on the seasons before each test season only.

   Sources
     college football  football/cfb_ev/data/cfb_ev_calibration_rows_v1 (OOS
                       2022-2025: edgedesk_cfb_p4_v1.0.0 replayed cold at a
                       Tuesday freeze, the market never an input; FBS vs FBS);
                       record/football/cfb_2026.json (the published 2026 picks)
     NBA, NFL, NHL     performance/ledger (the last forecast before each start,
                       its result, and the last quote captured at or before it)
     walk-forward      hockey/validation/nhl_walkforward.json,
                       nba/validation/nba_walkforward.json, football/nfl_params_v2.js
                       (aggregates as each record publishes them)

   REGRESSIONS, axes stated: the margin regression is actual home margin (y)
   on projected home margin (x): a slope below 1 means projections are too
   far from zero on average. The probability recalibration is a logistic
   regression of the outcome (y, 0/1) on logit(p) (x): a slope ABOVE 1 means
   probabilities sit too close to 0.5 (compressed), below 1 too extreme. The
   market comparison regresses logit(p_model) (y) on logit(p_no-vig) (x);
   that slope is diluted by any disagreement between the two, so the
   dispersion comparison is the ratio of their standard deviations (sd_ratio).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'system-integrity', 'model_calibration_audit.json');
const BLD = require('./build.js');

const num = (x) => (x === null || x === undefined || x === '' || !isFinite(Number(x)) ? null : Number(x));
const r = (x, d) => (x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d == null ? 3 : d)) / Math.pow(10, d == null ? 3 : d));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)) : null; };
const logit = (p) => Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, p))));
const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function wilson(k, n) { if (!n) return null; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r((c - w) / d, 4), r((c + w) / d, 4)]; }
/* seeded, so every bootstrap reproduces */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/* ordinary least squares y = a + b x, with b's standard error */
function ols(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = mean(xs), my = mean(ys); let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / sxx, a = my - b * mx; let sse = 0; for (let i = 0; i < n; i++) sse += (ys[i] - a - b * xs[i]) ** 2;
  return { a: r(a, 4), b: r(b, 4), se_b: r(Math.sqrt(sse / (n - 2) / sxx), 4), n };
}
/* logistic regression y ~ a + b x by Newton-Raphson */
function logistic(xs, ys) {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < xs.length; i++) { const p = 1 / (1 + Math.exp(-(a + b * xs[i]))), w = p * (1 - p), e = ys[i] - p; g0 += e; g1 += e * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i]; }
    const det = h00 * h11 - h01 * h01; if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
function recalSlope(ps, ys, boot) {
  if (ps.length < 20) return { n: ps.length, slope: null, why: 'fewer than 20 games' };
  const xs = ps.map(logit), f = logistic(xs, ys);
  const out = { n: ps.length, intercept: r(f.a, 3), slope: r(f.b, 3), axes: 'y = outcome (0/1), x = logit(model probability); slope > 1 means compressed toward 0.5' };
  if (boot) {
    const R = rng(20261026), bs = [];
    for (let k = 0; k < boot; k++) { const ix = xs.map(() => Math.floor(R() * xs.length)); bs.push(logistic(ix.map((i) => xs[i]), ix.map((i) => ys[i])).b); }
    bs.sort((u, v) => u - v); out.slope_ci95 = [r(bs[Math.floor(0.025 * boot)], 3), r(bs[Math.floor(0.975 * boot) - 1], 3)]; out.bootstrap = boot + ' resamples, seed 20261026';
  }
  return out;
}
function probScores(ps, ys) {
  if (!ps.length) return null;
  let br = 0, ll = 0; ps.forEach((p, i) => { br += (p - ys[i]) ** 2; const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); ll += -(ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q)); });
  return { n: ps.length, brier: r(br / ps.length, 4), log_loss: r(ll / ps.length, 4), mean_p: r(mean(ps), 4), mean_y: r(mean(ys), 4) };
}
/* reliability on the FAVOURITE's probability, 5-point bins from 50% to 100%; ECE weighted by count */
function reliability(ps, ys) {
  const bins = []; for (let lo = 0.5; lo < 0.999; lo += 0.05) bins.push({ lo: r(lo, 2), hi: r(lo + 0.05, 2), p: [], y: [] });
  ps.forEach((p, i) => { const fav = p >= 0.5 ? p : 1 - p, yf = p >= 0.5 ? ys[i] : 1 - ys[i]; const b = bins[Math.min(bins.length - 1, Math.floor((fav - 0.5) / 0.05))]; b.p.push(fav); b.y.push(yf); });
  let ece = 0, n = 0;
  const rows = bins.filter((b) => b.p.length).map((b) => { const k = b.y.reduce((s, v) => s + v, 0); ece += b.p.length * Math.abs(mean(b.p) - k / b.p.length); n += b.p.length;
    const w = wilson(k, b.p.length); return { bin: Math.round(b.lo * 100) + '-' + Math.round(b.hi * 100) + '%', n: b.p.length, predicted: r(mean(b.p), 4), observed: r(k / b.p.length, 4), wilson95: w, inside: w ? mean(b.p) >= w[0] && mean(b.p) <= w[1] : null }; });
  return { bins: rows, ece: r(ece / n, 4), ece_basis: '10 equal-width bins of the favourite\'s probability (50-100%), |predicted - observed| weighted by count' };
}
const BUCKETS = [[0, 3], [3, 7], [7, 10], [10, 14], [14, 21], [21, Infinity]];
const bucketName = (b) => (b[1] === Infinity ? b[0] + '+' : (b[0] === 0 ? '0' : '>' + b[0]) + '-' + b[1]);
/* favourite performance by projected margin; rows { proj (home margin), actual, close (home margin, + = home), open, p_home } */
function byBucket(rows) {
  return BUCKETS.map((b) => {
    const g = rows.filter((x) => { const a = Math.abs(x.proj); return a > b[0] && a <= b[1] || (b[0] === 0 && a === 0); });
    if (!g.length) return { bucket: bucketName(b), n: 0 };
    const s = (x) => (x.proj >= 0 ? 1 : -1);
    const pj = g.map((x) => s(x) * x.proj), ac = g.map((x) => s(x) * x.actual), err = g.map((x, i) => ac[i] - pj[i]);
    const withClose = g.filter((x) => x.close != null), cl = withClose.map((x) => s(x) * x.close);
    const won = g.filter((x) => s(x) * x.actual > 0).length, decided = g.filter((x) => x.actual !== 0).length;
    const covC = withClose.filter((x) => s(x) * x.actual !== s(x) * x.close), covK = covC.filter((x) => s(x) * x.actual > s(x) * x.close).length;
    const pf = g.filter((x) => x.p_home != null).map((x) => (x.proj >= 0 ? x.p_home : 1 - x.p_home));
    return { bucket: bucketName(b), n: g.length, projected_mean: r(mean(pj), 2), actual_mean: r(mean(ac), 2), realized_over_projected: r(mean(ac) / mean(pj), 3),
      bias_actual_minus_projected: r(mean(err), 2), bias_se: r(sd(err) / Math.sqrt(g.length), 2),
      model_mae: r(mean(g.map((x) => Math.abs(x.actual - x.proj))), 2), close_mae: withClose.length ? r(mean(withClose.map((x) => Math.abs(x.actual - x.close))), 2) : null,
      market_close_mean: withClose.length ? r(mean(cl), 2) : null,
      favourite_won: decided ? r(won / decided, 4) : null, favourite_won_wilson95: wilson(won, decided), mean_predicted_win: pf.length ? r(mean(pf), 4) : null,
      favourite_covered_close: covC.length ? { k: covK, n: covC.length, rate: r(covK / covC.length, 4), wilson95: wilson(covK, covC.length) } : null };
  });
}
function errStats(rows) {
  const e = rows.map((x) => x.actual - x.proj);
  return { n: rows.length, mae: r(mean(e.map(Math.abs)), 3), rmse: r(Math.sqrt(mean(e.map((v) => v * v))), 3), signed_bias_actual_minus_projected: r(mean(e), 3), bias_se: rows.length > 1 ? r(sd(e) / Math.sqrt(rows.length), 3) : null };
}

/* ---------------------------------------------------------------- college football */
function cfbOos() {
  let text = '';
  try { text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'football', 'cfb_ev', 'data', 'cfb_ev_calibration_rows_v1.csv.gz'))).toString('utf8'); } catch (_) { return []; }
  const lines = text.split('\n').filter(Boolean), H = lines[0].split(',');
  const by = {};
  lines.slice(1).forEach((l) => {
    const v = l.split(','), o = {}; H.forEach((h, i) => { o[h] = v[i]; });
    if (o.window !== 'OOS' || (o.checkpoint !== 'close' && o.checkpoint !== 'open')) return;
    const g = by[o.game_id] || (by[o.game_id] = { game_id: o.game_id, season: num(o.season), kickoff: o.kickoff, prediction_ts: o.prediction_ts, proj: num(o.fair_margin), sigma: num(o.sigma), p_home: num(o.p_home_ml), actual: num(o.final_margin), home_won: num(o.y_home_win), neutral: o.neutral === '1' });
    if (o.checkpoint === 'close') g.close = -num(o.market_home_line); else g.open = -num(o.market_home_line);
  });
  return Object.values(by).filter((g) => g.proj != null && g.actual != null).sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
}
function cfb2026() {
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'cfb_2026.json'), 'utf8')); } catch (_) { return []; }
  const G = Array.isArray(j.games) ? j.games : Object.values(j.games || {});
  return G.filter((g) => g.final && num(g.final.home_score) != null && g.pick && num(g.pick.home_line) != null && Date.parse(g.pick.at) < Date.parse(g.kickoff))
    .map((g) => ({ game_id: g.game_id, season: 2026, week: g.week, proj: -num(g.pick.home_line), p_home: num(g.pick.home_win_prob), actual: num(g.final.home_score) - num(g.final.away_score),
      close: g.close && num(g.close.home_line) != null ? -num(g.close.home_line) : null, fbs: g.home_division === 'fbs' && g.away_division === 'fbs', version: g.pick.model_version }));
}
/* ROLLING ORIGIN: for each test season, fit on the seasons before it only */
function rollingOrigin(rows) {
  const seasons = [...new Set(rows.map((x) => x.season))].sort();
  const out = [];
  seasons.slice(1).forEach((t) => {
    const train = rows.filter((x) => x.season < t), test = rows.filter((x) => x.season === t);
    const m = ols(train.map((x) => x.proj), train.map((x) => x.actual));
    const tp = train.filter((x) => x.p_home != null), lf = logistic(tp.map((x) => logit(x.p_home)), tp.map((x) => x.home_won));
    const sh = test.map((x) => m.a + m.b * x.proj);
    const base = errStats(test), shr = errStats(test.map((x, i) => ({ actual: x.actual, proj: sh[i] })));
    const te = test.filter((x) => x.p_home != null), p0 = te.map((x) => x.p_home), p1 = te.map((x) => 1 / (1 + Math.exp(-(lf.a + lf.b * logit(x.p_home))))), y = te.map((x) => x.home_won);
    out.push({ test_season: t, train_seasons: [...new Set(train.map((x) => x.season))].sort(), n_test: test.length,
      margin: { fitted: { a: m.a, b: m.b }, mae_published: base.mae, mae_shrunk: shr.mae, delta: r(shr.mae - base.mae, 3) },
      win_probability: { fitted: { a: r(lf.a, 3), b: r(lf.b, 3) }, published: probScores(p0, y), recalibrated: probScores(p1, y) } });
  });
  return out;
}

/* ---------------------------------------------------------------- the ledgers (NBA, NFL, NHL; and college 2026 against its market) */
function ledgerOutcomes(sport) {
  const L = (kind) => { const dir = path.join(ROOT, 'performance', 'ledger', kind); let n = []; try { n = fs.readdirSync(dir); } catch (_) { n = []; }
    return [].concat.apply([], n.filter((f) => new RegExp('^' + sport + '-\\d{4}\\.jsonl$').test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean))); };
  const res = {}; L('results').forEach((x) => { if (x.state === 'FINAL' && num(x.home_score) != null) res[x.event_key] = x; });
  const fc = {}; L('forecasts').forEach((f) => { const t = Date.parse(f.model && f.model.predicted_at), st = Date.parse(f.start_utc); if (!(t < st)) return; if (!fc[f.event_key] || Date.parse(fc[f.event_key].model.predicted_at) < t) fc[f.event_key] = f; });
  return Object.keys(fc).filter((k) => res[k]).map((k) => { const f = fc[k], x = res[k]; return { event_key: k, version: f.model.version, p_home: num(f.forecast.p_home), proj: f.forecast.fair_home_line != null ? -num(f.forecast.fair_home_line) : null,
    total: num(f.forecast.fair_total != null ? f.forecast.fair_total : f.forecast.expected_total), actual: num(x.home_score) - num(x.away_score), actual_total: num(x.home_score) + num(x.away_score), home_won: num(x.home_score) > num(x.away_score) ? 1 : 0 }; });
}
function marketCompression(rows) {
  const g = rows.filter((x) => x.model_p_home != null && x.market_novig_home != null);
  if (g.length < 10) return { n: g.length, why: 'fewer than 10 games with both a model probability and a no-vig price captured before the forecast' };
  const f = ols(g.map((x) => logit(x.market_novig_home)), g.map((x) => logit(x.model_p_home)));
  const sm = sd(g.map((x) => logit(x.model_p_home))), sk = sd(g.map((x) => logit(x.market_novig_home)));
  return { n: g.length, regression: f, axes: 'y = logit(model p), x = logit(no-vig market p captured at or before the forecast). The slope is diluted by any disagreement between the two (it is b = r x sd_model / sd_market), so it is NOT a compression measure on its own: sd_ratio is',
    model_spread_sd_logit: r(sm, 3), market_spread_sd_logit: r(sk, 3), sd_ratio: r(sm / sk, 3), sd_ratio_basis: 'sd of logit(model p) / sd of logit(no-vig p) over the same games: below 1, the model\'s probabilities sit closer to 0.5 than the market\'s' };
}

function build() {
  const oos = cfbOos(), live = cfb2026();
  const oosP = oos.filter((x) => x.p_home != null);
  const out = { schema: 'edgedesk_model_calibration_audit_v1', generated_from: 'tools/model_integrity/calibration_report.js', note: 'Read-only over the committed records; see the file header for every axis. Nothing is fitted on a season it is scored on.' };
  out.cfb = {
    oos_2022_2025: {
      source: 'football/cfb_ev/data/cfb_ev_calibration_rows_v1 (OOS, FBS vs FBS; edgedesk_cfb_p4_v1.0.0 cold Tuesday freeze, market never an input)',
      spread: Object.assign(errStats(oos), { close: errStats(oos.filter((x) => x.close != null).map((x) => ({ actual: x.actual, proj: x.close }))), open: errStats(oos.filter((x) => x.open != null).map((x) => ({ actual: x.actual, proj: x.open }))) }),
      by_favourite_size: byBucket(oos),
      by_season: [...new Set(oos.map((x) => x.season))].sort().map((s) => { const g = oos.filter((x) => x.season === s); return Object.assign({ season: s }, errStats(g), { margin_regression: ols(g.map((x) => x.proj), g.map((x) => x.actual)) }); }),
      home_away: { favourite_at_home: errStats(oos.filter((x) => !x.neutral && x.proj > 0)), favourite_away: errStats(oos.filter((x) => !x.neutral && x.proj < 0)), neutral: errStats(oos.filter((x) => x.neutral)) },
      margin_regression: Object.assign(ols(oos.map((x) => x.proj), oos.map((x) => x.actual)), { axes: 'y = actual home margin, x = projected home margin; slope < 1 means projections too far from zero' }),
      win_probability: Object.assign({}, probScores(oosP.map((x) => x.p_home), oosP.map((x) => x.home_won)), { recalibration: recalSlope(oosP.map((x) => x.p_home), oosP.map((x) => x.home_won), 400), reliability: reliability(oosP.map((x) => x.p_home), oosP.map((x) => x.home_won)),
        favourites: probScores(oosP.map((x) => Math.max(x.p_home, 1 - x.p_home)), oosP.map((x) => (x.p_home >= 0.5 ? x.home_won : 1 - x.home_won))),
        underdogs: probScores(oosP.map((x) => Math.min(x.p_home, 1 - x.p_home)), oosP.map((x) => (x.p_home < 0.5 ? x.home_won : 1 - x.home_won))) }),
      market: (() => {
        const g = oos.filter((x) => x.open != null && x.close != null);
        const mv = g.map((x) => x.close - x.open), dis = g.map((x) => x.proj - x.open);
        const toward = g.filter((x, i) => dis[i] !== 0 && mv[i] !== 0 && Math.sign(mv[i]) === Math.sign(dis[i])).length, moved = g.filter((x, i) => dis[i] !== 0 && mv[i] !== 0).length;
        const res = g.map((x) => x.actual - x.open);
        return { n: g.length, close_moved_toward_model: { k: toward, n: moved, rate: r(toward / moved, 4), wilson95: wilson(toward, moved), basis: 'games where the model differed from the opener and the line moved' },
          movement_on_disagreement: Object.assign(ols(dis, mv), { axes: 'y = close - open (home margin), x = model - open' }),
          result_on_disagreement: Object.assign(ols(dis, res), { axes: 'y = actual - open, x = model - open; slope near 0 means the disagreement carried no information past the opener' }),
          clv_model_side_points: r(mean(g.filter((x, i) => dis[i] !== 0).map((x) => Math.sign(x.proj - x.open) * (x.close - x.open))), 3) };
      })(),
      rolling_origin: rollingOrigin(oos)
    },
    live_2026: {
      source: 'record/football/cfb_2026.json (the published pick, frozen before kickoff)',
      all: errStats(live), fbs_vs_fbs: Object.assign(errStats(live.filter((x) => x.fbs)), { by_favourite_size: byBucket(live.filter((x) => x.fbs)) }),
      fbs_vs_fcs: Object.assign(errStats(live.filter((x) => !x.fbs)), { by_favourite_size: byBucket(live.filter((x) => !x.fbs)) }),
      win_probability_fbs: (() => { const g = live.filter((x) => x.fbs && x.p_home != null); return Object.assign({}, probScores(g.map((x) => x.p_home), g.map((x) => (x.actual > 0 ? 1 : 0))), { reliability: reliability(g.map((x) => x.p_home), g.map((x) => (x.actual > 0 ? 1 : 0))), recalibration: recalSlope(g.map((x) => x.p_home), g.map((x) => (x.actual > 0 ? 1 : 0)), 400) }); })(),
      by_version: [...new Set(live.map((x) => x.version))].map((v) => Object.assign({ version: v }, errStats(live.filter((x) => x.version === v))))
    }
  };
  ['nba', 'nfl', 'nhl'].forEach((s) => {
    const g = ledgerOutcomes(s), gp = g.filter((x) => x.p_home != null), gs = g.filter((x) => x.proj != null), gt = g.filter((x) => x.total != null);
    const mk = BLD.ledgerRows(ROOT, s);
    out[s] = { source: 'performance/ledger (last forecast before the start)', graded: g.length,
      moneyline: Object.assign({}, probScores(gp.map((x) => x.p_home), gp.map((x) => x.home_won)), { recalibration: recalSlope(gp.map((x) => x.p_home), gp.map((x) => x.home_won), 400), reliability: reliability(gp.map((x) => x.p_home), gp.map((x) => x.home_won)) }),
      spread: s === 'nhl' ? null : Object.assign(errStats(gs), { by_favourite_size: byBucket(gs) }),
      total: gt.length ? { n: gt.length, mae: r(mean(gt.map((x) => Math.abs(x.actual_total - x.total))), 3), signed_bias_actual_minus_projected: r(mean(gt.map((x) => x.actual_total - x.total)), 3) } : null,
      against_the_market: Object.assign({ n_matched: mk.length }, marketCompression(mk),
        mk.filter((x) => x.market_home_line != null && x.model_home_line != null).length ? { spread: { model_mae: r(mean(mk.filter((x) => x.market_home_line != null && x.model_home_line != null).map((x) => Math.abs(x.final_margin + x.model_home_line))), 3), market_mae: r(mean(mk.filter((x) => x.market_home_line != null && x.model_home_line != null).map((x) => Math.abs(x.final_margin + x.market_home_line))), 3) } } : {}) };
  });
  try {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_walkforward.json'), 'utf8'));
    out.nhl.walk_forward = { source: 'hockey/validation/nhl_walkforward.json', generated_at: w.generated_at, moneyline: w.markets && w.markets.moneyline ? { n: w.markets.moneyline.n, calibration_slope: w.markets.moneyline.calibration_slope, calibration_in_the_large: w.markets.moneyline.calibration_in_the_large, log_loss: w.markets.moneyline.log_loss } : null,
      chosen: w.selection ? w.selection.chosen : null,
      by_season_slope: Object.keys(w.by_season || {}).sort().map((y) => { const m = (w.by_season[y] || {})[w.selection && w.selection.chosen] || {}; const ml = m.moneyline || {}; return { season: Number(y), n: ml.n || null, slope: ml.calibration_slope != null ? ml.calibration_slope : null, mean_p: ml.mean_p, mean_y: ml.mean_y }; }) };
  } catch (_) { /* absent */ }
  try {
    const n = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'validation', 'nba_walkforward.json'), 'utf8'));
    const ch = n.choice && n.choice.P ? n.choice.P.chosen : null, sel = n.windows && n.windows.selection && ch ? n.windows.selection[ch] : null;
    out.nba.walk_forward = { source: 'nba/validation/nba_walkforward.json (selection window)', chosen: ch, n: sel ? sel.n : null, moneyline: sel ? { calibration_slope: sel.moneyline.calibration_slope, log_loss: sel.moneyline.log_loss, brier: sel.moneyline.brier } : null };
  } catch (_) { /* absent */ }
  return out;
}

function text(o) {
  const L = [], c = o.cfb.oos_2022_2025;
  L.push('COLLEGE FOOTBALL, out of sample 2022-2025 (n ' + c.spread.n + ')');
  L.push('  margin MAE model ' + c.spread.mae + ' | opener ' + c.spread.open.mae + ' | close ' + c.spread.close.mae + '; regression slope ' + c.margin_regression.b + ' (se ' + c.margin_regression.se_b + ')');
  c.by_favourite_size.forEach((b) => L.push('  ' + b.bucket.padEnd(7) + ' n ' + String(b.n).padStart(4) + '  projected ' + b.projected_mean + '  actual ' + b.actual_mean + '  ratio ' + b.realized_over_projected + '  bias ' + b.bias_actual_minus_projected + ' (se ' + b.bias_se + ')  MAE ' + b.model_mae + ' vs close ' + b.close_mae + '  fav won ' + b.favourite_won + ' vs ' + b.mean_predicted_win + (b.favourite_covered_close ? '  covered close ' + b.favourite_covered_close.rate : '')));
  L.push('  win probability: brier ' + c.win_probability.brier + ', recal slope ' + c.win_probability.recalibration.slope + ' ' + JSON.stringify(c.win_probability.recalibration.slope_ci95) + ', ECE ' + c.win_probability.reliability.ece);
  c.win_probability.reliability.bins.forEach((b) => L.push('    ' + b.bin.padEnd(8) + ' n ' + String(b.n).padStart(4) + ' predicted ' + b.predicted + ' observed ' + b.observed + ' ' + JSON.stringify(b.wilson95) + (b.inside ? '' : '  OUTSIDE')));
  L.push('  market: close moved toward the model ' + c.market.close_moved_toward_model.rate + ' ' + JSON.stringify(c.market.close_moved_toward_model.wilson95) + '; result on disagreement slope ' + c.market.result_on_disagreement.b + ' (se ' + c.market.result_on_disagreement.se_b + ')');
  c.rolling_origin.forEach((x) => L.push('  rolling origin ' + x.test_season + ' (fit ' + x.train_seasons.join(',') + '): margin shrink b ' + x.margin.fitted.b + ' MAE ' + x.margin.mae_published + ' -> ' + x.margin.mae_shrunk + '; win prob log loss ' + x.win_probability.published.log_loss + ' -> ' + x.win_probability.recalibrated.log_loss));
  const lv = o.cfb.live_2026;
  L.push('COLLEGE FOOTBALL 2026 live: FBS-vs-FBS n ' + lv.fbs_vs_fbs.n + ' MAE ' + lv.fbs_vs_fbs.mae + ' bias ' + lv.fbs_vs_fbs.signed_bias_actual_minus_projected + '; FBS-vs-FCS n ' + lv.fbs_vs_fcs.n + ' bias ' + lv.fbs_vs_fcs.signed_bias_actual_minus_projected);
  lv.fbs_vs_fbs.by_favourite_size.forEach((b) => L.push('  ' + b.bucket.padEnd(7) + ' n ' + String(b.n).padStart(3) + '  bias ' + b.bias_actual_minus_projected + ' (se ' + b.bias_se + ')  fav won ' + b.favourite_won + ' vs ' + b.mean_predicted_win));
  ['nba', 'nfl', 'nhl'].forEach((s) => { const x = o[s]; L.push(s.toUpperCase() + ' live: graded ' + x.graded + '; moneyline brier ' + x.moneyline.brier + ' slope ' + x.moneyline.recalibration.slope + ' ' + JSON.stringify(x.moneyline.recalibration.slope_ci95 || null) + '; vs market n ' + x.against_the_market.n_matched + ' ' + JSON.stringify(x.against_the_market.regression || x.against_the_market.why)); });
  return L.join('\n');
}

if (require.main === module) {
  const o = build();
  console.log(text(o));
  const json = JSON.stringify(o, null, 1) + '\n';
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, json); console.log('wrote ' + path.relative(ROOT, OUT)); }
  if (process.argv.includes('--check')) { const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''; const same = cur === json; console.log(same ? 'CHECK: the committed audit reproduces' : 'CHECK: the committed audit differs (the records moved; rerun with --write)'); process.exit(same ? 0 : 1); }
}
module.exports = { build, recalSlope, reliability, byBucket, ols, logistic };
