"""Tests for the market-intelligence research package.

    python3 -m v2.market_intel.tests_market --fast     synthetic only (no data, seconds)
    python3 -m v2.market_intel.tests_market            + [artifact] checks on the built outputs

Synthetic tests build tiny worlds with known answers: sign conventions, the
key-number distribution (mass, ties, locality, the fit), half-point and
price-vs-point math, implied margins, consensus rules, the challenger weight,
the layer contract (a market column can never be a pure input), the
point-in-time decision masks (perturbing the close changes no decision), the
walk-forward cap and the holdout-once guard.
"""
import argparse
import json
import os
import sys
import tempfile
import traceback

import numpy as np
import pandas as pd

from .. import contract as K
from . import books as BK
from . import challenger as CH
from . import data as D
from . import keynumbers as KN
from . import replay as RP

TESTS = []


def test(fn):
    TESTS.append((fn, getattr(fn, 'artifact', False)))
    return fn


def artifact(fn):
    fn.artifact = True
    return test(fn)


def near(a, b, tol=1e-9):
    return abs(float(a) - float(b)) <= tol


# ------------------------------------------------------------ signs
@test
def canonical_home_margin_convention():
    # "Texas Tech -4.5" with Texas Tech at home -> home_market_margin = +4.5 for BOTH side quotes
    sides = D.canonical_sides({'home_line': -4.5, 'price_home': -110, 'price_away': -110})
    assert [x['side'] for x in sides] == ['HOME', 'AWAY']
    assert all(near(x['home_market_margin'], 4.5) for x in sides)
    assert near(sides[0]['line'], -4.5) and near(sides[1]['line'], 4.5)       # away +4.5 is the same market state
    assert near(sides[0]['implied_probability_raw'], 110 / 210.0, 1e-12)
    assert near(sides[0]['decimal_odds'], 1 + 100 / 110.0, 1e-12)
    # away favoured: home +3 -> home_market_margin = -3
    s2 = D.canonical_sides({'home_line': 3.0, 'price_home': None, 'price_away': None})
    assert near(s2[0]['home_market_margin'], -3.0) and s2[0]['american_odds'] is None and s2[0]['implied_probability_raw'] is None


@test
def outcome_probs_sign_and_push():
    P = KN.pmf_t([0.0], [14.0], [100])[0]
    w, p, l = KN.outcome_probs(P, 3.0)                   # home at internal line 3 (home -3): covers when margin > 3
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    assert near(w, P[ks > 3].sum()) and near(p, P[ks == 3].sum()) and near(l, P[ks < 3].sum())
    w2, p2, l2 = KN.outcome_probs(P, 3.5)
    assert p2 == 0.0 and near(w2, w) and near(l2, l + p)  # -3 -> -3.5: the margin == 3 mass moves from push to loss
    # side_probs: the away side at the same line is the mirror
    wa, pa, la = RP.side_probs(P[None, :], [3.0], np.array([-1.0]))
    assert near(wa[0], l) and near(la[0], w) and near(pa[0], p)


# -------------------------------------------------- the key distribution
@test
def discretised_t_is_a_distribution():
    P = KN.pmf_t([0.0, 7.0, -21.0], [15.0, 16.0, 18.0], [100, 30, 50])
    assert np.allclose(P.sum(axis=1), 1.0, atol=1e-12) and (P >= 0).all()
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    assert near((P[1] * ks).sum(), 7.0, 1e-3)
    assert np.allclose(P[0], P[0][::-1], atol=1e-12)                          # symmetric at mu = 0


@test
def untie_removes_ties_and_conserves_mass():
    ot = np.zeros(KN.KMAX + 1)
    ot[3], ot[7] = 0.6, 0.4
    P = KN.pmf_t([0.0], [14.0], [100])
    U = KN.untie(P, ot)
    c = KN.KMAX
    assert U[0, c] == 0.0 and near(U.sum(), 1.0, 1e-12)
    assert near(U[0, c + 3] - P[0, c + 3], P[0, c] * 0.3, 1e-12) and near(U[0, c - 7] - P[0, c - 7], P[0, c] * 0.2, 1e-12)


