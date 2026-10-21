"""Score a model's early-line predictions with the CLV harness.

  python3 -m model_loop.clv.run --exp E-001 --sport nfl --pred .cache/clv/pred_nfl_v21.csv \
      --market spread --threshold 2 --sweep 1,3,4 --label "NFL v2.1.0"

Every invocation is appended to docs/model-loop/clv/results/ledger.jsonl (the
mechanical variant count; failures included) and its scorecard is written to
docs/model-loop/clv/results/<exp>__<label>.json.

The holdout is locked: a season >= 2025 is refused unless --unlock-holdout is
passed, which Phase 6 does exactly once.
"""
import argparse
import json
import os
import re
import time

import numpy as np
import pandas as pd

from . import harness as H
from .baselines import previous_starters

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "clv")
RESULTS = os.path.join(ROOT, "docs", "model-loop", "clv", "results")
HOLDOUT_FIRST = 2025
DEV = {"nfl": list(range(2020, 2025)), "cfb": [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024]}


class HoldoutLocked(RuntimeError):
    pass


def guard(seasons, unlock):
    if any(int(s) >= HOLDOUT_FIRST for s in seasons) and not unlock:
        raise HoldoutLocked(f"seasons {sorted(set(int(s) for s in seasons))} include the locked holdout (>= {HOLDOUT_FIRST})")


# ------------------------------------------------------------------ inputs
def read_pred(path):
    p = pd.read_parquet(path) if path.endswith(".parquet") else pd.read_csv(path)
    p["game_id"] = p.game_id.astype(str)
    return p


_ELIG = {}


def eligibility(sport):
    if sport not in _ELIG:
        if sport == "nfl":
            g = pd.read_parquet(os.path.join(ROOT, ".cache", "model_loop", "nfl", "build", "games.parquet"))
            g["kick"] = pd.to_datetime(g.kick_et)
        else:
            g = pd.read_parquet(os.path.join(ROOT, ".cache", "model_loop", "cfb", "build", "games.parquet"))
            g["kick"] = pd.to_datetime(g.kick_utc)
        _, el = previous_starters(g)
        _ELIG[sport] = {str(k): v for k, v in el.items()}
    return _ELIG[sport]


def lines(sport):
    L = pd.read_parquet(os.path.join(CACHE, f"{sport}_lines.parquet"))
    L["game_id"] = L.game_id.astype(str)
    return L


def fresh_mask(L, market="spread"):
    """NFL: the early value was (re)posted after week W-1's first kickoff, so
    it is a line the book put up after the weekend, not a stale lookahead
    number the feed kept showing (EXPERIMENTS.md, instrument rule R-1)."""
    first = L.groupby(["season", "week"]).kick_utc.min()
    prev_first = pd.Series([first.get((s, w - 1)) for s, w in zip(L.season, L.week)], index=L.index)
    posted = L[f"early_{market}_posted_at"]
    return (posted > prev_first).fillna(False)


def frame(sport, pred, market="spread", checkpoint="early", close="book", seasons=None, unlock=False, model_col=None,
          fresh=False):
    """The harness input: one row per eligible game with a model number, an
    early line and a close, in line space."""
    L = lines(sport)
    if fresh and sport == "nfl":
        L = L[fresh_mask(L, market)]
    seasons = seasons or DEV[sport]
    guard(seasons, unlock)
    L = L[L.season.isin(seasons)]
    mc = model_col or f"model_{market}"
    P = pred[["game_id", mc]].rename(columns={mc: "model"})
    d = L.merge(P, on="game_id", how="inner")
    el = eligibility(sport)
    d = d[d.game_id.map(el).fillna(False).astype(bool)]
    if sport == "nfl":
        oo, ou = f"{checkpoint}_{market}_odds_over", f"{checkpoint}_{market}_odds_under"
    else:
        oo, ou = f"early_{market}_odds_over", f"early_{market}_odds_under"
    if sport == "nfl":
        bet, bp = f"{checkpoint}_{market}", f"{checkpoint}_{market}_p"
        cl, cp = f"close_{market}", f"close_{market}_p"
        res = "result" if market == "spread" else "total_pts"
    else:
        bet, bp = f"early_{market}", f"early_{market}_p"
        cl, cp = (f"close_{market}", f"close_{market}_p") if close == "book" else (f"cons_close_{market}", None)
        res = "result" if market == "spread" else "total_pts"
    out = pd.DataFrame({"game_id": d.game_id, "season": d.season.astype(int), "week": (d.slate if sport == "cfb" else d.week).astype(int),
                        "model": d.model.astype(float), "bet_line": d[bet].astype(float), "close_line": d[cl].astype(float),
                        "bet_p": d[bp].astype(float) if bp in d else np.nan,
                        "close_p": d[cp].astype(float) if cp and cp in d else np.nan,
                        "bet_odds_over": d[oo].astype(float) if oo in d else np.nan,
                        "bet_odds_under": d[ou].astype(float) if ou in d else np.nan,
                        "result": d[res].astype(float)})
    return out[out.bet_line.notna() & out.close_line.notna() & out.model.notna()].reset_index(drop=True)


