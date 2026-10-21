"""The NFL weekly loop: every week the served model is refreshed, scored
against the close, interrogated for patterns in its misses, and challenged by
candidate fixes; a candidate replaces it only on the full backtest.

  python3 -m model_loop.adapters.nfl.weekly refresh    # re-fit, publish this week's cards (same formula)
  python3 -m model_loop.adapters.nfl.weekly score      # grade every published pregame number that has settled
  python3 -m model_loop.adapters.nfl.weekly research   # error analysis -> candidates -> walk-forward -> promote?
  python3 -m model_loop.adapters.nfl.weekly report     # docs/model-loop/nfl/weekly_model_report.md
  python3 -m model_loop.adapters.nfl.weekly all        # the Tuesday run: refresh, score, research, (refresh), report

THE TWO JOBS ARE SEPARATE ON PURPOSE.
  refresh  re-fits ratings with the SERVED version's configuration on the
           newest results and re-prices the upcoming games. It never changes
           a weight, a decay rate or the structure.
  research the only path by which the model changes. Candidates come from a
           fixed catalogue (reweight a component, move a decay or shrink rate,
           switch a Phase 1 component on or off), ranked by the patterns in
           this season's misses. Each is walk-forward backtested on every
           season from 2011 through the current season to date; no game is
           ever priced by coefficients fitted on it. A candidate is promoted
           only if it lowers BOTH margin MAE and log loss on that full
           backtest by at least the noise floor AND is no worse on the most
           recent full season. One week's games never decide anything. Every
           candidate, pass or fail, is logged.

Outputs
  football/nfl/model_loop/current.json       the served numbers for upcoming games (the board reads this)
  football/nfl/model_loop/record_<season>.json  every published pregame number, graded
  model_loop/ledger/nfl/cards_<season>.jsonl  append-only: every pregame publication
  model_loop/ledger/nfl/<season>.jsonl        append-only: weekly rating snapshots
  model_loop/ledger/nfl/site_<season>.jsonl   append-only: the board's served number (football/nfl/slate.json),
                                              captured at each refresh, so the two are graded head to head
  docs/model-loop/nfl/versions.json           version history (current = served)
  docs/model-loop/nfl/candidates.jsonl        every candidate ever tried
  docs/model-loop/nfl/weekly/<season>-wNN.md  the week's report (also weekly_model_report.md)
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ...core import metrics as M
from ...core import walkforward as WF
from ...core import snapshots
from ...core.versions import Versions
from . import backtest as BT
from . import cards as CARDS
from . import ingest
from . import model as NM

ROOT = BT.ROOT
DATA = BT.DATA
DOCS = BT.DOCS
PUB = os.path.join(ROOT, "football", "nfl", "model_loop")
LEDGER = os.path.join(ROOT, "model_loop", "ledger", "nfl")
VERSIONS = os.path.join(DOCS, "versions.json")
CANDIDATES = os.path.join(DOCS, "candidates.jsonl")
WEEKLY = os.path.join(DOCS, "weekly")
OPENERS = os.path.join(ROOT, "football", "pricing", "openers_nfl.json")
SITE_SLATE = os.path.join(ROOT, "football", "nfl", "slate.json")  # the number the board serves today (read only)
EVAL_FROM = 2011
# the noise floor a candidate must clear on the full backtest (both metrics)
MIN_GAIN = {"mae": 0.003, "logloss": 0.0002}
MAX_CANDIDATES = 10
THRESHOLD = CARDS.THRESHOLD


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, float) and not np.isfinite(o):
        return None
    return str(o)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, default=_json_default)


# ------------------------------------------------------------------ versions
def versions():
    if os.path.exists(VERSIONS):
        return Versions(VERSIONS)
    bt = json.load(open(os.path.join(DOCS, "backtest.json")))
    ev = bt["evaluation"]
    first = {"version": "2.0.0", "parent": "edgedesk_football_v1.0.0 (football/engine.js)", "config": bt["final_config"],
             "config_sha256": WF.content_hash(bt["final_config"]), "status": "SERVED", "promoted_by": "owner",
             "promoted_at": now_iso(),
             "reason": "Owner decision 2026-10-21 ('ship it all ... grow every single week'). Overrides the preregistered rule, "
                       "which v2 did not clear against v1-as-trained on 2025 holdout log loss (0.6390 vs 0.6362, CI spans zero); "
                       "v2 beats v1 as trained on the full 2011-2025 backtest (MAE -0.135, log loss -0.0094) and v1 as shipped everywhere.",
             "evidence": {"backtest_2011_2025": BT._summ(ev["v2"]["backtest_2011_2025"]), "holdout_2025": BT._summ(ev["v2"]["holdout"]),
                          "v1_trained_backtest": BT._summ(ev["v1_trained"]["backtest_2011_2025"]), "v1_trained_holdout": BT._summ(ev["v1_trained"]["holdout"])}}
    return Versions.create(VERSIONS, "NFL", first)


# ------------------------------------------------------------------- refresh
def cmd_refresh(fetch=True):
    """Same formula, newest results: re-fit and re-publish the upcoming cards."""
    if fetch:
        seasons = list(range(BT.FIRST_SEASON, datetime.now(timezone.utc).year + 1))
        ingest.fetch(DATA, seasons)
        ingest.build(DATA, [s for s in seasons if os.path.exists(os.path.join(DATA, "raw", f"pbp_{s}.parquet"))])
    V = versions()
    cur = V.current
    cfg = copy.deepcopy(cur["config"])
    cfg["version"] = "nfl_v" + cur["version"]
    out, snaps = CARDS.build(cfg, days=12)
    out["model_version"] = cur["version"]
    out["served"] = {"version": cur["version"], "status": cur["status"], "promoted_by": cur["promoted_by"],
                     "promoted_at": cur["promoted_at"], "reason": cur["reason"]}
    out["schema"] = "edgedesk_model_loop_nfl_current_v1"
    out["contract"] = ("Per game: fair_home_margin (+ = home), fair_home_line (book convention), home_win_prob, tie_prob, "
                       "fair moneylines, range80 (centred on the margin), components that sum exactly to fair_home_margin, "
                       "the starter priced, qb_scenarios for a contested starter, disagreement vs the reference line. "
                       "distribution (sigma + key-number multipliers by |margin|) prices any spread: "
                       "P(M=k) proportional to exp(-((k-mu')/sigma)^2/2) * mult[|k|], mu' solved so the mean is the margin.")
    dump(os.path.join(PUB, "current.json"), out)
    season = out["season"]
    # the pregame ledger: a row per game whenever its published number changes
    path = os.path.join(LEDGER, f"cards_{season}.jsonl")
    last = {}
    if os.path.exists(path):
        for line in open(path):
            if line.strip():
                r = json.loads(line)
                last[r["game_id"]] = r["content_sha256"]
    added = 0
    with open(path, "a") as f:
        for gm in out["games"]:
            body = {"game_id": gm["game_id"], "week": gm["week"], "version": cur["version"], "config_sha256": out["config_sha256"],
                    "fair_home_margin": gm["fair_home_margin"], "home_win_prob": gm["home_win_prob"], "fair_total": gm["fair_total"],
                    "range80": gm["range80"], "starters": {k: v.get("id") for k, v in gm["starters"].items()},
                    "components": {c["key"]: round(c["points"], 4) for c in gm["components"]},
                    "reference_home_line": gm["market_reference"]["home_line"]}
            sha = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if last.get(gm["game_id"]) == sha:
                continue
            f.write(json.dumps(dict(body, published_at=out["generated_at"], content_sha256=sha), sort_keys=True) + "\n")
            added += 1
    rows = []
    last_week = max([gm["week"] for gm in out["games"]], default=0)
    for (s, w), snap in sorted(snaps.items()):
        if w <= last_week:
            rows += snapshots.rows_from_nfl_snapshot(snap, s, w, "NFL-CORE", cur["version"], out["config_sha256"], out["generated_at"])
    n_snap = snapshots.append(os.path.join(LEDGER, f"{season}.jsonl"), rows) if rows else 0
    n_site = capture_site(season)
    print(f"refresh: {len(out['games'])} games published by v{cur['version']}; {added} ledger rows, {n_snap} snapshot rows, "
          f"{n_site} board rows", file=sys.stderr)
    return out


def capture_site(season):
    """The board's own number (football/nfl/slate.json, built by football/engine.js)
    for every upcoming game, appended whenever it changes, stamped with the time
    the board built it. Read only: this loop never writes the board's files.
    Grading both from pregame ledgers is what makes the comparison fair."""
    try:
        sl = json.load(open(SITE_SLATE))
    except Exception:
        return 0
    built = sl.get("generated_at")
    path = os.path.join(LEDGER, f"site_{season}.jsonl")
    last = {}
    if os.path.exists(path):
        for line in open(path):
            if line.strip():
                r = json.loads(line)
                last[r["game_id"]] = r["content_sha256"]
    n = 0
    os.makedirs(LEDGER, exist_ok=True)
    with open(path, "a") as f:
        for g in sl.get("games") or []:
            if g.get("model_status") != "PREDICTED" or g.get("season") != season or not built or built >= g.get("kickoff", ""):
                continue
            m = g.get("model_home_margin_exact", g.get("model_home_margin"))
            if m is None or g.get("model_home_win_prob") is None:
                continue
            body = {"game_id": g["game_id"], "week": g.get("week"), "model_version": g.get("model_version"),
                    "home_margin": round(float(m), 4), "home_win_prob": round(float(g["model_home_win_prob"]), 4)}
            sha = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if last.get(g["game_id"]) == sha:
                continue
            f.write(json.dumps(dict(body, published_at=built, captured_at=now_iso(), content_sha256=sha), sort_keys=True) + "\n")
            n += 1
    return n


def _pregame(path, game_id_to_kick):
    """{game_id: the last row published before kickoff} from an append-only ledger."""
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path):
        if not line.strip():
            continue
        r = json.loads(line)
        ko = game_id_to_kick.get(r["game_id"])
        if ko is None or pd.Timestamp(r["published_at"]) >= ko:
            continue
        if r["game_id"] not in out or r["published_at"] >= out[r["game_id"]]["published_at"]:
            out[r["game_id"]] = r
    return out


# --------------------------------------------------------------------- score
def _kickoff_utc(kick_et):
    t = pd.Timestamp(kick_et)
    if t.tzinfo is None:
        t = t.tz_localize("America/New_York")
    return t.tz_convert("UTC")


def cmd_score():
    """Grade every published pregame number that has a result: the number at
    the snapshot, the opener, the close, the result, CLV, errors; the week and
    the season to date; every game beyond the threshold with its drivers."""
    T = BT.Tables(os.path.join(DATA, "build"))
    games = T.games
    season = int(games[games.result.notna()].season.max())
    path = os.path.join(LEDGER, f"cards_{season}.jsonl")
    pub = {}
    if os.path.exists(path):
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            pub.setdefault(r["game_id"], []).append(r)
    try:
        openers = json.load(open(OPENERS))["games"]
    except Exception:
        openers = {}
    rows = []
    for g in games[(games.season == season) & games.result.notna()].itertuples():
        hist = pub.get(g.game_id)
        if not hist:
            continue
        ko = _kickoff_utc(g.kick_et)
        pre = [r for r in hist if pd.Timestamp(r["published_at"]) < ko]
        if not pre:
            continue
        snap = sorted(pre, key=lambda r: r["published_at"])[-1]
        mu = snap["fair_home_margin"]
        o = (openers.get(g.game_id) or {}).get("open") or {}
        open_margin = -o["home_line"] if o.get("home_line") is not None else None
        close = g.close_margin if np.isfinite(g.close_margin) else None
        res = float(g.result)
        side = None if close is None else (1 if mu > close else -1 if mu < close else 0)
        clv = None
        if open_margin is not None and close is not None and mu != open_margin:
            clv = (close - open_margin) * (1 if mu > open_margin else -1)
        ats = None
        if side:
            m = (res - close) * side
            ats = "win" if m > 0 else "loss" if m < 0 else "push"
        y = None if res == 0 else (1.0 if res > 0 else 0.0)
        p = snap["home_win_prob"]
        drivers = sorted([(k, v) for k, v in snap["components"].items() if k not in ("home_field", "market")],
                         key=lambda kv: -abs(kv[1]))
        gap = None if close is None else mu - close
        rows.append({"game_id": g.game_id, "week": int(g.week), "home": g.home, "away": g.away, "version": snap["version"],
                     "published_at": snap["published_at"], "model_home_margin": mu, "open_home_margin": open_margin,
                     "close_home_margin": close, "result": res, "gap_vs_close": gap, "clv_points": clv, "ats_vs_close": ats,
                     "model_abs_err": abs(res - mu), "close_abs_err": abs(res - close) if close is not None else None,
                     "home_win_prob": p, "brier": (p - y) ** 2 if y is not None else None,
                     "flag": bool(gap is not None and abs(gap) >= THRESHOLD),
                     "drivers": [{"key": k, "points": v} for k, v in drivers[:4] if gap is not None and np.sign(v) == np.sign(gap)]})
    # head to head: the board's own pregame number on the same games
    done = games[(games.season == season) & games.result.notna()]
    site = _pregame(os.path.join(LEDGER, f"site_{season}.jsonl"), {g.game_id: _kickoff_utc(g.kick_et) for g in done.itertuples()})
    for r in rows:
        b = site.get(r["game_id"])
        if b:
            y = None if r["result"] == 0 else (1.0 if r["result"] > 0 else 0.0)
            r["board"] = {"version": b["model_version"], "published_at": b["published_at"], "home_margin": b["home_margin"],
                          "home_win_prob": b["home_win_prob"], "abs_err": abs(r["result"] - b["home_margin"]),
                          "brier": (b["home_win_prob"] - y) ** 2 if y is not None else None}
    df = pd.DataFrame(rows)
    out = {"schema": "edgedesk_model_loop_nfl_record_v1", "season": season, "generated_at": now_iso(),
           "rules": "Pregame only: each game is graded on the last number published before kickoff (model_loop/ledger/nfl/cards_<season>.jsonl). "
                    "Close is the nflverse consensus; CLV is points the market moved toward the model's side from EdgeDesk's own opener capture.",
           "games": rows}
    if len(df):
        def summ(d):
            dp = d[d.brier.notna()]
            yv = (d.loc[dp.index, "result"] > 0).astype(float)
            c = d[d.clv_points.notna()]
            a = d.ats_vs_close.value_counts().to_dict()
            return {"n": int(len(d)), "model_mae": round(float(d.model_abs_err.mean()), 3),
                    "close_mae": round(float(d.close_abs_err.dropna().mean()), 3) if d.close_abs_err.notna().any() else None,
                    "mean_abs_vs_close": round(float(d.gap_vs_close.abs().mean()), 3) if d.gap_vs_close.notna().any() else None,
                    "brier": round(float(dp.brier.mean()), 4) if len(dp) else None,
                    "logloss": round(M.logloss(dp.home_win_prob, yv), 4) if len(dp) else None,
                    "clv_mean_pts": round(float(c.clv_points.mean()), 3) if len(c) else None, "clv_n": int(len(c)),
                    "clv_positive": int((c.clv_points > 0).sum()), "ats_vs_close": a, "flags": int(d.flag.sum()),
                    "calibration": M.calibration_table(dp.home_win_prob, yv, bins=5) if len(dp) else None}
        out["season_to_date"] = summ(df)
        last_week = int(df.week.max())
        out["last_week"] = dict(summ(df[df.week == last_week]), week=last_week)
        both = [r for r in rows if r.get("board")]
        if both:
            out["head_to_head"] = {"rule": "same games, each side's last number published before kickoff; the board's number is "
                                           "captured from football/nfl/slate.json at each daily refresh",
                                   "season_to_date": head_to_head(both),
                                   "last_week": dict(head_to_head([r for r in both if r["week"] == last_week]), week=last_week)
                                   if any(r["week"] == last_week for r in both) else None}
    dump(os.path.join(PUB, f"record_{season}.json"), out)
    print(f"score: {len(rows)} published pregame numbers graded", file=sys.stderr)
    return out


def head_to_head(rs):
    """The model loop and the board on the same settled games: margin MAE,
    win-probability Brier and log loss, distance from the close."""
    pr = [r for r in rs if r["brier"] is not None and r["board"]["brier"] is not None]
    yv = [1.0 if r["result"] > 0 else 0.0 for r in pr]
    cl = [r for r in rs if r["close_home_margin"] is not None]
    return {"n": len(rs),
            "model_loop": {"version": sorted({r["version"] for r in rs}), "mae": round(float(np.mean([r["model_abs_err"] for r in rs])), 3),
                           "brier": round(float(np.mean([r["brier"] for r in pr])), 4) if pr else None,
                           "logloss": round(M.logloss(pd.Series([r["home_win_prob"] for r in pr]), pd.Series(yv)), 4) if pr else None,
                           "mean_abs_vs_close": round(float(np.mean([abs(r["gap_vs_close"]) for r in cl])), 3) if cl else None},
            "board": {"version": sorted({r["board"]["version"] or "?" for r in rs}), "mae": round(float(np.mean([r["board"]["abs_err"] for r in rs])), 3),
                      "brier": round(float(np.mean([r["board"]["brier"] for r in pr])), 4) if pr else None,
                      "logloss": round(M.logloss(pd.Series([r["board"]["home_win_prob"] for r in pr]), pd.Series(yv)), 4) if pr else None,
                      "mean_abs_vs_close": round(float(np.mean([abs(r["board"]["home_margin"] - r["close_home_margin"]) for r in cl])), 3) if cl else None},
            "close_mae": round(float(np.mean([abs(r["result"] - r["close_home_margin"]) for r in cl])), 3) if cl else None}


# ------------------------------------------------------------------ research
# the candidate catalogue: (id, path, how to move it, the patterns it answers)
CATALOGUE = [
    ("recency_faster", "rating.hl_week", ("mul", 0.5), {"recency", "early_season"}),
    ("recency_slower", "rating.hl_week", ("mul", 2.0), {"recency"}),
    ("pass_off_prior_weaker", "rating.lam.pass_off", ("mul", 0.5), {"early_season", "prior"}),
    ("pass_off_prior_stronger", "rating.lam.pass_off", ("mul", 2.0), {"prior"}),
    ("pass_def_prior_weaker", "rating.lam.pass_def", ("mul", 0.5), {"early_season", "prior"}),
    ("pass_def_prior_stronger", "rating.lam.pass_def", ("mul", 2.0), {"prior"}),
    ("rush_off_prior_weaker", "rating.lam.rush_off", ("mul", 0.5), {"prior"}),
    ("rush_def_prior_stronger", "rating.lam.rush_def", ("mul", 2.0), {"prior"}),
    ("qb_prior_weaker", "rating.lam.qb", ("mul", 0.5), {"qb_change"}),
    ("qb_prior_stronger", "rating.lam.qb", ("mul", 2.0), {"qb_change"}),
    ("qb_carry_lower", "rating.carry.qb", ("add", -0.1), {"qb_change", "prior"}),
    ("off_carry_lower", "rating.carry.off", ("add", -0.1), {"early_season", "prior"}),
    ("def_carry_lower", "rating.carry.def", ("add", -0.1), {"early_season", "prior"}),
    ("def_carry_higher", "rating.carry.def", ("add", 0.1), {"prior"}),
    ("market_faster", "rating.market.hl_week", ("mul", 0.5), {"market", "big_favourites"}),
    ("market_slower", "rating.market.hl_week", ("mul", 2.0), {"market"}),
    ("market_prior_stronger", "rating.market.lam", ("mul", 2.0), {"market", "early_season"}),
    ("market_carry_higher", "rating.market.carry", ("add", 0.2), {"market", "early_season"}),
    ("skill_moves_on", "rating.personnel.skill", ("set", 0.5), {"early_season", "prior"}),
    ("ol_continuity_more", "rating.personnel.ol", ("add", 0.05), {"early_season"}),
    ("garbage_heavier", "rating.garbage_floor", ("set", 0.1), {"big_favourites"}),
    ("garbage_lighter", "rating.garbage_floor", ("set", 0.5), {"big_favourites"}),
    # home field follows the recent era (half-life 2 seasons) while everything else keeps its memory
    ("hfa_recent_era", "multi", ("multi", [("model.hfa_target", ("set", "recent")), ("model.hfa_prior_games", ("set", 300.0))]),
     {"home", "home_dogs", "recent_era"}),
    ("hfa_recent_era_strong", "multi", ("multi", [("model.hfa_target", ("set", "recent")), ("model.hfa_prior_games", ("set", 3000.0))]),
     {"home", "home_dogs"}),
    ("market_hfa_looser", "rating.market.lam_hfa", ("mul", 0.25), {"home", "home_dogs", "market"}),
    ("era_shorter", "model.hl_season", ("set", 3.0), {"home", "recent_era"}),
    ("era_longer", "model.hl_season", ("set", 10.0), {"home"}),
    ("hfa_shrink_on", "model.hfa_prior_games", ("set", 300.0), {"home"}),
    ("ridge_looser", "model.ridge_lam", ("mul", 0.5), {"big_favourites"}),
    ("ridge_tighter", "model.ridge_lam", ("mul", 2.0), {"big_favourites", "noise"}),
    ("split_od_on", "model.components.pass_split", ("set", True), {"defence"}),
    ("division_on", "model.components.division", ("set", True), {"division"}),
    ("rest_off", "model.components.rest", ("set", False), {"rest"}),
    ("travel_off", "model.components.travel", ("set", False), {"travel"}),
]


def _apply(cfg, path, how):
    if how[0] == "multi":
        c = cfg
        for sub_path, sub_how in how[1]:
            n = _apply(c, sub_path, sub_how)
            c = n if n is not None else c
        return None if c == cfg else c
    c = copy.deepcopy(cfg)
    scope, sub = path.split(".", 1)
    try:
        cur = BT._get(c[scope], sub)
    except KeyError:
        cur = None          # a key the served config leaves at its default
    kind, v = how
    if kind == "mul":
        if cur is None:
            return None
        new = cur * v
    elif kind == "add":
        new = round(min(1.0, max(0.0, (cur or 0.0) + v)), 4)
    else:
        new = v
    if new == cur:
        return None
    BT._set(c[scope], sub, new)
    return c


def _tags(p, T):
    """Situational tags on each game, for the error analysis."""
    p = p.copy()
    g = T.games[["game_id", "home_qb_id", "away_qb_id", "home", "away", "season", "week", "kick_et"]].sort_values("kick_et")
    last = {}
    newqb = {}
    for r in g.itertuples():
        for side, team, q in (("home", r.home, r.home_qb_id), ("away", r.away, r.away_qb_id)):
            key = (r.season, team)
            newqb[(r.game_id, side)] = bool(key in last and isinstance(q, str) and q != last[key])
            if isinstance(q, str):
                last[key] = q
    p["new_qb_home"] = [newqb.get((x, "home"), False) for x in p.game_id]
    p["new_qb_away"] = [newqb.get((x, "away"), False) for x in p.game_id]
    hr = pd.to_numeric(p.home_rest, errors="coerce").fillna(7)
    ar = pd.to_numeric(p.away_rest, errors="coerce").fillna(7)
    p["tag_early"] = p.week <= 4
    p["tag_home_dog"] = p.close_margin < 0
    p["tag_big_fav"] = p.close_margin.abs() >= 7
    p["tag_short"] = (hr <= 5) | (ar <= 5)
    p["tag_bye"] = (hr >= 13) | (ar >= 13)
    p["tag_div"] = p.div_game == 1
    p["tag_body_clock"] = (p.away_body == 1) | (p.home_body == 1)
    p["tag_new_qb"] = p.new_qb_home | p.new_qb_away
    return p


PATTERN_TAGS = {"early_season": "tag_early", "home": None, "big_favourites": "tag_big_fav", "rest": "tag_short",
                "bye": "tag_bye", "division": "tag_div", "travel": "tag_body_clock", "qb_change": "tag_new_qb",
                "home_dogs": "tag_home_dog"}


def error_analysis(p, T, season):
    """Where this season's (and last season's) misses concentrate: line bias
    (model - close) and outcome bias (result - model) by situation, with t."""
    d = p[(p.season >= season - 1) & p.pred_margin.notna() & p.result.notna() & p.close_margin.notna()]
    d = _tags(d, T)
    out = []
    def stat(name, sel, note):
        x = d[sel]
        if len(x) < 12:
            return
        line = (x.pred_margin - x.close_margin)
        outc = (x.result - x.pred_margin)
        se_l = line.std(ddof=1) / np.sqrt(len(x))
        se_o = outc.std(ddof=1) / np.sqrt(len(x))
        out.append({"pattern": name, "n": int(len(x)), "note": note,
                    "line_bias": round(float(line.mean()), 3), "line_t": round(float(line.mean() / se_l), 2) if se_l > 0 else None,
                    "outcome_bias": round(float(outc.mean()), 3), "outcome_t": round(float(outc.mean() / se_o), 2) if se_o > 0 else None,
                    "abs_gap": round(float(line.abs().mean()), 3), "close_beats_model_by": round(float((outc.abs() - (x.result - x.close_margin).abs()).mean()), 3)})
    stat("home", np.ones(len(d), bool), "every game; line bias is the model's home lean against the close")
    for name, col in PATTERN_TAGS.items():
        if col:
            stat(name, d[col].values, col)
    # misses this season, largest first, attributed to components
    cur = d[d.season == season].copy()
    cur["miss_vs_close"] = (cur.pred_margin - cur.close_margin).abs()
    comp_cols = [c for c in cur.columns if c.startswith("c_")]
    misses = []
    for r in cur.sort_values("miss_vs_close", ascending=False).head(8).itertuples():
        comps = sorted(((c[2:], getattr(r, c)) for c in comp_cols if np.isfinite(getattr(r, c))), key=lambda kv: -abs(kv[1]))
        misses.append({"game_id": r.game_id, "model": round(r.pred_margin, 2), "close": r.close_margin, "result": r.result,
                       "gap": round(r.pred_margin - r.close_margin, 2), "top_components": [{"key": k, "points": round(v, 2)} for k, v in comps[:5]]})
    return out, misses


def rank_candidates(patterns, week_index, n=MAX_CANDIDATES):
    """The strongest significant pattern (|t| >= 2) gets the first two
    candidates that answer it, then the next pattern, and so on, for up to
    n - 3 slots; the rest of the catalogue rotates through the remaining
    slots so every candidate is tried within a few weeks."""
    sig = sorted(((max(abs(pt.get("line_t") or 0), abs(pt.get("outcome_t") or 0)), pt["pattern"]) for pt in patterns), reverse=True)
    top = []
    for t, name in sig:
        if t < 2.0 or len(top) >= n - 3:
            break
        top += [cid for cid, _, _, answers in CATALOGUE if name in answers and cid not in top][:2]
    top = top[: n - 3]
    rest = [cid for cid, *_ in CATALOGUE if cid not in top]
    k = week_index % max(1, len(rest))
    rotate = (rest[k:] + rest[:k])[: n - len(top)]
    return top + rotate


def _full_and_recent(p, season):
    """The full backtest (2011 through the current season to date) and the
    most recent FULL season, both scored the same way."""
    full = WF.evaluate(p[(p.season >= EVAL_FROM) & (p.season <= season)])
    recent = WF.evaluate(p[p.season == season - 1])
    return full, recent


def cmd_research(max_candidates=MAX_CANDIDATES, only=None):
    """only: test these catalogue ids instead of the ranked list (a second run
    in the same week appends to that week's record; every candidate is logged)."""
    V = versions()
    cur = V.current
    runner = BT.Runner()
    runner.seasons = runner.all_seasons()
    season = int(runner.T.games[runner.T.games.result.notna()].season.max())
    base, _ = runner.predict(cur["config"], probs=True)
    full0, recent0 = _full_and_recent(base, season)
    patterns, misses = error_analysis(base, runner.T, season)
    week = int(runner.T.games[(runner.T.games.season == season) & runner.T.games.result.notna()].week.max())
    cat = {c[0]: c for c in CATALOGUE}
    order = [c for c in only if c in cat] if only else rank_candidates(patterns, season * 100 + week)[:max_candidates]
    results = []
    for cid in order:
        _, path, how, answers = cat[cid]
        cfg = _apply(cur["config"], path, how)
        rec = {"at": now_iso(), "season": season, "week": week, "served_version": cur["version"], "candidate": cid,
               "change": {"path": path, "how": list(how)}, "answers_patterns": sorted(answers)}
        if cfg is None:
            rec.update(decision="SKIPPED", reason="no change from the served configuration")
            results.append(rec)
            continue
        p, _ = runner.predict(cfg, probs=True)
        full, recent = _full_and_recent(p, season)
        d_mae = full["margin_mae"] - full0["margin_mae"]
        d_ll = full["logloss"] - full0["logloss"]
        r_mae = recent["margin_mae"] - recent0["margin_mae"]
        r_ll = recent["logloss"] - recent0["logloss"]
        ok = d_mae <= -MIN_GAIN["mae"] and d_ll <= -MIN_GAIN["logloss"] and r_mae <= 0 and r_ll <= 0
        reasons = []
        if d_mae > -MIN_GAIN["mae"]:
            reasons.append(f"full-backtest MAE change {d_mae:+.4f} does not clear -{MIN_GAIN['mae']}")
        if d_ll > -MIN_GAIN["logloss"]:
            reasons.append(f"full-backtest log loss change {d_ll:+.5f} does not clear -{MIN_GAIN['logloss']}")
        if r_mae > 0:
            reasons.append(f"worse on {season - 1} MAE ({r_mae:+.4f})")
        if r_ll > 0:
            reasons.append(f"worse on {season - 1} log loss ({r_ll:+.5f})")
        rec.update(config=cfg, full={"margin_mae": full["margin_mae"], "logloss": full["logloss"], "n": full["n"]},
                   recent_season={"margin_mae": recent["margin_mae"], "logloss": recent["logloss"], "n": recent["n"]},
                   delta={"full_mae": round(d_mae, 5), "full_logloss": round(d_ll, 6), "recent_mae": round(r_mae, 5), "recent_logloss": round(r_ll, 6)},
                   decision="PASS" if ok else "FAIL", reason="; ".join(reasons) or "clears every condition")
        results.append(rec)
        print(f"candidate {cid}: {rec['decision']} (full dMAE {d_mae:+.4f}, dLL {d_ll:+.5f}; {season - 1} dMAE {r_mae:+.4f}, dLL {r_ll:+.5f})", file=sys.stderr)
    with open(CANDIDATES, "a") as f:
        for r in results:
            f.write(json.dumps({k: v for k, v in r.items() if k != "config"}, default=_json_default) + "\n")
    passed = [r for r in results if r["decision"] == "PASS"]
    promoted = None
    if passed:
        best = min(passed, key=lambda r: r["delta"]["full_logloss"] / MIN_GAIN["logloss"] + r["delta"]["full_mae"] / MIN_GAIN["mae"])
        promoted = V.promote(best["config"], reason=f"weekly loop {season} week {week}: candidate {best['candidate']} "
                                                    f"({best['change']['path']} {best['change']['how']}) cleared the full-backtest rule",
                             evidence={"full": best["full"], "recent_season": best["recent_season"], "delta": best["delta"],
                                       "previous": {"full": {"margin_mae": full0["margin_mae"], "logloss": full0["logloss"]},
                                                    "recent_season": {"margin_mae": recent0["margin_mae"], "logloss": recent0["logloss"]}}})
    wpath = os.path.join(WEEKLY, f"{season}-w{week:02d}.json")
    earlier = json.load(open(wpath)) if os.path.exists(wpath) else None
    if earlier and not promoted and earlier.get("promoted"):
        promoted = V.get(earlier["promoted"])
    summary = {"at": now_iso(), "season": season, "week": week,
               "served_before": earlier["served_before"] if earlier else cur["version"],
               "runs": (earlier.get("runs", 1) + 1) if earlier else 1,
               "served_after": V.doc["current"], "promoted": promoted["version"] if promoted else None,
               "baseline": {"full": {k: full0.get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "mean_abs_vs_close")},
                            "recent_season": {k: recent0.get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss")},
                            "this_season": {k: WF.evaluate(base[base.season == season]).get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "mean_abs_vs_close")}},
               "patterns": patterns, "largest_misses": misses,
               "candidates": (earlier["candidates"] if earlier else []) + [{k: v for k, v in r.items() if k not in ("config",)} for r in results]}
    dump(wpath, summary)
    return summary


