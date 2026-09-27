"""Tests for the non-QB personnel units (values, units, backtests).

    python3 -m v2.personnel.tests_units --fast     # synthetic checks only; needs no data directory
    python3 -m v2.personnel.tests_units            # + real-data checks (CFB_V2_DATA / CFB_V2_OUT = out_h)

Prints 'ALL GREEN n passed, 0 failed' (exit 0) or the failures (exit 1).
"""
import ast
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

PASS, FAIL = [0], []
HERE = os.path.dirname(os.path.abspath(__file__))


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL.append((name, detail))


def section(fn):
    try:
        fn()
    except Exception as e:                            # noqa: BLE001
        import traceback
        FAIL.append((fn.__name__ + ' raised', repr(e) + ' ' + traceback.format_exc()[-900:]))


def done():
    for n, d in FAIL:
        print('FAIL | %s%s' % (n, ('  ' + str(d)[:600]) if d is not None else ''))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (PASS[0], len(FAIL)))
    sys.exit(0 if not FAIL else 1)


# ================================================================ synthetic
def t_delta_zero():
    from . import units as UN
    rng = np.random.default_rng(1)
    b = rng.uniform(0, 0.4, 8)
    V = rng.normal(0, 2, 8)
    d, var = UN.lineup_delta(b, b.copy(), V, np.abs(V))
    chk('delta_zero_when_upcoming_equals_baseline', d == 0.0 and var == 0.0, (d, var))
    up = b.copy()
    up[0] = 0.0
    V[0] = 3.0
    d, _ = UN.lineup_delta(b, up, V)
    chk('delta_negative_when_a_positive_value_player_is_removed', d < 0, d)
    chk('delta_equals_share_change_times_value', abs(d - (-b[0] * 3.0)) < 1e-12, d)


def t_conditioning():
    from . import units as UN
    e, h = np.array([0.40, 0.30, 0.10]), np.array([0.50, 0.30, 0.20])     # p_hist 0.8, 1.0, 0.5
    nan = np.nan
    a = UN.condition_share(e, h, [1.0, 1.0, 1.0])
    chk('available_status_conditions_to_healthy_not_multiplied', np.allclose(a, h), a)
    chk('multiplying_would_double_count', not np.allclose(a, 1.0 * e))
    a = UN.condition_share(e, h, [0.5, 0.5, 0.5])
    chk('questionable_is_half_the_healthy_share', np.allclose(a, 0.5 * h), a)
    a = UN.condition_share(e, h, [0.0, nan, nan])
    chk('out_is_zero', a[0] == 0.0, a)
    chk('unknown_keeps_history', np.allclose(a[1:], e[1:]), a)
    a = UN.condition_share(e, h, [nan, nan, nan])
    chk('unknown_is_not_healthy', np.all(a <= h) and a[0] < h[0] and a[2] < h[2], a)
    sp = UN.condition_starter([0.64, 0.9, 0.2], [0.8, 1.0, 0.5], [1.0, nan, 0.0])
    chk('starter_prob_conditioned', abs(sp[0] - 0.8) < 1e-12 and sp[1] == 0.9 and sp[2] == 0.0, sp)
    sp = UN.condition_starter([0.5], [0.4], [1.0])
    chk('starter_prob_capped_at_1', sp[0] == 1.0, sp)


def t_redistribute():
    from . import units as UN
    a = np.array([0.0, 0.2, 0.1])                          # the star (0.4) is out
    u, r = UN.redistribute(a, 0.7, 0.25, available=[False, True, True])
    chk('redistribute_keeps_total', abs(u.sum() + r - 0.7) < 1e-12, (u, r))
    chk('redistribute_lambda_to_replacement', abs(r - 0.25 * 0.4) < 1e-12, r)
    chk('redistribute_pro_rata', abs((u[1] - 0.2) / (u[2] - 0.1) - 2.0) < 1e-9, u)
    chk('redistribute_out_player_stays_zero', u[0] == 0.0)
    u, r = UN.redistribute(np.array([0.5, 0.4]), 0.6, 0.3)
    chk('redistribute_scales_down_above_total', abs(u.sum() - 0.6) < 1e-12 and r == 0.0, u)
    u, r = UN.redistribute(np.array([0.0]), 0.5, 0.3, available=[False])
    chk('redistribute_nobody_available_all_to_replacement', u[0] == 0.0 and abs(r - 0.5) < 1e-12, (u, r))


