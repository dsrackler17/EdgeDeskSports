"""The CLV backtest harness: bet a model's number against an early line, score
the bet against the close.

One row per (game, market) in, the bets and their scorecard out:

  model       the model's number, in LINE SPACE: for spreads the expected home
              margin (home -3 is +3), for totals the expected total
  bet_line    the market's number at bet time (opener / early week), same space
  close_line  the closing number, same space
  bet_p       optional: no-vig probability of the HOME / OVER side at bet time
              (from the bet-time prices); 0.5 when the prices are unknown
  close_p     optional: no-vig probability of the HOME / OVER side at the close
  result      optional: final home margin / total points (diagnostics only)
  bet_odds_over / bet_odds_under   optional: American prices of the HOME/OVER
              and AWAY/UNDER sides at bet time (-110 assumed where missing),
              for the expected return at the price actually offered

The rule. edge = model - bet_line. A bet is placed when |edge| >= threshold, on
the side the edge points to (home / over when edge > 0). Then

  clv_pts   = side * (close_line - bet_line)            points the line moved our way
  clv_prob  = P_close(our side wins at OUR bet line) - P_bet(our side)

where P_close comes from the closing market: a margin (or total) distribution
whose no-vig cover probability at the closing number equals close_p (0.5 when
no prices), evaluated at the bet line with pushes excluded. A move through a
key number (3, 7) is therefore worth more probability than the same move
through 5.5, which is the point of measuring CLV in probability as well.

The scorecard: bet count, mean CLV (points, probability) with cluster-bootstrap
95% intervals (clusters = season-week, because a week's lines move together),
a within-week permutation null (shuffle which game each edge belongs to), the
line-direction hit rate, edge buckets (0-1, 1-2, 2-3, 3+ points, all games
with a non-zero edge), per-season rows, the movement slope (how much of the
model's disagreement the market closed), and diagnostics against the result
(ATS at the bet line, MAE) that are never the headline.
"""
import math
from dataclasses import dataclass, field, asdict

import numpy as np
import pandas as pd

from ..core.distribution import KeyNumberMargin

BUCKETS = (0.0, 1.0, 2.0, 3.0, math.inf)


@dataclass
class Config:
    threshold: float = 2.0
    market: str = "spread"          # "spread" | "total"
    n_boot: int = 2000
    n_perm: int = 1000
    seed: int = 20261021
    buckets: tuple = BUCKETS
    cluster: tuple = ("season", "week")
    label: str = ""
    extra: dict = field(default_factory=dict)


# ------------------------------------------------------------- distributions
class LineDistribution:
    """The closing market's outcome distribution around a number: a
    key-number margin table for spreads, a plain discretised normal for totals.
    cover(mu, L) -> P(X > L), P(X = L), P(X < L)."""

    def __init__(self, dist, offset=0.0):
        self.d = dist
        self.offset = offset            # totals are shifted to sit inside the table's support

    @classmethod
    def spread(cls, sigma=13.5, mult=None, kmax=70):
        return cls(KeyNumberMargin(sigma=sigma, mult=mult, kmax=kmax))

    @classmethod
    def total(cls, sigma=13.5, centre=45.0, kmax=120):
        return cls(KeyNumberMargin(sigma=sigma, mult=None, kmax=kmax), offset=centre)

    @classmethod
    def fit_spread(cls, close, result, kmax=70):
        ok = np.isfinite(close) & np.isfinite(result)
        sig = np.arange(11.0, 20.01, 0.5) if kmax > 70 else None
        return cls(KeyNumberMargin.fit(np.asarray(close)[ok], np.asarray(result)[ok], sigmas=sig, kmax=kmax))

    @classmethod
    def fit_total(cls, close, result):
        ok = np.isfinite(close) & np.isfinite(result)
        sd = float(np.std(np.asarray(result)[ok] - np.asarray(close)[ok]))
        centre = float(np.median(np.asarray(close)[ok]))
        return cls.total(sigma=sd, centre=centre)

    def p_over(self, mu, line):
        """No-vig P(X > line) with pushes excluded."""
        w, t, l = self.d.cover(np.asarray(mu, float) - self.offset, np.asarray(line, float) - self.offset)
        return w / np.maximum(w + l, 1e-12)

    def implied_mu(self, line, p_over, iters=48):
        """mu such that p_over(mu, line) = p_over (bisection, vectorised)."""
        line = np.asarray(line, float)
        target = np.asarray(p_over, float)
        lo, hi = line - 15.0, line + 15.0
        for _ in range(iters):
            mid = 0.5 * (lo + hi)
            f = self.p_over(mid, line)
            hi = np.where(f > target, mid, hi)
            lo = np.where(f > target, lo, mid)
        return 0.5 * (lo + hi)

    def to_json(self):
        return {"table": self.d.to_json(), "offset": self.offset}


