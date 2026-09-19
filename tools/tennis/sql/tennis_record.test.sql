-- ===========================================================================
-- supabase/tennis_record.sql, attacked.
--
-- Applied by tools/tennis/record_sql.test.js to a throwaway database that has
-- the Supabase shim, billing.sql (for public.subscriptions), the live tennis
-- contract and this record contract. Every assertion below raises a NOTICE
-- 'ok <what>' when it holds, and 'FAIL: ...' otherwise; the harness fails the
-- suite on any FAIL and on too few oks.
--
-- What is attacked, and why each one matters:
--
--   THE LICENCE GATE   a row naming an unregistered source must be refused,
--                      and the archive must be unable to claim commercial
--                      clearance without a named clearer. This is the product
--                      claim the app has been making for months.
--   IMMUTABILITY       a prediction, a model version and a published record
--                      must be un-rewritable EVEN BY THE PIPELINE. A public
--                      record that its own writer can edit is not a record.
--   IDEMPOTENCY        the same match imported twice is one row; a CORRECTED
--                      result updates the match it corrects rather than
--                      creating a second one.
--   THE PAYWALL        anon reads the record and is REFUSED prices; a
--                      signed-in free account is refused them too; only an
--                      entitled subscriber sees them. And nobody at all reads
--                      the point-in-time feature table.
--   NO CLIENT WRITES   every table, attacked as anon and as authenticated.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_what text) returns void language plpgsql as $$
begin raise notice 'ok %', p_what; end $$;
create or replace function pg_temp.want(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok %', p_what;
  else raise exception 'FAIL: %', p_what; end if;
end $$;
-- run a statement and say whether it was REFUSED. The whole suite is built on
-- this: most assertions here pass when the database says no.
create or replace function pg_temp.refused(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok % (%)' , p_what, left(sqlerrm, 60);
    return;
  end;
  raise exception 'FAIL: % — the statement was ALLOWED', p_what;
end $$;
create or replace function pg_temp.allowed(p_sql text, p_what text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'ok %', p_what;
exception when others then
  raise exception 'FAIL: % — refused with %', p_what, left(sqlerrm, 90);
end $$;

-- ── fixtures ───────────────────────────────────────────────────────────────
do $$
declare uid_sub uuid := gen_random_uuid(); uid_free uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (uid_sub, 'sub@example.com', now()), (uid_free, 'free@example.com', now());
  if to_regclass('public.subscriptions') is not null then
    insert into public.subscriptions (user_id, status, price_id, current_period_end)
      values (uid_sub, 'active', 'price_x', now() + interval '30 days');
  end if;
  insert into tennis.meta (key, value) values ('test_sub', uid_sub::text), ('test_free', uid_free::text)
    on conflict (key) do update set value = excluded.value;
end $$;

insert into tennis.players (player_id, tour, source_key, source_player_id, full_name, name_norm)
values ('archive:ATP:1', 'ATP', 'archive', '1', 'Player One', 'player one'),
       ('archive:ATP:2', 'ATP', 'archive', '2', 'Player Two', 'player two')
on conflict (player_id) do nothing;

insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num,
                            match_date, surface, winner_id, loser_id, score, best_of)
values ('archive:ATP:t1:1', 'archive', 'ATP', 't1', 1, '2024-05-01', 'clay',
        'archive:ATP:1', 'archive:ATP:2', '6-4 6-3', 3)
on conflict (match_id) do nothing;

-- ── 1. THE LICENCE GATE ────────────────────────────────────────────────────
select pg_temp.refused($$
  insert into tennis.players (player_id, tour, source_key, source_player_id, full_name, name_norm)
  values ('mystery:ATP:9', 'ATP', 'a_source_nobody_registered', '9', 'X', 'x')
$$, 'a player from an UNREGISTERED source is refused');

select pg_temp.refused($$
  insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num, match_date)
  values ('mystery:ATP:t9:1', 'nope', 'ATP', 't9', 1, '2024-01-01')
$$, 'a match from an unregistered source is refused');

select pg_temp.want(
  (select commercial_use from tennis.source_licenses where source_key = 'archive') = false,
  'the historical archive is registered NON-COMMERCIAL');

select pg_temp.want(
  (select 'research' = any(allowed_uses) and not ('commercial' = any(allowed_uses))
     from tennis.source_licenses where source_key = 'archive'),
  'and is allowed for research only');

select pg_temp.refused($$
  insert into tennis.source_licenses (source_key, title, licence, commercial_use)
  values ('sneaky', 'A feed', 'Unknown', true)
$$, 'a source cannot be marked commercially usable without a named clearer');

select pg_temp.want(tennis.license_allows('archive', 'research'), 'the archive may be used for research');
select pg_temp.want(not tennis.license_allows('archive', 'commercial'), 'and may NOT be used commercially');
select pg_temp.want(not tennis.license_allows('does_not_exist', 'research'), 'an unknown source allows nothing');

-- ── 2. IDEMPOTENCY AND CORRECTIONS ─────────────────────────────────────────
do $$
declare n_before bigint; n_after bigint; w text;
begin
  select count(*) into n_before from tennis.matches;
  -- the same draw slot, imported again
  insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num,
                              match_date, surface, winner_id, loser_id, score, best_of)
  values ('archive:ATP:t1:1', 'archive', 'ATP', 't1', 1, '2024-05-01', 'clay',
          'archive:ATP:1', 'archive:ATP:2', '6-4 6-3', 3)
  on conflict (match_id) do update set score = excluded.score, updated_at = now();
  select count(*) into n_after from tennis.matches;
  perform pg_temp.want(n_before = n_after, 'a second import of the same match creates no second row');

  -- a CORRECTION: the winner and loser are swapped upstream
  insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num,
                              match_date, surface, winner_id, loser_id, score, best_of)
  values ('archive:ATP:t1:1', 'archive', 'ATP', 't1', 1, '2024-05-01', 'clay',
          'archive:ATP:2', 'archive:ATP:1', '4-6 6-3 6-2', 3)
  on conflict (match_id) do update set
    winner_id = excluded.winner_id, loser_id = excluded.loser_id, score = excluded.score, updated_at = now();
  select count(*) into n_after from tennis.matches;
  perform pg_temp.want(n_before = n_after, 'a CORRECTED result updates the match rather than duplicating it');
  select winner_id into w from tennis.matches where match_id = 'archive:ATP:t1:1';
  perform pg_temp.want(w = 'archive:ATP:2', 'and the correction actually took');
  -- put it back
  update tennis.matches set winner_id = 'archive:ATP:1', loser_id = 'archive:ATP:2', score = '6-4 6-3'
   where match_id = 'archive:ATP:t1:1';
