"""Opening lines for the sports the CLV programme could not test.

FINAL_REPORT.md left NCAAW, UFC and college baseball UNTESTED: no opening line
with a matching close exists for them anywhere in the repo. The MLB holdout
(after 2021) and the NHL 2026-27 season have none either. This starts the
record. It prices nothing, serves nothing and changes no published number.

  python3 -m research.clv.collect_openers            capture, settle, rewrite the summary
  python3 -m research.clv.collect_openers summary    rewrite the summary from the ledger only
  python3 -m research.clv.collect_openers probe      read-only: what ESPN carries now (CI evidence)
  python3 -m research.clv.collect_openers backfill <sport> <YYYYMMDD> <YYYYMMDD> [max_requests]
                                                     ESPN's archive of finished games' open and close

SOURCE. ESPN's public, keyless scoreboard, read with the plain request the
slate, the UFC ingest and the CFB lab already make from GitHub's runners (one
ET day per request, no custom User-Agent; tools/ufc/espn.js says why). Its
odds object names the book (DraftKings) and carries the book's OPEN beside
the number showing now. The Odds API is not used: October's credits are spent
and paid retrieval re-opens on 2026-11-01 under a budget
(docs/odds-api-incident-2026-10/INCIDENT.md).

THE LEDGER: research/clv/openers/<sport>/<YYYY-MM>.jsonl, append-only, filed
by the month a row was observed. Three kinds of row:
  event   every listed game (or UFC bout): when first seen, and again when
          its start, status or sides change. The denominator of coverage.
  quote   every named book's pregame line, on first sighting and on every
          change, stamped `observed_at`. The first quote of a game is the
          earliest available line; `open`, when ESPN sends it, is the book's
          own opener as ESPN shows it (written when it first appears or
          changes, not on every row).
  settle  once a game is over: the final score and, from ESPN's game
          summary, each book's open and close as ESPN kept them, so the close
          does not depend on when this job last ran. UFC is not settled
          here (its results come from model_loop/data/ufc/bouts.csv).

THE ARCHIVE: research/clv/openers/<sport>/backfill_<season>.jsonl. ESPN's game
summaries keep each book's open and close after the game: the probe of
2026-10-21 found DraftKings' for NHL (2025-26 and 2026-27), NCAAW (2025-26)
and part of college baseball (2026), and none for MLB 2025. `backfill` reads
them back, one `archive` row per finished game (the event, the score and
each book's open and close, with no first-seen quote: the opener there is
the book's own, as ESPN kept it). It is resumable and writes only its files.

THE RULES. A quote is read only while ESPN says the game is pre and before
its start: in-play prices are never read. A moneyline needs both sides; a
spread or total needs its number (its prices are kept when ESPN gives them).
Nothing is inferred: an unnamed or consensus book, sides whose readings
disagree about the favourite, an odds block that names the other side's team,
or a price pair whose margin is impossible is left out and counted in the
run report. README.md beside the ledger documents every field.
"""
import datetime as dt
import glob
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "research", "clv", "openers")
SUMMARY = os.path.join(OUT, "summary.json")
ESPN = os.environ.get("ESPN_API", "https://site.api.espn.com").rstrip("/")
ESPN_CORE = os.environ.get("ESPN_CORE_API", "https://sports.core.api.espn.com").rstrip("/")
ET = ZoneInfo("America/New_York")

# days: how many ET days after today are read each run; details_spread: ESPN's
# `details` text is the spread (basketball) rather than the moneyline favourite
# (hockey and baseball, "TOR -205"); max_spread / max_total bound a sane number.
SPORTS = {
    "nhl": {"path": "hockey/nhl", "days": 6, "max_spread": 5, "max_total": 15},
    "mlb": {"path": "baseball/mlb", "days": 6, "max_spread": 5, "max_total": 30},
    "ncaaw": {"path": "basketball/womens-college-basketball", "groups": "50", "days": 6,
              "details_spread": True, "max_spread": 70, "max_total": 250},
    "college_baseball": {"path": "baseball/college-baseball", "groups": "50", "days": 6,
                         "max_spread": 10, "max_total": 40},
    "ufc": {"path": "mma/ufc", "core_league": "mma/leagues/ufc", "months": 2, "card": True},
}
SETTLE_AFTER_H = 4        # a game's summary is first read this long after its start
SETTLE_GIVE_UP_H = 72     # after this long it is recorded as it stands (postponed, suspended, no summary)
SETTLE_PER_RUN = 60
CORE_PER_RUN = 150        # UFC bouts whose odds are read from the core API when the scoreboard has none
CORE_EVERY_H = 4          # ... on every run when the card is inside CORE_NEAR_H, else on hours divisible by this
CORE_NEAR_H = 30
LOOKBACK_MONTHS = 2       # state (last line per game and book) is read from this many earlier months
LIVE_FILE = re.compile(r"^\d{4}-\d{2}\.jsonl$")
ARCHIVE_FILE = re.compile(r"^backfill_.+\.jsonl$")
PAUSE_S = 0.25            # between requests
# a consensus, an average or a stats site's line (ESPN quotes TeamRankings and
# numberFire in older summaries) is a number, not a book's price
REFUSED_BOOK = re.compile(r"consensus|average|opening|teamrankings|numberfire", re.I)
NOT_PLAYING = re.compile(r"POSTPONED|CANCEL|SUSPENDED|FORFEIT|DELAYED", re.I)


