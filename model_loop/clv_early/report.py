"""Compact tables from the scorecards in docs/model-loop/clv_early/results/ (for
EXPERIMENTS.md and FINAL_REPORT.md)."""
import glob
import json
import os
import sys

from .run import RESULTS


def load(name):
    p = name if name.endswith(".json") else os.path.join(RESULTS, name + ".json")
    return json.load(open(p))


def fmt_ci(ci, pct=False):
    if not ci or ci[0] is None:
        return "—"
    k = 100 if pct else 1
    return f"[{k * ci[0]:+.2f}, {k * ci[1]:+.2f}]"


def headline(r):
    return (f"| {r['label']} | {r['threshold']:g} | {r['n']} | **{r['clv_pts']:+.3f}** {fmt_ci(r['clv_pts_ci95'])} | "
            f"{100 * r['clv_prob']:+.2f}% {fmt_ci(r['clv_prob_ci95'], True)} | {r['hit_rate']:.3f} | "
            f"{r['permutation']['p_value']:.3f} | {100 * r.get('roi_at_bet_price', float('nan')):+.2f}% |")


def detail(rec):
    r = rec["primary"]
    out = [f"**{r['label']}** — buckets (all games with a non-zero edge): " + "; ".join(
        f"{b['bucket']}: n {b['n']}, {b['clv_pts']:+.3f} pts, hit {b['hit_rate']:.3f}" for b in r["buckets"])]
    out.append("per season (bets, CLV pts): " + "; ".join(f"{s['season']}: {s['n']}, {s['clv_pts']:+.3f}" for s in r["by_season"]))
    m = r["movement"]
    out.append(f"movement slope {m['slope']:+.3f} (corr {m['corr']:+.3f}, n {m['n']}); diagnostics: " +
               ", ".join(f"{k} {v:.3f}" if isinstance(v, float) else f"{k} {v}" for k, v in r["diagnostics"].items()))
    return "\n".join(out)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        for f in sorted(glob.glob(os.path.join(RESULTS, name + "*.json"))):
            rec = load(f)
            print(headline(rec["primary"]))
            for s in rec.get("sweep", []):
                print(headline(s))
            print(detail(rec))
            print()


def ledger_rows(path=None):
    """The variant ledger as markdown rows: one per unique (experiment, label,
    threshold), in first-run order, with how many times it was scored."""
    path = path or os.path.join(RESULTS, "ledger.jsonl")
    seen, order = {}, []
    for line in open(path):
        r = json.loads(line)
        k = (r["exp"], r["label"], r["threshold"])
        if k not in seen:
            order.append(k)
            seen[k] = {"r": r, "runs": 0}
        seen[k]["runs"] += 1
        seen[k]["r"] = r
    rows = []
    for i, k in enumerate(order, 1):
        r, n = seen[k]["r"], seen[k]["runs"]
        lo = r["clv_pts_ci95"][0] if r["clv_pts_ci95"] and r["clv_pts_ci95"][0] is not None else float("nan")
        called = lo > 0 and r["perm_p"] is not None and r["perm_p"] <= 0.05 and r["clv_prob"] > 0
        rows.append(f"| {i} | {r['exp']} | {r['label']} | {r['market']} | {r['threshold']:g} | "
                    f"{'primary' if r['primary'] else 'sweep'} | {r['n']} | {r['clv_pts']:+.3f} | "
                    f"{'CLV>0' if called else 'no'} | {n} |")
    return rows
