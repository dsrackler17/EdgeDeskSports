"""Tests for the scheme and matchup engine.

    python3 -m v2.matchup.tests_matchup --fast     synthetic checks only (no data directories)
    python3 -m v2.matchup.tests_matchup            + real-data checks (CFB_V2_DATA / CFB_V2_OUT = the V2.1 build)

Prints 'ALL GREEN n passed, 0 failed' (exit 0) or the failures (exit 1).
"""
import json
import os
import sys
import tempfile

import numpy as np
import pandas as pd

from .. import config as C

PASS, FAIL, FAILS = [0], [0], []


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL[0] += 1
        FAILS.append((name, detail))


# =================================================================== synthetic
def synthetic_plays(n_games=4, seed=1):
    """A tiny play table in style.extract_plays' layout with known counts."""
    rng = np.random.default_rng(seed)
    rows = []
    for g in range(n_games):
        gid = 1000 + g
        for side, (tm, op) in enumerate(((1, 2), (2, 1))):
            pn = 0
            for dr in range(4):
                did = '%d-%d-%d' % (gid, side, dr)
                for k in range(6):
                    pn += 1
                    down = [1, 2, 3, 1, 2, 3][k]
                    is_pass = (k % 2 == 1) or (tm == 1 and k == 4)
                    rusher = 11 if (not is_pass and k == 2 and tm == 1) else 50 + k
                    rows.append({'game_id': gid, 'team_id': tm, 'opp_id': op, 'play_no': pn + 100 * side, 'drive_id': did,
                                 'period': 1 + dr % 3, 'secs': 1500.0 - 60 * k, 'sd': 0.0, 'down': down, 'dist': 10.0 - k,
                                 'ytg': 60.0, 'is_rush': not is_pass, 'is_pass': is_pass, 'is_sack': False, 'no_play': False,
                                 'epa': float(rng.normal()), 'succ': bool(k % 3 == 0), 'expl': False, 'conv': bool(k == 5),
                                 'passer': 11.0 if is_pass else np.nan, 'rusher': np.nan if is_pass else float(rusher),
                                 'punt': False, 'fga': False, 'kneel': False, 'yds': 4.0, 'pdown': down == 3,
                                 'drive_secs': 150.0, 'garbage': False, 'scrim': True, 'season': 2019})
                # a 4th-down decision: team 1 goes for it, team 2 punts
                pn += 1
                go = tm == 1
                rows.append({'game_id': gid, 'team_id': tm, 'opp_id': op, 'play_no': pn + 100 * side, 'drive_id': did,
                             'period': 1, 'secs': 1000.0, 'sd': 0.0, 'down': 4, 'dist': 1.0, 'ytg': 50.0, 'is_rush': go,
                             'is_pass': False, 'is_sack': False, 'no_play': False, 'epa': 0.5 if go else np.nan,
                             'succ': go, 'expl': False, 'conv': go, 'passer': np.nan, 'rusher': 60.0 if go else np.nan,
                             'punt': not go, 'fga': False, 'kneel': False, 'yds': 2.0, 'pdown': False, 'drive_secs': 150.0,
                             'garbage': False, 'scrim': go, 'season': 2019})
    return pd.DataFrame(rows)