# ------------------------------------------------------------------ helpers
def _now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def _iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(s):
    """ESPN writes '2026-10-22T23:00Z'; the ledger writes seconds. A time without a zone is refused."""
    if not s:
        return None
    s = str(s).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return t.astimezone(dt.timezone.utc) if t.tzinfo else None


def _hours(a, b):
    return (a - b).total_seconds() / 3600.0


def _str(v):
    return None if v is None or v == "" else str(v)


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ------------------------------------------------------------------ numbers
def american(v):
    """An American price, or None. ESPN sends -162, -110.0, '+136', 'EVEN', or (core API) {'american': '-130'}."""
    if isinstance(v, dict):
        v = v.get("american")
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip().upper()
    if s in ("EVEN", "EV"):
        return 100
    try:
        x = float(s.replace("+", ""))
    except ValueError:
        return None
    if not math.isfinite(x) or abs(x) < 100:
        return None
    return int(round(x))


def point(v):
    """A spread or total: -1.5, '+2.5', 'o6.5', 'u230.5', 'PK', or (core API) {'american': '+3.5'}."""
    if isinstance(v, dict):
        v = v.get("american", v.get("alternateDisplayValue"))
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip().lower()
    if s in ("pk", "pick", "pickem", "pick'em", "even", "ev"):
        return 0.0
    if s[:1] in ("o", "u"):
        s = s[1:].strip()
    try:
        x = float(s)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def _implied(a):
    return 100.0 / (a + 100.0) if a > 0 else -a / (-a + 100.0)


def overround_ok(a, b):
    """Two prices on one two-way market: their implied probabilities must sum to
    at least 1 (no free money) and not absurdly more. A missing price passes."""
    if a is None or b is None:
        return True
    s = _implied(a) + _implied(b)
    return 0.99 <= s <= 1.35


# ------------------------------------------------------------------ markets
_SIDE_KEYS = {"home": ("homeTeamOdds", "homeAthleteOdds"), "away": ("awayTeamOdds", "awayAthleteOdds")}


def _side_odds(o, side):
    for k in _SIDE_KEYS[side]:
        if isinstance(o.get(k), dict):
            return o[k]
    return {}


def _nested(o, market, side, when):
    """ESPN's nested block o[market][side][when] (scoreboard and pickcenter).
    Before the game its 'close' is the number showing now; some payloads say 'current'."""
    s = (o.get(market) or {}).get(side) if isinstance(o.get(market), dict) else None
    if not isinstance(s, dict):
        return {}
    b = (s.get("close") or s.get("current")) if when == "now" else s.get(when)
    return b if isinstance(b, dict) else {}


def _core_side(o, side, when):
    """The core API's per-side block: o['homeTeamOdds'][when] = {moneyLine, pointSpread, spread}."""
    s = _side_odds(o, side)
    b = (s.get("current") or s.get("close")) if when == "now" else s.get(when)
    return b if isinstance(b, dict) else {}


def _core_top(o, when):
    b = (o.get("current") or o.get("close")) if when == "now" else o.get(when)
    return b if isinstance(b, dict) else {}


def _moneyline(o, when):
    out = {}
    for side in ("home", "away"):
        cands = []
        if when != "open":
            cands.append(_side_odds(o, side).get("moneyLine"))
        cands += [_nested(o, "moneyline", side, when).get("odds"), _core_side(o, side, when).get("moneyLine")]
        out[side] = next((x for x in map(american, cands) if x is not None), None)
    if out["home"] is None or out["away"] is None or not overround_ok(out["home"], out["away"]):
        return None
    return out


def _flat_spread(o, cfg, home_abbr, away_abbr):
    """The home line from ESPN's flat fields: `details` ('POR -3.5', basketball
    only) and `spread` oriented by the favourite flags. Readings that disagree
    about who is favoured give nothing."""
    reads = []
    det = str(o.get("details") or "").strip()
    if cfg.get("details_spread") and det:
        if re.fullmatch(r"(?i)even|pk|pick'?em", det):
            reads.append(0.0)
        else:
            m = re.fullmatch(r"(.+?)\s+([+-]?\d+(?:\.\d+)?)", det)
            if m:
                ab, n = m.group(1).strip().upper(), -abs(float(m.group(2)))
                if home_abbr and ab == str(home_abbr).upper():
                    reads.append(n)
                elif away_abbr and ab == str(away_abbr).upper():
                    reads.append(-n)
    sp = point(o.get("spread")) if not isinstance(o.get("spread"), dict) else None
    hf, af = _side_odds(o, "home").get("favorite"), _side_odds(o, "away").get("favorite")
    if sp is not None:
        if sp == 0:
            reads.append(0.0)
        elif hf is True and af is not True:
            reads.append(-abs(sp))
        elif af is True and hf is not True:
            reads.append(abs(sp))
    if not reads or _disagree(reads):
        return None
    return reads[0]


