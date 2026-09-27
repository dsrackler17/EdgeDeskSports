"""Upcoming-game features, pure inference with the frozen artifact, calibration,
uncertainty, change attribution, movement guardrails and degraded modes.

The pure projection reads football information only. Every model input column
is listed from the artifact itself, and `assert_no_market_inputs` refuses a
column that names a line, a price or a book. A market move never changes a
pure projection: it is a different stage (MARKET_COMPARISON) with a different
output (the betting layer).

Projections are write-once per (game, feature_version, input_hash). A run whose
inputs for a game are unchanged adds nothing (cost control, and no
contradictory duplicates). A changed input produces a NEW projection record
and a change record that says why (`attribute`).
"""
import json
import os

import numpy as np
import pandas as pd

from .. import config as C
from .. import models as MD
from .. import predict_live as PL
from .. import walkforward as WF
from . import ids

REPO_V2 = PL.REPO_V2
ART_DIR = os.path.join(REPO_V2, 'artifacts')

# Guardrails on a game's pure projection between two published records.
# Provenance: MOVE_WITH_GAMES_PTS is the p99.5 of the week-over-week change of
# the same game's projection in the 2024 shadow replay (replay.py writes the
# measured value to docs/cfb-weekly/REPLAY.md); MOVE_WITHOUT_NEWS_PTS is a
# declared tolerance for "nothing football changed" (data corrections only).
MOVE_WITH_GAMES_PTS = 9.0
MOVE_WITHOUT_NEWS_PTS = 3.0

# a column is a market input if one of its '_'-separated tokens names the
# market, or it is one of the market columns V2 keeps outside the model
# ('line' alone is not a token here: edge_line_yds is line YARDS, a football stat)
MARKET_TOKENS = {'spread', 'moneyline', 'ml', 'price', 'prices', 'odds', 'book', 'books', 'market', 'vig', 'clv',
                 'juice', 'sportsbook'}
MARKET_COLUMNS = {'open_margin', 'close_margin', 'over_under', 'total_open', 'total_close', 'line_move',
                  'home_line', 'away_line', 'current_home_line', 'open_home_line', 'spread_open', 'spread_close'}

# degraded-mode reliability caps (never raised, only capped)
MODE_CAPS = {'FULL': 100, 'DEGRADED_MARKET': 100, 'DEGRADED_AVAILABILITY': 75, 'DEGRADED_PBP': 60, 'FALLBACK': 0}
MODE_ORDER = ['FALLBACK', 'DEGRADED_PBP', 'DEGRADED_AVAILABILITY', 'DEGRADED_MARKET', 'FULL']


# --------------------------------------------------------------- artifacts
def artifact_files(version):
    d = os.path.join(ART_DIR, version)
    return {f: os.path.join(d, f) for f in sorted(os.listdir(d)) if f != 'MANIFEST.json'} if os.path.isdir(d) else {}


def artifact_manifest(version):
    return {'model_version': version, 'files': {f: ids.file_hash(p) for f, p in artifact_files(version).items()}}


def verify_artifact(version):
    """The artifact's files must match the committed MANIFEST.json: a model
    file changed outside a governed release is refused, not used."""
    mpath = os.path.join(ART_DIR, version, 'MANIFEST.json')
    if not os.path.exists(mpath):
        return {'ok': False, 'reason': 'no MANIFEST.json for %s' % version, 'files': {}}
    want = json.load(open(mpath)).get('files', {})
    have = artifact_manifest(version)['files']
    bad = sorted(k for k in set(want) | set(have) if want.get(k) != have.get(k))
    return {'ok': not bad, 'reason': ('files differ from MANIFEST.json: ' + ', '.join(bad)) if bad else None,
            'files': have, 'manifest_hash': ids.content_hash(want)}


def model_inputs(A):
    """Every column the frozen artifact reads (C, D, TotalE, sigma design)."""
    cols = []
    for k, v in A['submodels'].items():
        cols += list(v.get('cols', []))
    base_sigma = [c for c in A['sigma_model']['cols'] if c not in ('ens_sd', 'abs_pred', 'exp_total_z', 'inv_games')]
    cols += base_sigma + ['min_games', 'exp_plays_total', 'fcs_game', 'neutral_site']
    return list(dict.fromkeys(cols))


