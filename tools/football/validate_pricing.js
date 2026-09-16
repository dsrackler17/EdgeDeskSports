#!/usr/bin/env node
/* ===========================================================================
   THE PRICING VALIDATION — does the desk's number deserve a bet-to price?

   Replays the SHIPPED NFL engine (football/engine.js) cold, in kickoff order,
   from 2006, and scores 2016-2025 against the closing archive
   (football/pricing/lines_nfl.json). The parameters were frozen on seasons
   <= 2015 (football/params.js validation_summary), so every scored game is
   out of sample for the engine, and every blend below is fitted on seasons
   BEFORE the season it is scored on. Nothing here is fitted on the games it
   is graded against.

   WHAT IT MEASURES, PER MARKET (spread, total, moneyline)
     model vs close          MAE of the raw projection and of the close
     the blend               margin ~ a + b*close + c*(model - close), fitted
                             on 2016..S-1 and scored on S, for S = 2019..2025
                             (three tune seasons minimum). c is the model's
                             INCREMENTAL information over the market.
     ATS by threshold        pick the side the blend (and the raw model)
                             favours when it disagrees with the close by >= t
                             points; win / push / loss; one-sided binomial p
     calibration             P(cover) from the blend's residual sigma, in
                             buckets, against the observed cover rate; Brier
     required edge           the smallest threshold that cleared break-even
                             (52.38% at -110) with p < 0.05 on the held-out
                             seasons; null when none did
     tier                    VALIDATED   the model side beat the close by a
                                         full point above break-even (53.5%+)
                                         with p < 0.01, n >= 500, in most
                                         seasons, and held up on 2019-2025
                             LEAN        the model side cleared break-even
                                         (52.38%+ at -110) with p < 0.05,
                                         n >= 300, in most seasons: not a
                                         losing side, not yet a profit
                             PROBABILITY no threshold cleared; the cover
                                         probabilities are calibrated (Brier
                                         beats 0.25 by 0.002 held out)
                             RESEARCH    none of the above

   The output, football/validation/pricing_nfl.json, is what the pricing
   kernel reads. It carries the negative results as plainly as any positive
   one, because a bet-to price built on an unvalidated edge is an invented
   number.

   CFB: the shipped Power 4 backtest (football/cfb_p4/research/report/*) is the
   same kind of evidence; --sport cfb copies its ATS-by-disagreement and
   open-to-close tables into football/validation/pricing_cfb.json with the
   same tier rule, and says where every number came from.

   Usage
     node tools/football/validate_pricing.js               # NFL replay (fetches missing team-week seasons)
     node tools/football/validate_pricing.js --offline     # cached feeds only
     node tools/football/validate_pricing.js --sport cfb   # copy the CFB report
     node tools/football/validate_pricing.js --check       # exit 1 if the artifact is stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));

const SCHEMA = 'edgedesk_pricing_validation_v1';
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
const STW = (s) => path.join(CACHE, ('https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + s + '.csv').replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const ARCHIVE = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
const OUT_DIR = path.join(ROOT, 'football', 'validation');
const BREAK_EVEN = 0.5238; /* -110 both ways */
const THRESHOLDS = [0.5, 1, 1.5, 2, 3, 4, 6];
const RULES = { first_eval: 2016, first_holdout: 2019, last: 2025, break_even: BREAK_EVEN, replay_from: 2006, brier_margin: 0.002, min_cal_n: 100,
  validated: { win_pct: 0.535, p_max: 0.01, min_n: 500 }, lean: { win_pct: BREAK_EVEN, p_max: 0.05, min_n: 300 },
  thresholds_tested: THRESHOLDS.length, multiple_comparisons: 'seven thresholds are read; the VALIDATED p-threshold of 0.01 is the allowance for that, and a threshold must also hold on the later 2019-2025 sub-window' };

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function binomP(wins, n) { /* one-sided P(X >= wins | p = .5), normal approx with continuity */ if (!n) return null; const z = (wins - 0.5 - n / 2) / Math.sqrt(n / 4); return r4(1 - normCdf(z)); }

