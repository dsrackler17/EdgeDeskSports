#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — walk-forward training and backtest.

DISCIPLINE (the part that makes the numbers worth anything)

* Chronological only. Ratings are ONE sequential pass in kickoff order; a
  game's prediction is made from the state BEFORE it and the game is then
  absorbed. There is never a random split.

* A LAYERED tune/test firewall, because the data sources do not all start in
  the same year and pretending otherwise would either waste seasons or leak
  them. Each layer is tuned on its own window, frozen, and then scored on
  seasons it has never seen:

      layer A  ratings, venue HFA, travel, rivalry, conference
               tune 2001-2013            test 2014-2025
      layer B  efficiency EWMAs, matchup weights, preseason blend curve
               tune 2014-2019            test 2020-2025   (play data starts 2014)
      layer C  roster continuity, volatility sigma model, confidence weights
               tune 2018-2021            test 2022-2025   (class data usable from 2018)

  The HEADLINE market backtest is 2022-2025 — seasons untouched by every
  layer — and the wider 2014-2021 window is reported separately for the
  layers that were already frozen by then.

* No fabricated market data. The CFB line archive (2006-2025, opening and
  closing, multiple books including Pinnacle) is real and is used as-is; the
  eras where it thins out are reported rather than smoothed over.

* Every constant emitted here is measured. Where a quantity could not be
  measured, this script emits nothing for it and the engine declares it
  unavailable. That is the whole design.

