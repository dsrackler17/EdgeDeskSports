"""The matchup backtest (docs/cfb-matchup/BACKTEST.md).

    python3 -m v2.matchup.backtest --features     build + cache features (style must be built)
    python3 -m v2.matchup.backtest --dev          every development-window experiment (2016-2023)
    python3 -m v2.matchup.backtest --freeze       freeze the artifact from the dev decision
    python3 -m v2.matchup.backtest --holdout      score 2024-2025 ONCE with the frozen artifact
    python3 -m v2.matchup.backtest --live         2026 games played so far (frozen artifact)

GENERAL MODEL = V2.1 (edgedesk_cfb_v2.1.0) walk-forward predictions, read unchanged from
$CFB_V2_OUT/stage7/backtest_predictions.parquet (the identity V2.1 p_home_raw == 1 - F_t(-ens/sigma)
is checked on every row). GENERAL + MATCHUP = ens_pred + walk-forward matchup correction, with
V2.1's sigma and t degrees of freedom (the variance model is reported separately).

The validation rule is PRE-REGISTERED (PREREG below, written before any family was scored) and
applied on development seasons only. The holdout is scored once, after the artifact is frozen.
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from . import interactions as IX
from . import similar as SM
from . import style as ST
from . import residual as RS
from . import changes as CH
from . import (RESIDUAL_MODEL_VERSION, MATCHUP_FEATURE_VERSION, STYLE_VERSION, SIMILARITY_VERSION,
               CLUSTER_VERSION, PLAYSEL_VERSION, BASE_MODEL_VERSION)

DEV = list(C.DEV_SEASONS)
HOLDOUT = list(C.HOLDOUT_SEASONS)
N_BOOT = 2000
P4 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}
NOTRE_DAME = 87

PREREG = {
    'written': 'before any matchup family was scored (this constant is part of the first commit of the module)',
    'unit': 'a feature FAMILY (interactions.FAMILIES, similar.FAMILY), fitted alone as a walk-forward ridge '
            'correction to V2.1 (seasons 2014..S-1 -> S), shrunk by lambda_S and capped',
    'validate_if_all': ['dev (2016-2023) paired delta MAE < 0 with its 95% bootstrap CI upper bound < 0',
                        'delta MAE < 0 in >= 5 of the 8 dev seasons',
                        'delta RMSE <= 0 (point estimate)'],
    'production': 'only VALIDATED families enter the combined correction; if none validates the artifact is '
                  'NO_ADJUSTMENT (correction identically 0)',
    'combined_check': 'the combined model of validated families must itself pass the same three conditions',
    'holdout': '2024-2025 scored once with the frozen artifact; reported separately; never used to choose',
    'narratives': 'a narrative is SUPPORTED only if its single feature validates by the same rule AND its pooled '
                  'dev coefficient has the sign the narrative predicts with a 95% CI excluding zero',
}


def mdir(*p):
    return common.out_path('matchup', *p)


# ================================================================== load
def load():
    rep = json.load(open(common.out_path('report', 'backtest.json')))
    if rep.get('model_version') != C.PRODUCTION_MODEL_VERSION or rep.get('feature_version') != C.FEATURE_VERSION:
        raise AssertionError('CFB_V2_OUT is not the V2.1 build: %s %s' % (rep.get('model_version'), rep.get('feature_version')))
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    return M, RS.t_dfs()


def identity_check(D, dfs):
    """V2.1's stored p_home_raw is exactly 1 - F_t(-ens_pred / sigma; df_S): the base is untouched."""
    mx = 0.0
    for S, g in D[D.sigma.notna()].groupby('season'):
        p = RS.win_prob(g.ens_pred.values, g.sigma.values, dfs[S])
        mx = max(mx, float(np.nanmax(np.abs(p - g.p_home_raw.values))))
    return mx


def build_features(M, sim_cfg=None, refresh=False):
    f = mdir('features.parquet')
    if os.path.exists(f) and not refresh:
        return pd.read_parquet(f)
    F, Sty = IX.build(M)
    cfg = sim_cfg or load_sim_choice()
    SF = SM.build(M, metric=cfg['metric'], h=cfg['h'])
    F = pd.concat([M[['game_id', 'season']], F], axis=1)
    F = F.merge(SF.drop(columns=['metric', 'h', 'similarity_version']), on='game_id', how='left')
    F.to_parquet(f, index=False)
    return F


def load_sim_choice():
    f = mdir('similarity_choice.json')
    return json.load(open(f))['chosen'] if os.path.exists(f) else dict(SM.DEFAULT)


def frame(M, F):
    D = RS.base_frame(M)
    cols = [c for c in F.columns if c not in ('game_id', 'season')]
    D = D.join(F.set_index(M.index)[cols]) if len(F) == len(M) and (F.game_id.values == M.game_id.values).all() \
        else D.merge(F.drop(columns=['season']), on='game_id', how='left').set_index(D.index)
    D['ens_pred_x'] = M['ens_pred']
    return D


def families():
    fam = dict(IX.FAMILIES)
    fam.update(SM.FAMILY)
    return fam


# ============================================================== evaluation
def probs(D, pred, dfs):
    p = np.full(len(D), np.nan)
    for S in D.season.unique():
        if S not in dfs:
            continue
        m = (D.season.eq(S) & D.sigma.notna()).values
        p[m] = RS.win_prob(pred[m], D.sigma.values[m], dfs[S])
    return p


def score(D, adj, seasons, dfs, n_boot=N_BOOT, sigma_mult=None):
    """GENERAL vs GENERAL + MATCHUP on the in-scope rows of `seasons`."""
    m = (D.in_scope & D.season.isin(seasons) & adj.notna()).values
    d = D[m]
    a = adj[m].values
    new = d.base.values + a
    pb = d.p_home_raw.values if 'p_home_raw' in d else None
    pn = probs(d, new, dfs)
    res = RS.paired(d.margin.values, d.base.values, new, pb, pn, n_boot=n_boot)
    per = {}
    for S in seasons:
        k = (d.season == S).values
        if k.sum():
            per[int(S)] = float(np.mean(np.abs(new[k] - d.margin.values[k])) - np.mean(np.abs(d.base.values[k] - d.margin.values[k])))
    res['delta_mae_by_season'] = per
    res['seasons_improved'] = int(sum(v < 0 for v in per.values()))
    res['adj_abs_mean'] = float(np.mean(np.abs(a)))
    res['adj_abs_p95'] = float(np.quantile(np.abs(a), 0.95))
    res['adj_share_capped'] = float(np.mean(np.abs(a) >= RS.CAP - 1e-9))
    return res


