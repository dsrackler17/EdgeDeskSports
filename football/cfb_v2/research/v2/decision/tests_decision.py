"""Tests for the decision-science layer.

    python3 -m v2.decision.tests_decision          synthetic + data + artifact + parity
    python3 -m v2.decision.tests_decision --fast   synthetic checks only (no data directories)

Prints 'ALL GREEN n passed, 0 failed' on success.
"""
import ast
import json
import math
import os
import sys
import traceback

import numpy as np
import pandas as pd

from .. import config as C
from . import core
from . import calibration as CAL
from . import reference as REF

PASS, FAIL = [], []


def check(name, fn):
    try:
        fn()
        PASS.append(name)
    except Exception as e:                              # noqa: BLE001
        FAIL.append((name, '%s: %s' % (type(e).__name__, e)))
        if os.environ.get('DEBUG'):
            traceback.print_exc()


def near(a, b, tol=1e-9):
    assert a is not None and b is not None and abs(a - b) <= tol, '%r != %r (tol %g)' % (a, b, tol)


# ================================================================ synthetic
def t_vig_removal():
    p, over = core.devig(-110, -110)
    near(p, 0.5)
    near(over, 2 * (110 / 210) - 1, 1e-12)
    p1, _ = core.devig(-120, 100)
    p2, _ = core.devig(100, -120)
    near(p1, (120 / 220) / (120 / 220 + 0.5), 1e-12)
    near(p1 + p2, 1.0, 1e-12)
    p3, _ = core.devig(130, -150)
    assert p3 < 0.5
    assert core.devig(-110, None) == (None, None)
    assert core.devig(-110, float('nan')) == (None, None)
    assert core.market_implied_side(-110, None) == (0.5, 'FAIR_LINE_0.5')
    assert core.market_implied_side(-120, 100)[1] == 'DEVIG_PROPORTIONAL'


def t_break_even():
    near(core.break_even(-110), 110 / 210, 1e-12)
    near(core.break_even(150), 0.4, 1e-12)
    near(core.break_even(-200), 2 / 3, 1e-12)
    near(core.break_even(100), 0.5, 1e-12)
    near(core.american_to_payout(-110), 100 / 110, 1e-12)
    assert math.isnan(core.american_to_payout(50))          # not a valid American price
    assert math.isnan(core.break_even(float('nan')))


def t_push():
    tab = {'buckets': [{'lo': 0, 'hi': 2.5, 'p': 0.01}, {'lo': 2.5, 'hi': 3.5, 'p': 0.09}, {'lo': 3.5, 'hi': 6.5, 'p': 0.02},
                       {'lo': 6.5, 'hi': 7.5, 'p': 0.06}, {'lo': 7.5, 'hi': 13.5, 'p': 0.03}, {'lo': 13.5, 'hi': 99, 'p': 0.028}],
           'default': 0.02}
    near(core.push_prob_lookup(3, tab), 0.09)
    near(core.push_prob_lookup(-7, tab), 0.06)
    near(core.push_prob_lookup(3.5, tab), 0.0)
    near(core.push_prob_lookup(0, tab), 0.01)
    js = {'%s-%s' % (b['lo'], b['hi']): b['p'] for b in tab['buckets']}
    for L in (-14, -7, -3.5, -3, 0, 1, 3, 7, 10, 21):
        near(REF.push_probability(L, js), core.push_prob_lookup(L, tab))
    rng = np.random.default_rng(1)
    lines = rng.choice([3.0, 3.5, 7.0], 6000)
    margins = np.where(rng.random(6000) < 0.1, lines, lines + rng.choice([-1, 1], 6000) * rng.integers(1, 20, 6000))
    ft = core.fit_push_table(lines, margins)
    b3 = [b for b in ft['buckets'] if b['lo'] == 2.5][0]
    assert abs(b3['p'] - 0.1) < 0.02, b3
    assert core.push_prob_model(0.0, 16.0, 3.5, 100) == 0.0
    pm = core.push_prob_model(0.0, 16.0, 3.0, 100)
    assert 0.015 < pm < 0.03, pm


