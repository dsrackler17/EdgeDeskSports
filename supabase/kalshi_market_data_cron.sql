-- =============================================================================
-- kalshi_market_data_cron.sql — when kalshi_sync runs. README §Kalshi market
-- data.
--
-- REQUIRES supabase/kalshi_market_data.sql, pg_cron, pg_net, and the Vault
-- secret kalshi_cron_secret (the same value as the function's
-- KALSHI_CRON_SECRET):
--   select vault.create_secret('<the secret>', 'kalshi_cron_secret');
--
-- WHEN.
--   kalshi_sync_discover   daily at 09:17 UTC: the Sports series list, and the
--                          status and result of tracked markets whose game
--                          has ended
--   kalshi_sync_snapshot   every 5 minutes: every open market of every
--                          tracked series settling inside the horizon, one
--                          snapshot row each, then the game links
-- A poke the function cannot be reached for still leaves its trace: pg_net
-- logs the request, and a scheduler that stops calling shows as an error in
-- public.kalshi_readiness after 20 minutes without a snapshot run.
--
-- The same Vault-secret poke as nba_injury_cron.sql: the service-role key is
-- never written into a cron command.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.kalshi_sync_runs') is null then raise exception 'apply supabase/kalshi_market_data.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.kalshi_poke(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
  v_run uuid;
begin
  if p_mode is null or p_mode not in ('discover', 'snapshot') then
    raise exception 'kalshi_poke: mode must be discover or snapshot, not %', coalesce(p_mode, 'null');
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'kalshi_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.kalshi_sync_runs (trigger, mode, status, started_at, finished_at, message, details)
    values ('cron', p_mode, 'error', now(), now(), 'Vault kalshi_cron_secret is missing: the sync was not called', jsonb_build_object('code', 'no_cron_secret'))
    returning run_id into v_run;
    insert into public.kalshi_alerts (run_id, severity, code, message)
    values (v_run, 'FAILURE', 'no_cron_secret', 'Vault kalshi_cron_secret is missing: the Kalshi sync was not called. Set it to the function''s KALSHI_CRON_SECRET.');
    return jsonb_build_object('queued', false, 'error', 'Vault kalshi_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/kalshi_sync',
    body                 := jsonb_build_object('source', 'supabase_cron', 'mode', p_mode),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  return jsonb_build_object('queued', true, 'mode', p_mode, 'request_id', v_req);
end $fn$;
revoke all on function public.kalshi_poke(text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.kalshi_poke(text) from service_role';
  end if;
end $g$;

-- also the starter's two jobs (kalshi_schema.sql's commented block), if they were
-- ever scheduled: they carried the service-role key in their command
select cron.unschedule(jobid) from cron.job where jobname in ('kalshi_sync_discover', 'kalshi_sync_snapshot', 'kalshi_discover_daily', 'kalshi_snapshot_5m');
select cron.schedule('kalshi_sync_discover', '17 9 * * *', $job$ select public.kalshi_poke('discover'); $job$);
select cron.schedule('kalshi_sync_snapshot', '*/5 * * * *', $job$ select public.kalshi_poke('snapshot'); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the daily discover is scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'kalshi_sync_discover' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 the 5-minute snapshot is scheduled', case when exists (select 1 from cron.job where jobname = 'kalshi_sync_snapshot' and schedule = '*/5 * * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '4 no starter job is left (none carries the service-role key)', case when not exists (select 1 from cron.job where jobname in ('kalshi_discover_daily', 'kalshi_snapshot_5m')) then 'ok' else 'CHECK THIS' end
  union all select '3 Vault kalshi_cron_secret is set', case when exists (select 1 from vault.decrypted_secrets where name = 'kalshi_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
    else 'CHECK THIS: select vault.create_secret(''<KALSHI_CRON_SECRET>'', ''kalshi_cron_secret'');' end
) r order by 1;
