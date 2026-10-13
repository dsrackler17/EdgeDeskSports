#!/usr/bin/env python3
"""Bounded historical research collector. No paid providers or credentials used.
All data is retrospective, never assume retrieved_at is historical known_at.
"""
import argparse, concurrent.futures, csv, datetime as dt, gzip, hashlib, io, json, os, pathlib, time, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
NOW=dt.datetime.now(dt.timezone.utc).isoformat()
LOG=[]
CACHED_METADATA={}
for manifest_path in (ROOT/'sources').glob('*download_manifest.json'):
 try:
  for record in json.loads(manifest_path.read_text()).get('files',[]):
   CACHED_METADATA[record['file']]=record
 except (ValueError,KeyError):
  pass
BUDGET=220
REQUESTS=0
import threading
LOCK=threading.Lock()
def fetch(url, dest, kind='json'):
 global REQUESTS
 p=ROOT/dest; p.parent.mkdir(parents=True,exist_ok=True)
 if p.exists():
  b=p.read_bytes()
  original=CACHED_METADATA.get(dest,{})
  item={**original,'source_url':url,'file':dest,'status':'cache_reused','bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
  item.setdefault('retrieved_at',None)
  item.setdefault('historical_known_at',None)
  with LOCK: LOG.append(item)
  return json.loads(gzip.decompress(b)) if kind=='json' else b
 with LOCK:
  if REQUESTS>=BUDGET: raise RuntimeError('Public-request budget exhausted')
  REQUESTS+=1
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'EdgeDeskHistoricalResearch/1.0'}),timeout=40) as r:
   b=r.read(); final=r.url
  if kind=='json':
   j=json.loads(b)
   if '/summary?' in url:
    j={k:v for k,v in j.items() if k in {'boxscore', 'plays', 'scoringPlays', 'gameInfo', 'rosters', 'wallclockAvailable', 'format', 'drives', 'winprobability', 'header'}}
    b=json.dumps(j,separators=(',',':')).encode()
   stored=gzip.compress(b,mtime=0)
  else: stored=b;j=b
  p.write_bytes(stored)
  item={'source_url':url,'resolved_url':final,'file':dest,'retrieved_at':NOW,'historical_known_at':None,'sha256':hashlib.sha256(stored).hexdigest(),'bytes':len(stored),'status':'downloaded'}
  with LOCK: LOG.append(item)
  return j
 except Exception as e:
  with LOCK:LOG.append({'source_url':url,'file':dest,'status':'failed','error':str(e),'retrieved_at':NOW})
  raise

def write_csv(path,rows,fields=None):
 rows=list(rows);p=ROOT/path;p.parent.mkdir(parents=True,exist_ok=True)
 fields=fields or list(dict.fromkeys(k for r in rows for k in r))
 if not fields:return
 with p.open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(rows)

def nfl(year):
 d=f'data/nfl/play_by_play_{year}.csv.gz'
 fetch(f'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{year}.csv.gz',d,'bytes')
 print('NFL',year,'downloaded',flush=True)

