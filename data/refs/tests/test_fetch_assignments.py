"""data/refs/fetch_assignments.py: the weekly pull of NFL referee assignments,
on fixture feeds in the layouts Football Zebras uses (a table, a dashed list,
the matchup on one line and the referee on the next, a "Referee:" label).
No network, standard library only.

  python3 -m unittest discover -s data/refs/tests -v
"""
import csv
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

REFS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("fetch_assignments", os.path.join(REFS, "fetch_assignments.py"))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)

# the real 2026 week-8 slate (nflverse games.csv), one game with a referee nflverse already filled
WEEK8 = [("2026_08_CAR_GB", "2026-10-29", "CAR", "GB", ""), ("2026_08_BAL_BUF", "2026-11-01", "BAL", "BUF", ""),
         ("2026_08_TEN_CIN", "2026-11-01", "TEN", "CIN", ""), ("2026_08_ARI_DAL", "2026-11-01", "ARI", "DAL", ""),
         ("2026_08_MIN_DET", "2026-11-01", "MIN", "DET", ""), ("2026_08_IND_JAX", "2026-11-01", "IND", "JAX", ""),
         ("2026_08_LV_NYJ", "2026-11-01", "LV", "NYJ", ""), ("2026_08_CLE_PIT", "2026-11-01", "CLE", "PIT", ""),
         ("2026_08_ATL_TB", "2026-11-01", "ATL", "TB", ""), ("2026_08_LAC_LA", "2026-11-01", "LAC", "LA", ""),
         ("2026_08_KC_DEN", "2026-11-01", "KC", "DEN", ""), ("2026_08_NE_MIA", "2026-11-01", "NE", "MIA", ""),
         ("2026_08_PHI_WAS", "2026-11-01", "PHI", "WAS", "Shawn Hochuli"), ("2026_08_CHI_SEA", "2026-11-02", "CHI", "SEA", "")]
PLAYED7 = ("2026_07_NE_CHI", "2026-10-22", "NE", "CHI", "Alan Eck")

TABLE_POST = """<p>Here are the Week 8 referee assignments.</p>
<table><tr><th>Game</th><th>Referee</th></tr>
<tr><td>Panthers at Packers</td><td>Clete Blakeman</td></tr>
<tr><td>Ravens at Bills</td><td>Bill Vinovich</td></tr>
<tr><td>Titans at Bengals</td><td>Ron Torbert</td></tr>
<tr><td>Cardinals at Cowboys</td><td>Shawn Smith</td></tr>
<tr><td>Vikings at Lions</td><td>Carl Cheffers</td></tr>
<tr><td>Colts at Jaguars</td><td>Land Clark</td></tr>
<tr><td>Raiders at Jets</td><td>Clay Martin</td></tr>
<tr><td>Browns at Steelers</td><td>Alex Kemp</td></tr>
<tr><td>Falcons at Buccaneers</td><td>John Hussey</td></tr>
<tr><td>Chargers at Rams</td><td>Brad Allen</td></tr>
<tr><td>Chiefs at Broncos</td><td>Craig Wrolstad</td></tr>
<tr><td>Patriots at Dolphins</td><td>Scott Novak</td></tr>
<tr><td>Eagles at Commanders</td><td>Alex Moore</td></tr>
<tr><td>Bears at Seahawks</td><td>Adrian Hill</td></tr></table>"""

LIST_POST = """<p><strong>Thursday</strong><br/>Panthers at Packers &#8212; Clete Blakeman</p>
<p><strong>Sunday</strong><br/>Ravens at Bills &#8212; Bill Vinovich<br/>Titans at Bengals: Ron Torbert<br/>
Raiders at Jets &#8211; Jordan Newcomb</p>"""

NEXT_LINE_POST = """<h3>Monday</h3><p>Bears at Seahawks</p><p>Referee: Adrian Hill</p>
<p>Chargers at Rams</p><p>Brad Allen (crew 7) &#8226; umpire Paul King</p>"""

CREW_ROW = """<table><tr><td>Chiefs at Broncos</td><td>Craig Wrolstad</td><td>Umpire: Mike Morton</td><td>Down judge: Alan Eck</td></tr></table>"""


