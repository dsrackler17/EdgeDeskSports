"""UFC bouts from ESPN's public scoreboard, one month at a time.

  python3 -m model_loop.adapters.ufc.ingest fetch [--from 2014]   # network: GitHub runners
  python3 -m model_loop.adapters.ufc.ingest build                 # raw months -> model_loop/data/ufc/bouts.csv
  python3 -m model_loop.adapters.ufc.ingest athletes              # network: each fighter's date of birth -> fighters.csv
  python3 -m model_loop.adapters.ufc.ingest records               # each fighter's pro record as ESPN shows it now -> records.csv
  python3 -m model_loop.adapters.ufc.ingest history               # network: each fighter's dated pro fight history (ESPN)

The request is the one the data pack made for 2024
(datapack/quant_v1/scripts/expand_samples.py): the site scoreboard for a month,
`?dates=YYYYMM&limit=1000`, plain (no custom User-Agent: tools/ufc/espn.js
records that ESPN's edge answered 403 to a custom one from a GitHub runner).
Nothing logs in, pays or bypasses anything. UFCStats refused automated access,
so nothing here reads it, directly or through anyone's scrape of it.

The parser keeps exactly the data pack's fields, so `build` over the pack's
own 2024 responses reproduces datapack/quant_v1/data/ufc/bouts_2024.csv, plus
the weight class. A fighter's `records` field is NOT kept: ESPN serves the
record as of the request, not as of the bout, so it would carry hindsight.

Finished months never change: once a month's file holds only completed or
cancelled bouts it is not fetched again. The month in progress always is.

`athletes` reads one thing per fighter from ESPN's public athlete document:
the date of birth (a fixed fact, so an age at any bout is point in time).
Nothing else in that document is kept: its record, weight and rank are as of
the request. A fighter already on file with a date is not fetched again.

`records` keeps each fighter's professional record as ESPN shows it at one
stated time (`as_of`): the scoreboard feed the simulator refreshes daily
(simulator/data/feeds/ufc_bouts.json.gz, every month refetched in one run).
That record is a fact as of `as_of` only. The model never reads it as the
record at an earlier bout: factors.py backs out every bout in the data
between the bout and `as_of` (see there for what that cannot see).
"""
import argparse
import csv
import glob
import gzip
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
RAW = os.path.join(ROOT, ".cache", "model_loop", "ufc", "raw")
PACK_RAW = os.path.join(ROOT, "datapack", "quant_v1", "data", "ufc", "raw")
OUT = os.path.join(ROOT, "model_loop", "data", "ufc", "bouts.csv")
FIGHTERS = os.path.join(ROOT, "model_loop", "data", "ufc", "fighters.csv")
URL = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={month}&limit=1000"
ATHLETE_URLS = ["https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/{id}",
                "https://sports.core.api.espn.com/v2/sports/mma/athletes/{id}"]
FIGHTER_FIELDS = ["fighter_id", "name", "date_of_birth", "source", "fetched_at"]
RECORDS = os.path.join(ROOT, "model_loop", "data", "ufc", "records.csv")
HISTORY = os.path.join(ROOT, "model_loop", "data", "ufc", "espn_fight_history.json.gz")
OVERVIEW_URL = "https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/{id}/overview"
SIM_FEED = os.path.join(ROOT, "simulator", "data", "feeds", "ufc_bouts.json.gz")
FIELDS = ["bout_id", "event_id", "event_name", "start_time", "fighter_a_id", "fighter_a", "fighter_b_id", "fighter_b",
          "a_winner", "b_winner", "status", "status_detail", "round", "clock", "format_json", "weight_class"]
DONE = {"STATUS_FINAL", "STATUS_CANCELED", "STATUS_POSTPONED", "STATUS_NO_CONTEST"}