def assert_no_market_inputs(cols):
    bad = [c for c in cols if c.lower() in MARKET_COLUMNS or set(c.lower().split('_')) & MARKET_TOKENS]
    if bad:
        raise AssertionError('market columns in the pure model inputs: %s' % bad)
    return True


# --------------------------------------------------------------- features
def upcoming_features(X, A, T, run_versions):
    """Write-once feature snapshots for the games frozen at T: the model inputs
    (after the artifact's own derivations) and their hash."""
    Xd = MD.add_derived(X)
    cols = model_inputs(A)
    assert_no_market_inputs(cols)
    out = []
    for _, r in Xd.iterrows():
        inputs = {c: (None if c not in r or pd.isna(r[c]) else (float(r[c]) if isinstance(r[c], (int, float, np.integer, np.floating, bool, np.bool_)) else str(r[c])))
                  for c in cols}
        ih = ids.content_hash(inputs)
        rec = {
            'feature_snapshot_id': 'cfbf_' + ids.h(r['game_id'], ids.ts(r['prediction_ts']), C.FEATURE_VERSION, ih),
            'game_id': str(r['game_id']), 'season': int(r['season']), 'week': int(r['week']),
            'home_id': str(r['home_id']), 'away_id': str(r['away_id']),
            'home_team': r.get('home_team'), 'away_team': r.get('away_team'),
            'kickoff_ts': ids.ts(r['kickoff_ts']), 'prediction_ts': ids.ts(r['prediction_ts']),
            'feature_ts': ids.ts(r['feature_ts']), 'feature_version': C.FEATURE_VERSION,
            'model_version': A['model_version'], 'data_version': run_versions.get('data_version'),
            'pbp_version': run_versions.get('pbp_version'), 'input_hash': ih, 'inputs': inputs,
        }
        out.append(ids.clean(rec))
    return out


# --------------------------------------------------------------- inference
def infer(X, A, gbm):
    """Run the approved submodels and the approved stack exactly as production
    does (predict_live.predict), and add what the brief asks to be stored."""
    D = PL.predict(X, A, gbm)
    W = A['stack_weights']
    comps = ['pred_' + k for k in W]
    D['directional_agreement'] = np.sign(D[comps]).nunique(axis=1).eq(1)
    D['p_home_raw'] = D['p_home']
    D['win_calibration_method'] = A['win_calibration'].get('method', 'raw')
    D['p_home_calibrated'] = calibrate_win(D['p_home_raw'].values, A['win_calibration'])
    # expected absolute error and intervals from the approved sigma model and t_df
    q = {lvl: _t_ppf(0.5 + lvl / 2.0, A['t_df']) for lvl in (0.5, 0.8, 0.95)}
    D['expected_model_error'] = D['sigma'] * np.sqrt(2.0 / np.pi)
    for lvl, z in q.items():
        k = int(round(lvl * 100))
        D['int%d_low' % k] = D['ens_pred'] - z * D['sigma']
        D['int%d_high' % k] = D['ens_pred'] + z * D['sigma']
    return D


def _t_ppf(p, df):
    from scipy import stats
    return float(stats.t.ppf(p, df))


def calibrate_win(p, cal):
    """Apply the artifact's win calibration object. method 'raw' (chosen on
    dev log loss) returns p unchanged; 'platt' and 'iso' are applied as fitted.
    Never re-fitted here."""
    p = np.asarray(p, dtype=float)
    m = (cal or {}).get('method', 'raw')
    if m == 'platt':
        a, b = cal['platt'][:2]
        lg = np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1))
        return 1.0 / (1.0 + np.exp(-(a + b * lg)))
    if m == 'iso':
        return np.interp(p, cal['iso']['x'], cal['iso']['y'])
    return p


