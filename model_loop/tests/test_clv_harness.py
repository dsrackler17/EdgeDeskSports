"""The CLV harness on synthetic cases whose answers are known in advance.

  - odds conversion and de-vig on textbook prices;
  - a model that knows the close earns exactly the line move, all toward it;
  - a model that is backwards earns exactly minus the move;
  - a model with no information earns zero within its interval;
  - thresholds, buckets and seasons count the bets they should;
  - points CLV in probability matches a closed-form integer-margin case;
  - moneyline CLV and EV match hand arithmetic;
  - the cluster bootstrap widens the interval when bets share news;
  - Holm and the alpha / k verdict behave;
  - the residual model's walk-forward never sees its own season.

Run: python3 -m unittest model_loop.tests.test_clv_harness -v
"""
import math
import unittest

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import residual as R


def points_frame(open_line, close_line, model_line, season=2015, result=None, cluster=None):
    n = len(open_line)
    d = pd.DataFrame({"season": season if np.ndim(season) else [season] * n, "game_id": np.arange(n),
                      "open_line": open_line, "close_line": close_line, "model_line": model_line})
    if result is not None:
        d["result"] = result
    if cluster is not None:
        d["cluster"] = cluster
    return d


class TestOdds(unittest.TestCase):
    def test_conversions(self):
        self.assertAlmostEqual(float(H.implied(-110)), 110 / 210, places=12)
        self.assertAlmostEqual(float(H.implied(150)), 0.4, places=12)
        self.assertAlmostEqual(float(H.decimal(150)), 2.5, places=12)
        self.assertAlmostEqual(float(H.decimal(-200)), 1.5, places=12)

    def test_no_vig(self):
        self.assertAlmostEqual(float(H.no_vig(-110, -110)), 0.5, places=12)
        pa, pb = 150 / 250, 100 / 230
        self.assertAlmostEqual(float(H.no_vig(-150, 130)), pa / (pa + pb), places=12)
        p = H.no_vig(-150, 130, "power")
        q = H.no_vig(130, -150, "power")
        self.assertAlmostEqual(p + q, 1.0, places=6)
        # power shades the longshot more than multiplicative does
        self.assertLess(q, 1 - float(H.no_vig(-150, 130)))


