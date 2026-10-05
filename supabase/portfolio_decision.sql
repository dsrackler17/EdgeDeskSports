-- =============================================================================
-- portfolio_decision.sql — THE DECISION RECORD: what a reader knew, saw and
-- planned at the moment of a decision, kept exactly as it was, and everything
-- learned from it afterwards — over supabase/portfolio.sql and
-- supabase/portfolio_journal.sql. docs/decision-record.md is the methodology.
--
-- WHAT THIS ADDS (and what it reuses)
--   The journal (portfolio_journal_entries) already keeps the DECISION and
--   CLOSE blocks write-once, field by field, and the grade (portfolio_facts)
--   already reads them. This file does not duplicate either. It adds:
--
--   portfolio_methodology          every published method (process score,
--                                  edge capture, context quality, outcome
--                                  class, baseline, insight and experiment
--                                  tests), its version and its recalculation
--                                  rule. A version, once published, is never
--                                  edited.
--   portfolio_decision_snapshots   IMMUTABLE. One per position, taken when the
--                                  reader records it, before the event:
--                                  EdgeDesk's state (model and its versions,
--                                  probability, fair price, decision), the
--                                  market's state (best price, consensus,
--                                  range, per-book prices, capture time and
--                                  its freshness) and the reader's state
--                                  (unit, caps, the day's exposure, rules and
--                                  experiments in force) — the last computed
--                                  HERE, never taken from the client. Never
--                                  updated, by anyone. A snapshot after the
--                                  fact is refused.
--   portfolio_market_path          APPEND-ONLY. The prices observed between
--                                  the decision and the close, each with its
--                                  source and whether its time was observed
--                                  or only recorded. Written by the database
--                                  (from the snapshot, the journal and the
--                                  service's legitimate feeds), never typed.
--   portfolio_reflections          APPEND-ONLY. Every version of the reader's
--                                  review, stamped with whether the result
--                                  was known when it was written.
--   portfolio_outcome_classes      APPEND-ONLY. GOOD_WIN / BAD_WIN / GOOD_LOSS
--                                  / BAD_LOSS, from the PROCESS grade and the
--                                  result together — never from the result
--                                  alone. A new row only when the inputs or
--                                  the methodology change; old rows stay.
--   portfolio_baselines            The reader's first 30 graded positions,
--                                  frozen once reached: what change is
--                                  measured against.
--   portfolio_insights,
--   portfolio_insight_observations PROCESS MEMORY. When a pattern was first
--                                  detected, what it was then, what it is now
--                                  — the numbers and the exact positions
--                                  behind each observation (lineage), computed
--                                  here.
--   portfolio_experiments          (journal file) gains its success criteria,
--                                  a baseline frozen at the start, a result
--                                  and conclusion written once, and the
--                                  reader's reflection written once.
--   portfolio_card_events          APPEND-ONLY. What happened to a Card entry:
--                                  added, research viewed, considered,
--                                  recorded, removed. A skipped entry is never
--                                  a position.
--
--   and the reader's doors: portfolio_decision_record (the canonical record
--   of one position), portfolio_search, portfolio_export (everything, as
--   data), portfolio_delete_everything, plus the operator's aggregate-only
--   portfolio_admin_moat_metrics.
--
-- THE RULES, ENFORCED HERE
--   1. A snapshot, a path point, a reflection, an outcome class, a frozen
--      baseline, an observation and a concluded experiment are never
--      rewritten. A methodology change writes NEW rows beside the old.
--   2. Nothing EdgeDesk did not observe is invented: no snapshot after the
--      fact, no back-filled reasoning for imported history, no closing price
--      without a source, no time presented as observed when it was only
--      recorded.
--   3. Every derived row is computed by the database from the reader's own
--      data (functions run AS THE CALLER, so row level security applies);
--      the tables that hold them take writes only from those functions.
--   4. Private. Every table is owner-only. Nothing here is shared across
--      readers; the operator's metrics are counts over at least 5 readers.
--
-- Run AFTER supabase/portfolio.sql, supabase/portfolio_journal.sql and
-- supabase/portfolio_connect.sql. Idempotent, additive, ends in a report.
-- Paste-sized: supabase/parts/portfolio_decision.part*-of-*.sql
-- (npm run portfolio:parts).
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_journal_entries') is null then
    raise exception 'portfolio_decision: run supabase/portfolio.sql and supabase/portfolio_journal.sql first';
  end if;
  if to_regprocedure('public.portfolio_is_admin()') is null then
    raise exception 'portfolio_decision: run supabase/portfolio_connect.sql first';
  end if;
end $$;

-- Re-running on a live site: the triggers added to the journal, positions and
-- experiments tables are re-created below. Take them together, without
-- waiting while holding any (the same block as portfolio_journal.sql).
do $lock$
declare tries int := 0; tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into tables from pg_tables
   where schemaname = 'public' and tablename in ('portfolio_positions', 'portfolio_journal_entries', 'portfolio_experiments',
         'portfolio_decision_snapshots', 'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes');
  loop
    begin
      execute 'lock table ' || tables || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      tries := tries + 1;
      if tries > 300 then
        raise exception 'portfolio_decision: the tables stayed busy for a minute; run this file again when traffic is quieter';
      end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end $lock$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. METHODOLOGY — every method, versioned, with its recalculation rule
--    LIVE    derived on read from the recorded inputs: a new version applies
--            to all history at once, and every output names the version that
--            produced it.
--    APPEND  a persisted conclusion keeps the version it was made under; a
--            new version writes new rows beside the old, never over them.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_methodology (
  version         text        primary key,
  component       text        not null,
  effective_from  timestamptz not null default now(),
  summary         text        not null,
  recalc_rule     text        not null,
  supersedes      text        null references public.portfolio_methodology (version),
  created_at      timestamptz not null default now(),
  constraint portfolio_methodology_component check (component in ('PROCESS_SCORE', 'SNAPSHOT', 'CONTEXT_QUALITY', 'EDGE_CAPTURE',
    'OUTCOME_CLASS', 'BASELINE', 'INSIGHT_TEST', 'EXPERIMENT_TEST')),
  constraint portfolio_methodology_rule check (recalc_rule in ('LIVE', 'APPEND')),
  constraint portfolio_methodology_text check (version ~ '^[a-z][a-z0-9_]{2,40}$' and length(summary) between 10 and 2000)
);
comment on table public.portfolio_methodology is
  'Every published method behind the Decision Record, its version and its recalculation rule (LIVE: recomputed on read; APPEND: persisted rows keep their version). Never edited once published.';

create or replace function public.portfolio_methodology_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'portfolio: a published methodology is never edited (%); publish a new version that supersedes it', old.version
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'portfolio: a published methodology is never deleted (%)', old.version using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists portfolio_methodology_guard_trg on public.portfolio_methodology;
create trigger portfolio_methodology_guard_trg before update or delete on public.portfolio_methodology
  for each row execute function public.portfolio_methodology_guard();

insert into public.portfolio_methodology (version, component, effective_from, summary, recalc_rule) values
  ('process_v1', 'PROCESS_SCORE', '2026-09-01T00:00:00Z',
   'Seven components, each 0-100 or unavailable: closing line value 30, model edge at entry 20, price quality 15, sizing 15, timing 10, rule adherence 5, market structure 5, renormalized over the components that exist. Graded only with a price-based component and at least 30 points of weight. Bands: GOOD >= 66, AVERAGE 45-66, POOR < 45. Profit and loss are not an input.', 'LIVE'),
  ('snapshot_v1', 'SNAPSHOT', '2026-10-05T00:00:00Z',
   'One immutable snapshot per position, taken when it is recorded and before the event: EdgeDesk state (model, versions, probability, fair price, decision) and market state (best price, consensus, range, per-book prices, capture time and freshness) as the client observed them, and the reader''s state (unit, caps, the day''s exposure, rules and experiments in force) computed by the server. Refused after the event or more than 6 hours after the position was placed.', 'APPEND'),
  ('context_quality_v1', 'CONTEXT_QUALITY', '2026-10-05T00:00:00Z',
   'FULL: a pre-event snapshot with both EdgeDesk''s model state and a market price. STRONG: pre-event decision context with a price reference (a snapshot with one of the two, or journal reasoning plus a research or opening price recorded before the event). PARTIAL: pre-event reasoning without a price reference, or market context (a close, an opening price, an observed path) without pre-event reasoning. RESULT_ONLY: the wager and its result.', 'LIVE'),
  ('edge_capture_v1', 'EDGE_CAPTURE', '2026-10-05T00:00:00Z',
   'Edge at decision = model probability x decision price - 1 (contract: probability / price - 1); edge at entry = the same at the entry price; capture = entry edge / decision edge when the decision edge is positive. Slip and CLV in % of price at an unchanged line, in points when the line moved (never converted to probability). American odds convert to decimal exactly; implied probabilities include the book margin. Not computed for parlays or live entries.', 'LIVE'),
  ('outcome_class_v1', 'OUTCOME_CLASS', '2026-10-05T00:00:00Z',
   'For a settled WIN or LOSS with a process grade: GOOD (score >= 66) or POOR (< 45) process crossed with the result gives GOOD_WIN, GOOD_LOSS, BAD_WIN, BAD_LOSS; 45-66 is AVERAGE_PROCESS. No grade: NOT_CLASSIFIED. Never from the result alone. A new row is written only when the graded inputs change.', 'APPEND'),
  ('baseline_v1', 'BASELINE', '2026-10-05T00:00:00Z',
   'The reader''s first 30 graded positions by time placed, frozen when the 30th is graded: process score, CLV and return moments with the exact positions. Change is measured as the most recent graded positions after the baseline against it, by Welch''s test; fewer than 10 new graded positions is INSUFFICIENT_NEW_EVIDENCE.', 'APPEND'),
  ('insight_v1', 'INSIGHT_TEST', '2026-10-05T00:00:00Z',
   'A pattern is the group (dimension and key) against every other position placed in the same window, on CLV, process score or return. Each observation stores the group and comparison moments, the positions used and those excluded with the reason. Status compares positions placed after first detection against those before it (Welch, 95%): IMPROVING or DECLINED when the interval excludes zero, UNCHANGED otherwise, INSUFFICIENT_NEW_EVIDENCE below 10 new positions.', 'APPEND'),
  ('experiment_v1', 'EXPERIMENT_TEST', '2026-10-05T00:00:00Z',
   'The pre-registered metric over positions placed in the window against the same length of time before it (Welch, 95%). SUPPORTED when the interval is above zero, NOT_SUPPORTED when below (or the window ended with no improvement), INCONCLUSIVE otherwise or when either side has fewer positions than the pre-registered minimum.', 'APPEND')
on conflict (version) do nothing;

create or replace function public.portfolio_methodology_current(p_component text)
returns text language sql stable as $$
  select m.version from public.portfolio_methodology m
   where m.component = p_component and m.effective_from <= now()
   order by m.effective_from desc, m.version desc limit 1
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VOCABULARY — pure functions, mirrored in lib/edgedesk_decision.js
--    (tools/portfolio/decision_sql.test.js holds the two in parity)
-- ─────────────────────────────────────────────────────────────────────────────
-- how old a captured price was at a moment: lib/edgedesk_market.js
-- freshness() thresholds (fresh <= 30 min, aging <= 90 min, a capture more
-- than 5 minutes in the future is a clock fault)
create or replace function public.portfolio_freshness(p_captured timestamptz, p_at timestamptz)
returns text language sql immutable as $$
  select case when p_captured is null or p_at is null then 'UNKNOWN'
              when p_captured > p_at + interval '5 minutes' then 'FUTURE'
              when p_captured >= p_at - interval '30 minutes' then 'FRESH'
              when p_captured >= p_at - interval '90 minutes' then 'AGING'
              else 'STALE' end
$$;

-- what EdgeDesk actually knows about a decision (context_quality_v1)
create or replace function public.portfolio_context_quality(p_snapshot_pre boolean, p_snapshot_model boolean, p_snapshot_market boolean,
    p_decision_pre boolean, p_price_ref_pre boolean, p_market_ctx boolean)
returns text language sql immutable as $$
  select case when coalesce(p_snapshot_pre, false) and coalesce(p_snapshot_model, false) and coalesce(p_snapshot_market, false) then 'FULL'
              when (coalesce(p_snapshot_pre, false) and (coalesce(p_snapshot_model, false) or coalesce(p_snapshot_market, false)))
                or (coalesce(p_decision_pre, false) and coalesce(p_price_ref_pre, false)) then 'STRONG'
              when coalesce(p_decision_pre, false) or coalesce(p_snapshot_pre, false) or coalesce(p_market_ctx, false) then 'PARTIAL'
              else 'RESULT_ONLY' end
$$;

-- process and result together, never the result alone (outcome_class_v1)
create or replace function public.portfolio_outcome_class(p_status text, p_result text, p_score numeric, p_quality text)
returns text language sql immutable as $$
  select case when p_status is null or p_status = 'OPEN' then 'OPEN'
              when p_result is null or p_result not in ('WIN', 'LOSS') then 'NOT_APPLICABLE'
              when p_score is null or coalesce(p_quality, 'RESULT_ONLY') = 'RESULT_ONLY' then 'NOT_CLASSIFIED'
              when p_score >= 66 then case p_result when 'WIN' then 'GOOD_WIN' else 'GOOD_LOSS' end
              when p_score < 45 then case p_result when 'WIN' then 'BAD_WIN' else 'BAD_LOSS' end
              else 'AVERAGE_PROCESS' end
$$;

