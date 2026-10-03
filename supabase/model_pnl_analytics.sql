-- ============================================================================
-- EDGEDESK — model_pnl analytics: the public view, the rollups, the drawdown,
-- the daily series and a reader's own dollars. docs/pnl/DESIGN.md
--
-- Apply supabase/model_pnl.sql first (the guard below stops otherwise).
-- Every figure is computed in Postgres over model_pnl, by the same rules as
-- lib/edgedesk_pnl.js (a parity test pins them): the strategy is the rows
-- EdgeDesk classified BET that carry verified P&L; ROI = net ÷ risked × 100;
-- a push or a void risks nothing; win rate = wins ÷ (wins + losses);
-- drawdown from the running peak of cumulative units, which starts at 0.
--
-- Security: the rollups read only public fields and are callable by anyone;
-- model_pnl_my_dollars() is SECURITY INVOKER and reads the caller's own
-- bankroll_settings row under its RLS — no other reader's bankroll is ever
-- reachable, and no dollar figure is stored anywhere.
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- ============================================================================

do $g$ begin
  if to_regclass('public.model_pnl') is null then
    raise exception 'apply supabase/model_pnl.sql first';
  end if;
end $g$;

-- the public door: public fields only, LIVE recommendations only
create or replace view public.model_pnl_public as
select recommendation_id, source, sport, league, season, week, event_id, event_label, home, away, game_date, model_version, engine_version,
       market_group, market_type, prop_market, prop_label, prop_category, player_id, player_name, team, opponent, position,
       side, selection, model_line, entry_line, entry_odds, entry_book, price_assumed, model_prob, implied_prob, model_edge_pct, ev_pct,
       rec_class, confidence, stake_units, flat_stake_units, recommended_at, odds_captured_at, evaluation_mode,
       result, result_value, final_score, closing_line, closing_odds, clv_points, clv_prob_pp, beat_close, settled_at,
       pnl_status, missing_entry_odds, flat_profit_units, profit_units, corrected, correction_count
from public.model_pnl
where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED');

create or replace view public.model_pnl_corrections_public as
select c.recommendation_id, c.corrected_at, c.changed, c.reason from public.model_pnl_corrections c;

-- the strategy's bets: scope all | nfl | cfb | props | game; mode flat | staked
-- nfl / cfb are that league's game markets; props is every player prop, never
-- also in its league's scope (lib/edgedesk_pnl.js SCOPES): all = nfl + cfb + props
create or replace function public.model_pnl_bets(p_mode text default 'flat', p_scope text default 'all', p_class text default 'BET')
returns table (recommendation_id text, league text, market_group text, market_type text, prop_label text, side text, entry_book text,
  model_version text, week int, rec_class text, stake numeric, profit numeric, entry_odds numeric, result text, clv_points numeric,
  beat_close boolean, model_edge_pct numeric, model_prob numeric, stake_units numeric, game_date timestamptz, recommended_at timestamptz)
language sql stable security definer set search_path = public as $b$
  select p.recommendation_id, p.league, p.market_group, p.market_type, p.prop_label, p.side, p.entry_book, p.model_version, p.week, p.rec_class,
         case when p_mode = 'staked' then p.stake_units else 1 end,
         case when p_mode = 'staked' then p.profit_units else p.flat_profit_units end,
         p.entry_odds, p.result, p.clv_points, p.beat_close, p.model_edge_pct, p.model_prob, p.stake_units, p.game_date, p.recommended_at
  from public.model_pnl p
  where p.pnl_status = 'VERIFIED' and p.rec_class = p_class
    and (p_mode <> 'staked' or (p.stake_units > 0 and p.profit_units is not null))
    and p.evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')
    and (p_scope = 'all' or (p_scope = 'nfl' and p.league = 'NFL' and p.market_group = 'game') or (p_scope = 'cfb' and p.league = 'CFB' and p.market_group = 'game')
         or (p_scope = 'props' and p.market_group = 'prop') or (p_scope = 'game' and p.market_group = 'game'))
$b$;