def _disagree(xs):
    return any(x != 0 and xs[0] != 0 and (x > 0) != (xs[0] > 0) for x in xs)


def _spread(o, when, cfg, home_abbr, away_abbr):
    reads = []   # (home point, home price, away price), most explicit first
    hb, ab = _nested(o, "pointSpread", "home", when), _nested(o, "pointSpread", "away", when)
    hp, ap = point(hb.get("line")), point(ab.get("line"))
    if hp is not None:
        if ap is not None and ap != -hp:
            return None                      # the two sides' own lines are not one market
        reads.append((hp, american(hb.get("odds")), american(ab.get("odds"))))
    ch, ca = _core_side(o, "home", when), _core_side(o, "away", when)
    cp = point(ch.get("pointSpread"))
    if cp is not None:
        reads.append((cp, american(ch.get("spread")), american(ca.get("spread"))))
    if when != "open":
        f = _flat_spread(o, cfg, home_abbr, away_abbr)
        if f is not None:
            reads.append((f, american(_side_odds(o, "home").get("spreadOdds")), american(_side_odds(o, "away").get("spreadOdds"))))
    if not reads or _disagree([r[0] for r in reads]):
        return None
    line, h, a = reads[0]
    if h is None and a is None:      # a line without its prices takes them from a reading of the same line
        h, a = next(((rh, ra) for rl, rh, ra in reads[1:] if rl == line and (rh is not None or ra is not None)), (None, None))
    if abs(line) > cfg.get("max_spread", 100) or not overround_ok(h, a):
        return None
    return {"home": line, "home_price": h, "away_price": a}


def _total(o, when, cfg):
    reads = []
    ob, ub = _nested(o, "total", "over", when), _nested(o, "total", "under", when)
    t, tu = point(ob.get("line")), point(ub.get("line"))
    if t is not None:
        if tu is not None and tu != t:
            return None
        reads.append((t, american(ob.get("odds")), american(ub.get("odds"))))
    c = _core_top(o, when)
    ct = point(c.get("total"))
    if ct is not None:
        reads.append((ct, american(c.get("over")), american(c.get("under"))))
    if when != "open":
        ft = point(o.get("overUnder"))
        if ft is not None:
            reads.append((ft, american(o.get("overOdds")), american(o.get("underOdds"))))
    if not reads:
        return None
    t, ov, un = reads[0]
    if not (0 < t <= cfg.get("max_total", 1000)) or not overround_ok(ov, un):
        return None
    return {"point": t, "over": ov, "under": un}


def market(o, when, sport, home_abbr=None, away_abbr=None):
    """One book's markets at one moment: when = 'now' (pregame), 'open' or 'close'.
    {'ml', 'spread', 'total'} with None for a market not read; None if nothing was."""
    cfg = SPORTS[sport]
    m = {"ml": _moneyline(o, when)}
    if not cfg.get("card"):
        m["spread"] = _spread(o, when, cfg, home_abbr, away_abbr)
        m["total"] = _total(o, when, cfg)
    return m if any(v is not None for v in m.values()) else None


def book_of(o):
    """The named book, or None for a nameless, consensus or 'opening' entry."""
    p = o.get("provider") if isinstance(o, dict) else None
    name = str((p or {}).get("name") or "").strip()
    return None if not name or REFUSED_BOOK.search(name) else name


def _odds_side_id(s):
    """The team or fighter an odds block is for: its id field, or the id in its $ref link."""
    for k in ("teamId", "athleteId"):
        if s.get(k) is not None:
            return str(s[k])
    for k in ("team", "athlete"):
        d = s.get(k)
        if isinstance(d, dict):
            if d.get("id") is not None:
                return str(d["id"])
            m = re.search(r"/(?:teams|athletes)/(\d+)", str(d.get("$ref") or ""))
            if m:
                return m.group(1)
    return None


def _details_agrees(o, ev):
    """ESPN's `details` names the favourite ("I. Lucindo -380"). True when the
    side it names is the side whose odds block is the favourite, False when it
    names the other one, None when it cannot tell."""
    m = re.fullmatch(r"(.+?)\s+[+-]?\d+(?:\.\d+)?", str(o.get("details") or "").strip())
    if not m:
        return None
    name = m.group(1).strip().casefold()
    named = [s for s in ("home", "away") if name in {str(ev[s].get(k) or "").casefold() for k in ("abbr", "name")}]
    fav = [s for s in ("home", "away") if _side_odds(o, s).get("favorite") is True]
    if len(named) != 1 or len(fav) != 1:
        return None
    return named[0] == fav[0]


def oriented(o, home_id, away_id):
    """False when the odds name the sides the other way round from the competitors."""
    for side, mine, other in (("home", home_id, away_id), ("away", away_id, home_id)):
        sid = _odds_side_id(_side_odds(o, side))
        if sid and other and sid == str(other) and sid != str(mine):
            return False
    return True


