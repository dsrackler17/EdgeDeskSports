#!/usr/bin/env node
/* ============================================================================
   THE STAKING VALIDATION — is the sizing engine worth anything over flat bets?

   A sizing engine that does not beat flat staking is a decoration with extra
   steps. This runs EdgeDesk's real staking kernel (supabase/functions/
   edgedesk_ai/_stake.js) over the closing-line archives, WALK-FORWARD and
   SEPARATELY BY SPORT AND MARKET, and scores it against the only two
   baselines that matter: a flat 0.5u and a flat 1u on the same selections at
   the same prices.

   WHAT IS FITTED, AND WHEN
     For each held-out season S, everything is fitted on seasons BEFORE S:
       the rating line   margin ~ a + b*(rating difference) + c*home, from a
                         market-independent rating — CFB: the pregame Elo the
                         schedules carry; NFL: an Elo this script computes from
                         the archive's own results in kickoff order. Neither
                         reads a line, an opener or a close.
       the blend         margin ~ a + b*close + c*(model - close), the same
                         form the shipped pricer uses, with its residual sigma
       the tier          the ATS record of the model side by disagreement
                         threshold, under the SAME rules validate_pricing.js
                         applies (VALIDATED / LEAN / RESEARCH)
     Nothing is fitted on the season it is scored on, no closing line enters a
     pregame feature, and no threshold is chosen on the evaluation window.

   WHAT IS SCORED, ON S ONLY
     calibration       Brier and log loss on the CALIBRATED and on the
                       CONSERVATIVE probability, plus reliability buckets
     record            wins / losses / pushes of the sized positions
     money             profit in units at the engine's own sizes, against a
                       flat 0.5u and a flat 1u on the same selections
     risk              maximum drawdown in units, per arm
     CLV               the points the engine's side got at the OPENER against
                       the close, where the archive carries an opener
     shrinkage         the same run with the conservative shrink switched off,
                       so "does uncertainty shrinkage help out of sample" is
                       answered rather than assumed

   THE VERDICT IT WRITES
     football/validation/staking_<sport>.json carries, per market, a MODE:
       BET             the engine beat BOTH flat baselines on the held-out
                       window with a positive ROI and n >= 200 positions
       SHADOW          it sized positions but did not beat the baselines:
                       it runs, it records, it does not recommend
       RESEARCH_ONLY   it could not size the market at all
     The staking kernel reads the mode and refuses to stake a SHADOW market.
     Nothing here promotes itself: a mode is written from the numbers below it.

   Usage
     node tools/intelligence/validate_staking.js                 # both sports
     node tools/intelligence/validate_staking.js --sport nfl     # one
     node tools/intelligence/validate_staking.js --write         # write artifacts
     node tools/intelligence/validate_staking.js --json          # machine-readable
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');
require(path.join(FN, '_intelligence.js'));
require(path.join(FN, '_research.js'));
const P = require(path.join(FN, '_pricing.js'));
const S = require(path.join(FN, '_stake.js'));

const OUT_DIR = path.join(ROOT, 'football', 'validation');
const SCHEMA = 'edgedesk_staking_validation_v1';
/* The rules. Fixed here, never tuned against the evaluation window. */
const RULES = {
  first_eval: 2016, first_holdout: 2019, min_tune_seasons: 3,
  tier: {
    validated: { win_pct: 0.535, p_max: 0.01, min_n: 500 },
    lean: { win_pct: 0.5238, p_max: 0.05, min_n: 300 },
  },
  /* Every threshold below is tested, so they are a FAMILY and the p that
     matters is the corrected one. Holm-Bonferroni, applied across the
     testable thresholds only. */
  multiple_comparisons: 'holm-bonferroni across the testable disagreement thresholds; the best of m must clear p_max / m',
  thresholds: [0.5, 1, 1.5, 2, 3, 4, 6],
  /* A moneyline disagreement is in PROBABILITY points, not in points of a
     line, so it gets its own family — and its own null. */
  moneyline_thresholds: [0.01, 0.02, 0.03, 0.05, 0.07, 0.1],
  tier_moneyline: {
    validated: { roi: 0.03, p_max: 0.01, min_n: 500 },
    lean: { roi: 0, p_max: 0.05, min_n: 300 },
  },
  /* a mode is earned on the held-out window, with a sample floor */
  mode: { min_positions: 200, must_beat_flat_half: true, must_beat_flat_one: true },
  /* the policy the backtest sizes under: the shipped conservative default,
     with a bankroll so the Kelly fraction becomes units the way it does live */
  policy: { bankroll_amount: 2500, base_unit_amount: 25 },
};

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function clampP(v) { const n = num(v); return n == null ? null : Math.min(0.999, Math.max(0.001, n)); }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function binomP(wins, n) { if (!n) return null; const z = (wins - 0.5 - n / 2) / Math.sqrt(n / 4); return r4(1 - normCdf(z)); }

/**
 * Ordinary least squares with an intercept.
 *
 * A CONSTANT REGRESSOR IS DROPPED, and this is not a nicety. The NFL archive
 * has no neutral-site games, so its home-field column is 1 for every row and
 * perfectly collinear with the intercept; the normal equations are then
 * singular and the first version of this solver answered with a vector of
 * ZEROS and no complaint. A rating line of zero disagrees with every market
 * number by the whole line, so the backtest went on to grade a model that did
 * not exist. `dropped` names what was removed and `ok` is false when the
 * system still cannot be solved, so a caller can refuse the season instead of
 * scoring a fiction.
 */
function ols(rows, xs, yf) {
  const varying = [], dropped = [];
  xs.forEach((f, i) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) { const v = Number(f(r)) || 0; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo > 1e-9) varying.push({ f, i }); else dropped.push(i);
  });
  const fit = olsCore(rows, varying.map((v) => v.f), yf);
  if (!fit.ok) return { coef: new Array(xs.length + 1).fill(0), ok: false, dropped, why: 'the normal equations are singular even after dropping ' + dropped.length + ' constant regressor(s)' };
  /* re-expand to the caller's column order, with 0 for a dropped column:
     its effect is inside the intercept, which is where it belongs */
  const coef = new Array(xs.length + 1).fill(0);
  coef[0] = fit.coef[0];
  varying.forEach((v, k) => { coef[v.i + 1] = fit.coef[k + 1]; });
  return { coef, ok: true, dropped, why: dropped.length ? 'constant regressor(s) at index ' + dropped.join(',') + ' were absorbed by the intercept' : null };
}
function olsCore(rows, xs, yf) {
  const k = xs.length + 1;
  const A = Array.from({ length: k }, () => new Float64Array(k));
  const b = new Float64Array(k);
  for (const r of rows) {
    const x = [1].concat(xs.map((f) => Number(f(r)) || 0));
    const y = Number(yf(r)) || 0;
    for (let i = 0; i < k; i++) { for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; b[i] += x[i] * y; }
  }
  /* Gaussian elimination with partial pivoting */
  const M = A.map((row, i) => Array.from(row).concat([b[i]]));
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return { coef: new Array(k).fill(0), ok: false };
    const t = M[c]; M[c] = M[p]; M[p] = t;
    for (let r = 0; r < k; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; }
  }
  return { coef: M.map((row, i) => row[k] / M[i][i]), ok: true };
}
/**
 * Logistic regression by iteratively reweighted least squares.
 *
 * The moneyline blend predicts a PROBABILITY from a binary outcome, so least
 * squares on a logit of the outcome — the shortcut the pricing validation
 * takes — is a proxy. This is the real thing, and it is twenty lines: the
 * binary outcome is what the archive actually carries, and a probability
 * fitted by a method that assumes a continuous one is a probability with a
 * quiet bias in it.
 */
