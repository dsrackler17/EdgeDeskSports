'use strict';
/* ===========================================================================
   NFL v2 WALK-FORWARD BACKTEST (preregistration.json).

   One configuration of football/nfl_model.js is replayed over every game
   1999-2026, pregame: each game's features come from the rating state before
   it, then the game is absorbed exactly as the live board absorbs it. For each
   season S from 2006 the ridge weights (strength, context, total), the margin
   PMF the probabilities are read from, and any calibration are fitted on
   seasons before S only, and S is predicted. 2010-2024 is the validation
   window; 2025 is the holdout; 2026 to date is reported and never used.

   The baseline is the closing line: the closing consensus spread as the margin
   forecast, de-vigged closing moneylines as the win probability.

   "served" emulates what the board actually ran before the parity fix:
   features from a state that, inside the season being predicted, never moved
   a defensive rating or a quarterback value, scored with weights fitted on the
   correct features (as training produced them) and a Normal(margin, 10.7)
   win probability.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const D = require('./data.js');
const PARAMS = globalThis.EDFootballParams;

const FIRST_TRAIN = 2002, FIRST_PRED = 2006, VALID = [2010, 2024], HOLDOUT = 2025, LIVE = 2026;
const PMF_BW = 3;

/* ------------------------------------------------------------ replay */
function gameObj(g) {
  return { season: g.season, week: g.week, home: g.home, away: g.away, home_rest: g.home_rest, away_rest: g.away_rest,
    roof: g.roof, surface: g.surface, div_game: g.div_game, temp: g.temp, wind: g.wind,
    home_qb_id: g.home_qb_id, away_qb_id: g.away_qb_id, neutral: g.neutral, travel: g.travel,
    close_home_margin: g.close_home_margin, home_score: g.home_score, away_score: g.away_score };
}
function vec(obj, names) { const v = new Array(names.length); for (let i = 0; i < names.length; i++) { const x = obj[names[i]]; v[i] = Number.isFinite(x) ? x : 0; } return v; }

/* opts.served: emulate the pre-fix board inside each predicted season */
function replay(cfg, opts) {
  opts = opts || {};
  const names = M.featureNames(cfg);
  const st = M.newState(cfg);
  if (cfg.personnel.on) st.personnel = D.personnel();
  const rows = D.teamRows(cfg.source), qb = D.qbRows(), out = [];
  const snaps = {};
  for (const g of D.games()) {
    if (!g.done) continue;
    if (st.season !== g.season) { M.seasonBreak(st, g.season); if (opts.served && g.season >= FIRST_PRED) snaps[g.season] = JSON.stringify(st); }
    if (g.season >= FIRST_TRAIN) {
      const F = M.features(st, gameObj(g));
      out.push({ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa,
        prior: vec(F.prior, names.spread) });
    }
    const gg = { home_team: g.home_raw, away_team: g.away_raw, home_score: g.home_score, away_score: g.away_score };
    M.absorbCompleted(st, gg, rows[g.id] || [], qb[g.id] || []);
    M.afterGame(st, gameObj(g));
  }
  const res = { cfg, names, rows: out, state: st };
  if (opts.served) res.served = servedRows(cfg, names, snaps, rows);
  return res;
}
/* the pre-fix board: offence-only rows (home first), no quarterback starts, inside the season */
function servedRows(cfg, names, snaps, rows) {
  const out = {};
  const bySeason = {};
  for (const g of D.games()) if (g.done && snaps[g.season]) (bySeason[g.season] = bySeason[g.season] || []).push(g);
  for (const S of Object.keys(bySeason)) {
    const st = JSON.parse(snaps[S]); st.cfg = cfg;
    for (const g of bySeason[S]) {
      const F = M.features(st, gameObj(g));
      out[g.id] = { s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa };
      const pr = rows[g.id] || [];
      const h = pr.find((x) => D.fr(x.team) === g.home), a = pr.find((x) => D.fr(x.team) === g.away);
      if (pr.length === 2 && h && a) {
        const hr = E.nfl.teamGameFromStw(h), ar = E.nfl.teamGameFromStw(a);
        hr.pts_for = g.home_score; hr.pts_against = g.away_score; ar.pts_for = g.away_score; ar.pts_against = g.home_score;
        M.absorbGame(st, [[g.home, hr], [g.away, ar]], []);
      }
      M.afterGame(st, gameObj(g));
    }
  }
  return out;
}

