"""Registers every candidate that passed its holdout gate for live CLV
tracking (EXPERIMENTS.md G9), once, after Phase 6:

  research/clv/live/registry.json       the frozen rule of every tracked candidate
                                        (inputs, coefficients, threshold, distribution)
  docs/model-loop/<sport>/versions.json  a CANDIDATE (CLV live tracking) entry for each
                                        challenger, where the sport has a version history;
                                        `current` (what is served) is never touched

  python3 -m research.clv.register      (needs the study caches; run locally)
"""
import json
import os
import time

from model_loop.core.walkforward import content_hash
from research.clv import runner

ROOT = runner.RESULTS.rsplit("/research/", 1)[0]
REG = os.path.join(ROOT, "research", "clv", "live", "registry.json")


def fit(sport, eid):
    return json.load(open(os.path.join(runner.RESULTS, sport, f"{eid}.json")))["extra"]["fit"]


def holdout(sport, eid):
    r = json.load(open(os.path.join(runner.RESULTS, sport, f"{eid}.json")))
    p = r["primary"]
    return {"n_bets": p.get("n_bets"), "clv_prob": p.get("clv_prob"), "clv_pts": p.get("clv_pts"),
            "clv_ev": (p.get("clv_ev") or {}).get("mean"), "seasons": r.get("seasons")}


def sigmas():
    from research.clv import cfb, nfl, nhl, nba
    out = {}
    d, _ = cfb.load()
    out["cfb_spread"], out["cfb_total"] = cfb.sigma(d, "close_line_cons", "margin"), cfb.sigma(d, "close_total_cons", "total_pts")
    m, _, _ = nfl.load()
    km, tn = nfl.dists(m[m.season.isin(nfl.PRE)])
    out["nfl_spread_keynumber"], out["nfl_total"] = km.to_json(), tn.sigma
    return out


