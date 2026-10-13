# UFC collection and model contract

Family: mma. Keep this league independently calibrated.

## Collect in this order

- P0: Opponent-adjusted striking/grappling, age, layoff, rounds. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Round/location splits, control, weight/camp changes.
- P2: Judging and detailed exchange charting.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `mma/bouts` — one bout (P0).
- `mma/fighter_round` — one fighter round (P0).
- `mma/fighter_context` — one fighter before bout (P1).
- `mma/judging` — one judge score per round (P2).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| sig_strikes_landed_per_min | P0 | significant_strikes_landed/active_minutes |
| sig_strikes_absorbed_per_min | P0 | opponent_sig_strikes_landed/active_minutes |
| sig_strike_accuracy | P0 | sig_landed/sig_attempted |
| sig_strike_defense | P0 | 1-opponent_sig_landed/opponent_sig_attempted |
| takedowns_per15 | P0 | 15*takedowns_landed/active_minutes |
| takedown_accuracy | P0 | takedowns_landed/takedowns_attempted |
| takedown_defense | P0 | 1-opponent_takedowns_landed/opponent_takedowns_attempted |
| control_share | P0 | control_seconds/active_seconds |
| submission_attempts_per15 | P1 | 15*submission_attempts/active_minutes |
| knockdowns_per15 | P1 | 15*knockdowns/active_minutes |
| distance_strike_share | P1 | distance_attempted/significant_strikes_attempted |
| round_pace_decay | P1 | slope of sig_attempts_per_min over round number |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
