-- portfolio_decision -- part 1 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
