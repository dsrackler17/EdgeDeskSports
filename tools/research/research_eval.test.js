#!/usr/bin/env node
/* THE WALK-FORWARD EVALUATOR. Every record it scores must have been
   knowable at its prediction time. These tests inject future information on
   purpose — a line captured after the post, an input from tomorrow, a result
   already known — and prove each one is rejected by name. They also pin the
   metric denominators (ATS, MAE, Brier and CLV each on their own sample),
   the fixed-at-submission side for CLV and edge buckets, edge-threshold
   cumulation, similar-situation relaxation and model correlation.
   Run: node tools/research/research_eval.test.js */
'use strict';
const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'lib', 'research_core.js'));
const E = require(path.join(__dirname, '..', '..', 'lib', 'research_eval.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String(e && e.message) }; } }
  if (ok) { pass++; return; } fail++; failures.push({ name, detail });
}
const near = (a, b, e) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (e == null ? 1e-9 : e);
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const day = (d, h) => new Date(Date.UTC(2026, 8, d, h || 0)).toISOString();
function rec(o) {
  return Object.assign({ model_id: 'a/m', sport: 'CFB', game_id: 'g1', kickoff_at: day(10, 20), predicted_at: day(9, 12),
    spread: -7, home_win_prob: 0.7, pick_side: null, line_at_prediction: -4, close_line: -5, close_home_prob: 0.66,
    home_score: 30, away_score: 20, final_at: day(11, 0) }, o || {});
}

/* ---- 1. leakage guard ------------------------------------------------- */
chk('a clean record validates', E.validateRecord(rec()).ok === true);
chk('a market line captured after the prediction is rejected by name', /market line captured after/.test(E.validateRecord(rec({ line_at_prediction_at: day(9, 13) })).violations.join()));
chk('an input captured after the prediction is rejected and named', (() => {
  const v = E.validateRecord(rec({ inputs: [{ name: 'injury_report', captured_at: day(9, 18) }, { name: 'ratings', captured_at: day(8) }] })).violations;
  return v.length === 1 && /injury_report/.test(v[0]);
})());
chk('a result known before the prediction is rejected', /result known before/.test(E.validateRecord(rec({ final_at: day(9, 11) })).violations.join()));
chk('a prediction at or after kickoff is not a pregame forecast', /at or after kickoff/.test(E.validateRecord(rec({ predicted_at: day(10, 20) })).violations.join()));
chk('no prediction time is rejected, never assumed', E.validateRecord(rec({ predicted_at: null })).ok === false);
chk('evaluate drops leaked records into rejected and never scores them', (() => {
  const ev = E.evaluate([rec({ game_id: 'ok' }), rec({ game_id: 'bad', inputs: [{ name: 'close', captured_at: day(10, 21) }] })]);
  return ev.rows.length === 1 && ev.rows[0].game_id === 'ok' && ev.rejected.length === 1 && ev.rejected[0].record.game_id === 'bad';
})());

/* ---- 2. one derived row ---------------------------------------------- */
(function () {
  const r = E.evaluate([rec()]).rows[0];
  chk('side at submission comes from the model vs the POSTED line (-7 vs -4 = home)', r.side_at_submission === 'home');
  chk('gap 3 at submission is in the 2-4 bucket', near(r.gap, 3) && r.edge_bucket === '2-4');
  chk('CLV: home at -4, close -5 = +1', r.clv === 1);
  chk('residual = projected margin 7 - actual 10 = -3', r.residual === -3 && r.abs_error === 3);
  chk('ATS by the published contract: implied home vs close -5, won by 10 -> win', r.ats === 'win' && r.ats_side_implied === true);
  chk('brier against a home win', near(r.brier, 0.09) && near(r.market_brier, 0.34 * 0.34));
  chk('lead time 32h is the 24-72h bucket', r.lead_bucket === '24-72h');
  chk('home side at -4 is the favourite', r.role === 'favorite');
  chk('with no history the normalized edge is unavailable, never guessed', r.normalized_edge === null && r.scale === null);
})();
chk('the close never chooses the CLV side: model -4.5, posted -4, close -6', (() => {
  const r = E.evaluate([rec({ spread: -4.5, line_at_prediction: -4, close_line: -6 })]).rows[0];
  /* vs close the model is AWAY (-4.5 > -6), but it was HOME at submission */
  return r.side_at_submission === 'home' && r.clv === 2 && r.ats_side === 'away';
})());
chk('a named pick side wins over both implied sides', (() => {
  const r = E.evaluate([rec({ pick_side: 'away', spread: -7, line_at_prediction: -4 })]).rows[0];
  return r.side_at_submission === 'away' && r.clv === -1 && r.ats === 'loss';
})());
chk('a PRESENT null ats_result from the grader of record is kept null (not recomputed)', E.evaluate([rec({ ats_result: null })]).rows[0].ats === null);
chk('margin error and Brier of record win over recomputation', (() => { const r = E.evaluate([rec({ abs_error_of_record: 2.5, brier_of_record: 0.1 })]).rows[0]; return r.abs_error === 2.5 && r.brier === 0.1; })());
chk('final-known rule is kickoff + 6h', E.finalKnownAt('2026-09-26T20:00:00Z') === '2026-09-27T02:00:00.000Z' && E.finalKnownAt(null) === null);
chk('an ats_result from the grader of record is kept, never recomputed', E.evaluate([rec({ ats_result: 'push' })]).rows[0].ats === 'push');
chk('a tied game has no Brier outcome', E.evaluate([rec({ home_score: 20, away_score: 20 })]).rows[0].brier === null);
chk('no close: CLV and ATS are null, MAE still graded', (() => {
  const r = E.evaluate([rec({ close_line: null })]).rows[0];
  return r.clv === null && r.ats === null && r.abs_error === 3;
})());

/* ---- 3. walk-forward normalization ----------------------------------- */
(function () {
  const recs = [];
  for (let i = 0; i < 15; i++) recs.push(rec({ game_id: 'h' + i, predicted_at: day(1 + i, 1), kickoff_at: day(1 + i, 18), final_at: day(1 + i, 22),
    spread: -7, home_score: 17 + (i % 2 ? 6 : -6), away_score: 10 }));
  const ev = E.evaluate(recs);
  const first12 = ev.rows.filter((r) => r.scale != null);
  chk('the first 12 forecasts have no scale; the 13th uses exactly the 12 prior finals', ev.rows.filter((r) => r.scale == null).length === 12 && first12[0].scale_n === 12);
  chk('scale is rmse of the prior residuals (+/-6 -> 6)', near(first12[0].scale, 6));
  chk('normalized edge = 3 / 6 = 0.5', near(first12[0].normalized_edge, 0.5) && first12[0].normalized_bucket === '0.5-0.75');
  /* a game that is posted before an earlier game finishes must not see it */
  const overlap = recs.slice(0, 12).concat([rec({ game_id: 'late', predicted_at: day(12, 21), kickoff_at: day(14, 18), final_at: day(15) })]);
  const r = E.evaluate(overlap).rows.find((x) => x.game_id === 'late');
  chk('a residual finishing after the post time is not in the scale', r.scale_n === 11 && r.scale === null);
  const cmp = E.compareScaleMethods(recs);
  chk('scale methods are compared on coverage, not asserted (a degenerate MAD of 0 is refused, not used)', cmp.rmse.n === 3 && cmp.sd.n === 3 && cmp.mad.n === 2 && cmp.rmse.target_1 > 0.68);
})();

/* ---- 4. denominators and aggregation --------------------------------- */
(function () {
  const rows = E.evaluate([
    rec({ game_id: 'a' }),                                            // ats win, clv +1, mae 3, brier
    rec({ game_id: 'b', close_line: null }),                          // no ats, no clv; mae + brier
    rec({ game_id: 'c', home_win_prob: null, spread: -3, line_at_prediction: -4, close_line: -3.5 }), // away; ats? margin 10 - 3.5 > 0 -> home covers -> away loses
    rec({ game_id: 'd', spread: null, pick_side: 'home', home_win_prob: null })  // pick only
  ]).rows;
  const s = E.summarize(rows);
  chk('ATS n counts only rows with an ATS result (3)', s.ats.n === 3 && s.ats.wins === 2 && s.ats.losses === 1);
  chk('MAE n counts only rows with a spread (3)', s.mae.n === 3);
  chk('Brier n counts only rows with a probability (2)', s.brier.n === 2);
  chk('CLV n counts only rows with side, posted line and close (3)', s.clv.n === 3);
  chk('ATS interval is Wilson on decided games', near(s.ats.interval.p, 2 / 3));
  chk('market benchmark uses the same games only', s.market_benchmark.n === 2);
  chk('median CLV and positive share', s.clv.median != null && s.clv.positive_pct != null);
})();
chk('an empty sample has null values and zero n, never 0%', (() => {
  const s = E.summarize([]);
  return s.ats.pct === null && s.ats.interval === null && s.mae.value === null && s.clv.mean === null && s.market_benchmark.skill === null;
})());

/* ---- 5. edge buckets and thresholds ---------------------------------- */
(function () {
  const gaps = [0.5, 2, 3.5, 4, 5.5, 6, 9];
  const rows = E.evaluate(gaps.map((g, i) => rec({ game_id: 'e' + i, spread: -4 - g, line_at_prediction: -4 }))).rows;
  const d = E.modelDiagnostics(rows);
  const b = Object.fromEntries(d.edge_buckets.map((x) => [x.key, x.summary.n_rows]));
  chk('bucket counts: 0-2:1, 2-4:2, 4-6:2, 6+:2', b['0-2'] === 1 && b['2-4'] === 2 && b['4-6'] === 2 && b['6+'] === 2, b);
  const t = Object.fromEntries(d.edge_thresholds.map((x) => [x.threshold, x.summary.n_rows]));
  chk('thresholds are cumulative: 2+:6, 3+:5, 4+:4, 5+:3, 6+:2', t[2] === 6 && t[3] === 5 && t[4] === 4 && t[5] === 3 && t[6] === 2, t);
  chk('thresholds are marked prespecified', d.edge_thresholds.every((x) => x.prespecified === true));
  chk('buckets are always listed in fixed order, empty ones included', d.edge_buckets.map((x) => x.key).join() === '0-2,2-4,4-6,6+');
})();

/* ---- 6. similar situations ------------------------------------------- */
(function () {
  const recs = [];
  for (let i = 0; i < 20; i++) recs.push(rec({ game_id: 's' + i, predicted_at: day(1 + i, 1), kickoff_at: day(1 + i, 18), final_at: day(1 + i, 22),
    spread: i < 6 ? -9 : -5, line_at_prediction: -4 }));
  const rows = E.evaluate(recs).rows;
  const target = E.deriveRow(rec({ game_id: 'T', predicted_at: day(25, 1), kickoff_at: day(26), final_at: null, home_score: null, away_score: null, spread: -9, line_at_prediction: -4 }), null);
  const sim = E.similarSituations(target, rows, { minN: 5 });
  chk('similar situations keep the edge bucket while the sample allows (6 games at 4-6)', sim.criteria[0].key === 'edge_bucket' && sim.n === 6 && sim.sufficient);
  const strict = E.similarSituations(target, rows, { minN: 8 });
  chk('below minN the criteria relax from the end and say which were relaxed', strict.relaxed.indexOf('edge_bucket') >= 0 && strict.n === 20);
  const early = E.similarSituations(Object.assign({}, target, { predicted_at: day(3, 0) }), rows, { minN: 1 });
  chk('only games final before the target prediction are candidates', early.pool_n === 2);
  chk('another model\'s rows are never similar situations', E.similarSituations(Object.assign({}, target, { model_id: 'x/y' }), rows).n === 0);
})();

/* ---- 7. correlation / independence ----------------------------------- */
(function () {
  const recs = [];
  for (let i = 0; i < 20; i++) {
    const hs = 20 + ((i * 7) % 11);
    recs.push(rec({ model_id: 'a/1', game_id: 'c' + i, home_score: hs, spread: -7 }));
    recs.push(rec({ model_id: 'b/1', game_id: 'c' + i, home_score: hs, spread: -8 }));
    if (i < 5) recs.push(rec({ model_id: 'c/1', game_id: 'c' + i, home_score: hs, spread: -2 }));
  }
  const c = E.modelCorrelation(E.evaluate(recs).rows, { minOverlap: 15 });
  chk('two models with identical residual shape correlate at 1', near(c.matrix[0][1], 1));
  chk('a pair with too few shared games is null, and so is n_eff', c.matrix[0][2] === null && c.effective_n === null);
  const c2 = E.modelCorrelation(E.evaluate(recs.filter((r) => r.model_id !== 'c/1')).rows);
  chk('two perfectly correlated models count as one independent model', near(c2.effective_n, 1));
})();

/* ---- 8. calibration --------------------------------------------------- */
chk('calibration bins carry n, predicted, observed and interval', (() => {
  const rows = E.evaluate([rec({ game_id: 'k1', home_win_prob: 0.7 }), rec({ game_id: 'k2', home_win_prob: 0.72, home_score: 10 })]).rows;
  const b = E.calibration(rows).find((x) => x.n === 2);
  return b && near(b.observed, 0.5) && near(b.predicted, 0.71) && b.interval;
})());

/* ---- 9. component diagnostics --------------------------------------- */
(function () {
  const recs = [];
  for (let i = 0; i < 60; i++) {
    const good = (i % 7) - 3;                 /* a real signal: the result moves with it one for one */
    const noise = ((i * 13) % 5) - 2;         /* a component with no relation to the result */
    const margin = 3 - good * -1 + ((i * 5) % 3 - 1);
    recs.push(rec({ game_id: 'k' + i, season: i < 30 ? 2024 : 2025, spread: -3 + good * -1 + noise,
      components: { hfa: -3, good: -good, noise: noise }, home_score: 20 + margin, away_score: 20 }));
  }
  const rows = E.evaluate(recs).rows;
  const d = Object.fromEntries(E.componentDiagnostics(rows).map((x) => [x.key, x]));
  chk('a component that tracks the result improves MAE when kept', d.good.all.delta_mae > 0);
  chk('its slope is near 1 (correctly sized)', near(d.good.all.slope, 1, 0.2), d.good.all);
  chk('a pure-noise component makes MAE worse and its slope sits near 0', d.noise.all.delta_mae < 0 && Math.abs(d.noise.all.slope) < 0.4, d.noise.all);
  chk('noise reads as overshooting: its interval sits below 1', /overshoots/.test(d.noise.reading));
  chk('components are split by season for drift', d.good.by_season.length === 2);
  chk('below the minimum sample no reading is given', /insufficient sample/.test(E.componentDiagnostics(rows.slice(0, 10))[0].reading));
})();

/* ---- 10. ensemble research ------------------------------------------ */
(function () {
  const recs = [];
  for (let i = 0; i < 40; i++) {
    const m = (i % 11) - 5;
    const base = { game_id: 'n' + i, predicted_at: day(1 + Math.floor(i / 2), 1), kickoff_at: day(1 + Math.floor(i / 2), 18),
      final_at: day(1 + Math.floor(i / 2), 22), home_score: 20 + m, away_score: 20 };
    recs.push(rec(Object.assign({ model_id: 'good/1', spread: -m + 1 }, base)));
    recs.push(rec(Object.assign({ model_id: 'bad/1', spread: -m + 9 }, base)));
    recs.push(rec(Object.assign({ model_id: 'mid/1', spread: -m - 3 }, base)));
  }
  const res = E.ensembleResearch(E.evaluate(recs).rows, { minN: 5 });
  chk('every game with 2+ models is an ensemble game', res.n_games === 40);
  chk('development and holdout halves are reported separately', res.development.n_games === 20 && res.holdout.n_games === 20);
  chk('inverse-error weighting only exists once every model has a prior sample', res.all.methods.inverse_mae.n < 40 && res.all.methods.inverse_mae.n > 0);
  chk('methods are compared with the plain mean on the same games', res.holdout.methods.inverse_mae.vs_mean_same_games != null);
  chk('the best prior model beats the mean on holdout here, and it is measured, not assumed', res.holdout.methods.best_prior_model.mae < res.holdout.methods.mean.mae);
  chk('each individual model is scored on its own games beside the mean ensemble on those games', res.all.individual['good/1'].n === 40);
})();

done();