-- EDGE CAPTURE (edge_capture_v1). Prices are decimal odds for a sportsbook
-- and contract prices (0-1) for a prediction market; the reference is the
-- decision-time price (the snapshot's, else the journal's research price).
-- Every number is + when it favours the reader. What cannot be computed is
-- null, with the reason in "limitations".
create or replace function public.portfolio_edge_capture(p_platform_type text, p_position_type text, p_dir text, p_lead bigint,
    p_entry numeric, p_entry_line numeric, p_ref numeric, p_ref_line numeric, p_close numeric, p_close_line numeric, p_prob numeric)
returns jsonb language plpgsql immutable as $$
declare
  pm boolean := p_platform_type = 'PREDICTION_MARKET';
  lim text[] := array[]::text[];
  basis text; ref_same boolean; close_same boolean;
  e_dec numeric; e_ent numeric; cap numeric; slip numeric; slip_pts numeric; clv numeric; clv_pts numeric;
begin
  if p_position_type in ('PARLAY', 'SAME_GAME_PARLAY') then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('PARLAY_NOT_DECOMPOSED'));
  end if;
  if p_entry is null then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('NO_ENTRY_PRICE'));
  end if;
  if p_lead is not null and p_lead <= 0 then
    return jsonb_build_object('methodology', 'edge_capture_v1', 'basis', 'NONE', 'limitations', jsonb_build_array('LIVE_ENTRY'));
  end if;
  /* a price recorded without a line is at the entry's line (the journal's
     convention: a line has moved only when both lines are known and differ) */
  ref_same := p_ref is not null and (p_ref_line is null or p_entry_line is null or p_ref_line = p_entry_line);
  close_same := p_close is not null and (p_close_line is null or p_entry_line is null or p_close_line = p_entry_line);
  basis := case when pm then 'CONTRACT'
                when (p_ref is not null and not ref_same) or (p_close is not null and not close_same) then 'POINTS'
                else 'PRICE' end;
  if ref_same then e_dec := public.portfolio_model_ev(p_platform_type, p_prob, p_ref); end if;
  e_ent := public.portfolio_model_ev(p_platform_type, p_prob, p_entry);
  if e_dec is not null and e_dec > 0 and e_ent is not null then cap := public.portfolio_div_round(e_ent, e_dec, 4); end if;
  if ref_same then slip := public.portfolio_price_slip(p_platform_type, p_entry, p_ref);
  elsif p_ref is not null then slip_pts := public.portfolio_line_gain(p_dir, p_entry_line, p_ref_line); end if;
  if close_same then clv := public.portfolio_clv_pct(p_platform_type, p_entry, p_close);
  elsif p_close is not null then clv_pts := public.portfolio_line_gain(p_dir, p_entry_line, p_close_line); end if;
  if p_prob is null then lim := lim || 'NO_MODEL_PROBABILITY'::text; end if;
  if p_ref is null then lim := lim || 'NO_DECISION_PRICE'::text; end if;
  if p_close is null then lim := lim || 'NO_CLOSE'::text; end if;
  if pm then lim := lim || 'CONTRACT_PRICE_IS_PROBABILITY'::text; else lim := lim || 'IMPLIED_PROBABILITY_INCLUDES_MARGIN'::text; end if;
  if basis = 'POINTS' then lim := lim || 'POINTS_NOT_CONVERTED_TO_PROBABILITY'::text; end if;
  if p_position_type = 'PLAYER_PROP' then lim := lim || 'PROP_MARKET_THIN'::text; end if;
  return jsonb_strip_nulls(jsonb_build_object('methodology', 'edge_capture_v1', 'basis', basis,
    'edge_at_decision', e_dec, 'edge_at_entry', e_ent, 'capture_ratio', cap,
    'slip_pct', slip, 'slip_points', slip_pts, 'clv_pct', clv, 'clv_points', clv_pts)) || jsonb_build_object('limitations', to_jsonb(lim));
end $$;

-- typed reads of a client document: a value of the wrong type or out of
-- range is dropped, never coerced
create or replace function public.portfolio_j_num(j jsonb, k text, lo numeric, hi numeric)
returns numeric language sql immutable as $$
  select case when jsonb_typeof(j->k) = 'number' and (j->>k)::numeric between lo and hi then (j->>k)::numeric
              when jsonb_typeof(j->k) = 'string' and (j->>k) ~ '^[+-]?[0-9]+(\.[0-9]+)?$' and (j->>k)::numeric between lo and hi then (j->>k)::numeric end
$$;
create or replace function public.portfolio_j_text(j jsonb, k text, maxlen int)
returns text language sql immutable as $$
  select case when jsonb_typeof(j->k) = 'string' and length(btrim(j->>k)) between 1 and maxlen then btrim(j->>k) end
$$;
create or replace function public.portfolio_j_ts(j jsonb, k text)
returns timestamptz language sql stable as $$
  select case when jsonb_typeof(j->k) = 'string' then public.portfolio_try_timestamptz(j->>k) end
$$;
create or replace function public.portfolio_j_american(j jsonb, k text)
returns int language sql immutable as $$
  select case when x is not null and x = trunc(x) and (x <= -100 or x >= 100) and abs(x) <= 1000000 then x::int end
    from (select public.portfolio_j_num(j, k, -1000000, 1000000) as x) q
$$;

-- what EdgeDesk's research said, as the client observed it: listed keys only
create or replace function public.portfolio_snapshot_edgedesk(j jsonb)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'model_version', public.portfolio_j_text(j, 'model_version', 60),
    'calibration_version', public.portfolio_j_text(j, 'calibration_version', 60),
    'pricing_version', public.portfolio_j_text(j, 'pricing_version', 60),
    'engine', public.portfolio_j_text(j, 'engine', 60),
    'research_id', public.portfolio_j_text(j, 'research_id', 120),
    'probability', public.portfolio_j_num(j, 'probability', 0.000001, 0.999999),
    'probability_source', public.portfolio_j_text(j, 'probability_source', 40),
    'fair_odds_decimal', public.portfolio_j_num(j, 'fair_odds_decimal', 1.000001, 10001),
    'fair_line', public.portfolio_j_num(j, 'fair_line', -1000, 1000),
    'ev', public.portfolio_j_num(j, 'ev', -1, 100),
    'edge_pp', public.portfolio_j_num(j, 'edge_pp', -100, 100),
    'confidence', public.portfolio_j_num(j, 'confidence', 0, 100),
    'decision', case when j->>'decision' in ('BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION') then j->>'decision' end,
    'stage', public.portfolio_j_text(j, 'stage', 40),
    'evaluated_at', public.portfolio_j_ts(j, 'evaluated_at')))
$$;
-- the market as the client observed it, each price with its capture time
create or replace function public.portfolio_snapshot_market(j jsonb)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'captured_at', public.portfolio_j_ts(j, 'captured_at'),
    'source', public.portfolio_j_text(j, 'source', 60),
    'sig_key', public.portfolio_j_text(j, 'sig_key', 200),
    'book', public.portfolio_j_text(j, 'book', 60),
    'odds_american', public.portfolio_j_american(j, 'odds_american'),
    'odds_decimal', coalesce(public.portfolio_american_to_decimal(public.portfolio_j_american(j, 'odds_american')),
                             public.portfolio_j_num(j, 'odds_decimal', 1.000001, 10001)),
    'price', public.portfolio_j_num(j, 'price', 0.000001, 0.999999),
    'line', public.portfolio_j_num(j, 'line', -1000, 1000),
    'consensus_decimal', public.portfolio_j_num(j, 'consensus_decimal', 1.000001, 10001),
    'consensus_probability', public.portfolio_j_num(j, 'consensus_probability', 0.000001, 0.999999),
    'consensus_line', public.portfolio_j_num(j, 'consensus_line', -1000, 1000),
    'n_books', public.portfolio_j_num(j, 'n_books', 0, 200)::int,
    'range_min_decimal', public.portfolio_j_num(j, 'range_min_decimal', 1.000001, 10001),
    'range_max_decimal', public.portfolio_j_num(j, 'range_max_decimal', 1.000001, 10001),
    'range_min_line', public.portfolio_j_num(j, 'range_min_line', -1000, 1000),
    'range_max_line', public.portfolio_j_num(j, 'range_max_line', -1000, 1000),
    'books', (select jsonb_agg(b) from (
        select jsonb_strip_nulls(jsonb_build_object('book', public.portfolio_j_text(x, 'book', 60),
                 'odds_american', public.portfolio_j_american(x, 'odds_american'),
                 'odds_decimal', coalesce(public.portfolio_american_to_decimal(public.portfolio_j_american(x, 'odds_american')),
                                          public.portfolio_j_num(x, 'odds_decimal', 1.000001, 10001)),
                 'line', public.portfolio_j_num(x, 'line', -1000, 1000), 'captured_at', public.portfolio_j_ts(x, 'captured_at'))) as b
          from jsonb_array_elements(case when jsonb_typeof(j->'books') = 'array' then j->'books' else '[]'::jsonb end) with ordinality e(x, i)
         where jsonb_typeof(x) = 'object' and public.portfolio_j_text(x, 'book', 60) is not null and i <= 30) q)))
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DECISION SNAPSHOTS — immutable, one per position, before the event
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_decision_snapshots (
  position_id       uuid        primary key,
  user_id           uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  origin            text        not null,
  origin_ref        text        null,
  saved_at          timestamptz null,
  recorded_at       timestamptz not null default now(),
  snapshot_version  text        not null default 'snapshot_v1',
  edgedesk          jsonb       not null default '{}'::jsonb,
  market            jsonb       not null default '{}'::jsonb,
  user_state        jsonb       not null default '{}'::jsonb,
  market_freshness  text        not null default 'UNKNOWN',
  content_hash      text        not null default '',
  constraint portfolio_snapshot_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_snapshot_origin check (origin in ('CARD', 'RESEARCH', 'MANUAL')),
  constraint portfolio_snapshot_text check (coalesce(length(origin_ref), 0) <= 120),
  constraint portfolio_snapshot_json check (jsonb_typeof(edgedesk) = 'object' and jsonb_typeof(market) = 'object'
    and jsonb_typeof(user_state) = 'object' and pg_column_size(edgedesk) + pg_column_size(market) + pg_column_size(user_state) <= 32768),
  constraint portfolio_snapshot_freshness check (market_freshness in ('FRESH', 'AGING', 'STALE', 'FUTURE', 'UNKNOWN'))
);
comment on table public.portfolio_decision_snapshots is
  'IMMUTABLE. What EdgeDesk, the market and the reader''s own state were when a position was recorded, before the event. Never updated by anyone; goes only with its position.';
create index if not exists portfolio_snapshots_user on public.portfolio_decision_snapshots (user_id, recorded_at desc);

-- the reader's own state at the decision, computed here from their records
create or replace function public.portfolio_user_state(p_user uuid, p_position uuid, p_placed timestamptz)
returns jsonb language plpgsql stable as $$
declare u record; day_n int; day_cost numeric; r jsonb; x jsonb;
begin
  select * into u from public.portfolio_unit_snapshot(p_user);
  select count(*), coalesce(sum(p.cost_basis), 0) into day_n, day_cost from public.portfolio_positions p
   where p.user_id = p_user and p.id <> p_position and p.placed_at <= p_placed and p.placed_at > p_placed - interval '24 hours';
  select coalesce(jsonb_agg(jsonb_build_object('id', r0.id, 'kind', r0.kind, 'label', r0.label) order by r0.label), '[]'::jsonb) into r
    from public.portfolio_rules r0 where r0.user_id = p_user and r0.active_from <= p_placed and (r0.active_until is null or r0.active_until > p_placed);
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'metric', e.metric, 'ends_at', e.ends_at) order by e.starts_at), '[]'::jsonb) into x
    from public.portfolio_experiments e where e.user_id = p_user and e.status = 'ACTIVE' and e.starts_at <= p_placed and e.ends_at > p_placed;
  return jsonb_strip_nulls(jsonb_build_object('unit', u.unit, 'bankroll', u.bankroll, 'max_single_units', u.max_single, 'max_daily_units', u.max_daily,
    'prior_24h_positions', day_n, 'prior_24h_cost', day_cost,
    'prior_24h_units', case when u.unit > 0 then round(day_cost / u.unit, 4) end,
    'rules', r, 'experiments', x));
end $$;

create or replace function public.portfolio_snapshot_guard() returns trigger
language plpgsql as $$
declare p record; reader boolean := auth.uid() is not null;
begin
  if tg_op = 'UPDATE' then
    raise exception 'portfolio: a decision snapshot is never rewritten' using errcode = '42501',
      hint = 'It records what was known when the position was entered. Add a review note instead.';
  end if;
  if reader then new.user_id := auth.uid(); end if;
  new.recorded_at := now();
  new.snapshot_version := 'snapshot_v1';
  select id, user_id, placed_at, event_start_at, status into p from public.portfolio_positions where id = new.position_id and user_id = new.user_id;
  if not found then raise exception 'portfolio: no such position' using errcode = 'P0002'; end if;
  /* a snapshot is the moment of the decision, not a reconstruction */
  if p.status <> 'OPEN' or (p.event_start_at is not null and new.recorded_at >= p.event_start_at)
     or new.recorded_at > p.placed_at + interval '6 hours' then
    raise exception 'portfolio: a decision snapshot is taken when the position is recorded, before the event — not after the fact'
      using errcode = '22023';
  end if;
  new.origin := upper(coalesce(new.origin, 'MANUAL'));
  new.origin_ref := nullif(btrim(new.origin_ref), '');
  if new.saved_at is not null and (new.saved_at > new.recorded_at + interval '5 minutes' or new.saved_at < new.recorded_at - interval '400 days') then
    new.saved_at := null;
  end if;
  new.edgedesk := public.portfolio_snapshot_edgedesk(coalesce(new.edgedesk, '{}'::jsonb));
  new.market := public.portfolio_snapshot_market(coalesce(new.market, '{}'::jsonb));
  new.user_state := public.portfolio_user_state(new.user_id, new.position_id, p.placed_at);
  new.market_freshness := public.portfolio_freshness((new.market->>'captured_at')::timestamptz, new.recorded_at);
  new.content_hash := public.portfolio_sha256(jsonb_build_object('position_id', new.position_id, 'origin', new.origin, 'origin_ref', new.origin_ref,
    'saved_at', new.saved_at, 'recorded_at', new.recorded_at, 'version', new.snapshot_version, 'edgedesk', new.edgedesk,
    'market', new.market, 'user_state', new.user_state)::text);
  return new;
