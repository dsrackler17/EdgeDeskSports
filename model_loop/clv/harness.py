"""The closing-line-value harness. One implementation for every sport and
every market, so every study is scored the same way.

What it measures
----------------
Given, per game, the OPENING (or earliest available) line, the CLOSING line
and the model's number, it places the bets the model would have made against
the opener and asks how far the market moved toward them by the close.

Two kinds of market:

  points  the line moves and the price stays near -110: spreads and totals
          (NFL, CFB, NBA, CBB). CLV is reported in points AND in no-vig
          probability of the bet at the opening number, measured with the
          closing market.
  price   the line is fixed and the price moves: moneylines, puck lines and
          run lines (NHL, MLB, soccer, UFC). CLV is reported in no-vig
          probability only; points are meaningless there.

Orientation (the same as model_loop.core.metrics)
-------------------------------------------------
  spread  lines are the market's expected HOME margin: home -3 is +3.
          side +1 = home, -1 = away. Home at line L wins if margin > L.
  total   lines are the expected total. side +1 = over, -1 = under.
  price   side +1 = side A (home / over / fighter A), -1 = side B. The model
          supplies P(side A); the prices supply both sides' American odds.

CLV of one bet
--------------
  clv_pts  = side * (close_line - open_line)                (points only)
  clv_prob = P_close(bet wins | no push) - P_open(bet wins | no push), both
             no-vig. For a points bet, P_close is the closing market's
             no-vig probability of the bet AT THE OPENING NUMBER: the close's
             own no-vig price at its line, moved by the outcome distribution's
             mass between the two lines (a first-order shift, exact when the
             close is priced evenly and the distribution is centred on it).
  clv_ev   = expected return of the opening bet per unit staked, with the
             closing market's no-vig probabilities (pushes return the stake).

Uncertainty
-----------
Bets are resampled in clusters (by default one cluster per game date or
week: same-day news moves many lines at once), so intervals are not too
narrow. Every summary carries a percentile 95% interval, a one-sided p-value
for "mean CLV > 0" from the bootstrap standard error, and, when the caller
says how many variants the sport has tried, the Bonferroni-adjusted one-sided
lower bound used for the final verdict.
"""
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..core.distribution import KeyNumberMargin

INF = float("inf")


# --------------------------------------------------------------------- odds
def implied(american):
    """Implied probability of American odds (with the vig in it)."""
    a = np.asarray(american, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a < 0, -a / (-a + 100.0), 100.0 / (a + 100.0))


def decimal(american):
    a = np.asarray(american, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a < 0, 1.0 + 100.0 / -a, 1.0 + a / 100.0)


def valid_american(american):
    a = np.asarray(american, dtype=float)
    return np.isfinite(a) & (np.abs(a) >= 100)


def no_vig(a, b, method="multiplicative"):
    """No-vig probability of side A from both sides' American odds.

    multiplicative: pA / (pA + pB).
    power:          pA^k with k solved so that pA^k + pB^k = 1 (shades the
                    longshot more, the usual correction for favourite-longshot
                    bias)."""
    pa, pb = implied(a), implied(b)
    if method == "multiplicative":
        with np.errstate(invalid="ignore", divide="ignore"):
            return pa / (pa + pb)
    if method == "power":
        scalar = np.ndim(pa) == 0
        pa, pb = np.atleast_1d(pa).astype(float), np.atleast_1d(pb).astype(float)
        lo, hi = np.full(pa.shape, 0.5), np.full(pa.shape, 3.0)
        for _ in range(60):
            k = 0.5 * (lo + hi)
            over = pa ** k + pb ** k > 1
            lo = np.where(over, k, lo)
            hi = np.where(over, hi, k)
        out = pa ** (0.5 * (lo + hi))
        return float(out[0]) if scalar else out
    raise ValueError(method)


