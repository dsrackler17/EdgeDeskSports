"""Tests for the decision-policy layer (policy.py, tournament.py, portfolio.py, scorecard.py, holdout.py).

    python3 -m v2.decision.tests_policy          synthetic + artifact + data checks
    python3 -m v2.decision.tests_policy --fast   synthetic checks only
    python3 -m v2.decision.tests_policy --full   also re-runs the tournament and checks byte-identical outputs

Prints 'ALL GREEN n passed, 0 failed' on success. Never reads the holdout.
"""
import ast
import copy
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import traceback

import numpy as np
import pandas as pd

from .. import config as C
from . import policy as POL
from . import portfolio as PF
from . import scorecard as SC

PASS, FAIL = [], []
HERE = os.path.dirname(os.path.abspath(__file__))


def check(name, fn):
    try:
        fn()
        PASS.append(name)
    except Exception as e:                              # noqa: BLE001
        FAIL.append((name, '%s: %s' % (type(e).__name__, e)))
        if os.environ.get('DEBUG'):
            traceback.print_exc()


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


# ================================================================ synthetic
def t_js_semantics():
    assert POL.js_round(2.5) == 3 and POL.js_round(-2.5) == -2 and POL.js_round(0.49) == 0
    assert POL.r(0.12345, 4) == 0.1235 and POL.r(float('nan')) is None
    assert POL.jor(0, 3) == 3 and POL.jor(None, 3) == 3 and POL.jor(2, 3) == 2 and POL.jor(-1, 3) == -1
    assert POL.parse_ms('1970-01-01T00:00:01.500Z') == 1500.0 and POL.parse_ms('nope') is None
    assert POL.down3(0.6428571) == 0.642 and POL.down3(0.5) == 0.5
    assert POL.next_better_price(-101) == -100 and POL.next_better_price(-100) == 101 and POL.next_better_price(120) == 121
    assert POL.payout_to_american(POL.american_to_payout(-118)) == -118


def _frozen():
    return POL.load_artifact()


def _ctx(policy, artifact, **over):
    c = {'policy': policy, 'artifact': artifact, 'now': POL.parse_ms(POL.NOW_ISO), 'market': {'books': 6, 'dispersion_iqr': 0.5}, 'row': {}}
    c.update(over)
    return c


def t_eligibility_independent_of_bankroll():
    A = POL._merge(_frozen(), POL.BETTABLE_PATCH)
    for bank in (1, 10, 100, 1e6):
        for pm in (4.0, 9.5, 14.0):
            pol = copy.deepcopy(POL.TEST_POLICY)
            pol['stake'] = {'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.25, 'bankroll_u': bank,
                            'max_stake_u': 1, 'saturation_probability': 0.58}
            d = POL.decide_quote(POL._base_pure(projected_margin=pm), POL._base_quote(), _ctx(pol, A), with_targets=False)
            base = POL.decide_quote(POL._base_pure(projected_margin=pm), POL._base_quote(), _ctx(POL.TEST_POLICY, A), with_targets=False)
            assert (d['status'], d['reason_codes']) == (base['status'], base['reason_codes']), (bank, pm)
            assert d.get('stake_u', 0) <= 1 + 1e-12


def t_stake_caps_and_quarter_kelly():
    rng = np.random.default_rng(1)
    for _ in range(500):
        p, price = float(rng.uniform(0.45, 0.8)), float(rng.choice([-130, -110, -105, 100, 120, 150]))
        cap, frac = float(rng.choice([0.5, 1, 1.5, 100])), float(rng.choice([0.1, 0.25, 1.0, 5.0]))
        S = {'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': frac, 'bankroll_u': 100, 'max_stake_u': cap,
             'saturation_probability': 0.6}
        s = POL.stake({'decision_cover_probability': p, 'price': price}, {'stake': S})
        assert 0 <= s <= cap + 1e-9
        assert s <= POL.r(0.25 * POL.kelly_fraction(min(p, 0.6), price) * 100, 2) + 1e-9          # never above quarter Kelly
    assert POL.stake({'decision_cover_probability': 0.9, 'price': -110}, {'stake': {'method': 'flat', 'unit_u': 1, 'max_stake_u': 0.5}}) == 0.5


