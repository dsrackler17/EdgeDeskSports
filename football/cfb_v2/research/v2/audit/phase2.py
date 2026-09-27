"""Audit phase 2 — model, evidence and component items (20-23, 34, 40-42, 58, 61-70, 75-78).

    python3 -m v2.audit.phase2      -> $CFB_V2_OUT/audit/phase2.json (+ false_edges.csv, missed_edges.csv)

Holdout discipline: nothing here re-scores a holdout that a layer read once. Every new evaluation below
uses the development seasons (2016-2023) and the 2026 replay; holdout numbers are only READ from the
layers' own frozen evidence files. The core model's stored out-of-fold predictions are v2.1.0
(out_h/stage7); v2.1.1 (out_p/stage7) is identical on 2016-2023.
"""
import json
import os

import numpy as np
import pandas as pd
from scipy import stats

from . import _io

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
V2 = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(V2, '..', '..'))
DATA = os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))
DEV = list(range(2016, 2024))
P4 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}


def M_():
    M = _io.preds().copy()
    M['r'] = M.margin - M.ens_pred
    M['ae'] = M.r.abs()
    return M


# ------------------------------------------------------------------ 23 prior double count
def prior_double_count(M):
    from v2 import build_ratings as BR
    RP, TT, CO = BR.load_prior_inputs()
    fd = pd.read_parquet(os.path.join(_io.out_dir(), 'stage3', 'final_dataonly.parquet'))
    rows = []
    for S in range(2014, 2026):
        f1 = fd[fd.season.eq(S - 1) & fd.metric.eq('epa')].set_index('team_id')
        f2 = fd[fd.season.eq(S - 2) & fd.metric.eq('epa')].set_index('team_id')
        tt = TT[TT.season.eq(S)].set_index('team_id').talent_composite
        rp = RP[RP.season.eq(S)].set_index('team_id')
        co = CO[CO.season.eq(S)].set_index('team_id') if CO is not None else None
        teams = sorted(set(f1.index) & set(tt.index.dropna().astype(int)))
        for t in teams:
            rows.append({'season': S, 'lag1_net': f1.off.get(t, np.nan) - f1['def'].get(t, np.nan),
                         'lag2_net': f2.off.get(t, np.nan) - f2['def'].get(t, np.nan) if t in f2.index else np.nan,
                         'talent': tt.get(t, np.nan), 'ret_off': rp.off_returning.get(t, np.nan) if t in rp.index else np.nan,
                         'hc_new': float(co.hc_tenure.get(t, np.nan) == 0) if co is not None and t in co.index else np.nan})
    P = pd.DataFrame(rows)
    corr = P[['lag1_net', 'lag2_net', 'talent', 'ret_off', 'hc_new']].corr().round(3)
    # early-season certainty: slope of margin on the prediction (1 = right-sized, < 1 = over-confident),
    # by week bucket, V2 vs the close, on DEV and the 2026 replay
    out = {'prior_input_correlation_2014_2025': corr.to_dict(), 'n_team_seasons': int(len(P))}
    def slope(x, y):
        b, a, r, p, se = stats.linregress(x, y)
        return {'slope': float(b), 'slope_ci': [float(b - 1.96 * se), float(b + 1.96 * se)], 'n': int(len(x))}
    sl = {}
    for win, ss in (('dev', DEV), ('live_2026', [2026])):
        w = _io.fbs_final(M, ss).dropna(subset=['ens_pred'])
        w = w.assign(wk=np.where(w.is_postseason, 'post', pd.cut(w.weeks_in, [-1, 2, 4.99, 9, 30],
                                                                  labels=['wk0-2', 'wk3-4', 'wk5-9', 'wk10+']).astype(str)))
        t = {}
        for k, g in w.groupby('wk'):
            if len(g) < 40:
                continue
            e = {'v2': slope(g.ens_pred, g.margin), 'sd_pred_v2': float(g.ens_pred.std())}
            c = g.dropna(subset=['close_margin'])
            if len(c) >= 40:
                e['close'] = slope(c.close_margin, c.margin); e['sd_close'] = float(c.close_margin.std())
                e['v2_same_games'] = slope(c.ens_pred, c.margin)
            t[k] = e
        sl[win] = t
    out['calibration_slope_by_week'] = sl
    # how much of the week-0 prediction is the prior: corr(edge_prior_epa, ens_pred) by week
    w = _io.fbs_final(M, DEV)
    out['corr_prior_edge_with_prediction_by_week'] = {
        k: float(np.corrcoef(g.edge_prior_epa, g.ens_pred)[0, 1])
        for k, g in w.assign(wk=pd.cut(w.weeks_in, [-1, 0.99, 2, 4, 8, 30], labels=['wk0', 'wk1-2', 'wk3-4', 'wk5-8', 'wk9+']).astype(str)).groupby('wk')}
    return out


