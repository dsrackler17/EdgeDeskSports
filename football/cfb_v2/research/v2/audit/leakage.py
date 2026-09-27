"""Audit items 5, 6, 7, 8, 9, 10 — point-in-time and leakage checks on the V2.1 build.

    python3 -m v2.audit.leakage        -> $CFB_V2_OUT/audit/leakage.json

A  information set of every opponent-adjusted rating: for every (season, freeze T, team) the
   stored number of observations equals the team's FINAL games that kicked off before T.
B  independent re-solve (plain numpy, written for the audit) of the season-horizon ratings at a
   week-5 freeze from games of weeks 0-4 only, vs the stored ratings; and the same solve with the
   whole season (the leak it must NOT equal) to show the check has power.
C  stage-5 timestamps: feature_ts == prediction_ts < kickoff_ts for every row; the games counts
   carried by each row match the games before its freeze.
D  quarterback: the expected starter at T is the starter of the team's latest game before T;
   'missing' iff no game before T.
E  Elo: an independent implementation of the documented update, compared with stage 4.
F  outcome/market leakage scan: every model input vs final margin, the ATS residual against
   the close (margin - close) and the close itself, plus an automated detector (walk-forward
   gradient boosting on ALL model inputs predicting margin - close).
G  market columns: no market / evaluation / target column inside the pure snapshot table or
   the artifact's column lists.
"""
import json
import os

import numpy as np
import pandas as pd

from . import _io


def _out(*p):
    return os.path.join(_io.out_dir(), *p)


def team_games(S):
    TG = pd.read_parquet(_out('stage1', 'team_game_%d.parquet' % S))
    G = pd.read_parquet(_out('stage2', 'games.parquet'))
    TG = TG.merge(G[['game_id', 'kickoff_ts', 'home_id', 'away_id', 'neutral_site', 'status', 'season']]
                  .rename(columns={'season': 'g_season'}), on='game_id', how='inner')
    TG = TG[TG.status.eq('FINAL') & TG.g_season.eq(S)].copy()
    TG['H'] = np.where(TG.neutral_site, 0.0, np.where(TG.team_id.eq(TG.home_id), 1.0, -1.0))
    return TG


# ------------------------------------------------------------------ A
def information_set():
    """n_obs_off (metric epa) at T == count of the team's FINAL team-game rows with a finite EPA/play
    that kicked off before T — for every season, freeze and team."""
    rows = []
    for S in range(2012, 2027):
        R = pd.read_parquet(_out('stage3', 'ratings_%d.parquet' % S), columns=['team_id', 'metric', 'prediction_ts',
                                                                              'n_obs_off', 'n_obs_def'])
        R = R[R.metric.eq('epa')]
        TG = team_games(S)
        TG = TG[(TG.n_plays > 0) & TG.epa_sum.notna()]
        bad = 0; bad_def = 0; n = 0; bad_ex = []
        for T, r in R.groupby('prediction_ts'):
            b = TG[TG.kickoff_ts < T]
            cnt = b.groupby('team_id').size()
            cntd = b.groupby('opp_id').size()
            exp = r.team_id.map(cnt).fillna(0).values
            expd = r.team_id.map(cntd).fillna(0).values
            m = exp != r.n_obs_off.values
            bad += int(m.sum()); bad_def += int((expd != r.n_obs_def.values).sum()); n += len(r)
            if m.any() and len(bad_ex) < 3:
                bad_ex.append({'T': str(T), 'team': int(r.team_id.values[m][0])})
            # the complementary check: no game at/after T is counted
            later = TG[TG.kickoff_ts >= T].groupby('team_id').size()
            tot = TG.groupby('team_id').size()
        rows.append({'season': S, 'rows': n, 'mismatch_off': bad, 'mismatch_def': bad_def, 'examples': bad_ex})
    return rows


