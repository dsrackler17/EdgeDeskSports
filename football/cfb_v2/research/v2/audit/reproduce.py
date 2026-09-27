"""Audit item 3 — reproduce the model from raw data in an ISOLATED output directory.

    CFB_V2_OUT=<isolated dir> python3 -m v2.audit.reproduce build 2016 2024
    CFB_V2_OUT=out_h        python3 -m v2.audit.reproduce compare <isolated dir> 2016 2024
    CFB_V2_OUT=out_h        python3 -m v2.audit.reproduce refit            (stage 7 refit vs stored)

`build` runs the production stage code (plays -> games -> build_ratings -> qb -> elo ->
snapshots) for the selected seasons; stages that need every season as input (stage 2's
game table, stage 3's burn-in variance components and data-only finals) read stage-1
files that are rebuilt for the selected seasons and COPIED from the reference build for
the others (the copies are compared first, so the dependency is explicit).
`compare` diffs every shared column of every rebuilt table against the reference build.
`refit` refits stage 7 from the reference stage-5 table and diffs it against the stored
out-of-fold predictions; it also refits the target seasons from the REBUILT stage-5 rows.
Nothing here writes into the reference build except $CFB_V2_OUT/audit/.
"""
import json
import os
import shutil
import sys
import time

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.normpath(os.path.join(HERE, '..', '..'))


def _cmp_frames(a, b, keys, label):
    """Row-aligned comparison of two frames on `keys`: per-column max |diff| (numeric) or
    mismatch count (other), NaN-pattern mismatches, and rows missing on either side."""
    a = a.copy(); b = b.copy()
    for k in keys:
        if str(a[k].dtype).startswith('datetime'):
            a[k] = a[k].astype('int64'); b[k] = b[k].astype('int64')
    ka = a.set_index(keys); kb = b.set_index(keys)
    ka = ka[~ka.index.duplicated()]; kb = kb[~kb.index.duplicated()]
    common_idx = ka.index.intersection(kb.index)
    rep = {'table': label, 'rows_ref': int(len(kb)), 'rows_new': int(len(ka)), 'rows_common': int(len(common_idx)),
           'only_ref': int(len(kb.index.difference(ka.index))), 'only_new': int(len(ka.index.difference(kb.index))),
           'cols_only_ref': sorted(set(kb.columns) - set(ka.columns)),
           'cols_only_new': sorted(set(ka.columns) - set(kb.columns)), 'max_abs_diff': {}, 'nan_mismatch': {},
           'other_mismatch': {}}
    A_ = ka.loc[common_idx]; B_ = kb.loc[common_idx]
    for c in sorted(set(ka.columns) & set(kb.columns)):
        x, y = A_[c], B_[c]
        if pd.api.types.is_numeric_dtype(x) and pd.api.types.is_numeric_dtype(y) and not pd.api.types.is_bool_dtype(x):
            xv = x.astype(float).values; yv = y.astype(float).values
            nm = int((np.isnan(xv) != np.isnan(yv)).sum())
            ok = ~(np.isnan(xv) | np.isnan(yv))
            d = float(np.max(np.abs(xv[ok] - yv[ok]))) if ok.any() else 0.0
            if d > 0:
                rep['max_abs_diff'][c] = d
            if nm:
                rep['nan_mismatch'][c] = nm
        else:
            xs = x.astype(str).values; ys = y.astype(str).values
            n = int((xs != ys).sum())
            if n:
                rep['other_mismatch'][c] = n
    rep['worst'] = sorted(rep['max_abs_diff'].items(), key=lambda kv: -kv[1])[:10]
    rep['exact'] = (not rep['max_abs_diff'] and not rep['nan_mismatch'] and not rep['other_mismatch']
                    and rep['only_ref'] == 0 and rep['only_new'] == 0)
    rep['max_abs_diff_all'] = max(rep['max_abs_diff'].values()) if rep['max_abs_diff'] else 0.0
    return rep


