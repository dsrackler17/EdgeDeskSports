"""Measured team factors, source ID bridges, prior-game features; no fitted bet probabilities.
python scripts/build_features.py [--player-seasons 2024 2025 2026]
Native raw source tables stay unchanged. Defaults to latest-season player lags.
"""
from collections import Counter,defaultdict,deque
from pathlib import Path
import argparse,datetime as dt,hashlib,json,math
import pyarrow as pa
import pyarrow.parquet as pq
R=Path(__file__).resolve().parents[1];D=R/'data';ADDED=[]
def read(name):return pq.read_table(D/(name+'.parquet')).to_pylist()
def write(name,rows):
    t=pa.Table.from_pylist(rows);p=D/(name+'.parquet');pq.write_table(t,p,compression='zstd',compression_level=19,row_group_size=max(1,t.num_rows))
    assert t.equals(pq.read_table(p))
    ADDED.append({'table':name,'file':'data/'+p.name,'rows':t.num_rows,'columns':t.column_names,'native_schema':str(t.schema),'bytes':p.stat().st_size,'delivered_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'source_tag':'EdgeDesk measured/lagged transformations','encoding_check':'Exact in-memory table equality after encoding'})
def safe(a,b):return a/b if a is not None and b is not None and b>0 else None
def finite(v):return isinstance(v,(int,float)) and math.isfinite(v)
def main(years):
    bridge=[]
    for season in [2024,2025,2026]:
        refs={str(r['id']):r for r in read('ncaa_mbb_team_ids_'+str(season))}
        seen=set()
        for r in read('ncaa_mbb_team_box_'+str(season)):
            n=r.get('team_ncaa_team_id');e=r.get('team_espn_team_id');key=(season,n,e)
            if key in seen or n is None or e is None:continue
            seen.add(key);ref=refs.get(str(n))
            bridge.append({'season':season,'ncaa_team_season_id':str(n),'espn_team_id':str(e),'native_ncaa_team_name':r['team'],'conference':ref.get('conference') if ref else None,'listed_in_publisher_d1_team_reference':ref is not None,'mapping_source':'publisher ncaa_mbb_team_box explicit IDs'})
    write('team_season_identity_bridge',bridge)
    membership={(r['season'],r['espn_team_id']):r for r in bridge if r['listed_in_publisher_d1_team_reference']}
    schedules={};raw=[]
    for year in [2024,2025,2026]:
        for g in read('espn_mbb_schedule_'+str(year)):schedules[(year,g['game_id'])]=g
        raw+=read('espn_team_box_'+str(year))
    keycounts=Counter((r['season'],r['game_id'],r['team_id']) for r in raw)
    by={(r['season'],r['game_id'],r['team_id']):r for r in raw}
    features=[];quality=[]
    factors=['field_goals_made','field_goals_attempted','three_point_field_goals_made','three_point_field_goals_attempted','free_throws_made','free_throws_attempted','offensive_rebounds','defensive_rebounds','total_turnovers']
    for r in raw:
        season=r['season'];gid=r['game_id'];tid=r['team_id'];oppid=r['opponent_team_id'];key=(season,gid,tid);other=(season,gid,oppid)
        o=by.get(other);g=schedules.get((season,gid),{});pair_ok=keycounts[key]==1 and keycounts[other]==1 and o is not None
        row={k:r.get(k) for k in ['season','game_id','team_id','opponent_team_id','game_date_time','team_home_away','team_score','opponent_team_score']}
        row.update({k:r.get(k) for k in factors});row['pair_integrity_pass']=pair_ok
        row['neutral_site']=g.get('neutral_site');row['conference_competition']=g.get('conference_competition');row['native_season_type']=r.get('season_type')
        row['venue_id']=g.get('venue_id');row['venue_city']=g.get('venue_address_city');row['venue_state']=g.get('venue_address_state');row['native_regulation_periods']=g.get('format_regulation_periods')
        member=membership.get((season,str(tid)));omember=membership.get((season,str(oppid)))
        row['d1_reference_match']=member is not None;row['opponent_d1_reference_match']=omember is not None;row['conference']=member.get('conference') if member else None
        vals=[r.get(k) for k in factors];ovals=[o.get(k) for k in factors] if pair_ok else []
        counts_ok=pair_ok and all(finite(x) for x in vals+ovals)
        poss=None
        if counts_ok:
            own=r['field_goals_attempted']-r['offensive_rebounds']+r['total_turnovers']+.44*r['free_throws_attempted']
            theirs=o['field_goals_attempted']-o['offensive_rebounds']+o['total_turnovers']+.44*o['free_throws_attempted']
            poss=(own+theirs)/2
        row['possessions_044_proxy']=poss
        row['off_rating_proxy']=safe(100*r['team_score'],poss) if finite(r.get('team_score')) else None
        row['def_rating_proxy']=safe(100*r['opponent_team_score'],poss) if finite(r.get('opponent_team_score')) else None
        row['efg_pct']=safe(r['field_goals_made']+.5*r['three_point_field_goals_made'],r['field_goals_attempted']) if all(finite(r.get(k)) for k in ['field_goals_made','three_point_field_goals_made','field_goals_attempted']) else None
        row['tov_pct_proxy']=safe(r.get('total_turnovers'),poss)
        row['fta_per_fga']=safe(r.get('free_throws_attempted'),r.get('field_goals_attempted'))
        row['three_pa_share']=safe(r.get('three_point_field_goals_attempted'),r.get('field_goals_attempted'))
        row['orb_pct']=safe(r['offensive_rebounds'],r['offensive_rebounds']+o['defensive_rebounds']) if counts_ok else None
        row['drb_pct']=safe(r['defensive_rebounds'],r['defensive_rebounds']+o['offensive_rebounds']) if counts_ok else None
        period=g.get('status_period');reg=g.get('format_regulation_periods')
        duration=40+5*(period-2) if reg==2 and finite(period) and period>=2 else None
        row['game_minutes_from_native_period_count']=duration;row['pace_per40_proxy']=safe(40*poss,duration) if poss is not None else None
        delta=r['team_score']-(2*r['field_goals_made']+r['three_point_field_goals_made']+r['free_throws_made']) if all(finite(r.get(k)) for k in ['team_score','field_goals_made','three_point_field_goals_made','free_throws_made']) else None
        row['scoring_reconciliation_delta']=delta
        if delta not in [0,None] or not pair_ok:quality.append({'season':season,'game_id':gid,'team_id':tid,'scoring_delta':delta,'pair_integrity_pass':pair_ok})
        features.append(row)
    write('team_game_measured_features',features)
    history=defaultdict(list);lags=[]
    lagkeys=['team_score','opponent_team_score','possessions_044_proxy','off_rating_proxy','def_rating_proxy','pace_per40_proxy','efg_pct','tov_pct_proxy','orb_pct','drb_pct','fta_per_fga','three_pa_share']
    for r in sorted(features,key=lambda r:(r['game_date_time'],r['game_id'],r['team_id'])):
        h=history[(r['season'],r['team_id'])];out={k:r[k] for k in ['season','game_id','team_id','opponent_team_id','game_date_time','neutral_site','conference_competition','d1_reference_match','opponent_d1_reference_match','conference']}
        out['prior_games']=len(h);out['days_since_previous_start']=(r['game_date_time']-h[-1]['game_date_time']).total_seconds()/86400 if h else None
        out['prior_distinct_opponents']=len({a['opponent_team_id'] for a in h})
        for w in [5,10,20]:
            sub=h[-w:];out[f'prior_{w}_games']=len(sub)
            assert all(a['game_id']!=r['game_id'] and a['game_date_time']<r['game_date_time'] for a in sub)
            for k in lagkeys:
                v=[a[k] for a in sub if finite(a.get(k))];out[f'prior_{w}_{k}_mean']=sum(v)/len(v) if v else None
        lags.append(out)
        # Flagged game measurements stay in raw tables; exclude from feature history.
        if r['pair_integrity_pass'] and r['scoring_reconciliation_delta']==0:h.append(r)
    write('team_pregame_features',lags)
    for year in years:
        players=read('espn_player_box_'+str(year));history=defaultdict(lambda:deque(maxlen=20));outrows=[]
        pcounts=Counter((p['game_id'],p['athlete_id']) for p in players if p.get('athlete_id'))
        keys=['points','rebounds','assists','field_goals_attempted','three_point_field_goals_attempted','free_throws_attempted','turnovers']
        for r in sorted(players,key=lambda r:(r['game_date_time'],r['game_id'],r['athlete_id'] or -1)):
            pid=r['athlete_id'];h=list(history[pid]) if pid else []
            out={k:r.get(k) for k in ['season','game_id','team_id','athlete_id','game_date_time']}
            unique_identity=bool(pid) and pcounts[(r['game_id'],pid)]==1
            out['player_game_identity_unique']=unique_identity
            for w in [5,10,20]:
                sub=h[-w:];out[f'prior_{w}_positive_minute_games']=len(sub)
                out[f'prior_{w}_mean_minutes']=sum(a['minutes'] for a in sub)/len(sub) if sub else None
                out[f'prior_{w}_different_team_games']=sum(a['team_id']!=r['team_id'] for a in sub)
                assert all(a['game_id']!=r['game_id'] and a['game_date_time']<r['game_date_time'] and a['minutes']>0 for a in sub)
                for k in keys:
                    valid=[a for a in sub if finite(a.get(k))];out[f'prior_{w}_{k}_pooled_per40']=safe(40*sum(a[k] for a in valid),sum(a['minutes'] for a in valid))
            outrows.append(out)
            if unique_identity and finite(r.get('minutes')) and r['minutes']>0 and r.get('did_not_play') is not True:history[pid].append(r)
        write('player_pregame_features_'+str(year),outrows)
    old=json.loads((R/'sources/inventory.json').read_text());names={r['table'] for r in ADDED}
    (R/'sources/inventory.json').write_text(json.dumps([r for r in old if r['table'] not in names]+ADDED,indent=2))
    (R/'sources/FEATURE_METHODS.json').write_text(json.dumps({'possession_fta_coefficient':.44,'warning':'Generic boxscore proxy, not a fitted NCAA possession estimator.','regulation_minutes':40,'regulation_periods':2,'overtime_minutes':5,'team_lags':'Arithmetic means, within season, prior valid games only. Not opponent-adjusted.','player_lags':'Pooled counts per40 minutes, prior positive-minute games only, within season; unknown IDs not linked.','quality_exclusions':quality,'historical_known_at':'Unavailable. Prior tipoff order alone is not publication-time certification.','checks':['Source numeric scoring reconciliation flagged','Current/future games excluded from lag windows','Zero-minute/DNP/unknown-identity histories excluded','Exact derived-table encoding equality']},indent=2))
    print('FEATURES',[(r['table'],r['rows'],r['bytes']) for r in ADDED], 'quality flags',len(quality),flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--player-seasons',type=int,nargs='+',default=[2026]);main(p.parse_args().player_seasons)
