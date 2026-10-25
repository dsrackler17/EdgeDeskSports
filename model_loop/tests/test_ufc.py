"""The UFC adapter: the parser reproduces the data pack, the Elo is causal and
symmetric (the 2026-10 parameters too, and off they change nothing), the
point-in-time facts, the market's no-vig price and the disagreement guard
behave as documented, and the preregistered pipeline (backtest -> serve
decision -> refresh -> score -> research) runs end to end on a synthetic
history."""
import csv
import glob
import gzip
import json
import os
import shutil
import tempfile
import unittest

import numpy as np
import pandas as pd

from model_loop.adapters.ufc import factors as FX
from model_loop.adapters.ufc import guard as GD
from model_loop.adapters.ufc import ingest as I
from model_loop.adapters.ufc import loop as L
from model_loop.adapters.ufc import market as K
from model_loop.adapters.ufc import model as U

PACK = os.path.join(I.ROOT, "datapack", "quant_v1", "data", "ufc")


class ParserTest(unittest.TestCase):
    def test_reproduces_the_data_pack_2024_bouts(self):
        rows = {}
        for p in sorted(glob.glob(os.path.join(PACK, "raw", "scoreboard_2024*.json.gz"))):
            for r in I.parse(json.load(gzip.open(p))):
                rows[r["bout_id"]] = r
        pack = list(csv.DictReader(open(os.path.join(PACK, "bouts_2024.csv"))))
        self.assertEqual(len(rows), len(pack))
        keys = ["event_id", "event_name", "start_time", "fighter_a_id", "fighter_a", "fighter_b_id", "fighter_b",
                "a_winner", "b_winner", "status", "status_detail", "round", "clock", "format_json"]
        bad = [(x["bout_id"], k) for x in pack for k in keys if str(rows[x["bout_id"]][k]) != x[k]]
        self.assertEqual(bad, [])


def synthetic(path, seasons=range(2014, 2027), per_season=420, seed=5):
    """A history with real skill: fighters have a latent strength, results follow it."""
    rng = np.random.default_rng(seed)
    skill = rng.normal(0, 1.0, 600)
    rows, bid = [], 0
    for s in seasons:
        for i in range(per_season):
            a, b = rng.choice(600, 2, replace=False)
            ts = pd.Timestamp(f"{s}-01-01", tz="UTC") + pd.Timedelta(days=int(i * 360 / per_season))
            sched = s == 2026 and i >= per_season - 10
            pa = 1 / (1 + np.exp(-(skill[a] - skill[b])))
            aw = rng.uniform() < pa
            bid += 1
            rows.append({"bout_id": str(bid), "event_id": f"e{s}{i // 10}", "event_name": f"Card {s}-{i // 10}",
                         "start_time": ts.strftime("%Y-%m-%dT%H:%MZ"), "fighter_a_id": str(a), "fighter_a": f"F{a}",
                         "fighter_b_id": str(b), "fighter_b": f"F{b}", "a_winner": "" if sched else str(bool(aw)),
                         "b_winner": "" if sched else str(not aw), "status": "STATUS_SCHEDULED" if sched else "STATUS_FINAL",
                         "status_detail": "", "round": "", "clock": "", "format_json": "{}", "weight_class": "Lightweight"})
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=I.FIELDS)
        w.writeheader()
        w.writerows(rows)


class EloTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        synthetic(os.path.join(self.d, "bouts.csv"), seasons=range(2016, 2019), per_season=300)
        self.bouts = U.load(os.path.join(self.d, "bouts.csv"))

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_causal_a_later_result_never_moves_an_earlier_price(self):
        r1, _ = U.walk(self.bouts, {"k": 32})
        flipped = self.bouts.copy()
        flipped.loc[flipped.index[-50:], "y"] = 1 - flipped.loc[flipped.index[-50:], "y"]
        r2, _ = U.walk(flipped, {"k": 32})
        self.assertTrue(np.allclose(r1.p_raw.values[:-50], r2.p_raw.values[:-50]))

    def test_symmetric_in_the_feed_order(self):
        sw = self.bouts.copy()
        sw[["fighter_a_id", "fighter_b_id"]] = self.bouts[["fighter_b_id", "fighter_a_id"]].values
        sw["y"] = 1 - self.bouts.y
        r1, _ = U.walk(self.bouts, {"k": 32, "k_new_mult": 2.0, "layoff_regress": 0.25})
        r2, _ = U.walk(sw, {"k": 32, "k_new_mult": 2.0, "layoff_regress": 0.25})
        self.assertTrue(np.allclose(r1.p_raw.values, 1 - r2.p_raw.values))

    def test_champion_term_is_off_at_zero_and_follows_the_champion(self):
        flagged = self.bouts.copy()
        flagged["champ"] = ""
        flagged.loc[flagged.index[::7], "champ"] = flagged.fighter_a_id[::7]
        flagged.loc[flagged.index[3::7], "champ"] = flagged.fighter_b_id[3::7]
        base, _ = U.walk(self.bouts, {"k": 32})
        off, _ = U.walk(flagged, {"k": 32, "champ_bonus": 0.0})
        self.assertTrue(np.array_equal(base.p_raw.values, off.p_raw.values))
        on, _ = U.walk(flagged, {"k": 32, "champ_bonus": 100.0})
        self.assertFalse(np.allclose(base.p_raw.values, on.p_raw.values))
        sw = flagged.copy()
        sw[["fighter_a_id", "fighter_b_id"]] = flagged[["fighter_b_id", "fighter_a_id"]].values
        sw["y"] = 1 - flagged.y
        on_sw, _ = U.walk(sw, {"k": 32, "champ_bonus": 100.0})
        self.assertTrue(np.allclose(on.p_raw.values, 1 - on_sw.p_raw.values))
        first = on.iloc[0]
        self.assertAlmostEqual(first.p_raw, 1.0 / (1.0 + 10 ** (-100.0 / 400.0)))

    def test_title_flags_are_read_beside_the_bouts(self):
        b = self.bouts.iloc[0]
        with open(os.path.join(self.d, "title_bouts.csv"), "w") as f:
            f.write("bout_id,champion_id,champion,division,date,source\n%s,%s,x,Lightweight,2016-01-01,wikipedia\n" % (b.bout_id, b.fighter_b_id))
        d = U.load(os.path.join(self.d, "bouts.csv"))
        self.assertEqual(d.champ.iloc[0], b.fighter_b_id)
        self.assertEqual((d.champ != "").sum(), 1)

    def test_slope_calibration_is_symmetric_and_fitted_only_on_earlier_seasons(self):
        r, _ = U.walk(self.bouts, {"k": 32})
        c, fits = U.calibrate(r, {"calibration": "slope"}, 2016)
        self.assertNotIn(2016, fits)                       # no earlier season to fit on
        z = c[c.season == 2018]
        self.assertTrue(np.allclose(z.p.values - 0.5, -(1 - z.p.values - 0.5)))


EXT = {"k": 64, "k_new_mult": 1.5, "layoff_regress": 0.25, "debut_offset": 25.0, "prior_rec": 150, "prior_exp": -25, "age_slope": -15,
       "age_knee": 32, "shrink_bouts": 2, "half_life_days": 1460, "div_regress": 0.25, "div_up": -40, "div_down": 20, "h2h": 100, "h2h_decay": 0.5}


