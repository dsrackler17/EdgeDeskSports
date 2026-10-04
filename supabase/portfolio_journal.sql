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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE JOURNAL
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_journal_entries (
  position_id               uuid        primary key,
  user_id                   uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  -- DECISION (write-once per field)
  decision_source           text        null,
  opening_odds_american     integer     null,
  opening_odds_decimal      numeric     null,
  opening_line              numeric     null,
  opening_price             numeric     null,
  research_odds_american    integer     null,
  research_odds_decimal     numeric     null,
  research_line             numeric     null,
  research_price            numeric     null,
  research_at               timestamptz null,
  model_version             text        null,
  model_probability         numeric     null,
  model_fair_line           numeric     null,
  model_fair_odds_decimal   numeric     null,
  edge_at_entry             numeric     null,
  confidence_tier           text        null,
  decision_tags             text[]      null,
  planned                   boolean     null,
  thesis                    text        null,
  unit_size_at_entry        numeric     null,
  bankroll_at_entry         numeric     null,
  max_single_units_at_entry numeric     null,
  max_daily_units_at_entry  numeric     null,
  unit_recorded_at          timestamptz null,
  decision_recorded_at      timestamptz null,
  model_recorded_at         timestamptz null,
  research_recorded_at      timestamptz null,
  tags_recorded_at          timestamptz null,
  -- CLOSE (write-once per field)
  closing_odds_american     integer     null,
  closing_odds_decimal      numeric     null,
  closing_line              numeric     null,
  closing_price             numeric     null,
  closing_source            text        null,
  closing_book              text        null,
  closing_recorded_at       timestamptz null,
  -- REVIEW (the reader's)
  would_repeat              text        null,
  review_note               text        null,
  library                   text        null,
  reviewed_at               timestamptz null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint portfolio_journal_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_journal_source check ((decision_source is null or decision_source in ('EDGEDESK', 'USER', 'OTHER'))
    and (closing_source is null or closing_source in ('USER', 'PLATFORM', 'EDGEDESK_CAPTURE'))),
  constraint portfolio_journal_odds check (
    (opening_odds_american is null or ((opening_odds_american <= -100 or opening_odds_american >= 100) and abs(opening_odds_american) <= 1000000))
    and (research_odds_american is null or ((research_odds_american <= -100 or research_odds_american >= 100) and abs(research_odds_american) <= 1000000))
    and (closing_odds_american is null or ((closing_odds_american <= -100 or closing_odds_american >= 100) and abs(closing_odds_american) <= 1000000))
    and (opening_odds_decimal is null or (opening_odds_decimal > 1 and opening_odds_decimal <= 10001))
    and (research_odds_decimal is null or (research_odds_decimal > 1 and research_odds_decimal <= 10001))
    and (closing_odds_decimal is null or (closing_odds_decimal > 1 and closing_odds_decimal <= 10001))
    and (model_fair_odds_decimal is null or (model_fair_odds_decimal > 1 and model_fair_odds_decimal <= 10001))),
  constraint portfolio_journal_prices check ((opening_price is null or opening_price between 0 and 1)
    and (research_price is null or research_price between 0 and 1) and (closing_price is null or closing_price between 0 and 1)
    and (model_probability is null or (model_probability > 0 and model_probability < 1))
    and (edge_at_entry is null or edge_at_entry between -1 and 100)),
  constraint portfolio_journal_lines check ((opening_line is null or abs(opening_line) <= 1000) and (research_line is null or abs(research_line) <= 1000)
    and (closing_line is null or abs(closing_line) <= 1000) and (model_fair_line is null or abs(model_fair_line) <= 1000)),
  constraint portfolio_journal_units check ((unit_size_at_entry is null or unit_size_at_entry > 0) and (bankroll_at_entry is null or bankroll_at_entry > 0)
    and (max_single_units_at_entry is null or max_single_units_at_entry > 0) and (max_daily_units_at_entry is null or max_daily_units_at_entry > 0)),
  constraint portfolio_journal_tags check (decision_tags is null or (cardinality(decision_tags) <= 11 and decision_tags <@ array['MODEL', 'LINE_VALUE',
    'MATCHUP', 'INJURY', 'WEATHER', 'MARKET_MOVEMENT', 'PROMOTION', 'LIVE_READ', 'HEDGE', 'PERSONAL_READ', 'OTHER']::text[])),
  constraint portfolio_journal_review check ((would_repeat is null or would_repeat in ('YES', 'NO', 'UNSURE'))
    and (library is null or library in ('MISTAKE', 'STRENGTH'))),
  constraint portfolio_journal_text check (coalesce(length(thesis), 0) <= 1000 and coalesce(length(review_note), 0) <= 1000
    and coalesce(length(model_version), 0) <= 60 and coalesce(length(confidence_tier), 0) <= 30 and coalesce(length(closing_book), 0) <= 60)
);
comment on table public.portfolio_journal_entries is
  'One row per position. DECISION and CLOSE fields are write-once (a recorded value is never rewritten, by anyone); REVIEW fields are the reader''s. The Decision Grade reads these, never profit or loss.';
create index if not exists portfolio_journal_user on public.portfolio_journal_entries (user_id);
create index if not exists portfolio_positions_user_settled on public.portfolio_positions (user_id, settled_at) where settled_at is not null;

-- the fields that, once recorded, never change
create or replace function public.portfolio_journal_frozen_fields()
returns text[] language sql immutable as $$
  select array['decision_source', 'opening_odds_american', 'opening_odds_decimal', 'opening_line', 'opening_price',
    'research_odds_american', 'research_odds_decimal', 'research_line', 'research_price', 'research_at', 'model_version',
    'model_probability', 'model_fair_line', 'model_fair_odds_decimal', 'edge_at_entry', 'confidence_tier', 'decision_tags',
    'planned', 'thesis', 'unit_size_at_entry', 'bankroll_at_entry', 'max_single_units_at_entry', 'max_daily_units_at_entry', 'unit_recorded_at',
    'closing_odds_american', 'closing_odds_decimal', 'closing_line', 'closing_price', 'closing_source', 'closing_book']
$$;

create or replace function public.portfolio_journal_guard() returns trigger
language plpgsql as $$
declare
  reader boolean := auth.uid() is not null;
  o jsonb; n jsonb; k text;
  now_ts timestamptz := now();
  has_close boolean;
begin
  if tg_op = 'INSERT' then
    if reader then new.user_id := auth.uid(); end if;
    new.created_at := now_ts;
    o := '{}'::jsonb;
  else
    new.position_id := old.position_id; new.user_id := old.user_id; new.created_at := old.created_at;
    o := to_jsonb(old);
  end if;
  /* odds typed as American carry their decimal, computed the one way */
  if new.opening_odds_american is not null and new.opening_odds_decimal is null then new.opening_odds_decimal := public.portfolio_american_to_decimal(new.opening_odds_american); end if;
  if new.research_odds_american is not null and new.research_odds_decimal is null then new.research_odds_decimal := public.portfolio_american_to_decimal(new.research_odds_american); end if;
  if new.closing_odds_american is not null and new.closing_odds_decimal is null then new.closing_odds_decimal := public.portfolio_american_to_decimal(new.closing_odds_american); end if;
  new.thesis := nullif(btrim(new.thesis), '');
  new.review_note := nullif(btrim(new.review_note), '');
  if new.decision_tags is not null then
    new.decision_tags := (select array_agg(distinct upper(btrim(t)) order by upper(btrim(t))) from unnest(new.decision_tags) t where btrim(t) <> '');
  end if;
  /* who said what the close was: a reader's closing price is the reader's
     word; only a connector or EdgeDesk's own capture may name another source,
     and a source once recorded stays */
  has_close := coalesce(new.closing_odds_decimal, new.closing_price, new.closing_line) is not null;
  if o->>'closing_source' is not null then new.closing_source := o->>'closing_source';
  elsif not has_close then new.closing_source := null;
  elsif reader or new.closing_source is null then new.closing_source := 'USER';
  end if;
  if tg_op = 'UPDATE' then
    n := to_jsonb(new);
    foreach k in array public.portfolio_journal_frozen_fields() loop
      if jsonb_typeof(coalesce(o->k, 'null'::jsonb)) <> 'null' and (n->k) is distinct from (o->k) then
        raise exception 'portfolio: a recorded decision is never rewritten (%)', k using errcode = '42501',
          hint = 'Add a review note instead; the original stays as it was.';
      end if;
    end loop;
  end if;
  /* when each part was first recorded: the grade only credits a model
     probability or a research price recorded before the event */
  new.decision_recorded_at := case when coalesce(new.decision_source, new.opening_odds_decimal::text, new.opening_line::text, new.opening_price::text,
      new.research_odds_decimal::text, new.research_line::text, new.research_price::text, new.model_probability::text, new.model_fair_line::text,
      new.edge_at_entry::text, new.planned::text, new.thesis, array_to_string(new.decision_tags, ',')) is null then null
    else coalesce((o->>'decision_recorded_at')::timestamptz, now_ts) end;
  new.model_recorded_at := case when new.model_probability is null then null else coalesce((o->>'model_recorded_at')::timestamptz, now_ts) end;
  new.research_recorded_at := case when coalesce(new.research_odds_decimal, new.research_price, new.research_line) is null then null
                                   else coalesce((o->>'research_recorded_at')::timestamptz, now_ts) end;
  new.tags_recorded_at := case when new.decision_tags is null and new.planned is null then null
                               else coalesce((o->>'tags_recorded_at')::timestamptz, now_ts) end;
  new.closing_recorded_at := case when has_close then coalesce((o->>'closing_recorded_at')::timestamptz, now_ts) end;
  if tg_op = 'INSERT' or (new.would_repeat, new.review_note, new.library) is distinct from (o->>'would_repeat', o->>'review_note', o->>'library') then
    new.reviewed_at := case when coalesce(new.would_repeat, new.review_note, new.library) is null then null else now_ts end;
  else
    new.reviewed_at := (o->>'reviewed_at')::timestamptz;
  end if;
  new.updated_at := now_ts;
  return new;
end $$;
drop trigger if exists portfolio_journal_guard_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_guard_trg before insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_journal_guard();

-- The unit and caps in force for a reader, read the way lib/edgedesk_bankroll.js
-- unitValue() reads them: a fixed unit, else a percentage of the bankroll,
-- else a typed unit, else none. bankroll_settings belongs to the staking
-- engine; this only reads it, and copes with it not existing at all.
create or replace function public.portfolio_unit_snapshot(p_user uuid)
returns table (unit numeric, bankroll numeric, max_single numeric, max_daily numeric)
language plpgsql stable as $$
declare j jsonb; mode text; pct numeric; base numeric; bank numeric;
begin
  if to_regclass('public.bankroll_settings') is null then return; end if;
  execute 'select to_jsonb(b) from public.bankroll_settings b where b.user_id = $1' into j using p_user;
  if j is null then return; end if;
  base := case when (j->>'base_unit_amount') ~ '^[0-9]+(\.[0-9]+)?$' and (j->>'base_unit_amount')::numeric > 0 then (j->>'base_unit_amount')::numeric end;
  bank := case when (j->>'bankroll_amount') ~ '^[0-9]+(\.[0-9]+)?$' and (j->>'bankroll_amount')::numeric > 0 then (j->>'bankroll_amount')::numeric end;
  pct := case when (j->>'unit_percent') ~ '^[0-9]*\.?[0-9]+$' then (j->>'unit_percent')::numeric end;
  if pct is null or pct <= 0 or pct > 0.10 then pct := 0.01; end if;
  mode := case when j->>'unit_mode' in ('fixed', 'percent') then j->>'unit_mode' when base is not null then 'fixed' else 'percent' end;
  unit := case when mode = 'fixed' and base is not null then base when bank is not null then round(bank * pct, 2) else base end;
  bankroll := bank;
  max_single := case when (j->>'maximum_single_wager_units') ~ '^[0-9]*\.?[0-9]+$' then (j->>'maximum_single_wager_units')::numeric end;
  max_daily := case when (j->>'maximum_daily_exposure_units') ~ '^[0-9]*\.?[0-9]+$' then (j->>'maximum_daily_exposure_units')::numeric end;
  return next;
end $$;

-- Every position gets its journal entry the moment it exists, with the
-- decision context it arrived with and the unit and caps in force then.
-- Attribution set on the position later fills only what the journal has not
-- recorded yet; it never replaces a recorded value.
create or replace function public.portfolio_positions_journal() returns trigger
language plpgsql as $$
declare u record; src text;
begin
  src := case new.edge_source when 'EDGEDESK' then 'EDGEDESK' when 'SELF' then 'USER' when 'OTHER' then 'OTHER' end;
  if tg_op = 'INSERT' then
    select * into u from public.portfolio_unit_snapshot(new.user_id);
    insert into public.portfolio_journal_entries (position_id, user_id, decision_source, model_version, model_probability, model_fair_line,
        research_line, edge_at_entry, confidence_tier, unit_size_at_entry, bankroll_at_entry, max_single_units_at_entry,
        max_daily_units_at_entry, unit_recorded_at)
    values (new.id, new.user_id, src, new.model_version, new.model_probability, new.model_fair_line, new.market_line_at_research,
        new.edge_at_entry, new.confidence_tier, u.unit, u.bankroll, u.max_single, u.max_daily, case when u.unit is not null then now() end)
    on conflict (position_id) do nothing;
  else
    update public.portfolio_journal_entries j set
           decision_source = coalesce(j.decision_source, src), model_version = coalesce(j.model_version, new.model_version),
           model_probability = coalesce(j.model_probability, new.model_probability), model_fair_line = coalesce(j.model_fair_line, new.model_fair_line),
           research_line = coalesce(j.research_line, new.market_line_at_research), edge_at_entry = coalesce(j.edge_at_entry, new.edge_at_entry),
           confidence_tier = coalesce(j.confidence_tier, new.confidence_tier)
     where j.position_id = new.id
       and ((j.decision_source is null and src is not null) or (j.model_version is null and new.model_version is not null)
         or (j.model_probability is null and new.model_probability is not null) or (j.model_fair_line is null and new.model_fair_line is not null)
         or (j.research_line is null and new.market_line_at_research is not null) or (j.edge_at_entry is null and new.edge_at_entry is not null)
         or (j.confidence_tier is null and new.confidence_tier is not null));
  end if;
  return null;
end $$;
drop trigger if exists portfolio_positions_journal_ins_trg on public.portfolio_positions;
create trigger portfolio_positions_journal_ins_trg after insert on public.portfolio_positions
  for each row execute function public.portfolio_positions_journal();
drop trigger if exists portfolio_positions_journal_upd_trg on public.portfolio_positions;
create trigger portfolio_positions_journal_upd_trg after update on public.portfolio_positions
  for each row when ((old.edge_source, old.model_version, old.model_probability, old.model_fair_line, old.market_line_at_research,
                      old.edge_at_entry, old.confidence_tier)
       is distinct from (new.edge_source, new.model_version, new.model_probability, new.model_fair_line, new.market_line_at_research,
                      new.edge_at_entry, new.confidence_tier))
  execute function public.portfolio_positions_journal();

-- positions that existed before the journal: an entry each, recorded now
-- (the conservative stamp — a model probability that cannot be shown to
-- predate the event is not credited as pre-event)
insert into public.portfolio_journal_entries (position_id, user_id, decision_source, model_version, model_probability, model_fair_line,
    research_line, edge_at_entry, confidence_tier)
select p.id, p.user_id, case p.edge_source when 'EDGEDESK' then 'EDGEDESK' when 'SELF' then 'USER' when 'OTHER' then 'OTHER' end,
       p.model_version, p.model_probability, p.model_fair_line, p.market_line_at_research, p.edge_at_entry, p.confidence_tier
  from public.portfolio_positions p
 where not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RULES AND EXPERIMENTS — the reader's own, never retroactive
-- ─────────────────────────────────────────────────────────────────────────────
-- a rule's parameters are numbers where numbers are meant, checked on the way
-- in: a malformed one could never be evaluated
create or replace function public.portfolio_rule_params_ok(p_kind text, p_params jsonb)
returns boolean language sql immutable as $$
  select case p_kind
    when 'MAX_STAKE_UNITS' then jsonb_typeof(p_params->'units') = 'number' and (p_params->>'units')::numeric > 0
    when 'MAX_DAILY_UNITS' then jsonb_typeof(p_params->'units') = 'number' and (p_params->>'units')::numeric > 0
    when 'MAX_POSITIONS_PER_DAY' then jsonb_typeof(p_params->'count') = 'number' and (p_params->>'count')::numeric >= 1
    when 'MIN_MODEL_EDGE' then jsonb_typeof(p_params->'ev') = 'number' and (p_params->>'ev')::numeric between -1 and 1
    when 'ODDS_BETWEEN' then coalesce(jsonb_typeof(p_params->'min'), 'number') = 'number' and coalesce(jsonb_typeof(p_params->'max'), 'number') = 'number'
                             and (p_params ? 'min' or p_params ? 'max')
                             and coalesce((p_params->>'min')::numeric, 1) <= coalesce((p_params->>'max')::numeric, 10001)
    when 'MIN_LEAD_HOURS' then jsonb_typeof(p_params->'hours') = 'number' and (p_params->>'hours')::numeric between 0 and 8760
    when 'ONLY_SPORTS' then jsonb_typeof(p_params->'sports') = 'array' and jsonb_array_length(p_params->'sports') between 1 and 30
    else true end
$$;

create table if not exists public.portfolio_rules (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text        not null,
  params        jsonb       not null default '{}'::jsonb,
  label         text        not null,
  active_from   timestamptz not null default now(),
  active_until  timestamptz null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint portfolio_rules_kind check (kind in ('MAX_STAKE_UNITS', 'MAX_DAILY_UNITS', 'MAX_POSITIONS_PER_DAY', 'MIN_MODEL_EDGE',
    'ODDS_BETWEEN', 'NO_LIVE', 'MIN_LEAD_HOURS', 'NO_PARLAYS', 'ONLY_SPORTS', 'REQUIRE_PLANNED', 'REQUIRE_THESIS')),
  constraint portfolio_rules_params check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 2048
    and public.portfolio_rule_params_ok(kind, params)),
  constraint portfolio_rules_label check (length(btrim(label)) between 1 and 120),
  constraint portfolio_rules_window check (active_until is null or active_until >= active_from)
);
create index if not exists portfolio_rules_user on public.portfolio_rules (user_id, active_from);

