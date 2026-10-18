#!/usr/bin/env node
/* ============================================================================
   THE CFB LIVE CALIBRATION — diagnose, walk forward, decide.

   Reads the season's graded public record and the quote ledgers EdgeDesk
   stored, and answers three questions in this order:

     1  DIAGNOSE  Is the published V1 number systematically wrong, and where?
                  Calibration by confidence, margin compression, error by
                  margin size, the sigma behind the probability, the home
                  field, the market at publication, totals, FBS vs FCS.
     2  TEST      Every candidate fix, scored walk-forward: each game is
                  priced only with parameters fitted on games whose final was
                  known before that game's number was published, and only with
                  a market line EdgeDesk had OBSERVED by then. Never the close.
     3  DECIDE    The configured candidate against the promotion rule in
                  live_calibration_config.json. A person still has to flip the
                  switch; this script can only say whether the record allows it.

   WHAT IT NEVER DOES
     It never writes to the record, the performance ledger or any published
     number. It reads record/football/cfb_<season>.json and writes only:
       football/cfb_p4/live_calibration.js          the fitted parameters (GENERATED)
       football/validation/cfb_live_calibration.json the full evidence
       football/cfb_p4/research/report/LIVE_CALIBRATION.md

   SIGN CONVENTION. Every margin here is a HOME MARGIN, + = home favoured. A
   book line (negative = home favoured) is negated exactly once, on the way
   in (marginOfBookLine). The engine's req.market.spread_line is already a
   margin. Both are pinned by football/cfb_p4/live_calibration.test.js.

   Every option is priced through the engine's own E.liveCalibration.apply, so
   the number this script validates is the number the engine would publish.

   Usage
     node football/cfb_p4/research/live_calibration.js            # report, write nothing
     node football/cfb_p4/research/live_calibration.js --write    # write the three artifacts
     node football/cfb_p4/research/live_calibration.js --season 2026 --now 2026-10-18T23:00:00Z
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const P = global.window.EDCfbP4Params;

const CONFIG_FILE = path.join(ROOT, 'football', 'cfb_p4', 'live_calibration_config.json');
const OUT_JS = path.join(ROOT, 'football', 'cfb_p4', 'live_calibration.js');
const OUT_JSON = path.join(ROOT, 'football', 'validation', 'cfb_live_calibration.json');
const OUT_MD = path.join(ROOT, 'football', 'cfb_p4', 'research', 'report', 'LIVE_CALIBRATION.md');

/* ------------------------------------------------------------------ maths */
const normCdf = E._internal.normCdf;
function normInv(p) {
  let lo = -10, hi = 10;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function normPdf(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
const isNum = (v) => typeof v === 'number' && isFinite(v);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function sd(a) { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)) : null; }
function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
function pct(a, q) { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const brierOf = (ps, ys) => mean(ps.map((p, i) => (p - ys[i]) * (p - ys[i])));
const loglossOf = (ps, ys) => mean(ps.map((p, i) => -(ys[i] * Math.log(clip(p)) + (1 - ys[i]) * Math.log(1 - clip(p)))));
const r = (v, d) => (isNum(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null);

function wilson(k, n, z) {
  z = z || 1.96; if (!n) return [null, null];
  const ph = k / n, d = 1 + z * z / n, c = (ph + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d;
  return [c - h, c + h];
}

/* least squares with standard errors: y ~ X (X carries its own constant) */
function solve(A, b) {
  const n = A.length, M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[piv][c])) piv = i;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c]; if (Math.abs(d) < 1e-12) return null;
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let i = 0; i < n; i++) if (i !== c) { const f = M[i][c]; for (let j = c; j <= n; j++) M[i][j] -= f * M[c][j]; }
  }
  return M.map((row) => row[n]);
}
function inverse(A) {
  const n = A.length; const cols = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; cols.push(solve(A, e)); }
  if (cols.some((c) => !c)) return null;
  return A.map((_, i) => cols.map((c) => c[i]));
}
function ols(y, X) {
  const n = y.length, k = X[0].length;
  const XtX = []; const Xty = new Array(k).fill(0);
  for (let a = 0; a < k; a++) { XtX.push(new Array(k).fill(0)); }
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const inv = inverse(XtX); if (!inv) return null;
  const b = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  let rss = 0, tss = 0; const ym = mean(y);
  for (let i = 0; i < n; i++) { const f = X[i].reduce((s, v, j) => s + v * b[j], 0); rss += (y[i] - f) ** 2; tss += (y[i] - ym) ** 2; }
  const s2 = rss / (n - k);
  return { n, coef: b, se: inv.map((row, i) => Math.sqrt(s2 * row[i])), r2: 1 - rss / tss };
}

/* seeded, so a rerun on the same record prints the same intervals */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function bootMeanCI(d, B, seed) {
  const rnd = mulberry32(seed), n = d.length, vals = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)]; vals.push(s / n); }
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * B)], vals[Math.ceil(0.975 * B) - 1]];
}

/* ------------------------------------------------------------- the data */
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const ms = (s) => (s ? Date.parse(s) : NaN);
/* THE ONE PLACE A BOOK LINE BECOMES A MARGIN */
function marginOfBookLine(homeLine) { return isNum(homeLine) ? -homeLine : null; }
function noVig(homeMl, awayMl) {
  if (!isNum(homeMl) || !isNum(awayMl) || homeMl === 0 || awayMl === 0) return null;
  const imp = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
  const a = imp(homeMl), b = imp(awayMl);
  return a / (a + b);
}

function quoteLedgers(season) {
  const spreads = {}, mls = {};
  const add = (bag, gid, at, v) => { if (!at) return; (bag[String(gid)] = bag[String(gid)] || []).push(Object.assign({ at }, v)); };
  readJsonl(path.join(ROOT, 'record', 'football', 'quotes', 'cfb_' + season + '.jsonl')).forEach((q) => {
    if (!q.is_pregame || !(ms(q.observed_at) < ms(q.kickoff_ts))) return;
    if (q.market_type === 'spread' && isNum(q.home_line)) add(spreads, q.game_id, q.observed_at, { home_line: q.home_line, src: 'record_quotes' });
    if (q.market_type === 'moneyline' && isNum(q.price_home) && isNum(q.price_away)) add(mls, q.game_id, q.observed_at, { home_ml: q.price_home, away_ml: q.price_away });
  });
  const labDir = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season), 'quotes');
  (fs.existsSync(labDir) ? fs.readdirSync(labDir).filter((f) => /\.jsonl$/.test(f)).sort() : []).forEach((f) => {
    readJsonl(path.join(labDir, f)).forEach((q) => {
      /* a provider-declared OPEN or CLOSE row is still only KNOWN from the time
         EdgeDesk observed it, and a close is never an input */
      if (!q.is_pregame || q.is_provider_close || !(ms(q.observed_at) < ms(q.kickoff_ts))) return;
      if (q.market_type === 'spread' && isNum(q.home_line)) add(spreads, q.game_id, q.observed_at, { home_line: q.home_line, src: 'lab_' + q.source });
      if (q.market_type === 'moneyline' && isNum(q.price_home) && isNum(q.price_away)) add(mls, q.game_id, q.observed_at, { home_ml: q.price_home, away_ml: q.price_away });
    });
  });
  [spreads, mls].forEach((bag) => Object.keys(bag).forEach((k) => bag[k].sort((a, b) => ms(a.at) - ms(b.at))));
  return { spreads, mls };
}
function latestAtOrBefore(list, t) {
  let best = null;
  (list || []).forEach((q) => { if (ms(q.at) <= t) best = q; });
  return best;
}

/** One row per GRADED game: the pick as published, the market EdgeDesk had
    observed by the pick's publication, the close (benchmark only), the final. */
