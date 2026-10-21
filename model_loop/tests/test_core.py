"""Core guarantees, checked without any downloaded data:

  - the penalized fit's prior/data split adds back to the fit exactly, and the
    prior's share falls as evidence accumulates;
  - the key-number distribution's mean IS the projection, its range is centred
    on it, and win / cover probabilities come from one table;
  - calibration and metrics behave on known inputs;
  - an NFL card's components sum exactly to its fair line.

Run: python3 -m unittest discover -s model_loop/tests -v
"""
import math
import unittest

import numpy as np

from model_loop.core.ratings import penalized_wls, recency_weights, ridge
from model_loop.core.distribution import KeyNumberMargin, american_from_prob, prob_from_american, no_vig_two_way
from model_loop.core.calibration import Platt, Isotonic
from model_loop.core import metrics as M
from model_loop.core import walkforward as WF


class TestPenalizedFit(unittest.TestCase):
    def test_prior_plus_data_is_exact(self):
        rng = np.random.default_rng(1)
        n_obs, n_par = 60, 8
        rows = np.repeat(np.arange(n_obs), 2)
        cols = np.concatenate([[rng.integers(0, 4), 4 + rng.integers(0, 4)] for _ in range(n_obs)])
        vals = np.ones(len(rows))
        y = rng.normal(0, 1, n_obs)
        w = rng.uniform(5, 50, n_obs)
        m = rng.normal(0, 0.3, n_par)
        lam = np.full(n_par, 100.0)
        theta, fp, fd, _ = penalized_wls(rows, cols, vals, y, w, n_par, m, lam)
        self.assertTrue(np.allclose(theta, fp + fd, atol=1e-12))

    def test_prior_share_shrinks_with_evidence(self):
        shares = []
        for n in (0, 1, 4, 16):
            y = np.full(n, 1.0)
            theta, fp, fd, _ = penalized_wls(np.arange(n), np.zeros(n, int), np.ones(n), y, np.full(n, 50.0), 1,
                                             np.array([0.5]), np.array([100.0]))
            shares.append(fp[0] / theta[0])
        self.assertAlmostEqual(shares[0], 1.0)
        self.assertTrue(all(a > b for a, b in zip(shares, shares[1:])))

    def test_sparse_normal_equations_match_dense(self):
        rng = np.random.default_rng(2)
        n_obs, n_par = 80, 15
        rows = np.r_[np.repeat(np.arange(n_obs), 3), [0]]          # one repeated (row, col) entry
        cols = np.r_[rng.integers(0, n_par, 3 * n_obs), [0]]
        cols[-1] = cols[0]
        vals = rng.normal(size=len(rows))
        y, w = rng.normal(size=n_obs), rng.uniform(1, 9, n_obs)
        m, lam = rng.normal(size=n_par), rng.uniform(1, 30, n_par)
        X = np.zeros((n_obs, n_par))
        np.add.at(X, (rows, cols), vals)
        A = (X * w[:, None]).T @ X + np.diag(lam)
        dense = np.linalg.solve(A, lam * m + (X * w[:, None]).T @ y)
        theta, fp, fd, _ = penalized_wls(rows, cols, vals, y, w, n_par, m, lam)
        self.assertTrue(np.allclose(theta, dense, atol=1e-10))

    def test_recency(self):
        self.assertTrue(np.allclose(recency_weights([0, 6, 12], 6.0), [1, 0.5, 0.25]))
        self.assertTrue(np.allclose(recency_weights([0, 6], None), [1, 1]))

    def test_ridge_prior_pull(self):
        X = np.column_stack([np.ones(50), np.linspace(-1, 1, 50)])
        y = 3.0 + 2.0 * X[:, 1]
        b_free = ridge(X, y, None, 0.0, unpenalized=(0,))
        b_pull = ridge(X, y, None, 0.0, unpenalized=(0,), prior_mean={0: 1.0}, prior_lam={0: 1e6})
        self.assertAlmostEqual(b_free[0], 3.0, places=6)
        self.assertAlmostEqual(b_pull[0], 1.0, places=3)


