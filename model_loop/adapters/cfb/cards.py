"""CFB v2 cards for the upcoming games: the fair line, win probability, fair
moneylines, the centred 80% range, component rows that sum exactly to the
fair line (grouped as base strength / environment / rest), the prior-vs-
this-season split of base strength, and the disagreement flag.

The quarterback priced is, in order: the starter the current board already
resolved (football/fbs/slate.json home_starter / away_starter: an announced
starter, or the one who started the last game), else the side's most recent
starter in the play-by-play, else the side's debut-QB prior. The basis is
printed on the card.

Disagreement thresholds are the audit's CFB proposal (docs/model-loop/
audit_report.md §CFB 8): flag at 8 points (10 while either side has played
3 or fewer games, 7 from 6 games), watch at 6, and 14+ is presumed a model or
data fault. FBS-vs-FCS games are never flagged.

  python3 -m model_loop.adapters.cfb.cards [--config docs/model-loop/cfb/backtest.json] [--days 10]
Writes docs/model-loop/cfb/cards_current.json.
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ...core import snapshots
from ...core.walkforward import content_hash
from .ratings import Tables, CfbRatingPass
from . import model as CM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DATA = os.path.join(ROOT, ".cache", "model_loop", "cfb")
DOCS = os.path.join(ROOT, "docs", "model-loop", "cfb")
V1_SLATE = os.path.join(ROOT, "football", "fbs", "slate.json")
FLAG = 8.0
FLAG_EARLY = 10.0          # either side has played 3 or fewer games
FLAG_LATE = 7.0            # both sides have played 6 or more
WATCH = 6.0
FAULT = 14.0
GROUP_LABEL = {"base_strength": "Base strength", "environment": "Environment", "rest_travel": "Rest"}


def starters_from_v1():
    """({game_id: ((home_id, basis), (away_id, basis))}, {player_id: name})
    from the current board's starter resolution."""
    out, names = {}, {}
    try:
        s = json.load(open(V1_SLATE))
    except Exception:
        return out, names
    for g in s.get("games", []):
        sides = []
        for side in ("home", "away"):
            st = g.get(side + "_starter") or {}
            if st.get("player_id"):
                sides.append((str(st["player_id"]), "board starter: " + str(st.get("label") or st.get("status"))))
                names[str(st["player_id"])] = st.get("player_name")
            else:
                sides.append((None, None))
        try:
            out[int(g["game_id"])] = tuple(sides)
        except (KeyError, ValueError):
            continue
    return out, names


def last_starter(T, team, season):
    q = T.qbs[(T.qbs.team == team) & (T.qbs.season == season)]
    if not len(q):
        return None
    wk = q.week.max()
    q = q[q.week == wk]
    return str(q.assign(n=q.n_in + q.n_out).sort_values("n", ascending=False).qb_id.iloc[0])


def games_played(T, team, season):
    g = T.games[(T.games.season == season) & T.games.result.notna()]
    return int(((g.home == team) | (g.away == team)).sum())


def threshold(gp_min):
    return FLAG_EARLY if gp_min <= 3 else FLAG_LATE if gp_min >= 6 else FLAG


def drivers(card, ref_margin):
    """What carries the disagreement with the market. The market-rating row
    is last week's market; the other base-strength rows are where the model's
    own evidence departs from it."""
    if ref_margin is None or not np.isfinite(ref_margin):
        return None
    gap = card["fair_home_margin"] - ref_margin
    rows = [c for c in card["components"] if c["key"] not in ("home_field", "market") and abs(c["points"]) >= 0.25]
    same = sorted([c for c in rows if np.sign(c["points"]) == np.sign(gap)], key=lambda c: -abs(c["points"]))
    return {"gap_points": gap, "direction": "home" if gap > 0 else "away",
            "drivers": [{"key": c["key"], "label": c["label"], "points": round(c["points"], 2),
                         "prior_share": c.get("prior_share")} for c in same[:4]]}


def upcoming(games, now, days):
    """Games with no result that kick off after `now` and within `days`. A card is a pregame
    number, so a game already under way is not published (the record grades only numbers
    published before kickoff either way)."""
    up = games[games.result.isna()]
    return up[(up.kick_utc > pd.Timestamp(now)) & (up.kick_utc <= pd.Timestamp(now) + pd.Timedelta(days=days))]


