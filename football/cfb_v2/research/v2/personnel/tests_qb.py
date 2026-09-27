"""Tests for the QB personnel layer (personnel/qb.py, lineup.py, backtest_qb.py).

    python3 -m v2.personnel.tests_qb [--fast]

--fast runs the synthetic checks only (no data directories needed): the scenario mixture maths,
the starter-distribution rules (no report / OUT / questionable / probable / chains), the V2 QB
columns for an arbitrary starter, the transfer translation formula, and point in time (a report
published after `now` is ignored; a game after T never enters a rating). Without --fast the
real-data checks run too: the exact reproduction of the V2.1 stage-7 walk-forward, the exact
reproduction of V2's stage-4 QB features by the context rebuild, the artifact's QB inputs, the
no-report identity through the frozen artifact, the 2026 run, and the estimated constants.
Prints 'ALL GREEN n passed, 0 failed' and exits non-zero on any failure.
"""
import sys
import traceback

import numpy as np
import pandas as pd

from .. import config as C

PASS, FAIL = [0], []


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL.append((name, detail))
        print('FAIL', name, detail if detail is not None else '')


def close(a, b, tol=1e-12):
    return abs(float(a) - float(b)) <= tol


# ================================================================= synthetic
def t_mixture():
    from . import lineup as LU
    from .. import walkforward as WF
    from scipy import stats
    df = 50
    p, mu, sd, pw = [0.3, 0.7], [3.0, -1.0], [15.0, 16.0], [0.55, 0.47]
    m = LU.mixture(p, mu, sd, pw, df)
    mean = 0.3 * 3 + 0.7 * -1
    var = 0.3 * (15 ** 2 + 9) + 0.7 * (16 ** 2 + 1) - mean ** 2
    chk('mixture_mean', close(m['margin'], mean), m)
    chk('mixture_var', close(m['sd'] ** 2, var, 1e-9), (m['sd'] ** 2, var))
    chk('mixture_p_home', close(m['p_home'], 0.3 * 0.55 + 0.7 * 0.47), m)
    lo, hi = m['int80']
    F = lambda x: 0.3 * WF.t_cdf((x - 3) / 15, df) + 0.7 * WF.t_cdf((x + 1) / 16, df)
    chk('mixture_int80_cdf', abs(F(lo) - 0.1) < 1e-9 and abs(F(hi) - 0.9) < 1e-9, (F(lo), F(hi)))
    one = LU.mixture([1.0], [2.5], [14.0], [0.6], df)
    chk('mixture_single_exact', one['margin'] == 2.5 and one['sd'] == 14.0 and one['p_home'] == 0.6, one)
    s = np.sqrt((df - 2) / df)
    q = 14.0 * s * stats.t.ppf(0.975, df)
    chk('mixture_single_int95', abs(one['int95'][1] - (2.5 + q)) < 1e-7, (one['int95'], 2.5 + q))
    # mixture of identical scenarios == the scenario
    two = LU.mixture([0.4, 0.6], [2.5, 2.5], [14.0, 14.0], [0.6, 0.6], df)
    chk('mixture_identical_components', close(two['margin'], 2.5, 1e-12) and close(two['sd'], 14.0, 1e-9), two)


# realistic ESPN-sized athlete ids (ids <= qb.MIN_VALID_ID are provider placeholders, never candidates)
Q11, Q22, Q33, Q44, Q55 = 4000011, 4000022, 4000033, 4000044, 4000055


def _ctx(season_db=(300.0, 120.0, 5.0), ids_=(Q11, Q22, Q33), v2=Q11, starters3=1, missing=False):
    sdb = pd.Series(list(season_db), index=list(ids_), dtype=float).sort_values(ascending=False)
    return {'season': 2030, 'prediction_ts': pd.Timestamp('2030-10-01T12:00Z'), 'team_id': 7, 'repl': -0.05,
            'missing': missing, 'v2_starter': v2, 'season_db': sdb, 'team_rating': 0.08, 'starters3': starters3,
            'games': 5}


def _ratings():
    return pd.DataFrame({'rating': [0.12, -0.02, 0.01, 0.20], 'den': [400.0, 90.0, 5.0, 300.0],
                         'career_db': [900.0, 150.0, 6.0, 500.0], 'starts': [20.0, 2.0, 0.0, 14.0]},
                        index=pd.Index([Q11, Q22, Q33, Q44], name='qb_id'))


