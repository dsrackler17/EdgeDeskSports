"""Similar-opponent engine (docs/cfb-matchup/METHODS.md section 6; brief sections 16-18, 51, 62).

For a team A entering a game against B at the freeze T:
  * every FBS-vs-FBS game A played before T (this season, and last season at half weight) is a
    comparison; its opponent D_i is described by a standardized style vector (behavior AND
    quality: offense vector for the offense A's defense faced, defense vector for the defense A's
    offense faced), as known at T (same-season opponents: their ratings at T; last season's:
    their last freeze of that season). No game at or after T is ever read.
  * similarity s_i = exp(-d_i^2 / (2 h^2 k)) where d_i is the distance between D_i's vector and
    B's vector (k = dimensions; the metric and h are chosen on the DEVELOPMENT seasons from a
    declared grid: standardized Euclidean, Mahalanobis, cosine).
  * the outcome is OPPONENT-ADJUSTED: V2.1's out-of-fold residual in that game (points scored
    minus V2.1's expectation for the offense side, points allowed vs expectation for the defense
    side) -- never wins or losses.
  * the matchup-specific part: sum s_i (r_i - rbar) / (sum s_i + k0), rbar = A's mean residual over
    the same games (general form removed; k0 pseudo-games shrink thin evidence to zero).
  * familiarity: the effective number of similar opponents A has faced (sum s_i), so "has A seen
    anything like B?" is a number, not a label.

Game features (home-minus-away, + favours home):
  sim_resid_edge   (A_off vs defenses like B's + A_def vs offenses like B's) - (same for B)
  sim_margin_edge  the same with the whole-opponent vector and the margin residual
  fam_edge         familiarity of home with away's style minus the reverse
"""
import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import snapshots as SN
from . import style as ST
from . import SIMILARITY_VERSION

OFF_STYLE = ['proe', 'ed_proe', 'pd_proe', 'tempo', 'qb_rush_rate', 'go_oe']
OFF_V2 = ['epa_pass', 'epa_rush', 'expl_pass', 'expl_rush', 'sack_rate', 'stuff']
DEF_STYLE = ['qb_rush_epa', 'proe', 'tempo']
DEF_V2 = ['epa_pass', 'epa_rush', 'expl_pass', 'expl_rush', 'sack_rate', 'havoc', 'stuff']
PREV_SEASON_WEIGHT = 0.5
K0 = 3.0                                  # pseudo-games of shrinkage toward "no matchup-specific effect"
METRICS = ('euclid', 'mahalanobis', 'cosine')
BANDWIDTHS = (0.35, 0.5, 0.75, 1.0)
DEFAULT = {'metric': 'euclid', 'h': 0.5}  # declared default before the dev comparison
TOP_K = 3


def off_cols():
    return ['o_s_' + m for m in OFF_STYLE] + ['o_v_' + m for m in OFF_V2]


def def_cols():
    return ['d_s_' + m for m in DEF_STYLE] + ['d_v_' + m for m in DEF_V2]


def team_vectors(S):
    """(prediction_ts, team_id) -> standardized OFF and DEF style vectors, FBS-centred at each T."""
    sts = ST.metric_scales(S)
    v2s = SN.metric_scales(S)
    Rs = ST.ratings(S)
    Rv = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S),
                         columns=['prediction_ts', 'team_id', 'metric', 'off', 'def'])
    Rv = Rv[Rv.metric.isin(set(OFF_V2) | set(DEF_V2))]
    ws = Rs.pivot_table(index=['prediction_ts', 'team_id'], columns='metric', values=['off', 'def'], aggfunc='first')
    wv = Rv.pivot_table(index=['prediction_ts', 'team_id'], columns='metric', values=['off', 'def'], aggfunc='first')
    V = pd.DataFrame(index=ws.index)
    for m in OFF_STYLE:
        V['o_s_' + m] = ws[('off', m)] / sts.get(m, 1.0)
    for m in DEF_STYLE:
        V['d_s_' + m] = ws[('def', m)] / sts.get(m, 1.0)
    wv = wv.reindex(V.index)
    for m in OFF_V2:
        V['o_v_' + m] = wv[('off', m)] / v2s.get(m, 1.0)
    for m in DEF_V2:
        V['d_v_' + m] = wv[('def', m)] / v2s.get(m, 1.0)
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['season', 'home_id', 'away_id',
                                                                               'home_fbs', 'away_fbs'])
    g = G[G.season.eq(S)]
    fbs = set(g.loc[g.home_fbs, 'home_id']) | set(g.loc[g.away_fbs, 'away_id'])
    V = V.reset_index()
    V['fbs'] = V.team_id.isin(fbs)
    cols = off_cols() + def_cols()
    mu = V[['prediction_ts']].join(V[V.fbs].groupby('prediction_ts')[cols].mean(), on='prediction_ts')[cols]
    V[cols] = V[cols].values - mu.values
    V['season'] = S
    return V


