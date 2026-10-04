-- portfolio_journal -- part 7 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- At most 200 positions, filtered: one day's journal, one matrix cell, one
-- breakdown cell, the Mistake or Strength Library, the positions that broke
-- a rule. Each with its journal and its process components.
--   p_filter: {"basis": "placed"|"settled"|"either", "day": "2026-10-04",
--              "dim": "...", "key": "...", "process": "GOOD"|"AVERAGE"|"POOR"|"UNGRADED",
--              "result": "WIN"|"LOSS"|"OPEN"|"OTHER", "library": "MISTAKE"|"STRENGTH",
--              "rules_broken": true, "order": "recent"|"process_desc"|"process_asc"|"pnl_desc"|"pnl_asc"}
create or replace function public.portfolio_list(p_from timestamptz, p_to timestamptz, p_tz text default null,
    p_filter jsonb default '{}'::jsonb, p_limit int default 100, p_platform text default null)
returns setof jsonb language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz, coalesce(p_filter, '{}'::jsonb) as q),
  f as (select f.* from z, public.portfolio_facts_cached(p_from, p_to, z.tz, p_platform) f),
  sel as (
    select f.* from f, z
     where case coalesce(z.q->>'basis', 'either') when 'placed' then f.in_placed when 'settled' then f.in_settled
                when 'event' then f.in_event else true end
       and (z.q->>'day' is null or case coalesce(z.q->>'basis', 'either')
             when 'placed' then f.placed_day = (z.q->>'day')::date when 'settled' then f.settled_day = (z.q->>'day')::date
             when 'event' then f.event_day = (z.q->>'day')::date
             else f.placed_day = (z.q->>'day')::date or f.settled_day = (z.q->>'day')::date or f.event_day = (z.q->>'day')::date end)
       and (z.q->>'evidence' is null or f.evidence = z.q->>'evidence')
       and (z.q->>'process' is null or z.q->>'process' = case when f.process_score is null then 'UNGRADED' when f.process_score >= 66 then 'GOOD'
                                                              when f.process_score >= 45 then 'AVERAGE' else 'POOR' end)
       and (z.q->>'result' is null or z.q->>'result' = case when f.status = 'OPEN' then 'OPEN' when f.result in ('WIN', 'LOSS') then f.result else 'OTHER' end)
       and (z.q->>'library' is null or f.library = z.q->>'library')
       and (coalesce((z.q->>'rules_broken')::boolean, false) = false or f.rules_followed < f.rules_applicable)
       and (z.q->>'dim' is null or z.q->>'key' = case z.q->>'dim'
             when 'platform' then f.platform when 'platform_type' then f.platform_type when 'sport' then coalesce(f.sport, 'UNKNOWN')
             when 'league' then coalesce(f.league, 'UNKNOWN') when 'position_type' then f.position_type when 'source' then f.source
             when 'timing' then f.timing_bucket when 'placed_dow' then f.placed_dow::text when 'event_dow' then coalesce(f.event_dow::text, 'UNKNOWN')
             when 'hour' then f.hour_band when 'odds' then f.odds_band when 'units' then f.units_band
             when 'decision_source' then coalesce(f.decision_source, 'UNRECORDED')
             when 'planned' then case f.planned when true then 'PLANNED' when false then 'UNPLANNED' else 'UNTAGGED' end
             when 'after' then f.after_result
             when 'session' then case when f.session_order = 1 then 'FIRST' when f.session_order <= 3 then 'SECOND_THIRD' else 'FOURTH_PLUS' end
             when 'repeat' then coalesce(f.would_repeat, 'UNREVIEWED') when 'evidence' then f.evidence when 'stake_type' then f.stake_type
             when 'sport_type' then coalesce(f.sport, 'UNKNOWN') || ' · ' || f.position_type
             when 'timing_type' then f.timing_bucket || ' · ' || f.position_type
             when 'platform_type_pos' then f.platform || ' · ' || f.position_type
             when 'tag' then case when z.q->>'key' = 'UNTAGGED' then case when f.decision_tags is null then 'UNTAGGED' end
                                  when z.q->>'key' = any (f.decision_tags) then z.q->>'key' end
             when 'all' then 'all' end))
  select to_jsonb(s) - 'decile' || jsonb_build_object('market_name', p.market_name, 'side', p.side, 'line', p.line,
           'odds_american', p.odds_american, 'odds_decimal', p.odds_decimal, 'contracts', p.contracts, 'average_entry_price', p.average_entry_price,
           'notes', p.notes, 'journal', to_jsonb(j) - 'user_id' - 'position_id')
    from sel s, z join public.portfolio_positions p on true
    left join public.portfolio_journal_entries j on j.position_id = p.id
   where p.id = s.id
   order by case when z.q->>'order' = 'process_desc' then s.process_score end desc nulls last,
            case when z.q->>'order' = 'process_asc' then s.process_score end asc nulls last,
            case when z.q->>'order' = 'pnl_desc' then s.pnl end desc nulls last,
            case when z.q->>'order' = 'pnl_asc' then s.pnl end asc nulls last,
            coalesce(s.settled_at, s.placed_at) desc, s.id
   limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

