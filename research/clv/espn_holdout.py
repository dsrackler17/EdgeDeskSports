"""WNBA and NCAAM: the single pre-registered holdout run of each production
model against ESPN DraftKings open and close (EXPERIMENTS.md, WNBA-H / NCAAM-H).

  python3 -m research.clv.espn_holdout wnba
  python3 -m research.clv.espn_holdout ncaam
"""
import json
import os
import sys

import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import sources as S
from research.clv import runner

SPEC = {
    "wnba": {"sport": "wnba", "key": "wnba", "preds": "bb_wnba.csv", "seasons": [2025, 2026], "sig": (11.5, 15.0),
             "prefix": "WNBA", "label": "production bb_points (WNBA 1.0.0)"},
    "ncaam": {"sport": "ncaam", "key": "cbb", "preds": "bb_ncaam.csv", "seasons": [2026, 2027], "sig": (10.5, 15.5),
              "prefix": "NCAAM", "label": "production bb_points (NCAAM 1.1.0)"},
}


def frame(league):
    sp = SPEC[league]
    lines, qa = S.espn_lines(league, sp["key"])
    p = pd.read_csv(os.path.join(S.CACHE, sp["preds"]))
    p = p[p.season.isin(sp["seasons"])]
    m = p.merge(lines, on="game_id", how="inner")
    m["cluster"] = m.date.astype(str)
    m["result"] = m.margin
    return m, qa


def run(league):
    sp = SPEC[league]
    m, qa = frame(league)
    k = 3
    pre = sp["prefix"]
    out = {"qa": qa, "games_with_spread": int((m.open_line.notna() & m.close_line.notna()).sum())}
    ss, st = sp["sig"]
    sp_cfg = H.HarnessConfig(kind="points", market="spread", thresholds=(1.5, 1.0, 3.0, 5.0), primary=1.5,
                             dist=H.IntegerNormal(ss), buckets=(0, 1, 2, 3, 5, H.INF))
    x = m.copy()
    x["model_line"] = x.model_margin
    rep = runner.run(sp["sport"], f"{pre}-H1", x, sp_cfg, sp["label"] + " spread", holdout=True, k_tests=k)
    out[f"{pre}-H1"] = {"result": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k), "clv_ev": rep["primary"].get("clv_ev", {}).get("mean")}
    t_cfg = H.HarnessConfig(kind="points", market="total", thresholds=(2.0, 1.0, 3.0, 5.0), primary=2.0,
                            dist=H.IntegerNormal(st), buckets=(0, 1, 2, 3, 5, H.INF))
    x = m.copy()
    x["open_line"], x["close_line"], x["model_line"], x["result"] = x.open_total, x.close_total, x.model_total, x.total_pts
    x["open_price_a"], x["open_price_b"] = x.open_over_odds, x.open_under_odds
    x["close_price_a"], x["close_price_b"] = x.close_over_odds, x.close_under_odds
    rep = runner.run(sp["sport"], f"{pre}-H2", x, t_cfg, sp["label"] + " total", holdout=True, k_tests=k)
    out[f"{pre}-H2"] = {"result": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k), "clv_ev": rep["primary"].get("clv_ev", {}).get("mean")}
    ml_cfg = H.HarnessConfig(kind="price", market="moneyline", thresholds=(0.02, 0.01, 0.05), primary=0.02,
                             buckets=(0, 0.02, 0.04, 0.06, 0.1, 1))
    x = m.rename(columns={"open_ml_home": "open_a", "open_ml_away": "open_b", "close_ml_home": "close_a", "close_ml_away": "close_b"}).copy()
    x["model_prob"] = x.p_home
    x["result"] = (x.margin > 0).astype(float)
    rep = runner.run(sp["sport"], f"{pre}-H3", x, ml_cfg, sp["label"] + " moneyline", holdout=True, k_tests=k)
    out[f"{pre}-H3"] = {"result": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k), "clv_ev": rep["primary"].get("clv_ev", {}).get("mean")}
    print(json.dumps(out, indent=1, default=str))
    with open(os.path.join(runner.RESULTS, sp["sport"], "holdout_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)


if __name__ == "__main__":
    run(sys.argv[1])
