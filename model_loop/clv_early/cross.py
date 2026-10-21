"""Phase 7: cross-scoring this study against the independent study on main
(research/clv_early_week/EXPERIMENTS.md, X-1..X-6). The other study's own code
supplies its lines, base predictions and fitted rules; this study's harness
scores everything.

  python3 -m model_loop.clv_early.cross x1      # harness parity
  python3 -m model_loop.clv_early.cross x23     # line source + SBR timing
  python3 -m model_loop.clv_early.cross x45     # the other study's NFL totals rules on timestamped lines
  python3 -m model_loop.clv_early.cross x6      # CFB residual timing
"""
import json
import os
import sys

import numpy as np
import pandas as pd

from . import harness as H
from . import run as R

OUT = os.path.join(R.RESULTS, "cross")


def _save(name, obj):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump(obj, f, indent=1, default=R._js)


def _line(r):
    lo, hi = r["clv_pts_ci95"]
    return (f"bets {r['n']:>4}  CLV {r['clv_pts']:+.3f} pts [{lo:+.3f},{hi:+.3f}]  {100 * r['clv_prob']:+.2f}%  "
            f"hit {r['hit_rate']:.3f}  perm-p {r['permutation']['p_value']:.3f}  ROI {100 * r['roi_at_bet_price']:+.2f}%")


def score(df, market, thr, label, sport="nfl", n_perm=500, ci_level=0.95):
    cfg = H.Config(threshold=thr, market=market, label=label, n_boot=2000, n_perm=n_perm, ci_level=ci_level)
    return H.evaluate(df, cfg, R.distribution(sport, market))


# ------------------------------------------------------------- SBR frames
def sbr_games():
    """The other study's SBR-to-nflverse join (research/clv/nfl.py load()), with
    this study's eligibility (both teams have played this season)."""
    from research.clv import nfl as N
    m, qa, _ = N.load()
    el = R.eligibility("nfl")
    m = m[m.game_id.map(el).fillna(False).astype(bool)].copy()
    return m, qa


def harness_frame(src, model, market, bet="open", close="close", odds=None):
    """Rows for this study's harness from a frame with open/close columns."""
    if market == "spread":
        b, c, res = src[f"{bet}_line"], src[f"{close}_line"], src["result"] if "result" in src else src["margin"]
    else:
        b, c, res = src[f"{bet}_total"], src[f"{close}_total"], src["total_pts"]
    out = pd.DataFrame({"game_id": src.game_id.astype(str).values, "season": src.season.astype(int).values,
                        "week": src.week.astype(int).values, "model": np.asarray(model, float),
                        "bet_line": b.astype(float).values, "close_line": c.astype(float).values,
                        "result": res.astype(float).values})
    if odds is not None:
        out["bet_odds_over"], out["bet_odds_under"] = odds[0], odds[1]
    return out[out.model.notna() & out.bet_line.notna() & out.close_line.notna()].reset_index(drop=True)


# -------------------------------------------------------------------- X-1
def x1():
    from model_loop.clv import harness as HO
    from research.clv import nfl as N
    m, _, _ = N.load()
    pre = m[m.season.isin(N.PRE)]
    N.DISTS = N.dists(pre)
    proxy = m[m.season.isin(N.PROXY)]
    fr = N.frame(proxy, "v21_total", "total")
    c = N.cfg(pre, "total", 1.5)
    theirs = HO.bet_table(fr[fr.model_line.notna()], c, 1.5)
    mine_df = harness_frame(fr, fr.model_line, "total")
    mine = H.place_bets(mine_df, H.Config(threshold=1.5, market="total"), R.distribution("nfl", "total"))
    mine = mine[mine.bet]
    a, b = float(theirs.clv_pts.mean()), float(mine.clv_pts.mean())
    res = {"their_n": int(len(theirs)), "my_n": int(len(mine)), "their_clv_pts": a, "my_clv_pts": b,
           "abs_diff": abs(a - b), "their_clv_prob": float(theirs.clv_prob.mean()), "my_clv_prob": float(mine.clv_prob.mean()),
           "pass": bool(len(theirs) == len(mine) and abs(a - b) < 1e-9)}
    print("X-1 harness parity:", res)
    _save("X-1_harness_parity", res)
    return res


