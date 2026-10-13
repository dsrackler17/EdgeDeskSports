# EdgeDesk NHL Data Pack — 2024–25 club research data

This is an NHL-only package, expanded beyond the original 72-game sample. Begin with `CLAUDE_NHL_START_HERE.md`, `COVERAGE.json` and `docs/MISSING_DATA_PRIORITY.csv`.

## Real data included

- 1,398 completed NHL club games: regular-season and playoff types shown in COVERAGE.json.
- 448,177 native play events and 167,569 extracted shot attempts.
- 53,259 deduplicated player/game box records and 2,953 goalie/game records.

- Game results, venue labels, attendance and available official/referee fields.
- Native team and player box measures, TOI parsed to seconds, shot participants/coordinates, strength labels and shot-type extraction from event descriptions.
- Measured team shot share and goalie save metrics; prior-5/10/20-game shot-share, goals and workload features with target-event exclusion.
- NHL/shared canonical JSON Schemas, formulas, source manifest, field missingness inventory and an exact prioritized list of remaining inputs.

## Files and grain

| File | Rows | Columns |
|---|---:|---:|
| `data/events.csv` | 448,177 | 21 |
| `data/games.csv` | 1,398 | 24 |
| `data/goalie_game_boxscores.csv` | 2,953 | 20 |
| `data/goalie_game_measured_features.csv` | 2,953 | 15 |
| `data/officials.csv` | 5,722 | 4 |
| `data/player_game_boxscores.csv` | 53,259 | 41 |
| `data/pregame_lagged_research_features.csv` | 2,796 | 59 |
| `data/schedule_all_statuses.csv` | 1,514 | 11 |
| `data/shot_attempts.csv` | 167,569 | 41 |
| `data/team_game_boxscores.csv` | 2,796 | 19 |
| `data/team_game_measured_features.csv` | 2,796 | 41 |

## Critical interpretation rules

This archive is historical, not live. It is not a trained/validated betting model. The 2024–25 regular-season count is reconciled to the expected 1,312 club games where delivered; playoff and failed-response counts are shown separately. A feed query alone does not prove complete coverage of every statistic. National-team Four Nations events are excluded from the completed club dataset; schedule_all_statuses.csv retains the broader source schedule for auditing.

On blocked shots the native event team can be the defending team. Use `shooting_team_id` resolved from shooter IDs, with `shooting_team_mapping_method` and nulls kept explicitly. Never sum all native team IDs into Corsi without checking this mapping. Multiple assister roles are preserved in participant_role_rows_json; the legacy by-role object alone may collapse repeated roles.

`strength_state` is a native source label. Even Strength is not necessarily 5v5: it can include 4v4 and 3v3. No exact 5v5 claim is made without shift/on-ice counts. Power-play labels and player special-teams TOI do not establish a full manpower timeline. Native shot description keywords produce engineered shot-type labels, not verified structured tracking. Native coordinates remain unverified in physical units and direction; do not silently assume feet or a goal-side transformation.

Regular-season shootout-candidate events are flagged by period >4; playoff overtime is not flagged as shootout. Native final scores can include an awarded shootout goal. Regulation goal targets and nonshootout event counts are provided separately. Missing goalie assignment does not imply an empty net.

Box values preserve provider strings. Read sources/NATIVE_STAT_DEFINITIONS.csv: in these native player boxes SOG means shootout goals, not shots on goal. Do not interpret an abbreviation from another provider’s convention. TOI and special-teams TOI have explicitly parsed seconds. Ratio features pool measured counts; missing values are not zero. Player YTD fields can be retrospective snapshots and must not enter a prediction for the generating game. Missing source timestamps stay blank. Measured features are post-game; lagged features exclude the target game but remain retrospective because first-publication and revision times are unknown.

`hours_between_scheduled_starts` is exactly that, not actual recovery time or verified travel. Event-time player injury, goalie confirmation, lineup, minute projection, xG/GSAx, full shifts, exact strength exposures, tracking and timestamped executable odds are still gaps. Do not invent them. One season supports exploration and feature integration, not robust 2026 live calibration.

## Claude integration and refresh

Load facts and source lineage first. Read the P0 acquisition list, complete missing inputs with authorized sources, train/calibrate chronologically and then attach fresh prices under the existing EdgeDesk budget. Separate independent research from market-verified EV and PASS when evidence/price is insufficient.

The collector uses bounded public requests, explicit caching and normal access; it does not call paid feeds or bypass blocks. Its 2024–25 scope is fixed. Raw responses are cached locally for reproducibility but omitted from this ZIP to keep the upload small; digests and normalized facts are included. On a fresh machine, running the collector makes public requests again. Dependencies: Python standard library only.

```bash
python scripts/build_features.py
python scripts/verify_and_package.py
```

Source facts: ESPN; public commercial/API redistribution rights are not certified. Native NHL endpoints were blocked. No MoneyPuck data is included; its commercial-use permission is not assumed. See sources/ACCESS_AND_RIGHTS.md.
