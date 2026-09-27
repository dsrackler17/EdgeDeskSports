"""Grouped feature ablation, DEVELOPMENT seasons only.

Order (from the data-pack drop-in):
  base -> adj_eff -> drive -> trench_havoc -> matchup -> form -> special_teams
  -> qb -> volatile -> context

For the ridge (C) and the gradient-boosted model (D) separately, each family
is ADDED to the running set and kept only if, over the dev seasons 2016-2023,
  (1) walk-forward MAE falls, and
  (2) it falls in at least half of the individual dev seasons (stability).
Then every kept family is removed once from the final set (drop-one) to show
what each one is worth at the margin.

The holdout seasons are never predicted here: the walk-forward stops at 2023.
Result -> report/ablation.json and report/selected_families.json
"""
import json

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import models as MD
from . import walkforward as WF
from . import evaluate as EV

DEV = list(C.DEV_SEASONS)
PRED_SEASONS = list(range(C.FIRST_OOF_SEASON, max(DEV) + 1))


def oof(X, model, fams):
    C.assert_dev_only(PRED_SEASONS)
    rows = []
    for S in PRED_SEASONS:
        tr = WF.modeling_rows(X)
        tr = tr[(tr.season < S) & (tr.season >= C.FIRST_SNAPSHOT_SEASON)]
        m = MD.ModelC(fams) if model == 'C' else MD.ModelD(fams)
        m.fit(tr, tr.margin.values.astype(float))
        te = WF.modeling_rows(X[X.season.eq(S)])
        rows.append(pd.DataFrame({'season': S, 'y': te.margin.values, 'p': m.predict(te)}, index=te.index))
    return pd.concat(rows)


def score(P):
    d = P[P.season.isin(DEV)]
    per = d.assign(ae=(d.p - d.y).abs()).groupby('season').ae.mean()
    return float((d.p - d.y).abs().mean()), per


def run(X):
    X = MD.add_derived(X)
    out = {}
    selected = {}
    for model in ('C', 'D'):
        steps, keep = [], []
        prev_mae, prev_per, prev_P = None, None, None
        for fam in MD.ABLATION_ORDER:
            trial = keep + [fam]
            P = oof(X, model, trial)
            mae, per = score(P)
            if prev_mae is None:
                decision, better_share = True, None
            else:
                better_share = float((per < prev_per).mean())
                decision = (mae < prev_mae) and better_share >= 0.5
            d = EV.paired_mae_diff(P.y[P.season.isin(DEV)], P.p[P.season.isin(DEV)],
                                   prev_P.p[prev_P.season.isin(DEV)]) if prev_P is not None else None
            steps.append({'family': fam, 'mae_dev': mae, 'delta_vs_prev': None if prev_mae is None else mae - prev_mae,
                          'paired_ci': d['ci'] if d else None, 'seasons_improved_share': better_share,
                          'kept': bool(decision), 'per_season': {int(k): float(v) for k, v in per.items()}})
            print(model, fam, round(mae, 4), 'kept' if decision else 'dropped', better_share, flush=True)
            if decision:
                keep = trial
                prev_mae, prev_per, prev_P = mae, per, P
        # backward elimination: a family whose removal LOWERS dev MAE (and does
        # not raise it in most seasons) is redundant given the others -> removed
        forward = list(keep)
        rounds = []
        while True:
            drop_one = {}
            for fam in keep:
                if fam == 'base':
                    continue
                P = oof(X, model, [f for f in keep if f != fam])
                mae, per = score(P)
                drop_one[fam] = {'mae_without': mae, 'delta_if_removed': mae - prev_mae,
                                 'seasons_better_without': float((per < prev_per).mean())}
            rounds.append(drop_one)
            cand = [(v['delta_if_removed'], f) for f, v in drop_one.items()
                    if v['delta_if_removed'] < 0 and v['seasons_better_without'] >= 0.5]
            if not cand:
                break
            _, worst = min(cand)
            keep = [f for f in keep if f != worst]
            prev_mae = drop_one[worst]['mae_without']
            prev_P = oof(X, model, keep)
            prev_mae, prev_per = score(prev_P)
            print(model, 'backward: removed', worst, round(prev_mae, 4), flush=True)
        out[model] = {'steps': steps, 'forward_selected': forward, 'selected': keep,
                      'final_mae_dev': prev_mae, 'drop_one': rounds[-1], 'backward_rounds': rounds}
        selected[model] = keep
    common.write_json(common.out_path('report', 'ablation.json'), out)
    common.write_json(common.out_path('report', 'selected_families.json'), selected)
    return out


if __name__ == '__main__':
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    run(X)
