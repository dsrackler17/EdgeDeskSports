"""Step 4 first look (reported, never gating; research/clv_early_week/EXPERIMENTS.md).

  python3 -m model_loop.clv_early.step4

1. The CFB Loop with week W-1 inputs against EdgeDesk's timestamped DraftKings
   early line (2026 weeks 5-8), only where the timing is provable: the early quote
   was observed after both teams' previous games had kicked off + 4 h. The W-2 rule
   is scored on the same games beside it.
2. The big-edge thresholds on the 2025-26 holdout bets already scored.
"""
import json
import os

import numpy as np
import pandas as pd

from . import harness as H
from . import run as R

LAG_H = 4.0


def proven_timing_ids():
    L = R.lines("cfb")
    L = L[(L.season == 2026) & L.early_spread.notna()]
    g = pd.read_parquet(os.path.join(R.ROOT, ".cache", "model_loop", "cfb", "build", "games.parquet"))
    g = g[g.season == 2026].copy()
    g["game_id"] = g.game_id.astype(str)
    g["kick"] = pd.to_datetime(g.kick_utc, utc=True)
    long = pd.concat([g[["game_id", "kick", "home"]].rename(columns={"home": "team"}),
                      g[["game_id", "kick", "away"]].rename(columns={"away": "team"})]).sort_values("kick")
    ok, n = set(), 0
    for r in L.itertuples(index=False):
        row = g[g.game_id == str(r.game_id)]
        if not len(row):
            continue
        k = row.kick.iloc[0]
        need = []
        for t in (row.home.iloc[0], row.away.iloc[0]):
            prev = long[(long.team == t) & (long.kick < k)]
            if len(prev):
                need.append(prev.kick.max() + pd.Timedelta(hours=LAG_H))
        posted = pd.to_datetime(r.early_spread_posted_at, utc=True)
        n += 1
        if need and posted >= max(need):
            ok.add(str(r.game_id))
    return ok, n


def main():
    out = {}
    ids, n = proven_timing_ids()
    out["timing"] = {"games_2026_with_early_line": n, "proven_after_both_previous_games": len(ids)}
    print(f"2026 CFB games with a DraftKings early line: {n}; timing provable (early quote after both teams' previous games): {len(ids)}")
    w1 = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop.parquet"))
    w2 = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet"))
    for mk in ("spread", "total"):
        for tag, P in (("W-1", w1), ("W-2", w2)):
            df = R.frame("cfb", P, mk, seasons=[2026], unlock=True)
            for sub, keep in (("proven-timing games", df.game_id.isin(ids)), ("all 2026 captured games", df.game_id == df.game_id)):
                d = df[keep].reset_index(drop=True)
                r = H.evaluate(d, H.Config(threshold=3.0, market=mk, n_boot=2000, n_perm=500), R.distribution("cfb", mk))
                out[f"{mk}|{tag}|{sub}"] = r
                lo, hi = r["clv_pts_ci95"]
                print(f"CFB {mk:6} {tag} {sub:24} bets {r['n']:>3}  CLV {r['clv_pts']:+.3f} [{lo:+.3f},{hi:+.3f}]  "
                      f"{100 * r['clv_prob']:+.2f}%  hit {r['hit_rate']:.3f}  perm-p {r['permutation']['p_value']:.3f}")
    # big-edge thresholds on the holdout bets already scored (descriptive)
    pn = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21.csv"))
    pc = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet"))
    for name, sport, P, mk, thrs, kw in (("H-5 CFB total", "cfb", pc, "total", (3.0, 5.0), {}),
                                         ("H-4 CFB spread", "cfb", pc, "spread", (3.0, 5.0), {}),
                                         ("H-3 NFL total", "nfl", pn, "total", (2.0, 3.0, 4.0), {"fresh": True})):
        df = R.frame(sport, P, mk, seasons=[2025, 2026], unlock=True, **kw)
        for t in thrs:
            r = H.evaluate(df, H.Config(threshold=t, market=mk, n_boot=2000, n_perm=0), R.distribution(sport, mk))
            out[f"bigedge|{name}|{t}"] = r
            lo, hi = r["clv_pts_ci95"]
            print(f"holdout {name:15} >= {t:g}: bets {r['n']:>3}  CLV {r['clv_pts']:+.3f} [{lo:+.3f},{hi:+.3f}]  "
                  f"{100 * r['clv_prob']:+.2f}%  ROI {100 * r['roi_at_bet_price']:+.2f}%")
    with open(os.path.join(R.RESULTS, "step4_first_look.json"), "w") as f:
        json.dump(out, f, indent=1, default=R._js)
    return out


if __name__ == "__main__":
    main()
