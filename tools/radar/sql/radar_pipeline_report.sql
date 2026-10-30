-- =============================================================================
-- Prediction Radar, stage by stage. READ-ONLY: it writes nothing.
-- Deploy Prediction Radar runs it (the report input, and after run_now) with
-- the database URL; tools/radar/radar_sql.test.js runs it on a test database.
-- Needs supabase/radar.sql and radar_record.sql as of H-RADAR-02
-- (radar_sync_state(), the H-RADAR-02 wallet columns).
--
-- Each query answers one question:
--   1 which rules, which hypothesis, registered and on, and the sync state
--   2 every Radar sync run in the last 24 hours, by mode and status
--   3 the latest run of each mode, with its message and counts
--   4 discovery and evaluation: candidates, exclusions by reason, complete
--     histories, the pool
--   5 the current grade, by style: graded, ranked, positive score, featured
--   6 the covered game markets in the window: matched, unmatched and why
--   7 the stages in order, and the first one that reaches zero
--   8 what went wrong in the last 24 hours: failed and refused runs by
--     message, and the alerts by code
--   9 the Polymarket request budget (the gateway's ledger, by UTC day), and
--     which mode was granted what today
--  10 the unmatched covered markets in the window, by league and reason, with
--     an example of each
-- =============================================================================

-- 1 versions and state
select 'rules_version' as item, public.radar_rules() ->> 'rules_version' as value
union all select 'hypothesis', public.radar_hypothesis()
union all select 'registered (the live hypothesis is in radar_config)', public.radar_registered()::text
union all select 'enabled (POLYMARKET_DATA_ENABLED, the database half)', public.radar_enabled()::text
union all select 'current grading run', (select run_id::text || ', finished ' || to_char(finished_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC, ' || grading_version
                                             from public.poly_grade_runs where run_id = public.radar_current_run())
union all select 'sync state', public.radar_sync_state()::text;

-- 2 the runs in the last 24 hours
select mode, status, count(*) as runs, to_char(max(finished_at) at time zone 'utc', 'MM-DD HH24:MI') as latest_utc, sum(requests) as polymarket_requests
  from public.poly_sync_runs where finished_at > now() - interval '24 hours'
 group by mode, status order by mode, status;

-- 3 the latest run of each mode
select distinct on (mode) mode, status, to_char(finished_at at time zone 'utc', 'MM-DD HH24:MI') as finished_utc, requests,
       left(coalesce(message, ''), 200) as message,
       left((details - 'gateway' - 'grant' - 'alerts' - 'wallets' - 'skipped')::text, 400) as details
  from public.poly_sync_runs order by mode, finished_at desc;

-- 4 discovery and evaluation (exclusions by reason)
select count(*) filter (where board_rank is not null)                                   as board_candidates,
       count(*) filter (where screen_flag)                                               as screen_flagged,
       count(*) filter (where board_rank is not null and eval_status = 'pending')        as not_read_yet,
       count(*) filter (where eval_status = 'evaluating')                                as reading,
       count(*) filter (where eval_status = 'evaluated')                                 as complete_histories,
       count(*) filter (where eval_status = 'high_frequency')                            as excluded_high_frequency,
       count(*) filter (where eval_status = 'insufficient_history')                      as excluded_insufficient_history,
       count(*) filter (where eval_status = 'evaluated'
                          and coalesce(window_covered_bets, 0) < (public.radar_rules() ->> 'pool_min_covered_bets')::int) as complete_but_too_few_covered_bets,
       count(*) filter (where in_pool)                                                   as pool
  from public.poly_wallets;

-- 5 the current grade, by style
select g.style, count(*) as graded, count(*) filter (where g.sample = 'ranked') as ranked,
       count(*) filter (where g.radar_score > 0) as positive_score, count(*) filter (where g.high_frequency) as high_frequency,
       count(*) filter (where g.top_directional) as featured
  from public.poly_wallet_grades g where g.run_id = public.radar_current_run()
 group by g.style order by g.style;

-- 6 the covered game markets in the window (radar_rules().upcoming_hours), matched or not
select coalesce(match_status, '?') as match_status, coalesce(match_reason, '') as reason, count(*) as markets, count(distinct event_id) as games
  from public.poly_markets
 where game_start_at > now() and game_start_at <= now() + make_interval(hours => public.radar_rule('upcoming_hours')::int)
 group by 1, 2 order by 3 desc;

-- 7 the stages, in order, and where the count first reaches zero
with mk as (
  select condition_id, event_id from public.poly_markets
   where event_id is not null and game_start_at > now() and game_start_at <= now() + make_interval(hours => public.radar_rule('upcoming_hours')::int)
), snap as (
  select distinct on (h.condition_id) h.condition_id, h.run_id from public.poly_holder_snapshots h join mk on mk.condition_id = h.condition_id
   where h.captured_at > now() - make_interval(mins => public.radar_rule('holders_fresh_min')::int)
   order by h.condition_id, h.captured_at desc, h.run_id
), held as (
  select h.wallet, h.condition_id from public.poly_holder_snapshots h join snap s on s.condition_id = h.condition_id and s.run_id = h.run_id
), cur as (
  select wallet, top_directional from public.poly_wallet_grades where run_id = public.radar_current_run()
), s (n, stage, cnt) as (values
  (1,  'discovery: candidates from the 30-day board',                        (select count(*) from public.poly_wallets where board_rank is not null)),
  (2,  'complete 90-day histories (evaluated)',                             (select count(*) from public.poly_wallets where eval_status = 'evaluated')),
  (3,  'the pool (evaluated, enough covered bets)',                         (select count(*) from public.poly_wallets where in_pool)),
  (4,  'graded in the current run',                                         (select count(*) from cur)),
  (5,  'qualified: featured (positive score, followable)',                  (select count(*) from cur where top_directional)),
  (6,  'covered games in the window, matched to EdgeDesk games',            (select count(distinct event_id) from mk)),
  (7,  'open positions of pool wallets on them (fresh holders)',            (select count(*) from held)),
  (8,  'open positions of featured wallets on them',                        (select count(*) from held join cur on cur.wallet = held.wallet and cur.top_directional)),
  (9,  'Smart Money Tonight cards',                                         (select count(*) from public.radar_tonight_cards())),
  (10, 'observed activity cards (apart: not a signal)',                     (select count(*) from public.radar_observed_cards())),
  (11, 'cards recorded in the last 24 hours (the Radar record)',            (select count(*) from public.radar_cards where published_at > now() - interval '24 hours'))
)
select n, stage, cnt,
       case when n <= 9 and cnt = 0 and not exists (select 1 from s z where z.n < s.n and z.cnt = 0) then '<- the featured path first reaches zero here' else '' end as note
  from s order by n;

-- 8 what went wrong in the last 24 hours
select mode, status, left(coalesce(message, ''), 180) as message, count(*) as runs, to_char(max(finished_at) at time zone 'utc', 'MM-DD HH24:MI') as latest_utc
  from public.poly_sync_runs where finished_at > now() - interval '24 hours' and status in ('error', 'skipped')
 group by 1, 2, 3 order by runs desc limit 15;
select severity, code, count(*) as alerts, left(max(message), 180) as example, to_char(max(created_at) at time zone 'utc', 'MM-DD HH24:MI') as latest_utc
  from public.poly_alerts where created_at > now() - interval '24 hours'
 group by 1, 2 order by alerts desc limit 15;

-- 9 the request budget
select day, granted, used, (public.radar_rules() ->> 'daily_request_ceiling')::int as ceiling from public.poly_api_days order by day desc limit 3;
select split_part(caller, ':', 2) as mode, decision, count(*) as grants, sum(granted) as granted
  from public.poly_api_grants where granted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
 group by 1, 2 order by 1, 2;
-- grants never settled (their run died before poly_api_settle): each holds its whole grant for the rest of the UTC day
select split_part(g.caller, ':', 2) as mode, count(*) as unsettled_grants, sum(g.granted) as requests_held
  from public.poly_api_grants g left join public.poly_api_settlements s on s.grant_id = g.grant_id
 where s.grant_id is null and g.decision = 'granted' and g.granted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
 group by 1 order by 1;

-- 10 the unmatched covered markets in the window, by league and reason
select league, coalesce(match_reason, '(not tried)') as reason, count(*) as markets, count(distinct event_ref) as polymarket_games, left(min(event_title), 70) as example
  from public.poly_markets
 where event_id is null and game_start_at > now() and game_start_at <= now() + make_interval(hours => public.radar_rule('upcoming_hours')::int)
 group by 1, 2 order by markets desc limit 15;
