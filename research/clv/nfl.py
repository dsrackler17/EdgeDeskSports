"""NFL: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section NFL).

  python3 -m research.clv.nfl bases       # opener-time base models (cached in .cache/clv/)
  python3 -m research.clv.nfl pre         # every pre-holdout experiment
  python3 -m research.clv.nfl holdout     # Phase 6, once

Opener-time inputs (DATA_AUDIT.md): each side's QB is the QB who started that
franchise's previous game, and game-day temperature and wind are dropped (the
models' own missing-value defaults), in training and prediction alike.

Lines: SBR open and close (2011-2021), joined to nflverse games by date and
franchise; graded at -110 both sides (SBR keeps no spread prices).
"""
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import residual as R
from model_loop.clv import sources as S
from research.clv import runner

SPORT = "nfl"
PRE = list(range(2011, 2020))
PROXY = [2020, 2021]
LOOP_CACHE = os.path.join(S.CACHE, "nfl_loop_opener.csv")
V21_CACHE = os.path.join(S.CACHE, "nfl_v21_opener.csv")

# SBR nicknames -> nflverse franchise codes (current codes; relocations folded)
SBR_TEAMS = {
    "Cardinals": "ARI", "Arizona": "ARI", "Falcons": "ATL", "Atlanta": "ATL", "Ravens": "BAL", "Baltimore": "BAL",
    "Bills": "BUF", "Buffalo": "BUF", "Panthers": "CAR", "Carolina": "CAR", "Bears": "CHI", "Chicago": "CHI",
    "Bengals": "CIN", "Cincinnati": "CIN", "Browns": "CLE", "Cleveland": "CLE", "Cowboys": "DAL", "Dallas": "DAL",
    "Broncos": "DEN", "Denver": "DEN", "Lions": "DET", "Detroit": "DET", "Packers": "GB", "GreenBay": "GB",
    "Texans": "HOU", "Houston": "HOU", "Colts": "IND", "Indianapolis": "IND", "Jaguars": "JAX", "Jacksonville": "JAX",
    "Chiefs": "KC", "KansasCity": "KC", "Kansas": "KC", "Raiders": "LV", "Oakland": "LV", "LasVegas": "LV",
    "LVRaiders": "LV", "Chargers": "LAC", "SanDiego": "LAC", "LAChargers": "LAC", "Rams": "LA", "LARams": "LA",
    "St.Louis": "LA", "StLouis": "LA", "LosAngeles": "LA", "Dolphins": "MIA", "Miami": "MIA", "Vikings": "MIN",
    "Minnesota": "MIN", "Patriots": "NE", "NewEngland": "NE", "Saints": "NO", "NewOrleans": "NO", "Giants": "NYG",
    "NYGiants": "NYG", "Jets": "NYJ", "NYJets": "NYJ", "Eagles": "PHI", "Philadelphia": "PHI", "Steelers": "PIT",
    "Pittsburgh": "PIT", "Seahawks": "SEA", "Seattle": "SEA", "49ers": "SF", "SanFrancisco": "SF", "Buccaneers": "TB",
    "TampaBay": "TB", "Tampa": "TB", "Titans": "TEN", "Tennessee": "TEN", "Redskins": "WAS", "Washington": "WAS",
    "Commanders": "WAS", "FootballTeam": "WAS", "WashingtonFootballTeam": "WAS",
}
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA"}


# ------------------------------------------------------------ base models
def loop_opener():
    """model_loop NFL 2.0.0 (served config) with each side's previous starter
    and no game-day weather, walk-forward."""
    from model_loop.adapters.nfl import backtest as BT
    from model_loop.adapters.nfl import model as NM
    from model_loop.adapters.nfl.ratings import NflRatingPass
    v = json.load(open(os.path.join(S.ROOT, "docs", "model-loop", "nfl", "versions.json")))
    cfg = next(x for x in v["versions"] if x["version"] == v["current"])["config"]
    T = BT.Tables(os.path.join(BT.DATA, "build"))
    g = T.games.copy()
    order = "gameday" if "gameday" in g else ("kick_utc" if "kick_utc" in g else "game_id")
    g = g.sort_values([order, "game_id"])
    last, over = {}, {}
    for r in g.itertuples(index=False):
        over[r.game_id] = (last.get(r.home) or "__none__", last.get(r.away) or "__none__")
        for team, q in ((r.home, r.home_qb_id), (r.away, r.away_qb_id)):
            if isinstance(q, str) and q:
                last[team] = q
    rows, _ = NflRatingPass(T, cfg["rating"]).run(BT.SEASONS, qb_overrides=over)
    rows = NM.add_geo(rows)
    rows["wind"], rows["temp"] = np.nan, np.nan
    p, _ = NM.walk_forward(rows, cfg["model"])
    p[["game_id", "season", "week", "pred_margin", "pred_total"]].to_csv(LOOP_CACHE, index=False)
    print(f"loop opener: {len(p)} games", file=sys.stderr)


