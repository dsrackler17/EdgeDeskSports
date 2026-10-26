-- =============================================================================
-- sharp_lag_cron.sql — when the Sharp-lag research functions run.
-- docs/sharp-lag/README.md.
--
-- REQUIRES supabase/sharp_lag.sql, pg_cron, pg_net, and the Vault secrets
-- (each the same value as its function's environment variable):
--   select vault.create_secret('<SHARP_LAG_CRON_SECRET>', 'sharp_lag_cron_secret');
--   select vault.create_secret('<SHARP_CHECK_CRON_SECRET>', 'sharp_check_cron_secret');
--
-- WHEN.
--   sharp_lag     every 10 minutes. FREE: the function never calls the odds
--                 gateway or the provider, and this command names no paid
--                 path (it matches no odds_api_spend_patterns() entry)
--   sharp_check   hourly at :47. PAID, through odds_gateway only. The poke
--                 sends nothing unless sharp_lag_config.dispatch = live AND
--                 the gateway's breaker is on: shadow mode and a paused
--                 provider cost nothing, not even a wasted function run. Its
--                 command matches '%sharp_check_poke%', so the emergency stop
--                 pauses it and odds_api_hourly_limits.sql holds it to hourly
-- The service-role key is never written into a cron command (the Vault
-- secret poke, as kalshi_market_data_cron.sql).
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.sharp_lag_runs') is null then raise exception 'apply supabase/sharp_lag.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.sharp_lag_poke()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare v_secret text; v_req bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'sharp_lag_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.sharp_lag_runs (fn, status, started_at, message, details)
    values ('sharp_lag', 'error', now(), 'Vault sharp_lag_cron_secret is missing: the function was not called', jsonb_build_object('code', 'no_cron_secret'));
    return jsonb_build_object('queued', false, 'error', 'Vault sharp_lag_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/sharp_lag',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.sharp_lag_poke() from public, anon, authenticated;

create or replace function public.sharp_check_poke()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare v_secret text; v_req bigint; v_mode text;
begin
  select value into v_mode from public.sharp_lag_config where key = 'dispatch';
  if coalesce(v_mode, 'shadow') <> 'live' then
    return jsonb_build_object('queued', false, 'reason', 'sharp_lag_config.dispatch is ' || coalesce(v_mode, 'unset') || ': nothing is bought in shadow');
  end if;
  -- the gateway's breaker: off, every paid request would be refused anyway
  if to_regprocedure('public.odds_api_enabled()') is null then
    return jsonb_build_object('queued', false, 'reason', 'the odds gateway is not installed: nothing can be bought');
  end if;
  if not public.odds_api_enabled() then
    return jsonb_build_object('queued', false, 'reason', 'odds_api_enabled is false: sharp_check not woken');
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'sharp_check_cron_secret';
  if nullif(v_secret, '') is null then
    insert into public.sharp_lag_runs (fn, status, started_at, message, details)
    values ('sharp_check', 'error', now(), 'Vault sharp_check_cron_secret is missing: the function was not called', jsonb_build_object('code', 'no_cron_secret'));
    return jsonb_build_object('queued', false, 'error', 'Vault sharp_check_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/sharp_check',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.sharp_check_poke() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('sharp_lag', 'sharp_check');
select cron.schedule('sharp_lag', '*/10 * * * *', $job$ select public.sharp_lag_poke(); $job$);
select cron.schedule('sharp_check', '47 * * * *', $job$ select public.sharp_check_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the free sharp_lag job runs every 10 minutes' as piece,
         case when exists (select 1 from cron.job where jobname = 'sharp_lag' and schedule = '*/10 * * * *' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 Vault sharp_lag_cron_secret is set',
         case when exists (select 1 from vault.decrypted_secrets where name = 'sharp_lag_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
              else 'CHECK THIS: select vault.create_secret(''<SHARP_LAG_CRON_SECRET>'', ''sharp_lag_cron_secret'');' end
  union all select '3 the paid sharp_check runs at most hourly',
         case when exists (select 1 from cron.job where jobname = 'sharp_check' and schedule = '47 * * * *' and active) then 'ok' else 'CHECK THIS' end
  union all select '4 Vault sharp_check_cron_secret is set',
         case when exists (select 1 from vault.decrypted_secrets where name = 'sharp_check_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
              else 'CHECK THIS: select vault.create_secret(''<SHARP_CHECK_CRON_SECRET>'', ''sharp_check_cron_secret'');' end
) r order by 1;
