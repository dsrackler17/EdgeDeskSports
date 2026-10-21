"""CFB v2: preregistered tuning, walk-forward backtest, ablations, and the
comparison with the current CFB card engine (football/cfb_p4, v1.0.1) and the
closing line.

  python3 -m model_loop.adapters.cfb.backtest prereg     # write the preregistration (before any tuning)
  python3 -m model_loop.adapters.cfb.backtest baseline   # replay cfb_p4 cold, per game (baselines/)
  python3 -m model_loop.adapters.cfb.backtest tune       # coordinate descent on the TUNE window only
  python3 -m model_loop.adapters.cfb.backtest report     # ablations on VALIDATION, then holdout + live, once

Windows (fixed in PREREG before tuning):
  tune        2014-2020   hyperparameters chosen here, nowhere else
  validation  2021-2024   incremental-value bar for every component
  holdout     2025        read once, for the ship decision
  live        2026 to date (out of sample by construction)

Every variant evaluated is appended to the tuning log, pass or fail. Every
window is scored on all games with an FBS side, and separately on
FBS-vs-FBS and FBS-vs-FCS/lower-division games.
"""
import argparse
import copy
import gzip
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from ...core import walkforward as WF
from ...core.distribution import KeyNumberMargin, normal_cdf
from ...core import metrics as M
from .ratings import Tables, CfbRatingPass, DEFAULTS as RATING_DEFAULTS, merge
from . import model as CM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DATA = os.path.join(ROOT, ".cache", "model_loop", "cfb")
DOCS = os.path.join(ROOT, "docs", "model-loop", "cfb")
BASELINES = os.path.join(os.path.dirname(__file__), "baselines")
CFB_P4_PRED = os.path.join(BASELINES, "cfb_p4_replay_predictions.csv.gz")
RECORD = os.path.join(ROOT, "record", "football", "cfb_2026.json")
FIRST_SEASON = 2008
SEASONS = list(range(FIRST_SEASON, 2027))     # the study's frozen range; the weekly loop uses all_seasons()