end $$;

select pg_temp.refused($$
  insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num, match_date)
  values ('archive:ATP:t1:1:dup', 'archive', 'ATP', 't1', 1, '2024-05-01')
$$, 'two rows cannot occupy the same draw slot under a different id');

select pg_temp.refused($$
  insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num,
                              match_date, winner_id, loser_id)
  values ('archive:ATP:t1:99', 'archive', 'ATP', 't1', 99, '2024-05-01',
          'archive:ATP:1', 'archive:ATP:1')
$$, 'a match cannot have the same player on both sides');

select pg_temp.refused($$
  insert into tennis.players (player_id, tour, source_key, source_player_id, full_name, name_norm, height_cm)
  values ('archive:ATP:71', 'ATP', 'archive', '71', 'Tiny', 'tiny', 71)
$$, 'an impossible height cannot enter the player record');

-- ── 3. IMMUTABILITY ────────────────────────────────────────────────────────
insert into tennis.model_registry (model_version, feature_version, training_cutoff, status, eval_results)
values ('test-model-1', 'tennis-features-1.0.0', '2024-01-01', 'active', '{"test":{"log_loss":0.6}}'::jsonb)
on conflict (model_version) do nothing;

insert into tennis.model_predictions (match_scope, match_ref, tour, model_version, prob_a, prob_b,
                                      player_a_id, player_b_id)
values ('live', 'espn:test', 'ATP', 'test-model-1', 0.6, 0.4, 'archive:ATP:1', 'archive:ATP:2')
on conflict do nothing;

select pg_temp.refused($$update tennis.model_predictions set prob_a = 0.9 where match_ref = 'espn:test'$$,
  'a prediction cannot be rewritten, even by the pipeline');
select pg_temp.refused($$delete from tennis.model_predictions where match_ref = 'espn:test'$$,
  'and cannot be deleted');
select pg_temp.refused($$update tennis.model_registry set eval_results = '{}'::jsonb where model_version = 'test-model-1'$$,
  'a model version''s evaluation is immutable');
select pg_temp.refused($$update tennis.model_registry set training_cutoff = '2020-01-01' where model_version = 'test-model-1'$$,
  'and so is its training window');
select pg_temp.refused($$delete from tennis.model_registry where model_version = 'test-model-1'$$,
  'and a model version cannot be deleted, only retired');
select pg_temp.allowed($$update tennis.model_registry set status = 'retired', retired_at = now() where model_version = 'test-model-1'$$,
  'but its STATUS may change, which is how a rollback works');
update tennis.model_registry set status = 'active', retired_at = null where model_version = 'test-model-1';

