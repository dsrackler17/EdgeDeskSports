"""Evidence-gated research items: repeated failure patterns that cross a
minimum-evidence bar become RESEARCH tasks. Nothing here changes production.

Two kinds of evidence, never pooled:
  BACKTEST_DEV  walk-forward out-of-fold predictions of the development seasons
                (2016-2023; the holdout is never mined), the prior evidence
  LIVE          the season's frozen pregame predictions graded against finals

A pattern is a segment of games (e.g. a team starting a first-time QB) and a
residual oriented to the side the pattern is about. It becomes an item when
n >= MIN_N and |mean| / se >= Z. A new row is appended only when the evidence
grows by EVIDENCE_STEP observations (the lab's research-queue rule), so the
queue shows how the evidence accumulated.
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from . import ids

MIN_N, Z, EVIDENCE_STEP = 50, 2.0, 25

# name -> (description, row filter, orientation: 'home' | 'away' | 'favorite' | 'game')
PATTERNS = {
    'QB_FIRST_START_HOME': ('home team starts a QB with no career starts', lambda d: d.h_qb_exp_starts.fillna(99) == 0, 'home'),
    'QB_FIRST_START_AWAY': ('away team starts a QB with no career starts', lambda d: d.a_qb_exp_starts.fillna(99) == 0, 'away'),
    'QB_CHANGED_HOME': ('home team changed its starter since last game', lambda d: d.h_qb_changed.fillna(0) == 1, 'home'),
    'QB_CHANGED_AWAY': ('away team changed its starter since last game', lambda d: d.a_qb_changed.fillna(0) == 1, 'away'),
    'BIG_FAVORITE': ('projected margin of 21+ points (oriented to the favourite)', lambda d: d.ens_pred.abs() >= 21, 'favorite'),
    'EARLY_SEASON': ('first four weeks (home residual)', lambda d: d.weeks_in.fillna(99) < 4, 'game'),
    'HIGH_DISAGREEMENT': ('submodel SD in the top decile (home residual)',
                          lambda d: d.ens_sd >= d.ens_sd.quantile(0.9), 'game'),
}


def _oriented(d, how):
    r = d.margin - d.ens_pred                     # actual minus predicted home margin
    if how == 'away':
        return -r
    if how == 'favorite':
        return np.where(d.ens_pred >= 0, r, -r)
    return r


def evidence(frame, origin):
    out = []
    for name, (desc, f, how) in PATTERNS.items():
        try:
            m = f(frame)
        except (AttributeError, KeyError):
            continue
        x = pd.Series(_oriented(frame[m], how)).dropna().astype(float)
        n = len(x)
        if n < 2:
            continue
        mean, se = float(x.mean()), float(x.std(ddof=1) / np.sqrt(n))
        out.append({'pattern': name, 'origin': origin, 'description': desc, 'orientation': how, 'n': n,
                    'mean_residual': round(mean, 3), 'se': round(se, 3),
                    'ci95': [round(mean - 1.96 * se, 3), round(mean + 1.96 * se, 3)],
                    'z': round(mean / se, 2) if se > 0 else None})
    return out


def backtest_frame():
    p = common.out_path('stage7', 'backtest_predictions.parquet')
    if not os.path.exists(p):
        return None
    cols = ['game_id', 'season', 'margin', 'ens_pred', 'ens_sd', 'weeks_in', 'h_qb_exp_starts', 'a_qb_exp_starts',
            'h_qb_changed', 'a_qb_changed', 'fcs_game']
    d = pd.read_parquet(p, columns=[c for c in cols if c])
    d = d[d.season.isin(C.DEV_SEASONS) & d.margin.notna() & d.ens_pred.notna()]
    return d[~d.fcs_game.fillna(False).astype(bool)]


def live_frame(season):
    """Frozen pregame predictions of the season joined to their features and finals."""
    snap = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'snapshots', str(season)))
    rows = []
    if os.path.isdir(snap):
        for f in sorted(os.listdir(snap)):
            if f.endswith('.json') and f != 'replay_to_date.json':
                for x in json.load(open(os.path.join(snap, f))).get('rows', []):
                    r = x['row']
                    rows.append({'game_id': int(r['game_id']), 'prediction_ts': pd.Timestamp(r['prediction_ts']),
                                 'ens_pred': r.get('ens_pred'), 'ens_sd': r.get('ens_sd'), 'priced': r.get('priced', True)})
    if not rows:
        return None
    P = pd.DataFrame(rows)
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'),
                        columns=['game_id', 'prediction_ts', 'season', 'margin', 'weeks_in', 'h_qb_exp_starts',
                                 'a_qb_exp_starts', 'h_qb_changed', 'a_qb_changed', 'fcs_game'])
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['game_id', 'status', 'margin'])
    d = P.merge(X.drop(columns=['margin']), on=['game_id', 'prediction_ts'], how='left').merge(G, on='game_id', how='left')
    d = d[d.status.eq('FINAL') & d.priced.fillna(True)]
    return d


def scan(season, store, ctx=None):
    have = {}
    for r in store.read('research'):
        k = (r['pattern'], r['origin'])
        have[k] = max(have.get(k, 0), r['n'])
    items = []
    frames = [('BACKTEST_DEV', backtest_frame()), ('LIVE', live_frame(season))]
    for origin, fr in frames:
        if fr is None or not len(fr):
            continue
        for e in evidence(fr, origin):
            if e['n'] < MIN_N or e['z'] is None or abs(e['z']) < Z:
                continue
            if e['n'] < have.get((e['pattern'], origin), -EVIDENCE_STEP) + EVIDENCE_STEP:
                continue
            e.update({'item_id': 'cfbrq_' + ids.h(e['pattern'], origin, season, e['n'] // EVIDENCE_STEP),
                      'season': season, 'status': 'RESEARCH', 'rule': 'n >= %d and |z| >= %.1f' % (MIN_N, Z),
                      'created_at': ids.ts(pd.Timestamp.now(tz='UTC')), 'run_id': (ctx or {}).get('run_id'),
                      'action': 'none: research only; a change requires a registered experiment and a challenger'})
            items.append(ids.clean(e))
    return items
