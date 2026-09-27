"""Stage 7 — strict walk-forward: submodels -> stack -> uncertainty -> calibration.

For every target season S:
  1. each submodel is fit on FBS-vs-FBS FINAL snapshot rows with season < S
     and predicts every game of S (frozen features, as of each game's freeze);
  2. the stacker's weights are fit on OUT-OF-FOLD submodel predictions of
     seasons < S only (non-negative, summing to one — SLSQP);
  3. the error model (sigma), the standardized-residual distribution, the
     conformal interval quantiles and the probability calibrators are fit on
     stacked OUT-OF-FOLD residuals of seasons < S only.

No random split exists anywhere. `assert_past_only` guards every fit.
"""
import numpy as np
import pandas as pd
from scipy import optimize, stats

from . import config as C
from . import common
from . import models as MD

SUB = ['A_adj_eff', 'B_elo', 'C_ridge', 'D_gbm', 'E_drive']
SIGMA_COLS = ['early_season', 'inv_games', 'rating_sd_sum', 'ens_sd', 'abs_pred', 'exp_total_z',
              'fcs_game_f', 'qb_missing_any', 'qb_unsettled_any', 'vol_sum', 'to_dependence']
# Missing-value fills for the error model are LEARNED ON THE TRAINING ROWS and
# stored with the model. (Candidate 001 filled with the median of whatever
# batch was being predicted, i.e. a whole season including its later weeks —
# found by tests_poison.row_independence.)
SIGMA_FILL_COLS = ('rating_sd_sum', 'vol_sum', 'to_dependence')


def assert_past_only(train_seasons, S):
    assert len(train_seasons) and max(train_seasons) < S, 'future season in a training set'


def modeling_rows(X):
    return X[(~X.fcs_game) & X.status.eq('FINAL') & X.margin.notna()]


# ------------------------------------------------------------ submodels
def fit_submodels(X, S, fam_C=None, fam_D=None, gbm_params=None, ridge_alpha=None, keep=False):
    tr = modeling_rows(X)
    tr = tr[(tr.season < S) & (tr.season >= C.FIRST_SNAPSHOT_SEASON)]
    assert_past_only(sorted(tr.season.unique()), S)
    y = tr.margin.values.astype(float)
    ms = {
        'A_adj_eff': MD.ModelA(), 'B_elo': MD.ModelB(), 'E_drive': MD.ModelE(),
        'C_ridge': MD.ModelC(fam_C, alpha=ridge_alpha),
        'D_gbm': MD.ModelD(fam_D, params=gbm_params),
    }
    for k, m in ms.items():
        m.fit(tr, y)
    tot = MD.TotalE().fit(tr, tr.total_pts.values.astype(float))
    return ms, tot


def predict_submodels(ms, tot, Xs):
    P = pd.DataFrame(index=Xs.index)
    for k, m in ms.items():
        P['pred_' + k] = m.predict(Xs)
    P['pred_total'] = tot.predict(Xs)
    return P


# ------------------------------------------------------------- stacking
def stack_weights(P, y):
    """min ||y - P w||^2  s.t. w >= 0, sum w = 1."""
    k = P.shape[1]
    fun = lambda w: np.mean((y - P @ w) ** 2)
    res = optimize.minimize(fun, np.full(k, 1.0 / k), method='SLSQP',
                            bounds=[(0, 1)] * k,
                            constraints=[{'type': 'eq', 'fun': lambda w: np.sum(w) - 1.0}],
                            options={'ftol': 1e-10, 'maxiter': 500})
    return res.x


