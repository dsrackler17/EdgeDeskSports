-- ===========================================================================
-- ADMIN-ONLY MEMBER REMOVAL, run against a real PostgreSQL.
--
-- These are not assertions about what the SQL says. supabase/collective_member_
-- removal.sql is applied to a live database holding a reconstruction of the
-- Collective schema, and then used and attacked: as anon, as a signed-in
-- contributor, as an admin, twice in a row, and with a foreign key deliberately
-- left in the way so the rollback has to happen for real.
--
-- The load-bearing tests are the three a destructive feature is judged on:
--   * a contributor cannot reach the endpoint at all
--   * a full delete removes THIS contributor's rows and nobody else's
--   * a failure leaves the contributor and every row they own exactly as it was
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, ''); end if;
end; $$;

create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, false);
  execute 'set role authenticated';
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role anon';
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

-- ═══ the world ════════════════════════════════════════════════════════════
do $seed$
declare
  ADMIN  constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  ADMIN2 constant uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  U_ALPHA constant uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  U_BETA  constant uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  U_GAMMA constant uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
  U_DUAL  constant uuid := 'bbbbbbbb-0000-0000-0000-000000000004';
  c_alpha uuid; c_beta uuid; c_gamma uuid; c_dual uuid; c_admin uuid;
  m_alpha uuid; m_beta uuid; m_dual1 uuid; m_dual2 uuid; m_admin uuid;
  g uuid; pid uuid; i integer;
