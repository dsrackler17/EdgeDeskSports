"""The 2026-10 UFC study: why the served Elo (1.1.0) disagreed with liquid
markets by 14-17 points on UFC 333, what fixes it, and what the disagreement
guard may claim. EXPERIMENTAL throughout.

  python3 -m model_loop.adapters.ufc.study protocol          # write and hash the protocol (before selection)
  python3 -m model_loop.adapters.ufc.study diagnose [--version 1.1.0]
  python3 -m model_loop.adapters.ufc.study select            # one feature at a time, kept only out of sample
  python3 -m model_loop.adapters.ufc.study compare           # the selected model v 1.1.0 v the close, the test window read once
  python3 -m model_loop.adapters.ufc.study report            # docs/model-loop/ufc/study/README.md from the files above
  python3 -m model_loop.adapters.ufc.study version           # the selected model into versions.json: served only if compare promoted it
  python3 -m model_loop.adapters.ufc.study age               # the age curve, division by division, and for elite records (age_protocol.json)
  python3 -m model_loop.adapters.ufc.study all               # the four in order; then the report

Everything lands in docs/model-loop/ufc/study/ (protocol.json, diagnosis_<v>.json,
selection.json, comparison.json, README.md).

THE PROTOCOL (protocol.json, hashed; select refuses to run if the code's
protocol differs from the file's):
  windows   ratings walk from 2014; FIT 2016-2020 (each step's parameters are
            the grid point with the lowest log loss over its decided bouts);
            SELECT 2021-2023 (keep or drop the step); TEST 2024 to date (read
            once, by compare, for the promotion decision); the diagnosis reads
            every decided bout since 2018
  steps     in this order, each on top of every step kept before it:
            0 step size (k, the newcomer step), 1 short-sample shrinkage and the
            debut prior, 2 the pre-UFC record as the prior, 3 layoff decay,
            4 age curve, 5 division change, 6 recency, 7 head to head
  keep      SELECT log loss at least 0.0005 below the model before the step, and
            FIT log loss no worse (the paired 95% interval, card-blocked, is
            reported, not required: one step is small)
  promote   on TEST, against 1.1.0 on the same bouts: log loss at least 0.0005
            lower with the card-blocked paired 95% interval below zero, and the
            Brier score no worse
  reference the closing line: the public archive's pre-fight moneyline without
            its margin (market.py), UNTIMESTAMPED. It grades; it never certifies
            (guard.py)
"""
import argparse
import copy
import itertools
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd

from ...core.versions import Versions
from ...core.walkforward import content_hash
from . import factors as FX
from . import guard as G
from . import ingest
from . import market as K
from . import model as U

ROOT = ingest.ROOT
DOCS = os.path.join(ROOT, "docs", "model-loop", "ufc")
OUT = os.path.join(DOCS, "study")
WINDOWS = {"walk_from": 2014, "fit": [2016, 2020], "select": [2021, 2023], "test": [2024, 2099], "diagnosis": [2018, 2099]}
MIN_GAIN_LL = 0.0005
BASE_VERSION = "1.1.0"
# each step: the parameters it sets and its grid (every other parameter as the model before the step)
STEPS = [
    {"id": "step_size", "label": "Step size: k and the newcomer step re-tuned (1.1.0 sat at the edge of its grid, k 64)",
     "grid": {"k": [48, 64, 80, 96, 128], "k_new_mult": [1.0, 1.25, 1.5, 2.0]}},
    {"id": "short_sample", "label": "Short-sample shrinkage and a debut prior: few UFC bouts are pulled toward the prior; a debutant need not start at 1500",
     "grid": {"shrink_bouts": [0, 0.5, 1, 2, 3, 5], "debut_offset": [-75, -50, -25, 0, 25], "k_new_mult": [1.0, 1.5, 2.0]}},
    {"id": "pre_ufc_record", "label": "The pre-UFC record as the prior: professional wins, losses and experience before the first bout in the data",
     "grid": {"prior_rec": [0, 25, 50, 75, 100, 150], "prior_exp": [-25, 0, 25, 50, 75], "debut_offset": ["-25", "+0", "+25"]}},
    {"id": "layoff", "label": "Layoff decay: a smooth pull toward the prior after long inactivity, and a faster step on return",
     "grid": {"layoff_mode": ["smooth"], "layoff_days": [180, 270, 365], "layoff_span": [180, 365, 730],
              "layoff_regress": [0.1, 0.25, 0.4, 0.6], "layoff_k_mult": [1.0, 1.5]}},
    {"id": "age", "label": "Age curve: points per year above a knee, more past 36, and for youth",
     "grid": {"age_knee": [32, 34], "age_slope": [0, -5, -10, -15, -20], "age_slope2": [0, -10, -20], "young_slope": [0, 5, 10]}},
    {"id": "division_change", "label": "Division change: the rating discounted toward the prior, and points per division moved",
     "grid": {"div_regress": [0, 0.1, 0.25, 0.5], "div_up": [-60, -40, -20, 0, 20], "div_down": [-40, -20, 0, 20, 40]}},
    {"id": "recency", "label": "Recency: a rating's distance from the prior halves every so many days, so old results fade",
     "grid": {"half_life_days": [0, 730, 1095, 1460, 2190, 2920], "k": ["+0", "*1.25"]}},
    {"id": "head_to_head", "label": "Head to head: earlier meetings of the same two fighters (rematches, trilogies)",
     "grid": {"h2h": [0, 25, 50, 100, 150, 200], "h2h_decay": [0.5, 1.0]}},
]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else str(o))


def _jload(path):
    with open(path) as f:
        return json.load(f)


def _in(rows, w):
    return (rows.season >= w[0]) & (rows.season <= w[1])


def ll_each(p, y):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, dtype=float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def block_ci(diff, blocks, n_boot=2000, seed=13):
    """card-blocked bootstrap 95% interval of a mean (bouts on one card share a night)"""
    diff, blocks = np.asarray(diff, dtype=float), np.asarray(blocks)
    if len(diff) < 3:
        return None
    ids, inv = np.unique(blocks, return_inverse=True)
    sums, counts = np.bincount(inv, weights=diff), np.bincount(inv)
    pick = np.random.default_rng(seed).integers(0, len(ids), size=(n_boot, len(ids)))
    means = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)
    return [round(float(np.percentile(means, 2.5)), 5), round(float(np.percentile(means, 97.5)), 5)]


# ------------------------------------------------------------------ inputs
class Data:
    """the bouts, the point-in-time facts and the archive close, read once"""
    def __init__(self, fetch=True):
        self.d = U.load(ingest.OUT)
        self.fx = FX.compute(self.d)
        self.close, self.close_prov = K.archive_for(self.d, fetch=fetch)
        self.facts_prov = facts_provenance()

    def run(self, cfg):
        rows, state = U.walk(self.d, cfg, fx=self.fx)
        rows, fits = U.calibrate(rows, cfg, WINDOWS["fit"][0])
        rows = rows.join(self.fx)
        return rows.merge(self.close, on="bout_id", how="left").set_index(rows.index), state


def facts_provenance():
    """which fighter facts a run read: the file's sha256 and where each pre-UFC record came from (factors.py)"""
    import hashlib
    if not os.path.exists(FX.FACTS):
        return {"file": None, "note": "no fighter_facts.csv: dates of birth from fighters.csv, pre-UFC records reconstructed"}
    f = pd.read_csv(FX.FACTS, dtype=str).fillna("")
    return {"file": os.path.relpath(FX.FACTS, ROOT), "sha256": hashlib.sha256(open(FX.FACTS, "rb").read()).hexdigest(),
            "fighters": int(len(f)), "with_date_of_birth": int((f.date_of_birth != "").sum()),
            "pre_record_source": {k or "none": int(v) for k, v in f.pre_source.value_counts().items()}}


def served_config(version=None):
    V = Versions(os.path.join(DOCS, "versions.json"))
    return copy.deepcopy((V.get(version) if version else V.current)["config"])