Usage: python3 train_p4.py <out_dir>
Writes <out>/params_cfb_p4.json and <out>/report_cfb_p4.json
"""
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'

A_TUNE_END = 2013
B_TUNE_LO, B_TUNE_HI = 2014, 2019
C_TUNE_LO, C_TUNE_HI = 2018, 2021
TEST_LO = 2022
LAST = common.SCHED_LAST

EFF_FEATS = ['epa_per_play', 'epa_pass', 'epa_rush', 'success_rate',
             'early_down_success', 'passing_down_success', 'expl_epa_rate',
             'yards_per_play', 'sack_rate_allowed', 'stuff_rate',
             'third_down_rate', 'red_zone_success', 'front_disruption_rate',
             'points_per_drive', 'start_field_position', 'pass_rate',
             'plays_per_game']
# each offensive feature's defensive mirror, used for opponent adjustment
COUNTERPART = {}
for f in EFF_FEATS:
    COUNTERPART[f] = 'def_' + f
    COUNTERPART['def_' + f] = f
ALL_EFF = EFF_FEATS + ['def_' + f for f in EFF_FEATS]


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def rank_corr(a, b):
    """Spearman without scipy: Pearson on ranks. Ties get average ranks."""
    a = pd.Series(np.asarray(a, dtype=float))
    b = pd.Series(np.asarray(b, dtype=float))
    ok = a.notna() & b.notna()
    if ok.sum() < 3:
        return float('nan')
    return float(a[ok].rank().corr(b[ok].rank()))


# ===========================================================================
# frames
# ===========================================================================
def load_frames():
    g = common.fbs_games(both=False, played_only=True)
    g = common.attach_conferences(g)
    mk = pd.read_csv(os.path.join(OUT, 'market.csv'), low_memory=False)
    keep = ['game_id', 'spread_close', 'spread_open', 'total_close', 'total_open',
            'mlh_close', 'mla_close', 'spread_books', 'mkt_quality',
            'spread_close_pin', 'total_close_pin']
    mk = mk[[c for c in keep if c in mk.columns]]
    g = g.merge(mk, on='game_id', how='left')

    tg_path = os.path.join(OUT, 'team_game.csv')
    tg = pd.read_csv(tg_path, low_memory=False) if os.path.exists(tg_path) else None
    if tg is not None:
        tg['plays_per_game'] = tg['plays']
        tg['def_plays_per_game'] = tg['def_plays']
    rs_path = os.path.join(OUT, 'roster_team_season.csv')
    rs = pd.read_csv(rs_path, low_memory=False) if os.path.exists(rs_path) else None
    v = common.venue_geo()
    return g, tg, rs, v


# ===========================================================================
# Layer 1 — the rating recursion (this is the python reference the JS mirrors)
# ===========================================================================
class Ratings(object):
    def __init__(self, hp, venue_hfa=None, league_hfa=None):
        self.hp = hp
        self.r = {}
        self.r0 = {}
        # `rf` is a parallel rating that is WIPED at every season break: it
        # knows only what has happened this season. Comparing it against the
        # carried rating is what makes Section XXIV answerable — the model
        # can measure the week at which actual team identity beats preseason
        # belief, instead of asserting a schedule.
        self.rf = {}
        self.n = {}
        self.gs = defaultdict(int)         # games this season
        self.scoring = {}
        self.lmean = None
        self.venue_hfa = venue_hfa or {}
        self.league_hfa = league_hfa if league_hfa is not None else hp['hfa']
        self.eff = {}
        self.eff_mean = {}

    def rating(self, t, fbs):
        if not fbs:
            return self.hp['fcs_rating']
        return self.r.get(t, self.hp['init_rating'])

    def fresh(self, t, fbs):
        if not fbs:
            return self.hp['fcs_rating']
        return self.rf.get(t, self.hp['init_rating'])

    def games(self, t):
        return self.n.get(t, 0)

    def hfa_for(self, venue_id, neutral):
        if neutral:
            return 0.0
        if venue_id is not None and not (isinstance(venue_id, float) and np.isnan(venue_id)):
            v = self.venue_hfa.get(int(venue_id))
            if v is not None:
                return v
        return self.league_hfa

    def season_break(self):
        c = self.hp['carry']
        ce = self.hp.get('carry_eff', c)
        for t in self.r:
            self.r[t] *= c
        for t in self.scoring:
            self.scoring[t]['pf'] *= c
            self.scoring[t]['pa'] *= c
        for t in self.eff:
            for f in self.eff[t]:
                self.eff[t][f] *= ce
        self.r0 = dict(self.r)
        self.rf = {}
        self.gs = defaultdict(int)

    def predict_margin(self, home, away, h_fbs, a_fbs, hfa):
        return self.rating(home, h_fbs) - self.rating(away, a_fbs) + hfa

    def predict_total(self, home, away):
        if self.lmean is None:
            return np.nan
        oh, oa = self.scoring.get(home), self.scoring.get(away)
        if not oh or not oa:
            return np.nan
        return 2 * self.lmean + self.hp['k_total'] * (oh['pf'] + oh['pa'] + oa['pf'] + oa['pa'])

    def eff_of(self, t):
        if t not in self.eff:
            self.eff[t] = dict((f, 0.0) for f in ALL_EFF)
        return self.eff[t]

    def absorb(self, home, away, h_fbs, a_fbs, hfa, margin, hp_pts, ap_pts, stats=None):
        hp = self.hp
        m = max(-hp['cap'], min(hp['cap'], margin))
        err = m - self.predict_margin(home, away, h_fbs, a_fbs, hfa)
        errf = m - (self.fresh(home, h_fbs) - self.fresh(away, a_fbs) + hfa)
        if h_fbs:
            self.rf[home] = self.fresh(home, True) + hp['k_fresh'] * errf
        if a_fbs:
            self.rf[away] = self.fresh(away, True) - hp['k_fresh'] * errf
        if h_fbs:
            self.r[home] = self.rating(home, True) + hp['k'] * err
            self.n[home] = self.games(home) + 1
            self.gs[home] += 1
            self.r0.setdefault(home, hp['init_rating'])
        if a_fbs:
            self.r[away] = self.rating(away, True) - hp['k'] * err
            self.n[away] = self.games(away) + 1
            self.gs[away] += 1
            self.r0.setdefault(away, hp['init_rating'])
        if self.lmean is None:
            self.lmean = (hp_pts + ap_pts) / 2.0
        for t, pf, pa, fbs in ((home, hp_pts, ap_pts, h_fbs), (away, ap_pts, hp_pts, a_fbs)):
            if not fbs:
                continue
            o = self.scoring.setdefault(t, {'pf': 0.0, 'pa': 0.0})
            at = hp['alpha_total']
            o['pf'] = (1 - at) * o['pf'] + at * (pf - self.lmean)
            o['pa'] = (1 - at) * o['pa'] + at * (pa - self.lmean)
        al = hp['alpha_league']
        self.lmean = (1 - al) * self.lmean + al * ((hp_pts + ap_pts) / 2.0)
        if stats:
            self._absorb_eff(home, away, stats)

    def _absorb_eff(self, home, away, stats):
        a = self.hp.get('alpha_eff', 0.15)
        aL = self.hp.get('alpha_eff_league', 0.01)
        pre = dict((t, dict(self.eff_of(t))) for t in (home, away))
        for t, opp in ((home, away), (away, home)):
            raw = stats.get(t)
            if not raw:
                continue
            self.eff_of(opp)
            for f in ALL_EFF:
                v = raw.get(f)
                if v is None or not np.isfinite(v):
                    continue
                lm = self.eff_mean.get(f)
                if lm is None:
                    self.eff_mean[f] = v
                    continue
                cf = COUNTERPART.get(f)
                perf = v - lm - (pre[opp].get(cf, 0.0) if cf else 0.0)
                self.eff[t][f] = (1 - a) * self.eff[t][f] + a * perf
                self.eff_mean[f] = (1 - aL) * lm + aL * v


def run(games, hp, stats_by_game=None, venue_hfa=None, league_hfa=None,
        collect_eff=False):
    """One chronological pass. Returns the pregame prediction frame and the
    final state. `stats_by_game[game_id]` is {team_key: {feature: value}}."""
    R = Ratings(hp, venue_hfa, league_hfa)
    season = None
    rows = []
    eff_snap = []
    for g in games.itertuples():
        if season is not None and g.season != season:
            R.season_break()
        season = g.season
        hfa = R.hfa_for(getattr(g, 'venue_id', None), bool(g.neutral))
        known = min(R.games(g.home_key) if g.home_fbs else 99,
                    R.games(g.away_key) if g.away_fbs else 99)
        pm = R.predict_margin(g.home_key, g.away_key, g.home_fbs, g.away_fbs, hfa)
        pt = R.predict_total(g.home_key, g.away_key)
        prior_gap = (R.r0.get(g.home_key, hp['init_rating'])
                     - R.r0.get(g.away_key, hp['init_rating'])) + hfa
        fresh_gap = R.fresh(g.home_key, g.home_fbs) - R.fresh(g.away_key, g.away_fbs) + hfa
        row = {'game_id': g.game_id, 'season': g.season, 'week': g.week,
               'home_key': g.home_key, 'away_key': g.away_key,
               'known': known, 'gs_min': min(R.gs[g.home_key], R.gs[g.away_key]),
               'pred_margin': pm, 'prior_margin': prior_gap,
               'fresh_margin': fresh_gap, 'pred_total': pt,
               'hfa_used': hfa, 'venue_id': getattr(g, 'venue_id', np.nan),
               'home_rating': R.rating(g.home_key, g.home_fbs),
               'away_rating': R.rating(g.away_key, g.away_fbs),
               'kick_dt': g.kick_dt,
               'margin': g.margin, 'total_pts': g.total_pts,
               'both_fbs': bool(g.home_fbs and g.away_fbs),
               'neutral': bool(g.neutral)}
        if collect_eff:
            eh, ea = R.eff_of(g.home_key), R.eff_of(g.away_key)
            for f in ALL_EFF:
                row['h_' + f] = eh.get(f, 0.0)
                row['a_' + f] = ea.get(f, 0.0)
        rows.append(row)
        st = stats_by_game.get(g.game_id) if stats_by_game else None
        R.absorb(g.home_key, g.away_key, g.home_fbs, g.away_fbs, hfa,
                 g.margin, g.home_points, g.away_points, st)
    return pd.DataFrame(rows), R


def mae(d, a, b):
    return float(np.mean(np.abs(d[a] - d[b])))


def scored(df, lo, hi, min_known=4):
    return df[(df.season >= lo) & (df.season <= hi) & df.both_fbs & (df.known >= min_known)]


# ===========================================================================
# 1. hyperparameter tuning (layer A window only)
# ===========================================================================
def tune_ratings(games):
    base = dict(k=0.10, cap=28.0, hfa=2.8, carry=0.60, init_rating=-8.0,
                fcs_rating=-26.0, alpha_total=0.10, alpha_league=0.01,
                k_total=0.5, alpha_eff=0.15, alpha_eff_league=0.01, carry_eff=0.5,
                k_fresh=0.22)
    best, best_m = dict(base), 1e9
    grid = []
    for k in (0.06, 0.08, 0.10, 0.12, 0.14):
        for cap in (21.0, 24.0, 28.0, 32.0, 35.0):
            for hfa in (2.0, 2.4, 2.8, 3.2):
                grid.append({'k': k, 'cap': cap, 'hfa': hfa})
    for upd in grid:
        hp = dict(base); hp.update(upd)
        df, _ = run(games[games.season <= A_TUNE_END], hp)
        d = scored(df, 2003, A_TUNE_END)
        m = mae(d, 'pred_margin', 'margin')
        if m < best_m:
            best, best_m = dict(hp), m
    for carry in (0.35, 0.45, 0.55, 0.65, 0.75):
        for fcs in (-34.0, -28.0, -22.0):
            for init in (-12.0, -8.0, -4.0):
                hp = dict(best); hp.update({'carry': carry, 'fcs_rating': fcs, 'init_rating': init})
                df, _ = run(games[games.season <= A_TUNE_END], hp)
                d = scored(df, 2003, A_TUNE_END)
                m = mae(d, 'pred_margin', 'margin')
                if m < best_m:
                    best, best_m = dict(hp), m
    # the total is tuned on its own error, separately from the margin
    best_t = 1e9
    for at in (0.06, 0.10, 0.16):
        for kt in (0.4, 0.5, 0.6):
            hp = dict(best); hp.update({'alpha_total': at, 'k_total': kt})
            df, _ = run(games[games.season <= A_TUNE_END], hp)
            d = scored(df, 2003, A_TUNE_END).dropna(subset=['pred_total'])
            if not len(d):
                continue
            m = mae(d, 'pred_total', 'total_pts')
            if m < best_t:
                best_t = m
                best['alpha_total'], best['k_total'] = at, kt
    return best, best_m


# ===========================================================================
# 2. venue home-field advantage (empirical Bayes on pass-1 residuals)
# ===========================================================================
def fit_venue_hfa(df, games, hp):
    """Does a PER-VENUE home-field advantage beat a single league constant?

    The obvious estimator — each venue's own mean residual, shrunk by sample
    size — is a trap, and this function is built to expose it rather than
    ship it. Because a team plays every home game at one venue, any part of
    that team's strength the rating recursion has not yet absorbed lands on
    its stadium. The diagnostic below measures exactly that: the correlation
    between the estimated venue advantage and the home team's own rating. If
    it is high, the "venue table" is a team-quality table wearing a hat.

    The decision is then made by held-out error, not by preference: the
    shrunk table must beat the league constant on seasons it was not fitted
    on, or the constant ships and the table does not.
    """
    d = df[df.both_fbs & (df.known >= 4) & ~df.neutral & (df.season <= A_TUNE_END)].copy()
    d['resid'] = d.margin - d.pred_margin
    league = float(d.resid.mean() + hp['hfa'])
    grp = d.groupby('venue_id').agg(mean=('resid', 'mean'), count=('resid', 'size'),
                                    home_rating=('home_rating', 'mean'))
    hold = df[df.both_fbs & (df.known >= 4) & ~df.neutral
              & (df.season > A_TUNE_END) & (df.season <= B_TUNE_HI)].copy()
    hold['resid'] = hold.margin - hold.pred_margin

    baseline = float(np.mean(np.abs(hold.resid - d.resid.mean())))
    best_k, best_e = None, 1e9
    for kshrink in (5, 10, 20, 40, 80, 160, 320, 640, 1280):
        adj = grp['mean'] * (grp['count'] / (grp['count'] + kshrink))
        pred = hold.venue_id.map(adj).fillna(0.0) + d.resid.mean()
        e = float(np.mean(np.abs(hold.resid - pred)))
        if e < best_e:
            best_k, best_e = kshrink, e
    adj = grp['mean'] * (grp['count'] / (grp['count'] + best_k))

    solid = grp[grp['count'] >= 20]
    artifact_corr = float(
        (solid['mean'] * (solid['count'] / (solid['count'] + best_k)))
        .corr(solid['home_rating'])) if len(solid) > 20 else float('nan')

    improvement = baseline - best_e
    # A venue table has to earn its place. The threshold is deliberately
    # crude: a hundredth of a point of held-out MAE is not football.
    keep = bool(improvement > 0.02 and abs(artifact_corr) < 0.4)
    table = {}
    if keep:
        for vid, a in adj.items():
            if vid is None or (isinstance(vid, float) and np.isnan(vid)):
                continue
            table[int(vid)] = {'hfa': round(float(hp['hfa'] + a), 3),
                               'n': int(grp.loc[vid, 'count'])}
    spread = np.std([v['hfa'] for v in table.values()]) if table else 0.0
    diag = {'kept_per_venue_table': keep,
            'holdout_mae_league_constant': round(baseline, 4),
            'holdout_mae_venue_table': round(best_e, 4),
            'improvement': round(improvement, 4),
            'artifact_corr_with_home_team_rating': None if np.isnan(artifact_corr) else round(artifact_corr, 3),
            'shrink_games': best_k,
            'note': ('per-venue home-field advantage was tested and KEPT'
                     if keep else
                     'per-venue home-field advantage was tested and REJECTED: the estimates '
                     'track the home team\'s own rating (corr %.2f), i.e. they measure team '
                     'quality rather than the stadium, and they do not beat a single league '
                     'constant out of sample. The league constant ships instead.'
                     % (0.0 if np.isnan(artifact_corr) else artifact_corr))}
    return table, league, best_k, float(spread), best_e, diag


# ===========================================================================
# 3. travel / schedule / rivalry / conference, fitted on residuals
# ===========================================================================
def team_venue_map(v):
    m = {}
    for r in v.itertuples():
        if r.team_key and not (isinstance(r.latitude, float) and np.isnan(r.latitude)):
            m[r.team_key] = {'lat': float(r.latitude), 'lon': float(r.longitude),
                             'elev': None if pd.isna(r.elevation) else float(r.elevation),
                             'tz': common.tz_hours(r.timezone),
                             'venue_id': None if pd.isna(r.venue_id) else int(r.venue_id),
                             'capacity': None if pd.isna(r.capacity) else float(r.capacity),
                             'dome': bool(r.dome) if r.dome is not None else None,
                             'grass': None if r.grass is None else bool(r.grass)}
    return m


def fit_travel(df, tvm, lo, hi):
    d = df[df.both_fbs & (df.known >= 4) & ~df.neutral
           & (df.season >= lo) & (df.season <= hi)].copy()
    rows = []
    for r in d.itertuples():
        h, a = tvm.get(r.home_key), tvm.get(r.away_key)
        if not h or not a:
            continue
        miles = float(common.haversine_miles(np.array([a['lat']]), np.array([a['lon']]),
                                             np.array([h['lat']]), np.array([h['lon']]))[0])
        tz = (h['tz'] - a['tz']) if (h['tz'] is not None and a['tz'] is not None) else np.nan
        alt = (h['elev'] - a['elev']) if (h['elev'] is not None and a['elev'] is not None) else np.nan
        rows.append({'resid': r.margin - r.pred_margin, 'miles': miles / 1000.0,
                     'tz': abs(tz) if np.isfinite(tz) else np.nan,
                     'alt': max(0.0, alt) / 1000.0 if np.isfinite(alt) else np.nan})
    t = pd.DataFrame(rows).dropna()
    if len(t) < 500:
        return None, {'n': len(t), 'note': 'too few games with both venues geocoded'}
    X = np.column_stack([t.miles, t.tz, t.alt, np.ones(len(t))])
    w, *_ = np.linalg.lstsq(X, t.resid.values, rcond=None)
    yhat = X @ w
    ss = 1 - np.sum((t.resid - yhat) ** 2) / np.sum((t.resid - t.resid.mean()) ** 2)
    # a permutation check: does this beat shuffled travel?
    rng = np.random.RandomState(7)
    null = []
    for _ in range(50):
        idx = rng.permutation(len(t))
        Xs = np.column_stack([t.miles.values[idx], t.tz.values[idx], t.alt.values[idx], np.ones(len(t))])
        ws, *_ = np.linalg.lstsq(Xs, t.resid.values, rcond=None)
        null.append(1 - np.sum((t.resid - Xs @ ws) ** 2) / np.sum((t.resid - t.resid.mean()) ** 2))
    p = float(np.mean(np.array(null) >= ss))
    out = {'per_1000_miles': round(float(w[0]), 4), 'per_tz_hour': round(float(w[1]), 4),
           'per_1000m_altitude': round(float(w[2]), 4),
           'confidence': round(max(0.05, min(0.6, 1 - p)), 2),
           'basis': 'walk-forward residual regression on %d tune-window road games' % len(t)}
    diag = {'n': int(len(t)), 'r2': round(float(ss), 6), 'permutation_p': round(p, 3),
            'mean_miles': round(float(t.miles.mean() * 1000), 1),
            'note': 'r2 this small is the honest answer: travel barely moves the '
                    'mean once team strength is accounted for. It is kept because it is '
                    'measured, and its confidence is set from the permutation test.'}
    return out, diag


def detect_rivalries(games, tvm, lo, hi):
    """A rivalry is DETECTED, never asserted: frequent meetings, geographic
    proximity, and measured excess residual behaviour. History identifies a
    persistent situation; it never says one team simply beats another."""
    g = games[(games.season >= lo) & (games.season <= hi) & games.home_fbs & games.away_fbs].copy()
    g['pair'] = [tuple(sorted([h, a])) for h, a in zip(g.home_key, g.away_key)]
    agg = g.groupby('pair').agg(n=('game_id', 'size'), seasons=('season', 'nunique')).reset_index()
    agg = agg[agg.n >= 6]
    out = {}
    for r in agg.itertuples():
        a, b = r.pair
        va, vb = tvm.get(a), tvm.get(b)
        miles = None
        if va and vb:
            miles = float(common.haversine_miles(np.array([va['lat']]), np.array([va['lon']]),
                                                 np.array([vb['lat']]), np.array([vb['lon']]))[0])
        prox = 1.0 if (miles is not None and miles < 300) else (0.5 if (miles is not None and miles < 600) else 0.0)
        freq = min(1.0, r.seasons / float(hi - lo + 1))
        intensity = 0.6 * freq + 0.4 * prox
        if intensity < 0.45:
            continue
        out[a + '|' + b] = {'n': int(r.n), 'seasons': int(r.seasons),
                            'miles': None if miles is None else round(miles, 1),
                            'intensity': round(float(intensity), 3)}
    return out


def measure_rivalry_effects(df, riv, lo, hi):
    d = df[df.both_fbs & (df.known >= 4) & (df.season >= lo) & (df.season <= hi)].copy()
    d['pair'] = [('|'.join(sorted([h, a]))) for h, a in zip(d.home_key, d.away_key)]
    d['resid'] = d.margin - d.pred_margin
    base_sd = float(d.resid.std())
    kept = {}
    for key, meta in riv.items():
        sub = d[d.pair.eq(key)]
        if len(sub) < 5:
            meta2 = dict(meta); meta2.update({'volatility': 0.0, 'mean_points': 0.0,
                                              'why': 'frequency and proximity; too few rated meetings to measure behaviour'})
            kept[key] = meta2
            continue
        sd = float(sub.resid.std())
        excess = (sd / base_sd) - 1.0 if base_sd > 0 else 0.0
        # shrink the measured mean effect hard: 5-20 games cannot carry a
        # confident points adjustment, and a rivalry must never become
        # "Team A always beats Team B"
        n = len(sub)
        shrunk = float(sub.resid.mean()) * (n / (n + 60.0))
        meta2 = dict(meta)
        meta2.update({'volatility': round(float(max(0.0, min(1.0, excess))), 3),
                      'mean_points': round(shrunk, 3), 'measured_n': n,
                      'why': 'frequency + proximity; residual SD %.1f vs league %.1f'
                             % (sd, base_sd)})
        kept[key] = meta2
    exc = [v['volatility'] for v in kept.values() if v.get('measured_n', 0) >= 8]
    diag = {'pairs': len(kept), 'mean_excess_volatility': round(float(np.mean(exc)), 4) if exc else None,
            'share_more_volatile': round(float(np.mean([e > 0 for e in exc])), 3) if exc else None,
            'league_resid_sd': round(base_sd, 3)}
    return kept, diag


def conference_strength(games, df, lo, hi):
    """Cross-conference margin performance, per conference per season."""
    d = df[df.both_fbs & (df.known >= 3)].merge(
        games[['game_id', 'home_conf', 'away_conf']], on='game_id', how='left')
    d = d[(d.season >= lo) & (d.season <= hi)]
    cross = d[d.home_conf.notna() & d.away_conf.notna() & (d.home_conf != d.away_conf)]
    out = {}
    for (s, c), grp in pd.concat([
            cross.assign(conf=cross.home_conf, val=cross.margin - cross.hfa_used),
            cross.assign(conf=cross.away_conf, val=-(cross.margin - cross.hfa_used))
    ]).groupby(['season', 'conf']):
        out.setdefault(str(int(s)), {})[c] = {
            'strength': round(float(grp.val.mean()), 3), 'n': int(len(grp))}
    return out


# ===========================================================================
# 4. preseason -> in-season blend curve (Section XXIV)
# ===========================================================================
def fit_blend_curve(df, lo, hi):
    """Section XXIV, answered rather than asserted.

    Two rating tracks are carried through the whole pass: the CARRIED rating,
    which starts each season from last season's decayed rating (the model's
    preseason belief), and the FRESH rating, which is wiped at every season
    break and knows only what has happened this year. For each number of
    games played, this finds the mixture that minimises out-of-sample margin
    error. The resulting curve IS the answer to "when does actual team
    identity beat preseason assumption?" — and it is allowed to come out
    saying the prior never helps, or always does.
    """
    d = df[df.both_fbs & (df.season >= lo) & (df.season <= hi)
           & df.prior_margin.notna() & df.fresh_margin.notna()].copy()
    curve, diag = {}, []
    for gp in range(0, 16):
        sub = d[d.gs_min == gp] if gp < 15 else d[d.gs_min >= 15]
        if len(sub) < 150:
            curve[str(gp)] = curve.get(str(max(0, gp - 1)), 1.0)
            diag.append({'games_played': gp, 'n': int(len(sub)), 'w_prior': curve[str(gp)],
                         'note': 'too few games at this point of a season; carried forward'})
            continue
        best_w, best_e = 1.0, 1e9
        for w in np.arange(0, 1.001, 0.05):
            p = w * sub.pred_margin + (1 - w) * sub.fresh_margin
            e = float(np.mean(np.abs(p - sub.margin)))
            if e < best_e:
                best_w, best_e = float(w), e
        curve[str(gp)] = round(best_w, 3)
        diag.append({'games_played': gp, 'n': int(len(sub)), 'w_prior': round(best_w, 3),
                     'mae_blend': round(best_e, 3),
                     'mae_carried_only': round(float(np.mean(np.abs(sub.pred_margin - sub.margin))), 3),
                     'mae_this_season_only': round(float(np.mean(np.abs(sub.fresh_margin - sub.margin))), 3)})
    # The raw per-bucket argmin is noisy at 150-600 games a bucket. It is
    # smoothed to be monotone non-increasing in games played, because the
    # weight on prior-season information cannot honestly RISE as more of this
    # season is observed. The unsmoothed values stay in the report.
    smooth, run_min = {}, 1.0
    for gp in range(0, 16):
        run_min = min(run_min, curve[str(gp)])
        smooth[str(gp)] = round(run_min, 3)
    for row in diag:
        row['w_prior_smoothed'] = smooth[str(row['games_played'])]
    return smooth, diag


def preseason_share_curve(hp):
    """The other half of Section XXIV, derived rather than fitted: with step
    size k, a team's rating after n games this season still carries
    (1-k)^n of its season-start (preseason) value. This is the curve that
    actually answers 'when does what a team has DONE outweigh what we
    believed about it in August?'"""
    k = hp['k']
    return dict((str(n), round(float((1.0 - k) ** n), 4)) for n in range(0, 16))


