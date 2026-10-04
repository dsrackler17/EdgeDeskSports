#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the CALIBRATION TOURNAMENT (docs/edgedesk-ev/PREREG.md).

   Probability calibration is the EV engine's most important dependency, and
   calibration is a model-selection problem, not a checkbox (pack K17). Every
   candidate — identity included — competes strictly out of sample, walk-
   forward by season, on the champion's raw probabilities computed through the
   production path (football/cfb_ev/dataset.js). Simple wins ties. The 2026
   published record is an untouched holdout, read once.

     node football/cfb_ev/tournament.js                 # DEV (walk-forward) only, writes the artifacts
     node football/cfb_ev/tournament.js --check         # DEV only, writes nothing
     node football/cfb_ev/tournament.js --read-holdout  # DEV, then the one-time holdout read

   Writes football/cfb_ev/artifacts/cfb_ev_calibration_v1/
     calibration.json      the runtime artifact lib/edgedesk_ev.js reads
     tournament.json       every number behind it
     MANIFEST.json         hashes of the dataset, the code and the artifacts
     holdout_access.jsonl  append-only: the one holdout read
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const C = require('./calibrators.js');
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
const DS = require('./dataset.js');
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));

const VERSION = 'cfb_ev_calibration_v1';
const BASE_MODEL = 'edgedesk_cfb_p4_v1.0.0';
const OUTDIR = path.join(__dirname, 'artifacts', VERSION);
const DATA = path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.csv.gz');
const SEED = 20260928, B_BOOT = 2000, B_UNC = 200;
const FOLDS = [2023, 2024, 2025], FIRST_OOS = 2022;
const flag = (n) => process.argv.indexOf('--' + n) > 0;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const r = (x, k) => x == null || !isFinite(x) ? null : +x.toFixed(k == null ? 6 : k);

/* ------------------------------------------------------------------ data */
function readCsv(buf) {
  const text = zlib.gunzipSync(buf).toString('utf8'), rows = [];
  const lines = text.split('\n').filter(Boolean), head = splitLine(lines[0]);
  for (let i = 1; i < lines.length; i++) { const c = splitLine(lines[i]), o = {}; head.forEach((h, j) => { o[h] = c[j]; }); rows.push(o); }
  return rows;
}
function splitLine(l) {
  const out = []; let cell = '', q = false;
  for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cell); cell = ''; } else cell += ch; }
  out.push(cell); return out;
}
const N = (x) => x === '' || x == null ? null : Number(x);

const TASKS = [
  { key: 'cfb|spread|close', checkpoint: 'close', p: 'p_cover', y: 'y_cover', label: 'CFB spread at the close' },
  { key: 'cfb|spread|open', checkpoint: 'open', p: 'p_cover', y: 'y_cover', label: 'CFB spread at the opener' },
  { key: 'cfb|moneyline|close', checkpoint: 'close', p: 'p_home_ml', y: 'y_home_win', label: 'CFB moneyline (home win), pregame' }
];

/* ------------------------------------------------------------- bootstrap */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function clusterBoot(diffs, clusters, B, seed) {
  /* the mean of a per-row difference, resampling whole weeks (correlated weekly errors, pack E33) */
  const byC = new Map();
  diffs.forEach((d, i) => { const k = clusters[i]; if (!byC.has(k)) byC.set(k, []); byC.get(k).push(d); });
  const keys = [...byC.keys()], sums = keys.map((k) => byC.get(k).reduce((s, v) => s + v, 0)), ns = keys.map((k) => byC.get(k).length);
  const rand = rng(seed), out = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < keys.length; i++) { const j = Math.floor(rand() * keys.length); s += sums[j]; n += ns[j]; } out.push(s / n); }
  out.sort((a, b) => a - b);
  const m = diffs.reduce((s, v) => s + v, 0) / diffs.length, mu = out.reduce((s, v) => s + v, 0) / B;
  const sd = Math.sqrt(out.reduce((s, v) => s + (v - mu) * (v - mu), 0) / (B - 1));
  return { mean: m, ci95: [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]], sd: sd, clusters: keys.length };
}
function lossRow(p, y) { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }

