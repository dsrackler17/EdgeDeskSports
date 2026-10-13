# SOCCER collection and model contract

Family: soccer. Keep this league independently calibrated.

## Collect in this order

- P0: Nonpenalty xG for/against, lineup, goalkeeper, rest. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Set pieces, press/territory, shot quality.
- P2: Freeze frames, tracking, possession value.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `soccer/events` — one action (P0).
- `soccer/team_game` — one team match (P0).
- `soccer/player_game` — one player match (P1).
- `soccer/freeze_frames` — one tracked player at event (P2).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| npxg_per90 | P0 | 90*sum(nonpenalty_shot_xg)/minutes |
| npxga_per90 | P0 | 90*opponent_nonpenalty_xg/minutes |
| xg_per_shot | P0 | sum(xg)/shots |
| ppda | P1 | opponent_passes_in_defined_press_zone/defensive_actions_in_same_zone |
| field_tilt | P1 | own_final_third_passes/(own+opponent_final_third_passes) |
| set_piece_xg_per90 | P0 | 90*set_piece_xg/minutes |
| keeper_goals_prevented | P0 | post_shot_xg_against-goals_allowed |
| shot_on_target_rate | P1 | shots_on_target/shots |
| aerial_win_pct | P1 | aerial_duels_won/aerial_duels |
| progressive_actions_per90 | P1 | 90*(progressive_passes+progressive_carries)/minutes |
| red_card_rate | P1 | red_cards/matches |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