def build(seasons, ref):
    from v2 import config as C, common, plays, games, build_ratings, qb, elo, snapshots
    t0 = time.time()
    log = {'seasons': seasons, 'ref': ref, 'out': C.OUT, 'steps': []}
    for S in seasons:
        agg, Q, g = plays.build_season(S)
        agg.to_parquet(common.out_path('stage1', 'team_game_%d.parquet' % S), index=False)
        Q.to_parquet(common.out_path('stage1', 'qb_game_%d.parquet' % S), index=False)
        g.to_parquet(common.out_path('stage1', 'games_%d.parquet' % S), index=False)
        log['steps'].append(('stage1', S, round(time.time() - t0)))
        print('[repro] stage1', S, round(time.time() - t0), flush=True)
    for S in range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1):
        if S in seasons:
            continue
        for p in ('team_game_%d', 'qb_game_%d', 'games_%d'):
            shutil.copy(os.path.join(ref, 'stage1', (p % S) + '.parquet'), common.out_path('stage1', (p % S) + '.parquet'))
    games.main()
    log['steps'].append(('stage2', round(time.time() - t0)))
    print('[repro] stage2', round(time.time() - t0), flush=True)
    build_ratings.run(seasons_out=seasons)
    log['steps'].append(('stage3', round(time.time() - t0)))
    print('[repro] stage3', round(time.time() - t0), flush=True)
    qb.main(seasons)
    elo.main()
    log['steps'].append(('stage4', round(time.time() - t0)))
    print('[repro] stage4', round(time.time() - t0), flush=True)
    snapshots.main(seasons)
    log['steps'].append(('stage5', round(time.time() - t0)))
    common.write_json(common.out_path('build_log.json'), log)
    print('[repro] done', round(time.time() - t0), flush=True)


def compare(new, seasons):
    from v2 import config as C
    ref = C.OUT
    out = {'ref': ref, 'new': new, 'seasons': seasons, 'tables': []}
    rd = lambda d, *p: pd.read_parquet(os.path.join(d, *p))
    for S in seasons:
        out['tables'].append(_cmp_frames(rd(new, 'stage1', 'team_game_%d.parquet' % S),
                                         rd(ref, 'stage1', 'team_game_%d.parquet' % S), ['game_id', 'team_id'],
                                         'stage1/team_game_%d' % S))
        out['tables'].append(_cmp_frames(rd(new, 'stage1', 'qb_game_%d.parquet' % S),
                                         rd(ref, 'stage1', 'qb_game_%d.parquet' % S), ['game_id', 'team_id', 'qb_id'],
                                         'stage1/qb_game_%d' % S))
        out['tables'].append(_cmp_frames(rd(new, 'stage1', 'games_%d.parquet' % S).dropna(subset=['game_id']),
                                         rd(ref, 'stage1', 'games_%d.parquet' % S).dropna(subset=['game_id']),
                                         ['game_id'], 'stage1/games_%d' % S))
    ng, rg = rd(new, 'stage2', 'games.parquet'), rd(ref, 'stage2', 'games.parquet')
    out['tables'].append(_cmp_frames(ng, rg, ['game_id'], 'stage2/games'))
    out['tables'].append(_cmp_frames(rd(new, 'stage2', 'market.parquet'), rd(ref, 'stage2', 'market.parquet'),
                                     ['game_id'], 'stage2/market'))
    vn = json.load(open(os.path.join(new, 'stage3', 'varcomp.json')))
    vr = json.load(open(os.path.join(ref, 'stage3', 'varcomp.json')))
    out['varcomp_max_rel_diff'] = max(abs(a - b) / max(abs(b), 1e-12) for k in vr for a, b in zip(vn[k], vr[k]))
    out['tables'].append(_cmp_frames(rd(new, 'stage3', 'final_dataonly.parquet'), rd(ref, 'stage3', 'final_dataonly.parquet'),
                                     ['season', 'metric', 'team_id'], 'stage3/final_dataonly'))
    pn = rd(new, 'stage3', 'priors.parquet'); pr = rd(ref, 'stage3', 'priors.parquet')
    pr = pr[pr.season.isin(seasons)]
    out['tables'].append(_cmp_frames(pn, pr, ['season', 'metric', 'side', 'team_id'], 'stage3/priors'))
    for S in seasons:
        out['tables'].append(_cmp_frames(rd(new, 'stage3', 'ratings_%d.parquet' % S), rd(ref, 'stage3', 'ratings_%d.parquet' % S),
                                         ['prediction_ts', 'team_id', 'metric'], 'stage3/ratings_%d' % S))
        out['tables'].append(_cmp_frames(rd(new, 'stage3', 'league_%d.parquet' % S), rd(ref, 'stage3', 'league_%d.parquet' % S),
                                         ['prediction_ts', 'metric'], 'stage3/league_%d' % S))
    qn = rd(new, 'stage4', 'qb_team.parquet'); qr = rd(ref, 'stage4', 'qb_team.parquet')
    out['tables'].append(_cmp_frames(qn, qr[qr.season.isin(seasons)], ['season', 'prediction_ts', 'team_id'], 'stage4/qb_team'))
    out['tables'].append(_cmp_frames(rd(new, 'stage4', 'elo.parquet'), rd(ref, 'stage4', 'elo.parquet'), ['game_id'], 'stage4/elo'))
    sn = rd(new, 'stage5', 'cfb_model_training_snapshots.parquet')
    sr = rd(ref, 'stage5', 'cfb_model_training_snapshots.parquet')
    sr = sr[sr.season.isin(seasons)]
    out['tables'].append(_cmp_frames(sn, sr, ['game_id'], 'stage5/model_snapshots'))
    out['tables'].append(_cmp_frames(rd(new, 'stage5', 'cfb_market_training_snapshots.parquet'),
                                     rd(ref, 'stage5', 'cfb_market_training_snapshots.parquet'), ['game_id'],
                                     'stage5/market_snapshots'))
    # stage 7 for the target seasons from the REBUILT rows
    out['stage7_from_rebuilt_rows'] = refit_targets(sn, seasons)
    from v2 import common
    common.write_json(common.out_path('audit', 'reproduce_compare.json'), out)
    for t in out['tables']:
        print('%-32s exact=%s rows new/ref %d/%d max|d|=%.3g nan_mm=%d other_mm=%d' % (
            t['table'], t['exact'], t['rows_new'], t['rows_ref'], t['max_abs_diff_all'],
            sum(t['nan_mismatch'].values()), sum(t['other_mismatch'].values())))
    print('stage7 from rebuilt rows:', json.dumps(out['stage7_from_rebuilt_rows'])[:800])
    return out