-- BEFORE YOU ENTER: context for a position the reader is about to record,
-- from their own last 12 months — never a recommendation. It names the
-- reader's record in each matching context (with its sample size), today's
-- exposure against their daily cap, any of their own rules this position
-- would break, and the model's expected value at this price if a model
-- probability is given.
create or replace function public.portfolio_pre_bet(p jsonb, p_tz text default null)
returns jsonb language plpgsql volatile set jit = off set work_mem = '64MB' as $$
declare
  tz text := public.portfolio_tz(p_tz);
  ptype text := upper(coalesce(p->>'platform_type', 'SPORTSBOOK'));
  am int; dec numeric; price numeric; stake numeric; start_at timestamptz; lead bigint; u record; units numeric;
  day_units numeric; day_count int; ev numeric; prob numeric; hist jsonb; rules jsonb; today date;
  keys jsonb;
begin
  am := case when (p->>'odds_american') ~ '^[+-]?[0-9]+$' then (p->>'odds_american')::int end;
  dec := case when am is not null and (am >= 100 or am <= -100) then public.portfolio_american_to_decimal(am)
              when (p->>'odds_decimal') ~ '^[0-9]+(\.[0-9]+)?$' and (p->>'odds_decimal')::numeric > 1 then (p->>'odds_decimal')::numeric end;
  price := case when (p->>'price') ~ '^[0-9]*\.?[0-9]+$' and (p->>'price')::numeric > 0 and (p->>'price')::numeric <= 1 then (p->>'price')::numeric end;
  if ptype = 'PREDICTION_MARKET' and price is not null then dec := round(1 / price, 6); end if;
  stake := case when (p->>'stake') ~ '^[0-9]+(\.[0-9]+)?$' then (p->>'stake')::numeric end;
  start_at := case when coalesce(p->>'event_start_at', '') <> '' then public.portfolio_try_timestamptz(p->>'event_start_at') end;
  lead := public.portfolio_lead_seconds(now(), start_at);
  select * into u from public.portfolio_unit_snapshot(auth.uid());
  units := case when u.unit > 0 and stake is not null then round(stake / u.unit, 4) end;
  prob := case when (p->>'model_probability') ~ '^0?\.[0-9]+$' then (p->>'model_probability')::numeric end;
  ev := public.portfolio_model_ev(ptype, prob, case when ptype = 'PREDICTION_MARKET' then price else dec end);
  today := (now() at time zone tz)::date;
  perform public.portfolio_facts_fresh(tz);

  keys := jsonb_build_array(
    jsonb_build_array('platform', lower(coalesce(p->>'platform', ''))),
    jsonb_build_array('sport', upper(coalesce(nullif(p->>'sport', ''), 'UNKNOWN'))),
    jsonb_build_array('position_type', upper(coalesce(nullif(p->>'position_type', ''), 'OTHER'))),
    jsonb_build_array('timing', public.portfolio_timing_bucket(lead)),
    jsonb_build_array('odds', public.portfolio_odds_band(dec)),
    jsonb_build_array('units', public.portfolio_units_band(units)),
    jsonb_build_array('sport_type', upper(coalesce(nullif(p->>'sport', ''), 'UNKNOWN')) || ' · ' || upper(coalesce(nullif(p->>'position_type', ''), 'OTHER'))));
  select coalesce(jsonb_agg(jsonb_build_object('dim', c.dim, 'key', c.key, 'n', c.n, 'settled', c.settled, 'wins', c.wins, 'losses', c.losses,
           'pnl', c.pnl, 'staked', c.staked, 'ret_n', c.ret_n, 'ret_sum', c.ret_sum, 'ret_sq', c.ret_sq, 'clv_n', c.clv_n, 'clv_sum', c.clv_sum,
           'clv_sq', c.clv_sq, 'ps_n', c.ps_n, 'ps_sum', c.ps_sum, 'ps_sq', c.ps_sq)), '[]'::jsonb)
    into hist
    from public.portfolio_cells(now() - interval '365 days', now(), tz, null, false) c
   where (c.dim, c.key) in (select k->>0, k->>1 from jsonb_array_elements(keys) k) or c.dim = 'all';

  select coalesce(sum(f.units), 0), count(*) into day_units, day_count
    from public.portfolio_facts_cached((today::timestamp at time zone tz), ((today + 1)::timestamp at time zone tz), tz, null) f where f.in_placed;

  select coalesce(jsonb_agg(jsonb_build_object('label', r.label, 'kind', r.kind, 'verdict', public.portfolio_rule_verdict(r.kind, r.params, units,
           day_units + coalesce(units, 0), day_count + 1, ev, dec, lead, upper(coalesce(p->>'position_type', 'OTHER')), upper(nullif(p->>'sport', '')),
           case when p ? 'planned' and jsonb_typeof(p->'planned') = 'boolean' then (p->>'planned')::boolean end,
           length(btrim(coalesce(p->>'thesis', ''))) >= 10)) order by r.label), '[]'::jsonb)
    into rules
    from public.portfolio_rules r where r.active_until is null;

  return jsonb_build_object('tz', tz, 'entry_decimal', dec, 'timing_bucket', public.portfolio_timing_bucket(lead), 'lead_seconds', lead,
    'odds_band', public.portfolio_odds_band(dec), 'unit', u.unit, 'units', units, 'units_band', public.portfolio_units_band(units),
    'max_single_units', u.max_single, 'max_daily_units', u.max_daily, 'today_units', day_units, 'today_count', day_count,
    'model_ev', ev, 'history', hist, 'rules', rules, 'window_days', 365);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_journal_entries enable row level security;
