"""Shared loaders and statistics for the audit (read-only on the audited build)."""
import json
import os

import numpy as np
import pandas as pd
from scipy import stats

SEED = 20260927 + 1          # the audit's own seed (not the model's)
DEV = list(range(2016, 2024))
HOLD = [2024, 2025]
LIVE = [2026]


def out_dir():
    return os.environ.get('CFB_V2_OUT', 'out_h')


def audit_path(*p):
    d = os.path.join(out_dir(), 'audit', *p)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    return d


def write(name, obj):
    p = audit_path(name)
    with open(p, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_d)
        f.write('\n')
    return p


def _d(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (pd.Timestamp,)):
        return o.isoformat()
    if isinstance(o, np.bool_):
        return bool(o)
    return str(o)


_M = None


def preds():
    """The stored stage-7 out-of-fold frame (one row per game)."""
    global _M
    if _M is None:
        _M = pd.read_parquet(os.path.join(out_dir(), 'stage7', 'backtest_predictions.parquet'))
    return _M


def fbs_final(M, seasons):
    return M[M.season.isin(seasons) & M.status.eq('FINAL') & ~M.fcs_game & M.margin.notna()]


def boot_idx(n, B=2000, seed=SEED):
    rng = np.random.default_rng(seed)
    return rng.integers(0, n, size=(B, n))


def ci(v, lo=2.5, hi=97.5):
    v = np.asarray(v, float)
    v = v[~np.isnan(v)]
    return [float(np.percentile(v, lo)), float(np.percentile(v, hi))] if len(v) else [None, None]


def paired(y, a, b, B=2000, seed=SEED, pa=None, pb=None):
    """Paired game-level bootstrap of MAE/RMSE (and Brier if probs given) differences a - b.
    Negative = a better."""
    y, a, b = (np.asarray(v, float) for v in (y, a, b))
    ea, eb = a - y, b - y
    n = len(y)
    I = boot_idx(n, B, seed)
    dm = np.abs(ea) - np.abs(eb)
    mae_b = dm[I].mean(axis=1)
    rmse_b = np.sqrt((ea ** 2)[I].mean(axis=1)) - np.sqrt((eb ** 2)[I].mean(axis=1))
    out = {'n': int(n), 'mae_a': float(np.abs(ea).mean()), 'mae_b': float(np.abs(eb).mean()),
           'mae_diff': float(dm.mean()), 'mae_diff_ci': ci(mae_b),
           'p_a_not_better_mae': float((mae_b >= 0).mean()),
           'rmse_a': float(np.sqrt((ea ** 2).mean())), 'rmse_b': float(np.sqrt((eb ** 2).mean())),
           'rmse_diff': float(np.sqrt((ea ** 2).mean()) - np.sqrt((eb ** 2).mean())), 'rmse_diff_ci': ci(rmse_b)}
    if pa is not None and pb is not None:
        yw = (y > 0).astype(float)
        ba, bb = (np.asarray(pa, float) - yw) ** 2, (np.asarray(pb, float) - yw) ** 2
        db = ba - bb
        out.update({'brier_a': float(ba.mean()), 'brier_b': float(bb.mean()), 'brier_diff': float(db.mean()),
                    'brier_diff_ci': ci(db[I].mean(axis=1))})
    return out


def cluster_paired_mae(y, a, b, clusters, B=2000, seed=SEED):
    """Cluster (e.g. season-week) bootstrap of the MAE difference: games of one week share shocks."""
    y, a, b = (np.asarray(v, float) for v in (y, a, b))
    d = pd.Series(np.abs(a - y) - np.abs(b - y))
    g = pd.Series(clusters).astype(str).values
    s = d.groupby(g).agg(['sum', 'size'])
    rng = np.random.default_rng(seed)
    k = len(s)
    I = rng.integers(0, k, size=(B, k))
    tot = s['sum'].values[I].sum(axis=1) / s['size'].values[I].sum(axis=1)
    return {'clusters': int(k), 'mae_diff': float(d.mean()), 'mae_diff_ci': ci(tot)}


def prob_metrics(y, p, bins=10, B=1000, seed=SEED):
    """Brier, log loss, ECE (equal-width), calibration slope/intercept (logistic recalibration of
    logit p), each with a bootstrap CI."""
    y, p = np.asarray(y, float), np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    n = len(y)

    def core(yy, pp):
        br = float(((pp - yy) ** 2).mean())
        ll = float(-(yy * np.log(pp) + (1 - yy) * np.log(1 - pp)).mean())
        edges = np.linspace(0, 1, bins + 1)
        e = 0.0
        for i in range(bins):
            m = (pp >= edges[i]) & ((pp < edges[i + 1]) if i < bins - 1 else (pp <= 1))
            if m.any():
                e += m.sum() / len(pp) * abs(pp[m].mean() - yy[m].mean())
        return br, ll, float(e)

    br, ll, ece = core(y, p)
    sl, ic = logit_recal(y, p)
    I = boot_idx(n, B, seed)
    bs = np.array([core(y[i], p[i]) for i in I])
    rc = np.array([logit_recal(y[i], p[i]) for i in I[:300]])
    table = []
    edges = np.linspace(0, 1, bins + 1)
    for i in range(bins):
        m = (p >= edges[i]) & ((p < edges[i + 1]) if i < bins - 1 else (p <= 1))
        if m.sum() == 0:
            continue
        k = int(m.sum()); o = float(y[m].mean())
        lo, hi = wilson(o, k)
        table.append({'bin': '%.1f-%.1f' % (edges[i], edges[i + 1]), 'n': k, 'mean_pred': float(p[m].mean()),
                      'observed': o, 'observed_ci95': [lo, hi],
                      'pred_inside_ci': bool(lo <= p[m].mean() <= hi)})
    return {'n': int(n), 'brier': br, 'brier_ci': ci(bs[:, 0]), 'log_loss': ll, 'log_loss_ci': ci(bs[:, 1]),
            'ece': ece, 'ece_ci': ci(bs[:, 2]), 'slope': sl, 'slope_ci': ci(rc[:, 0]), 'intercept': ic,
            'intercept_ci': ci(rc[:, 1]), 'buckets': table,
            'base_rate': float(y.mean()), 'brier_climatology': float(y.mean() * (1 - y.mean()))}


def logit_recal(y, p):
    """Fit y ~ Bernoulli(sigmoid(a + b logit p)); returns (b, a). Newton iterations."""
    x = np.log(p / (1 - p))
    A = np.column_stack([np.ones_like(x), x])
    w = np.array([0.0, 1.0])
    for _ in range(50):
        z = A @ w
        mu = 1 / (1 + np.exp(-z))
        g = A.T @ (y - mu)
        H = (A * (mu * (1 - mu))[:, None]).T @ A + 1e-9 * np.eye(2)
        step = np.linalg.solve(H, g)
        w = w + step
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(w[1]), float(w[0])


def wilson(phat, n, z=1.96):
    if n == 0:
        return (None, None)
    d = 1 + z * z / n
    c = (phat + z * z / (2 * n)) / d
    h = z * np.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / d
    return float(c - h), float(c + h)


def norm_wp(pred, sd):
    return 1.0 - stats.norm.cdf(-np.asarray(pred, float) / sd)
