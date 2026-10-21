"""NHL: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section NHL).

  python3 -m research.clv.nhl check
  python3 -m research.clv.nhl pre
  python3 -m research.clv.nhl holdout

Predictions: .cache/clv/nhl_preds.jsonl, the unmodified hockey walk-forward's
per-game output (run in a scratch worktree). Seasons are repo end-year labels.
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

SPORT = "nhl"
PRE = list(range(2014, 2021))
PROXY = [2021, 2022]
PREDS = os.path.join(S.CACHE, "nhl_preds.jsonl")

SBR = {"Ducks": ["ANA"], "Arizonas": ["ARI", "PHX", "UTA"], "Coyotes": ["ARI", "PHX"], "Phoenix": ["PHX", "ARI"],
       "Bruins": ["BOS"], "Sabres": ["BUF"], "Hurricanes": ["CAR"], "Blue Jackets": ["CBJ"], "Flames": ["CGY"],
       "Blackhawks": ["CHI"], "Avalanche": ["COL"], "Stars": ["DAL"], "Red Wings": ["DET"], "Oilers": ["EDM"],
       "Panthers": ["FLA"], "Kings": ["LAK"], "Wild": ["MIN"], "Canadiens": ["MTL"], "Devils": ["NJD"],
       "Predators": ["NSH"], "Islanders": ["NYI"], "NY Islanders": ["NYI"], "Rangers": ["NYR"], "Senators": ["OTT"],
       "Flyers": ["PHI"], "Penguins": ["PIT"], "Kraken": ["SEA"], "SeattleKraken": ["SEA"], "Sharks": ["SJS"],
       "St.Louis": ["STL"], "Lightning": ["TBL"], "Tampa": ["TBL"], "Tampa Bay": ["TBL"], "Maple Leafs": ["TOR"],
       "Canucks": ["VAN"], "Golden Knights": ["VGK"], "Jets": ["WPG"], "WinnipegJets": ["WPG"], "Capitals": ["WSH"]}


def preds():
    rows = []
    with open(PREDS) as f:
        for l in f:
            r = json.loads(l)
            p = r["p"]
            rows.append({"game_id": r["game_id"], "season": r["season"], "type": r["type"], "date": r["date"],
                         "home": r["home"], "away": r["away"],
                         "p_core": p["xg_core"]["ml"], "p_gproj": p["xg_goalie_projected"]["ml"],
                         "t_core": p["xg_core"]["exp_total"], "t_gproj": p["xg_goalie_projected"]["exp_total"],
                         "hw": r["y"]["hw"], "margin": r["y"]["margin"], "total_pts": r["y"]["total"]})
    g = pd.DataFrame(rows)
    g["date"] = pd.to_datetime(g.date)
    g = g.sort_values(["date", "game_id"]).reset_index(drop=True)
    last, gp, b2b, early = {}, {}, {"h": [], "a": []}, []
    for r in g.itertuples(index=False):
        e = 0
        for side, team in (("h", r.home), ("a", r.away)):
            l = last.get(team)
            b2b[side].append(float(l is not None and (r.date - l).days == 1))
            e = max(e, int(gp.get((team, r.season), 0) < 10))
        early.append(float(e))
        for team in (r.home, r.away):
            last[team] = r.date
            gp[(team, r.season)] = gp.get((team, r.season), 0) + 1
    g["b2b_diff"] = np.array(b2b["h"]) - np.array(b2b["a"])
    g["b2b_one"] = ((np.array(b2b["h"]) + np.array(b2b["a"])) == 1).astype(float)
    g["early"] = early
    g["cluster"] = g.date.dt.strftime("%Y-%m-%d")
    return g


def load():
    g = preds()
    d, qa = S.sbr("nhl")
    rows = []
    for r in d.itertuples(index=False):
        for h in SBR.get(str(r.home_team), []):
            for a in SBR.get(str(r.away_team), []):
                rows.append({"date_sbr": r.date, "home": h, "away": a, "sbr_margin": r.margin, "sbr_total": r.total_pts,
                             "open_ml_home": r.open_ml_home, "open_ml_away": r.open_ml_away,
                             "close_ml_home": r.close_ml_home, "close_ml_away": r.close_ml_away,
                             "open_total": r.open_total, "close_total": r.close_total})
    x = pd.DataFrame(rows)
    # the scraper files some games under the wrong year (the 2020 bubble under
    # 2019, January-March 2021 under 2020): every row is also tried one year on;
    # teams, date (+-1 day) and the final score must all agree
    x["sbr_row"] = np.arange(len(x))
    x = pd.concat([x.assign(shifted=0), x.assign(date_sbr=x.date_sbr + pd.DateOffset(years=1), shifted=1)], ignore_index=True)
    m = g.merge(x, on=["home", "away"], how="inner")
    m = m[((m.date - m.date_sbr).abs() <= pd.Timedelta(days=1)) & (m.sbr_total == m.total_pts)]
    # SBR finals can differ from the record by the shootout goal; the winner must agree
    m = m[np.sign(m.sbr_margin) == np.sign(m.margin)]
    # one archive row is one game: the unshifted match wins, and nothing past the archive's last season
    m = m[m.season <= 2022].sort_values("shifted").drop_duplicates("sbr_row").drop_duplicates("game_id")
    qa["joined"] = int(len(m))
    qa["unmapped"] = sorted({str(t) for t in set(d.home_team) | set(d.away_team) if str(t) not in SBR})
    po = H.no_vig(m.open_ml_home, m.open_ml_away)
    pc = H.no_vig(m.close_ml_home, m.close_ml_away)
    m["p_open"], m["p_close"] = po, pc
    return m, qa


def price_frame(m, prob_col):
    x = m.rename(columns={"open_ml_home": "open_a", "open_ml_away": "open_b", "close_ml_home": "close_a",
                          "close_ml_away": "close_b"}).copy()
    x["model_prob"] = x[prob_col]
    x["result"] = x.hw.astype(float)
    return x


def total_frame(m, col):
    x = m.copy()
    x["open_line"], x["close_line"], x["result"], x["model_line"] = x.open_total, x.close_total, x.total_pts, x[col]
    return x


SIG = {}


def cfg_price(thr, kind="base"):
    th = (thr, 0.01, 0.03, 0.05) if kind == "base" else (thr, 0.01, 0.02)
    bk = (0, 0.02, 0.04, 0.06, 0.1, 1) if kind == "base" else (0, 0.005, 0.01, 0.02, 1)
    return H.HarnessConfig(kind="price", market="moneyline", thresholds=tuple(dict.fromkeys(th)), primary=thr, buckets=bk)


def cfg_total(thr, kind="base"):
    th = (thr, 0.5) if kind == "base" else (thr, 0.1, 0.25)
    bk = (0, 0.15, 0.3, 0.5, H.INF) if kind == "base" else (0, 0.05, 0.1, 0.25, H.INF)
    return H.HarnessConfig(kind="points", market="total", thresholds=tuple(dict.fromkeys(th)), primary=thr,
                           dist=H.IntegerNormal(SIG["total"]), buckets=bk)


def _features_ml(m, base, extra):
    x = price_frame(m, base[0])
    feats = []
    for c in base:
        x[f"d_{c}"] = x[c] - x.p_open
        feats.append(f"d_{c}")
    if extra:
        x["fav"] = x.p_open - 0.5
        x["d_early"] = x[f"d_{base[0]}"] * x.early
        feats += ["fav", "b2b_diff", "d_early"]
    x["move"] = x.p_close - x.p_open
    return x[x[feats].notna().all(axis=1) & x.move.notna()], feats


def _features_tot(m, base):
    x = total_frame(m, base[0])
    feats = []
    for c in base:
        x[f"d_{c}"] = x[c] - x.open_total
        feats.append(f"d_{c}")
    x["move"] = x.close_total - x.open_total
    return x[x[feats].notna().all(axis=1) & x.move.notna()], feats


def residual(m, featfn, seasons, frozen_train=None, market="moneyline"):
    x, feats = featfn(m)
    if frozen_train is None:
        x = x[x.season.isin(seasons)]
        pred, log = R.walk_forward(x, feats, "move", seasons, min_train_seasons=3)
        x = x.assign(pred_move=pred)
    else:
        tr, _ = featfn(frozen_train)
        tr = tr[tr.season.isin(PRE)]
        lam = R.choose_lambda(tr, feats, "move", [0.1, 1.0, 10.0, 100.0])
        mod = R.ridge_fit(tr[feats], tr.move, lam)
        x = x[x.season.isin(seasons)].copy()
        x["pred_move"] = R.ridge_predict(mod, x[feats])
        log = {"lambda": lam, "n_train": int(len(tr)), "coef": {f: round(float(c), 6) for f, c in zip(feats, mod["coef_raw"])},
               "intercept": round(float(mod["intercept_raw"]), 6)}
    x = x[x.pred_move.notna()].copy()
    if market == "moneyline":
        x["model_prob"] = x.p_open + x.pred_move
    else:
        x["model_line"] = x.open_line + x.pred_move
    return x, log, H.movement_calibration(x.pred_move, x.move)


def pre():
    m, qa = load()
    m = m[m.season.isin(PRE)].copy()
    SIG["total"] = float((m.total_pts - m.close_total).std())
    out = {"qa": qa}
    for eid, frame, c, label in (("NHL-B1", price_frame(m, "p_core"), cfg_price(0.02), "production xg_core moneyline"),
                                 ("NHL-B2", total_frame(m, "t_core"), cfg_total(0.30), "production xg_core total (line only)"),
                                 ("NHL-B3", price_frame(m, "p_gproj"), cfg_price(0.02), "xg_goalie_projected moneyline")):
        rep = runner.run(SPORT, eid, frame, c, label)
        out[eid] = runner.fmt(rep)
        print(eid, out[eid])
    res = {}
    for eid, extra, label in (("NHL-R1", False, "ML residual on d_core, d_gproj"), ("NHL-R2", True, "R1 + information block")):
        x, log, cal = residual(m, lambda mm, e=extra: _features_ml(mm, ["p_core", "p_gproj"], e), PRE)
        rep = runner.run(SPORT, eid, x, cfg_price(0.005, "resid"), label, extra={"fit_log": log, "movement_calibration": cal})
        res[eid] = x
        out[eid] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
        print(eid, out[eid])
    common = set(res["NHL-R1"].game_id) & set(res["NHL-R2"].game_id)
    c = cfg_price(0.005, "resid")
    b1 = H.bet_table(res["NHL-R1"][res["NHL-R1"].game_id.isin(common)], c, 0.005)
    b2 = H.bet_table(res["NHL-R2"][res["NHL-R2"].game_id.isin(common)], c, 0.005)
    out["R2_vs_R1_same_games"] = {"pool": len(common), "r1": [len(b1), round(100 * b1.clv_prob.mean(), 3)],
                                  "r2": [len(b2), round(100 * b2.clv_prob.mean(), 3)]}
    print("R2 vs R1", out["R2_vs_R1_same_games"])
    x = price_frame(m, "p_gproj")
    x = x[(x.p_gproj - x.p_core).abs() >= 0.02]
    rep = runner.run(SPORT, "NHL-W1", x, cfg_price(0.02), "B3 on games where the projected goalie moves the price >= 0.02")
    out["NHL-W1"] = runner.fmt(rep)
    print("NHL-W1", out["NHL-W1"])
    x = res["NHL-R1"]
    rep = runner.run(SPORT, "NHL-W2", x[x.b2b_one == 1], cfg_price(0.005, "resid"), "R1 on one-team back-to-backs")
    out["NHL-W2"] = runner.fmt(rep)
    print("NHL-W2", out["NHL-W2"])
    x, log, cal = residual(m, lambda mm: _features_tot(mm, ["t_core", "t_gproj"]), PRE, market="total")
    rep = runner.run(SPORT, "NHL-W3", x, cfg_total(0.05, "resid"), "totals residual (line only)",
                     extra={"fit_log": log, "movement_calibration": cal})
    out["NHL-W3"] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
    print("NHL-W3", out["NHL-W3"])
    return out


def holdout():
    m, qa = load()
    pre_m = m[m.season.isin(PRE)].copy()
    proxy = m[m.season.isin(PROXY)].copy()
    SIG["total"] = float((pre_m.total_pts - pre_m.close_total).std())
    k = 12
    out = {}
    both = pd.concat([pre_m, proxy], ignore_index=True)
    x2, log2, cal2 = residual(both, lambda mm: _features_ml(mm, ["p_core", "p_gproj"], False), PROXY, frozen_train=pre_m)
    x4, log4, cal4 = residual(both, lambda mm: _features_tot(mm, ["t_core", "t_gproj"]), PROXY, frozen_train=pre_m, market="total")
    specs = [("NHL-H1", price_frame(proxy, "p_core"), cfg_price(0.02), "production xg_core ML (proxy)", {}),
             ("NHL-H2", total_frame(proxy, "t_core"), cfg_total(0.30), "production xg_core total line (proxy)", {}),
             ("NHL-H3", x2[x2.b2b_one == 1], cfg_price(0.005, "resid"), "NHL-W2: R1 frozen on back-to-backs (proxy)",
              {"fit": log2, "movement_calibration": cal2}),
             ("NHL-H4", x4, cfg_total(0.05, "resid"), "NHL-W3 frozen totals (proxy)", {"fit": log4, "movement_calibration": cal4})]
    for eid, x, c, label, extra in specs:
        rep = runner.run(SPORT, eid, x, c, label, holdout=True, k_tests=k, extra=extra)
        out[eid] = {"proxy": runner.fmt(rep), "verdict": H.verdict(rep["primary"], k),
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
        print(m.groupby("season").size().to_dict())
        ok = m.p_open.notna() & m.p_close.notna()
        print("ml open+close", int(ok.sum()), "corr(p_core, p_close)", round(float(np.corrcoef(m.p_core[ok], m.p_close[ok])[0, 1]), 3))
    elif cmd == "pre":
        print(json.dumps(pre(), indent=1, default=str))
    elif cmd == "holdout":
        holdout()
