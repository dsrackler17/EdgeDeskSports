#!/usr/bin/env python3
"""EdgeDesk NFL — a REGIME SIGNAL, fitted walk-forward (second follow-up to
the 2026-09-30 audit, item 4).

WHY. The NFL had no regime signal. NFL rosters are more stable than college
ones, so a smaller effect is expected, but three events plausibly leave the
model's number stale: a new head coach, a new starting quarterback, and the
regular starter out for the game (Washington without Jayden Daniels).

WHAT THE MODEL ALREADY DOES. The NFL engine's quarterback layer
(football/engine.js qbAdjust) already moves a team by the announced starter's
value relative to the team's usual quarterback. So the signal is measured on
the model's OUT-OF-SAMPLE RESIDUAL: what the result says after the QB layer
has done its work.

THE SIGNALS, per team-game, from nflverse/nfldata games.csv (coach and
starting quarterback of every game; known before kickoff):
  hc_new    the head coach's tenure with this team began this season (a
            different coach from the team's last game of the previous season,
            or a mid-season change)
  qb_new    the game's starting quarterback is not the team's primary starter
            last season (most starts)
  qb_out    the team has started 2+ games this season and the game's starter
            is not its regular starter so far (most starts this season)

THE FIT (walk-forward): the residual r = margin - model (home perspective,
nfl_oos.csv, whose model numbers are themselves walk-forward) is regressed on
the home-minus-away signals, with hc_new and qb_new split into weeks 1-6 and
7+ (a stale prior should matter early). Each season S is predicted with the
coefficients fitted on seasons before S (from 2006). The research pipeline's
own firewall is kept: validation is 2016-2023; 2024 and 2025 are scored ONCE
as the holdout. The adjustment ships only if the holdout regime subset beats
the model with a 95% interval that excludes zero.

The EV plausibility check for the NFL (item 2) is not built here: it ships
from tools/football/ev_plausibility.js (football/validation/
ev_plausibility.json), one construction for both sports.

Usage:
  python3 nfl_regime.py <data_dir> <out_dir> [--holdout] [--write]
      <data_dir>/nfl/games.csv, <out_dir>/nfl_oos.csv (train_nfl.py)
"""
import json
import math
import os
import sys

import numpy as np
import pandas as pd

DATA = sys.argv[1] if len(sys.argv) > 1 else 'data'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'out'
HOLDOUT = '--holdout' in sys.argv
WRITE = '--write' in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
FIT_FROM, VAL_FROM, VAL_TO, HOLD = 2006, 2016, 2023, (2024, 2025)
EARLY_WEEKS = 6

# franchise continuity (build_features.py's own map)
FRANCHISE = {'OAK': 'LV', 'SD': 'LAC', 'STL': 'LA', 'LAR': 'LA'}


def fr(t):
    return FRANCHISE.get(t, t)


def signals(games):
    """one row per (game_id, side) with hc_new, qb_new, qb_out"""
    g = games[games.game_type.eq('REG') | games.game_type.eq('WC') | games.game_type.eq('DIV')
              | games.game_type.eq('CON') | games.game_type.eq('SB')].copy()
    g = g.sort_values(['season', 'week', 'gameday', 'game_id'])
    rows = []
    for side in ('home', 'away'):
        s = g[['game_id', 'season', 'week', 'gameday', side + '_team', side + '_coach', side + '_qb_id']].copy()
        s.columns = ['game_id', 'season', 'week', 'gameday', 'team', 'coach', 'qb']
        s['side'] = side
        rows.append(s)
    t = pd.concat(rows, ignore_index=True)
    t['team'] = t.team.map(fr)
    t = t.sort_values(['team', 'season', 'week', 'gameday', 'game_id']).reset_index(drop=True)
    out = []
    for team, tg in t.groupby('team', sort=False):
        last_coach_prev = {}          # season -> coach of the last game that season
        primary_qb = {}               # season -> most-started QB that season
        for season, sg in tg.groupby('season', sort=True):
            last_coach_prev[season] = sg.coach.iloc[-1]
            vc = sg.qb.dropna().value_counts()
            primary_qb[season] = vc.index[0] if len(vc) else None
        for season, sg in tg.groupby('season', sort=True):
            prev_coach = last_coach_prev.get(season - 1)
            first_coach = sg.coach.iloc[0]
            prev_qb = primary_qb.get(season - 1)
            starts = {}
            for r in sg.itertuples(index=False):
                hc_new = (prev_coach is not None and first_coach != prev_coach) or (r.coach != first_coach)
                if prev_coach is None:
                    hc_new = None
                qb_new = None if (prev_qb is None or not isinstance(r.qb, str)) else (r.qb != prev_qb)
                n_prev = sum(starts.values())
                if n_prev >= 2 and isinstance(r.qb, str):
                    regular = max(starts.items(), key=lambda kv: kv[1])[0]
                    qb_out = r.qb != regular
                else:
                    qb_out = False if isinstance(r.qb, str) else None
                out.append({'game_id': r.game_id, 'side': r.side, 'team': team, 'season': season, 'week': r.week,
                            'hc_new': hc_new, 'qb_new': qb_new, 'qb_out': qb_out, 'qb_known': isinstance(r.qb, str)})
                if isinstance(r.qb, str):
                    starts[r.qb] = starts.get(r.qb, 0) + 1
    return pd.DataFrame(out)