def candidates(sig, nba_cands=None):
    C = []
    pts = lambda s: {"type": "normal", "sigma": round(float(s), 4)}
    C += [
        {"id": "CFB-H1", "sport": "cfb", "market": "spread", "kind": "points", "rule": "base", "input": "p4", "threshold": 2.0,
         "dist": pts(sig["cfb_spread"]), "frame": "cfb", "label": "production cfb_p4 v1.0.1 vs the opener", "challenger": False},
        {"id": "CFB-H2", "sport": "cfb", "market": "total", "kind": "points", "rule": "base", "input": "p4_total", "threshold": 2.0,
         "dist": pts(sig["cfb_total"]), "frame": "cfb", "label": "production cfb_p4 v1.0.1 total vs the opener", "challenger": False},
        dict({"id": "CFB-H3", "sport": "cfb", "market": "spread", "kind": "points", "rule": "residual", "threshold": 0.25,
              "dist": pts(sig["cfb_spread"]), "frame": "cfb", "label": "CFB-R2 market-residual (p4 + loop v2 disagreement, information block)",
              "features": {"d_p4": "p4", "d_v2": "v2", "open_lvl": "open_lvl"},
              "interactions": {"d_early": ["d_p4", "early"], "d_nonpower": ["d_p4", "nonpower"], "d_fcs": ["d_p4", "fcs"]},
              "challenger": True, "parent_loop": "cfb"}, **fit("cfb", "CFB-H3")),
        dict({"id": "CFB-H4", "sport": "cfb", "market": "total", "kind": "points", "rule": "residual", "threshold": 0.25,
              "dist": pts(sig["cfb_total"]), "frame": "cfb", "label": "CFB-W3 totals market-residual (p4 + loop v2)",
              "features": {"d_p4_total": "p4_total", "d_v2_total": "v2_total"}, "challenger": True, "parent_loop": "cfb"},
             **fit("cfb", "CFB-H4")),
        {"id": "NFL-H1", "sport": "nfl", "market": "spread", "kind": "points", "rule": "base", "input": "v21", "threshold": 1.0,
         "dist": {"type": "keynumber", "json": sig["nfl_spread_keynumber"]}, "frame": "nfl",
         "label": "production edgedesk_nfl_v2.1.0 vs the opener", "challenger": False},
        {"id": "NFL-H2", "sport": "nfl", "market": "total", "kind": "points", "rule": "base", "input": "v21_total", "threshold": 1.5,
         "dist": pts(sig["nfl_total"]), "frame": "nfl", "label": "production edgedesk_nfl_v2.1.0 total vs the opener", "challenger": False},
        dict({"id": "NFL-H3", "sport": "nfl", "market": "spread", "kind": "points", "rule": "residual", "threshold": 0.25,
              "dist": {"type": "keynumber", "json": sig["nfl_spread_keynumber"]}, "frame": "nfl",
              "label": "NFL-R1 market-residual (v2.1.0 + loop disagreement)", "features": {"d_v21": "v21", "d_loop": "loop"},
              "challenger": True, "parent_loop": "nfl"}, **fit("nfl", "NFL-H3")),
        dict({"id": "NFL-H4", "sport": "nfl", "market": "total", "kind": "points", "rule": "residual", "threshold": 0.25,
              "dist": pts(sig["nfl_total"]), "frame": "nfl", "label": "NFL-W2 totals market-residual (v2.1.0 + loop)",
              "features": {"d_v21_total": "v21_total", "d_loop_total": "loop_total"}, "challenger": True, "parent_loop": "nfl"},
             **fit("nfl", "NFL-H4")),
        {"id": "NHL-H1", "sport": "nhl", "market": "moneyline", "kind": "price", "rule": "base", "input": "p_core", "threshold": 0.02,
         "frame": "nhl", "label": "production edgedesk_nhl_v1 (xg_core) moneyline vs the earliest DraftKings line", "challenger": False},
        dict({"id": "NHL-H3", "sport": "nhl", "market": "moneyline", "kind": "price", "rule": "residual", "threshold": 0.005,
              "frame": "nhl", "label": "NHL-W2: moneyline market-residual (production + projected goalie) on one-team back-to-backs",
              "features": {"d_p_core": "p_core", "d_p_gproj": "p_gproj"}, "filter": "b2b_one", "challenger": True}, **fit("nhl", "NHL-H3")),
        {"id": "NHL-H2", "sport": "nhl", "market": "total", "kind": "points", "rule": "base", "input": "t_core", "threshold": 0.3,
         "dist": {"type": "normal", "sigma": 2.3}, "frame": None, "label": "production xg_core total (line only)", "challenger": False,
         "live_note": "not tracked live: low-confidence line-only test, and the slate carries no per-model total to capture"},
        {"id": "NHL-H4", "sport": "nhl", "market": "total", "kind": "points", "rule": "residual", "threshold": 0.05,
         "dist": {"type": "normal", "sigma": 2.3}, "frame": None, "label": "NHL-W3 totals market-residual (line only)", "challenger": True,
         "coef": {}, "intercept": 0.0, "live_note": "not tracked live: low-confidence line-only test"},
        {"id": "MLB-H1", "sport": "mlb", "market": "moneyline", "kind": "price", "rule": "base", "input": "p_proj", "threshold": 0.02,
         "frame": None, "label": "MLB lab model (projected starter) moneyline", "challenger": False,
         "live_note": "the 2026 season is over; tracking starts with the 2027 season (the lab model prices no live game yet)"},
        dict({"id": "MLB-H2", "sport": "mlb", "market": "moneyline", "kind": "price", "rule": "residual", "threshold": 0.005,
              "frame": None, "label": "MLB-R2 moneyline market-residual", "challenger": True, "parent_loop": "mlb",
              "base_version": "1.0.0",
              "features": {"d_proj": "p_proj", "d_tp": "p_team_park"},
              "live_note": ("the 2026 season is over; its evidence was built on the lab loop's 1.0.0 inputs, and the loop "
                            "has since served 1.1.0, so re-derive it on 1.1.0 before tracking the 2027 season")}, **fit("mlb", "MLB-H2")),
        {"id": "NCAAM-H1", "sport": "ncaam", "market": "spread", "kind": "points", "rule": "base", "input": "lab", "threshold": 1.5,
         "dist": pts(10.5), "frame": "ncaam", "label": "production bb_points (NCAAM 1.1.0) spread", "challenger": False},
        {"id": "NCAAM-H2", "sport": "ncaam", "market": "total", "kind": "points", "rule": "base", "input": "lab_total", "threshold": 2.0,
         "dist": pts(15.5), "frame": "ncaam", "label": "production bb_points (NCAAM 1.1.0) total", "challenger": False},
        {"id": "NCAAM-H3", "sport": "ncaam", "market": "moneyline", "kind": "price", "rule": "base", "input": "lab_p", "threshold": 0.02,
         "frame": "ncaam", "label": "production bb_points (NCAAM 1.1.0) moneyline", "challenger": False},
        {"id": "WNBA-H2", "sport": "wnba", "market": "total", "kind": "points", "rule": "base", "input": "lab_total", "threshold": 2.0,
         "dist": pts(15.0), "frame": None, "label": "production bb_points (WNBA 1.0.0) total", "challenger": False,
         "live_note": "the WNBA Finals end by 2026-11-01; tracking resumes with the 2027 season"},
    ]
    C += nba_cands or []
    for c in C:
        c["status"] = "CANDIDATE (CLV live tracking)" if c["challenger"] else "PRODUCTION (CLV live tracking)"
        c["holdout"] = holdout(c["sport"], c["id"])
    return C + edge_candidates(sig)


