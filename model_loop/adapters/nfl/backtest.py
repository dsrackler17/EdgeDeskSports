"""NFL v2: preregistered tuning, walk-forward backtest, ablations, and the
comparison with the current model and the closing line.

  python3 -m model_loop.adapters.nfl.backtest prereg   # write the preregistration (before any tuning)
  python3 -m model_loop.adapters.nfl.backtest tune     # coordinate descent on the TUNE window only
  python3 -m model_loop.adapters.nfl.backtest report   # ablations on VALIDATION, then holdout + live, once

Windows (fixed in PREREG before tuning):
  tune        2011-2019   hyperparameters chosen here, nowhere else
  validation  2020-2024   incremental-value bar for every component
  holdout     2025        read once, for the ship decision
  live        2026 to date (out of sample by construction)

Every variant evaluated is appended to the tuning log, pass or fail.
"""
import argparse
import copy
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from ...core import walkforward as WF
from ...core.distribution import KeyNumberMargin, normal_cdf
from ...core import metrics as M
from .ratings import Tables, NflRatingPass, DEFAULTS as RATING_DEFAULTS, merge
from . import model as NM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DATA = os.path.join(ROOT, ".cache", "model_loop", "nfl")
DOCS = os.path.join(ROOT, "docs", "model-loop", "nfl")
BASELINES = os.path.join(os.path.dirname(__file__), "baselines", "legacy_v1_predictions.csv")
RECORD = os.path.join(ROOT, "record", "football", "nfl_2026.json")
SEASONS = list(range(2006, 2027))

PREREG = {
    "study": "NFL v2 core rebuild (Phase 1)",
    "version": "nfl_v2.0.0-candidate",
    "registered_at": "2026-10-20",
    "objective": "Lower margin error and win-probability log loss than the current NFL model (edgedesk_football_v1.0.0) "
                 "out of sample, measured against the closing line as the baseline.",
    "windows": {"tune": [2011, 2019], "validation": [2020, 2024], "holdout": [2025, 2025], "live": [2026, 2026]},
    "unit": "every NFL game (regular season and postseason) with a final score and a consensus closing spread",
    "metrics": ["margin MAE vs result (primary)", "win-probability log loss (primary)", "margin RMSE", "Brier",
                "mean |model - close|", "share of games 3+ points from the close", "ATS vs close at 1/2/3 pt gaps",
                "calibration table (10 bins) and ECE", "total MAE vs close total",
                "CLV in points vs EdgeDesk's own opener capture (2026 only; no historical openers exist)"],
    "tuning": {"objective": "margin MAE on the tune window", "method": "coordinate descent, two passes, over the grid below; "
               "garbage-time weight fixed at 0.25 (not tuned) and tested only as an ablation",
               "grid": {
                   "rating.hl_week": [3, 6, 12, None],
                   "rating.lam.pass_off": [150, 300, 600, 1200], "rating.lam.pass_def": [300, 600, 1200, 2400],
                   "rating.lam.rush_off": [150, 300, 600, 1200], "rating.lam.rush_def": [300, 600, 1200, 2400],
                   "rating.lam.qb": [100, 250, 500, 1000],
                   "rating.carry.off": [0.4, 0.6, 0.8], "rating.carry.def": [0.2, 0.4, 0.6], "rating.carry.qb": [0.6, 0.8, 1.0],
                   "rating.market.hl_week": [2, 4, 8], "rating.market.lam": [1, 3, 10], "rating.market.carry": [0.4, 0.6, 0.8],
                   "rating.personnel.skill": [0.0, 0.5, 1.0], "rating.personnel.ol": [0.0, 0.05, 0.1],
                   "model.hl_season": [3, 6, None], "model.hfa_prior_games": [0, 300, 1000], "model.ridge_lam": [0.5, 2, 8]}},
    "incremental_value_bar": "On the VALIDATION window only, each component is removed from the tuned model. A component stays "
                             "active only if removing it raises validation margin MAE or validation log loss; otherwise it is "
                             "marked inactive and the model is refitted without it. The holdout is not consulted.",
    "decision_rule": "v2 may replace v1 on the card only if, on the 2025 holdout, it has lower margin MAE AND lower log loss than "
                     "v1 as trained (walk-forward) AND v1 as shipped, AND it is not worse on the full 2011-2025 backtest. "
                     "Otherwise v1 stays and v2 remains EXPERIMENTAL. Beating the close is reported, not required.",
    "inactive_by_data": ["preseason win totals (not owned)", "historical openers (EdgeDesk capture starts 2026-09-16)",
                         "book-level closes before 2026", "OL grades / tracking data (not owned)"],
    "forking_paths": {
        "disclosed_before_tuning": "During development a single smoke test of the UNTUNED default configuration was scored on "
                                   "every window including the 2025 holdout (v2 MAE 10.18 vs v1-trained 10.17, log loss 0.644 vs "
                                   "0.636). No setting was changed in response to the holdout; the grid above was fixed before it.",
        "structural_choices": "no intercept (neutral = 0); offense and defense separate coefficients; QB as its own rating "
                              "parameter; travel rows centred on a typical trip so home field means home field with a typical trip; "
                              "per-week snapshots (a Thursday game is not absorbed before that week's Sunday games)."},
}


