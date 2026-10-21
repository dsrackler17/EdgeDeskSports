"""NBA: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section NBA).

  python3 -m research.clv.nba check      # join quality only
  python3 -m research.clv.nba pre        # every pre-holdout experiment
  python3 -m research.clv.nba holdout    # Phase 6, once

Seasons use the repo's end-year labels (SBR 2011 = repo 2012).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import residual as R
from model_loop.clv import sources as S
from research.clv import runner

SPORT = "nba"
PRE = list(range(2012, 2023))
LAB = os.path.join(S.CACHE, "bb_nba.csv")
PROD = os.path.join(S.CACHE, "nba_prod.csv")

# SBR names -> ESPN team ids (nba/data/teams.json); "Hornets" is New Orleans
# before 2014-15 and Charlotte after, so both are tried and the schedule decides
SBR = {"Hawks": [1], "Celtics": [2], "Pelicans": [3], "Hornets": [3, 30], "Bulls": [4], "Cavaliers": [5], "Mavericks": [6],
       "Nuggets": [7], "Pistons": [8], "Golden State": [9], "Warriors": [9], "Rockets": [10], "Pacers": [11],
       "Clippers": [12], "LA Clippers": [12], "Lakers": [13], "Heat": [14], "Bucks": [15], "Timberwolves": [16],
       "Nets": [17], "NewJersey": [17], "Knicks": [18], "Magic": [19], "Seventysixers": [20], "Suns": [21],
       "Trailblazers": [22], "Kings": [23], "Spurs": [24], "Oklahoma City": [25], "Thunder": [25], "Jazz": [26],
       "Wizards": [27], "Raptors": [28], "Grizzlies": [29], "Bobcats": [30], "Charlotte": [30]}


def schedule():
    g = pd.concat([pd.read_csv(os.path.join(S.ROOT, "nba", "data", "games", f"{y}.csv")) for y in range(2012, 2028)],
                  ignore_index=True)
    g = g[g.status.astype(str).str.upper().eq("FINAL")].copy()
    g["date"] = pd.to_datetime(g.date)
    g = g.sort_values(["start_utc", "game_id"]).reset_index(drop=True)
    # schedule features known at the open: back-to-backs and games played
    last, gp, b2b_h, b2b_a, gp_h, gp_a = {}, {}, [], [], [], []
    for r in g.itertuples(index=False):
        t = pd.Timestamp(r.start_utc)
        for team, out_b, out_g in ((r.home_id, b2b_h, gp_h), (r.away_id, b2b_a, gp_a)):
            key = (team, r.season)
            l = last.get(team)
            out_b.append(float(l is not None and (t - l).total_seconds() <= 30 * 3600))
            out_g.append(gp.get(key, 0))
        for team in (r.home_id, r.away_id):
            last[team] = t
            gp[(team, r.season)] = gp.get((team, r.season), 0) + 1
    g["b2b_h"], g["b2b_a"], g["gp_h"], g["gp_a"] = b2b_h, b2b_a, gp_h, gp_a
    g["b2b_diff"] = g.b2b_h - g.b2b_a
    g["b2b_one"] = ((g.b2b_h + g.b2b_a) == 1).astype(float)
    g["early"] = ((g.gp_h < 15) | (g.gp_a < 15)).astype(float)
    g["margin"] = g.hs - g["as"]
    g["total_pts"] = g.hs + g["as"]
    g["result"] = g.margin
    g["cluster"] = g.date.dt.strftime("%Y-%m-%d")
    return g


def sbr_lines(g):
    d, qa = S.sbr("nba")
    rows = []
    for r in d.itertuples(index=False):
        hs, as_ = SBR.get(str(r.home_team), []), SBR.get(str(r.away_team), [])
        for h in hs:
            for a in as_:
                rows.append({"date_sbr": r.date, "home_id": h, "away_id": a, "hs": r.home_score, "as": r.away_score,
                             "open_line": r.open_line, "close_line": r.close_line, "open_total": r.open_total,
                             "close_total": r.close_total})
    x = pd.DataFrame(rows)
    # the scraper files some games under the wrong year (the 2020 bubble under
    # 2019, January-March 2021 under 2020): every row is also tried one year on;
    # teams, date (+-1 day) and the final score must all agree
    x["sbr_row"] = np.arange(len(x))
    x = pd.concat([x.assign(shifted=0), x.assign(date_sbr=x.date_sbr + pd.DateOffset(years=1), shifted=1)], ignore_index=True)
    m = g.merge(x, on=["home_id", "away_id", "hs", "as"], how="inner")
    m = m[(m.date - m.date_sbr).abs() <= pd.Timedelta(days=1)]
    m = m[m.season <= 2022].sort_values("shifted").drop_duplicates("sbr_row").drop_duplicates("game_id")
    qa["joined"] = int(len(m))
    qa["unmapped"] = sorted({str(t) for t in set(d.home_team) | set(d.away_team) if str(t) not in SBR})
    return m, qa


def models(m):
    lab = pd.read_csv(LAB)[["game_id", "model_margin", "model_total"]].rename(columns={"model_margin": "lab", "model_total": "lab_total"})
    m = m.merge(lab, on="game_id", how="left")
    if os.path.exists(PROD) and prod_reproduced():
        p = pd.read_csv(PROD)[["game_id", "model_margin", "model_total", "p_home", "adj_proj"]].rename(
            columns={"model_margin": "prod", "model_total": "prod_total", "p_home": "prod_p"})
        m = m.merge(p, on="game_id", how="left")
    return m


def prod_reproduced(tol=1e-4):
    """The pre-registered gate on the production replay: its selection-window
    moneyline log loss must equal the committed record's."""
    try:
        chk = json.load(open(PROD + ".check.json"))["check"]["G_stack_P"]["selection_ll"]
        rec = json.load(open(os.path.join(S.ROOT, "nba", "validation", "nba_walkforward.json")))
        com = rec["choice"]["P"]["selection_ml_log_loss"]["G_stack_P"]
        return abs(chk - com) <= tol
    except (OSError, KeyError, ValueError):
        return False


