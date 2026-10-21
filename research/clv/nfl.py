"""NFL: Phases 3-6 of the CLV programme (EXPERIMENTS.md, section NFL).

  python3 -m research.clv.nfl bases       # opener-time base models (cached in .cache/clv/)
  python3 -m research.clv.nfl pre         # every pre-holdout experiment
  python3 -m research.clv.nfl holdout     # Phase 6, once

Opener-time inputs (DATA_AUDIT.md): each side's QB is the QB who started that
franchise's previous game, and game-day temperature and wind are dropped (the
models' own missing-value defaults), in training and prediction alike.

Lines: SBR open and close (2011-2021), joined to nflverse games by date and
franchise; graded at -110 both sides (SBR keeps no spread prices).
"""
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.clv import residual as R
from model_loop.clv import sources as S
from research.clv import runner

SPORT = "nfl"
PRE = list(range(2011, 2020))
PROXY = [2020, 2021]
LOOP_CACHE = os.path.join(S.CACHE, "nfl_loop_opener.csv")
V21_CACHE = os.path.join(S.CACHE, "nfl_v21_opener.csv")

# SBR nicknames -> nflverse franchise codes (current codes; relocations folded)
SBR_TEAMS = {
    "Cardinals": "ARI", "Arizona": "ARI", "Falcons": "ATL", "Atlanta": "ATL", "Ravens": "BAL", "Baltimore": "BAL",
    "Bills": "BUF", "Buffalo": "BUF", "Panthers": "CAR", "Carolina": "CAR", "Bears": "CHI", "Chicago": "CHI",
    "Bengals": "CIN", "Cincinnati": "CIN", "Browns": "CLE", "Cleveland": "CLE", "Cowboys": "DAL", "Dallas": "DAL",
    "Broncos": "DEN", "Denver": "DEN", "Lions": "DET", "Detroit": "DET", "Packers": "GB", "GreenBay": "GB",
    "Texans": "HOU", "Houston": "HOU", "Colts": "IND", "Indianapolis": "IND", "Jaguars": "JAX", "Jacksonville": "JAX",
    "Chiefs": "KC", "KansasCity": "KC", "Kansas": "KC", "Raiders": "LV", "Oakland": "LV", "LasVegas": "LV",
    "LVRaiders": "LV", "Chargers": "LAC", "SanDiego": "LAC", "LAChargers": "LAC", "Rams": "LA", "LARams": "LA",
    "St.Louis": "LA", "StLouis": "LA", "LosAngeles": "LA", "Dolphins": "MIA", "Miami": "MIA", "Vikings": "MIN",
    "Minnesota": "MIN", "Patriots": "NE", "NewEngland": "NE", "Saints": "NO", "NewOrleans": "NO", "Giants": "NYG",
    "NYGiants": "NYG", "Jets": "NYJ", "NYJets": "NYJ", "Eagles": "PHI", "Philadelphia": "PHI", "Steelers": "PIT",
    "Pittsburgh": "PIT", "Seahawks": "SEA", "Seattle": "SEA", "49ers": "SF", "SanFrancisco": "SF", "Buccaneers": "TB",
    "TampaBay": "TB", "Tampa": "TB", "Titans": "TEN", "Tennessee": "TEN", "Redskins": "WAS", "Washington": "WAS",
    "Commanders": "WAS", "FootballTeam": "WAS", "WashingtonFootballTeam": "WAS",
    "BuffaloBills": "BUF", "Fortyniners": "SF", "KCChiefs": "KC", "Washingtom": "WAS",
    "NewYork": "NY?",   # Giants or Jets: resolved by the schedule join (both tried)
}
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA"}


# ------------------------------------------------------------ base models
def loop_opener():
    """model_loop NFL 2.0.0 (served config) with each side's previous starter
    and no game-day weather, walk-forward."""
    from model_loop.adapters.nfl import backtest as BT
    from model_loop.adapters.nfl import model as NM
    from model_loop.adapters.nfl.ratings import NflRatingPass
    v = json.load(open(os.path.join(S.ROOT, "docs", "model-loop", "nfl", "versions.json")))
    cfg = next(x for x in v["versions"] if x["version"] == v["current"])["config"]
    T = BT.Tables(os.path.join(BT.DATA, "build"))
    g = T.games.copy()
    order = "gameday" if "gameday" in g else ("kick_utc" if "kick_utc" in g else "game_id")
    g = g.sort_values([order, "game_id"])
    last, over = {}, {}
    for r in g.itertuples(index=False):
        over[r.game_id] = (last.get(r.home) or "__none__", last.get(r.away) or "__none__")
        for team, q in ((r.home, r.home_qb_id), (r.away, r.away_qb_id)):
            if isinstance(q, str) and q:
                last[team] = q
    rows, _ = NflRatingPass(T, cfg["rating"]).run(BT.SEASONS, qb_overrides=over)
    rows = NM.add_geo(rows)
    rows["wind"], rows["temp"] = np.nan, np.nan
    p, _ = NM.walk_forward(rows, cfg["model"])
    p[["game_id", "season", "week", "pred_margin", "pred_total"]].to_csv(LOOP_CACHE, index=False)
    print(f"loop opener: {len(p)} games", file=sys.stderr)


