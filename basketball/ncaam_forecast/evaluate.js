'use strict';
/* ===========================================================================
   The promotion gates of config/promotion_v1.json, applied mechanically.

   gate(champion, challenger, policy, ctx) pairs the two candidates' scored
   rows on the same games inside the evaluation window and returns every gate
   with its evidence and the decision: PROMOTE, RETAIN or
   INSUFFICIENT_EVIDENCE. Nothing here can promote by itself: registry.js
   swaps the pointer only for a PROMOTE decision.
   =========================================================================== */
const M = require('./metrics');

const HOLDOUT = [2024, 2025, 2026];

function inWindow(r, w) {
  if (r.regime !== 'D1_D1' && !w.include_regimes) return false;
  if (!r.s || !Number.isFinite(r.s.p_home)) return false;
  if (r.season < w.from || r.season > w.to) return false;
  if (r.ncaa_round && HOLDOUT.includes(r.season)) return false;
  return true;
}

const COHORTS = {
  neutral_site: (r) => r.neutral && r.regime === 'D1_D1',
  home_site: (r) => !r.neutral && r.regime === 'D1_D1',
  early_season_min_games_lt_5: (r) => r.regime === 'D1_D1' && Math.min(r.n_h == null ? 99 : r.n_h, r.n_a == null ? 99 : r.n_a) < 5,
  postseason_non_holdout: (r) => r.regime === 'D1_D1' && (r.event === 'conference_tournament' || r.event === 'ncaa_tournament' || r.event === 'nit' || r.event === 'other_postseason'),
  most_recent_complete_season: (r, ctx) => r.regime === 'D1_D1' && r.season === ctx.recent_season,
  d1_vs_non_d1_regime: (r) => r.regime === 'D1_OTHER',
};

