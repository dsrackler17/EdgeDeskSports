"""Red team — attack the V2 model: components, ensembles, ablations, overfitting,
calibration, uncertainty, misses, residuals, market, thresholds, bankroll,
edge decay, learning, early season, QB, simplification.

    python3 -m v2.redteam [--out-snap <OUT with stage5>] [--phases 5,6,...]

Everything runs on the independent walk-forward (rt_walkforward.py), from the
frozen pregame snapshot table. Results land in report/redteam/*.json and are
rendered by rt_report.py into docs/cfb-v2/REDTEAM.md.

Windows: DEV 2016-2023 (every decision is made here), HOLDOUT 2024-2025
(scored, never tuned on; note it was already scored for candidate 001),
LIVE 2026 (genuinely out of sample, small).
"""
import argparse
import json
import os
import time

import numpy as np
import pandas as pd
from scipy import stats

from . import config as C
from . import common
from . import models as MD
from . import rt_walkforward as RT

WIN = {'dev': list(C.DEV_SEASONS), 'holdout': list(C.HOLDOUT_SEASONS), 'live': [C.LIVE_SEASON]}
RNG_SEED = C.SEED
BOOT = 1000
REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'report', 'redteam')


# ------------------------------------------------------------------ utils
def boot(x, stat=np.mean, b=BOOT):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    if len(x) < 20:
        return [None, None]
    rng = np.random.default_rng(RNG_SEED)
    idx = rng.integers(0, len(x), size=(b, len(x)))
    v = stat(x[idx], axis=1) if stat in (np.mean, np.median) else np.array([stat(x[i]) for i in idx])
    return [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]


def r4(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 4)


def margin_block(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = ~(np.isnan(y) | np.isnan(p))
    e = p[ok] - y[ok]
    if not len(e):
        return {'n': 0}
    return {'n': int(len(e)), 'mae': r4(np.abs(e).mean()), 'mae_ci': [r4(v) for v in boot(np.abs(e))],
            'rmse': r4(np.sqrt((e ** 2).mean())), 'median_ae': r4(np.median(np.abs(e))),
            'bias': r4(e.mean()), 'bias_ci': [r4(v) for v in boot(e)],
            'corr_margin': r4(np.corrcoef(p[ok], y[ok])[0, 1]), 'resid_var': r4(np.var(e))}


def prob_block(y, p, bins=None):
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], np.clip(p[ok], 1e-4, 1 - 1e-4)
    if not len(y):
        return {'n': 0}
    brier = (p - y) ** 2
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    # calibration slope / intercept: logistic regression of y on logit(p)
    from sklearn.linear_model import LogisticRegression
    lg = np.log(p / (1 - p))
    m = LogisticRegression(C=1e6).fit(lg[:, None], y)
    edges = np.linspace(0, 1, 11) if bins is None else bins
    ece, tab = 0.0, []
    for i in range(len(edges) - 1):
        s = (p >= edges[i]) & ((p < edges[i + 1]) if i < len(edges) - 2 else (p <= edges[i + 1]))
        if s.sum():
            ece += s.sum() / len(p) * abs(p[s].mean() - y[s].mean())
            tab.append({'bin': '%.2f-%.2f' % (edges[i], edges[i + 1]), 'n': int(s.sum()),
                        'pred': r4(p[s].mean()), 'obs': r4(y[s].mean())})
    return {'n': int(len(y)), 'brier': r4(brier.mean()), 'brier_ci': [r4(v) for v in boot(brier)],
            'log_loss': r4(ll.mean()), 'ece': r4(ece), 'cal_slope': r4(m.coef_[0][0]),
            'cal_intercept': r4(m.intercept_[0]), 'table': tab}


FAV_BINS = np.array([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 1.0])


def favorite_table(y_home, p_home):
    """Fold every probability to the favourite's side: 50-55%, ..., 80%+."""
    y, p = np.asarray(y_home, float), np.asarray(p_home, float)
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], p[ok]
    pf = np.where(p >= 0.5, p, 1 - p)
    yf = np.where(p >= 0.5, y, 1 - y)
    out = []
    for lo, hi in zip(FAV_BINS[:-1], FAV_BINS[1:]):
        s = (pf >= lo) & (pf < hi) if hi < 1 else (pf >= lo)
        if s.sum():
            out.append({'bucket': '%d-%d%%' % (lo * 100, hi * 100) if hi < 1 else '%d%%+' % (lo * 100),
                        'n': int(s.sum()), 'pred': r4(pf[s].mean()), 'obs': r4(yf[s].mean()),
                        'obs_ci': [r4(v) for v in boot(yf[s])]})
    return out


def paired(y, a, b):
    y, a, b = (np.asarray(v, float) for v in (y, a, b))
    ok = ~(np.isnan(y) | np.isnan(a) | np.isnan(b))
    d = np.abs(a[ok] - y[ok]) - np.abs(b[ok] - y[ok])
    return {'n': int(ok.sum()), 'diff': r4(d.mean()) if ok.any() else None, 'ci': [r4(v) for v in boot(d)]}


def normal_winprob(frame, col, seasons):
    """Walk-forward homoskedastic conversion of any margin predictor to a win
    probability: sigma_S = RMSE of that predictor on seasons < S."""
    p = pd.Series(np.nan, index=frame.index)
    for S in seasons:
        past = frame[(frame.season < S) & frame[col].notna() & frame.margin.notna()]
        if len(past) < 300:
            continue
        s = float(np.sqrt(np.mean((past.margin - past[col]) ** 2)))
        cur = frame.season.eq(S) & frame[col].notna()
        p[cur] = stats.norm.cdf(frame.loc[cur, col] / s)
    return p


# ---------------------------------------------------------------- loading
def load(out_snap):
    X = pd.read_parquet(os.path.join(out_snap, 'stage5', 'cfb_model_training_snapshots.parquet'))
    X = MD.add_derived(X)
    MK = pd.read_parquet(os.path.join(out_snap, 'stage5', 'cfb_market_training_snapshots.parquet'))
    return X, MK


def v1_records():
    f = os.environ.get('CFB_V2_V1_RECORDS', os.path.join(C.DATA, 'v1', 'out', 'v1_records.json'))
    v1 = pd.DataFrame(json.load(open(f)))
    v1['game_id'] = v1.game_id.astype('int64')
    v1 = v1.drop_duplicates('game_id').set_index('game_id')
    return pd.DataFrame({'base_v1': -v1.spread.astype(float), 'base_v1_winprob': v1.home_win_prob})


def attach_market(D, MK):
    m = MK[['game_id', 'open_margin', 'close_margin', 'total_open', 'total_close', 'spread_books',
            'market_dispersion', 'source']]
    D = D.merge(m, on='game_id', how='left')
    v1 = v1_records()
    D['base_v1'] = D.game_id.map(v1.base_v1)
    D['base_v1_winprob'] = D.game_id.map(v1.base_v1_winprob)
    return D


def fbs_fin(D, seasons):
    return D[D.season.isin(seasons) & D.status.eq('FINAL') & ~D.fcs_game.astype(bool) & D.margin.notna()]


# ============================================================ PHASE 4
def phase4_reproduction(D):
    """The independent walk-forward against candidate 001's frozen record
    (football/cfb_v2/candidates/cfb_v2_candidate_001/predictions.csv.gz):
    the largest absolute difference per quantity over every game both have."""
    f = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'candidates', 'cfb_v2_candidate_001',
                     'predictions.csv.gz')
    P = pd.read_csv(f)
    pairs = [('pred_' + c, 'pred_' + c) for c in RT.COMPONENTS] + [
        ('pred', 'ens_pred'), ('sigma', 'sigma'), ('reliability', 'reliability'), ('p_win_raw', 'p_home_raw')] + [
        (b % q, b % q) for q in (50, 80, 95) for b in ('lo_%d', 'hi_%d')]
    j = D.merge(P, on='game_id', how='inner', suffixes=('_rt', '_c001'))
    out = {'frozen_record': 'football/cfb_v2/candidates/cfb_v2_candidate_001/predictions.csv.gz', 'n_games': int(len(j))}
    for a, b in pairs:
        ca = a + '_rt' if a + '_rt' in j else a
        cb = b + '_c001' if b + '_c001' in j else b
        if ca not in j or cb not in j:
            continue
        m = j[ca].notna() & j[cb].notna()
        out[a] = {'n': int(m.sum()), 'max_abs_diff': float((j.loc[m, ca] - j.loc[m, cb]).abs().max()),
                  'missing_in_one': int((j[ca].isna() != j[cb].isna()).sum())}
    return out


# ============================================================ PHASE 5
PREDICTORS = ['pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm', 'pred_E_drive', 'pred',
              'base_v1', 'open_margin', 'close_margin']
NAMES = {'pred_A_adj_eff': 'A adjusted efficiency', 'pred_B_elo': 'B dynamic Elo', 'pred_C_ridge': 'C ridge matchup',
         'pred_D_gbm': 'D boosted matchup', 'pred_E_drive': 'E drive model', 'pred': 'V2 ensemble (cand. 001)',
         'base_v1': 'EdgeDesk V1', 'open_margin': 'opening market', 'close_margin': 'closing market'}


def phase5_components(D):
    seasons = sorted(D.season.unique())
    for c in PREDICTORS:
        D['wp_' + c] = normal_winprob(D, c, seasons)
    out = {}
    for w, ss in WIN.items():
        d = fbs_fin(D, ss)
        common_set = d.dropna(subset=[c for c in PREDICTORS if d[c].notna().mean() > 0.5])
        yw = (common_set.margin > 0).astype(float)
        res = {}
        for c in PREDICTORS:
            if c not in common_set or common_set[c].isna().all():
                continue
            b = margin_block(common_set.margin, common_set[c])
            pb = prob_block(yw, common_set['wp_' + c])
            b.update({'brier': pb.get('brier'), 'log_loss': pb.get('log_loss'), 'ece': pb.get('ece')})
            for mk in ('open_margin', 'close_margin'):
                s = common_set[[c, mk]].dropna()
                b['corr_' + mk] = r4(np.corrcoef(s[c], s[mk])[0, 1]) if len(s) > 30 and c != mk else None
            if c != 'pred':
                b['vs_ensemble'] = paired(common_set.margin, common_set.pred, common_set[c])
            res[c] = b
        if 'base_v1_winprob' in common_set and common_set.base_v1_winprob.notna().any():
            res['base_v1']['own_winprob'] = prob_block(yw, common_set.base_v1_winprob)
        comps = ['pred_' + k for k in RT.COMPONENTS]
        R = common_set[comps].sub(common_set.margin, axis=0)
        out[w] = {'n_common': int(len(common_set)), 'metrics': res,
                  'residual_corr': {a: {b: r4(R[a].corr(R[b])) for b in comps} for a in comps},
                  'prediction_corr': {a: {b: r4(common_set[a].corr(common_set[b])) for b in comps} for a in comps}}
    return out


# ============================================================ PHASE 6
def phase6_ensembles(X, base):
    """Every stacker on the same OOF components; weights by fold; drop-one."""
    OOF = base['D'][['game_id', 'season'] + ['pred_' + k for k in RT.COMPONENTS] + ['pred_total']]
    res = {}
    preds = {}
    for method in RT.STACKERS:
        p, W = RT.stack(OOF, X, RT.COMPONENTS, method)
        preds[method] = p
        wdf = pd.DataFrame({S: {k: v for k, v in w.items() if k != 'intercept'} for S, w in W.items() if w}).T
        res[method] = {'weights_by_season': {str(S): {k: r4(v) for k, v in (w or {}).items()} for S, w in W.items()},
                       'weight_sd_across_seasons': {k: r4(wdf[k].std()) for k in wdf.columns} if len(wdf) else None,
                       'weight_range': {k: [r4(wdf[k].min()), r4(wdf[k].max())] for k in wdf.columns} if len(wdf) else None}
    D = base['D'].copy()
    for m, p in preds.items():
        D['ens_' + m] = p
    for w, ss in WIN.items():
        d = fbs_fin(D, ss).dropna(subset=['ens_' + m for m in RT.STACKERS])
        for m in RT.STACKERS:
            res[m].setdefault('windows', {})[w] = margin_block(d.margin, d['ens_' + m])
            res[m]['windows'][w]['vs_mean'] = paired(d.margin, d['ens_' + m], d['ens_mean'])
            res[m]['windows'][w]['vs_current'] = paired(d.margin, d['ens_' + m], d['ens_sum_to_one_nonneg'])
    # drop-one: re-stack without each component (sum-to-one) — marginal contribution
    drop = {}
    for k in RT.COMPONENTS:
        comps = [c for c in RT.COMPONENTS if c != k]
        p, W = RT.stack(OOF, X, comps, 'sum_to_one_nonneg')
        D['drop_' + k] = p
        drop[k] = {}
        for w, ss in WIN.items():
            d = fbs_fin(D, ss).dropna(subset=['drop_' + k, 'ens_sum_to_one_nonneg'])
            drop[k][w] = paired(d.margin, d['drop_' + k], d['ens_sum_to_one_nonneg'])
    # small subsets
    subsets = {'C+D': ['C_ridge', 'D_gbm'], 'C+D+E': ['C_ridge', 'D_gbm', 'E_drive'],
               'B+C+D': ['B_elo', 'C_ridge', 'D_gbm'], 'C only': ['C_ridge'], 'D only': ['D_gbm'],
               'A+B+E (no matchup models)': ['A_adj_eff', 'B_elo', 'E_drive']}
    sub = {}
    for name, comps in subsets.items():
        for method in ('sum_to_one_nonneg', 'mean'):
            p, W = RT.stack(OOF, X, comps, method)
            key = '%s | %s' % (name, method)
            D['sub'] = p
            sub[key] = {}
            for w, ss in WIN.items():
                d = fbs_fin(D, ss).dropna(subset=['sub', 'ens_sum_to_one_nonneg'])
                sub[key][w] = dict(margin_block(d.margin, d['sub']),
                                   vs_current=paired(d.margin, d['sub'], d['ens_sum_to_one_nonneg']))
    return {'methods': res, 'drop_one_component': drop, 'subsets': sub}


