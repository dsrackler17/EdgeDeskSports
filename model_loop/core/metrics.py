"""Evaluation metrics, every one computed the same way for the model and
for the closing line it is measured against.

Conventions: margins are HOME margins (+ = home won / home favoured);
`close` is the market's expected home margin (the negative of the home line
a book prints).
"""
import math

import numpy as np


def _clean(*arrs):
    arrs = [np.asarray(a, dtype=float) for a in arrs]
    ok = np.ones(len(arrs[0]), dtype=bool)
    for a in arrs:
        ok &= np.isfinite(a)
    return [a[ok] for a in arrs], ok


def mae(pred, actual):
    (p, a), _ = _clean(pred, actual)
    return float(np.mean(np.abs(p - a))) if len(p) else None


def rmse(pred, actual):
    (p, a), _ = _clean(pred, actual)
    return float(np.sqrt(np.mean((p - a) ** 2))) if len(p) else None


def brier(prob, outcome):
    (p, y), _ = _clean(prob, outcome)
    return float(np.mean((p - y) ** 2)) if len(p) else None


def logloss(prob, outcome):
    (p, y), _ = _clean(prob, outcome)
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))) if len(p) else None


def calibration_table(prob, outcome, bins=10):
    (p, y), _ = _clean(prob, outcome)
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for i in range(bins):
        sel = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= edges[i + 1])
        if sel.sum():
            rows.append({"bin": f"{edges[i]:.1f}-{edges[i + 1]:.1f}", "n": int(sel.sum()),
                         "mean_pred": round(float(p[sel].mean()), 4), "observed": round(float(y[sel].mean()), 4)})
    ece = sum(r["n"] * abs(r["mean_pred"] - r["observed"]) for r in rows) / max(1, len(p))
    return {"bins": rows, "ece": round(float(ece), 4)}


def binom_p_one_sided(wins, n):
    """P(X >= wins | n, 0.5), normal approximation with continuity above 1000."""
    if n == 0:
        return None
    if n > 1000:
        z = (wins - 0.5 - n / 2) / math.sqrt(n / 4)
        return 0.5 * math.erfc(z / math.sqrt(2))
    return sum(math.comb(n, k) for k in range(wins, n + 1)) / 2 ** n


def ats_vs_close(pred, close, actual, thresholds=(1, 2, 3)):
    """Take the side the model prefers against the CLOSE when it disagrees
    by >= t points; graded on the final margin. Pushes excluded."""
    (p, c, a), _ = _clean(pred, close, actual)
    out = {}
    for t in thresholds:
        d = p - c
        sel = np.abs(d) >= t
        res = a[sel] - c[sel]
        side = np.sign(d[sel])
        win = int(np.sum(side * res > 0))
        loss = int(np.sum(side * res < 0))
        n = win + loss
        out[str(t)] = {"n": n, "wins": win, "pushes": int(np.sum(res == 0)),
                       "win_pct": round(win / n, 4) if n else None, "p_one_sided": binom_p_one_sided(win, n)}
    return out


def paired_abs_error_test(err_a, err_b, n_boot=2000, seed=7):
    """Is |err_a| smaller than |err_b| on the same games? Returns the mean
    difference (a - b, negative = a better), a paired t, and a bootstrap
    95% interval."""
    (ea, eb), _ = _clean(err_a, err_b)
    d = np.abs(ea) - np.abs(eb)
    n = len(d)
    if n < 3:
        return None
    se = d.std(ddof=1) / math.sqrt(n)
    rng = np.random.default_rng(seed)
    boots = rng.choice(d, size=(n_boot, n), replace=True).mean(axis=1)
    return {"n": n, "mean_diff": round(float(d.mean()), 4), "t": round(float(d.mean() / se), 3) if se > 0 else None,
            "ci95": [round(float(np.percentile(boots, 2.5)), 4), round(float(np.percentile(boots, 97.5)), 4)]}


def paired_logloss_test(p_a, p_b, y, n_boot=2000, seed=11):
    (pa, pb, yy), _ = _clean(p_a, p_b, y)
    def ll(p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -(yy * np.log(p) + (1 - yy) * np.log(1 - p))
    d = ll(pa) - ll(pb)
    n = len(d)
    if n < 3:
        return None
    se = d.std(ddof=1) / math.sqrt(n)
    rng = np.random.default_rng(seed)
    boots = rng.choice(d, size=(n_boot, n), replace=True).mean(axis=1)
    return {"n": n, "mean_diff": round(float(d.mean()), 5), "t": round(float(d.mean() / se), 3) if se > 0 else None,
            "ci95": [round(float(np.percentile(boots, 2.5)), 5), round(float(np.percentile(boots, 97.5)), 5)]}


def clv_points(model_margin, open_margin, close_margin):
    """Points the market moved toward the side the model preferred against
    the opener (positive = the close came to the model)."""
    (m, o, c), _ = _clean(model_margin, open_margin, close_margin)
    side = np.sign(m - o)
    mv = (c - o) * side
    keep = side != 0
    return {"n": int(keep.sum()), "mean_pts": round(float(mv[keep].mean()), 3) if keep.sum() else None,
            "positive": int((mv[keep] > 0).sum()), "negative": int((mv[keep] < 0).sum()), "flat": int((mv[keep] == 0).sum())}
