"""Walk-forward calibration fitters. Every fitter returns a PORTABLE spec (the
artifact schema of reference.py: knots and coefficients, never a pickle), and
every prediction goes through the same math the reference applies.

Guards (asserted on every fit):
  * fit rows are DEV seasons only (config.assert_dev_only): the holdout and
    live seasons can never reach a fitter;
  * walk-forward: the rows that fit season S's map are from seasons < S.

Probability maps operate on the SIDE-ORIENTED probability (the side the pure
model prefers, p >= 0.5). decision.js applies one map to each side's
probability, so a decision map must be SIDE-SYMMETRIC: f(1 - p) = 1 - f(p),
hence f(0.5) = 0.5. The symmetric family: market (w = 0), identity, shrink
(sigmoid(w logit p)), a symmetric logit-piecewise-linear spline and a
symmetric (reflected) isotonic map. Platt with an intercept and the 3-parameter
beta map are fitted and scored as DIAGNOSTICS of whether an asymmetric shape or
a side-level intercept is supported; they are not eligible decision maps.
"""
import math

import numpy as np
from scipy import optimize

from .. import config as C
from . import core
from . import reference as REF

PWL_KNOTS_P = (0.5, 0.52, 0.55, 0.60, 0.70, 0.85)
PWL_LAMBDA = 5.0                  # smoothness penalty on second differences of the knot values (declared)
RIDGE_MODEL = 1.0                 # L2 on standardized coefficients of the interpretable models (declared)


# ------------------------------------------------------------------ guards
def assert_fit_rows(df):
    seasons = sorted(int(s) for s in set(df.season))
    C.assert_dev_only(seasons)
    assert set(df.window) <= {'dev'}, 'a non-DEV row reached a fitter'
    return seasons


def assert_past_only(train_seasons, S):
    assert len(train_seasons) and max(train_seasons) < S, 'future season in a training set'


def walk_forward(df, scored_seasons, fit_fn, pred_fn, min_train=300):
    """{S: predictions for season S} with every model fit on seasons < S (DEV only)."""
    out, fits = {}, {}
    for S in scored_seasons:
        tr = df[df.season < S]
        if len(tr) < min_train:
            continue
        assert_past_only(assert_fit_rows(tr), S)
        m = fit_fn(tr)
        cur = df[df.season == S]
        out[S] = pred_fn(m, cur)
        fits[S] = m
    return out, fits


# --------------------------------------------------------------- map math
def interp_np(xs, ys, v):
    return np.interp(np.asarray(v, float), np.asarray(xs, float), np.asarray(ys, float))


def apply_map_np(spec, p):
    """Vectorized twin of reference.apply_map (tests assert they agree)."""
    p = np.asarray(p, dtype=float)
    m = (spec or {}).get('method', 'identity')
    if m == 'identity':
        return p.copy()
    if m == 'platt':
        return core.sigmoid(spec['a'] + spec['b'] * core.logit(p))
    if m == 'beta':
        q = core.clip_p(p)
        return core.sigmoid(spec['c'] + spec['a'] * np.log(q) - spec['b'] * np.log(1 - q))
    if m == 'isotonic':
        return np.clip(interp_np(spec['x'], spec['y'], p), 1e-4, 1 - 1e-4)
    if m == 'logit_pwl':
        return core.sigmoid(interp_np(spec['x'], spec['y'], core.logit(p)))
    raise ValueError(m)


def shrink_np(p_cal, p_mkt, w):
    return core.sigmoid(w * core.logit(p_cal) + (1 - w) * core.logit(p_mkt))


def nll(z, y):
    z = np.asarray(z, float)
    return float(np.sum(np.logaddexp(0.0, z) - y * z))


# ----------------------------------------------------------------- fitters
def fit_shrink(p, y, p_mkt=0.5, bounded=True):
    """w in logit p_dec = w logit p + (1 - w) logit p_mkt (the logit-space
    mixture of the model and the market). Bounded MLE on [0, 1]; the unbounded
    MLE and its profile-likelihood 95% interval are returned for reporting."""
    x = core.logit(p)
    o = core.logit(np.broadcast_to(p_mkt, np.shape(p)))
    f = lambda w: nll(w * x + (1 - w) * o, y)
    wb = optimize.minimize_scalar(f, bounds=(0.0, 1.0), method='bounded', options={'xatol': 1e-7}).x
    wu = optimize.minimize_scalar(f, bounds=(-2.0, 4.0), method='bounded', options={'xatol': 1e-7}).x
    lmin = f(wu)
    g = lambda w: f(w) - lmin - 1.920729                  # chi2(1) 95% / 2
    lo = hi = None
    for step in (0.25, 0.5, 1.0, 2.0, 4.0):
        if lo is None and g(wu - step) > 0:
            lo = optimize.brentq(g, wu - step, wu, xtol=1e-7)
        if hi is None and g(wu + step) > 0:
            hi = optimize.brentq(g, wu, wu + step, xtol=1e-7)
    return {'w': float(np.clip(wb, 0, 1)) if bounded else float(wu), 'w_unbounded': float(wu),
            'w_ci95_profile': [float(lo) if lo is not None else None, float(hi) if hi is not None else None],
            'lr_w0': float(2 * (f(0.0) - lmin)), 'lr_w1': float(2 * (f(1.0) - lmin)), 'n': int(len(y))}