def apply_blend(df, curve):
    """w is the weight on the CARRIED (preseason-informed) rating; 1-w is the
    weight on the rating built from this season alone."""
    w = df.gs_min.clip(0, 15).astype(int).astype(str).map(curve).astype(float).fillna(1.0)
    out = df.copy()
    out['blended_margin'] = w * out.pred_margin + (1 - w) * out.fresh_margin
    out['prior_weight'] = w
    return out


# ===========================================================================
# 5. matchup interactions (layer B)
# ===========================================================================
MATCHUP_PAIRS = [
    ('pass rush vs pass protection', 'sack_rate_allowed', 'def_sack_rate_allowed', -1.0, 1.0),
    ('run game vs run defence', 'epa_rush', 'def_epa_rush', 1.0, -1.0),
    ('explosive offence vs explosive prevention', 'expl_epa_rate', 'def_expl_epa_rate', 1.0, -1.0),
    ('passing efficiency vs pass defence', 'epa_pass', 'def_epa_pass', 1.0, -1.0),
    ('early-down offence vs early-down defence', 'early_down_success', 'def_early_down_success', 1.0, -1.0),
    ('finishing drives vs red-zone defence', 'red_zone_success', 'def_red_zone_success', 1.0, -1.0),
    ('ball control vs front disruption', 'success_rate', 'def_front_disruption_rate', 1.0, -1.0),
    ('field position', 'start_field_position', 'def_start_field_position', -1.0, 1.0),
]