def v21_opener():
    subprocess.run(["node", os.path.join(S.ROOT, "research", "clv", "nfl_v2_opener.js"), V21_CACHE], check=True)


# ------------------------------------------------------------------ data
def games():
    """nflverse schedule (game ids, franchise codes, dates, results, closes)."""
    p = os.path.join(S.ROOT, ".cache", "model_loop", "nfl", "raw", "games.csv")
    if not os.path.exists(p):
        p = os.path.join(S.ROOT, "football", "research", "nfl_v2", ".cache", "raw", "games.csv")
    g = pd.read_csv(p, low_memory=False)
    g["home"] = g.home_team.map(lambda t: FRANCHISE.get(t, t))
    g["away"] = g.away_team.map(lambda t: FRANCHISE.get(t, t))
    g["date"] = pd.to_datetime(g.gameday)
    return g[["game_id", "season", "week", "game_type", "date", "home", "away", "home_score", "away_score",
              "spread_line", "total_line", "home_qb_id", "away_qb_id", "home_qb_name", "away_qb_name", "div_game"]]


def sbr_lines():
    d, qa = S.sbr("nfl")
    d["home"] = d.home_team.str.replace(" ", "").map(SBR_TEAMS)
    d["away"] = d.away_team.str.replace(" ", "").map(SBR_TEAMS)
    qa["unmapped_teams"] = sorted(set(d.home_team[d.home.isna()]) | set(d.away_team[d.away.isna()]))
    return d, qa


def load():
    g = games()
    s, qa = sbr_lines()
    # join on (home, away) within +-3 days of the SBR date
    m = g.merge(s[["date", "home", "away", "open_line", "close_line", "open_total", "close_total", "home_score", "away_score"]]
                .rename(columns={"date": "sbr_date", "home_score": "sbr_hs", "away_score": "sbr_as"}), on=["home", "away"], how="inner")
    m = m[(m.date - m.sbr_date).abs() <= pd.Timedelta(days=3)]
    m = m.drop_duplicates("game_id")
    qa["joined"] = int(len(m))
    qa["score_mismatch"] = int(((m.sbr_hs != m.home_score) | (m.sbr_as != m.away_score)).sum())
    m = m[(m.sbr_hs == m.home_score) & (m.sbr_as == m.away_score)].copy()
    m["margin"] = m.home_score - m.away_score
    m["total_pts"] = m.home_score + m.away_score
    m["result"] = m.margin
    qa["close_vs_nflverse_abs_diff_mean"] = round(float((m.close_line - m.spread_line).abs().mean()), 3)
    qa["close_vs_nflverse_within_1"] = round(float(((m.close_line - m.spread_line).abs() <= 1).mean()), 3)
    for path, cols in ((LOOP_CACHE, {"pred_margin": "loop", "pred_total": "loop_total"}),
                       (V21_CACHE, {"model_margin": "v21", "model_total": "v21_total"})):
        if os.path.exists(path):
            p = pd.read_csv(path)
            m = m.merge(p[["game_id"] + list(cols)].rename(columns=cols), on="game_id", how="left")
    leg = pd.read_csv(os.path.join(S.ROOT, "model_loop", "adapters", "nfl", "baselines", "legacy_v1_predictions.csv"))
    m["cluster"] = m.season.astype(str) + "-" + m.week.astype(str)
    return m, qa, leg


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "bases":
        v21_opener()
        loop_opener()
    elif cmd == "check":
        m, qa, _ = load()
        print(json.dumps(qa, indent=1, default=str))
