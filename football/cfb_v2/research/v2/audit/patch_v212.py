"""Patch v2.1.2 (audit F-21) vs its parent v2.1.1: every number in docs/cfb-audit/PATCH_v2.1.2.md.

    cd football/cfb_v2/research
    export CFB_V2_DATA=$PWD/data OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
    CFB_V2_OUT=$PWD/out_p2 python3 -m v2.audit.patch_v212 [--old out_p] [--sections R,M,...]
        -> $CFB_V2_OUT/audit/patch_v212.json (+ patch_v212_movers.csv)

OLD = the v2.1.1 build (out_p, the parent; read only). NEW = the v2.1.2 build (out_p2).
Section R reads no outcome (stage-3 variances and priors only); it is the evidence behind the
rule declared in PATCH_v2.1.2.md section 1, which was committed before any other section ran.
  R  the between-variance rule's diagnostics: burn-in moments, split-half covariances, tv and
     the prior variance tau2 before / after, for every metric and side (no outcome read)
  M  the ratings move: posterior vs prior at several freezes; the audit's F-21 reproduction
     (phase2.prior_pinned) on both builds, plus the defence side it does not read
  S  stages 3-5 identical outside the fallback metrics (bit for bit), and which inputs changed
  A  every prediction 2016-2026: |delta margin|, |delta win prob|, the largest moves
  B  dev / holdout accuracy on true finals: MAE, RMSE, Brier, calibration, coverage, paired
     CIs, by season and by week bucket
  C  the live-2026 replay graded against true finals (the Model Lab's settled results)
  D  market comparisons (V2 - opener, V2 - close, CLV, ATS at the opener and at the close)
  E  the decision calibration's frozen procedure recomputed on v2.1.2 (w_model; nothing re-selected)
  F  the decision policy v1 holdout, RE-EVALUATED on v2.1.2 because of the bug fix (frozen policy,
     calibration and tournament choices); the caller logs a post_freeze_changes line
  G  promotion gates G1-G7 of both builds
  I  feature importance (GBM gain, ridge standardized coefficients) and input correlations
"""
import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

from . import _io
from . import patch_v211 as P1

RESEARCH, V2DIR, REPO = P1.RESEARCH, P1.V2DIR, P1.REPO
DEV, HOLD = P1.DEV, P1.HOLD
FALLBACK = ['expl_pass', 'fg_value', 'st_net', 'to_rate', 'sack_rate']
PINNED4 = ['expl_pass', 'fg_value', 'st_net', 'to_rate']
NEW_VERSION, OLD_VERSION = 'edgedesk_cfb_v2.1.2', 'edgedesk_cfb_v2.1.1'
r, rl, rd = P1.r, P1.rl, P1.rd


def _fbs(G):
    return {S: set(g[g.home_fbs].home_id) | set(g[g.away_fbs].away_id) for S, g in G.groupby('season')}


def _scale(m):
    from v2 import config as C
    return C.RATING_PRIOR_SCALE.get(m, C.RATING_PRIOR_SCALE.get('_default', 2.0))


# ------------------------------------------------------------------ R (no outcome)
def rule(OLD, NEW):
    bv = json.load(open(os.path.join(NEW, 'stage3', 'between_var.json')))
    G = rd(NEW, 'stage2', 'games.parquet')
    FBS = _fbs(G)
    fd = rd(OLD, 'stage3', 'final_dataonly.parquet')
    fd = fd[[t in FBS.get(S, ()) for S, t in zip(fd.season, fd.team_id)]]
    pooled = {}
    for m, g in fd.groupby('metric'):
        per = g.groupby('season').agg(vo=('off', 'var'), vd=('def', 'var'), no=('off_var', 'mean'), nd=('def_var', 'mean'))
        pooled[m] = {'off': float((per.vo - per.no).mean()), 'def': float((per.vd - per.nd).mean()),
                     'seasons_positive_off': int(((per.vo - per.no) > 0).sum()),
                     'seasons_positive_def': int(((per.vd - per.nd) > 0).sum()), 'n_seasons': int(len(per))}
    Po = rd(OLD, 'stage3', 'priors.parquet')
    Pn = rd(NEW, 'stage3', 'priors.parquet')
    key = ['season', 'metric', 'side', 'team_id']
    P = Po.merge(Pn, on=key, suffixes=('_old', '_new'))
    P['fbs'] = [t in FBS.get(S, ()) for S, t in zip(P.season, P.team_id)]
    out = {'rule': bv['rule'], 'rule_text': bv['rule_text'], 'metrics': {}}
    for m, d in sorted(bv['metrics'].items()):
        rec = {'n_seasons': d['n_seasons'], 'seasons': d['seasons'], 'prior_scale': _scale(m)}
        for side, k in (('off', 'o'), ('def', 'd')):
            x = d[side]
            q = P[P.metric.eq(m) & P.side.eq(k)]
            f = q[q.fbs]
            nf = q[~q.fbs]
            floor_old = 0.15 * x['legacy_tv'] * _scale(m)
            floor_new = 0.15 * x['tv'] * _scale(m)
            rec[side] = {
                'observed_var': x['observed_var'], 'posterior_var': x['posterior_var'], 'moment': x['moment'],
                'reliability_moment': x['moment'] / x['observed_var'],
                'split_half_cov': x['split_half_cov'], 'split_half_se': x['split_half_se'],
                'split_half_by_season': x['split_half_by_season'],
                'reliability_split_half': x['split_half_cov'] / x['observed_var'],
                'pooled_moment_2009_2025': pooled[m][side], 'pooled_seasons_positive': pooled[m]['seasons_positive_' + side],
                'pooled_n_seasons': pooled[m]['n_seasons'],
                'source': x['source'], 'tv_old': x['legacy_tv'], 'tv_new': x['tv'],
                'tau2_fbs_median_old': float(f.prior_var_old.median()), 'tau2_fbs_median_new': float(f.prior_var_new.median()),
                'tau2_fbs_min_old': float(f.prior_var_old.min()), 'tau2_fbs_min_new': float(f.prior_var_new.min()),
                'tau2_fbs_2026_median_old': float(f[f.season.eq(2026)].prior_var_old.median()),
                'tau2_fbs_2026_median_new': float(f[f.season.eq(2026)].prior_var_new.median()),
                'share_fbs_at_floor_old': float(np.isclose(f.prior_var_old, floor_old, rtol=1e-6, atol=0).mean()),
                'share_fbs_at_floor_new': float(np.isclose(f.prior_var_new, floor_new, rtol=1e-6, atol=0).mean()),
                'floor_old': floor_old, 'floor_new': floor_new,
                'tau2_fcs_median_old': float(nf.prior_var_old.median()), 'tau2_fcs_median_new': float(nf.prior_var_new.median()),
                'prior_mean_identical': bool((q.prior_mean_old == q.prior_mean_new).all()),
                'prior_var_identical': bool((q.prior_var_old == q.prior_var_new).all())}
        rec['h_prior_var_old'] = max(rec['off']['tv_old'], rec['def']['tv_old'])
        rec['h_prior_var_new'] = max(rec['off']['tv_new'], rec['def']['tv_new'])
        out['metrics'][m] = rec
    out['changed_metric_sides'] = sorted('%s/%s' % (m, s) for m, v in out['metrics'].items() for s in ('off', 'def')
                                         if v[s]['source'] != 'moment')
    out['priors_identical_outside_fallback'] = all(v[s]['prior_mean_identical'] and v[s]['prior_var_identical']
                                                   for m, v in out['metrics'].items() if m not in FALLBACK
                                                   for s in ('off', 'def'))
    return out