def closing_p_over(dist, close_line, close_p, at_line):
    """P(X > at_line), pushes excluded, under the closing market (the
    distribution whose no-vig probability at close_line is close_p). Lines sit
    on a half-point grid and most prices are unknown, so each distinct
    (close, price, line) triple is solved once."""
    key = np.round(np.column_stack([close_line, close_p, at_line]), 6)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    mu = dist.implied_mu(uniq[:, 0], uniq[:, 1])
    return dist.p_over(mu, uniq[:, 2])[inv.ravel()]


# -------------------------------------------------------------------- bets
REQUIRED = ("game_id", "season", "week", "model", "bet_line", "close_line")


def _validate(df):
    miss = [c for c in REQUIRED if c not in df.columns]
    if miss:
        raise ValueError(f"harness input is missing {miss}")


def place_bets(df, cfg, dist):
    """All rows with a finite model/bet/close, each with its edge, side, bet
    flag and CLV (computed for every row, so buckets can use non-bets too)."""
    _validate(df)
    d = df.copy()
    d = d[np.isfinite(d.model.astype(float)) & np.isfinite(d.bet_line.astype(float)) & np.isfinite(d.close_line.astype(float))].copy()
    d["edge"] = d.model.astype(float) - d.bet_line.astype(float)
    d["side"] = np.sign(d.edge).astype(int)
    d["bet"] = (d.edge.abs() >= cfg.threshold) & (d.side != 0)
    d["move"] = d.close_line.astype(float) - d.bet_line.astype(float)
    d["clv_pts"] = d.side * d.move
    bet_p = d["bet_p"].astype(float).fillna(0.5).values if "bet_p" in d else np.full(len(d), 0.5)
    close_p = d["close_p"].astype(float).fillna(0.5).values if "close_p" in d else np.full(len(d), 0.5)
    if len(d):
        p_over_at_bet = closing_p_over(dist, d.close_line.values.astype(float), close_p, d.bet_line.values.astype(float))
    else:
        p_over_at_bet = np.array([])
    side = d.side.values
    p_close_side = np.where(side > 0, p_over_at_bet, 1.0 - p_over_at_bet)
    p_bet_side = np.where(side > 0, bet_p, 1.0 - bet_p)
    d["clv_prob"] = np.where(side != 0, p_close_side - p_bet_side, 0.0)
    # expected return of the bet at the price actually offered, if the close is
    # the truth (pushes excluded); -110 where the data has no price
    o_over = d["bet_odds_over"].astype(float).values if "bet_odds_over" in d else np.full(len(d), np.nan)
    o_under = d["bet_odds_under"].astype(float).values if "bet_odds_under" in d else np.full(len(d), np.nan)
    o_side = np.where(side > 0, o_over, o_under)
    o_side = np.where(np.isfinite(o_side), o_side, -110.0)
    dec = np.where(o_side > 0, 1.0 + o_side / 100.0, 1.0 + 100.0 / np.abs(o_side))
    d["roi"] = np.where(side != 0, p_close_side * dec - 1.0, 0.0)
    if "result" in d:
        r = d.result.astype(float) - d.bet_line.astype(float)
        d["ats"] = np.where(np.isfinite(r) & (r != 0), (np.sign(r) == d.side).astype(float), np.nan)
    return d


# ----------------------------------------------------------------- scoring
def _clusters(d, keys):
    return d[list(keys)].astype(str).agg("|".join, axis=1).values