# ----------------------------------------------------------------- metrics
def metrics(p, y):
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    if not len(p):
        return {"n": 0}
    return {"n": int(len(p)), "log_loss": round(float(ll_each(p, y).mean()), 5), "brier": round(float(np.mean((p - y) ** 2)), 5),
            "accuracy": round(float(np.mean((p > 0.5) == (y > 0.5))), 4)}


def reliability(p, y, edges=(0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0)):
    """favourite-side calibration: bouts binned by the favourite's probability, the mean said and the share won"""
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    flip = p < 0.5
    pf, yf = np.where(flip, 1 - p, p), np.where(flip, 1 - y, y)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (pf >= lo) & ((pf < hi) if hi < 1.0 else (pf <= hi))
        if sel.sum():
            k = int(sel.sum())
            out.append({"bin": f"{int(lo * 100)}-{int(hi * 100)}%", "lo": lo, "hi": hi, "n": k, "said": round(float(pf[sel].mean()), 4),
                        "won": round(float(yf[sel].mean()), 4), "se": round(float(math.sqrt(max(yf[sel].mean() * (1 - yf[sel].mean()), 1e-9) / k)), 4)})
    return out


def gap_table(s, p_col="p"):
    """how gaps between the model and the close resolved, by gap size; a bout resolves in the model's favour when
    the result lands on the model's side of the close (equivalently, the model's log loss on it is the lower)"""
    c = s[s.p_a_close.notna() & s.y.notna()]
    gap = (c[p_col] - c.p_a_close).values
    side = np.sign(gap)
    model_side_won = (c.y.values - c.p_a_close.values) * side > 0
    lm, lc = ll_each(c[p_col], c.y), ll_each(c.p_a_close, c.y)
    # the chance the result lands on the model's side, as each number sees it
    p_side_close = np.where(side > 0, c.p_a_close.values, 1 - c.p_a_close.values)
    p_side_model = np.where(side > 0, c[p_col].values, 1 - c[p_col].values)
    rows = []
    for lo, hi in ((0, 4), (4, 8), (8, 10), (10, 15), (15, 20), (20, 100)):
        sel = (np.abs(gap) * 100 >= lo) & (np.abs(gap) * 100 < hi)
        k = int(sel.sum())
        if not k:
            continue
        rows.append({"gap_pp": f"{lo}-{hi}" if hi < 100 else f"{lo}+", "lo": lo, "hi": hi, "n": k,
                     "model_favour": int(model_side_won[sel].sum()), "market_favour": int(k - model_side_won[sel].sum()),
                     "model_side_rate": round(float(model_side_won[sel].mean()), 4),
                     "close_expected_rate": round(float(p_side_close[sel].mean()), 4), "model_expected_rate": round(float(p_side_model[sel].mean()), 4),
                     "model_log_loss": round(float(lm[sel].mean()), 5), "close_log_loss": round(float(lc[sel].mean()), 5),
                     "diff_ci95": block_ci((lm - lc)[sel], c.event_id.values[sel])})
    out = {"rows": rows}
    for th in (8, 10):
        sel = np.abs(gap) * 100 > th
        k = int(sel.sum())
        out[f"over_{th}"] = {"n": k, "model_favour": int(model_side_won[sel].sum()), "market_favour": int(k - model_side_won[sel].sum()),
                             "model_log_loss": round(float(lm[sel].mean()), 5) if k else None,
                             "close_log_loss": round(float(lc[sel].mean()), 5) if k else None,
                             "diff_ci95": block_ci((lm - lc)[sel], c.event_id.values[sel]) if k else None}
    return out


def _oriented(s, mask, flip, p_col):
    """bouts in mask read from the affected fighter's side (flip: the affected one is fighter_b)"""
    x = s[mask]
    f = flip[mask]
    pm = np.where(f, 1 - x[p_col].values, x[p_col].values)
    y = np.where(f, 1 - x.y.values, x.y.values)
    pc = np.where(f, 1 - x.p_a_close.values, x.p_a_close.values)
    has_c = np.isfinite(pc)
    out = {"n": int(len(x)), "model_log_loss": round(float(ll_each(x[p_col], x.y).mean()), 5) if len(x) else None,
           "model_said": round(float(pm.mean()), 4) if len(x) else None, "won": round(float(y.mean()), 4) if len(x) else None,
           "n_close": int(has_c.sum())}
    if has_c.sum():
        out.update(close_said=round(float(pc[has_c].mean()), 4), won_close_subset=round(float(y[has_c].mean()), 4),
                   model_said_close_subset=round(float(pm[has_c].mean()), 4),
                   model_log_loss_close_subset=round(float(ll_each(pm[has_c], y[has_c]).mean()), 5),
                   close_log_loss=round(float(ll_each(pc[has_c], y[has_c]).mean()), 5))
    return out


def breakdowns(s, p_col="p"):
    """errors by the factor, each bout read from the side of the fighter the factor is about"""
    s = s[s.y.notna()]
    na, nb = s.n_a.values, s.n_b.values
    out = {}
    # UFC sample: the fighter with fewer UFC bouts (ties are not oriented)
    less_b = nb < na
    nmin = np.minimum(na, nb)
    rows = []
    for lab, lo, hi in (("0 (debut)", 0, 0), ("1-2", 1, 2), ("3-5", 3, 5), ("6-10", 6, 10), ("11+", 11, 999)):
        m = (nmin >= lo) & (nmin <= hi) & (na != nb)
        rows.append(dict(_oriented(s, m, less_b, p_col), bucket=lab))
    out["ufc_sample"] = {"side": "the fighter with fewer UFC bouts in the data (bouts with equal counts left out)", "rows": rows}
    # layoff: the fighter longer out (both with an earlier bout)
    da, db = s.days_off_a.values, s.days_off_b.values
    both = np.isfinite(da) & np.isfinite(db)
    longer_b = db > da
    lmax = np.fmax(da, db)
    rows = []
    for lab, lo, hi in (("under 180 days", 0, 179), ("180-364", 180, 364), ("365-539", 365, 539), ("540+", 540, 99999)):
        m = both & (lmax >= lo) & (lmax <= hi) & (da != db)
        rows.append(dict(_oriented(s, m, longer_b, p_col), bucket=lab))
    out["layoff"] = {"side": "the fighter longer out since the last bout (both fighters with an earlier UFC bout)", "rows": rows}
    # age: the older fighter (both ages known)
    aa, ab = s.age_a.values, s.age_b.values
    known = np.isfinite(aa) & np.isfinite(ab)
    older_b = ab > aa
    amax = np.fmax(aa, ab)
    rows = []
    for lab, lo, hi in (("under 30", 0, 30), ("30-32", 30, 33), ("33-34", 33, 35), ("35-36", 35, 37), ("37+", 37, 99)):
        m = known & (amax >= lo) & (amax < hi)
        rows.append(dict(_oriented(s, m, older_b, p_col), bucket=lab))
    gap = np.abs(aa - ab)
    for lab, lo in (("older by 5+ years", 5), ("older by 8+ years", 8)):
        rows.append(dict(_oriented(s, known & (gap >= lo), older_b, p_col), bucket=lab))
    out["age"] = {"side": "the older fighter (both dates of birth on file)", "coverage": round(float(known.mean()), 4), "rows": rows}
    # division change: exactly one fighter at a new standard weight
    sa, sb_ = s.div_step_a.values, s.div_step_b.values
    mova = np.isfinite(sa) & (sa != 0)
    movb = np.isfinite(sb_) & (sb_ != 0)
    one = mova ^ movb
    step = np.where(movb, sb_, sa)
    rows = [dict(_oriented(s, one & (step > 0), movb, p_col), bucket="moved up"),
            dict(_oriented(s, one & (step < 0), movb, p_col), bucket="moved down"),
            dict(_oriented(s, ~mova & ~movb, np.zeros(len(s), bool), p_col), bucket="neither (read from fighter_a)")]
    out["division_change"] = {"side": "the fighter at a new weight (bouts where exactly one moved)", "rows": rows}
    # debutants
    deb_a, deb_b = na == 0, nb == 0
    rows = [dict(_oriented(s, deb_a ^ deb_b, deb_b, p_col), bucket="one debutant"),
            dict(_oriented(s, deb_a & deb_b, np.zeros(len(s), bool), p_col), bucket="both debut (read from fighter_a)"),
            dict(_oriented(s, ~deb_a & ~deb_b, np.zeros(len(s), bool), p_col), bucket="neither (read from fighter_a)")]
    out["debutants"] = {"side": "the debutant (bouts with exactly one)", "rows": rows}
    # rematches
    rows = [dict(_oriented(s, s.meet.values >= 1, s.meet_last.values == 0, p_col), bucket="rematch: read from the last meeting's winner")]
    out["rematches"] = {"side": "the winner of the fighters' latest meeting", "rows": rows}
    return out