@test
def local_adjust_identity_mass_locality():
    P = KN.untie(KN.pmf_t([5.0], [15.0], [100]), KN.ot_distribution([3, -7, 3, 7]))
    one = np.ones(KN.KMAX + 1)
    assert np.allclose(KN.local_adjust(P, one), P, atol=1e-12)                  # r = 1: nothing moves
    m = one.copy()
    m[3] = 2.5
    A = KN.local_adjust(P, m)
    c = KN.KMAX
    assert near(A.sum(), 1.0, 1e-12)
    assert A[0, c + 3] > 2.0 * P[0, c + 3]                                      # the key gains
    far = np.abs(np.arange(-KN.KMAX, KN.KMAX + 1)) > 6
    assert np.allclose(A[0, far], P[0, far] / A.sum(), atol=1e-12)             # nothing moves more than 3 points away
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    assert abs((A[0] * ks).sum() - (P[0] * ks).sum()) < 0.05                   # the mean is (all but) preserved


@test
def fit_local_recovers_a_known_key():
    rng = np.random.default_rng(7)
    n = 6000
    mu = rng.normal(0, 8, n)
    sg = np.full(n, 15.0)
    ot = KN.ot_distribution(np.array([3, 7, 3, 1, 6]))
    true = np.ones(KN.KMAX + 1)
    true[0] = 0.0
    true[3], true[7] = 2.2, 1.8
    Ptrue = KN.local_adjust(KN.untie(KN.pmf_t(mu, sg, np.full(n, 100.0)), ot), true)
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    cdf = Ptrue.cumsum(axis=1)
    u = rng.random(n)[:, None]
    m = ks[(cdf < u).sum(axis=1)]
    Pu = KN.untie(KN.pmf_t(mu, sg, np.full(n, 100.0)), ot)
    fit = KN.fit_local(Pu, m)
    assert fit[3] > 1.5 and fit[7] > 1.3, (fit[3], fit[7])
    rep = KN.fit_report(KN.pmf_t(mu, sg, np.full(n, 100.0)), fit, 'local', ot, m, upto=8)
    o3 = [x for x in rep if x['k'] == 3][0]
    assert abs(o3['expected'] - o3['observed']) / o3['observed'] < 0.12, o3


@test
def half_point_value_and_cents():
    assert KN.cents(-110) == 0 and KN.cents(105) == 15 and KN.cents(-120) == -10 and KN.cents(100) == 10
    # exact: laying 3 -> 3.5 costs exactly P(margin == 3) in probability of NOT losing
    P = KN.pmf_t([3.0], [15.0], [100])[0]
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    w0, p0, l0 = KN.outcome_probs(P, 3.0)
    w1, p1, l1 = KN.outcome_probs(P, 3.5)
    assert near(l1 - l0, P[ks == 3].sum(), 1e-12)
    # the equivalent price reproduces the EV of -110 at the better number
    eq = KN.price_for_ev(w1, p1, l1, KN.ev(w0, p0, l0, -110))
    assert near(KN.ev(w1, p1, l1, eq), KN.ev(w0, p0, l0, -110), 1e-9)
    # a fair price is EV zero
    f = KN.fair_american(w1, l1)
    assert near(KN.ev(w1, p1, l1, f), 0.0, 1e-9)


@test
def price_vs_point_exact_math():
    # +3 -125 vs +3.5 -110 for the underdog (home dog getting 3: internal line -3, home covers when margin > -3)
    P = KN.pmf_t([-3.0], [15.0], [100])[0]
    wA, pA, lA = RP.side_probs(P[None, :], [-3.0], np.array([1.0]))
    wB, pB, lB = RP.side_probs(P[None, :], [-3.5], np.array([1.0]))
    evA = RP.ev_units(wA, pA, lA, -125)[0]
    evB = RP.ev_units(wB, pB, lB, -110)[0]
    assert np.isfinite(evA) and np.isfinite(evB) and not near(evA, evB, 1e-6)


# ------------------------------------------------------ implied margins
@test
def implied_margin_is_monotone_and_centred():
    fit = {'mult': np.ones(KN.KMAX + 1), 'ot': KN.ot_distribution([3, 7]), 'method': 'local'}
    fit['mult'][0] = 0.0
    tab = BK.implied_table(fit, 15.0, [4.5])
    a = BK.implied_margin(4.5, 0.45, tab)
    b = BK.implied_margin(4.5, 0.50, tab)
    c = BK.implied_margin(4.5, 0.55, tab)
    assert a < b < c
    # overtime games that end by 7 put some tie mass above a 4.5 line, so a fair quote at 4.5 is centred a
    # little below 4.5 under the untied distribution; the plain t centres it exactly
    assert 0.0 < 4.5 - b < 0.35, b
    tab_t = BK.implied_table(dict(fit, method='t'), 15.0, [4.5])
    assert abs(BK.implied_margin(4.5, 0.5, tab_t) - 4.5) < 1e-9


