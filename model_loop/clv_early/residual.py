"""Phase 4: the market-residual model. It predicts line MOVEMENT,
y = close - early line, from inputs knowable at the early line; the early line
is the prior (predicted close = early + m_hat). A bet is placed when the
predicted move |m_hat| >= theta, on the side the move points to, and is scored
by the same harness as every baseline (EXPERIMENTS.md E-101..).

Model: ridge on standardised features with an intercept, fitted walk-forward
(seasons < S predict S), penalty fixed in the preregistration.

Feature groups (each enters as its own experiment):
  base     d = base model - early line (the disagreement)
  qb       NFL: previous-game starter left that game early (share of the team's
           dropbacks < 0.6); previous-game starter was not the team's regular
           starter this season (home minus away)
  rest     rest-day difference, byes, short weeks (schedule); NFL also travel
           miles and time zones crossed
  drift    NFL: early line minus the lookahead line (the line before week W-1
           kicked off), and whether a lookahead line existed
  market   favourite side, |early line|, early line on 3 / on 7 exactly
"""
import os

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "clv")


# --------------------------------------------------------------- ridge
def ridge_fit(X, y, lam):
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd < 1e-9] = 1.0
    Z = (X - mu) / sd
    yc = y.mean()
    A = Z.T @ Z + lam * np.eye(Z.shape[1])
    b = np.linalg.solve(A, Z.T @ (y - yc))
    return {"mu": mu, "sd": sd, "b": b, "a": yc}


def ridge_predict(m, X):
    return m["a"] + ((X - m["mu"]) / m["sd"]) @ m["b"]


def walk_forward(df, cols, lam, test_seasons, min_train=1):
    """df has season, y and the feature columns; returns m_hat for test seasons
    (fitted on every earlier season with a target) and the coefficients."""
    out = pd.Series(np.nan, index=df.index)
    coefs = {}
    for S in test_seasons:
        tr = df[(df.season < S) & df.y.notna()]
        te = df.season == S
        if tr.season.nunique() < min_train or not te.any():
            continue
        m = ridge_fit(tr[cols].values.astype(float), tr.y.values.astype(float), lam)
        out[te] = ridge_predict(m, df.loc[te, cols].values.astype(float))
        coefs[int(S)] = {"intercept": float(m["a"]), **{c: float(b / s) for c, b, s in zip(cols, m["b"], m["sd"])}}
    return out, coefs


# ------------------------------------------------------------ NFL inputs
def _lookahead(sport_lines):
    """NFL: the line each game carried just before week W-1 kicked off (the
    lookahead number), from the feed history; NaN when none was posted."""
    from .lines import NFL_CHANGES
    import bisect
    d = pd.read_csv(NFL_CHANGES, low_memory=False, usecols=["seen_at", "game_id", "spread_line", "total_line"])
    d["seen_at"] = pd.to_datetime(d.seen_at, utc=True)
    L = sport_lines
    first = L.groupby(["season", "week"]).kick_utc.min()
    t_look = {g: first.get((s, w - 1)) for g, s, w in zip(L.game_id, L.season, L.week)}
    out = {}
    for gid, q in d.groupby("game_id"):
        t = t_look.get(gid)
        if t is None or pd.isna(t):
            continue
        res = {}
        for col in ("spread_line", "total_line"):
            s = q[q[col].notna()].sort_values("seen_at")
            tl = list(s.seen_at)
            i = bisect.bisect_right(tl, t) - 1
            res[col] = float(s[col].iloc[i]) if i >= 0 else np.nan
        out[gid] = res
    return out


def _qb_flags(T):
    """Per (game, team): did the previous-game starter leave that game early,
    and was he not the team's regular starter so far this season."""
    g = T.games.copy()
    g["kick"] = pd.to_datetime(g.kick_et)
    q = T.qbs.copy()
    q["drops"] = q.n_in + q.n_out
    tot = q.groupby(["game_id", "team"]).drops.sum()
    long = []
    for side in ("home", "away"):
        x = g[["game_id", "season", "kick", side, f"{side}_qb_id", "result"]].rename(columns={side: "team", f"{side}_qb_id": "qb"})
        x["side"] = side
        long.append(x)
    L = pd.concat(long).sort_values(["team", "season", "kick"])
    share = q.set_index(["game_id", "team", "qb_id"]).drops
    rows = {}
    for (team, season), d in L.groupby(["team", "season"]):
        starts = {}
        prev = None
        for r in d.itertuples():
            left = backup = 0.0
            if prev is not None and isinstance(prev.qb, str):
                td = tot.get((prev.game_id, team), np.nan)
                sd = share.get((prev.game_id, team, prev.qb), np.nan) if (prev.game_id, team, prev.qb) in share.index else np.nan
                if np.isfinite(td) and td > 0 and np.isfinite(sd):
                    left = float(sd / td < 0.6)
                if len(starts) and sum(starts.values()) >= 2:
                    regular = max(starts.items(), key=lambda kv: kv[1])[0]
                    backup = float(prev.qb != regular)
            rows[(r.game_id, r.side)] = (left, backup)
            if pd.notna(r.result) and isinstance(r.qb, str):
                starts[r.qb] = starts.get(r.qb, 0) + 1
                prev = r
    return rows