def t_exposure_never_exceeds_caps():
    rng = np.random.default_rng(2)
    for _ in range(300):
        n = int(rng.integers(1, 12))
        pos = [{'game_id': 'g%d' % rng.integers(0, 4), 'stake_u': float(np.round(rng.uniform(0.1, 1.5), 3)),
                'conference_cluster': str(rng.choice(['A', 'B', None]))} for _ in range(n)]
        E = {'max_game_u': float(rng.choice([0.5, 1, 1.5])), 'max_slate_u': float(rng.choice([2, 3, 5])), 'max_cluster_u': 1.5,
             'same_game_correlation': float(rng.choice([0, 0.5, 1]))}
        res = POL.apply_exposure(pos, {'exposure': E})
        assert res['total_u'] <= E['max_slate_u'] + 1e-9, res
        for x, y in zip(pos, res['positions']):
            assert y['stake_u'] <= x['stake_u'] + 1e-12                                            # scaled down, never up
        for cl in ('A', 'B'):
            assert sum(y['stake_u'] for y in res['positions'] if y.get('conference_cluster') == cl) <= 1.5 + 1e-9


def t_price_targets_clear_exactly():
    A = POL._merge(_frozen(), POL.BETTABLE_PATCH)
    pol = dict(POL.TEST_POLICY, max_price=-300)
    worse = lambda a: (-101 if a - 1 < 100 else a - 1) if a > 0 else a - 1
    n = 0
    for pm in (6.0, 8.0, 9.5, 12.0):
        for hl in (-3.5, -3.0, -1.0, 2.5):
            d = POL.decide_quote(POL._base_pure(projected_margin=pm), POL._base_quote(home_line=hl), _ctx(pol, A))
            tb = d['price_targets']['bettable_to_price']
            if tb is None or d['status'] != 'BET':
                continue
            q1 = POL._base_quote(home_line=hl, price_home=tb, price_away=None)
            q2 = POL._base_quote(home_line=hl, price_home=worse(tb), price_away=None)
            assert POL.decide_quote(POL._base_pure(projected_margin=pm), q1, _ctx(pol, A), with_targets=False)['status'] == 'BET', (pm, hl, tb)
            assert POL.decide_quote(POL._base_pure(projected_margin=pm), q2, _ctx(pol, A), with_targets=False)['status'] != 'BET', (pm, hl, tb)
            n += 1
    assert n >= 5, n


def t_frozen_artifact_never_bets():
    A = _frozen()
    pol = dict(json.load(open(os.path.join(POL.ARTIFACTS, 'cfb_decision_policy_v1', 'policy.json'))), bet_enabled=True)
    for pm in (3.0, 8.0, 12.0, 16.0):
        for hl in (-7.0, -3.5, 0.0, 3.5):
            for ph in (-125, -110, 100, 150, 250):
                d = POL.decide_quote(POL._base_pure(projected_margin=pm, sigma=16.0), POL._base_quote(home_line=hl, price_home=ph, price_away=None),
                                     _ctx(pol, A), with_targets=(ph == -110))
                assert d['status'] != 'BET', (pm, hl, ph, d['reason_codes'])
                if ph == -110 and d.get('price_targets'):
                    assert d['price_targets']['bettable_to_price'] is None and d['price_targets']['bettable_to_line'] is None


