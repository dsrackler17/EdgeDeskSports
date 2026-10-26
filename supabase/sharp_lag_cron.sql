-- =============================================================================
-- sharp_lag_cron.sql — when the Sharp-lag research functions run.
-- docs/sharp-lag/README.md.
--
-- REQUIRES supabase/sharp_lag.sql, pg_cron, pg_net, and the Vault secrets
-- (each the same value as its function's environment variable):
--   select vault.create_secret('<SHARP_LAG_CRON_SECRET>', 'sharp_lag_cron_secret');
--
-- WHEN.
--   sharp_lag     every 10 minutes. FREE: the function never calls the odds
--                 gateway or the provider, and this command names no paid
--                 path (it matches no odds_api_spend_patterns() entry)
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


select cron.unschedule(jobid) from cron.job where jobname in ('sharp_lag', 'sharp_check');
select cron.schedule('sharp_lag', '*/10 * * * *', $job$ select public.sharp_lag_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the free sharp_lag job runs every 10 minutes' as piece,
         case when exists (select 1 from cron.job where jobname = 'sharp_lag' and schedule = '*/10 * * * *' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 Vault sharp_lag_cron_secret is set',
         case when exists (select 1 from vault.decrypted_secrets where name = 'sharp_lag_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
              else 'CHECK THIS: select vault.create_secret(''<SHARP_LAG_CRON_SECRET>'', ''sharp_lag_cron_secret'');' end
) r order by 1;
