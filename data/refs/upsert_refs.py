#!/usr/bin/env python3
"""Upsert NFL referee data into Supabase over the REST API (PostgREST).

  python3 data/refs/upsert_refs.py              the one-time seed: the CSVs committed in data/refs/
  python3 data/refs/upsert_refs.py --dir OUT    the weekly sync: what build_ref_data.py wrote to OUT
  python3 data/refs/upsert_refs.py --dry-run    read and check both files, write nothing

ref_assignments.csv goes FIRST, then ref_game_penalties.csv: every penalty row
references its game's assignment (supabase/nfl_ref_flags.sql). Both upsert on
game_id (on_conflict=game_id, resolution=merge-duplicates), so a re-run
rewrites the same rows and adds none.

Env: SB_URL and SB_SERVICE_ROLE, the secret names the repo's workflows use
(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read when those are unset).
The key is never printed. A malformed file, an HTTP error or a short count
stops the run with exit code 1 and the server's message. Standard library only.
"""
import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BATCH = 500

# (table, file, {column: type}, nullable columns), in load order
TABLES = [
    ("nfl_ref_assignments", "ref_assignments.csv",
     {"game_id": "text", "season": "int", "week": "int", "referee": "text", "source": "text"},
     set()),
    ("nfl_ref_game_penalties", "ref_game_penalties.csv",
     {"game_id": "text", "season": "int", "week": "int", "game_type": "text", "gameday": "text",
      "away_team": "text", "home_team": "text", "referee": "text",
      "total": "num", "total_line": "num", "spread_line": "num", "result": "num",
      "flags": "int", "accepted_flags": "int", "penalty_yards": "int", "home_flags": "int", "away_flags": "int",
      "off_holding": "int", "def_holding": "int", "dpi": "int", "opi": "int", "false_start": "int",
      "roughing_passer": "int", "unnecessary_roughness": "int", "illegal_contact": "int",
      "illegal_use_of_hands": "int", "snaps": "int", "holding_total": "int",
      "flags_per_100_snaps": "num", "went_over": "int"},
     {"gameday", "total", "total_line", "spread_line", "result", "flags_per_100_snaps", "went_over"}),
]
SOURCES = {"nflverse", "footballzebras", "manual"}


def fail(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def cell(raw, typ, where):
    v = (raw or "").strip()
    if v == "" or v.lower() == "nan":
        return None
    if typ == "text":
        return v
    try:
        f = float(v)
    except ValueError:
        fail(f"{where}: {v!r} is not a number")
    if not math.isfinite(f):
        fail(f"{where}: {v!r} is not a finite number")
    if typ == "int":
        if f != int(f):
            fail(f"{where}: {v!r} is not a whole number")
        return int(f)
    return f


def read(path, cols, nullable):
    if not os.path.exists(path):
        fail(f"{path} does not exist")
    with open(path, newline="") as fh:
        rd = csv.DictReader(fh)
        have = set(rd.fieldnames or [])
        if have != set(cols):
            fail(f"{path}: columns differ from the table: missing {sorted(set(cols) - have)}, unexpected {sorted(have - set(cols))}")
        rows, seen = [], set()
        for i, r in enumerate(rd, start=2):
            row = {c: cell(r[c], t, f"{os.path.basename(path)} line {i} {c}") for c, t in cols.items()}
            for c in cols:
                if row[c] is None and c not in nullable:
                    fail(f"{os.path.basename(path)} line {i}: {c} is empty")
            if row["game_id"] in seen:
                fail(f"{os.path.basename(path)} line {i}: game_id {row['game_id']} appears twice")
            seen.add(row["game_id"])
            if "source" in row and row["source"] not in SOURCES:
                fail(f"{os.path.basename(path)} line {i}: source {row['source']!r} is not one of {sorted(SOURCES)}")
            rows.append(row)
    return rows


def request(url, key, method="GET", body=None, prefer=None):
    headers = {"apikey": key, "Authorization": "Bearer " + key, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(3):
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")[:600]
            if e.code >= 500 and attempt < 2:
                time.sleep(2 ** (attempt + 1))
                continue
            return e.code, dict(e.headers or {}), text.encode()
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))
                continue
            fail(f"{method} {url.split('?')[0]}: {e.reason}")
    fail(f"{method} {url.split('?')[0]}: no answer")


def table_count(base, key, table):
    status, headers, body = request(f"{base}/rest/v1/{table}?select=game_id&limit=1", key, prefer="count=exact")
    if status >= 300:
        fail(f"counting {table}: HTTP {status}: {body.decode('utf-8', 'replace')}")
    rng = {k.lower(): v for k, v in headers.items()}.get("content-range", "")
    try:
        return int(rng.rsplit("/", 1)[1])
    except (IndexError, ValueError):
        fail(f"counting {table}: no row count in the answer (Content-Range {rng!r})")


def upsert(base, key, table, rows):
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        status, _, body = request(f"{base}/rest/v1/{table}?on_conflict=game_id", key, method="POST", body=chunk,
                                  prefer="resolution=merge-duplicates,return=minimal")
        if status >= 300:
            fail(f"upserting {table} rows {i + 1}-{i + len(chunk)}: HTTP {status}: {body.decode('utf-8', 'replace')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=HERE, help="folder holding ref_assignments.csv and ref_game_penalties.csv (default: data/refs/)")
    ap.add_argument("--dry-run", action="store_true", help="read and check the files, write nothing")
    a = ap.parse_args()

    loaded = [(table, read(os.path.join(a.dir, fn), cols, nullable)) for table, fn, cols, nullable in TABLES]
    assigned = {r["game_id"] for r in loaded[0][1]}
    orphans = sorted(r["game_id"] for r in loaded[1][1] if r["game_id"] not in assigned)
    if orphans:
        fail(f"ref_game_penalties.csv has {len(orphans)} game(s) with no row in ref_assignments.csv, e.g. {orphans[:3]}")
    for table, rows in loaded:
        seasons = {}
        for r in rows:
            seasons[r["season"]] = seasons.get(r["season"], 0) + 1
        print(f"{table}: {len(rows)} rows from {a.dir} " + json.dumps(dict(sorted(seasons.items()))))
    if a.dry_run:
        print("dry run: nothing written")
        return

    base = (os.environ.get("SB_URL") or os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SB_SERVICE_ROLE") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not base or not key:
        fail("set SB_URL and SB_SERVICE_ROLE (the project URL and its service-role key)")
    for table, rows in loaded:
        upsert(base, key, table, rows)
        n = table_count(base, key, table)
        if n < len(rows):
            fail(f"{table}: upserted {len(rows)} rows but the table holds {n}")
        print(f"{table}: upserted {len(rows)} rows on game_id; the table holds {n}")


if __name__ == "__main__":
    main()
