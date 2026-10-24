"""A walk-forward Elo for UFC bouts: the published baseline for MMA, run
point in time, with a calibration fitted only on earlier seasons.

Every bout is priced from the ratings as they stood before it, then absorbed
if it has a result. Nothing about a fighter's later career reaches an earlier
bout: ESPN's `records` field (the record as of the request) is never read as
the record at an earlier bout (factors.py backs every later result out of it).

Parameters (1.0.0 and 1.1.0 use only the first block; every later parameter is
off at its default, and with all of them off the walk prices exactly as it did)
  k                 the update step
  k_new_mult        a larger step for a fighter's first `new_bouts` bouts in
                    the data (a debutant's rating moves faster)
  layoff_days       a fighter returning after this long ...
  layoff_regress    ... has this share of their distance from 1500 removed
                    ("step": stored when priced, as 1.0/1.1 always did)
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

  The 2026-10 study (docs/model-loop/ufc/study/, study.py) added these, each
  tested one at a time; which ones a version uses is in its config:
  THE PRIOR (a fighter's starting rating, and what shrinkage and decay pull toward)
  debut_offset      Elo points added to 1500 for every fighter's starting rating
  prior_rec         Elo points per unit of the pre-data record's win-rate logit,
                    logit((w + 2) / (w + l + 4)), centred on a 10-2 record
  prior_exp         Elo points per unit of log(1 + w + l), centred on 12 bouts
                    (the record before the fighter's first bout in the data:
                    factors.py; no record on file = the centre)
  SHORT SAMPLE
  shrink_bouts      the price uses prior + (R - prior) * n / (n + shrink_bouts),
                    n the fighter's absorbed bouts (the stored rating is not shrunk)
  LAYOFF
  layoff_mode       "step" (1.0/1.1) or "smooth": the share removed grows linearly
                    from 0 at layoff_days to layoff_regress at layoff_days +
                    layoff_span, toward the prior, applied to the rating the bout
                    is priced and updated from (not stored by an unplayed bout)
  layoff_k_mult     the step multiplier for the first bout back after layoff_days
  RECENCY
  half_life_days    a rating's distance from the prior halves every this many
                    days since the fighter's last bout (0 = never)
  AGE (price only, Elo points; age from factors.py)
  age_slope, age_knee     per year above age_knee
  age_slope2, age_knee2   more per year above age_knee2
  young_slope, young_knee per year below young_knee
  DIVISION CHANGE (first bout at a new standard weight; factors.py div_step)
  div_regress       share of the distance from the prior removed (stored)
  div_up, div_down  Elo points per division moved up / down (price only)
  HEAD TO HEAD
  h2h               Elo points per unit of fighter_a's earlier residuals (s - e)
                    against this opponent, the latest meeting weighted 1 and each
                    earlier one h2h_decay times the next (price only)
"""
import math
import os

import numpy as np
import pandas as pd

from ...core import metrics as M

DEFAULTS = {"k": 32.0, "k_new_mult": 1.0, "new_bouts": 3, "layoff_days": 365, "layoff_regress": 0.0,
            "scale": 400.0, "calibration": "none", "champ_bonus": 0.0,
            "debut_offset": 0.0, "prior_rec": 0.0, "prior_exp": 0.0, "shrink_bouts": 0.0,
            "layoff_mode": "step", "layoff_span": 365, "layoff_k_mult": 1.0, "half_life_days": 0.0,
            "age_slope": 0.0, "age_knee": 33.0, "age_slope2": 0.0, "age_knee2": 36.0, "young_slope": 0.0, "young_knee": 26.0,
            "div_regress": 0.0, "div_up": 0.0, "div_down": 0.0, "h2h": 0.0, "h2h_decay": 0.5}
FINAL = "STATUS_FINAL"
REC_CENTRE = math.log(12.0 / 4.0)       # logit((10 + 2) / (12 + 4)): a 10-2 record
EXP_CENTRE = math.log(13.0)             # log(1 + 12)
# the parameters that need factors.py's columns, and the ones that change the walk at all
NEEDS_FACTORS = ("prior_rec", "prior_exp", "age_slope", "age_slope2", "young_slope", "div_regress", "div_up", "div_down")
EXTENSIONS = ("debut_offset", "prior_rec", "prior_exp", "shrink_bouts", "half_life_days", "age_slope", "age_slope2",
              "young_slope", "div_regress", "div_up", "div_down", "h2h")


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


def extended(P):
    """True when the configuration uses any parameter added after 1.1.0's"""
    return any(float(P.get(k) or 0.0) != 0.0 for k in EXTENSIONS) or P.get("layoff_mode", "step") != "step" \
        or float(P.get("layoff_k_mult", 1.0)) != 1.0


def prior_of(P, w, l):
    """a fighter's starting rating from the record before the data (None: no record on file)"""
    mu = 1500.0 + float(P.get("debut_offset") or 0.0)
    if w is not None and not (isinstance(w, float) and math.isnan(w)):
        z = math.log((w + 2.0) / (l + 2.0))
        mu += float(P.get("prior_rec") or 0.0) * (z - REC_CENTRE) + float(P.get("prior_exp") or 0.0) * (math.log1p(w + l) - EXP_CENTRE)
    return mu


def age_points(P, age):
    if age is None or (isinstance(age, float) and math.isnan(age)):
        return 0.0
    return (float(P["age_slope"]) * max(0.0, age - float(P["age_knee"])) + float(P["age_slope2"]) * max(0.0, age - float(P["age_knee2"]))
            + float(P["young_slope"]) * max(0.0, float(P["young_knee"]) - age))


