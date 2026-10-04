-- portfolio_journal -- part 6 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE AGGREGATES THE PAGE ASKS FOR — never a lifetime of rows
-- ─────────────────────────────────────────────────────────────────────────────
-- One window's headline: P&L by SETTLEMENT date, activity and the Decision
-- Grade by PLACED date, open exposure as it stands now. Each figure carries
-- its sample size.
create or replace function public.portfolio_summary(p_from timestamptz, p_to timestamptz, p_tz text default null, p_platform text default null)
returns jsonb language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  f as (select f.* from z, public.portfolio_facts_cached(p_from, p_to, z.tz, p_platform) f),
  st as (select * from f where in_settled),
  pl as (select * from f where in_placed),
  band as (select case when process_score is null then 'UNGRADED' when process_score >= 66 then 'GOOD' when process_score >= 45 then 'AVERAGE' else 'POOR' end as b,
                  case when status = 'OPEN' then 'OPEN' when result in ('WIN', 'LOSS') then result else 'OTHER' end as o, pnl from pl),
  cells as (select b, o, count(*) as n, sum(pnl) as pnl from band group by b, o)
  select jsonb_build_object(
    'tz', (select tz from z), 'from', p_from, 'to', p_to,
    'settled', (select jsonb_build_object('n', count(*), 'pnl', coalesce(sum(pnl), 0), 'staked', coalesce(sum(stake_amt), 0),
        'roi', case when sum(stake_amt) > 0 then round(sum(pnl) / sum(stake_amt), 6) end,
        'wins', count(*) filter (where result = 'WIN'), 'losses', count(*) filter (where result = 'LOSS'),
        'pushes', count(*) filter (where result in ('PUSH', 'VOID')), 'cashouts', count(*) filter (where result = 'CASHOUT'),
        'sportsbook', jsonb_build_object('n', count(*) filter (where platform_type = 'SPORTSBOOK'), 'pnl', coalesce(sum(pnl) filter (where platform_type = 'SPORTSBOOK'), 0),
          'staked', coalesce(sum(stake_amt) filter (where platform_type = 'SPORTSBOOK'), 0)),
        'prediction', jsonb_build_object('n', count(*) filter (where platform_type = 'PREDICTION_MARKET'), 'pnl', coalesce(sum(pnl) filter (where platform_type = 'PREDICTION_MARKET'), 0),
          'staked', coalesce(sum(stake_amt) filter (where platform_type = 'PREDICTION_MARKET'), 0)),
        'ret_n', count(ret), 'ret_sum', coalesce(sum(ret), 0), 'ret_sq', coalesce(sum(ret * ret), 0)) from st),
    'placed', (select jsonb_build_object('n', count(*), 'staked', coalesce(sum(stake_amt), 0), 'days', count(distinct placed_day),
        'units', sum(units), 'units_n', count(units)) from pl),
    'process', (select jsonb_build_object('n', count(*), 'graded', count(process_score), 'score', round(avg(process_score), 1),
        'letter', public.portfolio_grade_letter(round(avg(process_score), 1)), 'confidence', public.portfolio_confidence(count(process_score)),
        'coverage', round(avg(process_weight) filter (where process_score is not null), 1),
        'ps_sum', coalesce(sum(process_score), 0), 'ps_sq', coalesce(sum(process_score * process_score), 0),
        'components', jsonb_build_object(
          'clv', jsonb_build_object('n', count(s_clv), 'avg', round(avg(s_clv), 1)),
          'model', jsonb_build_object('n', count(s_model), 'avg', round(avg(s_model), 1)),
          'price', jsonb_build_object('n', count(s_price), 'avg', round(avg(s_price), 1)),
          'sizing', jsonb_build_object('n', count(s_sizing), 'avg', round(avg(s_sizing), 1)),
          'timing', jsonb_build_object('n', count(s_timing), 'avg', round(avg(s_timing), 1)),
          'rules', jsonb_build_object('n', count(s_rules), 'avg', round(avg(s_rules), 1)),
          'market', jsonb_build_object('n', count(s_market), 'avg', round(avg(s_market), 1))),
        'clv', jsonb_build_object('n', count(clv_pct), 'avg_pct', round(avg(clv_pct), 6), 'sum', coalesce(sum(clv_pct), 0), 'sq', coalesce(sum(clv_pct * clv_pct), 0),
          'beat', count(*) filter (where clv_pct > 0 or clv_points > 0), 'with_close', count(*) filter (where clv_pct is not null or clv_points is not null),
          'points_n', count(clv_points), 'avg_points', round(avg(clv_points), 2)),
        'model_ev', jsonb_build_object('n', count(model_ev), 'avg', round(avg(model_ev), 6)),
        'price_slip', jsonb_build_object('n', count(price_slip), 'avg', round(avg(price_slip), 6),
          'given_up', coalesce(sum(case when price_slip < 0 then stake_amt * (-price_slip) end), 0)),
        'rules', jsonb_build_object('applicable', coalesce(sum(rules_applicable), 0), 'followed', coalesce(sum(rules_followed), 0),
          'positions_broken', count(*) filter (where rules_followed < rules_applicable)),
        'tagged', count(*) filter (where planned is not null or decision_tags is not null),
        'reviewed', count(would_repeat),
        'variance', jsonb_build_object('n', count(*) filter (where result in ('WIN', 'LOSS') and entry_dec > 1),
          'wins', count(*) filter (where result = 'WIN' and entry_dec > 1),
          'expected_wins', coalesce(sum(round(1 / entry_dec, 6)) filter (where result in ('WIN', 'LOSS') and entry_dec > 1), 0),
          'var', coalesce(sum(round(1 / entry_dec, 6) * (1 - round(1 / entry_dec, 6))) filter (where result in ('WIN', 'LOSS') and entry_dec > 1), 0))
      ) from pl),
    'matrix', (select coalesce(jsonb_object_agg(b || ':' || o, jsonb_build_object('n', n, 'pnl', pnl)), '{}'::jsonb) from cells),
    'open', (select jsonb_build_object('n', count(*),
        'exposure', coalesce(sum(case when p.platform_type = 'SPORTSBOOK' then p.stake else p.open_cost_basis end), 0),
        'unrealized', sum(p.unrealized_profit_loss), 'marked', count(p.unrealized_profit_loss))
       from public.portfolio_positions p where p.status = 'OPEN'
        and (p_platform is null or p.platform = p_platform or ('type:' || p.platform_type) = p_platform)),
    'evidence', (select jsonb_build_object('full', count(*) filter (where evidence = 'FULL_CONTEXT'),
        'partial', count(*) filter (where evidence = 'PARTIAL_CONTEXT'), 'result_only', count(*) filter (where evidence = 'RESULT_ONLY')) from pl),
    'platforms', (select coalesce(jsonb_agg(jsonb_build_object('platform', x.platform, 'label', x.label, 'type', x.platform_type, 'n', x.n, 'pnl', x.pnl,
        'staked', x.staked) order by x.pnl desc nulls last), '[]'::jsonb)
        from (select platform, max(platform_label) as label, platform_type, count(*) as n, coalesce(sum(pnl), 0) as pnl, coalesce(sum(stake_amt), 0) as staked
                from st group by platform, platform_type) x))
$$;

-- Breakdown cells: per dimension and value, the counts, sums and sums of
-- squares of per-position return, CLV and process score over the positions
-- PLACED in the window. With p_segments, also for the chronological halves
-- (h1, h2) and the most recent 30% (ho, the holdout) — what the coach's
-- stability tests read. The statistics run on these few hundred rows, never
-- on the positions themselves.
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