# ---------------------------------------------------- outcome distributions
class IntegerNormal:
    """Integer outcomes (a margin, a total) as a discretised normal around a
    centre. The generic points distribution when no key-number table is
    fitted for the sport."""

    def __init__(self, sigma, width=8.0):
        self.sigma = float(sigma)
        self.half = int(math.ceil(width * sigma)) + 2

    def cover(self, center, line):
        """P(X > line), P(X == line), P(X < line) with X centred on `center`."""
        c = np.atleast_1d(np.asarray(center, dtype=float))
        ln = np.atleast_1d(np.asarray(line, dtype=float))
        j = np.arange(-self.half, self.half + 1)
        k = np.round(c)[:, None] + j[None, :]
        z = (k - c[:, None]) / self.sigma
        p = np.exp(-0.5 * z * z)
        p /= p.sum(axis=1, keepdims=True)
        above = k > ln[:, None] + 1e-9
        at = np.abs(k - ln[:, None]) < 1e-9
        return (p * above).sum(axis=1), (p * at).sum(axis=1), (p * ~(above | at)).sum(axis=1)


def outcome_distribution(sport, market):
    """The default points distribution per sport and market. Sigmas are the
    standard deviation of (final - closing line) in each sport's history; a
    study can pass its own (for example a KeyNumberMargin fitted on its
    pre-holdout seasons)."""
    s = {("nfl", "spread"): 13.5, ("nfl", "total"): 13.5, ("cfb", "spread"): 15.5, ("cfb", "total"): 16.5,
         ("nba", "spread"): 12.0, ("nba", "total"): 18.0, ("cbb", "spread"): 10.5, ("cbb", "total"): 15.5,
         ("wnba", "spread"): 11.5, ("wnba", "total"): 15.0}
    if (sport, market) == ("nfl", "spread"):
        return KeyNumberMargin(sigma=13.5)
    return IntegerNormal(s.get((sport, market), 13.5))


# ------------------------------------------------------------------ config
@dataclass
class HarnessConfig:
    kind: str                                   # "points" or "price"
    market: str = "spread"                      # spread / total / moneyline / puckline / runline
    thresholds: tuple = (0.5, 1.0, 2.0, 3.0)    # |edge| to bet: points, or probability for price
    primary: float = None                       # the pre-registered threshold (default: thresholds[0])
    buckets: tuple = (0.0, 1.0, 2.0, 3.0, 5.0, INF)
    dist: object = None                         # points: .cover(center, line); default IntegerNormal(13.5)
    devig: str = "multiplicative"
    default_price: float = -110.0               # points markets with no prices captured
    n_boot: int = 4000
    seed: int = 20261021
    cluster: str = "cluster"                    # resampling unit column; game_id when absent
    alpha: float = 0.05
    extra: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.kind not in ("points", "price"):
            raise ValueError(self.kind)
        if self.primary is None:
            self.primary = self.thresholds[0]
        if self.kind == "points" and self.dist is None:
            self.dist = IntegerNormal(13.5)


# ------------------------------------------------------------ per-bet CLV
REQUIRED = {
    "points": ["season", "game_id", "open_line", "close_line", "model_line"],
    "price": ["season", "game_id", "open_a", "open_b", "close_a", "close_b", "model_prob"],
}


def _price_cols(df, cfg, when):
    a, b = f"{when}_price_a", f"{when}_price_b"
    pa = df[a].to_numpy(float) if a in df else np.full(len(df), cfg.default_price)
    pb = df[b].to_numpy(float) if b in df else np.full(len(df), cfg.default_price)
    bad = ~(valid_american(pa) & valid_american(pb))
    pa, pb = np.where(bad, cfg.default_price, pa), np.where(bad, cfg.default_price, pb)
    return pa, pb


def _side_cover(dist, center, line, side):
    """(win, push, loss) of a bet on `side` at `line` with outcomes centred on `center`."""
    above, at, below = dist.cover(center, line)
    win = np.where(side > 0, above, below)
    loss = np.where(side > 0, below, above)
    return win, at, loss


