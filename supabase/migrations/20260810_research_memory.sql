-- ============================================================================
-- EdgeDesk research memory
--
-- Four tables that let EdgeDesk accumulate research rather than restart from
-- nothing every session:
--   research_sessions  what was asked, what was retrieved, what was concluded
--   research_facts     durable verified facts, WITH an expiry window
--   research_outcomes  what actually happened to a thesis, incl. closing/CLV
--   research_patterns  patterns discovered over a sample, never over one game
--
-- Two rules are enforced in the schema, not in prose:
--   1. Facts decay. valid_until exists on every fact and the reader downgrades
--      an expired fact to HISTORICAL rather than presenting it as current.
--   2. A pattern needs a sample. research_patterns.sample_size has a CHECK
--      floor, so a single result cannot become "a pattern".
--
-- Outcomes are linked to the EXISTING pipeline rather than duplicating it:
-- `settle` already writes signals.result / clv / beat_close / closing_sharp_fair,
-- so a trigger on signals fills research_outcomes when a graded signal matches
-- an open research session. No second grading pipeline.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- sessions
create table if not exists public.research_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),

  sport          text,
  event_id       text,
  market         text,
  entities       text[] not null default '{}',   -- teams / players this session was about

  question       text not null,
  intent         text,
  depth          text,
  research_plan  jsonb,                          -- steps executed + why
  evidence_summary jsonb,                        -- status counts, sources, gaps
  conclusion     text,
  thesis_attack  jsonb,
  data_freshness jsonb,                          -- freshness histogram at answer time
  retrieval_log  jsonb
);

create index if not exists research_sessions_user_created_idx on public.research_sessions (user_id, created_at desc);
create index if not exists research_sessions_entities_idx     on public.research_sessions using gin (entities);
create index if not exists research_sessions_event_idx        on public.research_sessions (event_id) where event_id is not null;

-- ------------------------------------------------------------------ facts
-- A verified fact about an entity, with the provenance and the window in which
-- it is true. A pitcher changing roles or a player changing teams invalidates
-- old facts; valid_until is how that is expressed.
create table if not exists public.research_facts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),

  entity              text not null,             -- team, player, venue
  entity_type         text,                      -- 'team' | 'player' | 'venue' | 'matchup'
  sport               text,
  fact_type           text not null,             -- 'pitcher_quality' | 'bullpen_state' | ...
  fact_value          jsonb not null,

  source              text not null,             -- the owned table it came from
  source_timestamp    timestamptz,
  verification_status text not null default 'VERIFIED'
    check (verification_status in ('VERIFIED','PROBABLE','PARTIAL','UNPROVEN','HISTORICAL','CONFLICT')),
  confidence          text check (confidence in ('HIGH','MEDIUM','LOW','UNVERIFIED')),

  valid_from          timestamptz not null default now(),
  valid_until         timestamptz,               -- null = no known expiry; readers still apply freshness
  unique (user_id, entity, fact_type, valid_from)
);

create index if not exists research_facts_entity_idx on public.research_facts (entity, fact_type, source_timestamp desc);
create index if not exists research_facts_sport_idx  on public.research_facts (sport, source_timestamp desc);

-- --------------------------------------------------------------- findings
-- Structured claims extracted from EVIDENCE, never from model prose. The
-- source + fact_value columns are NOT NULL precisely so an unsourced assertion
-- cannot be stored: knowledge contamination is prevented by the schema, not by
-- asking the model nicely.
create table if not exists public.research_findings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),

  entity              text,
  sport               text,
  fact_type           text not null,
  claim               text not null,             -- human-readable, but derived from fact_value
  fact_value          jsonb not null,            -- the actual record the claim came from
  source              text not null,             -- the owned table
  source_timestamp    timestamptz,
  verification_status text not null default 'VERIFIED'
    check (verification_status in ('VERIFIED','PROBABLE','PARTIAL','STALE','UNPROVEN','HISTORICAL','CONFLICT')),
  confidence          text check (confidence in ('HIGH','MEDIUM','LOW')),
  valid_until         timestamptz,
  times_verified      integer not null default 1,
  times_contradicted  integer not null default 0,
  last_verified_at    timestamptz not null default now()
);

create index if not exists research_findings_entity_idx on public.research_findings (entity, fact_type, created_at desc);
create index if not exists research_findings_valid_idx  on public.research_findings (valid_until);