-- a rule means what it meant when it was adopted: its kind, parameters and
-- start are frozen; it can be renamed, and retired once (to change a rule,
-- retire it and adopt a new one)
create or replace function public.portfolio_rules_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); new.active_from := now(); new.active_until := null; end if;
    new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.kind := old.kind; new.params := old.params; new.active_from := old.active_from;
    if old.active_until is not null then new.active_until := old.active_until; end if;
    if new.active_until is not null and new.active_until < new.active_from then new.active_until := new.active_from; end if;
  end if;
  new.label := btrim(new.label);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_rules_guard_trg on public.portfolio_rules;
create trigger portfolio_rules_guard_trg before insert or update on public.portfolio_rules
  for each row execute function public.portfolio_rules_guard();

create table if not exists public.portfolio_experiments (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  title         text        not null,
  hypothesis    text        null,
  metric        text        not null,
  condition     jsonb       not null default '{}'::jsonb,
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  min_sample    int         not null default 20,
  status        text        not null default 'ACTIVE',
  ended_at      timestamptz null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint portfolio_experiments_metric check (metric in ('CLV', 'PROCESS', 'ROI')),
  constraint portfolio_experiments_condition check (jsonb_typeof(condition) = 'object' and pg_column_size(condition) <= 2048),
  constraint portfolio_experiments_text check (length(btrim(title)) between 1 and 120 and coalesce(length(hypothesis), 0) <= 500),
  constraint portfolio_experiments_window check (ends_at > starts_at and ends_at <= starts_at + interval '366 days'),
  constraint portfolio_experiments_sample check (min_sample between 5 and 1000),
  constraint portfolio_experiments_status check (status in ('ACTIVE', 'ENDED', 'ABANDONED'))
);
create index if not exists portfolio_experiments_user on public.portfolio_experiments (user_id, starts_at desc);

