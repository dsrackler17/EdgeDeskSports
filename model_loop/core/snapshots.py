"""Append-only rating snapshots: a committed JSONL ledger per sport and
season (model_loop/ledger/<sport>/<season>.jsonl), mirrored to
public.model_rating_snapshots (supabase/model_loop.sql).

A row's id is a hash of its content, so writing the same snapshot twice is a
no-op, and a row is never rewritten: a refit for the same slate with a new
configuration or new data is a NEW row (different config hash or values).
"""
import hashlib
import json
import os


def row_id(row):
    body = {k: row[k] for k in sorted(row) if k not in ("snapshot_id", "fitted_at")}
    return "mls_" + hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:32]


def _r(x):
    return None if x is None else round(float(x), 6)


def rows_from_nfl_snapshot(snap, season, week, model_key, model_version, config_sha, fitted_at):
    """One NFL weekly snapshot (ratings.NflRatingPass._snapshot) -> ledger rows."""
    out = []
    for team, r in snap["teams"].items():
        ratings = {k: _r(r[k]) for k in ("pass_off", "pass_def", "rush_off", "rush_def", "market", "total") if r.get(k) is not None}
        prior = {k: _r(r[k + "_prior"]) for k in ("pass_off", "pass_def", "rush_off", "rush_def") if r.get(k + "_prior") is not None}
        season_part = {k: _r(ratings[k] - prior[k]) for k in prior}
        out.append({"sport": "NFL", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                    "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "team",
                    "entity_id": team, "ratings": ratings, "from_prior": prior, "from_season": season_part})
    for q, v in snap["qb"].items():
        out.append({"sport": "NFL", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                    "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "player",
                    "entity_id": q, "ratings": {"qb": _r(v)}, "from_prior": {}, "from_season": {}})
    out.append({"sport": "NFL", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "league",
                "entity_id": "NFL", "ratings": {"mu_pass": _r(snap["mu"]["pass"]), "mu_rush": _r(snap["mu"]["rush"]),
                                                "home_epa_pass": _r(snap["home_epa"]["pass"]), "home_epa_rush": _r(snap["home_epa"]["rush"]),
                                                "market_home": _r(snap.get("market_base")), "total_base": _r(snap.get("total_base"))},
                "from_prior": {}, "from_season": {}})
    for r in out:
        r["snapshot_id"] = row_id(r)
    return out


def append(ledger_path, rows):
    """Append rows whose id is not yet in the ledger; never rewrite."""
    os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
    seen = set()
    if os.path.exists(ledger_path):
        with open(ledger_path) as f:
            for line in f:
                if line.strip():
                    seen.add(json.loads(line)["snapshot_id"])
    new = [r for r in rows if r["snapshot_id"] not in seen]
    with open(ledger_path, "a") as f:
        for r in new:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    return len(new)
