"""The CFB rating pass: one chronological sweep that, before every slate,
fits opponent-adjusted unit ratings from that season's plays and records the
pregame inputs of each game in the slate.

Per slate W of season S (only plays from slates < W, so every input is pregame):

  pass:   EPA/dropback = mu_p + H_p*home + O_pass[off] + D_pass[def] + Q[dropback QB]
                         + G_off[division of off] + G_def[division of def]
  rush:   EPA/rush     = mu_r + H_r*home + O_rush[off] + D_rush[def] + G_off[..] + G_def[..]
  market: close margin = hm*(1-neutral) + M[home] + Gm[div home] - M[away] - Gm[div away]
  totals: close total  = t0 + T[home] + Gt[div home] + T[away] + Gt[div away]

Every FBS team is a parameter. So is every FCS (and lower-division) team that
appears in the play-by-play: an FCS side is its division's fitted mean G
(itself a parameter, carried from last season and re-estimated from this
season's FBS-vs-FCS plays) plus its own deviation, held by a strong prior,
so one FCS team is not priced like every other one and none of them sits on
a hand-set floor. `fcs_teams: False` collapses each non-FBS division to its
fitted mean (the ablation).

Each observation is one (game, offense[, QB]) aggregate weighted by its plays,
where plays outside the competitive window (naive win probability below 10%
or above 90%; the naive model reads game state only, not the spread) count
`garbage_floor` of a play, and by recency 0.5 ** (slates ago / hl). Every
parameter is pulled toward a prior (core penalized_wls):

  FBS team:  carry * retmod * ((1 - conf_w) * own last-season deviation
                               + conf_w * its conference's mean deviation)
             + talent * z(247 composite)                 [all fitted / tuned]
  non-FBS:   division mean (fitted) + carry_lower * own last deviation
  QB:        his last value * carry_qb * qb_gap^(seasons missed), carried
             with the player through transfers; a debut QB starts at the
             debut mean of his division, measured on earlier seasons only

so the prior's share falls as this season's evidence accumulates, at rates
fitted on history, and every rating splits exactly into from_prior +
from_data.
"""
from collections import defaultdict

import numpy as np
import pandas as pd

from ...core.ratings import penalized_wls, recency_weights

UNITS = ("pass_off", "pass_def", "rush_off", "rush_def")
GROUPS = ("fcs", "lower")          # non-FBS divisions, each with a fitted mean
IND = "FBS Independents"

DEFAULTS = {
    "garbage_floor": 0.25,          # 1.0 = no garbage-time filter
    "hl_week": 6.0,                 # in-season recency half-life, slates (None = no decay)
    "lam": {"pass_off": 150.0, "pass_def": 150.0, "rush_off": 150.0, "rush_def": 150.0,
            "qb": 150.0, "mu": 100.0, "home": 3000.0,
            "lower": 600.0,         # a non-FBS team's own deviation from its division mean
            "group": 50.0},         # a division mean's pull toward last season's
    "carry": {"off": 0.8, "def": 0.6, "qb": 0.8, "qb_gap": 0.8, "lower": 0.6},
    "conf_w": 0.0,                  # share of the carried prior taken from the conference mean
    "talent": {"off": 0.0, "def": 0.0},   # EPA/play per SD of roster talent, on the prior mean
    "retprod": 0.0,                 # carry multiplier slope per unit of returning-production share
    "qb_layer": True,
    "fcs_teams": True,
    "market": {"on": True, "hl_week": 8.0, "lam": 0.5, "carry": 0.9, "lam_hfa": 20.0, "lam_group": 3.0},
    "totals_market": {"on": True, "hl_week": 8.0, "lam": 0.5, "carry": 0.9, "lam_group": 3.0},
}


def merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


