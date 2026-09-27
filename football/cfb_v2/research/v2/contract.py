"""The feature contract: layers, the coverage map of the data-pack dictionary, the data dictionary.

LAYERS
  context     identifiers and row metadata (never a model input except the
              explicit flags whitelisted in CONTEXT_FEATURES)
  pure        football-only information frozen at prediction_ts
  market      sportsbook / external-model information (market layer only)
  evaluation  post-prediction benchmarks (closing line, CLV)
  target      outcomes

`assert_pure(cols)` is called by every training entry point. It raises on any
column that is market, evaluation, target, or UNKNOWN — an unregistered column
cannot sneak into a model by being new.
"""
import csv
import os
import re

import pandas as pd

from . import config as C

HERE = os.path.dirname(os.path.abspath(__file__))
DICT_CSV = os.path.join(HERE, '..', 'contract', 'edgedesk_feature_dictionary.csv')

TARGET_COLS = {'home_points', 'away_points', 'margin', 'total_pts', 'home_winner', 'away_winner'}
EVALUATION_COLS = {'close_margin', 'total_close', 'clv_pts', 'bet_result', 'bet_units', 'line_move',
                   'gap_close', 'spread_close', 'spread_close_pin', 'spread_close_sd', 'has_close',
                   'market_dispersion', 'eval_open_close_flip', 'eval_open_close_jump'}
MARKET_COLS = {'open_margin', 'total_open', 'spread_open', 'spread_open_pin', 'spread_books', 'has_open',
               'source', 'line', 'gap_open', 'pc_home_raw', 'pc_home_cal', 'p_side', 'ev', 'push_p',
               'clv_exp', 'pred_ma', 'ma_weight_model', 'side', 'status_research', 'current_margin',
               'current_price', 'book_count', 'dispersion_open', 'external_consensus'}
CONTEXT_COLS = {'game_id', 'season', 'week', 'season_type', 'start_date', 'completed', 'kickoff_ts',
                'prediction_ts', 'feature_ts', 'feature_version', 'venue_id', 'venue', 'home_id',
                'home_team', 'home_division', 'home_conference', 'away_id', 'away_team',
                'away_division', 'away_conference', 'notes', 'status', 'home_rest', 'away_rest',
                'home_fbs', 'away_fbs', 'fcs_game', 'is_postseason', 'neutral_site', 'conference_game',
                'h_qb_id', 'a_qb_id'}
# context columns that ARE legitimate pure inputs (knowable from the schedule)
CONTEXT_FEATURES = {'neutral_site', 'conference_game', 'is_postseason', 'fcs_game'}

# The PURE allowlist is EXACT, generated from the metric registry, never a
# prefix pattern. Candidate 001 used prefixes ('^edge_', '^qb_', ...), so a new
# column named 'edge_closing_line' or 'qb_status_final' would have been
# classified pure by its name alone (red-team finding; tests_leakage probes it).
_METRIC_NAMES = ([m[0] for m in C.METRICS] + [m[0] for m in C.PACE_METRICS] + [m[0] for m in C.ST_METRICS])
_M = '(' + '|'.join(sorted(_METRIC_NAMES, key=len, reverse=True)) + ')'
_SIDE = '(off|def|off_var|def_var|off_rec|def_rec|prior_off|prior_def|l4_off|l4_def|l2_off|l2_def|vol|' \
        'n_obs_off|n_obs_def|n_eff_off)'