@test
def consensus_rules_basic():
    assert BK.weighted_median([1, 2, 3], [1, 1, 1]) == 2
    assert BK.weighted_median([1, 2, 3], [1, 1, 10]) == 3
    assert near(BK.trimmed_mean([0, 1, 2, 3, 100], 0.2), 2.0)


# ------------------------------------------------------------ challenger
@test
def challenger_weight_recovers_truth_and_clips():
    rng = np.random.default_rng(3)
    n = 20000
    truth = rng.normal(0, 12, n)
    mkt = truth + rng.normal(0, 2, n)
    pure = truth + rng.normal(0, 4, n)
    y = truth + rng.normal(0, 15, n)
    w = CH.fit_w(pure, mkt, y)
    # BLUE weight on pure: var(mkt err) / (var(mkt err) + var(pure err)) = 4 / 20 = 0.2
    assert abs(w - 0.2) < 0.05, w
    assert CH.fit_w(pure, mkt, 2 * pure - mkt) == 1.0 and CH.fit_w(pure, mkt, mkt - (pure - mkt)) == 0.0


@test
def market_columns_can_never_be_pure_inputs():
    for c in ('open_margin', 'close_margin', 'spread_close', 'line', 'gap_open', 'implied_margin', 'consensus_margin',
              'market_adjusted_projection', 'line_velocity', 'coordinated_move_score', 'expected_close_margin', 'book_price_edge'):
        try:
            K.assert_pure(['edge_epa', c])
        except K.LayerViolation:
            continue
        raise AssertionError('the pure contract accepted market column ' + c)
    assert CH.layer_guard()


# -------------------------------------------------------- point in time
def _synthetic_Q(n=400, seed=11):
    rng = np.random.default_rng(seed)
    op = np.round(rng.normal(0, 10, n) * 2) / 2
    pure = op + rng.normal(0, 4, n)
    Q = pd.DataFrame({'game_id': np.arange(n), 'season': 2018, 'kickoff_ts': pd.date_range('2018-09-01', periods=n, freq='h', tz='UTC'),
                      'open_margin': op, 'ens_pred': pure, 'sigma': 16.0, 't_df': 100.0,
                      'close_margin': op + rng.normal(0, 1.5, n).round(), 'margin': np.round(pure + rng.normal(0, 15, n)),
                      'early_season': 0, 'stage8_ev': rng.normal(0, 0.05, n)})
    Q['gap'] = Q.ens_pred - Q.open_margin
    Q['s'] = np.where(Q.gap >= 0, 1.0, -1.0)
    Q['price_open'] = -110.0
    fit = {'mult': np.ones(KN.KMAX + 1), 'ot': KN.ot_distribution([3, 7]), 'method': 'local'}
    fit['mult'][0] = 0.0
    P = KN.key_pmf(Q.ens_pred.values, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], 'local')
    w, p, l = RP.side_probs(P, Q.open_margin.values, Q.s.values)
    Pt = KN.pmf_t(Q.ens_pred.values, Q.sigma.values, Q.t_df.values)
    wt, pt, lt = RP.side_probs(Pt, Q.open_margin.values, Q.s.values)
    Q['p_pure_t'] = wt / (wt + lt)
    Q['ev_pure_open'] = RP.ev_units(w, p, l, Q.price_open.values)
    mu = Q.open_margin.values + 0.2 * Q.gap.values
    Ph = KN.key_pmf(mu, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], 'local')
    wh, ph, lh = RP.side_probs(Ph, Q.open_margin.values, Q.s.values)
    Q['ev_mi_open'] = RP.ev_units(wh, ph, lh, Q.price_open.values)
    return Q


@test
def decisions_never_read_the_close_or_the_result():
    Q = _synthetic_Q()
    M0 = RP.arm_masks(Q, 2)
    Z = Q.copy()
    Z['close_margin'] = Z.close_margin + 7.0          # a wildly different close ...
    Z['margin'] = -Z.margin                           # ... and the opposite results
    Z['total_close'] = 99.0
    M1 = RP.arm_masks(Z, 2)
    for k in M0:
        assert (M0[k] == M1[k]).all(), k
    assert M0['a1'].sum() > 0 and M0['a4'].sum() > 0