def evaluate(D, rows, version_label, window):
    s = rows[_in(rows, window) & rows.y.notna()]
    c = s[s.p_a_close.notna()]
    return {"version": version_label, "window": window, "all": metrics(s.p, s.y),
            "close_subset": {"n": int(len(c)), "model": metrics(c.p, c.y), "close": metrics(c.p_a_close, c.y),
                             "model_minus_close_ci95": block_ci(ll_each(c.p, c.y) - ll_each(c.p_a_close, c.y), c.event_id.values)},
            "calibration": {"model": reliability(s.p, s.y), "model_close_subset": reliability(c.p, c.y), "close": reliability(c.p_a_close, c.y)},
            "gaps": gap_table(s), "by_season": {int(k): metrics(g.p, g.y) for k, g in s.groupby("season")}}


# ---------------------------------------------------------------- protocol
def protocol_doc():
    return {"schema": "edgedesk_model_loop_ufc_study_protocol_v1", "windows": WINDOWS, "min_gain_ll": MIN_GAIN_LL,
            "base_version": BASE_VERSION, "steps": STEPS,
            "keep_rule": f"SELECT log loss at least {MIN_GAIN_LL} below the model before the step, and FIT log loss no worse",
            "promote_rule": f"TEST log loss at least {MIN_GAIN_LL} below {BASE_VERSION}'s on the same bouts with the card-blocked "
                            "paired 95% interval below zero, and the Brier score no worse",
            "reference": "the public archive's pre-fight moneyline without its margin (untimestamped): it grades, never certifies",
            "disclosure": "Written 2026-10-24 after the diagnosis of 1.1.0 (which reads 2018 on, the test window included) and "
                          "before any step was fitted or selected. The diagnosis read the test window's errors for 1.1.0 only."}


def cmd_protocol():
    doc = protocol_doc()
    doc["sha256"] = content_hash({k: v for k, v in doc.items() if k != "sha256"})
    dump(os.path.join(OUT, "protocol.json"), doc)
    print(f"study protocol sha256 {doc['sha256']}", file=sys.stderr)
    return doc


def _check_protocol():
    p = os.path.join(OUT, "protocol.json")
    if not os.path.exists(p):
        raise SystemExit("write the protocol first (study protocol)")
    doc = _jload(p)
    body = {k: v for k, v in doc.items() if k != "sha256"}
    if content_hash(body) != doc["sha256"] or body != json.loads(json.dumps(protocol_doc())):
        raise SystemExit("protocol.json does not match the code's protocol: change neither after the fact")
    return doc["sha256"]


# ---------------------------------------------------------------- diagnose
def cmd_diagnose(version=BASE_VERSION, D=None):
    D = D or Data()
    cfg = served_config(version)
    rows, _ = D.run(cfg)
    s = rows[_in(rows, WINDOWS["diagnosis"]) & rows.y.notna()]
    out = {"schema": "edgedesk_model_loop_ufc_diagnosis_v1", "generated_at": now_iso(), "version": version, "config": cfg, "facts": D.facts_prov,
           "window": WINDOWS["diagnosis"], "reference": D.close_prov,
           "evaluation": evaluate(D, rows, version, WINDOWS["diagnosis"]), "breakdowns": breakdowns(s),
           "breakdowns_close_subset_only": breakdowns(s[s.p_a_close.notna()])}
    dump(os.path.join(OUT, f"diagnosis_{version}.json"), out)
    e = out["evaluation"]
    print(f"diagnose {version}: n {e['all']['n']} LL {e['all']['log_loss']}; close subset model {e['close_subset']['model']['log_loss']} "
          f"v close {e['close_subset']['close']['log_loss']}; gaps>10 {e['gaps']['over_10']}", file=sys.stderr)
    return out


# ------------------------------------------------------------------ select
def _grid_configs(base, grid):
    keys = list(grid)
    for vals in itertools.product(*(grid[k] for k in keys)):
        c = copy.deepcopy(base)
        for k, v in zip(keys, vals):
            if isinstance(v, str) and v[:1] in "+-*":       # relative to the model before the step
                cur = float(c.get(k, U.DEFAULTS.get(k)))
                v = cur * float(v[1:]) if v[0] == "*" else cur + float(v)
            c[k] = v
        yield c


def _window_ll(rows, w):
    s = rows[_in(rows, w) & rows.y.notna()]
    return float(ll_each(s.p, s.y).mean()), s


def cmd_select(D=None):
    sha = _check_protocol()
    D = D or Data()
    base = dict(U.DEFAULTS, **served_config(BASE_VERSION))
    rows0, _ = D.run(base)
    fit0, _ = _window_ll(rows0, WINDOWS["fit"])
    sel0, s_sel0 = _window_ll(rows0, WINDOWS["select"])
    log = [{"step": "base", "version": BASE_VERSION, "fit_log_loss": round(fit0, 5), "select_log_loss": round(sel0, 5)}]
    cur, cur_fit, cur_sel, cur_rows = base, fit0, sel0, rows0
    for st in STEPS:
        t0 = time.time()
        if st["id"] == "age" and not FX.load_dob():
            log.append({"step": st["id"], "label": st["label"], "decision": "NOT TESTED",
                        "reason": "no dates of birth on file (model_loop/data/ufc/fighters.csv: ingest athletes)"})
            continue
        best = None
        tried = 0
        for c in _grid_configs(cur, st["grid"]):
            rows, _ = D.run(c)
            f, _ = _window_ll(rows, WINDOWS["fit"])
            tried += 1
            if best is None or f < best[0] - 1e-12:
                best = (f, c, rows)
        f, c, rows = best
        sel, s_sel = _window_ll(rows, WINDOWS["select"])
        prev = cur_rows.loc[s_sel.index]
        diff = ll_each(s_sel.p, s_sel.y) - ll_each(prev.p, prev.y)
        changed = {k: c[k] for k in c if c[k] != cur.get(k)}
        keep = bool(changed) and (sel - cur_sel) <= -MIN_GAIN_LL and f <= cur_fit + 1e-12
        reasons = []
        if not changed:
            reasons.append("the fit window chose the model before the step (no change)")
        else:
            if (sel - cur_sel) > -MIN_GAIN_LL:
                reasons.append(f"SELECT log loss change {sel - cur_sel:+.5f} does not clear -{MIN_GAIN_LL}")
            if f > cur_fit + 1e-12:
                reasons.append(f"FIT log loss worse ({f - cur_fit:+.5f})")
        log.append({"step": st["id"], "label": st["label"], "grid_points": tried, "chosen": changed,
                    "fit_log_loss": round(f, 5), "fit_delta": round(f - cur_fit, 5),
                    "select_log_loss": round(sel, 5), "select_delta": round(sel - cur_sel, 5),
                    "select_ci95": block_ci(diff, s_sel.event_id.values), "n_select": int(len(s_sel)),
                    "decision": "KEPT" if keep else "DROPPED", "reason": "; ".join(reasons) or "clears the keep rule",
                    "seconds": round(time.time() - t0, 1)})
        print(f"study step {st['id']}: {log[-1]['decision']} (fit {f - cur_fit:+.5f}, select {sel - cur_sel:+.5f}) {changed}", file=sys.stderr)
        if keep:
            cur, cur_fit, cur_sel, cur_rows = c, f, sel, rows
    final = {k: v for k, v in cur.items() if k in base and (v != U.DEFAULTS.get(k) or k in served_config(BASE_VERSION))}
    out = {"schema": "edgedesk_model_loop_ufc_selection_v1", "generated_at": now_iso(), "protocol_sha256": sha, "facts": D.facts_prov,
           "base_version": BASE_VERSION, "steps": log, "selected_config": final,
           "kept": [x["step"] for x in log if x.get("decision") == "KEPT"],
           "dropped": [x["step"] for x in log if x.get("decision") == "DROPPED"],
           "not_tested": [x["step"] for x in log if x.get("decision") == "NOT TESTED"],
           "fit_log_loss": round(cur_fit, 5), "select_log_loss": round(cur_sel, 5),
           "base": {"fit_log_loss": round(fit0, 5), "select_log_loss": round(sel0, 5)}}
    dump(os.path.join(OUT, "selection.json"), out)
    return out