# --------------------------------------------------------------- attribution
def contributions(X, A, gbm):
    """Per-feature contribution of each approved submodel, weighted by its stack
    weight: the ridge exactly (coefficient x standardized value) and the GBM
    by TreeSHAP (exact for the tree ensemble). Sums to ens_pred minus a
    constant per model."""
    Xd = MD.add_derived(X)
    W = A['stack_weights']
    parts = []
    if 'C_ridge' in W:
        lin = PL.LinearArt(A['submodels']['C_ridge'])
        c = lin.contributions(Xd) * W['C_ridge']
        c.columns = ['C:' + x for x in c.columns]
        parts.append(c)
    if 'D_gbm' in W:
        cols = A['submodels']['D_gbm']['cols']
        sh = gbm.predict(Xd[cols].astype(float).values, pred_contrib=True)
        d = pd.DataFrame(sh[:, :-1] * W['D_gbm'], columns=['D:' + x for x in cols], index=Xd.index)
        parts.append(d)
    return pd.concat(parts, axis=1)


FAMILY_OF = {}
for fam, cols in MD.FAMILIES.items():
    for c in cols:
        FAMILY_OF.setdefault(c, fam)
REASON_OF_FAMILY = {'adj_eff': 'team efficiency ratings (new games / opponent re-adjustment)',
                    'base': 'priors and dynamic strength', 'trench_havoc': 'line-of-scrimmage ratings',
                    'matchup': 'matchup interactions', 'form': 'recent form', 'special_teams': 'special teams',
                    'qb': 'quarterback state', 'context': 'schedule / venue / travel', 'drive': 'drive ratings',
                    'volatile': 'turnover rate'}


def attribute(prev_inputs, new_inputs, A, gbm, prev_pred, new_pred):
    """Why a projection moved: the exact change in each submodel's per-feature
    contribution, grouped by feature family. Ridge: exact; GBM: difference of
    TreeSHAP values (each SHAP vector sums to that model's output, so the
    grouped deltas sum to the projection change up to float error)."""
    cols = sorted(set(prev_inputs) | set(new_inputs))
    X = pd.DataFrame([{c: prev_inputs.get(c) for c in cols}, {c: new_inputs.get(c) for c in cols}]).astype(float)
    # add_derived expects a few raw columns; the stored inputs are already derived
    W = A['stack_weights']
    delta = {}
    if 'C_ridge' in W:
        lin = PL.LinearArt(A['submodels']['C_ridge'])
        cc = lin.contributions(X) * W['C_ridge']
        for c in cc.columns:
            delta['C:' + c] = float(cc.iloc[1][c] - cc.iloc[0][c])
    if 'D_gbm' in W:
        dcols = A['submodels']['D_gbm']['cols']
        sh = gbm.predict(X[dcols].values, pred_contrib=True)
        for j, c in enumerate(dcols):
            delta['D:' + c] = float((sh[1, j] - sh[0, j]) * W['D_gbm'])
    fam = {}
    for k, v in delta.items():
        f = FAMILY_OF.get(k.split(':', 1)[1], 'other')
        fam[f] = fam.get(f, 0.0) + v
    changed = sorted(c for c in cols if not _same(prev_inputs.get(c), new_inputs.get(c)))
    total = float(new_pred - prev_pred)
    explained = float(sum(delta.values()))
    fams = sorted(({'family': f, 'reason': REASON_OF_FAMILY.get(f, f), 'points': round(v, 3)}
                   for f, v in fam.items() if abs(v) >= 0.005), key=lambda r: -abs(r['points']))
    top = sorted(({'feature': k, 'points': round(v, 3)} for k, v in delta.items() if abs(v) >= 0.01),
                 key=lambda r: -abs(r['points']))[:8]
    return {'delta_margin': round(total, 3), 'explained': round(explained, 3), 'unexplained': round(total - explained, 3),
            'by_family': fams, 'top_features': top, 'changed_inputs': changed[:40], 'n_changed_inputs': len(changed),
            'method': 'ridge exact contribution + GBM TreeSHAP difference, weighted by the approved stack'}


