-- portfolio_journal -- part 1 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- portfolio_journal.sql — the Performance Journal, Decision Grade, Betting
-- Calendar and Process Coach, over supabase/portfolio.sql.
--
-- WHAT THIS IS
--   portfolio_journal_entries  one row per position, in three blocks:
--       DECISION  what the reader knew and planned when they entered: the
--                 opening and research-time prices, the model's probability,
--                 fair line and edge, the decision tags, PLANNED / UNPLANNED,
--                 the thesis, and the unit and caps in force (snapshotted
--                 from bankroll_settings). WRITE-ONCE, field by field: a value
--                 once recorded is never rewritten, by anyone. A later model
--                 run or market move cannot change what the decision was.
--       CLOSE     the closing price, where it came from and when it was
--                 captured. WRITE-ONCE, the same way. No closing price, no
--                 CLV: it is never estimated or invented.
--       REVIEW    the reader's own afterthought ("would I make this bet
--                 again?", a note, the Mistake / Strength Library). Editable.
--   portfolio_rules            the reader's own process rules, evaluated
--                              against every position placed while the rule
--                              was in force. Never retroactive.
--   portfolio_experiments      a process change the reader commits to for a
--                              period, pre-registered: its metric, condition
--                              and window are frozen once written.
--
-- THE GRADE IS ABOUT PROCESS, NEVER OUTCOME. portfolio_process_score() takes
-- CLV, model edge at entry, price quality, sizing, timing, rule adherence and
-- market structure. Profit or loss is not an argument to any of them: a win
-- at a bad price scores its bad price, a loss at a strong price its strong
-- price. lib/edgedesk_portfolio_process.js mirrors every formula exactly and
-- tools/portfolio/journal_sql.test.js holds the two in parity.
--
-- THE BROWSER NEVER DOWNLOADS A LIFETIME. Every dashboard figure is an
-- aggregate computed here, by functions that run AS THE CALLER (row level
-- security applies inside them): summary, breakdown cells, calendar, period
-- folders, one day's journal, a filtered list of at most 200 positions.
--
-- Run AFTER supabase/portfolio.sql. Idempotent, additive, ends in a report.
-- Paste-sized: supabase/parts/portfolio_journal.part*-of-*.sql
-- (npm run portfolio:parts).
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_positions') is null then
    raise exception 'portfolio_journal: run supabase/portfolio.sql first';
  end if;
end $$;

-- Re-running on a live site: the triggers added to portfolio_positions are
-- re-created below. Take the tables involved together, without waiting while
-- holding any (see the same block in portfolio.sql).
do $lock$
declare tries int := 0; tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into tables from pg_tables
   where schemaname = 'public' and tablename in ('portfolio_positions', 'portfolio_transactions', 'platform_accounts',
         'portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments');
  loop
    begin
      execute 'lock table ' || tables || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      tries := tries + 1;
      if tries > 300 then
        raise exception 'portfolio_journal: the tables stayed busy for a minute; run this file again when traffic is quieter';
      end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end $lock$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. VOCABULARY — pure functions, mirrored in lib/edgedesk_portfolio_process.js
-- ─────────────────────────────────────────────────────────────────────────────
-- How long before the event a position was placed, from the RAW timestamps
-- (placed_at and event_start_at are stored apart and never merged).
create or replace function public.portfolio_lead_seconds(p_placed timestamptz, p_start timestamptz)
returns bigint language sql immutable as $$
  select case when p_placed is null or p_start is null then null
              else trunc(extract(epoch from (p_start - p_placed)))::bigint end
$$;
create or replace function public.portfolio_timing_bucket(p_lead_seconds bigint)
returns text language sql immutable as $$
  select case when p_lead_seconds is null then 'UNKNOWN'
              when p_lead_seconds <= 0 then 'LIVE'
              when p_lead_seconds < 3600 then 'UNDER_1H'
              when p_lead_seconds < 21600 then 'H1_6'
              when p_lead_seconds < 86400 then 'H6_24'
              when p_lead_seconds < 259200 then 'D1_3'
              when p_lead_seconds < 604800 then 'D3_7'
              else 'D7_PLUS' end
$$;
-- decimal odds → a price band (a prediction-market price p is decimal 1/p)
create or replace function public.portfolio_odds_band(p_dec numeric)
returns text language sql immutable as $$
  select case when p_dec is null then 'UNKNOWN'
              when p_dec < 1.5 then 'HEAVY_FAVOURITE'
              when p_dec < 1.91 then 'FAVOURITE'
              when p_dec <= 2.1 then 'NEAR_EVEN'
              when p_dec < 3 then 'UNDERDOG'
              when p_dec < 5 then 'LONG'
              else 'LONGSHOT' end
$$;
create or replace function public.portfolio_units_band(p_units numeric)
returns text language sql immutable as $$
  select case when p_units is null then 'NO_UNIT'
              when p_units < 0.5 then 'UNDER_HALF'
              when p_units <= 1 then 'HALF_TO_ONE'
              when p_units <= 2 then 'ONE_TO_TWO'
              else 'OVER_TWO' end