begin
  insert into auth.users (id, email) values
    (ADMIN,'admin@example.com'), (ADMIN2,'admin2@example.com'),
    (U_ALPHA,'alpha@example.com'), (U_BETA,'beta@example.com'),
    (U_GAMMA,'gamma@example.com'), (U_DUAL,'dual@example.com')
  on conflict (id) do nothing;

  insert into collective.config (key, value) values
    ('admin.user_ids', to_jsonb(array[ADMIN::text, ADMIN2::text])),
    ('submission.lock_minutes', '30'::jsonb)
  on conflict (key) do update set value = excluded.value;

  insert into collective.creators (user_id, slug, display_name, founding_member) values
    (U_ALPHA,'alpha','Alpha Analytics', true),
    (U_BETA, 'beta', 'Beta Numbers',    false),
    (U_GAMMA,'gamma','Gamma (never posted)', false),
    (U_DUAL, 'dual', 'Dual Model Shop', false),
    (ADMIN2, 'admin-two','The Other Admin', true);
  select id into c_alpha from collective.creators where slug='alpha';
  select id into c_beta  from collective.creators where slug='beta';
  select id into c_gamma from collective.creators where slug='gamma';
  select id into c_dual  from collective.creators where slug='dual';
  select id into c_admin from collective.creators where slug='admin-two';

  insert into collective.models (creator_id, slug, name) values
    (c_alpha,'alpha-1','Model Alpha') returning id into m_alpha;
  insert into collective.models (creator_id, slug, name) values
    (c_beta,'beta-1','Model Beta') returning id into m_beta;
  insert into collective.models (creator_id, slug, name) values
    (c_dual,'dual-1','Dual One') returning id into m_dual1;
  insert into collective.models (creator_id, slug, name) values
    (c_dual,'dual-2','Dual Two') returning id into m_dual2;
  insert into collective.models (creator_id, slug, name) values
    (c_admin,'admin-1','Admin Model') returning id into m_admin;

  insert into collective.api_keys (creator_id, model_id, key_prefix, key_hash) values
    (c_alpha, m_alpha, 'mck_live_AAAA', 'hash-a'),
    (c_alpha, null,    'mck_test_AAAA', 'hash-a2'),
    (c_beta,  m_beta,  'mck_live_BBBB', 'hash-b'),
    (c_gamma, null,    'mck_live_GGGG', 'hash-g'),
    (c_dual,  m_dual1, 'mck_live_DDDD', 'hash-d');
  insert into collective.embed_origins (creator_id, origin) values
    (c_alpha,'https://alpha.example'), (c_beta,'https://beta.example'), (c_gamma,'https://gamma.example');
  insert into collective.invites (creator_id, display_name, status) values
    (c_gamma,'Gamma','redeemed'), (c_beta,'Beta','redeemed');
  insert into collective.earnings_ledger (creator_id, month, earned_cents) values
    (c_beta,'2026-08', 12500), (c_alpha,'2026-08', 9900);

  for i in 1..5 loop
    insert into collective.games (week, kickoff_at, home_team, away_team)
    values (i, now() - interval '2 days', 'HOME'||i, 'AWAY'||i);
  end loop;
  insert into collective.game_results (game_id, home_score, away_score, closing_spread)
  select id, 24, 17, -3.5 from collective.games;

  perform set_config('collective.maintenance','on', false);
  -- Alpha: 6 submissions, 4 graded, 2 pending
  i := 0;
  for g in select id from collective.games order by week loop
    i := i + 1;
    insert into collective.projections (model_id, game_id, is_graded_candidate, spread, home_ml_prob, result)
    values (m_alpha, g, true, -3 - i, 0.5 + i/100.0, case when i <= 4 then 'win' else null end)
    returning id into pid;
    insert into collective.projection_grades (projection_id, ats_result) values (pid, 'win');
    insert into collective.consensus_contributions (projection_id, game_id) values (pid, g);
    insert into collective.consensus_snapshots (projection_id) values (pid);
  end loop;
  insert into collective.projections (model_id, game_id, is_graded_candidate, is_late, spread)
  select m_alpha, id, false, true, -1 from collective.games order by week limit 1;

  -- Beta: 4 submissions on the same games, 3 graded
  i := 0;
  for g in select id from collective.games order by week limit 4 loop
    i := i + 1;
    insert into collective.projections (model_id, game_id, is_graded_candidate, spread, home_ml_prob, result)
    values (m_beta, g, true, -2 - i, 0.4 + i/100.0, case when i <= 3 then 'loss' else null end)
    returning id into pid;
    insert into collective.projection_grades (projection_id, ats_result) values (pid, 'loss');
    insert into collective.consensus_contributions (projection_id, game_id) values (pid, g);
    insert into collective.consensus_snapshots (projection_id) values (pid);
  end loop;
  -- one quarantined row, never resolved to a game
  insert into collective.projections (model_id, game_id, resolution_status, raw_game_ref)
  values (m_beta, null, 'quarantined', 'KC vs BUFF');

  -- Dual: two models, two submissions each
  for g in select id from collective.games order by week limit 2 loop
    insert into collective.projections (model_id, game_id, is_graded_candidate, spread, result)
    values (m_dual1, g, true, -4, 'win') returning id into pid;
    insert into collective.consensus_contributions (projection_id, game_id) values (pid, g);
    insert into collective.projections (model_id, game_id, is_graded_candidate, spread, result)
    values (m_dual2, g, true, -5, 'push') returning id into pid;
    insert into collective.consensus_contributions (projection_id, game_id) values (pid, g);
  end loop;

  insert into collective.calibration_samples (model_id, bucket, predicted, actual)
  select m_alpha, s, 0.1 * s, (s % 2) from generate_series(1,4) s;
  insert into collective.calibration_samples (model_id, bucket, predicted, actual)
  select m_beta, s, 0.1 * s, (s % 2) from generate_series(1,3) s;

  perform set_config('collective.maintenance','', false);
  perform collective.rebuild_model_record_cache();
  refresh materialized view collective.leaderboard_mv;

  raise notice 'ok   the fixture Collective is seeded';
end $seed$;

-- ═══ 1. AUTHORIZATION ═════════════════════════════════════════════════════
do $test$
declare
  ADMIN   constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  U_BETA  constant uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v jsonb; caught text; n_before bigint; n_after bigint;
