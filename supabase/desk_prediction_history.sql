-- =============================================================================
-- desk_prediction_history — the frozen pregame record behind Similar Situations.
--
-- WHAT IT IS
--   One row per selection the AI Desk put in front of a reader at a CURRENT,
--   pregame price: the selection, the line and price at capture, EdgeDesk's
--   number, the value in points, the cover probability and edge, the verdict,
--   the validation tier, the confidence and evidence-quality scores, the
--   model version, and the typed-evidence feature vector (EDDESK.historyRecord).
--   Written by the edgedesk_ai function (deskTurn) under the caller's token.
--
-- WHY IT EXISTS
--   "Has EdgeDesk been right in situations like this?" needs frozen pregame
--   predictions beside settled results, compared on information that existed
--   before kickoff. Until enough of them exist, the desk says "building
--   history" (EDDESK.SIMILAR_MIN_TOTAL_SETTLED / SIMILAR_MIN_SETTLED) and no
--   historical claim reaches an answer.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Write once, never deleted (triggers).
--   2. No look-ahead: captured_at must precede kickoff (trigger).
--   3. `features` may carry only the pregame keys EDDESK.PREGAME_FEATURES
--      names; a postgame key (result, score, close, CLV, outcome...) is
--      refused at insert (trigger), so nothing learned after the game can
--      enter a similarity vector.
--   4. Finals live in their own write-once table and are joined by the view.
--      A final settled before its kickoff is not a final and is ignored.
--   5. The rows are EdgeDesk's predictions, not a reader's data: they carry no
--      user id and no question text, and every signed-in reader may read them.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.desk_prediction_history (
  id                  bigint generated always as identity primary key,
  record_id           text not null unique,
  schema              text not null default 'edgedesk_prediction_history_v1',
  created_at          timestamptz not null default now(),
  captured_at         timestamptz not null,
  sport               text not null,
  game_id             text not null,
  home_team           text,
  away_team           text,
  kickoff             timestamptz not null,
  market              text not null check (market in ('spread','total','moneyline')),
  side                text not null check (side in ('home','away','over','under')),
  selection           text,
  line                numeric,
  odds                numeric,
  book                text,
  fair_line           numeric,
  value_points        numeric,
  cover_prob          numeric,
  edge_pp             numeric,
  verdict             text check (verdict in ('VALUE','THIN','NO_VALUE','OVERPRICED')),
  tier                text,
  confidence_grade    text check (confidence_grade in ('HIGH','MEDIUM','LOW','INSUFFICIENT')),
  confidence_score    numeric,
  evidence_quality    numeric,
  model_version       text,
  market_home_line    numeric,
  projection_home_line numeric,
  features            jsonb not null default '{}'::jsonb,
  typed_evidence      jsonb
);

comment on table public.desk_prediction_history is
  'Frozen pregame AI Desk selections: price at capture, EdgeDesk number, value, tier, confidence and the pregame feature vector. Write-once, never deleted, captured before kickoff.';

create index if not exists desk_history_game_idx on public.desk_prediction_history (sport, game_id);
create index if not exists desk_history_bucket_idx on public.desk_prediction_history (sport, market, tier);

-- 1. WRITE ONCE.
create or replace function public.desk_history_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'desk_prediction_history is write-once: record % cannot be updated', old.record_id
    using errcode = 'restrict_violation';
end $$;
drop trigger if exists desk_history_immutable_trg on public.desk_prediction_history;
create trigger desk_history_immutable_trg
  before update on public.desk_prediction_history
  for each row execute function public.desk_history_immutable();

-- 2. NEVER DELETED.
create or replace function public.desk_history_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'desk_prediction_history rows are never deleted (record %)', old.record_id
    using errcode = 'restrict_violation';
end $$;
drop trigger if exists desk_history_no_delete_trg on public.desk_prediction_history;
create trigger desk_history_no_delete_trg
  before delete on public.desk_prediction_history
  for each row execute function public.desk_history_no_delete();

-- 3. PREGAME ONLY, AND NO POSTGAME KEY IN THE FEATURE VECTOR.
create or replace function public.desk_history_pregame()
returns trigger language plpgsql as $$
declare bad text;
begin
  if new.captured_at >= new.kickoff then
    raise exception 'desk_prediction_history: record % was captured at % which is not before kickoff %', new.record_id, new.captured_at, new.kickoff
      using errcode = 'check_violation';
  end if;
  select string_agg(k, ', ') into bad from jsonb_object_keys(coalesce(new.features, '{}'::jsonb)) k
   where k in ('result','home_score','away_score','final_margin','close_line','close_price','clv','clv_points','settled','settled_at','outcome','won','graded','ats_result');
  if bad is not null then
    raise exception 'desk_prediction_history: record % carries postgame keys in its features (%)', new.record_id, bad
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists desk_history_pregame_trg on public.desk_prediction_history;
create trigger desk_history_pregame_trg
  before insert on public.desk_prediction_history
  for each row execute function public.desk_history_pregame();