# ------------------------------------------------------------------ B
def solve_dense(TGm, y, n, teams, prior_o, prior_d, var_o, var_d, s2p, s2g, h_fixed):
    """Independent solve: y = mu + h*H + o_off + d_def, h fixed, Gaussian priors on o and d,
    flat mu. Dense normal equations."""
    ix = {t: i for i, t in enumerate(teams)}
    nt = len(teams)
    P = 1 + 2 * nt
    w = 1.0 / (s2p / n + s2g)
    X = np.zeros((len(y), P))
    X[:, 0] = 1.0
    X[np.arange(len(y)), 1 + np.array([ix[t] for t in TGm.team_id])] = 1.0
    X[np.arange(len(y)), 1 + nt + np.array([ix[t] for t in TGm.opp_id])] = 1.0
    yy = y - h_fixed * TGm.H.values
    A = X.T @ (X * w[:, None])
    b = X.T @ (w * yy)
    po = np.array([prior_o[t] for t in teams]); pd_ = np.array([prior_d[t] for t in teams])
    A[1:1 + nt, 1:1 + nt] += np.diag(1.0 / np.array([var_o[t] for t in teams]))
    A[1 + nt:, 1 + nt:] += np.diag(1.0 / np.array([var_d[t] for t in teams]))
    b[1:1 + nt] += po / np.array([var_o[t] for t in teams])
    b[1 + nt:] += pd_ / np.array([var_d[t] for t in teams])
    x = np.linalg.solve(A, b)
    return pd.DataFrame({'off': x[1:1 + nt], 'def': x[1 + nt:]}, index=pd.Index(teams, name='team_id')), x[0]


METRIC_SPEC = {'epa': ('epa_sum', 'n_plays'), 'epa_pass': ('epa_pass_sum', 'n_db'), 'sr': ('succ', 'n_plays'),
               'ppd': ('drive_pts', 'n_drives')}


def resolve(S, k_freeze=5, metrics=('epa', 'epa_pass', 'sr', 'ppd')):
    R = pd.read_parquet(_out('stage3', 'ratings_%d.parquet' % S))
    L = pd.read_parquet(_out('stage3', 'league_%d.parquet' % S))
    PR = pd.read_parquet(_out('stage3', 'priors.parquet'))
    PR = PR[PR.season.eq(S)]
    vc = json.load(open(_out('stage3', 'varcomp.json')))
    TG = team_games(S)
    Ts = sorted(R.prediction_ts.unique())
    T = pd.Timestamp(Ts[k_freeze])
    out = {'season': S, 'freeze': str(T), 'freeze_index': k_freeze, 'metrics': {}}
    for m in metrics:
        num, den = METRIC_SPEC[m]
        s2p, s2g = vc[m]
        pm = PR[PR.metric.eq(m)]
        po = pm[pm.side.eq('o')].set_index('team_id')
        pdd = pm[pm.side.eq('d')].set_index('team_id')
        teams = sorted(set(po.index) | set(TG.team_id) | set(TG.opp_id))
        prior_o = {t: float(po.prior_mean.get(t, np.nan)) for t in teams}
        prior_d = {t: float(pdd.prior_mean.get(t, np.nan)) for t in teams}
        var_o = {t: float(po.prior_var.get(t, np.nan)) for t in teams}
        var_d = {t: float(pdd.prior_var.get(t, np.nan)) for t in teams}
        stored = R[R.metric.eq(m) & R.prediction_ts.eq(T)].set_index('team_id')
        h = float(L[L.metric.eq(m) & L.prediction_ts.eq(T)].h.iloc[0])
        res = {}
        for label, sub in (('weeks_before_T', TG[TG.kickoff_ts < T]), ('whole_season_LEAK', TG)):
            n = sub[den].astype(float)
            y = sub[num].astype(float) / n.where(n > 0)
            ok = y.notna() & np.isfinite(y) & (n > 0)
            s = sub[ok]
            mine, mu = solve_dense(s, y[ok].values, n[ok].values, teams, prior_o, prior_d, var_o, var_d, s2p, s2g, h)
            j = mine.join(stored[['off', 'def', 'n_obs_off']], rsuffix='_stored', how='inner')
            fb = j.index.isin(TG[TG.kickoff_ts < T].team_id.unique())
            sd = float(stored.loc[stored.index.isin(TG.team_id.unique()), 'off'].std())
            res[label] = {'n_obs_rows': int(ok.sum()), 'max_abs_diff_off': float((j.off - j.off_stored).abs().max()),
                          'max_abs_diff_def': float((j['def'] - j.def_stored).abs().max()),
                          'mean_abs_diff_off_in_sd': float((j.off - j.off_stored).abs()[fb].mean() / sd),
                          'rating_sd_off': sd}
        out['metrics'][m] = res
    return out


