"""Freeze the decision calibration artifact, its manifest, its evidence and the parity fixture.

    football/cfb_v2/artifacts/decision/cfb_decision_calibration_v1/calibration.json
    football/cfb_v2/artifacts/decision/cfb_decision_calibration_v1/evidence.json
    football/cfb_v2/artifacts/decision/cfb_decision_calibration_v1/MANIFEST.json
    football/cfb_v2/artifacts/decision/fixtures/decision_parity.json

Called by study.main() with the study's DEV-only results. Every object in the
artifact is plain JSON in the schema reference.py evaluates (and decision.js
ports): probability maps, a logit-space market shrinkage, linear interpolation
tables and linear/logistic models with explicit standardization and fills.
The holdout is never read here; the fixture's inputs are DEV rows, live 2026
quotes (inputs only) and synthetic cases.
"""
import glob
import hashlib
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .. import config as C
from . import ARTIFACT_VERSION, BASE_MODEL_VERSION, DECISION_SCHEMA, BASELINE_ID
from . import core
from . import calibration as CAL
from . import reference as REF
from . import dataset as DS
from .baseline import ARTIFACTS, MANIFEST as BASELINE_MANIFEST, sha256_file, content_sha256

ART_DIR = os.path.join(ARTIFACTS, ARTIFACT_VERSION)
FIX_DIR = os.path.join(ARTIFACTS, 'fixtures')
CAL_JSON = os.path.join(ART_DIR, 'calibration.json')
FIXTURE = os.path.join(FIX_DIR, 'decision_parity.json')
FIT_CODE = ['__init__.py', 'core.py', 'calibration.py', 'dataset.py', 'study.py', 'reference.py', 'freeze.py']

FEATURE_DOC = {
    'pure_cover_prob': 'PURE P(side covers | no push) from the frozen t distribution at the quote (probability)',
    'gap_pts': 'model-market gap oriented to the side evaluated: (pure_margin - market_margin) * (+1 HOME / -1 AWAY), points',
    'abs_gap_pts': '|gap_pts|',
    'sigma': 'the frozen error model SD (points) of the projection',
    'ens_sd': 'submodel disagreement (SD of C and D, points)',
    'reliability': 'engine.js football_prediction_confidence (0-100, frozen params.js range and caps)',
    'early_season': '1 if the snapshot is < 5 weeks after the season\'s first kickoff',
    'qb_missing': '1 if either expected starting QB is unknown at the snapshot',
    'qb_unsettled': '1 if either team used >= 2 starters in its last 3 games',
    'abs_line': '|quoted spread| (points)',
    'total_line': 'the quoted game total (points); fill = DEV mean when not captured',
    'is_home_side': '1 if the side evaluated is HOME',
    'decision_cover_prob': 'the decision cover probability (after calibration and market shrinkage)',
}


def _clean_model(spec, note=None):
    keep = {k: spec[k] for k in ('type', 'target', 'intercept', 'coef', 'mu', 'sd', 'fill', 'n_train', 'l2') if k in spec}
    if 'coef_ci95' in spec:
        keep['coef_ci95_bootstrap'] = spec['coef_ci95']
    if note:
        keep['note'] = note
    return keep


