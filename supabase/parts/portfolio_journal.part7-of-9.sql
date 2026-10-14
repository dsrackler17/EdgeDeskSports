-- portfolio_journal -- part 7 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.portfolio_cells(p_from timestamptz, p_to timestamptz, p_tz text default null, p_platform text default null,
    p_segments boolean default true)
returns table (dim text, key text, n bigint, settled bigint, wins bigint, losses bigint, staked numeric, pnl numeric,
  ret_n bigint, ret_sum numeric, ret_sq numeric, clv_n bigint, clv_sum numeric, clv_sq numeric,
  ps_n bigint, ps_sum numeric, ps_sq numeric, units_n bigint, units_sum numeric, segs jsonb)
language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  f as materialized (
    select f.ret, f.pnl, f.stake_amt, f.result, f.clv_pct, f.process_score, f.units, f.decile, f.decision_tags,
           f.platform as k_platform,
           f.platform_type as k_platform_type,
           coalesce(f.sport, 'UNKNOWN') as k_sport,
           coalesce(f.league, 'UNKNOWN') as k_league,
           f.position_type as k_position_type,
           f.source as k_source,
           f.timing_bucket as k_timing,
           f.placed_dow::text as k_placed_dow,
           coalesce(f.event_dow::text, 'UNKNOWN') as k_event_dow,
           f.hour_band as k_hour,
           f.odds_band as k_odds,
           f.units_band as k_units,
           coalesce(f.decision_source, 'UNRECORDED') as k_decision_source,
           case f.planned when true then 'PLANNED' when false then 'UNPLANNED' else 'UNTAGGED' end as k_planned,
           f.after_result as k_after,
           case when f.session_order = 1 then 'FIRST' when f.session_order <= 3 then 'SECOND_THIRD' else 'FOURTH_PLUS' end as k_session,
           coalesce(f.would_repeat, 'UNREVIEWED') as k_repeat,
           f.evidence as k_evidence,
           f.stake_type as k_stake_type,
           coalesce(f.sport, 'UNKNOWN') || ' · ' || f.position_type as k_sport_type,
           f.timing_bucket || ' · ' || f.position_type as k_timing_type,
           f.platform || ' · ' || f.position_type as k_platform_type_pos
      from z, public.portfolio_facts_cached(p_from, p_to, z.tz, p_platform) f where f.in_placed),
  g as (
    select case when grouping(k_platform) = 0 then 'platform' when grouping(k_platform_type) = 0 then 'platform_type' when grouping(k_sport) = 0 then 'sport' when grouping(k_league) = 0 then 'league' when grouping(k_position_type) = 0 then 'position_type' when grouping(k_source) = 0 then 'source' when grouping(k_timing) = 0 then 'timing' when grouping(k_placed_dow) = 0 then 'placed_dow' when grouping(k_event_dow) = 0 then 'event_dow' when grouping(k_hour) = 0 then 'hour' when grouping(k_odds) = 0 then 'odds' when grouping(k_units) = 0 then 'units' when grouping(k_decision_source) = 0 then 'decision_source' when grouping(k_planned) = 0 then 'planned' when grouping(k_after) = 0 then 'after' when grouping(k_session) = 0 then 'session' when grouping(k_repeat) = 0 then 'repeat' when grouping(k_evidence) = 0 then 'evidence' when grouping(k_stake_type) = 0 then 'stake_type' when grouping(k_sport_type) = 0 then 'sport_type' when grouping(k_timing_type) = 0 then 'timing_type' when grouping(k_platform_type_pos) = 0 then 'platform_type_pos' else 'all' end as dim, coalesce(k_platform, k_platform_type, k_sport, k_league, k_position_type, k_source, k_timing, k_placed_dow, k_event_dow, k_hour, k_odds, k_units, k_decision_source, k_planned, k_after, k_session, k_repeat, k_evidence, k_stake_type, k_sport_type, k_timing_type, k_platform_type_pos, 'all') as key,
           count(*), count(ret), count(*) filter (where result = 'WIN'), count(*) filter (where result = 'LOSS'),
         coalesce(sum(stake_amt) filter (where ret is not null), 0), coalesce(sum(pnl) filter (where ret is not null), 0),
         count(ret), coalesce(sum(ret), 0), coalesce(sum(ret * ret), 0),
         count(clv_pct), coalesce(sum(clv_pct), 0), coalesce(sum(clv_pct * clv_pct), 0),
         count(process_score), coalesce(sum(process_score), 0), coalesce(sum(process_score * process_score), 0),
         count(units), coalesce(sum(units), 0),
         case when p_segments then jsonb_build_object(
           'h1', jsonb_build_array(count(ret) filter (where decile <= 5), coalesce(sum(ret) filter (where decile <= 5), 0), coalesce(sum(ret * ret) filter (where decile <= 5), 0),
                                   count(clv_pct) filter (where decile <= 5), coalesce(sum(clv_pct) filter (where decile <= 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile <= 5), 0),
                                   count(process_score) filter (where decile <= 5), coalesce(sum(process_score) filter (where decile <= 5), 0), coalesce(sum(process_score * process_score) filter (where decile <= 5), 0)),
           'h2', jsonb_build_array(count(ret) filter (where decile > 5), coalesce(sum(ret) filter (where decile > 5), 0), coalesce(sum(ret * ret) filter (where decile > 5), 0),
                                   count(clv_pct) filter (where decile > 5), coalesce(sum(clv_pct) filter (where decile > 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 5), 0),
                                   count(process_score) filter (where decile > 5), coalesce(sum(process_score) filter (where decile > 5), 0), coalesce(sum(process_score * process_score) filter (where decile > 5), 0)),
           'ho', jsonb_build_array(count(ret) filter (where decile > 7), coalesce(sum(ret) filter (where decile > 7), 0), coalesce(sum(ret * ret) filter (where decile > 7), 0),
                                   count(clv_pct) filter (where decile > 7), coalesce(sum(clv_pct) filter (where decile > 7), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 7), 0),
                                   count(process_score) filter (where decile > 7), coalesce(sum(process_score) filter (where decile > 7), 0), coalesce(sum(process_score * process_score) filter (where decile > 7), 0))) end
      from f group by grouping sets ((), (k_platform), (k_platform_type), (k_sport), (k_league), (k_position_type), (k_source), (k_timing), (k_placed_dow), (k_event_dow), (k_hour), (k_odds), (k_units), (k_decision_source), (k_planned), (k_after), (k_session), (k_repeat), (k_evidence), (k_stake_type), (k_sport_type), (k_timing_type), (k_platform_type_pos))),
  t as (
    select 'tag'::text as dim, x.tag as key,
           count(*), count(ret), count(*) filter (where result = 'WIN'), count(*) filter (where result = 'LOSS'),
         coalesce(sum(stake_amt) filter (where ret is not null), 0), coalesce(sum(pnl) filter (where ret is not null), 0),
         count(ret), coalesce(sum(ret), 0), coalesce(sum(ret * ret), 0),
         count(clv_pct), coalesce(sum(clv_pct), 0), coalesce(sum(clv_pct * clv_pct), 0),
         count(process_score), coalesce(sum(process_score), 0), coalesce(sum(process_score * process_score), 0),
         count(units), coalesce(sum(units), 0),
         case when p_segments then jsonb_build_object(
           'h1', jsonb_build_array(count(ret) filter (where decile <= 5), coalesce(sum(ret) filter (where decile <= 5), 0), coalesce(sum(ret * ret) filter (where decile <= 5), 0),
                                   count(clv_pct) filter (where decile <= 5), coalesce(sum(clv_pct) filter (where decile <= 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile <= 5), 0),
                                   count(process_score) filter (where decile <= 5), coalesce(sum(process_score) filter (where decile <= 5), 0), coalesce(sum(process_score * process_score) filter (where decile <= 5), 0)),
           'h2', jsonb_build_array(count(ret) filter (where decile > 5), coalesce(sum(ret) filter (where decile > 5), 0), coalesce(sum(ret * ret) filter (where decile > 5), 0),
                                   count(clv_pct) filter (where decile > 5), coalesce(sum(clv_pct) filter (where decile > 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 5), 0),
                                   count(process_score) filter (where decile > 5), coalesce(sum(process_score) filter (where decile > 5), 0), coalesce(sum(process_score * process_score) filter (where decile > 5), 0)),
           'ho', jsonb_build_array(count(ret) filter (where decile > 7), coalesce(sum(ret) filter (where decile > 7), 0), coalesce(sum(ret * ret) filter (where decile > 7), 0),
                                   count(clv_pct) filter (where decile > 7), coalesce(sum(clv_pct) filter (where decile > 7), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 7), 0),
                                   count(process_score) filter (where decile > 7), coalesce(sum(process_score) filter (where decile > 7), 0), coalesce(sum(process_score * process_score) filter (where decile > 7), 0))) end
      from (select f.*, tg.tag from f cross join lateral unnest(coalesce(f.decision_tags, array['UNTAGGED']::text[])) tg(tag)) x
     group by x.tag)
  select * from g union all select * from t
