-- =============================================================================
-- research_snapshots — what EdgeDesk said about a game, and exactly which
-- market it saw, at the time. docs/market-resilience/README.md (§ Audit)
--
-- WHAT IT IS
--   One row per change of a game's independent research state, mirrored from
--   the terminal build's append-only ledger
--   (football/cfb_terminal/history/<season>/research_snapshots.jsonl):
--     the projection (model version, published time, input version, fair
--     margin, total, win probability, sigma);
--     the market it was compared with (state LIVE / CACHED / HISTORICAL /
--     MANUAL / UNAVAILABLE / FAULT, sources, capture time, spread and total,
--     whether it was verified, the integrity failures and held quotes);
--     the three answers (research visibility, market integrity, betting
--     validation), the research disagreement, the verdict and the
--     model-only research priority.
--
-- WHY IT EXISTS
--   "What did EdgeDesk predict at the time?" and "what did we learn
--   afterwards?" must never blur. Grading reads these rows as written; a
--   later rebuild adds a new row, it never rewrites an old one.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only: no UPDATE, no DELETE, no TRUNCATE (the service role
--      included). A snapshot id is a hash of its content; a re-sync of the
--      same row is a no-op.
--   2. Pregame only: a snapshot observed at or after kickoff is refused.
--   3. The market state and the three answers are closed vocabularies.
--   4. Row level security: authenticated readers read; anon reads nothing;
--      only research_snapshots_ingest() (service role) writes.
--
-- ROLLBACK: supabase/research_snapshots_rollback.sql (drops only this file's
-- objects; the committed JSONL ledger remains the source of truth).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.research_snapshots (
  snapshot_id            text primary key check (snapshot_id ~ '^cfbr_[0-9a-f]{24}$'),
  schema                 text not null default 'edgedesk_research_snapshot_v1',
  observed_at            timestamptz not null,
  sport                  text not null default 'CFB',
  game_id                text not null,
  season                 int,
  week                   int,
  kickoff                timestamptz,
  model_version          text,
  prediction_ts          timestamptz,
  input_version          text,
  projection             jsonb,
  market_state           text not null check (market_state in ('LIVE', 'CACHED', 'HISTORICAL', 'MANUAL', 'UNAVAILABLE', 'FAULT')),
  market_sources         text[] not null default '{}',
  market_captured_at     timestamptz,
  market_spread_home_line numeric,
  market_total           numeric,
  market_verified        boolean not null default false,
  market_integrity_status text check (market_integrity_status in ('PASS', 'WARN', 'FAIL')),
  integrity_failures     jsonb not null default '[]'::jsonb,
  held_quotes            jsonb not null default '[]'::jsonb,
  provider_status        text,
  research_visibility    text not null check (research_visibility in ('AVAILABLE', 'LIMITED', 'UNAVAILABLE')),
  market_integrity       text not null check (market_integrity in ('VERIFIED', 'UNVERIFIED', 'FAULT', 'UNAVAILABLE')),
  betting_validation     text not null check (betting_validation in ('ELIGIBLE', 'BLOCKED')),
  research_disagreement  jsonb,
  research_verdict       text not null,
  research_priority      int check (research_priority between 0 and 100),
  engine                 jsonb,
  snapshot               jsonb not null,
  recorded_at            timestamptz not null default now(),
  -- what was predicted is a pregame record
  constraint research_snapshots_pregame check (kickoff is null or observed_at < kickoff),
  -- a market that is not LIVE and verified can never be betting-eligible
  constraint research_snapshots_betting_needs_live check (betting_validation = 'BLOCKED' or (market_state = 'LIVE' and market_verified)),
  -- a fault never carries a comparison number
  constraint research_snapshots_fault_withheld check (market_state <> 'FAULT' or (market_spread_home_line is null and market_total is null))
);
create index if not exists research_snapshots_game_idx on public.research_snapshots (game_id, observed_at desc);
create index if not exists research_snapshots_state_idx on public.research_snapshots (market_state, observed_at desc);

