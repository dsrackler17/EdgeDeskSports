"""Audit actual coverage, native missingness and reconstructed-source discrepancies.
Creates three ordinary ZIPs, each <30,000,000 bytes, using atomic finalization.
"""
import datetime as dt,hashlib,json,zipfile,zlib
from pathlib import Path
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
R=Path(__file__).resolve().parents[1];D=R/'data'
inv=json.loads((R/'sources/inventory.json').read_text());report={'scope':'Men\u2019s NCAA Division I-oriented public archives; includes games against opponents outside the D1 reference. Not an assertion that every source row is D1-v-D1.','seasons':[2024,2025,2026],'source_tables':{},'checks':[],'limitations':[]}
fields=[]
for x in inv:
    p=R/x['file'];assert hashlib.sha256(p.read_bytes()).hexdigest()==x['delivered_sha256'],p.name
    t=pq.read_table(p);assert t.num_rows==x['rows']
    for n in t.column_names:
        c=t[n];fields.append({'table':x['table'],'field':n,'type':str(c.type),'rows':len(c),'null_rows':c.null_count,'non_null_rows':len(c)-c.null_count})
    report['source_tables'][x['table']]={'rows':t.num_rows,'fields':t.num_columns,'bytes':p.stat().st_size}
del t
(R/'sources/field_inventory.json').write_text(json.dumps(fields,indent=2))
def read(name,columns=None):return pq.read_table(D/(name+'.parquet'),columns=columns).to_pandas()
def identity_int(s):return pd.to_numeric(s,errors='coerce').astype('Int64')
season_reports={};diffs=[]
for y in [2024,2025,2026]:
    team=read('espn_team_box_'+str(y));players=read('espn_player_box_'+str(y));sched=read('espn_mbb_schedule_'+str(y))
    schedule_duplicates=int(sched.duplicated(['game_id']).sum());team_duplicates=int(team.duplicated(['game_id','team_id']).sum())
    complete=sched[sched['status_type_completed']==True];box_games=set(team.game_id)
    season_reports[str(y)]={'schedule_games':len(sched),'completed_schedule_games':len(complete),'team_box_games':team.game_id.nunique(),'team_box_rows':len(team),'player_box_rows':len(players),'player_box_games':players.game_id.nunique(),'schedule_duplicate_keys':schedule_duplicates,'team_duplicate_keys':team_duplicates,'completed_schedule_ids_without_team_boxes':sorted(set(complete.game_id)-box_games),'team_game_rows_missing_datetime':int(team.game_date_time.isna().sum()),'player_rows_missing_athlete_id':int(players.athlete_id.isna().sum()),'player_duplicate_known_identity_rows':int(players[players.athlete_id.notna()].duplicated(['game_id','athlete_id']).sum()),'team_game_group_size_counts':team.groupby('game_id').size().value_counts().to_dict()}
    ncaa=read('ncaa_mbb_team_box_'+str(y));ncaa['game_id_join']=identity_int(ncaa.espn_game_id);ncaa['team_id_join']=identity_int(ncaa.team_espn_team_id)
    team_valid=team[~team.duplicated(['game_id','team_id'],keep=False)]
    joined=ncaa.merge(team_valid,on=None,left_on=['game_id_join','team_id_join'],right_on=['game_id','team_id'],how='left',suffixes=('_ncaa','_espn'),indicator=True)
    comparisons={'pts':'team_score','fgm':'field_goals_made','fga':'field_goals_attempted','tpm':'three_point_field_goals_made','tpa':'three_point_field_goals_attempted','ftm':'free_throws_made','fta':'free_throws_attempted'}
    mismatched=np.zeros(len(joined),dtype=bool);deltas={}
    for a,b in comparisons.items():
        delta=pd.to_numeric(joined[a],errors='coerce')-pd.to_numeric(joined[b],errors='coerce');bad=delta.notna() & (delta.abs()>1e-8);mismatched|=bad.to_numpy();deltas[a+'_delta']=delta
    season_reports[str(y)]['ncaa_team_rows']=len(ncaa);season_reports[str(y)]['ncaa_team_rows_with_espn_match']=int((joined['_merge']=='both').sum());season_reports[str(y)]['ncaa_vs_espn_scoring_shooting_discrepant_rows']=int(mismatched.sum())
    for idx in np.flatnonzero(mismatched):
        row=joined.iloc[idx];d={'season':y,'contest_id':str(row.contest_id),'espn_game_id':int(row.game_id_join) if pd.notna(row.game_id_join) else None,'espn_team_id':int(row.team_id_join) if pd.notna(row.team_id_join) else None}
        d.update({k:float(v.iloc[idx]) if pd.notna(v.iloc[idx]) else None for k,v in deltas.items()});diffs.append(d)
