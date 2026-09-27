"""Audit items 36-39, 54-61, 71-74 — calibration, reliability, intervals, subgroups, QB change, tails.

    python3 -m v2.audit.accuracy     -> $CFB_V2_OUT/audit/accuracy.json, worst50.csv, best50.csv, tails.csv

All on the stored walk-forward predictions of V2.1 (stage 7), FBS-vs-FBS FINAL unless stated.
Residual convention: r = margin - ens_pred (+ = home did better than projected). Team-oriented
residual: + = the team did better than projected.
"""
import json
import os

import numpy as np
import pandas as pd

from . import _io

P4 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}


def load():
    M = _io.preds().copy()
    M['r'] = M.margin - M.ens_pred
    M['ae'] = M.r.abs()
    # partial / cancelled games (F-01): flag with the provider completed flag
    M['completed_flag'] = M.completed.fillna(False).astype(bool)
    return M


def qb_states(M):
    """Actual starter of each team-game (first dropback, stage 1) vs the snapshot's expected
    starter (the starter of the team's latest game before the freeze)."""
    rows = []
    for S in sorted(M.season.unique()):
        f = os.path.join(_io.out_dir(), 'stage1', 'qb_game_%d.parquet' % S)
        q = pd.read_parquet(f, columns=['game_id', 'team_id', 'qb_id', 'starter', 'db'])
        rows.append(q[q.starter])
    Q = pd.concat(rows).drop_duplicates(['game_id', 'team_id'])
    X = pd.read_parquet(os.path.join(_io.out_dir(), 'stage5', 'cfb_model_training_snapshots.parquet'),
                        columns=['game_id', 'h_qb_id', 'a_qb_id', 'h_qb_missing', 'a_qb_missing', 'h_qb_exp_starts',
                                 'a_qb_exp_starts', 'kickoff_ts', 'season', 'home_id', 'away_id'])
    # prior starts THIS season of the actual starter (before this game)
    allq = []
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'), columns=['game_id', 'kickoff_ts', 'season'])
    Qk = Q.merge(G, on='game_id').sort_values('kickoff_ts')
    Qk['prior_starts_season'] = Qk.groupby(['season', 'team_id', 'qb_id']).cumcount()
    Qk['prior_starts_career'] = Qk.groupby(['qb_id']).cumcount()
    act = Qk.set_index(['game_id', 'team_id'])
    out = X[['game_id']].copy()
    for side, tid, eq, miss in (('h', 'home_id', 'h_qb_id', 'h_qb_missing'), ('a', 'away_id', 'a_qb_id', 'a_qb_missing')):
        k = pd.MultiIndex.from_arrays([X.game_id.values, X[tid].values])
        a_id = act.qb_id.reindex(k).values
        ps = act.prior_starts_season.reindex(k).values
        pc = act.prior_starts_career.reindex(k).values
        st = np.where(np.isnan(a_id.astype(float)), 'no_pbp_starter',
                      np.where(X[miss].fillna(1).values > 0, 'week1_unknown',
                               np.where(a_id == X[eq].values, 'same_starter',
                                        np.where(pc == 0, 'change_first_career_start',
                                                 np.where(ps > 0, 'change_starter_returning', 'change_new_this_season')))))
        out[side + '_qb_state'] = st
    def game_state(h, a):
        s = {h, a}
        if 'change_first_career_start' in s:
            return 'change_first_career_start'
        if 'change_new_this_season' in s:
            return 'change_new_this_season'
        if 'change_starter_returning' in s:
            return 'change_starter_returning'
        if 'week1_unknown' in s:
            return 'week1_unknown'
        if 'no_pbp_starter' in s:
            return 'no_pbp_starter'
        return 'same_starter'
    out['qb_state'] = [game_state(h, a) for h, a in zip(out.h_qb_state, out.a_qb_state)]
    return out


def bias_table(w, key, min_n=30):
    t = {}
    for k, g in w.groupby(key):
        if len(g) < min_n:
            continue
        r = g.r.values
        se = r.std(ddof=1) / np.sqrt(len(r))
        cov80 = float(((g.margin >= g.lo_80) & (g.margin <= g.hi_80)).mean()) if g.lo_80.notna().all() else None
        e = {'n': int(len(g)), 'bias_mean_r': float(r.mean()), 'bias_ci': [float(r.mean() - 1.96 * se), float(r.mean() + 1.96 * se)],
             't': float(r.mean() / se) if se > 0 else None, 'mae_v2': float(np.abs(r).mean()), 'cov80': cov80,
             'mean_sigma': float(g.sigma.mean()) if g.sigma.notna().any() else None}
        c = g.close_margin.notna()
        if c.sum() >= min_n:
            e['mae_close_same'] = float((g.close_margin - g.margin)[c].abs().mean())
            e['mae_v2_same'] = float(g.ae[c].mean())
            e['bias_close_mean'] = float((g.margin - g.close_margin)[c].mean())
        t[str(k)] = e
    return t