# ----------------------------------------------------------------- compare
def lineage(version):
    """the versions after BASE_VERSION up to `version`, parent by parent: who promoted each, why, and whether that
    choice read the test window (the weekly rule reads every bout since 2016; the study's promotion read it once)"""
    V = Versions(os.path.join(DOCS, "versions.json"))
    out, v = [], V.get(version)
    while v and v["version"] != BASE_VERSION:
        by = v.get("promoted_by") or ""
        out.append({"version": v["version"], "promoted_by": by, "promoted_at": v.get("promoted_at"), "reason": v.get("reason", ""),
                    "choice_read_test": not by.startswith("study")})
        v = V.get(v["parent"]) if v.get("parent") else None
    return out[::-1]


def cmd_compare(D=None):
    """the served version (versions.json current) against 1.1.0 and the close: what Model Health shows. The study's
    own selection stays in selection.json and its promotion in versions.json (1.2.0)"""
    sha = _check_protocol()
    D = D or Data()
    sel = _jload(os.path.join(OUT, "selection.json"))
    V = Versions(os.path.join(DOCS, "versions.json"))
    new_version = V.current["version"]
    old_cfg, new_cfg = served_config(BASE_VERSION), served_config(new_version)
    old, _ = D.run(old_cfg)
    new, _ = D.run(new_cfg)
    test = _in(old, WINDOWS["test"]) & old.y.notna()
    so, sn = old[test], new.loc[old[test].index]
    lo, ln = ll_each(so.p, so.y), ll_each(sn.p, sn.y)
    d_ll, d_br = float((ln - lo).mean()), float(np.mean((sn.p - sn.y) ** 2) - np.mean((so.p - so.y) ** 2))
    ci = block_ci(ln - lo, so.event_id.values)
    reasons = []
    if d_ll > -MIN_GAIN_LL:
        reasons.append(f"TEST log loss change {d_ll:+.5f} does not clear -{MIN_GAIN_LL}")
    if not ci or ci[1] >= 0:
        reasons.append(f"card-blocked 95% interval {ci} is not below zero")
    if d_br > 0:
        reasons.append(f"Brier worse ({d_br:+.5f})")
    windows = {}
    for name, w in (("since_2018", WINDOWS["diagnosis"]), ("fit", WINDOWS["fit"]), ("select", WINDOWS["select"]), ("test", WINDOWS["test"]),
                    ("out_of_sample", [WINDOWS["select"][0], WINDOWS["test"][1]])):
        windows[name] = {"old": evaluate(D, old, BASE_VERSION, w), "new": evaluate(D, new, "selected", w)}
    s18 = new[_in(new, WINDOWS["diagnosis"]) & new.y.notna()]
    hind = hindsight_check(D, old, new, new_cfg)
    lin = lineage(new_version)
    out = {"schema": "edgedesk_model_loop_ufc_comparison_v1", "generated_at": now_iso(), "protocol_sha256": sha, "facts": D.facts_prov,
           "base_version": BASE_VERSION, "base_config": old_cfg, "selected_config": sel["selected_config"],
           "new_version": new_version, "new_config": new_cfg, "lineage": lin,
           "test_untouched": not any(x["choice_read_test"] for x in lin), "reference": D.close_prov,
           "test": {"window": WINDOWS["test"], "n": int(len(so)), "old_log_loss": round(float(lo.mean()), 5), "new_log_loss": round(float(ln.mean()), 5),
                    "delta_log_loss": round(d_ll, 5), "ci95": ci, "delta_brier": round(d_br, 5)},
           "promote": not reasons, "reasons": reasons or ["clears the promotion rule"],
           "windows": windows, "breakdowns_new": breakdowns(s18), "dob_coverage": round(float(np.isfinite(s18.age_a).mean()), 4),
           "hindsight_check": hind}
    dump(os.path.join(OUT, "comparison.json"), out)
    print(f"study compare: {new_version} v {BASE_VERSION}: test n {len(so)} LL {lo.mean():.5f} -> {ln.mean():.5f} ({d_ll:+.5f}, CI {ci}); promote={not reasons}", file=sys.stderr)
    return out


def hindsight_check(D, old, new, new_cfg):
    """The pre-UFC record is reconstructed from ESPN's record as of one recent time (factors.py): a fighter who fought
    outside the UFC after the first bout in the data carries those results back. If that hindsight drove the gain, the
    gain would be largest where it has had the longest to act (early seasons) and would shrink on fighters who stayed
    in the UFC. Measured with each kept step alone beside the selected model: by season, on fighters who stayed or
    left (both still fighting in the UFC in 2025 or later), and the cleanest read: the test window on bouts where both
    fighters are still in the UFC in 2026, where outside results have had almost no room to act."""
    d = D.d
    last = {}
    for r in d[d.final].itertuples():
        last[r.fighter_a_id] = last[r.fighter_b_id] = r.ts
    rec_only = {k: v for k, v in new_cfg.items() if not k.startswith("age_")}
    age_only = {k: v for k, v in new_cfg.items() if k not in ("prior_rec", "prior_exp", "debut_offset")}
    variants = [("selected", new), ("record_step_only", D.run(rec_only)[0]), ("age_step_only", D.run(age_only)[0])]
    epoch = pd.Timestamp(0, tz="UTC")

    def stayed(s, cut):
        return np.array([last.get(a, epoch) >= cut and last.get(b, epoch) >= cut for a, b in zip(s.fighter_a_id, s.fighter_b_id)])
    s = old[_in(old, WINDOWS["diagnosis"]) & old.y.notna()]
    st = stayed(s, pd.Timestamp("2025-01-01", tz="UTC"))
    t = old[_in(old, WINDOWS["test"]) & old.y.notna()]
    tt = t[stayed(t, pd.Timestamp("2026-01-01", tz="UTC"))]
    lo, lt = ll_each(s.p, s.y), ll_each(tt.p, tt.y)
    out = {"by_season": {}, "stayed": {}, "left": {}, "test_window_still_in_ufc_2026": {}}
    for name, rows in variants:
        ln = ll_each(rows.loc[s.index, "p"], s.y)
        out["by_season"][name] = {int(k): round(float((ln - lo)[s.season.values == k].mean()), 5) for k in sorted(s.season.unique())}
        out["stayed"][name] = {"n": int(st.sum()), "delta_log_loss": round(float((ln - lo)[st].mean()), 5)}
        out["left"][name] = {"n": int((~st).sum()), "delta_log_loss": round(float((ln - lo)[~st].mean()), 5)}
        dt = ll_each(rows.loc[tt.index, "p"], tt.y) - lt
        out["test_window_still_in_ufc_2026"][name] = {"n": int(len(tt)), "delta_log_loss": round(float(dt.mean()), 5), "ci95": block_ci(dt, tt.event_id.values)}
    out["reading"] = ("a hindsight-driven gain would sit with fighters who left the UFC and in early seasons; the cleanest read is the "
                      "test window on fighters still in the UFC in 2026 (their reconstructed records carry almost no later outside result)")
    return out


def _f(x, d=4):
    return "—" if x is None else (f"{x:+.{d}f}" if isinstance(x, float) and d < 0 else f"{x:.{abs(d)}f}")