-- pre-registered: what is measured, on what, and over which window cannot be
-- changed once the experiment exists — only ended early or abandoned
create or replace function public.portfolio_experiments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); new.starts_at := greatest(new.starts_at, now() - interval '1 minute'); end if;
    new.status := 'ACTIVE'; new.ended_at := null; new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.metric := old.metric; new.condition := old.condition; new.starts_at := old.starts_at; new.ends_at := old.ends_at;
    new.min_sample := old.min_sample;
    if old.status <> 'ACTIVE' then new.status := old.status; new.ended_at := old.ended_at;
    elsif new.status <> 'ACTIVE' then new.ended_at := least(now(), old.ends_at); end if;
  end if;
  new.title := btrim(new.title);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_experiments_guard_trg on public.portfolio_experiments;
create trigger portfolio_experiments_guard_trg before insert or update on public.portfolio_experiments
  for each row execute function public.portfolio_experiments_guard();

-- one rule against one position: FOLLOWED, BROKEN, or UNKNOWN when the data
-- the rule needs was never recorded (an unknown is never counted either way)
create or replace function public.portfolio_rule_verdict(p_kind text, p_params jsonb, p_units numeric, p_day_units numeric, p_day_count int,
    p_model_ev numeric, p_entry_dec numeric, p_lead_seconds bigint, p_position_type text, p_sport text, p_planned boolean, p_thesis boolean)
