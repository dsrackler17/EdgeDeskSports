"""Lineup scenarios on the FROZEN artifact -- the quarterback part (docs/cfb-personnel/QB.md).

    out = project(X_rows, A, gbm, starters)          # per game: scenarios, mixture, delta vs V2.1

For each game the expected-starter distribution of each team (personnel.qb.expected_starters) is
turned into scenarios (home option x away option, p = p_home * p_away). Each scenario row is the
game's V2.1 feature row with EXACTLY the QB columns the artifact reads rebuilt the way
v2/qb.py team_features and v2/snapshots.build_season build them, for that starter:

  per team (h_/a_):  qb_missing, qb_id, qb_exp_rating, qb_team_rating, qb_delta, qb_backup_rating,
                     qb_drop, qb_exp_db_log, qb_exp_starts, qb_changed, qb_unsettled
  per game:          qb_missing_any, qb_unsettled_any, qb_delta_edge, qb_exp_edge
  (models.add_derived then fills qb_exp_edge, *_qb_exp_db_log, *_qb_changed NaN -> 0 inside predict)

Every scenario runs through weekly.project.infer (predict_live.predict: the approved submodels,
the approved stack, the approved sigma model and t distribution -- no refit), and the scenarios mix:

  mean = sum p_s mu_s,   var = sum p_s (sigma_s^2 + mu_s^2) - mean^2,   P(home) = sum p_s P_s

A scenario whose starters are V2's expected starters IS the unmodified row, so with no report the
output equals weekly.project.infer on the V2.1 row exactly (tests_qb: no_report_identity).

Double-count protection: qb_delta = expected - qb_team_rating, the rating baseline of the passers
whose snaps built the team's offence ratings. baseline_lineup() measures how far that baseline is
from the lineup the ratings actually contain (the preseason prior's share and the recent horizon's
8-week half-life) -- reported, never changed (V2 is frozen).
"""
import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import project as PJ
from . import qb as PQ

RULE_VERSION = 'cfb_personnel_lineup_qb_v1'
SIDE_COLS = PQ.QB_SIDE_COLS
GAME_QB_COLS = ('qb_missing_any', 'qb_unsettled_any', 'qb_delta_edge', 'qb_exp_edge')
MIX_INTERVALS = (0.80, 0.95)
DEFAULT_DB_PER_GAME = PQ.DEFAULT_DB_PER_GAME
# Points layer (the challenger candidate): a scenario's margin = V2.1 + QB_POINTS_BETA x lineup delta
# in points, delta = (rating of the scenario starter - rating of V2's expected starter) x the team's
# non-garbage dropbacks per game before T (home minus away). QB_POINTS_BETA is the slope of the V2.1
# walk-forward residual on that delta over QB-change games of 2014-2023 (DEV; oracle starters),
# through the origin, frozen (backtest_qb.oracle(..., beta_frozen_through=2023)); the artifact's own
# QB inputs move the margin by only ~0.06 points per point of delta.
#   fitted: beta = 0.3331, bootstrap 95% CI [0.147, 0.509], n = 1,728 QB-change games (2014-2023; changes
#   involving a provider placeholder passer id excluded). Theory (1 EPA = 1 point) would say 1.0: the
#   realised value of a starter change is about a third of the rating gap times dropbacks.
QB_POINTS_BETA = 0.333115


# ------------------------------------------------------------ the columns
def artifact_qb_inputs(A):
    """Every artifact input that is a QB quantity (model_inputs: the submodels and the sigma design)."""
    return [c for c in PJ.model_inputs(A) if 'qb' in c]


def uncovered_qb_inputs(A):
    """QB inputs the rebuild would NOT reproduce (must be empty; tests_qb asserts it)."""
    have = set(GAME_QB_COLS) | {p + c for p in ('h_', 'a_') for c in SIDE_COLS}
    return [c for c in artifact_qb_inputs(A) if c not in have]


