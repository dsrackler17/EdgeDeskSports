"""Tests for the weekly engine's orchestration layer (run tracking, retries,
locking, exactly-once state, the release gate, attribution, degraded modes,
week selection, idempotency, pure/market separation).

    python3 -m v2.weekly.tests_weekly [--fast]

--fast runs the synthetic checks only (seconds; the workflow runs it after
every refresh). Without it, the real-data checks run too (the local stage
outputs must exist). The games/PBP and team/QB layers have their own suites:
v2.weekly.tests_games and v2.weekly.tests_state.
"""
import json
import os
os.environ.setdefault('CFB_WEEKLY_QUIET', '1')
import shutil
import sys
import tempfile

import numpy as np
import pandas as pd

from .. import config as C
from . import gate as GATE
from . import ids
from . import project as PJ
from . import runlog as RL
from .store import Store

if __name__ == '__main__':          # bit-reproducible solves need single-threaded BLAS
    from .runlog import single_thread_blas
    single_thread_blas('v2.weekly.tests_weekly')

PASS, FAIL = [0], []


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL.append((name, detail))


def done():
    for n, d in FAIL:
        print('FAIL | %s%s' % (n, ('  ' + json.dumps(ids.clean(d), default=str)[:400]) if d is not None else ''))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (PASS[0], len(FAIL)))
    sys.exit(0 if not FAIL else 1)


def throws(fn, klass=None):
    try:
        fn()
        return False
    except Exception as e:                           # noqa: BLE001
        return klass is None or isinstance(e, klass)


# ---------------------------------------------------------------- ids
chk('ids: rendering matches the Model Lab (None, numbers, booleans, timestamps)',
    ids.h('a', None, -3.5, 110, 0.0, True, pd.Timestamp('2026-10-01T12:00:00Z')) == '13035e6ba862cd1de93b441e')
chk('ids: -0 renders 0 and 3.0 renders 3', ids.render(-0.0) == '0' and ids.render(3.0) == '3' and ids.render(3.25) == '3.25')
chk('ids: canonical hashing ignores key order', ids.content_hash({'a': 1, 'b': [1, 2]}) == ids.content_hash({'b': [1, 2], 'a': 1}))
chk('ids: NaN and inf become null', ids.clean({'x': float('nan'), 'y': float('inf')}) == {'x': None, 'y': None})

# ---------------------------------------------------------------- runlog
clock = iter(pd.date_range('2026-09-27T10:00Z', periods=400, freq='s'))
run = RL.PipelineRun(2026, 4, 5, 'weekly', 'm', 'f', started_at='2026-09-27T10:00:00Z', clock=lambda: next(clock))
run.data_version = 'dv1'
run.stage('A', lambda rec: {})
run.stage('B', lambda rec: (_ for _ in ()).throw(RL.StageError('bad schema column x', 'SCHEMA')), needs=('A',))
run.stage('C', lambda rec: {}, needs=('B',))
run.stage('D', lambda rec: {}, needs=('A',), skip='nothing changed')
chk('runlog: a failed stage BLOCKS what depends on it', run.stages['B']['status'] == 'FAILED' and run.stages['C']['status'] == 'BLOCKED')
chk('runlog: the failure carries its class', run.stages['B']['error_class'] == 'SCHEMA' and run.errors[0]['class'] == 'SCHEMA')
chk('runlog: a skip is recorded with its reason', run.stages['D']['status'] == 'SKIPPED' and run.stages['D']['error'] == 'nothing changed')
run2 = RL.PipelineRun(2026, 4, 5, 'weekly', 'm', 'f', started_at='2026-09-27T11:00:00Z')
run2.data_version = 'dv1'
chk('runlog: run_key names the work (same inputs), run_id the execution', run.run_key == run2.run_key and run.run_id != run2.run_id)
run2.data_version = 'dv2'
chk('runlog: new data is new work', run.run_key != run2.run_key)
rec = run.record(totals={'games_expected': 3})
chk('runlog: the record carries every brief field', all(k in rec for k in (
    'run_id', 'season', 'source_week', 'target_week', 'started_at', 'completed_at', 'model_version', 'feature_version',
    'data_version', 'status', 'score_ingestion_status', 'pbp_status', 'drive_status', 'player_status',
    'opponent_adjustment_status', 'team_rating_status', 'projection_status', 'market_status', 'model_lab_status',
    'games_expected', 'games_final', 'games_processed', 'plays_expected', 'plays_processed', 'warnings_count', 'errors_count')))
