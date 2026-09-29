-- player_props -- part 5 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- SEEDS (on conflict do nothing: a re-run never rewrites a stored value)
-- ===========================================================================
insert into props.quality_rules(rule_id, scope, check_type, rule, severity, action) values
 ('Q001','fact_player_game','PRIMARY KEY','game_id + player_id unique','ERROR','Reject duplicate player-game rows'),
 ('Q002','fact_player_game','RANGE','all counting stats >= 0','ERROR','Reject negatives except explicitly signed metrics'),
 ('Q003','fact_player_game','CONSISTENCY','completions <= attempts','ERROR','Reject or quarantine'),
 ('Q004','fact_player_game','CONSISTENCY','receptions <= targets when targets present','ERROR','Reject or quarantine'),
 ('Q005','fact_player_game','CONSISTENCY','passing_tds/interceptions plausible vs attempts','WARN','Flag extreme provider errors'),
 ('Q006','fact_prop_quote','LINEAGE','lineage in observed,reconstructed','ERROR','Never default missing lineage'),
 ('Q007','fact_prop_quote','TIMESTAMP','snapshot_at < kickoff_utc for pregame backtest','ERROR','Prevents in-game leakage'),
 ('Q008','fact_feature_snapshot','POINT IN TIME','source_max_timestamp <= asof_at','ERROR','Hard leakage gate'),
 ('Q009','bridge_cfb_nfl_player','IDENTITY','match_confidence >= .90 or manual_reviewed=true for production','ERROR','Prevents cross-player contamination'),
 ('Q010','fact_prop_result','SETTLEMENT','result_quality >= .95 for training target','ERROR','Quarantine uncertain settlements'),
 ('Q011','fact_prop_quote','ODDS','american_price not between -99 and 99','ERROR','Invalid American-odds gap'),
 ('Q012','fact_prop_quote','PAIRING','main OU should pair over+under at same book/snapshot/line','WARN','Needed for de-vigging'),
 ('Q013','dim_game','TIME','kickoff_utc non-null and timezone-aware','ERROR','No local-time ambiguity'),
 ('Q014','all','SOURCE','source/provider present','ERROR','Every row must retain provenance'),
 ('Q015','training_view','LEAKAGE','no post-kickoff/in-game/injury-resolution-after-bet fields','ERROR','Automated feature whitelist only')
on conflict (rule_id) do nothing;

