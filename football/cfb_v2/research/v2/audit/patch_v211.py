"""Patch v2.1.1 vs v2.1.0: every number in docs/cfb-audit/PATCH_v2.1.1.md.

    cd football/cfb_v2/research
    export CFB_V2_DATA=$PWD/data OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
    CFB_V2_OUT=$PWD/out_p python3 -m v2.audit.patch_v211 [--old out_h] [--sections A,B,C,D,E,F]
        -> $CFB_V2_OUT/audit/patch_v211.json (+ patch_v211_movers.csv)

OLD = the v2.1.0 build (out_h, evidence, read only). NEW = the v2.1.1 build (out_p).
  A  every prediction 2016-2026: |delta margin|, |delta win prob|, the largest moves and why
  B  dev / holdout accuracy on TRUE finals: MAE, RMSE, Brier, calibration, paired CIs
  C  the live-2026 replay graded against TRUE finals (the Model Lab's settled results)
  D  market comparisons (V2 - opener, V2 - close, CLV, ATS): v2.1.0 on the old market,
     v2.1.0 on the corrected market (F-11 alone), v2.1.1 on the corrected market
  E  the decision calibration's frozen procedure recomputed on v2.1.1 (w_model; nothing re-selected)
  F  the decision policy v1 holdout, RE-EVALUATED on v2.1.1 because of the bug fix (frozen policy,
     frozen calibration, frozen tournament choices; never a second read for tuning). Nothing is
     written into the policy's MANIFEST/evidence; the caller logs a post_freeze_changes line.
"""
import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

from . import _io

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
V2DIR = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(V2DIR, '..', '..'))
FETCH_AT = pd.Timestamp('2026-09-27T07:21:00Z')        # the 2026 schedule/PBP files on disk
DEV = list(range(2016, 2024))
HOLD = [2024, 2025]
MARKET_COLS = ['open_margin', 'close_margin', 'total_open', 'total_close', 'has_open', 'market_dispersion',
               'spread_books', 'source', 'line', 'gap_open', 'gap_close', 'pc_home_raw', 'pc_home_cal', 'p_side', 'ev',
               'push_p', 'clv_exp', 'pred_ma', 'ma_weight_model', 'side', 'bet_result', 'bet_units', 'clv_pts',
               'bet_result_close', 'bet_units_close', 'base_hfa', 'base_v1', 'base_v1_winprob', 'base_cfbd_elo',
               'cfbd_elo_diff']


def rd(d, *p, **k):
    return pd.read_parquet(os.path.join(d, *p), **k)


def r(x, k=4):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), k)


def rl(v, k=4):
    return [r(x, k) for x in v] if v is not None else None