def t_research_needs_the_decision_edge():
    A = _frozen()
    P = json.load(open(os.path.join(POL.ARTIFACTS, 'cfb_decision_policy_v1', 'policy.json')))
    d = POL.decide_quote(POL._base_pure(projected_margin=7.5, sigma=16.0), POL._base_quote(), _ctx(P, A, row={'qb_unsettled_any': True}))
    assert d['status'] == 'PASS' and d['reason_codes'] == ['PASS_PRICE'] and d['probability_edge'] <= 0 < d['pure_cover_probability'] - d['break_even_probability']
    d2 = POL.decide_quote(POL._base_pure(projected_margin=12.0, sigma=16.0), POL._base_quote(), _ctx(P, A, row={'qb_unsettled_any': True}))
    assert d2['status'] == 'RESEARCH' and d2['reason_codes'] == ['RESEARCH_QB']


def t_close_ev():
    from .tournament import close_ev
    e = np.array([-7, -3, -1, 0, 0, 1, 3, 7, -0.5, 0.5], float)
    vals, cnt = np.unique(np.concatenate([e, -e]), return_counts=True)
    tab = {'values': vals, 'p': cnt / cnt.sum()}
    v = close_ev(np.array([0.0, 0.5, 1.0, 3.0, -1.0]), tab)
    p0 = float((vals == 0).dot(tab['p']))
    assert abs(v[0] - ((1 - p0) / 2) * (100 / 110 - 1)) < 1e-12                                  # a fair coin at -110 with pushes
    assert v[4] < v[0] < v[1] <= v[2] < v[3]                                                     # monotone in CLV


def t_scorecard_known():
    df = pd.DataFrame({'game_id': [1, 2, 3, 4], 'kickoff_ts': pd.date_range('2024-01-01', periods=4, tz='UTC'),
                       'units': [100 / 110, -1.0, 100 / 110, 0.0], 'ats_win': [1.0, 0.0, 1.0, np.nan], 'is_push': [0, 0, 0, 1.0],
                       'clv_pts': [1.0, -0.5, 0.0, 2.0], 'p_dec': [0.55, 0.52, 0.53, 0.54], 'probability_edge': [0.02, 0.0, 0.01, 0.02],
                       'decision_ev': [0.03, 0.0, 0.01, 0.02]})
    c = SC.scorecard(df, B=200)
    assert c['bet_count'] == 4 and c['ats']['wins'] == 2 and c['ats']['losses'] == 1 and c['ats']['pushes'] == 1
    assert abs(c['roi'] - (200 / 110 - 1) / 4) < 1e-4 and abs(c['avg_clv'] - 0.625) < 1e-9 and c['positive_clv_pct'] == 0.5
    assert abs(c['calibration_error'] - ((0.55 + 0.52 + 0.53) / 3 - 2 / 3)) < 1e-4
    assert SC.longest_losing_streak([1, 0, 0, np.nan, 0, 1, 0]) == 3
    tr = SC.time_to_recovery([1, -1, -1, 1, 1, 1, -2])
    assert tr['bets'] == 4 and tr['recovered'] is True, tr
    lo, hi = SC.cluster_boot(np.r_[np.ones(50), np.zeros(50)], np.arange(100), B=500)
    assert lo < 0.5 < hi


def t_portfolio_mechanics():
    rng = np.random.default_rng(3)
    blocks = [rng.choice([100 / 110, -1.0], size=int(rng.integers(0, 6))) for _ in range(30)]
    sb = PF.season_bootstrap(blocks, n_weeks=15, sims=300, seed=5)
    idx = np.random.default_rng(5).integers(0, len(blocks), size=(300, 15))
    brute = [SC.core.max_drawdown(np.concatenate([blocks[j] for j in row] + [np.zeros(0)])) or 0.0 for row in idx]
    assert abs(sb['max_drawdown_p50'] - round(float(np.quantile(brute, 0.5)), 2)) < 1e-6, (sb['max_drawdown_p50'], np.quantile(brute, 0.5))
    groups = [np.r_[np.ones(5), np.zeros(5)] for _ in range(40)]
    assert abs(PF._icc(groups)) < 0.2
    assert PF._icc([np.ones(4) if i % 2 else np.zeros(4) for i in range(40)]) > 0.95
    a = PF.risk_of_ruin(50, 50, 0.02, [3, 4, 5], 0.0, bankrolls=(10,), paths=2000, seed=9)
    b = PF.risk_of_ruin(50, 50, 0.02, [3, 4, 5], 0.0, bankrolls=(10,), paths=2000, seed=9)
    assert a == b and a['by_bankroll']['10']['p50']['ror'] > 0.5