def decide(res):
    ci = res.get('ci95', {}).get('mae', [np.nan, np.nan])
    ok = res['delta']['mae'] < 0 and ci[1] < 0 and res['seasons_improved'] >= 5 and res['delta']['rmse'] <= 0
    return 'VALIDATED' if ok else ('INCONCLUSIVE' if res['delta']['mae'] < 0 else 'REJECTED')


def run_family(D, cols, dfs, make=None, n_boot=N_BOOT, seasons=None):
    raw, adj, lam, models = RS.walk_forward(D, cols, make=make)
    res = score(D, adj, seasons or DEV, dfs, n_boot=n_boot)
    res['lambda_by_season'] = {int(k): v for k, v in lam.items()}
    res['status'] = decide(res)
    unshrunk = score(D, raw.clip(-RS.CAP, RS.CAP), seasons or DEV, dfs, n_boot=0)
    res['unshrunk_delta'] = unshrunk['delta']
    return res, adj, raw, models


# ============================================================ experiments
def similarity_choice(M, D0, dfs):
    """Dev-only choice of the similarity metric and bandwidth: the walk-forward ridge of the
    similar-opponent family with each configuration; lowest dev delta MAE wins (ties -> default)."""
    vec = {S: SM.team_vectors(S) for S in range(C.FIRST_SNAPSHOT_SEASON + 1, C.LIVE_SEASON + 1)}
    grid = [(m, 0.5) for m in SM.METRICS] + [('euclid', h) for h in SM.BANDWIDTHS if h != 0.5]
    rows = []
    for metric, h in grid:
        SF = SM.build(M[M.season.le(max(DEV))], metric=metric, h=h, vectors=vec)
        D = D0.merge(SF[['game_id'] + SM.FAMILY['similar_opp']], on='game_id', how='left').set_index(D0.index)
        res, *_ = run_family(D, SM.FAMILY['similar_opp'], dfs, n_boot=0)
        rows.append({'metric': metric, 'h': h, 'dev_delta_mae': res['delta']['mae'], 'status_rule_no_ci': res['status']})
        print('[similarity] %s h=%.2f dMAE %+.4f' % (metric, h, res['delta']['mae']), flush=True)
    best = min(rows, key=lambda r: (round(r['dev_delta_mae'], 4), r['metric'] != SM.DEFAULT['metric']))
    out = {'grid': rows, 'chosen': {'metric': best['metric'], 'h': best['h']},
           'rule': 'lowest dev delta MAE of the similar-opponent family (walk-forward ridge); dev seasons only'}
    common.write_json(mdir('similarity_choice.json'), out)
    return out, vec


def buckets(D, adj, seasons):
    m = D.in_scope & D.season.isin(seasons) & adj.notna()
    d, a = D[m], adj[m]
    edges = [0, 0.5, 1, 2, 3, np.inf]
    lab = ['<0.5', '0.5-1', '1-2', '2-3', '3+']
    b = pd.cut(a.abs(), edges, labels=lab, right=False)
    out = {}
    for k in lab:
        s = b.eq(k).values
        if not s.any():
            out[k] = {'n': 0}
            continue
        y, base, new = d.margin.values[s], d.base.values[s], d.base.values[s] + a.values[s]
        out[k] = {'n': int(s.sum()), 'mae_base': float(np.mean(np.abs(base - y))), 'mae_matchup': float(np.mean(np.abs(new - y))),
                  'improvement': float(np.mean(np.abs(base - y)) - np.mean(np.abs(new - y))),
                  'bias_base': float(np.mean(base - y)), 'bias_matchup': float(np.mean(new - y))}
    return out


def direction_test(D, adj, seasons, thr=0.5, n_boot=N_BOOT):
    """Did the residual move in the direction (and by the size) the correction predicted?"""
    m = D.in_scope & D.season.isin(seasons) & adj.notna()
    a, r = adj[m].values, D.resid[m].values
    big = np.abs(a) >= thr
    rng = np.random.default_rng(C.SEED)
    out = {'threshold': thr, 'n_all': int(len(a)), 'n_big': int(big.sum())}
    if big.sum() >= 20:
        agree = (np.sign(a[big]) == np.sign(r[big])).astype(float)
        bs = [agree[rng.integers(0, len(agree), len(agree))].mean() for _ in range(n_boot)]
        out['direction_agreement'] = float(agree.mean())
        out['direction_ci95'] = [float(x) for x in np.quantile(bs, [0.025, 0.975])]
    if np.sum(a * a) > 0:
        slope = float(np.sum(a * r) / np.sum(a * a))
        n = len(a)
        idx = rng.integers(0, n, (n_boot, n))
        sl = (a[idx] * r[idx]).sum(axis=1) / np.maximum((a[idx] ** 2).sum(axis=1), 1e-12)
        out['magnitude_slope'] = slope
        out['magnitude_slope_ci95'] = [float(x) for x in np.quantile(sl, [0.025, 0.975])]
        out['note'] = 'slope 1 = the residual moved by exactly the predicted amount; 0 = not at all'
    return out