# ------------------------------------------------------------------ X-2/3
def x23():
    m, qa = sbr_games()
    early = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21.csv")).set_index("game_id")
    lag = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21_lag1.csv")).set_index("game_id")
    m = m.copy()
    m["game_id"] = m.game_id.astype(str)
    out = {}
    L = R.lines("nfl")
    fresh = set(L.game_id[R.fresh_mask(L, "spread")])
    for mk, thr in (("spread", 2.0), ("total", 2.0)):
        col = f"model_{mk}"
        for which, P in (("W-1", early), ("W-2", lag)):
            # against SBR opens
            for seasons, tag in (([2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019], "SBR 2011-19"),
                                 ([2020, 2021], "SBR 2020-21"), (list(range(2011, 2022)), "SBR 2011-21")):
                src = m[m.season.isin(seasons)]
                df = harness_frame(src, src.game_id.map(P[col]), mk)
                r = score(df, mk, thr, f"v2.1.0 {mk} {which} vs {tag}")
                out[f"{mk}|{which}|{tag}"] = r
                print(f"{mk:6} {which} vs {tag:12}", _line(r))
            # against this study's timestamped early-week lines (R-1), 2020-24, and the same 2020-21 games as SBR
            for seasons, tag, only in ((list(range(2020, 2025)), "tau 2020-24", None),
                                       ([2020, 2021], "tau 2020-21 (SBR games)", set(m[m.season.isin([2020, 2021])].game_id))):
                df = R.frame("nfl", P.reset_index(), mk, seasons=seasons, fresh=True)
                if only is not None:
                    df = df[df.game_id.isin(only)].reset_index(drop=True)
                r = score(df, mk, thr, f"v2.1.0 {mk} {which} vs {tag}")
                out[f"{mk}|{which}|{tag}"] = r
                print(f"{mk:6} {which} vs {tag:24}", _line(r))
    verdict = {}
    for mk in ("spread", "total"):
        s1, s2 = out[f"{mk}|W-1|SBR 2011-21"]["clv_pts"], out[f"{mk}|W-2|SBR 2011-21"]["clv_pts"]
        t1, t2 = out[f"{mk}|W-1|tau 2020-24"]["clv_pts"], out[f"{mk}|W-2|tau 2020-24"]["clv_pts"]
        keep_s, keep_t = s2 / s1 if s1 > 0 else float("nan"), t2 / t1 if t1 > 0 else float("nan")
        verdict[mk] = {"sbr_w1": s1, "sbr_w2": s2, "sbr_kept": keep_s, "tau_w1": t1, "tau_w2": t2, "tau_kept": keep_t,
                       "timing_confounded": bool(keep_s < 0.5 and keep_t >= 0.5)}
        print(f"X-3 {mk}: SBR keeps {keep_s:.2f} of its CLV with W-2 inputs, tau keeps {keep_t:.2f} -> "
              f"{'TIMING-CONFOUNDED' if verdict[mk]['timing_confounded'] else 'not confounded by the rule'}")
    _save("X-2_X-3_line_source_and_timing", {"results": out, "x3_verdict": verdict, "sbr_qa": qa})
    return out, verdict


