-- =============================================================================
-- model_loop.sql — the model loop's append-only rating snapshots.
-- docs/model-loop/README.md
--
-- WHAT IT IS
--   One row per (sport, model version, slate, entity) rating snapshot written
--   by the shared framework (model_loop/core/snapshots.py), mirrored from the
--   committed ledger model_loop/ledger/<sport>/<season>.jsonl:
--     the entity's ratings (e.g. NFL pass_off / pass_def / rush_off / rush_def
--     / market, or a quarterback's value) and, for every rating, the part that
--     came from the prior and the part that came from this season's data;
--     the model version and the sha256 of the exact configuration that fitted
--     it; the slate it was fitted for and when.
--
-- WHY IT EXISTS
--   "What did the model believe before this game?" is answered by a row that
--   was written before the game and never changed. The weekly update writes
--   new rows with the same formula; it never rewrites an old one.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only: no UPDATE, no DELETE (the service role included). The
--      snapshot id is a hash of the row's content, so re-sending a row is a
--      no-op.
--   2. Row level security: authenticated readers read; anon reads nothing;
--      only model_rating_snapshots_ingest() (service role) writes.
--
-- ROLLBACK: drop table public.model_rating_snapshots cascade; the committed
-- JSONL ledger stays the source of truth.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.model_rating_snapshots (
  snapshot_id     text primary key check (snapshot_id ~ '^mls_[0-9a-f]{32}$'),
  sport           text not null check (sport in ('NFL', 'CFB', 'MLB', 'WNBA', 'CBB', 'UFC', 'TENNIS')),
  model_key       text not null,
  model_version   text not null,
  config_sha256   text not null check (config_sha256 ~ '^[0-9a-f]{64}$'),
  season          int not null,
  slate_key       text not null,                -- NFL/CFB: week number; daily sports: the date; UFC/tennis: the event id
  fitted_at       timestamptz not null,
  entity_type     text not null check (entity_type in ('team', 'player', 'league')),
  entity_id       text not null,
  ratings         jsonb not null,               -- {name: value}
  from_prior      jsonb not null default '{}'::jsonb,
  from_season     jsonb not null default '{}'::jsonb,
  ingested_at     timestamptz not null default now()
);
create index if not exists model_rating_snapshots_lookup
  on public.model_rating_snapshots (sport, model_version, season, slate_key, entity_type, entity_id);

create or replace function public.model_rating_snapshots_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'model_rating_snapshots is append-only: % is refused (a rating snapshot is never rewritten)', tg_op;
end $$;
drop trigger if exists model_rating_snapshots_no_update_trg on public.model_rating_snapshots;
create trigger model_rating_snapshots_no_update_trg before update or delete on public.model_rating_snapshots
  for each row execute function public.model_rating_snapshots_guard();

alter table public.model_rating_snapshots enable row level security;
drop policy if exists model_rating_snapshots_read on public.model_rating_snapshots;
create policy model_rating_snapshots_read on public.model_rating_snapshots for select to authenticated using (true);
revoke all on public.model_rating_snapshots from anon;
revoke insert, update, delete on public.model_rating_snapshots from authenticated;

-- the only writer: an array of ledger rows; rows already present are skipped
create or replace function public.model_rating_snapshots_ingest(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'model_rating_snapshots_ingest: an array of snapshot rows'; end if;
  insert into public.model_rating_snapshots (snapshot_id, sport, model_key, model_version, config_sha256, season, slate_key,
                                             fitted_at, entity_type, entity_id, ratings, from_prior, from_season)
  select r ->> 'snapshot_id', r ->> 'sport', r ->> 'model_key', r ->> 'model_version', r ->> 'config_sha256',
         (r ->> 'season')::int, r ->> 'slate_key', (r ->> 'fitted_at')::timestamptz, r ->> 'entity_type', r ->> 'entity_id',
         r -> 'ratings', coalesce(r -> 'from_prior', '{}'::jsonb), coalesce(r -> 'from_season', '{}'::jsonb)
    from jsonb_array_elements(p_rows) r
  on conflict (snapshot_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.model_rating_snapshots_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.model_rating_snapshots_ingest(jsonb) to service_role;

-- THE REPORT: every row should say ok
select 'table' as piece, case when to_regclass('public.model_rating_snapshots') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'append-only trigger', case when exists (select 1 from pg_trigger where tgname = 'model_rating_snapshots_no_update_trg') then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.model_rating_snapshots'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'ingest function (service role only)', case when has_function_privilege('service_role', 'public.model_rating_snapshots_ingest(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.model_rating_snapshots_ingest(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end;
