"""Export the NFL early-week and closing spreads the prior-decay backtest scores
CLV against, using the model loop's own definitions (model_loop/clv_early/lines.py
nfl_lines: tau = latest kickoff of week W-1 + 5 h, the feed live within 6 h of
tau, Week 1 excluded, close = the last value before kickoff).

Needs the line history from nflverse/nfldata's git history first:

  git clone --bare https://github.com/nflverse/nfldata <dir>/nfldata.git
  python3 -m model_loop.clv_early.nfl_line_history --repo <dir>/nfldata.git
  git -C <dir>/nfldata.git log --format=%aI -- data/games.csv > .cache/clv/nfl_commit_times.txt
  python3 football/research/nfl_v2/prior_decay/export_early_lines.py

Writes football/research/nfl_v2/.cache/early_lines_nfl.csv (gitignored):
game_id, season, week, early_spread, close_spread, early_live, close_live, tau_utc
(spreads in nflverse's convention: the home team's expected margin).
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
sys.path.insert(0, ROOT)
from model_loop.clv_early.lines import nfl_lines  # noqa: E402

OUT = os.path.join(ROOT, "football", "research", "nfl_v2", ".cache", "early_lines_nfl.csv")


def main():
    L = nfl_lines()
    cols = ["game_id", "season", "week", "early_spread", "close_spread", "early_live", "close_live", "tau_utc"]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    L[cols].to_csv(OUT, index=False)
    ok = L[L.early_spread.notna() & L.close_spread.notna()]
    print(f"{len(L)} games, {len(ok)} with an early and a closing spread -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