/* ------------------------------------------------------------- one market */
function fitMethod(method, train) {
  if (method === 'rolling_platt') {
    const last = Math.max.apply(null, train.map((x) => x.season));
    const t = train.filter((x) => x.season === last);
    const f = C.fitPlatt(t.map((x) => x.p), t.map((x) => x.y));
    return Object.assign(f, { method: 'rolling_platt', window: String(last) });
  }
  return C.FITS[method](train.map((x) => x.p), train.map((x) => x.y));
}
function stability(rows, preds) {
  const groups = {
    week: (x) => x.week <= 3 ? 'weeks 1-3' : (x.week <= 8 ? 'weeks 4-8' : 'weeks 9+'),
    gap: (x) => { const g = Math.abs(x.gap); return g < 2 ? '|gap| < 2' : (g < 5 ? '2-5' : (g < 10 ? '5-10' : '10+')); },
    favorite_flip: (x) => x.flip ? 'favorite flip' : 'same favorite',
    home_role: (x) => x.line < 0 ? 'home favorite' : (x.line > 0 ? 'home underdog' : "pick'em"),
    season: (x) => String(x.season)
  };
  const out = {};
  Object.keys(groups).forEach((g) => {
    const by = {};
    rows.forEach((x, i) => { const k = groups[g](x); (by[k] = by[k] || []).push(i); });
    out[g] = Object.keys(by).sort().map((k) => {
      const ii = by[k], p = ii.map((i) => preds[i]), y = ii.map((i) => rows[i].y);
      const res = { group: k, n: ii.length, brier: r(C.brier(p, y), 5), log_loss: r(C.logloss(p, y), 5), mean_p: r(p.reduce((s, v) => s + v, 0) / p.length, 4), observed: r(y.reduce((s, v) => s + v, 0) / y.length, 4) };
      if (ii.length >= 150) { const si = C.slopeIntercept(p, y); res.slope = si.slope; res.slope_ci95 = si.slope_ci95; }
      else res.note = 'n < 150: slope not reported (small-group caution)';
      return res;
    });
  });
  return out;
}
function tournament(task, all) {
  const pick = (x) => ({ season: N(x.season), week: N(x.week), p: N(x[task.p]), y: N(x[task.y]), gap: N(x.gap_pts), flip: x.favorite_flip === '1', line: N(x.market_home_line),
    fair: N(x.fair_margin), game_id: x.game_id, window: x.window, cluster: x.season + '-' + x.week });
  const base = all.filter((x) => x.checkpoint === task.checkpoint).map(pick).filter((x) => x.p != null && (x.y === 0 || x.y === 1));
  const oos = base.filter((x) => x.window === 'OOS');
  const methods = C.ORDER;
  /* walk-forward: fit on the OOS seasons before, evaluate the season */
  const oofRows = [], oofPred = {}; methods.forEach((m) => { oofPred[m] = []; });
  const perSeason = {}, fits = {};
  FOLDS.forEach((s) => {
    const train = oos.filter((x) => x.season >= FIRST_OOS && x.season < s), test = oos.filter((x) => x.season === s);
    if (!train.length || !test.length) return;
    fits[s] = {};
    methods.forEach((m) => {
      const map = fitMethod(m, train);
      fits[s][m] = summarizeMap(map, train.length);
      test.forEach((x) => oofPred[m].push(C.apply(map, x.p)));
    });
    test.forEach((x) => oofRows.push(x));
  });
  const y = oofRows.map((x) => x.y);
  const results = {};
  methods.forEach((m) => {
    const p = oofPred[m], met = C.metrics(p, y);
    const seasons = FOLDS.map((s) => { const ii = oofRows.map((x, i) => x.season === s ? i : -1).filter((i) => i >= 0); const pp = ii.map((i) => p[i]), yy = ii.map((i) => y[i]);
      return { season: s, n: ii.length, brier: r(C.brier(pp, yy), 5), log_loss: r(C.logloss(pp, yy), 5) }; });
    results[m] = { method: m, params: C.PARAMS[m], pooled: met, by_season: seasons };
  });
  /* the bootstrap against identity, week-clustered, paired on the same rows */
  const clusters = oofRows.map((x) => x.cluster);
  const idLoss = oofRows.map((x, i) => lossRow(oofPred.identity[i], x.y)), idSq = oofRows.map((x, i) => Math.pow(oofPred.identity[i] - x.y, 2));
  methods.forEach((m, mi) => {
    if (m === 'identity') return;
    const dl = oofRows.map((x, i) => lossRow(oofPred[m][i], x.y) - idLoss[i]), db = oofRows.map((x, i) => Math.pow(oofPred[m][i] - x.y, 2) - idSq[i]);
    const bl = clusterBoot(dl, clusters, B_BOOT, SEED + mi), bb = clusterBoot(db, clusters, B_BOOT, SEED + 100 + mi);
    const seasonsNoWorse = results[m].by_season.filter((s, j) => s.log_loss <= results.identity.by_season[j].log_loss + 1e-12).length;
    results[m].vs_identity = { delta_log_loss: r(bl.mean, 6), delta_log_loss_ci95: [r(bl.ci95[0], 6), r(bl.ci95[1], 6)], delta_log_loss_sd: r(bl.sd, 6),
      delta_brier: r(bb.mean, 6), delta_brier_ci95: [r(bb.ci95[0], 6), r(bb.ci95[1], 6)], seasons_no_worse: seasonsNoWorse + '/' + FOLDS.length, clusters: bl.clusters };
    results[m].eligible = results[m].pooled.log_loss < results.identity.pooled.log_loss && results[m].pooled.brier < results.identity.pooled.brier
      && bl.ci95[1] < 0 && seasonsNoWorse >= 2;
    results[m].eligibility = [results[m].pooled.log_loss < results.identity.pooled.log_loss ? 'log loss below identity' : 'log loss NOT below identity',
      results[m].pooled.brier < results.identity.pooled.brier ? 'Brier below identity' : 'Brier NOT below identity',
      bl.ci95[1] < 0 ? 'Δ log loss 95% CI below 0' : 'Δ log loss 95% CI reaches 0', seasonsNoWorse >= 2 ? seasonsNoWorse + '/3 seasons no worse' : 'only ' + seasonsNoWorse + '/3 seasons no worse'];
  });
  /* the promotion rule (PREREG §5) */
  const eligible = methods.filter((m) => m !== 'identity' && results[m].eligible);
  let chosen = 'identity', status, why;
  if (eligible.length) {
    const best = eligible.slice().sort((a, b) => results[a].pooled.log_loss - results[b].pooled.log_loss)[0];
    /* simple wins ties: the simplest eligible method within one bootstrap SD of the best */
    const bestIdx = methods.indexOf(best);
    const dBest = oofRows.map((x, i) => lossRow(oofPred[best][i], x.y));
    chosen = best;
    for (const m of methods) {
      if (m === 'identity' || !results[m].eligible || methods.indexOf(m) >= bestIdx) continue;
      const d = oofRows.map((x, i) => lossRow(oofPred[m][i], x.y) - dBest[i]);
      const bt = clusterBoot(d, clusters, B_BOOT, SEED + 500 + methods.indexOf(m));
      if (bt.mean <= bt.sd) { chosen = m; results[m].tie_with_best = { best: best, delta_log_loss: r(bt.mean, 6), sd: r(bt.sd, 6) }; break; }
    }
    status = 'PROMOTED';
    why = chosen + ' beat identity out of sample (' + results[chosen].eligibility.join('; ') + ')' + (chosen !== best ? '; ' + best + ' scored lower but ' + chosen + ' is simpler and within one bootstrap SD' : '');
  } else {
    const id = results.identity.pooled;
    const slopeOk = id.slope_ci95 && id.slope_ci95[0] <= 1 && id.slope_ci95[1] >= 1, citlOk = id.citl_ci95 && id.citl_ci95[0] <= 0 && id.citl_ci95[1] >= 0;
    status = slopeOk && citlOk ? 'IDENTITY_VALIDATED' : 'NOT_VALIDATED';
    why = 'no candidate beat identity by the pre-registered rule; identity ' + (status === 'IDENTITY_VALIDATED' ? 'is itself calibrated out of sample (slope CI ' + JSON.stringify(id.slope_ci95) + ' contains 1, CITL CI ' + JSON.stringify(id.citl_ci95) + ' contains 0)'
      : 'is NOT calibrated out of sample (slope ' + id.slope + ' CI ' + JSON.stringify(id.slope_ci95) + ', CITL ' + id.citl + ' CI ' + JSON.stringify(id.citl_ci95) + ')');
  }
  /* the final map: the chosen method refitted on every OOS season */
  const finalMap = chosen === 'identity' ? { method: 'identity' } : fitMethod(chosen, oos);
  const ps = oos.map((x) => x.p).sort((a, b) => a - b), q = (v) => ps[Math.min(ps.length - 1, Math.max(0, Math.floor(v * ps.length)))];
  const domain = { p_min: r(ps[0], 4), p01: r(q(0.01), 4), p05: r(q(0.05), 4), p95: r(q(0.95), 4), p99: r(q(0.99), 4), p_max: r(ps[ps.length - 1], 4), n: ps.length };
  /* the uncertainty layer: Platt refits on week-clustered bootstrap resamples of all OOS rows */
  const center = C.fitPlatt(oos.map((x) => x.p), oos.map((x) => x.y));
  const byWeek = new Map(); oos.forEach((x) => { if (!byWeek.has(x.cluster)) byWeek.set(x.cluster, []); byWeek.get(x.cluster).push(x); });
  const wk = [...byWeek.keys()], rand = rng(SEED + 900), draws = [];
  for (let b = 0; b < B_UNC; b++) {
    const smp = []; for (let i = 0; i < wk.length; i++) byWeek.get(wk[Math.floor(rand() * wk.length)]).forEach((x) => smp.push(x));
    const f = C.fitPlatt(smp.map((x) => x.p), smp.map((x) => x.y)); draws.push([r(f.a, 5), r(f.b, 5)]);
  }
  /* in-sample diagnostic (never a fit) */
  const ins = base.filter((x) => x.window === 'IN_SAMPLE');
  const inSample = ins.length ? C.metrics(ins.map((x) => x.p), ins.map((x) => x.y)) : null;
  if (inSample) delete inSample.reliability_curve;
  return {
    key: task.key, label: task.label, n_oos: oos.length, n_oof: oofRows.length, folds: FOLDS.map((s) => ({ train: FIRST_OOS + '-' + (s - 1), evaluate: s })),
    fits_by_fold: fits, results: results, eligible: eligible, chosen: chosen, status: status, why: why,
    final_map: finalMap, final_training_window: FIRST_OOS + '-' + Math.max.apply(null, oos.map((x) => x.season)), domain: domain,
    uncertainty: { method: 'platt_bootstrap_deviation', platt_center: [r(center.a, 5), r(center.b, 5)], platt_draws: draws, B: B_UNC, clusters: wk.length, seed: SEED + 900 },
    benchmark: task.p === 'p_cover' ? { coin_flip: { brier: 0.25, log_loss: +Math.log(2).toFixed(6), note: 'the de-vigged close at symmetric juice is 0.5 for both sides: the market benchmark for a cover probability at the market line' } } : null,
    in_sample_identity: inSample ? Object.assign({ window: '2015-2021 (IN SAMPLE for the champion — diagnostic only)' }, inSample) : null,
    _oof: { rows: oofRows, preds: oofPred }, _oos: oos
  };
}
function summarizeMap(m, n) {
  const o = { method: m.method, n_train: n };
  ['a', 'b', 'c', 'T'].forEach((k) => { if (m[k] != null) o[k] = r(m[k], 5); });
  if (m.blocks) o.blocks = m.blocks;
  if (m.window) o.window = m.window;
  return o;
}