end $$;
drop trigger if exists portfolio_snapshot_guard_trg on public.portfolio_decision_snapshots;
create trigger portfolio_snapshot_guard_trg before insert or update on public.portfolio_decision_snapshots
  for each row execute function public.portfolio_snapshot_guard();

-- the snapshot fills the journal's DECISION block where it is still empty
-- (the journal stays write-once: nothing recorded is replaced), puts the
-- decision and entry prices on the market path, and marks the Card entry
-- recorded. Runs as the caller (the journal's own guard applies).
create or replace function public.portfolio_snapshot_after() returns trigger
language plpgsql as $$
declare e jsonb := new.edgedesk; m jsonb := new.market; cap timestamptz := (new.market->>'captured_at')::timestamptz;
begin
  update public.portfolio_journal_entries j set
         decision_source = coalesce(j.decision_source, case when new.origin in ('CARD', 'RESEARCH') then 'EDGEDESK' else 'USER' end),
         model_version = coalesce(j.model_version, e->>'model_version'),
         model_probability = coalesce(j.model_probability, (e->>'probability')::numeric),
         model_fair_line = coalesce(j.model_fair_line, (e->>'fair_line')::numeric),
         model_fair_odds_decimal = coalesce(j.model_fair_odds_decimal, (e->>'fair_odds_decimal')::numeric),
         research_odds_american = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                                       then coalesce(j.research_odds_american, (m->>'odds_american')::int) else j.research_odds_american end,
         research_odds_decimal = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                                      then coalesce(j.research_odds_decimal, (m->>'odds_decimal')::numeric) else j.research_odds_decimal end,
         research_price = case when coalesce(j.research_odds_decimal, j.research_price) is null and cap is not null and cap <= new.recorded_at
                               then coalesce(j.research_price, (m->>'price')::numeric) else j.research_price end,
         research_line = case when j.research_line is null and cap is not null and cap <= new.recorded_at then (m->>'line')::numeric else j.research_line end,
         research_at = case when j.research_at is null and cap is not null and cap <= new.recorded_at and coalesce(m->>'odds_decimal', m->>'price') is not null
                            then cap else j.research_at end
   where j.position_id = new.position_id;
  perform public.portfolio_path_from_snapshot(new.position_id);
  if new.origin = 'CARD' and new.origin_ref is not null then
    perform public.portfolio_card_recorded(new.user_id, new.origin_ref, new.position_id, e->>'decision');
  end if;
  return null;
end $$;
drop trigger if exists portfolio_snapshot_after_trg on public.portfolio_decision_snapshots;
create trigger portfolio_snapshot_after_trg after insert on public.portfolio_decision_snapshots
  for each row execute function public.portfolio_snapshot_after();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE MARKET PATH — append-only; written by the database, never typed
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_market_path (
  id            bigint      generated always as identity primary key,
  position_id   uuid        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  kind          text        not null,
  observed_at   timestamptz not null,
  time_basis    text        not null,
  source        text        not null,
  book          text        null,
  odds_decimal  numeric     null,
  price         numeric     null,
  line          numeric     null,
  recorded_at   timestamptz not null default now(),
  constraint portfolio_path_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_path_kind check (kind in ('OPEN', 'DECISION', 'RESEARCH', 'ENTRY', 'QUOTE', 'CLOSE')),
  constraint portfolio_path_time check (time_basis in ('OBSERVED', 'RECORDED')),
  constraint portfolio_path_source check (source in ('EDGEDESK_SNAPSHOT', 'USER', 'PLATFORM', 'EDGEDESK_CAPTURE', 'book_quote_ticks')),
  constraint portfolio_path_values check ((odds_decimal is null or (odds_decimal > 1 and odds_decimal <= 10001))
    and (price is null or price between 0 and 1) and (line is null or abs(line) <= 1000)
    and coalesce(odds_decimal, price, line) is not null and coalesce(length(book), 0) <= 60)
);
comment on table public.portfolio_market_path is
  'APPEND-ONLY. Prices observed for a position between the decision and the close, each with its source and whether its time was OBSERVED (a capture time) or only RECORDED (when EdgeDesk learned it). Written by the database from the snapshot, the journal and legitimate feeds; never typed by a reader.';
create unique index if not exists portfolio_path_once
  on public.portfolio_market_path (position_id, kind, source, observed_at, coalesce(book, ''));
create index if not exists portfolio_path_user on public.portfolio_market_path (user_id, position_id, observed_at);

create or replace function public.portfolio_path_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: a market path point is never rewritten' using errcode = '42501';
end $$;
drop trigger if exists portfolio_path_guard_trg on public.portfolio_market_path;
create trigger portfolio_path_guard_trg before update on public.portfolio_market_path
  for each row execute function public.portfolio_path_guard();

-- the decision price (the snapshot's market, at its capture time) and the
-- entry price (the position's own, at its placed time)
create or replace function public.portfolio_path_from_snapshot(p_position uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; p record;
begin
  select * into s from public.portfolio_decision_snapshots where position_id = p_position;
  select * into p from public.portfolio_positions where id = p_position;
  /* a reader reaches this only for their own position */
  if p.id is null or (auth.uid() is not null and p.user_id <> auth.uid()) then return; end if;
  if s.position_id is not null and s.user_id = p.user_id and (s.market->>'captured_at') is not null
     and coalesce(s.market->>'odds_decimal', s.market->>'price', s.market->>'line') is not null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'DECISION', (s.market->>'captured_at')::timestamptz, 'OBSERVED', 'EDGEDESK_SNAPSHOT', s.market->>'book',
            (s.market->>'odds_decimal')::numeric, (s.market->>'price')::numeric, (s.market->>'line')::numeric)
    on conflict do nothing;
  end if;
  if coalesce(p.odds_decimal, p.average_entry_price, p.line) is not null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'ENTRY', p.placed_at, 'OBSERVED', case when p.source = 'SYNC' then 'PLATFORM' else 'USER' end, p.platform,
            case when p.platform_type = 'SPORTSBOOK' then p.odds_decimal end,
            case when p.platform_type = 'PREDICTION_MARKET' then p.average_entry_price end, p.line)
    on conflict do nothing;
  end if;
end $$;

-- the journal's opening, research and closing prices, as they are recorded.
-- An opening or closing price typed by a reader has no observation time: it
-- is stamped with when it was RECORDED and says so.
create or replace function public.portfolio_path_from_journal() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record; o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
  select id, user_id, platform, platform_type, line into p from public.portfolio_positions where id = new.position_id;
  if p.id is null then return null; end if;
  if coalesce(new.opening_odds_decimal, new.opening_price, new.opening_line) is not null
     and coalesce(o->>'opening_odds_decimal', o->>'opening_price', o->>'opening_line') is null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, odds_decimal, price, line)
    values (p.id, p.user_id, 'OPEN', coalesce(new.decision_recorded_at, now()), 'RECORDED', 'USER',
            case when p.platform_type = 'SPORTSBOOK' then new.opening_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.opening_price end,
            new.opening_line)
    on conflict do nothing;
  end if;
  /* a researched price that IS the snapshot's (filled from it, same capture
     time) is already on the path as the decision price: not listed twice */
  if coalesce(new.research_odds_decimal, new.research_price, new.research_line) is not null
     and coalesce(o->>'research_odds_decimal', o->>'research_price', o->>'research_line') is null
     and not exists (select 1 from public.portfolio_decision_snapshots s where s.position_id = p.id
                       and (s.market->>'captured_at')::timestamptz is not distinct from new.research_at) then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, odds_decimal, price, line)
    values (p.id, p.user_id, 'RESEARCH', coalesce(new.research_at, new.research_recorded_at, now()),
            case when new.research_at is not null then 'OBSERVED' else 'RECORDED' end,
            'USER',
            case when p.platform_type = 'SPORTSBOOK' then new.research_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.research_price end,
            new.research_line)
    on conflict do nothing;
  end if;
  if coalesce(new.closing_odds_decimal, new.closing_price, new.closing_line) is not null
     and coalesce(o->>'closing_odds_decimal', o->>'closing_price', o->>'closing_line') is null then
    insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, price, line)
    values (p.id, p.user_id, 'CLOSE', coalesce(new.closing_recorded_at, now()), 'RECORDED', coalesce(new.closing_source, 'USER'), new.closing_book,
            case when p.platform_type = 'SPORTSBOOK' then new.closing_odds_decimal end, case when p.platform_type = 'PREDICTION_MARKET' then new.closing_price end,
            new.closing_line)
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists portfolio_journal_path_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_path_trg after insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_path_from_journal();

-- THE FEED. For a position whose snapshot names an exact capture key
-- (signals.sig_key — the same event, market, side and line), the book's own
-- price history from book_quote_ticks: every tick at the book the reader used
-- between the decision and the start, and — when the journal has no close —
-- the last tick at or before the start, no more than 6 hours before it, as
-- an EDGEDESK_CAPTURE close. Nothing is matched by name or guessed; a
-- position without an exact key gets no feed points. The service role only.
create or replace function public.portfolio_svc_attach_feed_path(p_limit int default 200)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r record; t record; n_pos int := 0; n_pts int := 0; n_close int := 0; k int;
begin
  perform public.portfolio_svc_assert();
  if to_regclass('public.book_quote_ticks') is null then return jsonb_build_object('feed', false); end if;
  for r in
    select p.id, p.user_id, p.platform, p.line, p.event_start_at, s.market->>'sig_key' as sig_key, s.recorded_at,
           coalesce(s.saved_at, s.recorded_at) as since, (s.market->>'line')::numeric as snap_line, j.closing_odds_decimal
      from public.portfolio_decision_snapshots s
      join public.portfolio_positions p on p.id = s.position_id
      join public.portfolio_journal_entries j on j.position_id = p.id
     where p.platform_type = 'SPORTSBOOK' and s.market ? 'sig_key' and p.event_start_at is not null
       and p.position_type not in ('PARLAY', 'SAME_GAME_PARLAY')
       and p.event_start_at > now() - interval '3 days'
       and p.line is not distinct from (s.market->>'line')::numeric
     order by p.event_start_at limit greatest(1, least(coalesce(p_limit, 200), 2000))
  loop
    n_pos := n_pos + 1;
    execute 'insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, line)
             select $1, $2, ''QUOTE'', t.seen_at, ''OBSERVED'', ''book_quote_ticks'', t.book_key, t.dec, $3
               from public.book_quote_ticks t
              where t.sig_key = $4 and t.book_key = $5 and t.dec > 1 and t.dec <= 10001
                and t.seen_at >= $6 - interval ''1 hour'' and t.seen_at <= $7
             on conflict do nothing'
      using r.id, r.user_id, r.line, r.sig_key, r.platform, r.since, r.event_start_at;
    get diagnostics k = row_count; n_pts := n_pts + k;
    if r.closing_odds_decimal is null and r.event_start_at <= now() then
      execute 'select t.dec, t.seen_at from public.book_quote_ticks t
                where t.sig_key = $1 and t.book_key = $2 and t.dec > 1 and t.dec <= 10001 and t.seen_at <= $3
                order by t.seen_at desc limit 1' into t using r.sig_key, r.platform, r.event_start_at;
      if t.dec is not null and t.seen_at >= r.event_start_at - interval '6 hours' then
        update public.portfolio_journal_entries set closing_odds_decimal = t.dec, closing_line = r.line, closing_source = 'EDGEDESK_CAPTURE',
               closing_book = r.platform
         where position_id = r.id and closing_odds_decimal is null and closing_price is null;
        get diagnostics k = row_count;
        if k > 0 then
          n_close := n_close + 1;
          insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, book, odds_decimal, line)
          values (r.id, r.user_id, 'CLOSE', t.seen_at, 'OBSERVED', 'book_quote_ticks', r.platform, t.dec, r.line) on conflict do nothing;
        end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('feed', true, 'positions', n_pos, 'points', n_pts, 'closes', n_close);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REFLECTIONS — every version of the review, append-only
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_reflections (
  id            bigint      generated always as identity primary key,
  position_id   uuid        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  written_at    timestamptz not null default now(),
  would_repeat  text        null,
  review_note   text        null,
  library       text        null,
  result_known  boolean     not null,
  result        text        null,
  constraint portfolio_reflections_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade
);
comment on table public.portfolio_reflections is
  'APPEND-ONLY. Every version of the reader''s review of a position, stamped with whether the result was known when it was written. The journal''s REVIEW block is the latest; this is the history.';
create index if not exists portfolio_reflections_position on public.portfolio_reflections (user_id, position_id, written_at);

create or replace function public.portfolio_reflections_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: a reflection, once written, is never rewritten' using errcode = '42501';
end $$;
drop trigger if exists portfolio_reflections_guard_trg on public.portfolio_reflections;
create trigger portfolio_reflections_guard_trg before update on public.portfolio_reflections
  for each row execute function public.portfolio_reflections_guard();

