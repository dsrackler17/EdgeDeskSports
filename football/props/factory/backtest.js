/* ===========================================================================
   EdgeDesk player props — WALK-FORWARD VALIDATION (Phase H).

   Chronological folds only (config/backtest_splits.json, the workbook's sheet
   07). A random split is never the main validation. Each fold trains every
   position × market model on the train seasons exactly as production does,
   then scores the test season it never saw.

   OUTCOME folds (both leagues, the full historical window):
     MAE / RMSE of the median, pinball loss at 10/25/50/75/90, 80% interval
     coverage, PIT deciles, and — at an EVALUATION THRESHOLD, the player's own
     pregame composite rounded to the half point — Brier, log loss and
     reliability bins. The threshold is a probe of the distribution, NOT a
     sportsbook line, and is never stored or shown as one.
     Every metric is reported for the raw and the recalibrated distribution;
     production turns recalibration on for a model only where it won here.
   MARKET folds (observed prop quotes only, lineage = 'observed'):
     edge, EV, realized ROI, units and CLV by edge bucket, confidence bucket,
     sportsbook, price range, favourite/underdog and home/away. With no
     observed quote history on file the fold reports NO_OBSERVED_QUOTES — it
     never substitutes a reconstructed line.
   The live/holdout season (2026) is never used to fit or tune anything.
   =========================================================================== */
'use strict';
const EDP = require('./dist.js');
const M = require('./model.js');
const SPLITS = require('./config/backtest_splits.json');

const TAUS = [0.1, 0.25, 0.5, 0.75, 0.9];
function r(x, d) { return x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d || 4)) / Math.pow(10, d || 4); }

/* the composite a market's evaluation threshold is read from */
const PROBE = { pass_yards: 'passing_yards', pass_tds: 'passing_tds', pass_completions: 'completions', pass_attempts: 'attempts', pass_interceptions: 'interceptions',
  pass_longest_completion: 'longest_completion', rush_yards: 'rushing_yards', rush_attempts: 'carries', rush_tds: 'rushing_tds', longest_rush: 'longest_rush',
  receiving_yards: 'receiving_yards', receptions: 'receptions', targets: 'targets', receiving_tds: 'receiving_tds', longest_reception: 'longest_reception', anytime_td: 'tds',
  pass_rush_yards: 'pass_rush_yards', rush_rec_yards: 'rush_rec_yards', pass_rush_rec_yards: 'pass_rush_rec_yards', receptions_rush_attempts: 'receptions_rush_attempts' };

function newAcc() { return { n: 0, ae: 0, se: 0, pin: TAUS.map(() => 0), cov: 0, pit: new Array(10).fill(0), brier: 0, ll: 0, nb: 0, cal: [], base_ae: 0, base_n: 0 }; }
function addObs(a, d, y, probeLine, u, baseMean) {
  const s = EDP.dist.summary(d);
  a.n++; a.ae += Math.abs(y - s.median); a.se += (y - s.mean) * (y - s.mean);
  TAUS.forEach((t, i) => { a.pin[i] += EDP.metrics.pinball(y, EDP.dist.quantile(d, t), t); });
  if (y >= EDP.dist.quantile(d, 0.1) && y <= EDP.dist.quantile(d, 0.9)) a.cov++;
  const p = M.pitOf(d, y, u); if (p != null) a.pit[Math.min(9, Math.floor(p * 10))]++;
  if (isFinite(baseMean)) { a.base_ae += Math.abs(y - baseMean); a.base_n++; }
  if (probeLine != null) {
    const pr = d.t === 'bern' ? { over: d.p } : EDP.dist.probs(d, probeLine);
    if (pr && isFinite(pr.over)) {
      const o = d.t === 'bern' ? (y >= 1 ? 1 : 0) : (y > probeLine ? 1 : 0);
      const pp = Math.min(1 - 1e-6, Math.max(1e-6, pr.over));
      a.brier += (pp - o) * (pp - o); a.ll += -(o * Math.log(pp) + (1 - o) * Math.log(1 - pp)); a.nb++;
      a.cal.push({ p: pp, y: o });
    }
  }
}
function finish(a) {
  if (!a.n) return null;
  return { n: a.n, mae: r(a.ae / a.n, 3), rmse: r(Math.sqrt(a.se / a.n), 3), pinball: TAUS.reduce((o, t, i) => { o['q' + Math.round(t * 100)] = r(a.pin[i] / a.n, 4); return o; }, {}),
    mean_pinball: r(a.pin.reduce((x, y) => x + y, 0) / (a.n * TAUS.length), 4), coverage_80: r(a.cov / a.n, 4), pit_deciles: a.pit.map((v) => r(v / a.n, 3)),
    pit_max_abs_dev: r(Math.max.apply(null, a.pit.map((v) => Math.abs(v / a.n - 0.1))), 3),
    brier: a.nb ? r(a.brier / a.nb, 5) : null, log_loss: a.nb ? r(a.ll / a.nb, 5) : null, n_threshold: a.nb,
    reliability: a.nb ? EDP.metrics.calibrationBins(a.cal, 10) : null,
    baseline_mae: a.base_n ? r(a.base_ae / a.base_n, 3) : null, mae_skill_vs_baseline: a.base_n ? r(1 - (a.ae / a.n) / (a.base_ae / a.base_n), 4) : null };
}

