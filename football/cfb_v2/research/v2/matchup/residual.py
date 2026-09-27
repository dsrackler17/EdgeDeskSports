"""Matchup residual models (docs/cfb-matchup/METHODS.md section 7; brief sections 19-20, 44-47, 57-58).

Target: V2.1's OUT-OF-FOLD residual r = margin - ens_pred (for 2014-2015, where V2.1 has no stack,
the identical equal-weight C/D mean). The base model is never refit here: general strength stays
V2.1 and the matchup model can only add a correction.

Walk-forward: the correction for season S is fit on seasons FIRST_TRAIN..S-1 only (assert).
Interpretable first:
  RidgeResid   standardized ridge, NO intercept (features are centred on the training rows, so
               the correction has mean zero there and cannot learn a home-field / bias shift),
               declared penalty ALPHA = residual variance / TAU^2 (TAU = 0.5 points per SD of a
               feature: a Gaussian prior that matchup effects are small).
Nonlinear challenger second:
  GBMResid     LightGBM, depth-2 trees (4 leaves), learning rate 0.02, 150 rounds, >= 300 games per
               leaf, L2 50, feature_fraction 0.8, seeded, deterministic, single-threaded.
Shrinkage by evidence: the raw correction of season S is multiplied by lambda_S, the out-of-fold
calibration slope of r on the raw correction over seasons < S (clipped to [0, 1]): if past
corrections did not move the residual, the correction goes to zero. A hard cap (CAP points) is a
documented safety only; the report counts how often it binds.
Variance: a Gamma GLM (log link) of r^2 / sigma_V2.1^2 on symmetric matchup-volatility features,
walk-forward; it may widen or narrow the distribution, never move the mean.
"""
import hashlib
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import walkforward as WF
from . import RESIDUAL_MODEL_VERSION, MATCHUP_FEATURE_VERSION, STYLE_VERSION, SIMILARITY_VERSION, BASE_MODEL_VERSION

FIRST_TRAIN = C.FIRST_OOF_SEASON          # 2014: first season with a V2.1 out-of-fold prediction
FIRST_LAMBDA = FIRST_TRAIN + 1            # 2015 is predicted (from 2014) only to seed lambda
RESID_VAR = 256.0                         # ~ (16 points)^2, V2.1 dev RMSE
TAU = 0.5                                 # prior SD of a matchup effect, points per feature SD
ALPHA = RESID_VAR / TAU ** 2              # = 1024
CAP = 3.0                                 # safety cap, points (documented; see BACKTEST.md)
ZCLIP = 4.0                               # standardized features are winsorized at +/- 4 SD
GBM_PARAMS = dict(objective='regression', learning_rate=0.02, num_leaves=4, max_depth=2, min_data_in_leaf=300,
                  feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=50.0, verbose=-1,
                  deterministic=True, force_row_wise=True, num_threads=1)
GBM_ROUNDS = 150
ARTIFACT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..',
                                             'artifacts', 'matchup'))


# ------------------------------------------------------------------ the frame
def base_frame(M):
    """V2.1 walk-forward rows with the base prediction and residual; in_scope = FBS vs FBS,
    FINAL, margin and base present (pipeline.window_report's scope)."""
    D = M[['game_id', 'season', 'week', 'status', 'fcs_game', 'margin', 'ens_pred', 'pred_C_ridge', 'pred_D_gbm',
           'sigma', 'p_home_raw', 'home_id', 'away_id', 'home_team', 'away_team', 'home_conference', 'away_conference',
           'prediction_ts', 'kickoff_ts', 'neutral_site', 'weeks_in', 'is_postseason']].copy()
    D['base'] = D.ens_pred.where(D.ens_pred.notna(), D[['pred_C_ridge', 'pred_D_gbm']].mean(axis=1))
    D['resid'] = D.margin - D.base
    D['in_scope'] = D.status.eq('FINAL') & ~D.fcs_game.astype(bool) & D.margin.notna() & D.base.notna()
    return D


def t_dfs(report_path=None):
    f = report_path or common.out_path('report', 'backtest.json')
    u = json.load(open(f))['uncertainty_by_season']
    return {int(k): int(v['t_df']) for k, v in u.items()}