def t_choose_plateau():
    from . import tournament as T
    n = 3000
    rng = np.random.default_rng(4)
    pe = rng.uniform(-0.03, 0.06, n)
    df = pd.DataFrame({'game_id': np.arange(n), 'probability_edge': pe, 'close_ev': np.where(pe >= 0.01, 0.02, -0.03) + rng.normal(0, 1e-4, n)})
    ch, rows, pl = T.choose(df, T.CANDIDATES['edge']['grid'], T.CANDIDATES['edge']['mask'])
    assert pl['best'] in (0.01, 0.015, 0.02, 0.025, 0.03) and ch in pl['plateau'] and ch >= 0.01, (ch, pl)
    assert all(not r['eligible'] for r in rows if r['n'] < 100)


# ================================================================ artifacts
READS = ['version', 'min_probability_edge', 'min_ev', 'stale_minutes', 'max_price', 'min_books', 'max_dispersion_iqr', 'extreme_gap_pts',
         'extreme_ev', 'extreme_cover_probability', 'orientation_gap', 'orientation_reconcile', 'extreme_max_age_minutes', 'push_table',
         'hysteresis', 'min_football_confidence', 'max_ensemble_sd', 'min_bet_confidence', 'bet_enabled', 'lean', 'wait', 'reference_price',
         'ideal_probability_edge', 'stake', 'exposure']


def _pdir():
    return os.path.join(POL.ARTIFACTS, 'cfb_decision_policy_v1')


def t_committed_policy():
    P = json.load(open(os.path.join(_pdir(), 'policy.json')))
    assert POL.validate_policy(P)['ok'] and P['bet_enabled'] is False
    missing = [k for k in READS if k not in P]
    assert not missing, missing
    for k in ('edge_buffer', 'ev_buffer'):
        assert k in P['hysteresis']
    for k in ('enabled', 'ev_per_point', 'p_disappear', 'min_benefit_ev'):
        assert k in P['wait']
    for k in ('unit_u', 'method', 'kelly_validated', 'max_stake_u', 'kelly_fraction', 'saturation_probability', 'bankroll_u'):
        assert k in P['stake']
    for k in ('same_game_correlation', 'max_game_u', 'max_cluster_u', 'max_slate_u'):
        assert k in P['exposure']
    for k in ('min_probability_edge', 'min_gap_pts'):
        assert k in P['lean']
    # supabase/cfb_decision.sql constraints (cfb_decision_policies, cfb_bankroll_policy)
    assert P['min_probability_edge'] >= 0 and P['min_ev'] >= 0 and P['stale_minutes'] > 0
    assert P['status'] in ('UNVALIDATED_DEFAULT', 'RESEARCH', 'SHADOW', 'PRODUCTION', 'RETIRED', 'REJECTED')
    S, E = P['stake'], P['exposure']
    assert 0 < S['max_stake_u'] <= 2 and E['max_game_u'] >= S['max_stake_u'] and E['max_slate_u'] >= E['max_game_u']
    assert S['kelly_fraction'] is None or 0 < S['kelly_fraction'] <= 0.25
    # no JS `||` trap: the frozen policy sets none of the defaulted fields to exactly 0
    for k in ('min_books', 'max_dispersion_iqr', 'extreme_gap_pts', 'extreme_ev', 'extreme_max_age_minutes', 'orientation_gap', 'orientation_reconcile'):
        assert P[k] != 0, k
    assert P['lean']['min_gap_pts'] != 0 and P['hysteresis']['edge_buffer'] != 0