function buildDataset(season) {
  const rec = readJson(path.join(ROOT, 'record', 'football', 'cfb_' + season + '.json'));
  const Q = quoteLedgers(season);
  const rows = [];
  Object.keys(rec.games).forEach((gid) => {
    const v = rec.games[gid], gr = v.grade || {};
    if (gr.status !== 'GRADED' || !v.pick || !v.final || !v.close) return;
    const t = ms(v.pick.at);
    const cands = [];
    const lq = latestAtOrBefore(Q.spreads[gid], t);
    if (lq) cands.push({ at: lq.at, home_line: lq.home_line, src: lq.src });
    const em = v.entry && v.entry.market;
    if (em && isNum(em.home_line) && ms(em.at) <= t) cands.push({ at: em.at, home_line: em.home_line, src: 'entry' });
    const pl = v.pick.price_lock && v.pick.price_lock.spread;
    if (pl && pl.status === 'locked' && isNum(pl.home_line) && ms(pl.observed_at) <= t) cands.push({ at: pl.observed_at, home_line: pl.home_line, src: 'price_lock' });
    cands.sort((a, b) => ms(a.at) - ms(b.at));
    const pub = cands.length ? cands[cands.length - 1] : null;
    const ml = latestAtOrBefore(Q.mls[gid], t);
    const cp = v.close.prices || {};
    const margin = v.final.home_score - v.final.away_score;
    rows.push({
      game_id: gid, week: v.week, kickoff: v.kickoff, home: v.home, away: v.away,
      home_conf: v.home_conference || null, away_conf: v.away_conference || null,
      group: v.group || null, fbs_fbs: v.group !== 'fbs_fcs', neutral: !!v.neutral_site,
      pick_at: v.pick.at, model_version: v.pick.model_version || v.model_version || null,
      model_margin: marginOfBookLine(v.pick.home_line), model_total: isNum(v.pick.total) ? v.pick.total : null,
      p_home: isNum(v.pick.home_win_prob) ? v.pick.home_win_prob : null,
      pub_margin: pub ? marginOfBookLine(pub.home_line) : null, pub_at: pub ? pub.at : null, pub_src: pub ? pub.src : null,
      pub_nv: ml ? noVig(ml.home_ml, ml.away_ml) : null,
      close_margin: marginOfBookLine(v.close.home_line), close_total: isNum(v.close.total) ? v.close.total : null,
      close_nv: noVig(cp.home_ml, cp.away_ml),
      actual_margin: margin, actual_total: v.final.home_score + v.final.away_score,
      home_win: margin > 0 ? 1 : (margin < 0 ? 0 : 0.5)
    });
  });
  rows.sort((a, b) => ms(a.kickoff) - ms(b.kickoff) || String(a.game_id).localeCompare(String(b.game_id)));
  /* the engine's own sigma for each game, recovered from the published pair
     and held inside the volatility layer's own [floor, ceiling] */
  const V = P.volatility || {}, lo = V.sigma_floor || 14.6, hi = V.sigma_ceiling || 15.7;
  const valid = rows.filter((x) => isNum(x.p_home) && x.p_home > 1e-3 && x.p_home < 1 - 1e-3 && Math.abs(x.model_margin) > 0.5)
    .map((x) => x.model_margin / normInv(x.p_home));
  const fallback = valid.length ? median(valid) : (V.sigma_base || 14.9);
  rows.forEach((x) => {
    let s = (isNum(x.p_home) && x.p_home > 1e-3 && x.p_home < 1 - 1e-3 && Math.abs(x.model_margin) > 0.5)
      ? x.model_margin / normInv(x.p_home) : fallback;
    x.sigma_pub = Math.min(hi, Math.max(lo, s));
    x.is_home = x.neutral ? 0 : 1;
    x.applied_hfa = x.neutral ? 0 : P.venue.league_hfa;
  });
  return { rows, record_updated_at: rec.updated_at || null, model: rec.model || null, implied_sigma: valid };
}

/* --------------------------------------------------------- the options */
/* Every option is a parameter set for E.liveCalibration.apply. Fitting
   returns that set from training rows only. */
function priceWith(params, x) {
  return E.liveCalibration.apply({ params }, {
    raw_margin: x.model_margin, applied_hfa: x.applied_hfa, neutral: x.neutral,
    sigma: x.sigma_pub, total: x.model_total, market_margin: x.pub_margin
  });
}
function sigmaScaleMle(params, rows, grid) {
  let best = null;
  for (let s = grid[0]; s <= grid[1] + 1e-9; s += grid[2]) {
    const pp = Object.assign({}, params, { sigma_scale: s });
    let ll = 0;
    rows.forEach((x) => { const q = priceWith(pp, x); const p = clip(q.home_win_prob); ll += x.home_win * Math.log(p) + (1 - x.home_win) * Math.log(1 - p); });
    if (!best || ll > best.ll) best = { s, ll };
  }
  return Math.round(best.s * 1000) / 1000;
}
function probitMle(z, y) {
  let a = 1, b = 0;
  for (let it = 0; it < 100; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < z.length; i++) {
      const eta = a * z[i] + b, F = Math.min(1 - 1e-10, Math.max(1e-10, normCdf(eta))), f = normPdf(eta);
      const lam = f * (y[i] - F) / (F * (1 - F)), W = f * f / (F * (1 - F));
      g0 += lam * z[i]; g1 += lam; h00 += W * z[i] * z[i]; h01 += W * z[i]; h11 += W;
    }
    const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (-h01 * g0 + h00 * g1) / det;
    a += da; b += db;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
function isotonicFit(p, y) {
  const o = p.map((v, i) => i).sort((i, j) => p[i] - p[j]);
  const blocks = o.map((i) => ({ sum: y[i], n: 1, lo: p[i], hi: p[i] }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].n > blocks[i + 1].sum / blocks[i + 1].n) {
      const b = blocks.splice(i + 1, 1)[0]; blocks[i].sum += b.sum; blocks[i].n += b.n; blocks[i].hi = b.hi; i = Math.max(i - 1, 0);
    } else i++;
  }
  return blocks.map((b) => ({ x: (b.lo + b.hi) / 2, v: b.sum / b.n }));
}
function isotonicApply(fit, p) {
  if (p <= fit[0].x) return fit[0].v;
  for (let i = 1; i < fit.length; i++) if (p <= fit[i].x) {
    const a = fit[i - 1], b = fit[i]; return a.v + (b.v - a.v) * (p - a.x) / (b.x - a.x);
  }
  return fit[fit.length - 1].v;
}

function blendFit(rows, base, kind, minN) {
  const t = rows.filter((x) => isNum(x.pub_margin));
  if (t.length < minN) return null;
  const pre = t.map((x) => priceWith(base, Object.assign({}, x, { pub_margin: null })).margin);
  const d = t.map((x, i) => pre[i] - x.pub_margin), y = t.map((x) => x.actual_margin - x.pub_margin);
  if (kind === 'global') {
    const num = d.reduce((s, v, i) => s + v * y[i], 0), den = d.reduce((s, v) => s + v * v, 0);
    const w = num / den;
    const res = y.map((v, i) => v - w * d[i]);
    const se = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / (t.length - 1) / den);
    return { w: Math.min(1, Math.max(0, w)), w_unclamped: w, se, n: t.length };
  }
  const X = d.map((v, i) => [v, kind === 'disagree' ? v * Math.abs(v) / 10 : v * Math.abs(pre[i]) / 10]);
  const f = ols(y, X); if (!f) return null;
  return { w0: f.coef[0], w1: f.coef[1], se0: f.se[0], se1: f.se[1], n: t.length };
}

const OPTIONS = [
  { id: 'BASE', label: 'current model (published numbers)' },
  { id: 'CAP95', label: '(d) hard cap at 95%, applied by widening sigma' },
  { id: 'SIGMA', label: '(c) refit sigma (a scale on the engine sigma)' },
  { id: 'K', label: '(a) global shrinkage k x margin' },
  { id: 'K+SIGMA', label: '(a)+(c)' },
  { id: 'HFA_PRE', label: 'home-field fix, pre-registered on 2015-2025 (cfb_margin_cal_v1)' },
  { id: 'HFA_PRE+SIGMA', label: 'home-field fix + refit sigma' },
  { id: 'HFA_WF', label: 'home-field constant refit walk-forward on 2026' },
  { id: 'BLEND', label: '(b) market blend w x model + (1-w) x publish-time line' },
  { id: 'BLEND_DIS', label: '(b) blend, w falls with disagreement' },
  { id: 'BLEND_SIZE', label: '(b) blend, w falls with margin size' },
  { id: 'HFA_PRE+BLEND', label: 'home-field fix + blend' },
  { id: 'PLATT', label: '(c) probit-Platt on the margin (consistent)' },
  { id: 'HFA_PRE+PLATT', label: 'home-field fix + probit-Platt' },
  { id: 'ISOTONIC', label: '(c) isotonic on the probability (NOT margin-consistent)' }
];

function fitAll(train, C) {
  const W = C.walk_forward, prior = C.prior, grid = W.sigma_grid ? [0.6, 2.0, 0.005] : [0.6, 2.0, 0.005];
  const trp = train.filter((x) => isNum(x.p_home));
  const F = { n: train.length, n_p: trp.length };
  const one = { k: 1, h: null };
  const pre = { k: prior.k, h: prior.h, league_hfa: prior.league_hfa };
  F.BASE = one;
  F.CAP95 = Object.assign({}, one, { p_cap: 0.95 });
  const okM = train.length >= W.min_train_games, okP = trp.length >= W.min_train_probabilities;
  /* k by least squares through the origin: actual = k x model */
  let k = 1;
  if (okM) { const n = train.reduce((s, x) => s + x.model_margin * x.actual_margin, 0), d = train.reduce((s, x) => s + x.model_margin * x.model_margin, 0); k = n / d; }
  F.K = { k, h: null };
  F.SIGMA = okP ? Object.assign({}, one, { sigma_scale: sigmaScaleMle(one, trp, grid) }) : one;
  F['K+SIGMA'] = okP ? Object.assign({}, F.K, { sigma_scale: sigmaScaleMle(F.K, trp, grid) }) : F.K;
  F.HFA_PRE = pre;
  F['HFA_PRE+SIGMA'] = okP ? Object.assign({}, pre, { sigma_scale: sigmaScaleMle(pre, trp, grid) }) : pre;
  /* the home-field constant alone: actual = model - applied + h on home games */
  let h = prior.h;
  const hg = train.filter((x) => x.is_home === 1);
  if (okM && hg.length) h = mean(hg.map((x) => x.actual_margin - (x.model_margin - x.applied_hfa)));
  F.HFA_WF = { k: 1, h };
  const bl = (base, kind) => {
    const f = blendFit(train, base, kind, W.min_train_market);
    if (!f) return base;
    const blend = kind === 'global' ? { enabled: true, w: f.w }
      : (kind === 'disagree' ? { enabled: true, w: f.w0, w_per_10_disagreement: f.w1 }
        : { enabled: true, w: f.w0, w_per_10_margin: f.w1 });
    const pp = Object.assign({}, base, { blend });
    return Object.assign(pp, { sigma_scale: okP ? sigmaScaleMle(pp, trp, grid) : 1, _fit: f });
  };
  F.BLEND = bl(one, 'global');
  F.BLEND_DIS = bl(one, 'disagree');
  F.BLEND_SIZE = bl(one, 'size');
  F['HFA_PRE+BLEND'] = bl(pre, 'global');
  const platt = (base) => {
    if (!okP) return base;
    const z = trp.map((x) => { const q = priceWith(base, x); return q.margin / q.sigma; });
    const f = probitMle(z, trp.map((x) => x.home_win));
    return Object.assign({}, base, { probit_a: f.a, probit_b: f.b });
  };
  F.PLATT = platt(one);
  F['HFA_PRE+PLATT'] = platt(pre);
  F.ISOTONIC = okP ? { iso: isotonicFit(trp.map((x) => x.p_home), trp.map((x) => x.home_win)) } : null;
  return F;
}

