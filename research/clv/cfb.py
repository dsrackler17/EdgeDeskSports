"""CFB: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section CFB).

  python3 -m research.clv.cfb v2prevqb      # re-run model_loop CFB 2.0.0 with previous-game QBs (cached)
  python3 -m research.clv.cfb pre           # every pre-holdout experiment (B1-B5, R1, R2, W1, W3)
  python3 -m research.clv.cfb holdout       # Phase 6, once, after its entry is written

Lines: the opener books' own open and close (sources.cfb_market). Bets are
graded at -110 both sides (the archive carries no spread prices).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import residual as R
from model_loop.clv import sources as S
from research.clv import runner

SPORT = "cfb"
PRE = [s for s in range(2012, 2025) if s != 2020]
LOOP_DATA = os.path.join(S.ROOT, ".cache", "model_loop", "cfb")
V2_CACHE = os.path.join(S.CACHE, "cfb_v2_prevqb.csv")
POWER = {"ACC", "Big Ten", "Big 12", "SEC", "Pac-12"}


# ------------------------------------------------------------ base models
def v2_prev_qb():
    """model_loop CFB 2.0.0 (the served config), walk-forward, with every
    game's QB input replaced by the QB who started that team's previous game
    (the last starter seen: knowable when the opener is posted). Each team's
    first game in the data has no previous starter and gets no QB term."""
    from model_loop.adapters.cfb import backtest as BT
    from model_loop.adapters.cfb import model as CM
    from model_loop.adapters.cfb.ratings import CfbRatingPass
    cfg = json.load(open(os.path.join(S.ROOT, "docs", "model-loop", "cfb", "versions.json")))
    cfg = next(v for v in cfg["versions"] if v["version"] == cfg["current"])["config"]
    T = BT.Tables(os.path.join(LOOP_DATA, "build"))
    g = T.games.sort_values(["kick_utc", "game_id"]).copy()
    last, over = {}, {}
    for r in g.itertuples(index=False):
        h, a = r.home, r.away
        over[r.game_id] = (last.get(h), last.get(a))
        for team, q in ((h, r.home_qb_id), (a, r.away_qb_id)):
            if isinstance(q, str) and q:
                last[team] = q
    changed = sum(1 for r in g.itertuples(index=False)
                  if (over[r.game_id][0] or None) != (r.home_qb_id if isinstance(r.home_qb_id, str) else None)
                  or (over[r.game_id][1] or None) != (r.away_qb_id if isinstance(r.away_qb_id, str) else None))
    # an absent previous starter must not fall back to the actual one: pass a sentinel id with no rating
    over = {k: (h or "__none__", a or "__none__") for k, (h, a) in over.items()}
    rows, _ = CfbRatingPass(T, cfg["rating"]).run(BT.SEASONS if hasattr(BT, "SEASONS") else sorted(g.season.unique()),
                                                  qb_overrides=over)
    p, info = CM.walk_forward(rows, cfg["model"])
    out = p[["game_id", "season", "week", "pred_margin", "pred_total"]].copy()
    out.to_csv(V2_CACHE, index=False)
    print(f"v2 prev-QB: {len(out)} games, {changed} with a starter different from the previous game's", file=sys.stderr)
    return out


def load():
    d, qa = S.cfb_market()
    d = d[d.played.astype(bool)].copy()
    sched = pd.concat([pd.read_csv(os.path.join(S.CACHE, "cfbdata", "sched", f"sched_{y}.csv"),
                                   usecols=["game_id", "season_type", "home_conference", "away_conference",
                                            "home_team", "away_team", "home_division", "away_division"])
                       for y in range(2012, 2026)])
    d = d.merge(sched.drop(columns=["home_team", "away_team"]), on="game_id", how="left")
    p4 = pd.read_csv(os.path.join(S.ROOT, "model_loop", "adapters", "cfb", "baselines", "cfb_p4_replay_predictions.csv.gz"))
    d = d.merge(p4[["game_id", "fair_spread", "fair_total"]].rename(columns={"fair_spread": "p4", "fair_total": "p4_total"}),
                on="game_id", how="left")
    c1 = pd.read_csv(os.path.join(S.ROOT, "football", "cfb_v2", "candidates", "cfb_v2_candidate_001", "predictions.csv.gz"))
    d = d.merge(c1[["game_id", "ens_equal"]].rename(columns={"ens_equal": "c001"}), on="game_id", how="left")
    if os.path.exists(V2_CACHE):
        v2 = pd.read_csv(V2_CACHE)
        d = d.merge(v2[["game_id", "pred_margin", "pred_total"]].rename(columns={"pred_margin": "v2", "pred_total": "v2_total"}),
                    on="game_id", how="left")
    d["cluster"] = d.season.astype(str) + "-" + d.season_type.fillna("x").astype(str) + "-" + d.week.astype(str)
    hp = d.home_conference.isin(POWER) | d.home_team.eq("Notre Dame")
    ap = d.away_conference.isin(POWER) | d.away_team.eq("Notre Dame")
    # Pac-12 counts as Power through 2023 only
    pac = d.season >= 2024
    hp &= ~(pac & d.home_conference.eq("Pac-12"))
    ap &= ~(pac & d.away_conference.eq("Pac-12"))
    d["nonpower"] = (~hp & ~ap).astype(float)
    d["fcs"] = (~d.home_fbs.astype(bool) | ~d.away_fbs.astype(bool)).astype(float)
    d["early"] = (d.week <= 4).astype(float) * d.season_type.eq("regular")
    return d, qa


def sigma(d, col, res):
    x = d[d.season.isin(PRE)]
    return float((x[res] - x[col]).std())


def cfg_points(d, market, thr, model_kind="base"):
    if market == "spread":
        dist = H.IntegerNormal(sigma(d, "close_line_cons", "margin"))
        return H.HarnessConfig(kind="points", market="spread", thresholds=(thr, 1.0, 3.0, 5.0) if model_kind == "base"
                               else (thr, 0.5, 1.0), primary=thr, dist=dist,
                               buckets=(0, 1, 2, 3, 5, 8, H.INF) if model_kind == "base" else (0, 0.25, 0.5, 1, H.INF))
    dist = H.IntegerNormal(sigma(d, "close_total_cons", "total_pts"))
    return H.HarnessConfig(kind="points", market="total", thresholds=(thr, 1.0, 3.0, 5.0) if model_kind == "base"
                           else (thr, 0.5, 1.0), primary=thr, dist=dist,
                           buckets=(0, 1, 2, 3, 5, 8, H.INF) if model_kind == "base" else (0, 0.25, 0.5, 1, H.INF))


def frame(d, model_col, market="spread"):
    x = d.copy()
    if market == "spread":
        x = x.rename(columns={})
        x["model_line"] = x[model_col]
    else:
        x["open_line"], x["close_line"], x["result"] = x.open_total, x.close_total, x.total_pts
        x["model_line"] = x[model_col]
    return x[["season", "game_id", "cluster", "open_line", "close_line", "model_line", "result", "nonpower", "fcs", "early"]]


def residual(d, base_cols, extra, market, seasons):
    x = frame(d, base_cols[0], market)
    feats = []
    for c in base_cols:
        x[f"d_{c}"] = (d[c] - (d.open_line if market == "spread" else d.open_total)).values
        feats.append(f"d_{c}")
    if extra:
        x["open_lvl"] = x.open_line
        x["d_early"] = x[f"d_{base_cols[0]}"] * x.early
        x["d_nonpower"] = x[f"d_{base_cols[0]}"] * x.nonpower
        x["d_fcs"] = x[f"d_{base_cols[0]}"] * x.fcs
        feats += ["open_lvl", "d_early", "d_nonpower", "d_fcs"]
    x["move"] = x.close_line - x.open_line
    x = x[x[feats].notna().all(axis=1) & x.season.isin(seasons)]
    pred, log = R.walk_forward(x, feats, "move", seasons, min_train_seasons=3)
    x["pred_move"] = pred
    x = x[x.pred_move.notna()].copy()
    x["model_line"] = x.open_line + x.pred_move
    cal = H.movement_calibration(x.pred_move, x.move)
    return x, log, cal


def pre():
    d, qa = load()
    d = d[d.season.isin(PRE)].copy()
    out = {}
    have_v2 = "v2" in d
    runs = [("CFB-B1", "p4", "spread", "production cfb_p4 v1.0.1 spread"),
            ("CFB-B2", "p4_total", "total", "production cfb_p4 v1.0.1 total"),
            ("CFB-B5", "c001", "spread", "shadow cfb_v2_candidate_001 ens_equal spread")]
    if have_v2:
        runs += [("CFB-B3", "v2", "spread", "model_loop CFB 2.0.0, previous-game QB, spread"),
                 ("CFB-B4", "v2_total", "total", "model_loop CFB 2.0.0, previous-game QB, total")]
    for eid, col, mk, label in runs:
        x = frame(d, col, mk)
        rep = runner.run(SPORT, eid, x, cfg_points(d, mk, 2.0), label)
        out[eid] = runner.fmt(rep)
        print(eid, out[eid])
    if have_v2:
        for eid, extra, label in (("CFB-R1", False, "residual ridge on d_p4, d_v2 (spread)"),
                                  ("CFB-R2", True, "R1 + information block (spread)")):
            x, log, cal = residual(d, ["p4", "v2"], extra, "spread", PRE)
            rep = runner.run(SPORT, eid, x, cfg_points(d, "spread", 0.25, "resid"), label,
                             extra={"fit_log": log, "movement_calibration": cal})
            out[eid] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
            print(eid, out[eid])
            if eid == "CFB-R1":
                r1 = x
            else:
                r2 = x
        # R2 vs R1 paired on the same games
        both = r1[["game_id", "pred_move", "move"]].merge(r2[["game_id", "pred_move"]], on="game_id", suffixes=("_r1", "_r2"))
        out["R2_vs_R1_same_games"] = int(len(both))
        x = r1[r1.nonpower == 1]
        rep = runner.run(SPORT, "CFB-W1", x, cfg_points(d, "spread", 0.25, "resid"), "R1 restricted to non-Power games",
                         extra={"movement_calibration": H.movement_calibration(x.pred_move, x.move)})
        out["CFB-W1"] = runner.fmt(rep)
        print("CFB-W1", out["CFB-W1"])
        x, log, cal = residual(d, ["p4_total", "v2_total"], False, "total", PRE)
        rep = runner.run(SPORT, "CFB-W3", x, cfg_points(d, "total", 0.25, "resid"), "totals residual ridge on dt_p4, dt_v2",
                         extra={"fit_log": log, "movement_calibration": cal})
        out["CFB-W3"] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
        print("CFB-W3", out["CFB-W3"])
    return out


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "v2prevqb":
        v2_prev_qb()
    elif cmd == "pre":
        print(json.dumps(pre(), indent=1))
