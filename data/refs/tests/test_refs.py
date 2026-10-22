"""data/refs: the build's assignment rules and the seed's file checks, on a
synthetic season (no download). Needs pandas and pyarrow.

  python3 -m unittest discover -s data/refs/tests -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import pandas as pd

REFS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(REFS, "build_ref_data.py")
UPSERT = os.path.join(REFS, "upsert_refs.py")

GAMES = [  # game_id, week, referee (nflverse), result, total, total_line
    ("2026_01_AAA_BBB", 1, "Ref One", 3, 40, 41.5),     # under
    ("2026_01_CCC_DDD", 1, None, -7, 44, 44.0),          # manual fills it; a push
    ("2026_02_AAA_CCC", 2, "Ref One", 10, 50, None),     # nflverse and manual disagree; no line
    ("2026_02_BBB_DDD", 2, None, 1, 37, 40.0),           # nobody knows the referee
    ("2026_03_AAA_DDD", 3, None, None, None, 45.5),      # upcoming, manual
    ("2026_03_BBB_CCC", 3, None, None, None, 47.0),      # upcoming, not announced
]


def play(gid, home, away, ptype="pass", pen=0, ptype_pen=None, team=None, yards=0, desc=""):
    return {"game_id": gid, "play_type": ptype, "penalty": pen, "penalty_type": ptype_pen, "penalty_team": team,
            "penalty_yards": yards, "home_team": home, "away_team": away, "desc": desc}


def world(d, manual):
    rows = []
    for gid, wk, ref, res, tot, line in GAMES:
        away, home = gid.split("_")[2:]
        rows.append({"game_id": gid, "season": 2026, "game_type": "REG", "week": wk, "gameday": f"2026-09-{10 + wk:02d}",
                     "away_team": away, "home_team": home, "result": res, "total": tot, "total_line": line,
                     "spread_line": 1.5, "referee": ref})
    pd.DataFrame(rows).to_csv(os.path.join(d, "games.csv"), index=False)
    plays = []
    for gid, *_ in GAMES[:4]:
        away, home = gid.split("_")[2:]
        plays += [play(gid, home, away), play(gid, home, away, "run"), play(gid, home, away, "kickoff"),
                  play(gid, home, away, "no_play", 1, "Offensive Holding", home, 10, "PENALTY on X, Offensive Holding"),
                  play(gid, home, away, "pass", 1, "Defensive Holding", away, 0, "PENALTY on Y, Defensive Holding, declined"),
                  play(gid, home, away, "no_play", 1, "False Start", away, 5, "PENALTY on Z, False Start")]
    pd.DataFrame(plays).to_parquet(os.path.join(d, "pbp_2026.parquet"))
    with open(os.path.join(d, "manual.json"), "w") as fh:
        json.dump(manual, fh)


MANUAL = {"weeks": [
    {"season": 2026, "week": 1, "games": {"2026_01_CCC_DDD": "Ref Two"}},
    {"season": 2026, "week": 2, "source": "manual", "games": {"2026_02_AAA_CCC": "Ref Three"}},
    {"season": 2026, "week": 3, "games": {"2026_03_AAA_DDD": "Ref Two"}},
]}


def build(d, manual=MANUAL):
    world(d, manual)
    return subprocess.run([sys.executable, "-I", BUILD, "--seasons", "2026", "--games", os.path.join(d, "games.csv"),
                           "--pbp-dir", d, "--out-dir", os.path.join(d, "out"), "--manual", os.path.join(d, "manual.json")],
                          capture_output=True, text=True)


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.res = build(cls.d)
        o = os.path.join(cls.d, "out")
        cls.assign = pd.read_csv(os.path.join(o, "ref_assignments.csv")).set_index("game_id") if cls.res.returncode == 0 else None
        cls.pen = pd.read_csv(os.path.join(o, "ref_game_penalties.csv")).set_index("game_id") if cls.res.returncode == 0 else None

    def test_builds(self):
        self.assertEqual(self.res.returncode, 0, self.res.stderr)

    def test_nflverse_wins_over_the_manual_entry(self):
        self.assertEqual(self.assign.loc["2026_02_AAA_CCC", "referee"], "Ref One")
        self.assertEqual(self.assign.loc["2026_02_AAA_CCC", "source"], "nflverse")
        self.assertIn("2026_02_AAA_CCC: nflverse has Ref One, manual_assignments.json has Ref Three; nflverse wins", self.res.stdout)
        self.assertEqual(self.pen.loc["2026_02_AAA_CCC", "referee"], "Ref One")

    def test_manual_fills_what_nflverse_lacks_with_its_source(self):
        self.assertEqual(self.assign.loc["2026_01_CCC_DDD", "referee"], "Ref Two")
        self.assertEqual(self.assign.loc["2026_01_CCC_DDD", "source"], "footballzebras")   # the default
        self.assertEqual(self.assign.loc["2026_01_AAA_BBB", "source"], "nflverse")

    def test_upcoming_and_unknown_games(self):
        self.assertEqual(self.assign.loc["2026_03_AAA_DDD", "referee"], "Ref Two")         # announced, not played
        self.assertNotIn("2026_03_BBB_CCC", self.assign.index)                               # not announced: no row
        self.assertNotIn("2026_02_BBB_DDD", self.assign.index)                               # played, nobody knows
        self.assertNotIn("2026_02_BBB_DDD", self.pen.index)
        self.assertNotIn("2026_03_AAA_DDD", self.pen.index)                                  # not played: no penalties
        slate = pd.read_csv(os.path.join(self.d, "out", "ref_assignments_2026_w3.csv"))
        self.assertEqual(list(slate.game_id), ["2026_03_AAA_DDD"])

    def test_counts_and_the_over_under(self):
        r = self.pen.loc["2026_01_AAA_BBB"]
        cols = ["flags", "accepted_flags", "off_holding", "def_holding", "holding_total", "false_start", "home_flags", "away_flags", "snaps", "penalty_yards"]
        self.assertEqual([int(r[c]) for c in cols], [3, 2, 1, 1, 2, 1, 1, 2, 6, 15])
        self.assertEqual(self.pen.loc["2026_01_AAA_BBB", "went_over"], 0)
        self.assertTrue(pd.isna(self.pen.loc["2026_01_CCC_DDD", "went_over"]))              # a push
        self.assertTrue(pd.isna(self.pen.loc["2026_02_AAA_CCC", "went_over"]))              # no line is not an under

    def test_the_seed_reads_what_the_build_wrote(self):
        r = subprocess.run([sys.executable, "-I", UPSERT, "--dir", os.path.join(self.d, "out"), "--dry-run"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("nfl_ref_assignments: 4 rows", r.stdout)
        self.assertIn("nfl_ref_game_penalties: 3 rows", r.stdout)


class ManualFileTest(unittest.TestCase):
    def bad(self, manual, msg):
        r = build(tempfile.mkdtemp(), manual)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(msg, r.stderr)

    def test_unknown_game(self):
        self.bad({"weeks": [{"season": 2026, "week": 1, "games": {"2026_01_ZZZ_YYY": "Ref"}}]}, "2026_01_ZZZ_YYY is not a game_id")

    def test_game_in_the_wrong_week(self):
        self.bad({"weeks": [{"season": 2026, "week": 2, "games": {"2026_01_CCC_DDD": "Ref"}}]}, "2026_01_CCC_DDD is listed under 2026 week 2")

    def test_unknown_source(self):
        self.bad({"weeks": [{"season": 2026, "week": 1, "source": "twitter", "games": {}}]}, "source 'twitter' is not one of")

    def test_empty_name(self):
        self.bad({"weeks": [{"season": 2026, "week": 1, "games": {"2026_01_CCC_DDD": " "}}]}, "2026_01_CCC_DDD has no referee name")


class CommittedTest(unittest.TestCase):
    def test_the_committed_manual_file_names_real_week_blocks(self):
        with open(os.path.join(REFS, "manual_assignments.json")) as fh:
            doc = json.load(fh)
        for b in doc["weeks"]:
            for gid in b["games"]:
                self.assertTrue(gid.startswith(f"{b['season']}_{b['week']:02d}_"), gid)

    def test_the_committed_csvs_pass_the_seed_checks(self):
        r = subprocess.run([sys.executable, "-I", UPSERT, "--dry-run"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("nfl_ref_assignments: 677 rows", r.stdout)
        self.assertIn("nfl_ref_game_penalties: 663 rows", r.stdout)


class SeedFileTest(unittest.TestCase):
    def files(self, assign, pen):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "ref_assignments.csv"), "w") as fh:
            fh.write(assign)
        src = open(os.path.join(REFS, "ref_game_penalties.csv")).read().splitlines()
        with open(os.path.join(d, "ref_game_penalties.csv"), "w") as fh:
            fh.write("\n".join([src[0]] + [pen(l) for l in src[1:3]]) + "\n")
        return subprocess.run([sys.executable, "-I", UPSERT, "--dir", d, "--dry-run"], capture_output=True, text=True)

    A = "game_id,season,week,referee,source\n2024_01_ARI_BUF,2024,1,Tra Blake,nflverse\n2024_01_BAL_KC,2024,1,Shawn Hochuli,nflverse\n"

    def test_good(self):
        self.assertEqual(self.files(self.A, lambda l: l).returncode, 0)

    def test_a_fraction_in_a_whole_number_column(self):
        r = self.files(self.A, lambda l: l.replace(",14,14,96,", ",14.5,14,96,"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("flags", r.stderr)
        self.assertIn("is not a whole number", r.stderr)

    def test_a_penalty_row_without_its_assignment(self):
        r = self.files(self.A.splitlines()[0] + "\n" + self.A.splitlines()[1] + "\n", lambda l: l)
        self.assertEqual(r.returncode, 1)
        self.assertIn("with no row in ref_assignments.csv", r.stderr)

    def test_an_unexpected_column(self):
        r = self.files(self.A.replace("source\n", "source,extra\n", 1), lambda l: l)
        self.assertEqual(r.returncode, 1)
        self.assertIn("columns differ", r.stderr)

    def test_an_unknown_source(self):
        r = self.files(self.A.replace("Tra Blake,nflverse", "Tra Blake,twitter"), lambda l: l)
        self.assertEqual(r.returncode, 1)
        self.assertIn("source 'twitter'", r.stderr)


if __name__ == "__main__":
    unittest.main()
