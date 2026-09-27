"""Leakage, sign-convention and determinism tests for the V2 research pipeline.

    python3 -m v2.tests_leakage            (exit 0 = green)

Most tests are SYNTHETIC (they build tiny worlds with known answers) so they
run anywhere with no data. Tests marked [artifact] additionally check the
real built tables when CFB_V2_OUT points at a pipeline output.

Each injection test deliberately tries to leak something into training — a
closing line, a final score, a future game, post-kickoff quarterback
knowledge — and PASSES ONLY IF the leak is refused or has zero effect.
"""
import os
import sys
import traceback

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import contract as K
from . import ratings as R
from . import models as MD
from . import walkforward as WF
from . import plays as PL
from . import qb as QB

RESULTS = []


def test(fn):
    RESULTS.append(fn)
    return fn


def raises(exc, f, *a, **k):
    try:
        f(*a, **k)
    except exc:
        return True
    return False


# ------------------------------------------------------------- layers
@test
def layer_contract_refuses_market_target_evaluation():
    for c in ('close_margin', 'open_margin', 'spread_close', 'margin', 'home_points', 'total_pts',
              'clv_pts', 'bet_result', 'line', 'gap_open', 'pc_home_cal', 'ev', 'total_close'):
        assert raises(K.LayerViolation, K.assert_pure, ['edge_epa', c]), c
    assert K.assert_pure(['edge_epa', 'h_epa__off', 'elo_diff', 'home_field', 'qb_delta_edge'])


@test
def unknown_columns_are_refused():
    assert raises(K.LayerViolation, K.assert_pure, ['some_new_column'])


@test
def inject_closing_line_into_ridge_is_refused():
    fam = MD.FAMILIES.copy()
    MD.FAMILIES['base'] = MD.FAMILIES['base'] + ['close_margin']
    try:
        cols = MD.features_for(['base'])
        assert raises(K.LayerViolation, K.assert_pure, cols)
        X = pd.DataFrame({c: np.arange(50.0) for c in cols})
        assert raises(K.LayerViolation, MD.ModelC(['base']).fit, X, np.arange(50.0))
    finally:
        MD.FAMILIES.clear(); MD.FAMILIES.update(fam)


@test
def inject_final_outcome_into_gbm_is_refused():
    fam = MD.FAMILIES.copy()
    MD.FAMILIES['context'] = MD.FAMILIES['context'] + ['home_points']
    try:
        assert raises(K.LayerViolation, K.assert_pure, MD.features_for(['context']))
        cols = MD.features_for(['context'])
        X = pd.DataFrame({c: np.arange(50.0) for c in cols})
        assert raises(K.LayerViolation, MD.ModelD(['context']).fit, X, np.arange(50.0))
    finally:
        MD.FAMILIES.clear(); MD.FAMILIES.update(fam)


# Phase-2 injection list: every kind of hindsight the brief names, offered to
# the models under names that LOOK like legitimate features. Each must be
# refused by the layer guard inside fit() (the contract is an exact allowlist).
INJECTIONS = {
    'final score': ['home_points', 'margin', 'x_final_score', 'match_final_margin'],
    'closing spread': ['close_margin', 'spread_close', 'edge_closing_line'],
    'future opponent rating': ['opp_rating_final', 'h_epa__final', 'edge_epa_season_final'],
    'future season average': ['epa_season_final', 'lg_epa__final', 'form_epa_fullseason'],
    'future injury status': ['qb_status_final', 'h_qb_status_final', 'injury_status_postgame'],
    'postgame EPA': ['edge_epa_postgame', 'h_epa__postgame', 'epa_game'],
    'postseason ranking': ['edge_postseason_rank', 'ap_rank_final', 'elo_postgame'],
}


