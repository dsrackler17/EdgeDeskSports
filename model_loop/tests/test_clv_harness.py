"""The CLV harness on synthetic games whose right answer is known by
construction. No downloaded data.

  python3 -m unittest model_loop.tests.test_clv_harness
"""
import unittest

import numpy as np
import pandas as pd

from model_loop.clv import harness as H


def frame(rows):
    cols = ["game_id", "season", "week", "model", "bet_line", "close_line"]
    return pd.DataFrame([dict(zip(cols, r)) for r in rows])


def quick(threshold=1.0, market="spread", **kw):
    return H.Config(threshold=threshold, market=market, n_boot=300, n_perm=200, **kw)


class TestBetRule(unittest.TestCase):
    def test_hand_computed_clv(self):
        # home-margin space: model 5 vs line 3 -> bet home; close 4 -> +1 point.
        # model -1 vs line 2 -> bet away; close 3.5 (home more favoured) -> -1.5.
        # model 2.5 vs line 2 -> edge 0.5 < threshold -> no bet.
        df = frame([("a", 2020, 1, 5.0, 3.0, 4.0), ("b", 2020, 1, -1.0, 2.0, 3.5), ("c", 2020, 2, 2.5, 2.0, 7.0)])
        d = H.place_bets(df, quick(1.0), H.LineDistribution.spread())
        d = d.set_index("game_id")
        self.assertEqual(d.loc["a", "side"], 1)
        self.assertEqual(d.loc["b", "side"], -1)
        self.assertAlmostEqual(d.loc["a", "clv_pts"], 1.0)
        self.assertAlmostEqual(d.loc["b", "clv_pts"], -1.5)
        self.assertTrue(d.loc["a", "bet"] and d.loc["b", "bet"] and not d.loc["c", "bet"])
        r = H.evaluate(df, quick(1.0))
        self.assertEqual(r["n"], 2)
        self.assertAlmostEqual(r["clv_pts"], -0.25)
        self.assertAlmostEqual(r["hit_rate"], 0.5)

    def test_threshold_is_inclusive_and_zero_edge_never_bets(self):
        df = frame([("a", 2020, 1, 5.0, 3.0, 4.0), ("b", 2020, 1, 3.0, 3.0, 9.0)])
        d = H.place_bets(df, quick(2.0), H.LineDistribution.spread()).set_index("game_id")
        self.assertTrue(d.loc["a", "bet"])
        self.assertFalse(d.loc["b", "bet"])
        d0 = H.place_bets(df, quick(0.0), H.LineDistribution.spread()).set_index("game_id")
        self.assertFalse(d0.loc["b", "bet"])

    def test_model_equal_to_close_always_beats_close(self):
        rng = np.random.default_rng(1)
        n = 600
        open_ = rng.choice(np.arange(-14, 14.5, 0.5), n)
        close = open_ + rng.choice([-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2], n)
        df = pd.DataFrame({"game_id": np.arange(n), "season": 2020 + np.arange(n) % 4, "week": np.arange(n) % 17,
                           "model": close, "bet_line": open_, "close_line": close})
        r = H.evaluate(df, quick(0.5))
        self.assertEqual(r["n"], n)
        self.assertAlmostEqual(r["clv_pts"], float(np.mean(np.abs(close - open_))))
        self.assertEqual(r["hit_rate"], 1.0)
        self.assertGreater(r["clv_prob"], 0.0)
        self.assertGreater(r["clv_pts_ci95"][0], 0.0)
        self.assertLess(r["permutation"]["p_value"], 0.01)
        self.assertAlmostEqual(r["movement"]["slope"], 1.0, places=9)

    def test_model_equal_to_opener_places_no_bets(self):
        df = frame([("a", 2020, 1, 3.0, 3.0, 4.0), ("b", 2020, 1, -7.0, -7.0, -3.0)])
        r = H.evaluate(df, quick(0.5))
        self.assertEqual(r["n"], 0)

    def test_noise_model_has_no_clv(self):
        rng = np.random.default_rng(2)
        n = 4000
        open_ = np.round(rng.normal(0, 7, n) * 2) / 2
        close = open_ + np.round(rng.normal(0, 1.2, n) * 2) / 2
        model = open_ + rng.normal(0, 3, n)                 # independent of the move
        df = pd.DataFrame({"game_id": np.arange(n), "season": 2016 + np.arange(n) % 8, "week": np.arange(n) % 17,
                           "model": model, "bet_line": open_, "close_line": close})
        r = H.evaluate(df, quick(2.0))
        lo, hi = r["clv_pts_ci95"]
        self.assertLess(lo, 0.0)
        self.assertGreater(hi, 0.0)
        self.assertGreater(r["permutation"]["p_value"], 0.01)

    def test_totals_orientation(self):
        # model 50 vs total 47 -> over; close 48.5 -> +1.5. model 40 vs 44 -> under; close 42 -> +2
        df = frame([("a", 2021, 3, 50.0, 47.0, 48.5), ("b", 2021, 3, 40.0, 44.0, 42.0)])
        r = H.evaluate(df, quick(1.0, market="total"), H.LineDistribution.total(sigma=13.5, centre=45))
        self.assertAlmostEqual(r["clv_pts"], 1.75)
        self.assertEqual(r["hit_rate"], 1.0)
        self.assertGreater(r["clv_prob"], 0)