def bet_table(df, cfg, threshold):
    """Every bet the model makes against the opener at |edge| >= threshold,
    with its CLV. Rows missing an opener, a close or a model number are not
    bets (they are counted by coverage())."""
    need = REQUIRED[cfg.kind]
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise KeyError(f"missing columns {miss}")
    d = df.dropna(subset=need).copy()
    if cfg.kind == "points":
        d["edge"] = d.model_line - d.open_line
        d = d[np.abs(d.edge) >= max(threshold, 1e-12)].copy()
        if not len(d):
            return d
        side = np.sign(d.edge.to_numpy())
        lo, lc = d.open_line.to_numpy(float), d.close_line.to_numpy(float)
        oa, ob = _price_cols(d, cfg, "open")
        ca, cb = _price_cols(d, cfg, "close")
        p_open_a = no_vig(oa, ob, cfg.devig)
        p_close_a_at_close = no_vig(ca, cb, cfg.devig)
        # the closing market's distribution, centred on the close
        w_o, push_o, l_o = _side_cover(cfg.dist, lc, lo, side)
        w_c, _, l_c = _side_cover(cfg.dist, lc, lc, side)
        q_open = w_o / np.maximum(w_o + l_o, 1e-12)
        q_close = w_c / np.maximum(w_c + l_c, 1e-12)
        p_close_side_at_close = np.where(side > 0, p_close_a_at_close, 1 - p_close_a_at_close)
        p_close_at_open = np.clip(p_close_side_at_close + (q_open - q_close), 1e-4, 1 - 1e-4)
        p_open_side = np.where(side > 0, p_open_a, 1 - p_open_a)
        dec_open = np.where(side > 0, decimal(oa), decimal(ob))
        d["side"] = side
        d["clv_pts"] = side * (lc - lo)
        d["p_open"] = p_open_side
        d["p_close"] = p_close_at_open
        d["clv_prob"] = p_close_at_open - p_open_side
        d["clv_ev"] = (1 - push_o) * (p_close_at_open * (dec_open - 1) - (1 - p_close_at_open))
        d["toward"] = np.sign(d.clv_pts)
        if "result" in d.columns:
            r = d.result.to_numpy(float)
            res = np.sign(side * (r - lo))
            d["won"] = np.where(np.isfinite(r), res, np.nan)
            d["ret"] = np.where(res > 0, dec_open - 1, np.where(res < 0, -1.0, 0.0))
            d.loc[~np.isfinite(r), "ret"] = np.nan
    else:
        oa, ob = d.open_a.to_numpy(float), d.open_b.to_numpy(float)
        ca, cb = d.close_a.to_numpy(float), d.close_b.to_numpy(float)
        ok = valid_american(oa) & valid_american(ob) & valid_american(ca) & valid_american(cb)
        d, oa, ob, ca, cb = d[ok].copy(), oa[ok], ob[ok], ca[ok], cb[ok]
        p_open_a = no_vig(oa, ob, cfg.devig)
        p_close_a = no_vig(ca, cb, cfg.devig)
        edge_a = d.model_prob.to_numpy(float) - p_open_a
        d["edge"] = edge_a
        keep = np.abs(edge_a) >= max(threshold, 1e-12)
        d, p_open_a, p_close_a, oa, ob = d[keep].copy(), p_open_a[keep], p_close_a[keep], oa[keep], ob[keep]
        if not len(d):
            return d
        side = np.sign(d.edge.to_numpy())
        p_open = np.where(side > 0, p_open_a, 1 - p_open_a)
        p_close = np.where(side > 0, p_close_a, 1 - p_close_a)
        dec_open = np.where(side > 0, decimal(oa), decimal(ob))
        d["side"] = side
        d["p_open"] = p_open
        d["p_close"] = p_close
        d["clv_prob"] = p_close - p_open
        d["clv_ev"] = p_close * dec_open - 1
        d["toward"] = np.where(np.abs(d.clv_prob) < 1e-9, 0.0, np.sign(d.clv_prob))
        if "result" in d.columns:
            r = d.result.to_numpy(float)          # 1 = side A won, 0 = side B won, 0.5 / nan = void
            won = np.where(side > 0, r, 1 - r)
            d["won"] = np.where(np.isfinite(r) & (r != 0.5), np.where(won > 0.5, 1.0, -1.0), np.nan)
            d["ret"] = np.where(d.won > 0, dec_open - 1, np.where(d.won < 0, -1.0, np.nan))
    return d


# --------------------------------------------------------------- bootstrap
def _clusters(d, cfg):
    col = cfg.cluster if cfg.cluster in d.columns else "game_id"
    codes, _ = pd.factorize(d[col].astype(str))
    return codes