$$;

-- Three different questions, kept apart: what did I ENTER on a day (placed),
-- what EVENTS did I have exposure to that day (event start), and what
-- SETTLED that day (P&L).
create or replace function public.portfolio_calendar(p_from date, p_to date, p_tz text default null, p_platform text default null)
returns table (day date, placed bigint, placed_staked numeric, events bigint, event_exposure numeric, settled bigint, pnl numeric,
  wins bigint, losses bigint, pushes bigint, graded bigint, process numeric)
language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  f as (select f.* from z, public.portfolio_facts_cached((p_from::timestamp at time zone z.tz), (least(p_to, p_from + 400)::timestamp at time zone z.tz), z.tz, p_platform) f),
  ev as (select f.placed_day as day, 1 as placed, f.stake_amt as placed_staked, 0 as events, null::numeric as exposure, 0 as settled,
                null::numeric as pnl, null::text as result, f.process_score
           from f where f.in_placed
         union all
         select f.event_day, 0, null, 1, f.stake_amt, 0, null, null, null from f where f.in_event
         union all
         select f.settled_day, 0, null, 0, null, 1, f.pnl, f.result, null from f where f.in_settled)
  select ev.day, sum(ev.placed)::bigint, coalesce(sum(ev.placed_staked), 0), sum(ev.events)::bigint, coalesce(sum(ev.exposure), 0),
         sum(ev.settled)::bigint, sum(ev.pnl),
         count(*) filter (where ev.result = 'WIN'), count(*) filter (where ev.result = 'LOSS'), count(*) filter (where ev.result in ('PUSH', 'VOID')),
         count(ev.process_score), round(avg(ev.process_score), 1)
    from ev group by ev.day order by ev.day