def v21_opener():
    subprocess.run(["node", os.path.join(S.ROOT, "research", "clv", "nfl_v2_opener.js"), V21_CACHE], check=True)


# ------------------------------------------------------------------ data
def games():
    """nflverse schedule (game ids, franchise codes, dates, results, closes)."""
    p = os.path.join(S.ROOT, ".cache", "model_loop", "nfl", "raw", "games.csv")
    if not os.path.exists(p):
        p = os.path.join(S.ROOT, "football", "research", "nfl_v2", ".cache", "raw", "games.csv")
    g = pd.read_csv(p, low_memory=False)
    g["home"] = g.home_team.map(lambda t: FRANCHISE.get(t, t))
    g["away"] = g.away_team.map(lambda t: FRANCHISE.get(t, t))
    g["date"] = pd.to_datetime(g.gameday)
    g = g.sort_values(["date", "game_id"]).reset_index(drop=True)
    # backup flag, knowable at the opener: a side's previous-game starter is not
    # its regular starter (most starts in that franchise's previous 8 games)
    hist, prev, flags = {}, {}, {"home_backup": [], "away_backup": []}
    for r in g.itertuples(index=False):
        for side, team, q in (("home", r.home, r.home_qb_id), ("away", r.away, r.away_qb_id)):
            h = hist.get(team, [])
            last = prev.get(team)
            if last is None or len(h) < 3:
                flags[f"{side}_backup"].append(np.nan)
            else:
                window = h[-8:]
                regular = max(set(window), key=window.count)
                flags[f"{side}_backup"].append(float(last != regular))
        for team, q in ((r.home, r.home_qb_id), (r.away, r.away_qb_id)):
            if isinstance(q, str) and q:
                hist.setdefault(team, []).append(q)
                prev[team] = q
    g["home_backup"], g["away_backup"] = flags["home_backup"], flags["away_backup"]
    g["rest_diff"] = g.home_rest - g.away_rest
    return g[["game_id", "season", "week", "game_type", "date", "home", "away", "home_score", "away_score",
              "spread_line", "total_line", "home_qb_id", "away_qb_id", "home_qb_name", "away_qb_name", "div_game",
              "home_backup", "away_backup", "rest_diff"]]


def sbr_lines():
    d, qa = S.sbr("nfl")
    d["home"] = d.home_team.str.replace(" ", "").map(SBR_TEAMS)
    d["away"] = d.away_team.str.replace(" ", "").map(SBR_TEAMS)
    qa["unmapped_teams"] = sorted(map(str, set(d.home_team[d.home.isna()]) | set(d.away_team[d.away.isna()])))
    parts = [d]
    for col in ("home", "away"):
        amb = d[d[col] == "NY?"]
        d = d[d[col] != "NY?"]
        parts = [d] + [amb.assign(**{col: c}) for c in ("NYG", "NYJ")] + parts[1:]
    d = pd.concat(parts, ignore_index=True)
    return d, qa


def load():
    g = games()
    s, qa = sbr_lines()
    # join on (home, away) within +-3 days of the SBR date
    m = g.merge(s[["date", "home", "away", "open_line", "close_line", "open_total", "close_total", "home_score", "away_score"]]
                .rename(columns={"date": "sbr_date", "home_score": "sbr_hs", "away_score": "sbr_as"}), on=["home", "away"], how="inner")
    m = m[(m.date - m.sbr_date).abs() <= pd.Timedelta(days=3)]
    m = m.drop_duplicates("game_id")
    qa["joined"] = int(len(m))
    qa["score_mismatch"] = int(((m.sbr_hs != m.home_score) | (m.sbr_as != m.away_score)).sum())
    m = m[(m.sbr_hs == m.home_score) & (m.sbr_as == m.away_score)].copy()
    m["margin"] = m.home_score - m.away_score
    m["total_pts"] = m.home_score + m.away_score
    m["result"] = m.margin
    qa["close_vs_nflverse_abs_diff_mean"] = round(float((m.close_line - m.spread_line).abs().mean()), 3)
    qa["close_vs_nflverse_within_1"] = round(float(((m.close_line - m.spread_line).abs() <= 1).mean()), 3)
    for path, cols in ((LOOP_CACHE, {"pred_margin": "loop", "pred_total": "loop_total"}),
                       (V21_CACHE, {"model_margin": "v21", "model_total": "v21_total"})):
        if os.path.exists(path):
            p = pd.read_csv(path)
            m = m.merge(p[["game_id"] + list(cols)].rename(columns=cols), on="game_id", how="left")
    leg = pd.read_csv(os.path.join(S.ROOT, "model_loop", "adapters", "nfl", "baselines", "legacy_v1_predictions.csv"))
    m["cluster"] = m.season.astype(str) + "-" + m.week.astype(str)
    return m, qa, leg


