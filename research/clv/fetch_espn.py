"""Fetch ESPN pickcenter (DraftKings open/close) for the seasons the CLV
studies hold out. Cached in .cache/clv/espn/<league>_pickcenter.jsonl.

  python3 -m research.clv.fetch_espn nba 2026 2027
  python3 -m research.clv.fetch_espn wnba 2025 2026
  python3 -m research.clv.fetch_espn ncaam 2026
"""
import os
import sys

import pandas as pd

from model_loop.clv import sources as S

GAMES = {"nba": "nba/data/games/{s}.csv", "wnba": "basketball/data/wnba/{s}.csv", "ncaam": "basketball/data/ncaam/{s}.csv"}


def main(league, seasons):
    ids = []
    for s in seasons:
        d = pd.read_csv(os.path.join(S.ROOT, GAMES[league].format(s=s)))
        d = d[d.status.astype(str).str.upper().eq("FINAL")] if "status" in d else d
        ids += d.game_id.astype(int).tolist()
    print(league, seasons, len(ids), "games")
    p = S.espn_fetch(league, ids)
    print("cached", p)


if __name__ == "__main__":
    main(sys.argv[1], [int(x) for x in sys.argv[2:]])
