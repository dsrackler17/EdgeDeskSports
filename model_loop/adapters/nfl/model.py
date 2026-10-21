"""The NFL v2 projection: rating differences and situational inputs ->
home margin and total, fitted walk-forward, with every component of the
fair line attributed exactly.

Margin (no intercept: a neutral site with equal teams projects 0):

  margin = hfa*(1-neutral) + b_po*pass_off + b_qb*qb + b_pd*pass_def
         + b_ro*rush_off + b_rd*rush_def + b_m*market
         + b_rest*rest + b_bye*bye + b_short*short
         + b_tr*travel + b_tz*timezone + b_bc*body_clock + b_div*division
         + b_covid*(2020 home game)

Every b is fitted on seasons BEFORE the season it prices (weighted toward
recent seasons by `hl_season`), so each season's numbers are out of
sample. Offense and defense carry separate coefficients, so the data decide
how much a point of pass-defense EPA is worth next to a point of
pass-offense EPA. Home field is fitted from recent seasons and shrunk
toward its long-run value.

Because the model is linear, the fair margin IS the sum of its component
rows: contributions are coefficient x input, they reconcile to the fair line
to floating-point precision, and nothing is left unattributed.
"""
import numpy as np
import pandas as pd

from ...core.ratings import ridge, recency_weights
from ...core.distribution import KeyNumberMargin, no_vig_two_way, american_from_prob
from ...core.calibration import Platt
from . import geo

# (key, label, group): the card's rows, in order
MARGIN_COMPONENTS = [
    ("home_field", "Home field", "environment"),
    ("covid_2020", "No-crowd season (2020)", "environment"),
    ("division", "Division game", "environment"),
    ("pass_off", "Pass offense (team, excluding QB)", "base_strength"),
    ("qb", "Quarterback", "base_strength"),
    ("pass_def", "Pass defense", "base_strength"),
    ("rush_off", "Rush offense", "base_strength"),
    ("rush_def", "Rush defense", "base_strength"),
    ("market", "Market rating (prior weeks' closing lines)", "base_strength"),
    ("rest", "Rest days", "rest_travel"),
    ("bye", "Off a bye", "rest_travel"),
    ("short", "Short week", "rest_travel"),
    ("travel", "Travel distance", "rest_travel"),
    ("timezone", "Time zones crossed", "rest_travel"),
    ("body_clock", "Early body-clock kickoff", "rest_travel"),
]
TRIP_TERMS = ("travel", "timezone", "body_clock")
TOTAL_COMPONENTS = [
    ("intercept", "League scoring baseline"),
    ("pass_env", "Both pass matchups (expected EPA/dropback)"),
    ("rush_env", "Both rush matchups (expected EPA/rush)"),
    ("market_total", "Market total rating (prior weeks' closing totals)"),
    ("dome", "Dome / closed roof"),
    ("wind", "Wind above 10 mph"),
    ("cold", "Temperature below 40F"),
]

MODEL_DEFAULTS = {
    "components": {"qb": True, "market": True, "rest": True, "travel": True, "division": True,
                   "covid": True, "pass_split": True, "rush": True},
    "hl_season": 6.0,
    "ridge_lam": 2.0,
    "hfa_prior_games": 300.0,
    "first_train": 2007,
    "min_train_seasons": 2,
    "calibration": "none",          # "none" | "platt"
    "total_market": True,
}


def merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def add_geo(rows):
    """Travel / time-zone / body-clock inputs, computed once per row."""
    g = [geo.game_geo({"home": r.home, "away": r.away, "season": r.season, "neutral": r.neutral,
                       "stadium": r.stadium, "kick_et": r.kick_et}) for r in rows.itertuples()]
    gd = pd.DataFrame(g, index=rows.index)
    return pd.concat([rows.drop(columns=[c for c in gd.columns if c in rows.columns]), gd], axis=1)


