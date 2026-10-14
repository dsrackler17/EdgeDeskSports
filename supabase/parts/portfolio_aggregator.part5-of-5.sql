-- portfolio_aggregator -- part 5 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

grant select on public.portfolio_refresh_requests, public.portfolio_position_settlements to authenticated;
grant select, insert, update, delete on public.portfolio_refresh_requests, public.portfolio_position_settlements to service_role;
grant usage, select on sequence public.portfolio_position_settlements_id_seq to service_role;

revoke all on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections from public;
do $$ begin
  execute 'revoke all on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections to service_role';
  execute 'grant usage on sequence portfolio_private.aggregator_webhook_events_id_seq, portfolio_private.aggregator_webhook_rejections_id_seq to service_role';
end $$;

-- service functions: the service role only (portfolio.sql's reader loop
-- skips portfolio_svc_*, and each one asserts its caller as well)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_ag\_%' or p.proname in ('portfolio_svc_ingest_wagers', 'portfolio_position_settlements_frozen')) loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    if f.proname <> 'portfolio_position_settlements_frozen' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  -- the operator panel checks its caller itself
  revoke all on function public.portfolio_admin_aggregator_health(int) from public, anon;
  grant execute on function public.portfolio_admin_aggregator_health(int) to authenticated, service_role;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the bettor, webhook, refresh and settlement tables exist' as item,
    case when to_regclass('portfolio_private.aggregator_bettors') is not null and to_regclass('portfolio_private.aggregator_webhook_events') is not null
      and to_regclass('portfolio_private.aggregator_webhook_rejections') is not null and to_regclass('public.portfolio_refresh_requests') is not null
      and to_regclass('public.portfolio_position_settlements') is not null then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'SharpSports is registered as an aggregator, and is on only with its evidence',
    case when exists (select 1 from public.portfolio_platform_registry g where g.platform_key = 'sharpsports' and g.automatic_method = 'AUTHORIZED_API'
        and (not g.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test
              and t.status = 'PASSED' and t.connector_version = g.connector_version and g.tos_review = 'CLEARED')))
      then 'ok' else 'CHECK THIS — the row is missing, or on without a passing smoke test and a cleared terms review' end
  union all select 3, 'no sportsbook has a direct automatic method (only an approved aggregator)',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK'
      and automatic_method is not null and automatic_method <> 'AUTHORIZED_API') then 'ok' else 'CHECK THIS' end
  union all select 4, 'readers cannot call an aggregator service function, or reach the private tables',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
           and (p.proname like 'portfolio\_svc\_ag\_%' or p.proname = 'portfolio_svc_ingest_wagers')
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage') and not has_schema_privilege('anon', 'portfolio_private', 'usage')
      then 'ok' else 'CHECK THIS — a service function or the private schema is reachable by a reader' end
  union all select 5, 'refresh requests and settlements: row level security on, the reader''s own, read-only',
    case when (select bool_and(rowsecurity) from pg_tables where schemaname = 'public' and tablename in ('portfolio_refresh_requests', 'portfolio_position_settlements'))
      and (select count(*) from pg_policies where schemaname = 'public' and tablename in ('portfolio_refresh_requests', 'portfolio_position_settlements')
             and qual like '%user_id = auth.uid()%' and cmd = 'SELECT') = 2
      and not has_table_privilege('authenticated', 'public.portfolio_refresh_requests', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_position_settlements', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_position_settlements', 'delete') then 'ok' else 'CHECK THIS' end
  union all select 6, 'the settlement history is append-only',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_position_settlements_frozen_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select 7, 'anon reads nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_refresh_requests', 'select') and not has_table_privilege('anon', 'public.portfolio_position_settlements', 'select')
      then 'ok' else 'CHECK THIS' end
  union all select 8, 'the run lifecycle serves aggregator accounts (portfolio_connect.sql is current)',
    case when position('AGGREGATOR' in pg_get_functiondef('public.portfolio_svc_run_begin(uuid,text)'::regprocedure)) > 0
      and position('RELINK_REQUIRED' in pg_get_functiondef('public.portfolio_svc_run_finish(uuid,text,text,text,text,jsonb)'::regprocedure)) > 0
      then 'ok' else 'CHECK THIS — re-apply supabase/portfolio_connect.sql' end
) r order by 1;

