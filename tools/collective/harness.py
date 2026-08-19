#!/usr/bin/env python3
"""Model Collective CSV ingest harness.

Proves that a real-world creator CSV (the Section 9 shape: a result column
that means "the pick covered", moneyline and spread probabilities side by
side, offset cover probabilities, a v1-backfill version tag) maps cleanly
onto the Collective submission envelope BEFORE any UI matters.

Usage:
  python3 harness.py sample_moose_nfl.csv --dry-run     # default
  python3 harness.py sample_moose_nfl.csv --live        # real submission
  python3 harness.py --selftest                         # offline assertions

Auth and target come from --api/--key or env COLLECTIVE_API / COLLECTIVE_KEY.
With neither set, the mapping proof and envelopes still print (offline mode)
and nothing is sent. Standard library only: csv, json, urllib.

Exit codes: 0 clean (quarantine is not rejection), 2 any row rejected.
"""

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request

MAPPING = [
    # csv column, collective field, note
    ("season", "envelope.season", "grouped per envelope"),
    ("week", "rows[].week", "passed through"),
    ("date", "rows[].kickoff", "date only in the file; 13:00 ET placeholder hour added, resolution matches within 48h"),
    ("home", "rows[].home_team", "any alias the Collective knows: code, city, nickname, full name"),
    ("road", "rows[].away_team", "same alias handling"),
    ("line", "rows[].line_at_submission", "home convention, negative means home favored"),
    ("total", "rows[].projected_total", "the model's total"),
    ("result", "IGNORED", "rule 9.1: this means the pick covered, not who won; creator grading is never trusted, the Collective grades independently"),
    ("home_pts", "rows[].proj_home_score", "only on backfill rows where they are projections; blank on live rows"),
    ("road_pts", "rows[].proj_away_score", "same"),
    ("ml_prob_home", "rows[].home_win_probability", "moneyline probability, rule 9.2: never a cover probability"),
    ("cover_prob_m3", "IGNORED", "offset probability at line minus 3; only the at-line number submits"),
    ("cover_prob_0", "rows[].cover_probability", "cover probability at the listed line"),
    ("cover_prob_p3", "IGNORED", "offset probability at line plus 3"),
    ("version", "envelope.data_origin", "v1-backfill maps to backfill; everything else maps to live; rule 9.4: backfill is stored and shown separately, never ranked"),
    ("confidence", "rows[].confidence", "creator-defined scale, displayed in the creator's own context only"),
]

# The sample file carries no kickoff hour. 13:00 ET (17:00 UTC) is a
# placeholder; the Collective resolves by teams plus nearest kickoff within
# 48 hours, so the placeholder is safe.
PLACEHOLDER_HOUR_UTC = "17:00:00"


def read_rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def to_envelopes(rows):
    """One envelope per (data_origin, season). The result column and the
    offset probabilities never enter the output."""
    groups = {}
    for r in rows:
        origin = "backfill" if (r.get("version") or "").strip().startswith("v1-backfill") else "live"
        season = int(r["season"])
        key = (origin, season)
        row = {
            "game_ref": "NFL_%s_W%s_%s_%s" % (season, r["week"], r["road"].strip().replace(" ", ""), r["home"].strip().replace(" ", "")),
            "home_team": r["home"].strip(),
            "away_team": r["road"].strip(),
            "kickoff": "%sT%sZ" % (r["date"].strip(), PLACEHOLDER_HOUR_UTC),
            "week": int(r["week"]),
        }
        def num(col):
            v = (r.get(col) or "").strip()
            return float(v) if v else None
        if num("line") is not None:
            row["line_at_submission"] = num("line")
            row["projected_spread"] = num("line")
        if num("total") is not None:
            row["projected_total"] = num("total")
        if origin == "backfill":
            if num("home_pts") is not None:
                row["proj_home_score"] = num("home_pts")
            if num("road_pts") is not None:
                row["proj_away_score"] = num("road_pts")
        if num("ml_prob_home") is not None:
            row["home_win_probability"] = num("ml_prob_home")
        if num("cover_prob_0") is not None and num("line") is not None:
            row["cover_probability"] = num("cover_prob_0")
            row["pick_side"] = "home" if num("cover_prob_0") >= 0.5 else "away"
        if num("confidence") is not None:
            row["confidence"] = num("confidence")
        groups.setdefault(key, []).append(row)

    return [
        {"sport": "NFL", "season": season, "data_origin": origin, "rows": rws}
        for (origin, season), rws in sorted(groups.items())
    ]


