'use strict';
/* ===========================================================================
   EdgeDesk college baseball — which run distribution? (Model 4)

     node college_baseball/run_distribution.js     fit on SELECTION, report VALIDATION

   Uses the team model's out-of-sample run expectations (walkforward cache).
   Measures, before choosing anything:
     - overdispersion: Pearson dispersion of team runs around the model mean
     - score dependence: correlation of the two teams' standardised residuals
   Fits on SELECTION, by maximum likelihood:
     poisson; nb (size r); nb_frailty (size r0 and shared gamma k, grid)
   Scores on VALIDATION:
     team-runs log score and RPS; total-runs log score, RPS and 80% interval
     coverage; margin RPS; moneyline log loss; the tails (P(total >= 20),
     P(a side >= 15), shutouts) predicted vs observed.
   The family with the best SELECTION total-runs log score is written to
   params/team_tuning.json as the pricing distribution, and the simulator's
   game-level frailty is calibrated to reproduce its dispersion.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const D = require('./lib/distribution');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');
const SIM = require('./lib/simulator');

const r = V.r;

function rowsOf() { return JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.hier_lh != null); }

function dispersion(rows) {
  let chi = 0; let n = 0; let zh = []; let za = [];
  for (const x of rows) {
    chi += Math.pow(x.home_runs - x.hier_lh, 2) / x.hier_lh + Math.pow(x.away_runs - x.hier_la, 2) / x.hier_la; n += 2;
    zh.push((x.home_runs - x.hier_lh) / Math.sqrt(x.hier_lh)); za.push((x.away_runs - x.hier_la) / Math.sqrt(x.hier_la));
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mh = mean(zh); const ma = mean(za);
  let cov = 0; let vh = 0; let va = 0; for (let i = 0; i < zh.length; i++) { cov += (zh[i] - mh) * (za[i] - ma); vh += Math.pow(zh[i] - mh, 2); va += Math.pow(za[i] - ma, 2); }
  return { pearson_dispersion: r(chi / n, 3), residual_correlation: r(cov / Math.sqrt(vh * va), 4), n_team_games: n };
}

function score(rows, spec, constants) {
  let lsTeam = 0; let rpsTeam = 0; let lsTot = 0; let rpsTot = 0; let cov80 = 0; let rpsMar = 0; let ll = 0; const tails = { p_total_ge_20: 0, obs_total_ge_20: 0, p_side_ge_15: 0, obs_side_ge_15: 0, p_shutout: 0, obs_shutout: 0 };
  for (const x of rows) {
    const mh = D.marginal(x.hier_lh, spec); const ma = D.marginal(x.hier_la, spec);
    lsTeam += D.logScore(mh, x.home_runs) + D.logScore(ma, x.away_runs); rpsTeam += D.rpsPmf(mh, x.home_runs) + D.rpsPmf(ma, x.away_runs);
    const o = D.outcomes(x.hier_lh, x.hier_la, spec, constants);
    const tot = x.home_runs + x.away_runs;
    lsTot += D.logScore(o.total_pmf, tot); rpsTot += D.rpsPmf(o.total_pmf, tot);
    const lo = D.quantile(o.total_pmf, 0.1); const hi = D.quantile(o.total_pmf, 0.9); if (tot >= lo && tot <= hi) cov80++;
    rpsMar += D.rpsPmf(o.margin_pmf, x.home_runs - x.away_runs + o.margin_offset);
    ll += V.logLoss(o.p_home, x.y);
    let p20 = 0; for (let t = 20; t < o.total_pmf.length; t++) p20 += o.total_pmf[t];
    tails.p_total_ge_20 += p20; tails.obs_total_ge_20 += tot >= 20 ? 1 : 0;
    let p15 = 0; for (let t = 15; t < mh.length; t++) p15 += mh[t] + ma[t]; tails.p_side_ge_15 += p15 / 2; tails.obs_side_ge_15 += ((x.home_runs >= 15) + (x.away_runs >= 15)) / 2;
    tails.p_shutout += (mh[0] + ma[0]) / 2; tails.obs_shutout += ((x.home_runs === 0) + (x.away_runs === 0)) / 2;
  }
  const n = rows.length;
  for (const k of Object.keys(tails)) tails[k] = r(tails[k] / n, 4);
  return { n, team_runs_log_score: r(lsTeam / (2 * n), 5), team_runs_rps: r(rpsTeam / (2 * n), 5), total_log_score: r(lsTot / n, 5), total_rps: r(rpsTot / n, 5), total_coverage_80: r(cov80 / n, 4), margin_rps: r(rpsMar / n, 5), moneyline_log_loss: r(ll / n, 5), tails };
}

/* frailty grid fitted by total-runs log likelihood on a subsample of SELECTION */
function fitFrailty(rows, constants, rFit) {
  const sub = rows.filter((_, i) => i % 4 === 0);
  let best = null;
  for (const k of [2, 3, 4, 6, 10, 16, 25, 40, 80, 160]) for (const rr of [rFit, rFit * 1.5, rFit * 2.5, rFit * 4, rFit * 8]) {
    const spec = { family: 'nb_frailty', r: rr, k };
    let ls = 0; for (const x of sub) ls += D.logScore(D.outcomes(x.hier_lh, x.hier_la, spec, constants).total_pmf, x.home_runs + x.away_runs);
    ls /= sub.length;
    if (!best || ls < best.ls) best = { spec, ls };
  }
  return best.spec;
}