def _age_report(ag, proto):
    C, ad = ag["candidates"], ag.get("adopted")
    md = ["", "## 5. The age curve by division\n",
          "Asked 2026-10-24: does age cost the same at every weight (heavyweights, perhaps the lighter divisions, aging later), "
          f"and the same for an elite UFC record? Protocol `age_protocol.json` (sha256 `{(proto or {}).get('sha256', '')[:16]}…`), "
          f"written before any candidate was fitted, on top of {ag['base_version']}. Each candidate was fitted on "
          f"{WINDOWS['fit'][0]}-{WINDOWS['fit'][1]} alone, so {WINDOWS['select'][0]} on is out of sample for every one of them.\n",
          "| Candidate | Δ fit LL | Δ 2021-2023 LL | Study decision | Δ 2021 on LL (95% interval) | Δ by season, 2021 on |\n|---|---|---|---|---|---|"]
    for k, r in C.items():
        o = r.get("out_of_sample") or {}
        md.append(f"| {k.replace('_', ' ')} | {r['fit_delta']:+.5f} | {r['select_delta']:+.5f} | {r['decision']} | "
                  f"{o.get('delta_log_loss', 0):+.5f} ({o.get('ci95')}) | " + ", ".join(f"{y} {v:+.4f}" for y, v in (o.get("by_season") or {}).items()) + " |")
    md.append(f"\nStudy rule (2021-2023 alone): kept {ag.get('kept') or 'none'}; " + "; ".join(ag.get("reasons", [])) + ".\n")
    if ad:
        r = C[ad["candidate"]]
        o = r["out_of_sample"]
        md.append(f"**Adopted: {ad['candidate'].replace('_', ' ')}, as {ad['version']}** ({ad['promoted_by']}, {str(ad['promoted_at'])[:10]}: "
                  f"{ad['reason']}). The study's own rule dropped it on 2021-2023 alone; the weekly rule, which every UFC change has to clear "
                  f"(loop.py), reads every bout since 2016 and passed it. Out of sample it gains {-o['delta_log_loss']:.4f} over {o['n']} bouts "
                  f"(95% interval {o['ci95']}): better, not proven. The weekly loop retests it, and the reverse, every week.\n")
    fits = ag["fits"]["division_curves"]
    rows = (C.get(ad["candidate"]) if ad else C["division_curves"])["divisions"]
    md += ["Where the decline starts, by division (fitted on 2016-2020 bouts at that weight; the older fighter in bouts 3+ years apart, "
           "older one 33+, every bout since 2016):\n",
           f"| Division | Fit bouts | Decline from | Elo a year | Older fighter: {ag['base_version']} said | {ad['version'] if ad else 'by division'} said | won |\n|---|---|---|---|---|---|---|"]
    for div, f in fits.items():
        cur = f.get("curve")
        od = (rows.get(div) or {}).get("older_33_plus") or {}
        md.append(f"| {div} | {f['fit_bouts']} | {cur[0] if cur else 'shared (32)'} | {cur[1] if cur else 'shared (-15)'} | "
                  f"{od.get('base_said', 0):.3f} | {od.get('new_said', 0):.3f} | {od.get('won', 0):.3f} ({od.get('n', 0)}) |")
    knees = {d: f["curve"][0] for d, f in fits.items() if f.get("curve")}
    if knees:
        lo, hi = min(knees.values()), max(knees.values())
        md.append(f"\nEarliest decline: {', '.join(d for d, k in knees.items() if k == lo)} ({lo}); latest: "
                  f"{', '.join(d for d, k in knees.items() if k == hi)} ({hi}); the grid runs {AGE_GRID['knee'][0]}-{AGE_GRID['knee'][-1]}.")
    el = C.get("elite") or {}
    if el:
        bs = (el.get("out_of_sample") or {}).get("by_season") or {}
        md.append(f"The elite term ({json.dumps(el['config_change'])}): 2021 on {el['out_of_sample']['delta_log_loss']:+.5f}; better in "
                  f"{sum(v < 0 for v in bs.values())} of {len(bs)} seasons. Before the protocol, a heavyweight-only later knee was tried on "
                  "every window and made each worse (age_protocol.json disclosure).")
    return md