class TestProbability(unittest.TestCase):
    def setUp(self):
        mult = np.ones(71)
        mult[3], mult[7], mult[10] = 2.8, 1.8, 1.3               # key numbers carry extra mass
        self.dist = H.LineDistribution.spread(sigma=13.5, mult=mult)

    def test_no_move_no_prices_is_zero(self):
        df = frame([("a", 2020, 1, 6.0, 3.5, 3.5), ("b", 2020, 1, -6.0, 3.0, 3.0)])
        d = H.place_bets(df, quick(1.0), self.dist)
        np.testing.assert_allclose(d.clv_prob.values, 0.0, atol=1e-6)

    def test_key_number_is_worth_more(self):
        # half a point across 3 (2.5 -> 3.5) is worth more than across 5 (4.5 -> 5.5)
        df = frame([("k", 2020, 1, 9.0, 2.5, 3.5), ("n", 2020, 1, 9.0, 4.5, 5.5)])
        d = H.place_bets(df, quick(1.0), self.dist).set_index("game_id")
        self.assertGreater(d.loc["k", "clv_prob"], d.loc["n", "clv_prob"])
        self.assertGreater(d.loc["n", "clv_prob"], 0)

    def test_symmetry(self):
        # the same move from the other side is the same loss
        df = frame([("h", 2020, 1, 9.0, 2.5, 3.5), ("a", 2020, 1, -9.0, 2.5, 3.5)])
        d = H.place_bets(df, quick(1.0), self.dist).set_index("game_id")
        self.assertAlmostEqual(d.loc["h", "clv_prob"], -d.loc["a", "clv_prob"], places=9)

    def test_prices_enter(self):
        # same number at open and close, but the home price went from -110/-110 to -125/+105:
        # a home bet at the open gained probability, an away bet lost it
        from model_loop.core.distribution import no_vig_two_way
        pc = no_vig_two_way(-125, 105)
        df = frame([("h", 2020, 1, 9.0, 3.0, 3.0), ("a", 2020, 1, -9.0, 3.0, 3.0)])
        df["bet_p"] = 0.5
        df["close_p"] = pc
        d = H.place_bets(df, quick(1.0), self.dist).set_index("game_id")
        self.assertAlmostEqual(d.loc["h", "clv_prob"], pc - 0.5, places=4)
        self.assertAlmostEqual(d.loc["a", "clv_prob"], 0.5 - pc, places=4)

    def test_roi_at_bet_price(self):
        # no move, no prices: the close says 50/50, a -110 bet returns 0.5 * 1.909 - 1
        df = frame([("h", 2020, 1, 9.0, 3.5, 3.5)])
        d = H.place_bets(df, quick(1.0), self.dist).set_index("game_id")
        self.assertAlmostEqual(d.loc["h", "roi"], 0.5 * (1 + 100 / 110) - 1, places=6)
        # the same bet at +100 breaks even, and a line that moved our way pays more
        df = frame([("h", 2020, 1, 9.0, 3.5, 3.5), ("m", 2020, 1, 9.0, 3.5, 5.5)])
        df["bet_odds_over"] = 100.0
        df["bet_odds_under"] = -120.0
        d = H.place_bets(df, quick(1.0), self.dist).set_index("game_id")
        self.assertAlmostEqual(d.loc["h", "roi"], 0.0, places=6)
        self.assertGreater(d.loc["m", "roi"], 0.0)

    def test_implied_mu_inverts(self):
        lines = np.array([-7.0, -3.0, 0.5, 3.0, 6.5, 14.0])
        ps = np.array([0.45, 0.5, 0.55, 0.52, 0.48, 0.5])
        mu = self.dist.implied_mu(lines, ps)
        np.testing.assert_allclose(self.dist.p_over(mu, lines), ps, atol=1e-6)


