-- portfolio_journal -- part 4 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- p_platform narrows the whole book to one platform ('draftkings') or one
-- kind ('type:SPORTSBOOK', 'type:PREDICTION_MARKET'); null is every platform.
create or replace function public.portfolio_facts(p_from timestamptz, p_to timestamptz, p_tz text, p_platform text default null)
returns table (
  id uuid, platform text, platform_label text, platform_type text, position_type text, sport text, league text, source text,
  event_name text, selection text, status text, result text, placed_at timestamptz, settled_at timestamptz, event_start_at timestamptz,
  in_placed boolean, in_settled boolean, in_event boolean, placed_day date, settled_day date, event_day date,
  placed_dow int, event_dow int, hour_band text,
  lead_seconds bigint, timing_bucket text, stake_amt numeric, pnl numeric, ret numeric, entry_dec numeric, entry_price numeric,
  odds_band text, units numeric, units_band text, day_units numeric, day_count int, session_no int, session_order int,
  after_result text, decile int, decision_source text, decision_tags text[], planned boolean, has_thesis boolean,
  would_repeat text, library text, closing_source text, model_pre_event boolean, research_pre_event boolean,
  clv_pct numeric, clv_points numeric, model_ev numeric, price_slip numeric, price_points numeric,
  s_clv numeric, s_model numeric, s_price numeric, s_sizing numeric, s_timing numeric, s_rules numeric, s_market numeric,
  process_weight int, process_score numeric, grade text, rules_applicable int, rules_followed int, rules_broken text[],
  evidence text, stake_type text)