# ------------------------------------------------------------------ scoreboard
def scoreboard_urls(sport, now):
    cfg = SPORTS[sport]
    base = f"{ESPN}/apis/site/v2/sports/{cfg['path']}/scoreboard?"
    if cfg.get("months"):
        y, m = now.year, now.month
        out = []
        for _ in range(cfg["months"]):
            out.append(base + f"dates={y}{m:02d}&limit=400")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return out
    today = now.astimezone(ET).date()
    q = f"&limit=500" + (f"&groups={cfg['groups']}" if cfg.get("groups") else "")
    return [base + f"dates={(today + dt.timedelta(days=d)).strftime('%Y%m%d')}" + q for d in range(cfg["days"] + 1)]


def _side(x, card):
    t = x.get("team") if isinstance(x.get("team"), dict) else {}
    a = x.get("athlete") if isinstance(x.get("athlete"), dict) else {}
    sid = (x.get("id") or a.get("id")) if card else (t.get("id") or x.get("id"))
    return {"id": _str(sid), "abbr": _str(t.get("abbreviation") or a.get("shortName")),
            "name": _str(t.get("displayName") or a.get("displayName") or x.get("displayName"))}


def _status(c, e):
    st = c.get("status") or e.get("status") or {}
    ty = st.get("type") or {}
    return _str(ty.get("name")), _str(ty.get("state")), bool(ty.get("completed"))


def _order(x):
    try:
        return int(x.get("order"))
    except (TypeError, ValueError):
        return 99


def competitions(j, sport):
    """(event row, odds list) for every competition on a scoreboard payload."""
    card = bool(SPORTS[sport].get("card"))
    out = []
    for e in (j or {}).get("events") or []:
        season = e.get("season") or {}
        for c in e.get("competitions") or []:
            cs = c.get("competitors") or []
            if c.get("id") is None or len(cs) != 2:
                continue
            h = next((x for x in cs if x.get("homeAway") == "home"), None)
            a = next((x for x in cs if x.get("homeAway") == "away"), None)
            side_source = "homeAway"
            if h is None or a is None:
                if not card:
                    continue                 # a game without a named home side is not recorded
                h, a = sorted(cs, key=_order)
                side_source = "order"
            start = _parse_ts(c.get("date") or e.get("date"))
            name, state, done = _status(c, e)
            ev = {"kind": "event", "cid": str(c["id"]), "event_id": _str(e.get("id")),
                  "season": season.get("year"), "season_type": season.get("type"),
                  "start_utc": _iso(start) if start else None,
                  "time_valid": c.get("timeValid", e.get("timeValid")),
                  "status": name, "state": state, "neutral": c.get("neutralSite"),
                  "home": _side(h, card), "away": _side(a, card)}
            if card:
                ev["side_source"] = side_source
                ev["card"] = _str(e.get("name"))
                ev["bout_number"] = c.get("matchNumber")
            out.append((ev, [o for o in (c.get("odds") or []) if isinstance(o, dict)]))
    return out


def pregame(ev, now):
    """ESPN says pre, the game is not off, and (when its time is real) it has not started."""
    if ev.get("state") != "pre" or NOT_PLAYING.search(ev.get("status") or ""):
        return False
    start = _parse_ts(ev.get("start_utc"))
    if start is None:
        return False
    if ev.get("time_valid") is False:
        return start.astimezone(ET).date() >= now.astimezone(ET).date()
    return start > now


def quote(o, ev, sport, now):
    """One odds entry -> a quote row (without `open` bookkeeping), or (None, why)."""
    book = book_of(o)
    if not book:
        return None, "unnamed or consensus book"
    if not oriented(o, ev["home"]["id"], ev["away"]["id"]):
        return None, "odds name the other side as home"
    if ev.get("side_source") == "order":
        # ESPN did not label the sides: the odds must confirm them, by their own ids
        # or, when they carry none, by the favourite their `details` names
        ids = (_odds_side_id(_side_odds(o, "home")), _odds_side_id(_side_odds(o, "away")))
        if any(ids):
            agrees = all(i is None or i == ev[s]["id"] for i, s in zip(ids, ("home", "away")))
        else:
            agrees = _details_agrees(o, ev)
            if agrees is False:
                return None, "odds name the other side as home"
        if not agrees:
            return None, "sides not verifiable"
    m = market(o, "now", sport, ev["home"]["abbr"], ev["away"]["abbr"])
    if not m:
        return None, "no market with its sides"
    row = {"kind": "quote", "cid": ev["cid"], "observed_at": _iso(now), "book": book}
    row.update(m)
    op = market(o, "open", sport, ev["home"]["abbr"], ev["away"]["abbr"])
    return (row, op), None


# ------------------------------------------------------------------ the ledger
def _month(t):
    return t.strftime("%Y-%m")