def load():
    g = schedule()
    m, qa = sbr_lines(g)
    return models(m), qa


SIG = {}


def cfg(market, thr, kind="base"):
    th = (thr, 0.5, 1.0, 2.0, 3.0) if kind == "base" else (thr, 0.5, 1.0)
    bk = (0, 1, 2, 3, 5, H.INF) if kind == "base" else (0, 0.25, 0.5, 1, H.INF)
    return H.HarnessConfig(kind="points", market=market, thresholds=tuple(dict.fromkeys(th)), primary=thr,
                           dist=H.IntegerNormal(SIG[market]), buckets=bk)


def sigmas(m):
    x = m[m.season.isin(PRE)]
    SIG["spread"] = float((x.margin - x.close_line).std())
    SIG["total"] = float((x.total_pts - x.close_total).std())


def frame(m, col, market="spread"):
    x = m.copy()
    if market == "total":
        x["open_line"], x["close_line"], x["result"] = x.open_total, x.close_total, x.total_pts
    x["model_line"] = x[col]
    return x


def _features(m, base_cols, extra, market):
    x = frame(m, base_cols[0], market)
    feats = []
    for c in base_cols:
        x[f"d_{c}"] = x[c] - x.open_line
        feats.append(f"d_{c}")
    if extra:
        x["open_lvl"] = x.open_line
        x["d_early"] = x["d_lab"] * x.early
        feats += ["open_lvl", "b2b_diff", "d_early"]
    x["move"] = x.close_line - x.open_line
    return x[x[feats].notna().all(axis=1) & x.move.notna()], feats


