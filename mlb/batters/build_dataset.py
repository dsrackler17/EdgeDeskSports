#!/usr/bin/env python3
"""Download MLB regular-season hitting, validate team splits, export reusable tables. Python 3 stdlib only."""
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
 p={'stats':'season','group':'hitting','season':y,'sportIds':1,'playerPool':'ALL','gameType':'R','limit':10000}
 if tid:p['teamId']=tid
 d,u=fetch('stats',p,f'hitting_{y}_{tid or "all"}')
 ss=d['stats'][0];assert len(ss['splits'])==ss['totalSplits'],(y,tid,'pagination')
 return ss['splits'],u

teams={};allstats={}
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
 fut={ex.submit(fetch,'teams',{'sportId':1,'season':y},f'teams_{y}'):y for y in range(A.start,A.end+1)}
 for f in concurrent.futures.as_completed(fut):
  y=fut[f];d,u=f.result();teams[y]=d['teams'];assert len(teams[y])==30
jobs=[(y,t['id']) for y in sorted(teams) for t in teams[y]]+[(y,None) for y in sorted(teams)]
responses={}
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
 fut={ex.submit(stats,y,t):(y,t) for y,t in jobs}
 for n,f in enumerate(concurrent.futures.as_completed(fut),1):
  responses[fut[f]]=f.result()
  if n%30==0:print('Downloaded',n,'/',len(jobs),flush=True)
counts={'games':'gamesPlayed','plate_appearances':'plateAppearances','at_bats':'atBats','runs':'runs','hits':'hits','doubles':'doubles','triples':'triples','home_runs':'homeRuns','rbi':'rbi','walks':'baseOnBalls','intentional_walks':'intentionalWalks','strikeouts':'strikeOuts','hit_by_pitch':'hitByPitch','stolen_bases':'stolenBases','caught_stealing':'caughtStealing','total_bases':'totalBases','sacrifice_bunts':'sacBunts','sacrifice_flies':'sacFlies','grounded_into_double_play':'groundIntoDoublePlay','catcher_interference':'catchersInterference','pitches_seen':'numberOfPitches'}
core=[k for k in counts if k not in ['games','pitches_seen']]
team_lookup={(y,t['id']):t for y in teams for t in teams[y]}
rows=[]
def make_row(s,y,url,identity=None):
 t=team_lookup[y,s['team']['id']];st=s['stat'];p=(identity or s)['player'];pos=(identity or s).get('position',{})
 r={'player_id':p['id'],'player_name':p['fullName'],'season':y,'team_id':t['id'],'team_name':t['name'],'position_reported':pos.get('abbreviation'),'age':st.get('age')}
 for k,v in counts.items():r[k]=st.get(v)
 for k in core:assert r[k] is not None,(y,p['id'],k)
 r['source_url']=url;return r
for (y,tid),(ss,u) in responses.items():
 if tid is not None:
  for s in ss:
   assert s['team']['id']==tid;rows.append(make_row(s,y,u))
def group(data,keys):
 g=collections.defaultdict(list)
 for r in data:g[tuple(r[k] for k in keys)].append(r)
 return g
pre=group(rows,['season','player_id']);expected={(y,s['player']['id']):s for y in sorted(teams) for s in responses[y,None][0]}
repair=[]
for (y,pid),s in expected.items():
 rs=pre[y,pid]
 if not rs or any(sum(r[k] for r in rs)!=s['stat'][counts[k]] for k in core):repair.append((y,pid))
histories={}
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
 fut={ex.submit(fetch,f'people/{pid}/stats',{'stats':'yearByYear','group':'hitting','sportIds':1,'gameType':'R'},f'person_{pid}_yearByYear'):pid for pid in sorted({pid for y,pid in repair})}
 for f in concurrent.futures.as_completed(fut):histories[fut[f]]=f.result()