# ============================================================ PHASE 7
ABLATION_GROUPS = {
    'EPA (current-season efficiency)': ['edge_epa', 'edge_epa_pass', 'edge_epa_rush', 'eff_pts_raw'],
    'success rate': ['edge_sr', 'edge_sr_pass', 'edge_sr_rush', 'edge_sr_early', 'edge_sr_pd', 'edge_sr_3rd'],
    'drive efficiency': ['drive_margin_raw', 'edge_ppd', 'edge_so_rate', 'edge_drive_epa'],
    'explosiveness': ['edge_expl', 'edge_expl_pass', 'edge_expl_rush'],
    'havoc': ['edge_havoc', 'edge_sack_rate', 'x_sack_h', 'x_sack_a'],
    'trenches': ['edge_line_yds', 'edge_stuff', 'edge_opp_rate'],
    'finishing drives': ['edge_pts_per_opp'],
    'preseason prior edges': ['edge_prior_epa', 'edge_prior_epa_pass', 'edge_prior_epa_rush', 'edge_prior_sr',
                              'edge_prior_ppd'],
    'QB model': ['qb_delta_edge', 'qb_exp_edge', 'h_qb_exp_db_log', 'a_qb_exp_db_log', 'h_qb_changed',
                 'a_qb_changed', 'qb_missing_any', 'qb_unsettled_any'],
    'recent form': ['edge_rec_epa', 'edge_rec_epa_pass', 'edge_rec_epa_rush', 'edge_rec_sr', 'edge_rec_ppd',
                    'l4_edge_epa', 'l2_edge_epa'],
    'home field': ['home_field'],
    'travel / time zone / altitude': ['travel_miles_log', 'tz_shift', 'altitude_kft'],
    'rest': ['rest_diff'],
    'special teams': ['edge_st_net', 'edge_fg_value'],
    'matchup interactions': ['x_pass_h', 'x_pass_a', 'x_rush_h', 'x_rush_a', 'x_sack_h', 'x_sack_a',
                             'match_mix_edge'],
    'results-based Elo': ['elo_diff'],
    'conference / postseason flags': ['conference_game_f', 'is_postseason_f'],
    'turnover rate (volatile)': ['edge_to_rate'],
}
NOT_TESTABLE = {
    'non-QB injuries': 'no point-in-time injury history exists in any reachable feed; the live overlay only widens intervals',
    'weather': 'no archived pregame forecasts; archived observed weather is hindsight (REJECTED)',
}
# Rebuilt priors (stage 3 with CFB_V2_PRIOR_DROP), compared with the same-code baseline out_fix
PRIOR_VARIANTS = {'recruiting / talent': 'talent', 'returning production': 'retprod', 'coaching': 'coach',
                  'last season ratings (program baseline)': 'lagged', 'all preseason information': 'noprior'}


def ats_clv(d, col):
    """Every game, at the opener, on the side the predictor prefers."""
    s = d[d.open_margin.notna() & d[col].notna()]
    side_home = (s[col] - s.open_margin) > 0
    diff = s.margin - s.open_margin
    res = np.where(diff == 0, 0.0, np.where((diff > 0) == side_home, 1.0, -1.0))
    clv = np.where(side_home, s.close_margin - s.open_margin, s.open_margin - s.close_margin)
    return res, clv


def window_scores(D, col, p_col):
    out = {}
    for w, ss in WIN.items():
        d = fbs_fin(D, ss)
        res, clv = ats_clv(d, col)
        dec = res[res != 0]
        out[w] = {'mae': r4((d[col] - d.margin).abs().mean()), 'rmse': r4(np.sqrt(((d[col] - d.margin) ** 2).mean())),
                  'brier': r4((((d.margin > 0).astype(float) - d[p_col]) ** 2).mean()),
                  'ats': r4((dec == 1).mean()), 'clv': r4(np.nanmean(clv))}
    return out


def compare_to_base(Db, Da, col='pred', p_col='p_win_raw'):
    """Ablated (a) minus baseline (b), paired on identical games."""
    out = {}
    j = Db[['game_id', 'season', 'status', 'fcs_game', 'margin', 'open_margin', 'close_margin', col, p_col]].merge(
        Da[['game_id', col, p_col]], on='game_id', suffixes=('_b', '_a'))
    for w, ss in WIN.items():
        d = fbs_fin(j, ss).dropna(subset=[col + '_b', col + '_a', p_col + '_b', p_col + '_a'])
        yw = (d.margin > 0).astype(float)
        ae_b, ae_a = (d[col + '_b'] - d.margin).abs(), (d[col + '_a'] - d.margin).abs()
        se_b, se_a = (d[col + '_b'] - d.margin) ** 2, (d[col + '_a'] - d.margin) ** 2
        br_b, br_a = (yw - d[p_col + '_b']) ** 2, (yw - d[p_col + '_a']) ** 2
        rb, cb = ats_clv(d.rename(columns={col + '_b': 'x'}), 'x')
        ra, ca = ats_clv(d.rename(columns={col + '_a': 'x'}), 'x')
        seasons = {}
        for S, g in d.groupby('season'):
            seasons[str(S)] = r4(((g[col + '_a'] - g.margin).abs() - (g[col + '_b'] - g.margin).abs()).mean())
        out[w] = {'n': int(len(d)), 'd_mae': r4((ae_a - ae_b).mean()), 'd_mae_ci': [r4(v) for v in boot((ae_a - ae_b).values)],
                  'd_rmse': r4(np.sqrt(se_a.mean()) - np.sqrt(se_b.mean())),
                  'd_brier': r4((br_a - br_b).mean()), 'd_brier_ci': [r4(v) for v in boot((br_a - br_b).values)],
                  'd_ats': r4((ra[ra != 0] == 1).mean() - (rb[rb != 0] == 1).mean()),
                  'd_clv': r4(np.nanmean(ca) - np.nanmean(cb)), 'd_mae_by_season': seasons,
                  'seasons_removal_hurts': int(sum(1 for v in seasons.values() if v is not None and v > 0)),
                  'seasons': len(seasons)}
    return out


def ablation_decision(r):
    """PRE-REGISTERED (docs/cfb-v2/HARDENING_PREREG.md), DEV window only.
    KEEP   removing it worsens dev MAE with the 95% CI above 0, or in >= 6 of 8 dev seasons
    REMOVE removing it does not worsen dev MAE (point estimate <= 0) and does not worsen dev Brier
    RETEST otherwise (a small positive effect the dev window cannot resolve)."""
    d = r['dev']
    lo = d['d_mae_ci'][0]
    if (lo is not None and lo > 0) or d['seasons_removal_hurts'] >= 6:
        return 'KEEP'
    if d['d_mae'] <= 0 and (d['d_brier'] or 0) <= 0:
        return 'REMOVE'
    return 'RETEST'


def phase7_ablation(X, MK, fam, base_D, variants_root):
    used = set(MD.features_for(fam['C'], drop=())) | set(MD.features_for(fam['D'], drop=())) | set(RT.A_COLS + RT.B_COLS + RT.E_COLS)
    res = {'groups': {}, 'prior_rebuilds': {}, 'not_testable': NOT_TESTABLE}
    for g, cols in ABLATION_GROUPS.items():
        in_model = [c for c in cols if c in used]
        if not in_model:
            res['groups'][g] = {'status': 'NOT IN CANDIDATE 001', 'cols': cols}
            continue
        r = RT.run(X, RT.Spec(fam['C'], fam['D'], drop=in_model, name='-' + g))
        Da = attach_market(r['D'], MK)
        cmp_ = compare_to_base(base_D, Da)
        res['groups'][g] = dict(cols_removed=in_model, decision=ablation_decision(cmp_), **cmp_)
    # prior-input rebuilds: each compared with the same-code baseline rebuild
    fx = os.path.join(variants_root, 'out_fix')
    if os.path.exists(os.path.join(fx, 'stage5', 'cfb_model_training_snapshots.parquet')):
        Xf, MKf = load(fx)
        Db = attach_market(RT.run(Xf, RT.Spec(fam['C'], fam['D']))['D'], MKf)
        for g, v in PRIOR_VARIANTS.items():
            p = os.path.join(variants_root, 'out_' + v)
            if not os.path.exists(os.path.join(p, 'stage5', 'cfb_model_training_snapshots.parquet')):
                res['prior_rebuilds'][g] = {'status': 'variant not built'}
                continue
            Xv, MKv = load(p)
            Da = attach_market(RT.run(Xv, RT.Spec(fam['C'], fam['D']))['D'], MKv)
            cmp_ = compare_to_base(Db, Da)
            res['prior_rebuilds'][g] = dict(variant=v, decision=ablation_decision(cmp_), **cmp_)
    return res