def _get(d, path):
    for k in path.split("."):
        d = d[k]
    return d


def _set(d, path, v):
    ks = path.split(".")
    for k in ks[:-1]:
        d = d.setdefault(k, {})
    d[ks[-1]] = v


class Runner:
    def __init__(self, data=DATA):
        self.T = Tables(os.path.join(data, "build"))
        self.cache = {}

    def rows(self, rcfg):
        key = WF.content_hash(rcfg)
        if key not in self.cache:
            r, _ = NflRatingPass(self.T, rcfg).run(SEASONS)
            self.cache[key] = NM.add_geo(r)
            if len(self.cache) > 12:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def predict(self, cfg, probs=False):
        r = self.rows(cfg["rating"])
        p, info = NM.walk_forward(r, cfg["model"])
        if probs:
            p, dists = NM.add_probabilities(p, cfg["model"])
            info["dists"] = dists
        return p, info


def default_cfg():
    return {"rating": copy.deepcopy(RATING_DEFAULTS), "model": copy.deepcopy(NM.MODEL_DEFAULTS)}


def tune_score(runner, cfg):
    p, _ = runner.predict(cfg)
    lo, hi = PREREG["windows"]["tune"]
    d = p[(p.season >= lo) & (p.season <= hi) & p.pred_margin.notna() & p.result.notna() & p.close_margin.notna()]
    return float(np.mean(np.abs(d.pred_margin - d.result))), len(d)


def cmd_prereg(out=DOCS):
    os.makedirs(out, exist_ok=True)
    j = dict(PREREG)
    j["content_sha256"] = WF.content_hash(PREREG)
    with open(os.path.join(out, "prereg.json"), "w") as f:
        json.dump(j, f, indent=1)
    print(j["content_sha256"])


def cmd_tune(out=DOCS, passes=2):
    os.makedirs(out, exist_ok=True)
    runner = Runner()
    cfg = default_cfg()
    grid = PREREG["tuning"]["grid"]
    log_path = os.path.join(out, "tuning_log.jsonl")
    log = open(log_path, "a")
    best, n = tune_score(runner, cfg)
    log.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "pass": 0, "param": None, "value": None, "tune_mae": round(best, 5), "n": n, "cfg": cfg}) + "\n")
    print("start", round(best, 4), file=sys.stderr)
    for ps in range(1, passes + 1):
        changed = False
        for path, values in grid.items():
            scope, sub = path.split(".", 1)
            cur = _get(cfg[scope], sub)
            for v in values:
                if v == cur:
                    continue
                trial = copy.deepcopy(cfg)
                _set(trial[scope], sub, v)
                s, n = tune_score(runner, trial)
                log.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "pass": ps, "param": path, "value": v,
                                      "tune_mae": round(s, 5), "n": n, "accepted": s < best - 1e-6}) + "\n")
                log.flush()
                if s < best - 1e-6:
                    best, cfg, changed = s, trial, True
                    print(f"pass {ps} {path}={v}: {s:.4f}", file=sys.stderr)
        if not changed:
            break
    log.close()
    with open(os.path.join(out, "tuned_config.json"), "w") as f:
        json.dump({"tune_mae": round(best, 5), "cfg": cfg}, f, indent=1)
    print(json.dumps({"tune_mae": best, "cfg": cfg}))
    return cfg