def team_bias(w):
    """Team-oriented residual per team (home rows +r, away rows -r), with a Bonferroni screen."""
    h = pd.DataFrame({'team': w.home_team, 'tr': w.r, 'season': w.season, 'cl': w.margin - w.close_margin})
    a = pd.DataFrame({'team': w.away_team, 'tr': -w.r, 'season': w.season, 'cl': -(w.margin - w.close_margin)})
    T = pd.concat([h, a])
    g = T.groupby('team').agg(n=('tr', 'size'), mean=('tr', 'mean'), sd=('tr', 'std'), close_mean=('cl', 'mean'),
                              seasons=('season', 'nunique'))
    g = g[g.n >= (30 if w.season.nunique() > 2 else 20)]
    if g.empty:
        return {'teams_tested': 0}
    g['t'] = g['mean'] / (g.sd / np.sqrt(g.n))
    from scipy import stats
    g['p'] = 2 * stats.t.sf(g.t.abs(), g.n - 1)
    g['bonferroni_sig'] = g.p < 0.05 / len(g)
    top = g.reindex(g.t.abs().sort_values(ascending=False).index).head(15)
    return {'teams_tested': int(len(g)), 'bonferroni_significant': g[g.bonferroni_sig].index.tolist(),
            'expected_false_positives_at_p05': round(0.05 * len(g), 1),
            'share_p_lt_05': float((g.p < 0.05).mean()),
            'top15_by_abs_t': top.round(3).reset_index().to_dict('records')}


def calibration(M):
    out = {}
    for name, ss in (('dev_2017_2023', range(2017, 2024)), ('holdout_2024_2025', _io.HOLD), ('live_2026_replay', _io.LIVE)):
        w = M[M.season.isin(ss) & M.status.eq('FINAL') & ~M.fcs_game & M.p_home_raw.notna()]
        y = (w.margin > 0).astype(float).values
        out[name] = {'win_raw_shipped': _io.prob_metrics(y, w.p_home_raw.values),
                     'win_v1': _io.prob_metrics(y[w.base_v1_winprob.notna().values], w.base_v1_winprob.dropna().values)
                     if w.base_v1_winprob.notna().sum() > 50 else None}
        c = w[w.pc_home_cal.notna() & (w.margin != w.line)]
        yc = (c.margin > c.line).astype(float).values
        if len(c) > 50:
            out[name]['cover_calibrated_at_open'] = _io.prob_metrics(yc, c.pc_home_cal.values, bins=10)
            out[name]['cover_raw_at_open'] = _io.prob_metrics(yc, c.pc_home_raw.values, bins=10)
            out[name]['cover_coin_flip_log_loss'] = float(np.log(2))
            ps = np.maximum(c.pc_home_cal.values, 1 - c.pc_home_cal.values)
            pr = np.maximum(c.pc_home_raw.values, 1 - c.pc_home_raw.values)
            out[name]['cover_extremes'] = {
                'calibrated_max_side_prob': float(ps.max()), 'calibrated_n_ge_0.60': int((ps >= 0.6).sum()),
                'raw_n_ge_0.70': int((pr >= 0.70).sum()), 'raw_n_ge_0.75': int((pr >= 0.75).sum()),
                'raw_n_ge_0.80': int((pr >= 0.80).sum()),
                'raw_ge_0.70_side_won_share': float(((c.pc_home_raw >= 0.7) & (c.margin > c.line) |
                                                     (c.pc_home_raw <= 0.3) & (c.margin < c.line))[pr >= 0.7].mean())
                if (pr >= 0.7).any() else None}
    return out


