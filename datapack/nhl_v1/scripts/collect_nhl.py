#!/usr/bin/env python3
"""Build an NHL factual research archive from available cached/public ESPN feed.
No paid calls. Native NHL endpoints are blocked; their missing fields stay missing.
"""
import pathlib,urllib.request,json,gzip,csv,concurrent.futures,threading,time,datetime as dt,hashlib,collections,re
R=pathlib.Path(__file__).resolve().parents[1]
CACHE=R.parent/'EdgeDesk_Quant_Data_Pack/data/nhl/raw'
STAGING=R.parent/'quant_build/nhl_season_cache';STAGING.mkdir(parents=True,exist_ok=True)
NOW=dt.datetime.now(dt.timezone.utc).isoformat();log=[];lock=threading.Lock();requests=0;MAX_REQUESTS=1700
KEEP={'header','boxscore','gameInfo','plays','scoringPlays'}
CAPTURE_TIMES={}
prior_manifest=R/'sources/COLLECTION_MANIFEST.json'
if prior_manifest.exists():
 for entry in json.loads(prior_manifest.read_text()).get('cached_response_provenance',[]):
  CAPTURE_TIMES[entry['native_file']]=entry.get('retrieved_at')
old_manifest=R.parent/'EdgeDesk_Quant_Data_Pack/sources/unified_download_manifest.json'
if old_manifest.exists():
 for entry in json.loads(old_manifest.read_text()).get('files',[]):
  if 'data/nhl/raw/' in entry.get('file',''):
   CAPTURE_TIMES.setdefault(pathlib.Path(entry['file']).name,entry.get('retrieved_at'))
def get(url,name):
 global requests
 old=CACHE/name;new=STAGING/name
 p=old if old.exists() else new
 if p.exists():
  b=p.read_bytes();j=json.loads(gzip.decompress(b));status='cache_reused';retrieved=CAPTURE_TIMES.get(name)
 else:
  with lock:
   if requests>=MAX_REQUESTS:raise RuntimeError('Request budget reached')
   requests+=1
  # No retries on authentication/access blocks; bounded retry on transient errors.
  for attempt in range(2):
   try:
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'EdgeDeskHistoricalResearch/1.0'}),timeout=25) as resp:j=json.load(resp)
    if 'summary?' in url:j={k:v for k,v in j.items() if k in KEEP}
    b=gzip.compress(json.dumps(j,separators=(',',':')).encode(),mtime=0);new.write_bytes(b);status='downloaded';retrieved=NOW;break
   except Exception as e:
    if attempt==1 or getattr(e,'code',0) in [401,403,404]:raise
    time.sleep(1)
 with lock:log.append({'source_url':url,'native_file':name,'sha256_of_cached_response':hashlib.sha256(b).hexdigest(),'bytes':len(b),'status':status,'retrieved_at':retrieved,'known_at':None})
 return j

def write(name,rows):
 if not rows:return
 fields=list(dict.fromkeys(k for row in rows for k in row))
 with (R/'data'/name).open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)

def clock(s):
 try:
  a,b=s.split(':');return int(a)*60+int(b)
 except:return None

