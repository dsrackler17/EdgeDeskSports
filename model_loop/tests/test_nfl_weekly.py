"""The NFL weekly loop's own rules: pregame-only grading, the head-to-head
with the board, how a candidate changes the served config, and which
candidates a week's misses pull forward. No data download is needed."""
import json
import os
import tempfile
import unittest

import pandas as pd

from model_loop.adapters.nfl import weekly as W


class PregameTest(unittest.TestCase):
    def test_last_row_before_kickoff_only(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "site.jsonl")
        with open(p, "w") as f:
            for at, m in (("2026-10-20T00:00:00Z", 1.0), ("2026-10-22T12:00:00Z", 2.0), ("2026-10-23T01:00:00Z", 9.0)):
                f.write(json.dumps({"game_id": "g", "published_at": at, "home_margin": m}) + "\n")
        got = W._pregame(p, {"g": pd.Timestamp("2026-10-23T00:15:00Z")})
        self.assertEqual(got["g"]["home_margin"], 2.0)          # the 01:00 row came after kickoff
        self.assertEqual(W._pregame(p, {}), {})                  # an unknown game is never graded
        self.assertEqual(W._pregame(os.path.join(d, "none.jsonl"), {"g": pd.Timestamp("2026-10-23")}), {})


class CaptureTest(unittest.TestCase):
    def test_only_pregame_numbers_and_only_when_they_change(self):
        from model_loop.core import head_to_head as H2H
        d = tempfile.mkdtemp()
        slate, led = os.path.join(d, "slate.json"), os.path.join(d, "site.jsonl")
        games = [{"game_id": 1, "season": 2026, "week": 8, "kickoff": "2026-10-24T17:00:00.000Z", "model_status": "PREDICTED",
                  "model_home_margin": 3.5, "model_home_win_prob": 0.6, "model_version": "b1"},
                 {"game_id": 2, "season": 2026, "week": 8, "kickoff": "2026-10-20T23:00:00.000Z", "model_status": "PREDICTED",
                  "model_home_margin": 1.0, "model_home_win_prob": 0.52, "model_version": "b1"},
                 {"game_id": 3, "season": 2026, "week": 8, "kickoff": "2026-10-24T20:00:00.000Z", "model_status": "NO_MODEL"}]
        with open(slate, "w") as f:
            json.dump({"generated_at": "2026-10-21T02:44:52.694Z", "games": games}, f)
        self.assertEqual(H2H.capture(slate, led, 2026, "t"), 1)        # started and unpriced games are skipped
        self.assertEqual(H2H.capture(slate, led, 2026, "t"), 0)        # an unchanged number is not appended again
        games[0]["model_home_margin"] = 4.0
        with open(slate, "w") as f:
            json.dump({"generated_at": "2026-10-21T08:00:00.000Z", "games": games}, f)
        self.assertEqual(H2H.capture(slate, led, 2026, "t"), 1)
        got = H2H.pregame(led, {"1": pd.Timestamp("2026-10-24T17:00:00Z")})
        self.assertEqual(got["1"]["home_margin"], 4.0)
        self.assertEqual(H2H.capture(os.path.join(d, "none.json"), led, 2026, "t"), 0)