class ExtendedTest(unittest.TestCase):
    """the 2026-10 parameters: off, the walk is 1.1.0's to the last digit; on, it stays causal and symmetric"""
    def setUp(self):
        self.d = tempfile.mkdtemp()
        synthetic(os.path.join(self.d, "bouts.csv"), seasons=range(2016, 2019), per_season=300)
        self.bouts = U.load(os.path.join(self.d, "bouts.csv"))
        self.bouts.loc[self.bouts.index[::5], "weight_class"] = "Welterweight"
        rng = np.random.default_rng(9)
        ids = sorted(set(self.bouts.fighter_a_id) | set(self.bouts.fighter_b_id))
        self.facts = {f: (pd.Timestamp("1985-01-01", tz="UTC") + pd.Timedelta(days=int(rng.integers(0, 4000))),
                          float(rng.integers(0, 20)), float(rng.integers(0, 6))) for f in ids}
        self.fx = FX.compute(self.bouts, facts=self.facts)

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_off_the_extended_walk_is_the_served_walk(self):
        cfg = {"k": 64, "k_new_mult": 1.5, "layoff_regress": 0.25}
        r0, _ = U.walk(self.bouts, cfg)
        r1, _ = U._walk_extended(self.bouts, dict(U.DEFAULTS, **cfg), self.fx)
        self.assertTrue(np.array_equal(r0.p_raw.values, r1.p_raw.values))
        self.assertFalse(U.extended(dict(U.DEFAULTS, **cfg)))
        self.assertTrue(U.extended(dict(U.DEFAULTS, **cfg, age_slope=-15)))

    def test_on_causal_and_symmetric(self):
        r1, _ = U.walk(self.bouts, EXT, fx=self.fx)
        flipped = self.bouts.copy()
        flipped.loc[flipped.index[-50:], "y"] = 1 - flipped.loc[flipped.index[-50:], "y"]
        r2, _ = U.walk(flipped, EXT, fx=FX.compute(flipped, facts=self.facts))
        self.assertTrue(np.allclose(r1.p_raw.values[:-50], r2.p_raw.values[:-50]))
        sw = self.bouts.copy()
        sw[["fighter_a_id", "fighter_b_id"]] = self.bouts[["fighter_b_id", "fighter_a_id"]].values
        sw["y"] = 1 - self.bouts.y
        r3, _ = U.walk(sw, EXT, fx=FX.compute(sw, facts=self.facts))
        self.assertTrue(np.allclose(r1.p_raw.values, 1 - r3.p_raw.values))
        self.assertFalse(np.allclose(r1.p_raw.values, U.walk(self.bouts, {"k": 64, "k_new_mult": 1.5, "layoff_regress": 0.25})[0].p_raw.values))

    def test_the_prior_and_the_age_curve(self):
        P = dict(U.DEFAULTS, debut_offset=25.0, prior_rec=150, prior_exp=-25)
        self.assertAlmostEqual(U.prior_of(P, 10, 2), 1525.0)                    # the centre: a 10-2 record
        self.assertAlmostEqual(U.prior_of(P, None, None), 1525.0)               # no record on file: the centre
        self.assertGreater(U.prior_of(P, 15, 0), U.prior_of(P, 10, 2))
        A = dict(U.DEFAULTS, age_slope=-15, age_knee=32)
        self.assertEqual(U.age_points(A, 30.0), 0.0)
        self.assertAlmostEqual(U.age_points(A, 38.0), -90.0)
        self.assertEqual(U.age_points(A, float("nan")), 0.0)
        first = self.bouts.iloc[0]
        r, st = U.walk(self.bouts.iloc[:1].reset_index(drop=True), EXT, fx=self.fx.iloc[:1].reset_index(drop=True))
        self.assertIn(first.fighter_a_id, st["priors"])

    def test_the_age_curve_by_division_and_the_elite_term(self):
        A = dict(U.DEFAULTS, age_slope=-15, age_knee=32, age_div={"Heavyweight": [31, -20]}, age_elite_slope=-10)
        self.assertAlmostEqual(U.age_points(A, 38.0, "Heavyweight"), -140.0)    # its own knee and slope: -20 * 7
        self.assertAlmostEqual(U.age_points(A, 38.0, "Lightweight"), -90.0)     # a division without one: the shared curve
        self.assertAlmostEqual(U.age_points(A, 38.0), -90.0)
        self.assertAlmostEqual(U.age_points(A, 38.0, "Heavyweight", True), -210.0)  # elite: -10 more a year past the knee
        self.assertTrue(U.elite_record(A, 6, 2) and not U.elite_record(A, 5, 0) and not U.elite_record(A, 6, 3))
        self.assertFalse(U.elite_record(A, None, None))
        self.assertTrue(U.extended(dict(U.DEFAULTS, age_div={"Heavyweight": [31, -15]})))
        # the shared curve written out per division prices exactly as the shared curve
        same = {k: [32, -15] for k in ("Lightweight", "Welterweight")}
        r0, _ = U.walk(self.bouts, EXT, fx=self.fx)
        r1, _ = U.walk(self.bouts, dict(EXT, age_div=same), fx=self.fx)
        self.assertTrue(np.array_equal(r0.p_raw.values, r1.p_raw.values))
        # on: causal and symmetric, and it moves the welterweight bouts only
        on = dict(EXT, age_div={"Welterweight": [28, -30]}, age_elite_slope=-15)
        r2, _ = U.walk(self.bouts, on, fx=self.fx)
        self.assertFalse(np.allclose(r0.p_raw.values, r2.p_raw.values))
        first_wel = int(np.argmax((self.bouts.weight_class == "Welterweight").values))
        self.assertTrue(np.allclose(r0.p_raw.values[:first_wel], r2.p_raw.values[:first_wel]))
        sw = self.bouts.copy()
        sw[["fighter_a_id", "fighter_b_id"]] = self.bouts[["fighter_b_id", "fighter_a_id"]].values
        sw["y"] = 1 - self.bouts.y
        r3, _ = U.walk(sw, on, fx=FX.compute(sw, facts=self.facts))
        self.assertTrue(np.allclose(r2.p_raw.values, 1 - r3.p_raw.values))
        flipped = self.bouts.copy()
        flipped.loc[flipped.index[-50:], "y"] = 1 - flipped.loc[flipped.index[-50:], "y"]
        r4, _ = U.walk(flipped, on, fx=FX.compute(flipped, facts=self.facts))
        self.assertTrue(np.allclose(r2.p_raw.values[:-50], r4.p_raw.values[:-50]))

    def test_factors(self):
        fx = self.fx
        self.assertTrue((fx.n_a.iloc[:1] == 0).all())
        moved = fx.div_step_a.dropna()
        self.assertTrue(set(moved.unique()) <= {-1.0, 0.0, 1.0})              # Lightweight <-> Welterweight
        self.assertTrue((fx.meet >= 0).all() and fx.meet_last.dropna().isin([0.0, 0.5, 1.0]).all())
        ages = fx.age_a.dropna()
        self.assertTrue(((ages > 20) & (ages < 40)).all())