# ------------------------------------------------------------------ report
ABLATIONS = [
    ("garbage_time_filter", "rating.garbage_floor", 1.0),
    ("in_season_recency", "rating.hl_week", None),
    ("qb_layer", "rating.qb_layer", False),
    ("market_rating", "model.components.market", False),
    ("last_season_carryover", "rating.carry.off", 0.0),
    ("personnel_skill_moves", "rating.personnel.skill", 0.0),
    ("ol_continuity", "rating.personnel.ol", 0.0),
    ("offense_defense_split", "model.components.pass_split", False),
    ("rest_bye_short", "model.components.rest", False),
    ("travel_timezone", "model.components.travel", False),
    ("division", "model.components.division", False),
    ("hfa_shrinkage", "model.hfa_prior_games", 0),
    ("era_weighting", "model.hl_season", None),
]


def _ablate(cfg, path, value):
    c = copy.deepcopy(cfg)
    scope, sub = path.split(".", 1)
    _set(c[scope], sub, value)
    if path == "rating.carry.off":       # carryover off means every prior back to the league mean
        _set(c["rating"], "carry.def", 0.0)
        _set(c["rating"], "carry.qb", 0.0)
    if path == "rating.qb_layer":
        _set(c["model"], "components.qb", False)
    return c


def windows_eval(p, label, pred="pred_margin", prob="win_prob", total="pred_total"):
    out = {}
    for name, (lo, hi) in list(PREREG["windows"].items()) + [("backtest_2011_2025", (2011, 2025)), ("all_2011_2026", (2011, 2026))]:
        out[name] = WF.evaluate(p[(p.season >= lo) & (p.season <= hi)], pred, prob, total, label)
    return out


def normal_logloss(p, sigma_from):
    """The same projections priced from a plain normal (sigma fitted on prior
    seasons' residuals), to measure what the key-number shape adds."""
    out = p.copy()
    out["win_prob_normal"] = np.nan
    for S in sorted(out.season[out.pred_margin.notna()].unique()):
        prior = out[(out.season < S) & out.pred_margin.notna() & out.result.notna()]
        if prior.season.nunique() < 2:
            continue
        sd = float(np.std(prior.result - prior.pred_margin))
        te = (out.season == S) & out.pred_margin.notna()
        out.loc[te, "win_prob_normal"] = [normal_cdf(m / sd) for m in out.loc[te, "pred_margin"]]
    return out


def load_legacy(p):
    L = pd.read_csv(BASELINES)
    keep = ["game_id", "trained_margin", "trained_win_prob", "trained_total", "shipped_margin", "shipped_win_prob",
            "shipped_total", "shipped_deffix_margin", "shipped_deffix_win_prob"]
    return p.merge(L[keep], on="game_id", how="left")


def load_record(p):
    """What the live board actually published in 2026 (last pregame number)."""
    try:
        rec = json.load(open(RECORD))["games"]
    except Exception:
        return p.assign(record_margin=np.nan, record_win_prob=np.nan)
    m = {gid: (-g["pick"]["home_line"], g["pick"].get("home_win_prob")) for gid, g in rec.items()
         if g.get("pick") and g["pick"].get("home_line") is not None}
    p = p.copy()
    p["record_margin"] = p.game_id.map(lambda x: m.get(x, (np.nan, np.nan))[0])
    p["record_win_prob"] = p.game_id.map(lambda x: m.get(x, (np.nan, np.nan))[1])
    return p


def clv_2026(p, col):
    path = os.path.join(ROOT, "football", "pricing", "openers_nfl.json")
    try:
        op = json.load(open(path))["games"]
    except Exception:
        return None
    def nid(gid):
        return gid
    rows = []
    for _, r in p[(p.season == 2026) & p[col].notna() & p.close_margin.notna()].iterrows():
        o = op.get(r.game_id)
        if o and o.get("open") and o["open"].get("home_line") is not None:
            rows.append((r[col], -o["open"]["home_line"], r.close_margin))
    if not rows:
        return None
    a = np.array(rows, dtype=float)
    return M.clv_points(a[:, 0], a[:, 1], a[:, 2])


