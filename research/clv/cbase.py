"""College baseball: the model against the closing line, on prices captured
after the model was frozen (EXPERIMENTS.md, "College baseball: a forward
holdout", CBASE-H1). Nothing here prices, publishes or serves anything.

  python3 -m research.clv.cbase            count, and read the holdout once when its read point comes
  python3 -m research.clv.cbase --season 2027

THE ROWS (all committed files; college_baseball/market/fetch_quotes.js keeps them):
  model    college_baseball/data/market/<season>/models.jsonl: the model's home
           probability for a game, taken from the live board the first time the
           game was seen with a price, with the served configuration's hash.
  open     the reference book's moneyline in force when that number was taken
           (its last price seen at or before `captured_at`): the price a bettor
           could have had once the model's number was known, never earlier.
  close    the same book's last pregame price (lines.jsonl), seen no more than
           CLOSE_AGE_MAX minutes before the first pitch.
  book     the first of BOOKS that has both.
  contest  our record's game (college_baseball/data/games/<season>.csv), FINAL,
           on the board's date: a price on a game that was not played is no bet.
Side A is our record's home team.

THE READ. The holdout is read ONCE (G8): the first run on which the frozen
configuration has READ_BETS bets at the primary threshold, or the first run
from READ_BY on. Before then this module reports how many games and bets there
are and nothing about their CLV. The read goes through research.clv.runner
(pre-registration check, the attempts log) and the harness's own verdict
(G7). The frozen configuration is the one the first captured model number
carries; a configuration served later is a new experiment, registered before
its first price.
"""
import argparse
import datetime as dt
import glob
import gzip
import json
import os

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv.sources import ROOT

SPORT = "cbase"
EXP_ID = "CBASE-H1"
THRESHOLD = 0.02                 # G6: moneyline, base model, no-vig probability
READ_BETS = 500                  # lib/edgedesk_sport_brains.js: MARKET_VALIDATED needs n >= 500
MIN_BETS = 50                    # G7
READ_BY = "2027-06-30T00:00:00Z" # after the 2027 season's last game (the price job runs through June)
CLOSE_AGE_MAX = 60               # minutes before the first pitch
BOOKS = ("draftkings", "fanduel", "betmgm", "williamhill_us", "betrivers", "espnbet", "fanatics", "bovada")
OUT = os.path.join(ROOT, "college_baseball", "validation", "market_clv.json")


def _jsonl(p):
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def _ts(s):
    return pd.to_datetime(s, utc=True)


def market_dir(season, root=None):
    return os.path.join(root or ROOT, "college_baseball", "data", "market", str(season))


def observations(season, root=None):
    rows = []
    for fn in sorted(glob.glob(os.path.join(market_dir(season, root), "observations", "*.jsonl.gz"))):
        with gzip.open(fn, "rt") as f:
            rows.extend(json.loads(l) for l in f if l.strip())
    return [r for r in rows if r.get("market") == "h2h"]


def frame(season, config_sha256, root=None, games=None):
    """One row per game with the frozen model's number, an open and a close at the same book."""
    md = market_dir(season, root)
    models = [m for m in _jsonl(os.path.join(md, "models.jsonl")) if m.get("config_sha256") == config_sha256]
    lines = {(l["event_id"], l["book"]): l for l in _jsonl(os.path.join(md, "lines.jsonl")) if l.get("market") == "h2h"}
    obs = {}
    for o in observations(season, root):
        obs.setdefault((o["event_id"], o["book"]), []).append(o)
    for v in obs.values():
        v.sort(key=lambda o: o["at"])
    if games is None:
        gf = os.path.join(root or ROOT, "college_baseball", "data", "games", f"{season}.csv")
        games = pd.read_csv(gf, dtype=str) if os.path.exists(gf) else pd.DataFrame(columns=["game_id", "date", "status"])
    final = {r.game_id: r.date for r in games.itertuples() if r.status == "FINAL"}
    rows, why = [], {"no_contest": 0, "no_book_with_open_and_close": 0, "close_too_old": 0}
    for m in models:
        if final.get(m["game_id"]) != m["date"]:
            why["no_contest"] += 1
            continue
        got = None
        for book in BOOKS:
            ln = lines.get((m["event_id"], book))
            seen = [o for o in obs.get((m["event_id"], book), []) if o["at"] <= m["captured_at"]]
            if not ln or not seen:
                continue
            if ln["close_age_min"] is None or ln["close_age_min"] > CLOSE_AGE_MAX:
                why["close_too_old"] += 1
                continue
            got = (book, seen[-1]["price"], ln["close"])
            break
        if not got:
            why["no_book_with_open_and_close"] += 1
            continue
        book, op, cl = got
        flip = not m.get("provider_home_is_ours", True)
        oa, ob = (op["away"], op["home"]) if flip else (op["home"], op["away"])
        ca, cb = (cl["away"], cl["home"]) if flip else (cl["home"], cl["away"])
        rows.append({"season": int(season), "game_id": m["game_id"], "open_a": oa, "open_b": ob, "close_a": ca, "close_b": cb,
                     "model_prob": float(m["p_home"]), "cluster": m["date"], "book": book, "config_sha256": config_sha256})
    df = pd.DataFrame(rows, columns=["season", "game_id", "open_a", "open_b", "close_a", "close_b", "model_prob", "cluster", "book", "config_sha256"])
    return df, why


