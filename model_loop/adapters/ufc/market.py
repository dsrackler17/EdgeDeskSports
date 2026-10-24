"""UFC market prices for the model loop: the historical pre-fight line the
backtest measures the Elo against, and the latest captured line for every
booked bout, which the disagreement guard (guard.py) reads.

  python3 -m model_loop.adapters.ufc.market archive   # network: fetch the public archive into .cache, report coverage

HISTORICAL (the backtest's reference). No licensed, timestamped UFC closing
archive exists in this repository. The best public substitute reachable from
GitHub is the Ultimate UFC Dataset's ufc-master.csv
(github.com/shortlikeafox/ultimate_ufc_dataset, the Kaggle "Ultimate UFC
Dataset"): one American moneyline per fighter per bout from 2010, a steady
3.7-4.5% margin from 2016 on (one book's pre-fight line, not a best-of-books
mix). It is UNTIMESTAMPED: the quote time is not stated, so it is called an
approximate close everywhere and it can never certify a model edge (guard.py:
an untimestamped reference can refuse certification, never grant it). Only
its two odds columns are read. Everything else in that file (fighter
statistics, ages, records) comes from UFCStats, which refuses automated
access, so none of it is read here. The file is fetched into .cache at run
time and its sha256 recorded; it is never committed.

A row is matched to one ESPN bout in model_loop/data/ufc/bouts.csv by date
(+-1 day: the archive dates by the local card date) and both fighters'
normalised names, then by surnames, then by a shared name token on each side;
a match that is ambiguous, or whose winner disagrees with ESPN's, is dropped.

LIVE (the guard's reference). research/clv/openers/ufc/<YYYY-MM>.jsonl:
DraftKings' pregame moneyline for every listed UFC bout as ESPN shows it,
stamped observed_at, captured hourly by research/clv/collect_openers.py
(the clv-openers workflow). The latest quote before the bout is read.

No-vig: multiplicative, p_i = q_i / (q_a + q_b) from the implied q = 1/decimal.
"""
import argparse
import csv
import glob
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request

import numpy as np
import pandas as pd

from . import ingest

ROOT = ingest.ROOT
CACHE = os.path.join(ROOT, ".cache", "model_loop", "ufc", "market")
ARCHIVE = {"name": "Ultimate UFC Dataset (ufc-master.csv)",
           "url": "https://raw.githubusercontent.com/shortlikeafox/ultimate_ufc_dataset/master/ufc-master.csv",
           "home": "https://github.com/shortlikeafox/ultimate_ufc_dataset",
           "timestamped": False,
           "kind": "approximate close: one pre-fight moneyline per side, quote time not stated"}
OPENERS = os.path.join(ROOT, "research", "clv", "openers", "ufc")
MAX_OVERROUND = 0.15          # a pair whose margin is above this, or below zero, is a data error


def american_to_prob(o):
    """implied probability of an American price (margin included); NaN when not a price"""
    o = np.asarray(o, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        q = np.where(o < 0, -o / (-o + 100.0), 100.0 / (o + 100.0))
    q[~np.isfinite(o) | (np.abs(o) < 100)] = np.nan
    return q


def novig(odds_a, odds_b):
    """(p_a without the margin, the overround) from two American prices"""
    qa, qb = american_to_prob(odds_a), american_to_prob(odds_b)
    return qa / (qa + qb), qa + qb - 1.0


def norm_name(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii)\b", " ", re.sub(r"[^a-z ]", " ", s))
    return " ".join(s.split())


# ----------------------------------------------------------------- archive
def fetch_archive(force=False):
    """the public archive into .cache (fetched once; force refetches); returns (path, sha256)"""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "ufc-master.csv")
    if force or not os.path.exists(path):
        with urllib.request.urlopen(urllib.request.Request(ARCHIVE["url"], headers={"Accept": "text/csv"}), timeout=120) as r:
            body = r.read()
        with open(path, "wb") as f:
            f.write(body)
    return path, hashlib.sha256(open(path, "rb").read()).hexdigest()


def load_archive(path):
    """date, both names and both moneylines; nothing else in the file is read"""
    head = pd.read_csv(path, nrows=0).columns
    cols = (["R_fighter", "B_fighter", "R_odds", "B_odds", "date", "Winner"] if "R_fighter" in head
            else ["RedFighter", "BlueFighter", "RedOdds", "BlueOdds", "Date", "Winner"])
    a = pd.read_csv(path, usecols=cols)
    a.columns = ["red", "blue", "red_odds", "blue_odds", "date", "winner"]
    a["date"] = pd.to_datetime(a.date, errors="coerce")
    a = a[a.date.notna() & a.red_odds.notna() & a.blue_odds.notna()].reset_index(drop=True)
    a["p_red"], a["overround"] = novig(a.red_odds.values, a.blue_odds.values)
    return a[(a.overround >= 0) & (a.overround <= MAX_OVERROUND) & np.isfinite(a.p_red)].reset_index(drop=True)