def mlb():
 j=fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2024-01-01&endDate=2024-12-31','data/mlb/raw/schedule_2024.json.gz')
 games=[]
 for day in j['dates']:
  for g in day['games']:
   h=g['teams']['home'];a=g['teams']['away']
   games.append({'game_id':str(g['gamePk']),'sport':'mlb','season':g['season'],'start_time':g['gameDate'],'game_type':g['gameType'],'home_id':h['team']['id'],'home_name':h['team']['name'],'away_id':a['team']['id'],'away_name':a['team']['name'],'home_score':h.get('score'),'away_score':a.get('score'),'status':g['status']['detailedState'],'venue_id':g.get('venue',{}).get('id'),'retrieved_at':NOW,'known_at':''})
 write_csv('data/mlb/games_2024.csv',games)
 candidates=[g for g in games if g['status']=='Final' and g['game_type']=='R']
 selected=[candidates[round(i*(len(candidates)-1)/29)] for i in range(30)]
 pitches=[];players=[]
 def detail(g):
  gid=g['game_id']; j=fetch(f'https://statsapi.mlb.com/api/v1.1/game/{gid}/feed/live',f'data/mlb/raw/feed_{gid}.json.gz')
  for pa in j.get('liveData',{}).get('plays',{}).get('allPlays',[]):
   for ev in pa.get('playEvents',[]):
    if not ev.get('isPitch'):continue
    pd=ev.get('pitchData',{});co=pd.get('coordinates',{});br=pd.get('breaks',{});hd=ev.get('hitData',{});d=ev.get('details',{})
    pitches.append({'game_id':gid,'at_bat_index':pa['about']['atBatIndex'],'pitch_index':ev['index'],'event_time':ev.get('startTime'),'pitcher_id':pa.get('matchup',{}).get('pitcher',{}).get('id'),'batter_id':pa.get('matchup',{}).get('batter',{}).get('id'),'batter_side':pa.get('matchup',{}).get('batSide',{}).get('code'),'pitcher_hand':pa.get('matchup',{}).get('pitchHand',{}).get('code'),'inning':pa['about']['inning'],'half_inning':pa['about']['halfInning'],'pitch_type':d.get('type',{}).get('code'),'call':d.get('code'),'balls_after':ev.get('count',{}).get('balls'),'strikes_after':ev.get('count',{}).get('strikes'),'outs_after':ev.get('count',{}).get('outs'),'release_speed_mph':pd.get('startSpeed'),'end_speed_mph':pd.get('endSpeed'),'plate_x_ft':co.get('pX'),'plate_z_ft':co.get('pZ'),'release_x_ft':co.get('x0'),'release_y_ft':co.get('y0'),'release_z_ft':co.get('z0'),'vx0_ft_s':co.get('vX0'),'vy0_ft_s':co.get('vY0'),'vz0_ft_s':co.get('vZ0'),'ax_ft_s2':co.get('aX'),'ay_ft_s2':co.get('aY'),'az_ft_s2':co.get('aZ'),'movement_x_ft':co.get('pfxX'),'movement_z_ft':co.get('pfxZ'),'spin_rate_rpm':br.get('spinRate'),'spin_direction_deg':br.get('spinDirection'),'strike_zone_top_ft':pd.get('strikeZoneTop'),'strike_zone_bottom_ft':pd.get('strikeZoneBottom'),'exit_velocity_mph':hd.get('launchSpeed'),'launch_angle_deg':hd.get('launchAngle'),'distance_ft':hd.get('totalDistance'),'hit_trajectory':hd.get('trajectory'),'hit_hardness':hd.get('hardness'),'retrieved_at':NOW,'known_at':''})
  for side,t in j.get('liveData',{}).get('boxscore',{}).get('teams',{}).items():
   for player in t.get('players',{}).values():
    for category,stats in player.get('stats',{}).items():
     for name,value in stats.items():players.append({'game_id':gid,'team_id':t['team']['id'],'player_id':player['person']['id'],'player_name':player['person']['fullName'],'category':category,'stat':name,'value':value,'retrieved_at':NOW,'known_at':''})
 with concurrent.futures.ThreadPoolExecutor(3) as ex:
  for f in [ex.submit(detail,g) for g in selected]:
   try:f.result()
   except Exception as e:print('MLB detail failed',str(e),flush=True)
 write_csv('data/mlb/pitches_sample_2024.csv',sorted(pitches,key=lambda r:(r['game_id'],r['at_bat_index'],r['pitch_index'])))
 write_csv('data/mlb/player_game_stats_sample_2024.csv',players)
 print('MLB',len(games),'games',len(pitches),'pitches',flush=True)

