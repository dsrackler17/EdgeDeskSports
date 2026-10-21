"""The weekly accountability report for the two preregistered engines: the NHL
engine (hockey/) and the NBA engine (nba/). READ ONLY: it changes no number.

  python3 -m model_loop.adapters.engines.weekly report [--engine nhl|nba_engine|all] [--now ISO]

Both engines choose their own models and hyperparameters under a written
protocol: hockey/model/walkforward.js (rules 1-7: the ratings' hyperparameters
are chosen on the SELECTION window alone, CONFIRMATION is "reported, never
used to choose") and nba/model/walkforward.js (a test window unsealed under a
frozen spec; any change to the tuning re-seals it). A loop that changed their
numbers week to week would break those protocols, so this one does not. Each
week it:

  1. grades the last record each engine published BEFORE every game (the rule
     hockey/grade_ledger.js and nba/grade_ledger.js use) against the result;
  2. says whether the season so far is what the engine's own out-of-sample
     record promised (NHL: the CONFIRMATION window; NBA: the unsealed TEST
     window), and whether it beats the constant home-win rate that record
     measured;
  3. tests the patterns the other loops' research ranks (favourites,
     underdogs, back-to-backs, the goalie or rotation the price assumed,
     totals). A pattern with n >= 30 and |t| >= 2 is written down as a
     research question for the engine's next protocol amendment, never
     applied;
  4. names games the ledger priced that have no result 36 hours after the
     start, and finished games the engine published nothing for beforehand.

Per engine:
  docs/model-loop/<engine>/weekly/<date>.json   (edgedesk_engine_week_v1)
  docs/model-loop/<engine>/weekly_model_report.md
"""
import argparse
import csv
import glob
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

from ...core import metrics as M

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MIN_PATTERN_N = 30
PATTERN_T = 2.0
RESULT_GRACE_H = 36
B2B_HOURS = 30