insert into tennis.model_registry (model_version, feature_version, training_cutoff, status)
values ('test-model-2', 'tennis-features-1.0.0', '2024-06-01', 'candidate')
on conflict (model_version) do nothing;
select pg_temp.refused($$update tennis.model_registry set status = 'active' where model_version = 'test-model-2'$$,
  'two models cannot be active in the same family at once');

insert into tennis.prediction_record (match_scope, match_ref, tour, model_version, prob_a,
                                      player_a_id, player_b_id, scheduled_at)
values ('live', 'espn:test', 'ATP', 'test-model-1', 0.6, 'archive:ATP:1', 'archive:ATP:2', now() - interval '1 hour')
on conflict do nothing;
select pg_temp.refused($$update tennis.prediction_record set prob_a = 0.99 where match_ref = 'espn:test'$$,
  'a PUBLISHED claim is immutable');
select pg_temp.refused($$delete from tennis.prediction_record where match_ref = 'espn:test'$$,
  'and cannot be deleted');
select pg_temp.allowed($$update tennis.prediction_record set settled_at = now(), outcome_a = true,
  winner_id = 'archive:ATP:1', brier = 0.16 where match_ref = 'espn:test'$$,
  'but settlement may write the RESULT beside it');
select pg_temp.refused($$update tennis.prediction_record set settled_at = now() + interval '1 day' where match_ref = 'espn:test'$$,
  'and a settled record is never re-settled');

-- ── 4. THE PAYWALL, ATTACKED FROM EVERY SEAT ──────────────────────────────
--
-- SESSION-LEVEL `set role`, not `set local`. psql runs each statement in its
-- own implicit transaction, so `set local role anon` is scoped to that one
-- statement and the role is back to the owner by the next line — which made
-- every "anon cannot read this" assertion pass for the wrong reason, as the
-- owner reading it happily. The same applies to the JWT claim the shim's
-- auth.uid() reads, so it is set session-wide too and cleared after.
-- anon
set role anon;
select pg_temp.want((select count(*) from tennis.players) > 0, 'anon CAN read the player record');
select pg_temp.want((select count(*) from tennis.matches) > 0, 'anon CAN read the match record');
select pg_temp.want((select count(*) from tennis.player_career) >= 0, 'anon CAN read the record views');
select pg_temp.refused($$select count(*) from tennis.model_predictions$$, 'anon CANNOT read predictions');
select pg_temp.refused($$select count(*) from tennis.odds_snapshots$$, 'anon CANNOT read prices');
select pg_temp.refused($$select count(*) from tennis.research_opportunities$$, 'anon CANNOT read research opportunities');
select pg_temp.refused($$select count(*) from tennis.player_match_features$$, 'anon CANNOT read the feature table');
select pg_temp.refused($$select count(*) from tennis.stg_archive_matches$$, 'anon CANNOT read staging');
select pg_temp.refused($$select count(*) from tennis.ingestion_runs$$, 'anon CANNOT read the pipeline diary');
select pg_temp.refused($$select count(*) from tennis.data_quality_issues$$, 'anon CANNOT read data-quality issues');
select pg_temp.refused($$select count(*) from tennis.board_research$$, 'anon CANNOT reach the priced view');
select pg_temp.refused($$select count(*) from tennis.board_current$$, 'anon CANNOT reach the board view');
select pg_temp.refused($$select count(*) from tennis.match_context$$, 'anon CANNOT reach the match-context view');
select pg_temp.want((select count(*) from tennis.board_public) >= 0, 'but anon CAN reach the public board');
-- SELECT *, not count(*). count(*) lets the planner skip the scalar subqueries,
-- which is exactly how this view shipped reading a PRIVATE table for months
-- without anyone noticing: the page does `select *` and got "permission denied
-- for table ingestion_runs", while every test did `count(*)` and passed.
select pg_temp.want((select count(*) from tennis.record_health) = 1, 'and the health line');
select pg_temp.allowed($$select * from tennis.record_health$$,
  'and can read EVERY COLUMN of it, including the operational ones');
select pg_temp.want((select failed_runs_7d from tennis.record_health) is not null,
  'the operational numbers reach anon through the narrow definer door');
select pg_temp.refused($$select * from tennis.ingestion_runs$$,
  'while the table behind them stays private');
select pg_temp.want((select open_opportunities from tennis.record_health) is not null,
  'the header can count open opportunities without reading one');
select pg_temp.refused($$select * from tennis.research_opportunities$$,
  'while the opportunities themselves stay subscriber-only');
select pg_temp.want((select count(*) from tennis.prediction_record) > 0,
  'and the PUBLISHED record of a match that has already started');
