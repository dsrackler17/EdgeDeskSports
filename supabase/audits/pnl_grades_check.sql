-- ============================================================================
-- AUDIT — pnl_grades against the raw signals. Read-only: ONE select, safe to
-- paste into the SQL editor on production at any time after the backfill
-- (tools/record/pnl_grades_sql.test.js proves it runs inside a READ ONLY
-- transaction). Every row says ok or CHECK THIS.
--
--   check 1 · hand       10 random graded rows: the raw signal (decimal price,
--                        American price, result), the stored P&L, and the same
--                        P&L worked by hand here — no pnl_* function is used
--   check 2 · summary    pnl_summary all-time units won vs a raw SUM over
--                        pnl_grades, per sport × verdict and in total
--   check 3 · reconcile  pnl_reconciliation(): settled flags with no P&L
--                        row must be 0
-- ============================================================================
with hand as (
  select p.event_label, p.selection, p.point, p.pnl_units, s.flagged_best_dec as dec, s.result as raw_result,
         lower(btrim(s.result)) as r,
         case when s.flagged_best_dec >= 2 then (s.flagged_best_dec - 1) * 100 else -100 / (s.flagged_best_dec - 1) end as am
    from public.pnl_grades p join public.signals s on s.sig_key = p.sig_key
   where p.pnl_status = 'graded'
   order by random() limit 10
), hand_checked as (
  select h.*,
         case when h.r in ('win', 'won', 'w') then case when h.am > 0 then h.am / 100 else 100 / abs(h.am) end
              when h.r in ('loss', 'lost', 'lose', 'l') then -1
              when h.r in ('push', 'p', 'tie') then 0 end as by_hand
    from hand h
), raw as (
  select case when grouping(sport_key) = 1 then 'ALL' else coalesce(sport_key, 'unknown') end as sport_key,
         case when grouping(verdict) = 1 then 'ALL' else verdict end as verdict,
         count(*) filter (where pnl_status = 'graded') as graded,
         coalesce(sum(pnl_units) filter (where pnl_status = 'graded'), 0) as units
    from public.pnl_grades
   group by grouping sets ((sport_key, verdict), ())
), out as (
  select 1 as o, 'hand' as check_kind,
         coalesce(h.event_label, '?') || ' · ' || coalesce(h.selection, '?') || coalesce(' ' || h.point::text, '') as item,
         'dec ' || h.dec::text || ' = ' || (case when h.am > 0 then '+' else '' end) || round(h.am)::text || ' · ' || h.raw_result as raw,
         h.pnl_units as stored, h.by_hand,
         case when abs(h.pnl_units - h.by_hand) < 0.000000001 then 'ok' else 'CHECK THIS' end as state
    from hand_checked h
  union all
  select 2, 'summary', r.sport_key || ' · ' || r.verdict, r.graded::text || ' graded', coalesce(s.units_won, 0), r.units,
         case when coalesce(s.units_won, 0) = r.units and coalesce(s.graded, 0) = r.graded then 'ok' else 'CHECK THIS' end
    from raw r left join public.pnl_summary s
      on s.period_type = 'all' and s.market_type = 'ALL' and s.sport_key = r.sport_key and s.verdict = r.verdict
  union all
  select 3, 'reconcile', c.check_name, null, c.n, 0, c.state from public.pnl_reconciliation() c
)
select check_kind, item, raw, stored, by_hand, state from out order by o, item;
