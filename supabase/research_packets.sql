-- =============================================================================
-- research_packets — the immutable prediction ledger of EdgeDesk Intelligence.
--
-- WHAT IT IS
--   One row per normalised research packet the desk built for a single-game
--   football question BEFORE kickoff: the projection and its version, the
--   price it was compared against, the label the rules produced, the two
--   confidence scores, and the whole packet as JSON. Written by the
--   edgedesk_ai edge function under the caller's own token.
--
-- WHY IT EXISTS
--   "Has the model historically been calibrated in situations like this?"
--   cannot be answered from prose. It needs the prediction as it stood, the
--   closing price and the result, joined without a second identity map. The
--   packet carries the `sig_key` of the signal it priced against, and
--   `signals` already carries the close and the result for that key, so
--   research_packet_grades below is a plain join.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Write once. Every column is frozen by a trigger after insert.
--   2. No deletes. A prediction that embarrasses the model stays.
--   3. A forward record cannot postdate kickoff (trigger), so nothing built
--      after the game can masquerade as a prediction.
--   4. Row level security: a reader inserts and reads their own rows; the
--      service role reads everything for grading.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.research_packets (
  id              bigint generated always as identity primary key,
  packet_id       text not null unique,
  packet_hash     text not null,
  schema          text not null default 'edgedesk_prediction_record_v1',
  user_id         uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  built_at        timestamptz not null,
  sport           text,
  game_id         text,
  matchup         text,
  kickoff         timestamptz,
  season          int,
  week            int,
  model_version   text,
  kernel_version  int,
  model_home_line numeric,
  model_total     numeric,
  model_home_win_prob numeric,
  model_tier      text,
  market          text,
  selection       text,
  side            text,
  handicap        numeric,
  odds_decimal    numeric,
  book            text,
  captured_at     timestamptz,
  quote_freshness text,
  fair_probability numeric,
  fair_method     text,
  sig_key         text,
  gap_points      numeric,
  ev_per_unit     numeric,
  label           text check (label in ('PASS','RESEARCH LEAD','PRICE DEPENDENT','MODEL DISAGREEMENT','STALE MARKET','INSUFFICIENT DATA')),
  decision        text,
  data_confidence numeric,
  conclusion_confidence numeric,
  completeness    numeric,
  question        text,
  packet          jsonb
);

comment on table public.research_packets is
  'Immutable pregame research packets from EdgeDesk Intelligence. One row per packet; joined to signals by sig_key for closes and results. Never edited, never deleted.';

create index if not exists research_packets_game_idx on public.research_packets (sport, game_id, built_at desc);
create index if not exists research_packets_sig_idx on public.research_packets (sig_key) where sig_key is not null;
create index if not exists research_packets_model_idx on public.research_packets (model_version, label);
create index if not exists research_packets_user_idx on public.research_packets (user_id, created_at desc);

-- 1. WRITE ONCE.
create or replace function public.research_packets_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'research_packets is write-once: row % (packet %) cannot be updated', old.id, old.packet_id
    using errcode = 'restrict_violation';
end $$;
drop trigger if exists research_packets_immutable_trg on public.research_packets;
create trigger research_packets_immutable_trg
  before update on public.research_packets
  for each row execute function public.research_packets_immutable();

-- 2. NO DELETES.
create or replace function public.research_packets_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'research_packets rows are never deleted (row %, packet %)', old.id, old.packet_id
    using errcode = 'restrict_violation';
end $$;
drop trigger if exists research_packets_no_delete_trg on public.research_packets;
create trigger research_packets_no_delete_trg
  before delete on public.research_packets
  for each row execute function public.research_packets_no_delete();

-- 3. A FORWARD RECORD PRECEDES THE GAME.
create or replace function public.research_packets_no_lookahead()
returns trigger language plpgsql as $$
begin
  if new.kickoff is not null and new.built_at >= new.kickoff then
    raise exception 'research_packets: packet % was built at % which is not before kickoff %', new.packet_id, new.built_at, new.kickoff
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists research_packets_no_lookahead_trg on public.research_packets;
create trigger research_packets_no_lookahead_trg
  before insert on public.research_packets
  for each row execute function public.research_packets_no_lookahead();

-- 4. ROW LEVEL SECURITY.
alter table public.research_packets enable row level security;
drop policy if exists research_packets_insert_own on public.research_packets;
create policy research_packets_insert_own on public.research_packets
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists research_packets_select_own on public.research_packets;
create policy research_packets_select_own on public.research_packets
  for select to authenticated using (user_id = auth.uid());