create or replace function public.portfolio_reflection_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare st text; res text;
begin
  if tg_op = 'UPDATE' and (new.would_repeat, new.review_note, new.library) is not distinct from (old.would_repeat, old.review_note, old.library) then
    return null;
  end if;
  if tg_op = 'INSERT' and coalesce(new.would_repeat, new.review_note, new.library) is null then return null; end if;
  select status, result into st, res from public.portfolio_positions where id = new.position_id;
  insert into public.portfolio_reflections (position_id, user_id, written_at, would_repeat, review_note, library, result_known, result)
  values (new.position_id, new.user_id, coalesce(new.reviewed_at, now()), new.would_repeat, new.review_note, new.library,
          coalesce(st, 'OPEN') <> 'OPEN', case when coalesce(st, 'OPEN') <> 'OPEN' then res end);
  return null;
end $$;
drop trigger if exists portfolio_journal_reflection_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_reflection_trg after insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_reflection_log();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CONTEXT, PER POSITION — the inputs every later section reads
-- ─────────────────────────────────────────────────────────────────────────────
-- for each of the caller's cached facts: its context quality and the edge
-- capture inputs (decision price: the snapshot's, else the journal's
-- research price recorded before the event)
create or replace function public.portfolio_context(p_tz text)
returns table (id uuid, quality text, snapshot_pre boolean, snapshot_model boolean, snapshot_market boolean, decision_pre boolean,
  price_ref_pre boolean, market_ctx boolean, origin text, origin_ref text, saved_at timestamptz, recorded_at timestamptz,
  ref_price numeric, ref_line numeric, close_price numeric, close_line numeric, prob numeric, entry_line numeric, ou text)
language sql stable as $$
  select c.id,
         public.portfolio_context_quality(x.snapshot_pre, x.snapshot_model, x.snapshot_market, x.decision_pre, x.price_ref_pre, x.market_ctx),
         x.snapshot_pre, x.snapshot_model, x.snapshot_market, x.decision_pre, x.price_ref_pre, x.market_ctx,
         s.origin, s.origin_ref, s.saved_at, s.recorded_at,
         case when c.platform_type = 'PREDICTION_MARKET' then coalesce((s.market->>'price')::numeric, case when c.research_pre_event then j.research_price end)
              else coalesce((s.market->>'odds_decimal')::numeric, case when c.research_pre_event then j.research_odds_decimal end) end,
         case when s.market ? 'odds_decimal' or s.market ? 'price' then (s.market->>'line')::numeric when c.research_pre_event then j.research_line end,
         case when c.platform_type = 'PREDICTION_MARKET' then j.closing_price else j.closing_odds_decimal end,
         j.closing_line,
         case when c.model_pre_event then j.model_probability
              when x.snapshot_pre then (s.edgedesk->>'probability')::numeric end,
         p.line, public.portfolio_ou_direction(p.selection, p.side)
    from public.portfolio_facts_cache c
    join public.portfolio_positions p on p.id = c.id
    left join public.portfolio_journal_entries j on j.position_id = c.id
    left join public.portfolio_decision_snapshots s on s.position_id = c.id
    cross join lateral (select
           (s.position_id is not null and s.recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as snapshot_pre,
           (s.edgedesk ? 'probability' or s.edgedesk ? 'fair_odds_decimal' or s.edgedesk ? 'fair_line') as snapshot_model,
           (s.market ? 'odds_decimal' or s.market ? 'price') as snapshot_market,
           (j.decision_recorded_at is not null and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as decision_pre,
           (coalesce(c.research_pre_event, false)
             or (coalesce(j.opening_odds_decimal, j.opening_price) is not null and j.decision_recorded_at is not null
                 and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz)))) as price_ref_pre,
           (coalesce(j.closing_odds_decimal, j.closing_price, j.closing_line, j.opening_odds_decimal, j.opening_price, j.opening_line) is not null
             or exists (select 1 from public.portfolio_market_path mp where mp.position_id = c.id and mp.source in ('EDGEDESK_CAPTURE', 'book_quote_ticks', 'PLATFORM')
                          and mp.kind <> 'ENTRY')) as market_ctx) x
   where c.user_id = auth.uid() and c.tz = public.portfolio_tz(p_tz)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. OUTCOME CLASSES — process and result together, persisted, append-only
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_outcome_classes (
  id                   bigint      generated always as identity primary key,
  position_id          uuid        not null,
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  classified_at        timestamptz not null default now(),
  methodology_version  text        not null,
  process_methodology  text        not null,
  tz                   text        not null,
  class                text        not null,
  result               text        null,
  process_score        numeric     null,
  grade                text        null,
  context_quality      text        not null,
  components           jsonb       not null default '{}'::jsonb,
  inputs_hash          text        not null,
  constraint portfolio_outcome_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_outcome_class check (class in ('GOOD_WIN', 'GOOD_LOSS', 'BAD_WIN', 'BAD_LOSS', 'AVERAGE_PROCESS', 'NOT_CLASSIFIED', 'NOT_APPLICABLE')),
  constraint portfolio_outcome_quality check (context_quality in ('FULL', 'STRONG', 'PARTIAL', 'RESULT_ONLY'))
);
comment on table public.portfolio_outcome_classes is
  'APPEND-ONLY. GOOD_WIN / GOOD_LOSS / BAD_WIN / BAD_LOSS from the process grade and the result together, never the result alone. A new row only when the graded inputs or the methodology change; the latest row is current, earlier rows are history.';
create unique index if not exists portfolio_outcome_once on public.portfolio_outcome_classes (position_id, methodology_version, inputs_hash);
create index if not exists portfolio_outcome_user on public.portfolio_outcome_classes (user_id, position_id, classified_at desc);

-- the derived tables take writes only from their own functions: each sets a
-- transaction-local marker that a request through the API cannot set
create or replace function public.portfolio_writer_is(p_writer text)
returns boolean language sql stable as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin') or coalesce(current_setting('portfolio.writer', true), '') = p_writer
$$;

create or replace function public.portfolio_outcome_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'portfolio: an outcome classification is never rewritten; a changed grade writes a new one' using errcode = '42501';
  end if;
  if not public.portfolio_writer_is('classify') then
    raise exception 'portfolio: outcome classes are computed by portfolio_classify_outcomes(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.classified_at := now();
  return new;
end $$;
drop trigger if exists portfolio_outcome_guard_trg on public.portfolio_outcome_classes;
create trigger portfolio_outcome_guard_trg before insert or update on public.portfolio_outcome_classes
  for each row execute function public.portfolio_outcome_guard();

-- classify every settled position of the caller whose graded inputs have no
-- row yet under the current methodology; returns how many were written
create or replace function public.portfolio_classify_outcomes(p_tz text default null)
returns int language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); n int; mv text := public.portfolio_methodology_current('OUTCOME_CLASS');
  pv text := public.portfolio_methodology_current('PROCESS_SCORE');
begin
  if auth.uid() is null then return 0; end if;
  perform set_config('portfolio.writer', 'classify', true);
  insert into public.portfolio_outcome_classes (position_id, user_id, methodology_version, process_methodology, tz, class, result, process_score,
      grade, context_quality, components, inputs_hash)
  select q.id, auth.uid(), mv, pv, z, q.cls, q.result, q.process_score, q.grade, q.quality, q.comp,
         public.portfolio_sha256(concat_ws('|', mv, pv, q.cls, q.result, q.process_score::text, q.quality, q.comp::text))
    from (select c.id, c.result, c.process_score, c.grade, x.quality,
                 public.portfolio_outcome_class(c.status, c.result, c.process_score, x.quality) as cls,
                 jsonb_strip_nulls(jsonb_build_object('clv', c.s_clv, 'model', c.s_model, 'price', c.s_price, 'sizing', c.s_sizing,
                   'timing', c.s_timing, 'rules', c.s_rules, 'market', c.s_market)) as comp
            from public.portfolio_facts_cached(null, null, z, null) c
            join public.portfolio_context(z) x on x.id = c.id
           where c.status <> 'OPEN') q
   where not exists (select 1 from public.portfolio_outcome_classes o
                      where o.position_id = q.id and o.methodology_version = mv
                        and o.inputs_hash = public.portfolio_sha256(concat_ws('|', mv, pv, q.cls, q.result, q.process_score::text, q.quality, q.comp::text)))
  on conflict do nothing;
  get diagnostics n = row_count;
  perform set_config('portfolio.writer', '', true);
  return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. THE PERSONAL BASELINE — the first 30 graded positions, frozen once
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_baselines (
  user_id              uuid        not null references auth.users(id) on delete cascade,
  methodology_version  text        not null,
  frozen_at            timestamptz not null default now(),
  tz                   text        not null,
  n                    int         not null,
  first_placed         timestamptz not null,
  last_placed          timestamptz not null,
  position_ids         uuid[]      not null,
  moments              jsonb       not null,
  primary key (user_id, methodology_version)
);
comment on table public.portfolio_baselines is
  'The reader''s first graded positions (baseline_v1: 30), frozen once reached. What later process change is measured against. Never rewritten.';

create or replace function public.portfolio_baseline_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'portfolio: a frozen baseline is never rewritten' using errcode = '42501'; end if;
  if not public.portfolio_writer_is('baseline') then
    raise exception 'portfolio: the baseline is computed by portfolio_baseline(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.frozen_at := now();
  return new;
end $$;
drop trigger if exists portfolio_baseline_guard_trg on public.portfolio_baselines;
create trigger portfolio_baseline_guard_trg before insert or update on public.portfolio_baselines
  for each row execute function public.portfolio_baseline_guard();

-- moments (n, sum, sum of squares) of the three metrics over a set of facts
create or replace function public.portfolio_moments(p_ids uuid[], p_tz text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'ps', jsonb_build_array(count(c.process_score), coalesce(sum(c.process_score), 0), coalesce(sum(c.process_score * c.process_score), 0)),
    'clv', jsonb_build_array(count(c.clv_pct), coalesce(sum(c.clv_pct), 0), coalesce(sum(c.clv_pct * c.clv_pct), 0)),
    'ret', jsonb_build_array(count(c.ret), coalesce(sum(c.ret), 0), coalesce(sum(c.ret * c.ret), 0)))
    from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = p_tz and c.id = any (p_ids)
$$;

-- the baseline, frozen the first time 30 graded positions exist; before that
-- a provisional one (status BUILDING) that is not stored. With it, the most
-- recent graded positions placed after it (up to 30): the comparison the
-- page tests with Welch's test (lib/edgedesk_decision.js changeStatus).
create or replace function public.portfolio_baseline(p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); mv text := public.portfolio_methodology_current('BASELINE'); b record; ids uuid[];
  recent uuid[]; n int; need int := 30;
begin
  if auth.uid() is null then return null; end if;
  select * into b from public.portfolio_baselines where user_id = auth.uid() and methodology_version = mv;
  if b.user_id is null then
    select array_agg(id order by placed_at, id) into ids from (
      select c.id, c.placed_at from public.portfolio_facts_cache c
       where c.user_id = auth.uid() and c.tz = z and c.process_score is not null order by c.placed_at, c.id limit need) q;
    n := coalesce(array_length(ids, 1), 0);
    if n < need then
      return jsonb_build_object('status', 'BUILDING', 'methodology', mv, 'n', n, 'needed', need - n,
        'moments', case when n > 0 then public.portfolio_moments(ids, z) end);
    end if;
    perform set_config('portfolio.writer', 'baseline', true);
    insert into public.portfolio_baselines (user_id, methodology_version, tz, n, first_placed, last_placed, position_ids, moments)
    select auth.uid(), mv, z, n, min(c.placed_at), max(c.placed_at), ids, public.portfolio_moments(ids, z)
      from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (ids)
    on conflict do nothing;
    perform set_config('portfolio.writer', '', true);
    select * into b from public.portfolio_baselines where user_id = auth.uid() and methodology_version = mv;
  end if;
  select array_agg(id) into recent from (
    select c.id from public.portfolio_facts_cache c
     where c.user_id = auth.uid() and c.tz = z and c.process_score is not null and c.placed_at > b.last_placed
       and not (c.id = any (b.position_ids))
     order by c.placed_at desc, c.id desc limit 30) q;
  return jsonb_build_object('status', 'FROZEN', 'methodology', mv, 'frozen_at', b.frozen_at, 'n', b.n, 'first_placed', b.first_placed,
    'last_placed', b.last_placed, 'moments', b.moments,
    'recent', jsonb_build_object('n', coalesce(array_length(recent, 1), 0),
      'moments', case when recent is not null then public.portfolio_moments(recent, z) end,
      'from', (select min(c.placed_at) from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (recent)),
      'to', (select max(c.placed_at) from public.portfolio_facts_cache c where c.user_id = auth.uid() and c.tz = z and c.id = any (recent))));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. PROCESS MEMORY — patterns, when first detected, then and now
