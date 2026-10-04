"""Stage 1 — play-by-play -> team-game efficiency, drives, special teams, QB games.

Source: sportsdataverse `espn_cfb_pbp` release (one consistent EP model across
every season 2009-2026). Output per season, written to <OUT>/stage1/:

  team_game_<S>.parquet   one row per (game, OFFENSE team): counts and sums,
                          never pre-divided, so any later weighting is exact
  qb_game_<S>.parquet     one row per (game, team, passer)
  games_<S>.parquet       schedule rows (neutral site, kickoff, divisions, scores)

What is deliberately NOT read from the play table:
  * gameSpread / homeTeamSpread / overUnder / *_spread / spread_time — market
  * wp_before / wp_after / wpa / *_wp_*  — the WP model reads the spread
  Both are enforced by `FORBIDDEN_PBP_COLUMNS` and a test.
"""
import os
import sys

import numpy as np
import pandas as pd

from . import config as C
from . import common

FORBIDDEN_PBP_COLUMNS = (
    'gameSpread', 'homeTeamSpread', 'overUnder', 'homeFavorite', 'gameSpreadAvailable',
    'start.pos_team_spread', 'end.pos_team_spread', 'start.spread_time', 'end.spread_time',
    'wp_before', 'wp_after', 'wpa', 'def_wp_before', 'def_wp_after', 'home_wp_before',
    'home_wp_after', 'away_wp_before', 'away_wp_after', 'lead_wp_before', 'lead_wp_before2',
    'wp_touchback',
)

PBP_COLS = [
    'game_id', 'season', 'week', 'seasonType', 'pos_team_id', 'def_pos_team_id',
    'homeTeamId', 'awayTeamId', 'period', 'start.pos_score_diff', 'game_play_number',
    'rush', 'pass', 'sack', 'scrimmage_play', 'sp', 'penalty_no_play', 'EPA', 'EPA_success',
    'down', 'distance', 'start.yardsToEndzone', 'int', 'fumble_lost',
    'EPA_explosive', 'early_down',
    'passing_down', 'drive.id', 'drive.result', 'passer_player_id', 'rusher_player_id',
    'fg_attempt', 'punt', 'kickoff_play', 'first_down_created', 'touchdown', 'text_dupe',
    'statYardage',
]

# Seasons whose provider feed does not tag sacks (ESPN 2013: 32 'Sack' plays in
# a season that had ~3,000). Sack rate is MISSING for them — never zero — and
# the pass/rush split is flagged as contaminated in the data-quality report.
SACKS_UNTAGGED = {2013}


def _b(s):
    return s.fillna(False).astype(bool)


def load_pbp(season):
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % season)
    import pyarrow.parquet as pq
    names = set(pq.ParquetFile(f).schema_arrow.names)
    use = [c for c in PBP_COLS if c in names]
    assert not (set(use) & set(FORBIDDEN_PBP_COLUMNS)), 'market/WP column requested from pbp'
    d = pd.read_parquet(f, columns=use)
    for c in PBP_COLS:
        if c not in d.columns:
            d[c] = np.nan
    return d