def _files(sport, now=None, back=None, kind=LIVE_FILE):
    fs = sorted(f for f in glob.glob(os.path.join(OUT, sport, "*.jsonl")) if kind.match(os.path.basename(f)))
    if now is None or back is None:
        return fs
    y, m = now.year, now.month - back
    while m < 1:
        y, m = y - 1, m + 12
    first = f"{y}-{m:02d}"
    return [f for f in fs if os.path.basename(f)[:7] >= first]


def _rows(files):
    for fn in files:
        with open(fn) as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)


def _event_sig(ev):
    return (ev.get("start_utc"), ev.get("status"), ev.get("time_valid"), ev["home"].get("id"), ev["away"].get("id"))


class State:
    """What the ledger already says, read back from its recent months."""

    def __init__(self, sport, now):
        self.sport = sport
        self.events, self.lines, self.opens, self.settles, self.last_quote = {}, {}, {}, {}, {}
        for r in _rows(_files(sport, now, LOOKBACK_MONTHS)):
            k = r.get("kind")
            if k == "event":
                self.events[r["cid"]] = r
            elif k == "quote":
                self.lines[(r["cid"], r["book"])] = (r.get("ml"), r.get("spread"), r.get("total"))
                if "open" in r:
                    self.opens[(r["cid"], r["book"])] = r["open"]
                self.last_quote[r["cid"]] = r["observed_at"]
            elif k == "settle":
                self.settles[r["cid"]] = r

    def event_row(self, ev, now):
        prev = self.events.get(ev["cid"])
        if prev and _event_sig(prev) == _event_sig(ev):
            return None
        row = dict(ev, observed_at=_iso(now))
        self.events[ev["cid"]] = row
        return row

    def quote_row(self, row, op):
        key = (row["cid"], row["book"])
        line = (row.get("ml"), row.get("spread"), row.get("total"))
        open_changed = op is not None and self.opens.get(key) != op
        if self.lines.get(key) == line and not open_changed:
            return None
        if open_changed:
            row["open"] = op
            self.opens[key] = op
        self.lines[key] = line
        self.last_quote[row["cid"]] = row["observed_at"]
        return row

    def is_settled(self, cid):
        """Settled when the game finished, or when nothing was quoted after a
        settle that found it unfinished (a postponed game priced again reopens)."""
        s = self.settles.get(cid)
        return bool(s) and (s.get("completed") or s["observed_at"] >= self.last_quote.get(cid, ""))

    def unsettled(self, now):
        out = []
        for cid in self.last_quote:
            ev = self.events.get(cid)
            start = _parse_ts(ev.get("start_utc")) if ev else None
            if self.is_settled(cid) or start is None or _hours(now, start) < SETTLE_AFTER_H:
                continue
            out.append((start, cid))
        return [cid for _, cid in sorted(out)]


def append(sport, rows, now):
    if not rows:
        return None
    d = os.path.join(OUT, sport)
    os.makedirs(d, exist_ok=True)
    fn = os.path.join(d, _month(now) + ".jsonl")
    with open(fn, "a") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    return fn


# ------------------------------------------------------------------ capture
def _core_due(ev, now):
    start = _parse_ts(ev.get("start_utc"))
    return start is not None and (_hours(start, now) <= CORE_NEAR_H or now.hour % CORE_EVERY_H == 0)


def _deref(url):
    """Core API links name an internal host; ask the public one."""
    return re.sub(r"^https?://sports\.core\.api\.espn\.[a-z]+", ESPN_CORE, url)


def core_odds(sport, ev, fetch_fn):
    """A UFC bout's odds from the core API (the card scoreboard may carry none)."""
    url = f"{ESPN_CORE}/v2/sports/{SPORTS[sport]['core_league']}/events/{ev['event_id']}/competitions/{ev['cid']}/odds"
    j = fetch_fn(url)
    items = []
    for it in (j or {}).get("items") or []:
        if isinstance(it, dict) and set(it) == {"$ref"}:
            it = fetch_fn(_deref(it["$ref"]))
        if isinstance(it, dict):
            items.append(it)
    return items