# ----------------------------------------------------------- experiments
def dists(m):
    g = games()
    tr = g[(g.season >= 2006) & (g.season <= 2019) & g.home_score.notna() & g.spread_line.notna()]
    km = H.KeyNumberMargin.fit(tr.spread_line.values, (tr.home_score - tr.away_score).values)
    x = m[m.season.isin(PRE)]
    st = float((x.total_pts - x.close_total).std())
    return km, H.IntegerNormal(st)


def cfg(m, market, thr, kind="base"):
    km, tn = DISTS if DISTS else dists(m)
    th = (thr, 0.5, 1.0, 2.0, 3.0) if kind == "base" else (thr, 0.5, 1.0)
    bk = (0, 0.5, 1, 2, 3, 5, H.INF) if kind == "base" else (0, 0.25, 0.5, 1, H.INF)
    return H.HarnessConfig(kind="points", market=market, thresholds=tuple(dict.fromkeys(th)), primary=thr,
                           dist=km if market == "spread" else tn, buckets=bk)


DISTS = None


def frame(m, col, market="spread"):
    x = m.copy()
    if market == "total":
        x["open_line"], x["close_line"], x["result"] = x.open_total, x.close_total, x.total_pts
    x["model_line"] = x[col]
    x["backup_any"] = ((x.home_backup == 1) | (x.away_backup == 1)).astype(float)
    x["backup_diff"] = x.home_backup.fillna(0) - x.away_backup.fillna(0)
    x["early"] = ((x.week <= 4) & x.game_type.eq("REG")).astype(float)
    return x


def _features(m, base_cols, extra, market):
    x = frame(m, base_cols[0], market)
    feats = []
    for c in base_cols:
        x[f"d_{c}"] = x[c] - x.open_line
        feats.append(f"d_{c}")
    if extra:
        x["open_lvl"] = x.open_line
        x["d_early"] = x[f"d_{base_cols[0]}"] * x.early
        feats += ["open_lvl", "d_early", "rest_diff", "backup_diff"]
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
    global DISTS
    m, qa, _ = load()
    m = m[m.season.isin(PRE)].copy()
    DISTS = dists(m)
    out = {"qa": qa}
    for eid, col, mk, thr, label in (("NFL-B1", "v21", "spread", 1.0, "production v2.1.0 (opener inputs) spread"),
                                     ("NFL-B2", "v21_total", "total", 1.5, "production v2.1.0 (opener inputs) total"),
                                     ("NFL-B3", "loop", "spread", 1.0, "model_loop 2.0.0 (opener inputs) spread"),
                                     ("NFL-B4", "loop_total", "total", 1.5, "model_loop 2.0.0 (opener inputs) total")):
        rep = runner.run(SPORT, eid, frame(m, col, mk), cfg(m, mk, thr), label)
        out[eid] = runner.fmt(rep)
        print(eid, out[eid])
    res = {}
    for eid, extra, label in (("NFL-R1", False, "residual ridge on d_v21, d_loop (spread)"),
                              ("NFL-R2", True, "R1 + information block (spread)")):
        x, log, cal = residual(m, ["v21", "loop"], extra, "spread", PRE)
        rep = runner.run(SPORT, eid, x, cfg(m, "spread", 0.25, "resid"), label, extra={"fit_log": log, "movement_calibration": cal})
        res[eid] = x
        out[eid] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
        print(eid, out[eid])
    common = set(res["NFL-R1"].game_id) & set(res["NFL-R2"].game_id)
    c = cfg(m, "spread", 0.25, "resid")
    b1 = H.bet_table(res["NFL-R1"][res["NFL-R1"].game_id.isin(common)], c, 0.25)
    b2 = H.bet_table(res["NFL-R2"][res["NFL-R2"].game_id.isin(common)], c, 0.25)
    out["R2_vs_R1_same_games"] = {"pool": len(common), "r1": [len(b1), round(100 * b1.clv_prob.mean(), 3)],
                                  "r2": [len(b2), round(100 * b2.clv_prob.mean(), 3)]}
    print("R2 vs R1", out["R2_vs_R1_same_games"])
    x = frame(m, "v21", "spread")
    x = x[x.backup_any == 1]
    rep = runner.run(SPORT, "NFL-W1", x, cfg(m, "spread", 1.0), "B1 restricted to backup-QB games")
    out["NFL-W1"] = runner.fmt(rep)
    print("NFL-W1", out["NFL-W1"])
    x, log, cal = residual(m, ["v21_total", "loop_total"], False, "total", PRE)
    rep = runner.run(SPORT, "NFL-W2", x, cfg(m, "total", 0.25, "resid"), "totals residual ridge on dt_v21, dt_loop",
                     extra={"fit_log": log, "movement_calibration": cal})
    out["NFL-W2"] = runner.fmt(rep) + f"; move slope {cal.get('slope')}"
    print("NFL-W2", out["NFL-W2"])
    return out