def walk(d, params, fx=None):
    """One causal pass: p_raw for every bout from the ratings before it."""
    P = dict(DEFAULTS, **(params or {}))
    if extended(P):
        return _walk_extended(d, P, fx)
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
    return _rows(d, out, na, nb), {"ratings": R, "bouts": N, "last": last}


def _rows(d, out, na, nb):
    r = d[["bout_id", "event_id", "event_name", "ts", "season", "fighter_a", "fighter_b", "fighter_a_id", "fighter_b_id",
           "weight_class", "status", "final", "y", "draw"]].copy()
    r["p_raw"] = out
    r["a_bouts"], r["b_bouts"] = na, nb
    return r


def _walk_extended(d, P, fx=None):
    """The walk with the 2026-10 parameters. Per fighter: the stored rating R, the prior mu (fixed at the first
    appearance), absorbed bouts N and the last absorbed bout's time. At a bout, the rating it is priced and updated
    from is the stored one moved toward the prior by time (layoff, recency) and by a division change; the price adds
    the price-only terms (short-sample shrinkage, age, the division step, head to head, the champion)."""
    if fx is None and any(float(P.get(k) or 0.0) != 0.0 for k in NEEDS_FACTORS):
        from . import factors
        fx = factors.compute(d)
    R, N, last, MU, PAIR = {}, {}, {}, {}, {}
    out = np.full(len(d), np.nan)
    na = np.zeros(len(d), dtype=int)
    nb = np.zeros(len(d), dtype=int)
    k, scale, step = float(P["k"]), float(P["scale"]), P.get("layoff_mode", "step") == "step"
    lr, ld, ls, lk = float(P["layoff_regress"]), float(P["layoff_days"]), float(P["layoff_span"]), float(P["layoff_k_mult"])
    hl, sb, dvr = float(P["half_life_days"]), float(P["shrink_bouts"]), float(P["div_regress"])
    dup, ddn, h2h, h2d, cb = float(P["div_up"]), float(P["div_down"]), float(P["h2h"]), float(P["h2h_decay"]), float(P["champ_bonus"] or 0.0)
    use_age = any(float(P[x]) != 0.0 for x in ("age_slope", "age_slope2", "young_slope"))
    cols = {} if fx is None else {c: fx[c].values for c in fx.columns}
    has_champ = "champ" in d.columns

    def col(name, i):
        v = cols.get(name)
        return None if v is None or np.isnan(v[i]) else float(v[i])

    def state(f, t, s, i):
        """(the rating to price and update from, the prior, absorbed bouts, a long layoff)"""
        if f not in MU:
            w = col("pre_w_" + s, i)
            MU[f] = prior_of(P, w, col("pre_l_" + s, i) if w is not None else None)
            R[f] = MU[f]
        mu, r, n, lt = MU[f], R[f], N.get(f, 0), last.get(f)
        long_off = False
        if lt is not None:
            days = (t - lt).days
            long_off = days >= ld
            if step:
                if lr and long_off:                    # 1.0/1.1: toward 1500, stored when priced
                    r = 1500.0 + (r - 1500.0) * (1.0 - lr)
                    R[f] = r
                if hl:
                    r = mu + (r - mu) * 0.5 ** (days / hl)
            else:
                dev = r - mu
                if lr and days > ld:
                    dev *= 1.0 - lr * min(1.0, (days - ld) / ls)
                if hl:
                    dev *= 0.5 ** (days / hl)
                r = mu + dev
        ds = col("div_step_" + s, i)
        if dvr and ds:
            r = mu + (r - mu) * (1.0 - dvr)
        return r, mu, n, long_off

    for i, row in enumerate(d.itertuples()):
        a, b, t = row.fighter_a_id, row.fighter_b_id, row.ts
        ra, mua, nA, offa = state(a, t, "a", i)
        rb, mub, nB, offb = state(b, t, "b", i)
        pa = mua + (ra - mua) * nA / (nA + sb) if sb else ra
        pb = mub + (rb - mub) * nB / (nB + sb) if sb else rb
        adj = 0.0
        if use_age:
            adj += age_points(P, col("age_a", i)) - age_points(P, col("age_b", i))
        if dup or ddn:
            for sgn, s in ((1.0, "a"), (-1.0, "b")):
                ds = col("div_step_" + s, i)
                if ds:
                    adj += sgn * (dup * ds if ds > 0 else ddn * -ds)
        key = (a, b) if a < b else (b, a)
        if h2h and key in PAIR:
            res, wgt = 0.0, 1.0
            for x in reversed(PAIR[key]):                # fighter key[0]'s residuals, latest first
                res += wgt * x
                wgt *= h2d
            adj += h2h * (res if a == key[0] else -res)
        if cb and has_champ and row.champ:
            adj += cb if row.champ == a else (-cb if row.champ == b else 0.0)
        e = 1.0 / (1.0 + 10 ** (-(pa - pb + adj) / scale))
        out[i] = e
        na[i], nb[i] = nA, nB
        if row.final and (not math.isnan(row.y) or row.draw):
            s = 0.5 if row.draw else row.y
            ka = k * (P["k_new_mult"] if nA < P["new_bouts"] else 1.0) * (lk if offa else 1.0)
            kb = k * (P["k_new_mult"] if nB < P["new_bouts"] else 1.0) * (lk if offb else 1.0)
            R[a] = ra + ka * (s - e)
            R[b] = rb - kb * (s - e)
            N[a], N[b] = nA + 1, nB + 1
            last[a] = last[b] = t
            PAIR.setdefault(key, []).append((s - e) if a == key[0] else -(s - e))
    return _rows(d, out, na, nb), {"ratings": R, "bouts": N, "last": last, "priors": MU}


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
