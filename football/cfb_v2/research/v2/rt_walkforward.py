"""Red team — an INDEPENDENT walk-forward, written without walkforward.py.

The original backtest is not trusted until a second implementation reproduces
it. This module re-implements the training loop from the frozen snapshot table
with different code paths (scikit-learn Ridge on explicitly standardized
inputs, LightGBM called directly, scipy NNLS / SLSQP for the stack, its own
error model and calibrators) and is also the engine every red-team experiment
runs on: component comparisons, ensemble alternatives, feature ablations,
overfitting checks, calibration methods.

Strict chronology, stated once and asserted everywhere:

  target season S  <-  fit on FBS-vs-FBS FINAL games with season < S
  stack weights for S  <-  out-of-fold component predictions of seasons < S
  error model / calibrators for S  <-  out-of-fold ensemble residuals of seasons < S

Nothing here is random except LightGBM's bagging, which is seeded.
"""
import numpy as np
import pandas as pd
from scipy import optimize, stats

from . import config as C
from . import models as MD

COMPONENTS = ['A_adj_eff', 'B_elo', 'C_ridge', 'D_gbm', 'E_drive']
A_COLS = ['home_field', 'eff_pts_raw', 'edge_st_net']
B_COLS = ['elo_diff']
E_COLS = ['home_field', 'drive_margin_raw', 'edge_st_net']


def past_only(train_seasons, S):
    assert len(train_seasons) and max(train_seasons) < S, 'future season in a red-team training set'


def fbs_final(X):
    return X[(~X.fcs_game) & X.status.eq('FINAL') & X.margin.notna()]


# ------------------------------------------------------------ components
class StdRidge:
    """Ridge on inputs standardized with TRAIN mean / sd (ddof=1), NaN -> train
    mean, intercept unpenalized. Implemented with scikit-learn's Ridge."""

    def __init__(self, cols, alpha):
        self.cols, self.alpha = list(cols), float(alpha)

    def fit(self, X, y):
        from sklearn.linear_model import Ridge
        Z = X[self.cols].astype(float)
        self.mu = Z.mean()
        self.sd = Z.std(ddof=1).replace(0, 1.0).fillna(1.0)
        A = ((Z.fillna(self.mu) - self.mu) / self.sd).values
        self.m = Ridge(alpha=max(self.alpha, 1e-12), fit_intercept=True, solver='cholesky').fit(A, y)
        return self

    def predict(self, X):
        Z = X[self.cols].astype(float)
        return self.m.predict(((Z.fillna(self.mu) - self.mu) / self.sd).values)


class GBM:
    def __init__(self, cols, params):
        self.cols, self.params = list(cols), dict(params)

    def fit(self, X, y):
        import lightgbm as lgb
        p = dict(self.params)
        n = p.pop('n_estimators')
        p.update(seed=C.SEED, bagging_seed=C.SEED, feature_fraction_seed=C.SEED, data_random_seed=C.SEED)
        self.b = lgb.train(p, lgb.Dataset(X[self.cols].astype(float).values, label=y,
                                          feature_name=['f%d' % i for i in range(len(self.cols))]),
                           num_boost_round=n)
        return self

    def predict(self, X):
        return self.b.predict(X[self.cols].astype(float).values)

    def gain(self):
        return dict(zip(self.cols, self.b.feature_importance('gain')))