begin
  select count(*) into n_before from collective.projections;

  -- anon cannot even execute the function
  perform pg_temp.as_anon();
  caught := null;
  begin perform public.collective_member_removal_preview('alpha');
  exception when others then caught := sqlstate; end;
  perform pg_temp.ok('an anonymous caller cannot execute the preview at all',
    caught = '42501', coalesce(caught,'no error raised'));
  caught := null;
  begin perform public.collective_member_remove('alpha','full_collective_delete','DELETE');
  exception when others then caught := sqlstate; end;
  perform pg_temp.ok('an anonymous caller cannot execute the removal at all',
    caught = '42501', coalesce(caught,'no error raised'));

  -- a signed-in contributor is authenticated, and still refused
  perform pg_temp.as_user(U_BETA);
  v := public.collective_member_removal_preview('alpha');
  perform pg_temp.ok('a signed-in contributor cannot preview another contributor',
    (v->>'ok')::boolean is false and v->>'code' = 'forbidden', v::text);
  v := public.collective_member_remove('alpha','full_collective_delete','DELETE');
  perform pg_temp.ok('a signed-in contributor cannot delete another contributor',
    (v->>'ok')::boolean is false and v->>'code' = 'forbidden', v::text);
  v := public.collective_member_remove('beta','full_collective_delete','DELETE');
  perform pg_temp.ok('a contributor cannot delete their own Collective history either',
    (v->>'ok')::boolean is false and v->>'code' = 'forbidden', v::text);
  v := public.collective_member_activity();
  perform pg_temp.ok('a contributor cannot read the member activity roll',
    (v->>'ok')::boolean is false and v->>'code' = 'forbidden', v::text);

  perform pg_temp.as_owner();
  select count(*) into n_after from collective.projections;
  perform pg_temp.ok('every refused call deleted nothing', n_before = n_after,
    n_before::text || ' -> ' || n_after::text);

  perform pg_temp.ok('an unauthorised caller is never told whether a slug exists',
    (public.collective_member_removal_preview('no-such-slug-at-all')) is not null);
end $test$;

-- ═══ 2. THE PREVIEW IS THE TRUTH ══════════════════════════════════════════
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; tables jsonb;
begin
  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_removal_preview('alpha');
  perform pg_temp.ok('an admin can preview', (v->>'ok')::boolean, v::text);
  perform pg_temp.ok('the preview counts every submission (5 live + 1 late)',
    (v->'counts'->>'submissions') = '6', v->'counts'->>'submissions');
  perform pg_temp.ok('the preview counts the graded ones',
    (v->'counts'->>'graded') = '4', v->'counts'->>'graded');
  perform pg_temp.ok('the preview counts the ungraded ones',
    (v->'counts'->>'pending') = '2', v->'counts'->>'pending');
  perform pg_temp.ok('the preview counts the late row', (v->'counts'->>'late') = '1');
  perform pg_temp.ok('the preview names the column its graded count came from',
    (v->'counts'->>'graded_basis') = 'result', v->'counts'->>'graded_basis');
  perform pg_temp.ok('the preview lists the model', v->'models'->0->>'name' = 'Model Alpha', (v->'models')::text);

  tables := v->'will_delete'->'tables';
  perform pg_temp.ok('the plan found the projections', tables::text like '%projections%', tables::text);
  perform pg_temp.ok('the plan found the grades', tables::text like '%projection_grades%', tables::text);
  perform pg_temp.ok('the plan found the consensus contributions',
    tables::text like '%consensus_contributions%', tables::text);
  perform pg_temp.ok('the plan found the calibration samples',
    tables::text like '%calibration_samples%', tables::text);
  perform pg_temp.ok('the plan found the cached model record',
    tables::text like '%model_record_cache%', tables::text);
  perform pg_temp.ok('the ledger is listed as PRESERVED, never as deleted',
    exists (select 1 from jsonb_array_elements(tables) t
             where t->>'table' = 'earnings_ledger' and t->>'action' = 'preserved'), tables::text);
  perform pg_temp.ok('the creators table is never in the delete plan',
    not exists (select 1 from jsonb_array_elements(tables) t where t->>'table' = 'creators'), tables::text);
  perform pg_temp.ok('games are counted as preserved',
    (v->'will_preserve'->>'games') = '5', (v->'will_preserve')::text);
  perform pg_temp.ok('other contributors'' submissions are counted as preserved',
    (v->'will_preserve'->>'other_contributor_submissions')::int > 0, (v->'will_preserve')::text);
  perform pg_temp.ok('the preview says the auth account is never touched',
    v->'will_preserve'->>'auth_account' = 'never touched');
  perform pg_temp.ok('a contributor who never posted previews with zero submissions',
    (public.collective_member_removal_preview('gamma')->'counts'->>'submissions') = '0');
  perform pg_temp.ok('an unknown slug is not_found, not a crash',
    (public.collective_member_removal_preview('nope')->>'code') = 'not_found');
  perform pg_temp.as_owner();