@test
def phase2_injections_are_refused_by_every_model():
    X = pd.DataFrame({c: np.arange(60.0) for c in MD.features_for(['base'])})
    y = np.arange(60.0)
    for kind, cols in INJECTIONS.items():
        for c in cols:
            assert raises(K.LayerViolation, K.assert_pure, ['edge_epa', c]), (kind, c)
            fam = MD.FAMILIES.copy()
            MD.FAMILIES['base'] = MD.FAMILIES['base'] + [c]
            try:
                Xi = X.assign(**{c: np.arange(60.0)})
                assert raises(K.LayerViolation, MD.ModelC(['base']).fit, Xi, y), (kind, c, 'ridge')
                assert raises(K.LayerViolation, MD.ModelD(['base']).fit, Xi, y), (kind, c, 'gbm')
            finally:
                MD.FAMILIES.clear(); MD.FAMILIES.update(fam)


@test
def every_model_feature_is_pure():
    K.assert_pure(MD.features_for(MD.ABLATION_ORDER, drop=()))
    K.assert_pure(MD.ModelA.COLS + MD.ModelB.COLS + MD.ModelE.COLS + MD.TotalE.COLS)


@test
def red_team_candidate_spec_ignores_the_production_drop_list():
    # the red team's Spec(fam_C, fam_D) IS candidate 001: a later production
    # decision (config.DROPPED_FEATURES) must not silently change it
    from . import rt_walkforward as RT
    full = set(MD.features_for(MD.ABLATION_ORDER, drop=()))
    spec = RT.Spec(MD.ABLATION_ORDER, MD.ABLATION_ORDER)
    assert set(spec.cols('C')) == full and set(spec.cols('D')) == full
    assert not set(MD.features_for(MD.ABLATION_ORDER)) & set(C.DROPPED_FEATURES)
    hard = RT.Spec(MD.ABLATION_ORDER, MD.ABLATION_ORDER, drop=C.DROPPED_FEATURES)
    assert set(hard.cols('C')) == set(MD.features_for(MD.ABLATION_ORDER))


@test
def pbp_never_reads_market_or_wp_columns():
    assert not (set(PL.PBP_COLS) & set(PL.FORBIDDEN_PBP_COLUMNS))


@test
def tuning_refuses_holdout_and_live():
    assert raises(AssertionError, C.assert_dev_only, [2023, 2024])
    assert raises(AssertionError, C.assert_dev_only, [2026])
    C.assert_dev_only(list(C.DEV_SEASONS))


@test
def walk_forward_refuses_same_or_future_season():
    assert raises(AssertionError, WF.assert_past_only, [2019, 2020], 2020)
    assert raises(AssertionError, WF.assert_past_only, [2021], 2020)
    WF.assert_past_only([2018, 2019], 2020)


# ----------------------------------------------------- sign conventions
@test
def book_to_margin_is_a_negation():
    assert common.book_home_line_to_margin(-7) == 7
    assert common.book_home_line_to_margin(3.5) == -3.5
    assert common.margin_to_book_home_line(10) == -10
    assert common.book_home_line_to_margin(None) is None
    assert common.book_home_line_to_margin(float('nan')) is None


@test
def home_cover_semantics():
    # home -7 (margin +7): home wins by 10 covers, by 7 pushes, by 3 fails
    m = common.book_home_line_to_margin(-7)
    assert common.home_cover_result(10, m) == 1
    assert common.home_cover_result(7, m) == 0
    assert common.home_cover_result(3, m) == -1
    # away favoured by 3 (home +3 -> margin -3): home loses by 2 = home covers
    assert common.home_cover_result(-2, common.book_home_line_to_margin(3)) == 1


# --------------------------------------------------------- garbage time
@test
def garbage_time_boundaries():
    per = np.array([1, 2, 2, 3, 3, 4, 4, 5])
    sd = np.array([50, 38, 39, 28, 29, 22, 23, 60])
    g = common.garbage_mask(per, sd)
    assert list(g) == [False, False, True, False, True, False, True, False]


