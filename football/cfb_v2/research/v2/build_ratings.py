"""Stage 3 orchestrator — priors, then point-in-time ratings for every prediction timestamp.

Order (every step uses only information older than the thing it feeds):

 1. variance components per metric, from the burn-in seasons 2009-2011 only;
 2. DATA-ONLY final ratings for every completed season (weak prior) — the
    targets the preseason prior model learns to predict, and the lagged
    inputs it reads;
 3. the preseason PRIOR for season S: a ridge regression fitted on seasons
    strictly before S, reading last season's and the season before's data-only
    ratings, returning production, roster talent and head-coach change. Its
    out-of-sample residual variance IS the prior variance: a prior is a
    distribution, not a point;
 4. for every prediction timestamp T of season S: season-horizon and
    recent-horizon posteriors from games that kicked off before T, plus
    last-4 / last-2 residual form.

Output: <OUT>/stage3/ratings_<S>.parquet (long: one row per T x team x metric)
        <OUT>/stage3/league_<S>.parquet (mu, h per T x metric)
        <OUT>/stage3/final_dataonly.parquet, priors.parquet, varcomp.json
"""
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import ratings as R

CORE_FORM = ('epa', 'epa_pass', 'epa_rush', 'sr', 'ppd')


def metric_specs():
    specs = {}
    for name, num, den, kind, fam in C.METRICS:
        specs[name] = (num, den, kind if kind != 'drive' else 'rate')
    for name, col in C.PACE_METRICS:
        specs[name] = (col, None, 'game')
    for name, col in C.ST_METRICS:
        specs[name] = (col, None, 'game')
    return specs


def load_team_games(seasons):
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    frames = []
    for S in seasons:
        f = common.out_path('stage1', 'team_game_%d.parquet' % S)
        frames.append(pd.read_parquet(f))
    TG = pd.concat(frames, ignore_index=True)
    TG = TG.merge(G[['game_id', 'kickoff_ts', 'home_id', 'away_id', 'neutral_site', 'status',
                     'home_fbs', 'away_fbs', 'season']].rename(columns={'season': 'g_season'}),
                  on='game_id', how='inner')
    TG = TG[TG.status.eq('FINAL')].copy()
    TG['opp_id'] = TG.opp_id.astype('int64')
    TG['H'] = np.where(TG.neutral_site, 0, np.where(TG.team_id.eq(TG.home_id), 1, -1)).astype(float)
    return TG, G


def fbs_teams_by_season(G):
    out = {}
    for S, g in G.groupby('season'):
        out[S] = set(g.loc[g.home_fbs, 'home_id']) | set(g.loc[g.away_fbs, 'away_id'])
    return out


def weak_prior(teams, scale_o, scale_d, h=(0.0, 1.0)):
    return {'o': {}, 'd': {}, 'tau2_o': {t: scale_o for t in teams},
            'tau2_d': {t: scale_d for t in teams}, 'tau2_default_o': scale_o,
            'tau2_default_d': scale_d, 'h': h}


# ------------------------------------------------------------ prior inputs
def load_prior_inputs():
    rp = []
    for f in sorted(os.listdir(common.data_path('retprod'))):
        d = pd.read_parquet(common.data_path('retprod', f))
        rp.append(d[['season', 'team_id', 'off_returning', 'def_returning']])
    RP = pd.concat(rp).drop_duplicates(['season', 'team_id'])
    tt = []
    for f in sorted(os.listdir(common.data_path('talent'))):
        d = pd.read_parquet(common.data_path('talent', f))
        tt.append(d[['season', 'team_id', 'talent_composite']])
    TT = pd.concat(tt).drop_duplicates(['season', 'team_id'])
    co = []
    md = common.data_path('mline')
    for f in sorted(os.listdir(md)) if os.path.isdir(md) else []:
        d = pd.read_parquet(os.path.join(md, f), columns=['season', 'home_team_id', 'away_team_id',
                                                         'home_hc_tenure', 'away_hc_tenure',
                                                         'home_oc_cont', 'away_oc_cont',
                                                         'home_dc_cont', 'away_dc_cont'])
        h = d[['season', 'home_team_id', 'home_hc_tenure', 'home_oc_cont', 'home_dc_cont']]
        h.columns = ['season', 'team_id', 'hc_tenure', 'oc_cont', 'dc_cont']
        a = d[['season', 'away_team_id', 'away_hc_tenure', 'away_oc_cont', 'away_dc_cont']]
        a.columns = h.columns
        co.append(pd.concat([h, a]))
    CO = pd.concat(co).dropna(subset=['team_id']).drop_duplicates(['season', 'team_id']) if co else None
    for X in (RP, TT) + ((CO,) if CO is not None else ()):
        X['team_id'] = pd.to_numeric(X.team_id, errors='coerce').astype('Int64')
        X['season'] = X.season.astype(int)
    return RP, TT, CO


