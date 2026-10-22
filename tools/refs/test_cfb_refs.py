#!/usr/bin/env python3
"""tools/refs/cfb_refs.py: the ESPN check, the backfill, name keys, play parsing and the weekly rows.

Offline: every ESPN summary here is a fixture built in this file. Run:
  python3 -I tools/refs/test_cfb_refs.py
"""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ["CFB_REF_CACHE"] = tempfile.mkdtemp(prefix="cfbref-cache-")
for k in ("SB_URL", "SB_SERVICE_ROLE", "GITHUB_STEP_SUMMARY", "GITHUB_ACTIONS"):
    os.environ.pop(k, None)
spec = importlib.util.spec_from_file_location("cfb_refs", HERE / "cfb_refs.py")
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

ROWS = M.seed_rows()
REFS = M.Referees(ROWS)
MISSING = M.read_csv(M.MISSING_CSV)
MISSING_IDS = {int(m["game_id"]) for m in MISSING}


def summ(officials=(), teams=(("61", "UGA", "Georgia"), ("333", "ALA", "Alabama")), drives=None, box=None):
    """A minimal ESPN summary in the shape build_cfb_ref_data.py reads."""
    return {
        "gameInfo": {"officials": [{"displayName": n, "position": {"displayName": p}} for p, n in officials]},
        "boxscore": {"teams": [{"team": {"id": tid, "abbreviation": ab, "displayName": nm, "location": nm},
                                "statistics": [{"name": "totalPenaltiesYards", "displayValue": (box or {}).get(tid, "0-0")}]}
                               for tid, ab, nm in teams]},
        "drives": {"previous": drives or []},
    }


def ref_summary(name):
    return summ(officials=[("Umpire", "Some Umpire"), ("Referee", name), ("Line Judge", "Some Judge")])


def ncaa_fetch(override=None):
    """ESPN agrees with the NCAA referee on every game, except where `override` says otherwise."""
    by_id = {r["game_id"]: r for r in ROWS}
    override = override or {}

    def fetch(gid):
        if gid in override:
            v = override[gid]
            if isinstance(v, Exception):
                raise v
            return v
        return ref_summary(by_id[gid]["referee"])
    return fetch


CANDS = M.validation_candidates(ROWS, MISSING_IDS)


class Names(unittest.TestCase):
    def test_aliases_come_from_cfb_enrich(self):
        self.assertGreaterEqual(len(M.ALIASES), 55)
        self.assertEqual(M.ALIASES["jeffreyservinski"], "jeffservinski")
        self.assertTrue(set(M.ALIASES.values()) <= REFS.ids(), "every alias target is a dataset referee_id")
        self.assertFalse(set(M.ALIASES) & REFS.ids(), "no alias spelling is its own referee_id")

    def test_key_is_lowercase_letters_only(self):
        self.assertEqual(M.key("Jerry  Magallanes Jr."), "jerrymagallanesjr")
        self.assertEqual(M.key("D'Andre O'Neal-Smith"), "dandreonealsmith")

    def test_resolve(self):
        self.assertEqual(REFS.resolve("Jerry Magallanes")[:2], ("jerrymagallanes", "exact"))
        self.assertEqual(REFS.resolve("JERRY MAGALLANES")[:2], ("jerrymagallanes", "exact"))
        self.assertEqual(REFS.resolve("Jeffrey Servinski")[:2], ("jeffservinski", "alias"))
        self.assertEqual(REFS.resolve("Hank Johns")[:2], ("henryjohns", "alias"))
        self.assertEqual(REFS.resolve("Ron Snodgrass Jr.")[:2], ("ronsnodgrass", "spelling_variant"))
        self.assertEqual(REFS.resolve("Jery Magallanes")[:2], ("jerrymagallanes", "spelling_variant"))
        rid, how, cands = REFS.resolve("Jonathon Noli")
        self.assertEqual((rid, how), (None, "ambiguous"))
        self.assertEqual(cands, ["jonathannoli", "jonnoli"])
        self.assertEqual(REFS.resolve("Totally Unknown Official")[:2], ("totallyunknownofficial", "new_referee"))
        self.assertEqual(REFS.resolve("")[:2], (None, "no_name"))

    def test_different_people_stay_different(self):
        self.assertEqual(REFS.resolve("Jon Noli")[0], "jonnoli")
        self.assertEqual(REFS.resolve("Jonathan Noli")[0], "jonathannoli")

    def test_display_and_conference_are_the_datasets(self):
        self.assertEqual(REFS.name["jeffservinski"], next(r["referee"] for r in ROWS if r["referee_id"] == "jeffservinski"))
        self.assertEqual(REFS.conf["jerrymagallanes"], "ACC")
        unmapped = {r["referee_id"] for r in ROWS if r["referee_id"] and not r["referee_primary_conf"]}
        self.assertTrue(unmapped and not (unmapped & set(REFS.conf)), "a referee the dataset does not map has no conference")


