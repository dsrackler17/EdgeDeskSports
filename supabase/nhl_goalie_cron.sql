-- =============================================================================
-- nhl_goalie_cron.sql — when nhl_goalie_sync runs. docs/engine/NHL_GOALIES.md.
--
-- REQUIRES supabase/nhl_goalie_layer.sql, pg_cron, pg_net, and the Vault
-- secret nhl_goalie_cron_secret (the same value as the function's
-- NHL_GOALIE_CRON_SECRET):
--   select vault.create_secret('<the secret>', 'nhl_goalie_cron_secret');
--
-- WHEN. pg_cron cannot know the NHL schedule, so — as nba_injury_cron and
-- research_cron do — the job pokes the function on a fixed grid and the
-- FUNCTION decides (hockey/goalies/core.js nhlgIsDue):
--   * grid: every 5 minutes, all day (overseas games start in the US morning)
--   * on each Eastern date with a game: every two hours from 8:00 AM Eastern
--     until the last puck drop
--   * every 15 minutes in the final three hours before each puck drop
--   * a final pass at T-30 for each game
-- A declined poke is logged as a SKIPPED run at most once every 55 minutes,
-- so the readiness KPIs can tell a quiet morning from a dead scheduler (no
-- run of any kind in 90 minutes is a failure).
--
-- WHAT THE FUNCTION ANSWERED. pg_net sends the poke later, and pg_cron records
-- only that the poke's SQL ran, never what the function said. A refused
-- secret therefore looked like a working scheduler until the 90-minute
-- silence (2026-10-26: the function's NHL_GOALIE_CRON_SECRET no longer matched
-- Vault, and every poke for 85 minutes was a 401). Each poke's pg_net request
-- id is kept in public.nhl_goalie_pokes for two days, so its answer
-- (net._http_response, which pg_net keeps for six hours) can be read beside it.
-- NHL goalie sync (.github/workflows/nhl-goalie-sync.yml) reads them through
-- tools/hockey/sql/nhl_goalie_cron_check.sql and fails on a refused poke.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.nhl_goalie_sync_runs') is null then raise exception 'apply supabase/nhl_goalie_layer.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create table if not exists public.nhl_goalie_pokes (
  request_id bigint primary key,   -- net.http_post's id = net._http_response.id
  queued_at  timestamptz not null default now()
);
alter table public.nhl_goalie_pokes enable row level security;
revoke all on public.nhl_goalie_pokes from public, anon, authenticated;

create or replace function public.nhl_goalie_poke()
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
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nhl_goalie_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.nhl_goalie_sync_runs (trigger, status, started_at, finished_at, message, details)
    values ('cron', 'error', now(), now(), 'Vault nhl_goalie_cron_secret is missing: the sync was not called', jsonb_build_object('code', 'no_cron_secret'))
    returning run_id into v_run;
    insert into public.nhl_goalie_alerts (run_id, severity, code, message)
    values (v_run, 'FAILURE', 'no_cron_secret', 'Vault nhl_goalie_cron_secret is missing: the NHL goalie sync was not called. Set it to the function''s NHL_GOALIE_CRON_SECRET.');
    return jsonb_build_object('queued', false, 'error', 'Vault nhl_goalie_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/nhl_goalie_sync',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  insert into public.nhl_goalie_pokes (request_id) values (v_req) on conflict do nothing;
  delete from public.nhl_goalie_pokes where queued_at < now() - interval '2 days';
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.nhl_goalie_poke() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.nhl_goalie_poke() from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname in ('nhl_goalie_sync');
select cron.schedule('nhl_goalie_sync', '*/5 * * * *', $job$ select public.nhl_goalie_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the five-minute poke is scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'nhl_goalie_sync' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '3 each poke''s answer is kept (public.nhl_goalie_pokes)', case when to_regclass('public.nhl_goalie_pokes') is not null then 'ok' else 'CHECK THIS' end
  union all select '2 Vault nhl_goalie_cron_secret is set', case when exists (select 1 from vault.decrypted_secrets where name = 'nhl_goalie_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
    else 'CHECK THIS: select vault.create_secret(''<NHL_GOALIE_CRON_SECRET>'', ''nhl_goalie_cron_secret'');' end
) r order by 1;
