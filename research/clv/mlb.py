"""MLB: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section MLB).

  python3 -m research.clv.mlb check | pre | holdout
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

SPORT = "mlb"
PRE = list(range(2012, 2020))
PROXY = [2020, 2021]
LAB = os.path.join(S.CACHE, "mlb_lab.csv")
SBR = {"Angels": "ANA", "Astros": "HOU", "Athletics": "OAK", "BRS": "BOS", "Red Sox": "BOS", "Blue Jays": "TOR",
       "Braves": "ATL", "Brewers": "MIL", "CUB": "CHN", "Cubs": "CHN", "Cardinals": "SLN", "Diamondbacks": "ARI",
       "Dodgers": "LAN", "LOS": "LAN", "Indians": "CLE", "KAN": "KCA", "Mariners": "SEA", "Marlins": "MIA",
       "Mets": "NYN", "Nationals": "WAS", "Orioles": "BAL", "Phillies": "PHI", "Pirates": "PIT", "Rangers": "TEX",
       "Reds": "CIN", "Rockies": "COL", "SDG": "SDN", "SFG": "SFN", "SFO": "SFN", "TAM": "TBA", "Tigers": "DET",
       "Twins": "MIN", "White Sox": "CHA", "Yankees": "NYA"}


def lab():
    g = pd.read_csv(LAB, dtype={"proj_sp_home": str, "proj_sp_away": str})
    g["date"] = pd.to_datetime(g.date)
    g = g.sort_values(["date", "game_id"]).reset_index(drop=True)
    gp, early = {}, []
    for r in g.itertuples(index=False):
        early.append(float(gp.get((r.home, r.season), 0) < 20 or gp.get((r.away, r.season), 0) < 20))
        for t in (r.home, r.away):
            gp[(t, r.season)] = gp.get((t, r.season), 0) + 1
    g["early"] = early
    g["rotation_unknown"] = g.proj_sp_home.isna().astype(float) + g.proj_sp_away.isna().astype(float)
    g["hw"] = (g.hs > g["as"]).astype(float)
    g["margin"] = g.hs - g["as"]
    g["total_pts"] = g.hs + g["as"]
    g["cluster"] = g.date.dt.strftime("%Y-%m-%d")
    return g


def load():
    """SBR MLB, repaired. The scraper pairs each record's home side with the
    NEXT game's away side (on every game: no game has both sides in one
    record), which is why ~40% of its moneyline pairs looked impossible. Each
    record is split into its two team rows and every row is matched to its
    Retrosheet game by exact date, team and runs scored; a game takes its
    home prices from the home team's row and its away prices from the away
    team's row. Games with an ambiguous or missing match are dropped. The
    repaired pairs pass the overround check 99.9% of the time (median 1.038).
    Totals cannot be attributed to games (closing total vs runs scored:
    correlation 0.155 at the best alignment) and are not used."""
    g = lab()
    d, qa = S.sbr("mlb")
    raw = pd.read_json(os.path.join(S.RAW, "sbr_mlb_archive_10Y.json"))
    raw["date"] = pd.to_datetime(raw.date.astype("Int64").astype(str), format="%Y%m%d", errors="coerce")
    num = lambda c: pd.to_numeric(raw[c], errors="coerce")
    rows = []
    for side in ("home", "away"):
        rows.append(pd.DataFrame({"date": raw.date, "team": raw[f"{side}_team"].map(SBR), "runs": num(f"{side}_final"),
                                  "o": num(f"{side}_open_ml"), "c": num(f"{side}_close_ml"), "rec": np.arange(len(raw))}))
    tr = pd.concat(rows, ignore_index=True)
    tr = tr[tr.team.notna()]
    h = g.merge(tr.rename(columns={"team": "home", "runs": "hs", "o": "open_ml_home", "c": "close_ml_home", "rec": "rec_h"}),
                on=["home", "hs", "date"])
    a = h.merge(tr.rename(columns={"team": "away", "runs": "as", "o": "open_ml_away", "c": "close_ml_away", "rec": "rec_a"}),
                on=["away", "as", "date"])
    cnt = a.groupby("game_id").size()
    qa["repair"] = {"games_in_scope": int((g.season <= 2021).sum()), "matched_unique": int((cnt == 1).sum()),
                    "ambiguous": int((cnt > 1).sum()),
                    "home_from_next_record": float(((a.rec_h - a.rec_a) == 1).mean())}
    m = a[a.game_id.isin(cnt[cnt == 1].index)].copy()
    ok = S.ml_ok(m.open_ml_home, m.open_ml_away) & S.ml_ok(m.close_ml_home, m.close_ml_away)
    qa["repair"]["overround_ok"] = float(ok.mean())
    m = m[ok].copy()
    qa["joined"] = int(len(m))
    m["p_open"] = H.no_vig(m.open_ml_home, m.open_ml_away)
    m["p_close"] = H.no_vig(m.close_ml_home, m.close_ml_away)
    return m, qa


def price_frame(m, col):
    x = m.rename(columns={"open_ml_home": "open_a", "open_ml_away": "open_b", "close_ml_home": "close_a",
                          "close_ml_away": "close_b"}).copy()
    x["model_prob"] = x[col]
    x["result"] = x.hw
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
    th = (thr, 1.0) if kind == "base" else (thr, 0.1, 0.25)
    bk = (0, 0.25, 0.5, 1, H.INF) if kind == "base" else (0, 0.05, 0.1, 0.25, H.INF)
    return H.HarnessConfig(kind="points", market="total", thresholds=tuple(dict.fromkeys(th)), primary=thr,
                           dist=H.IntegerNormal(SIG["total"]), buckets=bk)


def _feat_ml(m, extra):
    x = price_frame(m, "p_proj")
    x["d_proj"], x["d_tp"] = x.p_proj - x.p_open, x.p_team_park - x.p_open
    feats = ["d_proj", "d_tp"]
    if extra:
        x["fav"] = x.p_open - 0.5
        x["d_early"] = x.d_proj * x.early
        feats += ["fav", "d_early", "rotation_unknown"]
    x["move"] = x.p_close - x.p_open
    ok = x[feats].notna().all(axis=1) & x.move.notna() & H.valid_american(x.open_a) & H.valid_american(x.close_a)
    return x[ok], feats


def _feat_tot(m):
    x = total_frame(m, "total_proj")
    x["dt_proj"], x["dt_tp"] = x.total_proj - x.open_total, x.total_team_park - x.open_total
    x["move"] = x.close_total - x.open_total
    feats = ["dt_proj", "dt_tp"]
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
    out = {"qa": qa}
    for eid, frame, c, label in (("MLB-B1", price_frame(m, "p_proj"), cfg_price(0.02), "lab, projected starter, ML"),
                                 ("MLB-B2", price_frame(m, "p_team_park"), cfg_price(0.02), "lab team_park (no starter), ML")):
        rep = runner.run(SPORT, eid, frame, c, label)
        out[eid] = runner.fmt(rep)
        print(eid, out[eid])
    res = {}
    for eid, extra in (("MLB-R1", False), ("MLB-R2", True)):
        x, log, cal = residual(m, lambda mm, e=extra: _feat_ml(mm, e), PRE)
        rep = runner.run(SPORT, eid, x, cfg_price(0.005, "resid"), f"ML residual{' + block' if extra else ''}",
                         extra={"fit_log": log, "movement_calibration": cal})
        res[eid] = x
        out[eid] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
        print(eid, out[eid])
    common = set(res["MLB-R1"].game_id) & set(res["MLB-R2"].game_id)
    c = cfg_price(0.005, "resid")
    b1 = H.bet_table(res["MLB-R1"][res["MLB-R1"].game_id.isin(common)], c, 0.005)
    b2 = H.bet_table(res["MLB-R2"][res["MLB-R2"].game_id.isin(common)], c, 0.005)
    out["R2_vs_R1_same_games"] = {"pool": len(common), "r1": [len(b1), round(100 * b1.clv_prob.mean(), 3)],
                                  "r2": [len(b2), round(100 * b2.clv_prob.mean(), 3)]}
    print("R2 vs R1", out["R2_vs_R1_same_games"])
    x = res["MLB-R1"]
    rep = runner.run(SPORT, "MLB-W1", x[x.rotation_unknown > 0], cfg_price(0.005, "resid"), "R1 where the rotation is disrupted")
    out["MLB-W1"] = runner.fmt(rep)
    print("MLB-W1", out["MLB-W1"])
    return out


def _feat_fav(m):
    x = price_frame(m, "p_proj")
    x["fav"] = x.p_open - 0.5
    x["move"] = x.p_close - x.p_open
    ok = x.fav.notna() & x.move.notna()
    return x[ok], ["fav"]


def drift():
    m, _ = load()
    m = m[m.season.isin(PRE)].copy()
    x, log, cal = residual(m, _feat_fav, PRE)
    rep = runner.run(SPORT, "MLB-D1", x, cfg_price(0.005, "resid"), "favourite drift only (diagnostic)",
                     extra={"fit_log": log, "movement_calibration": cal})
    print("MLB-D1", runner.fmt(rep), log[-1])


def holdout():
    m, _ = load()
    pre_m = m[m.season.isin(PRE)].copy()
    proxy = m[m.season.isin(PROXY)].copy()
    k = 8
    both = pd.concat([pre_m, proxy], ignore_index=True)
    x2, log2, cal2 = residual(both, lambda mm: _feat_ml(mm, True), PROXY, frozen_train=pre_m)
    out = {}
    for eid, x, c, label, extra in (("MLB-H1", price_frame(proxy, "p_proj"), cfg_price(0.02), "lab projected starter ML (proxy)", {}),
                                    ("MLB-H2", x2, cfg_price(0.005, "resid"), "MLB-R2 frozen (proxy)", {"fit": log2, "movement_calibration": cal2})):
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
        print("ml open+close", int(ok.sum()), "by season", m[ok].groupby("season").size().to_dict(),
              "corr(p_proj, p_close)", round(float(np.corrcoef(m.p_proj[ok], m.p_close[ok])[0, 1]), 3))
    elif cmd == "pre":
        print(json.dumps(pre(), indent=1, default=str))
    elif cmd == "drift":
        drift()
    elif cmd == "holdout":
        holdout()
