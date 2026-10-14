-- ===========================================================================
-- supabase/server_only_lockdown.sql, attacked on a real PostgreSQL.
--
-- Run after server_only_lockdown_fixture.sql and the shipped file. Every
-- attack the August audit described is made here as the role that made it,
-- and every caller the lockdown must not break is made as the role it runs as:
-- the Collective edge functions as service_role, RLS as authenticated, the
-- browser's wrappers as a signed-in user.
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end; $$;

create or replace function pg_temp.as_role(p_role text, p_sub text default '') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub, false);
  execute format('set local role %I', p_role);
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

-- Runs p_sql as p_role. Returns null when it succeeded, and the error text when
-- the database refused it.
create or replace function pg_temp.try_as(p_role text, p_sql text) returns text
language plpgsql as $$
declare v_err text;
begin
  perform pg_temp.as_role(p_role, case when p_role = 'authenticated'
                                       then '00000000-0000-0000-0000-0000000000b1' else '' end);
  begin
    execute p_sql;
  exception when others then
    v_err := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.as_owner();
  return v_err;
end; $$;

do $test$
declare
  r      text;
  role_  text;
  stmt   text;
  attacks text[] := array[
    'select collective.get_config(''admin.user_ids'')',
    'select collective.get_config()',
    'select collective.billing_upsert_subscriber(''00000000-0000-0000-0000-0000000000ff'', ''active'')',
    'call collective.nightly_sweep()',
    'select public.edge_call(''settle'', ''{}''::jsonb, 1000, null)',
    'select public.guarantee_sweep()',
    'select public.research_set_status(gen_random_uuid(), ''x'', null)',
    'select public.research_rebuild_patterns(30)',
    'select public.research_register_validation(gen_random_uuid(), 1, 1, ''{}''::jsonb, true)',
    'select public.research_complete_validation(gen_random_uuid(), 1, 1, 1)',
    'select * from public.ai_cost_per_user',
    'select * from public.guarantee_refunds_due',
    'select * from public.partner_rollup'
  ];
begin
  -- ── 1. every attack the audit described is refused, for both client roles ──
  foreach role_ in array array['anon', 'authenticated'] loop
    foreach stmt in array attacks loop
      r := pg_temp.try_as(role_, stmt);
      perform pg_temp.ok(role_ || ' is refused: ' || stmt,
        r like '42501 %', coalesce(r, 'it succeeded'));
    end loop;
  end loop;

  -- The refusal is the function's EXECUTE, not the schema. The lockdown takes
  -- nothing from USAGE, so the API keeps routing to collective for the reads
  -- that are meant to work.
  r := pg_temp.try_as('anon', 'select collective.get_config(''admin.user_ids'')');
  perform pg_temp.ok('anon is refused on the function itself, not the schema',
    r ilike '%permission denied for function%', r);
  perform pg_temp.ok('the lockdown left USAGE on collective alone',
    has_schema_privilege('anon', 'collective', 'USAGE'));

  -- The forged subscription the audit described did not land.
  perform pg_temp.ok('no subscriber was forged by the refused calls',
    not exists (select 1 from collective.subscribers
                 where user_id = '00000000-0000-0000-0000-0000000000ff'));

  -- ── 2. the server keeps everything ─────────────────────────────────────────
  foreach stmt in array attacks loop
    r := pg_temp.try_as('service_role', stmt);
    perform pg_temp.ok('service_role still runs: ' || stmt, r is null, r);
  end loop;
  perform pg_temp.ok('service_role''s billing write landed',
    exists (select 1 from collective.subscribers
             where user_id = '00000000-0000-0000-0000-0000000000ff' and status = 'active'));
  perform pg_temp.ok('service_role now holds collective EXECUTE explicitly, not only through PUBLIC',
    exists (select 1
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                   aclexplode(p.proacl) a
             where n.nspname = 'collective' and p.proname = 'get_config'
               and a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE'));
  perform pg_temp.ok('PUBLIC holds no EXECUTE on any collective routine',
    not exists (select 1
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                       aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where n.nspname = 'collective' and a.grantee = 0));

  -- ── 3. what the lockdown must not touch ────────────────────────────────────
  r := pg_temp.try_as('authenticated', 'select public.has_active_sub()');
  perform pg_temp.ok('authenticated still calls has_active_sub (RLS depends on it)', r is null, r);
  r := pg_temp.try_as('authenticated', 'select public.collective_model_ensure(''nfl'', ''m'')');
  perform pg_temp.ok('a signed-in user still reaches the Collective through collective_model_ensure', r is null, r);
  r := pg_temp.try_as('authenticated', 'select public.collective_my_models()');
  perform pg_temp.ok('a signed-in user still reaches the Collective through collective_my_models', r is null, r);
  r := pg_temp.try_as('anon', 'select public.collective_model_ensure(''nfl'', ''m'')');
  perform pg_temp.ok('the wrapper is still refused to anon, as it was before', r like '42501 %',
    coalesce(r, 'it succeeded'));
  r := pg_temp.try_as('anon', 'select public.public_home_board()');
  perform pg_temp.ok('a public function the lockdown does not name stays callable by anon', r is null, r);
  r := pg_temp.try_as('authenticated', 'select count(*) from public.ai_usage');
  perform pg_temp.ok('the tables under the views keep their own grants', r is null, r);
end
$test$;