# ------------------------------------------------------------------ M (no outcome)
def movement(OLD, NEW):
    """Posterior vs prior of FBS teams at several freezes of each season, both builds."""
    G = rd(NEW, 'stage2', 'games.parquet')
    FBS = _fbs(G)
    cols = ['team_id', 'metric', 'prediction_ts', 'off', 'def', 'prior_off', 'prior_def', 'off_var', 'def_var']
    out = {'by_season_final_freeze': {}, 'by_week_2024': {}, 'by_week_2026': {}}
    for S in range(2014, 2027):
        o = rd(OLD, 'stage3', 'ratings_%d.parquet' % S, columns=cols)
        n = rd(NEW, 'stage3', 'ratings_%d.parquet' % S, columns=cols)
        o, n = o[o.team_id.isin(FBS[S]) & o.metric.isin(FALLBACK + ['sr'])], n[n.team_id.isin(FBS[S]) & n.metric.isin(FALLBACK + ['sr'])]
        ts = sorted(n.prediction_ts.unique())
        g = G[G.season.eq(S)]
        wk = g.groupby('prediction_ts').week.min()
        pick = {'final': ts[-1]}
        if S in (2024, 2026):
            for i, t in enumerate(ts):
                pick['freeze_%02d_week_%s' % (i, int(wk.get(t, -1)))] = t
        for lab, T in pick.items():
            blk = {}
            for m in FALLBACK + ['sr']:
                for side in ('off', 'def'):
                    b = {}
                    for v, d in (('v211', o), ('v212', n)):
                        x = d[d.prediction_ts.eq(T) & d.metric.eq(m)]
                        mv = (x[side] - x['prior_' + side]).abs()
                        sd_prior = x['prior_' + side].std()
                        b[v] = {'median_abs_move': r(mv.median(), 8), 'max_abs_move': r(mv.max(), 8),
                                'median_abs_move_over_prior_sd': r(mv.median() / sd_prior if sd_prior > 0 else np.nan, 4),
                                'median_post_var': r(x[side + '_var'].median(), 10),
                                'share_var_at_1p6e9': r((x[side + '_var'] <= 1.6e-9).mean(), 3)}
                    blk['%s/%s' % (m, side)] = b
            if lab == 'final':
                out['by_season_final_freeze'][int(S)] = blk
            else:
                out['by_week_%d' % S][lab] = blk
    # the audit's own reproduction (phase2.prior_pinned reads the offence columns only)
    from . import phase2 as PH
    rep = {}
    old_env = os.environ.get('CFB_V2_OUT')
    for v, d in (('v211', OLD), ('v212', NEW)):
        os.environ['CFB_V2_OUT'] = d
        rep[v] = {int(S): sorted(x) for S, x in PH.prior_pinned().items()}
    os.environ['CFB_V2_OUT'] = old_env
    out['audit_core_prior_pinned_metrics'] = rep
    # both sides (the defence side of sack_rate is pinned too and the audit key misses it)
    both = {}
    for v, d in (('v211', OLD), ('v212', NEW)):
        both[v] = {}
        for S in range(2014, 2027):
            x = rd(d, 'stage3', 'ratings_%d.parquet' % S, columns=cols)
            x = x[x.prediction_ts.eq(x.prediction_ts.max()) & x.team_id.isin(FBS[S])]
            pinned = []
            for m, g in x.groupby('metric'):
                for side in ('off', 'def'):
                    if (g[side + '_var'] <= 1.6e-9 * 8).mean() > 0.5 and (g[side] - g['prior_' + side]).abs().max() < 1e-6:
                        pinned.append('%s/%s' % (m, side))
            both[v][int(S)] = pinned
    out['pinned_both_sides_final_freeze'] = both
    return out