# -------------------------------------------------------- freeze times
@test
def prediction_timestamp_is_tuesday_before_kickoff():
    from datetime import datetime, timezone
    sat = datetime(2024, 9, 7, 19, 30, tzinfo=timezone.utc)
    t = common.prediction_ts_for_kickoff(sat)
    assert t.weekday() == 1 and t.hour == 12 and t < sat and (sat - t).days < 7
    tue_early = datetime(2024, 9, 3, 10, 0, tzinfo=timezone.utc)
    t2 = common.prediction_ts_for_kickoff(tue_early)
    assert t2 < tue_early and (tue_early - t2).days == 6


# --------------------------------------------------- opponent adjustment
def _world(seed=0, noise=0.0):
    rng = np.random.default_rng(seed)
    teams = list(range(1, 9))
    off = {t: v for t, v in zip(teams, rng.normal(0, 0.15, 8))}
    de = {t: v for t, v in zip(teams, rng.normal(0, 0.15, 8))}
    rows, k = [], 0
    base = pd.Timestamp('2024-09-01', tz='UTC')
    for i, a in enumerate(teams):
        for b in teams:
            if a == b:
                continue
            k += 1
            H = 1.0 if (a + b + k) % 2 else -1.0
            y = 0.05 + off[a] + de[b] + 0.02 * H + rng.normal(0, noise)
            rows.append({'team_id': a, 'opp_id': b, 'H': H, 'num': y * 60, 'den': 60.0,
                         'kickoff_ts': base + pd.Timedelta(days=k % 50)})
    return pd.DataFrame(rows), off, de


def _flat_prior(teams, v=10.0):
    return {'o': {}, 'd': {}, 'tau2_o': {t: v for t in teams}, 'tau2_d': {t: v for t in teams},
            'tau2_default_o': v, 'tau2_default_d': v, 'h': (0.0, 10.0)}


@test
def joint_opponent_adjustment_recovers_truth():
    tg, off, de = _world()
    fit, _ = R.fit_metric(tg, 'x', ('num', 'den', 'rate'), (1.0, 1e-6), _flat_prior(off.keys()))
    o = fit.off - fit.off.mean()
    true = pd.Series(off) - np.mean(list(off.values()))
    assert np.max(np.abs(o.values - true.reindex(o.index).values)) < 1e-3


@test
def same_raw_number_counts_more_against_a_good_defence():
    # A and B both post 0.25 EPA/play; A did it against the best defence, B the worst
    base = pd.Timestamp('2024-09-01', tz='UTC')
    rows = []
    # calibrate defences with games against a neutral pool
    for d, allowed in ((10, -0.20), (11, 0.30)):
        for p in (20, 21, 22, 23):
            rows.append({'team_id': p, 'opp_id': d, 'H': 0.0, 'num': allowed * 60, 'den': 60.0, 'kickoff_ts': base})
    rows.append({'team_id': 1, 'opp_id': 10, 'H': 0.0, 'num': 0.25 * 60, 'den': 60.0, 'kickoff_ts': base})
    rows.append({'team_id': 2, 'opp_id': 11, 'H': 0.0, 'num': 0.25 * 60, 'den': 60.0, 'kickoff_ts': base})
    tg = pd.DataFrame(rows)
    teams = set(tg.team_id) | set(tg.opp_id)
    fit, _ = R.fit_metric(tg, 'x', ('num', 'den', 'rate'), (1.0, 1e-4), _flat_prior(teams, 1.0))
    assert fit.loc[1, 'off'] > fit.loc[2, 'off'] + 0.2