/* ------------------------------------------------------------ the margin PMF */
const PMF_MEMO = {};
/* P(margin = m | closing spread = s), kernel over closing spreads of seasons < S
   (research/train_nfl.py pmf_at, bandwidth 3), refitted so no season is priced
   from a table that saw its own results */
function pmfFor(S) {
  if (PMF_MEMO[S]) return PMF_MEMO[S];
  const tr = D.games().filter((g) => g.done && g.season >= 1999 && g.season < S && g.close_home_margin != null);
  const sp = tr.map((g) => g.close_home_margin), mi = tr.map((g) => Math.round(g.home_score - g.away_score));
  const tab = {};
  for (let s10 = -28; s10 <= 28; s10++) {
    const s = s10 / 2, acc = {}; let tot = 0;
    for (let i = 0; i < tr.length; i++) { const w = Math.exp(-0.5 * Math.pow((sp[i] - s) / PMF_BW, 2)); tot += w; acc[mi[i]] = (acc[mi[i]] || 0) + w; }
    const o = {};
    Object.keys(acc).sort((a, b) => a - b).forEach((m) => { const v = acc[m] / tot; if (v >= 1e-5 && Math.abs(+m) <= 45) o[m] = Math.round(v * 1e6) / 1e6; });
    tab[s.toFixed(1)] = o;
  }
  PMF_MEMO[S] = tab;
  return tab;
}
function withTable(S, fn) {
  const nfl = PARAMS.nfl, keep = nfl.margin_pmf_by_spread;
  nfl.margin_pmf_by_spread = pmfFor(S);
  try { return fn(); } finally { nfl.margin_pmf_by_spread = keep; }
}
function normCdf(x) { return E._normCdf(x); }

/* ------------------------------------------------------------ walk-forward */
function predictRows(model, rows, sel) {
  return rows.map((r) => {
    const x = sel ? sel(r) : r;
    let s = model.spread.b; for (let i = 0; i < x.s.length; i++) s += model.spread.w[i] * x.s[i];
    let c = model.ctx.b; for (let i = 0; i < x.c.length; i++) c += model.ctx.w[i] * x.c[i];
    let t = model.total.b; for (let i = 0; i < x.t.length; i++) t += model.total.w[i] * x.t[i];
    const neutral = r.g.neutral, season = model.season_hfa;
    const strength = season ? s : (neutral ? s - model.spread.b : s);
    return { strength, context: c, hfa: season ? x.hfa : 0, margin: strength + c + (season ? x.hfa : 0), total: t };
  });
}
/* round 2, S1: each column scaled to unit SD on these training rows before
   the ridge, the weights mapped back to raw scale (serving reads raw weights) */