def t_starter_distribution():
    from . import qb as PQ
    ctx = _ctx()
    d = PQ.starter_distribution(ctx, {}, 'UNKNOWN')
    chk('no_report_is_v2_rule', len(d) == 1 and d[0]['qb_id'] == Q11 and d[0]['p'] == 1.0 and d[0]['status'] == 'UNKNOWN', d)
    d = PQ.starter_distribution(ctx, {}, 'KNOWN')
    chk('not_listed_keeps_starter', len(d) == 1 and d[0]['qb_id'] == Q11 and d[0]['status'] == 'NOT LISTED', d)
    for st in ('OUT', 'SUSPENDED', 'OUT FOR SEASON', 'TRANSFERRED', 'out_for_season'):
        d = PQ.starter_distribution(ctx, {Q11: PQ.normalize_status(st)}, 'KNOWN')
        chk('out_to_backup_' + st, len(d) == 1 and d[0]['qb_id'] == Q22 and close(d[0]['p'], 1.0), d)
    d = PQ.starter_distribution(ctx, {Q11: 'OUT', Q22: 'OUT'}, 'KNOWN')
    chk('out_out_to_third', d[0]['qb_id'] == Q33 and close(d[0]['p'], 1.0), d)
    d = PQ.starter_distribution(ctx, {Q11: 'OUT', Q22: 'OUT', Q33: 'OUT'}, 'KNOWN', fallback=[Q55])
    chk('fallback_last_season_qb', d[0]['qb_id'] == Q55 and close(d[0]['p'], 1.0), d)
    d = PQ.starter_distribution(ctx, {Q11: 'OUT', Q22: 'OUT', Q33: 'OUT'}, 'KNOWN')
    chk('all_out_to_replacement', d[0]['qb_id'] is None and d[0]['role'] == 'REPLACEMENT' and close(d[0]['p'], 1.0), d)
    for st, p in (('QUESTIONABLE', 0.5), ('GAME_TIME_DECISION', 0.5), ('GTD', 0.5), ('DOUBTFUL', 0.2),
                  ('PROBABLE', 0.85), ('OUT_FIRST_HALF', 0.5)):
        d = PQ.starter_distribution(ctx, {Q11: PQ.normalize_status(st)}, 'KNOWN')
        chk('two_scenarios_' + st, len(d) == 2 and d[0]['qb_id'] == Q11 and close(d[0]['p'], p)
            and d[1]['qb_id'] == Q22 and close(d[1]['p'], 1 - p), d)
    d = PQ.starter_distribution(ctx, {Q11: 'QUESTIONABLE', Q22: 'QUESTIONABLE'}, 'KNOWN')
    chk('chain_q_q', [x['qb_id'] for x in d] == [Q11, Q22, Q33] and np.allclose([x['p'] for x in d], [0.5, 0.25, 0.25]), d)
    d = PQ.starter_distribution(ctx, {Q22: 'OUT'}, 'KNOWN')
    chk('backup_out_starter_unchanged', len(d) == 1 and d[0]['qb_id'] == Q11 and close(d[0]['p'], 1.0), d)
    d = PQ.starter_distribution(ctx, {Q11: 'SOMETHING ODD'}, 'KNOWN')
    chk('unrecognised_status_no_guess', d[0]['qb_id'] == Q11 and close(d[0]['p'], 1.0)
        and 'UNRECOGNISED' in d[0]['status'], d)
    d = PQ.starter_distribution(_ctx(missing=True), {Q11: 'OUT'}, 'KNOWN')
    chk('v2_missing_stays_missing', d[0]['role'] == 'V2_MISSING', d)
    for sts in ({}, {Q11: 'QUESTIONABLE', Q22: 'DOUBTFUL'}, {Q11: 'OUT', Q22: 'PROBABLE'}):
        d = PQ.starter_distribution(ctx, sts, 'KNOWN')
        chk('p_sums_to_one_%s' % sorted(sts.items()), close(sum(x['p'] for x in d), 1.0, 1e-12), d)
    chk('play_probability_unknown_is_none', PQ.play_probability('UNKNOWN') is None)
    d = PQ.starter_distribution(_ctx(ids_=(Q11, -5151, Q33)), {Q11: 'OUT'}, 'KNOWN', fallback=[3])
    chk('placeholder_ids_never_candidates', d[0]['qb_id'] == Q33 and close(d[0]['p'], 1.0), d)