$$;
create or replace function public.portfolio_hour_band(p_hour int)
returns text language sql immutable as $$
  select case when p_hour is null then 'UNKNOWN' when p_hour < 6 then 'NIGHT' when p_hour < 12 then 'MORNING'
              when p_hour < 18 then 'AFTERNOON' else 'EVENING' end
$$;
-- "Over 47.5", "o47.5", side OVER → OVER; the same for under; else null
create or replace function public.portfolio_ou_direction(p_selection text, p_side text)
returns text language sql immutable as $$
  select case when coalesce(p_side, '') ~* '^\s*over\M' or coalesce(p_selection, '') ~* '^\s*(over\M|o\s*[+]?[0-9])' then 'OVER'
              when coalesce(p_side, '') ~* '^\s*under\M' or coalesce(p_selection, '') ~* '^\s*(under\M|u\s*[+]?[0-9])' then 'UNDER' end
$$;
-- points by which the entry line beats a reference line (+ = better for the
-- bettor): a spread or handicap is quoted for the side held (−2.5 beats −3.5),
-- an over wants the lower total, an under the higher
create or replace function public.portfolio_line_gain(p_dir text, p_entry numeric, p_ref numeric)
returns numeric language sql immutable as $$
  select case when p_entry is null or p_ref is null then null
              when p_dir = 'OVER' then p_ref - p_entry
              when p_dir = 'UNDER' then p_entry - p_ref
              else p_entry - p_ref end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE PROCESS COMPONENTS — each 0–100 or NULL (unavailable, never guessed).
--    Profit and loss are not an argument to any of them.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_clamp_score(p numeric)
returns numeric language sql immutable as $$
  select case when p is null then null else round(least(100, greatest(0, p)), 1) end
$$;
-- CLV as a fraction of price, + = the entry beat the close. Sportsbook:
-- entry decimal ÷ closing decimal − 1. Prediction market (price of the side
-- held, 0–1): closing price ÷ average entry price − 1 — the same quantity.
create or replace function public.portfolio_clv_pct(p_platform_type text, p_entry numeric, p_close numeric)
returns numeric language sql immutable as $$
  select case when p_entry is null or p_close is null then null
              when p_platform_type = 'PREDICTION_MARKET' then
                case when p_entry > 0 and p_close >= 0 and p_close <= 1 then round(p_close / p_entry, 6) - 1 end
              else case when p_entry > 1 and p_close > 1 then round(p_entry / p_close, 6) - 1 end end
$$;
-- CLV score: 50 is the close; ±5% of price spans 0–100; a line that moved is
-- graded in points instead, ±2 points spanning 0–100 (a stated convention,
-- not a pricing model)
create or replace function public.portfolio_score_clv(p_pct numeric, p_points numeric)
returns numeric language sql immutable as $$
  select case when p_points is not null then public.portfolio_clamp_score(50 + 25 * p_points)
              when p_pct is not null then public.portfolio_clamp_score(50 + 1000 * p_pct) end
$$;
-- expected value per $1 at the entry price, from a probability recorded
-- before the event: p × decimal − 1 (sportsbook), p ÷ price − 1 (contract)
create or replace function public.portfolio_model_ev(p_platform_type text, p_prob numeric, p_entry numeric)
returns numeric language sql immutable as $$
  select case when p_prob is null or p_entry is null or p_prob <= 0 or p_prob >= 1 then null
              when p_platform_type = 'PREDICTION_MARKET' then case when p_entry > 0 then round(p_prob / p_entry, 6) - 1 end
              else case when p_entry > 1 then round(p_prob * p_entry, 6) - 1 end end
$$;
create or replace function public.portfolio_score_model(p_ev numeric)
returns numeric language sql immutable as $$
  select public.portfolio_clamp_score(50 + 1000 * p_ev)
$$;
-- value kept between deciding and placing: entry vs the research-time price
-- (+ = entered at a better price than researched)
create or replace function public.portfolio_price_slip(p_platform_type text, p_entry numeric, p_research numeric)
returns numeric language sql immutable as $$
  select case when p_entry is null or p_research is null then null
              when p_platform_type = 'PREDICTION_MARKET' then case when p_entry > 0 and p_research > 0 then round(p_research / p_entry, 6) - 1 end
              else case when p_entry > 1 and p_research > 1 then round(p_entry / p_research, 6) - 1 end end
$$;
-- matching or beating the researched price scores 100; each 1% given up
-- costs 10 points, each point of line 25
create or replace function public.portfolio_score_price(p_slip numeric, p_points numeric)
returns numeric language sql immutable as $$
  select case when p_points is not null then public.portfolio_clamp_score(100 + 25 * least(p_points, 0))
              when p_slip is not null then public.portfolio_clamp_score(100 + 1000 * least(p_slip, 0)) end