function logistic(rows, xs, yf, iters) {
  const k = xs.length + 1;
  let beta = new Array(k).fill(0);
  const X = rows.map((r) => [1].concat(xs.map((f) => Number(f(r)) || 0)));
  const Y = rows.map((r) => (yf(r) ? 1 : 0));
  for (let it = 0; it < (iters || 25); it++) {
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const g = new Float64Array(k);
    for (let i = 0; i < X.length; i++) {
      let z = 0; for (let j = 0; j < k; j++) z += beta[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const w = Math.max(1e-6, p * (1 - p));
      for (let a = 0; a < k; a++) { g[a] += X[i][a] * (Y[i] - p); for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b] * w; }
    }
    /* solve A d = g */
    const M = A.map((row, i) => Array.from(row).concat([g[i]]));
    let ok = true;
    for (let c = 0; c < k && ok; c++) {
      let piv = c; for (let r2i = c + 1; r2i < k; r2i++) if (Math.abs(M[r2i][c]) > Math.abs(M[piv][c])) piv = r2i;
      if (Math.abs(M[piv][c]) < 1e-12) { ok = false; break; }
      const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (let r2i = 0; r2i < k; r2i++) { if (r2i === c) continue; const f = M[r2i][c] / M[c][c]; for (let j = c; j <= k; j++) M[r2i][j] -= f * M[c][j]; }
    }
    if (!ok) return { coef: beta, ok: false, why: 'the logistic fit became singular' };
    let moved = 0;
    for (let i = 0; i < k; i++) { const d = M[i][k] / M[i][i]; beta[i] += d; moved += Math.abs(d); }
    if (moved < 1e-9) break;
  }
  const predict = (r) => { let z = beta[0]; xs.forEach((f, i) => { z += beta[i + 1] * (Number(f(r)) || 0); }); return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); };
  return { coef: beta, ok: true, predict, why: null };
}

function sigmaOf(rows, pred, yf) {
  const res = rows.map((r) => Number(yf(r)) - Number(pred(r))).filter((x) => Number.isFinite(x));
  if (res.length < 30) return null;
  const m = mean(res);
  return Math.sqrt(mean(res.map((x) => (x - m) * (x - m))));
}

/* ------------------------------------------------------------------ inputs */
/**
 * THE SHIPPED ENGINE, WHERE ITS FEEDS ARE ON DISK.
 *
 * The Elo line below is a stand-in. It is market-independent and reproducible
 * anywhere, which is what makes this file runnable in a sandbox — but it is
 * NOT the projection the desk actually quotes, so a validation built on it
 * proves the sizing RULES and says nothing about the shipped number.
 *
 * validate_pricing.js already replays `football/engine.js` cold from 2006 in
 * kickoff order and returns a per-game row carrying the engine's own fair
 * spread, fair total and win probability. That replay needs the nflverse
 * team-week CSVs, which are cached rather than committed — present on the
 * nightly runner, absent in a fresh checkout. So it is TRIED first and the
 * Elo line is the documented fallback, with `model_source` on every row
 * saying which one a reader is looking at.
 */
function engineRows() {
  let VP = null;
  try { VP = require(path.join(ROOT, 'tools', 'football', 'validate_pricing.js')); }
  catch (e) { return { ok: false, why: 'the pricing validation could not be loaded: ' + String(e && e.message || e).slice(0, 120) }; }
  const archiveFile = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
  if (!fs.existsSync(archiveFile)) return { ok: false, why: 'no NFL closing-line archive on file' };
  let rep = null;
  try {
    const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    let injuries = null;
    try { injuries = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'injuries_nfl.json'), 'utf8')); } catch (_) { injuries = null; }
    rep = VP.replayNfl(archive, { injuries });
  } catch (e) { return { ok: false, why: 'the engine replay threw: ' + String(e && e.message || e).slice(0, 160) }; }
  if (!rep || !rep.rows || rep.rows.length < 500) {
    return { ok: false, why: 'the engine replay produced ' + (rep && rep.rows ? rep.rows.length : 0) + ' rows'
      + (rep && rep.seasons_loaded && !rep.seasons_loaded.length ? ': no nflverse team-week season is cached, so the engine had no state to project from (run tools/football/fetch_nfl_feeds.js)' : ''),
      seasons_loaded: rep ? rep.seasons_loaded : [] };
  }
  /* the replay row carries `model` as the engine's FAIR SPREAD, which is a
     betting line in the same convention the archive stores `close` in */
  const byId = {};
  rep.rows.forEach((r) => { byId[r.id] = r; });
  return { ok: true, byId, rows: rep.rows.length, seasons_loaded: rep.seasons_loaded, absorbed: rep.absorbed, refused: rep.refused };
}

/** The NFL archive with a market-independent Elo computed from its own results. */
function nflRows(opts) {
  opts = opts || {};
  const file = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
  if (!fs.existsSync(file)) return { rows: [], error: 'no NFL closing-line archive on file; run tools/football/build_lines_archive.js' };
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  /* the shipped engine first, the Elo line as the stated fallback */
  const eng = opts.engine === false ? { ok: false, why: 'the engine replay was switched off for this run' } : engineRows();
  const games = (a.games || []).filter((g) => g.margin != null && g.close && g.close.home_line != null)
    .sort((x, y) => x.season - y.season || String(x.date).localeCompare(String(y.date)) || String(x.id).localeCompare(String(y.id)));
  /* Elo, in kickoff order, from results only. The rating of a game is the
     rating BEFORE it, so nothing a game produced can price it. */
  const elo = {}, K = 20, HFA = 55, MEAN = 1500;
  let season = null;
  const rows = [];
  for (const g of games) {
    if (season != null && g.season !== season) { Object.keys(elo).forEach((t) => { elo[t] = MEAN + (elo[t] - MEAN) * 0.75; }); }
    season = g.season;
    const eh = elo[g.home] == null ? MEAN : elo[g.home], ea = elo[g.away] == null ? MEAN : elo[g.away];
    const e = eng.ok ? eng.byId[g.id] : null;
    rows.push({
      id: g.id, season: g.season, week: g.week, elo_diff: eh - ea, home: 1, margin: g.margin,
      /* the shipped engine's own numbers, when the replay reached this game */
      engine_home_line: e && e.model != null ? -Number(e.model) : null,
      engine_total: e && e.model_total != null ? Number(e.model_total) : null,
      engine_home_win_prob: e && e.p_home != null ? Number(e.p_home) : null,
      close: g.close.home_line, open: g.open && g.open.home_line != null ? g.open.home_line : null,
      close_total: num(g.close.total), points: num(g.points),
      home_odds: num(g.close.home_spread_odds), away_odds: num(g.close.away_spread_odds),
      over_odds: num(g.close.over_odds), under_odds: num(g.close.under_odds),
      home_ml: num(g.close.home_moneyline), away_ml: num(g.close.away_moneyline),
      qb_known: !!(g.ctx && g.ctx.home_qb_id && g.ctx.away_qb_id),
      weather_known: !!(g.ctx && (g.ctx.roof === 'dome' || g.ctx.roof === 'closed' || g.ctx.temp != null)),
      home_team: g.home, away_team: g.away,
    });
    /* absorb */
    const exp = 1 / (1 + Math.pow(10, -((eh + HFA - ea) / 400)));
    const res = g.margin > 0 ? 1 : g.margin < 0 ? 0 : 0.5;
    const mult = Math.log(Math.abs(g.margin) + 1) * (2.2 / (((eh + HFA - ea) * 0.001) * (g.margin > 0 ? 1 : -1) + 2.2));
    const d = K * mult * (res - exp);
    elo[g.home] = eh + d; elo[g.away] = ea - d;
  }
  const withEngine = rows.filter((r) => r.engine_home_line != null).length;
  return {
    rows, error: null, source: path.relative(ROOT, file), games: games.length,
    engine: eng.ok
      ? { available: true, rows: eng.rows, seasons_loaded: eng.seasons_loaded, joined: withEngine, source: 'football/engine.js replayed cold by tools/football/validate_pricing.js' }
      : { available: false, why: eng.why, seasons_loaded: eng.seasons_loaded || [] },
  };
}

/** The CFB archive, using the pregame Elo the schedules already carry. */
function cfbRows() {
  const file = path.join(ROOT, 'football', 'pricing', 'lines_cfb.json');
  if (!fs.existsSync(file)) return { rows: [], error: 'no CFB line archive on file; run tools/football/build_lines_archive.js --sport cfb' };
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (a.games || []).filter((g) => g.margin != null && g.close && g.close.home_line != null
    && g.ctx && num(g.ctx.home_pregame_elo) != null && num(g.ctx.away_pregame_elo) != null
    && g.home_division === 'fbs' && g.away_division === 'fbs')
    .map((g) => ({
      id: g.id, season: g.season, week: g.week,
      elo_diff: num(g.ctx.home_pregame_elo) - num(g.ctx.away_pregame_elo), home: g.neutral ? 0 : 1, margin: g.margin,
      close: g.close.home_line, open: g.open && g.open.home_line != null ? g.open.home_line : null,
      close_total: num(g.close.total), points: num(g.points),
      home_odds: null, away_odds: null, over_odds: null, under_odds: null,
      home_ml: num(g.close.home_moneyline), away_ml: num(g.close.away_moneyline),
      qb_known: false, weather_known: false,
      home_team: g.home, away_team: g.away,
    }));
  return { rows, error: null, source: path.relative(ROOT, file), games: rows.length };
}