def build(cfg, days=10, now=None):
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    T = Tables(os.path.join(DATA, "build"))
    v1, names = starters_from_v1()
    up = upcoming(T.games, now, days)
    # the season being carded: the upcoming games' (week 0 of a new season has no result yet)
    season = int(up.season.max()) if len(up) else int(T.games[T.games.result.notna()].season.max())
    up = up[up.season == season]
    overrides, basis = {}, {}
    for g in up.itertuples():
        pair = v1.get(int(g.game_id), ((None, None), (None, None)))
        sides = []
        for (qid, why), team in ((pair[0], g.home), (pair[1], g.away)):
            if qid:
                sides.append((qid, why))
            else:
                ls = last_starter(T, team, season)
                why = "most recent starter (play-by-play)"
                if not ls:
                    ls, why = last_starter(T, team, season - 1), "last season's final starter (play-by-play)"
                sides.append((ls, why if ls else "no starter known (debut-QB prior)"))
        overrides[g.game_id] = (sides[0][0], sides[1][0])
        basis[g.game_id] = (sides[0][1], sides[1][1])
    rp = CfbRatingPass(T, cfg["rating"])
    rows, snaps = rp.run(list(range(2008, season + 1)), keep_snapshots_for=(season,), qb_overrides=overrides)
    pred, info = CM.walk_forward(rows, cfg["model"])
    pred, dists = CM.add_probabilities(pred, cfg["model"])
    d = dists[season]
    names = info["names"]
    coef = info["margin"][season]
    ref = dict(zip(T.games.game_id, T.games.ref_margin))
    gp = {}
    cards = []
    for _, r in pred[pred.game_id.isin(up.game_id)].sort_values(["kick_utc", "game_id"]).iterrows():
        c = CM.card(r, coef, d, names)
        pmap = {"pass_off": "p_pass_off", "pass_def": "p_pass_def", "qb": "p_qb", "rush_off": "p_rush_off",
                "rush_def": "p_rush_def", "market": "p_market"}
        for comp in c["components"]:
            comp["points"] = round(comp["points"], 4)
            if comp["key"] in pmap:
                prior_pts = coef[comp["key"]] * r[pmap[comp["key"]]]
                comp["from_prior"] = round(prior_pts, 4)
                comp["from_this_season"] = round(comp["points"] - prior_pts, 4)
                comp["prior_share"] = round(abs(prior_pts) / (abs(prior_pts) + abs(comp["points"] - prior_pts)), 3) \
                    if abs(prior_pts) + abs(comp["points"] - prior_pts) > 1e-9 else None
        groups = {}
        for comp in c["components"]:
            groups.setdefault(comp["group"], 0.0)
            groups[comp["group"]] += comp["points"]
        # the fair line is the exact sum of the rounded rows' unrounded values; the
        # reconciliation is checked on the unrounded numbers
        rm = ref.get(r.game_id)
        rm = float(rm) if rm is not None and np.isfinite(rm) else None
        gap = (c["fair_home_margin"] - rm) if rm is not None else None
        fbs_game = r.home_div == "fbs" and r.away_div == "fbs"
        for t in (r.home, r.away):
            if t not in gp:
                gp[t] = games_played(T, t, season)
        gpm = min(gp[r.home], gp[r.away])
        flag = None
        if gap is not None and fbs_game:
            th = threshold(gpm)
            level = "MODEL/DATA FAULT?" if abs(gap) >= FAULT else "FLAG" if abs(gap) >= th else "WATCH" if abs(gap) >= WATCH else None
            if level:
                dr = drivers(c, rm)
                flag = {"level": level, "threshold_points": th, "games_played_min": gpm,
                        "text": f"Model disagrees with market by {abs(gap):.1f}"
                        + (" (14+: presumed a model or data fault, not an edge)" if level.startswith("MODEL") else ""), **dr}
        cards.append({
            "game_id": str(r.game_id), "week": int(r.week), "home": r.home_name, "away": r.away_name,
            "home_id": int(r.home), "away_id": int(r.away), "home_division": r.home_div, "away_division": r.away_div,
            "home_conference": r.home_conf if isinstance(r.home_conf, str) else None,
            "away_conference": r.away_conf if isinstance(r.away_conf, str) else None, "neutral_site": bool(r.neutral),
            "kickoff_utc": pd.Timestamp(r.kick_utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "starters": {"home": {"id": overrides[r.game_id][0], "name": r.home_qb_name or names.get(overrides[r.game_id][0]),
                                  "basis": basis[r.game_id][0]},
                         "away": {"id": overrides[r.game_id][1], "name": r.away_qb_name or names.get(overrides[r.game_id][1]),
                                  "basis": basis[r.game_id][1]}},
            "fair_home_margin": round(c["fair_home_margin"], 2), "fair_home_line": round(-c["fair_home_margin"], 2),
            "fair_total": round(float(r.pred_total), 2) if np.isfinite(r.pred_total) else None,
            "home_win_prob": round(c["home_win_prob"], 4), "tie_prob": round(c["tie_prob"], 4),
            "fair_home_ml": c["fair_home_ml"], "fair_away_ml": c["fair_away_ml"],
            "range80": {k: round(v, 2) for k, v in c["range80"].items()},
            "groups": {GROUP_LABEL[k]: round(v, 4) for k, v in groups.items()},
            "components": c["components"],
            "reconciliation": {"components_sum": round(c["components_sum"], 6), "fair_home_margin": round(c["fair_home_margin"], 6),
                               "unattributed": round(c["unattributed"], 9)},
            "games_played": {"home": gp[r.home], "away": gp[r.away]},
            "market_reference": {"home_line": -rm if rm is not None else None,
                                 "source": "CFBD consensus via sportsdataverse cfb_matchup_line (reference, not a price)"
                                 if rm is not None else "no line on file (FBS-vs-FCS games are not carried by the feed)"},
            "qb_scenarios": [],
            "disagreement": flag,
        })
    out = {"schema": "edgedesk_model_loop_cfb_cards_v1", "model_version": cfg.get("version", "cfb_v2.0.0"),
           "status": "EXPERIMENTAL", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "season": season, "config_sha256": content_hash({k: v for k, v in cfg.items() if k in ("rating", "model")}),
           "distribution": d.to_json(), "coefficients": coef,
           "thresholds": {"flag_points": FLAG, "flag_points_early": FLAG_EARLY, "flag_points_late": FLAG_LATE,
                          "watch_points": WATCH, "fault_points": FAULT, "fbs_vs_fcs": "never flagged"},
           "note": "CFB model loop v2. Research cards; the served version is in docs/model-loop/cfb/versions.json.",
           "games": cards}
    return out, snaps


def rows_from_snapshot(snap, season, week, model_key, model_version, config_sha, fitted_at):
    """One CFB weekly snapshot -> ledger rows (public.model_rating_snapshots)."""
    r6 = lambda x: None if x is None else round(float(x), 6)
    out = []
    for team, r in snap["teams"].items():
        ratings = {k: r6(r[k]) for k in ("pass_off", "pass_def", "rush_off", "rush_def", "market", "total") if r.get(k) is not None}
        prior = {k: r6(r[k + "_prior"]) for k in ("pass_off", "pass_def", "rush_off", "rush_def") if r.get(k + "_prior") is not None}
        out.append({"sport": "CFB", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                    "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "team",
                    "entity_id": str(team), "ratings": dict(ratings, division=r["div"]), "from_prior": prior,
                    "from_season": {k: r6(ratings[k] - prior[k]) for k in prior}})
    for q, v in snap["qb"].items():
        out.append({"sport": "CFB", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                    "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "player",
                    "entity_id": q, "ratings": {"qb": r6(v)}, "from_prior": {}, "from_season": {}})
    out.append({"sport": "CFB", "model_key": model_key, "model_version": model_version, "config_sha256": config_sha,
                "season": int(season), "slate_key": str(week), "fitted_at": fitted_at, "entity_type": "league",
                "entity_id": "FBS", "ratings": {"mu_pass": r6(snap["mu"]["pass"]), "mu_rush": r6(snap["mu"]["rush"]),
                                                "home_epa_pass": r6(snap["home_epa"]["pass"]), "home_epa_rush": r6(snap["home_epa"]["rush"]),
                                                "market_home": r6(snap.get("market_base")), "total_base": r6(snap.get("total_base")),
                                                "division_means": snap.get("division_means")},
                "from_prior": {}, "from_season": {}})
    for r in out:
        r["snapshot_id"] = snapshots.row_id(r)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.path.join(DOCS, "backtest.json"))
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--out", default=os.path.join(DOCS, "cards_current.json"))
    ap.add_argument("--ledger", default=os.path.join(ROOT, "model_loop", "ledger", "cfb"))
    a = ap.parse_args(argv)
    j = json.load(open(a.config))
    cfg = j.get("final_config") or j.get("cfg")
    out, snaps = build(cfg, a.days)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else str(o))
    rows = []
    last_week = max([g["week"] for g in out["games"]], default=0)
    for (season, week), snap in sorted(snaps.items()):
        if week > last_week:
            continue
        rows += rows_from_snapshot(snap, season, week, "CFB-CORE", out["model_version"].replace("cfb_v", ""),
                                   out["config_sha256"], out["generated_at"])
    n = snapshots.append(os.path.join(a.ledger, f"{out['season']}.jsonl"), rows) if rows else 0
    print(a.out, len(out["games"]), "snapshot rows added:", n)


if __name__ == "__main__":
    main()