def rss(*items):
    body = "".join("<item><title>%s</title><pubDate>%s</pubDate><content:encoded><![CDATA[%s]]></content:encoded></item>" % it for it in items)
    return ('<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">'
            "<channel><title>Football Zebras</title>%s</channel></rss>" % body)


class Pull(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.games = os.path.join(self.d, "games.csv")
        with open(self.games, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["game_id", "season", "game_type", "week", "gameday", "away_team", "home_team", "result", "referee"])
            gid, day, a, h, r = PLAYED7
            w.writerow([gid, 2026, "REG", 7, day, a, h, 3, r])
            for gid, day, a, h, r in WEEK8:
                w.writerow([gid, 2026, "REG", 8, day, a, h, "", r])
        self.manual = os.path.join(self.d, "manual.json")
        shutil.copy(os.path.join(REFS, "manual_assignments.json"), self.manual)

    def doc(self):
        with open(self.manual) as fh:
            return json.load(fh)

    def text(self, path):
        with open(path) as fh:
            return fh.read()

    def tearDown(self):
        shutil.rmtree(self.d)

    def run_with(self, *posts, **kw):
        feed = os.path.join(self.d, "feed.xml")
        with open(feed, "w") as fh:
            fh.write(rss(*posts))
        args = ["--games", self.games, "--manual", self.manual, "--feed", feed, "--today", kw.get("today", "2026-10-28")]
        args += kw.get("extra", [])
        code = F.main(args)
        blk = next((b for b in self.doc()["weeks"] if b["week"] == 8), None)
        return code, (blk or {}).get("games", {})

    def test_the_coming_week_is_the_first_unplayed_one(self):
        rows = F.read_games(self.games)
        self.assertEqual(F.target_week(rows, 2026, __import__("datetime").date(2026, 10, 28)), 8)

    def test_a_table_assigns_every_game_nflverse_has_not(self):
        code, g = self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", TABLE_POST))
        self.assertEqual(code, 0)
        self.assertEqual(len(g), 13)
        self.assertEqual(g["2026_08_CAR_GB"], "Clete Blakeman")
        self.assertEqual(g["2026_08_LAC_LA"], "Brad Allen")          # Chargers and Rams, never "Los Angeles"
        self.assertEqual(g["2026_08_LV_NYJ"], "Clay Martin")
        self.assertNotIn("2026_08_PHI_WAS", g)                        # nflverse already names Shawn Hochuli: it wins
        self.assertEqual(list(g)[0], "2026_08_CAR_GB")               # kept in kickoff order

    def test_the_block_is_footballzebras_and_the_rest_of_the_file_is_untouched(self):
        before = self.doc()
        self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", TABLE_POST))
        after = self.doc()
        self.assertEqual(after["weeks"][:len(before["weeks"])], before["weeks"])
        self.assertEqual(after["weeks"][-1]["source"], "footballzebras")
        self.assertEqual(after["_how"], before["_how"])

    def test_a_dashed_list_and_a_referee_not_yet_on_file(self):
        code, g = self.run_with(("2026 Week 8 officiating assignments", "Wed, 28 Oct 2026 15:00:00 +0000", LIST_POST))
        self.assertEqual(g["2026_08_CAR_GB"], "Clete Blakeman")
        self.assertEqual(g["2026_08_TEN_CIN"], "Ron Torbert")
        self.assertEqual(g["2026_08_LV_NYJ"], "Jordan Newcomb")       # a new crew chief, standing alone after the matchup
        self.assertNotIn("2026_08_KC_DEN", g)                          # not in the post: left unassigned

    def test_the_referee_on_the_next_line_and_a_labelled_one(self):
        _, g = self.run_with(("Week 8 referee assignments", "Thu, 29 Oct 2026 12:00:00 +0000", NEXT_LINE_POST))
        self.assertEqual(g["2026_08_CHI_SEA"], "Adrian Hill")
        self.assertEqual(g["2026_08_LAC_LA"], "Brad Allen")

    def test_a_full_crew_row_takes_the_first_crew_chief_named(self):
        _, g = self.run_with(("Week 8 referee assignments", "Thu, 29 Oct 2026 12:00:00 +0000", CREW_ROW))
        self.assertEqual(g["2026_08_KC_DEN"], "Craig Wrolstad")       # not Alan Eck, a referee listed later in the row

    def test_another_weeks_post_is_never_used(self):
        code, g = self.run_with(("Week 7 referee assignments", "Wed, 21 Oct 2026 15:00:00 +0000", TABLE_POST),
                                ("Week 8 injury report", "Wed, 28 Oct 2026 15:00:00 +0000", TABLE_POST))
        self.assertEqual(code, 0)
        self.assertEqual(g, {})

    def test_last_seasons_week_8_is_never_used(self):
        _, g = self.run_with(("Week 8 referee assignments", "Wed, 30 Oct 2024 15:00:00 +0000", TABLE_POST))
        self.assertEqual(g, {})

    def test_nothing_found_is_not_an_error_unless_required(self):
        code, _ = self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", "<p>Coming soon.</p>"))
        self.assertEqual(code, 0)
        code, _ = self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", "<p>Coming soon.</p>"), extra=["--require"])
        self.assertEqual(code, 1)

    def test_an_assignment_on_file_is_never_overwritten(self):
        self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", LIST_POST))
        changed = TABLE_POST.replace("Clete Blakeman", "Brad Rogers")
        _, g = self.run_with(("Week 8 referee assignments", "Thu, 29 Oct 2026 15:00:00 +0000", changed))
        self.assertEqual(g["2026_08_CAR_GB"], "Clete Blakeman")
        self.assertEqual(g["2026_08_KC_DEN"], "Craig Wrolstad")       # the rest filled in on the next run

    def test_a_dry_run_writes_nothing(self):
        before = self.text(self.manual)
        self.run_with(("Week 8 referee assignments", "Wed, 28 Oct 2026 15:00:00 +0000", TABLE_POST), extra=["--dry-run"])
        self.assertEqual(self.text(self.manual), before)

    def test_the_writer_keeps_the_files_own_layout(self):
        src = self.text(os.path.join(REFS, "manual_assignments.json"))
        self.assertEqual(F.dump_manual(json.loads(src)), src)


spec2 = importlib.util.spec_from_file_location("merge_season", os.path.join(REFS, "merge_season.py"))
MS = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(MS)


class Merge(unittest.TestCase):
    """merge_season.py: the Tuesday rebuild folded into the committed CSVs"""
    HEAD = "game_id,season,week,referee,source\n"

    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, "out"))
        self.write("ref_assignments.csv", self.HEAD + "2025_01_AAA_BBB,2025,1,Ref One,nflverse\n2026_01_AAA_BBB,2026,1,Ref Two,footballzebras\n")

    def tearDown(self):
        shutil.rmtree(self.d)

    def write(self, name, text, sub=""):
        with open(os.path.join(self.d, sub, name), "w") as fh:
            fh.write(text)

    def read(self, name):
        with open(os.path.join(self.d, name)) as fh:
            return fh.read()

    def test_the_season_is_replaced_and_the_others_kept(self):
        self.write("ref_assignments.csv", self.HEAD + "2026_01_AAA_BBB,2026,1,Ref Two,nflverse\n2026_02_CCC_DDD,2026,2,Ref Three,footballzebras\n", "out")
        MS.merge(os.path.join(self.d, "out"), 2026, self.d)
        self.assertEqual(self.read("ref_assignments.csv"), self.HEAD + "2025_01_AAA_BBB,2025,1,Ref One,nflverse\n"
                         "2026_01_AAA_BBB,2026,1,Ref Two,nflverse\n2026_02_CCC_DDD,2026,2,Ref Three,footballzebras\n")

    def test_an_empty_or_missing_rebuild_changes_nothing(self):
        before = self.read("ref_assignments.csv")
        self.write("ref_assignments.csv", self.HEAD, "out")
        r = MS.merge(os.path.join(self.d, "out"), 2026, self.d)
        self.assertEqual(self.read("ref_assignments.csv"), before)
        self.assertIn("left as it is", r["ref_assignments.csv"])
        self.assertIn("no rebuilt file", r["ref_game_penalties.csv"])


if __name__ == "__main__":
    unittest.main()
