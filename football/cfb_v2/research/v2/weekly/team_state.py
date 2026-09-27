"""Team state on the points scale (docs/cfb-weekly/DESIGN.md, METHODS_STATE.md).

    rows, convergence, explanations = build(season, T, prev=None, ratings=None, league=None)

State updating, not retraining: the ratings are V2.1's stage-3 Gaussian
posteriors (ratings.solve / build_ratings.run), rebuilt for ONE freeze time T
with build_ratings.run(only_ts=[T]) and converted to points exactly the way
V2 converts them (snapshots.eff_pts_raw):

    points = EPA/play edge x expected plays per team

against an AVERAGE FBS team (the FBS mean of every rating at T) on a neutral
field. Nothing here feeds the frozen model; every derived quantity is
descriptive (state, uncertainty, attribution, flags).

Units: points per game. offense_mean > 0 = scores more than an average FBS
offence would against the same (average) defence; defense_mean > 0 = allows
fewer. overall = offense + defense + special teams.
"""
import numpy as np
import pandas as pd

from .. import build_ratings as BR
from .. import common
from .. import config as C
from .. import ratings as R
from . import ids
from . import qb_state as QS

STATE_RULE_VERSION = 'cfb_team_state_v1'
POINT_METRICS = ('epa', 'epa_pass', 'epa_rush', 'pass_rate', 'plays_pg', 'st_net')
PR_CLIP = (0.2, 0.8)            # expected pass rate clip, as snapshots.py
TREND_Z = 2.0                   # trend flag: |recent - season| beyond 2 SD of its null distribution
TREND_MIN_GAMES = 4
VOL_RECENT_GAMES = 4            # recent volatility window (games)
VOL_SHRINK_K = 3.0              # as ratings.residual_volatility
VOL_TREND_MIN_GAMES = 6
THIN_GAMES = 3                  # thin data: < 3 games, or the prior still > 50% of the precision
THIN_PRIOR_WEIGHT = 0.5

# Movement guardrails: the p99.5 of the weekly |overall move| (points) and of
# the SD drop 1 - sd_T/sd_prev, estimated by estimate_movement_bounds() on the
# DEV seasons 2016-2023: every consecutive pair of freezes within a season,
# from the prior-only freeze on (20,018 FBS and 12,491 FCS team-transitions).
# Pooled, and by season phase (transition index k: MOVE_BUCKETS).
# Provenance: stage-3 ratings rebuilt on 2026-09-27 with this repository's
# build_ratings (hooks off); every rebuilt ratings_<S>.parquet is byte-identical
# to the v2.1 build (out_h). sha256[:16] of ratings_<S>.parquet:
#   2016 d26bf83b55cb9de1  2017 e32311dec84f3c43  2018 9ab8d396fb2a5ab9  2019 58d06bf74dc0779e
#   2020 d7b8af475b63ce11  2021 6ca9080853ff6dd9  2022 a4b97bfe0b3f1d49  2023 8da74cd3c3a93923
# Re-derive: team_state.estimate_movement_bounds(out_dir=<an OUT with those files>).
MOVE_BOUNDS = {
    'fbs_abs_move_p995': 5.1018, 'fbs_sd_drop_p995': 0.1342,
    'fcs_abs_move_p995': 18.4158, 'fcs_sd_drop_p995': 0.3593,
    'by_bucket': {
        'fbs': {'1': {'abs_move_p995': 5.3864, 'sd_drop_p995': 0.1512},
                '2': {'abs_move_p995': 6.6137, 'sd_drop_p995': 0.161},
                '3-4': {'abs_move_p995': 5.797, 'sd_drop_p995': 0.1004},
                '5-7': {'abs_move_p995': 4.8314, 'sd_drop_p995': 0.0814},
                '8-11': {'abs_move_p995': 4.13, 'sd_drop_p995': 0.0874},
                '12-99': {'abs_move_p995': 2.8343, 'sd_drop_p995': 0.0584}},
        'fcs': {'1': {'abs_move_p995': 8.7355, 'sd_drop_p995': 0.2831},
                '2': {'abs_move_p995': 28.9528, 'sd_drop_p995': 0.4201},
                '3-4': {'abs_move_p995': 22.6425, 'sd_drop_p995': 0.3626},
                '5-7': {'abs_move_p995': 16.1028, 'sd_drop_p995': 0.3396},
                '8-11': {'abs_move_p995': 6.31, 'sd_drop_p995': 0.2541},
                '12-99': {'abs_move_p995': 6.8536, 'sd_drop_p995': 0.2186}}},
    'provenance': {'seasons': list(range(2016, 2024)), 'quantile': 0.995, 'n_fbs': 20018, 'n_fcs': 12491,
                   'estimated': '2026-09-27', 'function': 'team_state.estimate_movement_bounds',
                   'ratings_sha256_16': {2016: 'd26bf83b55cb9de1', 2017: 'e32311dec84f3c43',
                                         2018: '9ab8d396fb2a5ab9', 2019: '58d06bf74dc0779e',
                                         2020: 'd7b8af475b63ce11', 2021: '6ca9080853ff6dd9',
                                         2022: 'a4b97bfe0b3f1d49', 2023: '8da74cd3c3a93923'}},
}

# prior-mean components (build_prior's ridge design columns, grouped)
PRIOR_GROUPS = {
    'program_history': ('lag1', 'lag2'),
    'returning_production': ('ret', 'lag1_ret'),
    'roster_talent': ('talent_z',),
    'coaching_change': ('hc_new', 'lag1_hc'),
    'unit_change': ('unit_change',),
    'missing_data': ('m_lag1', 'm_lag2', 'm_ret', 'm_talent', 'm_coach'),
}

# why an optional numeric can be null (DESIGN: finite, or null with a reason)
OPTIONAL_NULL_REASONS = {
    'recent_minus_season_sd': 'no game before T',
    'offense_trend_z': 'no game before T, or the recent/season difference has no sampling variance yet',
    'defense_trend_z': 'no game before T, or the recent/season difference has no sampling variance yet',
    'volatility_recent': 'fewer than 2 residuals in the recent window',
    'volatility_trend_z': 'fewer than 2 residuals in the recent window',
    'hfa_team_evidence_pts': 'needs at least one home and one away (non-neutral) game',
    'hfa_team_evidence_raw_pts': 'needs at least one home and one away (non-neutral) game',
    'hfa_team_evidence_n_home': 'no game before T',
    'qb_offense_var_inflation_pts2': 'no QB rows for this team before T',
    'prior_weight_offense': 'metric not rated',
    'prior_weight_defense': 'metric not rated',
}

_CTX = {}


def _reset():
    """Drop every in-process cache (tests)."""
    _CTX.clear()
    QS._CACHE.clear()


def _br_ctx():
    return _CTX.setdefault('br', {})


def _utc(T):
    T = pd.Timestamp(T)
    return T.tz_localize('UTC') if T.tzinfo is None else T.tz_convert('UTC')


def _games():
    if 'G' not in _CTX:
        _CTX['G'] = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    return _CTX['G']


def freezes(season):
    """Every prediction timestamp of a season, sorted."""
    G = _games()
    return sorted(pd.Timestamp(x) for x in G.loc[G.season.eq(season), 'prediction_ts'].unique())


def previous_freeze(season, T):
    before = [x for x in freezes(season) if x < T]
    return before[-1] if before else None