def margin_design(rows, cfg):
    c = cfg["components"]
    nn = 1.0 - rows.neutral.values
    rest_h = pd.to_numeric(rows.home_rest, errors="coerce").fillna(7).values
    rest_a = pd.to_numeric(rows.away_rest, errors="coerce").fillna(7).values
    cols = {"home_field": nn}
    if c["covid"]:
        cols["covid_2020"] = nn * (rows.season.values == 2020)
    if c["division"]:
        cols["division"] = rows.div_game.values.astype(float)
    if c["pass_split"]:
        cols["pass_off"] = rows.x_pass_off.values
        cols["pass_def"] = rows.x_pass_def.values
    else:
        cols["pass_net"] = rows.x_pass_off.values + rows.x_pass_def.values
    if c["qb"]:
        cols["qb"] = rows.x_qb.values
    if c["rush"]:
        if c["pass_split"]:
            cols["rush_off"] = rows.x_rush_off.values
            cols["rush_def"] = rows.x_rush_def.values
        else:
            cols["rush_net"] = rows.x_rush_off.values + rows.x_rush_def.values
    if c["market"]:
        cols["market"] = rows.x_market.values
    if c["rest"]:
        cols["rest"] = np.clip(rest_h - rest_a, -7, 7) / 7.0
        cols["bye"] = (rest_h >= 13).astype(float) - (rest_a >= 13).astype(float)
        cols["short"] = (rest_h <= 5).astype(float) - (rest_a <= 5).astype(float)
    if c["travel"]:
        cols["travel"] = (rows.away_miles.values - rows.home_miles.values) / 1000.0
        cols["timezone"] = np.abs(rows.away_tz.values) - np.abs(rows.home_tz.values)
        cols["body_clock"] = rows.away_body.values.astype(float) - rows.home_body.values.astype(float)
    names = list(cols)
    return np.column_stack([cols[k] for k in names]), names


# one fitted coefficient shared by offense and defense (the validation bar
# decides); the card still prints offense and defense as separate rows
TIED = {"pass_net": ("pass_off", "pass_def"), "rush_net": ("rush_off", "rush_def")}
XSRC = {"pass_off": "x_pass_off", "pass_def": "x_pass_def", "rush_off": "x_rush_off", "rush_def": "x_rush_def"}
PSRC = {"pass_off": "p_pass_off", "pass_def": "p_pass_def", "qb": "p_qb",
        "rush_off": "p_rush_off", "rush_def": "p_rush_def", "market": "p_market"}


def display_names(names):
    out = []
    for n in names:
        out += list(TIED.get(n, (n,)))
    return out


def prior_split(rows, names, coef):
    """The part of the base-strength points that comes from the prior (last
    season + personnel), exactly: each rating is from_prior + from_data."""
    out = np.zeros(len(rows))
    for j, n in enumerate(names):
        for d in TIED.get(n, (n,)):
            if d in PSRC:
                out += coef[j] * rows[PSRC[d]].values
    return out


def total_design(rows, cfg):
    dome = rows.roof.isin(["dome", "closed"]).values.astype(float)
    wind = pd.to_numeric(rows.wind, errors="coerce").fillna(0).values
    temp = pd.to_numeric(rows.temp, errors="coerce").fillna(65).values
    cols = {"intercept": np.ones(len(rows)), "pass_env": rows.t_pass_sum.values, "rush_env": rows.t_rush_sum.values}
    if cfg["total_market"]:
        cols["market_total"] = rows.t_market.values - 44.0
    cols["dome"] = dome
    cols["wind"] = np.where(dome > 0, 0.0, np.maximum(0.0, wind - 10.0)) / 10.0
    cols["cold"] = np.where(dome > 0, 0.0, np.maximum(0.0, 40.0 - temp)) / 10.0
    names = list(cols)
    return np.column_stack([cols[k] for k in names]), names


