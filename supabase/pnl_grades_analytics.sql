-- ============================================================================
-- EDGEDESK — pnl_grades, part 3 of 3: the public rollup and the
-- reconciliation. docs/pnl/GRADES.md. Run pnl_grades.sql and
-- pnl_grades_sync.sql first (the guard says so).
--
--   · pnl_summary: graded count, W-L-P, units risked and won, ROI, the same at
--     the closing price, and every ungraded / void / not-a-bet count, by
--     sport × verdict (BET and LEAN apart) × market type, for all time and per
--     month, week and day (America/Chicago, dated by kickoff). A dimension
--     reads 'ALL' where it is rolled up. ROI = units won ÷ units risked × 100;
--     a push is 1u risked and returned, a void is not risked.
--   · the live board stays private: a flag whose game has not started is not
--     counted anywhere in the view (the same rule as the table's RLS policy;
--     it reaches the view the moment the game starts).
--   · pnl_reconciliation(): settled flags with no P&L row must be 0.
-- Idempotent and additive. Ends in a report whose rows must all read ok.
-- ============================================================================

do $dep$ begin
  if to_regprocedure('public.pnl_grades_compute(public.signals)') is null then
    raise exception 'pnl_grades_analytics.sql builds on pnl_grades.sql and pnl_grades_sync.sql: run those first';
  end if;
end $dep$;

create or replace view public.pnl_summary as
with g as (
  select p.*, (coalesce(p.event_at, p.settled_at, p.flagged_at) at time zone 'America/Chicago') as bet_local
    from public.pnl_grades p
   where p.settled_at is not null or (p.event_at is not null and p.event_at <= now())
), x as (
  select 'all'::text as period_type, null::date as period_start, g.* from g
  union all select 'month', date_trunc('month', g.bet_local)::date, g.* from g
  union all select 'week', date_trunc('week', g.bet_local)::date, g.* from g
  union all select 'day', g.bet_local::date, g.* from g
)
select x.period_type, x.period_start,
  case when grouping(x.sport_key) = 1 then 'ALL' else coalesce(x.sport_key, 'unknown') end as sport_key,
  case when grouping(x.sport_key) = 1 then 'All sports' else coalesce(max(x.sport_title), x.sport_key, 'unknown') end as sport_title,
  case when grouping(x.verdict) = 1 then 'ALL' else x.verdict end as verdict,
  case when grouping(x.market_type) = 1 then 'ALL' else x.market_type end as market_type,
  count(*) as flags,
  count(*) filter (where x.pnl_status = 'graded') as graded,
  count(*) filter (where x.pnl_status = 'graded' and x.result = 'win') as wins,
  count(*) filter (where x.pnl_status = 'graded' and x.result = 'loss') as losses,
  count(*) filter (where x.pnl_status = 'graded' and x.result = 'push') as pushes,
  coalesce(sum(x.stake_units) filter (where x.pnl_status = 'graded'), 0) as units_risked,
  coalesce(sum(x.pnl_units) filter (where x.pnl_status = 'graded'), 0) as units_won,
  100 * sum(x.pnl_units) filter (where x.pnl_status = 'graded')
      / nullif(sum(x.stake_units) filter (where x.pnl_status = 'graded'), 0) as roi_pct,
  count(*) filter (where x.pnl_units_at_close is not null) as graded_with_close,
  coalesce(sum(x.stake_units) filter (where x.pnl_units_at_close is not null), 0) as units_risked_at_close,
  coalesce(sum(x.pnl_units_at_close), 0) as units_won_at_close,
  100 * sum(x.pnl_units_at_close) / nullif(sum(x.stake_units) filter (where x.pnl_units_at_close is not null), 0) as roi_at_close_pct,
  count(*) filter (where x.pnl_status = 'void') as void,
  count(*) filter (where x.pnl_status = 'ungraded_missing_price') as ungraded_missing_price,
  count(*) filter (where x.pnl_status = 'ungraded_unsettled') as ungraded_unsettled,
  count(*) filter (where x.pnl_status = 'ungraded_unsupported') as ungraded_unsupported,
  count(*) filter (where x.pnl_status = 'not_a_bet') as not_a_bet,
  max(x.computed_at) as last_computed_at