# ================================================== stage 8: the V2 solve
def opponent_adjust(season, T, warm=None, diag=True):
    """V2's stage-3 solve at one freeze T (build_ratings.run with only_ts),
    with the convergence record. Returns a dict: ratings, league (frames at T),
    convergence, priors, explain, fbs (set), setup (the cached build context)."""
    T = _utc(T)
    key = ('oa', int(season), T, bool(diag), warm is not None, C.OUT, C.DATA)
    if key in _CTX:
        return _copy_oa(_CTX[key])
    d = [] if diag else None
    ex = {}
    fr = BR.run(seasons_out=[season], only_ts=[T], write=False, diag=d, warm=warm, explain=ex,
                ctx=_br_ctx(), return_frames=True, verbose=False)
    out = {'ratings': fr['ratings'][season], 'league': fr['league'][season],
           'priors': fr['priors'][season], 'explain': ex, 'fbs': set(fr['fbs'].get(season, set())),
           'setup': _br_ctx()['setup'], 'varcomp': fr['varcomp'], 'typ_n': fr['typ_n']}
    out['convergence'] = convergence_summary(d, season, T, warm is not None) if diag else None
    _CTX[key] = out
    return _copy_oa(out)


def _copy_oa(o):
    """A copy safe for callers: the frames are copied, the convergence dict too."""
    c = dict(o)
    c['ratings'], c['league'] = o['ratings'].copy(), o['league'].copy()
    if o['convergence'] is not None:
        c['convergence'] = dict(o['convergence'], records=[dict(r) for r in o['convergence']['records']])
    return c


def convergence_summary(diag, season, T, warm_given=False):
    recs = [dict(r) for r in diag]
    solved = [r for r in recs if r.get('solved')]
    metrics = sorted(set(r['metric'] for r in recs))
    out = {'season': int(season), 'as_of': T, 'n_metrics': len(metrics), 'metrics': metrics,
           'n_records': len(recs), 'records': recs,
           'converged': bool(recs) and all(r['converged'] for r in recs),
           'not_converged': [(r['metric'], r['horizon']) for r in recs if not r['converged']],
           'warm_start': 'prev_week' if warm_given else 'prior_means'}
    if solved:
        out['summary'] = {
            'max_rel_residual': max(r['rel_residual'] for r in solved),
            'max_cond': max(r['cond'] for r in solved),
            'max_cond_scaled': max(r['cond_scaled'] for r in solved),
            'max_delta': max(r['delta_max_abs'] for r in solved),
            'max_cg_iters': max(r['cg_iters'] for r in solved),
            'median_cg_iters': float(np.median([r['cg_iters'] for r in solved])),
            'thresholds': {'residual': R.RESIDUAL_TOL, 'cg_tol': R.CG_TOL, 'delta': R.DELTA_TOL}}
    else:
        out['summary'] = {'note': 'no game before T: every posterior is its prior (nothing to solve)'}
    return out


# ============================================================ points scale
def wide(Rt):
    """{metric: frame indexed by team_id} from the long ratings rows of one T."""
    return {m: g.set_index('team_id') for m, g in Rt.groupby('metric')}


def league_at(Lt):
    return {r.metric: (float(r.mu), float(r.h)) for r in Lt.itertuples()}


def _fbs_mean(df, col, fb):
    return float(df.loc[df.index.intersection(fb), col].mean())


def points(W, lg, fbs, mu_fallback=None, horizon_cols=('off', 'def')):
    """Points-scale state of every team at one T (season horizon by default).

    W: wide() frames; lg: league_at(); fbs: set of FBS team ids;
    mu_fallback: {'plays_pg': mu, 'pass_rate': mu} used when the league mean
    is not identified yet (no game before T).
    SDs: delta method from off_var/def_var, each rating treated as
    independent (no covariance between a team's offence and defence, with the
    FBS mean, or across metrics) - quantified by delta_method_check()."""
    oc, dc = horizon_cols
    teams = W['epa'].index
    fb = [t for t in teams if t in fbs]

    def mu(m):
        v = lg.get(m, (np.nan, 0.0))[0]
        if not np.isfinite(v) and mu_fallback:
            v = mu_fallback.get(m, np.nan)
        return v

    pl = W['plays_pg'].reindex(teams)
    p = mu('plays_pg') + 0.5 * (pl['off'] + pl['def'] + _fbs_mean(pl, 'off', fb) + _fbs_mean(pl, 'def', fb))
    var_p = 0.25 * (pl['off_var'] + pl['def_var'])
    pr = W['pass_rate'].reindex(teams)
    pr_o_raw = mu('pass_rate') + pr['off'] + _fbs_mean(pr, 'def', fb)
    pr_d_raw = mu('pass_rate') + _fbs_mean(pr, 'off', fb) + pr['def']
    pr_o, pr_d = pr_o_raw.clip(*PR_CLIP), pr_d_raw.clip(*PR_CLIP)
    v_pr_o = pr['off_var'].where(pr_o.eq(pr_o_raw), 0.0)
    v_pr_d = pr['def_var'].where(pr_d.eq(pr_d_raw), 0.0)

    def unit(m, side, plays, var_plays, sign):
        f = W[m].reindex(teams)
        col = oc if side == 'off' else dc
        e = sign * (f[col] - _fbs_mean(f, col, fb))
        v = f['off_var' if side == 'off' else 'def_var']
        return e * plays, np.sqrt(plays ** 2 * v + e ** 2 * var_plays), e

    out = pd.DataFrame(index=teams)
    out['exp_plays'] = p
    out['exp_dropbacks'] = pr_o * p
    out['exp_rushes'] = (1 - pr_o) * p
    out['exp_opp_dropbacks'] = pr_d * p
    out['exp_opp_rushes'] = (1 - pr_d) * p
    out['offense_mean'], out['offense_sd'], e_o = unit('epa', 'off', p, var_p, 1.0)
    out['defense_mean'], out['defense_sd'], e_d = unit('epa', 'def', p, var_p, -1.0)
    var_db = p ** 2 * v_pr_o + pr_o ** 2 * var_p
    var_ru = p ** 2 * v_pr_o + (1 - pr_o) ** 2 * var_p
    var_odb = p ** 2 * v_pr_d + pr_d ** 2 * var_p
    var_oru = p ** 2 * v_pr_d + (1 - pr_d) ** 2 * var_p
    out['pass_off_mean'], out['pass_off_sd'], _ = unit('epa_pass', 'off', out.exp_dropbacks, var_db, 1.0)
    out['rush_off_mean'], out['rush_off_sd'], _ = unit('epa_rush', 'off', out.exp_rushes, var_ru, 1.0)
    out['pass_def_mean'], out['pass_def_sd'], _ = unit('epa_pass', 'def', out.exp_opp_dropbacks, var_odb, -1.0)
    out['rush_def_mean'], out['rush_def_sd'], _ = unit('epa_rush', 'def', out.exp_opp_rushes, var_oru, -1.0)
    st = W['st_net'].reindex(teams)
    # st_net is one zero-sum net rating per team-game (the team's special-teams
    # EPA minus its opponent's). V2's edge_st_net is the difference of both
    # teams' expected nets, which counts the same quantity twice; the team's
    # expected net against an average FBS team is half of it.
    out['st_mean'] = 0.5 * ((st[oc] - _fbs_mean(st, oc, fb)) - (st[dc] - _fbs_mean(st, dc, fb)))
    out['st_sd'] = 0.5 * np.sqrt(st['off_var'] + st['def_var'])
    ep = W['epa'].reindex(teams)
    out['overall_mean'] = out.offense_mean + out.defense_mean + out.st_mean
    out['overall_sd'] = np.sqrt(p ** 2 * (ep['off_var'] + ep['def_var']) + (e_o + e_d) ** 2 * var_p
                                + out.st_sd ** 2)
    out['e_off'], out['e_def'] = e_o, e_d          # rating-unit edges (EPA/play) behind the points
    h_epa = lg.get('epa', (np.nan, 0.0))[1]
    h_st = lg.get('st_net', (np.nan, 0.0))[1]
    out['hfa_epa_pts'] = 2.0 * h_epa * p            # both units gain h per play (eff_pts_raw's 2h)
    out['hfa_st_pts'] = h_st                        # the home team's net ST gain (the 1/2 convention)
    out['hfa'] = out.hfa_epa_pts + out.hfa_st_pts
    return out