# ------------------------------------------------------------------ C
def stage5_timestamps():
    X = pd.read_parquet(_out('stage5', 'cfb_model_training_snapshots.parquet'),
                        columns=['game_id', 'season', 'kickoff_ts', 'prediction_ts', 'feature_ts', 'home_id', 'away_id',
                                 'home_games', 'away_games', 'status'])
    r = {'rows': int(len(X)),
         'feature_ts_ne_prediction_ts': int((X.feature_ts != X.prediction_ts).sum()),
         'prediction_ts_not_before_kickoff': int((X.prediction_ts >= X.kickoff_ts).sum()),
         'lead_hours_min': float(((X.kickoff_ts - X.prediction_ts).dt.total_seconds() / 3600).min()),
         'lead_hours_max': float(((X.kickoff_ts - X.prediction_ts).dt.total_seconds() / 3600).max()),
         'duplicate_game_rows': int(X.game_id.duplicated().sum())}
    # games-before-T counts from the SCHEDULE (FINAL games incl. those without PBP)
    mism = 0; nopbp = 0
    for S, g in X.groupby('season'):
        TG = team_games(S)
        TG = TG[(TG.n_plays > 0) & TG.epa_sum.notna()]
        for T, gg in g.groupby('prediction_ts'):
            c = TG[TG.kickoff_ts < T].groupby('team_id').size()
            mism += int((gg.home_id.map(c).fillna(0).values != gg.home_games.values).sum())
            mism += int((gg.away_id.map(c).fillna(0).values != gg.away_games.values).sum())
    r['games_before_T_mismatch'] = mism
    G = pd.read_parquet(_out('stage2', 'games.parquet'))
    fin = G[G.status.eq('FINAL')]
    tgs = pd.concat([pd.read_parquet(_out('stage1', 'team_game_%d.parquet' % S), columns=['game_id'])
                     for S in range(2009, 2027)]).game_id.unique()
    r['final_games_without_pbp_rows'] = int((~fin.game_id.isin(tgs)).sum())
    r['final_fbs_fbs_games_without_pbp_by_season'] = fin[~fin.game_id.isin(tgs) & ~fin.fcs_game].groupby('season').size().to_dict()
    return r


# ------------------------------------------------------------------ D
def qb_point_in_time():
    Qt = pd.read_parquet(_out('stage4', 'qb_team.parquet'))
    G = pd.read_parquet(_out('stage2', 'games.parquet'))[['game_id', 'kickoff_ts', 'status']]
    out = {'rows': int(len(Qt)), 'checked': 0, 'expected_starter_mismatch': 0, 'missing_flag_mismatch': 0,
           'examples': []}
    for S, q in Qt.groupby('season'):
        Q = pd.read_parquet(_out('stage1', 'qb_game_%d.parquet' % S)).merge(G, on='game_id')
        Q = Q[Q.status.eq('FINAL')]
        st = Q[Q.starter].sort_values('kickoff_ts')
        for T, qq in q.groupby('prediction_ts'):
            b = st[st.kickoff_ts < T]
            last = b.groupby('team_id').tail(1).set_index('team_id').qb_id
            anyg = Q[Q.kickoff_ts < T].groupby('team_id').size()
            has = qq.team_id.map(anyg).fillna(0).values > 0
            out['missing_flag_mismatch'] += int(((qq.qb_missing.values == 0) != has).sum())
            k = qq[qq.qb_missing.eq(0)]
            exp = k.team_id.map(last)
            mm = (exp.notna()) & (exp.values != k.qb_id.values)
            out['checked'] += int(len(k))
            out['expected_starter_mismatch'] += int(mm.sum())
            if mm.any() and len(out['examples']) < 5:
                out['examples'].append({'season': int(S), 'T': str(T), 'team': int(k.team_id.values[mm.values][0])})
    return out