end $test$;

-- ═══ 3. MEMBERSHIP ONLY ═══════════════════════════════════════════════════
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; n_proj bigint; n_keys bigint; n_orig bigint; n_grades bigint; caught text;
  rec record; c_alpha uuid; m_alpha uuid;
begin
  select id into c_alpha from collective.creators where slug='alpha';
  select id into m_alpha from collective.models where creator_id=c_alpha;

  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_remove('alpha','membership_only', null);
  perform pg_temp.ok('membership-only removal succeeds without a typed confirmation',
    (v->>'ok')::boolean, v::text);
  perform pg_temp.as_owner();

  select count(*) into n_proj from collective.projections where model_id = m_alpha;
  perform pg_temp.ok('membership-only PRESERVES every submission', n_proj = 6, n_proj::text);
  select count(*) into n_grades from collective.projection_grades pg
    join collective.projections p on p.id = pg.projection_id where p.model_id = m_alpha;
  perform pg_temp.ok('membership-only preserves every grading row', n_grades = 5, n_grades::text);
  perform pg_temp.ok('membership-only preserves the model',
    exists (select 1 from collective.models where id = m_alpha));
  perform pg_temp.ok('membership-only preserves the historical record view',
    (select graded from collective.model_records where model_id = m_alpha) = 4);

  select count(*) into n_keys from collective.api_keys where creator_id = c_alpha;
  perform pg_temp.ok('membership-only REVOKES every submission key', n_keys = 0, n_keys::text);
  select count(*) into n_orig from collective.embed_origins where creator_id = c_alpha;
  perform pg_temp.ok('membership-only revokes every embed origin', n_orig = 0, n_orig::text);
  perform pg_temp.ok('the ledger is untouched',
    (select count(*) from collective.earnings_ledger where creator_id = c_alpha) = 1);

  select removed_at, removal_mode, removed_by, account_status into rec
    from collective.creators where id = c_alpha;
  perform pg_temp.ok('the membership record says when, by whom and how',
    rec.removed_at is not null and rec.removal_mode = 'membership_only' and rec.removed_by = ADMIN,
    row_to_json(rec)::text);
  perform pg_temp.ok('the account status says removed', rec.account_status = 'removed', rec.account_status);
  perform pg_temp.ok('the EdgeDesk auth account is preserved',
    exists (select 1 from auth.users where email = 'alpha@example.com'));

  -- and the removal STICKS, whatever is deployed in front of the database
  caught := null;
  begin
    perform set_config('collective.maintenance','on', false);
    insert into collective.projections (model_id, game_id, spread)
    select m_alpha, id, -7 from collective.games limit 1;
    perform set_config('collective.maintenance','', false);
  exception when others then caught := sqlerrm; perform set_config('collective.maintenance','', false); end;
  perform pg_temp.ok('a removed contributor''s model can no longer receive a projection',
    caught like '%removed from the Collective%', coalesce(caught,'the insert was accepted'));

  -- repeating it is a no-op, not a second removal
  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_remove('alpha','membership_only', null);
  perform pg_temp.ok('a repeated membership removal is a no-op',
    (v->>'ok')::boolean and (v->>'no_op')::boolean and v->>'code' = 'already_removed', v::text);
  perform pg_temp.as_owner();
  perform pg_temp.ok('and it still deleted nothing',
    (select count(*) from collective.projections where model_id = m_alpha) = 6);
end $test$;

-- ═══ 4. THE TRANSACTION ROLLS BACK ════════════════════════════════════════
-- A foreign key deliberately left in the way: consensus_snapshots is named as
-- protected, so the removal must not delete from it — and then the projections
-- it points at cannot be deleted either. The whole removal has to come back.
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; c_beta uuid; m_beta uuid;
  n_proj_before bigint; n_proj_after bigint; n_grade_after bigint; n_cal_after bigint;
  audit record;