def build_season(season):
    d = load_pbp(season)
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()].copy()
    d['pos_team_id'] = d.pos_team_id.astype('int64')
    d['def_pos_team_id'] = d.def_pos_team_id.astype('int64')
    if 'text_dupe' in d:
        d = d[~_b(d.text_dupe)]
    d['garbage'] = common.garbage_mask(d.period.fillna(1).astype(int).values,
                                       d['start.pos_score_diff'].fillna(0).values)

    # ------------------------------------------------ scrimmage plays
    rush, pas = _b(d.rush), _b(d['pass'])
    scrim = (rush | pas) & ~_b(d.penalty_no_play) & d.EPA.notna()
    s = d[scrim].copy()
    s['is_rush'] = _b(s.rush)
    s['is_pass'] = _b(s['pass'])
    s['w'] = np.where(s.garbage, C.GARBAGE_WEIGHT, 1.0)
    s['succ_f'] = _b(s.EPA_success).astype(float)
    s['expl_f'] = _b(s.EPA_explosive).astype(float)
    s['early'] = _b(s.early_down)
    s['pd'] = _b(s.passing_down)
    s['third'] = s.down.eq(3)
    s['conv3'] = (_b(s.first_down_created) | _b(s.touchdown)).astype(float)
    s['to_f'] = (_b(s['int']) | _b(s.fumble_lost)).astype(float)
    # Trench and disruption metrics are computed HERE from raw yardage rather
    # than read from the provider's stuffed_run / line_yards / opportunity_run
    # / havoc flags: those drift across seasons (provider stuff rate 0.18 in
    # 2019, 0.08 in 2026; pass break-ups 754 in 2021, 3,418 in 2025), while
    # statYardage on a rush is the same observation in every season.
    yd = s.statYardage.astype(float)
    s['sack_f'] = _b(s.sack).astype(float)
    s['tfl_rush_f'] = (s.is_rush & (yd < 0)).astype(float)
    s['havoc_f'] = np.maximum(s.sack_f, s.tfl_rush_f)      # front havoc: sacks + run TFLs
    s['stuff_f'] = (s.is_rush & (yd <= 0)).astype(float)
    s['opp_f'] = (s.is_rush & (yd >= 5)).astype(float)
    # line yards (Football Outsiders' allocation, as SP+ uses it): losses x1.2,
    # 0-4 yards x1, 5-10 yards x0.5, beyond 10 nothing
    y = yd.clip(lower=-20)
    s['ly'] = np.where(y < 0, 1.2 * y, np.minimum(y, 4) + 0.5 * np.clip(y - 4, 0, 6))

    w = s.w
    key = ['game_id', 'pos_team_id']
    agg = pd.DataFrame({
        'n_plays_all': s.groupby(key).size(),
    })
    def wsum(expr_mask, val=None):
        v = w if val is None else w * val
        return (v.where(expr_mask, 0.0)).groupby([s.game_id, s.pos_team_id]).sum()

    allm = pd.Series(True, index=s.index)
    agg['n_plays'] = wsum(allm)
    agg['epa_sum'] = wsum(allm, s.EPA)
    agg['succ'] = wsum(allm, s.succ_f)
    agg['expl'] = wsum(allm, s.expl_f)
    agg['n_db'] = wsum(s.is_pass)
    agg['epa_pass_sum'] = wsum(s.is_pass, s.EPA)
    agg['succ_pass'] = wsum(s.is_pass, s.succ_f)
    agg['expl_pass'] = wsum(s.is_pass, s.expl_f)
    agg['sacks'] = wsum(s.is_pass, s.sack_f)
    agg['n_rush'] = wsum(s.is_rush)
    agg['epa_rush_sum'] = wsum(s.is_rush, s.EPA)
    agg['succ_rush'] = wsum(s.is_rush, s.succ_f)
    agg['expl_rush'] = wsum(s.is_rush, s.expl_f)
    agg['line_yds'] = wsum(s.is_rush, pd.Series(s.ly, index=s.index))
    agg['stuff'] = wsum(s.is_rush, s.stuff_f)
    agg['opp_run'] = wsum(s.is_rush, s.opp_f)
    agg['n_early'] = wsum(s.early)
    agg['succ_early'] = wsum(s.early, s.succ_f)
    agg['n_pd'] = wsum(s.pd)
    agg['succ_pd'] = wsum(s.pd, s.succ_f)
    agg['n_3rd'] = wsum(s.third)
    agg['conv_3rd'] = wsum(s.third, s.conv3)
    agg['havoc'] = wsum(allm, s.havoc_f)
    agg['turnovers'] = wsum(allm, s.to_f)
    agg['garbage_plays'] = s.garbage.groupby([s.game_id, s.pos_team_id]).sum()
    if season in SACKS_UNTAGGED:
        # sacks were filed as rushes, so every pass/rush split is contaminated
        for c in ('sacks', 'havoc', 'n_db', 'epa_pass_sum', 'succ_pass', 'expl_pass',
                  'n_rush', 'epa_rush_sum', 'succ_rush', 'expl_rush', 'line_yds', 'stuff', 'opp_run'):
            agg[c] = np.nan
    agg = agg.reset_index().rename(columns={'pos_team_id': 'team_id'})

    # ------------------------------------------------------- drives
    dr = s[s['drive.id'].notna()].copy()
    dr = dr.sort_values(['game_id', 'game_play_number'])
    g = dr.groupby(['game_id', 'drive.id'])
    D = pd.DataFrame({
        'team_id': g.pos_team_id.agg(lambda x: x.mode().iloc[0]),
        'start_ytg': g['start.yardsToEndzone'].first(),
        'min_ytg': g['start.yardsToEndzone'].min(),
        'epa': g.EPA.sum(),
        'garbage': g.garbage.first(),
        'result': g['drive.result'].first(),
    }).reset_index()
    res = D.result.fillna('').str.upper()
    D['pts'] = np.where(res.isin(['TD', 'PASSING TD', 'RUSHING TD']), 7.0,
                        np.where(res.isin(['FG', 'FG GOOD', 'FIELD GOAL']), 3.0, 0.0))
    D['so'] = (D.min_ytg <= 40).astype(float)
    D['wd'] = np.where(D.garbage, C.GARBAGE_WEIGHT, 1.0)
    D = D[D.start_ytg.between(1, 99)]
    dg = D.assign(
        n_drives_all=1.0, n_drives=D.wd, drive_pts=D.wd * D.pts, scoring_opps=D.wd * D.so,
        opp_pts=D.wd * D.so * D.pts, start_ytg_sum=D.wd * D.start_ytg,
        drive_epa_sum=D.wd * D.epa,
    ).groupby(['game_id', 'team_id'])[['n_drives_all', 'n_drives', 'drive_pts', 'scoring_opps', 'opp_pts',
                                       'start_ytg_sum', 'drive_epa_sum']].sum().reset_index()
    agg = agg.merge(dg, on=['game_id', 'team_id'], how='left')

    # -------------------------------------------------- special teams
    spm = _b(d.sp) & d.EPA.notna() & ~_b(d.penalty_no_play)
    sp = d[spm][['game_id', 'pos_team_id', 'def_pos_team_id', 'EPA', 'fg_attempt', 'punt',
                 'kickoff_play']].copy()
    def net(frame, name):
        a = frame.groupby(['game_id', 'pos_team_id']).EPA.sum()
        a.index = a.index.set_names(['game_id', 'team_id'])
        b = frame.groupby(['game_id', 'def_pos_team_id']).EPA.sum()
        b.index = b.index.set_names(['game_id', 'team_id'])
        return a.sub(b, fill_value=0.0).rename(name).reset_index()
    stn = net(sp, 'st_net_epa')
    fg = sp[_b(sp.fg_attempt)].groupby(['game_id', 'pos_team_id']).EPA.agg(['sum', 'size'])
    fg = fg.reset_index().rename(columns={'pos_team_id': 'team_id', 'sum': 'fg_epa', 'size': 'n_fg'})
    pn = net(sp[_b(sp.punt)], 'punt_net_epa')
    kn = net(sp[_b(sp.kickoff_play)], 'kick_net_epa')
    for t in (stn, fg, pn, kn):
        agg = agg.merge(t, on=['game_id', 'team_id'], how='left')
    for c in ('fg_epa', 'n_fg', 'punt_net_epa', 'kick_net_epa'):
        agg[c] = agg[c].fillna(0.0)

    # opponent id per (game, offense)
    opp_map = d.groupby(['game_id', 'pos_team_id']).def_pos_team_id.agg(lambda x: x.mode().iloc[0])
    agg['opp_id'] = [opp_map.get((a, b), np.nan) for a, b in zip(agg.game_id, agg.team_id)]
    agg['season'] = season

    # ------------------------------------------------------------ QB games
    qp = s[s.is_pass & s.passer_player_id.notna()].copy()
    qp['passer_player_id'] = pd.to_numeric(qp.passer_player_id, errors='coerce')
    qp = qp[qp.passer_player_id.notna()]
    qp['passer_player_id'] = qp.passer_player_id.astype('int64')
    qg = qp.groupby(['game_id', 'pos_team_id', 'passer_player_id'])
    Q = pd.DataFrame({
        'db': qg.size(),
        'db_ng': qg.w.sum(),
        'epa_db_sum': (qp.w * qp.EPA).groupby([qp.game_id, qp.pos_team_id, qp.passer_player_id]).sum(),
        'succ_db': (qp.w * qp.succ_f).groupby([qp.game_id, qp.pos_team_id, qp.passer_player_id]).sum(),
        'sacks': (qp.w * qp.sack_f).groupby([qp.game_id, qp.pos_team_id, qp.passer_player_id]).sum(),
        'first_play': qg.game_play_number.min(),
    }).reset_index().rename(columns={'pos_team_id': 'team_id', 'passer_player_id': 'qb_id'})
    Q['starter'] = Q.groupby(['game_id', 'team_id']).first_play.transform('min').eq(Q.first_play)
    Q['season'] = season

    # --------------------------------------------------------- schedule
    games = load_schedule(season)
    return agg, Q, games


