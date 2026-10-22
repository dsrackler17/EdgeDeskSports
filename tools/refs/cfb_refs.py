#!/usr/bin/env python3
"""EdgeDesk CFB referee flags: the ESPN backfill, the weekly sync and the seed.

Tier: Observed (T0). DISPLAY ONLY: nothing here feeds a model, a classification
(INVESTIGATE / MONITOR / PASS), H-CFB-01, CLV grading or any ranking of games.

  python3 tools/refs/cfb_refs.py backfill                     # 5-game ESPN check, then fill the missing referees
  python3 tools/refs/cfb_refs.py seed [--emit FILE]           # the dataset + the backfill -> Supabase
  python3 tools/refs/cfb_refs.py finals [--season S --week W] # Sunday: last week's finals -> cfb_ref_game_penalties
  python3 tools/refs/cfb_refs.py assignments [--season S --week W]  # Thu/Fri: pregame referees -> cfb_ref_assignments
  python3 tools/refs/cfb_refs.py coverage                     # referee coverage by season

Reuses data/refs/cfb/build_cfb_ref_data.py for every ESPN request (retries, the
cache of completed games), the officials parse (position "Referee" only), the
box-score penalties and the penalty regexes. Name keys are that dataset's own:
lowercase letters only, then the ALIASES map in data/refs/cfb/cfb_enrich.py
(read from the file, never copied).

Writes go through supabase/cfb_refs.sql's service-role functions, with SB_URL
and SB_SERVICE_ROLE (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY when those are
unset), as data/refs/upsert_refs.py does for the NFL. --dry-run reads, builds
and reports but writes nothing to the database. Without --dry-run a missing
secret, a migration that is not applied or a failed write exits 1, so the job
fails. `backfill` exits 2 when the five-game check fails: nothing is filled and
data/refs/cfb/backfill/STOPPED.md says why.
"""
import argparse
import ast
import csv
import importlib.util
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "data" / "refs" / "cfb"
OUT = DATA / "backfill"
SEED_CSV = DATA / "cfb_ref_game_penalties.csv"
MISSING_CSV = DATA / "cfb_games_missing_referee.csv"
os.environ.setdefault("CFB_REF_CACHE", str(DATA / "cache"))

VALIDATION_GAMES = 5          # ESPN's Referee must match the NCAA crew chief on this many games
VALIDATION_MAX_TRIES = 40     # candidates read before the check gives up as inconclusive
NCAA_SOURCES = ("ncaa_listed", "ncaa_matched_by_date_teams")

# ESPN conference (group) ids -> the dataset's conference names, used only when
# a game is not in cfb.games. Unknown ids stay null (never guessed).
ESPN_CONF = {"1": "ACC", "151": "American Athletic", "4": "Big 12", "5": "Big Ten", "12": "Conference USA",
             "18": "FBS Independents", "15": "Mid-American", "17": "Mountain West", "9": "Pac-12",
             "8": "SEC", "37": "Sun Belt"}

INT_COLS = ["game_id", "season", "week", "home_points", "away_points", "flags", "penalty_yards", "home_flags",
            "away_flags", "home_penalty_yards", "away_penalty_yards", "holding_total", "off_holding", "def_holding",
            "holding_side_unknown", "dpi", "opi", "false_start", "scrimmage_plays"]
BOOL_COLS = ["neutral_site", "assignment_conflict", "pbp_available"]
NUM_COLS = ["flags_per_100_plays"]


# ------------------------------------------------------------------ the dataset's own helpers
_B = None


def espn():
    """data/refs/cfb/build_cfb_ref_data.py, loaded from its path (the data folder never joins sys.path)."""
    global _B
    if _B is None:
        spec = importlib.util.spec_from_file_location("build_cfb_ref_data", DATA / "build_cfb_ref_data.py")
        _B = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_B)
        _B.CACHE = Path(os.environ["CFB_REF_CACHE"])
        _B.CACHE.mkdir(parents=True, exist_ok=True)
    return _B


