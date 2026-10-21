"""Is every learning loop alive, current and fed? The answer for the app.

  python3 -m model_loop.health            # writes model_loop/health.json
  python3 -m model_loop.health --check    # exit 1 when a loop in season is not OK

Read only: it looks at what each loop committed (versions, the published
numbers, the weekly research, the live ratings) and never runs a model.

Per loop:
  status      OK | STALE | DEGRADED | OFF_SEASON | NOT_SERVED (no version has
              cleared its preregistered rule, so the loop publishes nothing)
  reasons     every rule that fired, in words
  served      the version in use and since when
  refreshed   when the served version last re-fitted on new results
  researched  when the weekly research last ran (and whether it promoted)
  data        the newest result the ratings have seen, and the data_status the
              refresh stamped on its cards (football)

The rules, in season:
  DEGRADED  the refresh stamped its cards DEGRADED (results missing, cards
            that do not reconcile), or the served version is not in the history
  STALE     no refresh within 36 hours; no research within 8 days (once the
            loop is 8 days old); or the newest result is over 4 days old while
            games are being played
Out of season (by the calendar, unless results are still arriving) a loop is
OFF_SEASON and nothing is expected of it.
"""
import argparse
import csv
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "model_loop", "health.json")

# id, label, months in season, where its outputs live
LOOPS = [
    {"id": "nfl", "label": "NFL", "months": {9, 10, 11, 12, 1, 2}, "kind": "football",
     "workflow": ".github/workflows/model-loop-nfl.yml"},
    {"id": "cfb", "label": "College football", "months": {8, 9, 10, 11, 12, 1}, "kind": "football",
     "workflow": ".github/workflows/model-loop-cfb.yml"},
    {"id": "nba", "label": "NBA", "months": {10, 11, 12, 1, 2, 3, 4, 5, 6}, "kind": "basketball",
     "workflow": ".github/workflows/model-loop-basketball.yml"},
    {"id": "wnba", "label": "WNBA", "months": {5, 6, 7, 8, 9}, "kind": "basketball",
     "workflow": ".github/workflows/model-loop-basketball.yml"},
    {"id": "ncaam", "label": "Men's college basketball", "months": {11, 12, 1, 2, 3, 4}, "kind": "basketball",
     "workflow": ".github/workflows/model-loop-basketball.yml"},
    {"id": "ncaaw", "label": "Women's college basketball", "months": {11, 12, 1, 2, 3, 4}, "kind": "basketball",
     "workflow": ".github/workflows/model-loop-basketball.yml"},
    # cards most weekends all year; refreshed Thursday to Sunday, so up to four days apart
    {"id": "ufc", "label": "UFC", "months": set(range(1, 13)), "kind": "ufc", "refresh_max_h": 108,
     "workflow": ".github/workflows/model-loop-ufc.yml"},
    # the two preregistered engines: their own protocols choose their numbers; the
    # loop grades them weekly and watches their builds (model_loop/adapters/engines)
    {"id": "nhl", "label": "NHL engine", "months": {10, 11, 12, 1, 2, 3, 4, 5, 6}, "kind": "engine",
     "workflow": ".github/workflows/model-loop-engines.yml"},
    {"id": "nba_engine", "label": "NBA engine", "months": {10, 11, 12, 1, 2, 3, 4, 5, 6}, "kind": "engine",
     "workflow": ".github/workflows/model-loop-engines.yml"},
]
REFRESH_MAX_H = 36
RESEARCH_MAX_D = 8
RESULTS_MAX_D = 4