alter table public.portfolio_rules enable row level security;
alter table public.portfolio_experiments enable row level security;
alter table public.portfolio_facts_cache enable row level security;
alter table public.portfolio_facts_cache_state enable row level security;

drop policy if exists portfolio_journal_select_own on public.portfolio_journal_entries;
create policy portfolio_journal_select_own on public.portfolio_journal_entries for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_journal_insert_own on public.portfolio_journal_entries;
create policy portfolio_journal_insert_own on public.portfolio_journal_entries for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_journal_update_own on public.portfolio_journal_entries;
create policy portfolio_journal_update_own on public.portfolio_journal_entries for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- no delete policy: a journal entry goes only with its position

drop policy if exists portfolio_rules_select_own on public.portfolio_rules;
create policy portfolio_rules_select_own on public.portfolio_rules for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_rules_insert_own on public.portfolio_rules;
create policy portfolio_rules_insert_own on public.portfolio_rules for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_rules_update_own on public.portfolio_rules;
create policy portfolio_rules_update_own on public.portfolio_rules for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_rules_delete_own on public.portfolio_rules;
create policy portfolio_rules_delete_own on public.portfolio_rules for delete to authenticated using (user_id = auth.uid());

drop policy if exists portfolio_experiments_select_own on public.portfolio_experiments;
create policy portfolio_experiments_select_own on public.portfolio_experiments for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_experiments_insert_own on public.portfolio_experiments;
create policy portfolio_experiments_insert_own on public.portfolio_experiments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_experiments_update_own on public.portfolio_experiments;
create policy portfolio_experiments_update_own on public.portfolio_experiments for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_experiments_delete_own on public.portfolio_experiments;
create policy portfolio_experiments_delete_own on public.portfolio_experiments for delete to authenticated using (user_id = auth.uid());

drop policy if exists portfolio_facts_cache_own on public.portfolio_facts_cache;