SPORTS={
'nhl':('hockey/nhl',['202410','202411','202412','202501','202502','202503','202504','202505','202506']),
'nba':('basketball/nba',['202410','202411','202412','202501','202502','202503','202504','202505','202506']),
'wnba':('basketball/wnba',['202405','202406','202407','202408','202409','202410']),
'cfb':('football/college-football',['202409','202410','202411','202412','202501']),
'cbb_men':('basketball/mens-college-basketball',['202411','202412','202501','202502','202503','202504']),
'cbb_women':('basketball/womens-college-basketball',['202411','202412','202501','202502','202503','202504']),
'college_baseball':('baseball/college-baseball',['202402','202403','202404','202405','202406']),
'soccer':('soccer/eng.1',['202408','202409','202410','202411','202412','202501','202502','202503','202504','202505']),
}
def espn(sport):
 route,months=SPORTS[sport];events={};games=[];teamstats=[];playerstats=[];plays=[]
 for month in months:
  u=f'https://site.api.espn.com/apis/site/v2/sports/{route}/scoreboard?dates={month}&limit=1000'
  if sport=='cfb':u+='&groups=80'
  if sport.startswith('cbb') or sport=='college_baseball':u+='&groups=50'
  try:
   j=fetch(u,f'data/{sport}/raw/scoreboard_{month}.json.gz')
   for e in j.get('events',[]):events[e['id']]=e
  except Exception as e: print(sport,month,str(e),flush=True)
 for e in events.values():
  for c in e.get('competitions',[]):
   competitors=c.get('competitors',[])
   if len(competitors)!=2:continue
   h=next((x for x in competitors if x.get('homeAway')=='home'),competitors[0]);a=next((x for x in competitors if x.get('homeAway')=='away'),competitors[1])
   games.append({'game_id':c['id'],'sport':sport,'season':e.get('season',{}).get('year'),'start_time':e.get('date'),'home_id':h.get('id'),'home_name':h.get('team',{}).get('displayName'),'away_id':a.get('id'),'away_name':a.get('team',{}).get('displayName'),'home_score':h.get('score'),'away_score':a.get('score'),'status':c.get('status',{}).get('type',{}).get('name'),'neutral_site':c.get('neutralSite'),'venue_id':c.get('venue',{}).get('id'),'retrieved_at':NOW,'known_at':''})
 write_csv(f'data/{sport}/games_historical.csv',games)
 completed=sorted([g for g in games if g['status']=='STATUS_FINAL'],key=lambda g:g['start_time'])
 n=min(12,len(completed));selected=[completed[round(i*(len(completed)-1)/max(1,n-1))] for i in range(n)]
 for g in selected:
  gid=g['game_id']
  try:j=fetch(f'https://site.api.espn.com/apis/site/v2/sports/{route}/summary?event={gid}',f'data/{sport}/raw/summary_{gid}.json.gz')
  except Exception as e:print(sport,'summary',str(e),flush=True);continue
  box=j.get('boxscore',{})
  for t in box.get('teams',[]):
   tid=t.get('team',{}).get('id')
   for stat in t.get('statistics',[]):
    teamstats.append({'game_id':gid,'team_id':tid,'stat':stat.get('name') or stat.get('label'),'value':stat.get('displayValue') or stat.get('value'),'retrieved_at':NOW,'known_at':''})
  for t in box.get('players',[]):
   tid=t.get('team',{}).get('id')
   for group in t.get('statistics',[]):
    names=group.get('names') or group.get('labels') or group.get('keys',[])
    for a in group.get('athletes',[]):
     ath=a.get('athlete',{})
     for name,value in zip(names,a.get('stats',[])):
      playerstats.append({'game_id':gid,'team_id':tid,'player_id':ath.get('id'),'player_name':ath.get('displayName'),'category':group.get('name'),'stat':name,'value':value,'starter':a.get('starter'),'did_not_play':a.get('didNotPlay'),'retrieved_at':NOW,'known_at':''})
  plist=j.get('plays',[])
  if not plist:
   plist=[p for d in j.get('drives',{}).get('previous',[]) for p in d.get('plays',[])]
  for p in plist:
   plays.append({'game_id':gid,'event_id':p.get('id'),'sequence':p.get('sequenceNumber'),'period':p.get('period',{}).get('number'),'clock':p.get('clock',{}).get('displayValue'),'event_type':p.get('type',{}).get('text'),'team_id':p.get('team',{}).get('id'),'home_score_after':p.get('homeScore'),'away_score_after':p.get('awayScore'),'scoring_play':p.get('scoringPlay'),'shooting_play':p.get('shootingPlay'),'x_native':p.get('coordinate',{}).get('x'),'y_native':p.get('coordinate',{}).get('y'),'participants_json':json.dumps(p.get('participants',[]),separators=(',',':')),'native_start_json':json.dumps(p.get('start',{}),separators=(',',':')),'native_end_json':json.dumps(p.get('end',{}),separators=(',',':')),'retrieved_at':NOW,'known_at':''})
 write_csv(f'data/{sport}/team_game_stats_sample.csv',teamstats)
 write_csv(f'data/{sport}/player_game_stats_sample.csv',playerstats)
 write_csv(f'data/{sport}/events_sample.csv',plays)
 print(sport,len(games),'games',len(playerstats),'player-stat cells',len(plays),'events',flush=True)

