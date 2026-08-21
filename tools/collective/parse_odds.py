#!/usr/bin/env python3
"""Parse a saved NFL odds page into Collective market snapshot rows.

Input is the page's rendered text (copy the odds page, paste to a file).
Output is JSON ready for collective.record_market_snapshots.

The parser is structural, not positional: it keys off the time-of-day line
that starts every game and the "@" that separates away from home, so a
layout change shows up as a validation failure rather than a wrong number.

Usage:
  python3 parse_odds.py page.txt --season 2026 > rows.json
  python3 parse_odds.py page.txt --season 2026 --check     # validate only
"""
import argparse, json, re, sys
from datetime import datetime
from zoneinfo import ZoneInfo

SKIP = {"nfl odds", "spread", "total", "moneyline", "more odds", "see all games"}
TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*(AM|PM)\s+([A-Z]{2,4})$", re.I)
DATE_RE = re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Z][a-z]+)\s+(\d{1,2})$")
NUM_RE  = re.compile(r"^[+-]?\d+(\.\d+)?$")
TOT_RE  = re.compile(r"^([OU])\s+(\d+(\.\d+)?)$")
# The page prints local US times; the Collective stores UTC.
ZONES = {"CDT": "America/Chicago", "CST": "America/Chicago",
         "EDT": "America/New_York", "EST": "America/New_York",
         "PDT": "America/Los_Angeles", "PST": "America/Los_Angeles",
         "MDT": "America/Denver", "MST": "America/Denver"}


def parse(text, season, book, source, captured_at):
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if l and l.lower() not in SKIP]
    rows, problems = [], []
    cur_date = None
    i = 0
    while i < len(lines):
        line = lines[i]

        m = DATE_RE.match(line)
        if m:
            weekday, month, day = m.group(1), m.group(2), int(m.group(3))
            try:
                d = datetime.strptime(f"{month} {day} {season}", "%B %d %Y")
            except ValueError:
                problems.append(f"unreadable date: {line}")
                cur_date = None
                i += 1
                continue
            # The weekday is a free checksum on the season year.
            if d.strftime("%A") != weekday:
                problems.append(
                    f"{line} is a {d.strftime('%A')} in {season}, not a {weekday}: wrong season?")
            cur_date = d
            i += 1
            continue

        t = TIME_RE.match(line)
        if not t:
            i += 1
            continue
        if cur_date is None:
            problems.append(f"game at {line} has no date header above it")
            i += 1
            continue

        block, j = [], i + 1
        while j < len(lines) and not TIME_RE.match(lines[j]) and not DATE_RE.match(lines[j]):
            block.append(lines[j])
            j += 1

        row = _game(block, t, cur_date, season, book, source, captured_at, problems)
        if row:
            rows.append(row)
        i = j
    return rows, problems


def _game(block, t, cur_date, season, book, source, captured_at, problems):
    away = block[0] if block else None
    home = None
    for b in block[1:]:
        if b.startswith("@"):
            home = b.lstrip("@").strip()
            break
    if not away or not home:
        problems.append(f"could not read teams from block starting {block[:2]}")
        return None

    nums = [b for b in block if NUM_RE.match(b) or TOT_RE.match(b)]
    if len(nums) < 4:
        problems.append(f"{away} @ {home}: only {len(nums)} numbers, expected at least 4")
        return None

    try:
        away_line, away_price = float(nums[0]), int(float(nums[1]))
        home_line, home_price = float(nums[2]), int(float(nums[3]))
    except ValueError:
        problems.append(f"{away} @ {home}: unreadable spread numbers {nums[:4]}")
        return None

    # A spread pair that does not mirror means the columns moved.
    if abs(home_line + away_line) > 1e-9:
        problems.append(f"{away} @ {home}: spreads {away_line}/{home_line} do not mirror")
        return None
    for p in (away_price, home_price):
        if not (-10000 <= p <= 10000) or abs(p) < 100:
            problems.append(f"{away} @ {home}: implausible price {p}")
            return None

    # Moneyline is the last pair in the block: away then home.
    home_ml = away_ml = None
    if len(nums) >= 10:
        try:
            a_ml, h_ml = int(float(nums[8])), int(float(nums[9]))
            if all(abs(x) >= 100 and abs(x) <= 10000 for x in (a_ml, h_ml)):
                away_ml, home_ml = a_ml, h_ml
            else:
                problems.append(f"{away} @ {home}: implausible moneyline {a_ml}/{h_ml}, skipped")
        except ValueError:
            problems.append(f"{away} @ {home}: unreadable moneyline, skipped")

    total_line = over_price = under_price = None
    tot = [b for b in block if TOT_RE.match(b)]
    if len(tot) >= 2:
        o, u = TOT_RE.match(tot[0]), TOT_RE.match(tot[1])
        if o and u and o.group(2) == u.group(2):
            total_line = float(o.group(2))
            k = nums.index(tot[0])
            try:
                over_price = int(float(nums[k + 1]))
                under_price = int(float(nums[nums.index(tot[1]) + 1]))
            except (IndexError, ValueError):
                over_price = under_price = None

    hh, mm, ampm, tz = int(t.group(1)), int(t.group(2)), t.group(3).upper(), t.group(4).upper()
    if ampm == "PM" and hh != 12:
        hh += 12
    if ampm == "AM" and hh == 12:
        hh = 0
    zone = ZONES.get(tz)
    if not zone:
        problems.append(f"{away} @ {home}: unknown timezone {tz}")
        return None
    local = cur_date.replace(hour=hh, minute=mm, tzinfo=ZoneInfo(zone))
    kickoff = local.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "sport": "NFL", "season": season, "market": "spread",
        "home_team": home, "away_team": away, "kickoff": kickoff,
        "book": book, "source": source, "captured_at": captured_at,
        "home_line": home_line, "home_price": home_price,
        "away_line": away_line, "away_price": away_price,
        "total_line": total_line, "over_price": over_price, "under_price": under_price,
        "home_ml_price": home_ml, "away_ml_price": away_ml,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--book", default="oddschecker_featured",
                    help="the page shows one featured price and does not name the book")
    ap.add_argument("--source", default="oddschecker")
    ap.add_argument("--captured-at", default=None,
                    help="ISO timestamp of the capture, defaults to now in UTC")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()

    captured = a.captured_at or datetime.now(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, problems = parse(open(a.file).read(), a.season, a.book, a.source, captured)

    if a.check:
        print(f"parsed {len(rows)} games, {len(problems)} problems")
        for p in problems[:20]:
            print("  PROBLEM:", p)
        for r in rows[:3]:
            print(f"  {r['away_team']} {r['away_line']:+g} @ {r['home_team']} {r['home_line']:+g}"
                  f"  kickoff {r['kickoff']}")
        return 1 if problems else 0

    if problems:
        print(json.dumps({"problems": problems}), file=sys.stderr)
    print(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
