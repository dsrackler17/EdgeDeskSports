# NHL collection and model contract

Family: hockey. Keep this league independently calibrated.

## Collect in this order

- P0: 5v5 chance creation/prevention, goalies, PP/PK, lineups. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Shot geometry, rebounds/rushes, shifts, special teams exposure.
- P2: Entries/exits, puck movement, tracking.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `hockey/shots` — one attempted shot (P0).
- `hockey/shifts` — one player shift (P0).
- `hockey/skater_game` — one skater game and strength state (P1).
- `hockey/goalie_game` — one goalie game and strength state (P0).
- `hockey/tracking` — one tracked possession or action (P2).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| xgf_per60 | P0 | 60*sum(shot_xg_for)/sum(toi_minutes) |
| xga_per60 | P0 | 60*sum(shot_xg_against)/sum(toi_minutes) |
| xg_share | P0 | xgf/(xgf+xga) |
| corsi_share | P1 | attempts_for/(attempts_for+attempts_against) |
| fenwick_share | P1 | unblocked_for/(unblocked_for+unblocked_against) |
| shots_for_per60 | P0 | 60*shots_on_goal_for/toi_minutes |
| shots_against_per60 | P0 | 60*shots_on_goal_against/toi_minutes |
| gsax_per60 | P0 | 60*(expected_goals_against-goals_allowed)/goalie_toi_minutes |
| save_pct | P0 | saves/shots_faced |
| shooting_pct | P1 | goals/shots_on_goal |
| pp_xg_per60 | P0 | 60*pp_xgf/pp_toi_minutes |
| pk_xga_per60 | P0 | 60*pk_xga/pk_toi_minutes |
| penalties_taken_per60 | P1 | 60*noncoincidental_penalties_taken/toi_minutes |
| faceoff_win_pct | P2 | faceoffs_won/(faceoffs_won+faceoffs_lost) |
| rebound_shot_share | P1 | rebound_attempts/unblocked_attempts |
| rush_shot_share | P1 | rush_attempts/unblocked_attempts |
| empty_net_goal_rate | P1 | empty_net_goals/empty_net_toi_minutes |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
