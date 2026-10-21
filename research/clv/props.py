"""Player props (NFL, CFB): the single pre-registered holdout run of the
production props model (EXPERIMENTS.md, NFL-P1 / CFB-P1).

  python3 -m research.clv.props nfl
  python3 -m research.clv.props cfb
"""
import json
import os
import re
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from research.clv import runner

ROOT = runner.RESULTS.rsplit("/research/", 1)[0]
TOL = pd.Timedelta(minutes=5)


def _norm(name):
    s = re.sub(r"[^a-z ]", "", str(name).lower())
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return " ".join(s.split())


def _ticks(main):
    """[ts, line, over, under] -> rows with both prices filled forward."""
    rows, over, under = [], None, None
    for t in main:
        ts, line, o, u = (t + [None] * 4)[:4]
        over = o if o is not None else over
        under = u if u is not None else under
        rows.append((pd.Timestamp(ts), line, over, under))
    return rows


def frame(league):
    base = os.path.join(ROOT, "football", "props", league, "2026")
    closes = {}
    with open(os.path.join(base, "closes.jsonl")) as f:
        for l in f:
            e = json.loads(l)
            ko = pd.Timestamp(e["commence_time"])
            for key, p in e["props"].items():
                name, market = key.split("|", 1)
                closes[(ko, _norm(p.get("player_name") or name), market)] = (ko, p["books"])
    ev = pd.DataFrame([json.loads(l) for l in open(os.path.join(base, "evaluations.jsonl"))])
    ev = ev[(ev.kind == "qualified") & ev.side.isin(["over", "under"])].copy()
    ev["evaluated_at"] = pd.to_datetime(ev.evaluated_at)
    ev = ev.sort_values("evaluated_at").drop_duplicates("prop_id", keep="first")
    rows, miss = [], {"no_close_record": 0, "no_book": 0, "no_open_tick": 0, "line_mismatch": 0, "one_sided": 0}
    for r in ev.itertuples(index=False):
        ko = pd.Timestamp(r.kickoff)
        hit = closes.get((ko, _norm(r.player_name), r.market))
        if not hit:
            miss["no_close_record"] += 1
            continue
        book = (hit[1].get(r.book) or {}).get("main")
        if not book:
            miss["no_book"] += 1
            continue
        tk = _ticks(book)
        op = [t for t in tk if t[0] <= r.evaluated_at + TOL]
        cl = [t for t in tk if t[0] < ko]
        if not op or not cl:
            miss["no_open_tick"] += 1
            continue
        o, c = op[-1], cl[-1]
        if o[1] != r.line:
            miss["line_mismatch"] += 1
            continue
        if None in (o[2], o[3], c[2], c[3]):
            miss["one_sided"] += 1
            continue
        p_over = r.p_side if r.side == "over" else 1 - r.p_side
        rows.append({"season": 2026, "game_id": f"{r.game_id}|{r.prop_id}", "cluster": r.game_id, "market": r.market,
                     "side_model": r.side, "evaluated_at": r.evaluated_at, "open_line": o[1], "close_line": c[1],
                     "open_a": o[2], "open_b": o[3], "close_a": c[2], "close_b": c[3], "model_prob": p_over})
    return pd.DataFrame(rows), miss, int(len(ev))


def run(league):
    eid = {"nfl": "NFL-P1", "cfb": "CFB-P1"}[league]
    x, miss, n_eval = frame(league)
    k = runner.k_sport(league) + 1
    same = x[x.open_line == x.close_line]
    moved = x[x.open_line != x.close_line].copy()
    cfg = H.HarnessConfig(kind="price", market="player_prop", thresholds=(0.02, 0.05), primary=0.02,
                          buckets=(0, 0.02, 0.05, 0.1, 1))
    rep = runner.run(league, eid, same, cfg, f"production props model v1, {league.upper()} player props (same-line bets)",
                     holdout=True, k_tests=k, extra={"unmatched": miss, "first_evaluations": n_eval,
                                                       "same_line_props": int(len(same)), "moved_line_props": int(len(moved))})
    # line-moved props: did the line move toward the side the model would bet?
    p_open = H.no_vig(moved.open_a, moved.open_b)
    edge = moved.model_prob - p_open
    bet = moved[np.abs(edge) >= 0.02].copy()
    side = np.sign((bet.model_prob - H.no_vig(bet.open_a, bet.open_b)).to_numpy())
    toward = np.sign((bet.close_line - bet.open_line).to_numpy()) * side
    out = {"same_line": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k),
           "clv_ev": rep["primary"].get("clv_ev", {}).get("mean"), "unmatched": miss,
           "moved_line_bets": int(len(bet)), "moved_toward_share": round(float((toward > 0).mean()), 4) if len(bet) else None}
    print(eid, json.dumps(out, default=str))
    with open(os.path.join(runner.RESULTS, league, f"{eid}_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)


if __name__ == "__main__":
    run(sys.argv[1])