language sql stable as $$
  with base as (
    select p.id, p.user_id, p.platform, p.platform_label, p.platform_type, p.position_type, upper(p.sport) as sport, upper(p.league) as league,
           p.source, p.event_name, p.selection, p.side, p.line, p.status, p.result, p.placed_at, p.settled_at, p.event_start_at,
           ((p_from is null or p.placed_at >= p_from) and (p_to is null or p.placed_at < p_to)) as in_placed,
           (p.settled_at is not null and p.status <> 'OPEN' and (p_from is null or p.settled_at >= p_from) and (p_to is null or p.settled_at < p_to)) as in_settled,
           (p.event_start_at is not null and (p_from is null or p.event_start_at >= p_from) and (p_to is null or p.event_start_at < p_to)) as in_event,
           (p.placed_at at time zone p_tz) as placed_local, p.stake_type,
           p.cost_basis as stake_amt,
           case when p.status <> 'OPEN' then p.profit_loss end as pnl,
           case when p.platform_type = 'SPORTSBOOK' then p.odds_decimal end as entry_dec_wager,
           case when p.platform_type = 'PREDICTION_MARKET' then p.average_entry_price end as entry_price,
           public.portfolio_lead_seconds(p.placed_at, p.event_start_at) as lead_seconds,
           public.portfolio_ou_direction(p.selection, p.side) as ou,
           least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz)) as cutoff,
           j.decision_source, j.decision_tags, j.planned, (j.thesis is not null and length(j.thesis) >= 10) as has_thesis,
           j.would_repeat, j.library, j.closing_source, j.model_probability, j.model_recorded_at, j.research_recorded_at,
           j.opening_odds_decimal, j.opening_line, j.opening_price, j.research_odds_decimal, j.research_line, j.research_price,
           j.closing_odds_decimal, j.closing_line, j.closing_price, j.unit_size_at_entry, j.max_single_units_at_entry, j.max_daily_units_at_entry,
           j.decision_recorded_at
      from public.portfolio_positions p
      left join public.portfolio_journal_entries j on j.position_id = p.id
     where (p_platform is null or p.platform = p_platform or ('type:' || p.platform_type) = p_platform)
       and (((p_from is null or p.placed_at >= p_from) and (p_to is null or p.placed_at < p_to))
        or (p.settled_at is not null and p.status <> 'OPEN' and (p_from is null or p.settled_at >= p_from) and (p_to is null or p.settled_at < p_to))
        or (p.event_start_at is not null and (p_from is null or p.event_start_at >= p_from) and (p_to is null or p.event_start_at < p_to)))
  ),
  -- (each step below is MATERIALIZED and hands the next plain columns, so
  -- every component function is inlined into the query instead of being
  -- called once per row: the difference between milliseconds and seconds
  -- on a long history)
  priced0 as materialized (
    select b.*,
           coalesce(b.entry_dec_wager, case when b.entry_price > 0 then round(1 / b.entry_price, 6) end) as entry_dec,
           (b.model_recorded_at is not null and b.model_recorded_at < b.cutoff) as model_pre_event,
           (b.research_recorded_at is not null and b.research_recorded_at < b.cutoff) as research_pre_event,
           case when b.unit_size_at_entry > 0 and b.stake_amt is not null then round(b.stake_amt / b.unit_size_at_entry, 4) end as units,
           (b.line is not null and b.closing_line is not null and b.closing_line <> b.line) as close_moved,
           (b.line is not null and b.research_line is not null and b.research_line <> b.line) as research_moved
      from base b
  ),
  priced as materialized (
    select q.*,
           case when q.platform_type = 'PREDICTION_MARKET' then q.entry_price else q.entry_dec end as entry_any,
           case when q.platform_type = 'PREDICTION_MARKET' then q.closing_price else q.closing_odds_decimal end as close_any,
           case when q.platform_type = 'PREDICTION_MARKET' then q.research_price else q.research_odds_decimal end as research_any,
           case when q.platform_type = 'PREDICTION_MARKET' then q.opening_price
                when q.line is null or q.opening_line is null or q.opening_line = q.line then q.opening_odds_decimal end as open_path,
           case when not q.research_pre_event then null when q.platform_type = 'PREDICTION_MARKET' then q.research_price
                when not q.research_moved then q.research_odds_decimal end as research_path,
           case when q.platform_type = 'PREDICTION_MARKET' then q.closing_price when not q.close_moved then q.closing_odds_decimal end as close_path,
           case when q.model_pre_event then q.model_probability end as model_prob_pre
      from priced0 q
  ),
  windowed as (
    select q.id, q.placed_at,
           sum(q.units) over w_day as day_units,
           (count(*) over w_day)::int as day_count,
           /* a session: positions placed within 90 minutes of the one
              before, on the same local day */
           case when lag(q.placed_at) over w_all is null or q.placed_at - lag(q.placed_at) over w_all > interval '90 minutes'
                  or q.placed_local::date <> (lag(q.placed_local) over w_all)::date then 1 else 0 end as starts_session,
           ntile(10) over w_all as decile
      from priced q where q.in_placed
    window w_day as (partition by q.placed_local::date order by q.placed_at, q.id rows between unbounded preceding and current row),
           w_all as (order by q.placed_at, q.id)
  ),
  sessions as (
    select w.id, w.placed_at, w.day_units, w.day_count, w.decile,
           (sum(w.starts_session) over (order by w.placed_at, w.id))::int as session_no
      from windowed w
  ),
  sessions2 as (
    select x.*, (row_number() over (partition by x.session_no order by x.placed_at, x.id))::int as session_order from sessions x
  ),
  scored as materialized (
    select q.*, s.day_units, s.day_count, s.session_no, s.decile, s.session_order,
           prev.result as prev_result,
           case when q.close_moved then public.portfolio_line_gain(q.ou, q.line, q.closing_line) end as clv_points,
           case when q.close_moved then null else public.portfolio_clv_pct(q.platform_type, q.entry_any, q.close_any) end as clv_pct,
           public.portfolio_model_ev(q.platform_type, q.model_prob_pre, q.entry_any) as model_ev,
           case when q.research_pre_event and q.research_moved then public.portfolio_line_gain(q.ou, q.line, q.research_line) end as price_points,
           case when not q.research_pre_event or q.research_moved then null
                else public.portfolio_price_slip(q.platform_type, q.entry_any, q.research_any) end as price_slip,
           public.portfolio_score_timing(q.platform_type, q.entry_any, q.open_path, q.research_path, q.close_path) as s_timing
      from priced q
      left join sessions2 s on s.id = q.id
      left join lateral (select pr.result from public.portfolio_positions pr
                          where q.in_placed and pr.user_id = q.user_id and pr.status <> 'OPEN' and pr.id <> q.id
                            and pr.settled_at < q.placed_at and pr.settled_at >= q.placed_at - interval '24 hours'
                          order by pr.settled_at desc limit 1) prev on true
  ),
  ruled as materialized (
    select c.*, ru.applicable, ru.followed, ru.broken
      from scored c
      left join lateral (
        select count(*) filter (where v.verdict in ('FOLLOWED', 'BROKEN'))::int as applicable,
               count(*) filter (where v.verdict = 'FOLLOWED')::int as followed,
               array_agg(v.label order by v.label) filter (where v.verdict = 'BROKEN') as broken
          from (select r.label, public.portfolio_rule_verdict(r.kind, r.params, c.units, c.day_units, c.day_count, c.model_ev, c.entry_dec,
                         c.lead_seconds, c.position_type, c.sport, c.planned, c.has_thesis) as verdict
                  from public.portfolio_rules r
                 where c.in_placed and r.user_id = c.user_id and r.active_from <= c.placed_at
                   and (r.active_until is null or c.placed_at < r.active_until)) v) ru on true
  ),
  components as materialized (
    select r.*,
           public.portfolio_score_clv(r.clv_pct, r.clv_points) as s_clv,
           public.portfolio_score_model(r.model_ev) as s_model,
           public.portfolio_score_price(r.price_slip, r.price_points) as s_price,
           public.portfolio_score_sizing(r.units, r.max_single_units_at_entry, r.day_units, r.max_daily_units_at_entry) as s_sizing,
           case when r.applicable > 0 then round(100.0 * r.followed / r.applicable, 1) end as s_rules,
           public.portfolio_score_market(r.platform_type, r.position_type) as s_market
      from ruled r
  )
  select c.id, c.platform, c.platform_label, c.platform_type, c.position_type, c.sport, c.league, c.source, c.event_name, c.selection,
         c.status, c.result, c.placed_at, c.settled_at, c.event_start_at, c.in_placed, c.in_settled, c.in_event,
         c.placed_local::date, (c.settled_at at time zone p_tz)::date, (c.event_start_at at time zone p_tz)::date,
         extract(isodow from c.placed_local)::int, case when c.event_start_at is not null then extract(isodow from (c.event_start_at at time zone p_tz))::int end,
         public.portfolio_hour_band(extract(hour from c.placed_local)::int),
         c.lead_seconds, public.portfolio_timing_bucket(c.lead_seconds), c.stake_amt, c.pnl,
         case when c.pnl is not null and c.stake_amt > 0 then round(c.pnl / c.stake_amt, 6) end,
         c.entry_dec, c.entry_price, public.portfolio_odds_band(c.entry_dec), c.units, public.portfolio_units_band(c.units),
         c.day_units, c.day_count, c.session_no, c.session_order,
         case when not c.in_placed then null when c.prev_result is null then 'NONE' when c.prev_result = 'LOSS' then 'AFTER_LOSS'
              when c.prev_result = 'WIN' then 'AFTER_WIN' else 'AFTER_OTHER' end,
         c.decile, c.decision_source, c.decision_tags, c.planned, c.has_thesis, c.would_repeat, c.library, c.closing_source,
         c.model_pre_event, c.research_pre_event, c.clv_pct, c.clv_points, c.model_ev, c.price_slip, c.price_points,
         c.s_clv, c.s_model, c.s_price, c.s_sizing, c.s_timing, c.s_rules, c.s_market,
         public.portfolio_process_weight(c.s_clv, c.s_model, c.s_price, c.s_sizing, c.s_timing, c.s_rules, c.s_market),
         public.portfolio_process_score(c.s_clv, c.s_model, c.s_price, c.s_sizing, c.s_timing, c.s_rules, c.s_market),
         public.portfolio_grade_letter(public.portfolio_process_score(c.s_clv, c.s_model, c.s_price, c.s_sizing, c.s_timing, c.s_rules, c.s_market)),
         c.applicable, c.followed, c.broken,
         /* what EdgeDesk actually knows about this decision:
            FULL_CONTEXT    the decision context was recorded before the event
            PARTIAL_CONTEXT market context (a recorded price path or close) but
                            not the reader's original reasoning
            RESULT_ONLY     the wager and its result, nothing more */
         case when c.decision_recorded_at is not null and c.decision_recorded_at < c.cutoff then 'FULL_CONTEXT'
              when c.clv_pct is not null or c.clv_points is not null or c.opening_odds_decimal is not null or c.opening_price is not null
                then 'PARTIAL_CONTEXT'
              else 'RESULT_ONLY' end,
         c.stake_type
    from components c
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. THE FACTS, CACHED PER READER — so a long history is computed once, not
--     on every request. A reader's lifetime facts (in their time zone) are
--     stored the first time they are asked for, and rebuilt only when that
--     reader's positions, journal or rules change: every request compares a
--     cheap stamp (counts and the latest change of each) first. Windows,
--     halves and the holdout are applied when read. Exposure, sessions and
--     "after a result" are computed over EVERY platform, whatever filter the
--     page applies — that is the reader's real exposure. The cache is derived
--     data under the same row level security; it is never a source of truth.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_facts_cache (
  user_id uuid not null references auth.users(id) on delete cascade,
  tz text not null,
  id uuid,
  platform text,
  platform_label text,
  platform_type text,
  position_type text,
  sport text,
  league text,
  source text,
  event_name text,
  selection text,
  status text,
  result text,
  placed_at timestamptz,
  settled_at timestamptz,
  event_start_at timestamptz,
  placed_day date,
  settled_day date,
  event_day date,
  placed_dow int,
  event_dow int,
  hour_band text,
  lead_seconds bigint,
  timing_bucket text,
  stake_amt numeric,
  pnl numeric,
  ret numeric,
  entry_dec numeric,
  entry_price numeric,
  odds_band text,
  units numeric,
  units_band text,
  day_units numeric,
  day_count int,
  session_no int,
  session_order int,
  after_result text,
  decision_source text,
  decision_tags text[],
  planned boolean,
  has_thesis boolean,
  would_repeat text,
  library text,
  closing_source text,
  model_pre_event boolean,
  research_pre_event boolean,
  clv_pct numeric,
  clv_points numeric,
  model_ev numeric,
  price_slip numeric,
  price_points numeric,
  s_clv numeric,
  s_model numeric,
  s_price numeric,
  s_sizing numeric,
  s_timing numeric,
  s_rules numeric,
  s_market numeric,
  process_weight int,
  process_score numeric,
  grade text,
  rules_applicable int,
  rules_followed int,
  rules_broken text[],
  evidence text,
  stake_type text,
  src_position_at timestamptz,
  src_journal_at timestamptz,
  primary key (user_id, tz, id)
);
alter table public.portfolio_facts_cache add column if not exists src_position_at timestamptz;
alter table public.portfolio_facts_cache add column if not exists src_journal_at timestamptz;
create table if not exists public.portfolio_facts_cache_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  tz text not null,
  stamp text not null,
  built_at timestamptz not null default now(),
  rows int not null default 0,
  rules_stamp text null,
  primary key (user_id, tz)
);
alter table public.portfolio_facts_cache_state add column if not exists rules_stamp text null;
comment on table public.portfolio_facts_cache is
  'Derived, per reader and time zone: portfolio_facts() over the reader''s whole history, rebuilt when its stamp changes. Never a source of truth.';

-- what the cached facts were built from: if any of it changed, rebuild
create or replace function public.portfolio_facts_stamp(p_user uuid)
returns text language sql stable as $$
  select concat_ws('|', 'facts_v1',
    (select count(*) || ':' || coalesce(max(updated_at)::text, '-') from public.portfolio_positions where user_id = p_user),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '-') from public.portfolio_journal_entries where user_id = p_user),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '-') from public.portfolio_rules where user_id = p_user))
$$;