def subgroups(D, adj, seasons, CT):
    m = D.in_scope & D.season.isin(seasons) & adj.notna()
    d, a = D[m].copy(), adj[m]
    d['new'] = d.base + a
    hp4 = d.home_conference.isin(P4) | d.home_id.eq(NOTRE_DAME)
    ap4 = d.away_conference.isin(P4) | d.away_id.eq(NOTRE_DAME)
    ct = CT.set_index(['season', 'team_id'])
    oc_h = ct.oc_cont.reindex(pd.MultiIndex.from_arrays([d.season, d.home_id])).values
    oc_a = ct.oc_cont.reindex(pd.MultiIndex.from_arrays([d.season, d.away_id])).values
    groups = {
        'early_season (weeks_in < 5)': d.weeks_in < 5, 'late_season (weeks_in >= 5)': d.weeks_in >= 5,
        'P4 vs P4': hp4 & ap4, 'G5 vs G5': ~hp4 & ~ap4, 'P4 vs G5': hp4 != ap4,
        'both OCs retained': (oc_h == 1) & (oc_a == 1), 'an OC changed': (oc_h == 0) | (oc_a == 0),
        'high |adjustment| (>= 1)': a.abs() >= 1, 'low |adjustment| (< 1)': a.abs() < 1,
        'postseason': d.is_postseason.astype(bool), 'close V2.1 line (|pred| < 7)': d.base.abs() < 7,
        'big favourite (|pred| >= 14)': d.base.abs() >= 14,
    }
    out = {}
    for k, s in groups.items():
        s = np.asarray(s, dtype=bool)
        if s.sum() < 30:
            continue
        y = d.margin.values[s]
        out[k] = {'n': int(s.sum()), 'mae_base': float(np.mean(np.abs(d.base.values[s] - y))),
                  'mae_matchup': float(np.mean(np.abs(d.new.values[s] - y))),
                  'delta': float(np.mean(np.abs(d.new.values[s] - y)) - np.mean(np.abs(d.base.values[s] - y)))}
    return out


def redundancy(D, cols):
    """How much of each new feature V2.1 already has: max |corr| with any V2.1 model input, the
    corr with ens_pred, and the out-of-sample partial correlation with the V2.1 residual (dev)."""
    from .. import models as MD
    fam = json.load(open(common.out_path('report', 'selected_families.json')))
    v2cols = sorted(set(MD.features_for(fam['C'])) | set(MD.features_for(fam['D'])))
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    Mx = MD.add_derived(M)
    m = (D.in_scope & D.season.isin(DEV)).values
    V = Mx.loc[D.index[m], [c for c in v2cols if c in Mx]].astype(float)
    V = V.fillna(V.mean())
    out = {}
    r = D.resid.values[m]
    for c in cols:
        x = D[c].values[m].astype(float)
        ok = np.isfinite(x)
        if ok.sum() < 100 or np.nanstd(x) == 0:
            continue
        xs = pd.Series(x[ok])
        cors = V[ok].apply(lambda v: np.corrcoef(v.values, xs.values)[0, 1] if np.std(v.values) > 0 else 0.0)
        top = cors.abs().sort_values(ascending=False)
        out[c] = {'max_abs_corr_v2_input': float(top.iloc[0]), 'most_correlated_v2_input': top.index[0],
                  'corr_ens_pred': float(np.corrcoef(x[ok], D.base.values[m][ok])[0, 1]),
                  'corr_resid': float(np.corrcoef(x[ok], r[ok])[0, 1]),
                  'n': int(ok.sum())}
    return out


def narrative_tests(D, dfs, n_boot=N_BOOT):
    """Each narrative's single feature: walk-forward validation + pooled dev coefficient (points per SD)."""
    rng = np.random.default_rng(C.SEED)
    out = {}
    for text, col in IX.NARRATIVES.items():
        if col not in D:
            continue
        res, adj, raw, models = run_family(D, [col], dfs, n_boot=n_boot)
        tr = D[D.in_scope & D.season.between(RS.FIRST_TRAIN, max(DEV)) & D[col].notna()]
        x = tr[col].values.astype(float)
        x = np.clip((x - x.mean()) / (x.std() or 1.0), -RS.ZCLIP, RS.ZCLIP)
        y = tr.resid.values
        n = len(x)
        coef = float(np.sum(x * (y - y.mean())) / np.sum(x * x))
        idx = rng.integers(0, n, (n_boot, n))
        bs = ((x[idx] - x[idx].mean(axis=1, keepdims=True)) * (y[idx] - y[idx].mean(axis=1, keepdims=True))).sum(axis=1) \
            / ((x[idx] - x[idx].mean(axis=1, keepdims=True)) ** 2).sum(axis=1)
        ci = [float(v) for v in np.quantile(bs, [0.025, 0.975])]
        sign_ok = ci[0] > 0
        out[text] = {'feature': col, 'pooled_coef_pts_per_sd': coef, 'coef_ci95': ci, 'n': int(n),
                     'walk_forward': {k: res[k] for k in ('delta', 'ci95', 'seasons_improved', 'status')},
                     'verdict': 'SUPPORTED' if (sign_ok and res['status'] == 'VALIDATED') else
                     ('IN-SAMPLE ONLY (pooled coefficient in the predicted direction; the walk-forward correction '
                      'does not validate)' if sign_ok else
                      ('IN-SAMPLE OPPOSITE SIGN (pooled coefficient against the narrative); no out-of-sample value'
                       if ci[1] < 0 else 'NO OUT-OF-SAMPLE VALUE'))}
    return out