class Spec:
    """One experimental configuration. `drop` removes columns from EVERY
    component that uses them (an ablation must remove the information, not
    just one copy of it). The spec is explicit: the production drop list
    (config.DROPPED_FEATURES) is NOT applied here, so Spec(fam_C, fam_D) is
    candidate 001 and the hardened model is Spec(..., drop=<its list>)."""

    def __init__(self, fam_C=None, fam_D=None, drop=(), ridge_alpha=None, gbm_params=None,
                 noise_cols=0, name='candidate_001'):
        self.fam_C = list(fam_C) if fam_C else None
        self.fam_D = list(fam_D) if fam_D else None
        self.drop = set(drop)
        self.alpha = C.RIDGE_ALPHA if ridge_alpha is None else ridge_alpha
        self.gbm = dict(C.GBM_PARAMS if gbm_params is None else gbm_params)
        self.noise_cols = int(noise_cols)
        self.name = name

    def cols(self, which):
        if which == 'A':
            c = A_COLS
        elif which == 'B':
            c = B_COLS
        elif which == 'E':
            c = E_COLS
        elif which == 'C':
            c = MD.features_for(self.fam_C or MD.ABLATION_ORDER, drop=())
        else:
            c = MD.features_for(self.fam_D or MD.ABLATION_ORDER, drop=())
        c = [x for x in c if x not in self.drop]
        if which in ('C', 'D'):
            c += ['noise_%d' % i for i in range(self.noise_cols)]
        return c


def with_noise(X, k, seed=C.SEED):
    if k <= 0:
        return X
    rng = np.random.default_rng(seed + 99)
    X = X.copy()
    for i in range(k):
        X['noise_%d' % i] = rng.normal(size=len(X))
    return X


def fit_season(X, S, spec, want_models=False):
    tr = fbs_final(X)
    tr = tr[(tr.season < S) & (tr.season >= C.FIRST_SNAPSHOT_SEASON)]
    past_only(sorted(tr.season.unique()), S)
    y = tr.margin.values.astype(float)
    fitted = {}
    for k, which, alpha in (('A_adj_eff', 'A', 1.0), ('B_elo', 'B', 1e-9), ('E_drive', 'E', 1.0),
                            ('C_ridge', 'C', spec.alpha)):
        cols = spec.cols(which)
        fitted[k] = StdRidge(cols, alpha).fit(tr, y) if cols else None
    dcols = spec.cols('D')
    fitted['D_gbm'] = GBM(dcols, spec.gbm).fit(tr, y) if dcols else None
    tot = StdRidge(['drive_total_raw'], 1.0).fit(tr, tr.total_pts.values.astype(float))
    ins = {k: (float(np.mean(np.abs(m.predict(tr) - y))) if m is not None else None) for k, m in fitted.items()}
    return fitted, tot, ins, len(tr)


def run_components(X, spec, seasons=None, keep_models=False, verbose=False):
    """Out-of-fold component predictions for every game of every season."""
    X = with_noise(X, spec.noise_cols)
    seasons = seasons or list(range(C.FIRST_OOF_SEASON, C.LIVE_SEASON + 1))
    out, insample, models = [], {}, {}
    for S in seasons:
        fitted, tot, ins, n = fit_season(X, S, spec)
        Xs = X[X.season.eq(S)]
        P = pd.DataFrame({'game_id': Xs.game_id.values, 'season': S}, index=Xs.index)
        for k, m in fitted.items():
            P['pred_' + k] = m.predict(Xs) if m is not None else np.nan
        P['pred_total'] = tot.predict(Xs)
        out.append(P)
        insample[S] = dict(ins, n_train=n)
        if keep_models:
            models[S] = (fitted, tot)
        if verbose:
            print('[rt] %s season %d n_train=%d' % (spec.name, S, n))
    return pd.concat(out), insample, models


# -------------------------------------------------------------- stacking
def w_sum_to_one(P, y):
    k = P.shape[1]
    r = optimize.minimize(lambda w: np.mean((y - P @ w) ** 2), np.full(k, 1.0 / k), method='SLSQP',
                          bounds=[(0, 1)] * k, constraints=[{'type': 'eq', 'fun': lambda w: w.sum() - 1}],
                          options={'ftol': 1e-12, 'maxiter': 1000})
    return r.x, 0.0