def cmd_report():
    """the study in words and tables, from its own files (nothing typed in)"""
    P = lambda n: _jload(os.path.join(OUT, n)) if os.path.exists(os.path.join(OUT, n)) else None
    dg, sel, cmp_ = P(f"diagnosis_{BASE_VERSION}.json"), P("selection.json"), P("comparison.json")
    proto = P("protocol.json")
    md = ["# UFC model study (2026-10)\n",
          "Why the served Elo disagreed with liquid markets by 14-17 points on UFC 333, what changed, and what the disagreement "
          "guard lets the product say. Generated by `python3 -m model_loop.adapters.ufc.study report` from the JSON beside this file; "
          "every number below is read from them.\n"]
    if proto:
        md.append(f"Protocol: `protocol.json` (sha256 `{proto['sha256'][:16]}…`): fit {WINDOWS['fit'][0]}-{WINDOWS['fit'][1]}, keep or drop on "
                  f"{WINDOWS['select'][0]}-{WINDOWS['select'][1]}, promote on {WINDOWS['test'][0]} to date (read once per data version). "
                  f"Keep rule: {proto['keep_rule']}. Promotion rule: {proto['promote_rule']}.\n")
    if dg:
        e, ref = dg["evaluation"], dg["reference"]
        cs = e["close_subset"]
        md += ["## 1. Diagnosis of 1.1.0 (every decided bout since 2018)\n",
               f"Closing line: {ref.get('name')} ({ref.get('kind')}), matched to {ref.get('matched')} bouts, {ref.get('span')}; "
               f"median margin {ref.get('median_overround')}. **Untimestamped**: it grades, it never certifies.\n",
               "| | Bouts | Log loss | Brier |\n|---|---|---|---|",
               f"| 1.1.0, every bout | {e['all']['n']} | {e['all']['log_loss']} | {e['all']['brier']} |",
               f"| 1.1.0, bouts with a close | {cs['n']} | {cs['model']['log_loss']} | {cs['model']['brier']} |",
               f"| closing line, same bouts | {cs['n']} | {cs['close']['log_loss']} | {cs['close']['brier']} |\n",
               "Calibration by the favourite's stated chance (said / won, bouts):\n",
               "| Favourite at | 1.1.0 (all bouts) | Closing line |\n|---|---|---|"]
        cl = {r["bin"]: r for r in e["calibration"]["close"]}
        for r in e["calibration"]["model"]:
            c = cl.get(r["bin"])
            md.append(f"| {r['bin']} | {r['said']:.3f} / {r['won']:.3f} ({r['n']}) | " + (f"{c['said']:.3f} / {c['won']:.3f} ({c['n']})" if c else "—") + " |")
        for b in e["calibration"]["close"]:
            if b["bin"] not in {r["bin"] for r in e["calibration"]["model"]}:
                md.append(f"| {b['bin']} | — | {b['said']:.3f} / {b['won']:.3f} ({b['n']}) |")
        g = e["gaps"]
        md += ["", "How gaps between 1.1.0 and the close resolved (the result landing on the model's side of the close = the model's favour):\n",
               "| Gap (points) | Bouts | Model's favour | Market's favour | Close expected for the model's side | Model log loss | Close log loss |\n|---|---|---|---|---|---|---|"]
        for r in g["rows"]:
            md.append(f"| {r['gap_pp']} | {r['n']} | {r['model_favour']} | {r['market_favour']} | {r['close_expected_rate']:.3f} | {r['model_log_loss']} | {r['close_log_loss']} |")
        o10 = g["over_10"]
        md.append(f"\n**Gaps over 10 points: {o10['n']} bouts, {o10['model_favour']} resolved in the model's favour, {o10['market_favour']} in the market's** "
                  f"(model log loss {o10['model_log_loss']} v the close's {o10['close_log_loss']}).\n")
        md += ["Errors by factor (each bout read from the side of the fighter the factor is about; the bouts with a close):\n",
               "| Factor | Bucket | Bouts | 1.1.0 said | Close said | Won | 1.1.0 log loss | Close log loss |\n|---|---|---|---|---|---|---|---|"]
        for k, v in dg["breakdowns"].items():
            for r in v["rows"]:
                if r.get("n_close"):
                    md.append(f"| {k.replace('_', ' ')} | {r['bucket']} | {r['n_close']} | {r.get('model_said_close_subset', 0):.3f} | {r.get('close_said', 0):.3f} | "
                              f"{r.get('won_close_subset', 0):.3f} | {r.get('model_log_loss_close_subset')} | {r.get('close_log_loss')} |")
    if sel:
        md += ["", "## 2. One change at a time\n", f"Fighter facts read: `{json.dumps(sel.get('facts', {}).get('pre_record_source'))}` pre-UFC record sources.\n",
               "| Step | Chosen on 2016-2020 | Δ fit log loss | Δ 2021-2023 log loss (95% interval) | Decision |\n|---|---|---|---|---|"]
        for x in sel["steps"]:
            if x["step"] == "base":
                continue
            md.append(f"| {x['label']} | `{json.dumps(x.get('chosen'))}` | {x.get('fit_delta', '—')} | {x.get('select_delta', '—')} ({x.get('select_ci95')}) | "
                      f"**{x['decision']}**{': ' + x['reason'] if x.get('decision') != 'KEPT' else ''} |")
        md.append(f"\nSelected configuration: `{json.dumps(sel['selected_config'], sort_keys=True)}`.\n")
    if cmp_:
        t, nv = cmp_["test"], cmp_.get("new_version", "selected")
        md += [f"## 3. The served model ({nv}) against 1.1.0 and the close\n",
               "Versions since 1.1.0: " + "; ".join(f"**{x['version']}** ({x['promoted_by']}, {str(x['promoted_at'])[:10]}): {x['reason']}"
                                                     for x in cmp_.get("lineage", [])) + "\n",
               f"Test window {t['window'][0]} on: {t['n']} bouts, log loss {t['old_log_loss']} → {t['new_log_loss']} "
               f"({t['delta_log_loss']:+.5f}, card-blocked 95% interval {t['ci95']}), Brier {t['delta_brier']:+.5f}. "
               + ("No choice behind it read this window except the promotion itself. " if cmp_.get("test_untouched", True) else
                  "**This window is no longer untouched**: a later change was adopted by the weekly rule, which reads every bout "
                  "since 2016 (its own out-of-sample record is in section 5). ")
               + (f"Against 1.1.0: **clears** the promotion rule.\n" if cmp_["promote"] else
                  f"Against 1.1.0: **does not clear** the promotion rule ({'; '.join(cmp_['reasons'])}).\n"),
               f"| Window | Bouts | 1.1.0 LL | {nv} LL | 1.1.0 Brier | {nv} Brier | With a close | 1.1.0 LL | {nv} LL | Close LL | Close Brier |\n|---|---|---|---|---|---|---|---|---|---|---|"]
        for k, w in cmp_["windows"].items():
            o, n = w["old"], w["new"]
            md.append(f"| {k} | {o['all']['n']} | {o['all']['log_loss']} | {n['all']['log_loss']} | {o['all']['brier']} | {n['all']['brier']} | "
                      f"{o['close_subset']['n']} | {o['close_subset']['model']['log_loss']} | {n['close_subset']['model']['log_loss']} | "
                      f"{o['close_subset']['close']['log_loss']} | {o['close_subset']['close']['brier']} |")
        for side, lab in (("old", "1.1.0"), ("new", nv)):
            ov = cmp_["windows"]["out_of_sample"][side]["gaps"]
            md.append(f"\n{lab}, out of sample (2021 on): gaps over 8 points {ov['over_8']['n']} bouts, {ov['over_8']['model_favour']} in the model's favour, "
                      f"{ov['over_8']['market_favour']} in the market's; over 10 points {ov['over_10']['n']}, {ov['over_10']['model_favour']} v {ov['over_10']['market_favour']}.")
        h = cmp_.get("hindsight_check")
        if h:
            md += ["", f"Hindsight check on the pre-UFC record (gain v 1.1.0, log loss; 'selected' is {nv}):\n",
                   f"- fighters who stayed in the UFC (both fought there in 2025 or later): selected {h['stayed']['selected']['delta_log_loss']}, "
                   f"record step alone {h['stayed']['record_step_only']['delta_log_loss']} ({h['stayed']['selected']['n']} bouts)",
                   f"- the others: selected {h['left']['selected']['delta_log_loss']}, record step alone {h['left']['record_step_only']['delta_log_loss']} ({h['left']['selected']['n']} bouts)",
                   f"- by season, selected: {h['by_season']['selected']}", f"- by season, record step alone: {h['by_season']['record_step_only']}"]
            c = h.get("test_window_still_in_ufc_2026") or {}
            if c:
                md.append(f"- **the cleanest read**, test window, both fighters still in the UFC in 2026 ({c['selected']['n']} bouts): selected "
                          f"{c['selected']['delta_log_loss']} {c['selected']['ci95']}, record step alone {c['record_step_only']['delta_log_loss']} "
                          f"{c['record_step_only']['ci95']}, age step alone {c['age_step_only']['delta_log_loss']} {c['age_step_only']['ci95']}")
        vs = Versions(os.path.join(DOCS, "versions.json")).doc["versions"]
        sv = next((v for v in vs if v["config_sha256"] == content_hash(cmp_.get("new_config") or cmp_["selected_config"])), None)
        dn = P(f"diagnosis_{sv['version']}.json") if sv else None
        if dn:
            md += ["", f"What {sv['version']} still misreads (the same breakdown, since 2018, bouts with a close):\n",
                   f"| Factor | Bucket | Bouts | {sv['version']} said | Close said | Won |\n|---|---|---|---|---|---|"]
            for k, v in dn["breakdowns"].items():
                for r in v["rows"]:
                    if r.get("n_close") and not r["bucket"].startswith("neither") and not r["bucket"].startswith("both"):
                        md.append(f"| {k.replace('_', ' ')} | {r['bucket']} | {r['n_close']} | {r.get('model_said_close_subset', 0):.3f} | "
                                  f"{r.get('close_said', 0):.3f} | {r.get('won_close_subset', 0):.3f} |")
        cert = G.certification(cmp_["windows"]["out_of_sample"]["new"]["gaps"], cmp_.get("reference"))
        md += ["", "## 4. The guard\n", f"Threshold {G.config()["threshold_pp"]} points (`docs/model-loop/ufc/guard.json`). "
               f"Certification of {nv}'s large gaps: **{'certified' if cert['certified'] else 'not certified'}**: {'; '.join(cert['reasons'])}."]
    ag = P("age_by_division.json")
    if ag:
        md += _age_report(ag, P("age_protocol.json"))
    text = "\n".join(md) + "\n"
    with open(os.path.join(OUT, "README.md"), "w") as f:
        f.write(text)
    print(os.path.join(OUT, "README.md"))
    return text