insert into props.prop_catalog(market_key, market_group, positions, target_column, bet_type, priority, cfb, nfl, family, modeled, settle_stats, notes) values
 ('pass_yards','passing','{QB}','passing_yards','OU','P0',true,true,'continuous',true,'{passing_yards}','Core continuous prop'),
 ('pass_tds','passing','{QB}','passing_tds','OU','P0',true,true,'count',true,'{passing_tds}','Count distribution'),
 ('pass_completions','passing','{QB}','completions','OU','P0',true,true,'count',true,'{completions}','Volume + efficiency'),
 ('pass_attempts','passing','{QB}','attempts','OU','P0',true,true,'count',true,'{attempts}','Highly role/game-script dependent'),
 ('pass_interceptions','passing','{QB}','interceptions','OU','P0',true,true,'count',true,'{interceptions}','Low-count discrete'),
 ('pass_longest_completion','passing','{QB}','longest_completion','OU','P1',true,true,'continuous',true,'{longest_completion}','Tail-sensitive'),
 ('rush_yards','rushing','{QB,RB,WR}','rushing_yards','OU','P0',true,true,'continuous',true,'{rushing_yards}','Core continuous prop'),
 ('rush_attempts','rushing','{QB,RB,WR}','carries','OU','P0',true,true,'count',true,'{carries}','Usage prop'),
 ('rush_tds','rushing','{QB,RB,WR}','rushing_tds','OU','P1',true,true,'count',true,'{rushing_tds}','Count distribution'),
 ('longest_rush','rushing','{QB,RB,WR}','longest_rush','OU','P1',true,true,'continuous',true,'{longest_rush}','Tail-sensitive'),
 ('receiving_yards','receiving','{RB,WR,TE}','receiving_yards','OU','P0',true,true,'continuous',true,'{receiving_yards}','Core continuous prop'),
 ('receptions','receiving','{RB,WR,TE}','receptions','OU','P0',true,true,'count',true,'{receptions}','Target + catch model'),
 ('targets','receiving','{RB,WR,TE}','targets','OU','P1',true,true,'count',true,'{targets}','Not offered everywhere'),
 ('receiving_tds','receiving','{RB,WR,TE}','receiving_tds','OU','P1',true,true,'count',true,'{receiving_tds}','Count distribution'),
 ('longest_reception','receiving','{RB,WR,TE}','longest_reception','OU','P1',true,true,'continuous',true,'{longest_reception}','Tail-sensitive'),
 ('anytime_td','scoring','{QB,RB,WR,TE}','any_touchdown','YESNO','P0',true,true,'binary',true,'{rushing_tds,receiving_tds}','Binary scoring probability; define passing TD exclusion by book'),
 ('first_td','scoring','{QB,RB,WR,TE}','first_touchdown','YESNO','P2',true,true,'binary',false,'{}','High variance; lineup/drive-order sensitive'),
 ('pass_rush_yards','combo','{QB}','pass_plus_rush_yards','OU','P0',true,true,'continuous',true,'{passing_yards,rushing_yards}','Strong QB market'),
 ('rush_rec_yards','combo','{RB,WR,TE}','rush_plus_receiving_yards','OU','P0',true,true,'continuous',true,'{rushing_yards,receiving_yards}','Useful for hybrid usage'),
 ('pass_rush_rec_yards','combo','{QB,RB,WR,TE}','total_offense_yards','OU','P1',true,true,'continuous',true,'{passing_yards,rushing_yards,receiving_yards}','Provider-specific naming'),
 ('receptions_rush_attempts','combo','{RB,WR,TE}','receptions_plus_carries','OU','P2',true,true,'count',true,'{receptions,carries}','Provider-specific'),
 ('kicking_points','kicking','{K}','kicking_points','OU','P2',true,true,'count',false,'{}','Can add after offensive markets stabilize'),
 ('field_goals_made','kicking','{K}','field_goals_made','OU','P2',true,true,'count',false,'{}','Discrete'),
 ('extra_points_made','kicking','{K}','extra_points_made','OU','P2',true,true,'count',false,'{}','Often low edge'),
 ('def_interceptions','defense','{DB,LB}','defensive_interceptions','OU','P3',true,true,'count',false,'{}','Historical player stat quality varies'),
 ('sacks','defense','{DL,LB}','sacks','OU','P3',true,true,'count',false,'{}','Provider/stat attribution variance'),
 ('tackles_assists','defense','{LB,DB,DL}','tackles_assists','OU','P3',false,true,'count',false,'{}','NFL first; CFB historical consistency weaker')
on conflict (market_key) do nothing;

