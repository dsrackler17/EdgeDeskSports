#!/usr/bin/env python3
"""Generate measured game stats and lagged research features from shipped PBP.
IMPORTANT: chronological event exclusion != proven historical source availability.
Retrospective EPA/model revisions prevent calling this strict point-in-time data.
"""
from pathlib import Path
import pandas as pd
import pyarrow.parquet as pq
R=Path(__file__).resolve().parents[1]

def build():
 tables=[];players=[];labels=[]
 for p in sorted((R/'data').glob('play_by_play_*.parquet')):
  df=pq.read_table(p).to_pandas()
  game=df.groupby('game_id',sort=False).first().reset_index()
  cols=[x for x in ['game_id','game_date','season','season_type','week','home_team','away_team','home_score','away_score','spread_line','total_line','stadium','roof','surface','temp','wind'] if x in game]
  g=game[cols].copy();g['data_status']='retrospective_not_point_in_time_certified';g['known_at']=None;labels.append(g)
  mask=df['posteam'].notna() & df['epa'].notna() & df['play_type'].isin(['pass','run'])
  for col in ['qb_kneel','qb_spike']:
   if col in df:mask &= df[col].fillna(0).eq(0)
  x=df[mask].copy()
  x['epa_positive']=x['epa'].gt(0).astype(int)
  x['dropback']=x['pass_attempt'].fillna(0).eq(1)|x['sack'].fillna(0).eq(1)
  x['designed_rush']=x['rush_attempt'].fillna(0).eq(1)&x['qb_scramble'].fillna(0).eq(0)
  x['pass_epa']=x['epa'].where(x['dropback'],0)
  x['rush_epa']=x['epa'].where(x['designed_rush'],0)
  agg=x.groupby(['game_id','posteam','defteam','game_date','season'],dropna=False).agg(plays=('epa','size'),epa_sum=('epa','sum'),successful_plays=('epa_positive','sum'),dropbacks=('dropback','sum'),pass_epa_sum=('pass_epa','sum'),designed_rushes=('designed_rush','sum'),rush_epa_sum=('rush_epa','sum'),sacks=('sack','sum'),completions=('complete_pass','sum'),pass_attempts=('pass_attempt','sum'),cpoe_sum=('cpoe','sum'),cpoe_passes=('cpoe','count')).reset_index().rename(columns={'posteam':'team_id','defteam':'opponent_id'})
  defense=agg[['game_id','team_id','plays','epa_sum','successful_plays']].rename(columns={'team_id':'opponent_id','plays':'def_plays','epa_sum':'def_epa_allowed_sum','successful_plays':'def_successes_allowed'})
  agg=agg.merge(defense,on=['game_id','opponent_id'],how='left',validate='one_to_one');tables.append(agg)
  # Opportunity counters by observed player identity; no unobserved routes imputed.
  for idcol,stat,condition in [('receiver_player_id','targets',x['pass_attempt'].eq(1)),('receiver_player_id','receptions',x['complete_pass'].eq(1)),('rusher_player_id','carries',x['rush_attempt'].eq(1)),('passer_player_id','pass_attempts',x['pass_attempt'].eq(1))]:
   z=x[condition & x[idcol].notna()]
   counts=z.groupby(['game_id','game_date','season','posteam',idcol]).size().reset_index(name='value').rename(columns={'posteam':'team_id',idcol:'player_id'});counts['stat']=stat;players.append(counts)
  for idcol,stat,col,condition in [('receiver_player_id','receiving_yards','receiving_yards',x['complete_pass'].eq(1)),('rusher_player_id','rushing_yards','rushing_yards',x['rush_attempt'].eq(1)),('passer_player_id','passing_yards','passing_yards',x['pass_attempt'].eq(1))]:
   z=x[condition & x[idcol].notna()]
   counts=z.groupby(['game_id','game_date','season','posteam',idcol])[col].sum().reset_index(name='value').rename(columns={'posteam':'team_id',idcol:'player_id'});counts['stat']=stat;players.append(counts)
 tables.append(pd.read_csv(R/'data/team_game_advanced_historical_seed_2022_2024.csv',low_memory=False))
 labels.append(pd.read_csv(R/'data/game_labels_historical_seed_2022_2024.csv',low_memory=False))
 players.append(pd.read_csv(R/'data/player_game_opportunities_historical_seed_2022_2024.csv',low_memory=False))
 out=pd.concat(tables,ignore_index=True).sort_values(['team_id','game_date','game_id'])
 out['off_epa_per_play']=out['epa_sum']/out['plays'];out['off_success_rate']=out['successful_plays']/out['plays'];out['pass_epa_per_dropback']=out['pass_epa_sum']/out['dropbacks'].replace(0,float('nan'));out['rush_epa_per_designed_rush']=out['rush_epa_sum']/out['designed_rushes'].replace(0,float('nan'));out['def_epa_allowed_per_play']=out['def_epa_allowed_sum']/out['def_plays'];out['data_status']='retrospective_not_point_in_time_certified';out['known_at']=None
 out.to_csv(R/'data/team_game_advanced_2022_2026.csv',index=False)
 lag=out[['game_id','game_date','season','team_id','opponent_id']].copy()
 for window in [5,10,20]:
  for num,den,name in [('epa_sum','plays','off_epa_per_play'),('successful_plays','plays','success_rate'),('pass_epa_sum','dropbacks','pass_epa_per_dropback'),('rush_epa_sum','designed_rushes','rush_epa_per_designed_rush'),('def_epa_allowed_sum','def_plays','def_epa_allowed_per_play'),('def_successes_allowed','def_plays','def_success_allowed_rate'),('sacks','dropbacks','sack_rate'),('cpoe_sum','cpoe_passes','cpoe')]:
   n=out.groupby('team_id')[num].transform(lambda s:s.shift(1).rolling(window,min_periods=1).sum());d=out.groupby('team_id')[den].transform(lambda s:s.shift(1).rolling(window,min_periods=1).sum());lag[f'{name}_prior_{window}']=n/d.replace(0,float('nan'));lag[f'{name}_exposure_prior_{window}']=d
  lag[f'games_observed_prior_{window}']=out.groupby('team_id')['game_id'].transform(lambda s:s.shift(1).rolling(window,min_periods=1).count())
 lag['data_status']='chronologically_lagged_retrospective_not_point_in_time_certified';lag['known_at']=None;lag.to_csv(R/'data/pregame_rolling_features_2022_2026.csv',index=False)
 pd.concat(labels,ignore_index=True).to_csv(R/'data/game_labels_2022_2026.csv',index=False)
 pl=pd.concat(players,ignore_index=True);pl['data_status']='retrospective_opportunity_counts_excludes_kneels_spikes';pl['known_at']=None;pl.to_csv(R/'data/player_game_opportunities_2022_2026.csv',index=False)
 print('NFL derived',len(out),'team games',len(lag),'lagged feature rows',len(pl),'player/stat rows')
if __name__=='__main__':build()
