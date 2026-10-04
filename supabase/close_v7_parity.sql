-- ============================================================================
--  close_v7_parity.sql — label how each close was measured
--
--  Run this BEFORE deploying close v7. The function degrades safely without it
--  (it probes for closing_reference_type and omits the labels when absent) but
--  until it runs there is no way to tell a Pinnacle-anchored close from a
--  consensus one, or a v7 row from a pre-parity row — and averaging across
--  either boundary is exactly how the -2.09% offset stayed invisible.
--
--  IDEMPOTENT. ADDITIVE. ENDS IN A REPORT. No measurement is edited: the only
--  rows written are ones whose new label column is still NULL, and labelling
--  history is allowed where rewriting it is not.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- THE COLUMNS close HAS ALWAYS WRITTEN, AND THAT NOTHING IN THIS REPOSITORY
-- EVER CREATED.
--
-- close writes closing_dec, closing_book, closing_has_sharp, closing_n_books,
-- closing_source and closing_at_observed on every run. They exist in the live
-- database because somebody added them by hand in the dashboard; no committed
-- file creates them, so a fresh database — or anyone rebuilding from this
-- checkout — gets a close job whose every UPDATE fails on a missing column.
-- Additive and idempotent, so this is a no-op where they already exist.
-- ---------------------------------------------------------------------------
alter table public.signals
  add column if not exists closing_dec           numeric,
  add column if not exists closing_book          text,
  add column if not exists closing_has_sharp     boolean,
  add column if not exists closing_n_books       integer,
  add column if not exists closing_source        text,
  add column if not exists closing_at_observed   timestamptz;

alter table public.signals
  -- WHICH RULE PRODUCED closing_sharp_fair.
  --   sharp             the reference book's own de-vigged probability
  --   robust_consensus  trimmed median of the independent families that are NOT
  --                     the best-priced one — a weaker close, labelled as one
  --   tick              capture's own last recorded pregame fair, when no live
  --                     close could be fetched (a rotated tournament key)
  --   none              no reference and too thin a pack; clv is null
  -- Before v7 this was unknowable: close could not reach the reference book at
  -- all, so every "sharp_fair" it wrote was consensus that had silently
  -- substituted itself. Those rows are labelled pre-v7-legacy below.
  add column if not exists closing_reference_type text,

  -- The book that anchored it, when one did. Named so a systematic problem with
  -- one reference is visible rather than averaged into the whole record.
  add column if not exists closing_ref_book       text,

  -- Independent operator families seen at close. Two brands on one trading desk
  -- are one opinion; this is the count of opinions, not of rows.
  add column if not exists closing_n_families     integer,

  -- Age of the anchor at the moment it was read. For a consensus this is the
  -- median age of the books that formed it, and a missing age counts as unknown
  -- rather than fresh.
  add column if not exists closing_ref_age_s      integer,

  -- The policy that measured this row. The point is not the string, it is that
  -- a reader can segment on it and never pool two different definitions of CLV.
  add column if not exists closing_policy         text;

comment on column public.signals.closing_reference_type is
  'How closing_sharp_fair was computed: sharp | robust_consensus | tick | none. Before close v7 the '
  'function could not reach the reference book at all, so a value of pre-v7-legacy in closing_policy '
  'means the fair is a consensus that was stored under the name sharp.';

comment on column public.signals.closing_policy is
  'The close policy that measured this row. Rows carrying different values were measured against '
  'different references and must never be averaged into one CLV number.';

-- ---------------------------------------------------------------------------
-- Label the history. Touches only rows whose label is still NULL, and changes
-- no measurement — every clv, closing_dec and closing_sharp_fair is left
-- exactly as it was found.
-- ---------------------------------------------------------------------------
update public.signals
   set closing_policy = 'pre-v7-legacy'
 where closed_at is not null
   and closing_policy is null;

update public.signals
   set closing_reference_type = case
         when closing_source = 'last_tick' then 'tick'
         when clv is null                  then 'none'
         else 'pre-v7-unknown'
       end
 where closed_at is not null
   and closing_reference_type is null;

commit;

-- The board never filters on these, but the record segments by them, and a
-- segment scan over a table this size is the difference between a page that
-- loads and one that does not.
create index if not exists signals_closing_policy_idx
  on public.signals (closing_policy, closing_reference_type)
  where closed_at is not null;

-- ---------------------------------------------------------------------------
-- REPORT. Every row says ok or CHECK THIS.
-- ---------------------------------------------------------------------------
select 1 as n, 'signals.closing_reference_type exists' as check_name,
       count(*) as got, 1 as want,
       case when count(*) = 1 then 'ok' else 'CHECK THIS' end as status
  from information_schema.columns
 where table_schema = 'public' and table_name = 'signals' and column_name = 'closing_reference_type'
union all
select 2, 'signals.closing_policy exists', count(*), 1,
       case when count(*) = 1 then 'ok' else 'CHECK THIS' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'signals' and column_name = 'closing_policy'
union all
select 3, 'the three supporting columns exist', count(*), 3,
       case when count(*) = 3 then 'ok' else 'CHECK THIS' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'signals'
   and column_name in ('closing_ref_book','closing_n_families','closing_ref_age_s')
union all
select 4, 'no closed row is left without a policy label', count(*), 0,
       case when count(*) = 0 then 'ok' else 'CHECK THIS' end
  from public.signals
 where closed_at is not null and closing_policy is null
union all
select 5, 'no closed row is left without a reference label', count(*), 0,
       case when count(*) = 0 then 'ok' else 'CHECK THIS' end
  from public.signals
 where closed_at is not null and closing_reference_type is null
union all
select 6, 'no measurement was edited (open rows stay unlabelled)', count(*), 0,
       case when count(*) = 0 then 'ok' else 'CHECK THIS' end
  from public.signals
 where closed_at is null and closing_policy is not null
union all
select 7, 'the six columns close has always written now exist in this repo', count(*), 6,
       case when count(*) = 6 then 'ok' else 'CHECK THIS' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'signals'
   and column_name in ('closing_dec','closing_book','closing_has_sharp',
                       'closing_n_books','closing_source','closing_at_observed')
union all
select 8, 'the segment index exists', count(*), 1,
       case when count(*) = 1 then 'ok' else 'CHECK THIS' end
  from pg_indexes
 where schemaname = 'public' and indexname = 'signals_closing_policy_idx'
 order by n;
