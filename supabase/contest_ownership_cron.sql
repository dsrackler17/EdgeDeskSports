-- =============================================================================
-- contest_ownership_cron.sql — when circa_ownership_sync runs.
-- docs/market-structure/README.md §Contest ownership
--
-- REQUIRES supabase/contest_ownership.sql, pg_cron, pg_net, and the Vault
-- secret circa_cron_secret (the same value as the function's
-- CIRCA_CRON_SECRET):
--   select vault.create_secret('<the secret>', 'circa_cron_secret');
--
-- WHEN. Circa posts the Million selections PDF on Saturday, before the Sunday
-- games. The function runs Saturday every two hours from 10:00 to 18:00
-- Eastern and Sunday at 08:00, 10:00 and 12:00 Eastern (UTC below, written
-- for daylight time; under standard time each lands an hour earlier Eastern,
-- still inside the window). A run that finds this week already complete
-- returns at once; a run that finds no PDF records a WARNING until Sunday
-- 13:00 Eastern and a FAILURE after it (contest_ownership_fail).
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.contest_ownership_ingest(jsonb,jsonb,jsonb)') is null then raise exception 'apply supabase/contest_ownership.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.circa_ownership_poke()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'circa_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception here would roll the
    -- alert back with it, and the missing secret would never be seen
    perform public.market_structure_alert('circa_ownership', 'FAILURE', 'no_cron_secret',
      'Vault circa_cron_secret is missing: the contest sync was not called. Set it to the function''s CIRCA_CRON_SECRET.', null);
    return jsonb_build_object('queued', false, 'error', 'Vault circa_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/circa_ownership_sync',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req;
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.circa_ownership_poke() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.circa_ownership_poke() from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname in ('circa_ownership_saturday', 'circa_ownership_sunday');
select cron.schedule('circa_ownership_saturday', '7 14,16,18,20,22 * * 6', $job$ select public.circa_ownership_poke(); $job$);
select cron.schedule('circa_ownership_sunday',   '7 12,14,16 * * 0',       $job$ select public.circa_ownership_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 Saturday runs scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'circa_ownership_saturday' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 Sunday morning retries scheduled', case when exists (select 1 from cron.job where jobname = 'circa_ownership_sunday' and active) then 'ok' else 'CHECK THIS' end
  union all select '3 Vault circa_cron_secret is set', case when exists (select 1 from vault.decrypted_secrets where name = 'circa_cron_secret' and nullif(decrypted_secret, '') is not null) then 'ok'
    else 'CHECK THIS: select vault.create_secret(''<CIRCA_CRON_SECRET>'', ''circa_cron_secret'');' end
) r order by 1;
