"""The board's number against the loop's, on the same games, pregame only.

The site's board prices each game with its own engine (football/nfl/slate.json,
football/fbs/slate.json). A loop serves its version beside it. To know which
deserves the board, both are graded the same way: every refresh appends the
board's current number to an append-only ledger, stamped with the time the
board built it; at scoring time each side's last number published before
kickoff is graded against the result and the close. Read only: a loop never
writes the board's files.
"""
import hashlib
import json
import os

import numpy as np
import pandas as pd

from . import metrics as M


def capture(slate_path, ledger_path, season, captured_at):
    """Append the board's number for every upcoming game whose number changed."""
    try:
        with open(slate_path) as f:
            sl = json.load(f)
    except (OSError, ValueError):
        return 0
    built = sl.get("generated_at")
    last = {}
    if os.path.exists(ledger_path):
        for line in open(ledger_path):
            if line.strip():
                r = json.loads(line)
                last[str(r["game_id"])] = r["content_sha256"]
    n = 0
    os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
    with open(ledger_path, "a") as f:
        for g in sl.get("games") or []:
            if g.get("model_status") != "PREDICTED" or g.get("season") != season or not built or built >= (g.get("kickoff") or ""):
                continue
            m = g.get("model_home_margin_exact", g.get("model_home_margin"))
            if m is None or g.get("model_home_win_prob") is None:
                continue
            gid = str(g["game_id"])
            body = {"game_id": gid, "week": g.get("week"), "model_version": g.get("model_version"),
                    "home_margin": round(float(m), 4), "home_win_prob": round(float(g["model_home_win_prob"]), 4)}
            sha = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if last.get(gid) == sha:
                continue
            f.write(json.dumps(dict(body, published_at=built, captured_at=captured_at, content_sha256=sha), sort_keys=True) + "\n")
            n += 1
    return n


def pregame(path, game_id_to_kick):
    """{game_id: the last row published before kickoff} from an append-only ledger."""
    out = {}
    if not os.path.exists(path):
        return out
    kick = {str(k): v for k, v in game_id_to_kick.items()}
    for line in open(path):
        if not line.strip():
            continue
        r = json.loads(line)
        gid = str(r["game_id"])
        ko = kick.get(gid)
        if ko is None or pd.Timestamp(r["published_at"]) >= ko:
            continue
        if gid not in out or r["published_at"] >= out[gid]["published_at"]:
            out[gid] = r
    return out


def attach(rows, board):
    """Put the board's pregame number on each graded row (rows: the loop's
    record rows with result, home_win_prob, brier...)."""
    for r in rows:
        b = board.get(str(r["game_id"]))
        if b:
            y = None if r["result"] == 0 else (1.0 if r["result"] > 0 else 0.0)
            r["board"] = {"version": b["model_version"], "published_at": b["published_at"], "home_margin": b["home_margin"],
                          "home_win_prob": b["home_win_prob"], "abs_err": abs(r["result"] - b["home_margin"]),
                          "brier": (b["home_win_prob"] - y) ** 2 if y is not None else None}
    return rows


def summary(rs):
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


def section(rows, last_week, source):
    """The record's head_to_head block, or None before any game has both numbers."""
    both = [r for r in rows if r.get("board")]
    if not both:
        return None
    lw = [r for r in both if r["week"] == last_week]
    return {"rule": "same games, each side's last number published before kickoff; the board's number is captured "
                    f"from {source} at each refresh",
            "season_to_date": summary(both), "last_week": dict(summary(lw), week=last_week) if lw else None}


def report_md(hh):
    """The weekly report's table."""
    if not hh:
        return []
    md = ["\n## Head to head with the board's number (same games, pregame)\n",
          "| Window | n | Model loop MAE | Board MAE | Close MAE | Model loop log loss | Board log loss | Model loop Brier | Board Brier |\n|---|---|---|---|---|---|---|---|---|"]
    for lab, x in (("Last week", hh.get("last_week")), ("Season to date", hh["season_to_date"])):
        if x:
            a, b = x["model_loop"], x["board"]
            md.append(f"| {lab} | {x['n']} | {a['mae']} | {b['mae']} | {x['close_mae']} | {a['logloss']} | {b['logloss']} | {a['brier']} | {b['brier']} |")
    md.append("\nOne season is not enough to rank two models; this table is the running record, and the full backtest decides promotions.\n")
    return md