def _read(path):
    try:
        with open(os.path.join(ROOT, path)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _ts(s):
    if not s:
        return None
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        try:
            t = datetime.strptime(str(s)[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _age_h(t, now):
    return None if t is None else round((now - t).total_seconds() / 3600, 1)


def _latest_research(lid):
    files = sorted(glob.glob(os.path.join(ROOT, "docs", "model-loop", lid, "weekly", "*.json")))
    if not files:
        return None
    d = _read(os.path.relpath(files[-1], ROOT)) or {}
    return {"file": os.path.relpath(files[-1], ROOT), "at": d.get("at"), "promoted": d.get("promoted"),
            "candidates": len([c for c in d.get("candidates") or [] if c.get("decision") != "SKIPPED"])}


def _season_games(lid, season):
    """The date of every game in the lab's season file (basketball/data/<lid>/<season>.csv), or
    None when there is no such file. Postponed games are not in it (basketball/ingest.js keeps FINAL
    and SCHEDULED only), so a past-dated SCHEDULED row is a result that has not arrived."""
    if not season:
        return None
    try:
        with open(os.path.join(ROOT, "basketball", "data", lid, f"{season}.csv"), newline="") as f:
            return [str(r.get("date") or "")[:10] for r in csv.DictReader(f) if r.get("date")]
    except OSError:
        return None


def engine_health(L, now):
    """An engine with its own protocol: no version history here (the engine's validation file
    and slate say what is served), so it is judged on its build, its weekly validation, the
    weekly report and whether its results arrive."""
    from .adapters.engines import weekly as EW
    lid, eng = L["id"], EW.ENGINES[L["id"]]
    reasons = []
    slate = _read(eng["slate"]) or {}
    val = _read(eng["validation"]) or {}
    model = slate.get("model")
    version = (model.get("id") or model.get("chosen")) if isinstance(model, dict) else model
    refreshed, validated = _ts(slate.get("generated_at")), _ts(val.get("generated_at"))
    if not slate:
        reasons.append(("DEGRADED", f"no slate ({eng['slate']})"))
    if not val:
        reasons.append(("DEGRADED", f"no validation record ({eng['validation']})"))
    dc = EW.data_check(lid, now)
    near = [g for g in dc.get("starts") or [] if -14 <= (g - now).days <= RESULTS_MAX_D]
    in_season = now.month in L["months"] or bool(near)
    research = _latest_research(lid)
    if in_season:
        a = _age_h(refreshed, now)
        if a is None or a > REFRESH_MAX_H:
            reasons.append(("STALE", "no slate build on record" if a is None else
                            f"last slate build {a:.0f} h ago (expected within {REFRESH_MAX_H} h)"))
        if validated is not None and (now - validated).days > RESEARCH_MAX_D:
            reasons.append(("STALE", f"last weekly validation {(now - validated).days} days ago (expected weekly)"))
        r_at = _ts(research and research.get("at"))
        if r_at is not None and (now - r_at).days > RESEARCH_MAX_D:
            reasons.append(("STALE", f"last weekly report {(now - r_at).days} days ago (expected weekly)"))
        if dc["missing_results"]:
            m = dc["missing_results"]
            reasons.append(("STALE", f"{len(m)} game(s) the engine priced started more than {EW.RESULT_GRACE_H} h ago "
                                     f"and have no result (the first: {m[0]['game_id']} at {m[0]['start_utc']})"))
    order = {"DEGRADED": 0, "STALE": 1}
    if any(k == "DEGRADED" for k, _ in reasons):
        status = "DEGRADED"
    elif not in_season:
        status = "OFF_SEASON"
    else:
        status = min((k for k, _ in reasons), key=lambda k: order[k]) if reasons else "OK"
    return {"id": lid, "label": L["label"], "status": status, "in_season": in_season,
            "reasons": [r for _, r in reasons],
            "served": {"version": version, "since": val.get("generated_at"),
                       "promoted_by": f"its own protocol ({eng['protocol']})"} if version else None,
            "refreshed_at": refreshed.strftime("%Y-%m-%dT%H:%M:%SZ") if refreshed else None,
            "refreshed_age_h": _age_h(refreshed, now), "research": research,
            "data": {"graded": dc.get("graded"), "games_priced": dc.get("games_priced"),
                     "missing_results": len(dc["missing_results"]), "unpriced": len(dc["unpriced"]),
                     "validated_at": val.get("generated_at")},
            "workflow": L["workflow"]}


def loop_health(L, now):
    lid = L["id"]
    if L["kind"] == "engine":
        return engine_health(L, now)
    reasons = []
    vers = _read(f"docs/model-loop/{lid}/versions.json")
    served = None
    if vers or L["kind"] == "ufc":
        vers = vers or {"versions": [], "current": None}
        cur = next((v for v in vers.get("versions") or [] if v.get("version") == vers.get("current")), None)
        if cur is None and L["kind"] == "ufc":
            pass                                          # no version until the preregistered backtest has run
        elif cur is None:
            reasons.append(("DEGRADED", f"the served version {vers.get('current')} is not in docs/model-loop/{lid}/versions.json"))
        else:
            served = {"version": cur["version"], "since": cur.get("promoted_at"), "promoted_by": cur.get("promoted_by"),
                      "versions": len(vers.get("versions") or [])}
    else:
        reasons.append(("DEGRADED", f"no version history (docs/model-loop/{lid}/versions.json)"))

    refreshed = newest = data = not_served = games = None
    if L["kind"] == "football":
        cur_json = _read(f"football/{lid}/model_loop/current.json")
        if cur_json:
            refreshed = _ts(cur_json.get("generated_at"))
            ds = cur_json.get("data_status")
            data = {"games_published": len(cur_json.get("games") or []), "data_status": ds}
            if ds and ds.get("status") == "DEGRADED":
                reasons += [("DEGRADED", r) for r in ds.get("reasons") or []]
            rec = _read(f"football/{lid}/model_loop/record_{cur_json.get('season')}.json") or {}
            graded = [g for g in rec.get("games") or [] if g.get("result") is not None]
            data["graded_games"] = len(graded)
        else:
            reasons.append(("DEGRADED", f"no published numbers (football/{lid}/model_loop/current.json)"))
    elif L["kind"] == "ufc":
        cur_json = _read("model_loop/published/ufc/current.json")
        if cur_json:
            refreshed = _ts(cur_json.get("generated_at"))
            ds = cur_json.get("data_status")
            data = {"bouts_published": len(cur_json.get("bouts") or []), "data_status": ds, "served": cur_json.get("served")}
            if ds and ds.get("status") == "DEGRADED":
                reasons += [("DEGRADED", r) for r in ds.get("reasons") or []]
            if not cur_json.get("served"):
                served = None
                not_served = cur_json.get("reason") or "no version is served"
        else:
            reasons.append(("DEGRADED", "no published file (model_loop/published/ufc/current.json)"))
    else:
        live = _read(f"basketball/params/{lid}_live.json")
        if live:
            refreshed = _ts(live.get("generated_at"))
            newest = _ts(live.get("last_game_date"))
            data = {"last_game_date": live.get("last_game_date"), "for_season": live.get("for_season")}
            games = _season_games(lid, live.get("for_season"))
        else:
            reasons.append(("DEGRADED", f"no live ratings (basketball/params/{lid}_live.json)"))

    research = _latest_research(lid)
    # in season by the calendar, or because the schedule has games from two weeks
    # ago to RESULTS_MAX_D days ahead (a final that runs past the usual months; a
    # final whose result never arrives stays flagged for ten days)
    near = [d for d in games or [] if -14 <= (_ts(d) - now).days <= RESULTS_MAX_D] if games else []
    in_season = (now.month in L["months"] or (newest is not None and (now - newest).days <= RESULTS_MAX_D)
                 or bool(near))
    if in_season:
        a = _age_h(refreshed, now)
        lim = L.get("refresh_max_h", REFRESH_MAX_H)
        if a is None or a > lim:
            reasons.append(("STALE", "no refresh on record" if a is None else
                            f"last refresh {a:.0f} h ago (expected within {lim} h)"))
        loop_age_d = (now - _ts(served["since"])).days if served and _ts(served.get("since")) else 0
        r_at = _ts(research and research.get("at"))
        if r_at is None and loop_age_d >= RESEARCH_MAX_D:
            reasons.append(("STALE", "the weekly research has never run"))
        elif r_at is not None and (now - r_at).days > RESEARCH_MAX_D:
            reasons.append(("STALE", f"last weekly research {(now - r_at).days} days ago (expected weekly)"))
        if games is not None:
            # against the season's own schedule: stale only when games played more than
            # RESULTS_MAX_D days ago are not in the ratings (so not on opening night, when
            # the newest result is still last season's)
            cutoff = (now - timedelta(days=RESULTS_MAX_D)).date().isoformat()
            last = newest.date().isoformat() if newest is not None else ""
            due = sorted(d for d in games if last < d <= cutoff)
            if due:
                reasons.append(("STALE", f"{len(due)} game(s) played more than {RESULTS_MAX_D} days ago are not in the "
                                         f"ratings (the first on {due[0]}); the newest result is from {last or 'no game'}"))
        elif newest is not None and (now - newest).days > RESULTS_MAX_D:
            reasons.append(("STALE", f"the newest result in the ratings is from {newest.date()}, "
                                     f"{(now - newest).days} days ago"))
    order = {"DEGRADED": 0, "STALE": 1}
    if not_served and not any(k == "DEGRADED" for k, _ in reasons):
        status = "NOT_SERVED"
        reasons = [("NOT_SERVED", not_served)]
    elif not in_season and not any(k == "DEGRADED" for k, _ in reasons):
        status = "OFF_SEASON"
    elif reasons:
        status = min((k for k, _ in reasons), key=lambda k: order[k])
    else:
        status = "OK"
    return {"id": lid, "label": L["label"], "status": status, "in_season": in_season,
            "reasons": [r for _, r in reasons], "served": served,
            "refreshed_at": refreshed.strftime("%Y-%m-%dT%H:%M:%SZ") if refreshed else None,
            "refreshed_age_h": _age_h(refreshed, now), "research": research, "data": data,
            "workflow": L["workflow"]}


def build(now=None):
    now = now or datetime.now(timezone.utc)
    loops = [loop_health(L, now) for L in LOOPS]
    summary = {k: sum(1 for x in loops if x["status"] == k) for k in ("OK", "STALE", "DEGRADED", "OFF_SEASON", "NOT_SERVED")}
    worst = "DEGRADED" if summary["DEGRADED"] else "STALE" if summary["STALE"] else "OK"
    return {"schema": "edgedesk_model_loop_health_v1", "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": worst, "summary": summary,
            "rules": {"refresh_max_hours": REFRESH_MAX_H, "research_max_days": RESEARCH_MAX_D, "results_max_days": RESULTS_MAX_D},
            "note": "Each learning loop's served version, when it last re-fitted and researched, and whether its data "
                    "is complete. A DEGRADED loop's cards say why; nothing here changes a number.",
            "loops": loops}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    h = build()
    with open(OUT, "w") as f:
        json.dump(h, f, indent=1)
    for x in h["loops"]:
        print(f"{x['label']:<28} {x['status']:<10} " + ("; ".join(x["reasons"]) or "—"), file=sys.stderr)
    if a.check and h["status"] != "OK":
        sys.exit(1)


if __name__ == "__main__":
    main()