PREREG = {
    "study": "CFB v2 core rebuild (model loop)",
    "version": "cfb_v2.0.0-candidate",
    "registered_at": "2026-10-21",
    "objective": "Lower margin error and win-probability log loss than the current CFB card engine "
                 "(football/cfb_p4/engine.js projectGame, edgedesk_cfb_p4_v1.0.1) out of sample, measured against the "
                 "closing line as the baseline, on FBS-vs-FBS and FBS-vs-FCS games separately and together.",
    "windows": {"tune": [2014, 2020], "validation": [2021, 2024], "holdout": [2025, 2025], "live": [2026, 2026]},
    "unit": "every game with at least one FBS side (regular season and postseason) with a final score and a closing spread "
            "(cfbfastR line archive median across books 2006-2025 via football/cfb_p4/research/build_market.py; "
            "2026: record/football/cfb_2026.json, DraftKings via ESPN, frozen at kickoff)",
    "slices": {"all": "every game with an FBS side", "fbs": "FBS vs FBS", "fcs": "FBS vs FCS or a lower division"},
    "metrics": ["margin MAE vs result (primary)", "win-probability log loss (primary)", "margin RMSE", "Brier",
                "mean |model - close|", "share of games 3+ points from the close", "ATS vs close at 1/2/3 pt gaps",
                "calibration table (10 bins) and ECE", "total MAE vs close total",
                "line movement toward the model (opener to close, archive openers 2014-2025)"],
    "tuning": {"objective": "margin MAE on the tune window, every game with an FBS side and a close (FBS and FCS together)",
               "method": "coordinate descent, two passes, over the grid below, starting from the defaults in "
                         "model_loop/adapters/cfb/ratings.py DEFAULTS and model.py MODEL_DEFAULTS as committed with this file; "
                         "garbage-time weight fixed at 0.25 (not tuned) and tested only as an ablation",
               "grid": {
                   "rating.market.hl_week": [4, 8, 16, None], "rating.market.lam": [0.1, 0.25, 0.5, 1],
                   "rating.market.carry": [0.8, 0.9, 1.0],
                   "rating.hl_week": [3, 6, 12, None],
                   "rating.lam.pass_off": [50, 150, 400, 1000], "rating.lam.pass_def": [50, 150, 400, 1000],
                   "rating.lam.rush_off": [50, 150, 400, 1000], "rating.lam.rush_def": [50, 150, 400, 1000],
                   "rating.lam.qb": [50, 150, 400, 1000], "rating.lam.lower": [200, 600, 1500, 4000],
                   "rating.carry.off": [0.6, 0.8, 1.0], "rating.carry.def": [0.4, 0.6, 0.8, 1.0],
                   "rating.carry.qb": [0.6, 0.8, 1.0], "rating.carry.lower": [0.3, 0.6, 0.9],
                   "rating.conf_w": [0.0, 0.25, 0.5],
                   "rating.talent.off": [0.0, 0.015, 0.03, 0.06], "rating.talent.def": [0.0, 0.015, 0.03, 0.06],
                   "rating.retprod": [0.0, 0.5, 1.0, 1.5],
                   "model.hl_season": [3, 6, None], "model.hfa_prior_games": [0, 300, 1000], "model.ridge_lam": [0.5, 2, 8]}},
    "incremental_value_bar": "On the VALIDATION window only (all games), each component is removed from the tuned model. A "
                             "component stays active only if removing it raises validation margin MAE or validation log loss; "
                             "otherwise it is marked inactive and the model is refitted without it. The holdout is not consulted.",
    "decision_rule": "v2 may replace cfb_p4 v1.0.1 on the card only if, on the 2025 holdout (all games), it has lower margin MAE "
                     "AND lower log loss than the cfb_p4 replay on the same games, AND it is not worse on the full 2014-2025 "
                     "backtest. Otherwise cfb_p4 stays and v2 remains EXPERIMENTAL. Beating the close is reported, not required.",
    "baseline": "football/cfb_p4/engine.js v1.0.1 (home field 2.8 via home_field.js) replayed cold from 2006, every game "
                "projected before it is absorbed (model_loop/adapters/cfb/baselines/replay_cfb_p4.js). Its trained coefficients "
                "were fitted on 2001-2025 in layers, so before 2026 the replay has an in-sample advantage. No team-game "
                "efficiency feed is supplied, so its matchup term is 0 (it reproduces the published 2022-2025 FBS MAE "
                "within 0.06). 2026 is also compared with what the record actually published.",
    "inactive_by_data": ["coaching change / tenure (the feed's coaching series starts 2015 and carries no publication date; not built)",
                         "historical QB starter announcements (the backtest prices the QB who took the most dropbacks)",
                         "historical injury / availability", "historical weather",
                         "Pinnacle closes after 2019 (the benchmark is the median across books)",
                         "travel distance / time zones (venue geography not ingested in this round)"],
    "data_caveats": ["Talent (247 composite) and returning production come from sportsdataverse-data releases that carry no "
                     "publication timestamp; for past seasons they are reconstructions from that season's roster, so their "
                     "contribution is measured by ablation, not assumed point-in-time clean.",
                     "The 2013 play-by-play feed files almost no sacks (53 vs ~3,500 a season), so 2013 pass ratings are "
                     "rosier; 2013 is a burn-in season for the tune window's priors only.",
                     "Garbage time uses the provider's NAIVE win probability (game state only); its wp_before reads the "
                     "pregame spread and is not used."],
    "forking_paths": {
        "disclosed_before_tuning": "During development one smoke test of a first, untuned configuration (market prior 3 games of "
                                   "evidence, half-life 4, carry 0.6; unit priors 300/600 plays) was scored on every window including "
                                   "the 2025 holdout (all games: v2 MAE 13.12 vs close 11.90; FBS 12.99 vs 11.82). A diagnostic of "
                                   "that market rating's compression (close regressed on the market rating, by week) was run on "
                                   "2014-2024, which includes the validation window: the market rating was shrunk ~1.5x. Four market "
                                   "settings and then the full model with the defaults committed here were scored on the TUNE window "
                                   "only (2014-2020: all games MAE 13.21 vs close 12.47; FBS 13.02 vs 12.45), and the defaults and "
                                   "the market grid were set from those. No setting was changed in response to the holdout. The "
                                   "cfb_p4 replay was scored on 2014-2025 to check it reproduces the published numbers.",
        "structural_choices": "no intercept (neutral = 0); offense and defense separate coefficients; QB as its own rating "
                              "parameter carried with the player through transfers; every FCS / lower-division team in the "
                              "play-by-play rated, around a fitted division mean; per-slate snapshots (a midweek game is not "
                              "absorbed before that week's Saturday games); the postseason in weekly slates."},
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
    def __init__(self, data=DATA, seasons=None):
        self.T = Tables(os.path.join(data, "build"))
        self.seasons = seasons or SEASONS
        self.cache = {}

    def all_seasons(self):
        return list(range(FIRST_SEASON, int(self.T.games.season.max()) + 1))

    def rows(self, rcfg):
        key = WF.content_hash(rcfg)
        if key not in self.cache:
            r, _ = CfbRatingPass(self.T, rcfg).run(self.seasons)
            self.cache[key] = r
            if len(self.cache) > 8:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def predict(self, cfg, probs=False):
        r = self.rows(cfg["rating"])
        p, info = CM.walk_forward(r, cfg["model"])
        if probs:
            p, dists = CM.add_probabilities(p, cfg["model"])
            info["dists"] = dists
        return p, info


def default_cfg():
    return {"rating": copy.deepcopy(RATING_DEFAULTS), "model": copy.deepcopy(CM.MODEL_DEFAULTS)}


def slice_mask(p, name):
    fbs = (p.home_div == "fbs") & (p.away_div == "fbs")
    return np.ones(len(p), bool) if name == "all" else fbs.values if name == "fbs" else ~fbs.values


def tune_score(runner, cfg):
    p, _ = runner.predict(cfg)
    lo, hi = PREREG["windows"]["tune"]
    d = p[(p.season >= lo) & (p.season <= hi) & p.pred_margin.notna() & p.result.notna() & p.close_margin.notna()]
    return float(np.mean(np.abs(d.pred_margin - d.result))), len(d)


_WORKER = {}


def _score_worker(cfg):
    if "runner" not in _WORKER:
        _WORKER["runner"] = Runner()
    return tune_score(_WORKER["runner"], cfg)


def cmd_prereg(out=DOCS):
    os.makedirs(out, exist_ok=True)
    j = dict(PREREG)
    j["content_sha256"] = WF.content_hash(PREREG)
    j["defaults_at_registration"] = {"rating": RATING_DEFAULTS, "model": CM.MODEL_DEFAULTS}
    with open(os.path.join(out, "prereg.json"), "w") as f:
        json.dump(j, f, indent=1)
    print(j["content_sha256"])


def cmd_tune(out=DOCS, passes=2, workers=3):
    """Coordinate descent. Every value of one parameter is scored in parallel
    and then accepted in grid order exactly as a sequential pass would (each
    trial changes only that parameter, so the trials are independent)."""
    os.makedirs(out, exist_ok=True)
    cfg = default_cfg()
    grid = PREREG["tuning"]["grid"]
    log_path = os.path.join(out, "tuning_log.jsonl")
    log = open(log_path, "a")
    pool = ProcessPoolExecutor(max_workers=workers)
    best, n = pool.submit(_score_worker, cfg).result()
    log.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "pass": 0, "param": None, "value": None,
                          "tune_mae": round(best, 5), "n": n, "cfg": cfg}) + "\n")
    log.flush()
    print("start", round(best, 4), file=sys.stderr)
    for ps in range(1, passes + 1):
        changed = False
        for path, values in grid.items():
            scope, sub = path.split(".", 1)
            cur = _get(cfg[scope], sub)
            trials = []
            for v in values:
                if v == cur:
                    continue
                trial = copy.deepcopy(cfg)
                _set(trial[scope], sub, v)
                trials.append((v, trial))
            results = list(pool.map(_score_worker, [t for _, t in trials]))
            for (v, trial), (s, n) in zip(trials, results):
                acc = s < best - 1e-6
                log.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "pass": ps, "param": path, "value": v,
                                      "tune_mae": round(s, 5), "n": n, "accepted": acc}) + "\n")
                log.flush()
                if acc:
                    best, cfg, changed = s, trial, True
                    print(f"pass {ps} {path}={v}: {s:.4f}", file=sys.stderr)
        if not changed:
            break
    pool.shutdown()
    log.close()
    with open(os.path.join(out, "tuned_config.json"), "w") as f:
        json.dump({"tune_mae": round(best, 5), "cfg": cfg}, f, indent=1)
    print(json.dumps({"tune_mae": best, "cfg": cfg}))
    return cfg