def t_ev_with_push():
    near(core.ev_with_push(0.55, 0.1, -110), 0.55 * 0.9 * (100 / 110) - 0.45 * 0.9, 1e-12)
    for pp in (0.0, 0.05, 0.12):
        near(core.ev_with_push(core.break_even(-110), pp, -110), 0.0, 1e-12)
        near(core.ev_with_push(core.break_even(140), pp, 140), 0.0, 1e-12)
    near(core.ev_with_push(0.5, 0.0, 100), 0.0, 1e-12)
    near(core.units(1, -110), 100 / 110, 1e-12)
    near(core.units(0, -110), 0.0)
    near(core.units(-1, 150), -1.0)


def t_distribution():
    from ..walkforward import t_cdf
    for x in (-2.0, -0.3, 0.0, 0.7, 1.9):
        for df in (5, 30, 100):
            near(core.t_cdf_std(x, df), float(t_cdf(np.array([x]), df)[0]), 1e-12)
    near(core.mean_abs_t_std(1e6), math.sqrt(2 / math.pi), 1e-5)
    near(core.cover_prob_home(0.0, 16.0, 0.0, 100), 0.5, 1e-12)
    assert core.cover_prob_home(7.0, 16.0, 3.0, 100) > 0.5
    near(REF.pure_cover(7.0, 16.0, 100, -3.0, 'HOME'), core.cover_prob_home(7.0, 16.0, 3.0, 100), 1e-12)
    near(REF.pure_cover(7.0, 16.0, 100, -3.0, 'HOME') + REF.pure_cover(7.0, 16.0, 100, -3.0, 'AWAY'), 1.0, 1e-12)


def _synthetic_calibration_data(n=6000, w0=0.3, seed=7):
    rng = np.random.default_rng(seed)
    p = rng.uniform(0.5, 0.85, n)
    y = (rng.random(n) < core.sigmoid(w0 * core.logit(p))).astype(float)
    return p, y


def t_maps_monotone_in_unit_interval():
    p, y = _synthetic_calibration_data()
    grid = np.linspace(0.001, 0.999, 999)
    specs = {'shrink': CAL.symmetric_shrink_map(CAL.fit_shrink(p, y)['w']), 'platt': CAL.fit_platt(p, y),
             'beta': CAL.fit_beta(p, y), 'logit_pwl': CAL.fit_logit_pwl(p, y), 'isotonic': CAL.fit_isotonic_symmetric(p, y),
             'identity': {'method': 'identity'}}
    for k, s in specs.items():
        v = CAL.apply_map_np(s, grid)
        assert np.all(v > 0) and np.all(v < 1), k
        assert np.all(np.diff(v) >= -1e-12), '%s not monotone' % k
        ref = CAL.apply_reference(s, grid)
        assert np.max(np.abs(ref - v)) < 1e-12, '%s: numpy and reference maps differ' % k
    for k in ('shrink', 'logit_pwl', 'isotonic', 'identity'):         # the side-symmetric (decision-eligible) family
        v = CAL.apply_map_np(specs[k], grid)
        v2 = CAL.apply_map_np(specs[k], 1 - grid)
        assert np.max(np.abs(v + v2 - 1)) < 1e-9, '%s is not side-symmetric' % k
        near(float(CAL.apply_map_np(specs[k], np.array([0.5]))[0]), 0.5, 1e-9)


def t_shrink_recovers_weight():
    p, y = _synthetic_calibration_data(n=40000, w0=0.25, seed=3)
    f = CAL.fit_shrink(p, y)
    assert abs(f['w'] - 0.25) < 0.04, f
    assert f['w_ci95_profile'][0] < 0.25 < f['w_ci95_profile'][1], f
    pm = np.full_like(p, 0.55)                       # a non-0.5 market anchor is an offset
    y2 = (np.random.default_rng(4).random(len(p)) < CAL.shrink_np(p, pm, 0.4)).astype(float)
    assert abs(CAL.fit_shrink(p, y2, pm)['w'] - 0.4) < 0.05