# ---------------------------------------------------------- uncertainty
def sigma_design(D, fill=None):
    if fill is None:                       # artifacts older than the fix carry no fills
        fill = {c: D[c].median() for c in SIGMA_FILL_COLS}
    Z = pd.DataFrame(index=D.index)
    Z['early_season'] = D.early_season.astype(float)
    Z['inv_games'] = 1.0 / (1.0 + D.min_games.fillna(0))
    Z['rating_sd_sum'] = D.rating_sd_sum.fillna(fill['rating_sd_sum'])
    Z['ens_sd'] = D.ens_sd
    Z['abs_pred'] = np.abs(D.ens_pred) / 10.0
    Z['exp_total_z'] = (D.pred_total - 55.0) / 10.0
    Z['fcs_game_f'] = D.fcs_game.astype(float)
    Z['qb_missing_any'] = D.qb_missing_any.fillna(1.0)
    Z['qb_unsettled_any'] = D.qb_unsettled_any.fillna(0.0)
    Z['vol_sum'] = D.vol_sum.fillna(fill['vol_sum'])
    Z['to_dependence'] = D.to_dependence.fillna(fill['to_dependence'])
    return Z[SIGMA_COLS]


class SigmaModel:
    """E[r^2] = exp(X b): Gamma GLM with log link (IRLS), ridge-stabilised."""

    def fit(self, D, r):
        self.fill_ = {c: float(D[c].median()) for c in SIGMA_FILL_COLS}
        Z = sigma_design(D, self.fill_)
        self.mu_, self.sd_ = Z.mean(), Z.std().replace(0, 1.0)
        A = np.column_stack([np.ones(len(Z)), ((Z - self.mu_) / self.sd_).values])
        yv = r ** 2 + 0.25
        b = np.zeros(A.shape[1]); b[0] = np.log(np.mean(yv))
        lam = 1.0
        for _ in range(50):
            eta = A @ b
            mu = np.exp(eta)
            # Gamma IRLS: working response z = eta + (y - mu)/mu, weights 1
            z = eta + (yv - mu) / mu
            P = np.eye(A.shape[1]) * lam; P[0, 0] = 0
            b_new = np.linalg.solve(A.T @ A + P, A.T @ z)
            if np.max(np.abs(b_new - b)) < 1e-8:
                b = b_new; break
            b = b_new
        self.b_ = b
        return self

    def predict(self, D):
        Z = sigma_design(D, self.fill_)
        A = np.column_stack([np.ones(len(Z)), ((Z - self.mu_) / self.sd_).values])
        return np.sqrt(np.exp(A @ self.b_))

    def coef(self):
        return dict(zip(['intercept'] + SIGMA_COLS, [float(x) for x in self.b_]))


def fit_t_df(z):
    best = None
    for df in (3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100):
        s = np.sqrt((df - 2) / df)
        ll = np.sum(stats.t.logpdf(z / s, df) - np.log(s))
        if best is None or ll > best[1]:
            best = (df, ll)
    return best[0]


def t_cdf(x, df):
    s = np.sqrt((df - 2) / df)
    return stats.t.cdf(x / s, df)


# ---------------------------------------------------------- calibrators
class Platt:
    def fit(self, p, y):
        x = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
        f = lambda ab: np.sum(np.logaddexp(0, -(2 * y - 1) * (ab[0] + ab[1] * x))) + 1e-3 * ab[1] ** 2
        self.ab_ = optimize.minimize(f, [0.0, 1.0], method='BFGS').x
        return self

    def predict(self, p):
        x = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
        return 1.0 / (1.0 + np.exp(-(self.ab_[0] + self.ab_[1] * x)))


class Iso:
    def fit(self, p, y):
        from sklearn.isotonic import IsotonicRegression
        self.m_ = IsotonicRegression(y_min=0.005, y_max=0.995, out_of_bounds='clip').fit(p, y)
        return self

    def predict(self, p):
        return self.m_.predict(p)


