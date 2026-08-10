-- ============================================================================
-- 20260812_learning_loop.sql
--
-- Turns the pattern store from a leaderboard into a learning loop.
--
-- research_patterns already refused to hold a pattern below 30 samples. That
-- stops the worst abuse and nothing else: slice a few hundred graded bets nine
-- ways and something always clears 30 samples at 60%. What was missing is the
-- evidence that a slice is real - a holdout window, a significance level that
-- accounts for how many slices were asked about, an effect floor, and an expiry.
--
-- Every column below exists so a stored pattern can be INTERROGATED rather than
-- trusted: how big was the holdout, what was the q-value across the family,
-- what is the base rate it is being compared against, and why did it pass or
-- fail. A pattern that cannot explain itself should not be quotable.
--
-- Additive and idempotent. Nothing is dropped, no column changes type.
-- Run AFTER 20260810_research_memory.sql.
-- ============================================================================

-- ------------------------------------------------------------- patterns v2
alter table public.research_patterns add column if not exists status        text;
alter table public.research_patterns add column if not exists family        text;
alter table public.research_patterns add column if not exists effect        numeric;
alter table public.research_patterns add column if not exists base_rate     numeric;
alter table public.research_patterns add column if not exists n_discovery   integer;
alter table public.research_patterns add column if not exists n_holdout     integer;
alter table public.research_patterns add column if not exists lo_overall    numeric;
alter table public.research_patterns add column if not exists lo_discovery  numeric;
alter table public.research_patterns add column if not exists lo_holdout    numeric;
alter table public.research_patterns add column if not exists p_value       numeric;
alter table public.research_patterns add column if not exists q_value       numeric;
alter table public.research_patterns add column if not exists avg_clv       numeric;
alter table public.research_patterns add column if not exists rationale     text;
alter table public.research_patterns add column if not exists last_confirmed_at timestamptz;

-- Anything written before this migration predates holdout validation, so it is
-- a candidate at best. Nothing is deleted; it simply stops being quotable.
update public.research_patterns set status = 'CANDIDATE' where status is null;

-- The default is what actually enforces "the old rebuild cannot create a
-- quotable pattern": a CHECK passes on NULL, so without this an insert that
-- omits status would leave it null rather than CANDIDATE.
alter table public.research_patterns alter column status set default 'CANDIDATE';

do $$ begin
  alter table public.research_patterns
    add constraint research_patterns_status_chk
    check (status in ('CONFIRMED','CANDIDATE','REJECTED','EXPIRED'));
exception when duplicate_object then null; end $$;

-- The engine only ever reads CONFIRMED, so that read must be the fast one.
create index if not exists research_patterns_status_idx
  on public.research_patterns (status, sample_size desc);

comment on column public.research_patterns.status is
  'CONFIRMED = held in both the discovery and holdout windows, cleared the FDR and the effect floor. CANDIDATE = interesting, not yet evidence. REJECTED = tested and failed. EXPIRED = no longer re-evaluated by the current data. Only CONFIRMED may be quoted to a user.';
comment on column public.research_patterns.q_value is
  'Benjamini-Hochberg adjusted significance across every slice tested in the same run. A raw p-value is meaningless here because ~40 slices are asked about at once.';
comment on column public.research_patterns.n_holdout is
  'Samples in the newer, chronologically separated window. A pattern that only holds before the holdout is a pattern that stopped working.';
comment on column public.research_patterns.base_rate is
  'The population beat-close rate this slice is measured against. The question is never "does this beat a coin" but "does this beat EdgeDesk''s own average".';

-- ---------------------------------------------------------- calibration
-- Predicted edge against realised CLV. The most immediately useful artifact
-- here and it needs no pattern at all: it says whether the number on the card
-- means what it claims. It changes nothing automatically - the deterministic
-- engine still owns every price - it makes the gap visible.
create table if not exists public.research_calibration (
  bucket               text primary key,
  n                    integer not null,
  mean_edge_predicted  numeric,
  mean_clv_realised    numeric,
  beat_rate            numeric,
  beat_lo              numeric,
  shortfall            numeric,      -- predicted minus realised; positive = optimistic
  updated_at           timestamptz not null default now()
);

comment on table public.research_calibration is
  'Reliability curve for the deterministic engine: for each predicted-edge bucket, what CLV actually came back. Read-only to users; written by the learn cron.';
comment on column public.research_calibration.shortfall is
  'mean_edge_predicted - mean_clv_realised. Positive means the engine is optimistic in this bucket by that much.';

-- ---------------------------------------------------------- learning state
-- One row. Answers "is this loop actually learning yet" without anyone having
-- to interpret an empty table as a good sign.
create or replace view public.research_learning_state as
select
  (select count(*) from public.signals where graded_at is not null)                      as graded_signals,
  (select count(*) from public.signals where graded_at is not null and clv is not null)  as graded_with_clv,
  (select count(*) from public.research_outcomes)                                        as research_outcomes,
  (select count(*) from public.research_outcomes where graded_at is not null)            as outcomes_graded,
  (select count(*) from public.research_patterns where status = 'CONFIRMED')             as patterns_confirmed,
  (select count(*) from public.research_patterns where status = 'CANDIDATE')             as patterns_candidate,
  (select count(*) from public.research_calibration)                                     as calibration_buckets,
  (select max(updated_at) from public.research_patterns)                                 as patterns_updated_at,
  case
    when (select count(*) from public.signals where graded_at is not null and clv is not null) < 30
      then 'NOT READY — fewer than 30 graded signals with CLV; no pattern can be evaluated yet'
    when (select count(*) from public.research_patterns where status = 'CONFIRMED') = 0
      then 'EVALUATING — enough samples to test, nothing has cleared confirmation yet'
    else 'LEARNING — confirmed patterns are available'
  end                                                                                    as readiness;

comment on view public.research_learning_state is
  'Single-row summary of whether the learning loop has enough evidence to say anything. An empty patterns table means "not yet", never "no patterns exist".';

-- ------------------------------------------------------------------- RLS
alter table public.research_calibration enable row level security;

-- Calibration is an aggregate over everyone's graded signals and contains no
-- user data, so it is readable by any signed-in user and writable only by the
-- service role (which bypasses RLS and therefore needs no policy).
drop policy if exists rc_read on public.research_calibration;
create policy rc_read on public.research_calibration
  for select using (auth.role() = 'authenticated');

grant select on public.research_calibration to authenticated;
grant select on public.research_learning_state to authenticated;

-- ---------------------------------------------------------------- retire
-- research_rebuild_patterns() wrote patterns with no holdout, no multiple-
-- comparison control and no effect floor. It is superseded by the `learn`
-- Edge Function. Left in place so an existing cron does not error, but it can
-- no longer create a quotable pattern: everything it writes is a CANDIDATE.
comment on function public.research_rebuild_patterns(integer) is
  'SUPERSEDED by the learn Edge Function. Writes CANDIDATE rows only; a pattern from this path is never quoted to a user because it was never holdout-validated. Point your cron at learn instead.';