def w_nnls(P, y):
    """Non-negative, NOT constrained to sum to one, with a free intercept."""
    A = np.column_stack([np.ones(len(P)), P])
    # NNLS cannot leave the intercept free: centre instead
    Pm, ym = P.mean(axis=0), y.mean()
    w, _ = optimize.nnls(P - Pm, y - ym)
    return w, float(ym - Pm @ w)


def w_inverse_mse(P, y):
    mse = np.mean((P - y[:, None]) ** 2, axis=0)
    w = (1.0 / mse) / np.sum(1.0 / mse)
    return w, 0.0


def w_ridge_to_equal(P, y, lam_per_row=0.05):
    """Unconstrained stack shrunk toward the equal-weight average, intercept free."""
    k = P.shape[1]
    eq = np.full(k, 1.0 / k)
    Pm, ym = P.mean(axis=0), y.mean()
    A, b = P - Pm, y - ym - (P - Pm) @ eq
    lam = lam_per_row * len(y)
    d = np.linalg.solve(A.T @ A + lam * np.eye(k), A.T @ b)
    w = eq + d
    return w, float(ym - Pm @ w)


STACKERS = {
    'mean': None, 'median': None, 'inverse_mse': w_inverse_mse, 'nnls_free': w_nnls,
    'sum_to_one_nonneg': w_sum_to_one, 'ridge_to_equal': w_ridge_to_equal,
}


def stack(OOF, X, comps, method, seasons=None):
    """Ensemble prediction per season from OOF components of EARLIER seasons."""
    D = OOF.merge(X[['game_id', 'margin', 'status', 'fcs_game']], on='game_id', how='left')
    D.index = OOF.index
    seasons = seasons or sorted(D.season.unique())
    pred = pd.Series(np.nan, index=D.index)
    weights = {}
    cols = ['pred_' + c for c in comps]
    for S in seasons:
        cur = D.season.eq(S)
        if method == 'mean':
            pred[cur] = D.loc[cur, cols].mean(axis=1)
            weights[S] = dict(zip(comps, [1.0 / len(comps)] * len(comps)))
            continue
        if method == 'median':
            pred[cur] = D.loc[cur, cols].median(axis=1)
            weights[S] = None
            continue
        past = D[(D.season < S) & (D.season >= C.FIRST_OOF_SEASON) & ~D.fcs_game.astype(bool)
                 & D.status.eq('FINAL') & D.margin.notna()].dropna(subset=cols)
        if past.season.nunique() < 2:
            continue
        past_only(sorted(past.season.unique()), S)
        w, b0 = STACKERS[method](past[cols].values, past.margin.values.astype(float))
        weights[S] = dict(zip(comps, [float(x) for x in w]), intercept=float(b0))
        pred[cur] = D.loc[cur, cols].values @ w + b0
    return pred, weights


# ---------------------------------------------------------- error model
UNC_COLS = ['early_season', 'inv_games', 'rating_sd_sum', 'ens_sd', 'abs_pred', 'exp_total_z',
            'fcs_game_f', 'qb_missing_any', 'qb_unsettled_any', 'vol_sum', 'to_dependence']


def unc_design(D, fill):
    Z = pd.DataFrame(index=D.index)
    Z['early_season'] = D.early_season.astype(float)
    Z['inv_games'] = 1.0 / (1.0 + D.min_games.fillna(0))
    Z['rating_sd_sum'] = D.rating_sd_sum.fillna(fill['rating_sd_sum'])
    Z['ens_sd'] = D.ens_sd
    Z['abs_pred'] = np.abs(D.pred) / 10.0
    Z['exp_total_z'] = (D.pred_total - 55.0) / 10.0
    Z['fcs_game_f'] = D.fcs_game.astype(float)
    Z['qb_missing_any'] = D.qb_missing_any.fillna(1.0)
    Z['qb_unsettled_any'] = D.qb_unsettled_any.fillna(0.0)
    Z['vol_sum'] = D.vol_sum.fillna(fill['vol_sum'])
    Z['to_dependence'] = D.to_dependence.fillna(fill['to_dependence'])
    return Z[UNC_COLS]