_QB = '(missing|delta|drop|changed|unsettled|backup_rating|exp_rating|exp_starts|exp_db_log|team_rating)'
PURE_PATTERNS = [
    r'^[ha]_%s__%s$' % (_M, _SIDE), r'^lg_%s__(mu|h)$' % _M,
    r'^edge_(rec_|prior_)?%s$' % _M, r'^form_%s$' % _M, r'^[ha]_qb_%s$' % _QB,
]
PURE_NAMES = {
    'match_pass_edge', 'match_rush_edge', 'match_mix_edge', 'match_trench_edge', 'match_havoc_edge',
    'match_sack_edge', 'match_explosive_edge', 'match_early_down_edge', 'match_passing_down_edge',
    'match_finishing_edge', 'match_field_pos_edge', 'match_st_edge',
    'x_pass_h', 'x_pass_a', 'x_rush_h', 'x_rush_a', 'x_sack_h', 'x_sack_a',
    'exp_plays_total', 'exp_drives_home', 'exp_drives_away', 'drive_pts_home', 'drive_pts_away',
    'drive_margin_raw', 'drive_total_raw', 'eff_pts_raw', 'l4_edge_epa', 'l2_edge_epa',
    'qb_delta_edge', 'qb_exp_edge', 'qb_missing_any', 'qb_unsettled_any', 'elo_home', 'elo_away', 'elo_diff',
    'rest_diff', 'travel_miles', 'travel_miles_log', 'tz_shift', 'altitude_diff_ft', 'altitude_kft',
    'home_field', 'home_games', 'away_games', 'min_games', 'rating_sd_sum', 'weeks_in', 'early_season',
    'vol_sum', 'to_dependence', 'conference_game_f', 'is_postseason_f', 'inv_games', 'fcs_game_f',
    'pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm', 'pred_E_drive', 'pred_total',
    'ens_pred', 'ens_sd', 'ens_range', 'ens_equal', 'sigma', 'abs_pred', 'exp_total_z', 'reliability',
}


def layer_of(col):
    if col in TARGET_COLS:
        return 'target'
    if col in EVALUATION_COLS:
        return 'evaluation'
    if col in MARKET_COLS:
        return 'market'
    if col in CONTEXT_FEATURES:
        return 'pure'
    if col in CONTEXT_COLS:
        return 'context'
    if col in PURE_NAMES:
        return 'pure'
    for p in PURE_PATTERNS:
        if re.match(p, col):
            return 'pure'
    return 'unknown'


class LayerViolation(AssertionError):
    pass


def assert_pure(cols):
    bad = {c: layer_of(c) for c in cols if layer_of(c) != 'pure'}
    if bad:
        raise LayerViolation('non-pure columns offered to a pure model: %s' % bad)
    return True