/** ordinary least squares: y ~ 1 + X (X rows without the intercept) */
function ols(rows, xf, yf) {
  const k = xf.length + 1; const A = Array.from({ length: k }, () => new Array(k).fill(0)); const b = new Array(k).fill(0);
  rows.forEach((r) => { const x = [1].concat(xf.map((f) => f(r))); const y = yf(r); for (let i = 0; i < k; i++) { b[i] += x[i] * y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; } });
  /* gaussian elimination */
  for (let i = 0; i < k; i++) { let p = i; for (let r2 = i + 1; r2 < k; r2++) if (Math.abs(A[r2][i]) > Math.abs(A[p][i])) p = r2; [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]]; const d = A[i][i] || 1e-12; for (let r2 = 0; r2 < k; r2++) { if (r2 === i) continue; const f = A[r2][i] / d; for (let c = i; c < k; c++) A[r2][c] -= f * A[i][c]; b[r2] -= f * b[i]; } }
  const coef = b.map((v, i) => v / (A[i][i] || 1e-12));
  const pred = (r) => coef[0] + xf.reduce((s, f, i) => s + coef[i + 1] * f(r), 0);
  const resid = rows.map((r) => yf(r) - pred(r));
  const sigma = Math.sqrt(mean(resid.map((e) => e * e)) || 0);
  return { coef, pred, sigma };
}