def fit_platt(p, y):
    x = core.logit(p)
    f = lambda ab: nll(ab[0] + ab[1] * x, y) + 1e-6 * (ab[0] ** 2 + ab[1] ** 2)
    ab = optimize.minimize(f, [0.0, 1.0], method='L-BFGS-B').x
    return {'method': 'platt', 'a': float(ab[0]), 'b': float(ab[1])}


def fit_beta(p, y):
    q = core.clip_p(p)
    lp, lq = np.log(q), np.log(1 - q)
    f = lambda v: nll(v[2] + v[0] * lp - v[1] * lq, y) + 1e-6 * np.sum(v ** 2)
    v = optimize.minimize(f, [1.0, 1.0, 0.0], method='L-BFGS-B',
                          bounds=[(0, None), (0, None), (None, None)]).x
    return {'method': 'beta', 'a': float(v[0]), 'b': float(v[1]), 'c': float(v[2])}


def _hat_basis(x, knots):
    """Linear-interpolation weights (n x K), clamped at the end knots."""
    x = np.clip(np.asarray(x, float), knots[0], knots[-1])
    K = len(knots)
    B = np.zeros((len(x), K))
    idx = np.clip(np.searchsorted(knots, x, side='right') - 1, 0, K - 2)
    lo, hi = knots[idx], knots[idx + 1]
    t = (x - lo) / (hi - lo)
    B[np.arange(len(x)), idx] = 1 - t
    B[np.arange(len(x)), idx + 1] = t
    return B


def fit_logit_pwl(p, y, knots_p=PWL_KNOTS_P, lam=PWL_LAMBDA):
    """Symmetric piecewise-linear map in logit space: the value at logit 0 is
    fixed at 0 (f(0.5) = 0.5), free values at the other knots, a smoothness
    penalty on second differences; exported mirrored over [-x_K, x_K]."""
    kx = core.logit(np.asarray(knots_p))
    kx[0] = 0.0
    B = _hat_basis(core.logit(p), kx)[:, 1:]            # value at knot 0 is pinned to 0
    K = B.shape[1]
    D = np.diff(np.eye(K + 1), n=2, axis=0)[:, 1:]       # second differences incl. the pinned 0

    def f(v):
        z = B @ v
        pen = lam * np.sum((D @ v) ** 2)
        return nll(z, y) + pen

    def g(v):
        z = B @ v
        return B.T @ (core.sigmoid(z) - y) + 2 * lam * D.T @ (D @ v)

    v0 = kx[1:].copy()
    v = optimize.minimize(f, v0, jac=g, method='L-BFGS-B').x
    xs = list(-kx[:0:-1]) + list(kx)
    ys = list(-v[::-1]) + [0.0] + list(v)
    return {'method': 'logit_pwl', 'x': [float(a) for a in xs], 'y': [float(b) for b in ys]}


def fit_isotonic_symmetric(p, y):
    """Isotonic on the side-oriented probability, reflected so f(1-p) = 1 - f(p)."""
    from sklearn.isotonic import IsotonicRegression
    m = IsotonicRegression(increasing=True, y_min=1e-3, y_max=1 - 1e-3, out_of_bounds='clip').fit(p, y)
    x, v = np.asarray(m.X_thresholds_, float), np.asarray(m.y_thresholds_, float)
    keep = x > 0.5
    x, v = x[keep], v[keep]
    xs = list(1 - x[::-1]) + list(x)
    ys = list(1 - v[::-1]) + list(v)
    return {'method': 'isotonic', 'x': [float(a) for a in xs], 'y': [float(b) for b in ys]}


