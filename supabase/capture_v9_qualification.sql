-- ===========================================================================
-- CAPTURE v9 — THE QUALIFICATION STATE
--
-- Paste into the Supabase SQL editor and run. Safe to run again. Nothing is
-- dropped, nothing is deleted, no existing value is rewritten.
--
-- WHY
--   capture-v9 replaces "is this edge big enough" with an explicit
--   qualification decision that has a TIER, a REASON and a set of measured
--   components. All of that is written on every row, actionable or not, so
--   that an empty board can always be told apart from a broken one, and so a
--   backtest can ask why a signal was refused six months after the fact.
--
--   Capture degrades safely if this has not been run: it drops the columns the
--   database does not have, keeps writing everything else, and names the gap in
--   its response under `schema_gaps`. So the deploy order does not matter. What
--   DOES matter is that until this runs, persistence streaks cannot be stored,
--   which means a Tier B candidate can never reach its second confirmation and
--   the actionable board stays empty. Run it.
--
-- WHAT IT DOES
--   1. Adds the v9 qualification columns to `signals` and `signal_ticks`.
--   2. LABELS the flags that already exist as pre-v9, so the record can report
--      the v9 policy separately instead of averaging two different systems
--      together and calling the result one number.
--   3. Rebuilds preserve_anchor_entry() so the freeze covers every flagged_*
--      and first_* column automatically, including ones added later.
--   4. Creates `book_families` and `book_quality` EMPTY, with the reason they
--      are empty written into the table comment.
--   5. Adds the indexes the board query and the persistence read need.
--   6. Prints a report. Every row should say ok.
-- ===========================================================================

begin;

-- ── 1. THE QUALIFICATION COLUMNS ──────────────────────────────────────────
-- Every one of these is written on EVERY priced row, not only on actionable
-- ones. A rejected candidate that cannot say why it was rejected is not
-- research data, it is a gap.

alter table public.signals
  -- The reference EdgeDesk anchored on, and what kind of reference it was.
  add column if not exists reference_type      text,      -- sharp | robust_consensus | none
  add column if not exists reference_book      text,
  -- The reference book's OWN de-vigged number. NULL whenever there wasn't one.
  -- This column can never hold a median. That is the entire point of it: v8's
  -- `sharp_fair` silently held the consensus whenever Pinnacle was absent, and
  -- nothing downstream could tell the difference.
  add column if not exists sharp_book_fair     numeric,

  -- The decision.
  add column if not exists qual_tier           text,      -- A | B | PASS
  add column if not exists qual_reason         text,
  add column if not exists qual_segment        text,      -- sport|market|tier
  add column if not exists qual_streak         integer default 0,
  add column if not exists edge_floor          numeric,   -- the floor actually applied
  add column if not exists capture_policy      text,
  add column if not exists devig_method        text,

  -- The evidence behind it, stored so the score can be taken apart.
  add column if not exists quality_score       integer,
  add column if not exists quality_components  jsonb,
  add column if not exists fresh_books         integer,
  add column if not exists n_books_eff         integer,
  add column if not exists dispersion          numeric,
  add column if not exists ref_quote_age_s     integer,
  add column if not exists best_quote_age_s    integer,

  -- Corroboration. app.html's corroboration() has read these three since it was
  -- written and nothing ever wrote them, so it has been falling back to a
  -- browser-side recomputation over whatever quotes happened to be cached — a
  -- different moment and a different sample from the one the row is graded on.
  add column if not exists corrob_n            integer,
  add column if not exists corrob_ref          text,
  add column if not exists corrob_levels       integer,

  -- The raw two-way reference price. app.html's method-sensitivity panel has
  -- been self-gated behind these two columns, printing "engine ready, data not".
  add column if not exists pin_dec             numeric,
  add column if not exists pin_opp_dec         numeric,
  add column if not exists is_fav              boolean,

  -- Football line discipline. Which point the market is actually trading, how
  -- many points are on offer, and which key numbers sit between this line and
  -- the modal one. No probability adjustment is derived from these anywhere —
  -- they are exposed so research can measure whether they are worth anything.
  add column if not exists point_is_modal      boolean,
  add column if not exists modal_point         numeric,
  add column if not exists points_offered      integer,
  add column if not exists key_numbers_to_modal jsonb,

  -- Frozen at first sighting.
  add column if not exists first_corrob_n      integer,
  add column if not exists first_corrob_ref    text,
  add column if not exists first_reference_type text,
  add column if not exists first_qual_tier     text,

  -- Frozen at the moment the signal became actionable. `flagged_at IS NOT NULL`
  -- is the canonical definition of an EdgeDesk signal and these travel with it.
  add column if not exists flagged_corrob_n    integer,
  add column if not exists flagged_tier        text,
  add column if not exists flagged_reference_type text,
  add column if not exists flagged_quality_score  integer,
  add column if not exists flagged_fresh_books    integer,
  add column if not exists flagged_policy      text,
  add column if not exists flagged_build       text;