def t_side_features():
    from . import qb as PQ
    ctx, rat = _ctx(), _ratings()
    f = PQ.side_features(ctx, Q11, rat)
    chk('side_v2_starter', close(f['qb_exp_rating'], 0.12) and close(f['qb_delta'], 0.12 - 0.08)
        and close(f['qb_backup_rating'], -0.02) and f['qb_changed'] == 0.0 and close(f['qb_exp_db_log'], np.log1p(900))
        and f['qb_exp_starts'] == 20.0 and f['qb_unsettled'] == 0.0 and f['qb_missing'] == 0.0, f)
    f = PQ.side_features(ctx, Q22, rat)
    chk('side_backup', close(f['qb_exp_rating'], -0.02) and close(f['qb_delta'], -0.10)
        and close(f['qb_backup_rating'], 0.12) and f['qb_changed'] == 1.0 and close(f['qb_drop'], -0.14)
        and f['qb_team_rating'] == 0.08, f)
    f = PQ.side_features(ctx, Q44, rat)      # a QB who has not thrown for this team this season
    chk('side_other_qb', close(f['qb_exp_rating'], 0.20) and close(f['qb_backup_rating'], 0.12)
        and f['qb_changed'] == 1.0 and f['qb_exp_starts'] == 14.0, f)
    f = PQ.side_features(ctx, None, rat)
    chk('side_replacement', close(f['qb_exp_rating'], -0.05) and f['qb_exp_db_log'] == 0.0
        and f['qb_exp_starts'] == 0.0 and np.isnan(f['qb_id']) and f['qb_changed'] == 1.0, f)
    f = PQ.side_features(_ctx(missing=True), Q11, rat)
    chk('side_missing', f == {'qb_missing': 1.0}, f)
    f = PQ.side_features(_ctx(starters3=2), Q11, rat)
    chk('side_unsettled_is_history', f['qb_unsettled'] == 1.0, f)


def t_lineup_columns():
    from . import lineup as LU
    X = pd.DataFrame({'h_qb_missing': [0.0, 1.0, 0.0], 'a_qb_missing': [0.0, 0.0, np.nan],
                      'h_qb_unsettled': [1.0, np.nan, 0.0], 'a_qb_unsettled': [0.0, 0.0, np.nan],
                      'h_qb_delta': [0.1, np.nan, -0.02], 'a_qb_delta': [-0.05, 0.03, np.nan],
                      'h_qb_exp_rating': [0.2, np.nan, 0.1], 'a_qb_exp_rating': [0.1, 0.0, np.nan]})
    Y = LU.game_qb_columns(X.copy())
    # snapshots.build_season's four lines, written out
    chk('game_cols_missing_any', list(Y.qb_missing_any) == [0.0, 1.0, 1.0], list(Y.qb_missing_any))
    chk('game_cols_unsettled_any', list(Y.qb_unsettled_any) == [1.0, 0.0, 0.0], list(Y.qb_unsettled_any))
    chk('game_cols_delta_edge', np.allclose(Y.qb_delta_edge, [0.15, -0.03, -0.02]), list(Y.qb_delta_edge))
    chk('game_cols_exp_edge', close(Y.qb_exp_edge.iloc[0], 0.1) and Y.qb_exp_edge.iloc[1:].isna().all(), list(Y.qb_exp_edge))
    Z = X.copy()
    for c in LU.SIDE_COLS:
        Z['h_' + c] = 9.0
    LU.set_side(Z, Z.index[:1], 'home', {'qb_missing': 1.0})
    chk('set_side_missing_nans', Z.loc[0, 'h_qb_missing'] == 1.0 and np.isnan(Z.loc[0, 'h_qb_exp_rating'])
        and Z.loc[1, 'h_qb_exp_rating'] == 9.0)