# ------------------------------------------------------------------ baseline
def cmd_baseline(data=DATA, out=CFB_P4_PRED):
    """Replay football/cfb_p4/engine.js cold over every game with an FBS
    side (baselines/replay_cfb_p4.js) and keep the per-game numbers."""
    import glob
    fs = sorted(glob.glob(os.path.join(data, "raw", "sched", "sched_*.csv")))
    cols = ["game_id", "season", "week", "season_type", "start_date", "home_team", "away_team", "home_division",
            "away_division", "home_conference", "away_conference", "neutral_site", "home_points", "away_points"]
    d = pd.concat([pd.read_csv(f, low_memory=False)[cols] for f in fs], ignore_index=True)
    d = d[d.season_type.isin(["regular", "postseason"])]
    inp = os.path.join(data, "build", "cfb_p4_replay_in.csv")
    tmp = os.path.join(data, "build", "cfb_p4_replay.csv")
    d.to_csv(inp, index=False)
    r = subprocess.run(["node", os.path.join(BASELINES, "replay_cfb_p4.js"), inp, tmp, "2006"], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr)
    b = pd.read_csv(tmp)
    b = b[b.season >= 2012]
    b.to_csv(out, index=False, compression="gzip")
    print(r.stderr.strip(), "->", out, len(b))


