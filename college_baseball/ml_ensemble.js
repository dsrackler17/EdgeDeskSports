'use strict';
/* ===========================================================================
   EdgeDesk college baseball — machine learning (Model 6) and the validated
   ensemble (Model 8), on the team walk-forward's out-of-sample predictions.

     node college_baseball/ml_ensemble.js

   LEAKAGE. Every input is a pregame quantity: the base models' out-of-sample
   probabilities and run expectations (each computed from earlier dates only)
   and the game's schedule context. Learners are fitted on SELECTION rows and
   scored on VALIDATION rows; HOLDOUT is never touched here.

   MODEL 6  glm   L2 logistic regression on the features below
            gbm   depth-2 gradient boosting (lib/gbm.js), same features
   MODEL 8  ens   logistic stacking of the calibrated base models' logits only.
            Kept ONLY if a date-block bootstrap of its VALIDATION log loss
            against the best single model has a 95% interval wholly below 0.
            Its weights are also fitted on three separate season blocks; large
            swings between blocks are reported (auditor check 17).
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const S = require('../engine/stats');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const GBM = require('./lib/gbm');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const r = V.r;
const FEATURES = ['logit_hier', 'logit_elo', 'logit_massey', 'logit_pythag', 'log_run_ratio', 'hier_sd', 'min_info', 'neutral', 'conf_game', 'weekend', 'dh', 'tourney', 'days_into_season'];

function feats(x) {
  return [S.logit(x.p.hier), S.logit(x.p.elo), S.logit(x.p.massey), S.logit(x.p.pythag), Math.log(x.hier_lh / x.hier_la), x.hier_sd, Math.min(60, x.hier_info || 0) / 60,
    x.neutral ? 1 : 0, x.conf_game ? 1 : 0, [5, 6, 0].includes(x.weekday) ? 1 : 0, x.dh ? 1 : 0, x.tourney ? 1 : 0, Math.min(140, K.daysBetween(x.season + '-02-10', x.date)) / 140];
}
const STACK = ['hier_cal', 'elo_cal', 'massey_cal', 'pythag_cal'];
function stackFeats(x) { return [1].concat(STACK.map((m) => S.logit(x.p[m]))); }

function main() {
  const all = JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.hier_lh != null && STACK.every((m) => x.p[m] != null) && x.p.elo != null);
  const sel = all.filter((x) => x.window === 'SELECTION'); const val = all.filter((x) => x.window === 'VALIDATION');
  /* standardise on SELECTION */
  const Xs = sel.map(feats); const mu = FEATURES.map((_, j) => Xs.reduce((a, x) => a + x[j], 0) / Xs.length);
  const sd = FEATURES.map((_, j) => Math.sqrt(Xs.reduce((a, x) => a + Math.pow(x[j] - mu[j], 2), 0) / Xs.length) || 1);
  const z = (x) => [1].concat(x.map((v, j) => (v - mu[j]) / sd[j]));
  const ysel = sel.map((x) => x.y);
  const glm = S.logistic(Xs.map(z), ysel, { l2: 1.0 });
  const t0 = Date.now();
  const gbm = GBM.fit(Xs, ysel, { trees: 150, depth: 2, lr: 0.05, minLeaf: 300, lambda: 20 });
  const gbmSecs = (Date.now() - t0) / 1000;
  const stack = S.logistic(sel.map(stackFeats), ysel, { l2: 1e-4 });
  /* weight stability across season blocks */
  const blocks = [[2014, 2016], [2017, 2019], [2020, 2022]];
  const blockW = blocks.map(([a, b]) => { const rs = sel.filter((x) => x.season >= a && x.season <= b); return { seasons: [a, b], n: rs.length, weights: Array.from(S.logistic(rs.map(stackFeats), rs.map((x) => x.y), { l2: 1e-4 }).beta).map((v) => r(v, 3)) }; });
  const chosenName = JSON.parse(fs.readFileSync(C.PATHS.walkforward, 'utf8')).selection.chosen;
  const preds = (rs) => rs.map((x) => ({ date: x.date, y: x.y, chosen: x.p[chosenName], hier: x.p.hier, elo: x.p.elo_cal, glm: S.sigmoid(S.dot(glm.beta, z(feats(x)))), gbm: GBM.predict(gbm, feats(x)), ens: S.sigmoid(S.dot(stack.beta, stackFeats(x))) }));
  const out = { schema: 'edgedesk_cbase_ml_ensemble_v1', point_in_time: 'RETROSPECTIVE', features: FEATURES, fitted_on: 'SELECTION 2014-2022', scored_on: 'VALIDATION 2023-2024',
    glm: { beta: Array.from(glm.beta).map((v) => r(v, 4)), l2: 1.0 }, gbm: { trees: 150, depth: 2, lr: 0.05, min_leaf: 300, seconds: gbmSecs, split_importance: Object.fromEntries(FEATURES.map((f, i) => [f, GBM.importance(gbm, FEATURES.length)[i]])) },
    ensemble: { members: STACK, weights: Array.from(stack.beta).map((v) => r(v, 4)), block_weights: blockW }, windows: {} };
  for (const [w, rs] of [['SELECTION', sel], ['VALIDATION', val]]) {
    const pr = preds(rs);
    const m = {}; for (const k of ['chosen', 'hier', 'elo', 'glm', 'gbm', 'ens']) { const b = V.binary(pr.map((x) => ({ p: x[k], y: x.y }))); m[k] = { n: b.n, log_loss: b.log_loss, brier: b.brier, citl: b.calibration_in_the_large, slope: b.calibration_slope }; }
    const cmp = (a, b) => V.pairedBootstrap(pr.map((x) => ({ date: x.date, a: V.logLoss(x[a], x.y), b: V.logLoss(x[b], x.y) })), { B: 1000 });
    out.windows[w] = { n: rs.length, models: m, comparisons: { glm_vs_chosen: cmp('glm', 'chosen'), gbm_vs_glm: cmp('gbm', 'glm'), gbm_vs_chosen: cmp('gbm', 'chosen'), ens_vs_chosen: cmp('ens', 'chosen') } };
  }
  const vc = out.windows.VALIDATION.comparisons;
  out.decisions = {
    glm: vc.glm_vs_chosen.a_better ? 'ADOPT_CANDIDATE' : 'REJECT',
    gbm: vc.gbm_vs_glm.a_better && vc.gbm_vs_chosen.a_better ? 'ADOPT_CANDIDATE' : 'REJECT',
    ensemble: vc.ens_vs_chosen.a_better ? 'ADOPT' : 'REJECT',
    rule: 'a learner is adopted only if its VALIDATION log loss beats the chosen single model with a block-bootstrap 95% interval wholly below zero; boosting must also beat the GLM',
  };
  const spread = STACK.map((_, i) => { const ws = blockW.map((b) => b.weights[i + 1]); return r(Math.max(...ws) - Math.min(...ws), 3); });
  out.ensemble.weight_spread_across_blocks = Object.fromEntries(STACK.map((m, i) => [m, spread[i]]));
  K.writeJson(require('path').join(C.PATHS.validation, 'ml_ensemble.json'), out);
  for (const [id, model, dec, cmp] of [['CBX-ML-GLM', 'glm', out.decisions.glm, vc.glm_vs_chosen], ['CBX-ML-GBM', 'gbm', out.decisions.gbm, vc.gbm_vs_chosen], ['CBX-ENSEMBLE', 'ensemble', out.decisions.ensemble, vc.ens_vs_chosen]]) {
    REG.register({ id, family: 'ml_' + model, title: `${model} on base-model OOS predictions + context`, hypothesis: `${model} improves VALIDATION moneyline log loss over the chosen single model`,
      dataset: { warehouse: 'college_baseball/data', rows: 'walkforward cache' }, windows: { training: [2014, 2022], validation: [2023, 2024], holdout: null },
      features: model === 'ensemble' ? STACK : FEATURES, algorithm: model === 'gbm' ? out.gbm : model === 'glm' ? out.glm : out.ensemble, seeds: [20261013],
      metrics: { validation: out.windows.VALIDATION.models[model === 'ensemble' ? 'ens' : model], chosen: out.windows.VALIDATION.models.chosen }, uncertainty: cmp,
      decision: dec === 'REJECT' ? 'REJECT' : 'ACCEPT', justification: dec === 'REJECT' ? 'the 95% interval of the VALIDATION log-loss difference vs the chosen model is not wholly below zero' : 'VALIDATION improvement with a 95% interval below zero', holdout_evaluated: false });
  }
  console.log(JSON.stringify(out.windows.VALIDATION.models));
  console.log(JSON.stringify(out.windows.VALIDATION.comparisons));
  console.log(JSON.stringify(out.decisions), 'weight spread', JSON.stringify(out.ensemble.weight_spread_across_blocks));
}

if (require.main === module) main();
module.exports = { FEATURES, feats };