def match_archive(bouts, arch):
    """one row per matched bout: bout_id, p_a_close (fighter_a's no-vig chance), overround, matched_by"""
    fin = bouts[bouts.final].copy()
    fin["day"] = fin.ts.dt.tz_convert(None).dt.normalize()
    keys = {"full": {}, "surname": {}}
    toks = {}
    for r in fin.itertuples():
        na, nb = norm_name(r.fighter_a), norm_name(r.fighter_b)
        for dd in (r.day, r.day - pd.Timedelta(days=1), r.day + pd.Timedelta(days=1)):
            keys["full"].setdefault((dd, frozenset([na, nb])), set()).add(r.bout_id)
            keys["surname"].setdefault((dd, frozenset([na.split()[-1] if na else "", nb.split()[-1] if nb else ""])), set()).add(r.bout_id)
            toks.setdefault(dd, []).append((r.bout_id, set(na.split()), set(nb.split())))
    by = fin.set_index("bout_id")
    out, used = [], set()
    for r in arch.itertuples():
        nr, nbl = norm_name(r.red), norm_name(r.blue)
        hit, how = None, None
        k = keys["full"].get((r.date, frozenset([nr, nbl])))
        if k and len(k) == 1:
            hit, how = next(iter(k)), "full names"
        if hit is None and nr and nbl:
            k = keys["surname"].get((r.date, frozenset([nr.split()[-1], nbl.split()[-1]])))
            if k and len(k) == 1:
                hit, how = next(iter(k)), "surnames"
        if hit is None:
            tr, tb = {t for t in nr.split() if len(t) > 3}, {t for t in nbl.split() if len(t) > 3}
            c = {bid for bid, ta, tb2 in toks.get(r.date, []) if (tr & ta and tb & tb2) or (tr & tb2 and tb & ta)}
            if len(c) == 1:
                hit, how = next(iter(c)), "a shared name token"
        if hit is None or hit in used:
            continue
        g = by.loc[hit]
        ta, tbb = set(norm_name(g.fighter_a).split()), set(norm_name(g.fighter_b).split())
        red_score = len(ta & set(nr.split())) + len(tbb & set(nbl.split()))
        blue_score = len(ta & set(nbl.split())) + len(tbb & set(nr.split()))
        if red_score == blue_score:
            continue                                   # the sides cannot be told apart: no match
        a_is_red = red_score > blue_score
        p_a = r.p_red if a_is_red else 1.0 - r.p_red
        # the archive's winner must agree with ESPN's (a decided bout); otherwise the match is wrong
        if not np.isnan(g.y) and str(r.winner) in ("Red", "Blue"):
            a_won = (str(r.winner) == "Red") == a_is_red
            if a_won != (g.y == 1.0):
                continue
        used.add(hit)
        out.append({"bout_id": hit, "p_a_close": float(p_a), "overround": float(r.overround), "matched_by": how})
    return pd.DataFrame(out, columns=["bout_id", "p_a_close", "overround", "matched_by"])


def archive_for(bouts, fetch=True):
    """(per-bout close frame, provenance) for the backtest; an empty frame when the archive cannot be read"""
    try:
        path, sha = fetch_archive() if fetch else (os.path.join(CACHE, "ufc-master.csv"), None)
        if sha is None:
            sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
        arch = load_archive(path)
    except Exception as e:  # noqa: BLE001 - the backtest reports the reference as unavailable
        return pd.DataFrame(columns=["bout_id", "p_a_close", "overround", "matched_by"]), dict(ARCHIVE, available=False, error=str(e)[:200])
    m = match_archive(bouts, arch)
    span = [str(arch.date.min().date()), str(arch.date.max().date())]
    return m, dict(ARCHIVE, available=True, sha256=sha, rows_with_odds=int(len(arch)), matched=int(len(m)), span=span,
                   median_overround=round(float(arch[arch.date >= "2016-01-01"].overround.median()), 4))


# -------------------------------------------------------------------- live
def latest_quotes(paths=None, before=None):
    """bout id -> the latest DraftKings two-way quote in the openers ledger:
    {book, observed_at, ml_home, ml_away, home_id, away_id, p_home, overround}"""
    paths = paths if paths is not None else sorted(glob.glob(os.path.join(OPENERS, "20[0-9][0-9]-[0-9][0-9].jsonl")))
    events, quotes = {}, {}
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                x = json.loads(line)
                if x.get("kind") == "event":
                    events[x["cid"]] = x
                elif x.get("kind") == "quote" and isinstance(x.get("ml"), dict):
                    if before is not None and x["observed_at"] >= before:
                        continue
                    prev = quotes.get(x["cid"])
                    if prev is None or x["observed_at"] >= prev["observed_at"]:
                        quotes[x["cid"]] = x
    out = {}
    for cid, q in quotes.items():
        e = events.get(cid)
        if not e or not e.get("home") or not e.get("away"):
            continue
        ph, ov = novig(q["ml"].get("home"), q["ml"].get("away"))
        ph, ov = float(ph), float(ov)
        if not np.isfinite(ph) or not 0 <= ov <= MAX_OVERROUND:
            continue
        out[cid] = {"book": q.get("book"), "observed_at": q["observed_at"], "ml_home": q["ml"]["home"], "ml_away": q["ml"]["away"],
                    "home_id": str(e["home"]["id"]), "away_id": str(e["away"]["id"]), "p_home": ph, "overround": ov,
                    "source": "research/clv/openers/ufc (DraftKings via ESPN, captured by the clv-openers workflow)"}
    return out


def quote_for(q, fighter_a_id):
    """the quote read from fighter_a's side: (p_a no-vig, fighter_a's price, fighter_b's price), or None when the ids do not match"""
    if not q:
        return None
    if q["home_id"] == str(fighter_a_id):
        return q["p_home"], q["ml_home"], q["ml_away"]
    if q["away_id"] == str(fighter_a_id):
        return 1.0 - q["p_home"], q["ml_away"], q["ml_home"]
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["archive"])
    a = ap.parse_args(argv)
    if a.cmd == "archive":
        from . import model as U
        d = U.load(ingest.OUT)
        m, prov = archive_for(d)
        print(json.dumps(prov, indent=1))
        print(m.matched_by.value_counts().to_dict() if len(m) else {}, file=sys.stderr)


if __name__ == "__main__":
    main()