class Officials(unittest.TestCase):
    def test_only_the_position_referee_counts(self):
        self.assertEqual(M.officials(ref_summary("Jerry Magallanes"))[0], "Jerry Magallanes")
        self.assertIsNone(M.officials(summ(officials=[("Umpire", "A B"), ("Back Judge", "C D")]))[0])
        self.assertIsNone(M.officials(summ())[0])
        self.assertIsNone(M.officials({})[0])
        name, crew = M.officials(summ(officials=[("Referee", "Jerry Magallanes"), ("Umpire", "Ump Ire")]))
        self.assertIn("Umpire:Ump Ire", crew)


class Validation(unittest.TestCase):
    def test_candidates_have_an_ncaa_referee_one_per_referee_nearest_the_gap(self):
        self.assertTrue(all(c["referee_source"] in M.NCAA_SOURCES and not c["assignment_conflict"] for c in CANDS))
        self.assertEqual(len({c["referee_id"] for c in CANDS}), len(CANDS))
        self.assertFalse({c["game_id"] for c in CANDS} & MISSING_IDS)
        self.assertEqual(CANDS[0]["season"], 2026)
        # 2026 Week 7 (the gap) has no NCAA referee at all, so the nearest weeks come first
        self.assertEqual(abs(CANDS[0]["week"] - 7), min(abs(c["week"] - 7) for c in CANDS if c["season"] == 2026))

    def test_five_matches_pass(self):
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(), MISSING_IDS)
        self.assertTrue(ok, why)
        self.assertEqual([r["result"] for r in rep], ["match"] * 5)

    def test_missing_officials_are_inconclusive_and_another_game_is_read(self):
        o = {CANDS[0]["game_id"]: summ(officials=[("Umpire", "Ump Ire")]),
             CANDS[1]["game_id"]: RuntimeError("ESPN request failed"),
             CANDS[2]["game_id"]: None}
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(o), MISSING_IDS)
        self.assertTrue(ok, why)
        self.assertEqual([r["result"] for r in rep],
                         ["inconclusive_no_referee_listed", "inconclusive_fetch_failed", "inconclusive_fetch_failed"] + ["match"] * 5)

    def test_a_mismatch_stops_the_check(self):
        o = {CANDS[2]["game_id"]: ref_summary("Totally Different Person")}
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(o), MISSING_IDS)
        self.assertFalse(ok)
        self.assertIn("mismatch", why)
        self.assertEqual([r["result"] for r in rep], ["match", "match", "mismatch"])

    def test_a_known_different_referee_is_a_mismatch_not_a_spelling(self):
        c = next(c for c in CANDS if c["referee_id"] == "jonnoli") if any(c["referee_id"] == "jonnoli" for c in CANDS) else None
        if c is None:
            self.skipTest("jonnoli is not a validation candidate")
        cands = M.validation_candidates(ROWS, MISSING_IDS)
        o = {c["game_id"]: ref_summary("Jonathan Noli")}
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(o), MISSING_IDS, max_tries=cands.index(c) + 1, need=99)
        self.assertFalse(ok)
        self.assertEqual(rep[-1]["result"], "mismatch")

    def test_spelling_allowed(self):
        o = {CANDS[0]["game_id"]: ref_summary(CANDS[0]["referee"].upper() + " Jr.")}
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(o), MISSING_IDS)
        self.assertTrue(ok, why)
        self.assertEqual(rep[0]["result"], "match")

    def test_fewer_than_five_verifiable_stops(self):
        o = {c["game_id"]: summ() for c in CANDS[3:12]}
        ok, why, rep = M.validate(ROWS, REFS, ncaa_fetch(o), MISSING_IDS, max_tries=12)
        self.assertFalse(ok)
        self.assertIn("only 3 of 5", why)


