"""Phase 3 baselines: the production models priced with only what was
knowable at the early line (EXPERIMENTS.md E-001..E-006).

  python3 -m model_loop.clv_early.baselines nfl_loop     # E-002 -> .cache/clv/pred_nfl_loop.parquet
  python3 -m model_loop.clv_early.baselines cfb_loop     # E-004 (+ E-006 lagged)
  python3 -m model_loop.clv_early.baselines cfb_v1       # E-003 (+ E-006 lagged), via node
  python3 -m model_loop.clv_early.baselines nfl_v21      # E-001, via node

Loop models: two rating passes. The production pass (the starter who
actually played, observed weather) supplies the TRAINING rows exactly as the
loop trains; the early pass (each team's previous-game starter, weather
neutral) supplies the rows that are PRICED. Per season S the walk-forward fit
uses production rows of seasons < S and predicts the early rows of S.
"""
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "clv")
UNKNOWN_QB = "__no_prior_start__"


def previous_starters(games, kick="kick", slate_gap=0):
    """{game_id: (home_prev_qb, away_prev_qb)}: each team's starter in its
    previous game of the same season (UNKNOWN_QB before its first game), and
    {game_id: bool} whether both teams have a completed game before this one.
    slate_gap=1: the starter of the team's last game at slate <= W-2 (nothing
    from week W-1), for E-006."""
    long = []
    for side in ("home", "away"):
        cols = ["game_id", "season", kick, side, f"{side}_qb_id", "result"] + (["slate"] if slate_gap else [])
        x = games[cols].rename(columns={side: "team", f"{side}_qb_id": "qb"})
        x["side"] = side
        long.append(x)
    L = pd.concat(long).sort_values(["team", "season", kick, "game_id"])
    L["played"] = L.result.notna()
    L["qb_s"] = np.where(L.played, L.qb.astype(object), None)
    if slate_gap:
        def lag_by_slate(d):
            sl = d.slate.values
            qb = d.qb_s.values
            played = d.played.values
            out = [None] * len(d)
            for i in range(len(d)):
                prior = [j for j in range(i) if sl[j] <= sl[i] - 1 - slate_gap and played[j] and qb[j] is not None]
                out[i] = qb[prior[-1]] if prior else None
            return pd.Series(out, index=d.index)
        L["prev_qb"] = L.groupby(["team", "season"], group_keys=False).apply(lag_by_slate)
    else:
        L["prev_qb"] = L.groupby(["team", "season"]).qb_s.transform(lambda s: s.shift(1).ffill())
    L["n_prev"] = L.groupby(["team", "season"]).played.transform(lambda s: s.shift(1).fillna(False).astype(int).cumsum())
    over, elig = {}, {}
    piv = L.set_index(["game_id", "side"])
    for gid in games.game_id:
        h, a = piv.loc[(gid, "home")], piv.loc[(gid, "away")]
        hq = h.prev_qb if isinstance(h.prev_qb, str) and h.prev_qb else UNKNOWN_QB
        aq = a.prev_qb if isinstance(a.prev_qb, str) and a.prev_qb else UNKNOWN_QB
        over[gid] = (str(hq), str(aq))
        elig[gid] = bool(h.n_prev > 0 and a.n_prev > 0)
    return over, elig


class _LagOneSlate:
    """Mixin: price slate W's games from the fits made at the start of slate
    W-1 (ratings through W-2). E-006's opener-timing sensitivity."""

    def _game_row(self, g, tix, fp, fr, fm, ft, use_qb, qb_prior):
        key = (int(g.season), id(fp))
        if getattr(self, "_cur_key", None) != key:
            cur = getattr(self, "_cur", None)
            self._prev = cur if (cur is not None and cur[0] == int(g.season)) else None
            self._cur = (int(g.season), (fp, fr, fm, ft))
            self._cur_key = key
        use = self._prev[1] if self._prev is not None else (fp, fr, fm, ft)
        return super()._game_row(g, tix, *use, use_qb, qb_prior)


def _hybrid_walk_forward(prod, early, wf, model_cfg, seasons):
    out = []
    for S in seasons:
        h = pd.concat([prod[prod.season < S], early[early.season == S]], ignore_index=True)
        p, _ = wf(h, model_cfg, predict_seasons=[S])
        out.append(p[p.season == S])
    return pd.concat(out, ignore_index=True)