class Tables:
    """The ingest outputs, indexed once."""

    def __init__(self, build_dir):
        rd = lambda n: pd.read_parquet(f"{build_dir}/{n}.parquet")
        self.games = rd("games")
        self.units = rd("unit_games")
        self.qbs = rd("qb_games")
        self.qbs["qb_id"] = self.qbs.qb_id.astype(str)
        self.priors = rd("priors")
        qn = rd("qb_names")
        self.qb_name = dict(zip(qn.qb_id.astype(str), qn.name.astype(str)))
        g = self.games
        self.home_of = dict(zip(g.game_id, g.home))
        self.neutral_of = dict(zip(g.game_id, g.neutral))
        self.by_season = {s: d.sort_values(["slate", "kick_utc", "game_id"]) for s, d in g.groupby("season")}
        self.units_by_season = {s: d for s, d in self.units.groupby("season")}
        self.qbs_by_season = {s: d for s, d in self.qbs.groupby("season")}
        self.priors_by_season = {s: d.set_index("team") for s, d in self.priors.groupby("season")}
        long = pd.concat([g[["season", "home", "home_div", "home_conf"]].set_axis(["season", "team", "div", "conf"], axis=1),
                          g[["season", "away", "away_div", "away_conf"]].set_axis(["season", "team", "div", "conf"], axis=1)])
        mode = lambda x: x.value_counts().index[0] if x.notna().any() else None
        dc = long.groupby(["season", "team"]).agg(div=("div", mode), conf=("conf", mode))
        self.div = dc["div"].to_dict()
        self.conf = {k: (v if (isinstance(v, str) and v != IND and self.div.get(k) == "fbs") else None)
                     for k, v in dc["conf"].to_dict().items()}
        names = pd.concat([g[["home", "home_name"]].set_axis(["team", "name"], axis=1),
                           g[["away", "away_name"]].set_axis(["team", "name"], axis=1)])
        self.team_name = dict(zip(names.team, names.name))


def _w(df, floor):
    return df.n_in.values + floor * df.n_out.values, df.epa_in.values + floor * df.epa_out.values


