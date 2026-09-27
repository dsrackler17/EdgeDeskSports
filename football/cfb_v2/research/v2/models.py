"""Stage 6 — the five independent submodels and their feature families.

  A  adj_eff   adjusted-efficiency rating model: net opponent-adjusted EPA/play
               edge x expected plays, special teams, home field (3 coefficients)
  B  elo       dynamic margin Elo (results only) scaled to points
  C  ridge     regularised linear matchup model over the standardized families
  D  gbm       LightGBM (Huber loss) over the same families, nonlinear
  E  drive     possession model: expected points per drive x expected drives

Every model is fit ONLY on rows whose season is strictly before the season it
predicts (walkforward.py enforces it) and only on FBS-vs-FBS FINAL games.
"""
import numpy as np
import pandas as pd

from . import config as C
from . import contract as K

CORE = ['epa', 'epa_pass', 'epa_rush', 'sr', 'ppd']

FAMILIES = {
    # BASE: priors, home/neutral, simple dynamic strength
    'base': ['home_field', 'elo_diff', 'edge_prior_epa', 'edge_prior_epa_pass', 'edge_prior_epa_rush',
             'edge_prior_sr', 'edge_prior_ppd'],
    'adj_eff': ['edge_epa', 'edge_epa_pass', 'edge_epa_rush', 'edge_sr', 'edge_sr_pass', 'edge_sr_rush',
                'eff_pts_raw'],
    'drive': ['edge_ppd', 'edge_so_rate', 'edge_pts_per_opp', 'edge_start_fp', 'edge_drive_epa',
              'drive_margin_raw'],
    'trench_havoc': ['edge_line_yds', 'edge_stuff', 'edge_opp_rate', 'edge_havoc', 'edge_sack_rate'],
    'matchup': ['match_mix_edge', 'edge_sr_early', 'edge_sr_pd', 'edge_sr_3rd', 'edge_expl',
                'edge_expl_pass', 'edge_expl_rush', 'x_pass_h', 'x_pass_a', 'x_rush_h', 'x_rush_a',
                'x_sack_h', 'x_sack_a'],
    'form': ['edge_rec_epa', 'edge_rec_epa_pass', 'edge_rec_epa_rush', 'edge_rec_sr', 'edge_rec_ppd',
             'l4_edge_epa', 'l2_edge_epa'],
    'special_teams': ['edge_st_net', 'edge_fg_value'],
    'qb': ['qb_delta_edge', 'qb_exp_edge', 'h_qb_exp_db_log', 'a_qb_exp_db_log', 'h_qb_changed',
           'a_qb_changed', 'qb_missing_any', 'qb_unsettled_any'],
    'volatile': ['edge_to_rate'],
    'context': ['rest_diff', 'travel_miles_log', 'tz_shift', 'altitude_kft', 'conference_game_f',
                'is_postseason_f'],
}
# ablation order from the data-pack drop-in instructions
ABLATION_ORDER = ['base', 'adj_eff', 'drive', 'trench_havoc', 'matchup', 'form', 'special_teams',
                  'qb', 'volatile', 'context']


def add_derived(X):
    X = X.copy()
    X['travel_miles_log'] = np.log1p(X.travel_miles.fillna(0.0))
    X['altitude_kft'] = X.altitude_diff_ft.fillna(0.0) / 1000.0
    X['conference_game_f'] = X.conference_game.astype(float)
    X['is_postseason_f'] = X.is_postseason.astype(float)
    X['rest_diff'] = X.rest_diff.fillna(0.0).clip(-14, 14)
    X['tz_shift'] = X.tz_shift.fillna(0.0)
    X['qb_exp_edge'] = X.qb_exp_edge.fillna(0.0)
    for c in ('h_qb_exp_db_log', 'a_qb_exp_db_log', 'h_qb_changed', 'a_qb_changed'):
        X[c] = X[c].fillna(0.0)
    # last-k residual form as a home-minus-away edge on EPA
    for k in (4, 2):
        X['l%d_edge_epa' % k] = ((X['h_epa__l%d_off' % k].fillna(0) - X['h_epa__l%d_def' % k].fillna(0))
                                 - (X['a_epa__l%d_off' % k].fillna(0) - X['a_epa__l%d_def' % k].fillna(0)))
    return X