def game_qb_columns(X, idx=None):
    """snapshots.build_season's four game-level QB lines, on rows `idx` (default all), in place."""
    ix = X.index if idx is None else idx
    s = X.loc[ix]
    X.loc[ix, 'qb_missing_any'] = s[['h_qb_missing', 'a_qb_missing']].fillna(1).max(axis=1)
    X.loc[ix, 'qb_unsettled_any'] = s[['h_qb_unsettled', 'a_qb_unsettled']].fillna(0).max(axis=1)
    X.loc[ix, 'qb_delta_edge'] = s['h_qb_delta'].fillna(0) - s['a_qb_delta'].fillna(0)
    X.loc[ix, 'qb_exp_edge'] = s['h_qb_exp_rating'] - s['a_qb_exp_rating']
    return X


def set_side(X, idx, side, feats):
    """Write one team's rebuilt QB columns (missing keys -> NaN, as a V2 week-1 row)."""
    pre = 'h_' if side == 'home' else 'a_'
    for c in SIDE_COLS:
        X.loc[idx, pre + c] = feats.get(c, np.nan)


# -------------------------------------------------------------- mixtures
def _t_cdf(x, df):
    from .. import walkforward as WF
    return WF.t_cdf(x, df)


def mixture(p, mu, sd, pw, t_df):
    """Mixture of the scenarios' predictive distributions (each a unit-variance t scaled by sigma,
    the artifact's error model). Exact moments; intervals by bisection on the mixture CDF.
    One scenario: returned as is (no floating-point re-derivation)."""
    p, mu, sd, pw = (np.asarray(v, dtype=float) for v in (p, mu, sd, pw))
    if len(p) == 1:
        m, s = float(mu[0]), float(sd[0])
        out = {'margin': m, 'sd': s, 'p_home': float(pw[0])}
    else:
        m = float(np.sum(p * mu))
        v = float(np.sum(p * (sd ** 2 + mu ** 2)) - m ** 2)
        out = {'margin': m, 'sd': float(np.sqrt(max(v, 0.0))), 'p_home': float(np.sum(p * pw))}
    cdf = lambda x: float(np.sum(p * _t_cdf((x - mu) / sd, t_df)))
    lo_b, hi_b = float(np.min(mu - 12 * sd)), float(np.max(mu + 12 * sd))
    for lvl in MIX_INTERVALS:
        qs = []
        for q in (0.5 - lvl / 2, 0.5 + lvl / 2):
            lo, hi = lo_b, hi_b
            for _ in range(80):
                mid = 0.5 * (lo + hi)
                if cdf(mid) < q:
                    lo = mid
                else:
                    hi = mid
            qs.append(0.5 * (lo + hi))
        out['int%d' % int(round(lvl * 100))] = qs
    return out


# -------------------------------------------------------------- scenarios
def side_options(entry, ratings):
    """[(p, feats or None, meta)] for one team; feats None = keep the V2.1 row's columns (the
    option IS V2's expected starter), so the unmodified row is reused bit for bit. meta carries the
    option's lineup delta in points (d_pts) for the points layer."""
    ctx = entry['ctx']
    opts = []
    for d in entry['dist']:
        q = d['qb_id']
        same = (not ctx['missing']) and q is not None and q == ctx['v2_starter']
        d = dict(d)
        if ctx['missing'] or same:
            feats = None
            d['d_pts'] = 0.0
        else:
            feats = PQ.side_features(ctx, q, ratings)
            r_v2 = float(ratings['rating'].get(ctx['v2_starter'], ctx['repl']))
            d['d_pts'] = (feats['qb_exp_rating'] - r_v2) * float(ctx.get('db_per_game', DEFAULT_DB_PER_GAME))
            d['rating'] = feats['qb_exp_rating']
        opts.append((float(d['p']), feats, d))
    return opts


