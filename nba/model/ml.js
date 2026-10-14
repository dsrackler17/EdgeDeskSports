'use strict';
/* ===========================================================================
   EdgeDesk NBA — MODEL E: machine learning on the point-in-time features.

   Season-level walk-forward: the models that predict season S are trained on
   the feature rows of seasons FIRST_TRAIN..S−1 only (an expanding window), so
   every prediction is out of sample. Three learners per availability track:

     ridge      linear regression of the regulation margin and of the
                regulation total (standardised features, L2 penalty)
     logit      ridge logistic regression of the home win
     gbdt       gradient-boosted trees (nba/model/learn.js): logistic for the
                home win, squared loss for the margin and the total. The number
                of trees is found by early stopping on season S−1 (a model
                trained on ..S−2), then the model is refitted on ..S−1 with
                that many trees.

   Hyperparameters (ridge λ, tree depth, learning rate, leaf size) are chosen
   on the SELECTION window only (nba/model/walkforward.js --tune-ml).

   TRACKS. `P` (projected) features never read this game's box or who played
   in it; `C` (confirmed) adds the confirmed-availability features. A P-track
   model is what can be published in the morning; a C-track model is what the
   price becomes once the inactive list is out.
   =========================================================================== */
const L = require('./learn');
const S = require('../../engine/stats');

const FIRST_TRAIN = 2004;
const GROUPS = {
  ratings: ['elo_diff', 'gl_logit', 'eff_m', 'kal_m', 'kal_sd'],
  totals: ['eff_t', 'kal_t', 'pace', 'pp_h', 'pp_a'],
  factors: ['efg_h', 'efg_a', 'tov_h', 'tov_a', 'orb_h', 'orb_a', 'ftr_h', 'ftr_a', 'tpar_h', 'tpar_a'],
  luck: ['luck_oh', 'luck_dh', 'luck_oa', 'luck_da'],
  schedule: ['rest_h', 'rest_a', 'b2b_h', 'b2b_a', 'g7_h', 'g7_a', 'trav_h', 'trav_a', 'tz_h', 'tz_a', 'alt_vis', 'road_a', 'homestand_h'],
  context: ['neutral', 'playoff', 'gp_h', 'gp_a'],
  players_proj: ['plr_m_proj', 'adj_proj', 'proj_stale'],
  players_conf: ['plr_m_conf', 'adj_conf', 'cont_h', 'cont_a', 'plr_off_h', 'plr_def_h', 'plr_off_a', 'plr_def_a', 'unk_min'],
};
const TRACKS = {
  P: ['ratings', 'totals', 'factors', 'luck', 'schedule', 'context', 'players_proj'],
  C: ['ratings', 'totals', 'factors', 'luck', 'schedule', 'context', 'players_proj', 'players_conf'],
};
function featureNames(track, drop) { return TRACKS[track].filter((g) => g !== drop).flatMap((g) => GROUPS[g]); }

function value(f, k) {
  if (k === 'gl_logit') return S.logit(f.gl_p);
  const v = f[k]; return v == null || !isFinite(v) ? 0 : v;
}
function design(rows, names) { return rows.map((r) => [1].concat(names.map((k) => value(r.f, k)))); }

const DEFAULT_CFG = {
  ridge_l2: 30, logit_l2: 30,
  gbdt: { trees: 600, depth: 3, lr: 0.04, minLeaf: 80, l2: 5, subsample: 0.8, colsample: 0.8, bins: 32, patience: 40 },
  learners: ['ridge', 'logit', 'gbdt'],
};

/**
 * Attach out-of-sample predictions to rows (f.ml{track}_{learner}_{target}).
 * cfg: { ridge_l2, logit_l2, gbdt, learners, seasons (subset to predict), drop (a group) }
 */
