"""Dev-only hyperparameter search for Model C (ridge alpha) and Model D (GBM).

Walk-forward over 2014-2023, scored on the dev seasons 2016-2023.
Result -> report/tuning_models.json. config.py is then set from it by hand,
with the file cited, so the chosen value and its evidence travel together.
"""
import json
import sys

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import models as MD
from .ablation import oof, score

GBM_GRID = {
    'g0_current': dict(C.GBM_PARAMS),
    'g1_shallow': dict(C.GBM_PARAMS, num_leaves=7, min_data_in_leaf=100, n_estimators=500),
    'g2_slow_reg': dict(C.GBM_PARAMS, num_leaves=7, min_data_in_leaf=150, lambda_l2=30.0,
                        learning_rate=0.02, n_estimators=900),
    'g3_l2loss': dict(C.GBM_PARAMS, objective='regression', n_estimators=500),
    'g4_fewer': dict(C.GBM_PARAMS, num_leaves=7, min_data_in_leaf=100, n_estimators=250,
                     learning_rate=0.03),
    'g5_linear_tree': dict(C.GBM_PARAMS, num_leaves=7, min_data_in_leaf=150, n_estimators=400,
                           linear_tree=True, linear_lambda=10.0),
    'g6_tiny': dict(C.GBM_PARAMS, num_leaves=5, min_data_in_leaf=150, n_estimators=200),
    'g7_short': dict(C.GBM_PARAMS, num_leaves=7, min_data_in_leaf=100, n_estimators=150),
}
EXTRA = ['g6_tiny', 'g7_short']


def main(which):
    X = MD.add_derived(pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet')))
    fam = json.load(open(common.out_path('report', 'selected_families.json')))
    res = {}
    if which in ('C', 'all'):
        for a in (3.0, 10.0, 30.0, 100.0, 300.0):
            C.RIDGE_ALPHA = a
            mae, per = score(oof(X, 'C', fam['C']))
            res['C_alpha_%g' % a] = mae
            print('C alpha', a, round(mae, 4), flush=True)
    if which in ('D', 'all', 'D2'):
        base = dict(C.GBM_PARAMS)
        grid = GBM_GRID if which == 'D' else {k: GBM_GRID[k] for k in EXTRA}
        for k, p in grid.items():
            C.GBM_PARAMS.clear(); C.GBM_PARAMS.update(p)
            mae, per = score(oof(X, 'D', fam['D']))
            res['D_' + k] = mae
            print('D', k, round(mae, 4), flush=True)
        C.GBM_PARAMS.clear(); C.GBM_PARAMS.update(base)
    common.write_json(common.out_path('report', 'tuning_models_%s.json' % which), res)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'all')