-- ─────────────────────────────────────────────────────────────────────────────
-- the key a cached fact takes in a breakdown dimension: the same expressions
-- as portfolio_cells(), held equal by test
create or replace function public.portfolio_fact_key(p_dim text, c public.portfolio_facts_cache)
returns text language sql immutable as $$
  select case p_dim
    when 'all' then 'all'
    when 'platform' then c.platform
    when 'platform_type' then c.platform_type
    when 'sport' then coalesce(c.sport, 'UNKNOWN')
    when 'league' then coalesce(c.league, 'UNKNOWN')
    when 'position_type' then c.position_type
    when 'source' then c.source
    when 'timing' then c.timing_bucket
    when 'placed_dow' then c.placed_dow::text
    when 'event_dow' then coalesce(c.event_dow::text, 'UNKNOWN')
    when 'hour' then c.hour_band
    when 'odds' then c.odds_band
    when 'units' then c.units_band
    when 'decision_source' then coalesce(c.decision_source, 'UNRECORDED')
    when 'planned' then case c.planned when true then 'PLANNED' when false then 'UNPLANNED' else 'UNTAGGED' end
    when 'after' then c.after_result
    when 'session' then case when c.session_order = 1 then 'FIRST' when c.session_order <= 3 then 'SECOND_THIRD' else 'FOURTH_PLUS' end
    when 'repeat' then coalesce(c.would_repeat, 'UNREVIEWED')
    when 'evidence' then c.evidence
    when 'stake_type' then c.stake_type
    when 'sport_type' then coalesce(c.sport, 'UNKNOWN') || ' · ' || c.position_type
    when 'timing_type' then c.timing_bucket || ' · ' || c.position_type
    when 'platform_type_pos' then c.platform || ' · ' || c.position_type
  end
$$;
create or replace function public.portfolio_fact_in(p_dim text, p_key text, c public.portfolio_facts_cache)
returns boolean language sql immutable as $$
  select case when p_dim = 'tag' then p_key = any (coalesce(c.decision_tags, array['UNTAGGED']::text[]))
              else public.portfolio_fact_key(p_dim, c) = p_key end
$$;

create table if not exists public.portfolio_insights (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  dim                  text        not null,
  key                  text        not null,
  metric               text        not null,
  kind                 text        not null,
  label                text        not null,
  methodology_version  text        not null,
  first_detected_at    timestamptz not null default now(),
  constraint portfolio_insights_shape check (metric in ('clv', 'ps', 'ret') and kind in ('LEAK', 'STRENGTH')
    and dim ~ '^[a-z_]{2,30}$' and length(key) between 1 and 120 and length(label) between 1 and 200)
);
comment on table public.portfolio_insights is
  'PROCESS MEMORY. A pattern in the reader''s own history (a group on a metric), when it was first detected and under which methodology. Its observations carry the numbers and the positions behind them.';
create unique index if not exists portfolio_insights_once on public.portfolio_insights (user_id, dim, key, metric, methodology_version);

create table if not exists public.portfolio_insight_observations (
  id                   bigint      generated always as identity primary key,
  insight_id           uuid        not null references public.portfolio_insights(id) on delete cascade,
  user_id              uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  observed_at          timestamptz not null default now(),
  methodology_version  text        not null,
  tz                   text        not null,
  window_from          timestamptz null,
  window_to            timestamptz null,
  grp                  jsonb       not null,
  comparison           jsonb       not null,
  since_first          jsonb       not null,
  before_first         jsonb       not null,
  confidence           text        not null,
  position_ids         uuid[]      not null,
  position_count       int         not null,
  excluded             jsonb       not null default '{}'::jsonb
);
comment on table public.portfolio_insight_observations is
  'APPEND-ONLY. One look at a pattern: the group and comparison moments, the same group split at first detection, the exact positions used (lineage) and those excluded with the reason. Computed by portfolio_observe_insight().';
create index if not exists portfolio_insight_obs on public.portfolio_insight_observations (insight_id, observed_at desc);

create or replace function public.portfolio_insight_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'portfolio_insight_observations' then
    raise exception 'portfolio: an observation is never rewritten' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    /* a pattern's identity and first detection are fixed */
    new.id := old.id; new.user_id := old.user_id; new.dim := old.dim; new.key := old.key; new.metric := old.metric; new.kind := old.kind;
    new.methodology_version := old.methodology_version; new.first_detected_at := old.first_detected_at;
    return new;
  end if;
  if not public.portfolio_writer_is('insight') then
    raise exception 'portfolio: process memory is computed by portfolio_observe_insight(), not written' using errcode = '42501';
  end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists portfolio_insights_guard_trg on public.portfolio_insights;
create trigger portfolio_insights_guard_trg before insert or update on public.portfolio_insights
  for each row execute function public.portfolio_insight_guard();
drop trigger if exists portfolio_insight_obs_guard_trg on public.portfolio_insight_observations;
create trigger portfolio_insight_obs_guard_trg before insert or update on public.portfolio_insight_observations
  for each row execute function public.portfolio_insight_guard();

-- record one look at a pattern the Process page surfaced. The page names the
-- group and the window; every number and every position is computed here.
-- A look whose numbers have not changed within 12 hours is not stored twice.
create or replace function public.portfolio_observe_insight(p_dim text, p_key text, p_metric text, p_kind text, p_label text,
    p_from timestamptz, p_to timestamptz, p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); mv text := public.portfolio_methodology_current('INSIGHT_TEST');
  ins record; g jsonb; cmp jsonb; sf jsonb; bf jsonb; ids uuid[]; excl jsonb; last record; col text;
begin
  if auth.uid() is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  if p_metric not in ('clv', 'ps', 'ret') or p_kind not in ('LEAK', 'STRENGTH') or p_dim !~ '^[a-z_]{2,30}$' or coalesce(length(p_key), 0) not between 1 and 120 then
    raise exception 'portfolio: not a pattern this methodology tests' using errcode = '22023';
  end if;
  perform set_config('portfolio.writer', 'insight', true);
  insert into public.portfolio_insights (user_id, dim, key, metric, kind, label, methodology_version)
  values (auth.uid(), p_dim, p_key, p_metric, p_kind, left(coalesce(nullif(btrim(p_label), ''), p_dim || ': ' || p_key), 200), mv)
  on conflict (user_id, dim, key, metric, methodology_version) do nothing;
  select * into ins from public.portfolio_insights i where i.user_id = auth.uid() and i.dim = p_dim and i.key = p_key and i.metric = p_metric
     and i.methodology_version = mv;
  col := case p_metric when 'clv' then 'clv_pct' when 'ps' then 'process_score' else 'ret' end;
  execute format($q$
    with f as (select c.*, c.%1$I as v, public.portfolio_fact_in($1, $2, c) as in_grp from public.portfolio_facts_cache c
                where c.user_id = auth.uid() and c.tz = $3 and ($4::timestamptz is null or c.placed_at >= $4) and ($5::timestamptz is null or c.placed_at < $5))
    select jsonb_build_array(count(v) filter (where in_grp), coalesce(sum(v) filter (where in_grp), 0), coalesce(sum(v * v) filter (where in_grp), 0)),
           jsonb_build_array(count(v) filter (where not in_grp), coalesce(sum(v) filter (where not in_grp), 0), coalesce(sum(v * v) filter (where not in_grp), 0)),
           jsonb_build_array(count(v) filter (where in_grp and placed_at >= $6), coalesce(sum(v) filter (where in_grp and placed_at >= $6), 0),
                             coalesce(sum(v * v) filter (where in_grp and placed_at >= $6), 0)),
           jsonb_build_array(count(v) filter (where in_grp and placed_at < $6), coalesce(sum(v) filter (where in_grp and placed_at < $6), 0),
                             coalesce(sum(v * v) filter (where in_grp and placed_at < $6), 0)),
           (select array_agg(id order by placed_at, id) from (select id, placed_at from f where in_grp and v is not null order by placed_at, id limit 1000) q),
           jsonb_strip_nulls(jsonb_build_object(
             'NO_CLOSING_PRICE', nullif(count(*) filter (where in_grp and v is null and $7 = 'clv' and clv_points is null), 0),
             'LINE_MOVED_CLV_IN_POINTS', nullif(count(*) filter (where in_grp and v is null and $7 = 'clv' and clv_points is not null), 0),
             'NOT_GRADED', nullif(count(*) filter (where in_grp and v is null and $7 = 'ps'), 0),
             'NOT_SETTLED', nullif(count(*) filter (where in_grp and v is null and $7 = 'ret' and status = 'OPEN'), 0),
             'NO_RETURN', nullif(count(*) filter (where in_grp and v is null and $7 = 'ret' and status <> 'OPEN'), 0)))
      from f $q$, col)
    into g, cmp, sf, bf, ids, excl using p_dim, p_key, z, p_from, p_to, ins.first_detected_at, p_metric;
  select * into last from public.portfolio_insight_observations o where o.insight_id = ins.id order by o.observed_at desc limit 1;
  if last.id is not null and last.observed_at > now() - interval '12 hours' and last.grp = g and last.comparison = cmp
     and last.window_from is not distinct from p_from and last.window_to is not distinct from p_to then
    perform set_config('portfolio.writer', '', true);
    return jsonb_build_object('insight', to_jsonb(ins), 'observation', to_jsonb(last), 'stored', false);
  end if;
  insert into public.portfolio_insight_observations (insight_id, user_id, methodology_version, tz, window_from, window_to, grp, comparison,
      since_first, before_first, confidence, position_ids, position_count, excluded)
  values (ins.id, auth.uid(), mv, z, p_from, p_to, g, cmp, sf, bf, public.portfolio_confidence((g->>0)::bigint), coalesce(ids, array[]::uuid[]),
          (g->>0)::int, coalesce(excl, '{}'::jsonb))
  returning * into last;
  perform set_config('portfolio.writer', '', true);
  return jsonb_build_object('insight', to_jsonb(ins), 'observation', to_jsonb(last), 'stored', true);
end $$;

-- every pattern the caller has, with its first observation (THEN) and its
-- latest (NOW); the status is computed from these by the page
create or replace function public.portfolio_insight_memory()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('insight', to_jsonb(i), 'first', to_jsonb(f), 'latest', to_jsonb(l), 'observations', k.n)
           order by l.observed_at desc), '[]'::jsonb)
    from public.portfolio_insights i
    cross join lateral (select o.* from public.portfolio_insight_observations o where o.insight_id = i.id order by o.observed_at asc limit 1) f
    cross join lateral (select o.* from public.portfolio_insight_observations o where o.insight_id = i.id order by o.observed_at desc limit 1) l
    cross join lateral (select count(*) as n from public.portfolio_insight_observations o where o.insight_id = i.id) k
   where i.user_id = auth.uid()
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. EXPERIMENTS — a permanent record: criteria and baseline frozen at the
--     start, the result and conclusion written once, the reflection once
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_experiments add column if not exists success_criteria text null;
alter table public.portfolio_experiments add column if not exists tz text null;
alter table public.portfolio_experiments add column if not exists baseline jsonb null;
alter table public.portfolio_experiments add column if not exists result jsonb null;
alter table public.portfolio_experiments add column if not exists conclusion text null;
alter table public.portfolio_experiments add column if not exists concluded_at timestamptz null;
alter table public.portfolio_experiments add column if not exists result_methodology text null;
alter table public.portfolio_experiments add column if not exists reflection text null;
alter table public.portfolio_experiments add column if not exists reflected_at timestamptz null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'portfolio_experiments_record') then
    alter table public.portfolio_experiments add constraint portfolio_experiments_record check (
      coalesce(length(success_criteria), 0) <= 300 and coalesce(length(reflection), 0) <= 1000
      and (conclusion is null or conclusion in ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE'))
      and (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536))
      and (baseline is null or jsonb_typeof(baseline) = 'object'));
  end if;
end $$;

-- the metric's moments over the positions placed in a window, the positions
-- themselves, and how many followed the experiment's condition
create or replace function public.portfolio_experiment_window(p_metric text, p_condition jsonb, p_from timestamptz, p_to timestamptz, p_tz text)
returns jsonb language sql stable as $$
  with f as (select c as r, c.id, c.placed_at, case p_metric when 'CLV' then c.clv_pct when 'PROCESS' then c.process_score else c.ret end as v
               from public.portfolio_facts_cache c
              where c.user_id = auth.uid() and c.tz = p_tz and c.placed_at >= p_from and c.placed_at < p_to)
  select jsonb_build_object('from', p_from, 'to', p_to, 'positions', count(*),
    'moments', jsonb_build_array(count(v), coalesce(sum(v), 0), coalesce(sum(v * v), 0)),
    'followed', case when p_condition ? 'dim' and p_condition ? 'key'
                     then count(*) filter (where public.portfolio_fact_in(p_condition->>'dim', p_condition->>'key', f.r)) end,
    'position_ids', coalesce((select jsonb_agg(id order by placed_at, id) from (select id, placed_at from f where v is not null order by placed_at, id limit 1000) q), '[]'::jsonb))
    from f
$$;

create or replace function public.portfolio_experiments_record_guard() returns trigger
language plpgsql as $$
declare len interval; z text;
begin
  if tg_op = 'INSERT' then
    new.success_criteria := nullif(btrim(new.success_criteria), '');
    new.result := null; new.conclusion := null; new.concluded_at := null; new.result_methodology := null;
    new.reflection := null; new.reflected_at := null;
    z := public.portfolio_tz(new.tz); new.tz := z;
    /* the baseline the experiment will be judged against, frozen now: the
       same length of time just before it starts */
    if auth.uid() is not null then
      perform public.portfolio_facts_fresh(z);
      len := new.ends_at - new.starts_at;
      new.baseline := public.portfolio_experiment_window(new.metric, new.condition, new.starts_at - len, new.starts_at, z)
                      || jsonb_build_object('frozen_at', now(), 'methodology', public.portfolio_methodology_current('EXPERIMENT_TEST'));
    else
      new.baseline := null;
    end if;
    return new;
  end if;
  new.success_criteria := old.success_criteria; new.baseline := old.baseline; new.tz := old.tz;
  if old.conclusion is not null or not public.portfolio_writer_is('experiment') then
    new.result := old.result; new.conclusion := old.conclusion; new.concluded_at := old.concluded_at; new.result_methodology := old.result_methodology;
  end if;
  /* the reflection is written once, after the experiment has ended */
  if old.reflection is not null or new.status = 'ACTIVE' then
    new.reflection := old.reflection; new.reflected_at := old.reflected_at;
  elsif new.reflection is distinct from old.reflection then
    new.reflection := nullif(btrim(new.reflection), ''); new.reflected_at := case when new.reflection is not null then now() end;
  end if;
  return new;