def _mu_fallback(setup, season):
    """League means for pace and pass rate before any game of the season:
    the previous season's FBS means (point-in-time)."""
    TG = setup['TG']
    prv = TG[TG.g_season.eq(season - 1) & (TG.home_fbs & TG.away_fbs)]
    if prv.empty:
        return None
    return {'plays_pg': float(prv.n_plays_all.mean()),
            'pass_rate': float(prv.n_db.sum() / prv.n_plays.sum())}


# ========================================================= system matrices
def _X(D, sub):
    from scipy import sparse
    n = len(sub)
    io = np.fromiter((D.o(t) for t in sub.team_id.values), dtype=np.int64, count=n)
    idd = np.fromiter((D.d(t) for t in sub.opp_id.values), dtype=np.int64, count=n)
    rows = np.repeat(np.arange(n), 4)
    cols = np.stack([np.zeros(n, dtype=np.int64), np.ones(n, dtype=np.int64), io, idd], axis=1).ravel()
    vals = np.stack([np.ones(n), sub.H.values.astype(float), np.ones(n), np.ones(n)], axis=1).ravel()
    return sparse.csr_matrix((vals, (rows, cols)), shape=(n, D.p))


def _obs(setup, season, T):
    TG = setup['TG']
    return TG[TG.g_season.eq(season) & (TG.kickoff_ts < T)]


def _system(setup, priors, season, T, m, horizon='season', want_var=True, obs=None):
    """Re-solve one metric with the system captured (the same call build_ratings makes)."""
    spec = BR.metric_specs()[m]
    obs = _obs(setup, season, T) if obs is None else obs
    so = {}
    fit, res = R.fit_metric(obs, m, spec, setup['varcomp'][m], priors[m], horizon=horizon, T=T,
                            halflife_weeks=C.RECENT_HALFLIFE_WEEKS if horizon == 'recent' else None,
                            want_var=want_var, system_out=so)
    so['sub'] = obs.loc[so['rows']]
    so['fit'] = fit
    so['X'] = _X(so['design'], so['sub'])
    return so


# ================================================== recent form & volatility
def recent_form_test(setup, priors, season, T, P, fbs):
    """recent - season on the points scale, with its sampling SD and bias
    under the null of NO change (constant ratings), for offence and defence.

    Both horizons are linear in y: x = A^-1 (X' W y + Pi m). With y ~ N(X theta,
    W_season^-1), (x_rec - x_season) has covariance M W_s^-1 M', M = A_r^-1 X'W_r
    - A_s^-1 X'W_s, and mean (A_r^-1 (X'W_r X theta + Pi_r m) - A_s^-1 (X'W_s X
    theta + Pi_s m)), evaluated at theta = x_season (plug-in). z = (diff - bias)/sd."""
    so_s = _system(setup, priors, season, T, 'epa', 'season', want_var=False)
    so_r = _system(setup, priors, season, T, 'epa', 'recent', want_var=False)
    D, X = so_s['design'], so_s['X']
    ws, wr = so_s['w'], so_r['w']
    XtWs = (X.T.multiply(ws)).toarray() if hasattr(X.T, 'multiply') else X.T.toarray() * ws
    XtWr = (X.T.multiply(wr)).toarray()
    Ms = np.linalg.solve(so_s['A'], XtWs)
    Mr = np.linalg.solve(so_r['A'], XtWr)
    M = Mr - Ms
    Xd = X.toarray()
    xs, xr = so_s['x'], so_r['x']
    Es = np.linalg.solve(so_s['A'], XtWs @ (Xd @ xs) + so_s['prior_prec'] * so_s['prior_mean'])
    Er = np.linalg.solve(so_r['A'], XtWr @ (Xd @ xs) + so_r['prior_prec'] * so_r['prior_mean'])
    bias = Er - Es
    diff = xr - xs
    teams = D.teams
    nt = len(teams)
    fbi = np.array([D.ix[t] for t in teams if t in fbs])
    p = P['exp_plays'].reindex(teams).values
    out = pd.DataFrame(index=pd.Index(teams, name='team_id'))
    for unit, base, sign in (('offense', 2, 1.0), ('defense', 2 + nt, -1.0)):
        G = np.zeros((nt, D.p))
        G[np.arange(nt), base + np.arange(nt)] = 1.0
        G[:, base + fbi] -= 1.0 / len(fbi)
        G *= (sign * p)[:, None]
        out[unit + '_diff'] = G @ diff
        out[unit + '_bias'] = G @ bias
        out[unit + '_diff_sd'] = np.sqrt(((G @ M) ** 2 / ws[None, :]).sum(axis=1))
    for unit in ('offense', 'defense'):
        sd = out[unit + '_diff_sd'].where(out[unit + '_diff_sd'] > 1e-12)
        out[unit + '_z'] = (out[unit + '_diff'] - out[unit + '_bias']) / sd
    out['overall_diff_sd'] = np.sqrt(out.offense_diff_sd ** 2 + out.defense_diff_sd ** 2)
    # residuals of the season fit (volatility and home-field evidence)
    sub = so_s['sub']
    res = pd.DataFrame({'off': sub.team_id.values, 'def': sub.opp_id.values, 'H': sub.H.values,
                        'kickoff_ts': sub.kickoff_ts.reset_index(drop=True), 'res': so_s['y'] - X @ xs})
    return out, res


def recent_volatility(res, prior_sd, k_games=VOL_RECENT_GAMES, k=VOL_SHRINK_K):
    """Residual SD over each team's last k games (offence and defence rows
    pooled, as ratings.residual_volatility), shrunk the same way."""
    long = pd.concat([res[['off', 'kickoff_ts', 'res']].rename(columns={'off': 'team_id'}),
                      res[['def', 'kickoff_ts', 'res']].rename(columns={'def': 'team_id'})])
    out = {}
    for t, g in long.groupby('team_id'):
        ks = sorted(g.kickoff_ts.unique())[-k_games:]
        r = g[g.kickoff_ts.isin(ks)].res
        m = len(r)
        v = (np.var(r, ddof=1) * (m - 1) if m > 1 else 0.0) + k * prior_sd ** 2
        out[t] = (float(np.sqrt(v / (max(m - 1, 0) + k))), m)
    return out


def hfa_evidence(res, P, fbs):
    """Report-only: a team-specific home effect in the season residuals.
    V2 has ONE league home effect h per metric; this is the evidence a team
    or venue effect would need (never used by the model). eta_t = (mean home
    net residual - mean away net residual) / 4 per play (net = offence
    residual - defence residual; the symmetric H coding gives +-2 eta),
    in points x 2 x plays, shrunk across FBS teams by empirical Bayes."""
    r = res[res.H.ne(0)]
    long = pd.concat([pd.DataFrame({'team_id': r.off.values, 'home': r.H.values == 1, 'v': r.res.values}),
                      pd.DataFrame({'team_id': r['def'].values, 'home': r.H.values == -1, 'v': -r.res.values})])
    g = long.groupby(['team_id', 'home']).v.agg(['mean', 'size']).unstack('home')
    g = g.reindex(P.index)
    mh, ma = g[('mean', True)], g[('mean', False)]
    nh, na = g[('size', True)].fillna(0), g[('size', False)].fillna(0)
    s2 = float(np.var(long.v.values)) if len(long) > 2 else np.nan
    eta = (mh - ma) / 4.0
    se2 = s2 * (1.0 / nh.where(nh > 0) + 1.0 / na.where(na > 0)) / 16.0
    fb = [t for t in eta.index if t in fbs and np.isfinite(eta.get(t, np.nan))]
    tau2 = max(0.0, float(eta.loc[fb].var() - se2.loc[fb].mean())) if len(fb) > 5 else 0.0
    shr = eta * (tau2 / (tau2 + se2))
    pts = 2.0 * P['exp_plays']
    return pd.DataFrame({'hfa_team_evidence_raw_pts': eta * pts, 'hfa_team_evidence_pts': shr * pts,
                         'hfa_team_evidence_n_home': nh / 2.0}), {'tau2_eta': tau2, 'resid_var': s2}