def load_aliases(path=DATA / "cfb_enrich.py"):
    """The ALIASES literal from cfb_enrich.py. That script reads build-machine paths at import, so it is parsed, not run."""
    tree = ast.parse(Path(path).read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "ALIASES" for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("ALIASES not found in " + str(path))


ALIASES = load_aliases()


def key(name):
    return re.sub(r"[^a-z]", "", str(name or "").lower())


def canon(k):
    return ALIASES.get(k, k)


# ------------------------------------------------------------------ name -> referee_id
SUFFIX = {"jr", "sr", "ii", "iii", "iv", "v"}
NICK = [{"mike", "michael"}, {"jeff", "jeffrey", "jeffery"}, {"steve", "steven", "stephen"}, {"matt", "matthew"},
        {"dan", "daniel", "danny"}, {"dave", "david"}, {"tom", "thomas"}, {"jim", "james", "jimmy"},
        {"bill", "william", "will", "billy"}, {"bob", "robert", "rob", "bobby"}, {"chris", "christopher"},
        {"greg", "gregory"}, {"tim", "timothy"}, {"tony", "anthony"}, {"joe", "joseph", "joey"},
        {"ken", "kenneth", "kenny"}, {"larry", "lawrence"}, {"andy", "andrew", "drew"}, {"ed", "edward", "eddie"},
        {"nick", "nicholas"}, {"pat", "patrick"}, {"ron", "ronald", "ronnie"}, {"sam", "samuel"},
        {"zach", "zachary", "zack"}, {"hank", "henry"}, {"rick", "richard", "rich", "dick"}, {"fred", "frederick"},
        {"terry", "terrence", "terence"}, {"jerry", "gerald", "gerry"}, {"al", "albert", "alan", "allen"}]


def name_parts(name):
    toks = [key(t) for t in re.split(r"[\s.]+", str(name or "")) if key(t)]
    while len(toks) > 1 and toks[-1] in SUFFIX:
        toks.pop()
    return (toks[0], toks[-1]) if len(toks) >= 2 else (None, None)


def first_names_compatible(a, b):
    if not a or not b:
        return False
    if a == b:
        return True
    if any(a in s and b in s for s in NICK):
        return True
    return len(a) >= 3 and len(b) >= 3 and (a.startswith(b) or b.startswith(a))


def edits(a, b):
    if abs(len(a) - len(b)) > 2:
        return 3
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class Referees:
    """The known referee_ids (the dataset, the backfill, the database) and how an ESPN name resolves to one.

    exact / alias        the name's key (or its ALIASES target) is a known id
    spelling_variant     not a known key, but exactly one known referee is the same
                         person spelled differently: same surname and a compatible
                         first name (a nickname or a prefix), or a typo in one of
                         the two names (at most 2 letters apart on the full key,
                         the other name identical). Never a new id for these.
    ambiguous            more than one known referee could be that spelling: not filled
    new_referee          nobody close: a new official (an FCS crew), conference unknown
    """

    def __init__(self, rows):
        self.name = {}      # referee_id -> display name (the dataset's spelling when it has one)
        self.conf = {}      # referee_id -> the dataset's primary conference (its NCAA rows only)
        self.parts = {}     # referee_id -> (first, last) keys
        ncaa_named = set()
        for r in rows:
            rid = r.get("referee_id")
            if not rid:
                continue
            ncaa = r.get("referee_source") in NCAA_SOURCES
            if rid not in self.name or (ncaa and rid not in ncaa_named):
                self.name[rid] = r.get("referee") or rid
                self.parts[rid] = name_parts(self.name[rid])
                if ncaa:
                    ncaa_named.add(rid)
            # cfb_ref_referees.primary_conf is already read from the NCAA rows only
            conf = r.get("referee_primary_conf") if ncaa else r.get("primary_conf") if r.get("referee_source") == "db" else None
            if conf:
                self.conf[rid] = conf

    def ids(self):
        return set(self.name)

    def resolve(self, espn_name):
        k = key(espn_name)
        if not k:
            return None, "no_name", []
        if k in self.name:
            return k, "exact", []
        c = canon(k)
        if c != k and c in self.name:
            return c, "alias", []
        if c != k:
            return c, "alias", []           # an ALIASES target always wins, known yet or not
        first, last = name_parts(espn_name)
        cands = set()
        for rid, (f, l) in self.parts.items():
            if last and l == last and first_names_compatible(first, f):
                cands.add(rid)
            elif (last and (l == last or f == first)) and edits(k, rid) <= 2:
                cands.add(rid)
        if len(cands) == 1:
            return cands.pop(), "spelling_variant", []
        if len(cands) > 1:
            return None, "ambiguous", sorted(cands)
        return k, "new_referee", []


# ------------------------------------------------------------------ ESPN summary parsing
def officials(summary):
    """(referee display name or None, crew string). Only an official whose position is Referee counts."""
    return espn().find_referee(summary or {})


def officials_diag(summary):
    """What ESPN's summary says about officials, for the evidence file when no Referee is listed."""
    s = summary or {}
    gi = s.get("gameInfo")
    if not isinstance(gi, dict):
        return "no gameInfo in the summary (top-level keys: " + ",".join(sorted(s)[:12]) + ")"
    offs = gi.get("officials")
    if offs is None:
        elsewhere = '"officials"' in json.dumps(s)
        return ("gameInfo has no officials list (gameInfo keys: " + ",".join(sorted(gi)) + ")"
                + ("; an officials key exists elsewhere in the summary" if elsewhere else "; no officials anywhere in the summary"))
    if not offs:
        return "gameInfo.officials is an empty list"
    pos = sorted({str(((o.get("position") or {}).get("displayName") or (o.get("position") or {}).get("name") or "(no position)"))
                  for o in offs if isinstance(o, dict)})
    return f"{len(offs)} officials listed, none labelled Referee (positions: " + ", ".join(pos) + ")"


def summary_for(game_id, completed=True):
    B = espn()
    return B.get(f"{B.BASE}/summary", {"event": game_id}, cache_key=f"sum_{game_id}.json" if completed else None)


def _teams(summary):
    out = []
    for t in (summary.get("boxscore") or {}).get("teams", []) or []:
        tm = t.get("team") or {}
        toks = {tm.get(f) for f in ("abbreviation", "displayName", "shortDisplayName", "location", "name") if tm.get(f)}
        out.append((str(tm.get("id")), sorted((x for x in toks if len(x) >= 2), key=len, reverse=True)))
    return out


def penalty_team(text, teams):
    """The team a penalty is on, from the play text ("PENALTY UGA Offensive Holding", "Georgia Penalty, ...")."""
    t = text or ""
    best = None
    for m in re.finditer(r"penalty", t, re.I):
        after, before = t[m.end():m.end() + 40], t[max(0, m.start() - 40):m.start()]
        for tid, toks in teams:
            for tok in toks:
                ra = re.search(r"^[\s,:]*" + re.escape(tok) + r"\b", after, re.I)
                rb = re.search(r"\b" + re.escape(tok) + r"\s*$", before, re.I)
                if ra or rb:
                    d = 0 if ra else 1
                    if best is None or d < best[0]:
                        best = (d, tid)
        if best:
            return best[1]
    return None


SKIP_PLAY_RE = re.compile(r"kickoff|punt|field goal|extra point|timeout|end (of )?(period|half|game|regulation|quarter)|coin toss|two[- ]point", re.I)


def parse_plays(summary):
    """Holding (offensive / defensive), DPI / OPI and false starts from play-by-play, the side read from
    the text when it says, else from possession: the penalized team has the ball = offensive. Declined and
    offsetting penalties are not counted (as build_cfb_ref_data.parse_play_penalties and cfb_enrich.py)."""
    B = espn()
    teams = _teams(summary)
    c = dict(holding_total=0, off_holding=0, def_holding=0, holding_side_unknown=0, dpi=0, opi=0, false_start=0,
             scrimmage_plays=0)
    drives = ((summary.get("drives") or {}).get("previous")) or []
    for d in drives:
        drive_team = str(((d.get("team") or {}).get("id")) or "") or None
        for p in d.get("plays", []) or []:
            text = p.get("text") or ""
            ptype = ((p.get("type") or {}).get("text")) or ""
            if not SKIP_PLAY_RE.search(ptype):
                c["scrimmage_plays"] += 1
            if not (B.PEN_RE.search(text) or "penalty" in ptype.lower()):
                continue
            if B.DECLINED_RE.search(text):
                continue
            low = text.lower()
            pos = str((((p.get("start") or {}).get("team")) or {}).get("id") or "") or drive_team
            pt = penalty_team(text, teams)
            side = None
            if pt and pos:
                side = "off" if pt == pos else "def"
            if B.HOLD_RE.search(text):
                c["holding_total"] += 1
                hs = "off" if "offensive holding" in low else "def" if "defensive holding" in low else side
                c[{"off": "off_holding", "def": "def_holding", None: "holding_side_unknown"}[hs]] += 1
            if "pass interference" in low:
                if "offensive pass interference" in low or (side == "off" and "defensive pass interference" not in low):
                    c["opi"] += 1
                elif "defensive pass interference" in low or side == "def":
                    c["dpi"] += 1
            if B.FALSE_START_RE.search(text):
                c["false_start"] += 1
    c["pbp_available"] = bool(drives)
    if not drives:
        for k in list(c):
            if k != "pbp_available":
                c[k] = None
    return c


# ------------------------------------------------------------------ files
def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path, rows, cols):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})