class TestInference(unittest.TestCase):
    def test_bootstrap_covers_and_shrinks(self):
        rng = np.random.default_rng(3)
        small = rng.normal(0.3, 1.0, 200)
        big = rng.normal(0.3, 1.0, 5000)
        cs = np.arange(200) // 4
        cb = np.arange(5000) // 4
        lo_s, hi_s = H.cluster_bootstrap(small, cs, 1000, rng)[0]
        lo_b, hi_b = H.cluster_bootstrap(big, cb, 1000, rng)[0]
        self.assertTrue(lo_b < 0.3 < hi_b)
        self.assertLess(hi_b - lo_b, hi_s - lo_s)

    def test_cluster_bootstrap_is_wider_for_correlated_weeks(self):
        rng = np.random.default_rng(4)
        weeks = np.repeat(np.arange(100), 10)
        shock = rng.normal(0, 1, 100)[weeks]                    # every game in a week moves together
        v = shock + rng.normal(0, 0.2, 1000)
        lo_c, hi_c = H.cluster_bootstrap(v, weeks, 1000, rng)[0]
        lo_i, hi_i = H.cluster_bootstrap(v, np.arange(1000), 1000, rng)[0]
        self.assertGreater(hi_c - lo_c, 1.5 * (hi_i - lo_i))

    def test_buckets_partition_nonzero_edges(self):
        df = frame([("a", 2020, 1, 3.5, 3.0, 3.0), ("b", 2020, 1, 4.5, 3.0, 3.0), ("c", 2020, 1, 5.5, 3.0, 4.0),
                    ("d", 2020, 1, 9.0, 3.0, 2.0), ("e", 2020, 1, 3.0, 3.0, 1.0)])
        r = H.evaluate(df, quick(0.0))
        counts = {b["bucket"]: b["n"] for b in r["buckets"]}
        self.assertEqual(counts, {"0-1": 1, "1-2": 1, "2-3": 1, "3+": 1})

    def test_holm(self):
        adj = H.holm([0.01, 0.04, 0.03, 0.5])
        self.assertAlmostEqual(adj[0], 0.04)
        self.assertAlmostEqual(adj[2], 0.09)
        self.assertAlmostEqual(adj[1], 0.09)
        self.assertAlmostEqual(adj[3], 0.5)
        self.assertGreater(H.bonferroni_z(50), H.bonferroni_z(1))

    def test_per_season_rows_sum(self):
        df = frame([("a", 2020, 1, 5.0, 3.0, 4.0), ("b", 2021, 1, 5.0, 3.0, 2.0), ("c", 2021, 2, 5.0, 3.0, 3.5)])
        r = H.evaluate(df, quick(1.0))
        by = {x["season"]: x for x in r["by_season"]}
        self.assertEqual(by[2020]["n"], 1)
        self.assertEqual(by[2021]["n"], 2)
        self.assertAlmostEqual(by[2021]["clv_pts"], -0.25)

    def test_fitted_distributions(self):
        rng = np.random.default_rng(5)
        close = np.round(rng.normal(0, 6, 3000) * 2) / 2
        res = np.round(close + rng.normal(0, 13, 3000))
        res[rng.random(3000) < 0.08] = np.sign(close[:1])[0] * 3     # extra mass on 3
        sp = H.LineDistribution.fit_spread(close, res)
        self.assertTrue(10.0 <= sp.d.sigma <= 16.5)
        tot_close = 44 + np.round(rng.normal(0, 4, 3000) * 2) / 2
        tot = H.LineDistribution.fit_total(tot_close, tot_close + rng.normal(0, 13, 3000))
        self.assertAlmostEqual(tot.d.sigma, 13.0, delta=0.6)
        # a total half a point better is worth roughly 1.5% of probability
        p = tot.p_over(np.array([45.0]), np.array([44.5]))[0] - tot.p_over(np.array([45.0]), np.array([45.0]))[0]
        self.assertTrue(0.005 < p < 0.03)

    def test_sweep_monotone_bet_count(self):
        rng = np.random.default_rng(6)
        n = 500
        o = np.round(rng.normal(0, 7, n) * 2) / 2
        df = pd.DataFrame({"game_id": np.arange(n), "season": 2021, "week": np.arange(n) % 17,
                           "model": o + rng.normal(0, 3, n), "bet_line": o, "close_line": o + 0.5})
        res = H.sweep(df, [0.5, 1.0, 2.0, 3.0], quick())
        counts = [r["n"] for r in res]
        self.assertEqual(counts, sorted(counts, reverse=True))

    def test_missing_columns_raise(self):
        with self.assertRaises(ValueError):
            H.evaluate(pd.DataFrame({"game_id": [1]}), quick())


if __name__ == "__main__":
    unittest.main()


class TestHoldoutLock(unittest.TestCase):
    def test_holdout_refused_without_unlock(self):
        from model_loop.clv import run as R
        R.guard([2020, 2024], False)
        with self.assertRaises(R.HoldoutLocked):
            R.guard([2024, 2025], False)
        with self.assertRaises(R.HoldoutLocked):
            R.guard([2026], False)
        R.guard([2025, 2026], True)