def reliability(M):
    out = {}
    for name, ss in (('dev_2017_2023', range(2017, 2024)), ('holdout_2024_2025', _io.HOLD)):
        w = M[M.season.isin(ss) & M.status.eq('FINAL') & ~M.fcs_game & M.reliability.notna()].copy()
        w['rb'] = pd.cut(w.reliability, [-1, 40, 60, 75, 90, 101], labels=['<40', '40-60', '60-75', '75-90', '90+'])
        t = {}
        for k, g in w.groupby('rb', observed=True):
            y = (g.margin > 0).astype(float)
            ae = g.ae.values
            I = _io.boot_idx(len(ae), 1000)
            t[str(k)] = {'n': int(len(g)), 'mae': float(ae.mean()), 'mae_ci': _io.ci(ae[I].mean(axis=1)),
                         'cov80': float(((g.margin >= g.lo_80) & (g.margin <= g.hi_80)).mean()),
                         'cov50': float(((g.margin >= g.lo_50) & (g.margin <= g.hi_50)).mean()),
                         'brier': float(((g.p_home_raw - y) ** 2).mean()),
                         'mae_close_same': float((g.close_margin - g.margin).abs()[g.close_margin.notna()].mean())}
        from scipy import stats
        rho = stats.spearmanr(w.reliability, w.ae)
        # does reliability add anything over |ens_pred| alone? MAE by reliability within |pred| terciles
        w['pt'] = pd.qcut(w.ens_pred.abs(), 3, labels=['small', 'mid', 'large'])
        within = {str(p): stats.spearmanr(g.reliability, g.ae).correlation for p, g in w.groupby('pt', observed=True)}
        out[name] = {'by_bucket': t, 'spearman_reliability_vs_abs_error': [float(rho.correlation), float(rho.pvalue)],
                     'spearman_within_abs_pred_terciles': within, 'n': int(len(w))}
    return out


def intervals(M, qbs):
    w = M[M.season.isin(list(range(2017, 2027))) & M.status.eq('FINAL') & ~M.fcs_game & M.lo_80.notna()].copy()
    w = w.merge(qbs[['game_id', 'qb_state']], on='game_id', how='left')
    w['win'] = np.where(w.season <= 2023, 'dev', np.where(w.season <= 2025, 'holdout', 'live'))
    w['wk'] = pd.cut(w.weeks_in, [-1, 2, 5, 9, 30], labels=['wk0-2', 'wk3-5', 'wk6-9', 'wk10+']).astype(str)
    w.loc[w.is_postseason, 'wk'] = 'postseason'
    w['spread'] = pd.cut(w.ens_pred.abs(), [-0.1, 3, 7, 14, 21, 99], labels=['0-3', '3-7', '7-14', '14-21', '21+']).astype(str)
    def cov(g):
        d = {'n': int(len(g))}
        for q in (50, 80, 95):
            ins = ((g.margin >= g['lo_%d' % q]) & (g.margin <= g['hi_%d' % q])).astype(float)
            lo, hi = _io.wilson(float(ins.mean()), len(g))
            d['cov%d' % q] = float(ins.mean()); d['cov%d_ci' % q] = [lo, hi]
        d['mean_width80'] = float((g.hi_80 - g.lo_80).mean())
        return d
    out = {}
    for key in ('season', 'win', 'wk', 'spread', 'qb_state'):
        out[key] = {str(k): cov(g) for k, g in w.groupby(key) if len(g) >= 30}
    # FCS games separately
    f = M[M.status.eq('FINAL') & M.fcs_game & M.lo_80.notna() & M.season.between(2017, 2026)]
    out['fbs_vs_fcs'] = {str(k): dict(cov(g), bias_fbs_side=float(np.where(g.home_fbs, g.r, -g.r).mean()),
                                       mae=float(g.ae.mean())) for k, g in f.groupby(np.where(f.season <= 2023, 'dev', np.where(f.season <= 2025, 'holdout', 'live')))}
    return out