def fit_isotonic_fold(p, y):
    """Isotonic on the fold as fitted (diagnostic; f(0.5) may differ from 0.5)."""
    from sklearn.isotonic import IsotonicRegression
    m = IsotonicRegression(increasing=True, y_min=1e-3, y_max=1 - 1e-3, out_of_bounds='clip').fit(p, y)
    return {'method': 'isotonic', 'x': [float(a) for a in m.X_thresholds_], 'y': [float(b) for b in m.y_thresholds_]}


def symmetric_shrink_map(w):
    """The shrink candidate as a portable map: platt with a = 0, b = w."""
    return {'method': 'platt', 'a': 0.0, 'b': float(w)}


# --------------------------------------------------- interpretable models
def fit_model(df, features, target, kind='logistic', l2=RIDGE_MODEL, fill=None, weights=None):
    """Standardized ridge linear/logistic model in the artifact's model schema.
    mu/sd and missing-value fills are learned on the TRAINING rows."""
    X = df[features].astype(float)
    fill = fill or {k: float(X[k].mean()) for k in features}
    X = X.fillna(fill)
    mu = {k: float(X[k].mean()) for k in features}
    sd = {k: float(X[k].std(ddof=0)) or 1.0 for k in features}
    Z = np.column_stack([(X[k].values - mu[k]) / sd[k] for k in features]) if features else np.zeros((len(df), 0))
    y = df[target].astype(float).values
    A = np.column_stack([np.ones(len(y)), Z])
    P = np.eye(A.shape[1]) * l2
    P[0, 0] = 0.0
    if kind == 'linear':
        b = np.linalg.solve(A.T @ A + P, A.T @ y)
    else:
        f = lambda b: nll(A @ b, y) + 0.5 * b @ P @ b
        gr = lambda b: A.T @ (core.sigmoid(A @ b) - y) + P @ b
        b0 = np.zeros(A.shape[1])
        b0[0] = core.logit(np.clip(y.mean(), 0.01, 0.99))
        b = optimize.minimize(f, b0, jac=gr, method='L-BFGS-B').x
    return {'type': kind, 'target': target, 'intercept': float(b[0]),
            'coef': {k: float(v) for k, v in zip(features, b[1:])},
            'mu': mu, 'sd': sd, 'fill': fill, 'n_train': int(len(y)), 'l2': l2}


def eval_model_np(spec, df):
    """Vectorized twin of reference.eval_model."""
    z = np.full(len(df), float(spec['intercept']))
    for k, c in spec['coef'].items():
        x = df[k].astype(float).values if k in df else np.full(len(df), np.nan)
        x = np.where(np.isfinite(x), x, spec['fill'].get(k, np.nan))
        z = z + c * (x - spec['mu'].get(k, 0.0)) / (spec['sd'].get(k, 1.0) or 1.0)
    return core.sigmoid(z) if spec['type'] == 'logistic' else z


# --------------------------------------------------- tests of structure
def lr_test(ll_small, ll_big, df):
    from scipy import stats
    stat = 2 * (ll_small - ll_big)                     # ll are NEGATIVE log likelihoods
    return {'lr': float(stat), 'df': int(df), 'p': float(stats.chi2.sf(max(stat, 0.0), df))}


def fit_group_shrink(p, y, groups, p_mkt=0.5):
    """One shrink weight per group (no intercepts): the conditional-calibration
    alternative to a single weight."""
    ws, total = {}, 0.0
    for g in sorted(set(groups)):
        m = groups == g
        r = fit_shrink(p[m], y[m], p_mkt, bounded=False)
        ws[g] = r['w_unbounded']
        total += nll(ws[g] * core.logit(p[m]), y[m])
    return ws, total


# ------------------------------------------------ empirical Bayes shrinkage
def eb_normal(means, ses, prior=None, weights=None):
    """Normal-normal empirical Bayes: tau^2 by the method of moments.
    Returns (shrunk means, tau^2, prior mean)."""
    m = np.asarray(means, float)
    s2 = np.asarray(ses, float) ** 2
    ok = np.isfinite(m) & np.isfinite(s2)
    if ok.sum() < 2:
        return list(m), None, prior
    w = np.asarray(weights, float)[ok] if weights is not None else 1 / s2[ok]
    m0 = float(np.sum(w * m[ok]) / np.sum(w)) if prior is None else float(prior)
    tau2 = max(0.0, float(np.mean((m[ok] - m0) ** 2) - np.mean(s2[ok])))
    shr = np.where(ok, m0 + tau2 / (tau2 + s2) * (m - m0) if tau2 > 0 else m0, np.nan)
    return [float(v) for v in shr], tau2, m0


