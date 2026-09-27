"""Tests for the games layer: finality, PBP validation, play context classes, game
performance, expected performance margin, turnover luck, explosive dependency.

    python3 -m v2.weekly.tests_games [--fast]

--fast runs the synthetic checks only (seconds). Without it the real-data checks run
too (data/pbp, data/sched and the committed artifact must exist; the expected-margin
refit takes about a minute).
"""
import json
import os
import sys
import tempfile

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import plays as V2P
from . import gamestate as GS
from . import ids
from . import perf as PF
from . import validate as VAL

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


def throws(fn):
    try:
        fn()
        return False
    except Exception:                                  # noqa: BLE001
        return True


# ------------------------------------------------------------ synthetic data
NOW = pd.Timestamp('2025-10-07T12:00:00Z')
KICK = '2025-10-04T19:30:00.000Z'
HOME, AWAY = 10, 20
# drive index -> points; even drives are the away offense, odd the home offense
DEFAULT_SCORES = {1: 7, 2: 7, 5: 7, 8: 7, 13: 7}             # final 21-14


def synth_game(gid=1, scores=None, drives_per_q=5, plays_per_drive=8, ot_scores=None):
    """A clean, complete game: 4 quarters x drives_per_q drives x plays_per_drive rush
    plays, alternating possession (away first), one missing play number at each
    quarter break (the provider's end-of-period rows)."""
    scores = DEFAULT_SCORES if scores is None else scores
    rows, gpn, seq, hs, as_ = [], 0, 1000, 0, 0
    n_reg = 4 * drives_per_q
    drives = [(j, j // drives_per_q + 1) for j in range(n_reg)]
    if ot_scores is not None:
        drives += [(n_reg + i, 5) for i in range(len(ot_scores))]
    prev_per = 1
    for j, per in drives:
        if per != prev_per:
            gpn += 1                                 # end-of-period row removed by the provider
            prev_per = per
        off = AWAY if j % 2 == 0 else HOME
        dfn = HOME if off == AWAY else AWAY
        pts = scores.get(j, 0) if per <= 4 else ot_scores[j - n_reg]
        for i in range(plays_per_drive):
            gpn += 1
            seq += 1
            last = i == plays_per_drive - 1
            if last and pts:
                if off == HOME:
                    hs += pts
                else:
                    as_ += pts
            rows.append({
                'game_id': gid, 'id': gid * 100000 + gpn, 'sequenceNumber': seq, 'game_play_number': gpn,
                'period': per, 'pos_team_id': off, 'def_pos_team_id': dfn, 'homeTeamId': HOME,
                'awayTeamId': AWAY, 'down': i % 4 + 1, 'distance': 10, 'start.yardsToEndzone': 75 - 8 * i,
                'start.yardLine': 75 - 8 * i, 'homeScore': hs, 'awayScore': as_,
                'drive.id': '%d%02d' % (gid, j), 'text_dupe': False,
                'type.text': 'Rushing Touchdown' if (last and pts) else 'Rush',
                'status_type_completed': True, 'rush': True, 'pass': False, 'penalty_no_play': False,
            })
    return pd.DataFrame(rows)


def sched_row(gid=1, hp=21, ap=14, completed=True, status='STATUS_FINAL', notes=None, kick=KICK, **kw):
    r = {'game_id': gid, 'season': 2025, 'week': 6, 'season_type': 'regular', 'start_date': kick,
         'completed': completed, 'status': status, 'notes': notes, 'home_id': HOME, 'away_id': AWAY,
         'home_points': hp, 'away_points': ap, 'home_division': 'fbs', 'away_division': 'fbs'}
    r.update(kw)
    return r


def run1(pbp, **srow):
    s = pd.DataFrame([sched_row(**srow)])
    ref = float(len(synth_game()))
    v = VAL.validate_games(2025, NOW, pbp=pbp, sched=s, ref_plays=ref)
    return v.iloc[0]


def test_finality():
    g = synth_game()
    r = run1(g)
    chk('final game with clean PBP is FINAL_VALIDATED', r.status == 'FINAL_VALIDATED', dict(r.issues))
    chk('validated game: every check passes', all(r.checks.values()), r.checks)
    chk('validated game: completeness 1', abs(r.pbp_completeness_score - 1.0) < 1e-9, r.pbp_completeness_score)
    chk('validated game: PBP score reconciles', r.score_reconciles and r.pbp_score_home == 21 and r.pbp_score_away == 14)
    chk('validated game: no overtime, 4 periods', r.overtime is not None and not r.overtime and r.periods == 4)
    chk('rule version', r.rule_version == 'cfb_game_validation_v1')
    chk('validated_at is now', r.validated_at == ids.ts(NOW))
    e = g.iloc[0:0]
    r = run1(e, hp=0, ap=0, completed=False, status='STATUS_POSTPONED')
    chk('postponed status -> POSTPONED', r.status == 'POSTPONED' and r.home_points is None, r.status)
    r = run1(e, hp=None, ap=None, completed=False, status=None, notes='Game postponed due to weather')
    chk('postponed in notes -> POSTPONED', r.status == 'POSTPONED', r.status)
    r = run1(e, hp=0, ap=0, completed=False, status='STATUS_CANCELED')
    chk('canceled status -> CANCELED', r.status == 'CANCELED', r.status)
    r = run1(e, hp=1, ap=0, completed=True, status=None, notes='Roanoke College wins by forfeit')
    chk('forfeit -> CANCELED with an issue', r.status == 'CANCELED' and any('forfeit' in i for i in r.issues))
    kick_2h = (NOW - pd.Timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    r = run1(e, hp=None, ap=None, completed=False, status=None, kick=kick_2h)
    chk('kicked off 2h ago, no result -> IN_PROGRESS, not overdue', r.status == 'IN_PROGRESS' and not r.overdue)
    kick_10h = (NOW - pd.Timedelta(hours=10)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    r = run1(e, hp=7, ap=3, completed=False, status='STATUS_IN_PROGRESS', kick=kick_10h)
    chk('no final 10h after kickoff -> IN_PROGRESS and overdue', r.status == 'IN_PROGRESS' and r.overdue, dict(r))
    kick_future = (NOW + pd.Timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    r = run1(e, hp=None, ap=None, completed=False, status=None, kick=kick_future)
    chk('future kickoff -> SCHEDULED', r.status == 'SCHEDULED', r.status)
    r = run1(g, kick=kick_future)
    chk('a result in the file for a future kickoff is ignored (point in time)', r.status == 'SCHEDULED', r.status)
    r = run1(g, status='STATUS_HALFTIME')
    chk('completed flag but provider HALFTIME -> IN_PROGRESS, sources disagree',
        r.status == 'IN_PROGRESS' and not r.sources_agree, dict(r))
    g2 = g.copy()
    g2['status_type_completed'] = False
    r = run1(g2)
    chk('completed flag but PBP not completed -> IN_PROGRESS', r.status == 'IN_PROGRESS' and not r.sources_agree)
    r = run1(e, hp=None, ap=None, completed=True, status=None)
    chk('completed without a score -> DATA_ERROR', r.status == 'DATA_ERROR', r.status)
    r = run1(e)
    chk('final score, no PBP -> FINAL_PARTIAL_DATA, completeness 0',
        r.status == 'FINAL_PARTIAL_DATA' and r.pbp_completeness_score == 0.0 and r.overtime is None, dict(r))
    # source_week filter
    s = pd.DataFrame([sched_row(1), sched_row(2, week=7)])
    v = VAL.validate_games(2025, NOW, source_week=7, pbp=pd.concat([g, synth_game(2)]), sched=s, ref_plays=160.0)
    chk('source_week keeps only that week', list(v.game_id) == [2], list(v.game_id))


def test_overtime():
    g = synth_game(scores={1: 7, 2: 7, 5: 7, 8: 7}, ot_scores=[0, 7])      # 14-14 after regulation, home wins 21-14
    r = run1(g)
    chk('OT game detected from period >= 5', bool(r.overtime) and r.periods == 5, dict(r))
    chk('OT game: regulation tied -> overtime_consistent', r.checks['overtime_consistent'], r.issues)
    chk('OT game validates', r.status == 'FINAL_VALIDATED', r.issues)
    g = synth_game(ot_scores=[0, 7])                                          # 21-14 after regulation, then OT
    r = run1(g, hp=28, ap=14)
    chk('OT periods after an untied regulation -> overtime_consistent False',
        r.checks['overtime_consistent'] is False and any('overtime' in i for i in r.issues), r.issues)
    g = synth_game(scores={1: 7, 2: 7})                                        # 7-7, no OT
    r = run1(g, hp=7, ap=7)
    chk('tied final without OT -> overtime_consistent False', r.checks['overtime_consistent'] is False)


def test_pbp_checks():
    g = synth_game()
    # duplicates: one text_dupe row, one repeated play id
    d = pd.concat([g, g.iloc[[10]].assign(text_dupe=True), g.iloc[[20]]], ignore_index=True)
    r = run1(d)
    chk('duplicate plays -> no_duplicate_plays False', r.checks['no_duplicate_plays'] is False, r.checks)
    chk('a few duplicates -> FINAL_PARTIAL_DATA', r.status == 'FINAL_PARTIAL_DATA', r.status)
    chk('duplicates are excluded from the play count', r.pbp_plays == len(g), r.pbp_plays)
    d = pd.concat([g, g.iloc[:20].assign(text_dupe=True)], ignore_index=True)
    r = run1(d)
    chk('duplicates beyond 5% -> DATA_ERROR (corrupted)', r.status == 'DATA_ERROR', r.status)
    # bad downs
    d = g.copy()
    d.loc[[3, 40, 90], 'down'] = 7
    r = run1(d)
    chk('3 bad downs -> down_valid False', r.checks['down_valid'] is False, r.checks)
    chk('bad downs are non-critical (status stays validated)', r.status == 'FINAL_VALIDATED', r.status)
    d = g.copy()
    d.loc[[3, 40], 'down'] = 0
    chk('2 bad downs are within tolerance', run1(d).checks['down_valid'])
    d = g.copy()
    d.loc[[3, 40, 90], 'distance'] = 120
    chk('distance outside 0..99 -> distance_valid False', run1(d).checks['distance_valid'] is False)
    d = g.copy()
    d.loc[[3, 40, 90], 'start.yardsToEndzone'] = 104
    chk('yard line outside 0..100 -> yardline_valid False', run1(d).checks['yardline_valid'] is False)
    # missing quarter: drop Q4 (the PBP score stops below the final: truncation, not contradiction)
    d = g[g.period < 4]
    r = run1(d)
    chk('missing Q4 -> quarters_present False', r.checks['quarters_present'] is False, r.checks)
    chk('missing Q4 -> FINAL_PARTIAL_DATA (not DATA_ERROR)', r.status == 'FINAL_PARTIAL_DATA', (r.status, r.issues))
    # score mismatch on a complete PBP
    r = run1(g, hp=45)
    chk('complete PBP contradicting the final by 24 -> DATA_ERROR', r.status == 'DATA_ERROR' and not r.score_reconciles,
        (r.status, r.issues))
    r = run1(g, hp=24)
    chk('small reconciliation miss (3) -> FINAL_PARTIAL_DATA', r.status == 'FINAL_PARTIAL_DATA' and r.score_gap == 3,
        (r.status, r.issues))
    d = g.copy()
    d.loc[d.index[-1], ['homeScore', 'awayScore']] = [0, 0]
    r = run1(d)
    chk('stale last row: the maximum running score reconciles', r.score_reconciles and r.score_method == 'max_running',
        (r.score_method, r.issues))
    # team ids
    d = g.copy()
    d.loc[[5, 6], 'pos_team_id'] = 99
    r = run1(d)
    chk('team id outside the scheduled pair -> DATA_ERROR', r.checks['team_ids'] is False and r.status == 'DATA_ERROR',
        (r.status, r.issues))
    d = g.copy()
    d['homeTeamId'], d['awayTeamId'] = AWAY, HOME
    d['homeScore'], d['awayScore'] = g.awayScore, g.homeScore
    r = run1(d)
    chk('swapped PBP home/away: scores re-oriented, reconciles, orientation flagged',
        r.score_reconciles and r.checks['home_away_orientation'] is False and r.status == 'FINAL_VALIDATED',
        (r.status, r.issues))
    # ordering: a first-quarter play appended after the fourth quarter, twice
    d = g.copy()
    d.loc[[2, 3], 'game_play_number'] = [500, 501]
    r = run1(d)
    chk('plays out of period order -> play_order False -> FINAL_PARTIAL_DATA',
        r.checks['play_order'] is False and r.status == 'FINAL_PARTIAL_DATA', (r.status, r.issues))
    d = g.copy()
    d = d[~d.game_play_number.isin(range(30, 40))]
    r = run1(d)
    chk('a run of 10 missing play numbers -> play_order False', r.checks['play_order'] is False, r.issues)
    d = g.copy()
    d['sequenceNumber'] = d.sequenceNumber.values[::-1]
    chk('sequenceNumber backwards but play ids in order -> order corroborated', run1(d).checks['play_order'])
    d['id'] = d['id'].values[::-1]
    chk('both provider sequence keys backwards -> play_order False', run1(d).checks['play_order'] is False)
    # drive contiguity: five drive ids re-appear later
    d = g.copy()
    for k, j in enumerate((0, 2, 4, 6, 8)):
        d.loc[d.index[100 + 8 * k + 3], 'drive.id'] = '1%02d' % j
    r = run1(d)
    chk('drive ids re-appearing -> drive_contiguity False', r.checks['drive_contiguity'] is False, r.issues)
    # possession changes inside one drive
    d = g.copy()
    for j in (3, 9, 15):
        d.loc[j * 8 + 3, ['pos_team_id', 'def_pos_team_id']] = [HOME if d.loc[j * 8 + 3, 'pos_team_id'] == AWAY else AWAY,
                                                                 d.loc[j * 8 + 3, 'pos_team_id']]
    r = run1(d)
    chk('possession changes inside drives -> possession_transitions False',
        r.checks['possession_transitions'] is False, r.issues)
    # few plays
    g2 = synth_game(plays_per_drive=5)
    r = run1(g2)
    chk('play count 62% of the median -> play_count False -> FINAL_PARTIAL_DATA',
        r.checks['play_count'] is False and r.status == 'FINAL_PARTIAL_DATA', (r.play_ratio, r.status))
    # corrupted: most rows without a period
    d = g.copy()
    d.loc[d.index[:60], 'period'] = np.nan
    chk('rows without period beyond 20% -> DATA_ERROR', run1(d).status == 'DATA_ERROR')


def test_completeness_monotone():
    g = synth_game()
    prev, seq = None, []
    for frac in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1):
        d = g.iloc[:max(1, int(len(g) * frac))]
        seq.append(float(run1(d).pbp_completeness_score))
    mono = all(seq[i] >= seq[i + 1] - 1e-12 for i in range(len(seq) - 1))
    chk('completeness is non-increasing as the PBP is truncated', mono, seq)
    chk('completeness falls well below 1 when most plays are missing', seq[0] == 1.0 and seq[-1] < 0.5, seq)
    d = pd.concat([g, g.iloc[[10]].assign(text_dupe=True)], ignore_index=True)
    chk('a failed check lowers completeness', run1(d).pbp_completeness_score < 1.0)
    s = sum(VAL.COMPLETENESS_WEIGHTS.values())
    chk('completeness weights sum to 1', abs(s - 1.0) < 1e-12, s)


def test_gamestate_synthetic():
    rows = [
        # period, secs, diff, rush, pass, kneel, expected
        (1, 1500, 0, True, False, False, 'COMPETITIVE'),
        (1, 1500, 35, True, False, False, 'LOW_LEVERAGE'),       # no Q1 garbage in V2
        (2, 600, 20, False, True, False, 'LOW_LEVERAGE'),
        (2, 600, 39, False, True, False, 'GARBAGE'),
        (3, 1200, 29, True, False, False, 'GARBAGE'),
        (4, 800, 23, True, False, False, 'GARBAGE'),
        (4, 800, 22, True, False, False, 'LOW_LEVERAGE'),        # 22 is not > 22
        (4, 200, 7, True, False, False, 'CLOCK_KILL'),
        (4, 200, 7, False, True, False, 'COMPETITIVE'),          # a pass is not a clock play
        (4, 90, -3, False, True, False, 'DESPERATION'),
        (4, 280, -10, True, False, False, 'DESPERATION'),
        (4, 280, -3, False, True, False, 'COMPETITIVE'),
        (2, 20, 3, True, False, True, 'CLOCK_KILL'),             # end-of-half kneel
        (4, 30, 30, True, False, True, 'GARBAGE'),               # garbage has precedence
        (5, 0, -7, False, True, False, 'COMPETITIVE'),           # overtime
    ]
    df = pd.DataFrame(rows, columns=['period', 'start.TimeSecsRem', 'start.pos_score_diff', 'rush', 'pass',
                                     'kneel_down', 'exp'])
    df['pos_team_id'] = 1
    got = GS.classify(df)
    bad = [(i, g, e) for i, (g, e) in enumerate(zip(got, df.exp)) if g != e]
    chk('gamestate classes on synthetic situations', not bad, bad)
    chk('gamestate rule version', GS.RULE_VERSION == 'cfb_gamestate_v1')
    w = GS.production_weight(got)
    chk('production weight: garbage 0, everything else 1',
        (w[got == 'GARBAGE'] == 0).all() and (w[got != 'GARBAGE'] == 1).all())
    df2 = df.copy()
    df2.loc[0, 'period'] = np.nan
    df2.loc[1, 'start.pos_score_diff'] = np.nan
    g2 = GS.classify(df2)
    ref = common.garbage_mask(df2.period.fillna(1).astype(int).values, df2['start.pos_score_diff'].fillna(0).values)
    chk('GARBAGE uses V2 fill conventions (period NaN->1, diff NaN->0)', ((g2 == 'GARBAGE').values == ref).all())


def test_turnover_sign():
    K = {'fumble_lost_share': 0.5, 'int_rate_per_dropback': 0.025, 'int_shrinkage_k': 1000.0,
         'points_per_turnover': 4.0}
    base = dict(dropbacks=300.0, opp_dropbacks=300.0, ints_thrown=7.5, ints_made=7.5, fumbles=10.0,
                fumbles_lost=5.0, opp_fumbles=10.0, opp_fumbles_recovered=5.0)
    H = pd.DataFrame([base,
                      dict(base, opp_fumbles_recovered=9.0),       # recovered more opponent fumbles
                      dict(base, fumbles_lost=1.0),                # kept more of its own fumbles
                      dict(base, fumbles_lost=9.0),                # lost more than expected
                      dict(base, ints_made=15.0)])                 # many interceptions
    L = PF._turnover_luck(H, K)
    chk('exactly expected turnovers -> zero luck', abs(L.turnover_luck_index.iloc[0]) < 1e-9, L.iloc[0].to_dict())
    chk('recovering more opponent fumbles than expected -> positive luck',
        L.turnover_luck_index.iloc[1] > 0 and L.fumble_luck.iloc[1] > 0, L.iloc[1].to_dict())
    chk('recovering more own fumbles than expected -> positive luck', L.turnover_luck_index.iloc[2] > 0)
    chk('losing more fumbles than expected -> negative luck', L.turnover_luck_index.iloc[3] < 0)
    chk('fumble luck = (extra recoveries) x points per turnover', abs(L.fumble_luck.iloc[1] - 16.0) < 1e-9,
        L.fumble_luck.iloc[1])
    # INT expectation is shrunk: 15 INTs made on 300 dropbacks, k=1000 ->
    # E = 300 * (15 + 25) / 1300 = 9.23; luck = (15 - 9.23) * 4
    e = 300 * (15 + 1000 * 0.025) / 1300.0
    chk('INT expectation is the shrunk rate', abs(L.exp_ints_made.iloc[4] - e) < 1e-9, L.exp_ints_made.iloc[4])
    chk('INT luck sign and size', abs(L.int_luck.iloc[4] - (15 - e) * 4) < 1e-9, L.int_luck.iloc[4])


def test_explosive_shrink():
    K = {'explosive_dep_k': 600.0, 'explosive_dep_league': 0.45}
    v = PF._shrink_dep([0.0], [0.0], [0.0], K)[0]
    chk('no plays -> league mean', abs(v - 0.45) < 1e-12, v)
    v = PF._shrink_dep([10.0], [10.0], [5.0], K)[0]           # raw 1.0 on 5 plays
    chk('tiny sample stays near the league mean', abs(v - 0.45) < 0.01, v)
    v = PF._shrink_dep([0.0], [10.0], [5.0], K)[0]            # raw 0.0 on 5 plays
    chk('tiny sample stays near the league mean (low side)', abs(v - 0.45) < 0.01, v)
    v = PF._shrink_dep([90.0], [100.0], [60000.0], K)[0]      # raw 0.9 on a huge sample
    chk('a huge sample approaches its raw share', abs(v - 0.9) < 0.01, v)
    a = PF._shrink_dep([6.0, 6.0, 6.0], [10.0, 10.0, 10.0], [50.0, 300.0, 3000.0], K)
    chk('shrinkage weakens monotonically with plays', a[0] < a[1] < a[2] < 0.6, list(a))


def test_synthetic_determinism():
    s = pd.DataFrame([sched_row(1), sched_row(2), sched_row(3, status='STATUS_POSTPONED', completed=False, hp=0, ap=0)])
    p = pd.concat([synth_game(1), synth_game(2)], ignore_index=True)
    a = VAL.validate_games(2025, NOW, pbp=p, sched=s, ref_plays=160.0)
    b = VAL.validate_games(2025, NOW, pbp=p.sample(frac=1.0, random_state=0), sched=s.iloc[::-1], ref_plays=160.0)
    chk('validation is deterministic and independent of input row order',
        ids.content_hash(a.to_dict('records')) == ids.content_hash(b.to_dict('records')))
    chk('row_hash excludes validated_at',
        a.row_hash.tolist() == VAL.validate_games(2025, NOW + pd.Timedelta(hours=1), pbp=p, sched=s,
                                                  ref_plays=160.0).row_hash.tolist())


def test_no_market_columns():
    for name, cols in (('validate', VAL.PBP_VALIDATION_COLS), ('perf', V2P.PBP_COLS + PF.EXTRA_PBP_COLS),
                       ('gamestate', list(GS.INPUT_COLUMNS))):
        bad = set(cols) & set(V2P.FORBIDDEN_PBP_COLUMNS)
        chk('%s reads no market / win-probability column' % name, not bad, sorted(bad))


# ------------------------------------------------------------ real-data tests
def test_data_validation():
    v = VAL.validate_games(2025, pd.Timestamp('2026-03-01', tz='UTC'))
    sc = v[v.in_scope]
    cnt = VAL.status_counts(v)
    fin = sum(cnt[k] for k in ('FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'))
    chk('[data] 2025: every in-scope game is final or canceled', fin + cnt['CANCELED'] == len(sc), cnt)
    chk('[data] 2025: >= 90% of final in-scope games validate', cnt['FINAL_VALIDATED'] >= 0.9 * fin, cnt)
    chk('[data] 2025: DATA_ERROR share < 1%', cnt['DATA_ERROR'] < 0.01 * fin, cnt)
    chk('[data] 2025: overtime games found', int(sc.overtime.fillna(False).astype(bool).sum()) > 20)
    v2 = VAL.validate_games(2025, pd.Timestamp('2026-03-01', tz='UTC'))
    chk('[data] validation twice -> identical rows', ids.content_hash(v.to_dict('records')) ==
        ids.content_hash(v2.to_dict('records')))
    comp = v.pbp_completeness_score.dropna()
    chk('[data] completeness within [0, 1]', ((comp >= 0) & (comp <= 1)).all())
    wk = VAL.validate_games(2025, pd.Timestamp('2025-10-07T12:00Z'), source_week=6)
    chk('[data] source week 6 rows are week 6', len(wk) > 0 and wk.week.eq(6).all() and
        set(wk.game_id) <= set(v.game_id))


def test_data_garbage_equals_v2():
    d = V2P.load_pbp(2025)
    extra = pd.read_parquet(common.data_path('pbp', 'play_by_play_2025.parquet'),
                            columns=['start.TimeSecsRem', 'kneel_down'])
    d = pd.concat([d.reset_index(drop=True), extra.reset_index(drop=True)], axis=1)
    cls = GS.classify(d)
    ref = common.garbage_mask(d.period.fillna(1).astype(int).values, d['start.pos_score_diff'].fillna(0).values)
    chk('[data] GARBAGE class == common.garbage_mask on every 2025 play',
        ((cls == 'GARBAGE').values == ref).all(), int(((cls == 'GARBAGE').values != ref).sum()))
    # and the same count V2's stage1 recorded, per team-game
    x = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()]
    x = x[~x.text_dupe.fillna(False).astype(bool)]
    sc = (x.rush.fillna(False).astype(bool) | x['pass'].fillna(False).astype(bool)) & \
        ~x.penalty_no_play.fillna(False).astype(bool) & x.EPA.notna()
    x = x[sc]
    got = (GS.classify(x) == 'GARBAGE').groupby([x.game_id, x.pos_team_id.astype('int64')]).sum()
    st1 = common.out_path('stage1', 'team_game_2025.parquet')
    if os.path.exists(st1):
        tg = pd.read_parquet(st1, columns=['game_id', 'team_id', 'garbage_plays']).set_index(['game_id', 'team_id'])
        got.index = got.index.set_names(['game_id', 'team_id'])
        j = tg.join(got.rename('g'), how='left').fillna(0)
        chk('[data] GARBAGE counts == stage1 garbage_plays per team-game', (j.garbage_plays == j.g).all())
    cs = set(cls.unique())
    chk('[data] every class is one of the five', cs <= set(GS.CLASSES), sorted(cs))


def test_data_stage1_reuse():
    TG = PF._core(2024)
    st1 = common.out_path('stage1', 'team_game_2024.parquet')
    if not os.path.exists(st1):
        chk('[data] stage1 file present for the reuse check', False, st1)
        return
    st = pd.read_parquet(st1)
    m = TG.merge(st, on=['game_id', 'team_id'], how='inner')
    bad = []
    for c in ('n_plays', 'epa_sum', 'succ', 'n_db', 'havoc', 'line_yds', 'n_drives', 'drive_pts',
              'scoring_opps', 'start_ytg_sum', 'drive_epa_sum'):
        dd = float(np.nanmax(np.abs(m['off_' + c].astype(float) - m[c].astype(float))))
        if not dd <= 1e-9:
            bad.append((c, dd))
    chk('[data] filtered sums == stage1 team_game (V2 definitions reused)', not bad and len(m) > 1500, bad)
    chk('[data] raw play count == stage1 n_plays_all', float(np.nanmax(np.abs(m.off_n_plays_raw - m.n_plays_all))) == 0)


def test_data_perf_T_and_determinism():
    G = PF.game_performance(2025)
    ks = sorted(G.kickoff_ts.unique())
    T = pd.Timestamp(ks[len(ks) // 2])                      # a real kickoff instant
    GT = PF.game_performance(2025, T)
    chk('[data] game_performance(T): no game kicked off at or after T', (GT.kickoff_ts < T).all() and len(GT) > 0,
        str(GT.kickoff_ts.max()))
    want = set(G.game_id[G.kickoff_ts < T])
    chk('[data] game_performance(T): every final game before T is present', set(GT.game_id) == want)
    chk('[data] two rows per game', (GT.groupby('game_id').size() == 2).all())
    chk('[data] expected margin is antisymmetric within a game',
        float(GT.groupby('game_id').expected_performance_margin.sum().abs().max()) < 1e-9)
    chk('[data] overperformance = margin - expected',
        float((GT.scoreboard_overperformance - (GT.margin - GT.expected_performance_margin)).abs().max()) < 1e-9)
    chk('[data] league takeaways == giveaways', float(G.takeaways.sum()) == float(G.giveaways.sum()))
    PF._CORE_CACHE.clear()
    G2 = PF.game_performance(2025)
    chk('[data] game_performance twice (cache cleared) -> identical frames',
        G.drop(columns=['kickoff_ts']).equals(G2.drop(columns=['kickoff_ts'])) and G.kickoff_ts.equals(G2.kickoff_ts))
    S1 = PF.team_summary(2025, T)
    S2 = PF.team_summary(2025, T)
    chk('[data] team_summary deterministic', S1.equals(S2))
    chk('[data] team_summary games == team-games before T', int(S1.games.sum()) == len(GT))
    num = S1.select_dtypes('number')
    fbs = S1.fbs
    bad = [c for c in num.columns if not np.isfinite(num[fbs][c].astype(float)).all()]
    chk('[data] team_summary numeric fields finite for FBS teams', not bad, bad)


def test_data_artifact():
    a = PF.load_expected_margin()
    chk('[data] artifact training seasons are dev seasons only',
        set(a['training_seasons']) <= set(C.DEV_SEASONS) and not (set(a['training_seasons']) & {2024, 2025, 2026}))
    chk('[data] artifact records n, R2, residual SD, features',
        a['model']['n'] > 5000 and 0 < a['model']['r2'] < 1 and a['model']['residual_sd'] > 0 and
        a['model']['features'] == [f for f, _ in PF.EM_FEATURES])
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, 'em.json')
        b = dict(a)
        b['model'] = dict(a['model'], intercept=a['model']['intercept'] + 1.0)
        with open(p, 'w') as f:
            json.dump(b, f)
        chk('[data] a tampered artifact fails its hash', throws(lambda: PF.load_expected_margin(p)))
    chk('[data] fitting on a holdout season is refused', throws(lambda: PF.fit_expected_margin(write=False,
                                                                                              seasons=(2023, 2024))))
    r = PF.fit_expected_margin(write=False)
    chk('[data] refitting the expected margin reproduces the artifact hash', r['sha256'] == a['sha256'],
        (r['sha256'], a['sha256']))


def main():
    fast = '--fast' in sys.argv
    for t in (test_finality, test_overtime, test_pbp_checks, test_completeness_monotone,
              test_gamestate_synthetic, test_turnover_sign, test_explosive_shrink,
              test_synthetic_determinism, test_no_market_columns):
        try:
            t()
        except Exception as e:                          # noqa: BLE001
            import traceback
            chk(t.__name__ + ' raised', False, traceback.format_exc()[-600:])
    if not fast:
        for t in (test_data_validation, test_data_garbage_equals_v2, test_data_stage1_reuse,
                  test_data_perf_T_and_determinism, test_data_artifact):
            try:
                t()
            except Exception:                           # noqa: BLE001
                import traceback
                chk(t.__name__ + ' raised', False, traceback.format_exc()[-600:])
    done()


if __name__ == '__main__':
    main()