# ------------------------------------------------------------------ report
ABLATIONS = [
    ("garbage_time_filter", "rating.garbage_floor", 1.0),
    ("in_season_recency", "rating.hl_week", None),
    ("qb_layer", "rating.qb_layer", False),
    ("market_rating", "model.components.market", False),
    ("last_season_carryover", "rating.carry.off", 0.0),
    ("conference_prior", "rating.conf_w", 0.0),
    ("talent_prior", "rating.talent.off", 0.0),
    ("returning_production", "rating.retprod", 0.0),
    ("fcs_team_ratings", "rating.fcs_teams", False),
    ("division_offset", "model.components.division", False),
    ("offense_defense_split", "model.components.pass_split", False),
    ("rest_bye_short", "model.components.rest", False),
    ("covid_2020", "model.components.covid", False),
    ("hfa_shrinkage", "model.hfa_prior_games", 0),
    ("era_weighting", "model.hl_season", None),
]


def _ablate(cfg, path, value):
    c = copy.deepcopy(cfg)
    scope, sub = path.split(".", 1)
    _set(c[scope], sub, value)
    if path == "rating.carry.off":       # carryover off means every prior back to its mean
        for k in ("def", "qb", "lower"):
            _set(c["rating"], "carry." + k, 0.0)
        _set(c["rating"], "market.carry", 0.0)
        _set(c["rating"], "totals_market.carry", 0.0)
    if path == "rating.qb_layer":
        _set(c["model"], "components.qb", False)
    if path == "rating.talent.off":
        _set(c["rating"], "talent.def", 0.0)
    return c