/* ------------------------------------------------------------- the replay */
function replayNfl(archive, opts) {
  const games = archive.games.filter((g) => g.margin != null && g.season >= RULES.replay_from && g.season <= RULES.last && g.close.home_line != null);
  const stwByGame = {}; const seasonsLoaded = [];
  for (let s = RULES.replay_from; s <= RULES.last; s++) {
    const p = STW(s); if (!fs.existsSync(p)) continue; seasonsLoaded.push(s);
    R.parseCsv(fs.readFileSync(p, 'utf8')).forEach((x) => { (stwByGame[x.game_id] = stwByGame[x.game_id] || []).push(x); });
  }
  /* cold state: the shipped seeds contain the seasons being scored, so they are discarded */
  const st = E.nfl.newState(); st.team = {}; st.ngames = {}; st.teamQb = {}; st.qb = {}; st.seededThrough = RULES.replay_from - 1;
  games.sort((a, b) => a.season - b.season || String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const rows = []; let season = null, absorbed = 0, refused = 0, noRows = 0;
  games.forEach((g) => {
    if (season != null && g.season !== season) E.nfl.seasonBreak(st);
    season = g.season;
    if (g.season >= RULES.first_eval) {
      const req = { sport: 'nfl', state: st, season: g.season, game: { home: g.home, away: g.away, week: g.week, home_rest: g.ctx.home_rest, away_rest: g.ctx.away_rest, roof: g.ctx.roof, surface: g.ctx.surface, div_game: g.ctx.divisional ? 1 : 0, temp: g.ctx.temp, wind: g.ctx.wind, home_qb_id: g.ctx.home_qb_id, away_qb_id: g.ctx.away_qb_id }, market: { spread_line: -g.close.home_line, total_line: g.close.total } };
      let p = null; try { p = E.predictGame(req); } catch (_) { p = null; }
      if (p && p.status === 'PREDICTED' && (st.ngames[g.home] || 0) >= 8 && (st.ngames[g.away] || 0) >= 8) {
        rows.push({ id: g.id, season: g.season, week: g.week, type: g.type, model: p.model.fair_spread, close: -g.close.home_line, margin: g.margin, model_total: p.model.fair_total, close_total: g.close.total, points: g.points, p_home: p.model.home_win_prob, ml_home: g.close.home_moneyline, ml_away: g.close.away_moneyline,
          ctx: { dome: g.ctx.roof === 'dome' || g.ctx.roof === 'closed', temp: g.ctx.temp, wind: g.ctx.wind, rest_diff: (g.ctx.home_rest != null && g.ctx.away_rest != null) ? g.ctx.home_rest - g.ctx.away_rest : null, divisional: !!g.ctx.divisional, grass: g.ctx.surface === 'grass', qb_known: !!(g.ctx.home_qb_id && g.ctx.away_qb_id) } });
      } else refused++;
    }
    const pair = stwByGame[g.id];
    if (!pair || pair.length !== 2) { noRows++; return; }
    const h = pair.find((x) => x.team === g.home), a = pair.find((x) => x.team === g.away);
    if (!h || !a) { noRows++; return; }
    const hr = E.nfl.teamGameFromStw(h), ar = E.nfl.teamGameFromStw(a);
    hr.pts_for = g.home_score; hr.pts_against = g.away_score; ar.pts_for = g.away_score; ar.pts_against = g.home_score;
    E.nfl.absorbGame(st, [[g.home, hr], [g.away, ar]], []);
    absorbed++;
  });
  return { rows, absorbed, refused, no_rows: noRows, seasons_loaded: seasonsLoaded };
}

/* -------------------------------------------------------- the scoring */
function atsTable(rows, lineOf, pickOf, resultOf) {
  /* pickOf(r) = signed disagreement (positive = take the home side); resultOf(r) = home margin vs the line */
  const out = {};
  THRESHOLDS.forEach((t) => {
    let n = 0, w = 0, push = 0; const bySeason = {};
    rows.forEach((r) => {
      const d = pickOf(r); if (d == null || Math.abs(d) < t) return;
      const res = resultOf(r); if (res == null) return;
      const s = (bySeason[r.season] = bySeason[r.season] || { n: 0, w: 0 });
      if (res === 0) { push++; return; }
      n++; s.n++; const win = (d > 0 && res > 0) || (d < 0 && res < 0); if (win) { w++; s.w++; }
    });
    out[String(t)] = { n, wins: w, pushes: push, win_pct: n ? r4(w / n) : null, p_one_sided: binomP(w, n), seasons_above_half: Object.keys(bySeason).filter((s) => bySeason[s].n >= 20 && bySeason[s].w / bySeason[s].n > 0.5).length, seasons_scored: Object.keys(bySeason).filter((s) => bySeason[s].n >= 20).length };
  });
  return out;
}
function passes(e, rule, later) {
  return !!(e && e.n >= rule.min_n && e.win_pct != null && e.win_pct >= rule.win_pct && e.p_one_sided != null && e.p_one_sided < rule.p_max && e.seasons_above_half * 2 >= e.seasons_scored && (!later || (later.n >= 50 && later.win_pct != null && later.win_pct > 0.5)));
}
/** the smallest threshold that earns a tier: [tier, threshold] on the OOS table, robustness-checked on the later sub-window */
function requiredEdge(table, laterTable) {
  for (const t of THRESHOLDS) { const e = table[String(t)], l = laterTable ? laterTable[String(t)] : null; if (passes(e, RULES.validated, l)) return ['VALIDATED', t]; }
  for (const t of THRESHOLDS) { const e = table[String(t)], l = laterTable ? laterTable[String(t)] : null; if (passes(e, RULES.lean, l)) return ['LEAN', t]; }
  return [null, null];
}
function calibration(pairs) { /* pairs: [p(home covers), covered 0/1] */
  const buckets = [[0, 0.4], [0.4, 0.48], [0.48, 0.52], [0.52, 0.6], [0.6, 1.01]];
  const table = buckets.map(([lo, hi]) => { const in_ = pairs.filter(([p]) => p >= lo && p < hi); return { bucket: lo + '-' + Math.min(hi, 1), n: in_.length, predicted: r4(mean(in_.map((x) => x[0]))), observed: r4(mean(in_.map((x) => x[1]))) }; });
  const brier = mean(pairs.map(([p, y]) => (p - y) * (p - y)));
  return { buckets: table, brier: r4(brier), brier_base_rate: 0.25, n: pairs.length };
}
function scoreMarket(rows, cfg) {
  /* cfg: modelOf, closeOf, actualOf */
  const evalRows = rows.filter((r) => cfg.modelOf(r) != null && cfg.closeOf(r) != null && cfg.actualOf(r) != null);
  const bySeason = {};
  evalRows.forEach((r) => { const s = (bySeason[r.season] = bySeason[r.season] || { n: 0, model: [], close: [] }); s.n++; s.model.push(Math.abs(cfg.actualOf(r) - cfg.modelOf(r))); s.close.push(Math.abs(cfg.actualOf(r) - cfg.closeOf(r))); });
  const seasons = {}; Object.keys(bySeason).forEach((s) => { seasons[s] = { n: bySeason[s].n, model_mae: r3(mean(bySeason[s].model)), close_mae: r3(mean(bySeason[s].close)) }; });
  /* time-separated blend */
  const holdouts = []; const held = []; const calPairs = []; const rawPairs = [];
  for (let S = RULES.first_holdout; S <= RULES.last; S++) {
    const tune = evalRows.filter((r) => r.season < S && r.season >= RULES.first_eval), test = evalRows.filter((r) => r.season === S);
    if (tune.length < 300 || !test.length) continue;
    const fit = ols(tune, [cfg.closeOf, (r) => cfg.modelOf(r) - cfg.closeOf(r)], cfg.actualOf);
    const closeFit = ols(tune, [cfg.closeOf], cfg.actualOf);
    const mae = mean(test.map((r) => Math.abs(cfg.actualOf(r) - fit.pred(r)))), cmae = mean(test.map((r) => Math.abs(cfg.actualOf(r) - cfg.closeOf(r))));
    holdouts.push({ season: S, tune_seasons: RULES.first_eval + '-' + (S - 1), n_tune: tune.length, n_test: test.length, coef: { intercept: r4(fit.coef[0]), close: r4(fit.coef[1]), model_minus_close: r4(fit.coef[2]) }, sigma_tune: r3(fit.sigma), blend_mae: r3(mae), close_mae: r3(cmae) });
    test.forEach((r) => { const b = fit.pred(r); held.push(Object.assign({}, r, { _blend: b, _sig: fit.sigma, _csig: closeFit.sigma })); const res = cfg.actualOf(r) - cfg.closeOf(r); if (res !== 0) { calPairs.push([normCdf((b - cfg.closeOf(r)) / fit.sigma), res > 0 ? 1 : 0]); rawPairs.push([normCdf((cfg.modelOf(r) - cfg.closeOf(r)) / closeFit.sigma), res > 0 ? 1 : 0]); } });
  }
  /* the pick rule a user would apply is the RAW disagreement, model minus close, so that is what is graded: over the whole
     out-of-sample window (the engine's parameters were frozen before it) and again on the later sub-window as a robustness check */
  const atsRaw = atsTable(evalRows, cfg.closeOf, (r) => cfg.modelOf(r) - cfg.closeOf(r), (r) => cfg.actualOf(r) - cfg.closeOf(r));
  const atsLater = atsTable(evalRows.filter((r) => r.season >= RULES.first_holdout), cfg.closeOf, (r) => cfg.modelOf(r) - cfg.closeOf(r), (r) => cfg.actualOf(r) - cfg.closeOf(r));
  const cal = calibration(calPairs), calRaw = calibration(rawPairs);
  const [edgeTier, edge] = requiredEdge(atsRaw, atsLater);
  const c = holdouts.length ? holdouts[holdouts.length - 1].coef.model_minus_close : null;
  const tier = edgeTier || (cal.n >= RULES.min_cal_n && cal.brier != null && cal.brier <= 0.25 - RULES.brier_margin ? 'PROBABILITY' : 'RESEARCH');
  return {
    n: evalRows.length, seasons, pooled: { model_mae: r3(mean(evalRows.map((r) => Math.abs(cfg.actualOf(r) - cfg.modelOf(r))))), close_mae: r3(mean(evalRows.map((r) => Math.abs(cfg.actualOf(r) - cfg.closeOf(r))))) },
    blend: { holdouts, pooled_holdout: { n: held.length, blend_mae: r3(mean(held.map((r) => Math.abs(cfg.actualOf(r) - r._blend)))), close_mae: r3(mean(held.map((r) => Math.abs(cfg.actualOf(r) - cfg.closeOf(r))))) }, latest_coef: holdouts.length ? holdouts[holdouts.length - 1].coef : null, latest_sigma: holdouts.length ? holdouts[holdouts.length - 1].sigma_tune : null, incremental_information: c == null ? null : (c > 0.05 ? 'the model adds information over the close' : 'the model adds no usable information over the close') },
    ats_vs_close: { raw_model_oos: atsRaw, raw_model_later: atsLater, window_oos: RULES.first_eval + '-' + RULES.last, window_later: RULES.first_holdout + '-' + RULES.last, pick_rule: 'take the side the raw model favours when it disagrees with the close by at least the threshold; pushes excluded' },
    calibration: { blend_held_out: cal, raw_model_held_out: calRaw, basis: 'P(cover at the close) = Phi((fair - close) / sigma) with fair the time-separated blend (or the raw model with the close-only sigma), scored on 2019-2025' },
    required_edge_points: edge, tier,
    tier_basis: tier === 'VALIDATED' ? 'a disagreement of ' + edge + '+ points beat the close by a point above break-even with p < ' + RULES.validated.p_max + ' over ' + RULES.first_eval + '-' + RULES.last + ' and held on ' + RULES.first_holdout + '-' + RULES.last
      : tier === 'LEAN' ? 'a disagreement of ' + edge + '+ points cleared break-even (' + atsRaw[String(edge)].win_pct + ' over n=' + atsRaw[String(edge)].n + ', p ' + atsRaw[String(edge)].p_one_sided + ') but not a point above it: the model side is not a losing side at -110, and it is not yet a profit'
      : (tier === 'PROBABILITY' ? 'no disagreement threshold cleared break-even; the cover probabilities are calibrated (Brier ' + cal.brier + ' vs 0.25)' : 'no disagreement threshold cleared break-even and the cover probabilities do not beat the base rate'),
  };
}
function scoreMoneyline(rows) {
  const ev = rows.filter((r) => r.p_home != null && r.ml_home != null && r.ml_away != null && r.margin != null && r.margin !== 0);
  const imp = (am) => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  const mk = (r) => { const h = imp(r.ml_home), a = imp(r.ml_away); return h / (h + a); };
  const y = (r) => (r.margin > 0 ? 1 : 0);
  const logit = (p) => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const holdouts = []; const heldPairs = []; const mktPairs = []; const rawPairs = [];
  for (let S = RULES.first_holdout; S <= RULES.last; S++) {
    const tune = ev.filter((r) => r.season < S && r.season >= RULES.first_eval), test = ev.filter((r) => r.season === S);
    if (tune.length < 300 || !test.length) continue;
    /* a two-feature logistic-ish blend fitted by least squares on the logit scale: a proxy that is honest enough for a tier decision */
    const fit = ols(tune, [(r) => logit(mk(r)), (r) => logit(r.p_home) - logit(mk(r))], (r) => logit(y(r) ? 0.9 : 0.1));
    holdouts.push({ season: S, n_test: test.length, coef: { market: r4(fit.coef[1]), model_minus_market: r4(fit.coef[2]) } });
    test.forEach((r) => { heldPairs.push([sig(fit.pred(r)), y(r)]); mktPairs.push([mk(r), y(r)]); rawPairs.push([r.p_home, y(r)]); });
  }
  const b = (pairs) => r4(mean(pairs.map(([p, yy]) => (p - yy) * (p - yy))));
  const brier = { blend_held_out: b(heldPairs), market_devigged: b(mktPairs), raw_model: b(rawPairs), n: heldPairs.length };
  const tier = brier.n >= RULES.min_n && brier.blend_held_out != null && brier.market_devigged != null && brier.blend_held_out < brier.market_devigged - 0.001 ? 'PROBABILITY' : 'RESEARCH';
  return { n: ev.length, holdouts, brier, tier, tier_basis: tier === 'PROBABILITY' ? 'the blended win probability beats the de-vigged market Brier on the held-out seasons' : 'the model does not improve on the de-vigged market win probability; the market is the fair price', required_edge_points: null };
}

/* ------------------------------------------------ the feature intake */
/** Candidate corrections to the blend, each fitted on seasons before S and scored on S, paired against the blend itself.
    A candidate EARNS nothing here: the verdict is written to feature-status-nfl.json for a reviewed change, never applied. */
const FEATURE_RULES = { min_holdout_seasons: 2, p_max: 0.05, min_pooled_improvement: 0.02, max_season_degradation: 0.15 };
const CANDIDATES = {
  spread: [
    { id: 'rest_diff', label: 'rest-day difference (home minus away)', f: (r) => (r.ctx && r.ctx.rest_diff != null ? r.ctx.rest_diff : 0) },
    { id: 'divisional', label: 'division game', f: (r) => (r.ctx && r.ctx.divisional ? 1 : 0) },
    { id: 'dome', label: 'dome or closed roof', f: (r) => (r.ctx && r.ctx.dome ? 1 : 0) },
    { id: 'cold', label: 'kickoff temperature below 40F (outdoors)', f: (r) => (r.ctx && !r.ctx.dome && r.ctx.temp != null && r.ctx.temp < 40 ? 1 : 0) },
    { id: 'wind', label: 'wind above 15 mph (outdoors)', f: (r) => (r.ctx && !r.ctx.dome && r.ctx.wind != null && r.ctx.wind > 15 ? 1 : 0) },
    { id: 'qb_unknown', label: 'a starting quarterback unknown to the feed', f: (r) => (r.ctx && !r.ctx.qb_known ? 1 : 0) },
  ],
  total: [
    { id: 'dome', label: 'dome or closed roof', f: (r) => (r.ctx && r.ctx.dome ? 1 : 0) },
    { id: 'cold', label: 'kickoff temperature below 40F (outdoors)', f: (r) => (r.ctx && !r.ctx.dome && r.ctx.temp != null && r.ctx.temp < 40 ? 1 : 0) },
    { id: 'wind', label: 'wind above 15 mph (outdoors)', f: (r) => (r.ctx && !r.ctx.dome && r.ctx.wind != null && r.ctx.wind > 15 ? 1 : 0) },
    { id: 'divisional', label: 'division game', f: (r) => (r.ctx && r.ctx.divisional ? 1 : 0) },
  ],
};
function pairedT(a, b) { /* paired two-sided t on per-game absolute errors: a = baseline, b = candidate */
  const d = a.map((x, i) => x - b[i]); const n = d.length; if (n < 30) return { t: null, p: null };
  const m = mean(d); const sd = Math.sqrt(d.reduce((s2, x) => s2 + (x - m) * (x - m), 0) / (n - 1)) || 1e-9; const t = m / (sd / Math.sqrt(n));
  return { t: r3(t), p: r4(2 * (1 - normCdf(Math.abs(t)))) };
}
function featureArms(rows, market) {
  const cfg = market === 'total' ? { modelOf: (r) => r.model_total, closeOf: (r) => r.close_total, actualOf: (r) => r.points } : { modelOf: (r) => r.model, closeOf: (r) => r.close, actualOf: (r) => r.margin };
  const evalRows = rows.filter((r) => cfg.modelOf(r) != null && cfg.closeOf(r) != null && cfg.actualOf(r) != null && r.ctx);
  const arms = {};
  CANDIDATES[market].forEach((c) => {
    const seasons = []; const baseErr = [], candErr = []; let coefLast = null;
    for (let S = RULES.first_holdout; S <= RULES.last; S++) {
      const tune = evalRows.filter((r) => r.season < S && r.season >= RULES.first_eval), test = evalRows.filter((r) => r.season === S);
      if (tune.length < 300 || !test.length) continue;
      const base = ols(tune, [cfg.closeOf, (r) => cfg.modelOf(r) - cfg.closeOf(r)], cfg.actualOf);
      const cand = ols(tune, [cfg.closeOf, (r) => cfg.modelOf(r) - cfg.closeOf(r), c.f], cfg.actualOf);
      coefLast = r4(cand.coef[3]);
      const be = test.map((r) => Math.abs(cfg.actualOf(r) - base.pred(r))), ce = test.map((r) => Math.abs(cfg.actualOf(r) - cand.pred(r)));
      baseErr.push(...be); candErr.push(...ce);
      seasons.push({ season: S, n: test.length, base_mae: r3(mean(be)), candidate_mae: r3(mean(ce)), improvement: r3(mean(be) - mean(ce)), coef: coefLast });
    }
    const pooled = seasons.length ? r3(mean(baseErr) - mean(candErr)) : null;
    const pt = pairedT(baseErr, candErr);
    const worstSeason = seasons.length ? Math.min(...seasons.map((x) => x.improvement)) : null;
    const reasons = [];
    if (seasons.length < FEATURE_RULES.min_holdout_seasons) reasons.push('fewer than ' + FEATURE_RULES.min_holdout_seasons + ' held-out seasons');
    if (pooled == null || pooled < FEATURE_RULES.min_pooled_improvement) reasons.push('pooled improvement ' + pooled + ' below ' + FEATURE_RULES.min_pooled_improvement + ' points of MAE');
    if (pt.p == null || pt.p >= FEATURE_RULES.p_max) reasons.push('paired p ' + pt.p + ' not below ' + FEATURE_RULES.p_max);
    if (worstSeason != null && worstSeason < -FEATURE_RULES.max_season_degradation) reasons.push('a held-out season degraded by ' + Math.abs(worstSeason) + ' (limit ' + FEATURE_RULES.max_season_degradation + ')');
    const status = reasons.length ? (pooled != null && pooled > 0 && pt.p != null && pt.p < 0.2 ? 'CANDIDATE' : 'REJECTED') : 'VALIDATED';
    arms[c.id] = { label: c.label, market, status, pooled_improvement_mae: pooled, paired_t: pt.t, paired_p: pt.p, holdout_seasons: seasons, latest_coef: coefLast, reasons, basis: 'the blend with and without the candidate term, both fitted on seasons before the held-out season; a paired two-sided test over per-game absolute errors' };
  });
  return arms;
}
function featureStatus(rep) {
  return {
    schema: 'edgedesk_feature_status_nfl_v1', generated_at: new Date().toISOString(), rules: FEATURE_RULES,
    frame: 'candidate context terms on top of the validated projection-market blend, NFL 2016-2025 replay, held out 2019-2025',
    statuses: ['VALIDATED', 'CANDIDATE', 'REJECTED'], arms: { spread: featureArms(rep.rows, 'spread'), total: featureArms(rep.rows, 'total') },
    note: 'A VALIDATED arm is a reviewed change to the engine or the blend, never an edit made here. Nothing in this file is applied to a price.',
  };
}

function buildNfl() {
  if (!fs.existsSync(ARCHIVE)) throw new Error('no closing-line archive; run tools/football/build_lines_archive.js first');
  const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
  const rep = replayNfl(archive);
  const spread = scoreMarket(rep.rows, { modelOf: (r) => r.model, closeOf: (r) => r.close, actualOf: (r) => r.margin });
  const total = scoreMarket(rep.rows, { modelOf: (r) => r.model_total, closeOf: (r) => r.close_total, actualOf: (r) => r.points });
  const moneyline = scoreMoneyline(rep.rows);
  try { const fsArt = featureStatus(rep); fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'feature-status-nfl.json'), JSON.stringify(fsArt, null, 1)); const flat = [].concat(Object.values(fsArt.arms.spread), Object.values(fsArt.arms.total)); console.log('feature intake: ' + flat.filter((a) => a.status === 'VALIDATED').length + ' validated, ' + flat.filter((a) => a.status === 'CANDIDATE').length + ' candidates, ' + flat.filter((a) => a.status === 'REJECTED').length + ' rejected -> football/validation/feature-status-nfl.json'); } catch (e) { console.error('feature intake failed: ' + e.message); }
  return {
    schema: SCHEMA, sport: 'americanfootball_nfl', generated_at: new Date().toISOString(),
    frame: { engine: 'football/engine.js ' + (E.version() || ''), params_trained_through: E.meta() && E.meta().nfl ? E.meta().nfl.trained_through : null, replay: 'cold from ' + RULES.replay_from + ' in kickoff order; seeds discarded; a game is projected from the state before it and absorbed after; both clubs need 8 absorbed games', eval_window: RULES.first_eval + '-' + RULES.last, holdout_window: RULES.first_holdout + '-' + RULES.last, archive: path.relative(ROOT, ARCHIVE), seasons_loaded: rep.seasons_loaded, games_scored: rep.rows.length, games_absorbed: rep.absorbed, refused: rep.refused, without_team_week_rows: rep.no_rows,
      caveats: ['league-mean priors come from the shipped parameter set (trained through ' + (E.meta() && E.meta().nfl ? E.meta().nfl.trained_through : '?') + '); the club ratings start at zero', 'the close is nflverse’s consensus number, not a book’s; no opener is on file for the NFL, so open-to-close value cannot be measured here', 'quarterback starts are absorbed without pass-deviation splits, as the live board does'] },
    rules: RULES, markets: { spread, total, moneyline },
    note: 'A number that has not cleared this file is a projection, not a price. Tiers are read by the pricing kernel; nothing here promotes itself.',
  };
}