def t_ew_and_prior():
    from . import units as UN
    Cm = np.array([[10, 0, 12, 11.], [2, 9, 3, 2.]])
    D = np.array([30, 28, 31, 29.])
    e, h = UN.ew_shares(Cm, D, [0.75, 1.5])
    W = [0.5 ** ((3 - np.arange(4)) / hl) for hl in (0.75, 1.5)]
    ph = [(W[i] * D * (Cm[i] > 0)).sum() / (W[i] * D).sum() for i in range(2)]
    chk('ew_e_equals_p_hist_times_h', np.allclose(e, np.array(ph) * h), (e, h, ph))
    chk('ew_no_missed_game_e_equals_h', abs(e[1] - h[1]) < 1e-12)
    chk('ew_healthy_above_history_after_a_miss', h[0] > e[0])
    pi0 = UN.prior_shares([], [], 0.01, 0.0)
    chk('pi_is_1_with_no_games', pi0 == (1.0, 1.0), pi0)
    w = np.full(6, 30 / 6.12)
    ages = np.arange(6)[::-1] + 0.5
    p3 = UN.prior_shares(w[:3], ages[:3], 0.008, 3)
    p6 = UN.prior_shares(w, ages, 0.008, 6)
    chk('pi_falls_as_games_accumulate', p6[0] < p3[0] < 1 and p6[1] < p3[1] < 1, (p3, p6))


def t_reanchoring_synthetic():
    """A star (0.5 of carries, last season too) is out from game 5 on; the replacement (0.1) takes 0.45.
    The baseline moves to the replacement through the rating's own weights; the baseline delta shrinks;
    the naive delta (upcoming - full health) does not."""
    from . import units as UN
    n = 13
    share = np.zeros((2, n))
    share[0, :5] = 0.5
    share[1, :5] = 0.1
    share[1, 5:] = 0.45
    prior = np.array([0.5, 0.1])
    V = np.array([3.0, 0.5])
    w = np.full(n, 30 / 6.12)
    tau2 = 0.008
    db, dn, sb, rb = [], [], [], []
    for J in range(6, n + 1):
        ages = (J - np.arange(J)) - 0.5
        pis, pir = UN.prior_shares(w[:J], ages, tau2, J)
        base, _, _ = UN.baseline_share(share[:, :J], w[:J], 0.5 ** (ages / 8.0), prior, pis, pir)
        up = np.array([0.0, 0.45])
        db.append(UN.lineup_delta(base, up, V)[0])
        dn.append(UN.lineup_delta(np.array([0.5, 0.1]), up, V)[0])
        sb.append(base[0])
        rb.append(base[1])
    chk('reanchor_absent_baseline_decreases', all(np.diff(sb) < 0), sb)
    chk('reanchor_replacement_baseline_increases', all(np.diff(rb) > 0), rb)
    chk('reanchor_baseline_delta_shrinks', all(np.diff(np.abs(db)) < 0) and abs(db[-1]) < abs(dn[-1]), (db, dn))
    chk('reanchor_naive_delta_constant', np.allclose(dn, dn[0]), dn)
    # a data-only rating (no prior) re-anchors fully in the limit
    J = n
    ages = (J - np.arange(J)) - 0.5
    base, ds, dr = UN.baseline_share(share, w, 0.5 ** (ages / 8.0), prior, 0.0, 0.0)
    chk('reanchor_data_only_limit_is_the_data_share', abs(base[0] - 0.5 * (ds[0] + dr[0])) < 1e-12 and base[0] < 0.25,
        (base, ds, dr))