def _ablation_active(cfg, path, value):
    scope, sub = path.split(".", 1)
    cur = _get(cfg[scope], sub)
    if path == "rating.talent.off":
        return not (cur == 0.0 and cfg["rating"]["talent"]["def"] == 0.0)
    return cur != value


WINDOWS_EXTRA = [("backtest_2014_2025", (2014, 2025)), ("all_2014_2026", (2014, 2026))]


def windows_eval(p, label, pred="pred_margin", prob="win_prob", total="pred_total"):
    out = {}
    for sl in ("all", "fbs", "fcs"):
        q = p[slice_mask(p, sl)]
        out[sl] = {}
        for name, (lo, hi) in list(PREREG["windows"].items()) + WINDOWS_EXTRA:
            out[sl][name] = WF.evaluate(q[(q.season >= lo) & (q.season <= hi)], pred, prob, total, label)
    return out


def normal_logloss(p):
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


def load_cfb_p4(p):
    """The cfb_p4 replay (same games, paired) and what the record published in 2026."""
    p = p.copy()
    try:
        b = pd.read_csv(CFB_P4_PRED)
        b = b[b.status == "PREDICTED"]
        mp = dict(zip(b.game_id.astype("int64"), b.fair_spread))
        mw = dict(zip(b.game_id.astype("int64"), b.home_win_prob))
        mt = dict(zip(b.game_id.astype("int64"), b.fair_total))
    except Exception:
        mp, mw, mt = {}, {}, {}
    p["p4_margin"] = p.game_id.map(mp).astype(float)
    p["p4_win_prob"] = p.game_id.map(mw).astype(float)
    p["p4_total"] = p.game_id.map(mt).astype(float)
    try:
        rec = json.load(open(RECORD))["games"]
    except Exception:
        rec = {}
    m = {}
    for gid, g in rec.items():
        pk = g.get("pick") or {}
        if pk.get("home_line") is not None:
            m[int(gid)] = (-float(pk["home_line"]), pk.get("home_win_prob"), pk.get("total"))
    p["record_margin"] = p.game_id.map(lambda x: m.get(int(x), (np.nan,) * 3)[0]).astype(float)
    p["record_win_prob"] = p.game_id.map(lambda x: m.get(int(x), (np.nan,) * 3)[1]).astype(float)
    p["record_total"] = p.game_id.map(lambda x: m.get(int(x), (np.nan,) * 3)[2]).astype(float)
    return p


def line_moves(p, col, lo=2014, hi=2025):
    """Did the market move from the opener toward the model's side? (archive
    openers; a model priced before the opener was posted would see the same
    information the opener did, so this is a fair read of agreement)."""
    d = p[(p.season >= lo) & (p.season <= hi) & p[col].notna() & p.open_margin.notna() & p.close_margin.notna()]
    if not len(d):
        return None
    return M.clv_points(d[col].values, d.open_margin.values, d.close_margin.values)


def key_number_eval(p, dists, lo=2014, hi=2025):
    """Pushes and covers AT the closing line: each season's distribution
    (fitted on earlier seasons) against the same sigma with no key-number
    weights."""
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
    for lab, sel in (("line 3", a == 3), ("line 7", a == 7), ("line 10", a == 10), ("line 14", a == 14),
                     ("other whole lines", ~np.isin(a, [3, 7, 10, 14]))):
        if sel.sum():
            out["push"][lab] = {"n": int(sel.sum()), "observed": round(float(np.mean(o[sel] == 1)), 4),
                                "predicted_key": round(float(K[sel, 1].mean()), 4), "predicted_flat": round(float(F[sel, 1].mean()), 4)}
    return out


def calibration_eval(p, lo=2014, hi=2025):
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


def _val(p):
    vlo, vhi = PREREG["windows"]["validation"]
    return WF.evaluate(p[(p.season >= vlo) & (p.season <= vhi)])


