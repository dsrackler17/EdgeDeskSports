/* ============================================================================
   THE ALTITUDE PROMOTION GATES — written down before the first fit.

   Declared 2026-10-17, in the same change that adds the research harness and
   before that harness was run against the line archive. The harness reads
   these thresholds; it does not choose them. Changing one later is a visible
   diff against this date, not a quiet re-run.

   WHY NOT ONLY football/validation/promote.js. That gate is applied to every
   game, and a pooled MAE improvement of 0.02 points across ALL games is out
   of reach for any feature that touches one game in twenty, however real its
   effect: a perfect 1.2-point correction on 4% of games moves pooled MAE by
   about 0.01. So the repository's own six conditions are applied to the games
   the adjustment actually touches (G1), and a separate no-harm condition
   protects every other game (G3). Every other gate is altitude-specific.

   SELECTION IS NESTED. The candidate that goes forward is chosen on the
   2014-2021 walk-forward only. 2022-2025 is the confirmation window: no
   candidate, penalty or threshold is chosen while looking at it.
   ========================================================================== */
'use strict';

const DECLARED = '2026-10-17';

const WINDOWS = {
  train_from: 2006,                /* first season with a usable closing line in the archive */
  select: [2014, 2021],            /* walk-forward seasons used to CHOOSE the candidate */
  confirm: [2022, 2025]            /* walk-forward seasons used only to CONFIRM it */
};

const GATES = [
  { id: 'G1_promotion_rules_on_affected_games',
    rule: 'football/validation/promote.js evaluate() on the confirmation-window games the adjustment touches: >= 2 holdout seasons, MAE improves >= 0.02, paired p < 0.05, no season worse by > 0.15, Brier no worse by > 0.002, leakage clean',
    why: 'the repository’s own promotion conditions, applied to the population the feature acts on' },
  { id: 'G2_confirmation_sample',
    rule: '>= 100 affected games in the confirmation window',
    min_games: 100,
    why: 'fewer games than this cannot distinguish a one-point effect from noise' },
  { id: 'G3_global_no_harm',
    rule: 'confirmation window, all non-neutral games: pooled MAE no worse by > 0.002 and Brier no worse by > 0.0005',
    max_mae_harm: 0.002, max_brier_harm: 0.0005,
    why: 'the games the adjustment does not touch must not pay for it' },
  { id: 'G4_permutation_placebo',
    rule: 'shuffling the altitude features among games of the same season produces an improvement as large as the real one in < 5% of shuffles (2014-2025 walk-forward)',
    p_max: 0.05,
    why: 'an effect a random assignment reproduces is not altitude' },
  { id: 'G5_descent_placebo',
    rule: 'the full-sample coefficient on a visitor playing >= 1,000 ft BELOW normal has a 95% CI that includes zero',
    why: 'physiology predicts no visitor penalty for descending; a "descent effect" means the specification is picking up something else (travel, region, schedule)' },
  { id: 'G6_venue_robustness',
    rule: 'dropping any single mountain host venue does not flip the sign of the main coefficient, and predicting each held-out mountain venue from the others improves pooled MAE on those games',
    why: 'an effect that lives in one stadium is that stadium, and the venue table was already rejected for exactly this reason' },
  { id: 'G7_coefficient_stability',
    rule: 'the main coefficient has the same sign in >= 80% of the walk-forward refits',
    min_share: 0.8,
    why: 'the V1 travel layer’s altitude slope reversed sign out of sample; this one must not' },
  { id: 'G8_data_coverage',
    rule: '>= 95% of non-neutral FBS games in the confirmation window have a usable altitude context',
    min_share: 0.95,
    why: 'an adjustment that silently drops games where an elevation is missing is graded on a filtered sample' }
];

/* MINIMUM SUPPORT FOR A FITTED TERM. Added on the same day as everything
   above, but AFTER a dry run of the harness: interaction cells such as
   "climbed 3,000+ ft AND lives at altitude" held a handful of games across
   two venues and produced coefficients of 13 points with a cluster-robust
   standard error that cannot be trusted at that cluster count. The rule can
   only REMOVE a term (its coefficient is held at zero and the term is reported
   as unsupported); it cannot make a candidate look better. */
const MIN_SUPPORT = { games: 30, clusters: 5,
  why: 'a term fitted on fewer than 30 games or fewer than 5 host venues is a handful of results, and its cluster-robust standard error is not reliable with that few clusters' };

const SUPPORT = {
  SUPPORTED: 'every gate passed: the adjustment improves out-of-sample predictions and may be enabled by a person',
  SUGGESTIVE: 'the historical coefficient points the expected way (p < 0.10), but the adjustment did not pass its out-of-sample gates',
  NOT_ESTABLISHED: 'the historical record does not separate the effect from noise'
};

module.exports = { DECLARED, WINDOWS, GATES, SUPPORT, MIN_SUPPORT };
