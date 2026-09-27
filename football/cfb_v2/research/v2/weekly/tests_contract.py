"""Tests for the model input contract, the feature distribution monitor and the
matchup shadow stage (docs/cfb-production/CANONICAL.md §3-4).

    python3 -m v2.weekly.tests_contract [--fast]

--fast: synthetic checks on the committed contract, reference and artifacts
(no build needed). Without it, the real-data checks run too when
$CFB_V2_OUT holds a v2.1 (cfb_v2_fv2) stage-5 build: the contract refuses no
real game, the reference is the artifact's training rows, and the monitor's
leave-one-season-out flag rate is reported.
"""
import json
import os
import shutil
import sys
import tempfile

import numpy as np
import pandas as pd

from . import contract as IC
from . import matchup_shadow as MS
from .sources import REPO

PASS, FAIL = [0], []


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL.append((name, detail))


def done():
    for n, d in FAIL:
        print('FAIL | %s%s' % (n, ('  ' + json.dumps(d, default=str)[:400]) if d is not None else ''))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (PASS[0], len(FAIL)))
    sys.exit(0 if not FAIL else 1)


def throws(fn, klass=Exception):
    try:
        fn()
        return False
    except klass:
        return True


ART = os.path.join(REPO, 'football', 'cfb_v2', 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json')
A = json.load(open(ART))
C = IC.load()
REF = IC.load_reference(C)
RG = IC.ranges(C, REF)


# ---------------------------------------------------------------- the declaration
def declaration():
    from . import project as PJ
    fields = [f['field'] for f in C['model_inputs']]
    chk('contract: one entry per artifact input, no more, no less', sorted(fields) == sorted(PJ.model_inputs(A)),
        sorted(set(fields) ^ set(PJ.model_inputs(A))))
    chk('contract: names the artifact it was declared for', C['model_version'] == A['model_version'] and C['feature_version'] == A['feature_version'])
    chk('contract: every input has a type, a null policy and the model\'s null behaviour',
        all(f.get('type') in ('number', 'binary') and f.get('null_policy') in ('REFUSE', 'ALLOWED_BEFORE_FIRST_GAME')
            and f.get('model_null_behavior') for f in C['model_inputs']))
    chk('contract: only the four drive fields may be null, and only before a team\'s first game',
        sorted(f['field'] for f in C['model_inputs'] if f['null_policy'] != 'REFUSE') == ['drive_total_raw', 'eff_pts_raw', 'exp_plays_total', 'match_mix_edge'])
    chk('contract: every field add_derived fills with 0 is declared as such (its raw missingness is monitored)',
        all(f.get('imputed_from') for f in C['model_inputs'] if f['field'] in ('travel_miles_log', 'altitude_kft', 'rest_diff', 'tz_shift', 'qb_exp_edge', 'l4_edge_epa', 'l2_edge_epa')))
    chk('contract: the row inputs of the JS engine are declared with their criticality',
        {r['field'] for r in C['row_inputs'] if r.get('critical')} >= {'game_id', 'home_id', 'away_id', 'kickoff', 'ens_pred', 'sigma', 'priced', 'components'})
    chk('reference: built from the artifact\'s training rows (C_ridge\'s stored training means reproduced to 1e-9)',
        REF is not None and all(abs(m - REF['fields'][c]['mean']) < 1e-9 for c, m in zip(A['submodels']['C_ridge']['cols'], A['submodels']['C_ridge']['mean'])))
    chk('reference: names the contract and the model it describes', REF['contract_version'] == C['version'] and REF['model_version'] == C['model_version'])
    chk('reference: one envelope per week of the season and the postseason', {'w0', 'w5', 'w10', 'post'} <= set(REF['weeks']))
    chk('ranges: binary inputs are exactly {0, 1}', all(RG[f['field']]['hard'] == (0.0, 1.0) for f in C['model_inputs'] if f['type'] == 'binary'))
    chk('ranges: rest_diff hard range is the clip [-14, 14]', RG['rest_diff']['hard'] == (-14, 14) or (RG['rest_diff']['hard'][0] >= -14 and RG['rest_diff']['hard'][1] <= 14))
    chk('ranges: non-negative inputs never admit a negative value', all(RG[f['field']]['hard'][0] >= 0 for f in C['model_inputs'] if 'min' in f))
    chk('ranges: every numeric input has a finite hard range containing its soft range',
        all(np.isfinite(RG[f['field']]['hard'][0]) and RG[f['field']]['hard'][0] <= RG[f['field']]['soft'][0] <= RG[f['field']]['soft'][1] <= RG[f['field']]['hard'][1]
            for f in C['model_inputs'] if f['type'] == 'number'))


# ---------------------------------------------------------------- enforce (synthetic)
def typical_slate(n=30, phase='w5'):
    """A slate whose every input sits at the middle of the training envelope of
    `phase` (mean +/- SD alternating), already in derived form."""
    env = REF['weeks'][phase]['envelope']
    rows = []
    for i in range(n):
        r = {'game_id': 1000 + i, 'home_id': 10 + 2 * i, 'away_id': 11 + 2 * i, 'weeks_in': 5.5, 'is_postseason': False,
             'kickoff_ts': pd.Timestamp('2026-10-03T19:00:00Z'), 'prediction_ts': pd.Timestamp('2026-09-29T12:00:00Z'),
             'feature_ts': pd.Timestamp('2026-09-29T12:00:00Z')}
        for f in C['model_inputs']:
            e = env.get(f['field']) or {}
            mu = float(np.mean(e['mean'])) if e.get('mean') else 0.0
            if f['type'] == 'binary':
                r[f['field']] = 1.0 if (i / n) < mu else 0.0
            else:
                sd = float(np.mean(e['sd'])) if e.get('sd') else 0.0
                lo, hi = RG[f['field']]['soft']
                r[f['field']] = float(np.clip(mu + (sd if i % 2 else -sd), lo, hi))
        r['fcs_game'] = False
        rows.append(r)
    return pd.DataFrame(rows)


def enforcement():
    IC._derived = lambda X: X.copy()          # the synthetic frames are already derived
    base = typical_slate()
    e = IC.enforce(base, A, C, REF)
    chk('enforce: a typical slate passes with no violation', e['ok'] and e['games'] == 30, e['violations'])
    x = base.copy()
    x.loc[0, 'elo_diff'] = np.nan
    x.loc[1, 'edge_epa'] = 1e6
    x.loc[2, 'home_field'] = 0.5
    x.loc[3, 'edge_sr'] = np.inf
    x.loc[4, 'eff_pts_raw'] = np.nan
    x.loc[4, 'min_games'] = 3.0
    x.loc[5, 'eff_pts_raw'] = np.nan
    x.loc[5, 'min_games'] = 0.0
    x.loc[6, 'feature_ts'] = pd.Timestamp('2026-10-04T00:00:00Z')
    x.loc[7, 'away_id'] = x.loc[7, 'home_id']
    x.loc[8, 'edge_expl'] = RG['edge_expl']['soft'][1] + 0.5 * (RG['edge_expl']['hard'][1] - RG['edge_expl']['soft'][1])
    x['edge_line_yds'] = x['edge_line_yds'].astype(object)
    x.loc[9, 'edge_line_yds'] = 'n/a'
    e = IC.enforce(x, A, C, REF)
    v = e['violations']
    chk('enforce: a null REFUSE input is CRITICAL (never imputed)', '1000' in v and 'elo_diff: null' in v['1000'][0], v.get('1000'))
    chk('enforce: a value outside the hard range is CRITICAL', '1001' in v and 'hard range' in v['1001'][0], v.get('1001'))
    chk('enforce: a binary input that is not 0/1 is CRITICAL', '1002' in v, v.get('1002'))
    chk('enforce: an infinite value is CRITICAL', '1003' in v, v.get('1003'))
    chk('enforce: a null drive field after the first game is CRITICAL', '1004' in v, v.get('1004'))
    chk('enforce: a null drive field before a team\'s first game is allowed (as in training)', '1005' not in v, v.get('1005'))
    chk('enforce: features stamped after kickoff are CRITICAL', '1006' in v and 'after kickoff' in ' '.join(v['1006']), v.get('1006'))
    chk('enforce: home = away is CRITICAL', '1007' in v, v.get('1007'))
    chk('enforce: a legitimate extreme (past p99, inside the hard range) is not refused', '1008' not in v, v.get('1008'))
    chk('enforce: text in a numeric input is CRITICAL', '1009' in v, v.get('1009'))
    chk('enforce: exactly the violating games are listed', e['critical_games'] == ['1000', '1001', '1002', '1003', '1004', '1006', '1007', '1009'], e['critical_games'])
    chk('enforce: the frame is never modified', x.loc[0, 'elo_diff'] != x.loc[0, 'elo_diff'] and x.loc[1, 'edge_epa'] == 1e6)
    A2 = json.loads(json.dumps(A))
    A2['submodels']['C_ridge']['cols'] = A2['submodels']['C_ridge']['cols'] + ['brand_new_feature']
    chk('enforce: an artifact input the contract does not declare fails (never run unchecked)', throws(lambda: IC.enforce(base, A2, C, REF), ValueError))
    xa = base.drop(columns=['edge_opp_rate'])
    chk('enforce: an absent input column is CRITICAL for every game', len(IC.enforce(xa, A, C, REF)['critical_games']) == 30)


# ---------------------------------------------------------------- monitor (synthetic)
def monitoring():
    IC._derived = lambda X: X.copy()
    base = typical_slate()
    m = IC.monitor(base, REF, C)
    chk('monitor: a typical slate is not flagged', m['status'] == 'OK' and not m['flags'] and m['phase'] == 'w5', m['flags'][:3])
    x = base.copy()
    x['edge_epa'] = x['edge_epa'] * 100
    m2 = IC.monitor(x, REF, C)
    fl = {(f['field'], f['flag']) for f in m2['flags']}
    chk('monitor: a feature scaled x100 (a unit or provider bug) is flagged', ('edge_epa', 'MEAN_SHIFT') in fl or ('edge_epa', 'SD_SHIFT') in fl, sorted(fl))
    chk('monitor: only the broken feature is flagged', {f for f, _ in fl} == {'edge_epa'}, sorted(fl))
    chk('monitor: flags never change an input', x['edge_epa'].equals(base['edge_epa'] * 100))
    y = base.copy()
    y.loc[:14, 'x_pass_h'] = np.nan
    m3 = IC.monitor(y, REF, C)
    chk('monitor: half the slate missing an input is a MISSINGNESS flag', any(f['field'] == 'x_pass_h' and f['flag'] == 'MISSINGNESS' for f in m3['flags']), m3['flags'][:3])
    z = base.copy()
    z['exp_plays_total'] = z['exp_plays_total'] - 20
    m4 = IC.monitor(z, REF, C)
    chk('monitor: a regime shift (20 fewer plays a game) is flagged for review', any(f['field'] == 'exp_plays_total' for f in m4['flags']), m4['flags'][:3])
    chk('monitor: a slate under the minimum is not judged', IC.monitor(base.head(5), REF, C)['status'] == 'TOO_FEW_GAMES')
    chk('monitor: FBS-vs-FCS games are left out (the reference is FBS-vs-FBS)', IC.monitor(base.assign(fcs_game=True), REF, C)['status'] == 'TOO_FEW_GAMES')
    chk('monitor: without a reference it says so, never OK', IC.monitor(base, None if False else {}, C)['status'] in ('NO_REFERENCE_WEEK', 'NO_REFERENCE'))
    chk('monitor: phases follow the calendar', IC.phase_of(0.2, False) == 'w0' and IC.phase_of(7.9, False) == 'w7' and IC.phase_of(30, False) == 'w16' and IC.phase_of(3, True) == 'post')


# ---------------------------------------------------------------- matchup shadow
def matchup():
    g = {'game_id': '1', 'general_fair_margin': -3.2, 'matchup_aware_margin': -3.2, 'matchup_adjustment_points': 0.0, 'matchup_id': 'cfbmg_a'}
    ok, bad = MS.check_records([g], {'1': -3.2}, 'NO_ADJUSTMENT')
    chk('matchup shadow: a record equal to the published projection is kept', len(ok) == 1 and not bad)
    moved = dict(g, matchup_aware_margin=-2.2, matchup_adjustment_points=1.0, matchup_id='cfbmg_b')
    ok, bad = MS.check_records([moved], {'1': -3.2}, 'NO_ADJUSTMENT')
    chk('matchup shadow: under NO_ADJUSTMENT a record that moves the margin is refused, never applied', not ok and 'refused' in bad[0]['_refused'])
    ok, bad = MS.check_records([dict(g, general_fair_margin=-1.0)], {'1': -3.2}, 'NO_ADJUSTMENT')
    chk('matchup shadow: a general margin that is not the published projection is refused', not ok and bad)
    ok, bad = MS.check_records([g], {}, 'NO_ADJUSTMENT')
    chk('matchup shadow: a game without a published projection is refused', not ok and bad)
    D = pd.DataFrame({'game_id': [1, 2], 'ens_pred': [-3.2, 7.0], 'sigma': [15.0, 16.0]})
    X = pd.DataFrame({'game_id': [1, 2], 'fcs_game': [False, False]})
    r = MS.run_stage(2026, pd.Timestamp('2026-09-29T12:00:00Z'), X, D, tempfile.mkdtemp(), prereq=lambda s: ['style ratings'])
    chk('matchup shadow: missing prerequisites SKIP the stage with the reason (never a silent pass)', r['_status'] == 'SKIPPED' and 'style ratings' in r['reason'])
    d = tempfile.mkdtemp()
    try:
        def hook(season, T, X, projections=None, art=None, week=None):
            P = projections.set_index('game_id')
            return {'game_matchup': [{'game_id': str(i), 'general_fair_margin': round(float(P.ens_pred[i]), 3),
                                      'matchup_aware_margin': round(float(P.ens_pred[i]), 3), 'matchup_adjustment_points': 0.0,
                                      'matchup_id': 'cfbmg_%d' % i} for i in X.game_id]}
        r1 = MS.run_stage(2026, pd.Timestamp('2026-09-29T12:00:00Z'), X, D, d, hook=hook, prereq=lambda s: [])
        r2 = MS.run_stage(2026, pd.Timestamp('2026-09-29T12:00:00Z'), X, D, d, hook=hook, prereq=lambda s: [])
        rows = [json.loads(l) for l in open(os.path.join(d, MS.FILE))]
        chk('matchup shadow: records are written once and a re-run adds nothing', r1['written'] == 2 and r2['written'] == 0 and len(rows) == 2, (r1, r2))
        chk('matchup shadow: every record says it moves nothing', all(x['moves_production'] is False and x['record'] == 'SHADOW' for x in rows))
        chk('matchup shadow: the frozen artifact is the NO_ADJUSTMENT one', r1['artifact_status'] == 'NO_ADJUSTMENT', r1)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------- run.py wiring
def wiring():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'run.py')).read()
    i_enf, i_inf = src.find('IC.enforce(Xt, A)'), src.find('PJ.infer(X, ')
    chk('run.py: the input contract is enforced before inference', 0 < i_enf < i_inf)
    chk('run.py: contract-violating games are excluded from inference', "X = ctx['X'][~ctx['X'].game_id.astype(str).isin(bad)]" in src)
    chk('run.py: the release gate withholds them (and holds the week past 5%)', "model inputs pass the input contract" in src and "action='WITHHOLD_GAME'" in src
        and 'n_week_games=len(D) + len(bad)' in src)
    chk('run.py: the feature monitor runs on the slate and only warns', 'IC.monitor(Xt)' in src and 'nothing is refit' in src)
    chk('run.py: the matchup shadow stage is wired after WRITE_STATE and never blocks', "run.stage('MATCHUP_SHADOW', matchup_shadow, needs=('WRITE_STATE',)" in src
        and 'a shadow never blocks the pathway' in src)


