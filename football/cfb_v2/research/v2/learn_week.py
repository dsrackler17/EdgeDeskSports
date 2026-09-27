"""Weekly learning: score the frozen predictions, classify major misses, update monitoring.

    python3 -m v2.learn_week --season 2026

Nothing here refits a model. After a completed week it:
  * joins every frozen (or replayed) V2 projection to the final score;
  * stores the error, and for MAJOR misses (|error| > 1.5 sigma) assigns the
    most likely contributor from measurable evidence in that game;
  * writes football/cfb_v2/learning/<season>_misses.json and
    football/cfb_v2/monitoring.json (rolling accuracy, bias, interval
    coverage, CLV vs the close), so the ENGINE is improved on patterns across
    many games — never a coefficient changed after one Saturday.

Classification (first rule that fires, evidence recorded):
  qb_injury_miss          the team's actual starter was not the expected starter
  turnover_variance       turnover margin >= 3 in the direction of the miss
  special_teams           net special-teams EPA >= 7 pts in the direction of the miss
  explosive_variance      explosive-play differential >= 5 in the direction of the miss
  garbage_time            >= 30% of snaps in garbage time and the miss is in the blowout's direction
  market_news_unavailable the close moved >= 3 pts from the opener in the direction of the miss
  bad_team_rating         the next freeze moved a team's EPA rating by >= 0.08/play toward the result
  matchup_interaction     play-level EPA/play differential agreed with the projection's side, the score did not
  ordinary_variance       none of the above
(weather is never assigned: no pregame forecast archive exists to attribute it)
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import common

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def load_predictions(season, snap_dir=None):
    """Every frozen and replayed row of the season, each under the model_version that
    PRODUCED it (audit F-02): the row's own `model_version` (rows carry it since the
    v2.1.1 patch), else its file's. A replay built by v2.0.0 is graded as v2.0.0, never
    under the production version's name."""
    d = snap_dir or os.path.join(REPO_V2, 'snapshots', str(season))
    rows = []
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if not f.endswith('.json'):
                continue
            j = json.load(open(os.path.join(d, f)))
            if f == 'replay_to_date.json':
                for r in j['rows']:
                    rows.append(dict(r, source='REPLAY', model_version=r.get('model_version') or j.get('model_version'),
                                     snapshot_file=f))
            else:
                for x in j['rows']:
                    rows.append(dict(x['row'], source='FROZEN', hash=x['hash'], snapshot_file=f,
                                     model_version=x['row'].get('model_version') or j.get('model_version')))
    P = pd.DataFrame(rows)
    if P.empty:
        return P
    P['model_version'] = P.model_version.fillna('UNKNOWN')
    # per version, a frozen row beats a replay row for the same game
    P['rank'] = P.source.map({'FROZEN': 0, 'REPLAY': 1})
    return P.sort_values(['model_version', 'game_id', 'rank']).drop_duplicates(['model_version', 'game_id']) \
        .drop(columns='rank')