def _ts(s):
    if not s:
        return None
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _read(rel):
    try:
        with open(os.path.join(ROOT, rel)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _r(x, k=5):
    return None if x is None else round(float(x), k)


# ---------------------------------------------------------------- the engines
def _nhl_results(season):
    """{game_id: result} and the schedule of every game on file, from the home rows of
    hockey/data/team_games/<season>/*.csv (the table hockey/grade_ledger.js joins)."""
    res, sched = {}, {}
    for p in sorted(glob.glob(os.path.join(ROOT, "hockey", "data", "team_games", str(season), "*.csv"))):
        with open(p, newline="") as f:
            for r in csv.DictReader(f):
                if r.get("home") != "1":
                    continue
                gid = str(r["game_id"])
                sched[gid] = (r.get("start_utc"), r.get("team"), r.get("opp"))
                gf, ga = _num(r.get("gf")), _num(r.get("ga"))
                if gf is None or ga is None:
                    continue
                res[gid] = {"y": 1.0 if r.get("win") == "1" else 0.0, "total": gf + ga, "margin": gf - ga,
                            "decided": r.get("decided")}
    return res, sched


def _nba_results(season):
    """{game_id: result} and the schedule, from nba/data/games/<season>.csv (FINAL rows)."""
    res, sched = {}, {}
    p = os.path.join(ROOT, "nba", "data", "games", f"{season}.csv")
    if not os.path.exists(p):
        return res, sched
    with open(p, newline="") as f:
        for r in csv.DictReader(f):
            gid = str(r["game_id"])
            sched[gid] = (r.get("start_utc"), r.get("home_id"), r.get("away_id"))
            if r.get("status") != "FINAL":
                continue
            hs, as_ = _num(r.get("hs")), _num(r.get("as"))
            if hs is None or as_ is None:
                continue
            res[gid] = {"y": 1.0 if hs > as_ else 0.0, "total": hs + as_, "margin": hs - as_}
    return res, sched


def _nhl_expectation(v):
    chosen = v["selection"]["chosen"]
    c = v["windows"]["confirmation"]
    m = c["by_candidate"][chosen]
    ml = m["moneyline"]
    return {"window": f"confirmation {c['seasons'][0]}-{c['seasons'][1]}" if isinstance(c.get("seasons"), list) else "confirmation",
            "model": chosen, "n": m.get("n"), "moneyline_log_loss": ml["log_loss"], "moneyline_brier": ml.get("brier"),
            "home_rate": ml["climatology"]["rate"], "home_rate_log_loss": ml["climatology"]["log_loss"],
            "total_bias": (m.get("total_goals") or {}).get("mean_bias")}


def _nba_expectation(v):
    chosen = v["choice"]["P"]["chosen"]
    t = v["windows"]["test"][chosen]
    w = (v.get("protocol") or {}).get("windows", {}).get("test")
    home = v["windows"]["test"].get("home_only", {}).get("moneyline", {})
    # the test window's home-win rate, from the chosen model's calibration bins (observed x n)
    bins = [b for b in t["moneyline"].get("bins") or [] if b.get("n")]
    rate = round(sum(b["n"] * b["observed"] for b in bins) / sum(b["n"] for b in bins), 4) if bins else None
    return {"window": f"test {w[0]}-{w[1]}" if w else "test", "model": chosen, "n": t.get("n"),
            "moneyline_log_loss": t["moneyline"]["log_loss"], "moneyline_brier": t["moneyline"].get("brier"),
            "home_rate": rate, "home_rate_log_loss": home.get("log_loss"),
            "margin_mae": t["margin"]["mae"], "total_mae": t["total"]["mae"],
            "margin_bias": t["margin"].get("mean_bias"), "total_bias": t["total"].get("mean_bias")}


ENGINES = {
    "nhl": {"label": "NHL engine", "ledger_dir": "hockey/ledger", "slate": "hockey/slate.json",
            "validation": "hockey/validation/nhl_walkforward.json", "protocol": "hockey/model/walkforward.js",
            "results": _nhl_results, "expectation": _nhl_expectation, "assumption": ("goalie_certainty", "goalie the price assumed")},
    "nba_engine": {"label": "NBA engine", "ledger_dir": "nba/ledger", "slate": "nba/slate.json",
                   "validation": "nba/validation/nba_walkforward.json", "protocol": "nba/model/walkforward.js",
                   "results": _nba_results, "expectation": _nba_expectation, "assumption": ("rotation_stale", "rotation stale")},
}


def season_ledger(eng):
    """(season, records) of the newest season ledger, <ledger_dir>/<season>.jsonl."""
    files = [p for p in glob.glob(os.path.join(ROOT, eng["ledger_dir"], "*.jsonl"))
             if re.fullmatch(r"\d{4}\.jsonl", os.path.basename(p))]
    if not files:
        return None, []
    p = max(files)
    with open(p) as f:
        recs = [json.loads(line) for line in f if line.strip()]
    return int(os.path.basename(p)[:4]), recs


def pregame(recs):
    """The last record of each game made before its start (hockey/ and nba/grade_ledger.js)."""
    last = {}
    for r in recs:
        if not (str(r.get("recorded_at") or "") and _ts(r.get("recorded_at")) and _ts(r.get("start_utc"))):
            continue
        if not _ts(r["recorded_at"]) < _ts(r["start_utc"]):
            continue
        k = str(r["game_id"])
        if k not in last or r["recorded_at"] >= last[k]["recorded_at"]:
            last[k] = r
    return last


def back_to_back(sched):
    """{game_id: (home_b2b, away_b2b)}: a side played another game within B2B_HOURS before this one."""
    by_team = {}
    for gid, (start, h, a) in sched.items():
        t = _ts(start)
        if t is None:
            continue
        for side in (h, a):
            by_team.setdefault(side, []).append((t, gid))
    prev = {}
    for side, games in by_team.items():
        games.sort()
        for i, (t, gid) in enumerate(games):
            prev[(side, gid)] = i > 0 and (t - games[i - 1][0]) <= timedelta(hours=B2B_HOURS)
    return {gid: (prev.get((h, gid), False), prev.get((a, gid), False)) for gid, (_, h, a) in sched.items()}


def graded_rows(eng, season, recs):
    res, sched = eng["results"](season)
    b2b = back_to_back(sched)
    key = eng["assumption"][0]
    rows = []
    for gid, r in pregame(recs).items():
        x = res.get(gid)
        if x is None or _num(r.get("p_home")) is None:
            continue
        hb, ab = b2b.get(gid, (False, False))
        rows.append({"game_id": gid, "start_utc": r["start_utc"], "home": r.get("home"), "away": r.get("away"),
                     "model": r.get("model"), "p": float(r["p_home"]), "y": x["y"],
                     "exp_total": _num(r.get("exp_total")), "total": x["total"],
                     "exp_margin": _num(r.get("exp_margin")), "margin": x["margin"],
                     "assumption": r.get(key), "home_b2b": hb, "away_b2b": ab})
    rows.sort(key=lambda z: (z["start_utc"], z["game_id"]))
    return rows, res, sched


# --------------------------------------------------------------- the grading
def _ll(p, y):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, dtype=float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def summarize(rows):
    if not rows:
        return {"n": 0}
    p = np.array([z["p"] for z in rows])
    y = np.array([z["y"] for z in rows])
    out = {"n": len(rows), "log_loss": _r(M.logloss(p, y)), "brier": _r(M.brier(p, y)),
           "accuracy": _r(np.mean((p > 0.5) == (y > 0.5)), 4), "mean_p": _r(p.mean(), 4), "mean_y": _r(y.mean(), 4)}
    t = [(z["total"] - z["exp_total"]) for z in rows if z["exp_total"] is not None]
    if t:
        out["total_mae"] = _r(np.mean(np.abs(t)), 3)
        out["total_bias"] = _r(np.mean(t), 3)
    m = [(z["margin"] - z["exp_margin"]) for z in rows if z["exp_margin"] is not None]
    if m:
        out["margin_mae"] = _r(np.mean(np.abs(m)), 3)
        out["margin_bias"] = _r(np.mean(m), 3)
    return out


def vs_expectation(rows, exp):
    """Is the season's log loss what the engine's out-of-sample record promised?"""
    n = len(rows)
    if n < MIN_PATTERN_N:
        return {"verdict": "TOO_EARLY", "n": n, "expected": exp["moneyline_log_loss"],
                "note": f"fewer than {MIN_PATTERN_N} graded games"}
    ll = _ll([z["p"] for z in rows], [z["y"] for z in rows])
    se = ll.std(ddof=1) / math.sqrt(n)
    t = (ll.mean() - exp["moneyline_log_loss"]) / se if se > 0 else 0.0
    verdict = "WORSE_THAN_ITS_RECORD" if t >= PATTERN_T else "BETTER_THAN_ITS_RECORD" if t <= -PATTERN_T else "AS_EXPECTED"
    return {"verdict": verdict, "n": n, "season_log_loss": _r(ll.mean()), "expected": exp["moneyline_log_loss"],
            "expected_window": exp["window"], "t": _r(t, 2)}


def vs_home_rate(rows, rate):
    """Paired against a constant home-win rate (the climatology the record measured)."""
    if rate is None or len(rows) < 3:
        return None
    p = np.array([z["p"] for z in rows])
    y = np.array([z["y"] for z in rows])
    cmp = M.paired_logloss_test(p, np.full(len(p), rate), y)
    if cmp:
        cmp["home_rate"] = rate
        cmp["beats_it"] = bool(cmp["ci95"][1] < 0)
    return cmp


def _t_stat(v):
    v = np.asarray(v, dtype=float)
    if len(v) < 2:
        return None
    sd = v.std(ddof=1)
    return float(v.mean() / (sd / math.sqrt(len(v)))) if sd > 0 else None


def _binomial_z(p, y):
    """(won - priced) / sqrt(sum p(1-p)): how far the wins sit from the engine's own prices,
    in the standard deviations those prices imply. A t on 0/1 residuals is wrong here: ten
    favourites that all win have near-constant residuals and a t in the forties."""
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    var = float(np.sum(p * (1 - p)))
    return float((y.sum() - p.sum()) / math.sqrt(var)) if var > 0 else None


def patterns(rows, label):
    """Moneyline residual (won - priced) by pattern, tested with the binomial z under the
    engine's prices, and the totals residual (actual - expected), tested with a t. |stat| >= 2
    with n >= MIN_PATTERN_N is flagged as a research question."""
    groups = [
        ("all games", lambda z: True),
        ("home favourite (p >= 0.60)", lambda z: z["p"] >= 0.60),
        ("home underdog (p <= 0.40)", lambda z: z["p"] <= 0.40),
        ("near a coin flip (0.40 < p < 0.60)", lambda z: 0.40 < z["p"] < 0.60),
        ("home side on a back-to-back", lambda z: z["home_b2b"]),
        ("away side on a back-to-back", lambda z: z["away_b2b"]),
    ]
    for val in sorted({str(z["assumption"]) for z in rows if z["assumption"] is not None}):
        groups.append((f"{label}: {val}", lambda z, v=val: str(z["assumption"]) == v))
    out = []
    for name, f in groups:
        g = [z for z in rows if f(z)]
        if not g:
            continue
        res = [z["y"] - z["p"] for z in g]
        t = _binomial_z([z["p"] for z in g], [z["y"] for z in g])
        row = {"pattern": name, "market": "moneyline", "n": len(g), "mean_p": _r(np.mean([z["p"] for z in g]), 4),
               "mean_y": _r(np.mean([z["y"] for z in g]), 4), "residual": _r(np.mean(res), 4), "stat": _r(t, 2), "stat_kind": "z"}
        row["flag"] = bool(len(g) >= MIN_PATTERN_N and t is not None and abs(t) >= PATTERN_T)
        out.append(row)
        tot = [z["total"] - z["exp_total"] for z in g if z["exp_total"] is not None]
        if tot and name in ("all games", "home side on a back-to-back", "away side on a back-to-back"):
            tt = _t_stat(tot)
            out.append({"pattern": name, "market": "total", "n": len(tot), "residual": _r(np.mean(tot), 3), "stat": _r(tt, 2), "stat_kind": "t",
                        "flag": bool(len(tot) >= MIN_PATTERN_N and tt is not None and abs(tt) >= PATTERN_T)})
    return out


def data_check(eng_id, now=None):
    """Ledger games past due with no result, and finished games with no pregame record.
    Also used by model_loop/health.py."""
    now = now or datetime.now(timezone.utc)
    eng = ENGINES[eng_id]
    season, recs = season_ledger(eng)
    if season is None:
        return {"season": None, "ledger_records": 0, "missing_results": [], "unpriced": [], "starts": []}
    res, sched = eng["results"](season)
    starts = {}
    for r in recs:
        starts.setdefault(str(r["game_id"]), r.get("start_utc"))
    missing = sorted((s, g) for g, s in starts.items()
                     if g not in res and _ts(s) and now - _ts(s) > timedelta(hours=RESULT_GRACE_H))
    pre = pregame(recs)
    first = min((_ts(r.get("recorded_at")) for r in recs if _ts(r.get("recorded_at"))), default=None)
    unpriced = sorted((sched[g][0], g) for g in res
                      if g not in pre and g in sched and first and _ts(sched[g][0]) and _ts(sched[g][0]) > first)
    return {"season": season, "ledger_records": len(recs), "games_priced": len(starts), "graded": len([g for g in pre if g in res]),
            "starts": sorted(t for t in (_ts(s) for s in starts.values()) if t),
            "missing_results": [{"game_id": g, "start_utc": s} for s, g in missing],
            "unpriced": [{"game_id": g, "start_utc": s} for s, g in unpriced]}


# ------------------------------------------------------------------- report
def build(eng_id, now=None):
    now = now or datetime.now(timezone.utc)
    eng = ENGINES[eng_id]
    season, recs = season_ledger(eng)
    v = _read(eng["validation"])
    slate = _read(eng["slate"]) or {}
    if season is None or v is None:
        raise SystemExit(f"{eng_id}: no ledger under {eng['ledger_dir']} or no {eng['validation']}")
    exp = eng["expectation"](v)
    rows, _, _ = graded_rows(eng, season, recs)
    week_from = now - timedelta(days=7)
    week = [z for z in rows if week_from <= _ts(z["start_utc"]) < now]
    pats = patterns(rows, eng["assumption"][1])
    model = slate.get("model")
    served = model.get("id") if isinstance(model, dict) else model
    if isinstance(model, dict) and not served:
        served = model.get("chosen")
    out = {
        "schema": "edgedesk_engine_week_v1", "engine": eng_id, "label": eng["label"],
        "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "season": season,
        "served_model": served, "protocol": eng["protocol"],
        "validation_generated_at": v.get("generated_at"), "slate_generated_at": slate.get("generated_at"),
        "expectation": exp,
        "week": {"from": week_from.strftime("%Y-%m-%d"), "to": now.strftime("%Y-%m-%d"), **summarize(week)},
        "season_to_date": summarize(rows),
        "vs_its_record": vs_expectation(rows, exp),
        "vs_home_rate": vs_home_rate(rows, exp.get("home_rate")),
        "patterns": pats,
        "research_questions": [p for p in pats if p["flag"]],
        "data": {k: v for k, v in data_check(eng_id, now).items() if k != "starts"},
        "models_in_ledger": sorted({z["model"] for z in rows if z["model"]}),
        # the health check and the app read these two like every loop's weekly file
        "promoted": None, "candidates": [],
        "changes": f"none: this report changes no number. {eng['label']}'s models and hyperparameters are chosen by its "
                   f"own protocol ({eng['protocol']}); a flagged pattern is a question for its next amendment.",
    }
    return out


def _fmt(x, k=4):
    return "—" if x is None else (f"{x:.{k}f}" if isinstance(x, float) else str(x))


def report_md(w):
    e, st, wk, ve = w["expectation"], w["season_to_date"], w["week"], w["vs_its_record"]
    lines = [f"# {w['label']} weekly report", "",
             f"Generated {w['at']}. Read only: it grades what the engine published before each game and changes no number. "
             f"The engine's models are chosen by its own protocol ({w['protocol']}).", "",
             f"Served: **{w['served_model']}** (validation {w['validation_generated_at']}).", "",
             "## Season to date and this week", "",
             "| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |",
             "|---|---|---|---|---|---|---|---|---|"]
    for name, s in (("Season to date", st), (f"Week {wk['from']} to {wk['to']}", wk)):
        lines.append(f"| {name} | {s.get('n', 0)} | {_fmt(s.get('log_loss'))} | {_fmt(s.get('brier'))} | {_fmt(s.get('accuracy'))} | "
                     f"{_fmt(s.get('mean_p'))} | {_fmt(s.get('mean_y'))} | {_fmt(s.get('total_mae'), 2)} | {_fmt(s.get('margin_mae'), 2)} |")
    lines += ["", "## Against its own record", ""]
    if ve["verdict"] == "TOO_EARLY":
        lines.append(f"Too early: {ve['n']} graded games (the comparison starts at {MIN_PATTERN_N}). "
                     f"The record promises a log loss of {e['moneyline_log_loss']} ({e['window']}, n = {e.get('n')}).")
    else:
        words = {"AS_EXPECTED": "within what its out-of-sample record promised",
                 "WORSE_THAN_ITS_RECORD": "worse than its out-of-sample record promised",
                 "BETTER_THAN_ITS_RECORD": "better than its out-of-sample record promised"}[ve["verdict"]]
        lines.append(f"Season log loss {ve['season_log_loss']} on {ve['n']} games against {ve['expected']} on the "
                     f"{e['window']} window (t = {ve['t']}): **{words}**.")
    hr = w.get("vs_home_rate")
    if hr:
        lines.append(f"Against a constant home-win rate of {hr['home_rate']}: log loss difference {hr['mean_diff']} "
                     f"(95% interval {hr['ci95']}), {'it beats it' if hr['beats_it'] else 'not yet distinguishable from it'}.")
    lines += ["", "## Patterns", "",
              "Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the "
              "standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. "
              f"Flagged: n >= {MIN_PATTERN_N} and |z| or |t| >= {PATTERN_T}. "
              "A flag is a research question for the engine's next protocol amendment, not a change.", "",
              "| Pattern | Market | n | Residual | z / t | |", "|---|---|---|---|---|---|"]
    for p in w["patterns"]:
        lines.append(f"| {p['pattern']} | {p['market']} | {p['n']} | {_fmt(p['residual'])} | "
                     f"{_fmt(p['stat'], 2)} {p['stat_kind'] if p['stat'] is not None else ''} | {'flag' if p['flag'] else ''} |")
    d = w["data"]
    lines += ["", "## Data", "",
              f"{d['ledger_records']} ledger records over {d.get('games_priced', 0)} games; {d.get('graded', 0)} graded."]
    if d["missing_results"]:
        lines.append(f"{len(d['missing_results'])} game(s) started more than {RESULT_GRACE_H} h ago with no result on file "
                     f"(first: {d['missing_results'][0]['game_id']} at {d['missing_results'][0]['start_utc']}).")
    if d["unpriced"]:
        lines.append(f"{len(d['unpriced'])} finished game(s) since the ledger began had no pregame record "
                     f"(first: {d['unpriced'][0]['game_id']} at {d['unpriced'][0]['start_utc']}).")
    if len(w["models_in_ledger"]) > 1:
        lines.append(f"The graded games were priced by more than one model: {', '.join(w['models_in_ledger'])}.")
    lines += ["", f"Changes: {w['changes']}", ""]
    return "\n".join(lines)


def cmd_report(eng_id, now=None):
    w = build(eng_id, now)
    docs = os.path.join(ROOT, "docs", "model-loop", eng_id)
    os.makedirs(os.path.join(docs, "weekly"), exist_ok=True)
    with open(os.path.join(docs, "weekly", w["at"][:10] + ".json"), "w") as f:
        json.dump(w, f, indent=1)
        f.write("\n")
    with open(os.path.join(docs, "weekly_model_report.md"), "w") as f:
        f.write(report_md(w))
    print(f"{eng_id}: {w['season_to_date'].get('n', 0)} graded, {w['vs_its_record']['verdict']}, "
          f"{len(w['research_questions'])} flagged pattern(s), {len(w['data']['missing_results'])} missing result(s)", file=sys.stderr)
    return w


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["report"])
    ap.add_argument("--engine", default="all", choices=["all"] + sorted(ENGINES))
    ap.add_argument("--now", default=None)
    a = ap.parse_args(argv)
    now = _ts(a.now) if a.now else None
    for e in (sorted(ENGINES) if a.engine == "all" else [a.engine]):
        cmd_report(e, now)


if __name__ == "__main__":
    main()
