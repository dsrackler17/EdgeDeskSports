-- =============================================================================
-- THE RESEARCH OS NAVIGATION — navigation evidence for the seats it added.
-- docs/research-os/DESIGN.md §1 · docs/research-os/REPORT.md §6
--
-- The terminal's navigation (app.html, lib/edgedesk_shell.js) now carries an
-- Overview, Market Foresight and Performance seat, and the Simulator seat it
-- already had. lib/edgedesk_track.js sends a primary_nav_<seat> event per tap;
-- the database records only names it lists in public.user_event_kinds, so
-- without these rows the taps are dropped (the Simulator's always were).
--
-- This file only REGISTERS four event names. It creates no table, changes no
-- policy, reads no reader's row and touches no other feature. It is idempotent
-- (on conflict do nothing) and skips itself where the funnel is not installed.
-- supabase/funnel.sql carries the same four rows for a fresh install.
-- Rollback: supabase/research_os_rollback.sql.
-- =============================================================================
begin;

do $nav$ begin
  if to_regclass('public.user_event_kinds') is not null then
    insert into public.user_event_kinds (event_name, source, dedupe, stage, signed_in, description) values
      ('primary_nav_overview',    'client', 'session', 60, true, 'The Overview seat in the primary navigation was tapped.'),
      ('primary_nav_foresight',   'client', 'session', 60, true, 'The Market Foresight seat in the primary navigation was tapped.'),
      ('primary_nav_performance', 'client', 'session', 60, true, 'The Performance seat in the primary navigation was tapped.'),
      ('primary_nav_simulator',   'client', 'session', 60, true, 'The Simulator seat in the primary navigation was tapped.')
    on conflict (event_name) do nothing;
  end if;
end $nav$;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- report
select 1 as row, 'the four navigation events are registered' as check,
       case when to_regclass('public.user_event_kinds') is null then 'pending — supabase/funnel.sql is not applied on this project'
            when (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.user_event_kinds where source = ''client'' and event_name in (''primary_nav_overview'',''primary_nav_foresight'',''primary_nav_performance'',''primary_nav_simulator'')', false, true, '')))[1]::text = '4'
            then 'ok' else 'CHECK THIS' end as result;