create or replace function public.research_snapshots_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'research_snapshots is append-only: % is refused (a prediction record is never rewritten)', tg_op;
end $$;
drop trigger if exists research_snapshots_no_update_trg on public.research_snapshots;
create trigger research_snapshots_no_update_trg before update or delete on public.research_snapshots
  for each row execute function public.research_snapshots_append_only();
drop trigger if exists research_snapshots_no_truncate_trg on public.research_snapshots;
create trigger research_snapshots_no_truncate_trg before truncate on public.research_snapshots
  for each statement execute function public.research_snapshots_append_only();

alter table public.research_snapshots enable row level security;
drop policy if exists research_snapshots_read on public.research_snapshots;
create policy research_snapshots_read on public.research_snapshots for select to authenticated using (true);
revoke all on public.research_snapshots from anon;
revoke insert, update, delete, truncate on public.research_snapshots from authenticated;
grant select on public.research_snapshots to authenticated;

-- the one write path: insert-only, idempotent on the content-hash id
create or replace function public.research_snapshots_ingest(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_in int := 0; v_new int := 0; r jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'research_snapshots_ingest: an array of snapshots'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_in := v_in + 1;
    insert into public.research_snapshots (snapshot_id, schema, observed_at, sport, game_id, season, week, kickoff, model_version, prediction_ts, input_version,
      projection, market_state, market_sources, market_captured_at, market_spread_home_line, market_total, market_verified, market_integrity_status,
      integrity_failures, held_quotes, provider_status, research_visibility, market_integrity, betting_validation, research_disagreement,
      research_verdict, research_priority, engine, snapshot)
    values (r ->> 'snapshot_id', coalesce(r ->> 'schema', 'edgedesk_research_snapshot_v1'), (r ->> 'observed_at')::timestamptz, coalesce(r ->> 'sport', 'CFB'),
      r ->> 'game_id', (r ->> 'season')::int, (r ->> 'week')::int, (r ->> 'kickoff')::timestamptz, r ->> 'model_version', (r ->> 'prediction_ts')::timestamptz,
      r ->> 'input_version', r -> 'projection', r -> 'market' ->> 'state',
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(r -> 'market' -> 'sources', '[]'::jsonb)) x), '{}'),
      (r -> 'market' ->> 'captured_at')::timestamptz, (r -> 'market' ->> 'spread_home_line')::numeric, (r -> 'market' ->> 'total')::numeric,
      coalesce((r -> 'market' ->> 'verified')::boolean, false), r -> 'market' ->> 'integrity_status',
      coalesce(r -> 'market' -> 'integrity_failures', '[]'::jsonb), coalesce(r -> 'market' -> 'held', '[]'::jsonb), r -> 'market' ->> 'provider',
      r ->> 'research_visibility', r ->> 'market_integrity', r ->> 'betting_validation', r -> 'research_disagreement',
      r ->> 'research_verdict', (r ->> 'research_priority')::int, r -> 'engine', r)
    on conflict (snapshot_id) do nothing;
    if found then v_new := v_new + 1; end if;
  end loop;
  return jsonb_build_object('received', v_in, 'inserted', v_new, 'already_present', v_in - v_new);
end $$;
revoke all on function public.research_snapshots_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.research_snapshots_ingest(jsonb) to service_role;

-- the latest snapshot per game (what EdgeDesk says now; history stays in the table)
create or replace view public.research_snapshot_latest with (security_invoker = true) as
select distinct on (game_id) * from public.research_snapshots order by game_id, observed_at desc;
grant select on public.research_snapshot_latest to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'research_snapshots table' as piece, case when to_regclass('public.research_snapshots') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'append-only trigger', case when exists (select 1 from pg_trigger where tgname = 'research_snapshots_no_update_trg') then 'ok' else 'CHECK THIS' end
union all
select 'no-truncate trigger', case when exists (select 1 from pg_trigger where tgname = 'research_snapshots_no_truncate_trg') then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.research_snapshots'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'ingest function', case when to_regprocedure('public.research_snapshots_ingest(jsonb)') is not null then 'ok' else 'CHECK THIS' end
union all
select 'latest view', case when to_regclass('public.research_snapshot_latest') is not null then 'ok' else 'CHECK THIS' end;