def t_values_pure():
    from . import values as V
    k, repl, s2 = 160.0, -0.02, 1.3
    tau2 = s2 / k
    n, xbar = 200.0, 0.10
    m, v = V.posterior(repl, tau2, n, n * xbar, s2)
    chk('posterior_is_the_spec_shrinkage', abs(m - (n * xbar + k * repl) / (n + k)) < 1e-12, m)
    chk('posterior_variance', abs(v - s2 / (n + k)) < 1e-15, v)
    m2, v2 = V.propagate(0.3, tau2, 0.7, 0.0, tau2)
    chk('propagate_regresses_and_keeps_stationary_var', abs(m2 - 0.21) < 1e-12 and abs(v2 - tau2) < 1e-15, (m2, v2))
    r = V.season_rho([True, False, True], [1, 1, 2], 0.8, 0.4)
    chk('season_rho_stay_transfer_gap', np.allclose(r, [0.8, 0.4, 0.64]), r)
    chk('gate_reliable', V.reliability_gate('RELIABLE') == (True, True, None))
    chk('gate_insufficient_prior_only', V.reliability_gate('INSUFFICIENT')[:2] == (False, True))
    g = V.reliability_gate('UNRELIABLE')
    chk('gate_unreliable_yields_null', g[1] is False and 'UNRELIABLE' in g[2], g)
    chk('gate_missing_yields_null', V.reliability_gate(None)[1] is False)
    p = V.fg_make_prob([20, 35, 45, 55], [0.79, -0.86, 0.09])
    chk('fg_make_prob_decreasing', all(np.diff(p) < 0) and 0.4 < p[-1] < p[0] < 1, p)


def t_point_in_time_sums():
    from . import values as V
    T = pd.Timestamp('2025-10-14T12:00:00Z')
    rows = pd.DataFrame({'espn_id': [1, 1, 1, 2, 2], 'n': [10., 12, 9, 5, 7], 'e': [1., 2, 3, 0.5, 0.2],
                         'kickoff_ts': pd.to_datetime(['2025-10-04T19:00Z', '2025-10-11T19:00Z', '2025-10-14T12:00Z',
                                                       '2025-10-11T19:00Z', '2025-10-18T19:00Z'], utc=True)})
    rq = pd.DataFrame({'espn_id': [1, 2, 3], 'T': [T, T, T]})
    n, e = V.sums_before(rows, rq)
    chk('pit_strictly_before_T', list(n) == [22.0, 5.0, 0.0] and list(e) == [3.0, 0.5, 0.0], (n, e))
    rows2 = rows.copy()
    later = rows2.kickoff_ts >= T
    rows2.loc[later, 'e'] = 99.0
    rows2.loc[later, 'n'] = 999.0
    n2, e2 = V.sums_before(rows2, rq)
    chk('pit_rows_at_or_after_T_change_nothing', np.array_equal(n, n2) and np.array_equal(e, e2))


def _synthetic_panel():
    rows = []
    for i, (e, h, b, Vv) in enumerate([(0.40, 0.50, 0.45, 2.0), (0.20, 0.20, 0.20, 0.5), (0.05, 0.10, 0.02, 0.0)]):
        rows.append({'team_id': 7, 'T': pd.Timestamp('2026-09-26T00:00Z'), 'group': 'RB', 'unit': 'RB', 'espn_id': 100 + i,
                     'e': e, 'h': h, 'base': b, 'V': Vv, 'V_sd': 0.5, 'group_total': 0.65, 'den_per_game': 30.0,
                     'next_played': False, 'in_season': True, 'games_missed_run': 0, 'prod_share': np.nan,
                     'pi_s': 0.5, 'pi_r': 0.5, 'J': 5, 'season': 2026, 'next_c': np.nan, 'rem_c': np.nan,
                     'rem_games': np.nan, 'next_group_c': np.nan})
    return pd.DataFrame(rows)


