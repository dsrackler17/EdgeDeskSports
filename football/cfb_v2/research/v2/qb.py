"""Stage 4 — the quarterback model, point-in-time.

A quarterback is not an injury flag. For every passer we keep a career of
opponent-adjusted dropback games:

    adj_epa_db(game) = EPA/dropback - (opponent pass-defence rating at that
                       game's freeze) - h * H

(league-relative, so an average FBS passer against an average defence is 0).
A quarterback's rating at time T is the dropback-weighted, season-decayed mean
of his games before T, shrunk toward the REPLACEMENT mean by k dropbacks. k
and the replacement mean are estimated from the burn-in/early seasons, never
from the season being predicted.

Per team and prediction timestamp:
  qb_exp_rating      the EXPECTED starter: whoever started the team's most
                     recent game this season. (Historical pregame depth
                     charts do not exist in any feed this repository can
                     reach; the most recent start is the only point-in-time
                     signal. In production the status feed overrides it.)
  qb_team_rating     dropback-weighted rating of the passers whose snaps built
                     this season's team offence ratings
  qb_delta           qb_exp_rating - qb_team_rating: what the offence ratings
                     have NOT yet absorbed about who is under centre
  qb_backup_rating   the team's next passer by season dropbacks (replacement
                     mean when there is none) -> starter/backup drop-off
  qb_exp_db_log      log(1 + career dropbacks) of the expected starter
  qb_changed         the expected starter is not the season's dropback leader
  qb_unsettled       the team has used >= 2 different starters in its last 3 games
Week 1 (no game this season yet) is MISSING for every QB field, with a flag.
"""
import numpy as np
import pandas as pd

from . import config as C
from . import common

SEASON_DECAY = 0.6          # weight of a game one season older (declared, checked in report)


def load(seasons):
    Q = pd.concat([pd.read_parquet(common.out_path('stage1', 'qb_game_%d.parquet' % S))
                   for S in seasons], ignore_index=True)
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    Q = Q.merge(G[['game_id', 'season', 'kickoff_ts', 'prediction_ts', 'home_id', 'away_id',
                   'neutral_site', 'status']].rename(columns={'season': 'g_season'}),
                on='game_id', how='inner')
    Q = Q[Q.status.eq('FINAL')].copy()
    Q['opp_id'] = np.where(Q.team_id.eq(Q.home_id), Q.away_id, Q.home_id)
    Q['H'] = np.where(Q.neutral_site, 0, np.where(Q.team_id.eq(Q.home_id), 1, -1))
    return Q, G


def opponent_adjust_past(Q):
    """Opponent adjustment for COMPLETED seasons: the opponent's data-only
    final pass-defence rating of that season. At any prediction time in a
    later season those games are finished, so this is point-in-time."""
    fd = pd.read_parquet(common.out_path('stage3', 'final_dataonly.parquet'))
    fd = fd[fd.metric.eq('epa_pass')].set_index(['season', 'team_id'])['def']
    a = Q.copy()
    dv = fd.reindex(pd.MultiIndex.from_arrays([a.g_season.values, a.opp_id.values])).values
    a['epa_db'] = a.epa_db_sum / a.db_ng.where(a.db_ng > 0)
    a['adj'] = a.epa_db - np.where(np.isnan(dv), 0.0, dv)
    return a


def current_season_adjust(q, ratings_T, h_T):
    """Current-season games, adjusted with the ratings frozen at T."""
    dv = ratings_T.reindex(q.opp_id.values).values
    a = q.copy()
    a['epa_db'] = a.epa_db_sum / a.db_ng.where(a.db_ng > 0)
    a['adj'] = a.epa_db - np.where(np.isnan(dv), 0.0, dv) - h_T * a.H
    return a


def estimate_shrinkage(A, seasons):
    """Empirical Bayes: true between-QB variance vs per-dropback noise."""
    s = A[A.g_season.isin(seasons) & A.db_ng.gt(0) & A.adj.notna()]
    qs = s.groupby(['g_season', 'qb_id']).apply(
        lambda d: pd.Series({'m': np.average(d.adj, weights=d.db_ng), 'n': d.db_ng.sum()}))
    noise = float(np.average((s.adj - s.groupby(['g_season', 'qb_id']).adj.transform('mean')) ** 2
                             * s.db_ng, weights=s.db_ng)) if len(s) else 2.0
    big = qs[qs.n >= 150]
    true_var = max(1e-4, float(big.m.var() - np.mean(noise / big.n)))
    k = noise / true_var
    newbies = qs[qs.n.between(20, 120)]
    repl = float(np.average(newbies.m, weights=newbies.n)) if len(newbies) else -0.1
    return {'noise_per_game_db': noise, 'true_var': true_var, 'k_dropbacks': float(k),
            'replacement_mean': repl, 'seasons': list(seasons)}