comment on column public.signals.qual_reason is
  'Why this row is or is not actionable, from capture''s qualifySignal(). "ok" means actionable. '
  'Written on EVERY priced row so a refusal is data rather than an absence.';
comment on column public.signals.reference_type is
  'sharp = an approved reference book quoted this exact selection at this exact point, fresh. '
  'robust_consensus = it did not, and the fair line is a trimmed median of independent fresh books '
  'with the best-price book removed. none = neither. A robust_consensus row is NEVER sharp-anchored.';
comment on column public.signals.sharp_book_fair is
  'The reference book''s own de-vigged probability, or NULL. Never a median, under any circumstances.';
comment on column public.signals.flagged_policy is
  'The qualification policy version in force when this signal was frozen. A backtest that mixes '
  'policies is measuring the average of two systems and reporting it as one.';

alter table public.signal_ticks
  add column if not exists fresh_books     integer,
  add column if not exists n_books_eff     integer,
  add column if not exists qual_tier       text,
  add column if not exists qual_reason     text,
  add column if not exists reference_type  text,
  add column if not exists quality_score   integer,
  add column if not exists ref_quote_age_s integer,
  add column if not exists actionable      boolean;

-- ── 2. LABEL THE HISTORY. DO NOT REWRITE IT. ──────────────────────────────
-- Rows flagged before v9 were qualified under rules that did not require a
-- real sharp reference, did not check freshness, and used a single 0.5% floor.
-- They are REAL history and they stay exactly as they are. They are labelled so
-- that a report can say "under the v9 policy" and mean it.
--
-- This is deliberately the only UPDATE in this file, it touches only rows whose
-- label is still NULL, and it changes no measurement.
update public.signals
   set flagged_policy = coalesce(flagged_policy, 'pre-v9-legacy'),
       flagged_build  = coalesce(flagged_build,  'pre-v9-unknown')
 where flagged_at is not null
   and (flagged_policy is null or flagged_build is null);

-- ── 3. THE FREEZE ─────────────────────────────────────────────────────────
-- preserve_anchor_entry() is the guarantee that an entry price cannot drift and
-- an opening snapshot cannot be overwritten. Its documented rule is
-- coalesce(old, new) — first non-NULL wins and is then permanent.
--
-- It was maintained as a hardcoded column list, which is why capture writing
-- six of seven flagged_* columns left the seventh permanently NULL on every
-- signal ever flagged: a column absent from the list is not protected, and a
-- column left NULL at flag time can never be filled afterwards.
--
-- This version derives the list from the row itself, so every flagged_* and
-- first_* column is covered including ones added after this migration runs.
-- Same semantics, no list to fall out of date.
create or replace function public.preserve_anchor_entry()
returns trigger
language plpgsql
as $$
declare
  k    text;
  oldj jsonb := to_jsonb(OLD);
  newj jsonb := to_jsonb(NEW);
  changed boolean := false;