def t_lineups_synthetic():
    from . import units as UN
    P = _synthetic_panel()
    L = UN.lineups(P, 0.3, availability=None)
    chk('lineup_unknown_is_history_not_healthy', np.allclose(L.u_report, L.e), L.u_report.tolist())
    L = UN.lineups(P, 0.3, availability={(7, 100): 0.0})
    u = L.u_report.values
    chk('lineup_out_player_zero', u[0] == 0.0, u)
    chk('lineup_out_mass_redistributed', abs(u.sum() - (0.65 - 0.3 * 0.40)) < 1e-9 and u[1] > 0.20, u)
    L = UN.lineups(P, 0.3, availability={(7, 100): 1.0, (7, 101): 1.0, (7, 102): 1.0})
    chk('lineup_all_available_is_healthy_scaled', np.allclose(L.u_report, L.u_healthy), (L.u_report.tolist(),
                                                                                        L.u_healthy.tolist()))
    P2 = P.copy()
    P2['base'] = P2.e
    D = UN.deltas(UN.lineups(P2, 0.3), variants=('pregame',))
    chk('deltas_zero_when_history_equals_baseline', abs(float(D.d_pregame.iloc[0])) < 1e-12, D.d_pregame.tolist())
    # the report-path candidate: known absences only -> exactly 0 without a report (ordinary games unchanged)
    L0 = UN.lineups(P, 0.3, availability=None)
    chk('known_lineup_is_healthy_without_report', np.allclose(L0.u_known, L0.u_healthy))
    D0 = UN.deltas(L0, variants=('report_absence_use', 'report'))
    chk('report_absence_delta_zero_without_report', float(D0.d_report_absence_use.abs().max()) == 0.0,
        D0.d_report_absence_use.tolist())
    L1 = UN.lineups(P, 0.3, availability={(7, 100): 0.0})
    D1 = UN.deltas(L1, variants=('report_absence_use',))
    chk('report_absence_delta_negative_when_starter_out', float(D1.d_report_absence_use.iloc[0]) < 0,
        D1.d_report_absence_use.tolist())
    Vu = L1.h * L1.den_per_game
    exp = float(((L1.u_known - L1.u_healthy) * Vu).sum())
    chk('report_absence_delta_formula', abs(float(D1.d_report_absence_use.iloc[0]) - exp) < 1e-9)
    L2 = UN.lineups(P, 0.3, availability={(7, 100): 0.5})
    chk('questionable_is_half_an_absence', abs(L2.u_known.iloc[0] - 0.5 * L2.u_healthy.iloc[0]) <
        abs(L2.u_healthy.iloc[0]) and L2.u_known.iloc[0] > 0)
    # the new-absence flag: 1-2 missed games only
    P3 = P.assign(next_played=True, next_c=[0.0, 5.0, 1.0], rem_c=[0.0, 9.0, 3.0], rem_games=5, next_den=30.0,
                  next_group_c=20.0, games_missed_run=[2, 0, 0])
    D3 = UN.deltas(UN.lineups(P3, 0.3), variants=('oracle',))
    chk('absence_three_games_is_not_new', int(D3.n_absent_in_season.iloc[0]) == 1 and int(D3.n_absent_new.iloc[0]) == 0,
        D3[['n_absent_in_season', 'n_absent_new', 'max_absence_len']].to_dict('records'))


def t_ol_rule():
    from . import units as UN
    T = pd.Timestamp('2026-09-26T12:00:00Z')
    rep = {'team_id': 5, 'game_id': '900', 'published_at': '2026-09-26T10:00:00Z', 'ok': True,
           'rows': [{'position': 'OL', 'status': 'OUT'}, {'position': 'OT', 'status': 'QUESTIONABLE'},
                    {'position': 'WR', 'status': 'OUT'}, {'position': 'G', 'status': 'OUT_FIRST_HALF'}]}
    o = UN.ol_from_reports([rep], T, {5: 900})
    x = o.get(5, {})
    chk('ol_counts', x.get('ol_listed') == 3 and x.get('ol_out') == 1 and x.get('ol_uncertain') == 1, x)
    chk('ol_expected_missing', abs(x.get('ol_expected_missing', 0) - 2.0) < 1e-12, x)
    chk('ol_declared_prior_not_estimated', x.get('status') == 'NOT_ESTIMATED'
        and abs(x['var_inflation_pts2'] - UN.OL_VAR_PER_MISSING * 2.0) < 1e-12, x)
    late = dict(rep, published_at='2026-09-26T13:00:00Z')
    chk('ol_report_after_T_ignored', UN.ol_from_reports([late], T, {5: 900}) == {})
    chk('ol_other_game_ignored', UN.ol_from_reports([rep], T, {5: 901}) == {})
    chk('ol_failed_read_ignored', UN.ol_from_reports([dict(rep, ok=False)], T, {5: 900}) == {})


