#!/usr/bin/env node
'use strict';

/* Final promotion decision for the NFL Coaching / Staff experiment.
   The Python replay measures. This file applies the repository's ONE shared
   feature-promotion gate, so NFL coaching does not get a friendlier standard
   merely because somebody wants the feature to work. */

const fs = require('fs');
const path = require('path');
const PROMOTE = require('../validation/promote.js');

function isNum(x) { return typeof x === 'number' && isFinite(x); }

function decide(experiment, opts) {
  opts = opts || {};
  const tune = experiment && experiment.tune && experiment.tune.selection;
  const baseline = experiment && experiment.holdout && experiment.holdout.baseline;
  const arms = experiment && experiment.holdout && experiment.holdout.arms || [];

  if (!tune || !(tune.cap > 0) || !isNum(tune.k)) {
    return {
      schema: 'edgedesk_nfl_coaching_staff_validation_v1',
      sport: 'americanfootball_nfl',
      status: 'RESEARCH_ONLY',
      affects_projection: false,
      selected_cap: 0,
      selected_reliability_k: tune && isNum(tune.k) ? tune.k : null,
      tune_selection: tune || null,
      verdict: null,
      reason: tune && tune.reason
        ? tune.reason
        : 'the tune window did not select a non-zero Coaching / Staff arm',
      experiment
    };
  }

  const arm = arms.find(a => Number(a.cap) === Number(tune.cap)
    && Number(a.k) === Number(tune.k));
  if (!arm || !baseline) {
    return {
      schema: 'edgedesk_nfl_coaching_staff_validation_v1',
      sport: 'americanfootball_nfl',
      status: 'RESEARCH_ONLY',
      affects_projection: false,
      selected_cap: 0,
      selected_reliability_k: tune.k,
      tune_selection: tune,
      verdict: null,
      reason: 'the frozen tune-selected arm is missing from the holdout experiment',
      experiment
    };
  }

  const verdict = PROMOTE.evaluate(arm, baseline, { now: opts.now });
  const rmseOk = isNum(arm.rmse) && isNum(baseline.rmse)
    && arm.rmse <= baseline.rmse + 0.01;
  const residualOk = arm.predictive_residual
    && isNum(arm.predictive_residual.slope)
    && arm.predictive_residual.slope > 0;
  const validated = verdict.status === 'VALIDATED' && rmseOk && residualOk;

  return {
    schema: 'edgedesk_nfl_coaching_staff_validation_v1',
    sport: 'americanfootball_nfl',
    status: validated ? 'VALIDATED' : verdict.status,
    affects_projection: validated,
    selected_cap: validated ? tune.cap : 0,
    selected_reliability_k: tune.k,
    tuned_cap: tune.cap,
    tune_selection: tune,
    verdict,
    extra_guards: {
      rmse_not_worse_by_more_than_0_01: rmseOk,
      positive_predictive_residual_direction: residualOk
    },
    reason: validated
      ? 'the NFL-specific Coaching / Staff arm was selected on 2003-2015 only, then cleared every 2016-2025 promotion condition'
      : 'the frozen tune-selected arm did not clear every NFL holdout promotion condition; Coaching / Staff remains research-only',
    experiment
  };
}

function main() {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf('--in');
  const outIdx = args.indexOf('--out');
  if (inIdx < 0 || !args[inIdx + 1] || outIdx < 0 || !args[outIdx + 1]) {
    console.error('usage: node football/nfl/validate_coaching_staff.js --in EXPERIMENT.json --out VALIDATION.json');
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(args[inIdx + 1], 'utf8'));
  const doc = decide(input);
  fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
  fs.writeFileSync(args[outIdx + 1], JSON.stringify(doc, null, 1) + '\n');
  console.log(JSON.stringify({
    status: doc.status,
    affects_projection: doc.affects_projection,
    selected_cap: doc.selected_cap,
    selected_reliability_k: doc.selected_reliability_k,
    reason: doc.reason
  }, null, 2));
}

module.exports = { decide };
if (require.main === module) main();
