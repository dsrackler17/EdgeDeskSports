-- portfolio_connect -- part 4 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.portfolio_svc_smoke_finish(p_test uuid)
returns text language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare st text;
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.connector_smoke_tests
     set status = case when public.portfolio_smoke_all_ok(stages) and environment = 'PRODUCTION' then 'PASSED' else 'FAILED' end, finished_at = now()
   where id = p_test and status = 'RUNNING' returning status into st;
  return st;
end $$;
create or replace function public.portfolio_svc_smoke_status(p_test uuid)
returns jsonb language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select to_jsonb(t) from portfolio_private.connector_smoke_tests t where t.id = p_test);
end $$;
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
-- One connection attempt and how it ended (the connect function). Counts only.
create or replace function public.portfolio_svc_connector_event(p_platform text, p_kind text, p_code text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.connector_events (platform_key, kind, code) values (left(p_platform, 48), p_kind, left(p_code, 40));
end $$;

-- What the operator sees: per platform, every sync's outcome and what it
-- moved (records discovered, inserted, updated, duplicates rejected,
-- settlements recorded, rejected, reconciliations); connection attempts and
-- their failures; imports, parser failures and new file layouts. Counts and
-- rates only — never a reader, a credential or a position.
create or replace function public.portfolio_admin_connector_health(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h int := greatest(1, least(coalesce(p_hours, 24), 720)); since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return jsonb_build_object('window_hours', h,
    'platforms', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', r.platform, 'runs', count(*), 'succeeded', count(*) filter (where r.status = 'SUCCEEDED'),
            'partial', count(*) filter (where r.status = 'PARTIAL'), 'failed', count(*) filter (where r.status = 'FAILED'),
            'running', count(*) filter (where r.status = 'RUNNING'),
            'p50_ms', percentile_cont(0.5) within group (order by r.duration_ms), 'p95_ms', percentile_cont(0.95) within group (order by r.duration_ms),
            'discovered', coalesce(sum(r.fetched), 0), 'positions_inserted', coalesce(sum(r.positions_inserted), 0),
            'positions_updated', coalesce(sum(r.positions_updated), 0), 'transactions_inserted', coalesce(sum(r.transactions_inserted), 0),
            'duplicates_rejected', coalesce(sum(r.transactions_unchanged), 0), 'settlements', coalesce(sum(r.positions_settled), 0),
            'rejected', coalesce(sum(r.rejected), 0),
            'reconciled', count(*) filter (where (r.reconcile->>'ok')::boolean is true),
            'reconcile_mismatches', count(*) filter (where (r.reconcile->>'ok')::boolean is false),
            'errors', (select jsonb_object_agg(code, c) from (select r2.error_code as code, count(*) as c from public.portfolio_sync_runs r2
                        where r2.platform = r.platform and r2.started_at > since and r2.error_code is not null group by r2.error_code) e),
            'last_success', max(r.finished_at) filter (where r.status in ('SUCCEEDED', 'PARTIAL'))) as x
          from public.portfolio_sync_runs r where r.started_at > since group by r.platform) t),
    'connections', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', e.platform_key, 'attempts', count(*) filter (where e.kind = 'ATTEMPT'),
            'connected', count(*) filter (where e.kind = 'CONNECTED'), 'failed', count(*) filter (where e.kind = 'FAILED'),
            'disconnected', count(*) filter (where e.kind = 'DISCONNECTED'),
            'failures', (select jsonb_object_agg(code, c) from (select e2.code, count(*) as c from portfolio_private.connector_events e2
                          where e2.platform_key = e.platform_key and e2.at > since and e2.kind = 'FAILED' and e2.code is not null group by e2.code) f)) as x
          from portfolio_private.connector_events e where e.at > since group by e.platform_key) t),
    'imports', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', coalesce(i.platform, 'unknown'), 'files', count(*),
            'committed', count(*) filter (where i.status = 'COMMITTED'), 'failed', count(*) filter (where i.status = 'FAILED'),
            'not_finished', count(*) filter (where i.status in ('STAGED', 'CLASSIFIED')),
            'rows', coalesce(sum(i.rows_total), 0), 'parser_failures', coalesce(sum(i.rows_invalid), 0),
            'files_with_parser_failures', count(*) filter (where i.rows_invalid > 0),
            -- a layout first seen in the window, for a platform imported before
            -- with another layout: the platform may have changed its export
            'new_layouts', (select count(*) from (select i2.header_signature, min(i2.created_at) as first_at from public.portfolio_imports i2
                              where i2.platform is not distinct from i.platform and i2.header_signature is not null group by i2.header_signature) sig
                             where sig.first_at > since
                               and exists (select 1 from public.portfolio_imports i3 where i3.platform is not distinct from i.platform
                                            and i3.header_signature is not null and i3.header_signature <> sig.header_signature and i3.created_at <= since))) as x
          from public.portfolio_imports i where i.created_at > since group by i.platform) t),
    'registry', (select jsonb_agg(jsonb_build_object('platform', g.platform_key, 'automatic_method', g.automatic_method, 'connector_version', g.connector_version,
         'automatic_enabled', g.automatic_enabled, 'enabled_at', g.enabled_at, 'tos_review', g.tos_review, 'docs_verified_on', g.docs_verified_on,
         'import_verified', g.import_verified) order by g.platform_key) from public.portfolio_platform_registry g),
    'accounts', (select jsonb_object_agg(k, v) from (select status as k, count(*) as v from public.platform_accounts where connection_type = 'API' group by status) q));