def subgroups(M, qbs):
    out = {}
    for name, ss in (('dev_2016_2023', _io.DEV), ('holdout_2024_2025', _io.HOLD), ('dev_plus_holdout', _io.DEV + _io.HOLD)):
        w = M[M.season.isin(ss) & M.status.eq('FINAL') & ~M.fcs_game].copy()
        w = w.merge(qbs[['game_id', 'qb_state']], on='game_id', how='left')
        hp, ap = w.home_conference.isin(P4), w.away_conference.isin(P4)
        w['p4g5'] = np.where(hp & ap, 'P4vP4', np.where(hp & ~ap, 'P4home_vs_G5', np.where(~hp & ap, 'G5home_vs_P4', 'G5vG5')))
        w['site'] = np.where(w.neutral_site, 'neutral', 'home_site')
        w['fav'] = pd.cut(-w.close_margin.abs(), [-99, -21, -14, -7, -3, 0.1],
                          labels=['close fav 21+', '14-21', '7-14', '3-7', '0-3']).astype(str)
        w['wk'] = np.where(w.is_postseason, 'postseason', pd.cut(w.weeks_in, [-1, 4.99, 30], labels=['weeks0-4', 'weeks5+']).astype(str))
        w['bowl'] = np.where(w.is_postseason, 'postseason', 'regular')
        o = {}
        for key in ('home_conference', 'p4g5', 'site', 'fav', 'wk', 'bowl', 'qb_state'):
            o[key] = bias_table(w, key)
        # conference seen from the team (home and away rows)
        h = pd.DataFrame({'conf': w.home_conference, 'r': w.r, 'margin': w.margin, 'close_margin': w.close_margin,
                          'lo_80': w.lo_80, 'hi_80': w.hi_80, 'sigma': w.sigma, 'ae': w.ae})
        a = pd.DataFrame({'conf': w.away_conference, 'r': -w.r, 'margin': -w.margin, 'close_margin': -w.close_margin,
                          'lo_80': -w.hi_80, 'hi_80': -w.lo_80, 'sigma': w.sigma, 'ae': w.ae})
        o['team_conference_oriented'] = bias_table(pd.concat([h, a]), 'conf', min_n=60)
        # favourite side of the market: residual oriented to the market favourite
        c = w[w.close_margin.notna() & (w.close_margin != 0)].copy()
        sgn = np.sign(c.close_margin)
        c['r_fav'] = c.r * sgn
        c['bucket'] = pd.cut(c.close_margin.abs(), [0, 3, 7, 14, 21, 28, 99], labels=['0-3', '3-7', '7-14', '14-21', '21-28', '28+'])
        o['favourite_oriented'] = {str(k): {'n': int(len(g)), 'mean_resid_fav_side': float(g.r_fav.mean()),
                                            'ci': [float(g.r_fav.mean() - 1.96 * g.r_fav.std() / np.sqrt(len(g))),
                                                   float(g.r_fav.mean() + 1.96 * g.r_fav.std() / np.sqrt(len(g)))],
                                            'close_resid_fav_side': float(((c.margin - c.close_margin) * sgn)[g.index].mean()),
                                            'mae_v2': float(g.ae.mean()),
                                            'mae_close': float((g.margin - g.close_margin).abs().mean())}
                                   for k, g in c.groupby('bucket', observed=True)}
        o['team_specific'] = team_bias(w)
        out[name] = o
    return out


def tails(M, qbs, imm_pbp_bad):
    w = M[M.season.isin(list(range(2016, 2027))) & M.status.eq('FINAL') & ~M.fcs_game].copy()
    w = w.merge(qbs[['game_id', 'qb_state', 'h_qb_state', 'a_qb_state']], on='game_id', how='left')
    w['pbp_incomplete'] = w.game_id.isin(imm_pbp_bad)
    w['close_ae'] = (w.close_margin - w.margin).abs()
    w['open_ae'] = (w.line - w.margin).abs()

    def cls(r):
        if not r.completed_flag:
            return 'data_bug (provider completed=False: partial or cancelled game scored as final)'
        if r.pbp_incomplete:
            return 'data_bug (play-by-play incomplete for this game)'
        if isinstance(r.qb_state, str) and r.qb_state.startswith('change'):
            return 'information_unavailable (starting QB differed from the expected starter)'
        if pd.notna(r.close_margin) and r.close_ae <= r.ae - 10:
            return 'model_issue (the close was >= 10 pts closer to the result)'
        return 'ordinary_variance (the market missed by a similar amount)'
    w['miss_class'] = [cls(r) for r in w.itertuples()]
    out = {}
    for thr in (20, 30):
        t = w[w.ae >= thr]
        out['ge_%d' % thr] = {'n': int(len(t)), 'share_of_games': float(len(t) / len(w)),
                              'classes': t.miss_class.value_counts().to_dict(),
                              'close_also_missed_by_thr': int((t.close_ae >= thr).sum()),
                              'n_with_close': int(t.close_margin.notna().sum()),
                              'by_window': t.groupby(np.where(t.season <= 2023, 'dev', np.where(t.season <= 2025, 'holdout', 'live'))).size().to_dict()}
        # Normal/t reference: expected share of |z| beyond thr/sigma
        from scipy import stats
        exp = float(np.mean(2 * stats.norm.sf(thr / w.sigma.dropna())))
        out['ge_%d' % thr]['expected_share_under_normal_sigma'] = exp
        out['ge_%d' % thr]['observed_share_with_sigma'] = float((w.ae[w.sigma.notna()] >= thr).mean())
    cols = ['game_id', 'season', 'week', 'home_team', 'away_team', 'ens_pred', 'line', 'close_margin', 'margin', 'r',
            'ae', 'close_ae', 'qb_state', 'ens_sd', 'sigma', 'reliability', 'miss_class', 'completed_flag']
    W = w.sort_values('ae', ascending=False).head(50)[cols].copy()
    for c in ('ens_pred', 'line', 'close_margin'):
        W[c + '_book'] = -W[c]                     # book convention for display (- = home favoured)
    W.to_csv(_io.audit_path('worst50.csv'), index=False)
    # best 50: smallest error, and what kind of games they are
    B = w[w.close_margin.notna()].sort_values('ae').head(50)[cols].copy()
    B['easy_favourite'] = B.close_margin.abs() >= 14
    B.to_csv(_io.audit_path('best50.csv'), index=False)
    w[w.ae >= 20][cols].to_csv(_io.audit_path('tails_ge20.csv'), index=False)
    out['worst50_summary'] = {'classes': W.miss_class.value_counts().to_dict(),
                              'close_missed_by_20_plus': int((W.close_ae >= 20).sum()),
                              'mean_close_ae': float(W.close_ae.mean()), 'mean_v2_ae': float(W.ae.mean()),
                              'qb_state': W.qb_state.value_counts().to_dict(),
                              'mean_ens_sd': float(W.ens_sd.mean()), 'all_games_mean_ens_sd': float(w.ens_sd.mean()),
                              'mean_reliability': float(W.reliability.mean()), 'all_mean_reliability': float(w.reliability.mean())}
    out['best50_summary'] = {'share_close_fav_14_plus': float(B.easy_favourite.mean()),
                             'all_games_share_close_fav_14_plus': float((w.close_margin.abs() >= 14).mean()),
                             'mean_close_ae': float(B.close_ae.mean()), 'v2_beat_close_share': float((B.ae < B.close_ae).mean()),
                             'mean_abs_close_line': float(B.close_margin.abs().mean()),
                             'all_mean_abs_close_line': float(w.close_margin.abs().mean())}
    # is V2's "best" better than chance? share of all games with ae <= max(best50 ae)
    return out