class HeadToHeadTest(unittest.TestCase):
    def row(self, result, model, board, close, p_model, p_board):
        y = 1.0 if result > 0 else 0.0
        return {"game_id": "x", "week": 7, "version": "2.0.0", "result": result, "home_win_prob": p_model,
                "model_abs_err": abs(result - model), "brier": (p_model - y) ** 2, "close_home_margin": close,
                "gap_vs_close": model - close,
                "board": {"version": "b", "home_margin": board, "home_win_prob": p_board, "abs_err": abs(result - board),
                          "brier": (p_board - y) ** 2}}

    def test_same_games_both_sides(self):
        rs = [self.row(7, 3, -1, 2.5, 0.6, 0.65), self.row(-3, 1, -2, -1, 0.55, 0.35)]
        h = W.head_to_head(rs)
        self.assertEqual(h["n"], 2)
        self.assertAlmostEqual(h["model_loop"]["mae"], (4 + 4) / 2)
        self.assertAlmostEqual(h["board"]["mae"], (8 + 1) / 2)
        self.assertAlmostEqual(h["close_mae"], (4.5 + 2) / 2)
        self.assertAlmostEqual(h["model_loop"]["mean_abs_vs_close"], (0.5 + 2) / 2)
        self.assertAlmostEqual(h["board"]["mean_abs_vs_close"], (3.5 + 1) / 2)
        self.assertLess(h["board"]["brier"], h["model_loop"]["brier"])

    def test_a_tie_has_no_probability_score(self):
        r = self.row(0, 1, -1, 0.5, 0.5, 0.5)
        r["brier"] = None
        r["board"]["brier"] = None
        h = W.head_to_head([r])
        self.assertIsNone(h["model_loop"]["brier"])
        self.assertIsNone(h["board"]["logloss"])


class CandidateTest(unittest.TestCase):
    CFG = {"rating": {"hl_week": 12, "lam": {"pass_off": 600}, "carry": {"off": 0.8}, "market": {"lam_hfa": 20}},
           "model": {"hfa_prior_games": 0, "components": {"division": False}}}

    def test_single_changes(self):
        self.assertEqual(W._apply(self.CFG, "rating.hl_week", ("mul", 0.5))["rating"]["hl_week"], 6)
        self.assertEqual(W._apply(self.CFG, "rating.carry.off", ("add", 0.3))["rating"]["carry"]["off"], 1.0)   # clipped
        self.assertIsNone(W._apply(self.CFG, "model.components.division", ("set", False)))                    # no change
        self.assertEqual(self.CFG["rating"]["hl_week"], 12)                                                   # never mutated

    def test_a_key_left_at_its_default_can_be_set(self):
        c = W._apply(self.CFG, "model.hfa_target", ("set", "recent"))
        self.assertEqual(c["model"]["hfa_target"], "recent")
        self.assertIsNone(W._apply(self.CFG, "model.not_there", ("mul", 2.0)))

    def test_multi(self):
        how = ("multi", [("model.hfa_target", ("set", "recent")), ("model.hfa_prior_games", ("set", 300.0))])
        c = W._apply(self.CFG, "multi", how)
        self.assertEqual((c["model"]["hfa_target"], c["model"]["hfa_prior_games"]), ("recent", 300.0))
        self.assertNotIn("hfa_target", self.CFG["model"])

    def test_every_catalogue_entry_applies_to_the_served_config(self):
        cfg = W.versions().current["config"]
        ids = [c[0] for c in W.CATALOGUE]
        self.assertEqual(len(ids), len(set(ids)))
        for cid, path, how, _ in W.CATALOGUE:
            W._apply(cfg, path, how)          # raises on a bad path


class RankingTest(unittest.TestCase):
    def test_strongest_pattern_first_and_rotation_fills(self):
        pats = [{"pattern": "home_dogs", "line_t": 6.2, "outcome_t": -1.5}, {"pattern": "home", "line_t": 3.8, "outcome_t": 0},
                {"pattern": "travel", "line_t": 0.7, "outcome_t": 0.2}]
        order = W.rank_candidates(pats, 202606)
        self.assertEqual(len(order), W.MAX_CANDIDATES)
        self.assertEqual(len(set(order)), len(order))
        self.assertTrue(order[0].startswith("hfa_"))
        answers = {c[0]: c[3] for c in W.CATALOGUE}
        self.assertIn("home_dogs", answers[order[1]])

    def test_no_signal_rotates_through_the_catalogue(self):
        a = W.rank_candidates([], 202606)
        b = W.rank_candidates([], 202607)
        self.assertEqual(len(a), W.MAX_CANDIDATES)
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