def t_translation():
    from . import qb as PQ
    per = {'alpha': 0.1, 'rho': 0.5, 'resid_sd': 0.1, 'param_cov': [[0.0, 0.0], [0.0, 0.0]]}
    m, v = PQ.translate(0.2, persistence=per, repl=-0.05)
    chk('translate_mean', close(m, -0.05 + 0.1 + 0.5 * 0.25), m)
    chk('translate_var_residual', close(v, 0.01), v)
    per2 = dict(per, param_cov=[[0.001, -0.002], [-0.002, 0.04]])
    m2, v2 = PQ.translate(0.2, persistence=per2, repl=-0.05)
    chk('translate_var_widened', close(v2, 0.01 + 0.001 + 2 * -0.002 * 0.25 + 0.04 * 0.0625) and v2 > v, v2)
    m3, _ = PQ.translate(-0.05, persistence=per, repl=-0.05)
    chk('translate_replacement_fixed_point_plus_alpha', close(m3, -0.05 + 0.1), m3)
    sh = {'k_dropbacks': 150.0, 'replacement_mean': -0.05, 'noise_per_game_db': 2.7}
    perv = {'rho_transfer_shift': -0.3, 'alpha_transfer_shift': -0.02, 'resid_sd': 0.14, 'resid_sd_stay': 0.11,
            'shift_param_cov': [[0.0, 0.0], [0.0, 0.0]]}
    m, v = PQ.translated(0.0, 0.0, 200.0, 30.0, sh, perv)
    chk('translated_no_other_team_is_v2', close(m, (30.0 + 150 * -0.05) / 350.0) and close(v, 2.7 / 350.0), (m, v))
    m, v = PQ.translated(300.0, 60.0, 100.0, 5.0, sh, perv)
    m_o = (60.0 + 150 * -0.05) / 450.0
    m_o2 = m_o - 0.02 - 0.3 * (m_o + 0.05)
    exp_m = (m_o2 * 450.0 + 5.0) / 550.0
    exp_v = 2.7 / 550.0 + (450.0 / 550.0) ** 2 * (0.14 ** 2 - 0.11 ** 2)
    chk('translated_formula', close(m, exp_m) and close(v, exp_v), (m, exp_m, v, exp_v))


def t_point_in_time_reports():
    from . import qb as PQ
    now = pd.Timestamp('2030-10-03T18:00Z')
    base = {'game_id': '9', 'team': 'Test U', 'ok': True, 'rows': [{'player_id': '11', 'position': 'QB', 'status': 'OUT'}]}
    reps = [dict(base, published_at='2030-10-03T17:00:00Z', _file='a'),
            dict(base, published_at='2030-10-03T19:00:00Z', _file='late',
                 rows=[{'player_id': '11', 'position': 'QB', 'status': 'AVAILABLE'}])]
    r = PQ.team_report(reps, 9, 7, 'Test U', now)
    chk('report_after_now_ignored', r is not None and r['_file'] == 'a', r and r['_file'])
    r = PQ.team_report(reps, 9, 7, 'Test U', pd.Timestamp('2030-10-03T16:00Z'))
    chk('no_report_before_publication', r is None)
    r = PQ.team_report(reps, 9, 7, 'Test U', pd.Timestamp('2030-10-04T00:00Z'), kickoff=pd.Timestamp('2030-10-03T18:30Z'))
    chk('report_after_kickoff_ignored', r is not None and r['_file'] == 'a', r and r['_file'])
    r = PQ.team_report([dict(base, published_at='Sat, 03 Oct 2030 17:30:00 GMT', _file='rfc')], 9, 7, 'Test U', now)
    chk('rfc2822_published_at', r is not None and r['_file'] == 'rfc')
    r = PQ.team_report([dict(base, published_at='2030-10-03T17:00:00Z', ok=False, _file='bad')], 9, 7, 'Test U', now)
    chk('failed_read_is_not_a_report', r is None)
    r = PQ.team_report([dict(base, published_at='2030-10-03T17:00:00Z', rows=[], _file='empty')], 9, 7, 'Test U', now)
    chk('empty_report_without_silence_rule_ignored', r is None)
    r = PQ.team_report([dict(base, published_at='2030-10-03T17:00:00Z', rows=[], silence_means_available=True,
                             _file='silent')], 9, 7, 'Test U', now)
    chk('silence_means_available_report_used', r is not None and PQ.qb_statuses(r) == {})
    r = PQ.team_report([dict(base, published_at=None, retrieved_at='2030-10-03T17:00:00Z', _file='ret')], 9, 7, 'Test U', now)
    chk('retrieved_at_fallback', r is not None)
    r = PQ.team_report(reps, 9, 8, 'Other U', now)
    chk('report_other_team_ignored', r is None)
    st = PQ.qb_statuses(dict(base, rows=[{'player_id': '11', 'position': 'QB', 'status': 'GAME_TIME_DECISION'},
                                         {'player_id': '12', 'position': 'WR', 'status': 'OUT'}]))
    chk('qb_statuses_qb_only_normalized', st == {11: 'GAME-TIME DECISION'}, st)


