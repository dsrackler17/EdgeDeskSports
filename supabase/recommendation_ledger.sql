-- ===========================================================================
-- THE RECOMMENDATION LEDGER — an immutable record of what EdgeDesk said, when.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHY IT HAS TO BE IMMUTABLE
--   Every claim about whether this system works is a claim about what it said
--   BEFORE the games were played. A table that can be edited after the fact
--   cannot support that claim, however honest everyone involved intends to be:
--   an UPDATE that "corrects" a stale price, a decision quietly upgraded once
--   the result came in, a row deleted because it looked bad — none of these
--   leave a trace, and all of them turn a measurement into a story.
--
--   So the original row is written once and then locked by a trigger. A later
--   change is a SEPARATE row of kind='UPDATE' pointing back at the original
--   through supersedes. The record of what was actually published survives
--   whatever happens afterwards, which is the only property that makes the
--   measurement built on it mean anything.
--
-- THE FORWARD/BACKTEST SEPARATION
--   `mode` is FORWARD or BACKTEST and the two are NEVER measured together.
--   A backtest cannot be wrong about a game it was fitted on, so blending the
--   populations manufactures a record. The reporting view below counts them
--   separately and refuses to sum them.
--
-- LOOK-AHEAD
--   published_at must precede kickoff for a FORWARD row. The constraint is
--   enforced here rather than in application code, because a leaked row is
--   indistinguishable from a good one once it is in the table.
-- ===========================================================================

begin;

create table if not exists public.recommendation_ledger (
  id                    bigserial primary key,
  schema                text        not null default 'edgedesk_recommendation_v1',
  kind                  text        not null default 'RECOMMENDATION'
                          check (kind in ('RECOMMENDATION','UPDATE','CORRECTION')),
  entry_key             text        not null,
  supersedes            text        null,

  -- identity
  user_id               uuid        not null default auth.uid(),
  sport                 text        null,
  game_id               text        null,
  matchup               text        null,
  kickoff               timestamptz null,

  -- the selection, exactly as it was offered
  market                text        null,
  selection             text        null,
  handicap              numeric     null,
  odds_decimal          numeric     null,
  odds_american         text        null,
  book                  text        null,
  quote_captured_at     timestamptz null,

  -- the decision and what produced it
  decision              text        not null
                          check (decision in ('BET CANDIDATE','WATCH','PASS','INSUFFICIENT DATA')),
  strength              text        null,
  probability           numeric     null,
  probability_source    text        null,
  expected_value        numeric     null,
  price_limit_american  text        null,
  evidence_version      text        null,
  evidence_packet_id    text        null,
  model_version         text        null,
  engine_version        text        null,
  decision_config       jsonb       null,
  reason                text        null,

  -- forward record or backtest. Never mixed.
  mode                  text        not null default 'FORWARD'
                          check (mode in ('FORWARD','BACKTEST')),

  published_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),

  -- graded afterwards by the settle pipeline, and ONLY these columns may move
  result                text        null check (result in ('win','loss','push','void','cancelled')),
  closing_probability   numeric     null,
  closing_captured_at   timestamptz null,
  clv                   numeric     null,
  beat_close            boolean     null,
  graded_at             timestamptz null,

  constraint recommendation_ledger_entry_key_uniq unique (entry_key)
);

-- A forward recommendation that postdates kickoff is leakage, not a record.
alter table public.recommendation_ledger
  drop constraint if exists recommendation_ledger_no_lookahead;
alter table public.recommendation_ledger
  add constraint recommendation_ledger_no_lookahead
  check (mode <> 'FORWARD' or kickoff is null or published_at <= kickoff);