# ------------------------------------------------------------------ S
def identity(OLD, NEW):
    """Which stage-3/4/5 outputs changed: they must be bit-identical outside the fallback metrics."""
    out = {'stage3_ratings': {}, 'stage3_league': {}}
    for S in range(2012, 2027):
        for kind in ('ratings', 'league'):
            o = rd(OLD, 'stage3', '%s_%d.parquet' % (kind, S))
            n = rd(NEW, 'stage3', '%s_%d.parquet' % (kind, S))
            key = ['prediction_ts', 'metric'] + (['team_id'] if kind == 'ratings' else [])
            j = o.merge(n, on=key, suffixes=('_o', '_n'), how='outer', indicator=True)
            vals = [c for c in o.columns if c not in key]
            ch = set()
            for c in vals:
                a, b = j[c + '_o'], j[c + '_n']
                diff = ~((a == b) | (a.isna() & b.isna()))
                ch |= set(j.loc[diff, 'metric'])
            out['stage3_%s' % kind][int(S)] = {'rows_old': int(len(o)), 'rows_new': int(len(n)),
                                               'unmatched': int((j._merge != 'both').sum()),
                                               'metrics_changed': sorted(ch)}
    for f in ('varcomp.json',):
        out[f + '_identical'] = open(os.path.join(OLD, 'stage3', f)).read() == open(os.path.join(NEW, 'stage3', f)).read()
    fo, fn = rd(OLD, 'stage3', 'final_dataonly.parquet'), rd(NEW, 'stage3', 'final_dataonly.parquet')
    out['final_dataonly_identical'] = bool(fo.equals(fn))
    for f in ('qb_team.parquet', 'elo.parquet'):
        out['stage4_' + f + '_identical'] = bool(rd(OLD, 'stage4', f).equals(rd(NEW, 'stage4', f)))
    Xo = rd(OLD, 'stage5', 'cfb_model_training_snapshots.parquet').set_index(['game_id', 'prediction_ts'])
    Xn = rd(NEW, 'stage5', 'cfb_model_training_snapshots.parquet').set_index(['game_id', 'prediction_ts'])
    ix = Xo.index.intersection(Xn.index)
    out['stage5_rows'] = {'old': int(len(Xo)), 'new': int(len(Xn)), 'common': int(len(ix))}
    changed = []
    for c in Xo.columns:
        if c not in Xn.columns:
            continue
        a, b = Xo.loc[ix, c], Xn.loc[ix, c]
        try:
            diff = ~((a == b) | (a.isna() & b.isna()))
        except TypeError:
            diff = a.astype(str) != b.astype(str)
        if diff.any():
            changed.append(c)
    out['stage5_columns_changed'] = changed
    out['stage5_columns_changed_not_of_fallback_metrics'] = [c for c in changed if not any(m in c for m in FALLBACK)]
    Mk = rd(OLD, 'stage5', 'cfb_market_training_snapshots.parquet'), rd(NEW, 'stage5', 'cfb_market_training_snapshots.parquet')
    out['stage5_market_identical'] = bool(Mk[0].equals(Mk[1]))
    return out


# ------------------------------------------------------------------ A
def predictions(OLD, NEW):
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    keep = ['game_id', 'season', 'week', 'home_team', 'away_team', 'fcs_game', 'ens_pred', 'p_home_raw', 'sigma']
    j = Mo[keep].merge(Mn[['game_id', 'ens_pred', 'p_home_raw', 'sigma']], on='game_id', suffixes=('_old', '_new'))
    j = j[j.season.between(2016, 2026) & j.ens_pred_old.notna() & j.ens_pred_new.notna()].copy()
    j['d_margin'] = j.ens_pred_new - j.ens_pred_old
    j['d_p'] = j.p_home_raw_new - j.p_home_raw_old
    j['d_sigma'] = j.sigma_new - j.sigma_old
    per = []
    for S, g in j.groupby('season'):
        per.append({'season': int(S), 'n': int(len(g)), 'n_moved': int((g.d_margin.abs() > 1e-9).sum()),
                    'mean_abs_d_margin': r(g.d_margin.abs().mean()), 'max_abs_d_margin': r(g.d_margin.abs().max()),
                    'mean_abs_d_winprob': r(g.d_p.abs().mean(), 5), 'max_abs_d_winprob': r(g.d_p.abs().max(), 5),
                    'mean_abs_d_sigma': r(g.d_sigma.abs().mean(), 4)})
    top = j.reindex(j.d_margin.abs().sort_values(ascending=False).index).head(15)
    movers = [{'game_id': int(x.game_id), 'season': int(x.season), 'week': int(x.week),
               'game': '%s vs %s' % (x.home_team, x.away_team), 'fcs_game': bool(x.fcs_game),
               'v211': r(x.ens_pred_old, 2), 'v212': r(x.ens_pred_new, 2), 'd_margin': r(x.d_margin, 2)}
              for x in top.itertuples()]
    j.to_csv(_io.audit_path('patch_v212_movers.csv'), index=False)
    return {'all_2016_2026': {'n': int(len(j)), 'mean_abs_d_margin': r(j.d_margin.abs().mean()),
                              'max_abs_d_margin': r(j.d_margin.abs().max()), 'sd_d_margin': r(j.d_margin.std()),
                              'mean_abs_d_winprob': r(j.d_p.abs().mean(), 5), 'max_abs_d_winprob': r(j.d_p.abs().max(), 5),
                              'corr_margin': r(np.corrcoef(j.ens_pred_old, j.ens_pred_new)[0, 1], 6)},
            'by_season': per, 'largest_moves': movers}


# ------------------------------------------------------------------ B
def _coverage(j, y, v):
    """Shipped interval coverage (the pipeline's lo_q / hi_q columns), rows with an interval only."""
    out = {}
    for q in (50, 80, 95):
        lo, hi = j['lo_%d_%s' % (q, v)].values, j['hi_%d_%s' % (q, v)].values
        ok = np.isfinite(lo) & np.isfinite(hi)
        out[str(q)] = r(float(((y[ok] >= lo[ok]) & (y[ok] <= hi[ok])).mean()), 4) if ok.any() else None
    out['n'] = int((np.isfinite(j['lo_50_' + v].values)).sum())
    return out


