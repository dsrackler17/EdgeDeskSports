"""Verify delivered parquet tables, document fields and create a <30MB ZIP."""
from pathlib import Path
import csv,hashlib,json,zipfile
import pyarrow.parquet as pq
import pyarrow.compute as pc
R=Path(__file__).resolve().parents[1]
inventory=json.loads((R/'sources/inventory.json').read_text())
dictionary=[]
for entry in inventory:
    p=R/'data'/(entry['table']+'.parquet');t=pq.read_table(p)
    assert t.num_rows==entry['rows']
    assert hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256']
    for name in t.column_names:
        col=t[name];nulls=col.null_count
        dictionary.append({'table':entry['table'],'field':name,'storage_type':str(col.type),'rows':t.num_rows,'null_rows':nulls,'non_null_rows':t.num_rows-nulls})
(R/'sources/field_inventory.json').write_text(json.dumps(dictionary,indent=2))
g=pq.read_table(R/'data/games.parquet').to_pylist()
summary={}
for r in g:summary[r['season_type']]=summary.get(r['season_type'],0)+1
coverage=json.loads((R/'COVERAGE.json').read_text());coverage['native_season_type_counts']=summary
coverage['competition_scope_counts']={}
for r in g:coverage['competition_scope_counts'][r['scope']]=coverage['competition_scope_counts'].get(r['scope'],0)+1
regular=[r for r in g if r['scope']=='regular_season']
counts={}
for r in regular:
    for k in ['home_id','away_id']:counts[r[k]]=counts.get(r[k],0)+1
assert len(regular)==1230 and len(counts)==30 and all(v==82 for v in counts.values())
periods=pq.read_table(R/'data/period_scores.parquet').to_pylist();sums={}
for p in periods:
    key=(p['game_id'],p['team_id']);sums[key]=sums.get(key,0)+float(p['points'])
for r in g:
    for side in ['home','away']:
        key=(r['game_id'],r[side+'_id'])
        assert sums[key]==float(r[side+'_score']),(key,sums[key],r[side+'_score'])
coverage['checks']+=['1230 regular-season games; 82 per club','all period score sums equal final scoreboard scores']
primary=pq.read_table(R/'data/play_by_play.parquet',columns=['game_id']).column(0).to_pylist()
detail_ids=set(primary)
if (R/'data/core_supplement_plays.parquet').exists():
    supplemental=set(pq.read_table(R/'data/core_supplement_plays.parquet',columns=['game_id']).column(0).to_pylist())
    assert not (detail_ids & supplemental),'Core/site detail overlap requires source priority'
    detail_ids |= supplemental
coverage['games_with_play_by_play_including_supplement']=len(detail_ids)
coverage['game_ids_without_play_by_play']=sorted(set(r['game_id'] for r in g)-detail_ids)
coverage['limitations']=['No historical odds or availability feed','No historical publication timestamps','Native shot coordinate frame unverified','Possessions and true shooting are .44-FTA proxies','Extended schemas are unpopulated specifications','Missing detailed game records listed explicitly','Single season only; no model profitability claim']
(R/'COVERAGE.json').write_text(json.dumps(coverage,indent=2))
z=R.parent/(R.name+'.zip')
staging=R.parent/(R.name+'.verified-staging.zip')
with zipfile.ZipFile(staging,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as f:
    for p in sorted(R.rglob('*')):
        if p.is_file() and '__pycache__' not in p.parts:f.write(p,p.relative_to(R.parent))
with zipfile.ZipFile(staging) as f:assert f.testzip() is None
assert staging.stat().st_size<30_000_000,staging.stat().st_size
staging.replace(z)
print(json.dumps({'file':str(z),'bytes':z.stat().st_size,'games':len(g),'tables':[(e['table'],e['rows']) for e in inventory]},indent=2))