insert into props.provider_market_map(provider, provider_market_key, market_key, is_alternate) values
 ('the-odds-api','player_pass_yds','pass_yards',false),('the-odds-api','player_pass_yds_alternate','pass_yards',true),
 ('the-odds-api','player_pass_tds','pass_tds',false),('the-odds-api','player_pass_tds_alternate','pass_tds',true),
 ('the-odds-api','player_pass_completions','pass_completions',false),('the-odds-api','player_pass_completions_alternate','pass_completions',true),
 ('the-odds-api','player_pass_attempts','pass_attempts',false),('the-odds-api','player_pass_attempts_alternate','pass_attempts',true),
 ('the-odds-api','player_pass_interceptions','pass_interceptions',false),('the-odds-api','player_pass_interceptions_alternate','pass_interceptions',true),
 ('the-odds-api','player_pass_longest_completion','pass_longest_completion',false),('the-odds-api','player_pass_longest_completion_alternate','pass_longest_completion',true),
 ('the-odds-api','player_rush_yds','rush_yards',false),('the-odds-api','player_rush_yds_alternate','rush_yards',true),
 ('the-odds-api','player_rush_attempts','rush_attempts',false),('the-odds-api','player_rush_attempts_alternate','rush_attempts',true),
 ('the-odds-api','player_rush_tds','rush_tds',false),('the-odds-api','player_rush_tds_alternate','rush_tds',true),
 ('the-odds-api','player_rush_longest','longest_rush',false),('the-odds-api','player_rush_longest_alternate','longest_rush',true),
 ('the-odds-api','player_reception_yds','receiving_yards',false),('the-odds-api','player_reception_yds_alternate','receiving_yards',true),
 ('the-odds-api','player_receptions','receptions',false),('the-odds-api','player_receptions_alternate','receptions',true),
 ('the-odds-api','player_reception_tds','receiving_tds',false),('the-odds-api','player_reception_tds_alternate','receiving_tds',true),
 ('the-odds-api','player_reception_longest','longest_reception',false),('the-odds-api','player_reception_longest_alternate','longest_reception',true),
 ('the-odds-api','player_anytime_td','anytime_td',false),('the-odds-api','player_1st_td','first_td',false),
 ('the-odds-api','player_pass_rush_yds','pass_rush_yards',false),('the-odds-api','player_pass_rush_yds_alternate','pass_rush_yards',true),
 ('the-odds-api','player_rush_reception_yds','rush_rec_yards',false),('the-odds-api','player_rush_reception_yds_alternate','rush_rec_yards',true),
 ('the-odds-api','player_pass_rush_reception_yds','pass_rush_rec_yards',false),('the-odds-api','player_pass_rush_reception_yds_alternate','pass_rush_rec_yards',true),
 ('the-odds-api','player_kicking_points','kicking_points',false),('the-odds-api','player_kicking_points_alternate','kicking_points',true),
 ('the-odds-api','player_field_goals','field_goals_made',false),('the-odds-api','player_field_goals_alternate','field_goals_made',true),
 ('the-odds-api','player_pats','extra_points_made',false),('the-odds-api','player_pats_alternate','extra_points_made',true),
 ('the-odds-api','player_defensive_interceptions','def_interceptions',false),('the-odds-api','player_defensive_interceptions_alternate','def_interceptions',true),
 ('the-odds-api','player_sacks','sacks',false),('the-odds-api','player_sacks_alternate','sacks',true),
 ('the-odds-api','player_tackles_assists','tackles_assists',false),('the-odds-api','player_tackles_assists_alternate','tackles_assists',true)
on conflict (provider, provider_market_key) do nothing;