/* ------------------------------------------------ spread-only audits (§6) */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function audits(all) {
  const close = all.filter((x) => x.window === 'OOS' && x.checkpoint === 'close');
  /* push calibration at integer lines */
  const ints = close.filter((x) => Math.abs(N(x.market_home_line) - Math.round(N(x.market_home_line))) < 1e-9);
  const pushBy = (f) => { const s = ints.filter(f); return { n: s.length, predicted: r(s.reduce((a, x) => a + N(x.p_push), 0) / (s.length || 1), 4), observed: r(s.reduce((a, x) => a + N(x.y_push), 0) / (s.length || 1), 4), wilson95: C.wilson(s.reduce((a, x) => a + N(x.y_push), 0), s.length) }; };
  const push = { all_integer_lines: pushBy(() => true), line_3: pushBy((x) => Math.abs(N(x.market_home_line)) === 3), line_7: pushBy((x) => Math.abs(N(x.market_home_line)) === 7),
    line_10: pushBy((x) => Math.abs(N(x.market_home_line)) === 10), other_integers: pushBy((x) => [3, 7, 10].indexOf(Math.abs(N(x.market_home_line))) < 0) };
  /* PMF vs a continuous-normal shortcut: three-state log loss at integer lines, cover log loss at half points */
  let llPmf = 0, llNorm = 0, n3 = 0, pushPmf = 0, pushNorm = 0;
  ints.forEach((x) => {
    const L = N(x.market_home_line), f = N(x.fair_margin), s = N(x.sigma), t = -L;
    const pP = N(x.p_push), pW = N(x.p_win), pL = N(x.p_loss);
    const nP = Phi((t + 0.5 - f) / s) - Phi((t - 0.5 - f) / s), nW = 1 - Phi((t + 0.5 - f) / s), nL = Phi((t - 0.5 - f) / s);
    const o = N(x.y_push) === 1 ? 'P' : (N(x.y_cover) === 1 ? 'W' : 'L');
    const g = (a) => Math.log(Math.max(1e-6, a));
    llPmf -= o === 'P' ? g(pP) : (o === 'W' ? g(pW) : g(pL)); llNorm -= o === 'P' ? g(nP) : (o === 'W' ? g(nW) : g(nL));
    pushPmf -= N(x.y_push) === 1 ? g(pP) : g(1 - pP); pushNorm -= N(x.y_push) === 1 ? g(nP) : g(1 - nP);
    n3++;
  });
  const halves = close.filter((x) => Math.abs(N(x.market_home_line) - Math.round(N(x.market_home_line))) > 1e-9 && (N(x.y_cover) === 0 || N(x.y_cover) === 1));
  let cPmf = 0, cNorm = 0;
  halves.forEach((x) => { const y = N(x.y_cover), p = N(x.p_cover), q = 1 - Phi((-N(x.market_home_line) - N(x.fair_margin)) / N(x.sigma)); cPmf += lossRow(p, y); cNorm += lossRow(q, y); });
  const dist = { integer_lines: { n: n3, three_state_log_loss_pmf: r(llPmf / n3, 5), three_state_log_loss_normal: r(llNorm / n3, 5), push_log_loss_pmf: r(pushPmf / n3, 5), push_log_loss_normal: r(pushNorm / n3, 5) },
    half_point_lines: { n: halves.length, cover_log_loss_pmf: r(cPmf / halves.length, 5), cover_log_loss_normal: r(cNorm / halves.length, 5) },
    verdict: null };
  dist.verdict = dist.integer_lines.push_log_loss_pmf < dist.integer_lines.push_log_loss_normal
    ? 'At integer market lines the production PMF predicts pushes better than a continuous-normal shortcut (push log loss ' + dist.integer_lines.push_log_loss_pmf + ' vs ' + dist.integer_lines.push_log_loss_normal + ').'
    : 'At integer MARKET lines the production curve (the empirical PMF re-centred on EdgeDesk’s fair margin) predicts pushes WORSE than a continuous-normal shortcut (push log loss ' + dist.integer_lines.push_log_loss_pmf + ' vs ' + dist.integer_lines.push_log_loss_normal + '): its key-number mass does not sit where the market’s numbers are. Neither is adequate there; see the anchored audit.';
  /* key numbers: empirical |margin| frequency vs the PMF's mean predicted mass (the curve at each integer) */
  const ks = [1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21], acc = {}; ks.forEach((k) => { acc[k] = { pred: 0, obs: 0 }; });
  close.forEach((x) => {
    const cv = DS.curveFor(N(x.fair_margin), N(x.sigma), N(x.cond_margin)).curve;
    ks.forEach((k) => { acc[k].pred += (RD.massAt(cv, 'home', k) || 0) + (RD.massAt(cv, 'home', -k) || 0); acc[k].obs += Math.abs(N(x.final_margin)) === k ? 1 : 0; });
  });
  const key = ks.map((k) => ({ abs_margin: k, empirical: r(acc[k].obs / close.length, 4), wilson95: C.wilson(acc[k].obs, close.length), pmf_mean_mass: r(acc[k].pred / close.length, 4) }));
  /* extremes and model-location reference (stored for the runtime) */
  const pe = close.map((x) => Math.abs(N(x.p_cover) - 0.5)).sort((a, b) => a - b), gp = close.map((x) => Math.abs(N(x.gap_pts))).sort((a, b) => a - b);
  const qq = (a, v) => a[Math.min(a.length - 1, Math.floor(v * a.length))];
  const extremes = { prob_p95: r(qq(pe, 0.95), 4), prob_p99: r(qq(pe, 0.99), 4), gap_p95: r(qq(gp, 0.95), 2), gap_p99: r(qq(gp, 0.99), 2), n: close.length,
    basis: '|raw cover − 0.5| and |model − market| at the close, 2022-2025 OOS FBS games (football/cfb_ev/dataset.js)' };
  const sds = close.filter((x) => x.v2_ens !== '' && x.v2_ens != null).map((x) => Math.abs(N(x.fair_margin) - N(x.v2_ens)) / Math.SQRT2).sort((a, b) => a - b);
  const location = { sd_ref: r(qq(sds, 0.5), 3), n: sds.length, basis: 'median between-model SD of {V1 fair, V2 walk-forward ensemble} on 2022-2025 OOS games: disagreement at or below this is already absorbed by the calibrated distribution; only the excess is sampled' };
  return { push: push, distribution: dist, key_numbers: key, extremes: extremes, location: location };
}