def capture_sport(sport, now, fetch_fn=fetch, pause=PAUSE_S):
    st = State(sport, now)
    rep = {"requests": 0, "scoreboards_ok": 0, "errors": [], "listed": 0, "pregame": 0, "with_odds": 0, "priced": 0,
           "rows": {"event": 0, "quote": 0, "settle": 0}, "rejected": {}, "core_requests": 0}
    seen = {}
    for url in scoreboard_urls(sport, now):
        rep["requests"] += 1
        try:
            j = fetch_fn(url)
        except Exception as ex:   # recorded, never guessed; the next run asks again
            rep["errors"].append(f"{url.split('?')[1]}: {str(ex)[:120]}")
            continue
        finally:
            time.sleep(pause)
        rep["scoreboards_ok"] += 1
        for ev, odds in competitions(j, sport):
            seen[ev["cid"]] = (ev, odds)
    rows = []
    core_left = CORE_PER_RUN
    for cid, (ev, odds) in sorted(seen.items(), key=lambda kv: kv[1][0].get("start_utc") or "~"):
        off = bool(NOT_PLAYING.search(ev.get("status") or ""))
        if ev.get("state") != "pre" and not off:
            continue                         # in play or over: its result comes from the settle
        rep["listed"] += 1
        r = st.event_row(ev, now)
        if r:
            rows.append(r)
        if not pregame(ev, now):
            continue
        rep["pregame"] += 1
        if not odds and SPORTS[sport].get("core_league") and core_left > 0 and _core_due(ev, now):
            core_left -= 1
            rep["core_requests"] += 1
            try:
                odds = core_odds(sport, ev, fetch_fn)
            except Exception as ex:
                rep["errors"].append(f"core {cid}: {str(ex)[:120]}")
            time.sleep(pause)
        if odds:
            rep["with_odds"] += 1
        got = False
        for o in odds:
            q, why = quote(o, ev, sport, now)
            if why:
                rep["rejected"][why] = rep["rejected"].get(why, 0) + 1
                continue
            got = True
            r = st.quote_row(*q)
            if r:
                rows.append(r)
        rep["priced"] += got
    if not SPORTS[sport].get("card"):
        rows += settle_sport(sport, st, now, fetch_fn, rep, pause)
    for r in rows:
        rep["rows"][r["kind"]] += 1
    append(sport, rows, now)
    return rep


def settle_row(sport, j, ev, now):
    """A game summary -> the settle row: final score and each book's open and close."""
    comp = (((j or {}).get("header") or {}).get("competitions") or [{}])[0]
    ty = (comp.get("status") or {}).get("type") or {}
    scores = {}
    for c in comp.get("competitors") or []:
        if c.get("homeAway") in ("home", "away"):
            try:
                scores[c["homeAway"]] = float(c.get("score"))
            except (TypeError, ValueError):
                scores[c["homeAway"]] = None
    books = []
    h, a = (ev or {}).get("home") or {}, (ev or {}).get("away") or {}
    for p in (j or {}).get("pickcenter") or []:
        b = book_of(p)
        if not b or not oriented(p, h.get("id"), a.get("id")):
            continue
        books.append({"book": b, "open": market(p, "open", sport, h.get("abbr"), a.get("abbr")),
                      "close": market(p, "close", sport, h.get("abbr"), a.get("abbr"))})
    return {"kind": "settle", "cid": (ev or {}).get("cid"), "observed_at": _iso(now), "status": _str(ty.get("name")),
            "completed": bool(ty.get("completed")), "home_score": scores.get("home"), "away_score": scores.get("away"),
            "books": books}


def settle_sport(sport, st, now, fetch_fn, rep, pause=PAUSE_S):
    out = []
    for cid in st.unsettled(now)[:SETTLE_PER_RUN]:
        ev = st.events[cid]
        late = _hours(now, _parse_ts(ev["start_utc"])) >= SETTLE_GIVE_UP_H
        url = f"{ESPN}/apis/site/v2/sports/{SPORTS[sport]['path']}/summary?event={cid}"
        rep["requests"] += 1
        try:
            j = fetch_fn(url)
        except Exception as ex:
            rep["errors"].append(f"summary {cid}: {str(ex)[:120]}")
            if late:
                row = {"kind": "settle", "cid": cid, "observed_at": _iso(now), "status": None, "completed": False,
                       "error": str(ex)[:120], "books": []}
                out.append(row)
                st.settles[cid] = row
            continue
        finally:
            time.sleep(pause)
        row = settle_row(sport, j, ev, now)
        if row["completed"] or late:
            out.append(row)
            st.settles[cid] = row
    return out


# ------------------------------------------------------------------ archive
def _archive_cids(sport):
    return {r["cid"] for r in _rows(_files(sport, kind=ARCHIVE_FILE))}