def cmd_version():
    """The selected configuration becomes a version (docs/model-loop/ufc/versions.json), with its config sha256 and the
    study's evidence. SERVED only when compare promoted it; then every earlier version is a rollback target and 1.1.0
    stays runnable (loop.py price --version 1.1.0; every published bout carries its price). Otherwise it is recorded as
    NOT SERVED and the current version is unchanged. A configuration already on file is not added twice."""
    sha = _check_protocol()
    cmp_ = _jload(os.path.join(OUT, "comparison.json"))
    sel = _jload(os.path.join(OUT, "selection.json"))
    vp = os.path.join(DOCS, "versions.json")
    V = Versions(vp)
    cfg = sel["selected_config"]
    h = content_hash(cfg)
    for v in V.doc["versions"]:
        if v["config_sha256"] == h:
            print(f"study version: the selected configuration is already version {v['version']} ({v['status']})", file=sys.stderr)
            return v
    t = cmp_["test"]
    evidence = {"study": "docs/model-loop/ufc/study (protocol sha256 " + sha + ")", "test_window": t,
                "kept": sel["kept"], "dropped": sel["dropped"], "not_tested": sel.get("not_tested", []),
                "facts": cmp_.get("facts"), "reference": {k: cmp_["reference"].get(k) for k in ("name", "timestamped", "matched", "sha256")},
                "vs_close_since_2018": {k: cmp_["windows"]["since_2018"][k]["close_subset"] for k in ("old", "new")}}
    reason = (f"2026-10 study: {', '.join(sel['kept'])} kept one at a time on 2021-2023; on the {t['n']} test bouts from "
              f"{t['window'][0]} log loss {t['old_log_loss']} -> {t['new_log_loss']} ({t['delta_log_loss']:+.5f}, card-blocked 95% "
              f"interval {t['ci95']}), Brier {t['delta_brier']:+.5f} against {BASE_VERSION}. ")
    if cmp_["promote"]:
        v = V.promote(cfg, reason=reason + "Cleared the promotion rule.", evidence=evidence, promoted_by="study-2026-10",
                      status="SERVED (EXPERIMENTAL)")
        for old in V.doc["versions"]:
            if old["version"] != v["version"] and str(old.get("status", "")).startswith("SERVED"):
                old["status"] = "RETIRED (rollback target)" + ("; runnable for comparison" if old["version"] == BASE_VERSION else "")
        V.save()
    else:
        v = {"version": V.next_version(), "parent": V.doc["current"], "config": cfg, "config_sha256": h, "status": "NOT SERVED (candidate)",
             "promoted_by": None, "promoted_at": now_iso(), "reason": reason + "Did not clear the promotion rule: " + "; ".join(cmp_["reasons"]),
             "evidence": evidence}
        V.doc["versions"].append(v)
        V.save()
    print(f"study version: {v['version']} {v['status']} (config sha256 {v['config_sha256'][:12]})", file=sys.stderr)
    return v


# ------------------------------------------------------------- age study
AGE_BASE = "1.2.0"
AGE_DIVISIONS = ["Flyweight", "Bantamweight", "Featherweight", "Lightweight", "Welterweight", "Middleweight", "Light Heavyweight",
                 "Heavyweight", "W Strawweight", "W Flyweight", "W Bantamweight", "W Featherweight"]
AGE_GRID = {"knee": list(range(28, 41)), "slope": [0, -5, -10, -15, -20, -25, -30, -40], "elite": [0, -5, -10, -15, -20, -30],
            "min_fit_bouts": 150}
AGE_OUT = os.path.join(OUT, "age_by_division.json")


def age_protocol_doc():
    return {"schema": "edgedesk_model_loop_ufc_age_protocol_v1", "base_version": AGE_BASE, "windows": WINDOWS, "grid": AGE_GRID,
            "divisions": AGE_DIVISIONS,
            "question": "Does a fighter's age cost the same at every weight, and for an elite UFC record as for any other? "
                        "(asked 2026-10-24: heavyweights, and perhaps the lighter divisions, may age later)",
            "candidates": {
                "division_curves": "each division its own knee and slope (age_div), chosen on FIT by the log loss of that division's "
                                   "bouts alone: knee with the shared slope, then slope, then knee again, divisions in the order "
                                   "listed, each on top of the ones before; a division with fewer than min_fit_bouts FIT bouts with "
                                   "both ages keeps the shared curve",
                "division_knees": "each division its own knee, the shared slope (-15), chosen the same way",
                "elite": "age_elite_slope (more Elo per year past the knee for a fighter with 6+ UFC wins at 70%+ before the bout), "
                         "chosen on FIT over every bout",
                "division_curves_and_elite": "division_curves, then the elite slope chosen on FIT on top of them"},
            "keep_rule": f"SELECT log loss at least {MIN_GAIN_LL} below {AGE_BASE}'s and FIT no worse; among the kept, the lowest SELECT "
                         "log loss",
            "promote_rule": f"TEST log loss at least {MIN_GAIN_LL} below {AGE_BASE}'s on the same bouts with the card-blocked paired 95% "
                            "interval below zero, and the Brier score no worse",
            "disclosure": "Written 2026-10-24 before any candidate was fitted. Already seen, on every bout since 2016 (FIT, SELECT and "
                          "TEST): 1.2.0's error for the older fighter by division and age, and for older fighters with an elite UFC "
                          "record (6+ wins at 70%+, the cut-off used here). A heavyweight-only later knee (0-6 years) was tried on all "
                          "three windows and made each worse; it is not a candidate. TEST was read for 1.2.0's promotion; this is the "
                          "first read for an age-by-division model."}


def _age_protocol_sha():
    p = os.path.join(OUT, "age_protocol.json")
    body = json.loads(json.dumps(age_protocol_doc()))
    if not os.path.exists(p):
        doc = dict(body, sha256=content_hash(body))
        dump(p, doc)
        return doc["sha256"]
    doc = _jload(p)
    if {k: v for k, v in doc.items() if k != "sha256"} != body or content_hash(body) != doc["sha256"]:
        raise SystemExit("age_protocol.json does not match the code's protocol: change neither after the fact")
    return doc["sha256"]


def _div_mask(D, rows, w, div=None):
    m = _in(rows, w) & rows.y.notna()
    if div:
        m &= (D.d.loc[rows.index, "weight_class"] == div).values
    return m


def _fit_divisions(D, base, slopes):
    """coordinate search, division by division, on FIT bouts at that weight"""
    cfg = copy.deepcopy(base)
    cfg["age_div"] = dict(cfg.get("age_div") or {})
    shared = (float(cfg["age_knee"]), float(cfg["age_slope"]))
    known = np.isfinite(D.fx.age_a.values) & np.isfinite(D.fx.age_b.values)
    picks = {}
    for div in AGE_DIVISIONS:
        nfit = int((_in(D.d, WINDOWS["fit"]) & D.d.y.notna() & (D.d.weight_class == div) & known).sum())
        if nfit < AGE_GRID["min_fit_bouts"]:
            picks[div] = {"fit_bouts": nfit, "curve": None, "note": f"fewer than {AGE_GRID['min_fit_bouts']} FIT bouts: the shared curve"}
            continue

        def score(knee, slope):
            c = copy.deepcopy(cfg)
            c["age_div"][div] = [knee, slope]
            rows, _ = D.run(c)
            x = rows[_div_mask(D, rows, WINDOWS["fit"], div)]
            return float(ll_each(x.p, x.y).mean())
        knee, slope = shared
        best = (score(knee, slope), knee, slope)
        for rnd in (0, 1, 2):
            if rnd == 1 and slopes:
                for sl in AGE_GRID["slope"]:
                    v = score(best[1], sl)
                    if v < best[0] - 1e-12:
                        best = (v, best[1], sl)
            elif rnd != 1:
                for kn in AGE_GRID["knee"]:
                    v = score(kn, best[2])
                    if v < best[0] - 1e-12:
                        best = (v, kn, best[2])
        if (best[1], best[2]) != shared:
            cfg["age_div"][div] = [best[1], best[2]]
        picks[div] = {"fit_bouts": nfit, "curve": [best[1], best[2]], "fit_log_loss_division": round(best[0], 5)}
    if not cfg["age_div"]:
        cfg.pop("age_div")
    return cfg, picks


def _fit_elite(D, base):
    best = None
    for es in AGE_GRID["elite"]:
        c = dict(copy.deepcopy(base), age_elite_slope=es)
        f, _ = _window_ll(D.run(c)[0], WINDOWS["fit"])
        if best is None or f < best[0] - 1e-12:
            best = (f, c)
    return best[1]