end $$;

-- Time to value, for the operator: how long readers take from starting setup
-- to a first position and to a ready portfolio, how many abandon setup, and
-- how often imports and connections fail. Medians and rates only; no reader.
create or replace function public.portfolio_admin_ttv(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365))); out jsonb;
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  if to_regclass('public.user_events') is null then
    return jsonb_build_object('window_days', p_days, 'events', false, 'note', 'supabase/funnel.sql is not installed: no event data.');
  end if;
  execute $q$
    with ev as (select user_id, event_name, min(created_at) as at from public.user_events
                 where created_at > $1 and user_id is not null and event_name in ('portfolio_onboarding_started', 'first_position_created', 'portfolio_ready',
                   'connection_started', 'connection_completed', 'import_started', 'import_completed') group by user_id, event_name),
    starts as (select user_id, at from ev where event_name = 'portfolio_onboarding_started'),
    t as (select s.user_id, s.at as started,
                 (select at from ev e where e.user_id = s.user_id and e.event_name = 'first_position_created') as first_pos,
                 (select at from ev e where e.user_id = s.user_id and e.event_name = 'portfolio_ready') as ready
            from starts s)
    select jsonb_build_object(
      'window_days', $2, 'events', true,
      'onboarding_started', (select count(*) from t),
      'time_to_first_position_minutes_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from first_pos - started) / 60))::numeric, 1) from t where first_pos >= started),
      'time_to_portfolio_ready_minutes_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from ready - started) / 60))::numeric, 1) from t where ready >= started),
      'onboarding_abandonment', (select case when count(*) > 0 then round(count(*) filter (where ready is null)::numeric / count(*), 4) end from t where started < now() - interval '7 days'),
      'import_failure_rate', (select case when count(*) > 0 then round(count(*) filter (where status = 'FAILED' or rows_failed > 0)::numeric / count(*), 4) end
                                from public.portfolio_imports where created_at > $1 and status in ('COMMITTED', 'FAILED')),
      'imports_abandoned', (select count(*) from public.portfolio_imports where created_at > $1 and created_at < now() - interval '1 day' and status in ('STAGED', 'CLASSIFIED')),
      'connection_failure_rate', (select case when count(*) > 0 then round(count(*) filter (where not exists (select 1 from ev c where c.user_id = s.user_id
                                    and c.event_name = 'connection_completed' and c.at >= s.at))::numeric / count(*), 4) end
                                    from ev s where s.event_name = 'connection_started'))
  $q$ into out using since, greatest(1, least(p_days, 365));
  return out;
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

revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events from public;
do $$ begin
  execute 'revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events to service_role';
  execute 'grant usage on sequence portfolio_private.connector_events_id_seq to service_role';
end $$;

-- Service functions: the service role only. Reader functions: signed-in readers.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_%' or p.proname in ('portfolio_disconnect', 'portfolio_admin_connector_health', 'portfolio_admin_ttv',
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