function ridgeStd(X, y, lam, withIntercept) {
  const p = X.length ? X[0].length : 0, n = X.length, sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let m = 0; for (let i = 0; i < n; i++) m += X[i][j]; m /= n || 1;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i][j] - m) * (X[i][j] - m);
    const s = Math.sqrt(v / (n || 1)); if (s > 1e-9) sd[j] = s;
  }
  const f = M.ridge(X.map((r) => r.map((x, j) => x / sd[j])), y, lam, withIntercept);
  return { w: f.w.map((w, j) => w / sd[j]), b: f.b };
}
function fit(cfg, train) {
  const season = cfg.hfa.kind === 'season';
  const ys = train.map((r) => (r.g.home_score - r.g.away_score) - (season ? r.hfa : 0));
  const sFit = cfg.ridge.standardize ? ridgeStd(train.map((r) => r.s), ys, cfg.ridge.strength, !season) : M.ridge(train.map((r) => r.s), ys, cfg.ridge.strength, !season);
  const res = train.map((r, i) => { let p = sFit.b; for (let j = 0; j < r.s.length; j++) p += sFit.w[j] * r.s[j]; return ys[i] - p; });
  const cFit = M.ridge(train.map((r) => r.c), res, cfg.ridge.context, !season);
  const tTrain = train.filter((r) => r.g.home_score != null);
  const tFit = M.ridge(tTrain.map((r) => r.t), tTrain.map((r) => r.g.home_score + r.g.away_score), cfg.ridge.total, true);
  return { spread: sFit, ctx: cFit, total: tFit, season_hfa: season };
}
/* returns one prediction per scored game, every season from FIRST_PRED */
function walkForward(rep, opts) {
  opts = opts || {};
  const cfg = rep.cfg, out = [], fits = {};
  const seasons = [...new Set(rep.rows.map((r) => r.g.season))].filter((s) => s >= FIRST_PRED).sort((a, b) => a - b);
  for (const S of seasons) {
    const train = rep.rows.filter((r) => r.g.season >= FIRST_TRAIN && r.g.season < S);
    const test = rep.rows.filter((r) => r.g.season === S);
    const model = fit(cfg, train);
    fits[S] = model;
    const preds = predictRows(model, test, opts.served ? (r) => rep.served[r.g.id] : null);
    const iso = cfg.calibration.kind === 'isotonic' ? M.fitIsotonic(out.filter((o) => o.season < S && o.y != null).map((o) => [o.p_raw, o.y])) : null;
    withTable(S, () => {
      test.forEach((r, i) => {
        const pr = preds[i], g = r.g, margin = g.home_score - g.away_score;
        const pRaw = opts.served ? normCdf(pr.margin / 10.7) : E.dist.winProb('nfl', pr.margin);
        const p = iso ? M.calibrate(iso, pRaw) : pRaw;
        out.push({ id: g.id, season: S, week: g.week, type: g.type, neutral: g.neutral, margin, model: pr.margin, total: pr.total,
          actual_total: g.home_score + g.away_score, close: g.close_home_margin, close_total: g.close_total,
          p, p_raw: pRaw, y: margin > 0 ? 1 : (margin < 0 ? 0 : null), home_ml: g.home_ml, away_ml: g.away_ml,
          parts: { strength: pr.strength, context: pr.context, hfa: pr.hfa } });
      });
    });
  }
  return { preds: out, fits };
}