def config():
    return H.HarnessConfig(kind="price", market="moneyline", thresholds=(THRESHOLD,), primary=THRESHOLD)


def frozen_config(season, root=None, prior=None):
    """The configuration the first captured model number carries (fixed once found)."""
    if prior and prior.get("frozen_config_sha256"):
        return prior["frozen_config_sha256"], prior.get("frozen_version")
    models = _jsonl(os.path.join(market_dir(season, root), "models.jsonl"))
    if not models:
        return None, None
    first = min(models, key=lambda m: m["captured_at"])
    return first.get("config_sha256"), first.get("served_version")


def status(season=2027, now=None, root=None, games=None, out=None, run_read=None):
    """Count; read the holdout once at its read point; write college_baseball/validation/market_clv.json."""
    out = out or OUT
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prior = None
    if os.path.exists(out):
        with open(out) as f:
            prior = json.load(f)
    cfg_sha, version = frozen_config(season, root, prior)
    doc = {"schema": "edgedesk_cbase_market_clv_v1", "experiment": EXP_ID, "season": season, "updated_at": now,
           "rule": {"threshold": THRESHOLD, "read_bets": READ_BETS, "read_by": READ_BY, "min_bets": MIN_BETS, "close_age_max_min": CLOSE_AGE_MAX, "books": list(BOOKS)},
           "frozen_config_sha256": cfg_sha, "frozen_version": version}
    if prior and prior.get("read_at"):
        doc.update({k: prior[k] for k in ("read_at", "status", "verdict", "n_bets", "summary") if k in prior})
        doc["note"] = "read once on " + prior["read_at"] + "; never read again"
    elif not cfg_sha:
        doc.update({"status": "NOT_TESTED", "n_bets": 0, "note": "no model number has been taken with a price yet"})
    else:
        df, why = frame(season, cfg_sha, root, games)
        n = int(len(H.bet_table(df, config(), THRESHOLD))) if len(df) else 0
        doc.update({"games_with_model_open_and_close": int(len(df)), "excluded": why, "n_bets": n})
        due = n >= READ_BETS or now >= READ_BY
        if not due:
            doc.update({"status": "CAPTURING", "note": "CLV is not computed before the read point (G8: the holdout is read once)"})
        else:
            rep = (run_read or _read)(df)
            v = H.verdict(rep["primary"], rep["primary"].get("clv_prob", {}).get("k_tests", 1), min_bets=MIN_BETS)
            nb = rep["primary"].get("n_bets", 0)
            st = ("MARKET_VALIDATED" if nb >= READ_BETS else "PASSED_BELOW_MARKET_MINIMUM") if v["pass"] else ("INCONCLUSIVE" if nb < MIN_BETS else "FAILED")
            doc.update({"read_at": now, "status": st, "verdict": v, "n_bets": nb,
                        "summary": {k: rep["primary"].get(k) for k in ("n_bets", "clv_prob", "clv_ev", "direction_hit_rate") if k in rep["primary"]}})
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(doc, f, indent=1, default=float)
    return doc


def _read(df):
    from research.clv import runner
    k = runner.k_sport(SPORT) + 1
    return runner.run(SPORT, EXP_ID, df, config(), "production college baseball model (frozen), moneyline >= 0.02, 2027 forward holdout",
                      holdout=True, k_tests=k, notes="read once at its pre-registered read point")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2027)
    a = ap.parse_args()
    d = status(a.season)
    print(EXP_ID, d["status"], "bets", d.get("n_bets"), "frozen", (d.get("frozen_config_sha256") or "-")[:12])
