/* ============================================================================
   THE FEATURE PROMOTION GATE.

   THIS FILE IS THE ANSWER TO "CAN THIS NEW THING MOVE A LINE?" AND THE ANSWER
   IS NO UNTIL IT EARNS IT.

   New football data reaches research the moment it exists: it shows up on
   player cards, unit cards, confidence, warnings and explanations. What it may
   NOT do is change a projected number — not because new data is suspect, but
   because "we added a feature and the line moved" is indistinguishable from
   "we fitted the recent past" unless something adversarial stands in between.
   This is that something.

   SIX CONDITIONS, ALL OF WHICH MUST HOLD:

     0  There are at least TWO holdout seasons. Without this, condition 3 is
        vacuous — "no season was degraded" checked against the single season
        that produced the pooled result is not a test of anything. A feature
        measured on one holdout season is a measurement, not a validation, and
        it stays CANDIDATE however good the number looks.

     1  POOLED out-of-sample MAE improves.
     2  The improvement is statistically credible — a paired test over the
        per-game absolute errors at p < 0.05. With sixteen hundred games,
        condition 1 alone is met by a coin flip about half the time.
     3  No holdout season is materially degraded. A feature that wins overall
        by winning enormously in one season and losing in another is fitting a
        season, not football.
     4  Calibration does not get worse: the Brier score must not deteriorate
        beyond a small tolerance.
     5  The leakage tests pass. A feature that beats the market because it
        knows the result is not a feature.

   STATUSES
     RESEARCH_ONLY  visible everywhere, moves nothing. The default, and where
                    almost everything stays.
     CANDIDATE      passed some conditions, not all. Named, with which ones.
     VALIDATED      passed all five. May move a line by its fitted effect.
     REJECTED       measured and found to make things worse. Kept in the
                    registry on purpose: a feature that was tried and failed is
                    information, and deleting it invites trying it again.

   Runs in the browser (window.EDPromote) and in node.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPromote = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_feature_status_v1';
  var STATUSES = ['RESEARCH_ONLY', 'CANDIDATE', 'VALIDATED', 'REJECTED'];

  var RULES = {
    min_holdout_seasons: 2,
    min_holdout_basis: 'a single holdout season cannot show that a feature is football rather than that season. Until a second one exists the honest status is CANDIDATE, and a promising effect size does not change that.',
    p_max: 0.05,
    p_basis: 'a paired two-sided test over the per-game absolute errors of the two arms. Not a t-test on the pooled means — the games are the same games and pairing is what makes the comparison honest.',
    min_pooled_improvement: 0.02,
    min_pooled_basis: 'points of spread MAE. Below this the feature is not worth the complexity even if it is real, and at this sample size it is very unlikely to be real.',
    max_season_degradation: 0.15,
    season_basis: 'a feature may lose a holdout season slightly — football is noisy — but losing one by more than 0.15 points of MAE while winning overall is the signature of fitting a season rather than a sport.',
    max_brier_degradation: 0.002,
    brier_basis: 'a spread can improve while the win probabilities get worse. Both are checked, because a research page publishes both.',
    require_leakage_clean: true,
    leakage_basis: 'every arm is built from data that existed before kickoff, and the harness asserts it. An arm whose leakage test did not run is not eligible, however good it looks.'
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* Evaluate ONE arm against the baseline. `arm` carries the measured results;
     this function makes no measurements, it only applies the rules — so the
     rules can be read, tested and argued with in one place. */
  function evaluate(arm, baseline, opts) {
    opts = opts || {};
    var reasons = [], passed = [], failed = [];

    var seasonsSeen = (arm.per_season || []).filter(function (x) { return x && x.n > 0; }).length;
    if (seasonsSeen >= RULES.min_holdout_seasons) passed.push('holdout_breadth');
    else {
      failed.push('holdout_breadth');
      reasons.push('only ' + seasonsSeen + ' holdout season' + (seasonsSeen === 1 ? '' : 's')
        + ' — ' + RULES.min_holdout_seasons + ' are required before a feature can be validated, because one season cannot distinguish football from that season');
    }

    var pooled = (isNum(baseline.spread_mae) && isNum(arm.spread_mae))
      ? baseline.spread_mae - arm.spread_mae : null;
    if (pooled == null) { failed.push('pooled_improvement'); reasons.push('no pooled MAE for one of the arms'); }
    else if (pooled >= RULES.min_pooled_improvement) { passed.push('pooled_improvement'); }
    else {
      failed.push('pooled_improvement');
      reasons.push('pooled MAE ' + (pooled >= 0 ? 'improved by only ' : 'got worse by ') + Math.abs(pooled).toFixed(3)
        + ' points, against a ' + RULES.min_pooled_improvement + ' bar');
    }

    var p = arm.paired && isNum(arm.paired.p) ? arm.paired.p : null;
    if (p == null) { failed.push('significance'); reasons.push('no paired test was run'); }
    else if (p < RULES.p_max) passed.push('significance');
    else { failed.push('significance'); reasons.push('paired p = ' + p.toFixed(3) + ', above the ' + RULES.p_max + ' bar'); }

    var worst = null, worstSeason = null;
    var per = arm.per_season || [];
    for (var i = 0; i < per.length; i++) {
      if (!isNum(per[i].mae_before) || !isNum(per[i].mae_after)) continue;
      var d = per[i].mae_after - per[i].mae_before;      /* + = worse */
      if (worst == null || d > worst) { worst = d; worstSeason = per[i].season; }
    }
    if (worst == null) { failed.push('season_stability'); reasons.push('no per-season results'); }
    else if (worst <= RULES.max_season_degradation) passed.push('season_stability');
    else {
      failed.push('season_stability');
      reasons.push('degrades ' + worstSeason + ' by ' + worst.toFixed(3) + ' points, beyond the ' + RULES.max_season_degradation + ' bar');
    }

    var brierDelta = (isNum(baseline.brier) && isNum(arm.brier)) ? arm.brier - baseline.brier : null;
    if (brierDelta == null) { failed.push('calibration'); reasons.push('no Brier score for one of the arms'); }
    else if (brierDelta <= RULES.max_brier_degradation) passed.push('calibration');
    else { failed.push('calibration'); reasons.push('Brier worsens by ' + brierDelta.toFixed(4)); }

    if (!RULES.require_leakage_clean) passed.push('leakage');
    else if (arm.leakage_clean === true) passed.push('leakage');
    else { failed.push('leakage'); reasons.push(arm.leakage_clean === false ? 'a leakage test FAILED' : 'the leakage test did not run'); }

    var status;
    if (failed.length === 0) status = 'VALIDATED';
    else if (failed.length === 1 && failed[0] === 'holdout_breadth') status = 'CANDIDATE';
    else if (pooled != null && pooled < 0 && failed.indexOf('pooled_improvement') >= 0) status = 'REJECTED';
    else if (passed.length >= 3) status = 'CANDIDATE';
    else status = 'RESEARCH_ONLY';

    return {
      feature: arm.feature, status: status,
      may_move_lines: status === 'VALIDATED',
      effect_size: pooled == null ? null : Math.round(pooled * 10000) / 10000,
      effect_units: 'points of spread MAE improvement on the holdout',
      p_value: p, brier_delta: brierDelta == null ? null : Math.round(brierDelta * 100000) / 100000,
      worst_season: worstSeason, worst_season_delta: worst == null ? null : Math.round(worst * 10000) / 10000,
      conditions_passed: passed, conditions_failed: failed,
      reasons: reasons,
      holdout_results: { baseline: baseline, arm: arm },
      fitted_coefficient: isNum(arm.coefficient) ? arm.coefficient : null,
      date_validated: status === 'VALIDATED' ? (opts.now || new Date().toISOString()) : null,
      version: arm.version || null,
      rules: RULES
    };
  }

  /* The registry. Every feature this system has ever measured, including the
     ones that failed — a feature that was tried and rejected is information,
     and deleting it invites trying it again next year. */
  function registry(entries, opts) {
    opts = opts || {};
    var byStatus = { RESEARCH_ONLY: [], CANDIDATE: [], VALIDATED: [], REJECTED: [] };
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      (byStatus[e.status] || byStatus.RESEARCH_ONLY).push(e.feature);
    }
    return {
      schema: SCHEMA,
      generated_at: opts.now || new Date().toISOString(),
      rules: RULES, statuses: STATUSES,
      tune_seasons: opts.tune || null, holdout_seasons: opts.holdout || null,
      games_scored: opts.games || null,
      summary: byStatus,
      validated_count: byStatus.VALIDATED.length,
      features: entries,
      statement: byStatus.VALIDATED.length
        ? byStatus.VALIDATED.length + ' feature(s) cleared every promotion condition and may move a projected line by their fitted effect. Everything else is research and moves nothing.'
        : 'NO feature has cleared every promotion condition. Every enrichment in this repository is research: it changes confidence, warnings, explanations and what is shown, and it changes no projected number anywhere.',
      how_to_read: 'RESEARCH_ONLY is the default and is not a failure — it is the honest state of a football feature that has not yet proved itself out of sample. REJECTED means measured and found harmful. VALIDATED means it earned the right to move a number.'
    };
  }

  /* What a consumer asks before applying a feature's points. Defaults to NO. */
  function mayMove(featureName, registryDoc) {
    if (!registryDoc || !registryDoc.features) {
      return { allowed: false, reason: 'no feature registry is loaded, so nothing is allowed to move a line' };
    }
    for (var i = 0; i < registryDoc.features.length; i++) {
      var f = registryDoc.features[i];
      if (f.feature !== featureName) continue;
      return { allowed: f.status === 'VALIDATED', status: f.status,
        coefficient: f.status === 'VALIDATED' ? f.fitted_coefficient : null,
        reason: f.status === 'VALIDATED'
          ? 'cleared every promotion condition on ' + f.date_validated
          : 'status ' + f.status + ' — ' + (f.reasons.join('; ') || 'not validated') };
    }
    return { allowed: false, reason: 'feature "' + featureName + '" is not in the registry, and an unknown feature moves nothing' };
  }

  return { SCHEMA: SCHEMA, STATUSES: STATUSES, RULES: RULES,
    evaluate: evaluate, registry: registry, mayMove: mayMove };
});