/* ------------------------------------------------------- the walk-forward */
/**
 * The ATS record of the model's own side, by disagreement threshold.
 *
 * `rows` are PRE-ORIENTED: each carries the size of the disagreement and the
 * cover margin OF THE SIDE THE MODEL FAVOURS, both computed where the market's
 * sign convention is known. A shared helper that tried to derive the side from
 * a home line had to encode one market's convention and got the other's wrong,
 * which is exactly the class of error this whole file exists to catch.
 *   gap            |model - market|, in points
 *   favoured_cover >0 the model's side covered, 0 push, <0 it did not
 */
function atsTable(rows) {
  const out = {};
  for (const t of RULES.thresholds) {
    let n = 0, wins = 0, pushes = 0;
    for (const r of rows) {
      if (!(Math.abs(r.gap) >= t)) continue;
      n++; if (r.favoured_cover > 0) wins++; else if (r.favoured_cover === 0) pushes++;
    }
    const scored = n - pushes;
    out[String(t)] = { n, wins, pushes, win_pct: scored ? r4(wins / scored) : null, p_one_sided: scored ? binomP(wins, scored) : null };
  }
  return out;
}
/**
 * A TIER MUST BE EARNED, NOT FOUND BY SEARCHING.
 *
 * The first version of this scanned seven disagreement thresholds and took
 * the first one whose p cleared 0.05. That is seven chances at a 1-in-20
 * event: under a model with no edge at all, the probability that SOME
 * threshold clears is far closer to 1 in 3 than to 1 in 20, and the artifact
 * showed exactly that signature — the winning threshold wandered 2 → 1 → 2 →
 * 2 → 4 → 4 → 4 across held-out seasons, and the "VALIDATED" seasons rested
 * on 14, 14 and 32 picks apiece. A threshold that rare clearing significance
 * after a seven-way scan is a fitting artifact.
 *
 * HOLM-BONFERRONI over the whole scanned family fixes it. The thresholds are
 * ordered by p ascending; the k-th smallest must clear alpha / (m - k + 1),
 * and the procedure stops at the first failure — so the best of seven has to
 * clear alpha/7 rather than alpha. Every threshold's adjusted bar is reported
 * beside its raw p, so a reader can see what the correction cost.
 *
 * The thresholds are a FAMILY, not a menu: `family_size` is the count of
 * thresholds that were actually testable (a usable sample), because a
 * threshold with no games was never a chance to be wrong.
 */
function holmAdjust(table, rule, thresholds) {
  const testable = (thresholds || RULES.thresholds)
    .map((t) => ({ t, e: table[String(t)] }))
    .filter((x) => x.e && x.e.p_one_sided != null && x.e.n >= rule.min_n);
  const m = testable.length;
  if (!m) return { m: 0, passes: {}, ordered: [] };
  const ordered = testable.slice().sort((a, b) => a.e.p_one_sided - b.e.p_one_sided);
  const passes = {}; let stillRejecting = true;
  ordered.forEach((x, k) => {
    const bar = r4(rule.p_max / (m - k));
    const clears = stillRejecting && x.e.p_one_sided < bar;
    if (!clears) stillRejecting = false;
    passes[String(x.t)] = { holm_bar: bar, rank: k + 1, clears_holm: clears };
  });
  return { m, passes, ordered: ordered.map((x) => x.t) };
}
function tierFrom(table, opts) {
  opts = opts || {};
  const thresholds = opts.thresholds || RULES.thresholds;
  const ruleset = opts.rules || RULES.tier;
  /* what "good enough" means: a cover rate for a spread or a total, a return
     on risk for a moneyline, because those are the quantities whose nulls the
     tables above actually tested */
  const metric = opts.metric || 'win_pct';
  const unit = opts.unit || 'points';
  const searched = [];
  for (const [name, rule] of [['VALIDATED', ruleset.validated], ['LEAN', ruleset.lean]]) {
    const holm = holmAdjust(table, rule, thresholds);
    for (const t of thresholds) {
      const e = table[String(t)];
      const h = holm.passes[String(t)] || null;
      if (!e || e.p_one_sided == null) continue;
      const sampleOk = e.n >= rule.min_n;
      const observed = metric === 'roi' ? e.roi : e.win_pct;
      const bar = metric === 'roi' ? rule.roi : rule.win_pct;
      const rateOk = observed != null && observed >= bar;
      const rawOk = e.p_one_sided < rule.p_max;
      const holmOk = !!(h && h.clears_holm);
      searched.push({ tier: name, threshold: t, n: e.n, metric, observed, bar, win_pct: e.win_pct, roi: e.roi, p_one_sided: e.p_one_sided, holm_bar: h ? h.holm_bar : null, family_size: holm.m, sample_ok: sampleOk, rate_ok: rateOk, raw_p_ok: rawOk, holm_ok: holmOk });
      if (sampleOk && rateOk && rawOk && holmOk) {
        return { tier: name, required_edge_points: t, family_size: holm.m, holm_bar: h.holm_bar, metric,
          basis: name + ' on the tune window: the model side went ' + e.wins + '-' + (e.n - e.wins - e.pushes) + '-' + e.pushes
            + (metric === 'roi' ? ' for ' + (e.roi * 100).toFixed(2) + '% on risk' : ' (' + (e.win_pct * 100).toFixed(2) + '%)')
            + ', n ' + e.n + ', at ' + t + '+ ' + unit + ' of disagreement, p ' + e.p_one_sided + ' against a Holm bar of ' + h.holm_bar + ' for a family of ' + holm.m + ' thresholds'
            + (metric === 'roi' ? ' (' + e.null_basis + ')' : ''),
          searched };
      }
    }
  }
  /* Was anything lost to the correction alone? That is worth naming: it is the
     difference between "no signal" and "a signal that did not survive being
     looked for seven times". */
  const lostToHolm = searched.filter((x) => x.sample_ok && x.rate_ok && x.raw_p_ok && !x.holm_ok);
  return {
    tier: 'RESEARCH', required_edge_points: null, family_size: searched.length ? searched[0].family_size : 0, holm_bar: null, searched,
    basis: lostToHolm.length
      ? 'no threshold survived the multiple-comparison correction: ' + lostToHolm.map((x) => x.threshold + ' pts cleared raw p (' + x.p_one_sided + ') but not its Holm bar (' + x.holm_bar + ' for a family of ' + x.family_size + ')').join('; ') + '. A record found by scanning ' + (searched[0] ? searched[0].family_size : 0) + ' thresholds is not a record'
      : 'no disagreement threshold on the tune window cleared break-even with a usable sample; the cover probabilities are arithmetic on the blend, not a betting edge',
  };
}

/**
 * THE MONEYLINE NEEDS A DIFFERENT NULL, and this is the reason it was left out
 * of the first round rather than bolted on.
 *
 * A spread or total is graded against a coin flip: the null is 50% and a
 * binomial test is exactly right. A moneyline is not. Backing favourites wins
 * far more than half the time and loses money; backing dogs wins far less and
 * can make money. Testing a moneyline win rate against 0.5 would call a
 * chalk-only strategy a discovery.
 *
 * So the null here is the PRICE: each bet is assumed to have exactly the
 * probability its own break-even implies, under which its expected profit is
 * zero. The test statistic is total realised profit over its standard error
 * under that null — a sum of independent bets with per-bet variance
 * p(1-p)(d-1)^2 + ... computed from the price itself. One-sided, because the
 * claim being tested is "this makes money", not "this is different".
 *
 *   rows: { gap, took_price_decimal, won (1/0/0.5 push) }
 */
function moneylineTable(rows, thresholds) {
  const out = {};
  for (const t of thresholds) {
    let n = 0, wins = 0, pushes = 0, profit = 0, variance = 0, staked = 0;
    for (const r of rows) {
      if (!(Math.abs(r.gap) >= t)) continue;
      n++;
      if (r.won === 0.5) { pushes++; continue; }
      const d = r.took_price_decimal, p0 = 1 / d;      /* the null: the price is right */
      const win = r.won === 1;
      if (win) { wins++; profit += d - 1; } else { profit -= 1; }
      /* Var(profit of one unit) under the null = p0(1-p0)d^2 */
      variance += p0 * (1 - p0) * d * d;
      staked += 1;
    }
    const sd = Math.sqrt(variance);
    const z = sd > 0 ? profit / sd : null;
    out[String(t)] = {
      n, wins, pushes, staked, profit: r3(profit),
      roi: staked ? r4(profit / staked) : null,
      win_pct: (n - pushes) ? r4(wins / (n - pushes)) : null,
      p_one_sided: z == null ? null : r4(1 - normCdf(z)), z: r3(z),
      null_basis: 'each bet is assumed to have exactly the probability its own price implies, so expected profit is zero; the z is realised profit over its standard error under that null',
    };
  }
  return out;
}