def _int(v):
    if v is None or v == "":
        return None
    f = float(v)
    return None if math.isnan(f) else int(round(f))


def _bool(v):
    if v is None or v == "":
        return None
    return str(v).strip().lower() in ("true", "1", "t", "yes")


def _num(v):
    if v is None or v == "":
        return None
    f = float(v)
    return None if math.isnan(f) else f


def seed_rows(path=SEED_CSV):
    """cfb_ref_game_penalties.csv -> JSON-safe rows (ints are ints: the CSV writes 24.0)."""
    out = []
    for r in read_csv(path):
        o = {}
        for k, v in r.items():
            if k in INT_COLS:
                o[k] = _int(v)
            elif k in BOOL_COLS:
                o[k] = _bool(v)
            elif k in NUM_COLS:
                o[k] = _num(v)
            else:
                o[k] = v if v != "" else None
        out.append(o)
    return out


def backfill_rows():
    f = OUT / "espn_backfill.csv"
    return read_csv(f) if f.exists() else []


def day_of(start):
    """The game's local day, as cfb_enrich.py computes it (UTC - 6 h)."""
    try:
        return (datetime.fromisoformat(str(start).replace("Z", "+00:00")) - timedelta(hours=6)).date()
    except ValueError:
        return None


# ------------------------------------------------------------------ database (PostgREST, service role)
class DB:
    def __init__(self):
        self.url = (os.environ.get("SB_URL") or os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.key = os.environ.get("SB_SERVICE_ROLE") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        self.ok = bool(self.url and self.key)

    def _h(self, profile=None):
        h = {"apikey": self.key, "authorization": "Bearer " + self.key, "content-type": "application/json"}
        if profile:
            h["accept-profile"] = profile
        return h

    def rpc(self, fn, body):
        import requests
        r = requests.post(f"{self.url}/rest/v1/rpc/{fn}", headers=self._h(), data=json.dumps(body), timeout=120)
        if r.status_code == 404 or "PGRST202" in r.text or "42883" in r.text:
            raise NotDeployed(f"{fn}: supabase/cfb_refs.sql is not applied ({r.status_code})")
        if not r.ok:
            raise RuntimeError(f"{fn}: HTTP {r.status_code} {r.text[:300]}")
        return r.json()

    def select_all(self, path, profile=None, page=1000):
        import requests
        out, off = [], 0
        while True:
            sep = "&" if "?" in path else "?"
            r = requests.get(f"{self.url}/rest/v1/{path}{sep}limit={page}&offset={off}", headers=self._h(profile), timeout=60)
            if r.status_code == 404 or "PGRST205" in r.text or "42P01" in r.text:
                raise NotDeployed(f"{path.split('?')[0]}: not readable ({r.status_code})")
            if not r.ok:
                raise RuntimeError(f"{path}: HTTP {r.status_code} {r.text[:300]}")
            rows = r.json()
            out += rows
            if len(rows) < page:
                return out
            off += page


class NotDeployed(Exception):
    pass


def error(msg):
    print(("::error::" if os.environ.get("GITHUB_ACTIONS") else "ERROR: ") + msg)
    return 1


def writer(a):
    """The database to write to: None on --dry-run (nothing is written), False when a write was asked for but
    SB_URL / SB_SERVICE_ROLE are missing (the job fails, as ref-sync.yml does for the NFL)."""
    if getattr(a, "dry_run", False):
        print("dry run: nothing written to the database")
        return None
    db = DB()
    if not db.ok:
        error("SB_URL and SB_SERVICE_ROLE must be set to write the referee tables (or pass --dry-run)")
        return False
    return db


def warn(msg):
    print(("::warning::" if os.environ.get("GITHUB_ACTIONS") else "WARNING: ") + msg)


def summary(md):
    print(md)
    f = os.environ.get("GITHUB_STEP_SUMMARY")
    if f:
        with open(f, "a") as fh:
            fh.write(md + "\n")


def cfb_games(db, ids=None, seasons=None):
    """The CFB module's own games (cfb.games): ESPN ids, since CFBD's game ids are ESPN's."""
    q = "games?select=game_id,season,week,start_date,neutral_site,home_team,away_team,home_conference,away_conference,home_points,away_points,completed&order=game_id.asc"
    if ids:
        out = []
        ids = sorted(set(int(i) for i in ids))
        for i in range(0, len(ids), 150):
            out += db.select_all(q + "&game_id=in.(" + ",".join(map(str, ids[i:i + 150])) + ")", profile="cfb")
        return {int(g["game_id"]): g for g in out}
    if seasons:
        q += "&season=in.(" + ",".join(map(str, seasons)) + ")"
    return {int(g["game_id"]): g for g in db.select_all(q, profile="cfb")}


def map_report(espn_ids, games, label):
    """ESPN game id -> CFB game id is the identity (the CFB module keys games by ESPN id); a miss is logged."""
    miss = sorted(set(int(i) for i in espn_ids) - set(games))
    summary(f"- {label}: {len(espn_ids)} ESPN games, {len(espn_ids) - len(miss)} found in cfb.games, {len(miss)} not found")
    for m in miss[:200]:
        print(f"  map miss: ESPN game {m} has no cfb.games row (stored under its ESPN id; no CFB card reads it)")
    return miss


# ------------------------------------------------------------------ backfill
def validation_candidates(rows, missing_ids):
    """Games that already have an NCAA referee, one per referee, taken in turn from each season (newest
    first) and within a season nearest Week 7 (the gap) first, so a check that reads many games samples
    every season ESPN might list officials for, not one week."""
    cand = [r for r in rows if r["referee_id"] and r["referee_source"] in NCAA_SOURCES and not r["assignment_conflict"]
            and r["game_id"] not in missing_ids]
    cand.sort(key=lambda r: (abs((r["week"] or 0) - 7), r["game_id"]))
    by_season = {}
    for r in cand:
        by_season.setdefault(r["season"], []).append(r)
    queues = [by_season[k] for k in sorted(by_season, reverse=True)]
    seen, out = set(), []
    while any(queues):
        for q in queues:
            while q:
                r = q.pop(0)
                if r["referee_id"] not in seen:
                    seen.add(r["referee_id"])
                    out.append(r)
                    break
    return out


def validate(rows, refs, fetch, missing_ids, need=VALIDATION_GAMES, max_tries=VALIDATION_MAX_TRIES):
    """Five games with an NCAA referee: ESPN must list an official explicitly as Referee, and that referee must
    be the same person after normalization. No Referee listed (or ESPN unreachable) is inconclusive: the next
    game is read. A mismatch stops the check at once. Returns (ok, reason, report rows)."""
    report, verified = [], 0
    for r in validation_candidates(rows, missing_ids)[:max_tries]:
        row = dict(order=len(report) + 1, game_id=r["game_id"], season=r["season"], week=r["week"],
                   matchup=f"{r['away_team']} @ {r['home_team']}", ncaa_referee=r["referee"], ncaa_referee_id=r["referee_id"])
        try:
            s = fetch(r["game_id"])
        except Exception as e:  # noqa: BLE001 (ESPN unreachable for this game: inconclusive, not a match)
            s, row["detail"] = None, str(e)[:160]
        if not s:
            row["result"] = "inconclusive_fetch_failed"
            report.append(row)
            continue
        name, crew = officials(s)
        row["crew"] = crew
        if not name:
            row["result"] = "inconclusive_no_referee_listed"
            row["detail"] = officials_diag(s)
            report.append(row)
            continue
        rid, how, cands = refs.resolve(name)
        row.update(espn_referee=name, espn_referee_id=rid or "", method=how)
        if rid == r["referee_id"]:
            row["result"] = "match"
            verified += 1
            report.append(row)
            if verified >= need:
                return True, f"{verified} of {need} games verified", report
            continue
        row["result"] = "mismatch"
        row["detail"] = ("ESPN lists " + name + (" (could be " + ", ".join(cands) + ")" if cands else "")
                         + "; the NCAA box score lists " + str(r["referee"]))
        report.append(row)
        return False, f"identity mismatch on game {r['game_id']}: {row['detail']}", report
    return False, f"only {verified} of {need} games could be verified ({len(report)} read)", report


def backfill(rows, refs, fetch, missing):
    """Fill each missing game from ESPN's Referee. Returns (fills, log)."""
    by_id = {r["game_id"]: r for r in rows}
    busy = {}
    for r in rows:
        if r["referee_id"]:
            busy.setdefault((r["referee_id"], day_of(r["start_date"])), []).append(r["game_id"])
    fills, log = [], []
    for m in missing:
        gid = int(m["game_id"])
        r = by_id.get(gid)
        entry = dict(game_id=gid, season=m["season"], week=m["week"], matchup=f"{m['away_team']} @ {m['home_team']}")
        if r is None:
            log.append(dict(entry, outcome="not_in_dataset"))
            continue
        if r["assignment_conflict"]:
            log.append(dict(entry, outcome="assignment_conflict_left_alone",
                            detail="same-day double listing in the NCAA data; not refilled"))
            continue
        if r["referee_id"]:
            log.append(dict(entry, outcome="already_has_referee", referee_id=r["referee_id"]))
            continue
        try:
            s = fetch(gid)
        except Exception as e:  # noqa: BLE001
            log.append(dict(entry, outcome="fetch_failed", detail=str(e)[:160]))
            continue
        if not s:
            log.append(dict(entry, outcome="fetch_failed", detail="ESPN has no summary"))
            continue
        name, crew = officials(s)
        if not name:
            log.append(dict(entry, outcome="no_referee_listed", crew=crew, detail=officials_diag(s)))
            continue
        rid, how, cands = refs.resolve(name)
        if not rid:
            log.append(dict(entry, outcome="ambiguous_name", espn_name=name, crew=crew,
                            detail="could be " + ", ".join(cands)))
            continue
        k = (rid, day_of(r["start_date"]))
        if busy.get(k):
            log.append(dict(entry, outcome="same_day_conflict", espn_name=name, referee_id=rid, crew=crew,
                            detail="already listed on game " + ",".join(map(str, busy[k])) + " that day"))
            continue
        busy.setdefault(k, []).append(gid)
        display = refs.name.get(rid) or re.sub(r"\s+", " ", name).strip()
        f = dict(game_id=gid, season=r["season"], week=r["week"], referee_id=rid, referee=display,
                 referee_primary_conf=refs.conf.get(rid, ""), espn_name=name, name_match=how, crew=crew,
                 referee_source="espn", referee_identity="espn_referee_role")
        fills.append(f)
        log.append(dict(entry, outcome="filled", espn_name=name, referee_id=rid, name_match=how, crew=crew))
    return fills, log


def coverage(rows, fills=()):
    filled = {int(f["game_id"]) for f in fills}
    out = []
    for season in sorted({r["season"] for r in rows}):
        sub = [r for r in rows if r["season"] == season]
        before = sum(1 for r in sub if r["referee_id"])
        add = sum(1 for r in sub if not r["referee_id"] and r["game_id"] in filled)
        out.append(dict(season=season, games=len(sub), with_referee_before=before, espn_filled=add,
                        with_referee_after=before + add,
                        coverage_before_pct=round(100.0 * before / len(sub), 1),
                        coverage_after_pct=round(100.0 * (before + add) / len(sub), 1),
                        assignment_conflict=sum(1 for r in sub if r["assignment_conflict"]),
                        still_missing=len(sub) - before - add))
    return out


def coverage_md(cov):
    lines = ["| Season | Games | Referee (NCAA) | + ESPN | Referee now | Coverage | Conflict (left alone) | Still missing |",
             "|---|---|---|---|---|---|---|---|"]
    for c in cov:
        lines.append(f"| {c['season']} | {c['games']} | {c['with_referee_before']} ({c['coverage_before_pct']}%) | "
                     f"{c['espn_filled']} | {c['with_referee_after']} | {c['coverage_after_pct']}% | "
                     f"{c['assignment_conflict']} | {c['still_missing']} |")
    return "\n".join(lines)


COV_COLS = ["season", "games", "with_referee_before", "espn_filled", "with_referee_after", "coverage_before_pct",
            "coverage_after_pct", "assignment_conflict", "still_missing"]


def cmd_backfill(a):
    rows = seed_rows()
    missing = read_csv(MISSING_CSV)
    missing_ids = {int(m["game_id"]) for m in missing}
    refs = Referees(rows)
    fetch = lambda gid: summary_for(gid, completed=True)  # noqa: E731 (completed games: cached)
    ok, why, report = validate(rows, refs, fetch, missing_ids)
    vcols = ["order", "game_id", "season", "week", "matchup", "ncaa_referee", "ncaa_referee_id", "espn_referee",
             "espn_referee_id", "method", "result", "detail", "crew"]
    write_csv(OUT / "espn_validation.csv", report, vcols)
    summary("### ESPN referee check (5 games with an NCAA referee)\n")
    summary("| # | Game | NCAA referee | ESPN Referee | Result |\n|---|---|---|---|---|")
    for r in report:
        summary(f"| {r['order']} | {r['game_id']} {r['matchup']} | {r['ncaa_referee']} | {r.get('espn_referee') or '—'} | {r['result']} |")
    if not ok:
        seen = {}
        for r in report:
            k = (r["season"], r["result"], r.get("detail") if r["result"].startswith("inconclusive") else "")
            seen[k] = seen.get(k, 0) + 1
        lines = [f"- {s}: {n} game{'s' if n != 1 else ''} {res}" + (f" ({d})" if d else "")
                 for (s, res, d), n in sorted(seen.items(), key=lambda kv: (-kv[0][0], kv[0][1]))]
        cov = coverage(rows)
        write_csv(OUT / "coverage_by_season.csv", cov, COV_COLS)
        (OUT / "STOPPED.md").write_text(
            "# ESPN backfill stopped\n\n" + why + ". Nothing was filled.\n\n"
            "The rule: ESPN must list an official explicitly as Referee on 5 games that already have an NCAA "
            "referee, and that Referee must match after normalization. A game with no Referee listed is "
            "inconclusive and another game is read.\n\nWhat ESPN returned, by season:\n\n" + "\n".join(lines)
            + "\n\nEvery game read is in espn_validation.csv. Coverage stays as the NCAA data has it "
            "(coverage_by_season.csv).\n")
        for f in ("espn_backfill.csv", "espn_backfill_log.csv"):
            (OUT / f).unlink(missing_ok=True)
        summary(f"\n**STOPPED: {why}.** Nothing was filled.\n\n" + "\n".join(lines))
        summary("\n### Coverage by season (unchanged)\n\n" + coverage_md(cov))
        return 2
    (OUT / "STOPPED.md").unlink(missing_ok=True)
    summary(f"\nCheck passed: {why}.\n")
    fills, log = backfill(rows, refs, fetch, missing)
    write_csv(OUT / "espn_backfill.csv", fills, ["game_id", "season", "week", "referee_id", "referee", "referee_primary_conf",
                                                  "referee_source", "referee_identity", "espn_name", "name_match", "crew"])
    write_csv(OUT / "espn_backfill_log.csv", log, ["game_id", "season", "week", "matchup", "outcome", "espn_name",
                                                    "referee_id", "name_match", "detail", "crew"])
    cov = coverage(rows, fills)
    write_csv(OUT / "coverage_by_season.csv", cov, COV_COLS)
    tally = {}
    for e in log:
        tally[e["outcome"]] = tally.get(e["outcome"], 0) + 1
    summary("### Backfill (" + str(len(missing)) + " games without a referee)\n")
    summary("\n".join(f"- {k}: {v}" for k, v in sorted(tally.items())))
    variants = [f for f in fills if f["name_match"] in ("alias", "spelling_variant")]
    if variants:
        summary("\nSpelling variants mapped to an existing referee_id: "
                + "; ".join(f"{f['espn_name']} -> {f['referee_id']}" for f in variants))
    new = sorted({f["referee_id"] for f in fills if f["name_match"] == "new_referee"})
    if new:
        summary("\nNew referee ids (not in the dataset; conference unavailable): " + ", ".join(new))
    summary("\n### Coverage by season\n\n" + coverage_md(cov))
    db = writer(a)
    if db is None:
        return 0
    if db is False:
        return 1
    if fills:
        try:
            res = db.rpc("cfb_ref_merge_games", {"p_rows": [dict(game_id=int(f["game_id"]), referee_id=f["referee_id"],
                                                                 referee=f["referee"]) for f in fills],
                                                 "p_mode": "espn_referee"})
            summary(f"\nDatabase: {res['updated']} games filled")
        except (NotDeployed, RuntimeError) as e:
            return error(str(e))
    return 0


# ------------------------------------------------------------------ seed
def cmd_seed(a):
    rows = seed_rows()
    fills = backfill_rows()
    summary(f"### Seed\n\n- {SEED_CSV.relative_to(REPO)}: {len(rows)} games\n- ESPN backfill overlay: {len(fills)} games")
    if a.emit:
        Path(a.emit).write_text(json.dumps({"seed": rows, "espn_referee": [
            dict(game_id=int(f["game_id"]), referee_id=f["referee_id"], referee=f["referee"]) for f in fills]}))
        print("wrote", a.emit)
    db = writer(a)
    if db is None:
        return cmd_coverage(a, db=None)
    if db is False:
        return 1
    try:
        games = cfb_games(db, seasons=sorted({r["season"] for r in rows}))
        map_report([r["game_id"] for r in rows], games, "seed")
    except (NotDeployed, RuntimeError) as e:
        warn("cfb.games could not be read, the game-id check is skipped: " + str(e))
    try:
        tot = {"inserted": 0, "updated": 0}
        for i in range(0, len(rows), 400):
            res = db.rpc("cfb_ref_merge_games", {"p_rows": rows[i:i + 400], "p_mode": "seed"})
            tot["inserted"] += res["inserted"]
            tot["updated"] += res["updated"]
        summary(f"- loaded: {tot['inserted']} inserted, {tot['updated']} updated (upsert on game_id)")
        if fills:
            res = db.rpc("cfb_ref_merge_games", {"p_rows": [dict(game_id=int(f["game_id"]), referee_id=f["referee_id"],
                                                                 referee=f["referee"]) for f in fills],
                                                 "p_mode": "espn_referee"})
            summary(f"- ESPN backfill applied: {res['updated']} games")
    except (NotDeployed, RuntimeError) as e:
        return error(str(e))
    return cmd_coverage(a, db=db)


def cmd_coverage(a, db=None):
    db = db if db is not None else (None if getattr(a, "dry_run", False) else DB())
    if db is not None and db.ok:
        try:
            rows = db.select_all("cfb_ref_game_penalties?select=game_id,season,referee_id,referee_source,assignment_conflict&order=game_id.asc")
            src = "database"
        except NotDeployed as e:
            warn(str(e))
            rows, src = None, None
    else:
        rows = None
    if rows is None:
        rows = seed_rows()
        fills = {int(f["game_id"]): f for f in backfill_rows()}
        for r in rows:
            if not r["referee_id"] and r["game_id"] in fills and not r["assignment_conflict"]:
                r["referee_id"], r["referee_source"] = fills[r["game_id"]]["referee_id"], "espn"
        src = "files (seed + backfill)"
    lines = ["| Season | Games | With referee | Coverage | via ESPN | Conflict (left alone) |", "|---|---|---|---|---|---|"]
    for season in sorted({r["season"] for r in rows}):
        sub = [r for r in rows if r["season"] == season]
        w = sum(1 for r in sub if r["referee_id"])
        e = sum(1 for r in sub if r.get("referee_source") == "espn")
        c = sum(1 for r in sub if r.get("assignment_conflict"))
        lines.append(f"| {season} | {len(sub)} | {w} | {100.0 * w / len(sub):.1f}% | {e} | {c} |")
    summary(f"\n### Referee coverage by season ({src})\n\n" + "\n".join(lines))
    return 0


# ------------------------------------------------------------------ weekly sync
def current_week(season=None, week=None):
    """(season, week, scoreboard): ESPN's current FBS week (the scoreboard with no week), unless given."""
    B = espn()
    if season and week is not None:
        return season, week, None
    sb = B.get(f"{B.BASE}/scoreboard", {"groups": 80, "limit": 400}) or {}
    s = season or ((sb.get("season") or {}).get("year"))
    w = week if week is not None else ((sb.get("week") or {}).get("number"))
    return s, w, sb


def finals_week(season=None, week=None):
    """The week just played: ESPN's current week if any of its games are final, else the one before."""
    if season and week is not None:
        return season, week
    s, w, sb = current_week(season, None)
    done = [e for e in (sb or {}).get("events", []) if (((e.get("status") or {}).get("type")) or {}).get("completed")]
    return s, (w if done else w - 1)


def known_referees(db):
    rows = seed_rows() + [dict(f, referee_source="espn") for f in backfill_rows()]
    if db.ok:
        try:
            rows += [dict(r, referee_source="db") for r in db.select_all("cfb_ref_referees?select=referee_id,referee,primary_conf")]
        except (NotDeployed, RuntimeError) as e:
            warn("cfb_ref_referees not readable, names resolve against the files only: " + str(e))
    return Referees(rows)


def event_meta(ev):
    comp = ev["competitions"][0]
    teams = {c["homeAway"]: c for c in comp["competitors"]}
    h, w = teams.get("home") or {}, teams.get("away") or {}
    return comp, h, w


def final_row(ev, summ, refs, game, season, week):
    B = espn()
    comp, h, w = event_meta(ev)
    gid = int(ev["id"])
    box = B.parse_box_penalties(summ)
    hf, hy = box.get(str((h.get("team") or {}).get("id")), (None, None))
    af, ay = box.get(str((w.get("team") or {}).get("id")), (None, None))
    plays = parse_plays(summ)
    name, crew = officials(summ)
    rid, how, cands = refs.resolve(name) if name else (None, "no_referee_listed", [])
    g = game or {}

    def team(c):
        t = c.get("team") or {}
        return t.get("location") or t.get("displayName")

    row = dict(
        game_id=gid, season=int(g.get("season") or season), week=_int(g.get("week") if g.get("week") is not None else week),
        start_date=g.get("start_date") or comp.get("date") or ev.get("date"),
        neutral_site=g.get("neutral_site") if g.get("neutral_site") is not None else bool(comp.get("neutralSite")),
        home_team=g.get("home_team") or team(h), away_team=g.get("away_team") or team(w),
        home_conference=g.get("home_conference") or ESPN_CONF.get(str((h.get("team") or {}).get("conferenceId") or "")),
        away_conference=g.get("away_conference") or ESPN_CONF.get(str((w.get("team") or {}).get("conferenceId") or "")),
        home_points=_int(g.get("home_points") if g.get("home_points") is not None else h.get("score")),
        away_points=_int(g.get("away_points") if g.get("away_points") is not None else w.get("score")),
        referee_id=rid, referee=(refs.name.get(rid) or name) if rid else None,
        flags=(hf + af) if hf is not None and af is not None else None,
        penalty_yards=(hy + ay) if hy is not None and ay is not None else None,
        home_flags=hf, away_flags=af, home_penalty_yards=hy, away_penalty_yards=ay,
        source_url=f"https://www.espn.com/college-football/game/_/gameId/{gid}")
    row.update(plays)
    if row["flags"] is not None and plays.get("scrimmage_plays"):
        row["flags_per_100_plays"] = round(100.0 * row["flags"] / plays["scrimmage_plays"], 4)
    note = dict(game_id=gid, espn_name=name, referee_id=rid, name_match=how, candidates=cands, crew=crew)
    return row, note


def cmd_finals(a):
    B = espn()
    season, week = finals_week(a.season, a.week)
    sb = B.scoreboard(season, week) or {}
    evs = [e for e in sb.get("events", []) if (((e.get("status") or {}).get("type")) or {}).get("completed")]
    db = DB()
    refs = known_referees(db)
    games, games_ok = {}, False
    if db.ok:
        try:
            games, games_ok = cfb_games(db, ids=[e["id"] for e in evs]), True
        except (NotDeployed, RuntimeError) as e:
            warn("cfb.games not readable: names and conferences come from ESPN, the game-id check is skipped: " + str(e))
    summary(f"### Finals {season} week {week}: {len(evs)} completed FBS games")
    if games_ok:
        map_report([e["id"] for e in evs], games, f"{season} week {week}")
    rows, notes = [], []
    for ev in evs:
        try:
            s = summary_for(ev["id"], completed=True)
        except Exception as e:  # noqa: BLE001
            warn(f"game {ev['id']}: ESPN summary failed ({e}); skipped this run")
            continue
        if not s:
            continue
        r, n = final_row(ev, s, refs, games.get(int(ev["id"])), season, week)
        rows.append(r)
        notes.append(n)
    with_ref = sum(1 for r in rows if r["referee_id"])
    summary(f"- parsed {len(rows)}; ESPN listed a Referee on {with_ref}; box score on {sum(1 for r in rows if r['flags'] is not None)}")
    for n in notes:
        if n["name_match"] in ("alias", "spelling_variant", "new_referee", "ambiguous"):
            print(f"  name: game {n['game_id']} ESPN '{n['espn_name']}' -> {n['referee_id']} ({n['name_match']} {n['candidates'] or ''})")
    if a.emit:
        Path(a.emit).write_text(json.dumps({"rows": rows, "notes": notes}, default=str))
    w = writer(a)
    if w is None:
        return 0
    if w is False:
        return 1
    try:
        res = w.rpc("cfb_ref_merge_games", {"p_rows": rows, "p_mode": "espn_final"})
        summary(f"- database: {res['inserted']} new games, {res['updated']} filled, {res['unchanged']} unchanged")
    except (NotDeployed, RuntimeError) as e:
        return error(str(e))
    return 0


def cmd_assignments(a):
    B = espn()
    s, w, _ = current_week(a.season, a.week)
    sb = B.scoreboard(s, w) or {}
    evs = [e for e in sb.get("events", []) if ((((e.get("status") or {}).get("type")) or {}).get("state")) == "pre"]
    db = DB()
    refs = known_referees(db)
    summary(f"### Assignments {s} week {w}: {len(evs)} FBS games not yet started")
    if db.ok:
        try:
            map_report([e["id"] for e in evs], cfb_games(db, ids=[e["id"] for e in evs]), f"{s} week {w}")
        except (NotDeployed, RuntimeError) as e:
            warn("cfb.games not readable, the game-id check is skipped: " + str(e))
    rows = []
    for ev in evs:
        try:
            summ = summary_for(ev["id"], completed=False)   # pregame: never cached
        except Exception as e:  # noqa: BLE001
            warn(f"game {ev['id']}: ESPN summary failed ({e})")
            continue
        name, crew = officials(summ or {})
        if not name:
            continue
        rid, how, cands = refs.resolve(name)
        if not rid:
            print(f"  game {ev['id']}: ESPN Referee '{name}' is ambiguous ({', '.join(cands)}): not recorded")
            continue
        if how != "exact":
            print(f"  game {ev['id']}: ESPN Referee '{name}' -> {rid} ({how})")
        rows.append(dict(game_id=int(ev["id"]), season=int(s), week=_int(w), referee_id=rid,
                         referee=refs.name.get(rid) or re.sub(r"\s+", " ", name).strip(), source="espn"))
    summary(f"- ESPN lists a Referee for {len(rows)} of {len(evs)} games")
    if a.emit:
        Path(a.emit).write_text(json.dumps(rows))
    w = writer(a)
    if w is None:
        return 0
    if w is False:
        return 1
    if not rows:
        return 0
    try:
        res = w.rpc("cfb_ref_observe_assignments", {"p_rows": rows})
        summary(f"- database: {res['new']} new, {res['seen_again']} seen again, {res['replaced']} replaced (the earlier referee is kept)")
    except (NotDeployed, RuntimeError) as e:
        return error(str(e))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    dry = argparse.ArgumentParser(add_help=False)
    dry.add_argument("--dry-run", action="store_true", help="read, build and report; write nothing to the database")
    sub.add_parser("backfill", parents=[dry])
    sd = sub.add_parser("seed", parents=[dry])
    sd.add_argument("--emit")
    for n in ("finals", "assignments"):
        p = sub.add_parser(n, parents=[dry])
        p.add_argument("--season", type=int)
        p.add_argument("--week", type=int)
        p.add_argument("--emit")
    sub.add_parser("coverage", parents=[dry])
    a = ap.parse_args(argv)
    return {"backfill": cmd_backfill, "seed": cmd_seed, "finals": cmd_finals, "assignments": cmd_assignments,
            "coverage": cmd_coverage}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
