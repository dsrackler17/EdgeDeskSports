"""Runs a pre-registered CLV experiment and logs it.

  - refuses an experiment ID that EXPERIMENTS.md does not pre-register;
  - refuses to read a locked holdout season unless the call is the sport's
    registered Phase 6 run (its ID has a '-H' suffix and a pre-registration);
  - appends every run to research/clv/results/attempts.jsonl (the count the
    multiple-testing penalty uses) and writes the full report to
    research/clv/results/<sport>/<exp_id>.json.
"""
import datetime as dt
import json
import os
import re

from model_loop.clv import harness as H
from model_loop.clv.sources import ROOT

RESULTS = os.path.join(ROOT, "research", "clv", "results")
EXPERIMENTS = os.path.join(ROOT, "EXPERIMENTS.md")

# G4: every season a sport locks until its Phase 6 entry
LOCKED = {
    "cfb": {2025, 2026},
    "nfl": {2020, 2021, 2025, 2026},
    "nba": {2026, 2027},
    "nhl": {2021, 2022, 2026, 2027},
    "mlb": {2020, 2021, 2025, 2026},
    "wnba": {2025, 2026},
    "ncaam": {2026, 2027},
}


def preregistered(exp_id):
    with open(EXPERIMENTS) as f:
        return re.search(rf"^### {re.escape(exp_id)}:", f.read(), re.M) is not None


def attempts(sport=None):
    p = os.path.join(RESULTS, "attempts.jsonl")
    if not os.path.exists(p):
        return []
    rows = [json.loads(l) for l in open(p) if l.strip()]
    return [r for r in rows if sport is None or r["sport"] == sport]


def k_sport(sport):
    return len({r["exp_id"] for r in attempts(sport)})


def _brief(rep):
    p = rep["primary"]
    out = {"n_bets": p.get("n_bets", 0)}
    for m in ("clv_prob", "clv_pts", "clv_ev"):
        if m in p:
            out[m] = {k: p[m].get(k) for k in ("mean", "ci95", "p_one_sided", "lb_adjusted", "k_tests") if k in p[m]}
    if "direction_hit_rate" in p:
        out["direction_hit_rate"] = p["direction_hit_rate"]["mean"]
    return out


def run(sport, exp_id, df, cfg, label, holdout=False, notes=None, k_tests=1, extra=None, log=True):
    if not preregistered(exp_id):
        raise SystemExit(f"{exp_id} is not pre-registered in EXPERIMENTS.md")
    seasons = set(int(s) for s in df.season.dropna().unique())
    locked = seasons & LOCKED.get(sport, set())
    if locked and not holdout:
        raise SystemExit(f"{exp_id} would read locked holdout seasons {sorted(locked)}")
    if holdout and not re.search(r"-H\d*$", exp_id):
        raise SystemExit(f"holdout runs must use a registered Phase 6 ID (<SPORT>-H<n>), got {exp_id}")
    rep = H.evaluate(df, cfg, k_tests=k_tests, label=label)
    rep["exp_id"], rep["sport"], rep["holdout"] = exp_id, sport, holdout
    rep["seasons"] = sorted(seasons)
    if extra:
        rep["extra"] = extra
    os.makedirs(os.path.join(RESULTS, sport), exist_ok=True)
    with open(os.path.join(RESULTS, sport, f"{exp_id}.json"), "w") as f:
        json.dump(rep, f, indent=1, default=float)
    if log:
        row = {"at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sport": sport, "exp_id": exp_id,
               "label": label, "market": cfg.market, "kind": cfg.kind, "threshold": cfg.primary, "holdout": holdout,
               "seasons": sorted(seasons), "k_tests": k_tests, "notes": notes, **_brief(rep)}
        with open(os.path.join(RESULTS, "attempts.jsonl"), "a") as f:
            f.write(json.dumps(row, default=float) + "\n")
    return rep


def fmt(rep, kind="points"):
    """One-line summary for EXPERIMENTS.md."""
    p = rep["primary"]
    if not p.get("n_bets"):
        return "0 bets"
    s = [f"n={p['n_bets']}"]
    if "clv_pts" in p:
        c = p["clv_pts"]
        s.append(f"CLV {c['mean']:+.3f} pts [{c['ci95'][0]:+.3f}, {c['ci95'][1]:+.3f}]")
    c = p["clv_prob"]
    s.append(f"CLV {100 * c['mean']:+.2f} pp [{100 * c['ci95'][0]:+.2f}, {100 * c['ci95'][1]:+.2f}], p={c['p_one_sided']:.3g}")
    if "lb_adjusted" in c:
        s.append(f"alpha/{c['k_tests']} LB {100 * c['lb_adjusted']:+.2f} pp")
    if "direction_hit_rate" in p:
        s.append(f"toward {p['direction_hit_rate']['mean']:.3f}")
    return "; ".join(s)