@test
def future_games_cannot_move_a_frozen_rating():
    tg, off, de = _world(noise=0.05)
    T = tg.kickoff_ts.sort_values().iloc[len(tg) // 2]
    past = tg[tg.kickoff_ts < T]
    f1, _ = R.fit_metric(past, 'x', ('num', 'den', 'rate'), (1.0, 1e-4), _flat_prior(off.keys()))
    poisoned = tg.copy()
    poisoned.loc[poisoned.kickoff_ts >= T, 'num'] = 999.0      # absurd future results
    f2, _ = R.fit_metric(poisoned[poisoned.kickoff_ts < T], 'x', ('num', 'den', 'rate'), (1.0, 1e-4),
                         _flat_prior(off.keys()))
    assert np.allclose(f1.off.values, f2.off.values) and np.allclose(f1['def'].values, f2['def'].values)


@test
def shrinkage_by_sample_size():
    tg, off, de = _world(noise=0.05)
    pri = _flat_prior(off.keys(), 0.001)
    one = tg.groupby('team_id').head(1)
    f_small, _ = R.fit_metric(one, 'x', ('num', 'den', 'rate'), (1.0, 1e-4), pri)
    f_big, _ = R.fit_metric(tg, 'x', ('num', 'den', 'rate'), (1.0, 1e-4), pri)
    assert f_small.off.abs().mean() < f_big.off.abs().mean()


# ---------------------------------------------------------------- QB
@test
def qb_features_ignore_post_kickoff_quarterback_knowledge():
    """A QB who first plays AFTER the freeze must not be the expected starter."""
    base = pd.Timestamp('2025-09-01', tz='UTC')
    q = pd.DataFrame([
        dict(game_id=1, team_id=5, qb_id=100, db=30, db_ng=30, epa_db_sum=3.0, starter=True,
             first_play=1, g_season=2025, kickoff_ts=base, opp_id=9, H=1),
        dict(game_id=2, team_id=5, qb_id=200, db=30, db_ng=30, epa_db_sum=9.0, starter=True,
             first_play=1, g_season=2025, kickoff_ts=base + pd.Timedelta(days=7), opp_id=9, H=1)])
    T = base + pd.Timedelta(days=3)
    cur = QB.current_season_adjust(q[q.kickoff_ts < T], pd.Series(dtype=float), 0.0)
    assert set(cur.qb_id) == {100}


# --------------------------------------------------------- determinism
@test
def gbm_is_deterministic():
    rng = np.random.default_rng(1)
    n = 400
    X = pd.DataFrame({c: rng.normal(size=n) for c in MD.features_for(['base', 'adj_eff'])})
    y = X['edge_epa'].values * 10 + rng.normal(size=n)
    p = dict(C.GBM_PARAMS); p['n_estimators'] = 50
    a = MD.ModelD(['base', 'adj_eff'], p).fit(X, y).predict(X)
    b = MD.ModelD(['base', 'adj_eff'], p).fit(X, y).predict(X)
    assert np.array_equal(a, b)


@test
def stacking_weights_are_nonnegative_and_sum_to_one():
    rng = np.random.default_rng(2)
    y = rng.normal(size=500) * 14
    P = np.column_stack([y + rng.normal(size=500) * s for s in (8, 10, 30, 12, 9)])
    w = WF.stack_weights(P, y)
    assert np.all(w >= -1e-9) and abs(w.sum() - 1) < 1e-6 and w[2] < 0.1


# ------------------------------------------------------- immutability
@test
def frozen_snapshots_are_write_once():
    import tempfile, json as _j
    from . import predict_live as PLV
    base = tempfile.mkdtemp()
    row = {'game_id': 7, 'prediction_ts': '2026-09-29T12:00:00Z', 'kickoff': '2026-10-03T19:30:00Z',
           'ens_pred': 3.5, 'sigma': 15.0}
    now = pd.Timestamp('2026-09-29T13:00:00Z')
    log1 = PLV.freeze([row], 2026, now, 'v', base=base)
    assert log1['frozen_new'] == 1
    f = os.path.join(base, '2026', os.listdir(os.path.join(base, '2026'))[0])
    first = open(f).read()
    changed = dict(row, ens_pred=9.9)                     # a later run disagrees
    log2 = PLV.freeze([changed], 2026, now + pd.Timedelta(hours=20), 'v', base=base)
    assert open(f).read() == first, 'a frozen snapshot was overwritten'
    assert log2['refused_overwrites'] == [{'game_id': 7, 'prediction_ts': '2026-09-29T12:00:00Z'}]
    late = dict(row, game_id=8)                          # a game first seen after its freeze passed
    PLV.freeze([row, late], 2026, now + pd.Timedelta(hours=30), 'v', base=base)
    assert [x['row']['game_id'] for x in _j.load(open(f))['rows']] == [7], 'a late game was back-dated'
    # after kickoff nothing is frozen
    log4 = PLV.freeze([dict(row, game_id=9)], 2026, pd.Timestamp('2026-10-04T00:00:00Z'), 'v',
                      base=tempfile.mkdtemp())
    assert log4['frozen_new'] == 0
    # tampering is detectable by the stored hash
    d = _j.load(open(f)); d['rows'][0]['row']['ens_pred'] = 1.0
    assert PLV.canonical_hash(d['rows'][0]['row']) != d['rows'][0]['hash']


@test
def pregame_reports_are_recorded_beside_the_pure_projection():
    # the shadow capture of the board's availability / QB evidence is data for
    # a future validation: it never enters the pure projection or its hash
    from . import predict_live as PLV
    row = {'game_id': 7, 'prediction_ts': '2026-09-29T12:00:00Z', 'kickoff': '2026-10-03T19:30:00Z',
           'ens_pred': 3.5, 'sigma': 15.0}
    with_reports = dict(row, shadow={'pregame_reports': {'reports': [{'field': 'availability', 'side': 'home'}]}})
    assert PLV.canonical_hash(PLV.pure_part(with_reports)) == PLV.canonical_hash(PLV.pure_part(row))
    for g in PLV.pregame_reports().values():
        assert {r['field'] for r in g['reports']} <= set(PLV.REPORT_FIELDS)
        assert all(len(r['detail']) <= 120 for r in g['reports'])


# ------------------------------------------------------------ artifacts
def _art(p):
    f = common.out_path(*p)
    return f if os.path.exists(f) else None


@test
def artifact_games_unique_and_market_sign():
    f = _art(('stage2', 'games.parquet'))
    if not f:
        return 'skipped (no artifact)'
    G = pd.read_parquet(f)
    assert G.game_id.is_unique
    M = pd.read_parquet(_art(('stage2', 'market.parquet')))
    j = G.merge(M, on='game_id')
    j = j[j.status.eq('FINAL') & j.spread_close.notna() & ~j.fcs_game]
    assert j.spread_close.corr(j.margin) > 0.6, 'market converted with the wrong sign'
    assert (G.prediction_ts < G.kickoff_ts).all()


@test
def artifact_ratings_count_only_prior_games():
    f = _art(('stage3', 'ratings_2019.parquet'))
    if not f:
        return 'skipped (no artifact)'
    R_ = pd.read_parquet(f, columns=['prediction_ts', 'team_id', 'metric', 'n_obs_off'])
    R_ = R_[R_.metric.eq('epa')]
    TG = pd.read_parquet(common.out_path('stage1', 'team_game_2019.parquet'))
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    TG = TG.merge(G[['game_id', 'kickoff_ts', 'status']], on='game_id')
    TG = TG[TG.status.eq('FINAL')]
    for T in sorted(R_.prediction_ts.unique())[3:8]:
        r = R_[R_.prediction_ts.eq(T)].set_index('team_id').n_obs_off
        truth = TG[TG.kickoff_ts < T].groupby('team_id').size()
        common_ = truth.index.intersection(r.index)
        assert (r.reindex(common_).values == truth.reindex(common_).values).all()


@test
def artifact_snapshots_have_no_market_columns():
    f = _art(('stage5', 'cfb_model_training_snapshots.parquet'))
    if not f:
        return 'skipped (no artifact)'
    import pyarrow.parquet as pq
    cols = pq.ParquetFile(f).schema_arrow.names
    bad = [c for c in cols if K.layer_of(c) in ('market', 'evaluation')]
    assert not bad, bad


@test
def artifact_live_path_reproduces_backtest():
    f = _art(('stage7', 'backtest_predictions.parquet'))
    cur = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'current.json')
    if not f or not os.path.exists(cur):
        return 'skipped (no artifact)'
    import json as _j
    cj = _j.load(open(cur))
    L = pd.DataFrame(cj['rows'])
    if L.empty:
        return 'skipped (no upcoming rows)'
    # the same model on the same data rules, or the comparison means nothing (audit F-02: rows are
    # compared under the version that produced them)
    rp = _art(('report', 'backtest.json'))
    built = _j.load(open(rp)).get('model_version') if rp else None
    if built and cj.get('model_version') != built:
        return 'skipped (current.json is %s, this build is %s)' % (cj.get('model_version'), built)
    rules = {(x.get('build') or {}).get('finality_rule') for x in cj['rows']} - {None}
    stamp = common.build_stamp() or {}
    if rules and rules != {((stamp.get('stages') or {}).get('stage2') or {}).get('finality_rule')}:
        return 'skipped (current.json was built under finality rule %s)' % sorted(rules)
    B = pd.read_parquet(f, columns=['game_id', 'season', 'ens_pred', 'sigma'])
    j = L.merge(B[B.season.eq(int(L.season.iloc[0]))], on='game_id', suffixes=('_l', '_b'))
    if j.empty:
        return 'skipped (backtest predates these games)'
    assert (j.ens_pred_l - j.ens_pred_b).abs().max() < 0.01, 'live artifacts diverge from the backtest models'
    assert (j.sigma_l - j.sigma_b).abs().max() < 0.01