# ============================================================ PHASE 8
def phase8_overfit(X, MK, fam, base):
    out = {}
    # 1. train vs next-season (OOF) error, every component, every season
    D = base['D']
    tv = {}
    for S, ins in base['insample'].items():
        d = fbs_fin(D, [S])
        row = {'n_train': ins['n_train']}
        for k in RT.COMPONENTS:
            oof = r4((d['pred_' + k] - d.margin).abs().mean()) if len(d) else None
            row[k] = {'train_mae': r4(ins[k]), 'oof_mae': oof,
                      'gap': r4(oof - ins[k]) if oof is not None and ins[k] is not None else None}
        tv[str(S)] = row
    out['train_vs_oof'] = tv
    # 2. complexity sweeps (dev + holdout OOF MAE of the component itself)
    def comp_mae(spec, comp):
        r = RT.run_components(X, spec)[0]
        j = r.merge(X[['game_id', 'margin', 'status', 'fcs_game']], on='game_id')
        o = {}
        for w, ss in WIN.items():
            d = fbs_fin(j, ss)
            o[w] = r4((d['pred_' + comp] - d.margin).abs().mean())
        return o
    sweep_C = {}
    for a in (1, 3, 10, 30, 100, 300, 1000):
        sweep_C[str(a)] = comp_mae(RT.Spec(fam['C'], fam['D'], ridge_alpha=a), 'C_ridge')
    out['ridge_alpha_sweep'] = sweep_C
    base_g = dict(C.GBM_PARAMS)
    grid = {'current (7 leaves, 250 trees, lr .03)': {},
            '3 leaves': {'num_leaves': 3}, '15 leaves': {'num_leaves': 15}, '31 leaves': {'num_leaves': 31},
            '100 trees': {'n_estimators': 100}, '600 trees': {'n_estimators': 600},
            '1500 trees': {'n_estimators': 1500}, 'lr .1': {'learning_rate': 0.1},
            'min leaf 25': {'min_data_in_leaf': 25}, 'no L2': {'lambda_l2': 0.0},
            'squared loss': {'objective': 'regression'}}
    sweep_D = {}
    for name, ch in grid.items():
        sweep_D[name] = comp_mae(RT.Spec(fam['C'], fam['D'], gbm_params=dict(base_g, **ch)), 'D_gbm')
    out['gbm_sweep'] = sweep_D
    # 3. noise features: 10 pure-noise columns added to C and D
    rn = RT.run(X, RT.Spec(fam['C'], fam['D'], noise_cols=10, name='noise'), keep_models=True)
    Dn = attach_market(rn['D'], MK)
    out['noise_features'] = {'vs_base': compare_to_base(base['D'], Dn)}
    ranks = {}
    for S in (2020, 2023, 2026):
        g = rn['models'][S][0]['D_gbm'].gain()
        order = sorted(g, key=lambda k: -g[k])
        ranks[str(S)] = {'n_features': len(order),
                         'noise_ranks': sorted(order.index(c) + 1 for c in order if c.startswith('noise_')),
                         'top10': order[:10],
                         'noise_gain_share': r4(sum(v for k, v in g.items() if k.startswith('noise_')) / sum(g.values()))}
        cm = rn['models'][S][0]['C_ridge']
        coef = dict(zip(cm.cols, cm.m.coef_))
        ab = sorted(coef, key=lambda k: -abs(coef[k]))
        ranks[str(S)]['ridge_noise_ranks'] = sorted(ab.index(c) + 1 for c in ab if c.startswith('noise_'))
        ranks[str(S)]['ridge_top10'] = [(k, r4(coef[k])) for k in ab[:10]]
    out['noise_features']['ranks'] = ranks
    # 4. permutation importance (group-wise) on the holdout and dev, with the season models
    rk = RT.run(X, RT.Spec(fam['C'], fam['D']), keep_models=True, probs=False)
    rng = np.random.default_rng(C.SEED)
    perm = {}
    for g, cols in ABLATION_GROUPS.items():
        perm[g] = {}
        for w, ss in (('dev', WIN['dev']), ('holdout', WIN['holdout'])):
            deltas = []
            for S in ss:
                Xs = fbs_fin(X, [S])
                if Xs.empty:
                    continue
                fitted, _ = rk['models'][S]
                Xp = Xs.copy()
                idx = rng.permutation(len(Xp))
                for c in cols:
                    if c in Xp:
                        Xp[c] = Xp[c].values[idx]
                for k in ('C_ridge', 'D_gbm'):
                    m = fitted[k]
                    if not any(c in m.cols for c in cols):
                        continue
                    e0 = np.abs(m.predict(Xs) - Xs.margin.values)
                    e1 = np.abs(m.predict(Xp) - Xs.margin.values)
                    deltas.append((k, S, float((e1 - e0).mean()), len(Xs)))
            for k in ('C_ridge', 'D_gbm'):
                dk = [(d, n) for kk, S, d, n in deltas if kk == k]
                if dk:
                    perm[g].setdefault(k, {})[w] = r4(np.average([d for d, n in dk], weights=[n for d, n in dk]))
    out['permutation_importance_mae_increase'] = perm
    # 5. leave-one-training-season-out for the 2024 and 2025 fits
    loso = {}
    for S in (2024, 2025):
        base_fit = RT.fit_season(X, S, RT.Spec(fam['C'], fam['D']))[0]
        Xs = fbs_fin(X, [S])
        e0 = {k: float(np.abs(base_fit[k].predict(Xs) - Xs.margin).mean()) for k in ('C_ridge', 'D_gbm')}
        loso[str(S)] = {}
        for drop in range(C.FIRST_SNAPSHOT_SEASON, S):
            Xd = X[X.season.ne(drop)]
            f = RT.fit_season(Xd, S, RT.Spec(fam['C'], fam['D']))[0]
            loso[str(S)][str(drop)] = {k: r4(float(np.abs(f[k].predict(Xs) - Xs.margin).mean()) - e0[k])
                                       for k in ('C_ridge', 'D_gbm')}
    out['leave_one_training_season_out'] = loso
    # 6. by conference and by season: model vs market gap (collapse / dependence)
    d = fbs_fin(D, list(range(C.FIRST_STACK_SEASON, C.LIVE_SEASON + 1))).dropna(subset=['pred'])
    by_season = {}
    for S, g in d.groupby('season'):
        gg = g.dropna(subset=['open_margin'])
        by_season[str(S)] = {'n': int(len(g)), 'mae_v2': r4((g.pred - g.margin).abs().mean()),
                             'mae_open_same': r4((gg.open_margin - gg.margin).abs().mean()) if len(gg) else None,
                             'mae_v2_same': r4((gg.pred - gg.margin).abs().mean()) if len(gg) else None,
                             'mae_v1': r4((g.base_v1 - g.margin).abs().mean()) if g.base_v1.notna().any() else None}
    out['by_season'] = by_season
    conf = {}
    for c, g in d[d.season.isin(WIN['dev'] + WIN['holdout'])].groupby('home_conference'):
        gg = g.dropna(subset=['open_margin'])
        if len(g) >= 150:
            conf[c] = {'n': int(len(g)), 'mae_v2': r4((g.pred - g.margin).abs().mean()),
                       'bias_v2': r4((g.pred - g.margin).mean()),
                       'mae_open_same': r4((gg.open_margin - gg.margin).abs().mean()),
                       'mae_v2_same': r4((gg.pred - gg.margin).abs().mean())}
    out['by_home_conference_dev_holdout'] = conf
    return out


# ============================================================ PHASE 9
def cover_probs(D):
    """Walk-forward cover probabilities at the OPENER from the ensemble's error
    model, then raw / Platt / isotonic / beta calibration fit on earlier seasons."""
    D = D.copy()
    ok = D.open_margin.notna() & D.sigma.notna()
    D['pc_input'] = np.nan
    D.loc[ok, 'pc_input'] = 1 - RT.tcdf((D.loc[ok, 'open_margin'] - D.loc[ok, 'pred']) / D.loc[ok, 'sigma'],
                                      D.loc[ok, 't_df'])
    for k in RT.CALIBRATORS:
        D['pc_' + k.name] = np.nan
    for S in sorted(D.season.unique()):
        past = D[(D.season < S) & D.pc_input.notna() & D.status.eq('FINAL') & ~D.fcs_game.astype(bool)
                 & (D.margin != D.open_margin)]
        cur = D.season.eq(S) & D.pc_input.notna()
        if len(past) < 400 or not cur.any():
            continue
        RT.past_only(sorted(past.season.unique()), S)
        y = (past.margin > past.open_margin).astype(float).values
        for k in RT.CALIBRATORS:
            cal = k().fit(past.pc_input.values, y)
            D.loc[cur, 'pc_' + k.name] = cal.predict(D.loc[cur, 'pc_input'].values)
    return D


def phase9_calibration(D):
    D = cover_probs(D)
    out = {'win': {}, 'cover': {}}
    for w, ss in WIN.items():
        d = fbs_fin(D, ss)
        yw = (d.margin > 0).astype(float)
        out['win'][w] = {k.name: dict(prob_block(yw, d['p_win_' + k.name]),
                                      favorite_buckets=favorite_table(yw, d['p_win_' + k.name]))
                         for k in RT.CALIBRATORS}
        out['win'][w]['v1_own'] = dict(prob_block(yw, d.base_v1_winprob),
                                       favorite_buckets=favorite_table(yw, d.base_v1_winprob)) \
            if d.base_v1_winprob.notna().sum() > 100 else None
        c = d[d.pc_raw.notna() & d.open_margin.notna() & (d.margin != d.open_margin)]
        yc = (c.margin > c.open_margin).astype(float)
        out['cover'][w] = {k.name: dict(prob_block(yc, c['pc_' + k.name]),
                                        side_buckets=favorite_table(yc, c['pc_' + k.name]))
                           for k in RT.CALIBRATORS}
    # the selection rule: lowest DEV log loss
    out['win_choice_dev_logloss'] = min(out['win']['dev'], key=lambda k: out['win']['dev'][k]['log_loss']
                                        if isinstance(out['win']['dev'][k], dict) and 'log_loss' in out['win']['dev'][k]
                                        and k != 'v1_own' else 9)
    out['cover_choice_dev_logloss'] = min(out['cover']['dev'], key=lambda k: out['cover']['dev'][k].get('log_loss', 9))
    return out, D


# ============================================================ PHASE 10
def cov_rows(d):
    r = {'n': int(len(d))}
    for q in (50, 80, 95):
        inside = (d.margin >= d['lo_%d' % q]) & (d.margin <= d['hi_%d' % q])
        r['cov%d' % q] = r4(inside.mean()) if len(d) else None
    r['mean_width80'] = r4((d.hi_80 - d.lo_80).mean()) if len(d) else None
    return r


def phase10_uncertainty(D):
    out = {}
    for w, ss in WIN.items():
        d = D[D.season.isin(ss) & D.status.eq('FINAL') & D.margin.notna() & D.lo_80.notna()]
        fbs = d[~d.fcs_game.astype(bool)]
        fcs = d[d.fcs_game.astype(bool)]
        seg = {'all FBS-vs-FBS': cov_rows(fbs), 'FBS-vs-FCS': cov_rows(fcs)}
        if 'home_fbs' in fcs and len(fcs):
            # error oriented to the FBS side: negative = the FBS team is under-rated
            s_fbs = np.where(fcs.home_fbs.astype(bool), 1.0, -1.0)
            e = (fcs.pred - fcs.margin) * s_fbs
            seg['FBS-vs-FCS'].update(fbs_side_bias=r4(e.mean()), fbs_side_bias_ci=[r4(x) for x in boot(e.values)],
                                     mae=r4((fcs.pred - fcs.margin).abs().mean()))
        wk = pd.cut(fbs.weeks_in, [-1, 2, 5, 9, 30], labels=['wk0-2', 'wk3-5', 'wk6-9', 'wk10+']).astype(str)
        wk[fbs.is_postseason.astype(bool)] = 'postseason'
        for k, g in fbs.groupby(wk):
            seg['week ' + k] = cov_rows(g)
        fav = pd.cut(fbs.pred.abs(), [-0.1, 3, 7, 14, 21, 99], labels=['0-3', '3-7', '7-14', '14-21', '21+']).astype(str)
        for k, g in fbs.groupby(fav):
            seg['predicted margin ' + k] = cov_rows(g)
        qb = np.where(fbs.qb_missing_any.fillna(1) > 0, 'QB unknown (wk1)',
                      np.where(fbs.qb_unsettled_any.fillna(0) > 0, 'QB unsettled', 'QB settled'))
        for k, g in fbs.groupby(qb):
            seg[k] = cov_rows(g)
        if 'total_open' in fbs:
            tt = pd.cut(fbs.total_open, [0, 45, 55, 65, 200], labels=['total <45', 'total 45-55', 'total 55-65', 'total 65+']).astype(str)
            for k, g in fbs.groupby(tt):
                if k != 'nan':
                    seg[k] = cov_rows(g)
        q = fbs.ens_sd.quantile([0.33, 0.67]).values
        dis = np.where(fbs.ens_sd <= q[0], 'disagreement low', np.where(fbs.ens_sd <= q[1], 'disagreement mid', 'disagreement high'))
        for k, g in fbs.groupby(dis):
            seg[k] = cov_rows(g)
        for c, g in fbs.groupby('home_conference'):
            if len(g) >= 150:
                seg['conf ' + c] = cov_rows(g)
        seg['injury uncertainty'] = 'NOT TESTABLE: no historical point-in-time injury data'
        out[w] = seg
    return out


# ============================================================ PHASE 11
def postgame_table(out_root):
    """Post-game diagnostics per game (home minus away). EVALUATION ONLY —
    none of this can reach a model: it is built here, after the fact."""
    tg = pd.concat([pd.read_parquet(os.path.join(out_root, 'stage1', f))
                    for f in sorted(os.listdir(os.path.join(out_root, 'stage1'))) if f.startswith('team_game_')])
    qg = pd.concat([pd.read_parquet(os.path.join(out_root, 'stage1', f))
                    for f in sorted(os.listdir(os.path.join(out_root, 'stage1'))) if f.startswith('qb_game_')])
    G = pd.read_parquet(os.path.join(out_root, 'stage2', 'games.parquet'))
    g = G[['game_id', 'home_id', 'away_id']]
    h = g.merge(tg, left_on=['game_id', 'home_id'], right_on=['game_id', 'team_id'], how='left')
    a = g.merge(tg, left_on=['game_id', 'away_id'], right_on=['game_id', 'team_id'], how='left')
    P = pd.DataFrame({'game_id': g.game_id})
    P['pbp_missing'] = h.n_plays_all.isna().values | a.n_plays_all.isna().values
    P['to_margin'] = (a.turnovers - h.turnovers).values             # + = home won the turnover battle
    P['st_net'] = h.st_net_epa.values
    P['expl_diff'] = (h.expl - a.expl).values
    P['sr_margin'] = ((h.succ / h.n_plays - a.succ / a.n_plays) * (h.n_plays + a.n_plays) / 2).values
    P['plays_total'] = (h.n_plays_all + a.n_plays_all).values
    P['garbage_share'] = ((h.garbage_plays + a.garbage_plays) / (h.n_plays_all + a.n_plays_all)).values
    st = qg[qg.starter].drop_duplicates(['game_id', 'team_id'])
    sm = st.set_index(['game_id', 'team_id']).qb_id
    P['home_starter'] = [sm.get((x, y)) for x, y in zip(g.game_id, g.home_id)]
    P['away_starter'] = [sm.get((x, y)) for x, y in zip(g.game_id, g.away_id)]
    # observed weather (post-hoc diagnostic only; REJECTED as a feature: hindsight)
    md = C.DATA and os.path.join(C.DATA, 'mline')
    if md and os.path.isdir(md):
        w = pd.concat([pd.read_parquet(os.path.join(md, f), columns=['game_id', 'wind_speed', 'precipitation', 'temperature'])
                       for f in sorted(os.listdir(md))]).drop_duplicates('game_id')
        P = P.merge(w, on='game_id', how='left')
    return P


MISS_CLASSES = ['data-source error', 'model sign/join bug', 'QB injury/change', 'turnover variance',
                'special-teams variance', 'explosive plays', 'garbage time', 'weather', 'pace',
                'bad preseason prior', 'recent-form overreaction', 'matchup interaction failure',
                'FCS data weakness', 'ordinary football variance']