class TestPointsCLV(unittest.TestCase):
    def setUp(self):
        self.cfg = H.HarnessConfig(kind="points", thresholds=(0.5, 1.0, 2.0), n_boot=500)

    def test_perfect_model_earns_the_move(self):
        o = np.zeros(200)
        c = np.where(np.arange(200) % 2 == 0, 2.0, -1.0)
        bets = H.bet_table(points_frame(o, c, c), self.cfg, 0.5)
        self.assertEqual(len(bets), 200)
        self.assertAlmostEqual(bets.clv_pts.mean(), 1.5, places=12)
        self.assertTrue((bets.toward > 0).all())
        s = H.summarize(bets, self.cfg)
        self.assertAlmostEqual(s["direction_hit_rate"]["mean"], 1.0)
        self.assertGreater(s["clv_prob"]["mean"], 0)

    def test_backwards_model_loses_the_move(self):
        o = np.zeros(100)
        c = np.full(100, 1.5)
        bets = H.bet_table(points_frame(o, c, -c), self.cfg, 0.5)
        self.assertAlmostEqual(bets.clv_pts.mean(), -1.5, places=12)
        self.assertTrue((bets.clv_prob < 0).all())

    def test_uninformed_model_is_zero_within_interval(self):
        rng = np.random.default_rng(3)
        n = 6000
        o = rng.normal(0, 7, n).round() / 1.0
        c = o + rng.choice([-1.0, -0.5, 0, 0.5, 1.0], n)
        m = o + rng.normal(0, 3, n)
        r = H.evaluate(points_frame(o, c, m), H.HarnessConfig(kind="points", thresholds=(1.0,), n_boot=800))
        ci = r["primary"]["clv_pts"]["ci95"]
        self.assertLess(ci[0], 0)
        self.assertGreater(ci[1], 0)

    def test_thresholds_buckets_seasons_count(self):
        o = np.zeros(10)
        m = np.array([0.25, 0.75, 1.0, 1.5, 2.0, 2.5, -3.0, -4.0, -6.0, 0.0])
        c = np.zeros(10)
        d = points_frame(o, c, m, season=np.repeat([2014, 2015], 5))
        self.assertEqual(len(H.bet_table(d, self.cfg, 0.5)), 8)
        self.assertEqual(len(H.bet_table(d, self.cfg, 1.0)), 7)
        self.assertEqual(len(H.bet_table(d, self.cfg, 2.0)), 5)
        rows = H.bucket_table(d, self.cfg)
        self.assertEqual(sum(r["n_bets"] for r in rows), 9)          # every nonzero edge, once
        self.assertEqual([r["n_bets"] for r in rows], [2, 2, 2, 2, 1, 0][: len(rows)])
        seasons = {r["season"]: r["n_bets"] for r in H.season_table(d, self.cfg, 0.5)}
        self.assertEqual(seasons, {2014: 4, 2015: 4})

    def test_probability_clv_closed_form(self):
        """Home bet at an opening line of 3 (home -3); the close is 3.5 at
        even prices. Under a discretised normal centred on 3.5 the home side
        at 3 wins with P(X >= 4) = 1/2 and pushes with p3, so the closing
        market's no-push probability is 0.5 / (1 - p3)."""
        dist = H.IntegerNormal(13.5)
        cfg = H.HarnessConfig(kind="points", thresholds=(0.5,), dist=dist, n_boot=50)
        bets = H.bet_table(points_frame([3.0], [3.5], [5.0]), cfg, 0.5)
        _, p3, _ = dist.cover(3.5, 3.0)
        self.assertAlmostEqual(float(bets.p_close.iloc[0]), 0.5 / (1 - p3[0]), places=9)
        self.assertAlmostEqual(float(bets.clv_prob.iloc[0]), 0.5 / (1 - p3[0]) - 0.5, places=9)
        # EV at -110: no-push probability times the payout, scaled by no-push mass
        q = 0.5 / (1 - p3[0])
        ev = (1 - p3[0]) * (q * (100 / 110) - (1 - q))
        self.assertAlmostEqual(float(bets.clv_ev.iloc[0]), ev, places=9)

    def test_key_number_crossing_worth_more(self):
        """With key-number multipliers (mass piled on |margin| = 3), moving
        through 3 is worth more probability than 9 -> 9.5."""
        mult = np.ones(71)
        mult[3], mult[7] = 2.5, 1.6
        dist = H.KeyNumberMargin(sigma=13.5, mult=mult)
        cfg = H.HarnessConfig(kind="points", thresholds=(0.25,), dist=dist, n_boot=50)
        b = H.bet_table(points_frame([2.5, 8.5], [3.5, 9.5], [6.0, 12.0]), cfg, 0.25)
        self.assertGreater(b.clv_prob.iloc[0], b.clv_prob.iloc[1])

    def test_totals_and_away_side(self):
        cfg = H.HarnessConfig(kind="points", market="total", thresholds=(1.0,), dist=H.IntegerNormal(13.5), n_boot=50)
        b = H.bet_table(points_frame([45.0], [43.0], [41.0]), cfg, 1.0)   # under at 45, closes 43
        self.assertEqual(b.side.iloc[0], -1)
        self.assertAlmostEqual(b.clv_pts.iloc[0], 2.0)
        self.assertGreater(b.clv_prob.iloc[0], 0)

    def test_results_diagnostic(self):
        cfg = H.HarnessConfig(kind="points", thresholds=(0.5,), n_boot=50)
        d = points_frame([0.0] * 4, [0.0] * 4, [1.0] * 4, result=[3, -3, 0, 5])
        s = H.summarize(H.bet_table(d, cfg, 0.5), cfg)
        self.assertEqual((s["results"]["wins"], s["results"]["losses"], s["results"]["pushes"]), (2, 1, 1))
        self.assertAlmostEqual(s["results"]["roi_at_open"]["mean"], (2 * 100 / 110 - 1) / 4, places=4)


class TestPriceCLV(unittest.TestCase):
    def frame(self, **kw):
        base = {"season": 2016, "game_id": 0, "open_a": -110, "open_b": -110, "close_a": -130, "close_b": 110,
                "model_prob": 0.6}
        base.update(kw)
        return pd.DataFrame([base])

    def test_hand_arithmetic(self):
        cfg = H.HarnessConfig(kind="price", market="moneyline", thresholds=(0.02,), buckets=(0, 0.05, 1), n_boot=50)
        b = H.bet_table(self.frame(), cfg, 0.02)
        pa, pb = 130 / 230, 100 / 210
        p_close = pa / (pa + pb)
        self.assertEqual(b.side.iloc[0], 1)
        self.assertAlmostEqual(b.p_open.iloc[0], 0.5, places=12)
        self.assertAlmostEqual(b.clv_prob.iloc[0], p_close - 0.5, places=12)
        self.assertAlmostEqual(b.clv_ev.iloc[0], p_close * (1 + 100 / 110) - 1, places=12)

    def test_side_b_and_threshold(self):
        cfg = H.HarnessConfig(kind="price", market="moneyline", thresholds=(0.02,), buckets=(0, 0.05, 1), n_boot=50)
        b = H.bet_table(self.frame(model_prob=0.4), cfg, 0.02)
        self.assertEqual(b.side.iloc[0], -1)
        self.assertLess(b.clv_prob.iloc[0], 0)          # the close moved to A; the B bet lost value
        self.assertEqual(len(H.bet_table(self.frame(model_prob=0.51), cfg, 0.02)), 0)

    def test_invalid_prices_are_not_bets(self):
        cfg = H.HarnessConfig(kind="price", market="moneyline", thresholds=(0.02,), n_boot=50)
        self.assertEqual(len(H.bet_table(self.frame(close_a=50), cfg, 0.02)), 0)

    def test_result_grading(self):
        cfg = H.HarnessConfig(kind="price", market="moneyline", thresholds=(0.02,), n_boot=50)
        d = pd.concat([self.frame(result=1.0), self.frame(result=0.0, game_id=1)])
        s = H.summarize(H.bet_table(d, cfg, 0.02), cfg)
        self.assertEqual((s["results"]["wins"], s["results"]["losses"]), (1, 1))


