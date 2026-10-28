-- =============================================================================
-- bet_checker_cron.sql — when grade_user_bets runs: after the close, on the
-- close's own cadence. docs/bet-checker.md
--
-- REQUIRES supabase/bet_checker.sql, pg_cron, pg_net, and the Vault secret
-- bet_checker_cron_secret (the same value as the function's
-- BET_CHECKER_CRON_SECRET; .github/workflows/deploy-bet-checker.yml sets both
-- sides and proves they agree):
--   select vault.create_secret('<the secret>', 'bet_checker_cron_secret');
--
-- WHEN. `close` writes the closing line onto public.signals at most every 35
-- minutes while games are pending (its pg_cron schedule exists only in the
-- database, docs/odds-api-incident-2026-10/INCIDENT.md). bet_checker_grade
-- runs every fifteen minutes, at :05 :20 :35 :50 — clear of capture's :04 /
-- :12 / :18 and the import close's :07 / :22 / :37 / :52 — so every close is
-- graded within fifteen minutes of being written. The grader is idempotent:
-- a run with nothing new to grade changes nothing, and overlapping runs skip
-- each other's rows (FOR UPDATE SKIP LOCKED). The report below names the
-- close job it follows, read from cron.job, so the pairing is checked rather
-- than assumed.
--
-- The same Vault-secret poke as kalshi_market_data_cron.sql: the service-role
-- key is never written into a cron command.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.bet_checker_grade_pending(integer,text)') is null then raise exception 'apply supabase/bet_checker.sql first'; end if;
  if to_regclass('cron.job') is null then raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)'; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then raise exception 'pg_net is not enabled (Database -> Extensions -> pg_net)'; end if;
end $req$;

create or replace function public.bet_checker_grade_poke()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'bet_checker_cron_secret';
  if nullif(v_secret, '') is null then
    -- recorded and returned, not raised: an exception would roll the record back with it
    insert into public.bet_checker_grade_runs (started_at, finished_at, source, ok, result)
    values (now(), now(), 'cron', false, jsonb_build_object('error', 'no_cron_secret',
      'message', 'Vault bet_checker_cron_secret is missing: grade_user_bets was not called'));
    return jsonb_build_object('queued', false, 'error', 'Vault bet_checker_cron_secret is missing -- nothing was sent');
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/grade_user_bets',
    body                 := jsonb_build_object('source', 'supabase_cron'),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000
  ) into v_req;
  return jsonb_build_object('queued', true, 'request_id', v_req);
end $fn$;
revoke all on function public.bet_checker_grade_poke() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.bet_checker_grade_poke() from service_role';
  end if;
end $g$;

select cron.unschedule(jobid) from cron.job where jobname = 'bet_checker_grade';
select cron.schedule('bet_checker_grade', '5,20,35,50 * * * *', $job$ select public.bet_checker_grade_poke(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 grade_user_bets is scheduled every fifteen minutes' as piece,
         case when exists (select 1 from cron.job where jobname = 'bet_checker_grade' and schedule = '5,20,35,50 * * * *' and active)
              then 'ok' else 'CHECK THIS' end as state
  union all select '2 the close job it follows (read from cron.job)',
         coalesce((select 'ok (' || string_agg(jobname || ' ' || schedule || case when active then '' else ' PAUSED' end, '; ') || ')'
                     from cron.job where command ilike '%/functions/v1/close%' and command not ilike '%close_backfill%'),
                  'CHECK THIS: no pg_cron job calls /functions/v1/close here — closes will not be written, so nothing will be graded')
  union all select '3 Vault bet_checker_cron_secret is set',
         case when exists (select 1 from vault.decrypted_secrets where name = 'bet_checker_cron_secret' and nullif(decrypted_secret, '') is not null)
              then 'ok' else 'CHECK THIS: select vault.create_secret(''<BET_CHECKER_CRON_SECRET>'', ''bet_checker_cron_secret'');' end
) r order by 1;