def _toy_frame():
    rows = []
    rng = np.random.default_rng(11)
    for s in (2016, 2017, 2018, 2019, 2021, 2022, 2023):
        for _ in range(400):
            rows.append({'season': s, 'window': 'dev', 'pure_cover_prob': rng.uniform(0.5, 0.8),
                         'ats_win': float(rng.random() < 0.52)})
    return pd.DataFrame(rows)


def t_walk_forward_refuses_future():
    try:
        CAL.assert_past_only([2017, 2018], 2018)
        raise AssertionError('assert_past_only accepted the scored season')
    except AssertionError as e:
        assert 'future season' in str(e)
    D = _toy_frame()
    seen = {}

    def fit(tr):
        seen[len(seen)] = sorted(tr.season.unique())
        return CAL.fit_shrink(tr.pure_cover_prob.values, tr.ats_win.values)
    pr, fits = CAL.walk_forward(D, [2018, 2019, 2021, 2022, 2023], fit, lambda m, c: CAL.shrink_np(c.pure_cover_prob.values, 0.5, m['w']))
    for S, seasons in zip([2018, 2019, 2021, 2022, 2023], seen.values()):
        assert max(seasons) < S, (S, seasons)


def t_holdout_never_reaches_a_fitter():
    D = _toy_frame()
    bad = pd.concat([D, pd.DataFrame([{'season': 2024, 'window': 'holdout', 'pure_cover_prob': 0.6, 'ats_win': 1.0}])])
    for frame in (bad, D.assign(window='holdout'), pd.concat([D, pd.DataFrame([{'season': 2026, 'window': 'live',
                                                                                'pure_cover_prob': 0.6, 'ats_win': 1.0}])])):
        try:
            CAL.assert_fit_rows(frame)
            raise RuntimeError('a holdout/live row reached a fitter')
        except AssertionError:
            pass
    try:
        CAL.walk_forward(bad, [2025], lambda tr: None, lambda m, c: None)
        raise RuntimeError('walk_forward trained on a holdout season')
    except AssertionError:
        pass