/* w(|m|) needs the margin before blending; apply() carries only w(|d|), so the
   size variant is priced here, through apply, at the w its own margin gives */
function priceOption(id, F, x) {
  const par = F[id];
  if (id === 'ISOTONIC') {
    if (!par) return { margin: x.model_margin, p: x.p_home, consistent: false };
    return { margin: x.model_margin, p: Math.min(0.99, Math.max(0.01, isotonicApply(par.iso, x.p_home))), consistent: false };
  }
  let pp = par;
  if (par.blend && isNum(par.blend.w_per_10_margin)) {
    const preM = priceWith(Object.assign({}, par, { blend: null }), x).margin;
    pp = Object.assign({}, par, { blend: { enabled: true, w: Math.min(1, Math.max(0, par.blend.w + par.blend.w_per_10_margin * Math.abs(preM) / 10)) } });
  }
  const q = priceWith(pp, x);
  return { margin: q.margin, p: q.home_win_prob, sigma: q.sigma, blend_used: !!(q.blend && q.blend.used), consistent: true };
}

function walkForward(D, C) {
  const W = C.walk_forward, lagMs = W.final_known_after_hours * 3600e3;
  const pop = D.rows.filter((x) => x.fbs_fbs);
  const ev = D.rows.filter((x) => x.week >= W.eval_from_week && isNum(x.p_home));
  const cache = {};
  const out = [];
  ev.forEach((x) => {
    const t = ms(x.pick_at), key = String(Math.floor(t / 3600e3));
    if (!cache[key]) {
      const train = pop.filter((g) => ms(g.kickoff) + lagMs < t);
      cache[key] = fitAll(train, C);
    }
    const F = cache[key];
    const row = { x, train_n: F.n, train_np: F.n_p, priced: {} };
    OPTIONS.forEach((o) => {
      if (!x.fbs_fbs && o.id !== 'CAP95') { row.priced[o.id] = { margin: x.model_margin, p: x.p_home, consistent: true }; return; }
      if (!x.fbs_fbs) { row.priced[o.id] = priceOption(o.id, F, x); return; }
      row.priced[o.id] = priceOption(o.id, F, x);
    });
    /* BASE is the published probability itself, not a recomputation of it */
    row.priced.BASE = { margin: x.model_margin, p: x.p_home, consistent: true };
    row.fit = F;
    out.push(row);
  });
  return out;
}

/* ------------------------------------------------------------- scoring */
const BUCKETS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0001]];
function favView(p, y) { return p >= 0.5 ? [p, y] : [1 - p, 1 - y]; }
function calibTable(ps, ys) {
  return BUCKETS.map(([lo, hi]) => {
    const idx = []; ps.forEach((p, i) => { const f = favView(p, ys[i])[0]; if (f >= lo && f < hi) idx.push(i); });
    const n = idx.length;
    const label = Math.round(lo * 100) + '-' + Math.min(100, Math.round(hi * 100));
    if (!n) return { bucket: label, n: 0 };
    const pf = idx.map((i) => favView(ps[i], ys[i])[0]), yf = idx.map((i) => favView(ps[i], ys[i])[1]);
    const k = yf.reduce((s, v) => s + v, 0), w = wilson(k, n);
    return { bucket: label, n, avg_pred: r(mean(pf), 4), actual: r(k / n, 4), wilson_lo: r(w[0], 4), wilson_hi: r(w[1], 4),
      brier: r(brierOf(pf, yf), 4), gap: r(k / n - mean(pf), 4), inside_interval: mean(pf) >= w[0] && mean(pf) <= w[1], small_sample: n < 30 };
  });
}
function ece(ps, ys) {
  let tot = 0;
  BUCKETS.forEach(([lo, hi]) => {
    const idx = []; ps.forEach((p, i) => { const f = favView(p, ys[i])[0]; if (f >= lo && f < hi) idx.push(i); });
    if (idx.length) tot += idx.length * Math.abs(mean(idx.map((i) => favView(ps[i], ys[i])[1])) - mean(idx.map((i) => favView(ps[i], ys[i])[0])));
  });
  return tot / ps.length;
}

function score(rows, id, C) {
  const ys = rows.map((w) => w.x.home_win), as = rows.map((w) => w.x.actual_margin);
  const ps = rows.map((w) => w.priced[id].p), ms_ = rows.map((w) => w.priced[id].margin);
  const pb = rows.map((w) => w.priced.BASE.p), mb = rows.map((w) => w.priced.BASE.margin);
  const dB = ps.map((p, i) => (p - ys[i]) ** 2 - (pb[i] - ys[i]) ** 2);
  const dL = ps.map((p, i) => -(ys[i] * Math.log(clip(p)) + (1 - ys[i]) * Math.log(1 - clip(p))) + (ys[i] * Math.log(clip(pb[i])) + (1 - ys[i]) * Math.log(1 - clip(pb[i]))));
  const dM = ms_.map((m, i) => Math.abs(as[i] - m) - Math.abs(as[i] - mb[i]));
  const R = C.promotion_rule;
  const ciB = bootMeanCI(dB, R.bootstrap_draws, R.bootstrap_seed), ciM = bootMeanCI(dM, R.bootstrap_draws, R.bootstrap_seed + 1);
  const ciL = bootMeanCI(dL, R.bootstrap_draws, R.bootstrap_seed + 2);
  const weeks = {}; rows.forEach((w, i) => { (weeks[w.x.week] = weeks[w.x.week] || []).push(dB[i]); });
  const wk = Object.keys(weeks).sort((a, b) => a - b).map((k) => ({ week: +k, n: weeks[k].length, d_brier: r(mean(weeks[k]), 5) }));
  const sdB = sd(dB), mB = mean(dB);
  const z = R.power.alpha_two_sided_z + R.power.power_z;
  return {
    n: rows.length,
    brier: r(brierOf(ps, ys), 5), logloss: r(loglossOf(ps, ys), 5), ece: r(ece(ps, ys), 4),
    mae: r(mean(as.map((a, i) => Math.abs(a - ms_[i]))), 4), rmse: r(Math.sqrt(mean(as.map((a, i) => (a - ms_[i]) ** 2))), 4),
    bias: r(mean(as.map((a, i) => a - ms_[i])), 3),
    d_brier: r(mB, 5), d_brier_ci: [r(ciB[0], 5), r(ciB[1], 5)],
    d_logloss: r(mean(dL), 5), d_logloss_ci: [r(ciL[0], 5), r(ciL[1], 5)],
    d_mae: r(mean(dM), 4), d_mae_ci: [r(ciM[0], 4), r(ciM[1], 4)],
    weeks: wk, weeks_better: wk.filter((w) => w.d_brier < -1e-9).length, weeks_scored: wk.length,
    /* how many unseen games a real effect of this size needs to be told from
       noise at 95% / 80% power, from this sample's own per-game spread */
    games_needed: (mB < 0 && sdB > 0) ? Math.ceil(Math.pow(z * sdB / Math.abs(mB), 2)) : null,
    calibration: calibTable(ps, ys)
  };
}

function segmentKey(w, kind) {
  const x = w.x;
  if (kind === 'group') return x.group || 'unknown';
  if (kind === 'margin_bucket') { const a = Math.abs(x.model_margin); return a < 7 ? '0-7' : a < 14 ? '7-14' : a < 21 ? '14-21' : '21+'; }
  if (kind === 'favourite_side') return x.neutral ? 'neutral' : (x.model_margin >= 0 ? 'home favourite' : 'road favourite');
  if (kind === 'conference') return x.home_conf && x.home_conf === x.away_conf ? x.home_conf : 'non-conference';
  return 'all';
}
function segments(rows, ids, kind) {
  const groups = {};
  rows.forEach((w) => { const k = segmentKey(w, kind); (groups[k] = groups[k] || []).push(w); });
  return Object.keys(groups).sort().map((k) => {
    const g = groups[k], ys = g.map((w) => w.x.home_win), as = g.map((w) => w.x.actual_margin);
    const base = brierOf(g.map((w) => w.priced.BASE.p), ys), baseM = mean(g.map((w, i) => Math.abs(as[i] - w.priced.BASE.margin)));
    const o = { segment: k, n: g.length, small_sample: g.length < 30, base_brier: r(base, 4), base_mae: r(baseM, 3), d_brier: {}, d_mae: {} };
    ids.forEach((id) => {
      o.d_brier[id] = r(brierOf(g.map((w) => w.priced[id].p), ys) - base, 5);
      o.d_mae[id] = r(mean(g.map((w, i) => Math.abs(as[i] - w.priced[id].margin))) - baseM, 3);
    });
    return o;
  });
}

