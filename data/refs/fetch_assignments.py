#!/usr/bin/env python3
"""Pull the coming NFL week's referee assignments into manual_assignments.json.

The NFL announces each week's crew chiefs on Wednesday or Thursday and Football
Zebras publishes them in a "Week N referee assignments" post. nflverse fills its
own `referee` column weeks later. This script reads Football Zebras' RSS feeds,
finds the post for the week whose games have not been played, matches every
game of that week by its two teams, and writes the referees into the week's
block of manual_assignments.json (source "footballzebras"), which
build_ref_data.py, the Tuesday ref sync and tools/football/game_context.js
already read. nflverse still wins whenever it has a name.

  python3 data/refs/fetch_assignments.py --games games.csv            # the coming week
  python3 data/refs/fetch_assignments.py --games games.csv --week 8   # a given week
  python3 data/refs/fetch_assignments.py --games games.csv --feed FILE.xml --dry-run

THE RULES
  * A referee is written only for a game whose two teams appear together in the
    post, and only as a name the post ties to that game: a referee already on
    file in data/refs (a known crew chief), a name labelled "Referee", or a name
    standing alone after the matchup. Anything else is left unassigned.
  * A game nflverse or the file already assigns is never overwritten.
  * Nothing found is not an error (the post may not be out yet): the script
    says so and exits 0. --require exits 1 instead.
Standard library only.
"""
import argparse
import csv
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
MANUAL = os.path.join(HERE, "manual_assignments.json")
HISTORY = os.path.join(HERE, "ref_assignments.csv")
FEEDS = [
    "https://www.footballzebras.com/?s=referee+assignments&feed=rss2",
    "https://www.footballzebras.com/feed/",
    "https://www.footballzebras.com/category/assignments/feed/",
]
UA = "EdgeDesk referee sync (+https://edgedesksports.com)"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"

# nflverse club codes -> how a post names them. Shared cities (New York, Los
# Angeles) are named by nickname only.
TEAMS = {
    "ARI": ("Cardinals", "Arizona"), "ATL": ("Falcons", "Atlanta"), "BAL": ("Ravens", "Baltimore"),
    "BUF": ("Bills", "Buffalo"), "CAR": ("Panthers", "Carolina"), "CHI": ("Bears", "Chicago"),
    "CIN": ("Bengals", "Cincinnati"), "CLE": ("Browns", "Cleveland"), "DAL": ("Cowboys", "Dallas"),
    "DEN": ("Broncos", "Denver"), "DET": ("Lions", "Detroit"), "GB": ("Packers", "Green Bay"),
    "HOU": ("Texans", "Houston"), "IND": ("Colts", "Indianapolis"), "JAX": ("Jaguars", "Jacksonville"),
    "KC": ("Chiefs", "Kansas City"), "LA": ("Rams",), "LAC": ("Chargers",), "LV": ("Raiders", "Las Vegas"),
    "MIA": ("Dolphins", "Miami"), "MIN": ("Vikings", "Minnesota"), "NE": ("Patriots", "New England"),
    "NO": ("Saints", "New Orleans"), "NYG": ("Giants",), "NYJ": ("Jets",), "PHI": ("Eagles", "Philadelphia"),
    "PIT": ("Steelers", "Pittsburgh"), "SEA": ("Seahawks", "Seattle"), "SF": ("49ers", "Niners", "San Francisco"),
    "TB": ("Buccaneers", "Bucs", "Tampa Bay"), "TEN": ("Titans", "Tennessee"), "WAS": ("Commanders", "Washington"),
}
NAME = r"[A-Z][a-zA-Z'.’-]+(?:\s+[A-Z][a-zA-Z'.’-]+){1,2}"


def team_re(code):
    words = "|".join(re.escape(w) for w in TEAMS.get(code, ()))
    return re.compile(r"(?<![A-Za-z])(?:" + words + r")(?![A-Za-z])", re.I) if words else None


# ---------------------------------------------------------------- inputs
def read_games(path):
    with open(path, newline="") as fh:
        return [r for r in csv.DictReader(fh)]


def known_referees():
    names = set()
    if os.path.exists(HISTORY):
        with open(HISTORY, newline="") as fh:
            names.update(r["referee"].strip() for r in csv.DictReader(fh) if r.get("referee"))
    if os.path.exists(MANUAL):
        with open(MANUAL) as fh:
            doc = json.load(fh)
        for blk in doc.get("weeks", []):
            names.update(v.strip() for v in (blk.get("games") or {}).values() if v)
    return sorted(n for n in names if n)


