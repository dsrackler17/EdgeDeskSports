"""Phase 5 runners, exactly as preregistered in EXPERIMENTS.md.

  python3 -m model_loop.clv_early.phase5 e201      # NFL backup-QB games at the Friday line
  python3 -m model_loop.clv_early.phase5 e202      # CFB non-power games at the opener
  python3 -m model_loop.clv_early.phase5 e203      # NFL totals with venue climatology (needs node)
"""
import argparse
import glob
import os
import subprocess
import sys

import numpy as np
import pandas as pd

from . import harness as H
from . import run as R
from .baselines import previous_starters, _hybrid_walk_forward, _current_cfg, UNKNOWN_QB

ROOT = R.ROOT
CACHE = R.CACHE
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "JAC": "JAX"}
DEV_NFL = [2020, 2021, 2022, 2023, 2024]


# ------------------------------------------------------------------ E-201
def injuries():
    fs = sorted(glob.glob(os.path.join(CACHE, "raw", "inj", "injuries_*.csv")))
    d = pd.concat([pd.read_csv(f, low_memory=False) for f in fs], ignore_index=True)
    d["team"] = d.team.map(lambda t: FRANCHISE.get(t, t))
    d["date_modified"] = pd.to_datetime(d.date_modified, utc=True, errors="coerce")
    return d[d.game_type.isin(["REG", "POST"])]


def friday_starters(T, L):
    """{game_id: (home_q, away_q)} with the Friday-expected starter, and the set
    of games where some team's previous-game starter was Out/Doubtful on the
    final report filed by the Friday checkpoint."""
    g = T.games.copy()
    g["kick"] = pd.to_datetime(g.kick_et)
    prev, _ = previous_starters(g)
    inj = injuries()
    inj = inj[inj.report_status.isin(["Out", "Doubtful"])]
    fri = dict(zip(L.game_id, L.fri_utc))
    q = T.qbs.copy()
    q["drops"] = q.n_in + q.n_out
    q["qb_id"] = q.qb_id.astype(str)
    over, flagged = {}, set()
    for r in g.itertuples():
        hp, ap = prev[r.game_id]
        t = fri.get(r.game_id)
        out = []
        for side, team, pq in (("home", r.home, hp), ("away", r.away, ap)):
            new = pq
            if t is not None and pd.notna(t) and pq != UNKNOWN_QB:
                m = inj[(inj.season == r.season) & (inj.week == r.week) & (inj.team == team) & (inj.gsis_id == pq)
                        & (inj.date_modified <= t)]
                if len(m):
                    flagged.add(r.game_id)
                    cand = q[(q.season == r.season) & (q.team == team) & (q.week < r.week) & (q.qb_id != pq)]
                    new = cand.groupby("qb_id").drops.sum().idxmax() if len(cand) else UNKNOWN_QB
            out.append(new)
        over[r.game_id] = tuple(out)
    return over, flagged


def e201():
    from ..adapters.nfl.ratings import Tables, NflRatingPass
    from ..adapters.nfl import model as NM
    cfg = _current_cfg("nfl")
    T = Tables(os.path.join(ROOT, ".cache", "model_loop", "nfl", "build"))
    L = R.lines("nfl")
    over, flagged = friday_starters(T, L)
    seasons = list(range(2006, int(T.games.season.max()) + 1))
    prod = NM.add_geo(NflRatingPass(T, cfg["rating"]).run(seasons)[0])
    fri = NM.add_geo(NflRatingPass(T, cfg["rating"]).run(seasons, qb_overrides=over)[0])
    fri["temp"] = np.nan
    fri["wind"] = np.nan
    p = _hybrid_walk_forward(prod, fri, NM.walk_forward, cfg["model"], list(range(2008, 2027)))
    p = p[["game_id", "season", "week", "pred_margin", "pred_total"]].rename(columns={"pred_margin": "model_spread", "pred_total": "model_total"})
    p["flagged"] = p.game_id.isin(flagged)
    p.to_parquet(os.path.join(CACHE, "pred_nfl_loop_friday.parquet"))
    p = R.read_pred(os.path.join(CACHE, "pred_nfl_loop_friday.parquet"))
    ids = set(p.game_id[p.flagged])
    df = R.frame("nfl", p, "spread", checkpoint="fri", seasons=DEV_NFL)
    df = df[df.game_id.isin(ids)].reset_index(drop=True)
    tue = R.read_pred(os.path.join(CACHE, "pred_nfl_loop.parquet"))
    dft = R.frame("nfl", tue, "spread", checkpoint="fri", seasons=DEV_NFL)
    dft = dft[dft.game_id.isin(set(df.game_id))].reset_index(drop=True)
    gap = float(np.mean(np.abs(df.model - df.bet_line))), float(np.mean(np.abs(dft.model - dft.bet_line)))
    side = R.score(dft, "nfl", "spread", 2.0, "NFL Loop backup-QB games, Tuesday starters, Friday line", "E-201-ref",
                   extra={"note": "reference: previous-game starters on the same games"})
    rec = R.score(df, "nfl", "spread", 2.0, "NFL Loop backup-QB games, Friday starters, Friday line", "E-201", sweep=[1.0, 3.0],
                  extra={"games": len(df), "flagged_games_all_seasons": len(ids),
                         "mean_abs_model_minus_friday_line": gap[0], "tuesday_inputs_mean_abs_gap": gap[1]})
    R.print_rec(rec)
    print("   reference (previous-game starters):", H.summary_line(side["primary"]))
    print(f"   games {len(df)}; mean |model - Friday line|: Friday starters {gap[0]:.2f}, previous starters {gap[1]:.2f}")
    return rec


