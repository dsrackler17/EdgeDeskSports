"""Backtests of the non-QB personnel units (docs/cfb-personnel/UNITS.md).

    python3 -m v2.personnel.backtest_units --dev        # constants, panels, lambda, dev backtest, ablation,
                                                        # multi-absence test, returning production 2.0
    python3 -m v2.personnel.backtest_units --pvar       # 2025 PVAR tables
    python3 -m v2.personnel.backtest_units --reanchor   # the re-anchoring example
    python3 -m v2.personnel.backtest_units --live       # 2026 unit states from the official reports
    python3 -m v2.personnel.backtest_units --all        # everything above (never the holdout)
    python3 -m v2.personnel.backtest_units --holdout    # the holdout 2024-2025, ONCE (refuses to re-score)

BASE = V2.1's walk-forward out-of-fold prediction (out_h/stage7/backtest_predictions.parquet, ens_pred;
for 2014-2015, training rows only, the equal C/D mean that IS the V2.1 stack). An adjusted prediction is
BASE + sum_u beta_u x Delta_u (Delta_u = home unit delta - away unit delta, points), beta fitted
walk-forward on earlier seasons only with a N(0, BETA_PRIOR_SD^2) prior (shrunk toward 0).
Win probability: V2.1's own t (the season's df from report/backtest.json) on the adjusted mean and V2.1's
sigma; the OL component adds variance only. Scope: FBS vs FBS, FINAL.
Pure model only: the stage-7 file is read through an allowlist of columns; no market column enters.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import state as ST
from . import units as UN
from . import usage as U
from . import values as V

DEV = tuple(C.DEV_SEASONS)
HOLDOUT = tuple(C.HOLDOUT_SEASONS)
TRAIN0 = (2014, 2015)                 # training rows only (no ens_pred / sigma in the V2.1 walk-forward)
EVAL_UNITS = ('RB', 'WR_TE', 'FRONT7', 'SECONDARY', 'ST')
VARIANT_UNITS = {'SKILL': ('RB', 'WR_TE'), 'DEF': ('FRONT7', 'SECONDARY'), 'ST': ('ST',), 'ALL': EVAL_UNITS}
DELTA_VARIANTS = ('oracle', 'oracle_naive', 'pregame', 'oracle_use', 'oracle_naive_use', 'pregame_use')
BETA_PRIOR_SD = 1.0                   # beta ~ N(0, 1): Delta is in nominal points, beta = 1 = taken at face value
N_BOOT = 2000
# the stage-7 columns this module may read (an allowlist: every market / evaluation column is excluded)
STAGE7_COLS = ['game_id', 'season', 'week', 'season_type', 'home_id', 'away_id', 'home_team', 'away_team',
               'home_fbs', 'away_fbs', 'status', 'kickoff_ts', 'prediction_ts', 'margin', 'neutral_site',
               'ens_pred', 'pred_C_ridge', 'pred_D_gbm', 'sigma', 'p_home_raw', 'lo_80', 'hi_80', 'lo_95', 'hi_95']


def out_dir():
    d = common.out_path('personnel', 'units')
    os.makedirs(d, exist_ok=True)
    return d


def _dump(name, obj):
    with open(os.path.join(out_dir(), name), 'w') as fh:
        json.dump(ids.clean(obj), fh, indent=1, sort_keys=True, default=str)


def _load(name):
    return json.load(open(os.path.join(out_dir(), name)))


def assert_no_market(cols):
    """No market / evaluation column may enter the pure path (contract.layer_of + weekly.project tokens)."""
    from .. import contract as K
    from ..weekly import project as PJ
    bad = [c for c in cols if K.layer_of(c) in ('market', 'evaluation') or c.lower() in PJ.MARKET_COLUMNS
           or set(c.lower().split('_')) & PJ.MARKET_TOKENS]
    if bad:
        raise AssertionError('market columns in the personnel path: %s' % bad)
    return True


# ================================================================ BASE
def wf_dir():
    """The V2.1 walk-forward directory (the QB layer's rule: report/backtest.json names V2.1 / fv2)."""
    for d in (C.OUT, os.environ.get('CFB_V2_WF_DIR'), os.path.join(os.path.dirname(os.path.abspath(C.OUT)), 'out_h')):
        if not d:
            continue
        f = os.path.join(d, 'report', 'backtest.json')
        if os.path.exists(f):
            r = json.load(open(f))
            if r.get('model_version') == C.PRODUCTION_MODEL_VERSION and r.get('feature_version') == C.FEATURE_VERSION:
                return d
    raise FileNotFoundError('no V2.1 walk-forward output (report/backtest.json with %s / %s)'
                            % (C.PRODUCTION_MODEL_VERSION, C.FEATURE_VERSION))


def t_df_by_season():
    r = json.load(open(os.path.join(wf_dir(), 'report', 'backtest.json')))
    return {int(k): int(v['t_df']) for k, v in r['uncertainty_by_season'].items()}


def t_cdf(x, df):
    from scipy import stats
    s = np.sqrt((df - 2) / df)
    return stats.t.cdf(x / s, df)


def p_home(mu, sigma, df):
    return 1.0 - t_cdf(-np.asarray(mu) / np.asarray(sigma), df)


def load_base(seasons=None):
    assert_no_market(STAGE7_COLS)
    B = pd.read_parquet(os.path.join(wf_dir(), 'stage7', 'backtest_predictions.parquet'), columns=STAGE7_COLS)
    B = B[B.home_fbs.astype(bool) & B.away_fbs.astype(bool) & B.status.eq('FINAL') & B.margin.notna()].copy()
    B['base'] = B.ens_pred.where(B.ens_pred.notna(), (B.pred_C_ridge + B.pred_D_gbm) / 2.0)
    B = B[B.base.notna()]
    if seasons is not None:
        B = B[B.season.isin(list(seasons))]
    B['prediction_ts'] = pd.to_datetime(B.prediction_ts, utc=True)
    df = t_df_by_season()
    B['t_df'] = B.season.map(df)
    B['p_base'] = np.where(B.sigma.notna(), p_home(B.base, B.sigma.where(B.sigma.notna(), 1.0), B.t_df.fillna(100)),
                           np.nan)
    B['y_win'] = (B.margin > 0).astype(float)
    return B.reset_index(drop=True)


# ================================================================ panels
def _panel_sig(S):
    const = V.constants()
    keys = [U._cache_key(s) for s in (S - 1, S) if s >= C.FIRST_PBP_SEASON]
    f7 = os.path.join(wf_dir(), 'stage7', 'backtest_predictions.parquet')
    st7 = os.stat(f7)
    return ids.h(UN.PANEL_VERSION, const['signature'], *keys, st7.st_size, st7.st_mtime_ns)


def season_panel(S, B=None, refresh=False):
    """The unit panel of season S at every V2.1 freeze of its FBS-vs-FBS games (oracle columns on).
    Cached under <OUT>/personnel/cache/units_panel_<S>.parquet."""
    d = os.path.dirname(common.out_path('personnel', 'cache', 'x'))
    f = os.path.join(d, 'units_panel_%d.parquet' % S)
    fm = f.replace('.parquet', '.json')
    sig = _panel_sig(S)
    if not refresh:
        try:
            if json.load(open(fm)).get('key') == sig:
                P = pd.read_parquet(f)
                P['T'] = pd.to_datetime(P['T'], utc=True)
                return P
        except (OSError, ValueError):
            pass
    B = load_base([S]) if B is None else B[B.season.eq(S)]
    fr = pd.concat([B[['home_id', 'prediction_ts', 'game_id']].rename(columns={'home_id': 'team_id', 'prediction_ts': 'T'}),
                    B[['away_id', 'prediction_ts', 'game_id']].rename(columns={'away_id': 'team_id', 'prediction_ts': 'T'})])
    t0 = time.time()
    P = UN.panel(S, fr, oracle=True)
    P.to_parquet(f, index=False)
    json.dump({'key': sig}, open(fm, 'w'))
    print('[panel] %d: %d rows, %.0fs' % (S, len(P), time.time() - t0), flush=True)
    return P


# ================================================================ lambda
def estimate_lambda(seasons=DEV):
    """Share of an absent player's usage that goes to players outside the lineup list (an unseen
    replacement), share groups RB and WR_TE, in-season absences, dev only:
        lam = sum_J n1_J [E(out-of-list share | one absence, J) - E(out-of-list share | no absence, J)]
              / sum_J n1_J  /  E(missing healthy share | one absence)
    matched on J = the team's games before T (capped at 12): new players appear most early in a season,
    so an unmatched comparison is confounded by the calendar (it came out negative). Bootstrap CI."""
    C.assert_dev_only(seasons)
    rows = []
    for S in seasons:
        P = season_panel(S)
        P = P[P.group.isin(['RB', 'WR_TE']) & P.next_played.astype(bool)]
        P = P.assign(ab=(P.h * P.den_per_game >= UN.MIN_EXPECTED_EVENTS) & (P.next_c == 0) & P.in_season)
        g = P.groupby(['team_id', 'T', 'group'])
        a = g.agg(in_c=('next_c', 'sum'), grp_c=('next_group_c', 'first'), den=('next_den', 'first'),
                  n_ab=('ab', 'sum'), sh=('h', 'sum'), tot=('group_total', 'first'), J=('J', 'first'))
        m = P[P.ab].groupby(['team_id', 'T', 'group']).h.sum()
        a['M'] = (m.reindex(a.index).fillna(0.0) * a.tot / a.sh.where(a.sh > 0)).fillna(0.0)
        a['out_share'] = ((a.grp_c - a.in_c) / a.den.where(a.den > 0)).clip(lower=0)
        rows.append(a.reset_index())
    A = pd.concat(rows, ignore_index=True).dropna(subset=['out_share'])
    A['Jb'] = A.J.clip(upper=12)
    rng = np.random.default_rng(C.SEED)

    def est(A_):
        one, zero = A_[A_.n_ab.eq(1)], A_[A_.n_ab.eq(0)]
        d = one.groupby('Jb').out_share.mean() - zero.groupby('Jb').out_share.mean()
        w = one.groupby('Jb').size()
        d = d.reindex(w.index)
        ok = d.notna()
        return float((d[ok] * w[ok]).sum() / w[ok].sum() / one.M.mean())
    lam = est(A)
    bs = [est(A.iloc[rng.integers(0, len(A), len(A))]) for _ in range(500)]
    one, zero = A[A.n_ab.eq(1)], A[A.n_ab.eq(0)]
    res = {'lambda': float(np.clip(lam, 0.0, 1.0)), 'lambda_raw': lam,
           'ci': [float(np.quantile(bs, 0.025)), float(np.quantile(bs, 0.975))],
           'n_one_absence': int(len(one)), 'n_no_absence': int(len(zero)),
           'out_share_one': float(one.out_share.mean()), 'out_share_none': float(zero.out_share.mean()),
           'missing_share_one': float(one.M.mean()), 'seasons': list(seasons),
           'by_group': {g: est(A[A.group.eq(g)]) for g in ('RB', 'WR_TE')},
           'basis': 'dev estimate, matched on team games before T (backtest_units.estimate_lambda)'}
    _dump('lambda.json', res)
    return res


# ================================================================ game frame
def game_frame(seasons, lam=None):
    """One row per FBS-vs-FBS game: BASE, outcome, and per unit and delta variant the game-level delta
    (home - away, points) with its variance, plus the oracle's absence descriptors per side."""
    lam = UN.lambda_estimate()['lambda'] if lam is None else lam
    B = load_base(seasons)
    parts = []
    for S in seasons:
        P = season_panel(S, B)
        L = UN.lineups(P, lam)
        D = UN.deltas(L, DELTA_VARIANTS)
        D['game_id'] = D.game_id.astype('int64')
        parts.append(D)
    D = pd.concat(parts, ignore_index=True)
    cols = [c for c in D.columns if c.startswith('d_') or c.startswith('v_')] + \
        ['n_absent', 'n_absent_in_season', 'n_absent_new', 'max_absence_len', 'abs_V', 'pi_s', 'J']
    W = D.pivot_table(index=['game_id', 'team_id'], columns='unit', values=cols, aggfunc='first')
    W.columns = ['%s__%s' % (a, b) for a, b in W.columns]
    W = W.reset_index()
    G = B.copy()
    for side in ('home', 'away'):
        x = W.rename(columns={c: side[0] + '_' + c for c in W.columns if c not in ('game_id', 'team_id')})
        G = G.merge(x.rename(columns={'team_id': side + '_id'}), on=['game_id', side + '_id'], how='left')
    new = {}
    col = lambda c: G[c].fillna(0.0) if c in G else pd.Series(0.0, index=G.index)
    for u in EVAL_UNITS:
        for k in DELTA_VARIANTS:
            new['D_%s__%s' % (k, u)] = col('h_d_%s__%s' % (k, u)) - col('a_d_%s__%s' % (k, u))
            new['V_%s__%s' % (k, u)] = col('h_v_%s__%s' % (k, u)) + col('a_v_%s__%s' % (k, u))
        for s_ in ('h', 'a'):
            for c in ('%s_n_absent_in_season__%s' % (s_, u), '%s_n_absent_new__%s' % (s_, u)):
                new[c] = col(c)
        # a unit CHANGE: a new in-season absence (1-2 games old) on either side: the lineup change the
        # rating has not absorbed yet (long absences are the re-anchoring population: the ablation)
        new['change__' + u] = (new['h_n_absent_new__' + u] > 0) | (new['a_n_absent_new__' + u] > 0)
    G = pd.concat([G.drop(columns=[c for c in new if c in G.columns]), pd.DataFrame(new, index=G.index)], axis=1)
    G['change__ANY'] = G[['change__' + u for u in EVAL_UNITS]].any(axis=1)
    G['change__SKILL'] = G.change__RB | G.change__WR_TE
    G['change__DEF'] = G.change__FRONT7 | G.change__SECONDARY
    G['change__ALL'] = G.change__ANY
    return G


# ================================================================ beta
def fit_beta(G, units, variant, train):
    """Posterior of beta (Gaussian prior N(0, BETA_PRIOR_SD^2) per unit, noise var = the residual
    variance of the training rows): mean, covariance."""
    X = G.loc[train, ['D_%s__%s' % (variant, u) for u in units]].values.astype(float)
    y = (G.loc[train, 'margin'] - G.loc[train, 'base']).values.astype(float)
    s2 = float(np.var(y))
    A = X.T @ X / s2 + np.eye(len(units)) / BETA_PRIOR_SD ** 2
    b = X.T @ y / s2
    cov = np.linalg.inv(A)
    return cov @ b, cov, int(train.sum())


def walk_forward(G, units, variant, eval_seasons, frozen_through=None):
    """Adjusted predictions for eval_seasons: beta_S fitted on seasons < S (>= 2014); or, for the
    holdout, one fit on seasons <= frozen_through."""
    pred = pd.Series(np.nan, index=G.index)
    betas = {}
    for S in eval_seasons:
        train = (G.season < S) if frozen_through is None else (G.season <= frozen_through)
        beta, cov, n = fit_beta(G, units, variant, train.values)
        m = G.season.eq(S)
        X = G.loc[m, ['D_%s__%s' % (variant, u) for u in units]].values.astype(float)
        pred[m] = G.loc[m, 'base'].values + X @ beta
        betas[int(S)] = {u: {'beta': float(beta[i]), 'ci': [float(beta[i] - 1.96 * np.sqrt(cov[i, i])),
                                                              float(beta[i] + 1.96 * np.sqrt(cov[i, i]))]}
                         for i, u in enumerate(units)}
        betas[int(S)]['n_train'] = n
    return pred, betas


# ================================================================ metrics
def _metrics(y, pred, p=None, yw=None):
    e = pred - y
    out = {'n': int(len(y)), 'mae': float(np.mean(np.abs(e))), 'rmse': float(np.sqrt(np.mean(e ** 2))),
           'bias': float(np.mean(e))}
    if p is not None:
        ok = np.isfinite(p)
        if ok.any():
            pp = np.clip(p[ok], 1e-6, 1 - 1e-6)
            out['logloss'] = float(-np.mean(yw[ok] * np.log(pp) + (1 - yw[ok]) * np.log(1 - pp)))
            out['n_prob'] = int(ok.sum())
    return out


def compare(G, mask, pred_var, p_var=None, rng=None):
    """BASE vs variant on the rows in mask: metrics of both and the paired bootstrap CI of the deltas."""
    rng = np.random.default_rng(C.SEED) if rng is None else rng
    g = G[mask]
    y = g.margin.values
    b, v = g.base.values, pred_var[mask].values
    pb, pv = g.p_base.values, (p_var[mask].values if p_var is not None else None)
    yw = g.y_win.values
    mb, mv = _metrics(y, b, pb, yw), _metrics(y, v, pv, yw)
    n = len(g)
    if n == 0:
        return {'base': mb, 'variant': mv}
    ae_b, ae_v = np.abs(b - y), np.abs(v - y)
    se_b, se_v = (b - y) ** 2, (v - y) ** 2
    idx = rng.integers(0, n, size=(N_BOOT, n))
    d_mae = ae_v[idx].mean(axis=1) - ae_b[idx].mean(axis=1)
    d_rmse = np.sqrt(se_v[idx].mean(axis=1)) - np.sqrt(se_b[idx].mean(axis=1))
    res = {'base': mb, 'variant': mv, 'd_mae': mv['mae'] - mb['mae'],
           'd_mae_ci': [float(np.quantile(d_mae, 0.025)), float(np.quantile(d_mae, 0.975))],
           'd_rmse': mv['rmse'] - mb['rmse'],
           'd_rmse_ci': [float(np.quantile(d_rmse, 0.025)), float(np.quantile(d_rmse, 0.975))]}
    if pv is not None:
        ok = np.isfinite(pv) & np.isfinite(pb)
        if ok.any():
            def ll(p):
                p = np.clip(p, 1e-6, 1 - 1e-6)
                return -(yw * np.log(p) + (1 - yw) * np.log(1 - p))
            lb, lv = ll(np.where(ok, pb, 0.5)), ll(np.where(ok, pv, 0.5))
            okf = ok.astype(float)
            dl = ((lv - lb) * okf)[idx].sum(axis=1) / np.maximum(okf[idx].sum(axis=1), 1)
            res['d_logloss'] = float(((lv - lb) * okf).sum() / okf.sum())
            res['d_logloss_ci'] = [float(np.quantile(dl, 0.025)), float(np.quantile(dl, 0.975))]
    return res


def evaluate(G, eval_seasons, frozen_through=None, delta_variant='oracle'):
    """BASE vs +SKILL / +DEF / +ST / +ALL on (i) games with a unit change (oracle absences), (ii) all games."""
    rng = np.random.default_rng(C.SEED)
    res = {'delta_variant': delta_variant, 'seasons': list(eval_seasons), 'variants': {}}
    E = G[G.season.isin(eval_seasons)]
    for name, units in VARIANT_UNITS.items():
        pred, betas = walk_forward(G, units, delta_variant, eval_seasons, frozen_through)
        p = pd.Series(np.where(G.sigma.notna(), p_home(pred.fillna(0), G.sigma.fillna(1.0), G.t_df.fillna(100)), np.nan),
                      index=G.index)
        ev = G.season.isin(eval_seasons)
        chg = ev & G['change__' + name].astype(bool)
        res['variants'][name] = {
            'units': list(units), 'betas': betas,
            'unit_change_games': compare(G, chg & pred.notna(), pred, p, rng),
            'all_games': compare(G, ev & pred.notna(), pred, p, rng),
            'no_change_games': compare(G, ev & ~G['change__' + name].astype(bool) & pred.notna(), pred, p, rng)}
    res['n_games'] = int(len(E))
    return res


# ================================================================ ablation
def ablation(G, eval_seasons=DEV, value=''):
    """Double-count ablation: the baseline delta (upcoming - rating lineup) against the naive absolute
    delta (upcoming - full-health lineup), per absence length, on team-games with an in-season oracle
    absence in a skill unit. r = the team's V2.1 residual (margin - BASE, signed to the team)."""
    rng = np.random.default_rng(C.SEED)
    out = {}
    fits = {}
    for k in ('oracle', 'oracle_naive'):
        pred, betas = walk_forward(G, VARIANT_UNITS['SKILL'], k + value, eval_seasons)
        fits[k] = (pred, betas)
    rows = []
    for side, s in (('h', 1.0), ('a', -1.0)):
        for u in ('RB', 'WR_TE'):
            c = '%s_n_absent_in_season__%s' % (side, u)
            m = G.season.isin(eval_seasons) & (G[c] > 0)
            g = G[m]
            rows.append(pd.DataFrame({
                'game_id': g.game_id.values, 'season': g.season.values, 'unit': u, 'home_away': side,
                'r': s * (g.margin - g.base).values,
                'len': g['%s_max_absence_len__%s' % (side, u)].values,
                'd_base': g['%s_d_oracle%s__%s' % (side, value, u)].values,
                'd_naive': g['%s_d_oracle_naive%s__%s' % (side, value, u)].values,
                'adj_base': s * (fits['oracle'][0][m] - g.base).values,
                'adj_naive': s * (fits['oracle_naive'][0][m] - g.base).values,
                'err_b': np.abs(g.base - g.margin).values, 'err_base': np.abs(fits['oracle'][0][m] - g.margin).values,
                'err_naive': np.abs(fits['oracle_naive'][0][m] - g.margin).values}))
    A = pd.concat(rows, ignore_index=True)
    A['bucket'] = np.where(A.len >= 3, '3+', A.len.fillna(1).astype(int).astype(str))

    def ci(x):
        x = np.asarray(x, dtype=float)
        if len(x) < 3:
            return [None, None]
        bs = x[rng.integers(0, len(x), size=(N_BOOT, len(x)))].mean(axis=1)
        return [float(np.quantile(bs, 0.025)), float(np.quantile(bs, 0.975))]
    for bkt, g in A.groupby('bucket'):
        out[bkt] = {'n_team_games': int(len(g)), 'mean_residual_r': float(g.r.mean()), 'r_ci': ci(g.r),
                    'mean_nominal_delta_baseline': float(g.d_base.mean()),
                    'mean_nominal_delta_naive': float(g.d_naive.mean()),
                    'mean_fitted_adj_baseline': float(g.adj_base.mean()),
                    'mean_fitted_adj_naive': float(g.adj_naive.mean()),
                    'overshoot_nominal_naive': float((g.d_naive - g.r).mean()),
                    'overshoot_nominal_baseline': float((g.d_base - g.r).mean()),
                    'mae_base': float(g.err_b.mean()), 'mae_baseline_delta': float(g.err_base.mean()),
                    'mae_naive_delta': float(g.err_naive.mean()),
                    'd_mae_naive_minus_baseline': float((g.err_naive - g.err_base).mean()),
                    'd_mae_naive_minus_baseline_ci': ci(g.err_naive - g.err_base)}
    return {'value': 'usage-revealed' if value else 'efficiency', 'buckets': out,
            'betas': {k: v[1] for k, v in fits.items()}, 'n': int(len(A)),
            'note': 'r > 0: the team did better than V2.1 said. A delta that is more negative than r on long '
                    'absences over-subtracts (double counts what the rating already absorbed).'}


# ================================================================ multiple absences
def multi_absence(G, seasons=DEV, value=''):
    """Is the effect of several absences in one unit super-linear? Team-games with >= 1 in-season
    oracle absence in RB or WR_TE: r = b Delta + g (Delta x 1[>= 2 absences]) (OLS, bootstrap CI);
    a convex unit function is implemented only if g's CI excludes 0 (it is not: linear, variance widened)."""
    rng = np.random.default_rng(C.SEED)
    rows = []
    for side, s in (('h', 1.0), ('a', -1.0)):
        for u in ('RB', 'WR_TE'):
            c = '%s_n_absent_in_season__%s' % (side, u)
            m = G.season.isin(seasons) & (G[c] > 0)
            g = G[m]
            rows.append(pd.DataFrame({'r': s * (g.margin - g.base).values,
                                      'd': g['%s_d_oracle%s__%s' % (side, value, u)].values,
                                      'n_abs': g[c].values, 'unit': u}))
    A = pd.concat(rows, ignore_index=True)
    A['multi'] = (A.n_abs >= 2).astype(float)
    X = np.column_stack([np.ones(len(A)), A.d, A.d * A.multi])
    y = A.r.values

    def ols(ix):
        return np.linalg.lstsq(X[ix], y[ix], rcond=None)[0]
    b = ols(np.arange(len(A)))
    bs = np.array([ols(ix) for ix in rng.integers(0, len(A), size=(N_BOOT, len(A)))])
    res_ = y - X @ b
    return {'value': 'usage-revealed' if value else 'efficiency', 'n_team_unit_games': int(len(A)),
            'n_multi': int(A.multi.sum()),
            'intercept': float(b[0]), 'slope_single': float(b[1]), 'slope_single_ci': [float(np.quantile(bs[:, 1], .025)),
                                                                                       float(np.quantile(bs[:, 1], .975))],
            'extra_slope_multi': float(b[2]), 'extra_slope_multi_ci': [float(np.quantile(bs[:, 2], .025)),
                                                                       float(np.quantile(bs[:, 2], .975))],
            'mean_delta_single': float(A.d[A.multi == 0].mean()), 'mean_delta_multi': float(A.d[A.multi == 1].mean()),
            'mean_r_single': float(A.r[A.multi == 0].mean()), 'mean_r_multi': float(A.r[A.multi == 1].mean()),
            'resid_sd_single': float(res_[A.multi.values == 0].std()), 'resid_sd_multi': float(res_[A.multi.values == 1].std()),
            'variance_widening_factor': float(res_[A.multi.values == 1].var() / res_[A.multi.values == 0].var()),
            'super_linear_supported': bool(np.quantile(bs[:, 2], .025) > 0)}


# ================================================================ returning production 2.0
def returning_production(seasons=DEV):
    """Share of last season's summed PVAR (positive parts) that returns: players with usage for the same
    team this season (spec definition; partly hindsight inside the season) or on this season's roster
    for it (point in time as far as a roster snapshot is), plus transfers in at rho_transfer / rho_stay
    of their old PVAR. Compared with V2's returning-production inputs (data/retprod) as predictors of
    the early-season V2.1 residual (weeks 1-4). Evidence only."""
    C.assert_dev_only(seasons)
    const = V.constants()
    mp = V.model_params(const)
    from .. import build_ratings as BR
    RP, _, _ = BR.load_prior_inputs()
    rows = []
    for S in seasons:
        st = V.season_states(S - 1, const)
        st = st[st.season.eq(S - 1)]
        tgp = U.team_games(S - 1)
        ngames = tgp.groupby('team_id').size()
        rw = V._season_rows(S - 1, const)
        rw = rw[rw.season_reliable]
        ex = rw.groupby(['component', 'espn_id', 'team_id']).n.sum().reset_index()
        pv = ex.merge(st[['component', 'espn_id', 'm']], on=['component', 'espn_id'], how='inner')
        pv['repl'] = pv.component.map(lambda c: mp[c]['repl'] if c in mp else np.nan)
        pv['pts_per_event'] = pv.component.map(lambda c: V.event_value(c, const))
        pv['pvar'] = (pv.m - pv.repl) * pv.n / pv.team_id.map(ngames) * pv.pts_per_event
        pv['phase'] = pv.component.map(lambda c: 'off' if c in V.SKILL_COMPONENTS else 'def' if c in V.DEF_COMPONENTS
                                       else 'st')
        pg = U.player_games(S)
        used = set(zip(pg.espn_id, pg.team_id))
        roster = ST._roster_listing(S)
        rost = set(zip(roster.espn_id.astype('int64'), roster.team_id.astype('int64')))
        # transfers in: a player of another team last season who plays / is listed for this team now
        cur_team = pg.groupby('espn_id').team_id.agg(lambda s: s.mode().iloc[0])
        rteam = roster.set_index('espn_id').team_id if len(roster) else pd.Series(dtype=float)
        for phase, g in pv.groupby('phase'):
            pp = g.copy()
            pp['ret_use'] = [(e, t) in used for e, t in zip(pp.espn_id, pp.team_id)]
            pp['ret_ros'] = [(e, t) in rost for e, t in zip(pp.espn_id, pp.team_id)]
            pp['pos'] = pp.pvar.clip(lower=0)
            tot = pp.groupby('team_id').pos.sum()
            r_use = pp[pp.ret_use].groupby('team_id').pos.sum()
            r_ros = pp[pp.ret_ros].groupby('team_id').pos.sum()
            # transfers in (to a different team), by usage / by roster
            pp['to_use'] = pp.espn_id.map(cur_team)
            pp['to_ros'] = pp.espn_id.map(rteam)
            rho_ratio = pp.component.map(lambda c: mp[c]['rho_transfer'] / max(mp[c]['rho_stay'], 1e-9) if c in mp else 0)
            tin_u = (pp.pos * rho_ratio)[pp.to_use.notna() & pp.to_use.ne(pp.team_id)].groupby(pp.to_use).sum()
            tin_r = (pp.pos * rho_ratio)[pp.to_ros.notna() & pp.to_ros.ne(pp.team_id)].groupby(pp.to_ros).sum()
            teams = sorted(set(tot.index))
            for t in teams:
                T_ = float(tot.get(t, 0.0))
                rows.append({'season': S, 'team_id': int(t), 'phase': phase, 'pvar_total_prev': T_,
                             'rp2_use': (float(r_use.get(t, 0.0)) + float(tin_u.get(t, 0.0))) / T_ if T_ > 0 else np.nan,
                             'rp2_roster': (float(r_ros.get(t, 0.0)) + float(tin_r.get(t, 0.0))) / T_ if T_ > 0 else np.nan,
                             'lost_pts_roster': T_ - float(r_ros.get(t, 0.0)) - float(tin_r.get(t, 0.0))})
    R = pd.DataFrame(rows)
    W = R.pivot_table(index=['season', 'team_id'], columns='phase',
                      values=['rp2_use', 'rp2_roster', 'lost_pts_roster']).reset_index()
    W.columns = ['_'.join([c for c in col if c]) for col in W.columns]
    RP = RP.assign(team_id=RP.team_id.astype('float').astype('Int64'))
    W = W.merge(RP.rename(columns={'off_returning': 'v2_ret_off', 'def_returning': 'v2_ret_def'}).astype(
        {'team_id': 'int64'}), on=['season', 'team_id'], how='left')
    B = load_base(seasons)
    B = B[B.week.le(4) & B.season_type.eq('regular')]
    B['r'] = B.margin - B.base
    feats = [c for c in W.columns if c not in ('season', 'team_id')]
    for side in ('home', 'away'):
        x = W.rename(columns={c: side[0] + '_' + c for c in feats}).rename(columns={'team_id': side + '_id'})
        B = B.merge(x, on=['season', side + '_id'], how='left')
    out = {'n_games': int(len(B)), 'seasons': list(seasons), 'measures': {}}
    rng = np.random.default_rng(C.SEED)
    for f in feats:
        d = (B['h_' + f] - B['a_' + f]).values.astype(float)
        ok = np.isfinite(d)
        if ok.sum() < 50:
            continue
        dd, rr, ss = d[ok], B.r.values[ok], B.season.values[ok]
        z = (dd - dd.mean()) / (dd.std() or 1.0)
        slope = float(np.polyfit(z, rr, 1)[0])
        bs = []
        for ix in rng.integers(0, ok.sum(), size=(1000, ok.sum())):
            bs.append(np.polyfit(z[ix], rr[ix], 1)[0])
        # leave-one-season-out: MAE of r after subtracting the out-of-season fitted slope
        err_b, err_f = [], []
        for S in sorted(set(ss)):
            tr, te = ss != S, ss == S
            b1 = np.polyfit(z[tr], rr[tr], 1)
            err_b.append(np.abs(rr[te] - rr[tr].mean()))
            err_f.append(np.abs(rr[te] - np.polyval(b1, z[te])))
        eb, ef = np.concatenate(err_b), np.concatenate(err_f)
        out['measures'][f] = {'n': int(ok.sum()), 'corr_with_residual': float(np.corrcoef(dd, rr)[0, 1]),
                              'slope_per_sd': slope, 'slope_ci': [float(np.quantile(bs, .025)), float(np.quantile(bs, .975))],
                              'loso_mae_intercept_only': float(eb.mean()), 'loso_mae_with_measure': float(ef.mean()),
                              'loso_d_mae': float(ef.mean() - eb.mean())}
    out['team_seasons'] = int(len(W))
    out['coverage'] = {f: float(np.isfinite(W[f]).mean()) for f in feats}
    return out


# ================================================================ PVAR 2025
PVAR_GROUP = {'RB_rush': 'RB', 'WR_rec': 'WR', 'TE_rec': 'TE', 'FRONT_sack': 'FRONT7', 'SEC_int': 'SECONDARY',
              'SEC_pbu': 'SECONDARY', 'K_fg': 'K', 'K_xp': 'K', 'P_net': 'P'}


def pvar_table(season=2025, top=25):
    """PVAR at the season's last V2.1 freeze: posterior value per event (per team game for the defence)
    x the player's own usage per game played this season (per team game from his first appearance for
    the defence) x points per event; SD from the posterior and the replacement uncertainty."""
    const = V.constants()
    B = pd.read_parquet(os.path.join(wf_dir(), 'stage7', 'backtest_predictions.parquet'), columns=['season', 'prediction_ts'])
    T = pd.to_datetime(B[B.season.eq(season)].prediction_ts, utc=True).max()
    r = V._season_rows(season, const)
    r = r[r.kickoff_ts < T]
    ex = r.groupby(['component', 'espn_id', 'team_id']).agg(n=('n', 'sum'), games=('game_id', 'nunique')).reset_index()
    ex = ex.sort_values(['component', 'espn_id', 'n'], ascending=[True, True, False]).drop_duplicates(['component', 'espn_id'])
    ex['T'] = T
    v = V.values_for(season, ex[['espn_id', 'team_id', 'T', 'component']], const)
    v = v.join(ex[['n', 'games']])
    ev = v.component.map(lambda c: V.event_value(c, const))
    per_game = np.where(v.component.isin(V.DEF_COMPONENTS), 1.0, v.n / v.games)
    v['exposure_per_game'] = per_game
    v['pvar'] = v.value_rate * per_game * ev
    v['pvar_sd'] = v.value_sd * per_game * ev.abs()
    v['group'] = v.component.map(PVAR_GROUP)
    pg = U.player_games(season)
    nm = pg.sort_values('kickoff_ts').groupby('espn_id').name.last()
    v['name'] = v.espn_id.map(nm)
    fbs = set(load_base([season]).home_id) | set(load_base([season]).away_id)
    v = v[v.team_id.isin(fbs)]
    # a player's group total (K: FG + XP; SECONDARY: INT + PBU where reliable)
    P = v.groupby(['group', 'espn_id', 'team_id', 'name'], dropna=False).agg(
        pvar=('pvar', lambda s: s.sum(min_count=1)), pvar_sd=('pvar_sd', lambda s: float(np.sqrt((s ** 2).sum()))),
        exposure=('n', 'max'), games=('games', 'max'),
        null=('null_reason', lambda s: ';'.join(sorted({x for x in s if x})))).reset_index()
    min_exp = {'RB': 60, 'WR': 30, 'TE': 20, 'FRONT7': 6, 'SECONDARY': 6, 'K': 8, 'P': 20}
    out = {'season': season, 'as_of': ids.ts(T), 'groups': {}}
    for gname, g in P.groupby('group'):
        q = g[g.exposure >= min_exp[gname]].dropna(subset=['pvar'])
        if not len(q):
            out['groups'][gname] = {'n': 0, 'null_reason': ';'.join(sorted(set(g.null)))}
            continue
        topq = q.sort_values('pvar', ascending=False).head(top)
        out['groups'][gname] = {
            'n': int(len(q)), 'min_exposure': min_exp[gname],
            'distribution': {k: float(np.quantile(q.pvar, x)) for k, x in
                             (('p05', .05), ('p25', .25), ('p50', .5), ('p75', .75), ('p95', .95))},
            'mean': float(q.pvar.mean()), 'sd': float(q.pvar.std()), 'mean_pvar_sd': float(q.pvar_sd.mean()),
            'share_above_2sd': float((q.pvar > 1.96 * q.pvar_sd).mean()),
            'top': [{'name': r_.name, 'team_id': int(r_.team_id), 'pvar': round(float(r_.pvar), 3),
                     'sd': round(float(r_.pvar_sd), 3), 'exposure': float(r_.exposure), 'games': int(r_.games)}
                    for r_ in topq.itertuples(index=False)]}
    P.to_parquet(os.path.join(out_dir(), 'pvar_%d.parquet' % season), index=False)
    _dump('pvar_%d.json' % season, out)
    return out


# ================================================================ re-anchoring example
def reanchor_example(season=2019, team_id=None, espn_id=None):
    """A real long absence: per freeze, the absent player's baseline share (it decays as the rating
    re-anchors), the replacement's baseline share (it grows), and the baseline vs naive deltas."""
    P = season_panel(season)
    lam = UN.lambda_estimate()['lambda']
    L = UN.lineups(P[P.group.isin(['RB'])], lam)
    if espn_id is None:
        a = L[L.absent & L.in_season & L.group.eq('RB')]
        a = a.assign(Vh=a.V * a.h)
        runs = a.groupby(['team_id', 'espn_id']).agg(n=('T', 'nunique'), Vh=('Vh', 'mean'))
        runs = runs[runs.n >= 6].sort_values(['Vh'], ascending=False)
        team_id, espn_id = [int(x) for x in runs.index[0]]
    x = L[L.team_id.eq(team_id) & L.group.eq('RB')].copy()
    x['d_base'] = (x.u_oracle - x.base) * x.V.fillna(0)
    x['d_naive'] = (x.u_oracle - x.u_healthy) * x.V.fillna(0)
    tot = x.groupby('T').agg(d_base=('d_base', 'sum'), d_naive=('d_naive', 'sum'), pi_s=('pi_s', 'first'),
                             pi_r=('pi_r', 'first'), J=('J', 'first'))
    me = x[x.espn_id.eq(espn_id)].set_index('T')
    ab = x[x.absent].groupby('T').espn_id.apply(list)
    # the replacement: the player whose baseline share grows most over the absence
    rep = x[~x.espn_id.eq(espn_id)].groupby('espn_id').base.agg(lambda s: s.iloc[-1] - s.iloc[0]).idxmax()
    rp = x[x.espn_id.eq(rep)].set_index('T')
    nm = U.player_games(season).groupby('espn_id').name.last()
    rows = []
    for T in tot.index:
        rows.append({'T': ids.ts(T), 'team_games_before': int(tot.loc[T, 'J']), 'pi_season': round(float(tot.loc[T, 'pi_s']), 3),
                     'pi_recent': round(float(tot.loc[T, 'pi_r']), 3),
                     'absent_player_absent': bool(espn_id in ab.get(T, [])),
                     'absent_player_baseline': round(float(me.base.get(T, np.nan)), 4),
                     'absent_player_healthy': round(float(me.h.get(T, np.nan)), 4),
                     'absent_player_value_per_game': round(float(me.V.get(T, np.nan)), 3),
                     'absent_player_delta_baseline': round(float((me.u_oracle.get(T, np.nan) - me.base.get(T, np.nan))
                                                                 * me.V.get(T, np.nan)), 3),
                     'absent_player_delta_naive': round(float((me.u_oracle.get(T, np.nan) - me.u_healthy.get(T, np.nan))
                                                              * me.V.get(T, np.nan)), 3),
                     'replacement_baseline': round(float(rp.base.get(T, np.nan)), 4),
                     'replacement_expected': round(float(rp.e.get(T, np.nan)), 4),
                     'replacement_value_per_game': round(float(rp.V.get(T, np.nan)), 3),
                     'unit_delta_baseline': round(float(tot.loc[T, 'd_base']), 3),
                     'unit_delta_naive': round(float(tot.loc[T, 'd_naive']), 3)})
    res = {'season': season, 'team_id': team_id, 'player': {'espn_id': espn_id, 'name': nm.get(espn_id)},
           'replacement': {'espn_id': int(rep), 'name': nm.get(rep)}, 'unit': 'RB', 'rows': rows}
    _dump('reanchor_example.json', res)
    return res


# ================================================================ live 2026
def live_2026(season=2026):
    """Unit states for the report-covered 2026 games: at the V2.1 Tuesday freeze and at kickoff - 1 min
    (a game-day refresh), plus the OL variance evaluation on completed report-covered games."""
    reps = ST.load_reports(season)
    ok = [r for r in reps if ST._truthy(r.get('ok', True))]
    games = sorted({int(r['game_id']) for r in ok if str(r.get('game_id', '')).isdigit()})
    k = U.kickoffs(season).set_index('game_id')
    B = pd.read_parquet(os.path.join(wf_dir(), 'stage7', 'backtest_predictions.parquet'), columns=STAGE7_COLS)
    B = B[B.season.eq(season) & B.game_id.isin(games)]
    rows, ol_rows = [], []
    lam = UN.lambda_estimate()['lambda']
    for gid, g in B.groupby('game_id'):
        g = g.iloc[0]
        teams = [int(g.home_id), int(g.away_id)]
        for label, T in (('freeze', pd.Timestamp(g.prediction_ts)), ('kickoff_minus_1m', pd.Timestamp(k.kickoff_ts.get(gid)) - pd.Timedelta(minutes=1))):
            if pd.isna(T):
                continue
            s = UN.unit_state(season, T, availability=reps, lam=lam, teams=teams)
            if not len(s):
                continue
            s = s[s.next_game_id.astype(str).eq(str(gid))]
            for r_ in s.itertuples(index=False):
                d = r_._asdict()
                d.update({'game_id': int(gid), 'when': label, 'home': int(r_.team_id) == int(g.home_id)})
                d.pop('lineup', None)
                rows.append(d)
    R = pd.DataFrame(rows)
    out = {'season': season, 'report_games': len(games), 'rows': int(len(R))}
    if len(R):
        R.to_parquet(os.path.join(out_dir(), 'live_%d.parquet' % season), index=False)
        for when, x in R.groupby('when'):
            rep = x[x.knowledge.eq('REPORTED')]
            sk = x[x.unit.isin(['RB', 'WR_TE'])]
            ka = sk[sk.absence_delta_use.fillna(0) < 0]
            out[when] = {'team_units': int(len(x)), 'reported_team_units': int(len(rep)),
                         'games_with_anchored_skill_delta_over_0.05': int(rep[rep.unit.isin(['RB', 'WR_TE']) &
                                                                               rep.delta_pts.abs().gt(0.05)].game_id.nunique()),
                         'games_with_known_skill_absence': int(ka.game_id.nunique()),
                         'known_absence_pts': {'n_team_units': int(len(ka)),
                                               'mean': float(ka.absence_delta_pts.mean()) if len(ka) else None,
                                               'min': float(ka.absence_delta_pts.min()) if len(ka) else None},
                         'ol_teams_with_listed_ol': int((x[x.unit.eq('OL')].ol_listed.fillna(0) > 0).sum()),
                         'ol_expected_missing_total': float(x[x.unit.eq('OL')].ol_expected_missing.fillna(0).sum())}
        # OL: variance inflation evaluated on completed games (coverage / log loss vs V2.1's sigma)
        x = R[R.when.eq('kickoff_minus_1m') & R.unit.eq('OL')]
        infl = x.groupby('game_id').var_inflation_pts2.sum()
        Bc = B[B.margin.notna() & B.sigma.notna()].copy()
        Bc['infl'] = Bc.game_id.map(infl).fillna(0.0)
        df = t_df_by_season().get(season, 100)
        if len(Bc):
            s0 = Bc.sigma.values
            s1 = np.sqrt(s0 ** 2 + Bc.infl.values)
            y = Bc.margin.values
            mu = Bc.ens_pred.values
            yw = (y > 0).astype(float)
            q80 = 1.2844

            def ll(p):
                p = np.clip(p, 1e-6, 1 - 1e-6)
                return float(-np.mean(yw * np.log(p) + (1 - yw) * np.log(1 - p)))
            # the report-path candidate on the completed report-covered games (tiny n: evidence, not a test)
            k1 = R[R.when.eq('kickoff_minus_1m') & R.unit.isin(['RB', 'WR_TE'])].copy()
            k1['s'] = np.where(k1.home, 1.0, -1.0)
            adj = (k1.absence_delta_pts.fillna(0.0) * k1.s).groupby(k1.game_id).sum()
            mu1 = mu + Bc.game_id.map(adj).fillna(0.0).values
            out['report_path_eval'] = {'n_completed': int(len(Bc)), 'n_adjusted': int((Bc.game_id.map(adj).fillna(0) != 0).sum()),
                                       'mae_base': float(np.mean(np.abs(y - mu))), 'mae_report_path': float(np.mean(np.abs(y - mu1))),
                                       'logloss_base': ll(p_home(mu, s0, df)), 'logloss_report_path': ll(p_home(mu1, s0, df))}
            out['ol_eval'] = {'n_completed': int(len(Bc)), 'n_with_ol_listed': int((Bc.infl > 0).sum()),
                              'mean_inflation_pts2': float(Bc.infl.mean()),
                              'coverage80_base': float(np.mean(np.abs(y - mu) <= q80 * s0)),
                              'coverage80_ol': float(np.mean(np.abs(y - mu) <= q80 * s1)),
                              'logloss_base': ll(p_home(mu, s0, df)), 'logloss_ol': ll(p_home(mu, s1, df)),
                              'note': 'n is tiny; the OL prior is NOT_ESTIMATED and stays research'}
    _dump('live_%d.json' % season, out)
    return out


# ================================================================ report
def _f(x, d=3, sign=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return '—'
    return ('%+.' + str(d) + 'f' if sign else '%.' + str(d) + 'f') % x


def _ci(c, d=3):
    return '[%s, %s]' % (_f(c[0], d, True), _f(c[1], d, True)) if c else '—'


def md_backtest(res, title):
    """Markdown rows: variant x set with n, MAE / RMSE / bias / log loss for BASE and the variant, deltas + CIs."""
    out = ['| %s | set | n | MAE base | MAE var | RMSE base | RMSE var | bias base | bias var | LL base | LL var '
           '| dMAE [95%% CI] | dRMSE [95%% CI] | dLL [95%% CI] |' % title, '|' + '---|' * 14]
    for name, v in res['variants'].items():
        for setn in ('unit_change_games', 'no_change_games', 'all_games'):
            r = v[setn]
            b, x = r['base'], r['variant']
            out.append('| +%s | %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s %s | %s %s | %s %s |' % (
                name, setn.replace('_games', '').replace('_', ' '), b['n'], _f(b['mae']), _f(x['mae']), _f(b['rmse']),
                _f(x['rmse']), _f(b['bias'], 2, True), _f(x['bias'], 2, True), _f(b.get('logloss'), 4),
                _f(x.get('logloss'), 4), _f(r.get('d_mae'), 4, True), _ci(r.get('d_mae_ci'), 4),
                _f(r.get('d_rmse'), 4, True), _ci(r.get('d_rmse_ci'), 4), _f(r.get('d_logloss'), 5, True),
                _ci(r.get('d_logloss_ci'), 5)))
    return '\n'.join(out)


def md_betas(res):
    out = ['| variant | unit | ' + ' | '.join(str(S) for S in res['seasons']) + ' |',
           '|' + '---|' * (2 + len(res['seasons']))]
    for name, v in res['variants'].items():
        for u in v['units']:
            cells = []
            for S in res['seasons']:
                b = v['betas'][str(S)] if str(S) in v['betas'] else v['betas'][S]
                cells.append('%s %s' % (_f(b[u]['beta'], 2, True), _ci(b[u]['ci'], 2)))
            out.append('| +%s | %s | %s |' % (name, u, ' | '.join(cells)))
    return '\n'.join(out)


def markdown(which=('dev',)):
    """Every table of UNITS.md from the JSON outputs."""
    parts = []
    c = V.constants()
    parts.append('### constants\n| component | k [95% CI] | sigma2 | tau2 [95% CI] | split-half r (n, min/half) | '
                 'repl [95% CI] (n player-seasons) | starter-slot mean | mu | rho stay [CI] (n) | rho transfer [CI] (n) | seasons |')
    parts.append('|' + '---|' * 11)
    for k_, x in c['components'].items():
        if not x.get('estimated'):
            parts.append('| %s | not estimated: %s |' % (k_, x.get('reason')))
            continue
        ps = x['persistence']
        parts.append('| %s | %s %s | %s | %s %s | %s (%d, %d) | %s %s (%d) | %s | %s | %s %s (%d) | %s %s (%d) | %s |' % (
            k_, _f(x['k'], 1), _ci(x['k_ci'], 1), _f(x['sigma2'], 4), _f(x['tau2'], 5), _ci(x['tau2_ci'], 5),
            _f(x['split_half_r'], 3), x['split_half_r_n'], x['split_half_r_min_exposure_per_half'],
            _f(x['repl'], 4, True), _ci(x['repl_ci'], 4), x['repl_n_player_seasons'], _f(x['starter_slot_mean'], 4, True),
            _f(x['mu_pop'], 4, True), _f(ps['stay'].get('rho'), 3), _ci(ps['stay'].get('rho_ci'), 3), ps['stay']['n'],
            _f(ps['transfer'].get('rho'), 3), _ci(ps['transfer'].get('rho_ci'), 3), ps['transfer']['n'],
            '%d-%d' % (min(x['seasons']), max(x['seasons']))))
    for w in which:
        f = os.path.join(out_dir(), 'backtest_%s.json' % w)
        if not os.path.exists(f):
            continue
        r = json.load(open(f))
        for k_ in DELTA_VARIANTS:
            if k_ in r:
                parts.append('### %s — %s deltas\n' % (w, k_) + md_backtest(r[k_], k_))
                parts.append('#### betas (%s, %s)\n' % (w, k_) + md_betas(r[k_]))
    return '\n\n'.join(parts)


# ================================================================ drivers
def run_dev():
    t0 = time.time()
    c = V.constants()
    print('[constants] %s (%.0fs)' % (c['signature'], time.time() - t0), flush=True)
    B = load_base(TRAIN0 + DEV)
    for S in TRAIN0 + DEV:
        season_panel(S, B)
    lam = estimate_lambda(DEV)
    print('[lambda]', json.dumps(ids.clean(lam))[:300], flush=True)
    G = game_frame(TRAIN0 + DEV, lam['lambda'])
    G.to_parquet(os.path.join(out_dir(), 'games_dev.parquet'), index=False)
    res = {k: evaluate(G, DEV, delta_variant=k) for k in DELTA_VARIANTS}
    _dump('backtest_dev.json', res)
    _dump('ablation_dev.json', {vb: ablation(G, DEV, value=vb) for vb in ('', '_use')})
    _dump('multi_absence_dev.json', {vb: multi_absence(G, DEV, value=vb) for vb in ('', '_use')})
    _dump('returning_production_dev.json', returning_production(DEV))
    absence_beta_fit(G)
    _dump('prereg_units.json', prereg(res))
    print('[dev] done %.0fs' % (time.time() - t0), flush=True)
    return res


def prereg(res):
    """The recommendation fixed on dev BEFORE the holdout is scored: a unit (variant) is recommended for
    the challenger only if it improves or preserves accuracy on ordinary (no-change) games (d_mae <= 0.005
    and d_logloss <= 0.0005) AND improves unit-change games with a d_mae CI entirely below 0 -- with the
    PREGAME deltas (the only kind computable before a report); the oracle is the upper bound."""
    out = {'rule': prereg.__doc__.split('the challenger')[1].strip() if prereg.__doc__ else '', 'decisions': {}}
    for vb in ('', '_use'):
        for name in VARIANT_UNITS:
            out['decisions'][name + vb] = _decide(res, name, vb)
    # the REPORT-PATH candidate (added after the first dev pass showed the efficiency value and the anchored
    # deltas carry no signal; disclosed in UNITS.md): known absences only, usage-revealed value, SKILL units.
    # No historical report exists, so its evidence is the ORACLE (hindsight absences = a perfect report):
    # recommended for the game-day report path only if the oracle passes the same two conditions.
    o = res['oracle_naive_use']['variants']['SKILL']
    ordinary, chg = o['no_change_games'], o['unit_change_games']
    keep_ord = ordinary.get('d_mae', 1) <= 0.005 and ordinary.get('d_logloss', 0) <= 0.0005
    better = chg.get('d_mae_ci', [0, 0])[1] < 0
    out['decisions']['SKILL_report_absence_use'] = {
        'value': 'usage-revealed', 'delta': 'known absences only (report path)', 'evidence': 'oracle',
        'recommend': bool(keep_ord and better), 'ordinary_ok': bool(keep_ord), 'change_improved_ci_below_0': bool(better),
        'oracle_change_d_mae': chg.get('d_mae'), 'oracle_change_d_mae_ci': chg.get('d_mae_ci'),
        'oracle_change_d_rmse_ci': chg.get('d_rmse_ci'), 'oracle_ordinary_d_mae': ordinary.get('d_mae'),
        'oracle_all_d_mae': o['all_games'].get('d_mae'), 'oracle_all_d_mae_ci': o['all_games'].get('d_mae_ci')}
    out['fixed_at'] = ids.ts(pd.Timestamp.now(tz='UTC'))
    return out


def absence_beta_fit(G):
    """The report-path candidate's betas, fitted once on the oracle absences of 2014-2023 (usage-revealed
    value, known-absence delta) and frozen: the holdout and the live engine use exactly these."""
    train = G.season.le(max(DEV)).values
    beta, cov, n = fit_beta(G, VARIANT_UNITS['SKILL'], 'oracle_naive_use', train)
    out = {'betas': {u: {'beta': float(beta[i]), 'ci': [float(beta[i] - 1.96 * np.sqrt(cov[i, i])),
                                                        float(beta[i] + 1.96 * np.sqrt(cov[i, i]))]}
                     for i, u in enumerate(VARIANT_UNITS['SKILL'])},
           'n_train': n, 'train_seasons': [int(G.season.min()), max(DEV)], 'variant': 'oracle_naive_use',
           'units': 'points per (share x events per game) of usage lost at the healthy share'}
    _dump('absence_beta.json', out)
    return out


def _decide(res, name, vb):
    """One prereg decision: pregame deltas of value basis vb ('' efficiency, '_use' usage-revealed)."""
    o = res['pregame' + vb]['variants'][name]
    ordinary = o['no_change_games']
    chg = o['unit_change_games']
    keep_ord = ordinary.get('d_mae', 1) <= 0.005 and ordinary.get('d_logloss', 0) <= 0.0005
    better = chg.get('d_mae_ci', [0, 0])[1] < 0
    orc = res['oracle' + vb]['variants'][name]['unit_change_games']
    return {'value': 'usage-revealed' if vb else 'efficiency', 'recommend': bool(keep_ord and better),
            'ordinary_ok': bool(keep_ord), 'change_improved_ci_below_0': bool(better),
            'pregame_change_d_mae': chg.get('d_mae'), 'pregame_change_d_mae_ci': chg.get('d_mae_ci'),
            'pregame_ordinary_d_mae': ordinary.get('d_mae'), 'pregame_ordinary_d_logloss': ordinary.get('d_logloss'),
            'oracle_change_d_mae': orc.get('d_mae'), 'oracle_change_d_mae_ci': orc.get('d_mae_ci')}


def run_holdout(rescore=False):
    f = os.path.join(out_dir(), 'backtest_holdout.json')
    if os.path.exists(f) and not rescore:
        raise SystemExit('the holdout was already scored (%s); it is scored ONCE' % f)
    if not os.path.exists(os.path.join(out_dir(), 'prereg_units.json')):
        raise SystemExit('run --dev first: the recommendation must be fixed on dev before the holdout is scored')
    lam = UN.lambda_estimate()['lambda']
    B = load_base(TRAIN0 + DEV + HOLDOUT)
    for S in HOLDOUT:
        season_panel(S, B)
    G = game_frame(TRAIN0 + DEV + HOLDOUT, lam)
    G[G.season.isin(HOLDOUT)].to_parquet(os.path.join(out_dir(), 'games_holdout.parquet'), index=False)
    res = {k: evaluate(G, HOLDOUT, frozen_through=max(DEV), delta_variant=k)
           for k in ('oracle', 'pregame', 'oracle_use', 'pregame_use', 'oracle_naive_use')}
    res['ablation'] = {vb or 'efficiency': ablation_holdout(G, vb) for vb in ('', '_use')}
    res['scored_at'] = ids.ts(pd.Timestamp.now(tz='UTC'))
    _dump('backtest_holdout.json', res)
    return res


def ablation_holdout(G, value=''):
    """The double-count ablation on the holdout (betas frozen on 2014-2023)."""
    m = G.season.isin(HOLDOUT)
    out = {}
    for k in ('oracle', 'oracle_naive'):
        pred, _ = walk_forward(G, VARIANT_UNITS['SKILL'], k + value, HOLDOUT, frozen_through=max(DEV))
        out[k] = pred
    rows = []
    for side, s in (('h', 1.0), ('a', -1.0)):
        for u in ('RB', 'WR_TE'):
            c = '%s_n_absent_in_season__%s' % (side, u)
            mm = m & (G[c] > 0)
            g = G[mm]
            rows.append(pd.DataFrame({'r': s * (g.margin - g.base).values, 'len': g['%s_max_absence_len__%s' % (side, u)].values,
                                      'd_base': g['%s_d_oracle%s__%s' % (side, value, u)].values,
                                      'd_naive': g['%s_d_oracle_naive%s__%s' % (side, value, u)].values,
                                      'e_b': np.abs(g.base - g.margin).values, 'e_o': np.abs(out['oracle'][mm] - g.margin).values,
                                      'e_n': np.abs(out['oracle_naive'][mm] - g.margin).values}))
    A = pd.concat(rows, ignore_index=True)
    A['bucket'] = np.where(A.len >= 3, '3+', A.len.fillna(1).astype(int).astype(str))
    return {b: {'n': int(len(g)), 'mean_r': float(g.r.mean()), 'mean_d_baseline': float(g.d_base.mean()),
                'mean_d_naive': float(g.d_naive.mean()), 'mae_base': float(g.e_b.mean()),
                'mae_baseline_delta': float(g.e_o.mean()), 'mae_naive_delta': float(g.e_n.mean())}
            for b, g in A.groupby('bucket')}


def main(argv=None):
    ap = argparse.ArgumentParser()
    for a in ('dev', 'pvar', 'reanchor', 'live', 'all', 'holdout', 'rescore_holdout', 'report'):
        ap.add_argument('--' + a.replace('_', '-'), action='store_true')
    a = ap.parse_args(argv)
    if a.dev or a.all:
        run_dev()
    if a.pvar or a.all:
        r = pvar_table(2025)
        print('[pvar]', {g: (v.get('n'), v.get('top', [{}])[0].get('name') if v.get('top') else None)
                         for g, v in r['groups'].items()}, flush=True)
    if a.reanchor or a.all:
        print('[reanchor]', json.dumps(ids.clean(reanchor_example()))[:600], flush=True)
    if a.live or a.all:
        print('[live]', json.dumps(ids.clean(live_2026()))[:800], flush=True)
    if a.holdout:
        r = run_holdout(rescore=a.rescore_holdout)
        print('[holdout] written', flush=True)
    if a.report:
        print(markdown(('dev', 'holdout')))


if __name__ == '__main__':
    main(sys.argv[1:])
