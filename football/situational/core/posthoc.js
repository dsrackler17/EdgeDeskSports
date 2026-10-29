'use strict';
/* ============================================================================
   FSIE — post-hoc diagnostics, run only AFTER the one-look holdout.

   Nothing here is a promotion criterion, nothing here can change a verdict,
   and nothing here feeds a model choice. It exists to explain a holdout
   result, and every file it writes says so in its first field.

   intervalVariant(sport): the frozen harness's simulateRows() calls
   simulateGame() without a variant, so predictMean() fell back to its
   default rung, 'formation', when the walk-forward chose phi and when the
   holdout measured P10-P90 coverage. The preregistered primary variant is
   'pace_script' (the live pipeline passes it explicitly). This recomputes,
   with the same fit, seeds and draws, the coverage of both rungs on the
   validation folds and on the holdout season, so the recorded numbers can be
   reproduced and the primary variant's own numbers read beside them.
   The frozen files are not edited: the holdout file stays the record.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const VM = require(path.join(__dirname, 'volume_model.js'));
const EV = require(path.join(__dirname, 'evaluate.js'));
const R = require(path.join(__dirname, 'research.js'));

function simulate(params, rows, phi, draws, variant) {
  const byGame = {}; rows.forEach((r) => { (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  const out = [];
  Object.values(byGame).forEach((pair) => {
    if (pair.length !== 2) return;
    /* the frozen harness's seed, so the 'formation' column reproduces the record */
    const sim = VM.simulateGame(params, pair[0], pair[1], { phi, draws, seed: 'cov|' + pair[0].game_id, variant });
    [[pair[0], sim.a], [pair[1], sim.b]].forEach(([r, s]) => { if (r.labels) out.push({ r, s }); });
  });
  return out;
}
function cover(sims) {
  const o = {}; R.TARGETS.forEach((t) => { o[t] = EV.coverage(sims.map((x) => ({ y: x.r.labels[t], p10: x.s.p10[t], p90: x.s.p90[t] }))); });
  return o;
}

async function intervalVariant(sport, opts) {
  opts = opts || {};
  const dir = opts.research_dir || R.RESEARCH;
  const hfile = path.join(dir, 'holdout_' + sport + '.json');
  if (!fs.existsSync(hfile)) throw new Error('post-hoc refused: the holdout has not been evaluated');
  const fz = R.checkFrozen(); if (!fz.ok) throw new Error('post-hoc refused: ' + fz.why);
  const P = fz.prereg; const S = P.sports[sport]; const roles = S.seasons;
  const draws = opts.draws || 1000; const variants = ['formation', S.primary_variant];
  const recorded = U.readJson(hfile);

  /* validation folds: the phi grid, both rungs (the walk-forward's 600 draws) */
  const K = await R.shrinkK(sport, roles.shrinkage_estimation, opts);
  const panels = {};
  for (const s of roles.train.concat(roles.validation)) panels[s] = (await R.seasonPanel(sport, s, K, opts)).rows;
  const byPhi = {}; variants.forEach((v) => { byPhi[v] = {}; S.interval_phi_grid.forEach((phi) => { byPhi[v][phi] = []; }); });
  for (const v of roles.validation) {
    const trainRows = [].concat(...roles.train.concat(roles.validation).filter((s) => s < v).map((s) => panels[s])).filter((r) => r.labels);
    const params = VM.train(sport, trainRows, { lambda: S.ridge_lambda, trained_on: 'seasons < ' + v });
    const test = panels[v].filter((r) => r.labels);
    variants.forEach((vr) => S.interval_phi_grid.forEach((phi) => { byPhi[vr][phi].push(...simulate(params, test, phi, opts.fold_draws || 600, vr)); }));
  }
  const validation = {};
  variants.forEach((vr) => {
    validation[vr] = { by_phi: {} };
    let best = null, bestErr = Infinity;
    S.interval_phi_grid.forEach((phi) => {
      const c = cover(byPhi[vr][phi]); validation[vr].by_phi[phi] = c;
      const e = U.mean(R.TARGETS.map((t) => Math.abs(c[t].p10_p90 - 0.8)));
      if (e < bestErr - 1e-9) { bestErr = e; best = phi; }
    });
    validation[vr].phi_that_would_be_chosen = best;
  });

  /* the holdout season: the holdout's own fit and frozen phi, both rungs */
  const fit = await R.fitOn(sport, roles.train.concat(roles.validation), Object.assign({}, opts, { phi: S.frozen_choices.phi }));
  const test = (await R.seasonPanel(sport, roles.holdout, fit.K, opts)).rows.filter((r) => r.labels);
  const holdout = {};
  variants.forEach((vr) => {
    const sims = simulate(fit.params, test, S.frozen_choices.phi, draws, vr);
    /* how far the simulated median sits from the rung's own point prediction */
    const off = sims.map((x) => Math.abs(x.s.p50.plays - VM.predictMean(fit.params, x.r, vr).plays));
    holdout[vr] = { coverage: cover(sims), median_minus_point_plays_mae: U.round(U.mean(off), 3) };
  });
  const reproduces = R.TARGETS.every((t) => Math.abs(holdout.formation.coverage[t].p10_p90 - recorded.team.coverage[t].p10_p90) < 1e-9);
  const out = {
    status: 'POST-HOC DIAGNOSTIC — computed after the one-look holdout; not a promotion criterion; changes no verdict; informs no v1 choice',
    schema: 'edgedesk_fsie_posthoc_interval_variant_v1', sport, computed_at: opts.now || new Date().toISOString(),
    preregistration_sha256: P.content_sha256, code_sha256: fz.code.sha256,
    finding: 'research.js simulateRows() simulates without a variant, so predictMean() used its default rung "formation" for the walk-forward phi choice and the holdout P10-P90 coverage; the preregistered primary variant is "' + S.primary_variant + '". The live pipeline passes the primary variant explicitly and is not affected.',
    recorded_holdout_coverage: recorded.team.coverage,
    recorded_reproduced_by_the_formation_column: reproduces,
    frozen_phi: S.frozen_choices.phi,
    validation_folds: validation,
    holdout_season: { season: roles.holdout, n_team_games: test.length, by_variant: holdout },
    verdict_effect: 'none: the team verdict also fails on a criterion computed from ' + S.primary_variant + ' point predictions (' +
      recorded.criteria.team.filter((c) => !c.pass && c.id !== 'interval_coverage').map((c) => c.id).join(', ') + ')',
    next: 'the fix (pass the primary variant) is a code change to a frozen file; it belongs to a situational_v2 preregistration with a new untouched holdout, not to v1'
  };
  U.writeJson(path.join(dir, 'posthoc_interval_variant_' + sport + '.json'), out);
  return out;
}

module.exports = { intervalVariant };
