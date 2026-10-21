"""The opening-line collector (research/clv/collect_openers.py) records each
book's first pregame line and every change after it, never an in-play or
off-the-board price, never a line whose sides disagree, and settles each game
once with ESPN's own open and close. Offline: ESPN is a fake here.

Run: python3 -m unittest model_loop.tests.test_clv_openers -v
"""
import copy
import datetime as dt
import json
import os
import shutil
import tempfile
import unittest

from research.clv import collect_openers as C

T0 = dt.datetime(2026, 10, 21, 17, 0, tzinfo=dt.timezone.utc)

# the shape ESPN's scoreboard sends (football/cfb_lab/fixtures/providers/espn_scoreboard_pregame.json,
# and the pickcenter of an ESPN game summary), with hockey's moneyline-style `details`
NHL_ODDS = {
    "provider": {"id": "100", "name": "DraftKings", "priority": 1},
    "details": "TOR -205", "overUnder": 6.5, "spread": 1.5,
    "homeTeamOdds": {"favorite": True, "underdog": False, "moneyLine": -205, "spreadOdds": 120.0, "teamId": "21"},
    "awayTeamOdds": {"favorite": False, "underdog": True, "moneyLine": 170, "spreadOdds": -145.0, "teamId": "1"},
    "moneyline": {"home": {"open": {"odds": "-190"}, "close": {"odds": "-205"}},
                  "away": {"open": {"odds": "+160"}, "close": {"odds": "+170"}}},
    "pointSpread": {"home": {"open": {"line": "-1.5", "odds": "+130"}, "close": {"line": "-1.5", "odds": "+120"}},
                    "away": {"open": {"line": "+1.5", "odds": "-155"}, "close": {"line": "+1.5", "odds": "-145"}}},
    "total": {"over": {"open": {"line": "o6.5", "odds": "-110"}, "close": {"line": "o6.5", "odds": "-118"}},
              "under": {"open": {"line": "u6.5", "odds": "-110"}, "close": {"line": "u6.5", "odds": "-102"}}},
}


def team(i, ab, name, side):
    return {"id": i, "homeAway": side, "team": {"id": i, "abbreviation": ab, "displayName": name}}


def board(odds=None, start="2026-10-22T23:00Z", state="pre", status="STATUS_SCHEDULED", cid="401", time_valid=True,
          home=("21", "TOR", "Toronto Maple Leafs"), away=("1", "BOS", "Boston Bruins"), season=2027):
    return {"events": [{"id": cid, "date": start, "season": {"year": season, "type": 2}, "competitions": [{
        "id": cid, "date": start, "timeValid": time_valid,
        "status": {"type": {"name": status, "state": state, "completed": state == "post"}},
        "competitors": [team(*home, "home"), team(*away, "away")],
        "odds": [copy.deepcopy(NHL_ODDS)] if odds is None else odds}]}]}


def summary(state="post", name="STATUS_FINAL", pick=True):
    pc = dict(copy.deepcopy(NHL_ODDS), provider={"id": "100", "name": "Draft Kings"})   # as ESPN's summaries spell it
    return {"header": {"competitions": [{"status": {"type": {"name": name, "state": state, "completed": state == "post"}},
                                         "competitors": [{"homeAway": "home", "score": "4"}, {"homeAway": "away", "score": "2"}]}]},
            "pickcenter": [pc] if pick else []}