class GammaSigma:
    """E[r^2] = exp(Z b), Gamma deviance with a log link, fitted by Newton steps
    on the penalised deviance (a different solver from walkforward.SigmaModel)."""

    def fit(self, D, r, lam=1.0):
        self.fill = {c: float(D[c].median()) for c in ('rating_sd_sum', 'vol_sum', 'to_dependence')}
        Z = unc_design(D, self.fill)
        self.mu, self.sd = Z.mean(), Z.std().replace(0, 1.0)
        A = np.column_stack([np.ones(len(Z)), ((Z - self.mu) / self.sd).values])
        y = r ** 2 + 0.25
        b = np.zeros(A.shape[1]); b[0] = np.log(y.mean())
        P = np.eye(A.shape[1]) * lam; P[0, 0] = 0.0

        def obj(bb):                                   # penalised Gamma deviance / 2
            eta = A @ bb
            return float(np.sum(y * np.exp(-eta) + eta) + 0.5 * bb @ P @ bb)
        f0 = obj(b)
        for _ in range(200):
            m = np.exp(A @ b)
            g = A.T @ (1 - y / m) + P @ b              # gradient
            H = A.T @ (A * (y / m)[:, None]) + P       # observed Hessian
            step = np.linalg.solve(H, g)
            t = 1.0
            while t > 1e-6:                            # damped Newton: never increase the objective
                f1 = obj(b - t * step)
                if np.isfinite(f1) and f1 <= f0:
                    break
                t *= 0.5
            b = b - t * step
            f0 = obj(b)
            if np.max(np.abs(t * step)) < 1e-10:
                break
        self.b = b
        return self

    def predict(self, D):
        Z = unc_design(D, self.fill)
        A = np.column_stack([np.ones(len(Z)), ((Z - self.mu) / self.sd).values])
        return np.sqrt(np.exp(A @ self.b))


def t_df_mle(z):
    best = None
    for df in (3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30, 50, 100):
        s = np.sqrt((df - 2) / df)
        ll = np.sum(stats.t.logpdf(z / s, df) - np.log(s))
        if best is None or ll > best[1]:
            best = (df, ll)
    return best[0]


def tcdf(x, df):
    return stats.t.cdf(x / np.sqrt((df - 2) / df), df)


# ----------------------------------------------------------- calibrators
def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


class PlattCal:
    name = 'platt'

    def fit(self, p, y):
        from sklearn.linear_model import LogisticRegression
        self.m = LogisticRegression(C=1e4).fit(logit(p)[:, None], y)
        return self

    def predict(self, p):
        return self.m.predict_proba(logit(p)[:, None])[:, 1]


class IsoCal:
    name = 'isotonic'

    def fit(self, p, y):
        from sklearn.isotonic import IsotonicRegression
        self.m = IsotonicRegression(y_min=0.005, y_max=0.995, out_of_bounds='clip').fit(p, y)
        return self

    def predict(self, p):
        return self.m.predict(p)


class BetaCal:
    """Beta calibration (Kull et al. 2017): logistic on [ln p, -ln(1-p)]."""
    name = 'beta'

    def fit(self, p, y):
        from sklearn.linear_model import LogisticRegression
        p = np.clip(p, 1e-4, 1 - 1e-4)
        self.m = LogisticRegression(C=1e4).fit(np.column_stack([np.log(p), -np.log(1 - p)]), y)
        return self

    def predict(self, p):
        p = np.clip(p, 1e-4, 1 - 1e-4)
        return self.m.predict_proba(np.column_stack([np.log(p), -np.log(1 - p)]))[:, 1]


class RawCal:
    name = 'raw'

    def fit(self, p, y):
        return self

    def predict(self, p):
        return p


CALIBRATORS = (RawCal, PlattCal, IsoCal, BetaCal)