w = RL.PipelineRun(2026, 4, 5, 'weekly', 'm', 'f')
w.stage('X', lambda rec: w.warn('X', 'partial') or {})
chk('runlog: a warning makes the stage WARN, not OK', w.stages['X']['status'] == 'WARN')

# retries: bounded, transient only
calls = []
def flaky():
    calls.append(1)
    if len(calls) < 3:
        raise ConnectionError('connection reset by peer')
    return 'ok'
slept = []
chk('retry: a transient error is retried with exponential backoff', RL.retry(flaky, sleep=slept.append) == 'ok' and slept == [2.0, 4.0])
calls.clear(); slept.clear()
def schema():
    calls.append(1)
    raise KeyError('no such column: epa')
chk('retry: a schema error is never retried', throws(lambda: RL.retry(schema, sleep=slept.append)) and len(calls) == 1 and not slept)
calls.clear(); slept.clear()
def always():
    calls.append(1)
    raise TimeoutError('timed out')
chk('retry: bounded (4 attempts, then raise)', throws(lambda: RL.retry(always, sleep=slept.append)) and len(calls) == 4 and slept == [2.0, 4.0, 8.0])
chk('classify: rate limit / auth / database / data quality',
    RL.classify_error(Exception('HTTP 429 too many requests')) == 'RATE_LIMIT' and RL.classify_error(Exception('403 forbidden')) == 'AUTH'
    and RL.classify_error(Exception('deadlock detected 40P01')) == 'DATABASE'
    and RL.classify_error(Exception('score does not reconcile')) == 'DATA_QUALITY')

# locking: a second holder is refused, the lock is released after
tmp = tempfile.mkdtemp()
lp = os.path.join(tmp, '.weekly.lock')
with RL.RunLock(lp):
    chk('lock: a second concurrent run is refused', throws(lambda: RL.RunLock(lp).__enter__(), RL.StageError))
with RL.RunLock(lp):
    chk('lock: released after the run', True)

# ---------------------------------------------------------------- exactly-once state
st = Store(2026, root=tmp)
row = {'team_id': '251', 'season': 2026, 'week': 4, 'feature_version': 'fv2', 'overall_mean': 10.0, 'run_id': 'r1'}
s1 = st.write_versioned('team_week_state', [row])
s2 = st.write_versioned('team_week_state', [dict(row, run_id='r2')])
chk('state: first write is version 1; an identical re-run writes nothing (provenance ignored)',
    s1 == {'written': 1, 'unchanged': 0, 'corrected': 0} and s2 == {'written': 0, 'unchanged': 1, 'corrected': 0})
s3 = st.write_versioned('team_week_state', [dict(row, overall_mean=10.4)], reason='PBP corrected by the provider')
rows = st.read('team_week_state')
chk('state: a correction is version 2 that supersedes version 1; version 1 stays',
    s3['corrected'] == 1 and len(rows) == 2 and rows[1]['state_version'] == 2 and rows[1]['supersedes'] == rows[0]['state_id']
    and rows[0]['overall_mean'] == 10.0 and rows[1]['reason'] == 'PBP corrected by the provider')
chk('state: current() returns the newest version per key', [r['overall_mean'] for r in st.current('team_week_state')] == [10.4])
chk('state: the id is deterministic from the key and version', rows[0]['state_id'] == 'cfbs_' + ids.h('251', 2026, 4, 'fv2', 1))
n = st.append_unique('projections', [{'projection_id': 'p1'}, {'projection_id': 'p1'}])
n2 = st.append_unique('projections', [{'projection_id': 'p1'}, {'projection_id': 'p2'}])
chk('state: write-once facts are appended once (idempotent re-run)', n == 1 and n2 == 1 and len(st.read('projections')) == 2)

# ---------------------------------------------------------------- pure / market separation
chk('market guard: the artifact reads no market column', PJ.assert_no_market_inputs(
    ['edge_line_yds', 'edge_epa', 'match_mix_edge', 'eff_pts_raw', 'elo_diff']))