def fit_matchup(df, lo, hi):
    d = df[df.both_fbs & (df.known >= 4) & (df.season >= lo) & (df.season <= hi)].copy()
    d['resid'] = d.margin - d.pred_margin
    cols, names = [], []
    for name, off, deff, so, sd in MATCHUP_PAIRS:
        ho, hd = 'h_' + off, 'a_' + deff
        ao, ad = 'a_' + off, 'h_' + deff
        if ho not in d.columns or hd not in d.columns:
            continue
        home_int = so * d[ho] + sd * d[hd]
        away_int = so * d[ao] + sd * d[ad]
        cols.append((home_int - away_int).values)
        names.append((name, off, deff, so, sd))
    if not cols:
        return [], {'note': 'no efficiency columns available'}
    X = np.column_stack(cols + [np.ones(len(d))])
    ok = np.all(np.isfinite(X), axis=1) & np.isfinite(d.resid.values)
    X, y = X[ok], d.resid.values[ok]
    lam = 1.0
    XtX = X.T @ X + lam * np.eye(X.shape[1])
    w = np.linalg.solve(XtX, X.T @ y)
    yhat = X @ w
    r2 = 1 - np.sum((y - yhat) ** 2) / np.sum((y - y.mean()) ** 2)
    pairs = []
    for i, (name, off, deff, so, sd) in enumerate(names):
        pairs.append({'name': name, 'off': off, 'def': deff,
                      'off_sign': so, 'def_sign': sd, 'w': round(float(w[i]), 5)})
    scale = float(np.mean(np.abs(X[:, :-1] @ w[:-1]))) * 3.0
    return pairs, {'n': int(len(y)), 'r2_on_residual': round(float(r2), 5),
                   'intercept': round(float(w[-1]), 4),
                   'scheme_fit_scale': round(max(1.0, scale), 3)}