def load_schedule(season):
    f = common.data_path('sched', 'cfb_schedules_%d.parquet' % season)
    g = pd.read_parquet(f)
    keep = ['game_id', 'season', 'week', 'season_type', 'start_date', 'completed', 'neutral_site',
            'conference_game', 'venue_id', 'venue', 'home_id', 'home_team', 'home_division',
            'home_conference', 'home_points', 'away_id', 'away_team', 'away_division',
            'away_conference', 'away_points', 'notes']
    g = g[[c for c in keep if c in g.columns]].copy()
    g['game_id'] = pd.to_numeric(g.game_id, errors='coerce').astype('Int64')
    g = g.drop_duplicates('game_id')
    return g


def main(seasons):
    for S in seasons:
        agg, Q, games = build_season(S)
        agg.to_parquet(common.out_path('stage1', 'team_game_%d.parquet' % S), index=False)
        Q.to_parquet(common.out_path('stage1', 'qb_game_%d.parquet' % S), index=False)
        games.to_parquet(common.out_path('stage1', 'games_%d.parquet' % S), index=False)
        print('[stage1] %d: %d team-games, %d qb-games, %d scheduled, garbage share %.3f'
              % (S, len(agg), len(Q), len(games),
                 agg.garbage_plays.sum() / max(1, agg.n_plays_all.sum())))


if __name__ == '__main__':
    main([int(x) for x in sys.argv[1:]])