/* alternate-line transport check: the map fitted on the training folds is
   evaluated AT the close (the anchor) and carried to close ± 3 / ± 7 by the
   same frozen distribution (lib/edgedesk_ev.js anchorOf → solveShift →
   shiftedHome) — exactly the runtime path for an alternate line */
function altDomain(all, t) {
  const byGame = new Map();
  all.filter((x) => x.window === 'OOS' && /^close/.test(x.checkpoint)).forEach((x) => { if (!byGame.has(x.game_id)) byGame.set(x.game_id, {}); byGame.get(x.game_id)[x.checkpoint] = x; });
  const maps = {};
  FOLDS.forEach((s) => { maps[s] = t.chosen === 'identity' ? { method: 'identity' } : fitMethod(t.chosen, t._oos.filter((x) => x.season < s)); });
  const acc = {};
  ['close_m7', 'close_m3', 'close_p3', 'close_p7'].forEach((cp) => { acc[cp] = { pi: [], pc: [], y: [] }; });
  byGame.forEach((g) => {
    const c = g.close; if (!c) return;
    const s = N(c.season); if (!maps[s]) return;
    const curve = DS.curveFor(N(c.fair_margin), N(c.sigma), N(c.cond_margin)).curve;
    const H = N(c.market_home_line), p0 = RD.sideProb(curve, 'home', H);
    if (!p0) return;
    const q = Math.min(1 - 1e-4, Math.max(1e-4, EV.applyCalibrator(maps[s], p0.cover)));
    const d = Math.abs(q - p0.cover) < 1e-12 ? 0 : EV.solveShift(curve, H, q);
    if (d == null) return;
    Object.keys(acc).forEach((cp) => {
      const x = g[cp]; if (!x) return;
      const y = N(x.y_cover); if (!(y === 0 || y === 1)) return;
      const sh = EV.shiftedHome(curve, N(x.market_home_line), d);
      if (!sh || sh.cover == null) return;
      acc[cp].pi.push(N(x.p_cover)); acc[cp].pc.push(Math.min(1 - 1e-6, Math.max(1e-6, sh.cover))); acc[cp].y.push(y);
    });
  });
  return Object.keys(acc).map((cp) => {
    const a = acc[cp], mi = C.metrics(a.pi, a.y), mc = C.metrics(a.pc, a.y);
    return { checkpoint: cp, n: a.y.length, identity: { brier: mi.brier, log_loss: mi.log_loss, slope: mi.slope, citl: mi.citl }, anchored: { method: t.chosen, brier: mc.brier, log_loss: mc.log_loss, slope: mc.slope, citl: mc.citl },
      mean_raw_p: mi.mean_p, mean_anchored_p: mc.mean_p, observed: mi.base_rate,
      note: 'the calibrator evaluated at the close and carried to this line by the frozen distribution (the runtime path for an alternate)' };
  });
}