def variance_eval(D, dfs, cols=None):
    cols = cols or IX.VARIANCE_FEATURES
    m_all = D.sigma.notna() & D.in_scope
    mult = pd.Series(np.nan, index=D.index)
    coefs = {}
    for S in sorted(D.season.unique()):
        if S < min(DEV) + 1:
            continue
        tr = D[m_all & D.season.between(RS.FIRST_TRAIN, S - 1)]
        if tr.season.nunique() < 2:
            continue
        RS.assert_past_only(sorted(tr.season.unique()), S)
        vm = RS.VarianceModel(cols).fit(tr, tr.resid.values, tr.sigma.values)
        cur = D.season.eq(S) & D.sigma.notna()
        mult[cur] = vm.multiplier(D[cur])
        coefs[int(S)] = vm.coef()
    ev = m_all & D.season.isin(DEV) & mult.notna()
    d = D[ev]
    ll_b, ll_n = [], []
    for S, g in d.groupby('season'):
        ll_b.append(RS.t_loglik(g.resid.values, g.sigma.values, dfs[S]))
        ll_n.append(RS.t_loglik(g.resid.values, g.sigma.values * mult[g.index].values, dfs[S]))
    lb, ln = np.concatenate(ll_b), np.concatenate(ll_n)
    rng = np.random.default_rng(C.SEED)
    dl = ln - lb
    bs = [dl[rng.integers(0, len(dl), len(dl))].mean() for _ in range(N_BOOT)]
    zq = {}
    for S, g in d.groupby('season'):
        from scipy import stats
        df = dfs[S]
        s = np.sqrt((df - 2) / df)
        q = stats.t.ppf(0.9, df) * s
        zq.setdefault('base', []).extend(np.abs(g.resid.values) <= q * g.sigma.values)
        zq.setdefault('matchup', []).extend(np.abs(g.resid.values) <= q * g.sigma.values * mult[g.index].values)
    return {'n': int(len(dl)), 'mean_loglik_gain': float(dl.mean()), 'gain_ci95': [float(x) for x in np.quantile(bs, [0.025, 0.975])],
            'coverage80_base': float(np.mean(zq['base'])), 'coverage80_matchup': float(np.mean(zq['matchup'])),
            'multiplier_p05_p95': [float(mult[ev].quantile(0.05)), float(mult[ev].quantile(0.95))],
            'coef_last': coefs.get(max(DEV)), 'status': 'VALIDATED' if np.quantile(bs, 0.025) > 0 else 'REJECTED'}, mult


def play_selection_eval(seasons, frozen_through=None):
    """Expected play selection (brief 40-41): predict each team's actual neutral pass rate / PROE /
    tempo in a game from (a) its own tendency, (b) + the opponent's response rating (the additive
    joint model), (c) + game script from V2.1's expected margin (gamma fitted walk-forward, or on
    seasons <= frozen_through for the holdout)."""
    if frozen_through is None:
        C.assert_dev_only(seasons)
    else:
        C.assert_dev_only(list(range(RS.FIRST_TRAIN, frozen_through + 1)))
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'),
                        columns=['game_id', 'season', 'prediction_ts', 'home_id', 'away_id', 'ens_pred', 'neutral_site',
                                 'pred_C_ridge', 'pred_D_gbm'])
    M['base'] = M.ens_pred.where(M.ens_pred.notna(), M[['pred_C_ridge', 'pred_D_gbm']].mean(axis=1))
    rows = []
    lo = RS.FIRST_TRAIN
    need = set(seasons) | set(range(lo, (min(seasons) if frozen_through is None else frozen_through + 1)))
    for S in sorted(need):
        TG = ST.team_games(S)
        Rt = ST.ratings(S).set_index(['prediction_ts', 'team_id', 'metric'])
        Lg = ST.league(S).set_index(['prediction_ts', 'metric'])
        g = M[M.season.eq(S)]
        for side, tid, oid, sgn in (('home', 'home_id', 'away_id', 1.0), ('away', 'away_id', 'home_id', -1.0)):
            x = g[['game_id', 'prediction_ts', tid, oid, 'base', 'neutral_site']].rename(columns={tid: 'team_id', oid: 'opp'})
            x = x.merge(TG, on=['game_id', 'team_id'])
            x['H'] = np.where(x.neutral_site, 0.0, sgn)
            x['exp_margin'] = sgn * x.base
            for m, num, den in (('neu_pass', 'pass_neu', 'n_neu'), ('proe', 'proe_num', 'n13'), ('tempo', 'secs_neu', 'plays_neu')):
                y = x[num] / x[den].where(x[den] > 0)
                o = Rt['off'].reindex(pd.MultiIndex.from_arrays([x.prediction_ts, x.team_id, [m] * len(x)])).values
                dd = Rt['def'].reindex(pd.MultiIndex.from_arrays([x.prediction_ts, x.opp, [m] * len(x)])).values
                mu = Lg['mu'].reindex(pd.MultiIndex.from_arrays([x.prediction_ts, [m] * len(x)])).values
                h = Lg['h'].reindex(pd.MultiIndex.from_arrays([x.prediction_ts, [m] * len(x)])).values
                rows.append(pd.DataFrame({'season': S, 'metric': m, 'y': y.values, 'w': x[den].values,
                                          'a': mu + o + h * x.H.values, 'b': mu + o + dd + h * x.H.values,
                                          'em': x.exp_margin.values}))
    R = pd.concat(rows, ignore_index=True)
    R = R[np.isfinite(R.y) & np.isfinite(R.a) & np.isfinite(R.b) & (R.w >= 10)]
    out = {}
    for m, g in R.groupby('metric'):
        g = g.copy()
        g['c'] = np.nan
        gam = {}
        for S in seasons:
            tr = g[g.season.between(RS.FIRST_TRAIN, S - 1 if frozen_through is None else frozen_through)]
            e = tr.y - tr.b
            gm = float(np.sum(tr.w * tr.em * e) / np.sum(tr.w * tr.em ** 2))
            gam[int(S)] = gm
            k = g.season.eq(S)
            g.loc[k, 'c'] = g.loc[k, 'b'] + gm * g.loc[k, 'em']
        d = g[g.season.isin(seasons)]
        wm = lambda col: float(np.average(np.abs(d.y - d[col]), weights=d.w))
        ea, eb = np.abs(d.y - d.a).values, np.abs(d.y - d.b).values
        w = d.w.values
        rng = np.random.default_rng(C.SEED)
        bs = []
        for _ in range(1000):
            i = rng.integers(0, len(d), len(d))
            bs.append(np.average(eb[i], weights=w[i]) - np.average(ea[i], weights=w[i]))
        out[m] = {'n_team_games': int(len(d)), 'wmae_own_tendency': wm('a'), 'wmae_plus_opponent_response': wm('b'),
                  'wmae_plus_game_script': wm('c'), 'game_script_gamma_last': gam.get(max(seasons)),
                  'opponent_response_delta_ci95': [float(x) for x in np.quantile(bs, [0.025, 0.975])],
                  'note': 'weighted by the play count of each game'}
    return out