def residual(m, base_cols, extra, market, seasons, frozen_train=None):
    x, feats = _features(m, base_cols, extra, market)
    if frozen_train is None:
        x = x[x.season.isin(seasons)]
        pred, log = R.walk_forward(x, feats, "move", seasons, min_train_seasons=3)
        x = x.assign(pred_move=pred)
    else:
        tr, _ = _features(frozen_train, base_cols, extra, market)
        tr = tr[tr.season.isin(PRE)]
        lam = R.choose_lambda(tr, feats, "move", [0.1, 1.0, 10.0, 100.0])
        mod = R.ridge_fit(tr[feats], tr.move, lam)
        x = x[x.season.isin(seasons)].copy()
        x["pred_move"] = R.ridge_predict(mod, x[feats])
        log = {"lambda": lam, "n_train": int(len(tr)), "coef": {f: round(float(c), 5) for f, c in zip(feats, mod["coef_raw"])},
               "intercept": round(float(mod["intercept_raw"]), 5)}
    x = x[x.pred_move.notna()].copy()
    x["model_line"] = x.open_line + x.pred_move
    return x, log, H.movement_calibration(x.pred_move, x.move)


def pre():
    m, qa = load()
    m = m[m.season.isin(PRE)].copy()
    sigmas(m)
    have_prod = "prod" in m and m["prod"].notna().any()
    out = {"qa": qa, "have_prod": bool(have_prod)}
    runs = []
    if have_prod:
        runs += [("NBA-B1", "prod", "spread", 1.0, "production G_stack_P spread"),
                 ("NBA-B2", "prod_total", "total", 2.0, "production G_stack_P total")]
    runs += [("NBA-B3", "lab", "spread", 1.0, "lab points_rest spread"), ("NBA-B4", "lab_total", "total", 2.0, "lab points_rest total")]
    for eid, col, mk, thr, label in runs:
        rep = runner.run(SPORT, eid, frame(m, col, mk), cfg(mk, thr), label)
        out[eid] = runner.fmt(rep)
        print(eid, out[eid])
    base = ["prod", "lab"] if have_prod else ["lab"]
    res = {}
    for eid, extra, label in (("NBA-R1", False, f"residual ridge on {base} (spread)"), ("NBA-R2", True, "R1 + information block")):
        x, log, cal = residual(m, base, extra, "spread", PRE)
        rep = runner.run(SPORT, eid, x, cfg("spread", 0.25, "resid"), label, extra={"fit_log": log, "movement_calibration": cal})
        res[eid] = x
        out[eid] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
        print(eid, out[eid])
    common = set(res["NBA-R1"].game_id) & set(res["NBA-R2"].game_id)
    c = cfg("spread", 0.25, "resid")
    b1 = H.bet_table(res["NBA-R1"][res["NBA-R1"].game_id.isin(common)], c, 0.25)
    b2 = H.bet_table(res["NBA-R2"][res["NBA-R2"].game_id.isin(common)], c, 0.25)
    out["R2_vs_R1_same_games"] = {"pool": len(common), "r1": [len(b1), round(100 * b1.clv_prob.mean(), 3)],
                                  "r2": [len(b2), round(100 * b2.clv_prob.mean(), 3)]}
    print("R2 vs R1", out["R2_vs_R1_same_games"])
    if have_prod:
        x = frame(m, "prod", "spread")
        x = x[x.adj_proj.abs() >= 2]
        rep = runner.run(SPORT, "NBA-W1", x, cfg("spread", 1.0), "B1 on games with |projected availability adj| >= 2")
        out["NBA-W1"] = runner.fmt(rep)
        print("NBA-W1", out["NBA-W1"])
    x = res["NBA-R1"]
    rep = runner.run(SPORT, "NBA-W2", x[x.b2b_one == 1], cfg("spread", 0.25, "resid"), "R1 on games with exactly one team on a back-to-back")
    out["NBA-W2"] = runner.fmt(rep)
    print("NBA-W2", out["NBA-W2"])
    tb = ["prod_total", "lab_total"] if have_prod else ["lab_total"]
    x, log, cal = residual(m, tb, False, "total", PRE)
    rep = runner.run(SPORT, "NBA-W3", x, cfg("total", 0.25, "resid"), f"totals residual on {tb}",
                     extra={"fit_log": log, "movement_calibration": cal})
    out["NBA-W3"] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
    print("NBA-W3", out["NBA-W3"])
    x = frame(m, "lab", "spread")
    rep = runner.run(SPORT, "NBA-W4", x[x.early == 1], cfg("spread", 1.0), "B3 on early-season games")
    out["NBA-W4"] = runner.fmt(rep)
    print("NBA-W4", out["NBA-W4"])
    return out