report['seasons_coverage']=season_reports
if diffs:
    t=pa.Table.from_pylist(diffs);p=D/'audit_source_discrepancies.parquet';pq.write_table(t,p,compression='zstd',compression_level=19)
    inv=[x for x in inv if x['table']!=p.stem]+[{'table':p.stem,'file':'data/'+p.name,'rows':t.num_rows,'columns':t.column_names,'bytes':p.stat().st_size,'delivered_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'source_tag':'Cross-source audit, not new observations'}]
lineups=read('ncaa_mbb_lineups_2026');slots=['player_'+str(i) for i in range(1,6)]
report['lineup_quality']={'rows':len(lineups),'contests':lineups.contest_id.nunique(),'publisher_player_count_error_null_rows':int(lineups.player_count_error.isna().sum()),'rows_without_five_distinct_nonnull_names':int((lineups[slots].nunique(axis=1,dropna=True)!=5).sum()),'negative_duration_rows':int((lineups.duration_mins<0).sum()),'zero_duration_rows':int((lineups.duration_mins==0).sum()),'end_start_duration_discrepancy_rows':int(((lineups.end_min-lineups.start_min-lineups.duration_mins).abs()>1e-7).sum()),'warning':'Name/clock checks do not independently establish correct player identity, inferred substitutions or true exposure. Null QA flags are unknown, not passes.'}
del lineups
stints=read('ncaa_mbb_matchup_stints_2026')
report['matchup_stint_quality']={'rows':len(stints),'contests':stints.contest_id.nunique(),'duplicate_contest_stint_keys':int(stints.duplicated(['contest_id','game_stint_num']).sum()),'negative_duration_rows':int((stints.duration_seconds<0).sum()),'duration_reconciliation_failure_rows':int(((stints.end_seconds-stints.start_seconds-stints.duration_seconds).abs()>1e-7).sum())}
del stints
poss=read('ncaa_mbb_possessions_2026',columns=['contest_id','period','poss_num','espn_game_id','pts','home_ncaa_team_id','away_ncaa_team_id'])
report['possession_quality']={'rows':len(poss),'contests':poss.contest_id.nunique(),'duplicate_contest_period_possession_keys':int(poss.duplicated(['contest_id','period','poss_num']).sum()),'missing_espn_crosswalk_rows':int(poss.espn_game_id.isna().sum()),'period_counts':poss.period.value_counts().to_dict(),'warning':'Periods 1 and 2 are halves; 3+ are overtime. Publisher reconstructed possessions are not independently certified official counts.'}
del poss
shots=read('espn_shots_2026',columns=['game_id','scoring_play','score_value','coordinate_x','coordinate_y','athlete_id_1'])
report['shot_quality']={'rows':len(shots),'games':shots.game_id.nunique(),'nonscoring_rows_with_positive_score_value':int(((shots.scoring_play==False)&(shots.score_value>0)).sum()),'coordinate_missing_rows':int((shots.coordinate_x.isna()|shots.coordinate_y.isna()).sum()),'primary_actor_missing_rows':int(shots.athlete_id_1.isna().sum()),'warning':'score_value can be positive on missed shots: never sum it as actual scored points without scoring_play and event validation. Transformed and raw coordinate systems require verification.'}
report['checks']=['Release bytes checked against source sizes/hashes','Native source tables preserved by exact-value Parquet recompression','Delivered file hashes/row counts checked','Prior team/player windows assert target/future exclusion','DNP and zero-minute/ambiguous-player rows excluded from rate history','Native coverage, missingness and reconstructed-source QA reported','Each final ZIP CRC-tested and smaller than 30,000,000 bytes']
report['limitations']=['No executable odds feed or bet settlement archive','Historical first-publication timestamps absent','No confirmed historical injury/availability/starting-lineup feed','Roster tables are name-based observed-participation summaries, not verified registration or current eligibility','NCAA detailed tables and RAPM are publisher-derived; use discrepancy and QA gates','Final-season RAPM/rankings/records may leak future games if used as historical pregame predictors','No guaranteed D1-v-D1 coverage; reference matches and source coverage are explicit','No full play-by-play event-text archive in this bundle; detailed shots, possessions and stints are supplied','No independent model profit/calibration claim']
(R/'sources/inventory.json').write_text(json.dumps(inv,indent=2,default=str))
(R/'COVERAGE.json').write_text(json.dumps(report,indent=2,default=lambda x:int(x) if isinstance(x,np.integer) else str(x)))
part_files={1:[],2:[],3:[]}
for p in D.glob('*.parquet'):
    if p.stem in ['ncaa_mbb_lineups_2026','ncaa_mbb_matchup_stints_2026','ncaa_mbb_player_box_2026']:part=2
    elif p.stem in ['ncaa_mbb_possessions_2026','espn_shots_2026','player_pregame_features_2026']:part=3
    else:part=1
    part_files[part].append(p)
sizes={p:len(zlib.compress(p.read_bytes(),9))+len(p.name)*2+200 for p in D.glob('*.parquet')}
# Leave room for shared documentation and ZIP directory entries. Move complete
# files only if needed; preserve all source fields and records.
budget=29_500_000
while any(sum(sizes[p] for p in v)>budget for v in part_files.values()):
    over=max(part_files,key=lambda k:sum(sizes[p] for p in part_files[k]))
    moved=False
    for target in sorted(part_files,key=lambda k:sum(sizes[p] for p in part_files[k])):
        if target==over:continue
        for p in sorted(part_files[over],key=lambda p:sizes[p]):
            if sum(sizes[q] for q in part_files[target])+sizes[p]<=budget:
                part_files[over].remove(p);part_files[target].append(p);moved=True;break
        if moved:break
    if not moved:
        # Balance full files when the preferred thematic grouping cannot fit.
        # All parts are required; PARTS.json supplies their authoritative index.
        part_files={1:[],2:[],3:[]}
        for p in sorted(sizes,key=lambda p:sizes[p],reverse=True):
            target=min(part_files,key=lambda k:sum(sizes[q] for q in part_files[k]))
            part_files[target].append(p)
        assert all(sum(sizes[p] for p in v)<=budget for v in part_files.values()),'Three-part budget exceeded; no data removed'
        break
layout={str(k):[str(p.relative_to(R)) for p in sorted(v)] for k,v in part_files.items()}
(R/'PARTS.json').write_text(json.dumps({'extract_all_parts_into_same_parent':True,'parts':layout},indent=2))
docs=[p for p in R.rglob('*') if p.is_file() and 'data' not in p.relative_to(R).parts and '__pycache__' not in p.parts]
result=[]
for part,files in part_files.items():
    name=f'EdgeDesk_College_Basketball_0{part}.zip';final=R.parent/name;tmp=final.with_suffix('.staging.zip')
    with zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(files+docs):z.write(p,p.relative_to(R.parent))
    with zipfile.ZipFile(tmp) as z:assert z.testzip() is None
    assert tmp.stat().st_size<30_000_000,(part,tmp.stat().st_size)
    tmp.replace(final);result.append({'file':str(final),'bytes':final.stat().st_size,'data_files':len(files)})
(R.parent/'quant_build/cbb_package_result.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'parts':result,'quality':{k:report[k] for k in ['lineup_quality','matchup_stint_quality','possession_quality','shot_quality']}},indent=2,default=str))