/**
 * HOW WRONG IS THE FAIR LINE, EMPIRICALLY?
 *
 * The staking kernel prefers a measured lower bound and almost never gets
 * one, so every live candidate falls through to shrinking the calibrated
 * probability toward a coin flip by a reliability score. That shrink is a
 * reasonable stand-in and it is not a measurement.
 *
 * This is the measurement. The tune window is resampled with replacement, the
 * blend is refitted on each replicate, and the fair value is recomputed for a
 * sample of games. The spread of those refits is the fit's own uncertainty —
 * not the residual spread of outcomes around the fair line (that is sigma,
 * and the cover curve already uses it), but the uncertainty in WHERE the fair
 * line sits. The 10th percentile of the pooled deviation is how far the line
 * could reasonably be against a selection, in points, and that is what the
 * conservative probability should be read at.
 *
 * Returns the shift as a POSITIVE magnitude: move the fair value this far
 * against the selection before reading the cover curve.
 */
function bootstrapFair(rows, fitFair, o) {
  o = o || {};
  const B = o.replicates || 120;
  const sampleRows = o.sample || 400;
  if (rows.length < 200) return { ok: false, why: 'too few tune rows to bootstrap a fit' };
  const point = fitFair(rows);
  if (!point) return { ok: false, why: 'the point fit did not solve' };
  /* a fixed, spread-out sample of games, so the deviation is measured at
     representative numbers rather than at whichever games sorted first */
  const step = Math.max(1, Math.floor(rows.length / sampleRows));
  const probe = []; for (let i = 0; i < rows.length; i += step) probe.push(rows[i]);
  const deltas = [];
  let seed = 20260917;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let solved = 0;
  for (let b = 0; b < B; b++) {
    const draw = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) draw[i] = rows[(rnd() * rows.length) | 0];
    const f = fitFair(draw);
    if (!f) continue;
    solved++;
    for (const r of probe) { const d = f(r) - point(r); if (Number.isFinite(d)) deltas.push(d); }
  }
  if (deltas.length < 100) return { ok: false, why: 'the bootstrap produced too few usable replicates' };
  deltas.sort((a, b) => a - b);
  const q = (p) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(p * deltas.length)))];
  return {
    ok: true, replicates: solved, probes: probe.length, deltas: deltas.length,
    shift_points_p10: r3(Math.abs(q(0.10))),
    shift_points_p05: r3(Math.abs(q(0.05))),
    median_abs: r3(mean(deltas.map(Math.abs))),
    basis: solved + ' bootstrap refits of the blend on the tune window, read at ' + probe.length + ' sample games; the shift is the 10th percentile of how far the fair value moved',
  };
}

/** Max drawdown, in units, of a sequence of per-position profits. */
function drawdown(profits) {
  let peak = 0, cum = 0, worst = 0;
  for (const p of profits) { cum += p; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > worst) worst = dd; }
  return r3(worst);
}

/**
 * THE MONEYLINE ARM. Structurally its own function, not a branch inside the
 * spread path, because almost nothing is shared: the model output is a
 * probability rather than a line, the blend is logistic rather than least
 * squares, the price varies per side by hundreds of points rather than
 * sitting at -110, and the null is the price rather than a coin flip. Forcing
 * it through the spread machinery is how a moneyline backtest ends up
 * grading favourites against 50% and calling chalk a discovery.
 */
function runMoneyline(o) {
  const sport = o.sport;
  const usable = o.rows.filter((r) => num(r.home_ml) != null && num(r.away_ml) != null && num(r.margin) != null);
  const settings = S.settings(RULES.policy, {});
  if (usable.length < 500) {
    return {
      market: 'moneyline', positions: 0, units_staked: 0, mode: 'RESEARCH_ONLY',
      mode_basis: usable.length
        ? 'only ' + usable.length + ' games in this archive carry both moneylines and a result; that is below the floor this validation will grade on, so the market is research only'
        : 'this archive carries no moneyline prices at all, so there is nothing to grade and the market is research only',
      record: { wins: 0, losses: 0, pushes: 0, win_pct: null }, money: null, risk: null, calibration: null,
      shrinkage: null, clv: { positions: 0, mean_points: null, note: 'not applicable to a moneyline' },
      per_season: [], holdouts: [], refused_seasons: [], counterfactual_lean: null,
    };
  }
  const imp = (am) => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  const devig = (r) => { const h = imp(num(r.home_ml)), a = imp(num(r.away_ml)); return h + a > 0 ? h / (h + a) : null; };
  const lg = (p) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
  const seasons = Array.from(new Set(usable.map((r) => r.season))).sort((a, b) => a - b).filter((x) => x >= RULES.first_holdout);
  const arms = { engine: [], flat_half: [], flat_one: [], no_shrink: [] };
  const probs = []; const perSeason = []; const holdouts = []; const refused = [];

  for (const Sn of seasons) {
    const tune = usable.filter((r) => r.season < Sn && r.season >= RULES.first_eval - 3);
    const test = usable.filter((r) => r.season === Sn);
    if (tune.length < 300 || !test.length) continue;
    if (Array.from(new Set(tune.map((r) => r.season))).length < RULES.min_tune_seasons) continue;

    /* the same market-independent rating, turned into a win probability
       through the tune window's own margin spread */
    const rating = ols(tune, [(r) => r.elo_diff, (r) => r.home], (r) => r.margin);
    if (!rating.ok || !(Math.abs(rating.coef[1]) > 1e-9)) { refused.push({ season: Sn, why: 'the rating fit carries no information on the tune window' }); continue; }
    const ratingMargin = (r) => rating.coef[0] + rating.coef[1] * r.elo_diff + rating.coef[2] * r.home;
    const sigM = sigmaOf(tune, ratingMargin, (r) => r.margin);
    if (!sigM) { refused.push({ season: Sn, why: 'no residual spread for the rating, so it cannot become a probability' }); continue; }
    /* the engine publishes a win probability directly; the rating has to be
       turned into one through the tune window's own margin spread */
    const shareE = (rows) => (rows.length ? rows.filter((r) => num(r.engine_home_win_prob) != null).length / rows.length : 0);
    const useEngine = shareE(tune) >= 0.9 && shareE(test) >= 0.9;
    const modelSource = useEngine ? 'shipped_engine' : 'elo_rating_line';
    const pModel = useEngine
      ? ((r) => clampP(num(r.engine_home_win_prob)))
      : ((r) => normCdf(ratingMargin(r) / sigM));

    const fitRows = tune.filter((r) => devig(r) != null && r.margin !== 0);
    if (fitRows.length < 300) { refused.push({ season: Sn, why: 'too few tune games with a coherent two-way moneyline' }); continue; }
    const blend = logistic(fitRows, [(r) => lg(devig(r)), (r) => lg(pModel(r)) - lg(devig(r))], (r) => r.margin > 0);
    if (!blend.ok) { refused.push({ season: Sn, why: blend.why }); continue; }

    /* the tier, on the tune window, at the PRICE the model's side was offered */
    const tierRows = fitRows.map((r) => {
      const pm = devig(r), pc = blend.predict(r);
      const takeHome = pc > pm;
      const gap = takeHome ? pc - pm : (1 - pc) - (1 - pm);
      const am = takeHome ? num(r.home_ml) : num(r.away_ml);
      const d = am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
      const won = r.margin === 0 ? 0.5 : (takeHome ? (r.margin > 0 ? 1 : 0) : (r.margin < 0 ? 1 : 0));
      return { gap, took_price_decimal: d, won };
    });
    const table = moneylineTable(tierRows, RULES.moneyline_thresholds);
    const tier = tierFrom(table, { thresholds: RULES.moneyline_thresholds, rules: RULES.tier_moneyline, metric: 'roi', unit: 'probability points' });
    holdouts.push({ season: Sn, n_tune: fitRows.length, n_test: test.length, model_source: modelSource,
      blend: { market: r4(blend.coef[1]), model_minus_market: r4(blend.coef[2]) },
      tier: tier.tier, required_edge_points: tier.required_edge_points, family_size: tier.family_size, holm_bar: tier.holm_bar,
      thresholds_that_cleared_raw_p_only: (tier.searched || []).filter((x) => x.sample_ok && x.rate_ok && x.raw_p_ok && !x.holm_ok).map((x) => x.threshold) });

    const seasonArms = { engine: [], flat_half: [], flat_one: [], no_shrink: [] };
    for (const r of test) {
      const pm = devig(r); if (pm == null) continue;
      const pc = blend.predict(r);
      for (const side of ['home', 'away']) {
        const pCal = side === 'home' ? pc : 1 - pc;
        const pMkt = side === 'home' ? pm : 1 - pm;
        const am = side === 'home' ? num(r.home_ml) : num(r.away_ml);
        if (am == null) continue;
        const cand = {
          id: [sport, r.id, 'h2h', side].join('|'), sport, game_id: String(r.id),
          matchup: r.away_team + ' at ' + r.home_team, home: r.home_team, away: r.away_team, kickoff: null,
          market: 'h2h', side, selection: side === 'home' ? r.home_team : r.away_team, line: null,
          quote: { book: 'consensus close', odds_american: am, odds_decimal: null, captured_at: '1970-01-01T00:00:00Z', freshness: 'CURRENT', executable: true, actionable: true, age_seconds: 0 },
          probability_source: 'MODEL_BLEND', fair_method: 'MODEL_BLEND',
          model_probability: pCal, calibrated_probability: pCal,
          no_vig_market_probability: pMkt, no_vig_method: 'NO_VIG_PROPORTIONAL',
          no_vig_source: 'both sides of the closing moneyline',
          push_probability: 0, fair_selection_line: null, sigma: null, fair_line_se: null,
          tier: tier.tier, tier_basis: tier.basis, calibration_available: true, calibration_version: 'walk-forward ' + Sn,
          model_version: (useEngine ? 'engine_logit_' : 'rating_logit_') + Sn, model_version_validated: tier.tier === 'VALIDATED' || tier.tier === 'LEAN',
          distribution_validated: true, sample_n: tier.required_edge_points != null ? table[String(tier.required_edge_points)].n : fitRows.length,
          data_completeness: 0.5 + (r.qb_known ? 0.25 : 0) + (r.weather_known ? 0.25 : 0),
          book_confirmed: true, availability_state: r.qb_known ? 'PROJECTED' : 'UNKNOWN',
          counter: 'a backtest position', invalidation: [], primary_reason: 'walk-forward',
        };
        const rec = S.evaluate(cand, { settings, timezone: 'UTC', now: 0 });
        const noShrink = S.evaluate(Object.assign({}, cand, { lower_bound: pCal, lower_bound_basis: 'shrinkage disabled for the ablation arm' }), { settings, timezone: 'UTC', now: 0 });
        const won = r.margin === 0 ? 0.5 : (side === 'home' ? (r.margin > 0 ? 1 : 0) : (r.margin < 0 ? 1 : 0));
        const dec = am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
        const payoff = (u) => (won === 1 ? u * (dec - 1) : won === 0.5 ? 0 : -u);
        if (rec.recommended_units > 0) {
          seasonArms.engine.push(payoff(rec.recommended_units));
          seasonArms.flat_half.push(payoff(0.5));
          seasonArms.flat_one.push(payoff(1));
          probs.push({ p_cal: rec.calibrated_probability, p_cons: rec.conservative_probability, won, reliability: rec.reliability_score, units: rec.recommended_units, season: Sn });
        }
        if (noShrink.recommended_units > 0) seasonArms.no_shrink.push(payoff(noShrink.recommended_units));
      }
    }
    perSeason.push({ season: Sn, tier: tier.tier, positions: seasonArms.engine.length,
      engine_units: r3(seasonArms.engine.reduce((a, b) => a + b, 0)),
      flat_half_units: r3(seasonArms.flat_half.reduce((a, b) => a + b, 0)),
      flat_one_units: r3(seasonArms.flat_one.reduce((a, b) => a + b, 0)) });
    Object.keys(arms).forEach((k) => { arms[k] = arms[k].concat(seasonArms[k]); });
  }
  return scoreArms({ market: 'moneyline', arms, probs, clv: [], perSeason, holdouts, refused, counterfactual: null });
}