function decide(id, s, segs, C, consistent) {
  const R = C.promotion_rule, fails = [];
  if (!consistent) fails.push('the probability is not a function of the margin');
  if (s.n < R.min_eval_games) fails.push('scored on ' + s.n + ' unseen games; the rule needs ' + R.min_eval_games);
  if (s.weeks_scored < R.min_eval_weeks) fails.push('scored on ' + s.weeks_scored + ' weeks; the rule needs ' + R.min_eval_weeks);
  if (!(s.d_brier_ci[1] < R.brier_ci_upper_below)) fails.push('the 95% interval on the Brier change (' + s.d_brier_ci[0] + ' to ' + s.d_brier_ci[1] + ') is not entirely below zero');
  if (R.logloss_must_improve && !(s.d_logloss < 0)) fails.push('log loss does not improve (' + s.d_logloss + ')');
  if (s.d_mae > R.max_mae_worsening) fails.push('margin MAE worsens by ' + s.d_mae + ' (limit ' + R.max_mae_worsening + ')');
  if (s.weeks_scored && s.weeks_better / s.weeks_scored < R.min_share_weeks_improved) fails.push('Brier better in ' + s.weeks_better + ' of ' + s.weeks_scored + ' weeks');
  ['group', 'margin_bucket', 'favourite_side'].forEach((kind) => (segs[kind] || []).forEach((g) => {
    if (g.n >= R.min_segment_n && g.d_brier[id] > R.max_segment_brier_worsening) fails.push(kind + ' "' + g.segment + '" (n ' + g.n + ') worse by ' + g.d_brier[id] + ' Brier');
  }));
  let status;
  if (id === 'BASE') status = 'CONTROL';
  else if (!fails.length) status = 'VALIDATED';
  else if (s.d_brier < 0 && s.d_logloss < 0 && consistent) status = 'CANDIDATE';
  else if (s.d_brier > 0 && s.d_logloss > 0) status = 'REJECTED';
  else status = 'RESEARCH_ONLY';
  return { status, fails, games_needed: s.games_needed, additional_games_needed: s.games_needed != null ? Math.max(0, s.games_needed - s.n) : null };
}

/* -------------------------------------------------------- diagnostics */
function bucketOf(m) { const a = Math.abs(m); return a < 7 ? '0-7' : a < 14 ? '7-14' : a < 21 ? '14-21' : '21+'; }
function regress(name, rows, yf, xfs) {
  const f = ols(rows.map(yf), rows.map((x) => [1].concat(xfs.map((g) => g(x)))));
  return f ? { name, n: f.n, coef: f.coef.map((v) => r(v, 4)), se: f.se.map((v) => r(v, 4)), r2: r(f.r2, 4) } : { name, n: rows.length, coef: null };
}
function sigmaMleAbs(rows, mf) {
  let best = null;
  for (let s = 8; s <= 40 + 1e-9; s += 0.05) {
    let ll = 0; rows.forEach((x) => { const p = clip(normCdf(mf(x) / s)); ll += x.home_win * Math.log(p) + (1 - x.home_win) * Math.log(1 - p); });
    if (!best || ll > best.ll) best = { s, ll };
  }
  return r(best.s, 2);
}
function byBucket(rows) {
  const out = {};
  rows.forEach((x) => {
    const sg = x.model_margin >= 0 ? 1 : -1, b = bucketOf(x.model_margin);
    const o = out[b] = out[b] || { bucket: b, n: 0, e: [], ec: [], ep: [], dis: [], fav_won: 0 };
    o.n++; o.e.push(x.actual_margin * sg - Math.abs(x.model_margin));
    if (isNum(x.close_margin)) o.ec.push(x.actual_margin * sg - x.close_margin * sg);
    if (isNum(x.pub_margin)) { o.ep.push(x.actual_margin * sg - x.pub_margin * sg); o.dis.push(Math.abs(x.model_margin) - x.pub_margin * sg); }
    if (x.actual_margin * sg > 0) o.fav_won++;
  });
  return ['0-7', '7-14', '14-21', '21+'].filter((b) => out[b]).map((b) => {
    const o = out[b];
    return { bucket: b, n: o.n, small_sample: o.n < 30, model_mae: r(mean(o.e.map(Math.abs)), 2), model_bias: r(mean(o.e), 2),
      bias_se: r(sd(o.e) / Math.sqrt(o.n), 2), close_mae: r(mean(o.ec.map(Math.abs)), 2), close_bias: r(mean(o.ec), 2),
      n_publish_line: o.ep.length, publish_line_mae: o.ep.length ? r(mean(o.ep.map(Math.abs)), 2) : null,
      model_minus_publish_line: o.dis.length ? r(mean(o.dis), 2) : null, favourite_won: r(o.fav_won / o.n, 3) };
  });
}
function murphy(ps, ys) {
  const ob = mean(ys); let rel = 0, res = 0; const bins = {};
  ps.forEach((p, i) => { const b = Math.min(9, Math.floor(p * 10)); (bins[b] = bins[b] || []).push(i); });
  Object.keys(bins).forEach((b) => { const ix = bins[b]; const pm = mean(ix.map((i) => ps[i])), om = mean(ix.map((i) => ys[i])); rel += ix.length * (pm - om) ** 2; res += ix.length * (om - ob) ** 2; });
  return { reliability: r(rel / ps.length, 4), resolution: r(res / ps.length, 4), uncertainty: r(ob * (1 - ob), 4) };
}

/* a results-only rating as of each pick: if it predicts the model's error,
   the model is under-weighting this season (a stale prior). Ridge toward 0. */
function stalePriorTest(D, season) {
  const meta = {};
  const pdir = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season), 'predictions');
  if (fs.existsSync(pdir)) fs.readdirSync(pdir).filter((f) => /\.jsonl$/.test(f)).forEach((f) => readJsonl(path.join(pdir, f)).forEach((p) => {
    if (!meta[p.game_id]) meta[p.game_id] = { home: p.home_team, away: p.away_team, kickoff: p.kickoff_ts, neutral: !!p.neutral_site };
  }));
  D.rows.forEach((x) => { meta[x.game_id] = { home: x.home, away: x.away, kickoff: x.kickoff, neutral: x.neutral }; });
  const res = readJsonl(path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season), 'results.jsonl'))
    .filter((q) => q.status === 'FINAL' && meta[q.game_id]).map((q) => Object.assign({ margin: q.final_margin }, meta[q.game_id]))
    .sort((a, b) => ms(a.kickoff) - ms(b.kickoff));
  if (res.length < 100) return { available: false, why: 'fewer than 100 results in the lab ledger' };
  const teams = Array.from(new Set(res.map((g) => g.home).concat(res.map((g) => g.away)))).sort();
  const ti = {}; teams.forEach((t, i) => { ti[t] = i; });
  const n = teams.length, LAM = 2, CAP = 35, cache = {};
  function fit(t) {
    const tr = res.filter((g) => ms(g.kickoff) + 4 * 3600e3 < t);
    if (tr.length < 50) return null;
    const A = []; for (let i = 0; i <= n; i++) A.push(new Array(n + 1).fill(0));
    const b = new Array(n + 1).fill(0);
    tr.forEach((g) => {
      const y = Math.max(-CAP, Math.min(CAP, g.margin)), idx = [[ti[g.home], 1], [ti[g.away], -1]];
      if (!g.neutral) idx.push([n, 1]);
      idx.forEach(([i, vi]) => { b[i] += vi * y; idx.forEach(([j, vj]) => { A[i][j] += vi * vj; }); });
    });
    for (let i = 0; i < n; i++) A[i][i] += LAM; A[n][n] += 1e-6;
    return solve(A, b);
  }
  const pts = [];
  D.rows.filter((x) => x.fbs_fbs).forEach((x) => {
    const key = x.pick_at.slice(0, 13);
    if (!(key in cache)) cache[key] = fit(ms(x.pick_at));
    const bb = cache[key];
    if (!bb || !(x.home in ti) || !(x.away in ti)) return;
    pts.push({ x, fresh: bb[ti[x.home]] - bb[ti[x.away]] + (x.neutral ? 0 : bb[n]) });
  });
  const f = ols(pts.map((q) => q.x.actual_margin - q.x.model_margin), pts.map((q) => [1, q.fresh - q.x.model_margin]));
  return { available: true, n: pts.length, ridge_lambda: LAM,
    slope: r(f.coef[1], 3), se: r(f.se[1], 3),
    mae_model: r(mean(pts.map((q) => Math.abs(q.x.actual_margin - q.x.model_margin))), 2),
    mae_results_only: r(mean(pts.map((q) => Math.abs(q.x.actual_margin - q.fresh))), 2),
    reading: 'regression of (actual - model) on (results-only rating - model): a slope well above 0 would mean the model under-weights this season' };
}