# ------------------------------------------------------------- Phase 6
def holdout_frame():
    """ESPN DraftKings open/close for the holdout seasons, with the schedule features."""
    g = schedule()
    lines, qa = S.espn_lines("nba", "nba")
    h = g[g.season.isin([2026, 2027])].merge(lines.drop(columns=["start"], errors="ignore"), on="game_id", how="inner")
    return models(h), qa


def holdout(spec):
    """spec: [(exp_id, kind, market, col_or_residual, threshold, label)] exactly as EXPERIMENTS.md NBA-H selects."""
    m, _ = load()
    pre_m = m[m.season.isin(PRE)].copy()
    sigmas(pre_m)
    h, qa = holdout_frame()
    k = runner.k_sport(SPORT) + len(spec)
    out = {"qa": qa, "k": k}
    for eid, kind, mk, src, thr, label in spec:
        extra = {}
        if kind == "price":
            x = h.rename(columns={"open_ml_home": "open_a", "open_ml_away": "open_b", "close_ml_home": "close_a",
                                  "close_ml_away": "close_b"}).copy()
            x["model_prob"] = x[src]
            x["result"] = (x.margin > 0).astype(float)
            c = H.HarnessConfig(kind="price", market="moneyline", thresholds=(thr, 0.01, 0.05), primary=thr,
                                buckets=(0, 0.02, 0.04, 0.06, 0.1, 1))
        elif isinstance(src, tuple):
            base, extra_block = src
            both = pd.concat([pre_m, h], ignore_index=True)
            x, log, cal = residual(both, base, extra_block, mk, sorted(h.season.unique()), frozen_train=pre_m)
            extra = {"fit": log, "movement_calibration": cal}
            if mk == "total":
                x["open_price_a"], x["open_price_b"] = x.open_over_odds, x.open_under_odds
                x["close_price_a"], x["close_price_b"] = x.close_over_odds, x.close_under_odds
            c = cfg(mk, thr, "resid")
        else:
            x = frame(h, src, mk)
            if mk == "total":
                x["open_price_a"], x["open_price_b"] = x.open_over_odds, x.open_under_odds
                x["close_price_a"], x["close_price_b"] = x.close_over_odds, x.close_under_odds
            c = cfg(mk, thr)
        rep = runner.run(SPORT, eid, x, c, label, holdout=True, k_tests=k, extra=extra)
        out[eid] = {"result": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k),
                    "clv_ev": rep["primary"].get("clv_ev", {}).get("mean"),
                    "by_season": {s["season"]: f"n={s['n_bets']} {100 * s['clv_prob']['mean']:+.2f} pp" for s in rep["by_season"]}}
        print(eid, json.dumps(out[eid], default=str))
    with open(os.path.join(runner.RESULTS, SPORT, "holdout_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "check":
        m, qa = load()
        print(json.dumps(qa, indent=1, default=str))
        x = m[m.season.isin(PRE)]
        print(x.groupby("season").size().to_dict())
        ok = x.open_line.notna() & x.close_line.notna()
        print("with lines", int(ok.sum()), "lab", int((ok & x.lab.notna()).sum()),
              "corr(lab, close)", round(float(np.corrcoef(x.lab[ok & x.lab.notna()], x.close_line[ok & x.lab.notna()])[0, 1]), 3))
    elif cmd == "pre":
        print(json.dumps(pre(), indent=1, default=str))