def parse(j):
    """Bout rows from one scoreboard response, exactly as the data pack read them."""
    rows = []
    for e in j.get("events", []):
        for m in e.get("competitions", []):
            cs = m.get("competitors", [])
            if len(cs) != 2:
                continue
            a, b = cs
            st = m.get("status", {}) or {}
            rows.append({"bout_id": m.get("id"), "event_id": e.get("id"), "event_name": e.get("name"),
                         "start_time": m.get("date") or e.get("date"),
                         "fighter_a_id": a.get("id"), "fighter_a": (a.get("athlete") or {}).get("displayName"),
                         "fighter_b_id": b.get("id"), "fighter_b": (b.get("athlete") or {}).get("displayName"),
                         "a_winner": a.get("winner"), "b_winner": b.get("winner"),
                         "status": (st.get("type") or {}).get("name"), "status_detail": (st.get("type") or {}).get("detail"),
                         "round": st.get("period"), "clock": st.get("displayClock"),
                         "format_json": json.dumps(m.get("format")),
                         "weight_class": (m.get("type") or {}).get("abbreviation")})
    return rows


def _months(first_year, now):
    out = []
    for y in range(first_year, now.year + 1):
        for mth in range(1, 13):
            if (y, mth) > (now.year, now.month):
                break
            out.append(f"{y}{mth:02d}")
    return out


def _finished(path):
    try:
        rows = parse(json.load(gzip.open(path)))
    except Exception:
        return False
    return bool(rows) and all(r["status"] in DONE for r in rows)