function diagnostics(D) {
  const rows = D.rows, fbs = rows.filter((x) => x.fbs_fbs), fcs = rows.filter((x) => !x.fbs_fbs);
  const wp = rows.filter((x) => isNum(x.p_home)), pub = rows.filter((x) => isNum(x.pub_margin));
  const out = {};
  out.counts = { graded: rows.length, with_probability: wp.length, with_publish_time_line: pub.length,
    fbs_vs_fbs: fbs.length, fbs_vs_fcs: fcs.length,
    weeks: Array.from(new Set(rows.map((x) => x.week))).sort((a, b) => a - b),
    publish_line_sources: rows.reduce((o, x) => { const k = x.pub_src || 'none'; o[k] = (o[k] || 0) + 1; return o; }, {}),
    by_week: Array.from(new Set(rows.map((x) => x.week))).sort((a, b) => a - b).map((w) => {
      const g = rows.filter((x) => x.week === w), gp = g.filter((x) => isNum(x.p_home));
      return { week: w, graded: g.length, with_probability: gp.length, with_publish_time_line: g.filter((x) => isNum(x.pub_margin)).length,
        brier: gp.length ? r(brierOf(gp.map((x) => x.p_home), gp.map((x) => x.home_win)), 4) : null,
        su_correct: gp.length ? r(mean(gp.map((x) => ((x.p_home >= 0.5) === (x.home_win === 1)) ? 1 : 0)), 3) : null,
        mae: r(mean(g.map((x) => Math.abs(x.actual_margin - x.model_margin))), 2),
        close_mae: r(mean(g.map((x) => Math.abs(x.actual_margin - x.close_margin))), 2) };
    }) };
  out.sign_check = {
    corr_model_close: r(corr(rows.map((x) => x.model_margin), rows.map((x) => x.close_margin)), 3),
    corr_model_publish_line: pub.length ? r(corr(pub.map((x) => x.model_margin), pub.map((x) => x.pub_margin)), 3) : null,
    orientation_faults_vs_publish_line: pub.filter((x) => E.market.orientationFault(x.model_margin, x.pub_margin)).length,
    max_abs_publish_minus_close: pub.length ? r(Math.max.apply(null, pub.map((x) => Math.abs(x.pub_margin - x.close_margin))), 1) : null,
    note: 'margins are home margins (+ = home favoured); book lines were negated once on the way in'
  };
  out.calibration = { overall: { n: wp.length, brier: r(brierOf(wp.map((x) => x.p_home), wp.map((x) => x.home_win)), 4),
    logloss: r(loglossOf(wp.map((x) => x.p_home), wp.map((x) => x.home_win)), 4),
    su_correct: r(mean(wp.map((x) => ((x.p_home >= 0.5) === (x.home_win === 1)) ? 1 : 0)), 3) },
  table: calibTable(wp.map((x) => x.p_home), wp.map((x) => x.home_win)),
  table_fbs_vs_fbs: calibTable(wp.filter((x) => x.fbs_fbs).map((x) => x.p_home), wp.filter((x) => x.fbs_fbs).map((x) => x.home_win)) };
  out.ninety_plus = wp.filter((x) => Math.max(x.p_home, 1 - x.p_home) >= 0.9).map((x) => {
    const sg = x.p_home >= 0.5 ? 1 : -1;
    return { week: x.week, favourite: sg > 0 ? x.home : x.away, underdog: sg > 0 ? x.away : x.home, at_home: !x.neutral && sg > 0,
      group: x.group, p_fav: r(Math.max(x.p_home, 1 - x.p_home), 3), model_margin: r(Math.abs(x.model_margin), 2),
      publish_line: isNum(x.pub_margin) ? r(x.pub_margin * sg, 1) : null, close: r(x.close_margin * sg, 1), actual: x.actual_margin * sg, won: x.actual_margin * sg > 0 };
  });
  out.regressions = [
    regress('actual ~ model  (all)', rows, (x) => x.actual_margin, [(x) => x.model_margin]),
    regress('actual ~ model  (FBS vs FBS)', fbs, (x) => x.actual_margin, [(x) => x.model_margin]),
    regress('actual ~ model  (FBS vs FCS)', fcs, (x) => x.actual_margin, [(x) => x.model_margin]),
    regress('actual ~ close  (all, benchmark)', rows, (x) => x.actual_margin, [(x) => x.close_margin]),
    regress('actual ~ close  (FBS vs FBS, benchmark)', fbs, (x) => x.actual_margin, [(x) => x.close_margin]),
    regress('actual ~ publish-time line', pub, (x) => x.actual_margin, [(x) => x.pub_margin]),
    regress('(actual - publish line) ~ (model - publish line)', pub, (x) => x.actual_margin - x.pub_margin, [(x) => x.model_margin - x.pub_margin]),
    regress('actual ~ publish line + (model - publish line)', pub, (x) => x.actual_margin, [(x) => x.pub_margin, (x) => x.model_margin - x.pub_margin]),
    regress('(close - publish line) ~ (model - publish line)  [line movement]', pub, (x) => x.close_margin - x.pub_margin, [(x) => x.model_margin - x.pub_margin]),
    regress('model ~ close  (FBS vs FBS, non-neutral: constant = home-field excess, slope = stretch)', fbs.filter((x) => !x.neutral), (x) => x.model_margin, [(x) => x.close_margin])
  ];
  out.margin_buckets = { all: byBucket(rows), fbs_vs_fbs: byBucket(fbs), fbs_vs_fcs: byBucket(fcs), with_publish_time_line: byBucket(pub),
    note: 'favourite perspective (the model’s favourite); bias = actual - predicted, negative = the favourite did worse than projected' };
  const wv = wp.filter((x) => x.fbs_fbs), res = (a, f) => a.map((x) => x.actual_margin - f(x));
  out.sigma = {
    how: 'P(home) = Phi(fair_spread / sigma); sigma = sigma_base x (1 + lambda x early_season), clamped to [sigma_floor, sigma_ceiling] (engine.js uncertainty.volatility)',
    params: { sigma_base: P.volatility.sigma_base, sigma_floor: P.volatility.sigma_floor, sigma_ceiling: P.volatility.sigma_ceiling, lambda: P.volatility.lambda },
    implied_from_published: { n: D.implied_sigma.length, median: r(median(D.implied_sigma), 3), p05: r(pct(D.implied_sigma, 0.05), 3), p95: r(pct(D.implied_sigma, 0.95), 3) },
    best_fit: {
      all_with_probability: { n: wp.length, mle_sigma: sigmaMleAbs(wp, (x) => x.model_margin), residual_sd: r(sd(res(wp, (x) => x.model_margin)), 2) },
      fbs_vs_fbs: { n: wv.length, mle_sigma: sigmaMleAbs(wv, (x) => x.model_margin), residual_sd: r(sd(res(wv, (x) => x.model_margin)), 2) },
      close_line_benchmark: { n: wp.length, mle_sigma: sigmaMleAbs(wp, (x) => x.close_margin), residual_sd: r(sd(res(wp, (x) => x.close_margin)), 2) }
    },
    brier_by_sigma: [14.85, 16, 17, 18, 20].map((s) => ({ sigma: s, brier: r(brierOf(wp.map((x) => normCdf(x.model_margin / s)), wp.map((x) => x.home_win)), 4) }))
  };
  const cn = wp.filter((x) => isNum(x.close_nv)), pn = wp.filter((x) => isNum(x.pub_nv));
  out.market = {
    close_no_vig: { n: cn.length, model_brier: r(brierOf(cn.map((x) => x.p_home), cn.map((x) => x.home_win)), 4), market_brier: r(brierOf(cn.map((x) => x.close_nv), cn.map((x) => x.home_win)), 4),
      model_logloss: r(loglossOf(cn.map((x) => x.p_home), cn.map((x) => x.home_win)), 4), market_logloss: r(loglossOf(cn.map((x) => x.close_nv), cn.map((x) => x.home_win)), 4),
      model_murphy: murphy(cn.map((x) => x.p_home), cn.map((x) => x.home_win)), market_murphy: murphy(cn.map((x) => x.close_nv), cn.map((x) => x.home_win)),
      market_calibration: calibTable(cn.map((x) => x.close_nv), cn.map((x) => x.home_win)), note: 'the close is a benchmark only; it is never an input' },
    publish_time_no_vig: { n: pn.length, model_brier: r(brierOf(pn.map((x) => x.p_home), pn.map((x) => x.home_win)), 4), market_brier: r(brierOf(pn.map((x) => x.pub_nv), pn.map((x) => x.home_win)), 4),
      model_logloss: r(loglossOf(pn.map((x) => x.p_home), pn.map((x) => x.home_win)), 4), market_logloss: r(loglossOf(pn.map((x) => x.pub_nv), pn.map((x) => x.home_win)), 4) },
    margin_mae: { n: rows.length, model: r(mean(rows.map((x) => Math.abs(x.actual_margin - x.model_margin))), 3), close: r(mean(rows.map((x) => Math.abs(x.actual_margin - x.close_margin))), 3),
      fbs_vs_fbs_model: r(mean(fbs.map((x) => Math.abs(x.actual_margin - x.model_margin))), 3), fbs_vs_fbs_close: r(mean(fbs.map((x) => Math.abs(x.actual_margin - x.close_margin))), 3),
      fbs_vs_fcs_model: r(mean(fcs.map((x) => Math.abs(x.actual_margin - x.model_margin))), 3), fbs_vs_fcs_close: r(mean(fcs.map((x) => Math.abs(x.actual_margin - x.close_margin))), 3),
      publish_subset_n: pub.length, publish_subset_model: r(mean(pub.map((x) => Math.abs(x.actual_margin - x.model_margin))), 3),
      publish_subset_line: r(mean(pub.map((x) => Math.abs(x.actual_margin - x.pub_margin))), 3), publish_subset_close: r(mean(pub.map((x) => Math.abs(x.actual_margin - x.close_margin))), 3) }
  };
  const pw = pub.filter((x) => isNum(x.p_home));
  const segs = [['model less bullish by 3+', -99, -3], ['within 3', -3, 3], ['model more bullish 3-7', 3, 7], ['model more bullish 7+', 7, 99]];
  out.disagreement = segs.map(([label, lo, hi]) => {
    const g = pw.filter((x) => { const sg = x.model_margin >= 0 ? 1 : -1, d = (x.model_margin - x.pub_margin) * sg; return d >= lo && d < hi; });
    if (!g.length) return { segment: label, n: 0 };
    const fav = g.map((x) => favView(x.p_home, x.home_win)), sg = (x) => (x.model_margin >= 0 ? 1 : -1);
    const mk = g.map((x) => (sg(x) > 0 ? normCdf(x.pub_margin / 15.4) : 1 - normCdf(x.pub_margin / 15.4)));
    const kWon = fav.reduce((s, f) => s + f[1], 0), wl = wilson(kWon, g.length);
    return { segment: label, n: g.length, small_sample: g.length < 30, model_p_fav: r(mean(fav.map((f) => f[0])), 3), market_p_fav: r(mean(mk), 3),
      favourite_won: r(kWon / g.length, 3), favourite_won_ci: [r(wl[0], 3), r(wl[1], 3)],
      model_brier: r(brierOf(fav.map((f) => f[0]), fav.map((f) => f[1])), 4), market_brier: r(brierOf(mk, fav.map((f) => f[1])), 4),
      fav_margin_vs_model: r(mean(g.map((x) => x.actual_margin * sg(x) - Math.abs(x.model_margin))), 2), fav_margin_vs_market: r(mean(g.map((x) => (x.actual_margin - x.pub_margin) * sg(x))), 2) };
  });
  const hm = fbs.filter((x) => !x.neutral);
  const side = (lab, f) => { const g = hm.filter(f); const sg = (x) => (x.model_margin >= 0 ? 1 : -1);
    const e = g.map((x) => x.actual_margin * sg(x) - Math.abs(x.model_margin));
    return { side: lab, n: g.length, model_minus_close: r(mean(g.map((x) => (x.model_margin - x.close_margin) * sg(x))), 2),
      actual_minus_model: r(mean(e), 2), se: r(sd(e) / Math.sqrt(g.length), 2), actual_minus_close: r(mean(g.map((x) => (x.actual_margin - x.close_margin) * sg(x))), 2) }; };
  const hw = hm.filter((x) => isNum(x.p_home));
  out.home_field = {
    applied_in_projection: P.venue.league_hfa, learned_in_rating_recursion: P.rating.hyperparams.hfa,
    fitted_on_2015_2025_final_margins: 2.582,
    favourite_side: [side('home favourite', (x) => x.model_margin >= 0), side('road favourite', (x) => x.model_margin < 0)],
    home_team_win_rate: { n: hw.length, model_mean_p_home: r(mean(hw.map((x) => x.p_home)), 3), actual: r(mean(hw.map((x) => x.home_win)), 3),
      close_no_vig_mean: r(mean(hw.filter((x) => isNum(x.close_nv)).map((x) => x.close_nv)), 3) },
    excess_vs_close_by_week: Array.from(new Set(hm.map((x) => x.week))).sort((a, b) => a - b).map((w) => {
      const g = hm.filter((x) => x.week === w), d = g.map((x) => x.model_margin - x.close_margin);
      return { week: w, n: g.length, model_minus_close: r(mean(d), 2), se: r(sd(d) / Math.sqrt(g.length), 2) };
    })
  };
  const tt = rows.filter((x) => isNum(x.model_total) && isNum(x.close_total));
  const te = tt.map((x) => x.actual_total - x.model_total);
  out.totals = { n: tt.length, model_mae: r(mean(te.map(Math.abs)), 2), bias_actual_minus_model: r(mean(te), 2), bias_se: r(sd(te) / Math.sqrt(tt.length), 2),
    close_mae: r(mean(tt.map((x) => Math.abs(x.actual_total - x.close_total))), 2), close_bias: r(mean(tt.map((x) => x.actual_total - x.close_total)), 2),
    regression: regress('actual total ~ model total', tt, (x) => x.actual_total, [(x) => x.model_total]),
    note: 'FBS-vs-FCS games carry no closing total and are not in this comparison' };
  out.stale_prior = stalePriorTest(D, D.season);
  return out;
}
function corr(a, b) { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); }

