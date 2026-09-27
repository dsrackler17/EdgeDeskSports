# Feature coverage — the data-pack dictionary mapped to EdgeDesk sources

Every one of the 140 candidate fields in `edgedesk_feature_dictionary.csv` has a decision. Counts: AVAILABLE 20, DERIVABLE 90, NEW SOURCE REQUIRED 18, REJECTED 12.

Status meanings: **AVAILABLE** read directly from a reachable feed; **DERIVABLE** computed by V2 from available data; **NEW SOURCE REQUIRED** no reachable feed carries it point-in-time; **REJECTED** derivable but refused (drift, redundancy, instability or leakage). "Used" = enters a V2 model or overlay.

| feature | layer | priority | status | V2 column | source | used | note |
|---|---|---|---|---|---|---|---|
| game_id | context | P0 | AVAILABLE | game_id | espn/CFBD game id | yes |  |
| season | context | P0 | AVAILABLE | season | schedule | yes |  |
| week | context | P0 | AVAILABLE | week | schedule | yes |  |
| kickoff_ts | context | P0 | AVAILABLE | kickoff_ts | cfb_schedules start_date (UTC) | yes |  |
| home_team | context | P0 | AVAILABLE | home_id/home_team | schedule | yes |  |
| away_team | context | P0 | AVAILABLE | away_id/away_team | schedule | yes |  |
| neutral_site | pure | P0 | AVAILABLE | neutral_site | schedule | yes | feeds home_field |
| conference_game | pure | P2 | AVAILABLE | conference_game_f | schedule | yes | context family; ablation decides |
| prior_power_rating | pure | P0 | DERIVABLE | edge_prior_* (per-metric priors) + Elo carry-over | stage 3 priors | yes | V2 keeps per-unit priors rather than one power number |
| prior_off_rating | pure | P0 | DERIVABLE | [ha]_<metric>__prior_off | stage 3 priors | yes |  |
| prior_def_rating | pure | P0 | DERIVABLE | [ha]_<metric>__prior_def | stage 3 priors | yes |  |
| recent_program_history_3y | pure | P1 | DERIVABLE | prior model reads lag-1 and lag-2 data-only ratings | stage 3 | yes | two seasons, not three: the third lag added nothing in the prior fit |
| returning_production_off | pure | P0 | AVAILABLE | ret_off (prior input) | sportsdataverse cfb_returning_production | yes | season roster assumed ~ preseason roster; is_estimated rows kept |
| returning_production_def | pure | P0 | AVAILABLE | ret_def (prior input) | sportsdataverse cfb_returning_production | yes |  |
| returning_ol_snap_pct | pure | P1 | NEW SOURCE REQUIRED | — | — | no | no public college snap counts |
| returning_wrte_rec_yards_pct | pure | P1 | DERIVABLE | — | ESPN player box | no | derivable; deferred — covered by aggregate returning production |
| returning_qb_pass_yards_pct | pure | P1 | DERIVABLE | — | ESPN player box | no | deferred; in-season QB model + aggregate returning production |
| returning_def_snap_pct | pure | P1 | NEW SOURCE REQUIRED | — | — | no | no public college snap counts |
| talent_composite | pure | P2 | AVAILABLE | talent_z (prior input) | sportsdataverse cfb_team_talent (247 composite) | yes |  |
| transfer_value_net | pure | P1 | REJECTED | — | roster diffs | no | portal arrival dates are not point-in-time in any reachable feed |
| coaching_change_hc | pure | P1 | AVAILABLE | hc_new (prior input) | cfb_matchup_line hc_tenure (preseason incumbent), 2015+ | yes | missing before 2015 -> flag m_coach, never zero |
| coordinator_change_off | pure | P2 | AVAILABLE | unit_change (offence prior) | cfb_matchup_line oc_cont, 2015+ | yes |  |
| coordinator_change_def | pure | P2 | AVAILABLE | unit_change (defence prior) | cfb_matchup_line dc_cont, 2015+ | yes |  |
| offense_adj_epa_play | pure | P0 | DERIVABLE | [ha]_epa__off | stage 3 joint ridge | yes |  |
| offense_adj_pass_epa | pure | P0 | DERIVABLE | [ha]_epa_pass__off | stage 3 | yes | sacks included as dropbacks, every season |
| offense_adj_rush_epa | pure | P0 | DERIVABLE | [ha]_epa_rush__off | stage 3 | yes | scrambles are rushes in the feed, every season |
| offense_adj_success_rate | pure | P0 | DERIVABLE | [ha]_sr__off | stage 3 | yes |  |
| offense_adj_early_down_success | pure | P1 | DERIVABLE | [ha]_sr_early__off | stage 3 | yes |  |
| offense_adj_standard_down_success | pure | P1 | REJECTED | — | — | no | redundant with early-down and passing-down success |
| offense_adj_passing_down_success | pure | P1 | DERIVABLE | [ha]_sr_pd__off | stage 3 | yes |  |
| offense_adj_explosiveness | pure | P1 | DERIVABLE | [ha]_expl__off | stage 3 | yes | explosive-play RATE, not EPA on successful plays |
| offense_adj_pass_explosiveness | pure | P1 | DERIVABLE | [ha]_expl_pass__off | stage 3 | yes |  |
| offense_adj_rush_explosiveness | pure | P1 | DERIVABLE | [ha]_expl_rush__off | stage 3 | yes |  |
| defense_adj_epa_play | pure | P0 | DERIVABLE | [ha]_epa__def | stage 3 | yes | sign: + = defence allows more |
| defense_adj_pass_epa | pure | P0 | DERIVABLE | [ha]_epa_pass__def | stage 3 | yes |  |
| defense_adj_rush_epa | pure | P0 | DERIVABLE | [ha]_epa_rush__def | stage 3 | yes |  |
| defense_adj_success_rate | pure | P0 | DERIVABLE | [ha]_sr__def | stage 3 | yes |  |
| defense_adj_early_down_success | pure | P1 | DERIVABLE | [ha]_sr_early__def | stage 3 | yes |  |
| defense_adj_standard_down_success | pure | P1 | REJECTED | — | — | no | redundant (see offence) |
| defense_adj_passing_down_success | pure | P1 | DERIVABLE | [ha]_sr_pd__def | stage 3 | yes |  |
| defense_adj_explosiveness | pure | P1 | DERIVABLE | [ha]_expl__def | stage 3 | yes |  |
| defense_adj_pass_explosiveness | pure | P1 | DERIVABLE | [ha]_expl_pass__def | stage 3 | yes |  |
| defense_adj_rush_explosiveness | pure | P1 | DERIVABLE | [ha]_expl_rush__def | stage 3 | yes |  |
| off_adj_line_yards | pure | P1 | DERIVABLE | [ha]_line_yds__off | stage 1 own allocation from statYardage | yes | provider line_yards drifts across seasons; recomputed |
| def_adj_line_yards_allowed | pure | P1 | DERIVABLE | [ha]_line_yds__def | stage 1 | yes |  |
| off_adj_stuff_rate_allowed | pure | P1 | DERIVABLE | [ha]_stuff__off | stage 1 (rush statYardage <= 0) | yes | provider stuffed_run drifts |
| def_adj_stuff_rate | pure | P1 | DERIVABLE | [ha]_stuff__def | stage 1 | yes |  |
| off_second_level_yards | pure | P2 | REJECTED | — | — | no | provider column drifts; line-yard allocation already caps at 10 |
| def_second_level_yards_allowed | pure | P2 | REJECTED | — | — | no | as above |
| off_open_field_yards | pure | P2 | REJECTED | — | — | no | low stability; provider column drifts |
| def_open_field_yards_allowed | pure | P2 | REJECTED | — | — | no | as above |
| off_havoc_allowed | pure | P1 | DERIVABLE | [ha]_havoc__off (front havoc: sacks + run TFLs) | stage 1 | yes | classic havoc needs pass break-ups, whose tagging swings 4x between seasons |
| def_havoc_created | pure | P1 | DERIVABLE | [ha]_havoc__def | stage 1 | yes |  |
| off_front7_havoc_allowed | pure | P2 | REJECTED | — | — | no | attribution unavailable |
| def_front7_havoc_created | pure | P2 | REJECTED | — | — | no | attribution unavailable |
| off_db_havoc_allowed | pure | P2 | REJECTED | — | — | no | needs PBU/INT attribution; PBU tagging drifts |
| def_db_havoc_created | pure | P2 | REJECTED | — | — | no | as above |
| off_points_per_opportunity | pure | P1 | DERIVABLE | [ha]_pts_per_opp__off | stage 1 drives | yes | opportunity = drive reaching opp 40 |
| def_points_per_opportunity_allowed | pure | P1 | DERIVABLE | [ha]_pts_per_opp__def | stage 1 | yes |  |
| off_scoring_opportunity_rate | pure | P1 | DERIVABLE | [ha]_so_rate__off | stage 1 | yes |  |
| def_scoring_opportunity_rate_allowed | pure | P1 | DERIVABLE | [ha]_so_rate__def | stage 1 | yes |  |
| off_drive_epa | pure | P0 | DERIVABLE | [ha]_drive_epa__off | stage 1 | yes |  |
| def_drive_epa_allowed | pure | P0 | DERIVABLE | [ha]_drive_epa__def | stage 1 | yes |  |
| off_points_per_drive | pure | P1 | DERIVABLE | [ha]_ppd__off | stage 1 | yes | TD=7, FG=3, non-garbage drives |
| def_points_per_drive_allowed | pure | P1 | DERIVABLE | [ha]_ppd__def | stage 1 | yes |  |
| off_avg_start_field_position | pure | P1 | DERIVABLE | [ha]_start_fp__off | stage 1 | yes | yards to goal; higher = worse |
| def_avg_start_field_position_allowed | pure | P1 | DERIVABLE | [ha]_start_fp__def | stage 1 | yes |  |
| pace_seconds_per_play | pure | P1 | REJECTED | — | — | no | the provider clock stamp changes meaning by season (doc) |
| plays_per_game_neutral | pure | P2 | DERIVABLE | [ha]_plays_pg__off | stage 1 | yes | all scrimmage plays; not game-state neutralised |
| drives_per_game_neutral | pure | P1 | DERIVABLE | [ha]_drives_pg__off, exp_drives_* | stage 1 | yes |  |
| qb_status | pure | P0 | NEW SOURCE REQUIRED | engine input qb.status (live only) | football/enrichment (tier 5 only today) | no | no archived pregame status history exists; cannot be trained or backtested |
| qb_start_probability | pure | P0 | DERIVABLE | engine STATUS_START_PROB (declared, live only) | engine | no | declared mapping; calibration requires archived status reports |
| qb_adj_epa_dropback | pure | P0 | DERIVABLE | [ha]_qb_exp_rating | stage 4 | yes |  |
| qb_success_rate | pure | P1 | DERIVABLE | — | stage 4 | no | deferred; EPA/dropback carries it |
| qb_cpoe | pure | P2 | NEW SOURCE REQUIRED | — | — | no | no air-yards / expected-completion model in the feed |
| qb_sack_rate | pure | P1 | DERIVABLE | — | stage 4 | no | team sack-rate rating carries it |
| qb_rush_epa | pure | P1 | DERIVABLE | — | stage 4 | no | scrambles not separable from designed runs |
| qb_turnover_rate | pure | P2 | DERIVABLE | — | stage 4 | no | regresses almost fully to the mean |
| qb_experience_starts | pure | P1 | DERIVABLE | [ha]_qb_exp_starts, [ha]_qb_exp_db_log | stage 4 | yes |  |
| qb_starter_backup_delta | pure | P0 | DERIVABLE | [ha]_qb_drop | stage 4 | yes | backup = next passer by dropbacks, else replacement mean |
| availability_ol_value_lost | pure | P1 | NEW SOURCE REQUIRED | engine input (live), capped | football/availability | no | no archived pregame injury reports or snap counts |
| availability_skill_value_lost | pure | P1 | NEW SOURCE REQUIRED | engine input (live), capped | football/availability | no | as above |
| availability_front7_value_lost | pure | P1 | NEW SOURCE REQUIRED | engine input (live), capped | football/availability | no | as above |
| availability_secondary_value_lost | pure | P1 | NEW SOURCE REQUIRED | engine input (live), capped | football/availability | no | as above |
| availability_uncertainty | pure | P0 | DERIVABLE | engine sigma inflation (live) | engine | no | variance only, never the mean |
| st_epa_per_game | pure | P1 | DERIVABLE | [ha]_st_net__off/def, edge_st_net | stage 1+3 | yes | zero-sum net special-teams EPA |
| fg_value_over_expected | pure | P2 | DERIVABLE | [ha]_fg_value__off, edge_fg_value | stage 1+3 | yes | FG EPA = value vs EP expectation |
| punt_net_ep_value | pure | P2 | DERIVABLE | punt_net_epa (stage 1 only) | stage 1 | no | folded into st_net |
| return_ep_value | pure | P2 | DERIVABLE | kick_net_epa (stage 1 only) | stage 1 | no | folded into st_net |
| home_field_team_effect | pure | P1 | DERIVABLE | hfa_team_edge | walk-forward residuals | yes | home-minus-road residual, partial pooling |
| travel_distance_miles | pure | P2 | DERIVABLE | travel_miles_log | team_info geography | yes | ablation decides |
| timezone_shift_hours | pure | P2 | DERIVABLE | tz_shift | team_info timezone | yes | ablation decides |
| rest_days_diff | pure | P2 | DERIVABLE | rest_diff | schedule | yes | ablation decides |
| altitude_diff_ft | pure | P3 | DERIVABLE | altitude_kft | team_info elevation | yes | ablation decides |
| wind_mph | pure | P1 | NEW SOURCE REQUIRED | engine input weather.wind_mph (live, variance only) | — | no | no archived pregame FORECASTS reachable; observed weather would leak post-kickoff information |
| precip_prob | pure | P2 | NEW SOURCE REQUIRED | engine input (live, variance only) | — | no | as above |
| temperature_f | pure | P2 | NEW SOURCE REQUIRED | engine input (live, variance only) | — | no | as above |
| weather_forecast_age_minutes | pure | P2 | NEW SOURCE REQUIRED | engine input (live) | — | no | as above |
| team_strength_ewma | pure | P0 | DERIVABLE | [ha]_<metric>__off_rec/def_rec | stage 3 recent horizon | yes | half-life tuned |
| off_epa_ewma | pure | P1 | DERIVABLE | [ha]_epa__off_rec | stage 3 | yes |  |
| def_epa_ewma | pure | P1 | DERIVABLE | [ha]_epa__def_rec | stage 3 | yes |  |
| form_vs_season_delta | pure | P1 | DERIVABLE | form_<metric> | stage 5 | yes |  |
| team_volatility | pure | P0 | DERIVABLE | [ha]_<metric>__vol, vol_sum | stage 3 | yes |  |
| match_pass_edge | pure | P0 | DERIVABLE | match_pass_edge | stage 5 | yes |  |
| match_rush_edge | pure | P0 | DERIVABLE | match_rush_edge | stage 5 | yes |  |
| match_havoc_edge | pure | P1 | DERIVABLE | match_havoc_edge, match_sack_edge | stage 5 | yes |  |
| match_explosive_edge | pure | P1 | DERIVABLE | match_explosive_edge | stage 5 | yes |  |
| match_early_down_edge | pure | P1 | DERIVABLE | match_early_down_edge | stage 5 | yes |  |
| match_passing_down_edge | pure | P1 | DERIVABLE | match_passing_down_edge | stage 5 | yes |  |
| match_trench_edge | pure | P1 | DERIVABLE | match_trench_edge | stage 5 | yes |  |
| match_finishing_edge | pure | P1 | DERIVABLE | match_finishing_edge | stage 5 | yes |  |
| expected_possessions | pure | P0 | DERIVABLE | exp_drives_home, exp_drives_away | stage 5 | yes |  |
| sample_effective_plays | pure | P0 | DERIVABLE | [ha]_epa__n_eff_off | stage 3 | yes |  |
| sample_effective_drives | pure | P0 | DERIVABLE | [ha]_ppd__n_eff_off | stage 3 | yes |  |
| pbp_completeness | pure | P0 | DERIVABLE | report/data_quality.json | stage 1 vs schedule | no | a pipeline QA gate, not a model input |
| source_conflict_score | pure | P0 | NEW SOURCE REQUIRED | engine input (live) | football/enrichment | no | no historical source-conflict archive |
| ensemble_std_margin | pure | P0 | DERIVABLE | ens_sd | stage 7 | yes |  |
| prediction_sigma | pure | P0 | DERIVABLE | sigma | stage 7 | yes |  |
| football_confidence | pure | P0 | DERIVABLE | reliability | stage 7 | yes | NOT betting edge |
| open_spread | market | P0 | AVAILABLE | open_margin | cfbfastR multi-book archive 2012-2025 (none in 2020); CFBD mean 2026 | yes | converted to home-margin convention at ingestion |
| current_spread | market | P0 | NEW SOURCE REQUIRED | engine input market.current (live) | EdgeDesk capture (signals) | no | no historical intermediate snapshots; history has open and close only |
| close_spread | evaluation | P0 | AVAILABLE | close_margin (EVALUATION ONLY) | archive | yes | never a pregame feature |
| current_price_american | market | P0 | NEW SOURCE REQUIRED | engine input (live) | EdgeDesk capture | no | the archive carries lines, not spread prices; backtests state -110 |
| consensus_spread | market | P0 | AVAILABLE | open_margin / close_margin (median across books) | archive | yes |  |
| market_dispersion | market | P1 | NEW SOURCE REQUIRED | engine input (live) | EdgeDesk capture | no | history has cross-book SD at the CLOSE only; not usable pregame |
| line_move_from_open | market | P1 | DERIVABLE | line_move (evaluation), engine live | archive | no | evaluation only historically |
| pure_model_margin | market | P0 | DERIVABLE | ens_pred | stage 7 | yes |  |
| model_market_gap | market | P0 | DERIVABLE | gap_open | stage 8 | yes |  |
| cover_probability | market | P0 | DERIVABLE | pc_home_cal / p_side | stage 8 | yes | calibrated walk-forward |
| break_even_probability | market | P0 | DERIVABLE | engine breakEven(price) | stage 8 | yes |  |
| estimated_ev_per_unit | market | P0 | DERIVABLE | ev | stage 8 | yes |  |
| edge_reliability | market | P0 | DERIVABLE | reliability (+ gates) | stage 7/8 | yes |  |
| external_model_consensus | market | P2 | NEW SOURCE REQUIRED | — | Prediction Tracker | no | network policy blocks the host; ESPN FPI archive is end-of-season (leaks); CFBD pregame Elo is benchmarked alone |
| external_model_dispersion | market | P2 | NEW SOURCE REQUIRED | — | Prediction Tracker | no | as above |
| final_home_points | target | P0 | AVAILABLE | home_points (TARGET) | schedule | yes | target only |
| final_away_points | target | P0 | AVAILABLE | away_points (TARGET) | schedule | yes | target only |
| final_margin_home | target | P0 | AVAILABLE | margin (TARGET) | schedule | yes | target only |
| ats_result_current | target | P0 | DERIVABLE | bet_result (EVALUATION) | stage 8 | yes | evaluation only |
| clv_points | target | P0 | DERIVABLE | clv_pts (EVALUATION) | stage 8 | yes | evaluation only |
| prediction_abs_error | target | P0 | DERIVABLE | report | stage 9 | yes | evaluation only |
