'use strict';
/* ===========================================================================
   EdgeDesk college baseball — is the simulator right? (Model 5 evaluation)

     node college_baseball/sim_eval.js

   On VALIDATION games that have a reconciled inning line (2023-2024), with the
   team model's out-of-sample run expectations:
     - simulator vs closed form: P(home), and which one scores better on the
       moneyline, the total (log score) and the home -1.5 run line;
     - calibration of things only the simulator prices: the home side covering
       -1.5, the first-five-inning result, walk-off share, run-rule share,
       seven-inning games;
     - convergence: one game simulated at 1k/5k/20k/50k draws and four seeds;
     - coherence of every derived market (lib/pricing.coherence).
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const W = require('./lib/warehouse');
const D = require('./lib/distribution');
const SIM = require('./lib/simulator');
const PR = require('./lib/pricing');
const RULES = require('./lib/rules');
const V = require('../engine/validation');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const r = V.r;

function main() {
  const constants = WF.constants(); const t = WF.tuning(); const spec = t.dist || { family: 'nb', r: 4 }; const frailty = t.sim_frailty || {};
  const rr = JSON.parse(fs.readFileSync(require('path').join(C.PATHS.validation, 'rules_evidence.json'), 'utf8')).run_rule;
  const rrP = (g) => { const k = g.ncaa_tourney_inferred ? 'ncaa_tourney' : (g.conf_game ? 'conf' : 'nonconf'); const e = rr[k] || rr.all; return e ? e.stopped / Math.max(1, e.eligible) : 0; };
  /* the run-space calibrated expectations: what the board actually prices from */
  const rows = JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.window === 'VALIDATION' && x.hier_lh != null)
    .map((x) => (x.hier_cal_lh != null ? Object.assign(x, { hier_lh: x.hier_cal_lh, hier_la: x.hier_cal_la }) : x));
  const gm = new Map(); for (const s of [2023, 2024]) for (const g of W.games(s)) gm.set(g.game_id, g);
  const sample = rows.filter((x) => { const g = gm.get(x.game_id); return g && g.away_line; }).filter((_, i) => i % 2 === 0);
  const p7 = WF.p7Context();
  const acc = { n: 0, ll_sim: 0, ll_cf: 0, ls_tot_sim: 0, ls_tot_cf: 0, rl_sim: [], rl_cf: [], f5: [], diff: 0, maxSe: 0, incoherent: 0, walkoff_pred: 0, walkoff_obs: 0, runrule_pred: 0, runrule_obs: 0 };
  const t0 = Date.now();
  for (const x of sample) {
    const g = gm.get(x.game_id);
    const s = SIM.simulate({ lh: x.hier_lh, la: x.hier_la, p7: p7.fn(g), run_rule_p: rrP(g), frailty }, constants, { n: 2000, seed: 1 + acc.n });
    const o = D.outcomes(x.hier_lh, x.hier_la, spec, constants);
    const dSim = PR.fromJoint(s.joint); const pSim = PR.price(dSim, { f5: s.f5_joint });
    const coh = PR.coherence(pSim); if (!coh.ok) acc.incoherent++;
    acc.n++; acc.diff += Math.abs(s.p_home - o.p_home); acc.maxSe = Math.max(acc.maxSe, s.se_p_home);
    acc.ll_sim += V.logLoss(s.p_home, x.y); acc.ll_cf += V.logLoss(o.p_home, x.y);
    const tot = x.home_runs + x.away_runs;
    acc.ls_tot_sim += D.logScore(dSim.total, tot); acc.ls_tot_cf += D.logScore(o.total_pmf, tot);
    const cover = x.home_runs - x.away_runs >= 2 ? 1 : 0;
    acc.rl_sim.push({ p: pSim.run_lines.find((l) => l.home_line === -1.5).home_cover, y: cover });
    let cfCover = 0; for (let i = 0; i < o.margin_pmf.length; i++) if (i - o.margin_offset >= 2) cfCover += o.margin_pmf[i];
    acc.rl_cf.push({ p: cfCover, y: cover });
    const a = RULES.parseLine(g.away_line); const h = RULES.parseLine(g.home_line);
    if (a.length >= 5 && h.length >= 5 && h[4] != null) { const fa = RULES.runsThrough(a, 5); const fh = RULES.runsThrough(h, 5); acc.f5.push({ p: pSim.first_five.three_way.home, y: fh > fa ? 1 : 0, pt: pSim.first_five.three_way.tie, yt: fh === fa ? 1 : 0 }); }
    const inf = RULES.inferScheduled(g);
    acc.walkoff_pred += s.walkoff_share; acc.runrule_pred += s.run_rule_share;
    if (g.home_runs > g.away_runs && h.length === a.length && h[h.length - 1] != null && RULES.runsThrough(h, h.length - 1) <= RULES.runsThrough(a, a.length)) acc.walkoff_obs++;
    if (inf.run_rule) acc.runrule_obs++;
  }
  const secs = (Date.now() - t0) / 1000;
  /* convergence on one typical game */
  const conv = [];
  for (const n of [1000, 5000, 20000, 50000]) { const ps = [1, 2, 3, 4].map((sd) => SIM.simulate({ lh: 6.6, la: 5.6, p7: 0, run_rule_p: 0.3, frailty }, constants, { n, seed: sd }).p_home); const m = ps.reduce((a2, b) => a2 + b, 0) / 4; conv.push({ n, mean_p_home: r(m, 4), seed_spread: r(Math.max(...ps) - Math.min(...ps), 4), theoretical_se: r(Math.sqrt(m * (1 - m) / n), 4) }); }
  const b = (rs) => { const x = V.binary(rs); return { n: x.n, log_loss: x.log_loss, brier: x.brier, citl: x.calibration_in_the_large, slope: x.calibration_slope }; };
  const out = { schema: 'edgedesk_cbase_simulator_eval_v1', point_in_time: 'RETROSPECTIVE', window: 'VALIDATION 2023-2024 (every second game with a reconciled inning line)', sims_per_game: 2000, seconds: Math.round(secs),
    n: acc.n, mean_abs_diff_p_home: r(acc.diff / acc.n, 4), max_mc_se: r(acc.maxSe, 4), coherence_failures: acc.incoherent, frailty,
    moneyline_log_loss: { simulator: r(acc.ll_sim / acc.n, 5), closed_form: r(acc.ll_cf / acc.n, 5) },
    total_log_score: { simulator: r(acc.ls_tot_sim / acc.n, 5), closed_form: r(acc.ls_tot_cf / acc.n, 5) },
    home_minus_1_5: { simulator: b(acc.rl_sim), closed_form: b(acc.rl_cf) },
    first_five: { home_win: b(acc.f5.map((x) => ({ p: x.p, y: x.y }))), tie: b(acc.f5.map((x) => ({ p: x.pt, y: x.yt }))) },
    walkoff_share: { predicted: r(acc.walkoff_pred / acc.n, 4), observed: r(acc.walkoff_obs / acc.n, 4) },
    run_rule_share: { predicted: r(acc.runrule_pred / acc.n, 4), observed: r(acc.runrule_obs / acc.n, 4) },
    convergence: conv };
  K.writeJson(C.PATHS.simEval, out);
  REG.register({ id: 'CBX-SIMULATOR', family: 'simulator', title: 'Inning-level simulator vs closed-form run distribution', hypothesis: 'An inning-level simulator with measured half-inning shapes, walk-offs and rules prices run lines and first-five markets at least as well as the closed form, without losing moneyline or total accuracy',
    dataset: { warehouse: 'college_baseball/data' }, windows: { training: [2017, 2022], validation: [2023, 2024], holdout: null }, features: ['team model run expectations', 'measured half-inning shapes', 'rules evidence'],
    algorithm: { name: 'Monte Carlo, 2000 draws per game', frailty }, seeds: ['1..n per game'], metrics: { moneyline_log_loss: out.moneyline_log_loss, total_log_score: out.total_log_score, run_line: out.home_minus_1_5 }, uncertainty: { max_mc_se: out.max_mc_se, convergence: conv },
    decision: out.mean_abs_diff_p_home <= 0.03 && out.coherence_failures === 0 ? 'ACCEPT' : 'REJECT', justification: 'accepted as the pricing engine for run lines and first-five markets when it agrees with the closed form within 0.03 on P(home) and every price is coherent', holdout_evaluated: false });
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
}

if (require.main === module) main();