def project(X_rows, A, gbm, starters, ratings_by_ts, now=None, points_beta=None):
    """Scenario projections for the games in X_rows (V2.1 feature rows, one per game).

    starters      {(game_id, team_id): entry} from personnel.qb.expected_starters
    ratings_by_ts {prediction_ts: personnel.qb.ratings_at(...)}
    points_beta   slope of the points layer (default QB_POINTS_BETA); each scenario also gets
                  margin_points = V2.1 base + beta x (d_pts home - d_pts away), same sigma as V2.1
    Returns (games, scenario_frame): per game a dict with the scenarios, the artifact mixture, the
    points-layer mixture, the plain V2.1 projection and the deltas, plus the flat scenario rows."""
    beta = QB_POINTS_BETA if points_beta is None else points_beta
    nm = PQ.names()
    rows, meta = [], []
    base_rows = X_rows.copy()
    for i, (_, r) in enumerate(X_rows.iterrows()):
        gid = int(r.game_id)
        T = pd.Timestamp(r.prediction_ts)
        rat = ratings_by_ts[T]
        eh = starters[(gid, int(r.home_id))]
        ea = starters[(gid, int(r.away_id))]
        for ph, fh, mh in side_options(eh, rat):
            for pa, fa, ma in side_options(ea, rat):
                row = r.copy()
                changed = False
                if fh is not None:
                    for c in SIDE_COLS:
                        row['h_' + c] = fh.get(c, np.nan)
                    changed = True
                if fa is not None:
                    for c in SIDE_COLS:
                        row['a_' + c] = fa.get(c, np.nan)
                    changed = True
                rows.append(row)
                meta.append({'game_id': gid, 'p': ph * pa, 'changed': changed, 'home': mh, 'away': ma,
                             'd_pts': mh['d_pts'] - ma['d_pts']})
    if not rows:
        return [], pd.DataFrame()
    S = pd.DataFrame(rows).reset_index(drop=True)
    ch = [j for j, m in enumerate(meta) if m['changed']]
    if ch:
        game_qb_columns(S, S.index[ch])
    D = PJ.infer(S, A, gbm)
    B = PJ.infer(base_rows.reset_index(drop=True), A, gbm)
    Bg = B.set_index(B.game_id.astype('int64'))
    t_df = A['t_df']
    games = []
    D['scenario_p'] = [m['p'] for m in meta]
    D['rebuilt'] = [m['changed'] for m in meta]
    for gid, grp in D.groupby(D.game_id.astype('int64'), sort=False):
        ix = list(grp.index)
        p = grp.scenario_p.values
        mix = mixture(p, grp.ens_pred.values, grp.sigma.values, grp.p_home_calibrated.values, t_df)
        b = Bg.loc[gid]
        scen = []
        mpts, ppts = [], []
        for j in ix:
            m = meta[j]
            mp = float(b.ens_pred) + (beta or 0.0) * m['d_pts']
            pp = float(PJ.calibrate_win(1.0 - _t_cdf(np.array([-mp / float(b.sigma)]), t_df), A['win_calibration'])[0])
            mpts.append(mp); ppts.append(pp)
            scen.append({
                'p': round(float(m['p']), 6),
                'home_qb': _qb_meta(m['home'], nm), 'away_qb': _qb_meta(m['away'], nm),
                'margin': float(D.at[j, 'ens_pred']), 'sigma': float(D.at[j, 'sigma']),
                'p_home': float(D.at[j, 'p_home_calibrated']), 'rebuilt_qb_columns': bool(m['changed']),
                'd_pts': float(m['d_pts']), 'margin_points': mp, 'p_home_points': pp})
        mix_pts = mixture(p, np.array(mpts), np.full(len(mpts), float(b.sigma)), np.array(ppts), t_df) \
            if beta is not None else None
        g0 = grp.iloc[0]
        games.append({
            'game_id': int(gid), 'season': int(g0.season), 'week': int(g0.week),
            'home_team': g0.get('home_team'), 'away_team': g0.get('away_team'),
            'prediction_ts': common.iso(pd.Timestamp(g0.prediction_ts).to_pydatetime()),
            'kickoff': common.iso(pd.Timestamp(g0.kickoff_ts).to_pydatetime()) if 'kickoff_ts' in g0 else None,
            'now': None if now is None else common.iso(pd.Timestamp(now).to_pydatetime()),
            'model_version': A['model_version'], 'rule_version': PQ.RULE_VERSION, 'lineup_rule': RULE_VERSION,
            'base': {'margin': float(b.ens_pred), 'sigma': float(b.sigma), 'p_home': float(b.p_home_calibrated)},
            'scenarios': scen, 'n_scenarios': len(scen), 'mixture': mix,
            'delta_vs_base': {'margin': mix['margin'] - float(b.ens_pred), 'sd': mix['sd'] - float(b.sigma),
                              'p_home': mix['p_home'] - float(b.p_home_calibrated)},
            'points_layer': None if mix_pts is None else {
                'beta': beta, 'mixture': mix_pts,
                'delta_vs_base': {'margin': mix_pts['margin'] - float(b.ens_pred),
                                  'sd': mix_pts['sd'] - float(b.sigma),
                                  'p_home': mix_pts['p_home'] - float(b.p_home_calibrated)}},
            'knowledge': {'home': starters[(int(gid), int(g0.home_id))]['knowledge'],
                          'away': starters[(int(gid), int(g0.away_id))]['knowledge']},
            'reports': {'home': starters[(int(gid), int(g0.home_id))]['report'],
                        'away': starters[(int(gid), int(g0.away_id))]['report']},
        })
    return games, D


