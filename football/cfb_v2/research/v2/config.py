"""EdgeDesk CFB V2 — every tunable, every window, every seed, in one place.

Nothing in the pipeline reads a magic number from anywhere else. A value here
is either
  * DECLARED  — a definition (garbage-time thresholds, window boundaries), or
  * TUNED     — chosen by walk-forward search on the DEVELOPMENT window only,
                with the search and its result recorded in report/tuning.json.

The holdout seasons are never read by any tuning code path. `assert_dev_only`
is called by every tuner, and `tests/test_leakage.py` asserts that it raises.
"""
import os

MODEL_ID = 'edgedesk_cfb_v2'
MODEL_VERSION = 'edgedesk_cfb_v2.0.0'
FEATURE_VERSION = 'cfb_v2_fv1'
SEED = 20260927                       # the only seed; LightGBM and bootstraps use it

DATA = os.environ.get('CFB_V2_DATA', 'data')
OUT = os.environ.get('CFB_V2_OUT', 'out')

# ---------------------------------------------------------------- windows
FIRST_PBP_SEASON = 2009               # burn-in only: ratings + priors, never scored
FIRST_SNAPSHOT_SEASON = 2012          # first season with a frozen pregame feature row
FIRST_OOF_SEASON = 2014               # submodels need >= 2 seasons of snapshots to train
FIRST_STACK_SEASON = 2016             # stacker needs >= 2 seasons of OOF submodel output
FIRST_CAL_SEASON = 2017               # calibration needs >= 1 season of stacked OOF
DEV_SEASONS = tuple(range(2016, 2024))          # 2016-2023: tuning + ablation + thresholds
HOLDOUT_SEASONS = (2024, 2025)                  # untouched until the config is frozen
LIVE_SEASON = 2026                              # genuine live out-of-sample evidence
COVID_SEASON = 2020                             # reported separately, never silently dropped


def assert_dev_only(seasons):
    """Raise if a tuning routine is handed a holdout or live season."""
    bad = sorted(set(int(s) for s in seasons) & (set(HOLDOUT_SEASONS) | {LIVE_SEASON}))
    if bad:
        raise AssertionError('tuning touched holdout/live seasons %s — forbidden' % bad)


# ----------------------------------------------------- play-level cleaning
# Garbage time, DECLARED, from the score and the quarter only. The provider's
# win-probability columns are NOT used: its WP model reads the pregame spread
# (start.pos_team_spread, spread_time), so a WP-based garbage filter would
# carry market information into the pure football features.
GARBAGE_MARGIN_BY_QTR = {1: None, 2: 38, 3: 28, 4: 22}   # |score diff| > value -> garbage
GARBAGE_WEIGHT = 0.0                   # garbage plays contribute nothing to efficiency

# ------------------------------------------------ opponent-adjusted ratings
# Each metric: y_(off t, def d, game g) = mu + o_t + d_d + h*home + e,
#   Var(e) = s2_play / n_plays + s2_game,   o_t ~ N(prior_o, tau2_o), d_d ~ N(prior_d, tau2_d)
# solved jointly (one weighted ridge / Gaussian posterior) at every prediction
# timestamp from games that kicked off before it. s2_play, s2_game and tau2 are
# estimated from pre-season data (see ratings.py); the multipliers below are
# the TUNED knobs.
# Multiplier on each metric's estimated preseason prior variance, TUNED per
# metric by walk-forward next-game prediction on dev seasons 2016-2019,
# 2021-2022 (grid 0.25..8; report/tuning_ratings*.json). Small = the prior is
# sticky (the metric does not persist: turnovers, special teams, pace); large
# = current-season data takes over quickly (pass efficiency, drive scoring).
RATING_PRIOR_SCALE = {
    '_default': 2.0, 'drive_epa': 8.0, 'drives_pg': 1.0, 'epa': 4.0, 'epa_pass': 8.0,
    'epa_rush': 2.0, 'expl': 1.0, 'expl_pass': 1.0, 'expl_rush': 1.0, 'fg_value': 1.0,
    'havoc': 2.0, 'line_yds': 1.0, 'opp_rate': 1.0, 'pass_rate': 1.0, 'plays_pg': 1.0,
    'ppd': 8.0, 'pts_per_opp': 1.0, 'sack_rate': 8.0, 'so_rate': 4.0, 'sr': 2.0,
    'sr_3rd': 1.0, 'sr_early': 2.0, 'sr_pass': 2.0, 'sr_pd': 2.0, 'sr_rush': 1.0,
    'st_net': 1.0, 'start_fp': 1.0, 'stuff': 2.0, 'to_rate': 1.0,
}
# recent-form horizon half-life, TUNED (grid 2/3/5/8 weeks). At 8 weeks the
# recent horizon beats season-long next-game error by only 0.2% — the data's
# way of saying "do not chase last week".
RECENT_HALFLIFE_WEEKS = 8.0
RECENT_PRIOR_SCALE = 0.35              # recent-form posterior is shrunk toward season (tuned)
FCS_POOL = 'FCS'                       # all non-FBS teams share one pooled prior mean