# ------------------------------------------------------------------ run
def run(X, seasons=None, fam_C=None, fam_D=None, gbm_params=None, ridge_alpha=None,
        subset=None, verbose=True):
    X = MD.add_derived(X)
    seasons = seasons or list(range(C.FIRST_OOF_SEASON, C.LIVE_SEASON + 1))
    subset = subset or SUB
    out, fitted = [], {}
    for S in seasons:
        ms, tot = fit_submodels(X, S, fam_C, fam_D, gbm_params, ridge_alpha)
        Xs = X[X.season.eq(S)]
        P = predict_submodels(ms, tot, Xs)
        out.append(pd.concat([Xs[['game_id', 'season']], P], axis=1))
        fitted[S] = (ms, tot)
        if verbose:
            print('[wf] submodels season %d: %d rows' % (S, len(Xs)))
    OOF = pd.concat(out)
    D = X.loc[OOF.index].join(OOF.drop(columns=['game_id', 'season']))
    pcols = ['pred_' + k for k in subset]
    D['ens_sd'] = D[['pred_' + k for k in SUB]].std(axis=1)
    D['ens_range'] = D[['pred_' + k for k in SUB]].max(axis=1) - D[['pred_' + k for k in SUB]].min(axis=1)
    D['ens_equal'] = D[pcols].mean(axis=1)
    # ---- stacking, strictly OOF
    W = {}
    D['ens_pred'] = np.nan
    for S in seasons:
        past = D[(D.season < S) & D.season.ge(C.FIRST_OOF_SEASON)]
        past = modeling_rows(past)
        if past.season.nunique() < 2:
            continue
        assert_past_only(sorted(past.season.unique()), S)
        w = stack_weights(past[pcols].values, past.margin.values.astype(float))
        W[S] = dict(zip(subset, [float(x) for x in w]))
        m = D.season.eq(S)
        D.loc[m, 'ens_pred'] = D.loc[m, pcols].values @ w
    # ---- uncertainty + calibration, strictly OOF
    D['sigma'] = np.nan
    D['p_home_raw'] = np.nan
    D['p_home_platt'] = np.nan
    D['p_home_iso'] = np.nan
    for q in C.INTERVALS:
        D['lo_%d' % int(q * 100)] = np.nan
        D['hi_%d' % int(q * 100)] = np.nan
    unc = {}
    for S in seasons:
        past = D[(D.season < S) & D.ens_pred.notna() & D.status.eq('FINAL') & D.margin.notna()]
        if past.season.nunique() < 1 or len(past) < 500:
            continue
        assert_past_only(sorted(past.season.unique()), S)
        r = (past.margin - past.ens_pred).values
        sm = SigmaModel().fit(past, r)
        sp = sm.predict(past)
        z = r / sp
        df = fit_t_df(z)
        qs = {q: float(np.quantile(np.abs(z), q)) for q in C.INTERVALS}
        # raw win prob via the fitted t, then calibrators on past rows
        p_raw_past = 1.0 - t_cdf(-past.ens_pred.values / sp, df)
        yw = (past.margin.values > 0).astype(float)
        platt = Platt().fit(p_raw_past, yw)
        iso = Iso().fit(p_raw_past, yw)
        m = D.season.eq(S) & D.ens_pred.notna()
        cur = D[m]
        sg = sm.predict(cur)
        D.loc[m, 'sigma'] = sg
        pr = 1.0 - t_cdf(-cur.ens_pred.values / sg, df)
        D.loc[m, 'p_home_raw'] = pr
        D.loc[m, 'p_home_platt'] = platt.predict(pr)
        D.loc[m, 'p_home_iso'] = iso.predict(pr)
        for q in C.INTERVALS:
            D.loc[m, 'lo_%d' % int(q * 100)] = cur.ens_pred.values - qs[q] * sg
            D.loc[m, 'hi_%d' % int(q * 100)] = cur.ens_pred.values + qs[q] * sg
        unc[S] = {'sigma_coef': sm.coef(), 'sigma_mu': {k: float(v) for k, v in sm.mu_.items()},
                  'sigma_sd': {k: float(v) for k, v in sm.sd_.items()},
                  'sigma_fill': dict(sm.fill_),
                  't_df': int(df), 'abs_z_quantiles': qs,
                  'platt': [float(x) for x in platt.ab_],
                  'iso_x': [float(x) for x in iso.m_.X_thresholds_],
                  'iso_y': [float(x) for x in iso.m_.y_thresholds_], 'n_train': int(len(past))}
    return D, W, unc, fitted
