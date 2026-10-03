-- ============================================================================
-- EDGEDESK — VERIFIED P&L, read side: the decisions, the summary, the
-- breakdowns, the cumulative series and the integrity checks. Apply after
-- supabase/model_pnl_verified.sql. docs/pnl/DESIGN.md § Verified P&L
--   · the strategy is the graded record's picks — the model's published
--     number and every BET (LEAN when asked) — that settled at a verified
--     price: graded = priced + record only, always.
--   · flat: 1u each. staked: the decision's stake (explicit, or the default
--     a priced model number carries). ROI = net ÷ risked × 100; a push or a
--     void risks nothing. The same rules as lib/edgedesk_pnl.js (parity test).
--   · filters: league (NFL | CFB), market (spread | total | moneyline |
--     player_prop), a date range on the game date (UTC), leans.
--   · anon reads public fields and counts only; nothing here writes.
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- ============================================================================
do $g$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_pnl' and column_name = 'pnl_verified') then
    raise exception 'apply supabase/model_pnl_verified.sql first'; end if;
end $g$;

-- every graded-record decision in the vocabulary of the Verified P&L spec
create or replace view public.verified_pnl_decisions as
select recommendation_id as decision_id, event_id, event_label, sport, league, season, week, market_group, market_type, selection,
       case when source = 'model_record' then closing_line else entry_line end as line, side,
       case when entry_odds is not null then entry_book end as book, entry_odds as american_odds, odds_captured_at as price_timestamp, recommended_at as decision_timestamp,
       game_date as event_time, rec_class, stake_units, stake_source, price_source, price_locked_at,
       result, profit_units, flat_profit_units, settled_at, pnl_verified, pnl_exclusion_reason,
       price_lookup ->> 'why' as exclusion_code, price_lookup ->> 'detail' as exclusion_detail,
       player_id, player_name, prop_market as prop_type, case when market_group = 'prop' then entry_line end as prop_line,
       case when market_group = 'prop' then side end as over_under, record_state, model_version, source
from public.model_pnl
where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED');

-- the picks of one view, with the strategy's stake and profit
create or replace function public.verified_pnl_rows(p_mode text default 'staked', p_league text default null, p_market text default null,
  p_from date default null, p_to date default null, p_leans boolean default false)
returns table (decision_id text, sport text, league text, market_type text, week int, game_date timestamptz, recommended_at timestamptz,
  record_state text, result text, counted boolean, stake numeric, profit numeric, entry_odds numeric, pending_priced boolean)
language sql stable security definer set search_path = public as $r$
  select p.recommendation_id, p.sport, p.league, p.market_type, p.week, p.game_date, p.recommended_at, p.record_state, p.result,
         p.pnl_verified and (case when p_mode = 'flat' then p.flat_profit_units is not null else p.stake_units > 0 and p.profit_units is not null end),
         case when p_mode = 'flat' then 1 else p.stake_units end,
         case when p_mode = 'flat' then p.flat_profit_units else p.profit_units end,
         p.entry_odds, p.record_state = 'PENDING' and p.entry_odds is not null
  from public.model_pnl p
  where p.evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')
    and (p.rec_class in ('MODEL', 'BET') or (p_leans and p.rec_class = 'LEAN'))
    and (p_league is null or p.league = upper(p_league))
    and (p_market is null or p.market_type = p_market)
    and (p_from is null or (p.game_date at time zone 'utc')::date >= p_from)
    and (p_to is null or (p.game_date at time zone 'utc')::date <= p_to)
$r$;

-- one row per group: all | sport | league | market_type | date | week | month
create or replace function public.verified_pnl_breakdown(p_group text default 'all', p_mode text default 'staked', p_league text default null,
  p_market text default null, p_from date default null, p_to date default null, p_leans boolean default false)
returns table (group_key text, graded_decisions bigint, total_verified_bets bigint, record_only_decisions bigint, pending_priced bigint,
  wins bigint, losses bigint, pushes bigint, net_units numeric, units_risked numeric, roi_percent numeric, win_rate_pct numeric)