def phase11_misses(D, X, out_root, n_worst=150):
    P = postgame_table(out_root)
    snap = X[['game_id', 'h_qb_id', 'a_qb_id', 'exp_plays_total', 'weeks_in'] +
             [c for c in ('form_epa', 'x_pass_h', 'x_pass_a', 'x_rush_h', 'x_rush_a', 'match_mix_edge') if c in X]]
    J = D.merge(P, on='game_id', how='left').merge(snap.drop(columns=['weeks_in']), on='game_id', how='left')
    J['err'] = J.margin - J.pred                                     # + = home did better than predicted
    dev = fbs_fin(J, WIN['dev']).dropna(subset=['to_margin', 'st_net', 'expl_diff', 'sr_margin'])
    # post-game decomposition, fitted on DEV: how much of a miss each ingredient explains
    comps = ['to_margin', 'st_net', 'expl_diff', 'sr_margin']
    A = np.column_stack([np.ones(len(dev))] + [dev[c].values for c in comps])
    beta = np.linalg.lstsq(A, dev.err.values, rcond=None)[0]
    r2 = 1 - np.var(dev.err.values - A @ beta) / np.var(dev.err.values)
    coef = dict(zip(['intercept'] + comps, [r4(b) for b in beta]))

    pool = J[J.season.isin(WIN['dev'] + WIN['holdout']) & J.status.eq('FINAL') & J.margin.notna() & J.pred.notna()]
    worst = pool.reindex(pool.err.abs().sort_values(ascending=False).index).head(n_worst)
    rows = []
    for _, r in worst.iterrows():
        e = r.err
        contrib = {c: (beta[i + 1] * r[c]) if pd.notna(r[c]) else 0.0 for i, c in enumerate(comps)}
        cls, why = None, ''
        if r.fcs_game:
            cls, why = 'FCS data weakness', 'FBS-vs-FCS game (never priced)'
        elif r.pbp_missing:
            cls, why = 'data-source error', 'play-by-play missing for one team'
        elif pd.notna(r.open_margin) and abs(r.pred - r.open_margin) > 21 and abs(r.pred + r.open_margin) <= 7:
            cls, why = 'model sign/join bug', 'prediction and market disagree in a sign-flip pattern'
        elif (pd.notna(r.h_qb_id) and pd.notna(r.home_starter) and r.h_qb_id != r.home_starter
              and np.sign(e) < 0) or (pd.notna(r.a_qb_id) and pd.notna(r.away_starter)
                                      and r.a_qb_id != r.away_starter and np.sign(e) > 0):
            cls, why = 'QB injury/change', 'the team that underperformed started a different QB than expected'
        if cls is None:
            share = {k: v / e for k, v in contrib.items() if abs(e) > 0}
            best = max(share, key=share.get)
            if share[best] >= 0.4 and best != 'sr_margin':
                cls = {'to_margin': 'turnover variance', 'st_net': 'special-teams variance',
                       'expl_diff': 'explosive plays'}[best]
                why = '%s explains %.0f%% of the miss' % (best, 100 * share[best])
            elif pd.notna(r.get('wind_speed')) and (r.wind_speed >= 20 or (r.get('precipitation') or 0) >= 0.3):
                cls, why = 'weather', 'observed wind %.0f mph / precip %.2f (post-hoc)' % (r.wind_speed, r.get('precipitation') or 0)
            elif (r.garbage_share or 0) >= 0.3:
                cls, why = 'garbage time', 'garbage share %.0f%%' % (100 * r.garbage_share)
            elif pd.notna(r.exp_plays_total) and abs(r.plays_total - r.exp_plays_total) > 40:
                cls, why = 'pace', 'plays %d vs expected %d' % (r.plays_total, r.exp_plays_total)
            elif r.weeks_in < 4 and not r.is_postseason:
                cls, why = 'bad preseason prior', 'week %.0f: efficiency far from the preseason prior' % r.weeks_in
            elif pd.notna(r.get('form_epa')) and np.sign(r.form_epa) == -np.sign(e) and abs(r.form_epa) > 0.5:
                cls, why = 'recent-form overreaction', 'recent-form edge pointed the wrong way'
            elif share.get('sr_margin', 0) >= 0.6:
                cls, why = 'ordinary football variance', 'a real efficiency swing (success margin) the ratings could not know'
            else:
                cls, why = 'ordinary football variance', 'no single post-game factor explains it'
        rows.append({'game_id': int(r.game_id), 'season': int(r.season), 'week': int(r.week) if pd.notna(r.week) else None,
                     'pred': r4(r.pred), 'margin': r4(r.margin), 'error': r4(e), 'open': r4(r.open_margin),
                     'class': cls, 'why': why, 'to_margin': r4(r.to_margin), 'st_net': r4(r.st_net),
                     'expl_diff': r4(r.expl_diff), 'sr_margin': r4(r.sr_margin)})
    W = pd.DataFrame(rows)
    freq = W['class'].value_counts().to_dict()
    # the same decomposition over ALL games: how much of V2's error is irreducible game variance
    allg = fbs_fin(J, WIN['dev'] + WIN['holdout']).dropna(subset=comps)
    A2 = np.column_stack([np.ones(len(allg))] + [allg[c].values for c in comps])
    expl = A2 @ beta
    return {'n_worst': len(W), 'class_frequency': freq, 'decomposition_coef_dev': coef,
            'decomposition_r2_dev': r4(r2),
            'share_of_error_variance_explained_by_postgame_luck_factors': {
                'turnovers+special teams+explosives (no success margin)': r4(1 - np.var(allg.err - (
                    beta[1] * allg.to_margin + beta[2] * allg.st_net + beta[3] * allg.expl_diff)) / np.var(allg.err))},
            'worst': rows, 'market_also_missed_share': r4(
                (W.dropna(subset=['open']).apply(lambda x: abs(x.margin - x.open) > 21, axis=1)).mean())}


# ============================================================ PHASE 12
def team_history(out_root):
    """Per team-game: previous game margin, turnover margin, EPA margin (for residual slices)."""
    G = pd.read_parquet(os.path.join(out_root, 'stage2', 'games.parquet'))
    G = G[G.status.eq('FINAL')]
    tg = pd.concat([pd.read_parquet(os.path.join(out_root, 'stage1', f))
                    for f in sorted(os.listdir(os.path.join(out_root, 'stage1'))) if f.startswith('team_game_')])
    tg = tg[['game_id', 'team_id', 'turnovers', 'epa_sum', 'n_plays']]
    rows = []
    for side, other in (('home', 'away'), ('away', 'home')):
        d = G[['game_id', 'season', 'kickoff_ts', side + '_id', other + '_id', 'margin']].rename(
            columns={side + '_id': 'team_id', other + '_id': 'opp_id'})
        d['team_margin'] = d.margin if side == 'home' else -d.margin
        rows.append(d)
    L = pd.concat(rows).merge(tg, on=['game_id', 'team_id'], how='left').merge(
        tg.rename(columns={'team_id': 'opp_id', 'turnovers': 'opp_to', 'epa_sum': 'opp_epa', 'n_plays': 'opp_n'}),
        on=['game_id', 'opp_id'], how='left')
    L['to_margin'] = L.opp_to - L.turnovers
    L['epa_margin'] = L.epa_sum / L.n_plays - L.opp_epa / L.opp_n
    L = L.sort_values(['team_id', 'kickoff_ts'])
    g = L.groupby(['team_id', 'season'])
    L['prev_margin'] = g.team_margin.shift(1)
    L['prev_to_margin'] = g.to_margin.shift(1)
    L['prev_epa_margin'] = g.epa_margin.shift(1)
    L['to_margin_last3'] = g.to_margin.transform(lambda x: x.shift(1).rolling(3, min_periods=2).sum())
    return L[['game_id', 'team_id', 'prev_margin', 'prev_to_margin', 'prev_epa_margin', 'to_margin_last3']]


def oriented_bias(d, orient):
    """mean(pred - actual) with the sign oriented to a team of interest: > 0 means
    V2 OVERRATED that team."""
    e = (d.pred - d.margin) * orient
    return {'n': int(len(e)), 'bias': r4(e.mean()), 'ci': [r4(v) for v in boot(e.values)]}


def phase12_residuals(D, X, out_root):
    H = team_history(out_root).set_index(['game_id', 'team_id'])
    J = D.merge(X[['game_id', 'elo_home', 'elo_away', 'exp_plays_total', 'edge_expl', 'h_epa__off', 'a_epa__off']],
                on='game_id', how='left')
    for side in ('home', 'away'):
        tid = J[side + '_id']
        for c in ('prev_margin', 'prev_to_margin', 'prev_epa_margin', 'to_margin_last3'):
            J['%s_%s' % (side[0], c)] = [H[c].get((g, t), np.nan) for g, t in zip(J.game_id, tid)]
    out = {}
    for w, ss in (('dev', WIN['dev']), ('holdout', WIN['holdout'])):
        d = fbs_fin(J, ss).dropna(subset=['pred'])
        R = {}
        fav = np.sign(d.pred).replace(0, 1)
        R['favourites (oriented to V2 favourite)'] = oriented_bias(d, fav)
        big = d.pred.abs() > 21
        R['huge predicted margins (>21), favourite'] = oriented_bias(d[big], fav[big])
        R['home teams (non-neutral)'] = oriented_bias(d[~d.neutral_site.astype(bool)], 1.0)
        mf = np.sign(d.open_margin).replace(0, 1)
        dm = d.open_margin.notna()
        R['market favourites'] = oriented_bias(d[dm], mf[dm])
        R['market favourites > 21'] = oriented_bias(d[dm & (d.open_margin.abs() > 21)], mf[dm & (d.open_margin.abs() > 21)])
        hp, ap = is_p4(d.home_conference, d.season), is_p4(d.away_conference, d.season)
        mixed = hp ^ ap
        R['P4 team in P4-vs-G5'] = oriented_bias(d[mixed], np.where(hp[mixed], 1.0, -1.0))
        lowt = d.total_open < 45
        R['low totals (<45)'] = oriented_bias(d[lowt], fav[lowt])
        hight = d.total_open > 65
        R['high totals (>65), favourite'] = oriented_bias(d[hight], fav[hight])
        R['early season (<4 weeks), favourite'] = oriented_bias(d[d.weeks_in < 4], fav[d.weeks_in < 4])
        # team-history slices, oriented to the team with the property
        for name, col, cond in (('after a blowout win (>= 28)', 'prev_margin', lambda x: x >= 28),
                                ('after a close loss (<= 7) while winning EPA/play', None, None),
                                ('after +3 turnover margin last game', 'prev_to_margin', lambda x: x >= 3),
                                ('after +4 turnover margin over last 3', 'to_margin_last3', lambda x: x >= 4)):
            parts = []
            for side, o in (('h', 1.0), ('a', -1.0)):
                if col is None:
                    m = (d['%s_prev_margin' % side] < 0) & (d['%s_prev_margin' % side] >= -7) & (d['%s_prev_epa_margin' % side] > 0)
                else:
                    m = cond(d['%s_%s' % (side, col)])
                m = m.fillna(False)
                parts.append(((d.pred - d.margin)[m] * o))
            e = pd.concat(parts)
            R[name] = {'n': int(len(e)), 'bias': r4(e.mean()), 'ci': [r4(v) for v in boot(e.values)]}
        ex = d.edge_expl.abs() > d.edge_expl.abs().quantile(0.8)
        R['more explosive team (top-quintile explosiveness edge)'] = oriented_bias(d[ex], np.sign(d.edge_expl[ex]))
        # continuous: calibration of the margin (actual ~ a + b * pred)
        b = np.polyfit(d.pred, d.margin, 1)
        R['margin calibration slope (actual on predicted)'] = {'slope': r4(b[0]), 'intercept': r4(b[1]),
                                                               'note': 'slope < 1: favourites overrated'}
        # binned residual means for the continuous axes
        bins = {}
        for axis, v, edges in (('predicted margin', d.pred, [-99, -21, -14, -7, -3, 0, 3, 7, 14, 21, 99]),
                               ('market margin (open)', d.open_margin, [-99, -21, -14, -7, -3, 0, 3, 7, 14, 21, 99]),
                               ('total (open)', d.total_open, [0, 45, 50, 55, 60, 65, 200]),
                               ('week', d.weeks_in, [-1, 1, 2, 3, 4, 6, 9, 12, 30]),
                               ('home Elo', d.elo_home, [0, 1300, 1400, 1500, 1600, 1700, 3000]),
                               ('expected plays', d.exp_plays_total, [0, 130, 140, 150, 160, 400]),
                               ('model disagreement (ens_sd)', d.ens_sd, [0, 1, 1.5, 2, 3, 99]),
                               ('min games played', d.min_games, [-1, 0, 2, 4, 7, 20]),
                               ('QB unsettled', d.qb_unsettled_any.fillna(0), [-0.5, 0.5, 1.5])):
            cut = pd.cut(v, edges)
            bins[axis] = {str(k): {'n': int(len(g)), 'mean_resid_actual_minus_pred': r4((g.margin - g.pred).mean())}
                          for k, g in d.groupby(cut, observed=True) if len(g) >= 30}
        R['_binned'] = bins
        out[w] = R
    # a bias is SYSTEMATIC only if the dev CI excludes 0 and the holdout agrees in sign
    flags = {}
    for k, v in out['dev'].items():
        if k.startswith('_') or 'ci' not in v:
            continue
        h = out['holdout'].get(k, {})
        lo, hi = v['ci']
        dev_sig = lo is not None and (lo > 0 or hi < 0)
        same = h.get('bias') is not None and np.sign(h['bias']) == np.sign(v['bias'])
        hlo, hhi = h.get('ci', [None, None])
        hold_sig = hlo is not None and (hlo > 0 or hhi < 0)
        flags[k] = ('SYSTEMATIC (dev and holdout)' if dev_sig and same and hold_sig else
                    'dev only / holdout same sign' if dev_sig and same else
                    'dev only (did not replicate)' if dev_sig else 'not significant')
    out['verdict'] = flags
    return out