def gather(g):
 gid=g['game_id'];j=get(f'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event={gid}',f'summary_{gid}.json.gz');header=j.get('header',{});hc=header.get('competitions',[{}])[0];st=header.get('season',{}).get('type')
 games=dict(g);games['season_type_native']=st;games['known_at']='';games['retrieved_at']=NOW;games['result_status']=hc.get('status',{}).get('type',{}).get('name');games['end_period']=hc.get('status',{}).get('period');info=j.get('gameInfo',{});venue=info.get('venue',{});games['venue_id']=venue.get('id');games['venue_name']=venue.get('fullName');games['venue_city']=venue.get('address',{}).get('city');games['venue_state']=venue.get('address',{}).get('state');games['venue_country']=venue.get('address',{}).get('country');games['attendance']=info.get('attendance');games['neutral_site']=hc.get('neutralSite')
 ids={x.get('homeAway'):x.get('id') for x in hc.get('competitors',[])}
 teamrows=[];playerrows=[];goalierows=[];officials=[];events=[];shots=[];goals_by_team=collections.Counter()
 for o in info.get('officials',[]):officials.append({'game_id':gid,'name':o.get('displayName'),'position':o.get('position',{}).get('name') if isinstance(o.get('position'),dict) else o.get('position'),'known_at':''})
 for t in j.get('boxscore',{}).get('teams',[]):
  row={'game_id':gid,'team_id':t.get('team',{}).get('id'),'team_name':t.get('team',{}).get('displayName'),'home_away':t.get('homeAway'),'known_at':''}
  for s in t.get('statistics',[]):row[s.get('name') or s['label']]=s.get('displayValue')
  teamrows.append(row)
 for t in j.get('boxscore',{}).get('players',[]):
  tid=t.get('team',{}).get('id');seen=set()
  for group in t.get('statistics',[]):
   names=group.get('names') or group.get('labels') or group.get('keys',[])
   for a in group.get('athletes',[]):
    ath=a.get('athlete',{});aid=ath.get('id')
    if aid in seen:continue
    seen.add(aid);stats=dict(zip(names,a.get('stats',[])))
    row={'game_id':gid,'team_id':tid,'player_id':aid,'player_name':ath.get('displayName'),'group':group.get('name'),'native_starter_flag':a.get('starter'),'known_at':'',**stats}
    for key in ['TOI','PPTOI','SHTOI','ESTOI']:
     if key in stats:row[key+'_seconds']=clock(stats[key])
    playerrows.append(row)
    if group.get('name')=='goalies':goalierows.append(row)
 player_team_lookup={r['player_id']:r['team_id'] for r in playerrows}
 prev={};home_before=0;away_before=0
 for p in j.get('plays',[]):
  et=p.get('type',{}).get('text');period=p.get('period',{}).get('number');participants=p.get('participants',[])
  ids_by_type={x.get('type'):x.get('athlete',{}).get('id') for x in participants}
  row={'game_id':gid,'event_id':p.get('id'),'sequence_native':p.get('sequenceNumber'),'period':period,'clock_native':p.get('clock',{}).get('displayValue'),'event_type':et,'strength_label_native':p.get('strength',{}).get('text'),'strength_code_native':p.get('strength',{}).get('id'),'shot_description_native':p.get('text') if et in ['Shot','Goal','Missed','Blocked'] else None,'team_id':p.get('team',{}).get('id'),'home_score_before':home_before,'away_score_before':away_before,'home_score_after':p.get('homeScore'),'away_score_after':p.get('awayScore'),'x_native':p.get('coordinate',{}).get('x'),'y_native':p.get('coordinate',{}).get('y'),'participants_by_role_json':json.dumps(ids_by_type,separators=(',',':')),'participant_role_rows_json':json.dumps([{'role':a.get('type'),'player_id':a.get('athlete',{}).get('id')} for a in participants],separators=(',',':')),'occurred_at':p.get('wallclock'),'source_modified_at':p.get('modified'),'known_at':''}
  events.append(row)
  if et in ['Shot','Goal','Missed','Blocked']:
   period_shootout=period is not None and period>4 and st!=3
   sh={**row,'shooter_id':ids_by_type.get('shooter') or ids_by_type.get('scorer'),'goalie_id':ids_by_type.get('saver') or ids_by_type.get('goalie'),'blocker_id':ids_by_type.get('blocker') or ids_by_type.get('defender'),'is_goal':et=='Goal','is_blocked':et=='Blocked','is_missed':et=='Missed','is_shootout_candidate':period_shootout,'coordinate_unit':'unverified_native','strength_state':p.get('strength',{}).get('text'),'shot_type':next((kind for kind in ['Wrist Shot','Slap Shot','Snap Shot','Backhand','Tip-In','Tip-in','Deflected','Wrap-around'] if kind.lower() in p.get('text','').lower()),None),'shot_type_method':'description_keyword_extraction_not_provider_structured_code','xg':'','goalie_empty_net_status':p.get('emptyNet')}
   sh['shooting_team_id']=player_team_lookup.get(sh['shooter_id'])
   sh['shooting_team_mapping_method']='boxscore_player_id_lookup' if sh['shooting_team_id'] else 'unmapped'
   sh['previous_event_type']=prev.get('event_type');sh['previous_event_x_native']=prev.get('x_native');sh['previous_event_y_native']=prev.get('y_native');sh['previous_event_same_period']=prev.get('period')==period if prev else None
   # Clock direction is not inferred. Signed native delta is kept for later frame/clock mapping.
   cur=clock(row['clock_native']);pr=clock(prev.get('clock_native',''));sh['signed_native_clock_delta_seconds']=cur-pr if cur is not None and pr is not None and sh['previous_event_same_period'] else None
   shots.append(sh)
   if et=='Goal' and not period_shootout and row['team_id']:goals_by_team[row['team_id']]+=1
  if p.get('homeScore') is not None:home_before=p['homeScore']
  if p.get('awayScore') is not None:away_before=p['awayScore']
  prev=row
 games['home_nonshootout_goals_from_pbp']=goals_by_team.get(ids.get('home'),0);games['away_nonshootout_goals_from_pbp']=goals_by_team.get(ids.get('away'),0)
 return games,teamrows,playerrows,goalierows,officials,events,shots