repairs=[]
for y,pid in repair:
 d,u=histories[pid];ss=[s for s in d['stats'][0]['splits'] if int(s['season'])==y and (y,s.get('team',{}).get('id')) in team_lookup]
 assert ss,(y,pid,'no individual team splits')
 old=[r for r in rows if (r['season'],r['player_id'])==(y,pid)];rows=[r for r in rows if (r['season'],r['player_id'])!=(y,pid)]
 rows.extend(make_row(s,y,u,expected[y,pid]) for s in ss);repairs.append({'season':y,'player_id':pid,'previous_team_rows':len(old),'replacement_team_rows':len(ss),'source_url':u})
print('Individual-history repairs:',len(repairs),flush=True)
rows.sort(key=lambda r:(r['season'],r['player_id'],r['team_id']));assert len(rows)==len({(r['player_id'],r['season'],r['team_id']) for r in rows})
assert {(r['season'],r['player_id']) for r in rows}==set(expected),'player universe mismatch'
def aggregate(rs,keys):
 r={k:rs[0][k] for k in keys}
 for k in counts:r[k]=None if any(x[k] is None for x in rs) else sum(x[k] for x in rs)
 return r
season=[];game_differences=[]
for (pid,y),rs in sorted(group(rows,['player_id','season']).items()):
 r=aggregate(rs,['player_id','player_name','season']);s=expected[y,pid]
 for k in core:assert r[k]==s['stat'][counts[k]],(y,pid,k,r[k],s['stat'][counts[k]])
 # Official full-season games can differ from team sums. Preserve both explicitly.
 r['team_split_games_sum']=r['games'];r['games']=s['stat'].get('gamesPlayed')
 if r['games']!=r['team_split_games_sum']:game_differences.append({'season':y,'player_id':pid,'official_games':r['games'],'team_split_games_sum':r['team_split_games_sum']})
 r['age']=s['stat'].get('age');r['position_reported']=s.get('position',{}).get('abbreviation');r['team_count']=len(rs);r['team_ids']=';'.join(str(x['team_id']) for x in sorted(rs,key=lambda x:x['team_id']));r['teams']=';'.join(x['team_name'] for x in sorted(rs,key=lambda x:x['team_id']));r['source_url']=responses[y,None][1];season.append(r)

def rates(r):
 h=r['hits'];ab=r['at_bats'];pa=r['plate_appearances'];hr=r['home_runs'];bb=r['walks'];hbp=r['hit_by_pitch'];sf=r['sacrifice_flies'];k=r['strikeouts'];tb=r['total_bases'];r['singles']=h-r['doubles']-r['triples']-hr
 assert r['singles']>=0
 assert tb==r['singles']+2*r['doubles']+3*r['triples']+4*hr
 obpd=ab+bb+hbp+sf
 for key,n,d in [('avg',h,ab),('obp',h+bb+hbp,obpd),('slg',tb,ab),('iso',tb-h,ab),('babip',h-hr,ab-k-hr+sf),('k_pct',k,pa),('bb_pct',bb,pa),('hr_pct',hr,pa),('sb_success_pct',r['stolen_bases'],r['stolen_bases']+r['caught_stealing'])]:r[key]=round(n/d,6) if d>0 else None
 r['ops']=round((h+bb+hbp)/obpd+tb/ab,6) if obpd and ab else None
 r['sample_flag']='zero_PA' if not pa else ('under_50_PA' if pa<50 else ('50_to_199_PA' if pa<200 else '200_plus_PA'))
 return r
league=[];lg={}
for y in sorted(teams):
 r=rates(aggregate([r for r in season if r['season']==y],['season']));r['player_games_sum']=r.pop('games');lg[y]=r;league.append(r)