def design(df):
    """home-minus-away signal columns"""
    X = pd.DataFrame(index=df.index)
    early = df.week <= EARLY_WEEKS
    for k in ('hc_new', 'qb_new'):
        h = df['home_' + k].fillna(False).astype(float)
        a = df['away_' + k].fillna(False).astype(float)
        X[k + '_early'] = (h - a) * early
        X[k + '_late'] = (h - a) * (~early)
    X['qb_out'] = df.home_qb_out.fillna(False).astype(float) - df.away_qb_out.fillna(False).astype(float)
    X['intercept'] = 1.0
    return X


def ols(X, y):
    beta, *_ = np.linalg.lstsq(X.values, y.values, rcond=None)
    return pd.Series(beta, index=X.columns)


def boot_ci(d, reps=2000, seed=20260930):
    if len(d) == 0:
        return None
    rng = np.random.default_rng(seed)
    d = np.asarray(d)
    m = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(reps)]
    return [round(float(np.quantile(m, 0.025)), 3), round(float(np.quantile(m, 0.975)), 3)]


def regime_active(df, side):
    early = df.week <= EARLY_WEEKS
    return (df[side + '_hc_new'].fillna(False).astype(bool) & early) | (df[side + '_qb_new'].fillna(False).astype(bool) & early) \
        | df[side + '_qb_out'].fillna(False).astype(bool)


def score(df, adj):
    """regime subset and overall, model vs model + adjustment"""
    sub = df[regime_active(df, 'home') | regime_active(df, 'away')]
    e0 = (sub.model_spread - sub.margin).abs()
    e1 = (sub.model_spread + adj.loc[sub.index] - sub.margin).abs()
    # bias from the regime team's side (positive = the model rated the regime team higher than the result)
    bs0, bs1 = [], []
    for side, sg in (('home', 1), ('away', -1)):
        m = regime_active(sub, side)
        bs0 += list(sg * (sub.model_spread[m] - sub.margin[m]))
        bs1 += list(sg * (sub.model_spread[m] + adj.loc[sub.index][m] - sub.margin[m]))
    d = (e1 - e0).values
    ci = boot_ci(d)
    all0 = (df.model_spread - df.margin).abs().mean()
    all1 = (df.model_spread + adj - df.margin).abs().mean()
    return {'regime_subset': {'games': int(len(sub)), 'mae_model': round(float(e0.mean()), 3), 'mae_adjusted': round(float(e1.mean()), 3),
                              'delta': round(float(d.mean()), 3) if len(d) else None, 'delta_ci95': ci,
                              'bias_model': round(float(np.mean(bs0)), 3) if bs0 else None,
                              'bias_adjusted': round(float(np.mean(bs1)), 3) if bs1 else None},
            'overall': {'games': int(len(df)), 'mae_model': round(float(all0), 3), 'mae_adjusted': round(float(all1), 3)},
            'significant': bool(ci and ci[1] < 0)}