def main():
 events_by_id={}
 for month in ['202409','202410','202411','202412','202501','202502','202503','202504','202505','202506']:
  j=get(f'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates={month}&limit=1000',f'scoreboard_{month}.json.gz')
  for e in j.get('events',[]):
   for c in e.get('competitions',[]):
    cs=c.get('competitors',[])
    if len(cs)!=2:continue
    h=next((x for x in cs if x.get('homeAway')=='home'),cs[0]);a=next((x for x in cs if x.get('homeAway')=='away'),cs[1]);status=c.get('status',{}).get('type',{}).get('name')
    events_by_id[c['id']]={'game_id':c['id'],'start_time':e.get('date'),'season_year_native':e.get('season',{}).get('year'),'season_type_native':e.get('season',{}).get('type'),'status':status,'home_id':h['id'],'home_name':h.get('team',{}).get('displayName'),'away_id':a['id'],'away_name':a.get('team',{}).get('displayName'),'home_final_score_native':h.get('score'),'away_final_score_native':a.get('score')}
 selected=sorted([g for g in events_by_id.values() if g['status']=='STATUS_FINAL' and g['season_type_native'] in [2,3] and g['home_id'] not in ['47842','47836','47838','47844'] and g['away_id'] not in ['47842','47836','47838','47844']],key=lambda x:x['start_time'])
 print('Selected regular-season/postseason',len(selected),'completed games; public-request budget',MAX_REQUESTS,flush=True)
 buckets=[[] for _ in range(7)];fails=[];completed=0
 with concurrent.futures.ThreadPoolExecutor(5) as ex:
  fs={ex.submit(gather,g):g['game_id'] for g in selected}
  for f in concurrent.futures.as_completed(fs):
   gid=fs[f]
   try:
    result=f.result()
    for b,r in zip(buckets,result):b.extend(r if isinstance(r,list) else [r])
   except Exception as e:fails.append({'game_id':gid,'error':str(e)})
   completed+=1
   if completed%100==0:print('Processed',completed,'/',len(selected),'failed',len(fails),flush=True)
 for filename,rows in zip(['games.csv','team_game_boxscores.csv','player_game_boxscores.csv','goalie_game_boxscores.csv','officials.csv','events.csv','shot_attempts.csv'],buckets):
  rows.sort(key=lambda r:(r['game_id'],str(r.get('event_id') or r.get('player_id') or r.get('team_id') or '')));write(filename,rows)
 write('schedule_all_statuses.csv',sorted(events_by_id.values(),key=lambda x:x['start_time']))
 (R/'sources/COLLECTION_MANIFEST.json').write_text(json.dumps({'source':'ESPN undocumented public factual feed','retrieved_at':NOW,'season':'2024-25','selected_completed_games':len(selected),'completed_details':len(buckets[0]),'requests_dispatched':requests,'request_budget':MAX_REQUESTS,'failures':fails,'cached_response_provenance':log,'first_publication_timestamps_reconstructed':False,'raw_cache_not_shipped':'Source response digests retained; normalized factual records shipped.'},indent=2))
 print('DONE counts',[len(x) for x in buckets],'failures',len(fails),flush=True)
if __name__=='__main__':main()