# Red-team ablation switch (never set in production): CFB_V2_PRIOR_DROP is a
# comma list of prior inputs to remove — talent, retprod, coach, lagged, all.
# A removed input becomes missing for every team, so the prior model learns
# nothing from it ('all' leaves every team at the pooled FBS prior mean).
PRIOR_DROP = set(x for x in os.environ.get('CFB_V2_PRIOR_DROP', '').split(',') if x)


def prior_frame(S, teams, final_do, metric, RP, TT, CO):
    """Feature rows for the preseason prior of `metric` in season S."""
    rows = _prior_frame(S, teams, final_do, metric, RP, TT, CO)
    if 'talent' in PRIOR_DROP or 'all' in PRIOR_DROP:
        rows['talent_z'] = np.nan
    if 'retprod' in PRIOR_DROP or 'all' in PRIOR_DROP:
        rows['ret_off'] = np.nan; rows['ret_def'] = np.nan
    if 'coach' in PRIOR_DROP or 'all' in PRIOR_DROP:
        rows['hc_new'] = np.nan; rows['oc_change'] = np.nan; rows['dc_change'] = np.nan
    if 'lagged' in PRIOR_DROP or 'all' in PRIOR_DROP:
        for c in ('off_lag1', 'off_lag2', 'def_lag1', 'def_lag2'):
            rows[c] = np.nan
    return rows


def _prior_frame(S, teams, final_do, metric, RP, TT, CO):
    rows = pd.DataFrame({'team_id': sorted(teams)})
    rows['season'] = S
    for lag in (1, 2):
        f = final_do.get(S - lag, {}).get(metric)
        for side in ('off', 'def'):
            col = '%s_lag%d' % (side, lag)
            rows[col] = rows.team_id.map(f[side]) if f is not None else np.nan
    rp = RP[RP.season.eq(S)].set_index('team_id')
    rows['ret_off'] = rows.team_id.map(rp.off_returning)
    rows['ret_def'] = rows.team_id.map(rp.def_returning)
    tt = TT[TT.season.eq(S)].set_index('team_id').talent_composite
    tz = (tt - tt.mean()) / (tt.std() or 1.0)
    rows['talent_z'] = rows.team_id.map(tz)
    if CO is not None and (CO.season == S).any():
        co = CO[CO.season.eq(S)].set_index('team_id')
        rows['hc_new'] = rows.team_id.map((co.hc_tenure == 0).astype(float))
        rows['oc_change'] = rows.team_id.map(1.0 - co.oc_cont.astype(float))
        rows['dc_change'] = rows.team_id.map(1.0 - co.dc_cont.astype(float))
    else:
        rows['hc_new'] = np.nan; rows['oc_change'] = np.nan; rows['dc_change'] = np.nan
    return rows


PRIOR_COLS = ['lag1', 'lag2', 'lag1_ret', 'ret', 'talent_z', 'hc_new', 'lag1_hc', 'unit_change',
              'm_lag1', 'm_lag2', 'm_ret', 'm_talent', 'm_coach']


def prior_design(rows, side):
    """Explicit missing-value policy: impute the column mean (0 for centred
    ratings) AND carry a missingness flag. Never a silent zero."""
    X = pd.DataFrame(index=rows.index)
    l1 = rows['%s_lag1' % side]
    l2 = rows['%s_lag2' % side]
    ret = rows['ret_%s' % side]
    X['m_lag1'] = l1.isna().astype(float)
    X['m_lag2'] = l2.isna().astype(float)
    X['m_ret'] = ret.isna().astype(float)
    X['m_talent'] = rows.talent_z.isna().astype(float)
    X['m_coach'] = rows.hc_new.isna().astype(float)
    X['lag1'] = l1.fillna(0.0)
    X['lag2'] = l2.fillna(0.0)
    X['ret'] = (ret - 0.6).fillna(0.0)
    X['lag1_ret'] = X.lag1 * X.ret
    X['talent_z'] = rows.talent_z.fillna(0.0)
    X['hc_new'] = rows.hc_new.fillna(0.0)
    X['lag1_hc'] = X.lag1 * X.hc_new
    X['unit_change'] = rows['%s_change' % ('oc' if side == 'off' else 'dc')].fillna(0.0)
    return X[PRIOR_COLS]