# ======================================================== prior accounting
def prior_accounting(priors, explain, Wt, fbs, season, metrics=None, plays=None):
    """Per team x metric x side: prior_weight = prior precision / posterior
    precision = posterior var / tau2 (the share of the posterior precision the
    preseason prior still contributes), and the prior MEAN decomposed into
    build_prior's ridge terms (coefficient x feature value), grouped and
    centred on the FBS mean of each group (the intercept is common to every FBS
    team and cancels on the points scale). effective_weight = prior_weight x
    |centred group contribution| share. Accounting only: nothing changes the model."""
    frames = []
    metrics = metrics or sorted(Wt)
    fbl = list(fbs)
    for m in metrics:
        pr, W = priors[m], Wt[m]
        ex = explain.get((season, m), {})
        for side, key in (('off', 'o'), ('def', 'd')):
            tau2 = np.array([pr['tau2_' + key].get(t, pr['tau2_default_' + key]) for t in W.index])
            pv = W['%s_var' % side].values
            cols = {'metric': m, 'side': side, 'tau2': tau2, 'posterior_var': pv,
                    'prior_weight': np.minimum(pv / tau2, 1.0), 'prior_mean': W['prior_%s' % side].values,
                    'pool': np.where(W.index.isin(fbl), 'none', 'fcs_pooled')}
            e = ex.get(side) if ex else None
            if e is not None and e.get('beta') is not None:
                Xc, beta = e['X'], e['beta']
                c = pd.DataFrame({'baseline': float(beta[0])}, index=Xc.index)
                for g, gc in PRIOR_GROUPS.items():
                    c[g] = sum(beta[1 + BR.PRIOR_COLS.index(col)] * Xc[col] for col in gc)
                check = c.sum(axis=1)
                fb = c.index.intersection(fbl)
                grp = list(PRIOR_GROUPS)
                cen = (c[grp] - c.loc[fb, grp].mean()).reindex(W.index)
                tot = cen.abs().sum(axis=1)
                share = cen.abs().div(tot.where(tot > 0), axis=0)
                share = share.where(cen.notna(), np.nan).fillna(0.0).where(cen.notna())
                has = cen.notna().all(axis=1).values
                cols['pool'] = np.where(has, 'fbs_ridge', cols['pool'])
                for g in grp:
                    cols['contrib_' + g] = cen[g].values
                    cols['share_' + g] = share[g].values
                    cols['eff_weight_' + g] = cols['prior_weight'] * share[g].values
                cols['decomposition_error'] = check.reindex(W.index).values - cols['prior_mean']
            frames.append(pd.DataFrame(cols, index=W.index))
    return pd.concat(frames).rename_axis('team_id').reset_index()


# ============================================================ explanations
def _metric_rows(setup, season, T, m):
    spec = BR.metric_specs()[m]
    obs = _obs(setup, season, T)
    y, n, ok = R.metric_obs(obs, spec[0], spec[1], spec[2])
    sub = obs[ok]
    w = R.obs_weights(n.values, *setup['varcomp'][m])
    return pd.DataFrame({'off': sub.team_id.values, 'def': sub.opp_id.values, 'H': sub.H.values.astype(float),
                         'y': y.values.astype(float), 'w': np.asarray(w, dtype=float),
                         'kickoff_ts': sub.kickoff_ts.reset_index(drop=True)})


def _conditional(rows, side, rest, pm, pp):
    """Conditional posterior mean of every team's `side` rating given all
    other parameters at `rest` (a genuine re-solve of that block):
        (pi mu_p + sum w (y - mu - h H - other)) / (pi + sum w)."""
    teams = pm.index
    if side == 'off':
        tm, oth = rows['off'].values, rest['def'].reindex(rows['def'].values).values
    else:
        tm, oth = rows['def'].values, rest['off'].reindex(rows['off'].values).values
    r = rows.y.values - rest['mu'] - rest['h'] * rows.H.values - oth
    W = pd.Series(rows.w.values).groupby(tm).sum().reindex(teams).fillna(0.0)
    WR = pd.Series(rows.w.values * r).groupby(tm).sum().reindex(teams).fillna(0.0)
    cond = (pp * pm + WR) / (pp + W)
    rbar = (WR / W.where(W > 0)).fillna(pm)          # no data: define r-bar = prior mean
    lam = pp / (pp + W)
    return cond, rbar, lam


def _x(W, lg, m):
    mu, h = lg.get(m, (np.nan, 0.0))
    return {'mu': mu if np.isfinite(mu) else 0.0, 'h': h if np.isfinite(h) else 0.0,
            'off': W[m]['off'], 'def': W[m]['def']}


def metric_change(setup, priors, season, T_prev, T, m, W0, W1, lg0, lg1):
    """Exact sequential attribution of x(T) - x(T_prev) for one metric, per
    team and side, in rating units (see METHODS_STATE.md):
      opponent re-adjustment  old games, opponents re-solved (at T), league held
      league shift            old games, mu and h re-solved
      prior decay / new evidence   adding the team's new games: the prior's
                              weight falls (lambda) and the data mean moves
      numerical               the fixed-point residual (~1e-12)"""
    rows = _metric_rows(setup, season, T, m)
    old = rows[rows.kickoff_ts < T_prev]
    pr = priors[m]
    teams = W1[m].index
    out = {}
    x0, x1 = _x(W0, lg0, m), _x(W1, lg1, m)
    mixed = {'mu': x0['mu'], 'h': x0['h'], 'off': x1['off'], 'def': x1['def']}
    for side, key in (('off', 'o'), ('def', 'd')):
        pm = pd.Series({t: pr[key].get(t, (pr['default_' + key],))[0] for t in teams})
        pp = pd.Series({t: 1.0 / pr['tau2_' + key].get(t, pr['tau2_default_' + key]) for t in teams})
        ca, _, _ = _conditional(old, side, x0, pm, pp)
        cb, _, _ = _conditional(old, side, mixed, pm, pp)
        cc, rbar_old, lam_old = _conditional(old, side, x1, pm, pp)
        cd, rbar_all, lam_all = _conditional(rows, side, x1, pm, pp)
        v0, v1 = W0[m][side].reindex(teams), W1[m][side].reindex(teams)
        comp = pd.DataFrame({
            'opponent_readjustment': cb - ca,
            'league_shift': cc - cb,
            'prior_decay': (lam_all - lam_old) * (pm - rbar_old),
            'new_evidence': (1 - lam_all) * (rbar_all - rbar_old),
        })
        comp['numerical'] = (v1 - v0) - comp.sum(axis=1)
        comp['fixed_point_check'] = np.maximum((ca - v0).abs(), (cd - v1).abs())
        out[side] = comp
    return out