insert into props.backtest_splits(fold, family, train_from, train_to, test_season, method, notes) values
 ('OUTCOME_CFB_1','CFB outcome model',2014,2018,2019,'Walk-forward','Primary baseline'),
 ('OUTCOME_CFB_2','CFB outcome model',2014,2019,2020,'Walk-forward','Pandemic season tagged; report separately'),
 ('OUTCOME_CFB_3','CFB outcome model',2014,2020,2021,'Walk-forward','No random split'),
 ('OUTCOME_CFB_4','CFB outcome model',2014,2021,2022,'Walk-forward','No random split'),
 ('OUTCOME_CFB_5','CFB outcome model',2014,2022,2023,'Walk-forward','Begins overlap with prop-market labels'),
 ('OUTCOME_CFB_6','CFB outcome model',2014,2023,2024,'Walk-forward',null),
 ('OUTCOME_CFB_7','CFB outcome model',2014,2024,2025,'Walk-forward',null),
 ('OUTCOME_CFB_8','CFB outcome model',2014,2025,2026,'Live/holdout','Do not tune to current-season results'),
 ('OUTCOME_NFL_1','NFL outcome model',2011,2017,2018,'Walk-forward',null),
 ('OUTCOME_NFL_2','NFL outcome model',2011,2018,2019,'Walk-forward',null),
 ('OUTCOME_NFL_3','NFL outcome model',2011,2019,2020,'Walk-forward','Pandemic tagged'),
 ('OUTCOME_NFL_4','NFL outcome model',2011,2020,2021,'Walk-forward',null),
 ('OUTCOME_NFL_5','NFL outcome model',2011,2021,2022,'Walk-forward',null),
 ('OUTCOME_NFL_6','NFL outcome model',2011,2022,2023,'Walk-forward','Market overlap begins'),
 ('OUTCOME_NFL_7','NFL outcome model',2011,2023,2024,'Walk-forward',null),
 ('OUTCOME_NFL_8','NFL outcome model',2011,2024,2025,'Walk-forward',null),
 ('OUTCOME_NFL_9','NFL outcome model',2011,2025,2026,'Live/holdout',null),
 ('MARKET_1','Market calibration / EV',2023,2023,2024,'Walk-forward','Observed player-prop quotes only'),
 ('MARKET_2','Market calibration / EV',2023,2024,2025,'Walk-forward','Observed quotes only'),
 ('MARKET_3','Market calibration / EV',2023,2025,2026,'Live/holdout','Observed quotes only')
on conflict (fold) do nothing;

insert into props.pipeline_jobs(job, job_order, league, cadence, layer, input, output) values
 ('ingest_nfl_players',1,'NFL','daily in season / weekly offseason','RAW','nflverse players','dim_player staging'),
 ('ingest_nfl_rosters',2,'NFL','daily in season','RAW','nflverse rosters','roster staging'),
 ('ingest_nfl_player_stats',3,'NFL','after games','RAW','nflverse weekly stats','player_game staging'),
 ('ingest_nfl_pbp',4,'NFL','after games','RAW','nflverse PBP','PBP staging'),
 ('ingest_cfb_rosters',5,'CFB','daily in season','RAW','SportsDataverse','roster staging'),
 ('ingest_cfb_player_box',6,'CFB','after games','RAW','SportsDataverse player box','player_game staging'),
 ('ingest_cfb_pbp',7,'CFB','after games','RAW','SportsDataverse PBP','PBP staging'),
 ('ingest_cfb_recruiting',8,'CFB','weekly/monthly','RAW','CFBD','recruiting staging'),
 ('ingest_prop_quotes',9,'BOTH','5-15 min pregame','RAW','Odds API provider','fact_prop_quote'),
 ('snapshot_market_open',10,'BOTH','event-driven','CURATED','fact_prop_quote','open snapshot flags'),
 ('snapshot_market_close',11,'BOTH','10 min pre-kick','CURATED','fact_prop_quote','close snapshot flags'),
 ('resolve_player_identity',12,'BOTH','after source loads','CURATED','all identity sources','dim_player + bridge'),
 ('build_player_game_fact',13,'BOTH','after stats/PBP','CURATED','stats + PBP','fact_player_game'),
 ('settle_prop_results',14,'BOTH','after game final','CURATED','player_game + quotes','fact_prop_result'),
 ('build_pit_features',15,'BOTH','hourly / pre-board','FEATURE','curated facts','fact_feature_snapshot'),
 ('score_prop_models',16,'BOTH','on quote change','MODEL','features + models','model_prediction'),
 ('publish_props_board',17,'BOTH','on scoring update','SERVE','predictions + quotes','API/public view'),
 ('nightly_qa',18,'BOTH','nightly','QA','all layers','quality metrics + quarantine')
on conflict (job) do nothing;