@test
def expected_move_respects_the_training_cap():
    rng = np.random.default_rng(5)
    rows = []
    for S, b in ((2019, 0.2), (2020, 0.2), (2021, 0.2), (2024, -5.0), (2025, 0.2)):
        g = rng.normal(0, 4, 500)
        rows.append(pd.DataFrame({'season': S, 'gap': g, 'open_margin': 0.0, 'close_margin': b * g, 's': np.sign(g),
                                  'on_key': False, 'early_season': 0}))
    Q = pd.concat(rows, ignore_index=True)
    capped = RP.expected_move(Q, train_cap=2021)
    free = RP.expected_move(Q)
    m = Q.season.values == 2025
    assert (capped.exp_move_toward.values[m] > 0).all()           # the cap never reads the 2024 regime
    assert (free.exp_move_toward.values[m] < 0).mean() > 0.9      # without the cap it would


@test
def holdout_is_scored_once():
    old = D.OUTDIR
    with tempfile.TemporaryDirectory() as d:
        D.OUTDIR = d
        try:
            with open(os.path.join(d, RP.HOLDOUT_FILE), 'w') as f:
                json.dump({'scored_at': '2026-09-27T00:00:00Z'}, f)
            try:
                RP.holdout(rescore=False)
            except SystemExit as e:
                assert 'scored once' in str(e)
            else:
                raise AssertionError('a second holdout run was allowed')
        finally:
            D.OUTDIR = old


@test
def bootstrap_is_deterministic_and_covers():
    x = np.random.default_rng(1).normal(2.0, 1.0, 500)
    a = D.Boot(500).mean(x)
    b = D.Boot(500).mean(x)
    assert a == b and a['ci'][0] < a['est'] < a['ci'][1] and a['ci'][0] < 2.0 < a['ci'][1]


# ------------------------------------------------------------- artifacts
@artifact
def key_number_artifact_is_frozen_and_sane():
    fit, a = KN.load_artifact()
    assert a['schema'] == 'cfb_market_key_numbers_schema_v1' and a['method'] in ('local', 'global', 't_untied')
    assert fit['mult'][0] == 0.0 and near(fit['ot'].sum(), 1.0, 1e-9)
    assert set(a['fit']['seasons']) <= set(D.DEV), a['fit']['seasons']                 # DEV only
    P = KN.key_pmf([3.0], [16.0], [100], fit['mult'], fit['ot'], fit['method'])[0]
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    assert P[ks == 3].sum() > P[ks == 4].sum() and P[ks == 7].sum() > P[ks == 8].sum()
    assert P[ks == 0].sum() == 0.0


@artifact
def book_and_challenger_artifacts_are_dev_only():
    b = json.load(open(os.path.join(D.ARTIFACTS, 'book_quality_v1.json')))
    c = json.load(open(os.path.join(D.ARTIFACTS, 'challenger_v1.json')))
    assert set(b['fit']['seasons']) <= set(D.DEV) and set(c['fit']['seasons']) <= set(D.DEV)
    assert b['weights_active'] is False and 0.0 <= c['w_pure'] <= 1.0
    assert 'never the EdgeDesk fair line' in c['label']


@artifact
def outputs_carry_n_and_cis():
    r = json.load(open(os.path.join(D.OUTDIR, 'keynumbers.json')))
    x = r['landing_dev']['abs_margin'][2]
    assert x['k'] == 3 and x['n'] > 1000 and x['ci'][0] < x['est'] < x['ci'][1]
    rp = json.load(open(os.path.join(D.OUTDIR, 'replay.json')))
    for row in rp['ladder_dev']:
        if row.get('bets'):
            assert 'ci' in row['roi'] and row['bets'] > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fast', action='store_true')
    a = ap.parse_args()
    ok = fail = skip = 0
    for fn, is_art in TESTS:
        if is_art and a.fast:
            skip += 1
            continue
        try:
            fn()
            ok += 1
        except Exception:
            fail += 1
            print('FAIL', fn.__name__)
            traceback.print_exc()
    print(('ALL GREEN ' if fail == 0 else 'FAILED ') + '%d passed, %d failed%s' % (ok, fail, (', %d artifact tests skipped (--fast)' % skip) if skip else ''))
    sys.exit(0 if fail == 0 else 1)


if __name__ == '__main__':
    main()