def key_number_eval(p, dists, lo=2011, hi=2025):
    """What the key-number shape adds where it should: pushes and covers AT
    the closing line. Each season's distribution (fitted on earlier seasons)
    against the same sigma with no key-number weights."""
    rows = {"key": [], "flat": [], "obs": [], "absline": []}
    for S, d in dists.items():
        if not (lo <= S <= hi):
            continue
        flat = KeyNumberMargin(sigma=d.sigma)
        q = p[(p.season == S) & p.pred_margin.notna() & p.result.notna() & p.close_margin.notna()]
        q = q[np.isclose(q.close_margin, np.round(q.close_margin))]
        if not len(q):
            continue
        mu, line, res = q.pred_margin.values, q.close_margin.values, q.result.values
        outcome = np.where(res > line, 0, np.where(res == line, 1, 2))
        for name, dist in (("key", d), ("flat", flat)):
            w, pu, l = dist.cover(mu, line)
            rows[name].append(np.column_stack([w, pu, l]))
        rows["obs"].append(outcome)
        rows["absline"].append(np.abs(line))
    if not rows["obs"]:
        return None
    K, F = np.vstack(rows["key"]), np.vstack(rows["flat"])
    o, a = np.concatenate(rows["obs"]), np.concatenate(rows["absline"])
    def ll(P):
        return float(-np.mean(np.log(np.clip(P[np.arange(len(o)), o], 1e-9, 1))))
    out = {"n_integer_close_lines": int(len(o)), "three_way_logloss_key": round(ll(K), 5), "three_way_logloss_flat": round(ll(F), 5), "push": {}}
    for lab, sel in (("line 3", a == 3), ("line 7", a == 7), ("other whole lines", (a != 3) & (a != 7))):
        if sel.sum():
            out["push"][lab] = {"n": int(sel.sum()), "observed": round(float(np.mean(o[sel] == 1)), 4),
                                "predicted_key": round(float(K[sel, 1].mean()), 4), "predicted_flat": round(float(F[sel, 1].mean()), 4)}
    return out


def calibration_eval(p, lo=2011, hi=2025):
    """Does a Platt or isotonic layer on top of the fitted distribution help?
    Each season is calibrated on earlier seasons' out-of-sample probabilities
    only (nested walk-forward)."""
    from ...core.calibration import Platt, Isotonic
    out = {}
    q = p[p.win_prob_raw.notna() & p.result.notna() & (p.result != 0)].copy()
    q["y"] = (q.result > 0).astype(float)
    for name, cls in (("platt", Platt), ("isotonic", Isotonic)):
        col = "wp_" + name
        q[col] = np.nan
        for S in sorted(q.season.unique()):
            hist = q[q.season < S]
            if hist.season.nunique() < 2:
                continue
            f = cls.fit(hist.win_prob_raw.values, hist.y.values)
            sel = q.season == S
            q.loc[sel, col] = f(q.loc[sel, "win_prob_raw"].values)
        d = q[(q.season >= lo) & (q.season <= hi) & q[col].notna()]
        out[name] = {"n": int(len(d)), "logloss_raw": round(M.logloss(d.win_prob_raw, d.y), 5),
                     "logloss_calibrated": round(M.logloss(d[col], d.y), 5),
                     "brier_raw": round(M.brier(d.win_prob_raw, d.y), 5), "brier_calibrated": round(M.brier(d[col], d.y), 5),
                     "ece_raw": M.calibration_table(d.win_prob_raw, d.y)["ece"], "ece_calibrated": M.calibration_table(d[col], d.y)["ece"]}
    return out


def run_ablations(runner, cfg):
    """The incremental-value bar on VALIDATION only."""
    base, _ = runner.predict(cfg, probs=True)
    vlo, vhi = PREREG["windows"]["validation"]
    def val(p):
        return WF.evaluate(p[(p.season >= vlo) & (p.season <= vhi)])
    vb = val(base)
    abl = []
    final = copy.deepcopy(cfg)
    for name, path, value in ABLATIONS:
        scope, sub = path.split(".", 1)
        if _get(cfg[scope], sub) == value:
            abl.append({"component": name, "status": "inactive (tuned off)", "val_mae_without": None})
            continue
        p, _ = runner.predict(_ablate(cfg, path, value), probs=True)
        v = val(p)
        d_mae = v["margin_mae"] - vb["margin_mae"]
        d_ll = v["logloss"] - vb["logloss"]
        keep = d_mae > 0 or d_ll > 0
        both = p[(p.season >= vlo) & (p.season <= vhi)][["game_id", "pred_margin", "win_prob"]].rename(columns={"pred_margin": "abl_margin", "win_prob": "abl_prob"})
        pair = WF.compare(base[(base.season >= vlo) & (base.season <= vhi)].merge(both, on="game_id"), "pred_margin", "abl_margin", "win_prob", "abl_prob")
        abl.append({"component": name, "val_mae_with": vb["margin_mae"], "val_mae_without": v["margin_mae"], "delta_mae_if_removed": round(d_mae, 4),
                    "val_logloss_with": vb["logloss"], "val_logloss_without": v["logloss"], "delta_logloss_if_removed": round(d_ll, 5),
                    "paired": pair, "status": "active (adds value)" if keep else "INACTIVE (no incremental value on validation)"})
        if not keep:
            final = _ablate(final, path, value)
    return abl, final


