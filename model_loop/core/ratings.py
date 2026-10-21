"""Penalized weighted least squares with an explicit prior: the one rating
fit every adapter uses.

    minimise  sum_i w_i (y_i - x_i . theta)^2 + sum_j lam_j (theta_j - m_j)^2

w_i is the observation's weight (plays x recency x garbage-time weight), m_j
the prior mean (last season's rating regressed, plus personnel moves) and
lam_j the prior's strength in the same units as w (for per-play EPA,
"plays of evidence"). The prior's share of a rating therefore shrinks as
games are played, at a rate set by lam_j, which is fitted on history.

Because the solution is linear in the prior means and in the data,

    theta = A^-1 (Lam m)  +  A^-1 (X' W y)
          = from_prior    +  from_data

exactly. Every snapshot keeps both parts, so a card can say how much of a
rating is last season and how much is this one.
"""
import numpy as np


def recency_weights(age, half_life):
    """0.5 ** (age / half_life); half_life None or <= 0 means no decay."""
    age = np.asarray(age, dtype=float)
    if half_life is None or half_life <= 0 or not np.isfinite(half_life):
        return np.ones_like(age)
    return np.power(0.5, age / float(half_life))


def penalized_wls(rows, cols, vals, y, w, n_params, prior_mean, prior_prec):
    """rows/cols/vals: sparse design (observation i has value vals[k] on
    parameter cols[k] when rows[k] == i). Returns (theta, from_prior,
    from_data, posterior_precision_diag)."""
    y = np.asarray(y, dtype=float)
    w = np.asarray(w, dtype=float)
    n_obs = len(y)
    X = np.zeros((n_obs, n_params))
    if n_obs:
        np.add.at(X, (np.asarray(rows), np.asarray(cols)), np.asarray(vals, dtype=float))
    lam = np.asarray(prior_prec, dtype=float)
    m = np.asarray(prior_mean, dtype=float)
    Xw = X * w[:, None] if n_obs else X
    A = Xw.T @ X + np.diag(lam)
    # a parameter with neither data nor prior is pinned at zero rather than left singular
    dead = np.where(np.diag(A) <= 0)[0]
    if len(dead):
        A[dead, dead] = 1.0
    b_prior = lam * m
    b_data = Xw.T @ y if n_obs else np.zeros(n_params)
    L = np.linalg.cholesky(A)
    def solve(b):
        return np.linalg.solve(L.T, np.linalg.solve(L, b))
    from_prior = solve(b_prior)
    from_data = solve(b_data)
    return from_prior + from_data, from_prior, from_data, np.diag(A).copy()


def ridge(X, y, w=None, lam=1.0, unpenalized=(0,), prior_mean=None, prior_lam=None):
    """Weighted ridge on standardised columns; returns coefficients on the
    original scale. Columns in `unpenalized` are free unless `prior_lam`
    gives them an explicit pull toward `prior_mean` (in the original
    scale), which is how a fitted home-field term is shrunk toward its
    long-run value."""
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    w = np.ones(len(y)) if w is None else np.asarray(w, dtype=float)
    p = X.shape[1]
    sd = np.sqrt(np.average((X - np.average(X, axis=0, weights=w)) ** 2, axis=0, weights=w))
    sd[sd < 1e-12] = 1.0
    sd[list(unpenalized)] = 1.0
    Z = X / sd
    pen = np.full(p, float(lam))
    pen[list(unpenalized)] = 0.0
    m = np.zeros(p)
    if prior_lam is not None:
        for j, l in prior_lam.items():
            pen[j] = float(l)
            m[j] = float(prior_mean.get(j, 0.0)) * sd[j] if prior_mean else 0.0
    Zw = Z * w[:, None]
    A = Zw.T @ Z + np.diag(pen)
    beta = np.linalg.solve(A + 1e-9 * np.eye(p), Zw.T @ y + pen * m)
    return beta / sd
