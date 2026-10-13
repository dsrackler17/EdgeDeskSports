# CBB_WOMEN collection and model contract

Family: basketball. Keep this league independently calibrated.

## Collect in this order

- P0: Opponent-adjusted efficiency, pace, starters, neutral venues. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Shot profile, rotation continuity.
- P2: Lineup/tracking if reliable.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `basketball/plays` — one event in ordered play-by-play (P0).
- `basketball/player_game` — one player game (P0).
- `basketball/team_game` — one team game (P0).
- `basketball/lineup_stints` — one uninterrupted five-player lineup interval (P1).
- `basketball/tracking` — one player game tracking split (P2).
- `basketball/college_context` — one team season as-of version (P1).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| off_rating | P0 | 100*points/possessions |
| def_rating | P0 | 100*opponent_points/opponent_possessions |
| net_rating | P0 | off_rating-def_rating |
| efg_pct | P0 | (fgm+0.5*three_pm)/fga |
| turnover_pct | P0 | turnovers/possessions |
| off_rebound_pct | P0 | off_reb/(off_reb+opponent_def_reb) |
| def_rebound_pct | P0 | def_reb/(def_reb+opponent_off_reb) |
| free_throw_rate | P0 | fta/fga |
| three_point_attempt_rate | P0 | three_pa/fga |
| true_shooting_pct | P1 | points/(2*(fga+c_fta*fta)) |
| pace | P0 | regulation_minutes*possessions/game_minutes |
| usage_proxy | P0 | player_(fga+c_fta*fta+turnovers)/team_(fga+c_fta*fta+turnovers) |
| minutes_share | P0 | player_minutes/(5*game_minutes) |
| assist_per_possession | P1 | assists/possessions_on_court |
| rebound_chance_conversion | P1 | rebounds/rebound_chances |
| potential_assist_conversion | P1 | assists/potential_assists |
| lineup_net_rating | P0 | 100*(stint_points_for-stint_points_against)/stint_possessions |
| rim_attempt_share | P1 | rim_attempts/fga |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