def is_p4(conf, season):
    """Power tier per season: the Pac-12 is a peer through 2023, not after."""
    base = conf.isin(['SEC', 'Big Ten', 'Big 12', 'ACC'])
    return base | (conf.eq('Pac-12') & (season < 2024))


# ============================================================ PHASE 13-16
def closing_prices():
    """Consensus CLOSING spread price per side from the multi-book archive
    (2014-2019 carry prices; later seasons do not). Books quoting the consensus
    number only; median American odds per side."""
    import sys as _s
    v1r = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'cfb_p4', 'research'))
    os.environ.setdefault('CFB_P4_DATA', os.path.join(C.DATA, 'v1'))
    if v1r not in _s.path:
        _s.path.insert(0, v1r)
    import build_market as V1BM
    L = V1BM._load_raw()
    amap = V1BM.resolve_abbr_sides(L)
    S = V1BM._side_frame(L, amap)
    S = S[S.market_type.eq('spread') & S.is_home.notna() & S.odds.notna() & S.lines.notna()].copy()
    S['odds'] = pd.to_numeric(S.odds, errors='coerce')
    S = S[S.odds.abs().between(100, 400)]
    S['is_home'] = S.is_home.astype(bool)
    S['home_line'] = np.where(S.is_home, S.lines, -S.lines)
    med = S.groupby('game_id').home_line.median()
    S = S[np.isclose(S.home_line, S.game_id.map(med))]
    # American odds are discontinuous at +/-100 (a median of +107 and -107 is ~0):
    # take the median of the PAYOUT per unit risked, then convert back
    S['b'] = payout(S.odds.values)
    P = S.groupby(['game_id', 'is_home']).b.median().unstack()
    P = P.apply(lambda col: np.where(col >= 1, 100 * col, -100 / col))
    P.columns = ['price_away_close' if not c else 'price_home_close' for c in P.columns]
    return P.reset_index()


def payout(american):
    a = np.asarray(american, float)
    return np.where(a > 0, a / 100.0, 100.0 / np.abs(a))


def grade(margin, line, side_home):
    diff = margin - line
    return np.where(diff == 0, 0.0, np.where((diff > 0) == side_home, 1.0, -1.0))


def bet_frame(D):
    """Every game with an opener, on the side of the calibrated cover probability."""
    d = D[D.open_margin.notna() & D.pc_platt.notna() & D.status.eq('FINAL') & ~D.fcs_game.astype(bool)].copy()
    d['gap'] = d.pred - d.open_margin
    d['side_home'] = d.pc_platt >= 0.5
    d['p_side'] = np.where(d.side_home, d.pc_platt, 1 - d.pc_platt)
    d['p_side_raw'] = np.where(d.side_home, d.pc_raw, 1 - d.pc_raw)
    d['ev'] = d.p_side * (100 / 110) - (1 - d.p_side)
    d['res_open'] = grade(d.margin.values, d.open_margin.values, d.side_home.values)
    d['units_open'] = np.where(d.res_open == 1, 100 / 110, np.where(d.res_open == -1, -1.0, 0.0))
    hc = d.close_margin.notna()
    d['res_close'] = np.where(hc, grade(d.margin.values, d.close_margin.fillna(0).values, d.side_home.values), np.nan)
    # actual closing juice where the archive has it, -110 otherwise (flagged)
    price = np.where(d.side_home, d.get('price_home_close', np.nan), d.get('price_away_close', np.nan))
    d['price_close'] = price
    d['price_actual'] = pd.notna(price)
    po = np.where(pd.notna(price), payout(np.where(pd.notna(price), price, -110)), 100 / 110)
    d['units_close'] = np.where(d.res_close == 1, po, np.where(d.res_close == -1, -1.0, np.where(d.res_close == 0, 0.0, np.nan)))
    d['units_close_110'] = np.where(d.res_close == 1, 100 / 110, np.where(d.res_close == -1, -1.0, np.where(d.res_close == 0, 0.0, np.nan)))
    d['move'] = d.close_margin - d.open_margin
    d['move_toward'] = np.where(d.side_home, d.move, -d.move)               # CLV in points
    d['gap_side'] = np.where(d.side_home, d.gap, -d.gap)
    return d


def streaks(res):
    worst = best = cur_l = cur_w = 0
    for r in res:
        if r == -1:
            cur_l += 1; cur_w = 0
        elif r == 1:
            cur_w += 1; cur_l = 0
        worst, best = max(worst, cur_l), max(best, cur_w)
    return worst, best


def bet_stats(b, units='units_open', res='res_open'):
    b = b.sort_values('kickoff_ts')
    u = b[units].dropna().values
    r = b[res].dropna().values
    if len(u) == 0:
        return {'n': 0}
    dec = r[r != 0]
    cum = np.cumsum(u)
    dd = float(np.max(np.maximum.accumulate(np.concatenate([[0], cum]))[1:] - cum))
    ls, ws = streaks(r)
    return {'n': int(len(u)), 'win_rate': r4((dec == 1).mean()) if len(dec) else None,
            'win_rate_ci': [r4(v) for v in boot((dec == 1).astype(float))] if len(dec) >= 20 else None,
            'roi': r4(u.mean()), 'roi_ci': [r4(v) for v in boot(u)], 'units': r4(u.sum()),
            'clv_mean': r4(np.nanmean(b.move_toward)), 'clv_pos_share': r4((b.move_toward.dropna() > 0).mean()),
            'avg_gap': r4(b.gap_side.mean()), 'max_drawdown': r4(dd), 'longest_losing_streak': int(ls),
            'longest_winning_streak': int(ws),
            'cover_brier': r4(((b[res].dropna() == 1).astype(float) - b.p_side[b[res].notna()]).pow(2)[b[res].dropna() != 0].mean())}


GAP_BUCKETS = [0, 1, 2, 3, 4, 5, 7, 99]


def movement_frame(D):
    """Every priced game with an opener and a close, 2016+, oriented by the
    PURE model's disagreement with the opener (not by a calibrated side)."""
    d = D[D.open_margin.notna() & D.close_margin.notna() & D.pred.notna() & D.status.eq('FINAL')
          & ~D.fcs_game.astype(bool)].copy()
    d['gap'] = d.pred - d.open_margin
    d['move'] = d.close_margin - d.open_margin
    d['move_toward'] = np.where(d.gap > 0, d.move, -d.move)
    # rows production would never act on: a disagreement beyond the review gap, or
    # the sign-flip pattern (engine orientation guard)
    d['review'] = (d.gap.abs() >= 14) | ((d.gap.abs() > 21) & ((d.pred + d.open_margin).abs() <= 7))
    return d


def phase13_market(D):
    B = bet_frame(D)
    MV = movement_frame(D)
    out = {}
    for w, ss in WIN.items():
        d = B[B.season.isin(ss)]
        dm = MV[MV.season.isin(ss)]
        mvr = dm[~dm.review]
        o = {'n_bet_frame': int(len(d)), 'n_movement': int(len(dm)),
             'mae_v2': r4((dm.pred - dm.margin).abs().mean()), 'mae_open': r4((dm.open_margin - dm.margin).abs().mean()),
             'v2_minus_open': paired(dm.margin, dm.pred, dm.open_margin),
             'v2_minus_close': paired(dm.margin, dm.pred, dm.close_margin),
             'close_moved_toward_v2_share_of_moves': r4((dm.move_toward[dm.move != 0] > 0).mean()),
             'mean_clv_all_games': r4(dm.move_toward.mean()), 'mean_clv_ci': [r4(v) for v in boot(dm.move_toward.values)],
             'mean_clv_excluding_review_rows': r4(mvr.move_toward.mean()),
             'mean_clv_excluding_review_ci': [r4(v) for v in boot(mvr.move_toward.values)],
             'review_rows': int(dm.review.sum()),
             'mean_clv_calibrated_side_bet_frame': r4(d.dropna(subset=['close_margin']).move_toward.mean())}
        # does a bigger opener disagreement predict more movement toward the model?
        x, y = dm.gap.values, dm.move.values
        b = float(np.sum(x * y) / np.sum(x * x))
        rng = np.random.default_rng(C.SEED)
        bs = []
        for _ in range(BOOT):
            i = rng.integers(0, len(x), len(x))
            bs.append(np.sum(x[i] * y[i]) / np.sum(x[i] * x[i]))
        o['move_on_gap_slope'] = {'slope': r4(b), 'ci': [r4(np.percentile(bs, 2.5)), r4(np.percentile(bs, 97.5))],
                                  'meaning': 'points the close moves toward V2 per point of opener disagreement'}
        # the same for V1: is V2 more informative about the close than V1 was?
        dv = dm.dropna(subset=['base_v1'])
        if len(dv) > 200:
            x1 = (dv.base_v1 - dv.open_margin).values
            o['v1_move_on_gap_slope'] = r4(np.sum(x1 * dv.move.values) / np.sum(x1 * x1))
            A = np.column_stack([dv.gap.values, x1])
            o['joint_move_regression_v2_v1'] = [r4(v) for v in np.linalg.lstsq(A, dv.move.values, rcond=None)[0]]
        bk = pd.cut(d.gap.abs(), GAP_BUCKETS, right=False)
        bkm = pd.cut(dm.gap.abs(), GAP_BUCKETS, right=False)
        tab = {}
        for k, g in d.groupby(bk, observed=True):
            gm = g[g.close_margin.notna()]
            mm = dm[bkm == k]
            st = bet_stats(g)
            tab[str(k)] = {'n': int(len(g)), 'n_movement': int(len(mm)),
                           'avg_move_toward_model': r4(mm.move_toward.mean()),
                           'move_ci': [r4(v) for v in boot(mm.move_toward.values)],
                           'pos_clv_share': r4((mm.move_toward > 0).mean()),
                           'ats_open': st.get('win_rate'), 'ats_open_ci': st.get('win_rate_ci'),
                           'roi_open': st.get('roi'), 'roi_open_ci': st.get('roi_ci'),
                           'ats_close': bet_stats(gm, 'units_close_110', 'res_close').get('win_rate'),
                           'roi_close': bet_stats(gm, 'units_close_110', 'res_close').get('roi'),
                           'tiny': len(g) < 100}
        o['gap_buckets'] = tab
        out[w] = o
    return out, B


RULE_GRID = dict(gap=(0, 1, 2, 3, 4, 5, 7), p=(0.5, 0.51, 0.52, 0.53), rel=(0, 50, 65, 80), sd=(99, 3, 2),
                 cap=(99, 10, 7))


def rule_masks(d):
    specs, masks = [], []
    ag, p, rel, sd = d.gap.abs().values, d.p_side.values, d.reliability.fillna(0).values, d.ens_sd.values
    for g in RULE_GRID['gap']:
        for pm in RULE_GRID['p']:
            for rm in RULE_GRID['rel']:
                for sm in RULE_GRID['sd']:
                    for cap in RULE_GRID['cap']:
                        if cap <= g:
                            continue
                        m = (ag >= g) & (ag < cap) & (p >= pm) & (rel >= rm) & (sd <= sm)
                        if m.sum() < 150:
                            continue
                        specs.append(dict(min_gap=g, max_gap=cap, min_cover_p=pm, min_reliability=rm, max_ens_sd=sm))
                        masks.append(m)
    return specs, np.array(masks, dtype=float)