def backfill(sport, day_from, day_to, fetch_fn=fetch, max_requests=1500, now=None, pause=PAUSE_S):
    """ESPN's archive for finished games, ET days day_from..day_to (YYYYMMDD):
    one `archive` row per final game, filed by its season. Games already in
    the archive are skipped, so a run that stops at max_requests resumes."""
    cfg = SPORTS[sport]
    if cfg.get("card"):
        raise ValueError(f"{sport}: card sports have no game summary to read")
    now = now or _now()
    have = _archive_cids(sport)
    d, last = dt.datetime.strptime(day_from, "%Y%m%d").date(), dt.datetime.strptime(day_to, "%Y%m%d").date()
    rep = {"sport": sport, "from": day_from, "to": None, "requests": 0, "games": 0, "with_open_and_close": 0,
           "skipped_have": 0, "errors": [], "files": []}
    out = {}
    q = "&limit=500" + (f"&groups={cfg['groups']}" if cfg.get("groups") else "")
    while d <= last and rep["requests"] < max_requests:
        url = f"{ESPN}/apis/site/v2/sports/{cfg['path']}/scoreboard?dates={d.strftime('%Y%m%d')}" + q
        rep["requests"] += 1
        try:
            comps = competitions(fetch_fn(url), sport)
        except Exception as ex:
            rep["errors"].append(f"{d}: {str(ex)[:120]}")
            comps = []
        time.sleep(pause)
        finals = [ev for ev, _ in comps if ev.get("status") == "STATUS_FINAL"]
        if rep["to"] is not None and rep["requests"] + sum(ev["cid"] not in have for ev in finals) > max_requests:
            break                            # a day is taken whole or not at all, so the resume point is a day
        for ev in finals:
            if ev["cid"] in have:
                rep["skipped_have"] += 1
                continue
            rep["requests"] += 1
            try:
                j = fetch_fn(f"{ESPN}/apis/site/v2/sports/{cfg['path']}/summary?event={ev['cid']}")
            except Exception as ex:
                rep["errors"].append(f"summary {ev['cid']}: {str(ex)[:120]}")
                continue                     # not written, so a later run asks again
            finally:
                time.sleep(pause)
            st = settle_row(sport, j, ev, now)
            row = {k: v for k, v in ev.items() if k not in ("kind", "state")}
            row.update(kind="archive", observed_at=_iso(now), status=st["status"], completed=st["completed"],
                       home_score=st["home_score"], away_score=st["away_score"], books=st["books"])
            out.setdefault(str(ev.get("season")), []).append(row)
            have.add(ev["cid"])
            rep["games"] += 1
            rep["with_open_and_close"] += any(b.get("open") and b.get("close") for b in st["books"])
        rep["to"] = d.strftime("%Y%m%d")
        d += dt.timedelta(days=1)
    for season, rows in sorted(out.items()):
        os.makedirs(os.path.join(OUT, sport), exist_ok=True)
        fn = os.path.join(OUT, sport, f"backfill_{season}.jsonl")
        with open(fn, "a") as f:
            for r in rows:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
        rep["files"].append(os.path.relpath(fn, ROOT))
    rep["done"] = d > last
    return rep


# ------------------------------------------------------------------ summary
def summarise(sport):
    """Per season: games listed, priced, with ESPN's opener, settled with a close,
    testable (an opener and a later close), and how early the first quote came."""
    events, quotes, settles = {}, {}, {}
    for r in _rows(_files(sport)):
        k = r.get("kind")
        if k == "event":
            events[r["cid"]] = r
        elif k == "quote":
            quotes.setdefault(r["cid"], []).append(r)
        elif k == "settle":
            settles[r["cid"]] = r
    blank = lambda: {"listed": 0, "priced": 0, "with_espn_open": 0, "settled_with_close": 0, "testable_live": 0,
                     "archive_games": 0, "archive_with_open_and_close": 0, "_lead": [], "_testable": set()}
    seasons = {}
    for cid, ev in events.items():
        if NOT_PLAYING.search(ev.get("status") or "") and cid not in quotes:
            continue
        s = seasons.setdefault(str(ev.get("season")), blank())
        s["listed"] += 1
        q = quotes.get(cid)
        if not q:
            continue
        s["priced"] += 1
        has_open = any(r.get("open") for r in q)
        se = settles.get(cid) or {}
        has_close = any(b.get("close") for b in se.get("books") or [])
        s["with_espn_open"] += has_open
        s["settled_with_close"] += has_close
        if has_close or len(q) > 1:
            s["testable_live"] += 1
            s["_testable"].add(cid)
        start = _parse_ts(ev.get("start_utc"))
        first = _parse_ts(q[0]["observed_at"])
        if start and first:
            s["_lead"].append(_hours(start, first))
    archive = list(_rows(_files(sport, kind=ARCHIVE_FILE)))
    for r in archive:
        s = seasons.setdefault(str(r.get("season")), blank())
        s["archive_games"] += 1
        if any(b.get("open") and b.get("close") for b in r.get("books") or []):
            s["archive_with_open_and_close"] += 1
            s["_testable"].add(r["cid"])
    for s in seasons.values():
        lead = s.pop("_lead")
        s["testable"] = len(s.pop("_testable"))
        s["priced_share"] = round(s["priced"] / s["listed"], 3) if s["listed"] else None
        s["first_quote_hours_before_start_median"] = round(statistics.median(lead), 1) if lead else None
    seen = list(events.values()) + list(settles.values()) + [x for q in quotes.values() for x in q]
    through = max((r["observed_at"] for r in seen), default=None)
    return {"through": through, "seasons": dict(sorted(seasons.items()))}


def write_summary():
    out = {"schema": "edgedesk_openers_summary_v1",
           "note": "Opening-line collection (research/clv/collect_openers.py). Counts per ESPN season label. "
                   "listed .. testable_live: games seen pregame by the hourly capture (testable_live = priced with a later "
                   "close: ESPN's close at settle, or a second quote). archive_*: finished games read back from ESPN's "
                   "summaries (backfill), with the book's own open and close. testable: games with either. Nothing here is served.",
           "sports": {s: summarise(s) for s in SPORTS}}
    os.makedirs(OUT, exist_ok=True)
    with open(SUMMARY, "w") as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write("\n")
    return out