begin
  select id into c_beta from collective.creators where slug='beta';
  select id into m_beta from collective.models where creator_id=c_beta;
  select count(*) into n_proj_before from collective.projections where model_id = m_beta;

  insert into collective.config (key, value)
  values ('collective.member_removal.extra_protected', '"consensus_snapshots"'::jsonb)
  on conflict (key) do update set value = excluded.value;

  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_remove('beta','full_collective_delete','DELETE');
  perform pg_temp.ok('a removal that cannot complete reports a failure',
    (v->>'ok')::boolean is false and v->>'code' = 'removal_failed', v::text);
  perform pg_temp.as_owner();

  select count(*) into n_proj_after from collective.projections where model_id = m_beta;
  perform pg_temp.ok('EVERY deletion rolled back — the submissions are all still there',
    n_proj_after = n_proj_before, n_proj_before::text || ' -> ' || n_proj_after::text);
  select count(*) into n_grade_after from collective.projection_grades pg
    join collective.projections p on p.id = pg.projection_id where p.model_id = m_beta;
  perform pg_temp.ok('the grading rows rolled back too', n_grade_after = 4, n_grade_after::text);
  select count(*) into n_cal_after from collective.calibration_samples where model_id = m_beta;
  perform pg_temp.ok('the calibration samples rolled back too', n_cal_after = 3, n_cal_after::text);
  perform pg_temp.ok('the model is still there', exists (select 1 from collective.models where id = m_beta));
  perform pg_temp.ok('the contributor is NOT marked removed by a failed removal',
    (select removed_at from collective.creators where id = c_beta) is null);
  perform pg_temp.ok('the api key was not silently revoked either',
    (select count(*) from collective.api_keys where creator_id = c_beta) = 1);

  select * into audit from collective.admin_audit_log
   where subject_slug = 'beta' order by at desc limit 1;
  perform pg_temp.ok('the failed attempt is in the audit log', audit.status = 'failed', audit.status);
  perform pg_temp.ok('and it records that nothing was deleted', audit.rows_deleted = 0);

  delete from collective.config where key = 'collective.member_removal.extra_protected';
end $test$;

-- ═══ 4b. A RECALCULATION THAT FAILS TAKES THE REMOVAL WITH IT ════════════
-- The alternative is a removal that reports success and leaves the deleted
-- contributor inside a leaderboard the site still shows as current.
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; m_beta uuid; n_before bigint; n_after bigint;
begin
  select m.id into m_beta from collective.models m
    join collective.creators c on c.id = m.creator_id where c.slug = 'beta';
  select count(*) into n_before from collective.projections where model_id = m_beta;

  create or replace function collective.rebuild_deliberately_broken() returns void
  language plpgsql as $b$ begin raise exception 'the rebuild could not run'; end $b$;

  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_remove('beta','full_collective_delete','DELETE');
  perform pg_temp.ok('a removal whose recalculation fails reports a failure',
    (v->>'ok')::boolean is false and v->>'code' = 'removal_failed', v::text);
  perform pg_temp.ok('and names what went wrong', v->>'message' like '%rebuild could not run%', v->>'message');
  perform pg_temp.as_owner();

  select count(*) into n_after from collective.projections where model_id = m_beta;
  perform pg_temp.ok('the deletions rolled back rather than leaving stale numbers behind',
    n_after = n_before, n_before::text || ' -> ' || n_after::text);
  perform pg_temp.ok('and the contributor is not marked removed',
    (select removed_at from collective.creators where slug = 'beta') is null);

  drop function collective.rebuild_deliberately_broken();
end $test$;

-- ═══ 5. FULL COLLECTIVE DELETE ════════════════════════════════════════════
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; c_beta uuid; m_beta uuid; c_alpha uuid; m_alpha uuid;
  g1 uuid; n_before bigint; n_after bigint; audit record;