-- 4. FINALS: one per game, written by the settlement job (service role), write-once.
create table if not exists public.desk_prediction_finals (
  sport           text not null,
  game_id         text not null,
  home_score      int not null check (home_score >= 0),
  away_score      int not null check (away_score >= 0),
  close_home_line numeric,
  close_total     numeric,
  settled_at      timestamptz not null,
  source          text not null,
  primary key (sport, game_id),
  check (not (home_score = 0 and away_score = 0))
);
comment on table public.desk_prediction_finals is
  'Final scores and captured closes for games in desk_prediction_history. Written by tools/intelligence/desk_history.js from the Collective settlement record. 0-0 is never a final.';
create or replace function public.desk_finals_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'desk_prediction_finals is write-once (% %)', old.sport, old.game_id using errcode = 'restrict_violation';
end $$;
drop trigger if exists desk_finals_immutable_trg on public.desk_prediction_finals;
create trigger desk_finals_immutable_trg
  before update or delete on public.desk_prediction_finals
  for each row execute function public.desk_finals_immutable();

-- 5. ROW LEVEL SECURITY. EdgeDesk's predictions, readable by every signed-in
-- reader; inserted by the function under a reader's token; finals by the
-- service role only.
alter table public.desk_prediction_history enable row level security;
drop policy if exists desk_history_insert on public.desk_prediction_history;
create policy desk_history_insert on public.desk_prediction_history
  for insert to authenticated with check (true);
drop policy if exists desk_history_select on public.desk_prediction_history;
create policy desk_history_select on public.desk_prediction_history
  for select to authenticated using (true);
grant select, insert on public.desk_prediction_history to authenticated;
grant usage, select on sequence public.desk_prediction_history_id_seq to authenticated;
alter table public.desk_prediction_finals enable row level security;
drop policy if exists desk_finals_select on public.desk_prediction_finals;
create policy desk_finals_select on public.desk_prediction_finals
  for select to authenticated using (true);
grant select on public.desk_prediction_finals to authenticated;

-- THE SETTLED VIEW: every record beside its final, graded by the same rule as
-- tools/intelligence/desk_history.js (outcomeOf). `features` is the frozen
-- pregame vector; the result columns sit beside it and never inside it.
create or replace view public.desk_prediction_history_settled as
select
  h.record_id, h.sport, h.game_id, h.home_team, h.away_team, h.kickoff, h.captured_at, h.market, h.side, h.selection, h.line, h.odds,
  h.fair_line, h.value_points, h.cover_prob, h.edge_pp, h.verdict, h.tier, h.confidence_grade, h.confidence_score,
  h.evidence_quality, h.model_version, h.features,
  (f.game_id is not null and f.settled_at > h.kickoff) as settled,
  case when f.game_id is null or f.settled_at <= h.kickoff then null
       else (case
         when h.market = 'spread' then sign((case when h.side = 'home' then f.home_score - f.away_score else f.away_score - f.home_score end) + h.line)
         when h.market = 'total' then sign(case when h.side = 'over' then (f.home_score + f.away_score) - h.line else h.line - (f.home_score + f.away_score) end)
         when h.market = 'moneyline' then sign(case when h.side = 'home' then f.home_score - f.away_score else f.away_score - f.home_score end)
       end) end as outcome_sign,
  case when f.game_id is null or f.settled_at <= h.kickoff then null
       else (case
         (case
           when h.market = 'spread' then sign((case when h.side = 'home' then f.home_score - f.away_score else f.away_score - f.home_score end) + h.line)
           when h.market = 'total' then sign(case when h.side = 'over' then (f.home_score + f.away_score) - h.line else h.line - (f.home_score + f.away_score) end)
           when h.market = 'moneyline' then sign(case when h.side = 'home' then f.home_score - f.away_score else f.away_score - f.home_score end)
         end) when 1 then 'WIN' when -1 then 'LOSS' else 'PUSH' end) end as outcome,
  case when f.game_id is null or f.settled_at <= h.kickoff then null
       when h.market = 'spread' and f.close_home_line is not null then h.line - (case when h.side = 'home' then f.close_home_line else -f.close_home_line end)
       when h.market = 'total' and f.close_total is not null then (case when h.side = 'over' then f.close_total - h.line else h.line - f.close_total end)
       else null end as clv_points
from public.desk_prediction_history h
left join public.desk_prediction_finals f on f.sport = h.sport and f.game_id = h.game_id;

grant select on public.desk_prediction_history_settled to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'desk_prediction_history table' as piece,
       case when to_regclass('public.desk_prediction_history') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'write-once trigger', case when exists (select 1 from pg_trigger where tgname = 'desk_history_immutable_trg') then 'ok' else 'CHECK THIS' end
union all
select 'no-delete trigger', case when exists (select 1 from pg_trigger where tgname = 'desk_history_no_delete_trg') then 'ok' else 'CHECK THIS' end
union all
select 'pregame trigger', case when exists (select 1 from pg_trigger where tgname = 'desk_history_pregame_trg') then 'ok' else 'CHECK THIS' end
union all
select 'finals table', case when to_regclass('public.desk_prediction_finals') is not null then 'ok' else 'CHECK THIS' end
union all
select 'settled view', case when to_regclass('public.desk_prediction_history_settled') is not null then 'ok' else 'CHECK THIS' end;