# ------------------------------------------------------------------ A
def predictions(OLD, NEW):
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    keep = ['game_id', 'season', 'week', 'home_team', 'away_team', 'fcs_game', 'ens_pred', 'p_home_raw', 'sigma']
    j = Mo[keep].merge(Mn[['game_id', 'ens_pred', 'p_home_raw', 'sigma']], on='game_id', suffixes=('_old', '_new'))
    j = j[j.season.between(2016, 2026) & j.ens_pred_old.notna() & j.ens_pred_new.notna()].copy()
    j['d_margin'] = j.ens_pred_new - j.ens_pred_old
    j['d_p'] = j.p_home_raw_new - j.p_home_raw_old
    # why: which model inputs of the game changed between the two builds (else: the refit only)
    A = json.load(open(os.path.join(V2DIR, 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json')))
    cols = sorted(set(A['submodels']['C_ridge']['cols']) | set(A['submodels']['D_gbm']['cols']))
    from v2 import models as MD
    Xo = MD.add_derived(rd(OLD, 'stage5', 'cfb_model_training_snapshots.parquet')).set_index('game_id')
    Xn = MD.add_derived(rd(NEW, 'stage5', 'cfb_model_training_snapshots.parquet')).set_index('game_id')
    ix = Xo.index.intersection(Xn.index)
    a, b = Xo.loc[ix, cols].astype(float), Xn.loc[ix, cols].astype(float)
    ch = ~((a == b) | (a.isna() & b.isna()))
    fam = lambda c: ('elo' if 'elo' in c else 'rest days' if c == 'rest_diff' else 'quarterback' if 'qb' in c
                     else 'team ratings')
    why = {g: sorted({fam(c) for c in cols if ch.loc[g, c]}) for g in ix[ch.any(axis=1).values]}
    j['inputs_changed'] = [', '.join(why.get(g, [])) for g in j.game_id]
    per = []
    for S, g in j.groupby('season'):
        per.append({'season': int(S), 'n': int(len(g)), 'n_moved': int((g.d_margin.abs() > 1e-9).sum()),
                    'n_inputs_changed': int((g.inputs_changed != '').sum()),
                    'mean_abs_d_margin': r(g.d_margin.abs().mean()), 'max_abs_d_margin': r(g.d_margin.abs().max()),
                    'mean_abs_d_winprob': r(g.d_p.abs().mean(), 5), 'max_abs_d_winprob': r(g.d_p.abs().max(), 5)})
    top = j.reindex(j.d_margin.abs().sort_values(ascending=False).index).head(20)
    movers = [{'game_id': int(x.game_id), 'season': int(x.season), 'week': int(x.week),
               'game': '%s vs %s' % (x.home_team, x.away_team), 'fcs_game': bool(x.fcs_game),
               'v210': r(x.ens_pred_old, 2), 'v211': r(x.ens_pred_new, 2), 'd_margin': r(x.d_margin, 2),
               'd_winprob': r(x.d_p, 4), 'inputs_changed': x.inputs_changed or 'none (the refit only)'}
              for x in top.itertuples()]
    j.to_csv(_io.audit_path('patch_v211_movers.csv'), index=False)
    allw = {'n': int(len(j)), 'mean_abs_d_margin': r(j.d_margin.abs().mean()), 'max_abs_d_margin': r(j.d_margin.abs().max()),
            'mean_abs_d_winprob': r(j.d_p.abs().mean(), 5), 'max_abs_d_winprob': r(j.d_p.abs().max(), 5)}
    dev = j[j.season.isin(DEV)]
    return {'all_2016_2026': allw, 'by_season': per, 'largest_moves': movers,
            'dev_2016_2023_identical': bool((dev.d_margin.abs() < 1e-12).all()
                                            and ((dev.d_p.abs() < 1e-12) | (dev.p_home_raw_old.isna() & dev.p_home_raw_new.isna())).all()),
            'games_with_changed_inputs_by_season': j[j.inputs_changed != ''].groupby('season').size().to_dict()}


# ------------------------------------------------------------------ B
def accuracy(OLD, NEW):
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    out = {}
    for name, ss in (('dev_2016_2023', DEV), ('holdout_2024_2025', HOLD)):
        # TRUE finals: the v2.1.1 build's FINAL rows (the 2024 App State-Liberty cancellation is not a game)
        n_ = Mn[Mn.season.isin(ss) & Mn.status.eq('FINAL') & ~Mn.fcs_game & Mn.margin.notna() & Mn.ens_pred.notna()]
        j = n_[['game_id', 'season', 'margin', 'ens_pred', 'p_home_raw']].merge(
            Mo[['game_id', 'ens_pred', 'p_home_raw']], on='game_id', suffixes=('_new', '_old'))
        y = j.margin.values
        pr = _io.paired(y, j.ens_pred_new.values, j.ens_pred_old.values)
        jp = j[j.p_home_raw_new.notna() & j.p_home_raw_old.notna()]      # no win probability before 2017
        pb = _io.paired(jp.margin.values, jp.ens_pred_new.values, jp.ens_pred_old.values,
                        pa=jp.p_home_raw_new.values, pb=jp.p_home_raw_old.values)
        pr.update({k: pb[k] for k in ('brier_a', 'brier_b', 'brier_diff', 'brier_diff_ci')})
        yw = (jp.margin.values > 0).astype(float)
        cal = {'n_with_win_prob': int(len(jp))}
        for v in ('old', 'new'):
            c = _io.prob_metrics(yw, jp['p_home_raw_' + v].values, B=1000)
            cal[v] = {k: (rl(c[k]) if isinstance(c[k], list) and k != 'buckets' else r(c[k], 5))
                      for k in ('brier', 'brier_ci', 'log_loss', 'ece', 'ece_ci', 'slope', 'slope_ci', 'intercept')}
            cal[v]['buckets_inside_ci'] = '%d/%d' % (sum(b['pred_inside_ci'] for b in c['buckets']), len(c['buckets']))
        # v2.1.0 as it was scored (its own FINAL set, which counted the cancelled 0-0 game)
        o_ = Mo[Mo.season.isin(ss) & Mo.status.eq('FINAL') & ~Mo.fcs_game & Mo.margin.notna() & Mo.ens_pred.notna()]
        out[name] = {'n_true_finals': int(len(j)),
                     'v210_as_scored': {'n': int(len(o_)), 'mae': r((o_.ens_pred - o_.margin).abs().mean()),
                                        'rmse': r(np.sqrt(((o_.ens_pred - o_.margin) ** 2).mean()))},
                     'v210': {'mae': r(pr['mae_b']), 'rmse': r(pr['rmse_b']), 'brier': r(pr['brier_b'], 5)},
                     'v211': {'mae': r(pr['mae_a']), 'rmse': r(pr['rmse_a']), 'brier': r(pr['brier_a'], 5)},
                     'v211_minus_v210': {'mae': r(pr['mae_diff'], 5), 'mae_ci': rl(pr['mae_diff_ci'], 5),
                                         'rmse': r(pr['rmse_diff'], 5), 'rmse_ci': rl(pr['rmse_diff_ci'], 5),
                                         'brier': r(pr['brier_diff'], 6), 'brier_ci': rl(pr['brier_diff_ci'], 6)},
                     'calibration': cal,
                     'games_whose_prediction_moved': int((np.abs(j.ens_pred_new - j.ens_pred_old) > 1e-9).sum())}
    for v, d in (('v210', OLD), ('v211', NEW)):
        h = json.load(open(os.path.join(d, 'report', 'backtest.json')))['headline']
        out.setdefault('published_headline', {})[v] = {k: h[k] for k in ('holdout_mae', 'holdout_n_common', 'holdout_brier',
                                                                         'holdout_coverage', 'beats_opening_line',
                                                                         'beats_closing_line')}
    return out


# ------------------------------------------------------------------ C
def truth_2026(NEW):
    R = pd.DataFrame([json.loads(l) for l in open(os.path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026', 'results.jsonl'))
                      if l.strip()])
    R = R[R.status.eq('FINAL')].sort_values('recorded_at').drop_duplicates('game_id', keep='last')
    R['game_id'] = pd.to_numeric(R.game_id)
    R['true_margin'] = R.home_points.astype(float) - R.away_points.astype(float)
    return R.set_index('game_id')


def live2026(OLD, NEW):
    R = truth_2026(NEW)
    Go = rd(OLD, 'stage2', 'games.parquet').set_index('game_id')
    Gn = rd(NEW, 'stage2', 'games.parquet').set_index('game_id')
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet').set_index('game_id')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet').set_index('game_id')
    MK = rd(NEW, 'stage2', 'market.parquet').set_index('game_id')
    rp = json.load(open(os.path.join(V2DIR, 'snapshots', '2026', 'replay_to_date.json')))
    v200 = pd.DataFrame(rp['rows']).drop_duplicates('game_id').set_index('game_id')
    g = Gn[Gn.season.eq(2026) & ~Gn.fcs_game & (Gn.kickoff_ts < FETCH_AT)]
    F = pd.DataFrame(index=g.index)
    F['status_v211'] = g.status
    F['status_v210'] = Go.status.reindex(F.index)
    F['stage2_margin_v210'] = Go.margin.reindex(F.index)
    F['true_margin'] = R.true_margin.reindex(F.index)
    F['v200'] = v200.ens_pred.reindex(F.index).astype(float)
    F['v210'] = Mo.ens_pred.reindex(F.index)
    F['v211'] = Mn.ens_pred.reindex(F.index)
    F['p210'] = Mo.p_home_raw.reindex(F.index)
    F['p211'] = Mn.p_home_raw.reindex(F.index)
    F['opener'] = MK.spread_open.reindex(F.index)
    F['close'] = MK.spread_close.reindex(F.index)
    F['partial_score_graded'] = F.status_v210.eq('FINAL') & (F.stage2_margin_v210 != F.true_margin)
    sets = {'published_208_on_stage2_scores': (F.status_v210.eq('FINAL'), 'stage2_margin_v210'),
            'published_208_on_true_finals': (F.status_v210.eq('FINAL'), 'true_margin'),
            'all_215_on_true_finals': (F.true_margin.notna(), 'true_margin')}
    out = {'games': {'fbs_fbs_kicked_off_before_fetch': int(len(F)), 'with_true_final': int(F.true_margin.notna().sum()),
                     'v210_final': int(F.status_v210.eq('FINAL').sum()), 'v211_final': int(F.status_v211.eq('FINAL').sum()),
                     'graded_on_a_partial_score_in_v210': int(F.partial_score_graded.sum()),
                     'v211_not_final_but_played': F[F.status_v211.ne('FINAL') & F.true_margin.notna()]
                     .status_v211.value_counts().to_dict()},
           'truth': 'football/cfb_lab/ledger/2026/results.jsonl (settled finals, recorded up to 2026-09-27T15:07Z; the '
                    'schedule file on disk was fetched 07:21Z)'}
    for name, (m, ycol) in sets.items():
        d = F[m & F[ycol].notna()]
        y = d[ycol].values
        blk = {'n': int(len(d))}
        for p in ('v200', 'v210', 'v211', 'opener', 'close'):
            ok = d[p].notna()
            blk['mae_' + p] = r((d[p][ok] - d[ycol][ok]).abs().mean())
            blk['n_' + p] = int(ok.sum())
        for p in ('v210', 'v211'):
            ok = d.close.notna()
            pc = _io.paired(y[ok.values], d[p][ok].values, d.close[ok].values)
            blk[p + '_minus_close'] = {'diff': r(pc['mae_diff']), 'ci': rl(pc['mae_diff_ci'])}
            po = _io.paired(y[d.opener.notna().values], d[p][d.opener.notna()].values, d.opener[d.opener.notna()].values)
            blk[p + '_minus_opener'] = {'diff': r(po['mae_diff']), 'ci': rl(po['mae_diff_ci'])}
            pp = d['p' + p[1:]]
            okp = pp.notna()
            blk['brier_' + p] = r(float(((pp[okp].values - (y[okp.values] > 0)) ** 2).mean()), 5)
        pv = _io.paired(y, d.v211.values, d.v210.values)
        blk['v211_minus_v210'] = {'diff': r(pv['mae_diff']), 'ci': rl(pv['mae_diff_ci'])}
        out[name] = blk
    out['partial_score_games'] = [{'game_id': int(i), 'stage2_margin_v210': r(x.stage2_margin_v210, 1),
                                   'true_margin': r(x.true_margin, 1), 'v210': r(x.v210, 2), 'v211': r(x.v211, 2)}
                                  for i, x in F[F.partial_score_graded].iterrows()]
    return out


# ------------------------------------------------------------------ D
def market(OLD, NEW):
    from v2 import market as MKT, pipeline as PL
    Mo = rd(OLD, 'stage7', 'backtest_predictions.parquet')
    Mn = rd(NEW, 'stage7', 'backtest_predictions.parquet')
    MKo = rd(OLD, 'stage5', 'cfb_market_training_snapshots.parquet')
    MKn = rd(NEW, 'stage5', 'cfb_market_training_snapshots.parquet')
    bo = json.load(open(os.path.join(OLD, 'report', 'backtest.json')))
    bn = json.load(open(os.path.join(NEW, 'report', 'backtest.json')))
    unc = {int(k): v for k, v in bo['uncertainty_by_season'].items()}
    seasons = sorted(unc)
    Do = Mo.drop(columns=[c for c in MARKET_COLS if c in Mo.columns])
    variants = {
        'a_v210_old_market': (Mo, bo['rule']),
        'a_check_v210_old_market_rerun': (MKT.run(Do, MKo, unc, seasons)[0], bo['rule']),
        'b_v210_corrected_market': (MKT.run(Do, MKn, unc, seasons)[0], bo['rule']),
        'c_v211_corrected_market': (Mn, bn['rule']),
    }
    out = {}
    for vname, (M, rule) in variants.items():
        blk = {}
        for wname, ss in (('dev_2016_2023', DEV), ('holdout_2024_2025', HOLD)):
            rep, w = PL.betting_report(M, ss, rule)
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
                          'ats_close': r(ac.get('ats_win_rate')), 'roi_close': r(ac.get('roi_per_bet')), 'n_bets_close': ac.get('n'),
                          'rule_qualified': {k: (r(v) if isinstance(v, float) else v) for k, v in rep['rule_qualified'].items()
                                             if k in ('n', 'ats_win_rate', 'roi_per_bet', 'clv_mean')}}
        out[vname] = blk
    out['rule'] = {'v210': {k: bo['rule'][k] for k in ('review_gap', 'bet_gap', 'bet_ev', 'bet_min_rel', 'exclude_early', 'bet_enabled')},
                   'v211': {k: bn['rule'][k] for k in ('review_gap', 'bet_gap', 'bet_ev', 'bet_min_rel', 'exclude_early', 'bet_enabled')},
                   'v210_reality_check': bo['rule']['reality_check'], 'v211_reality_check': bn['rule']['reality_check'],
                   'v210_grid_size': bo['rule']['grid_size'], 'v211_grid_size': bn['rule']['grid_size']}
    q = os.environ.get('CFB_V2_V1_MARKET', '')
    qa = os.path.join(os.path.dirname(q), 'market_qa.json') if q else ''
    out['v1_archive_qa'] = json.load(open(qa)) if qa and os.path.exists(qa) else None
    return out


# ------------------------------------------------------------------ E, F
def _decision_dataset(out_dir, params_path, version):
    """The decision dataset of a build, by the frozen dataset code (no doc is written)."""
    from v2 import config as C
    from v2.decision import dataset as DS
    from v2.decision import baseline as BL
    old_out, old_pp = C.OUT, DS.parse_params_js
    try:
        C.OUT = out_dir
        DS.parse_params_js = lambda: BL.parse_params_js(params_path)
        Dd, summ = DS.build(write=False, verbose=False)
    finally:
        C.OUT, DS.parse_params_js = old_out, old_pp
    Dd['model_version'] = version
    return Dd, summ


def _w_fit(D):
    """The frozen procedure's market-shrinkage fit (study: selection 'shrink' with the identity map,
    freeze.build_artifact: w = fit_shrink(pure_cover_prob, ats_win) on every DEV decision row)."""
    from v2.decision import study as ST, calibration as CAL
    Dv = D[D.window.eq('dev')]
    _, W, _, _ = ST.populations(Dv)
    CAL.assert_fit_rows(W)
    Y = W[W.ats_win.notna()]
    f = CAL.fit_shrink(Y.pure_cover_prob.values, Y.ats_win.values)
    return {'w_model': r(f['w'], 6), 'w_unbounded': r(f['w_unbounded'], 6), 'w_ci95_profile': rl(f['w_ci95_profile'], 4),
            'lr_w0': r(f['lr_w0'], 3), 'lr_w1': r(f['lr_w1'], 3), 'n_fit': int(f['n']),
            'seasons': sorted(int(s) for s in Y.season.unique())}


def decision(OLD, NEW):
    from v2.decision import policy as POL
    A = POL.load_artifact()
    Dfrozen = pd.read_parquet(os.path.join(OLD, 'decision', 'decision_dataset.parquet'))
    Dold, _ = _decision_dataset(OLD, os.path.join(V2DIR, 'params.js'), 'edgedesk_cfb_v2.1.0')
    Dnew, snew = _decision_dataset(NEW, os.path.join(V2DIR, 'artifacts', 'edgedesk_cfb_v2.1.1', 'params.js'),
                                   'edgedesk_cfb_v2.1.1')
    os.makedirs(os.path.join(NEW, 'decision'), exist_ok=True)
    Dnew.to_parquet(os.path.join(NEW, 'decision', 'decision_dataset.parquet'), index=False)
    json.dump(snew, open(os.path.join(NEW, 'decision', 'dataset_summary.json'), 'w'), indent=1, sort_keys=True, default=str)
    return {'frozen_artifact_w_model': A['market_shrinkage']['w_model'],
            'frozen_selection': A['cover_calibration']['selected_method'],
            'recomputed_on_frozen_v210_dataset': _w_fit(Dfrozen),
            'recomputed_on_rebuilt_v210_dataset': _w_fit(Dold),
            'recomputed_on_v211': _w_fit(Dnew),
            'note': 'recompute ONLY: the frozen selection (identity map + logit shrink toward the market) is kept; '
                    'nothing is re-selected; the frozen artifact is not rewritten'}


def holdout_reeval(OLD, NEW):
    from v2 import config as C
    from v2.decision import holdout as HO, policy as POL, tournament as T, dataset as DS
    A = POL.load_artifact()
    policy = json.load(open(os.path.join(T.POLICY_DIR, 'policy.json')))
    ev = json.load(open(os.path.join(T.POLICY_DIR, 'evidence.json')))
    tour = ev['tournament']
    old_out = C.OUT
    try:
        C.OUT = OLD                                      # the frozen DEV apparatus (close-EV table, baseline rule)
        U, _, rule = T.load_dev()
        table = T.residual_table(U)
        an = json.load(open(os.path.join(OLD, 'decision', 'policy', 'analyses.json')))
    finally:
        C.OUT = old_out
    res = {}
    for name, d in (('v210_reproduced', OLD), ('v211', NEW), ('v211_fail_closed_today', NEW)):
        H = pd.read_parquet(os.path.join(d, 'decision', 'decision_dataset.parquet'), columns=HO.HO_COLS,
                            filters=[('window', '==', 'holdout')])
        if name == 'v211':
            # the frozen numbers, as if the calibration's base_model_version named v2.1.1: without that
            # switch decision.js / policy.py refuse every row (NO_BET_VERSION_MISMATCH, next variant)
            H['model_version'] = A['base_model_version']
        S7 = pd.read_parquet(os.path.join(d, 'stage7', 'backtest_predictions.parquet'),
                             columns=['game_id', 'season', 'ev', 'side', 'gap_open', 'early_season', 'reliability', 'line',
                                      'bet_units', 'bet_result', 'clv_pts', 'p_side'],
                             filters=[('season', 'in', HO.HOLDOUT)])
        F = HO.frame(H, S7, A, rule, table)
        x = HO.evaluate(F, tour, policy, A, tour['oos'])
        if name == 'v211_fail_closed_today':
            res[name] = {'status_counts': x['production']['status_counts'],
                         'why': 'the rows carry model_version edgedesk_cfb_v2.1.1; the frozen calibration is validated for '
                                '%s, so policy.validate_artifact returns NO_BET_VERSION_MISMATCH' % A['base_model_version']}
            continue
        x['per_book_sensitivity'] = HO.per_book(H, A, table)
        x['promotion_gate'] = T.promotion_gate(tour, an, holdout={'production': x['production'],
                                                                  'tiers_high_ge_low_clv': x['tiers_high_ge_low_clv'],
                                                                  'no_collapse': x['no_collapse']}, shadow_settled=0)
        res[name] = T.clean(x)
    rec = json.load(open(os.path.join(OLD, 'decision', 'policy', 'holdout.json')))
    keyc = lambda z: {k: (v.get('bet_count'), v.get('avg_clv'), v.get('close_implied_ev'), v.get('roi'))
                      for k, v in z['candidates'].items()}
    res['recorded_v210_matches_reproduction'] = keyc(rec) == keyc(res['v210_reproduced']) and \
        rec['production']['status_counts'] == res['v210_reproduced']['production']['status_counts']
    res['label'] = ('DOCUMENTED RE-EVALUATION DUE TO A BUG FIX (audit F-01/F-11, patch edgedesk_cfb_v2.1.1): the frozen '
                    'policy cfb_decision_policy_v1, its frozen calibration (w_model 0.227829) and its frozen tournament '
                    'choices applied to the v2.1.1 holdout rows. Not a second read for tuning: nothing was chosen, '
                    'refit or re-thresholded; the policy MANIFEST and evidence.json were not modified.')
    return res


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', default=os.path.join(RESEARCH, 'out_h'))
    ap.add_argument('--sections', default='A,B,C,D,E,F')
    a = ap.parse_args()
    NEW, OLD = _io.out_dir(), a.old
    p = _io.audit_path('patch_v211.json')
    out = json.load(open(p)) if os.path.exists(p) else {}
    out.update({'doc': __doc__, 'old': OLD, 'new': NEW})
    fns = {'A': ('A_predictions', predictions), 'B': ('B_accuracy', accuracy), 'C': ('C_live_2026', live2026),
           'D': ('D_market', market), 'E': ('E_decision_w_model', decision), 'F': ('F_policy_holdout_reevaluation', holdout_reeval)}
    for s in a.sections.split(','):
        k, f = fns[s]
        out[k] = f(OLD, NEW)
        _io.write('patch_v211.json', out)
        print('[patch_v211] %s done' % k, flush=True)
    print(json.dumps({k: v for k, v in out.items() if k != 'doc'}, default=_io._d)[:4000])


if __name__ == '__main__':
    sys.path.insert(0, RESEARCH)
    main()