def fast():
    from . import style as ST
    from . import interactions as IX
    from . import similar as SM
    from . import residual as RS
    from . import changes as CH
    from . import hook as HK
    from . import audit as AU
    from . import backtest as BT

    # ---- audit / forbidden columns
    chk('no forbidden provider column is read by style', not set(ST.PLAY_COLS) & set(AU.FORBIDDEN))
    chk('every audited field has a known status', all(f[2] in ('AVAILABLE', 'DERIVABLE', 'PARTIAL', 'UNRELIABLE', 'UNAVAILABLE',
                                                                'REJECT') for f in AU.FIELDS))
    # ---- expectation models
    P = synthetic_plays()
    X = ST.xpass_design(ST.std13(P))
    chk('xpass design is finite', np.isfinite(X).all(), X.shape)
    rng = np.random.default_rng(0)
    n = 4000
    Q = pd.DataFrame({'down': rng.integers(1, 4, n), 'dist': rng.integers(1, 20, n).astype(float),
                      'ytg': rng.integers(5, 95, n).astype(float), 'sd': rng.normal(0, 10, n), 'period': rng.integers(1, 5, n),
                      'secs': rng.uniform(0, 1800, n)})
    logit = -1 + 0.25 * Q.dist.values * (Q.down.values == 3) + 0.05 * Q.dist.values
    y = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    mdl = ST._fit_logit(ST.xpass_design(Q), y)
    p = ST._predict_logit(mdl, ST.xpass_design(Q))
    long3, short3 = (Q.down == 3) & (Q.dist >= 12), (Q.down == 3) & (Q.dist <= 3)
    chk('xpass learns: 3rd-and-long passes more than 3rd-and-short', p[long3.values].mean() > p[short3.values].mean() + 0.2)
    chk('xpass is calibrated in-sample', abs(p.mean() - y.mean()) < 0.01, (p.mean(), y.mean()))
    # ---- team-game sums with a flat 0.5 model
    flat = {'mu': [0.0] * X.shape[1], 'sd': [1.0] * X.shape[1], 'coef': [0.0] * X.shape[1], 'intercept': 0.0}
    flat_g = {'mu': [0.0] * 14, 'sd': [1.0] * 14, 'coef': [0.0] * 14, 'intercept': 0.0}
    T = ST.team_game_sums(2019, P=P, models={'xpass': flat, 'xgo': flat_g}).set_index(['game_id', 'team_id'])
    t1 = T.loc[(1000, 1)]
    chk('n13 counts downs 1-3 (24 per team-game)', t1.n13 == 24, t1.n13)
    chk('PROE numerator = passes - expected (flat 0.5)', abs(t1.proe_num - (t1.pass13 - 12.0)) < 1e-9, (t1.proe_num, t1.pass13))
    chk('QB rushes: only the rusher who also passed (>= 2 dropbacks) counts', t1.n_qbrush == 4, t1.n_qbrush)
    chk('team 2 has no QB rush', T.loc[(1000, 2)].n_qbrush == 0)
    chk('4th-down decisions: go (team 1) and kick (team 2) counted', t1.go4 == 4 and T.loc[(1000, 2)].go4 == 0 and
        T.loc[(1000, 2)].n_4dec == 4)
    chk('go over expected = go - 0.5 per decision', abs(t1.go_oe_num - 2.0) < 1e-9, t1.go_oe_num)
    chk('neutral tempo = drive seconds / snaps', abs(t1.secs_neu / t1.plays_neu - 150.0 / 7.0) < 1e-9,
        (t1.secs_neu, t1.plays_neu))
    chk('short yardage: 3rd/4th and <= 2 attempts and conversions', t1.n_sy >= 4 and t1.sy_conv >= 4, (t1.n_sy, t1.sy_conv))
    # ---- interaction antisymmetry (scales 1)
    import v2.snapshots as SN
    orig = (SN.metric_scales, ST.metric_scales)
    SN.metric_scales = lambda S: {}
    ST.metric_scales = lambda S, metrics=None: {}
    try:
        g = synthetic_game_rows(12)
        F1 = IX.season_features(g, 2019)
        F2 = IX.season_features(swap_rows(g), 2019)
        anti = [c for fam, cols in IX.FAMILIES.items() if fam not in ('v2_existing', 'environment') for c in cols]
        bad = [c for c in anti if not np.allclose(F1[c].values, -F2[c].values, atol=1e-9, equal_nan=True)]
        chk('every non-environment interaction is antisymmetric under a home/away swap', not bad, bad)
        chk('variance features are symmetric', all(np.allclose(F1[c], F2[c], equal_nan=True) for c in
                                                   ('var_expl', 'var_to', 'var_pace', 'var_qbr', 'var_tempo_gap')))
        conf = HK.matchup_confidence(F1.assign(home_eff_sim=2.0, away_eff_sim=5.0, conf_continuity=1.0))
        chk('matchup confidence in [0, 1]', bool(((conf >= 0) & (conf <= 1)).all()))
        # the explanation reads only numbers present in the row
        r = pd.concat([g, F1], axis=1).iloc[0].to_dict()
        e = HK.explain(r, 'HOME', 'AWAY', {}, {}, 0.0, 0.5, 'NO_ADJUSTMENT', 0.0)
        pe = e['primary_matchup_edge']
        chk('explanation: primary edge carries the measured ratings', pe is not None and
            abs(pe['expected_vs_league'] - (pe['offense_rating'] + pe['defense_allows'])) < 1e-3)
        chk('explanation: NO_ADJUSTMENT says the fair line is the general line', 'general line' in e['note'])
        r2 = dict(r, match_pass_edge=1.0, match_rush_edge=-1.0)
        chk('contradictory signals are surfaced', HK.explain(r2, 'H', 'A', {}, {}, 0, 0.5, 'NO_ADJUSTMENT', 0)
            ['contradictory_signals']['mixed'])
    finally:
        SN.metric_scales, ST.metric_scales = orig
    # ---- similarity kernel
    x = np.array([0.5, -1.0, 2.0])
    Qm = np.vstack([x, x + 0.1, x + 1.0, x * 5])
    s, d = SM.kernel(Qm, x, 'euclid', 0.5)
    chk('self-similarity is 1 at distance 0', abs(s[0] - 1) < 1e-12 and d[0] == 0)
    chk('similarity decreases with distance', s[0] > s[1] > s[2])
    sc, _ = SM.kernel(Qm, x, 'cosine', 0.5)
    chk('cosine: a scaled copy is maximally similar', abs(sc[3] - 1) < 1e-9)
    spec, eff = SM._spec_part(np.array([1.0, 0.5, 0.2]), np.array([3.0, 3.0, 3.0]), np.ones(3))
    chk('similar-opponent residual removes general form (equal residuals -> 0)', abs(spec) < 1e-12)
    spec2, _ = SM._spec_part(np.array([1.0, 0.0]), np.array([4.0, -4.0]), np.ones(2))
    chk('similar-opponent residual is shrunk by K0 pseudo-games', 0 < spec2 < 4.0 and abs(spec2 - 4.0 / (1 + SM.K0)) < 1e-9)
    # ---- residual walk-forward on a planted signal
    D = synthetic_resid_frame()
    raw, adj, lam, models = RS.walk_forward(D, ['sig'])
    y, b = D.margin.values, D.base.values
    m = D.season.ge(2016).values
    chk('a planted matchup signal is learned out of sample', np.mean(np.abs(b[m] + adj.values[m] - y[m])) <
        np.mean(np.abs(b[m] - y[m])) - 0.05)
    raw_n, adj_n, lam_n, _ = RS.walk_forward(D, ['noise'])
    chk('pure noise is shrunk toward zero (mean |adj| small)', np.nanmean(np.abs(adj_n.values[m])) < 0.3,
        np.nanmean(np.abs(adj_n.values[m])))
    chk('lambda is in [0, 1]', all(0 <= v <= 1 for v in lam.values()) and all(0 <= v <= 1 for v in lam_n.values()))
    chk('the cap binds', np.nanmax(np.abs(adj.values)) <= RS.CAP + 1e-12)
    mdl = models[max(models)]
    tr = D[D.season.lt(max(models))]
    chk('the correction has mean zero on its training rows (no intercept / bias learning)',
        abs(np.mean(mdl.predict(tr))) < 1e-9)
    try:
        RS.assert_past_only([2016, 2017], 2017)
        chk('a future season in a training set is refused', False)
    except AssertionError:
        chk('a future season in a training set is refused', True)
    # ---- paired metrics
    z = np.zeros(50)
    pr = RS.paired(np.arange(50.0), z, z, n_boot=100)
    chk('identical predictions give zero deltas and zero CIs', pr['delta']['mae'] == 0 and pr['ci95']['mae'] == [0.0, 0.0])
    # ---- artifact round trip, tamper, NO_ADJUSTMENT
    with tempfile.TemporaryDirectory() as td:
        pth = os.path.join(td, 'a.json')
        RS.freeze({'families': []}, None, {'mean': None, 'lambda': 0.0}, 'NO_ADJUSTMENT', {'x': 1}, path=pth)
        a = RS.load_artifact(pth)
        chk('artifact hash verifies', a['status'] == 'NO_ADJUSTMENT')
        chk('NO_ADJUSTMENT applies exactly zero', np.all(RS.apply(a, D.head(20)) == 0.0))
        j = json.load(open(pth))
        j['status'] = 'ADJUST'
        json.dump(j, open(pth, 'w'))
        try:
            RS.load_artifact(pth)
            chk('a tampered artifact is refused', False)
        except ValueError:
            chk('a tampered artifact is refused', True)
        # the holdout is scored once
        old = C.OUT
        C.OUT = td
        os.makedirs(os.path.join(td, 'matchup'), exist_ok=True)
        open(os.path.join(td, 'matchup', 'holdout.json'), 'w').write('{}')
        try:
            BT.holdout()
            chk('the holdout refuses a second scoring', False)
        except SystemExit:
            chk('the holdout refuses a second scoring', True)
        finally:
            C.OUT = old
    # ---- change points
    xs = np.concatenate([np.zeros(8), np.full(3, 2.0)])
    zz = CH.scan(xs, np.full(11, 0.25))
    chk('a planted style shift is detected at the right game', max(zz, key=lambda t: abs(t[1]))[0] == 11 and
        max(abs(z) for _, z in zz) > 3)
    zz0 = CH.scan(np.random.default_rng(3).normal(0, 0.5, 11), np.full(11, 0.25))
    chk('no shift: the scan stays small', max(abs(z) for _, z in zz0) < 3.5)
    # ---- monitor
    rec = [{'game_id': '1', 'general_fair_margin': 3.0, 'matchup_adjustment_points': 0.0, 'shadow_adjustment_points': 1.0,
            'matchup_confidence': 0.7, 'explanation': {'primary_matchup_edge': {'matchup': 'PASS'}}}] * 6
    mon = HK.lab_monitor(rec, {'1': 7.0})
    chk('lab monitor: zero production adjustment -> zero delta', mon['overall']['delta_adj'] == 0.0)
    chk('lab monitor: shadow direction tracked', mon['overall']['direction_agreement_shadow'] == 1.0)
    chk('pre-registration names the three conditions', len(BT.PREREG['validate_if_all']) == 3)