def history_frame(M):
    """Per team-game residual rows from the V2.1 walk-forward (FBS vs FBS, FINAL, predicted)."""
    d = M[(~M.fcs_game.astype(bool)) & M.status.eq('FINAL') & M.margin.notna()].copy()
    d['pred'] = d.ens_pred.where(d.ens_pred.notna(), d[['pred_C_ridge', 'pred_D_gbm']].mean(axis=1))
    d = d[d.pred.notna() & d.pred_total.notna()]
    hp = (d.pred_total + d.pred) / 2.0
    ap = (d.pred_total - d.pred) / 2.0
    h = pd.DataFrame({'game_id': d.game_id, 'season': d.season, 'kickoff_ts': d.kickoff_ts, 'team_id': d.home_id,
                      'opp_id': d.away_id, 'r_margin': d.margin - d.pred, 'r_off': d.home_points - hp,
                      'r_def': -(d.away_points - ap), 'side': 'home'})
    a = pd.DataFrame({'game_id': d.game_id, 'season': d.season, 'kickoff_ts': d.kickoff_ts, 'team_id': d.away_id,
                      'opp_id': d.home_id, 'r_margin': -(d.margin - d.pred), 'r_off': d.away_points - ap,
                      'r_def': -(d.home_points - hp), 'side': 'away'})
    return pd.concat([h, a], ignore_index=True).sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True)


_W_CACHE = {}


def whitening(vectors, cols):
    """Mahalanobis whitening from FBS team vectors at the last freeze of EVERY dev season (2016-2023),
    whatever seasons the caller loaded: a live one-season call gets the identical frozen matrix the
    backtest and the holdout used (dev seasons missing from `vectors` are built here)."""
    key = tuple(cols)
    if key in _W_CACHE:
        return _W_CACHE[key]
    rows = []
    for S in C.DEV_SEASONS:
        V = vectors.get(S)
        if V is None:
            V = team_vectors(S)
        last = V[V.fbs & V.prediction_ts.eq(V.prediction_ts.max())]
        rows.append(last[cols].dropna().values)
    A = np.vstack(rows)
    cov = np.cov(A, rowvar=False) + 1e-6 * np.eye(A.shape[1])
    w, U = np.linalg.eigh(cov)
    _W_CACHE[key] = U @ np.diag(1.0 / np.sqrt(w)) @ U.T
    return _W_CACHE[key]


def kernel(Q, x, metric, h, Wm=None):
    """Similarity of each row of Q to x (both standardized vectors)."""
    ok = np.isfinite(Q).all(axis=1) & np.isfinite(x).all()
    s = np.zeros(len(Q))
    if not ok.any():
        return s, np.full(len(Q), np.nan)
    k = Q.shape[1]
    if metric == 'cosine':
        num = Q[ok] @ x
        den = np.linalg.norm(Q[ok], axis=1) * np.linalg.norm(x) + 1e-12
        cs = num / den
        d = np.sqrt(np.maximum(0.0, 2.0 * (1.0 - cs)))          # chord distance on the unit sphere
        s[ok] = np.exp(-d ** 2 / (2.0 * h ** 2 * 2.0))
    else:
        D = Q[ok] - x
        if metric == 'mahalanobis':
            D = D @ Wm
        d = np.sqrt((D ** 2).sum(axis=1))
        s[ok] = np.exp(-d ** 2 / (2.0 * h ** 2 * k))
    dist = np.full(len(Q), np.nan)
    dist[ok] = d
    return s, dist


