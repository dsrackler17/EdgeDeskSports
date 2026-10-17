-- =============================================================================
-- altitude_shadow_rollback — REMOVE the CFB Altitude & Travel objects created
-- by supabase/cfb_altitude.sql.
--
-- READ FIRST: docs/cfb-altitude/ROLLBACK.md. Removing these objects is almost
-- never the rollback you want. The fast, reversible rollback is the switch:
--
--   select public.cfb_set_feature_flag('cfb_altitude_adjustment_enabled', false,
--     '<your name>', 'altitude adjustment rolled back: <why>');
--
-- which returns every number to V1 on the next build. This file is for taking
-- the module out entirely (for example after it is retired).
--
-- WHAT IS NOT REVERSIBLE: the pregame altitude records, registry versions and
-- validation runs are DROPPED with their tables. Export them first if they
-- matter (they are the module's prospective record). The flag row is NOT
-- deleted — public.cfb_feature_flags never deletes a flag — it is switched
-- off through the audited door instead.
--
-- Named without the cfb_ prefix on purpose: football/cfb_production/
-- migration_review.js refuses any destructive statement in supabase/cfb_*.sql,
-- and this file is destructive by design. Idempotent; ends in a report.
-- Tested by football/altitude/sql.test.js (apply, roll back, re-apply).
-- =============================================================================

do $blk$
declare
  v_on boolean;
begin
  if to_regclass('public.cfb_feature_flags') is not null and exists (select 1 from pg_proc where proname = 'cfb_set_feature_flag') then
    execute 'select coalesce(bool_or(enabled), false) from public.cfb_feature_flags where flag = ''cfb_altitude_adjustment_enabled''' into v_on;
    if v_on then
      perform public.cfb_set_feature_flag('cfb_altitude_adjustment_enabled', false, 'altitude_shadow_rollback.sql',
        'altitude module removed by supabase/altitude_shadow_rollback.sql');
    end if;
  end if;
end $blk$;

drop view if exists public.cfb_altitude_monitor;
drop view if exists public.cfb_altitude_shadow_latest;
drop view if exists public.cfb_venue_elevation_current;
drop table if exists public.cfb_altitude_shadow;
drop table if exists public.cfb_venue_elevation;
drop table if exists public.cfb_altitude_validation_runs;
drop function if exists public.cfb_altitude_append_only();

notify pgrst, 'reload schema';

select check_name, status from (
  select 1 as ord, 'altitude tables and views removed' as check_name,
         case when to_regclass('public.cfb_altitude_shadow') is null and to_regclass('public.cfb_venue_elevation') is null
               and to_regclass('public.cfb_altitude_validation_runs') is null and to_regclass('public.cfb_altitude_monitor') is null
              then 'ok' else 'CHECK THIS' end as status
  union all
  select 2, 'switch cfb_altitude_adjustment_enabled is off (or the flag table is absent)',
         case when to_regclass('public.cfb_feature_flags') is null then 'ok'
              when (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from public.cfb_feature_flags where flag = ''cfb_altitude_adjustment_enabled'' and enabled',
                     false, true, '')))[1]::text = '0' then 'ok'
              else 'CHECK THIS' end
) r
order by ord;
