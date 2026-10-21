"""The CFB weekly loop: every week the served model is refreshed, scored
against the close, interrogated for patterns in its misses, and challenged by
candidate fixes; a candidate replaces it only on the full backtest.

  python3 -m model_loop.adapters.cfb.weekly refresh    # re-fit, publish this week's cards (same formula)
  python3 -m model_loop.adapters.cfb.weekly score      # grade every published pregame number that has settled
  python3 -m model_loop.adapters.cfb.weekly research   # error analysis -> candidates -> walk-forward -> promote?
  python3 -m model_loop.adapters.cfb.weekly report     # docs/model-loop/cfb/weekly_model_report.md
  python3 -m model_loop.adapters.cfb.weekly all        # the Sunday-night run: refresh, score, research, (refresh), report

THE TWO JOBS ARE SEPARATE ON PURPOSE (exactly as the NFL loop).
  refresh  re-fits ratings with the SERVED version's configuration on the
           newest results and re-prices the upcoming games. It never changes
           a weight, a decay rate or the structure.
  research the only path by which the model changes. Candidates come from a
           fixed catalogue (move a decay or shrink rate, a prior weight, switch
           a component on or off), ranked by the patterns in this season's
           misses. Each is walk-forward backtested on every season from 2014
           through the current season to date; no game is ever priced by
           coefficients fitted on it. A candidate is promoted only if it lowers
           BOTH margin MAE and log loss on that full backtest by at least the
           noise floor AND is no worse on the most recent full season. One
           week's games never decide anything. Every candidate, pass or fail,
           is logged.

Outputs
  football/cfb/model_loop/current.json       the served numbers for upcoming games (the board reads this)
  football/cfb/model_loop/record_<season>.json  every published pregame number, graded
  model_loop/ledger/cfb/cards_<season>.jsonl  append-only: every pregame publication
  model_loop/ledger/cfb/<season>.jsonl        append-only: weekly rating snapshots
  docs/model-loop/cfb/versions.json           version history (current = served)
  docs/model-loop/cfb/candidates.jsonl        every candidate ever tried
  docs/model-loop/cfb/weekly/<season>-wNN.md  the week's report (also weekly_model_report.md)
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from ...core import metrics as M
from ...core import walkforward as WF
from ...core import snapshots
from ...core.versions import Versions
from . import backtest as BT
from . import cards as CARDS
from . import ingest

ROOT = BT.ROOT
DATA = BT.DATA
DOCS = BT.DOCS
PUB = os.path.join(ROOT, "football", "cfb", "model_loop")
LEDGER = os.path.join(ROOT, "model_loop", "ledger", "cfb")
VERSIONS = os.path.join(DOCS, "versions.json")
CANDIDATES = os.path.join(DOCS, "candidates.jsonl")
WEEKLY = os.path.join(DOCS, "weekly")
EVAL_FROM = 2014
# the noise floor a candidate must clear on the full backtest (both metrics)
MIN_GAIN = {"mae": 0.003, "logloss": 0.0002}
MAX_CANDIDATES = 10
OWNER_REASON = "Owner decision 2026-10-21: ship every sport's model loop and let it learn weekly"

CONTRACT = ("Per game: fair_home_margin (+ = home), fair_home_line (book convention), home_win_prob (no ties in college "
            "football: P(home wins) = P(M>0)/(P(M>0)+P(M<0)); tie_prob is the distribution's mass at 0, settled in overtime), "
            "fair moneylines, range80 (centred on the margin), components that sum exactly to fair_home_margin (grouped as "
            "base strength / environment / rest), the quarterback priced and the basis for it, games played, disagreement vs "
            "the reference line (flag 8 pts; 10 while either side has played <=3 games; 7 from 6 games; 14+ presumed a model "
            "or data fault; FBS-vs-FCS never flagged). distribution (sigma + key-number multipliers by |margin|, support "
            "+/-kmax) prices any spread: P(M=k) proportional to exp(-((k-mu')/sigma)^2/2) * mult[|k|], mu' solved so the mean "
            "is the margin.")


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
    v2, p4 = ev["v2"]["all"], ev["cfb_p4"]["all"]
    beat_full = v2["backtest_2014_2025"]["margin_mae"] < p4["backtest_2014_2025"]["margin_mae"] and \
        v2["backtest_2014_2025"]["logloss"] < p4["backtest_2014_2025"]["logloss"]
    beat_hold = v2["holdout"]["margin_mae"] < p4["holdout"]["margin_mae"] and v2["holdout"]["logloss"] < p4["holdout"]["logloss"]
    first = {"version": "2.0.0", "parent": "edgedesk_cfb_p4_v1.0.1 (football/cfb_p4/engine.js)", "config": bt["final_config"],
             "config_sha256": WF.content_hash(bt["final_config"]), "status": "SERVED", "promoted_by": "owner",
             "promoted_at": now_iso(),
             "reason": OWNER_REASON + ". " + (
                 "The preregistered rule is also cleared: v2 beats the cfb_p4 replay on MAE and log loss on the 2014-2025 "
                 "backtest and on the 2025 holdout." if bt["decision"]["ship"] else
                 "This overrides the preregistered rule, which v2 did not clear: " + "; ".join(bt["decision"]["against"]["cfb_p4"]["reasons"]) + ".")
             + f" Full 2014-2025 backtest, all games: v2 MAE {v2['backtest_2014_2025']['margin_mae']} vs cfb_p4 "
               f"{p4['backtest_2014_2025']['margin_mae']} vs close {v2['backtest_2014_2025']['close_margin_mae']}; log loss "
               f"{v2['backtest_2014_2025']['logloss']} vs {p4['backtest_2014_2025']['logloss']}. 2025 holdout: MAE "
               f"{v2['holdout']['margin_mae']} vs {p4['holdout']['margin_mae']}; log loss {v2['holdout']['logloss']} vs "
               f"{p4['holdout']['logloss']}. Beats cfb_p4 on the full backtest: {'yes' if beat_full else 'no'}; on the holdout: "
               f"{'yes' if beat_hold else 'no'}. Neither model beats the closing line over all games (close MAE "
               f"{v2['backtest_2014_2025']['close_margin_mae']} on the backtest, {v2['holdout']['close_margin_mae']} on the holdout).",
             "evidence": {"backtest_2014_2025": BT._summ(v2["backtest_2014_2025"]), "holdout_2025": BT._summ(v2["holdout"]),
                          "live_2026": BT._summ(v2["live"]),
                          "fbs_only": {"backtest_2014_2025": BT._summ(ev["v2"]["fbs"]["backtest_2014_2025"]),
                                       "holdout_2025": BT._summ(ev["v2"]["fbs"]["holdout"])},
                          "fbs_vs_fcs": {"backtest_2014_2025": BT._summ(ev["v2"]["fcs"]["backtest_2014_2025"]),
                                         "holdout_2025": BT._summ(ev["v2"]["fcs"]["holdout"])},
                          "cfb_p4_backtest": BT._summ(p4["backtest_2014_2025"]), "cfb_p4_holdout": BT._summ(p4["holdout"]),
                          "cfb_p4_live_2026": BT._summ(p4["live"]),
                          "preregistered_decision": bt["decision"], "report": "docs/model-loop/cfb/BACKTEST.md"}}
    return Versions.create(VERSIONS, "CFB", first)


# ------------------------------------------------------------------- refresh
def cmd_refresh(fetch=True):
    """Same formula, newest results: re-fit and re-publish the upcoming cards."""
    if fetch:
        seasons = list(range(BT.FIRST_SEASON, ingest.current_season() + 1))
        ingest.fetch(DATA, seasons)
        ingest.build(DATA, [s for s in seasons if os.path.exists(os.path.join(DATA, "raw", f"pbp_{s}.parquet"))])
    V = versions()
    cur = V.current
    cfg = copy.deepcopy(cur["config"])
    cfg["version"] = "cfb_v" + cur["version"]
    out, snaps = CARDS.build(cfg, days=10)
    out["model_version"] = cur["version"]
    out["status"] = cur["status"]
    out["served"] = {"version": cur["version"], "status": cur["status"], "promoted_by": cur["promoted_by"],
                     "promoted_at": cur["promoted_at"], "reason": cur["reason"]}
    out["schema"] = "edgedesk_model_loop_cfb_current_v1"
    out["contract"] = CONTRACT
    out["note"] = ("CFB model loop: the served version's numbers for the next 10 days of games with an FBS side. "
                   "Version history and evidence: docs/model-loop/cfb/versions.json and BACKTEST.md.")
    dump(os.path.join(PUB, "current.json"), out)
    season = out["season"]
    # the pregame ledger: a row per game whenever its published number changes
    os.makedirs(LEDGER, exist_ok=True)
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
            rows += CARDS.rows_from_snapshot(snap, s, w, "CFB-CORE", cur["version"], out["config_sha256"], out["generated_at"])
    n_snap = snapshots.append(os.path.join(LEDGER, f"{season}.jsonl"), rows) if rows else 0
    print(f"refresh: {len(out['games'])} games published by v{cur['version']}; {added} ledger rows, {n_snap} snapshot rows", file=sys.stderr)
    return out


# --------------------------------------------------------------------- score
def cmd_score():
    """Grade every published pregame number that has a result: the number at
    the snapshot, the opener, the close, the result, CLV, errors; the week and
    the season to date; every flagged game with its drivers."""
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
            pub.setdefault(str(r["game_id"]), []).append(r)
    rows = []
    for g in games[(games.season == season) & games.result.notna()].itertuples():
        hist = pub.get(str(g.game_id))
        if not hist:
            continue
        ko = pd.Timestamp(g.kick_utc).tz_localize("UTC")
        pre = [r for r in hist if pd.Timestamp(r["published_at"]) < ko]
        if not pre:
            continue
        snap = sorted(pre, key=lambda r: r["published_at"])[-1]
        mu = snap["fair_home_margin"]
        open_margin = g.open_margin if np.isfinite(g.open_margin) else (g.ref_open_margin if np.isfinite(g.ref_open_margin) else None)
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
        drivers = sorted([(k, v) for k, v in snap["components"].items() if k not in ("home_field", "market")], key=lambda kv: -abs(kv[1]))
        gap = None if close is None else mu - close
        fbs_game = g.home_div == "fbs" and g.away_div == "fbs"
        rows.append({"game_id": str(g.game_id), "week": int(g.week), "home": g.home_name, "away": g.away_name, "fbs_vs_fbs": bool(fbs_game),
                     "version": snap["version"], "published_at": snap["published_at"], "model_home_margin": mu, "open_home_margin": open_margin,
                     "close_home_margin": close, "result": res, "gap_vs_close": gap, "clv_points": clv, "ats_vs_close": ats,
                     "model_abs_err": abs(res - mu), "close_abs_err": abs(res - close) if close is not None else None,
                     "home_win_prob": p, "brier": (p - y) ** 2 if y is not None else None,
                     "flag": bool(gap is not None and fbs_game and abs(gap) >= CARDS.FLAG),
                     "drivers": [{"key": k, "points": v} for k, v in drivers[:4] if gap is not None and np.sign(v) == np.sign(gap)]})
    df = pd.DataFrame(rows)
    out = {"schema": "edgedesk_model_loop_cfb_record_v1", "season": season, "generated_at": now_iso(),
           "rules": "Pregame only: each game is graded on the last number published before kickoff (model_loop/ledger/cfb/cards_<season>.jsonl). "
                    "Close is the record's (record/football/cfb_2026.json, DraftKings via ESPN, frozen at kickoff); CLV is points the market moved "
                    "toward the model's side from the opener (CFBD consensus opener via sportsdataverse cfb_matchup_line).",
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
        out["season_to_date_fbs_vs_fbs"] = summ(df[df.fbs_vs_fbs]) if df.fbs_vs_fbs.any() else None
        last_week = int(df.week.max())
        out["last_week"] = dict(summ(df[df.week == last_week]), week=last_week)
    dump(os.path.join(PUB, f"record_{season}.json"), out)
    print(f"score: {len(rows)} published pregame numbers graded", file=sys.stderr)
    return out


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
    ("fcs_prior_weaker", "rating.lam.lower", ("mul", 0.5), {"fcs"}),
    ("fcs_prior_stronger", "rating.lam.lower", ("mul", 2.0), {"fcs"}),
    ("fcs_carry_higher", "rating.carry.lower", ("add", 0.1), {"fcs"}),
    ("conference_prior_more", "rating.conf_w", ("add", 0.25), {"early_season", "prior", "conference"}),
    ("talent_more", "rating.talent.off", ("add", 0.015), {"early_season", "prior"}),
    ("talent_def_more", "rating.talent.def", ("add", 0.015), {"early_season", "prior"}),
    ("retprod_more", "rating.retprod", ("add", 0.5), {"early_season", "prior"}),
    ("market_faster", "rating.market.hl_week", ("mul", 0.5), {"market", "big_favourites"}),
    ("market_slower", "rating.market.hl_week", ("mul", 2.0), {"market"}),
    ("market_prior_stronger", "rating.market.lam", ("mul", 2.0), {"market", "early_season"}),
    ("market_prior_weaker", "rating.market.lam", ("mul", 0.5), {"market"}),
    ("market_carry_lower", "rating.market.carry", ("add", -0.1), {"market", "early_season"}),
    ("garbage_heavier", "rating.garbage_floor", ("set", 0.1), {"big_favourites"}),
    ("garbage_lighter", "rating.garbage_floor", ("set", 0.5), {"big_favourites"}),
    ("era_shorter", "model.hl_season", ("set", 3.0), {"home", "recent_era"}),
    ("era_longer", "model.hl_season", ("set", 10.0), {"home"}),
    ("hfa_shrink_on", "model.hfa_prior_games", ("set", 300.0), {"home"}),
    ("ridge_looser", "model.ridge_lam", ("mul", 0.5), {"big_favourites"}),
    ("ridge_tighter", "model.ridge_lam", ("mul", 2.0), {"big_favourites", "noise"}),
    ("split_od_on", "model.components.pass_split", ("set", True), {"defence"}),
    ("division_row_on", "model.components.division", ("set", True), {"fcs"}),
    ("rest_off", "model.components.rest", ("set", False), {"rest"}),
]


def _apply(cfg, path, how):
    c = copy.deepcopy(cfg)
    scope, sub = path.split(".", 1)
    cur = BT._get(c[scope], sub)
    kind, v = how
    if kind == "mul":
        if cur is None:
            return None
        new = cur * v
    elif kind == "add":
        hi = 1.0 if ".carry" in path or path.endswith("conf_w") else 10.0
        new = round(min(hi, max(0.0, (cur or 0.0) + v)), 4)
    else:
        new = v
    if new == cur:
        return None
    BT._set(c[scope], sub, new)
    return c


def _tags(p, T):
    """Situational tags on each game, for the error analysis."""
    p = p.copy()
    g = T.games[["game_id", "home_qb_id", "away_qb_id", "home", "away", "season", "kick_utc"]].sort_values("kick_utc")
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
    p["tag_early"] = p.slate <= 4
    p["tag_home_dog"] = p.close_margin < 0
    p["tag_big_fav"] = p.close_margin.abs() >= 14
    p["tag_fcs"] = (p.home_div != "fbs") | (p.away_div != "fbs")
    p["tag_neutral"] = p.neutral == 1
    p["tag_new_qb"] = p.new_qb_home | p.new_qb_away
    p["tag_postseason"] = p.season_type == "postseason"
    return p


PATTERN_TAGS = {"early_season": "tag_early", "home": None, "big_favourites": "tag_big_fav", "fcs": "tag_fcs",
                "neutral": "tag_neutral", "qb_change": "tag_new_qb", "home_dogs": "tag_home_dog", "postseason": "tag_postseason"}


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
    cur = d[d.season == season].copy()
    cur["miss_vs_close"] = (cur.pred_margin - cur.close_margin).abs()
    comp_cols = [c for c in cur.columns if c.startswith("c_")]
    misses = []
    for r in cur.sort_values("miss_vs_close", ascending=False).head(8).itertuples():
        comps = sorted(((c[2:], getattr(r, c)) for c in comp_cols if np.isfinite(getattr(r, c))), key=lambda kv: -abs(kv[1]))
        misses.append({"game_id": str(r.game_id), "game": f"{r.away_name} @ {r.home_name}", "model": round(r.pred_margin, 2),
                       "close": r.close_margin, "result": r.result, "gap": round(r.pred_margin - r.close_margin, 2),
                       "top_components": [{"key": k, "points": round(v, 2)} for k, v in comps[:5]]})
    return out, misses


def rank_candidates(patterns, week_index):
    """Patterns that are significant pull their catalogue entries forward;
    the rest rotate in so every candidate is tried within a few weeks."""
    strength = {}
    for pt in patterns:
        strength[pt["pattern"]] = max(abs(pt.get("line_t") or 0), abs(pt.get("outcome_t") or 0))
    always = {"prior", "recency", "market", "noise", "defence", "recent_era"}
    scored = []
    for i, (cid, path, how, answers) in enumerate(CATALOGUE):
        s = max([strength.get(a, 0.0) for a in answers] + [0.0])
        s += 0.5 if answers & always else 0.0
        scored.append((s, i, cid))
    scored.sort(key=lambda x: (-x[0], x[1]))
    top = [c for s, i, c in scored if s >= 2.0][: MAX_CANDIDATES - 3]
    rest = [c for s, i, c in scored if c not in top]
    k = week_index % max(1, len(rest))
    rotate = (rest[k:] + rest[:k])[: MAX_CANDIDATES - len(top)]
    return top + rotate


def _full_and_recent(p, season):
    """The full backtest (2014 through the current season to date) and the
    most recent FULL season, both scored the same way."""
    full = WF.evaluate(p[(p.season >= EVAL_FROM) & (p.season <= season)])
    recent = WF.evaluate(p[p.season == season - 1])
    return full, recent


_W = {}


def _candidate_worker(cfg):
    if "runner" not in _W:
        r = BT.Runner()
        r.seasons = r.all_seasons()
        _W["runner"] = r
    runner = _W["runner"]
    season = int(runner.T.games[runner.T.games.result.notna()].season.max())
    p, _ = runner.predict(cfg, probs=True)
    full, recent = _full_and_recent(p, season)
    return {"margin_mae": full["margin_mae"], "logloss": full["logloss"], "n": full["n"]}, \
           {"margin_mae": recent["margin_mae"], "logloss": recent["logloss"], "n": recent["n"]}


def cmd_research(max_candidates=MAX_CANDIDATES, workers=3):
    V = versions()
    cur = V.current
    runner = BT.Runner()
    runner.seasons = runner.all_seasons()
    season = int(runner.T.games[runner.T.games.result.notna()].season.max())
    base, _ = runner.predict(cur["config"], probs=True)
    full0, recent0 = _full_and_recent(base, season)
    patterns, misses = error_analysis(base, runner.T, season)
    week = int(runner.T.games[(runner.T.games.season == season) & runner.T.games.result.notna()].slate.max())
    order = rank_candidates(patterns, season * 100 + week)[:max_candidates]
    cat = {c[0]: c for c in CATALOGUE}
    results, jobs = [], []
    for cid in order:
        _, path, how, answers = cat[cid]
        cfg = _apply(cur["config"], path, how)
        rec = {"at": now_iso(), "season": season, "week": week, "served_version": cur["version"], "candidate": cid,
               "change": {"path": path, "how": list(how)}, "answers_patterns": sorted(answers)}
        if cfg is None:
            rec.update(decision="SKIPPED", reason="no change from the served configuration")
        else:
            rec["config"] = cfg
            jobs.append(rec)
        results.append(rec)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        scored = list(pool.map(_candidate_worker, [r["config"] for r in jobs]))
    for rec, (full, recent) in zip(jobs, scored):
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
        rec.update(full=full, recent_season=recent,
                   delta={"full_mae": round(d_mae, 5), "full_logloss": round(d_ll, 6), "recent_mae": round(r_mae, 5), "recent_logloss": round(r_ll, 6)},
                   decision="PASS" if ok else "FAIL", reason="; ".join(reasons) or "clears every condition")
        print(f"candidate {rec['candidate']}: {rec['decision']} (full dMAE {d_mae:+.4f}, dLL {d_ll:+.5f}; {season - 1} dMAE {r_mae:+.4f}, dLL {r_ll:+.5f})", file=sys.stderr)
    with open(CANDIDATES, "a") as f:
        for r in results:
            f.write(json.dumps({k: v for k, v in r.items() if k != "config"}, default=_json_default) + "\n")
    passed = [r for r in results if r.get("decision") == "PASS"]
    promoted = None
    if passed:
        best = min(passed, key=lambda r: r["delta"]["full_logloss"] / MIN_GAIN["logloss"] + r["delta"]["full_mae"] / MIN_GAIN["mae"])
        promoted = V.promote(best["config"], reason=f"weekly loop {season} week {week}: candidate {best['candidate']} "
                                                    f"({best['change']['path']} {best['change']['how']}) cleared the full-backtest rule",
                             evidence={"full": best["full"], "recent_season": best["recent_season"], "delta": best["delta"],
                                       "previous": {"full": {"margin_mae": full0["margin_mae"], "logloss": full0["logloss"]},
                                                    "recent_season": {"margin_mae": recent0["margin_mae"], "logloss": recent0["logloss"]}}})
    this = base[base.season == season]
    summary = {"at": now_iso(), "season": season, "week": week, "served_before": cur["version"],
               "served_after": V.doc["current"], "promoted": promoted["version"] if promoted else None,
               "baseline": {"full": {k: full0.get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "mean_abs_vs_close")},
                            "recent_season": {k: recent0.get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss")},
                            "this_season": {k: WF.evaluate(this).get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "mean_abs_vs_close")},
                            "this_season_fbs": {k: WF.evaluate(this[BT.slice_mask(this, "fbs")]).get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss")},
                            "this_season_fcs": {k: WF.evaluate(this[BT.slice_mask(this, "fcs")]).get(k) for k in ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss")}},
               "patterns": patterns, "largest_misses": misses,
               "candidates": [{k: v for k, v in r.items() if k not in ("config",)} for r in results]}
    dump(os.path.join(WEEKLY, f"{season}-w{week:02d}.json"), summary)
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
    md = [f"# CFB weekly model report: {s['season']} week {s['week']}\n",
          f"Generated {s['at']}. Served version **{cur['version']}** ({cur['status']}; promoted by {cur['promoted_by']} on {cur['promoted_at'][:10]}).\n",
          "## What changed\n"]
    if s["promoted"]:
        v = V.get(s["promoted"])
        e = v["evidence"]
        md.append(f"**Promoted {s['served_before']} → {s['promoted']}.** {v['reason']}.\n")
        md.append(f"- Full backtest {EVAL_FROM}–{s['season']}: MAE {e['previous']['full']['margin_mae']} → {e['full']['margin_mae']}, "
                  f"log loss {e['previous']['full']['logloss']} → {e['full']['logloss']}")
        md.append(f"- {s['season'] - 1} season: MAE {e['previous']['recent_season']['margin_mae']} → {e['recent_season']['margin_mae']}, "
                  f"log loss {e['previous']['recent_season']['logloss']} → {e['recent_season']['logloss']}")
        md.append(f"- Roll back: point `current` in docs/model-loop/cfb/versions.json at {s['served_before']}.\n")
    else:
        md.append(f"**Nothing promoted.** {len([c for c in s['candidates'] if c.get('decision') != 'SKIPPED'])} candidates were tested; none cleared the full-backtest rule "
                  f"(both MAE ≤ −{MIN_GAIN['mae']} and log loss ≤ −{MIN_GAIN['logloss']} over {EVAL_FROM}–{s['season']}, and no worse on {s['season'] - 1}). "
                  f"v{cur['version']} keeps serving.\n")
    b = s["baseline"]
    md.append("## Accuracy against the closing line (walk-forward, out of sample)\n")
    md.append("| Window | n | Model MAE | Close MAE | Log loss | Close log loss |\n|---|---|---|---|---|---|")
    for lab, k in ((f"{s['season']} to date, all", "this_season"), (f"{s['season']} to date, FBS vs FBS", "this_season_fbs"),
                   (f"{s['season']} to date, FBS vs FCS", "this_season_fcs"), (f"{s['season'] - 1}", "recent_season"),
                   (f"{EVAL_FROM}–{s['season']}", "full")):
        x = b.get(k) or {}
        md.append(f"| {lab} | {x.get('n')} | {x.get('margin_mae')} | {x.get('close_margin_mae')} | {x.get('logloss')} | {x.get('close_logloss')} |")
    if rec and rec.get("season_to_date"):
        st, lw = rec["season_to_date"], rec.get("last_week", {})
        md.append("\n## The published record (pregame numbers as they were served)\n")
        md.append("| Window | n | Model MAE | Close MAE | \\|model − close\\| | Brier | Log loss | CLV (pts, n) | ATS vs close | Flags |\n|---|---|---|---|---|---|---|---|---|---|")
        for lab, x in ((f"Week {lw.get('week')}", lw), ("Season to date", st)):
            if x:
                md.append(f"| {lab} | {x['n']} | {x['model_mae']} | {x['close_mae']} | {x['mean_abs_vs_close']} | {x['brier']} | {x['logloss']} | "
                          f"{x['clv_mean_pts']} ({x['clv_n']}) | {x['ats_vs_close']} | {x['flags']} |")
        flagged = [g for g in rec["games"] if g["flag"] and g["week"] == lw.get("week")]
        if flagged:
            md.append(f"\n### FBS games where the model differed from the close by {CARDS.FLAG:g}+ points\n")
            md.append("| Game | Model | Close | Result | Drivers |\n|---|---|---|---|---|")
            for g in flagged:
                md.append(f"| {g['away']} @ {g['home']} | {g['home']} {-g['model_home_margin']:+.1f} | {g['home']} {-g['close_home_margin']:+.1f} | "
                          f"{g['result']:+.0f} | " + "; ".join(f"{d['key']} {d['points']:+.2f}" for d in g["drivers"]) + " |")
    else:
        md.append("\n*The published record starts with the first week this version served; nothing it published has settled yet.*\n")
    md.append("\n## Where the misses concentrate (this season and last, walk-forward)\n")
    md.append("Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.\n")
    md.append("| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |\n|---|---|---|---|---|---|---|")
    for pt in s["patterns"]:
        md.append(f"| {pt['pattern']} | {pt['n']} | {pt['line_bias']:+.2f} | {pt['line_t']} | {pt['outcome_bias']:+.2f} | {pt['outcome_t']} | {pt['close_beats_model_by']:+.2f} |")
    md.append("\n## This season's largest misses against the close, by component\n")
    md.append("| Game | Model | Close | Result | Gap | Largest components |\n|---|---|---|---|---|---|")
    for m in s["largest_misses"]:
        md.append(f"| {m['game']} | {m['model']:+.1f} | {m['close']:+.1f} | {m['result']:+.0f} | {m['gap']:+.1f} | "
                  + "; ".join(f"{c['key']} {c['points']:+.2f}" for c in m["top_components"]) + " |")
    md.append("\n## Every candidate tried this week\n")
    md.append("| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |\n|---|---|---|---|---|---|---|")
    for c in s["candidates"]:
        d = c.get("delta") or {}
        md.append(f"| {c['candidate']} | `{c['change']['path']}` {c['change']['how']} | {d.get('full_mae', '—')} | {d.get('full_logloss', '—')} | "
                  f"{d.get('recent_mae', '—')} | {d.get('recent_logloss', '—')} | {c['decision']}: {c.get('reason', '')} |")
    md.append("\nEvery candidate ever tried is in `docs/model-loop/cfb/candidates.jsonl`; the version history in `docs/model-loop/cfb/versions.json`.")
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
    ap.add_argument("--no-fetch", action="store_true", help="use the cached sportsdataverse files")
    ap.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES)
    a = ap.parse_args(argv)
    if a.cmd == "refresh":
        cmd_refresh(fetch=not a.no_fetch)
    elif a.cmd == "score":
        cmd_score()
    elif a.cmd == "research":
        cmd_research(a.max_candidates)
    elif a.cmd == "report":
        cmd_report()
    else:
        cmd_all(fetch=not a.no_fetch)


if __name__ == "__main__":
    main()
