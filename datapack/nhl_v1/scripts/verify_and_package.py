#!/usr/bin/env python3
import pathlib,csv,json,hashlib,collections,datetime as dt,zipfile
R=pathlib.Path(__file__).resolve().parents[1]
def read(n):
 with (R/'data'/n).open(newline='') as f:return list(csv.DictReader(f))
def verify():
 inventory=[];fields=[]
 for p in sorted((R/'data').glob('*.csv')):
  with p.open(newline='') as f:
   reader=csv.DictReader(f);names=reader.fieldnames;rows=0;nonempty=collections.Counter()
   for r in reader:
    rows+=1
    for k,v in r.items():
     if v not in ['',None]:nonempty[k]+=1
  inventory.append({'file':'data/'+p.name,'rows':rows,'columns':len(names),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
  for n in names:fields.append({'file':p.name,'native_field':n,'observed_rows':nonempty[n],'missing_rows':rows-nonempty[n],'interpretation':'Provider-native or explicitly named engineered field; see README for units and temporal limits.'})
 games=read('games.csv');ids={x['game_id'] for x in games};assert len(ids)==len(games)
 excluded={'47842','47836','47838','47844'};assert all(x['home_id'] not in excluded and x['away_id'] not in excluded for x in games)
 teams={x[k] for x in games for k in ['home_id','away_id']};assert len(teams)==32
 players=read('player_game_boxscores.csv');assert len({(x['game_id'],x['team_id'],x['player_id']) for x in players})==len(players)
 shots=read('shot_attempts.csv');assert len({(x['game_id'],x['event_id']) for x in shots})==len(shots);assert all(not s['xg'] for s in shots)
 assert all(s['game_id'] in ids for s in shots)
 features=read('pregame_lagged_research_features.csv');measured=read('team_game_measured_features.csv');index={(x['game_id'],x['team_id']):x for x in measured};history=collections.defaultdict(list)
 for r in sorted(features,key=lambda x:(x['start_time'],x['game_id'],x['team_id'])):
  prior=history[r['team_id']];assert all(x['start_time']<r['start_time'] for x in prior)
  for n in [5,10,20]:
   subset=prior[-n:];assert int(r[f'games_exposure_prior_{n}'])==len(subset)
   for f,a,name in [('all_nonshootout_attempts_for','all_nonshootout_attempts_against','corsi_share'),('all_unblocked_for','all_unblocked_against','fenwick_share')]:
    num=sum(int(x[f]) for x in subset);den=num+sum(int(x[a]) for x in subset);v=r[f'{name}_prior_{n}'];assert abs(float(v)-num/den)<1e-10 if den else not v
  history[r['team_id']].append(index[(r['game_id'],r['team_id'])])
 raw=read('goalie_game_measured_features.csv');assert all(not x['gsax'] and not x['expected_goals_against'] for x in raw)
 report={'verified_at':dt.datetime.now(dt.timezone.utc).isoformat(),'status':'passed','nhl_clubs':len(teams),'games':len(games),'season_type_counts':dict(collections.Counter(x['season_type_native'] for x in games)),'shot_attempts':len(shots),'events':next(i['rows'] for i in inventory if i['file']=='data/events.csv'),'player_game_rows':len(players),'goalie_game_rows':len(raw),'csv_datasets':len(inventory),'inventory':inventory,'checks':['File counts and hashes','32-club scope; national tournaments excluded','Unique games, shot events and player/game rows','All shot records point to delivered games','Every prior-5/10/20 Corsi/Fenwick ratio independently recomputed','No target or future event in lagged features','Missing xG/GSAx retained, never fabricated'],'limitations':['Not source rights certification','Not strict historical availability certification','Not model validation','Coordinate units and exact manpower not established']}
 (R/'COVERAGE.json').write_text(json.dumps(report,indent=2))
 with (R/'sources/OBSERVED_FIELD_DICTIONARY.csv').open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(fields[0]));w.writeheader();w.writerows(fields)
 print(json.dumps({k:v for k,v in report.items() if k not in ['inventory']},indent=2))
 return report

def finish():
 report=verify();inv=report['inventory']
 text='''# EdgeDesk NHL Data Pack — 2024–25 club research data

This is an NHL-only package, expanded beyond the original 72-game sample. Begin with `CLAUDE_NHL_START_HERE.md`, `COVERAGE.json` and `docs/MISSING_DATA_PRIORITY.csv`.

## Real data included

'''+f"- {report['games']:,} completed NHL club games: regular-season and playoff types shown in COVERAGE.json.\n- {report['events']:,} native play events and {report['shot_attempts']:,} extracted shot attempts.\n- {report['player_game_rows']:,} deduplicated player/game box records and {report['goalie_game_rows']:,} goalie/game records.\n"+'''
- Game results, venue labels, attendance and available official/referee fields.
- Native team and player box measures, TOI parsed to seconds, shot participants/coordinates, strength labels and shot-type extraction from event descriptions.
- Measured team shot share and goalie save metrics; prior-5/10/20-game shot-share, goals and workload features with target-event exclusion.
- NHL/shared canonical JSON Schemas, formulas, source manifest, field missingness inventory and an exact prioritized list of remaining inputs.

## Files and grain

| File | Rows | Columns |
|---|---:|---:|
'''
 for i in inv:text+=f"| `{i['file']}` | {i['rows']:,} | {i['columns']} |\n"
 text+='''
## Critical interpretation rules

This archive is historical, not live. It is not a trained/validated betting model. The 2024–25 regular-season count is reconciled to the expected 1,312 club games where delivered; playoff and failed-response counts are shown separately. A feed query alone does not prove complete coverage of every statistic. National-team Four Nations events are excluded from the completed club dataset; schedule_all_statuses.csv retains the broader source schedule for auditing.

On blocked shots the native event team can be the defending team. Use `shooting_team_id` resolved from shooter IDs, with `shooting_team_mapping_method` and nulls kept explicitly. Never sum all native team IDs into Corsi without checking this mapping. Multiple assister roles are preserved in participant_role_rows_json; the legacy by-role object alone may collapse repeated roles.

`strength_state` is a native source label. Even Strength is not necessarily 5v5: it can include 4v4 and 3v3. No exact 5v5 claim is made without shift/on-ice counts. Power-play labels and player special-teams TOI do not establish a full manpower timeline. Native shot description keywords produce engineered shot-type labels, not verified structured tracking. Native coordinates remain unverified in physical units and direction; do not silently assume feet or a goal-side transformation.

Regular-season shootout-candidate events are flagged by period >4; playoff overtime is not flagged as shootout. Native final scores can include an awarded shootout goal. Regulation goal targets and nonshootout event counts are provided separately. Missing goalie assignment does not imply an empty net.

Box values preserve provider strings. Read sources/NATIVE_STAT_DEFINITIONS.csv: in these native player boxes SOG means shootout goals, not shots on goal. Do not interpret an abbreviation from another provider’s convention. TOI and special-teams TOI have explicitly parsed seconds. Ratio features pool measured counts; missing values are not zero. Player YTD fields can be retrospective snapshots and must not enter a prediction for the generating game. Missing source timestamps stay blank. Measured features are post-game; lagged features exclude the target game but remain retrospective because first-publication and revision times are unknown.

`hours_between_scheduled_starts` is exactly that, not actual recovery time or verified travel. Event-time player injury, goalie confirmation, lineup, minute projection, xG/GSAx, full shifts, exact strength exposures, tracking and timestamped executable odds are still gaps. Do not invent them. One season supports exploration and feature integration, not robust 2026 live calibration.

## Claude integration and refresh

Load facts and source lineage first. Read the P0 acquisition list, complete missing inputs with authorized sources, train/calibrate chronologically and then attach fresh prices under the existing EdgeDesk budget. Separate independent research from market-verified EV and PASS when evidence/price is insufficient.

The collector uses bounded public requests, explicit caching and normal access; it does not call paid feeds or bypass blocks. Its 2024–25 scope is fixed. Raw responses are cached locally for reproducibility but omitted from this ZIP to keep the upload small; digests and normalized facts are included. On a fresh machine, running the collector makes public requests again. Dependencies: Python standard library only.

```bash
python scripts/build_features.py
python scripts/verify_and_package.py
```

Source facts: ESPN; public commercial/API redistribution rights are not certified. Native NHL endpoints were blocked. No MoneyPuck data is included; its commercial-use permission is not assumed. See sources/ACCESS_AND_RIGHTS.md.
'''
 (R/'README.md').write_text(text)
 out=R.parent/'EdgeDesk_NHL_Data_Pack.zip'
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for p in sorted(R.rglob('*')):
   if p.is_file() and '__pycache__' not in p.parts:z.write(p,arcname=str(p.relative_to(R.parent)))
 with zipfile.ZipFile(out) as z:assert z.testzip() is None
 assert out.stat().st_size<30_000_000,f'Upload too large: {out.stat().st_size}'
 print('ZIP',round(out.stat().st_size/1_000_000,2),'MB; integrity checked')
if __name__=='__main__':finish()