/* fitted on every graded FBS-vs-FBS game to date: what the shadow would run
   with next week if the season's own estimate were chosen over the prior */
function seasonFit(D, C) {
  const train = D.rows.filter((x) => x.fbs_fbs);
  const F = fitAll(train, C);
  const pick = (o) => { const c = Object.assign({}, o); delete c._fit; return c; };
  const g = blendFit(train, { k: 1, h: null }, 'global', C.walk_forward.min_train_market);
  const dis = blendFit(train, { k: 1, h: null }, 'disagree', C.walk_forward.min_train_market);
  const size = blendFit(train, { k: 1, h: null }, 'size', C.walk_forward.min_train_market);
  const hg = train.filter((x) => x.is_home === 1), he = hg.map((x) => x.actual_margin - (x.model_margin - x.applied_hfa));
  const kj = ols(train.map((x) => x.actual_margin), train.map((x) => [x.model_margin - x.applied_hfa, x.is_home]));
  return {
    n: train.length, n_with_probability: F.n_p, n_with_publish_line: train.filter((x) => isNum(x.pub_margin)).length,
    k: { value: r(F.K.k, 4), what: 'actual = k x model, least squares through the origin' },
    home_field: { value: r(F.HFA_WF.h, 3), se: r(sd(he) / Math.sqrt(hg.length), 3), what: 'actual = model - applied home field + h, home games' },
    k_and_home_field_jointly: kj ? { k: r(kj.coef[0], 4), k_se: r(kj.se[0], 4), h: r(kj.coef[1], 3), h_se: r(kj.se[1], 3), what: 'actual = k x (model - applied home field) + h x home' } : null,
    sigma_scale: { value: F.SIGMA.sigma_scale || 1, what: 'maximum-likelihood scale on the engine sigma, win/loss outcomes' },
    blend: g ? { w: r(g.w, 4), w_unclamped: r(g.w_unclamped, 4), se: r(g.se, 4), n: g.n,
      w_by_disagreement: dis ? { w0: r(dis.w0, 4), w1_per_10_points: r(dis.w1, 4), se1: r(dis.se1, 4) } : null,
      w_by_margin_size: size ? { w0: r(size.w0, 4), w1_per_10_points: r(size.w1, 4), se1: r(size.se1, 4) } : null,
      what: 'adjusted = w x model + (1 - w) x the line observed at publication; w is the MODEL weight' } : null,
    probit: F.PLATT.probit_a ? { a: r(F.PLATT.probit_a, 4), b: r(F.PLATT.probit_b, 4), what: 'P = Phi(a x margin/sigma + b): a > 1 sharpens, a < 1 softens' } : null,
    options: Object.keys(F).filter((k) => typeof F[k] === 'object' && F[k] && k !== 'ISOTONIC').reduce((o, k) => { o[k] = pick(F[k]); return o; }, {})
  };
}

/* ------------------------------------------------------------- output */
function mdTable(rows, cols) {
  const h = '| ' + cols.map((c) => c[0]).join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n';
  return h + rows.map((x) => '| ' + cols.map((c) => { const v = typeof c[1] === 'function' ? c[1](x) : x[c[1]]; return v == null ? '—' : String(v); }).join(' | ') + ' |').join('\n') + '\n';
}
function writeJs(file, name, obj, title) {
  const body = 'if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n'
    + '/* ' + title + ' GENERATED FILE — produced by\n   football/cfb_p4/research/live_calibration.js --write; never edit by hand.\n'
    + '   The switch and the rule live in football/cfb_p4/live_calibration_config.json. */\n'
    + 'window.' + name + ' = ' + JSON.stringify(obj) + ';\n'
    + 'if(typeof module!==\'undefined\'&&module.exports){module.exports=window.' + name + ';}\n';
  fs.writeFileSync(file, body);
}