def _spec_part(s, r, w):
    """Matchup-specific residual: sum w s (r - rbar) / (sum w s + K0); rbar = w-weighted mean."""
    if len(r) == 0:
        return 0.0, 0.0
    rbar = np.sum(w * r) / np.sum(w)
    ws = w * s
    return float(np.sum(ws * (r - rbar)) / (np.sum(ws) + K0)), float(np.sum(ws))


def _by_team(Hs):
    """team -> dict of arrays (sorted by kickoff) for one season's history rows."""
    out = {}
    for t, g in Hs.groupby('team_id'):
        g = g.sort_values('kickoff_ts', kind='mergesort')
        out[t] = {'ko': g.kickoff_ts.values.astype('datetime64[ns]').astype('int64'), 'opp': g.opp_id.values.astype('int64'),
                  'r_off': g.r_off.values.astype(float), 'r_def': g.r_def.values.astype(float),
                  'r_margin': g.r_margin.values.astype(float), 'game_id': g.game_id.values.astype('int64'),
                  'ko_ts': list(g.kickoff_ts)}
    return out


def _rows(mat, idx, teams):
    r = np.array([idx.get(int(t), -1) for t in teams], dtype=int)
    Q = np.full((len(r), mat.shape[1]), np.nan)
    ok = r >= 0
    if ok.any():
        Q[ok] = mat[r[ok]]
    return Q


