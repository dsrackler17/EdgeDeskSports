-- cfb_personnel -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ================================================================= report
with tables(t) as (
  values ('cfb_players'),('cfb_player_aliases'),('cfb_transfer_history'),('cfb_player_performance'),
         ('cfb_player_week_state'),('cfb_depth_chart_state'),('cfb_personnel_unit_state'),('cfb_player_events'),
         ('cfb_personnel_game_snapshot'),('cfb_personnel_model_versions')
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only, row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg where tg.tgrelid = to_regclass('public.' || t)
                     and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'exactly-once keys (registry, performance, player / depth / unit state, game snapshots)',
         case when to_regclass('public.cfb_players_key') is not null
               and to_regclass('public.cfb_player_performance_key') is not null
               and to_regclass('public.cfb_player_week_state_key') is not null
               and to_regclass('public.cfb_depth_chart_state_key') is not null
               and to_regclass('public.cfb_personnel_unit_state_key') is not null
               and to_regclass('public.cfb_personnel_game_snapshot_key') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'views: current player state, current unit state, current registry, model status',
         case when to_regclass('public.cfb_player_week_state_current') is not null
               and to_regclass('public.cfb_personnel_unit_state_current') is not null
               and to_regclass('public.cfb_players_current') is not null
               and to_regclass('public.cfb_personnel_model_status') is not null then 'ok' else 'CHECK THIS' end
) r
order by ord, check_name;

