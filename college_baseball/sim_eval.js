'use strict';
/* ===========================================================================
   EdgeDesk college baseball — which engine prices which market? (Model 5)

     node college_baseball/sim_eval.js

   On VALIDATION games that have a reconciled inning line (2023-2024, every
   second one), against what actually happened:

   FULL GAME (moneyline, total, home -1.5): the closed form the board prices
   from (distribution.closedForm at the pricing model's run-space calibrated
   expectations, mixed over rating uncertainty and scheduled length) against
   the inning simulator fed the run model's own expectations, and against the
   simulator fed the calibrated expectations (the first version's mistake: the
   calibration shifts the ratio so the CLOSED FORM's P(home) is right, and the
   simulator, which models the home side's unplayed or cut-short last inning
   explicitly, counts that effect twice). Paired date-block bootstrap on each.

   CONSTRUCTION (every VALIDATION game): the closed form at the calibrated
   expectations against the closed form at the run model's own expectations
   re-weighted so P(home) is the validated probability. Same moneyline; the
   question is which gives the better totals, run lines and team runs (the
   calibration moves the run ratio, which biases each side's level).

   FIRST FIVE (simulator only; the closed form has no innings): calibration of
   the home-win and tie probabilities.

   Also: walk-off and run-rule shares, the coherence of the combined price
   (closed-form full game + simulator first five), Monte Carlo convergence.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const D = require('./lib/distribution');
const SIM = require('./lib/simulator');
const PR = require('./lib/pricing');
const RULES = require('./lib/rules');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const r = V.r;
const SIMS = 2000;

function main() {
  const constants = WF.constants(); const t = WF.tuning(); const spec = t.dist || { family: 'nb', r: 4 }; const frailty = t.sim_frailty || {};
  const rr = JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'rules_evidence.json'), 'utf8')).run_rule;
  const rrP = (g) => { const k = g.ncaa_tourney_inferred ? 'ncaa_tourney' : (g.conf_game ? 'conf' : 'nonconf'); const e = rr[k] || rr.all; return e ? e.stopped / Math.max(1, e.eligible) : 0; };
  const wf = JSON.parse(fs.readFileSync(C.PATHS.walkforward, 'utf8'));
  const pricing = wf.pricing ? wf.pricing.model : 'hier_cal';
  if (pricing !== 'hier_cal') console.error(`note: the pricing model is ${pricing}; this study scores the closed form at hier_cal's expectations`);
  const rows = JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.window === 'VALIDATION' && x.hier_lh != null && x.hier_cal_lh != null);
  const gm = new Map(); for (const s of [2023, 2024]) for (const g of W.games(s)) gm.set(g.game_id, g);
  const sample = rows.filter((x) => { const g = gm.get(x.game_id); return g && g.away_line; }).filter((_, i) => i % 2 === 0);
  const p7 = WF.p7Context();
  /* ---- construction study on every VALIDATION game */
  const allG = new Map(); for (const s2 of [2023, 2024]) for (const g of W.games(s2)) allG.set(g.game_id, g);
  const con = [];
  for (const x of rows) {
    const g = allG.get(x.game_id); if (!g) continue;
    const P7 = p7.fn(g); const sd = x.hier_sd || 0; const target = x.p.hier_cal;
    const A = D.closedForm(x.hier_cal_lh, x.hier_cal_la, sd, P7, spec, constants);
    const B = D.closedForm(x.hier_lh, x.hier_la, sd, P7, spec, constants, { p_home_target: target });
    const tot = x.home_runs + x.away_runs; const cover = x.home_runs - x.away_runs >= 2 ? 1 : 0; const coverP = x.home_runs - x.away_runs >= -1 ? 1 : 0;
    const rlA = PR.fromClosedForm(A); const rlB = PR.fromClosedForm(B);
    const clip = (v) => Math.min(1 - 1e-6, Math.max(1e-6, v));
    con.push({ date: x.date, y: x.y, cover, coverP, p_A: A.p_home, p_B: B.p_home,
      tot_A: D.logScore(A.total_pmf, tot), tot_B: D.logScore(B.total_pmf, tot),
      h_A: D.logScore(A.home_pmf, x.home_runs), h_B: D.logScore(B.home_pmf, x.home_runs), a_A: D.logScore(A.away_pmf, x.away_runs), a_B: D.logScore(B.away_pmf, x.away_runs),
      rl_A: clip(PR.runLine(rlA.margin, rlA.marginOffset, -1.5).home_cover), rl_B: clip(PR.runLine(rlB.margin, rlB.marginOffset, -1.5).home_cover),
      rlp_A: clip(PR.runLine(rlA.margin, rlA.marginOffset, 1.5).home_cover), rlp_B: clip(PR.runLine(rlB.margin, rlB.marginOffset, 1.5).home_cover),
      eh_A: A.exp_home, eh_B: B.exp_home, ea_A: A.exp_away, ea_B: B.exp_away, hr: x.home_runs, ar: x.away_runs });
  }
  const cm = (k) => r(con.reduce((a2, x) => a2 + x[k], 0) / con.length, 5);
  const bb = (rs) => { const z = V.binary(rs); return { n: z.n, log_loss: z.log_loss, citl: z.calibration_in_the_large, slope: z.calibration_slope }; };
  const ccmp = (fa, fb) => P.compare(con, fa, fb);
  const construction = { n: con.length,
    candidates: { calibrated_expectations: 'closed form at the run-space calibrated expectations', reweighted_raw: 'closed form at the run model\'s own expectations, re-weighted so P(home) is the validated probability' },
    moneyline_log_loss: { calibrated_expectations: bb(con.map((x) => ({ p: x.p_A, y: x.y }))).log_loss, reweighted_raw: bb(con.map((x) => ({ p: x.p_B, y: x.y }))).log_loss },
    total_log_score: { calibrated_expectations: cm('tot_A'), reweighted_raw: cm('tot_B') },
    team_runs_log_score: { calibrated_expectations: r((cm('h_A') + cm('a_A')) / 2, 5), reweighted_raw: r((cm('h_B') + cm('a_B')) / 2, 5) },
    expected_runs: { home: { calibrated_expectations: cm('eh_A'), reweighted_raw: cm('eh_B'), observed: cm('hr') }, away: { calibrated_expectations: cm('ea_A'), reweighted_raw: cm('ea_B'), observed: cm('ar') } },
    home_minus_1_5: { calibrated_expectations: bb(con.map((x) => ({ p: x.rl_A, y: x.cover }))), reweighted_raw: bb(con.map((x) => ({ p: x.rl_B, y: x.cover }))) },
    home_plus_1_5: { calibrated_expectations: bb(con.map((x) => ({ p: x.rlp_A, y: x.coverP }))), reweighted_raw: bb(con.map((x) => ({ p: x.rlp_B, y: x.coverP }))) },
    comparisons: {
      total: ccmp((x) => x.tot_B, (x) => x.tot_A),
      team_runs: ccmp((x) => (x.h_B + x.a_B) / 2, (x) => (x.h_A + x.a_A) / 2),
      run_line_minus: ccmp((x) => V.logLoss(x.rl_B, x.cover), (x) => V.logLoss(x.rl_A, x.cover)),
      run_line_plus: ccmp((x) => V.logLoss(x.rlp_B, x.coverP), (x) => V.logLoss(x.rlp_A, x.coverP)),
    } };
  const cc = construction.comparisons;
  const reweightedNotWorse = !cc.total.b_better && !cc.team_runs.b_better && !cc.run_line_minus.b_better && !cc.run_line_plus.b_better;
  construction.decision = reweightedNotWorse ? 'reweighted_raw' : 'calibrated_expectations';
  const useB = construction.decision === 'reweighted_raw';
  const per = []; const f5 = []; let incoherent = 0; let maxSeF5 = 0; let wPred = 0; let wObs = 0; let rrPred = 0; let rrObs = 0;
  const level = { actual_home: 0, actual_away: 0, raw_lh: 0, raw_la: 0, cal_lh: 0, cal_la: 0 };
  const t0 = Date.now();
  let i = 0;
  for (const x of sample) {
    const g = gm.get(x.game_id); const P7 = p7.fn(g); const sd = x.hier_sd || 0; const ctx = { p7: P7, run_rule_p: rrP(g), frailty, sd };
    level.actual_home += x.home_runs; level.actual_away += x.away_runs; level.raw_lh += x.hier_lh; level.raw_la += x.hier_la; level.cal_lh += x.hier_cal_lh; level.cal_la += x.hier_cal_la;
    const cf = useB ? D.closedForm(x.hier_lh, x.hier_la, sd, P7, spec, constants, { p_home_target: x.p.hier_cal }) : D.closedForm(x.hier_cal_lh, x.hier_cal_la, sd, P7, spec, constants);
    const s = SIM.simulate(Object.assign({ lh: x.hier_lh, la: x.hier_la }, ctx), constants, { n: SIMS, seed: 1 + i });
    const sc = SIM.simulate(Object.assign({ lh: x.hier_cal_lh, la: x.hier_cal_la }, ctx), constants, { n: SIMS, seed: 1 + i });
    i++;
    const dCf = PR.fromClosedForm(cf); const dS = PR.fromJoint(s.joint); const dSc = PR.fromJoint(sc.joint);
    const price = PR.price(dCf, { f5: s.f5_joint });
    if (!PR.coherence(price).ok) incoherent++;
    const tot = x.home_runs + x.away_runs; const cover = x.home_runs - x.away_runs >= 2 ? 1 : 0;
    const rl = (d) => PR.runLine(d.margin, d.marginOffset, -1.5).home_cover;
    const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
    per.push({ date: x.date, y: x.y, cover, p_cf: cf.p_home, p_sim: clip(s.p_home), p_simcal: clip(sc.p_home), ls_cf: D.logScore(dCf.total, tot), ls_sim: D.logScore(dS.total, tot), ls_simcal: D.logScore(dSc.total, tot), rl_cf: clip(rl(dCf)), rl_sim: clip(rl(dS)), rl_simcal: clip(rl(dSc)) });
    const a = RULES.parseLine(g.away_line); const h = RULES.parseLine(g.home_line);
    if (a.length >= 5 && h.length >= 5 && h[4] != null) { const fa = RULES.runsThrough(a, 5); const fh = RULES.runsThrough(h, 5); f5.push({ p: price.first_five.three_way.home, y: fh > fa ? 1 : 0, pt: price.first_five.three_way.tie, yt: fh === fa ? 1 : 0 }); }
    maxSeF5 = Math.max(maxSeF5, Math.sqrt(price.first_five.three_way.home * (1 - price.first_five.three_way.home) / SIMS));
    const inf = RULES.inferScheduled(g);
    wPred += s.walkoff_share; rrPred += s.run_rule_share;
    if (g.home_runs > g.away_runs && h.length === a.length && h[h.length - 1] != null && RULES.runsThrough(h, h.length - 1) <= RULES.runsThrough(a, a.length)) wObs++;
    if (inf.run_rule) rrObs++;
  }
  const n = per.length; const secs = (Date.now() - t0) / 1000;
  for (const k of Object.keys(level)) level[k] = r(level[k] / n, 3);
  const b = (rs) => { const z = V.binary(rs); return { n: z.n, log_loss: z.log_loss, brier: z.brier, citl: z.calibration_in_the_large, slope: z.calibration_slope }; };
  const mean = (k) => r(per.reduce((a2, x) => a2 + x[k], 0) / n, 5);
  const LL = (p, y) => V.logLoss(p, y);
  const cmp = (fa, fb) => P.compare(per, fa, fb);
  const fullGame = {
    moneyline: { closed_form: b(per.map((x) => ({ p: x.p_cf, y: x.y }))), simulator: b(per.map((x) => ({ p: x.p_sim, y: x.y }))), simulator_on_calibrated_inputs: b(per.map((x) => ({ p: x.p_simcal, y: x.y }))) },
    moneyline_log_loss: { closed_form: b(per.map((x) => ({ p: x.p_cf, y: x.y }))).log_loss, simulator: b(per.map((x) => ({ p: x.p_sim, y: x.y }))).log_loss, simulator_on_calibrated_inputs: b(per.map((x) => ({ p: x.p_simcal, y: x.y }))).log_loss },
    total_log_score: { closed_form: mean('ls_cf'), simulator: mean('ls_sim'), simulator_on_calibrated_inputs: mean('ls_simcal') },
    home_minus_1_5: { closed_form: b(per.map((x) => ({ p: x.rl_cf, y: x.cover }))), simulator: b(per.map((x) => ({ p: x.rl_sim, y: x.cover }))), simulator_on_calibrated_inputs: b(per.map((x) => ({ p: x.rl_simcal, y: x.cover }))) },
    comparisons: {
      moneyline_cf_vs_sim: cmp((x) => LL(x.p_cf, x.y), (x) => LL(x.p_sim, x.y)),
      total_cf_vs_sim: cmp((x) => x.ls_cf, (x) => x.ls_sim),
      run_line_cf_vs_sim: cmp((x) => LL(x.rl_cf, x.cover), (x) => LL(x.rl_sim, x.cover)),
      moneyline_sim_vs_sim_on_calibrated_inputs: cmp((x) => LL(x.p_sim, x.y), (x) => LL(x.p_simcal, x.y)),
    },
    mean_p_home: { closed_form: mean('p_cf'), simulator: mean('p_sim'), simulator_on_calibrated_inputs: mean('p_simcal'), observed: mean('y') },
  };
  /* convergence of the simulator's first-five home probability on one typical game */
  const conv = [];
  for (const nn of [1000, 5000, 20000, 50000]) {
    const ps = [1, 2, 3, 4].map((sd) => { const s = SIM.simulate({ lh: 6.6, la: 5.6, p7: 0, run_rule_p: 0.3, frailty, sd: 0.2 }, constants, { n: nn, seed: sd }); return PR.price(PR.fromJoint(s.joint), { f5: s.f5_joint }).first_five.three_way.home; });
    const m = ps.reduce((a2, b2) => a2 + b2, 0) / 4; conv.push({ n: nn, mean_f5_home: r(m, 4), seed_spread: r(Math.max(...ps) - Math.min(...ps), 4), theoretical_se: r(Math.sqrt(m * (1 - m) / nn), 4) });
  }
  const f5home = b(f5.map((x) => ({ p: x.p, y: x.y }))); const f5tie = b(f5.map((x) => ({ p: x.pt, y: x.yt })));
  const c = fullGame.comparisons;
  const cfNotWorse = !c.moneyline_cf_vs_sim.b_better && !c.total_cf_vs_sim.b_better && !c.run_line_cf_vs_sim.b_better;
  const f5ok = Math.abs(f5home.citl) <= 0.03 && f5home.slope >= 0.75 && f5home.slope <= 1.33 && Math.abs(f5tie.citl) <= 0.03;
  const out = { schema: 'edgedesk_cbase_simulator_eval_v2', point_in_time: 'RETROSPECTIVE', window: 'VALIDATION 2023-2024 (every second game with a reconciled inning line)', sims_per_game: SIMS, seconds: Math.round(secs), n,
    inputs: { closed_form: 'the pricing model\'s run-space calibrated expectations, mixed over rating uncertainty and scheduled length (distribution.closedForm)', simulator: 'the run model\'s own expectations (level-unbiased), rating uncertainty drawn per simulated game', simulator_on_calibrated_inputs: 'the calibrated expectations (the first version; double-counts the home side\'s last-inning effect)' },
    level_check: level, frailty, construction, full_game: fullGame,
    first_five: { home_win: f5home, tie: f5tie, max_mc_se: r(maxSeF5, 4) },
    walkoff_share: { predicted: r(wPred / n, 4), observed: r(wObs / n, 4) },
    run_rule_share: { predicted: r(rrPred / n, 4), observed: r(rrObs / n, 4) },
    coherence_failures: incoherent, convergence: conv,
    decision: { full_game_engine: cfNotWorse ? 'closed form' : 'REVIEW: the simulator scored better on a full-game market', full_game_construction: construction.decision, first_five_engine: f5ok ? 'simulator (PROVISIONAL)' : 'simulator, calibration outside tolerance: first-five prices are research only' } };
  K.writeJson(C.PATHS.simEval, out);
  const windows = { training: [2017, 2022], validation: [2023, 2024], holdout: null };
  REG.register({ id: 'CBX-SIMULATOR', family: 'simulator', title: 'Inning-level simulator vs closed-form run distribution',
    hypothesis: 'An inning-level simulator with measured half-inning shapes, walk-offs and rules prices run lines and first-five markets at least as well as the closed form, without losing moneyline or total accuracy',
    dataset: { warehouse: 'college_baseball/data', games: n }, windows, features: ['run model expectations', 'measured half-inning shapes', 'rules evidence', 'rating uncertainty'],
    algorithm: { name: `Monte Carlo, ${SIMS} draws per game`, frailty, inputs: out.inputs }, seeds: ['1..n per game'], metrics: { moneyline_log_loss: fullGame.moneyline_log_loss, total_log_score: fullGame.total_log_score, run_line_log_loss: { closed_form: fullGame.home_minus_1_5.closed_form.log_loss, simulator: fullGame.home_minus_1_5.simulator.log_loss }, first_five: out.first_five },
    uncertainty: fullGame.comparisons, decision: cfNotWorse && (c.moneyline_cf_vs_sim.a_better || c.total_cf_vs_sim.a_better || c.run_line_cf_vs_sim.a_better) ? 'REJECT' : 'INCONCLUSIVE',
    justification: 'the simulator loses accuracy on full-game markets against the closed form (comparisons in uncertainty), so it does not price them; it remains the only first-five engine (CBX-SIMULATOR-F5)', holdout_evaluated: false });
  REG.register({ id: 'CBX-PRICING-ENGINE', family: 'simulator', title: 'Which engine prices full-game markets',
    hypothesis: 'The closed form (negative-binomial mixture over rating uncertainty and scheduled length, at the pricing model\'s expectations) prices the moneyline, totals and run lines at least as well as the inning simulator',
    dataset: { warehouse: 'college_baseball/data', games: n }, windows, features: ['pricing model expectations', 'rating uncertainty', 'seven-inning probability'],
    algorithm: { name: 'distribution.closedForm vs lib/simulator' }, seeds: [], metrics: { moneyline: fullGame.moneyline, total_log_score: fullGame.total_log_score, run_line: fullGame.home_minus_1_5, level_check: level },
    uncertainty: fullGame.comparisons, decision: cfNotWorse ? 'ACCEPT' : 'REJECT', justification: cfNotWorse ? 'the closed form is not worse on any full-game market and better where the intervals separate; it prices every full-game market' : 'the simulator was better on at least one full-game market', holdout_evaluated: false });
  REG.register({ id: 'CBX-PRICE-CONSTRUCTION', family: 'simulator', title: 'Closed form at calibrated expectations vs raw expectations re-weighted to the validated P(home)',
    hypothesis: 'Re-weighting the run model\'s own (level-unbiased) distribution to the validated P(home) prices totals, run lines and team runs at least as well as the closed form at the calibrated expectations, with the same moneyline',
    dataset: { warehouse: 'college_baseball/data', games: con.length }, windows, features: ['run model expectations', 'validated P(home)', 'rating uncertainty', 'seven-inning probability'],
    algorithm: { name: 'distribution.closedForm with and without opts.p_home_target' }, seeds: [], metrics: { total_log_score: construction.total_log_score, team_runs_log_score: construction.team_runs_log_score, expected_runs: construction.expected_runs, home_minus_1_5: construction.home_minus_1_5, home_plus_1_5: construction.home_plus_1_5 },
    uncertainty: construction.comparisons, decision: reweightedNotWorse ? 'ACCEPT' : 'REJECT', justification: reweightedNotWorse ? 'not worse on any market and the levels are unbiased; the board prices from it' : 'worse on at least one market; the board keeps the calibrated expectations', holdout_evaluated: false });
  REG.register({ id: 'CBX-SIMULATOR-F5', family: 'simulator', title: 'First-five-inning prices from the simulator',
    hypothesis: 'The simulator\'s first-five home-win and tie probabilities are calibrated (|calibration-in-the-large| <= 0.03, slope 0.75-1.33)',
    dataset: { warehouse: 'college_baseball/data', games_with_five_innings: f5.length }, windows, features: ['run model expectations', 'inning shapes'],
    algorithm: { name: `Monte Carlo, ${SIMS} draws per game` }, seeds: ['1..n per game'], metrics: out.first_five, uncertainty: { convergence: conv },
    decision: f5ok ? 'ACCEPT' : 'REJECT', justification: f5ok ? 'calibrated within tolerance; priced as PROVISIONAL (no market test)' : 'outside the calibration tolerance', holdout_evaluated: false });
  console.log(JSON.stringify({ construction: { decision: construction.decision, total: construction.total_log_score, team_runs: construction.team_runs_log_score, expected: construction.expected_runs, rl_minus: [construction.home_minus_1_5.calibrated_expectations, construction.home_minus_1_5.reweighted_raw], rl_plus: [construction.home_plus_1_5.calibrated_expectations, construction.home_plus_1_5.reweighted_raw], cmp: Object.fromEntries(Object.entries(cc).map(([k, v]) => [k, [v.mean_diff, v.ci95]])) } }, null, 1));
  console.log(JSON.stringify({ n, level, moneyline: fullGame.moneyline_log_loss, total: fullGame.total_log_score, run_line: { cf: fullGame.home_minus_1_5.closed_form.log_loss, sim: fullGame.home_minus_1_5.simulator.log_loss }, comparisons: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [v.mean_diff, v.ci95]])), f5: out.first_five, coherence_failures: incoherent, decision: out.decision }, null, 1));
}

if (require.main === module) main();