def t_point_in_time_rating():
    """A game that kicks off after T never enters a rating or the expected starter (synthetic data
    through V2's own qb.team_features and the personnel context)."""
    from .. import qb as QB
    from . import qb as PQ
    S = 2030
    T = pd.Timestamp('2030-09-22T12:00Z')
    k = [pd.Timestamp('2030-09-06T16:00Z'), pd.Timestamp('2030-09-13T16:00Z'), pd.Timestamp('2030-09-26T16:00Z')]

    def mk(epa_after):
        rows = []
        for gi, (ko, qb, epa) in enumerate(zip(k, (11, 11, 22), (5.0, 3.0, epa_after))):
            rows.append({'game_id': 100 + gi, 'team_id': 7, 'qb_id': qb, 'db': 30, 'db_ng': 30.0, 'epa_db_sum': epa,
                         'succ_db': 10.0, 'sacks': 1.0, 'first_play': 1.0, 'starter': True, 'season': S, 'g_season': S,
                         'kickoff_ts': ko, 'prediction_ts': ko.normalize() - pd.Timedelta(days=3) + pd.Timedelta(hours=12),
                         'home_id': 7, 'away_id': 8, 'neutral_site': False, 'status': 'FINAL', 'opp_id': 8, 'H': 1})
        return pd.DataFrame(rows)
    G = pd.DataFrame({'game_id': [100, 101, 102], 'season': S, 'home_id': 7, 'away_id': 8,
                      'prediction_ts': [T - pd.Timedelta(days=14), T - pd.Timedelta(days=7), T], 'kickoff_ts': k})
    Ap = pd.DataFrame({'g_season': pd.Series([], dtype='int64'), 'qb_id': pd.Series([], dtype='int64'),
                       'db_ng': pd.Series([], dtype=float), 'adj': pd.Series([], dtype=float),
                       'db': pd.Series([], dtype='int64'), 'starter': pd.Series([], dtype=bool),
                       'team_id': pd.Series([], dtype='int64')})
    sh = {'k_dropbacks': 150.0, 'replacement_mean': -0.05, 'noise_per_game_db': 2.7}
    R = pd.DataFrame({'prediction_ts': [T, T], 'team_id': [7, 8], 'metric': 'epa_pass', 'def': [0.0, 0.01]})
    L = pd.DataFrame({'prediction_ts': [T], 'metric': 'epa_pass', 'h': [0.02]})
    outs = []
    for epa_after in (-40.0, 40.0):
        Q = mk(epa_after)
        det = {}
        F = QB.team_features(Q, Ap, G, sh, [S], only_ts=[T], detail=det,
                             ratings={S: R}, league={S: L})
        d = det[(S, T)]
        PQ._MEM[('qs', S, C.OUT)] = Q
        rat = pd.DataFrame({'rating': d['rating'], 'den': d['den'], 'career_db': d['career_db'],
                            'starts': d['starts']}).fillna(0.0)
        ctx = PQ.team_context(S, T, 7, rat, repl=-0.05)
        outs.append((d['rating'].to_dict(), F.qb_id.iloc[0] if 'qb_id' in F else None, ctx['v2_starter'],
                     ctx['season_db'].to_dict()))
    PQ._MEM.pop(('qs', S, C.OUT), None)
    chk('post_T_game_never_enters_rating', outs[0][0] == outs[1][0] and 22 not in outs[0][0], outs)
    chk('post_T_starter_never_expected', outs[0][1] == 11 and outs[0][2] == 11 and outs[1][2] == 11, outs)
    exp = (3.0 + 5.0 - 0.01 * 60 - 0.02 * 60 + 150 * -0.05) / (60 + 150)   # adj = epa/db - opp def - h*H
    chk('synthetic_rating_value', close(outs[0][0][11], exp, 1e-12), (outs[0][0][11], exp))


