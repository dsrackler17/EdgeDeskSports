"""NFL line history from the git history of nflverse/nfldata data/games.csv.

nflverse's games.csv is rewritten by an automated job roughly every ten
minutes in season (since late September 2020). Each commit is a snapshot of
the spread, total, moneylines and prices nflverse carried AT THE COMMIT TIME,
so the commit timestamp is a provable known-at time for every value in it.
This walks that history and keeps every change of a game's market columns.

It reads; it never computes a line. A value that is blank in a commit stays
blank (missing), never filled.

  git clone --bare https://github.com/nflverse/nfldata /home/user/nflverse/nfldata.git
  python3 -m model_loop.clv.nfl_line_history --repo /home/user/nflverse/nfldata.git

Output (gitignored): .cache/clv/nfl_line_changes.csv.gz, one row per (game,
commit) where any market column changed, stamped with the commit time (UTC).
"""
import argparse
import csv
import datetime as dt
import gzip
import io
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, ".cache", "clv", "nfl_line_changes.csv.gz")

MARKET = ["spread_line", "total_line", "home_moneyline", "away_moneyline",
          "home_spread_odds", "away_spread_odds", "over_odds", "under_odds"]
KEEP = ["game_id", "season", "game_type", "week", "gameday", "gametime",
        "away_team", "home_team", "away_score", "home_score", "away_qb_id", "home_qb_id",
        "away_qb_name", "home_qb_name"]


def utc(stamp):
    return dt.datetime.fromisoformat(stamp).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def walk(repo, paths=("data/games.csv",)):
    """(commit_utc, header, row) for every added line of games.csv, oldest first."""
    cmd = ["git", "-C", repo, "log", "--reverse", "-p", "-U0", "--no-color", "--no-renames",
           "--format=@@COMMIT %H %aI", "--"] + list(paths)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=1 << 20)
    header = None
    when = None
    for raw in io.TextIOWrapper(proc.stdout, encoding="utf-8", errors="replace"):
        if raw.startswith("@@COMMIT "):
            when = utc(raw.split()[2])
            continue
        if not raw.startswith("+") or raw.startswith("+++"):
            continue
        line = raw[1:].rstrip("\n")
        if line.startswith("game_id,"):
            header = next(csv.reader([line]))
            continue
        if header is None:
            continue
        vals = next(csv.reader([line]))
        if len(vals) != len(header):
            continue
        yield when, header, dict(zip(header, vals))
    proc.wait()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/home/user/nflverse/nfldata.git")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    last = {}
    n_in = n_out = 0
    with gzip.open(a.out, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["seen_at"] + KEEP + MARKET)
        for when, header, row in walk(a.repo):
            n_in += 1
            if "spread_line" not in header:
                continue
            gid = row.get("game_id")
            key = tuple(row.get(c, "") for c in MARKET)
            if last.get(gid) == key:
                continue
            last[gid] = key
            w.writerow([when] + [row.get(c, "") for c in KEEP] + list(key))
            n_out += 1
    print(f"{n_in} added rows read, {n_out} market changes kept -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