# ------------------------------------------------------------------ E
def elo_independent():
    """Re-implementation of the documented Elo (K 50, HFA 70, carry 1.0, MOV cap 35) from scores only."""
    from v2 import config as C
    G = pd.read_parquet(_out('stage2', 'games.parquet')).sort_values(['kickoff_ts', 'game_id'])
    E = pd.read_parquet(_out('stage4', 'elo.parquet')).set_index('game_id')
    fbs = {S: set(g.loc[g.home_fbs, 'home_id']) | set(g.loc[g.away_fbs, 'away_id']) for S, g in G.groupby('season')}
    K, HFA, CAP = C.ELO_K, C.ELO_HFA, C.ELO_MOV_CAP
    elo, season = {}, None
    snaps = {}
    games = G.to_dict('records')
    gi = 0
    for T in sorted(G.prediction_ts.unique()):
        while gi < len(games) and games[gi]['kickoff_ts'] < T:
            g = games[gi]; gi += 1
            if g['season'] != season:
                if season is not None:
                    fb = [t for t in elo if t in fbs[season]]
                    m = np.mean([elo[t] for t in fb])
                    for t in list(elo):
                        if t in fbs.get(g['season'], set()):
                            elo[t] = 1500 + (elo[t] - m) if t in fb else 1350.0
                season = g['season']
            if g['status'] != 'FINAL':
                continue
            h, a = g['home_id'], g['away_id']
            eh = elo.get(h, 1500.0 if h in fbs[g['season']] else 1150.0)
            ea = elo.get(a, 1500.0 if a in fbs[g['season']] else 1150.0)
            d = eh - ea + (0 if g['neutral_site'] else HFA)
            pe = 1 / (1 + 10 ** (-d / 400))
            mg = g['margin']
            res = 1.0 if mg > 0 else (0.0 if mg < 0 else 0.5)
            wd = d if mg > 0 else -d
            mult = np.log(min(abs(mg), CAP) + 1) * 2.2 / (2.2 + 0.001 * wd)
            dl = K * mult * (res - pe)
            elo[h] = eh + dl; elo[a] = ea - dl
        snaps[pd.Timestamp(T)] = dict(elo)
    diffs = []
    for g in games:
        s = snaps[pd.Timestamp(g['prediction_ts'])]
        fb = fbs[g['season']]
        eh = s.get(g['home_id'], 1500.0 if g['home_id'] in fb else 1150.0)
        ea = s.get(g['away_id'], 1500.0 if g['away_id'] in fb else 1150.0)
        if g['game_id'] in E.index:
            diffs.append(abs(eh - E.loc[g['game_id'], 'elo_home']) + abs(ea - E.loc[g['game_id'], 'elo_away']))
    return {'games': len(diffs), 'max_abs_diff_elo_pts': float(np.max(diffs)), 'n_diff_gt_1e6': int(np.sum(np.array(diffs) > 1e-6))}


# ------------------------------------------------------------------ F
def outcome_scan():
    import lightgbm as lgb
    art = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'artifacts', 'edgedesk_cfb_v2.1.0',
                                      'models.json')))
    cols = sorted(set(art['submodels']['C_ridge']['cols']) | set(art['submodels']['D_gbm']['cols']))
    M = _io.preds()
    from v2 import models as MD
    Xd = MD.add_derived(M)
    w = Xd[Xd.season.between(2014, 2025) & Xd.status.eq('FINAL') & ~Xd.fcs_game & Xd.close_margin.notna()].copy()
    w['ats_close'] = w.margin - w.close_margin
    w['ats_open'] = w.margin - w.line
    rows = []
    for c in cols:
        x = w[c].astype(float)
        ok = x.notna()
        r = lambda t: float(np.corrcoef(x[ok], w.loc[ok, t])[0, 1]) if x[ok].std() > 0 else np.nan
        rows.append({'feature': c, 'n': int(ok.sum()), 'corr_margin': r('margin'), 'corr_close': r('close_margin'),
                     'corr_ats_close': r('ats_close'),
                     'corr_ats_open': r('ats_open') if w.loc[ok, 'line'].notna().all() else
                     float(np.corrcoef(x[ok & w.line.notna()], w.loc[ok & w.line.notna(), 'ats_open'])[0, 1])})
    F = pd.DataFrame(rows)
    se = 1.0 / np.sqrt(F.n)
    F['ats_close_z'] = F.corr_ats_close / se
    thr_ats = 0.08
    close_r2 = float(np.corrcoef(w.close_margin, w.margin)[0, 1] ** 2)
    # automated detector: walk-forward GBM on ALL model inputs predicting margin - close
    det = {}
    pred = pd.Series(np.nan, index=w.index)
    for S in range(2016, 2026):
        tr = w[w.season < S]; te = w.season.eq(S)
        b = lgb.train(dict(objective='l2', num_leaves=15, learning_rate=0.05, min_data_in_leaf=50, verbose=-1,
                           seed=_io.SEED, num_threads=1, deterministic=True, force_row_wise=True),
                      lgb.Dataset(tr[cols].astype(float).values, label=tr.ats_close.values), num_boost_round=200)
        pred[te] = b.predict(w.loc[te, cols].astype(float).values)
    ok = pred.notna()
    y = w.loc[ok, 'ats_close']
    det['oos_r2_vs_zero'] = float(1 - ((y - pred[ok]) ** 2).sum() / (y ** 2).sum())
    det['oos_r2_vs_mean'] = float(1 - ((y - pred[ok]) ** 2).sum() / ((y - y.mean()) ** 2).sum())
    det['corr_pred_actual'] = float(np.corrcoef(pred[ok], y)[0, 1])
    det['n'] = int(ok.sum())
    return {'n_games': int(len(w)), 'close_r2_with_margin': close_r2,
            'max_single_feature_r2_with_margin': float((F.corr_margin ** 2).max()),
            'features_r2_above_close': F[F.corr_margin ** 2 > close_r2].feature.tolist(),
            'features_abs_corr_ats_close_gt_%.2f' % thr_ats: F[F.corr_ats_close.abs() > thr_ats].feature.tolist(),
            'top_abs_corr_ats_close': F.reindex(F.corr_ats_close.abs().sort_values(ascending=False).index)
                .head(8)[['feature', 'corr_ats_close', 'ats_close_z', 'corr_margin']].to_dict('records'),
            'detector_gbm_all_inputs_to_margin_minus_close': det,
            'table': F.round(4).to_dict('records')}


