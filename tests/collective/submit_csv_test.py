#!/usr/bin/env python3
"""Tests for the slate CSV mapper.

    python3 tests/collective/submit_csv_test.py

The sign flip is the reason this file exists. A line stored for the wrong side
inverts every game on the board and still looks entirely plausible: -3.5 and
+3.5 are both real numbers, both render fine, and the error only surfaces
months later as a record that grades backwards.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "collective"))
import submit_csv as M  # noqa: E402

passed = 0
failed = 0


def check(label, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"pass: {label}")
    except AssertionError as e:
        failed += 1
        print(f"FAIL: {label}\n      {e}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        failed += 1
        print(f"FAIL: {label}\n      {type(e).__name__}: {e}", file=sys.stderr)


# ------------------------------------------------------------ the sign flip

def t_away_pick_negates():
    # "NE +3.5" with NE away means the HOME team is laying 3.5.
    assert M.parse_pick("NE +3.5", home="SEA", away="NE") == ("away", -3.5)


def t_home_pick_keeps():
    # "LA -3.5" with LA home is already the home number.
    assert M.parse_pick("LA -3.5", home="LA", away="SF") == ("home", -3.5)


def t_away_favourite_flips_to_home_dog():
    # "CHI -2.5" with CHI away means home CAR is +2.5.
    assert M.parse_pick("CHI -2.5", home="CAR", away="CHI") == ("away", 2.5)


def t_home_dog_stays_positive():
    assert M.parse_pick("IND +3.5", home="IND", away="BAL") == ("home", 3.5)


def t_pickem_is_zero_not_missing():
    # PK is a real number. Dropped, the pick renders with no line at all.
    for word in ("PK", "pk", "PICK", "even"):
        assert M.parse_pick(f"BUF {word}", home="HOU", away="BUF") == ("away", 0.0), word


def t_whole_numbers():
    assert M.parse_pick("ATL +3", home="PIT", away="ATL") == ("away", -3.0)
    assert M.parse_pick("NO +7", home="DET", away="NO") == ("away", -7.0)


# --------------------------------------------------------- side resolution

def t_full_name_resolves_against_a_code():
    # A CSV that writes full names against a schedule that uses codes.
    assert M.side_of("Cincinnati Bengals", "CIN", "TB") == "home"
    assert M.side_of("Seattle Seahawks", "SEA", "NE") == "home"
    assert M.parse_pick("Cincinnati Bengals -3.5", home="CIN", away="TB") == ("home", -3.5)


def t_ambiguous_name_is_refused_rather_than_guessed():
    # If a name could be either side, no answer beats a coin flip: the wrong
    # one inverts the market and still looks perfectly reasonable.
    assert M.side_of("New", "New England", "New Orleans") is None


def t_exact_codes_win():
    assert M.side_of("SEA", "SEA", "NE") == "home"
    assert M.side_of("NE", "SEA", "NE") == "away"


def t_short_code_cannot_match_by_prefix():
    # NE at NO: a 2-character code must match exactly or not at all, or the
    # away price gets booked as the home price and the market silently inverts.
    assert M.side_of("NE", "NO", "NE") == "away"
    assert M.side_of("NO", "NO", "NE") == "home"


def t_unknown_team_is_refused_not_guessed():
    try:
        M.parse_pick("Nowhere United -3", home="SEA", away="NE")
    except M.Problem as e:
        assert "neither" in str(e)
        return
    raise AssertionError("expected a Problem for an unrecognised team")


def t_empty_pick_is_not_an_error():
    # A model that skips a game is not broken. Inventing a side would be worse.
    assert M.parse_pick("", home="SEA", away="NE") == (None, None)
    assert M.parse_pick("   ", home="SEA", away="NE") == (None, None)


def t_bare_team_keeps_the_side():
    assert M.parse_pick("NE", home="SEA", away="NE") == ("away", None)


# ------------------------------------------------------------------ kickoff

def t_iso_passthrough():
    assert M.parse_kickoff("2026-09-13T17:00:00Z") == "2026-09-13T17:00:00Z"


def t_bare_date_gets_a_stated_default():
    assert M.parse_kickoff("2026-09-13") == "2026-09-13T17:00:00Z"


def t_explicit_midnight_is_not_overwritten_silently():
    # A bare date and an explicit 00:00 are indistinguishable in a CSV, so the
    # default applies to both. Pinned so the behaviour is a decision, not a
    # surprise.
    assert M.parse_kickoff("2026-09-13T00:00:00") == "2026-09-13T17:00:00Z"


def t_bad_date_is_refused():
    try:
        M.parse_kickoff("week one")
    except M.Problem:
        return
    raise AssertionError("expected a Problem for an unparseable date")


# ------------------------------------------------------------- whole files

MOOSE = """date,game_id,season,week,away,home,pick
2026-09-09,2026_01_NE_SEA,2026,1,NE,SEA,NE +3.5
2026-09-13,2026_01_BAL_IND,2026,1,BAL,IND,IND +3.5
2026-09-13,2026_01_BUF_HOU,2026,1,BUF,HOU,BUF PK
2026-09-13,2026_01_CHI_CAR,2026,1,CHI,CAR,CHI -2.5
"""


def with_csv(text, fn):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "s.csv"
        p.write_text(text, encoding="utf-8")
        return fn(p)


def t_real_slate_maps_every_row():
    rows, problems = with_csv(MOOSE, M.build_rows)
    assert problems == [], problems
    assert len(rows) == 4
    assert all("pick_side" in r for r in rows), "every row had a pick"
    assert all("line_at_submission" in r for r in rows), "every row had a number"


def t_lines_match_home_convention():
    rows, _ = with_csv(MOOSE, M.build_rows)
    by = {r["game_ref"]: r for r in rows}
    assert by["2026_01_NE_SEA"]["line_at_submission"] == -3.5
    assert by["2026_01_BAL_IND"]["line_at_submission"] == 3.5
    assert by["2026_01_CHI_CAR"]["line_at_submission"] == 2.5
    assert by["2026_01_BUF_HOU"]["line_at_submission"] == 0


def t_no_proprietary_fields_are_sent():
    # Only finished numbers leave the creator's project.
    allowed = {
        "game_ref", "home_team", "away_team", "kickoff", "pick_side",
        "line_at_submission", "projected_spread", "projected_total",
        "home_win_probability", "cover_probability", "confidence",
    }
    rows, _ = with_csv(MOOSE, M.build_rows)
    for r in rows:
        extra = set(r) - allowed
        assert not extra, f"unexpected field(s) would be sent: {extra}"


def t_game_ref_is_synthesised_when_absent():
    rows, _ = with_csv("away,home,date,pick\nNE,SEA,2026-09-09,NE +3.5\n", M.build_rows)
    assert rows[0]["game_ref"] == "2026-09-09_NE_SEA"


def t_missing_required_column_fails_loudly():
    try:
        with_csv("away,pick\nNE,NE +3.5\n", M.build_rows)
    except SystemExit as e:
        assert "home" in str(e) and "kickoff" in str(e)
        return
    raise AssertionError("expected a SystemExit naming the missing columns")


def t_a_bad_row_is_skipped_not_fatal():
    rows, problems = with_csv(
        MOOSE + "2026-09-13,2026_01_X_Y,2026,1,XXX,YYY,Nowhere -3\n", M.build_rows)
    assert len(rows) == 4, "the good rows still went through"
    assert len(problems) == 1 and "neither" in problems[0]


def t_explicit_line_column_wins_over_the_parsed_one():
    rows, _ = with_csv(
        "away,home,date,pick,line_at_submission\nNE,SEA,2026-09-09,NE +3.5,-4.0\n",
        M.build_rows)
    assert rows[0]["line_at_submission"] == -4.0


def t_optional_numbers_ride_along_when_present():
    rows, _ = with_csv(
        "away,home,date,pick,projected_total,home_win_probability\n"
        "NE,SEA,2026-09-09,NE +3.5,44.5,0.63\n", M.build_rows)
    assert rows[0]["projected_total"] == 44.5
    assert rows[0]["home_win_probability"] == 0.63


def t_blank_optional_cells_are_omitted_not_zeroed():
    # A zero total is a claim. An empty cell is not.
    rows, _ = with_csv(
        "away,home,date,pick,projected_total\nNE,SEA,2026-09-09,NE +3.5,\n", M.build_rows)
    assert "projected_total" not in rows[0]


def t_bom_and_odd_headers_survive():
    rows, _ = with_csv("﻿Away,Home,Date,Pick\nNE,SEA,2026-09-09,NE +3.5\n", M.build_rows)
    assert rows[0]["away_team"] == "NE"
    assert rows[0]["line_at_submission"] == -3.5


for name, fn in sorted((k, v) for k, v in list(globals().items()) if k.startswith("t_")):
    check(name[2:].replace("_", " "), fn)

print(f"\n{passed} checks passed")
if failed:
    print(f"{failed} FAILED", file=sys.stderr)
    sys.exit(1)
print("ALL CSV MAPPER TESTS PASSED")