# ------------------------------------------------------------------ X-4/5
def tau_frame(seasons):
    """The other study's schedule features + this study's timestamped early-week
    lines (R-1) + its own opener-time base predictions."""
    from research.clv import nfl as N
    g = N.games()
    L = R.lines("nfl")
    L = L[L.season.isin(seasons) & L.game_id.isin(set(L.game_id[R.fresh_mask(L, "spread")]))]
    keep = ["game_id", "early_spread", "close_spread", "early_total", "close_total", "early_total_odds_over",
            "early_total_odds_under", "early_spread_odds_over", "early_spread_odds_under"]
    x = g.merge(L[keep], on="game_id", how="inner").rename(columns={
        "early_spread": "open_line", "close_spread": "close_line", "early_total": "open_total"})
    x = x[x.home_score.notna()].copy()
    x["margin"] = x.home_score - x.away_score
    x["total_pts"] = x.home_score + x.away_score
    x["result"] = x.margin
    for path, cols in ((N.LOOP_CACHE, {"pred_margin": "loop", "pred_total": "loop_total"}),
                       (N.V21_CACHE, {"model_margin": "v21", "model_total": "v21_total"})):
        p = pd.read_csv(path)
        x = x.merge(p[["game_id"] + list(cols)].rename(columns=cols), on="game_id", how="left")
    el = R.eligibility("nfl")
    x = x[x.game_id.map(el).fillna(False).astype(bool)]
    x["cluster"] = x.season.astype(str) + "-" + x.week.astype(str)
    return x


def _df_total(x, model):
    return pd.DataFrame({"game_id": x.game_id.astype(str).values, "season": x.season.astype(int).values,
                         "week": x.week.astype(int).values, "model": np.asarray(model, float),
                         "bet_line": x.open_total.astype(float).values, "close_line": x.close_total.astype(float).values,
                         "result": x.total_pts.astype(float).values,
                         "bet_odds_over": x.early_total_odds_over.astype(float).values,
                         "bet_odds_under": x.early_total_odds_under.astype(float).values}).dropna(subset=["model", "bet_line", "close_line"])


def x45():
    from research.clv import nfl as N
    m, _, _ = N.load()
    pre_m = m[m.season.isin(N.PRE)].copy()
    N.DISTS = N.dists(pre_m)
    seasons = [2021, 2022, 2023, 2024, 2025, 2026]
    x = tau_frame(seasons)
    # NFL-H4: the totals residual, one ridge fit on SBR 2011-19 (lambda by its inner walk-forward), frozen
    rx, log, cal = N.residual(x, ["v21_total", "loop_total"], False, "total", seasons, frozen_train=pre_m)
    h4 = _df_total(rx, rx.model_line)
    h4["game_id"] = rx.game_id.astype(str).values
    h2 = _df_total(x, x.v21_total)
    mine_pred = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21.csv")).set_index("game_id").model_total
    h3 = _df_total(x, x.game_id.astype(str).map(mine_pred))
    out = {"h4_fit": log}
    res = {}
    for part, ss in (("holdout 2025-26", [2025, 2026]), ("2021-24", [2021, 2022, 2023, 2024]), ("2021-26", seasons)):
        for name, df, thr in (("NFL-H4 residual", h4, 0.25), ("NFL-H2 v2.1.0 total", h2, 1.5), ("this study H-3", h3, 2.0)):
            d = df[df.season.isin(ss)].reset_index(drop=True)
            r = score(d, "total", thr, f"{name} on tau {part}")
            # ROI at -110 for comparison with SBR grading
            d110 = d.drop(columns=["bet_odds_over", "bet_odds_under"])
            r110 = score(d110, "total", thr, f"{name} on tau {part} @-110", n_perm=0)
            r["roi_at_minus110"], r["roi_at_minus110_ci95"] = r110["roi_at_bet_price"], r110["roi_ci95"]
            res[f"{name}|{part}"] = r
            print(f"{name:20} {part:16}", _line(r), f" ROI@-110 {100 * r110['roi_at_bet_price']:+.2f}% "
                  f"[{100 * r110['roi_ci95'][0]:+.2f},{100 * r110['roi_ci95'][1]:+.2f}]  ROI CI offered "
                  f"[{100 * r['roi_ci95'][0]:+.2f},{100 * r['roi_ci95'][1]:+.2f}]")
    # X-4 decision: holdout 2025-26, ROI at the offered price, one-sided alpha 0.05/2 -> lower end of the 95% CI
    x4 = {k: {"roi": res[f"{k}|holdout 2025-26"]["roi_at_bet_price"], "roi_ci95": res[f"{k}|holdout 2025-26"]["roi_ci95"],
              "beats_vig": bool(res[f"{k}|holdout 2025-26"]["roi_ci95"][0] > 0)} for k in ("NFL-H4 residual", "NFL-H2 v2.1.0 total")}
    print("X-4:", {k: (round(100 * v["roi"], 2), v["beats_vig"]) for k, v in x4.items()})
    # X-5: residual vs plain, matched volume, same games, 2021-26
    dist = R.distribution("nfl", "total")
    ids = set(h4.game_id) & set(h2.game_id) & set(h3.game_id)
    f = lambda d: d[d.game_id.isin(ids)].reset_index(drop=True)
    x5 = {"vs NFL-H2": H.compare_matched(f(h4), f(h2), 1.5, dist), "vs this study H-3": H.compare_matched(f(h4), f(h3), 2.0, dist)}
    for k, v in x5.items():
        print(f"X-5 residual {k}: cand {v['cand_clv_pts']:+.3f} vs comp {v['comp_clv_pts']:+.3f} (n {v['n_cand']}), "
              f"diff {v['diff']:+.3f} [{v['diff_ci95'][0]:+.3f},{v['diff_ci95'][1]:+.3f}] -> {'HELPS' if v['beats'] else 'does not help'}")
    out.update({"results": res, "x4": x4, "x5": x5, "movement_calibration": cal})
    _save("X-4_X-5_nfl_totals_on_timestamped_lines", out)
    return out


