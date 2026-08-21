#!/usr/bin/env python3
"""EdgeDesk Football Engine — feature builder.

Turns the raw public datasets fetched by fetch_data.sh into the exact
team-game feature tables the training scripts (train_nfl.py / train_cfb.py)
and the runtime engine (../engine.js) consume.

Sources (all public, keyless; provenance carried into params.js):
  NFL  games.csv            nflverse/nfldata  — schedule, scores, CLOSING
                            consensus spread/total (all seasons) and
                            moneylines (2010+), rest days, starting QBs,
                            coaches, roof/surface/temp/wind.
  NFL  stats_team_week_*.csv nflverse-data     — per team-game offensive
                            EPA/efficiency aggregates (defense = the
                            opponent's offense row of the same game).
  NFL  stats_player_week_*  nflverse-data     — per-QB passing EPA for the
                            quarterback layer (GSIS ids match games.csv).
  CFB  cfb_schedules_*.csv  sportsdataverse/cfbfastR-data — schedule,
                            scores, divisions, neutral site, pregame Elo.
                            NO betting lines exist in this dataset; the CFB
                            report therefore never claims a market backtest.

Nothing here fabricates a value: a field absent from the source stays NaN
and downstream models must either handle it or exclude the row.

Usage:  python3 build_features.py <data_dir> <out_dir>
"""
import sys, os
import numpy as np
import pandas as pd

DATA = sys.argv[1] if len(sys.argv) > 1 else 'data'
OUT  = sys.argv[2] if len(sys.argv) > 2 else 'out'
os.makedirs(OUT, exist_ok=True)

NFL_SEASONS = range(1999, 2026)   # completed seasons used for training
CFB_SEASONS = range(2002, 2026)

# Franchise continuity across relocations (nflverse team codes).
FRANCHISE = {'STL': 'LA', 'SD': 'LAC', 'OAK': 'LV'}
def franchise(t): return FRANCHISE.get(t, t)