/**
 * One market of one sport, walk-forward.
 * marketOf: builds the per-side candidates for a row under a fitted blend.
 */
function runMarket(o) {
  const all = o.rows, market = o.market, sport = o.sport;
  const settings = S.settings(RULES.policy, {});
  const seasons = Array.from(new Set(all.map((r) => r.season))).sort((a, b) => a - b)
    .filter((s) => s >= RULES.first_holdout);
  const arms = { engine: [], flat_half: [], flat_one: [], no_shrink: [], cf_engine: [], cf_flat_half: [], cf_flat_one: [] };
  const probs = [];            /* {p_cal, p_cons, won, reliability} */
  const cfUnits = [], cfProbs = [];
  const clv = [];
  const perSeason = [];
  const holdouts = [];
  const refused = [];

  for (const Sn of seasons) {
    const tune = all.filter((r) => r.season < Sn && r.season >= RULES.first_eval - 3);
    const test = all.filter((r) => r.season === Sn);
    if (tune.length < 300 || !test.length) continue;
    const tuneSeasons = Array.from(new Set(tune.map((r) => r.season)));
    if (tuneSeasons.length < RULES.min_tune_seasons) continue;

    /* 1. the rating line, from the rating only */
    const rating = ols(tune, [(r) => r.elo_diff, (r) => r.home], (r) => r.margin);
    if (!rating.ok) { refused.push({ season: Sn, why: 'the rating fit did not solve: ' + rating.why }); continue; }
    if (!(Math.abs(rating.coef[1]) > 1e-9)) { refused.push({ season: Sn, why: 'the rating carries no information on the tune window (a zero coefficient), so there is no model to grade' }); continue; }
    const ratingMargin = (r) => rating.coef[0] + rating.coef[1] * r.elo_diff + rating.coef[2] * r.home;

    /* 2. the market and the model, in the market's own units */
    const yOf = market === 'total' ? ((r) => num(r.points)) : ((r) => num(r.margin));
    const mktOf = market === 'total' ? ((r) => num(r.close_total)) : ((r) => -num(r.close));
    /* WHICH MODEL IS BEING GRADED, AND IT IS ALL OR NOTHING.
       The shipped engine's number is used when the replay reached essentially
       every game in BOTH the tune and the test window; otherwise the Elo line
       stands in for the whole market. Mixing a replayed engine number on some
       games with a stand-in on others would grade a projection that never
       existed, and the two are not on the same scale. `model_source` on the
       holdout says which one produced the season. */
    const engField = market === 'total' ? 'engine_total' : 'engine_home_line';
    const share = (rows) => (rows.length ? rows.filter((r) => num(r[engField]) != null).length / rows.length : 0);
    const useEngine = share(tune) >= 0.9 && share(test) >= 0.9;
    const tuneTotals = tune.map((r) => num(r.close_total)).filter((x) => x != null);
    const meanTotal = mean(tuneTotals);
    const modelSource = useEngine ? 'shipped_engine' : (market === 'total' ? 'tune_window_mean_total' : 'elo_rating_line');
    const modelOf = useEngine
      ? (market === 'total' ? ((r) => num(r.engine_total)) : ((r) => -num(r.engine_home_line)))
      : (market === 'total' ? (() => meanTotal) : ratingMargin);

    const tuneOk = tune.filter((r) => yOf(r) != null && mktOf(r) != null);
    const withModel = tuneOk.map((r) => Object.assign({}, r, { model: modelOf(r), mkt: mktOf(r), y: yOf(r) }));
    if (withModel.length < 200) continue;

    /* 3. the blend, fitted on the tune window only */
    const blend = ols(withModel, [(r) => r.mkt, (r) => r.model - r.mkt], (r) => r.y);
    if (!blend.ok) { refused.push({ season: Sn, why: 'the blend fit did not solve: ' + blend.why }); continue; }
    const fairOf = (r) => blend.coef[0] + blend.coef[1] * r.mkt + blend.coef[2] * (r.model - r.mkt);
    const sigma = sigmaOf(withModel, fairOf, (r) => r.y);
    if (!sigma) continue;
    /* the fit's own uncertainty, measured rather than approximated */
    const boot = bootstrapFair(withModel, (sample) => {
      const f = ols(sample, [(r) => r.mkt, (r) => r.model - r.mkt], (r) => r.y);
      return f.ok ? ((r) => f.coef[0] + f.coef[1] * r.mkt + f.coef[2] * (r.model - r.mkt)) : null;
    });

    /* 4. the tier, from the tune window's ATS record, in spread units only */
    /* SIGN CONVENTIONS, WRITTEN OUT ONCE.
       The archive stores `close` as a BETTING LINE (home_line = -spread_line,
       so -3.5 means the home side is favoured by 3.5). The blend predicts a
       MARGIN, so the model's home line is minus its predicted margin. A home
       selection covers when margin + its own line > 0. Getting either of these
       backwards inverts every position in the backtest and produces a
       spectacular fake profit, so both are derived here and nowhere else. */
    const tierRows = market === 'spread'
      ? withModel.map((r) => {
        const modelHomeLine = -r.model, gap = modelHomeLine - r.close;
        const sgn = gap < 0 ? 1 : -1;                       /* model likes the home side when its line is lower */
        return { gap, favoured_cover: sgn * (r.margin + r.close) };
      })
      : withModel.map((r) => {
        const gap = r.model - r.mkt;                        /* model total above the market total */
        const sgn = gap > 0 ? 1 : -1;                       /* take the over when the model is higher */
        return { gap, favoured_cover: sgn * (r.y - r.mkt) };
      });
    const table = atsTable(tierRows);
    const tier = tierFrom(table);
    holdouts.push({ season: Sn, tune_seasons: tuneSeasons.length, n_tune: withModel.length, n_test: test.length,
      model_source: modelSource,
      rating: { points_per_rating_point: r4(rating.coef[1]), home_field: r2(rating.coef[2]) },
      blend: { intercept: r2(blend.coef[0]), market: r4(blend.coef[1]), model_minus_market: r4(blend.coef[2]), sigma: r2(sigma), dropped_regressors: blend.dropped.length },
      bootstrap: boot.ok ? { shift_points_p10: boot.shift_points_p10, shift_points_p05: boot.shift_points_p05, replicates: boot.replicates } : { error: boot.why },
      rating_note: rating.why,
      tier: tier.tier, required_edge_points: tier.required_edge_points,
      family_size: tier.family_size, holm_bar: tier.holm_bar,
      thresholds_that_cleared_raw_p_only: (tier.searched || []).filter((x) => x.sample_ok && x.rate_ok && x.raw_p_ok && !x.holm_ok).map((x) => x.threshold) });

    /* 5. score S, position by position */
    const seasonArms = { engine: [], flat_half: [], flat_one: [], no_shrink: [], cf_engine: [], cf_flat_half: [], cf_flat_one: [] };
    for (const raw of test) {
      const y = yOf(raw), mkt = mktOf(raw);
      if (y == null || mkt == null) continue;
      const r = Object.assign({}, raw, { model: modelOf(raw), mkt, y });
      const fair = fairOf(r);
      /* both sides, through the pricing kernel's own cover curve */
      const sides = market === 'total' ? ['over', 'under'] : ['home', 'away'];
      for (const side of sides) {
        const sgn = market === 'total' ? (side === 'over' ? 1 : -1) : (side === 'home' ? 1 : -1);
        /* the selection's own line and the fair line, in the SAME convention
           the pricing kernel uses: a betting line for a spread (negative =
           laying points), the total itself for a total. The fair spread line
           is minus the predicted margin. */
        const selLine = market === 'total' ? mkt : sgn * r.close;
        const fairSel = market === 'total' ? fair : sgn * -fair;
        const at = market === 'total'
          ? (() => { const z = (mkt - fair) / sigma; const pOver = 1 - normCdf(z); return { cover: side === 'over' ? pOver : 1 - pOver, push: 0 }; })()
          : P.coverAt(fairSel, selLine, sigma);
        if (!at || at.cover == null) continue;
        const odds = market === 'total'
          ? (side === 'over' ? r.over_odds : r.under_odds)
          : (side === 'home' ? r.home_odds : r.away_odds);
        const american = odds != null ? odds : -110;
        /* the reliability inputs, every one from the tune window or the row */
        const relInputs = {
          tier: tier.tier, calibration_available: true,
          sample_n: tier.required_edge_points != null ? table[String(tier.required_edge_points)].n : withModel.length,
          data_completeness: 0.5 + (r.qb_known ? 0.25 : 0) + (r.weather_known ? 0.25 : 0),
          quote_freshness: 'CURRENT', book_confirmed: true, min_book_families: settings.minimum_book_families,
          availability_state: r.qb_known ? 'PROJECTED' : 'UNKNOWN',
          distribution_validated: true, model_version_validated: tier.tier === 'VALIDATED' || tier.tier === 'LEAN',
        };
        const cand = {
          id: [sport, r.id, market, side].join('|'), sport, game_id: String(r.id),
          matchup: r.away_team + ' at ' + r.home_team, home: r.home_team, away: r.away_team,
          kickoff: null, market: market === 'total' ? 'totals' : 'spreads', side,
          selection: market === 'total' ? (side === 'over' ? 'Over' : 'Under') : (side === 'home' ? r.home_team : r.away_team),
          line: selLine,
          quote: { book: 'consensus close', odds_american: american, odds_decimal: null, captured_at: '1970-01-01T00:00:00Z', freshness: 'CURRENT', executable: true, actionable: true, age_seconds: 0 },
          probability_source: 'MODEL_BLEND', fair_method: 'MODEL_BLEND',
          model_probability: at.cover, calibrated_probability: at.cover,
          no_vig_market_probability: null, push_probability: at.push || 0,
          fair_selection_line: fairSel, sigma,
          /* the measured bound replaces the reliability shrink when it exists */
          bootstrap_shift_points: boot.ok ? boot.shift_points_p10 : null,
          bootstrap_basis: boot.ok ? boot.basis : null,
          tier: tier.tier, tier_basis: tier.basis, calibration_available: true, calibration_version: 'walk-forward ' + Sn,
          model_version: (useEngine ? 'engine_blend_' : 'rating_blend_') + Sn, model_version_validated: relInputs.model_version_validated,
          distribution_validated: true, sample_n: relInputs.sample_n, data_completeness: relInputs.data_completeness,
          book_confirmed: true, availability_state: relInputs.availability_state,
          counter: 'a backtest position', invalidation: [], primary_reason: 'walk-forward',
        };
        /* the engine, and the same engine with the shrink switched off */
        const rec = S.evaluate(cand, { settings, timezone: 'UTC', now: 0 });
        const noShrink = S.evaluate(Object.assign({}, cand, { lower_bound: at.cover, lower_bound_basis: 'shrinkage disabled for the ablation arm' }), { settings, timezone: 'UTC', now: 0 });
        /* the outcome of THIS side at THIS number */
        const covered = market === 'total'
          ? (side === 'over' ? (y > mkt ? 1 : y === mkt ? 0.5 : 0) : (y < mkt ? 1 : y === mkt ? 0.5 : 0))
          : (() => { const c = sgn * (r.margin + r.close); return c > 0 ? 1 : c === 0 ? 0.5 : 0; })();
        const dec = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
        const payoff = (u) => covered === 1 ? u * (dec - 1) : covered === 0.5 ? 0 : -u;
        if (rec.recommended_units > 0) {
          seasonArms.engine.push(payoff(rec.recommended_units));
          seasonArms.flat_half.push(payoff(0.5));
          seasonArms.flat_one.push(payoff(1));
          probs.push({ p_cal: rec.calibrated_probability, p_cons: rec.conservative_probability, won: covered, reliability: rec.reliability_score, units: rec.recommended_units, season: Sn });
          if (r.open != null && market === 'spread') {
            /* the points this side got at the OPENER against the close, from
               the selection's own side: +1.5 means the opener gave it a point
               and a half more than the close did */
            clv.push(r3(sgn * r.open - selLine));
          }
        }
        if (noShrink.recommended_units > 0) seasonArms.no_shrink.push(payoff(noShrink.recommended_units));
        /* THE COUNTERFACTUAL ARM, and it is a counterfactual on purpose.
           A market whose tier is RESEARCH is refused a stake, which is the
           right answer and leaves nothing to compare — so the sizing RULES
           would go unmeasured in exactly the markets that matter most. This
           arm re-runs the same candidate with the tier forced to LEAN and
           records what the engine WOULD have staked. It answers "do these
           sizing rules beat flat staking", it is never a claim that the
           market is playable, and it can never move a MODE. */
        const cf = S.evaluate(Object.assign({}, cand, { tier: 'LEAN', model_version_validated: true }), { settings, timezone: 'UTC', now: 0 });
        if (cf.recommended_units > 0) {
          seasonArms.cf_engine.push(payoff(cf.recommended_units));
          seasonArms.cf_flat_half.push(payoff(0.5));
          seasonArms.cf_flat_one.push(payoff(1));
          cfUnits.push(cf.recommended_units);
          cfProbs.push({ p_cal: cf.calibrated_probability, p_cons: cf.conservative_probability, won: covered });
        }
      }
    }
    perSeason.push({ season: Sn, tier: tier.tier, positions: seasonArms.engine.length,
      engine_units: r3(seasonArms.engine.reduce((s, x) => s + x, 0)),
      flat_half_units: r3(seasonArms.flat_half.reduce((s, x) => s + x, 0)),
      flat_one_units: r3(seasonArms.flat_one.reduce((s, x) => s + x, 0)) });
    Object.keys(arms).forEach((k) => { arms[k] = arms[k].concat(seasonArms[k]); });
  }

  /* ------------------------------------------------------------- the score
     Extracted so the spread, total and moneyline arms are scored by the SAME
     code. Three copies of "engine against flat" is three chances for one of
     them to quietly measure something else. */
  return scoreArms({ market, arms, probs, clv, perSeason, holdouts, refused,
    counterfactual: { units: cfUnits, probs: cfProbs } });
}