returns text language sql immutable as $$
  select case p_kind
    when 'MAX_STAKE_UNITS' then case when p_units is null or (p_params->>'units') is null then 'UNKNOWN'
                                     when p_units <= (p_params->>'units')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MAX_DAILY_UNITS' then case when p_day_units is null or (p_params->>'units') is null then 'UNKNOWN'
                                     when p_day_units <= (p_params->>'units')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MAX_POSITIONS_PER_DAY' then case when p_day_count is null or (p_params->>'count') is null then 'UNKNOWN'
                                     when p_day_count <= (p_params->>'count')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'MIN_MODEL_EDGE' then case when p_model_ev is null or (p_params->>'ev') is null then 'UNKNOWN'
                                     when p_model_ev >= (p_params->>'ev')::numeric then 'FOLLOWED' else 'BROKEN' end
    when 'ODDS_BETWEEN' then case when p_entry_dec is null then 'UNKNOWN'
                                  when p_entry_dec >= coalesce((p_params->>'min')::numeric, 1) and p_entry_dec <= coalesce((p_params->>'max')::numeric, 10001)
                                  then 'FOLLOWED' else 'BROKEN' end
    when 'NO_LIVE' then case when p_lead_seconds is null then 'UNKNOWN' when p_lead_seconds > 0 then 'FOLLOWED' else 'BROKEN' end
    when 'MIN_LEAD_HOURS' then case when p_lead_seconds is null or (p_params->>'hours') is null then 'UNKNOWN'
                                    when p_lead_seconds >= (p_params->>'hours')::numeric * 3600 then 'FOLLOWED' else 'BROKEN' end
    when 'NO_PARLAYS' then case when p_position_type in ('PARLAY', 'SAME_GAME_PARLAY') then 'BROKEN' else 'FOLLOWED' end
    when 'ONLY_SPORTS' then case when p_sport is null or jsonb_typeof(p_params->'sports') <> 'array' then 'UNKNOWN'
                                 when upper(p_sport) in (select upper(x) from jsonb_array_elements_text(p_params->'sports') x) then 'FOLLOWED' else 'BROKEN' end
    when 'REQUIRE_PLANNED' then case when p_planned is null then 'UNKNOWN' when p_planned then 'FOLLOWED' else 'BROKEN' end
    when 'REQUIRE_THESIS' then case when p_thesis then 'FOLLOWED' else 'BROKEN' end
    else 'UNKNOWN' end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE FACTS — every position the caller owns that was placed or settled in