def t_beta_fit():
    from . import backtest_units as BU
    rng = np.random.default_rng(3)
    n = 6000
    G = pd.DataFrame({'season': rng.integers(2014, 2020, n), 'base': rng.normal(0, 14, n)})
    for u in BU.EVAL_UNITS:
        G['D_oracle__' + u] = rng.normal(0, 1.0, n)
    G['margin'] = G.base + 0.6 * G['D_oracle__RB'] + rng.normal(0, 16, n)
    beta, cov, m = BU.fit_beta(G, ('RB', 'WR_TE'), 'oracle', np.ones(n, dtype=bool))
    chk('beta_recovered', abs(beta[0] - 0.6) < 3 * np.sqrt(cov[0, 0]) and abs(beta[1]) < 3 * np.sqrt(cov[1, 1]), beta)
    few = np.zeros(n, dtype=bool)
    few[:30] = True
    b2, _, _ = BU.fit_beta(G, ('RB',), 'oracle', few)
    X = G.loc[few, 'D_oracle__RB'].values
    y = (G.margin - G.base).values[few]
    ols = float(X @ y / (X @ X))
    chk('beta_shrunk_toward_zero', abs(b2[0]) < abs(ols), (b2, ols))
    pred, betas = BU.walk_forward(G, ('RB',), 'oracle', [2018, 2019])
    chk('walk_forward_uses_earlier_seasons_only', betas[2018]['n_train'] == int((G.season < 2018).sum()), betas[2018])
    p = BU.p_home([0.0, 7.0, -7.0], [16.0, 16.0, 16.0], 100)
    chk('p_home_symmetric', abs(p[0] - 0.5) < 1e-12 and abs(p[1] + p[2] - 1) < 1e-12, p)


MARKET_WORDS = None


def _market_names():
    from .. import contract as K
    from .. import plays as P
    from ..weekly import project as PJ
    return set(K.MARKET_COLS) | set(K.EVALUATION_COLS) | set(PJ.MARKET_COLUMNS) | set(P.FORBIDDEN_PBP_COLUMNS)


def t_no_market():
    from . import backtest_units as BU
    chk('stage7_allowlist_is_pure', BU.assert_no_market(BU.STAGE7_COLS))
    for bad in ('close_margin', 'spread_open', 'line', 'home_moneyline', 'open_margin'):
        try:
            BU.assert_no_market([bad])
            chk('market_guard_raises_' + bad, False)
        except AssertionError:
            chk('market_guard_raises_' + bad, True)
    names = _market_names()
    for f in ('values.py', 'units.py', 'backtest_units.py', 'backtest.py'):
        tree = ast.parse(open(os.path.join(HERE, f)).read())
        consts = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        hit = sorted(consts & names)
        chk('no_market_string_in_' + f, not hit, hit)


def t_dev_only_guards():
    from . import values as V
    from . import backtest_units as BU
    for fn, arg in ((V.estimate_constants, [2016, 2024]), (V._pbp_play_constants, [2025]),
                    (BU.estimate_lambda, [2023, 2024]), (BU.returning_production, [2025]),
                    (BU.multi_absence, None)):
        if arg is None:
            continue
        try:
            fn(arg)
            chk('dev_only_' + fn.__name__, False)
        except AssertionError:
            chk('dev_only_' + fn.__name__, True)


FAST = [t_delta_zero, t_conditioning, t_redistribute, t_ew_and_prior, t_reanchoring_synthetic, t_values_pure,
        t_point_in_time_sums, t_lineups_synthetic, t_ol_rule, t_beta_fit, t_no_market, t_dev_only_guards]