def clustering_eval(D, dfs, seasons_fit=None):
    """Offensive / defensive style archetypes (k-means, k by BIC of a Gaussian mixture on dev
    team-season finals), their measured profiles, and whether cluster-pair indicators improve the
    residual beyond the continuous features (walk-forward: centroids refit on seasons < S)."""
    from sklearn.cluster import KMeans
    from sklearn.mixture import GaussianMixture
    fd = ST.finals()
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['season', 'home_id', 'home_fbs'])
    fbs = {S: set(g.loc[g.home_fbs, 'home_id']) for S, g in G.groupby('season')}
    off_m = ['proe', 'ed_proe', 'pd_proe', 'tempo', 'qb_rush_rate', 'go_oe']
    def_m = ['proe', 'tempo', 'qb_rush_rate', 'qb_rush_epa', 'epa_early', 'epa_pd']

    def team_season(side, mets, seasons):
        W = fd[fd.metric.isin(mets) & fd.season.isin(seasons)].pivot_table(index=['season', 'team_id'], columns='metric',
                                                                           values=side)[mets]
        W = W[[t in fbs.get(s, set()) for s, t in W.index]]
        return W.dropna()
    dev_fit = [s for s in range(2014, max(DEV) + 1)]
    out = {'cluster_version': CLUSTER_VERSION}
    ks = {}
    for side, mets in (('off', off_m), ('def', def_m)):
        W = team_season(side, mets, dev_fit)
        Z = (W - W.mean()) / W.std()
        bic = {k: float(GaussianMixture(k, random_state=C.SEED, n_init=3).fit(Z.values).bic(Z.values)) for k in range(2, 9)}
        k = min(bic, key=bic.get)
        km = KMeans(k, random_state=C.SEED, n_init=10).fit(Z.values)
        prof = []
        names = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['home_id', 'home_team']) \
            .drop_duplicates('home_id').set_index('home_id').home_team
        for c in range(k):
            idx = km.labels_ == c
            ex = W[idx].copy()
            ex['d'] = ((Z[idx].values - km.cluster_centers_[c]) ** 2).sum(axis=1)
            prof.append({'cluster': c, 'n_team_seasons': int(idx.sum()),
                         'mean_raw': {m: round(float(W[idx][m].mean()), 4) for m in mets},
                         'mean_z': {m: round(float(Z[idx][m].mean()), 2) for m in mets},
                         'closest_examples': ['%s %d' % (names.get(t, t), s) for s, t in ex.sort_values('d').index[:4]]})
        out[side] = {'k_by_bic': k, 'bic': bic, 'profiles': prof}
        ks[side] = (k, mets)
    # walk-forward cluster-pair features
    feats = pd.DataFrame(index=D.index)
    ko, kd = ks['off'][0], ks['def'][0]
    pair_cols = ['cl_%d_%d' % (i, j) for i in range(ko) for j in range(kd)]
    for c in pair_cols:
        feats[c] = 0.0
    for S in sorted(D.season.unique()):
        tr_seasons = list(range(max(2012, S - 6), S))
        cents = {}
        for side, (k, mets) in ks.items():
            W = team_season(side, mets, tr_seasons)
            mu, sd = W.mean(), W.std()
            km = KMeans(k, random_state=C.SEED, n_init=10).fit(((W - mu) / sd).values)
            cents[side] = (km, mu, sd, mets)
        Rt = ST.ratings(S)
        g = D[D.season.eq(S)]

        def assign(side, teams, T):
            km, mu, sd, mets = cents[side]
            w = Rt[Rt.prediction_ts.isin(T.unique()) & Rt.metric.isin(mets)].pivot_table(
                index=['prediction_ts', 'team_id'], columns='metric', values=side)[mets]
            v = w.reindex(pd.MultiIndex.from_arrays([T, teams]))
            z = ((v - mu) / sd).fillna(0.0).values
            return km.predict(z)
        ho, hd = assign('off', g.home_id.values, g.prediction_ts), assign('def', g.home_id.values, g.prediction_ts)
        ao, ad = assign('off', g.away_id.values, g.prediction_ts), assign('def', g.away_id.values, g.prediction_ts)
        for i, ix in enumerate(g.index):
            feats.loc[ix, 'cl_%d_%d' % (ho[i], ad[i])] += 1.0
            feats.loc[ix, 'cl_%d_%d' % (ao[i], hd[i])] -= 1.0
    Dc = D.join(feats)
    res, *_ = run_family(Dc, pair_cols, dfs)
    out['cluster_pairs_walk_forward'] = {k: res[k] for k in ('delta', 'ci95', 'seasons_improved', 'status')}
    out['n_pair_features'] = len(pair_cols)
    out['decision'] = 'KEEP' if res['status'] == 'VALIDATED' else 'DISCARD (continuous features only; brief 23)'
    return out


def possessions_eval(seasons):
    """Expected possessions (brief 28): V2's additive drives model (exp_drives_home + exp_drives_away)
    vs the actual number of drives, and a style-informed version (+ gamma x both teams' neutral
    tempo), gamma fitted walk-forward."""
    C.assert_dev_only(seasons)
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'),
                        columns=['game_id', 'season', 'prediction_ts', 'home_id', 'away_id', 'exp_drives_home',
                                 'exp_drives_away', 'status'])
    rows = []
    for S in sorted(set(seasons) | set(range(RS.FIRST_TRAIN, min(seasons)))):
        T1 = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % S), columns=['game_id', 'n_drives_all'])
        act = T1.groupby('game_id').n_drives_all.sum()
        g = M[M.season.eq(S) & M.status.eq('FINAL')].copy()
        W, Lg = ST.wide(S)
        tempo = W['s_tempo__off']
        th = tempo.reindex(pd.MultiIndex.from_arrays([g.prediction_ts, g.home_id])).values
        ta = tempo.reindex(pd.MultiIndex.from_arrays([g.prediction_ts, g.away_id])).values
        g['actual'] = g.game_id.map(act)
        g['v2'] = g.exp_drives_home + g.exp_drives_away
        g['tempo_sum'] = th + ta
        rows.append(g[['season', 'actual', 'v2', 'tempo_sum']])
    R = pd.concat(rows).dropna()
    out = {'n': 0}
    pred = pd.Series(np.nan, index=R.index)
    for S in seasons:
        tr = R[R.season.between(RS.FIRST_TRAIN, S - 1)]
        e = tr.actual - tr.v2
        x = tr.tempo_sum - tr.tempo_sum.mean()
        gam = float(np.sum(x * (e - e.mean())) / np.sum(x * x))
        k = R.season.eq(S)
        pred[k] = R.v2[k] + (e.mean()) + gam * (R.tempo_sum[k] - tr.tempo_sum.mean())
    d = R[R.season.isin(seasons)]
    p = pred[d.index]
    out = {'n_games': int(len(d)), 'mae_v2_expected_drives': float((d.actual - d.v2).abs().mean()),
           'bias_v2': float((d.v2 - d.actual).mean()),
           'mae_plus_style_tempo': float((d.actual - p).abs().mean()),
           'note': 'actual = both teams\' drives (stage 1 n_drives_all); V2 exp_drives are the additive drives-per-game ratings'}
    return out