end $$;
drop trigger if exists portfolio_experiments_record_trg on public.portfolio_experiments;
create trigger portfolio_experiments_record_trg before insert or update on public.portfolio_experiments
  for each row execute function public.portfolio_experiments_record_guard();

-- the evidence an experiment is judged on: the window and the frozen
-- baseline, computed here. The page runs the pre-registered test on exactly
-- these moments (lib/edgedesk_portfolio_process.js evaluateExperiment).
create or replace function public.portfolio_experiment_evidence(p_id uuid)
returns jsonb language plpgsql volatile set jit = off as $$
declare e record; z text; w jsonb;
begin
  select * into e from public.portfolio_experiments where id = p_id and user_id = auth.uid();
  if not found then raise exception 'portfolio: no such experiment' using errcode = 'P0002'; end if;
  z := public.portfolio_facts_fresh(coalesce(e.tz, 'UTC'));
  w := public.portfolio_experiment_window(e.metric, e.condition, e.starts_at, least(coalesce(e.ended_at, e.ends_at), now()), z);
  return jsonb_build_object('experiment', e.id, 'metric', e.metric, 'min_sample', e.min_sample, 'window', w,
    'baseline', coalesce(e.baseline, public.portfolio_experiment_window(e.metric, e.condition, e.starts_at - (e.ends_at - e.starts_at), e.starts_at, z)
                                     || jsonb_build_object('frozen_at', null, 'computed_at_conclusion', true)),
    'methodology', public.portfolio_methodology_current('EXPERIMENT_TEST'));
end $$;

-- conclude an ended experiment, once. The server recomputes the evidence and
-- refuses a conclusion the evidence does not allow: SUPPORTED needs the
-- interval above zero and the window mean above the baseline; fewer
-- positions than pre-registered on either side is INCONCLUSIVE, whatever
-- the page says.
create or replace function public.portfolio_conclude_experiment(p_id uuid, p_test jsonb)
returns jsonb language plpgsql volatile set jit = off as $$
declare e record; ev jsonb; wm jsonb; bm jsonb; wn numeric; bn numeric; diff numeric; lo numeric; hi numeric; st text; claimed text; ended boolean;
begin
  select * into e from public.portfolio_experiments where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'portfolio: no such experiment' using errcode = 'P0002'; end if;
  if e.conclusion is not null then return jsonb_build_object('conclusion', e.conclusion, 'result', e.result, 'already', true); end if;
  ended := e.status <> 'ACTIVE' or e.ends_at <= now();
  if not ended then raise exception 'portfolio: an experiment is concluded once its window has ended' using errcode = '55000'; end if;
  ev := public.portfolio_experiment_evidence(p_id);
  /* an experiment started before baselines were frozen: its baseline window
     is computed now, and the result says so */
  if e.baseline is null then
    e.baseline := public.portfolio_experiment_window(e.metric, e.condition, e.starts_at - (e.ends_at - e.starts_at), e.starts_at,
                    public.portfolio_tz(coalesce(e.tz, 'UTC'))) || jsonb_build_object('frozen_at', null, 'computed_at_conclusion', true);
  end if;
  wm := ev->'window'->'moments'; bm := e.baseline->'moments';
  wn := (wm->>0)::numeric; bn := (bm->>0)::numeric;
  diff := case when wn > 0 and bn > 0 then (wm->>1)::numeric / wn - (bm->>1)::numeric / bn end;
  claimed := upper(coalesce(p_test->>'status', ''));
  lo := public.portfolio_j_num(p_test, 'ci_lo', -1000000, 1000000); hi := public.portfolio_j_num(p_test, 'ci_hi', -1000000, 1000000);
  st := case when wn < e.min_sample or bn < e.min_sample or diff is null then 'INCONCLUSIVE'
             when claimed = 'SUPPORTED' and lo > 0 and diff > 0 then 'SUPPORTED'
             when claimed = 'NOT_SUPPORTED' and ((hi < 0 and diff < 0) or diff <= 0) then 'NOT_SUPPORTED'
             else 'INCONCLUSIVE' end;
  perform set_config('portfolio.writer', 'experiment', true);
  update public.portfolio_experiments set status = case when status = 'ACTIVE' then 'ENDED' else status end,
         result = jsonb_build_object('window', ev->'window', 'baseline', e.baseline, 'diff', diff,
           'test', jsonb_strip_nulls(jsonb_build_object('ci_lo', lo, 'ci_hi', hi, 'p', public.portfolio_j_num(p_test, 'p', 0, 1),
             'df', public.portfolio_j_num(p_test, 'df', 0, 100000000))), 'claimed', nullif(claimed, '')),
         conclusion = st, concluded_at = now(), result_methodology = ev->>'methodology'
   where id = p_id;
  perform set_config('portfolio.writer', '', true);
  select * into e from public.portfolio_experiments where id = p_id;
  return jsonb_build_object('conclusion', e.conclusion, 'result', e.result, 'already', false);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. CARD LIFECYCLE — what happened to each saved opportunity, append-only.
--     A skipped or removed entry is never a position.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_card_events (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id     text        not null,
  event        text        not null,
  at           timestamptz not null default now(),
  position_id  uuid        null,
  detail       jsonb       not null default '{}'::jsonb,
  constraint portfolio_card_events_shape check (event in ('ADDED', 'RESEARCH_VIEWED', 'CONSIDERED', 'RECORDED', 'REMOVED')
    and length(entry_id) between 1 and 120 and jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024)
);
comment on table public.portfolio_card_events is
  'APPEND-ONLY. The life of a Card entry: added, research viewed, considered (Before You Enter opened), recorded (a position), removed. RECORDED is written only by the decision snapshot. Private to its reader.';
create unique index if not exists portfolio_card_events_once on public.portfolio_card_events (user_id, entry_id, event)
  where event in ('ADDED', 'RECORDED', 'REMOVED');
create index if not exists portfolio_card_events_user on public.portfolio_card_events (user_id, at desc);

create or replace function public.portfolio_card_events_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'portfolio: a Card event is never rewritten' using errcode = '42501'; end if;
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.at := now();
  if new.event = 'RECORDED' and not public.portfolio_writer_is('card_recorded') then
    raise exception 'portfolio: a Card entry is recorded by recording its position' using errcode = '42501';
  end if;
  if new.event <> 'RECORDED' then new.position_id := null; end if;
  /* the detail is labels, never money */
  new.detail := jsonb_strip_nulls(jsonb_build_object('decision', public.portfolio_j_text(new.detail, 'decision', 20),
    'sport', public.portfolio_j_text(new.detail, 'sport', 20), 'type', public.portfolio_j_text(new.detail, 'type', 20),
    'surface', public.portfolio_j_text(new.detail, 'surface', 40)));
  return new;
end $$;
drop trigger if exists portfolio_card_events_guard_trg on public.portfolio_card_events;
create trigger portfolio_card_events_guard_trg before insert or update on public.portfolio_card_events
  for each row execute function public.portfolio_card_events_guard();

create or replace function public.portfolio_card_recorded(p_user uuid, p_entry text, p_position uuid, p_decision text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  /* only the snapshot that names this entry records it */
  if not exists (select 1 from public.portfolio_decision_snapshots s where s.position_id = p_position and s.user_id = p_user
                   and s.origin = 'CARD' and s.origin_ref = p_entry and (auth.uid() is null or s.user_id = auth.uid())) then
    return;
  end if;
  perform set_config('portfolio.writer', 'card_recorded', true);
  insert into public.portfolio_card_events (user_id, entry_id, event, position_id, detail)
  values (p_user, left(p_entry, 120), 'RECORDED', p_position, jsonb_build_object('decision', p_decision))
  on conflict do nothing;
  perform set_config('portfolio.writer', '', true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. THE DECISION RECORD — one position, canonically:
--     BEFORE · ENTRY · MARKET PATH · RESULT · GRADE · REFLECTION · FOLLOW-UP
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_decision_record(p_position uuid, p_tz text default null)
returns jsonb language plpgsql volatile set jit = off as $$
declare z text := public.portfolio_facts_fresh(p_tz); p record; j record; s record; c record; x record; oc record; refl jsonb; path jsonb;
  cev jsonb; exps jsonb; ins jsonb; ec jsonb;
begin
  select * into p from public.portfolio_positions where id = p_position and user_id = auth.uid();
  if not found then raise exception 'portfolio: no such position' using errcode = 'P0002'; end if;
  select * into j from public.portfolio_journal_entries where position_id = p.id;
  select * into s from public.portfolio_decision_snapshots where position_id = p.id;
  select * into c from public.portfolio_facts_cached(null, null, z, null) f where f.id = p.id;
  select * into x from public.portfolio_context(z) q where q.id = p.id;
  select * into oc from public.portfolio_outcome_classes o where o.position_id = p.id order by o.classified_at desc, o.id desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('kind', m.kind, 'observed_at', m.observed_at, 'time_basis', m.time_basis, 'source', m.source,
           'book', m.book, 'odds_decimal', m.odds_decimal, 'price', m.price, 'line', m.line) order by m.observed_at, m.id), '[]'::jsonb)
    into path from public.portfolio_market_path m where m.position_id = p.id;
  select coalesce(jsonb_agg(jsonb_build_object('written_at', r.written_at, 'would_repeat', r.would_repeat, 'review_note', r.review_note,
           'library', r.library, 'result_known', r.result_known, 'result', r.result) order by r.written_at, r.id), '[]'::jsonb)
    into refl from public.portfolio_reflections r where r.position_id = p.id;
  select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at) order by e.at, e.id), '[]'::jsonb)
    into cev from public.portfolio_card_events e where e.user_id = auth.uid() and s.origin = 'CARD' and e.entry_id = s.origin_ref;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'metric', e.metric, 'status', e.status, 'conclusion', e.conclusion,
           'starts_at', e.starts_at, 'ends_at', e.ends_at,
           'followed', case when e.condition ? 'dim' and e.condition ? 'key' then (select public.portfolio_fact_in(e.condition->>'dim', e.condition->>'key', fc)
                              from public.portfolio_facts_cache fc where fc.user_id = auth.uid() and fc.tz = z and fc.id = p.id) end)
           order by e.starts_at), '[]'::jsonb)
    into exps from public.portfolio_experiments e
   where e.user_id = auth.uid() and e.starts_at <= p.placed_at and coalesce(e.ended_at, e.ends_at) > p.placed_at;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'kind', i.kind, 'metric', i.metric, 'dim', i.dim, 'key', i.key,
           'first_detected_at', i.first_detected_at) order by i.first_detected_at), '[]'::jsonb)
    into ins from public.portfolio_insights i
   where i.user_id = auth.uid() and exists (select 1 from public.portfolio_insight_observations o where o.insight_id = i.id and p.id = any (o.position_ids)
                                             and o.observed_at = (select max(o2.observed_at) from public.portfolio_insight_observations o2 where o2.insight_id = i.id));
  ec := public.portfolio_edge_capture(p.platform_type, p.position_type, x.ou, c.lead_seconds,
          case when p.platform_type = 'PREDICTION_MARKET' then p.average_entry_price else p.odds_decimal end, p.line,
          x.ref_price, x.ref_line, x.close_price, x.close_line, x.prob);
  return jsonb_build_object(
    'methodology', jsonb_build_object('process', public.portfolio_methodology_current('PROCESS_SCORE'),
      'context_quality', public.portfolio_methodology_current('CONTEXT_QUALITY'), 'edge_capture', public.portfolio_methodology_current('EDGE_CAPTURE'),
      'outcome_class', public.portfolio_methodology_current('OUTCOME_CLASS'), 'snapshot', s.snapshot_version, 'calc', p.calc_version),
    'position', jsonb_build_object('id', p.id, 'platform', p.platform, 'platform_label', p.platform_label, 'platform_type', p.platform_type,
      'position_type', p.position_type, 'sport', p.sport, 'league', p.league, 'event_name', p.event_name, 'event_start_at', p.event_start_at,
      'market_name', p.market_name, 'selection', p.selection, 'side', p.side, 'line', p.line, 'source', p.source),
    'context_quality', coalesce(x.quality, 'RESULT_ONLY'),
    'before', jsonb_build_object(
      'snapshot', case when s.position_id is not null then jsonb_build_object('origin', s.origin, 'origin_ref', s.origin_ref, 'saved_at', s.saved_at,
        'recorded_at', s.recorded_at, 'version', s.snapshot_version, 'edgedesk', s.edgedesk, 'market', s.market, 'user_state', s.user_state,
        'market_freshness', s.market_freshness, 'content_hash', s.content_hash,
        'research_to_decision_seconds', case when s.saved_at is not null then trunc(extract(epoch from (s.recorded_at - s.saved_at)))::bigint end) end,
      'journal', case when j.position_id is not null then jsonb_strip_nulls(jsonb_build_object('decision_source', j.decision_source,
        'planned', j.planned, 'thesis', j.thesis, 'decision_tags', to_jsonb(j.decision_tags), 'model_version', j.model_version,
        'model_probability', j.model_probability, 'model_fair_line', j.model_fair_line, 'model_fair_odds_decimal', j.model_fair_odds_decimal,
        'research_odds_american', j.research_odds_american, 'research_odds_decimal', j.research_odds_decimal, 'research_line', j.research_line,
        'research_price', j.research_price, 'research_at', j.research_at, 'opening_odds_decimal', j.opening_odds_decimal, 'opening_line', j.opening_line,
        'opening_price', j.opening_price, 'unit_size_at_entry', j.unit_size_at_entry, 'max_single_units_at_entry', j.max_single_units_at_entry,
        'max_daily_units_at_entry', j.max_daily_units_at_entry, 'decision_recorded_at', j.decision_recorded_at,
        'model_pre_event', c.model_pre_event, 'research_pre_event', c.research_pre_event)) end,
      'card', cev),
    'entry', jsonb_strip_nulls(jsonb_build_object('placed_at', p.placed_at, 'odds_american', p.odds_american, 'odds_decimal', p.odds_decimal,
      'average_entry_price', p.average_entry_price, 'contracts', p.contracts, 'line', p.line, 'stake', p.stake, 'cost_basis', p.cost_basis,
      'stake_type', p.stake_type, 'currency', p.currency, 'units', c.units, 'lead_seconds', c.lead_seconds, 'timing_bucket', c.timing_bucket)),
    'market_path', path,
    'result', jsonb_strip_nulls(jsonb_build_object('status', p.status, 'result', p.result, 'settled_at', p.settled_at, 'profit_loss', p.profit_loss,
      'closing_source', j.closing_source, 'closing_book', j.closing_book, 'closing_recorded_at', j.closing_recorded_at,
      'closing_odds_decimal', j.closing_odds_decimal, 'closing_line', j.closing_line, 'closing_price', j.closing_price)),
    'grade', jsonb_build_object('process_score', c.process_score, 'grade', c.grade, 'process_weight', c.process_weight, 'evidence', c.evidence,
      'components', jsonb_build_object('clv', c.s_clv, 'model', c.s_model, 'price', c.s_price, 'sizing', c.s_sizing, 'timing', c.s_timing,
        'rules', c.s_rules, 'market', c.s_market),
      'clv_pct', c.clv_pct, 'clv_points', c.clv_points, 'model_ev', c.model_ev, 'price_slip', c.price_slip, 'price_points', c.price_points,
      'rules_applicable', c.rules_applicable, 'rules_followed', c.rules_followed, 'rules_broken', to_jsonb(c.rules_broken),
      'edge_capture', ec,
      'outcome', case when oc.id is not null then jsonb_build_object('class', oc.class, 'classified_at', oc.classified_at,
        'methodology', oc.methodology_version, 'process_score', oc.process_score, 'context_quality', oc.context_quality)
        else jsonb_build_object('class', public.portfolio_outcome_class(p.status, p.result, c.process_score, coalesce(x.quality, 'RESULT_ONLY')),
          'provisional', true) end),
    'reflection', jsonb_build_object('current', case when j.position_id is not null then jsonb_strip_nulls(jsonb_build_object('would_repeat', j.would_repeat,
      'review_note', j.review_note, 'library', j.library, 'reviewed_at', j.reviewed_at)) end, 'history', refl),
    'follow_up', jsonb_build_object('needs_review', p.status <> 'OPEN' and j.would_repeat is null, 'experiments', exps, 'patterns', ins,
      'rules_broken', to_jsonb(c.rules_broken)));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. SEARCH — the caller's own positions and their journal words
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_search(p_q text, p_limit int default 20)
returns table (id uuid, event_name text, selection text, market_name text, platform_label text, position_type text, sport text,
  placed_at timestamptz, event_start_at timestamptz, status text, result text, profit_loss numeric, matched text)