def team_features(Q, Apast, G, shrink, seasons_out, only_ts=None, detail=None, ratings=None,
                  league=None):
    """Per team x prediction timestamp QB features (see the module docstring).

    Optional, default off (the output is unchanged when unused):
      only_ts   list of prediction timestamps to compute (instead of every
                freeze of the season)
      detail    dict: receives {(season, T): {'rating', 'den', 'career_db',
                'starts', 'cur'}} — the per-QB posterior mean, its decayed
                dropback count, career dropbacks/starts and the adjusted
                current-season games, exactly as used below
      ratings / league   {season: frame} used instead of reading the stage-3
                files (a freshly rebuilt freeze)"""
    k, repl = shrink['k_dropbacks'], shrink['replacement_mean']
    rows = []
    for S in seasons_out:
        g_s = G[G.season.eq(S)]
        teams = sorted(set(g_s.home_id) | set(g_s.away_id))
        prev = Apast[Apast.g_season < S].dropna(subset=['adj'])
        wp = prev.db_ng * SEASON_DECAY ** (S - prev.g_season)
        num0 = (wp * prev.adj).groupby(prev.qb_id).sum()
        den0 = wp.groupby(prev.qb_id).sum()
        cdb0 = prev.groupby('qb_id').db.sum()
        st0 = prev[prev.starter].groupby('qb_id').size()
        if ratings is not None and S in ratings:
            R = ratings[S][['prediction_ts', 'team_id', 'metric', 'def']]
        else:
            R = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S),
                                columns=['prediction_ts', 'team_id', 'metric', 'def'])
        R = R[R.metric.eq('epa_pass')]
        if league is not None and S in league:
            L = league[S]
        else:
            L = pd.read_parquet(common.out_path('stage3', 'league_%d.parquet' % S))
        L = L[L.metric.eq('epa_pass')].set_index('prediction_ts').h.fillna(0.0)
        qs = Q[Q.g_season.eq(S)]
        pts = sorted(g_s.prediction_ts.unique())
        if only_ts is not None:
            pts = sorted(pd.Timestamp(t) for t in only_ts)
        for T in pts:
            T = pd.Timestamp(T)
            rT = R[R.prediction_ts.eq(T)].set_index('team_id')['def']
            cur = current_season_adjust(qs[qs.kickoff_ts < T], rT, float(L.get(T, 0.0))) \
                .dropna(subset=['adj'])
            num = num0.add((cur.db_ng * cur.adj).groupby(cur.qb_id).sum(), fill_value=0.0)
            den = den0.add(cur.db_ng.groupby(cur.qb_id).sum(), fill_value=0.0)
            rating = (num + k * repl) / (den + k)
            career_db = cdb0.add(cur.groupby('qb_id').db.sum(), fill_value=0)
            starts = st0.add(cur[cur.starter].groupby('qb_id').size(), fill_value=0)
            if detail is not None:
                detail[(S, T)] = {'rating': rating, 'den': den, 'career_db': career_db,
                                  'starts': starts, 'cur': cur}
            for t in teams:
                ct = cur[cur.team_id.eq(t)]
                r = {'season': S, 'prediction_ts': T, 'team_id': t}
                if ct.empty:
                    r.update(qb_missing=1.0)
                    rows.append(r); continue
                last_gid = ct.sort_values('kickoff_ts').game_id.iloc[-1]
                st = ct[(ct.game_id == last_gid) & ct.starter]
                exp_q = int(st.qb_id.iloc[0]) if len(st) else int(ct.qb_id.iloc[-1])
                season_db = ct.groupby('qb_id').db_ng.sum().sort_values(ascending=False)
                team_rating = float(np.average(rating.reindex(season_db.index).fillna(repl),
                                               weights=season_db.values + 1e-9))
                others = [q for q in season_db.index if q != exp_q]
                backup = float(rating.get(others[0], repl)) if others else repl
                last3 = ct.drop_duplicates('game_id').sort_values('kickoff_ts').game_id.tail(3)
                starters3 = ct[ct.game_id.isin(last3) & ct.starter].qb_id.nunique()
                er = float(rating.get(exp_q, repl))
                r.update(qb_missing=0.0, qb_id=exp_q, qb_exp_rating=er, qb_team_rating=team_rating,
                         qb_delta=er - team_rating, qb_backup_rating=backup,
                         qb_drop=er - backup,
                         qb_exp_db_log=float(np.log1p(career_db.get(exp_q, 0))),
                         qb_exp_starts=float(starts.get(exp_q, 0)),
                         qb_changed=float(season_db.index[0] != exp_q),
                         qb_unsettled=float(starters3 >= 2))
                rows.append(r)
    return pd.DataFrame(rows)


def same_starter_rate(Q, seasons):
    """P(the team's most recent starter starts the next game), measured."""
    st = Q[Q.starter & Q.g_season.isin(seasons)].sort_values('kickoff_ts')
    st['prev'] = st.groupby(['team_id', 'g_season']).qb_id.shift(1)
    s = st.dropna(subset=['prev'])
    return float((s.qb_id == s.prev).mean())


def main(seasons_out=None):
    seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    Q, G = load(seasons)
    Apast = opponent_adjust_past(Q)
    shrink = estimate_shrinkage(Apast, [2009, 2010, 2011, 2012, 2013])
    shrink['same_starter_prob'] = same_starter_rate(Q, [2012, 2013, 2014, 2015])
    common.write_json(common.out_path('stage4', 'qb_shrinkage.json'), shrink)
    seasons_out = seasons_out or list(range(C.FIRST_SNAPSHOT_SEASON, C.LIVE_SEASON + 1))
    F = team_features(Q, Apast, G, shrink, seasons_out)
    F.to_parquet(common.out_path('stage4', 'qb_team.parquet'), index=False)
    print('[stage4] qb shrinkage', shrink, 'rows', len(F))


if __name__ == '__main__':
    import sys
    main([int(a) for a in sys.argv[1:]] or None)