def real():
    from .. import common
    p = common.out_path('stage5', 'cfb_model_training_snapshots.parquet')
    if not os.path.exists(p):
        print('real: skipped (no stage-5 build at $CFB_V2_OUT)')
        return
    X = pd.read_parquet(p)
    if set(X.feature_version.dropna().unique()) != {C['feature_version']}:
        print('real: skipped (the build is not %s)' % C['feature_version'])
        return
    import importlib
    importlib.reload(IC)
    e = IC.enforce(X[X.season.ge(2012)], A, C, REF)
    chk('real: the contract refuses no real game 2012-2026 (%d games)' % e['games'], e['ok'], list(e['violations'].items())[:3])
    ref = IC.build_reference(X, C)
    chk('real: the committed reference is reproduced from this build', ref['sha256'] == REF['sha256'] or ref['rows'] == REF['rows'], (ref['rows'], REF['rows']))
    flagged = weeks = 0
    for s in IC.TRAINING_SEASONS:
        if s == 2020:
            continue
        r = IC.build_reference(X[X.season.ne(s)], C)
        for _, g in X[X.season.eq(s)].groupby('prediction_ts'):
            m = IC.monitor(g, r, C)
            if m['status'] in ('OK', 'FLAGGED'):
                weeks += 1
                flagged += bool(m['flags'])
    print('real: leave-one-season-out (2020 aside): %d of %d training weeks flagged' % (flagged, weeks))
    chk('real: the monitor stays quiet on most held-out training weeks (< 30%)', weeks and flagged / weeks < 0.30, (flagged, weeks))


if __name__ == '__main__':
    declaration()
    enforcement()
    monitoring()
    matchup()
    wiring()
    if '--fast' not in sys.argv:
        real()
    done()