begin
  for k in select jsonb_object_keys(oldj) loop
    if (k like 'flagged\_%' or k like 'first\_%')
       and jsonb_typeof(oldj -> k) <> 'null' then
      -- The old value exists, so it wins. Permanently.
      if (newj -> k) is distinct from (oldj -> k) then
        newj := jsonb_set(newj, array[k], oldj -> k);
        changed := true;
      end if;
    end if;
  end loop;
  if changed then
    NEW := jsonb_populate_record(NEW, newj);
  end if;
  return NEW;
end;
$$;

comment on function public.preserve_anchor_entry() is
  'BEFORE UPDATE on signals: any flagged_* or first_* column that already holds a non-NULL value keeps '
  'it forever. The opening snapshot and the frozen entry price are what EdgeDesk is graded against; '
  'letting later market movement rewrite them would make the record meaningless.';

-- Exactly one trigger, whatever it was called before.
do $$
declare t record;
begin
  for t in
    select tg.tgname
      from pg_trigger tg
      join pg_proc p on p.oid = tg.tgfoid
     where tg.tgrelid = 'public.signals'::regclass
       and p.proname  = 'preserve_anchor_entry'
       and not tg.tgisinternal
  loop
    execute format('drop trigger %I on public.signals', t.tgname);
  end loop;
end $$;

create trigger trg_preserve_anchor_entry
  before update on public.signals
  for each row execute function public.preserve_anchor_entry();

-- ── 4. BOOK METADATA, CREATED EMPTY ON PURPOSE ────────────────────────────
-- app.html has documented `book_families` as the source of n_books_eff since
-- the column existed. It has never existed. Capture ships a built-in map of the
-- operator families it is confident about and reads this table as an override.
create table if not exists public.book_families (
  book_key   text primary key,
  family     text not null,
  note       text,
  updated_at timestamptz not null default now()
);
comment on table public.book_families is
  'Which books share a trading desk. Two brands on one desk are ONE opinion however many rows the feed '
  'sends. Empty by default and that is correct: wrongly merging two independent books is a worse error '
  'than failing to merge two related ones, so only relationships someone has actually verified belong here.';

create table if not exists public.book_quality (
  book_key            text primary key,
  reference_weight    numeric,
  freshness_reliability numeric,
  outlier_rate        numeric,
  lead_lag_score      numeric,
  closing_accuracy    numeric,
  measured_from       date,
  measured_to         date,
  n_observations      integer,
  frozen_at           timestamptz,
  note                text
);
comment on table public.book_quality is
  'MEASURED book behaviour: which books lead, which follow, which post stale prices, which move toward '
  'the close. CREATED EMPTY AND MEANT TO STAY EMPTY until tools/capture/backtest.js computes these from '
  'history on data STRICTLY EARLIER than the period they are then used on. Inventing a lead_lag_score in '
  'a source file would be a decorative number with no measured relationship to anything, which is exactly '
  'what this overhaul exists to remove. measured_from/measured_to/frozen_at are not optional metadata: '
  'a weight used on data it was fitted to is leakage.';

-- ── 4b. PER-BOOK QUOTES ───────────────────────────────────────────────────
-- book_quotes has a trigger (book_quote_ticks.sql), a view, four UI code paths
-- and three UI strings asserting capture populates it. Nothing ever wrote it.
-- capture v9 does, for ACTIONABLE signals only — the whole board at every book
-- would be tens of thousands of rows a run, and the actionable set is exactly
-- the population a book-behaviour study is about.
--
-- Created if absent; if it already exists only the missing columns are added and
-- nothing is rewritten.
create table if not exists public.book_quotes (
  sig_key    text not null,
  book_key   text not null,
  book_title text,
  dec        numeric,
  opp_dec    numeric,
  fair       numeric,
  updated_at timestamptz not null default now()
);
alter table public.book_quotes
  add column if not exists opp_dec     numeric,
  add column if not exists quote_age_s integer,
  add column if not exists is_fresh    boolean,
  add column if not exists is_reference boolean,
  add column if not exists is_best     boolean,
  add column if not exists book_family text,
  add column if not exists book_tier   text;

comment on column public.book_quotes.quote_age_s is
  'How stale this book''s quote was AT CAPTURE TIME. Stored rather than recomputed because a browser '
  'refetching quotes later is looking at a different moment and a different sample from the one the '
  'signal was graded on.';