def walk_forward(rows, cfg=None, predict_seasons=None):
    """Fit before each season on prior seasons only; returns the rows with
    pred_margin, pred_total, per-component contributions and the
    coefficients used for each season."""
    cfg = merge(MODEL_DEFAULTS, cfg or {})
    rows = rows.copy()
    X, names = margin_design(rows, cfg)
    XT, tnames = total_design(rows, cfg)
    seasons = sorted(rows.season.unique())
    predict_seasons = predict_seasons or [s for s in seasons if s >= cfg["first_train"] + cfg["min_train_seasons"]]
    pm = np.full(len(rows), np.nan)
    pt = np.full(len(rows), np.nan)
    pp = np.full(len(rows), np.nan)
    dnames = display_names(names)
    di = {d: i for i, d in enumerate(dnames)}
    contrib = np.full((len(rows), len(dnames)), np.nan)
    tcontrib = np.full((len(rows), len(tnames)), np.nan)
    coefs, tcoefs = {}, {}
    played = rows.result.notna().values
    hfa_j = names.index("home_field")
    X0 = X.copy()
    nn = 1.0 - rows.neutral.values
    centred = [names.index(k) for k in TRIP_TERMS if k in names]
    for S in predict_seasons:
        tr = (rows.season.values < S) & (rows.season.values >= cfg["first_train"]) & played
        te = rows.season.values == S
        if tr.sum() < 200 or te.sum() == 0:
            continue
        # a home game's TYPICAL trip belongs to home field; the travel rows say
        # only how this trip differs from a typical one (training seasons' mean)
        X = X0.copy()
        for j in centred:
            home_games = tr & (nn > 0)
            X[:, j] = X0[:, j] - X0[home_games, j].mean() * nn
        age = (S - 1 - rows.season.values[tr]).astype(float)
        w = recency_weights(age, cfg["hl_season"])
        # the long-run home field (every prior season equally) is the shrinkage target
        b_long = ridge(X[tr], rows.result.values[tr], None, cfg["ridge_lam"], unpenalized=(hfa_j,))
        b = ridge(X[tr], rows.result.values[tr], w, cfg["ridge_lam"], unpenalized=(hfa_j,),
                  prior_mean={hfa_j: b_long[hfa_j]},
                  prior_lam={hfa_j: cfg["hfa_prior_games"]} if cfg["hfa_prior_games"] else None)
        coefs[int(S)] = {}
        for j, n in enumerate(names):
            if n in TIED:
                for d in TIED[n]:
                    contrib[te, di[d]] = b[j] * rows[XSRC[d]].values[te]
                    coefs[int(S)][d] = float(b[j])
            else:
                contrib[te, di[n]] = X[te, j] * b[j]
                coefs[int(S)][n] = float(b[j])
        pm[te] = contrib[te].sum(axis=1)
        pp[te] = prior_split(rows[te], names, b)
        trt = tr & rows.total_pts.notna().values & np.isfinite(XT).all(axis=1)
        if trt.sum() > 200:
            bt = ridge(XT[trt], rows.total_pts.values[trt], recency_weights((S - 1 - rows.season.values[trt]).astype(float), cfg["hl_season"]),
                       cfg["ridge_lam"], unpenalized=(0,))
            tcoefs[int(S)] = dict(zip(tnames, map(float, bt)))
            ok = te & np.isfinite(XT).all(axis=1)
            tcontrib[ok] = XT[ok] * bt[None, :]
            pt[ok] = tcontrib[ok].sum(axis=1)
    rows["pred_margin"] = pm
    rows["pred_total"] = pt
    rows["prior_part"] = pp
    for j, n in enumerate(dnames):
        rows["c_" + n] = contrib[:, j]
    for j, n in enumerate(tnames):
        rows["ct_" + n] = tcontrib[:, j]
    return rows, {"margin": coefs, "total": tcoefs, "names": dnames, "fitted_names": names, "total_names": tnames, "cfg": cfg}