def explain_changes(setup, priors, season, T_prev, T, W0, W1, lg0, lg1, P0, P1, fbs):
    """Week-over-week change of offence, defence, special teams and overall,
    in points, split into new evidence, opponent re-adjustment, prior decay,
    league/HFA shift (incl. the FBS reference mean moving) and pace. The
    split is an exact telescoping identity (it sums to the change up to the
    'numerical' term) but path-dependent: opponents first, then the league,
    then the team's own new games."""
    ch = {m: metric_change(setup, priors, season, T_prev, T, m, W0, W1, lg0, lg1)
          for m in ('epa', 'st_net')}
    teams = P1.index
    fb = [t for t in teams if t in fbs]
    comps = ('new_evidence', 'opponent_readjustment', 'prior_decay', 'league_shift', 'numerical')

    def ref_shift(m, side):
        return _fbs_mean(W1[m], side, fb) - _fbs_mean(W0[m], side, fb)

    p0, p1 = P0['exp_plays'].reindex(teams), P1['exp_plays'].reindex(teams)
    unit = {}
    # offence: (o - o_fbs) * p ; defence: -(d - d_fbs) * p
    for name, m, side, sign in (('offense', 'epa', 'off', 1.0), ('defense', 'epa', 'def', -1.0)):
        c = ch[m][side].reindex(teams)
        e0 = P0['e_off' if side == 'off' else 'e_def'].reindex(teams)
        d = {k: sign * c[k] * p1 for k in comps}
        d['league_shift'] = d['league_shift'] - sign * ref_shift(m, side) * p1
        d['pace'] = e0 * (p1 - p0)
        unit[name] = d
    cst0, cst1 = ch['st_net']['off'].reindex(teams), ch['st_net']['def'].reindex(teams)
    d = {k: 0.5 * (cst0[k] - cst1[k]) for k in comps}
    d['league_shift'] = d['league_shift'] - 0.5 * (ref_shift('st_net', 'off') - ref_shift('st_net', 'def'))
    d['pace'] = pd.Series(0.0, index=teams)
    unit['st'] = d
    unit['overall'] = {k: unit['offense'][k] + unit['defense'][k] + unit['st'][k]
                       for k in comps + ('pace',)}
    col = {'offense': 'offense', 'defense': 'defense', 'st': 'st', 'overall': 'overall'}
    out = {}
    for t in teams:
        e = {'available': True, 'from': T_prev, 'to': T, 'method': 'sequential conditional re-solves '
             '(exact identity, path-dependent: opponents -> league -> own games)'}
        for u, d in unit.items():
            m0 = float(P0.loc[t, col[u] + '_mean']) if t in P0.index else np.nan
            m1 = float(P1.loc[t, col[u] + '_mean'])
            s0 = float(P0.loc[t, col[u] + '_sd']) if t in P0.index else np.nan
            s1 = float(P1.loc[t, col[u] + '_sd'])
            cmp = {k: float(v[t]) for k, v in d.items()}
            e[u] = {'mean_prev': m0, 'mean': m1, 'mean_change': m1 - m0, 'sd_prev': s0, 'sd': s1,
                    'sd_change': s1 - s0, 'components': cmp,
                    'closure': float((m1 - m0) - sum(cmp.values()))}
        e['fixed_point_check'] = float(max(ch['epa']['off'].fixed_point_check.get(t, 0.0),
                                           ch['epa']['def'].fixed_point_check.get(t, 0.0)))
        out[int(t)] = e
    return out


# ============================================================ guardrails
MOVE_BUCKETS = ((1, 1), (2, 2), (3, 4), (5, 7), (8, 11), (12, 99))   # transition index ranges


def move_bucket(k):
    """Bucket of the k-th transition of a season (k = 1: the prior -> the
    first games; k = 2: first -> second freeze with games; ...)."""
    for lo, hi in MOVE_BUCKETS:
        if lo <= k <= hi:
            return '%d-%d' % (lo, hi) if lo != hi else str(lo)
    return None


def transition_index(season, T):
    """k of the transition T_prev -> T (0 when T has no game before it)."""
    fr = freezes(season)
    G = _games()
    g = G[G.season.eq(season)]
    k = 0
    for F in fr:
        if F > T:
            break
        if (g.kickoff_ts < F).any():
            k += 1
    return k


def movement_flags(rows, prev, explanations=None, bounds=None, k=None):
    """Flag an overall move above the historical p99.5 weekly move, or an SD
    collapse (1 - sd/sd_prev) above its p99.5, naming the drivers from the
    explanations. The bound is the one of the season phase (MOVE_BUCKETS, by
    transition index k) when k is given, else the pooled one."""
    b = bounds or MOVE_BOUNDS
    pv = prev.set_index('team_id') if prev is not None and len(prev) else None
    flags = []
    if pv is None:
        return flags
    bucket = move_bucket(k) if k else None
    for r in rows.itertuples():
        if r.team_id not in pv.index:
            continue
        q = pv.loc[r.team_id]
        mv = float(r.overall_mean - q.overall_mean)
        drop = float(1.0 - r.overall_sd / q.overall_sd) if q.overall_sd > 0 else 0.0
        kind = 'fcs' if r.fcs else 'fbs'
        by = b.get('by_bucket', {}).get(kind, {}).get(bucket) if bucket else None
        lim_m = by['abs_move_p995'] if by else b.get('%s_abs_move_p995' % kind)
        lim_s = by['sd_drop_p995'] if by else b.get('%s_sd_drop_p995' % kind)
        drivers = []
        ex = (explanations or {}).get(r.team_id)
        if ex and ex.get('available'):
            cmp = ex['overall']['components']
            drivers = [{'component': c, 'points': round(v, 3)}
                       for c, v in sorted(cmp.items(), key=lambda kv: -abs(kv[1])) if abs(v) >= 0.05][:3]
        base = {'team_id': int(r.team_id), 'bucket': bucket or 'pooled',
                'drivers': drivers or [{'component': 'unattributed'}]}
        if lim_m is not None and abs(mv) > lim_m:
            flags.append(dict(base, flag='MOVE_ABOVE_P995', move=mv, bound=lim_m))
        if lim_s is not None and drop > lim_s:
            flags.append(dict(base, flag='SD_COLLAPSE', sd_drop=drop, bound=lim_s))
    return flags


def movement_history(seasons, out_dir=None):
    """Weekly overall moves and SD drops (points) on stage-3 files: every
    consecutive pair of freezes within each season, from the prior-only
    freeze on (the pace/pass-rate means before any game: the previous
    season's, as build() uses)."""
    import os
    base = out_dir or C.OUT
    G = _games()
    TG, _ = BR.load_team_games(sorted(set(seasons) | set(s - 1 for s in seasons)))
    recs = []
    for S in seasons:
        Rs = pd.read_parquet(os.path.join(base, 'stage3', 'ratings_%d.parquet' % S))
        Ls = pd.read_parquet(os.path.join(base, 'stage3', 'league_%d.parquet' % S))
        g = G[G.season.eq(S)]
        fbs = set(g.loc[g.home_fbs, 'home_id']) | set(g.loc[g.away_fbs, 'away_id'])
        mfb = _mu_fallback({'TG': TG}, S)
        prevP, k = None, 0
        for T in sorted(Rs.prediction_ts.unique()):
            W = wide(Rs[Rs.prediction_ts.eq(T)])
            lg = league_at(Ls[Ls.prediction_ts.eq(T)])
            P = points(W, lg, fbs, mfb)
            if prevP is not None and (g.kickoff_ts < T).any():
                k += 1
                j = P.index.intersection(prevP.index)
                recs.append(pd.DataFrame({
                    'season': S, 'T': T, 'k': k, 'team_id': j,
                    'move': (P.loc[j, 'overall_mean'] - prevP.loc[j, 'overall_mean']).values,
                    'sd_drop': (1 - P.loc[j, 'overall_sd'] / prevP.loc[j, 'overall_sd']).values,
                    'fbs': [t in fbs for t in j]}))
            prevP = P
    return pd.concat(recs, ignore_index=True)


def estimate_movement_bounds(seasons=C.DEV_SEASONS, out_dir=None, q=0.995):
    H = movement_history(seasons, out_dir)
    H['bucket'] = H.k.map(move_bucket)
    out = {'by_bucket': {}}
    for kind, sel in (('fbs', H.fbs), ('fcs', ~H.fbs)):
        h = H[sel]
        out['%s_abs_move_p995' % kind] = round(float(np.quantile(h.move.abs(), q)), 4)
        out['%s_sd_drop_p995' % kind] = round(float(np.quantile(h.sd_drop, q)), 4)
        out['n_%s' % kind] = int(len(h))
        out['by_bucket'][kind] = {
            bk: {'abs_move_p995': round(float(np.quantile(x.move.abs(), q)), 4),
                 'sd_drop_p995': round(float(np.quantile(x.sd_drop, q)), 4), 'n': int(len(x))}
            for bk, x in h.groupby('bucket')}
    out['seasons'] = [int(s) for s in seasons]
    return out, H


