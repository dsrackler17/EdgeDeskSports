-- portfolio_connect -- part 5 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the registry, sync runs, smoke tests, connect sessions and connector events exist' as item,
    case when to_regclass('public.portfolio_platform_registry') is not null and to_regclass('public.portfolio_sync_runs') is not null
      and to_regclass('portfolio_private.connector_smoke_tests') is not null and to_regclass('portfolio_private.connect_sessions') is not null
      and to_regclass('portfolio_private.connector_events') is not null
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