def synthetic_game_rows(n, seed=5):
    rng = np.random.default_rng(seed)
    from . import style as ST
    v2m = ['epa', 'epa_pass', 'epa_rush', 'sr_pd', 'expl', 'expl_pass', 'expl_rush', 'line_yds', 'stuff', 'havoc', 'sack_rate',
           'to_rate', 'pts_per_opp', 'start_fp', 'pass_rate', 'so_rate']
    g = {}
    for s in ('h', 'a'):
        for m in v2m:
            g['%s_%s__off' % (s, m)] = rng.normal(0, 1, n)
            g['%s_%s__def' % (s, m)] = rng.normal(0, 1, n)
        for m in ST.METRIC_NAMES:
            for u in ('off', 'def'):
                g['%s_s_%s__%s' % (s, m, u)] = rng.normal(0, 1, n)
            g['%s_s_%s__off_var' % (s, m)] = np.full(n, 0.01)
            g['%s_s_%s__n_obs_off' % (s, m)] = np.full(n, 5.0)
        g['%s_qb_exp_db_log' % s] = rng.normal(5, 1.5, n)
        g['%s_qb_changed' % s] = rng.integers(0, 2, n).astype(float)
    for m in v2m:
        g['lg_%s__mu' % m] = np.full(n, 0.4 if m == 'pass_rate' else 0.0)
    for m in ST.METRIC_NAMES:
        g['slg_%s__mu' % m] = np.full(n, 0.3)
    g['exp_plays_total'] = np.full(n, 140.0)
    g['exp_drives_home'] = rng.normal(12, 1, n)
    g['exp_drives_away'] = rng.normal(12, 1, n)
    g['lg_drives_pg__mu'] = np.full(n, 12.0)
    g['ens_pred'] = rng.normal(0, 10, n)
    g['pred_E_drive'] = g['ens_pred'] + rng.normal(0, 2, n)
    for c in ('edge_pts_per_opp', 'edge_so_rate', 'edge_start_fp', 'match_pass_edge', 'match_rush_edge', 'match_mix_edge',
              'match_trench_edge', 'match_havoc_edge', 'match_sack_edge', 'match_explosive_edge', 'match_early_down_edge',
              'match_passing_down_edge', 'match_finishing_edge', 'match_field_pos_edge', 'x_pass_h', 'x_pass_a', 'x_rush_h',
              'x_rush_a', 'x_sack_h', 'x_sack_a'):
        g[c] = rng.normal(0, 1, n)
    for c, v in (('altitude_kft', 1.0), ('tz_shift', 1.0), ('home_field', 1.0), ('qb_missing_any', 0.0),
                 ('qb_unsettled_any', 0.0)):
        g[c] = np.full(n, v)
    return pd.DataFrame(g)


