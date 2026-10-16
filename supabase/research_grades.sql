-- =============================================================================
-- research_grades — the database mirror of the A–F Research Grade ledger
-- (docs/research-grade/). The committed, hash-chained streams written hourly by
-- tools/performance/run.js are the source of truth: perf_research_grades
-- (every pregame grade revision) and perf_grade_outcomes (each settled
-- outcome of a game's latest valid pregame grade), plus perf_grade_performance.
--
-- ENFORCED: append-only for every role; the chain; no grade captured at or
-- after its start; an outcome names a stored grade captured before the game
-- and carries its letter; the letter is the score's (A 90+, B 80+, C 70+,
-- D 60+, F below); server_recorded_at is the server's. Reads: outcomes and the
-- aggregate public, grades once their game started, the log server-only.
-- Standalone of model_performance.sql. Rollback: research_grades_rollback.sql.
-- Idempotent, additive, no psql meta-commands, ends in a report.
-- =============================================================================

create table if not exists public.perf_research_grades (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  league             text,
  season             int,
  start_utc          timestamptz not null,
  captured_at        timestamptz not null,
  grade_version      text not null,
  weights_version    text,
  model_id           text,
  model_version      text,
  grade_state        text not null check (grade_state in ('GRADED', 'INSUFFICIENT')),
  letter             text check (letter is null or letter in ('A', 'B', 'C', 'D', 'F')),
  score              int check (score is null or (score >= 0 and score <= 100)),
  market_status      text,
  forecast_hash      text,
  revision           int not null check (revision >= 1),
  supersedes         text,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_research_grades_pregame check (captured_at < start_utc),
  constraint perf_research_grades_letter check ((grade_state = 'GRADED') = (letter is not null and score is not null)
    and (letter is null or letter = case when score >= 90 then 'A' when score >= 80 then 'B' when score >= 70 then 'C' when score >= 60 then 'D' else 'F' end)),
  constraint perf_research_grades_revision check ((revision = 1) = (supersedes is null)),
  constraint perf_research_grades_file_seq unique (ledger_file, seq)
);
create index if not exists perf_rg_event_idx on public.perf_research_grades (event_key, captured_at);
create index if not exists perf_rg_letter_idx on public.perf_research_grades (sport, letter, start_utc);

create table if not exists public.perf_grade_outcomes (
  hash               text primary key check (hash ~ '^[0-9a-f]{64}$'),
  ledger_file        text not null,
  seq                int not null check (seq >= 1),
  prev               text not null,
  event_key          text not null,
  sport              text not null,
  league             text,
  season             int,
  start_utc          timestamptz not null,
  snapshot_hash      text not null references public.perf_research_grades (hash),
  letter             text check (letter is null or letter in ('A', 'B', 'C', 'D', 'F')),
  score              int,
  grade_version      text,
  model_id           text,
  settlement_state   text not null check (settlement_state in ('SETTLED', 'VOID', 'UNSETTLED')),
  eligible           boolean not null,
  why                text,
  brier              numeric check (brier is null or (brier >= 0 and brier <= 1)),
  margin_abs_error   numeric,
  total_abs_error    numeric,
  ats_result         text check (ats_result is null or ats_result in ('win', 'loss', 'push')),
  ou_result          text check (ou_result is null or ou_result in ('win', 'loss', 'push')),
  revision           int not null check (revision >= 1),
  supersedes         text,
  reason             text not null,
  row                jsonb not null,
  server_recorded_at timestamptz not null default now(),
  constraint perf_grade_outcomes_revision check ((revision = 1) = (supersedes is null)),
  constraint perf_grade_outcomes_settled check (not eligible or settlement_state = 'SETTLED'),
  constraint perf_grade_outcomes_file_seq unique (ledger_file, seq)
);
create index if not exists perf_go_event_idx on public.perf_grade_outcomes (event_key, revision desc);
create index if not exists perf_go_letter_idx on public.perf_grade_outcomes (sport, letter, start_utc);
create index if not exists perf_go_version_idx on public.perf_grade_outcomes (grade_version, letter);

create table if not exists public.perf_rg_ingest_runs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null,
  run         text,
  git_sha     text,
  received    int not null,
  inserted    int not null,
  already     int not null
);

create or replace function public.perf_rg_append_only() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is append-only: % is refused', tg_table_name, tg_op using errcode = 'restrict_violation';
end $$;
create or replace function public.perf_rg_stamp() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.server_recorded_at := now();
  return new;
end $$;
create or replace function public.perf_rg_outcome_check() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare g record;
begin
  select captured_at, letter, grade_state into g from public.perf_research_grades where hash = new.snapshot_hash;
  if not found then raise exception 'perf_grade_outcomes: no stored research grade %', new.snapshot_hash using errcode = 'foreign_key_violation'; end if;
  if g.captured_at >= new.start_utc then
    raise exception 'perf_grade_outcomes: grade captured at or after the start (%, start %)', g.captured_at, new.start_utc using errcode = 'check_violation';
  end if;
  if new.letter is distinct from g.letter then
    raise exception 'perf_grade_outcomes: letter % differs from the grade''s %', coalesce(new.letter, 'none'), coalesce(g.letter, 'none') using errcode = 'check_violation';
  end if;
  return new;