# ================================================================ real data
def r_constants():
    from . import values as V
    c = V.constants()
    chk('const_dev_seasons_only', c['dev_seasons'] == list(range(2016, 2024)), c['dev_seasons'])
    for comp in V.COMPONENTS:
        x = c['components'][comp]
        chk('const_estimated_' + comp, x.get('estimated') is True, x)
        if x.get('estimated'):
            chk('const_k_in_ci_' + comp, x['k_ci'][0] <= x['k'] <= x['k_ci'][1], (x['k'], x['k_ci']))
            chk('const_repl_in_ci_' + comp, x['repl_ci'][0] <= x['repl'] <= x['repl_ci'][1])
    chk('const_secondary_only_reliable_seasons', set(c['components']['SEC_int']['seasons']) <= set(range(2016, 2021))
        and set(c['components']['SEC_pbu']['seasons']) <= set(range(2016, 2021)),
        (c['components']['SEC_int']['seasons'], c['components']['SEC_pbu']['seasons']))
    mp = V.model_params(c)
    chk('const_rho_in_unit_interval', all(0 <= p['rho_stay'] <= 1 and 0 <= p['rho_transfer'] <= p['rho_stay']
                                          for p in mp.values()), {k: (p['rho_stay'], p['rho_transfer']) for k, p in mp.items()})


def r_unreliable_null():
    from . import values as V
    T = pd.Timestamp('2022-10-18T12:00:00Z')
    from . import usage as U
    pg = U.player_games(2022, T)
    fam = V.family_map(2022)
    pg = pg.assign(f=pg.espn_id.map(fam))
    sec = pg[pg.f.isin(['CB', 'S', 'DB_OTHER'])].drop_duplicates('espn_id').head(20)
    fr = pg[pg.f.isin(['EDGE', 'LB', 'DT']) & (pg.def_sacks > 0)].drop_duplicates('espn_id').head(20)
    rq = pd.concat([pd.DataFrame({'espn_id': sec.espn_id, 'team_id': sec.team_id, 'T': T, 'component': 'SEC_int'}),
                    pd.DataFrame({'espn_id': sec.espn_id, 'team_id': sec.team_id, 'T': T, 'component': 'SEC_pbu'}),
                    pd.DataFrame({'espn_id': fr.espn_id, 'team_id': fr.team_id, 'T': T, 'component': 'FRONT_sack'})],
                   ignore_index=True)
    v = V.values_for(2022, rq)
    s = v[v.component.str.startswith('SEC')]
    chk('secondary_2022_null_with_reason', s.value_rate.isna().all() and s.null_reason.notna().all(),
        s[['component', 'null_reason']].drop_duplicates().to_dict('records'))
    f = v[v.component.eq('FRONT_sack')]
    chk('front_2022_valued', f.value_rate.notna().all() and len(f) > 0)


def r_base_and_market():
    from . import backtest_units as BU
    B = BU.load_base()
    m = B.p_home_raw.notna()
    chk('base_reproduces_p_home_raw', float(np.abs(B.p_base[m] - B.p_home_raw[m]).max()) < 1e-12)
    chk('base_no_market_columns', BU.assert_no_market(list(B.columns)))
    chk('base_fbs_final_only', bool(B.home_fbs.all() and B.away_fbs.all() and B.status.eq('FINAL').all()))


def r_pi_check():
    """The one-team pi (used by the baseline) against the joint solve's off_var(T) / off_var(T0)."""
    from .. import common
    from . import units as UN
    S = 2019
    rw = UN.rating_weights(S)
    rt = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S),
                         columns=['prediction_ts', 'team_id', 'metric', 'off_var'])
    rt = rt[rt.metric.eq('epa_pass')]
    T0 = rt.prediction_ts.min()
    tau = rt[rt.prediction_ts.eq(T0)].set_index('team_id').off_var
    x = rt[rt.prediction_ts.isin(sorted(rt.prediction_ts.unique())[3:12:2])]
    teams = [t for t in sorted(set(x.team_id)) if t in rw['metrics'][('epa_pass', 'o')]['tau2'].index][:60]
    a, b = [], []
    for r in x[x.team_id.isin(teams)].itertuples(index=False):
        a.append(UN.pi_at(rw, 'epa_pass', 'o', int(r.team_id), pd.Timestamp(r.prediction_ts))[0])
        b.append(r.off_var / tau[r.team_id])
    c = float(np.corrcoef(a, b)[0, 1])
    chk('pi_one_team_matches_joint_solve', c > 0.98, c)