def nfl_features(base_pred, market="spread"):
    """One row per NFL game with an early line: y and every feature group."""
    from .run import lines
    from ..adapters.nfl.ratings import Tables
    from ..adapters.nfl import geo
    L = lines("nfl")
    T = Tables(os.path.join(ROOT, ".cache", "model_loop", "nfl", "build"))
    g = T.games.set_index("game_id")
    col = f"early_{market}"
    d = L[L[col].notna()].copy()
    d["early"] = d[col]
    d["close"] = d[f"close_{market}"]
    d["y"] = d.close - d.early
    bp = base_pred.set_index("game_id")[f"model_{market}"]
    d["base"] = d.game_id.map(bp)
    d["d_base"] = d.base - d.early
    # qb
    flags = _qb_flags(T)
    d["qb_left"] = [flags.get((x, "home"), (0, 0))[0] - flags.get((x, "away"), (0, 0))[0] for x in d.game_id]
    d["qb_backup"] = [flags.get((x, "home"), (0, 0))[1] - flags.get((x, "away"), (0, 0))[1] for x in d.game_id]
    # rest / travel
    hr = pd.to_numeric(d.game_id.map(g.home_rest), errors="coerce").fillna(7)
    ar = pd.to_numeric(d.game_id.map(g.away_rest), errors="coerce").fillna(7)
    d["rest_diff"] = np.clip(hr - ar, -7, 7) / 7.0
    d["bye_diff"] = (hr >= 13).astype(float) - (ar >= 13).astype(float)
    d["short_diff"] = (hr <= 5).astype(float) - (ar <= 5).astype(float)
    geo_rows = [geo.game_geo({"home": g.home.get(x), "away": g.away.get(x), "season": g.season.get(x), "neutral": g.neutral.get(x),
                              "stadium": g.stadium.get(x), "kick_et": g.kick_et.get(x)}) for x in d.game_id]
    G = pd.DataFrame(geo_rows, index=d.index)
    d["travel_diff"] = (G.away_miles - G.home_miles) / 1000.0
    d["tz_diff"] = G.away_tz.abs() - G.home_tz.abs()
    # drift
    la = _lookahead(L)
    key = "spread_line" if market == "spread" else "total_line"
    look = d.game_id.map(lambda x: la.get(x, {}).get(key, np.nan))
    d["has_look"] = look.notna().astype(float)
    d["drift"] = (d.early - look).fillna(0.0)
    # market structure
    d["fav"] = np.sign(d.early) if market == "spread" else 0.0
    d["abs_early"] = d.early.abs() if market == "spread" else d.early - 44.0
    d["on3"] = (d.early.abs() == 3).astype(float) if market == "spread" else 0.0
    d["on7"] = (d.early.abs() == 7).astype(float) if market == "spread" else 0.0
    return d


GROUPS = {"base": ["d_base"], "qb": ["qb_left", "qb_backup"], "rest": ["rest_diff", "bye_diff", "short_diff"],
          "travel": ["travel_diff", "tz_diff"], "drift": ["drift", "has_look"], "market": ["fav", "abs_early", "on3", "on7"]}


def cfb_features(base_pred, market="spread"):
    """One row per CFB game with an opener: y and the timing-safe groups."""
    from .run import lines
    L = lines("cfb")
    g = pd.read_parquet(os.path.join(ROOT, ".cache", "model_loop", "cfb", "build", "games.parquet"))
    g["game_id"] = g.game_id.astype(str)
    g = g.set_index("game_id")
    col = f"early_{market}"
    d = L[L[col].notna() & L[f"close_{market}"].notna()].copy()
    d["early"] = d[col]
    d["close"] = d[f"close_{market}"]
    d["y"] = d.close - d.early
    bp = base_pred.assign(game_id=base_pred.game_id.astype(str)).set_index("game_id")[f"model_{market}"]
    d["base"] = d.game_id.map(bp)
    d["d_base"] = d.base - d.early
    hr = pd.to_numeric(d.game_id.map(g.home_rest), errors="coerce").fillna(7)
    ar = pd.to_numeric(d.game_id.map(g.away_rest), errors="coerce").fillna(7)
    d["rest_diff"] = np.clip(hr - ar, -7, 7) / 7.0
    d["bye_diff"] = (hr >= 13).astype(float) - (ar >= 13).astype(float)
    d["short_diff"] = (hr <= 5).astype(float) - (ar <= 5).astype(float)
    d["fav"] = np.sign(d.early) if market == "spread" else 0.0
    d["abs_early"] = d.early.abs() if market == "spread" else d.early - 52.0
    d["on3"] = (d.early.abs() == 3).astype(float) if market == "spread" else 0.0
    d["on7"] = (d.early.abs() == 7).astype(float) if market == "spread" else 0.0
    return d