class Fake:
    """URL substring -> payload; anything else is an empty scoreboard."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url):
        self.calls.append(url)
        for k, v in self.routes.items():
            if k in url:
                if isinstance(v, Exception):
                    raise v
                return copy.deepcopy(v)
        return {"events": []}


def ev_of(payload, sport="nhl"):
    return C.competitions(payload, sport)[0]


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.saved = C.OUT, C.SUMMARY
        C.OUT, C.SUMMARY = self.dir, os.path.join(self.dir, "summary.json")

    def tearDown(self):
        C.OUT, C.SUMMARY = self.saved
        shutil.rmtree(self.dir)

    def rows(self, sport="nhl"):
        out = []
        for fn in sorted(os.listdir(os.path.join(self.dir, sport))) if os.path.isdir(os.path.join(self.dir, sport)) else []:
            with open(os.path.join(self.dir, sport, fn)) as f:
                out += [json.loads(l) for l in f if l.strip()]
        return out


class TestMarkets(unittest.TestCase):
    def test_reads_the_book_now_and_its_open(self):
        ev, odds = ev_of(board())
        (row, op), why = C.quote(odds[0], ev, "nhl", T0)
        self.assertIsNone(why)
        self.assertEqual(row["book"], "DraftKings")
        self.assertEqual(row["ml"], {"home": -205, "away": 170})
        self.assertEqual(row["spread"], {"home": -1.5, "home_price": 120, "away_price": -145})
        self.assertEqual(row["total"], {"point": 6.5, "over": -118, "under": -102})
        self.assertEqual(op["ml"], {"home": -190, "away": 160})
        self.assertEqual(op["spread"], {"home": -1.5, "home_price": 130, "away_price": -155})
        self.assertEqual(op["total"], {"point": 6.5, "over": -110, "under": -110})

    def test_hockey_details_is_never_read_as_a_spread(self):
        o = {k: v for k, v in NHL_ODDS.items() if k not in ("pointSpread", "spread")}
        m = C.market(o, "now", "nhl", "TOR", "BOS")
        self.assertIsNone(m["spread"])                   # "TOR -205" is the moneyline favourite
        self.assertEqual(m["ml"], {"home": -205, "away": 170})

    def test_flat_spread_follows_the_favourite_flags(self):
        o = {k: v for k, v in NHL_ODDS.items() if k != "pointSpread"}
        self.assertEqual(C.market(o, "now", "nhl", "TOR", "BOS")["spread"], {"home": -1.5, "home_price": 120, "away_price": -145})

    def test_basketball_details_and_a_side_disagreement(self):
        o = {"provider": {"name": "DraftKings"}, "details": "UCONN -12.5", "spread": 12.5, "overUnder": 141.5,
             "homeTeamOdds": {"favorite": True, "moneyLine": -1200, "spreadOdds": -110},
             "awayTeamOdds": {"favorite": False, "moneyLine": 700, "spreadOdds": -110}}
        m = C.market(o, "now", "ncaaw", "UCONN", "SC")
        self.assertEqual(m["spread"]["home"], -12.5)
        o["pointSpread"] = {"home": {"close": {"line": "+12.5", "odds": "-110"}}, "away": {"close": {"line": "-12.5", "odds": "-110"}}}
        self.assertIsNone(C.market(o, "now", "ncaaw", "UCONN", "SC")["spread"])   # nested says the away side is favoured

    def test_impossible_prices_and_missing_sides_are_left_out(self):
        o = copy.deepcopy(NHL_ODDS)
        o["homeTeamOdds"]["moneyLine"], o["moneyline"]["home"]["close"]["odds"] = 150, "+150"
        o["awayTeamOdds"]["moneyLine"], o["moneyline"]["away"]["close"]["odds"] = 150, "+150"
        self.assertIsNone(C.market(o, "now", "nhl", "TOR", "BOS")["ml"])           # +150 / +150 is free money
        o = {"provider": {"name": "DraftKings"}, "homeTeamOdds": {"moneyLine": -150}, "awayTeamOdds": {}}
        self.assertIsNone(C.market(o, "now", "nhl"))

    def test_unnamed_consensus_and_misoriented_books_are_refused(self):
        ev, _ = ev_of(board())
        for name in ("", "consensus", "Opening Line", "teamrankings", "numberfire"):
            o = dict(NHL_ODDS, provider={"name": name})
            self.assertIsNotNone(C.quote(o, ev, "nhl", T0)[1])
        o = copy.deepcopy(NHL_ODDS)
        o["homeTeamOdds"]["teamId"], o["awayTeamOdds"]["teamId"] = "1", "21"
        self.assertEqual(C.quote(o, ev, "nhl", T0)[1], "odds name the other side as home")

    def test_one_spelling_per_book(self):
        for name in ("DraftKings", "Draft Kings", " draftkings "):
            self.assertEqual(C.book_of({"provider": {"name": name}}), "DraftKings")
        self.assertEqual(C.book_of({"provider": {"name": "Some Book"}}), "Some Book")
        self.assertIsNone(C.book_of({"provider": {"name": "Team Rankings"}}))

    def test_numbers(self):
        self.assertEqual(C.american("EVEN"), 100)
        self.assertEqual(C.american({"american": "-130"}), -130)
        self.assertIsNone(C.american("-50"))
        self.assertIsNone(C.american(True))
        self.assertEqual(C.point("o230.5"), 230.5)
        self.assertEqual(C.point("PK"), 0.0)
        self.assertEqual(C.point({"american": "+3.5"}), 3.5)


class TestPregame(unittest.TestCase):
    def test_only_before_the_start_and_only_pre(self):
        self.assertTrue(C.pregame(ev_of(board())[0], T0))
        self.assertFalse(C.pregame(ev_of(board(start="2026-10-21T16:00Z"))[0], T0))
        self.assertFalse(C.pregame(ev_of(board(state="in", status="STATUS_IN_PROGRESS"))[0], T0))
        self.assertFalse(C.pregame(ev_of(board(status="STATUS_POSTPONED"))[0], T0))

    def test_a_tbd_time_counts_until_its_day_is_over(self):
        tbd = ev_of(board(start="2026-10-21T04:00Z", time_valid=False))[0]     # midnight ET placeholder, today
        self.assertTrue(C.pregame(tbd, T0))
        self.assertFalse(C.pregame(tbd, T0 + dt.timedelta(days=1)))


class TestCapture(Base):
    def test_first_sighting_then_only_changes(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": board()})
        rep = C.capture_sport("nhl", T0, f, pause=0)
        self.assertEqual(rep["rows"], {"event": 1, "quote": 1, "settle": 0})
        self.assertEqual(rep["requests"], 7)                                        # today and six more ET days
        r = self.rows()
        self.assertEqual([x["kind"] for x in r], ["event", "quote"])
        self.assertEqual(r[0]["home"], {"id": "21", "abbr": "TOR", "name": "Toronto Maple Leafs"})
        self.assertEqual(r[0]["start_utc"], "2026-10-22T23:00:00Z")
        self.assertEqual(r[1]["observed_at"], "2026-10-21T17:00:00Z")
        self.assertEqual(r[1]["open"]["ml"], {"home": -190, "away": 160})
        self.assertTrue(os.path.exists(os.path.join(self.dir, "nhl", "2026-10.jsonl")))

        rep = C.capture_sport("nhl", T0 + dt.timedelta(hours=1), f, pause=0)        # nothing moved
        self.assertEqual(rep["rows"], {"event": 0, "quote": 0, "settle": 0})

        moved = board()
        moved["events"][0]["competitions"][0]["odds"][0]["homeTeamOdds"]["moneyLine"] = -215
        moved["events"][0]["competitions"][0]["odds"][0]["moneyline"]["home"]["close"]["odds"] = "-215"
        f.routes["hockey/nhl/scoreboard?dates=20261022"] = moved
        C.capture_sport("nhl", T0 + dt.timedelta(hours=2), f, pause=0)
        r = self.rows()
        self.assertEqual(len(r), 3)
        self.assertEqual(r[2]["ml"], {"home": -215, "away": 170})
        self.assertNotIn("open", r[2])                                              # the opener did not change

    def test_a_game_in_play_is_not_quoted_or_listed(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261021": board(start="2026-10-21T16:00Z", state="in", status="STATUS_IN_PROGRESS")})
        rep = C.capture_sport("nhl", T0, f, pause=0)
        self.assertEqual(rep["listed"], 0)
        self.assertEqual(self.rows(), [])

    def test_a_postponement_is_an_event_row_and_never_a_quote(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": board()})
        C.capture_sport("nhl", T0, f, pause=0)
        f.routes["hockey/nhl/scoreboard?dates=20261022"] = board(status="STATUS_POSTPONED")
        rep = C.capture_sport("nhl", T0 + dt.timedelta(hours=1), f, pause=0)
        self.assertEqual(rep["rows"], {"event": 1, "quote": 0, "settle": 0})
        self.assertEqual(self.rows()[-1]["status"], "STATUS_POSTPONED")

    def test_settle_once_with_espns_open_and_close(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": board(), "summary?event=401": summary()})
        C.capture_sport("nhl", T0, f, pause=0)
        later = dt.datetime(2026, 10, 23, 4, 0, tzinfo=dt.timezone.utc)             # five hours after the start
        f.routes.pop("hockey/nhl/scoreboard?dates=20261022")
        rep = C.capture_sport("nhl", later, f, pause=0)
        self.assertEqual(rep["rows"]["settle"], 1)
        s = self.rows()[-1]
        self.assertEqual((s["status"], s["completed"], s["home_score"], s["away_score"]), ("STATUS_FINAL", True, 4.0, 2.0))
        self.assertEqual(s["books"][0]["book"], "DraftKings")                         # the quote's spelling
        self.assertEqual(s["books"][0]["open"]["ml"], {"home": -190, "away": 160})
        self.assertEqual(s["books"][0]["close"]["ml"], {"home": -205, "away": 170})
        rep = C.capture_sport("nhl", later + dt.timedelta(hours=1), f, pause=0)
        self.assertEqual(rep["rows"]["settle"], 0)
        self.assertEqual(sum("summary" in u for u in f.calls), 1)

    def test_settle_waits_for_the_final_then_records_it_as_it_stands(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": board(), "summary?event=401": summary("in", "STATUS_IN_PROGRESS")})
        C.capture_sport("nhl", T0, f, pause=0)
        f.routes.pop("hockey/nhl/scoreboard?dates=20261022")
        rep = C.capture_sport("nhl", dt.datetime(2026, 10, 23, 4, 0, tzinfo=dt.timezone.utc), f, pause=0)
        self.assertEqual(rep["rows"]["settle"], 0)
        rep = C.capture_sport("nhl", dt.datetime(2026, 10, 26, 0, 0, tzinfo=dt.timezone.utc), f, pause=0)
        self.assertEqual(rep["rows"]["settle"], 1)
        self.assertFalse(self.rows()[-1]["completed"])

    def test_a_failed_scoreboard_is_reported_not_guessed(self):
        f = Fake({"scoreboard": OSError("403 from the edge")})
        rep = C.capture_sport("nhl", T0, f, pause=0)
        self.assertEqual(rep["scoreboards_ok"], 0)
        self.assertEqual(len(rep["errors"]), 7)
        self.assertEqual(self.rows(), [])


class TestUfc(Base):
    def card(self, odds):
        bout = lambda cid, a, b: {"id": cid, "date": "2026-11-07T23:00Z", "matchNumber": int(cid[-1]),
                                  "status": {"type": {"name": "STATUS_SCHEDULED", "state": "pre"}},
                                  "competitors": [{"id": a, "homeAway": "home", "order": 1, "athlete": {"id": a, "displayName": "Fighter " + a}},
                                                  {"id": b, "homeAway": "away", "order": 2, "athlete": {"id": b, "displayName": "Fighter " + b}}],
                                  "odds": odds}
        return {"events": [{"id": "600", "name": "UFC 999", "date": "2026-11-07T23:00Z", "season": {"year": 2026},
                            "competitions": [bout("6001", "11", "12"), bout("6002", "13", "14")]}]}

    def test_bouts_from_the_card_scoreboard(self):
        o = {"provider": {"name": "DraftKings"}, "homeAthleteOdds": {"moneyLine": -250}, "awayAthleteOdds": {"moneyLine": 200}}
        f = Fake({"mma/ufc/scoreboard?dates=202611": self.card([o])})
        rep = C.capture_sport("ufc", T0, f, pause=0)
        self.assertEqual(rep["rows"], {"event": 2, "quote": 2, "settle": 0})
        r = self.rows("ufc")
        self.assertEqual(r[0]["card"], "UFC 999")
        self.assertEqual(r[0]["side_source"], "homeAway")
        self.assertEqual(r[1]["ml"], {"home": -250, "away": 200})
        self.assertNotIn("spread", r[1])
        self.assertFalse(any("summary" in u for u in f.calls))                      # UFC is not settled here

    def order_ev(self):
        """A bout as ESPN lists it: no homeAway, the sides come from the listing order."""
        c = self.card([])
        for b in c["events"][0]["competitions"]:
            for x in b["competitors"]:
                x.pop("homeAway")
        return C.competitions(c, "ufc")[0][0]

    def test_unlabelled_sides_must_be_verified(self):
        ev = self.order_ev()
        self.assertEqual(ev["side_source"], "order")
        self.assertEqual(ev["home"]["name"], "Fighter 11")
        o = {"provider": {"name": "DraftKings"}, "details": "Fighter 11 -250",
             "homeAthleteOdds": {"favorite": True, "moneyLine": -250}, "awayAthleteOdds": {"favorite": False, "moneyLine": 200}}
        self.assertIsNone(C.quote(o, ev, "ufc", T0)[1])                              # details names the home favourite
        o["details"] = "Fighter 12 -250"
        self.assertEqual(C.quote(o, ev, "ufc", T0)[1], "odds name the other side as home")
        o["details"] = "EVEN"
        self.assertEqual(C.quote(o, ev, "ufc", T0)[1], "sides not verifiable")
        o["homeAthleteOdds"]["athlete"] = {"$ref": "http://sports.core.api.espn.pvt/v2/sports/mma/athletes/11?lang=en"}
        self.assertIsNone(C.quote(o, ev, "ufc", T0)[1])                              # the odds' own id settles it
        o["homeAthleteOdds"]["athlete"] = {"$ref": "http://sports.core.api.espn.pvt/v2/sports/mma/athletes/12?lang=en"}
        self.assertEqual(C.quote(o, ev, "ufc", T0)[1], "odds name the other side as home")
        o["homeAthleteOdds"]["athlete"] = {"$ref": "http://sports.core.api.espn.pvt/v2/sports/mma/athletes/99?lang=en"}
        self.assertEqual(C.quote(o, ev, "ufc", T0)[1], "sides not verifiable")    # an id that is neither fighter

    def test_core_api_when_the_card_has_no_odds(self):
        core_item = {"provider": {"name": "DraftKings"},
                     "homeAthleteOdds": {"current": {"moneyLine": {"american": "-140"}}, "open": {"moneyLine": {"american": "-120"}}},
                     "awayAthleteOdds": {"current": {"moneyLine": {"american": "+115"}}, "open": {"moneyLine": {"american": "+100"}}}}
        f = Fake({"mma/ufc/scoreboard?dates=202611": self.card([]),
                  "competitions/6001/odds/100": core_item,
                  "competitions/6001/odds": {"items": [{"$ref": "http://sports.core.api.espn.pvt/v2/sports/mma/leagues/ufc/events/600/competitions/6001/odds/100"}]},
                  "competitions/6002/odds": {"items": []}})
        now = T0.replace(hour=16)                                                   # an hour divisible by CORE_EVERY_H
        rep = C.capture_sport("ufc", now, f, pause=0)
        self.assertEqual(rep["core_requests"], 2)
        q = [x for x in self.rows("ufc") if x["kind"] == "quote"]
        self.assertEqual(len(q), 1)
        self.assertEqual(q[0]["ml"], {"home": -140, "away": 115})
        self.assertEqual(q[0]["open"]["ml"], {"home": -120, "away": 100})
        self.assertTrue(any(u.startswith(C.ESPN_CORE) and u.endswith("/odds/100") for u in f.calls))
        rep = C.capture_sport("ufc", T0, f, pause=0)                                # 17:00: not due, card 17 days out
        self.assertEqual(rep["core_requests"], 0)


class TestArchive(Base):
    def day(self, *games):
        return {"events": [g for b in games for g in b["events"]]}

    def test_backfill_reads_finished_games_and_resumes(self):
        final = lambda cid: board(cid=cid, state="post", status="STATUS_FINAL", start="2026-01-15T00:00Z", season=2026)
        f = Fake({"scoreboard?dates=20260114": self.day(final("501"), final("502"), board(cid="503", start="2026-01-15T00:00Z")),
                  "scoreboard?dates=20260115": self.day(final("504")),
                  "summary?event=502": summary(pick=False), "summary?event=": summary()})
        rep = C.backfill("nhl", "20260114", "20260115", f, max_requests=4, now=T0, pause=0)
        self.assertEqual((rep["games"], rep["with_open_and_close"], rep["to"], rep["done"]), (2, 1, "20260114", False))
        rows = self.rows()
        self.assertEqual([r["cid"] for r in rows], ["501", "502"])                  # the scheduled game is not archived
        self.assertEqual(rows[0]["kind"], "archive")
        self.assertEqual(rows[0]["books"][0]["open"]["ml"], {"home": -190, "away": 160})
        self.assertEqual(rows[0]["books"][0]["close"]["ml"], {"home": -205, "away": 170})
        self.assertEqual((rows[0]["home_score"], rows[0]["season"]), (4.0, 2026))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "nhl", "backfill_2026.jsonl")))
        rep = C.backfill("nhl", "20260114", "20260115", f, now=T0, pause=0)
        self.assertEqual((rep["games"], rep["skipped_have"], rep["done"]), (1, 2, True))
        s = C.summarise("nhl")["seasons"]["2026"]
        self.assertEqual((s["archive_games"], s["archive_with_open_and_close"], s["testable"], s["listed"]), (3, 2, 2, 0))

    def test_the_hourly_state_never_reads_the_archive(self):
        os.makedirs(os.path.join(self.dir, "nhl"))
        with open(os.path.join(self.dir, "nhl", "backfill_2027.jsonl"), "w") as fh:
            fh.write(json.dumps({"kind": "quote", "cid": "401", "book": "DraftKings", "observed_at": "2026-10-21T16:00:00Z",
                                 "ml": NHL_QUOTE_ML, "spread": None, "total": None}) + "\n")
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": board()})
        self.assertEqual(C.capture_sport("nhl", T0, f, pause=0)["rows"]["quote"], 1)

    def test_card_sports_have_no_archive(self):
        with self.assertRaises(ValueError):
            C.backfill("ufc", "20261001", "20261002", Fake({}), pause=0)


NHL_QUOTE_ML = {"home": -205, "away": 170}


class TestSummary(Base):
    def test_counts_per_season(self):
        f = Fake({"hockey/nhl/scoreboard?dates=20261022": {"events": board()["events"] + board(cid="402", odds=[])["events"]},
                  "summary?event=401": summary()})
        C.capture_sport("nhl", T0, f, pause=0)
        f.routes.pop("hockey/nhl/scoreboard?dates=20261022")
        C.capture_sport("nhl", dt.datetime(2026, 10, 23, 4, 0, tzinfo=dt.timezone.utc), f, pause=0)
        s = C.write_summary()["sports"]["nhl"]
        self.assertEqual(s["seasons"]["2027"], {"listed": 2, "priced": 1, "with_espn_open": 1, "settled_with_close": 1,
                                                "testable_live": 1, "archive_games": 0, "archive_with_open_and_close": 0,
                                                "testable": 1, "priced_share": 0.5,
                                                "first_quote_hours_before_start_median": 30.0})
        self.assertEqual(s["through"], "2026-10-23T04:00:00Z")
        with open(C.SUMMARY) as fh:
            self.assertEqual(json.load(fh)["sports"]["nhl"], s)


if __name__ == "__main__":
    unittest.main()