def t_manifest_and_prereg():
    M = json.load(open(os.path.join(_pdir(), 'MANIFEST.json')))
    for fn, h in M['files'].items():
        assert h is None or sha(os.path.normpath(os.path.join(_pdir(), fn))) == h, fn
    from .tournament import PREREG
    assert sha(PREREG) == M['prereg']['sha256']
    P = json.load(open(os.path.join(_pdir(), 'policy.json')))
    assert P['prereg_sha256'] == M['prereg']['sha256'] and M['bet_enabled'] is False
    assert sha(POL.CAL_JSON) == M['calibration_json_sha256']


def t_holdout_once():
    """The access log shows exactly one READ for the frozen policy, the manifest agrees, policy.json never changed."""
    M = json.load(open(os.path.join(_pdir(), 'MANIFEST.json')))
    log = os.path.join(_pdir(), 'holdout_access.jsonl')
    if not os.path.exists(log):
        assert M['holdout_scored'] is False
        return
    E = [json.loads(l) for l in open(log) if l.strip()]
    reads = [e for e in E if e['action'] == 'READ_HOLDOUT']
    assert len(reads) == 1 and reads[0]['policy_sha256'] == M['files']['policy.json'] == sha(os.path.join(_pdir(), 'policy.json'))
    assert M['holdout_scored'] is True and M['holdout']['policy_sha256'] == reads[0]['policy_sha256']
    assert E.index(reads[0]) < max(i for i, e in enumerate(E) if e['action'] == 'HOLDOUT_SCORED')      # logged before scoring


def t_holdout_refuses():
    from . import holdout as H
    from . import tournament as T
    real_dir, real_log = T.POLICY_DIR, H.ACCESS_LOG
    tmp = tempfile.mkdtemp()
    try:
        T.POLICY_DIR = os.path.join(tmp, 'p')
        H.ACCESS_LOG = os.path.join(T.POLICY_DIR, 'holdout_access.jsonl')
        try:
            H.preflight()
            raise RuntimeError('ran without a frozen policy')
        except SystemExit as e:
            assert 'not frozen' in str(e)
        shutil.copytree(real_dir, T.POLICY_DIR)
        if os.path.exists(H.ACCESS_LOG):
            os.remove(H.ACCESS_LOG)
        ids = H.preflight()                                      # frozen, never read here: allowed (nothing is read by preflight)
        H.log_access(dict(ids, action='READ_HOLDOUT', at='test'))
        try:
            H.preflight()
            raise RuntimeError('a second read was allowed')
        except SystemExit as e:
            assert 'already read' in str(e)
        pj = os.path.join(T.POLICY_DIR, 'policy.json')
        with open(pj, 'a') as f:
            f.write(' ')
        try:
            H.preflight()
            raise RuntimeError('a changed policy.json was allowed')
        except SystemExit as e:
            assert 'does not match' in str(e)
    finally:
        T.POLICY_DIR, H.ACCESS_LOG = real_dir, real_log
        shutil.rmtree(tmp)
    if os.path.exists(os.path.join(real_dir, 'holdout_access.jsonl')):
        try:
            H.preflight()
            raise RuntimeError('the real holdout could be read again')
        except SystemExit as e:
            assert 'already read' in str(e)


def t_holdout_static_guard():
    """Only holdout.py loads holdout rows: every other read of the decision dataset or stage 7 filters to DEV (or live)."""
    for fn in ('tournament.py', 'policy.py', 'portfolio.py', 'scorecard.py', 'render.py'):
        src = open(os.path.join(HERE, fn)).read()
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Call) and getattr(node.func, 'attr', '') == 'read_parquet':
                txt = ast.get_source_segment(src, node)
                if 'decision_dataset' in txt:
                    assert 'filters' in txt and 'holdout' not in txt and ("'dev'" in txt or "'live'" in txt), (fn, txt)
                if 'backtest_predictions' in txt:
                    assert "('season', '<='" in txt and 'DEV_SEASONS' in txt, (fn, txt)
    src = open(os.path.join(HERE, 'holdout.py')).read()
    assert "filters=[('window', '==', 'holdout')]" in src and "('season', 'in', HOLDOUT)" in src
    assert src.index('log_access(entry)') < src.index('H, S7 = load_holdout()')               # logged before the read


