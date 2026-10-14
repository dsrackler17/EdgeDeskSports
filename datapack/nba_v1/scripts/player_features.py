"""Run after collect.py. Preserves measurements; computes prior-player exposure features."""
import datetime as dt,json,gzip
from collections import defaultdict
import collect as c
import pyarrow.parquet as pq

R=c.ROOT
games={r['game_id']:r for r in pq.read_table(R/'data/games.parquet').to_pylist()}
periods=pq.read_table(R/'data/period_scores.parquet').to_pylist()
last_period={}
for p in periods:
    last_period[p['game_id']]=max(last_period.get(p['game_id'],0),int(float(p['period'])))
for g in games.values():
    native=json.loads(g.get('competition_type') or '{}')
    if native.get('id')=='39' or native.get('abbreviation')=='CC':g['scope']='nba_cup_final'
    elif g['season_type']=='2':g['scope']='regular_season'
    g['last_scoring_period']=last_period.get(g['game_id'])
c.write('games',list(games.values()))
teamrows=pq.read_table(R/'data/team_measured_features.parquet').to_pylist()
for r in teamrows:
    g=games[r['game_id']];r['scope']=g['scope'];period=g['last_scoring_period']
    duration=48+5*(period-4) if period is not None and period>=4 else None
    r['game_minutes_from_period_count']=duration
    r['pace_per48_proxy']=48*float(r['possessions_proxy'])/duration if duration else None
    r['net_rating_proxy']=float(r['off_rating_proxy'])-float(r['def_rating_proxy'])
c.write('team_measured_features',teamrows)
teamlags=pq.read_table(R/'data/team_pregame_lags.parquet').to_pylist()
lagmap={(r['game_id'],r['team_id']):r for r in teamlags};thistory=defaultdict(list)
for r in sorted(teamrows,key=lambda r:(r['date'],r['game_id'])):
    out=lagmap[(r['game_id'],r['team_id'])];out['scope']=r['scope'];h=thistory[r['team_id']]
    for w in [5,10,20]:
        v=[float(a['pace_per48_proxy']) for a in h[-w:] if a.get('pace_per48_proxy') is not None]
        out[f'prior_{w}_pace_per48_proxy_mean']=sum(v)/len(v) if v else None
    h.append(r)
c.write('team_pregame_lags',teamlags)
players=pq.read_table(R/'data/player_boxscores.parquet').to_pylist()
identity_warnings=[]
for gid in sorted({p['game_id'] for p in players if not p.get('player_id')}):
    cache=c.CACHE/('summary_'+gid+'.json.gz')
    if not cache.exists():continue
    j=json.loads(gzip.decompress(cache.read_bytes()))
    for team in j.get('boxscore',{}).get('players',[]):
        for group in team.get('statistics',[]):
            for p in group.get('athletes',[]):
                if not p.get('athlete',{}).get('id'):
                    identity_warnings.append({'game_id':gid,'team_id':team['team']['id'],'native_athlete':p.get('athlete'),'native_stats':dict(zip(group.get('labels',[]),p.get('stats',[]))),'reason':p.get('reason'),'did_not_play':p.get('didNotPlay'),'identity_status':'source_id_missing_do_not_join_by_short_name'})
c.write('unresolved_player_identity_records',identity_warnings)
def number(x):
    try:return float(x)
    except (TypeError,ValueError):return None
def pair(x):
    try:return tuple(map(float,x.split('-')))
    except (TypeError,ValueError,AttributeError):return None,None
rows=[]
for p in players:
    m=p.get('MIN');minutes=None
    try:
        if ':' in m:
            a,b=m.split(':');minutes=float(a)+float(b)/60
        else:minutes=float(m)
    except (ValueError,TypeError):pass
    fg,fga=pair(p.get('FG'));th,tha=pair(p.get('3PT'));ft,fta=pair(p.get('FT'))
    g=games[p['game_id']]
    r={k:p.get(k) for k in ['game_id','team_id','player_id','player_name','starter','did_not_play']}
    r.update({'date':g['date'],'scope':g['scope'],'minutes_native':m,'minutes_numeric':minutes,'minutes_precision':'native_clock' if m and ':' in m else 'native_whole_minutes_or_missing','fgm':fg,'fga':fga,'three_pm':th,'three_pa':tha,'ftm':ft,'fta':fta})
    for native,key in [('PTS','points'),('REB','rebounds'),('AST','assists'),('TO','turnovers'),('STL','steals'),('BLK','blocks'),('OREB','off_reb'),('DREB','def_reb'),('PF','fouls'),('+/-','plus_minus')]:r[key]=number(p.get(native))
    pts=r['points'];den=2*(fga+.44*fta) if fga is not None and fta is not None else None
    r['true_shooting_proxy']=pts/den if pts is not None and den else None
    for key in ['points','rebounds','assists','turnovers','steals','blocks','fga','three_pa','fta']:
        r[key+'_per36']=r[key]*36/minutes if r[key] is not None and minutes and minutes>0 else None
    rows.append(r)
c.write('player_measured_features',rows)
past=defaultdict(list);lags=[]
for r in sorted(rows,key=lambda r:(r['date'],r['game_id'],r['player_id'] or '')):
    history=past[r['player_id']] if r['player_id'] else [];out={k:r[k] for k in ['game_id','team_id','player_id','date']}
    for w in [5,10,20]:
        h=history[-w:];out[f'prior_{w}_positive_minute_games']=len(h)
        minutes=sum(a['minutes_numeric'] for a in h)
        out[f'prior_{w}_mean_minutes']=minutes/len(h) if h else None
        for key in ['points','rebounds','assists','turnovers','steals','blocks','fga','three_pa','fta']:
            valid=[a for a in h if a.get(key) is not None];den=sum(a['minutes_numeric'] for a in valid)
            out[f'prior_{w}_{key}_pooled_per36']=36*sum(a[key] for a in valid)/den if den else None
        out[f'prior_{w}_different_team_games']=sum(a['team_id']!=r['team_id'] for a in h)
        assert all(a['date']<r['date'] and a['minutes_numeric']>0 for a in h)
    lags.append(out)
    if r['player_id'] and r['minutes_numeric'] is not None and r['minutes_numeric']>0:history.append(r)
c.write('player_pregame_lags',lags)
rewritten={x['table'] for x in c.LOG}
inventory=[x for x in json.loads((R/'sources/inventory.json').read_text()) if x['table'] not in rewritten]+c.LOG
(R/'sources/inventory.json').write_text(json.dumps(inventory,indent=2))
coverage=json.loads((R/'COVERAGE.json').read_text());coverage['tables']=[x for x in coverage['tables'] if x['table'] not in rewritten]+[{k:v for k,v in x.items() if k!='columns'} for x in c.LOG]
coverage['checks'].append('player lags exclude current/future/zero-minute rows')
coverage['primary_player_rows_missing_source_id']=sum(not p.get('player_id') for p in players)
(R/'COVERAGE.json').write_text(json.dumps(coverage,indent=2))
print('player features',len(rows),'lags',len(lags),flush=True)