class TestBootstrapAndVerdict(unittest.TestCase):
    def test_cluster_bootstrap_is_wider_with_shared_news(self):
        rng = np.random.default_rng(5)
        k, per = 60, 20
        shock = np.repeat(rng.normal(0, 1, k), per)
        v = shock + rng.normal(0, 0.1, k * per)
        codes = np.repeat(np.arange(k), per)
        se_cluster = H.cluster_boot(v, codes, 2000, 1).std()
        se_iid = H.cluster_boot(v, np.arange(k * per), 2000, 1).std()
        self.assertGreater(se_cluster, 3 * se_iid)
        self.assertAlmostEqual(se_cluster, shock[::per].std(ddof=1) / math.sqrt(k), delta=0.04)

    def test_holm(self):
        self.assertTrue(np.allclose(H.holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]))

    def test_verdict_counts_the_family(self):
        rng = np.random.default_rng(9)
        n = 400
        o = np.zeros(n)
        c = rng.choice([1.0, -1.0], n, p=[0.8, 0.2])
        strong = H.evaluate(points_frame(o, c, np.ones(n)), H.HarnessConfig(kind="points", thresholds=(0.5,), n_boot=2000),
                            k_tests=20)
        self.assertTrue(H.verdict(strong["primary"], 20)["pass"])
        c0 = rng.choice([1.0, -1.0], n)
        null = H.evaluate(points_frame(o, c0, np.ones(n)), H.HarnessConfig(kind="points", thresholds=(0.5,), n_boot=2000),
                          k_tests=20)
        self.assertFalse(H.verdict(null["primary"], 20)["pass"])
        self.assertFalse(H.verdict({"n_bets": 10, "clv_prob": {"mean": 0.1, "ci95": [0.05, 0.2]}}, 1)["pass"])

    def test_movement_calibration_slope(self):
        rng = np.random.default_rng(2)
        p = rng.normal(0, 1, 5000)
        a = 0.5 * p + rng.normal(0, 0.5, 5000)
        self.assertAlmostEqual(H.movement_calibration(p, a)["slope"], 0.5, delta=0.03)


class TestResidualWalkForward(unittest.TestCase):
    def test_no_season_sees_itself(self):
        rng = np.random.default_rng(4)
        rows = []
        for s in range(2010, 2018):
            x = rng.normal(0, 1, 300)
            rows.append(pd.DataFrame({"season": s, "x": x, "y": 0.4 * x + rng.normal(0, 0.2, 300)}))
        d = pd.concat(rows, ignore_index=True)
        pred, log = R.walk_forward(d, ["x"], "y", range(2010, 2018), min_train_seasons=3)
        self.assertTrue(pred[d.season < 2013].isna().all())
        self.assertTrue(pred[d.season >= 2013].notna().all())
        # changing a season's targets cannot change that season's predictions
        d2 = d.copy()
        d2.loc[d2.season == 2016, "y"] = 100.0
        pred2, _ = R.walk_forward(d2, ["x"], "y", range(2010, 2018), min_train_seasons=3)
        same = d.season <= 2016
        self.assertTrue(np.allclose(pred[same], pred2[same], equal_nan=True))
        self.assertFalse(np.allclose(pred[d.season == 2017], pred2[d.season == 2017]))
        self.assertAlmostEqual(log[-1]["coef"]["x"], 0.4, delta=0.05)

    def test_ridge_shrinks_to_no_move(self):
        rng = np.random.default_rng(8)
        x = rng.normal(0, 1, (200, 2))
        y = 0.3 * x[:, 0] + rng.normal(0, 1, 200)
        big = R.ridge_fit(x, y, 1e6)
        self.assertTrue(np.all(np.abs(big["coef_raw"]) < 1e-3))


if __name__ == "__main__":
    unittest.main()