# -------------------------------------------------------------------- X-6
POWER = {"ACC", "Big Ten", "Big 12", "SEC", "Pac-12"}


def cfb_r2_frame():
    """This study's CFB lines (bet book open -> same-book close), with the other
    study's R2 inputs at week W-1 and at week W-2."""
    from research.clv import cfb as C
    L = R.lines("cfb")
    L = L[L.early_spread.notna() & L.close_spread.notna()]
    g = pd.read_parquet(os.path.join(R.ROOT, ".cache", "model_loop", "cfb", "build", "games.parquet"))
    g["game_id"] = g.game_id.astype(str)
    g = g.set_index("game_id")
    x = L.copy()
    x["game_id"] = x.game_id.astype(str)
    x["open_line"], x["close_line"] = x.early_spread, x.close_spread
    p4 = pd.read_csv(os.path.join(R.ROOT, "model_loop", "adapters", "cfb", "baselines", "cfb_p4_replay_predictions.csv.gz"))
    x["p4_w1"] = x.game_id.map(dict(zip(p4.game_id.astype(str), p4.fair_spread)))
    v2 = pd.read_csv(C.V2_CACHE)
    x["v2_w1"] = x.game_id.map(dict(zip(v2.game_id.astype(str), v2.pred_margin)))
    p4l = R.read_pred(os.path.join(R.CACHE, "pred_cfb_v1_lag1.csv"))
    x["p4_w2"] = x.game_id.map(dict(zip(p4l.game_id, p4l.model_spread)))
    v2l = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet"))
    x["v2_w2"] = x.game_id.map(dict(zip(v2l.game_id, v2l.model_spread)))
    conf_h, conf_a = x.game_id.map(g.home_conf), x.game_id.map(g.away_conf)
    name_h, name_a = x.game_id.map(g.home_name), x.game_id.map(g.away_name)
    pac = x.season >= 2024
    hp = (conf_h.isin(POWER) & ~(pac & conf_h.eq("Pac-12"))) | name_h.eq("Notre Dame")
    ap = (conf_a.isin(POWER) & ~(pac & conf_a.eq("Pac-12"))) | name_a.eq("Notre Dame")
    x["nonpower"] = (~hp & ~ap).astype(float)
    x["fcs"] = (x.home_div.ne("fbs") | x.away_div.ne("fbs")).astype(float)
    x["early"] = ((x.week <= 4) & x.season_type.eq("regular")).astype(float)
    el = R.eligibility("cfb")
    return x[x.game_id.map(el).fillna(False).astype(bool)].copy()


