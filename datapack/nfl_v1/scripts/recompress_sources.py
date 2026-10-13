#!/usr/bin/env python3
"""Lossless re-encoding only: retain all columns, types, nulls and values."""
import pathlib,pyarrow.parquet as pq,json,hashlib
R=pathlib.Path(__file__).resolve().parents[1]
changes=[]
for p in sorted((R/'data').glob('*.parquet')):
 before=p.stat().st_size;oldhash=hashlib.sha256(p.read_bytes()).hexdigest();t=pq.read_table(p)
 if t.num_rows==0:
  changes.append({'file':'data/'+p.name,'status':'empty_source_no_observations','rows':0,'columns':t.num_columns});continue
 temp=p.with_suffix('.tmp.parquet');pq.write_table(t,temp,compression='zstd',compression_level=19,use_dictionary=True,row_group_size=max(1,t.num_rows),write_statistics=True)
 check=pq.read_table(temp)
 assert t.equals(check,check_metadata=False),p.name
 if temp.stat().st_size<before:temp.replace(p)
 else:temp.unlink()
 changes.append({'file':'data/'+p.name,'rows':t.num_rows,'columns':t.num_columns,'source_download_bytes':before,'source_download_sha256':oldhash,'delivered_bytes':p.stat().st_size,'delivered_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'status':'lossless_value_equality_verified'})
 print(p.name,t.num_rows,t.num_columns,round(before/1e6,2),'->',round(p.stat().st_size/1e6,2),'MB',flush=True)
(R/'sources/LOSSLESS_REENCODING.json').write_text(json.dumps(changes,indent=2))