def win_prob(pred, sigma, df):
    """V2.1's raw win probability: 1 - F_t(-pred / sigma; df), F_t unit-variance t (walkforward.t_cdf)."""
    return 1.0 - WF.t_cdf(-np.asarray(pred, dtype=float) / np.asarray(sigma, dtype=float), df)


# ------------------------------------------------------------------- models
class RidgeResid:
    def __init__(self, cols, alpha=ALPHA):
        self.cols, self.alpha = list(cols), float(alpha)

    def _Z(self, X):
        Z = X[self.cols].astype(float)
        Z = Z.fillna(self.mean_)
        # winsorized at +/- ZCLIP training SDs: a heavy-tailed interaction cannot lever the fit
        return np.clip(((Z - self.mean_) / self.sd_).values, -ZCLIP, ZCLIP)

    def fit(self, X, r):
        Z = X[self.cols].astype(float)
        self.mean_ = Z.mean().fillna(0.0)          # a column with no training value contributes nothing
        self.sd_ = Z.std().replace(0, 1.0).fillna(1.0)
        A = self._Z(X)
        self.beta_ = np.linalg.solve(A.T @ A + self.alpha * np.eye(A.shape[1]), A.T @ np.asarray(r, dtype=float))
        return self

    def predict(self, X):
        return self._Z(X) @ self.beta_

    def coef(self):
        """Points per 1 SD of each feature (the SD of the training rows)."""
        return dict(zip(self.cols, [float(b) for b in self.beta_]))

    def contributions(self, X):
        return pd.DataFrame(self._Z(X) * self.beta_, columns=self.cols, index=X.index)

    def to_json(self):
        return {'kind': 'ridge', 'cols': self.cols, 'alpha': self.alpha, 'mean': {k: float(v) for k, v in self.mean_.items()},
                'sd': {k: float(v) for k, v in self.sd_.items()}, 'beta': [float(b) for b in self.beta_]}

    @classmethod
    def from_json(cls, j):
        m = cls(j['cols'], j['alpha'])
        m.mean_, m.sd_ = pd.Series(j['mean'])[m.cols], pd.Series(j['sd'])[m.cols]
        m.beta_ = np.array(j['beta'])
        return m


class GBMResid:
    def __init__(self, cols, params=None, rounds=GBM_ROUNDS):
        self.cols, self.params, self.rounds = list(cols), dict(params or GBM_PARAMS), rounds

    def fit(self, X, r):
        import lightgbm as lgb
        p = dict(self.params, seed=C.SEED, bagging_seed=C.SEED, feature_fraction_seed=C.SEED)
        ds = lgb.Dataset(X[self.cols].astype(float).values, label=np.asarray(r, dtype=float), free_raw_data=False)
        self.booster_ = lgb.train(p, ds, num_boost_round=self.rounds)
        self.center_ = float(np.mean(self.booster_.predict(X[self.cols].astype(float).values)))
        return self

    def predict(self, X):
        # centred on the training rows like the ridge: no learned intercept / bias shift
        return self.booster_.predict(X[self.cols].astype(float).values) - self.center_


# ------------------------------------------------------------- walk-forward
def assert_past_only(train_seasons, S):
    assert len(train_seasons) and max(train_seasons) < S, 'future season in a matchup training set'


