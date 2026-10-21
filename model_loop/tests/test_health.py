"""The health rules and the degraded-data flag, on synthetic loop outputs."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone

from model_loop import health as H
from model_loop.core import data_status


def card(gid, home_line=-3.0, basis="reconciled starter", unattributed=0.0):
    return {"game_id": gid, "starters": {"home": {"id": "h", "basis": basis}, "away": {"id": "a", "basis": "reconciled starter"}},
            "market_reference": {"home_line": home_line}, "reconciliation": {"unattributed": unattributed}}


class DataStatusTest(unittest.TestCase):
    def test_clean_slate_is_ok(self):
        out = {"games": [card("g1"), card("g2")]}
        ds = data_status.stamp(out, [], "2026-10-21T00:00:00Z")
        self.assertEqual(ds["status"], "OK")
        self.assertTrue(all(g["data_status"]["status"] == "OK" for g in out["games"]))

    def test_a_card_says_what_it_is_missing_without_failing_the_slate(self):
        out = {"games": [card("g1", basis="UNRESOLVED: schedule feed names A, depth chart names B"), card("g2", home_line=None)]}
        ds = data_status.stamp(out, [])
        self.assertEqual(ds["status"], "OK")
        self.assertEqual(ds["games_flagged"], 2)
        self.assertIn("starter unresolved", out["games"][0]["data_status"]["reasons"][0])
        self.assertIn("no reference line", out["games"][1]["data_status"]["reasons"][0])

    def test_missing_results_or_a_broken_card_degrade_the_slate(self):
        ds = data_status.stamp({"games": [card("g1")]}, ["2026_07_KC_SEA"])
        self.assertEqual(ds["status"], "DEGRADED")
        self.assertIn("1 game(s) already played", ds["reasons"][0])
        ds = data_status.stamp({"games": [card("g1", unattributed=0.5)]}, [])
        self.assertEqual(ds["status"], "DEGRADED")


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self._root = H.ROOT
        H.ROOT = self.root

    def tearDown(self):
        H.ROOT = self._root
        shutil.rmtree(self.root)

    def put(self, rel, obj):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            json.dump(obj, f)

    def versions(self, lid, since="2026-10-01T00:00:00Z"):
        self.put(f"docs/model-loop/{lid}/versions.json", {"current": "1.0.0", "versions": [{"version": "1.0.0", "promoted_at": since, "promoted_by": "x"}]})

    def test_a_fresh_loop_in_season_is_ok(self):
        now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
        self.versions("nfl")
        self.put("football/nfl/model_loop/current.json", {"generated_at": "2026-10-21T08:00:00Z", "season": 2026, "games": [{}],
                                                          "data_status": {"status": "OK", "reasons": []}})
        self.put("docs/model-loop/nfl/weekly/2026-w06.json", {"at": "2026-10-20T15:00:00Z", "promoted": None, "candidates": []})
        x = H.loop_health(H.LOOPS[0], now)
        self.assertEqual(x["status"], "OK", x["reasons"])

    def test_stale_refresh_research_and_results_are_named(self):
        now = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
        self.versions("ncaam")
        self.put("basketball/params/ncaam_live.json", {"generated_at": "2026-11-17T00:00:00Z", "last_game_date": "2026-11-10"})
        self.put("docs/model-loop/ncaam/weekly/2026-11-01.json", {"at": "2026-11-01T10:00:00Z"})
        x = H.loop_health(next(L for L in H.LOOPS if L["id"] == "ncaam"), now)
        self.assertEqual(x["status"], "STALE")
        text = " | ".join(x["reasons"])
        self.assertIn("last refresh", text)
        self.assertIn("last weekly research 19 days ago", text)
        self.assertIn("newest result", text)

    def test_degraded_cards_make_the_loop_degraded(self):
        now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
        self.versions("cfb")
        self.put("football/cfb/model_loop/current.json", {"generated_at": "2026-10-21T08:00:00Z", "season": 2026, "games": [],
                                                          "data_status": {"status": "DEGRADED", "reasons": ["3 game(s) already played have no result"]}})
        x = H.loop_health(H.LOOPS[1], now)
        self.assertEqual(x["status"], "DEGRADED")

    def test_out_of_season_nothing_is_expected_unless_games_are_still_played(self):
        self.versions("wnba")
        self.put("basketball/params/wnba_live.json", {"generated_at": "2026-10-10T00:00:00Z", "last_game_date": "2026-09-20"})
        L = next(L for L in H.LOOPS if L["id"] == "wnba")
        self.assertEqual(H.loop_health(L, datetime(2026, 12, 1, tzinfo=timezone.utc))["status"], "OFF_SEASON")
        self.put("basketball/params/wnba_live.json", {"generated_at": "2026-10-10T00:00:00Z", "last_game_date": "2026-10-19"})
        self.assertEqual(H.loop_health(L, datetime(2026, 10, 21, tzinfo=timezone.utc))["status"], "STALE")

    def season(self, lid, season, rows):
        p = os.path.join(self.root, "basketball", "data", lid, f"{season}.csv")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write("game_id,season,date,status\n" + "".join(f"{i},{season},{d},{s}\n" for i, (d, s) in enumerate(rows)))

    def fresh_basketball(self, lid, now, last_game, for_season):
        self.versions(lid)
        self.put(f"basketball/params/{lid}_live.json", {"generated_at": (now.replace(hour=0)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                                        "last_game_date": last_game, "for_season": for_season})
        self.put(f"docs/model-loop/{lid}/weekly/x.json", {"at": now.replace(hour=0).strftime("%Y-%m-%dT%H:%M:%SZ")})
        return next(L for L in H.LOOPS if L["id"] == lid)

    def test_opening_night_is_not_stale_results(self):
        now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
        L = self.fresh_basketball("nba", now, "2026-06-13", 2027)
        self.season("nba", 2027, [("2026-10-20", "SCHEDULED"), ("2026-10-21", "SCHEDULED"), ("2026-11-01", "SCHEDULED")])
        x = H.loop_health(L, now)
        self.assertEqual(x["status"], "OK", x["reasons"])

    def test_games_past_due_are_counted_from_the_schedule(self):
        now = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        L = self.fresh_basketball("nba", now, "2026-10-24", 2027)
        self.season("nba", 2027, [("2026-10-24", "FINAL"), ("2026-10-25", "SCHEDULED"), ("2026-10-26", "SCHEDULED"),
                                  ("2026-10-27", "SCHEDULED")])
        x = H.loop_health(L, now)
        self.assertEqual(x["status"], "STALE")
        self.assertIn("2 game(s) played more than 4 days ago are not in the ratings (the first on 2026-10-25)", " | ".join(x["reasons"]))

    def test_a_final_after_the_calendar_season_keeps_the_loop_in_season(self):
        now = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)
        L = self.fresh_basketball("wnba", now, "2026-10-17", 2026)
        self.season("wnba", 2026, [("2026-10-17", "FINAL"), ("2026-10-26", "SCHEDULED")])
        x = H.loop_health(L, now)
        self.assertTrue(x["in_season"])
        self.assertEqual(x["status"], "OK", x["reasons"])
        late = H.loop_health(L, datetime(2026, 11, 3, tzinfo=timezone.utc))     # the final's result never came
        self.assertEqual(late["status"], "STALE")
        self.assertIn("(the first on 2026-10-26)", " | ".join(late["reasons"]))
        self.assertEqual(H.loop_health(L, datetime(2026, 11, 20, tzinfo=timezone.utc))["status"], "OFF_SEASON")

    def test_a_missing_history_is_degraded_even_out_of_season(self):
        x = H.loop_health(H.LOOPS[0], datetime(2026, 6, 1, tzinfo=timezone.utc))
        self.assertEqual(x["status"], "DEGRADED")


if __name__ == "__main__":
    unittest.main()