# --------------------------------------------------------------- coverage
A, D, N, R = 'AVAILABLE', 'DERIVABLE', 'NEW SOURCE REQUIRED', 'REJECTED'
COVERAGE = {
    'game_id': (A, 'game_id', 'espn/CFBD game id', True, ''),
    'season': (A, 'season', 'schedule', True, ''),
    'week': (A, 'week', 'schedule', True, ''),
    'kickoff_ts': (A, 'kickoff_ts', 'cfb_schedules start_date (UTC)', True, ''),
    'home_team': (A, 'home_id/home_team', 'schedule', True, ''),
    'away_team': (A, 'away_id/away_team', 'schedule', True, ''),
    'neutral_site': (A, 'neutral_site', 'schedule', True, 'feeds home_field'),
    'conference_game': (A, 'conference_game_f', 'schedule', True, 'context family; ablation decides'),
    'prior_power_rating': (D, 'edge_prior_* (per-metric priors) + Elo carry-over', 'stage 3 priors', True,
                           'V2 keeps per-unit priors rather than one power number'),
    'prior_off_rating': (D, '[ha]_<metric>__prior_off', 'stage 3 priors', True, ''),
    'prior_def_rating': (D, '[ha]_<metric>__prior_def', 'stage 3 priors', True, ''),
    'recent_program_history_3y': (D, 'prior model reads lag-1 and lag-2 data-only ratings', 'stage 3', True,
                                  'two seasons, not three: the third lag added nothing in the prior fit'),
    'returning_production_off': (A, 'ret_off (prior input)', 'sportsdataverse cfb_returning_production', True,
                                 'season roster assumed ~ preseason roster; is_estimated rows kept'),
    'returning_production_def': (A, 'ret_def (prior input)', 'sportsdataverse cfb_returning_production', True, ''),
    'returning_ol_snap_pct': (N, None, None, False, 'no public college snap counts'),
    'returning_wrte_rec_yards_pct': (D, None, 'ESPN player box', False, 'derivable; deferred — covered by aggregate returning production'),
    'returning_qb_pass_yards_pct': (D, None, 'ESPN player box', False, 'deferred; in-season QB model + aggregate returning production'),
    'returning_def_snap_pct': (N, None, None, False, 'no public college snap counts'),
    'talent_composite': (A, 'talent_z (prior input)', 'sportsdataverse cfb_team_talent (247 composite)', True, ''),
    'transfer_value_net': (R, None, 'roster diffs', False, 'portal arrival dates are not point-in-time in any reachable feed'),
    'coaching_change_hc': (A, 'hc_new (prior input)', 'cfb_matchup_line hc_tenure (preseason incumbent), 2015+', True,
                           'missing before 2015 -> flag m_coach, never zero'),
    'coordinator_change_off': (A, 'unit_change (offence prior)', 'cfb_matchup_line oc_cont, 2015+', True, ''),
    'coordinator_change_def': (A, 'unit_change (defence prior)', 'cfb_matchup_line dc_cont, 2015+', True, ''),
    'offense_adj_epa_play': (D, '[ha]_epa__off', 'stage 3 joint ridge', True, ''),
    'offense_adj_pass_epa': (D, '[ha]_epa_pass__off', 'stage 3', True, 'sacks included as dropbacks, every season'),
    'offense_adj_rush_epa': (D, '[ha]_epa_rush__off', 'stage 3', True, 'scrambles are rushes in the feed, every season'),
    'offense_adj_success_rate': (D, '[ha]_sr__off', 'stage 3', True, ''),
    'offense_adj_early_down_success': (D, '[ha]_sr_early__off', 'stage 3', True, ''),
    'offense_adj_standard_down_success': (R, None, None, False, 'redundant with early-down and passing-down success'),
    'offense_adj_passing_down_success': (D, '[ha]_sr_pd__off', 'stage 3', True, ''),
    'offense_adj_explosiveness': (D, '[ha]_expl__off', 'stage 3', True, 'explosive-play RATE, not EPA on successful plays'),
    'offense_adj_pass_explosiveness': (D, '[ha]_expl_pass__off', 'stage 3', True, ''),
    'offense_adj_rush_explosiveness': (D, '[ha]_expl_rush__off', 'stage 3', True, ''),
    'defense_adj_epa_play': (D, '[ha]_epa__def', 'stage 3', True, 'sign: + = defence allows more'),
    'defense_adj_pass_epa': (D, '[ha]_epa_pass__def', 'stage 3', True, ''),
    'defense_adj_rush_epa': (D, '[ha]_epa_rush__def', 'stage 3', True, ''),
    'defense_adj_success_rate': (D, '[ha]_sr__def', 'stage 3', True, ''),
    'defense_adj_early_down_success': (D, '[ha]_sr_early__def', 'stage 3', True, ''),
    'defense_adj_standard_down_success': (R, None, None, False, 'redundant (see offence)'),
    'defense_adj_passing_down_success': (D, '[ha]_sr_pd__def', 'stage 3', True, ''),
    'defense_adj_explosiveness': (D, '[ha]_expl__def', 'stage 3', True, ''),
    'defense_adj_pass_explosiveness': (D, '[ha]_expl_pass__def', 'stage 3', True, ''),
    'defense_adj_rush_explosiveness': (D, '[ha]_expl_rush__def', 'stage 3', True, ''),
    'off_adj_line_yards': (D, '[ha]_line_yds__off', 'stage 1 own allocation from statYardage', True,
                           'provider line_yards drifts across seasons; recomputed'),
    'def_adj_line_yards_allowed': (D, '[ha]_line_yds__def', 'stage 1', True, ''),
    'off_adj_stuff_rate_allowed': (D, '[ha]_stuff__off', 'stage 1 (rush statYardage <= 0)', True, 'provider stuffed_run drifts'),
    'def_adj_stuff_rate': (D, '[ha]_stuff__def', 'stage 1', True, ''),
    'off_second_level_yards': (R, None, None, False, 'provider column drifts; line-yard allocation already caps at 10'),
    'def_second_level_yards_allowed': (R, None, None, False, 'as above'),
    'off_open_field_yards': (R, None, None, False, 'low stability; provider column drifts'),
    'def_open_field_yards_allowed': (R, None, None, False, 'as above'),
    'off_havoc_allowed': (D, '[ha]_havoc__off (front havoc: sacks + run TFLs)', 'stage 1', True,
                          'classic havoc needs pass break-ups, whose tagging swings 4x between seasons'),
    'def_havoc_created': (D, '[ha]_havoc__def', 'stage 1', True, ''),
    'off_front7_havoc_allowed': (R, None, None, False, 'attribution unavailable'),
    'def_front7_havoc_created': (R, None, None, False, 'attribution unavailable'),
    'off_db_havoc_allowed': (R, None, None, False, 'needs PBU/INT attribution; PBU tagging drifts'),
    'def_db_havoc_created': (R, None, None, False, 'as above'),
    'off_points_per_opportunity': (D, '[ha]_pts_per_opp__off', 'stage 1 drives', True, 'opportunity = drive reaching opp 40'),
    'def_points_per_opportunity_allowed': (D, '[ha]_pts_per_opp__def', 'stage 1', True, ''),
    'off_scoring_opportunity_rate': (D, '[ha]_so_rate__off', 'stage 1', True, ''),
    'def_scoring_opportunity_rate_allowed': (D, '[ha]_so_rate__def', 'stage 1', True, ''),
    'off_drive_epa': (D, '[ha]_drive_epa__off', 'stage 1', True, ''),
    'def_drive_epa_allowed': (D, '[ha]_drive_epa__def', 'stage 1', True, ''),
    'off_points_per_drive': (D, '[ha]_ppd__off', 'stage 1', True, 'TD=7, FG=3, non-garbage drives'),
    'def_points_per_drive_allowed': (D, '[ha]_ppd__def', 'stage 1', True, ''),
    'off_avg_start_field_position': (D, '[ha]_start_fp__off', 'stage 1', True, 'yards to goal; higher = worse'),
    'def_avg_start_field_position_allowed': (D, '[ha]_start_fp__def', 'stage 1', True, ''),
    'pace_seconds_per_play': (R, None, None, False, 'the provider clock stamp changes meaning by season (doc)'),
    'plays_per_game_neutral': (D, '[ha]_plays_pg__off', 'stage 1', True, 'all scrimmage plays; not game-state neutralised'),
    'drives_per_game_neutral': (D, '[ha]_drives_pg__off, exp_drives_*', 'stage 1', True, ''),
    'qb_status': (N, 'engine input qb.status (live only)', 'football/enrichment (tier 5 only today)', False,
                  'no archived pregame status history exists; cannot be trained or backtested'),
    'qb_start_probability': (D, 'engine STATUS_START_PROB (declared, live only)', 'engine', False,
                             'declared mapping; calibration requires archived status reports'),
    'qb_adj_epa_dropback': (D, '[ha]_qb_exp_rating', 'stage 4', True, ''),
    'qb_success_rate': (D, None, 'stage 4', False, 'deferred; EPA/dropback carries it'),
    'qb_cpoe': (N, None, None, False, 'no air-yards / expected-completion model in the feed'),
    'qb_sack_rate': (D, None, 'stage 4', False, 'team sack-rate rating carries it'),
    'qb_rush_epa': (D, None, 'stage 4', False, 'scrambles not separable from designed runs'),
    'qb_turnover_rate': (D, None, 'stage 4', False, 'regresses almost fully to the mean'),
    'qb_experience_starts': (D, '[ha]_qb_exp_starts, [ha]_qb_exp_db_log', 'stage 4', True, ''),
    'qb_starter_backup_delta': (D, '[ha]_qb_drop', 'stage 4', True, 'backup = next passer by dropbacks, else replacement mean'),
    'availability_ol_value_lost': (N, 'engine input (live), capped', 'football/availability', False,
                                   'no archived pregame injury reports or snap counts'),
    'availability_skill_value_lost': (N, 'engine input (live), capped', 'football/availability', False, 'as above'),
    'availability_front7_value_lost': (N, 'engine input (live), capped', 'football/availability', False, 'as above'),
    'availability_secondary_value_lost': (N, 'engine input (live), capped', 'football/availability', False, 'as above'),
    'availability_uncertainty': (D, 'engine sigma inflation (live)', 'engine', False, 'variance only, never the mean'),
    'st_epa_per_game': (D, '[ha]_st_net__off/def, edge_st_net', 'stage 1+3', True, 'zero-sum net special-teams EPA'),
    'fg_value_over_expected': (D, '[ha]_fg_value__off, edge_fg_value', 'stage 1+3', True, 'FG EPA = value vs EP expectation'),
    'punt_net_ep_value': (D, 'punt_net_epa (stage 1 only)', 'stage 1', False, 'folded into st_net'),
    'return_ep_value': (D, 'kick_net_epa (stage 1 only)', 'stage 1', False, 'folded into st_net'),
    'home_field_team_effect': (D, 'hfa_team_edge', 'walk-forward residuals', True, 'home-minus-road residual, partial pooling'),
    'travel_distance_miles': (D, 'travel_miles_log', 'team_info geography', True, 'ablation decides'),
    'timezone_shift_hours': (D, 'tz_shift', 'team_info timezone', True, 'ablation decides'),
    'rest_days_diff': (D, 'rest_diff', 'schedule', True, 'ablation decides'),
    'altitude_diff_ft': (D, 'altitude_kft', 'team_info elevation', True, 'ablation decides'),
    'wind_mph': (N, 'engine input weather.wind_mph (live, variance only)', None, False,
                 'no archived pregame FORECASTS reachable; observed weather would leak post-kickoff information'),
    'precip_prob': (N, 'engine input (live, variance only)', None, False, 'as above'),
    'temperature_f': (N, 'engine input (live, variance only)', None, False, 'as above'),
    'weather_forecast_age_minutes': (N, 'engine input (live)', None, False, 'as above'),
    'team_strength_ewma': (D, '[ha]_<metric>__off_rec/def_rec', 'stage 3 recent horizon', True, 'half-life tuned'),
    'off_epa_ewma': (D, '[ha]_epa__off_rec', 'stage 3', True, ''),
    'def_epa_ewma': (D, '[ha]_epa__def_rec', 'stage 3', True, ''),
    'form_vs_season_delta': (D, 'form_<metric>', 'stage 5', True, ''),
    'team_volatility': (D, '[ha]_<metric>__vol, vol_sum', 'stage 3', True, ''),
    'match_pass_edge': (D, 'match_pass_edge', 'stage 5', True, ''),
    'match_rush_edge': (D, 'match_rush_edge', 'stage 5', True, ''),
    'match_havoc_edge': (D, 'match_havoc_edge, match_sack_edge', 'stage 5', True, ''),
    'match_explosive_edge': (D, 'match_explosive_edge', 'stage 5', True, ''),
    'match_early_down_edge': (D, 'match_early_down_edge', 'stage 5', True, ''),
    'match_passing_down_edge': (D, 'match_passing_down_edge', 'stage 5', True, ''),
    'match_trench_edge': (D, 'match_trench_edge', 'stage 5', True, ''),
    'match_finishing_edge': (D, 'match_finishing_edge', 'stage 5', True, ''),
    'expected_possessions': (D, 'exp_drives_home, exp_drives_away', 'stage 5', True, ''),
    'sample_effective_plays': (D, '[ha]_epa__n_eff_off', 'stage 3', True, ''),
    'sample_effective_drives': (D, '[ha]_ppd__n_eff_off', 'stage 3', True, ''),
    'pbp_completeness': (D, 'report/data_quality.json', 'stage 1 vs schedule', False, 'a pipeline QA gate, not a model input'),
    'source_conflict_score': (N, 'engine input (live)', 'football/enrichment', False, 'no historical source-conflict archive'),
    'ensemble_std_margin': (D, 'ens_sd', 'stage 7', True, ''),
    'prediction_sigma': (D, 'sigma', 'stage 7', True, ''),
    'football_confidence': (D, 'reliability', 'stage 7', True, 'NOT betting edge'),
    'open_spread': (A, 'open_margin', 'cfbfastR multi-book archive 2012-2025 (none in 2020); CFBD mean 2026', True,
                    'converted to home-margin convention at ingestion'),
    'current_spread': (N, 'engine input market.current (live)', 'EdgeDesk capture (signals)', False,
                       'no historical intermediate snapshots; history has open and close only'),
    'close_spread': (A, 'close_margin (EVALUATION ONLY)', 'archive', True, 'never a pregame feature'),
    'current_price_american': (N, 'engine input (live)', 'EdgeDesk capture', False,
                               'the archive carries lines, not spread prices; backtests state -110'),
    'consensus_spread': (A, 'open_margin / close_margin (median across books)', 'archive', True, ''),
    'market_dispersion': (N, 'engine input (live)', 'EdgeDesk capture', False,
                          'history has cross-book SD at the CLOSE only; not usable pregame'),
    'line_move_from_open': (D, 'line_move (evaluation), engine live', 'archive', False, 'evaluation only historically'),
    'pure_model_margin': (D, 'ens_pred', 'stage 7', True, ''),
    'model_market_gap': (D, 'gap_open', 'stage 8', True, ''),
    'cover_probability': (D, 'pc_home_cal / p_side', 'stage 8', True, 'calibrated walk-forward'),
    'break_even_probability': (D, 'engine breakEven(price)', 'stage 8', True, ''),
    'estimated_ev_per_unit': (D, 'ev', 'stage 8', True, ''),
    'edge_reliability': (D, 'reliability (+ gates)', 'stage 7/8', True, ''),
    'external_model_consensus': (N, None, 'Prediction Tracker', False,
                                 'network policy blocks the host; ESPN FPI archive is end-of-season (leaks); '
                                 'CFBD pregame Elo is benchmarked alone'),
    'external_model_dispersion': (N, None, 'Prediction Tracker', False, 'as above'),
    'final_home_points': (A, 'home_points (TARGET)', 'schedule', True, 'target only'),
    'final_away_points': (A, 'away_points (TARGET)', 'schedule', True, 'target only'),
    'final_margin_home': (A, 'margin (TARGET)', 'schedule', True, 'target only'),
    'ats_result_current': (D, 'bet_result (EVALUATION)', 'stage 8', True, 'evaluation only'),
    'clv_points': (D, 'clv_pts (EVALUATION)', 'stage 8', True, 'evaluation only'),
    'prediction_abs_error': (D, 'report', 'stage 9', True, 'evaluation only'),
}