for bad in ('spread_open', 'close_margin', 'home_line', 'consensus_price_home', 'book_count', 'market_total', 'ml_home'):
    chk('market guard refuses %s' % bad, throws(lambda b=bad: PJ.assert_no_market_inputs(['edge_epa', b]), AssertionError))

# ---------------------------------------------------------------- degraded modes
chk('modes: clean inputs are FULL', PJ.model_mode(1.0, 'HEALTHY', True, True) == ('FULL', ['FULL']))
p, al = PJ.model_mode(0.5, 'STALE', False, True)
chk('modes: every degradation is kept; PBP outranks availability outranks market',
    p == 'DEGRADED_PBP' and al == ['DEGRADED_PBP', 'DEGRADED_AVAILABILITY', 'DEGRADED_MARKET'])
chk('modes: an artifact failure is FALLBACK', PJ.model_mode(1.0, 'HEALTHY', True, False)[0] == 'FALLBACK')
chk('modes: a degraded projection never carries more reliability than its cap',
    PJ.MODE_CAPS['DEGRADED_PBP'] < PJ.MODE_CAPS['DEGRADED_AVAILABILITY'] < PJ.MODE_CAPS['FULL'] and PJ.MODE_CAPS['FALLBACK'] == 0)

# ---------------------------------------------------------------- gate
def fake_D(n=4, **over):
    d = pd.DataFrame({'game_id': [str(i) for i in range(n)], 'home_id': ['h%d' % i for i in range(n)],
                      'away_id': ['a%d' % i for i in range(n)], 'ens_pred': np.linspace(-7, 7, n), 'sigma': 15.0,
                      'pred_total': 52.0, 'p_home_raw': 0.5, 'p_home_calibrated': 0.5})
    for k, v in over.items():
        d[k] = v
    return d
T = pd.Timestamp('2026-09-29T12:00:00Z')
feats = [{'feature_ts': ids.ts(T), 'kickoff_ts': '2026-10-03T19:30:00.000Z'}] * 4
games = pd.DataFrame({'home_id': ['h0', 'h1', 'h2', 'h3'], 'away_id': ['a0', 'a1', 'a2', 'a3']})
ok_checks = GATE.sanity(fake_D(), feats, games, T, T)
chk('gate: sane projections pass every sanity check', all(c['ok'] for c in ok_checks), [c for c in ok_checks if not c['ok']])
bad = fake_D()
bad.loc[1, 'ens_pred'] = np.nan
bad.loc[2, 'away_id'] = 'h1'            # h1 in two games
bad.loc[3, 'p_home_raw'] = 1.0
fails = {c['check'] for c in GATE.sanity(bad, feats, games, T, T) if not c['ok']}
chk('gate: NaN spread, a team in two games, probability 1 are all caught',
    any('NaN' in f for f in fails) and any('two games' in f for f in fails) and any('probabilities' in f for f in fails), sorted(fails))
late = [{'feature_ts': '2026-10-03T19:30:00.000Z', 'kickoff_ts': '2026-10-03T19:30:00.000Z'}] * 4
chk('gate: post-kickoff data is caught', any('post-kickoff' in c['check'] and not c['ok'] for c in GATE.sanity(fake_D(), late, games, T, T)))
chk('gate: an invalid team id is caught', any('invalid team' in c['check'] and not c['ok']
                                              for c in GATE.sanity(fake_D(home_id=['zz', 'h1', 'h2', 'h3']), feats, games, T, T)))
chk('gate: a margin beyond the total (negative implied points) is caught as a withheld TOTAL',
    any('implied team points' in c['check'] and not c['ok'] and c.get('action') == 'WITHHOLD_TOTAL'
        for c in GATE.sanity(fake_D(pred_total=[30.0, 55, 55, 55], ens_pred=[33.0, 0, 0, 0]), feats, games, T, T)))
chk('gate: an implausible total withholds the game', any('plausible' in c['check'] and not c['ok'] and c.get('action') == 'WITHHOLD_GAME'
                                                        for c in GATE.sanity(fake_D(pred_total=[5.0, 55, 55, 55]), feats, games, T, T)))