from x
group by grouping sets (
  (x.period_type, x.period_start, x.sport_key, x.verdict, x.market_type),
  (x.period_type, x.period_start, x.sport_key, x.verdict),
  (x.period_type, x.period_start, x.sport_key),
  (x.period_type, x.period_start, x.verdict, x.market_type),
  (x.period_type, x.period_start, x.verdict),
  (x.period_type, x.period_start, x.market_type),
  (x.period_type, x.period_start)
);
comment on view public.pnl_summary is
  'P&L rollups over pnl_grades. Owner-run on purpose (the pattern of public_record): it exposes counts and units, never a live flag.';

-- Settled flags with no P&L row must be 0. Counts only, so anyone may ask.
create or replace function public.pnl_reconciliation()
returns table (check_name text, n bigint, state text)
language sql stable security definer set search_path = public as $f$
  with f as (
    select s.sig_key, public.pnl_norm_result(s.result) as res, case when s.flagged_best_dec > 1 then s.flagged_best_dec end as price
      from public.signals s where s.flagged_at is not null
  ), c as (
    select 1 as o, 'settled flags with no P&L row'::text as k,
           (select count(*) from f where f.res in ('win', 'loss', 'push', 'void')
              and not exists (select 1 from public.pnl_grades p where p.sig_key = f.sig_key)) as v
    union all select 2, 'P&L rows out of step with their signal',
           (select count(*) from f join public.pnl_grades p on p.sig_key = f.sig_key
             where p.result is distinct from (case when f.res in ('win', 'loss', 'push', 'void') then f.res end)
                or p.price_at_flag is distinct from f.price)
    union all select 3, 'flags with no P&L row yet (any state)',
           (select count(*) from f where not exists (select 1 from public.pnl_grades p where p.sig_key = f.sig_key))
    union all select 4, 'grading errors not yet repaired (last 7 days)',
           (select count(*) from public.pnl_grades_errors e left join public.pnl_grades p on p.sig_key = e.sig_key
             where e.at > now() - interval '7 days' and (p.sig_key is null or p.computed_at < e.at))
    union all select 5, 'rows on an older calc_version',
           (select count(*) from public.pnl_grades p where p.calc_version <> public.pnl_calc_version())
  )
  select c.k, c.v, case when c.v = 0 then 'ok' else 'CHECK THIS' end from c order by c.o
$f$;

revoke all on public.pnl_summary from anon, authenticated;
grant select on public.pnl_summary to anon, authenticated, service_role;
revoke all on function public.pnl_reconciliation() from public;
grant execute on function public.pnl_reconciliation() to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'pnl_summary: anon may read it' as piece,
    case when has_table_privilege('anon', 'public.pnl_summary', 'select') then 'ok' else 'CHECK THIS' end as state
  union all select 'all-time units won = the raw sum of pnl_units over the same rows',
    case when (select units_won from public.pnl_summary where period_type = 'all' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL')
              is not distinct from (select coalesce(sum(pnl_units), 0) from public.pnl_grades where pnl_status = 'graded')
           or not exists (select 1 from public.pnl_summary) then 'ok' else 'CHECK THIS' end
  union all select 'every month adds back up to all time',
    case when not exists (select 1 from public.pnl_summary)
           or (select sum(units_won) from public.pnl_summary where period_type = 'month' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL')
              = (select units_won from public.pnl_summary where period_type = 'all' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL')
         then 'ok' else 'CHECK THIS' end
  union all select 'pnl_reconciliation(): anyone may ask, counts only',
    case when has_function_privilege('anon', 'public.pnl_reconciliation()', 'execute') then 'ok' else 'CHECK THIS' end
) r order by 1;