class TestDistribution(unittest.TestCase):
    def setUp(self):
        mult = np.ones(31)
        mult[3], mult[7], mult[10] = 2.2, 1.6, 1.3
        self.d = KeyNumberMargin(sigma=13.5, mult=mult)

    def test_mean_is_projection(self):
        for mu in (-14.2, -6.72, -2.5, 0.0, 2.9, 6.72, 13.3):
            p = self.d.pmf(mu)[0]
            self.assertAlmostEqual(float((p * self.d.k).sum()), mu, places=6)

    def test_mean_is_projection_near_the_support_edge(self):
        d = KeyNumberMargin(sigma=17.0)
        for mu in (-52.0, 47.5, 58.0):
            p = d.pmf(mu)[0]
            self.assertAlmostEqual(float((p * d.k).sum()), mu, places=6)

    def test_range_is_centred_and_holds_its_mass(self):
        for mu in (-6.72, 0.4, 6.72, 11.8):
            h = self.d.central_halfwidth(mu, 0.8)[0]
            row = self.d.pmf(mu)[0]
            a, b = mu - h, mu + h
            cov = np.clip(np.minimum(self.d.k + 0.5, b) - np.maximum(self.d.k - 0.5, a), 0, 1)
            self.assertGreaterEqual((row * cov).sum(), 0.8 - 1e-9)
            self.assertLess(h, 30)

    def test_one_table_for_win_and_cover(self):
        mu = 6.72
        w, t, l = self.d.win_tie_loss(mu)
        c_win, c_push, c_lose = self.d.cover(mu, 0.0)
        self.assertAlmostEqual(w[0], c_win[0], places=12)
        self.assertAlmostEqual(t[0], c_push[0], places=12)
        self.assertAlmostEqual(w[0] + t[0] + l[0], 1.0, places=12)

    def test_key_numbers_carry_mass(self):
        p = self.d.pmf(3.0)[0]
        k = self.d.k
        self.assertGreater(p[k == 3][0], p[k == 4][0])
        self.assertGreater(p[k == 3][0], p[k == 2][0])

    def test_fit_recovers_sigma(self):
        rng = np.random.default_rng(3)
        mu = rng.normal(0, 6, 4000)
        res = np.round(mu + rng.normal(0, 13.0, 4000))
        d = KeyNumberMargin.fit(mu, res, sigmas=np.arange(11.0, 15.01, 0.5))
        self.assertTrue(12.0 <= d.sigma <= 14.0)

    def test_odds_round_trip(self):
        for p in (0.25, 0.5, 0.735, 0.9):
            self.assertAlmostEqual(prob_from_american(american_from_prob(p)), p, places=2)
        self.assertAlmostEqual(no_vig_two_way(-110, -110), 0.5)


