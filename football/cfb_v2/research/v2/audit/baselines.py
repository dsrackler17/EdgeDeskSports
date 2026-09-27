"""Audit items 17, 18, 51, 52, 53 — simple-baseline and market-only challenge on IDENTICAL games.

    python3 -m v2.audit.baselines      -> $CFB_V2_OUT/audit/baselines.json

Predictors (all scored on the same FBS-vs-FBS FINAL games per window):
  V2.1 (ens_pred, the audited model), V1 (cold replay), the model's own components A-E,
  an ensemble MEDIAN of A-E, the V2 Elo (B), CFBD pregame Elo (external, scaled walk-forward),
  naive home field, the opening line, the closing line, and two audit ridge baselines fitted
  here walk-forward on the SAME point-in-time stage-5 features:
    ridge_epa3   home_field + opponent-adjusted EPA edge + preseason-prior EPA edge
    ridge_small8 ridge_epa3 + elo_diff + adjusted pass/rush EPA, success rate, points/drive edges
Win probability for predictors without their own: Normal(pred, sd) with sd = walk-forward RMSE
of that predictor on earlier seasons (FBS-vs-FBS FINAL). V2.1 uses its shipped p_home_raw;
V1 its own published probability.
"""
import numpy as np
import pandas as pd

from . import _io

RIDGE_SETS = {
    'ridge_epa3': ['home_field', 'edge_epa', 'edge_prior_epa'],
    'ridge_small8': ['home_field', 'edge_epa', 'edge_prior_epa', 'elo_diff', 'edge_epa_pass', 'edge_epa_rush',
                     'edge_sr', 'edge_ppd'],
}


def ridge_wf(X, cols, alpha=1.0, first=2016, last=2026):
    """Walk-forward standardized ridge: season S fitted on FBS-vs-FBS FINAL rows of 2012..S-1."""
    out = pd.Series(np.nan, index=X.index)
    tr_all = X[~X.fcs_game & X.status.eq('FINAL') & X.margin.notna()]
    for S in range(first, last + 1):
        tr = tr_all[tr_all.season < S]
        Z = tr[cols].astype(float)
        mu, sd = Z.mean(), Z.std().replace(0, 1)
        A = np.column_stack([np.ones(len(Z)), ((Z.fillna(mu) - mu) / sd).values])
        P = np.eye(A.shape[1]) * alpha; P[0, 0] = 0
        b = np.linalg.solve(A.T @ A + P, A.T @ tr.margin.values)
        cur = X.season.eq(S)
        Zc = X.loc[cur, cols].astype(float)
        out[cur] = np.column_stack([np.ones(cur.sum()), ((Zc.fillna(mu) - mu) / sd).values]) @ b
    return out


def wf_sd(M, col):
    """Walk-forward RMSE of a predictor on earlier seasons (FBS-vs-FBS FINAL)."""
    sd = {}
    base = _io.fbs_final(M, range(2000, 2100))
    for S in sorted(M.season.unique()):
        p = base[(base.season < S) & base[col].notna()]
        if len(p) >= 300:
            sd[S] = float(np.sqrt(((p[col] - p.margin) ** 2).mean()))
    return sd


