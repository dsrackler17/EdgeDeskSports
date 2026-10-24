-- =============================================================================
-- ncaaw_forecast.sql — EdgeDesk women's college basketball forecasts: model
-- versions, training snapshots, weekly evaluation reports, the champion
-- pointer, immutable pregame forecasts, Upset Watch, and the live-forecast
-- table (refused while live is disabled; no women's live writer exists).
-- NCAAW_MODEL_NOTES.md; runbook docs/ncaaw-forecast/README.md.
--
-- The men's layer (supabase/ncaam_forecast.sql, ncaam_fc_*) mirrored for the
-- women's game with its own tables, so neither system can read or move the
-- other's champion, runs or forecasts. Differences from the men's file: every
-- object is ncaaw_fc_*, the champion scope is 'ncaaw', and there is no live
-- observation function (the games slate carries no women's games).
--
-- PREREQUISITE: supabase/simulator.sql (this file reuses its fail-closed
-- premium gate public.sim_viewer_entitled() and its alert conventions). The
-- file refuses to run without it. It does not need supabase/ncaam_forecast.sql.
--
-- WHAT IT ADDS (every table named ncaaw_fc_*)
--   ncaaw_fc_snapshots        a training snapshot: the sha256 of every row a
--                             fit may read, its cut-off time (immutable)
--   ncaaw_fc_models           every model version ever evaluated: config and
--                             its sha256, code hash, snapshot (immutable)
--   ncaaw_fc_jobs             each weekly/refresh job attempt
--   ncaaw_fc_reports          each weekly evaluation report: champion,
--                             challenger, every gate, the decision (immutable)
--   ncaaw_fc_champion         THE MODEL POINTER (one row per scope)
--   ncaaw_fc_champion_history every INIT / PROMOTE / ROLLBACK (append-only)
--   ncaaw_fc_runs             one forecast publication attempt
--   ncaaw_fc_forecasts        per game: probability, margin and total
--                             distribution summaries, intervals, data-quality
--                             flags, availability assumption (frozen once the
--                             run is no longer running)
--   ncaaw_fc_upset_watch      per game: underdog and its basis, the separate
--                             signals, factors (frozen with the run)
--   ncaaw_fc_published        THE FORECAST POINTER (scope 'pregame')
--   ncaaw_fc_live_forecasts   live probabilities (append-only; refused while
--                             live is disabled)
--   ncaaw_fc_alerts           failures and refusals
--   ncaaw_fc_config           switches (live_enabled = 'false' by default)
--
-- PUBLICATION IS ATOMIC (service_role only): ncaaw_fc_begin_run ->
-- ncaaw_fc_put_forecasts / ncaaw_fc_put_upset -> ncaaw_fc_publish_run, which
-- re-checks every count and value and moves the pointer in ONE transaction
-- (or keeps a newer published run and marks this one superseded);
-- ncaaw_fc_fail_run never touches the pointer.
-- THE CHAMPION moves only through ncaaw_fc_set_champion: a PROMOTE needs a
-- stored report whose decision is PROMOTE for exactly that model; a ROLLBACK
-- needs a recorded model and a reason.
--
-- READS. Row level security on every table. A reader sees rows only when the
-- project's entitlement rule admits them (sim_viewer_entitled() ->
-- community_is_entitled: premium) and only for completed runs. anon may call
-- ncaaw_fc_public_status() (versions, freshness, decisions — never a number).
--
-- CONVENTION (supabase/README.md): idempotent, additive, no psql
-- meta-commands, ends in a report. Mirrored in
-- supabase/migrations/20261024180000_ncaaw_forecast.sql.
-- =============================================================================

create extension if not exists pgcrypto;

do $pre$
begin
  if to_regprocedure('public.sim_viewer_entitled()') is null or to_regprocedure('public.sim_keep()') is null then
    raise exception 'ncaaw_forecast.sql needs supabase/simulator.sql applied first (public.sim_viewer_entitled, public.sim_keep)';
  end if;
end $pre$;

begin;

-- ---------------------------------------------------------------- model evidence
create table if not exists public.ncaaw_fc_snapshots (
  snapshot_sha256 text primary key check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  through_at      timestamptz not null,
  row_count       integer not null check (row_count >= 0),
  seasons         jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists public.ncaaw_fc_models (
  model_key        text primary key check (model_key ~ '^[a-z0-9_]{2,40}@[0-9]+\.[0-9]+\.[0-9]+$'),
  model_id         text not null,
  version          text not null,
  engine           text not null check (engine in ('research_team_model', 'points_ratings')),
  config           jsonb not null,
  config_sha256    text not null check (config_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256      text check (code_sha256 is null or code_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256  text references public.ncaaw_fc_snapshots (snapshot_sha256),
  recorded_at      timestamptz not null default now(),
  check (model_key = model_id || '@' || version)
);

create table if not exists public.ncaaw_fc_jobs (
  job_id          uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('weekly', 'refresh', 'backtest')),
  status          text not null default 'running' check (status in ('running', 'completed', 'failed')),
  snapshot_sha256 text references public.ncaaw_fc_snapshots (snapshot_sha256),
  decision        text,
  error_summary   jsonb,
  runtime         jsonb not null default '{}'::jsonb,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error_summary is not null)
);

create table if not exists public.ncaaw_fc_reports (
  report_sha256   text primary key check (report_sha256 ~ '^[0-9a-f]{64}$'),
  job_id          uuid references public.ncaaw_fc_jobs (job_id),
  candidate       text not null,
  champion_key    text not null,
  challenger_key  text not null,
  decision        text not null check (decision in ('PROMOTE', 'RETAIN', 'INSUFFICIENT_EVIDENCE')),
  policy_version  text not null,
  gates           jsonb not null,
  summary         jsonb not null default '{}'::jsonb,
  report_path     text,
  created_at      timestamptz not null default now()
);
create index if not exists ncaaw_fc_reports_created_idx on public.ncaaw_fc_reports (created_at desc);

create table if not exists public.ncaaw_fc_champion (
  scope              text primary key check (scope in ('ncaaw')),
  model_key          text not null references public.ncaaw_fc_models (model_key),
  since              timestamptz not null default now(),
  decision           text not null check (decision in ('INIT', 'PROMOTE', 'ROLLBACK')),
  report_sha256      text references public.ncaaw_fc_reports (report_sha256),
  previous_model_key text references public.ncaaw_fc_models (model_key)
);

create table if not exists public.ncaaw_fc_champion_history (
  id            bigint generated always as identity primary key,
  scope         text not null,
  model_key     text not null references public.ncaaw_fc_models (model_key),
  replaced_key  text references public.ncaaw_fc_models (model_key),
  decision      text not null check (decision in ('INIT', 'PROMOTE', 'ROLLBACK')),
  report_sha256 text references public.ncaaw_fc_reports (report_sha256),
  reason        text,
  created_at    timestamptz not null default now(),
  check (decision <> 'PROMOTE' or report_sha256 is not null),
  check (decision <> 'ROLLBACK' or (reason is not null and char_length(reason) > 0))
);

-- ---------------------------------------------------------------- forecasts
create table if not exists public.ncaaw_fc_runs (
  run_id           uuid primary key default gen_random_uuid(),
  scope            text not null default 'pregame' check (scope in ('pregame')),
  idempotency_key  text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  model_key        text not null references public.ncaaw_fc_models (model_key),
  artifact_sha256  text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256  text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  as_of            timestamptz not null,
  expected_games   integer not null check (expected_games >= 0),
  status           text not null default 'running' check (status in ('running', 'completed', 'superseded', 'failed')),
  gates            jsonb not null default '[]'::jsonb,
  definitions      jsonb not null default '{}'::jsonb,
  upset_policy     jsonb,
  error_summary    jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  failed_at        timestamptz,
  check ((status in ('completed', 'superseded')) = (completed_at is not null)),
  check ((status = 'failed') = (failed_at is not null)),
  check (status <> 'failed' or error_summary is not null)
);
create unique index if not exists ncaaw_fc_runs_key_live_uk on public.ncaaw_fc_runs (idempotency_key) where status <> 'failed';
create index if not exists ncaaw_fc_runs_asof_idx on public.ncaaw_fc_runs (scope, as_of desc);

create table if not exists public.ncaaw_fc_forecasts (
  run_id        uuid not null references public.ncaaw_fc_runs (run_id) on delete restrict,
  game_id       text not null check (game_id ~ '^[0-9]{1,20}$'),
  start_utc     timestamptz not null,
  home_id       text not null,
  away_id       text not null,
  home_name     text not null,
  away_name     text not null,
  neutral       boolean not null,
  event         text,
  regime        text not null check (regime in ('D1_D1', 'D1_OTHER', 'OTHER_OTHER')),
  available     boolean not null,
  unavailable_reason text,
  p_home        double precision,
  p_ot          double precision,
  margin        jsonb,
  total         jsonb,
  pts_home      double precision,
  pts_away      double precision,
  games_played  jsonb not null default '{}'::jsonb,
  data_quality  jsonb not null default '[]'::jsonb,
  availability_assumption text not null,
  provenance    text not null default 'Research' check (provenance in ('Research')),
  primary key (run_id, game_id),
  check (home_id <> away_id),
  check (available = (p_home is not null)),
  check (not available or (p_home > 0 and p_home < 1 and p_ot >= 0 and p_ot < 1 and margin ? 'mean' and total ? 'mean'
         and (margin ->> 'q10')::double precision <= (margin ->> 'q90')::double precision
         and (total ->> 'q10')::double precision <= (total ->> 'q90')::double precision)),
  check (available or unavailable_reason is not null)
);
create index if not exists ncaaw_fc_forecasts_game_idx on public.ncaaw_fc_forecasts (game_id);

create table if not exists public.ncaaw_fc_upset_watch (
  run_id            uuid not null,
  game_id           text not null,
  underdog          text not null check (underdog in ('home', 'away')),
  basis             text not null check (basis in ('market', 'seed', 'model')),
  p_underdog        double precision not null check (p_underdog > 0 and p_underdog < 1),
  signals           text[] not null default '{}',
  p_market_underdog double precision check (p_market_underdog is null or (p_market_underdog > 0 and p_market_underdog < 1)),
  disagreement      double precision,
  factors           jsonb,
  primary key (run_id, game_id),
  foreign key (run_id, game_id) references public.ncaaw_fc_forecasts (run_id, game_id) on delete restrict,
  check ((basis = 'market') = (p_market_underdog is not null)),
  check (signals <@ array['upset_probability', 'toss_up', 'model_favours_underdog', 'market_disagreement', 'high_uncertainty']::text[])
);

create table if not exists public.ncaaw_fc_published (
  scope           text primary key check (scope in ('pregame')),
  run_id          uuid not null references public.ncaaw_fc_runs (run_id),
  as_of           timestamptz not null,
  published_at    timestamptz not null default now(),
  previous_run_id uuid references public.ncaaw_fc_runs (run_id)
);

create table if not exists public.ncaaw_fc_live_forecasts (
  id                bigint generated always as identity primary key,
  game_id           text not null,
  model_key         text not null references public.ncaaw_fc_models (model_key),
  observed_at       timestamptz not null,
  period            integer not null check (period between 1 and 12),
  clock_s           integer not null check (clock_s between 0 and 1200),
  home_score        integer not null check (home_score >= 0),
  away_score        integer not null check (away_score >= 0),
  feed_age_s        double precision,
  feed_ok           boolean not null,
  suppressed_reasons jsonb not null default '[]'::jsonb,
  p_home_pregame    double precision not null check (p_home_pregame > 0 and p_home_pregame < 1),
  p_home_live       double precision check (p_home_live is null or (p_home_live >= 0 and p_home_live <= 1)),
  live_model        text not null,
  created_at        timestamptz not null default now(),
  check (feed_ok = (p_home_live is not null))
);
create index if not exists ncaaw_fc_live_game_idx on public.ncaaw_fc_live_forecasts (game_id, observed_at desc);

create table if not exists public.ncaaw_fc_alerts (
  id         bigint generated always as identity primary key,
  run_id     uuid references public.ncaaw_fc_runs (run_id),
  severity   text not null check (severity in ('FAILURE', 'DEGRADED', 'WARNING', 'INFO')),
  code       text not null check (code ~ '^[a-z0-9_.]{3,64}$'),
  message    text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ncaaw_fc_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);
insert into public.ncaaw_fc_config (key, value, note) values
  ('live_enabled', 'false', 'live forecasts are written only when this is true; see CBB_MODEL_NOTES.md §8 for the activation requirements')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- immutability
create or replace function public.ncaaw_fc_rows_guard()
returns trigger language plpgsql as $$
declare st text;
begin
  if tg_op = 'DELETE' then raise exception 'public.%: delete refused (history is kept)', tg_table_name; end if;
  select status into st from public.ncaaw_fc_runs where run_id = new.run_id;
  if st is distinct from 'running' then raise exception 'public.%: run % is %, its rows are frozen', tg_table_name, new.run_id, coalesce(st, 'missing'); end if;
  return new;
end $$;
create or replace function public.ncaaw_fc_runs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.ncaaw_fc_runs: delete refused (history is kept)'; end if;
  if old.status <> 'running' then raise exception 'public.ncaaw_fc_runs: run % is %, it is frozen', old.run_id, old.status; end if;
  if new.run_id <> old.run_id or new.idempotency_key <> old.idempotency_key or new.model_key <> old.model_key or new.artifact_sha256 <> old.artifact_sha256 or new.as_of <> old.as_of then
    raise exception 'public.ncaaw_fc_runs: the identity of run % cannot change', old.run_id;
  end if;
  return new;
end $$;
create or replace function public.ncaaw_fc_jobs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.ncaaw_fc_jobs: delete refused (history is kept)'; end if;
  if old.status <> 'running' then raise exception 'public.ncaaw_fc_jobs: job % is %, it is frozen', old.job_id, old.status; end if;
  return new;
end $$;

do $trg$
declare t text;
begin
  foreach t in array array['ncaaw_fc_forecasts', 'ncaaw_fc_upset_watch'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.ncaaw_fc_rows_guard()', t || '_guard', t);
  end loop;
  drop trigger if exists ncaaw_fc_runs_guard on public.ncaaw_fc_runs;
  create trigger ncaaw_fc_runs_guard before update or delete on public.ncaaw_fc_runs for each row execute function public.ncaaw_fc_runs_guard();
  drop trigger if exists ncaaw_fc_jobs_guard on public.ncaaw_fc_jobs;
  create trigger ncaaw_fc_jobs_guard before update or delete on public.ncaaw_fc_jobs for each row execute function public.ncaaw_fc_jobs_guard();
  foreach t in array array['ncaaw_fc_snapshots', 'ncaaw_fc_models', 'ncaaw_fc_reports', 'ncaaw_fc_champion_history', 'ncaaw_fc_live_forecasts', 'ncaaw_fc_alerts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.sim_keep()', t || '_frozen', t);
  end loop;
  foreach t in array array['ncaaw_fc_champion', 'ncaaw_fc_published'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.sim_keep()', t || '_no_delete', t);
  end loop;
  foreach t in array array['ncaaw_fc_snapshots', 'ncaaw_fc_models', 'ncaaw_fc_jobs', 'ncaaw_fc_reports', 'ncaaw_fc_champion', 'ncaaw_fc_champion_history', 'ncaaw_fc_runs',
                           'ncaaw_fc_forecasts', 'ncaaw_fc_upset_watch', 'ncaaw_fc_published', 'ncaaw_fc_live_forecasts', 'ncaaw_fc_alerts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.sim_keep()', t || '_no_truncate', t);
  end loop;
end $trg$;

-- ---------------------------------------------------------------- job functions (service_role only)
create or replace function public.ncaaw_fc_alert(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare i bigint;
begin
  insert into public.ncaaw_fc_alerts (run_id, severity, code, message, detail)
  values (nullif(p ->> 'run_id', '')::uuid, p ->> 'severity', p ->> 'code', p ->> 'message', p -> 'detail') returning id into i;
  return i;
end $$;

create or replace function public.ncaaw_fc_record_snapshot(p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ncaaw_fc_snapshots (snapshot_sha256, through_at, row_count, seasons)
  values (p ->> 'sha256', (p ->> 'through')::timestamptz, (p ->> 'rows')::int, coalesce(p -> 'seasons', '[]')) on conflict (snapshot_sha256) do nothing;
  return p ->> 'sha256';
end $$;

-- a model version is immutable: the same key with another config is refused
create or replace function public.ncaaw_fc_record_model(p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := (p ->> 'model_id') || '@' || (p ->> 'version'); old public.ncaaw_fc_models;
begin
  select * into old from public.ncaaw_fc_models where model_key = k;
  if found then
    if old.config_sha256 <> p ->> 'config_sha256' then raise exception 'ncaaw_fc_record_model: % already exists with another configuration', k; end if;
    return k;
  end if;
  insert into public.ncaaw_fc_models (model_key, model_id, version, engine, config, config_sha256, code_sha256, snapshot_sha256)
  values (k, p ->> 'model_id', p ->> 'version', p ->> 'engine', p -> 'config', p ->> 'config_sha256', nullif(p ->> 'code_sha256', ''), nullif(p ->> 'snapshot_sha256', ''));
  return k;
end $$;

create or replace function public.ncaaw_fc_record_report(p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ncaaw_fc_reports (report_sha256, job_id, candidate, champion_key, challenger_key, decision, policy_version, gates, summary, report_path)
  values (p ->> 'report_sha256', nullif(p ->> 'job_id', '')::uuid, p ->> 'candidate', p ->> 'champion_key', p ->> 'challenger_key', p ->> 'decision', p ->> 'policy_version',
          coalesce(p -> 'gates', '[]'), coalesce(p -> 'summary', '{}'), p ->> 'report_path')
  on conflict (report_sha256) do nothing;
  return p ->> 'report_sha256';
end $$;

-- THE CHAMPION POINTER: a PROMOTE needs a PROMOTE report for exactly this model
create or replace function public.ncaaw_fc_set_champion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d text := p ->> 'decision'; k text := p ->> 'model_key'; cur public.ncaaw_fc_champion; rep public.ncaaw_fc_reports; had boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('ncaaw_fc:champion', 0));
  if d not in ('INIT', 'PROMOTE', 'ROLLBACK') then raise exception 'ncaaw_fc_set_champion: unknown decision %', d; end if;
  if not exists (select 1 from public.ncaaw_fc_models where model_key = k) then raise exception 'ncaaw_fc_set_champion: model % is not recorded', k; end if;
  select * into cur from public.ncaaw_fc_champion where scope = 'ncaaw' for update; had := found;
  if d = 'INIT' and had then return jsonb_build_object('changed', false, 'model_key', cur.model_key); end if;
  if d = 'PROMOTE' then
    select * into rep from public.ncaaw_fc_reports where report_sha256 = p ->> 'report_sha256';
    if not found then raise exception 'ncaaw_fc_set_champion: no stored report %', p ->> 'report_sha256'; end if;
    if rep.decision <> 'PROMOTE' then raise exception 'ncaaw_fc_set_champion: report decision is %, not PROMOTE', rep.decision; end if;
    if rep.challenger_key <> k then raise exception 'ncaaw_fc_set_champion: the report promotes %, not %', rep.challenger_key, k; end if;
    if had and rep.champion_key <> cur.model_key then raise exception 'ncaaw_fc_set_champion: the report was evaluated against %, the champion is %', rep.champion_key, cur.model_key; end if;
  end if;
  if d = 'ROLLBACK' and (p ->> 'reason') is null then raise exception 'ncaaw_fc_set_champion: a rollback needs a reason'; end if;
  insert into public.ncaaw_fc_champion (scope, model_key, since, decision, report_sha256, previous_model_key)
  values ('ncaaw', k, now(), d, nullif(p ->> 'report_sha256', ''), case when had then cur.model_key end)
  on conflict (scope) do update set model_key = excluded.model_key, since = excluded.since, decision = excluded.decision, report_sha256 = excluded.report_sha256, previous_model_key = public.ncaaw_fc_champion.model_key;
  insert into public.ncaaw_fc_champion_history (scope, model_key, replaced_key, decision, report_sha256, reason)
  values ('ncaaw', k, case when had then cur.model_key end, d, nullif(p ->> 'report_sha256', ''), p ->> 'reason');
  return jsonb_build_object('changed', true, 'model_key', k, 'previous', case when had then cur.model_key end);
end $$;

create or replace function public.ncaaw_fc_begin_job(p jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare j uuid;
begin
  insert into public.ncaaw_fc_jobs (kind, snapshot_sha256) values (p ->> 'kind', nullif(p ->> 'snapshot_sha256', '')) returning job_id into j;
  return j;
end $$;
create or replace function public.ncaaw_fc_finish_job(p_job uuid, p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean := coalesce((p ->> 'ok')::boolean, false);
begin
  update public.ncaaw_fc_jobs set status = case when ok then 'completed' else 'failed' end, finished_at = now(), decision = p ->> 'decision',
    error_summary = case when ok then null else coalesce(p -> 'error', jsonb_build_object('code', 'unknown')) end, runtime = coalesce(p -> 'runtime', '{}')
   where job_id = p_job and status = 'running';
  if not found then raise exception 'ncaaw_fc_finish_job: job % is not running', p_job; end if;
  if not ok then perform public.ncaaw_fc_alert(jsonb_build_object('severity', 'FAILURE', 'code', 'job.failed', 'message', coalesce(p -> 'error' ->> 'message', 'job failed'), 'detail', p -> 'error')); end if;
  return case when ok then 'completed' else 'failed' end;
end $$;

-- forecasts: begin, put, publish | fail
create or replace function public.ncaaw_fc_begin_run(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ncaaw_fc_runs; stale interval := interval '2 hours';
begin
  perform pg_advisory_xact_lock(hashtextextended('ncaaw_fc:pregame', 0));
  select * into r from public.ncaaw_fc_runs where idempotency_key = p ->> 'idempotency_key' and status <> 'failed';
  if found then
    if r.status = 'running' and r.created_at < now() - stale then
      update public.ncaaw_fc_runs set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'abandoned') where run_id = r.run_id;
    elsif r.status = 'running' then raise exception 'ncaaw_fc_begin_run: a run with these inputs is in progress (%)', r.run_id;
    else return jsonb_build_object('run_id', r.run_id, 'status', r.status, 'existing', true);
    end if;
  end if;
  insert into public.ncaaw_fc_runs (idempotency_key, model_key, artifact_sha256, snapshot_sha256, as_of, expected_games, gates, definitions, upset_policy)
  values (p ->> 'idempotency_key', p ->> 'model_key', p ->> 'artifact_sha256', p ->> 'snapshot_sha256', (p ->> 'as_of')::timestamptz, (p ->> 'expected_games')::int,
          coalesce(p -> 'gates', '[]'), coalesce(p -> 'definitions', '{}'), p -> 'upset_policy')
  returning * into r;
  return jsonb_build_object('run_id', r.run_id, 'status', r.status, 'existing', false);
end $$;

create or replace function public.ncaaw_fc_put_forecasts(p_run uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.ncaaw_fc_forecasts (run_id, game_id, start_utc, home_id, away_id, home_name, away_name, neutral, event, regime, available, unavailable_reason,
    p_home, p_ot, margin, total, pts_home, pts_away, games_played, data_quality, availability_assumption, provenance)
  select p_run, x ->> 'game_id', (x ->> 'start_utc')::timestamptz, x ->> 'home_id', x ->> 'away_id', x ->> 'home_name', x ->> 'away_name', (x ->> 'neutral')::boolean,
    x ->> 'event', x ->> 'regime', (x ->> 'available')::boolean, x ->> 'reason', (x ->> 'p_home')::double precision, (x ->> 'p_ot')::double precision,
    x -> 'margin', x -> 'total', (x ->> 'pts_home')::double precision, (x ->> 'pts_away')::double precision, coalesce(x -> 'games_played', '{}'),
    coalesce(x -> 'data_quality', '[]'), x ->> 'availability_assumption', coalesce(x ->> 'provenance', 'Research')
  from jsonb_array_elements(p_rows) x
  on conflict (run_id, game_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ncaaw_fc_put_upset(p_run uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.ncaaw_fc_upset_watch (run_id, game_id, underdog, basis, p_underdog, signals, p_market_underdog, disagreement, factors)
  select p_run, x ->> 'game_id', x ->> 'underdog', x ->> 'basis', (x ->> 'p_underdog')::double precision,
    coalesce(array(select jsonb_array_elements_text(coalesce(x -> 'signals', '[]'))), '{}'), (x ->> 'p_market_underdog')::double precision,
    (x ->> 'disagreement')::double precision, x -> 'factors'
  from jsonb_array_elements(p_rows) x
  on conflict (run_id, game_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ncaaw_fc_publish_run(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ncaaw_fc_runs; cur public.ncaaw_fc_published; had boolean; e jsonb := '[]'::jsonb; n bigint; g jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('ncaaw_fc:pregame', 0));
  select * into r from public.ncaaw_fc_runs where run_id = p_run for update;
  if not found then raise exception 'ncaaw_fc_publish_run: no run %', p_run; end if;
  if r.status <> 'running' then raise exception 'ncaaw_fc_publish_run: run % is %, only a running run can be published', p_run, r.status; end if;
  select count(*) into n from public.ncaaw_fc_forecasts where run_id = p_run;
  if n <> r.expected_games then e := e || jsonb_build_array('forecast rows ' || n || ' != expected ' || r.expected_games); end if;
  select count(*) into n from public.ncaaw_fc_upset_watch u join public.ncaaw_fc_forecasts f using (run_id, game_id) where u.run_id = p_run and not f.available;
  if n > 0 then e := e || jsonb_build_array(n || ' Upset Watch rows for unavailable forecasts'); end if;
  if not exists (select 1 from public.ncaaw_fc_champion c where c.scope = 'ncaaw' and c.model_key = r.model_key) then
    e := e || jsonb_build_array('model ' || r.model_key || ' is not the champion');
  end if;
  for g in select * from jsonb_array_elements(r.gates) loop
    if coalesce((g ->> 'pass')::boolean, false) is not true then e := e || jsonb_build_array('gate ' || (g ->> 'id') || ' did not pass'); end if;
  end loop;
  if jsonb_array_length(e) > 0 then
    update public.ncaaw_fc_runs set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'publish_verification_failed', 'errors', e) where run_id = p_run;
    perform public.ncaaw_fc_alert(jsonb_build_object('run_id', p_run, 'severity', 'FAILURE', 'code', 'run.publish_refused', 'message', 'verification failed; the published forecasts are unchanged', 'detail', e));
    return jsonb_build_object('published', false, 'status', 'failed', 'errors', e);
  end if;
  select * into cur from public.ncaaw_fc_published where scope = r.scope for update; had := found;
  if had and cur.as_of > r.as_of then
    update public.ncaaw_fc_runs set status = 'superseded', completed_at = now() where run_id = p_run;
    return jsonb_build_object('published', false, 'status', 'superseded', 'current_run_id', cur.run_id);
  end if;
  update public.ncaaw_fc_runs set status = 'completed', completed_at = now() where run_id = p_run;
  insert into public.ncaaw_fc_published (scope, run_id, as_of, published_at, previous_run_id) values (r.scope, p_run, r.as_of, now(), null)
  on conflict (scope) do update set run_id = excluded.run_id, as_of = excluded.as_of, published_at = excluded.published_at, previous_run_id = public.ncaaw_fc_published.run_id;
  return jsonb_build_object('published', true, 'status', 'completed', 'run_id', p_run, 'previous_run_id', case when had then cur.run_id end);
end $$;

create or replace function public.ncaaw_fc_fail_run(p_run uuid, p_error jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ncaaw_fc_runs;
begin
  select * into r from public.ncaaw_fc_runs where run_id = p_run for update;
  if not found then raise exception 'ncaaw_fc_fail_run: no run %', p_run; end if;
  if r.status <> 'running' then return jsonb_build_object('run_id', p_run, 'status', r.status, 'changed', false); end if;
  update public.ncaaw_fc_runs set status = 'failed', failed_at = now(), error_summary = coalesce(p_error, jsonb_build_object('code', 'unknown')) where run_id = p_run;
  perform public.ncaaw_fc_alert(jsonb_build_object('run_id', p_run, 'severity', 'FAILURE', 'code', 'run.failed', 'message', coalesce(p_error ->> 'message', 'forecast run failed'), 'detail', p_error));
  return jsonb_build_object('run_id', p_run, 'status', 'failed', 'changed', true);
end $$;

-- live: refused unless enabled; a suppressed observation is stored without a live probability
create or replace function public.ncaaw_fc_put_live(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare i bigint;
begin
  if coalesce((select value from public.ncaaw_fc_config where key = 'live_enabled'), 'false') <> 'true' then
    raise exception 'ncaaw_fc_put_live: live forecasts are disabled (ncaaw_fc_config.live_enabled)';
  end if;
  insert into public.ncaaw_fc_live_forecasts (game_id, model_key, observed_at, period, clock_s, home_score, away_score, feed_age_s, feed_ok, suppressed_reasons, p_home_pregame, p_home_live, live_model)
  values (p ->> 'game_id', p ->> 'model_key', (p ->> 'observed_at')::timestamptz, (p ->> 'period')::int, (p ->> 'clock_s')::int, (p ->> 'home_score')::int, (p ->> 'away_score')::int,
          (p ->> 'feed_age_s')::double precision, (p ->> 'feed_ok')::boolean, coalesce(p -> 'suppressed_reasons', '[]'), (p ->> 'p_home_pregame')::double precision,
          (p ->> 'p_home_live')::double precision, p ->> 'live_model')
  returning id into i;
  return i;
end $$;

-- ---------------------------------------------------------------- what anyone may know (no probability)
create or replace function public.ncaaw_fc_public_status()
returns table (champion_key text, champion_since timestamptz, champion_decision text, last_weekly_decision text, last_weekly_at timestamptz,
               published_run_id uuid, published_as_of timestamptz, published_at timestamptz, last_attempt_status text, last_attempt_at timestamptz, live_enabled boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.model_key, c.since, c.decision,
         (select x.decision from public.ncaaw_fc_reports x order by x.created_at desc limit 1),
         (select x.created_at from public.ncaaw_fc_reports x order by x.created_at desc limit 1),
         p.run_id, p.as_of, p.published_at,
         (select y.status from public.ncaaw_fc_runs y order by y.created_at desc limit 1),
         (select coalesce(y.failed_at, y.completed_at, y.created_at) from public.ncaaw_fc_runs y order by y.created_at desc limit 1),
         coalesce((select value = 'true' from public.ncaaw_fc_config where key = 'live_enabled'), false)
    from (select 1) one
    left join public.ncaaw_fc_champion c on c.scope = 'ncaaw'
    left join public.ncaaw_fc_published p on p.scope = 'pregame';
$$;

-- ---------------------------------------------------------------- row level security
do $rls$
declare t text;
begin
  foreach t in array array['ncaaw_fc_snapshots', 'ncaaw_fc_models', 'ncaaw_fc_jobs', 'ncaaw_fc_reports', 'ncaaw_fc_champion', 'ncaaw_fc_champion_history', 'ncaaw_fc_runs',
                           'ncaaw_fc_forecasts', 'ncaaw_fc_upset_watch', 'ncaaw_fc_published', 'ncaaw_fc_live_forecasts', 'ncaaw_fc_alerts', 'ncaaw_fc_config'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['ncaaw_fc_snapshots', 'ncaaw_fc_models', 'ncaaw_fc_reports', 'ncaaw_fc_champion', 'ncaaw_fc_champion_history', 'ncaaw_fc_published', 'ncaaw_fc_live_forecasts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.sim_viewer_entitled())', t || '_read', t);
  end loop;
  foreach t in array array['ncaaw_fc_forecasts', 'ncaaw_fc_upset_watch'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.sim_viewer_entitled() and exists (select 1 from public.ncaaw_fc_runs r where r.run_id = %I.run_id and r.status in (''completed'', ''superseded'')))', t || '_read', t, t);
  end loop;
end $rls$;
drop policy if exists ncaaw_fc_runs_read on public.ncaaw_fc_runs;
create policy ncaaw_fc_runs_read on public.ncaaw_fc_runs for select to authenticated using (status in ('completed', 'superseded') and public.sim_viewer_entitled());
-- ncaaw_fc_jobs, ncaaw_fc_alerts, ncaaw_fc_config: no client policy (operators only)

revoke insert, update, delete, truncate on public.ncaaw_fc_snapshots, public.ncaaw_fc_models, public.ncaaw_fc_jobs, public.ncaaw_fc_reports, public.ncaaw_fc_champion,
  public.ncaaw_fc_champion_history, public.ncaaw_fc_runs, public.ncaaw_fc_forecasts, public.ncaaw_fc_upset_watch, public.ncaaw_fc_published, public.ncaaw_fc_live_forecasts,
  public.ncaaw_fc_alerts, public.ncaaw_fc_config from anon, authenticated;
revoke all on public.ncaaw_fc_snapshots, public.ncaaw_fc_models, public.ncaaw_fc_jobs, public.ncaaw_fc_reports, public.ncaaw_fc_champion, public.ncaaw_fc_champion_history,
  public.ncaaw_fc_runs, public.ncaaw_fc_forecasts, public.ncaaw_fc_upset_watch, public.ncaaw_fc_published, public.ncaaw_fc_live_forecasts, public.ncaaw_fc_alerts, public.ncaaw_fc_config from anon;
revoke select on public.ncaaw_fc_jobs, public.ncaaw_fc_alerts, public.ncaaw_fc_config from authenticated;
grant select on public.ncaaw_fc_snapshots, public.ncaaw_fc_models, public.ncaaw_fc_reports, public.ncaaw_fc_champion, public.ncaaw_fc_champion_history, public.ncaaw_fc_runs,
  public.ncaaw_fc_forecasts, public.ncaaw_fc_upset_watch, public.ncaaw_fc_published, public.ncaaw_fc_live_forecasts to authenticated;

-- the reader's views (security invoker: RLS applies to the reader)
create or replace view public.ncaaw_fc_current_forecasts with (security_invoker = true) as
  select f.*, u.underdog, u.basis, u.p_underdog, u.signals, u.p_market_underdog, u.disagreement, u.factors,
         r.model_key, r.artifact_sha256, r.snapshot_sha256, r.as_of, r.definitions, r.upset_policy, p.published_at
    from public.ncaaw_fc_published p
    join public.ncaaw_fc_runs r on r.run_id = p.run_id
    join public.ncaaw_fc_forecasts f on f.run_id = p.run_id
    left join public.ncaaw_fc_upset_watch u on u.run_id = f.run_id and u.game_id = f.game_id
   where p.scope = 'pregame';
create or replace view public.ncaaw_fc_model_health with (security_invoker = true) as
  select c.model_key, c.since, c.decision as champion_decision, c.previous_model_key, m.engine, m.config_sha256, m.code_sha256,
         (select jsonb_agg(jsonb_build_object('candidate', x.candidate, 'challenger', x.challenger_key, 'decision', x.decision, 'created_at', x.created_at, 'gates', x.gates, 'summary', x.summary) order by x.created_at desc)
            from (select * from public.ncaaw_fc_reports order by created_at desc limit 12) x) as recent_reports
    from public.ncaaw_fc_champion c join public.ncaaw_fc_models m on m.model_key = c.model_key
   where c.scope = 'ncaaw';
create or replace view public.ncaaw_fc_current_live with (security_invoker = true) as
  select distinct on (l.game_id) l.* from public.ncaaw_fc_live_forecasts l order by l.game_id, l.observed_at desc, l.id desc;
revoke all on public.ncaaw_fc_current_forecasts, public.ncaaw_fc_model_health, public.ncaaw_fc_current_live from anon;
revoke insert, update, delete, truncate on public.ncaaw_fc_current_forecasts, public.ncaaw_fc_model_health, public.ncaaw_fc_current_live from authenticated;
grant select on public.ncaaw_fc_current_forecasts, public.ncaaw_fc_model_health, public.ncaaw_fc_current_live to authenticated;

-- function grants: job functions to service_role only; the status helper to everyone
do $g$
declare f text;
begin
  foreach f in array array['public.ncaaw_fc_alert(jsonb)', 'public.ncaaw_fc_record_snapshot(jsonb)', 'public.ncaaw_fc_record_model(jsonb)', 'public.ncaaw_fc_record_report(jsonb)',
    'public.ncaaw_fc_set_champion(jsonb)', 'public.ncaaw_fc_begin_job(jsonb)', 'public.ncaaw_fc_finish_job(uuid,jsonb)', 'public.ncaaw_fc_begin_run(jsonb)',
    'public.ncaaw_fc_put_forecasts(uuid,jsonb)', 'public.ncaaw_fc_put_upset(uuid,jsonb)', 'public.ncaaw_fc_publish_run(uuid)', 'public.ncaaw_fc_fail_run(uuid,jsonb)',
    'public.ncaaw_fc_put_live(jsonb)', 'public.ncaaw_fc_rows_guard()', 'public.ncaaw_fc_runs_guard()', 'public.ncaaw_fc_jobs_guard()'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') and f !~ 'guard\(\)$' then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  execute 'revoke all on function public.ncaaw_fc_public_status() from public';
  execute 'grant execute on function public.ncaaw_fc_public_status() to anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.ncaaw_fc_public_status() to service_role'; end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- report
select 1 as row, 'tables exist' as check,
       case when to_regclass('public.ncaaw_fc_models') is not null and to_regclass('public.ncaaw_fc_forecasts') is not null and to_regclass('public.ncaaw_fc_champion') is not null
             and to_regclass('public.ncaaw_fc_upset_watch') is not null and to_regclass('public.ncaaw_fc_live_forecasts') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'row level security on every ncaaw_fc table',
       case when (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'ncaaw\_fc\_%') then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role can write an ncaaw_fc table',
       case when not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'ncaaw\_fc\_%'
                              and g.grantee in ('anon', 'authenticated') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) then 'ok' else 'CHECK THIS' end
union all select 4, 'the job functions are not callable by clients',
       case when not has_function_privilege('anon', 'public.ncaaw_fc_publish_run(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.ncaaw_fc_set_champion(jsonb)', 'execute')
             and not has_function_privilege('authenticated', 'public.ncaaw_fc_put_live(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
union all select 5, 'live forecasts are disabled by default',
       case when (select value from public.ncaaw_fc_config where key = 'live_enabled') is not null then 'ok' else 'CHECK THIS' end
union all select 6, 'an anonymous caller is not entitled',
       case when not public.sim_viewer_entitled() then 'ok' else 'CHECK THIS' end;