language sql stable security definer set search_path = public as $b$
  with k as (
    select r.*, case p_group when 'all' then 'all' when 'sport' then r.sport when 'league' then r.league when 'market_type' then r.market_type
      when 'date' then to_char(r.game_date at time zone 'utc', 'YYYY-MM-DD') when 'month' then to_char(r.game_date at time zone 'utc', 'YYYY-MM')
      when 'week' then r.league || ' · Week ' || lpad(r.week::text, 2, '0') end as g
    from public.verified_pnl_rows(p_mode, p_league, p_market, p_from, p_to, p_leans) r
  )
  select g,
    count(*) filter (where record_state in ('VERIFIED', 'RECORD_ONLY')),
    count(*) filter (where counted),
    count(*) filter (where record_state = 'RECORD_ONLY'),
    count(*) filter (where pending_priced),
    count(*) filter (where counted and result = 'win'), count(*) filter (where counted and result = 'loss'), count(*) filter (where counted and result = 'push'),
    round(sum(profit) filter (where counted), 2),
    round(sum(stake) filter (where counted and result in ('win', 'loss')), 2),
    round(100 * sum(profit) filter (where counted) / nullif(sum(stake) filter (where counted and result in ('win', 'loss')), 0), 2),
    round(100.0 * count(*) filter (where counted and result = 'win') / nullif(count(*) filter (where counted and result in ('win', 'loss')), 0), 2)
  from k where g is not null group by g order by g
$b$;

-- the headline: is the model up or down, and over how many priced decisions
create or replace function public.verified_pnl_summary(p_mode text default 'staked', p_league text default null, p_market text default null,
  p_from date default null, p_to date default null, p_leans boolean default false)
returns table (graded_decisions bigint, total_verified_bets bigint, record_only_decisions bigint, pending_priced bigint,
  wins bigint, losses bigint, pushes bigint, net_units numeric, units_risked numeric, roi_percent numeric, win_rate_pct numeric)
language sql stable security definer set search_path = public as $s$
  select coalesce(b.graded_decisions, 0), coalesce(b.total_verified_bets, 0), coalesce(b.record_only_decisions, 0), coalesce(b.pending_priced, 0),
         coalesce(b.wins, 0), coalesce(b.losses, 0), coalesce(b.pushes, 0), b.net_units, b.units_risked, b.roi_percent, b.win_rate_pct
  from (select 1) one left join public.verified_pnl_breakdown('all', p_mode, p_league, p_market, p_from, p_to, p_leans) b on true
$s$;

-- the cumulative path, one point per settled priced decision, in the kernel's order
create or replace function public.verified_pnl_series(p_mode text default 'staked', p_league text default null, p_market text default null,
  p_from date default null, p_to date default null, p_leans boolean default false)
returns table (n bigint, decision_id text, event_date date, result text, stake numeric, profit numeric, cumulative_units numeric)
language sql stable security definer set search_path = public as $c$
  select row_number() over w, r.decision_id, (r.game_date at time zone 'utc')::date, r.result, r.stake, r.profit, sum(r.profit) over w
  from public.verified_pnl_rows(p_mode, p_league, p_market, p_from, p_to, p_leans) r
  where r.counted
  window w as (order by coalesce(r.game_date, r.recommended_at, 'epoch'::timestamptz), r.recommended_at nulls first, r.decision_id rows unbounded preceding)
  order by 1
$c$;

