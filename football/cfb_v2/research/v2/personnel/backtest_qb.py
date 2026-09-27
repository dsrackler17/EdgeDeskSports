"""QB personnel backtests (docs/cfb-personnel/QB.md).

    python3 -m v2.personnel.backtest_qb [--dev] [--holdout] [--live] [--pvar] [--estimates] [--audit] [--all]

  reproduce     refit the V2.1 stage-7 walk-forward (walkforward.run on the V2.1 snapshot rows) and
                prove it reproduces the V2.1 backtest predictions (max |diff|) before anything changes
  oracle        games where the ACTUAL starter (the passer on the team's first dropback -- post-kickoff
                knowledge standing in for a pregame announcement: an ORACLE, an UPPER BOUND on what an
                announcement is worth) differs from V2's expected starter: rebuild that team's QB columns
                with the actual starter's point-in-time rating (games before the freeze) and re-predict
                with the SAME season-S walk-forward fits (models fitted on seasons < S only; the
                training rows are untouched). DEV 2016-2023; the holdout 2024-2025 once, separately.
  live          2026: games whose expected starter the official reports changed, (a) with reports
                published before the Tuesday 12:00 UTC freeze, (b) before kickoff (a game-day refresh)
  pvar          QB points above replacement per game for the 2025 FBS starters
  estimates     replacement level + spread, transfer persistence (dev), written with CIs
  audit         the rating-baseline mismatch (double-count protection) on dev seasons

Outputs: out/personnel/qb/*.json|parquet. No market data is read anywhere in this module.
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import models as MD
from .. import walkforward as WF
from . import lineup as LU
from . import qb as PQ

DEV = list(C.DEV_SEASONS)
HOLDOUT = list(C.HOLDOUT_SEASONS)
N_BOOT = 2000


def out_file(*parts):
    return common.out_path('personnel', 'qb', *parts)


# =============================================================== the V2.1 run
def v21_dir():
    """The output directory holding the V2.1 (production) walk-forward: report/backtest.json with
    model_version == C.PRODUCTION_MODEL_VERSION and feature_version == C.FEATURE_VERSION.
    CFB_V2_OUT first, then CFB_V2_WF_DIR, then the sibling out_h (the hardened build)."""
    cands = [C.OUT, os.environ.get('CFB_V2_WF_DIR'), os.path.join(os.path.dirname(os.path.abspath(C.OUT)), 'out_h')]
    seen = []
    for d in cands:
        if not d or d in seen:
            continue
        seen.append(d)
        f = os.path.join(d, 'report', 'backtest.json')
        if not os.path.exists(f):
            continue
        r = json.load(open(f))
        if r.get('model_version') == C.PRODUCTION_MODEL_VERSION and r.get('feature_version') == C.FEATURE_VERSION \
                and os.path.exists(os.path.join(d, 'stage7', 'backtest_predictions.parquet')):
            return d
    raise FileNotFoundError('no V2.1 walk-forward output (%s, %s) in %s'
                            % (C.PRODUCTION_MODEL_VERSION, C.FEATURE_VERSION, seen))


def load_wf(d=None):
    d = d or v21_dir()
    X = pd.read_parquet(os.path.join(d, 'stage5', 'cfb_model_training_snapshots.parquet'))
    M = pd.read_parquet(os.path.join(d, 'stage7', 'backtest_predictions.parquet'))
    for nm, F in (('stage5', X), ('stage7', M)):
        if 'feature_version' in F and set(F.feature_version.dropna().unique()) != {C.FEATURE_VERSION}:
            raise AssertionError('%s/%s rows are not %s: %s' % (d, nm, C.FEATURE_VERSION,
                                                              sorted(F.feature_version.dropna().unique())))
    fam = json.load(open(os.path.join(d, 'report', 'selected_families.json')))
    return X, M, fam, d


def _maxdiff(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    nan_mis = int(np.sum(np.isnan(a) != np.isnan(b)))
    ok = ~np.isnan(a) & ~np.isnan(b)
    return (float(np.max(np.abs(a[ok] - b[ok]))) if ok.any() else 0.0), nan_mis


def reproduce(X=None, M=None, fam=None, d=None):
    """Refit stage 7 exactly as pipeline.modeling does and compare with the stored predictions."""
    if X is None:
        X, M, fam, d = load_wf()
    seasons = list(range(C.FIRST_OOF_SEASON, C.LIVE_SEASON + 1))
    D, W, unc, fitted = WF.run(X, seasons, fam['C'], fam['D'], verbose=False)
    m = D[['game_id']].join(D[['ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm']]) \
        .merge(M[['game_id', 'ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm']], on='game_id',
               suffixes=('', '_stored'))
    rep = {'wf_dir': d, 'n_rows': int(len(D)), 'n_matched': int(len(m)), 'max_abs_diff': {}, 'nan_mismatch': {}}
    for c in ('ens_pred', 'sigma', 'p_home_raw', 'pred_C_ridge', 'pred_D_gbm'):
        rep['max_abs_diff'][c], rep['nan_mismatch'][c] = _maxdiff(m[c], m[c + '_stored'])
    # any other stage-7 build in view (the local out/ is the v2.0.0 / fv1 build) is reported as such
    others = {os.path.abspath(C.OUT), os.path.join(os.path.dirname(os.path.abspath(C.OUT)), 'out')}
    for od in sorted(others - {os.path.abspath(d)}):
        lf = os.path.join(od, 'stage7', 'backtest_predictions.parquet')
        if not os.path.exists(lf):
            continue
        L = pd.read_parquet(lf, columns=['game_id', 'ens_pred'])
        br = os.path.join(od, 'report', 'backtest.json')
        mv = json.load(open(br)).get('model_version') if os.path.exists(br) else None
        fv = json.load(open(br)).get('feature_version') if os.path.exists(br) else None
        ml = D[['game_id', 'ens_pred']].merge(L, on='game_id', suffixes=('', '_local'))
        rep.setdefault('other_stage7_builds', []).append(
            {'path': lf, 'model_version': mv, 'feature_version': fv,
             'max_abs_diff_ens_pred': _maxdiff(ml.ens_pred, ml.ens_pred_local)[0],
             'note': 'a different model build (not V2.1): not the reproduction target'})
    rep['exact'] = all(v < 1e-9 for v in rep['max_abs_diff'].values()) and not any(rep['nan_mismatch'].values())
    return rep, (D, W, unc, fitted)


def predict_fitted(Xs, S, fitted, W, unc):
    """Season S's walk-forward prediction for rows Xs, from the fits walkforward.run made for S
    (submodels on seasons < S, the equal-weight stack, the sigma model and t fitted on OOF rows of
    seasons < S) -- the same arithmetic as walkforward.run, applied to (possibly modified) rows."""
    Xd = MD.add_derived(Xs)
    ms, tot = fitted[S]
    P = WF.predict_submodels(ms, tot, Xd)
    D = Xd.join(P)
    subset = list(W[S].keys())
    w = np.array([W[S][k] for k in subset])
    D['ens_sd'] = D[['pred_' + k for k in WF.SUB]].std(axis=1)
    D['ens_pred'] = D[['pred_' + k for k in subset]].values @ w
    u = unc.get(S)
    if u is None:
        D['sigma'] = np.nan
        D['p_home_raw'] = np.nan
        return D
    Z = WF.sigma_design(D, u['sigma_fill'])
    mu = pd.Series(u['sigma_mu'])[WF.SIGMA_COLS]
    sd = pd.Series(u['sigma_sd'])[WF.SIGMA_COLS]
    b = np.array([u['sigma_coef']['intercept']] + [u['sigma_coef'][c] for c in WF.SIGMA_COLS])
    Aa = np.column_stack([np.ones(len(Z)), ((Z - mu) / sd).values])
    D['sigma'] = np.sqrt(np.exp(Aa @ b))
    D['p_home_raw'] = 1.0 - WF.t_cdf(-D.ens_pred.values / D.sigma.values, u['t_df'])
    return D


# ================================================================== oracle
def actual_starters(S):
    """(game_id, team_id) -> the passer on the team's first dropback (V2 stage 1's starter flag)."""
    qs = PQ.season_rows(S)
    st = qs[qs.starter].sort_values(['game_id', 'team_id', 'first_play'], kind='mergesort') \
        .drop_duplicates(['game_id', 'team_id'])
    return {(int(g), int(t)): int(q) for g, t, q in zip(st.game_id, st.team_id, st.qb_id)}


def team_db_per_game(S):
    return PQ.team_db_per_game(S, LU.DEFAULT_DB_PER_GAME)


def oracle_rows(X, seasons):
    """X rows of `seasons` with the actual starter's QB columns where he differs from V2's expected
    starter; plus one flag row per game. Point in time: the actual starter's rating, dropbacks and
    starts are those at the game's freeze (games kicked off before it).

    Also the lineup delta in points used by the points layer:
        d_pts(team) = (rating_actual - rating_expected) x team non-garbage dropbacks per game before T
        d_pts(game) = d_pts(home) - d_pts(away)"""
    Xs = X[X.season.isin(seasons)].copy()
    flags = []
    for S in seasons:
        act = actual_starters(S)
        dbpg = team_db_per_game(S)
        R, _ = PQ.season_ratings(S)
        rat_cache = {}
        sub = Xs[Xs.season.eq(S)]
        for idx, r in sub.iterrows():
            T = pd.Timestamp(r.prediction_ts)
            fl = {'game_id': int(r.game_id), 'season': S, 'week': int(r.week)}
            changed = False
            for side, pre, tid in (('home', 'h_', int(r.home_id)), ('away', 'a_', int(r.away_id))):
                a = act.get((int(r.game_id), tid))
                miss = r.get(pre + 'qb_missing', 1.0)
                e = None if (pd.isna(miss) or miss == 1.0 or pd.isna(r.get(pre + 'qb_id'))) else int(r[pre + 'qb_id'])
                fl[side + '_expected'] = e
                fl[side + '_actual'] = a
                fl[side + '_v2_missing'] = e is None
                ident = e is not None and a is not None and e > PQ.MIN_VALID_ID and a > PQ.MIN_VALID_ID
                # a placeholder ('TEAM') passer on either side: the starter is not identified -> no rebuild
                fl[side + '_unidentified'] = bool(e is not None and a is not None and a != e and not ident)
                fl[side + '_change'] = bool(ident and a != e)
                fl[side + '_first_start'] = False
                fl[side + '_actual_rating'] = np.nan
                if fl[side + '_change']:
                    if T not in rat_cache:
                        rat_cache[T] = PQ.ratings_at(S, T, R)
                    rat = rat_cache[T]
                    ctx = PQ.team_context(S, T, tid, rat)
                    assert ctx['v2_starter'] == e, ('context disagrees with V2', S, T, tid, ctx['v2_starter'], e)
                    f = PQ.side_features(ctx, a, rat)
                    for c in PQ.QB_SIDE_COLS:
                        Xs.at[idx, pre + c] = f.get(c, np.nan)
                    fl[side + '_first_start'] = bool(f['qb_exp_starts'] == 0)
                    fl[side + '_actual_rating'] = f['qb_exp_rating']
                    fl[side + '_expected_rating'] = float(r[pre + 'qb_exp_rating'])
                    fl[side + '_actual_career_db'] = float(np.expm1(f['qb_exp_db_log']))
                    fl[side + '_db_per_game'] = dbpg(tid, T)
                    fl[side + '_d_pts'] = (f['qb_exp_rating'] - float(r[pre + 'qb_exp_rating'])) * fl[side + '_db_per_game']
                    changed = True
            fl['qb_change'] = changed
            fl['d_pts'] = fl.get('home_d_pts', 0.0) - fl.get('away_d_pts', 0.0)
            fl['first_start'] = fl['home_first_start'] or fl['away_first_start']
            flags.append(fl)
    Fl = pd.DataFrame(flags)
    ch = Xs.index[Xs.game_id.isin(Fl[Fl.qb_change].game_id)]
    LU.game_qb_columns(Xs, ch)
    return Xs, Fl


def _metrics(y, pred, p):
    e = pred - y
    out = {'mae': float(np.mean(np.abs(e))), 'rmse': float(np.sqrt(np.mean(e ** 2))), 'bias': float(np.mean(e))}
    ok = ~np.isnan(p)
    if ok.any():
        yw = (y[ok] > 0).astype(float)
        pp = np.clip(p[ok], 1e-6, 1 - 1e-6)
        out['log_loss'] = float(-np.mean(yw * np.log(pp) + (1 - yw) * np.log(1 - pp)))
        out['brier'] = float(np.mean((pp - yw) ** 2))
    return out


def compare(df, n_boot=N_BOOT, seed=None):
    """BASE vs +QB-oracle on one game set, paired bootstrap over games (95% percentile CIs)."""
    y = df.margin.values.astype(float)
    b, o = df.ens_pred_base.values, df.ens_pred_oracle.values
    pb, po = df.p_base.values, df.p_oracle.values
    res = {'n': int(len(df)), 'n_with_prob': int(np.sum(~np.isnan(pb))),
           'base': _metrics(y, b, pb), 'oracle': _metrics(y, o, po)}
    res['delta'] = {k: res['oracle'][k] - res['base'][k] for k in res['base'] if k in res['oracle']}
    if len(df) < 5:
        return res
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    bs = {k: {'base': [], 'oracle': [], 'delta': []} for k in res['delta']}
    n = len(df)
    for _ in range(n_boot):
        i = rng.integers(0, n, n)
        mb, mo = _metrics(y[i], b[i], pb[i]), _metrics(y[i], o[i], po[i])
        for k in bs:
            if k in mb and k in mo:
                bs[k]['base'].append(mb[k]); bs[k]['oracle'].append(mo[k]); bs[k]['delta'].append(mo[k] - mb[k])
    res['ci95'] = {k: {w: tuple(float(x) for x in np.quantile(v[w], [0.025, 0.975])) for w in v if v[w]}
                   for k, v in bs.items()}
    return res


def fit_points_beta(F):
    """Points-layer slope: margin residual of the V2.1 walk-forward on the lineup delta in points,
    through the origin (no change -> no adjustment), over QB-change games."""
    x, r = F.d_pts.values, F.resid_base.values
    return float(np.sum(x * r) / np.sum(x * x)) if np.sum(x * x) > 0 else 0.0


def oracle(seasons, wf=None, n_boot=N_BOOT, label='dev', beta_first=C.FIRST_OOF_SEASON, beta_frozen_through=None):
    """The oracle-lineup backtest on `seasons` (see the module docstring), two ways:

      artifact  rebuild the QB columns for the actual starter and re-predict with season S's
                walk-forward fits (the frozen-artifact path lineup.project runs in production)
      points    V2.1 + beta_S x d_pts, the lineup delta in points (rating change x team dropbacks per
                game), beta_S fitted on QB-change games of seasons beta_first..S-1 only (walk-forward;
                seasons 2014-2015 contribute training rows only, from the equal-weight C/D mean that
                IS the V2.1 stack). beta_frozen_through=Y: fit once on seasons <= Y and freeze (holdout).
    """
    X, M, fam, d = load_wf() if wf is None else wf
    rep, (D, W, unc, fitted) = reproduce(X, M, fam, d)
    if not rep['exact']:
        raise AssertionError('the walk-forward refit does not reproduce the V2.1 backtest: %s' % rep['max_abs_diff'])
    train_seasons = list(range(beta_first, max(seasons)))
    Xo, Fl = oracle_rows(X, sorted(set(seasons) | set(train_seasons)))
    # V2.1 residuals for the points-layer fit (C/D equal mean == ens_pred wherever the stack exists)
    Dm = D[['game_id', 'season', 'margin', 'status', 'fcs_game']].copy()
    Dm['base_mean'] = D[['pred_' + k for k in WF.SUB]].mean(axis=1)
    Fz = Fl.merge(Dm, on=['game_id', 'season'])
    Fz = Fz[Fz.qb_change & Fz.status.eq('FINAL') & ~Fz.fcs_game.astype(bool) & Fz.margin.notna()]
    Fz = Fz.assign(resid_base=Fz.margin - Fz.base_mean)
    betas = {}
    rows = []
    dev_tr = Fz[Fz.season.between(beta_first, max(C.DEV_SEASONS))]
    frozen = None
    if set(dev_tr.season.unique()) >= set(C.DEV_SEASONS):
        rng = np.random.default_rng(C.SEED)
        bb = [fit_points_beta(dev_tr.iloc[rng.integers(0, len(dev_tr), len(dev_tr))]) for _ in range(N_BOOT)]
        frozen = {'beta': fit_points_beta(dev_tr), 'n_train': int(len(dev_tr)),
                  'beta_ci95': tuple(float(x) for x in np.quantile(bb, [0.025, 0.975])),
                  'train_seasons': sorted(int(x) for x in dev_tr.season.unique())}
    for S in seasons:
        if beta_frozen_through is not None:
            tr = Fz[Fz.season.between(beta_first, beta_frozen_through)]
        else:
            tr = Fz[Fz.season.between(beta_first, S - 1)]
        C.assert_dev_only(sorted(tr.season.unique())) if beta_frozen_through is not None else None
        betas[S] = {'beta': fit_points_beta(tr), 'n_train': int(len(tr)),
                    'train_seasons': [int(tr.season.min()), int(tr.season.max())] if len(tr) else None}
        m = Xo.season.eq(S)
        base = predict_fitted(X[X.season.eq(S)], S, fitted, W, unc)
        orc = predict_fitted(Xo[m], S, fitted, W, unc)
        # the unchanged-input identity inside the oracle run: base == stored V2.1 walk-forward
        chk = base[['game_id', 'ens_pred', 'sigma']].merge(M[['game_id', 'ens_pred', 'sigma']], on='game_id',
                                                           suffixes=('', '_m'))
        dmax = max(_maxdiff(chk.ens_pred, chk.ens_pred_m)[0], _maxdiff(chk.sigma, chk.sigma_m)[0])
        assert dmax < 1e-9, ('base re-prediction differs from the stored walk-forward', S, dmax)
        r = base[['game_id', 'season', 'week', 'margin', 'status', 'fcs_game', 'ens_pred', 'sigma', 'p_home_raw']] \
            .rename(columns={'ens_pred': 'ens_pred_base', 'sigma': 'sigma_base', 'p_home_raw': 'p_base'})
        o = orc[['game_id', 'ens_pred', 'sigma', 'p_home_raw']].rename(
            columns={'ens_pred': 'ens_pred_oracle', 'sigma': 'sigma_oracle', 'p_home_raw': 'p_oracle'})
        r = r.merge(o, on='game_id').merge(Fl[['game_id', 'd_pts']], on='game_id', how='left')
        r['d_pts'] = r.d_pts.fillna(0.0)
        r['ens_pred_points'] = r.ens_pred_base + betas[S]['beta'] * r.d_pts
        df = unc[S]['t_df'] if S in unc else None
        r['p_points'] = (1.0 - WF.t_cdf(-r.ens_pred_points.values / r.sigma_base.values, df)) if df else np.nan
        rows.append(r)
    P = pd.concat(rows, ignore_index=True).merge(Fl.drop(columns=['d_pts']), on=['game_id', 'season', 'week'],
                                                 how='left')
    P['in_scope'] = P.status.eq('FINAL') & ~P.fcs_game.astype(bool) & P.margin.notna() & P.ens_pred_base.notna()
    Ps = P[P.in_scope]
    res = {'label': label, 'seasons': list(seasons), 'wf_dir': d, 'reproduction': rep,
           'oracle_definition': 'actual starter = passer on the team\'s first dropback (post-kickoff knowledge); '
                                'an UPPER BOUND on the value of a pregame starter announcement',
           'scope': 'FBS vs FBS, FINAL, V2.1 prediction present (as pipeline.window_report)',
           'points_beta_by_season': betas, 'points_beta_frozen_dev_2014_2023': frozen,
           'counts': {'games_in_scope': int(len(Ps)),
                      'team_games_v2_missing (week 1: no expected starter; not rebuilt)':
                          int(Ps.home_v2_missing.sum() + Ps.away_v2_missing.sum()),
                      'team_games_with_expected_starter': int((~Ps.home_v2_missing).sum() + (~Ps.away_v2_missing).sum()),
                      'team_games_starter_changed': int(Ps.home_change.sum() + Ps.away_change.sum()),
                      'team_games_unidentified_placeholder_passer (not rebuilt)':
                          int(Ps.home_unidentified.sum() + Ps.away_unidentified.sum()),
                      'games_qb_change': int(Ps.qb_change.sum()), 'games_first_start': int(Ps.first_start.sum())},
           'sets': {}, 'sets_points': {}}
    nexp = res['counts']['team_games_with_expected_starter']
    res['counts']['v2_rule_accuracy'] = 1.0 - (res['counts']['team_games_starter_changed'] + res['counts'][
        'team_games_unidentified_placeholder_passer (not rebuilt)']) / max(nexp, 1)
    sets = {'qb_change_games': Ps[Ps.qb_change], 'first_time_starter_games': Ps[Ps.first_start],
            'all_games': Ps, 'unchanged_games': Ps[~Ps.qb_change]}
    for k, s_ in sets.items():
        res['sets'][k] = compare(s_, n_boot=n_boot)
        res['sets_points'][k] = compare(s_.assign(ens_pred_oracle=s_.ens_pred_points, p_oracle=s_.p_points),
                                        n_boot=n_boot)
    res['by_season_qb_change'] = {int(S): {'artifact': compare(Ps[Ps.qb_change & Ps.season.eq(S)], n_boot=0),
                                           'points': compare(Ps[Ps.qb_change & Ps.season.eq(S)].assign(
                                               ens_pred_oracle=lambda z: z.ens_pred_points,
                                               p_oracle=lambda z: z.p_points), n_boot=0)}
                                  for S in seasons}
    res['_D'], res['_unc'] = D, unc
    ch = Ps[Ps.qb_change]
    res['oracle_shift'] = {'artifact_mean_abs_margin_change': float((ch.ens_pred_oracle - ch.ens_pred_base).abs().mean()),
                           'artifact_p90_abs_margin_change': float((ch.ens_pred_oracle - ch.ens_pred_base).abs().quantile(0.9)),
                           'points_mean_abs_margin_change': float((ch.ens_pred_points - ch.ens_pred_base).abs().mean()),
                           'd_pts_mean_abs': float(ch.d_pts.abs().mean()), 'd_pts_p90_abs': float(ch.d_pts.abs().quantile(0.9)),
                           'artifact_response_slope_pts_per_d_pts': float(
                               np.sum(ch.d_pts * (ch.ens_pred_oracle - ch.ens_pred_base)) / np.sum(ch.d_pts ** 2))}
    return res, P


# ==================================================================== live
def live_2026(season=C.LIVE_SEASON, wf=None, A=None, gbm=None, reports=None):
    """2026: which games' expected starters the official reports changed, at the Tuesday freeze and
    at kickoff, with the scenario projections (frozen artifact, PJ.infer)."""
    from .. import predict_live as PL
    from ..weekly import project as PJ
    X, _, _, d = load_wf() if wf is None else wf
    X = X[X.season.eq(season)].copy()
    if A is None or gbm is None:
        A, gbm = PL.load_artifacts(C.PRODUCTION_MODEL_VERSION)
    ver = PJ.verify_artifact(C.PRODUCTION_MODEL_VERSION)
    reports = PQ.load_reports(season) if reports is None else reports
    rep_games = {str(r.get('game_id')) for r in reports}
    Xr = X[X.game_id.astype(str).isin(rep_games)]
    act = actual_starters(season)
    nm = PQ.names()
    R, _ = PQ.season_ratings(season)
    out = {'season': season, 'artifact': C.PRODUCTION_MODEL_VERSION, 'artifact_manifest_ok': ver['ok'],
           'wf_dir': d, 'n_report_files': len(reports),
           'n_report_files_usable': int(sum(PQ.report_is_usable(r) for r in reports)),
           'report_publication_vs_freeze': [], 'modes': {}}
    for r in reports:
        t = PQ.report_known_at(r)
        g = Xr[Xr.game_id.astype(str).eq(str(r.get('game_id')))]
        if len(g) and t is not None:
            out['report_publication_vs_freeze'].append(
                {'team': r.get('team'), 'game_id': str(r.get('game_id')), 'usable': PQ.report_is_usable(r),
                 'hours_after_freeze': round((t - pd.Timestamp(g.prediction_ts.iloc[0])).total_seconds() / 3600, 2),
                 'hours_before_kickoff': round((pd.Timestamp(g.kickoff_ts.iloc[0]) - t).total_seconds() / 3600, 2)})
    for mode in ('freeze', 'kickoff'):
        games_out, changed = [], []
        for T, gT in Xr.groupby('prediction_ts'):
            T = pd.Timestamp(T)
            rat = PQ.ratings_at(season, T, R)
            for _, g in gT.iterrows():
                now = T if mode == 'freeze' else pd.Timestamp(g.kickoff_ts) - pd.Timedelta(minutes=1)
                st = PQ.expected_starters(season, T, now, pd.DataFrame([g]), reports=reports, ratings=rat)
                ent = list(st.values())
                is_changed = any(len(e['dist']) > 1 or (e['dist'][0]['qb_id'] != e['ctx']['v2_starter'])
                                 for e in ent if not e['ctx']['missing'])
                known = [e['knowledge'] for e in ent]
                rec = {'game_id': int(g.game_id), 'week': int(g.week), 'home_team': g.home_team,
                       'away_team': g.away_team, 'kickoff': common.iso(pd.Timestamp(g.kickoff_ts).to_pydatetime()),
                       'knowledge': known, 'expected_starter_changed': bool(is_changed)}
                games_out.append(rec)
                if is_changed:
                    gl, _ = LU.project(pd.DataFrame([g]), A, gbm, st, {T: rat}, now=now)
                    gg = gl[0]
                    for side, tid in (('home', int(g.home_id)), ('away', int(g.away_id))):
                        e = st[(int(g.game_id), tid)]
                        a = act.get((int(g.game_id), tid))
                        gg.setdefault('hindsight_actual_starter', {})[side] = (
                            None if a is None else {'qb_id': a, 'name': nm.get(a) if len(nm) else None,
                                                    'label': 'post-kickoff fact, NOT an input'})
                        gg.setdefault('v2_expected_starter', {})[side] = (
                            None if e['ctx']['missing'] else {'qb_id': e['ctx']['v2_starter'],
                                                              'name': nm.get(e['ctx']['v2_starter']) if len(nm) else None})
                    changed.append(gg)
        out['modes'][mode] = {'games_with_report_file': len(games_out),
                              'games_with_usable_report_known': int(sum(any(k == 'KNOWN' for k in g['knowledge'])
                                                                        for g in games_out)),
                              'games_expected_starter_changed': len(changed), 'changed': changed}
    return out


# ==================================================================== PVAR
def pvar(season=2025):
    """Points above replacement per game for the season's FBS starters, as of its last freeze:
         PVAR = (rating - repl) x expected non-garbage dropbacks per game (his mean per start),
         SD   = dropbacks x sqrt(rating_sd^2 + repl_sd^2)   (rating posterior + replacement spread)."""
    b = PQ.base()
    G = b['G']
    R, _ = PQ.season_ratings(season)
    T = pd.Timestamp(R.prediction_ts.max())
    V = PQ.qb_values(season, T, include_prev_season=False)
    g = G[G.season.eq(season)]
    fbs = set(g[g.home_fbs.astype(bool)].home_id) | set(g[g.away_fbs.astype(bool)].away_id)
    qs = PQ.season_rows(season)
    st = qs[qs.starter & (qs.kickoff_ts < T)]
    per = st.groupby('qb_id').db_ng.mean()
    V = V[V.starts_season.ge(1) & V.team_id.isin(fbs)].copy()
    V['db_per_start'] = V.qb_id.map(per)
    V['pvar'] = V.above_repl * V.db_per_start
    V['pvar_sd'] = V.db_per_start * np.sqrt(V.rating_sd ** 2 + PQ.REPLACEMENT['sd'] ** 2)
    V['pvar_sd_rating_only'] = V.db_per_start * V.rating_sd
    prim = V.sort_values(['team_id', 'starts_season', 'db_season'], ascending=[True, False, False]) \
        .drop_duplicates('team_id')
    q = lambda s: {k: float(v) for k, v in zip(('p05', 'p25', 'p50', 'p75', 'p95'),
                                              np.quantile(s, [0.05, 0.25, 0.5, 0.75, 0.95]))}
    cols = ['qb_id', 'name', 'team_id', 'starts_season', 'rating', 'rating_sd', 'db_per_start', 'pvar', 'pvar_sd']
    res = {'season': season, 'as_of': common.iso(T.to_pydatetime()), 'replacement_mean': PQ.REPLACEMENT['mean'],
           'replacement_sd': PQ.REPLACEMENT['sd'],
           'primary_starters': {'n': int(len(prim)), 'mean': float(prim.pvar.mean()), 'sd': float(prim.pvar.std()),
                                'quantiles': q(prim.pvar), 'mean_pvar_sd': float(prim.pvar_sd.mean()),
                                'share_significantly_above_repl': float(np.mean(prim.pvar - 1.96 * prim.pvar_sd > 0)),
                                'mean_db_per_start': float(prim.db_per_start.mean())},
           'all_starters': {'n': int(len(V)), 'mean': float(V.pvar.mean()), 'sd': float(V.pvar.std()),
                            'quantiles': q(V.pvar), 'mean_pvar_sd': float(V.pvar_sd.mean())},
           'top10': prim.sort_values('pvar', ascending=False).head(10)[cols].to_dict('records'),
           'bottom10': prim.sort_values('pvar').head(10)[cols].to_dict('records')}
    return res, V


# =================================================================== audit
def baseline_audit(seasons=DEV, wf=None, n_boot=N_BOOT):
    """Double-count protection check: qb_team_rating vs the lineup the pass-offence ratings contain
    (lineup.baseline_lineup), on DEV seasons; the re-anchoring pace after a mid-season starter change;
    and whether the mismatch predicts the V2.1 walk-forward residual."""
    C.assert_dev_only(seasons)
    parts = [LU.baseline_lineup(S) for S in seasons]
    B = pd.concat(parts, ignore_index=True)
    B['week_idx'] = B.games
    res = {'seasons': list(seasons), 'n_team_freezes': int(len(B))}
    wk = B.groupby(B.games.clip(upper=12))
    res['by_games_played'] = {int(k): {'n': int(len(v)), 'pi_season_mean': float(v.pi_season.mean()),
                                       'pi_season_1param_mean': float(v.pi_season_1param.mean()),
                                       'pi_recent_mean': float(v.pi_recent.mean()),
                                       'abs_mismatch_season_mean': float(v.mismatch_season.abs().mean()),
                                       'abs_mismatch_recent_mean': float(v.mismatch_recent.abs().mean())}
                              for k, v in wk}
    pts = lambda m, dbpg: float(np.mean(np.abs(m) * dbpg))
    newq = B[~B.exp_in_prior]
    res['overall'] = {
        'pi_season_mean': float(B.pi_season.mean()), 'pi_recent_mean': float(B.pi_recent.mean()),
        'pi_approx_check_corr': float(np.corrcoef(B.pi_season, B.pi_season_1param)[0, 1]),
        'abs_mismatch_season_epa_db': float(B.mismatch_season.abs().mean()),
        'abs_mismatch_recent_epa_db': float(B.mismatch_recent.abs().mean()),
        'p90_abs_mismatch_season_epa_db': float(B.mismatch_season.abs().quantile(0.9)),
        'abs_mismatch_season_pts_per_game': pts(B.mismatch_season, B.db_per_game),
        'abs_mismatch_recent_pts_per_game': pts(B.mismatch_recent, B.db_per_game),
        'new_starter_vs_last_season': {'n': int(len(newq)),
                                       'mean_mismatch_season_epa_db': float(newq.mismatch_season.mean()),
                                       'abs_mismatch_season_epa_db': float(newq.mismatch_season.abs().mean()),
                                       'abs_mismatch_season_pts_per_game': pts(newq.mismatch_season, newq.db_per_game)},
        'returning_starter': {'n': int((B.exp_in_prior).sum()),
                              'abs_mismatch_season_epa_db': float(B[B.exp_in_prior].mismatch_season.abs().mean())}}
    # re-anchoring pace: mid-season changes to a starter who keeps the job
    ev = []
    for S in seasons:
        qs = PQ.season_rows(S)
        st = qs[qs.starter].sort_values('kickoff_ts').drop_duplicates(['game_id', 'team_id'])
        for tid, g in st.groupby('team_id'):
            seq = list(g.qb_id)
            ts = list(g.kickoff_ts)
            for j in range(2, len(seq) - 4):
                if seq[j] != seq[j - 1] and seq[j - 1] == seq[j - 2] and all(q == seq[j] for q in seq[j:j + 5]):
                    ev.append((S, int(tid), int(seq[j]), ts[j]))
    Bi = B.set_index(['season', 'team_id', 'prediction_ts'])
    pace = {k: {'qb_team_rating': [], 'season_rating': [], 'recent_rating': []} for k in range(1, 6)}
    for S, tid, q, t0 in ev:
        bt = B[(B.season == S) & (B.team_id == tid) & (B.prediction_ts > t0) & (B.exp_q == q)].sort_values('prediction_ts')
        for k, (_, r) in enumerate(bt.head(5).iterrows(), start=1):
            pace[k]['qb_team_rating'].append(r.exp_share_qb_team_rating)
            pace[k]['season_rating'].append(r.exp_weight_season)
            pace[k]['recent_rating'].append(r.exp_weight_recent)
    res['reanchoring_after_midseason_change'] = {
        'n_events': len(ev),
        'weight_on_new_starter_by_freezes_after_change': {
            k: {w: float(np.mean(v)) if v else None for w, v in d.items()} | {'n': len(d['qb_team_rating'])}
            for k, d in pace.items()}}
    # does the mismatch predict the V2.1 walk-forward residual? (dev, FBS vs FBS)
    X, M, fam, d = load_wf() if wf is None else wf
    Md = M[M.season.isin(seasons) & M.status.eq('FINAL') & ~M.fcs_game & M.margin.notna() & M.ens_pred.notna()]
    Bk = B.set_index(['prediction_ts', 'team_id'])
    hm = Bk.reindex(pd.MultiIndex.from_arrays([Md.prediction_ts, Md.home_id]))
    am = Bk.reindex(pd.MultiIndex.from_arrays([Md.prediction_ts, Md.away_id]))
    for kind in ('season', 'recent'):
        e = (hm['mismatch_' + kind].values - am['mismatch_' + kind].values)
        r = (Md.margin - Md.ens_pred).values
        ok = ~np.isnan(e)
        e, r = e[ok], r[ok]
        slope = float(np.sum(e * (r - r.mean())) / np.sum((e - e.mean()) ** 2))
        rng = np.random.default_rng(C.SEED)
        bs = []
        for _ in range(n_boot):
            i = rng.integers(0, len(e), len(e))
            ee, rr = e[i], r[i]
            bs.append(np.sum((ee - ee.mean()) * (rr - rr.mean())) / np.sum((ee - ee.mean()) ** 2))
        res['residual_check_' + kind] = {'n_games': int(len(e)), 'slope_pts_per_epa_db': slope,
                                         'slope_ci95': tuple(float(x) for x in np.quantile(bs, [0.025, 0.975])),
                                         'sd_mismatch_edge_epa_db': float(np.std(e)),
                                         'implied_pts_per_1sd': slope * float(np.std(e))}
    return res, B


# ======================================================= baseline correction
def baseline_frames(seasons):
    """lineup.baseline_lineup per season, cached under out/personnel/qb/cache (keyed like the ratings)."""
    out = []
    for S in seasons:
        f = os.path.join(PQ.cache_dir(), 'baseline_%d.parquet' % S)
        fj = f.replace('.parquet', '.json')
        sig = {'code': PQ.CODE_VERSION, 'inputs': PQ._sig(PQ._season_inputs(S) + [
            common.out_path('stage1', 'team_game_%d.parquet' % S), common.out_path('stage3', 'varcomp.json')])}
        if os.path.exists(f) and os.path.exists(fj) and json.load(open(fj)) == sig:
            out.append(pd.read_parquet(f))
            continue
        B = LU.baseline_lineup(S)
        B.to_parquet(f, index=False)
        with open(fj, 'w') as fh:
            json.dump(sig, fh)
        out.append(B)
    return pd.concat(out, ignore_index=True)


def baseline_edge(Mx, B, kind='season'):
    """Per game: mismatch(home) - mismatch(away) in EPA/dropback (0 for a team with no row: week 1)."""
    Bk = B.set_index(['prediction_ts', 'team_id'])['mismatch_' + kind]
    h = Bk.reindex(pd.MultiIndex.from_arrays([Mx.prediction_ts, Mx.home_id])).values
    a = Bk.reindex(pd.MultiIndex.from_arrays([Mx.prediction_ts, Mx.away_id])).values
    return np.nan_to_num(h) - np.nan_to_num(a)


def baseline_correction(seasons, P, D, unc, beta_first=C.FIRST_OOF_SEASON, frozen_through=None, kind='season'):
    """Candidate component: V2.1 + beta_S x baseline mismatch edge (lineup.baseline_lineup), beta_S the
    slope of the V2.1 residual on the edge over FBS games of seasons beta_first..S-1 (walk-forward),
    or frozen on seasons <= frozen_through (holdout). Pregame-computable: no announcement needed."""
    B = baseline_frames(list(range(beta_first, max(seasons) + 1)))
    Dm = D[['game_id', 'season', 'prediction_ts', 'home_id', 'away_id', 'margin', 'status', 'fcs_game']].copy()
    Dm['base_mean'] = D[['pred_' + k for k in WF.SUB]].mean(axis=1)
    Dm['edge'] = baseline_edge(Dm, B, kind)
    tr_all = Dm[Dm.status.eq('FINAL') & ~Dm.fcs_game.astype(bool) & Dm.margin.notna()]
    tr_all = tr_all.assign(r=tr_all.margin - tr_all.base_mean)
    betas = {}
    P = P.merge(Dm[['game_id', 'edge']], on='game_id', how='left')
    P['ens_pred_baseline'] = np.nan
    P['p_baseline'] = np.nan
    for S in seasons:
        hi = frozen_through if frozen_through is not None else S - 1
        tr = tr_all[tr_all.season.between(beta_first, hi)]
        if frozen_through is not None:
            C.assert_dev_only(sorted(tr.season.unique()))
        bta = float(np.sum(tr.edge * tr.r) / np.sum(tr.edge ** 2))
        betas[S] = {'beta': bta, 'n_train': int(len(tr)), 'train_seasons': [int(beta_first), int(hi)]}
        m = P.season.eq(S)
        P.loc[m, 'ens_pred_baseline'] = P.loc[m, 'ens_pred_base'] + bta * P.loc[m, 'edge']
        if S in unc:
            P.loc[m, 'p_baseline'] = 1.0 - WF.t_cdf(-P.loc[m, 'ens_pred_baseline'].values / P.loc[m, 'sigma_base'].values,
                                                    unc[S]['t_df'])
        # combined with the QB points layer (oracle starters)
        P.loc[m, 'ens_pred_combined'] = P.loc[m, 'ens_pred_points'] + bta * P.loc[m, 'edge']
        if S in unc:
            P.loc[m, 'p_combined'] = 1.0 - WF.t_cdf(-P.loc[m, 'ens_pred_combined'].values / P.loc[m, 'sigma_base'].values,
                                                    unc[S]['t_df'])
    return P, betas


def evaluate(seasons, label, wf=None, n_boot=N_BOOT, frozen=False):
    """All variants on one window: artifact (oracle QB rebuild through the frozen artifact), points
    (oracle QB points layer), baseline (pregame baseline-mismatch correction, no oracle), combined
    (points + baseline). frozen=True: every slope fitted on 2014-2023 only and frozen (holdout)."""
    res, P = oracle(seasons, wf=wf, n_boot=n_boot, label=label,
                    beta_frozen_through=max(C.DEV_SEASONS) if frozen else None)
    D, unc = res.pop('_D'), res.pop('_unc')
    P, bb = baseline_correction(seasons, P, D, unc, frozen_through=max(C.DEV_SEASONS) if frozen else None)
    res['baseline_beta_by_season'] = bb
    Ps = P[P.in_scope]
    sets = {'qb_change_games': Ps[Ps.qb_change], 'first_time_starter_games': Ps[Ps.first_start],
            'all_games': Ps, 'unchanged_games': Ps[~Ps.qb_change]}
    res['variants'] = {'artifact_oracle': res.pop('sets'), 'points_oracle': res.pop('sets_points')}
    for v, (mc, pc) in (('baseline_pregame', ('ens_pred_baseline', 'p_baseline')),
                        ('points_oracle_plus_baseline', ('ens_pred_combined', 'p_combined'))):
        res['variants'][v] = {k: compare(s_.assign(ens_pred_oracle=s_[mc], p_oracle=s_[pc]), n_boot=n_boot)
                              for k, s_ in sets.items()}
    return res, P


# ==================================================================== main
OOF_COLUMNS = ['game_id', 'season', 'week', 'window', 'qb_change', 'first_time_starter', 'pred_base', 'pred_qb',
               'sigma_base', 'sigma_qb', 'p_home_base', 'p_home_qb', 'margin']


def write_oof(wf=None):
    """The combined-comparison contract: $CFB_V2_OUT/personnel/backtest_qb_oof.parquet, one row per
    game of the V2.1 stage-7 backtest.

      pred_base / sigma_base / p_home_base   the stage-7 ens_pred / sigma / p_home_raw (identical)
      pred_qb / sigma_qb / p_home_qb         +QB, the challenger path (points layer, ORACLE starter):
                                             pred_base + beta x d_pts, sigma_qb = sigma_base; equal to
                                             base wherever the starter did not change
      pred_qb_artifact / sigma_qb_artifact / p_home_qb_artifact   the artifact-rebuild path, beside it
      qb_change          actual starter (first dropback) != V2's expected starter, both identified
      first_time_starter the actual starter had no career start before the freeze
      window             dev_2016_2023 (beta walk-forward), holdout_2024_2025 (scored once, beta frozen
                         on 2014-2023), live_2026 (played games, beta frozen), pre_stack (2014-2015:
                         V2.1 has no stacked prediction), unplayed (no outcome, no actual starter)
    Built from the dev and holdout oracle rows already written (the holdout is NOT re-scored) and a
    2026 oracle run on the games played so far."""
    X, M, fam, d = load_wf() if wf is None else wf
    f_dev, f_ho = out_file('oracle_dev_rows.parquet'), out_file('oracle_holdout_rows.parquet')
    if not (os.path.exists(f_dev) and os.path.exists(f_ho)):
        raise FileNotFoundError('run --dev and (once) --holdout first: %s, %s' % (f_dev, f_ho))
    res26, P26 = oracle([C.LIVE_SEASON], wf=(X, M, fam, d), n_boot=0, label='live_2026',
                        beta_frozen_through=max(C.DEV_SEASONS))
    parts = [pd.read_parquet(f_dev).assign(window='dev_2016_2023'),
             pd.read_parquet(f_ho).assign(window='holdout_2024_2025'), P26.assign(window='live_2026')]
    P = pd.concat(parts, ignore_index=True)
    O = pd.DataFrame({'game_id': P.game_id, 'season': P.season, 'week': P.week, 'window': P.window,
                      'qb_change': P.qb_change.fillna(False).astype(bool),
                      'first_time_starter': P.first_start.fillna(False).astype(bool),
                      'pred_base': P.ens_pred_base, 'pred_qb': P.ens_pred_points,
                      'sigma_base': P.sigma_base, 'sigma_qb': P.sigma_base,
                      'p_home_base': P.p_base, 'p_home_qb': P.p_points, 'margin': P.margin,
                      'pred_qb_artifact': P.ens_pred_oracle, 'sigma_qb_artifact': P.sigma_oracle,
                      'p_home_qb_artifact': P.p_oracle, 'd_pts': P.d_pts})
    O.loc[O.window.eq('live_2026') & O.margin.isna(), 'window'] = 'unplayed'
    rest = M[~M.game_id.isin(O.game_id)]
    R = pd.DataFrame({'game_id': rest.game_id, 'season': rest.season, 'week': rest.week,
                      'window': np.where(rest.season < min(C.DEV_SEASONS), 'pre_stack', 'other'),
                      'qb_change': False, 'first_time_starter': False, 'pred_base': rest.ens_pred,
                      'pred_qb': rest.ens_pred, 'sigma_base': rest.sigma, 'sigma_qb': rest.sigma,
                      'p_home_base': rest.p_home_raw, 'p_home_qb': rest.p_home_raw, 'margin': rest.margin,
                      'pred_qb_artifact': rest.ens_pred, 'sigma_qb_artifact': rest.sigma,
                      'p_home_qb_artifact': rest.p_home_raw, 'd_pts': 0.0})
    O = pd.concat([O, R], ignore_index=True).sort_values(['season', 'week', 'game_id']).reset_index(drop=True)
    # contract checks: one row per stage-7 game; base == stage 7; +QB == base where nothing changed
    chk = O.merge(M[['game_id', 'ens_pred', 'sigma', 'p_home_raw']], on='game_id', how='outer', indicator=True)
    assert (chk._merge == 'both').all() and len(O) == len(M) == O.game_id.nunique(), 'row set != stage 7'
    for a_, b_ in (('pred_base', 'ens_pred'), ('sigma_base', 'sigma'), ('p_home_base', 'p_home_raw')):
        assert _maxdiff(chk[a_], chk[b_])[0] < 1e-9 and _maxdiff(chk[a_], chk[b_])[1] == 0, a_
    same = ~O.qb_change
    assert _maxdiff(O.pred_qb[same], O.pred_base[same])[0] == 0.0, 'pred_qb != pred_base on unchanged games'
    f = common.out_path('personnel', 'backtest_qb_oof.parquet')
    O.to_parquet(f, index=False)
    meta = {'path': f, 'rows': int(len(O)), 'columns': list(O.columns), 'contract_columns': OOF_COLUMNS,
            'by_window': O.window.value_counts().to_dict(),
            'qb_change_by_window': O[O.qb_change].window.value_counts().to_dict(),
            'points_beta_2026': res26['points_beta_by_season'], 'rule_version': PQ.RULE_VERSION,
            'oracle': 'qb_change / pred_qb use the ACTUAL starter (post-kickoff): an upper bound on a pregame '
                      'announcement', 'wf_dir': d}
    common.write_json(common.out_path('personnel', 'backtest_qb_oof.json'), meta)
    return O, meta


def table(res):
    """Plain-text table of every variant x set: n, base vs variant MAE / RMSE / bias / log loss, delta + CI."""
    lines = ['%-28s %-26s %5s %8s %8s %8s %8s %8s %8s %8s %8s %8s %-22s %-22s' % (
        'variant', 'set', 'n', 'MAE_b', 'MAE_v', 'RMSE_b', 'RMSE_v', 'bias_b', 'bias_v', 'LL_b', 'LL_v', 'dMAE',
        'dMAE 95% CI', 'dLL 95% CI')]
    for v, sets in res['variants'].items():
        for k, c in sets.items():
            ci = c.get('ci95', {})
            f = lambda m: '[%+.4f, %+.4f]' % ci[m]['delta'] if m in ci and 'delta' in ci[m] else '-'
            lines.append('%-28s %-26s %5d %8.4f %8.4f %8.4f %8.4f %+8.4f %+8.4f %8.4f %8.4f %+8.4f %-22s %-22s' % (
                v, k, c['n'], c['base']['mae'], c['oracle']['mae'], c['base']['rmse'], c['oracle']['rmse'],
                c['base']['bias'], c['oracle']['bias'], c['base'].get('log_loss', np.nan),
                c['oracle'].get('log_loss', np.nan), c['delta']['mae'], f('mae'), f('log_loss')))
    return '\n'.join(lines)


def _dump(name, obj):
    common.write_json(out_file(name), obj)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dev', action='store_true')
    ap.add_argument('--holdout', action='store_true', help='score the holdout ONCE (written separately)')
    ap.add_argument('--live', action='store_true')
    ap.add_argument('--pvar', action='store_true')
    ap.add_argument('--estimates', action='store_true')
    ap.add_argument('--audit', action='store_true')
    ap.add_argument('--all', action='store_true', help='everything except the holdout')
    ap.add_argument('--boot', type=int, default=N_BOOT)
    ap.add_argument('--rescore-holdout', action='store_true')
    ap.add_argument('--oof', action='store_true', help='write personnel/backtest_qb_oof.parquet (the contract)')
    a = ap.parse_args()
    PQ.build_cache(list(range(min(DEV), C.LIVE_SEASON + 1)))
    wf = load_wf()
    if a.estimates or a.all:
        rep = PQ.replacement(n_boot=a.boot)
        rep['stability_dev_2014_2023'] = {k: v for k, v in PQ.replacement(tuple(range(2014, 2024)), n_boot=a.boot).items()
                                          if k in ('mean', 'sd', 'sd_raw', 'n_qb_seasons', 'mean_ci95', 'sd_ci95')}
        _dump('replacement.json', rep)
        ev = PQ.transfer_events()
        ev.to_parquet(out_file('transfer_events.parquet'), index=False)
        est = PQ.estimate_persistence(ev, n_boot=a.boot)
        ev9 = PQ.transfer_events(window=None, min_db=50)
        est['sensitivity_full_season_min50'] = {k: est9 for k, est9 in
                                                (('fit', PQ.estimate_persistence(ev9, n_boot=min(a.boot, 500))),)}
        _dump('persistence.json', est)
        print('[estimates] replacement', {k: rep[k] for k in ('mean', 'sd', 'mean_ci95', 'sd_ci95', 'n_qb_seasons')})
        print('[estimates] persistence transfer', est['transfer'], 'stay', est['stay'], 'ci', est['ci95'])
    if a.dev or a.all:
        C.assert_dev_only(DEV)
        res, P = evaluate(DEV, 'dev_2016_2023', wf=wf, n_boot=a.boot)
        _dump('oracle_dev.json', res)
        P.to_parquet(out_file('oracle_dev_rows.parquet'), index=False)
        print('[dev]', table(res))
    if a.holdout:
        f = out_file('oracle_holdout.json')
        if os.path.exists(f) and not a.rescore_holdout:
            raise SystemExit('the holdout was already scored (%s); it is scored ONCE. --rescore-holdout only '
                             'after a documented reason.' % f)
        res, P = evaluate(HOLDOUT, 'holdout_2024_2025', wf=wf, n_boot=a.boot, frozen=True)
        _dump('oracle_holdout.json', res)
        P.to_parquet(out_file('oracle_holdout_rows.parquet'), index=False)
        print('[holdout]', table(res))
    if a.audit or a.all:
        res, B = baseline_audit(DEV, wf=wf, n_boot=a.boot)
        _dump('baseline_audit.json', res)
        B.to_parquet(out_file('baseline_lineup_dev.parquet'), index=False)
        print('[audit]', json.dumps(res['overall'], indent=1))
    if a.live or a.all:
        res = live_2026(wf=wf)
        _dump('live_2026.json', res)
        print('[live 2026]', {m: {k: v for k, v in d.items() if k != 'changed'} for m, d in res['modes'].items()})
    if a.oof:
        O, meta = write_oof(wf=wf)
        print('[oof]', {k: v for k, v in meta.items() if k != 'columns'})
    if a.pvar or a.all:
        res, V = pvar(2025)
        _dump('pvar_2025.json', res)
        V.to_parquet(out_file('pvar_2025.parquet'), index=False)
        print('[pvar 2025]', res['primary_starters'])


if __name__ == '__main__':
    main()