def main():
    M = load()
    qbs = qb_states(M)
    imm = json.load(open(_io.audit_path('immutability.json'))) if os.path.exists(_io.audit_path('immutability.json')) else None
    # games whose PBP final score disagrees with the schedule (recomputed here, cheap)
    bad = []
    for S in range(2016, 2027):
        p = pd.read_parquet(os.path.join(os.environ.get('CFB_V2_DATA', 'data'), 'pbp', 'play_by_play_%d.parquet' % S),
                            columns=['game_id', 'end.homeScore', 'end.awayScore'])
        p['game_id'] = pd.to_numeric(p.game_id, errors='coerce')
        last = p.groupby('game_id')[['end.homeScore', 'end.awayScore']].max()
        g = M[M.season.eq(S) & M.status.eq('FINAL')].set_index('game_id').join(last, how='left')
        bad += g[(g['end.homeScore'] != g.home_points) | (g['end.awayScore'] != g.away_points)].index.tolist()
    out = {'doc': __doc__, 'calibration': calibration(M), 'reliability': reliability(M),
           'intervals': intervals(M, qbs), 'subgroups': subgroups(M, qbs), 'tails': tails(M, qbs, set(bad))}
    qbs.to_parquet(_io.audit_path('qb_states.parquet'), index=False)
    _io.write('accuracy.json', out)
    c = out['calibration']['holdout_2024_2025']['win_raw_shipped']
    print('holdout win: brier %.4f %s ll %.4f ece %.4f %s slope %.3f %s int %.3f %s' % (
        c['brier'], c['brier_ci'], c['log_loss'], c['ece'], c['ece_ci'], c['slope'], c['slope_ci'], c['intercept'], c['intercept_ci']))
    for b in c['buckets']:
        print('   ', b)
    for k in ('dev_2017_2023', 'holdout_2024_2025', 'live_2026_replay'):
        cc = out['calibration'][k].get('cover_calibrated_at_open')
        if cc:
            print(k, 'cover cal ll %.4f (coin %.4f) brier %.4f slope %.3f %s' % (cc['log_loss'], np.log(2), cc['brier'], cc['slope'], cc['slope_ci']),
                  out['calibration'][k]['cover_extremes'])
    print('reliability', json.dumps(out['reliability'], default=str)[:1500])
    print('intervals win', out['intervals']['win'])
    print('intervals qb', out['intervals']['qb_state'])
    print('intervals wk', out['intervals']['wk'])
    print('fcs', out['intervals']['fbs_vs_fcs'])
    print('tails', json.dumps({k: v for k, v in out['tails'].items()}, default=str)[:2500])


if __name__ == '__main__':
    main()