language sql stable as $$
  with q as (select '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
                    length(btrim(coalesce(p_q, ''))) as len)
  select p.id, p.event_name, p.selection, p.market_name, p.platform_label, p.position_type, p.sport, p.placed_at, p.event_start_at,
         p.status, p.result, p.profit_loss,
         case when p.event_name ilike q.pat then 'event' when p.selection ilike q.pat then 'selection' when p.market_name ilike q.pat then 'market'
              when p.platform_label ilike q.pat then 'platform' when coalesce(p.sport, '') ilike q.pat or coalesce(p.league, '') ilike q.pat then 'sport'
              when coalesce(p.notes, '') ilike q.pat then 'notes' when coalesce(j.thesis, '') ilike q.pat then 'thesis' else 'review' end
    from q, public.portfolio_positions p
    left join public.portfolio_journal_entries j on j.position_id = p.id
   where p.user_id = auth.uid() and q.len between 2 and 80
     and (p.event_name ilike q.pat or p.selection ilike q.pat or p.market_name ilike q.pat or p.platform_label ilike q.pat
          or coalesce(p.sport, '') ilike q.pat or coalesce(p.league, '') ilike q.pat or coalesce(p.notes, '') ilike q.pat
          or coalesce(j.thesis, '') ilike q.pat or coalesce(j.review_note, '') ilike q.pat)
   order by p.placed_at desc, p.id
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. NOTIFICATIONS — a settled position's record is ready to review. One
--     per position, in the reader's own notification centre, only if they
--     keep the preference on; never a prompt to place anything.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_settled_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare on_pref boolean := true; pj jsonb;
begin
  if to_regclass('public.user_alerts') is null then return null; end if;
  if to_regclass('public.alert_preferences') is not null then
    execute 'select to_jsonb(a) from public.alert_preferences a where a.user_id = $1' into pj using new.user_id;
    if pj is not null and ((pj->>'enabled') = 'false' or (pj->>'on_decision_review') = 'false') then return null; end if;
  end if;
  begin
    execute 'insert into public.user_alerts (user_id, kind, title, body, severity, payload, dedupe_key)
             values ($1, ''decision_review'', $2, $3, ''info'', $4, $5) on conflict (user_id, dedupe_key) do nothing'
      using new.user_id, left(new.event_name || ' settled', 160),
            left(new.selection || ' · ' || new.platform_label || '. The decision record is ready: what you saw at entry, the market path and the process grade.', 600),
            jsonb_build_object('position_id', new.id, 'surface', 'portfolio'), 'decision_review:' || new.id::text;
  exception when check_violation or undefined_column or undefined_table then
    /* the notification centre predates this kind: the settlement stands */
    null;
  end;
  return null;
end $$;
drop trigger if exists portfolio_positions_settled_notice_trg on public.portfolio_positions;
create trigger portfolio_positions_settled_notice_trg after update on public.portfolio_positions
  for each row when (old.status = 'OPEN' and new.status <> 'OPEN')
  execute function public.portfolio_settled_notice();

-- an experiment whose window has ended and is not yet concluded: one notice,
-- for the caller only (the page calls this as it loads)
create or replace function public.portfolio_due_notices()
returns int language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); n int := 0; k int; e record; pj jsonb;
begin
  if me is null or to_regclass('public.user_alerts') is null then return 0; end if;
  if to_regclass('public.alert_preferences') is not null then
    execute 'select to_jsonb(a) from public.alert_preferences a where a.user_id = $1' into pj using me;
    if pj is not null and ((pj->>'enabled') = 'false' or (pj->>'on_experiment_ready') = 'false') then return 0; end if;
  end if;
  for e in select x.id, x.title from public.portfolio_experiments x
            where x.user_id = me and x.conclusion is null and (x.status <> 'ACTIVE' or x.ends_at <= now()) and x.ends_at > now() - interval '60 days' loop
    begin
      execute 'insert into public.user_alerts (user_id, kind, title, body, severity, payload, dedupe_key)
               values ($1, ''experiment_ready'', $2, $3, ''info'', $4, $5) on conflict (user_id, dedupe_key) do nothing'
        using me, left('Experiment window ended: ' || e.title, 160),
              'The result can be read now, against the baseline frozen when it started.',
              jsonb_build_object('experiment_id', e.id, 'surface', 'process'), 'experiment_ready:' || e.id::text;
      get diagnostics k = row_count; n := n + k;
    exception when check_violation or undefined_column or undefined_table then null;
    end;
  end loop;
  return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. PRIVACY — everything as data, and everything deleted on request
-- ─────────────────────────────────────────────────────────────────────────────
-- the caller's whole Portfolio and Decision Record, in one document. Runs as
-- the caller: it can contain nothing that is not theirs. Credentials are
-- never readable and are not included; derived caches are not data.
create or replace function public.portfolio_export()
returns jsonb language plpgsql stable as $$
declare me uuid := auth.uid(); out jsonb;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  out := jsonb_build_object(
    'format', 'edgedesk_portfolio_export_v1', 'exported_at', now(),
    'methodology', (select coalesce(jsonb_agg(to_jsonb(m) order by m.component, m.effective_from), '[]'::jsonb) from public.portfolio_methodology m),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) - 'sync_cursor' order by a.created_at), '[]'::jsonb) from public.platform_accounts a where a.user_id = me),
    'positions', (select coalesce(jsonb_agg(to_jsonb(p) order by p.placed_at, p.id), '[]'::jsonb) from public.portfolio_positions p where p.user_id = me),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.executed_at, t.id), '[]'::jsonb) from public.portfolio_transactions t where t.user_id = me),
    'journal', (select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at), '[]'::jsonb) from public.portfolio_journal_entries j where j.user_id = me),
    'decision_snapshots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.recorded_at), '[]'::jsonb) from public.portfolio_decision_snapshots s where s.user_id = me),
    'market_path', (select coalesce(jsonb_agg(to_jsonb(m) order by m.position_id, m.observed_at, m.id), '[]'::jsonb) from public.portfolio_market_path m where m.user_id = me),
    'reflections', (select coalesce(jsonb_agg(to_jsonb(r) order by r.written_at, r.id), '[]'::jsonb) from public.portfolio_reflections r where r.user_id = me),
    'outcome_classes', (select coalesce(jsonb_agg(to_jsonb(o) order by o.classified_at, o.id), '[]'::jsonb) from public.portfolio_outcome_classes o where o.user_id = me),
    'baselines', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.portfolio_baselines b where b.user_id = me),
    'insights', (select coalesce(jsonb_agg(to_jsonb(i) order by i.first_detected_at), '[]'::jsonb) from public.portfolio_insights i where i.user_id = me),
    'insight_observations', (select coalesce(jsonb_agg(to_jsonb(o) order by o.observed_at, o.id), '[]'::jsonb) from public.portfolio_insight_observations o where o.user_id = me),
    'rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.active_from), '[]'::jsonb) from public.portfolio_rules r where r.user_id = me),
    'experiments', (select coalesce(jsonb_agg(to_jsonb(e) order by e.starts_at), '[]'::jsonb) from public.portfolio_experiments e where e.user_id = me),
    'card_events', (select coalesce(jsonb_agg(to_jsonb(c) order by c.at, c.id), '[]'::jsonb) from public.portfolio_card_events c where c.user_id = me),
    'imports', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) from public.portfolio_imports i where i.user_id = me),
    'import_rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.import_id, r.row_number), '[]'::jsonb) from public.portfolio_import_rows r where r.user_id = me));
  return out;
end $$;

-- delete every Portfolio and Decision Record row the caller owns: positions
-- (with their journal, snapshots, path, reflections and classes), fills,
-- imports, accounts and their stored credentials, rules, experiments,
-- patterns, the baseline, Card events, caches and this kind of notification.
-- The typed phrase guards against a stray call. Irreversible.
create or replace function public.portfolio_delete_everything(p_confirm text)
returns jsonb language plpgsql volatile security definer set search_path = public, portfolio_private, pg_temp as $$
declare me uuid := auth.uid(); out jsonb := '{}'::jsonb; k int;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  if coalesce(p_confirm, '') <> 'DELETE MY PORTFOLIO' then
    raise exception 'portfolio: type DELETE MY PORTFOLIO to confirm' using errcode = '22023';
  end if;
  /* the caller is checked above; what follows deletes only rows whose
     user_id is theirs, including connector-owned ones a reader cannot touch,
     so it runs without the reader's identity (as portfolio_disconnect does) */
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  delete from portfolio_private.platform_credentials where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('credentials', k);
  delete from public.portfolio_positions where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('positions', k);
  delete from public.portfolio_transactions where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('transactions', k);
  delete from public.portfolio_import_rows where user_id = me;
  delete from public.portfolio_imports where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('imports', k);
  delete from public.portfolio_sync_logs where user_id = me;
  if to_regclass('public.portfolio_sync_runs') is not null then
    delete from public.portfolio_sync_runs r using public.platform_accounts a where r.platform_account_id = a.id and a.user_id = me;
  end if;
  delete from public.platform_accounts where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('accounts', k);
  delete from public.portfolio_rules where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('rules', k);
  delete from public.portfolio_experiments where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('experiments', k);
  delete from public.portfolio_insights where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('patterns', k);
  delete from public.portfolio_insight_observations where user_id = me;
  delete from public.portfolio_baselines where user_id = me;
  delete from public.portfolio_card_events where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('card_events', k);
  delete from public.portfolio_outcome_classes where user_id = me;
  delete from public.portfolio_facts_cache where user_id = me;
  delete from public.portfolio_facts_cache_state where user_id = me;
  if to_regclass('public.user_alerts') is not null then
    execute 'delete from public.user_alerts where user_id = $1 and kind in (''decision_review'', ''experiment_ready'')' using me;
  end if;
  return out;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. THE OPERATOR'S MOAT METRICS — counts over readers, never a reader.
