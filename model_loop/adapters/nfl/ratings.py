"""The NFL rating pass: one chronological sweep that, before every week,
fits opponent-adjusted unit ratings from that season's plays and records the
pregame inputs of each game in the week.

Per week W of season S (only plays from weeks < W, so every input is pregame):

  pass:  EPA/dropback = mu_p + H_p*home + O_pass[off] + D_pass[def] + Q[dropback QB]
  rush:  EPA/rush     = mu_r + H_r*home + O_rush[off] + D_rush[def]
  market: close margin = hm*(1-neutral) + M[home] - M[away]          (prior weeks' closes)
  totals: close total  = t0 + T[home] + T[away]

Each observation is one (game, offense[, QB]) aggregate weighted by its plays,
where plays outside the competitive window (win probability below 10% or above
90%) count `garbage_floor` of a play, and by recency 0.5 ** (weeks ago / hl).
Every parameter is pulled toward a prior (penalized_wls): last season's
rating regressed by `carry`, re-centred, plus personnel moves; the strength
of each pull (`lam`, in plays of evidence) is fitted on history, so the
prior's share falls as the season's evidence accumulates.

The quarterback is a parameter of his own and travels with the player, so a
benching, an injury or a trade moves the pass rating the moment a different
starter is named, and the team's pass rating is what remains: line, receivers,
scheme.
"""
import math
from collections import defaultdict

import numpy as np
import pandas as pd

from ...core.ratings import penalized_wls, recency_weights

UNITS = ("pass_off", "pass_def", "rush_off", "rush_def")