def _same(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return abs(float(a) - float(b)) < 1e-12
    except (TypeError, ValueError):
        return a == b


# --------------------------------------------------------------- modes
def model_mode(team_pbp_quality, availability_status, has_market, artifact_ok):
    """The run's degraded modes for one game (all that apply, plus the primary)."""
    modes = []
    if not artifact_ok:
        modes.append('FALLBACK')
    if team_pbp_quality is not None and team_pbp_quality < 0.9:
        modes.append('DEGRADED_PBP')
    if availability_status not in ('HEALTHY', None):
        modes.append('DEGRADED_AVAILABILITY')
    if not has_market:
        modes.append('DEGRADED_MARKET')
    primary = next((m for m in MODE_ORDER if m in modes), 'FULL')
    return primary, modes or ['FULL']


def projection_records(D, feats, run_id, run_versions, prev_by_game, A, gbm, modes, has_new_games):
    """Write-once projection records for this run, and the change records for
    games whose inputs changed since their last published projection."""
    fe = {f['game_id']: f for f in feats}
    recs, changes, flags = [], [], []
    for _, r in D.iterrows():
        gid = str(r['game_id'])
        f = fe.get(gid)
        if f is None:
            continue
        ih = f['input_hash']
        prev = prev_by_game.get(gid)
        if prev and prev.get('input_hash') == ih:
            continue                    # unchanged football inputs: no new projection
        primary, all_modes = modes.get(gid, ('FULL', ['FULL']))
        cap = MODE_CAPS[primary]
        rec = {
            'projection_id': 'cfbj_' + ids.h(gid, f['feature_version'], ih, A['model_version']),
            'game_id': gid, 'season': f['season'], 'week': f['week'], 'kickoff_ts': f['kickoff_ts'],
            'prediction_ts': f['prediction_ts'], 'home_team': f['home_team'], 'away_team': f['away_team'],
            'model_version': A['model_version'], 'feature_version': f['feature_version'],
            'feature_snapshot_id': f['feature_snapshot_id'], 'input_hash': ih, 'run_id': run_id,
            'data_version': run_versions.get('data_version'),
            'components': {k: round(float(r['pred_' + k]), 4) for k in A['stack_weights']},
            'weights': A['stack_weights'], 'ens_pred': round(float(r['ens_pred']), 4),
            'ens_sd': round(float(r['ens_sd']), 4), 'directional_agreement': bool(r['directional_agreement']),
            'fair_total': round(float(r['pred_total']), 2), 'sigma': round(float(r['sigma']), 4),
            'expected_model_error': round(float(r['expected_model_error']), 3),
            'intervals': {k: [round(float(r['int%d_low' % k]), 2), round(float(r['int%d_high' % k]), 2)] for k in (50, 80, 95)},
            'p_home_raw': round(float(r['p_home_raw']), 5), 'p_home_calibrated': round(float(r['p_home_calibrated']), 5),
            'win_calibration_method': r['win_calibration_method'],
            'reliability': round(float(r['reliability']), 1), 'reliability_mode_cap': cap,
            'reliability_effective': round(min(float(r['reliability']), cap), 1),
            'model_mode': primary, 'model_modes': all_modes, 'priced': not bool(r.get('fcs_game', False)),
            'previous_projection_id': prev.get('projection_id') if prev else None,
        }
        recs.append(ids.clean(rec))
        if prev:
            att = attribute(prev.get('_inputs') or {}, f['inputs'], A, gbm, prev['ens_pred'], rec['ens_pred'])
            ch = {'change_id': 'cfbc_' + ids.h(prev['projection_id'], rec['projection_id']),
                  'game_id': gid, 'from_projection_id': prev['projection_id'], 'to_projection_id': rec['projection_id'],
                  'from_margin': prev['ens_pred'], 'to_margin': rec['ens_pred'], 'run_id': run_id,
                  'new_games_since': bool(has_new_games), 'projection_change_reason': att}
            bound = MOVE_WITH_GAMES_PTS if has_new_games else MOVE_WITHOUT_NEWS_PTS
            if abs(att['delta_margin']) > bound:
                fl = {'game_id': gid, 'flag': 'PROJECTION_MOVE_REVIEW', 'delta': att['delta_margin'], 'bound': bound,
                      'drivers': att['by_family'][:3], 'new_games_since': bool(has_new_games)}
                flags.append(fl)
                ch['review_flag'] = fl
            changes.append(ids.clean(ch))
    return recs, changes, flags