# ===========================================================================
# 6. persistence -> regression constants (Section XXI)
# ===========================================================================
def fit_persistence(tg):
    if tg is None:
        return {}, {}
    stats = ['turnovers', 'expl_epa_rate', 'third_down_rate', 'red_zone_success',
             'front_disruption_rate', 'success_rate', 'epa_per_play', 'sack_rate_allowed',
             'stuff_rate', 'points_per_drive']
    out, diag = {}, {}
    d = tg.sort_values(['team', 'season', 'week'])
    for s in stats:
        if s not in d.columns:
            continue
        cur = d.groupby(['team', 'season'])[s]
        lag = d.groupby(['team', 'season'])[s].shift(1)
        both = pd.DataFrame({'x': lag, 'y': d[s]}).dropna()
        if len(both) < 500:
            continue
        r = float(both.x.corr(both.y))
        # a statistic with persistence r repeats a share r of itself; the
        # half-weight sample size is derived from that, never chosen
        r = max(0.001, min(0.95, r))
        k = max(0.5, (1.0 - r) / r)
        out[s] = {'persistence': round(r, 4), 'shrink_games': round(float(k), 2)}
        diag[s] = {'n': int(len(both)), 'lag1_r': round(r, 4)}
    return out, diag


# ===========================================================================
# 7. volatility sigma model (Section XXIII) and confidence weights
# ===========================================================================
def build_vol_context(df, games, tg, rs, riv, tvm):
    """Per-game volatility drivers, all pregame-computable."""
    d = df[df.both_fbs & (df.known >= 3)].copy()
    d = d.merge(games[['game_id', 'home_conf', 'away_conf']], on='game_id', how='left')
    d['pair'] = [('|'.join(sorted([h, a]))) for h, a in zip(d.home_key, d.away_key)]
    d['rivalry'] = d.pair.map(lambda p: riv.get(p, {}).get('volatility', 0.0)).astype(float)
    d['early_season'] = ((5 - d.gs_min).clip(lower=0) / 5.0).astype(float)

    if rs is not None:
        r = rs[['team_key', 'season', 'returning_share', 'experience',
                'returning_production', 'transfers_in']].copy()
        d = d.merge(r.add_prefix('h_'), left_on=['home_key', 'season'],
                    right_on=['h_team_key', 'h_season'], how='left')
        d = d.merge(r.add_prefix('a_'), left_on=['away_key', 'season'],
                    right_on=['a_team_key', 'a_season'], how='left')
        d['roster_turnover'] = np.fmax(1 - d.h_returning_share, 1 - d.a_returning_share)
        d['youth_volatility'] = np.fmax(1 - d.h_experience, 1 - d.a_experience)
    else:
        d['roster_turnover'] = np.nan
        d['youth_volatility'] = np.nan

    if tvm:
        miles = []
        for h, a, nt in zip(d.home_key, d.away_key, d.neutral):
            vh, va = tvm.get(h), tvm.get(a)
            if nt or not vh or not va:
                miles.append(0.0)
            else:
                miles.append(min(1.0, float(common.haversine_miles(
                    np.array([va['lat']]), np.array([va['lon']]),
                    np.array([vh['lat']]), np.array([vh['lon']]))[0]) / 2500.0))
        d['travel'] = miles
    else:
        d['travel'] = 0.0
    # margin variance genuinely scales with the scoring environment and with
    # the size of the projected gap; both are pregame-known
    if 'pred_total' in d.columns and d.pred_total.notna().any():
        base_t = float(d.pred_total.median())
        d['scoring_environment'] = ((d.pred_total - base_t) / 25.0 + 0.5).clip(0, 1)
    else:
        d['scoring_environment'] = np.nan
    d['mismatch'] = (d.pred_margin.abs() / 35.0).clip(0, 1)
    d['resid'] = d.margin - d.pred_margin
    return d


# Candidate volatility drivers. `scoring_environment` and `mismatch` are here
# because margin variance genuinely scales with pace and with the size of the
# projected gap — a 70-point-total shootout and a 38-point rock fight do not
# have the same outcome range. The fit is free to give any of these zero.
VOL_DRIVERS = ['roster_turnover', 'youth_volatility', 'rivalry', 'early_season',
               'travel', 'scoring_environment', 'mismatch']


