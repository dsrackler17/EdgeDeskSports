"""Apply the PRE-REGISTERED hardening rules (docs/cfb-v2/HARDENING_PREREG.md)
mechanically, on the development window only, and write the decisions.

    python3 -m v2.harden --variants-root <dir with out_fix, out_ps2, ...>

Reads the red-team results for candidate 001 (phase 6 components/stacking,
phase 7 ablation, phase 9 calibration, phase 19 QB) and evaluates the
update-speed rebuilds (R5) against the same-code baseline. Nothing here reads
a holdout outcome: every comparison is restricted to DEV seasons.
Output: report/redteam/hardening_decisions.json
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import redteam as RTM
from . import rt_walkforward as RT

HERE = os.path.dirname(os.path.abspath(__file__))
RD = os.path.join(HERE, '..', 'report', 'redteam')
DEV = list(C.DEV_SEASONS)


def J(name):
    return json.load(open(os.path.join(RD, name + '.json')))


def dev_mae_paired(Xa, Xb, spec, comps, method):
    """dev MAE of configuration a minus b (same games), with a paired bootstrap CI."""
    ra = RT.run(Xa, spec, comps=comps, method=method, probs=False)['D']
    rb = RT.run(Xb, spec, comps=comps, method=method, probs=False)['D']
    j = ra[['game_id', 'season', 'status', 'fcs_game', 'margin', 'pred']].merge(
        rb[['game_id', 'pred']], on='game_id', suffixes=('_a', '_b'))
    d = RTM.fbs_fin(j, DEV).dropna(subset=['pred_a', 'pred_b'])
    diff = (d.pred_a - d.margin).abs() - (d.pred_b - d.margin).abs()
    return {'n': int(len(d)), 'mae_a': RTM.r4((d.pred_a - d.margin).abs().mean()),
            'mae_b': RTM.r4((d.pred_b - d.margin).abs().mean()),
            'diff': RTM.r4(diff.mean()), 'ci': [RTM.r4(v) for v in RTM.boot(diff.values)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants-root', required=True)
    a = ap.parse_args()
    fam = json.load(open(os.path.join(HERE, '..', 'report', 'selected_families.json')))
    out = {'rules': 'docs/cfb-v2/HARDENING_PREREG.md', 'window': 'development 2016-2023 only'}

    # R2 components
    p6 = J('phase06_ensembles')
    drop1 = {k: v['dev']['diff'] for k, v in p6['drop_one_component'].items()}
    keep = [k for k, d in drop1.items() if d is not None and d > 0.005]
    if not any(k in keep for k in ('A_adj_eff', 'C_ridge', 'D_gbm', 'E_drive')):
        keep.append('C_ridge')
    out['R2_components'] = {'dev_drop_one_delta_mae': drop1, 'threshold': 0.005, 'keep': keep,
                            'drop': [k for k in drop1 if k not in keep]}

    # R4 feature groups (drop REMOVE groups; RETEST stays)
    p7 = J('phase07_ablation')
    remove = [g for g, v in p7['groups'].items() if v.get('decision') == 'REMOVE']
    drop_cols = sorted({c for g in remove for c in p7['groups'][g]['cols_removed']})
    out['R4_feature_groups'] = {g: v.get('decision', v.get('status')) for g, v in p7['groups'].items()}
    out['R4_prior_rebuilds'] = {g: v.get('decision', v.get('status')) for g, v in p7['prior_rebuilds'].items()}
    out['R4_removed_groups'] = remove
    out['R4_removed_columns'] = drop_cols

    # R3 + joint check on candidate 001's snapshots
    X, _ = RTM.load(os.path.join(a.variants_root, 'out_c001'))
    base = RT.run(X, RT.Spec(fam['C'], fam['D']), probs=False)['D']
    specs = {}
    for method in ('sum_to_one_nonneg', 'mean'):
        r = RT.run(X, RT.Spec(fam['C'], fam['D'], drop=drop_cols), comps=keep, method=method, probs=False)['D']
        d = RTM.fbs_fin(r, DEV).dropna(subset=['pred'])
        specs[method] = RTM.r4((d.pred - d.margin).abs().mean())
    method = 'mean' if specs['mean'] <= specs['sum_to_one_nonneg'] + 0.01 else 'sum_to_one_nonneg'
    b = RTM.fbs_fin(base, DEV).dropna(subset=['pred'])
    c001 = RTM.r4((b.pred - b.margin).abs().mean())
    out['R3_combination'] = {'dev_mae': specs, 'tolerance': 0.01, 'chosen': method}
    joint = specs[method]
    restored = []
    order = sorted(remove, key=lambda g: -(p7['groups'][g]['dev']['d_mae'] or 0))
    while joint - c001 > 0.01 and order:
        g = order.pop(0)
        restored.append(g)
        drop_cols = sorted({c for gg in remove if gg not in restored for c in p7['groups'][gg]['cols_removed']})
        r = RT.run(X, RT.Spec(fam['C'], fam['D'], drop=drop_cols), comps=keep, method=method, probs=False)['D']
        d = RTM.fbs_fin(r, DEV).dropna(subset=['pred'])
        joint = RTM.r4((d.pred - d.margin).abs().mean())
    out['R4_joint_check'] = {'candidate_001_dev_mae': c001, 'simplified_dev_mae': joint, 'tolerance': 0.01,
                             'restored_groups': restored, 'final_removed_columns': drop_cols}

    # R5 update speed: variants vs the same-code baseline, final architecture
    spec = RT.Spec(fam['C'], fam['D'], drop=drop_cols)
    Xf, _ = RTM.load(os.path.join(a.variants_root, 'out_fix'))
    r5 = {}
    for v in ('ps2', 'ps4', 'hl4'):
        p = os.path.join(a.variants_root, 'out_' + v)
        if not os.path.exists(os.path.join(p, 'stage5', 'cfb_model_training_snapshots.parquet')):
            r5[v] = {'status': 'not built'}
            continue
        Xv, _ = RTM.load(p)
        res = dev_mae_paired(Xv, Xf, spec, keep, method)
        res['qualifies'] = bool(res['diff'] is not None and res['diff'] <= -0.02 and res['ci'][1] < 0)
        r5[v] = res
    q = {k: v for k, v in r5.items() if v.get('qualifies')}
    out['R5_update_speed'] = {'variants': r5, 'rule': 'adopt if dev MAE improves by >= 0.02 with CI < 0',
                              'adopted': (min(q, key=lambda k: q[k]['diff']) if q else None)}

    # R6 calibration choices (dev log loss, candidate 001's analysis; re-checked on the hardened build)
    p9 = J('phase09_calibration')
    out['R6_calibration'] = {'win': p9['win_choice_dev_logloss'], 'cover': p9['cover_choice_dev_logloss']}

    # R8 QB overlay from DEV surprise changes only
    out['R8_qb_overlay'] = qb_overlay_dev(a.variants_root)
    os.makedirs(RD, exist_ok=True)
    with open(os.path.join(RD, 'hardening_decisions.json'), 'w') as f:
        json.dump(out, f, indent=1, default=str)
        f.write('\n')
    print(json.dumps(out, indent=1, default=str))


def qb_overlay_dev(root):
    """Mean team residual of UNEXPECTED starter changes, dev seasons only."""
    X, MK = RTM.load(os.path.join(root, 'out_c001'))
    fam = json.load(open(os.path.join(HERE, '..', 'report', 'selected_families.json')))
    D = RTM.attach_market(RT.run(X, RT.Spec(fam['C'], fam['D']))['D'], MK)
    ratings, Q = RTM.qb_ratings_at_games(os.path.join(root, 'out'))
    st = Q[Q.starter].drop_duplicates(['game_id', 'team_id']).set_index(['game_id', 'team_id']).qb_id
    J_ = D.merge(X[['game_id', 'h_qb_id', 'a_qb_id']], on='game_id', how='left')
    J_ = RTM.fbs_fin(J_, DEV)
    rows = []
    for side, sgn, tcol in (('h', 1.0, 'home_id'), ('a', -1.0, 'away_id')):
        for g, t, e, m, p in zip(J_.game_id, J_[tcol], J_[side + '_qb_id'], J_.margin, J_.pred):
            act = st.get((g, t))
            if act is None or pd.isna(e) or pd.isna(p):
                continue
            cdb = ratings.get((g, act), (np.nan, np.nan, None))[1]
            rows.append((int(e) != int(act), cdb == 0, sgn * (m - p)))
    R = pd.DataFrame(rows, columns=['changed', 'first_time', 'resid'])
    ch, same = R[R.changed], R[~R.changed]
    ft = ch[ch.first_time]
    same_ci = RTM.boot(same.resid.values)
    out = {'same starter': {'n': int(len(same)), 'mean_resid': RTM.r4(same.resid.mean()),
                            'ci': [RTM.r4(v) for v in same_ci]},
           'baseline_same_starter_rate_dev': RTM.r4(len(same) / (len(same) + len(ch))),
           'delta_change_minus_same': RTM.r4(ch.resid.mean() - same.resid.mean()),
           'delta_ci': [RTM.r4(v) for v in RTM._boot_diff(ch.resid.values, same.resid.values)]}
    for name, d in (('any unexpected change', ch), ('first-time starter', ft)):
        ci = RTM.boot(d.resid.values)
        out[name] = {'n': int(len(d)), 'mean_resid': RTM.r4(d.resid.mean()), 'ci': [RTM.r4(v) for v in ci],
                     'applied': bool(ci[1] is not None and ci[1] < 0),
                     'excess_var_pts2': RTM.r4(max(0.0, d.resid.var() - same.resid.var()))}
    return out


if __name__ == '__main__':
    main()