def walk_forward(D, cols, make=None, seasons=None, first_train=FIRST_TRAIN, cap=CAP, shrink=True):
    """Raw and shrunk walk-forward corrections for every row of D (index-aligned). Rows of season S
    get a model fitted on in-scope rows of seasons first_train..S-1 only.
    Returns (adj_raw, adj, lambdas, models)."""
    make = make or (lambda c: RidgeResid(c))
    seasons = seasons or sorted(s for s in D.season.unique() if s >= FIRST_LAMBDA)
    adj_raw = pd.Series(np.nan, index=D.index)
    models = {}
    for S in seasons:
        tr = D[D.in_scope & D.season.between(first_train, S - 1)]
        tr = tr[tr[cols].notna().any(axis=1)]
        if tr.season.nunique() < 1 or len(tr) < 300:
            continue
        assert_past_only(sorted(tr.season.unique()), S)
        m = make(cols).fit(tr, tr.resid.values)
        cur = D.season.eq(S)
        adj_raw[cur] = m.predict(D[cur])
        models[S] = m
    lambdas, adj = {}, pd.Series(np.nan, index=D.index)
    for S in seasons:
        cur = D.season.eq(S) & adj_raw.notna()
        if not cur.any():
            continue
        if shrink:
            past = D.in_scope & (D.season < S) & (D.season >= FIRST_LAMBDA) & adj_raw.notna()
            a, r = adj_raw[past].values, D.resid[past].values
            lam = float(np.clip(np.sum(a * r) / np.sum(a * a), 0.0, 1.0)) if past.sum() >= 300 and np.sum(a * a) > 0 else 0.0
        else:
            lam = 1.0
        lambdas[S] = lam
        adj[cur] = np.clip(lam * adj_raw[cur], -cap, cap)
    return adj_raw, adj, lambdas, models


# --------------------------------------------------------------- metrics
def metrics(y, pred, p=None):
    e = pred - y
    out = {'n': int(len(y)), 'mae': float(np.mean(np.abs(e))), 'rmse': float(np.sqrt(np.mean(e ** 2))),
           'bias': float(np.mean(e)), 'tail_p90_abs_err': float(np.quantile(np.abs(e), 0.9))}
    if p is not None:
        ok = np.isfinite(p)
        if ok.any():
            yw = (y[ok] > 0).astype(float)
            pp = np.clip(p[ok], 1e-6, 1 - 1e-6)
            out['log_loss'] = float(-np.mean(yw * np.log(pp) + (1 - yw) * np.log(1 - pp)))
            out['brier'] = float(np.mean((pp - yw) ** 2))
            out['n_prob'] = int(ok.sum())
            # calibration: mean |observed - predicted| over deciles (ECE)
            bins = np.clip((pp * 10).astype(int), 0, 9)
            ece = 0.0
            for b in range(10):
                k = bins == b
                if k.any():
                    ece += k.mean() * abs(yw[k].mean() - pp[k].mean())
            out['ece'] = float(ece)
    return out


def paired(y, base, new, pb=None, pn=None, n_boot=2000, seed=None):
    """Base vs base+matchup on one game set: metrics, deltas, paired bootstrap 95% CIs of deltas."""
    y, base, new = np.asarray(y, float), np.asarray(base, float), np.asarray(new, float)
    res = {'base': metrics(y, base, pb), 'matchup': metrics(y, new, pn)}
    res['delta'] = {k: res['matchup'][k] - res['base'][k] for k in res['base']
                    if k in res['matchup'] and k not in ('n', 'n_prob')}
    if n_boot and len(y) >= 20:
        rng = np.random.default_rng(C.SEED if seed is None else seed)
        eb, en = np.abs(base - y), np.abs(new - y)
        sb, sn = (base - y) ** 2, (new - y) ** 2
        n = len(y)
        idx = rng.integers(0, n, (n_boot, n))
        dmae = (en[idx] - eb[idx]).mean(axis=1)
        drmse = np.sqrt(sn[idx].mean(axis=1)) - np.sqrt(sb[idx].mean(axis=1))
        ci = {'mae': [float(x) for x in np.quantile(dmae, [0.025, 0.975])],
              'rmse': [float(x) for x in np.quantile(drmse, [0.025, 0.975])]}
        if pb is not None and pn is not None:
            ok = np.isfinite(pb) & np.isfinite(pn)
            if ok.sum() >= 20:
                yw = (y[ok] > 0).astype(float)
                lb = -(yw * np.log(np.clip(pb[ok], 1e-6, 1)) + (1 - yw) * np.log(np.clip(1 - pb[ok], 1e-6, 1)))
                ln = -(yw * np.log(np.clip(pn[ok], 1e-6, 1)) + (1 - yw) * np.log(np.clip(1 - pn[ok], 1e-6, 1)))
                bb, bn = (pb[ok] - yw) ** 2, (pn[ok] - yw) ** 2
                k = int(ok.sum())
                j = rng.integers(0, k, (n_boot, k))
                ci['log_loss'] = [float(x) for x in np.quantile((ln[j] - lb[j]).mean(axis=1), [0.025, 0.975])]
                ci['brier'] = [float(x) for x in np.quantile((bn[j] - bb[j]).mean(axis=1), [0.025, 0.975])]
        res['ci95'] = ci
    return res