def _window(Mo, Mn, ss, tdf_old, tdf_new, calib=True):
    n_ = Mn[Mn.season.isin(ss) & Mn.status.eq('FINAL') & ~Mn.fcs_game & Mn.margin.notna() & Mn.ens_pred.notna()]
    IV = ['lo_50', 'hi_50', 'lo_80', 'hi_80', 'lo_95', 'hi_95']
    j = n_[['game_id', 'season', 'week', 'weeks_in', 'margin', 'ens_pred', 'p_home_raw', 'sigma'] + IV].merge(
        Mo[['game_id', 'ens_pred', 'p_home_raw', 'sigma'] + IV], on='game_id', suffixes=('_new', '_old'))
    y = j.margin.values
    pr = _io.paired(y, j.ens_pred_new.values, j.ens_pred_old.values)
    jp = j[j.p_home_raw_new.notna() & j.p_home_raw_old.notna()]
    pb = _io.paired(jp.margin.values, jp.ens_pred_new.values, jp.ens_pred_old.values,
                    pa=jp.p_home_raw_new.values, pb=jp.p_home_raw_old.values)
    blk = {'n': int(len(j)), 'n_with_win_prob': int(len(jp)),
           'v211': {'mae': r(pr['mae_b']), 'rmse': r(pr['rmse_b']), 'brier': r(pb['brier_b'], 5)},
           'v212': {'mae': r(pr['mae_a']), 'rmse': r(pr['rmse_a']), 'brier': r(pb['brier_a'], 5)},
           'v212_minus_v211': {'mae': r(pr['mae_diff'], 5), 'mae_ci': rl(pr['mae_diff_ci'], 5),
                               'p_v212_not_better': r(pr['p_a_not_better_mae'], 3),
                               'rmse': r(pr['rmse_diff'], 5), 'rmse_ci': rl(pr['rmse_diff_ci'], 5),
                               'brier': r(pb['brier_diff'], 6), 'brier_ci': rl(pb['brier_diff_ci'], 6)},
           'cluster_week_mae': {k: (rl(v, 5) if isinstance(v, list) else v) for k, v in
                                _io.cluster_paired_mae(y, j.ens_pred_new.values, j.ens_pred_old.values,
                                                       j.season.astype(str) + '-' + j.week.astype(str)).items()},
           'coverage': {'v211': _coverage(j, y, 'old'), 'v212': _coverage(j, y, 'new')},
           'moved': int((np.abs(j.ens_pred_new - j.ens_pred_old) > 1e-9).sum())}
    if calib and len(jp) > 200:
        yw = (jp.margin.values > 0).astype(float)
        cal = {}
        for v in ('old', 'new'):
            c = _io.prob_metrics(yw, jp['p_home_raw_' + v].values, B=1000)
            cal['v211' if v == 'old' else 'v212'] = {
                k: (rl(c[k]) if isinstance(c[k], list) and k != 'buckets' else r(c[k], 5))
                for k in ('brier', 'brier_ci', 'log_loss', 'ece', 'ece_ci', 'slope', 'slope_ci', 'intercept')}
            cal['v211' if v == 'old' else 'v212']['buckets_inside_ci'] = '%d/%d' % (
                sum(b['pred_inside_ci'] for b in c['buckets']), len(c['buckets']))
        blk['calibration'] = cal
    return blk, j


def accuracy(OLD, NEW):
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    to = json.load(open(os.path.join(OLD, 'report', 'backtest.json'))).get('t_df') or \
        json.load(open(os.path.join(V2DIR, 'artifacts', OLD_VERSION, 'models.json')))['t_df']
    tn = json.load(open(os.path.join(V2DIR, 'artifacts', NEW_VERSION, 'models.json')))['t_df'] \
        if os.path.exists(os.path.join(V2DIR, 'artifacts', NEW_VERSION, 'models.json')) else to
    out = {'t_df': {'v211': to, 'v212': tn}}
    for name, ss in (('dev_2016_2023', DEV), ('holdout_2024_2025', HOLD)):
        blk, j = _window(Mo, Mn, ss, to, tn)
        blk['by_season'] = {}
        for S in ss:
            b, _ = _window(Mo, Mn, [S], to, tn, calib=False)
            blk['by_season'][int(S)] = {k: b[k] for k in ('n', 'v211', 'v212', 'v212_minus_v211', 'coverage')}
        wb = pd.cut(j.weeks_in, [-1, 3.5, 7.5, 11.5, 100], labels=['weeks 0-3', 'weeks 4-7', 'weeks 8-11', 'weeks 12+'])
        blk['by_week_bucket'] = {}
        for lab in wb.cat.categories:
            gids = set(j.game_id[wb.eq(lab).values])
            b, _ = _window(Mo[Mo.game_id.isin(gids)], Mn[Mn.game_id.isin(gids)], ss, to, tn, calib=False)
            blk['by_week_bucket'][str(lab)] = {k: b[k] for k in ('n', 'v211', 'v212', 'v212_minus_v211', 'coverage')}
        out[name] = blk
    for v, d in (('v211', OLD), ('v212', NEW)):
        h = json.load(open(os.path.join(d, 'report', 'backtest.json')))['headline']
        out.setdefault('published_headline', {})[v] = {k: h.get(k) for k in (
            'holdout_mae', 'holdout_n_common', 'holdout_brier', 'holdout_coverage', 'beats_opening_line',
            'beats_closing_line')}
    return out