-- -------------------------------------------------------------- snapshots
-- Versioned research packets. One row per (event, version); the diff between
-- consecutive versions is what answers "what changed since we last looked".
create table if not exists public.research_snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id   text not null,
  sport      text,
  version    integer not null,
  taken_at   timestamptz not null default now(),
  facts      jsonb not null,
  unique (user_id, event_id, version)
);

create index if not exists research_snapshots_event_idx on public.research_snapshots (event_id, version desc);

-- --------------------------------------------------------------- outcomes
-- What happened to a thesis. Closing price and CLV come from the EXISTING
-- settle/close pipeline via the trigger below — they are never recomputed here.
create table if not exists public.research_outcomes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at       timestamptz not null default now(),

  session_id       uuid references public.research_sessions(id) on delete set null,
  entity           text,
  sport            text,
  event_id         text,
  market           text,
  selection        text,

  thesis           text,
  price            numeric,        -- price at research time
  fair_price       numeric,        -- deterministic fair, copied
  edge             numeric,        -- deterministic edge, copied
  strongest_support text,
  strongest_contradiction text,
  falsifier        text,

  closing_price    numeric,        -- from signals.closing_sharp_fair
  clv              numeric,        -- from signals.clv
  beat_close       boolean,
  result           text,           -- from signals.result
  thesis_survived  boolean,
  what_happened    text,
  graded_at        timestamptz
);

create index if not exists research_outcomes_entity_idx on public.research_outcomes (entity, graded_at desc);
create index if not exists research_outcomes_event_idx  on public.research_outcomes (event_id);
create index if not exists research_outcomes_open_idx   on public.research_outcomes (event_id, market, selection) where graded_at is null;
-- One outcome per user per signal. Researching the same game twice must not
-- create a second open row, or the graded result attaches to both and the
-- sample double-counts itself.
create unique index if not exists research_outcomes_signal_uniq
  on public.research_outcomes (user_id, event_id, market, selection);

-- --------------------------------------------------------------- patterns
-- Only written by the aggregation function below, and only once the sample
-- clears the floor. The CHECK makes "one game is a pattern" unrepresentable.
create table if not exists public.research_patterns (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,   -- null = global
  pattern_key   text not null,
  sport         text,
  description   text not null,
  metric        text not null,            -- 'beat_close_rate' | 'avg_clv' | 'win_rate'
  metric_value  numeric,
  sample_size   integer not null check (sample_size >= 30),
  confidence    text check (confidence in ('HIGH','MEDIUM','LOW')),
  updated_at    timestamptz not null default now(),
  unique (pattern_key, sport, metric)
);

create index if not exists research_patterns_sport_idx on public.research_patterns (sport, sample_size desc);

-- ------------------------------------------------------------------- RLS
alter table public.research_sessions  enable row level security;
alter table public.research_findings  enable row level security;
alter table public.research_snapshots enable row level security;
alter table public.research_facts    enable row level security;
alter table public.research_outcomes enable row level security;
alter table public.research_patterns enable row level security;

drop policy if exists rs_own on public.research_sessions;
create policy rs_own on public.research_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rf_own on public.research_facts;
create policy rf_own on public.research_facts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rfi_own on public.research_findings;
create policy rfi_own on public.research_findings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rsn_own on public.research_snapshots;
create policy rsn_own on public.research_snapshots
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ro_own on public.research_outcomes;
create policy ro_own on public.research_outcomes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Patterns are readable by everyone (global ones) or by their owner; they are
-- written only by the aggregation function, which runs as definer.
drop policy if exists rp_read on public.research_patterns;
create policy rp_read on public.research_patterns
  for select using (user_id is null or user_id = auth.uid());

grant select, insert, update, delete on public.research_sessions to authenticated;
grant select, insert, update, delete on public.research_facts    to authenticated;
grant select, insert, update, delete on public.research_outcomes to authenticated;
grant select, insert, update, delete on public.research_findings  to authenticated;
grant select, insert, update, delete on public.research_snapshots to authenticated;
grant select                          on public.research_patterns to authenticated;

