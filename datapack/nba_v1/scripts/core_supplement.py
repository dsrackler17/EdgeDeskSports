"""Fetch missing detailed games from ESPN's alternate public core API.
Run after collect.py. Separate native stat tables preserve definitions.
"""
import concurrent.futures as cf,json,urllib.parse
import collect as c
R=c.ROOT;BASE='https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/'
games={r['game_id']:r for r in c.pq.read_table(R/'data/games.parquet').to_pylist()}
missing=json.loads((R/'sources/collection.json').read_text())['failures']
def idref(x):
    if isinstance(x,dict):
        if x.get('id') is not None:return str(x['id'])
        ref=x.get('$ref','');return urllib.parse.urlsplit(ref).path.rstrip('/').split('/')[-1] if ref else None
def pull(url,key):return c.fetch(url.replace('http://','https://'),key)
jobs=[]
for f in missing:
    gid=f['game_id'];g=games[gid]
    root=BASE+gid+'/competitions/'+gid
    jobs.append((gid,None,'plays',root+'/plays?limit=1000'))
    for tid in [g['home_id'],g['away_id']]:
        jobs +=[(gid,tid,'teamstats',root+'/competitors/'+tid+'/statistics'),(gid,tid,'roster',root+'/competitors/'+tid+'/roster')]
errors=[];responses=[];manifest=[]
def one(job):
    gid,tid,kind,url=job;key='core_'+gid+'_'+str(tid)+'_'+kind
    try:return job,pull(url,key),None
    except Exception as e:return job,None,str(e)
with cf.ThreadPoolExecutor(12) as pool:
    for job,j,err in pool.map(one,jobs):
        if err:errors.append({'job':job,'error':err})
        else:responses.append((job,j));manifest.append({'game_id':job[0],'team_id':job[1],'kind':job[2],'url':job[3]})
events=[];teamstats=[];playerstats=[];playerjobs=[];rosters=[]
def flatten(gid,tid,pid,j):
    out=[]
    for cat in j.get('splits',{}).get('categories',[]):
        for s in cat.get('stats',[]):
            out.append({'game_id':gid,'team_id':tid,'player_id':pid,'category':cat.get('name'),'stat_name':s.get('name'),'stat_display_name':s.get('displayName'),'stat_abbreviation':s.get('abbreviation'),'value':s.get('value'),'display_value':s.get('displayValue')})
    return out
for (gid,tid,kind,url),j in responses:
    if kind=='plays':
        assert j.get('pageCount',1)==1,'Unretrieved core play pagination'
        for p in j.get('items',[]):
            row={'game_id':gid,'event_id':p.get('id'),'sequence':p.get('sequenceNumber'),'period':p.get('period',{}).get('number'),'clock':p.get('clock',{}).get('displayValue'),'type':p.get('type',{}).get('text'),'team_id':idref(p.get('team')),'description':p.get('text'),'home_score':p.get('homeScore'),'away_score':p.get('awayScore'),'scoring_play':p.get('scoringPlay'),'score_value':p.get('scoreValue'),'shooting_play':p.get('shootingPlay'),'points_attempted':p.get('pointsAttempted'),'participants':p.get('participants'),'wallclock':p.get('wallclock'),'known_at':None}
            for axis in ['x','y']:
                value=p.get('coordinate',{}).get(axis)
                row[axis+'_native']=value if value is not None and abs(value)<=1000 else None
            events.append(row)
    elif kind=='teamstats':teamstats+=flatten(gid,tid,None,j)
    else:
        for player in j.get('entries',[]):
            pid=str(player.get('playerId') or idref(player.get('athlete')) or '')
            rosters.append({'game_id':gid,'team_id':tid,'player_id':pid,'display_name_native':player.get('displayName'),'starter':player.get('starter'),'did_not_play':player.get('didNotPlay'),'reason':player.get('reason'),'jersey':player.get('jersey'),'athlete_ref':player.get('athlete'),'position_ref':player.get('position')})
            refs=player.get('statistics',{})
            url=refs.get('$ref') if isinstance(refs,dict) else None
            if url:playerjobs.append((gid,tid,pid,url))
def playerjob(job):
    gid,tid,pid,url=job
    try:return job,pull(url,'core_player_'+gid+'_'+pid),None
    except Exception as e:return job,None,str(e)
with cf.ThreadPoolExecutor(12) as pool:
    for job,j,err in pool.map(playerjob,playerjobs):
        if err:errors.append({'job':job,'error':err})
        else:
            playerstats+=flatten(*job[:3],j);manifest.append({'game_id':job[0],'team_id':job[1],'player_id':job[2],'kind':'playerstats','url':job[3]})
c.write('core_supplement_plays',events);c.write('core_supplement_shots',[e for e in events if e['shooting_play']]);c.write('core_supplement_team_stats',teamstats);c.write('core_supplement_player_stats',playerstats)
c.write('core_supplement_rosters',rosters)
assert len({(e['game_id'],e['event_id']) for e in events})==len(events)
rewritten={x['table'] for x in c.LOG}
inventory=[x for x in json.loads((R/'sources/inventory.json').read_text()) if x['table'] not in rewritten]+c.LOG
(R/'sources/inventory.json').write_text(json.dumps(inventory,indent=2))
coverage=json.loads((R/'COVERAGE.json').read_text());coverage['core_supplement_game_ids']=sorted(set(e['game_id'] for e in events));coverage['core_supplement_errors']=errors;coverage['tables']=[x for x in coverage['tables'] if x['table'] not in rewritten]+[{k:v for k,v in x.items() if k!='columns'} for x in c.LOG]
(R/'COVERAGE.json').write_text(json.dumps(coverage,indent=2))
(R/'sources/core_supplement.json').write_text(json.dumps({'collected_at':c.dt.datetime.now(c.dt.timezone.utc).isoformat(),'requests':manifest,'errors':errors,'note':'Supplemental native core tables are separate from site tables; use game_id and source priority, not concatenated duplicates.'},indent=2))
print('CORE',len(events),len(teamstats),len(playerstats),'errors',len(errors),flush=True)