def _ablation_worker(args):
    name, cfg = args
    if "runner" not in _WORKER:
        _WORKER["runner"] = Runner()
    p, _ = _WORKER["runner"].predict(cfg, probs=True)
    vlo, vhi = PREREG["windows"]["validation"]
    return name, p[(p.season >= vlo) & (p.season <= vhi)][["game_id", "pred_margin", "win_prob", "home_div", "away_div",
                                                           "result", "close_margin", "home_ml", "away_ml", "mkt_win_prob",
                                                           "season", "pred_total", "total_pts", "close_total"]]


def run_ablations(runner, cfg, workers=3):
    """The incremental-value bar on VALIDATION only."""
    base, _ = runner.predict(cfg, probs=True)
    vlo, vhi = PREREG["windows"]["validation"]
    vb = _val(base)
    jobs = [(name, _ablate(cfg, path, value)) for name, path, value in ABLATIONS if _ablation_active(cfg, path, value)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        done = dict(pool.map(_ablation_worker, jobs))
    abl = []
    final = copy.deepcopy(cfg)
    for name, path, value in ABLATIONS:
        if name not in done:
            abl.append({"component": name, "status": "inactive (tuned off)", "val_mae_without": None})
            continue
        v = WF.evaluate(done[name])
        d_mae = v["margin_mae"] - vb["margin_mae"]
        d_ll = v["logloss"] - vb["logloss"]
        keep = d_mae > 0 or d_ll > 0
        both = done[name][["game_id", "pred_margin", "win_prob"]].rename(columns={"pred_margin": "abl_margin", "win_prob": "abl_prob"})
        bv = base[(base.season >= vlo) & (base.season <= vhi)].merge(both, on="game_id")
        pair = WF.compare(bv, "pred_margin", "abl_margin", "win_prob", "abl_prob")
        by = {}
        for sl in ("fbs", "fcs"):
            q = bv[slice_mask(bv, sl)]
            by[sl] = {"mae_with": round(M.mae(q.pred_margin, q.result), 4), "mae_without": round(M.mae(q.abl_margin, q.result), 4), "n": int(len(q))}
        abl.append({"component": name, "val_mae_with": vb["margin_mae"], "val_mae_without": v["margin_mae"], "delta_mae_if_removed": round(d_mae, 4),
                    "val_logloss_with": vb["logloss"], "val_logloss_without": v["logloss"], "delta_logloss_if_removed": round(d_ll, 5),
                    "paired": pair, "by_slice": by,
                    "status": "active (adds value)" if keep else "INACTIVE (no incremental value on validation)"})
        if not keep:
            final = _ablate(final, path, value)
    return abl, final


def _summ(e):
    keys = ("n", "margin_mae", "close_margin_mae", "logloss", "close_logloss", "logloss_same_games", "brier", "close_brier",
            "mean_abs_vs_close", "share_3plus_from_close", "total_mae", "close_total_mae")
    return {k: e.get(k) for k in keys if k in e}


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, float) and not np.isfinite(o):
        return None
    return str(o)


def prior_fade(p, lo=2014, hi=2025):
    """Share of base strength that is prior, by slate (|prior points| over
    |prior| + |this season|, summed over base-strength rows)."""
    d = p[(p.season >= lo) & (p.season <= hi) & p.pred_margin.notna()]
    base_cols = [c for c in ("c_pass_off", "c_qb", "c_pass_def", "c_rush_off", "c_rush_def", "c_market") if c in d.columns]
    tot = d[base_cols].sum(axis=1)
    pr = d.prior_part
    share = (pr.abs() / (pr.abs() + (tot - pr).abs())).where((pr.abs() + (tot - pr).abs()) > 1e-9)
    out = {}
    for w in (1, 2, 3, 4, 5, 6, 8, 10, 12, 14):
        s = share[d.slate == w]
        if len(s):
            out[str(w)] = round(float(s.mean()), 3)
    return out


