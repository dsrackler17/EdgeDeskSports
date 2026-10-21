"""Phase 4 runner: the market-residual experiments exactly as preregistered in
EXPERIMENTS.md (E-101..E-114, E-120).

  python3 -m model_loop.clv_early.phase4 nfl E-101 base
  python3 -m model_loop.clv_early.phase4 nfl E-102 base,qb --comparator E-101
  python3 -m model_loop.clv_early.phase4 cfb E-111 base
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import harness as H
from . import residual as RS
from . import run as R

LAM = 25.0
THETA = 0.25
EVAL = {"nfl": [2021, 2022, 2023, 2024], "cfb": [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024]}
TRAIN_FROM = {"nfl": 2020, "cfb": 2012}
BASE = {"nfl": os.path.join(R.CACHE, "pred_nfl_loop.parquet"), "cfb": os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet")}
COMP_BASELINE = {"nfl": 2.0, "cfb": 3.0}
_ROWS = {}


def rows(sport, market="spread"):
    """Every eligible development game with a target, the base model's number
    and every feature group (R-1 fresh lines for the NFL)."""
    k = (sport, market)
    if k in _ROWS:
        return _ROWS[k]
    base = R.read_pred(BASE[sport])
    F = RS.nfl_features(base, market) if sport == "nfl" else RS.cfb_features(base, market)
    F["game_id"] = F.game_id.astype(str)
    el = R.eligibility(sport)
    F = F[F.game_id.map(el).fillna(False).astype(bool)]
    F = F[(F.season >= TRAIN_FROM[sport]) & (F.season <= 2024)]
    if sport == "nfl":
        L = R.lines("nfl")
        fresh = set(L.game_id[R.fresh_mask(L, market)])
        F = F[F.game_id.isin(fresh)]
    F = F[F.y.notna() & F.base.notna()].copy()
    _ROWS[k] = F
    return F


def predict(sport, groups, market="spread", interactions=False):
    F = rows(sport, market).copy()
    cols = [c for g in groups for c in RS.GROUPS[g]]
    if interactions:
        extra = []
        for c in cols:
            if c != "d_base":
                F[f"d_x_{c}"] = F.d_base * F[c]
                extra.append(f"d_x_{c}")
        cols = cols + extra
    m, coefs = RS.walk_forward(F, cols, LAM, EVAL[sport])
    F["m_hat"] = m
    P = F[F.m_hat.notna()][["game_id", "season", "early", "m_hat"]].copy()
    P[f"model_{market}"] = P.early + P.m_hat
    return P, coefs, cols


def frame_for(sport, pred, market, game_ids):
    df = R.frame(sport, pred, market, seasons=EVAL[sport], fresh=(sport == "nfl"))
    return df[df.game_id.isin(game_ids)].reset_index(drop=True)


def comparator(sport, spec, market, game_ids):
    """('baseline', None) -> the base model's threshold rule; (exp, groups) -> that residual model."""
    if spec[0] == "baseline":
        return frame_for(sport, R.read_pred(BASE[sport]), market, game_ids), COMP_BASELINE[sport]
    P, _, _ = predict(sport, spec[1], market, interactions=spec[2] if len(spec) > 2 else False)
    return frame_for(sport, P, market, game_ids), THETA


def experiment(sport, exp, groups, comp_spec, market="spread", interactions=False, label=None):
    P, coefs, cols = predict(sport, groups, market, interactions)
    ids = set(P.game_id)
    comp_df, comp_thr = comparator(sport, comp_spec, market, ids)
    ids &= set(comp_df.game_id)
    cand_df = frame_for(sport, P, market, ids)
    comp_df = comp_df[comp_df.game_id.isin(ids)]
    dist = R.distribution(sport, market)
    cmp_ = H.compare_matched(cand_df, comp_df, comp_thr, dist)
    label = label or f"{sport.upper()} residual {'+'.join(groups)}{' x d' if interactions else ''} {market}"
    rec = R.score(cand_df, sport, market, THETA, label, exp, sweep=[0.5, 0.75],
                  extra={"features": cols, "lambda": LAM, "theta": THETA, "coefficients_by_season": coefs,
                         "comparator": {"spec": list(map(str, comp_spec)), "threshold": comp_thr}, "matched": cmp_})
    passed = R.edge_called(rec["primary"]) and cmp_.get("beats", False)
    R.print_rec(rec)
    print(f"   matched volume vs comparator: cand {cmp_.get('cand_clv_pts', float('nan')):+.3f} ({cmp_['n_cand']}) "
          f"vs comp {cmp_.get('comp_clv_pts', float('nan')):+.3f} ({cmp_['n_comp']}), diff {cmp_['diff']:+.3f} "
          f"[{cmp_['diff_ci95'][0]:+.3f},{cmp_['diff_ci95'][1]:+.3f}]  overlap {cmp_.get('overlap')}  -> {'PASS' if passed else 'FAIL'}")
    last = coefs[max(coefs)] if coefs else {}
    print("   coefficients (last season, raw units):", {k: round(v, 4) for k, v in last.items()})
    return rec, cmp_, passed


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("sport", choices=["nfl", "cfb"])
    ap.add_argument("exp")
    ap.add_argument("groups")
    ap.add_argument("--comparator", default="baseline", help="'baseline' or comma groups of the comparator residual model")
    ap.add_argument("--market", default="spread")
    ap.add_argument("--interactions", action="store_true")
    ap.add_argument("--comparator-interactions", action="store_true")
    a = ap.parse_args(argv)
    comp = ("baseline",) if a.comparator == "baseline" else ("residual", a.comparator.split(","), a.comparator_interactions)
    experiment(a.sport, a.exp, a.groups.split(","), comp, a.market, a.interactions)


if __name__ == "__main__":
    main()