-- ---------------------------------------------------------------------------
-- OFFICIAL RESULT CORRECTIONS, AS APPENDED EVENTS.
--
-- Immutability was solving the right problem the wrong way round. A graded
-- outcome must never be quietly rewritten -- that is how a losing record turns
-- into a winning one -- but official results DO get corrected: a scoring change
-- after review, a game ruled a no-contest, a book voiding a market it settled
-- in error. A ledger that makes those impossible is not honest either; it just
-- carries a number everyone knows is wrong and cannot say so.
--
-- So the original row stays exactly as written, forever, and the correction is
-- a NEW row: kind='CORRECTION', supersedes=<original entry_key>, carrying the
-- corrected result and the reason it changed. Both rows are in the table. The
-- history is the point.
--
-- recommendation_record reads the corrected outcome where one exists and counts
-- the corrections separately, so measurement reflects what actually happened
-- while the correction itself stays visible rather than absorbed.
-- ---------------------------------------------------------------------------
alter table public.recommendation_ledger
  add column if not exists correction_reason text null,
  add column if not exists correction_source text null,
  add column if not exists corrected_at      timestamptz null;

-- A correction has to say what it corrects and why. Nothing else may.
alter table public.recommendation_ledger
  drop constraint if exists recommendation_ledger_correction_shape;
alter table public.recommendation_ledger
  add constraint recommendation_ledger_correction_shape
  check (
    (kind <> 'CORRECTION')
    or (supersedes is not null and result is not null
        and correction_reason is not null and correction_source is not null)
  );

alter table public.recommendation_ledger
  drop constraint if exists recommendation_ledger_correction_only;
alter table public.recommendation_ledger
  add constraint recommendation_ledger_correction_only
  check (kind = 'CORRECTION' or correction_reason is null);

-- A correction must point at a row that exists. Without this a typo in
-- `supersedes` produces a correction that silently corrects nothing.
create or replace function public.recommendation_ledger_correction_target()
returns trigger language plpgsql as $$
begin
  if new.kind <> 'CORRECTION' then return new; end if;
  if not exists (select 1 from public.recommendation_ledger o
                 where o.entry_key = new.supersedes and o.kind = 'RECOMMENDATION') then
    raise exception
      'recommendation_ledger correction % names supersedes=% and no RECOMMENDATION row carries that entry_key. A correction that corrects nothing is worse than none.',
      new.entry_key, new.supersedes;
  end if;
  if new.corrected_at is null then new.corrected_at := now(); end if;
  return new;
end $$;

drop trigger if exists recommendation_ledger_correction_trg on public.recommendation_ledger;
create trigger recommendation_ledger_correction_trg
  before insert on public.recommendation_ledger
  for each row execute function public.recommendation_ledger_correction_target();

create index if not exists recommendation_ledger_user_idx    on public.recommendation_ledger (user_id, published_at desc);
create index if not exists recommendation_ledger_game_idx    on public.recommendation_ledger (game_id, market, selection);
create index if not exists recommendation_ledger_grade_idx   on public.recommendation_ledger (mode, decision, result);
create index if not exists recommendation_ledger_super_idx   on public.recommendation_ledger (supersedes) where supersedes is not null;

-- ---------------------------------------------------------------------------
-- IMMUTABILITY. Everything that describes the decision is frozen at insert.
-- The grading columns are the only ones that may ever change, and they may
-- only change from null — a result cannot be rewritten once it is recorded.
-- ---------------------------------------------------------------------------
create or replace function public.recommendation_ledger_immutable()
returns trigger language plpgsql as $$
begin
  if  new.entry_key          is distinct from old.entry_key
   or new.kind               is distinct from old.kind
   or new.user_id            is distinct from old.user_id
   or new.sport              is distinct from old.sport
   or new.game_id            is distinct from old.game_id
   or new.market             is distinct from old.market
   or new.selection          is distinct from old.selection
   or new.handicap           is distinct from old.handicap
   or new.odds_decimal       is distinct from old.odds_decimal
   or new.book               is distinct from old.book
   or new.decision           is distinct from old.decision
   or new.strength           is distinct from old.strength
   or new.probability        is distinct from old.probability
   or new.expected_value     is distinct from old.expected_value
   or new.evidence_packet_id is distinct from old.evidence_packet_id
   or new.model_version      is distinct from old.model_version
   or new.mode               is distinct from old.mode
   or new.published_at       is distinct from old.published_at
  then
    raise exception
      'recommendation_ledger row % is immutable. Record a change as a new row with kind=UPDATE and supersedes=%, never by editing the original.',
      old.entry_key, old.entry_key;
  end if;

  -- grading is write-once as well: a recorded outcome is never rewritten
  if old.result is not null and new.result is distinct from old.result then
    raise exception 'recommendation_ledger row % already carries result %. A graded outcome is not rewritten.', old.entry_key, old.result;
  end if;
  return new;