/**
 * Turn the collected arms into the report block: the record, the money
 * against both flat baselines, the risk, the calibration, the shrinkage
 * ablation, the CLV, and the MODE the staking kernel reads.
 */
function scoreArms(o) {
  const market = o.market, arms = o.arms, probs = o.probs, clv = o.clv || [];
  const perSeason = o.perSeason || [], holdouts = o.holdouts || [], refused = o.refused || [];
  const cfUnits = o.counterfactual ? o.counterfactual.units : [];
  const cfProbs = o.counterfactual ? o.counterfactual.probs : [];
  const staked = probs.reduce((s, x) => s + x.units, 0);
  const engineProfit = arms.engine.reduce((s, x) => s + x, 0);
  const halfProfit = arms.flat_half.reduce((s, x) => s + x, 0);
  const oneProfit = arms.flat_one.reduce((s, x) => s + x, 0);
  const noShrinkProfit = (arms.no_shrink || []).reduce((s, x) => s + x, 0);
  const graded = probs.filter((x) => x.won !== 0.5);
  const brierCal = graded.length ? mean(graded.map((x) => Math.pow(x.p_cal - x.won, 2))) : null;
  const brierCons = graded.length ? mean(graded.map((x) => Math.pow(x.p_cons - x.won, 2))) : null;
  const logLossCal = graded.length ? mean(graded.map((x) => -(x.won ? Math.log(Math.max(1e-9, x.p_cal)) : Math.log(Math.max(1e-9, 1 - x.p_cal))))) : null;
  const logLossCons = graded.length ? mean(graded.map((x) => -(x.won ? Math.log(Math.max(1e-9, x.p_cons)) : Math.log(Math.max(1e-9, 1 - x.p_cons))))) : null;
  const wins = probs.filter((x) => x.won === 1).length, losses = probs.filter((x) => x.won === 0).length, pushes = probs.filter((x) => x.won === 0.5).length;
  const roi = staked > 0 ? engineProfit / staked : null;
  const roiHalf = arms.flat_half.length ? halfProfit / (0.5 * arms.flat_half.length) : null;
  const roiOne = arms.flat_one.length ? oneProfit / arms.flat_one.length : null;
  const beatsHalf = roi != null && roiHalf != null && engineProfit > halfProfit;
  const beatsOne = roi != null && roiOne != null && engineProfit > oneProfit;
  const enough = probs.length >= RULES.mode.min_positions;
  const mode = !probs.length ? 'RESEARCH_ONLY'
    : (enough && roi > 0 && beatsHalf && beatsOne) ? 'BET' : 'SHADOW';
  const basis = !probs.length
    ? 'the engine sized no position in this market on the held-out window: every candidate failed a gate, so there is nothing to grade and the market is research only'
    : mode === 'BET'
      ? 'on ' + probs.length + ' held-out positions the engine returned ' + r3(engineProfit) + 'u on ' + r3(staked) + 'u staked (ROI ' + (roi * 100).toFixed(2) + '%), beating flat 0.5u (' + r3(halfProfit) + 'u) and flat 1u (' + r3(oneProfit) + 'u)'
      : 'the engine sized ' + probs.length + ' held-out positions and returned ' + r3(engineProfit) + 'u on ' + r3(staked) + 'u staked (ROI ' + (roi == null ? '—' : (roi * 100).toFixed(2) + '%') + '), against flat 0.5u ' + r3(halfProfit) + 'u and flat 1u ' + r3(oneProfit) + 'u'
        + (!enough ? '; and ' + probs.length + ' positions is below the ' + RULES.mode.min_positions + '-position floor' : '')
        + '. SHADOW: it runs and records, and it does not recommend.';

  /* THE POOLED SHIFT THE LIVE KERNEL READS.
     Each held-out season measured the blend's own uncertainty on its own tune
     window; the median across them is the stable number to carry forward, and
     the spread is reported beside it so a reader can see whether the seasons
     agreed. A market whose seasons disagree wildly has not measured anything. */
  const shifts = holdouts.map((h) => (h.bootstrap && h.bootstrap.shift_points_p10 != null ? h.bootstrap.shift_points_p10 : null)).filter((x) => x != null).sort((a, b) => a - b);
  const pooledShift = shifts.length ? shifts[Math.floor(shifts.length / 2)] : null;
  return {
    market, positions: probs.length, units_staked: r3(staked),
    bootstrap_shift_points: pooledShift,
    bootstrap_basis: shifts.length
      ? 'the median of ' + shifts.length + ' per-season bootstrap measurements of the blend\'s own uncertainty (range ' + shifts[0] + ' to ' + shifts[shifts.length - 1] + ' points)'
      : null,
    record: { wins, losses, pushes, win_pct: (wins + losses) ? r4(wins / (wins + losses)) : null },
    money: {
      engine_units: r3(engineProfit), engine_roi_on_staked: r4(roi),
      flat_half_units: r3(halfProfit), flat_half_roi: r4(roiHalf),
      flat_one_units: r3(oneProfit), flat_one_roi: r4(roiOne),
      beats_flat_half: beatsHalf, beats_flat_one: beatsOne,
      note: 'ROI is profit over units actually staked. The two flat arms take the SAME selections at the SAME prices, so the only difference is the sizing.',
    },
    risk: {
      engine_max_drawdown_units: drawdown(arms.engine),
      flat_half_max_drawdown_units: drawdown(arms.flat_half),
      flat_one_max_drawdown_units: drawdown(arms.flat_one),
    },
    calibration: {
      brier_calibrated: r4(brierCal), brier_conservative: r4(brierCons),
      log_loss_calibrated: r4(logLossCal), log_loss_conservative: r4(logLossCons),
      graded: graded.length,
      note: 'the conservative probability is deliberately pessimistic, so a WORSE Brier than the calibrated one is expected and is not a fault; what matters is whether it stakes better.',
    },
    shrinkage: {
      engine_units: r3(engineProfit), no_shrink_units: r3(noShrinkProfit),
      no_shrink_positions: (arms.no_shrink || []).length,
      helps: noShrinkProfit != null && engineProfit > noShrinkProfit,
      verdict: (arms.no_shrink || []).length === 0 ? 'the ablation arm sized nothing, so shrinkage cannot be compared here'
        : engineProfit > noShrinkProfit ? 'shrinkage HELPED out of sample: the shrunk engine returned ' + r3(engineProfit) + 'u against ' + r3(noShrinkProfit) + 'u without it'
          : 'shrinkage did NOT help out of sample on this market (' + r3(engineProfit) + 'u with, ' + r3(noShrinkProfit) + 'u without); it is kept because it is the conservative direction and the sample is thin, and this line says so',
    },
    clv: { positions: clv.length, mean_points: r3(mean(clv)), note: clv.length ? 'the points the engine’s side got at the OPENER against the close; positive means the opening number was better' : 'no opener on file for the sized positions' },
    counterfactual_lean: o.counterfactual === null ? null : (() => {
      const st = cfUnits.reduce((a, b) => a + b, 0);
      const e = (arms.cf_engine || []).reduce((a, b) => a + b, 0);
      const h = (arms.cf_flat_half || []).reduce((a, b) => a + b, 0);
      const o = (arms.cf_flat_one || []).reduce((a, b) => a + b, 0);
      const gradedCf = cfProbs.filter((x) => x.won !== 0.5);
      return {
        what_this_is: 'NOT A RESULT AND NOT A RECOMMENDATION. The same held-out positions re-sized with the validation tier forced to LEAN, so the SIZING RULES can be compared against flat staking even where the real tier refuses to stake. It cannot change a MODE and no number in it describes a market EdgeDesk would bet.',
        positions: (arms.cf_engine || []).length, units_staked: r3(st),
        engine_units: r3(e), engine_roi_on_staked: st > 0 ? r4(e / st) : null,
        flat_half_units: r3(h), flat_one_units: r3(o),
        beats_flat_half: (arms.cf_engine || []).length > 0 && e > h, beats_flat_one: (arms.cf_engine || []).length > 0 && e > o,
        engine_max_drawdown_units: drawdown((arms.cf_engine || [])),
        flat_half_max_drawdown_units: drawdown((arms.cf_flat_half || [])),
        flat_one_max_drawdown_units: drawdown((arms.cf_flat_one || [])),
        brier_calibrated: gradedCf.length ? r4(mean(gradedCf.map((x) => Math.pow(x.p_cal - x.won, 2)))) : null,
        brier_conservative: gradedCf.length ? r4(mean(gradedCf.map((x) => Math.pow(x.p_cons - x.won, 2)))) : null,
        reading: !(arms.cf_engine || []).length ? 'nothing was sized even with the tier forced, so the rules cannot be compared here'
          : (e > h && e > o) ? 'the sizing rules beat both flat arms on these positions, mostly by staking less on the thin ones: engine ' + r3(e) + 'u on ' + r3(st) + 'u staked against flat 0.5u ' + r3(h) + 'u and flat 1u ' + r3(o) + 'u'
            : 'the sizing rules did not beat both flat arms on these positions (engine ' + r3(e) + 'u, flat 0.5u ' + r3(h) + 'u, flat 1u ' + r3(o) + 'u)',
      };
    })(),
    per_season: perSeason, holdouts, refused_seasons: refused,
    ats_on_last_tune_window: holdouts.length ? holdouts[holdouts.length - 1] : null,
    mode, mode_basis: basis,
  };
}