EDGE_RESULTS = os.path.join(ROOT, "docs", "model-loop", "clv_early", "results")


def edge_holdout(hid):
    """The early-week study's holdout record (research/clv_early_week/EXPERIMENTS.md, Phase 6)."""
    import glob
    f = sorted(glob.glob(os.path.join(EDGE_RESULTS, f"{hid.replace('-', '_')}__*.json")))[0]
    p = json.load(open(f))["primary"]
    return {"n_bets": p["n"], "clv_prob": {"n": p["n"], "mean": round(p["clv_prob"], 5), "ci98": p["clv_prob_ci95"]},
            "clv_pts": {"n": p["n"], "mean": round(p["clv_pts"], 5), "ci98": p["clv_pts_ci95"]},
            "clv_ev": round(p["roi_at_bet_price"], 5), "seasons": [2025, 2026],
            "source": os.path.relpath(f, ROOT)}


def edge_candidates(sig):
    """The three rules that passed the early-week study's own holdout gate. They
    are graded by the same frozen-rule machinery; the CFB pair reads the loop's
    number as published before week W-1 kicked off (live.py loop_w2)."""
    pts = lambda s: {"type": "normal", "sigma": round(float(s), 4)}
    C = [
        {"id": "EDGE-H3", "sport": "nfl", "market": "total", "kind": "points", "rule": "base", "input": "v21_total",
         "threshold": 2.0, "dist": pts(sig["nfl_total"]), "frame": "nfl", "challenger": False, "study_id": "H-3",
         "label": "early-week study H-3: production edgedesk_nfl_v2.1.0 total, edge >= 2"},
        {"id": "EDGE-H4", "sport": "cfb", "market": "spread", "kind": "points", "rule": "base", "input": "v2_w2",
         "threshold": 3.0, "dist": pts(sig["cfb_spread"]), "frame": "cfb", "challenger": True, "study_id": "H-4",
         "label": "early-week study H-4: CFB loop v2.0.0 as published before week W-1, edge >= 3 vs the opener"},
        {"id": "EDGE-H5", "sport": "cfb", "market": "total", "kind": "points", "rule": "base", "input": "v2_w2_total",
         "threshold": 3.0, "dist": pts(sig["cfb_total"]), "frame": "cfb", "challenger": True, "study_id": "H-5",
         "label": "early-week study H-5: CFB loop v2.0.0 total as published before week W-1, edge >= 3 vs the opener"},
    ]
    for c in C:
        c["status"] = "CANDIDATE (CLV live tracking)" if c["challenger"] else "PRODUCTION (CLV live tracking)"
        c["holdout"] = edge_holdout(c["study_id"])
    return C + edge_forward(sig)


EDGE_FORWARD_FROM = "2026-10-21T17:18:50Z"     # the step-4 preregistration commit (research/clv_early_week/EXPERIMENTS.md)