end $$;

drop trigger if exists recommendation_ledger_immutable_trg on public.recommendation_ledger;
create trigger recommendation_ledger_immutable_trg
  before update on public.recommendation_ledger
  for each row execute function public.recommendation_ledger_immutable();

-- Deletion would erase the record this table exists to keep.
create or replace function public.recommendation_ledger_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'recommendation_ledger rows are never deleted. The record of what was published is the point of the table.';
end $$;
drop trigger if exists recommendation_ledger_no_delete_trg on public.recommendation_ledger;
create trigger recommendation_ledger_no_delete_trg
  before delete on public.recommendation_ledger
  for each row execute function public.recommendation_ledger_no_delete();

-- ---------------------------------------------------------------------------
-- RLS: a user writes and reads their own ledger. Nothing else.
-- ---------------------------------------------------------------------------
alter table public.recommendation_ledger enable row level security;

drop policy if exists recommendation_ledger_select_own on public.recommendation_ledger;
create policy recommendation_ledger_select_own on public.recommendation_ledger
  for select using (user_id = auth.uid());

drop policy if exists recommendation_ledger_insert_own on public.recommendation_ledger;
create policy recommendation_ledger_insert_own on public.recommendation_ledger
  for insert with check (user_id = auth.uid());

-- The grading update is allowed through RLS; the trigger above is what keeps
-- it to the grading columns.
drop policy if exists recommendation_ledger_update_own on public.recommendation_ledger;
create policy recommendation_ledger_update_own on public.recommendation_ledger
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.recommendation_ledger to authenticated;
grant usage, select on sequence public.recommendation_ledger_id_seq to authenticated;