def build_artifact(W, s5, s10, s19, s24, cond, ptab):
    """All-DEV refits of what the walk-forward study selected."""
    CAL.assert_fit_rows(W)
    Y = W[W.ats_win.notna()]
    chosen = s5['chosen']
    x, y = Y.pure_cover_prob.values, Y.ats_win.values
    shrink = CAL.fit_shrink(x, y)
    evidence_cover = {k: s5['methods'][k]['log_loss'] for k in s5['methods']}
    if chosen in ('shrink', 'market', 'identity'):
        cmap = {'method': 'identity'}
        w = {'shrink': shrink['w'], 'market': 0.0, 'identity': 1.0}[chosen]
    elif chosen == 'logit_pwl':
        cmap = CAL.fit_logit_pwl(x, y)
        pc = CAL.apply_map_np(cmap, x)
        w = CAL.fit_shrink(pc, y)['w']
    else:
        cmap = CAL.fit_isotonic_symmetric(x, y)
        pc = CAL.apply_map_np(cmap, x)
        w = CAL.fit_shrink(pc, y)['w']
    cover_cal = {'map': cmap, 'selected_method': chosen,
                 'selection_rule': s5['rule'],
                 'walk_forward_log_loss_2018_2023': evidence_cover,
                 'domain': 'side-oriented pure cover probability; maps are side-symmetric f(1-p) = 1 - f(p)'}
    adopted = [k for k, v in cond.items() if isinstance(v, dict) and v.get('adopted')]
    if adopted:                                    # only when the evidence supports it (study rule)
        k = adopted[0]
        c = cond[k]
        if c['feature']:
            maps = []
            edges = c['edges']
            Yg = Y.copy()
            vals = Yg[c['feature']].values
            idx = np.array([REF.bin_of(edges, v) for v in vals])
            for b in range(len(edges) + 1):
                m = idx == b
                wb = CAL.fit_shrink(Yg.pure_cover_prob.values[m], Yg.ats_win.values[m])['w'] if m.sum() >= 150 else w
                maps.append(CAL.symmetric_shrink_map(wb))
            cover_cal['conditional'] = {'by': c['feature'], 'bins': edges, 'maps': maps}
            w = 1.0
    market_shrinkage = {'w_model': float(w), 'space': 'logit',
                        'formula': 'decision_p = sigmoid(w_model * logit(calibrated_p) + (1 - w_model) * logit(market_p))',
                        'market_p': 'proportional de-vig of the two-sided price for the side; 0.5 when the price is not two-sided',
                        'w_ci95_profile_dev': shrink['w_ci95_profile'], 'lr_test_w0': shrink['lr_w0'], 'lr_test_w1': shrink['lr_w1'],
                        'walk_forward_w_by_season': s5['shrink_weight']['walk_forward'],
                        'per_season_local_w': s5['shrink_weight']['per_season_local'],
                        'historical_market_p': 'always 0.5 (ASSUMED -110 both sides): the data identify w only against a fair-line market',
                        'n_fit': int(len(Y))}
    ev = CAL.fit_ev_curve(W.theoretical_ev.values, W.units_assumed_110.values, W.push_prob.values)
    sc = W  # decision EV exists only where the walk-forward decision probability does (2018+)
    return cover_cal, market_shrinkage, ev


def decision_ev_curve(Wd):
    sc = Wd[Wd.decision_ev.notna()]
    CAL.assert_fit_rows(sc)
    cv = CAL.fit_ev_curve(sc.decision_ev.values, sc.units_assumed_110.values, sc.push_prob.values)
    cv['input'] = 'decision_ev'
    cv['fit_rows'] = 'walk-forward decision EVs of 2018-2023 (each season\'s decision probability from maps fit on earlier seasons)'
    return cv


def push_table_js(pt):
    return {'%s-%s' % (b['lo'], b['hi']): b['p'] for b in pt['buckets']}


