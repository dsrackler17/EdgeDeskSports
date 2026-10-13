# MLB collection and model contract

Family: baseball. Keep this league independently calibrated.

## Collect in this order

- P0: Starter pitch quality, lineup handedness, bullpen availability, park/weather. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Pitch mix, plate discipline, contact quality, defense.
- P2: Fielding and pitch-sequence tracking.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `baseball/pitches` — one pitch or explicitly identified non-pitch event (P0).
- `baseball/batter_game` — one batter game (P0).
- `baseball/pitcher_game` — one pitcher game (P0).
- `baseball/bullpen_availability` — one pitcher before event (P0).
- `baseball/lineup` — one projected or confirmed batting-order slot (P0).
- `baseball/defense_running` — one player game or season split (P2).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| k_pct_batter | P0 | strikeouts/plate_appearances |
| bb_pct_batter | P0 | unintentional_walks/plate_appearances |
| k_pct_pitcher | P0 | strikeouts/batters_faced |
| bb_pct_pitcher | P0 | walks/batters_faced |
| k_minus_bb_pct | P0 | k_pct_pitcher-bb_pct_pitcher |
| whiff_rate | P0 | whiffs/swings |
| csw_rate | P1 | (called_strikes+whiffs)/pitches |
| chase_rate | P0 | swings_outside_zone/pitches_outside_zone |
| zone_contact_rate | P0 | contact_swings_in_zone/swings_in_zone |
| hard_hit_rate | P0 | batted_balls_with_exit_velocity_ge_95mph/batted_balls_with_ev |
| mean_exit_velocity | P0 | sum(exit_velocity)/measured_batted_balls |
| ground_ball_pct | P1 | ground_balls/classified_batted_balls |
| woba | P0 | sum(season_linear_weight*event_count)/season_woba_denominator |
| xwoba | P0 | sum(valid_provider_expected_woba)/eligible_PA |
| fip | P1 | (13*HR+3*(BB+HBP)-2*K)/innings+season_constant |
| hr_per_fly_ball | P1 | home_runs/fly_balls |
| innings_pitched | P0 | outs_recorded/3 |
| pitch_mix_share | P0 | pitch_type_count/all_pitches |
| platoon_woba | P0 | woba calculated within batter/pitcher hand split |
| bullpen_workload | P0 | sum(pitches_previous_3_days) |
| starter_velocity_delta | P0 | recent_mean_fastball_mph-minus_prior_season_mean |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