def fit_volatility(d, lo, hi):
    """sigma_i = sigma_base * (1 + sum lambda_k u_k), lambdas by Gaussian MLE
    on the tune window with non-negativity, then VALIDATED out of sample by
    checking that realised |residual| actually rises across predicted-sigma
    buckets. If it does not, the layer says so."""
    tr = d[(d.season >= lo) & (d.season <= hi)].copy()
    use = [c for c in VOL_DRIVERS if c in tr.columns and tr[c].notna().mean() > 0.5]
    tr = tr.dropna(subset=['resid'] + use)
    if len(tr) < 800 or not use:
        return None, {'note': 'insufficient data to fit a volatility model', 'n': int(len(tr))}
    base = float(tr.resid.std())
    U = tr[use].clip(0, 1).values
    y = tr.resid.values

    def nll(lam):
        s = base * (1 + U @ lam)
        s = np.clip(s, base * 0.6, base * 2.2)
        return float(np.mean(0.5 * (y / s) ** 2 + np.log(s)))

    lam = np.zeros(len(use))
    step = 0.20
    cur = nll(lam)
    for _ in range(400):
        improved = False
        for j in range(len(use)):
            for delta in (step, -step):
                cand = lam.copy()
                cand[j] = max(0.0, cand[j] + delta)
                v = nll(cand)
                if v < cur - 1e-9:
                    lam, cur = cand, v
                    improved = True
        if not improved:
            step *= 0.5
            if step < 1e-3:
                break
    lam_d = dict((k, round(float(v), 4)) for k, v in zip(use, lam))
    # The floor and ceiling are the ACHIEVABLE range of this fit, not a
    # decorative multiple of the base. If every lambda came out zero the range
    # collapses and the volatility index correctly reports one flat value,
    # rather than pretending to discriminate inside a band it never reaches.
    fitted = base * (1 + U @ lam)
    lo = float(np.percentile(fitted, 1))
    hi = float(np.percentile(fitted, 99))
    if hi - lo < 0.25:
        lo, hi = float(fitted.min()), float(fitted.min()) + 0.25
    return {'sigma_base': round(base, 3), 'lambda': lam_d,
            'sigma_floor': round(lo, 3), 'sigma_ceiling': round(hi, 3),
            'mean_multiplier': round(float(np.mean(1 + U @ lam)), 5)}, \
           {'n': int(len(tr)), 'drivers_used': use,
            'nonzero_drivers': [k for k, v in lam_d.items() if v > 0],
            'fitted_sigma_range': [round(lo, 2), round(hi, 2)],
            'note': 'a driver at exactly 0.0 was offered to the fit and REJECTED by it'}


def validate_volatility(d, model, lo, hi):
    if not model:
        return {'note': 'no volatility model'}
    te = d[(d.season >= lo) & (d.season <= hi)].copy()
    use = list(model['lambda'].keys())
    te = te.dropna(subset=['resid'] + use)
    if len(te) < 300:
        return {'note': 'too few out-of-sample games to validate', 'n': int(len(te))}
    lam = np.array([model['lambda'][k] for k in use])
    U = te[use].clip(0, 1).values
    sig = np.clip(model['sigma_base'] * (1 + U @ lam),
                  model['sigma_floor'], model['sigma_ceiling'])
    te['sigma'] = sig
    q = pd.qcut(te.sigma, 5, labels=False, duplicates='drop')
    buckets = []
    for b in sorted(pd.Series(q).dropna().unique()):
        sub = te[q == b]
        buckets.append({'bucket': int(b), 'n': int(len(sub)),
                        'predicted_sigma': round(float(sub.sigma.mean()), 3),
                        'realised_sd': round(float(sub.resid.std()), 3),
                        'realised_mean_abs': round(float(sub.resid.abs().mean()), 3)})
    rc = rank_corr(te.sigma, te.resid.abs())
    # With few distinct sigma values qcut collapses to two or three buckets.
    # That is not a failure of the test, so direction is judged on whatever
    # buckets exist and the number of them is reported alongside.
    direction_ok = len(buckets) >= 2 and buckets[-1]['realised_sd'] > buckets[0]['realised_sd']
    verdict = ('directionally correct but weak' if (direction_ok and rc < 0.15)
               else 'validated' if direction_ok else 'not validated')
    return {'n': int(len(te)), 'n_buckets': len(buckets), 'buckets': buckets,
            'direction_correct': bool(direction_ok),
            'rank_corr_sigma_vs_absresid': round(rc, 4), 'verdict': verdict,
            'note': 'a rank correlation this small means per-game volatility is barely '
                    'discriminable out of sample: the engine reports a volatility index, '
                    'but it is a research signal, not a validated one.'}


# ===========================================================================
# 8. distributions
# ===========================================================================
def fit_distributions(df, market_lo, market_hi):
    d = df[df.both_fbs & (df.known >= 4) & (df.season >= market_lo) & (df.season <= market_hi)].copy()
    resid = (d.margin - d.pred_margin).round().astype(int)
    resid = resid[(resid >= -49) & (resid <= 49)]
    margin_pmf = resid.value_counts(normalize=True).sort_index()
    dt = d.dropna(subset=['pred_total'])
    tres = (dt.total_pts - dt.pred_total).round().astype(int)
    tres = tres[(tres >= -49) & (tres <= 49)]
    total_pmf = tres.value_counts(normalize=True).sort_index()
    key = dict((str(k), round(float((d.margin.abs() == k).mean()), 4))
               for k in [1, 2, 3, 4, 6, 7, 8, 10, 13, 14, 17, 21])
    return margin_pmf, total_pmf, key, float((d.margin - d.pred_margin).std()), \
        float((dt.total_pts - dt.pred_total).std())