-- one rollup per group: league | market | prop_type | side | book | model_version | week | unit_size | edge | all
create or replace function public.model_pnl_rollup(p_mode text default 'flat', p_group text default 'all', p_scope text default 'all', p_class text default 'BET')
returns table (group_key text, bets bigint, wins bigint, losses bigint, pushes bigint, net_units numeric, risked_units numeric,
  roi_pct numeric, win_rate_pct numeric, avg_decimal numeric, break_even_pct numeric, avg_clv_points numeric, clv_hit_rate_pct numeric,
  avg_edge_pct numeric, gross_win_units numeric, gross_loss_units numeric, profit_factor numeric)
language sql stable security definer set search_path = public as $r$
  with k as (
    select b.*, case p_group
      when 'all' then 'all' when 'league' then b.league when 'market' then b.market_type when 'prop_type' then b.prop_label
      when 'side' then b.side when 'book' then b.entry_book when 'model_version' then coalesce(b.model_version, 'unversioned')
      when 'week' then b.league || ' · Week ' || lpad(b.week::text, 2, '0') when 'unit_size' then to_char(b.stake_units, 'FM0.00') || 'u'
      when 'edge' then case when b.model_edge_pct is null then null when b.model_edge_pct < 0 then '< 0%' when b.model_edge_pct < 1 then '0–1%'
        when b.model_edge_pct < 2 then '1–2%' when b.model_edge_pct < 3 then '2–3%' when b.model_edge_pct < 5 then '3–5%' when b.model_edge_pct < 7 then '5–7%' else '7%+' end
      end as g,
      case when b.entry_odds > 0 then 1 + b.entry_odds / 100 else 1 + 100 / abs(b.entry_odds) end as dec,
      b.result in ('win', 'loss') as wl
    from public.model_pnl_bets(p_mode, p_scope, p_class) b
  )
  select g, count(*), count(*) filter (where result = 'win'), count(*) filter (where result = 'loss'), count(*) filter (where result = 'push'),
    round(sum(profit), 2),
    round(coalesce(sum(stake) filter (where wl), 0), 2),
    round(100 * sum(profit) / nullif(sum(stake) filter (where wl), 0), 2),
    round(100.0 * count(*) filter (where result = 'win') / nullif(count(*) filter (where wl), 0), 2),
    round(sum(stake * dec) filter (where wl) / nullif(sum(stake) filter (where wl), 0), 4),
    round(100 / (sum(stake * dec) filter (where wl) / nullif(sum(stake) filter (where wl), 0)), 2),
    round(avg(clv_points), 2),
    round(100.0 * count(*) filter (where beat_close) / nullif(count(beat_close), 0), 1),
    round(avg(model_edge_pct), 2),
    round(coalesce(sum(profit) filter (where result = 'win'), 0), 2),
    round(coalesce(-sum(profit) filter (where result = 'loss'), 0), 2),
    round(sum(profit) filter (where result = 'win') / nullif(-sum(profit) filter (where result = 'loss'), 0), 2)
  from k where g is not null group by g order by g
$r$;

-- the cumulative path and its drawdown, in the kernel's order
create or replace function public.model_pnl_drawdown(p_mode text default 'flat', p_scope text default 'all', p_class text default 'BET')
returns table (bets bigint, net_units numeric, peak_units numeric, max_drawdown_units numeric, current_drawdown_units numeric)
language sql stable security definer set search_path = public as $d$
  with c as (
    select sum(profit) over w as cum, row_number() over w as rn
    from public.model_pnl_bets(p_mode, p_scope, p_class)
    window w as (order by coalesce(game_date, recommended_at, 'epoch'::timestamptz), recommended_at nulls first, recommendation_id rows unbounded preceding)
  ), p as (select cum, rn, greatest(0, max(cum) over (order by rn rows unbounded preceding)) as peak from c)
  select count(*), round(coalesce((select cum from p order by rn desc limit 1), 0), 2), round(coalesce(max(peak), 0), 2),
         round(coalesce(least(0, min(cum - peak)), 0), 2), round(coalesce((select cum - peak from p order by rn desc limit 1), 0), 2)
  from p
$d$;

