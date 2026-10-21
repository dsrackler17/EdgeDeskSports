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

    def test_missing_frame_is_empty(self):
        c = {"kind": "price", "market": "moneyline", "rule": "base", "input": "p", "frame": None, "threshold": 0.02}
        self.assertTrue(L.candidate_frame(c, self.frames()).empty)


if __name__ == "__main__":
    unittest.main()