# The adjusted metrics. sign=+1: higher is better for the OFFENSE.
# kind: 'rate' metrics are per-play means; 'drive' per-drive means.
METRICS = [
    # name,            numerator col,  denominator col, kind,   family
    ('epa',            'epa_sum',      'n_plays',   'rate',  'adj_eff'),
    ('epa_pass',       'epa_pass_sum', 'n_db',      'rate',  'adj_eff'),
    ('epa_rush',       'epa_rush_sum', 'n_rush',    'rate',  'adj_eff'),
    ('sr',             'succ',         'n_plays',   'rate',  'adj_eff'),
    ('sr_pass',        'succ_pass',    'n_db',      'rate',  'adj_eff'),
    ('sr_rush',        'succ_rush',    'n_rush',    'rate',  'adj_eff'),
    ('sr_early',       'succ_early',   'n_early',   'rate',  'situational'),
    ('sr_pd',          'succ_pd',      'n_pd',      'rate',  'situational'),
    ('expl',           'expl',         'n_plays',   'rate',  'explosive'),
    ('expl_pass',      'expl_pass',    'n_db',      'rate',  'explosive'),
    ('expl_rush',      'expl_rush',    'n_rush',    'rate',  'explosive'),
    ('line_yds',       'line_yds',     'n_rush',    'rate',  'trench'),
    ('stuff',          'stuff',        'n_rush',    'rate',  'trench'),
    ('opp_rate',       'opp_run',      'n_rush',    'rate',  'trench'),
    ('havoc',          'havoc',        'n_plays',   'rate',  'havoc'),
    ('sack_rate',      'sacks',        'n_db',      'rate',  'havoc'),
    ('to_rate',        'turnovers',    'n_plays',   'rate',  'volatile'),
    ('ppd',            'drive_pts',    'n_drives',  'drive', 'drive'),
    ('so_rate',        'scoring_opps', 'n_drives',  'drive', 'drive'),
    ('pts_per_opp',    'opp_pts',      'scoring_opps', 'drive', 'drive'),
    ('start_fp',       'start_ytg_sum', 'n_drives', 'drive', 'field_pos'),
    ('drive_epa',      'drive_epa_sum', 'n_drives', 'drive', 'drive'),
    ('sr_3rd',         'conv_3rd',     'n_3rd',     'rate',  'situational'),
    ('pass_rate',      'n_db',         'n_plays',   'rate',  'style'),
]
# metrics where a HIGHER offensive value is WORSE for the offense
NEGATIVE_METRICS = {'stuff', 'havoc', 'sack_rate', 'to_rate', 'start_fp'}
# style metrics carry no better/worse direction and never form an 'edge'
STYLE_METRICS = {'pass_rate'}

# pace is a shared quantity (both teams make it), modelled additively
PACE_METRICS = [('plays_pg', 'n_plays_all'), ('drives_pg', 'n_drives_all')]

# special teams: one zero-sum net rating per team per game
ST_METRICS = [('st_net', 'st_net_epa'), ('fg_value', 'fg_epa')]

# --------------------------------------------------------------- Elo (B)
ELO_K = 20.0                          # tuned on dev window
ELO_HFA = 55.0                        # Elo points (tuned)
ELO_CARRY = 0.70                      # season carry-over toward conference mean (tuned)
ELO_MOV_CAP = 35.0                    # diminishing returns on blowouts
ELO_PTS_PER_ELO = 1.0 / 25.0          # margin per Elo point (fitted)

# ------------------------------------------------------------ submodels
RIDGE_ALPHA = 30.0                    # model C ridge penalty (tuned on dev)
GBM_PARAMS = dict(objective='huber', alpha=14.0, learning_rate=0.03, num_leaves=15,
                  min_data_in_leaf=60, feature_fraction=0.7, bagging_fraction=0.8,
                  bagging_freq=1, lambda_l2=10.0, n_estimators=600, verbose=-1,
                  deterministic=True, force_row_wise=True, num_threads=1)

# ------------------------------------------------------------- uncertainty
INTERVALS = (0.50, 0.80, 0.95)

# ---------------------------------------------------------- market layer
VIG_DEFAULT_AMERICAN = None           # never assume -110 silently; null -> EV not computable
STANDARD_JUICE_FOR_BACKTEST = -110    # the historical archive carries lines, not spread prices