-- the daily cumulative series, cached: refreshed after every sync
create materialized view if not exists public.model_pnl_daily as
with s(scope) as (values ('all'), ('nfl'), ('cfb'), ('props'), ('game')), m(mode) as (values ('flat'), ('staked')),
d as (
  select s.scope, m.mode, (b.game_date at time zone 'utc')::date as day, count(*) as bets, sum(b.profit) as units
  from s cross join m cross join lateral public.model_pnl_bets(m.mode, s.scope, 'BET') b
  group by 1, 2, 3
)
select scope, mode, day, bets, round(units, 4) as units, round(sum(units) over (partition by scope, mode order by day), 4) as cum_units from d;
create unique index if not exists model_pnl_daily_key on public.model_pnl_daily (scope, mode, day);

create or replace function public.model_pnl_refresh() returns void language plpgsql security definer set search_path = public as $x$
begin refresh materialized view public.model_pnl_daily; end $x$;

-- a signed-in reader's dollars, from THEIR bankroll settings (RLS), never stored
create or replace function public.model_pnl_my_dollars(p_mode text default 'flat', p_scope text default 'all')
returns table (unit_value numeric, basis text, net_units numeric, net_dollars numeric)
language plpgsql stable security invoker set search_path = public as $m$
declare b record; u numeric := null; why text := 'NOT_SET'; net numeric;
begin
  select dd.net_units into net from public.model_pnl_drawdown(p_mode, p_scope, 'BET') dd;
  if auth.uid() is null then return query select null::numeric, 'NOT_SIGNED_IN'::text, net, null::numeric; return; end if;
  if to_regclass('public.bankroll_settings') is not null then
    execute 'select to_jsonb(s) as j from public.bankroll_settings s where s.user_id = auth.uid() limit 1' into b;
    if b.j is not null then
      if coalesce(b.j ->> 'unit_mode', '') = 'fixed' and (b.j ->> 'base_unit_amount') is not null then u := (b.j ->> 'base_unit_amount')::numeric; why := 'CUSTOM';
      elsif (b.j ->> 'bankroll_amount') is not null then u := round((b.j ->> 'bankroll_amount')::numeric * coalesce((b.j ->> 'unit_percent')::numeric, 0.01), 2); why := 'PERCENT';
      elsif (b.j ->> 'base_unit_amount') is not null then u := (b.j ->> 'base_unit_amount')::numeric; why := 'CUSTOM';
      end if;
    end if;
  end if;
  return query select u, why, net, case when u is null then null else round(net * u, 2) end;
end $m$;

revoke all on public.model_pnl_daily from anon, authenticated;
grant select on public.model_pnl_public, public.model_pnl_corrections_public, public.model_pnl_daily to anon, authenticated;
revoke all on function public.model_pnl_bets(text, text, text), public.model_pnl_rollup(text, text, text, text), public.model_pnl_drawdown(text, text, text) from public;
grant execute on function public.model_pnl_bets(text, text, text), public.model_pnl_rollup(text, text, text, text), public.model_pnl_drawdown(text, text, text) to anon, authenticated, service_role;
revoke all on function public.model_pnl_refresh() from public, anon, authenticated;
grant execute on function public.model_pnl_refresh() to service_role;
revoke all on function public.model_pnl_my_dollars(text, text) from public, anon;
grant execute on function public.model_pnl_my_dollars(text, text) to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'the public view (public fields only)' as piece, case when has_table_privilege('anon', 'public.model_pnl_public', 'select') and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_pnl_public' and column_name in ('entry_odds_raw', 'last_correction_reason', 'source_ref')) then 'ok' else 'CHECK THIS' end as state
  union all select 'corrections are public', case when has_table_privilege('anon', 'public.model_pnl_corrections_public', 'select') then 'ok' else 'CHECK THIS' end
  union all select 'rollups and drawdown callable', case when has_function_privilege('anon', 'public.model_pnl_rollup(text, text, text, text)', 'execute') and has_function_privilege('anon', 'public.model_pnl_drawdown(text, text, text)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'daily series cached', case when to_regclass('public.model_pnl_daily') is not null and to_regclass('public.model_pnl_daily_key') is not null then 'ok' else 'CHECK THIS' end
  union all select 'only the service role refreshes', case when not has_function_privilege('anon', 'public.model_pnl_refresh()', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'dollars: signed-in readers only, invoker rights', case when not has_function_privilege('anon', 'public.model_pnl_my_dollars(text, text)', 'execute') and not (select prosecdef from pg_proc where oid = 'public.model_pnl_my_dollars(text, text)'::regprocedure) then 'ok' else 'CHECK THIS' end
) r order by 1;