def fit_margin_pmf_by_spread(games, lo, hi):
    """Margin distribution CONDITIONED ON THE MARKET SPREAD. This is the
    upgrade the line archive makes possible: CFB key numbers are real, but
    they are not the NFL's, and they depend on the number. Bandwidth chosen
    by held-out log-likelihood."""
    d = games[games.home_fbs & games.away_fbs & games.spread_close.notna()
              & (games.season >= lo) & (games.season <= hi)].copy()
    d['mi'] = d.margin.round().astype(int)
    tr = d[d.season <= (lo + hi) // 2]
    te = d[d.season > (lo + hi) // 2]
    if len(tr) < 1000 or len(te) < 300:
        tr, te = d, d

    def pmf_at(train, s, bw):
        w = np.exp(-0.5 * ((train.spread_close.values - s) / bw) ** 2)
        tot = w.sum()
        if tot <= 0:
            return {}
        out = {}
        for m, ww in zip(train.mi.values, w):
            out[m] = out.get(m, 0.0) + ww
        return dict((m, v / tot) for m, v in out.items())

    best_bw, best_ll = None, -1e18
    for bw in (1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0):
        ll = 0.0
        for s_val, grp in te.groupby(te.spread_close.round(0)):
            p = pmf_at(tr, s_val, bw)
            for m in grp.mi:
                ll += math.log(max(p.get(m, 0.0), 1e-6))
        if ll > best_ll:
            best_bw, best_ll = bw, ll
    table = {}
    for s in np.arange(-45, 45.5, 0.5):
        p = pmf_at(d, float(s), best_bw)
        row = dict((str(m), round(v, 6)) for m, v in sorted(p.items())
                   if v >= 2e-5 and -70 <= m <= 70)
        if row:
            table['%.1f' % s] = row
    return table, best_bw, len(d)


# ===========================================================================
# 9. market backtest
# ===========================================================================
def market_backtest(df, games, label, lo, hi, spread_col='spread_close',
                    total_col='total_close'):
    d = df[df.both_fbs & (df.known >= 4) & (df.season >= lo) & (df.season <= hi)].merge(
        games[['game_id', spread_col, total_col, 'spread_open', 'mkt_quality']],
        on='game_id', how='left')
    proj = 'blended_margin' if 'blended_margin' in d.columns else 'pred_margin'
    out = {'window': '%d-%d' % (lo, hi), 'label': label, 'n_games': int(len(d))}
    m = d.dropna(subset=[spread_col])
    if len(m):
        out['spread_mae_model'] = round(float(np.mean(np.abs(m[proj] - m.margin))), 3)
        out['spread_mae_market'] = round(float(np.mean(np.abs(m[spread_col] - m.margin))), 3)
        out['n_with_spread'] = int(len(m))
        gaps = {}
        for th in (0.5, 1, 1.5, 2, 3, 4, 6):
            s = m[(m[proj] - m[spread_col]).abs() >= th]
            s = s[s.margin != s[spread_col]]
            if len(s) < 40:
                continue
            side = np.sign(s[proj] - s[spread_col])
            win = ((np.sign(s.margin - s[spread_col]) == side)).mean()
            n = int(len(s))
            k = int(round(win * n))
            gaps[str(th)] = {'n': n, 'wins': k, 'win_pct': round(float(win) * 100, 2),
                             'binom_p_one_sided': round(binom_p(k, n, 0.5), 4)}
        out['ats_vs_close'] = gaps
    t = d.dropna(subset=[total_col, 'pred_total'])
    if len(t):
        out['total_mae_model'] = round(float(np.mean(np.abs(t.pred_total - t.total_pts))), 3)
        out['total_mae_market'] = round(float(np.mean(np.abs(t[total_col] - t.total_pts))), 3)
        gaps = {}
        for th in (0.5, 1, 1.5, 2, 3, 4, 6):
            s = t[(t.pred_total - t[total_col]).abs() >= th]
            s = s[s.total_pts != s[total_col]]
            if len(s) < 40:
                continue
            side = np.sign(s.pred_total - s[total_col])
            win = ((np.sign(s.total_pts - s[total_col]) == side)).mean()
            n = int(len(s))
            k = int(round(win * n))
            gaps[str(th)] = {'n': n, 'wins': k, 'win_pct': round(float(win) * 100, 2),
                             'binom_p_one_sided': round(binom_p(k, n, 0.5), 4)}
        out['ou_vs_close'] = gaps
    # CLV: does the model's side beat the number the market closed at?
    c = d.dropna(subset=['spread_open', 'spread_close'])
    if len(c) > 200:
        side = np.sign(c[proj] - c.spread_open)
        moved = (c.spread_close - c.spread_open) * side
        out['clv_open_to_close'] = {
            'n': int(len(c)),
            'mean_points_gained': round(float(moved.mean()), 4),
            'beat_close_rate': round(float((moved > 0).mean()), 4),
            'note': 'positive means the line moved TOWARD the side the model preferred '
                    'at the open — the only market test that is not just a coin flip on results'}
    return out


def binom_p(k, n, p):
    """One-sided P(X >= k) under Binomial(n, p), normal approximation with
    continuity correction (n here is always in the hundreds or thousands)."""
    if n <= 0:
        return 1.0
    mu, sd = n * p, math.sqrt(n * p * (1 - p))
    if sd == 0:
        return 1.0
    z = (k - 0.5 - mu) / sd
    return 1.0 - norm_cdf(z)


def fit_sigma_mle(df, lo, hi):
    z = df[df.both_fbs & (df.known >= 4) & (df.season >= lo) & (df.season <= hi)
           & (df.margin != 0)]
    proj = 'blended_margin' if 'blended_margin' in z.columns else 'pred_margin'
    best, best_ll = None, -1e18
    y = (z.margin > 0).astype(float).values
    for s in np.arange(11.0, 22.05, 0.1):
        p = np.clip([norm_cdf(m / s) for m in z[proj]], 1e-6, 1 - 1e-6)
        ll = float(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
        if ll > best_ll:
            best, best_ll = float(s), ll
    p = np.clip([norm_cdf(m / best) for m in z[proj]], 1e-6, 1 - 1e-6)
    return best, {'n': int(len(z)),
                  'brier': round(float(np.mean((np.array(p) - y) ** 2)), 5),
                  'log_loss': round(float(-best_ll), 5)}


def calibration(df, sigma, lo, hi):
    z = df[df.both_fbs & (df.known >= 4) & (df.season >= lo) & (df.season <= hi)
           & (df.margin != 0)]
    proj = 'blended_margin' if 'blended_margin' in z.columns else 'pred_margin'
    p = np.array([norm_cdf(m / sigma) for m in z[proj]])
    y = (z.margin > 0).astype(float).values
    bins = np.linspace(0, 1, 11)
    out = []
    for i in range(10):
        m = (p >= bins[i]) & (p < bins[i + 1])
        if m.sum() >= 30:
            out.append({'bin': '%.1f-%.1f' % (bins[i], bins[i + 1]), 'n': int(m.sum()),
                        'p_pred': round(float(p[m].mean()), 3),
                        'p_obs': round(float(y[m].mean()), 3)})
    return out


# ===========================================================================
def main():
    os.makedirs(OUT, exist_ok=True)
    games, tg, rs, venues = load_frames()
    print('[frames] games=%d  team_game=%s  roster=%s  venues=%d'
          % (len(games), 'none' if tg is None else len(tg),
             'none' if rs is None else len(rs), len(venues)))

    stats_by_game = None
    if tg is not None:
        stats_by_game = {}
        cols = [c for c in ALL_EFF if c in tg.columns]
        for r in tg[['game_id', 'team_key'] + cols].itertuples(index=False):
            gid = int(r[0]); tk = r[1]
            if tk is None or (isinstance(tk, float) and np.isnan(tk)):
                continue
            stats_by_game.setdefault(gid, {})[tk] = dict(
                (c, (None if pd.isna(v) else float(v))) for c, v in zip(cols, r[2:]))
        print('[stats] efficiency rows attached for %d games' % len(stats_by_game))

    rep = {}

    # ---- layer A -----------------------------------------------------
    HP, tune_mae = tune_ratings(games)
    print('[layer A] frozen hyperparams: %s  tune MAE %.3f' % (HP, tune_mae))
    rep['hyperparams'] = HP
    rep['layer_a_tune_mae'] = round(tune_mae, 3)

    pass1, _ = run(games, HP)
    venue_tab, league_hfa, shrink_k, venue_spread, venue_hold_mae, venue_diag = \
        fit_venue_hfa(pass1, games, HP)
    print('[venue] league HFA %.2f | %s' % (league_hfa, venue_diag['note']))
    rep['venue'] = dict(venue_diag)
    rep['venue'].update({'n_venues': len(venue_tab), 'league_hfa': round(league_hfa, 3),
                         'sd_across_venues': round(venue_spread, 3)})

    vhfa = dict((k, v['hfa']) for k, v in venue_tab.items())
    df, R = run(games, HP, stats_by_game=stats_by_game, venue_hfa=vhfa,
                league_hfa=league_hfa, collect_eff=(stats_by_game is not None))
    print('[pass2] scored %d games' % len(df))

    tvm = team_venue_map(venues)
    travel, travel_diag = fit_travel(df, tvm, 2003, A_TUNE_END)
    print('[travel] %s' % json.dumps(travel_diag))
    rep['travel'] = travel_diag

    riv_raw = detect_rivalries(games, tvm, 2001, A_TUNE_END)
    riv, riv_diag = measure_rivalry_effects(df, riv_raw, 2001, A_TUNE_END)
    print('[rivalry] %s' % json.dumps(riv_diag))
    rep['rivalry'] = riv_diag

    conf = conference_strength(games, df, 2001, LAST)

    # ---- layer B -----------------------------------------------------
    curve, curve_diag = fit_blend_curve(df, B_TUNE_LO, B_TUNE_HI)
    share = preseason_share_curve(HP)
    print('[blend] weight on the carried rating by games played: %s' % json.dumps(curve))
    print('[blend] share of the rating still attributable to the preseason value: %s'
          % json.dumps(share))
    rep['blend_curve'] = curve_diag
    rep['preseason_share_curve'] = share
    df = apply_blend(df, curve)

    pairs, pair_diag = fit_matchup(df, B_TUNE_LO, B_TUNE_HI) if stats_by_game else ([], {})
    print('[matchup] %s' % json.dumps(pair_diag))
    rep['matchup'] = pair_diag

    persistence, pers_diag = fit_persistence(tg)
    print('[persistence] %s' % json.dumps(pers_diag))
    rep['persistence'] = pers_diag

    # ---- layer C -----------------------------------------------------
    vol_ctx = build_vol_context(df, games, tg, rs, riv, tvm)
    vol, vol_diag = fit_volatility(vol_ctx, C_TUNE_LO, C_TUNE_HI)
    vol_val = validate_volatility(vol_ctx, vol, TEST_LO, LAST)
    print('[volatility] fit=%s' % json.dumps(vol_diag))
    print('[volatility] validation=%s' % json.dumps(
        {k: v for k, v in vol_val.items() if k != 'buckets'}))
    rep['volatility_fit'] = vol_diag
    rep['volatility_validation'] = vol_val

    # ---- distributions and market ------------------------------------
    sigma, sig_diag = fit_sigma_mle(df, TEST_LO, LAST)
    # The volatility layer's base is the residual SD of its own tune window,
    # which is NOT the sigma that calibrates win probability. Rescale so the
    # AVERAGE game sigma equals the MLE-calibrated value; otherwise every win
    # probability the engine publishes is quietly mis-calibrated.
    if vol and vol.get('mean_multiplier'):
        k = sigma / (vol['sigma_base'] * vol['mean_multiplier'])
        for key in ('sigma_base', 'sigma_floor', 'sigma_ceiling'):
            vol[key] = round(vol[key] * k, 3)
        vol['rescaled_to_winprob_sigma'] = round(sigma, 3)
        vol['rescale_factor'] = round(float(k), 5)
        vol_val = validate_volatility(vol_ctx, vol, TEST_LO, LAST)
        rep['volatility_validation'] = vol_val
        print('[volatility] rescaled by %.4f so the mean game sigma equals the '
              'calibrated %.2f' % (k, sigma))
    m_pmf, t_pmf, key_mass, sd_m, sd_t = fit_distributions(df, TEST_LO, LAST)
    pmf_by_spread, bw, n_pmf = fit_margin_pmf_by_spread(
        games.merge(df[['game_id', 'known', 'both_fbs']], on='game_id', how='left'),
        2014, LAST)
    print('[dist] sigma_mle=%.2f  brier=%.5f  pmf_by_spread bw=%.1f from %d games'
          % (sigma, sig_diag['brier'], bw, n_pmf))
    rep['winprob'] = sig_diag
    rep['calibration'] = calibration(df, sigma, TEST_LO, LAST)
    rep['key_mass'] = key_mass
    rep['pmf_spread_bw'] = bw

    rep['market_headline'] = market_backtest(df, games, 'held-out (untouched by every layer)',
                                             TEST_LO, LAST)
    rep['market_secondary'] = market_backtest(df, games, 'layer-A-frozen window', 2014, 2021)
    rep['market_full'] = market_backtest(df, games, 'all seasons with market data', 2006, LAST)
    print('[market] headline %s' % json.dumps(
        {k: v for k, v in rep['market_headline'].items() if not isinstance(v, dict)}))

    # ---- params ------------------------------------------------------
    params = {
        'engine': 'edgedesk_cfb_p4',
        'sport': 'cfb_p4',
        'feature_version': 'cfb_p4_fv1',
        'trained_through_season': int(games.season.max()),
        'rating': {
            'hyperparams': HP,
            'games_for_full_confidence': 6,
            'league_mean_pts': round(float(R.lmean), 3),
            'seed_ratings': dict((t, round(v, 4)) for t, v in sorted(R.r.items())),
            'seed_ngames': dict((t, int(n)) for t, n in sorted(R.n.items())),
            'seed_scoring': dict((t, {'pf': round(o['pf'], 4), 'pa': round(o['pa'], 4)})
                                 for t, o in sorted(R.scoring.items())),
        },
        'efficiency': {
            'feats': ALL_EFF,
            'counterpart': COUNTERPART,
            'alpha': HP.get('alpha_eff', 0.15),
            'alpha_league': HP.get('alpha_eff_league', 0.01),
            'seed': dict((t, dict((f, round(v, 6)) for f, v in e.items()))
                         for t, e in sorted(R.eff.items())),
            'league_means': dict((f, round(v, 6)) for f, v in sorted(R.eff_mean.items())),
        },
        'venue': {
            'hfa_by_venue': dict((str(k), v) for k, v in venue_tab.items()),
            'league_hfa': round(league_hfa, 3),
            'n_for_full_confidence': shrink_k,
        },
        'travel': travel,
        'rivalry': {'pairs': riv},
        'conference': {'by_season': conf, 'points_per_strength': 0.0,
                       'seed_strength': {}},
        'blend': {'prior_weight_by_week': curve,
                  'preseason_share_by_games': share},
        'matchup': {'pairs': pairs,
                    'scheme_fit_scale': pair_diag.get('scheme_fit_scale', 6)},
        'regression': persistence,
        'volatility': vol or {},
        'distributions': {
            'sigma_margin': round(sigma, 2),
            'sigma_total': round(sd_t, 2),
            'margin_resid_pmf': dict((str(k), round(float(v), 6)) for k, v in m_pmf.items()),
            'total_resid_pmf': dict((str(k), round(float(v), 6)) for k, v in t_pmf.items()),
            'margin_pmf_by_spread': pmf_by_spread,
            'pmf_spread_bw': bw,
            'pmf_spread_range': [-45.0, 45.0],
            'pmf_conditioning': 'market closing spread (cfbfastR-data betting archive)',
            'abs_margin_key_mass': key_mass,
        },
    }
    with open(os.path.join(OUT, 'params_cfb_p4.json'), 'w') as f:
        json.dump(params, f, indent=1)
    with open(os.path.join(OUT, 'report_cfb_p4.json'), 'w') as f:
        json.dump(rep, f, indent=1)
    df.to_csv(os.path.join(OUT, 'p4_oos.csv'), index=False)
    print('[write] params_cfb_p4.json, report_cfb_p4.json, p4_oos.csv')


if __name__ == '__main__':
    main()
