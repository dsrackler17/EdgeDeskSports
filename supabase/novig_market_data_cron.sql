-- =============================================================================
-- novig_market_data_cron.sql — when novig_sync runs, and the daily prune.
-- docs/novig/README.md.
--
-- REQUIRES supabase/novig_market_data.sql, pg_cron, pg_net, and the Vault
-- secret novig_cron_secret (the same value as the function's
-- NOVIG_CRON_SECRET):
--   select vault.create_secret('<the secret>', 'novig_cron_secret');
--
-- WHEN.
--   novig_sync_probe      daily at 10:23 UTC: the clock, the signed echo, the
--                         throttle schedule and the account's geolocation
--                         standing (no market data)
--   novig_sync_discover   hourly at :07: events, participants and game-line
--                         markets of the tracked leagues, then the links
--   novig_sync_snapshot   every 5 minutes: the order books of the linked
--                         markets that are DUE (5 / 10 / 30 minutes by time
--                         to kickoff, novig_rule snapshot_*); an unchanged
--                         book is not stored again
--   novig_prune           daily at 04:41 UTC: depth past its retention
-- The function does nothing (one 'skipped' run an hour) until
-- NOVIG_INGEST_ENABLED=true and the read credentials are set on it, so this
-- file is safe to apply before the credentials exist.
-- A poke the function cannot be reached for still leaves its trace: pg_net
-- logs the request, and a scheduler that stops calling shows as an error in
-- public.novig_readiness after 20 minutes without a snapshot run.
--
-- The same Vault-secret poke as kalshi_market_data_cron.sql: the service-role
-- key is never written into a cron command.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261030120100_novig_market_data_cron.sql.
-- =============================================================================

do $req$ begin
  if to_regclass('public.novig_sync_runs') is null then raise exception 'apply supabase/novig_market_data.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.novig_poke(p_mode text)
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
  if p_mode is null or p_mode not in ('probe', 'discover', 'snapshot') then
    raise exception 'novig_poke: mode must be probe, discover or snapshot, not %', coalesce(p_mode, 'null');
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'novig_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.novig_sync_runs (trigger, mode, status, started_at, finished_at, message, details)
    values ('cron', p_mode, 'error', now(), now(), 'Vault novig_cron_secret is missing: the sync was not called', jsonb_build_object('code', 'no_cron_secret'))
    returning run_id into v_run;
    insert into public.novig_alerts (run_id, severity, code, message)
    values (v_run, 'FAILURE', 'no_cron_secret', 'Vault novig_cron_secret is missing: the Novig sync was not called. Set it to the function''s NOVIG_CRON_SECRET.');
    return jsonb_build_object('queued', false, 'error', 'Vault novig_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/novig_sync',
    body                 := jsonb_build_object('source', 'supabase_cron', 'mode', p_mode),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 140000
  ) into v_req;
  return jsonb_build_object('queued', true, 'mode', p_mode, 'request_id', v_req);
end $fn$;
revoke all on function public.novig_poke(text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.novig_poke(text) from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname in ('novig_sync_probe', 'novig_sync_discover', 'novig_sync_snapshot', 'novig_prune');
select cron.schedule('novig_sync_probe', '23 10 * * *', $job$ select public.novig_poke('probe'); $job$);
select cron.schedule('novig_sync_discover', '7 * * * *', $job$ select public.novig_poke('discover'); $job$);
select cron.schedule('novig_sync_snapshot', '*/5 * * * *', $job$ select public.novig_poke('snapshot'); $job$);
select cron.schedule('novig_prune', '41 4 * * *', $job$ select public.novig_prune(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the daily probe is scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'novig_sync_probe' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 the hourly discover is scheduled', case when exists (select 1 from cron.job where jobname = 'novig_sync_discover' and schedule = '7 * * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '3 the 5-minute snapshot is scheduled', case when exists (select 1 from cron.job where jobname = 'novig_sync_snapshot' and schedule = '*/5 * * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '4 the daily prune is scheduled', case when exists (select 1 from cron.job where jobname = 'novig_prune' and active) then 'ok' else 'CHECK THIS' end
  union all select '5 Vault novig_cron_secret is set', case when exists (select 1 from vault.decrypted_secrets where name = 'novig_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
    else 'CHECK THIS: select vault.create_secret(''<NOVIG_CRON_SECRET>'', ''novig_cron_secret'');' end
) r order by 1;
