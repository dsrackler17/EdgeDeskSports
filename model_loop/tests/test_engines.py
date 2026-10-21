"""The engines' weekly report: it grades the last pregame record against the result,
measures the season against the engine's own record, tests patterns with the right
statistic, names missing results, and writes nothing but its own report."""
import csv
import json
import math
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import numpy as np

from model_loop import health as H
from model_loop.adapters.engines import weekly as EW

NOW = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
FIELDS = ["game_id", "season", "type", "date", "start_utc", "team", "opp", "home", "decided", "gf", "ga", "win"]


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class EngineReportTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.saved = (EW.ROOT, H.ROOT)
        EW.ROOT = H.ROOT = self.root

    def tearDown(self):
        EW.ROOT, H.ROOT = self.saved
        shutil.rmtree(self.root)

    def put(self, rel, obj):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            json.dump(obj, f)

    def nhl(self, games, ledger_extra=(), results_skip=()):
        """games: [(gid, start, home, away, p_home, home_won)]"""
        os.makedirs(os.path.join(self.root, "hockey", "ledger"), exist_ok=True)
        with open(os.path.join(self.root, "hockey", "ledger", "2027.jsonl"), "w") as f:
            for gid, start, h, a, p, _ in games:
                f.write(json.dumps({"game_id": gid, "start_utc": iso(start), "home": h, "away": a, "model": "edgedesk_nhl_v1:xg_core",
                                    "recorded_at": iso(start - timedelta(hours=6)), "p_home": p, "exp_total": 6.0,
                                    "goalie_certainty": "PROJECTED_UNCERTAIN"}) + "\n")
            for r in ledger_extra:
                f.write(json.dumps(r) + "\n")
        d = os.path.join(self.root, "hockey", "data", "team_games", "2027")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "2026-10.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            w.writeheader()
            for gid, start, h, a, p, won in games:
                if gid in results_skip:
                    continue
                for side, opp, home, win in ((h, a, 1, won), (a, h, 0, 1 - won)):
                    w.writerow({"game_id": gid, "season": 2027, "type": "R", "date": start.date().isoformat(), "start_utc": iso(start),
                                "team": side, "opp": opp, "home": home, "decided": "REG", "gf": 4 if win else 2, "ga": 2 if win else 4, "win": win})
        self.put("hockey/validation/nhl_walkforward.json", {
            "generated_at": iso(NOW - timedelta(days=2)), "selection": {"chosen": "xg_core"},
            "windows": {"confirmation": {"seasons": [2021, 2026], "by_candidate": {"xg_core": {
                "n": 7945, "moneyline": {"log_loss": 0.66286, "brier": 0.235, "climatology": {"rate": 0.5363, "log_loss": 0.69051}},
                "total_goals": {"mean_bias": 0.05}}}}}})
        self.put("hockey/slate.json", {"generated_at": iso(NOW - timedelta(hours=2)), "model": {"id": "edgedesk_nhl_v1:xg_core"}})

    def season(self, n, seed, flip=False):
        rng = np.random.default_rng(seed)
        teams = [f"T{i}" for i in range(16)]
        out = []
        for i in range(n):
            start = NOW - timedelta(days=40) + timedelta(hours=6 * i)
            h, a = rng.choice(teams, 2, replace=False)
            p = float(rng.uniform(0.3, 0.75))
            won = int(rng.uniform() < (1 - p if flip else p))
            out.append((str(1000 + i), start, h, a, round(p, 4), won))
        return out

    def test_the_last_record_before_the_start_is_graded(self):
        s = NOW - timedelta(days=3)
        recs = [{"game_id": 1, "start_utc": iso(s), "recorded_at": iso(s - timedelta(hours=9)), "p_home": 0.4},
                {"game_id": 1, "start_utc": iso(s), "recorded_at": iso(s - timedelta(hours=1)), "p_home": 0.6},
                {"game_id": 1, "start_utc": iso(s), "recorded_at": iso(s + timedelta(minutes=5)), "p_home": 0.9}]
        self.assertEqual(EW.pregame(recs)["1"]["p_home"], 0.6)

    def test_grading_matches_a_hand_computation(self):
        g = self.season(40, 1)
        self.nhl(g)
        w = EW.build("nhl", NOW)
        ll = -np.mean([math.log(p) if y else math.log(1 - p) for _, _, _, _, p, y in g])
        self.assertEqual(w["season_to_date"]["n"], 40)
        self.assertAlmostEqual(w["season_to_date"]["log_loss"], ll, places=5)
        self.assertEqual(w["promoted"], None)
        self.assertTrue(w["changes"].startswith("none"))

    def test_back_to_back_is_read_off_the_schedule(self):
        t = NOW - timedelta(days=5)
        b = EW.back_to_back({"1": (iso(t), "A", "B"), "2": (iso(t + timedelta(hours=24)), "C", "A"),
                             "3": (iso(t + timedelta(hours=72)), "A", "B")})
        self.assertEqual(b["2"], (False, True))
        self.assertEqual(b["3"], (False, False))

    def test_the_moneyline_pattern_uses_the_binomial_z_not_a_t(self):
        p = [0.7] * 10
        self.assertAlmostEqual(EW._binomial_z(p, [1] * 10), 3 / math.sqrt(10 * 0.21), places=6)
        rows = [{"p": 0.7, "y": 1.0, "home_b2b": False, "away_b2b": False, "assumption": None,
                 "exp_total": None, "total": 5, "exp_margin": None, "margin": 1}] * 10
        fav = next(x for x in EW.patterns(rows, "x") if x["pattern"].startswith("home favourite"))
        self.assertLess(fav["stat"], 3)
        self.assertFalse(fav["flag"])                 # n < 30

    def test_the_season_is_measured_against_the_engines_own_record(self):
        self.nhl(self.season(20, 2))
        self.assertEqual(EW.build("nhl", NOW)["vs_its_record"]["verdict"], "TOO_EARLY")
        self.nhl(self.season(160, 3, flip=True))
        w = EW.build("nhl", NOW)
        self.assertEqual(w["vs_its_record"]["verdict"], "WORSE_THAN_ITS_RECORD")
        self.assertTrue(any(p["flag"] for p in w["patterns"]))

    def test_a_missing_result_is_named_and_makes_the_engine_stale(self):
        g = self.season(40, 4)
        late = (NOW - timedelta(days=2))
        g.append(("9999", late, "T1", "T2", 0.55, 1))
        self.nhl(g, results_skip={"9999"})
        d = EW.data_check("nhl", NOW)
        self.assertEqual([m["game_id"] for m in d["missing_results"]], ["9999"])
        x = H.loop_health(next(L for L in H.LOOPS if L["id"] == "nhl"), NOW)
        self.assertEqual(x["status"], "STALE")
        self.assertIn("have no result (the first: 9999", " | ".join(x["reasons"]))

    def test_a_fresh_engine_is_ok_and_names_its_protocol(self):
        self.nhl(self.season(40, 5))
        EW.cmd_report("nhl", NOW)
        x = H.loop_health(next(L for L in H.LOOPS if L["id"] == "nhl"), NOW)
        self.assertEqual(x["status"], "OK", x["reasons"])
        self.assertIn("hockey/model/walkforward.js", x["served"]["promoted_by"])

    def test_the_report_writes_only_its_own_files(self):
        self.nhl(self.season(40, 6))
        before = {os.path.join(d, f) for d, _, fs in os.walk(self.root) for f in fs}
        EW.cmd_report("nhl", NOW)
        after = {os.path.join(d, f) for d, _, fs in os.walk(self.root) for f in fs}
        new = sorted(os.path.relpath(p, self.root) for p in after - before)
        self.assertEqual(new, ["docs/model-loop/nhl/weekly/2026-11-20.json", "docs/model-loop/nhl/weekly_model_report.md"])


if __name__ == "__main__":
    unittest.main()
