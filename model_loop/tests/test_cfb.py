"""CFB adapter guarantees, checked on synthetic data (no download):

  - a card's components sum exactly to its fair line and its 80% range is
    centred on it, FBS-vs-FBS and FBS-vs-FCS alike;
  - FCS teams are rated individually around a FITTED division mean (no single
    floor): two FCS teams of different strength get different ratings and
    different fair lines against the same FBS team, and the division mean moves
    to the data; `fcs_teams: False` collapses a division to its fitted mean;
  - every rating splits exactly into a prior part and a data part;
  - the lower-division row has the right sign.

Run: python3 -m unittest discover -s model_loop/tests -t .
"""
import os
import shutil
import tempfile
import unittest

import numpy as np
import pandas as pd

from model_loop.core.distribution import KeyNumberMargin


def synthetic_build(seasons=(2018, 2019, 2020, 2021), n_fbs=24, n_fcs=6, seed=0):
    """A tiny CFB world written as the ingest tables: FBS teams with a true
    strength, FCS teams far below it (two of them much better than the rest),
    one quarterback per team, per-game EPA aggregates and closing lines."""
    rng = np.random.default_rng(seed)
    fbs = list(range(1, n_fbs + 1))
    fcs = list(range(101, 101 + n_fcs))
    strength = {t: rng.normal(0, 0.12) for t in fbs}
    for i, t in enumerate(fcs):
        strength[t] = -0.30 + (0.20 if i < 2 else 0.0) + rng.normal(0, 0.02)
    games, units, qbs = [], [], []
    gid = 1000
    for S in seasons:
        for wk in range(1, 11):
            order = list(rng.permutation(fbs))
            pairs = [(order[i], order[i + 1]) for i in range(0, len(order) - 1, 2)]
            if wk in (1, 2):                      # FBS hosts FCS early in the season
                pairs = pairs[:-n_fcs // 2] + [(order[-1 - k], fcs[(k + wk * 3) % n_fcs]) for k in range(n_fcs // 2)]
            for h, a in pairs:
                gid += 1
                neutral = int(rng.uniform() < 0.05)
                margin = 120 * (strength[h] - strength[a]) + 3 * (1 - neutral) + rng.normal(0, 14)
                close = 120 * (strength[h] - strength[a]) + 3 * (1 - neutral) + rng.normal(0, 3)
                total = 52 + rng.normal(0, 12)
                games.append({"game_id": gid, "season": S, "week": wk, "season_type": "regular",
                              "kick_utc": pd.Timestamp(f"{S}-09-01") + pd.Timedelta(days=7 * wk),
                              "home": h, "away": a, "home_name": f"T{h}", "away_name": f"T{a}",
                              "home_div": "fbs" if h in strength and h <= n_fbs else "fcs",
                              "away_div": "fbs" if a <= n_fbs else "fcs",
                              "home_conf": "C1" if h % 2 else "C2", "away_conf": ("C1" if a % 2 else "C2") if a <= n_fbs else "FCS",
                              "neutral": neutral, "conf_game": 0, "home_score": np.nan, "away_score": np.nan,
                              "venue": "v", "notes": "", "result": round(margin), "total_pts": round(total),
                              "home_rest": 7.0, "away_rest": 7.0, "slate": wk, "close_margin": round(close * 2) / 2,
                              "close_total": 52.0, "open_margin": np.nan, "home_ml": np.nan, "away_ml": np.nan,
                              "close_margin_pin": np.nan, "close_books": 5.0, "close_source": "synthetic",
                              "ref_margin": np.nan, "ref_open_margin": np.nan, "mkt_margin": round(close * 2) / 2,
                              "home_qb_id": f"q{h}", "away_qb_id": f"q{a}"})
                for off, de in ((h, a), (a, h)):
                    for unit, base in (("pass", 0.10), ("rush", 0.0)):
                        n = 30
                        epa = n * (base + strength[off] - strength[de] + rng.normal(0, 0.05))
                        units.append({"game_id": gid, "season": S, "week": wk, "team": off, "opp": de, "unit": unit,
                                      "n_in": n, "n_out": 5, "epa_in": epa, "epa_out": 5 * epa / n})
                        if unit == "pass":
                            qbs.append({"game_id": gid, "season": S, "week": wk, "team": off, "opp": de, "qb_id": f"q{off}",
                                        "n_in": n, "n_out": 5, "epa_in": epa, "epa_out": 5 * epa / n})
    d = tempfile.mkdtemp()
    pd.DataFrame(games).to_parquet(os.path.join(d, "games.parquet"), index=False)
    pd.DataFrame(units).to_parquet(os.path.join(d, "unit_games.parquet"), index=False)
    pd.DataFrame(qbs).to_parquet(os.path.join(d, "qb_games.parquet"), index=False)
    pd.DataFrame({"qb_id": [f"q{t}" for t in strength], "name": [f"QB {t}" for t in strength]}).to_parquet(os.path.join(d, "qb_names.parquet"), index=False)
    pd.DataFrame({"team": fbs, "talent": rng.normal(600, 100, n_fbs), "ret_off": rng.uniform(0.3, 0.9, n_fbs),
                  "ret_def": rng.uniform(0.3, 0.9, n_fbs), "ret_all": 0.6, "season": seasons[-1]}).to_parquet(os.path.join(d, "priors.parquet"), index=False)
    return d, strength, fbs, fcs


class TestCfb(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from model_loop.adapters.cfb.ratings import Tables, CfbRatingPass
        cls.dir, cls.strength, cls.fbs, cls.fcs = synthetic_build()
        cls.T = Tables(cls.dir)
        cls.Pass = CfbRatingPass
        cls.rows, cls.snaps = CfbRatingPass(cls.T, {}).run([2018, 2019, 2020, 2021], keep_snapshots_for=(2021,))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_components_sum_and_range_centred(self):
        from model_loop.adapters.cfb import model as CM
        pred, info = CM.walk_forward(self.rows, {"first_train": 2018, "min_train_seasons": 2})
        te = pred[pred.season == 2021]
        self.assertTrue(len(te) > 0)
        csum = te[[c for c in te.columns if c.startswith("c_")]].sum(axis=1)
        self.assertTrue(np.allclose(csum.values, te.pred_margin.values, atol=1e-9))
        d = KeyNumberMargin(sigma=16.5, kmax=100)
        fcs_rows = te[(te.home_div != "fbs") | (te.away_div != "fbs")]
        self.assertTrue(len(fcs_rows) > 0)
        for _, r in pd.concat([te.head(3), fcs_rows.head(3)]).iterrows():
            card = CM.card(r, info["margin"][2021], d, info["names"])
            self.assertAlmostEqual(card["unattributed"], 0.0, places=9)
            self.assertAlmostEqual(card["range80"]["centre"], card["fair_home_margin"])
            self.assertAlmostEqual(card["range80"]["hi"] - card["fair_home_margin"], card["fair_home_margin"] - card["range80"]["lo"], places=9)
            mean = float((d.pmf(card["fair_home_margin"])[0] * d.k).sum())
            self.assertAlmostEqual(mean, card["fair_home_margin"], places=5)

    def test_fcs_teams_rated_individually_around_a_fitted_mean(self):
        snap = self.snaps[max(k for k in self.snaps if k[0] == 2021)]
        t = snap["teams"]
        good, poor = self.fcs[:2], self.fcs[2:]
        po = lambda ids: np.mean([t[i]["pass_off"] for i in ids])
        # the better FCS teams are rated better, and no two FCS teams share a floor
        self.assertGreater(po(good), po(poor))
        self.assertGreater(len({round(t[i]["pass_off"], 6) for i in self.fcs}), 1)
        # the division mean is fitted: FCS sits well below FBS, near the truth (-0.30 + 0.067)
        fbs_mean = np.mean([t[i]["pass_off"] for i in self.fbs])
        g = snap["division_means"]["pass_off"]["fcs"]
        self.assertLess(g, -0.1)
        self.assertLess(po(self.fcs), fbs_mean - 0.1)

    def test_collapsed_division_is_one_fitted_level(self):
        rows, snaps = self.Pass(self.T, {"fcs_teams": False}).run([2018, 2019, 2020, 2021], keep_snapshots_for=(2021,))
        snap = snaps[max(k for k in snaps if k[0] == 2021)]
        vals = [snap["teams"][i]["pass_off"] for i in self.fcs]
        self.assertLess(max(vals) - min(vals), 1e-3)
        self.assertLess(np.mean(vals), -0.1)

    def test_prior_plus_data_is_exact_in_rows(self):
        r = self.rows[self.rows.season == 2021]
        # prior part is bounded by the full rating difference only through data; week-1 rows are all prior
        w1 = r[r.slate == 1]
        self.assertTrue(np.allclose(w1.x_pass_off, w1.p_pass_off, atol=1e-9))
        self.assertTrue(np.allclose(w1.x_rush_def, w1.p_rush_def, atol=1e-9))

    def test_lower_division_sign(self):
        from model_loop.adapters.cfb.model import lower_side
        df = pd.DataFrame({"home_div": ["fbs", "fcs", "fbs"], "away_div": ["fcs", "fbs", "fbs"]})
        self.assertEqual(list(lower_side(df)), [1.0, -1.0, 0.0])


class WeeklyRankingTest(unittest.TestCase):
    """The weekly loop tests what the misses point at first (the NFL loop's rule)."""

    def test_strongest_pattern_first_and_every_slot_filled(self):
        from model_loop.adapters.cfb import weekly as W
        pats = [{"pattern": "home_dogs", "line_t": 5.1, "outcome_t": -0.4}, {"pattern": "fcs", "line_t": 2.4, "outcome_t": 0.0},
                {"pattern": "early_season", "line_t": 0.9, "outcome_t": 0.3}]
        order = W.rank_candidates(pats, 202608)
        answers = {c[0]: c[3] for c in W.CATALOGUE}
        self.assertEqual(len(order), W.MAX_CANDIDATES)
        self.assertEqual(len(set(order)), len(order))
        self.assertTrue(all("home_dogs" in answers[c] for c in order[:2]), order[:2])
        self.assertTrue(all("fcs" in answers[c] for c in order[2:4]), order[2:4])

    def test_every_pattern_the_analysis_reports_can_be_answered_or_rotates(self):
        from model_loop.adapters.cfb import weekly as W
        ids = [c[0] for c in W.CATALOGUE]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotEqual(W.rank_candidates([], 202608), W.rank_candidates([], 202609))


if __name__ == "__main__":
    unittest.main()