insert into props.source_registry(source, league, data, coverage, access, license_note, url, role) values
 ('nflverse','NFL','Player stats, PBP, rosters, schedules, players','1999+','Public data releases','CC BY 4.0 for most nflverse data; verify dataset-specific notes','https://nflverse.nflverse.com/','PRIMARY'),
 ('nflreadr player stats','NFL','Weekly player stats','1999+','Season-partitioned releases','nflverse license applies','https://nflreadr.nflverse.com/reference/load_player_stats','PRIMARY'),
 ('nflreadr PBP','NFL','Play-by-play','1999+','Season-partitioned releases','nflverse license applies','https://nflreadr.nflverse.com/reference/load_pbp','PRIMARY'),
 ('SportsDataverse / cfbfastR','CFB','PBP, schedules, player box, rosters, advanced stats','2004+ varies by family','GitHub release assets / package loaders','SportsDataverse release store is CC BY 4.0; upstream-source terms still matter','https://cfbfastr.sportsdataverse.org/','PRIMARY'),
 ('CollegeFootballData','CFB','Games, players, recruiting, ratings, analytics','Varies by endpoint','Bearer API','Check current API terms and access tier','https://api.collegefootballdata.com/','ENRICH'),
 ('The Odds API','BOTH','Observed sportsbook odds, player props, historical snapshots','Props history from 2023-05-03','Paid historical API','Commercial API terms','https://the-odds-api.com/historical-odds-data/','PRIMARY MARKET'),
 ('SportsGameOdds','BOTH','Player props, per-book open/close, historical odds','Availability varies by league/tier','Commercial REST API','Commercial API terms','https://sportsgameodds.com/use-cases/historical-odds-data-api','SECONDARY MARKET'),
 ('Open-Meteo / weather archive','BOTH','Weather observations / historical forecast context','Historical','REST','Check attribution/terms for deployed usage','https://open-meteo.com/','ENRICH')
on conflict (source) do nothing;

-- feature_registry is seeded by football/props/db.js from config/feature_registry.json (121 rows);
-- the report below says whether it has been.

-- ===========================================================================
-- ROW LEVEL SECURITY AND GRANTS
-- Readers: the catalog, the entities, the history, the registry, the serving
-- views and the record. Signed-in only: quote history and predictions.
-- Nobody but the service role: staging, raw payloads, features, quarantine,
-- the ingestion diary, corrections.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['source_registry','prop_catalog','provider_market_map','feature_registry','quality_rules','backtest_splits','pipeline_jobs','ingestion_runs','quarantine',
    'dim_team','dim_player','player_id_map','player_id_merges','bridge_cfb_nfl_player','identity_review','dim_game','fact_player_game','fact_team_game','fact_corrections',
    'stg_player_game','fact_prop_quote','fact_prop_listing','raw_odds_payloads','fact_feature_snapshot','model_registry','model_status_events','model_prediction','fact_prop_result',
    'backtest_run','backtest_decision','prop_record'] loop
    execute format('alter table props.%I enable row level security', t);
    execute format('revoke all on props.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on props.%I to service_role', t);
  end loop;
  -- public reads
  foreach t in array array['source_registry','prop_catalog','provider_market_map','feature_registry','quality_rules','backtest_splits','pipeline_jobs','dim_team','dim_player',
    'bridge_cfb_nfl_player','dim_game','fact_player_game','fact_team_game','model_registry','model_status_events','fact_prop_result','prop_record','backtest_run'] loop
    execute format('grant select on props.%I to anon, authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'props' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on props.%I for select to anon, authenticated using (true)', t || '_read', t);
    end if;
  end loop;
  -- signed-in reads
  foreach t in array array['fact_prop_quote','fact_prop_listing','model_prediction','backtest_decision'] loop
    execute format('grant select on props.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'props' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on props.%I for select to authenticated using (true)', t || '_read', t);
    end if;
  end loop;
end $$;
grant select on props.v_player_props_board, props.v_prop_record_summary, props.v_model_status, props.v_quality to anon, authenticated;