def main():
    games = pd.read_csv(os.path.join(DATA, 'nfl', 'games.csv'), low_memory=False)
    oos = pd.read_csv(os.path.join(OUT, 'nfl_oos.csv'))
    S = signals(games)
    H = S[S.side.eq('home')].set_index('game_id').add_prefix('home_')
    A = S[S.side.eq('away')].set_index('game_id').add_prefix('away_')
    df = oos.set_index('game_id').join(H, how='left').join(A, how='left').reset_index()
    df = df[df.margin.notna() & df.model_spread.notna()].reset_index(drop=True)
    df['resid'] = df.margin - df.model_spread
    X = design(df)
    # walk-forward: season S predicted by the fit on [FIT_FROM, S-1]
    adj = pd.Series(0.0, index=df.index)
    coefs = {}
    for s in range(FIT_FROM + 1, max(HOLD) + 1):
        tr = df.season.between(FIT_FROM, s - 1) & (df.season <= (VAL_TO if s <= VAL_TO else VAL_TO))
        if s > VAL_TO:
            tr = df.season.between(FIT_FROM, VAL_TO)        # the holdout seasons use the fit through 2023 only
        te = df.season.eq(s)
        if tr.sum() < 200 or te.sum() == 0:
            continue
        b = ols(X[tr], df.resid[tr])
        coefs[s] = {k: round(float(v), 4) for k, v in b.items()}
        adj[te] = (X[te].drop(columns=['intercept']) * b.drop('intercept')).sum(axis=1)
    val = df.season.between(VAL_FROM, VAL_TO)
    shipped = ols(X[df.season.between(FIT_FROM, VAL_TO)], df.resid[df.season.between(FIT_FROM, VAL_TO)])
    rep = {'schema': 'edgedesk_nfl_regime_v1', 'generated_at': pd.Timestamp.now('UTC').isoformat(),
           'question': 'After the model’s quarterback layer, do a new head coach, a new starting quarterback or the regular starter being out leave a residual the model misses?',
           'signals': {'hc_new': 'the head coach’s tenure with the team began this season (incl. a mid-season change)',
                       'qb_new': 'the game’s starting quarterback is not last season’s primary starter',
                       'qb_out': 'the team has started 2+ games this season and the game’s starter is not its regular starter so far'},
           'fit': 'OLS of the out-of-sample residual on home-minus-away signals (hc_new and qb_new split at week %d), walk-forward from %d' % (EARLY_WEEKS, FIT_FROM),
           'validation_seasons': '%d-%d' % (VAL_FROM, VAL_TO), 'holdout_seasons': list(HOLD), 'holdout_scored': HOLDOUT,
           'coefficients_by_season': coefs, 'shipped_coefficients': {k: round(float(v), 4) for k, v in shipped.items()},
           'validation': score(df[val], adj[val])}
    # prevalence
    for k in ('hc_new', 'qb_new', 'qb_out'):
        rep.setdefault('prevalence', {})[k] = round(float(pd.concat([df['home_' + k], df['away_' + k]]).fillna(False).astype(bool).mean()), 4)
    if HOLDOUT:
        ho = df.season.isin(HOLD)
        rep['holdout'] = score(df[ho], adj[ho])
        rep['holdout']['by_season'] = {int(s): score(df[df.season.eq(s)], adj[df.season.eq(s)]) for s in HOLD}
    rep['promoted'] = bool(HOLDOUT and rep['holdout']['significant'])

    print(json.dumps({'regime': {k: rep[k] for k in ('prevalence', 'shipped_coefficients', 'validation', 'promoted')},
                      'regime_holdout': rep.get('holdout')}, indent=1))
    if WRITE:
        if not HOLDOUT:
            raise SystemExit('[write] refused: the shipped records must carry their holdout score (--holdout)')
        with open(os.path.join(HERE, 'report', 'nfl_regime.json'), 'w') as fh:
            json.dump(rep, fh, indent=1)
            fh.write('\n')
        reg = {'version': 'nfl_regime_v1', 'generated_by': 'football/research/nfl_regime.py', 'generated_at': rep['generated_at'],
               'promoted': rep['promoted'],
               'promotion_rule': 'priced only if the holdout regime subset beats the model with a 95% interval that excludes zero',
               'signals': rep['signals'], 'early_weeks': EARLY_WEEKS,
               'coefficients': {k: v for k, v in rep['shipped_coefficients'].items() if k != 'intercept'},
               'coefficient_meaning': 'points added to the team’s side of the fair margin when the signal is active (home minus away enters the margin)',
               'record': {'validation': rep['validation'], 'holdout': rep.get('holdout')},
               'report': 'football/research/report/nfl_regime.json'}
        js2 = ('/* GENERATED by football/research/nfl_regime.py --holdout --write. Do not edit by hand.\n'
               '   The NFL regime signal (new head coach, new starting quarterback, the regular starter out) and its\n'
               '   walk-forward fitted adjustment. `promoted` says whether the adjustment prices; while it is false the\n'
               '   board shows the signal and the adjustment it would make, and prices nothing. */\n'
               '(function (root) {\n  var R = ' + json.dumps(reg, indent=1).replace('\n', '\n  ') + ';\n'
               '  root.EDNflRegime = R;\n  if (typeof module !== \'undefined\' && module.exports) module.exports = R;\n'
               '})(typeof window !== \'undefined\' ? window : globalThis);\n')
        with open(os.path.join(REPO, 'football', 'nfl', 'regime_nfl.js'), 'w') as fh:
            fh.write(js2)
        print('[write] report/nfl_regime.json, football/nfl/regime_nfl.js', file=sys.stderr)


if __name__ == '__main__':
    main()
