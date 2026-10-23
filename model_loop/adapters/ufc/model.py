"""A walk-forward Elo for UFC bouts: the published baseline for MMA, run
point in time, with a calibration fitted only on earlier seasons.

Every bout is priced from the ratings as they stood before it, then absorbed
if it has a result. Nothing about a fighter's later career reaches an earlier
bout: ESPN's `records` field (the record as of the request) is never read.

Parameters
  k                 the update step
  k_new_mult        a larger step for a fighter's first `new_bouts` bouts in
                    the data (a debutant's rating moves faster)
  layoff_days       a fighter returning after this long ...
  layoff_regress    ... has this share of their distance from 1500 removed
  champ_bonus       Elo points added to the defending champion's rating in an
                    undisputed title fight, for the bout's expectation and so
                    for its update too (as a home advantage is): the champion
                    going in is read from model_loop/data/ufc/title_bouts.csv
                    (Wikipedia's title history matched to the bouts, and booked
                    defences from ufc.com's current champions), which is known
                    when the bout is booked. 0 = no term (every version before
                    the term existed prices exactly as it did). Symmetric: it
                    follows the champion, whichever side the feed lists first
  calibration       "none" or "slope": p' = sigmoid(b * logit(p)), b fitted on
                    every earlier season's out-of-sample bouts. Slope only, no
                    intercept, so a bout is priced the same whichever fighter the
                    feed lists first: in the 2024 data the first-listed fighter
                    wins 44.8%, most likely the corner, but the feed has not been
                    shown to keep its order from before the result, so the order
                    is not used (the pregame ledger records it, to test that)
"""
import math
import os

import numpy as np
import pandas as pd

from ...core import metrics as M

DEFAULTS = {"k": 32.0, "k_new_mult": 1.0, "new_bouts": 3, "layoff_days": 365, "layoff_regress": 0.0,
            "scale": 400.0, "calibration": "none", "champ_bonus": 0.0}
FINAL = "STATUS_FINAL"


def title_champions(path):
    """bout id -> the champion going in, from title_bouts.csv beside the bouts (empty when the file is absent)"""
    f = os.path.join(os.path.dirname(path), "title_bouts.csv")
    if not os.path.exists(f):
        return {}
    t = pd.read_csv(f, dtype={"bout_id": str, "champion_id": str})
    return dict(zip(t.bout_id, t.champion_id))


def load(path):
    d = pd.read_csv(path, dtype={"bout_id": str, "event_id": str, "fighter_a_id": str, "fighter_b_id": str})
    d["ts"] = pd.to_datetime(d.start_time, utc=True, errors="coerce")
    d = d[d.ts.notna()].sort_values(["ts", "bout_id"]).reset_index(drop=True)
    aw = d.a_winner.astype(str).str.lower() == "true"
    bw = d.b_winner.astype(str).str.lower() == "true"
    d["final"] = d.status == FINAL
    d["y"] = np.where(d.final & aw & ~bw, 1.0, np.where(d.final & bw & ~aw, 0.0, np.nan))
    d["draw"] = d.final & ~aw & ~bw
    d["season"] = d.ts.dt.year
    champs = title_champions(path)
    d["champ"] = d.bout_id.map(champs).fillna("")
    return d


def walk(d, params):
    """One causal pass: p_raw for every bout from the ratings before it."""
    P = dict(DEFAULTS, **(params or {}))
    R, N, last = {}, {}, {}
    out = np.full(len(d), np.nan)
    na = np.zeros(len(d), dtype=int)
    nb = np.zeros(len(d), dtype=int)

    def rating(f, t):
        r = R.get(f, 1500.0)
        lt = last.get(f)
        if lt is not None and P["layoff_regress"] and (t - lt).days >= P["layoff_days"]:
            r = 1500.0 + (r - 1500.0) * (1.0 - P["layoff_regress"])
            R[f] = r
        return r

    cb = float(P.get("champ_bonus") or 0.0)
    has_champ = "champ" in d.columns
    for i, row in enumerate(d.itertuples()):
        a, b, t = row.fighter_a_id, row.fighter_b_id, row.ts
        ra, rb = rating(a, t), rating(b, t)
        adj = 0.0
        if cb and has_champ and row.champ:
            adj = cb if row.champ == a else (-cb if row.champ == b else 0.0)
        e = 1.0 / (1.0 + 10 ** (-(ra - rb + adj) / P["scale"]))
        out[i] = e
        na[i], nb[i] = N.get(a, 0), N.get(b, 0)
        if row.final and (not math.isnan(row.y) or row.draw):
            s = 0.5 if row.draw else row.y
            ka = P["k"] * (P["k_new_mult"] if N.get(a, 0) < P["new_bouts"] else 1.0)
            kb = P["k"] * (P["k_new_mult"] if N.get(b, 0) < P["new_bouts"] else 1.0)
            R[a] = ra + ka * (s - e)
            R[b] = rb - kb * (s - e)
            N[a] = N.get(a, 0) + 1
            N[b] = N.get(b, 0) + 1
            last[a] = last[b] = t
    r = d[["bout_id", "event_id", "event_name", "ts", "season", "fighter_a", "fighter_b", "fighter_a_id", "fighter_b_id",
           "weight_class", "status", "final", "y", "draw"]].copy()
    r["p_raw"] = out
    r["a_bouts"], r["b_bouts"] = na, nb
    return r, {"ratings": R, "bouts": N, "last": last}


def _logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def fit_slope(p, y, iters=50):
    """Maximum-likelihood b in sigmoid(b * logit(p)), by Newton; symmetric in a/b."""
    z, yy, b = _logit(p), np.asarray(y, dtype=float), 1.0
    for _ in range(iters):
        q = 1 / (1 + np.exp(-b * z))
        g = np.sum((yy - q) * z)
        h = np.sum(q * (1 - q) * z * z) + 1e-9
        step = g / h
        b += step
        if abs(step) < 1e-10:
            break
    return float(b)


def calibrate(rows, params, first_season):
    """p for every row: raw, or with the slope fitted on all earlier seasons' scored rows."""
    P = dict(DEFAULTS, **(params or {}))
    rows = rows.copy()
    rows["p"] = rows.p_raw
    if P["calibration"] != "slope":
        return rows, {}
    fits = {}
    scored = rows.y.notna()
    for s in sorted(rows.season.unique()):
        prior = rows[scored & (rows.season < s)]
        if len(prior) < 300:
            continue
        b = fit_slope(prior.p_raw.values, prior.y.values)
        rows.loc[rows.season == s, "p"] = 1 / (1 + np.exp(-b * _logit(rows.loc[rows.season == s, "p_raw"].values)))
        fits[int(s)] = round(b, 4)
    return rows, fits


def score(rows, mask=None):
    """Log loss, Brier and calibration of p on the decided bouts in mask, with the
    coin flip as the baseline and the paired difference."""
    s = rows[rows.y.notna() & (True if mask is None else mask)]
    if not len(s):
        return {"n": 0}
    p, y = s.p.values, s.y.values
    cmp = M.paired_logloss_test(p, np.full(len(p), 0.5), y)
    return {"n": int(len(s)), "logloss": round(M.logloss(pd.Series(p), pd.Series(y)), 5), "brier": round(float(np.mean((p - y) ** 2)), 5),
            "coin_flip_logloss": round(math.log(2), 5), "vs_coin_flip": cmp,
            "accuracy": round(float(np.mean((p > 0.5) == (y > 0.5))), 4),
            "calibration": M.calibration_table(pd.Series(p), pd.Series(y), bins=5)}