# ------------------------------------------------------------ variance model
class VarianceModel:
    """E[r^2] = sigma_V2.1^2 x exp(Z b): Gamma GLM, log link, offset log sigma^2, ridge 1.0."""

    def __init__(self, cols):
        self.cols = list(cols)

    def _Z(self, X):
        Z = X[self.cols].astype(float).fillna(self.mean_)
        return ((Z - self.mean_) / self.sd_).values

    def fit(self, X, r, sigma):
        Z0 = X[self.cols].astype(float)
        self.mean_, self.sd_ = Z0.mean(), Z0.std().replace(0, 1.0).fillna(1.0)
        A = np.column_stack([np.ones(len(X)), self._Z(X)])
        off = np.log(np.asarray(sigma, float) ** 2)
        yv = np.asarray(r, float) ** 2 + 0.25
        b = np.zeros(A.shape[1])
        for _ in range(50):
            eta = off + A @ b
            mu = np.exp(eta)
            z = (eta - off) + (yv - mu) / mu
            P = np.eye(A.shape[1]); P[0, 0] = 0.0
            bn = np.linalg.solve(A.T @ A + P, A.T @ z)
            if np.max(np.abs(bn - b)) < 1e-8:
                b = bn
                break
            b = bn
        self.b_ = b
        return self

    def multiplier(self, X):
        """sigma multiplier (sqrt of the variance ratio), with the intercept removed so the
        model reshapes the spread across games rather than re-scaling V2.1's sigma."""
        return np.exp(0.5 * (self._Z(X) @ self.b_[1:]))

    def coef(self):
        return dict(zip(['intercept'] + self.cols, [float(x) for x in self.b_]))


def t_loglik(r, sigma, df):
    from scipy import stats
    s = np.sqrt((df - 2) / df)
    z = r / sigma
    return stats.t.logpdf(z / s, df) - np.log(s) - np.log(sigma)


# --------------------------------------------------------------- artifact
def content_hash(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def freeze(spec, D, models_json, status, evidence, path=None):
    """Write the frozen matchup artifact. status 'NO_ADJUSTMENT' => apply() returns zeros."""
    body = {'artifact': RESIDUAL_MODEL_VERSION, 'status': status, 'base_model_version': BASE_MODEL_VERSION,
            'feature_version': MATCHUP_FEATURE_VERSION, 'style_version': STYLE_VERSION,
            'similarity_version': SIMILARITY_VERSION, 'spec': spec, 'models': models_json,
            'train_seasons': [FIRST_TRAIN, max(C.DEV_SEASONS)], 'cap_points': CAP, 'alpha': ALPHA, 'tau': TAU,
            'evidence': evidence}
    body['sha256'] = content_hash({k: v for k, v in body.items() if k != 'sha256'})
    path = path or os.path.join(ARTIFACT_DIR, RESIDUAL_MODEL_VERSION + '.json')
    common.write_json(path, body)
    return path, body


def load_artifact(path=None):
    path = path or os.path.join(ARTIFACT_DIR, RESIDUAL_MODEL_VERSION + '.json')
    a = json.load(open(path))
    body = {k: v for k, v in a.items() if k != 'sha256'}
    if content_hash(body) != a.get('sha256'):
        raise ValueError('matchup artifact hash does not verify: %s' % path)
    return a


def apply(art, X):
    """The frozen correction for rows X (points, + = home). NO_ADJUSTMENT -> exactly 0."""
    if art['status'] != 'ADJUST' or not art['models'].get('mean'):
        return np.zeros(len(X))
    m = RidgeResid.from_json(art['models']['mean'])
    lam = float(art['models'].get('lambda', 0.0))
    return np.clip(lam * m.predict(X), -art['cap_points'], art['cap_points'])