# ------------------------------------------------------------------ probe
def _trim(o, depth=0):
    """A raw odds object without links, logos and $refs, for a readable log."""
    if isinstance(o, dict):
        return {k: _trim(v, depth + 1) for k, v in o.items()
                if k not in ("links", "link", "logos", "header", "footer", "$ref", "team", "athlete")}
    if isinstance(o, list):
        return [_trim(v, depth + 1) for v in o[:3]]
    return o


HISTORY = {"nhl": ["20261015", "20260115"], "mlb": ["20250610", "20240610", "20230715"],
           "ncaaw": ["20260115"], "college_baseball": ["20260411"]}


def probe(fetch_fn=fetch, now=None, pause=PAUSE_S):
    """What ESPN carries now, and whether finished games' summaries keep each
    book's open and close. Read-only: prints a report and writes nothing."""
    now = now or _now()
    rep = {}
    for sport, cfg in SPORTS.items():
        r = {"listed": 0, "pregame": 0, "with_odds": 0, "quotes": [], "rejected": {}, "errors": [], "raw": None}
        for url in scoreboard_urls(sport, now):
            try:
                comps = competitions(fetch_fn(url), sport)
            except Exception as ex:
                r["errors"].append(f"{url.split('?')[1]}: {str(ex)[:120]}")
                continue
            finally:
                time.sleep(pause)
            for ev, odds in comps:
                r["listed"] += 1
                if not pregame(ev, now):
                    continue
                r["pregame"] += 1
                if not odds and cfg.get("core_league") and r.get("core_tried", 0) < 2:
                    r["core_tried"] = r.get("core_tried", 0) + 1
                    try:
                        odds = core_odds(sport, ev, fetch_fn)
                        r["core_found"] = r.get("core_found", 0) + bool(odds)
                    except Exception as ex:
                        r["errors"].append(f"core {ev['cid']}: {str(ex)[:120]}")
                if odds:
                    r["with_odds"] += 1
                    r["raw"] = r["raw"] or {"event": ev, "odds": _trim(odds[:2])}
                for o in odds:
                    q, why = quote(o, ev, sport, now)
                    if why:
                        r["rejected"][why] = r["rejected"].get(why, 0) + 1
                    elif len(r["quotes"]) < 3:
                        r["quotes"].append({"event": f"{ev['away']['abbr']} @ {ev['home']['abbr']} {ev['start_utc']}",
                                            "quote": q[0], "open": q[1]})
        hist = []
        for day in HISTORY.get(sport, []):
            h = {"day": day, "finals": 0, "with_pickcenter": 0, "with_open": 0, "with_close": 0, "sample": None}
            try:
                url = f"{ESPN}/apis/site/v2/sports/{cfg['path']}/scoreboard?dates={day}&limit=500" + (
                    f"&groups={cfg['groups']}" if cfg.get("groups") else "")
                finals = [ev for ev, _ in competitions(fetch_fn(url), sport) if ev.get("status") == "STATUS_FINAL"][:4]
            except Exception as ex:
                h["error"] = str(ex)[:120]
                hist.append(h)
                continue
            for ev in finals:
                time.sleep(pause)
                h["finals"] += 1
                try:
                    j = fetch_fn(f"{ESPN}/apis/site/v2/sports/{cfg['path']}/summary?event={ev['cid']}")
                except Exception as ex:
                    h["error"] = str(ex)[:120]
                    continue
                row = settle_row(sport, j, ev, now)
                h["with_pickcenter"] += bool(j.get("pickcenter"))
                h["with_open"] += any(b.get("open") for b in row["books"])
                h["with_close"] += any(b.get("close") for b in row["books"])
                h["sample"] = h["sample"] or (row["books"][:1] or None)
            hist.append(h)
        r["history"] = hist
        rep[sport] = r
    return rep


# ------------------------------------------------------------------ main
def run(now=None, fetch_fn=fetch):
    now = now or _now()
    report = {"at": _iso(now), "sports": {}}
    for sport in SPORTS:
        report["sports"][sport] = capture_sport(sport, now, fetch_fn)
    write_summary()
    return report


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd == "run":
        rep = run()
        print(json.dumps(rep, indent=1))
        if sum(r["scoreboards_ok"] for r in rep["sports"].values()) == 0:
            print("::error::no ESPN scoreboard answered; nothing was captured", file=sys.stderr)
            return 1
        return 0
    if cmd == "summary":
        print(json.dumps(write_summary(), indent=1))
        return 0
    if cmd == "probe":
        print(json.dumps(probe(), indent=1, default=str))
        return 0
    if cmd == "backfill":
        if len(argv) < 5 or argv[2] not in SPORTS:
            print("usage: backfill <sport> <YYYYMMDD> <YYYYMMDD> [max_requests]", file=sys.stderr)
            return 64
        rep = backfill(argv[2], argv[3], argv[4], max_requests=int(argv[5]) if len(argv) > 5 else 1500)
        rep["summary"] = summarise(argv[2])    # summary.json is the hourly job's to write
        print(json.dumps(rep, indent=1))
        return 0
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
