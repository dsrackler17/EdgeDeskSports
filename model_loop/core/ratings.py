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


def _normal_equations(rows, cols, vals, y, w, n_params):
    """X'WX and X'Wy straight from the sparse design, without forming the
    dense n_obs x n_params X (the same sums, so the same solution; a design
    with hundreds of teams and quarterbacks stays fast). Repeated
    (row, col) entries add, exactly as they would in a dense X."""
    rows = np.asarray(rows, dtype=np.int64)
    cols = np.asarray(cols, dtype=np.int64)
    vals = np.asarray(vals, dtype=float)
    b = np.bincount(cols, weights=vals * w[rows] * y[rows], minlength=n_params)
    order = np.argsort(rows, kind="stable")
    r, c, v = rows[order], cols[order], vals[order]
    starts = np.flatnonzero(np.r_[True, r[1:] != r[:-1]])
    sizes = np.diff(np.r_[starts, len(r)])
    grp = np.repeat(np.arange(len(starts)), sizes)
    per = sizes[grp]                                   # entries sharing each entry's row
    left = np.repeat(np.arange(len(r)), per)
    first = np.repeat(np.cumsum(np.r_[0, per[:-1]]), per)
    right = starts[grp[left]] + (np.arange(len(left)) - first)
    A = np.bincount(c[left] * n_params + c[right], weights=w[r[left]] * v[left] * v[right],
                    minlength=n_params * n_params).reshape(n_params, n_params)
    return A, b


def penalized_wls(rows, cols, vals, y, w, n_params, prior_mean, prior_prec):
    """rows/cols/vals: sparse design (observation i has value vals[k] on
    parameter cols[k] when rows[k] == i). Returns (theta, from_prior,
    from_data, posterior_precision_diag)."""
    y = np.asarray(y, dtype=float)
    w = np.asarray(w, dtype=float)
    n_obs = len(y)
    lam = np.asarray(prior_prec, dtype=float)
    m = np.asarray(prior_mean, dtype=float)
    if n_obs and len(np.asarray(rows)):
        A, b_data = _normal_equations(rows, cols, vals, y, w, n_params)
    else:
        A, b_data = np.zeros((n_params, n_params)), np.zeros(n_params)
    A = A + np.diag(lam)
    # a parameter with neither data nor prior is pinned at zero rather than left singular
    dead = np.where(np.diag(A) <= 0)[0]
    if len(dead):
        A[dead, dead] = 1.0
    b_prior = lam * m
    # one factorisation for both right-hand sides (A = X'WX + diag(lam) is
    # positive definite once dead parameters are pinned); the split stays
    # exact because the solution is linear in b
    sol = np.linalg.solve(A, np.column_stack([b_prior, b_data]))
    from_prior, from_data = sol[:, 0], sol[:, 1]
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