/* ------------------------------------------------------------ scoring */
const amToProb = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function marketProb(r) {
  if (r.home_ml == null || r.away_ml == null) return null;
  const h = amToProb(r.home_ml), a = amToProb(r.away_ml);
  return h / (h + a);
}
function logit(p) { return Math.log(p / (1 - p)); }
function calSlope(pairs) {
  /* logistic regression y ~ a + b*logit(p), Newton */
  let a = 0, b = 1;
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const [p, y] of pairs) { const x = logit(Math.min(1 - 1e-6, Math.max(1e-6, p))), q = 1 / (1 + Math.exp(-(a + b * x))); g0 += y - q; g1 += (y - q) * x; const w = q * (1 - q); h00 += w; h01 += w * x; h11 += w * x * x; }
    const det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { intercept: a, slope: b };
}
function probScores(pairs) {
  const n = pairs.length; if (!n) return null;
  let br = 0, ll = 0; const bins = []; for (let i = 0; i < 10; i++) bins.push({ n: 0, p: 0, y: 0 });
  for (const [p0, y] of pairs) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, p0));
    br += (p - y) * (p - y); ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += y;
  }
  let ece = 0; bins.forEach((b) => { if (b.n) ece += (b.n / n) * Math.abs(b.p / b.n - b.y / b.n); });
  return { n, brier: br / n, logloss: ll / n, ece, ...calSlope(pairs), bins: bins.map((b, i) => ({ lo: i / 10, n: b.n, predicted: b.n ? b.p / b.n : null, observed: b.n ? b.y / b.n : null })) };
}
function score(preds, seasons) {
  const rows = preds.filter((r) => seasons.indexOf(r.season) >= 0 && r.close != null);
  if (!rows.length) return null;
  const mae = (f) => rows.reduce((a, r) => a + Math.abs(f(r) - r.margin), 0) / rows.length;
  const rmse = (f) => Math.sqrt(rows.reduce((a, r) => a + Math.pow(f(r) - r.margin, 2), 0) / rows.length);
  const pp = rows.filter((r) => r.y != null);
  const mk = pp.filter((r) => marketProb(r) != null);
  const ats = {};
  [1, 2, 3].forEach((t) => {
    let n = 0, w = 0;
    rows.forEach((r) => { const d = r.model - r.close; if (Math.abs(d) < t) return; const res = r.margin - r.close; if (res === 0) return; n++; if ((d > 0) === (res > 0)) w++; });
    ats[t] = { n, win_pct: n ? w / n : null };
  });
  const nn = rows.filter((r) => !r.neutral);
  const tot = rows.filter((r) => r.close_total != null && r.total != null);
  return {
    n: rows.length, seasons: [Math.min(...seasons), Math.max(...seasons)],
    model: { mae: mae((r) => r.model), rmse: rmse((r) => r.model), ...probScores(pp.map((r) => [r.p, r.y])), ats,
      home_lean: nn.length ? nn.reduce((a, r) => a + (r.model - r.close), 0) / nn.length : null,
      total_mae: tot.length ? tot.reduce((a, r) => a + Math.abs(r.total - r.actual_total), 0) / tot.length : null },
    close: { mae: mae((r) => r.close), rmse: rmse((r) => r.close), ...probScores(mk.map((r) => [marketProb(r), r.y])),
      total_mae: tot.length ? tot.reduce((a, r) => a + Math.abs(r.close_total - r.actual_total), 0) / tot.length : null },
    model_on_market_rows: probScores(mk.map((r) => [r.p, r.y])),
  };
}
const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
function evaluate(cfg, opts) {
  opts = opts || {};
  const rep = replay(cfg, { served: !!opts.served });
  const wf = walkForward(rep, { served: !!opts.served });
  return { cfg, valid: score(wf.preds, range(VALID[0], VALID[1])), holdout: score(wf.preds, [HOLDOUT]), live: score(wf.preds, [LIVE]),
    by_season: range(VALID[0], LIVE).map((s) => { const x = score(wf.preds, [s]); return x ? { season: s, n: x.n, mae: x.model.mae, close_mae: x.close.mae, logloss: x.model.logloss } : null; }).filter(Boolean),
    preds: opts.keepPreds ? wf.preds : undefined, fits: opts.keepFits ? wf.fits : undefined, rep: opts.keepRep ? rep : undefined };
}

/* ------------------------------------------------------------ record */
const RES = path.join(__dirname, 'results');
function slim(x) { return x ? { n: x.n, mae: +x.model.mae.toFixed(4), rmse: +x.model.rmse.toFixed(4), brier: +x.model.brier.toFixed(5), logloss: +x.model.logloss.toFixed(5), ece: +x.model.ece.toFixed(4), cal_slope: +x.model.slope.toFixed(3), home_lean: x.model.home_lean == null ? null : +x.model.home_lean.toFixed(3), ats3: x.model.ats[3], total_mae: x.model.total_mae == null ? null : +x.model.total_mae.toFixed(4) } : null; }
function logVariant(rec) {
  fs.mkdirSync(RES, { recursive: true });
  fs.appendFileSync(path.join(RES, 'variants.jsonl'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n');
}

module.exports = { replay, walkForward, evaluate, score, slim, logVariant, pmfFor, withTable, fit, ridgeStd, predictRows, marketProb, gameObj,
  FIRST_TRAIN, FIRST_PRED, VALID, HOLDOUT, LIVE, RES, range };