function build(sport) {
  const src = sport === 'nfl' ? nflRows() : cfbRows();
  const key = sport === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';
  if (src.error) {
    return { schema: SCHEMA, sport: key, generated_at: new Date().toISOString(), error: src.error,
      markets: { spread: { market: 'spread', mode: 'RESEARCH_ONLY', mode_basis: src.error, positions: 0 }, total: { market: 'total', mode: 'RESEARCH_ONLY', mode_basis: src.error, positions: 0 }, moneyline: { market: 'moneyline', mode: 'RESEARCH_ONLY', mode_basis: src.error, positions: 0 } },
      note: 'No archive, no validation, no recommendation. The staking kernel reads this file and refuses to stake a market it cannot grade.' };
  }
  const spread = runMarket({ rows: src.rows, market: 'spread', sport: key });
  const total = runMarket({ rows: src.rows.filter((r) => r.close_total != null && r.points != null), market: 'total', sport: key });
  const moneyline = runMoneyline({ rows: src.rows, sport: key });
  return {
    schema: SCHEMA, sport: key, generated_at: new Date().toISOString(),
    frame: {
      archive: src.source, games: src.games, rows_used: src.rows.length,
      rating: sport === 'nfl'
        ? 'an Elo computed by this script from the archive’s own results in kickoff order, with a between-season regression to the mean; a game is rated by the state BEFORE it, so no result prices its own game'
        : 'the pregame Elo the sportsdataverse schedules carry, which is independent of the market',
      engine: src.engine || { available: false, why: 'not attempted for this sport' },
      model_graded: src.engine && src.engine.available
        ? 'the SHIPPED engine (football/engine.js), replayed cold and joined to ' + src.engine.joined + ' of ' + src.games + ' archive games; per-market use is all-or-nothing and each holdout says which it got in model_source'
        : 'the Elo stand-in, because the engine replay was unavailable here (' + ((src.engine && src.engine.why) || 'not attempted') + '). A validation on the stand-in proves the SIZING RULES and says nothing about the number the desk quotes.',
      blend: 'margin ~ a + b*market + c*(model - market), the same form the shipped pricer uses, fitted on the seasons BEFORE each held-out season',
      holdout_window: RULES.first_holdout + ' onward, one season at a time',
      policy: RULES.policy,
      leakage: 'no closing line enters a pregame feature; the close is the MARKET the position is taken at. Nothing is fitted on the season it is scored on, and no threshold is chosen on the evaluation window.',
      caveats: [
        src.engine && src.engine.available
          ? 'the model graded here is the shipped engine replayed cold, but the REPLAY is not the live data path: it reconstructs each week from committed feeds rather than from the board the desk saw, so a small gap between this and production is expected'
          : 'the rating line is NOT the shipped football engine: the engine replay needs per-game team-week feeds that are not committed, so this validates the SIZING ENGINE over a reproducible model rather than over the production projection',
        'the total arm uses the tune-window mean total as its model, which is deliberately weak — it is there to prove the engine PASSES on a market with no real edge, not to claim one',
        'prices are the archive’s consensus close, or -110 where the archive carries no price; a real board would be line-shopped and slightly better',
        'a backtest cannot reproduce quote freshness, book agreement or availability certainty, so those reliability components are held at their documented values and the run is a test of the SIZING RULES, not of the live data path',
      ],
    },
    rules: RULES, markets: { spread, total, moneyline },
    note: 'A market is BET only where the engine beat BOTH flat baselines on the held-out window with a positive ROI and a usable sample. Everything else is SHADOW or RESEARCH ONLY: it runs, it records, it does not recommend.',
  };
}