def r_panel_matches_state():
    """The panel's history share e is player_week_state's expected_usage_share (same definition)."""
    from . import units as UN
    from . import state as ST
    S, T = 2023, pd.Timestamp('2023-10-17T12:00:00Z')
    st = ST.player_week_state(S, T, availability=[])
    teams = sorted(st[st.context.eq('in_season')].team_id.unique())[:6]
    P = UN.panel(S, pd.DataFrame({'team_id': teams, 'T': T}), oracle=False)
    x = P[P.group.isin(['RB', 'WR_TE']) & P.in_season].merge(
        st[['team_id', 'espn_id', 'expected_usage_share', 'position_family']], on=['team_id', 'espn_id'], how='inner')
    x = x[x.family.eq(x.position_family)]
    d = float((x.e - x.expected_usage_share).abs().max()) if len(x) else 1.0
    chk('panel_history_share_equals_state_expected_share', len(x) > 20 and d < 1e-9, (len(x), d))


def r_point_in_time_panel():
    """Rewrite every player-game and team-game at or after T (and the FG attempts): the panel at T and every
    value in it are unchanged."""
    from . import units as UN
    from . import usage as U
    from . import values as V
    S, T = 2023, pd.Timestamp('2023-10-17T12:00:00Z')
    teams = [333, 57, 2]
    fr = pd.DataFrame({'team_id': teams, 'T': T})
    P1 = UN.panel(S, fr, oracle=False)
    pg0, tg0, fa0 = U.player_games, U.team_games, V.fg_attempts

    def pg_(season, T_=None, **k):
        d = pg0(season, T_, **k)
        if season == S:
            d = d.copy()
            m = d.kickoff_ts >= T
            for c in ('rush_att_ng', 'rush_epa_ng', 'targets_ng', 'rec_epa_ng', 'def_sacks', 'punts', 'punt_net_yds',
                      'xp_att', 'xp_made'):
                d.loc[m, c] = d.loc[m, c] * 3 + 7
        return d

    def tg_(season, T_=None, **k):
        d = tg0(season, T_, **k)
        if season == S:
            d = d.copy()
            m = d.kickoff_ts >= T
            d.loc[m, 'team_rushes_id_ng'] = d.loc[m, 'team_rushes_id_ng'] * 2 + 1
        return d

    def fa_(season):
        d = fa0(season)
        if season == S:
            d = d.copy()
            d.loc[d.kickoff_ts >= T, 'made'] = 0.0
        return d
    try:
        U.player_games, U.team_games, V.fg_attempts = pg_, tg_, fa_
        for M in (UN._MEM, V._MEM):
            M.clear()
        P2 = UN.panel(S, fr, oracle=False)
    finally:
        U.player_games, U.team_games, V.fg_attempts = pg0, tg0, fa0
        for M in (UN._MEM, V._MEM):
            M.clear()
    cols = ['base', 'e', 'h', 'V', 'V_sd', 'pi_s', 'pi_r']
    k = ['team_id', 'group', 'espn_id']
    a = P1.sort_values(k).reset_index(drop=True)
    b = P2.sort_values(k).reset_index(drop=True)
    same = len(a) == len(b) and all(np.allclose(a[c].fillna(-9).values, b[c].fillna(-9).values, rtol=0, atol=1e-12)
                                    for c in cols)
    chk('pit_panel_unchanged_by_rows_after_T', same, (len(a), len(b)))