/* the same push and key-number audits for the ANCHORED distribution (the
   calibrated runtime path): each fold's map at the close, carried by the
   frozen distribution. Is the calibrated distribution's push mass honest? */
function anchoredAudit(all, t) {
  const rows = all.filter((x) => x.window === 'OOS' && x.checkpoint === 'close' && FOLDS.indexOf(N(x.season)) >= 0);
  const maps = {};
  FOLDS.forEach((s) => { maps[s] = t.chosen === 'identity' ? { method: 'identity' } : fitMethod(t.chosen, t._oos.filter((x) => x.season < s)); });
  const ks = [1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21], acc = {}; ks.forEach((k) => { acc[k] = { raw: 0, anc: 0, obs: 0 }; });
  const push = { all: { n: 0, raw: 0, anc: 0, obs: 0 }, k3: { n: 0, raw: 0, anc: 0, obs: 0 }, k7: { n: 0, raw: 0, anc: 0, obs: 0 }, k10: { n: 0, raw: 0, anc: 0, obs: 0 }, other: { n: 0, raw: 0, anc: 0, obs: 0 } };
  let llRaw = 0, llAnc = 0, n3 = 0, n = 0;
  const g = (a) => Math.log(Math.max(1e-6, a));
  rows.forEach((x) => {
    const curve = DS.curveFor(N(x.fair_margin), N(x.sigma), N(x.cond_margin)).curve;
    const H = N(x.market_home_line), p0 = RD.sideProb(curve, 'home', H);
    if (!p0) return;
    const q = Math.min(1 - 1e-4, Math.max(1e-4, EV.applyCalibrator(maps[N(x.season)], p0.cover)));
    const d = Math.abs(q - p0.cover) < 1e-12 ? 0 : EV.solveShift(curve, H, q);
    if (d == null) return;
    n++;
    const fm = N(x.final_margin);
    ks.forEach((k) => {
      const at = (kk) => { const a = EV.shiftedHome(curve, -kk, d); return a ? a.push : 0; };
      acc[k].raw += (RD.massAt(curve, 'home', k) || 0) + (RD.massAt(curve, 'home', -k) || 0);
      acc[k].anc += at(k) + at(-k);
      acc[k].obs += Math.abs(fm) === k ? 1 : 0;
    });
    if (Math.abs(H - Math.round(H)) < 1e-9) {
      const sh = EV.shiftedHome(curve, H, d), yP = N(x.y_push), a = Math.abs(H);
      const b = a === 3 ? 'k3' : (a === 7 ? 'k7' : (a === 10 ? 'k10' : 'other'));
      [push.all, push[b]].forEach((P) => { P.n++; P.raw += p0.push; P.anc += sh.push; P.obs += yP; });
      const o = yP === 1 ? 'P' : (N(x.y_cover) === 1 ? 'W' : 'L');
      llRaw -= o === 'P' ? g(p0.push) : (o === 'W' ? g(p0.win) : g(p0.loss));
      llAnc -= o === 'P' ? g(sh.push) : (o === 'W' ? g(sh.win) : g(sh.loss));
      n3++;
    }
  });
  const pr = (P) => ({ n: P.n, predicted_raw: r(P.raw / (P.n || 1), 4), predicted_anchored: r(P.anc / (P.n || 1), 4), observed: r(P.obs / (P.n || 1), 4), wilson95: C.wilson(P.obs, P.n) });
  return { method: t.chosen, games: n, push: { all_integer_lines: pr(push.all), line_3: pr(push.k3), line_7: pr(push.k7), line_10: pr(push.k10), other_integers: pr(push.other) },
    three_state_log_loss: { n: n3, raw: r(llRaw / n3, 5), anchored: r(llAnc / n3, 5) },
    key_numbers: ks.map((k) => ({ abs_margin: k, empirical: r(acc[k].obs / n, 4), raw_mean_mass: r(acc[k].raw / n, 4), anchored_mean_mass: r(acc[k].anc / n, 4) })),
    note: 'OOF: each season read with the map fitted on the seasons before it, evaluated at the close and carried by the frozen distribution (fractional moves are mixtures of the two neighbouring integer moves)' };
}