class Backfill(unittest.TestCase):
    def test_fills_skips_and_logs(self):
        busy = {(r["referee_id"], M.day_of(r["start_date"])) for r in ROWS if r["referee_id"]}
        free = lambda m, rid: (rid, M.day_of(m["start_date"])) not in busy  # noqa: E731
        open_ = [m for m in MISSING if m["assignment_conflict"] == "False"
                 and free(m, "jerrymagallanes") and free(m, "jeffservinski")]
        conflict = [m for m in MISSING if m["assignment_conflict"] == "True"]
        seen = []
        g_exact, g_variant, g_none, g_amb, g_new = (int(m["game_id"]) for m in open_[:5])

        def fetch(gid):
            seen.append(gid)
            return {g_exact: ref_summary("Jerry Magallanes"), g_variant: ref_summary("Jeffrey Servinski"),
                    g_none: summ(officials=[("Umpire", "Ump Ire")]), g_amb: ref_summary("Jonathon Noli"),
                    g_new: ref_summary("Brand New Official")}.get(gid, summ())
        fills, log = M.backfill(ROWS, REFS, fetch, MISSING)
        out = {e["game_id"]: e for e in log}
        self.assertEqual(len(log), len(MISSING))
        self.assertTrue(all(out[int(m["game_id"])]["outcome"] == "assignment_conflict_left_alone" for m in conflict))
        self.assertFalse({int(m["game_id"]) for m in conflict} & set(seen), "a conflict game is not even fetched")
        f = {x["game_id"]: x for x in fills}
        self.assertEqual((f[g_exact]["referee_id"], f[g_exact]["name_match"]), ("jerrymagallanes", "exact"))
        self.assertEqual(f[g_exact]["referee_primary_conf"], "ACC")
        self.assertEqual(f[g_variant]["referee_id"], "jeffservinski")
        self.assertEqual(f[g_variant]["referee"], REFS.name["jeffservinski"], "the dataset's spelling, not ESPN's")
        self.assertEqual(f[g_variant]["name_match"], "alias")
        self.assertEqual(f[g_variant]["referee_source"], "espn")
        self.assertEqual(f[g_variant]["referee_identity"], "espn_referee_role")
        self.assertEqual(out[g_none]["outcome"], "no_referee_listed")
        self.assertEqual(out[g_amb]["outcome"], "ambiguous_name")
        self.assertNotIn(g_amb, f)
        self.assertEqual(f[g_new]["referee_id"], "brandnewofficial")
        self.assertEqual(f[g_new]["referee_primary_conf"], "")

    def test_same_day_double_listing_is_not_filled(self):
        m, r = next((m, r) for m in MISSING if m["assignment_conflict"] == "False"
                    for r in ROWS if r["referee_id"] and M.day_of(r["start_date"]) == M.day_of(m["start_date"]))
        fills, log = M.backfill(ROWS, REFS, lambda gid: ref_summary(r["referee"]), [m])
        self.assertEqual(fills, [])
        self.assertEqual(log[0]["outcome"], "same_day_conflict")

    def test_coverage(self):
        open1 = next(m for m in MISSING if m["assignment_conflict"] == "False" and m["season"] == "2026")
        cov = {c["season"]: c for c in M.coverage(ROWS, [dict(game_id=open1["game_id"])])}
        self.assertEqual((cov[2024]["games"], cov[2025]["games"], cov[2026]["games"]), (919, 934, 513))
        self.assertEqual(cov[2026]["with_referee_after"], cov[2026]["with_referee_before"] + 1)
        self.assertEqual(sum(c["with_referee_before"] for c in cov.values()), 2242)

    def test_command_writes_the_report_and_stops_on_a_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            M.OUT = Path(d)
            real = M.summary_for
            try:
                M.summary_for = lambda gid, completed=True: ncaa_fetch()(gid) if gid not in MISSING_IDS else ref_summary("Jerry Magallanes")
                with contextlib.redirect_stdout(io.StringIO()):
                    rc = M.cmd_backfill(type("A", (), {"write_db": False})())
                self.assertEqual(rc, 0)
                for f in ("espn_validation.csv", "espn_backfill.csv", "espn_backfill_log.csv", "coverage_by_season.csv"):
                    self.assertTrue((Path(d) / f).exists(), f)
                self.assertFalse((Path(d) / "STOPPED.md").exists())
                M.summary_for = lambda gid, completed=True: ref_summary("Totally Different Person")
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    rc = M.cmd_backfill(type("A", (), {"write_db": False})())
                self.assertEqual(rc, 2)
                self.assertIn("STOPPED", out.getvalue())
                self.assertTrue((Path(d) / "STOPPED.md").exists())
                self.assertFalse((Path(d) / "espn_backfill.csv").exists(), "a failed check leaves no fills behind")
            finally:
                M.summary_for = real
                M.OUT = M.DATA / "backfill"