def target_week(games, season, today):
    """the week of the earliest game not yet played (no result) on or after yesterday"""
    up = [g for g in games if int(g["season"]) == season and g.get("game_type", "REG") == "REG"
          and not (g.get("result") or "").strip() and g.get("gameday", "") >= (today - dt.timedelta(days=1)).isoformat()]
    return min(int(g["week"]) for g in up) if up else None


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def feed_items(xml_text):
    """[(title, pub_date or None, html)] from one RSS document; a broken feed gives []"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        body = it.findtext(CONTENT) or it.findtext("description") or ""
        pub = None
        try:
            from email.utils import parsedate_to_datetime
            pub = parsedate_to_datetime(it.findtext("pubDate")) if it.findtext("pubDate") else None
        except (TypeError, ValueError):
            pub = None
        out.append((title, pub, body))
    return out


def pick_post(items, season, week):
    """the newest post announcing this week's referee assignments in this season"""
    want = []
    for title, pub, body in items:
        t = title.lower()
        m = re.search(r"\bweek\s+(\d{1,2})\b", t)
        if not m or int(m.group(1)) != week:
            continue
        if not re.search(r"referee|officiat|crew", t) or not re.search(r"assign|crews?\b", t):
            continue
        if pub is not None and pub.year not in (season, season + 1):
            continue
        want.append((pub.timestamp() if pub else 0, title, body))
    want.sort(reverse=True)
    return want[0] if want else None


