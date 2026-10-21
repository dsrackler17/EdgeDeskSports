"""The final verdict (EXPERIMENTS.md G7) for every holdout run, re-applied at
each sport's FINAL attempt count k (research/clv/results/attempts.jsonl),
with the cluster-bootstrap standard error the holdout run itself measured.

  python3 -m research.clv.verdicts      -> research/clv/results/final_verdicts.json
"""
import json
import os

from research.clv import runner


def adjusted(rep, k, metric="clv_prob"):
    """Lower one-sided bound at alpha/k from the normal approximation with the
    run's cluster-bootstrap SE (the percentile bound needs the draws; the two
    agree to the third decimal at the run's own k, checked below)."""
    s = rep["primary"].get(metric) or {}
    if s.get("mean") is None or not s.get("se"):
        return None
    from statistics import NormalDist
    z = NormalDist().inv_cdf(1 - 0.05 / k)
    return s["mean"] - z * s["se"]


def main():
    out = {}
    for sport in ("cfb", "nfl", "nba", "nhl", "mlb", "wnba", "ncaam"):
        k = runner.k_sport(sport)
        d = os.path.join(runner.RESULTS, sport)
        if not os.path.isdir(d):
            continue
        rows = []
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json") or not ("-H" in fn or "-P" in fn) or fn.endswith("_2026.json") or "summary" in fn:
                continue
            rep = json.load(open(os.path.join(d, fn)))
            p = rep["primary"]
            n = p.get("n_bets", 0)
            lb_k = adjusted(rep, k)
            lb_run = (p.get("clv_prob") or {}).get("lb_adjusted")
            lb_run_normal = adjusted(rep, (p.get("clv_prob") or {}).get("k_tests", 1))
            pts_ok = (p.get("clv_pts") or {}).get("mean", 1) > 0 if "clv_pts" in p else True
            verdict = "INCONCLUSIVE" if n < 50 else ("PASS" if (lb_k is not None and lb_k > 0 and pts_ok) else "FAIL")
            rows.append({"id": rep["exp_id"], "label": rep["label"], "market": rep["market"], "n_bets": n,
                         "clv_prob": p.get("clv_prob"), "clv_pts": p.get("clv_pts"), "clv_ev": p.get("clv_ev"),
                         "k_final": k, "lb_final_normal": lb_k, "lb_at_run_percentile": lb_run, "lb_at_run_normal": lb_run_normal,
                         "verdict_final": verdict, "by_season": rep.get("by_season")})
        out[sport] = {"k": k, "holdout": rows}
    with open(os.path.join(runner.RESULTS, "final_verdicts.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)
    for s, v in out.items():
        for r in v["holdout"]:
            c = r["clv_prob"] or {}
            print(f"{r['id']:10s} k={v['k']:2d} n={r['n_bets']:5d} clv {100 * (c.get('mean') or 0):+.2f} pp  "
                  f"LB(k) {100 * (r['lb_final_normal'] or 0):+.2f}  LB(run, pct) {100 * (r['lb_at_run_percentile'] or 0):+.2f}  "
                  f"-> {r['verdict_final']}")


if __name__ == "__main__":
    main()
