"""Export the frozen model version: auditable artifacts + the browser params.

Writes (repo paths, relative to football/cfb_v2/):
  artifacts/<model_version>/models.json     linear submodels, stack, sigma model, calibration
  artifacts/<model_version>/gbm_D.txt       LightGBM model (text, human-readable trees)
  artifacts/<model_version>/meta.json       windows, tuning, data provenance, gates
  params.js                                 window.EDCfbV2Params for engine.js

Artifacts are the fits whose training data ends with the last completed
season (trained_through = 2025): exactly the models that produced the 2026
walk-forward rows. Nothing here is refit.
"""
import json
import os
import pickle
from datetime import datetime, timezone

import numpy as np

from . import config as C
from . import common
from . import walkforward as WF

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

# DECLARED, not fitted — each labelled as such in params and the model card.
STATUS_START_PROB = {'confirmed': 0.99, 'probable': 0.85, 'questionable': 0.5, 'gtd': 0.5,
                     'doubtful': 0.2, 'out': 0.0}
INJURY = {'points_applied': False, 'unit_caps': {'OL': 0.6, 'SKILL': 0.6, 'FRONT7': 0.6, 'SECONDARY': 0.6},
          'team_cap': 1.5, 'var_pts_per_unit': 3.0,
          'basis': 'DECLARED: no archived pregame injury reports or snap counts exist in any reachable feed, '
                   'so no position coefficient can be trained. Capped availability loss WIDENS the '
                   'distribution (3 pts SD per fully-missing unit) and never moves the mean.'}
WEATHER = {'points_applied': False, 'wind_threshold_mph': 15, 'var_pts_per_wind_mph': 0.25,
           'basis': 'DECLARED: no archived pregame forecasts reachable; forecasts widen the interval only.'}
MARKET = {'stale_minutes': 180, 'dispersion_max': 1.5, 'orientation_gap': 21, 'orientation_reconcile': 7}


def linear_json(m):
    return {'cols': list(m.cols), 'mean': [float(m.mean_[c]) for c in m.cols],
            'sd': [float(m.sd_[c]) for c in m.cols], 'beta': [float(b) for b in m.beta_],
            'intercept': bool(m.intercept)}


def qb_coefficient():
    """Points of margin per 1.0 EPA/dropback of quarterback change.

    Measured, not assumed: the slope of the out-of-fold residual of the ridge
    (whose selected families contain NO quarterback feature) on qb_delta_edge,
    over 2014-2023 (never the holdout). Applied to the mean only if |t| > 2;
    otherwise status reports widen the distribution and move nothing."""
    import pandas as pd
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    d = M[M.status.eq('FINAL') & ~M.fcs_game & M.season.between(C.FIRST_OOF_SEASON, max(C.DEV_SEASONS))
          & (M.qb_delta_edge.abs() > 1e-9)]
    r = (d.margin - d.pred_C_ridge).values
    x = d.qb_delta_edge.values
    b = float(np.sum(x * r) / np.sum(x * x))
    se = float(np.sqrt(np.sum((r - b * x) ** 2) / (len(x) - 1) / np.sum(x * x)))
    return {'points_per_epa_db': b, 'se': se, 't': b / se, 'n': int(len(x)),
            'seasons': [C.FIRST_OOF_SEASON, max(C.DEV_SEASONS)], 'applied': bool(abs(b / se) > 2 and b > 0)}