-- THE INTEGRITY CHECKS: every one must read 0 failures (severity 'error')
create or replace function public.verified_pnl_integrity()
returns table (check_key text, label text, severity text, failures bigint)
language plpgsql stable security definer set search_path = public as $i$
declare m int := 0; x int := 0;
begin
  return query
  with p as (select * from public.model_pnl where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')),
  g as (select count(*) filter (where record_state in ('VERIFIED', 'RECORD_ONLY')) as graded, count(*) filter (where record_state = 'VERIFIED') as ver,
          count(*) filter (where record_state = 'RECORD_ONLY') as ro from p where rec_class in ('MODEL', 'BET'))
  select * from (values
    ('win_null_odds', 'a WIN with no odds counted as verified', 'error', (select count(*) from p where pnl_verified and result = 'win' and entry_odds is null)),
    ('loss_null_stake', 'a verified LOSS with no stake', 'error', (select count(*) from p where pnl_verified and result = 'loss' and rec_class in ('MODEL', 'BET') and coalesce(stake_units, 0) <= 0)),
    ('duplicate_decision', 'a decision with more than one P&L entry', 'error', (select count(*) - count(distinct recommendation_id) from public.model_pnl)
      + (select coalesce(sum(c - 1), 0)::bigint from (select count(*) c from p where source = 'model_record' group by event_id, market_type having count(*) > 1) d)),
    ('odds_zero', 'a verified decision at odds of 0', 'error', (select count(*) from p where pnl_verified and coalesce(entry_odds, 0) = 0)),
    ('odds_invalid', 'verified American odds between -100 and +100', 'error', (select count(*) from p where pnl_verified and abs(entry_odds) < 100)),
    ('price_after_decision', 'a verified price captured after its decision', 'error', (select count(*) from p where pnl_verified and odds_captured_at > recommended_at)),
    ('verified_null_result', 'a verified entry with no W / L / P', 'error', (select count(*) from p where pnl_verified and result not in ('win', 'loss', 'push'))),
    ('event_mismatch', 'a stored-quote price recorded for another game', 'error', (select count(*) from p where price_source = 'snapshot' and price_ref ->> 'event_id' is distinct from event_id)),
    ('line_mismatch', 'a stored-quote price for another number than the one graded', 'error', (select count(*) from p where price_source = 'snapshot' and market_type <> 'moneyline'
      and (price_ref ->> 'line')::numeric is distinct from closing_line)),
    ('prop_missing_player', 'a verified prop with no player or market', 'error', (select count(*) from p where pnl_verified and market_group = 'prop' and ((player_id is null and player_name is null) or prop_market is null))),
    ('profit_mismatch', 'units that do not match stake × odds × result', 'error', (select count(*) from p where pnl_verified and (flat_profit_units is distinct from public.edp_pnl_profit(entry_odds, 1, result)
      or (stake_units > 0 and profit_units is distinct from public.edp_pnl_profit(entry_odds, stake_units, result))))),
    ('no_reason', 'a decision outside Verified P&L with no reason', 'error', (select count(*) from p where not pnl_verified and pnl_exclusion_reason is null)),
    ('reconcile', 'graded decisions ≠ verified priced + record only', 'error', (select abs(graded - ver - ro) from g))
  ) v(a, b, c, d);
  -- every stored-quote price against the quote it names, where the quote mirror is deployed
  if to_regclass('public.cfb_lab_market_quotes') is not null then
    execute $q$ select count(*) filter (where q.quote_id is not null and (q.game_id is distinct from m.event_id or q.observed_at is distinct from m.odds_captured_at
        or q.observed_at > m.recommended_at or (case when m.market_type = 'total' then case when m.side = 'over' then q.price_over else q.price_under end
          else case when m.side = 'home' then q.price_home else q.price_away end end) is distinct from m.entry_odds)),
        count(*) filter (where q.quote_id is null)
      from public.model_pnl m left join public.cfb_lab_market_quotes q on q.quote_id = m.price_ref ->> 'quote_id'
      where m.price_source = 'snapshot' $q$ into m, x;
    return query select 'snapshot_quote_mismatch'::text, 'a locked price that differs from its stored quote'::text, 'error'::text, m::bigint;
    return query select 'snapshot_quote_not_mirrored'::text, 'a locked price whose quote has not reached the database mirror yet'::text, 'info'::text, x::bigint;
  end if;
end $i$;

create index if not exists model_pnl_decision_time_idx on public.model_pnl (game_date, recommended_at, recommendation_id);

grant select on public.verified_pnl_decisions to anon, authenticated;
revoke all on function public.verified_pnl_rows(text, text, text, date, date, boolean), public.verified_pnl_breakdown(text, text, text, text, date, date, boolean),
  public.verified_pnl_summary(text, text, text, date, date, boolean), public.verified_pnl_series(text, text, text, date, date, boolean), public.verified_pnl_integrity() from public;
grant execute on function public.verified_pnl_rows(text, text, text, date, date, boolean), public.verified_pnl_breakdown(text, text, text, text, date, date, boolean),
  public.verified_pnl_summary(text, text, text, date, date, boolean), public.verified_pnl_series(text, text, text, date, date, boolean), public.verified_pnl_integrity()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'the decisions view is public, internal fields absent' as piece, case when has_table_privilege('anon', 'public.verified_pnl_decisions', 'select')
    and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'verified_pnl_decisions' and column_name in ('entry_odds_raw', 'last_correction_reason', 'source_ref')) then 'ok' else 'CHECK THIS' end as state
  union all select 'summary, breakdowns and series callable', case when has_function_privilege('anon', 'public.verified_pnl_summary(text, text, text, date, date, boolean)', 'execute')
    and has_function_privilege('anon', 'public.verified_pnl_series(text, text, text, date, date, boolean)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'graded = verified priced + record only', case when (select failures from public.verified_pnl_integrity() where check_key = 'reconcile') = 0 then 'ok' else 'CHECK THIS' end
  union all select 'every integrity check reads 0', case when not exists (select 1 from public.verified_pnl_integrity() where severity = 'error' and failures > 0) then 'ok' else 'CHECK THIS' end
  union all select 'the series ends at the summary''s net', case when (select coalesce(round(max(cumulative_units) filter (where n = (select count(*) from public.verified_pnl_series())), 2), 0) from public.verified_pnl_series())
    = coalesce((select net_units from public.verified_pnl_summary()), 0) then 'ok' else 'CHECK THIS' end
) r order by 1;