def play(text, ptype="Rush", pos=None):
    p = {"text": text, "type": {"text": ptype}}
    if pos:
        p["start"] = {"team": {"id": pos}}
    return p


class Plays(unittest.TestCase):
    def test_penalty_team(self):
        teams = M._teams(summ())
        self.assertEqual(M.penalty_team("PENALTY UGA Holding (J. Smith) 10 yards", teams), "61")
        self.assertEqual(M.penalty_team("Alabama Penalty, Offensive Holding (J. Smith) to the ALA 20", teams), "333")
        self.assertEqual(M.penalty_team("J. Doe run for 5 yds, PENALTY ALA pass interference", teams), "333")
        self.assertIsNone(M.penalty_team("J. Doe run for 5 yds", teams))

    def test_holding_and_pi_by_possession(self):
        drives = [{"team": {"id": "61"}, "plays": [
            play("Kickoff by X", "Kickoff"),
            play("PENALTY UGA Holding (J. Smith) 10 yards from UGA35 to UGA25. NO PLAY.", "Penalty"),        # offense
            play("PENALTY ALA Holding (K. Lee) 5 yards, automatic first down", "Penalty"),                   # defense
            play("PENALTY ALA Defensive Holding (K. Lee) declined", "Penalty"),                              # declined
            play("Pass complete, PENALTY ALA Pass Interference (K. Lee) 15 yards", "Pass Reception"),       # DPI
            play("PENALTY UGA Offensive Pass Interference (T. Ray) 15 yards", "Penalty"),                     # OPI
            play("PENALTY UGA False Start (O. Line) 5 yards", "Penalty"),
            play("Team Penalty, Holding, offsetting", "Penalty"),                                              # offsetting
            play("PENALTY Holding (somebody) 10 yards", "Penalty"),                                            # side unknown
            play("Timeout Georgia", "Timeout"),
            play("Punt by Y", "Punt"),
        ]}, {"team": {"id": "333"}, "plays": [
            play("Alabama Penalty, Defensive Holding (Q. R.) to the UGA 30", "Penalty", pos="333"),           # text says def
            play("J. Run for 4 yds", "Rush", pos="333"),
        ]}]
        c = M.parse_plays(summ(drives=drives))
        self.assertEqual(c["holding_total"], 4)
        self.assertEqual((c["off_holding"], c["def_holding"], c["holding_side_unknown"]), (1, 2, 1))
        self.assertEqual((c["dpi"], c["opi"], c["false_start"]), (1, 1, 1))
        self.assertEqual(c["scrimmage_plays"], 10)
        self.assertTrue(c["pbp_available"])

    def test_no_play_by_play(self):
        c = M.parse_plays(summ())
        self.assertFalse(c["pbp_available"])
        self.assertIsNone(c["holding_total"])