def cmd_report(out=DOCS, cfg=None, reuse_ablations=False, workers=3):
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
        abl, final = run_ablations(runner, cfg, workers)
    res["ablations_validation"] = abl
    res["final_config"] = final
    # 2. the final model, every window, beside cfb_p4 and the close
    p, info = runner.predict(final, probs=True)
    res["key_numbers"] = key_number_eval(p, info["dists"])
    res["calibration_layers"] = calibration_eval(p)
    p = load_cfb_p4(p)
    p = normal_logloss(p)
    res["coefficients_by_season"] = {"margin": info["margin"], "total": info["total"]}
    res["distribution_by_season"] = {int(k): v.to_json() for k, v in info["dists"].items()}
    res["prior_fade"] = prior_fade(p)
    # the p4 replay's own probability: its published home_win_prob
    ev = {"v2": windows_eval(p, "v2"),
          "cfb_p4": windows_eval(p, "cfb_p4", "p4_margin", "p4_win_prob", "p4_total"),
          "v2_normal_distribution": windows_eval(p, "v2_normal", "pred_margin", "win_prob_normal", "pred_total")}
    ev["cfb_p4_published_2026"] = {sl: {"live": WF.evaluate(p[(p.season == 2026) & slice_mask(p, sl)], "record_margin",
                                                             "record_win_prob", "record_total", "cfb_p4_published")}
                                   for sl in ("all", "fbs", "fcs")}
    res["evaluation"] = ev
    pairs = {}
    for sl in ("all", "fbs", "fcs"):
        q = p[slice_mask(p, sl)]
        pairs[sl] = {}
        for name, (lo, hi) in list(PREREG["windows"].items()) + WINDOWS_EXTRA[:1]:
            d = q[(q.season >= lo) & (q.season <= hi)]
            pairs[sl][name] = {"v2_vs_cfb_p4": WF.compare(d, "pred_margin", "p4_margin", "win_prob", "p4_win_prob"),
                               "v2_vs_close": WF.compare(d, "pred_margin", "close_margin"),
                               "cfb_p4_vs_close": WF.compare(d, "p4_margin", "close_margin")}
        pairs[sl]["live_vs_published"] = WF.compare(q[q.season == 2026], "pred_margin", "record_margin")
    res["paired"] = pairs
    res["line_moves_toward_model_2014_2025"] = {"v2": line_moves(p, "pred_margin"), "cfb_p4": line_moves(p, "p4_margin")}
    # 3. the decision, as preregistered
    hold, full = "holdout", "backtest_2014_2025"
    dec = WF.promotion_decision(ev["v2"]["all"][full], ev["cfb_p4"]["all"][full], ev["v2"]["all"][hold], ev["cfb_p4"]["all"][hold])
    res["decision"] = {"against": {"cfb_p4": dec}, "ship": dec["promote"]}
    # 4. the prediction frame, for the card build and the week-by-week report
    keep = ["game_id", "season", "week", "slate", "season_type", "home", "away", "home_name", "away_name", "home_div", "away_div",
            "neutral", "result", "close_margin", "close_total", "total_pts", "pred_margin", "pred_total", "win_prob", "tie_prob",
            "range_half", "mkt_win_prob", "prior_part", "p4_margin", "p4_win_prob", "record_margin", "home_qb_name", "away_qb_name"] + \
           [c for c in p.columns if c.startswith("c_") or c.startswith("ct_")]
    p[keep].to_csv(os.path.join(out, "predictions.csv.gz"), index=False, compression="gzip")
    with open(os.path.join(out, "backtest.json"), "w") as f:
        json.dump(res, f, indent=1, default=_json_default)
    print(json.dumps({"decision": res["decision"], "v2_holdout": ev["v2"]["all"]["holdout"].get("margin_mae"),
                      "cfb_p4_holdout": ev["cfb_p4"]["all"]["holdout"].get("margin_mae")}, default=str))
    return res