def t_guards():
    from . import qb as PQ
    try:
        PQ.transfer_events([2024])
        chk('transfer_events_refuses_holdout', False)
    except AssertionError:
        chk('transfer_events_refuses_holdout', True)
    try:
        PQ.replacement(seasons=(2025,), n_boot=1)
        chk('replacement_refuses_holdout', False)
    except AssertionError:
        chk('replacement_refuses_holdout', True)


SYNTHETIC = [t_mixture, t_starter_distribution, t_side_features, t_lineup_columns, t_translation,
             t_point_in_time_reports, t_point_in_time_rating, t_guards]


# ================================================================= real data
def r_reproduce_stage7():
    from . import backtest_qb as BT
    rep, fit = BT.reproduce()
    print('  stage-7 reproduction (%s): max |diff| %s' % (rep['wf_dir'], rep['max_abs_diff']))
    chk('stage7_reproduction_exact', rep['exact'] and max(rep['max_abs_diff'].values()) < 1e-9, rep['max_abs_diff'])
    return fit


def r_context_reproduces_stage4():
    from . import qb as PQ
    from .. import common
    F4 = pd.read_parquet(common.out_path('stage4', 'qb_team.parquet'))
    for S in (2023, C.LIVE_SEASON):
        R, F = PQ.season_ratings(S)
        f4 = F4[F4.season.eq(S)]
        m = F.merge(f4, on=['season', 'prediction_ts', 'team_id'], suffixes=('', '_4'))
        cols = ['qb_exp_rating', 'qb_team_rating', 'qb_delta', 'qb_backup_rating', 'qb_drop', 'qb_exp_db_log',
                'qb_exp_starts', 'qb_changed', 'qb_unsettled', 'qb_missing']
        dm = max(float(np.nanmax(np.abs(m[c] - m[c + '_4']))) for c in cols)
        chk('cache_equals_stage4_%d' % S, len(m) == len(f4) == len(F) and dm == 0.0, (len(m), len(f4), dm))
        bad = 0
        for T, fT in F.groupby('prediction_ts'):
            rat = PQ.ratings_at(S, T, R)
            for _, row in fT.iterrows():
                ctx = PQ.team_context(S, T, int(row.team_id), rat)
                ft = PQ.side_features(ctx, ctx['v2_starter'], rat)
                for c in PQ.QB_SIDE_COLS:
                    a, b = ft.get(c, np.nan), row.get(c, np.nan)
                    if not ((pd.isna(a) and pd.isna(b)) or a == b):
                        bad += 1
        chk('context_rebuild_equals_stage4_%d' % S, bad == 0, bad)


def r_artifact_columns():
    from .. import predict_live as PL
    from ..weekly import project as PJ
    from . import lineup as LU
    A, gbm = PL.load_artifacts(C.PRODUCTION_MODEL_VERSION)
    chk('artifact_manifest_ok', PJ.verify_artifact(C.PRODUCTION_MODEL_VERSION)['ok'])
    cols = LU.artifact_qb_inputs(A)
    chk('artifact_qb_inputs_covered', LU.uncovered_qb_inputs(A) == [], LU.uncovered_qb_inputs(A))
    chk('artifact_qb_inputs_known', set(cols) == {'qb_delta_edge', 'qb_exp_edge', 'h_qb_exp_db_log', 'a_qb_exp_db_log',
                                                  'h_qb_changed', 'a_qb_changed', 'qb_missing_any',
                                                  'qb_unsettled_any'}, cols)
    PJ.assert_no_market_inputs(PJ.model_inputs(A))
    chk('artifact_no_market_inputs', True)
    return A, gbm