# ---------------------------------------------------------------- parsing
def text_lines(body):
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", body or "")
    s = re.sub(r"(?i)</t[dh]\s*>", " | ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|li|tr|h\d|div)\s*>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace(" ", " ")
    return [re.sub(r"\s+", " ", l).strip(" |") for l in s.split("\n") if l.strip(" |\t")]


def match_week(lines, games, refs):
    """{game_id: (referee, how)} for every game of the week the post ties to one referee"""
    known = sorted(refs, key=len, reverse=True)
    known_re = [(n, re.compile(r"(?<![A-Za-z])" + re.escape(n) + r"(?![A-Za-z])", re.I)) for n in known]
    pairs = {g["game_id"]: (team_re(g["away_team"]), team_re(g["home_team"])) for g in games}

    def both(line, gid):
        a, h = pairs[gid]
        return a is not None and h is not None and a.search(line) and h.search(line)

    def another_game(line, gid):
        return any(both(line, o) for o in pairs if o != gid)

    out = {}
    for gid in pairs:
        hit = next((i for i, l in enumerate(lines) if both(l, gid)), None)
        if hit is None:
            continue
        a, h = pairs[gid]
        line = lines[hit]
        end = max(a.search(line).end(), h.search(line).end())
        window = [line[end:]]
        for nxt in lines[hit + 1:hit + 4]:
            if another_game(nxt, gid) or both(nxt, gid):
                break
            window.append(nxt)
        found = None
        for chunk in window:
            hits = [(m.start(), n) for n, rx in known_re for m in [rx.search(chunk)] if m]
            if hits:
                found = (min(hits)[1], "known crew chief")
                break
            m = re.search(r"\bReferee\b\s*[:\-–—|]?\s*(" + NAME + ")", chunk)
            if m:
                found = (m.group(1).strip(), "labelled Referee")
                break
        if not found:
            m = re.match(r"^\s*(?:[:\-–—|,]\s*)?(" + NAME + r")\s*$", window[0])
            if m and not team_re(games_by(games, gid)["away_team"]).search(m.group(1)):
                found = (m.group(1).strip(), "a name after the matchup")
        if found:
            out[gid] = found
    return out


def games_by(games, gid):
    return next(g for g in games if g["game_id"] == gid)


# ---------------------------------------------------------------- the file
def dump_manual(doc):
    """the file's own layout: three games to a line, one block per week"""
    lines = ["{", '  "_how": [']
    how = doc.get("_how", [])
    lines += ["    " + json.dumps(h, ensure_ascii=False) + ("," if i < len(how) - 1 else "") for i, h in enumerate(how)]
    lines += ["  ],", '  "weeks": [']
    weeks = doc.get("weeks", [])
    for bi, b in enumerate(weeks):
        head = '      "season": %d, "week": %d' % (b["season"], b["week"])
        if "source" in b:
            head += ', "source": ' + json.dumps(b["source"])
        items = [json.dumps(k) + ": " + json.dumps(v, ensure_ascii=False) for k, v in (b.get("games") or {}).items()]
        rows = [", ".join(items[i:i + 3]) for i in range(0, len(items), 3)]
        lines += ["    {", head + ",", '      "games": {']
        lines += ["        " + r + ("," if i < len(rows) - 1 else "") for i, r in enumerate(rows)]
        lines += ["      }", "    }" + ("," if bi < len(weeks) - 1 else "")]
    lines += ["  ]", "}"]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--games", required=True, help="nflverse games.csv")
    ap.add_argument("--season", type=int)
    ap.add_argument("--week", type=int)
    ap.add_argument("--today", help="YYYY-MM-DD (default: today, UTC)")
    ap.add_argument("--feed", action="append", help="an RSS file to read instead of the network (repeatable)")
    ap.add_argument("--manual", default=MANUAL)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--require", action="store_true", help="exit 1 when nothing new is found")
    ap.add_argument("--summary", help="append a Markdown summary to this file (GITHUB_STEP_SUMMARY)")
    a = ap.parse_args(argv)

    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone.utc).date()
    games = read_games(a.games)
    season = a.season or (today.year if today.month >= 3 else today.year - 1)
    week = a.week or target_week(games, season, today)
    say = []
    if not week:
        print(f"{season}: no regular-season week left to assign")
        return 0
    wk = [g for g in games if int(g["season"]) == season and int(g["week"]) == week and g.get("game_type", "REG") == "REG"]
    with open(a.manual) as fh:
        doc = json.load(fh)
    blk = next((b for b in doc.get("weeks", []) if b.get("season") == season and b.get("week") == week), None)
    have = set((blk or {}).get("games", {}))
    need = [g for g in wk if not (g.get("referee") or "").strip() and g["game_id"] not in have]
    print(f"{season} week {week}: {len(wk)} games, {len(wk) - len(need)} already assigned, {len(need)} to find")
    if not need:
        return 0

    items = []
    if a.feed:
        for f in a.feed:
            with open(f, encoding="utf-8") as fh:
                items += feed_items(fh.read())
    else:
        for url in FEEDS:
            try:
                items += feed_items(fetch(url))
            except Exception as e:  # one feed down is not the end: the next may carry the post
                print(f"  {url}: {e}")
    post = pick_post(items, season, week)
    if not post:
        msg = f"no Football Zebras post for {season} week {week} referee assignments yet ({len(items)} feed items read)"
        print(msg)
        say.append(msg)
        write_summary(a.summary, say)
        return 1 if a.require else 0
    _, title, body = post
    found = match_week(text_lines(body), need, known_referees())
    refs = set(known_referees())
    for gid, (ref, how) in sorted(found.items()):
        print(f"  {gid}: {ref} ({how}{'' if ref in refs else '; a referee not yet on file'})")
    missing = [g["game_id"] for g in need if g["game_id"] not in found]
    if missing:
        print("  not in the post: " + ", ".join(missing))
    say.append(f"**{title}**: {len(found)} of {len(need)} games assigned" + (f"; not found: {', '.join(missing)}" if missing else ""))
    if not found:
        write_summary(a.summary, say)
        return 1 if a.require else 0
    if blk is None:
        blk = {"season": season, "week": week, "source": "footballzebras", "games": {}}
        doc.setdefault("weeks", []).append(blk)
        doc["weeks"].sort(key=lambda b: (b["season"], b["week"]))
    order = [g["game_id"] for g in wk]
    merged = dict(blk.get("games") or {})
    merged.update({gid: ref for gid, (ref, _) in found.items()})
    blk["games"] = {gid: merged[gid] for gid in sorted(merged, key=lambda x: order.index(x) if x in order else len(order))}
    if a.dry_run:
        print("dry run: manual_assignments.json not written")
    else:
        with open(a.manual, "w") as fh:
            fh.write(dump_manual(doc))
        print(f"wrote {len(found)} referee(s) to {os.path.relpath(a.manual)}")
    write_summary(a.summary, say)
    return 0


def write_summary(path, lines):
    if path and lines:
        with open(path, "a") as fh:
            fh.write("### NFL referee assignments\n\n" + "\n".join("- " + l for l in lines) + "\n")


if __name__ == "__main__":
    sys.exit(main())
