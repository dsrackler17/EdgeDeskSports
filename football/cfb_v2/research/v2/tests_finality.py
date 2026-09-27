"""Finality tests (audit finding F-01): only a completed game is a result.

    python3 -m v2.tests_finality

Before the fix, stage 2 (v2/games.py) called a game FINAL whenever both scores were
present, so 2026 games in progress at the fetch (partial scores) and the cancelled
2024 App State-Liberty game (0-0) were rated, fed Elo and QB state, and were graded.

Synthetic checks run anywhere. Real-data checks run when the raw files
($CFB_V2_DATA) and a patched build ($CFB_V2_OUT) exist, and are skipped otherwise:
  * the stage-2 classifier and the weekly engine's validator agree on every game
    2009-2026 that kicked off before the fetch;
  * the 169 scored-but-not-completed rows of 2014-2023 never reach stage 2;
  * the 2014-2023 rows of the stage-2 game table are byte-identical to the v2.1.0
    build's (pinned digest below), so the development window did not move.
"""
import hashlib
import json
import os
import sys
import traceback

import numpy as np
import pandas as pd

from . import common
from . import config as C
from . import elo as ELO
from . import games as GM
from .weekly import validate as VAL

RESULTS = []

# The digest of the 2014-2023 rows of the v2.1.0 stage-2 game table (the pre-fix
# build, research/out_h/stage2/games.parquet, sha256 f6fb1e17... as recorded in
# docs/cfb-audit/SNAPSHOT.json): 8,520 rows. See `table_digest`.
V210_GAMES_2014_2023 = {'rows': 8520,
                        'digest': '2f09e0a99d467f9cbdcc82db2f3112eee63e71d081fce4d13b085b2a61f61922'}
# The 2009-2023 rows (burn-in + development) of the same table.
V210_GAMES_2009_2023 = {'rows': 12636,
                        'digest': '40109f4f39f353779a1f0bd6c4ec35c2a1ac28e673d5be05ef6268be99a8639a'}
# Scored rows the provider marks not completed, 2014-2023 (all cancellations or
# postponements, 168 of them 0-0; none has an FBS side), per season.
UNCOMPLETED_SCORED_2014_2023 = {2014: 3, 2015: 3, 2016: 3, 2017: 13, 2018: 11, 2019: 1, 2020: 121,
                                2021: 4, 2022: 4, 2023: 6}


def test(fn):
    RESULTS.append(fn)
    return fn


def table_digest(df):
    """Canonical content digest of a table: column names, dtypes and every value
    (pandas' stable row hashes), rows ordered by game_id."""
    df = df.sort_values('game_id', kind='mergesort').reset_index(drop=True)
    h = hashlib.sha256()
    h.update(json.dumps([[c, str(df[c].dtype)] for c in df.columns]).encode())
    h.update(pd.util.hash_pandas_object(df, index=False).values.tobytes())
    return h.hexdigest()


NOW = pd.Timestamp('2026-09-27T07:21:00Z')
KICK = '2026-09-26T23:00:00.000Z'


def row(gid, hp, ap, completed, status=None, notes=None, pbp=None, kick=KICK):
    return {'game_id': gid, 'season': 2026, 'week': 4, 'season_type': 'regular', 'start_date': kick,
            'kickoff_ts': pd.Timestamp(kick), 'completed': completed, 'provider_status': status, 'status': status,
            'notes': notes, 'home_points': hp, 'away_points': ap, 'pbp_completed': pbp,
            'home_id': 1000 + gid, 'away_id': 2000 + gid, 'home_division': 'fbs', 'away_division': 'fbs'}


