-- cfb_matchup -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ================================================================= report
with tables(t) as (
  values ('cfb_team_week_style'),('cfb_game_matchup_features'),('cfb_similar_matchups'),
         ('cfb_style_change_events'),('cfb_matchup_model_versions'),('cfb_matchup_monitor')
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
  select 2, 'exactly-once keys (style, matchup, similar, events, versions, monitor)',
         case when to_regclass('public.cfb_team_week_style_key') is not null
               and to_regclass('public.cfb_game_matchup_key') is not null
               and to_regclass('public.cfb_similar_key') is not null
               and to_regclass('public.cfb_style_event_key') is not null
               and to_regclass('public.cfb_matchup_version_key') is not null
               and to_regclass('public.cfb_matchup_monitor_key') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'views: cfb_team_week_style_current, cfb_matchup_model_status, cfb_game_matchup_latest',
         case when to_regclass('public.cfb_team_week_style_current') is not null
               and to_regclass('public.cfb_matchup_model_status') is not null
               and to_regclass('public.cfb_game_matchup_latest') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'correction rules (NO_ADJUSTMENT = 0, cap 3, aware = general + adjustment)',
         case when exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_noadj')
               and exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_cap')
               and exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_sum') then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'point in time (snapshot before kickoff; comparisons before the prediction)',
         case when exists (select 1 from pg_constraint where conname = 'cfb_game_matchup_pit')
               and exists (select 1 from pg_constraint where conname = 'cfb_similar_pit') then 'ok' else 'CHECK THIS' end
) r
order by ord, check_name;