def swap_rows(g):
    s = g.copy()
    for c in g.columns:
        if c.startswith('h_'):
            s['a_' + c[2:]], s[c] = g[c], g['a_' + c[2:]]
    s['exp_drives_home'], s['exp_drives_away'] = g.exp_drives_away, g.exp_drives_home
    for c in ('ens_pred', 'pred_E_drive', 'edge_pts_per_opp', 'edge_so_rate', 'edge_start_fp') + tuple(
            c for c in g.columns if c.startswith('match_')):
        s[c] = -g[c]
    return s


def synthetic_resid_frame(seed=7):
    rng = np.random.default_rng(seed)
    rows = []
    for S in range(2014, 2024):
        n = 700
        sig, noise = rng.normal(0, 1, n), rng.normal(0, 1, n)
        base = rng.normal(0, 10, n)
        margin = base + 2.0 * sig + rng.normal(0, 14, n)
        rows.append(pd.DataFrame({'season': S, 'sig': sig, 'noise': noise, 'base': base, 'margin': margin}))
    D = pd.concat(rows, ignore_index=True)
    D['resid'] = D.margin - D.base
    D['in_scope'] = True
    return D


# =================================================================== real data
def real():
    from .. import common
    from . import style as ST
    from . import residual as RS
    from . import backtest as BT
    from . import interactions as IX
    from . import hook as HK
    M, dfs = BT.load()
    D0 = RS.base_frame(M)
    chk('real: V2.1 p_home_raw reproduced exactly from ens_pred / sigma / t df', BT.identity_check(D0, dfs) == 0.0)
    # style point in time: ratings at T use only games that kicked off before T
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    bad = []
    for S in (2016, 2021, 2025):
        Rt = ST.ratings(S)
        r = Rt[Rt.metric.eq('tempo')]
        TG = ST.team_games(S).merge(G[['game_id', 'kickoff_ts', 'status']], on='game_id')
        TG = TG[TG.status.eq('FINAL') & (TG.plays_neu > 0)]
        for T in sorted(r.prediction_ts.unique())[::5]:
            cnt = TG[TG.kickoff_ts < T].groupby('team_id').size()
            rt = r[r.prediction_ts.eq(T)].set_index('team_id').n_obs_off
            dd = (rt - cnt.reindex(rt.index).fillna(0)).abs().max()
            if dd > 0:
                bad.append((S, str(T), float(dd)))
        first = r[r.prediction_ts.eq(r.prediction_ts.min())]
        if not np.allclose(first.off, first.prior_off):
            bad.append((S, 'first freeze != prior'))
    chk('real: style ratings at T count exactly the games before T (and equal the prior before any game)', not bad, bad[:5])
    # features
    F = pd.read_parquet(common.out_path('matchup', 'features.parquet'))
    chk('real: one feature row per V2.1 game', len(F) == len(M) and (F.game_id.values == M.game_id.values).all())
    # antisymmetry on real rows: swap one season's home/away
    X = M[M.season.eq(2019)].head(200).copy()
    Xs = X.copy()
    for c in X.columns:
        if c.startswith('h_'):
            Xs['a_' + c[2:]], Xs[c] = X[c], X['a_' + c[2:]]
    Xs['home_id'], Xs['away_id'] = X.away_id, X.home_id
    Xs['exp_drives_home'], Xs['exp_drives_away'] = X.exp_drives_away, X.exp_drives_home
    for c in ['ens_pred', 'pred_E_drive', 'edge_pts_per_opp', 'edge_so_rate', 'edge_start_fp'] + [c for c in X if c.startswith('match_')]:
        Xs[c] = -X[c]
    F1, _ = IX.build(X)
    F2, _ = IX.build(Xs)
    anti = [c for fam, cols in IX.FAMILIES.items() if fam not in ('v2_existing', 'environment') for c in cols]
    badc = [c for c in anti if not np.allclose(F1[c].values, -F2[c].values, atol=1e-7, equal_nan=True)]
    chk('real: interactions are antisymmetric under a home/away swap (2019 rows)', not badc, badc)
    # similar pairs: point in time
    P = pd.read_parquet(common.out_path('matchup', 'similar_pairs.parquet'))
    ko = pd.to_datetime(P.comparison_kickoff_ts, utc=True)
    pt = pd.to_datetime(P.prediction_ts, utc=True)
    chk('real: every similar comparison kicked off before the target freeze', bool((ko < pt).all() and P.eligible_pre_prediction.all()))
    chk('real: no comparison is the target game itself', bool((P.comparison_game_id != P.target_game_id).all()))
    # events
    E = pd.read_parquet(common.out_path('matchup', 'style_change_events.parquet'))
    chk('real: every style event clears its calibrated threshold', bool((E.z.abs() >= E.threshold).all()))
    chk('real: every event is detected after its trigger game', bool((pd.to_datetime(E.detected_at, utc=True) >
                                                                     pd.to_datetime(E.trigger_kickoff_ts, utc=True)).all()))
    # dev decision reproduces the pre-registered rule
    dv = json.load(open(common.out_path('matchup', 'backtest_dev.json')))
    again = {f: BT.decide(r) for f, r in dv['families'].items()}
    chk('real: family decisions reproduce the pre-registered rule', again == {f: r['status'] for f, r in dv['families'].items()})
    chk('real: validated families = families with VALIDATED status', sorted(dv['validated_families']) ==
        sorted(f for f, s in again.items() if s == 'VALIDATED' and f != 'v2_existing'))
    # artifact + holdout
    art = RS.load_artifact()
    chk('real: the frozen artifact verifies and matches the dev decision',
        (art['status'] == 'NO_ADJUSTMENT') == (not dv['validated_families']))
    if art['status'] == 'NO_ADJUSTMENT':
        D = BT.frame(M, F)
        chk('real: NO_ADJUSTMENT -> matchup-aware == general on every game', np.all(RS.apply(art, D) == 0.0))
    hf = common.out_path('matchup', 'holdout.json')
    if os.path.exists(hf):
        H = json.load(open(hf))
        chk('real: the holdout was scored with the frozen artifact', H['sha256'] == art['sha256'])
        if art['status'] == 'NO_ADJUSTMENT':
            chk('real: holdout production delta is exactly 0 (no adjustment)', H['production']['delta']['mae'] == 0.0)
    # hook on a real freeze
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[X.season.eq(C.LIVE_SEASON)]
    T = sorted(X.prediction_ts.unique())[-1]
    XT = X[X.prediction_ts.eq(T) & ~X.fcs_game.astype(bool)].head(3)
    out = HK.matchup_week(C.LIVE_SEASON, T, XT, art=art)
    g0 = out['game_matchup'][0]
    stored = M.set_index('game_id').ens_pred.get(int(g0['game_id']))
    chk('real: hook general fair margin = the V2.1 projection', stored is not None and abs(g0['general_fair_margin'] - stored) < 1e-3)
    chk('real: hook matchup-aware = general + adjustment', abs(g0['matchup_aware_margin'] - g0['general_fair_margin']
                                                              - g0['matchup_adjustment_points']) < 2e-3)
    rows = HK.table_rows(out)
    sql = open(os.path.join(os.path.dirname(common.__file__), '..', '..', '..', '..', 'supabase', 'cfb_matchup.sql')).read()
    missing = [c for t, rr in rows.items() for r in rr[:1] for c in r if c not in sql]
    chk('real: every hook column exists in supabase/cfb_matchup.sql', not missing, missing)
    chk('real: team style rows carry style_mean and style_sd', all('off_sd' in v for v in out['team_week_style'][0]['style'].values()))
    au = json.load(open(common.out_path('matchup', 'audit.json')))
    chk('real: the audit covers every season 2009-2026', [r['season'] for r in au['per_season']] == list(range(2009, 2027)))


def main():
    fast_only = '--fast' in sys.argv
    fast()
    if not fast_only:
        real()
    for n, d in FAILS:
        print('FAIL | %s %s' % (n, '' if d is None else json.dumps(d, default=str)[:300]))
    print(('ALL GREEN ' if FAIL[0] == 0 else 'FAILED ') + '%d passed, %d failed' % (PASS[0], FAIL[0]))
    sys.exit(0 if FAIL[0] == 0 else 1)


if __name__ == '__main__':
    main()