/* is the production distribution's key-number mass validated? (pack §19) */
function keyVerdict(au) {
  const A = au.anchored, P = A.push.all_integer_lines, k3 = A.key_numbers.filter((k) => k.abs_margin === 3)[0], k7 = A.key_numbers.filter((k) => k.abs_margin === 7)[0];
  const covered = P.wilson95 && P.predicted_anchored >= P.wilson95[0] && P.predicted_anchored <= P.wilson95[1];
  /* where the key-number mass is lost: the raw curve (the champion re-centres its
     market-conditioned PMF by reweighting it in place since 2026-10-04, so its
     spikes stay on the margins games end on) or the calibration anchor, which
     carries that curve to the calibrated probability by a location move */
  const raw3 = (au.key_numbers.filter((k) => k.abs_margin === 3)[0] || {}).pmf_mean_mass, raw7 = (au.key_numbers.filter((k) => k.abs_margin === 7)[0] || {}).pmf_mean_mass;
  const anchorLoses = raw3 > k3.anchored_mean_mass && raw7 > k7.anchored_mean_mass;
  const cause = anchorLoses
    ? ' Cause: the raw curve keeps its spikes on the key numbers (raw mass ' + (100 * raw3).toFixed(1) + '% at 3, ' + (100 * raw7).toFixed(1) + '% at 7: football/cfb_p4/engine.js cfbRecentre re-centres the market-conditioned PMF by reweighting it in place), but the calibration anchor re-centres that curve on the calibrated probability by a location move (a mixture of integer moves, lib/edgedesk_ev.js shiftedHome), which carries the spikes off the key numbers again.'
    : ' Cause: the champion’s market-conditioned PMF, as re-centred (football/cfb_p4/engine.js cfbRecentre), carries less mass on the key numbers than games show (raw mass ' + (100 * raw3).toFixed(1) + '% at 3, ' + (100 * raw7).toFixed(1) + '% at 7).';
  return { validated: !!covered, primary: [3, 7],
    finding: 'At integer market lines the anchored distribution predicts a ' + (100 * P.predicted_anchored).toFixed(1) + '% push rate (raw ' + (100 * P.predicted_raw).toFixed(1) + '%) against ' + (100 * P.observed).toFixed(1)
      + '% observed (95% ' + (100 * P.wilson95[0]).toFixed(1) + '–' + (100 * P.wilson95[1]).toFixed(1) + '%); |margin| = 3 is ' + (100 * k3.empirical).toFixed(1) + '% of 2022-2025 FBS games but carries ' + (100 * k3.anchored_mean_mass).toFixed(1)
      + '% of the anchored mass, 7 is ' + (100 * k7.empirical).toFixed(1) + '% vs ' + (100 * k7.anchored_mean_mass).toFixed(1) + '%.' + cause,
    consequence: covered ? null : 'Key-number mass is NOT VALIDATED: an alternate line that crosses 3 or 7 relative to the market line is never actionable, and the juice panel prints the empirical share beside the model mass. A main-line EV at an integer number moves by about 0.1 pt of EV per 2 pp of push error at −110, so main lines are not blocked. No manual key-number bonus is added.' };
}

