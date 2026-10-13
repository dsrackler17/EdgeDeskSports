import pathlib,sys,json,csv,gzip,concurrent.futures,datetime as dt
R=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(R/'scripts'));import collect as c
# Expand NHL detail sample and collect college baseball on explicit historical dates.
nj=json.loads((R/'sources/download_manifest.json').read_text());original=nj['files']
c.SPORTS={'nhl':('hockey/nhl',['202410','202411','202412','202501','202502','202503','202504','202505','202506']),
'college_baseball':('baseball/college-baseball',[f'202406{i:02}' for i in range(1,25)]+['20240216','20240315','20240412','20240517'])}
# Reuse collector but increase NHL sampled summaries to 72 through a copied function source.
import inspect
src=inspect.getsource(c.espn).replace('min(12,len(completed))','min(72 if sport==\'nhl\' else 12,len(completed))').replace("if sport.startswith('cbb') or sport=='college_baseball':u+='&groups=50'","if sport.startswith('cbb'):u+='&groups=50'")
exec(src,c.__dict__)
with concurrent.futures.ThreadPoolExecutor(2) as ex:
 for f in [ex.submit(c.espn,s) for s in c.SPORTS]:
  try:f.result()
  except Exception as e:print(e,flush=True)
# Correct tennis draws: each ESPN tour response can contain both men's and women's competitions.
for tour,slug in [('atp','mens-singles'),('wta','womens-singles')]:
 rows=[]
 for p in (R/f'data/tennis_{tour}/raw').glob('scoreboard*.gz'):
  j=json.loads(gzip.decompress(p.read_bytes()))
  for e in j.get('events',[]):
   for group in e.get('groupings',[]):
    if group.get('grouping',{}).get('slug')!=slug:continue
    for match in group.get('competitions',[]):
     cs=match.get('competitors',[])
     if len(cs)!=2:continue
     a,b=cs
     rows.append({'match_id':match.get('id'),'tournament_id':e.get('id'),'tournament':e.get('name'),'draw_type':slug,'date':match.get('date') or e.get('date'),'round':match.get('round',{}).get('displayName'),'best_of':match.get('format',{}).get('regulation',{}).get('periods'),'player_a_id':a.get('id'),'player_a':a.get('athlete',{}).get('displayName'),'player_b_id':b.get('id'),'player_b':b.get('athlete',{}).get('displayName'),'a_score':a.get('score'),'b_score':b.get('score'),'a_winner':a.get('winner'),'b_winner':b.get('winner'),'status':match.get('status',{}).get('type',{}).get('name'),'a_sets_json':json.dumps(a.get('linescores',[])),'b_sets_json':json.dumps(b.get('linescores',[])),'a_statistics_json':json.dumps(a.get('statistics',[])),'b_statistics_json':json.dumps(b.get('statistics',[])),'retrieved_at':c.NOW,'known_at':''})
 unique={x['match_id']:x for x in rows};c.write_csv(f'data/tennis_{tour}/matches_sample.csv',unique.values());print(tour,len(unique),'singles matches',flush=True)
# UFC event cards contain bout competition records; retain factual result/statistics fields.
rows=[];statistics=[]
for month in [f'2024{i:02}' for i in range(1,13)]:
 try:j=c.fetch(f'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={month}&limit=1000',f'data/ufc/raw/scoreboard_{month}.json.gz')
 except Exception as e:print('ufc',e,flush=True);continue
 for e in j.get('events',[]):
  for match in e.get('competitions',[]):
   cs=match.get('competitors',[])
   if len(cs)!=2:continue
   a,b=cs
   rows.append({'bout_id':match.get('id'),'event_id':e['id'],'event_name':e['name'],'start_time':match.get('date') or e.get('date'),'fighter_a_id':a.get('id'),'fighter_a':a.get('athlete',{}).get('displayName'),'fighter_b_id':b.get('id'),'fighter_b':b.get('athlete',{}).get('displayName'),'a_winner':a.get('winner'),'b_winner':b.get('winner'),'status':match.get('status',{}).get('type',{}).get('name'),'status_detail':match.get('status',{}).get('type',{}).get('detail'),'round':match.get('status',{}).get('period'),'clock':match.get('status',{}).get('displayClock'),'format_json':json.dumps(match.get('format',{})),'retrieved_at':c.NOW,'known_at':''})
   for x in cs:
    for stat in x.get('statistics',[]):statistics.append({'bout_id':match.get('id'),'fighter_id':x.get('id'),'stat':stat.get('name'),'value':stat.get('displayValue') or stat.get('value'),'retrieved_at':c.NOW,'known_at':''})
unique={x['bout_id']:x for x in rows};c.write_csv('data/ufc/bouts_2024.csv',unique.values());c.write_csv('data/ufc/fighter_statistics_sample.csv',statistics);print('UFC',len(unique),'bouts',len(statistics),'statistics',flush=True)
(R/'sources/supplement_download_manifest.json').write_text(json.dumps({'retrieved_at':c.NOW,'request_count':c.REQUESTS,'files':c.LOG},indent=2))