grant select, insert on public.research_packets to authenticated;
grant usage, select on sequence public.research_packets_id_seq to authenticated;

-- THE GRADE: every packet beside the close and the result of the signal it
-- priced against, where `close` has written one. Nothing is estimated: a packet
-- with no sig_key, or whose signal has not closed, carries nulls and is counted
-- as ungraded. `signals` columns are read through to_jsonb so a deployment
-- whose signals table predates a column still builds the view.
create or replace view public.research_packet_grades as
select
  p.id, p.packet_id, p.built_at, p.sport, p.game_id, p.matchup, p.kickoff, p.season, p.week,
  p.model_version, p.model_tier, p.market, p.selection, p.side, p.handicap, p.odds_decimal, p.book,
  p.fair_probability, p.gap_points, p.ev_per_unit, p.label, p.decision,
  p.data_confidence, p.conclusion_confidence, p.sig_key,
  (to_jsonb(s) ->> 'closing_sharp_fair')::numeric  as closing_fair_probability,
  (to_jsonb(s) ->> 'closing_dec')::numeric         as closing_decimal,
  (to_jsonb(s) ->> 'closing_at_observed')::timestamptz as closing_observed_at,
  to_jsonb(s) ->> 'result'                          as result,
  (to_jsonb(s) ->> 'clv')::numeric                  as clv,
  case when (to_jsonb(s) ->> 'beat_close') in ('true','t','1') then true
       when (to_jsonb(s) ->> 'beat_close') in ('false','f','0') then false else null end as beat_close,
  case
    when p.sig_key is null then 'NO_SIGNAL_KEY'
    when s.sig_key is null then 'SIGNAL_NOT_FOUND'
    when to_jsonb(s) ->> 'closing_sharp_fair' is null then 'NOT_CLOSED'
    when to_jsonb(s) ->> 'result' is null then 'CLOSED_NO_RESULT'
    else 'GRADED'
  end as grade_state,
  -- Brier on the probability the packet actually used, against the graded result.
  case when to_jsonb(s) ->> 'result' in ('win','loss') and p.fair_probability is not null
       then power(p.fair_probability - case when to_jsonb(s) ->> 'result' = 'win' then 1 else 0 end, 2) end as brier
from public.research_packets p
left join public.signals s on s.sig_key = p.sig_key;

-- CALIBRATION BY MODEL VERSION AND LABEL. Counts, CLV and Brier where graded;
-- `sufficient_sample` is a floor, not a verdict.
create or replace view public.research_packet_calibration as
select
  model_version, sport, market, label,
  count(*)                                              as packets,
  count(*) filter (where grade_state = 'GRADED')        as graded,
  count(*) filter (where result = 'win')                as wins,
  count(*) filter (where result = 'loss')               as losses,
  count(*) filter (where result = 'push')               as pushes,
  avg(clv)  filter (where grade_state in ('GRADED','CLOSED_NO_RESULT')) as avg_clv,
  avg(case when beat_close then 1.0 else 0.0 end) filter (where beat_close is not null) as beat_close_rate,
  avg(brier) filter (where brier is not null)           as brier,
  avg(gap_points)                                       as avg_gap_points,
  (count(*) filter (where grade_state = 'GRADED')) >= 100 as sufficient_sample
from public.research_packet_grades
group by model_version, sport, market, label;

grant select on public.research_packet_grades to authenticated;
grant select on public.research_packet_calibration to authenticated;

-- PostgREST caches the schema; without this the table is invisible to the
-- function's insert until the next restart. Fires after commit.
notify pgrst, 'reload schema';

-- THE REPORT.
select 'research_packets table' as piece,
       case when to_regclass('public.research_packets') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'immutability trigger', case when exists (select 1 from pg_trigger where tgname = 'research_packets_immutable_trg') then 'ok' else 'CHECK THIS' end
union all
select 'no-delete trigger', case when exists (select 1 from pg_trigger where tgname = 'research_packets_no_delete_trg') then 'ok' else 'CHECK THIS' end
union all
select 'no-lookahead trigger', case when exists (select 1 from pg_trigger where tgname = 'research_packets_no_lookahead_trg') then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.research_packets'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'grades view', case when to_regclass('public.research_packet_grades') is not null then 'ok' else 'CHECK THIS' end
union all
select 'calibration view', case when to_regclass('public.research_packet_calibration') is not null then 'ok' else 'CHECK THIS' end;