# -------------------------------------------------------------------- report
def cmd_report():
    V = versions()
    files = sorted(f for f in os.listdir(WEEKLY) if f.endswith(".json")) if os.path.exists(WEEKLY) else []
    if not files:
        print("no research run yet", file=sys.stderr)
        return
    s = json.load(open(os.path.join(WEEKLY, files[-1])))
    rec = None
    rp = os.path.join(PUB, f"record_{s['season']}.json")
    if os.path.exists(rp):
        rec = json.load(open(rp))
    cur = V.current
    md = [f"# NFL weekly model report: {s['season']} week {s['week']}\n",
          f"Generated {s['at']}. Served version **{cur['version']}** ({cur['status']}; promoted by {cur['promoted_by']} on {cur['promoted_at'][:10]}).\n",
          "## What changed\n"]
    if s["promoted"]:
        v = V.get(s["promoted"])
        e = v["evidence"]
        md.append(f"**Promoted {s['served_before']} → {s['promoted']}.** {v['reason']}.\n")
        md.append(f"- Full backtest 2011–{s['season']}: MAE {e['previous']['full']['margin_mae']} → {e['full']['margin_mae']}, "
                  f"log loss {e['previous']['full']['logloss']} → {e['full']['logloss']}")
        md.append(f"- {s['season'] - 1} season: MAE {e['previous']['recent_season']['margin_mae']} → {e['recent_season']['margin_mae']}, "
                  f"log loss {e['previous']['recent_season']['logloss']} → {e['recent_season']['logloss']}")
        md.append(f"- Roll back: point `current` in docs/model-loop/nfl/versions.json at {s['served_before']}.\n")
    else:
        md.append(f"**Nothing promoted.** {len([c for c in s['candidates'] if c.get('decision') != 'SKIPPED'])} candidates were tested"
                  f"{' over ' + str(s['runs']) + ' runs' if s.get('runs', 1) > 1 else ''}; none cleared the full-backtest rule "
                  f"(both MAE ≤ −{MIN_GAIN['mae']} and log loss ≤ −{MIN_GAIN['logloss']} over 2011–{s['season']}, and no worse on {s['season'] - 1}). "
                  f"v{cur['version']} keeps serving.\n")
    b = s["baseline"]
    md.append("## Accuracy against the closing line (walk-forward, out of sample)\n")
    md.append("| Window | n | Model MAE | Close MAE | Log loss | Close log loss |\n|---|---|---|---|---|---|")
    for lab, k in ((f"{s['season']} to date", "this_season"), (f"{s['season'] - 1}", "recent_season"), (f"2011–{s['season']}", "full")):
        x = b[k]
        md.append(f"| {lab} | {x.get('n')} | {x.get('margin_mae')} | {x.get('close_margin_mae')} | {x.get('logloss')} | {x.get('close_logloss')} |")
    if rec and rec.get("season_to_date"):
        st, lw = rec["season_to_date"], rec.get("last_week", {})
        md.append("\n## The published record (pregame numbers as they were served)\n")
        md.append("| Window | n | Model MAE | Close MAE | \\|model − close\\| | Brier | Log loss | CLV (pts, n) | ATS vs close | Flags ≥3 |\n|---|---|---|---|---|---|---|---|---|---|")
        for lab, x in ((f"Week {lw.get('week')}", lw), ("Season to date", st)):
            if x:
                md.append(f"| {lab} | {x['n']} | {x['model_mae']} | {x['close_mae']} | {x['mean_abs_vs_close']} | {x['brier']} | {x['logloss']} | "
                          f"{x['clv_mean_pts']} ({x['clv_n']}) | {x['ats_vs_close']} | {x['flags']} |")
        flagged = [g for g in rec["games"] if g["flag"] and g["week"] == lw.get("week")]
        if flagged:
            md.append("\n### Games where the model differed from the close by 3+ points\n")
            md.append("| Game | Model | Close | Result | Drivers |\n|---|---|---|---|---|")
            for g in flagged:
                md.append(f"| {g['away']} @ {g['home']} | {g['home']} {-g['model_home_margin']:+.1f} | {g['home']} {-g['close_home_margin']:+.1f} | "
                          f"{g['result']:+.0f} | " + "; ".join(f"{d['key']} {d['points']:+.2f}" for d in g["drivers"]) + " |")
    else:
        md.append("\n*The published record starts with the first week this version served; nothing it published has settled yet.*\n")
    hh = (rec or {}).get("head_to_head")
    if hh:
        md.append("\n## Head to head with the board's number (same games, pregame)\n")
        md.append("| Window | n | Model loop MAE | Board MAE | Close MAE | Model loop log loss | Board log loss | Model loop Brier | Board Brier |\n|---|---|---|---|---|---|---|---|---|")
        for lab, x in (("Last week", hh.get("last_week")), ("Season to date", hh["season_to_date"])):
            if x:
                a, b = x["model_loop"], x["board"]
                md.append(f"| {lab} | {x['n']} | {a['mae']} | {b['mae']} | {x['close_mae']} | {a['logloss']} | {b['logloss']} | {a['brier']} | {b['brier']} |")
        md.append("\nOne season of NFL games is not enough to rank two models; this table is the running record, and the full backtest decides promotions.\n")
    md.append("\n## Where the misses concentrate (this season and last, walk-forward)\n")
    md.append("Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.\n")
    md.append("| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |\n|---|---|---|---|---|---|---|")
    for pt in s["patterns"]:
        md.append(f"| {pt['pattern']} | {pt['n']} | {pt['line_bias']:+.2f} | {pt['line_t']} | {pt['outcome_bias']:+.2f} | {pt['outcome_t']} | {pt['close_beats_model_by']:+.2f} |")
    md.append("\n## This season's largest misses against the close, by component\n")
    md.append("| Game | Model | Close | Result | Gap | Largest components |\n|---|---|---|---|---|---|")
    for m in s["largest_misses"]:
        md.append(f"| {m['game_id']} | {m['model']:+.1f} | {m['close']:+.1f} | {m['result']:+.0f} | {m['gap']:+.1f} | "
                  + "; ".join(f"{c['key']} {c['points']:+.2f}" for c in m["top_components"]) + " |")
    md.append("\n## Every candidate tried this week\n")
    md.append("| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |\n|---|---|---|---|---|---|---|")
    for c in s["candidates"]:
        d = c.get("delta") or {}
        md.append(f"| {c['candidate']} | `{c['change']['path']}` {c['change']['how']} | {d.get('full_mae', '—')} | {d.get('full_logloss', '—')} | "
                  f"{d.get('recent_mae', '—')} | {d.get('recent_logloss', '—')} | {c['decision']}: {c.get('reason', '')} |")
    md.append("\nEvery candidate ever tried is in `docs/model-loop/nfl/candidates.jsonl`; the version history in `docs/model-loop/nfl/versions.json`.")
    text = "\n".join(md) + "\n"
    with open(os.path.join(DOCS, "weekly_model_report.md"), "w") as f:
        f.write(text)
    with open(os.path.join(WEEKLY, files[-1].replace(".json", ".md")), "w") as f:
        f.write(text)
    print(os.path.join(DOCS, "weekly_model_report.md"))


def cmd_all(fetch=True):
    cmd_refresh(fetch=fetch)
    cmd_score()
    s = cmd_research()
    if s.get("promoted"):
        cmd_refresh(fetch=False)
    cmd_report()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["refresh", "score", "research", "report", "all"])
    ap.add_argument("--no-fetch", action="store_true", help="use the cached nflverse files")
    ap.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES)
    ap.add_argument("--only", default="", help="comma-separated catalogue ids to test (research)")
    a = ap.parse_args(argv)
    if a.cmd == "refresh":
        cmd_refresh(fetch=not a.no_fetch)
    elif a.cmd == "score":
        cmd_score()
    elif a.cmd == "research":
        cmd_research(a.max_candidates, [c for c in a.only.split(",") if c] or None)
    elif a.cmd == "report":
        cmd_report()
    else:
        cmd_all(fetch=not a.no_fetch)


if __name__ == "__main__":
    main()