def build(M, metric=None, h=None, vectors=None, want_pairs=False, seasons=None):
    """Similar-opponent features for every game of M (a V2.1 stage-7 frame), plus (want_pairs)
    the top comparisons per side for the similarity table."""
    metric = metric or DEFAULT['metric']
    h = h or DEFAULT['h']
    seasons = seasons or sorted(M.season.unique())
    # every season AND the one before it (its last freeze describes last season's opponents)
    vectors = vectors or {S: team_vectors(S) for S in sorted(set(seasons) | {s - 1 for s in seasons})
                          if S >= C.FIRST_SNAPSHOT_SEASON}
    oc, dc = off_cols(), def_cols()
    allc = oc + dc
    ci = {c: i for i, c in enumerate(allc)}
    kinds = (('off', [ci[c] for c in dc], 'r_off'), ('def', [ci[c] for c in oc], 'r_def'),
             ('all', list(range(len(allc))), 'r_margin'))
    W = {}
    if metric == 'mahalanobis':
        W = {'off': whitening(vectors, dc), 'def': whitening(vectors, oc), 'all': whitening(vectors, allc)}
    H = history_frame(M)
    Hs = {S: g for S, g in H.groupby('season')}
    feats, pairs = [], []
    for S in seasons:
        VS = vectors[S]
        byT = {T: (dict(zip(g.team_id.astype(int), range(len(g)))), g[allc].values.astype(float))
               for T, g in VS.groupby('prediction_ts')}
        Vprev = vectors.get(S - 1)
        prev = None
        if Vprev is not None:
            lp = Vprev[Vprev.prediction_ts.eq(Vprev.prediction_ts.max())]
            prev = (dict(zip(lp.team_id.astype(int), range(len(lp)))), lp[allc].values.astype(float))
        hn = _by_team(Hs.get(S, H.iloc[:0]))
        hp = _by_team(Hs.get(S - 1, H.iloc[:0])) if prev is not None else {}
        games = M[M.season.eq(S)]
        for T, gT in games.groupby('prediction_ts'):
            if T not in byT:
                continue
            idx, mat = byT[T]
            Tn = pd.Timestamp(T).value
            for gm in gT[['game_id', 'home_id', 'away_id']].itertuples(index=False):
                rec = {'game_id': gm.game_id}
                sides = {}
                for side, A, B in (('home', int(gm.home_id), int(gm.away_id)), ('away', int(gm.away_id), int(gm.home_id))):
                    a = hn.get(A)
                    k = int(np.searchsorted(a['ko'], Tn, side='left')) if a is not None else 0
                    assert a is None or k == 0 or a['ko'][k - 1] < Tn
                    b = hp.get(A) if prev is not None else None
                    opp_now = a['opp'][:k] if a is not None else np.array([], dtype='int64')
                    Qn = _rows(mat, idx, opp_now)
                    if b is not None:
                        Qp = _rows(prev[1], prev[0], b['opp'])
                        Q = np.vstack([Qn, Qp])
                        w = np.concatenate([np.ones(k), np.full(len(b['opp']), PREV_SEASON_WEIGHT)])
                    else:
                        Q, w = Qn, np.ones(k)
                    cat = lambda f: np.concatenate([a[f][:k] if a is not None else np.array([]),
                                                    b[f] if b is not None else np.array([])])
                    xB = _rows(mat, idx, [B])[0]
                    out = {}
                    for kind, cols_i, rcol in kinds:
                        # A's OFFENSE is compared on the DEFENSES it faced (vs B's defense), and so on
                        sim, dist = kernel(Q[:, cols_i], xB[cols_i], metric, h, W.get(kind))
                        r = cat(rcol)
                        spec, eff = _spec_part(sim, r, w)
                        out[kind] = (spec, eff, float(np.max(sim)) if len(sim) else 0.0)
                        if want_pairs and kind == 'all' and len(sim):
                            gids = cat('game_id').astype('int64')
                            opps = np.concatenate([opp_now, b['opp'] if b is not None else np.array([], dtype='int64')])
                            kos = (a['ko_ts'][:k] if a is not None else []) + (b['ko_ts'] if b is not None else [])
                            for j in np.argsort(-sim)[:TOP_K]:
                                diff = Q[j, cols_i] - xB[cols_i]
                                order = np.argsort(-np.abs(np.nan_to_num(diff)))[:3]
                                close = np.argsort(np.abs(np.nan_to_num(diff, nan=9)))[:3]
                                pairs.append({
                                    'target_game_id': int(gm.game_id), 'season': int(S), 'prediction_ts': T,
                                    'team_side': side, 'team_id': A, 'upcoming_opponent_id': B,
                                    'comparison_game_id': int(gids[j]), 'comparison_opponent_id': int(opps[j]),
                                    'comparison_kickoff_ts': kos[j], 'similarity_score': float(sim[j]),
                                    'feature_distance': float(dist[j]),
                                    'eligible_pre_prediction': bool(kos[j] < T),
                                    'comparison_margin_residual': float(r[j]),
                                    'relevant_differences': {allc[cols_i[i]]: round(float(diff[i]), 3) for i in order},
                                    'closest_features': {allc[cols_i[i]]: round(float(diff[i]), 3) for i in close},
                                    'same_season': bool(j < k), 'similarity_version': SIMILARITY_VERSION})
                    sides[side] = out
                    rec['%s_n_hist' % side] = int(len(w))
                    rec['%s_fam_def' % side] = out['def'][1]
                    rec['%s_fam_off' % side] = out['off'][1]
                    rec['%s_max_sim' % side] = out['all'][2]
                    rec['%s_eff_sim' % side] = out['all'][1]
                h_, a_ = sides['home'], sides['away']
                rec['sim_resid_edge'] = (h_['off'][0] + h_['def'][0]) - (a_['off'][0] + a_['def'][0])
                rec['sim_margin_edge'] = h_['all'][0] - a_['all'][0]
                nh, na = max(rec['home_n_hist'], 1), max(rec['away_n_hist'], 1)
                rec['fam_edge'] = (h_['def'][1] + h_['off'][1]) / nh - (a_['def'][1] + a_['off'][1]) / na
                feats.append(rec)
    F = pd.DataFrame(feats)
    F['similarity_version'] = SIMILARITY_VERSION
    F['metric'], F['h'] = metric, h
    return (F, pd.DataFrame(pairs)) if want_pairs else F


FAMILY = {'similar_opp': ['sim_resid_edge', 'sim_margin_edge', 'fam_edge']}
