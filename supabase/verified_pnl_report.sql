-- ============================================================================
-- EDGEDESK — VERIFIED P&L: the verification report. READ ONLY: paste into the
-- SQL editor any time after model_pnl_verified_views.sql and a sync
-- (tools/record/pnl_sync.js). It writes nothing. docs/pnl/DESIGN.md
--   A  graded decisions                 F  verified ROI
--   B  P&L-eligible (verified) decisions G  breakdown by market type
--   C  record-only decisions            H  sample decisions with price and P&L
--   D  net verified P&L (units)         I  data-integrity errors
--   E  total units risked               and graded = verified + record only
-- "Graded decisions" are the graded record: the model's published numbers and
-- the BETs (staked: each at its recorded stake, or the default when none).
-- ============================================================================

-- A–F and the reconciliation, in one row
select s.graded_decisions                                        as "A graded decisions",
       s.total_verified_bets                                     as "B verified (P&L-eligible) decisions",
       s.record_only_decisions                                   as "C record-only decisions",
       s.net_units                                               as "D net verified P&L (units)",
       s.units_risked                                            as "E units risked",
       s.roi_percent                                             as "F verified ROI %",
       s.wins || '-' || s.losses || '-' || s.pushes              as "W-L-P (verified)",
       s.pending_priced                                          as "priced, pending",
       case when s.graded_decisions = s.total_verified_bets + s.record_only_decisions then 'reconciles' else 'DOES NOT RECONCILE' end as "A = B + C"
from public.verified_pnl_summary('staked') s;

-- G: by market type (and by league)
select 'market' as by, b.* from public.verified_pnl_breakdown('market_type', 'staked') b
union all
select 'league', b.* from public.verified_pnl_breakdown('league', 'staked') b
order by 1, 2;

-- why the record-only decisions carry no verified price
select pnl_exclusion_reason, coalesce(price_lookup ->> 'why', '—') as detail, count(*) as decisions
from public.model_pnl
where rec_class in ('MODEL', 'BET') and record_state = 'RECORD_ONLY'
group by 1, 2 order by 3 desc;

-- H: sample decisions — every verified one first (with its stored price), then record-only ones
(select decision_id, event_label, selection, market_type, book, american_odds, price_timestamp, decision_timestamp,
        stake_units, stake_source, price_source, result, profit_units, pnl_verified, pnl_exclusion_reason
   from public.verified_pnl_decisions
  where pnl_verified and rec_class in ('MODEL', 'BET')
  order by event_time desc, decision_id limit 40)
union all
(select decision_id, event_label, selection, market_type, book, american_odds, price_timestamp, decision_timestamp,
        stake_units, stake_source, price_source, result, profit_units, pnl_verified, pnl_exclusion_reason
   from public.verified_pnl_decisions
  where record_state = 'RECORD_ONLY' and rec_class in ('MODEL', 'BET')
  order by event_time desc, decision_id limit 5);

-- I: the integrity checks — every 'error' row must read 0
select * from public.verified_pnl_integrity() order by severity, check_key;