def cmd_report(out=DOCS, cfg=None, reuse_ablations=False):
    os.makedirs(out, exist_ok=True)
    runner = Runner()
    if cfg is None:
        cfg = json.load(open(os.path.join(out, "tuned_config.json")))["cfg"]
    res = {"prereg_sha256": WF.content_hash(PREREG), "tuned_config": cfg, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    # 1. incremental-value bar on VALIDATION only (or the bar already run, unchanged)
    if reuse_ablations:
        prev = json.load(open(os.path.join(out, "backtest.json")))
        abl, final = prev["ablations_validation"], prev["final_config"]
    else:
        abl, final = run_ablations(runner, cfg)
    res["ablations_validation"] = abl
    res["final_config"] = final
    # 2. the final model, every window, beside v1 and the close
    p, info = runner.predict(final, probs=True)
    res["key_numbers"] = key_number_eval(p, info["dists"])
    res["calibration_layers"] = calibration_eval(p)
    p = load_legacy(p)
    p = load_record(p)
    p = normal_logloss(p, None)
    res["coefficients_by_season"] = {"margin": info["margin"], "total": info["total"]}
    res["distribution_2026"] = info["dists"][2026].to_json() if 2026 in info["dists"] else None
    ev = {"v2": windows_eval(p, "v2"),
          "v1_trained": windows_eval(p, "v1_trained", "trained_margin", "trained_win_prob", "trained_total"),
          "v1_shipped": windows_eval(p, "v1_shipped", "shipped_margin", "shipped_win_prob", "shipped_total"),
          "v1_shipped_defense_fixed": windows_eval(p, "v1_shipped_deffix", "shipped_deffix_margin", "shipped_deffix_win_prob", "pred_total"),
          "v2_normal_distribution": windows_eval(p, "v2_normal", "pred_margin", "win_prob_normal", "pred_total"),
          "v1_published_2026": {"live": WF.evaluate(p[p.season == 2026], "record_margin", "record_win_prob", "pred_total", "v1_published")}}
    res["evaluation"] = ev
    pairs = {}
    for name, (lo, hi) in list(PREREG["windows"].items()) + [("backtest_2011_2025", (2011, 2025))]:
        d = p[(p.season >= lo) & (p.season <= hi)]
        pairs[name] = {"v2_vs_v1_trained": WF.compare(d, "pred_margin", "trained_margin", "win_prob", "trained_win_prob"),
                       "v2_vs_v1_shipped": WF.compare(d, "pred_margin", "shipped_margin", "win_prob", "shipped_win_prob"),
                       "v2_vs_close": WF.compare(d, "pred_margin", "close_margin")}
    pairs["live_vs_published"] = WF.compare(p[p.season == 2026], "pred_margin", "record_margin", "win_prob", "record_win_prob")
    res["paired"] = pairs
    res["clv_2026"] = {"v2": clv_2026(p, "pred_margin"), "v1_published": clv_2026(p, "record_margin"), "v1_trained": clv_2026(p, "trained_margin")}
    # 3. the decision, as preregistered
    hold, full = "holdout", "backtest_2011_2025"
    dec = {}
    for cur in ("v1_trained", "v1_shipped"):
        dec[cur] = WF.promotion_decision(ev["v2"][full], ev[cur][full], ev["v2"][hold], ev[cur][hold])
    res["decision"] = {"against": dec, "ship": all(d["promote"] for d in dec.values())}
    # 4. the prediction frame, for the card build and the week-by-week report
    keep = ["game_id", "season", "week", "game_type", "home", "away", "neutral", "result", "close_margin", "close_total", "total_pts",
            "pred_margin", "pred_total", "win_prob", "tie_prob", "range_half", "mkt_win_prob", "prior_part",
            "trained_margin", "shipped_margin", "record_margin", "home_qb_name", "away_qb_name"] + \
           [c for c in p.columns if c.startswith("c_") or c.startswith("ct_")]
    p[keep].to_csv(os.path.join(out, "predictions.csv.gz"), index=False, compression="gzip")
    with open(os.path.join(out, "backtest.json"), "w") as f:
        json.dump(res, f, indent=1, default=lambda o: None if (isinstance(o, float) and not np.isfinite(o)) else (float(o) if isinstance(o, (np.floating,)) else int(o) if isinstance(o, np.integer) else str(o)))
    print(json.dumps({"decision": res["decision"], "v2_holdout": ev["v2"]["holdout"].get("margin_mae")}, default=str))
    return res


def _summ(e):
    keys = ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "brier", "close_brier",
            "mean_abs_vs_close", "share_3plus_from_close", "total_mae", "close_total_mae")
    return {k: e.get(k) for k in keys if k in e}