def cmd_registry(out=DOCS, sql_path=os.path.join(ROOT, "supabase", "model_loop_cfb_registry.sql")):
    """research_model_versions rows for cfb_p4 v1.0.1 (the current, replayed)
    and v2 (this candidate), each with its result row, as SQL for the editor."""
    from ...core.registry_sql import emit
    bt = json.load(open(os.path.join(out, "backtest.json")))
    pre = json.load(open(os.path.join(out, "prereg.json")))
    ev = bt["evaluation"]
    w = PREREG["windows"]
    def dates(lo, hi):
        return [f"{lo}-08-01", f"{hi + 1}-02-01"]
    common = {"training": {"seasons": w["tune"]}, "training_text": "tune 2014-2020 (hyperparameters); every coefficient walk-forward",
              "training_dates": dates(*w["tune"]), "validation": {"seasons": w["validation"]}, "validation_text": "2021-2024",
              "validation_dates": dates(*w["validation"]), "holdout": {"seasons": w["holdout"]}, "holdout_text": "2025 (untouched until the ship decision)",
              "holdout_dates": dates(*w["holdout"])}
    v1 = dict(common, version="1.0.1", spec={"engine": "football/cfb_p4/engine.js edgedesk_cfb_p4_v1.0.1", "baseline": "cold walk-forward replay",
                                             "baselines_file": "model_loop/adapters/cfb/baselines/cfb_p4_replay_predictions.csv.gz"},
              notes="The model on the live CFB card through 2026-10-21. Registered so the loop has a version to compare against and roll back to.",
              result={"passed": False, "note": "v1's own rule was beating the closing line; it does not (holdout MAE vs close below).",
                      "holdout": _summ(ev["cfb_p4"]["all"]["holdout"]), "backtest_2014_2025": _summ(ev["cfb_p4"]["all"]["backtest_2014_2025"])})
    v2 = dict(common, version="2.0.0",
              spec={"config": bt["final_config"], "config_sha256": WF.content_hash(bt["final_config"]), "prereg_sha256": bt["prereg_sha256"],
                    "code": "model_loop/adapters/cfb", "report": "docs/model-loop/cfb/BACKTEST.md"},
              notes="CFB v2 core rebuild (model loop). Served by owner decision 2026-10-21; EXPERIMENTAL in the registry.",
              result={"passed": bool(bt["decision"]["ship"]), "decision": bt["decision"],
                      "holdout": _summ(ev["v2"]["all"]["holdout"]), "backtest_2014_2025": _summ(ev["v2"]["all"]["backtest_2014_2025"]),
                      "live_2026": _summ(ev["v2"]["all"]["live"]), "validation": _summ(ev["v2"]["all"]["validation"]),
                      "note": "Preregistered decision against the cfb_p4 replay on the 2025 holdout and the 2014-2025 backtest."})
    payload = {"model_key": "CFB-CORE", "title": "CFB core projection (fair spread, win probability, total)", "sport": "CFB",
               "objective": pre["objective"], "primary_metric": "margin MAE vs result and win-probability log loss, against the closing line as baseline",
               "decision_rule": pre["decision_rule"], "forking_paths": pre["forking_paths"], "generated_at": bt["generated_at"],
               "versions": [v1, v2]}
    sql = emit(payload, "model_loop_cfb_registry.sql: register CFB-CORE v1.0.1 (current) and v2,\n"
                        "each with its backtest result, in the research registry. docs/model-loop/cfb/BACKTEST.md")
    with open(sql_path, "w") as f:
        f.write(sql)
    print(sql_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["prereg", "baseline", "tune", "report", "registry"])
    ap.add_argument("--out", default=DOCS)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--reuse-ablations", action="store_true",
                    help="report: keep the validation ablations already in backtest.json (re-run only the final evaluation)")
    a = ap.parse_args(argv)
    if a.cmd == "report":
        cmd_report(a.out, reuse_ablations=a.reuse_ablations, workers=a.workers)
    elif a.cmd == "tune":
        cmd_tune(a.out, workers=a.workers)
    elif a.cmd == "baseline":
        cmd_baseline()
    else:
        {"prereg": cmd_prereg, "registry": cmd_registry}[a.cmd](a.out)


if __name__ == "__main__":
    main()