_DIST = {}


def distribution(sport, market):
    """The measuring instrument, fitted once on development seasons only."""
    k = (sport, market)
    if k in _DIST:
        return _DIST[k]
    if sport == "nfl":
        g = pd.read_parquet(os.path.join(ROOT, ".cache", "model_loop", "nfl", "build", "games.parquet"))
        g = g[g.season.between(2006, 2024)]
        c, r = (g.close_margin, g.result) if market == "spread" else (g.close_total, g.total_pts)
        kmax = 70
    else:
        m = pd.read_csv(os.path.join(ROOT, ".cache", "model_loop", "cfb", "build", "market.csv"), low_memory=False)
        m = m[m.season.between(2012, 2024)]
        c, r = (m.spread_close, m.margin) if market == "spread" else (m.total_close, m.total_pts)
        kmax = 100
    c, r = c.values.astype(float), r.values.astype(float)
    _DIST[k] = H.LineDistribution.fit_spread(c, r, kmax=kmax) if market == "spread" else H.LineDistribution.fit_total(c, r)
    return _DIST[k]


# ----------------------------------------------------------------- scoring
def slug(s):
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")


def score(df, sport, market, threshold, label, exp, sweep=(), n_boot=2000, n_perm=1000, write=True, extra=None):
    dist = distribution(sport, market)
    cfg = H.Config(threshold=threshold, market=market, label=label, n_boot=n_boot, n_perm=n_perm)
    primary = H.evaluate(df, cfg, dist)
    sw = H.sweep(df, sweep, cfg, dist) if sweep else []
    rec = {"exp": exp, "label": label, "sport": sport, "market": market, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "primary": primary, "sweep": sw, "extra": extra or {}}
    if write:
        os.makedirs(RESULTS, exist_ok=True)
        with open(os.path.join(RESULTS, f"{slug(exp)}__{slug(label)}.json"), "w") as f:
            json.dump(rec, f, indent=1, default=_js)
        with open(os.path.join(RESULTS, "ledger.jsonl"), "a") as f:
            for r in [primary] + sw:
                f.write(json.dumps({"exp": exp, "label": label, "sport": sport, "market": market, "threshold": r["threshold"],
                                    "seasons": r["seasons"], "n": r["n"], "clv_pts": r["clv_pts"], "clv_pts_ci95": r["clv_pts_ci95"],
                                    "clv_prob": r["clv_prob"], "hit_rate": r["hit_rate"], "perm_p": r["permutation"]["p_value"],
                                    "primary": r is primary, "at": rec["at"]}, default=_js) + "\n")
    return rec


def _js(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, float) and not np.isfinite(o):
        return None
    return str(o)


def edge_called(r):
    lo = r["clv_pts_ci95"][0]
    return bool(lo is not None and np.isfinite(lo) and lo > 0 and r["permutation"]["p_value"] <= 0.05 and r["clv_prob"] > 0)


def print_rec(rec):
    print(H.summary_line(rec["primary"]), " EDGE" if edge_called(rec["primary"]) else "")
    for r in rec["sweep"]:
        print("   " + H.summary_line(r))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", required=True)
    ap.add_argument("--sport", choices=["nfl", "cfb"], required=True)
    ap.add_argument("--pred", required=True)
    ap.add_argument("--market", default="spread", choices=["spread", "total"])
    ap.add_argument("--threshold", type=float, required=True)
    ap.add_argument("--sweep", default="")
    ap.add_argument("--label", required=True)
    ap.add_argument("--checkpoint", default="early", choices=["early", "fri"])
    ap.add_argument("--close", default="book", choices=["book", "consensus"])
    ap.add_argument("--seasons", default="")
    ap.add_argument("--unlock-holdout", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="NFL: only early lines re-posted after week W-1 kicked off")
    a = ap.parse_args(argv)
    seasons = [int(x) for x in a.seasons.split(",") if x] or None
    df = frame(a.sport, read_pred(a.pred), a.market, a.checkpoint, a.close, seasons, a.unlock_holdout, fresh=a.fresh)
    sweep = [float(x) for x in a.sweep.split(",") if x]
    rec = score(df, a.sport, a.market, a.threshold, a.label, a.exp, sweep,
                extra={"pred": os.path.relpath(a.pred, ROOT), "checkpoint": a.checkpoint, "close": a.close, "fresh": a.fresh})
    print_rec(rec)


if __name__ == "__main__":
    main()
