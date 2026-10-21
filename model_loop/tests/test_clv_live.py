"""The live CLV tracker (research/clv/live.py) applies a candidate's frozen
rule exactly: a residual candidate's predicted move is its intercept plus its
coefficients on the disagreements, the bet is graded by the same harness, and
a model number captured too long after the opener is never graded.

Run: python3 -m unittest model_loop.tests.test_clv_live -v
"""
import unittest

import numpy as np
import pandas as pd

from research.clv import live as L


class TestLive(unittest.TestCase):
    def frames(self):
        return {"nfl": pd.DataFrame({
            "game_id": ["a", "b", "c"], "season": 2026, "cluster": ["w1", "w1", "w2"], "late": [False, False, True],
            "open_line": [3.0, -2.0, 1.0], "close_line": [4.0, -3.0, 1.0], "open_total": [44.0, 47.0, 40.0],
            "close_total": [44.0, 46.0, 40.0], "v21": [6.0, -6.0, 9.0], "loop": [5.0, -4.0, 9.0],
            "v21_total": [44.0, 45.0, 40.0], "loop_total": [44.0, 45.0, 40.0]})}

    def test_residual_rule_is_frozen_linear(self):
        c = {"kind": "points", "market": "spread", "rule": "residual", "frame": "nfl", "threshold": 0.25,
             "features": {"d_v21": "v21", "d_loop": "loop"}, "coef": {"d_v21": 0.1, "d_loop": 0.05}, "intercept": -0.1}
        x = L.candidate_frame(c, self.frames())
        self.assertEqual(list(x.game_id), ["a", "b"])                 # the late capture is not graded
        exp = np.array([-0.1 + 0.1 * 3 + 0.05 * 2, -0.1 + 0.1 * -4 + 0.05 * -2])
        self.assertTrue(np.allclose(x.model_line - x.open_line, exp))

    def test_base_rule_and_totals(self):
        c = {"kind": "points", "market": "total", "rule": "base", "input": "v21_total", "frame": "nfl", "threshold": 1.5}
        x = L.candidate_frame(c, self.frames())
        self.assertTrue(np.allclose(x.open_line, [44.0, 47.0]))
        self.assertTrue(np.allclose(x.model_line, [44.0, 45.0]))

    def test_loop_w2_only_numbers_published_before_either_teams_last_game(self):
        # week 8: A plays Tuesday 10-20, B Saturday 10-24, C and D Saturday; week 9: A-B and C-E (E on a bye in week 8)
        preds = pd.DataFrame({"game_id": ["w8a", "w8b", "w8c", "g1", "g2", "g3"], "season_type": "regular",
                              "week": [8, 8, 8, 9, 9, 9],
                              "home": ["A", "B", "C", "A", "C", "F"], "away": ["X", "Y", "D", "B", "E", "G"],
                              "kickoff_ts": ["2026-10-20T23:00:00Z", "2026-10-24T16:00:00Z", "2026-10-24T19:00:00Z",
                                             "2026-10-31T16:00:00Z", "2026-10-31T19:00:00Z", "2026-10-31T20:00:00Z"]})
        m = lambda gid, t, v: {"sport": "cfb_loop", "game_id": gid, "captured_at": t, "generated_at": t, "week": 9,
                               "loop": v, "loop_total": 50.0}
        models = [m("g1", "2026-10-21T03:00:00Z", 1.0),     # after A's Tuesday game: excluded
                  m("g2", "2026-10-21T03:00:00Z", 2.0),     # before C's Saturday game (E had a bye): kept
                  m("g3", "2026-10-21T03:00:00Z", 3.0)]     # F and G did not play in week 8: must predate week 8's first kick: excluded
        keep = L._jsonl
        L._jsonl = lambda p: models if p == L.MODELS else keep(p)
        try:
            w2 = L.loop_w2(preds)
        finally:
            L._jsonl = keep
        self.assertEqual(list(w2.index), ["g2"])
        self.assertEqual(float(w2.loc["g2", "loop"]), 2.0)

    def test_w2_base_rule_skips_games_without_a_w2_number(self):
        f = {"cfb": pd.DataFrame({"game_id": ["g1", "g2"], "season": 2026, "cluster": "c", "open_line": [3.0, 1.0],
                                  "close_line": [4.0, 1.5], "v2_w2": [7.5, np.nan]})}
        c = {"kind": "points", "market": "spread", "rule": "base", "input": "v2_w2", "frame": "cfb", "threshold": 3.0}
        x = L.candidate_frame(c, f)
        self.assertEqual(list(x.dropna(subset=["model_line"]).game_id), ["g1"])

    def test_missing_frame_is_empty(self):
        c = {"kind": "price", "market": "moneyline", "rule": "base", "input": "p", "frame": None, "threshold": 0.02}
        self.assertTrue(L.candidate_frame(c, self.frames()).empty)


if __name__ == "__main__":
    unittest.main()
