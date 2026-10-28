-- ===========================================================================
-- EdgeDesk — the scheduled Juice Reel billing reconciliation.
--
-- JUICE REEL DOES NOT RETRY A WEBHOOK DELIVERY, so a renewal whose event was
-- lost would otherwise end a paying reader's access at the old expiry. Every
-- hour pg_cron pokes juicereel_billing's reconcile, which reads the OAuth
-- application owner's current subscribers from Juice Reel (owner access,
-- /oauth2/subscribers/current, every page) and records each paid one — so a
-- missed purchase or renewal is picked up within the hour. A reader EdgeDesk
-- holds as paid who is NOT on that list is raised for a human
-- (billing_alerts: juicereel_absent_from_current), never cut off on a guess.
--
-- THE SAME SHAPE AS billing_reconcile_cron.sql: the job carries no key and
-- reads no database setting. juicereel_billing is deployed --no-verify-jwt,
-- the reconcile takes no identity and answers counts only, and the DATABASE
-- debounces it (billing_jr_reconcile_admit: once per 50 minutes) — so a
-- stranger poking the URL can at most make it run on schedule.
--
-- Run AFTER supabase/juicereel_billing.sql, once juicereel_billing is deployed.
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
  if to_regprocedure('public.billing_jr_reconcile_admit(integer)') is null then
    raise exception 'Apply supabase/juicereel_billing.sql first: the reconcile is debounced by billing_jr_reconcile_admit().';
  end if;
end $$;

select cron.unschedule('juicereel_billing_reconcile')
  where exists (select 1 from cron.job where jobname = 'juicereel_billing_reconcile');

select cron.schedule(
  'juicereel_billing_reconcile',
  '17 * * * *',
  $job$
    select net.http_post(
      url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/juicereel_billing',
      body                 := jsonb_build_object('action', 'reconcile'),
      headers              := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 55000
    );
  $job$
);

with checks as (
  select 1 as n, 'the juicereel_billing_reconcile job is scheduled every hour' as check_name,
         (select count(*) from cron.job where jobname = 'juicereel_billing_reconcile' and schedule = '17 * * * *' and active)::int as got, 1 as want
  union all select 2, 'the job calls juicereel_billing''s reconcile with no key and no database setting',
         (select count(*) from cron.job where jobname = 'juicereel_billing_reconcile'
            and command like '%/functions/v1/juicereel_billing%' and command like '%reconcile%'
            and command not like '%current_setting%' and command not like '%authorization%')::int, 1
  union all select 3, 'the reconcile is debounced in the database',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'billing_jr_reconcile_admit')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