function gate(champ, chal, policy, ctx) {
  const G = policy.gates; const w = ctx.window;
  const cm = new Map(champ.filter((r) => r.s).map((r) => [String(r.game_id), r]));
  const pairsAll = chal.filter((r) => r.s && cm.has(String(r.game_id))).map((r) => ({ a: r, b: cm.get(String(r.game_id)) }));
  const main = pairsAll.filter((p) => inWindow(p.a, w));
  const A = main.map((p) => p.a), B = main.map((p) => p.b);
  const seasons = new Set(A.map((r) => r.season));
  const gates = []; const add = (id, pass, detail, evidence) => gates.push({ id, pass, detail, evidence: evidence || null });
  add('G1_min_sample', A.length >= G.G1_min_sample.min_games && seasons.size >= G.G1_min_sample.min_seasons, A.length + ' shared games over ' + seasons.size + ' seasons (need ' + G.G1_min_sample.min_games + ' and ' + G.G1_min_sample.min_seasons + ')');
  const sa = M.summarize(A, { reliability: false }), sb = M.summarize(B, { reliability: false });
  const ll = A.length ? M.compare(A, B, 'log_loss') : { n: 0 };
  const br = A.length ? M.compare(A, B, 'brier') : { n: 0 };
  const mc = A.length ? M.compare(A, B, 'margin_crps') : { n: 0 };
  add('G2_log_loss', !!ll.n && ll.mean_diff <= G.G2_log_loss.max_diff && ll.ci95[1] < 0, ll.n ? 'difference ' + ll.mean_diff + ' (95% CI ' + JSON.stringify(ll.ci95) + '), need <= ' + G.G2_log_loss.max_diff + ' with the interval below 0' : 'no shared games', ll);
  add('G3_brier', !!br.n && br.mean_diff <= G.G3_brier.max_diff, br.n ? 'difference ' + br.mean_diff + ' (95% CI ' + JSON.stringify(br.ci95) + ')' : 'no shared games', br);
  add('G4_margin_crps', !!mc.n && mc.mean_diff <= G.G4_margin_crps.max_diff, mc.n ? 'difference ' + mc.mean_diff + ' (95% CI ' + JSON.stringify(mc.ci95) + '), limit +' + G.G4_margin_crps.max_diff : 'no shared games', mc);
  const cal = G.G5_calibration; const fails = [];
  if (sa.n) {
    if (Math.abs(sa.win.calibration_in_the_large) > cal.citl_max) fails.push('citl ' + sa.win.calibration_in_the_large);
    const sl = sa.win.logistic_recalibration.slope; if (sl < cal.slope[0] || sl > cal.slope[1]) fails.push('slope ' + sl);
    if (sa.margin.coverage.c80 < cal.coverage80[0] || sa.margin.coverage.c80 > cal.coverage80[1]) fails.push('margin 80% coverage ' + sa.margin.coverage.c80);
    if (sa.total.coverage.c80 < cal.coverage80[0] || sa.total.coverage.c80 > cal.coverage80[1]) fails.push('total 80% coverage ' + sa.total.coverage.c80);
    if (sa.overtime && Math.abs(sa.overtime.mean_forecast - sa.overtime.observed) > cal.ot_rate_abs_max) fails.push('overtime ' + sa.overtime.mean_forecast + ' vs ' + sa.overtime.observed);
  } else fails.push('no rows');
  add('G5_calibration', !fails.length, fails.length ? fails.join('; ') : 'citl ' + sa.win.calibration_in_the_large + ', slope ' + sa.win.logistic_recalibration.slope + ', coverage80 margin ' + sa.margin.coverage.c80 + ' total ' + sa.total.coverage.c80 + (sa.overtime ? ', overtime ' + sa.overtime.mean_forecast + ' vs ' + sa.overtime.observed : ''));
  const coh = {}; const cfails = [];
  for (const name of G.G6_cohorts.cohorts) {
    const f = COHORTS[name]; if (!f) { cfails.push('unknown cohort ' + name); continue; }
    const P = pairsAll.filter((p) => inWindow(p.a, Object.assign({}, w, { include_regimes: true })) && f(p.a, ctx));
    if (P.length < G.G6_cohorts.min_games) { coh[name] = { n: P.length, gated: false }; continue; }
    const c = M.compare(P.map((p) => p.a), P.map((p) => p.b), 'log_loss');
    const bad = c.mean_diff > G.G6_cohorts.max_worse && c.ci95[0] > 0;
    coh[name] = { n: P.length, gated: true, mean_diff: c.mean_diff, ci95: c.ci95, regression: bad };
    if (bad) cfails.push(name + ' worse by ' + c.mean_diff + ' ' + JSON.stringify(c.ci95));
  }
  add('G6_cohorts', !cfails.length, cfails.length ? cfails.join('; ') : 'no gated cohort regressed', coh);
  const integ = ctx.integrity || {}; const ifails = [];
  if (!integ.dataset_hashes_ok) ifails.push('dataset hashes');
  if (integ.leakage_violations !== 0) ifails.push('leakage violations ' + integ.leakage_violations);
  if (!integ.snapshot_sha256) ifails.push('no training snapshot');
  if (!integ.artifact_reproducible) ifails.push('artifact not reproducible');
  add('G7_integrity', !ifails.length, ifails.length ? ifails.join('; ') : 'hashes, leakage audit, snapshot ' + String(integ.snapshot_sha256).slice(0, 12) + ', reproducible artifact');
  const ops = ctx.operations || {}; const ofails = [];
  if (!(ops.runtime_min <= G.G8_operations.max_runtime_min)) ofails.push('runtime ' + ops.runtime_min + ' min');
  if (!A.every((r) => r.s.p_home > 0 && r.s.p_home < 1 && Number.isFinite(r.s.m_crps))) ofails.push('non-finite or boundary probability');
  add('G8_operations', !ofails.length, ofails.length ? ofails.join('; ') : 'runtime ' + ops.runtime_min + ' min, outputs finite');
  const g1 = gates[0].pass; const all = gates.every((g) => g.pass);
  return {
    decision: !g1 ? 'INSUFFICIENT_EVIDENCE' : all ? 'PROMOTE' : 'RETAIN',
    gates, window: w, shared_games: A.length, seasons: [...seasons].sort(),
    challenger: summaryLite(sa), champion: summaryLite(sb),
  };
}
function summaryLite(s) { return s.n ? { n: s.n, log_loss: s.win.log_loss, brier: s.win.brier, citl: s.win.calibration_in_the_large, slope: s.win.logistic_recalibration.slope, margin_crps: s.margin.crps, margin_mae: s.margin.mae, margin_c80: s.margin.coverage.c80, total_crps: s.total.crps, total_mae: s.total.mae, total_c80: s.total.coverage.c80, overtime: s.overtime || null } : { n: 0 }; }

/** leakage audit of walk-forward rows: inputs must be known before the prediction */
function leakage(rows) {
  let checked = 0, bad = 0; const ex = [];
  for (const r of rows) {
    if (r.inputs_known_through == null) continue;
    checked++;
    const pred = Date.parse(r.predicted_at);
    if (!(r.inputs_known_through < pred)) { bad++; if (ex.length < 5) ex.push(r.game_id); }
  }
  return { checked, violations: bad, examples: ex };
}

module.exports = { gate, leakage, inWindow, COHORTS, HOLDOUT, summaryLite };