DEFAULTS = {
    "garbage_floor": 0.25,          # 1.0 = no garbage-time filter
    "hl_week": 6.0,                 # in-season recency half-life, weeks (None = no decay)
    "lam": {"pass_off": 300.0, "pass_def": 600.0, "rush_off": 300.0, "rush_def": 600.0,
            "qb": 250.0, "mu": 100.0, "home": 3000.0},
    "carry": {"off": 0.6, "def": 0.4, "qb": 0.8, "qb_gap": 0.8},
    "qb_layer": True,
    "personnel": {"skill": 0.0, "skill_shrink": 50.0, "ol": 0.0},
    "market": {"on": True, "hl_week": 4.0, "lam": 3.0, "carry": 0.6, "lam_hfa": 20.0},
    "totals_market": {"on": True, "hl_week": 4.0, "lam": 3.0, "carry": 0.6},
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
        self.skill = rd("skill")
        self.roster = rd("roster_w1")
        self.players = rd("players")
        self.ol = rd("ol_snaps")
        self.pos = dict(zip(self.players.gsis_id.astype(str), self.players.position.astype(str)))
        self.draft = dict(zip(self.players.gsis_id.astype(str), self.players.draft_number))
        self.qb_name = dict(zip(self.players.gsis_id.astype(str), self.players.name.astype(str)))
        g = self.games
        self.home_of = dict(zip(g.game_id, g.home))
        self.by_season = {s: d.sort_values(["week", "kick_et", "game_id"]) for s, d in g.groupby("season")}
        self.units_by_season = {s: d for s, d in self.units.groupby("season")}
        self.qbs_by_season = {s: d for s, d in self.qbs.groupby("season")}


def _w(df, floor):
    return df.n_in.values + floor * df.n_out.values, df.epa_in.values + floor * df.epa_out.values


def draft_bucket(d):
    if d is None or not np.isfinite(d):
        return "undrafted"
    d = float(d)
    return "pick_1_10" if d <= 10 else "pick_11_32" if d <= 32 else "pick_33_100" if d <= 100 else "pick_101_plus"


class NflRatingPass:
    def __init__(self, tables, cfg=None):
        self.T = tables
        self.cfg = merge(DEFAULTS, cfg or {})

    # ------------------------------------------------------------ priors
    def _new_qb_prior(self, season, debut):
        """Mean debut-season EPA/dropback above the league, by draft bucket,
        from debuts in seasons before `season` only."""
        rows = [v for (s, b), v in debut.items() if s < season]
        by = defaultdict(lambda: [0.0, 0.0])
        for (s, b), (num, den) in debut.items():
            if s < season:
                by[b][0] += num
                by[b][1] += den
        out = {b: (v[0] / v[1] if v[1] > 200 else -0.10) for b, v in by.items()}
        for b in ("pick_1_10", "pick_11_32", "pick_33_100", "pick_101_plus", "undrafted"):
            out.setdefault(b, -0.10)
        return out

    def _personnel(self, season, teams, prev_unit_plays):
        """Skill-player production that arrived minus what left (EPA/play of
        the receiving unit), and the share of last season's OL snaps that
        returned. Inputs are last season's plays and this season's week-1
        roster; nothing from the season being predicted."""
        p = self.cfg["personnel"]
        out = {t: {"rush": 0.0, "rec": 0.0, "ol": 0.0} for t in teams}
        prev = season - 1
        sk = self.T.skill[self.T.skill.season == prev]
        if (p["skill"] or p["ol"]) and len(sk):
            ros = self.T.roster[self.T.roster.season == season]
            on_team = dict(zip(ros.gsis_id.astype(str), ros.team))
            for role, unit in (("rush", "rush"), ("rec", "pass")):
                r = sk[(sk.role == role)].copy()
                r = r[[self.T.pos.get(str(x), "") != "QB" for x in r.player_id]]
                m = r.epa_sum.sum() / max(1, r.n.sum())
                k = p["skill_shrink"]
                r["val"] = (r.epa_sum - m * r.n) * (r.n / (r.n + k))
                tot = r.groupby("player_id").val.sum()
                out_left = r.groupby("team").val.sum()
                incoming = defaultdict(float)
                for pid, v in tot.items():
                    t = on_team.get(str(pid))
                    if t is not None:
                        incoming[t] += v
                for t in teams:
                    plays = prev_unit_plays.get((t, unit), 0)
                    if plays > 0:
                        out[t][role] = (incoming.get(t, 0.0) - out_left.get(t, 0.0)) / plays
        ol = self.T.ol[self.T.ol.season == prev]
        if p["ol"] and len(ol):
            ros = self.T.roster[self.T.roster.season == season]
            pfr_team = dict(zip(ros.pfr_id.astype(str), ros.team))
            share = {}
            for t, d in ol.groupby("team"):
                tot = d.offense_snaps.sum()
                ret = sum(s for pid, s in zip(d.pfr_player_id.astype(str), d.offense_snaps) if pfr_team.get(pid) == t)
                share[t] = ret / tot if tot > 0 else np.nan
            vals = [v for v in share.values() if np.isfinite(v)]
            mean = float(np.mean(vals)) if vals else 0.0
            for t in teams:
                v = share.get(t)
                out[t]["ol"] = (v - mean) if v is not None and np.isfinite(v) else 0.0
        return out

    # --------------------------------------------------------------- fits
    def _fit_unit(self, rows, teams, tix, qb_ids, prior, lam, use_qb, mu_prior):
        """rows: DataFrame of (team, opp, game_id, [qb_id], n, epa, w).
        Parameter layout: [mu, H, O(teams), D(teams), Q(qb_ids)]."""
        nT = len(teams)
        qix = {q: i for i, q in enumerate(qb_ids)} if use_qb else {}
        n_par = 2 + 2 * nT + len(qix)
        pm = np.zeros(n_par)
        pp = np.zeros(n_par)
        pm[0], pp[0] = mu_prior, lam["mu"]
        pm[1], pp[1] = 0.0, lam["home"]
        pm[2:2 + nT] = prior["off"]
        pp[2:2 + nT] = lam["off"]
        pm[2 + nT:2 + 2 * nT] = prior["def"]
        pp[2 + nT:2 + 2 * nT] = lam["def"]
        for q, i in qix.items():
            pm[2 + 2 * nT + i] = prior["qb"](q)
            pp[2 + 2 * nT + i] = lam["qb"]
        if len(rows):
            n = len(rows)
            ri, ci, vi = [], [], []
            idx = np.arange(n)
            home = np.array([self.T.home_of.get(g) == t for g, t in zip(rows.game_id.values, rows.team.values)], dtype=float)
            oi = np.array([tix[t] for t in rows.team.values])
            di = np.array([tix[t] for t in rows.opp.values])
            ri += [idx, idx, idx, idx]
            ci += [np.zeros(n, int), np.ones(n, int), 2 + oi, 2 + nT + di]
            vi += [np.ones(n), home, np.ones(n), np.ones(n)]
            if use_qb:
                qi = np.array([qix[q] for q in rows.qb_id.values])
                ri.append(idx)
                ci.append(2 + 2 * nT + qi)
                vi.append(np.ones(n))
            y = rows.epa.values / np.maximum(rows.n.values, 1e-9)
            theta, fp, fd, _ = penalized_wls(np.concatenate(ri), np.concatenate(ci), np.concatenate(vi),
                                             y, rows.w.values, n_par, pm, pp)
        else:
            theta, fp, fd = pm.copy(), pm.copy(), np.zeros(n_par)
        res = {"mu": theta[0], "home": theta[1],
               "off": theta[2:2 + nT], "def": theta[2 + nT:2 + 2 * nT],
               "off_prior": fp[2:2 + nT], "def_prior": fp[2 + nT:2 + 2 * nT],
               "qb": {q: theta[2 + 2 * nT + i] for q, i in qix.items()},
               "qb_prior": {q: fp[2 + 2 * nT + i] for q, i in qix.items()}}
        return res

    def _fit_market(self, games_before, teams, tix, prior, cfg, week, kind):
        nT = len(teams)
        n_par = 1 + nT
        pm = np.zeros(n_par)
        pp = np.zeros(n_par)
        pm[0] = prior["base"]
        pp[0] = cfg.get("lam_hfa", 20.0)
        pm[1:] = prior["team"]
        pp[1:] = cfg["lam"]
        col = "close_margin" if kind == "margin" else "close_total"
        g = games_before[games_before[col].notna()]
        if len(g):
            n = len(g)
            idx = np.arange(n)
            hi = np.array([tix[t] for t in g.home.values])
            ai = np.array([tix[t] for t in g.away.values])
            if kind == "margin":
                rows = np.concatenate([idx, idx, idx])
                cols = np.concatenate([np.zeros(n, int), 1 + hi, 1 + ai])
                vals = np.concatenate([1.0 - g.neutral.values, np.ones(n), -np.ones(n)])
            else:
                rows = np.concatenate([idx, idx, idx])
                cols = np.concatenate([np.zeros(n, int), 1 + hi, 1 + ai])
                vals = np.ones(3 * n)
            w = recency_weights(week - g.week.values - 1, cfg["hl_week"])
            theta, fp, fd, _ = penalized_wls(rows, cols, vals, g[col].values.astype(float), w, n_par, pm, pp)
        else:
            theta, fp = pm.copy(), pm.copy()
        return {"base": theta[0], "team": theta[1:], "team_prior": fp[1:]}

    # ---------------------------------------------------------------- run
    def run(self, seasons, keep_snapshots_for=(), qb_overrides=None, qb_alternates=None):
        """qb_overrides: {game_id: (home_qb_id, away_qb_id)} for upcoming
        games whose starter the schedule feed has wrong or blank (the card
        build passes the reconciled starter; the backtest passes none and
        prices the starter who actually played)."""
        cfg = self.cfg
        self.qb_overrides = qb_overrides or {}
        # {game_id: (home_alt, away_alt)}: the other name when the starter is
        # contested, priced beside the main number as a scenario
        self.qb_alternates = qb_alternates or {}
        floor = cfg["garbage_floor"]
        lam_p = {"off": cfg["lam"]["pass_off"], "def": cfg["lam"]["pass_def"], "qb": cfg["lam"]["qb"],
                 "mu": cfg["lam"]["mu"], "home": cfg["lam"]["home"]}
        lam_r = {"off": cfg["lam"]["rush_off"], "def": cfg["lam"]["rush_def"],
                 "mu": cfg["lam"]["mu"], "home": cfg["lam"]["home"]}
        end = {}                       # team -> unit -> end-of-season rating
        qb_end = {}                    # qb -> (value, last season)
        mkt_end, tot_end = {}, {}
        mkt_base, tot_base = 1.5, 44.0
        mu_end = {"pass": 0.0, "rush": -0.06}
        debut = {}                     # (season, bucket) -> (sum epa above league, dropbacks)
        seen_qb = set()
        rows_out = []
        snapshots = {}
        prev_unit_plays = {}
        for S in seasons:
            sched = self.T.by_season.get(S)
            if sched is None:
                continue
            teams = sorted(set(sched.home) | set(sched.away))
            tix = {t: i for i, t in enumerate(teams)}
            U = self.T.units_by_season.get(S, self.T.units.iloc[:0])
            Q = self.T.qbs_by_season.get(S, self.T.qbs.iloc[:0])
            new_qb = self._new_qb_prior(S, debut)
            pers = self._personnel(S, teams, prev_unit_plays)
            c = cfg["carry"]

            def carried(unit, k):
                v = np.array([end.get(t, {}).get(unit, 0.0) for t in teams])
                return k * (v - v.mean())
            pri = {
                "pass": {"off": carried("pass_off", c["off"]) + cfg["personnel"]["skill"] * np.array([pers[t]["rec"] for t in teams])
                         + cfg["personnel"]["ol"] * np.array([pers[t]["ol"] for t in teams]),
                         "def": carried("pass_def", c["def"])},
                "rush": {"off": carried("rush_off", c["off"]) + cfg["personnel"]["skill"] * np.array([pers[t]["rush"] for t in teams])
                         + cfg["personnel"]["ol"] * np.array([pers[t]["ol"] for t in teams]),
                         "def": carried("rush_def", c["def"])},
            }

            def qb_prior(q, S=S):
                if q in qb_end:
                    v, last = qb_end[q]
                    return v * c["qb"] * (c["qb_gap"] ** max(0, S - 1 - last))
                return new_qb[draft_bucket(self.T.draft.get(str(q)))]
            pri["pass"]["qb"] = qb_prior
            mk = cfg["market"]
            mprior = {"base": mkt_base, "team": mk["carry"] * np.array([mkt_end.get(t, 0.0) for t in teams])}
            mprior["team"] -= mprior["team"].mean()
            tk = cfg["totals_market"]
            tprior = {"base": tot_base, "team": tk["carry"] * np.array([tot_end.get(t, 0.0) for t in teams])}
            tprior["team"] -= tprior["team"].mean()

            weeks = sorted(sched.week.unique())
            for W in weeks + [max(weeks) + 1]:
                last = W > max(weeks)
                rec_age = lambda wk: W - wk - 1
                u = U[U.week < W]
                up = u[u.unit == "pass"]
                ur = u[u.unit == "rush"]
                def frame(d, with_qb):
                    n, e = _w(d, floor)
                    f = pd.DataFrame({"team": d.team.values, "opp": d.opp.values, "game_id": d.game_id.values,
                                      "n": n, "epa": e, "w": n * recency_weights(rec_age(d.week.values), cfg["hl_week"])})
                    if with_qb:
                        f["qb_id"] = d.qb_id.astype(str).values
                    return f[f.n > 0]
                use_qb = cfg["qb_layer"]
                pass_rows = frame(Q[Q.week < W], True) if use_qb else frame(up, False)
                rush_rows = frame(ur, False)
                wk_games = sched[sched.week == W] if not last else sched.iloc[:0]
                starters = set(str(x) for x in pd.concat([wk_games.home_qb_id, wk_games.away_qb_id]).dropna())
                for gid in wk_games.game_id:
                    starters |= set(x for x in self.qb_overrides.get(gid, ()) if x)
                    starters |= set(x for x in self.qb_alternates.get(gid, ()) if x)
                qb_ids = sorted(set(pass_rows.qb_id) | starters) if use_qb else []
                fp = self._fit_unit(pass_rows, teams, tix, qb_ids, pri["pass"], lam_p, use_qb, mu_end["pass"])
                fr = self._fit_unit(rush_rows, teams, tix, [], pri["rush"], lam_r, False, mu_end["rush"])
                gb = sched[sched.week < W]
                fm = self._fit_market(gb, teams, tix, mprior, mk, W, "margin") if mk["on"] else None
                ft = self._fit_market(gb, teams, tix, tprior, tk, W, "total") if tk["on"] else None
                if last:
                    for t, i in tix.items():
                        end[t] = {"pass_off": fp["off"][i], "pass_def": fp["def"][i],
                                  "rush_off": fr["off"][i], "rush_def": fr["def"][i]}
                    for q, v in fp["qb"].items():
                        if (Q.qb_id.astype(str) == q).any():
                            qb_end[q] = (v, S)
                    if fm is not None:
                        mkt_end = {t: fm["team"][i] for t, i in tix.items()}
                        mkt_base = fm["base"]
                    if ft is not None:
                        tot_end = {t: ft["team"][i] for t, i in tix.items()}
                        tot_base = ft["base"]
                    mu_end = {"pass": fp["mu"], "rush": fr["mu"]}
                    break
                for _, g in wk_games.iterrows():
                    rows_out.append(self._game_row(g, tix, fp, fr, fm, ft, use_qb, qb_prior))
                if S in keep_snapshots_for:
                    snapshots[(S, W)] = self._snapshot(teams, tix, fp, fr, fm, ft)
            # what the next season's priors need from this one
            qa = Q.assign(qb_id=Q.qb_id.astype(str))
            if len(qa):
                lg = (qa.epa_in.sum() + qa.epa_out.sum()) / max(1, (qa.n_in.sum() + qa.n_out.sum()))
                for q, d in qa.groupby("qb_id"):
                    if q not in seen_qb and S > seasons[0]:
                        b = draft_bucket(self.T.draft.get(q))
                        n = d.n_in.sum() + d.n_out.sum()
                        num, den = debut.get((S, b), (0.0, 0.0))
                        debut[(S, b)] = (num + (d.epa_in.sum() + d.epa_out.sum()) - lg * n, den + n)
                    seen_qb.add(q)
            prev_unit_plays = {(t, un): (d.n_in.sum() + d.n_out.sum()) for (t, un), d in U.groupby(["team", "unit"])}
        return pd.DataFrame(rows_out), snapshots

    def _game_row(self, g, tix, fp, fr, fm, ft, use_qb, qb_prior):
        h, a = tix[g.home], tix[g.away]
        hq = str(g.home_qb_id) if isinstance(g.home_qb_id, str) else None
        aq = str(g.away_qb_id) if isinstance(g.away_qb_id, str) else None
        ov = getattr(self, "qb_overrides", {}).get(g.game_id)
        if ov:
            hq, aq = ov[0] or hq, ov[1] or aq
        def qv(q, prior=False):
            if not use_qb or q is None:
                return 0.0
            d = fp["qb_prior"] if prior else fp["qb"]
            if q in d:
                return d[q]
            return qb_prior(q)
        r = {"game_id": g.game_id, "season": int(g.season), "week": int(g.week), "game_type": g.game_type,
             "home": g.home, "away": g.away, "neutral": int(g.neutral),
             "result": g.result, "total_pts": g.total_pts, "close_margin": g.close_margin, "close_total": g.close_total,
             "home_ml": g.home_ml, "away_ml": g.away_ml, "div_game": int(g.div_game),
             "home_rest": g.home_rest, "away_rest": g.away_rest, "roof": g.roof, "temp": g.temp, "wind": g.wind,
             "stadium": g.stadium, "kick_et": g.kick_et,
             "home_qb_id": hq, "away_qb_id": aq,
             "home_qb_name": self.T.qb_name.get(hq, g.home_qb_name) if hq else None,
             "away_qb_name": self.T.qb_name.get(aq, g.away_qb_name) if aq else None,
             # rating differences, oriented so + favours the home side
             "x_pass_off": fp["off"][h] - fp["off"][a],
             "x_qb": qv(hq) - qv(aq),
             "x_pass_def": fp["def"][a] - fp["def"][h],
             "x_rush_off": fr["off"][h] - fr["off"][a],
             "x_rush_def": fr["def"][a] - fr["def"][h],
             "x_market": (fm["team"][h] - fm["team"][a]) if fm is not None else 0.0,
             # the same differences from the prior alone (the rest is this season's data)
             "p_pass_off": fp["off_prior"][h] - fp["off_prior"][a],
             "p_qb": qv(hq, True) - qv(aq, True),
             "p_pass_def": fp["def_prior"][a] - fp["def_prior"][h],
             "p_rush_off": fr["off_prior"][h] - fr["off_prior"][a],
             "p_rush_def": fr["def_prior"][a] - fr["def_prior"][h],
             "p_market": (fm["team_prior"][h] - fm["team_prior"][a]) if fm is not None else 0.0,
             # totals inputs: expected EPA per play of both offenses, and the market's total rating
             "t_pass_sum": (2 * fp["mu"] + fp["off"][h] + fp["off"][a] + fp["def"][h] + fp["def"][a] + qv(hq) + qv(aq)),
             "t_rush_sum": (2 * fr["mu"] + fr["off"][h] + fr["off"][a] + fr["def"][h] + fr["def"][a]),
             "t_market": (ft["base"] + ft["team"][h] + ft["team"][a]) if ft is not None else np.nan,
             "mkt_hfa": fm["base"] if fm is not None else np.nan}
        alt = getattr(self, "qb_alternates", {}).get(g.game_id)
        if alt:
            r["x_qb_alt_home"] = (qv(alt[0]) - qv(aq)) if alt[0] else np.nan
            r["x_qb_alt_away"] = (qv(hq) - qv(alt[1])) if alt[1] else np.nan
        return r

    def _snapshot(self, teams, tix, fp, fr, fm, ft):
        return {"teams": {t: {"pass_off": float(fp["off"][i]), "pass_def": float(fp["def"][i]),
                              "rush_off": float(fr["off"][i]), "rush_def": float(fr["def"][i]),
                              "pass_off_prior": float(fp["off_prior"][i]), "pass_def_prior": float(fp["def_prior"][i]),
                              "rush_off_prior": float(fr["off_prior"][i]), "rush_def_prior": float(fr["def_prior"][i]),
                              "market": float(fm["team"][i]) if fm is not None else None,
                              "total": float(ft["team"][i]) if ft is not None else None} for t, i in tix.items()},
                "qb": {q: float(v) for q, v in fp["qb"].items()},
                "mu": {"pass": float(fp["mu"]), "rush": float(fr["mu"])},
                "home_epa": {"pass": float(fp["home"]), "rush": float(fr["home"])},
                "market_base": float(fm["base"]) if fm is not None else None,
                "total_base": float(ft["base"]) if ft is not None else None}