$$;

-- The history folders: year → month → week → day, each with its summary.
-- Without a year: the years and their months. With one: that year to the
-- day. A week is Monday-based and, inside a month folder, holds only that
-- month's days.
create or replace function public.portfolio_periods(p_tz text default null, p_year int default null, p_platform text default null)
returns table (level text, year int, month int, week date, day date, placed bigint, staked numeric, settled bigint, pnl numeric,
  wins bigint, losses bigint, graded bigint, process numeric)
language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  f as (select f.* from z, public.portfolio_facts_cached(
          case when p_year is null then null else (make_date(p_year, 1, 1)::timestamp at time zone z.tz) end,
          case when p_year is null then null else (make_date(p_year + 1, 1, 1)::timestamp at time zone z.tz) end, z.tz, p_platform) f),
  ev as (select f.placed_day as d, 1 as placed, f.stake_amt as staked, 0 as settled, null::numeric as pnl, null::text as result, f.process_score
           from f where f.in_placed
         union all
         select f.settled_day, 0, null, 1, f.pnl, f.result, null from f where f.in_settled),
  k as (select extract(year from ev.d)::int as y, extract(month from ev.d)::int as m, date_trunc('week', ev.d)::date as w, ev.* from ev),
  g as (select case when grouping(k.m) = 1 then 'year' when grouping(k.w) = 1 then 'month' when grouping(k.d) = 1 then 'week' else 'day' end as level,
               k.y, k.m, k.w, k.d, sum(k.placed)::bigint as placed, coalesce(sum(k.staked), 0) as staked, sum(k.settled)::bigint as settled,
               sum(k.pnl) as pnl, count(*) filter (where k.result = 'WIN') as wins, count(*) filter (where k.result = 'LOSS') as losses,
               count(k.process_score) as graded, round(avg(k.process_score), 1) as process
          from k group by grouping sets ((k.y), (k.y, k.m), (k.y, k.m, k.w), (k.y, k.m, k.w, k.d)))
  select g.level, g.y, g.m, g.w, g.d, g.placed, g.staked, g.settled, g.pnl, g.wins, g.losses, g.graded, g.process
    from g where p_year is not null or g.level in ('year', 'month')
   order by g.y desc, g.m desc nulls first, g.w desc nulls first, g.d desc nulls first
$$;