/* the simulator's frailty: match the per-team variance of the chosen family at the league mean */
function calibrateSimFrailty(spec, constants) {
  const lam = constants.runs_per_team_game;
  const target = (() => { const p = D.marginal(lam, spec); let m = 0; let v = 0; for (let i = 0; i < p.length; i++) { m += i * p[i]; v += i * i * p[i]; } return { m, v: v - m * m }; })();
  let best = null;
  for (const tk of [4, 6, 8, 12, 20, 40, 1e9]) for (const sk of [4, 8, 16, 30, 60, 1e9]) {
    const s = SIM.simulate({ lh: lam, la: lam, p7: 0, run_rule_p: 0.3, frailty: { team_k: tk, shared_k: sk } }, constants, { n: 6000, seed: 99 });
    /* variance of home runs from the simulated joint */
    let m = 0; let v = 0; let cH = 0; let cov = 0; let ma = 0;
    for (const [h, a, p] of s.joint) { m += h * p; v += h * h * p; ma += a * p; cov += h * a * p; cH += p; }
    const varH = v - m * m; const covHA = cov - m * ma;
    const err = Math.pow(varH - target.v, 2) / target.v + (spec.family === 'nb_frailty' ? Math.pow(covHA - target_cov(spec, lam), 2) / target.v : 0);
    if (!best || err < best.err) best = { team_k: tk, shared_k: sk, err, sim_var: varH, sim_cov: covHA };
  }
  return Object.assign(best, { target_var: target.v, league_mean: lam });
}
function target_cov(spec, lam) { return spec.family === 'nb_frailty' ? lam * lam / spec.k : 0; }

