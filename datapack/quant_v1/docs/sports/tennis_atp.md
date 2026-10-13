# TENNIS_ATP collection and model contract

Family: tennis. Keep this league independently calibrated.

## Collect in this order

- P0: Surface-adjusted serve/return, format, fitness. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Point-by-point, opponent strength, fatigue.
- P2: Serve placement and shot tracking.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `tennis/matches` — one singles or doubles match (P0).
- `tennis/points` — one point (P0).
- `tennis/player_context` — one player at prediction time (P1).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| serve_points_won_pct | P0 | (first_serve_points_won+second_serve_points_won)/service_points |
| return_points_won_pct | P0 | (opponent_service_points-opponent_serve_points_won)/opponent_service_points |
| first_serve_in_pct | P0 | first_serves_in/service_points |
| first_serve_win_pct | P0 | first_serve_points_won/first_serves_in |
| second_serve_win_pct | P0 | second_serve_points_won/(service_points-first_serves_in) |
| ace_rate | P1 | aces/service_points |
| double_fault_rate | P1 | double_faults/(service_points-first_serves_in) |
| hold_pct | P0 | service_games_won/service_games |
| break_pct | P0 | return_games_won/return_games |
| break_point_save_pct | P2 | break_points_saved/break_points_faced |
| surface_elo | P0 | R_new=R_old+K*(outcome-1/(1+10^((R_opp-R_old)/400))) |
| recent_court_load | P0 | sum(duration_seconds over prior 7 days) |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