# every case the audit named, plus the neighbours of each
CASES = {
    'in_progress_partial_score': (row(1, 21, 3, False, 'STATUS_IN_PROGRESS'), 'IN_PROGRESS'),
    'in_progress_0_0': (row(2, 0, 0, False, 'STATUS_IN_PROGRESS'), 'IN_PROGRESS'),
    'halftime_with_completed_flag': (row(3, 52, 3, True, 'STATUS_HALFTIME', pbp=False), 'IN_PROGRESS'),
    'completed_but_pbp_not': (row(4, 24, 17, True, 'STATUS_FINAL', pbp=False), 'IN_PROGRESS'),
    'cancelled_0_0': (row(5, 0, 0, False, 'STATUS_CANCELED'), 'CANCELED'),
    'cancelled_abandoned_7_0': (row(6, 7, 0, False, 'STATUS_CANCELED'), 'CANCELED'),
    'postponed': (row(7, 0, 0, False, 'STATUS_POSTPONED'), 'POSTPONED'),
    'postponed_in_notes': (row(8, None, None, False, None, notes='Game postponed due to weather'), 'POSTPONED'),
    'forfeit': (row(9, 1, 0, True, None, notes='Roanoke College wins by forfeit'), 'CANCELED'),
    'real_final': (row(10, 49, 18, True, 'STATUS_FINAL', pbp=True), 'FINAL'),
    'real_final_no_provider_status': (row(11, 31, 28, True, None), 'FINAL'),
    'completed_0_0_tie': (row(12, 0, 0, True, 'STATUS_FINAL', pbp=True), 'DATA_ERROR'),
    'completed_14_14_tie': (row(13, 14, 14, True, None), 'DATA_ERROR'),
    'provider_final_without_completed_flag': (row(14, 24, 10, False, 'STATUS_FINAL'), 'IN_PROGRESS'),
    'completed_flag_missing': (row(15, 24, 10, None, None), 'IN_PROGRESS'),
    'completed_without_score': (row(16, None, None, True, None), 'DATA_ERROR'),
}


@test
def classifier_every_case():
    for name, (r, want) in CASES.items():
        got, why, _ = GM.classify_result(r['completed'], r['provider_status'], r['notes'], r['home_points'],
                                         r['away_points'], r['pbp_completed'])
        assert got == want, (name, got, want, why)
        if got != 'FINAL':
            assert why, (name, 'a non-result carries its reason')


@test
def only_final_is_a_result_in_stage2():
    G = pd.DataFrame([r for r, _ in CASES.values()] + [
        row(20, None, None, False, None, kick='2026-09-26T20:00:00.000Z'),      # past, no score
        row(21, None, None, False, None, kick='2030-10-03T19:00:00.000Z')])     # future
    G, why = GM.assign_status(G, now=NOW)
    want = {r['game_id']: w for r, w in CASES.values()}
    want.update({20: 'NOT_PLAYED', 21: 'SCHEDULED'})
    assert dict(zip(G.game_id, G.status)) == want, dict(zip(G.game_id, G.status))
    fin = G.status.eq('FINAL')
    assert fin.sum() == 2
    assert (G.loc[fin, 'margin'] == G.loc[fin, 'home_points'] - G.loc[fin, 'away_points']).all()
    assert G.loc[~fin, 'margin'].isna().all() and G.loc[~fin, 'total_pts'].isna().all(), \
        'an in-progress, cancelled, postponed or impossible game carries a margin'
    GM.check_finality(G.drop(columns=['provider_status', 'pbp_completed']))


@test
def stage2_invariant_refuses_a_non_final_result():
    G = pd.DataFrame([CASES['in_progress_partial_score'][0], CASES['real_final'][0]])
    G, _ = GM.assign_status(G, now=NOW)
    bad = G.copy()
    bad.loc[bad.game_id.eq(1), 'margin'] = 18.0                   # a partial score slipped in as a result
    try:
        GM.check_finality(bad)
    except AssertionError:
        pass
    else:
        raise AssertionError('check_finality accepted a margin on an IN_PROGRESS row')
    bad = G.copy()
    bad.loc[bad.game_id.eq(1), 'status'] = 'FINAL'                 # the old rule
    bad.loc[bad.game_id.eq(1), 'margin'] = 18.0
    try:
        GM.check_finality(bad)
    except AssertionError:
        pass
    else:
        raise AssertionError('check_finality accepted FINAL without completed == True')


@test
def weekly_validator_agrees_with_stage2():
    """The weekly engine's finality (with the clock) and stage 2 (without) put every
    past game in the same result / not-a-result class."""
    S = pd.DataFrame([r for r, _ in CASES.values()])
    fin = VAL.finality(S, NOW, {r['game_id']: r['pbp_completed'] for r, _ in CASES.values()
                                if r['pbp_completed'] is not None}).set_index('game_id')
    G, _ = GM.assign_status(S.copy(), now=NOW)
    for gid, st in zip(G.game_id, G.status):
        v = fin.loc[gid, 'pre_status']
        assert (st == 'FINAL') == (v == 'FINAL'), (gid, st, v)
        if st in ('CANCELED', 'POSTPONED', 'DATA_ERROR', 'IN_PROGRESS'):
            assert v == st, (gid, st, v)