def phase14_thresholds(B, n_null=500):
    """Choose on DEV only (max lower-90% ROI bound, n >= 150), reality-check against
    the same search on coin-flip worlds, then score ONCE on the holdout."""
    dev = B[B.season.isin(WIN['dev'])].reset_index(drop=True)
    specs, Mk = rule_masks(dev)
    u = dev.units_open.values
    n = Mk.sum(axis=1)

    def lb(units):
        s1, s2 = Mk @ units, Mk @ units ** 2
        m = s1 / n
        v = (s2 - n * m ** 2) / np.maximum(n - 1, 1)
        return m - 1.645 * np.sqrt(np.maximum(v, 0) / n), m
    l, m = lb(u)
    i = int(np.argmax(l))
    rng = np.random.default_rng(C.SEED)
    push = dev.res_open.values == 0
    null = []
    for _ in range(n_null):
        c = np.where(rng.random(len(u)) < 0.5, 100 / 110, -1.0)
        c[push] = 0.0
        null.append(float(np.max(lb(c)[0])))
    q95 = float(np.quantile(null, 0.95))
    best = specs[i]

    def apply(d, r):
        return d[(d.gap.abs() >= r['min_gap']) & (d.gap.abs() < r['max_gap']) & (d.p_side >= r['min_cover_p'])
                 & (d.reliability.fillna(0) >= r['min_reliability']) & (d.ens_sd <= r['max_ens_sd'])]
    res = {'grid_size': len(specs), 'selection': 'max lower 90% bound of ROI/bet at the opener (-110), dev 2016-2023, n>=150',
           'best_rule': best, 'dev_best_roi': r4(m[i]), 'dev_best_roi_lb90': r4(l[i]),
           'reality_check': {'null_worlds': n_null, 'null_q95_of_best_lb90': r4(q95),
                             'p_value': r4(float(np.mean(np.array(null) >= l[i]))),
                             'passes': bool(l[i] > q95)},
           'rules_with_positive_lb90_dev': int((l > 0).sum())}
    for w in ('dev', 'holdout', 'live'):
        d = apply(B[B.season.isin(WIN[w])], best)
        res[w] = {'at_open_-110': bet_stats(d), 'at_close_same_side_-110': bet_stats(d, 'units_close_110', 'res_close')}
        if w == 'dev':
            res[w]['at_close_actual_juice'] = bet_stats(d, 'units_close', 'res_close')
            res[w]['share_with_actual_price'] = r4(d.price_actual.mean())
    # reliability segmentation of the simple gap >= 3 rule
    seg = {}
    for w in ('dev', 'holdout'):
        d = B[B.season.isin(WIN[w]) & (B.gap.abs() >= 3)]
        rb = pd.cut(d.reliability, [-1, 50, 65, 80, 101], labels=['<50', '50-65', '65-80', '80+']).astype(str)
        seg[w] = {k: bet_stats(g) for k, g in d.groupby(rb)}
    res['gap3_by_reliability'] = seg
    # the threshold curve: one condition at a time (dev and holdout side by side)
    curve = {}
    for g in (0, 1, 2, 3, 4, 5, 7, 10):
        curve['gap>=%d' % g] = {w: bet_stats(B[B.season.isin(WIN[w]) & (B.gap.abs() >= g)]) for w in ('dev', 'holdout')}
    for pm in (0.5, 0.51, 0.52, 0.53, 0.54):
        curve['cover_p>=%.2f' % pm] = {w: bet_stats(B[B.season.isin(WIN[w]) & (B.p_side >= pm)]) for w in ('dev', 'holdout')}
    res['one_condition_curves'] = curve
    return res, best


def kelly_sim(b, frac, start=100.0, unit_col='units_open', res_col='res_open', cap=0.05):
    bank, peak, mdd, path = start, start, 0.0, []
    for _, r in b.sort_values('kickoff_ts').iterrows():
        if pd.isna(r[res_col]):
            continue
        bb = 100 / 110
        f = max(0.0, (bb * r.p_side - (1 - r.p_side)) / bb) * frac
        stake = min(f, cap) * bank
        if r[res_col] == 1:
            bank += stake * bb
        elif r[res_col] == -1:
            bank -= stake
        peak = max(peak, bank)
        mdd = max(mdd, (peak - bank) / peak)
        path.append(bank)
    return {'ending_bankroll': r4(bank), 'max_drawdown_pct': r4(100 * mdd), 'n_bets': len(path)}


def flat_sim(b, stake, start=100.0, unit_col='units_open'):
    u = b.sort_values('kickoff_ts')[unit_col].dropna().values * stake
    if not len(u):
        return {'n_bets': 0}
    cum = start + np.cumsum(u)
    peak = np.maximum.accumulate(np.concatenate([[start], cum]))[1:]
    return {'n_bets': int(len(u)), 'units_won': r4(u.sum()), 'roi': r4(u.sum() / (stake * len(u))),
            'ending_bankroll': r4(cum[-1]), 'max_drawdown_units': r4(np.max(peak - cum)),
            'volatility_per_bet': r4(u.std()), 'sharpe_like_per_season': r4(u.mean() / u.std() * np.sqrt(len(u) / max(1, b.season.nunique()))) if u.std() > 0 else None}


def phase15_bankroll(B, rule):
    def apply(d, r):
        return d[(d.gap.abs() >= r['min_gap']) & (d.gap.abs() < r['max_gap']) & (d.p_side >= r['min_cover_p'])
                 & (d.reliability.fillna(0) >= r['min_reliability']) & (d.ens_sd <= r['max_ens_sd'])]
    out = {'assumptions': {'start_bankroll_units': 100, 'price': '-110 at the opener (optimistic fill) and at the close (achievable); '
                           'actual closing juice where the archive has it (2014-2019)', 'kelly_stake_cap': '5% of bankroll',
                           'fills': 'the Tuesday 12:00 UTC freeze is AFTER the opener is posted: an opener fill assumes the '
                                    'prediction existed when the opener did (see phase 16); the close is always fillable'}}
    for w in ('dev', 'holdout', 'live'):
        d = apply(B[B.season.isin(WIN[w])], rule)
        o = {}
        for label, uc, rc in (('open_-110', 'units_open', 'res_open'), ('close_-110', 'units_close_110', 'res_close')):
            o[label] = {'flat_0.5u': flat_sim(d, 0.5, unit_col=uc), 'flat_1u': flat_sim(d, 1.0, unit_col=uc),
                        'kelly_0.10': kelly_sim(d, 0.10, unit_col=uc, res_col=rc),
                        'kelly_0.25': kelly_sim(d, 0.25, unit_col=uc, res_col=rc),
                        'streaks': dict(zip(('worst_losing', 'best_winning'), streaks(d.sort_values('kickoff_ts')[rc].dropna().values)))}
        if w == 'dev':
            o['close_actual_juice_flat_1u'] = flat_sim(d, 1.0, unit_col='units_close')
        out[w] = o
    return out


def phase16_decay(B, X):
    out = {}
    for w in ('dev', 'holdout', 'live'):
        d = B[B.season.isin(WIN[w]) & B.close_margin.notna()]
        o = {'n': int(len(d)),
             'mean_abs_gap_at_open': r4((d.pred - d.open_margin).abs().mean()),
             'mean_abs_gap_at_close': r4((d.pred - d.close_margin).abs().mean()),
             'share_of_open_gap_closed_by_market': r4(1 - (d.pred - d.close_margin).abs().mean() / (d.pred - d.open_margin).abs().mean()),
             'ats_at_open': bet_stats(d).get('win_rate'), 'ats_at_close_same_side': bet_stats(d, 'units_close_110', 'res_close').get('win_rate'),
             'roi_at_open': bet_stats(d).get('roi'), 'roi_at_close': bet_stats(d, 'units_close_110', 'res_close').get('roi')}
        # re-deciding the side at the CLOSE (the model vs the closing number)
        side_c = (d.pred - d.close_margin) > 0
        rc = grade(d.margin.values, d.close_margin.values, side_c.values)
        o['ats_model_vs_close_redecided'] = r4((rc[rc != 0] == 1).mean())
        out[w] = o
    # how many games would be predicted differently by a SUNDAY 12:00 UTC freeze?
    G = X[['game_id', 'season', 'kickoff_ts', 'prediction_ts']].copy()
    G['kickoff_ts'] = pd.to_datetime(G.kickoff_ts, utc=True)
    wd = G.kickoff_ts.dt.weekday
    hr = G.kickoff_ts.dt.hour
    between = ((wd == 6) & (hr >= 12)) | (wd == 0) | ((wd == 1) & (hr < 12))
    out['sunday_freeze_feasibility'] = {
        'share_of_games_kicking_off_sun_12utc_to_tue_12utc': r4(between.mean()),
        'meaning': 'only these games are known to a Tuesday freeze but not to a Sunday-noon freeze; every other input is identical',
        'intraday_line_history': 'NONE in the archive (open and close only). Timestamped capture starts with the 2026 shadow run.'}
    return out


# ============================================================ PHASE 17
REF_ID = -1


def synthetic_team_ratings(S, fitted, weights, comps, out_root):
    """R(t, T): the ensemble's neutral-site margin for team t against a
    league-average reference team, at every freeze T of season S, built with the
    production snapshot code (snapshots.build_season) and the season-S models."""
    from . import snapshots as SN
    from . import elo as EL
    old_out = C.OUT
    C.OUT = out_root
    try:
        W = SN.wide_ratings(S)
        G = pd.read_parquet(os.path.join(out_root, 'stage2', 'games.parquet'))
        gs = G[G.season.eq(S)]
        fbs = set(gs.loc[gs.home_fbs, 'home_id']) | set(gs.loc[gs.away_fbs, 'away_id'])
        pts = sorted(gs.prediction_ts.unique())
        # reference team: 0 offsets (league average), typical uncertainty and sample size
        refs = []
        for T in pts:
            w = W.loc[pd.Timestamp(T)]
            w = w[w.index.isin(fbs)]
            r = pd.Series(0.0, index=W.columns)
            for c in W.columns:
                if c.endswith(('__off_var', '__def_var', '__vol', '__n_obs_off', '__n_eff_off')):
                    r[c] = float(w[c].median())
            r.name = (pd.Timestamp(T), REF_ID)
            refs.append(r)
        Wa = pd.concat([W, pd.DataFrame(refs).set_index(pd.MultiIndex.from_tuples([x.name for x in refs],
                                                                                     names=W.index.names))])
        qb = pd.read_parquet(os.path.join(out_root, 'stage4', 'qb_team.parquet'))
        q = qb[qb.season.eq(S)]
        qref = []
        for T, g in q[q.team_id.isin(fbs)].groupby('prediction_ts'):
            m = g.drop(columns=['team_id', 'prediction_ts', 'season']).mean(numeric_only=True)
            m['qb_delta'] = 0.0; m['qb_changed'] = 0.0; m['qb_unsettled'] = 0.0
            m['team_id'] = REF_ID; m['prediction_ts'] = T; m['season'] = S
            qref.append(m)
        qa = pd.concat([q, pd.DataFrame(qref)], ignore_index=True)
        snaps, fbs_season = EL.run_elo(G[G.season <= S])
        rows, erows = [], []
        gid = -10_000_000
        for T in pts:
            T = pd.Timestamp(T)
            e = snaps.get(T, {})
            fe = [v for k, v in e.items() if k in fbs]
            emean = float(np.mean(fe)) if fe else 1500.0
            for t in sorted(fbs):
                gid -= 1
                rows.append({'game_id': gid, 'season': S, 'week': np.nan, 'season_type': 'regular',
                             'start_date': T + pd.Timedelta(days=4), 'kickoff_ts': T + pd.Timedelta(days=4),
                             'prediction_ts': T, 'home_id': t, 'away_id': REF_ID, 'neutral_site': True,
                             'conference_game': False, 'is_postseason': False, 'status': 'SCHEDULED',
                             'home_fbs': True, 'away_fbs': True, 'fcs_game': False, 'home_points': np.nan,
                             'away_points': np.nan, 'margin': np.nan, 'total_pts': np.nan,
                             'rest_diff': 0.0, 'travel_miles': np.nan, 'tz_shift': 0.0, 'altitude_diff_ft': 0.0,
                             'home_conference': None, 'away_conference': None})
                eh = e.get(t, 1500.0)
                erows.append((gid, eh, emean, eh - emean))
        Gs = pd.DataFrame(rows)
        elo = pd.DataFrame(erows, columns=['game_id', 'elo_home', 'elo_away', 'elo_diff'])
        orig = SN.wide_ratings
        SN.wide_ratings = lambda _S: Wa
        try:
            Xs = SN.build_season(S, Gs, qa, elo)
        finally:
            SN.wide_ratings = orig
    finally:
        C.OUT = old_out
    Xs = MD.add_derived(Xs)
    w = weights.get(S) or {}
    pred = np.zeros(len(Xs))
    for k in comps:
        pred += w.get(k, 0.0) * fitted[k].predict(Xs)
    pred += w.get('intercept', 0.0)
    return pd.DataFrame({'team_id': Xs.home_id.values, 'prediction_ts': Xs.prediction_ts.values, 'R': pred,
                         'elo_R': fitted['B_elo'].predict(Xs)})