-- ---------------------------------------------------------------------------
-- MEASUREMENT. One row per (mode, sport, market, decision) so the forward
-- record can never be summed with a backtest by accident, and so a headline
-- number can never be quoted without its sample size beside it.
--
-- Pushes are counted, excluded from the win rate, and INCLUDED in amount
-- staked, because a pushed stake really was at risk. Voids are excluded from
-- both. ROI is on amount staked.
-- ---------------------------------------------------------------------------
create or replace view public.recommendation_record as
  with corrected as (
    -- The LATEST correction per original, if any. Corrections are appended, so
    -- a row can be corrected more than once and the most recent one stands.
    select distinct on (c.supersedes)
      c.supersedes as entry_key, c.result as result, c.corrected_at
    from public.recommendation_ledger c
    where c.kind = 'CORRECTION'
    order by c.supersedes, c.corrected_at desc, c.created_at desc
  ),
  r as (
    -- Every originally published recommendation, wearing its corrected result
    -- where one was appended. The original row is untouched on disk; this is a
    -- read-time overlay, which is the only way both facts survive.
    select
      o.mode, o.sport, o.market, o.decision, o.odds_decimal, o.probability,
      o.clv, o.beat_close, o.kind,
      coalesce(x.result, o.result) as result,
      o.result                     as result_as_published,
      (x.entry_key is not null)    as was_corrected
    from public.recommendation_ledger o
    left join corrected x on x.entry_key = o.entry_key
    where o.kind = 'RECOMMENDATION'
  )
  select
    r.mode,
    r.sport,
    r.market,
    r.decision,
    count(*)                                              as n_published,
    count(*) filter (where r.result is not null)          as n_settled,
    count(*) filter (where r.result = 'win')              as wins,
    count(*) filter (where r.result = 'loss')             as losses,
    count(*) filter (where r.result = 'push')             as pushes,
    count(*) filter (where r.result in ('void','cancelled')) as voids,
    count(*) filter (where r.result in ('win','loss'))    as n_decided,
    -- win rate over DECIDED outcomes only; a push is neither
    case when count(*) filter (where r.result in ('win','loss')) > 0
      then round(count(*) filter (where r.result = 'win')::numeric
                 / count(*) filter (where r.result in ('win','loss')), 4)
    end                                                   as win_rate,
    -- units on a flat 1-unit stake
    round(coalesce(sum(case
      when r.result = 'win'  then r.odds_decimal - 1
      when r.result = 'loss' then -1
      else 0 end), 0), 3)                                 as units,
    count(*) filter (where r.result in ('win','loss','push')) as amount_staked,
    case when count(*) filter (where r.result in ('win','loss','push')) > 0
      then round(coalesce(sum(case
        when r.result = 'win'  then r.odds_decimal - 1
        when r.result = 'loss' then -1
        else 0 end), 0)
        / count(*) filter (where r.result in ('win','loss','push')), 4)
    end                                                   as roi_on_staked,
    round(avg(r.clv) filter (where r.clv is not null), 4)  as avg_clv,
    count(*) filter (where r.clv is not null)             as n_clv,
    case when count(*) filter (where r.beat_close is not null) > 0
      then round(count(*) filter (where r.beat_close)::numeric
                 / count(*) filter (where r.beat_close is not null), 4)
    end                                                   as beat_close_rate,
    -- Brier, over rows that carried a published probability and settled
    case when count(*) filter (where r.probability is not null and r.result in ('win','loss')) > 0
      then round(avg(power(r.probability - (case when r.result = 'win' then 1 else 0 end), 2))
        filter (where r.probability is not null and r.result in ('win','loss')), 5)
    end                                                   as brier,
    count(*) filter (where r.probability is not null and r.result in ('win','loss')) as n_brier,
    -- the honesty gate: below this the point estimate means nothing
    (count(*) filter (where r.result in ('win','loss')) >= 100) as sufficient_sample,
    count(*) filter (where r.was_corrected)               as n_corrected
  from r
  group by r.mode, r.sport, r.market, r.decision;

grant select on public.recommendation_record to authenticated;

comment on view public.recommendation_record is
  'Forward and backtest populations are separate rows and must never be summed. '
  'A win rate with n_decided under 100 is not evidence of anything; sufficient_sample says so. '
  'Outcomes reflect appended CORRECTION rows where they exist; the original rows are never edited, '
  'and n_corrected counts how many results in this population were officially corrected.';

commit;

/* ---------------------------------------------------------------------------
   TELL POSTGREST THE TABLE EXISTS.

   Applying this file is not the last step, and finding that out the hard way
   cost a release. A live run on 2026-09-15 created the table, the indexes, the
   triggers, the policies and the view, committed cleanly — and the deployment
   doctor, one second later, still reported

     NOT_APPLIED  recommendation_ledger — the table is not in the schema

   because PostgREST caches the database schema in memory and had started
   before this table existed. Everything that reaches this table goes through
   PostgREST: the doctor's check, and the edge function's insert. So a
   perfectly applied migration left the ledger invisible to the only clients
   that use it, and edgedesk_ai went on failing its writes with the SAME
   "schema cache" error the migration was supposed to end.

   NOTIFY is queued and delivered at COMMIT, so it fires after everything above
   is durable, and it is harmless to repeat — which matters, because this file
   is written to be re-appliable and ledger_sql.test.js applies it twice.
   --------------------------------------------------------------------------- */
notify pgrst, 'reload schema';