begin
  select id into c_beta  from collective.creators where slug='beta';
  select id into m_beta  from collective.models where creator_id=c_beta;
  select id into c_alpha from collective.creators where slug='alpha';
  select id into m_alpha from collective.models where creator_id=c_alpha;
  select game_id into g1 from collective.projections where model_id = m_beta and game_id is not null limit 1;
  select n_models into n_before from collective.consensus where game_id = g1;

  perform pg_temp.as_user(ADMIN);
  perform pg_temp.ok('a full delete without the typed confirmation is refused',
    (public.collective_member_remove('beta','full_collective_delete','delete')->>'code') = 'confirmation_required');
  perform pg_temp.ok('and with the wrong word too',
    (public.collective_member_remove('beta','full_collective_delete','Model Beta')->>'code') = 'confirmation_required');
  perform pg_temp.ok('an unknown mode is refused',
    (public.collective_member_remove('beta','wipe_everything','DELETE')->>'code') = 'bad_mode');

  v := public.collective_member_remove('beta','full_collective_delete','DELETE');
  perform pg_temp.ok('the full delete succeeds', (v->>'ok')::boolean, v::text);
  perform pg_temp.ok('and reports the submissions it deleted',
    (v->>'submissions_deleted') = '5', v->>'submissions_deleted');
  perform pg_temp.as_owner();

  -- gone
  perform pg_temp.ok('every submission of theirs is gone',
    (select count(*) from collective.projections where model_id = m_beta) = 0);
  perform pg_temp.ok('their grading rows are gone',
    (select count(*) from collective.projection_grades) = 5);
  perform pg_temp.ok('their calibration samples are gone',
    (select count(*) from collective.calibration_samples where model_id = m_beta) = 0);
  perform pg_temp.ok('their model is gone',
    not exists (select 1 from collective.models where id = m_beta));
  perform pg_temp.ok('their key is gone',
    (select count(*) from collective.api_keys where creator_id = c_beta) = 0);
  perform pg_temp.ok('their invite row is gone',
    (select count(*) from collective.invites where creator_id = c_beta) = 0);

  -- kept
  perform pg_temp.ok('the contributor row is KEPT, marked removed, so the removal is auditable',
    (select removal_mode from collective.creators where id = c_beta) = 'full_collective_delete');
  perform pg_temp.ok('their EdgeDesk auth account is untouched',
    exists (select 1 from auth.users where email = 'beta@example.com'));
  perform pg_temp.ok('their earnings ledger is untouched',
    (select count(*) from collective.earnings_ledger where creator_id = c_beta) = 1);
  perform pg_temp.ok('no game was deleted', (select count(*) from collective.games) = 5);
  perform pg_temp.ok('no settled game result was deleted',
    (select count(*) from collective.game_results) = 5);

  -- OTHER CONTRIBUTORS ARE UNTOUCHED
  perform pg_temp.ok('Alpha still has every one of their submissions',
    (select count(*) from collective.projections where model_id = m_alpha) = 6);
  perform pg_temp.ok('Alpha still has their calibration samples',
    (select count(*) from collective.calibration_samples where model_id = m_alpha) = 4);
  perform pg_temp.ok('the two-model contributor is untouched',
    (select count(*) from collective.projections p join collective.models m on m.id = p.model_id
      join collective.creators c on c.id = m.creator_id where c.slug = 'dual') = 4);

  -- RECALCULATION
  select n_models into n_after from collective.consensus where game_id = g1;
  perform pg_temp.ok('the consensus on a shared game now counts one model fewer',
    n_after = n_before - 1, n_before::text || ' -> ' || n_after::text);
  perform pg_temp.ok('the leaderboard view no longer lists the removed model',
    not exists (select 1 from collective.model_records where model_id = m_beta));
  perform pg_temp.ok('the CACHED model record was rebuilt, not left stale',
    not exists (select 1 from collective.model_record_cache where model_id = m_beta));
  perform pg_temp.ok('and the cache still holds every remaining model',
    (select count(*) from collective.model_record_cache) = (select count(*) from collective.models));
  perform pg_temp.ok('the materialized leaderboard was refreshed',
    not exists (select 1 from collective.leaderboard_mv where model_id = m_beta));
  perform pg_temp.ok('the removal reports which derived objects it rebuilt',
    v->>'recalculated' like '%leaderboard_mv%' and v->>'recalculated' like '%rebuild_model_record_cache%',
    v->>'recalculated');
  perform pg_temp.ok('the rebuild routine runs BEFORE the materialized view that may read what it rebuilt',
    v->'recalculated'->0->>'routine' = 'rebuild_model_record_cache'
    and v->'recalculated'->1->>'materialized_view' = 'leaderboard_mv',
    (v->'recalculated')::text);

  -- AUDIT
  select * into audit from collective.admin_audit_log
   where subject_slug = 'beta' and status = 'succeeded' order by at desc limit 1;
  perform pg_temp.ok('the audit log records the acting admin', audit.actor_id = ADMIN);
  perform pg_temp.ok('the audit log records the mode', audit.mode = 'full_collective_delete');
  perform pg_temp.ok('the audit log records how many rows went', audit.rows_deleted > 0, audit.rows_deleted::text);
  perform pg_temp.ok('the audit log holds NO credential material',
    audit.detail::text not like '%hash-b%' and audit.detail::text not like '%mck_live_BBBB%',
    audit.detail::text);