--     Any figure drawn from fewer than 5 readers is withheld. Not exposed to
--     analytics; nothing here leaves the database except through this call.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_admin_moat_metrics(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))); out jsonb; users int;
  k_min int := 5;
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  select count(distinct user_id) into users from public.portfolio_positions where placed_at >= since;
  with pos as (
    select p.id, p.user_id, p.status, j.decision_recorded_at, j.closing_source, j.would_repeat,
           (s.position_id is not null) as has_snap,
           (s.edgedesk ? 'probability' or s.edgedesk ? 'fair_odds_decimal' or s.edgedesk ? 'fair_line') as snap_model,
           (s.market ? 'odds_decimal' or s.market ? 'price') as snap_market, s.origin,
           (j.decision_recorded_at is not null and j.decision_recorded_at < least(coalesce(p.event_start_at, 'infinity'::timestamptz), coalesce(p.settled_at, 'infinity'::timestamptz))) as decision_pre
      from public.portfolio_positions p
      left join public.portfolio_journal_entries j on j.position_id = p.id
      left join public.portfolio_decision_snapshots s on s.position_id = p.id
     where p.placed_at >= since),
  per_user as (select p0.user_id, count(*) filter (where z.has_snap or z.decision_pre) as ctx from public.portfolio_positions p0
                 left join public.portfolio_journal_entries j0 on j0.position_id = p0.id
                 left join public.portfolio_decision_snapshots s0 on s0.position_id = p0.id
                 cross join lateral (select s0.position_id is not null as has_snap,
                   (j0.decision_recorded_at is not null and j0.decision_recorded_at < least(coalesce(p0.event_start_at, 'infinity'::timestamptz), coalesce(p0.settled_at, 'infinity'::timestamptz))) as decision_pre) z
                group by p0.user_id)
  select jsonb_build_object(
    'window_days', p_days, 'readers_with_positions', case when users >= k_min then users end,
    'withheld_below_readers', k_min,
    'positions', case when users >= k_min then (select count(*) from pos) end,
    'share_with_decision_snapshot', case when users >= k_min then (select round(avg(case when has_snap then 1 else 0 end), 4) from pos) end,
    'share_with_pre_event_context', case when users >= k_min then (select round(avg(case when has_snap or decision_pre then 1 else 0 end), 4) from pos) end,
    'share_full_snapshot', case when users >= k_min then (select round(avg(case when has_snap and snap_model and snap_market then 1 else 0 end), 4) from pos) end,
    'share_settled_with_close', case when users >= k_min then (select round(avg(case when closing_source is not null then 1 else 0 end), 4) from pos where status <> 'OPEN') end,
    'share_settled_reviewed', case when users >= k_min then (select round(avg(case when would_repeat is not null then 1 else 0 end), 4) from pos where status <> 'OPEN') end,
    'snapshots_by_origin', case when users >= k_min then (select coalesce(jsonb_object_agg(origin, n), '{}'::jsonb) from (select origin, count(*) as n from pos where has_snap group by origin) o) end,
    'path_points_per_snapshot', case when users >= k_min then (select round(avg(n), 2) from (select count(m.id) as n from public.portfolio_decision_snapshots s
        left join public.portfolio_market_path m on m.position_id = s.position_id where s.recorded_at >= since group by s.position_id) q) end,
    'card_entries_recorded_share', case when (select count(distinct user_id) from public.portfolio_card_events where at >= since) >= k_min then
        (select round(count(*) filter (where event = 'RECORDED')::numeric / nullif(count(*) filter (where event = 'ADDED'), 0), 4)
           from public.portfolio_card_events where at >= since) end,
    'experiments_concluded', case when users >= k_min then (select count(*) from public.portfolio_experiments where concluded_at >= since) end,
    'readers_by_context_depth', (select jsonb_build_object(
        'at_least_10', case when count(*) filter (where ctx >= 10) >= k_min then count(*) filter (where ctx >= 10) end,
        'at_least_30', case when count(*) filter (where ctx >= 30) >= k_min then count(*) filter (where ctx >= 30) end,
        'at_least_100', case when count(*) filter (where ctx >= 100) >= k_min then count(*) filter (where ctx >= 100) end) from per_user),
    'generated_at', now()) into out;
  return out;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_methodology enable row level security;
alter table public.portfolio_decision_snapshots enable row level security;
alter table public.portfolio_market_path enable row level security;
alter table public.portfolio_reflections enable row level security;
alter table public.portfolio_outcome_classes enable row level security;
alter table public.portfolio_baselines enable row level security;
alter table public.portfolio_insights enable row level security;
alter table public.portfolio_insight_observations enable row level security;
alter table public.portfolio_card_events enable row level security;

-- the methodology is published method, not anyone's data
drop policy if exists portfolio_methodology_read on public.portfolio_methodology;
create policy portfolio_methodology_read on public.portfolio_methodology for select to authenticated using (true);

drop policy if exists portfolio_snapshots_select_own on public.portfolio_decision_snapshots;
create policy portfolio_snapshots_select_own on public.portfolio_decision_snapshots for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_snapshots_insert_own on public.portfolio_decision_snapshots;
create policy portfolio_snapshots_insert_own on public.portfolio_decision_snapshots for insert to authenticated with check (user_id = auth.uid());
-- no update policy and no delete policy: a snapshot goes only with its position
drop policy if exists portfolio_path_select_own on public.portfolio_market_path;
create policy portfolio_path_select_own on public.portfolio_market_path for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_reflections_select_own on public.portfolio_reflections;
create policy portfolio_reflections_select_own on public.portfolio_reflections for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_outcome_select_own on public.portfolio_outcome_classes;
create policy portfolio_outcome_select_own on public.portfolio_outcome_classes for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_outcome_insert_own on public.portfolio_outcome_classes;
create policy portfolio_outcome_insert_own on public.portfolio_outcome_classes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_baselines_select_own on public.portfolio_baselines;
create policy portfolio_baselines_select_own on public.portfolio_baselines for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_baselines_insert_own on public.portfolio_baselines;
create policy portfolio_baselines_insert_own on public.portfolio_baselines for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_insights_select_own on public.portfolio_insights;
create policy portfolio_insights_select_own on public.portfolio_insights for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_insights_insert_own on public.portfolio_insights;
create policy portfolio_insights_insert_own on public.portfolio_insights for insert to authenticated with check (user_id = auth.uid());
drop policy if exists portfolio_insight_obs_select_own on public.portfolio_insight_observations;
create policy portfolio_insight_obs_select_own on public.portfolio_insight_observations for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_insight_obs_insert_own on public.portfolio_insight_observations;
create policy portfolio_insight_obs_insert_own on public.portfolio_insight_observations for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.portfolio_insights i where i.id = insight_id and i.user_id = auth.uid()));
drop policy if exists portfolio_card_events_select_own on public.portfolio_card_events;
create policy portfolio_card_events_select_own on public.portfolio_card_events for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_card_events_insert_own on public.portfolio_card_events;
create policy portfolio_card_events_insert_own on public.portfolio_card_events for insert to authenticated with check (user_id = auth.uid());

revoke all on public.portfolio_methodology, public.portfolio_decision_snapshots, public.portfolio_market_path, public.portfolio_reflections,
  public.portfolio_outcome_classes, public.portfolio_baselines, public.portfolio_insights, public.portfolio_insight_observations,
  public.portfolio_card_events from anon, authenticated;
grant select on public.portfolio_methodology, public.portfolio_market_path, public.portfolio_reflections to authenticated;
grant select, insert on public.portfolio_decision_snapshots, public.portfolio_outcome_classes, public.portfolio_baselines,
  public.portfolio_insights, public.portfolio_insight_observations, public.portfolio_card_events to authenticated;
-- the experiment's reflection is the reader's one write after the fact
grant select, insert, update, delete on public.portfolio_methodology, public.portfolio_decision_snapshots, public.portfolio_market_path,
  public.portfolio_reflections, public.portfolio_outcome_classes, public.portfolio_baselines, public.portfolio_insights,
  public.portfolio_insight_observations, public.portfolio_card_events to service_role;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in ('portfolio_methodology_guard', 'portfolio_methodology_current', 'portfolio_freshness',
              'portfolio_context_quality', 'portfolio_outcome_class', 'portfolio_edge_capture', 'portfolio_j_num', 'portfolio_j_text', 'portfolio_j_ts',
              'portfolio_j_american', 'portfolio_snapshot_edgedesk', 'portfolio_snapshot_market', 'portfolio_user_state', 'portfolio_snapshot_guard',
              'portfolio_snapshot_after', 'portfolio_path_guard', 'portfolio_path_from_snapshot', 'portfolio_path_from_journal',
              'portfolio_svc_attach_feed_path', 'portfolio_reflections_guard', 'portfolio_reflection_log', 'portfolio_context',
              'portfolio_writer_is', 'portfolio_outcome_guard', 'portfolio_classify_outcomes', 'portfolio_baseline_guard', 'portfolio_moments',
              'portfolio_baseline', 'portfolio_fact_key', 'portfolio_fact_in', 'portfolio_insight_guard', 'portfolio_observe_insight',
              'portfolio_insight_memory', 'portfolio_experiment_window', 'portfolio_experiments_record_guard', 'portfolio_experiment_evidence',
              'portfolio_conclude_experiment', 'portfolio_card_events_guard', 'portfolio_card_recorded', 'portfolio_decision_record',
              'portfolio_search', 'portfolio_settled_notice', 'portfolio_due_notices', 'portfolio_export', 'portfolio_delete_everything',
              'portfolio_admin_moat_metrics') loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname like 'portfolio\_svc\_%' then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    else
      /* portfolio_path_from_snapshot and portfolio_card_recorded run as their
         owner when the snapshot's trigger calls them, and check inside that
         the position and the entry are the caller's own */
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the Decision Record tables exist' as item,
    case when (select count(*) from pg_tables where schemaname = 'public' and tablename in ('portfolio_methodology', 'portfolio_decision_snapshots',
      'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines', 'portfolio_insights',
      'portfolio_insight_observations', 'portfolio_card_events')) = 9 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'row level security is on for every one',
    case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in ('portfolio_methodology',
      'portfolio_decision_snapshots', 'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines',
      'portfolio_insights', 'portfolio_insight_observations', 'portfolio_card_events')) = 9 then 'ok' else 'CHECK THIS — RLS is off' end
  union all select 3, 'every reader policy on reader data is keyed to auth.uid()',
    case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('portfolio_decision_snapshots', 'portfolio_market_path',
      'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines', 'portfolio_insights', 'portfolio_insight_observations', 'portfolio_card_events')
      and coalesce(qual, with_check) not like '%user_id = auth.uid()%') then 'ok' else 'CHECK THIS — a policy is not owner-scoped' end
  union all select 4, 'no reader can update or delete a snapshot, a path point, a reflection or a class',
    case when not has_table_privilege('authenticated', 'public.portfolio_decision_snapshots', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_decision_snapshots', 'delete')
      and not has_table_privilege('authenticated', 'public.portfolio_market_path', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_reflections', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_outcome_classes', 'update') then 'ok' else 'CHECK THIS — a reader holds a write' end
  union all select 5, 'anon can read nothing and call nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_decision_snapshots', 'select')
      and not has_function_privilege('anon', 'public.portfolio_decision_record(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_export()', 'execute') then 'ok' else 'CHECK THIS — anon holds a privilege' end
  union all select 6, 'the immutability triggers are installed',
    case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('portfolio_snapshot_guard_trg', 'portfolio_path_guard_trg',
      'portfolio_reflections_guard_trg', 'portfolio_outcome_guard_trg', 'portfolio_baseline_guard_trg', 'portfolio_insight_obs_guard_trg',
      'portfolio_card_events_guard_trg', 'portfolio_methodology_guard_trg', 'portfolio_experiments_record_trg')) = 9 then 'ok' else 'CHECK THIS' end
  union all select 7, 'every method in use is published',
    case when (select count(*) from public.portfolio_methodology where version in ('process_v1', 'snapshot_v1', 'context_quality_v1', 'edge_capture_v1',
      'outcome_class_v1', 'baseline_v1', 'insight_v1', 'experiment_v1')) = 8 then 'ok' else 'CHECK THIS — a methodology row is missing' end
  union all select 8, 'the reader functions run as the caller (row level security applies inside them)',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef
      and p.proname in ('portfolio_decision_record', 'portfolio_search', 'portfolio_export', 'portfolio_classify_outcomes', 'portfolio_baseline',
        'portfolio_observe_insight', 'portfolio_insight_memory', 'portfolio_context', 'portfolio_conclude_experiment', 'portfolio_experiment_evidence'))
      then 'ok' else 'CHECK THIS — a reader function runs as its owner' end
  union all select 9, 'context quality: a full snapshot is FULL; reasoning with a price is STRONG; a close alone is PARTIAL; nothing is RESULT_ONLY',
    case when public.portfolio_context_quality(true, true, true, true, true, true) = 'FULL'
      and public.portfolio_context_quality(false, false, false, true, true, false) = 'STRONG'
      and public.portfolio_context_quality(false, false, false, false, false, true) = 'PARTIAL'
      and public.portfolio_context_quality(false, false, false, false, false, false) = 'RESULT_ONLY' then 'ok' else 'CHECK THIS' end
  union all select 10, 'a win at a poor process is a BAD_WIN; a loss at a good one a GOOD_LOSS; no grade is never classified',
    case when public.portfolio_outcome_class('WON', 'WIN', 40, 'STRONG') = 'BAD_WIN' and public.portfolio_outcome_class('LOST', 'LOSS', 80, 'FULL') = 'GOOD_LOSS'
      and public.portfolio_outcome_class('WON', 'WIN', null, 'PARTIAL') = 'NOT_CLASSIFIED' then 'ok' else 'CHECK THIS' end
) r order by 1;