# ---------------------------------------------------- outcome scan (F-15)
# The layer contract checks column NAMES: an outcome disguised under an allowed
# feature name passes it (audit F-15: the margin under an allowed name took MAE from
# 12.55 to 7.54). This scan checks CONTENT: every model input against the result
# against the close (margin - close) and against the margin itself. DECLARED
# thresholds (the audit's, fixed before the v2.1.1 rebuild was scanned):
#   * |corr(input, margin - close)| must not exceed max(0.08, 4 standard errors
#     1/sqrt(n)): on v2.1.0 the largest is 0.052 (edge_stuff, n 8,668); the audit's
#     disguised outcome scores 0.73. The 4-SE floor keeps a small live-season sample
#     (n ~200: floor 0.28) from failing on noise.
#   * with n >= 2,000, no single input's r^2 with the margin may exceed the close's
#     r^2 (v2.1.0: 0.402 vs 0.446): no pregame input should know the result better
#     than the market's final number. Below 2,000 games this check has no power and
#     is not applied.
#   * at least 150 scored games, else the scan reports itself skipped.
OUTCOME_SCAN_MAX_ABS_CORR_ATS_CLOSE = 0.08
OUTCOME_SCAN_SE_MULT = 4.0
OUTCOME_SCAN_R2_MIN_N = 2000
OUTCOME_SCAN_MIN_N = 150