/* ------------------------------------------------------------ the holdout */
function holdout(all, tasks) {
  const acc = path.join(OUTDIR, 'holdout_access.jsonl');
  if (fs.existsSync(acc) && fs.readFileSync(acc, 'utf8').split('\n').filter(Boolean).some((l) => JSON.parse(l).version === VERSION)) {
    console.error('the ' + VERSION + ' holdout was already read (holdout_access.jsonl): a second read is refused'); process.exit(3);
  }
  const res = {};
  tasks.forEach((t) => {
    if (t.key === 'cfb|spread|open') { res[t.key] = { n: 0, note: 'the published 2026 record carries no opener price or line for most games: no open-checkpoint holdout' }; return; }
    const hp = t.key === 'cfb|moneyline|close' ? 'p_home_ml' : 'p_cover', hy = t.key === 'cfb|moneyline|close' ? 'y_home_win' : 'y_cover';
    const rows = all.filter((x) => x.window === 'HOLDOUT_2026' && x.checkpoint === 'close').map((x) => ({ p: N(x[hp]), y: N(x[hy]), cluster: x.season + '-' + x.week })).filter((x) => x.p != null && (x.y === 0 || x.y === 1));
    if (!rows.length) { res[t.key] = { n: 0, note: 'no holdout rows (the week-2 record has no win probability)' }; return; }
    const pi = rows.map((x) => x.p), pc = rows.map((x) => C.apply(t.final_map, x.p)), y = rows.map((x) => x.y);
    const d = rows.map((x, i) => lossRow(pc[i], x.y) - lossRow(pi[i], x.y));
    const bt = clusterBoot(d, rows.map((x) => x.cluster), B_BOOT, SEED + 77);
    const mi = C.metrics(pi, y), mc = C.metrics(pc, y);
    delete mi.reliability_curve; delete mc.reliability_curve;
    const revoke = t.status === 'PROMOTED' && bt.ci95[0] > 0;
    res[t.key] = { n: rows.length, identity: mi, chosen: Object.assign({ method: t.chosen }, mc), delta_log_loss: r(bt.mean, 6), delta_log_loss_ci95: [r(bt.ci95[0], 6), r(bt.ci95[1], 6)],
      verdict: t.status !== 'PROMOTED' ? 'nothing to confirm (' + t.status + ')' : (revoke ? 'REVOKED: the promoted map is significantly worse than identity on the holdout' : 'CONFIRMED: the holdout does not contradict the promotion') };
    if (revoke) { t.status = 'NOT_VALIDATED'; t.why += ' — REVOKED by the 2026 holdout'; t.chosen = 'identity'; t.final_map = { method: 'identity' }; }
  });
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.appendFileSync(acc, JSON.stringify({ version: VERSION, read_at: new Date().toISOString(), dataset_sha256: sha(fs.readFileSync(DATA)), rule: 'PREREG §5: the holdout confirms or revokes, never selects', results: Object.keys(res).map((k) => ({ key: k, n: res[k].n, verdict: res[k].verdict || res[k].note })) }) + '\n');
  return res;
}