def fixture_cases(A, Wd):
    """~40 cases: DEV rows across gap buckets, live 2026 quotes (inputs only), synthetic edge cases."""
    cases = []
    D = pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dataset.parquet'),
                        filters=[('window', 'in', ['dev', 'live'])])
    dev = D[D.window.eq('dev') & D.quote_role.eq('CONSENSUS_OPEN') & D.pure_cover_prob.notna()
            & D.pricing_scope.eq('FBS_FBS') & ~D.review_route].sort_values('decision_row_id')
    rng = np.random.default_rng(C.SEED)
    picks = []
    for lo, hi in ((0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 7), (7, 10), (10, 14)):
        s = dev[(dev.abs_gap_pts >= lo) & (dev.abs_gap_pts < hi)]
        picks += list(s.iloc[rng.choice(len(s), size=min(3, len(s)), replace=False)].index)
    live = D[D.window.eq('live') & D.quote_role.eq('LIVE_BOOK_QUOTE') & D.pure_cover_prob.notna()].sort_values('decision_row_id')
    lp = list(live.index[:: max(1, len(live) // 5)][:5])

    def row_inputs(rr, price_home, price_away):
        return {'pure_margin': float(rr.pure_margin), 'sigma': float(rr.sigma), 't_df': float(rr.t_df),
                'home_line': float(rr.quote_home_line), 'price_home': price_home, 'price_away': price_away,
                'ens_sd': float(rr.ens_sd), 'reliability': float(rr.reliability), 'week': int(rr.week),
                'early_season': float(rr.early_season), 'qb_missing': float(rr.qb_missing),
                'qb_unsettled': float(rr.qb_unsettled),
                'total_line': float(rr.total_line) if np.isfinite(rr.total_line) else None,
                'books': float(rr.books) if np.isfinite(rr.books) else None,
                'dispersion': float(rr.dispersion) if np.isfinite(rr.dispersion) else None}

    for i in picks:
        rr = D.loc[i]
        cases.append(('dev_%s' % rr.decision_row_id, 'DEV consensus opener at the ASSUMED -110 (historical convention)',
                      row_inputs(rr, -110.0, -110.0)))
    for i in lp:
        rr = D.loc[i]
        cases.append(('live_%s' % rr.decision_row_id, 'LIVE 2026 quote: no price captured -> EV, break-even and edge are null',
                      row_inputs(rr, None, None)))
    base = {'pure_margin': 7.0, 'sigma': 16.5, 't_df': 100.0, 'home_line': -3.0, 'price_home': -110.0, 'price_away': -110.0,
            'ens_sd': 1.2, 'reliability': 70.0, 'week': 8, 'early_season': 0.0, 'qb_missing': 0.0, 'qb_unsettled': 0.0,
            'total_line': 55.5, 'books': 5.0, 'dispersion': 0.5}
    syn = [
        ('syn_key_number_3_push', 'integer line on the key number 3', {}),
        ('syn_key_number_7', 'integer line 7', {'home_line': -7.0, 'pure_margin': 12.0}),
        ('syn_half_point', 'half-point line: no push', {'home_line': -3.5}),
        ('syn_pickem', 'a pick-em line (0): push table first bucket', {'home_line': 0.0, 'pure_margin': 2.0}),
        ('syn_away_side', 'the model prefers the away side', {'pure_margin': -4.0, 'home_line': -3.0}),
        ('syn_devig_shaded', 'a shaded two-sided price -120/+100 (de-vig != 0.5)', {'price_home': -120.0, 'price_away': 100.0}),
        ('syn_devig_plus', 'a plus-money side +130/-150', {'price_home': 130.0, 'price_away': -150.0, 'home_line': 3.5, 'pure_margin': 1.0}),
        ('syn_one_sided_price', 'only the side price: market_p falls back to 0.5, EV computable', {'price_away': None}),
        ('syn_reduced_juice', '-105/-105', {'price_home': -105.0, 'price_away': -105.0}),
        ('syn_huge_gap', 'a 13-point disagreement (would be REVIEW-adjacent)', {'pure_margin': 16.0, 'home_line': -3.0}),
        ('syn_tiny_sigma', 'a small sigma (extreme pure probability)', {'sigma': 9.0, 'pure_margin': 10.0}),
        ('syn_t_df_5', 'heavy tails t_df = 5', {'t_df': 5.0}),
        ('syn_missing_features', 'missing ens_sd / reliability / total: the models use their fills', {'ens_sd': None, 'reliability': None, 'total_line': None}),
        ('syn_early_qb', 'early season with an unsettled QB', {'early_season': 1.0, 'qb_unsettled': 1.0, 'qb_missing': 1.0, 'week': 2}),
        ('syn_big_favorite', 'a 28-point favourite', {'home_line': -28.0, 'pure_margin': 31.0, 'total_line': 62.0}),
    ]
    for cid, note, over in syn:
        inp = dict(base)
        inp.update(over)
        cases.append((cid, note, inp))
    fx = []
    for cid, note, inp in cases:
        o = REF.evaluate(inp, A)
        f = o.pop('features')
        exp = {k: (float(v) if isinstance(v, (int, float, np.floating)) and not isinstance(v, bool) else v) for k, v in o.items()}
        exp['decision_cover_probability'] = exp['decision_cover_prob']
        fx.append({'id': cid, 'note': note,
                   'inputs': dict(inp, side=o['side'], pure_cover_prob=o['pure_cover_prob'],
                                  market_implied_prob=o['market_implied_prob'],
                                  features={k: (float(v) if isinstance(v, (int, float, np.floating)) and not isinstance(v, bool) and v is not None else v)
                                            for k, v in f.items()}),
                   'expected': exp})
    return fx


def main(W, Wd, s5, s10, s19, s24, s4, cond, s14, s33, s20, ps, summary):
    os.makedirs(ART_DIR, exist_ok=True)
    os.makedirs(FIX_DIR, exist_ok=True)
    CAL.assert_fit_rows(W)
    # push table: FBS openers 2014-2023 (pre-DEV burn-in + DEV; never holdout)
    H = DS.load_stage7()
    H = H[H.season.between(DS.PUSH_BURN_IN, max(C.DEV_SEASONS)) & ~H.fcs_game.astype(bool) & H.status.eq('FINAL')
          & H.open_margin.notna() & H.margin.notna()]
    assert not set(H.season) & (set(C.HOLDOUT_SEASONS) | {C.LIVE_SEASON})
    pt = core.fit_push_table(H.open_margin.values, H.margin.values)
    cover_cal, shrink, ev = build_artifact(W, s5, s10, s19, s24, cond, pt)
    evd = decision_ev_curve(Wd)
    fb = s24['football']
    mk = s24['market']
    e_lo, e_hi = fb['scale_expected_abs_error']
    m_lo, m_hi = mk['scale_expected_abs_move']
    pclv = _clean_model(s19['final']['logistic'], 'P(side-oriented CLV > 0); features picked walk-forward: %s' % s19['picked']['logistic'])
    A = {
        'schema': DECISION_SCHEMA, 'version': ARTIFACT_VERSION, 'base_model_version': BASE_MODEL_VERSION,
        'created_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'baseline': BASELINE_ID,
        'fit_seasons': {'cover_calibration': sorted(int(s) for s in W.season.unique()),
                        'market_shrinkage': sorted(int(s) for s in W.season.unique()),
                        'ev_curve': sorted(int(s) for s in W.season.unique()),
                        'ev_curve_decision': sorted(int(s) for s in Wd[Wd.decision_ev.notna()].season.unique()),
                        'clv_models': sorted(int(s) for s in W.season.unique()),
                        'football_confidence': fb['seasons_scored'] and sorted(set([2017] + fb['seasons_scored'])),
                        'market_confidence': sorted(set([2016] + mk['seasons_scored'])),
                        'push_table': list(range(DS.PUSH_BURN_IN, max(C.DEV_SEASONS) + 1)),
                        'holdout_2024_2025': 'never read'},
        'price_convention': ('historical fits price every decision at an ASSUMED -110 each side (the archive used carries '
                             'no decision-time prices); live decisions never assume a price: without a captured price '
                             'break-even, probability edge and every EV are null'),
        'side_convention': 'every probability is P(the side covers | no push); a map is applied to the side\'s own pure probability',
        'cover_calibration': cover_cal,
        'market_shrinkage': shrink,
        'push_table': push_table_js(pt),
        'push_table_detail': pt,
        'ev_curve': {'input': 'theoretical_ev', 'x': ev['x'], 'y': ev['y'], 'tau2': ev['tau2'], 'price': ev['price'],
                     'method': ev['method'], 'bins': ev['bins'],
                     'note': 'input is the THEORETICAL EV (pure probability at the price); output the expected realized EV per unit at that price'},
        'ev_curve_decision': {'input': 'decision_ev', 'x': evd['x'], 'y': evd['y'], 'tau2': evd['tau2'], 'bins': evd['bins'],
                              'method': evd['method'], 'fit_rows': evd['fit_rows']},
        'p_positive_clv': pclv,
        'clv_magnitude': _clean_model(s19['final']['linear'], 'expected side-oriented CLV points (fit on CLV clipped at +/-%g); features picked walk-forward: %s'
                                      % (s19['winsor_clv_fit'], s19['picked']['linear'])),
        'bet_confidence': dict(pclv, note='bet_confidence = P(positive CLV) (the p_positive_clv model); score = round(100 p). It targets CLV, not wins'),
        'football_confidence': _clean_model(fb['final_model'], 'expected |final margin - projected margin| (points); pure inputs only'),
        'football_confidence_scale': {
            'score_from_expected_abs_error': {'x': [e_lo, e_hi], 'y': [100.0, 0.0]},
            'expected_abs_error_from_score': {'x': [0.0, 100.0], 'y': [e_hi, e_lo]},
            'note': 'DECLARED absolute scale, linear and clamped: 100 = 10 pts expected |error|, 0 = 16 pts. Not fitted, so the '
                    'score shows how much the data can separate games: on DEV FBS games it cannot (see evidence)'},
        'reliability_scale': {'expected_abs_error': fb['reliability_scale'],
                              'input': 'reliability = engine.js football_prediction_confidence (0-100)',
                              'method': 'mean |error| per production-score band (<40, 40-60, 60-75, 75-90, 90+; knot = the band\'s mean score), '
                                        'normal-normal empirical Bayes toward the pooled mean, then PAV (non-increasing); DEV FBS games 2017-2023',
                              'tau2': fb['reliability_scale_detail']['tau2'], 'bands': fb['reliability_scale_detail']['bands']},
        'market_confidence': _clean_model(mk['final_model'], 'expected |close - quote| (points): how unsettled the quoted number is; point-in-time inputs only'),
        'market_confidence_scale': {
            'score_from_expected_abs_move': {'x': [m_lo, m_hi], 'y': [100.0, 0.0]},
            'expected_abs_move_from_score': {'x': [0.0, 100.0], 'y': [m_hi, m_lo]},
            'note': 'DECLARED absolute scale: 100 = 0.5 pt expected |close - quote|, 0 = 3 pts'},
        'features': FEATURE_DOC,
        'schema_doc': {
            'probability_map': 'identity | platt{a,b}: sigmoid(a+b*logit p) | beta{a,b,c}: sigmoid(c+a ln p-b ln(1-p)) | '
                               'isotonic{x,y}: interp clamped then clamped to [1e-4,1-1e-4] | logit_pwl{x,y}: sigmoid(interp(logit p)); p clamped to [1e-4,1-1e-4] before logit',
            'cover_calibration': '{map: <probability map>} or {conditional: {by, bins, maps}} (bin i = first edge v is below; len(bins) past the last)',
            'market_shrinkage': 'decision = sigmoid(w logit(calibrated) + (1-w) logit(market)) (space logit)',
            'model': 'z = intercept + sum coef_k (x_k - mu_k)/sd_k; missing x -> fill_k; logistic -> sigmoid(z)',
            'interp_table': '{x ascending, y}: linear interpolation, clamped at both ends',
            'push_table': '{"lo-hi": p}: integer lines only, first bucket with lo <= |line| <= hi, else 0.02; half-point lines 0',
            'ev': 'EV = p (1 - push) b - (1 - p)(1 - push), b = payout per unit at the side\'s American price'},
        'evidence': 'evidence.json in this directory; docs/cfb-decision/CALIBRATION.md',
    }
    with open(CAL_JSON, 'w') as f:
        json.dump(A, f, indent=1, sort_keys=True, default=_js)
        f.write('\n')
    A = json.load(open(CAL_JSON))                  # the fixture is computed from the file exactly as written
    fx = fixture_cases(A, Wd)
    with open(FIXTURE, 'w') as f:
        json.dump({'artifact': ARTIFACT_VERSION, 'artifact_sha256': sha256_file(CAL_JSON), 'schema': DECISION_SCHEMA,
                   'generated_by': 'v2.decision.reference.evaluate', 'tolerance': 1e-6,
                   'side_rule': 'the larger probability edge when both sides are priced, else the larger decision probability (decision.js decideQuote)',
                   'cases': fx}, f, indent=1, sort_keys=True, default=_js)
        f.write('\n')
    evidence = {'s05': {k: s5[k] for k in ('chosen', 'best_eligible', 'rule', 'n_scored_nonpush')},
                's05_methods': {k: {kk: v.get(kk) for kk in ('log_loss', 'brier', 'ece_adaptive10', 'dll_vs_market', 'dll_vs_market_ci', 'eligible')}
                                for k, v in s5['methods'].items()},
                'shrink_weight': s5['shrink_weight'], 'w_on_top_of_each_map': s5['w_on_top_of_each_map'],
                'cover_buckets_pure': s4['pure_buckets_scored'], 'cover_buckets_decision': s4['decision_buckets_scored'],
                'conditional_tests': {k: {kk: v[kk] for kk in ('lr_test_dev_2017_2023', 'walk_forward_dll_conditional_minus_single',
                                                                'walk_forward_dll_ci', 'adopted', 'w_by_group')}
                                      for k, v in cond.items() if isinstance(v, dict) and 'adopted' in v},
                'ev_evaluation': s10['evaluation_scored'], 'edge': {k: s14[k] for k in ('by_season', 'edge_positive', 'edge_nonpositive')},
                'clv_models': s19['walk_forward'], 'football_confidence': {k: fb[k] for k in ('candidates_walk_forward', 'picked', 'sigma_quintiles', 'reliability_bands_production_score',
                                                              'reliability_slope_per_10pts', 'reliability_slope_ci', 'disagreement_vs_standardized_error')},
                'market_confidence': {k: mk[k] for k in ('candidates_walk_forward', 'picked')},
                'rank_order_tests': {k: v['tests'] for k, v in s33.items() if isinstance(v, dict) and 'tests' in v},
                'season_2020': s20, 'price_sensitivity': ps, 'populations': summary['populations']}
    ev_path = os.path.join(ART_DIR, 'evidence.json')
    with open(ev_path, 'w') as f:
        json.dump(evidence, f, indent=1, sort_keys=True, default=_js)
        f.write('\n')
    code_dir = os.path.dirname(os.path.abspath(__file__))
    man = {'artifact': ARTIFACT_VERSION, 'schema': DECISION_SCHEMA, 'base_model_version': BASE_MODEL_VERSION,
           'baseline': BASELINE_ID, 'baseline_manifest_sha256': sha256_file(BASELINE_MANIFEST),
           'created_at': A['created_at'],
           'files': {'calibration.json': sha256_file(CAL_JSON), 'evidence.json': sha256_file(ev_path),
                     '../fixtures/decision_parity.json': sha256_file(FIXTURE)},
           'dataset': {'path': 'football/cfb_v2/research/out_h/decision/decision_dataset.parquet',
                       'file_sha256': sha256_file(os.path.join(DS.out_dir(), 'decision_dataset.parquet'))},
           'fit_code_sha256': {f: sha256_file(os.path.join(code_dir, f)) for f in FIT_CODE},
           'fit_window': 'DEV 2016-2023 (priced 2017-2019, 2021-2023; 2020 has no openers)',
           'holdout_scored': False,
           'holdout_rule': 'the policy agent applies this frozen artifact to 2024 AND 2025 once, after its thresholds are frozen; nothing is refit',
           'live': 'no priced live quote exists yet: every live EV is null'}
    with open(os.path.join(ART_DIR, 'MANIFEST.json'), 'w') as f:
        json.dump(man, f, indent=1, sort_keys=True)
        f.write('\n')
    print('[freeze] wrote', ART_DIR, 'and', FIXTURE, '(%d cases)' % len(fx))
    return A


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, float) and not np.isfinite(o):
        return None
    raise TypeError(type(o))
