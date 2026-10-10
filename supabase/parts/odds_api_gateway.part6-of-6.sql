-- odds_api_gateway -- part 6 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ── THE REPORT ──────────────────────────────────────────────────────────────
with checks as (
  select 1 as n, 'odds_api_emergency_stop.sql has been applied (its stop and resume functions exist)' as check_name,
         (case when to_regprocedure('public.odds_api_emergency_stop(text)') is not null
                and to_regprocedure('public.odds_api_resume_schedules(text)') is not null then 1 else 0 end) as got, 1 as want
  union all select 2, 'the switch row exists',
         (select count(*) from public.odds_api_config where id = 1)::int, 1
  union all select 3, 'every gateway table has row level security on and no anon read',
         (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity
            and relname in ('odds_api_config', 'odds_api_requests', 'odds_api_snapshots', 'odds_api_events', 'odds_api_alerts',
                            'odds_api_job_locks', 'odds_api_categories', 'odds_api_sports', 'odds_api_cadence', 'odds_api_consumer_marks')
            and not has_table_privilege('anon', oid, 'select'))::int, 10
  union all select 4, 'acquire and settle cannot be called by anon or a signed-in browser',
         (case when not has_function_privilege('anon', 'public.odds_api_acquire(jsonb)', 'execute')
                and not has_function_privilege('authenticated', 'public.odds_api_acquire(jsonb)', 'execute')
                and not has_function_privilege('authenticated', 'public.odds_api_settle(jsonb)', 'execute') then 1 else 0 end), 1
  union all select 5, 'readers can see the feed status (and nothing else)',
         (case when has_function_privilege('anon', 'public.odds_feed_status()', 'execute')
                and not has_function_privilege('anon', 'public.odds_api_dashboard(integer)', 'execute') then 1 else 0 end), 1
  union all select 6, 'alternate player props, secondary props, scores and historical calls are OFF',
         (select count(*) from public.odds_api_categories where category in ('props_alt', 'props_extra', 'scores', 'historical_events', 'historical_props') and not enabled)::int, 5
  union all select 7, 'main markets within 3 h of kickoff refresh at most every 20 minutes',
         (select count(*) from public.odds_api_cadence where category = 'featured' and sport_group = '*' and max_hours_to_start = 3 and interval_minutes = 20)::int, 1
  union all select 8, 'NFL props within 3 h at most hourly; beyond 48 h never',
         (select count(*) from public.odds_api_cadence where category = 'props' and sport_group = 'nfl'
            and ((max_hours_to_start = 3 and interval_minutes = 60) or (max_hours_to_start = 1000000 and interval_minutes is null)))::int, 2
  union all select 9, 'the provider allowlist is football first (NFL and NCAAF at priority 1)',
         (select count(*) from public.odds_api_sports where sport_key in ('americanfootball_nfl', 'americanfootball_ncaaf') and priority = 1)::int, 2
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

