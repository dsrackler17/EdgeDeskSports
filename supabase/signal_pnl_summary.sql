-- ============================================================================
-- EDGEDESK — flagged-edge P&L, 2 of 3: the brief's formulas and pnl_summary.
-- Apply supabase/signal_pnl.sql first (the guard below stops otherwise).
--
-- pnl_summary rolls pnl_grades up by sport, tier, market type, day / week /
-- month and all-time. Every row says which cut it is (grain + breakdown); a
-- NULL sport_key / tier / market_type means "all of them" in that cut.
--   · only the CLV record's rows (record_scope = 'record': an edge between
--     0.5% and 10% when flagged) are counted; the rest are reported as
--     outside_edge_band, never mixed in.
--   · graded = W + L + P. units_won = the sum of pnl_units, full precision.
--   · ROI % = units won ÷ units risked × 100. A push returns its stake, so it
--     is not counted as risked (the convention of every other P&L on the site).
--   · voids, missing prices and unsettled flags are counted, never priced.
--   · the closing-price comparison uses only the graded rows that have a
--     closing price, and gives the flag-price result on those same rows.
-- security_invoker: a reader sees exactly the rows pnl_grades' RLS lets them
-- (every row once its game has started).
-- pnl_handcheck(10): random stored rows beside the raw signal and a
-- recomputation that never reads the stored row (raw decimal -> American ->
-- the brief's formula). Service role only.
-- Idempotent, additive, no psql meta-commands, ends in a report.
-- ============================================================================

do $dep$ begin
  if to_regclass('public.pnl_grades') is null then
    raise exception 'apply supabase/signal_pnl.sql first';
  end if;
end $dep$;

create or replace function public.pnl_decimal(p_american numeric) returns numeric language sql immutable as $f$
  select case when p_american is null or abs(p_american) < 100 or abs(p_american) > 100000 then null
              when p_american > 0 then 1 + p_american / 100
              else 1 + 100 / abs(p_american) end
$f$;

-- THE BRIEF'S FORMULAS, word for word. 1 unit risked.
create or replace function public.pnl_units_american(p_american numeric, p_result text) returns numeric language sql immutable as $f$
  select case
    when p_american is null or abs(p_american) < 100 or abs(p_american) > 100000 then null
    when public.pnl_result(p_result) = 'win' then case when p_american > 0 then p_american / 100 else 100 / abs(p_american) end
    when public.pnl_result(p_result) = 'loss' then -1::numeric
    when public.pnl_result(p_result) = 'push' then 0::numeric
  end
$f$;

create or replace view public.pnl_summary with (security_invoker = true) as
with b as (
  select g.*, g.record_scope = 'record' as in_rec, (g.record_scope = 'record' and g.pnl_status = 'graded') as gr
  from public.pnl_grades g
), p as (
  select 'all'::text as grain, null::date as period_start, b.* from b
  union all select 'month', date_trunc('month', b.game_date)::date, b.* from b
  union all select 'week', date_trunc('week', b.game_date)::date, b.* from b
  union all select 'day', b.game_date, b.* from b
), a as (
  select grain, period_start,
    case when grouping(sport_key) = 0 then sport_key end as sport_key,
    case when grouping(sport_key) = 0 then max(sport_title) end as sport_title,
    case when grouping(tier) = 0 then tier end as tier,
    case when grouping(market_type) = 0 then market_type end as market_type,
    coalesce(nullif(concat_ws('+', case when grouping(sport_key) = 0 then 'sport' end, case when grouping(tier) = 0 then 'tier' end,
      case when grouping(market_type) = 0 then 'market' end), ''), 'total') as breakdown,
    count(*) filter (where in_rec) as flags,
    count(*) filter (where gr) as graded,
    count(*) filter (where gr and result = 'win') as wins,
    count(*) filter (where gr and result = 'loss') as losses,
    count(*) filter (where gr and result = 'push') as pushes,
    count(*) filter (where in_rec and pnl_status = 'void') as voids,
    count(*) filter (where in_rec and pnl_status = 'ungraded_missing_price') as ungraded_missing_price,
    count(*) filter (where in_rec and pnl_status = 'ungraded_unsettled') as ungraded_unsettled,
    count(*) filter (where not in_rec) as outside_edge_band,
    coalesce(sum(pnl_units) filter (where gr), 0) as units_won,
    coalesce(sum(stake_units) filter (where gr and result in ('win', 'loss')), 0) as units_risked,
    count(*) filter (where gr and pnl_units_at_close is not null) as close_compared,
    coalesce(sum(pnl_units_at_close) filter (where gr and pnl_units_at_close is not null), 0) as units_won_at_close,
    coalesce(sum(pnl_units) filter (where gr and pnl_units_at_close is not null), 0) as units_won_flag_compared,
    coalesce(sum(stake_units) filter (where gr and pnl_units_at_close is not null and result in ('win', 'loss')), 0) as units_risked_compared,
    min(game_date) filter (where gr) as first_game_date,
    max(game_date) filter (where gr) as last_game_date,
    max(computed_at) as last_computed_at
  from p
  group by grain, period_start, cube (sport_key, tier, market_type)
)
select a.*,
  case when units_risked > 0 then units_won / units_risked * 100 end as roi_pct,
  case when wins + losses > 0 then wins::numeric / (wins + losses) * 100 end as win_pct,
  case when units_risked_compared > 0 then units_won_at_close / units_risked_compared * 100 end as roi_at_close_pct,
  case when units_risked_compared > 0 then units_won_flag_compared / units_risked_compared * 100 end as roi_flag_compared_pct
from a;

comment on view public.pnl_summary is
  'Flagged-edge P&L rolled up. grain: all | month | week | day. breakdown: which of sport / tier / market the row is cut by (NULL = all). ROI = units won / units risked; a push is not risked. docs/pnl/EDGE_PNL.md';

revoke all on public.pnl_summary from anon, authenticated;
grant select on public.pnl_summary to anon, authenticated, service_role;

create or replace function public.pnl_fmt_units(v numeric) returns text language sql immutable as $f$
  select case when v is null then '—' else (case when v > 0 then '+' else '' end) || to_char(round(v, 2), 'FM999990.00') end
$f$;
create or replace function public.pnl_fmt_price(d numeric) returns text language sql immutable as $f$
  select case when not public.pnl_price_ok(d) then coalesce('invalid (' || d::text || ')', 'none')
    else (case when public.pnl_american(d) > 0 then '+' else '' end) || round(public.pnl_american(d))::text || ' (' || trim_scale(round(d, 3))::text || ')' end
$f$;

-- ── HAND-CHECK: random rows against the raw signal ─────────────────────────
create or replace function public.pnl_handcheck(p_n int default 10)
returns table (sig_key text, game text, pick text, raw_flagged_best_dec text, raw_result text, raw_closing_dec text,
  stored_status text, stored_price_at_flag text, stored_pnl numeric, recomputed_pnl numeric,
  stored_pnl_at_close numeric, recomputed_pnl_at_close numeric, matches boolean)
language sql volatile security definer set search_path = public as $h$
  select g.sig_key, coalesce(g.away_team || ' @ ' || g.home_team, g.event_id) || ' · ' || g.game_date,
    g.selection || coalesce(' ' || trim_scale(g.point)::text, ''),
    j ->> 'flagged_best_dec', j ->> 'result', j ->> 'closing_dec',
    g.pnl_status, public.pnl_fmt_price(g.price_at_flag_dec), g.pnl_units, rf, g.pnl_units_at_close, rc,
    round(g.pnl_units, 9) is not distinct from round(rf, 9) and round(g.pnl_units_at_close, 9) is not distinct from round(rc, 9)
  from public.pnl_grades g
  join lateral (select to_jsonb(s) j from public.signals s where s.sig_key = g.sig_key) s on true
  -- independent of the stored row: raw decimal -> American -> the brief's formula
  cross join lateral (select public.pnl_units_american(public.pnl_american(public.pnl_num(j ->> 'flagged_best_dec')), j ->> 'result') rf) a
  cross join lateral (select case when rf is not null then public.pnl_units_american(public.pnl_american(public.pnl_num(j ->> 'closing_dec')), j ->> 'result') end rc) b
  order by random() limit greatest(coalesce(p_n, 10), 1)
$h$;
revoke all on function public.pnl_handcheck(int) from public, anon, authenticated;
grant execute on function public.pnl_handcheck(int) to service_role;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should read ok.
select n, piece, state from (
  select 1 as n, 'math: +150 win = 1.50, -110 win = 0.909, loss = -1, push = 0, void = no bet' as piece,
    case when public.pnl_units_american(150, 'win') = 1.5 and round(public.pnl_units_american(-110, 'win'), 3) = 0.909
      and public.pnl_units_american(-110, 'loss') = -1 and public.pnl_units_american(-110, 'push') = 0
      and public.pnl_units_american(-110, 'void') is null then 'ok' else 'CHECK THIS' end as state
  union all select 2, 'the stored decimal gives the same number as the brief''s formula (2.50 = +150, -110)',
    case when public.pnl_units_decimal(2.5, 'win') = public.pnl_units_american(150, 'win')
      and round(public.pnl_units_decimal(public.pnl_decimal(-110), 'win'), 12) = round(public.pnl_units_american(-110, 'win'), 12)
      and public.pnl_units_decimal(1.0, 'win') is null and public.pnl_units_american(50, 'win') is null then 'ok' else 'CHECK THIS' end
  union all select 3, 'pnl_summary: anyone can read it',
    case when has_table_privilege('anon', 'public.pnl_summary', 'select') then 'ok' else 'CHECK THIS' end
  union all select 4, 'pnl_summary all-time units = the raw sum of pnl_units (record rows)',
    case when (select coalesce(units_won, 0) from public.pnl_summary where grain = 'all' and breakdown = 'total')
      is not distinct from (select coalesce(sum(pnl_units), 0) from public.pnl_grades where record_scope = 'record' and pnl_status = 'graded')
      or not exists (select 1 from public.pnl_grades) then 'ok' else 'CHECK THIS' end
) r order by 1;