# ------------------------------------------------------------- Phase 6
def lines_2026():
    d = json.load(open(os.path.join(S.ROOT, "football", "pricing", "openers_nfl.json")))["games"]
    rows = []
    for gid, g in d.items():
        o, c = g.get("open") or {}, g.get("close") or {}
        if not g.get("closed"):
            continue
        rows.append({"game_id": gid, "open_line": -o["home_line"] if o.get("home_line") is not None else np.nan,
                     "close_line": -c["home_line"] if c.get("home_line") is not None else np.nan,
                     "open_total": o.get("total"), "close_total": c.get("total"), "open_seen_at": o.get("seen_at")})
    return pd.DataFrame(rows)


def holdout_frames():
    m, _, _ = load()
    pre_m = m[m.season.isin(PRE)].copy()
    proxy = m[m.season.isin(PROXY)].copy()
    g = games()
    l26 = lines_2026()
    x = g[g.season == 2026].merge(l26, on="game_id", how="inner")
    x = x[x.home_score.notna()].copy()
    x["margin"] = x.home_score - x.away_score
    x["total_pts"] = x.home_score + x.away_score
    x["result"] = x.margin
    for path, cols in ((LOOP_CACHE, {"pred_margin": "loop", "pred_total": "loop_total"}),
                       (V21_CACHE, {"model_margin": "v21", "model_total": "v21_total"})):
        p = pd.read_csv(path)
        x = x.merge(p[["game_id"] + list(cols)].rename(columns=cols), on="game_id", how="left")
    x["cluster"] = x.season.astype(str) + "-" + x.week.astype(str)
    return pre_m, proxy, x


def holdout():
    global DISTS
    pre_m, proxy, live = holdout_frames()
    DISTS = dists(pre_m)
    k = 12
    out = {}
    specs = [("NFL-H1", "spread", "v21", None, 1.0, "production v2.1.0 spread"),
             ("NFL-H2", "total", "v21_total", None, 1.5, "production v2.1.0 total"),
             ("NFL-H3", "spread", None, (["v21", "loop"], False), 0.25, "NFL-R1 frozen, spread"),
             ("NFL-H4", "total", None, (["v21_total", "loop_total"], False), 0.25, "NFL-W2 frozen, total")]
    for eid, mk, col, resid, thr, label in specs:
        c = cfg(pre_m, mk, thr, "base" if resid is None else "resid")
        res = {}
        for part, src in (("proxy", proxy), ("2026", live)):
            if resid is None:
                x = frame(src, col, mk)
                extra = {}
            else:
                both = pd.concat([pre_m, src], ignore_index=True)
                x, log, cal = residual(both, resid[0], resid[1], mk, sorted(src.season.unique()), frozen_train=pre_m)
                extra = {"fit": log, "movement_calibration": cal}
            if part == "proxy":
                rep = runner.run(SPORT, eid, x, c, label + " (proxy holdout 2020-21)", holdout=True, k_tests=k, extra=extra)
                res["proxy"] = runner.fmt(rep)
                res["verdict"] = H.verdict(rep["primary"], k)
                res["clv_ev"] = rep["primary"].get("clv_ev", {}).get("mean")
                res["by_season"] = {s["season"]: f"n={s['n_bets']} {100 * s['clv_prob']['mean']:+.2f} pp" for s in rep["by_season"]}
            else:
                rep = H.evaluate(x, c, k_tests=k, label=label + " (2026, reported)")
                with open(os.path.join(runner.RESULTS, SPORT, f"{eid}_2026.json"), "w") as f:
                    json.dump(rep, f, indent=1, default=float)
                res["2026"] = runner.fmt(rep) if rep["primary"].get("n_bets") else "0 bets"
        out[eid] = res
        print(eid, json.dumps(res, default=str))
    with open(os.path.join(runner.RESULTS, SPORT, "holdout_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "bases":
        v21_opener()
        loop_opener()
    elif cmd == "pre":
        print(json.dumps(pre(), indent=1, default=str))
    elif cmd == "holdout":
        holdout()
    elif cmd == "check":
        m, qa, _ = load()
        print(json.dumps(qa, indent=1, default=str))