class CfbRatingPass:
    def __init__(self, tables, cfg=None):
        self.T = tables
        self.cfg = merge(DEFAULTS, cfg or {})

    # ------------------------------------------------------------ priors
    def _talent_z(self, S, teams, fbs):
        pr = self.T.priors_by_season.get(S)
        z = np.zeros(len(teams))
        if pr is None or "talent" not in pr.columns:
            return z
        v = np.array([pr.talent.get(t, np.nan) if t in pr.index else np.nan for t in teams], dtype=float)
        ok = fbs & np.isfinite(v)
        if ok.sum() > 20:
            z[ok] = (v[ok] - v[ok].mean()) / max(v[ok].std(), 1e-9)
        return z

    def _ret(self, S, teams, fbs, col):
        pr = self.T.priors_by_season.get(S)
        out = np.full(len(teams), np.nan)
        if pr is None or col not in pr.columns:
            return out
        v = np.array([pr[col].get(t, np.nan) if t in pr.index else np.nan for t in teams], dtype=float)
        ok = fbs & np.isfinite(v)
        out[ok] = v[ok] - v[ok].mean() if ok.sum() > 20 else 0.0
        return out

    def _unit_prior(self, S, unit, side, teams, div, end, group_end):
        """Prior means for one unit: FBS teams' carried deviations (centred),
        non-FBS teams' deviations from their division mean, the division means."""
        cfg = self.cfg
        fbs = div == "fbs"
        prev_fbs = [r[unit] for r in end.values() if r.get("div") == "fbs" and unit in r]
        m_prev = float(np.mean(prev_fbs)) if prev_fbs else 0.0
        dev = np.array([end[t][unit] - m_prev if (t in end and unit in end[t]) else np.nan for t in teams])
        conf = [self.T.conf.get((S, t)) for t in teams]
        cdev = np.full(len(teams), np.nan)
        by = defaultdict(list)
        for i, c in enumerate(conf):
            if c and fbs[i] and np.isfinite(dev[i]):
                by[c].append(dev[i])
        for i, c in enumerate(conf):
            if c and by.get(c):
                cdev[i] = float(np.mean(by[c]))
        cw = cfg["conf_w"]
        own = np.where(np.isfinite(dev), dev, np.where(np.isfinite(cdev), cdev, 0.0))
        base = (1 - cw) * own + cw * np.where(np.isfinite(cdev), cdev, own)
        ret = self._ret(S, teams, fbs, "ret_off" if side == "off" else "ret_def")
        mult = np.where(np.isfinite(ret), np.clip(1.0 + cfg["retprod"] * ret, 0.0, 2.0), 1.0)
        tz = self._talent_z(S, teams, fbs)
        sign = 1.0 if side == "off" else -1.0
        pm = cfg["carry"][side] * mult * base + sign * cfg["talent"][side] * tz
        pm = np.where(fbs, pm, 0.0)
        if fbs.any():
            pm[fbs] -= pm[fbs].mean()
        # non-FBS: own deviation from its division's mean, carried
        for i, t in enumerate(teams):
            if not fbs[i] and t in end and unit in end[t]:
                pm[i] = cfg["carry"]["lower"] * (end[t][unit] - group_end[unit].get(div[i], 0.0))
        return pm, {g: group_end[unit].get(g, 0.0) for g in GROUPS}

    def _new_qb_prior(self, S, debut):
        out = {}
        for g in ("fbs",) + GROUPS:
            num = sum(v[0] for (s, gg), v in debut.items() if s < S and gg == g)
            den = sum(v[1] for (s, gg), v in debut.items() if s < S and gg == g)
            out[g] = num / den if den > 300 else -0.05
        return out

    # --------------------------------------------------------------- fits
    def _fit_unit(self, rows, teams, tix, div, qb_ids, prior, lam, use_qb, mu_prior):
        """rows: (team, opp, game_id, [qb_id], n, epa, w).
        Parameter layout: [mu, H, O(teams), D(teams), Q(qbs), Goff(GROUPS), Gdef(GROUPS)]."""
        nT = len(teams)
        qix = {q: i for i, q in enumerate(qb_ids)} if use_qb else {}
        nQ = len(qix)
        g0 = 2 + 2 * nT + nQ
        n_par = g0 + 2 * len(GROUPS)
        fbs = div == "fbs"
        pm = np.zeros(n_par)
        pp = np.zeros(n_par)
        pm[0], pp[0] = mu_prior, lam["mu"]
        pm[1], pp[1] = 0.0, lam["home"]
        pm[2:2 + nT] = prior["off"]
        pm[2 + nT:2 + 2 * nT] = prior["def"]
        lower_lam = lam["lower"] if self.cfg["fcs_teams"] else 1e9
        pp[2:2 + nT] = np.where(fbs, lam["off"], lower_lam)
        pp[2 + nT:2 + 2 * nT] = np.where(fbs, lam["def"], lower_lam)
        for q, i in qix.items():
            pm[2 + 2 * nT + i] = prior["qb"](q)
            pp[2 + 2 * nT + i] = lam["qb"]
        for k, g in enumerate(GROUPS):
            pm[g0 + k], pp[g0 + k] = prior["g_off"][g], lam["group"]
            pm[g0 + len(GROUPS) + k], pp[g0 + len(GROUPS) + k] = prior["g_def"][g], lam["group"]
        gidx = np.array([GROUPS.index(d) if d in GROUPS else -1 for d in div])
        if len(rows):
            n = len(rows)
            idx = np.arange(n)
            home = np.array([(self.T.home_of.get(g) == t) and not self.T.neutral_of.get(g, 0)
                             for g, t in zip(rows.game_id.values, rows.team.values)], dtype=float)
            oi = np.array([tix[t] for t in rows.team.values])
            di = np.array([tix[t] for t in rows.opp.values])
            ri = [idx, idx, idx, idx]
            ci = [np.zeros(n, int), np.ones(n, int), 2 + oi, 2 + nT + di]
            vi = [np.ones(n), home, np.ones(n), np.ones(n)]
            if use_qb:
                qi = np.array([qix[q] for q in rows.qb_id.values])
                ri.append(idx)
                ci.append(2 + 2 * nT + qi)
                vi.append(np.ones(n))
            go, gd = gidx[oi], gidx[di]
            for sel, base in ((go >= 0, g0), (gd >= 0, g0 + len(GROUPS))):
                if sel.any():
                    ri.append(idx[sel])
                    ci.append(base + (go if base == g0 else gd)[sel])
                    vi.append(np.ones(int(sel.sum())))
            y = rows.epa.values / np.maximum(rows.n.values, 1e-9)
            theta, fp, fd, _ = penalized_wls(np.concatenate(ri), np.concatenate(ci), np.concatenate(vi),
                                             y, rows.w.values, n_par, pm, pp)
        else:
            theta, fp = pm.copy(), pm.copy()
        def absolute(vec, start, gstart):
            v = vec[start:start + nT].copy()
            for k in range(len(GROUPS)):
                v[gidx == k] += vec[gstart + k]
            return v
        return {"mu": theta[0], "home": theta[1],
                "off": absolute(theta, 2, g0), "def": absolute(theta, 2 + nT, g0 + len(GROUPS)),
                "off_prior": absolute(fp, 2, g0), "def_prior": absolute(fp, 2 + nT, g0 + len(GROUPS)),
                "g_off": {g: theta[g0 + k] for k, g in enumerate(GROUPS)},
                "g_def": {g: theta[g0 + len(GROUPS) + k] for k, g in enumerate(GROUPS)},
                "qb": {q: theta[2 + 2 * nT + i] for q, i in qix.items()},
                "qb_prior": {q: fp[2 + 2 * nT + i] for q, i in qix.items()}}

    def _fit_market(self, games_before, teams, tix, div, prior, cfg, week, kind):
        """[base, M(teams), Gm(GROUPS)]; the margin form is home minus away, the
        total form is the sum."""
        nT = len(teams)
        g0 = 1 + nT
        n_par = g0 + len(GROUPS)
        pm = np.zeros(n_par)
        pp = np.zeros(n_par)
        pm[0], pp[0] = prior["base"], cfg.get("lam_hfa", 20.0)
        pm[1:1 + nT], pp[1:1 + nT] = prior["team"], cfg["lam"]
        for k, g in enumerate(GROUPS):
            pm[g0 + k], pp[g0 + k] = prior["group"][g], cfg["lam_group"]
        gidx = np.array([GROUPS.index(d) if d in GROUPS else -1 for d in div])
        col = ("mkt_margin" if "mkt_margin" in games_before.columns else "close_margin") if kind == "margin" else "close_total"
        g = games_before[games_before[col].notna()]
        if len(g):
            n = len(g)
            idx = np.arange(n)
            hi = np.array([tix[t] for t in g.home.values])
            ai = np.array([tix[t] for t in g.away.values])
            sgn = -1.0 if kind == "margin" else 1.0
            ri = [idx, idx, idx]
            ci = [np.zeros(n, int), 1 + hi, 1 + ai]
            vi = [(1.0 - g.neutral.values) if kind == "margin" else np.ones(n), np.ones(n), np.full(n, sgn)]
            for side_idx, v in ((hi, 1.0), (ai, sgn)):
                gg = gidx[side_idx]
                sel = gg >= 0
                if sel.any():
                    ri.append(idx[sel])
                    ci.append(g0 + gg[sel])
                    vi.append(np.full(int(sel.sum()), v))
            w = recency_weights(week - g.slate.values - 1, cfg["hl_week"])
            theta, fp, fd, _ = penalized_wls(np.concatenate(ri), np.concatenate(ci), np.concatenate(vi),
                                             g[col].values.astype(float), w, n_par, pm, pp)
        else:
            theta, fp = pm.copy(), pm.copy()
        def absolute(vec):
            v = vec[1:1 + nT].copy()
            for k in range(len(GROUPS)):
                v[gidx == k] += vec[g0 + k]
            return v
        return {"base": theta[0], "team": absolute(theta), "team_prior": absolute(fp),
                "group": {gg: theta[g0 + k] for k, gg in enumerate(GROUPS)}}

    def _market_prior(self, teams, div, end_vals, end_div, group_end, base, carry):
        fbs = div == "fbs"
        prev = [v for t, v in end_vals.items() if end_div.get(t) == "fbs"]
        m_prev = float(np.mean(prev)) if prev else 0.0
        pm = np.zeros(len(teams))
        for i, t in enumerate(teams):
            if t not in end_vals:
                continue
            if fbs[i]:
                pm[i] = carry * (end_vals[t] - m_prev)
            else:                       # deviation from its division's mean
                pm[i] = carry * (end_vals[t] - group_end.get(div[i], 0.0))
        if fbs.any():
            pm[fbs] -= pm[fbs].mean()
        return {"base": base, "team": pm, "group": dict(group_end)}

    # ---------------------------------------------------------------- run
    def run(self, seasons, keep_snapshots_for=(), qb_overrides=None, qb_alternates=None):
        """qb_overrides: {game_id: (home_qb_id, away_qb_id)} for upcoming games
        (the card build passes the expected starter; the backtest passes none
        and prices the quarterback who actually took the most dropbacks)."""
        cfg = self.cfg
        self.qb_overrides = qb_overrides or {}
        self.qb_alternates = qb_alternates or {}
        floor = cfg["garbage_floor"]
        L = cfg["lam"]
        lam_p = {"off": L["pass_off"], "def": L["pass_def"], "qb": L["qb"], "mu": L["mu"], "home": L["home"],
                 "lower": L["lower"], "group": L["group"]}
        lam_r = {"off": L["rush_off"], "def": L["rush_def"], "mu": L["mu"], "home": L["home"],
                 "lower": L["lower"], "group": L["group"]}
        end = {}                       # team -> {unit: absolute end-of-season rating, "div": division}
        group_end = {u: {g: 0.0 for g in GROUPS} for u in UNITS}
        qb_end = {}                    # qb -> (value, last season)
        mkt_end, mkt_div, tot_end = {}, {}, {}
        mkt_group, tot_group = {g: 0.0 for g in GROUPS}, {g: 0.0 for g in GROUPS}
        mkt_base, tot_base = 2.5, 52.0
        mu_end = {"pass": 0.0, "rush": 0.0}
        debut = {}
        seen_qb = set()
        rows_out = []
        snapshots = {}
        for S in seasons:
            sched = self.T.by_season.get(S)
            if sched is None:
                continue
            teams = sorted(set(sched.home) | set(sched.away))
            tix = {t: i for i, t in enumerate(teams)}
            div = np.array([self.T.div.get((S, t), "fcs") for t in teams])
            U = self.T.units_by_season.get(S, self.T.units.iloc[:0])
            Q = self.T.qbs_by_season.get(S, self.T.qbs.iloc[:0])
            new_qb = self._new_qb_prior(S, debut)
            c = cfg["carry"]
            pri = {}
            for unit_name, unit_key, side in (("pass", "pass_off", "off"), ("pass", "pass_def", "def"),
                                              ("rush", "rush_off", "off"), ("rush", "rush_def", "def")):
                pm, gm = self._unit_prior(S, unit_key, side, teams, div, end, group_end)
                pri.setdefault(unit_name, {})[side] = pm
                pri[unit_name]["g_" + side] = gm
            team_group = {t: div[i] for t, i in tix.items()}

            def qb_prior(q, S=S, team=None):
                if q in qb_end:
                    v, last = qb_end[q]
                    return v * c["qb"] * (c["qb_gap"] ** max(0, S - 1 - last))
                return new_qb.get(team_group.get(team, "fbs") if team is not None else "fbs", -0.05)
            qb_team = {}               # a debut quarterback's division prior follows his team
            for col, tcol in (("home_qb_id", "home"), ("away_qb_id", "away")):
                for q, t in zip(sched[col].values, sched[tcol].values):
                    if isinstance(q, str):
                        qb_team.setdefault(q, t)
            if len(Q):
                for q, t in zip(Q.qb_id.values, Q.team.values):
                    qb_team.setdefault(q, t)
            pri["pass"]["qb"] = lambda q: qb_prior(q, team=qb_team.get(q))
            mk, tk = cfg["market"], cfg["totals_market"]
            mprior = self._market_prior(teams, div, mkt_end, mkt_div, mkt_group, mkt_base, mk["carry"])
            tprior = self._market_prior(teams, div, tot_end, mkt_div, tot_group, tot_base, tk["carry"])

            weeks = sorted(sched.slate.unique())
            for W in weeks + [max(weeks) + 1]:
                last = W > max(weeks)
                u = U[U.week < W]
                def frame(d, with_qb):
                    n, e = _w(d, floor)
                    f = pd.DataFrame({"team": d.team.values, "opp": d.opp.values, "game_id": d.game_id.values,
                                      "n": n, "epa": e, "w": n * recency_weights(W - d.week.values - 1, cfg["hl_week"])})
                    if with_qb:
                        f["qb_id"] = d.qb_id.astype(str).values
                    f = f[f.n > 0]
                    return f[f.team.isin(tix) & f.opp.isin(tix)]
                use_qb = cfg["qb_layer"]
                pass_rows = frame(Q[Q.week < W], True) if use_qb else frame(u[u.unit == "pass"], False)
                rush_rows = frame(u[u.unit == "rush"], False)
                wk_games = sched[sched.slate == W] if not last else sched.iloc[:0]
                starters = set(str(x) for x in pd.concat([wk_games.home_qb_id, wk_games.away_qb_id]).dropna())
                for gid in wk_games.game_id:
                    starters |= set(x for x in self.qb_overrides.get(gid, ()) if x)
                    starters |= set(x for x in self.qb_alternates.get(gid, ()) if x)
                qb_ids = sorted(set(pass_rows.qb_id) | starters) if use_qb else []
                fp = self._fit_unit(pass_rows, teams, tix, div, qb_ids, pri["pass"], lam_p, use_qb, mu_end["pass"])
                fr = self._fit_unit(rush_rows, teams, tix, div, [], pri["rush"], lam_r, False, mu_end["rush"])
                gb = sched[sched.slate < W]
                fm = self._fit_market(gb, teams, tix, div, mprior, mk, W, "margin") if mk["on"] else None
                ft = self._fit_market(gb, teams, tix, div, tprior, tk, W, "total") if tk["on"] else None
                if last:
                    for t, i in tix.items():
                        end[t] = {"pass_off": fp["off"][i], "pass_def": fp["def"][i],
                                  "rush_off": fr["off"][i], "rush_def": fr["def"][i], "div": div[i]}
                    for unit_key, f, side in (("pass_off", fp, "off"), ("pass_def", fp, "def"),
                                              ("rush_off", fr, "off"), ("rush_def", fr, "def")):
                        for g in GROUPS:
                            group_end[unit_key][g] = f["g_" + side][g]
                    played = set(Q.qb_id.astype(str)) if len(Q) else set()
                    nq = Q.assign(n=Q.n_in + Q.n_out).groupby("qb_id").n.sum().to_dict() if len(Q) else {}
                    for q, v in fp["qb"].items():
                        if q in played:
                            qb_end[q] = (v, S)
                            if q not in seen_qb and S > seasons[0]:
                                g = team_group.get(qb_team.get(q), "fbs")
                                num, den = debut.get((S, g), (0.0, 0.0))
                                debut[(S, g)] = (num + v * nq.get(q, 0.0), den + nq.get(q, 0.0))
                    seen_qb |= played
                    if fm is not None:
                        mkt_end = {t: fm["team"][i] for t, i in tix.items()}
                        mkt_div = {t: div[i] for t, i in tix.items()}
                        mkt_group, mkt_base = fm["group"], fm["base"]
                    if ft is not None:
                        tot_end = {t: ft["team"][i] for t, i in tix.items()}
                        tot_group, tot_base = ft["group"], ft["base"]
                    mu_end = {"pass": fp["mu"], "rush": fr["mu"]}
                    break
                for g in wk_games.itertuples(index=False):
                    rows_out.append(self._game_row(g, tix, fp, fr, fm, ft, use_qb, qb_prior))
                if S in keep_snapshots_for:
                    snapshots[(S, W)] = self._snapshot(teams, tix, div, fp, fr, fm, ft)
        return pd.DataFrame(rows_out), snapshots

    def _game_row(self, g, tix, fp, fr, fm, ft, use_qb, qb_prior):
        h, a = tix[g.home], tix[g.away]
        hq = str(g.home_qb_id) if isinstance(g.home_qb_id, str) else None
        aq = str(g.away_qb_id) if isinstance(g.away_qb_id, str) else None
        ov = self.qb_overrides.get(g.game_id)
        if ov:
            hq, aq = ov[0] or hq, ov[1] or aq
        def qv(q, team, prior=False):
            if not use_qb or q is None:
                return 0.0
            d = fp["qb_prior"] if prior else fp["qb"]
            return d[q] if q in d else qb_prior(q, team=team)
        r = {"game_id": g.game_id, "season": int(g.season), "week": int(g.week), "slate": int(g.slate),
             "season_type": g.season_type, "kick_utc": g.kick_utc,
             "home": g.home, "away": g.away, "home_name": g.home_name, "away_name": g.away_name,
             "home_div": g.home_div, "away_div": g.away_div, "home_conf": g.home_conf, "away_conf": g.away_conf,
             "neutral": int(g.neutral), "conf_game": int(g.conf_game),
             "result": g.result, "total_pts": g.total_pts, "close_margin": g.close_margin, "close_total": g.close_total,
             "open_margin": g.open_margin, "home_ml": g.home_ml, "away_ml": g.away_ml,
             "home_rest": g.home_rest, "away_rest": g.away_rest,
             "home_qb_id": hq, "away_qb_id": aq,
             "home_qb_name": self.T.qb_name.get(hq) if hq else None, "away_qb_name": self.T.qb_name.get(aq) if aq else None,
             # rating differences, oriented so + favours the home side (division means included)
             "x_pass_off": fp["off"][h] - fp["off"][a],
             "x_qb": qv(hq, g.home) - qv(aq, g.away),
             "x_pass_def": fp["def"][a] - fp["def"][h],
             "x_rush_off": fr["off"][h] - fr["off"][a],
             "x_rush_def": fr["def"][a] - fr["def"][h],
             "x_market": (fm["team"][h] - fm["team"][a]) if fm is not None else 0.0,
             # the same differences from the prior alone (the rest is this season's data)
             "p_pass_off": fp["off_prior"][h] - fp["off_prior"][a],
             "p_qb": qv(hq, g.home, True) - qv(aq, g.away, True),
             "p_pass_def": fp["def_prior"][a] - fp["def_prior"][h],
             "p_rush_off": fr["off_prior"][h] - fr["off_prior"][a],
             "p_rush_def": fr["def_prior"][a] - fr["def_prior"][h],
             "p_market": (fm["team_prior"][h] - fm["team_prior"][a]) if fm is not None else 0.0,
             # totals inputs: both offenses' expected EPA per play, and the market's total rating
             "t_pass_sum": (2 * fp["mu"] + fp["off"][h] + fp["off"][a] + fp["def"][h] + fp["def"][a] + qv(hq, g.home) + qv(aq, g.away)),
             "t_rush_sum": (2 * fr["mu"] + fr["off"][h] + fr["off"][a] + fr["def"][h] + fr["def"][a]),
             "t_market": (ft["base"] + ft["team"][h] + ft["team"][a]) if ft is not None else np.nan,
             "mkt_hfa": fm["base"] if fm is not None else np.nan}
        alt = self.qb_alternates.get(g.game_id)
        if alt:
            r["x_qb_alt_home"] = (qv(alt[0], g.home) - qv(aq, g.away)) if alt[0] else np.nan
            r["x_qb_alt_away"] = (qv(hq, g.home) - qv(alt[1], g.away)) if alt[1] else np.nan
        return r

    def _snapshot(self, teams, tix, div, fp, fr, fm, ft):
        return {"teams": {int(t): {"div": str(div[i]), "pass_off": float(fp["off"][i]), "pass_def": float(fp["def"][i]),
                                   "rush_off": float(fr["off"][i]), "rush_def": float(fr["def"][i]),
                                   "pass_off_prior": float(fp["off_prior"][i]), "pass_def_prior": float(fp["def_prior"][i]),
                                   "rush_off_prior": float(fr["off_prior"][i]), "rush_def_prior": float(fr["def_prior"][i]),
                                   "market": float(fm["team"][i]) if fm is not None else None,
                                   "total": float(ft["team"][i]) if ft is not None else None} for t, i in tix.items()},
                "qb": {q: float(v) for q, v in fp["qb"].items()},
                "mu": {"pass": float(fp["mu"]), "rush": float(fr["mu"])},
                "home_epa": {"pass": float(fp["home"]), "rush": float(fr["home"])},
                "division_means": {"pass_off": {k: float(v) for k, v in fp["g_off"].items()},
                                   "pass_def": {k: float(v) for k, v in fp["g_def"].items()},
                                   "rush_off": {k: float(v) for k, v in fr["g_off"].items()},
                                   "rush_def": {k: float(v) for k, v in fr["g_def"].items()},
                                   "market": {k: float(v) for k, v in fm["group"].items()} if fm is not None else None},
                "market_base": float(fm["base"]) if fm is not None else None,
                "total_base": float(ft["base"]) if ft is not None else None}