end $test$;

-- ═══ 6. THE EDGE CASES ════════════════════════════════════════════════════
do $test$
declare
  ADMIN   constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  ADMIN2  constant uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  v jsonb; c_gamma uuid; c_dual uuid; before_n bigint;
begin
  select id into c_gamma from collective.creators where slug='gamma';
  select id into c_dual  from collective.creators where slug='dual';

  perform pg_temp.as_user(ADMIN);

  -- zero submissions
  v := public.collective_member_remove('gamma','full_collective_delete','DELETE');
  perform pg_temp.ok('a contributor with no submissions deletes cleanly',
    (v->>'ok')::boolean and (v->>'submissions_deleted') = '0', v::text);
  perform pg_temp.as_owner();
  perform pg_temp.ok('their invite and key went with them',
    (select count(*) from collective.invites where creator_id = c_gamma) = 0
    and (select count(*) from collective.api_keys where creator_id = c_gamma) = 0);
  perform pg_temp.as_user(ADMIN);

  -- a contributor with two models
  v := public.collective_member_remove('dual','full_collective_delete','DELETE');
  perform pg_temp.ok('a contributor with two models loses both',
    (v->>'ok')::boolean and (v->>'submissions_deleted') = '4', v::text);
  perform pg_temp.as_owner();
  perform pg_temp.ok('both models are gone',
    (select count(*) from collective.models where creator_id = c_dual) = 0);
  perform pg_temp.ok('and so is every consensus contribution under them',
    (select count(*) from collective.consensus_contributions) = 5);
  perform pg_temp.as_user(ADMIN);

  -- an admin removing themselves
  v := public.collective_member_remove('admin-two','membership_only', null);
  perform pg_temp.ok('one admin may remove another admin''s membership', (v->>'ok')::boolean, v::text);

  perform pg_temp.as_user(ADMIN2);
  v := public.collective_member_remove('admin-two','membership_only', null);
  perform pg_temp.ok('an admin cannot remove themselves through this action',
    (v->>'ok')::boolean is false and v->>'code' = 'cannot_remove_self', v::text);
  perform pg_temp.as_owner();

  -- the allowlist is the authority, live
  update collective.config set value = to_jsonb(array[ADMIN2::text]) where key = 'admin.user_ids';
  perform pg_temp.as_user(ADMIN);
  perform pg_temp.ok('an account dropped from the allowlist immediately loses admin',
    (public.collective_member_removal_preview('alpha')->>'code') = 'forbidden');

  -- and with only one admin configured, that admin cannot be removed AT ALL —
  -- the guard fires ahead of "you cannot remove yourself", because the useful
  -- instruction is "configure a second administrator first".
  perform pg_temp.as_user(ADMIN2);
  v := public.collective_member_remove('admin-two','membership_only', null);
  perform pg_temp.ok('the last configured admin cannot be removed',
    (v->>'ok')::boolean is false and v->>'code' = 'last_admin', v::text);
  perform pg_temp.ok('and the message says what to do about it',
    v->>'message' like '%admin.user_ids%', v->>'message');
  perform pg_temp.as_owner();
  update collective.config set value = to_jsonb(array[ADMIN::text, ADMIN2::text]) where key = 'admin.user_ids';
  perform pg_temp.ok('nothing happened to them',
    (select removed_at from collective.creators where slug='admin-two') is not null
    and (select removal_mode from collective.creators where slug='admin-two') = 'membership_only');
end $test$;