# ------------------------------------------------------------------ C
def live2026(OLD, NEW):
    R = P1.truth_2026(NEW)
    Gn = rd(NEW, 'stage2', 'games.parquet').set_index('game_id')
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet').set_index('game_id')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet').set_index('game_id')
    MK = rd(NEW, 'stage2', 'market.parquet').set_index('game_id')
    g = Gn[Gn.season.eq(2026) & ~Gn.fcs_game & (Gn.kickoff_ts < P1.FETCH_AT)]
    F = pd.DataFrame(index=g.index)
    F['status'] = g.status
    F['week'] = g.week
    F['true_margin'] = R.true_margin.reindex(F.index)
    F['v211'] = Mo.ens_pred.reindex(F.index)
    F['v212'] = Mn.ens_pred.reindex(F.index)
    F['p211'] = Mo.p_home_raw.reindex(F.index)
    F['p212'] = Mn.p_home_raw.reindex(F.index)
    F['opener'] = MK.spread_open.reindex(F.index)
    F['close'] = MK.spread_close.reindex(F.index)
    out = {'truth': 'football/cfb_lab/ledger/2026/results.jsonl (settled FINAL results; F-01 rule: a game counts '
                    'only when it is final in the settled ledger)',
           'games': {'fbs_fbs_kicked_off_before_fetch': int(len(F)), 'with_true_final': int(F.true_margin.notna().sum()),
                     'stage2_final_in_build': int(F.status.eq('FINAL').sum()),
                     'played_but_not_final_in_build': F[F.status.ne('FINAL') & F.true_margin.notna()].status.value_counts().to_dict()}}
    sets = {'stage2_final_on_true_finals': F.status.eq('FINAL') & F.true_margin.notna(),
            'all_true_finals': F.true_margin.notna()}
    for name, m in sets.items():
        d = F[m & F.v211.notna() & F.v212.notna()]
        y = d.true_margin.values
        blk = {'n': int(len(d)), 'weeks': sorted(int(w) for w in d.week.unique())}
        for p in ('v211', 'v212', 'opener', 'close'):
            ok = d[p].notna()
            blk['mae_' + p] = r((d[p][ok] - d.true_margin[ok]).abs().mean())
            blk['n_' + p] = int(ok.sum())
        for p in ('v211', 'v212'):
            ok = d.close.notna()
            pc = _io.paired(y[ok.values], d[p][ok].values, d.close[ok].values)
            blk[p + '_minus_close'] = {'diff': r(pc['mae_diff']), 'ci': rl(pc['mae_diff_ci'])}
            ok = d.opener.notna()
            po = _io.paired(y[ok.values], d[p][ok].values, d.opener[ok].values)
            blk[p + '_minus_opener'] = {'diff': r(po['mae_diff']), 'ci': rl(po['mae_diff_ci'])}
            pp = d['p' + p[1:]]
            okp = pp.notna()
            blk['brier_' + p] = r(float(((pp[okp].values - (y[okp.values] > 0)) ** 2).mean()), 5)
        pv = _io.paired(y, d.v212.values, d.v211.values)
        blk['v212_minus_v211'] = {'diff': r(pv['mae_diff']), 'ci': rl(pv['mae_diff_ci'])}
        out[name] = blk
    fut = Gn[Gn.season.eq(2026) & ~Gn.fcs_game & (Gn.kickoff_ts >= P1.FETCH_AT)]
    d = pd.DataFrame({'v211': Mo.ens_pred.reindex(fut.index), 'v212': Mn.ens_pred.reindex(fut.index)}).dropna()
    out['provisional_unplayed'] = {'n': int(len(d)), 'mean_abs_d_margin': r((d.v212 - d.v211).abs().mean()),
                                   'max_abs_d_margin': r((d.v212 - d.v211).abs().max()),
                                   'note': 'kickoff after the 07:21 UTC fetch: provisional predictions, not graded'}
    return out


# ------------------------------------------------------------------ D
def market(OLD, NEW):
    from v2 import pipeline as PL
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    bo = json.load(open(os.path.join(OLD, 'report', 'backtest.json')))
    bn = json.load(open(os.path.join(NEW, 'report', 'backtest.json')))
    out = {}
    for vname, M, rule_ in (('v211', Mo, bo['rule']), ('v212', Mn, bn['rule'])):
        blk = {}
        for wname, ss in (('dev_2016_2023', DEV), ('holdout_2024_2025', HOLD)):
            rep, w = PL.betting_report(M, ss, rule_)
            vm, ag, ac = rep['vs_market'], rep['all_games_side_of_model'], rep['all_games_side_of_model_at_close']
            blk[wname] = {'n_games': int(len(w)),
                          'v2_minus_open': {'diff': r(vm['paired_v2_minus_open']['diff']), 'ci': rl(vm['paired_v2_minus_open']['ci']),
                                            'n': vm['paired_v2_minus_open']['n']},
                          'v2_minus_close': {'diff': r(vm['paired_v2_minus_close']['diff']), 'ci': rl(vm['paired_v2_minus_close']['ci']),
                                             'n': vm['paired_v2_minus_close']['n']},
                          'close_moved_toward_v2_share': r(vm['close_moved_toward_v2_share']),
                          'clv_mean': r(ag.get('clv_mean')), 'clv_ci': rl(ag.get('clv_ci')),
                          'ats_open': r(ag.get('ats_win_rate')), 'ats_open_ci': rl(ag.get('ats_win_rate_ci')),
                          'roi_open': r(ag.get('roi_per_bet')), 'roi_open_ci': rl(ag.get('roi_ci')), 'n_bets_open': ag.get('n'),
                          'ats_close': r(ac.get('ats_win_rate')), 'ats_close_ci': rl(ac.get('ats_win_rate_ci')),
                          'roi_close': r(ac.get('roi_per_bet')), 'n_bets_close': ac.get('n'),
                          'rule_qualified': {k: (r(v) if isinstance(v, float) else v) for k, v in rep['rule_qualified'].items()
                                             if k in ('n', 'ats_win_rate', 'roi_per_bet', 'clv_mean')}}
        out[vname] = blk
    # paired V2.1.2 - V2.1.1 on the same games (MAE vs the result, and the CLV / ATS-at-open differences)
    for wname, ss in (('dev_2016_2023', DEV), ('holdout_2024_2025', HOLD)):
        _, wo = PL.betting_report(Mo, ss, bo['rule'])
        _, wn = PL.betting_report(Mn, ss, bn['rule'])
        j = wo[['game_id', 'clv_pts', 'bet_units', 'bet_units_close']].merge(
            wn[['game_id', 'clv_pts', 'bet_units', 'bet_units_close']], on='game_id', suffixes=('_o', '_n')).dropna()
        I = _io.boot_idx(len(j))
        blk = {'n': int(len(j))}
        for k in ('clv_pts', 'bet_units', 'bet_units_close'):
            dd = (j[k + '_n'] - j[k + '_o']).values
            blk[k + '_diff'] = r(dd.mean(), 5)
            blk[k + '_diff_ci'] = rl(_io.ci(dd[I].mean(axis=1)), 5)
        so_ = wo.drop_duplicates('game_id').set_index('game_id').reindex(j.game_id).side.astype(str).values
        sn_ = wn.drop_duplicates('game_id').set_index('game_id').reindex(j.game_id).side.astype(str).values
        blk['same_side_share'] = r(float((so_ == sn_).mean()), 4)
        out.setdefault('paired_v212_minus_v211', {})[wname] = blk
    out['rule'] = {'v211': {k: bo['rule'][k] for k in ('review_gap', 'bet_gap', 'bet_ev', 'bet_min_rel', 'exclude_early', 'bet_enabled')},
                   'v212': {k: bn['rule'][k] for k in ('review_gap', 'bet_gap', 'bet_ev', 'bet_min_rel', 'exclude_early', 'bet_enabled')},
                   'v211_reality_check': bo['rule']['reality_check'], 'v212_reality_check': bn['rule']['reality_check'],
                   'v211_grid_size': bo['rule']['grid_size'], 'v212_grid_size': bn['rule']['grid_size']}
    return out