def r_live_2026():
    from . import units as UN
    from . import state as ST
    reps = [r for r in ST.load_reports(2026) if ST._truthy(r.get('ok', True)) and r.get('published_at')]
    from . import usage as U
    k = U.kickoffs(2026).set_index('game_id').kickoff_ts
    found = False
    for r in reps:
        outs = [p for p in r.get('rows') or [] if p.get('position') in ('RB', 'WR', 'TE') and
                ST._status_key(p.get('status')) == 'OUT']
        if not outs:
            continue
        gid = int(r['game_id'])
        T = pd.Timestamp(k.get(gid)) - pd.Timedelta(minutes=1)
        if pd.isna(T) or pd.Timestamp(r['published_at']) > T:
            continue
        s = UN.unit_state(2026, T, availability=[r])
        tid = s[s.next_game_id.astype(str).eq(str(gid)) & s.knowledge.eq('REPORTED')]
        if not len(tid):
            continue
        lu = sum((json.loads(x) for x in tid[tid.unit.isin(['RB', 'WR_TE'])].lineup.dropna()), [])
        ids_out = {'espn:%s' % p['player_id'] for p in outs}
        hit = [p for p in lu if p['player_id'] in ids_out]
        if hit:
            chk('live_out_player_expected_zero', all(p['expected'] == 0.0 for p in hit), hit)
            nl = [p for p in lu if p['player_id'] not in ids_out and p['play_probability'] is not None]
            chk('live_not_listed_on_comprehensive_is_available', all(p['play_probability'] == 1.0 for p in nl) if
                r.get('comprehensive') else True, nl[:3])
            other = s[~s.next_game_id.astype(str).eq(str(gid)) & s.unit.isin(['RB', 'WR_TE'])]
            chk('live_unreported_teams_unknown', other.knowledge.eq('UNKNOWN').all() if len(other) else True)
            ol = s[s.unit.eq('OL')]
            chk('live_ol_rows_not_estimated', ol.value_status.str.startswith('NOT_ESTIMATED').all() and len(ol) > 0)
            rep = tid[tid.unit.isin(['RB', 'WR_TE'])]
            chk('live_known_absence_delta_nonpositive', (rep.absence_delta_use.fillna(0) <= 1e-12).all() and
                (rep.absence_delta_use.fillna(0) < 0).any(), rep[['unit', 'absence_delta_use']].to_dict('records'))
            chk('live_unreported_known_absence_zero', (other.absence_delta_use.fillna(0).abs() < 1e-12).all()
                if len(other) else True)
            found = True
            break
    chk('live_found_a_report_with_an_out_skill_player', found)


def r_backtest_outputs():
    """The dev backtest outputs (backtest_units --dev) are present and consistent."""
    from . import backtest_units as BU
    f = os.path.join(BU.out_dir(), 'backtest_dev.json')
    if not os.path.exists(f):
        chk('backtest_dev_present (run backtest_units --dev)', False, f)
        return
    r = json.load(open(f))
    o = r['oracle']['variants']
    chk('backtest_dev_has_all_variants', set(o) == set(BU.VARIANT_UNITS), list(o))
    chk('backtest_dev_seasons', r['oracle']['seasons'] == list(BU.DEV))
    n_all = o['ALL']['all_games']['base']['n']
    chk('backtest_dev_change_subset', o['SKILL']['unit_change_games']['base']['n'] < n_all and
        o['SKILL']['unit_change_games']['base']['n'] > 100)
    for name, v in o.items():
        for S, b in v['betas'].items():
            chk('beta_walk_forward_%s_%s' % (name, S), b['n_train'] > 0)
            break
    lam = json.load(open(os.path.join(BU.out_dir(), 'lambda.json')))
    chk('lambda_estimated_in_unit_interval', 0 <= lam['lambda'] <= 1 and lam['n_one_absence'] > 100, lam)
    chk('prereg_written_before_holdout', os.path.exists(os.path.join(BU.out_dir(), 'prereg_units.json')))


def r_holdout_guard():
    from . import backtest_units as BU
    import tempfile
    d = tempfile.mkdtemp(dir=os.path.dirname(BU.out_dir()), prefix='_test_guard_')
    od = BU.out_dir
    try:
        BU.out_dir = lambda: d
        open(os.path.join(d, 'backtest_holdout.json'), 'w').write('{}')
        try:
            BU.run_holdout()
            chk('holdout_scored_once_guard', False)
        except SystemExit as e:
            chk('holdout_scored_once_guard', 'ONCE' in str(e), str(e))
    finally:
        BU.out_dir = od
        import shutil
        shutil.rmtree(d, ignore_errors=True)


REAL = [r_constants, r_unreliable_null, r_base_and_market, r_pi_check, r_panel_matches_state, r_point_in_time_panel,
        r_live_2026, r_backtest_outputs, r_holdout_guard]


def main(argv):
    fast = '--fast' in argv
    for fn in FAST:
        section(fn)
    if not fast:
        for fn in REAL:
            section(fn)
    done()


if __name__ == '__main__':
    main(sys.argv[1:])