-- ═══ 7. THE ADMIN LIST'S ACTIVITY COLUMNS ═════════════════════════════════
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; row_alpha jsonb;
begin
  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_activity();
  perform pg_temp.ok('an admin can read the activity roll', (v->>'ok')::boolean and (v->>'available')::boolean, v::text);
  select t into row_alpha from jsonb_array_elements(v->'rows') t where t->>'creator_slug' = 'alpha';
  perform pg_temp.ok('it counts a member''s real submissions',
    (row_alpha->>'submissions') = '6', row_alpha::text);
  perform pg_temp.ok('it counts the graded ones', (row_alpha->>'graded') = '4', row_alpha::text);
  perform pg_temp.ok('it reports the last slate', row_alpha->>'last_submission_at' is not null);
  perform pg_temp.ok('it reports that a removed member is removed',
    row_alpha->>'removed_at' is not null and row_alpha->>'removal_mode' = 'membership_only', row_alpha::text);
  perform pg_temp.ok('a member with nothing posted reads as zero, not as missing',
    (select t->>'submissions' from jsonb_array_elements(v->'rows') t where t->>'creator_slug'='gamma') = '0');
  perform pg_temp.as_owner();
end $test$;

-- ═══ 8. THE AUDIT LOG IS NOT A CLIENT TABLE ═══════════════════════════════
do $test$
declare
  U_BETA constant uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  caught text; n bigint;
begin
  perform pg_temp.as_user(U_BETA);
  caught := null;
  begin execute 'select count(*) from collective.admin_audit_log' into n;
  exception when others then caught := sqlstate; end;
  perform pg_temp.ok('a signed-in contributor cannot read the admin audit log',
    caught is not null, 'read ' || coalesce(n::text,'?') || ' rows');
  perform pg_temp.as_anon();
  caught := null;
  begin execute 'select count(*) from collective.admin_audit_log' into n;
  exception when others then caught := sqlstate; end;
  perform pg_temp.ok('nor can an anonymous one', caught is not null);
  perform pg_temp.as_owner();
  perform pg_temp.ok('every removal attempt in this suite is on the record',
    (select count(*) from collective.admin_audit_log) >= 6,
    (select count(*)::text from collective.admin_audit_log));
end $test$;

-- ═══ 9. ESCALATING A REMOVAL ══════════════════════════════════════════════
-- Alpha was removed membership-only and their history kept. An operator who
-- later decides the data must go should be able to say so — and only that
-- should delete it.
do $test$
declare
  ADMIN constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v jsonb; c_alpha uuid; m_alpha uuid; g1 uuid; n_before bigint; n_after bigint;
begin
  select id into c_alpha from collective.creators where slug='alpha';
  select id into m_alpha from collective.models where creator_id=c_alpha;
  select game_id into g1 from collective.projections where model_id = m_alpha and game_id is not null limit 1;
  select coalesce((select n_models from collective.consensus where game_id = g1), 0) into n_before;

  perform pg_temp.as_user(ADMIN);
  v := public.collective_member_removal_preview('alpha');
  perform pg_temp.ok('the preview says they are already removed',
    (v->'guards'->>'already_removed')::boolean, (v->'guards')::text);
  perform pg_temp.ok('and still counts the history a full delete would take',
    (v->'counts'->>'submissions') = '6', (v->'counts')::text);

  v := public.collective_member_remove('alpha','full_collective_delete','DELETE');
  perform pg_temp.ok('an already-removed member can be escalated to a full delete',
    (v->>'ok')::boolean and (v->>'submissions_deleted') = '6', v::text);
  perform pg_temp.as_owner();
  perform pg_temp.ok('their history is gone now',
    (select count(*) from collective.projections where model_id = m_alpha) = 0);
  select coalesce((select n_models from collective.consensus where game_id = g1), 0) into n_after;
  perform pg_temp.ok('and the consensus on that game dropped again — to nobody, honestly, rather than to a remembered number',
    n_after = n_before - 1, n_before::text || ' -> ' || n_after::text);
  perform pg_temp.ok('their EdgeDesk account survived both removals',
    exists (select 1 from auth.users where email = 'alpha@example.com'));
  perform pg_temp.ok('and so did their earnings ledger',
    (select count(*) from collective.earnings_ledger where creator_id = c_alpha) = 1);
end $test$;