# ------------------------------------------------------------------ E, F
def decision(OLD, NEW):
    from v2.decision import policy as POL
    A = POL.load_artifact()
    Dold = pd.read_parquet(os.path.join(OLD, 'decision', 'decision_dataset.parquet'))
    Dnew, snew = P1._decision_dataset(NEW, os.path.join(V2DIR, 'artifacts', NEW_VERSION, 'params.js'), NEW_VERSION)
    os.makedirs(os.path.join(NEW, 'decision'), exist_ok=True)
    Dnew.to_parquet(os.path.join(NEW, 'decision', 'decision_dataset.parquet'), index=False)
    json.dump(snew, open(os.path.join(NEW, 'decision', 'dataset_summary.json'), 'w'), indent=1, sort_keys=True, default=str)
    return {'frozen_artifact_w_model': A['market_shrinkage']['w_model'],
            'frozen_selection': A['cover_calibration']['selected_method'],
            'recomputed_on_v211': P1._w_fit(Dold),
            'recomputed_on_v212': P1._w_fit(Dnew),
            'note': 'recompute ONLY: the frozen selection (identity map + logit shrink toward the market) is kept; '
                    'nothing is re-selected; the frozen artifact is not rewritten'}


def holdout_reeval(OLD, NEW):
    from v2 import config as C
    from v2.decision import holdout as HO, policy as POL, tournament as T
    A = POL.load_artifact()
    policy = json.load(open(os.path.join(T.POLICY_DIR, 'policy.json')))
    ev = json.load(open(os.path.join(T.POLICY_DIR, 'evidence.json')))
    tour = ev['tournament']
    # the frozen DEV apparatus lives with the v2.1.0 build (out_h, beside the parent build)
    ORIG = os.environ.get('CFB_V2_ORIG') or os.path.join(os.path.dirname(os.path.abspath(OLD)), 'out_h')
    old_out = C.OUT
    try:
        C.OUT = ORIG
        U, _, rule_ = T.load_dev()
        table = T.residual_table(U)
        an = json.load(open(os.path.join(ORIG, 'decision', 'policy', 'analyses.json')))
    finally:
        C.OUT = old_out
    res = {}
    for name, d in (('v210_reproduced', ORIG), ('v211', OLD), ('v212', NEW), ('v212_fail_closed_today', NEW)):
        H = pd.read_parquet(os.path.join(d, 'decision', 'decision_dataset.parquet'), columns=HO.HO_COLS,
                            filters=[('window', '==', 'holdout')])
        if name in ('v211', 'v212'):
            H['model_version'] = A['base_model_version']
        S7 = pd.read_parquet(os.path.join(d, 'stage7', 'backtest_predictions.parquet'),
                             columns=['game_id', 'season', 'ev', 'side', 'gap_open', 'early_season', 'reliability', 'line',
                                      'bet_units', 'bet_result', 'clv_pts', 'p_side'],
                             filters=[('season', 'in', HO.HOLDOUT)])
        F = HO.frame(H, S7, A, rule_, table)
        x = HO.evaluate(F, tour, policy, A, tour['oos'])
        if name == 'v212_fail_closed_today':
            res[name] = {'status_counts': x['production']['status_counts'],
                         'why': 'the rows carry model_version %s; the frozen calibration is validated for %s, so '
                                'policy.validate_artifact returns NO_BET_VERSION_MISMATCH' % (NEW_VERSION, A['base_model_version'])}
            continue
        x['per_book_sensitivity'] = HO.per_book(H, A, table)
        x['promotion_gate'] = T.promotion_gate(tour, an, holdout={'production': x['production'],
                                                                  'tiers_high_ge_low_clv': x['tiers_high_ge_low_clv'],
                                                                  'no_collapse': x['no_collapse']}, shadow_settled=0)
        res[name] = T.clean(x)
    rec = json.load(open(os.path.join(ORIG, 'decision', 'policy', 'holdout.json')))
    keyc = lambda z: {k: (v.get('bet_count'), v.get('avg_clv'), v.get('close_implied_ev'), v.get('roi'))
                      for k, v in z['candidates'].items()}
    res['recorded_v210_matches_reproduction'] = keyc(rec) == keyc(res['v210_reproduced']) and \
        rec['production']['status_counts'] == res['v210_reproduced']['production']['status_counts']
    res['label'] = ('DOCUMENTED RE-EVALUATION DUE TO A BUG FIX (audit F-21, patch edgedesk_cfb_v2.1.2): the frozen '
                    'policy cfb_decision_policy_v1, its frozen calibration (w_model 0.227829) and its frozen tournament '
                    'choices applied to the v2.1.2 holdout rows. Not a second read for tuning: nothing was chosen, '
                    'refit or re-thresholded; the policy MANIFEST, evidence.json and holdout_access.jsonl were not modified.')
    return res


# ------------------------------------------------------------------ G
def gates(OLD, NEW):
    out = {}
    for v, d in (('v211', OLD), ('v212', NEW)):
        p = json.load(open(os.path.join(d, 'report', 'promotion.json')))
        out[v] = {k: p.get(k) for k in ('decision', 'passed', 'failed', 'bet_allowed', 'champion')}
        out[v]['gates'] = {g: {'pass': x.get('pass'), 'evidence': x.get('evidence')}
                           for g, x in sorted((p.get('detail') or {}).items())}
    return out


