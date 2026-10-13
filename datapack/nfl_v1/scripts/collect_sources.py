#!/usr/bin/env python3
import pathlib,json,urllib.request,hashlib,datetime as dt,concurrent.futures
R=pathlib.Path(__file__).resolve().parents[1];NOW=dt.datetime.now(dt.timezone.utc).isoformat();meta=json.loads((R/'sources/RELEASE_ASSET_DISCOVERY.json').read_text());targets=[]
def add(tag,names):
 assets={x['name']:x for x in meta[tag]['assets']}
 for n in names:
  if n in assets:targets.append((tag,assets[n]))
add('pbp',[f'play_by_play_{y}.parquet' for y in [2025,2026]])
for tag,prefix in [('snap_counts','snap_counts'),('rosters','roster'),('weekly_rosters','roster_weekly'),('injuries','injuries'),('depth_charts','depth_charts')]:
 add(tag,[f'{prefix}_{y}.parquet' for y in [2024,2025,2026]])
add('player_stats',['stats_player_week_2024.parquet','player_stats_def_2024.parquet','player_stats_kicking_2024.parquet'])
add('pfr_advstats',[f'advstats_week_{kind}_{y}.parquet' for y in [2024,2025,2026] for kind in ['pass','rush','rec','def']])
add('nextgen_stats',['ngs_passing.parquet','ngs_receiving.parquet','ngs_rushing.parquet'])
print('Downloading',len(targets),'public assets; no paid feeds',flush=True)
def run(t):
 tag,a=t;out=R/'data'/a['name']
 try:
  with urllib.request.urlopen(a['url'],timeout=60) as r:b=r.read()
  out.write_bytes(b)
  return {'release':tag,'file':'data/'+out.name,'url':a['url'],'source_asset_updated_at':a['updated_at'],'retrieved_at':NOW,'known_at':None,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'status':'downloaded'}
 except Exception as e:return {'release':tag,'file':'data/'+out.name,'url':a['url'],'status':'failed','error':str(e)}
rows=[]
with concurrent.futures.ThreadPoolExecutor(4) as ex:
 for r in ex.map(run,targets):rows.append(r);print(r['file'],r['status'],r.get('bytes',''),flush=True)
(R/'sources/DOWNLOAD_MANIFEST.json').write_text(json.dumps({'retrieved_at':NOW,'records':rows},indent=2))