def edge_forward(sig):
    """Step 4's forward variants: graded only on games that kick off after their
    preregistration; judged at 100 bets or the end of the 2026 season (k = 5)."""
    pts = lambda s: {"type": "normal", "sigma": round(float(s), 4)}
    gate = ("forward gate (research/clv_early_week/EXPERIMENTS.md, step 4): at 100 graded bets or season's end, "
            "PASS = mean clv_pts > 0, clv_prob one-sided p <= 0.01 (0.05/5), n >= 100")
    C = [
        {"id": "EDGE-L1", "sport": "cfb", "market": "spread", "kind": "points", "rule": "base", "input": "v2", "threshold": 3.0,
         "dist": pts(sig["cfb_spread"]), "frame": "cfb",
         "label": "step 4 L1: CFB loop v2.0.0 at the Lab's OPEN checkpoint (week W-1 inputs), edge >= 3, timestamped opener"},
        {"id": "EDGE-L2", "sport": "cfb", "market": "total", "kind": "points", "rule": "base", "input": "v2_total", "threshold": 3.0,
         "dist": pts(sig["cfb_total"]), "frame": "cfb",
         "label": "step 4 L2: CFB loop v2.0.0 total at the Lab's OPEN checkpoint, edge >= 3, timestamped opener"},
        {"id": "EDGE-B1", "sport": "cfb", "market": "total", "kind": "points", "rule": "base", "input": "v2_w2_total", "threshold": 5.0,
         "dist": pts(sig["cfb_total"]), "frame": "cfb", "label": "step 4 B1: H-5 (CFB loop W-2 total) at edge >= 5"},
        {"id": "EDGE-B2", "sport": "cfb", "market": "spread", "kind": "points", "rule": "base", "input": "v2_w2", "threshold": 5.0,
         "dist": pts(sig["cfb_spread"]), "frame": "cfb", "label": "step 4 B2: H-4 (CFB loop W-2 spread) at edge >= 5"},
        {"id": "EDGE-B3", "sport": "nfl", "market": "total", "kind": "points", "rule": "base", "input": "v21_total", "threshold": 3.0,
         "dist": pts(sig["nfl_total"]), "frame": "nfl", "label": "step 4 B3: H-3 (NFL v2.1.0 total) at edge >= 3"},
    ]
    for c in C:
        c.update({"challenger": True, "status": "CANDIDATE (CLV live tracking, forward test)", "track_from": EDGE_FORWARD_FROM,
                  "gate": gate, "holdout": None})
    return C


def register_versions(C):
    """A challenger's entry in its sport's model-loop version history. `current` never moves."""
    done = []
    for c in C:
        if not c["challenger"] or not c.get("parent_loop"):
            continue
        path = os.path.join(ROOT, "docs", "model-loop", c["parent_loop"], "versions.json")
        if not os.path.exists(path):
            continue
        raw = open(path).read()
        doc = json.loads(raw)
        base = c.get("base_version", doc["current"])
        label = f"{base}+clv.{c['id'].lower()}"
        if any(v["version"] == label for v in doc["versions"]):
            continue
        cfg = {k: c[k] for k in ("market", "kind", "rule", "threshold", "features", "interactions", "coef", "intercept", "lambda", "filter")
               if k in c}
        doc["versions"].append({
            "version": label, "parent": base, "config": {"clv_candidate": cfg},
            "config_sha256": content_hash({"clv_candidate": cfg}), "status": "CANDIDATE (CLV live tracking)",
            "promoted_by": "clv-programme", "promoted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "reason": (f"{c['label']}: passed its pre-registered CLV holdout gate ({c['id']}, EXPERIMENTS.md). "
                       "Tracked live against the opener by research/clv/live.py; never served, and `current` is unchanged."),
            "evidence": {"holdout": c["holdout"], "registry": "research/clv/live/registry.json"}})
        with open(path, "w") as f:
            json.dump(doc, f, indent=1)
            if raw.endswith("\n"):
                f.write("\n")
        done.append((c["parent_loop"], label))
    return done


def main(nba_cands=None):
    C = candidates(sigmas(), nba_cands)
    os.makedirs(os.path.dirname(REG), exist_ok=True)
    with open(REG, "w") as f:
        json.dump({"schema": "edgedesk_clv_live_registry_v1", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "rule": "Every candidate here passed its pre-registered holdout CLV gate (EXPERIMENTS.md). It is tracked live "
                           "against the opener and graded at the last pregame line. Nothing here is served or priced on the board.",
                   "candidates": C}, f, indent=1, default=float)
    print("registered", len(C), "candidates; version entries:", register_versions(C))


if __name__ == "__main__":
    main()