# ------------------------------------------------------------------ I
def features(OLD, NEW):
    from v2 import models as MD
    out = {}
    for v, ver, d in (('v211', OLD_VERSION, OLD), ('v212', NEW_VERSION, NEW)):
        A = json.load(open(os.path.join(V2DIR, 'artifacts', ver, 'models.json')))
        cC = A['submodels']['C_ridge']['cols']
        bl = A['submodels']['C_ridge']['beta']
        beta = dict(zip(cC, bl[1:] if A['submodels']['C_ridge'].get('intercept') else bl))   # beta[0] is the intercept
        brank = sorted(cC, key=lambda c: -abs(beta[c]))
        sd = dict(zip(cC, A['submodels']['C_ridge']['sd']))
        gain = A['submodels']['D_gbm'].get('importance_gain_top20', {})
        import lightgbm as lgb
        bst = lgb.Booster(model_file=os.path.join(V2DIR, 'artifacts', ver, 'gbm_D.txt'))
        g = dict(zip(bst.feature_name(), bst.feature_importance('gain')))
        tot = sum(g.values()) or 1.0
        rank = sorted(g, key=lambda k: -g[k])
        X = MD.add_derived(rd(d, 'stage5', 'cfb_model_training_snapshots.parquet'))
        X = X[X.season.isin(DEV) & ~X.fcs_game.astype(bool)] if 'fcs_game' in X else X[X.season.isin(DEV)]
        watch = [c for c in sorted(set(cC) | set(bst.feature_name())) if any(m in c for m in FALLBACK)] + ['to_dependence']
        blk = {'ridge_C': {c: {'beta_per_sd': r(beta[c], 5), 'rank_abs_beta': brank.index(c) + 1, 'of': len(cC)}
                           for c in cC if any(m in c for m in FALLBACK)},
               'gbm_D_gain_share': {c: r(g.get(c, 0.0) / tot, 5) for c in watch if c in g},
               'gbm_D_gain_rank': {c: rank.index(c) + 1 for c in watch if c in g},
               'gbm_D_n_features': len(rank)}
        corr = {}
        pairs = [('edge_expl_pass', 'edge_prior_sr'), ('edge_expl_pass', 'edge_sr'), ('edge_st_net', 'edge_prior_sr'),
                 ('edge_fg_value', 'edge_prior_sr'), ('edge_st_net', 'edge_fg_value'), ('edge_expl_pass', 'edge_epa_pass')]
        for a, b in pairs:
            if a in X and b in X:
                ok = X[a].notna() & X[b].notna()
                corr['%s~%s' % (a, b)] = r(np.corrcoef(X.loc[ok, a], X.loc[ok, b])[0, 1], 4)
        for c in [c for c in X.columns if c.startswith('edge_') and any(m in c for m in FALLBACK)] + ['to_dependence']:
            pc = 'edge_prior_' + c[5:] if c.startswith('edge_') else None
            if pc and pc in X:
                ok = X[c].notna() & X[pc].notna()
                corr['%s~%s' % (c, pc)] = r(np.corrcoef(X.loc[ok, c], X.loc[ok, pc])[0, 1], 4)
        blk['dev_correlations'] = corr
        out[v] = blk
    # the same dev rows of both builds: how far did each fallback input move
    Xo = MD.add_derived(rd(OLD, 'stage5', 'cfb_model_training_snapshots.parquet')).set_index(['game_id', 'prediction_ts'])
    Xn = MD.add_derived(rd(NEW, 'stage5', 'cfb_model_training_snapshots.parquet')).set_index(['game_id', 'prediction_ts'])
    ix = Xo.index.intersection(Xn.index)
    mv = {}
    for c in [c for c in Xn.columns if (c.startswith('edge_') and any(m in c for m in FALLBACK)) or c == 'to_dependence']:
        a, b = Xo.loc[ix, c].astype(float), Xn.loc[ix, c].astype(float)
        ok = a.notna() & b.notna()
        mv[c] = {'corr_old_new': r(np.corrcoef(a[ok], b[ok])[0, 1], 5), 'sd_old': r(a[ok].std(), 5), 'sd_new': r(b[ok].std(), 5),
                 'mean_abs_diff': r((a[ok] - b[ok]).abs().mean(), 5)}
    out['input_moves_all_rows'] = mv
    return out