# ================================================================== build
def _flags(r, z_off, z_def, vol_z, n_games, lineup):
    f = []
    if n_games >= TREND_MIN_GAMES:
        if np.isfinite(z_off) and z_off > TREND_Z:
            f.append('OFFENSE_IMPROVING')
        if np.isfinite(z_off) and z_off < -TREND_Z:
            f.append('OFFENSE_DECLINING')
        if np.isfinite(z_def) and z_def > TREND_Z:
            f.append('DEFENSE_IMPROVING')
        if np.isfinite(z_def) and z_def < -TREND_Z:
            f.append('DEFENSE_DECLINING')
    if n_games >= VOL_TREND_MIN_GAMES and np.isfinite(vol_z) and vol_z > TREND_Z:
        f.append('VOLATILITY_RISING')
    if lineup and lineup.get('qb_stabilizing'):
        f.append('QB_STABILIZING')
    return f


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def build(season, T, prev=None, ratings=None, league=None, with_qb=True):
    """Team state of every team with games or a prior at freeze T.

    prev: last week's rows (same season) - the explanation and movement are
    measured against it; default: the previous freeze of the schedule.
    ratings/league: stage-3 frames at T (e.g. from opponent_adjust); default:
    rebuilt here with build_ratings.run(only_ts=[T]). Given frames are checked
    against the re-solve (convergence['input_check'])."""
    T = _utc(T)
    T_prev = None
    if prev is not None and len(prev):
        tp = _utc(prev['as_of'].iloc[0])
        T_prev = tp if int(prev['season'].iloc[0]) == int(season) and tp < T else None
    else:
        T_prev = previous_freeze(season, T)
    # ---- the V2 solve at T_prev (the CG warm start and the explanation base) and at T
    base = opponent_adjust(season, T_prev, diag=False) if T_prev is not None else None
    warm = (base['ratings'], base['league']) if base is not None else None
    cur = opponent_adjust(season, T, warm=warm)
    conv = cur['convergence']
    if ratings is not None:
        Rin = ratings[ratings.prediction_ts.eq(T)] if 'prediction_ts' in ratings else ratings
        k = ['team_id', 'metric']
        a = cur['ratings'].set_index(k).sort_index()
        b = Rin.set_index(k).reindex(a.index)
        cols = [c for c in ('off', 'def', 'off_var', 'def_var', 'off_rec', 'def_rec') if c in b]
        diff = float(np.nanmax(np.abs(a[cols].values - b[cols].values))) if len(b) else np.nan
        conv['input_check'] = {'max_abs_diff_vs_resolve': diff, 'matches': bool(diff <= 1e-9)}
        if not conv['input_check']['matches']:
            raise AssertionError('given ratings differ from the V2 re-solve at %s by %.3g' % (T, diff))
    setup, priors, fbs = cur['setup'], cur['priors'], cur['fbs']
    Rt, Lt = cur['ratings'], cur['league']
    W1, lg1 = wide(Rt), league_at(Lt)
    mfb = _mu_fallback(setup, season)
    P1 = points(W1, lg1, fbs, mfb)
    Prec = points(W1, lg1, fbs, mfb, horizon_cols=('off_rec', 'def_rec'))
    # ---- recent form, volatility, home-field evidence
    obs = _obs(setup, season, T)
    if len(obs):
        rt, res = recent_form_test(setup, priors, season, T, P1, fbs)
        s2p, s2g = setup['varcomp']['epa']
        prior_sd = float(np.sqrt(s2p / setup['typ_n']['epa'] + s2g))
        vr = recent_volatility(res, prior_sd)
        hfa_ev, hfa_meta = hfa_evidence(res, P1, fbs)
    else:
        rt, vr, hfa_ev, hfa_meta = None, {}, None, {}
    # ---- prior accounting
    PA = prior_accounting(priors, cur['explain'], W1, fbs, season)
    metrics_all = sorted(PA.metric.unique())
    PA_by_team = {}
    for r in PA.to_dict('records'):
        PA_by_team.setdefault(r['team_id'], {})[(r['metric'], r['side'])] = r
    # ---- QB context
    qb_rows = qb_events = None
    if with_qb:
        qb_rows, qb_events = QS.build(season, T, ratings=Rt, league=Lt)
    # ---- counts
    G = _games()
    g_s = G[G.season.eq(season)]
    names = pd.concat([g_s[['home_id', 'home_team', 'home_conference']].set_axis(['team_id', 'team', 'conf'], axis=1),
                       g_s[['away_id', 'away_team', 'away_conference']].set_axis(['team_id', 'team', 'conf'], axis=1)]
                      ).drop_duplicates('team_id').set_index('team_id')
    ob = obs.assign(opp_fbs=obs.opp_id.isin(fbs))
    n_games = ob.groupby('team_id').game_id.nunique()
    n_vs_fbs = ob[ob.opp_fbs].groupby('team_id').game_id.nunique()
    mp_off = ob.groupby('team_id').n_plays.sum()
    mp_def = ob.groupby('opp_id').n_plays.sum()
    # ---- explanations vs the previous freeze
    explanations = {}
    if base is not None:
        W0, lg0 = wide(base['ratings']), league_at(base['league'])
        P0 = points(W0, lg0, fbs, mfb)
        if prev is not None and len(prev):
            pv = prev.set_index('team_id')
            for u in ('offense', 'defense', 'st', 'overall'):
                for s in ('mean', 'sd'):
                    c = '%s_%s' % (u, s)
                    if c in pv:
                        P0.loc[P0.index.intersection(pv.index), c + '_given'] = pv[c]
        explanations = explain_changes(setup, priors, season, T_prev, T, W0, W1, lg0, lg1, P0, P1, fbs)
        if prev is not None and len(prev):
            gv = [c for c in P0.columns if c.endswith('_given')]
            dev = np.nanmax(np.abs(P0[gv].values - P0[[c[:-6] for c in gv]].values)) if gv else np.nan
            for e in explanations.values():
                e['prev_rows_consistent_max_abs'] = float(dev)
    reason = 'first freeze of the season' if T_prev is None else None
    rows = []
    for t in P1.index:
        p = P1.loc[t]
        fcs = t not in fbs
        ng = int(n_games.get(t, 0))
        pa_t = PA_by_team.get(t, {})
        pwg = lambda m, sd: _num(pa_t[(m, sd)]['prior_weight']) if (m, sd) in pa_t else None
        pw_off, pw_def = pwg('epa', 'off'), pwg('epa', 'def')
        pw_st = _num(np.mean([pwg('st_net', 'off'), pwg('st_net', 'def')]))
        comps = {}
        for unit, (m, side) in (('offense', ('epa', 'off')), ('defense', ('epa', 'def')),
                                ('pass_off', ('epa_pass', 'off')), ('rush_off', ('epa_rush', 'off')),
                                ('pass_def', ('epa_pass', 'def')), ('rush_def', ('epa_rush', 'def')),
                                ('st', ('st_net', 'off'))):
            r = pa_t.get((m, side))
            if r is None:
                continue
            if r['pool'] == 'fbs_ridge':
                comps[unit] = {'prior_weight': _num(r['prior_weight']), 'pool': 'fbs_ridge',
                               'effective_weight': {g: _num(r['eff_weight_' + g]) for g in PRIOR_GROUPS},
                               'contribution': {g: _num(r['contrib_' + g]) for g in PRIOR_GROUPS}}
            else:
                comps[unit] = {'prior_weight': _num(r['prior_weight']), 'pool': r['pool'],
                               'effective_weight': {'fcs_pool': _num(r['prior_weight'])}}
        thin = []
        if ng < THIN_GAMES:
            thin.append('%d games before T' % ng)
        if pw_off is not None and max(pw_off, pw_def or 0) > THIN_PRIOR_WEIGHT:
            thin.append('prior still %.0f%% of the offence/defence precision' % (100 * max(pw_off, pw_def or 0)))
        if fcs:
            thin.append('FCS: rated only through %d game(s) vs FBS; pooled FCS prior'
                        % int(n_vs_fbs.get(t, 0)))
        lu = QS.lineup(qb_rows, qb_events, t) if with_qb and qb_rows is not None else None
        infl_pts2 = None
        if lu is not None and lu.get('qb_offense_var_inflation_epa_db2') is not None:
            infl_pts2 = float(lu['qb_offense_var_inflation_epa_db2']) * float(p.exp_dropbacks) ** 2
        z_off = z_def = vol_z = np.nan
        rms = rms_sd = None
        if rt is not None and t in rt.index:
            z_off, z_def = rt.loc[t, 'offense_z'], rt.loc[t, 'defense_z']
            rms_sd = _num(rt.loc[t, 'overall_diff_sd'])
        rec_strength = float(Prec.loc[t, 'overall_mean'])
        vol_season = float(W1['epa'].loc[t, 'vol']) if 'vol' in W1['epa'] else np.nan
        vrec, m_r = vr.get(t, (np.nan, 0))
        if m_r > 1 and np.isfinite(vol_season) and vol_season > 0:
            vol_z = (vrec - vol_season) / (vol_season / np.sqrt(2.0 * (m_r - 1 + VOL_SHRINK_K)))
        flags = _flags(p, z_off, z_def, vol_z, ng, lu)
        pwd = {m: [pwg(m, 'off'), pwg(m, 'def')] for m in metrics_all}
        hfa_by_metric = {
            'epa': _num(2 * lg1['epa'][1] * p.exp_plays),
            'epa_pass': _num(lg1['epa_pass'][1] * (p.exp_dropbacks + p.exp_opp_dropbacks)),
            'epa_rush': _num(lg1['epa_rush'][1] * (p.exp_rushes + p.exp_opp_rushes)),
            'st_net': _num(lg1['st_net'][1])}
        row = {
            'season': int(season), 'as_of': T, 'team_id': int(t),
            'team': names.team.get(t), 'conference': names.conf.get(t), 'fcs': bool(fcs),
            'n_games': ng, 'n_games_vs_fbs': int(n_vs_fbs.get(t, 0)),
            'meaningful_plays_off': _num(mp_off.get(t, 0.0)), 'meaningful_plays_def': _num(mp_def.get(t, 0.0)),
        }
        for c in ('overall', 'offense', 'defense', 'st', 'pass_off', 'rush_off', 'pass_def', 'rush_def'):
            row[c + '_mean'] = _num(p[c + '_mean'])
            row[c + '_sd'] = _num(p[c + '_sd'])
        row.update({
            'exp_plays': _num(p.exp_plays), 'exp_dropbacks': _num(p.exp_dropbacks),
            'exp_rushes': _num(p.exp_rushes), 'exp_opp_dropbacks': _num(p.exp_opp_dropbacks),
            'exp_opp_rushes': _num(p.exp_opp_rushes),
            'season_strength': _num(p.overall_mean), 'recent_strength': _num(rec_strength),
            'recent_minus_season': _num(rec_strength - p.overall_mean),
            'recent_minus_season_sd': rms_sd,
            'offense_recent': _num(Prec.loc[t, 'offense_mean']), 'defense_recent': _num(Prec.loc[t, 'defense_mean']),
            'offense_trend_z': _num(z_off), 'defense_trend_z': _num(z_def),
            'volatility': _num(vol_season * p.exp_plays), 'volatility_recent': _num(vrec * p.exp_plays),
            'volatility_trend_z': _num(vol_z),
            'hfa': _num(p.hfa), 'hfa_epa_pts': _num(p.hfa_epa_pts), 'hfa_st_pts': _num(p.hfa_st_pts),
            'hfa_by_metric': hfa_by_metric,
            'hfa_team_evidence_pts': _num(hfa_ev.loc[t, 'hfa_team_evidence_pts']) if hfa_ev is not None else None,
            'hfa_team_evidence_raw_pts': _num(hfa_ev.loc[t, 'hfa_team_evidence_raw_pts'])
            if hfa_ev is not None else None,
            'hfa_team_evidence_n_home': _num(hfa_ev.loc[t, 'hfa_team_evidence_n_home'])
            if hfa_ev is not None else None,
            'prior_weight_offense': pw_off, 'prior_weight_defense': pw_def, 'prior_weight_st': pw_st,
            'prior_weight': pwd, 'prior_components': comps,
            'prior_pool': 'fcs_pooled' if fcs else 'fbs_ridge',
            # V2's FBS st_net prior variance sits at the build_prior floor (1.5e-9): the ST
            # rating is its preseason prior and st_sd reflects the floor, not real uncertainty
            'st_sd_floored': bool(pa_t.get(('st_net', 'off'), {}).get('tau2', 1.0) <= 1e-8),
            'thin_data': bool(thin), 'thin_data_reasons': thin,
            'trend_flags': flags,
            'lineup_context': lu,
            'qb_offense_var_inflation_pts2': infl_pts2,
            'offense_sd_with_qb': _num(np.sqrt(p.offense_sd ** 2 + (infl_pts2 or 0.0))),
            'explanation_available': bool(t in explanations),
            'null_reasons': {} if t in explanations else {'explanation': reason or 'team not rated at T_prev'},
            'model_version': C.MODEL_VERSION, 'feature_version': C.FEATURE_VERSION,
            'state_rule_version': STATE_RULE_VERSION,
        })
        for f, why in OPTIONAL_NULL_REASONS.items():
            if row.get(f) is None:
                row['null_reasons'][f] = why
        row['row_hash'] = ids.content_hash(row)
        rows.append(row)
    rows = pd.DataFrame(rows)
    conv['league'] = {'hfa_epa_h': lg1['epa'][1], 'hfa_st_h': lg1['st_net'][1],
                      'hfa_team_evidence': hfa_meta,
                      'h_by_metric': {m: v[1] for m, v in sorted(lg1.items())},
                      'note': 'V2 has one league home effect per metric; no team-specific HFA'}
    if T_prev is None:
        explanations = {int(t): {'available': False, 'reason': reason} for t in P1.index}
    return rows, conv, explanations