@test
def weekly_verify_refuses_stage2_results_the_validator_rejects():
    S = pd.DataFrame([CASES[k][0] for k in ('in_progress_partial_score', 'real_final', 'cancelled_0_0')])
    V = pd.DataFrame({'game_id': [1, 10, 5], 'status': ['IN_PROGRESS', 'FINAL_VALIDATED', 'CANCELED'],
                      'home_points': [None, 49, None], 'away_points': [None, 18, None],
                      'issues': [['sources disagree'], [], []]})
    G, _ = GM.assign_status(S.copy(), now=NOW)
    assert VAL.stage2_final_violations(G, V, 2026) == []
    legacy = G.copy()                        # the pre-fix table: every scored row FINAL
    legacy['status'] = 'FINAL'
    legacy['margin'] = legacy.home_points - legacy.away_points
    bad = VAL.stage2_final_violations(legacy, V, 2026)
    assert sorted(b['game_id'] for b in bad) == [1, 5], bad
    wrong = G.copy()
    wrong.loc[wrong.game_id.eq(10), 'home_points'] = 21.0        # a partial score of a final game
    assert [b['game_id'] for b in VAL.stage2_final_violations(wrong, V, 2026)] == [10]


@test
def elo_never_absorbs_a_non_result():
    """Elo reads results only: adding in-progress, cancelled and impossible rows to the
    table leaves every snapshot unchanged."""
    base = []
    t0 = pd.Timestamp('2025-09-06T19:00:00Z')
    for w in range(6):
        k = t0 + pd.Timedelta(days=7 * w)
        base.append(dict(game_id=100 + w, season=2025, home_id=1, away_id=2 + (w % 3), neutral_site=False,
                         home_fbs=True, away_fbs=True, kickoff_ts=k, prediction_ts=k - pd.Timedelta(days=4),
                         status='FINAL', margin=float(7 * (w % 2) - 3)))
    extra = []
    for i, (r, want) in enumerate(CASES.values()):
        if want == 'FINAL':
            continue
        k = t0 + pd.Timedelta(days=7 * (i % 6) + 1)
        m = (r['home_points'] or 0) - (r['away_points'] or 0)
        extra.append(dict(game_id=900 + i, season=2025, home_id=1, away_id=3, neutral_site=False, home_fbs=True,
                          away_fbs=True, kickoff_ts=k, prediction_ts=k - pd.Timedelta(days=4), status=want,
                          margin=float(m)))              # even a stray margin must not be read
    G0 = pd.DataFrame(base)
    G1 = pd.concat([G0, pd.DataFrame(extra)], ignore_index=True)
    s0, _ = ELO.run_elo(G0)
    s1, _ = ELO.run_elo(G1)
    assert len(s0) >= 5 and any(v != 1500.0 for v in s0[max(s0)].values()), 'the results moved nothing'
    for T, snap in s0.items():
        assert s1[T] == snap, (T, snap, s1[T])


# ------------------------------------------------------------- real data
def _have_data():
    return os.path.exists(common.data_path('sched', 'cfb_schedules_2026.parquet'))


def _stage2():
    f = common.out_path('stage2', 'games.parquet')
    if not os.path.exists(f):
        return None
    G = pd.read_parquet(f)
    rep = common.out_path('stage2', 'report.json')
    patched = os.path.exists(rep) and json.load(open(rep)).get('finality_rule') == GM.FINALITY_RULE
    return G if patched else None


@test
def real_classifier_and_validator_agree_2009_2026():
    if not _have_data():
        return 'skipped (no raw data)'
    n = 0
    for S in range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1):
        s = VAL.load_schedule_raw(S)
        fi = GM.finality_inputs(S).set_index('game_id')
        s = s[(s.home_division.eq('fbs') | s.away_division.eq('fbs'))].copy()
        kick = pd.to_datetime(s.start_date, utc=True, errors='coerce')
        s = s[kick < NOW]
        pc = {int(g): v for g, v in fi.pbp_completed.items() if v is not None}
        v = VAL.finality(s, NOW, pc).set_index('game_id')
        for r in s.itertuples(index=False):
            st, _, _ = GM.classify_result(r.completed, fi.loc[r.game_id, 'provider_status'], r.notes,
                                          r.home_points, r.away_points, pc.get(int(r.game_id)))
            assert (st == 'FINAL') == (v.loc[r.game_id, 'pre_status'] == 'FINAL'), (S, r.game_id, st,
                                                                                       v.loc[r.game_id, 'pre_status'])
            n += 1
    return '%d FBS games agree' % n