class MarketGuardTest(unittest.TestCase):
    def test_no_vig_and_orientation(self):
        p, ov = K.novig(-200, 170)
        self.assertAlmostEqual(float(p), (200 / 300) / (200 / 300 + 100 / 270))
        self.assertAlmostEqual(float(ov), 200 / 300 + 100 / 270 - 1)
        self.assertTrue(np.isnan(K.american_to_prob([50])[0]))                  # not a price
        q = {"home_id": "1", "away_id": "2", "p_home": 0.6, "ml_home": -160, "ml_away": 140}
        self.assertEqual(K.quote_for(q, "1"), (0.6, -160, 140))
        self.assertAlmostEqual(K.quote_for(q, "2")[0], 0.4)
        self.assertIsNone(K.quote_for(q, "3"))

    def test_archive_matching_reads_the_sides_and_refuses_a_wrong_winner(self):
        b = pd.DataFrame({"bout_id": ["1", "2"], "event_id": ["e", "e"], "fighter_a": ["Jon Smith", "Ana Lee"], "fighter_b": ["Bo Diaz", "Kim Park"],
                          "ts": pd.to_datetime(["2020-01-02T03:00Z", "2020-01-02T03:00Z"], utc=True), "final": [True, True], "y": [1.0, 0.0]})
        arch = pd.DataFrame({"red": ["Bo Diaz", "Ana Lee"], "blue": ["Jon Smith", "Kim Park"], "red_odds": [150, -200], "blue_odds": [-170, 170],
                             "date": pd.to_datetime(["2020-01-01", "2020-01-01"]), "winner": ["Blue", "Red"]})
        arch["p_red"], arch["overround"] = K.novig(arch.red_odds.values, arch.blue_odds.values)
        m = K.match_archive(b, arch).set_index("bout_id")
        self.assertEqual(list(m.index), ["1"])                                 # bout 2: the archive's winner disagrees with ESPN's
        self.assertAlmostEqual(m.loc["1", "p_a_close"], 1 - arch.p_red.iloc[0])  # Jon Smith is the archive's blue

    def test_the_guard_labels_a_gap_and_never_makes_it_a_signal_uncertified(self):
        cfg = GD.config()
        th = cfg["threshold_pp"]
        cert = GD.certification({"rows": [{"lo": th, "n": 500, "model_log_loss": 0.6, "close_log_loss": 0.5}],
                                 f"over_{th}": {"n": 500, "model_favour": 150, "market_favour": 350, "diff_ci95": [0.05, 0.1]}},
                                {"timestamped": False}, cfg)
        self.assertFalse(cert["certified"])
        self.assertTrue(any("untimestamped" in r for r in cert["reasons"]))
        ok = GD.certification({"rows": [{"lo": th, "n": 500, "model_log_loss": 0.5, "close_log_loss": 0.6}],
                               f"over_{th}": {"n": 500, "diff_ci95": [-0.1, -0.05]}}, {"timestamped": True}, cfg)
        self.assertTrue(ok["certified"])
        f = GD.explain("Old", {"ufc_bouts": 19, "age": 38.0, "days_off": 400}, "New", {"ufc_bouts": 2, "age": 31.0, "pre_w": 12, "pre_l": 1}, meet=1, meet_last=0.0, cfg=cfg)
        self.assertEqual([x["code"] for x in f], ["short_sample", "layoff", "age", "rematch"])
        d = GD.assess(0.70, {"p_a": 0.53}, f, cert, cfg)
        self.assertEqual((d["status"], d["label"], d["gap_pp"], d["signal_allowed"]), ("DISAGREES", GD.LABEL, 17.0, False))
        self.assertEqual(GD.assess(0.70, {"p_a": 0.53}, f, ok, cfg)["signal_allowed"], True)
        a = GD.assess(0.55, {"p_a": 0.53}, f, cert, cfg)
        self.assertEqual((a["status"], a["factors"]), ("AGREES", []))
        self.assertEqual(GD.assess(0.55, None, f, cert, cfg)["status"], "NO_MARKET")


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.saved = (L.DATA, L.DOCS, L.PUB, L.LEDGER)
        L.DATA = os.path.join(self.d, "bouts.csv")
        L.DOCS, L.PUB, L.LEDGER = (os.path.join(self.d, x) for x in ("docs", "pub", "ledger"))
        synthetic(L.DATA)
        L.cmd_prereg()

    def tearDown(self):
        L.DATA, L.DOCS, L.PUB, L.LEDGER = self.saved
        shutil.rmtree(self.d)

    def test_backtest_serve_refresh_score_research(self):
        bt = L.cmd_backtest()
        self.assertEqual(bt["variants"], 60)
        self.assertTrue(bt["decision"]["serve"], bt["decision"])           # a history with real skill clears the rule
        self.assertTrue(L.served()["status"].startswith("SERVED"))
        out = L.cmd_refresh(fetch=False)
        self.assertEqual(out["status"], "EXPERIMENTAL")
        self.assertTrue(all(abs(b["p_a"] + b["p_b"] - 1) < 1e-9 for b in out["bouts"]))
        self.assertTrue(all(b["guard"]["status"] in ("AGREES", "DISAGREES", "NO_MARKET") and not b["guard"]["signal_allowed"] for b in out["bouts"]))
        self.assertEqual(out["guard"]["threshold_pp"], GD.config()["threshold_pp"])
        s = L.cmd_research(only=["k_lower", "calibration_toggle"])
        self.assertEqual(len(s["candidates"]), 2)
        self.assertTrue(all(c["decision"] in ("PASS", "FAIL", "SKIPPED") for c in s["candidates"]))
        L.cmd_score()
        L.cmd_report()
        self.assertTrue(os.path.exists(os.path.join(L.DOCS, "weekly_model_report.md")))
        ev = L.cmd_evidence()
        m = ev["markets"]["moneyline"]
        self.assertEqual(json.load(open(os.path.join(L.PUB, "validation.json")))["schema"], "edgedesk_lab_walkforward_v1")
        self.assertEqual(m["n"], bt["evaluation"]["validation"]["all"]["n"])
        self.assertEqual(m["status"] == "OUTCOME_VALIDATED", not m["failed"])
        self.assertEqual(m["market_status"], "NOT_TESTED")
        c = ev["result"]["confirmation"]
        self.assertLess(c["vs_coin_flip"]["ci95"][1], 0)                     # real skill beats the coin flip, card-blocked
        self.assertGreater(c["vs_coin_flip"]["blocks"], 10)

    def test_calibration_is_read_the_same_whichever_fighter_is_listed_first(self):
        p = np.array([0.3, 0.55, 0.62, 0.71, 0.45, 0.8])
        y = np.array([0, 1, 1, 0, 1, 1.0])
        self.assertAlmostEqual(U.fit_slope(p, y), U.fit_slope(1 - p, 1 - y), places=9)
        pf, yf = L._favourite_side(p, y)
        self.assertTrue((pf >= 0.5).all())
        self.assertTrue(np.allclose(pf - yf, np.where(p < 0.5, (1 - p) - (1 - y), p - y)))

    def test_a_coin_flip_history_is_not_served(self):
        d = pd.read_csv(L.DATA, dtype=str)
        rng = np.random.default_rng(3)
        fin = d.status == "STATUS_FINAL"
        aw = rng.uniform(size=len(d)) < 0.5
        d.loc[fin, "a_winner"] = [str(bool(x)) for x in aw[fin.values]]
        d.loc[fin, "b_winner"] = [str(not bool(x)) for x in aw[fin.values]]
        d.to_csv(L.DATA, index=False)
        bt = L.cmd_backtest()
        self.assertFalse(bt["decision"]["serve"])
        self.assertIsNone(L.served())
        self.assertEqual(L.cmd_refresh(fetch=False)["bouts"], [])

    def test_a_changed_protocol_is_refused(self):
        doc = json.load(open(os.path.join(L.DOCS, "prereg.json")))
        doc["grid"]["k"].append(128)
        json.dump(doc, open(os.path.join(L.DOCS, "prereg.json"), "w"))
        with self.assertRaises(SystemExit):
            L.cmd_backtest()


if __name__ == "__main__":
    unittest.main()