class TestCalibrationAndMetrics(unittest.TestCase):
    def test_platt_fixes_overconfidence(self):
        rng = np.random.default_rng(5)
        true = rng.uniform(0.2, 0.8, 5000)
        y = (rng.uniform(size=5000) < true).astype(float)
        stretched = 1 / (1 + np.exp(-2.0 * np.log(true / (1 - true))))
        cal = Platt.fit(stretched, y, prior=0.0)
        self.assertLess(M.logloss(cal(stretched), y), M.logloss(stretched, y))
        self.assertTrue(0.4 < cal.b < 0.6)

    def test_isotonic_is_monotone(self):
        rng = np.random.default_rng(6)
        p = rng.uniform(size=500)
        y = (rng.uniform(size=500) < p).astype(float)
        iso = Isotonic.fit(p, y)
        grid = np.linspace(0, 1, 50)
        self.assertTrue(np.all(np.diff(iso(grid)) >= -1e-12))

    def test_ats_and_clv(self):
        pred = np.array([7.0, -3.0, 1.0])
        close = np.array([3.0, 0.0, 0.5])
        res = np.array([10.0, -7.0, 0.0])
        a = M.ats_vs_close(pred, close, res, thresholds=(1,))
        self.assertEqual(a["1"]["wins"], 2)
        c = M.clv_points(np.array([5.0, -2.0]), np.array([3.0, 0.0]), np.array([4.0, 1.0]))
        self.assertEqual(c["positive"], 1)
        self.assertEqual(c["negative"], 1)

    def test_promotion_rule_needs_everything(self):
        cand = {"margin_mae": 10.0, "logloss": 0.62}
        cur = {"margin_mae": 10.1, "logloss": 0.63}
        self.assertTrue(WF.promotion_decision(cand, cur, cand, cur)["promote"])
        worse_hold = {"margin_mae": 10.2, "logloss": 0.62}
        self.assertFalse(WF.promotion_decision(cand, cur, worse_hold, cur)["promote"])
        self.assertFalse(WF.promotion_decision(cand, cur, cand, cur, min_gain_mae=0.2)["promote"])


class TestNflCardReconciles(unittest.TestCase):
    def test_components_sum_to_fair_line(self):
        import pandas as pd
        from model_loop.adapters.nfl import model as NM
        rng = np.random.default_rng(9)
        n = 600
        rows = pd.DataFrame({
            "season": np.repeat([2018, 2019, 2020], n // 3), "neutral": (rng.uniform(size=n) < 0.03).astype(int),
            "div_game": (rng.uniform(size=n) < 0.35).astype(int), "home_rest": rng.choice([4, 7, 7, 7, 14], n),
            "away_rest": rng.choice([4, 7, 7, 7, 14], n), "x_pass_off": rng.normal(0, 0.05, n), "x_pass_def": rng.normal(0, 0.04, n),
            "x_qb": rng.normal(0, 0.08, n), "x_rush_off": rng.normal(0, 0.03, n), "x_rush_def": rng.normal(0, 0.02, n),
            "x_market": rng.normal(0, 4, n), "away_miles": rng.uniform(0, 2500, n), "home_miles": np.zeros(n),
            "away_tz": rng.choice([0, 1, 2, 3], n).astype(float), "home_tz": np.zeros(n),
            "away_body": rng.integers(0, 2, n), "home_body": np.zeros(n, int),
            "t_pass_sum": rng.normal(0.05, 0.05, n), "t_rush_sum": rng.normal(-0.1, 0.03, n), "t_market": rng.normal(44, 3, n),
            "roof": "outdoors", "wind": 5.0, "temp": 60.0,
            "p_pass_off": 0.0, "p_pass_def": 0.0, "p_qb": 0.0, "p_rush_off": 0.0, "p_rush_def": 0.0, "p_market": 0.0})
        rows["result"] = 2 * (1 - rows.neutral) + 0.9 * rows.x_market + 20 * rows.x_qb + rng.normal(0, 13, n)
        rows["total_pts"] = 44 + rng.normal(0, 13, n)
        pred, info = NM.walk_forward(rows, {"first_train": 2018, "min_train_seasons": 2})
        te = pred[pred.season == 2020]
        self.assertTrue(len(te) > 0)
        csum = te[[c for c in te.columns if c.startswith("c_")]].sum(axis=1)
        self.assertTrue(np.allclose(csum.values, te.pred_margin.values, atol=1e-9))
        d = KeyNumberMargin(sigma=13.5)
        card = NM.card(te.iloc[0], info["margin"][2020], d, info["names"])
        self.assertAlmostEqual(card["unattributed"], 0.0, places=9)
        self.assertAlmostEqual(card["range80"]["centre"], card["fair_home_margin"])
        self.assertAlmostEqual(card["range80"]["hi"] - card["fair_home_margin"], card["fair_home_margin"] - card["range80"]["lo"])


if __name__ == "__main__":
    unittest.main()
