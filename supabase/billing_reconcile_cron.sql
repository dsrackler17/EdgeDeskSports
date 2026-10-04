-- ===========================================================================
-- EdgeDesk — the scheduled billing reconciliation.
--
-- WEBHOOKS ALONE ARE NOT ENOUGH, and a customer should not have to press
-- anything. Every ten minutes pg_cron pokes sync_subscription's sweep, which:
--
--   * asks Stripe who the customer is for every delivery nobody could name in
--     the last 14 days, links it when Stripe's metadata or a CONFIRMED email
--     says whose it is, and reconciles that account;
--   * re-checks the accounts whose row may be behind Stripe — consent recorded
--     with nothing Stripe-backed granting access (the customer who paid while
--     nothing was listening), checkout sessions left open, Stripe-backed rows
--     whose period ended with no renewal recorded, rows with no status, payment
--     trouble, and (every three days) every entitled Stripe row, which is how
--     "EdgeDesk grants access but Stripe has cancelled" is caught.
--
-- THE SAME SHAPE AS research_state_cron.sql: the job carries no key and reads no
-- database setting. sync_subscription is deployed --no-verify-jwt, the sweep
-- takes no identity and answers counts only, and the DATABASE debounces it
-- (billing_sweep_admit: once per nine minutes) — so a stranger poking the URL
-- can at most make the sweep run on schedule.
--
-- Run AFTER supabase/billing_hardening.sql, once sync_subscription is deployed.
-- Requires pg_cron and pg_net (Database → Extensions). Ends in a report.
-- ===========================================================================

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
  if to_regprocedure('public.billing_sweep_admit(integer)') is null then
    raise exception 'Apply supabase/billing_hardening.sql first: the sweep is debounced by billing_sweep_admit().';
  end if;
end $$;

select cron.unschedule('billing_reconcile_sweep')
  where exists (select 1 from cron.job where jobname = 'billing_reconcile_sweep');

select cron.schedule(
  'billing_reconcile_sweep',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/sync_subscription',
      body                 := jsonb_build_object('action', 'sweep'),
      headers              := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 55000
    );
  $job$
);

with checks as (
  select 1 as n, 'the billing_reconcile_sweep job is scheduled every ten minutes' as check_name,
         (select count(*) from cron.job where jobname = 'billing_reconcile_sweep' and schedule = '*/10 * * * *' and active)::int as got, 1 as want
  union all select 2, 'the job calls sync_subscription''s sweep with no key and no database setting',
         (select count(*) from cron.job where jobname = 'billing_reconcile_sweep'
            and command like '%/functions/v1/sync_subscription%' and command like '%sweep%'
            and command not like '%current_setting%' and command not like '%authorization%')::int, 1
  union all select 3, 'the sweep is debounced in the database',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'billing_sweep_admit')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
