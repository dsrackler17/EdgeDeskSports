-- ============================================================================
-- THE PORTFOLIO SYNC SCHEDULER — pg_cron poking the portfolio_connect edge
-- function every ten minutes (research_state_cron.sql's shape).
--
-- WHAT THIS SCHEDULES. Not the syncs — the POKE. portfolio_connect's sweep
-- asks the database which automatic accounts are due
-- (portfolio_svc_due_accounts: connected, next_sync_at passed, not waiting on
-- the reader, on a platform the registry has switched on) and syncs at most
-- ten inside its time budget. Each finished sync sets the account's next
-- run: 30 minutes after a success, backoff after a failure, never for a key
-- the platform refused (ACTION REQUIRED until the reader reconnects). So a
-- second poke, or a stray one, syncs nothing extra.
--
-- While no connector is switched on (the state this ships in), every tick
-- finds nothing due and does nothing.
--
-- OPERATOR STEPS.
--   1  Enable pg_cron and pg_net (Database → Extensions).
--   2  Apply supabase/portfolio.sql, portfolio_journal.sql, portfolio_connect.sql.
--   3  Set the credential keys (once; never in a workflow log):
--        supabase secrets set PORTFOLIO_CREDENTIAL_KEYS='{"1":"<32 random bytes, base64>"}' PORTFOLIO_CREDENTIAL_KEY_VERSION=1
--   4  Deploy the function with JWT verification OFF:
--        supabase functions deploy portfolio_connect --no-verify-jwt
--      (or the Deploy Portfolio workflow with deploy_function ticked)
--   5  Run this file. It needs no key and no database setting.
-- Idempotent: re-running replaces the job.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not available. Enable it in the Supabase dashboard (Database → Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout).';
  end if;
  if to_regprocedure('public.portfolio_svc_due_accounts(integer)') is null then
    raise exception 'Apply supabase/portfolio_connect.sql first: the sweep asks portfolio_svc_due_accounts what is due.';
  end if;
end $$;

select cron.unschedule('portfolio_sync_sweep')
  where exists (select 1 from cron.job where jobname = 'portfolio_sync_sweep');

select cron.schedule(
  'portfolio_sync_sweep',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/portfolio_connect',
      body                 := jsonb_build_object('action', 'sweep'),
      headers              := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 120000
    );
  $job$
);

-- THE PRICE FEED FOR DECISION RECORDS (supabase/portfolio_decision.sql):
-- every fifteen minutes, the reader's book's own ticks for positions whose
-- snapshot names an exact capture key, and the last pre-start tick as an
-- EDGEDESK_CAPTURE close. Runs inside the database (no HTTP, no key); only
-- scheduled once portfolio_decision.sql is applied — re-run this file then.
select cron.unschedule('portfolio_feed_path')
  where exists (select 1 from cron.job where jobname = 'portfolio_feed_path');
select cron.schedule('portfolio_feed_path', '*/15 * * * *', $job$ select public.portfolio_svc_attach_feed_path(500); $job$)
  where to_regprocedure('public.portfolio_svc_attach_feed_path(integer)') is not null;

-- THE REPORT. Every row should say ok. Whether ticks ARRIVE is proven ten
-- minutes later: select * from net._http_response order by created desc limit 5;
-- a 404 is an undeployed function, a 401 one deployed with JWT verification on.
with checks as (
  select 1 as n, 'the portfolio_sync_sweep job runs every ten minutes' as check_name,
         (select count(*) from cron.job where jobname = 'portfolio_sync_sweep' and schedule = '*/10 * * * *' and active)::int as got, 1 as want
  union all select 2, 'it calls portfolio_connect with no key and no database setting',
         (select count(*) from cron.job where jobname = 'portfolio_sync_sweep' and command like '%/functions/v1/portfolio_connect%'
            and command not like '%authorization%' and command not like '%current_setting%')::int, 1
  union all select 3, 'the Decision Record price feed runs every fifteen minutes (when portfolio_decision.sql is applied)',
         (select count(*) from cron.job where jobname = 'portfolio_feed_path' and schedule = '*/15 * * * *' and active)::int,
         case when to_regprocedure('public.portfolio_svc_attach_feed_path(integer)') is not null then 1 else 0 end
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from checks order by 1;
