-- portfolio_connect -- part 4 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- Forget an account's cursor, so its next sync re-reads the whole history
-- (the smoke test's NO DUPLICATES stage; an operator's repair).
create or replace function public.portfolio_svc_reset_cursor(p_account uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update public.platform_accounts set sync_cursor = null, next_sync_at = now() where id = p_account and connection_type = 'API';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. WHAT A READER CALLS
-- ─────────────────────────────────────────────────────────────────────────────
-- Disconnect one of MY automatic accounts. Runs as the definer to reach the
-- credential row, and checks the account is the caller's before touching it.
create or replace function public.portfolio_disconnect(p_account uuid, p_delete_history boolean default false)
returns jsonb language plpgsql security definer set search_path = public, portfolio_private, pg_temp as $$
declare a record; me uuid := auth.uid(); cred int; pos int := 0;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  select id, connection_type into a from public.platform_accounts where id = p_account and user_id = me;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  if a.connection_type not in ('API', 'OAUTH', 'AGGREGATOR') then raise exception 'portfolio: only an automatic account is disconnected' using errcode = '22023'; end if;
  /* the account is the caller's: what follows is the connector's own change
     (status, the credential note), which the account's guard keeps from
     readers — so the rest of this transaction runs without the reader's
     identity, on the one account checked above */
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  delete from portfolio_private.platform_credentials where platform_account_id = p_account and user_id = me;
  get diagnostics cred = row_count;
  if p_delete_history then
    delete from public.portfolio_positions where platform_account_id = p_account and user_id = me and source = 'SYNC';
    get diagnostics pos = row_count;
    delete from public.platform_accounts where id = p_account and user_id = me;
  else
    update public.platform_accounts set status = 'DISCONNECTED', next_sync_at = null, metadata = metadata - 'credential'
     where id = p_account and user_id = me;
  end if;
  return jsonb_build_object('credential_deleted', cred > 0, 'positions_deleted', pos);
end $$;

-- The operator's view of every connector: run counts, failure codes and
-- timings by platform over a window. Counts only: no reader, no position,
-- no credential.
create or replace function public.portfolio_admin_connector_health(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return (select jsonb_build_object('window_hours', greatest(1, least(p_hours, 720)), 'platforms', coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb),
      'registry', (select jsonb_agg(jsonb_build_object('platform', g.platform_key, 'automatic_method', g.automatic_method, 'connector_version', g.connector_version,
         'automatic_enabled', g.automatic_enabled, 'enabled_at', g.enabled_at, 'tos_review', g.tos_review, 'docs_verified_on', g.docs_verified_on,
         'import_verified', g.import_verified) order by g.platform_key) from public.portfolio_platform_registry g),
      'accounts', (select jsonb_object_agg(k, v) from (select status as k, count(*) as v from public.platform_accounts where connection_type = 'API' group by status) q))
    from (select jsonb_build_object('platform', r.platform, 'runs', count(*), 'succeeded', count(*) filter (where r.status = 'SUCCEEDED'),
            'partial', count(*) filter (where r.status = 'PARTIAL'), 'failed', count(*) filter (where r.status = 'FAILED'),
            'running', count(*) filter (where r.status = 'RUNNING'),
            'p50_ms', percentile_cont(0.5) within group (order by r.duration_ms), 'p95_ms', percentile_cont(0.95) within group (order by r.duration_ms),
            'rejected', sum(r.rejected), 'transactions_inserted', sum(r.transactions_inserted),
            'errors', (select jsonb_object_agg(code, c) from (select r2.error_code as code, count(*) as c from public.portfolio_sync_runs r2
                        where r2.platform = r.platform and r2.started_at > now() - make_interval(hours => greatest(1, least(p_hours, 720))) and r2.error_code is not null
                        group by r2.error_code) e),
            'last_success', max(r.finished_at) filter (where r.status in ('SUCCEEDED', 'PARTIAL'))) as x
            from public.portfolio_sync_runs r where r.started_at > now() - make_interval(hours => greatest(1, least(p_hours, 720))) group by r.platform) t);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_platform_registry enable row level security;
alter table public.portfolio_sync_runs enable row level security;
drop policy if exists portfolio_registry_read on public.portfolio_platform_registry;
create policy portfolio_registry_read on public.portfolio_platform_registry for select to authenticated using (true);
drop policy if exists portfolio_sync_runs_own on public.portfolio_sync_runs;
create policy portfolio_sync_runs_own on public.portfolio_sync_runs for select to authenticated using (user_id = auth.uid());

revoke all on public.portfolio_platform_registry, public.portfolio_sync_runs from public, anon;
revoke all on public.portfolio_platform_registry, public.portfolio_sync_runs from authenticated;
grant select on public.portfolio_platform_registry, public.portfolio_sync_runs to authenticated;
grant select, insert, update, delete on public.portfolio_platform_registry, public.portfolio_sync_runs to service_role;

revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions from public;
do $$ begin
  execute 'revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions to service_role';
end $$;

-- Service functions: the service role only. Reader functions: signed-in readers.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_%' or p.proname in ('portfolio_disconnect', 'portfolio_admin_connector_health',
              'portfolio_is_admin', 'portfolio_registry_guard', 'portfolio_smoke_stages', 'portfolio_smoke_all_ok')) loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname like 'portfolio\_svc\_%' or f.proname = 'portfolio_registry_guard' then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the registry, sync runs, smoke tests and connect sessions exist' as item,
    case when to_regclass('public.portfolio_platform_registry') is not null and to_regclass('public.portfolio_sync_runs') is not null
      and to_regclass('portfolio_private.connector_smoke_tests') is not null and to_regclass('portfolio_private.connect_sessions') is not null
      then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'no connector is switched on without a passing live smoke test',
    case when not exists (select 1 from public.portfolio_platform_registry g where g.automatic_enabled and not exists (
      select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test and t.status = 'PASSED' and t.connector_version = g.connector_version))
      then 'ok' else 'CHECK THIS — a connector is on without its evidence' end
  union all select 3, 'no sportsbook has an automatic method',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK' and automatic_method is not null) then 'ok' else 'CHECK THIS' end
  union all select 4, 'readers cannot call a service function, read a credential or a smoke test',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'portfolio\_svc\_%'
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage')
      then 'ok' else 'CHECK THIS — a service function or the private schema is reachable by a reader' end
  union all select 5, 'sync runs: row level security on, the reader''s own only',
    case when (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'portfolio_sync_runs')
      and exists (select 1 from pg_policies where tablename = 'portfolio_sync_runs' and qual like '%user_id = auth.uid()%') then 'ok' else 'CHECK THIS' end
  union all select 6, 'anon reads nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_platform_registry', 'select') and not has_table_privilege('anon', 'public.portfolio_sync_runs', 'select')
      then 'ok' else 'CHECK THIS' end
) r order by 1;