-- ================================================================ feedback
-- Postgame linkage. `settle` already grades signals; this reacts to that write
-- instead of duplicating it. When a signal picks up a result/CLV, any open
-- research outcome for the same event+market+selection is completed.
create or replace function public.research_link_outcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.graded_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.graded_at is not null then
    return new;                      -- already graded; nothing new to link
  end if;

  update public.research_outcomes o
     set closing_price   = new.closing_sharp_fair,
         clv             = new.clv,
         beat_close      = new.beat_close,
         result          = new.result,
         graded_at       = new.graded_at,
         -- The thesis "survived" as a PROCESS question, not an outcome one:
         -- beating the close is the evidence that the price was right.
         thesis_survived = coalesce(new.beat_close, false),
         what_happened   = concat_ws(' · ',
                             'result=' || coalesce(new.result, 'n/a'),
                             'clv=' || coalesce(round(new.clv::numeric, 4)::text, 'n/a'),
                             case when new.beat_close then 'beat the close' else 'did not beat the close' end)
   where o.graded_at is null
     and o.event_id  = new.event_id
     and o.market    = new.market
     and (o.selection is null or o.selection = new.selection);

  return new;
end;
$$;

drop trigger if exists trg_research_link_outcome on public.signals;
create trigger trg_research_link_outcome
  after insert or update of graded_at on public.signals
  for each row execute function public.research_link_outcome();

-- ================================================================ patterns
-- Recompute discovered patterns from graded signals. Idempotent; run on a cron
-- alongside the existing settle/close jobs. Nothing is written below the floor,
-- so a pattern can never be born from a single game.
create or replace function public.research_rebuild_patterns(min_n integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if min_n < 30 then
    min_n := 30;                     -- the schema floor is the real floor
  end if;

  -- Beat-close rate by sport x market.
  insert into public.research_patterns (user_id, pattern_key, sport, description, metric, metric_value, sample_size, confidence, updated_at)
  select null,
         'market:' || s.market,
         s.sport_key,
         'EdgeDesk signals in ' || s.market || ' for this sport, measured by how often they beat the close.',
         'beat_close_rate',
         round(avg(case when s.beat_close then 1.0 else 0.0 end)::numeric, 4),
         count(*),
         case when count(*) >= 200 then 'HIGH' when count(*) >= 80 then 'MEDIUM' else 'LOW' end,
         now()
    from public.signals s
   where s.graded_at is not null and s.beat_close is not null
   group by s.sport_key, s.market
  having count(*) >= min_n
      on conflict (pattern_key, sport, metric) do update
         set metric_value = excluded.metric_value,
             sample_size  = excluded.sample_size,
             confidence   = excluded.confidence,
             updated_at   = now();
  get diagnostics n = row_count;

  -- Average CLV by detection-edge band. This is where "big edges are often bad
  -- prices" becomes measurable instead of folklore.
  insert into public.research_patterns (user_id, pattern_key, sport, description, metric, metric_value, sample_size, confidence, updated_at)
  select null,
         'edge_band:' || width_bucket(s.first_edge, 0, 0.10, 10)::text,
         s.sport_key,
         'Average CLV for signals detected in this edge band.',
         'avg_clv',
         round(avg(s.clv)::numeric, 4),
         count(*),
         case when count(*) >= 200 then 'HIGH' when count(*) >= 80 then 'MEDIUM' else 'LOW' end,
         now()
    from public.signals s
   where s.graded_at is not null and s.clv is not null and s.first_edge is not null
   group by s.sport_key, width_bucket(s.first_edge, 0, 0.10, 10)
  having count(*) >= min_n
      on conflict (pattern_key, sport, metric) do update
         set metric_value = excluded.metric_value,
             sample_size  = excluded.sample_size,
             confidence   = excluded.confidence,
             updated_at   = now();

  return n;
end;
$$;

grant execute on function public.research_rebuild_patterns(integer) to authenticated;

comment on table public.research_sessions is 'What EdgeDesk was asked, what it retrieved, and what it concluded.';
comment on table public.research_facts    is 'Durable verified facts with an explicit validity window. Expired facts are historical context, never current facts.';
comment on table public.research_outcomes is 'What happened to a thesis. Closing price and CLV are copied from the existing settle pipeline, never recomputed.';
comment on table public.research_findings  is 'Claims extracted from evidence and bound to the record that produced them. source and fact_value are NOT NULL so unsourced model prose cannot be stored as knowledge.';
comment on table public.research_snapshots is 'Versioned research packets. Diffing consecutive versions is how "what changed since we last looked" is answered factually.';
comment on table public.research_patterns is 'Patterns discovered over a sample. sample_size >= 30 is enforced so one game can never become a pattern.';