def alpha_sensitivity(D, dfs, cols):
    out = {}
    for a in (256.0, 1024.0, 4096.0, 16384.0):
        r, *_ = run_family(D, cols, dfs, make=lambda c, a=a: RS.RidgeResid(c, alpha=a), n_boot=0)
        out[str(int(a))] = {'delta_mae': r['delta']['mae'], 'unshrunk_delta_mae': r['unshrunk_delta']['mae'],
                            'seasons_improved': r['seasons_improved']}
    return out


def missed_matchups(D, cols, thr=21.0):
    """Major misses (|residual| >= thr, dev): is any standardized matchup feature aligned with the
    miss direction more than in ordinary games? Welch t on sign(resid) x z, Bonferroni."""
    from scipy import stats
    m = D.in_scope & D.season.isin(DEV)
    d = D[m]
    miss = d.resid.abs() >= thr
    out = {'threshold': thr, 'n_misses': int(miss.sum()), 'n_games': int(len(d)), 'features': {}}
    k = len(cols)
    for c in cols:
        x = d[c].astype(float)
        z = (x - x.mean()) / (x.std() or 1.0) * np.sign(d.resid)
        a, b = z[miss].dropna(), z[~miss].dropna()
        t, p = stats.ttest_ind(a, b, equal_var=False)
        out['features'][c] = {'mean_aligned_misses': float(a.mean()), 'mean_aligned_others': float(b.mean()),
                              'p': float(p), 'p_bonferroni': float(min(1.0, p * k))}
    sig = [c for c, v in out['features'].items() if v['p_bonferroni'] < 0.05]
    out['overlooked_features'] = sig
    out['verdict'] = ('research queue: %s' % sig) if sig else 'ordinary variance: no matchup feature separates major misses'
    return out


def display_threshold(pairs, D):
    """Similar-matchup display (brief 51): does the most similar past comparison's residual predict
    the team's residual in the upcoming game better than the team's general form? By similarity bin."""
    P = pairs[pairs.season.isin(DEV)]
    P = P.sort_values('similarity_score', ascending=False).drop_duplicates(['target_game_id', 'team_side'])
    r = D.set_index('game_id')[['resid', 'in_scope']]
    P = P.join(r, on='target_game_id')
    P = P[P.in_scope.astype(bool)]
    P['target_r'] = np.where(P.team_side.eq('home'), P.resid, -P.resid)
    bins = [0, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01]
    out = {}
    rng = np.random.default_rng(C.SEED)
    for lo, hi in zip(bins[:-1], bins[1:]):
        s = P[(P.similarity_score >= lo) & (P.similarity_score < hi)]
        if len(s) < 50:
            continue
        x, y = s.comparison_margin_residual.values, s.target_r.values
        c = float(np.corrcoef(x, y)[0, 1])
        bs = []
        for _ in range(1000):
            i = rng.integers(0, len(x), len(x))
            bs.append(np.corrcoef(x[i], y[i])[0, 1])
        out['%.1f-%.1f' % (lo, hi)] = {'n': int(len(s)), 'corr': c, 'ci95': [float(v) for v in np.nanquantile(bs, [0.025, 0.975])]}
    valid = [k for k, v in out.items() if v['ci95'][0] > 0]
    return {'bins': out, 'validated_bins': valid,
            'threshold': (min(float(k.split('-')[0]) for k in valid) if valid else None),
            'decision': ('display "most similar recent opponent" only at similarity >= %s' % min(valid)) if valid else
                        'NO validated threshold: similar matchups are shown as description only, labelled as carrying '
                        'no predictive evidence (never "they beat a similar team")'}