@test
def real_uncompleted_scored_rows_2014_2023_never_reach_stage2():
    if not _have_data():
        return 'skipped (no raw data)'
    G = _stage2()
    got = {}
    for S in range(2014, 2024):
        s = pd.read_parquet(common.data_path('sched', 'cfb_schedules_%d.parquet' % S))
        u = s[s.home_points.notna() & s.away_points.notna() & ~s.completed.fillna(False).astype(bool)]
        got[S] = int(len(u))
        # no FBS side: the stage-2 FBS filter drops every one of them ...
        assert not (u.home_division.eq('fbs') | u.away_division.eq('fbs')).any(), (S, 'an FBS side')
        # ... and even if one were kept it would not be a result
        for r in u.itertuples(index=False):
            st, _, _ = GM.classify_result(r.completed, r.status, r.notes, r.home_points, r.away_points)
            assert st != 'FINAL', (S, r.game_id)
        if G is not None:
            assert not set(pd.to_numeric(u.game_id)) & set(G.game_id), (S, 'reached stage 2')
    assert got == UNCOMPLETED_SCORED_2014_2023, got
    return '169 rows checked%s' % ('' if G is not None else ' (no patched stage-2 build: membership not checked)')


@test
def real_stage2_2014_2023_byte_identical_to_v210():
    G = _stage2()
    if G is None:
        return 'skipped (no patched stage-2 build at CFB_V2_OUT)'
    for pin, lo in ((V210_GAMES_2014_2023, 2014), (V210_GAMES_2009_2023, C.FIRST_PBP_SEASON)):
        g = G[G.season.between(lo, 2023)]
        assert len(g) == pin['rows'], (lo, len(g))
        assert table_digest(g) == pin['digest'], ('stage-2 game rows %d-2023 changed' % lo)
    ref = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'out_h', 'stage2', 'games.parquet')
    if os.path.exists(ref):                          # the audited v2.1.0 build, when it is on disk
        R = pd.read_parquet(ref)
        a = G[G.season.between(2014, 2023)].reset_index(drop=True)
        b = R[R.season.between(2014, 2023)].reset_index(drop=True)
        assert a.equals(b), 'stage-2 2014-2023 rows differ from out_h'
    return 'games 2009-2023 match the v2.1.0 digest'


@test
def real_market_table_does_not_read_finality():
    """F-01 changes the game table only: the market table is built from the game ids,
    which the fix does not change, so its content cannot depend on a status."""
    G = _stage2()
    if G is None:
        return 'skipped (no patched stage-2 build at CFB_V2_OUT)'
    csv = os.environ.get('CFB_V2_V1_MARKET', '')
    a = GM.build_market(G, csv, common.data_path('mline'))
    L = G.copy()
    L['status'] = np.where(L.home_points.notna() & L.away_points.notna(), 'FINAL', 'SCHEDULED')   # the old rule
    L['margin'] = L.home_points - L.away_points
    b = GM.build_market(L, csv, common.data_path('mline'))
    assert a.reset_index(drop=True).equals(b.reset_index(drop=True))


@test
def real_named_games_are_not_results():
    G = _stage2()
    if G is None:
        return 'skipped (no patched stage-2 build at CFB_V2_OUT)'
    g = G.set_index('game_id')
    if 401640992 in g.index:                     # 2024 App State-Liberty, cancelled (hurricane), 0-0 in the feed
        assert g.loc[401640992, 'status'] == 'CANCELED' and np.isnan(g.loc[401640992, 'margin'])
    # every scored FBS row the provider has not completed is not a result
    s = pd.read_parquet(common.data_path('sched', 'cfb_schedules_%d.parquet' % C.LIVE_SEASON))
    u = s[s.home_points.notna() & ~s.completed.fillna(False).astype(bool)]
    u = u[pd.to_numeric(u.game_id).isin(g.index)]
    assert (g.loc[pd.to_numeric(u.game_id), 'status'] != 'FINAL').all()
    assert g.loc[pd.to_numeric(u.game_id), 'margin'].isna().all()
    fin = G[G.status.eq('FINAL')]
    assert fin.completed.astype(bool).all() and fin.margin.ne(0).all()
    return '%d %d uncompleted scored rows are not results' % (len(u), C.LIVE_SEASON)


def main():
    fail = 0
    for fn in RESULTS:
        try:
            r = fn()
            print('ok   ' + fn.__name__ + ('  [%s]' % r if isinstance(r, str) else ''))
        except Exception:
            fail += 1
            print('FAIL ' + fn.__name__)
            traceback.print_exc()
    print('%d/%d passed' % (len(RESULTS) - fail, len(RESULTS)))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