def ridge_fit(X, y, w, alpha):
    Xm = np.column_stack([np.ones(len(X)), X])
    A = Xm.T @ (Xm * w[:, None]) + alpha * np.diag([0.0] + [1.0] * X.shape[1])
    b = Xm.T @ (w * y)
    return np.linalg.solve(A, b)


# ------------------------------------------------------------------ main
def run(seasons_out=None, prior_scale=None, halflife=None, write=True, metrics=None, verbose=True):
    t0 = time.time()
    specs = metric_specs()
    if metrics:
        specs = {k: v for k, v in specs.items() if k in metrics}
    prior_scale = C.RATING_PRIOR_SCALE if prior_scale is None else prior_scale
    halflife = C.RECENT_HALFLIFE_WEEKS if halflife is None else halflife
    all_seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    TG, G = load_team_games(all_seasons)
    FBS = fbs_teams_by_season(G)
    RP, TT, CO = load_prior_inputs()

    # ---- 1. variance components from burn-in seasons only
    vc_path = common.out_path('stage3', 'varcomp.json')
    varcomp = {}
    typ_n = {}                   # typical per-game sample size (burn-in), for the volatility prior
    burn = TG[TG.g_season.isin([2009, 2010, 2011])]
    for m, spec in specs.items():
        rr = []
        for S, tg in burn.groupby('g_season'):
            y, n, ok = R.metric_obs(tg, spec[0], spec[1], spec[2])
            teams = set(tg.team_id) | set(tg.opp_id)
            spread = float(np.var(y)) if len(y) else 1.0
            pr = weak_prior(teams, spread, spread)
            _, res = R.fit_metric(tg, m, spec, (spread * np.median(n), spread * 0.5), pr)
            rr.append(res)
        res = pd.concat(rr)
        typ_n[m] = float(np.median(res.n)) if spec[2] != 'game' else 1.0
        s2p, s2g = R.estimate_varcomp(res)
        if spec[2] == 'game':
            s2p = 0.0 + 1e-9
            s2g = float(np.mean(res.res.values ** 2))
            if m.startswith('st_') or m == 'fg_value':
                s2g *= 2.0          # both rows of a zero-sum game are the same observation
        varcomp[m] = (s2p, s2g)
    if write:
        common.write_json(vc_path, {k: list(v) for k, v in varcomp.items()})

    # ---- 2. data-only finals
    final_do = {}
    between = {m: [] for m in specs}
    for S in all_seasons:
        tg = TG[TG.g_season.eq(S)]
        if S == C.LIVE_SEASON or tg.empty:
            continue
        final_do[S] = {}
        for m, spec in specs.items():
            s2p, s2g = varcomp[m]
            y, n, ok = R.metric_obs(tg, spec[0], spec[1], spec[2])
            if ok.sum() < 50:
                continue
            big = float(np.var(y)) * 2.0
            pr = weak_prior(set(tg.team_id) | set(tg.opp_id), big, big)
            fit, _ = R.fit_metric(tg, m, spec, (s2p, s2g), pr, want_var=True)
            final_do[S][m] = {'off': fit.off, 'def': fit['def'],
                              'off_var': fit.off_var, 'def_var': fit.def_var}
            fb = [t for t in fit.index if t in FBS.get(S, set())]
            between[m].append((fit.loc[fb, 'off'].var(), fit.loc[fb, 'def'].var(),
                               fit.loc[fb, 'off_var'].mean(), fit.loc[fb, 'def_var'].mean()))
    if write:
        rows = []
        for S, mm in final_do.items():
            for m, f in mm.items():
                df = pd.DataFrame({'off': f['off'], 'def': f['def'], 'off_var': f['off_var'],
                                   'def_var': f['def_var']})
                df['season'] = S; df['metric'] = m
                rows.append(df.reset_index())
        pd.concat(rows).to_parquet(common.out_path('stage3', 'final_dataonly.parquet'), index=False)

    # true between-team variance (burn-in) as the fallback prior variance
    true_var = {}
    for m, lst in between.items():
        a = np.array(lst[:3]) if lst else np.array([[1, 1, 0, 0]])
        true_var[m] = (max(1e-8, np.mean(a[:, 0] - a[:, 2])), max(1e-8, np.mean(a[:, 1] - a[:, 3])))

    # ---- 3 + 4. per season: priors, then every prediction timestamp
    seasons_out = seasons_out or list(range(C.FIRST_SNAPSHOT_SEASON, C.LIVE_SEASON + 1))
    prior_records = []
    for S in seasons_out:
        fbs = FBS.get(S, set())
        tg_s = TG[TG.g_season.eq(S)]
        g_s = G[G.season.eq(S)]
        teams_s = sorted(set(g_s.home_id) | set(g_s.away_id))
        season_start = g_s.kickoff_ts.min() - pd.Timedelta(days=3)
        priors = {}
        for m, spec in specs.items():
            ps = prior_scale.get(m, prior_scale.get('_default', 2.0)) \
                if isinstance(prior_scale, dict) else prior_scale
            priors[m] = build_prior(S, m, teams_s, fbs, final_do, FBS, RP, TT, CO,
                                    true_var[m], ps, season_start, TG)
            for side in ('o', 'd'):
                for t, (mv,) in priors[m][side].items():
                    prior_records.append((S, m, side, t, mv,
                                          priors[m]['tau2_' + side].get(t)))
        # prediction timestamps: every distinct freeze time among this season's games
        pts = sorted(g_s.prediction_ts.unique())
        out_rows, league_rows = [], []
        for T in pts:
            T = pd.Timestamp(T)
            obs = tg_s[tg_s.kickoff_ts < T]
            assert (obs.kickoff_ts < T).all()
            for m, spec in specs.items():
                s2p, s2g = varcomp[m]
                pr = priors[m]
                if obs.empty:
                    df = pd.DataFrame(index=pd.Index(teams_s, name='team_id'))
                    df['off'] = [pr['o'].get(t, (pr['default_o'],))[0] for t in teams_s]
                    df['def'] = [pr['d'].get(t, (pr['default_d'],))[0] for t in teams_s]
                    df['off_var'] = [pr['tau2_o'].get(t, pr['tau2_default_o']) for t in teams_s]
                    df['def_var'] = [pr['tau2_d'].get(t, pr['tau2_default_d']) for t in teams_s]
                    df['off_rec'] = df.off; df['def_rec'] = df['def']
                    df['n_obs_off'] = 0.0; df['n_obs_def'] = 0.0; df['n_eff_off'] = 0.0
                    mu, h = np.nan, pr['h'][0]
                    res = None
                else:
                    fit, res = R.fit_metric(obs, m, spec, (s2p, s2g), pr, want_var=True)
                    rec, _ = R.fit_metric(obs, m, spec, (s2p, s2g), pr, horizon='recent', T=T,
                                          halflife_weeks=halflife)
                    df = fit
                    df['off_rec'] = rec.off.reindex(df.index)
                    df['def_rec'] = rec['def'].reindex(df.index)
                    mu, h = fit.attrs['mu'], fit.attrs['h']
                if m in CORE_FORM:
                    # the volatility PRIOR (the value residual_volatility shrinks
                    # toward) is defined for every team at every freeze, so a
                    # team with no games yet has its prior volatility — never a
                    # fill computed from other rows (candidate 001 filled these
                    # with a whole-season median in stage 5: a look-ahead)
                    prior_sd = float(np.sqrt(s2p / typ_n[m] + s2g))
                    if res is not None:
                        df['vol'] = R.residual_volatility(res, prior_sd).reindex(df.index).fillna(prior_sd)
                    else:
                        df['vol'] = prior_sd
                if m in CORE_FORM and res is not None:
                    for k in (4, 2):
                        fo, fd = R.residual_form(res, k, shrink_k=2.0)
                        df['l%d_off' % k] = fo.reindex(df.index)
                        df['l%d_def' % k] = fd.reindex(df.index)
                df = df.reset_index()
                df['metric'] = m
                df['prediction_ts'] = T
                df['prior_off'] = df.team_id.map(lambda t: pr['o'].get(t, (pr['default_o'],))[0])
                df['prior_def'] = df.team_id.map(lambda t: pr['d'].get(t, (pr['default_d'],))[0])
                out_rows.append(df)
                league_rows.append((T, m, mu, h, len(obs)))
        R_S = pd.concat(out_rows, ignore_index=True)
        R_S['season'] = S
        L_S = pd.DataFrame(league_rows, columns=['prediction_ts', 'metric', 'mu', 'h', 'n_rows'])
        L_S['season'] = S
        if write:
            R_S.to_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S), index=False)
            L_S.to_parquet(common.out_path('stage3', 'league_%d.parquet' % S), index=False)
        if verbose:
            print('[stage3] %d: %d timestamps, %d rows, %.0fs' % (S, len(pts), len(R_S), time.time() - t0))
    if write:
        pd.DataFrame(prior_records, columns=['season', 'metric', 'side', 'team_id', 'prior_mean',
                                             'prior_var']).to_parquet(
            common.out_path('stage3', 'priors.parquet'), index=False)
    return final_do