def r_no_report_identity(A, gbm):
    from . import backtest_qb as BT
    from . import qb as PQ
    from . import lineup as LU
    from ..weekly import project as PJ
    X, _, _, _ = BT.load_wf()
    S = C.LIVE_SEASON
    X = X[X.season.eq(S) & X.qb_missing_any.eq(0)]
    T = sorted(X.prediction_ts.unique())[-1]
    Xt = X[X.prediction_ts.eq(T)].head(40)
    rat = PQ.ratings_at(S, T)
    st = PQ.expected_starters(S, pd.Timestamp(T), pd.Timestamp(T), Xt, reports=[], ratings=rat)
    chk('no_report_all_unknown', all(e['knowledge'] == 'UNKNOWN' for e in st.values()))
    games, D = LU.project(Xt, A, gbm, st, {pd.Timestamp(T): rat})
    base = PJ.infer(Xt.reset_index(drop=True), A, gbm)
    bm = dict(zip(base.game_id.astype('int64'), zip(base.ens_pred, base.sigma, base.p_home_calibrated)))
    ok = all(g['n_scenarios'] == 1 and g['mixture']['margin'] == bm[g['game_id']][0]
             and g['mixture']['sd'] == bm[g['game_id']][1] and g['mixture']['p_home'] == bm[g['game_id']][2]
             and g['points_layer']['mixture']['margin'] == bm[g['game_id']][0] for g in games)
    chk('no_report_identity_exact', ok and len(games) == len(Xt), len(games))
    # the rebuild path for the V2 starter reproduces the artifact output exactly too
    Xr = Xt.copy().reset_index(drop=True)
    for i, r in Xr.iterrows():
        for side, pre, tid in (('home', 'h_', int(r.home_id)), ('away', 'a_', int(r.away_id))):
            ctx = st[(int(r.game_id), tid)]['ctx']
            LU.set_side(Xr, [i], side, PQ.side_features(ctx, ctx['v2_starter'], rat))
    LU.game_qb_columns(Xr)
    Dr = PJ.infer(Xr, A, gbm)
    chk('rebuild_v2_starter_identity', np.array_equal(Dr.ens_pred.values, base.ens_pred.values)
        and np.array_equal(Dr.sigma.values, base.sigma.values), float(np.max(np.abs(Dr.ens_pred - base.ens_pred))))
    # an OUT starter moves the projection only through the rebuilt columns, and to the backup
    r0 = Xt.iloc[:1]
    g0 = int(r0.game_id.iloc[0]); h0 = int(r0.home_id.iloc[0])
    st2 = dict(st)
    e = dict(st2[(g0, h0)])
    e['dist'] = PQ.starter_distribution(e['ctx'], {e['ctx']['v2_starter']: 'OUT'}, 'KNOWN')
    e['knowledge'] = 'KNOWN'
    st2[(g0, h0)] = e
    gg, _ = LU.project(r0, A, gbm, st2, {pd.Timestamp(T): rat})
    sc = gg[0]['scenarios']
    chk('out_starter_backup_scenario', len(sc) == 1 and sc[0]['home_qb']['qb_id'] != e['ctx']['v2_starter']
        and sc[0]['rebuilt_qb_columns'], sc)


def r_live_2026():
    from . import backtest_qb as BT
    res = BT.live_2026()
    fz, ko = res['modes']['freeze'], res['modes']['kickoff']
    print('  2026: report files %d (usable %d); changed at freeze %d, at kickoff %d'
          % (res['n_report_files'], res['n_report_files_usable'], fz['games_expected_starter_changed'],
             ko['games_expected_starter_changed']))
    chk('live_freeze_point_in_time', fz['games_with_usable_report_known'] == 0 and fz['games_expected_starter_changed'] == 0,
        fz['games_with_usable_report_known'])
    chk('live_kickoff_has_reports', ko['games_with_usable_report_known'] > 0)
    ok = True
    for g in ko['changed']:
        p = [s['p'] for s in g['scenarios']]
        ms = [s['margin'] for s in g['scenarios']]
        ok &= abs(sum(p) - 1) < 1e-5 and min(ms) - 1e-9 <= g['mixture']['margin'] <= max(ms) + 1e-9
        ok &= g['mixture']['sd'] >= min(s['sigma'] for s in g['scenarios']) - 1e-9
    chk('live_scenarios_consistent', ok and len(ko['changed']) >= 1, len(ko['changed']))
    out_cases = [g for g in ko['changed'] for side in ('home', 'away')
                 if any(s[side + '_qb']['status'] == 'NOT LISTED' for s in g['scenarios'])
                 and g['v2_expected_starter'][side] is not None
                 and all(s[side + '_qb']['qb_id'] != g['v2_expected_starter'][side]['qb_id'] for s in g['scenarios'])]
    chk('live_out_starter_replaced', len(out_cases) >= 1, len(out_cases))