function buildCfb() {
  const dir = path.join(ROOT, 'football', 'cfb_p4', 'research', 'report');
  const slices = JSON.parse(fs.readFileSync(path.join(dir, 'error_slices.json'), 'utf8'));
  const md = fs.readFileSync(path.join(dir, 'BACKTEST.md'), 'utf8');
  const gapRows = {}; const re = /^\| (\d+(?:\.\d)?) \| (\d+) \| (\d+) \| ([\d.]+)% \| ([\d.]+) \|$/gm; let m;
  while ((m = re.exec(md))) gapRows[m[1]] = { n: Number(m[2]), wins: Number(m[3]), win_pct: r4(Number(m[4]) / 100), p_one_sided: Number(m[5]) };
  const edge = (() => { for (const rule of [RULES.validated, RULES.lean]) for (const t of Object.keys(gapRows).map(Number).sort((a, b) => a - b)) { const e = gapRows[String(t)]; if (e.n >= rule.min_n && e.win_pct >= rule.win_pct && e.p_one_sided < rule.p_max) return [rule === RULES.validated ? 'VALIDATED' : 'LEAN', t]; } return [null, null]; })();
  const edgeTier = edge[0], edgePts = edge[1];
  const clv = slices.clv_proxy_vs_open || null;
  return {
    schema: SCHEMA, sport: 'americanfootball_ncaaf', generated_at: new Date().toISOString(),
    frame: { engine: 'football/cfb_p4/engine.js (shipped) replayed cold by football/cfb_p4/research/backtest_engine.js', source: 'football/cfb_p4/research/report/BACKTEST.md and error_slices.json, copied, not re-run here', eval_window: slices.what || null, archive: 'sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz (consensus median across books, duplicates dropped)' },
    rules: RULES,
    markets: {
      spread: { n: slices.overall ? slices.overall.n : null, pooled: { model_mae: slices.overall ? slices.overall.mae_raw : null, close_mae: slices.overall ? slices.overall.mae_market : null }, by_disagreement: slices.by_disagreement || null, ats_vs_close: { raw_model: gapRows }, required_edge_points: edgePts, tier: edgeTier || 'RESEARCH', tier_basis: edgeTier ? 'a disagreement of ' + edgePts + '+ points cleared the ' + edgeTier + ' rule in the shipped backtest' : 'no disagreement threshold cleared break-even against the close in the shipped backtest (2022-2025); the biggest disagreements are the worst', blend: null, calibration: null },
      total: { pooled: { model_mae: 12.913, close_mae: 12.501, source: 'BACKTEST.md 2022-2025' }, tier: 'RESEARCH', tier_basis: 'the total is 0.4 points worse than the close and has no held-out cover-probability calibration on file', required_edge_points: null },
      moneyline: { tier: 'RESEARCH', tier_basis: 'no moneyline backtest on file for the CFB engine', required_edge_points: null },
    },
    open_to_close: clv ? { table: clv, basis: 'share of games whose line moved from the opener toward the side the model preferred, by size of the model-vs-opener gap; a movement tendency, not a betting record', tier: 'LEAN' } : null,
    note: 'Copied from the shipped backtest so the pricing kernel and the CFB replay agree by construction; re-run football/cfb_p4/research to change it.',
  };
}