function fitPredict(rows, track, cfg, o) {
  cfg = Object.assign({}, DEFAULT_CFG, cfg || {}); o = o || {};
  const names = featureNames(track, cfg.drop);
  const tag = 'ml' + track + (cfg.tag || '');
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b).filter((s) => s > FIRST_TRAIN && (!cfg.seasons || cfg.seasons.includes(s)));
  const info = { features: names, seasons: {}, importance: null, coef: {} };
  for (const s of seasons) {
    const train = rows.filter((r) => r.y && r.season >= FIRST_TRAIN && r.season < s);
    const test = rows.filter((r) => r.season === s);
    if (train.length < 500 || !test.length) continue;
    const trM = train.filter((r) => r.y.reg_margin != null), trT = train.filter((r) => r.y.reg_total != null);
    const Xt = design(test, names);
    const si = { n_train: train.length };
    if (cfg.learners.includes('ridge')) {
      const fm = L.ridge(design(trM, names), trM.map((r) => r.y.reg_margin), { l2: cfg.ridge_l2 });
      const ft = L.ridge(design(trT, names), trT.map((r) => r.y.reg_total), { l2: cfg.ridge_l2 });
      test.forEach((r, i) => { r.f[tag + '_ridge_m'] = L.predictLinear(fm.beta, Xt[i]); r.f[tag + '_ridge_t'] = L.predictLinear(ft.beta, Xt[i]); });
      info.coef[s] = { margin: fm.beta.map((b) => Math.round(b * 1e5) / 1e5) };
    }
    if (cfg.learners.includes('logit')) {
      const fl = L.logisticRidge(design(train, names), train.map((r) => r.y.hw), { l2: cfg.logit_l2 });
      test.forEach((r, i) => { r.f[tag + '_logit_p'] = L.predictLogistic(fl.beta, Xt[i]); });
    }
    if (cfg.learners.includes('gbdt')) {
      const g = cfg.gbdt;
      const fitG = (tr, yk, loss) => {
        const prev = tr.filter((r) => r.season === s - 1), early = tr.filter((r) => r.season < s - 1);
        let nT = g.trees;
        if (prev.length > 200 && early.length > 500) {
          const m0 = L.gbdt(design(early, names), early.map(yk), Object.assign({}, g, { loss, valid: { X: design(prev, names), y: prev.map(yk) } }));
          nT = Math.max(20, m0.used);
        }
        return L.gbdt(design(tr, names), tr.map(yk), Object.assign({}, g, { loss, trees: nT, valid: null }));
      };
      const gp = fitG(train, (r) => r.y.hw, 'logistic');
      const gm = fitG(trM, (r) => r.y.reg_margin, 'squared');
      const gt = fitG(trT, (r) => r.y.reg_total, 'squared');
      test.forEach((r, i) => { r.f[tag + '_gbdt_p'] = L.predictGbdt(gp, Xt[i]); r.f[tag + '_gbdt_m'] = L.predictGbdt(gm, Xt[i]); r.f[tag + '_gbdt_t'] = L.predictGbdt(gt, Xt[i]); });
      si.trees = { p: gp.used, m: gm.used, t: gt.used };
      info.importance = L.gbdtUsage(gp, names);
      if (o.keepModels) info.models = { gbdt_p: gp, gbdt_m: gm, gbdt_t: gt };
    }
    info.seasons[s] = si;
    if (o.log) console.error('[nba ml] ' + track + ' ' + s + ' trained on ' + train.length + (si.trees ? ' trees ' + JSON.stringify(si.trees) : ''));
  }
  return info;
}

/** the live models: trained on every season before `season`, returned for the slate */
function fitLive(rows, track, cfg, season) {
  cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
  const names = featureNames(track);
  const train = rows.filter((r) => r.y && r.season >= FIRST_TRAIN && r.season < season);
  const trM = train.filter((r) => r.y.reg_margin != null), trT = train.filter((r) => r.y.reg_total != null);
  const out = { track, features: names, trained_through: season - 1, n: train.length };
  /* feature means and sds on the training rows: explanations read contributions against them */
  out.mean = names.map((k) => train.reduce((a, r) => a + value(r.f, k), 0) / train.length);
  out.sd = names.map((k, j) => Math.sqrt(train.reduce((a, r) => a + Math.pow(value(r.f, k) - out.mean[j], 2), 0) / train.length) || 1);
  out.ridge_m = L.ridge(design(trM, names), trM.map((r) => r.y.reg_margin), { l2: cfg.ridge_l2 }).beta;
  out.ridge_t = L.ridge(design(trT, names), trT.map((r) => r.y.reg_total), { l2: cfg.ridge_l2 }).beta;
  out.logit = L.logisticRidge(design(train, names), train.map((r) => r.y.hw), { l2: cfg.logit_l2 }).beta;
  const g = cfg.gbdt;
  const fitG = (tr, yk, loss) => {
    const prev = tr.filter((r) => r.season === season - 1), early = tr.filter((r) => r.season < season - 1);
    const m0 = L.gbdt(design(early, names), early.map(yk), Object.assign({}, g, { loss, valid: { X: design(prev, names), y: prev.map(yk) } }));
    return L.gbdt(design(tr, names), tr.map(yk), Object.assign({}, g, { loss, trees: Math.max(20, m0.used), valid: null }));
  };
  out.gbdt_p = fitG(train, (r) => r.y.hw, 'logistic');
  out.gbdt_m = fitG(trM, (r) => r.y.reg_margin, 'squared');
  out.gbdt_t = fitG(trT, (r) => r.y.reg_total, 'squared');
  return out;
}
/** the ridge margin model's per-feature contributions (points), against the training mean */
function contributions(model, f) {
  return model.features.map((k, j) => ({ feature: k, value: value(f, k), contribution: model.ridge_m[j + 1] * (value(f, k) - model.mean[j]) }));
}
function applyLive(model, f) {
  const x = [1].concat(model.features.map((k) => value(f, k)));
  return { ridge_m: L.predictLinear(model.ridge_m, x), ridge_t: L.predictLinear(model.ridge_t, x), logit_p: L.predictLogistic(model.logit, x),
    gbdt_p: L.predictGbdt(model.gbdt_p, x), gbdt_m: L.predictGbdt(model.gbdt_m, x), gbdt_t: L.predictGbdt(model.gbdt_t, x) };
}

module.exports = { fitPredict, fitLive, applyLive, contributions, featureNames, GROUPS, TRACKS, DEFAULT_CFG, FIRST_TRAIN, value };