# ======================================================= checks & analyses
def sequential_equivalence(season, T_prev, T, metrics=None):
    """Last week's posterior IS this week's prior: take the full posterior
    (mean x0, covariance S0) at T_prev as the prior, update with ONLY the games
    between T_prev and T (same observation weights; the h and team priors are
    already inside S0), and compare to the batch posterior at T (season
    horizon). Kalman / covariance form:
        K = S0 X1' (X1 S0 X1' + W1^-1)^-1,  x = x0 + K (y1 - X1 x0),  S = S0 - K X1 S0.
    Returns per-metric max |mean diff|, max |var diff| and the max relative to
    the posterior SD."""
    T_prev, T = _utc(T_prev), _utc(T)
    cur = opponent_adjust(season, T, diag=False)
    setup, priors = cur['setup'], cur['priors']
    metrics = metrics or list(BR.metric_specs())
    out = {}
    for m in metrics:
        s0 = _system(setup, priors, season, T_prev, m, want_var=True)
        s1 = _system(setup, priors, season, T, m, want_var=True)
        assert s0['design'].teams == s1['design'].teams
        new = (s1['sub'].kickoff_ts >= T_prev).values
        X1 = s1['X'][new].toarray()
        y1, w1 = s1['y'][new], s1['w'][new]
        S0, x0 = s0['Ainv'], s0['x']
        S = X1 @ S0 @ X1.T + np.diag(1.0 / w1)
        K = np.linalg.solve(S, X1 @ S0).T
        xs = x0 + K @ (y1 - X1 @ x0)
        Ss = S0 - K @ X1 @ S0
        vb = np.diag(s1['Ainv'])
        sd = np.sqrt(np.maximum(vb, 1e-300))
        out[m] = {'n_new_rows': int(new.sum()), 'max_abs_mean_diff': float(np.max(np.abs(xs - s1['x']))),
                  'max_abs_var_diff': float(np.max(np.abs(np.diag(Ss) - vb))),
                  'max_mean_diff_in_sd': float(np.max(np.abs(xs - s1['x']) / sd)),
                  'max_rel_var_diff': float(np.max(np.abs(np.diag(Ss) - vb) / np.maximum(vb, 1e-300)))}
    return {'season': int(season), 'T_prev': T_prev, 'T': T, 'metrics': out,
            'max_abs_mean_diff': max(v['max_abs_mean_diff'] for v in out.values()),
            'max_mean_diff_in_sd': max(v['max_mean_diff_in_sd'] for v in out.values()),
            'max_rel_var_diff': max(v['max_rel_var_diff'] for v in out.values())}