def _stats(clv, clp):
    moved = clv != 0
    return {"n": int(len(clv)),
            "clv_pts": float(np.mean(clv)) if len(clv) else float("nan"),
            "clv_prob": float(np.mean(clp)) if len(clp) else float("nan"),
            "hit_rate": float(np.mean(clv[moved] > 0)) if moved.any() else float("nan"),
            "share_moved_toward": float(np.mean(clv > 0)) if len(clv) else float("nan"),
            "share_moved_away": float(np.mean(clv < 0)) if len(clv) else float("nan"),
            "share_unmoved": float(np.mean(clv == 0)) if len(clv) else float("nan")}


def cluster_bootstrap(values, clusters, n_boot, rng, stat=np.mean):
    """Percentile 95% interval of `stat` over resampled clusters. `values` is
    an (n,) or (n, k) array; each row belongs to clusters[i]."""
    values = np.asarray(values, float)
    if values.ndim == 1:
        values = values[:, None]
    if len(values) == 0:
        return [[float("nan"), float("nan")] for _ in range(values.shape[1])]
    u, inv = np.unique(clusters, return_inverse=True)
    sums = np.zeros((len(u), values.shape[1]))
    np.add.at(sums, inv, np.nan_to_num(values))
    cnts = np.zeros((len(u), values.shape[1]))
    np.add.at(cnts, inv, np.isfinite(values).astype(float))
    draws = rng.integers(0, len(u), size=(n_boot, len(u)))
    S = sums[draws].sum(axis=1)
    C = cnts[draws].sum(axis=1)
    est = S / np.maximum(C, 1e-12)
    lo, hi = np.nanpercentile(est, [2.5, 97.5], axis=0)
    return [[float(a), float(b)] for a, b in zip(lo, hi)]


def permutation_null(d, cfg, rng):
    """Shuffle which game each edge belongs to inside its season-week, re-place
    the bets (same edge sizes, same count per week) and re-score mean CLV.
    Returns the one-sided p-value of the observed mean and the null's mean."""
    if cfg.n_perm <= 0 or not d.bet.any():
        return {"p_value": float("nan"), "null_mean_pts": float("nan"), "n_perm": 0}
    cl = _clusters(d, cfg.cluster)
    edges = d.edge.values.copy()
    move = d.move.values
    obs = float(np.mean((np.sign(edges) * move)[np.abs(edges) >= cfg.threshold]))
    groups = [np.where(cl == c)[0] for c in np.unique(cl)]
    null = np.empty(cfg.n_perm)
    for i in range(cfg.n_perm):
        e = edges.copy()
        for g in groups:
            if len(g) > 1:
                e[g] = edges[rng.permutation(g)]
        sel = (np.abs(e) >= cfg.threshold) & (e != 0)
        null[i] = np.mean(np.sign(e[sel]) * move[sel]) if sel.any() else 0.0
    return {"p_value": float((1 + np.sum(null >= obs)) / (1 + cfg.n_perm)),
            "null_mean_pts": float(np.mean(null)), "null_sd_pts": float(np.std(null)), "n_perm": int(cfg.n_perm)}


def movement_slope(d):
    """OLS of (close - bet line) on edge over every row: the share of the
    model's disagreement the market closed, and the correlation."""
    x, y = d.edge.values.astype(float), d.move.values.astype(float)
    if len(x) < 3 or np.var(x) == 0:
        return {"slope": float("nan"), "intercept": float("nan"), "corr": float("nan"), "n": int(len(x))}
    b = float(np.cov(x, y, bias=True)[0, 1] / np.var(x))
    return {"slope": b, "intercept": float(np.mean(y) - b * np.mean(x)),
            "corr": float(np.corrcoef(x, y)[0, 1]) if np.std(y) > 0 else float("nan"), "n": int(len(x))}