def _qb_meta(d, nm):
    q = d.get('qb_id')
    return {'qb_id': None if q is None else int(q),
            'name': None if q is None else (nm.get(int(q)) if len(nm) else None),
            'p': round(float(d['p']), 6), 'status': d.get('status'), 'role': d.get('role'),
            'd_pts': round(float(d.get('d_pts', 0.0)), 4)}


# ======================================================= baseline lineup
def _team_games(S):
    t = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % S),
                        columns=['game_id', 'team_id', 'n_db'])
    return t


def baseline_lineup(S, R=None, F=None):
    """How far V2's rating baseline (qb_team_rating) is from the lineup the pass-offence ratings
    actually contain, per team x freeze of season S.

    Season horizon (the edge_* inputs): every game weighted by its dropbacks / s2_play (varcomp:
    s2_game ~ 0, so per dropback -- the SAME weighting as qb_team_rating) PLUS the preseason prior,
    whose share of the posterior mean is  pi = off_var(T) / off_var(T0)  (exact for one team,
    approximate in the joint solve; checked against 1/tau2 / (1/tau2 + n/s2) here).
    Recent horizon (edge_rec_*): games AND the prior decayed by 0.5 ** (age / 8 weeks).
    The prior's lineup is proxied by last season's passers on this team (the prior regresses on the
    lagged final rating), valued at their ratings at T.
      L_season = pi L_prior + (1-pi) sum_q W_q r_q,  L_recent likewise with the decayed weights
      mismatch = L - qb_team_rating      (EPA/dropback; x team dropbacks/game = points/game)
    FBS teams only (FCS teams share one pooled prior; V2 does not price their games)."""
    b = PQ.base()
    Q, G = b['Q'], b['G']
    repl = b['shrink']['replacement_mean']
    if R is None or F is None:
        R, F = PQ.season_ratings(S)
    import json
    vc = json.load(open(common.out_path('stage3', 'varcomp.json')))
    s2p = float(vc['epa_pass'][0])
    rt = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S),
                         columns=['prediction_ts', 'team_id', 'metric', 'off_var', 'n_obs_off'])
    rt = rt[rt.metric.eq('epa_pass')]
    T0 = rt.prediction_ts.min()
    tau2 = rt[rt.prediction_ts.eq(T0)].set_index('team_id').off_var
    ov = rt.set_index(['prediction_ts', 'team_id']).off_var
    season_start = G[G.season.eq(S)].kickoff_ts.min() - pd.Timedelta(days=3)
    hl = C.RECENT_HALFLIFE_WEEKS
    tg = _team_games(S)
    qs = Q[Q.g_season.eq(S)]
    qg = qs[qs.db_ng > 0].groupby(['game_id', 'team_id', 'qb_id']).db_ng.sum().reset_index()
    qg['share'] = qg.db_ng / qg.groupby(['game_id', 'team_id']).db_ng.transform('sum')
    kick = qs.drop_duplicates('game_id').set_index('game_id').kickoff_ts
    qg['kickoff_ts'] = qg.game_id.map(kick)
    qg = qg.merge(tg, on=['game_id', 'team_id'], how='left')
    prev = Q[Q.g_season.eq(S - 1) & Q.db_ng.gt(0)].groupby(['team_id', 'qb_id']).db_ng.sum()
    gS = G[G.season.eq(S)]
    fbs = set(gS[gS.home_fbs.astype(bool)].home_id) | set(gS[gS.away_fbs.astype(bool)].away_id)
    Fs = F[F.qb_missing.eq(0) & F.team_id.isin(fbs)].set_index(['prediction_ts', 'team_id'])
    out = []
    for T, rT in R.groupby('prediction_ts'):
        rat = rT.set_index('qb_id').rating
        g = qg[qg.kickoff_ts < T]
        if g.empty:
            continue
        age = (T - g.kickoff_ts).dt.total_seconds() / (7 * 86400.0)
        g = g.assign(w=g.n_db.fillna(g.db_ng) / s2p, dec=0.5 ** (age / hl))
        pw = 0.5 ** (max(0.0, (T - season_start).total_seconds() / (7 * 86400.0)) / hl)
        for tid, gt in g.groupby('team_id'):
            if (T, tid) not in Fs.index or tid not in tau2.index:
                continue
            f = Fs.loc[(T, tid)]
            games = gt.drop_duplicates('game_id')
            n_data = float(games.w.sum())
            n_rec = float((games.w * games.dec).sum())
            p_prec = 1.0 / float(tau2[tid])
            pi_1p = p_prec / (p_prec + n_data)
            pi_var = float(ov.get((T, tid), np.nan)) / float(tau2[tid])
            pi_rec = pw * p_prec / (pw * p_prec + n_rec)
            ws = (gt.w * gt.share).groupby(gt.qb_id).sum()
            wr = (gt.w * gt.dec * gt.share).groupby(gt.qb_id).sum()
            r_q = rat.reindex(ws.index).fillna(repl)
            data_s = float(np.sum(ws * r_q) / ws.sum())
            data_r = float(np.sum(wr * r_q) / wr.sum())
            if tid in prev.index.get_level_values(0):
                pq = prev.loc[tid]
                L_prior = float(np.average(rat.reindex(pq.index).fillna(repl), weights=pq.values))
            else:
                L_prior = repl
            team_rating = float(f.qb_team_rating)
            L_s = pi_var * L_prior + (1 - pi_var) * data_s
            L_r = pi_rec * L_prior + (1 - pi_rec) * data_r
            exp_q = int(f.qb_id)
            new_share_v2 = float(gt[gt.qb_id.eq(exp_q)].db_ng.sum() / gt.db_ng.sum())
            out.append({'season': S, 'prediction_ts': T, 'team_id': int(tid), 'games': int(len(games)),
                        'db_per_game': float(games.n_db.mean()),
                        'pi_season': pi_var, 'pi_season_1param': pi_1p, 'pi_recent': pi_rec,
                        'qb_team_rating': team_rating, 'data_lineup_season': data_s, 'data_lineup_recent': data_r,
                        'prior_lineup': L_prior, 'L_season': L_s, 'L_recent': L_r,
                        'mismatch_season': L_s - team_rating, 'mismatch_recent': L_r - team_rating,
                        'exp_q': exp_q, 'exp_share_qb_team_rating': new_share_v2,
                        'exp_weight_season': (1 - pi_var) * float(ws.get(exp_q, 0.0) / ws.sum()),
                        'exp_weight_recent': (1 - pi_rec) * float(wr.get(exp_q, 0.0) / wr.sum()),
                        'exp_in_prior': bool(tid in prev.index.get_level_values(0)
                                             and exp_q in prev.loc[tid].index),
                        'qb_exp_rating': float(f.qb_exp_rating)})
    return pd.DataFrame(out)
