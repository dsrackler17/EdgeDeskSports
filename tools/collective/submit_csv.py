#!/usr/bin/env python3
"""Send a slate CSV to the Model Collective.

Standard library only. No install, no dependencies, runs anywhere Python does.

    set COLLECTIVE_KEY=mck_live_...                  (PowerShell: $env:COLLECTIVE_KEY="...")
    python tools/collective/submit_csv.py picks.csv                 # dry run, stores nothing
    python tools/collective/submit_csv.py picks.csv --live          # actually submit

WHY THIS EXISTS

A slate CSV usually writes the pick as one human string:

    away,home,pick
    NE,SEA,NE +3.5

That string carries TWO facts — the side and the number — and a mapping that
keeps only the side produces a submission the Collective renders as "NE -":
a pick with no number attached. It is graded, but it shows nothing, and
cover probability and CLV have nothing to work from. This parses both.

HOME CONVENTION

line_at_submission is always the HOME team's number, whichever side was
picked. "NE +3.5" with NE away means the home line is -3.5. Getting this
backwards inverts every line on the board while still looking plausible, so
the sign flip happens in exactly one place below and is covered by tests.

WHAT IS SENT

Only finished numbers: the game reference, the teams, the kickoff, the side,
and the line. No source, no weights, no intermediate data. Whatever your model
does to arrive at a pick stays in your project.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = os.environ.get(
    "COLLECTIVE_API",
    "https://iattxbkbufslbauoumga.supabase.co/functions/v1",
)
DRY_RUN = f"{API_BASE}/collective_ingest/v1/projections/dry-run"
LIVE = f"{API_BASE}/collective_ingest/v1/projections"

# Column names seen in the wild, lowercased. The first match wins.
COLUMNS = {
    "game_ref": ["game_id", "game_ref", "gameid", "id", "ref"],
    "home": ["home", "home_team", "hometeam", "h"],
    "away": ["away", "away_team", "awayteam", "a"],
    "kickoff": ["kickoff", "date", "datetime", "start", "commence_time", "game_time"],
    "pick": ["pick", "selection", "side", "bet"],
    "spread": ["projected_spread", "proj_spread", "spread", "model_spread"],
    "total": ["projected_total", "proj_total", "total", "model_total"],
    "home_wp": ["home_win_probability", "home_win_prob", "home_wp", "hwp"],
    "cover_prob": ["cover_probability", "cover_prob", "cover"],
    "line": ["line_at_submission", "line", "market_line", "closing_line"],
    "confidence": ["confidence", "conf", "units"],
}

# "NE +3.5" / "LA -3.5" / "BUF PK" / "CHI -2.5" / "PHI PICK"
PICK_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9 .'-]*?)\s+(pk|pick|even|[+-]?\d+(?:\.\d+)?)\s*$",
    re.IGNORECASE,
)


class Problem(Exception):
    pass


def resolve_columns(header: list[str]) -> dict[str, str | None]:
    lower = {h.strip().lower(): h for h in header}
    out: dict[str, str | None] = {}
    for field, names in COLUMNS.items():
        out[field] = next((lower[n] for n in names if n in lower), None)
    return out


def parse_pick(raw: str, home: str, away: str) -> tuple[str | None, float | None]:
    """A pick string -> (pick_side, home-convention line).

    Returns (None, None) for an empty cell rather than raising: a model that
    skips a game is not an error, and inventing a side for it would be worse
    than sending nothing.
    """
    text = (raw or "").strip()
    if not text:
        return None, None

    m = PICK_RE.match(text)
    if m:
        team_raw, num_raw = m.group(1).strip(), m.group(2).strip().lower()
        number = 0.0 if num_raw in ("pk", "pick", "even") else float(num_raw)
    else:
        # A bare team code with no number is still a usable pick.
        team_raw, number = text, None

    side = side_of(team_raw, home, away)
    if side is None:
        raise Problem(
            f'pick "{text}" names "{team_raw}", which is neither {away} (away) nor {home} (home)'
        )
    if number is None:
        return side, None

    # THE sign flip, in one place. The stored line is the HOME team's number,
    # so a number quoted for the away team is negated and one quoted for the
    # home team is kept as written.
    line = -number if side == "away" else number
    return side, (0.0 if line == 0 else line)  # negating zero yields -0.0


def side_of(team: str, home: str, away: str) -> str | None:
    def key(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    t, h, a = key(team), key(home), key(away)
    if not t:
        return None
    if t == h:
        return "home"
    if t == a:
        return "away"
    # A full name against a code, or the reverse. Require 3 characters so a
    # two-letter code cannot match half the league.
    if len(t) >= 3 and len(h) >= 3 and (h.startswith(t) or t.startswith(h)):
        home_hit = True
    else:
        home_hit = False
    if len(t) >= 3 and len(a) >= 3 and (a.startswith(t) or t.startswith(a)):
        away_hit = True
    else:
        away_hit = False
    if home_hit and not away_hit:
        return "home"
    if away_hit and not home_hit:
        return "away"
    return None


def parse_kickoff(raw: str) -> str:
    """A date or datetime -> ISO 8601 UTC.

    A bare date is read as 13:00 US Eastern, the earliest NFL kickoff slot.
    That is a stated assumption, not a guess dressed as data: the Collective
    matches on the calendar day, and a bare date carries no time to use.
    """
    text = (raw or "").strip()
    if not text:
        raise Problem("kickoff is empty")
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise Problem(f'kickoff "{text}" is not a date or ISO timestamp') from None
    if dt.tzinfo is None:
        if dt.hour == 0 and dt.minute == 0:
            dt = dt.replace(hour=17)  # 13:00 ET in UTC during the season
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def number(raw: str | None) -> float | None:
    if raw is None:
        return None
    text = raw.strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def build_rows(path: Path) -> tuple[list[dict], list[str]]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise SystemExit(f"{path} has no header row")
        col = resolve_columns(list(reader.fieldnames))
        missing = [f for f in ("home", "away", "kickoff") if not col[f]]
        if missing:
            raise SystemExit(
                f"{path} is missing a column for: {', '.join(missing)}\n"
                f"  columns found: {', '.join(reader.fieldnames)}"
            )

        rows: list[dict] = []
        problems: list[str] = []
        for n, raw in enumerate(reader, start=2):
            home = (raw.get(col["home"]) or "").strip()
            away = (raw.get(col["away"]) or "").strip()
            if not home or not away:
                problems.append(f"line {n}: home or away is empty, skipped")
                continue
            try:
                kickoff = parse_kickoff(raw.get(col["kickoff"]) or "")
                side, line = (None, None)
                if col["pick"]:
                    side, line = parse_pick(raw.get(col["pick"]) or "", home, away)
            except Problem as e:
                problems.append(f"line {n}: {e}")
                continue

            ref = (raw.get(col["game_ref"]) or "").strip() if col["game_ref"] else ""
            row: dict = {
                "game_ref": ref or f"{kickoff[:10]}_{away}_{home}",
                "home_team": home,
                "away_team": away,
                "kickoff": kickoff,
            }
            if side:
                row["pick_side"] = side
            # An explicit line column wins over one parsed out of the pick.
            explicit = number(raw.get(col["line"])) if col["line"] else None
            if explicit is not None:
                row["line_at_submission"] = explicit
            elif line is not None:
                row["line_at_submission"] = line

            for field, key in (
                ("spread", "projected_spread"),
                ("total", "projected_total"),
                ("home_wp", "home_win_probability"),
                ("cover_prob", "cover_probability"),
                ("confidence", "confidence"),
            ):
                if col[field]:
                    v = number(raw.get(col[field]))
                    if v is not None:
                        row[key] = v
            rows.append(row)
    return rows, problems


def post(url: str, payload: dict, key: str) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-collective-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except urllib.error.URLError as e:
        raise SystemExit(f"could not reach {url}: {e.reason}") from None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path)
    ap.add_argument("--live", action="store_true",
                    help="actually submit. Without it, nothing is stored.")
    ap.add_argument("--model", help="model slug, if the key has more than one")
    ap.add_argument("--print", dest="show", action="store_true",
                    help="print the envelope and send nothing")
    args = ap.parse_args()

    rows, problems = build_rows(args.csv)
    for p in problems:
        print(f"  skipped  {p}", file=sys.stderr)
    if not rows:
        raise SystemExit("no usable rows")

    with_line = sum(1 for r in rows if "line_at_submission" in r)
    with_side = sum(1 for r in rows if "pick_side" in r)
    # Commentary on stderr so --print emits nothing but the envelope, and the
    # output can be piped into jq or a file without hand-editing it first.
    print(f"{len(rows)} games, {with_side} with a side, {with_line} with a line",
          file=sys.stderr)
    if with_side and with_line < with_side:
        print(
            f"  note: {with_side - with_line} pick(s) carry no number. Those render as "
            f'"TEAM -" on the wall and cannot produce cover probability or CLV.',
            file=sys.stderr,
        )

    envelope: dict = {"rows": rows}
    if args.model:
        envelope["model"] = args.model

    if args.show:
        print(json.dumps(envelope, indent=2))
        return 0

    key = os.environ.get("COLLECTIVE_KEY", "").strip()
    if not key:
        raise SystemExit(
            "COLLECTIVE_KEY is not set.\n"
            '  PowerShell: $env:COLLECTIVE_KEY="mck_live_..."\n'
            "  bash:       export COLLECTIVE_KEY=mck_live_..."
        )

    url = LIVE if args.live else DRY_RUN
    print(f"POST {url}  ({'LIVE' if args.live else 'dry run, stores nothing'})")
    status, body = post(url, envelope, key)
    try:
        print(json.dumps(json.loads(body), indent=2))
    except json.JSONDecodeError:
        print(body)
    if status >= 300:
        print(f"\nHTTP {status}", file=sys.stderr)
        return 1
    if not args.live:
        print("\nDry run only. Nothing was stored. Re-run with --live to submit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
