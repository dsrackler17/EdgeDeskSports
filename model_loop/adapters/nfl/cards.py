"""NFL v2 cards for the upcoming games: the fair line, win probability,
fair moneylines, the centred 80% range, component rows that sum exactly to
the fair line (grouped as base strength / environment / rest & travel), the
prior-vs-this-season split of base strength, and the disagreement flag.

The starter priced is, in order: the reconciled starter the v1 slate build
already resolved (football/nfl/slate.json home_starter / away_starter), the
depth chart's QB1 from the same file, the schedule feed's name, and finally
the club's most recent starter. The basis is printed on the card.

  python3 -m model_loop.adapters.nfl.cards [--config docs/model-loop/nfl/tuned_config.json] [--days 12]
Writes docs/model-loop/nfl/cards_current.json.
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
from .ratings import Tables, NflRatingPass
from . import model as NM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DATA = os.path.join(ROOT, ".cache", "model_loop", "nfl")
DOCS = os.path.join(ROOT, "docs", "model-loop", "nfl")
V1_SLATE = os.path.join(ROOT, "football", "nfl", "slate.json")
THRESHOLD = 3.0          # proposed in the audit: flag at 3 points vs the market
WATCH = 2.0
GROUP_LABEL = {"base_strength": "Base strength", "environment": "Environment", "rest_travel": "Rest & travel"}


def starters_from_v1():
    """{game_id: ((home_id, basis, alt_id), (away_id, basis, alt_id))} from the
    v1 slate's starter reconciliation. A CONFLICT (feed and depth chart name
    different players and the last game does not settle it) is priced on the
    feed's name, as v1 does, and carries the depth chart's name as the
    alternate, so the card shows the number under both."""
    out = {}
    try:
        s = json.load(open(V1_SLATE))
    except Exception:
        return out
    for g in s.get("games", []):
        sides = []
        for side in ("home", "away"):
            st = g.get(side + "_starter") or {}
            chk = (g.get("starter_check") or {}).get(side) or {}
            dc = (chk.get("depth_chart") or {})
            if chk.get("status") == "CONFLICT":
                feed = (chk.get("schedule_feed") or {}).get("id") or st.get("player_id")
                sides.append((feed, "UNRESOLVED: schedule feed names " + str((chk.get("schedule_feed") or {}).get("name"))
                              + ", depth chart names " + str(dc.get("name")), dc.get("id")))
            elif st.get("player_id"):
                sides.append((st["player_id"], "reconciled starter (" + str(st.get("status") or "schedule feed") + ")", None))
            elif dc.get("id"):
                sides.append((dc["id"], "depth chart QB1 (" + str(dc.get("published_at")) + ")", None))
            else:
                sides.append((None, None, None))
        out[g["game_id"]] = tuple(sides)
    return out


def last_starter(T, team, season):
    q = T.qbs[(T.qbs.team == team) & (T.qbs.season == season)]
    if not len(q):
        return None
    wk = q.week.max()
    q = q[q.week == wk]
    return str(q.assign(n=q.n_in + q.n_out).sort_values("n", ascending=False).qb_id.iloc[0])


def drivers(card, close_margin):
    """What carries the disagreement with the market. The market-rating row
    is last week's market; the other base-strength rows are where the model's
    own evidence departs from it; '(market move since last week)' is the
    part of the gap the close has and the market rating does not."""
    if close_margin is None or not np.isfinite(close_margin):
        return None
    gap = card["fair_home_margin"] - close_margin
    rows = [c for c in card["components"] if c["key"] not in ("home_field", "market") and abs(c["points"]) >= 0.25]
    same = sorted([c for c in rows if np.sign(c["points"]) == np.sign(gap)], key=lambda c: -abs(c["points"]))
    return {"gap_points": gap, "direction": "home" if gap > 0 else "away",
            "drivers": [{"key": c["key"], "label": c["label"], "points": round(c["points"], 2),
                         "prior_share": c.get("prior_share")} for c in same[:4]]}


def build(cfg, days=12, now=None):
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    T = Tables(os.path.join(DATA, "build"))
    season = int(T.games[T.games.result.notna()].season.max())
    v1 = starters_from_v1()
    up = T.games[(T.games.season == season) & T.games.result.isna()]
    up = up[(pd.to_datetime(up.gameday) >= pd.Timestamp(now.date()) - pd.Timedelta(days=1)) &
            (pd.to_datetime(up.gameday) <= pd.Timestamp(now.date()) + pd.Timedelta(days=days))]
    overrides, basis, alternates = {}, {}, {}
    for g in up.itertuples():
        pair = v1.get(g.game_id, ((None, None, None), (None, None, None)))
        sides = []
        for (qid, why, alt), team, feed in ((pair[0], g.home, g.home_qb_id), (pair[1], g.away, g.away_qb_id)):
            if qid:
                sides.append((qid, why, alt))
            elif isinstance(feed, str):
                sides.append((feed, "schedule feed", None))
            else:
                ls = last_starter(T, team, season)
                sides.append((ls, "most recent starter" if ls else "no starter known (prior QB value)", None))
        overrides[g.game_id] = (sides[0][0], sides[1][0])
        basis[g.game_id] = (sides[0][1], sides[1][1])
        if sides[0][2] or sides[1][2]:
            alternates[g.game_id] = (sides[0][2], sides[1][2])
    rp = NflRatingPass(T, cfg["rating"])
    rows, snaps = rp.run(list(range(2006, season + 1)), keep_snapshots_for=(season,), qb_overrides=overrides, qb_alternates=alternates)
    rows = NM.add_geo(rows)
    pred, info = NM.walk_forward(rows, cfg["model"])
    pred, dists = NM.add_probabilities(pred, cfg["model"])
    d = dists[season]
    names = info["names"]
    coef = info["margin"][season]
    cards = []
    for _, r in pred[pred.game_id.isin(up.game_id)].sort_values(["week", "game_id"]).iterrows():
        c = NM.card(r, coef, d, names)
        # prior vs this season for each base-strength row (exact: the ratings are linear in the prior)
        pmap = {"pass_off": "p_pass_off", "pass_def": "p_pass_def", "qb": "p_qb", "rush_off": "p_rush_off",
                "rush_def": "p_rush_def", "market": "p_market"}
        xmap = {"pass_off": "x_pass_off", "pass_def": "x_pass_def", "qb": "x_qb", "rush_off": "x_rush_off",
                "rush_def": "x_rush_def", "market": "x_market"}
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
        close = r.close_margin if np.isfinite(r.close_margin) else None
        gap = (c["fair_home_margin"] - close) if close is not None else None
        # a contested starter: the same card priced with the other name
        scenarios = []
        alt = alternates.get(r.game_id)
        if alt:
            qb_now = next((x["points"] for x in c["components"] if x["key"] == "qb"), 0.0)
            for side, key, qid in (("home", "x_qb_alt_home", alt[0]), ("away", "x_qb_alt_away", alt[1])):
                if qid and key in r and np.isfinite(r[key]):
                    m2 = c["fair_home_margin"] - qb_now + coef.get("qb", 0.0) * r[key]
                    w2, _, l2 = d.win_tie_loss(m2)
                    scenarios.append({"if": f"{side} starter is {T.qb_name.get(qid, qid)}", "qb_id": qid,
                                      "fair_home_line": round(-m2, 2), "home_win_prob": round(float(w2[0] / (w2[0] + l2[0])), 4),
                                      "gap_vs_market": round(m2 - close, 2) if close is not None else None})
        flag = None
        if gap is not None:
            level = "FLAG" if abs(gap) >= THRESHOLD else "WATCH" if abs(gap) >= WATCH else None
            if scenarios and level:
                level = "QB UNRESOLVED"
            if level:
                dr = drivers(c, close)
                flag = {"level": level, "text": f"Model disagrees with market by {abs(gap):.1f}"
                        + (" with the schedule feed's starter; the starter is contested (see scenarios)" if scenarios else ""), **dr}
        cards.append({
            "game_id": r.game_id, "week": int(r.week), "home": r.home, "away": r.away, "kickoff_et": str(r.kick_et),
            "starters": {"home": {"id": overrides[r.game_id][0], "name": r.home_qb_name, "basis": basis[r.game_id][0]},
                         "away": {"id": overrides[r.game_id][1], "name": r.away_qb_name, "basis": basis[r.game_id][1]}},
            "fair_home_margin": round(c["fair_home_margin"], 2), "fair_home_line": round(-c["fair_home_margin"], 2),
            "fair_total": round(float(r.pred_total), 2) if np.isfinite(r.pred_total) else None,
            "home_win_prob": round(c["home_win_prob"], 4), "fair_home_ml": c["fair_home_ml"], "fair_away_ml": c["fair_away_ml"],
            "range80": {k: round(v, 2) for k, v in c["range80"].items()},
            "groups": {GROUP_LABEL[k]: round(v, 4) for k, v in groups.items()},
            "components": c["components"],
            "reconciliation": {"components_sum": round(c["components_sum"], 6), "fair_home_margin": round(c["fair_home_margin"], 6),
                               "unattributed": round(c["unattributed"], 9)},
            "market_reference": {"home_line": -close if close is not None else None,
                                 "source": "nflverse games.csv consensus (reference, not a price)"},
            "qb_scenarios": scenarios,
            "disagreement": flag,
        })
    out = {"schema": "edgedesk_model_loop_nfl_cards_v1", "model_version": cfg.get("version", "nfl_v2.0.0-candidate"),
           "status": "EXPERIMENTAL", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "season": season, "config_sha256": content_hash(cfg),
           "distribution": d.to_json(), "coefficients": coef,
           "thresholds": {"flag_points": THRESHOLD, "watch_points": WATCH},
           "note": "Research candidate. Not on the published card until it clears the preregistered decision rule "
                   "(docs/model-loop/nfl/prereg.json).", "games": cards}
    return out, snaps


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.path.join(DOCS, "backtest.json"))
    ap.add_argument("--days", type=int, default=12)
    ap.add_argument("--out", default=os.path.join(DOCS, "cards_current.json"))
    ap.add_argument("--ledger", default=os.path.join(ROOT, "model_loop", "ledger", "nfl"))
    a = ap.parse_args(argv)
    j = json.load(open(a.config))
    cfg = j.get("final_config") or j.get("cfg")
    out, snaps = build(cfg, a.days)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else str(o))
    # every week's ratings for the season, append-only (a re-run with the same inputs adds nothing)
    rows = []
    last_week = max([g["week"] for g in out["games"]], default=0)
    for (season, week), snap in sorted(snaps.items()):
        if week > last_week:
            continue                     # later weeks hold no new evidence yet
        rows += snapshots.rows_from_nfl_snapshot(snap, season, week, "NFL-CORE", out["model_version"].replace("nfl_v", ""),
                                                 out["config_sha256"], out["generated_at"])
    n = snapshots.append(os.path.join(a.ledger, f"{out['season']}.jsonl"), rows) if rows else 0
    print(a.out, len(out["games"]), "snapshot rows added:", n)


if __name__ == "__main__":
    main()