# ------------------------------------------------------------------ 20 QB double count
def qb_counterfactual():
    from v2 import predict_live as PL
    A, gbm = PL.load_artifacts('edgedesk_cfb_v2.1.0')
    X = pd.read_parquet(os.path.join(_io.out_dir(), 'stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[X.season.eq(2026) & ~X.fcs_game & X.h_qb_missing.eq(0)].copy()
    sh = json.load(open(os.path.join(_io.out_dir(), 'stage4', 'qb_shrinkage.json')))
    repl = sh['replacement_mean']
    base = PL.predict(X, A, gbm)
    Y = X.copy()
    # the home team's expected starter is replaced by a first-time starter: replacement-level rating,
    # no career dropbacks, flagged as a change
    Y['h_qb_exp_rating'] = repl
    Y['h_qb_exp_db_log'] = 0.0
    Y['h_qb_changed'] = 1.0
    Y['qb_delta_edge'] = (repl - Y.h_qb_team_rating) - Y.a_qb_delta.fillna(0)
    Y['qb_exp_edge'] = repl - Y.a_qb_exp_rating
    cf = PL.predict(Y, A, gbm)
    d = (cf.ens_pred - base.ens_pred)
    Pj = open(os.path.join(V2, 'params.js')).read()
    P = json.loads(Pj[Pj.index('{', Pj.index('EDCfbV2Params')):Pj.rindex('}; })') + 1])
    q = P['qb']
    overlay_out = (q['baseline_same_starter'] - 0.0) * q['change_delta_pts']
    return {'n_games_2026': int(len(X)), 'snapshot_shift_when_starter_becomes_first_timer': {
                'mean': float(d.mean()), 'median': float(d.median()), 'p10': float(d.quantile(0.1)),
                'p90': float(d.quantile(0.9)), 'min': float(d.min()), 'max': float(d.max())},
            'sigma_change_mean': float((cf.sigma - base.sigma).mean()),
            'engine_overlay_shift_for_OUT': overlay_out,
            'overlay_is_keyed_to_player_id': False,
            'production_callers_passing_qb_status': 0,
            'note': 'engine.qbOverlay reads overlays.qb_status[side] with no check that the reported player is the '
                    'snapshot\'s expected starter (row.qb[side].qb_id); every production caller passes {} (app.html, '
                    'cfb_lab/models.js, cfb_decision/shadow.js, sync_supabase.js, shadow_decisions.js)'}


# ------------------------------------------------------------------ 22 market double count
def market_signals():
    d = pd.read_parquet(os.path.join(_io.out_dir(), 'decision', 'decision_dataset.parquet'))
    dv = d[d.season.isin(DEV) & d.window.astype(str).str.contains('dev', case=False, na=False)] if 'window' in d else d[d.season.isin(DEV)]
    if dv.empty:
        dv = d[d.season.isin(DEV)]
    cols = [c for c in ('abs_gap_pts', 'theoretical_ev', 'pure_cover_prob', 'line_move_at_decision', 'dispersion',
                        'opener_dispersion_sd', 'market_dispersion_close', 'books', 'reliability', 'ens_sd', 'clv_pts')
            if c in dv and dv[c].notna().sum() > 100]
    C = dv[cols].astype(float).corr(method='spearman').round(3)
    return {'rows_dev': int(len(dv)), 'spearman': C.to_dict(),
            'gap_vs_ev': float(C.loc['abs_gap_pts', 'theoretical_ev']) if 'theoretical_ev' in C else None,
            'gap_vs_cover_prob': float(C.loc['abs_gap_pts', 'pure_cover_prob']) if 'pure_cover_prob' in C else None}


# ------------------------------------------------------------------ 34 line shopping
def line_shopping(M):
    f = os.path.join(DATA, 'v1', 'out_p', 'market_books.csv')
    if not os.path.exists(f):
        f = os.path.join(DATA, 'v1', 'out', 'market_books.csv')
    B = pd.read_csv(f, low_memory=False)
    B = B[B.market.eq('spread')].copy()
    for c in ('close', 'open'):
        B[c] = pd.to_numeric(B[c], errors='coerce')
    if 'close_conflict' in B:
        B = B[~B.close_conflict.fillna(False).astype(bool)]
    B = B.dropna(subset=['close'])
    w = _io.fbs_final(M, [2016, 2017, 2018, 2019]).dropna(subset=['ens_pred', 'close_margin'])
    B = B[B.game_id.isin(w.game_id)]
    g = B.groupby('game_id').close
    cons = g.median()
    w = w.set_index('game_id').loc[cons.index.intersection(w.game_id)]
    side_home = (w.ens_pred > cons.reindex(w.index)).values
    res = {}
    def grade(line_margin, name):
        diff = w.margin.values - line_margin
        win = np.where(side_home, diff > 0, diff < 0); push = diff == 0
        dec = ~push & ~np.isnan(line_margin)
        k, n = int(win[dec].sum()), int(dec.sum())
        units = np.where(push, 0.0, np.where(win, 100 / 110, -1.0))[~np.isnan(line_margin)]
        lo, hi = _io.wilson(k / n, n)
        res[name] = {'n': n, 'ats': k / n, 'ats_ci': [lo, hi], 'roi_at_minus110': float(units.mean()),
                     'roi_ci': _io.ci(units[_io.boot_idx(len(units), 1000)].mean(axis=1))}
    grade(cons.reindex(w.index).values, 'consensus_median_close')
    # best line for the side taken (home margin line: a home bettor wants the LOWEST home margin line)
    best_all = np.where(side_home, g.min().reindex(w.index).values, g.max().reindex(w.index).values)
    grade(best_all, 'best_of_all_books_close')
    # the same after removing quotes >= 1.5 pts from the book consensus (stale / off-market / error)
    Bc = B.merge(cons.rename('cons'), left_on='game_id', right_index=True)
    Bf = Bc[(Bc.close - Bc.cons).abs() < 1.5]
    gf = Bf.groupby('game_id').close
    best_f = np.where(side_home, gf.min().reindex(w.index).values, gf.max().reindex(w.index).values)
    grade(best_f, 'best_of_books_within_1.5_of_consensus')
    Bf2 = Bc[(Bc.close - Bc.cons).abs() <= 0.5]
    gf2 = Bf2.groupby('game_id').close
    grade(np.where(side_home, gf2.min().reindex(w.index).values, gf2.max().reindex(w.index).values),
          'best_of_books_within_0.5_of_consensus')
    for bk in ('PINNACLE', 'BOVADA & bodog', 'BetCRIS & BOOKMAKER'):
        s = B[B.book.eq(bk)].groupby('game_id').close.median()
        if len(s) > 500:
            grade(s.reindex(w.index).values, 'single_book_' + bk)
    res['share_of_best_lines_from_quotes_ge_1.5_off_consensus'] = float(
        (np.abs(best_all - cons.reindex(w.index).values) >= 1.5).mean())
    res['median_books_per_game'] = float(g.size().median())
    res['source'] = os.path.relpath(f, REPO)
    return res


# ------------------------------------------------------------------ 42 PASS counterfactual, 40 tiers (DEV)
def statuses_dev(M):
    """V2's own frozen research statuses (pipeline rule) on DEV: LEAN vs PASS vs REVIEW, at open and close."""
    from v2 import market as MKT
    w = M[M.season.isin(DEV) & M.status.eq('FINAL') & M.ev.notna() & ~M.fcs_game].copy()
    rule = json.load(open(os.path.join(_io.out_dir(), 'report', 'backtest.json')))['rule']
    st, _ = MKT.decide(w, rule)
    w['st'] = st
    out = {}
    for s, g in w.groupby('st'):
        dec = g[g.bet_result != 0]; dc = g[g.bet_result_close.notna() & (g.bet_result_close != 0)]
        k, n = int((dec.bet_result == 1).sum()), len(dec)
        out[s] = {'n': int(len(g)), 'ats_open': k / n if n else None, 'ats_open_ci': list(_io.wilson(k / n, n)) if n else None,
                  'ats_close': float((dc.bet_result_close == 1).mean()) if len(dc) else None,
                  'clv': float(g.clv_pts.mean()), 'roi_open': float(g.bet_units.mean())}
    return {'rule': {k: rule[k] for k in ('review_gap', 'bet_gap', 'bet_ev', 'exclude_early', 'bet_enabled')}, 'by_status_dev': out}


# ------------------------------------------------------------------ 70 disagreement
def disagreement(M):
    out = {}
    for win, ss in (('dev', DEV), ('live_2026', [2026])):
        w = _io.fbs_final(M, ss).dropna(subset=['ens_sd'])
        w = w.assign(q=pd.qcut(w.ens_sd, 5, labels=False, duplicates='drop'))
        t = w.groupby('q').agg(n=('ae', 'size'), ens_sd=('ens_sd', 'mean'), mae=('ae', 'mean'),
                               rmse=('r', lambda x: float(np.sqrt((x ** 2).mean()))), sigma=('sigma', 'mean'))
        rho = stats.spearmanr(w.ens_sd, w.ae)
        out[win] = {'by_quintile': t.round(3).reset_index().to_dict('records'),
                    'spearman_ens_sd_abs_err': [float(rho.correlation), float(rho.pvalue)],
                    'sigma_coef_ens_sd_in_artifact': json.load(open(os.path.join(V2, 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json')))['sigma_model']['coef'].get('ens_sd')}
    return out


# ------------------------------------------------------------------ 75-77 false / missed edges
def edges(M):
    Q = pd.read_parquet(_io.audit_path('qb_states.parquet'))
    w = M[M.season.isin(DEV + [2026]) & M.status.eq('FINAL') & ~M.fcs_game & M.line.notna()].copy()
    w = w.merge(Q[['game_id', 'qb_state']], on='game_id', how='left')
    w['gap'] = w.ens_pred - w.line
    w['open_ae'] = (w.line - w.margin).abs()
    w['close_move_toward'] = np.sign(w.gap) * (w.close_margin - w.line)
    hp, ap = w.home_conference.isin(P4), w.away_conference.isin(P4)
    w['p4g5'] = np.where(hp != ap, 'P4vG5', 'same_tier')
    def tags(g):
        return {'qb_change': float(g.qb_state.fillna('').str.startswith('change').mean()),
                'week1_unknown_qb': float(g.qb_state.eq('week1_unknown').mean()),
                'extreme_favourite_21plus': float((g.line.abs() >= 21).mean()),
                'early_season_wk0_4': float((g.weeks_in < 5).mean()),
                'P4_vs_G5': float(g.p4g5.eq('P4vG5').mean()),
                'postseason': float(g.is_postseason.mean()),
                'market_moved_away_2plus': float((g.close_move_toward <= -2).mean()),
                'market_moved_toward_2plus': float((g.close_move_toward >= 2).mean())}
    big = w[w.gap.abs() >= 7]
    false_edge = big[np.sign(big.margin - big.line) != np.sign(big.gap)]
    true_edge = big[np.sign(big.margin - big.line) == np.sign(big.gap)]
    missed = w[(w.gap.abs() < 1.5) & (w.open_ae >= 21)]
    away_big = big[big.close_move_toward <= -2]
    out = {'base_rates_all_lined_games': tags(w), 'n_all': int(len(w)),
           'gap_ge_7': {'n': int(len(big)), 'v2_side_covered_share': float(len(true_edge) / max(1, len(true_edge) + len(false_edge))),
                        'false_edges': {'n': int(len(false_edge)), 'tags': tags(false_edge)},
                        'true_edges': {'n': int(len(true_edge)), 'tags': tags(true_edge)}},
           'missed_edges_gap_lt_1.5_and_market_off_by_21plus': {'n': int(len(missed)), 'share_of_near_market_games': float(len(missed) / max(1, (w.gap.abs() < 1.5).sum())),
                                                                 'tags': tags(missed)},
           'gap_ge_7_market_moved_further_away': {'n': int(len(away_big)),
                                                  'v2_side_covered_at_open': float((np.sign(away_big.margin - away_big.line) == np.sign(away_big.gap)).mean()) if len(away_big) else None,
                                                  'close_closer_to_result_share': float(((away_big.close_margin - away_big.margin).abs() < (away_big.ens_pred - away_big.margin).abs()).mean()) if len(away_big) else None,
                                                  'tags': tags(away_big) if len(away_big) else None}}
    cols = ['game_id', 'season', 'week', 'home_team', 'away_team', 'ens_pred', 'line', 'close_margin', 'margin', 'gap',
            'close_move_toward', 'qb_state', 'weeks_in', 'p4g5', 'reliability', 'ens_sd']
    false_edge.assign(miss=(false_edge.ens_pred - false_edge.margin).abs()).sort_values('miss', ascending=False)[cols].head(100) \
        .to_csv(_io.audit_path('false_edges.csv'), index=False)
    missed.sort_values('open_ae', ascending=False)[cols].head(100).to_csv(_io.audit_path('missed_edges.csv'), index=False)
    return out


# ------------------------------------------------------------------ 67 similar opponents
def similar_pit():
    s = pd.read_parquet(os.path.join(_io.out_dir(), 'matchup', 'similar_pairs.parquet'))
    k = pd.to_datetime(s.comparison_kickoff_ts, utc=True)
    T = pd.to_datetime(s.prediction_ts, utc=True)
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'), columns=['game_id', 'kickoff_ts'])
    tk = s.target_game_id.map(G.set_index('game_id').kickoff_ts)
    return {'pairs': int(len(s)), 'comparison_at_or_after_freeze': int((k >= T).sum()),
            'flag_not_eligible': int((~s.eligible_pre_prediction).sum()),
            'comparison_is_target_game': int((s.comparison_game_id == s.target_game_id).sum()),
            'comparison_after_target_kickoff': int((k >= tk).sum())}


# ------------------------------------------------------------------ 66 matchup magnitudes (DEV only)
def matchup_dev():
    o = pd.read_parquet(os.path.join(_io.out_dir(), 'matchup', 'oof_dev.parquet'))
    cols = [c for c in o.columns if 'adj' in c.lower() or 'shadow' in c.lower() or 'corr' in c.lower()]
    out = {'rows': int(len(o)), 'columns_with_adjustments': cols[:20]}
    for c in cols[:6]:
        x = pd.to_numeric(o[c], errors='coerce')
        if x.notna().sum() > 100:
            out[c] = {'mean_abs': float(x.abs().mean()), 'p99_abs': float(x.abs().quantile(0.99)), 'max_abs': float(x.abs().max())}
    return out


# ------------------------------------------------------------------ 78 timeline (Model Lab ledger)
def timeline():
    L = os.path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026')
    P = [json.loads(l) for f in sorted(os.listdir(os.path.join(L, 'predictions'))) for l in open(os.path.join(L, 'predictions', f))]
    Q = [json.loads(l) for f in sorted(os.listdir(os.path.join(L, 'quotes'))) for l in open(os.path.join(L, 'quotes', f))]
    R = {r['game_id']: r for r in (json.loads(l) for l in open(os.path.join(L, 'results.jsonl')))}
    P = pd.DataFrame(P); Q = pd.DataFrame(Q)
    v1 = P[P.model_version.eq('edgedesk_cfb_p4_v1.0.0')]
    games = v1.groupby('game_id').size().sort_values(ascending=False).index[:6]
    out = []
    for gid in games:
        p = v1[v1.game_id.eq(gid)].sort_values('prediction_ts')
        q = Q[Q.game_id.eq(gid) & Q.market_type.eq('spread')].sort_values('observed_at')
        v2 = P[P.game_id.eq(gid) & P.model_version.str.startswith('edgedesk_cfb_v2')]
        r = R.get(gid, {})
        out.append({'game_id': gid, 'teams': '%s vs %s' % (p.home_team.iloc[0], p.away_team.iloc[0]),
                    'kickoff': p.kickoff_ts.iloc[0],
                    'v1_timeline': [(x.prediction_ts, x.checkpoint_type, x.origin, x.fair_spread_home_line) for x in p.itertuples()],
                    'draftkings_quotes': [(x.observed_at, x.home_line, bool(x.is_pregame), bool(x.is_provider_close)) for x in q.itertuples()],
                    'v2_rows': [(x.prediction_ts, x.origin, x.model_version, x.fair_spread_home_line) for x in v2.itertuples()],
                    'final': [r.get('home_points'), r.get('away_points')],
                    'news_timeline_available': False})
    return out


def main():
    M = M_()
    out = {'doc': __doc__}
    out['23_prior_double_count'] = prior_double_count(M); print('23 done', flush=True)
    out['20_qb_counterfactual'] = qb_counterfactual(); print('20 done', out['20_qb_counterfactual']['snapshot_shift_when_starter_becomes_first_timer'], flush=True)
    out['22_market_signals'] = market_signals(); print('22 done', flush=True)
    out['34_line_shopping_dev_2016_2019'] = line_shopping(M); print('34', json.dumps(out['34_line_shopping_dev_2016_2019'], default=str)[:1500], flush=True)
    out['41_42_statuses_dev'] = statuses_dev(M); print('42', out['41_42_statuses_dev'], flush=True)
    out['70_disagreement'] = disagreement(M); print('70', json.dumps(out['70_disagreement'], default=str)[:1200], flush=True)
    out['75_77_edges'] = edges(M); print('75', json.dumps(out['75_77_edges'], default=str)[:2500], flush=True)
    out['67_similar_point_in_time'] = similar_pit(); print('67', out['67_similar_point_in_time'], flush=True)
    out['66_matchup_dev'] = matchup_dev(); print('66', out['66_matchup_dev'], flush=True)
    out['78_timeline'] = timeline(); print('78', json.dumps(out['78_timeline'], default=str)[:1500], flush=True)
    _io.write('phase2.json', out)
    print('23', json.dumps(out['23_prior_double_count'], default=str)[:3000])
    print('22', json.dumps(out['22_market_signals'], default=str)[:1500])


if __name__ == '__main__':
    main()