def tennis(tour):
 sport='tennis_'+tour;rows=[]
 # Four Grand Slam finals days; each response may include whole tournament draws.
 for day in ['20240128','20240609','20240714','20240908']:
  try:j=fetch(f'https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates={day}&limit=1000',f'data/{sport}/raw/scoreboard_{day}.json.gz')
  except Exception as e:print(sport,str(e),flush=True);continue
  for e in j.get('events',[]):
   def visit(c):
    cs=c.get('competitors',[])
    if len(cs)==2:
     a,b=cs
     rows.append({'match_id':c.get('id'),'tournament_id':e.get('id'),'tournament':e.get('name'),'date':c.get('date') or e.get('date'),'round':c.get('round',{}).get('displayName'),'player_a_id':a.get('id'),'player_a':a.get('athlete',{}).get('displayName'),'player_b_id':b.get('id'),'player_b':b.get('athlete',{}).get('displayName'),'a_score':a.get('score'),'b_score':b.get('score'),'a_winner':a.get('winner'),'b_winner':b.get('winner'),'status':c.get('status',{}).get('type',{}).get('name'),'a_sets_json':json.dumps(a.get('linescores',[])),'b_sets_json':json.dumps(b.get('linescores',[])),'a_statistics_json':json.dumps(a.get('statistics',[])),'b_statistics_json':json.dumps(b.get('statistics',[])),'retrieved_at':NOW,'known_at':''})
    for k in ['competitions','groupings']:
     for child in c.get(k,[]):visit(child)
   visit(e)
 unique={r['match_id']:r for r in rows if r.get('match_id')}
 write_csv(f'data/{sport}/matches_sample.csv',unique.values())
 print(sport,len(unique),'matches',flush=True)

def main():
 tasks=[lambda y=y:nfl(y) for y in [2022,2023,2024]]+[mlb]+[lambda s=s:espn(s) for s in SPORTS]+[lambda:tennis('atp'),lambda:tennis('wta')]
 with concurrent.futures.ThreadPoolExecutor(3) as ex:
  for f in [ex.submit(t) for t in tasks]:
   try:f.result()
   except Exception as e:print('TASK FAILED',str(e),flush=True)
 (ROOT/'sources/download_manifest.json').write_text(json.dumps({'retrieved_at':NOW,'request_count':REQUESTS,'request_budget':BUDGET,'files':LOG},indent=2))
 print('DONE requests',REQUESTS,flush=True)
if __name__=='__main__':main()