class Weekly(unittest.TestCase):
    def ev(self, completed=True, state="post"):
        return {"id": "401999001", "date": "2026-10-24T19:30Z",
                "status": {"type": {"completed": completed, "state": state}},
                "competitions": [{"date": "2026-10-24T19:30Z", "neutralSite": False, "competitors": [
                    {"homeAway": "home", "score": "31", "team": {"id": "61", "location": "Georgia", "conferenceId": "8"}},
                    {"homeAway": "away", "score": "17", "team": {"id": "333", "location": "Alabama", "conferenceId": "8"}}]}]}

    def test_final_row_from_cfb_games(self):
        s = summ(officials=[("Referee", "Jeffrey Servinski")], box={"61": "7-55", "333": "5-40"},
                 drives=[{"team": {"id": "61"}, "plays": [play("PENALTY UGA Holding (A) 10 yards", "Penalty")]}])
        game = {"season": 2026, "week": 9, "start_date": "2026-10-24T19:30:00+00:00", "neutral_site": False,
                "home_team": "Georgia", "away_team": "Alabama", "home_conference": "SEC", "away_conference": "SEC",
                "home_points": 31, "away_points": 17}
        row, note = M.final_row(self.ev(), s, REFS, game, 2026, 9)
        self.assertEqual((row["game_id"], row["season"], row["week"]), (401999001, 2026, 9))
        self.assertEqual((row["flags"], row["penalty_yards"], row["home_flags"], row["away_flags"]), (12, 95, 7, 5))
        self.assertEqual((row["holding_total"], row["off_holding"]), (1, 1))
        self.assertEqual((row["referee_id"], row["referee"]), ("jeffservinski", REFS.name["jeffservinski"]))
        self.assertEqual(note["name_match"], "alias")
        self.assertEqual(row["home_conference"], "SEC")
        self.assertNotIn("referee_primary_conf", row, "the database sets the conference from the dataset mapping")

    def test_final_row_without_cfb_games_uses_espn(self):
        row, _ = M.final_row(self.ev(), summ(box={"61": "3-30", "333": "4-35"}), REFS, None, 2026, 9)
        self.assertEqual((row["home_team"], row["home_conference"], row["home_points"]), ("Georgia", "SEC", 31))
        self.assertIsNone(row["referee_id"])

    def test_finals_week(self):
        real = M.current_week
        try:
            M.current_week = lambda s, w: (2026, 9, {"events": [self.ev(completed=False, state="pre")]})
            self.assertEqual(M.finals_week(), (2026, 8))
            M.current_week = lambda s, w: (2026, 8, {"events": [self.ev()]})
            self.assertEqual(M.finals_week(), (2026, 8))
            self.assertEqual(M.finals_week(2025, 3), (2025, 3))
        finally:
            M.current_week = real

    def test_seed_rows_are_json_safe(self):
        r = ROWS[0]
        self.assertIsInstance(r["home_points"], int)
        self.assertIsInstance(r["holding_total"], int)
        self.assertIsInstance(r["neutral_site"], bool)
        self.assertEqual(len(ROWS), 2366)
        nopbp = next(r for r in ROWS if r["pbp_available"] is False)
        self.assertIsNone(nopbp["holding_total"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
