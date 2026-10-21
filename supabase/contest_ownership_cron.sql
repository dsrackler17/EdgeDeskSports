-- =============================================================================
-- contest_ownership_cron.sql — retires the pg_cron pokes of circa_ownership_sync.
-- docs/market-structure/README.md §Contest ownership
--
-- WHY. The deployed edge function cannot read a real week. The selections PDF
-- (every entry's five picks, thousands of entries) needs more compute than an
-- edge worker has, and Supabase answers 546 WORKER_RESOURCE_LIMIT (2026-10-21,
-- Week 6 of Million VIII). The same function file now runs in GitHub Actions
-- (.github/workflows/circa-ownership.yml, via tools/football/circa_ownership_run.ts)
-- on the same schedule: Saturday every two hours from 10:00 to 18:00 Eastern,
-- Sunday at 08:00, 10:00 and 12:00 Eastern. It writes through
-- contest_ownership_ingest() / contest_ownership_fail() with the service role,
-- exactly as the function did, so a missing PDF is still a WARNING until Sunday
-- 13:00 Eastern and a FAILURE after it.
--
-- WHAT IT DOES. Unschedules circa_ownership_saturday and circa_ownership_sunday
-- (the jobs earlier versions of this file created) and drops
-- public.circa_ownership_poke(). The Vault secret circa_cron_secret is left in
-- place; nothing reads it now.
--
-- REQUIRES supabase/contest_ownership.sql. pg_cron is optional: without it
-- there is nothing to unschedule.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again, and safe where the
-- jobs never existed.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.contest_ownership_ingest(jsonb,jsonb,jsonb)') is null then raise exception 'apply supabase/contest_ownership.sql first'; end if;
end $req$;

do $unschedule$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job
     where jobname in ('circa_ownership_saturday', 'circa_ownership_sunday') or command like '%circa_ownership_poke%';
  end if;
end $unschedule$;

drop function if exists public.circa_ownership_poke();

-- THE REPORT. Every row should say ok.
create or replace function pg_temp.circa_cron_jobs() returns integer
language plpgsql as $f$
declare n integer := 0;
begin
  if to_regclass('cron.job') is not null then
    execute $q$select count(*) from cron.job where jobname in ('circa_ownership_saturday', 'circa_ownership_sunday') or command like '%circa_ownership_poke%'$q$ into n;
  end if;
  return n;
end $f$;
select piece, state from (
  select '1 no pg_cron job pokes circa_ownership_sync (it runs in GitHub Actions: circa-ownership.yml)' as piece,
         case when pg_temp.circa_cron_jobs() = 0 then 'ok' else 'CHECK THIS' end as state
  union all select '2 the poke function is gone', case when to_regprocedure('public.circa_ownership_poke()') is null then 'ok' else 'CHECK THIS' end
) r order by 1;