function print(rep) {
  console.log('staking validation — ' + rep.sport + (rep.error ? ' (' + rep.error + ')' : ''));
  if (rep.frame) console.log('  ' + rep.frame.rows_used + ' rows from ' + rep.frame.archive + '; held out ' + rep.frame.holdout_window);
  ['spread', 'total', 'moneyline'].forEach((k) => {
    const m = rep.markets[k]; if (!m) return;
    console.log('  ' + k.padEnd(7) + ' MODE ' + String(m.mode).padEnd(14) + ' positions ' + String(m.positions).padStart(5)
      + (m.money ? '  engine ' + String(m.money.engine_units).padStart(8) + 'u  flat0.5 ' + String(m.money.flat_half_units).padStart(8) + 'u  flat1 ' + String(m.money.flat_one_units).padStart(8) + 'u  ROI ' + String(m.money.engine_roi_on_staked) : ''));
    if (m.risk) console.log('          drawdown engine ' + m.risk.engine_max_drawdown_units + 'u / flat1 ' + m.risk.flat_one_max_drawdown_units + 'u'
      + (m.calibration ? '  brier cal ' + m.calibration.brier_calibrated + ' cons ' + m.calibration.brier_conservative : ''));
    if (m.shrinkage && m.shrinkage.verdict) console.log('          ' + m.shrinkage.verdict);
    if (m.counterfactual_lean && m.counterfactual_lean.reading) console.log('          [counterfactual, tier forced to LEAN, never a recommendation] ' + m.counterfactual_lean.reading
      + (m.counterfactual_lean.positions ? '; drawdown ' + m.counterfactual_lean.engine_max_drawdown_units + 'u vs flat1 ' + m.counterfactual_lean.flat_one_max_drawdown_units + 'u' : ''));
    console.log('          ' + m.mode_basis);
  });
}

function main() {
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--sport')) || '').split('=')[1] || (args.includes('--sport') ? args[args.indexOf('--sport') + 1] : null);
  const sports = only ? [only] : ['nfl', 'cfb'];
  const out = {};
  for (const s of sports) {
    const rep = build(s);
    out[s] = rep;
    if (args.includes('--json')) console.log(JSON.stringify(rep, null, 1));
    else print(rep);
    if (args.includes('--write')) {
      const file = path.join(OUT_DIR, 'staking_' + s + '.json');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rep, null, 1) + '\n');
      console.log('  wrote ' + path.relative(ROOT, file));
    }
  }
  return out;
}
module.exports = { build, runMarket, runMoneyline, scoreArms, atsTable, moneylineTable, tierFrom, holmAdjust, drawdown, ols, logistic, nflRows, cfbRows, RULES, SCHEMA };
if (require.main === module) main();