# ================================================================== main
def dev(n_boot=N_BOOT, redo_similarity=False):
    M, dfs = load()
    D0 = RS.base_frame(M)
    out = {'base_model_version': BASE_MODEL_VERSION, 'feature_version': MATCHUP_FEATURE_VERSION,
           'style_version': STYLE_VERSION, 'similarity_version': SIMILARITY_VERSION, 'prereg': PREREG,
           'identity_max_abs_diff_p_home_raw': identity_check(D0, dfs)}
    if redo_similarity or not os.path.exists(mdir('similarity_choice.json')):
        sc, _ = similarity_choice(M, D0, dfs)
    out['similarity_choice'] = json.load(open(mdir('similarity_choice.json')))
    F = build_features(M, refresh=True)
    D = frame(M, F)
    fam = families()
    # ---- base window numbers
    out['general_model_dev'] = RS.metrics(D[D.in_scope & D.season.isin(DEV)].margin.values,
                                          D[D.in_scope & D.season.isin(DEV)].base.values)
    # ---- per family (add-one to the empty correction)
    res_f, adjs = {}, {}
    for f, cols in fam.items():
        r, adj, raw, models = run_family(D, cols, dfs, n_boot=n_boot)
        last = models.get(max(DEV))
        r['coef_last_dev_fit'] = last.coef() if last is not None else None
        res_f[f] = r
        adjs[f] = adj
        print('[family] %-14s dMAE %+.4f CI [%+.4f, %+.4f] seasons %d/8 -> %s' % (
            f, r['delta']['mae'], r['ci95']['mae'][0], r['ci95']['mae'][1], r['seasons_improved'], r['status']), flush=True)
    out['families'] = res_f
    # ---- controls
    D['ctl_ens_pred'] = D.base
    ctl, *_ = run_family(D, ['ctl_ens_pred'], dfs, n_boot=n_boot)
    out['control_recalibration_ens_pred'] = {k: ctl[k] for k in ('delta', 'ci95', 'seasons_improved', 'status')}
    # ---- kitchen sink (all new families) ridge vs GBM: interpretable vs nonlinear
    all_new = [c for f, cols in fam.items() if f != 'v2_existing' for c in cols]
    r_all, adj_all, raw_all, m_all = run_family(D, all_new, dfs, n_boot=n_boot)
    r_gbm, adj_gbm, raw_gbm, m_gbm = run_family(D, all_new, dfs, make=lambda c: RS.GBMResid(c), n_boot=n_boot)
    out['all_families_ridge'] = r_all
    out['all_families_gbm'] = r_gbm
    out['all_families_ridge']['coef_last_dev_fit'] = m_all[max(DEV)].coef()
    print('[all] ridge dMAE %+.4f %s | gbm dMAE %+.4f %s' % (r_all['delta']['mae'], r_all['status'], r_gbm['delta']['mae'],
                                                            r_gbm['status']), flush=True)
    # ---- drop-one ablation from the all-families ridge
    abl = {}
    for f, cols in fam.items():
        if f == 'v2_existing':
            continue
        keep = [c for c in all_new if c not in cols]
        r, *_ = run_family(D, keep, dfs, n_boot=0)
        abl[f] = {'delta_mae_without': r['delta']['mae'], 'delta_mae_all': r_all['delta']['mae'],
                  'family_contribution': r['delta']['mae'] - r_all['delta']['mae']}
    out['drop_one_ablation'] = abl
    out['alpha_sensitivity_all_families'] = alpha_sensitivity(D, dfs, all_new)
    out['possessions'] = possessions_eval(DEV)
    # ---- the combined validated model
    validated = [f for f, r in res_f.items() if r['status'] == 'VALIDATED' and f != 'v2_existing']
    out['validated_families'] = validated
    if validated:
        cols = [c for f in validated for c in fam[f]]
        r_c, adj_c, raw_c, m_c = run_family(D, cols, dfs, n_boot=n_boot)
        out['combined'] = r_c
        out['combined']['families'] = validated
        cand, cand_name = adj_c, 'combined_validated'
    else:
        out['combined'] = None
        cand, cand_name = adj_all, 'all_families_ridge (reference challenger; nothing validated)'
    out['analysis_candidate'] = cand_name
    # ---- buckets, direction, subgroups for the candidate (and the GBM)
    CT = CH.continuity_table()
    out['buckets'] = {'candidate': buckets(D, cand, DEV), 'all_families_ridge_unshrunk': buckets(D, raw_all.clip(-RS.CAP, RS.CAP), DEV),
                      'gbm': buckets(D, adj_gbm, DEV)}
    out['direction'] = {'candidate': direction_test(D, cand, DEV), 'all_families_ridge_unshrunk': direction_test(D, raw_all, DEV),
                        'gbm_unshrunk': direction_test(D, raw_gbm, DEV)}
    out['subgroups'] = {'candidate': subgroups(D, cand, DEV, CT), 'all_families_ridge_unshrunk': subgroups(D, raw_all.clip(-RS.CAP, RS.CAP), DEV, CT)}
    out['adjustment_distribution'] = {
        name: {'mean_abs': float(a[D.season.isin(DEV)].abs().mean()), 'p50': float(a[D.season.isin(DEV)].abs().quantile(0.5)),
               'p90': float(a[D.season.isin(DEV)].abs().quantile(0.9)), 'p99': float(a[D.season.isin(DEV)].abs().quantile(0.99)),
               'max': float(a[D.season.isin(DEV)].abs().max()), 'share_ge_3': float((a[D.season.isin(DEV)].abs() >= 3).mean())}
        for name, a in (('candidate', cand), ('all_families_ridge_raw', raw_all), ('gbm_raw', raw_gbm))}
    # ---- redundancy, narratives, variance, play selection, clusters, misses
    out['redundancy'] = redundancy(D, [c for c in all_new])
    out['narratives'] = narrative_tests(D, dfs, n_boot=n_boot)
    for k, v in out['narratives'].items():
        print('[narrative] %-70s %s' % (k[:70], v['verdict']), flush=True)
    ve, mult = variance_eval(D, dfs)
    out['variance_model'] = ve
    out['play_selection'] = play_selection_eval(DEV)
    out['clustering'] = clustering_eval(D, dfs)
    out['missed_matchups'] = missed_matchups(D, all_new)
    # ---- similar matchups: pairs (display table) + display threshold
    cfg = load_sim_choice()
    _, pairs = SM.build(M, metric=cfg['metric'], h=cfg['h'], want_pairs=True)
    pairs.to_parquet(mdir('similar_pairs.parquet'), index=False)
    out['similar_display'] = display_threshold(pairs, D)
    # ---- continuity + change points
    out['persistence'] = CH.persistence_study()
    out['head_coach_moves'] = CH.head_coach_moves()
    thr = CH.calibrate(DEV)
    out['change_thresholds'] = thr
    E = pd.concat([CH.events(S, thr) for S in range(RS.FIRST_TRAIN, C.LIVE_SEASON + 1)], ignore_index=True)
    E.to_parquet(mdir('style_change_events.parquet'), index=False)
    out['change_events'] = {'n_by_type_dev': E[E.season.isin(DEV)].event_type.value_counts().to_dict(),
                            'expected_false_alarms_per_season': '~5% of team-seasons per metric under the permutation null',
                            'validation': CH.validate_events(DEV, thr)}
    # ---- save the dev OOF rows
    O = D[['game_id', 'season', 'week', 'in_scope', 'margin', 'base', 'sigma', 'p_home_raw']].copy()
    O['adj_candidate'], O['adj_all_ridge'], O['adj_all_ridge_raw'], O['adj_gbm'] = cand, adj_all, raw_all, adj_gbm
    O['sigma_mult'] = mult
    O.to_parquet(mdir('oof_dev.parquet'), index=False)
    common.write_json(mdir('backtest_dev.json'), out)
    return out