$$;
-- where the entry sits on the recorded price path (opening, research, close
-- at the same line): 100 = the best recorded price, 0 = the worst. Needs at
-- least two recorded points besides the entry and a path that moved.
-- Sportsbook values are decimal odds (higher is better); contract values are
-- prices (lower is better).
create or replace function public.portfolio_score_timing(p_platform_type text, p_entry numeric, p_open numeric, p_research numeric, p_close numeric)
returns numeric language sql immutable as $$
  select case when p_entry is null
                or ((p_open is not null)::int + (p_research is not null)::int + (p_close is not null)::int) < 2
                or greatest(p_entry, p_open, p_research, p_close) = least(p_entry, p_open, p_research, p_close) then null
              when p_platform_type = 'PREDICTION_MARKET' then
                round(100 * (greatest(p_entry, p_open, p_research, p_close) - p_entry)
                      / (greatest(p_entry, p_open, p_research, p_close) - least(p_entry, p_open, p_research, p_close)), 1)
              else round(100 * (p_entry - least(p_entry, p_open, p_research, p_close))
                      / (greatest(p_entry, p_open, p_research, p_close) - least(p_entry, p_open, p_research, p_close)), 1) end
$$;
-- sizing against the reader's own caps in force at entry: within the cap
-- scores 100, twice the cap 0; the day's running exposure is held to the
-- daily cap the same way; the worse of the two counts
create or replace function public.portfolio_score_sizing(p_units numeric, p_max_single numeric, p_day_units numeric, p_max_daily numeric)
returns numeric language sql immutable as $$
  select public.portfolio_clamp_score(least(
    case when p_units is null or p_max_single is null or p_max_single <= 0 then null
         when p_units <= p_max_single then 100 else 200 - 100 * round(p_units / p_max_single, 6) end,
    case when p_day_units is null or p_max_daily is null or p_max_daily <= 0 then null
         when p_day_units <= p_max_daily then 100 else 200 - 100 * round(p_day_units / p_max_daily, 6) end))
$$;
-- the TYPICAL structural margin of the market chosen (a tier by market type,
-- not this market's measured margin)
create or replace function public.portfolio_score_market(p_platform_type text, p_position_type text)
returns numeric language sql immutable as $$
  select case when p_platform_type = 'PREDICTION_MARKET' then 70::numeric
              else case p_position_type when 'MONEYLINE' then 80 when 'SPREAD' then 80 when 'TOTAL' then 80
                     when 'PLAYER_PROP' then 60 when 'FUTURE' then 40 when 'PARLAY' then 30 when 'SAME_GAME_PARLAY' then 20
                     when 'EVENT_CONTRACT' then 70 when 'PREDICTION_MARKET' then 70 end end
$$;
-- the weights: CLV 30 · model edge 20 · price quality 15 · sizing 15 ·
-- timing 10 · rule adherence 5 · market structure 5, renormalized over the
-- components that exist. Graded only with at least one price-based component
-- (CLV, model edge, price quality, timing) and at least 30 of the 100 points
-- of weight — no points are ever awarded for data that is missing.
create or replace function public.portfolio_process_weight(c numeric, m numeric, p numeric, s numeric, t numeric, r numeric, k numeric)
returns int language sql immutable as $$
  select (case when c is null then 0 else 30 end) + (case when m is null then 0 else 20 end) + (case when p is null then 0 else 15 end)
       + (case when s is null then 0 else 15 end) + (case when t is null then 0 else 10 end) + (case when r is null then 0 else 5 end)
       + (case when k is null then 0 else 5 end)
$$;
create or replace function public.portfolio_process_score(c numeric, m numeric, p numeric, s numeric, t numeric, r numeric, k numeric)
returns numeric language sql immutable as $$
  select case when (c is not null or m is not null or p is not null or t is not null)
               and public.portfolio_process_weight(c, m, p, s, t, r, k) >= 30
    then round((coalesce(30 * c, 0) + coalesce(20 * m, 0) + coalesce(15 * p, 0) + coalesce(15 * s, 0) + coalesce(10 * t, 0)
                + coalesce(5 * r, 0) + coalesce(5 * k, 0)) / public.portfolio_process_weight(c, m, p, s, t, r, k), 1) end
$$;
create or replace function public.portfolio_grade_letter(p_score numeric)
returns text language sql immutable as $$
  select case when p_score is null then null when p_score >= 90 then 'A+' when p_score >= 84 then 'A' when p_score >= 78 then 'A-'
              when p_score >= 72 then 'B+' when p_score >= 66 then 'B' when p_score >= 60 then 'B-' when p_score >= 55 then 'C+'
              when p_score >= 45 then 'C' when p_score >= 40 then 'C-' when p_score >= 30 then 'D' else 'F' end
$$;
-- how much to trust an aggregate of n graded positions
create or replace function public.portfolio_confidence(p_n bigint)
returns text language sql immutable as $$
  select case when coalesce(p_n, 0) < 10 then 'BUILDING' when p_n < 30 then 'LOW' when p_n < 100 then 'MEDIUM' else 'HIGH' end
$$;