def phase17_learning(X, fam, out_root, seasons=None):
    seasons = seasons or list(range(2016, 2026))
    r = RT.run(X, RT.Spec(fam['C'], fam['D']), keep_models=True, probs=False)
    Rs = []
    for S in seasons:
        fitted, _ = r['models'][S]
        Rs.append(synthetic_team_ratings(S, fitted, r['weights'], RT.COMPONENTS, out_root).assign(season=S))
    R = pd.concat(Rs)
    R['prediction_ts'] = pd.to_datetime(R.prediction_ts, utc=True)
    P = postgame_table(out_root)
    G = pd.read_parquet(os.path.join(out_root, 'stage2', 'games.parquet'))
    G = G[G.season.isin(seasons) & G.status.eq('FINAL') & ~G.fcs_game]
    D = r['D'].set_index('game_id')
    rows = []
    for side, sgn in (('home', 1.0), ('away', -1.0)):
        g = G[['game_id', 'season', 'kickoff_ts', 'prediction_ts', side + '_id', 'margin']].rename(columns={side + '_id': 'team_id'})
        g['team_margin'] = sgn * g.margin
        g['team_pred'] = sgn * g.game_id.map(D.pred)
        pg = P.set_index('game_id')
        g['to_m'] = sgn * g.game_id.map(pg.to_margin)
        g['sr_m'] = sgn * g.game_id.map(pg.sr_margin)
        g['st_m'] = sgn * g.game_id.map(pg.st_net)
        rows.append(g)
    L = pd.concat(rows)
    L['prediction_ts'] = pd.to_datetime(L.prediction_ts, utc=True)
    Ri = R.set_index(['team_id', 'prediction_ts'])
    # the next freeze after the game
    nxt = {}
    for S, gS in R.groupby('season'):
        ts = sorted(gS.prediction_ts.unique())
        for a, b in zip(ts[:-1], ts[1:]):
            nxt[a] = b
    L['T1'] = L.prediction_ts.map(nxt)
    L = L.dropna(subset=['T1', 'team_pred'])
    # one game between the two freezes only
    L = L[L.kickoff_ts < L.T1]
    cnt = L.groupby(['team_id', 'prediction_ts']).size()
    L = L[[cnt.get((a, b), 0) == 1 for a, b in zip(L.team_id, L.prediction_ts)]]
    L['R0'] = [Ri.R.get((a, b), np.nan) for a, b in zip(L.team_id, L.prediction_ts)]
    L['R1'] = [Ri.R.get((a, b), np.nan) for a, b in zip(L.team_id, L.T1)]
    L['E0'] = [Ri.elo_R.get((a, b), np.nan) for a, b in zip(L.team_id, L.prediction_ts)]
    L['E1'] = [Ri.elo_R.get((a, b), np.nan) for a, b in zip(L.team_id, L.T1)]
    L = L.dropna(subset=['R0', 'R1'])
    L['dR'] = L.R1 - L.R0
    L['dE'] = L.E1 - L.E0
    L['surprise'] = L.team_margin - L.team_pred
    cls = {
        'A sustainable: beat expectation by 14+, success margin >= +4, turnover margin <= +1':
            (L.surprise >= 14) & (L.sr_m >= 4) & (L.to_m <= 1),
        'B luck: beat expectation by 14+, turnover margin >= +3 or ST >= +7, success margin <= 0':
            (L.surprise >= 14) & ((L.to_m >= 3) | (L.st_m >= 7)) & (L.sr_m <= 0),
        'C lost, but won the success battle (success margin >= +3)': (L.team_margin < 0) & (L.sr_m >= 3),
        'D lost and lost the success battle (success margin <= -3)': (L.team_margin < 0) & (L.sr_m <= -3),
        'E won, but lost the success battle (success margin <= -3)': (L.team_margin > 0) & (L.sr_m <= -3),
    }
    # the NEXT game's residual (team-oriented): if a class's rating move was an
    # over- or under-reaction, the next game says so
    allg = pd.concat(rows).sort_values('kickoff_ts')
    allg['resid'] = allg.team_margin - allg.team_pred
    allg['next_resid'] = allg.groupby(['team_id', 'season']).resid.shift(-1)
    nr = allg.set_index(['game_id', 'team_id']).next_resid
    L['next_resid'] = [nr.get((g, t), np.nan) for g, t in zip(L.game_id, L.team_id)]
    out = {'n_team_games': int(len(L)), 'classes': {}}
    for k, m in cls.items():
        d = L[m]
        out['classes'][k] = {'n': int(len(d)), 'mean_surprise': r4(d.surprise.mean()),
                             'next_game_residual': r4(d.next_resid.mean()),
                             'next_game_residual_ci': [r4(v) for v in boot(d.next_resid.dropna().values)],
                             'ensemble_rating_change': r4(d.dR.mean()), 'ci': [r4(v) for v in boot(d.dR.values)],
                             'per_point_of_surprise': r4((d.dR / d.surprise).median()) if len(d) else None,
                             'scoreboard_elo_rating_change': r4(d.dE.mean())}
    a, b = L[list(cls.values())[0]], L[list(cls.values())[1]]
    # A vs B at equal surprise: regress dR on surprise + luck indicator
    ab = pd.concat([a.assign(luck=0.0), b.assign(luck=1.0)])
    A_ = np.column_stack([np.ones(len(ab)), ab.surprise, ab.luck])
    coef = np.linalg.lstsq(A_, ab.dR.values, rcond=None)[0]
    rng = np.random.default_rng(C.SEED)
    bs = []
    for _ in range(BOOT):
        i = rng.integers(0, len(ab), len(ab))
        bs.append(np.linalg.lstsq(A_[i], ab.dR.values[i], rcond=None)[0][2])
    out['A_vs_B_luck_effect_at_equal_surprise'] = {'coef_luck': r4(coef[2]), 'ci': [r4(np.percentile(bs, 2.5)), r4(np.percentile(bs, 97.5))],
                                                   'meaning': 'negative = the model moves LESS for a turnover/ST-driven surprise than for a sustainable one'}
    c_, d_ = L[list(cls.values())[2]], L[list(cls.values())[3]]
    out['C_minus_D'] = {'diff': r4(c_.dR.mean() - d_.dR.mean()),
                        'ci': [r4(v) for v in _boot_diff(c_.dR.values, d_.dR.values)]}
    out['tests'] = {
        'sustainable surprise moves the rating more than luck (A > B at equal surprise)': bool(out['A_vs_B_luck_effect_at_equal_surprise']['ci'][1] < 0),
        'a loss that won the success battle is not punished like one that lost it (C > D)': bool(out['C_minus_D']['ci'][0] > 0),
        'a loss that won the success battle is not a downgrade on average (C >= -0.25)': bool(out['classes'][list(cls)[2]]['ensemble_rating_change'] >= -0.25),
        'no class is systematically mis-rated in its next game (every next-game residual CI covers 0)': bool(all(
            (v['next_game_residual_ci'][0] or 0) <= 0 <= (v['next_game_residual_ci'][1] or 0) for v in out['classes'].values())),
    }
    # examples
    ex = []
    for k, m in list(cls.items())[:3]:
        d = L[m].sort_values('surprise', ascending=False).head(4)
        for _, x in d.iterrows():
            ex.append({'class': k[:1], 'game_id': int(x.game_id), 'team_id': int(x.team_id), 'season': int(x.season),
                       'team_margin': r4(x.team_margin), 'surprise': r4(x.surprise), 'to_margin': r4(x.to_m),
                       'success_margin': r4(x.sr_m), 'st_net': r4(x.st_m), 'rating_change': r4(x.dR),
                       'elo_change': r4(x.dE)})
    out['examples'] = ex
    return out


def _boot_diff(a, b):
    rng = np.random.default_rng(C.SEED)
    v = [rng.choice(a, len(a)).mean() - rng.choice(b, len(b)).mean() for _ in range(BOOT)]
    return [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]


# ============================================================ PHASE 18
def phase18_early(D, X, out_root, variants_root, fam, spec=None, comps=None, method='sum_to_one_nonneg'):
    """`spec`/`comps`/`method` are the configuration under test, so the
    no-preseason-information variant is the same model without priors."""
    spec = spec or RT.Spec(fam['C'], fam['D'])
    out = {}
    wk = pd.cut(D.weeks_in, [-1, 1, 2, 3, 4, 5, 7, 10, 30], labels=['0-1', '1-2', '2-3', '3-4', '4-5', '5-7', '7-10', '10+']).astype(str)
    D = D.assign(wk=wk)
    # noprior variant (flat preseason information) for the same games
    npv = os.path.join(variants_root, 'out_noprior')
    fx = os.path.join(variants_root, 'out_fix')
    if os.path.exists(os.path.join(npv, 'stage5', 'cfb_model_training_snapshots.parquet')):
        Xn, _ = load(npv)
        Dn = RT.run(Xn, spec, comps=comps, method=method, probs=False)['D'][['game_id', 'pred']].rename(columns={'pred': 'pred_noprior'})
        Xf, _ = load(fx)
        Df = RT.run(Xf, spec, comps=comps, method=method, probs=False)['D'][['game_id', 'pred']].rename(columns={'pred': 'pred_fix'})
        D = D.merge(Dn, on='game_id', how='left').merge(Df, on='game_id', how='left')
    for w in ('dev', 'holdout'):
        d = fbs_fin(D, WIN[w])
        tab = {}
        for k, g in d.groupby('wk'):
            gg = g.dropna(subset=['open_margin'])
            r = {'n': int(len(g)), 'mae_v2': r4((g.pred - g.margin).abs().mean()),
                 'mae_open_same': r4((gg.open_margin - gg.margin).abs().mean()),
                 'mae_v2_same': r4((gg.pred - gg.margin).abs().mean()),
                 'mae_v1': r4((g.base_v1 - g.margin).abs().mean()) if g.base_v1.notna().any() else None}
            if 'pred_noprior' in g:
                gp = g.dropna(subset=['pred_noprior', 'pred_fix'])
                r['mae_no_preseason_info'] = r4((gp.pred_noprior - gp.margin).abs().mean())
                r['mae_with_priors_same_code'] = r4((gp.pred_fix - gp.margin).abs().mean())
                r['value_of_priors'] = r4(r['mae_no_preseason_info'] - r['mae_with_priors_same_code'])
            tab[k] = r
        out['mae_by_week_' + w] = tab
    # does a prior component still carry information the model under-uses, by week?
    tt = pd.concat([pd.read_parquet(os.path.join(C.DATA, 'talent', f)) for f in os.listdir(os.path.join(C.DATA, 'talent'))])
    tt['team_id'] = pd.to_numeric(tt.team_id, errors='coerce')
    tt = tt.dropna(subset=['team_id']).drop_duplicates(['season', 'team_id'])
    tt['tz'] = tt.groupby('season').talent_composite.transform(lambda x: (x - x.mean()) / x.std())
    TZ = tt.set_index(['season', 'team_id']).tz
    rp = pd.concat([pd.read_parquet(os.path.join(C.DATA, 'retprod', f)) for f in os.listdir(os.path.join(C.DATA, 'retprod'))])
    rp['team_id'] = pd.to_numeric(rp.team_id, errors='coerce')
    rp = rp.dropna(subset=['team_id']).drop_duplicates(['season', 'team_id'])
    RP = rp.set_index(['season', 'team_id'])[['off_returning', 'def_returning']].mean(axis=1)
    fd = pd.read_parquet(os.path.join(out_root, 'stage3', 'final_dataonly.parquet'))
    fd = fd[fd.metric.eq('epa')]
    FD = (fd.set_index(['season', 'team_id']).off - fd.set_index(['season', 'team_id'])['def'])
    d = fbs_fin(D, WIN['dev'] + WIN['holdout']).copy()
    d['talent_diff'] = [TZ.get((s, h), np.nan) - TZ.get((s, a), np.nan) for s, h, a in zip(d.season, d.home_id, d.away_id)]
    d['retprod_diff'] = [RP.get((s, h), np.nan) - RP.get((s, a), np.nan) for s, h, a in zip(d.season, d.home_id, d.away_id)]
    d['last_season_diff'] = [FD.get((s - 1, h), np.nan) - FD.get((s - 1, a), np.nan) for s, h, a in zip(d.season, d.home_id, d.away_id)]
    d = d.merge(X[['game_id', 'edge_prior_epa']], on='game_id', how='left')
    d['resid'] = d.margin - d.pred
    comp = {}
    for c in ('talent_diff', 'retprod_diff', 'last_season_diff', 'edge_prior_epa'):
        comp[c] = {}
        for k, g in d.dropna(subset=[c]).groupby('wk'):
            if len(g) < 150:
                continue
            z = (g[c] - g[c].mean()) / g[c].std()
            b = float(np.sum(z * g.resid) / np.sum(z * z))
            rng = np.random.default_rng(C.SEED)
            bs = []
            for _ in range(300):
                i = rng.integers(0, len(g), len(g))
                zz, rr = z.values[i], g.resid.values[i]
                bs.append(np.sum(zz * rr) / np.sum(zz * zz))
            comp[c][k] = {'n': int(len(g)), 'pts_per_sd_in_residual': r4(b),
                          'ci': [r4(np.percentile(bs, 2.5)), r4(np.percentile(bs, 97.5))]}
    out['prior_component_residual_slopes_dev_and_holdout'] = comp
    out['note'] = ('A positive slope at week k means the model UNDER-uses that prior component at week k '
                   '(the prior still predicts what the model missed); negative means it over-uses it. '
                   'The per-metric prior strengths (RATING_PRIOR_SCALE) already let each metric fade at its own rate.')
    return out


# ============================================================ PHASE 19
def qb_ratings_at_games(out_root, k=150.0, repl=-0.057, decay=0.6):
    """A simple, unadjusted career EPA/dropback rating for EVERY passer before
    every game (evaluation only): season-decayed, shrunk to replacement."""
    Q = pd.concat([pd.read_parquet(os.path.join(out_root, 'stage1', f))
                   for f in sorted(os.listdir(os.path.join(out_root, 'stage1'))) if f.startswith('qb_game_')])
    G = pd.read_parquet(os.path.join(out_root, 'stage2', 'games.parquet'))[['game_id', 'kickoff_ts', 'season']]
    Q = Q.merge(G.rename(columns={'season': 'g_season'}), on='game_id', how='inner').sort_values('kickoff_ts')
    Q = Q[Q.db_ng > 0]
    rating, career_db, prior_team = {}, {}, {}
    num, den = {}, {}
    out = {}
    cur_season = None
    for r in Q.itertuples(index=False):
        if r.g_season != cur_season:
            for q in num:
                num[q] *= decay; den[q] *= decay
            cur_season = r.g_season
        key = (r.game_id, r.qb_id)
        n0, d0 = num.get(r.qb_id, 0.0), den.get(r.qb_id, 0.0)
        out[key] = ((n0 + k * repl) / (d0 + k), career_db.get(r.qb_id, 0.0), prior_team.get(r.qb_id))
        num[r.qb_id] = n0 + r.epa_db_sum
        den[r.qb_id] = d0 + r.db_ng
        career_db[r.qb_id] = career_db.get(r.qb_id, 0.0) + r.db
        prior_team[r.qb_id] = r.team_id
    return out, Q