def monitoring_reference(weights):
    """What 'normal' looked like in the walk-forward, for the live health
    warnings (v2.monitor): holdout accuracy, the C/D disagreement tail, and the
    development-window distribution of the drift-watched inputs."""
    import pandas as pd
    B = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    f = B[B.status.eq('FINAL') & ~B.fcs_game & B.ens_pred.notna()]
    h = f[f.season.isin(C.HOLDOUT_SEASONS)]
    e = (h.ens_pred - h.margin).abs()
    yw = (h.margin > 0).astype(float)
    ref = {'mae': float(e.mean()), 'sd_abs_err': float(e.std()),
           'brier': float(((h.p_home_raw - yw) ** 2).mean()) if 'p_home_raw' in h else None,
           'stack_weights': {k: float(v) for k, v in weights.items()}, 'drift': {},
           'basis': 'holdout %s: accuracy, and input distributions at the same week of the season +/- 1'
                    % list(C.HOLDOUT_SEASONS)}
    if 'pred_C_ridge' in f and 'pred_D_gbm' in f:
        ref['c_d_abs_p99'] = float(np.nanpercentile((f.pred_C_ridge - f.pred_D_gbm).abs(), 99))
    # the MOST RECENT completed seasons (the same model generation as the live
    # season: error levels and schedules drift over a decade)
    d = f[f.season.isin(C.HOLDOUT_SEASONS)]
    # WEEK-MATCHED: games played, rating uncertainty and sigma depend on the
    # point of the season, so a week-5 slate is compared with week 3-5 history
    wk = np.floor(d.weeks_in.clip(lower=0))
    for k in range(0, 17):
        b = 'week%d' % k
        db = d[(wk >= k - 1) & (wk <= k + 1)]            # the same point of the season, +/- one week
        ref['drift'][b] = {}
        for k in ('ens_pred', 'sigma', 'ens_sd', 'pred_total'):
            if k in db and db[k].notna().sum() > 150:
                edges = np.unique(np.nanpercentile(db[k], np.linspace(0, 100, 11)))
                if len(edges) >= 3:
                    cnt = np.histogram(np.clip(db[k].dropna(), edges[0], edges[-1]), bins=edges)[0]
                    ref['drift'][b][k] = {'edges': [float(x) for x in edges],
                                          'share': [float(x) for x in (cnt + 0.5) / (cnt.sum() + 0.5 * len(cnt))]}
    return ref