def outcome_scan(w, cols):
    """w: FBS-vs-FBS FINAL rows with the model inputs `cols`, `margin` and `close_margin`.
    Returns the per-input table and the violations of the declared thresholds."""
    ats = w.margin - w.close_margin
    close_r2 = float(np.corrcoef(w.close_margin, w.margin)[0, 1] ** 2)
    rows, bad = [], []
    for c in cols:
        x = w[c].astype(float)
        ok = x.notna() & ats.notna()
        n = int(ok.sum())
        if n < OUTCOME_SCAN_MIN_N or x[ok].std() == 0:
            continue
        ra = float(np.corrcoef(x[ok], ats[ok])[0, 1])
        rm = float(np.corrcoef(x[ok], w.margin[ok])[0, 1])
        thr = max(OUTCOME_SCAN_MAX_ABS_CORR_ATS_CLOSE, OUTCOME_SCAN_SE_MULT / np.sqrt(n))
        rows.append({'feature': c, 'n': n, 'corr_ats_close': ra, 'r2_margin': rm * rm, 'threshold': thr})
        if abs(ra) > thr:
            bad.append('%s: corr with margin - close %.3f > %.3f (n %d)' % (c, ra, thr, n))
        if len(w) >= OUTCOME_SCAN_R2_MIN_N and rm * rm > close_r2:
            bad.append('%s: r2 with the margin %.3f > the close\'s %.3f' % (c, rm * rm, close_r2))
    return {'n_games': int(len(w)), 'close_r2': close_r2, 'table': rows, 'violations': bad}