def print_mapping():
    print("FIELD MAPPING (csv column -> collective field)")
    print("-" * 78)
    for col, field, note in MAPPING:
        print("  %-14s -> %-28s %s" % (col, field, note))
    print("-" * 78)


def post(api, key, path, envelope):
    req = urllib.request.Request(
        api.rstrip("/") + path,
        data=json.dumps(envelope).encode(),
        headers={"x-collective-key": key, "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": {"message": str(e)}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default=os.path.join(os.path.dirname(__file__) or ".", "sample_moose_nfl.csv"))
    ap.add_argument("--live", action="store_true", help="submit for real instead of dry-run")
    ap.add_argument("--dry-run", action="store_true", help="default behavior, kept for clarity")
    ap.add_argument("--api", default=os.environ.get("COLLECTIVE_API", ""))
    ap.add_argument("--key", default=os.environ.get("COLLECTIVE_KEY", ""))
    ap.add_argument("--sport", default="NFL")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    rows = read_rows(args.csv)
    envelopes = to_envelopes(rows)

    if args.selftest:
        by_origin = {}
        for e in envelopes:
            by_origin[e["data_origin"]] = by_origin.get(e["data_origin"], 0) + len(e["rows"])
        assert by_origin.get("backfill") == 14, "wanted 14 backfill rows, got %s" % by_origin.get("backfill")
        assert by_origin.get("live") == 6, "wanted 6 live rows, got %s" % by_origin.get("live")
        blob = json.dumps(envelopes)
        assert '"result"' not in blob, "the creator result column leaked into the payload (rule 9.1)"
        assert "cover_prob_m3" not in blob and "cover_prob_p3" not in blob, "offset probabilities leaked"
        for e in envelopes:
            for r in e["rows"]:
                if "cover_probability" in r:
                    assert "line_at_submission" in r, "cover probability without its line (rule 9.3)"
        print("SELFTEST PASS: 14 backfill + 6 live rows, result column and offsets excluded")
        return 0

    print_mapping()
    for e in envelopes:
        print("\nENVELOPE data_origin=%s season=%s rows=%d" % (e["data_origin"], e["season"], len(e["rows"])))
        print(json.dumps(e, indent=2))

    if not args.api or not args.key:
        print("\nOFFLINE MODE: no --api/--key (or COLLECTIVE_API/COLLECTIVE_KEY) set.")
        print("The mapping proof above is complete; nothing was sent.")
        return 0

    path = "/collective_ingest/v1/projections" + ("" if args.live else "/dry-run")
    rejected = 0
    for e in envelopes:
        status, body = post(args.api, args.key, path, e)
        print("\nPOST %s (%s, season %s) -> HTTP %s" % (path, e["data_origin"], e["season"], status))
        if status != 200:
            print(json.dumps(body, indent=2))
            rejected += 1
            continue
        counts = body.get("counts", {})
        print("counts:", json.dumps(counts))
        for r in body.get("rows", []):
            flag = {"resolved": "ok ", "late": "LATE", "quarantined": "QUAR", "rejected": "REJ "}.get(r.get("status"), "?   ")
            print("  [%s] %-28s %s" % (flag, r.get("game_ref"), r.get("reason") or ""))
        rejected += counts.get("rejected", 0)

    if rejected:
        print("\n%d row(s) rejected. Fix the mapping and rerun. Quarantined rows are fine: a human resolves them." % rejected)
        return 2
    print("\nAll rows accepted (quarantine, if any, resolves on the admin side).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
