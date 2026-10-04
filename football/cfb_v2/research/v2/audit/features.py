"""Audit items 24-25 — feature correlation and extreme values of the V2.1 model inputs.

    python3 -m v2.audit.features    -> $CFB_V2_OUT/audit/features.json

1. Pairwise Pearson correlation of every C/D input on FBS-vs-FBS FINAL rows 2014-2026; pairs with
   |r| >= 0.95 (near-duplicates) and >= 0.90.
2. Extreme values: per input, rows with a robust z (median / MAD) beyond 8; the worst rows traced to
   the game and to the stage-3 inputs (games played before the freeze, the rating's posterior
   variance) so data errors can be told from signal.
3. Rating extremes at stage 3: team EPA/play offence or defence ratings beyond 4 robust SDs and the
   number of observations behind them.
"""
import json
import os

import numpy as np
import pandas as pd

from . import _io


def main():
    from v2 import models as MD
    art = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'artifacts', 'edgedesk_cfb_v2.1.0',
                                      'models.json')))
    cols = list(dict.fromkeys(art['submodels']['C_ridge']['cols'] + art['submodels']['D_gbm']['cols']))
    M = MD.add_derived(_io.preds())
    w = M[M.season.between(2014, 2026) & ~M.fcs_game].copy()
    Cm = w[cols].astype(float).corr()
    pairs = []
    for i, a in enumerate(cols):
        for b in cols[i + 1:]:
            r = Cm.loc[a, b]
            if abs(r) >= 0.90:
                pairs.append({'a': a, 'b': b, 'r': round(float(r), 4),
                              'in_C': [a in art['submodels']['C_ridge']['cols'], b in art['submodels']['C_ridge']['cols']],
                              'in_D': [a in art['submodels']['D_gbm']['cols'], b in art['submodels']['D_gbm']['cols']]})
    pairs.sort(key=lambda p: -abs(p['r']))
    # condition number of the standardized C design (redundancy under ridge)
    Z = w[art['submodels']['C_ridge']['cols']].astype(float)
    Z = ((Z - Z.mean()) / Z.std()).fillna(0).values
    ev = np.linalg.eigvalsh(np.cov(Z.T))
    ext = []
    for c in cols:
        x = w[c].astype(float)
        med = x.median(); mad = (x - med).abs().median() * 1.4826
        if not mad or np.isnan(mad):
            continue
        z = (x - med) / mad
        k = z.abs() > 8
        if k.any():
            top = w.loc[z.abs().sort_values(ascending=False).index[:3]]
            ext.append({'feature': c, 'n_beyond_8': int(k.sum()), 'max_abs_z': float(z.abs().max()),
                        'worst': [{'game_id': int(r.game_id), 'season': int(r.season), 'week': int(r.week),
                                   'home': r.home_team, 'away': r.away_team, 'value': float(r[c]),
                                   'min_games_before_freeze': float(r.min_games), 'margin': r.margin,
                                   'ens_pred': float(r.ens_pred) if pd.notna(r.ens_pred) else None}
                                  for _, r in top.iterrows()]})
    ext.sort(key=lambda e: -e['max_abs_z'])
    # stage-3 rating extremes
    rows = []
    for S in range(2014, 2027):
        R = pd.read_parquet(os.path.join(_io.out_dir(), 'stage3', 'ratings_%d.parquet' % S),
                            columns=['team_id', 'metric', 'prediction_ts', 'off', 'def', 'n_obs_off', 'off_var'])
        R = R[R.metric.eq('epa')]
        for side in ('off', 'def'):
            x = R[side]; med = x.median(); mad = (x - med).abs().median() * 1.4826
            z = (x - med) / mad
            e = R[z.abs() > 4]
            rows.append({'season': S, 'side': side, 'rows': int(len(R)), 'beyond_4_robust_sd': int(len(e)),
                         'teams': int(e.team_id.nunique()), 'median_n_obs_of_extremes': float(e.n_obs_off.median()) if len(e) else None})
    out = {'doc': __doc__, 'n_rows': int(len(w)), 'n_inputs': len(cols), 'pairs_abs_r_ge_0.90': pairs,
           'n_pairs_ge_0.95': int(sum(abs(p['r']) >= 0.95 for p in pairs)), 'n_pairs_ge_0.90': len(pairs),
           'C_design_condition_number': float(np.sqrt(ev.max() / max(ev.min(), 1e-12))),
           'C_eigen_share_top3': [float(v) for v in sorted(ev, reverse=True)[:3] / ev.sum()],
           'extremes_robust_z_gt_8': ext, 'stage3_epa_rating_extremes': rows}
    _io.write('features.json', out)
    print('pairs>=.95', out['n_pairs_ge_0.95'], 'pairs>=.90', out['n_pairs_ge_0.90'], 'cond', out['C_design_condition_number'],
          'top3 eigen share', out['C_eigen_share_top3'])
    for p in pairs[:25]:
        print('  ', p)
    for e in ext[:12]:
        print('EXT', e['feature'], e['n_beyond_8'], round(e['max_abs_z'], 1), e['worst'][0])
    print(pd.DataFrame(rows).groupby('side')[['beyond_4_robust_sd', 'rows']].sum())


if __name__ == '__main__':
    main()