function main() {
  const all = rowsOf();
  const constants = WF.constants();
  const sel = all.filter((x) => x.window === 'SELECTION'); const val = all.filter((x) => x.window === 'VALIDATION');
  /* FIT and CHOOSE on separate parts of SELECTION: choosing a family on the rows that fitted its
     parameters favours the most flexible one (the first run of this script did exactly that) */
  const selFit = sel.filter((x) => x.season <= 2018); const selChoose = sel.filter((x) => x.season >= 2019);
  const disp = { selection: dispersion(sel), validation: dispersion(val) };
  const teamRows = []; for (const x of selFit) { teamRows.push({ mean: x.hier_lh, y: x.home_runs }, { mean: x.hier_la, y: x.away_runs }); }
  const rFit = D.fitNbSize(teamRows, 0.5, 200);
  const fr = fitFrailty(selFit, constants, rFit);
  const specs = { poisson: { family: 'poisson' }, nb: { family: 'nb', r: r(rFit, 3) }, nb_frailty: { family: 'nb_frailty', r: r(fr.r, 3), k: fr.k } };
  const res = { SELECTION_CHOOSE: {}, VALIDATION: {} };
  for (const [name, spec] of Object.entries(specs)) { res.SELECTION_CHOOSE[name] = score(selChoose, spec, constants); res.VALIDATION[name] = score(val, spec, constants); }
  /* the protocol's rule (research/PROTOCOL.md §3): families in order of complexity, the simplest is the
     incumbent, a challenger must improve the SELECTION total-runs log score by >= 0.001 */
  const chosen = require('../engine/lab/protocol').choose(Object.fromEntries(Object.entries(res.SELECTION_CHOOSE).map(([k, v]) => [k, v.total_log_score])), ['poisson', 'nb', 'nb_frailty']);
  const sim = calibrateSimFrailty(specs[chosen], constants);
  const out = { schema: 'edgedesk_cbase_run_distribution_v1', point_in_time: 'RETROSPECTIVE', fitted_on: 'SELECTION 2014-2018 (parameters), chosen on SELECTION 2019-2022, reported on VALIDATION 2023-2024; team-model out-of-sample run expectations',
    dispersion: disp, specs, scores: res, chosen, chosen_spec: specs[chosen], simulator_frailty: sim,
    findings: [
      `Pearson dispersion of team runs around the model mean: ${disp.selection.pearson_dispersion} (SELECTION), ${disp.validation.pearson_dispersion} (VALIDATION); 1 would be Poisson`,
      `Correlation of the two teams' standardised residuals: ${disp.selection.residual_correlation} (SELECTION), ${disp.validation.residual_correlation} (VALIDATION)`,
      `VALIDATION total-runs log score: ${Object.entries(res.VALIDATION).map(([k, v]) => k + ' ' + v.total_log_score).join(', ')}`,
    ] };
  K.writeJson(C.PATHS.distEval, out);
  const t = WF.tuning(); t.dist = specs[chosen]; t.sim_frailty = { team_k: sim.team_k, shared_k: sim.shared_k }; K.writeJson(require('path').join(C.PATHS.params, 'team_tuning.json'), t);
  REG.register({ id: 'CBX-DIST-FAMILY', family: 'run_distribution', title: 'Run distribution family: Poisson vs negative binomial vs shared frailty',
    hypothesis: 'College run counts are overdispersed relative to Poisson and the two teams\' runs are positively correlated; a negative binomial (with or without shared frailty) scores better',
    dataset: { warehouse: 'college_baseball/data', rows: 'walkforward cache, hier run expectations' }, windows: { training: [2014, 2018], selection: [2019, 2022], validation: [2023, 2024], holdout: null },
    features: ['hier expected runs'], algorithm: { specs }, seeds: [], metrics: { validation: Object.fromEntries(Object.entries(res.VALIDATION).map(([k, v]) => [k, { total_log_score: v.total_log_score, ml_log_loss: v.moneyline_log_loss, coverage_80: v.total_coverage_80 }])) },
    uncertainty: disp, decision: 'ACCEPT', justification: `${chosen} has the best total-runs log score on SELECTION 2019-2022 (parameters fitted on 2014-2018); VALIDATION reported above`, holdout_evaluated: false });
  for (const f of out.findings) console.log(f);
  console.log('SELECTION 2019-2022 total log score', JSON.stringify(Object.fromEntries(Object.entries(res.SELECTION_CHOOSE).map(([k, v]) => [k, v.total_log_score]))));
  console.log('chosen', chosen, JSON.stringify(specs[chosen]), 'sim frailty', JSON.stringify(sim));
  for (const [k, v] of Object.entries(res.VALIDATION)) console.log(k.padEnd(11), JSON.stringify(v));
}

if (require.main === module) main();
module.exports = { score, dispersion };
