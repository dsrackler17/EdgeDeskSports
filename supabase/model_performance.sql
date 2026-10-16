-- =============================================================================
-- model_performance — the database mirror of the public model performance
-- ledger. docs/model-performance/DESIGN.md §7 · docs/model-performance/RUNBOOK.md
--
-- WHAT IT IS
--   A mirror of the committed, hash-chained ledger (performance/ledger/*.jsonl,
--   the source of truth, written hourly by tools/performance/run.js). It adds a
--   server-stamped receipt time per row, append-only enforced for every role,
--   and an ingest audit log. perf_forecasts, perf_quotes, perf_results and
--   perf_grades mirror the four streams; perf_ingest_runs is server-only.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only: no UPDATE, DELETE or TRUNCATE (service role included).
--      A row's id is its ledger hash; re-sending one is a no-op.
--   2. Chain: a row whose predecessor (same file, seq - 1) is present must
--      name that predecessor's hash as prev, or the ingest is refused.
--   3. Pregame: a ledger capture before the start; nothing predicted or
--      recorded at or after it.
--   4. server_recorded_at is stamped by the server, never by the caller.
--   5. Reads: results and grades public; forecasts and quotes once their game
--      has started; the ingest log server-only. Only perf_ingest() writes.
--
-- ROLLBACK: supabase/model_performance_rollback.sql (drops only this file's
-- objects; the committed ledger remains the source of truth).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.perf_forecasts (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  start_utc          timestamptz not null,
  tier               text not null check (tier in ('VERIFIED', 'RECORDED')),
  method             text not null,
  captured_at        timestamptz,
  recorded_at        timestamptz,
  predicted_at       timestamptz,
  model_id           text,
  p_home             numeric check (p_home is null or (p_home >= 0 and p_home <= 1)),
  fair_home_line     numeric,
  fair_total         numeric,
  expected_total     numeric,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_forecasts_tier_method check ((tier = 'VERIFIED') = (method = 'ledger_capture')),
  constraint perf_forecasts_pregame check (
    (method <> 'ledger_capture' or (captured_at is not null and captured_at < start_utc))
    and (predicted_at is null or predicted_at < start_utc)
    and (recorded_at is null or recorded_at < start_utc)),
  constraint perf_forecasts_file_seq unique (ledger_file, seq)
);
create index if not exists perf_forecasts_event_idx on public.perf_forecasts (event_key, start_utc);

create table if not exists public.perf_quotes (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  start_utc          timestamptz not null,
  captured_at        timestamptz not null,
  book               text,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_quotes_pregame check (captured_at < start_utc),
  constraint perf_quotes_file_seq unique (ledger_file, seq)
);
create index if not exists perf_quotes_event_idx on public.perf_quotes (event_key, captured_at);

create table if not exists public.perf_results (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  start_utc          timestamptz,
  state              text not null check (state in ('FINAL', 'VOID')),
  void_reason        text,
  home_score         int check (home_score is null or home_score >= 0),
  away_score         int check (away_score is null or away_score >= 0),
  revision           int not null check (revision >= 1),
  supersedes         text,
  reason             text not null,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_results_revision check ((revision = 1) = (supersedes is null)),
  constraint perf_results_final_scores check (state <> 'FINAL' or (home_score is not null and away_score is not null and not (home_score = 0 and away_score = 0))),
  constraint perf_results_file_seq unique (ledger_file, seq)
);
create index if not exists perf_results_event_idx on public.perf_results (event_key, revision);

create table if not exists public.perf_grades (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  start_utc          timestamptz,
  grader             text not null,
  forecast_hash      text,
  forecast_tier      text check (forecast_tier is null or forecast_tier in ('VERIFIED', 'RECORDED')),
  result_hash        text,
  eligible           boolean not null,
  why                text,
  revision           int not null check (revision >= 1),
  supersedes         text,
  reason             text not null,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_grades_revision check ((revision = 1) = (supersedes is null)),
  constraint perf_grades_file_seq unique (ledger_file, seq)
);
create index if not exists perf_grades_event_idx on public.perf_grades (event_key, revision);

create table if not exists public.perf_ingest_runs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null,
  run         text,
  git_sha     text,
  received    int not null,
  inserted    int not null,
  already     int not null
);

-- append-only for every role (service_role bypasses RLS, not triggers)
create or replace function public.perf_append_only() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is append-only: % is refused (a performance record is never rewritten)', tg_table_name, tg_op using errcode = 'restrict_violation';
end $$;
-- the receipt time is the server's
create or replace function public.perf_stamp() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.server_recorded_at := now();
  return new;
end $$;

do $blk$
declare t text;
begin
  foreach t in array array['perf_forecasts', 'perf_quotes', 'perf_results', 'perf_grades', 'perf_ingest_runs'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.perf_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.perf_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on public.%I from service_role', t);
      execute format('grant select on public.%I to service_role', t);
    end if;
  end loop;
  foreach t in array array['perf_forecasts', 'perf_quotes', 'perf_results', 'perf_grades'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_stamp_trg', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.perf_stamp()', t || '_stamp_trg', t);
  end loop;
end $blk$;

-- reads: results, grades; forecasts and quotes once the game has started
drop policy if exists perf_forecasts_read on public.perf_forecasts;
create policy perf_forecasts_read on public.perf_forecasts for select to anon, authenticated using (start_utc <= now());
drop policy if exists perf_quotes_read on public.perf_quotes;
create policy perf_quotes_read on public.perf_quotes for select to anon, authenticated using (start_utc <= now());
drop policy if exists perf_results_read on public.perf_results;
create policy perf_results_read on public.perf_results for select to anon, authenticated using (true);
drop policy if exists perf_grades_read on public.perf_grades;
create policy perf_grades_read on public.perf_grades for select to anon, authenticated using (true);
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant select on public.perf_forecasts, public.perf_quotes, public.perf_results, public.perf_grades to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.perf_forecasts, public.perf_quotes, public.perf_results, public.perf_grades to authenticated;
  end if;
end $g$;

-- the one write path: insert-only, idempotent on the ledger hash, chain-checked, logged
create or replace function public.perf_ingest(p_kind text, p_rows jsonb, p_run text default null, p_git_sha text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_in int := 0; v_new int := 0; r jsonb; v_prev text; v_n int;
begin
  if p_kind not in ('forecasts', 'quotes', 'results', 'grades') then raise exception 'perf_ingest: unknown stream %', p_kind; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'perf_ingest: an array of ledger rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_in := v_in + 1;
    -- the chain: a present predecessor must be the row this one names
    execute format('select hash from public.%I where ledger_file = $1 and seq = $2', 'perf_' || p_kind) into v_prev using r ->> 'ledger_file', (r ->> 'seq')::int - 1;
    if v_prev is not null and v_prev <> r ->> 'prev' then
      raise exception 'perf_ingest: % seq % does not follow the stored chain', r ->> 'ledger_file', r ->> 'seq' using errcode = 'restrict_violation';
    end if;
    if (r ->> 'seq')::int = 1 and r ->> 'prev' <> 'GENESIS' then raise exception 'perf_ingest: the first row of % must start the chain', r ->> 'ledger_file'; end if;
    if p_kind = 'forecasts' then
      insert into public.perf_forecasts (hash, ledger_file, seq, prev, event_key, sport, start_utc, tier, method, captured_at, recorded_at, predicted_at, model_id,
        p_home, fair_home_line, fair_total, expected_total, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', (r ->> 'start_utc')::timestamptz,
        case when r -> 'row' -> 'capture' ->> 'method' = 'ledger_capture' then 'VERIFIED' else 'RECORDED' end, r -> 'row' -> 'capture' ->> 'method',
        (r -> 'row' -> 'capture' ->> 'captured_at')::timestamptz, (r -> 'row' -> 'capture' ->> 'recorded_at')::timestamptz, (r -> 'row' -> 'model' ->> 'predicted_at')::timestamptz,
        r -> 'row' -> 'model' ->> 'id', (r -> 'row' -> 'forecast' ->> 'p_home')::numeric, (r -> 'row' -> 'forecast' ->> 'fair_home_line')::numeric,
        (r -> 'row' -> 'forecast' ->> 'fair_total')::numeric, (r -> 'row' -> 'forecast' ->> 'expected_total')::numeric, r -> 'row')
      on conflict (hash) do nothing;
    elsif p_kind = 'quotes' then
      insert into public.perf_quotes (hash, ledger_file, seq, prev, event_key, sport, start_utc, captured_at, book, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', (r ->> 'start_utc')::timestamptz,
        (r -> 'row' ->> 'captured_at')::timestamptz, r -> 'row' ->> 'book', r -> 'row')
      on conflict (hash) do nothing;
    elsif p_kind = 'results' then
      insert into public.perf_results (hash, ledger_file, seq, prev, event_key, sport, start_utc, state, void_reason, home_score, away_score, revision, supersedes, reason, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', (r ->> 'start_utc')::timestamptz,
        r -> 'row' ->> 'state', r -> 'row' ->> 'void_reason', (r -> 'row' ->> 'home_score')::int, (r -> 'row' ->> 'away_score')::int,
        (r -> 'row' ->> 'revision')::int, r -> 'row' ->> 'supersedes', r -> 'row' ->> 'reason', r -> 'row')
      on conflict (hash) do nothing;
    else
      insert into public.perf_grades (hash, ledger_file, seq, prev, event_key, sport, start_utc, grader, forecast_hash, forecast_tier, result_hash, eligible, why, revision, supersedes, reason, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', (r ->> 'start_utc')::timestamptz,
        r -> 'row' ->> 'grader', r -> 'row' ->> 'forecast_hash', r -> 'row' ->> 'forecast_tier', r -> 'row' ->> 'result_hash', (r -> 'row' ->> 'eligible')::boolean,
        r -> 'row' ->> 'why', (r -> 'row' ->> 'revision')::int, r -> 'row' ->> 'supersedes', r -> 'row' ->> 'reason', r -> 'row')
      on conflict (hash) do nothing;
    end if;
    get diagnostics v_n = row_count;
    v_new := v_new + v_n;
  end loop;
  insert into public.perf_ingest_runs (kind, run, git_sha, received, inserted, already) values (p_kind, p_run, p_git_sha, v_in, v_new, v_in - v_new);
  return jsonb_build_object('received', v_in, 'inserted', v_new, 'already_present', v_in - v_new);
end $$;
-- each ledger file's head, so a sync sends only what is new
create or replace function public.perf_heads() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(k, s), '{}'::jsonb) from (
    select 'forecasts|' || ledger_file as k, max(seq) as s from public.perf_forecasts group by ledger_file
    union all select 'quotes|' || ledger_file, max(seq) from public.perf_quotes group by ledger_file
    union all select 'results|' || ledger_file, max(seq) from public.perf_results group by ledger_file
    union all select 'grades|' || ledger_file, max(seq) from public.perf_grades group by ledger_file) h
$$;
do $f$
begin
  revoke all on function public.perf_ingest(text, jsonb, text, text) from public;
  revoke all on function public.perf_heads() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.perf_ingest(text, jsonb, text, text) from anon; revoke all on function public.perf_heads() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.perf_ingest(text, jsonb, text, text) from authenticated; revoke all on function public.perf_heads() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.perf_ingest(text, jsonb, text, text) to service_role; grant execute on function public.perf_heads() to service_role; end if;
end $f$;

-- was this forecast on the server before its game started?
create or replace view public.perf_forecast_attestation with (security_invoker = true) as
select event_key, sport, hash, tier, captured_at, server_recorded_at, start_utc, server_recorded_at < start_utc as server_pregame
from public.perf_forecasts;
do $v$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then grant select on public.perf_forecast_attestation to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant select on public.perf_forecast_attestation to authenticated; end if;
end $v$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'perf tables' as piece, case when to_regclass('public.perf_forecasts') is not null and to_regclass('public.perf_quotes') is not null
  and to_regclass('public.perf_results') is not null and to_regclass('public.perf_grades') is not null and to_regclass('public.perf_ingest_runs') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'append-only triggers', case when (select count(*) from pg_trigger where tgname like 'perf\_%\_no\_update\_trg' escape '\') = 5
  and (select count(*) from pg_trigger where tgname like 'perf\_%\_no\_truncate\_trg' escape '\') = 5 then 'ok' else 'CHECK THIS' end
union all
select 'server receipt stamps', case when (select count(*) from pg_trigger where tgname like 'perf\_%\_stamp\_trg' escape '\') = 4 then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select bool_and(relrowsecurity) from pg_class where oid in ('public.perf_forecasts'::regclass, 'public.perf_quotes'::regclass,
  'public.perf_results'::regclass, 'public.perf_grades'::regclass, 'public.perf_ingest_runs'::regclass)) then 'ok' else 'CHECK THIS' end
union all
select 'ingest log is server-only', case when not exists (select 1 from pg_policy where polrelid = 'public.perf_ingest_runs'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'perf_ingest is security definer', case when (select prosecdef from pg_proc where oid = 'public.perf_ingest(text, jsonb, text, text)'::regprocedure) then 'ok' else 'CHECK THIS' end;
