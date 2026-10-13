#!/usr/bin/env python3
"""Measured and target-excluded NHL research features. Not PIT-certified."""
import pathlib,csv,collections,datetime as dt,json
R=pathlib.Path(__file__).resolve().parents[1]
def read(n):
 with (R/'data'/n).open() as f:return list(csv.DictReader(f))
def write(n,rs):
 if not rs:return
 cols=list(dict.fromkeys(k for r in rs for k in r))
 with (R/'data'/n).open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(rs)
def val(v):
 try:return float(v)
 except:return None
def ratio(n,d):return n/d if d else None

def main():
 games={r['game_id']:r for r in read('games.csv')};shotrows=read('shot_attempts.csv');bygame=collections.defaultdict(list)
 for s in shotrows:bygame[s['game_id']].append(s)
 boxes={(r['game_id'],r['team_id']):r for r in read('team_game_boxscores.csv')};team=[];unmapped=0
 for gid,g in games.items():
  shots=[s for s in bygame[gid] if s['is_shootout_candidate']!='True']
  for side,other in [('home','away'),('away','home')]:
   tid=g[side+'_id'];oid=g[other+'_id'];own=[s for s in shots if s['shooting_team_id']==tid];opp=[s for s in shots if s['shooting_team_id']==oid]
   unknown=sum(not s['shooting_team_id'] for s in shots);unmapped+=unknown if side=='home' else 0
   evown=[s for s in own if s['strength_state']=='Even Strength'];evopp=[s for s in opp if s['strength_state']=='Even Strength']
   def unblocked(ss):return sum(s['is_blocked']!='True' for s in ss)
   def sog(ss):return sum(s['event_type'] in ['Shot','Goal'] for s in ss)
   box=boxes.get((gid,tid),{})
   row={'game_id':gid,'team_id':tid,'opponent_id':oid,'start_time':g['start_time'],'season_type_native':g['season_type_native'],'home_away':side,'all_nonshootout_attempts_for':len(own),'all_nonshootout_attempts_against':len(opp),'all_unblocked_for':unblocked(own),'all_unblocked_against':unblocked(opp),'sog_from_pbp_for':sog(own),'sog_from_pbp_against':sog(opp),'all_goals_from_pbp_for':sum(s['is_goal']=='True' for s in own),'all_goals_from_pbp_against':sum(s['is_goal']=='True' for s in opp),'regulation_goals_for':sum(s['is_goal']=='True' and int(s['period'])<=3 for s in own),'regulation_goals_against':sum(s['is_goal']=='True' and int(s['period'])<=3 for s in opp),'even_strength_native_attempts_for':len(evown),'even_strength_native_attempts_against':len(evopp),'even_strength_native_unblocked_for':unblocked(evown),'even_strength_native_unblocked_against':unblocked(evopp),'shot_team_unmapped_in_game':unknown,'all_corsi_share_observed':ratio(len(own),len(own)+len(opp)),'all_fenwick_share_observed':ratio(unblocked(own),unblocked(own)+unblocked(opp)),'five_v_five_verified':False,'empty_net_separated':False,'known_at':'','quality':'retrospective_native_strength_not_verified_5v5'}
   for name in ['powerPlayGoals','powerPlayOpportunities','shortHandedGoals','faceoffsWon','faceoffPercent','blockedShots','hits','takeaways','giveaways','penalties','penaltyMinutes']:row['box_'+name]=val(box.get(name))
   pp=row['box_powerPlayGoals'];oppcount=row['box_powerPlayOpportunities'];row['pp_conversion_observed']=ratio(pp,oppcount) if pp is not None and oppcount is not None else None
   row['native_box_shots']=val(box.get('shotsTotal'));row['sog_reconciliation_delta']=row['sog_from_pbp_for']-row['native_box_shots'] if row['native_box_shots'] is not None else None
   team.append(row)
 write('team_game_measured_features.csv',team)
 history=collections.defaultdict(list);lag=[]
 for r in sorted(team,key=lambda r:(r['start_time'],r['game_id'],r['team_id'])):
  prior=history[r['team_id']];target=dt.datetime.fromisoformat(r['start_time'].replace('Z','+00:00'))
  out={k:r[k] for k in ['game_id','team_id','opponent_id','start_time','season_type_native','home_away']};out['prior_games_available']=len(prior);out['known_at']='';out['quality']='target_excluded_retrospective_publication_unknown'
  if prior:
   previous=dt.datetime.fromisoformat(prior[-1]['start_time'].replace('Z','+00:00'));out['hours_between_scheduled_starts']=(target-previous).total_seconds()/3600;out['previous_game_home_away']=prior[-1]['home_away']
  else:out['hours_between_scheduled_starts']=None;out['previous_game_home_away']=None
  for days in [3,7,14]:out[f'games_in_prior_{days}_days']=sum(0<(target-dt.datetime.fromisoformat(p['start_time'].replace('Z','+00:00'))).total_seconds()<=days*86400 for p in prior)
  for n in [5,10,20]:
   subset=prior[-n:];out[f'games_exposure_prior_{n}']=len(subset)
   for metric in ['all_nonshootout_attempts_for','all_nonshootout_attempts_against','all_unblocked_for','all_unblocked_against','regulation_goals_for','regulation_goals_against','sog_from_pbp_for','sog_from_pbp_against']:
    out[f'{metric}_pergame_prior_{n}']=sum(p[metric] for p in subset)/len(subset) if subset else None
   for f,a,name in [('all_nonshootout_attempts_for','all_nonshootout_attempts_against','corsi_share'),('all_unblocked_for','all_unblocked_against','fenwick_share'),('even_strength_native_attempts_for','even_strength_native_attempts_against','native_even_strength_corsi_share')]:
    num=sum(p[f] for p in subset);den=num+sum(p[a] for p in subset);out[f'{name}_prior_{n}']=ratio(num,den);out[f'{name}_attempts_exposure_prior_{n}']=den
  lag.append(out);history[r['team_id']].append(r)
 write('pregame_lagged_research_features.csv',lag)
 goalie=[]
 for r in read('goalie_game_boxscores.csv'):
  sa=val(r.get('SA'));sv=val(r.get('SV'));ga=val(r.get('GA'))
  goalie.append({'game_id':r['game_id'],'team_id':r['team_id'],'goalie_id':r['player_id'],'goalie_name':r['player_name'],'shots_faced_native':sa,'saves_native':sv,'goals_allowed_native':ga,'toi_seconds':val(r.get('TOI_seconds')),'save_pct_calculated':ratio(sv,sa) if sv is not None and sa is not None else None,'shots_minus_saves_minus_ga_delta':sa-sv-ga if all(x is not None for x in [sa,sv,ga]) else None,'native_starter_flag':r.get('native_starter_flag'),'pregame_starter_confirmation':'','expected_goals_against':'','gsax':'','known_at':''})
 write('goalie_game_measured_features.csv',goalie)
 (R/'sources/FEATURE_BUILD_STATUS.json').write_text(json.dumps({'team_game_rows':len(team),'lagged_rows':len(lag),'goalie_rows':len(goalie),'unmapped_nonshootout_attempts':unmapped,'xg_invented':False,'five_v_five_claimed':False,'strict_historical_availability_certified':False},indent=2))
 print('Features',len(team),'team games',len(lag),'prior-game rows',len(goalie),'goalie rows; unmapped attempts',unmapped)
if __name__=='__main__':main()