def rate(r):
 rates(r);l=lg[r['season']];pa=r['plate_appearances'];ab=r['at_bats'];od=ab+r['walks']+r['hit_by_pitch']+r['sacrifice_flies'];lod=l['at_bats']+l['walks']+l['hit_by_pitch']+l['sacrifice_flies'];lobp=(l['hits']+l['walks']+l['hit_by_pitch'])/lod;lslg=l['total_bases']/l['at_bats'];r['league_obp']=round(lobp,6);r['league_slg']=round(lslg,6);r['rating_sample_weight']=round(pa/(pa+200),6);r['rating_version']='ED_BAT_PERF_V1'
 r['offensive_index']=round(100+100*pa/(pa+200)*(((r['hits']+r['walks']+r['hit_by_pitch'])/od)/lobp+(r['total_bases']/ab)/lslg-2),3) if pa and ab and od else None
 return r
for r in rows+season:rate(r)

def summary(rs,keys):
 r=rates(aggregate(rs,keys));ys=sorted({x['season'] for x in rs});r.update(first_observed_season=ys[0],last_observed_season=ys[-1],seasons_with_records=len(ys),seasons_with_PA=len({x['season'] for x in rs if x['plate_appearances']>0}),observed_seasons=';'.join(map(str,ys)),boundary_start=ys[0]==A.start,boundary_end=ys[-1]==A.end)
 valid=[x for x in rs if x['offensive_index'] is not None];pa=sum(x['plate_appearances'] for x in valid);r['rated_plate_appearances']=pa;r['weighted_offensive_index']=round(sum(x['offensive_index']*x['plate_appearances'] for x in valid)/pa,3) if pa else None
 return r
teamgroups=group(rows,['player_id','team_id']);team_history=[];runs=[]
for key,rs in sorted(teamgroups.items()):
 r=summary(rs,['player_id','player_name','team_id']);r['team_names_observed']=';'.join(sorted({x['team_name'] for x in rs}));team_history.append(r);chunks=[]
 for s in sorted(rs,key=lambda r:r['season']):
  if not chunks or s['season']!=chunks[-1][-1]['season']+1:chunks.append([])
  chunks[-1].append(s)
 for i,chunk in enumerate(chunks,1):
  q=summary(chunk,['player_id','player_name','team_id']);q['observed_run_number']=i;q['team_names_observed']=';'.join(sorted({x['team_name'] for x in chunk}));runs.append(q)
overall=[];byplayer=group(rows,['player_id'])
for (pid,),rs in sorted(group(season,['player_id']).items()):
 r=summary(rs,['player_id','player_name']);ts=byplayer[pid];r['team_count']=len({x['team_id'] for x in ts});r['teams']=';'.join(sorted({x['team_name'] for x in ts}));latest=max(rs,key=lambda x:x['season']);r['latest_observed_offensive_index']=latest['offensive_index'];r['best_season_by_index']=max((x for x in rs if x['offensive_index'] is not None),key=lambda x:x['offensive_index'],default={'season':None})['season'];overall.append(r)
team_controls={}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
 fut={ex.submit(fetch,'teams/stats',{'stats':'season','group':'hitting','season':y,'sportIds':1,'gameType':'R','limit':1000},f'team_totals_{y}'):y for y in sorted(teams)}
 for f in concurrent.futures.as_completed(fut):
  y=fut[f];d,u=f.result();ss=d['stats'][0];assert len(ss['splits'])==ss['totalSplits']==30
  for split in ss['splits']:team_controls[y,split['team']['id']]=(split['stat'],u)
team_seasons=[]
for (y,tid),rs in sorted(group(rows,['season','team_id']).items()):
 r=rate(aggregate(rs,['season','team_id','team_name']));control,url=team_controls[y,tid]
 for k in core:assert r[k]==control[counts[k]],('team_control',y,tid,k,r[k],control[counts[k]])
 r['player_games_sum']=r.pop('games');r['players_with_records']=len(rs);r['team_games']=control['gamesPlayed'];r['runs_per_game']=round(r['runs']/r['team_games'],6) if r['team_games'] else None;r['team_totals_source_url']=url;team_seasons.append(r)