def cmd_registry(out=DOCS, sql_path=os.path.join(ROOT, "supabase", "model_loop_nfl_registry.sql")):
    """research_model_versions rows for v1 (the current, reproduced) and v2
    (this candidate), each with its result row, as SQL for the editor."""
    from ...core.registry_sql import emit
    bt = json.load(open(os.path.join(out, "backtest.json")))
    pre = json.load(open(os.path.join(out, "prereg.json")))
    ev = bt["evaluation"]
    w = PREREG["windows"]
    def dates(lo, hi):
        return [f"{lo}-09-01", f"{hi + 1}-03-01"]
    common = {"training": {"seasons": w["tune"]}, "training_text": "tune 2011-2019 (hyperparameters); every coefficient walk-forward",
              "training_dates": dates(*w["tune"]), "validation": {"seasons": w["validation"]}, "validation_text": "2020-2024",
              "validation_dates": dates(*w["validation"]), "holdout": {"seasons": w["holdout"]}, "holdout_text": "2025 (untouched until the ship decision)",
              "holdout_dates": dates(*w["holdout"])}
    v1 = dict(common, version="1.0.0", spec={"engine": "football/engine.js edgedesk_football_v1.0.0", "baseline": "reproduced walk-forward (as trained) and the shipped absorb path",
                                             "baselines_file": "model_loop/adapters/nfl/baselines/legacy_v1_predictions.csv"},
              notes="The model on the live card through 2026-10-20. Registered so the loop has a version to compare against and roll back to.",
              result={"passed": False, "note": "v1's own rule was beating the closing line; it does not (holdout MAE vs close below).",
                      "holdout": _summ(ev["v1_trained"]["holdout"]), "backtest_2011_2025": _summ(ev["v1_trained"]["backtest_2011_2025"]),
                      "shipped_holdout": _summ(ev["v1_shipped"]["holdout"])})
    v2 = dict(common, version="2.0.0-candidate",
              spec={"config": bt["final_config"], "config_sha256": WF.content_hash(bt["final_config"]), "prereg_sha256": bt["prereg_sha256"],
                    "code": "model_loop/adapters/nfl", "report": "docs/model-loop/nfl/BACKTEST.md"},
              notes="NFL v2 core rebuild (Phase 1). EXPERIMENTAL until a person promotes it.",
              result={"passed": bool(bt["decision"]["ship"]), "decision": bt["decision"],
                      "holdout": _summ(ev["v2"]["holdout"]), "backtest_2011_2025": _summ(ev["v2"]["backtest_2011_2025"]),
                      "live_2026": _summ(ev["v2"]["live"]), "validation": _summ(ev["v2"]["validation"]),
                      "note": "Preregistered decision against v1 as trained and v1 as shipped on the 2025 holdout and the 2011-2025 backtest."})
    payload = {"model_key": "NFL-CORE", "title": "NFL core projection (fair spread, win probability, total)", "sport": "NFL",
               "objective": pre["objective"], "primary_metric": "margin MAE vs result and win-probability log loss, against the closing line as baseline",
               "decision_rule": pre["decision_rule"], "forking_paths": pre["forking_paths"], "generated_at": bt["generated_at"],
               "versions": [v1, v2]}
    sql = emit(payload, "model_loop_nfl_registry.sql: register NFL-CORE v1.0.0 (current) and the v2 candidate,\n"
                        "each with its backtest result, in the research registry. docs/model-loop/nfl/BACKTEST.md")
    with open(sql_path, "w") as f:
        f.write(sql)
    print(sql_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["prereg", "tune", "report", "registry"])
    ap.add_argument("--out", default=DOCS)
    ap.add_argument("--reuse-ablations", action="store_true",
                    help="report: keep the validation ablations already in backtest.json (re-run only the final evaluation)")
    a = ap.parse_args(argv)
    if a.cmd == "report":
        cmd_report(a.out, reuse_ablations=a.reuse_ablations)
    else:
        {"prereg": cmd_prereg, "tune": cmd_tune, "registry": cmd_registry}[a.cmd](a.out)


if __name__ == "__main__":
    main()
