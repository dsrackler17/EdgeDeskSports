"""Public ESPN NBA factual data. Run python scripts/collect.py. Requires pyarrow.
Cache outside deliverable; no credentials. Missing responses recorded, never invented.
"""
import concurrent.futures as cf
import datetime as dt
import gzip, hashlib, json, time, urllib.request
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT.parent/'quant_build/nba_cache'
CACHE.mkdir(parents=True,exist_ok=True)
BASE='https://site.api.espn.com/apis/site/v2/sports/basketball/nba/'
LOG=[]
def fetch(url,key):
    p=CACHE/(key+'.json.gz')
    if p.exists():return json.loads(gzip.decompress(p.read_bytes()))
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'EdgeDeskResearch/1.0'}),timeout=35) as r:j=json.load(r)
    # Retain factual game structures only; do not redistribute articles/video.
    if key.startswith('summary_'):j={k:v for k,v in j.items() if k in ['header','boxscore','gameInfo','plays']}
    p.write_bytes(gzip.compress(json.dumps(j).encode()))
    return j
def write(name,rows):
    if not rows:return
    # String encoding retains native tuples and IDs. Parse numerical values explicitly.
    keys=sorted(set().union(*(r.keys() for r in rows)))
    cols={k:[None if r.get(k) is None else (json.dumps(r[k],separators=(',',':')) if isinstance(r[k],(list,dict)) else str(r[k])) for r in rows] for k in keys}
    table=pa.table(cols)
    path=ROOT/'data'/f'{name}.parquet'
    pq.write_table(table,path,compression='zstd',compression_level=19)
    assert table.equals(pq.read_table(path)),name
    LOG.append({'table':name,'rows':len(rows),'columns':keys,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
def run():
    games={}; failures=[]
    for month in ['202510','202511','202512','202601','202602','202603','202604','202605','202606']:
        j=fetch(BASE+'scoreboard?dates='+month+'&limit=1000','scoreboard_'+month)
        for e in j.get('events',[]):
            c=e['competitions'][0];cs=c.get('competitors',[])
            if len(cs)!=2 or not all(str(x.get('team',{}).get('id')) in {str(i) for i in range(1,31)} for x in cs):continue
            if not c.get('status',{}).get('type',{}).get('completed'):continue
            if e.get('season',{}).get('type') not in [2,3,5]:continue
            games[e['id']]=e
    print('Selected games',len(games),flush=True)
    results=[]
    def one(gid):
        url=BASE+'summary?event='+gid
        try:return gid,fetch(url,'summary_'+gid),None
        except Exception as e:return gid,None,str(e)
    with cf.ThreadPoolExecutor(max_workers=20) as pool:
        for gid,j,error in pool.map(one,games):
            if error:failures.append({'game_id':gid,'error':error,'url':BASE+'summary?event='+gid})
            else:results.append(gid)
            if (len(results)+len(failures))%100==0:print('Downloaded',len(results),'missing',len(failures),flush=True)
    (ROOT/'sources/collection.json').write_text(json.dumps({'collected_at':dt.datetime.now(dt.timezone.utc).isoformat(),'season':'2025-26','base_url':BASE,'selected_games':len(games),'summary_success':len(results),'failures':failures},indent=2))
    game_rows=[];teams=[];players=[];events=[];shots=[];periods=[];officials=[]
    for gid,e in games.items():
        c=e['competitions'][0];cs=c['competitors'];h=next(x for x in cs if x['homeAway']=='home');a=next(x for x in cs if x['homeAway']=='away')
        scope='playoffs' if e['season']['type']==3 else ('play_in' if e['season']['type']==5 else 'regular_season_or_cup')
        game_rows.append({'game_id':gid,'date':e['date'],'season':2026,'season_type':e['season']['type'],'scope':scope,'competition_type':c.get('type'),'notes':c.get('notes'),'home_id':h['team']['id'],'away_id':a['team']['id'],'home_score':h['score'],'away_score':a['score'],'venue':c.get('venue'),'summary_available':gid not in {f['game_id'] for f in failures},'known_at':None})
        for x in cs:
            for n,s in enumerate(x.get('linescores',[]),1):periods.append({'game_id':gid,'team_id':x['team']['id'],'period':s.get('period',n),'points':s.get('value')})
    lookup={r['game_id']:r for r in game_rows}
    for gid in results:
        j=fetch(BASE+'summary?event='+gid,'summary_'+gid)
        game=lookup[gid];b=j.get('boxscore',{})
        for x in b.get('teams',[]):
            row={'game_id':gid,'team_id':x['team']['id'],'team_name':x['team'].get('displayName'),'home_away':x.get('homeAway')}
            for s in x.get('statistics',[]):row[s['name']]=s.get('displayValue',s.get('value'))
            teams.append(row)
        for x in b.get('players',[]):
            for group in x.get('statistics',[]):
                labels=group.get('labels',[])
                for p in group.get('athletes',[]):
                    at=p['athlete'];row={'game_id':gid,'team_id':x['team']['id'],'player_id':at.get('id'),'player_name':at.get('displayName'),'position':at.get('position',{}).get('abbreviation'),'starter':p.get('starter'),'did_not_play':p.get('didNotPlay'),'reason':p.get('reason')}
                    row.update(dict(zip(labels,p.get('stats',[]))));players.append(row)
        for o in j.get('gameInfo',{}).get('officials',[]):officials.append({'game_id':gid,**o})
        for p in j.get('plays',[]):
            coord=p.get('coordinate',{});x=coord.get('x');y=coord.get('y')
            if x is not None and abs(x)>1000:x=None
            if y is not None and abs(y)>1000:y=None
            row={'game_id':gid,'event_id':p.get('id'),'sequence':p.get('sequenceNumber'),'period':p.get('period',{}).get('number'),'clock':p.get('clock',{}).get('displayValue'),'type':p.get('type',{}).get('text'),'type_id':p.get('type',{}).get('id'),'description':p.get('text'),'team_id':p.get('team',{}).get('id'),'home_score':p.get('homeScore'),'away_score':p.get('awayScore'),'scoring_play':p.get('scoringPlay'),'score_value':p.get('scoreValue'),'shooting_play':p.get('shootingPlay'),'points_attempted':p.get('pointsAttempted'),'x_native':x,'y_native':y,'participants':p.get('participants'),'wallclock':p.get('wallclock'),'known_at':None}
            events.append(row)
            if p.get('shootingPlay'):shots.append(row)
    write('games',game_rows);write('team_boxscores',teams);write('player_boxscores',players);write('officials',officials);write('period_scores',periods)
    write('play_by_play',events);write('shots_and_free_throws',shots)
    write('substitutions',[r for r in events if 'substitution' in (r['type'] or '').lower()])
    measured=[]
    def num(r,key):
        try:return float(r.get(key))
        except (ValueError,TypeError):return None
    def pair(r,key):
        try:return tuple(map(float,r[key].split('-')))
        except (KeyError,ValueError,TypeError):return None,None
    by={(r['game_id'],r['team_id']):r for r in teams}
    for r in teams:
        g=lookup[r['game_id']];oppid=g['away_id'] if r['team_id']==g['home_id'] else g['home_id'];o=by.get((r['game_id'],oppid),{})
        fg,fga=pair(r,'fieldGoalsMade-fieldGoalsAttempted');th,tha=pair(r,'threePointFieldGoalsMade-threePointFieldGoalsAttempted');ft,fta=pair(r,'freeThrowsMade-freeThrowsAttempted')
        ofg,ofga=pair(o,'fieldGoalsMade-fieldGoalsAttempted');oft,ofta=pair(o,'freeThrowsMade-freeThrowsAttempted')
        orb=num(r,'offensiveRebounds');drb=num(r,'defensiveRebounds');oorb=num(o,'offensiveRebounds');odrb=num(o,'defensiveRebounds');to=num(r,'totalTurnovers');oto=num(o,'totalTurnovers')
        pts=float(g['home_score'] if r['team_id']==g['home_id'] else g['away_score']);opts=float(g['away_score'] if r['team_id']==g['home_id'] else g['home_score'])
        if any(v is None for v in [fg,fga,th,tha,ft,fta,ofga,ofta,orb,drb,oorb,odrb,to,oto]):continue
        poss=((fga-orb+to+.44*fta)+(ofga-oorb+oto+.44*ofta))/2
        measured.append({'game_id':r['game_id'],'team_id':r['team_id'],'date':g['date'],'scope':g['scope'],'points':pts,'opponent_points':opts,'fga':fga,'fgm':fg,'three_pm':th,'three_pa':tha,'fta':fta,'ftm':ft,'off_reb':orb,'def_reb':drb,'opp_off_reb':oorb,'opp_def_reb':odrb,'turnovers':to,'possessions_proxy':poss,'off_rating_proxy':100*pts/poss if poss else None,'def_rating_proxy':100*opts/poss if poss else None,'efg_pct':(fg+.5*th)/fga if fga else None,'tov_pct_proxy':to/poss if poss else None,'orb_pct':orb/(orb+odrb) if orb+odrb else None,'drb_pct':drb/(drb+oorb) if drb+oorb else None,'fta_per_fga':fta/fga if fga else None,'three_pa_share':tha/fga if fga else None,'scoring_reconciliation_delta':pts-(2*fg+th+ft)})
    write('team_measured_features',measured)
    history={};lagged=[]
    for r in sorted(measured,key=lambda r:(r['date'],r['game_id'])):
        past=history.setdefault(r['team_id'],[]);out={k:r[k] for k in ['game_id','team_id','date','scope']}
        for w in [5,10,20]:
            h=past[-w:];out[f'prior_{w}_games']=len(h)
            for key in ['points','opponent_points','possessions_proxy','off_rating_proxy','def_rating_proxy','efg_pct','tov_pct_proxy','orb_pct','drb_pct','fta_per_fga','three_pa_share']:
                v=[a[key] for a in h if a.get(key) is not None];out[f'prior_{w}_{key}_mean']=sum(v)/len(v) if v else None
            assert all(a['date']<r['date'] for a in h)
        out['days_since_previous_start']=(dt.datetime.fromisoformat(r['date'].replace('Z','+00:00'))-dt.datetime.fromisoformat(past[-1]['date'].replace('Z','+00:00'))).total_seconds()/86400 if past else None
        lagged.append(out);past.append(r)
    write('team_pregame_lags',lagged)
    assert len({r['game_id'] for r in game_rows})==len(game_rows)
    assert len({(r['game_id'],r['event_id']) for r in events})==len(events)
    assert all(r['scoring_reconciliation_delta']==0 for r in measured)
    (ROOT/'sources/inventory.json').write_text(json.dumps(LOG,indent=2))
    (ROOT/'COVERAGE.json').write_text(json.dumps({'season':'2025-26','games':len(game_rows),'detail_games':len(results),'missing_detail_games':failures,'tables':[{k:v for k,v in r.items() if k!='columns'} for r in LOG],'checks':['unique game and play keys','box-score scoring reconciliation','strictly earlier-game lags','exact Parquet roundtrip equality']},indent=2))
    print('COMPLETE',[(r['table'],r['rows']) for r in LOG],flush=True)
if __name__=='__main__':run()