team_window=[]
for (tid,),rs in sorted(group(team_seasons,['team_id']).items()):
 # Player-game totals are not club games. Restore only to reuse aggregation, then rename.
 ss=[dict(x,games=x['player_games_sum']) for x in rs];r=summary(ss,['team_id']);r['team_names_observed']=';'.join(sorted({x['team_name'] for x in rs}));r['player_games_sum']=r.pop('games');r['team_games']=sum(x['team_games'] for x in rs);r['runs_per_game']=round(r['runs']/r['team_games'],6) if r['team_games'] else None;team_window.append(r)
tm=[{'season':y,'team_id':t['id'],'team_name':t['name'],'abbreviation':t.get('abbreviation'),'league':t.get('league',{}).get('name'),'division':t.get('division',{}).get('name')} for y in sorted(teams) for t in teams[y]]
checks=[{'season':y,'teams':30,'players':sum(r['season']==y for r in season),'player_team_rows':sum(r['season']==y for r in rows),'counting_fields_reconciled':len(core),'player_totals_reconcile':True,'team_totals_reconcile':True} for y in sorted(teams)]
tables={'batter_seasons':season,'batter_team_seasons':rows,'batter_overview':overall,'batter_team_history':team_history,'observed_team_runs':runs,'team_offense_seasons':team_seasons,'team_offense_overview':team_window,'league_seasons':league,'teams':tm,'validation':checks}
def writecsv(name,data):
 cols=list(dict.fromkeys(k for r in data for k in r))
 with (ROOT/(name+'.csv')).open('w',newline='',encoding='utf-8-sig') as f:
  w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(data)
 return cols
DB=ROOT/'mlb_offense.sqlite';temp=ROOT/'mlb_offense.build.sqlite';temp.unlink(missing_ok=True);con=sqlite3.connect(temp)
for name,data in tables.items():
 cols=writecsv(name,data);types=[]
 for col in cols:
  vals=[r[col] for r in data if r.get(col) is not None];types.append('INTEGER' if all(isinstance(v,(int,bool)) for v in vals) else ('REAL' if all(isinstance(v,(int,float)) for v in vals) else 'TEXT'))
 con.execute('CREATE TABLE '+name+' ('+', '.join('"'+col+'" '+t for col,t in zip(cols,types))+')');con.executemany('INSERT INTO '+name+' VALUES ('+','.join('?' for col in cols)+')',[[r.get(col) for col in cols] for r in data])
con.execute('CREATE UNIQUE INDEX batter_season_key ON batter_seasons(player_id,season)');con.execute('CREATE UNIQUE INDEX batter_team_season_key ON batter_team_seasons(player_id,season,team_id)');con.execute('CREATE UNIQUE INDEX team_season_key ON team_offense_seasons(team_id,season)');con.commit();assert con.execute('PRAGMA integrity_check').fetchone()[0]=='ok';con.close();temp.replace(DB)
(ROOT/'source_manifest.json').write_text(json.dumps(sorted(manifest,key=lambda x:x['file']),indent=2));(ROOT/'source_repairs.json').write_text(json.dumps(repairs,indent=2));(ROOT/'games_reconciliation_notes.json').write_text(json.dumps(game_differences,indent=2))
report={'start_season':A.start,'end_season':A.end,'scope':'MLB regular-season hitting records returned by playerPool=ALL, including pitchers and zero-PA records; no postseason or roster-only coverage','tables':{k:len(v) for k,v in tables.items()},'unique_players':len(overall),'players_with_PA':sum(r['plate_appearances']>0 for r in overall),'individual_history_repairs':len(repairs),'games_field_differences':len(game_differences),'validation':f'PASS: every player-season reconciled across {len(core)} offensive counting fields; every team-season reconciled to independent team endpoint; source universe, pagination, unique keys, all 30 teams/year, total-base identities, SQLite integrity','built_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(ROOT/'build_report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
