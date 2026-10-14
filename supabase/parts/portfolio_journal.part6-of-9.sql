-- portfolio_journal -- part 6 of 9.
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
        'ret_n', count(ret), 'ret_sum', coalesce(sum(ret), 0), 'ret_sq', coalesce(sum(ret * ret), 0),
        -- units won or lost: P&L in the unit size recorded with each position; only
        -- where one was recorded (never a unit size applied after the fact)
        'units_pnl', round(sum(pnl * units / stake_amt) filter (where units is not null and stake_amt > 0), 4),
        'units_n', count(*) filter (where units is not null and stake_amt > 0)) from st),
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
-- The bankroll path: settled P&L by settlement day (the reader's zone),
-- cumulative, and the drawdown from the running peak — the largest, and the
-- one standing now. Reads the same cached facts as the summary, as the
-- caller, so it is the reader's own rows and nothing else; no position list
-- is sent to the page to draw it.
create or replace function public.portfolio_pnl_path(p_from timestamptz, p_to timestamptz, p_tz text default null, p_platform text default null)
returns jsonb language sql volatile set jit = off as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  d as (select f.settled_day as day, sum(f.pnl) as pnl, count(*) as n
          from z, public.portfolio_facts_cached(p_from, p_to, z.tz, p_platform) f where f.in_settled and f.pnl is not null group by f.settled_day),
  c as (select day, pnl, n, sum(pnl) over (order by day) as cum from d),
  k as (select day, pnl, n, cum, greatest(0, max(cum) over (order by day)) as peak from c),
  w as (select day, pnl, n, cum, peak, peak - cum as dd from k)
  select jsonb_build_object(
    'days', (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'pnl', pnl, 'cumulative', cum, 'drawdown', dd, 'n', n) order by day), '[]'::jsonb) from w),
    'max_drawdown', (select coalesce(max(dd), 0) from w),
    'max_drawdown_on', (select day from w where dd > 0 order by dd desc, day limit 1),
    'peak', (select coalesce(max(peak), 0) from w),
    'current_drawdown', (select dd from w order by day desc limit 1))
$$;