/* One outcome fold for one league: train on [from, to], test on test_season. */
function runFold(rows, league, fold, opts) {
  opts = opts || {};
  const train = rows.filter((x) => x.season >= fold.train_from && x.season <= fold.train_to);
  const test = rows.filter((x) => x.season === fold.test_season);
  const out = { fold: fold.fold, league, train_seasons: [fold.train_from, fold.train_to], test_season: fold.test_season, method: fold.method, notes: fold.notes || null,
    n_train_rows: train.length, n_test_rows: test.length, models: [] };
  if (!train.length || !test.length) { out.status = 'NO_DATA'; return out; }
  ['QB', 'RB', 'WR', 'TE'].forEach((pg) => {
    M.marketsFor(league, pg).forEach((market) => {
      if (opts.markets && opts.markets.indexOf(market) < 0) return;
      const t0 = Date.now();
      const res = M.trainOne(train, { league, pg, market, fold: fold.fold, now: opts.now });
      if (res.skipped) { out.models.push({ position_group: pg, market_key: market, skipped: res.skipped }); return; }
      const m = res.model;
      const probe = M.targetFor, pk = PROBE[market];
      const raw = newAcc(), cal = newAcc();
      const F = require('./features.js');
      const pi = F.IDX.get(pk + '_eb');
      test.forEach((x) => {
        if (x.position_group !== pg) return;
        const y = probe(x, market);
        if (y == null || !isFinite(y)) return;
        const eb = x.f[pi];
        const line = market === 'anytime_td' ? null : (isFinite(eb) ? Math.floor(eb) + 0.5 : null);
        const u = M.hashU(x.game_id + x.player_id + market);
        const pRaw = M.predictDist(m, x.f, { recalibrate: false }), pCal = M.predictDist(m, x.f);
        addObs(raw, pRaw.dist, y, line, u, eb);
        addObs(cal, pCal.dist, y, line, u, eb);
      });
      const fr = finish(raw), fc = finish(cal);
      /* recalibration wins when it lowers mean pinball loss (the whole-
         distribution score) without raising the threshold Brier by more
         than noise */
      const recalWins = !!(fr && fc && m.pit_map && fc.mean_pinball <= fr.mean_pinball + 1e-9 && (fc.brier == null || fr.brier == null || fc.brier <= fr.brier + 0.002));
      out.models.push({ position_group: pg, market_key: market, model_version: m.model_version, n_train: m.training.n_rows, raw: fr, recalibrated: fc,
        recalibration_wins: recalWins, seconds: r((Date.now() - t0) / 1000, 1) });
      if (opts.log) opts.log('[props backtest] ' + league + ' ' + fold.fold + ' ' + pg + ' ' + market + ' n=' + (fr ? fr.n : 0) + ' mae=' + (fr ? fr.mae : '-') + ' base=' + (fr ? fr.baseline_mae : '-') + ' cov80=' + (fc ? fc.coverage_80 : '-'));
    });
  });
  out.status = 'OK';
  return out;
}

/* the folds to run: the workbook's outcome folds for a league, walk-forward
   only (the live/holdout fold is scored by the live record, not here) */
function foldsFor(league, opts) {
  opts = opts || {};
  const fam = league === 'NFL' ? 'NFL outcome model' : 'CFB outcome model';
  let folds = SPLITS.folds.filter((f) => f.family === fam && f.method === 'Walk-forward');
  if (opts.lastN) folds = folds.slice(-opts.lastN);
  return folds;
}
function runOutcome(rows, league, opts) {
  opts = opts || {};
  const folds = foldsFor(league, opts).map((f) => runFold(rows, league, f, opts));
  return { league, folds, summary: summarize(folds) };
}
/* The per-model summary across folds (recomputable from saved fold results).
   Tiers: OUTCOME_VALIDATED needs positive skill against the naive composite in
   EVERY fold and a calibrated distribution — the randomised PIT within 3
   points of uniform in every decile on average (coverage of [p10, p90] is not
   used: on a low-count stat it over-covers by construction). */
