#!/usr/bin/env python3
"""Download MLB regular-season pitching, validate team splits, export reusable tables. Python 3 stdlib only."""
import argparse,collections,concurrent.futures,csv,datetime,hashlib,json,pathlib,sqlite3,time,urllib.parse,urllib.request
P=argparse.ArgumentParser();P.add_argument('--start',type=int,default=2016);P.add_argument('--end',type=int,default=2025);P.add_argument('--output',default=str(pathlib.Path(__file__).resolve().parent));P.add_argument('--refresh',action='store_true');A=P.parse_args()
ROOT=pathlib.Path(A.output);RAW=ROOT/'raw';RAW.mkdir(parents=True,exist_ok=True)
BASE='https://statsapi.mlb.com/api/v1/'
manifest=[]
def fetch(path,params,key):
 url=BASE+path+'?'+urllib.parse.urlencode(params); f=RAW/(key+'.json');meta=RAW/(key+'.meta.json')
 if A.refresh or not f.exists():
  for attempt in range(5):
   try:
    with urllib.request.urlopen(url,timeout=60) as r: b=r.read()
    d=json.loads(b);f.write_bytes(b);meta.write_text(json.dumps({'url':url,'retrieved_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sha256':hashlib.sha256(b).hexdigest()}));break
   except Exception:
    if attempt==4:raise
    time.sleep(2**attempt)
 else:d=json.loads(f.read_text())
 m=json.loads(meta.read_text());manifest.append(dict(file=str(f.relative_to(ROOT)),**m));return d,url

def stats(y,tid=None):
 p={'stats':'season','group':'pitching','season':y,'sportIds':1,'playerPool':'ALL','gameType':'R','limit':10000}
 if tid:p['teamId']=tid
 d,u=fetch('stats',p,f'pitching_{y}_{tid or "all"}')
 ss=d['stats'][0];assert len(ss['splits'])==ss['totalSplits'],(y,tid,'pagination')
 return ss['splits'],u

teams={};allstats={}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
 fut={ex.submit(fetch,'teams',{'sportId':1,'season':y},f'teams_{y}'):y for y in range(A.start,A.end+1)}
 for f in concurrent.futures.as_completed(fut):
  y=fut[f];d,u=f.result();teams[y]=d['teams'];assert len(teams[y])==30
jobs=[(y,t['id']) for y in sorted(teams) for t in teams[y]]+[(y,None) for y in sorted(teams)]
responses={}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
 fut={ex.submit(stats,y,t):(y,t) for y,t in jobs}
 for n,f in enumerate(concurrent.futures.as_completed(fut),1):
  responses[fut[f]]=f.result()
  if n%30==0:print('Downloaded',n,'/',len(jobs),flush=True)
counts={'games':'gamesPitched','starts':'gamesStarted','outs':'outs','wins':'wins','losses':'losses','saves':'saves','save_opportunities':'saveOpportunities','holds':'holds','blown_saves':'blownSaves','hits':'hits','runs':'runs','earned_runs':'earnedRuns','home_runs':'homeRuns','strikeouts':'strikeOuts','walks':'baseOnBalls','intentional_walks':'intentionalWalks','hit_batters':'hitByPitch','batters_faced':'battersFaced','pitches':'numberOfPitches','complete_games':'completeGames','shutouts':'shutouts','inherited_runners':'inheritedRunners','inherited_runners_scored':'inheritedRunnersScored','wild_pitches':'wildPitches','balks':'balks'}
rows=[];tm=[]
for y in sorted(teams):
 for t in teams[y]:
  tm.append({'season':y,'team_id':t['id'],'team_name':t['name'],'abbreviation':t.get('abbreviation'),'league':t.get('league',{}).get('name'),'division':t.get('division',{}).get('name')})
  ss,url=responses[y,t['id']]
  for s in ss:
   assert s['team']['id']==t['id']
   st=s['stat'];r={'player_id':s['player']['id'],'player_name':s['player']['fullName'],'season':y,'team_id':t['id'],'team_name':t['name'],'position_reported':s.get('position',{}).get('abbreviation'),'age':st.get('age')}
   for k,v in counts.items():r[k]=st.get(v)
   for k in ['games','starts','outs','earned_runs','home_runs','strikeouts','walks','hit_batters','batters_faced','hits']:assert r[k] is not None,(y,r['player_id'],k)
   ip=st['inningsPitched'].split('.');assert int(ip[0])*3+int(ip[1])==r['outs']
   r['source_url']=url;rows.append(r)
# Some historical team queries omit pre-trade clubs. Repair only from sourced
# individual year-by-year team splits, never by allocating totals or guessing.
core=['games','starts','outs','wins','losses','saves','hits','runs','earned_runs','home_runs','strikeouts','walks','hit_batters','batters_faced']
pre=collections.defaultdict(list)
for r in rows:pre[r['season'],r['player_id']].append(r)
repair=[]
for y in sorted(teams):
 for expected in responses[y,None][0]:
  pid=expected['player']['id'];rs=pre[y,pid]
  if not rs or any(sum(r[k] for r in rs)!=expected['stat'][counts[k]] for k in core):repair.append((y,pid))