-- The upsert key. Created only if some unique constraint on the pair is missing.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'book_quotes'
       and indexdef like '%UNIQUE%' and indexdef like '%sig_key%' and indexdef like '%book_key%'
  ) then
    execute 'create unique index book_quotes_sig_book_uidx on public.book_quotes (sig_key, book_key)';
  end if;
end $$;

-- ── 5. INDEXES ────────────────────────────────────────────────────────────
-- The actionable board: flagged rows inside a commence_time window, ordered by
-- edge. Partial, because the flagged population is a small fraction of the table.
create index if not exists signals_actionable_board_idx
  on public.signals (commence_time, edge desc)
  where flagged_at is not null;

-- Capture's persistence read: every future row for one sport, once per run.
create index if not exists signals_sport_commence_idx
  on public.signals (sport_key, commence_time);

-- The record and every backtest export.
create index if not exists signals_graded_flagged_idx
  on public.signals (graded_at)
  where flagged_at is not null and graded_at is not null;

create index if not exists signal_ticks_sig_created_idx
  on public.signal_ticks (sig_key, created_at);

commit;

-- ── 6. THE REPORT ─────────────────────────────────────────────────────────
-- Every row should say ok.
with checks as (
  select 1 as n, 'signals.qual_reason exists' as check,
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='qual_reason')::int as got, 1 as want
  union all select 2, 'signals.reference_type exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='reference_type')::int, 1
  union all select 3, 'signals.sharp_book_fair exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='sharp_book_fair')::int, 1
  union all select 4, 'signals.qual_streak exists (persistence cannot work without it)',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='qual_streak')::int, 1
  union all select 5, 'signals.flagged_policy exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='flagged_policy')::int, 1
  union all select 6, 'signals.corrob_n exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='corrob_n')::int, 1
  union all select 7, 'signals.pin_dec exists (unblocks the method-sensitivity panel)',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='pin_dec')::int, 1
  union all select 8, 'signal_ticks.qual_tier exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signal_ticks' and column_name='qual_tier')::int, 1
  union all select 9, 'signal_ticks.created_at exists (the close reads the last tick before kickoff)',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signal_ticks' and column_name='created_at')::int, 1
  union all select 10, 'exactly one preserve_anchor_entry trigger on signals',
         (select count(*) from pg_trigger tg join pg_proc p on p.oid=tg.tgfoid
           where tg.tgrelid='public.signals'::regclass and p.proname='preserve_anchor_entry'
             and not tg.tgisinternal)::int, 1
  union all select 11, 'book_families exists',
         (select count(*) from information_schema.tables
           where table_schema='public' and table_name='book_families')::int, 1
  union all select 12, 'book_quality exists',
         (select count(*) from information_schema.tables
           where table_schema='public' and table_name='book_quality')::int, 1
  union all select 13, 'actionable-board index exists',
         (select count(*) from pg_indexes
           where schemaname='public' and indexname='signals_actionable_board_idx')::int, 1
  union all select 14, 'no flagged row is left without a policy label',
         (select count(*) from public.signals where flagged_at is not null and flagged_policy is null)::int, 0
  union all select 15, 'book_quotes has a unique key on (sig_key, book_key) so capture can upsert it',
         (select count(*) from pg_indexes where schemaname='public' and tablename='book_quotes'
            and indexdef like '%UNIQUE%' and indexdef like '%sig_key%' and indexdef like '%book_key%')::int, 1
  union all select 16, 'book_quotes.quote_age_s exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='book_quotes' and column_name='quote_age_s')::int, 1
)
select n, check, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

-- How much history is labelled legacy vs qualified under v9. Run this again in a
-- week: the v9 count is the population any honest claim about the new policy has
-- to be computed over.
select coalesce(flagged_policy, '(unflagged)') as policy,
       count(*) as signals,
       count(*) filter (where graded_at is not null) as graded
  from public.signals
 group by 1 order by 2 desc;