def refit_targets(rebuilt, seasons):
    """Fit stage 7 for S in `seasons` on the REFERENCE stage-5 rows of earlier seasons, predict the
    REBUILT rows of S, and compare with the stored out-of-fold predictions."""
    from v2 import config as C, common, walkforward as WF
    from v2.personnel import backtest_qb as BQ
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    fam = json.load(open(common.out_path('report', 'selected_families.json')))
    rep = {}
    for S in seasons:
        if S < C.FIRST_OOF_SEASON + 2:
            continue
        Xr = pd.concat([X[X.season < S], rebuilt[rebuilt.season.eq(S)]], ignore_index=True)
        D, W, unc, fitted = WF.run(Xr, list(range(C.FIRST_OOF_SEASON, S + 1)), fam['C'], fam['D'], verbose=False)
        d = D[D.season.eq(S)][['game_id', 'ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm']] \
            .merge(M[['game_id', 'ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm']], on='game_id',
                   suffixes=('', '_stored'))
        rep[S] = {'n': int(len(d)), 'max_abs_diff': {c: float(np.nanmax(np.abs(d[c] - d[c + '_stored'])))
                                                     for c in ('ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm')}}
    return rep


def refit():
    """Full stage-7 refit from the reference stage-5 table vs the stored predictions."""
    from v2 import common
    from v2.personnel import backtest_qb as BQ
    t0 = time.time()
    rep, _ = BQ.reproduce()
    rep['seconds'] = round(time.time() - t0)
    common.write_json(common.out_path('audit', 'reproduce_stage7_refit.json'), rep)
    print(json.dumps(rep, indent=1, default=str)[:3000])


if __name__ == '__main__':
    sys.path.insert(0, RESEARCH)
    cmd = sys.argv[1]
    if cmd == 'build':
        build([int(x) for x in sys.argv[2:]], os.environ['CFB_V2_REF'])
    elif cmd == 'compare':
        compare(sys.argv[2], [int(x) for x in sys.argv[3:]])
    elif cmd == 'refit':
        refit()