/* ----------------------------------------------------------------- main */
function main() {
  const buf = fs.readFileSync(DATA);
  const all = readCsv(buf);
  const out = TASKS.map((t) => tournament(t, all));
  const au = audits(all);
  const alt = altDomain(all, out[0]);
  au.anchored = anchoredAudit(all, out[0]);
  const readHold = flag('read-holdout');
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'tournament.json'), 'utf8')); } catch (e) { prior = null; }
  const hold = readHold ? holdout(all, out) : (prior && prior.holdout ? prior.holdout : null);
  if (!readHold && hold) {
    /* a revocation recorded by the one holdout read stands on every rebuild */
    out.forEach((t) => { const h = hold[t.key]; if (h && /^REVOKED/.test(h.verdict || '')) { t.status = 'NOT_VALIDATED'; t.chosen = 'identity'; t.final_map = { method: 'identity' }; t.why += ' — REVOKED by the 2026 holdout'; } });
  }
  const builtAt = new Date().toISOString();
  const cal = {
    schema: EV.CAL_SCHEMA, version: VERSION, base_model_version: BASE_MODEL, built_at: builtAt,
    dataset: { file: path.relative(ROOT, DATA), sha256: sha(buf) },
    rule: 'docs/edgedesk-ev/PREREG.md §5: walk-forward by season on 2022-2025; simple wins ties; the 2026 record confirms or revokes once',
    football_only: true, market_inputs: 'none — every map takes the raw football probability alone',
    orientation: 'home: the map calibrates P(home covers | no push) (or P(home wins)); the away side is the complement',
    calibrators: {}, checkpoint_map: { OPEN: 'cfb|spread|open', EARLY_WEEK: 'cfb|spread|open', MIDWEEK: 'cfb|spread|close', T24: 'cfb|spread|close', T6: 'cfb|spread|close', FINAL: 'cfb|spread|close',
      HYPOTHETICAL: 'cfb|spread|close', UNKNOWN: 'cfb|spread|close', note: 'pre-registered: an opener or early-week quote reads the opener calibrator; everything later reads the close calibrator' },
    extremes: au.extremes, location: au.location, holdout_read: !!hold,
    key_numbers: keyVerdict(au)
  };
  out.forEach((t) => {
    const id = t.results.identity.pooled, ch = t.results[t.chosen].pooled;
    cal.calibrators[t.key] = { status: t.status, method: t.chosen, map: compactMap(t.final_map), maturity: t.status === 'NOT_VALIDATED' ? 'PENDING' : 'SHADOW',
      training_window: t.final_training_window, n: t.n_oos, domain: t.domain, why: t.why,
      reason: t.status === 'NOT_VALIDATED' ? 'no calibrator is validated for ' + t.key + ': ' + t.why : null,
      oof: { n: ch.n, log_loss: ch.log_loss, brier: ch.brier, slope: ch.slope, citl: ch.citl, identity_log_loss: id.log_loss, identity_brier: id.brier, identity_slope: id.slope, identity_citl: id.citl },
      holdout: hold && hold[t.key] ? { n: hold[t.key].n, verdict: hold[t.key].verdict || hold[t.key].note || null } : null,
      uncertainty: Object.assign({ sd_ref: au.location.sd_ref }, t.uncertainty) };
  });
  const rep = { schema: 'edgedesk_ev_tournament_v1', version: VERSION, base_model_version: BASE_MODEL, built_at: builtAt, dataset: cal.dataset, seed: SEED, bootstrap: B_BOOT,
    prereg: 'docs/edgedesk-ev/PREREG.md', tasks: out.map((t) => { const o = Object.assign({}, t); delete o._oof; delete o._oos; delete o.uncertainty; return o; }),
    audits: au, alternate_line_domain: alt, holdout: hold || null };
  const summary = out.map((t) => ({ key: t.key, n_oof: t.n_oof, status: t.status, chosen: t.chosen,
    ll: Object.fromEntries(C.ORDER.map((m) => [m, t.results[m].pooled.log_loss])), identity_slope: t.results.identity.pooled.slope, identity_slope_ci: t.results.identity.pooled.slope_ci95,
    eligible: t.eligible, dll: Object.fromEntries(C.ORDER.filter((m) => m !== 'identity').map((m) => [m, t.results[m].vs_identity.delta_log_loss_ci95])) }));
  console.log(JSON.stringify({ summary: summary, push: au.push.all_integer_lines, distribution: au.distribution.verdict, extremes: au.extremes, location: au.location, holdout: hold ? Object.keys(hold).map((k) => [k, hold[k].verdict || hold[k].note]) : 'not read' }, null, 1));
  if (flag('check')) {
    /* reproducibility: the committed artifact must be exactly what the committed dataset and code produce */
    const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUTDIR, 'calibration.json'), 'utf8')); } catch (e) { return null; } })();
    const strip = (o) => { const x = JSON.parse(JSON.stringify(o)); delete x.built_at; return JSON.stringify(x); };
    if (!cur) { console.error('no committed calibration.json to compare with'); process.exit(1); }
    if (strip(cur) !== strip(cal)) { console.error('DIFFERS: the committed calibration.json is not what this dataset and code produce'); process.exit(1); }
    console.error('REPRODUCED: calibration.json matches the committed artifact');
    return;
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const wcal = JSON.stringify(cal) + '\n', wrep = JSON.stringify(rep, null, 1) + '\n';
  fs.writeFileSync(path.join(OUTDIR, 'calibration.json'), wcal);
  fs.writeFileSync(path.join(OUTDIR, 'tournament.json'), wrep);
  const files = ['football/cfb_ev/dataset.js', 'football/cfb_ev/calibrators.js', 'football/cfb_ev/tournament.js', 'lib/edgedesk_ev.js', 'lib/edgedesk_read.js', 'football/cfb_terminal/build.js', 'football/cfb_p4/params.js', 'docs/edgedesk-ev/PREREG.md'];
  const man = { schema: 'edgedesk_ev_calibration_manifest_v1', version: VERSION, built_at: builtAt, dataset_sha256: sha(buf),
    artifacts: { 'calibration.json': sha(wcal), 'tournament.json': sha(wrep) }, code: Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f)))])) };
  fs.writeFileSync(path.join(OUTDIR, 'MANIFEST.json'), JSON.stringify(man, null, 1) + '\n');
}
function compactMap(m) {
  const o = { method: m.method };
  ['a', 'b', 'c', 'T'].forEach((k) => { if (m[k] != null) o[k] = +(+m[k]).toFixed(6); });
  if (m.x) { o.x = m.x; o.y = m.y; }
  if (m.scores) { o.scores = m.scores; o.labels = m.labels; }
  if (m.window) o.window = m.window;
  return o;
}

if (require.main === module) main();
module.exports = { TASKS, clusterBoot, readCsv };
