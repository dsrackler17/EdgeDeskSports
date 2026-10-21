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

    def test_a_missing_history_is_degraded_even_out_of_season(self):
        x = H.loop_health(H.LOOPS[0], datetime(2026, 6, 1, tzinfo=timezone.utc))
        self.assertEqual(x["status"], "DEGRADED")


if __name__ == "__main__":
    unittest.main()
