-- Rollback of supabase/research_os.sql: unregisters the four navigation event
-- names. Events already recorded under them stay in public.user_events (the
-- recorded history of taps), so a name that has events keeps its row; only
-- unused names go, and new taps are dropped again exactly as before the change.
begin;
do $nav$ begin
  if to_regclass('public.user_event_kinds') is null then return; end if;
  if to_regclass('public.user_events') is not null then
    execute $d$delete from public.user_event_kinds k
       where k.event_name in ('primary_nav_overview', 'primary_nav_foresight', 'primary_nav_performance', 'primary_nav_simulator')
         and not exists (select 1 from public.user_events e where e.event_name = k.event_name)$d$;
  else
    delete from public.user_event_kinds
     where event_name in ('primary_nav_overview', 'primary_nav_foresight', 'primary_nav_performance', 'primary_nav_simulator');
  end if;
end $nav$;
commit;
notify pgrst, 'reload schema';