def evaluate(df, cfg=None, dist=None):
    """The full scorecard for one model / market / threshold."""
    cfg = cfg or Config()
    dist = dist or (LineDistribution.spread() if cfg.market == "spread" else LineDistribution.total())
    rng = np.random.default_rng(cfg.seed)
    d = place_bets(df, cfg, dist)
    b = d[d.bet]
    out = {"label": cfg.label, "market": cfg.market, "threshold": cfg.threshold,
           "n_rows": int(len(d)), "seasons": sorted(int(s) for s in d.season.unique())}
    s = _stats(b.clv_pts.values, b.clv_prob.values)
    out.update(s)
    cl = _clusters(b, cfg.cluster)
    out["roi_at_bet_price"] = float(b.roi.mean()) if len(b) else float("nan")
    if len(b):
        hit = np.where(b.clv_pts.values != 0, (b.clv_pts.values > 0).astype(float), np.nan)
        ci = cluster_bootstrap(np.column_stack([b.clv_pts.values, b.clv_prob.values, hit, b.roi.values]), cl, cfg.n_boot, rng)
        out["clv_pts_ci95"], out["clv_prob_ci95"], out["hit_rate_ci95"], out["roi_ci95"] = ci
    else:
        out["clv_pts_ci95"] = out["clv_prob_ci95"] = out["hit_rate_ci95"] = out["roi_ci95"] = [float("nan"), float("nan")]
    out["permutation"] = permutation_null(d, cfg, rng)
    # edge buckets over every row with a non-zero edge
    bk = []
    ae = d.edge.abs().values
    for lo, hi in zip(cfg.buckets[:-1], cfg.buckets[1:]):
        sel = (ae > 0) & (ae >= lo) & (ae < hi)
        q = d[sel]
        row = {"bucket": f"{lo:g}-{hi:g}" if np.isfinite(hi) else f"{lo:g}+"}
        row.update(_stats(q.clv_pts.values, q.clv_prob.values))
        if len(q):
            row["clv_pts_ci95"] = cluster_bootstrap(q.clv_pts.values, _clusters(q, cfg.cluster), max(200, cfg.n_boot // 4), rng)[0]
        bk.append(row)
    out["buckets"] = bk
    out["by_season"] = []
    for S, q in b.groupby("season"):
        row = {"season": int(S)}
        row.update(_stats(q.clv_pts.values, q.clv_prob.values))
        out["by_season"].append(row)
    out["movement"] = movement_slope(d)
    diag = {}
    if "ats" in b and b.ats.notna().any():
        diag["ats_win_rate_at_bet_line"] = float(b.ats.mean())
        diag["ats_n"] = int(b.ats.notna().sum())
    if "result" in d and d.result.notna().any():
        q = d[d.result.notna()]
        diag["model_mae_vs_result"] = float(np.mean(np.abs(q.model - q.result)))
        diag["bet_line_mae_vs_result"] = float(np.mean(np.abs(q.bet_line - q.result)))
        diag["close_mae_vs_result"] = float(np.mean(np.abs(q.close_line - q.result)))
    out["diagnostics"] = diag
    out["config"] = {k: v for k, v in asdict(cfg).items() if k not in ("extra",)}
    out["config"]["buckets"] = [str(x) for x in cfg.buckets]
    return out


def sweep(df, thresholds, cfg=None, dist=None):
    cfg = cfg or Config()
    res = []
    for t in thresholds:
        c = Config(**{**asdict(cfg), "threshold": t, "n_perm": min(cfg.n_perm, 400)})
        res.append(evaluate(df, c, dist))
    return res


# ------------------------------------------------------- multiple testing
def holm(pvalues):
    """Holm-Bonferroni adjusted p-values (same order as given)."""
    p = np.asarray(pvalues, float)
    m = len(p)
    order = np.argsort(p)
    adj = np.empty(m)
    run = 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (m - rank) * p[i]))
        adj[i] = run
    return adj.tolist()


def bonferroni_z(n_tests, alpha=0.05):
    """The one-sided z a single result must clear after n_tests looks."""
    from statistics import NormalDist
    return NormalDist().inv_cdf(1 - alpha / max(1, n_tests))


def summary_line(r):
    lo, hi = r["clv_pts_ci95"]
    plo, phi = r["clv_prob_ci95"]
    return (f"{r['label']:<34} thr {r['threshold']:>4.1f}  bets {r['n']:>5}  CLV {r['clv_pts']:+.3f} pts "
            f"[{lo:+.3f},{hi:+.3f}]  {100 * r['clv_prob']:+.2f}% [{100 * plo:+.2f},{100 * phi:+.2f}]  "
            f"dir-hit {r['hit_rate']:.3f}  perm-p {r['permutation']['p_value']:.3f}  ROI {100 * r.get('roi_at_bet_price', float('nan')):+.2f}%")