def _division_table(D, base_rows, rows):
    """per division: bouts and the log-loss change against the base in each window, and the older fighter's said / won"""
    out = {}
    for div in AGE_DIVISIONS:
        r = {}
        for wn in ("fit", "select", "test"):
            m = _div_mask(D, base_rows, WINDOWS[wn], div)
            if m.sum():
                a, b = rows[m], base_rows[m]
                r[wn] = {"n": int(m.sum()), "delta_log_loss": round(float((ll_each(a.p, a.y) - ll_each(b.p, b.y)).mean()), 5)}
        s = base_rows[_div_mask(D, base_rows, [WINDOWS["fit"][0], WINDOWS["test"][1]], div)]
        aa, ab = s.age_a.values, s.age_b.values
        ok = np.isfinite(aa) & np.isfinite(ab) & (np.abs(aa - ab) >= 3) & (np.fmax(aa, ab) >= 33)
        ob = ab > aa
        if ok.sum():
            y = np.where(ob, 1 - s.y.values, s.y.values)[ok]
            said_b = np.where(ob, 1 - s.p.values, s.p.values)[ok]
            said_n = np.where(ob, 1 - rows.loc[s.index, "p"].values, rows.loc[s.index, "p"].values)[ok]
            r["older_33_plus"] = {"n": int(ok.sum()), "base_said": round(float(said_b.mean()), 4), "new_said": round(float(said_n.mean()), 4),
                                  "won": round(float(y.mean()), 4)}
        out[div] = r
    return out


def _age_oos(base_rows, rows):
    """every candidate was fitted on FIT alone, so SELECT and TEST together (2021 on) are out of sample for it"""
    w = [WINDOWS["select"][0], WINDOWS["test"][1]]
    b = base_rows[_in(base_rows, w) & base_rows.y.notna()]
    a = rows.loc[b.index]
    dl = ll_each(a.p, b.y) - ll_each(b.p, b.y)
    return {"window": w, "n": int(len(b)), "delta_log_loss": round(float(dl.mean()), 5), "ci95": block_ci(dl, b.event_id.values),
            "delta_brier": round(float(np.mean((a.p - b.y) ** 2) - np.mean((b.p - b.y) ** 2)), 5),
            "by_season": {str(int(k)): round(float(dl[b.season.values == k].mean()), 5) for k in sorted(b.season.unique())}}


def _num_eq(a, b):
    f = lambda x: json.loads(json.dumps(x), parse_int=float)
    return f(a) == f(b)


def _age_adopted(results):
    """the candidate a version now carries, if any (the weekly loop retests the age curve by division: loop.py CATALOGUE)"""
    vs = Versions(os.path.join(DOCS, "versions.json")).doc["versions"]
    for v in vs:
        for name, r in results.items():
            ch = r["config_change"]
            if ch and all(_num_eq(v["config"].get(k), x) for k, x in ch.items()):
                return {"candidate": name, "version": v["version"], "status": v["status"], "promoted_by": v.get("promoted_by"),
                        "promoted_at": v.get("promoted_at"), "reason": v.get("reason")}
    return None


def cmd_age(D=None):
    """the age curve by division and for elite records, under age_protocol.json; writes age_by_division.json"""
    sha = _age_protocol_sha()
    D = D or Data()
    base = dict(U.DEFAULTS, **served_config(AGE_BASE))
    base_rows, _ = D.run(base)
    fit0, _ = _window_ll(base_rows, WINDOWS["fit"])
    sel0, s_sel = _window_ll(base_rows, WINDOWS["select"])
    curves_cfg, curves = _fit_divisions(D, base, slopes=True)
    knees_cfg, knees = _fit_divisions(D, base, slopes=False)
    elite_cfg = _fit_elite(D, base)
    both_cfg = _fit_elite(D, curves_cfg)
    cands, results = {"division_curves": curves_cfg, "division_knees": knees_cfg, "elite": elite_cfg, "division_curves_and_elite": both_cfg}, {}
    for name, c in cands.items():
        rows, _ = D.run(c)
        f, _ = _window_ll(rows, WINDOWS["fit"])
        sl, s2 = _window_ll(rows, WINDOWS["select"])
        diff = ll_each(s2.p, s2.y) - ll_each(base_rows.loc[s2.index, "p"], s2.y)
        keep = (sl - sel0) <= -MIN_GAIN_LL and f <= fit0 + 1e-12
        results[name] = {"config_change": {k: c.get(k) for k in ("age_div", "age_elite_slope") if c.get(k)},
                         "fit_delta": round(f - fit0, 5), "select_delta": round(sl - sel0, 5), "select_ci95": block_ci(diff, s2.event_id.values),
                         "decision": "KEPT" if keep else "DROPPED",
                         "reason": "clears the keep rule" if keep else "; ".join(x for x in (
                             f"SELECT log loss change {sl - sel0:+.5f} does not clear -{MIN_GAIN_LL}" if (sl - sel0) > -MIN_GAIN_LL else "",
                             f"FIT log loss worse ({f - fit0:+.5f})" if f > fit0 + 1e-12 else "") if x),
                         "divisions": _division_table(D, base_rows, rows), "out_of_sample": _age_oos(base_rows, rows)}
        print(f"age candidate {name}: {results[name]['decision']} (fit {f - fit0:+.5f}, select {sl - sel0:+.5f}) {results[name]['config_change']}", file=sys.stderr)
    kept = [k for k, v in results.items() if v["decision"] == "KEPT"]
    out = {"schema": "edgedesk_model_loop_ufc_age_study_v1", "generated_at": now_iso(), "protocol_sha256": sha, "base_version": AGE_BASE,
           "facts": D.facts_prov, "reference": D.close_prov, "fits": {"division_curves": curves, "division_knees": knees},
           "candidates": results, "kept": kept, "adopted": _age_adopted(results)}
    if kept:
        name = min(kept, key=lambda k: results[k]["select_delta"])
        new_cfg = {k: v for k, v in cands[name].items() if k in U.DEFAULTS and (v != U.DEFAULTS.get(k) or k in served_config(AGE_BASE))}
        rows, _ = D.run(new_cfg)
        test = _in(base_rows, WINDOWS["test"]) & base_rows.y.notna()
        so, sn = base_rows[test], rows.loc[base_rows[test].index]
        lo, ln = ll_each(so.p, so.y), ll_each(sn.p, sn.y)
        d_ll, d_br = float((ln - lo).mean()), float(np.mean((sn.p - sn.y) ** 2) - np.mean((so.p - so.y) ** 2))
        ci = block_ci(ln - lo, so.event_id.values)
        reasons = [x for x in (f"TEST log loss change {d_ll:+.5f} does not clear -{MIN_GAIN_LL}" if d_ll > -MIN_GAIN_LL else "",
                               f"card-blocked 95% interval {ci} is not below zero" if not ci or ci[1] >= 0 else "",
                               f"Brier worse ({d_br:+.5f})" if d_br > 0 else "") if x]
        out.update(chosen=name, selected_config=new_cfg, promote=not reasons, reasons=reasons or ["clears the promotion rule"],
                   test={"window": WINDOWS["test"], "n": int(len(so)), "old_log_loss": round(float(lo.mean()), 5), "new_log_loss": round(float(ln.mean()), 5),
                         "delta_log_loss": round(d_ll, 5), "ci95": ci, "delta_brier": round(d_br, 5)})
        print(f"age study: {name} chosen; test {d_ll:+.5f} CI {ci}; promote={not reasons}", file=sys.stderr)
    else:
        out.update(chosen=None, promote=False, reasons=["no candidate cleared the keep rule"])
    dump(AGE_OUT, out)
    return out


def cmd_all():
    D = Data()
    cmd_diagnose(BASE_VERSION, D)
    if not os.path.exists(os.path.join(OUT, "protocol.json")):
        cmd_protocol()
    cmd_select(D)
    out = cmd_compare(D)
    cmd_report()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["protocol", "diagnose", "select", "compare", "report", "version", "age", "all"])
    ap.add_argument("--version", default=BASE_VERSION)
    a = ap.parse_args(argv)
    if a.cmd == "protocol":
        cmd_protocol()
    elif a.cmd == "diagnose":
        cmd_diagnose(a.version)
    elif a.cmd == "select":
        cmd_select()
    elif a.cmd == "compare":
        cmd_compare()
    elif a.cmd == "report":
        cmd_report()
    elif a.cmd == "version":
        cmd_version()
    elif a.cmd == "age":
        cmd_age()
    else:
        cmd_all()


if __name__ == "__main__":
    main()