def build_nfl():
    g = pd.read_csv(os.path.join(DATA, 'nfl', 'games.csv'))
    g = g[(g.season >= 1999) & (g.season <= 2025)].copy()
    g = g.dropna(subset=['home_score', 'away_score'])
    g['margin'] = g.home_score - g.away_score          # == result column
    g['total_pts'] = g.home_score + g.away_score
    g['kick_dt'] = pd.to_datetime(g.gameday)
    g['home_fr'] = g.home_team.map(franchise)
    g['away_fr'] = g.away_team.map(franchise)

    stw = pd.concat([pd.read_csv(os.path.join(DATA, 'nfl', f'stw_{y}.csv'))
                     for y in NFL_SEASONS], ignore_index=True)
    o = pd.DataFrame()
    o['game_id'] = stw.game_id
    o['season'] = stw.season; o['week'] = stw.week
    o['team'] = stw.team.map(franchise)
    o['opp'] = stw.opponent_team.map(franchise)
    dropbacks = stw.attempts + stw.sacks_suffered
    o['plays'] = stw.attempts + stw.carries + stw.sacks_suffered
    o['off_epa_play'] = (stw.passing_epa + stw.rushing_epa) / o.plays
    o['pass_epa_db'] = stw.passing_epa / dropbacks.replace(0, np.nan)
    o['rush_epa_att'] = stw.rushing_epa / stw.carries.replace(0, np.nan)
    o['expl_pass'] = stw.passing_20 / stw.attempts.replace(0, np.nan)
    o['expl_rush'] = stw.rushing_10 / stw.carries.replace(0, np.nan)
    o['sack_rate_all'] = stw.sacks_suffered / dropbacks.replace(0, np.nan)
    o['cpoe'] = stw.passing_cpoe                       # NaN before 2006
    o['pass_rate'] = stw.attempts / o.plays
    o['to_lost'] = (stw.passing_interceptions + stw.sack_fumbles_lost
                    + stw.rushing_fumbles_lost + stw.receiving_fumbles_lost)

    d = o.rename(columns={
        'team': 'opp', 'opp': 'team',
        'off_epa_play': 'def_epa_play', 'pass_epa_db': 'def_pass_epa_db',
        'rush_epa_att': 'def_rush_epa_att', 'expl_pass': 'def_expl_pass',
        'expl_rush': 'def_expl_rush', 'sack_rate_all': 'sack_rate_made',
        'cpoe': 'def_cpoe', 'pass_rate': 'def_faced_pass_rate',
        'to_lost': 'to_won', 'plays': 'def_plays'})
    tg = o.merge(d, on=['game_id', 'season', 'week', 'team', 'opp'], how='inner')

    home = g[['game_id', 'home_fr', 'home_score', 'away_score', 'home_rest',
              'away_rest', 'kick_dt', 'game_type']].rename(
        columns={'home_fr': 'team', 'home_score': 'pts_for',
                 'away_score': 'pts_against', 'home_rest': 'rest',
                 'away_rest': 'opp_rest'})
    home['is_home'] = 1
    away = g[['game_id', 'away_fr', 'away_score', 'home_score', 'away_rest',
              'home_rest', 'kick_dt', 'game_type']].rename(
        columns={'away_fr': 'team', 'away_score': 'pts_for',
                 'home_score': 'pts_against', 'away_rest': 'rest',
                 'home_rest': 'opp_rest'})
    away['is_home'] = 0
    ha = pd.concat([home, away], ignore_index=True)
    tg = tg.merge(ha, on=['game_id', 'team'], how='inner')
    tg = tg.sort_values(['kick_dt', 'game_id']).reset_index(drop=True)
    tg.to_csv(os.path.join(OUT, 'nfl_team_games.csv'), index=False)

    # per-QB game log (dropbacks-weighted EPA) for the quarterback layer
    qb_rows = []
    for y in NFL_SEASONS:
        p = pd.read_csv(os.path.join(DATA, 'nfl', f'spw_{y}.csv'),
                        usecols=['player_id', 'player_display_name', 'position',
                                 'season', 'week', 'game_id', 'team',
                                 'attempts', 'sacks_suffered', 'passing_epa',
                                 'rushing_epa', 'carries'])
        p = p[(p.position == 'QB') & ((p.attempts + p.sacks_suffered) > 0)]
        qb_rows.append(p)
    qb = pd.concat(qb_rows, ignore_index=True)
    qb['dropbacks'] = qb.attempts + qb.sacks_suffered
    qb['team'] = qb.team.map(franchise)
    qb.to_csv(os.path.join(OUT, 'nfl_qb_games.csv'), index=False)

    g_out = g[['game_id', 'season', 'game_type', 'week', 'kick_dt',
               'home_fr', 'away_fr', 'home_score', 'away_score', 'margin',
               'total_pts', 'spread_line', 'total_line', 'home_moneyline',
               'away_moneyline', 'home_rest', 'away_rest', 'div_game',
               'roof', 'surface', 'temp', 'wind', 'home_qb_id', 'away_qb_id',
               'home_qb_name', 'away_qb_name', 'home_coach', 'away_coach']]
    g_out.to_csv(os.path.join(OUT, 'nfl_games.csv'), index=False)
    print(f'NFL: {len(g_out)} games, {len(tg)} team-games, {len(qb)} QB-games')


def build_cfb():
    frames = []
    for y in CFB_SEASONS:
        s = pd.read_csv(os.path.join(DATA, 'cfb', f'sched_{y}.csv'))
        frames.append(s)
    c = pd.concat(frames, ignore_index=True)
    c = c[c.completed == True].dropna(subset=['home_points', 'away_points'])
    c['kick_dt'] = pd.to_datetime(c.start_date, format='mixed', utc=True)
    c['margin'] = c.home_points - c.away_points
    c['total_pts'] = c.home_points + c.away_points
    c['home_fbs'] = (c.home_division == 'fbs')
    c['away_fbs'] = (c.away_division == 'fbs')
    # keep games with at least one FBS side; pure FCS games carry no signal here
    c = c[c.home_fbs | c.away_fbs]
    keep = ['game_id', 'season', 'week', 'season_type', 'kick_dt',
            'neutral_site', 'conference_game', 'home_team', 'away_team',
            'home_conference', 'away_conference', 'home_fbs', 'away_fbs',
            'home_points', 'away_points', 'margin', 'total_pts',
            'home_pregame_elo', 'away_pregame_elo']
    c = c[keep].sort_values(['kick_dt', 'game_id']).reset_index(drop=True)
    c.to_csv(os.path.join(OUT, 'cfb_games.csv'), index=False)
    print(f'CFB: {len(c)} games with an FBS side, seasons '
          f'{c.season.min()}-{c.season.max()}')


if __name__ == '__main__':
    build_nfl()
    build_cfb()