def add_probabilities(rows, cfg=None, eval_from=None):
    """Win, tie and cover probabilities and the centred 80% range, each
    season from a distribution fitted on EARLIER seasons' out-of-sample
    projections; optional Platt calibration fitted the same way. Also the
    market's own probability for comparison: no-vig moneyline where the
    feed has one, else the same distribution centred on the close."""
    cfg = merge(MODEL_DEFAULTS, cfg or {})
    rows = rows.copy()
    seasons = sorted(rows.season[rows.pred_margin.notna()].unique())
    for c in ("win_prob", "win_prob_raw", "tie_prob", "range_half", "mkt_win_prob", "dist_sigma"):
        rows[c] = np.nan
    dists = {}
    for S in seasons:
        prior = rows[(rows.season < S) & rows.pred_margin.notna() & rows.result.notna()]
        if prior.season.nunique() >= 2:
            d = KeyNumberMargin.fit(prior.pred_margin.values, prior.result.values, sigmas=np.arange(11.5, 16.01, 0.5))
        else:
            hist = rows[(rows.season < S) & rows.close_margin.notna() & rows.result.notna()]
            d = KeyNumberMargin.fit(hist.close_margin.values, hist.result.values, sigmas=np.arange(11.5, 16.01, 0.5))
        dists[int(S)] = d
        te = (rows.season == S) & rows.pred_margin.notna()
        mu = rows.loc[te, "pred_margin"].values
        w, t, l = d.win_tie_loss(mu)
        p = w / np.maximum(w + l, 1e-12)
        if cfg["calibration"] == "platt":
            hist = rows[(rows.season < S) & rows.win_prob_raw.notna() & rows.result.notna() & (rows.result != 0)]
            if hist.season.nunique() >= 2:
                p = Platt.fit(hist.win_prob_raw.values, (hist.result > 0).astype(float).values)(p)
        rows.loc[te, "win_prob_raw"] = w / np.maximum(w + l, 1e-12)
        rows.loc[te, "win_prob"] = p
        rows.loc[te, "tie_prob"] = t
        rows.loc[te, "range_half"] = d.central_halfwidth(mu, 0.80)
        rows.loc[te, "dist_sigma"] = d.sigma
        cm = rows.loc[te, "close_margin"].values
        nv = np.array([no_vig_two_way(a, b) for a, b in zip(rows.loc[te, "home_ml"].values, rows.loc[te, "away_ml"].values)], dtype=float)
        mw, _, ml = d.win_tie_loss(np.nan_to_num(cm))
        from_spread = mw / np.maximum(mw + ml, 1e-12)
        rows.loc[te, "mkt_win_prob"] = np.where(np.isfinite(nv), nv, np.where(np.isfinite(cm), from_spread, np.nan))
    return rows, dists


def card(row, coefs, dist, names):
    """One game's card: fair line, win probability, fair moneylines, the
    centred range and component rows that sum exactly to the fair margin."""
    mu = float(row["pred_margin"])
    comps = []
    for key, label, group in MARGIN_COMPONENTS:
        if key in names:
            comps.append({"key": key, "label": label, "group": group, "points": float(row["c_" + key])})
    total = sum(c["points"] for c in comps)
    w, t, l = dist.win_tie_loss(mu)
    p = float(w[0] / (w[0] + l[0]))
    h = float(dist.central_halfwidth(mu, 0.80)[0])
    return {"fair_home_margin": mu, "fair_home_line": -mu, "home_win_prob": p, "tie_prob": float(t[0]),
            "fair_home_ml": american_from_prob(p), "fair_away_ml": american_from_prob(1 - p),
            "range80": {"lo": mu - h, "hi": mu + h, "centre": mu, "half_width": h},
            "components": comps, "components_sum": total, "unattributed": mu - total,
            "prior_share_points": float(row.get("prior_part", np.nan))}
