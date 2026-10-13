#!/usr/bin/env python3
"""Offline structural, factual-count, lineage and NFL lag verification."""
import csv,gzip,hashlib,json,pathlib,sqlite3,sys,collections,datetime
R=pathlib.Path(__file__).resolve().parents[1]
def require(condition,message):
 if not condition:raise AssertionError(message)
def rows(path):
 p=R/path
 if str(p).endswith('.gz'):
  with gzip.open(p,'rt',newline='') as f:return list(csv.DictReader(f))
 with p.open(newline='') as f:return list(csv.DictReader(f))
def main():
 inventory=json.loads((R/'DATA_INVENTORY.json').read_text());counts={}
 for i in inventory:
  p=R/i['file'];require(hashlib.sha256(p.read_bytes()).hexdigest()==i['sha256'],f"Digest mismatch {p.name}")
  rr=rows(i['file']);require(len(rr)==i['rows'],f"Count mismatch {p.name}");counts[i['file']]=len(rr)
  require(len(rr[0])==i['columns'] if rr else True,f"Column mismatch {p.name}")
  for row in rr:
   if 'known_at' in row:require(not row['known_at'],'Unexpected historical known_at; this package does not reconstruct first publication')
 tables=json.loads((R/'schemas/table_catalog.json').read_text())
 names=[(t['family'],t['table']) for t in tables];require(len(names)==len(set(names)),'Duplicate contract table')
 for t in tables:
  fields=[x['field'] for x in t['columns']];require(len(fields)==len(set(fields)),f"Duplicate column {t['family']}/{t['table']}")
  schema=json.loads((R/f"schemas/{t['family']}/{t['table']}.schema.json").read_text());require(set(fields)==set(schema['properties']),'JSON Schema mismatch')
 db=sqlite3.connect(':memory:');db.executescript((R/'schemas/create_research_contracts_sqlite.sql').read_text());require(db.execute("select count(*) from sqlite_master where type='table'").fetchone()[0]==len(tables),'SQL table count mismatch');db.close()
 # Independently recompute all prior-5/10/20 feature numerators and denominators from team-game stats.
 stats=rows('data/nfl/team_game_advanced_2022_2024.csv');features=rows('data/nfl/pregame_rolling_features_2022_2024.csv');bykey={(x['game_id'],x['team_id']):x for x in stats};history=collections.defaultdict(list)
 for row in sorted(features,key=lambda x:(x['team_id'],x['game_date'],x['game_id'])):
  prior=history[row['team_id']]
  for window in [5,10,20]:
   earlier=prior[-window:];require(all(p['game_date']<row['game_date'] for p in earlier),'Future/same-date game entered prior features')
   for numerator,denominator,name in [('epa_sum','plays','off_epa_per_play'),('successful_plays','plays','success_rate'),('pass_epa_sum','dropbacks','pass_epa_per_dropback'),('rush_epa_sum','designed_rushes','rush_epa_per_designed_rush'),('def_epa_allowed_sum','def_plays','def_epa_allowed_per_play'),('def_successes_allowed','def_plays','def_success_allowed_rate'),('sacks','dropbacks','sack_rate'),('cpoe_sum','cpoe_passes','cpoe')]:
    n=sum(float(x[numerator]) for x in earlier if x[numerator]);d=sum(float(x[denominator]) for x in earlier if x[denominator]);actual=row[f'{name}_prior_{window}']
    if d:require(actual and abs(float(actual)-n/d)<1e-9,f'Incorrect lag feature {name}')
    else:require(not actual,f'Empty exposure generated a value for {name}')
  history[row['team_id']].append(bykey[(row['game_id'],row['team_id'])])
 nhl=rows('data/nhl/shot_attempts_sample.csv');require(all(not x['xg'] for x in nhl),'Missing xG was invented');require(len(set((x['game_id'],x['event_id']) for x in nhl))==len(nhl),'Duplicate NHL event IDs')
 for tour,slug in [('atp','mens-singles'),('wta','womens-singles')]:
  tr=rows(f'data/tennis_{tour}/matches_sample.csv');require(all(x['draw_type']==slug for x in tr),'Mixed tennis draws');require(len({x['match_id'] for x in tr})==len(tr),'Duplicate tennis matches')
 for manifest in ['download_manifest.json','supplement_download_manifest.json','ufc_download_manifest.json','unified_download_manifest.json']:
  j=json.loads((R/'sources'/manifest).read_text())
  for e in j['files']:
   p=R/e['file']
   if p.exists() and e.get('sha256'):require(hashlib.sha256(p.read_bytes()).hexdigest()==e['sha256'],f'Source digest mismatch {p}')
 report={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed','datasets':len(inventory),'contract_tables':len(tables),'checks':['CSV counts and SHA256','Unique contract tables and columns','Valid JSON parsing and schema property correspondence','SQLite DDL execution','Every NFL prior-5/10/20 feature independently recomputed','Target-event and same-day exclusion','No invented NHL xG','Tennis singles separation and match uniqueness','Source manifest SHA256'],'limitations':['Not strict historical availability certification','Not source licensing certification','Not model predictive validation','No current odds or live betting edge assessed'],'counts':counts}
 (R/'VERIFICATION.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='counts'},indent=2))
if __name__=='__main__':main()