function run(argv) {
  const a = { write: false, season: null, now: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--write') a.write = true;
    else if (argv[i] === '--season') a.season = Number(argv[++i]);
    else if (argv[i] === '--now') a.now = argv[++i];
    else throw new Error('unknown option ' + argv[i]);
  }
  const C = readJson(CONFIG_FILE);
  const season = a.season || (P.trained_through_season + 1);
  const D = buildDataset(season); D.season = season;
  const diag = diagnostics(D);
  const wf = walkForward(D, C);
  const ids = OPTIONS.map((o) => o.id);
  const subsets = {
    all: wf,
    fbs_vs_fbs: wf.filter((w) => w.x.fbs_fbs),
    blend_active: wf.filter((w) => w.priced.BLEND.blend_used)
  };
  const results = {};
  Object.keys(subsets).forEach((k) => { results[k] = {}; ids.forEach((id) => { results[k][id] = subsets[k].length ? score(subsets[k], id, C) : null; }); });
  const segs = {};
  ['week', 'group', 'margin_bucket', 'favourite_side', 'conference'].forEach((kind) => {
    segs[kind] = kind === 'week'
      ? results.all.BASE.weeks.map((w) => ({ segment: String(w.week), n: w.n }))
      : segments(wf, ids, kind);
  });
  const decisions = {};
  OPTIONS.forEach((o) => { decisions[o.id] = decide(o.id, results.all[o.id], segs, C, o.id !== 'ISOTONIC'); });
  const bench = (rows) => {
    const cl = rows.filter((w) => isNum(w.x.close_margin)), pl = rows.filter((w) => isNum(w.x.pub_margin)), cn = rows.filter((w) => isNum(w.x.close_nv));
    return { n: rows.length, close_mae: r(mean(cl.map((w) => Math.abs(w.x.actual_margin - w.x.close_margin))), 3),
      publish_line_n: pl.length, publish_line_mae: r(mean(pl.map((w) => Math.abs(w.x.actual_margin - w.x.pub_margin))), 3),
      base_mae_on_publish_subset: r(mean(pl.map((w) => Math.abs(w.x.actual_margin - w.x.model_margin))), 3),
      close_no_vig_n: cn.length, close_no_vig_brier: r(brierOf(cn.map((w) => w.x.close_nv), cn.map((w) => w.x.home_win)), 4),
      close_no_vig_logloss: r(loglossOf(cn.map((w) => w.x.close_nv), cn.map((w) => w.x.home_win)), 4),
      base_brier_on_close_subset: r(brierOf(cn.map((w) => w.x.p_home), cn.map((w) => w.x.home_win)), 4) };
  };
  const benchmarks = { all: bench(subsets.all), fbs_vs_fbs: bench(subsets.fbs_vs_fbs), blend_active: bench(subsets.blend_active) };
  const fitsByWeek = Array.from(new Set(wf.map((w) => w.x.week))).sort((x, y) => x - y).map((wk) => {
    const w = wf.find((q) => q.x.week === wk && q.x.fbs_fbs) || wf.find((q) => q.x.week === wk);
    const F = w.fit;
    return { week: wk, first_pick_at: w.x.pick_at, train_games: F.n, train_probabilities: F.n_p, k: r(F.K.k, 4), h: r(F.HFA_WF.h, 3),
      sigma_scale: F.SIGMA.sigma_scale || null, blend_w: F.BLEND.blend ? r(F.BLEND.blend.w, 4) : null,
      probit_a: F.PLATT.probit_a ? r(F.PLATT.probit_a, 3) : null, probit_b: F.PLATT.probit_b != null ? r(F.PLATT.probit_b, 3) : null };
  });
  const sfit = seasonFit(D, C);
  const cand = C.candidate, cd = decisions[cand], cs = results.all[cand];
  const promoted = C.promote === true && cd.status === 'VALIDATED';
  const now = a.now || new Date().toISOString();
  const candParams = Object.assign({ k: null, h: null, league_hfa: P.venue.league_hfa, sigma_scale: 1, probit_a: null, probit_b: null, p_cap: C.guardrail.p_cap, blend: null },
    sfit.options[cand] ? (function (o) { const c = Object.assign({}, o); return c; })(sfit.options[cand]) : {});
  if (cand.indexOf('HFA_PRE') === 0) { candParams.k = C.prior.k; candParams.h = C.prior.h; candParams.league_hfa = C.prior.league_hfa; }
  if (!C.blend.enabled) candParams.blend = null;
  if (!isNum(candParams.p_cap)) candParams.p_cap = C.guardrail.p_cap;

  const generated = {
    schema: 'edgedesk_cfb_live_calibration_v1',
    calibration_version: C.calibration_version,
    generated_at: now,
    generated_by: 'football/cfb_p4/research/live_calibration.js',
    data_through: D.record_updated_at,
    base_model_version: C.base_model_version,
    model_version_if_promoted: C.model_version_if_promoted,
    candidate: cand,
    params: candParams,
    status: cd.status,
    promoted,
    promotion: { switch: C.promote === true, rule_passed: cd.status === 'VALIDATED', fails: cd.fails,
      games_needed: cd.games_needed, additional_games_needed: cd.additional_games_needed,
      rule: 'football/cfb_p4/live_calibration_config.json promotion_rule' },
    record: { n: cs.n, weeks: cs.weeks_scored, brier_base: results.all.BASE.brier, brier: cs.brier, d_brier: cs.d_brier, d_brier_ci: cs.d_brier_ci,
      d_logloss: cs.d_logloss, mae_base: results.all.BASE.mae, mae: cs.mae, d_mae: cs.d_mae, d_mae_ci: cs.d_mae_ci, weeks_better: cs.weeks_better + '/' + cs.weeks_scored },
    decision: promoted
      ? 'PROMOTED: the switch is on and the walk-forward record passed every condition. New projections are priced from this calibration under ' + C.model_version_if_promoted + '; every number published before this file changed stays exactly as it was shown.'
      : 'SHADOW: ' + cand + ' is published beside the priced number and changes nothing. ' + (cd.status === 'VALIDATED'
        ? 'Its record passes the rule; promotion waits for a person to flip the switch.'
        : 'Status ' + cd.status + ' — ' + cd.fails.join('; ') + '.'),
    evidence: 'football/validation/cfb_live_calibration.json'
  };
  const report = {
    schema: 'edgedesk_cfb_live_calibration_report_v1', generated_at: now, data_through: D.record_updated_at, season,
    source: { record: 'record/football/cfb_' + season + '.json', quotes: ['record/football/quotes/cfb_' + season + '.jsonl', 'football/cfb_lab/ledger/' + season + '/quotes/*.jsonl'],
      model: D.model, immutability: 'read only: the record, the quote ledgers and every published number are untouched by this script' },
    config: C,
    diagnostics: diag,
    walk_forward: { design: C.walk_forward, fits_by_week: fitsByWeek, options: OPTIONS, benchmarks, results, segments: segs, decisions },
    season_fit: sfit,
    generated
  };
  return { generated, report, results, decisions, diag, benchmarks, segs, fitsByWeek, sfit, C };
}

