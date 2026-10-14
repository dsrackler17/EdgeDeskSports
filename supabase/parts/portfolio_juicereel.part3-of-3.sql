-- portfolio_juicereel -- part 3 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- The operator's view of Juice Reel connections: grants by status and how
-- recently they synced. Counts only — no reader, token or Juice Reel id.
create or replace function public.portfolio_admin_juicereel_health()
returns jsonb language plpgsql stable security definer set search_path = public, portfolio_private, pg_temp as $$
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'grants', (select coalesce(jsonb_object_agg(environment || ':' || status, n), '{}'::jsonb) from (select environment, status, count(*) as n
        from portfolio_private.oauth_grants where provider = 'juicereel' group by environment, status) q),
    'errors', (select coalesce(jsonb_object_agg(last_error_code, n), '{}'::jsonb) from (select last_error_code, count(*) as n
        from portfolio_private.oauth_grants where provider = 'juicereel' and last_error_code is not null group by last_error_code) q),
    'synced_last_24h', (select count(*) from portfolio_private.oauth_grants where provider = 'juicereel' and last_success_at > now() - interval '24 hours'),
    'overdue', (select count(*) from portfolio_private.oauth_grants where provider = 'juicereel' and status in ('CONNECTED', 'ERROR')
        and next_sync_at < now() - interval '1 hour'));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. GRANTS: the service role only (and the operator panel checks its caller)
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on portfolio_private.oauth_grants from public;
do $$ begin
  execute 'revoke all on portfolio_private.oauth_grants from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.oauth_grants to service_role';
end $$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_jr\_%' or p.proname = 'portfolio_admin_juicereel_health') loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname = 'portfolio_admin_juicereel_health' then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    else
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the grants table exists in the private schema, row level security on, no policy' as item,
    case when to_regclass('portfolio_private.oauth_grants') is not null
      and (select relrowsecurity from pg_class where oid = 'portfolio_private.oauth_grants'::regclass)
      and not exists (select 1 from pg_policies where schemaname = 'portfolio_private' and tablename = 'oauth_grants')
      then 'ok' else 'CHECK THIS' end as outcome
  union all select 2, 'tokens are stored only as ciphertext (no text column can hold one)',
    -- every text or JSON column is one of these, none of which a token is ever written to
    case when not exists (select 1 from information_schema.columns where table_schema = 'portfolio_private' and table_name = 'oauth_grants'
        and data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
        and column_name not in ('provider', 'environment', 'provider_user_id', 'display_name', 'status', 'scopes', 'sync_cursor', 'last_error_code',
                                'last_error', 'last_issues'))
      and (select data_type from information_schema.columns where table_schema = 'portfolio_private' and table_name = 'oauth_grants' and column_name = 'ciphertext') = 'bytea'
      then 'ok' else 'CHECK THIS' end
  union all select 3, 'Juice Reel is registered as an aggregator, and is on only with its evidence',
    case when exists (select 1 from public.portfolio_platform_registry g where g.platform_key = 'juicereel' and g.automatic_method = 'AUTHORIZED_API'
        and g.source_type = 'SPORTSBOOK'
        and (not g.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test
              and t.status = 'PASSED' and t.environment = 'PRODUCTION' and t.connector_version = g.connector_version and g.tos_review = 'CLEARED')))
      then 'ok' else 'CHECK THIS — the row is missing, or on without a passing PRODUCTION smoke test and a cleared terms review' end
  union all select 4, 'readers cannot call a Juice Reel service function, or reach the grants',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
           and p.proname like 'portfolio\_svc\_jr\_%'
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_table_privilege('authenticated', 'portfolio_private.oauth_grants', 'select')
      and not has_table_privilege('anon', 'portfolio_private.oauth_grants', 'select')
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage') then 'ok' else 'CHECK THIS — a service function or the grants are reachable by a reader' end
  union all select 5, 'every Juice Reel service function asserts its caller',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'portfolio\_svc\_jr\_%'
           and position('portfolio_svc_assert()' in pg_get_functiondef(p.oid)) = 0) then 'ok' else 'CHECK THIS' end
  union all select 6, 'a reader''s grant goes with their auth account',
    case when exists (select 1 from pg_constraint where conrelid = 'portfolio_private.oauth_grants'::regclass and contype = 'f' and confdeltype = 'c')
      then 'ok' else 'CHECK THIS' end
  union all select 7, '"delete everything" removes the grant too (when portfolio_decision.sql is installed)',
    case when to_regprocedure('public.portfolio_delete_everything(text)') is null then 'ok'
         when position('oauth_grants' in pg_get_functiondef('public.portfolio_delete_everything(text)'::regprocedure)) > 0 then 'ok'
         else 'CHECK THIS — re-apply the current supabase/portfolio_decision.sql' end
  union all select 8, 'no sportsbook has a direct automatic method (only an approved aggregator)',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK'
      and automatic_method is not null and automatic_method <> 'AUTHORIZED_API') then 'ok' else 'CHECK THIS' end
) r order by 1;