def t_holdout_static_guard():
    """Every read of the decision dataset in fitting code filters to DEV (or DEV/live for fixture inputs)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for fn in ('study.py', 'freeze.py'):
        src = open(os.path.join(here, fn)).read()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, 'attr', '') == 'read_parquet':
                txt = ast.get_source_segment(src, node)
                if 'decision_dataset' in txt:
                    assert 'filters' in txt and "'window'" in txt and 'holdout' not in txt, (fn, txt)


def t_models_and_reference_agree():
    rng = np.random.default_rng(5)
    df = pd.DataFrame({'gap_pts': rng.uniform(0, 8, 500), 'ens_sd': rng.uniform(0, 4, 500), 'early_season': rng.integers(0, 2, 500),
                       'season': 2020, 'window': 'dev'})
    df['positive_clv'] = (rng.random(500) < core.sigmoid(-0.2 + 0.15 * df.gap_pts)).astype(float)
    df['clv'] = 0.2 * df.gap_pts + rng.normal(0, 1, 500)
    df.loc[3, 'ens_sd'] = np.nan
    for kind, tgt in (('logistic', 'positive_clv'), ('linear', 'clv')):
        spec = CAL.fit_model(df, ['gap_pts', 'ens_sd', 'early_season'], tgt, kind=kind)
        spec = json.loads(json.dumps(spec))
        v = CAL.eval_model_np(spec, df)
        for i in range(0, 500, 37):
            feats = {k: (None if pd.isna(df.loc[i, k]) else float(df.loc[i, k])) for k in ('gap_pts', 'ens_sd', 'early_season')}
            near(REF.eval_model(spec, feats), float(v[i]), 1e-10)
        assert REF.eval_model(dict(spec, fill={}), {'gap_pts': 1.0, 'ens_sd': None, 'early_season': 0}) is None


def t_empirical_bayes():
    shr, kap, p0 = CAL.eb_beta_binomial([52, 51, 53, 50], [100, 100, 100, 100])
    assert kap > 1000 and max(shr) - min(shr) < 0.005               # homogeneous -> pooled
    shr2, kap2, _ = CAL.eb_beta_binomial([20, 80, 50, 35], [100, 100, 100, 100])
    assert kap2 < 50 and max(shr2) - min(shr2) > 0.3                # heterogeneous -> little pooling
    s, tau2, m0 = CAL.eb_normal([0.01, -0.02, 0.0], [0.05, 0.05, 0.05])
    assert tau2 == 0 and max(s) - min(s) < 1e-12


def t_ev_curve():
    rng = np.random.default_rng(9)
    ev = rng.uniform(-0.02, 0.3, 8000)
    res = rng.choice([1, -1], 8000)
    u = core.units(res, -110)
    cv = CAL.fit_ev_curve(ev, u, np.zeros(8000))
    assert np.all(np.diff(cv['y']) >= -1e-12)
    null = 0.5 * (100 / 110) - 0.5
    assert max(abs(y - null) for y in cv['y']) < 0.03, cv['y']        # no skill -> the no-skill line
    p = 0.5 + ev * 0.4
    res2 = np.where(rng.random(8000) < p, 1, -1)
    cv2 = CAL.fit_ev_curve(ev, core.units(res2, -110), np.zeros(8000))
    assert cv2['y'][-1] > cv2['y'][0]                               # real skill survives the shrinkage


def t_reference_evaluate_synthetic():
    A = {'schema': 'cfb_decision_calibration_schema_v1', 'base_model_version': 'edgedesk_cfb_v2.1.0',
         'cover_calibration': {'map': {'method': 'identity'}}, 'market_shrinkage': {'w_model': 0.25, 'space': 'logit'},
         'push_table': {'0-2.5': 0.01, '2.5-3.5': 0.09, '3.5-6.5': 0.02, '6.5-7.5': 0.06, '7.5-13.5': 0.03, '13.5-99': 0.028},
         'ev_curve': {'x': [0, 0.1], 'y': [-0.045, -0.045]}}
    row = {'pure_margin': 7.0, 'sigma': 16.0, 't_df': 100, 'home_line': -3.0, 'price_home': -110, 'price_away': -110}
    o = REF.evaluate(row, A)
    assert o['side'] == 'HOME'
    pp = core.cover_prob_home(7.0, 16.0, 3.0, 100)
    near(o['pure_cover_prob'], pp, 1e-12)
    near(o['decision_cover_prob'], core.sigmoid(0.25 * core.logit(pp)), 1e-12)
    near(o['break_even_prob'], 110 / 210, 1e-12)
    near(o['probability_edge'], o['decision_cover_prob'] - 110 / 210, 1e-12)
    near(o['push_prob'], 0.09)
    near(o['decision_ev'], core.ev_with_push(o['decision_cover_prob'], 0.09, -110), 1e-12)
    live = REF.evaluate(dict(row, price_home=None, price_away=None), A)
    assert live['decision_ev'] is None and live['break_even_prob'] is None and live['probability_edge'] is None
    assert live['theoretical_ev'] is None and live['empirical_ev'] is None
    near(live['market_implied_prob'], 0.5)
    shaded = REF.evaluate(dict(row, price_home=-120, price_away=100), A)
    assert shaded['market_implied_prob'] > 0.5 and shaded['market_implied_basis'] == 'DEVIG_PROPORTIONAL'
    away = REF.evaluate(dict(row, pure_margin=-2.0), A)
    assert away['side'] == 'AWAY' and away['pure_cover_prob'] > 0.5


def t_pure_fields_never_market():
    from . import dataset as DS
    assert not set(DS.PURE_FIELDS) & set(DS.MARKET_FIELDS)
    assert not set(DS.PURE_FIELDS) & set(DS.OUTCOME_FIELDS)
    words = ('open', 'close', 'quote', 'price', 'clv', 'book', 'market', 'spread', 'gap', 'dispersion', 'total')
    for c in DS.PURE_FIELDS:
        assert not any(w in c for w in words), c
        assert 'line' not in c or c == 'pure_fair_home_line', c        # the fair line is -pure_margin, nothing else
    from .study import FOOT_FEATURES
    for c in FOOT_FEATURES:
        assert DS.LAYER[c] == 'pure', c
    # the production reliability formula reads no market column: scrambling every market column changes nothing
    P = {'reliability': {'sigma_lo': 15.3, 'sigma_hi': 18.5, 'caps': {'fcs': 50, 'no_games': 70, 'qb_unsettled': 75, 'qb_unknown': 65}}}
    X = pd.DataFrame({'sigma': [15.0, 16.0, 17.5, 19.0], 'fcs_game': [False, False, True, False], 'min_games': [0, 3, 5, 2],
                      'qb_unsettled_any': [0, 1, 0, 0], 'qb_missing_any': [0, 0, 0, 1], 'open_margin': [3, 7, -2, 10.5]})
    a = DS.reliability_prod(X, P)
    b = DS.reliability_prod(X.assign(open_margin=[-99, 99, 0, 1]), P)
    assert np.array_equal(a, b)


SYNTHETIC = [t_vig_removal, t_break_even, t_push, t_ev_with_push, t_distribution, t_maps_monotone_in_unit_interval,
             t_shrink_recovers_weight, t_walk_forward_refuses_future, t_holdout_never_reaches_a_fitter,
             t_holdout_static_guard, t_models_and_reference_agree, t_empirical_bayes, t_ev_curve,
             t_reference_evaluate_synthetic, t_pure_fields_never_market]


# ================================================================ data tests
def _dataset(filters=None):
    from . import dataset as DS
    return pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dataset.parquet'), filters=filters)


def t_baseline_unchanged():
    from .baseline import write_or_verify
    write_or_verify(verify_only=True)


def t_dataset_pure_equals_stage7():
    D = _dataset(filters=[('window', 'in', ['dev', 'live'])])
    S7 = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'),
                         columns=['game_id', 'ens_pred', 'sigma', 'p_home_raw', 'ens_sd', 'pc_home_raw', 'open_margin'])
    S7 = S7.add_prefix('s7_').rename(columns={'s7_game_id': 'game_id'})
    j = D.merge(S7, on='game_id', how='left')
    for a, b in (('pure_margin', 's7_ens_pred'), ('sigma', 's7_sigma'), ('pure_win_prob_home', 's7_p_home_raw'), ('ens_sd', 's7_ens_sd')):
        x, y = j[a].values, j[b].values
        ok = np.isfinite(x) | np.isfinite(y)
        assert np.array_equal(np.isfinite(x[ok]), np.isfinite(y[ok])) and np.nanmax(np.abs(x[ok] - y[ok])) == 0, a
    m = j.quote_role.eq('CONSENSUS_OPEN') & j.s7_pc_home_raw.notna()
    assert m.sum() > 3000
    assert np.max(np.abs(j.loc[m, 'pure_cover_prob_home'] - j.loc[m, 's7_pc_home_raw'])) < 1e-12


def t_dataset_point_in_time_and_prices():
    D = _dataset(filters=[('window', 'in', ['dev', 'live'])])
    assert (pd.to_datetime(D.decision_ts, utc=True) >= D.prediction_ts).all()
    live = D[D.window.eq('live')]
    assert not live.price_source.eq(core.PRICE_SOURCE_ASSUMED).any(), 'a live price was assumed'
    unpriced = live[~live.price_source.isin([core.PRICE_SOURCE_CAPTURED, core.PRICE_SOURCE_ONE_SIDED])]
    assert unpriced.price_side_american.isna().all() and unpriced.theoretical_ev.isna().all() and unpriced.break_even_prob.isna().all()
    assert live.units_assumed_110.isna().all()
    priced = live[live.price_source.eq(core.PRICE_SOURCE_CAPTURED)]
    if len(priced):
        assert priced.quote_role.eq('LIVE_BOOK_QUOTE').all() and priced.break_even_prob.notna().all()
        assert np.allclose(priced.break_even_prob, core.break_even(priced.price_side_american.values))
        assert (priced.quote_age_min >= 0).all()
    lq = live[live.quote_role.eq('LIVE_BOOK_QUOTE')]
    assert len(lq) and (lq.quote_observed_at < lq.kickoff_ts).all()
    hist = D[D.window.eq('dev') & D.quote_role.isin(['CONSENSUS_OPEN', 'BOOK_OPEN'])]
    assert hist.price_source.eq(core.PRICE_SOURCE_ASSUMED).all() and hist.price_side_american.eq(-110).all()
    assert not D[D.season.eq(C.COVID_SEASON)].quote_role.ne('NONE').any()        # 2020: no openers, no quotes
    assert D.decision_row_id.is_unique
    # CLV orientation: a HOME side whose close moved toward home has positive CLV
    h = D[D.side.eq('HOME') & D.clv_pts.notna()]
    assert np.allclose(h.clv_pts, h.close_line_margin - h.quote_line_margin)
    a = D[D.side.eq('AWAY') & D.clv_pts.notna()]
    assert np.allclose(a.clv_pts, a.quote_line_margin - a.close_line_margin)
    # pure side agrees with the gap; pure probability of the side >= 0.5
    s = D[D.pure_cover_prob.notna()]
    assert (s.pure_cover_prob >= 0.5 - 1e-12).all()
    assert ((s.gap_home_pts > 0) == s.side.eq('HOME')).all()


def t_dataset_fcs_excluded_from_pricing():
    D = _dataset(filters=[('window', '==', 'dev')])
    assert (D.fcs_game.astype(bool) == D.pricing_scope.eq('FCS_EXCLUDED')).all()
    W = pd.read_parquet(os.path.join(C.OUT, 'decision', 'decision_dev_walkforward.parquet'))
    assert set(W.game_id) <= set(D[D.pricing_scope.eq('FBS_FBS')].game_id)
    assert set(W.season) <= set(C.DEV_SEASONS)


def t_walkforward_frame_reproduces():
    """The walk-forward decision probability of season S equals the shrink fit on seasons < S."""
    from . import study as ST
    D = ST.load_dev()
    _, Wpop, _, _ = ST.populations(D)
    W = pd.read_parquet(os.path.join(C.OUT, 'decision', 'decision_dev_walkforward.parquet'))
    for S in (2019, 2022):
        tr = Wpop[(Wpop.season < S) & Wpop.ats_win.notna()]
        CAL.assert_past_only(CAL.assert_fit_rows(tr), S)
        w = CAL.fit_shrink(tr.pure_cover_prob.values, tr.ats_win.values)['w']
        cur = W[W.season == S]
        near(float(cur.w_used.iloc[0]), w, 1e-9)
        assert np.max(np.abs(cur.p_dec.values - CAL.shrink_np(cur.pure_cover_prob.values, 0.5, w))) < 1e-12


def _artifact():
    from .freeze import CAL_JSON
    return json.load(open(CAL_JSON))


def t_artifact_schema_and_fit_window():
    from . import DECISION_SCHEMA, BASE_MODEL_VERSION
    A = _artifact()
    assert A['schema'] == DECISION_SCHEMA and A['base_model_version'] == BASE_MODEL_VERSION
    for k in ('version', 'created_at', 'fit_seasons', 'cover_calibration', 'market_shrinkage', 'push_table', 'ev_curve',
              'p_positive_clv', 'clv_magnitude', 'bet_confidence', 'football_confidence', 'reliability_scale',
              'market_confidence', 'features'):
        assert k in A, k
    for k, v in A['fit_seasons'].items():
        if isinstance(v, list):
            assert not set(v) & (set(C.HOLDOUT_SEASONS) | {C.LIVE_SEASON}), k
    grid = np.linspace(0.001, 0.999, 500)
    v = np.array([REF.calibrate(A['cover_calibration'], x, {}) for x in grid])
    assert np.all(v > 0) and np.all(v < 1) and np.all(np.diff(v) >= -1e-12)
    w = A['market_shrinkage']['w_model']
    assert 0 <= w <= 1
    d = np.array([REF.market_shrink(x, 0.5, A['market_shrinkage'], {})[0] for x in v])
    assert np.all(np.diff(d) >= -1e-12) and np.all(np.abs(d + d[::-1] - 1) < 1e-9)     # monotone, side-symmetric
    for key in ('ev_curve', 'ev_curve_decision'):
        assert np.all(np.diff(A[key]['x']) > 0) and np.all(np.diff(A[key]['y']) >= -1e-12), key
    rs = A['reliability_scale']['expected_abs_error']
    assert np.all(np.diff(rs['x']) > 0) and np.all(np.diff(rs['y']) <= 1e-12)
    for m in ('p_positive_clv', 'clv_magnitude', 'bet_confidence', 'football_confidence', 'market_confidence'):
        spec = A[m]
        assert spec['type'] in ('logistic', 'linear') and set(spec['coef']) <= set(A['features']), m
        assert set(spec['coef']) <= set(spec['fill']), m
    from . import dataset as DS
    for c in A['football_confidence']['coef']:
        assert DS.LAYER[c] == 'pure', 'a market column entered the football confidence: %s' % c


def t_parity_fixture_reproduces():
    from .freeze import FIXTURE, CAL_JSON
    from .baseline import sha256_file
    F = json.load(open(FIXTURE))
    A = _artifact()
    assert F['artifact_sha256'] == sha256_file(CAL_JSON), 'fixture was generated from a different artifact'
    assert 30 <= len(F['cases']) <= 60
    kinds = {c['id'].split('_')[0] for c in F['cases']}
    assert kinds == {'dev', 'live', 'syn'}, kinds
    for c in F['cases']:
        inp = {k: v for k, v in c['inputs'].items() if k not in ('features', 'side', 'pure_cover_prob', 'market_implied_prob')}
        o = REF.evaluate(inp, A)
        o.pop('features')
        for k, v in c['expected'].items():
            if k == 'decision_cover_probability':
                continue
            got = o.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                assert got is not None and abs(got - v) <= 1e-9, (c['id'], k, got, v)
            else:
                assert got == v, (c['id'], k, got, v)
        # the JS test's reduced path: decisionProbability(pure_cover_prob, market_implied_prob, features)
        p = REF.calibrate(A['cover_calibration'], c['inputs']['pure_cover_prob'], c['inputs']['features'])
        d, _ = REF.market_shrink(p, c['inputs']['market_implied_prob'], A['market_shrinkage'], c['inputs']['features'])
        near(d, c['expected']['decision_cover_prob'], 1e-12)
        if c['id'].startswith('live'):
            priced = c['inputs']['price_home'] is not None and c['inputs']['price_away'] is not None
            assert (c['expected']['decision_ev'] is not None) == priced, c['id']      # EV only from a captured price
            assert (c['expected']['probability_edge'] is not None) == priced, c['id']


def t_manifest_hashes():
    from .freeze import ART_DIR
    from .baseline import sha256_file, MANIFEST as BM
    M = json.load(open(os.path.join(ART_DIR, 'MANIFEST.json')))
    for fn, h in M['files'].items():
        assert sha256_file(os.path.normpath(os.path.join(ART_DIR, fn))) == h, fn
    assert M['baseline_manifest_sha256'] == sha256_file(BM)
    assert M['holdout_scored'] is False
    here = os.path.dirname(os.path.abspath(__file__))
    for fn, h in M['fit_code_sha256'].items():                 # the artifact was frozen by the code in this directory
        assert sha256_file(os.path.join(here, fn)) == h, 'fitting code changed since the freeze: %s (re-run v2.decision.study)' % fn


DATA = [t_baseline_unchanged, t_dataset_pure_equals_stage7, t_dataset_point_in_time_and_prices,
        t_dataset_fcs_excluded_from_pricing, t_walkforward_frame_reproduces, t_artifact_schema_and_fit_window,
        t_parity_fixture_reproduces, t_manifest_hashes]


def main():
    fast = '--fast' in sys.argv
    for t in SYNTHETIC:
        check(t.__name__, t)
    if not fast:
        for t in DATA:
            check(t.__name__, t)
    for n, e in FAIL:
        print('FAIL | %s | %s' % (n, e))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (len(PASS), len(FAIL)))
    sys.exit(0 if not FAIL else 1)


if __name__ == '__main__':
    main()