# ------------------------------------------------------------------ G
def market_columns():
    from v2 import contract as K
    X = pd.read_parquet(_out('stage5', 'cfb_model_training_snapshots.parquet'))
    layers = {c: K.layer_of(c) for c in X.columns}
    bad = {c: l for c, l in layers.items() if l in ('market', 'evaluation')}
    art = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'artifacts', 'edgedesk_cfb_v2.1.0',
                                      'models.json')))
    used = set(art['submodels']['C_ridge']['cols']) | set(art['submodels']['D_gbm']['cols']) | \
        set(art['submodels']['TotalE']['cols']) | set(art['sigma_model']['cols'])
    nonpure = {c: K.layer_of(c) for c in used if K.layer_of(c) != 'pure'}
    unknown_in_table = sorted(c for c, l in layers.items() if l == 'unknown')
    kw = [c for c in X.columns if any(s in c.lower() for s in ('spread', 'line', 'close', 'open', 'odds', 'price',
                                                               'wp', 'elo_', 'rank', 'weather', 'wind', 'temp'))]
    return {'market_or_eval_cols_in_pure_table': bad, 'artifact_nonpure_inputs': nonpure,
            'unknown_layer_cols_in_table': unknown_in_table[:50], 'n_unknown': len(unknown_in_table),
            'keyword_hits_in_pure_table': kw}


def main():
    out = {'doc': __doc__}
    out['A_information_set'] = information_set()
    print('A', sum(r['mismatch_off'] for r in out['A_information_set']), 'mismatches over',
          sum(r['rows'] for r in out['A_information_set']), flush=True)
    out['B_resolve'] = [resolve(S) for S in (2016, 2019, 2022, 2024, 2025)]
    for r in out['B_resolve']:
        print('B', r['season'], r['freeze'], {m: (round(v['weeks_before_T']['max_abs_diff_off'], 8),
                                                   round(v['whole_season_LEAK']['mean_abs_diff_off_in_sd'], 3))
                                               for m, v in r['metrics'].items()}, flush=True)
    out['C_stage5_timestamps'] = stage5_timestamps()
    print('C', out['C_stage5_timestamps'], flush=True)
    out['D_qb'] = qb_point_in_time()
    print('D', out['D_qb'], flush=True)
    out['E_elo'] = elo_independent()
    print('E', out['E_elo'], flush=True)
    out['F_outcome_scan'] = outcome_scan()
    f = out['F_outcome_scan']
    print('F close r2', f['close_r2_with_margin'], 'max single r2', f['max_single_feature_r2_with_margin'],
          'above close', f['features_r2_above_close'], 'ats>thr', f['features_abs_corr_ats_close_gt_0.08'],
          'detector', f['detector_gbm_all_inputs_to_margin_minus_close'])
    print('F top', f['top_abs_corr_ats_close'])
    out['G_market_columns'] = market_columns()
    print('G', {k: v for k, v in out['G_market_columns'].items() if k != 'unknown_layer_cols_in_table'})
    _io.write('leakage.json', out)


if __name__ == '__main__':
    main()