chk('gate: an unexplained rating jump is caught', any('explanation' in c['check'] and not c['ok']
                                                     for c in GATE.sanity(fake_D(), feats, games, T, T, team_flags=[{'team_id': 'x', 'drivers': []}])))
r = RL.PipelineRun(2026, 4, 5, 'weekly', 'm', 'f')
for sname in ('INGEST_FINAL_SCORES', 'OPPONENT_ADJUSTMENT'):
    r.stage(sname, lambda rec: {})
g = GATE.release_gate(r, ok_checks, {'converged': True}, {'ok': True}, True, critical_stages=('INGEST_FINAL_SCORES', 'OPPONENT_ADJUSTMENT'))
chk('release gate: passes when everything holds', g['pass'] and not g['failed'])
for name, args in (('not converged', ({'converged': False, 'not_converged': ['epa']}, {'ok': True}, True)),
                   ('artifact changed', ({'converged': True}, {'ok': False, 'reason': 'files differ'}, True)),
                   ('leakage failure', ({'converged': True}, {'ok': True}, False))):
    gg = GATE.release_gate(r, ok_checks, *args, critical_stages=('INGEST_FINAL_SCORES',))
    chk('release gate: blocks on %s' % name, not gg['pass'] and gg['failed'], gg['failed'])
one_bad = GATE.sanity(fake_D(pred_total=[5.0, 55, 55, 55]), feats, games, T, T)
g1 = GATE.release_gate(r, one_bad, {'converged': True}, {'ok': True}, True, n_week_games=40)
chk('release gate: one withheld game of 40 publishes the rest (2.5% <= 5%)', g1['pass'] and len(g1['withheld_games']) == 1, g1['failed'])
g2 = GATE.release_gate(r, one_bad, {'converged': True}, {'ok': True}, True, n_week_games=4)
chk('release gate: one withheld game of 4 holds the week (25% > 5%)', not g2['pass'])
gt = GATE.release_gate(r, GATE.sanity(fake_D(pred_total=[30.0, 55, 55, 55], ens_pred=[33.0, 0, 0, 0]), feats, games, T, T),
                       {'converged': True}, {'ok': True}, True, n_week_games=4)
chk('release gate: an incoherent total withholds only that total; the week publishes', gt['pass'] and len(gt['withheld_totals']) == 1
    and not gt['withheld_games'], gt)
V = pd.DataFrame({'status': ['FINAL_VALIDATED'] * 18 + ['DATA_ERROR'] * 2})
chk('release gate: blocks when data errors exceed the bound', not GATE.release_gate(r, ok_checks, {'converged': True}, {'ok': True}, True,
                                                                                    validation=V)['pass'])
rb = RL.PipelineRun(2026, 4, 5, 'weekly', 'm', 'f')
rb.stage('INGEST_FINAL_SCORES', lambda rec: (_ for _ in ()).throw(ValueError('x')))
chk('release gate: blocks when a critical stage failed', not GATE.release_gate(rb, ok_checks, {'converged': True}, {'ok': True}, True,
                                                                              critical_stages=('INGEST_FINAL_SCORES',))['pass'])

# ---------------------------------------------------------------- weeks and seasons
from .run import season_for, weeks_for
chk('season: January belongs to the season that began in August',
    season_for('2027-01-10T00:00:00Z') == 2026 and season_for('2026-09-27T00:00:00Z') == 2026 and season_for('2027-03-01T00:00:00Z') == 2027)
G = pd.DataFrame({'season': 2026, 'week': [4, 4, 5, 5, 6],
                  'kickoff_ts': pd.to_datetime(['2026-09-26T19:00Z', '2026-09-27T00:30Z', '2026-10-03T19:00Z', '2026-10-03T23:00Z', '2026-10-10T19:00Z']),
                  'prediction_ts': pd.to_datetime(['2026-09-22T12:00Z', '2026-09-22T12:00Z', '2026-09-29T12:00Z', '2026-09-29T12:00Z', '2026-10-06T12:00Z'])})
chk('weeks: Sunday after week 4 -> source 4, target 5, T = Tue 12:00',
    weeks_for(G, 2026, pd.Timestamp('2026-09-27T10:05Z'), 'weekly') == (4, 5, pd.Timestamp('2026-09-29T12:00Z')))
