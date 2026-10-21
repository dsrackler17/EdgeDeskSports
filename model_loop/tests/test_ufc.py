"""The UFC adapter: the parser reproduces the data pack, the Elo is causal and
symmetric, and the preregistered pipeline (backtest -> serve decision ->
refresh -> score -> research) runs end to end on a synthetic history."""
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

from model_loop.adapters.ufc import ingest as I
from model_loop.adapters.ufc import loop as L
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

    def test_slope_calibration_is_symmetric_and_fitted_only_on_earlier_seasons(self):
        r, _ = U.walk(self.bouts, {"k": 32})
        c, fits = U.calibrate(r, {"calibration": "slope"}, 2016)
        self.assertNotIn(2016, fits)                       # no earlier season to fit on
        z = c[c.season == 2018]
        self.assertTrue(np.allclose(z.p.values - 0.5, -(1 - z.p.values - 0.5)))


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
        s = L.cmd_research(only=["k_lower", "calibration_toggle"])
        self.assertEqual(len(s["candidates"]), 2)
        self.assertTrue(all(c["decision"] in ("PASS", "FAIL", "SKIPPED") for c in s["candidates"]))
        L.cmd_score()
        L.cmd_report()
        self.assertTrue(os.path.exists(os.path.join(L.DOCS, "weekly_model_report.md")))

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
