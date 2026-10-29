-- =============================================================================
-- polymarket_sync_cron.sql — when Prediction Radar's job runs.
-- docs/prediction-radar.md §Pipeline
--
-- REQUIRES supabase/radar.sql, pg_cron, pg_net, and the Vault secret
-- polymarket_sync_cron_secret (the same value as the function's
-- POLYMARKET_SYNC_SECRET):
--   select vault.create_secret('<the secret>', 'polymarket_sync_cron_secret');
--
-- WHEN (UTC; the night is 02:00 to 06:30 in New York, after the late games):
--   polymarket_sync_tonight   every 10 minutes: the covered leagues' open game
--                             markets, matched to EdgeDesk games; who holds
--                             each side of the upcoming ones, and the price
--   polymarket_sync_pool      daily at 06:07: the sports leaderboard pool
--   polymarket_sync_wallets   every 5 minutes, 06:10 to 09:55: the pool's
--                             activity, three wallets a run, and every newly
--                             resolved bet graded once
--   polymarket_sync_grade     daily at 10:17: every pool wallet regraded, one
--                             versioned run
-- Each run asks poly_api_acquire() for its grant first, so the gateway's
-- daily ceiling holds however the schedule is changed. While
-- POLYMARKET_DATA_ENABLED is off, every poke is answered "skipped" and
-- nothing is asked of Polymarket.
--
-- The same Vault-secret poke as kalshi_market_data_cron.sql: the service-role
-- key is never written into a cron command.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.poly_sync_runs') is null then raise exception 'apply supabase/radar.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.radar_poke(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
  v_run uuid := gen_random_uuid();
begin
  if p_mode is null or p_mode not in ('tonight', 'pool', 'wallets', 'grade') then
    raise exception 'radar_poke: mode must be tonight, pool, wallets or grade, not %', coalesce(p_mode, 'null');
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'polymarket_sync_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.poly_sync_runs (run_id, mode, trigger, status, started_at, finished_at, message, details)
    values (v_run, p_mode, 'cron', 'error', now(), now(), 'Vault polymarket_sync_cron_secret is missing: the sync was not called', jsonb_build_object('code', 'no_cron_secret'));
    insert into public.poly_alerts (run_id, severity, code, message)
    values (v_run, 'FAILURE', 'no_cron_secret', 'Vault polymarket_sync_cron_secret is missing: polymarket_sync was not called. Set it to the function''s POLYMARKET_SYNC_SECRET.');
    return jsonb_build_object('queued', false, 'error', 'Vault polymarket_sync_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/polymarket_sync',
    body                 := jsonb_build_object('source', 'supabase_cron', 'mode', p_mode),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 150000
  ) into v_req;
  return jsonb_build_object('queued', true, 'mode', p_mode, 'request_id', v_req);
end $fn$;
revoke all on function public.radar_poke(text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.radar_poke(text) from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname in ('polymarket_sync_tonight', 'polymarket_sync_pool', 'polymarket_sync_wallets', 'polymarket_sync_grade');
select cron.schedule('polymarket_sync_tonight', '*/10 * * * *', $job$ select public.radar_poke('tonight'); $job$);
select cron.schedule('polymarket_sync_pool', '7 6 * * *', $job$ select public.radar_poke('pool'); $job$);
select cron.schedule('polymarket_sync_wallets', '10-55/5 6-9 * * *', $job$ select public.radar_poke('wallets'); $job$);
select cron.schedule('polymarket_sync_grade', '17 10 * * *', $job$ select public.radar_poke('grade'); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 tonight runs every 10 minutes' as piece,
         case when exists (select 1 from cron.job where jobname = 'polymarket_sync_tonight' and schedule = '*/10 * * * *' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 the pool is refreshed daily at 06:07 UTC',
         case when exists (select 1 from cron.job where jobname = 'polymarket_sync_pool' and schedule = '7 6 * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '3 wallets run every 5 minutes, 06:10 to 09:55 UTC',
         case when exists (select 1 from cron.job where jobname = 'polymarket_sync_wallets' and schedule = '10-55/5 6-9 * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '4 the grade runs daily at 10:17 UTC',
         case when exists (select 1 from cron.job where jobname = 'polymarket_sync_grade' and schedule = '17 10 * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '5 Vault polymarket_sync_cron_secret is set',
         case when exists (select 1 from vault.decrypted_secrets where name = 'polymarket_sync_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
              else 'CHECK THIS: select vault.create_secret(''<POLYMARKET_SYNC_SECRET>'', ''polymarket_sync_cron_secret'');' end
) r order by 1;