def freeze(dev_out=None):
    """Freeze the artifact from the dev decision: ADJUST with the validated families, or NO_ADJUSTMENT.
    Also freezes (as CHALLENGER, never applied in production) the all-families ridge and GBM so the
    holdout can report what they would have done."""
    dev_out = dev_out or json.load(open(mdir('backtest_dev.json')))
    M, dfs = load()
    F = build_features(M)
    D = frame(M, F)
    fam = families()
    validated = dev_out.get('validated_families') or []
    tr = D[D.in_scope & D.season.between(RS.FIRST_TRAIN, max(DEV))]
    C.assert_dev_only([s for s in tr.season.unique() if s >= min(DEV)])
    models = {}
    all_new = [c for f, cols in fam.items() if f != 'v2_existing' for c in cols]
    lam_all = dev_out['all_families_ridge']['lambda_by_season']
    models['challenger_all_ridge'] = RS.RidgeResid(all_new).fit(tr, tr.resid.values).to_json()
    # lambda for the first holdout season = the OOF calibration slope over ALL dev seasons (2015-2023)
    key = str(min(HOLDOUT))
    models['challenger_all_ridge']['lambda'] = float(lam_all[key] if key in lam_all else lam_all[min(HOLDOUT)])
    if validated:
        cols = [c for f in validated for c in fam[f]]
        lam = dev_out['combined']['lambda_by_season']
        models['mean'] = RS.RidgeResid(cols).fit(tr, tr.resid.values).to_json()
        key = str(min(HOLDOUT))
        models['lambda'] = float(lam[key] if key in lam else lam[min(HOLDOUT)])
        status = 'ADJUST'
    else:
        models['mean'] = None
        models['lambda'] = 0.0
        status = 'NO_ADJUSTMENT'
    evidence = {'validated_families': validated,
                'family_status': {f: r['status'] for f, r in dev_out['families'].items()},
                'dev_delta_mae': {f: r['delta']['mae'] for f, r in dev_out['families'].items()},
                'report': 'docs/cfb-matchup/BACKTEST.md', 'prereg': PREREG['validate_if_all']}
    spec = {'families': validated, 'cols': [c for f in validated for c in fam[f]], 'similarity': load_sim_choice()}
    path, body = RS.freeze(spec, D, models, status, evidence)
    print('[freeze]', status, path)
    return path, body


def holdout(rescore=False, n_boot=N_BOOT):
    f = mdir('holdout.json')
    if os.path.exists(f) and not rescore:
        raise SystemExit('the matchup holdout was already scored (%s); it is scored ONCE' % f)
    art = RS.load_artifact()
    M, dfs = load()
    F = build_features(M)
    D = frame(M, F)
    out = {'artifact': art['artifact'], 'status': art['status'], 'sha256': art['sha256'], 'seasons': HOLDOUT}
    adj = pd.Series(RS.apply(art, D), index=D.index)
    out['production'] = score(D, adj, HOLDOUT, dfs, n_boot=n_boot)
    out['production_by_window_note'] = 'NO_ADJUSTMENT: matchup = general on every game' if art['status'] != 'ADJUST' else ''
    ch = RS.RidgeResid.from_json(art['models']['challenger_all_ridge'])
    lam = art['models']['challenger_all_ridge']['lambda']
    raw = pd.Series(ch.predict(D), index=D.index)
    out['challenger_all_ridge_frozen_lambda'] = score(D, (lam * raw).clip(-RS.CAP, RS.CAP), HOLDOUT, dfs, n_boot=n_boot)
    out['challenger_all_ridge_unshrunk'] = score(D, raw.clip(-RS.CAP, RS.CAP), HOLDOUT, dfs, n_boot=n_boot)
    out['challenger_buckets_unshrunk'] = buckets(D, raw.clip(-RS.CAP, RS.CAP), HOLDOUT)
    out['challenger_direction_unshrunk'] = direction_test(D, raw, HOLDOUT)
    out['play_selection_holdout'] = play_selection_eval(HOLDOUT, frozen_through=max(DEV))
    out['general_model_holdout'] = RS.metrics(D[D.in_scope & D.season.isin(HOLDOUT)].margin.values,
                                              D[D.in_scope & D.season.isin(HOLDOUT)].base.values)
    common.write_json(f, out)
    print('[holdout] production dMAE %+.4f | challenger(frozen lambda) dMAE %+.4f | unshrunk %+.4f' % (
        out['production']['delta']['mae'], out['challenger_all_ridge_frozen_lambda']['delta']['mae'],
        out['challenger_all_ridge_unshrunk']['delta']['mae']))
    return out


def live():
    art = RS.load_artifact()
    M, dfs = load()
    F = build_features(M)
    D = frame(M, F)
    adj = pd.Series(RS.apply(art, D), index=D.index)
    out = {'season': C.LIVE_SEASON, 'status': art['status'],
           'played': score(D, adj, [C.LIVE_SEASON], dfs, n_boot=500) if (D.in_scope & D.season.eq(C.LIVE_SEASON)).any() else None}
    common.write_json(mdir('live_2026.json'), out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--features', action='store_true')
    ap.add_argument('--dev', action='store_true')
    ap.add_argument('--redo-similarity', action='store_true')
    ap.add_argument('--freeze', action='store_true')
    ap.add_argument('--holdout', action='store_true')
    ap.add_argument('--rescore-holdout', action='store_true')
    ap.add_argument('--live', action='store_true')
    ap.add_argument('--boot', type=int, default=N_BOOT)
    a = ap.parse_args()
    if a.features:
        M, _ = load()
        build_features(M, refresh=True)
    if a.dev:
        dev(n_boot=a.boot, redo_similarity=a.redo_similarity)
    if a.freeze:
        freeze()
    if a.holdout:
        holdout(rescore=a.rescore_holdout, n_boot=a.boot)
    if a.live:
        live()


if __name__ == '__main__':
    main()