def nfl_loop(seasons_out=range(2008, 2027)):
    from ..adapters.nfl.ratings import Tables, NflRatingPass
    from ..adapters.nfl import model as NM
    cfg = _current_cfg("nfl")
    T = Tables(os.path.join(ROOT, ".cache", "model_loop", "nfl", "build"))
    seasons = list(range(2006, int(T.games.season.max()) + 1))
    g = T.games.copy()
    g["kick"] = pd.to_datetime(g.kick_et)
    over, elig = previous_starters(g)
    prod = NM.add_geo(NflRatingPass(T, cfg["rating"]).run(seasons)[0])
    early = NM.add_geo(NflRatingPass(T, cfg["rating"]).run(seasons, qb_overrides=over)[0])
    early["temp"] = np.nan
    early["wind"] = np.nan
    p = _hybrid_walk_forward(prod, early, NM.walk_forward, cfg["model"], list(seasons_out))
    pp, _ = NM.walk_forward(prod, cfg["model"])
    p = p.merge(pp[["game_id", "pred_margin"]].rename(columns={"pred_margin": "prod_spread"}), on="game_id", how="left")
    p["eligible"] = p.game_id.map(elig)
    out = p[["game_id", "season", "week", "home", "away", "pred_margin", "pred_total", "prod_spread", "eligible",
             "home_qb_id", "away_qb_id"]].rename(columns={"pred_margin": "model_spread", "pred_total": "model_total"})
    out.to_parquet(os.path.join(CACHE, "pred_nfl_loop.parquet"))
    print("nfl_loop", len(out), file=sys.stderr)
    return out


def cfb_loop(seasons_out=range(2010, 2027), lagged=False):
    from ..adapters.cfb.ratings import Tables, CfbRatingPass
    from ..adapters.cfb import model as CM
    cfg = _current_cfg("cfb")
    T = Tables(os.path.join(ROOT, ".cache", "model_loop", "cfb", "build"))
    seasons = list(range(2008, int(T.games.season.max()) + 1))
    g = T.games.copy()
    g["kick"] = pd.to_datetime(g.kick_utc)
    over, elig = previous_starters(g, slate_gap=1 if lagged else 0)
    Pass = type("LaggedCfbPass", (_LagOneSlate, CfbRatingPass), {}) if lagged else CfbRatingPass
    prod = CfbRatingPass(T, cfg["rating"]).run(seasons)[0]
    early = Pass(T, cfg["rating"]).run(seasons, qb_overrides=over)[0]
    p = _hybrid_walk_forward(prod, early, CM.walk_forward, cfg["model"], list(seasons_out))
    pp, _ = CM.walk_forward(prod, cfg["model"])
    p = p.merge(pp[["game_id", "pred_margin"]].rename(columns={"pred_margin": "prod_spread"}), on="game_id", how="left")
    p["eligible"] = p.game_id.map(elig)
    out = p[["game_id", "season", "week", "home", "away", "pred_margin", "pred_total", "prod_spread", "eligible"]].rename(
        columns={"pred_margin": "model_spread", "pred_total": "model_total"})
    name = "pred_cfb_loop_lag1.parquet" if lagged else "pred_cfb_loop.parquet"
    out.to_parquet(os.path.join(CACHE, name))
    print(name, len(out), file=sys.stderr)
    return out


def cfb_v1(lagged=False):
    """football/cfb_p4 replayed with week-start projections (node)."""
    import glob
    fs = sorted(glob.glob(os.path.join(ROOT, ".cache", "model_loop", "cfb", "raw", "sched", "sched_*.csv")))
    cols = ["game_id", "season", "week", "season_type", "start_date", "home_team", "away_team", "home_division",
            "away_division", "home_conference", "away_conference", "neutral_site", "home_points", "away_points"]
    d = pd.concat([pd.read_csv(f, low_memory=False)[cols] for f in fs], ignore_index=True)
    d = d[d.season_type.isin(["regular", "postseason"])]
    inp = os.path.join(CACHE, "cfb_v1_in.csv")
    name = "pred_cfb_v1_lag1.csv" if lagged else "pred_cfb_v1.csv"
    d.to_csv(inp, index=False)
    r = subprocess.run(["node", os.path.join(os.path.dirname(__file__), "js", "replay_cfb_p4_weekstart.js"), inp,
                        os.path.join(CACHE, name), "2006", "1" if lagged else "0"], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr)
    print(r.stderr.strip(), file=sys.stderr)


def nfl_v21():
    r = subprocess.run(["node", os.path.join(os.path.dirname(__file__), "js", "replay_nfl_v21.js"),
                        os.path.join(CACHE, "pred_nfl_v21.csv")], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr)
    print(r.stderr.strip(), file=sys.stderr)


def _current_cfg(sport):
    v = json.load(open(os.path.join(ROOT, "docs", "model-loop", sport, "versions.json")))
    cur = [x for x in v["versions"] if x["version"] == v["current"]][0]
    return cur["config"]


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("which", choices=["nfl_loop", "cfb_loop", "cfb_loop_lag1", "cfb_v1", "cfb_v1_lag1", "nfl_v21"])
    a = ap.parse_args(argv)
    os.makedirs(CACHE, exist_ok=True)
    {"nfl_loop": nfl_loop, "cfb_loop": cfb_loop, "cfb_loop_lag1": lambda: cfb_loop(lagged=True),
     "cfb_v1": cfb_v1, "cfb_v1_lag1": lambda: cfb_v1(lagged=True), "nfl_v21": nfl_v21}[a.which]()


if __name__ == "__main__":
    main()