def classify(r, tg, qb, rnext, mk):
    miss = r['margin'] - r['ens_pred']                  # + = home did better than projected
    s = np.sign(miss)
    h, a = r['home_id'], r['away_id']
    ev = {}
    def side(tid, col):
        x = tg[(tg.game_id == r['game_id']) & (tg.team_id == tid)]
        return float(x[col].iloc[0]) if len(x) and col in x else np.nan
    # QB
    q = qb[qb.game_id == r['game_id']]
    for tid, key in ((h, 'home'), (a, 'away')):
        st = q[(q.team_id == tid) & q.starter]
        exp = (r.get('qb') or {}).get(key) if isinstance(r.get('qb'), dict) else None
        if len(st) and exp and exp.get('qb_id') and int(st.qb_id.iloc[0]) != int(exp['qb_id']):
            ev['qb'] = {key: {'expected': exp['qb_id'], 'actual': int(st.qb_id.iloc[0])}}
            return 'qb_injury_miss', ev
    to_m = side(a, 'turnovers') - side(h, 'turnovers')      # + = home won the turnover battle
    ev['turnover_margin_home'] = to_m
    if abs(to_m) >= 3 and np.sign(to_m) == s:
        return 'turnover_variance', ev
    st_n = side(h, 'st_net_epa')
    ev['st_net_home'] = st_n
    if abs(st_n) >= 7 and np.sign(st_n) == s:
        return 'special_teams', ev
    ex = side(h, 'expl') - side(a, 'expl')
    ev['explosive_diff_home'] = ex
    if abs(ex) >= 5 and np.sign(ex) == s:
        return 'explosive_variance', ev
    gp = (side(h, 'garbage_plays') + side(a, 'garbage_plays')) / max(1.0, side(h, 'n_plays_all') + side(a, 'n_plays_all'))
    ev['garbage_share'] = gp
    if gp >= 0.30 and np.sign(r['margin']) == s:
        return 'garbage_time', ev
    m = mk.get(r['game_id'])
    if m is not None and not np.isnan(m[0]) and not np.isnan(m[1]):
        mv = m[1] - m[0]
        ev['close_minus_open'] = mv
        if abs(mv) >= 3 and np.sign(mv) == s:
            return 'market_news_unavailable', ev
    if rnext is not None:
        dh = rnext.get(h, np.nan) - r.get('_h_epa', np.nan)
        da = rnext.get(a, np.nan) - r.get('_a_epa', np.nan)
        ev['rating_move'] = {'home': dh, 'away': da}
        if (not np.isnan(dh) and abs(dh) >= 0.08 and np.sign(dh) == s) or \
           (not np.isnan(da) and abs(da) >= 0.08 and np.sign(-da) == s):
            return 'bad_team_rating', ev
    epa_d = side(h, 'epa_sum') / max(1, side(h, 'n_plays')) - side(a, 'epa_sum') / max(1, side(a, 'n_plays'))
    ev['epa_play_diff_home'] = epa_d
    if np.sign(epa_d) == np.sign(r['ens_pred']) and np.sign(r['margin']) != np.sign(r['ens_pred']):
        return 'matchup_interaction', ev
    return 'ordinary_variance', ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=C.LIVE_SEASON)
    a = ap.parse_args()
    P = load_predictions(a.season)
    if P.empty:
        print('[learn] no predictions for', a.season); return
    # grade only against a current build (F-01 finality; never the stale research/out, F-10)
    stamp = common.require_build(purpose='grading %d' % a.season, stages=('stage2',))
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    tg = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % a.season))
    qb = pd.read_parquet(common.out_path('stage1', 'qb_game_%d.parquet' % a.season))
    M = pd.read_parquet(common.out_path('stage2', 'market.parquet'))
    mk = {int(g): (o, c) for g, o, c in zip(M.game_id, M.spread_open, M.spread_close)}
    R = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % a.season),
                        columns=['prediction_ts', 'team_id', 'metric', 'off', 'def'])
    R = R[R.metric.eq('epa')].assign(net=lambda d: d.off - d['def'])
    ts = sorted(R.prediction_ts.unique())
    P = P.merge(G[['game_id', 'margin', 'status']], on='game_id', how='left')
    P = P[P.status.eq('FINAL')].copy()
    P['error'] = P.ens_pred - P.margin
    P['abs_error'] = P.error.abs()
    P['major'] = P.abs_error > 1.5 * P.sigma
    out = []
    for _, r in P.iterrows():
        rec = {'game_id': int(r.game_id), 'model_version': r.model_version,
               'week': int(r.week), 'home': r.home, 'away': r.away,
               'prediction_ts': r.prediction_ts, 'source': r.source, 'projected_margin': round(r.ens_pred, 2),
               'final_margin': float(r.margin), 'abs_error': round(r.abs_error, 2), 'sigma': r.sigma,
               'major_miss': bool(r.major)}
        if r.major:
            pt = pd.Timestamp(r.prediction_ts)
            nxt = [t for t in ts if t > pt]
            cur = R[R.prediction_ts.eq(pt)].set_index('team_id').net
            rnext = R[R.prediction_ts.eq(nxt[0])].set_index('team_id').net.to_dict() if nxt else None
            r = r.copy()
            r['_h_epa'] = cur.get(r.home_id, np.nan); r['_a_epa'] = cur.get(r.away_id, np.nan)
            cls, ev = classify(r, tg, qb, rnext, mk)
            rec['classification'], rec['evidence'] = cls, ev
        out.append(rec)
    lab = pd.DataFrame(out)
    d = os.path.join(REPO_V2, 'learning'); os.makedirs(d, exist_ok=True)
    grader = common.build_provenance(stamp)
    with open(os.path.join(d, '%d_misses.json' % a.season), 'w') as fh:
        json.dump({'season': a.season, 'model_version': C.MODEL_VERSION,
                   'rows_by_model_version': P.model_version.value_counts().sort_index().to_dict(),
                   'graded_with': {k: grader[k] for k in ('finality_rule', 'market_orientation_rule')},
                   'rows': out}, fh, indent=1, default=common._json_default, sort_keys=True)
    fcs_all = P[P.get('priced', pd.Series(True, index=P.index)).eq(False)] if 'priced' in P else P.iloc[0:0]
    fin_all = P[~P.index.isin(fcs_all.index)].copy()

    def block(f):
        return {'games_scored': int(len(f)), 'mae': float(f.abs_error.mean()) if len(f) else None,
                'bias': float(f.error.mean()) if len(f) else None,
                'major_miss_share': float(f.major.mean()) if len(f) else None,
                'sources': f.source.value_counts().to_dict()}
    by_version = {v: dict(block(f), fcs_not_priced_games=int(fcs_all.model_version.eq(v).sum()))
                  for v, f in fin_all.groupby('model_version')}
    # the headline is the PRODUCTION version's rows only; other versions are reported beside it
    fcs = fcs_all[fcs_all.model_version.eq(C.MODEL_VERSION)]
    fin = fin_all[fin_all.model_version.eq(C.MODEL_VERSION)].copy()
    mon_fcs = {'games': int(len(fcs)), 'mae': float(fcs.abs_error.mean()) if len(fcs) else None,
               'bias': float(fcs.error.mean()) if len(fcs) else None,
               'note': 'FBS-vs-FCS rows are NOT PRICED; tracked so the known bias stays measured'}
    mon = {'scope': 'priced games (FBS-vs-FBS) of %s only; rows of other versions are in by_model_version'
                    % C.MODEL_VERSION, 'fcs_not_priced': mon_fcs, 'season': a.season,
           'model_version': C.MODEL_VERSION, 'generated_at': common.iso(pd.Timestamp.now(tz='UTC').to_pydatetime()),
           'by_model_version': by_version,
           'graded_with': {k: grader[k] for k in ('finality_rule', 'market_orientation_rule')},
           'attribution': 'each row is graded under the model_version that produced it (its own, else its '
                          'snapshot file\'s); never relabelled (audit F-02)',
           'games_scored': int(len(fin)), 'mae': float(fin.abs_error.mean()) if len(fin) else None,
           'bias': float(fin.error.mean()) if len(fin) else None,
           'major_miss_share': float(fin.major.mean()) if len(fin) else None,
           'expected_major_miss_share_if_calibrated': 0.134,
           'by_week': fin.groupby('week').agg(n=('game_id', 'size'), mae=('abs_error', 'mean'),
                                                bias=('error', 'mean')).round(3).reset_index().to_dict('records'),
           'miss_classes': lab[lab.major_miss & lab.model_version.eq(C.MODEL_VERSION)
                               & lab.game_id.isin(fin.game_id)].classification.value_counts().to_dict()
           if 'classification' in lab else {},
           'sources': fin.source.value_counts().to_dict(),
           'policy': 'monitoring only: no parameter changes between scheduled offseason retrains'}
    # monitoring.json is owned by v2.monitor (shadow metrics + health warnings);
    # the weekly learning summary lives next to the miss classifications
    with open(os.path.join(REPO_V2, 'learning', '%d_summary.json' % a.season), 'w') as fh:
        json.dump(mon, fh, indent=1, default=common._json_default, sort_keys=True)
    print('[learn]', {k: mon[k] for k in ('games_scored', 'mae', 'bias', 'major_miss_share', 'miss_classes')})


if __name__ == '__main__':
    main()