def eb_beta_binomial(k, n, p0=None):
    """Beta-binomial empirical Bayes: prior Beta(kappa p0, kappa (1-p0)) with
    kappa by maximum marginal likelihood (1 .. 1e6). A homogeneous table gives
    kappa -> 1e6 (complete pooling)."""
    from scipy.special import betaln
    k, n = np.asarray(k, float), np.asarray(n, float)
    ok = n > 0
    if ok.sum() < 2:
        return list(k / np.maximum(n, 1)), None, p0
    p0 = float(k[ok].sum() / n[ok].sum()) if p0 is None else float(p0)

    def negml(lk):
        kap = math.exp(lk)
        a, b = kap * p0, kap * (1 - p0)
        return -float(np.sum(betaln(k[ok] + a, n[ok] - k[ok] + b) - betaln(a, b)))

    r = optimize.minimize_scalar(negml, bounds=(0.0, math.log(1e6)), method='bounded')
    kap = math.exp(r.x)
    shr = (k + kap * p0) / (n + kap)
    return [float(v) if nn > 0 else None for v, nn in zip(shr, n)], float(kap), p0


# --------------------------------------------------------- the EV curve
EV_EDGES = (-np.inf, 0.0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.25, np.inf)


def fit_ev_curve(ev, realized, push, price=core.ASSUMED_PRICE, edges=EV_EDGES):
    """Theoretical EV -> expected realized EV, heavily shrunk:
      1. bin the training rows by EV (fixed, declared edges);
      2. per bin: mean realized units and its SE;
      3. normal-normal empirical Bayes toward the NO-SKILL value of each bin
         (a fair coin at the price with the bin's push rate: 0.5 (1-push) b - 0.5 (1-push));
      4. pool-adjacent-violators so the curve never decreases;
      5. knots at the bins' mean EV, linear interpolation, clamped."""
    ev, realized, push = (np.asarray(v, float) for v in (ev, realized, push))
    ok = np.isfinite(ev) & np.isfinite(realized)
    ev, realized, push = ev[ok], realized[ok], np.nan_to_num(push[ok])
    b = core.american_to_payout(price)
    xs, ms, ses, nulls, ns = [], [], [], [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        s = (ev >= lo) & (ev < hi)
        if s.sum() < 30:
            continue
        xs.append(float(ev[s].mean()))
        ms.append(float(realized[s].mean()))
        ses.append(float(realized[s].std(ddof=1) / math.sqrt(s.sum())))
        pp = float(push[s].mean())
        nulls.append(0.5 * (1 - pp) * b - 0.5 * (1 - pp))
        ns.append(int(s.sum()))
    ms_a, ses_a, nulls_a = np.array(ms), np.array(ses), np.array(nulls)
    dev = ms_a - nulls_a
    tau2 = max(0.0, float(np.mean(dev ** 2) - np.mean(ses_a ** 2)))
    shr = nulls_a + (tau2 / (tau2 + ses_a ** 2)) * dev if tau2 > 0 else nulls_a.copy()
    from sklearn.isotonic import IsotonicRegression
    y = IsotonicRegression(increasing=True).fit(xs, shr, sample_weight=ns).predict(xs)
    return {'input': 'theoretical_ev', 'x': xs, 'y': [float(v) for v in y],
            'bins': [{'x': x, 'n': n, 'realized': m, 'se': s, 'null': nu, 'eb': float(e)}
                     for x, n, m, s, nu, e in zip(xs, ns, ms, ses, nulls, shr)],
            'tau2': tau2, 'price': price,
            'method': 'binned realized units, normal-normal EB toward the no-skill value of each bin, then PAV (non-decreasing)'}


def spearman_perm(x, y, n_perm=20000, seed=None):
    """Spearman rho of two short sequences and a two-sided permutation p-value."""
    from scipy import stats
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 4:
        return {'rho': None, 'p': None}
    rho = float(stats.spearmanr(x, y).statistic)
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    ry = stats.rankdata(y)
    rx = stats.rankdata(x)
    rx = (rx - rx.mean()) / rx.std()
    perm = np.array([np.corrcoef(rx, rng.permutation(ry))[0, 1] for _ in range(n_perm)])
    return {'rho': rho, 'p': float(np.mean(np.abs(perm) >= abs(rho) - 1e-12))}


# ------------------------------------------------ vectorized parity helper
def apply_reference(spec, p):
    """reference.apply_map row by row (used by tests to check apply_map_np)."""
    return np.array([REF.apply_map(spec, float(v)) for v in np.asarray(p, float)])