function summarize(folds) {
  const byModel = {};
  folds.forEach((fd) => (fd.models || []).forEach((m) => {
    if (m.skipped) return;
    const k = m.position_group + '|' + m.market_key;
    const b = byModel[k] || (byModel[k] = { position_group: m.position_group, market_key: m.market_key, folds: 0, recal_wins: 0, skill: [], coverage: [], brier: [], pitdev: [] });
    b.folds++; if (m.recalibration_wins) b.recal_wins++;
    if (m.raw && m.raw.mae_skill_vs_baseline != null) b.skill.push(m.raw.mae_skill_vs_baseline);
    const use = m.recalibration_wins ? m.recalibrated : m.raw;
    if (use && use.coverage_80 != null) b.coverage.push(use.coverage_80);
    if (use && use.brier != null) b.brier.push(use.brier);
    if (use && use.pit_max_abs_dev != null) b.pitdev.push(use.pit_max_abs_dev);
  }));
  return Object.keys(byModel).sort().map((k) => {
    const b = byModel[k], avg = (a) => (a.length ? r(a.reduce((x, y) => x + y, 0) / a.length, 4) : null);
    const skill = avg(b.skill), pit = avg(b.pitdev);
    const everyFold = b.skill.length === b.folds && b.skill.every((s) => s > 0);
    const tier = everyFold && pit != null && pit <= 0.03 ? 'OUTCOME_VALIDATED' : (skill != null && skill > 0 ? 'OUTCOME_LEAN' : 'RESEARCH');
    return { position_group: b.position_group, market_key: b.market_key, folds: b.folds, mean_mae_skill: skill, min_mae_skill: b.skill.length ? r(Math.min.apply(null, b.skill), 4) : null,
      mean_coverage_80: avg(b.coverage), mean_pit_max_abs_dev: pit, mean_brier: avg(b.brier), use_recalibration: b.recal_wins * 2 >= b.folds, outcome_tier: tier };
  });
}

/* ---------------------------------------------------------- market folds
   decisions = [{quote (observed), model_prob, market_prob, ev, confidence,
   result, units, clv, season, sportsbook, …}] from the frozen record or a
   replay over observed history. Reconstructed quotes never reach here. */
function runMarket(decisions, opts) {
  opts = opts || {};
  const obs = (decisions || []).filter((d) => d.quote && d.quote.lineage === 'observed');
  const refused = (decisions || []).length - obs.length;
  const folds = SPLITS.folds.filter((f) => f.family === 'Market calibration / EV');
  if (!obs.length) return { status: 'NO_OBSERVED_QUOTES', refused_non_observed: refused, folds: folds.map((f) => ({ fold: f.fold, status: 'NO_OBSERVED_QUOTES' })),
    note: 'No observed sportsbook prop quotes are on file for any market fold. Market calibration, realized ROI and CLV are not reported until they are; nothing is reconstructed in their place.' };
  const seg = (keyFn) => {
    const m = {};
    obs.forEach((d) => { const k = keyFn(d); if (k == null) return; const s = m[k] || (m[k] = { n: 0, settled: 0, units: 0, staked: 0, ev: 0, edge: 0, clv: 0, nclv: 0, wins: 0, losses: 0, pushes: 0 });
      s.n++; s.ev += d.ev || 0; s.edge += d.edge || 0;
      if (d.result === 'WIN' || d.result === 'LOSS' || d.result === 'PUSH') { s.settled++; s.units += d.units || 0; s.staked += d.stake || 1; if (d.result === 'WIN') s.wins++; else if (d.result === 'LOSS') s.losses++; else s.pushes++; }
      if (isFinite(d.clv)) { s.clv += d.clv; s.nclv++; } });
    return Object.keys(m).sort().map((k) => { const s = m[k]; return { segment: k, n: s.n, settled: s.settled, wins: s.wins, losses: s.losses, pushes: s.pushes,
      mean_ev: r(s.ev / s.n, 4), mean_edge: r(s.edge / s.n, 4), units: r(s.units, 3), roi: s.staked ? r(s.units / s.staked, 4) : null, mean_clv: s.nclv ? r(s.clv / s.nclv, 4) : null,
      sufficient_sample: s.settled >= 100 }; });
  };
  return {
    status: 'OK', n: obs.length, refused_non_observed: refused,
    by_edge_bucket: seg((d) => EDP.edgeBucket(d.edge)), by_confidence: seg((d) => EDP.confidenceBucket(d.confidence)), by_sportsbook: seg((d) => d.quote.sportsbook),
    by_season: seg((d) => d.season), by_price: seg((d) => EDP.priceBucket(d.quote.american_price)), by_fav_dog: seg((d) => (d.quote.american_price < 0 ? 'favorite' : 'underdog')),
    by_home_away: seg((d) => (d.is_home == null ? null : d.is_home ? 'home' : 'away')), by_market: seg((d) => d.market_key), by_position: seg((d) => d.position_group),
    by_league: seg((d) => d.league), by_model_version: seg((d) => d.model_version)
  };
}

module.exports = { runFold, runOutcome, runMarket, foldsFor, summarize, PROBE, TAUS };
