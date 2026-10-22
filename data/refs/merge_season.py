#!/usr/bin/env python3
"""Fold one rebuilt season into the committed referee CSVs.

The Tuesday ref sync rebuilds the season in progress with
  build_ref_data.py --seasons S --out-dir OUT
and loads it into Supabase. This puts the same rows into the committed files
the research snapshots read (tools/football/game_context.js), so a referee's
flags per game and over/under record include last week's games:

  python3 data/refs/merge_season.py --dir OUT --season S

ref_game_penalties.csv and ref_assignments.csv lose their season-S rows and
take the rebuilt ones, in the build's order; every other season is left
exactly as it is, and each file keeps its own columns. A rebuilt file that is
missing or has no season-S row leaves the committed one untouched.
Standard library only.
"""
import argparse
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ("ref_game_penalties.csv", "ref_assignments.csv")


def read(path):
    with open(path, newline="") as fh:
        r = csv.DictReader(fh)
        return r.fieldnames or [], list(r)


def merge(src_dir, season, into=HERE):
    report = {}
    for name in FILES:
        new_path, old_path = os.path.join(src_dir, name), os.path.join(into, name)
        if not os.path.exists(new_path):
            report[name] = "no rebuilt file: left as it is"
            continue
        _, fresh = read(new_path)
        fresh = [r for r in fresh if str(r.get("season", "")).strip() == str(season)]
        if not fresh:
            report[name] = f"no {season} rows in the rebuild: left as it is"
            continue
        head, rows = read(old_path)
        kept = [r for r in rows if str(r.get("season", "")).strip() != str(season)]
        out = kept + [{k: r.get(k, "") for k in head} for r in fresh]
        with open(old_path, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=head, lineterminator="\n")
            w.writeheader()
            w.writerows(out)
        report[name] = f"{len(rows) - len(kept)} {season} rows replaced by {len(fresh)}"
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="build_ref_data.py --out-dir")
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--into", default=HERE)
    a = ap.parse_args(argv)
    for name, what in merge(a.dir, a.season, a.into).items():
        print(f"{name}: {what}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