def fetch(first_year=2014, now=None, pause=1.0):
    now = now or datetime.now(timezone.utc)
    os.makedirs(RAW, exist_ok=True)
    got = skipped = failed = 0
    for month in _months(first_year, now):
        path = os.path.join(RAW, f"scoreboard_{month}.json.gz")
        current = month == f"{now.year}{now.month:02d}"
        if os.path.exists(path) and not current and _finished(path):
            skipped += 1
            continue
        req = urllib.request.Request(URL.format(month=month), headers={"Accept": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read()
                json.loads(body)
                with gzip.open(path, "wb") as f:
                    f.write(body)
                got += 1
                break
            except Exception as e:  # noqa: BLE001 - the month is retried, then reported
                if attempt == 2:
                    failed += 1
                    print(f"ufc fetch {month}: {e}", file=sys.stderr)
                time.sleep(2 ** attempt)
        time.sleep(pause)
    print(f"ufc fetch: {got} months fetched, {skipped} finished months kept, {failed} failed", file=sys.stderr)
    return failed


def build(raw_dirs=None, out=OUT):
    """Every month on file -> one row per bout (the newest response wins)."""
    raw_dirs = raw_dirs or [PACK_RAW, RAW]
    files = {}
    for d in raw_dirs:
        for p in glob.glob(os.path.join(d, "scoreboard_*.json.gz")):
            files[os.path.basename(p)] = p           # the cache wins over the pack for the same month
    rows = {}
    for name in sorted(files):
        for r in parse(json.load(gzip.open(files[name]))):
            rows[r["bout_id"]] = r
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ordered = sorted(rows.values(), key=lambda r: (str(r["start_time"]), str(r["bout_id"])))
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in ordered:
            w.writerow(r)
    print(f"ufc build: {len(ordered)} bouts from {len(files)} months -> {os.path.relpath(out, ROOT)}", file=sys.stderr)
    return ordered


def _dob(doc):
    """the date of birth (YYYY-MM-DD) in either ESPN athlete document, else None"""
    a = doc.get("athlete", doc) if isinstance(doc, dict) else {}
    v = a.get("dateOfBirth") or a.get("birthDate")
    return str(v)[:10] if v and len(str(v)) >= 10 and str(v)[4] == "-" else None


def athletes(bouts=OUT, out=FIGHTERS, pause=0.25, limit=None):
    """Every fighter in the bouts: the date of birth from ESPN (kept rows are not refetched)."""
    ids = {}
    with open(bouts, newline="") as f:
        for r in csv.DictReader(f):
            for k, n in (("fighter_a_id", "fighter_a"), ("fighter_b_id", "fighter_b")):
                if r[k]:
                    ids[r[k]] = r[n]
    have = {}
    if os.path.exists(out):
        with open(out, newline="") as f:
            have = {r["fighter_id"]: r for r in csv.DictReader(f)}
    todo = [i for i in sorted(ids) if not (have.get(i) or {}).get("date_of_birth")]
    if limit:
        todo = todo[:limit]
    got = missing = failed = 0
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for fid in todo:
        row = {"fighter_id": fid, "name": ids[fid], "date_of_birth": "", "source": "", "fetched_at": stamp}
        errored = False
        for url in ATHLETE_URLS:
            req = urllib.request.Request(url.format(id=fid), headers={"Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    dob = _dob(json.loads(r.read()))
            except Exception:  # noqa: BLE001 - the next host is tried, then the fighter is counted as failed
                dob, errored = None, True
            if dob:
                row.update(date_of_birth=dob, source=url.split("/apis/")[0].split("/v2/")[0])
                break
        if row["date_of_birth"]:
            got += 1
        elif errored:
            failed += 1
        else:
            missing += 1
        have[fid] = row
        time.sleep(pause)
    for fid, n in ids.items():
        have.setdefault(fid, {"fighter_id": fid, "name": n, "date_of_birth": "", "source": "", "fetched_at": ""})
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIGHTER_FIELDS)
        w.writeheader()
        for fid in sorted(have):
            w.writerow({k: have[fid].get(k, "") for k in FIGHTER_FIELDS})
    with_dob = sum(1 for r in have.values() if r.get("date_of_birth"))
    print(f"ufc athletes: {got} dates fetched, {missing} without a date, {failed} failed; "
          f"{with_dob} of {len(have)} fighters have a date of birth -> {os.path.relpath(out, ROOT)}", file=sys.stderr)
    return failed


def records(feed=SIM_FEED, out=RECORDS):
    """fighter id -> the W-L-D record ESPN shows as of the feed's fetch time (one time for every fighter)"""
    j = json.load(gzip.open(feed))
    as_of = j.get("fetched_at")
    if not as_of or j.get("unread"):
        raise SystemExit(f"ufc records: the feed has no fetch time or unread months ({j.get('unread')}): every month must be read in one run")
    rec, names = {}, {}
    for b in j.get("bouts", []):
        for side in ("a", "b"):
            fid, r = b.get(side + "_id"), b.get(side + "_record")
            if fid and isinstance(r, str) and r.count("-") == 2 and all(x.isdigit() for x in r.split("-")):
                rec[str(fid)] = r
                names[str(fid)] = b.get(side)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["fighter_id", "name", "record", "as_of"])
        w.writeheader()
        for fid in sorted(rec):
            w.writerow({"fighter_id": fid, "name": names[fid], "record": rec[fid], "as_of": as_of})
    print(f"ufc records: {len(rec)} fighters' records as of {as_of} -> {os.path.relpath(out, ROOT)}", file=sys.stderr)
    return len(rec)


def history(bouts=OUT, out=HISTORY, pause=0.2, limit=None):
    """Every fighter's fight history as ESPN's athlete overview lists it (dated bouts, any promotion), kept as ESPN
    sends it: factors.py reads the bouts dated before a fighter's first UFC bout in the data, which no later result
    changes. A fighter already on file is not fetched again."""
    ids = set()
    with open(bouts, newline="") as f:
        for r in csv.DictReader(f):
            ids.update(x for x in (r["fighter_a_id"], r["fighter_b_id"]) if x)
    doc = json.load(gzip.open(out)) if os.path.exists(out) else {"schema": "edgedesk_ufc_espn_fight_history_v1", "fighters": {}}
    todo = [i for i in sorted(ids) if i not in doc["fighters"]]
    if limit:
        todo = todo[:limit]
    got = failed = 0
    for fid in todo:
        req = urllib.request.Request(OVERVIEW_URL.format(id=fid), headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
            doc["fighters"][fid] = {"fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "fightHistory": j.get("fightHistory")}
            got += 1
        except Exception:  # noqa: BLE001 - counted; the next run tries the fighter again
            failed += 1
        time.sleep(pause)
    doc["source"] = OVERVIEW_URL
    with gzip.open(out, "wt") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"ufc history: {got} fetched, {failed} failed; {len(doc['fighters'])} fighters on file -> {os.path.relpath(out, ROOT)}", file=sys.stderr)
    return failed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "build", "athletes", "records", "history"])
    ap.add_argument("--from", dest="first", type=int, default=2014)
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args(argv)
    if a.cmd == "fetch":
        sys.exit(1 if fetch(a.first) else 0)
    if a.cmd == "athletes":
        athletes(limit=a.limit)
        return
    if a.cmd == "records":
        records()
        return
    if a.cmd == "history":
        history(limit=a.limit)
        return
    build()


if __name__ == "__main__":
    main()
