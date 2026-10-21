-- =============================================================================
-- nba_injury_cron.sql — when nba_injury_sync runs. README §NBA roster and
-- injury layer.
--
-- REQUIRES supabase/nba_injury_layer.sql, pg_cron, pg_net, and the Vault
-- secret nba_injury_cron_secret (the same value as the function's
-- NBA_INJURY_CRON_SECRET):
--   select vault.create_secret('<the secret>', 'nba_injury_cron_secret');
--
-- WHEN. pg_cron cannot know the NBA schedule, so — as research_cron does —
-- the job pokes the function on a fixed grid and the FUNCTION decides:
--   * grid: minutes 7 and 37 of every hour from 13:00 to 04:59 UTC (about
--     9 AM to midnight Eastern, both daylight and standard time)
--   * a GAME DAY (an Eastern date with a game on the slate): every poke from
--     9:00 AM Eastern until 30 minutes after the day's last tip — every 30
--     minutes, morning through the last tip
--   * any other day: the first poke at or after 9:00 AM Eastern only — once a
--     day (offseason trades, signings and waivers still land)
-- A poke the function declines is logged as a SKIPPED run, so the readiness
-- KPIs can tell a quiet day from a dead scheduler (no run of any kind in 90
-- minutes is a failure).
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.nba_injury_sync_runs') is null then raise exception 'apply supabase/nba_injury_layer.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.nba_injury_poke()
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
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nba_injury_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.nba_injury_sync_runs (trigger, status, started_at, finished_at, message, details)
    values ('cron', 'error', now(), now(), 'Vault nba_injury_cron_secret is missing: the sync was not called', jsonb_build_object('code', 'no_cron_secret'))
    returning run_id into v_run;
    insert into public.nba_injury_alerts (run_id, severity, code, message)
    values (v_run, 'FAILURE', 'no_cron_secret', 'Vault nba_injury_cron_secret is missing: the NBA injury sync was not called. Set it to the function''s NBA_INJURY_CRON_SECRET.');
    return jsonb_build_object('queued', false, 'error', 'Vault nba_injury_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/nba_injury_sync',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.nba_injury_poke() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.nba_injury_poke() from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname in ('nba_injury_sync');
select cron.schedule('nba_injury_sync', '7,37 0-4,13-23 * * *', $job$ select public.nba_injury_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the half-hourly poke is scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'nba_injury_sync' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 Vault nba_injury_cron_secret is set', case when exists (select 1 from vault.decrypted_secrets where name = 'nba_injury_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
    else 'CHECK THIS: select vault.create_secret(''<NBA_INJURY_CRON_SECRET>'', ''nba_injury_cron_secret'');' end
) r order by 1;