def cluster_boot(values, codes, n_boot, seed):
    """Cluster bootstrap of a mean: resample whole clusters with replacement.
    Returns the bootstrap means."""
    v = np.asarray(values, dtype=float)
    ok = np.isfinite(v)
    v, codes = v[ok], codes[ok]
    if len(v) == 0:
        return np.array([])
    _, codes = np.unique(codes, return_inverse=True)
    k = codes.max() + 1
    sums = np.bincount(codes, weights=v, minlength=k)
    cnts = np.bincount(codes, minlength=k).astype(float)
    rng = np.random.default_rng(seed)
    out = np.empty(n_boot)
    step = max(1, 2_000_000 // max(k, 1))
    for i in range(0, n_boot, step):
        m = min(step, n_boot - i)
        idx = rng.integers(0, k, size=(m, k))
        out[i:i + m] = sums[idx].sum(axis=1) / np.maximum(cnts[idx].sum(axis=1), 1)
    return out


def _stat(values, codes, cfg, k_tests=1):
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if len(v) == 0:
        return {"n": 0, "mean": None}
    boots = cluster_boot(values, codes, cfg.n_boot, cfg.seed)
    mean = float(v.mean())
    se = float(boots.std(ddof=1)) if len(boots) > 1 else float("nan")
    p = 0.5 * math.erfc((mean / se) / math.sqrt(2)) if se and se > 0 else (0.0 if mean > 0 else 1.0)
    out = {"n": int(len(v)), "mean": round(mean, 5), "se": round(se, 5) if np.isfinite(se) else None,
           "ci95": [round(float(np.percentile(boots, 2.5)), 5), round(float(np.percentile(boots, 97.5)), 5)],
           "p_one_sided": round(p, 5)}
    if k_tests and k_tests > 1:
        a = cfg.alpha / k_tests
        out["k_tests"] = int(k_tests)
        out["lb_adjusted"] = round(float(np.percentile(boots, 100 * a)), 5)
        out["p_adjusted"] = round(min(1.0, p * k_tests), 5)
    return out


# --------------------------------------------------------------- summaries
def summarize(bets, cfg, k_tests=1):
    """One threshold's bets -> counts, mean CLV with intervals, line-direction
    hit rate, and the outcome diagnostics."""
    n = int(len(bets))
    out = {"n_bets": n}
    if not n:
        return out
    codes = _clusters(bets, cfg)
    out["n_clusters"] = int(len(np.unique(codes)))
    if cfg.kind == "points":
        out["clv_pts"] = _stat(bets.clv_pts, codes, cfg, k_tests)
    out["clv_prob"] = _stat(bets.clv_prob, codes, cfg, k_tests)
    out["clv_ev"] = _stat(bets.clv_ev, codes, cfg)
    tw = bets.toward.to_numpy()
    toward, against = int((tw > 0).sum()), int((tw < 0).sum())
    out["moved_toward"], out["moved_against"], out["no_move"] = toward, against, int((tw == 0).sum())
    moved = tw != 0
    if moved.any():
        hit = (tw[moved] > 0).astype(float)
        out["direction_hit_rate"] = _stat(hit, codes[moved], cfg)
    out["mean_abs_edge"] = round(float(np.abs(bets.edge).mean()), 5)
    if "won" in bets.columns and bets.won.notna().any():
        g = bets[bets.won.notna()]
        wins, losses = int((g.won > 0).sum()), int((g.won < 0).sum())
        out["results"] = {"n": int(len(g)), "wins": wins, "losses": losses, "pushes": int((g.won == 0).sum()),
                          "win_pct": round(wins / max(wins + losses, 1), 4),
                          "roi_at_open": _stat(g.ret, _clusters(g, cfg), cfg)}
    return out


def coverage(df, cfg):
    need = REQUIRED[cfg.kind]
    have = df.dropna(subset=[c for c in need if c in df.columns])
    out = {"rows": int(len(df)), "usable": int(len(have))}
    if cfg.kind == "points" and len(have):
        mv = have.close_line - have.open_line
        out["mean_abs_move"] = round(float(np.abs(mv).mean()), 4)
        out["share_moved"] = round(float((mv != 0).mean()), 4)
        out["model_minus_open_sd"] = round(float((have.model_line - have.open_line).std()), 4)
    if cfg.kind == "price" and len(have):
        ok = valid_american(have.open_a) & valid_american(have.open_b) & valid_american(have.close_a) & valid_american(have.close_b)
        h = have[ok]
        mv = no_vig(h.close_a, h.close_b, cfg.devig) - no_vig(h.open_a, h.open_b, cfg.devig)
        out["usable"] = int(ok.sum())
        out["mean_abs_move_prob"] = round(float(np.nanmean(np.abs(mv))), 5) if len(h) else None
    return out


def bucket_table(df, cfg):
    """Every bet with nonzero edge, grouped by |edge| bucket."""
    bets = bet_table(df, cfg, 1e-9)
    rows = []
    if not len(bets):
        return rows
    e = np.abs(bets.edge.to_numpy())
    b = cfg.buckets
    for lo, hi in zip(b[:-1], b[1:]):
        sel = (e >= lo) & (e < hi)
        s = summarize(bets[sel], cfg)
        s["bucket"] = f"[{lo:g}, {'inf' if hi == INF else f'{hi:g}'})"
        rows.append(s)
    return rows


def season_table(df, cfg, threshold=None):
    t = cfg.primary if threshold is None else threshold
    bets = bet_table(df, cfg, t)
    rows = []
    for s, g in bets.groupby("season"):
        r = summarize(g, cfg)
        r["season"] = int(s)
        rows.append(r)
    return rows


def evaluate(df, cfg, k_tests=1, label=None):
    """The full CLV report for one model on one market."""
    out = {"label": label, "kind": cfg.kind, "market": cfg.market, "primary_threshold": cfg.primary,
           "coverage": coverage(df, cfg), "thresholds": []}
    for t in cfg.thresholds:
        s = summarize(bet_table(df, cfg, t), cfg, k_tests if t == cfg.primary else 1)
        s["threshold"] = t
        out["thresholds"].append(s)
    out["primary"] = next(x for x in out["thresholds"] if x["threshold"] == cfg.primary)
    out["buckets"] = bucket_table(df, cfg)
    out["by_season"] = season_table(df, cfg)
    return out


# ------------------------------------------------- the multiple-testing rule
def holm(pvals):
    """Holm-Bonferroni adjusted p-values, in the input order."""
    p = np.asarray(pvals, dtype=float)
    order = np.argsort(p)
    m = len(p)
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        adj[i] = running
    return adj


def verdict(summary_primary, k_tests, metric="clv_prob", min_bets=50):
    """PASS only if, with the sport's whole family of attempts counted, the
    one-sided lower bound of mean CLV at alpha / k is above zero and there are
    enough bets to mean anything."""
    s = summary_primary.get(metric) or {}
    n = summary_primary.get("n_bets", 0)
    if n < min_bets or s.get("mean") is None:
        return {"pass": False, "why": f"{n} bets (< {min_bets})"}
    lb = s.get("lb_adjusted", s["ci95"][0])
    ok = lb is not None and lb > 0
    return {"pass": bool(ok), "why": f"mean {metric} {s['mean']:+.4f}, alpha/{k_tests} one-sided lower bound {lb:+.4f}"}


# -------------------------------------------------- the residual diagnostic
def movement_calibration(pred_move, actual_move, bins=5):
    """Does the predicted open-to-close move come true? Slope of the actual
    move on the predicted one (1 = calibrated, 0 = no information) and the
    binned table."""
    p = np.asarray(pred_move, dtype=float)
    a = np.asarray(actual_move, dtype=float)
    ok = np.isfinite(p) & np.isfinite(a)
    p, a = p[ok], a[ok]
    if len(p) < 3 or np.var(p) == 0:
        return {"n": int(len(p))}
    slope = float(np.cov(p, a)[0, 1] / np.var(p, ddof=1))
    corr = float(np.corrcoef(p, a)[0, 1])
    qs = np.quantile(p, np.linspace(0, 1, bins + 1))
    rows = []
    for i in range(bins):
        sel = (p >= qs[i]) & ((p < qs[i + 1]) if i < bins - 1 else (p <= qs[i + 1]))
        if sel.any():
            rows.append({"n": int(sel.sum()), "pred": round(float(p[sel].mean()), 4), "actual": round(float(a[sel].mean()), 4)})
    return {"n": int(len(p)), "slope": round(slope, 4), "corr": round(corr, 4), "bins": rows}