chk('weeks: Tuesday after the freeze instant -> freeze the current week',
    weeks_for(G, 2026, pd.Timestamp('2026-09-29T12:07Z'), 'freeze') == (4, 5, pd.Timestamp('2026-09-29T12:00Z')))
chk('weeks: Wednesday daily prepares the next unfrozen week',
    weeks_for(G, 2026, pd.Timestamp('2026-09-30T10:47Z'), 'daily')[1] == 6)
chk('weeks: rebuild through week 4 uses the week-5 freeze instant',
    weeks_for(G, 2026, None, 'rebuild', through_week=4) == (4, 5, pd.Timestamp('2026-09-29T12:00Z')))
chk('weeks: a freeze with nothing between freeze and kickoff does nothing',
    weeks_for(G, 2026, pd.Timestamp('2026-09-28T10:00Z'), 'freeze') == (None, None, None))

# ---------------------------------------------------------------- real data (slow)
if '--fast' not in sys.argv:
    from .. import predict_live as PL
    art = PJ.verify_artifact(C.MODEL_VERSION)
    chk('artifact: the production artifact verifies against MANIFEST.json', art['ok'], art.get('reason'))
    A, gbm = PL.load_artifacts(C.MODEL_VERSION)
    X = pd.read_parquet(os.path.join(C.OUT, 'stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[X.season.eq(2025)].head(40)
    D = PJ.infer(X, A, gbm)
    ref = PL.predict(X, A, gbm)
    chk('inference: the engine reproduces production predict() exactly', np.allclose(D.ens_pred, ref.ens_pred, atol=0, rtol=0))
    chk('calibration: method raw leaves p unchanged', np.allclose(D.p_home_calibrated, D.p_home_raw))
    chk('intervals: nested 50 < 80 < 95 around the prediction',
        bool(((D.int50_low > D.int80_low) & (D.int80_low > D.int95_low) & (D.int50_low < D.ens_pred) & (D.ens_pred < D.int50_high)).all()))
    F = PJ.upcoming_features(X, A, X.prediction_ts.iloc[0], {'data_version': 'dv'})
    F2 = PJ.upcoming_features(X, A, X.prediction_ts.iloc[0], {'data_version': 'dv'})
    chk('features: deterministic (same inputs -> same hashes and ids)', [f['feature_snapshot_id'] for f in F] == [f['feature_snapshot_id'] for f in F2])
    chk('features: every snapshot is before its kickoff', all(f['feature_ts'] < f['kickoff_ts'] for f in F))
    # attribution sums exactly to the change, and a stored snapshot reproduces its projection
    f0 = F[0]
    new = dict(f0['inputs'])
    for c, dv in (('edge_epa', 0.25), ('qb_exp_edge', -0.1), ('rest_diff', 3.0)):
        new[c] = (new.get(c) or 0.0) + dv
    cols = sorted(new)
    Xa = pd.DataFrame([{c: f0['inputs'].get(c) for c in cols}, {c: new.get(c) for c in cols}]).astype(float)
    wC, wD = A['stack_weights']['C_ridge'], A['stack_weights']['D_gbm']
    pa = wC * PL.LinearArt(A['submodels']['C_ridge']).predict(Xa) + wD * gbm.predict(Xa[A['submodels']['D_gbm']['cols']].values)
    att = PJ.attribute(f0['inputs'], new, A, gbm, pa[0], pa[1])
    chk('attribution: the families sum to the projection change (exact, < 1e-6)', abs(att['unexplained']) < 1e-6, att)
    chk('attribution: names the inputs that changed', set(att['changed_inputs']) == {'edge_epa', 'qb_exp_edge', 'rest_diff'})
    chk('features: a stored snapshot reproduces its projection', abs(float(pa[0]) - float(D.ens_pred.iloc[0])) < 1e-9)
    # a market move does not change the pure projection: shuffle every market column
    X2 = X.copy()
    for c in [c for c in X2.columns if set(c.lower().split('_')) & PJ.MARKET_TOKENS or c in PJ.MARKET_COLUMNS]:
        X2[c] = X2[c].sample(frac=1.0, random_state=1).values if X2[c].dtype.kind in 'fi' else X2[c]
    chk('pure/market separation: scrambling market columns leaves every projection unchanged',
        np.allclose(PJ.infer(X2, A, gbm).ens_pred, D.ens_pred, atol=0, rtol=0))
    # projection records: same inputs -> nothing new; changed inputs -> a new record + a change record
    modes = {str(g): ('FULL', ['FULL']) for g in X.game_id}
    recs, ch, fl = PJ.projection_records(D, F, 'run1', {'data_version': 'dv'}, {}, A, gbm, modes, True)
    prev = {r['game_id']: dict(r, _inputs=next(f['inputs'] for f in F if f['game_id'] == r['game_id'])) for r in recs}
    recs2, ch2, _ = PJ.projection_records(D, F, 'run2', {'data_version': 'dv'}, prev, A, gbm, modes, False)
    chk('projections: an unchanged game makes no new projection (idempotent, no contradictions)', len(recs) == len(D) and not recs2 and not ch2)
    shutil.rmtree(tmp, ignore_errors=True)

# ---------------------------------------------------------------- miss classification
from . import misses as MS
hp = {'margin': -14, 'expected_performance_margin': 5.0, 'turnover_luck_game': -10.0, 'st_net_epa': 0.5, 'has_pbp': True,
      'return_tds': 0, 'pace_plays': 70, 'explosive_execution': 0.1}
ap = {'turnover_luck_game': 5.0, 'return_tds': 0, 'pace_plays': 70, 'explosive_execution': 0.1}
chk('misses: a small error is not a miss', MS.classify_game({'game_id': 1, 'ens_pred': 7}, dict(hp, margin=0), ap) is None)
m1 = MS.classify_game({'game_id': 1, 'ens_pred': 7}, hp, ap)
chk('misses: a turnover-driven miss names TURNOVER_LUCK with its points', m1['primary_driver'] == 'TURNOVER_LUCK'
    and m1['components']['TURNOVER_LUCK'] == -15.0 and abs(m1['performance_gap'] + m1['scoreboard_gap'] - m1['error']) < 1e-9, m1)
m2 = MS.classify_game({'game_id': 2, 'ens_pred': 7}, dict(hp, expected_performance_margin=-12.0, turnover_luck_game=0.0), dict(ap, turnover_luck_game=0.0),
                      qb_events=[{'event_type': 'NEW_STARTER'}])
chk('misses: a performance miss with a QB change names QB_CHANGE', m2['primary_driver'] == 'QB_CHANGE', m2)
m3 = MS.classify_game({'game_id': 3, 'ens_pred': 7}, dict(hp, expected_performance_margin=-12.0, turnover_luck_game=0.0), dict(ap, turnover_luck_game=0.0))
chk('misses: a performance miss with no measured cause is TEAM_PERFORMANCE', m3['primary_driver'] == 'TEAM_PERFORMANCE', m3)
m4 = MS.classify_game({'game_id': 4, 'ens_pred': 7}, dict(hp, expected_performance_margin=None, has_pbp=False), ap)
chk('misses: no play-by-play is UNEXPLAINED, never a guess', m4['primary_driver'] == 'UNEXPLAINED', m4)
m5 = MS.classify_game({'game_id': 5, 'ens_pred': 7}, dict(hp, turnover_luck_game=-2.0), dict(ap, turnover_luck_game=0.0))
chk('misses: a turnover part under one turnover never leads', m5['primary_driver'] != 'TURNOVER_LUCK', m5)

# ---------------------------------------------------------------- report tables
from . import report as RP
Gr = pd.DataFrame({'season': [2026, 2026], 'home_id': [1, 3], 'away_id': [2, 4], 'home_team': ['A', 'C'], 'away_team': ['B (FCS)', 'D'],
                   'home_fbs': [True, True], 'away_fbs': [False, True]})
Sr = pd.DataFrame({'team_id': [1, 2, 3, 4], 'record': ['1-0', '0-1', '1-0', '0-1'], 'scoreboard_margin': [40.0, -40.0, 3.0, -3.0],
                   'performance_margin': [10.0, -70.0, 1.0, -1.0]})
pt = RP._perf_table(Sr, names=RP._fbs_names(Gr, 2026))
chk('report: record-vs-performance ranks FBS teams only, by name', [r['team'] for r in pt] == ['A', 'C', 'D'], pt)

done()
