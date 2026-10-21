"""Phase 6: the holdout gate, exactly as preregistered in
research/clv_early_week/EXPERIMENTS.md (H-1..H-5). Run ONCE:

  python3 -m model_loop.clv_early.phase6 --unlock-holdout
"""
import argparse
import json
import os

from . import run as R

K = 5
ALPHA = 0.05 / K
HOLDOUT = [2025, 2026]
CANDIDATES = [
    ("H-1", "nfl", "spread", "pred_nfl_v21.csv", 2.0, "NFL v2.1.0 spread (holdout)"),
    ("H-2", "nfl", "spread", "pred_nfl_loop.parquet", 2.0, "NFL Loop v2.0.0 spread (holdout)"),
    ("H-3", "nfl", "total", "pred_nfl_v21.csv", 2.0, "NFL v2.1.0 total (holdout)"),
    ("H-4", "cfb", "spread", "pred_cfb_loop_lag1.parquet", 3.0, "CFB Loop v2.0.0 W-2 spread (holdout)"),
    ("H-5", "cfb", "total", "pred_cfb_loop_lag1.parquet", 3.0, "CFB Loop v2.0.0 W-2 total (holdout)"),
]


def gate(r):
    lo = r["clv_pts_ci95"][0]
    return {"n_ok": r["n"] >= 50, "lower_bound_ok": lo is not None and lo > 0,
            "perm_ok": r["permutation"]["p_value"] <= ALPHA, "prob_ok": r["clv_prob"] > 0}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--unlock-holdout", action="store_true", required=True)
    a = ap.parse_args(argv)
    out = []
    for hid, sport, market, pred, thr, label in CANDIDATES:
        df = R.frame(sport, R.read_pred(os.path.join(R.CACHE, pred)), market, seasons=HOLDOUT,
                     unlock=a.unlock_holdout, fresh=(sport == "nfl"))
        rec = R.score(df, sport, market, thr, label, hid, n_boot=4000, n_perm=2000, ci_level=1 - 2 * ALPHA,
                      extra={"pred": pred, "seasons": HOLDOUT, "k": K, "alpha": ALPHA,
                             "note": "clv_pts_ci95 holds the 98% two-sided interval: its lower end is the one-sided 99% bound"})
        g = gate(rec["primary"])
        passed = all(g.values())
        rec["gate"] = {**g, "PASS": passed}
        with open(os.path.join(R.RESULTS, f"{R.slug(hid)}__{R.slug(label)}.json"), "w") as f:
            json.dump(rec, f, indent=1, default=R._js)
        r = rec["primary"]
        print(f"{hid} {label}: bets {r['n']}, CLV {r['clv_pts']:+.3f} pts, one-sided 99% lower {r['clv_pts_ci95'][0]:+.3f}, "
              f"prob {100 * r['clv_prob']:+.2f}%, perm p {r['permutation']['p_value']:.4f}, dir-hit {r['hit_rate']:.3f}, "
              f"ROI {100 * r['roi_at_bet_price']:+.2f}% -> {'PASS' if passed else 'FAIL'} {g}")
        for s in r["by_season"]:
            print(f"    {s['season']}: bets {s['n']}, CLV {s['clv_pts']:+.3f}, prob {100 * s['clv_prob']:+.2f}%, hit {s['hit_rate']:.3f}")
        out.append({"id": hid, "label": label, "PASS": passed, **{k: r[k] for k in ("n", "clv_pts", "clv_prob", "hit_rate", "roi_at_bet_price")},
                    "lower_99": r["clv_pts_ci95"][0], "perm_p": r["permutation"]["p_value"], "by_season": r["by_season"]})
    with open(os.path.join(R.RESULTS, "phase6_holdout_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=R._js)


if __name__ == "__main__":
    main()