# ------------------------------------------------------------------ MANIFEST
def _sha(p):
    import hashlib
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def write_manifest(OLD, NEW, ev):
    """artifacts/edgedesk_cfb_v2.1.2/MANIFEST.json (after export; never overwrites one)."""
    from v2 import common
    adir = os.path.join(V2DIR, 'artifacts', NEW_VERSION)
    mp = os.path.join(adir, 'MANIFEST.json')
    if os.path.exists(mp):
        raise SystemExit('refused: %s exists (a released artifact is never rewritten)' % mp)
    pdir = os.path.join(V2DIR, 'artifacts', OLD_VERSION)
    parent = json.load(open(os.path.join(pdir, 'MANIFEST.json')))
    art = json.load(open(os.path.join(adir, 'models.json')))
    stamp = json.load(open(os.path.join(NEW, 'BUILD.json')))['stages']
    Rr, S, A = ev['R_rule'], ev['S_identity'], ev['A_predictions']
    frozen = {f: _sha(os.path.join(NEW, 'report', f)) for f in ('ablation.json', 'selected_families.json', 'tuning_ratings.json',
                                                                 'tuning_models_C.json', 'tuning_models_D.json', 'tuning_models_D2.json')}
    m = {
        'model_version': NEW_VERSION,
        'parent_version': OLD_VERSION,
        'parent_manifest_sha256': _sha(os.path.join(pdir, 'MANIFEST.json')),
        'kind': 'PATCH: same code recipe, same hyper-parameters, one corrected stage-3 variance rule '
                '(docs/cfb-audit/PATCH_v2.1.2.md)',
        'bugs_fixed': {'F-21': 'stage 3 floored the burn-in between-team variance at 1e-8 when its method-of-moments '
                               'estimate was <= 0, so the prior variance was 1.5e-9 x scale and expl_pass, fg_value, st_net, '
                               'to_rate (both sides) and sack_rate (defence) never left their preseason prior. Rule '
                               'cfb_v2_between_var_v2: the moment where positive (every other metric bit-identical), else '
                               'the split-half (odd/even weeks) covariance on the same burn-in seasons 2009-2011, else refuse.'},
        'bugs_that_change_this_artifact': ['F-21'],
        'between_var_rule': art.get('between_var_rule'),
        'recipe': {
            'build_dir': 'football/cfb_v2/research/out_p2 (git-ignored)',
            'build_stamp': stamp,
            'stages_1_2': 'copied unchanged from the v2.1.1 build (out_p): stage2/games.parquet sha256 %s, market.parquet %s'
                          % (_sha(os.path.join(NEW, 'stage2', 'games.parquet')), _sha(os.path.join(NEW, 'stage2', 'market.parquet'))),
            'code': 'v2.build_ratings, v2.qb, v2.elo, v2.snapshots, v2.tests_leakage, v2.pipeline, v2.export (the V2.1 '
                    'recipe), no re-tuning',
            'environment': 'CFB_V2_BETWEEN_VAR_RULE=cfb_v2_between_var_v2, CFB_V2_MODEL_VERSION=%s, '
                           'CFB_V2_V1_RECORDS=data/v1/out/v1_records.json (unchanged), single-threaded BLAS' % NEW_VERSION,
            'config_py_sha256': _sha(os.path.join(RESEARCH, 'v2', 'config.py')),
            'config_py_note': 'unchanged: identical to the file v2.1.0 and v2.1.1 were built with and to the one '
                              'cfb_decision_baseline_001 pins',
            'seed': art.get('seed') or 20260927,
            'feature_version': art['feature_version'],
            'trained_through': art['trained_through'],
            'frozen_tuning_inputs_copied_from_v2.1.1_build': frozen,
            'frozen_tuning_identical_to_parent': frozen == parent['recipe'].get('frozen_tuning_inputs_copied_from_v2.1.0_build'),
            'stack_weights': art['stack_weights'], 't_df': art['t_df'], 'families': art['families'],
            'market_rule': {k: art['rule'].get(k) for k in ('review_gap', 'bet_gap', 'bet_ev', 'bet_min_rel', 'exclude_early',
                                                            'bet_enabled')},
            'elo_tuning': 'v2.elo re-derives its dev tuning each run (stage 4 does not read stage 3)'},
        'data_diff': {
            'stage1_stage2': 'identical to v2.1.1 (copied)',
            'stage3_metric_sides_changed': Rr['changed_metric_sides'],
            'stage3_between_var_tv': {m: {s: {'v2.1.1': v[s]['tv_old'], 'v2.1.2': v[s]['tv_new'], 'source': v[s]['source']}
                                          for s in ('off', 'def')}
                                      for m, v in Rr['metrics'].items() if m in FALLBACK},
            'stage3_priors_identical_outside_fallback_metrics': Rr['priors_identical_outside_fallback'],
            'stage3_ratings_metrics_changed': sorted({m for v in S['stage3_ratings'].values() for m in v['metrics_changed']}),
            'stage3_varcomp_identical': S['varcomp.json_identical'],
            'stage3_final_dataonly_identical': S['final_dataonly_identical'],
            'stage4_identical': {k: v for k, v in S.items() if k.startswith('stage4_')},
            'stage5_columns_changed': S['stage5_columns_changed'],
            'stage5_market_identical': S['stage5_market_identical'],
            'predictions_2016_2026': A['all_2016_2026'],
        },
        'data_provenance_sha256': parent.get('data_provenance_sha256'),
        'evidence': 'football/cfb_v2/research/out_p2/audit/patch_v212.json (python3 -m v2.audit.patch_v212); '
                    'docs/cfb-audit/PATCH_v2.1.2.md',
        'files': {f: _sha(os.path.join(adir, f)) for f in sorted(os.listdir(adir)) if f != 'MANIFEST.json'},
        'created_by': 'EdgeDesk CFB audit patch engineer (v2.1.2)',
        'status': 'CHALLENGER_NOT_PROMOTED: not in football/cfb_production/compatibility.json; production stays '
                  'edgedesk_cfb_v2.1.0 until the owner switches (PATCH_v2.1.2.md, section 9)',
    }
    common.write_json(mp, m)
    return _sha(mp)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', default=os.path.join(RESEARCH, 'out_p'))
    ap.add_argument('--sections', default='R,M,S,A,B,C,D,E,F,G,I')
    ap.add_argument('--manifest', action='store_true', help='write artifacts/%s/MANIFEST.json and stop' % NEW_VERSION)
    a = ap.parse_args()
    NEW, OLD = _io.out_dir(), a.old
    p = _io.audit_path('patch_v212.json')
    out = json.load(open(p)) if os.path.exists(p) else {}
    if a.manifest:
        print('[patch_v212] MANIFEST sha256', write_manifest(OLD, NEW, out))
        return
    out.update({'doc': __doc__, 'old': OLD, 'new': NEW})
    fns = {'R': ('R_rule', rule), 'M': ('M_movement', movement), 'S': ('S_identity', identity),
           'A': ('A_predictions', predictions), 'B': ('B_accuracy', accuracy), 'C': ('C_live_2026', live2026),
           'D': ('D_market', market), 'E': ('E_decision_w_model', decision), 'F': ('F_policy_holdout_reevaluation', holdout_reeval),
           'G': ('G_gates', gates), 'I': ('I_features', features)}
    for s in a.sections.split(','):
        k, f = fns[s]
        out[k] = f(OLD, NEW)
        _io.write('patch_v212.json', out)
        print('[patch_v212] %s done' % k, flush=True)


if __name__ == '__main__':
    sys.path.insert(0, RESEARCH)
    main()