end $$;

do $blk$
declare t text;
begin
  foreach t in array array['perf_research_grades', 'perf_grade_outcomes', 'perf_rg_ingest_runs'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.perf_rg_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.perf_rg_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on public.%I from service_role', t);
      execute format('grant select on public.%I to service_role', t);
    end if;
  end loop;
  foreach t in array array['perf_research_grades', 'perf_grade_outcomes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_stamp_trg', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.perf_rg_stamp()', t || '_stamp_trg', t);
  end loop;
  drop trigger if exists perf_grade_outcomes_check_trg on public.perf_grade_outcomes;
  create trigger perf_grade_outcomes_check_trg before insert on public.perf_grade_outcomes for each row execute function public.perf_rg_outcome_check();
end $blk$;

drop policy if exists perf_research_grades_read on public.perf_research_grades;
create policy perf_research_grades_read on public.perf_research_grades for select to anon, authenticated using (start_utc <= now());
drop policy if exists perf_grade_outcomes_read on public.perf_grade_outcomes;
create policy perf_grade_outcomes_read on public.perf_grade_outcomes for select to anon, authenticated using (true);
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then grant select on public.perf_research_grades, public.perf_grade_outcomes to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant select on public.perf_research_grades, public.perf_grade_outcomes to authenticated; end if;
end $g$;

create or replace function public.perf_research_ingest(p_kind text, p_rows jsonb, p_run text default null, p_git_sha text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_in int := 0; v_new int := 0; r jsonb; x jsonb; v_prev text; v_n int; v_tbl text;
begin
  if p_kind not in ('research_grades', 'grade_outcomes') then raise exception 'perf_research_ingest: unknown stream %', p_kind; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'perf_research_ingest: an array of rows'; end if;
  v_tbl := case when p_kind = 'research_grades' then 'perf_research_grades' else 'perf_grade_outcomes' end;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_in := v_in + 1;
    x := r -> 'row';
    execute format('select hash from public.%I where ledger_file = $1 and seq = $2', v_tbl) into v_prev using r ->> 'ledger_file', (r ->> 'seq')::int - 1;
    if v_prev is not null and v_prev <> r ->> 'prev' then
      raise exception 'perf_research_ingest: % seq % does not follow the stored chain', r ->> 'ledger_file', r ->> 'seq' using errcode = 'restrict_violation';
    end if;
    if (r ->> 'seq')::int = 1 and r ->> 'prev' <> 'GENESIS' then raise exception 'perf_research_ingest: % must start the chain', r ->> 'ledger_file'; end if;
    if p_kind = 'research_grades' then
      insert into public.perf_research_grades (hash, ledger_file, seq, prev, event_key, sport, league, season, start_utc, captured_at, grade_version, weights_version,
        model_id, model_version, grade_state, letter, score, market_status, forecast_hash, revision, supersedes, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', x ->> 'league', (x ->> 'season')::int,
        (r ->> 'start_utc')::timestamptz, (x ->> 'captured_at')::timestamptz, x -> 'versions' ->> 'grade', x -> 'versions' ->> 'weights',
        x -> 'versions' ->> 'model_id', x -> 'versions' ->> 'model_version', x -> 'grade' ->> 'state', x -> 'grade' ->> 'letter', (x -> 'grade' ->> 'score')::int,
        x -> 'market' ->> 'status', x -> 'forecast' ->> 'hash', coalesce((x ->> 'revision')::int, 1), x ->> 'supersedes', x)
      on conflict (hash) do nothing;
    else
      insert into public.perf_grade_outcomes (hash, ledger_file, seq, prev, event_key, sport, league, season, start_utc, snapshot_hash, letter, score, grade_version,
        model_id, settlement_state, eligible, why, brier, margin_abs_error, total_abs_error, ats_result, ou_result, revision, supersedes, reason, row)
      values (r ->> 'hash', r ->> 'ledger_file', (r ->> 'seq')::int, r ->> 'prev', r ->> 'event_key', r ->> 'sport', x ->> 'league', (x ->> 'season')::int,
        (r ->> 'start_utc')::timestamptz, x ->> 'snapshot_hash', x ->> 'letter', (x ->> 'score')::int, x ->> 'grade_version', x ->> 'model_id',
        x -> 'settlement' ->> 'state', (x ->> 'eligible')::boolean, x ->> 'why', (x -> 'winner' ->> 'brier')::numeric, (x -> 'spread' ->> 'abs_error')::numeric,
        (x -> 'total' ->> 'abs_error')::numeric, x -> 'market' -> 'spread' -> 'pick' ->> 'result', x -> 'market' -> 'total' -> 'pick' ->> 'result',
        (x ->> 'revision')::int, x ->> 'supersedes', x ->> 'reason', x)
      on conflict (hash) do nothing;
    end if;
    get diagnostics v_n = row_count;
    v_new := v_new + v_n;
  end loop;
  insert into public.perf_rg_ingest_runs (kind, run, git_sha, received, inserted, already) values (p_kind, p_run, p_git_sha, v_in, v_new, v_in - v_new);
  return jsonb_build_object('received', v_in, 'inserted', v_new, 'already_present', v_in - v_new);
end $$;
create or replace function public.perf_research_heads() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(k, s), '{}'::jsonb) from (
    select 'research_grades|' || ledger_file as k, max(seq) as s from public.perf_research_grades group by ledger_file
    union all select 'grade_outcomes|' || ledger_file, max(seq) from public.perf_grade_outcomes group by ledger_file) h
$$;
do $f$
begin
  revoke all on function public.perf_research_ingest(text, jsonb, text, text) from public;
  revoke all on function public.perf_research_heads() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.perf_research_ingest(text, jsonb, text, text) from anon; revoke all on function public.perf_research_heads() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.perf_research_ingest(text, jsonb, text, text) from authenticated; revoke all on function public.perf_research_heads() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.perf_research_ingest(text, jsonb, text, text) to service_role; grant execute on function public.perf_research_heads() to service_role; end if;
end $f$;

-- latest outcome per game; a rate only from 20 settled games
create or replace view public.perf_grade_outcomes_latest with (security_invoker = true) as
select distinct on (event_key) * from public.perf_grade_outcomes order by event_key, revision desc;
create or replace view public.perf_grade_performance with (security_invoker = true) as
select coalesce(sport, 'all') as sport, grade_version, coalesce(letter, 'INSUFFICIENT') as letter,
  count(*) as games, count(*) filter (where eligible) as settled, round(avg(score), 1) as avg_score,
  count(b) as brier_n, case when count(b) >= 20 then round(avg(b), 4) end as brier,
  count(m) as margin_n, case when count(m) >= 20 then round(avg(m), 2) end as margin_mae, case when count(m) >= 20 then round(sqrt(avg(m ^ 2)), 2) end as margin_rmse,
  count(t) as total_n, case when count(t) >= 20 then round(avg(t), 2) end as total_mae, case when count(t) >= 20 then round(sqrt(avg(t ^ 2)), 2) end as total_rmse,
  count(*) filter (where ats = 'win') as ats_w, count(*) filter (where ats = 'loss') as ats_l, count(*) filter (where ats = 'push') as ats_p,
  count(*) filter (where ou = 'win') as ou_w, count(*) filter (where ou = 'loss') as ou_l, count(*) filter (where ou = 'push') as ou_p,
  min(start_utc) filter (where eligible) as first_start, max(start_utc) filter (where eligible) as last_start
from (select sport, grade_version, letter, score, eligible, start_utc, case when eligible then brier end as b, case when eligible then margin_abs_error end as m,
  case when eligible then total_abs_error end as t, case when eligible then ats_result end as ats, case when eligible then ou_result end as ou
  from public.perf_grade_outcomes_latest) o
group by grouping sets ((sport, grade_version, letter), (grade_version, letter));
do $v$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then grant select on public.perf_grade_outcomes_latest, public.perf_grade_performance to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant select on public.perf_grade_outcomes_latest, public.perf_grade_performance to authenticated; end if;
end $v$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'research grade tables' as piece, case when to_regclass('public.perf_research_grades') is not null and to_regclass('public.perf_grade_outcomes') is not null
  and to_regclass('public.perf_rg_ingest_runs') is not null then 'ok' else 'CHECK THIS' end as state
union all
select 'append-only triggers', case when (select count(*) from pg_trigger where tgname ~ '^perf_(research_grades|grade_outcomes|rg_ingest_runs)_no_(update|truncate)_trg$') = 6 then 'ok' else 'CHECK THIS' end
union all
select 'server receipt stamps', case when (select count(*) from pg_trigger where tgname in ('perf_research_grades_stamp_trg', 'perf_grade_outcomes_stamp_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all
select 'outcomes judge only pregame grades', case when exists (select 1 from pg_trigger where tgname = 'perf_grade_outcomes_check_trg') then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select bool_and(relrowsecurity) from pg_class where relname in ('perf_research_grades', 'perf_grade_outcomes', 'perf_rg_ingest_runs')) then 'ok' else 'CHECK THIS' end
union all
select 'ingest log is server-only', case when not exists (select 1 from pg_policy where polrelid = 'public.perf_rg_ingest_runs'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'perf_research_ingest is security definer', case when (select prosecdef from pg_proc where oid = 'public.perf_research_ingest(text, jsonb, text, text)'::regprocedure) then 'ok' else 'CHECK THIS' end
union all
select 'aggregate view is security invoker', case when (select coalesce(reloptions, '{}') @> array['security_invoker=true'] from pg_class where oid = 'public.perf_grade_performance'::regclass) then 'ok' else 'CHECK THIS' end;