select pg_temp.refused($$insert into tennis.players (player_id, tour, source_key, source_player_id, full_name, name_norm)
  values ('x:1','ATP','archive','x','X','x')$$, 'anon cannot write a player');
select pg_temp.refused($$update tennis.matches set score = 'hacked'$$, 'anon cannot rewrite a match');
select pg_temp.refused($$delete from tennis.players$$, 'anon cannot delete a player');
select pg_temp.refused($$insert into tennis.source_licenses (source_key, title, licence) values ('h','H','H')$$,
  'anon cannot register a source licence');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- a signed-in account with NO subscription
set role authenticated;
select set_config('request.jwt.claim.sub', (select value from tennis.meta where key = 'test_free'), false);
select pg_temp.want(not tennis.viewer_is_entitled(), 'a free account is not entitled');
select pg_temp.want((select count(*) from tennis.model_predictions) = 0,
  'and reads ZERO predictions — the database refuses, not the application');
select pg_temp.want((select count(*) from tennis.research_opportunities) = 0, 'and zero research opportunities');
select pg_temp.want((select count(*) from tennis.odds_snapshots) = 0, 'and zero prices');
select pg_temp.want((select count(*) from tennis.players) > 0, 'but the record is still readable');
select pg_temp.refused($$select count(*) from tennis.player_match_features$$,
  'and even a signed-in reader cannot reach the feature table');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- an ENTITLED subscriber
set role authenticated;
select set_config('request.jwt.claim.sub', (select value from tennis.meta where key = 'test_sub'), false);
select pg_temp.want(tennis.viewer_is_entitled(), 'an entitled subscriber is entitled');
select pg_temp.want((select count(*) from tennis.model_predictions) > 0, 'and reads predictions');
select pg_temp.want((select count(*) from tennis.board_current) >= 0, 'and reaches the board view');
select pg_temp.refused($$select count(*) from tennis.player_match_features$$,
  'but NOT the feature table — that is private to the pipeline, subscription or no subscription');
select pg_temp.refused($$update tennis.model_predictions set prob_a = 0.5$$, 'and cannot write a prediction');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ── 5. PRIVILEGED FUNCTIONS ────────────────────────────────────────────────
select pg_temp.want(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')),
  'every security-definer function has a fixed search_path');
select pg_temp.want(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and has_function_privilege('public', p.oid, 'EXECUTE')),
  'and none is executable by PUBLIC');
select pg_temp.want(not has_function_privilege('anon', 'tennis.drop_backfill_indexes()', 'EXECUTE'),
  'a browser cannot drop the backfill indexes');
select pg_temp.want(not has_function_privilege('authenticated', 'tennis.record_quality_issue(uuid,text,text,text,text,text,text,text,text,text,jsonb)', 'EXECUTE'),
  'nor write a data-quality issue');

-- ── 6. THE AI DOOR ─────────────────────────────────────────────────────────
set role anon;
select pg_temp.allowed($$select tennis.ai_data_health()$$, 'anon may ask the AI health function');
select pg_temp.allowed($$select * from tennis.ai_surface_leaders('ATP','clay',5)$$, 'and for surface leaders');
select pg_temp.want((select count(*) from tennis.ai_market_disagreement('ATP', 5)) = 0,
  'but gets NO rows from the priced one — the entitlement check is inside the function');
select pg_temp.want(((select tennis.ai_match_context('espn:test'))->>'entitled')::boolean = false,
  'and the match context tells the caller it is not entitled rather than throwing');
select pg_temp.want((select tennis.ai_match_context('espn:test'))->'prediction' = 'null'::jsonb,
  'and carries no prediction for an unentitled caller');
reset role;
select set_config('request.jwt.claim.sub', '', false);

set role authenticated;
select set_config('request.jwt.claim.sub', (select value from tennis.meta where key = 'test_sub'), false);
select pg_temp.want(((select tennis.ai_match_context('espn:test'))->>'entitled')::boolean = true,
  'an entitled caller is told so');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ── 7. THE LIVE CONTRACT IS UNTOUCHED ─────────────────────────────────────
select pg_temp.want(
  to_regclass('tennis.live_matches') is null
  or exists (select 1 from pg_policies where schemaname='tennis' and tablename='live_matches'),
  'the live contract kept its own policies');
select pg_temp.want(
  to_regclass('tennis.player_directory') is null
  or has_table_privilege('anon','tennis.player_directory','SELECT'),
  'and the provider directory is still readable');
select pg_temp.want(
  (select count(*) from tennis.tournaments where provider = 'espn') >= 0,
  'and tennis.tournaments still serves the live provider');

select pg_temp.ok('suite complete');