def _scan_inputs():
    """The model inputs (C and D) of the version being built, as the audit scanned them: its
    artifact when it exists (a challenger is scanned before its export), else the production
    artifact's."""
    import json as _j
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'artifacts')
    f = os.path.join(d, C.MODEL_VERSION, 'models.json')
    if not os.path.exists(f):
        f = os.path.join(d, C.PRODUCTION_MODEL_VERSION, 'models.json')
    A = _j.load(open(f))
    return sorted(set(A['submodels']['C_ridge']['cols']) | set(A['submodels']['D_gbm']['cols']))


def _scan_frame():
    """Scored FBS-vs-FBS rows of the build's stage-5 table with their close (None if absent)."""
    fx = _art(('stage5', 'cfb_model_training_snapshots.parquet'))
    fm = _art(('stage5', 'cfb_market_training_snapshots.parquet'))
    if not fx or not fm:
        return None
    X = pd.read_parquet(fx)
    M = pd.read_parquet(fm, columns=['game_id', 'close_margin'])
    w = MD.add_derived(X).merge(M, on='game_id', how='inner')
    return w[w.season.ge(C.FIRST_OOF_SEASON) & w.status.eq('FINAL') & ~w.fcs_game.astype(bool)
             & w.margin.notna() & w.close_margin.notna()].copy()


@test
def outcome_scan_catches_a_disguised_outcome():
    """Power, synthetic: an outcome under an allowed name is caught; honest inputs pass."""
    rng = np.random.default_rng(C.SEED)
    n = 3000
    truth = rng.normal(0, 15, n)
    margin = truth + rng.normal(0, 12, n)
    close = truth + rng.normal(0, 3, n)
    w = pd.DataFrame({'margin': margin, 'close_margin': close,
                      'edge_epa': truth / 15 + rng.normal(0, 1.2, n),              # an honest, weaker signal
                      'edge_ppd': rng.normal(0, 1, n)})
    assert not outcome_scan(w, ['edge_epa', 'edge_ppd'])['violations']
    w['edge_sr'] = (margin - close) + rng.normal(0, 8, n)                            # the result, disguised
    v = outcome_scan(w, ['edge_epa', 'edge_ppd', 'edge_sr'])['violations']
    assert v and all(x.startswith('edge_sr') for x in v), v
    w['edge_sr'] = margin + rng.normal(0, 1, n)                                      # the margin itself
    assert any('r2 with the margin' in x for x in outcome_scan(w, ['edge_sr'])['violations'])


@test
def artifact_outcome_scan_every_model_input():
    """[artifact] Every model input of the built stage-5 table passes the declared scan;
    the same table with the margin disguised as an input fails it (the scan has power
    on real data)."""
    w = _scan_frame()
    if w is None:
        return 'skipped (no artifact)'
    if len(w) < OUTCOME_SCAN_MIN_N:
        return 'skipped (%d scored games with a close < %d)' % (len(w), OUTCOME_SCAN_MIN_N)
    cols = [c for c in _scan_inputs() if c in w.columns]
    r = outcome_scan(w, cols)
    assert not r['violations'], r['violations']
    top = max(r['table'], key=lambda t: abs(t['corr_ats_close']))
    inj = w.copy()
    inj['edge_epa'] = inj.margin
    assert any(x.startswith('edge_epa') for x in outcome_scan(inj, cols)['violations']), 'the scan has no power'
    return '%d inputs, %d games, max |corr(x, margin-close)| %.3f (%s), max r2 %.3f vs close %.3f' % (
        len(r['table']), r['n_games'], abs(top['corr_ats_close']), top['feature'],
        max(t['r2_margin'] for t in r['table']), r['close_r2'])


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
