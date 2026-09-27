"""Champion / challenger promotion gates — PRE-REGISTERED.

These thresholds were written into this file before the holdout seasons were
scored (see the commit history). They are evaluated once, on the frozen
configuration, and never edited to make a challenger pass.

Champion: V1 (edgedesk_cfb_p4_v1.0.0), replayed cold from 2004.
Challenger: V2 (this pipeline).
Scope: FBS-vs-FBS games both models priced, holdout seasons 2024-2025.

A passing challenger is ELIGIBLE for promotion. It still does not replace V1
automatically: the production flag (CFB_MODEL_CHAMPION / params.promotion)
must be switched by a person. BET status is separately gated.
"""
import numpy as np

GATES = {
    'G1_mae': 'holdout spread MAE: V2 < V1 and the paired bootstrap 95% CI of (V2 - V1) is entirely below 0',
    'G2_rmse': 'holdout RMSE: V2 < V1',
    'G3_brier': 'holdout win-probability Brier (shipped calibration): V2 < V1',
    'G4_calibration': 'holdout win-probability ECE <= 0.03',
    'G5_coverage': 'holdout interval coverage within 50%: 0.47-0.53, 80%: 0.77-0.83, 95%: 0.93-0.97',
    'G6_stability': 'V2 MAE <= V1 MAE in EVERY holdout season and in >= 6 of 8 dev seasons',
    'G7_subgroups': 'no holdout subgroup (week, P4/G5, spread size; n >= 100) where V2 MAE exceeds V1 by > 0.75',
}
BET_GATE = ('BET enabled only if the dev-selected rule had a positive lower 90% ROI bound and positive '
            'CLV on dev, AND on holdout its plays show positive mean CLV and positive ROI. Tightened before '
            'the holdout was scored (commit ab83459): the dev rule must also beat the 95th percentile of the '
            'same threshold search run on 500 coin-flip worlds (a reality check against threshold mining)')


def evaluate(rep, win_key):
    H = rep['windows']['holdout_2024_2025']
    Dv = rep['windows']['dev_2016_2023']
    acc = H['accuracy']['accuracy']
    passed, failed, detail = [], [], {}

    def gate(k, ok, info):
        detail[k] = {'rule': GATES[k], 'pass': bool(ok), 'evidence': info}
        (passed if ok else failed).append(k)

    v2, v1 = acc.get('ens_pred', {}), acc.get('base_v1', {})
    pd_ = H['accuracy']['paired_vs_v2'].get('base_v1', {})
    ci = pd_.get('ci') or [None, None]
    gate('G1_mae', v2.get('mae') is not None and v1.get('mae') is not None and v2['mae'] < v1['mae']
         and ci[1] is not None and ci[1] < 0, {'v2': v2.get('mae'), 'v1': v1.get('mae'), 'diff_ci': ci})
    gate('G2_rmse', v2.get('rmse', 9e9) < v1.get('rmse', -1), {'v2': v2.get('rmse'), 'v1': v1.get('rmse')})
    wp = H['accuracy']['win_prob']
    b2, b1 = wp.get(win_key, {}).get('brier'), wp.get('base_v1_winprob', {}).get('brier')
    gate('G3_brier', b2 is not None and b1 is not None and b2 < b1, {'v2': b2, 'v1': b1})
    ece = wp.get(win_key, {}).get('ece')
    gate('G4_calibration', ece is not None and ece <= 0.03, {'ece': ece})
    cv = H['accuracy']['intervals']
    # keys are ints in memory and strings once the report has been through JSON
    c50, c80, c95 = ((cv.get(q) or cv.get(str(q)) or {}).get('coverage') for q in (50, 80, 95))
    gate('G5_coverage', None not in (c50, c80, c95) and 0.47 <= c50 <= 0.53 and 0.77 <= c80 <= 0.83
         and 0.93 <= c95 <= 0.97, {'50': c50, '80': c80, '95': c95})
    sg_h = H['subgroups'].get('season', {})
    sg_d = Dv['subgroups'].get('season', {})
    hold_ok = all(v.get('mae_v2_same_base_v1', 9e9) <= v.get('mae_base_v1', -1) for v in sg_h.values()) and len(sg_h) > 0
    dev_wins = sum(v.get('mae_v2_same_base_v1', 9e9) <= v.get('mae_base_v1', -1) for v in sg_d.values())
    gate('G6_stability', hold_ok and dev_wins >= 6,
         {'holdout': {k: (v.get('mae_v2_same_base_v1'), v.get('mae_base_v1')) for k, v in sg_h.items()},
          'dev_seasons_v2_better': dev_wins, 'dev_seasons': len(sg_d)})
    worst = []
    for key in ('week_bucket', 'p4_g5', 'spread_size'):
        for k, v in H['subgroups'].get(key, {}).items():
            if v.get('n', 0) >= 100 and 'mae_base_v1' in v:
                worst.append((key + ':' + k, v['mae_v2_same_base_v1'] - v['mae_base_v1']))
    gate('G7_subgroups', all(d <= 0.75 for _, d in worst), {'max_regression': max(worst, key=lambda x: x[1]) if worst else None})
    # BET gate
    rule = rep['rule']
    hb = H['betting']['by_status'].get('BET', {})
    bet_allowed = bool(rule.get('bet_enabled') and hb.get('n', 0) > 0 and (hb.get('clv_mean') or -1) > 0
                       and (hb.get('roi_per_bet') or -1) > 0)
    decision = 'ELIGIBLE_FOR_PROMOTION' if not failed else 'KEEP_V1'
    return {'decision': decision,
            'champion': 'V1 (V2 is eligible; the switch is a person setting the flag)' if not failed else 'V1',
            'passed': passed, 'failed': failed, 'detail': detail, 'bet_allowed': bet_allowed,
            'bet_gate': BET_GATE, 'bet_evidence': {'dev_rule': rule.get('dev_best'), 'holdout_bet': hb},
            'automatic_replacement': False,
            'note': 'A pass makes V2 eligible. Production switches only when a person sets the flag.'}