def delta_method_check(season, T):
    """The rows' SDs treat every rating as independent (delta method on the
    marginal variances). Recompute them with the FULL posterior covariance of
    each metric (A^-1: the FBS reference mean, a team's offence/defence
    covariance, the league mean of pace) and the exact product variance
    (+ var_e var_p), and report the error of the approximation."""
    T = _utc(T)
    cur = opponent_adjust(season, T, diag=False)
    setup, priors, fbs = cur['setup'], cur['priors'], cur['fbs']
    W, lg = wide(cur['ratings']), league_at(cur['league'])
    P = points(W, lg, fbs, _mu_fallback(setup, season))
    S = {m: _system(setup, priors, season, T, m, want_var=True) for m in ('epa', 'plays_pg', 'st_net')}
    D = S['epa']['design']
    teams, nt = D.teams, D.nt
    fbi = np.array([D.ix[t] for t in teams if t in fbs])

    def g_team(base):
        G = np.zeros((nt, D.p))
        G[np.arange(nt), base + np.arange(nt)] = 1.0
        G[:, base + fbi] -= 1.0 / len(fbi)
        return G

    def qf(G, Sig):
        return np.einsum('ij,jk,ik->i', G, Sig, G)

    Go, Gd = g_team(2), g_team(2 + nt)
    Se, Sp, Ss = S['epa']['Ainv'], S['plays_pg']['Ainv'], S['st_net']['Ainv']
    # pace per team: mu + (o_t + d_t + o_fbs + d_fbs) / 2
    Gp = np.zeros((nt, D.p))
    Gp[:, 0] = 1.0
    Gp[np.arange(nt), 2 + np.arange(nt)] += 0.5
    Gp[np.arange(nt), 2 + nt + np.arange(nt)] += 0.5
    Gp[:, 2 + fbi] += 0.5 / len(fbi)
    Gp[:, 2 + nt + fbi] += 0.5 / len(fbi)
    Pt = P.reindex(teams)
    p, eo, ed = Pt.exp_plays.values, Pt.e_off.values, Pt.e_def.values
    var_p = qf(Gp, Sp)
    v_eo, v_ed = qf(Go, Se), qf(Gd, Se)
    v_net = qf(Go - Gd, Se)
    v_st = 0.25 * qf(Go - Gd, Ss)
    full = {
        'offense': np.sqrt(p ** 2 * v_eo + eo ** 2 * var_p + v_eo * var_p),
        'defense': np.sqrt(p ** 2 * v_ed + ed ** 2 * var_p + v_ed * var_p),
        'st': np.sqrt(v_st),
        'overall': np.sqrt(p ** 2 * v_net + (eo + ed) ** 2 * var_p + v_net * var_p + v_st),
    }
    out = {'season': int(season), 'T': T, 'units': {}}
    isf = np.array([t in fbs for t in teams])
    for u, f in full.items():
        a = Pt['%s_sd' % u].values
        err = a - f
        rel = err / f
        out['units'][u] = {
            'fbs_max_abs_err': float(np.max(np.abs(err[isf]))), 'fbs_median_rel_err': float(np.median(rel[isf])),
            'fbs_max_rel_err': float(np.max(np.abs(rel[isf]))),
            'fcs_max_rel_err': float(np.max(np.abs(rel[~isf]))) if (~isf).any() else None,
            'median_sd_full': float(np.median(f[isf]))}
    # the dominant source for overall: cov(o_t, d_t) and the FBS reference mean
    cov_od = np.einsum('ij,jk,ik->i', Go, Se, Gd)
    out['overall_cov_off_def_median_pts2'] = float(np.median((-2 * p ** 2 * cov_od)[isf]))
    return out


def st_shock(season, T, team_id, shock=14.0, tau2_override=None):
    """Special-teams shrinkage: add ONE synthetic game in which `team_id` wins
    the special-teams battle by `shock` points of EPA (a blocked punt returned
    for a touchdown plus a long return: y = +shock for the team, -shock for
    the opponent, the zero-sum pair), against an average FBS opponent on a
    neutral field just before T, and report how far st_mean moves.

    Compared under: the production prior (st_net scale 1.0), a data-driven
    prior (tau2 = the between-team variance of last season's data-only FBS
    st_net finals, i.e. no floor), and an almost flat prior (tau2 = 1e6)."""
    T = _utc(T)
    cur = opponent_adjust(season, T, diag=False)
    setup, fbs = cur['setup'], cur['fbs']
    obs = _obs(setup, season, T)
    opp = sorted(t for t in fbs if t != team_id)[0]
    base = obs.iloc[:2].copy()
    base['game_id'] = -1
    base['team_id'] = [team_id, opp]
    base['opp_id'] = [opp, team_id]
    base['H'] = 0.0
    base['kickoff_ts'] = T - pd.Timedelta(hours=1)
    base['st_net_epa'] = [shock, -shock]
    spec = BR.metric_specs()['st_net']
    pr0 = cur['priors']['st_net']
    fd = setup['final_do'].get(season - 1, {}).get('st_net')
    fbs_prev = setup['FBS'].get(season - 1, set())
    dd = float(fd['off'].loc[[t for t in fd['off'].index if t in fbs_prev]].var()) if fd is not None else 1.0
    variants = {'production (scale 1.0)': None, 'data-driven tau2 (no floor)': dd, 'flat (tau2 1e6)': 1e6}
    if tau2_override is not None:
        variants = {'override': tau2_override}
    out = {'team_id': int(team_id), 'fcs': team_id not in fbs, 'shock_pts': shock, 'variants': {},
           'n_games_before': int(obs[obs.team_id.eq(team_id)].game_id.nunique())}
    for name, tau2 in variants.items():
        pr = pr0
        if tau2 is not None:
            pr = dict(pr0)
            pr['tau2_o'] = {t: tau2 for t in pr0['tau2_o']}
            pr['tau2_d'] = {t: tau2 for t in pr0['tau2_d']}
            pr['tau2_default_o'] = pr['tau2_default_d'] = tau2
        f0, _ = R.fit_metric(obs, 'st_net', spec, setup['varcomp']['st_net'], pr, want_var=True)
        f1, _ = R.fit_metric(pd.concat([obs, base]), 'st_net', spec, setup['varcomp']['st_net'], pr,
                             want_var=True)
        s0 = 0.5 * (f0.loc[team_id, 'off'] - f0.loc[team_id, 'def'])
        s1 = 0.5 * (f1.loc[team_id, 'off'] - f1.loc[team_id, 'def'])
        out['variants'][name] = {
            'tau2_team': float(pr['tau2_o'].get(team_id, pr['tau2_default_o'])),
            'st_before': float(s0), 'st_after': float(s1), 'move_pts': float(s1 - s0),
            'move_share_of_shock': float((s1 - s0) / shock),
            'posterior_sd_after': float(0.5 * np.sqrt(f1.loc[team_id, 'off_var'] + f1.loc[team_id, 'def_var']))}
    return out


def _season_start(season):
    G = _games()
    return G[G.season.eq(season)].kickoff_ts.min() - pd.Timedelta(days=3)