/** The historical team-week files the replay needs, fetched into the gitignored cache when absent (public, keyless). */
async function ensureTeamWeek() {
  const missing = []; for (let s = RULES.replay_from; s <= RULES.last; s++) if (!fs.existsSync(STW(s))) missing.push(s);
  for (const s of missing) {
    const url = 'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + s + '.csv';
    try { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(STW(s), t); console.log('fetched stats_team_week_' + s + '.csv'); }
    catch (e) { console.error('could not fetch stats_team_week_' + s + '.csv: ' + e.message + ' (the season is skipped in the replay)'); }
  }
  return missing.length;
}

async function main() {
  const args = process.argv.slice(2);
  const sport = args.includes('--sport') ? args[args.indexOf('--sport') + 1] : 'nfl';
  if (sport !== 'cfb' && !args.includes('--offline')) await ensureTeamWeek();
  const art = sport === 'cfb' ? buildCfb() : buildNfl();
  const out = path.join(OUT_DIR, 'pricing_' + sport + '.json');
  const m = art.markets;
  console.log(`pricing validation (${sport}): spread ${m.spread.tier}${m.spread.pooled ? ' model MAE ' + m.spread.pooled.model_mae + ' vs close ' + m.spread.pooled.close_mae : ''}${m.spread.blend && m.spread.blend.pooled_holdout ? ', blend held-out ' + m.spread.blend.pooled_holdout.blend_mae + ' vs close ' + m.spread.blend.pooled_holdout.close_mae + ' (c=' + (m.spread.blend.latest_coef || {}).model_minus_close + ')' : ''}; total ${m.total.tier}; moneyline ${m.moneyline.tier}`);
  if (m.spread.ats_vs_close) { const t = m.spread.ats_vs_close.raw_model_oos || m.spread.ats_vs_close.raw_model; Object.keys(t).sort((a, b) => a - b).forEach((k) => console.log(`  spread gap >= ${k}: n ${t[k].n} win ${t[k].win_pct} p ${t[k].p_one_sided}`)); }
  if (args.includes('--check')) {
    if (!fs.existsSync(out)) { console.error('CHECK: no artifact'); process.exit(1); }
    const prev = JSON.parse(fs.readFileSync(out, 'utf8')); const strip = (a) => JSON.stringify(Object.assign({}, a, { generated_at: null }));
    const same = strip(prev) === strip(art); console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build'); process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(out, JSON.stringify(art, null, 1)); console.log('wrote ' + path.relative(ROOT, out));
}

module.exports = { replayNfl, scoreMarket, scoreMoneyline, atsTable, requiredEdge, passes, calibration, ols, buildCfb, featureArms, featureStatus, pairedT, FEATURE_RULES, CANDIDATES, RULES, SCHEMA, THRESHOLDS };
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