# ------------------------------------------------------------------ E-202
POWER = {"SEC", "Big Ten", "Big 12", "ACC", "Pac-12"}


def is_power(conf, season, team_name=None):
    if team_name == "Notre Dame":
        return True
    if conf == "Pac-12" and season >= 2024:
        return False
    return conf in POWER


def e202():
    p = R.read_pred(os.path.join(CACHE, "pred_cfb_loop_lag1.parquet"))
    df = R.frame("cfb", p, "spread")
    g = pd.read_parquet(os.path.join(ROOT, ".cache", "model_loop", "cfb", "build", "games.parquet"))
    g["game_id"] = g.game_id.astype(str)
    g = g.set_index("game_id")
    pw = {gid: is_power(g.home_conf.get(gid), g.season.get(gid), g.home_name.get(gid)) or
          is_power(g.away_conf.get(gid), g.season.get(gid), g.away_name.get(gid)) for gid in df.game_id}
    df["power"] = df.game_id.map(pw)
    non, pow_ = df[~df.power].reset_index(drop=True), df[df.power].reset_index(drop=True)
    rn = R.score(non, "cfb", "spread", 3.0, "CFB Loop W-2 non-power games", "E-202", sweep=[2.0, 5.0])
    rp = R.score(pow_, "cfb", "spread", 3.0, "CFB Loop W-2 power-involved games", "E-202-ref")
    dist = R.distribution("cfb", "spread")
    bn = H.place_bets(non, H.Config(threshold=3.0), dist)
    bp = H.place_bets(pow_, H.Config(threshold=3.0), dist)
    bn, bp = bn[bn.bet], bp[bp.bet]
    rng = np.random.default_rng(20261021)
    cn, cp = H._clusters(bn, ("season", "week")), H._clusters(bp, ("season", "week"))
    u = np.unique(np.concatenate([cn, cp]))
    ix = {x: i for i, x in enumerate(u)}
    S = np.zeros((len(u), 4))
    np.add.at(S, (np.array([ix[x] for x in cn]), 0), bn.clv_pts.values)
    np.add.at(S, (np.array([ix[x] for x in cn]), 1), 1.0)
    np.add.at(S, (np.array([ix[x] for x in cp]), 2), bp.clv_pts.values)
    np.add.at(S, (np.array([ix[x] for x in cp]), 3), 1.0)
    D = S[rng.integers(0, len(u), size=(2000, len(u)))].sum(axis=1)
    diff = D[:, 0] / np.maximum(D[:, 1], 1e-12) - D[:, 2] / np.maximum(D[:, 3], 1e-12)
    lo, hi = np.percentile(diff, [2.5, 97.5])
    R.print_rec(rn)
    print("   power-involved:", H.summary_line(rp["primary"]))
    d = bn.clv_pts.mean() - bp.clv_pts.mean()
    passed = R.edge_called(rn["primary"]) and lo > 0
    print(f"   non-power minus power: {d:+.3f} [{lo:+.3f},{hi:+.3f}] -> {'PASS' if passed else 'FAIL'}")
    return rn, (d, lo, hi), passed


# ------------------------------------------------------------------ E-203
def e203():
    out = os.path.join(CACHE, "pred_nfl_v21_climate.csv")
    r = subprocess.run(["node", os.path.join(os.path.dirname(__file__), "js", "replay_nfl_v21.js"), out, "climate"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr)
    print(r.stderr.strip(), file=sys.stderr)
    cand = R.frame("nfl", R.read_pred(out), "total", fresh=True)
    comp = R.frame("nfl", R.read_pred(os.path.join(CACHE, "pred_nfl_v21.csv")), "total", fresh=True)
    ids = set(cand.game_id) & set(comp.game_id)
    cand, comp = cand[cand.game_id.isin(ids)].reset_index(drop=True), comp[comp.game_id.isin(ids)].reset_index(drop=True)
    dist = R.distribution("nfl", "total")
    cmp_ = H.compare_matched(cand, comp, 2.0, dist)
    rec = R.score(cand, "nfl", "total", 2.0, "NFL v2.1.0 total, venue climatology", "E-203", sweep=[1.0, 3.0],
                  extra={"matched": cmp_})
    R.print_rec(rec)
    passed = R.edge_called(rec["primary"]) and cmp_["beats"]
    print(f"   matched vs neutral weather: cand {cmp_['cand_clv_pts']:+.3f} vs comp {cmp_['comp_clv_pts']:+.3f} "
          f"diff {cmp_['diff']:+.3f} [{cmp_['diff_ci95'][0]:+.3f},{cmp_['diff_ci95'][1]:+.3f}] -> {'PASS' if passed else 'FAIL'}")
    return rec, cmp_, passed


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("which", choices=["e201", "e202", "e203"])
    a = ap.parse_args(argv)
    {"e201": e201, "e202": e202, "e203": e203}[a.which]()


if __name__ == "__main__":
    main()
