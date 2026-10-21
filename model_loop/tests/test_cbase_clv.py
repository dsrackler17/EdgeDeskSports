"""College baseball's forward CLV holdout (research/clv/cbase.py, EXPERIMENTS.md CBASE-H1):
the open is the price in force when the model's number was taken, the close the same book's last
pregame price; a stale close, a game not played and another configuration's numbers are no bets;
nothing about CLV is computed before the read point, and the holdout is read once."""
import gzip
import json
import os
import tempfile
import unittest

import pandas as pd

from model_loop.clv import harness as H
from research.clv import cbase as CB
from research.clv import runner


def _write(root, season, models, lines, obs):
    md = CB.market_dir(season, root)
    os.makedirs(os.path.join(md, "observations"), exist_ok=True)
    with open(os.path.join(md, "models.jsonl"), "w") as f:
        f.write("".join(json.dumps(m) + "\n" for m in models))
    with open(os.path.join(md, "lines.jsonl"), "w") as f:
        f.write("".join(json.dumps(l) + "\n" for l in lines))
    with gzip.open(os.path.join(md, "observations", "2027-03-01.jsonl.gz"), "wt") as f:
        f.write("".join(json.dumps(o) + "\n" for o in obs))


def _game(i, open_home=-120, open_away=100, close_home=-160, close_away=135, p_home=0.62, cfg="frozen", age=10, flip=False, book="draftkings", day="2027-03-01"):
    ev = f"e{i}"
    m = {"captured_at": f"{day}T12:01:00Z", "event_id": ev, "game_id": f"g{i}", "date": day, "commence_time": f"{day}T23:00:00Z", "home_id": "1", "away_id": "2",
         "provider_home_is_ours": not flip, "p_home": p_home, "config_sha256": cfg, "served_version": "1.0.0"}
    po = {"home": open_away, "away": open_home} if flip else {"home": open_home, "away": open_away}
    pc = {"home": close_away, "away": close_home} if flip else {"home": close_home, "away": close_away}
    o = {"at": f"{day}T12:00:00Z", "event_id": ev, "book": book, "market": "h2h", "price": po}
    later = {"at": f"{day}T13:00:00Z", "event_id": ev, "book": book, "market": "h2h", "price": {"home": -999, "away": 600}}   # after the model's number: not the open
    ln = {"event_id": ev, "book": book, "market": "h2h", "open": po, "close": pc, "close_age_min": age, "commence_time": m["commence_time"]}
    return m, ln, [o, later]


class CbaseClv(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.out = os.path.join(self.root, "market_clv.json")

    def build(self, games):
        models, lines, obs = [], [], []
        for m, ln, o in games:
            models.append(m); lines.append(ln); obs.extend(o)
        _write(self.root, 2027, models, lines, obs)
        return pd.DataFrame([{"game_id": m["game_id"], "date": m["date"], "status": "FINAL"} for m, _, _ in games])

    def test_registered_and_locked(self):
        self.assertTrue(runner.preregistered(CB.EXP_ID))
        self.assertEqual(runner.LOCKED["cbase"], {2027})

    def test_the_rows(self):
        gs = [_game(1), _game(2, flip=True), _game(3, age=90), _game(4, cfg="later"), _game(5, book="unknownbook")]
        games = self.build(gs)
        games.loc[games.game_id == "g1", "status"] = "FINAL"
        df, why = CB.frame(2027, "frozen", self.root, games)
        g1 = df[df.game_id == "g1"].iloc[0]
        self.assertEqual((g1.open_a, g1.open_b, g1.close_a, g1.close_b), (-120, 100, -160, 135))      # in force at the model's number, never the later price
        g2 = df[df.game_id == "g2"].iloc[0]
        self.assertEqual((g2.open_a, g2.close_a), (-120, -160))                                       # the provider's home turned to ours
        self.assertEqual(sorted(df.game_id), ["g1", "g2"])
        self.assertEqual(why["close_too_old"], 1)                                                     # g3
        self.assertEqual(why["no_book_with_open_and_close"], 2)                                       # g3 (its only book's close too old) and g5
        # g4 belongs to another configuration and is not in this frame at all

    def test_a_game_not_played_is_no_bet(self):
        games = self.build([_game(1), _game(2)])
        games.loc[games.game_id == "g2", "status"] = "POSTPONED"
        df, why = CB.frame(2027, "frozen", self.root, games)
        self.assertEqual(list(df.game_id), ["g1"])
        self.assertEqual(why["no_contest"], 1)

    def test_counting_only_before_the_read_point(self):
        games = self.build([_game(i) for i in range(1, 40)])
        calls = []
        d = CB.status(2027, now="2027-03-02T12:00:00Z", root=self.root, games=games, out=self.out, run_read=lambda df: calls.append(1))
        self.assertEqual(d["status"], "CAPTURING")
        self.assertEqual(d["n_bets"], 39)
        self.assertEqual(calls, [])
        self.assertNotIn("summary", d)
        self.assertNotIn("verdict", d)
        self.assertEqual(d["frozen_config_sha256"], "frozen")

    def test_read_once_at_the_read_point(self):
        games = self.build([_game(i, day="2027-03-%02d" % (1 + i % 28)) for i in range(1, 521)])
        reads = []

        def read(df):
            reads.append(len(df))
            return H.evaluate(df, CB.config(), k_tests=1, label="test")

        d = CB.status(2027, now="2027-04-01T12:00:00Z", root=self.root, games=games, out=self.out, run_read=read)
        self.assertEqual(reads, [520])
        self.assertEqual(d["status"], "MARKET_VALIDATED")
        self.assertTrue(d["verdict"]["pass"])
        again = CB.status(2027, now="2027-04-02T12:00:00Z", root=self.root, games=games, out=self.out, run_read=read)
        self.assertEqual(reads, [520])                                                                # never read twice
        self.assertEqual(again["read_at"], "2027-04-01T12:00:00Z")

    def test_a_model_that_loses_to_the_close_fails(self):
        games = self.build([_game(i, open_home=-160, open_away=135, close_home=-120, close_away=100, p_home=0.70, day="2027-03-%02d" % (1 + i % 28)) for i in range(1, 521)])
        d = CB.status(2027, now="2027-04-01T12:00:00Z", root=self.root, games=games, out=self.out,
                      run_read=lambda df: H.evaluate(df, CB.config(), k_tests=1, label="test"))
        self.assertEqual(d["status"], "FAILED")

    def test_the_season_end_reads_what_there_is(self):
        games = self.build([_game(i) for i in range(1, 30)])
        d = CB.status(2027, now="2027-07-01T00:00:00Z", root=self.root, games=games, out=self.out,
                      run_read=lambda df: H.evaluate(df, CB.config(), k_tests=1, label="test"))
        self.assertEqual(d["status"], "INCONCLUSIVE")

    def test_nothing_captured_is_not_tested(self):
        d = CB.status(2027, now="2027-03-01T00:00:00Z", root=self.root, games=pd.DataFrame(columns=["game_id", "date", "status"]), out=self.out)
        self.assertEqual(d["status"], "NOT_TESTED")


if __name__ == "__main__":
    unittest.main()