def r_constants():
    from . import qb as PQ
    from . import backtest_qb as BT
    from . import lineup as LU
    from .. import walkforward as WF
    rp = PQ.replacement(n_boot=50)
    chk('replacement_mean_is_v2', close(rp['mean'], PQ.base()['shrink']['replacement_mean'], 1e-12))
    chk('replacement_constants', close(rp['mean'], PQ.REPLACEMENT['mean'], 1e-6) and close(rp['sd'], PQ.REPLACEMENT['sd'], 1e-6)
        and rp['n_qb_seasons'] == PQ.REPLACEMENT['n_qb_seasons'], rp)
    ev = PQ.transfer_events()
    est = PQ.estimate_persistence(ev, n_boot=20)
    P = PQ.PERSISTENCE
    chk('persistence_constants', close(est['transfer']['alpha'], P['alpha'], 1e-6) and close(est['transfer']['rho'], P['rho'], 1e-6)
        and close(est['transfer']['resid_sd'], P['resid_sd'], 1e-6) and est['n_transfer'] == P['n']
        and close(est['stay']['rho'], P['rho_stay'], 1e-6) and est['n_stay'] == P['n_stay']
        and close(est['pooled']['rho_transfer_shift'], P['rho_transfer_shift'], 1e-6), (est['transfer'], est['stay']))
    Q, G = PQ.base()['Q'], PQ.base()['G']
    q = Q[Q.g_season.isin(C.DEV_SEASONS)].groupby(['game_id', 'team_id']).db_ng.sum().reset_index()
    g = G[G.season.isin(C.DEV_SEASONS)]
    fbs = set(g[g.home_fbs.astype(bool)].home_id) | set(g[g.away_fbs.astype(bool)].away_id)
    chk('default_db_per_game', abs(q[q.team_id.isin(fbs)].db_ng.mean() - PQ.DEFAULT_DB_PER_GAME) < 0.1)
    X, M, fam, d = BT.load_wf()
    rep, (D, W, unc, fitted) = BT.reproduce(X, M, fam, d)
    Xo, Fl = BT.oracle_rows(X, list(range(C.FIRST_OOF_SEASON, max(C.DEV_SEASONS) + 1)))
    Dm = D[['game_id', 'season', 'margin', 'status', 'fcs_game']].copy()
    Dm['base_mean'] = D[['pred_' + k for k in WF.SUB]].mean(axis=1)
    Fz = Fl.merge(Dm, on=['game_id', 'season'])
    Fz = Fz[Fz.qb_change & Fz.status.eq('FINAL') & ~Fz.fcs_game.astype(bool) & Fz.margin.notna()]
    b = BT.fit_points_beta(Fz.assign(resid_base=Fz.margin - Fz.base_mean))
    chk('points_beta_constant', close(b, LU.QB_POINTS_BETA, 1e-6), b)


def main():
    fast = '--fast' in sys.argv
    for t in SYNTHETIC:
        try:
            t()
        except Exception as e:           # a crash is a failure, reported by name
            traceback.print_exc()
            chk(t.__name__ + '_crashed', False, repr(e))
    if not fast:
        try:
            r_reproduce_stage7()
            r_context_reproduces_stage4()
            A, gbm = r_artifact_columns()
            r_no_report_identity(A, gbm)
            r_live_2026()
            r_constants()
        except Exception as e:
            traceback.print_exc()
            chk('real_data_crashed', False, repr(e))
    for n, d in FAIL:
        print('FAILED:', n, d)
    print(('FAILED ' if FAIL else 'ALL GREEN ') + '%d passed, %d failed' % (PASS[0], len(FAIL)))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