def main():
    M = _io.preds().copy()
    X = pd.read_parquet(_io.os.path.join(_io.out_dir(), 'stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[['game_id', 'season', 'fcs_game', 'status', 'margin'] + sorted({c for v in RIDGE_SETS.values() for c in v})]
    X = X.copy()
    X['home_field'] = X.home_field.astype(float)
    for k, cols in RIDGE_SETS.items():
        X[k] = ridge_wf(X, cols)
    M = M.merge(X[['game_id'] + list(RIDGE_SETS)], on='game_id', how='left')
    M['ens_median_AE'] = M[['pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm', 'pred_E_drive']].median(axis=1)
    preds = ['base_v1', 'pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm', 'pred_E_drive', 'ens_median_AE',
             'base_cfbd_elo', 'base_hfa', 'ridge_epa3', 'ridge_small8', 'line', 'close_margin']
    # walk-forward probabilities
    for c in preds + ['ens_pred']:
        sd = wf_sd(M, c)
        M['p_' + c] = [(_io.norm_wp(v, sd[s]) if (s in sd and not np.isnan(v)) else np.nan)
                       for v, s in zip(M[c].values, M.season.values)]
    M['p_base_v1_own'] = M.base_v1_winprob
    out = {'definition': __doc__, 'windows': {}}
    for wname, seasons, use in (('dev_2016_2023', _io.DEV, preds), ('holdout_2024_2025', _io.HOLD, preds),
                                ('live_2026_replay', _io.LIVE, [p for p in preds if p != 'base_v1'])):
        w = _io.fbs_final(M, seasons).dropna(subset=['ens_pred', 'p_home_raw'] + use)
        W = {'n_common': int(len(w)), 'n_window': int(len(_io.fbs_final(M, seasons))), 'vs': {}, 'mae': {}}
        W['mae']['ens_pred'] = float((w.ens_pred - w.margin).abs().mean())
        for c in use:
            pb = w['p_base_v1_own'] if c == 'base_v1' else w['p_' + c]
            r = _io.paired(w.margin, w.ens_pred, w[c], pa=w.p_home_raw, pb=pb)
            r['cluster_week'] = _io.cluster_paired_mae(w.margin, w.ens_pred, w[c],
                                                      w.season.astype(str) + '-' + w.week.astype(str))
            per = {}
            for s, g in w.groupby('season'):
                per[int(s)] = float((g.ens_pred - g.margin).abs().mean() - (g[c] - g.margin).abs().mean())
            r['per_season_mae_diff'] = per
            r['seasons_v2_better'] = int(sum(v < 0 for v in per.values()))
            r['seasons_v2_worse'] = int(sum(v > 0 for v in per.values()))
            W['vs'][c] = r
            W['mae'][c] = r['mae_b']
        out['windows'][wname] = W
    # holdout without requiring V1 / CFBD Elo (the market-only challenge on every game with both lines)
    w = _io.fbs_final(M, _io.HOLD).dropna(subset=['ens_pred', 'line', 'close_margin'])
    out['market_only_holdout_all_lined_games'] = {
        'vs_open': _io.paired(w.margin, w.ens_pred, w.line, pa=w.p_home_raw, pb=w.p_line),
        'vs_close': _io.paired(w.margin, w.ens_pred, w.close_margin, pa=w.p_home_raw, pb=w.p_close_margin),
        'open_vs_close': _io.paired(w.margin, w.line, w.close_margin)}
    # practical significance: V2.1 vs the simplest competitive baseline, in units a bettor cares about
    H = out['windows']['holdout_2024_2025']
    best_simple = min(['ridge_epa3', 'ridge_small8', 'pred_B_elo', 'base_cfbd_elo', 'base_v1'],
                      key=lambda c: H['mae'][c])
    out['practical'] = {'best_simple_holdout': best_simple, 'mae_simple': H['mae'][best_simple],
                        'mae_v2': H['mae']['ens_pred'], 'diff': H['mae']['ens_pred'] - H['mae'][best_simple],
                        'diff_ci': H['vs'][best_simple]['mae_diff_ci'],
                        'diff_as_share_of_mae': (H['mae']['ens_pred'] - H['mae'][best_simple]) / H['mae'][best_simple],
                        'v2_minus_open': H['mae']['ens_pred'] - H['mae']['line'],
                        'v2_minus_close': H['mae']['ens_pred'] - H['mae']['close_margin']}
    M[['game_id'] + list(RIDGE_SETS) + ['ens_median_AE'] + ['p_' + c for c in preds + ['ens_pred']]].to_parquet(
        _io.audit_path('baseline_preds.parquet'), index=False)
    p = _io.write('baselines.json', out)
    for wn, W in out['windows'].items():
        print(wn, 'n', W['n_common'])
        for c, r in W['vs'].items():
            print('  %-15s MAE %.3f  V2-this %+.3f [%+.3f,%+.3f] clusterCI [%+.3f,%+.3f] RMSE %+.3f Brier %+.4f [%+.4f,%+.4f] seasons better/worse %d/%d' % (
                c, r['mae_b'], r['mae_diff'], *r['mae_diff_ci'], *r['cluster_week']['mae_diff_ci'], r['rmse_diff'],
                r.get('brier_diff', np.nan), *(r.get('brier_diff_ci') or [np.nan, np.nan]), r['seasons_v2_better'],
                r['seasons_v2_worse']))
    print('practical', out['practical'])
    print('wrote', p)


if __name__ == '__main__':
    main()
