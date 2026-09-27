"""Stages 7-9 orchestration: model -> reliability -> market -> rule -> baselines -> report.

    python3 -m v2.pipeline            full walk-forward + report
The DEV-only rule selection happens here, and the holdout is scored exactly
once with the frozen rule. Nothing in this file reads a holdout outcome while
choosing anything.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import evaluate as EV
from . import market as MKT
from . import models as MD
from . import reliability as REL
from . import walkforward as WF
from . import contract as K
from . import gates as GT

WINDOWS = {'dev_2016_2023': list(C.DEV_SEASONS), 'holdout_2024_2025': list(C.HOLDOUT_SEASONS),
           'live_2026': [C.LIVE_SEASON]}


def load_snapshots():
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    MK = pd.read_parquet(common.out_path('stage5', 'cfb_market_training_snapshots.parquet'))
    return X, MK


def modeling(X, fam_C=None, fam_D=None, gbm_params=None, ridge_alpha=None, verbose=True):
    cols = MD.features_for(fam_C or MD.ABLATION_ORDER) + MD.features_for(fam_D or MD.ABLATION_ORDER)
    K.assert_pure(set(cols) | set(WF.SIGMA_COLS) - {'abs_pred', 'exp_total_z', 'fcs_game_f', 'inv_games'})
    seasons = list(range(C.FIRST_OOF_SEASON, C.LIVE_SEASON + 1))
    D, W, unc, fitted = WF.run(X, seasons, fam_C, fam_D, gbm_params, ridge_alpha, verbose=verbose)
    D, rr = REL.attach(D, seasons)
    return D, W, unc, fitted, rr


# ------------------------------------------------------------- baselines
def add_baselines(M, X):
    M = M.copy()
    # naive home field: mean FBS home margin of earlier seasons, 0 at neutral sites
    M['base_hfa'] = np.nan
    for S in sorted(M.season.unique()):
        p = M[(M.season < S) & ~M.fcs_game & ~M.neutral_site & M.status.eq('FINAL')]
        if len(p) < 300:
            continue
        M.loc[M.season.eq(S), 'base_hfa'] = np.where(M.loc[M.season.eq(S), 'neutral_site'], 0.0, p.margin.mean())
    # V1 (cold replay of the shipped engine; its line is in BOOK convention)
    f = os.environ.get('CFB_V2_V1_RECORDS', '')
    M['base_v1'] = np.nan
    M['base_v1_winprob'] = np.nan
    if f and os.path.exists(f):
        v1 = pd.DataFrame(json.load(open(f)))
        v1['game_id'] = v1.game_id.astype('int64')
        v1['v1_margin'] = -v1.spread.astype(float)          # BOOK -> INTERNAL
        v1 = v1.drop_duplicates('game_id').set_index('game_id')
        M['base_v1'] = M.game_id.map(v1.v1_margin)
        M['base_v1_winprob'] = M.game_id.map(v1.home_win_prob)
    # CFBD pregame Elo (external single system), scaled walk-forward
    md = common.data_path('mline')
    M['base_cfbd_elo'] = np.nan
    if os.path.isdir(md):
        e = pd.concat([pd.read_parquet(os.path.join(md, x), columns=['game_id', 'home_pregame_elo', 'away_pregame_elo'])
                       for x in sorted(os.listdir(md))])
        e = e.drop_duplicates('game_id').set_index('game_id')
        M['cfbd_elo_diff'] = M.game_id.map(e.home_pregame_elo - e.away_pregame_elo)
        for S in sorted(M.season.unique()):
            p = M[(M.season < S) & ~M.fcs_game & M.status.eq('FINAL') & M.cfbd_elo_diff.notna()]
            if len(p) < 300:
                continue
            A = np.column_stack([p.home_field, p.cfbd_elo_diff])
            b = np.linalg.lstsq(A, p.margin.values, rcond=None)[0]
            c = M.season.eq(S) & M.cfbd_elo_diff.notna()
            M.loc[c, 'base_cfbd_elo'] = np.column_stack([M.loc[c, 'home_field'], M.loc[c, 'cfbd_elo_diff']]) @ b
    return M


# ------------------------------------------------------------- rule (DEV)
def select_rule(M):
    dev = [s for s in C.DEV_SEASONS]
    C.assert_dev_only(dev)
    d = M[M.season.isin(dev) & M.ev.notna() & M.status.eq('FINAL') & ~M.fcs_game]
    grid = []
    for review_gap in (7.0, 10.0, 14.0):
        for gap in (0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0):
            for ev in (0.0, 0.02, 0.04, 0.06):
                for rel in (0.0, 50.0, 65.0):
                    for early in (False, True):
                        m = (d.gap_open.abs() >= gap) & (d.gap_open.abs() < review_gap) & (d.ev > ev) \
                            & (d.reliability.fillna(0) >= rel)
                        if early:
                            m &= ~d.early_season.astype(bool)
                        s = d[m]
                        n = len(s)
                        if n < 150:
                            continue
                        u = s.bet_units.values
                        roi = float(u.mean())
                        se = float(u.std(ddof=1) / np.sqrt(n))
                        grid.append(dict(review_gap=review_gap, bet_gap=gap, bet_ev=ev, bet_min_rel=rel,
                                         exclude_early=early, n=n, roi=roi, roi_lb90=roi - 1.645 * se,
                                         ats=float((s.bet_result[s.bet_result != 0] == 1).mean()),
                                         clv=float(s.clv_pts.mean())))
    G = pd.DataFrame(grid)
    best = G.sort_values('roi_lb90', ascending=False).iloc[0].to_dict() if len(G) else None
    validated = bool(best is not None and best['roi_lb90'] > 0 and best['clv'] > 0)
    rule = {'review_gap': float(best['review_gap']) if best else 10.0,
            'bet_gap': float(best['bet_gap']) if best else 99.0,
            'bet_ev': float(best['bet_ev']) if best else 1.0,
            'bet_min_rel': float(best['bet_min_rel']) if best else 101.0,
            'exclude_early': bool(best['exclude_early']) if best else True,
            'lean_ev': 0.0, 'lean_gap': 0.0,
            'dev_best': best, 'bet_enabled': validated,
            'selection': 'max lower 90% bound of ROI/bet on DEV seasons, n>=150; BET enabled only if that '
                         'bound > 0 AND mean CLV > 0',
            'grid_size': int(len(G))}
    return rule, G


# ------------------------------------------------------------------ report
def window_report(M, seasons, pred_cols):
    w = M[M.season.isin(seasons) & M.status.eq('FINAL') & ~M.fcs_game]
    # a COMMON game set so every predictor is scored on the same games
    common_set = w.dropna(subset=[c for c in pred_cols if c in w])
    out = {'n_games_all': int(len(w)), 'n_common': int(len(common_set)), 'accuracy': {}, 'paired_vs_v2': {}}
    for c in pred_cols:
        if c in common_set:
            out['accuracy'][c] = EV.margin_metrics(common_set.margin, common_set[c])
            if c != 'ens_pred':
                out['paired_vs_v2'][c] = EV.paired_mae_diff(common_set.margin, common_set.ens_pred, common_set[c])
    yw = (w.margin > 0).astype(float)
    out['win_prob'] = {k: EV.prob_metrics(yw, w[k]) for k in ('p_home_raw', 'p_home_platt', 'p_home_iso',
                                                             'base_v1_winprob') if k in w}
    out['intervals'] = {q: EV.coverage(w.margin, w['lo_%d' % q], w['hi_%d' % q]) for q in (50, 80, 95)}
    return out


def betting_report(M, seasons, rule):
    w = M[M.season.isin(seasons) & M.status.eq('FINAL') & M.ev.notna() & ~M.fcs_game].copy()
    st, why = MKT.decide(w, rule)
    w['status_research'] = st
    out = {'all_games_side_of_model': EV.betting_metrics(w),
           'by_status': {s: EV.betting_metrics(w[w.status_research.eq(s)]) for s in ('BET', 'LEAN', 'REVIEW', 'PASS')},
           'status_counts': w.status_research.value_counts().to_dict()}
    b = EV.buckets(w)
    for key in ('edge_bucket', 'reliability_bucket', 'week_bucket', 'spread_size', 'fav_dog_bet',
                'home_away_bet', 'p4_g5', 'qb_certainty', 'total_size', 'season'):
        if key in b:
            out['by_' + key] = {str(k): EV.betting_metrics(w[b[key].eq(k)]) for k in sorted(b[key].dropna().unique())}
    cov = w.pc_home_cal.notna()
    yc = (w.margin > w.line).astype(float)
    np_ = w.margin != w.line
    out['cover_prob_calibration_raw'] = EV.prob_metrics(yc[cov & np_], w.pc_home_raw[cov & np_])
    out['cover_prob_calibration_cal'] = EV.prob_metrics(yc[cov & np_], w.pc_home_cal[cov & np_])
    # beat the opener / beat the close (the pure model as a line-maker)
    m2 = w.close_margin.notna()
    out['vs_market'] = {
        'mae_v2': float((w.ens_pred - w.margin).abs().mean()),
        'mae_open': float((w.line - w.margin).abs().mean()),
        'mae_close_on_same_games': float((w.close_margin[m2] - w.margin[m2]).abs().mean()),
        'mae_v2_on_close_games': float((w.ens_pred[m2] - w.margin[m2]).abs().mean()),
        'mae_market_adjusted_challenger': float((w.pred_ma - w.margin).abs().mean()) if w.pred_ma.notna().any() else None,
        'paired_v2_minus_open': EV.paired_mae_diff(w.margin, w.ens_pred, w.line),
        'paired_v2_minus_close': EV.paired_mae_diff(w.margin[m2], w.ens_pred[m2], w.close_margin[m2]),
        'paired_ma_minus_open': EV.paired_mae_diff(w.margin, w.pred_ma, w.line),
        'paired_ma_minus_close': EV.paired_mae_diff(w.margin[m2], w.pred_ma[m2], w.close_margin[m2]),
        'close_moved_toward_v2_share': float((np.sign(w.close_margin[m2] - w.line[m2])
                                              == np.sign(w.ens_pred[m2] - w.line[m2]))[
                                                  (w.close_margin[m2] != w.line[m2])].mean()),
        'market_adjusted_model_weight_mean': float(w.ma_weight_model.mean()) if 'ma_weight_model' in w else None,
    }
    return out, w


def subgroup_accuracy(M, seasons):
    w = M[M.season.isin(seasons) & M.status.eq('FINAL')].copy()
    b = EV.buckets(w)
    out = {}
    for key in ('season', 'week_bucket', 'early_late', 'p4_g5', 'home_conf', 'qb_certainty',
                'reliability_bucket', 'spread_size', 'total_size'):
        if key not in b:
            continue
        out[key] = {}
        for k in sorted(b[key].dropna().unique()):
            s = w[b[key].eq(k)]
            if len(s) < 30:
                continue
            r = {'n': int(len(s)), 'mae_v2': float((s.ens_pred - s.margin).abs().mean()),
                 'bias_v2': float((s.ens_pred - s.margin).mean())}
            for c in ('base_v1', 'line', 'close_margin'):
                if c in s and s[c].notna().sum() > 20:
                    ss = s[s[c].notna()]
                    r['mae_' + c] = float((ss[c] - ss.margin).abs().mean())
                    r['mae_v2_same_' + c] = float((ss.ens_pred - ss.margin).abs().mean())
            if 'lo_80' in s:
                r['cov80'] = float(((s.margin >= s.lo_80) & (s.margin <= s.hi_80)).mean())
            out[key][str(k)] = r
    return out


def main():
    X, MK = load_snapshots()
    fam = json.load(open(common.out_path('report', 'selected_families.json'))) \
        if os.path.exists(common.out_path('report', 'selected_families.json')) else None
    fam_C = fam['C'] if fam else None
    fam_D = fam['D'] if fam else None
    D, W, unc, fitted, rr = modeling(X, fam_C, fam_D)
    seasons = sorted(unc.keys())
    M, mparams = MKT.run(D, MK, unc, seasons)
    M = add_baselines(M, X)
    rule, G = select_rule(M)
    preds = ['ens_pred', 'pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm', 'pred_E_drive',
             'ens_equal', 'base_v1', 'base_hfa', 'base_cfbd_elo', 'line', 'close_margin']
    rep = {'model_version': C.MODEL_VERSION, 'feature_version': C.FEATURE_VERSION,
           'stack_weights_by_season': W, 'uncertainty_by_season': unc, 'reliability_ranges': rr,
           'market_params_by_season': {str(k): v for k, v in mparams.items()},
           'rule': rule, 'windows': {}}
    for name, ss in WINDOWS.items():
        rep['windows'][name] = {'accuracy': window_report(M, ss, preds),
                                'betting': betting_report(M, ss, rule)[0],
                                'subgroups': subgroup_accuracy(M, ss)}
    # win-probability calibration method: chosen on DEV log loss only
    dwp = rep['windows']['dev_2016_2023']['accuracy']['win_prob']
    ll = {k.replace('p_home_', ''): v['log_loss'] for k, v in dwp.items() if k.startswith('p_home_') and v.get('n')}
    method = min(ll, key=ll.get)
    rep['win_calibration_choice'] = {'method': method, 'dev_log_loss': ll}
    H = rep['windows']['holdout_2024_2025']
    acc = H['accuracy']['accuracy']
    rep['headline'] = {
        'holdout_mae': {k: acc.get(k, {}).get('mae') for k in ('ens_pred', 'base_v1', 'line', 'close_margin',
                                                               'base_hfa', 'pred_B_elo', 'base_cfbd_elo')},
        'holdout_n_common': H['accuracy']['n_common'],
        'holdout_brier': H['accuracy']['win_prob'].get('p_home_' + method, {}).get('brier'),
        'holdout_brier_v1': H['accuracy']['win_prob'].get('base_v1_winprob', {}).get('brier'),
        'holdout_coverage': {q: H['accuracy']['intervals'][q]['coverage'] for q in (50, 80, 95)},
        'beats_closing_line': bool((acc.get('ens_pred', {}).get('mae') or 99) < (acc.get('close_margin', {}).get('mae') or 0)),
        'beats_opening_line': bool((acc.get('ens_pred', {}).get('mae') or 99) < (acc.get('line', {}).get('mae') or 0)),
    }
    gates = GT.evaluate(rep, 'p_home_' + method)
    common.write_json(common.out_path('report', 'promotion.json'), gates)
    rep['promotion'] = {k: gates[k] for k in ('decision', 'champion', 'passed', 'failed', 'bet_allowed')}
    common.write_json(common.out_path('report', 'backtest.json'), rep)
    G.to_csv(common.out_path('report', 'rule_grid_dev.csv'), index=False)
    M.to_parquet(common.out_path('stage7', 'backtest_predictions.parquet'), index=False)
    import pickle
    with open(common.out_path('stage7', 'fitted_last.pkl'), 'wb') as f:
        pickle.dump({'fitted': fitted[max(fitted)], 'unc': unc[max(unc)], 'W': W[max(W)],
                     'market': mparams[max(mparams)] if mparams else None, 'rule': rule,
                     'rel_range': rr[max(rr)], 'fam_C': fam_C, 'fam_D': fam_D}, f)
    print('[pipeline] done; rule', {k: v for k, v in rule.items() if k != 'dev_best'})
    return rep, M


if __name__ == '__main__':
    main()