def phase19_qb(D, X, out_root, beta_qb=None):
    art = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'artifacts',
                                      C.MODEL_VERSION, 'models.json')))
    params = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'params.js')).read()
    import re
    m = re.search(r'"points_per_epa_db":\s*([-0-9.e]+)', params)
    beta = float(m.group(1)) if m else 7.74
    ratings, Q = qb_ratings_at_games(out_root)
    st = Q[Q.starter].drop_duplicates(['game_id', 'team_id']).set_index(['game_id', 'team_id']).qb_id
    starts_season = Q[Q.starter][['game_id', 'team_id', 'qb_id', 'kickoff_ts', 'g_season']]
    J = D.merge(X[['game_id', 'h_qb_id', 'a_qb_id', 'qb_delta_edge', 'qb_exp_edge', 'h_qb_changed', 'a_qb_changed']],
                on='game_id', how='left')
    rows = []
    for side, sgn in (('h', 1.0), ('a', -1.0)):
        tid = J['home_id' if side == 'h' else 'away_id']
        for i, (g, t, exp_q, S) in enumerate(zip(J.game_id, tid, J[side + '_qb_id'], J.season)):
            act = st.get((g, t))
            if act is None or pd.isna(act):
                continue
            ra, cdb, pteam = ratings.get((g, act), (np.nan, np.nan, None))
            re_ = ratings.get((g, exp_q), (np.nan, np.nan, None))[0] if pd.notna(exp_q) else np.nan
            if pd.isna(exp_q):
                typ = ('week 1: first-time starter (no career dropbacks)' if cdb == 0 else
                       'week 1: transfer / new team starter' if pteam is not None and pteam != t else
                       'week 1: returning starter')
            elif int(exp_q) == int(act):
                typ = 'same starter as last game'
            else:
                earlier = starts_season[(starts_season.team_id == t) & (starts_season.g_season == S)
                                        & (starts_season.qb_id == act) & (starts_season.game_id != g)]
                typ = ('backup -> starter return (started earlier this season)' if len(earlier) and
                       earlier.kickoff_ts.min() < Q.loc[Q.game_id.eq(g), 'kickoff_ts'].iloc[0] else
                       'starter -> backup / new starter (first-time starter)' if cdb == 0 else
                       'starter -> backup / new starter')
            rows.append({'game_id': g, 'season': S, 'side': side, 'type': typ,
                         'resid_team': sgn * (J.margin.iat[i] - J.pred.iat[i]),
                         'd_rating': (ra - re_) if pd.notna(re_) else np.nan,
                         'fcs': bool(J.fcs_game.iat[i]), 'final': J.status.iat[i] == 'FINAL',
                         'inside80': bool(J.lo_80.iat[i] <= J.margin.iat[i] <= J.hi_80.iat[i]) if pd.notna(J.lo_80.iat[i]) else None})
    T = pd.DataFrame(rows)
    T = T[T.final & ~T.fcs & T.season.isin(WIN['dev'] + WIN['holdout'])]
    out = {'coefficient_shipped_pts_per_epa_db': r4(beta), 'types': {}}
    for k, g in T.groupby('type'):
        out['types'][k] = {'n': int(len(g)), 'mean_team_residual': r4(g.resid_team.mean()),
                           'ci': [r4(v) for v in boot(g.resid_team.values)],
                           'coverage80': r4(pd.Series(g.inside80).dropna().mean()),
                           'mean_rating_change_vs_expected': r4(g.d_rating.mean()),
                           'overlay_would_predict_pts': r4(beta * g.d_rating.mean()) if g.d_rating.notna().any() else None}
    ch = T[T.type.str.startswith(('starter ->', 'backup ->'))].dropna(subset=['d_rating'])
    if len(ch) > 50:
        x, y = ch.d_rating.values, ch.resid_team.values
        b = float(np.sum(x * y) / np.sum(x * x))
        rng = np.random.default_rng(C.SEED)
        bs = []
        for _ in range(BOOT):
            i = rng.integers(0, len(x), len(x))
            bs.append(np.sum(x[i] * y[i]) / np.sum(x[i] * x[i]))
        out['surprise_change_slope'] = {'n': int(len(ch)), 'pts_per_epa_db': r4(b),
                                        'ci': [r4(np.percentile(bs, 2.5)), r4(np.percentile(bs, 97.5))],
                                        'meaning': 'realised team residual per EPA/dropback of starter change the snapshot did not know'}
    # double counting: does the ensemble leave QB signal in its residual?
    d = fbs_fin(J, WIN['dev'] + WIN['holdout'])
    dc = {}
    for c in ('qb_delta_edge', 'qb_exp_edge'):
        g = d.dropna(subset=[c])
        g = g[g[c].abs() > 1e-9]
        x, y = g[c].values, (g.margin - g.pred).values
        b = float(np.sum(x * y) / np.sum(x * x))
        se = float(np.sqrt(np.sum((y - b * x) ** 2) / (len(x) - 1) / np.sum(x * x)))
        dc[c] = {'n': int(len(g)), 'residual_slope': r4(b), 't': r4(b / se)}
    out['double_counting_check_residual_on_qb_features'] = dc
    out['note'] = ('Week-1 QB features are MISSING by construction (no current-season game), so returning production '
                   '(prior) and the QB model never both describe the same QB in week 1. From week 2 the QB feature is '
                   'qb_delta = expected starter minus the passers whose snaps built the offence ratings: only the part '
                   'the team ratings have not absorbed.')
    return out


# ============================================================ NEXT ITERATION (exploratory)
def next_iteration_candidates(X, fam, drop_cols, comps=('C_ridge', 'D_gbm'), method='mean'):
    """EXPLORATORY, DEV ONLY, NOT ADOPTED (the brief: no new features yet).
    Sizes the two structural fixes the red team points at, against the hardened
    architecture, so the next iteration starts from evidence:
      prior_fade  edge_prior_* x exp(-weeks/3): lets the prior weigh MORE early
                  and LESS mid-season (phase 18 found the opposite misfit)
      p4_tier     P4(home) - P4(away), season-aware (phase 12: the P4 side of
                  P4-vs-G5 games is underrated by ~2.6 pts, dev and holdout)"""
    X = X.copy()
    w = np.exp(-X.weeks_in.clip(lower=0) / 3.0)
    pf = []
    for m in ('epa', 'epa_pass', 'epa_rush', 'sr', 'ppd'):
        c = 'pf_' + m
        X[c] = X['edge_prior_' + m] * w
        pf.append(c)
    X['p4_tier'] = is_p4(X.home_conference.fillna(''), X.season).astype(float) - \
        is_p4(X.away_conference.fillna(''), X.season).astype(float)
    base_spec = RT.Spec(fam['C'], fam['D'], drop=drop_cols)
    b = RT.run(X, base_spec, comps=list(comps), method=method, probs=False)['D']
    out = {'status': 'EXPLORATORY: development window only, not adopted', 'candidates': {}}
    import copy
    for name, extra in (('prior_fade', pf), ('p4_tier', ['p4_tier']), ('both', pf + ['p4_tier'])):
        sp = copy.deepcopy(base_spec)
        orig = sp.cols

        def cols(which, _o=orig, _e=extra):
            c = _o(which)
            return c + _e if which in ('C', 'D') else c
        sp.cols = cols
        r = RT.run(X, sp, comps=list(comps), method=method, probs=False)['D']
        j = b[['game_id', 'season', 'status', 'fcs_game', 'margin', 'pred', 'home_conference', 'away_conference', 'weeks_in']].merge(
            r[['game_id', 'pred']], on='game_id', suffixes=('_b', '_a'))
        d = fbs_fin(j, WIN['dev']).dropna(subset=['pred_a', 'pred_b'])
        diff = (d.pred_a - d.margin).abs() - (d.pred_b - d.margin).abs()
        res = {'dev_d_mae': r4(diff.mean()), 'ci': [r4(v) for v in boot(diff.values)], 'n': int(len(d))}
        early = d.weeks_in < 3
        res['dev_d_mae_weeks_0_2'] = r4(diff[early].mean())
        hp, ap = is_p4(d.home_conference.fillna(''), d.season), is_p4(d.away_conference.fillna(''), d.season)
        res['dev_d_mae_p4_vs_g5'] = r4(diff[hp ^ ap].mean())
        out['candidates'][name] = res
    return out


# ------------------------------------------------------------------- main
def dump(name, obj):
    os.makedirs(REPORT_DIR, exist_ok=True)
    with open(os.path.join(REPORT_DIR, name + '.json'), 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=lambda o: r4(o) if isinstance(o, (np.floating, float)) else (int(o) if isinstance(o, np.integer) else str(o)))
        f.write('\n')


def main():
    global REPORT_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-snap', default=C.OUT)
    ap.add_argument('--phases', default='5,6')
    ap.add_argument('--config', default='candidate_001', choices=['candidate_001', 'hardened'],
                    help='hardened: the architecture of report/redteam/hardening_decisions.json; results go to '
                         'report/redteam/hardened/')
    ap.add_argument('--variants-root', default=os.path.join(os.path.dirname(REPORT_DIR), '..'))
    a = ap.parse_args()
    ph = set(int(x) for x in a.phases.split(','))
    t0 = time.time()
    X, MK = load(a.out_snap)
    fam = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'report', 'selected_families.json')))
    if a.config == 'hardened':
        hd = json.load(open(os.path.join(REPORT_DIR, 'hardening_decisions.json')))
        REPORT_DIR = os.path.join(REPORT_DIR, 'hardened')
        base = RT.run(X, RT.Spec(fam['C'], fam['D'], drop=hd['R4_joint_check']['final_removed_columns'],
                                 name='hardened'),
                      comps=hd['R2_components']['keep'], method=hd['R3_combination']['chosen'])
    else:
        base = RT.run(X, RT.Spec(fam['C'], fam['D']), keep_models=False)
    D = attach_market(base['D'], MK)
    base['D'] = D
    if 4 in ph and a.config == 'candidate_001':
        dump('phase04_reproduction', phase4_reproduction(D))
        print('[rt] phase 4 %.0fs' % (time.time() - t0))
    if 5 in ph:
        dump('phase05_components', phase5_components(D))
        print('[rt] phase 5 %.0fs' % (time.time() - t0))
    if 6 in ph:
        dump('phase06_ensembles', phase6_ensembles(X, base))
        print('[rt] phase 6 %.0fs' % (time.time() - t0))
    if 9 in ph or 10 in ph:
        cal, D = phase9_calibration(D)
        base['D'] = D
        dump('phase09_calibration', cal)
        dump('phase10_uncertainty', phase10_uncertainty(D))
        print('[rt] phase 9-10 %.0fs' % (time.time() - t0))
    if ph & {13, 14, 15, 16}:
        if 'pc_platt' not in D:
            _, D = phase9_calibration(D)
        pr = closing_prices()
        D = D.merge(pr, on='game_id', how='left')
        m13, B = phase13_market(D)
        dump('phase13_market', m13)
        m14, rule = phase14_thresholds(B)
        dump('phase14_thresholds', m14)
        dump('phase15_bankroll', phase15_bankroll(B, rule))
        dump('phase16_edge_decay', phase16_decay(B, X))
        print('[rt] phase 13-16 %.0fs' % (time.time() - t0))
    root = a.out_snap if os.path.exists(os.path.join(a.out_snap, 'stage1')) else C.OUT
    if 17 in ph:
        dump('phase17_learning', phase17_learning(X, fam, root))
        print('[rt] phase 17 %.0fs' % (time.time() - t0))
    if 18 in ph:
        dump('phase18_early_season', phase18_early(D, X, root, a.variants_root, fam, spec=base['spec'],
                                                   comps=base['comps'], method=base['method']))
        print('[rt] phase 18 %.0fs' % (time.time() - t0))
    if 19 in ph:
        dump('phase19_qb', phase19_qb(D, X, root))
        print('[rt] phase 19 %.0fs' % (time.time() - t0))
    if 11 in ph:
        dump('phase11_misses', phase11_misses(D, X, a.out_snap if os.path.exists(os.path.join(a.out_snap, 'stage1')) else C.OUT))
        print('[rt] phase 11 %.0fs' % (time.time() - t0))
    if 12 in ph:
        dump('phase12_residuals', phase12_residuals(D, X, a.out_snap if os.path.exists(os.path.join(a.out_snap, 'stage1')) else C.OUT))
        print('[rt] phase 12 %.0fs' % (time.time() - t0))
    if 7 in ph:
        dump('phase07_ablation', phase7_ablation(X, MK, fam, D, a.variants_root))
        print('[rt] phase 7 %.0fs' % (time.time() - t0))
    if 8 in ph:
        dump('phase08_overfit', phase8_overfit(X, MK, fam, base))
        print('[rt] phase 8 %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
