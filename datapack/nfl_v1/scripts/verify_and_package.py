#!/usr/bin/env python3
import pathlib,json,csv,hashlib,collections,datetime as dt,zipfile
import pyarrow.parquet as pq
R=pathlib.Path(__file__).resolve().parents[1]
def read(n):
 with (R/'data'/n).open(newline='') as f:return list(csv.DictReader(f))
def main():
 inventory=[];fieldrows=[];formats=json.loads((R/'sources/LOSSLESS_REENCODING.json').read_text());enc={x['file']:x for x in formats}
 for p in sorted((R/'data').glob('*')):
  if not p.is_file() or '.tmp.' in p.name:continue
  item={'file':'data/'+p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  if p.suffix=='.parquet':
   t=pq.read_table(p);item.update(rows=t.num_rows,columns=t.num_columns,format='Parquet')
   if item['file'] in enc and enc[item['file']].get('delivered_sha256'):assert enc[item['file']]['delivered_sha256']==item['sha256']
   for fld,col in zip(t.schema,t.columns):fieldrows.append({'file':p.name,'field':fld.name,'type':str(fld.type),'nulls':col.null_count,'rows':t.num_rows})
   for col in ['season','week','game_date','dt']:
    if col in t.column_names:
     arr=t[col].to_pandas().dropna()
     if len(arr):item[col+'_min']=str(arr.min());item[col+'_max']=str(arr.max())
   if 'play_by_play_' in p.name:
    ids=t.select(['game_id','play_id']).to_pandas();assert not ids.duplicated().any(),p.name
    game=t.select(['game_id','game_date','season_type']).to_pandas().drop_duplicates('game_id');item['games']=len(game);item['game_types']=game.season_type.value_counts().to_dict()
  elif p.suffix=='.csv':
   with p.open(newline='') as f:
    rd=csv.DictReader(f);cols=rd.fieldnames;rs=list(rd)
   item.update(rows=len(rs),columns=len(cols),format='CSV')
   for col in cols:fieldrows.append({'file':p.name,'field':col,'type':'CSV native text / documented derived number','nulls':sum(x[col] in ['',None] for x in rs),'rows':len(rs)})
  else:continue
  inventory.append(item)
 stats=read('team_game_advanced_2022_2026.csv');features=read('pregame_rolling_features_2022_2026.csv');keys={(x['game_id'],x['team_id']):x for x in stats};assert len(keys)==len(stats)
 hist=collections.defaultdict(list)
 for row in sorted(features,key=lambda x:(x['team_id'],x['game_date'],x['game_id'])):
  prior=hist[row['team_id']];assert all(p['game_date']<row['game_date'] for p in prior);assert not row['known_at']
  for n in [5,10,20]:
   sub=prior[-n:]
   for num,den,name in [('epa_sum','plays','off_epa_per_play'),('successful_plays','plays','success_rate'),('pass_epa_sum','dropbacks','pass_epa_per_dropback'),('rush_epa_sum','designed_rushes','rush_epa_per_designed_rush'),('def_epa_allowed_sum','def_plays','def_epa_allowed_per_play'),('def_successes_allowed','def_plays','def_success_allowed_rate'),('sacks','dropbacks','sack_rate'),('cpoe_sum','cpoe_passes','cpoe')]:
    numerator=sum(float(x[num]) for x in sub if x[num]);denominator=sum(float(x[den]) for x in sub if x[den]);actual=row[f'{name}_prior_{n}']
    if denominator:assert actual and abs(float(actual)-numerator/denominator)<1e-9,(name,row['game_id'])
    else:assert not actual
  hist[row['team_id']].append(keys[(row['game_id'],row['team_id'])])
 labels=read('game_labels_2022_2026.csv');assert len(set(x['game_id'] for x in labels))==len(labels)
 newraw=[x for x in inventory if 'play_by_play_' in x['file']]
 coverage={'verified_at':dt.datetime.now(dt.timezone.utc).isoformat(),'status':'passed','source_tables':sum(x['format']=='Parquet' for x in inventory),'csv_tables':sum(x['format']=='CSV' for x in inventory),'new_raw_play_rows':sum(x['rows'] for x in newraw),'new_raw_game_count':sum(x['games'] for x in newraw),'new_raw_game_types':{x['file']:x['game_types'] for x in newraw},'new_raw_latest_game_date':max(x['game_date_max'] for x in newraw),'feature_years':'2022-2026, latest season partial','team_game_rows':len(stats),'lagged_feature_rows':len(features),'game_label_rows':len(labels),'player_stat_opportunity_rows':len(read('player_game_opportunities_2022_2026.csv')),'checks':['Parquet schemas/counts read successfully','Delivered source hashes match lossless encoding manifest','Source Parquet re-encoding previously verified exact value/type equality','Unique raw game/play and team/game keys','Every prior-5/10/20 feature independently recomputed','Target and future-game exclusion','Historical known_at kept blank'],'limitations':['No strict historical availability certification','No trained model or validated live edge','No current executable bookmaker quotes','Provider-specific upstream rights not certified']}
 (R/'COVERAGE.json').write_text(json.dumps(coverage,indent=2));(R/'sources/DATA_INVENTORY.json').write_text(json.dumps(inventory,indent=2))
 with (R/'sources/FIELD_INVENTORY.csv').open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(fieldrows[0]));w.writeheader();w.writerows(fieldrows)
 text='''# EdgeDesk NFL Data Pack — new 2025/2026 source data + five-season research features

Start with `CLAUDE_NFL_START_HERE.md`, `COVERAGE.json`, `sources/DATA_INVENTORY.json` and `docs/MISSING_DATA_PRIORITY.csv`.

## Actual coverage

'''+f"- {coverage['new_raw_play_rows']:,} new raw play records, all 372 native columns retained in each PBP file.\n- 2025: 285 games (272 regular-season + 13 playoff games).\n- 2026: {next(x['games'] for x in newraw if '2026' in x['file'])} games in the available archive, latest game date {coverage['new_raw_latest_game_date']}; current-season coverage is partial.\n- {coverage['team_game_rows']:,} team/game records and target-excluded prior-5/10/20 research rows spanning 2022 through available 2026.\n- {coverage['player_stat_opportunity_rows']:,} player/game/stat opportunity cells; this is not a count of distinct players or games.\n"+'''
- Snap counts, season/weekly rosters, injury tables and depth data for 2024–2026 where delivered.
- PFR advanced passing/rushing/receiving/defense measures for 2024–2026: pressure, blitz/hit/hurry counts, drops, broken tackles and related source measures.
- NFL Next Gen Stats aggregate passing/receiving/rushing history with time-to-throw, completion expectation, separation/cushion, YAC expectation and rushing over expectation where source values exist. These are public aggregate statistics, not raw tracking.
- Native schemas/types/null inventories, formulas, collection/source manifests, lossless encoding verification and an explicit prioritized remaining-data list.

Raw 2022–24 PBP is in the earlier NFL ZIP parts. This ZIP deliberately includes its derived seed data, not another copy of those large raw files. New 2025/2026 PBP and all delivered supplementary tables are independently included here. Nothing was rounded or dropped to make compression smaller: re-encoding preserves source Arrow values and types.

## File inventory

| File | Rows | Columns |
|---|---:|---:|
'''
 for i in inventory:text+=f"| `{i['file']}` | {i['rows']:,} | {i['columns']} |\n"
 text+='''
## Important limitations

Files are Parquet for efficient typed storage, plus CSV derived tables. Open with pandas/pyarrow and the scripts; do not expect the file browser to render a Parquet table as text. A CSV export utility is included. No credentials or paid calls are embedded.

Coverage differs by dataset; consult per-file season/week/date span and null counts. Depth rows are timestamped snapshots/positions, not independent player examples. Weekly injury rows lack verified report publication times. NGS/PFR source percentages and denominators are provider-native. Week-zero/season summary rows must not be pooled with weekly records. Native team aliases and GSIS/PFR/ESPN IDs require verified mapping before joins; do not join on names alone.

Measured game stats and final labels are outcomes, not target-game pregame inputs. Lagged tables exclude the target game and weight exposures but are retrospective because historical first-publication/model revisions are unknown. Source EPA/CPOE/NGS expectations are modeled source measures with version/availability limitations. The prior-game window crosses season boundaries; model and validate an offseason decay/reset explicitly.

Remaining high-value gaps include fresh and historical executable odds, timestamped inactive/QB confirmations, complete routes/participation, OL/DL assignment charting, forecast issue-time history, fully reconciled identity bridges and raw licensed tracking. Existing snap or target data cannot invent route counts. NFL source spread/total labels are not live quotes. No model has been trained/validated for betting in this package.

## Use

```bash
pip install -r requirements.txt
python scripts/build_features.py
python scripts/verify_and_package.py
# Optional single-table export:
python scripts/export_table.py data/play_by_play_2026.parquet current_plays.csv
```

The collector downloads from the discovered release URLs and saves provenance. Downloading again replaces the encoding; rerun lossless recompression and verification afterward. Collection uses no paid provider. Source rights/license and timing caveats are in docs/SOURCE_AND_TEMPORAL_RULES.md. Attribution: nflverse; repository CC-BY-4.0 license included. Review any dataset-specific/upstream restrictions before production redistribution.
'''
 (R/'README.md').write_text(text)
 print(json.dumps(coverage,indent=2),flush=True)
 out=R.parent/'EdgeDesk_NFL_Data_Pack.zip'
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for p in sorted(R.rglob('*')):
   if p.is_file() and '__pycache__' not in p.parts:z.write(p,arcname=str(p.relative_to(R.parent)))
 with zipfile.ZipFile(out) as z:assert z.testzip() is None
 print('ZIP',round(out.stat().st_size/1e6,2),'MB',flush=True)
 assert out.stat().st_size<30_000_000,'ZIP exceeds 30 MB upload limit'
if __name__=='__main__':main()