def _r2(x, tag, eval_seasons, frozen_train=None):
    from model_loop.clv import residual as RO
    y = x.copy()
    y["d_p4"] = y[f"p4_{tag}"] - y.open_line
    y["d_v2"] = y[f"v2_{tag}"] - y.open_line
    y["open_lvl"] = y.open_line
    y["d_early"] = y.d_p4 * y.early
    y["d_nonpower"] = y.d_p4 * y.nonpower
    y["d_fcs"] = y.d_p4 * y.fcs
    y["move"] = y.close_line - y.open_line
    feats = ["d_p4", "d_v2", "open_lvl", "d_early", "d_nonpower", "d_fcs"]
    y = y[y[feats].notna().all(axis=1) & y.move.notna()]
    if frozen_train is None:
        pred, log = RO.walk_forward(y, feats, "move", eval_seasons, min_train_seasons=3)
        y["pred_move"] = pred
    else:
        tr = y[y.season.isin(frozen_train)]
        lam = RO.choose_lambda(tr, feats, "move", [0.1, 1.0, 10.0, 100.0])
        mod = RO.ridge_fit(tr[feats], tr.move, lam)
        y = y[y.season.isin(eval_seasons)].copy()
        y["pred_move"] = RO.ridge_predict(mod, y[feats])
        log = {"lambda": lam, "coef": dict(zip(feats, map(float, mod["coef_raw"])))}
    y = y[y.pred_move.notna() & y.season.isin(eval_seasons)]
    df = pd.DataFrame({"game_id": y.game_id.values, "season": y.season.astype(int).values, "week": y.slate.astype(int).values,
                       "model": (y.open_line + y.pred_move).values, "bet_line": y.open_line.values,
                       "close_line": y.close_line.values, "result": y.result.values})
    return df, log


def x6():
    x = cfb_r2_frame()
    pre = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024]
    dev_eval = [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024]
    out = {}
    for tag in ("w1", "w2"):
        d, log = _r2(x[x.season.isin(pre)], tag, dev_eval)
        r = score(d, "spread", 0.25, f"CFB-R2 inputs {tag} dev", sport="cfb")
        out[f"dev|{tag}"] = {"result": r, "fit": log}
        print(f"CFB-R2 inputs {tag.upper()} dev 2015-19,21-24", _line(r), " edge" if R.edge_called(r) else "")
        d, log = _r2(x[x.season.isin(pre + [2025])], tag, [2025], frozen_train=pre)
        r = score(d, "spread", 0.25, f"CFB-R2 inputs {tag} 2025 frozen", sport="cfb")
        out[f"2025|{tag}"] = {"result": r, "fit": log}
        print(f"CFB-R2 inputs {tag.upper()} 2025 (frozen)  ", _line(r))
    w1, w2 = out["dev|w1"]["result"], out["dev|w2"]["result"]
    kept = w2["clv_pts"] / w1["clv_pts"] if w1["clv_pts"] > 0 else float("nan")
    robust = bool(R.edge_called(w2) and kept >= 0.5)
    print(f"X-6: W-2 keeps {kept:.2f} of the W-1 CLV; W-2 edge rule {'passes' if R.edge_called(w2) else 'fails'} -> "
          f"{'TIMING-ROBUST' if robust else 'NOT timing-robust'}")
    out["x6"] = {"kept": kept, "w2_edge": R.edge_called(w2), "timing_robust": robust}
    _save("X-6_cfb_residual_timing", out)
    return out


if __name__ == "__main__":
    {"x1": x1, "x23": x23, "x45": x45, "x6": x6}[sys.argv[1]]()