def coverage_rows():
    rows = []
    with open(DICT_CSV) as f:
        for r in csv.DictReader(f):
            name = r['feature_name']
            st = COVERAGE.get(name)
            if st is None:
                raise AssertionError('dictionary field %s has no coverage decision' % name)
            status, col, src, used, note = st
            rows.append({'feature_name': name, 'dictionary_layer': r['layer'], 'priority': r['priority'],
                         'status': status, 'v2_column': col or '', 'v2_source': src or '',
                         'used_in_v2_0': bool(used), 'note': note, 'leakage_rule': r['leakage_rule'],
                         'missing_data_policy': r['missing_data_policy']})
    return rows


def data_dictionary(snapshot_cols):
    """One row per production column: definition, source, transform, cadence, null policy, layer, version."""
    out = []
    for c in snapshot_cols:
        L = layer_of(c)
        m = re.match(r'^([ha])_([a-z0-9_]+)__(.+)$', c)
        if m:
            side = {'h': 'home', 'a': 'away'}[m.group(1)]
            d = '%s team %s rating component %s' % (side, m.group(2), m.group(3))
            src, tr = 'stage 3 joint Bayesian ridge (pbp)', 'posterior at prediction_ts; metric units vs league mean'
        elif c.startswith('edge_') or c.startswith('match_'):
            d, src, tr = 'home-minus-away standardized matchup edge', 'stage 5', '(off_h + def_a) - (off_a + def_h), / metric SD'
        elif c.startswith('lg_'):
            d, src, tr = 'league mean / home effect at prediction_ts', 'stage 3', 'posterior'
        else:
            d, src, tr = c, 'see pipeline', ''
        null = 'missing -> column mean + missingness flag (models)' if L == 'pure' else 'kept null'
        out.append({'column': c, 'layer': L, 'definition': d, 'source': src, 'transform': tr,
                    'update_cadence': 'weekly freeze (Tue 12:00 UTC); live refresh daily in season',
                    'null_policy': null, 'version_introduced': C.FEATURE_VERSION})
    return out


def write_reports(out_dir, snapshot_cols):
    rows = coverage_rows()
    pd.DataFrame(rows).to_csv(os.path.join(out_dir, 'feature_coverage.csv'), index=False)
    pd.DataFrame(data_dictionary(snapshot_cols)).to_csv(os.path.join(out_dir, 'data_dictionary.csv'), index=False)
    cnt = pd.DataFrame(rows).groupby('status').size().to_dict()
    return cnt