function markdown(o) {
  const { report, results, decisions, diag, benchmarks, segs, fitsByWeek, sfit, C, generated } = o;
  const L = [];
  L.push('# CFB live calibration — walk-forward record');
  L.push('');
  L.push('GENERATED by `football/cfb_p4/research/live_calibration.js --write` from `' + report.source.record + '` (data through ' + report.data_through + '). Never edit by hand. The narrative is `docs/cfb-calibration/README.md`.');
  L.push('');
  L.push('**Decision:** ' + generated.decision);
  L.push('');
  L.push('## Data');
  L.push('');
  L.push(mdTable(diag.counts.by_week, [['week', 'week'], ['graded', 'graded'], ['with prob', 'with_probability'], ['line known at publish', 'with_publish_time_line'], ['Brier', 'brier'], ['SU', 'su_correct'], ['model MAE', 'mae'], ['close MAE', 'close_mae']]));
  L.push('## 1. Calibration of the published probability (all graded games with one)');
  L.push('');
  L.push('n ' + diag.calibration.overall.n + ' · Brier ' + diag.calibration.overall.brier + ' · log loss ' + diag.calibration.overall.logloss + ' · straight-up ' + diag.calibration.overall.su_correct + '. Favourite perspective; buckets under 30 games are flagged.');
  L.push('');
  L.push(mdTable(diag.calibration.table, [['bucket', 'bucket'], ['n', 'n'], ['avg predicted', 'avg_pred'], ['actual', 'actual'], ['95% CI', (x) => x.n ? x.wilson_lo + '–' + x.wilson_hi : null], ['Brier', 'brier'], ['small n', (x) => x.small_sample ? 'yes' : '']]));
  L.push('## 2. Margin compression and the market');
  L.push('');
  L.push(mdTable(diag.regressions, [['regression', 'name'], ['n', 'n'], ['coefficients (se)', (x) => x.coef ? x.coef.map((c, i) => c + ' (' + x.se[i] + ')').join(' · ') : null], ['R²', 'r2']]));
  L.push('## 3. Error by size of predicted margin (favourite perspective)');
  L.push('');
  [['All', 'all'], ['FBS vs FBS', 'fbs_vs_fbs'], ['FBS vs FCS', 'fbs_vs_fcs'], ['Line known at publish', 'with_publish_time_line']].forEach(([t, k]) => {
    L.push('**' + t + '**'); L.push('');
    L.push(mdTable(diag.margin_buckets[k], [['bucket', 'bucket'], ['n', 'n'], ['model MAE', 'model_mae'], ['bias (se)', (x) => x.model_bias + ' (' + x.bias_se + ')'], ['close MAE', 'close_mae'], ['close bias', 'close_bias'], ['model − publish line', 'model_minus_publish_line'], ['fav won', 'favourite_won']]));
  });
  L.push('## 4. Sigma');
  L.push('');
  L.push(diag.sigma.how + '. Implied from the published pairs: median ' + diag.sigma.implied_from_published.median + ' (5–95%: ' + diag.sigma.implied_from_published.p05 + '–' + diag.sigma.implied_from_published.p95 + ', n ' + diag.sigma.implied_from_published.n + ').');
  L.push('');
  L.push(mdTable(Object.keys(diag.sigma.best_fit).map((k) => Object.assign({ set: k }, diag.sigma.best_fit[k])), [['set', 'set'], ['n', 'n'], ['MLE sigma (win/loss)', 'mle_sigma'], ['residual SD', 'residual_sd']]));
  L.push(mdTable(diag.sigma.brier_by_sigma, [['sigma', 'sigma'], ['Brier', 'brier']]));
  L.push('## 5. Against the market');
  L.push('');
  const cn = diag.market.close_no_vig, pn = diag.market.publish_time_no_vig, mm = diag.market.margin_mae;
  L.push('- No-vig closing moneyline (benchmark only), same ' + cn.n + ' games: model Brier ' + cn.model_brier + ' vs market ' + cn.market_brier + '; log loss ' + cn.model_logloss + ' vs ' + cn.market_logloss + '. Murphy reliability ' + cn.model_murphy.reliability + ' vs ' + cn.market_murphy.reliability + ', resolution ' + cn.model_murphy.resolution + ' vs ' + cn.market_murphy.resolution + '.');
  L.push('- No-vig moneyline observed at publication, same ' + pn.n + ' games: model Brier ' + pn.model_brier + ' vs market ' + pn.market_brier + '.');
  L.push('- Margin MAE, all ' + mm.n + ': model ' + mm.model + ' vs close ' + mm.close + ' · FBS vs FBS ' + mm.fbs_vs_fbs_model + ' vs ' + mm.fbs_vs_fbs_close + ' · FBS vs FCS ' + mm.fbs_vs_fcs_model + ' vs ' + mm.fbs_vs_fcs_close + ' · with a publish-time line (' + mm.publish_subset_n + '): model ' + mm.publish_subset_model + ', that line ' + mm.publish_subset_line + ', close ' + mm.publish_subset_close + '.');
  L.push('');
  L.push('**Disagreement with the line observed at publication**');
  L.push('');
  L.push(mdTable(diag.disagreement, [['segment', 'segment'], ['n', 'n'], ['model P(fav)', 'model_p_fav'], ['market P(fav)', 'market_p_fav'], ['fav won (95% CI)', (x) => x.n ? x.favourite_won + ' (' + x.favourite_won_ci.join('–') + ')' : null], ['fav vs model', 'fav_margin_vs_model'], ['fav vs market', 'fav_margin_vs_market'], ['small n', (x) => x.small_sample ? 'yes' : '']]));
  L.push('## 6. Home field');
  L.push('');
  L.push('Applied in every projection: ' + diag.home_field.applied_in_projection + ' · learned in the rating recursion: ' + diag.home_field.learned_in_rating_recursion + ' · fitted on 2015–2025 final margins: ' + diag.home_field.fitted_on_2015_2025_final_margins + '. Home teams (FBS vs FBS): model mean P ' + diag.home_field.home_team_win_rate.model_mean_p_home + ', actual ' + diag.home_field.home_team_win_rate.actual + ', no-vig close ' + diag.home_field.home_team_win_rate.close_no_vig_mean + ' (n ' + diag.home_field.home_team_win_rate.n + ').');
  L.push('');
  L.push(mdTable(diag.home_field.favourite_side, [['side', 'side'], ['n', 'n'], ['model − close', 'model_minus_close'], ['actual − model (se)', (x) => x.actual_minus_model + ' (' + x.se + ')'], ['actual − close', 'actual_minus_close']]));
  L.push(mdTable(diag.home_field.excess_vs_close_by_week, [['week', 'week'], ['n', 'n'], ['model − close (home)', 'model_minus_close'], ['se', 'se']]));
  L.push('## 7. Totals and the stale-prior check');
  L.push('');
  const t = diag.totals, sp = diag.stale_prior;
  L.push('- Totals (' + t.n + '): model MAE ' + t.model_mae + ', bias ' + t.bias_actual_minus_model + ' (se ' + t.bias_se + '); close MAE ' + t.close_mae + ', bias ' + t.close_bias + '. Slope ' + t.regression.coef[1] + ' (se ' + t.regression.se[1] + ').');
  if (sp.available) L.push('- Results-only in-season rating vs the model (' + sp.n + ' FBS games): slope ' + sp.slope + ' (se ' + sp.se + '). ' + sp.reading + '.');
  L.push('');
  L.push('## 8. Walk-forward: every option on the same unseen games');
  L.push('');
  L.push('Scored from week ' + C.walk_forward.eval_from_week + '. Parameters for each game were fitted on FBS-vs-FBS games whose final was known before its pick was published; FBS-vs-FCS games keep the published number in every option but the cap.');
  L.push('');
  L.push(mdTable(fitsByWeek, [['week', 'week'], ['train games', 'train_games'], ['train probs', 'train_probabilities'], ['k', 'k'], ['h', 'h'], ['sigma scale', 'sigma_scale'], ['blend w', 'blend_w'], ['probit a', 'probit_a'], ['probit b', 'probit_b']]));
  [['All scored games', 'all'], ['FBS vs FBS', 'fbs_vs_fbs'], ['Where the publish-time blend was active', 'blend_active']].forEach(([title, k]) => {
    const b = benchmarks[k];
    L.push('### ' + title + ' (n ' + b.n + ')');
    L.push('');
    L.push('Benchmarks on the same games: close MAE ' + b.close_mae + ' · line at publication MAE ' + b.publish_line_mae + ' (n ' + b.publish_line_n + '; current model on those ' + b.base_mae_on_publish_subset + ') · no-vig close Brier ' + b.close_no_vig_brier + ' (current model on those ' + b.base_brier_on_close_subset + ').');
    L.push('');
    L.push(mdTable(OPTIONS.map((op) => Object.assign({ id: op.id }, results[k][op.id])), [['option', 'id'], ['Brier', 'brier'], ['log loss', 'logloss'], ['ECE', 'ece'], ['MAE', 'mae'], ['bias', 'bias'], ['ΔBrier (95% CI)', (x) => x.d_brier + ' (' + x.d_brier_ci.join(' to ') + ')'], ['Δlog loss', 'd_logloss'], ['ΔMAE (95% CI)', (x) => x.d_mae + ' (' + x.d_mae_ci.join(' to ') + ')'], ['weeks better', (x) => x.weeks_better + '/' + x.weeks_scored]]));
  });
  L.push('### Decisions');
  L.push('');
  L.push(mdTable(OPTIONS.map((op) => Object.assign({ id: op.id, label: op.label }, decisions[op.id])), [['option', 'id'], ['what', 'label'], ['status', 'status'], ['unseen games a real effect this size needs', 'games_needed'], ['why not validated', (x) => x.fails.length ? x.fails.slice(0, 3).join('; ') + (x.fails.length > 3 ? '; …' : '') : '']]));
  L.push('### Stability (ΔBrier vs the current model)');
  L.push('');
  const show = ['HFA_PRE', 'HFA_WF', 'K', 'SIGMA', 'BLEND', 'BLEND_DIS', 'PLATT', 'CAP95'];
  ['group', 'margin_bucket', 'favourite_side', 'conference'].forEach((kind) => {
    L.push('**' + kind + '**'); L.push('');
    L.push(mdTable(segs[kind], [['segment', 'segment'], ['n', 'n'], ['base Brier', 'base_brier']].concat(show.map((id) => [id, (x) => x.d_brier[id]])).concat([['small n', (x) => x.small_sample ? 'yes' : '']])));
  });
  L.push('**week**'); L.push('');
  const wkRows = results.all.BASE.weeks.map((w) => { const o = { week: w.week, n: w.n }; show.forEach((id) => { o[id] = (results.all[id].weeks.find((q) => q.week === w.week) || {}).d_brier; }); return o; });
  L.push(mdTable(wkRows, [['week', 'week'], ['n', 'n']].concat(show.map((id) => [id, id]))));
  L.push('### Calibration of each option (scored games)');
  L.push('');
  ['BASE', 'HFA_PRE', 'SIGMA', 'K', 'BLEND', 'PLATT', 'CAP95'].forEach((id) => {
    L.push('**' + id + '**'); L.push('');
    L.push(mdTable(results.all[id].calibration, [['bucket', 'bucket'], ['n', 'n'], ['avg predicted', 'avg_pred'], ['actual', 'actual'], ['95% CI', (x) => x.n ? x.wilson_lo + '–' + x.wilson_hi : null], ['Brier', 'brier'], ['small n', (x) => x.small_sample ? 'yes' : '']]));
  });
  L.push('## 9. Fitted on every graded FBS-vs-FBS game to date');
  L.push('');
  L.push('```json');
  const s2 = Object.assign({}, sfit); delete s2.options;
  L.push(JSON.stringify(s2, null, 1));
  L.push('```');
  L.push('');
  return L.join('\n');
}

if (require.main === module) {
  const o = run(process.argv);
  const g = o.generated;
  console.error('[livecal] ' + o.diag.counts.graded + ' graded · ' + o.results.all.BASE.n + ' scored walk-forward · candidate ' + g.candidate + ' ' + g.status + ' · promoted ' + g.promoted);
  OPTIONS.forEach((op) => { const s = o.results.all[op.id]; console.error('  ' + op.id.padEnd(15) + ' Brier ' + s.brier + ' (Δ ' + s.d_brier + ' [' + s.d_brier_ci.join(', ') + '])  LL ' + s.logloss + '  MAE ' + s.mae + ' (Δ ' + s.d_mae + ')  weeks ' + s.weeks_better + '/' + s.weeks_scored + '  ' + o.decisions[op.id].status); });
  console.error('[livecal] ' + g.decision);
  if (process.argv.indexOf('--write') >= 0) {
    writeJs(OUT_JS, 'EDCfbP4LiveCalibration', g, 'EdgeDesk CFB live calibration (shadow unless promoted).');
    fs.writeFileSync(OUT_JSON, JSON.stringify(o.report, null, 1) + '\n');
    fs.writeFileSync(OUT_MD, markdown(o));
    console.error('[write] ' + [OUT_JS, OUT_JSON, OUT_MD].map((f) => path.relative(ROOT, f)).join(', '));
  }
}

module.exports = { run, buildDataset, walkForward, fitAll, priceWith, decide, marginOfBookLine, noVig, quoteLedgers, latestAtOrBefore, OPTIONS, markdown };