def build_prior(S, m, teams_s, fbs, final_do, FBS, RP, TT, CO, true_var, prior_scale,
                season_start, TG):
    """Preseason prior (mean, variance) for every team of season S, metric m.

    FBS teams: ridge prior model trained on target seasons < S.
    Non-FBS teams: the pooled FCS mean/variance of previous seasons' data-only
    ratings — one prior shared by the group, never a team-specific guess."""
    tvo, tvd = true_var
    pr = {'o': {}, 'd': {}, 'tau2_o': {}, 'tau2_d': {}, 'season_start': season_start}
    # home effect prior: mean of previous seasons' fitted h (from data-only fits is not
    # stored; use a weak prior around 0 — the season's own games identify it quickly)
    pr['h'] = (0.0, max(tvo, tvd))
    # FCS pooled prior from the last three completed seasons
    fo, fd = [], []
    for L in (1, 2, 3):
        f = final_do.get(S - L, {}).get(m)
        if f is None:
            continue
        nf = [t for t in f['off'].index if t not in FBS.get(S - L, set())]
        fo.extend(f['off'].loc[nf].values); fd.extend(f['def'].loc[nf].values)
    fcs_o = (float(np.mean(fo)) if fo else 0.0, float(np.var(fo)) if len(fo) > 5 else tvo * 4)
    fcs_d = (float(np.mean(fd)) if fd else 0.0, float(np.var(fd)) if len(fd) > 5 else tvd * 4)
    pr['default_o'], pr['tau2_default_o'] = fcs_o[0], max(fcs_o[1], tvo) * prior_scale
    pr['default_d'], pr['tau2_default_d'] = fcs_d[0], max(fcs_d[1], tvd) * prior_scale
    for t in teams_s:
        if t not in fbs:
            pr['o'][t] = (pr['default_o'],); pr['tau2_o'][t] = pr['tau2_default_o']
            pr['d'][t] = (pr['default_d'],); pr['tau2_d'][t] = pr['tau2_default_d']
    fb = sorted(fbs)
    # training set: target seasons S' < S with a data-only final
    train = []
    for Sp in range(C.FIRST_PBP_SEASON + 1, S):
        tgt = final_do.get(Sp, {}).get(m)
        if tgt is None:
            continue
        rows = prior_frame(Sp, sorted(FBS.get(Sp, set())), final_do, m, RP, TT, CO)
        rows = rows[rows.team_id.isin(tgt['off'].index)]
        rows['y_off'] = rows.team_id.map(tgt['off']); rows['y_def'] = rows.team_id.map(tgt['def'])
        rows['v_off'] = rows.team_id.map(tgt['off_var']); rows['v_def'] = rows.team_id.map(tgt['def_var'])
        train.append(rows)
    cur = prior_frame(S, fb, final_do, m, RP, TT, CO)
    for side, key, tv in (('off', 'o', tvo), ('def', 'd', tvd)):
        if not train:
            for t in fb:
                pr[key][t] = (0.0,); pr['tau2_' + key][t] = tv * prior_scale
            continue
        tr = pd.concat(train, ignore_index=True).dropna(subset=['y_' + side])
        X = prior_design(tr, side).values
        y = tr['y_' + side].values
        # recency weighting of training seasons (portal era differs from 2012)
        w = 0.85 ** (S - 1 - tr.season.values)
        beta = ridge_fit(X, y, w, alpha=2.0 * len(y) * 0.01)
        pred_tr = np.column_stack([np.ones(len(X)), X]) @ beta
        resid = y - pred_tr
        # prior variance = residual variance minus the target's own estimation noise
        tau2 = max(np.average(resid ** 2, weights=w) - np.average(tr['v_' + side].values, weights=w),
                   0.15 * tv)
        # teams with no lagged rating are less predictable: variance by missingness
        miss = tr['%s_lag1' % side].isna().values
        tau2_miss = max(np.mean(resid[miss] ** 2) - np.mean(tr['v_' + side].values[miss]), tau2) \
            if miss.sum() >= 10 else tau2 * 2.0
        Xc = prior_design(cur, side).values
        pc = np.column_stack([np.ones(len(Xc)), Xc]) @ beta
        cmiss = cur['%s_lag1' % side].isna().values
        for t, p, mi in zip(cur.team_id.values, pc, cmiss):
            pr[key][t] = (float(p),)
            pr['tau2_' + key][t] = float((tau2_miss if mi else tau2) * prior_scale)
    return pr


if __name__ == '__main__':
    args = [int(a) for a in sys.argv[1:]]
    run(seasons_out=args or None)