def t_parity_fixture_reproduces():
    P = json.load(open(os.path.join(_pdir(), 'policy.json')))
    tmp = tempfile.mkdtemp()
    try:
        out = os.path.join(tmp, 'fx.json')
        POL.build_fixture(P, path=out)
        assert sha(out) == sha(POL.FIXTURE), 'policy.py no longer reproduces the committed parity fixture'
    finally:
        shutil.rmtree(tmp)


def t_python_mirror_matches_fixture_statuses():
    F = json.load(open(POL.FIXTURE))
    seen = set()
    for c in F['cases']:
        seen.add(c['expected']['status'])
        seen.update(c['expected']['reason_codes'])
    assert {'BET', 'LEAN', 'RESEARCH', 'PASS', 'NO_BET'} <= seen
    need = set(POL.REASON_CODES) - {'PASS_QB_UNCERTAINTY'}
    assert need <= seen, need - seen


# ===================================================================== data
def t_outputs_consistent():
    from . import tournament as T
    p = os.path.join(T.out_dir(), 'tournament.json')
    if not os.path.exists(p):
        return
    tj = json.load(open(p))
    ev = json.load(open(os.path.join(_pdir(), 'evidence.json')))
    assert tj['prereg_sha256'] == sha(T.PREREG)
    assert json.dumps(ev['tournament'], sort_keys=True) == json.dumps(tj, sort_keys=True)
    assert ev['analyses_sha256'] == sha(os.path.join(T.out_dir(), 'analyses.json'))
    cand = json.load(open(os.path.join(T.out_dir(), 'policy_candidate.json')))
    assert cand == json.load(open(os.path.join(_pdir(), 'policy.json')))
    assert all(v['verdict'] != 'BET-VALID' for v in tj['bet_valid'].values()) or not json.load(open(os.path.join(_pdir(), 'policy.json')))['bet_enabled']


def t_full_rerun_byte_identical():
    from . import tournament as T
    files = ['tournament.json', 'analyses.json', 'policy_candidate.json']
    before = {f: sha(os.path.join(T.out_dir(), f)) for f in files}
    T.main(freeze=False)
    after = {f: sha(os.path.join(T.out_dir(), f)) for f in files}
    assert before == after, 'the tournament is not byte-identical on a re-run'


SYNTHETIC = [t_js_semantics, t_eligibility_independent_of_bankroll, t_stake_caps_and_quarter_kelly, t_exposure_never_exceeds_caps,
             t_price_targets_clear_exactly, t_frozen_artifact_never_bets, t_research_needs_the_decision_edge, t_close_ev,
             t_scorecard_known, t_portfolio_mechanics, t_choose_plateau]
ARTIFACT = [t_committed_policy, t_manifest_and_prereg, t_holdout_once, t_holdout_refuses, t_holdout_static_guard,
            t_parity_fixture_reproduces, t_python_mirror_matches_fixture_statuses]
DATA = [t_outputs_consistent]


def main():
    fast = '--fast' in sys.argv
    for t in SYNTHETIC + ([] if fast else ARTIFACT + DATA):
        check(t.__name__, t)
    if '--full' in sys.argv:
        check('t_full_rerun_byte_identical', t_full_rerun_byte_identical)
    for n, e in FAIL:
        print('FAIL | %s | %s' % (n, e))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (len(PASS), len(FAIL)))
    sys.exit(0 if not FAIL else 1)


if __name__ == '__main__':
    main()
