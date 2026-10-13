# NFL collection and model contract

Family: football. Keep this league independently calibrated.

## Collect in this order

- P0: Play EPA, QB efficiency, pressure, availability, pace. Also event IDs, historical results, confirmed availability, timestamped quotes and settlement rules.
- P1: Routes, targets, personnel, special teams.
- P2: Tracking, assignments, separation.

This ordering is a build hypothesis, not measured feature importance. Use fold-specific ablation, calibration and stability to decide which variables help.

## Required tables

- `football/plays` — one snap including no-play flag (P0).
- `football/participation` — one player per snap (P1).
- `football/team_game` — one team game (P0).
- `football/player_game` — one player game (P1).
- `football/college_roster_context` — one college team season as-of version (P1).
- `shared/event_context` — one pre-event context version (P0).
- `shared/availability` — one player status report version (P0).
- `shared/market_quotes` — one bookmaker selection quote at one instant (P0).
- `shared/outcomes` — one settled selection version (P0).

## Feature definitions

| Feature | Priority | Formula |
|---|---|---|
| off_epa_per_play | P0 | sum(epa)/count(valid_scrimmage_plays) |
| def_epa_allowed_per_play | P0 | sum(opponent_epa)/count(opponent_valid_scrimmage_plays) |
| pass_epa_per_dropback | P0 | sum(epa on pass_attempt or sack)/dropbacks |
| rush_epa_per_attempt | P0 | sum(epa on designed rushes)/designed_rushes |
| success_rate | P0 | count(epa>0)/count(valid_plays) |
| pressure_rate | P0 | pressured_dropbacks/opponent_dropbacks |
| pressure_allowed_rate | P0 | pressured_own_dropbacks/own_dropbacks |
| sack_rate | P1 | sacks/opponent_dropbacks |
| cpoe | P0 | mean(cpoe over eligible passes) |
| explosive_pass_rate | P1 | passes_gaining_at_least_20_yards/pass_attempts |
| explosive_rush_rate | P1 | rushes_gaining_at_least_10_yards/designed_rushes |
| seconds_per_snap | P0 | sum(valid_drive_elapsed_seconds)/snaps |
| red_zone_td_rate | P1 | red_zone_touchdown_drives/red_zone_drives |
| third_down_conversion_rate | P2 | third_down_conversions/third_down_attempts |
| turnover_rate | P1 | turnovers/drives |
| target_share | P0 | player_targets/team_pass_targets |
| route_participation | P0 | routes/team_dropbacks |
| targets_per_route | P0 | targets/routes |
| carry_share | P0 | player_carries/team_designed_rushes |
| air_yards_share | P1 | player_air_yards/team_air_yards |
| yards_per_route | P1 | receiving_yards/routes |
| special_teams_epa_per_play | P1 | sum(st_epa)/st_plays |

## Validation and readiness

Require chronological folds, a separate untouched last period, benchmark comparisons, calibration by market and probability band, missingness diagnostics and clustered uncertainty. Keep independent projections separate from market-anchored models. Game moneyline validation does not validate player props. All post-event stats become predictors only for subsequent events; never for the event generating them.

See `COVERAGE.md` for actual shipped records. Specified fields are not promises that a source contains them. Unknown source availability timestamps prevent strict point-in-time certification.