def features_for(families):
    cols = []
    for f in families:
        cols += FAMILIES[f]
    return list(dict.fromkeys(cols))


# ------------------------------------------------------------------ linear
class Linear:
    """Standardized ridge with explicit mean imputation learned on the train set."""

    def __init__(self, cols, alpha, intercept=True):
        self.cols, self.alpha, self.intercept = cols, alpha, intercept

    def _X(self, X):
        Z = X[self.cols].astype(float)
        Z = Z.fillna(self.mean_)
        return ((Z - self.mean_) / self.sd_).values

    def fit(self, X, y, w=None):
        K.assert_pure(self.cols)             # the layer guard lives in every fit
        Z = X[self.cols].astype(float)
        self.mean_ = Z.mean()
        self.sd_ = Z.std().replace(0, 1.0).fillna(1.0)
        A = self._X(X)
        w = np.ones(len(y)) if w is None else w
        if self.intercept:
            A = np.column_stack([np.ones(len(A)), A])
        P = np.eye(A.shape[1]) * self.alpha
        if self.intercept:
            P[0, 0] = 0.0
        self.beta_ = np.linalg.solve(A.T @ (A * w[:, None]) + P, A.T @ (w * y))
        return self

    def predict(self, X):
        A = self._X(X)
        if self.intercept:
            A = np.column_stack([np.ones(len(A)), A])
        return A @ self.beta_

    def coef(self):
        names = (['intercept'] if self.intercept else []) + list(self.cols)
        return dict(zip(names, [float(b) for b in self.beta_]))


class ModelA(Linear):
    COLS = ['home_field', 'eff_pts_raw', 'edge_st_net']

    def __init__(self):
        super().__init__(self.COLS, alpha=1.0, intercept=False)


class ModelB(Linear):
    COLS = ['elo_diff']

    def __init__(self):
        super().__init__(self.COLS, alpha=0.0, intercept=False)


class ModelE(Linear):
    COLS = ['home_field', 'drive_margin_raw', 'edge_st_net']

    def __init__(self):
        super().__init__(self.COLS, alpha=1.0, intercept=False)


class ModelC(Linear):
    def __init__(self, families=None, alpha=None):
        fam = families or [f for f in ABLATION_ORDER]
        super().__init__(features_for(fam), alpha=C.RIDGE_ALPHA if alpha is None else alpha)


class ModelD:
    def __init__(self, families=None, params=None):
        self.cols = features_for(families or ABLATION_ORDER)
        self.params = dict(C.GBM_PARAMS if params is None else params)

    def fit(self, X, y, w=None):
        K.assert_pure(self.cols)
        import lightgbm as lgb
        p = dict(self.params)
        n = p.pop('n_estimators')
        p['seed'] = C.SEED
        p['bagging_seed'] = C.SEED
        p['feature_fraction_seed'] = C.SEED
        ds = lgb.Dataset(X[self.cols].astype(float).values, label=y, weight=w,
                         feature_name=[c.replace('__', '_') for c in self.cols], free_raw_data=False)
        self.booster_ = lgb.train(p, ds, num_boost_round=n)
        return self

    def predict(self, X):
        return self.booster_.predict(X[self.cols].astype(float).values)

    def importance(self):
        g = self.booster_.feature_importance('gain')
        return dict(sorted(zip(self.cols, [float(x) for x in g]), key=lambda kv: -kv[1]))


class TotalE(Linear):
    COLS = ['drive_total_raw']

    def __init__(self):
        super().__init__(self.COLS, alpha=1.0, intercept=True)


SUBMODELS = {'A_adj_eff': ModelA, 'B_elo': ModelB, 'C_ridge': ModelC, 'D_gbm': ModelD, 'E_drive': ModelE}