repairs=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
 fut={ex.submit(fetch,f'people/{pid}/stats',{'stats':'yearByYear','group':'pitching','sportIds':1,'gameType':'R'},f'person_{pid}_yearByYear'):(y,pid) for y,pid in repair}
 for f in concurrent.futures.as_completed(fut):
  y,pid=fut[f];d,url=f.result();splits=[s for s in d['stats'][0]['splits'] if int(s['season'])==y and s.get('team',{}).get('id') in {t['id'] for t in teams[y]}]
  assert splits,(y,pid,'no individual team splits')
  old=[r for r in rows if (r['season'],r['player_id'])==(y,pid)]
  rows=[r for r in rows if (r['season'],r['player_id'])!=(y,pid)]
  for split in splits:
   st=split['stat'];t=next(t for t in teams[y] if t['id']==split['team']['id']);expected=next(s for s in responses[y,None][0] if s['player']['id']==pid)
   r={'player_id':pid,'player_name':expected['player']['fullName'],'season':y,'team_id':t['id'],'team_name':t['name'],'position_reported':expected.get('position',{}).get('abbreviation'),'age':st.get('age')}
   for k,v in counts.items():r[k]=st.get(v)
   for k in core:assert r[k] is not None,(y,pid,k)
   ip=st['inningsPitched'].split('.');assert int(ip[0])*3+int(ip[1])==r['outs']
   r['source_url']=url;rows.append(r)
  repairs.append({'season':y,'player_id':pid,'previous_team_rows':len(old),'replacement_team_rows':len(splits),'source_url':url})
if repairs:print('Repaired from individual histories:',len(repairs),flush=True)
rows.sort(key=lambda r:(r['season'],r['player_id'],r['team_id']))
(ROOT/'source_repairs.json').write_text(json.dumps(sorted(repairs,key=lambda r:(r['season'],r['player_id'])),indent=2))

assert len(rows)==len({(r['player_id'],r['season'],r['team_id']) for r in rows})
def group(data,keys):
 g=collections.defaultdict(list)
 for r in data:g[tuple(r[k] for k in keys)].append(r)
 return g

def aggregate(rs,keys):
 r={k:rs[0][k] for k in keys}
 for k in counts:r[k]=None if any(x[k] is None for x in rs) else sum(x[k] for x in rs)
 return r
season=[];checks=[]
for (pid,y),rs in sorted(group(rows,['player_id','season']).items()):
 r=aggregate(rs,['player_id','player_name','season']);r['age']=rs[0]['age'];r['position_reported']=rs[0]['position_reported'];r['team_count']=len(rs);r['team_ids']=';'.join(str(x['team_id']) for x in sorted(rs,key=lambda x:x['team_id']));r['teams']=';'.join(x['team_name'] for x in sorted(rs,key=lambda x:x['team_id']));season.append(r)
for y in sorted(teams):
 actual={r['player_id']:r for r in season if r['season']==y};ss,url=responses[y,None];expected={s['player']['id']:s for s in ss};assert actual.keys()==expected.keys(),(y,'player universe mismatch')
 for pid,r in actual.items():
  for k in ['games','starts','outs','wins','losses','saves','hits','runs','earned_runs','home_runs','strikeouts','walks','hit_batters','batters_faced']:
   assert r[k]==expected[pid]['stat'][counts[k]],(y,pid,k,r[k],expected[pid]['stat'][counts[k]])
 checks.append({'season':y,'teams':30,'pitchers':len(actual),'pitcher_team_rows':sum(r['season']==y for r in rows),'player_totals_reconcile':True})
league=[];lg={}
for y in sorted(teams):
 rs=[r for r in season if r['season']==y];r=aggregate(rs,['season']);ip=r['outs']/3;r['league_era']=27*r['earned_runs']/r['outs'];r['fip_constant']=r['league_era']-(13*r['home_runs']+3*(r['walks']+r['hit_batters'])-2*r['strikeouts'])/ip;league.append(r);lg[y]=r

def rates(r):
 o=r['outs'];bf=r['batters_faced'];r['innings_display']=f'{o//3}.{o%3}';r['innings_decimal']=round(o/3,6)
 for k,n,d in [('era',27*r['earned_runs'],o),('whip',3*(r['walks']+r['hits']),o),('k_per_9',27*r['strikeouts'],o),('bb_per_9',27*r['walks'],o),('hr_per_9',27*r['home_runs'],o),('k_pct',r['strikeouts'],bf),('bb_pct',r['walks'],bf),('k_minus_bb_pct',r['strikeouts']-r['walks'],bf)]:r[k]=round(n/d,6) if d else None
 r['role']='starter' if r['starts']/max(r['games'],1)>=.5 else ('reliever' if not r['starts'] else 'mixed')
 r['sample_flag']='zero_outs' if not o else ('under_10_IP' if o<30 else ('10_to_39_IP' if o<120 else '40_plus_IP'))
 return r

