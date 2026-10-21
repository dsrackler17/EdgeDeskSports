"""UFC bouts from ESPN's public scoreboard, one month at a time.

  python3 -m model_loop.adapters.ufc.ingest fetch [--from 2014]   # network: GitHub runners
  python3 -m model_loop.adapters.ufc.ingest build                 # raw months -> model_loop/data/ufc/bouts.csv

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
URL = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={month}&limit=1000"
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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "build"])
    ap.add_argument("--from", dest="first", type=int, default=2014)
    a = ap.parse_args(argv)
    if a.cmd == "fetch":
        sys.exit(1 if fetch(a.first) else 0)
    build()


if __name__ == "__main__":
    main()