def uncertainty_and_probs(D, pred_col='pred', min_train=500):
    """Walk-forward error model + win probabilities (raw / platt / isotonic / beta)
    + conformal-t intervals, for the prediction column `pred_col`."""
    D = D.copy()
    D['pred'] = D[pred_col]
    for c in ('sigma', 't_df') + tuple('p_win_' + k.name for k in CALIBRATORS):
        D[c] = np.nan
    for q in C.INTERVALS:
        D['lo_%d' % int(q * 100)] = np.nan
        D['hi_%d' % int(q * 100)] = np.nan
    info = {}
    for S in sorted(D.season.unique()):
        # candidate 001's specification: the error model is fit on every FINAL
        # game with a prediction, FBS-vs-FCS included (it carries an FCS flag)
        past = D[(D.season < S) & D.pred.notna() & D.status.eq('FINAL') & D.margin.notna()]
        if len(past) < min_train:
            continue
        past_only(sorted(past.season.unique()), S)
        r = (past.margin - past.pred).values
        sm = GammaSigma().fit(past, r)
        sp = sm.predict(past)
        z = r / sp
        df = t_df_mle(z)
        qs = {q: float(np.quantile(np.abs(z), q)) for q in C.INTERVALS}
        praw_past = 1 - tcdf(-past.pred.values / sp, df)
        yw = (past.margin.values > 0).astype(float)
        cals = [k().fit(praw_past, yw) for k in CALIBRATORS]
        cur = D.season.eq(S) & D.pred.notna()
        sg = sm.predict(D[cur])
        pr = 1 - tcdf(-D.loc[cur, 'pred'].values / sg, df)
        D.loc[cur, 'sigma'] = sg
        D.loc[cur, 't_df'] = df
        for cal in cals:
            D.loc[cur, 'p_win_' + cal.name] = cal.predict(pr)
        for q in C.INTERVALS:
            D.loc[cur, 'lo_%d' % int(q * 100)] = D.loc[cur, 'pred'].values - qs[q] * sg
            D.loc[cur, 'hi_%d' % int(q * 100)] = D.loc[cur, 'pred'].values + qs[q] * sg
        info[S] = {'t_df': int(df), 'abs_z_q': qs, 'n_train': int(len(past)),
                   'sigma_coef': dict(zip(['intercept'] + UNC_COLS, [float(x) for x in sm.b]))}
    return D, info


# ------------------------------------------------------------- one call
def run(X, spec, comps=None, method='sum_to_one_nonneg', seasons=None, probs=True, keep_models=False,
        verbose=False):
    """Components -> stack -> (optionally) error model + probabilities."""
    # a component whose every input was ablated away drops out of the stack
    comps = [c for c in (comps or COMPONENTS) if spec.cols(c[0])]
    OOF, ins, models = run_components(X, spec, seasons, keep_models=keep_models, verbose=verbose)
    pred, W = stack(OOF, X, comps, method)
    cols = ['game_id', 'season', 'week', 'status', 'margin', 'total_pts', 'fcs_game', 'neutral_site',
            'early_season', 'min_games', 'rating_sd_sum', 'qb_missing_any', 'qb_unsettled_any', 'vol_sum',
            'to_dependence', 'weeks_in', 'is_postseason', 'home_conference', 'away_conference', 'home_id',
            'away_id', 'kickoff_ts', 'prediction_ts', 'home_fbs']
    D = OOF.merge(X[[c for c in cols if c not in ('season',) and c in X.columns]], on='game_id', how='left')
    D.index = OOF.index
    D['pred'] = pred
    D['ens_sd'] = D[['pred_' + c for c in COMPONENTS]].std(axis=1)
    if probs:
        D, info = uncertainty_and_probs(D)
        from . import reliability as REL
        D, _ = REL.attach(D, sorted(D.season.unique()))
    else:
        info = {}
    return {'D': D, 'weights': W, 'insample': ins, 'models': models, 'unc': info, 'spec': spec,
            'comps': comps, 'method': method}