def rate(r):
 rates(r);l=lg[r['season']];ip=r['outs']/3;r['league_era']=round(l['league_era'],6);r['fip_constant']=round(l['fip_constant'],6);r['rating_version']='ED_PITCH_PERF_V1';r['rating_sample_weight']=round(ip/(ip+40),6)
 if ip:
  era=9*r['earned_runs']/ip;fip=(13*r['home_runs']+3*(r['walks']+r['hit_batters'])-2*r['strikeouts'])/ip+l['fip_constant'];r['fip']=round(fip,6);r['performance_index']=round(100+100*ip/(ip+40)*(1-(.7*fip+.3*era)/l['league_era']),3)
 else:r['fip']=None;r['performance_index']=None
for r in rows+season:rate(r)

def summary(rs,keys):
 r=rates(aggregate(rs,keys));years=sorted({x['season'] for x in rs});r.update(first_observed_season=years[0],last_observed_season=years[-1],seasons_with_appearances=len(years),observed_seasons=';'.join(map(str,years)),boundary_start=years[0]==A.start,boundary_end=years[-1]==A.end)
 valid=[x for x in rs if x['performance_index'] is not None];o=sum(x['outs'] for x in valid);r['weighted_performance_index']=round(sum(x['performance_index']*x['outs'] for x in valid)/o,3) if o else None
 return r
team_history=[summary(rs,['player_id','player_name','team_id']) for key,rs in sorted(group(rows,['player_id','team_id']).items())]
for r in team_history:
 rs=group(rows,['player_id','team_id'])[(r['player_id'],r['team_id'])];r['team_names_observed']=';'.join(sorted({x['team_name'] for x in rs}))
stints=[]
for key,rs in sorted(group(rows,['player_id','team_id']).items()):
 chunks=[]
 for r in sorted(rs,key=lambda r:r['season']):
  if not chunks or r['season']!=chunks[-1][-1]['season']+1:chunks.append([])
  chunks[-1].append(r)
 for i,chunk in enumerate(chunks,1):
  r=summary(chunk,['player_id','player_name','team_id']);r['observed_run_number']=i;r['team_names_observed']=';'.join(sorted({x['team_name'] for x in chunk}));stints.append(r)
overall=[]
for key,rs in sorted(group(season,['player_id']).items()):
 r=summary(rs,['player_id','player_name']);teamrows=[x for x in rows if x['player_id']==key[0]];r['team_count']=len({x['team_id'] for x in teamrows});r['teams']=';'.join(sorted({x['team_name'] for x in teamrows}));last=max(rs,key=lambda x:x['season']);r['latest_observed_performance_index']=last['performance_index'];r['latest_observed_role']=last['role'];r['best_season_by_index']=max((x for x in rs if x['performance_index'] is not None),key=lambda x:x['performance_index'],default={'season':None})['season'];overall.append(r)
tables={'pitcher_seasons':season,'pitcher_team_seasons':rows,'pitcher_overview':overall,'pitcher_team_history':team_history,'observed_team_runs':stints,'league_seasons':league,'teams':tm,'validation':checks}
def writecsv(name,data):
 cols=list(dict.fromkeys(k for r in data for k in r))
 with (ROOT/(name+'.csv')).open('w',newline='',encoding='utf-8-sig') as f:
  w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(data)
 return cols
DB=ROOT/'mlb_pitchers.sqlite';DB.unlink(missing_ok=True);con=sqlite3.connect(DB)
for name,data in tables.items():
 cols=writecsv(name,data);types=[]
 for c in cols:
  vals=[r[c] for r in data if r.get(c) is not None];types.append('INTEGER' if all(isinstance(v,(int,bool)) for v in vals) else ('REAL' if all(isinstance(v,(int,float)) for v in vals) else 'TEXT'))
 con.execute('CREATE TABLE '+name+' ('+', '.join('"'+c+'" '+t for c,t in zip(cols,types))+')');con.executemany('INSERT INTO '+name+' VALUES ('+','.join('?' for c in cols)+')',[[r.get(c) for c in cols] for r in data])
con.execute('CREATE UNIQUE INDEX season_key ON pitcher_seasons(player_id,season)');con.execute('CREATE UNIQUE INDEX team_season_key ON pitcher_team_seasons(player_id,season,team_id)');con.commit();assert con.execute('PRAGMA integrity_check').fetchone()[0]=='ok';con.close()
(ROOT/'source_manifest.json').write_text(json.dumps(sorted(manifest,key=lambda x:x['file']),indent=2))
report={'start_season':A.start,'end_season':A.end,'scope':'MLB regular season; all players with pitching appearances; no postseason or zero-appearance roster members','tables':{k:len(v) for k,v in tables.items()},'unique_pitchers':len(overall),'validation':'PASS: every player-season reconciled to independently fetched all-team MLB totals for 14 counting fields; unique keys; pagination; 30 teams/year; innings-to-outs; SQLite integrity','built_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(ROOT/'build_report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