def main(report_path=None):
    pk = common.out_path('stage7', 'fitted_last.pkl')
    with open(pk, 'rb') as f:
        L = pickle.load(f)
    rep = json.load(open(report_path or common.out_path('report', 'backtest.json')))
    gates = json.load(open(common.out_path('report', 'promotion.json')))
    shrink = json.load(open(common.out_path('stage4', 'qb_shrinkage.json')))
    ms, tot = L['fitted']
    unc = L['unc']
    ver = C.MODEL_VERSION
    adir = os.path.join(REPO_V2, 'artifacts', ver)
    os.makedirs(adir, exist_ok=True)
    models = {k: linear_json(m) for k, m in ms.items() if k != 'D_gbm' and k in WF.SUB}
    models['TotalE'] = linear_json(tot)
    ms['D_gbm'].booster_.save_model(os.path.join(adir, 'gbm_D.txt'))
    models['D_gbm'] = {'cols': ms['D_gbm'].cols, 'file': 'gbm_D.txt',
                       'importance_gain_top20': dict(list(ms['D_gbm'].importance().items())[:20])}
    win_method = rep.get('win_calibration_choice', {}).get('method', 'platt')
    qbc = qb_coefficient()
    beta_qb, qb_applied = qbc['points_per_epa_db'], qbc['applied']
    # hardened QB overlay: a LEVEL effect of a starter change, measured on dev
    # (report/redteam/hardening_decisions.json R8), relative to the baseline
    # change rate the training data already contains
    hd_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'report', 'redteam',
                           'hardening_decisions.json')
    qb_level = None
    if os.path.exists(hd_path):
        r8 = json.load(open(hd_path)).get('R8_qb_overlay', {})
        ch = r8.get('any unexpected change', {})
        if ch.get('applied'):
            qb_level = {'change_delta_pts': r8['delta_change_minus_same'],
                        'change_delta_ci': r8['delta_ci'],
                        'baseline_same_starter': r8['baseline_same_starter_rate_dev'],
                        'change_excess_var_pts2': ch['excess_var_pts2'],
                        'n_changes_dev': ch['n']}
    art = {'model_version': ver, 'feature_version': C.FEATURE_VERSION, 'trained_through': C.LIVE_SEASON - 1,
           'submodels': models, 'stack_weights': L['W'], 'sigma_model': {'coef': unc['sigma_coef'],
           'mu': unc['sigma_mu'], 'sd': unc['sigma_sd'], 'cols': WF.SIGMA_COLS,
           'fill': unc.get('sigma_fill')},
           't_df': unc['t_df'], 'abs_z_quantiles': unc['abs_z_quantiles'],
           'win_calibration': {'method': win_method, 'platt': unc['platt'],
                               'iso': {'x': unc['iso_x'], 'y': unc['iso_y']}},
           'market': L['market'], 'rule': L['rule'], 'reliability_range': L['rel_range'],
           'families': {'C': L['fam_C'], 'D': L['fam_D']}}
    common.write_json(os.path.join(adir, 'models.json'), art)
    meta = {'model_version': ver, 'generated_at': common.iso(datetime.now(timezone.utc)),
            'monitoring_reference': monitoring_reference(L['W']),
            'seed': C.SEED, 'windows': {'dev': list(C.DEV_SEASONS), 'holdout': list(C.HOLDOUT_SEASONS),
                                        'live': C.LIVE_SEASON},
            'prior_scale': C.RATING_PRIOR_SCALE, 'recent_halflife_weeks': C.RECENT_HALFLIFE_WEEKS,
            'garbage': C.GARBAGE_MARGIN_BY_QTR, 'qb_shrinkage': shrink, 'promotion': gates}
    common.write_json(os.path.join(adir, 'meta.json'), meta)

    mk = L['market'] or {}
    params = {
        'engine': 'edgedesk_cfb_v2', 'model_version': ver, 'feature_version': C.FEATURE_VERSION,
        'trained_through': C.LIVE_SEASON - 1, 'generated_at': meta['generated_at'],
        'layers': {'pure_never_reads_market': True, 'market_reads_frozen_pure': True},
        'distribution': {'t_df': unc['t_df'],
                         'abs_z_quantiles': {str(k): float(v) for k, v in unc['abs_z_quantiles'].items()}},
        'calibration': {'win': {'method': win_method, 'platt': unc['platt'],
                                'iso': {'x': unc['iso_x'], 'y': unc['iso_y']}}},
        'cover': {'coef': mk.get('cover_cal'), 'push_table': mk.get('push_table'),
                  'rsd_fill': mk.get('cover_rsd_fill'),
                  'design': 'conditional platt on [1, x, x*ens_sd, x*rating_sd, x*early, x*qb_uncertainty]'},
        'clv': {'beta': mk.get('clv_beta')},
        'qb': dict({'model': 'level', 'applied': True,
                    'basis': 'MEASURED on dev 2016-2023: teams whose starter changed unexpectedly (the '
                             'snapshot expected last game\'s starter) did %.2f pts worse than same-starter '
                             'games; applied relative to the baseline change rate already in the training '
                             'data, so no report = no shift' % qb_level['change_delta_pts']}, **qb_level)
        if qb_level else {'points_per_epa_db': beta_qb, 'applied': qb_applied, 'evidence': qbc,
               'same_starter_prob': shrink.get('same_starter_prob'),
               'replacement_mean': shrink.get('replacement_mean'),
               'status_start_prob': STATUS_START_PROB,
               'status_basis': 'DECLARED mapping; calibration needs archived status reports (none exist)',
               'unknown_var_pts': 4.0},
        'qb_common': {'status_start_prob': STATUS_START_PROB, 'same_starter_prob': shrink.get('same_starter_prob'),
                      'status_basis': 'DECLARED mapping; calibration needs archived status reports (none exist)',
                      'retired': 'rating-gap coefficient %.2f pts per EPA/dropback: not supported by the dev '
                                 'surprise-change regression (report/redteam/phase19_qb.json)' % beta_qb},
        'injury': INJURY, 'weather': WEATHER,
        'reliability': {'sigma_lo': L['rel_range'][0], 'sigma_hi': L['rel_range'][1],
                        'caps': {'fcs': 50, 'no_games': 70, 'qb_unsettled': 75, 'qb_unknown': 65}},
        'market': dict(MARKET, rule={k: v for k, v in L['rule'].items() if k != 'dev_best'},
                       bet_enabled=bool(L['rule']['bet_enabled'] and gates.get('bet_allowed', False))),
        'promotion': {'decision': gates['decision'], 'champion': gates['champion'],
                      'passed': gates['passed'], 'failed': gates['failed']},
        'validation_summary': rep.get('headline', {}),
    }
    js = ('/* GENERATED by football/cfb_v2/research (v2.export). Never edit by hand.\n'
          '   The frozen parameters of %s: calibration, market rule, gates and the\n'
          '   declared (not fitted) overlays, each labelled. */\n'
          '(function (root) { root.EDCfbV2Params = %s; })(typeof window !== "undefined" ? window : '
          '(typeof globalThis !== "undefined" ? globalThis : this));\n') % (ver, json.dumps(params, indent=1, sort_keys=True, default=common._json_default))
    with open(os.path.join(REPO_V2, 'params.js'), 'w') as f:
        f.write(js)
    print('[export] wrote', adir, 'and params.js; bet_enabled', params['market']['bet_enabled'],
          'decision', gates['decision'])


if __name__ == '__main__':
    main()