--    the window, with its timing, prices, units, session, the result that
--    came before it, its rule verdicts and its process components. Runs as
--    the caller: row level security decides what it can see.
-- ─────────────────────────────────────────────────────────────────────────────
-- the reader's zone: as asked, else their saved preference, else UTC; an
-- unknown zone is an error, never a silent UTC
create or replace function public.portfolio_tz(p_tz text)
returns text language plpgsql stable as $$
declare z text := nullif(btrim(coalesce(p_tz, '')), '');
begin
  if z is null and to_regclass('public.user_preferences') is not null and auth.uid() is not null then
    begin
      execute 'select nullif(btrim(timezone), '''') from public.user_preferences where user_id = $1' into z using auth.uid();
    exception when undefined_column then z := null;
    end;
  end if;
  z := coalesce(z, 'UTC');
  if length(z) > 64 or z !~ '^[A-Za-z0-9_+/-]+$' then
    raise exception 'portfolio: unknown time zone %', left(z, 64) using errcode = '22023';
  end if;
  begin
    perform now() at time zone z;
  exception when invalid_parameter_value then
    raise exception 'portfolio: unknown time zone %', z using errcode = '22023';
  end;
  return z;
end $$;

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

-- make sure the caller's cached facts are current; returns the zone used.
-- First build: everything. After that, only what changed: each cached row
-- remembers the position and journal versions it was built from, and the
-- rows to recompute are those whose sources moved, plus every position placed
-- in the days around them (whole local days, with a margin) — so a day's
-- exposure, a session and "after a result" stay exact without recomputing a
-- lifetime. A change to the rules, or to most of the history, rebuilds all.
create or replace function public.portfolio_facts_fresh(p_tz text)
returns text language plpgsql volatile set jit = off set work_mem = '64MB' as $$
declare
  z text := public.portfolio_tz(p_tz); u uuid := auth.uid(); st text; cur record; rs text;
  n int; total int; lo timestamptz; hi timestamptz; core_lo timestamptz; core_hi timestamptz; changed int; ids uuid[];
begin
  if u is null then return z; end if;
  st := public.portfolio_facts_stamp(u);
  select c.stamp into cur from public.portfolio_facts_cache_state c where c.user_id = u and c.tz = z;
  if cur.stamp is not distinct from st then return z; end if;
  /* one rebuild at a time per reader and zone; whoever waited re-checks */
  perform pg_advisory_xact_lock(hashtextextended('portfolio_facts|' || u::text || '|' || z, 0));
  select c.* into cur from public.portfolio_facts_cache_state c where c.user_id = u and c.tz = z;
  st := public.portfolio_facts_stamp(u);
  if cur.stamp is not distinct from st then return z; end if;
  rs := (select count(*) || ':' || coalesce(max(updated_at)::text, '-') from public.portfolio_rules where user_id = u);
  select count(*) into total from public.portfolio_positions where user_id = u;

  if cur.stamp is not null and cur.rules_stamp is not distinct from rs then
    /* what moved: new or edited positions and journals (their placed and
       settled times, old and new), and positions that are gone */
    select array_agg(distinct x.id), count(distinct x.id), min(x.at), max(x.at) into ids, changed, core_lo, core_hi from (
    select p.id, t.at from public.portfolio_positions p
      left join public.portfolio_journal_entries j on j.position_id = p.id
      left join public.portfolio_facts_cache c on c.user_id = u and c.tz = z and c.id = p.id
      cross join lateral (values (p.placed_at), (p.settled_at), (c.placed_at), (c.settled_at)) t(at)
     where p.user_id = u and t.at is not null
       and (c.id is null or c.src_position_at is distinct from p.updated_at or c.src_journal_at is distinct from j.updated_at)
    union all
    select c.id, t.at from public.portfolio_facts_cache c cross join lateral (values (c.placed_at), (c.settled_at)) t(at)
     where c.user_id = u and c.tz = z and t.at is not null
       and not exists (select 1 from public.portfolio_positions p where p.id = c.id)) x;
  end if;

  if cur.stamp is null or cur.rules_stamp is distinct from rs or changed is null or changed > greatest(500, total / 5) then
    delete from public.portfolio_facts_cache c where c.user_id = u and c.tz = z;
    insert into public.portfolio_facts_cache (user_id, tz, id, platform, platform_label, platform_type, position_type, sport, league, source, event_name, selection, status, result, placed_at, settled_at, event_start_at, placed_day, settled_day, event_day, placed_dow, event_dow, hour_band, lead_seconds, timing_bucket, stake_amt, pnl, ret, entry_dec, entry_price, odds_band, units, units_band, day_units, day_count, session_no, session_order, after_result, decision_source, decision_tags, planned, has_thesis, would_repeat, library, closing_source, model_pre_event, research_pre_event, clv_pct, clv_points, model_ev, price_slip, price_points, s_clv, s_model, s_price, s_sizing, s_timing, s_rules, s_market, process_weight, process_score, grade, rules_applicable, rules_followed, rules_broken, evidence, stake_type, src_position_at, src_journal_at)
    select u, z, f.id, f.platform, f.platform_label, f.platform_type, f.position_type, f.sport, f.league, f.source, f.event_name, f.selection, f.status, f.result, f.placed_at, f.settled_at, f.event_start_at, f.placed_day, f.settled_day, f.event_day, f.placed_dow, f.event_dow, f.hour_band, f.lead_seconds, f.timing_bucket, f.stake_amt, f.pnl, f.ret, f.entry_dec, f.entry_price, f.odds_band, f.units, f.units_band, f.day_units, f.day_count, f.session_no, f.session_order, f.after_result, f.decision_source, f.decision_tags, f.planned, f.has_thesis, f.would_repeat, f.library, f.closing_source, f.model_pre_event, f.research_pre_event, f.clv_pct, f.clv_points, f.model_ev, f.price_slip, f.price_points, f.s_clv, f.s_model, f.s_price, f.s_sizing, f.s_timing, f.s_rules, f.s_market, f.process_weight, f.process_score, f.grade, f.rules_applicable, f.rules_followed, f.rules_broken, f.evidence, f.stake_type, p.updated_at, j.updated_at
      from public.portfolio_facts(null, null, z, null) f
      join public.portfolio_positions p on p.id = f.id
      left join public.portfolio_journal_entries j on j.position_id = f.id;
  elsif changed > 0 then
    /* the core: whole local days from a day before the earliest change to two
       after the latest; computed with a further day either side */
    core_lo := ((date_trunc('day', core_lo at time zone z) - interval '1 day') at time zone z);
    core_hi := ((date_trunc('day', core_hi at time zone z) + interval '3 days') at time zone z);
    lo := ((date_trunc('day', core_lo at time zone z) - interval '1 day') at time zone z);
    hi := ((date_trunc('day', core_hi at time zone z) + interval '1 day') at time zone z);
    delete from public.portfolio_facts_cache c
     where c.user_id = u and c.tz = z
       and ((c.placed_at >= core_lo and c.placed_at < core_hi) or c.id = any (ids));
    insert into public.portfolio_facts_cache (user_id, tz, id, platform, platform_label, platform_type, position_type, sport, league, source, event_name, selection, status, result, placed_at, settled_at, event_start_at, placed_day, settled_day, event_day, placed_dow, event_dow, hour_band, lead_seconds, timing_bucket, stake_amt, pnl, ret, entry_dec, entry_price, odds_band, units, units_band, day_units, day_count, session_no, session_order, after_result, decision_source, decision_tags, planned, has_thesis, would_repeat, library, closing_source, model_pre_event, research_pre_event, clv_pct, clv_points, model_ev, price_slip, price_points, s_clv, s_model, s_price, s_sizing, s_timing, s_rules, s_market, process_weight, process_score, grade, rules_applicable, rules_followed, rules_broken, evidence, stake_type, src_position_at, src_journal_at)
    select u, z, f.id, f.platform, f.platform_label, f.platform_type, f.position_type, f.sport, f.league, f.source, f.event_name, f.selection, f.status, f.result, f.placed_at, f.settled_at, f.event_start_at, f.placed_day, f.settled_day, f.event_day, f.placed_dow, f.event_dow, f.hour_band, f.lead_seconds, f.timing_bucket, f.stake_amt, f.pnl, f.ret, f.entry_dec, f.entry_price, f.odds_band, f.units, f.units_band, f.day_units, f.day_count, f.session_no, f.session_order, f.after_result, f.decision_source, f.decision_tags, f.planned, f.has_thesis, f.would_repeat, f.library, f.closing_source, f.model_pre_event, f.research_pre_event, f.clv_pct, f.clv_points, f.model_ev, f.price_slip, f.price_points, f.s_clv, f.s_model, f.s_price, f.s_sizing, f.s_timing, f.s_rules, f.s_market, f.process_weight, f.process_score, f.grade, f.rules_applicable, f.rules_followed, f.rules_broken, f.evidence, f.stake_type, p.updated_at, j.updated_at
      from public.portfolio_facts(lo, hi, z, null) f
      join public.portfolio_positions p on p.id = f.id
      left join public.portfolio_journal_entries j on j.position_id = f.id
     where f.in_placed and f.placed_at >= core_lo and f.placed_at < core_hi
    on conflict (user_id, tz, id) do nothing;
  end if;
  select count(*) into n from public.portfolio_facts_cache c where c.user_id = u and c.tz = z;
  insert into public.portfolio_facts_cache_state (user_id, tz, stamp, built_at, rows, rules_stamp) values (u, z, st, now(), n, rs)
  on conflict (user_id, tz) do update set stamp = excluded.stamp, built_at = excluded.built_at, rows = excluded.rows, rules_stamp = excluded.rules_stamp;
  return z;
end $$;

-- the cached facts in the shape of portfolio_facts(), for one window
create or replace function public.portfolio_facts_cached(p_from timestamptz, p_to timestamptz, p_tz text, p_platform text default null)
returns table (id uuid, platform text, platform_label text, platform_type text, position_type text, sport text, league text, source text,
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
  with x as (
    select c.*,
           ((p_from is null or c.placed_at >= p_from) and (p_to is null or c.placed_at < p_to)) as in_placed_,
           (c.settled_at is not null and c.status <> 'OPEN' and (p_from is null or c.settled_at >= p_from) and (p_to is null or c.settled_at < p_to)) as in_settled_,
           (c.event_start_at is not null and (p_from is null or c.event_start_at >= p_from) and (p_to is null or c.event_start_at < p_to)) as in_event_
      from public.portfolio_facts_cache c
     where c.user_id = auth.uid() and c.tz = p_tz
       and (p_platform is null or c.platform = p_platform or ('type:' || c.platform_type) = p_platform)
       and (((p_from is null or c.placed_at >= p_from) and (p_to is null or c.placed_at < p_to))
        or (c.settled_at is not null and c.status <> 'OPEN' and (p_from is null or c.settled_at >= p_from) and (p_to is null or c.settled_at < p_to))
        or (c.event_start_at is not null and (p_from is null or c.event_start_at >= p_from) and (p_to is null or c.event_start_at < p_to))))
  select x.id, x.platform, x.platform_label, x.platform_type, x.position_type, x.sport, x.league, x.source, x.event_name, x.selection, x.status, x.result, x.placed_at, x.settled_at, x.event_start_at, x.in_placed_, x.in_settled_, x.in_event_, x.placed_day, x.settled_day, x.event_day, x.placed_dow, x.event_dow, x.hour_band, x.lead_seconds, x.timing_bucket, x.stake_amt, x.pnl, x.ret, x.entry_dec, x.entry_price, x.odds_band, x.units, x.units_band, x.day_units, x.day_count, x.session_no, x.session_order, x.after_result, case when x.in_placed_ then ntile(10) over (partition by x.in_placed_ order by x.placed_at, x.id) end, x.decision_source, x.decision_tags, x.planned, x.has_thesis, x.would_repeat, x.library, x.closing_source, x.model_pre_event, x.research_pre_event, x.clv_pct, x.clv_points, x.model_ev, x.price_slip, x.price_points, x.s_clv, x.s_model, x.s_price, x.s_sizing, x.s_timing, x.s_rules, x.s_market, x.process_weight, x.process_score, x.grade, x.rules_applicable, x.rules_followed, x.rules_broken, x.evidence, x.stake_type
    from x
$$;

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
        'ret_n', count(ret), 'ret_sum', coalesce(sum(ret), 0), 'ret_sq', coalesce(sum(ret * ret), 0)) from st),
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
create or replace function public.portfolio_cells(p_from timestamptz, p_to timestamptz, p_tz text default null, p_platform text default null,
    p_segments boolean default true)
returns table (dim text, key text, n bigint, settled bigint, wins bigint, losses bigint, staked numeric, pnl numeric,
  ret_n bigint, ret_sum numeric, ret_sq numeric, clv_n bigint, clv_sum numeric, clv_sq numeric,
  ps_n bigint, ps_sum numeric, ps_sq numeric, units_n bigint, units_sum numeric, segs jsonb)
language sql volatile
  -- JIT would spend seconds compiling these expressions to save milliseconds,
  -- and a long history sorts in memory rather than on disk
  set jit = off set work_mem = '64MB' as $$
  select public.portfolio_facts_fresh(p_tz);
  with z as materialized (select public.portfolio_tz(p_tz) as tz),
  f as materialized (
    select f.ret, f.pnl, f.stake_amt, f.result, f.clv_pct, f.process_score, f.units, f.decile, f.decision_tags,
           f.platform as k_platform,
           f.platform_type as k_platform_type,
           coalesce(f.sport, 'UNKNOWN') as k_sport,
           coalesce(f.league, 'UNKNOWN') as k_league,
           f.position_type as k_position_type,
           f.source as k_source,
           f.timing_bucket as k_timing,
           f.placed_dow::text as k_placed_dow,
           coalesce(f.event_dow::text, 'UNKNOWN') as k_event_dow,
           f.hour_band as k_hour,
           f.odds_band as k_odds,
           f.units_band as k_units,
           coalesce(f.decision_source, 'UNRECORDED') as k_decision_source,
           case f.planned when true then 'PLANNED' when false then 'UNPLANNED' else 'UNTAGGED' end as k_planned,
           f.after_result as k_after,
           case when f.session_order = 1 then 'FIRST' when f.session_order <= 3 then 'SECOND_THIRD' else 'FOURTH_PLUS' end as k_session,
           coalesce(f.would_repeat, 'UNREVIEWED') as k_repeat,
           f.evidence as k_evidence,
           f.stake_type as k_stake_type,
           coalesce(f.sport, 'UNKNOWN') || ' · ' || f.position_type as k_sport_type,
           f.timing_bucket || ' · ' || f.position_type as k_timing_type,
           f.platform || ' · ' || f.position_type as k_platform_type_pos
      from z, public.portfolio_facts_cached(p_from, p_to, z.tz, p_platform) f where f.in_placed),
  g as (
    select case when grouping(k_platform) = 0 then 'platform' when grouping(k_platform_type) = 0 then 'platform_type' when grouping(k_sport) = 0 then 'sport' when grouping(k_league) = 0 then 'league' when grouping(k_position_type) = 0 then 'position_type' when grouping(k_source) = 0 then 'source' when grouping(k_timing) = 0 then 'timing' when grouping(k_placed_dow) = 0 then 'placed_dow' when grouping(k_event_dow) = 0 then 'event_dow' when grouping(k_hour) = 0 then 'hour' when grouping(k_odds) = 0 then 'odds' when grouping(k_units) = 0 then 'units' when grouping(k_decision_source) = 0 then 'decision_source' when grouping(k_planned) = 0 then 'planned' when grouping(k_after) = 0 then 'after' when grouping(k_session) = 0 then 'session' when grouping(k_repeat) = 0 then 'repeat' when grouping(k_evidence) = 0 then 'evidence' when grouping(k_stake_type) = 0 then 'stake_type' when grouping(k_sport_type) = 0 then 'sport_type' when grouping(k_timing_type) = 0 then 'timing_type' when grouping(k_platform_type_pos) = 0 then 'platform_type_pos' else 'all' end as dim, coalesce(k_platform, k_platform_type, k_sport, k_league, k_position_type, k_source, k_timing, k_placed_dow, k_event_dow, k_hour, k_odds, k_units, k_decision_source, k_planned, k_after, k_session, k_repeat, k_evidence, k_stake_type, k_sport_type, k_timing_type, k_platform_type_pos, 'all') as key,
           count(*), count(ret), count(*) filter (where result = 'WIN'), count(*) filter (where result = 'LOSS'),
         coalesce(sum(stake_amt) filter (where ret is not null), 0), coalesce(sum(pnl) filter (where ret is not null), 0),
         count(ret), coalesce(sum(ret), 0), coalesce(sum(ret * ret), 0),
         count(clv_pct), coalesce(sum(clv_pct), 0), coalesce(sum(clv_pct * clv_pct), 0),
         count(process_score), coalesce(sum(process_score), 0), coalesce(sum(process_score * process_score), 0),
         count(units), coalesce(sum(units), 0),
         case when p_segments then jsonb_build_object(
           'h1', jsonb_build_array(count(ret) filter (where decile <= 5), coalesce(sum(ret) filter (where decile <= 5), 0), coalesce(sum(ret * ret) filter (where decile <= 5), 0),
                                   count(clv_pct) filter (where decile <= 5), coalesce(sum(clv_pct) filter (where decile <= 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile <= 5), 0),
                                   count(process_score) filter (where decile <= 5), coalesce(sum(process_score) filter (where decile <= 5), 0), coalesce(sum(process_score * process_score) filter (where decile <= 5), 0)),
           'h2', jsonb_build_array(count(ret) filter (where decile > 5), coalesce(sum(ret) filter (where decile > 5), 0), coalesce(sum(ret * ret) filter (where decile > 5), 0),
                                   count(clv_pct) filter (where decile > 5), coalesce(sum(clv_pct) filter (where decile > 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 5), 0),
                                   count(process_score) filter (where decile > 5), coalesce(sum(process_score) filter (where decile > 5), 0), coalesce(sum(process_score * process_score) filter (where decile > 5), 0)),
           'ho', jsonb_build_array(count(ret) filter (where decile > 7), coalesce(sum(ret) filter (where decile > 7), 0), coalesce(sum(ret * ret) filter (where decile > 7), 0),
                                   count(clv_pct) filter (where decile > 7), coalesce(sum(clv_pct) filter (where decile > 7), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 7), 0),
                                   count(process_score) filter (where decile > 7), coalesce(sum(process_score) filter (where decile > 7), 0), coalesce(sum(process_score * process_score) filter (where decile > 7), 0))) end
      from f group by grouping sets ((), (k_platform), (k_platform_type), (k_sport), (k_league), (k_position_type), (k_source), (k_timing), (k_placed_dow), (k_event_dow), (k_hour), (k_odds), (k_units), (k_decision_source), (k_planned), (k_after), (k_session), (k_repeat), (k_evidence), (k_stake_type), (k_sport_type), (k_timing_type), (k_platform_type_pos))),
  t as (
    select 'tag'::text as dim, x.tag as key,
           count(*), count(ret), count(*) filter (where result = 'WIN'), count(*) filter (where result = 'LOSS'),
         coalesce(sum(stake_amt) filter (where ret is not null), 0), coalesce(sum(pnl) filter (where ret is not null), 0),
         count(ret), coalesce(sum(ret), 0), coalesce(sum(ret * ret), 0),
         count(clv_pct), coalesce(sum(clv_pct), 0), coalesce(sum(clv_pct * clv_pct), 0),
         count(process_score), coalesce(sum(process_score), 0), coalesce(sum(process_score * process_score), 0),
         count(units), coalesce(sum(units), 0),
         case when p_segments then jsonb_build_object(
           'h1', jsonb_build_array(count(ret) filter (where decile <= 5), coalesce(sum(ret) filter (where decile <= 5), 0), coalesce(sum(ret * ret) filter (where decile <= 5), 0),
                                   count(clv_pct) filter (where decile <= 5), coalesce(sum(clv_pct) filter (where decile <= 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile <= 5), 0),
                                   count(process_score) filter (where decile <= 5), coalesce(sum(process_score) filter (where decile <= 5), 0), coalesce(sum(process_score * process_score) filter (where decile <= 5), 0)),
           'h2', jsonb_build_array(count(ret) filter (where decile > 5), coalesce(sum(ret) filter (where decile > 5), 0), coalesce(sum(ret * ret) filter (where decile > 5), 0),
                                   count(clv_pct) filter (where decile > 5), coalesce(sum(clv_pct) filter (where decile > 5), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 5), 0),
                                   count(process_score) filter (where decile > 5), coalesce(sum(process_score) filter (where decile > 5), 0), coalesce(sum(process_score * process_score) filter (where decile > 5), 0)),
           'ho', jsonb_build_array(count(ret) filter (where decile > 7), coalesce(sum(ret) filter (where decile > 7), 0), coalesce(sum(ret * ret) filter (where decile > 7), 0),
                                   count(clv_pct) filter (where decile > 7), coalesce(sum(clv_pct) filter (where decile > 7), 0), coalesce(sum(clv_pct * clv_pct) filter (where decile > 7), 0),
                                   count(process_score) filter (where decile > 7), coalesce(sum(process_score) filter (where decile > 7), 0), coalesce(sum(process_score * process_score) filter (where decile > 7), 0))) end
      from (select f.*, tg.tag from f cross join lateral unnest(coalesce(f.decision_tags, array['UNTAGGED']::text[])) tg(tag)) x
     group by x.tag)
  select * from g union all select * from t
$$;

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
create policy portfolio_facts_cache_own on public.portfolio_facts_cache for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_facts_cache_state_own on public.portfolio_facts_cache_state;
create policy portfolio_facts_cache_state_own on public.portfolio_facts_cache_state for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.portfolio_facts_cache, public.portfolio_facts_cache_state from anon, authenticated;
grant select, insert, delete on public.portfolio_facts_cache to authenticated;
grant select, insert, update on public.portfolio_facts_cache_state to authenticated;
grant select, insert, update, delete on public.portfolio_facts_cache, public.portfolio_facts_cache_state to service_role;
-- re-running this file changes the arithmetic the cache was built with
delete from public.portfolio_facts_cache_state;

revoke all on public.portfolio_journal_entries, public.portfolio_rules, public.portfolio_experiments from anon;
revoke all on public.portfolio_journal_entries from authenticated;
grant select, insert, update on public.portfolio_journal_entries to authenticated;
grant select, insert, update, delete on public.portfolio_rules, public.portfolio_experiments to authenticated;
grant select, insert, update, delete on public.portfolio_journal_entries, public.portfolio_rules, public.portfolio_experiments to service_role;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname like 'portfolio\_%' and p.proname not like 'portfolio\_svc\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the journal, rules and experiments tables exist' as item,
    case when (select count(*) from pg_tables where schemaname = 'public'
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments')) = 3 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'row level security is on for all three',
    case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments')) = 3 then 'ok' else 'CHECK THIS — RLS is off' end
  union all select 3, 'every reader policy is keyed to auth.uid()',
    case when (select count(*) from pg_policies where schemaname = 'public'
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments', 'portfolio_facts_cache', 'portfolio_facts_cache_state')
      and coalesce(qual, with_check) like '%user_id = auth.uid()%') = 13 then 'ok' else 'CHECK THIS — a policy is missing or not owner-scoped' end
  union all select 4, 'anon can read nothing and call nothing',
    case when not has_table_privilege('anon', 'public.portfolio_journal_entries', 'select') and not has_table_privilege('anon', 'public.portfolio_rules', 'select')
      and not has_function_privilege('anon', 'public.portfolio_summary(timestamptz,timestamptz,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_cells(timestamptz,timestamptz,text,text,boolean)', 'execute') then 'ok' else 'CHECK THIS — anon holds a privilege' end
  union all select 5, 'a recorded decision cannot be rewritten (the journal guard is installed)',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_journal_guard_trg' and not tgisinternal)
      and exists (select 1 from pg_trigger where tgname = 'portfolio_positions_journal_ins_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select 6, 'every position has its journal entry',
    case when not exists (select 1 from public.portfolio_positions p where not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id))
      then 'ok' else 'CHECK THIS — run this file again' end
  union all select 7, 'the grade never reads profit or loss (the analytics run as the caller)',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('portfolio_facts', 'portfolio_summary', 'portfolio_cells', 'portfolio_calendar', 'portfolio_periods', 'portfolio_list', 'portfolio_pre_bet')
      and p.prosecdef) and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('portfolio_facts', 'portfolio_summary', 'portfolio_cells', 'portfolio_calendar', 'portfolio_periods', 'portfolio_list', 'portfolio_pre_bet')) = 7
      then 'ok' else 'CHECK THIS — an analytics function is missing or runs as its owner' end
  union all select 8, 'the grade arithmetic: CLV 80 alone grades 80 (A-); a sizing score alone is not a grade',
    case when public.portfolio_process_score(80, null, null, null, null, null, null) = 80 and public.portfolio_grade_letter(80) = 'A-'
      and public.portfolio_process_score(null, null, null, 100, null, null, 80) is null
      and public.portfolio_process_score(70, 60, null, null, null, null, 80) = round((30 * 70 + 20 * 60 + 5 * 80) / 55.0, 1) then 'ok' else 'CHECK THIS' end
  union all select 9, 'CLV: −110 taken, −120 at the close is +4.13% of price; 40¢ taken, 50¢ at the close is +25%',
    case when public.portfolio_clv_pct('SPORTSBOOK', public.portfolio_american_to_decimal(-110), public.portfolio_american_to_decimal(-120)) = 0.041323
      and public.portfolio_clv_pct('PREDICTION_MARKET', 0.40, 0.50) = 0.25 then 'ok' else 'CHECK THIS' end
) r order by 1;
