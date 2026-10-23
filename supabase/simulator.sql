-- =============================================================================
-- simulator.sql — the EdgeDesk Simulator: runs, results, market comparisons,
-- atomic publication and premium read access. docs/simulator/README.md.
--
-- WHAT IT ADDS
--   sim_runs                 one row per simulation attempt: seed, PRNG, N,
--                            model / engine / rules versions, source commit,
--                            the input snapshot's time, reference and hash, the
--                            config hash, lifecycle status, gates, diagnostics
--   sim_input_snapshots      the frozen input snapshot itself, by content hash
--                            (immutable; deduplicated)
--   sim_team_results         per entity and outcome: count, N, probability,
--                            Monte Carlo SE, 95% Wilson interval, fair odds,
--                            applicability, provenance
--   sim_entity_summary       per entity: current record, mean wins, the wins
--                            histogram, clinch / elimination status
--   sim_trace_samples        at most 5 full traces per run, 64 KB each
--   sim_published            THE POINTER: per (sport, competition, season) the
--                            one run readers see, and its market comparison
--   sim_market_comparisons   one row per futures comparison attempt
--   sim_futures_quotes       Kalshi futures quotes as fetched (Observed,
--                            append-only)
--   sim_futures_edges        per comparison and market: mapping, quote, price
--                            basis, reference and executable comparisons kept
--                            apart, fees, eligibility, block reasons
--   sim_flag_snapshots       an immutable copy of every flagged opportunity
--   sim_closing_observations the closing quote of each flagged market (or
--                            'missing'), never a settled 0/1
--   sim_alerts               every failure, outage and incomplete input
--   sim_config               the research-registry link (simulator_registry.sql)
--
-- PUBLICATION IS ATOMIC. A job calls, as service_role only:
--   sim_begin_run(p)            -> a 'running' run (idempotent on its key)
--   sim_put_snapshot / sim_put_results / sim_put_entities / sim_put_traces
--                               -> rows of a RUNNING run only; no reader can
--                                  see a running run's rows
--   sim_publish_run(run)        -> ONE transaction: checks every row count,
--                                  every probability against its count, every
--                                  format sum, every gate; then marks the run
--                                  completed and moves the pointer — unless a
--                                  newer input is already published, in which
--                                  case the run is kept as 'superseded'
--   sim_fail_run(run, error)    -> failed, with diagnostics; the pointer is
--                                  never touched by a failure
-- Market comparisons follow the same pattern (sim_begin_comparison ->
-- sim_put_quotes / sim_put_edges -> sim_publish_comparison / sim_fail_comparison):
-- a market outage fails the COMPARISON and leaves the simulation published.
-- A per-competition advisory lock serialises publications.
--
-- READS. Every table is row-level secured. A row is visible only to a reader
-- the project's own entitlement rule admits (public.community_is_entitled,
-- i.e. billing_row_grants_access: active/trialing, owner comp, 21-day
-- past-due grace) AND only once its run is completed. Signed in is not
-- enough. sim_public_status() tells anyone, without a single probability,
-- which runs exist and how fresh they are. No client role may write.
--
-- HISTORY IS KEPT. Completed runs, quotes, flags and closes refuse update,
-- delete and truncate. Nothing here drops a table or rewrites a row.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261023120000_simulator.sql.
-- =============================================================================

create extension if not exists pgcrypto;

begin;

-- ---------------------------------------------------------------- guards
create or replace function public.sim_keep()
returns trigger language plpgsql as $$
begin
  raise exception 'public.% is append-only: % refused (history is kept; write a new row instead)', tg_table_name, tg_op;
end $$;

-- ---------------------------------------------------------------- entitlement
-- The caller's entitlement, through the project's one rule. Fails CLOSED: with
-- no entitlement authority installed, nobody is entitled (unlike a rule that
-- defaults open). Security definer so policies can call it; answers only for
-- auth.uid(), returns only a boolean.
create or replace function public.sim_viewer_entitled()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare uid uuid; ok boolean;
begin
  begin uid := auth.uid(); exception when others then return false; end;
  if uid is null then return false; end if;
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;
  if to_regclass('public.subscriptions') is not null and to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)') is not null then
    execute 'select exists (select 1 from public.subscriptions s where s.user_id = $1 and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))' into ok using uid;
    return coalesce(ok, false);
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------- runs
create table if not exists public.sim_runs (
  run_id              uuid primary key default gen_random_uuid(),
  sport               text not null check (sport ~ '^[a-z_]{2,24}$'),
  competition         text not null check (char_length(competition) between 2 and 40),
  season              text not null check (season ~ '^[0-9]{4}(-[0-9]{2,4})?$'),
  idempotency_key     text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  seed                text not null check (seed ~ '^[0-9]{1,20}$'),
  prng_version        text not null,
  n_sims              integer not null check (n_sims > 0),
  model_version       text not null,
  engine_version      text not null,
  source_commit       text check (source_commit is null or source_commit ~ '^[0-9a-f]{40}$'),
  rules_version       text not null,
  config_hash         text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot_at   timestamptz not null,
  input_ref           text not null,
  input_hash          text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  status              text not null default 'running' check (status in ('running', 'completed', 'superseded', 'failed')),
  expected            jsonb not null default '{}'::jsonb,
  gates               jsonb not null default '[]'::jsonb,
  validation_summary  jsonb not null default '{}'::jsonb,
  diagnostics         jsonb not null default '{}'::jsonb,
  limitations         jsonb not null default '[]'::jsonb,
  error_summary       jsonb,
  runtime             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  completed_at        timestamptz,
  failed_at           timestamptz,
  check ((status in ('completed', 'superseded')) = (completed_at is not null)),
  check ((status = 'failed') = (failed_at is not null)),
  check (status <> 'failed' or error_summary is not null)
);
-- one live attempt per key: a failed attempt may be retried with the same inputs
create unique index if not exists sim_runs_key_live_uk on public.sim_runs (idempotency_key) where status <> 'failed';
create index if not exists sim_runs_comp_idx on public.sim_runs (sport, competition, season, created_at desc);

create table if not exists public.sim_input_snapshots (
  input_hash  text primary key check (input_hash ~ '^[0-9a-f]{64}$'),
  sport       text not null,
  schema      text not null,
  data        jsonb not null,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.sim_team_results (
  run_id          uuid not null references public.sim_runs (run_id) on delete restrict,
  entity_id       text not null check (char_length(entity_id) between 1 and 64),
  entity_name     text not null,
  entity_groups   jsonb not null default '{}'::jsonb,
  outcome         text not null check (outcome ~ '^[a-z0-9_]{2,40}$'),
  category        text not null,
  applicable      boolean not null default true,
  outcome_count   bigint,
  n_sims          integer not null check (n_sims > 0),
  probability     double precision,
  mcse            double precision,
  wilson_lo       double precision,
  wilson_hi       double precision,
  interval_method text not null default 'wilson_95',
  fair_decimal    double precision,
  provenance      text not null default 'Research' check (provenance in ('Observed', 'Research', 'Estimated')),
  primary key (run_id, entity_id, outcome),
  check (applicable or (outcome_count is null and probability is null and mcse is null)),
  check (not applicable or (
    outcome_count between 0 and n_sims
    and probability between 0 and 1
    and abs(probability - outcome_count::double precision / n_sims) < 1e-9
    and abs(mcse - sqrt(probability * (1 - probability) / n_sims)) < 1e-9
    and wilson_lo >= 0 and wilson_hi <= 1 and wilson_lo <= probability and probability <= wilson_hi
    and ((probability = 0 and fair_decimal is null) or (probability > 0 and abs(fair_decimal - 1 / probability) < 1e-6 * (1 / probability))))
  )
);

create table if not exists public.sim_entity_summary (
  run_id       uuid not null references public.sim_runs (run_id) on delete restrict,
  entity_id    text not null,
  entity_name  text not null,
  entity_groups jsonb not null default '{}'::jsonb,
  record       jsonb,
  mean_wins    double precision,
  wins_hist_x2 jsonb,
  math_status  jsonb,
  primary key (run_id, entity_id)
);

create table if not exists public.sim_trace_samples (
  run_id     uuid not null references public.sim_runs (run_id) on delete restrict,
  run_index  integer not null check (run_index >= 0),
  trace      jsonb not null check (octet_length(trace::text) <= 65536),
  primary key (run_id, run_index)
);

create table if not exists public.sim_published (
  sport          text not null,
  competition    text not null,
  season         text not null,
  run_id         uuid not null references public.sim_runs (run_id),
  input_snapshot_at timestamptz not null,
  published_at   timestamptz not null default now(),
  previous_run_id uuid references public.sim_runs (run_id),
  comparison_id  uuid,
  primary key (sport, competition, season)
);

-- ---------------------------------------------------------------- markets
create table if not exists public.sim_market_comparisons (
  comparison_id   uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.sim_runs (run_id),
  sport           text not null,
  competition     text not null,
  season          text not null,
  status          text not null default 'running' check (status in ('running', 'completed', 'failed')),
  mapping_version text not null,
  methodology     jsonb not null default '{}'::jsonb,
  counts          jsonb not null default '{}'::jsonb,
  expected        jsonb not null default '{}'::jsonb,
  quotes_from     timestamptz,
  quotes_to       timestamptz,
  error_summary   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  failed_at       timestamptz,
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'failed') = (failed_at is not null and error_summary is not null))
);
do $fk$ begin
  if not exists (select 1 from pg_constraint where conname = 'sim_published_comparison_fk') then
    alter table public.sim_published add constraint sim_published_comparison_fk foreign key (comparison_id) references public.sim_market_comparisons (comparison_id);
  end if;
end $fk$;

create table if not exists public.sim_futures_quotes (
  quote_id        bigint generated always as identity primary key,
  comparison_id   uuid references public.sim_market_comparisons (comparison_id),
  market_ticker   text not null,
  event_ticker    text,
  series_ticker   text,
  captured_at     timestamptz not null,
  status          text,
  yes_bid         numeric check (yes_bid is null or (yes_bid >= 0 and yes_bid <= 1)),
  yes_ask         numeric check (yes_ask is null or (yes_ask >= 0 and yes_ask <= 1)),
  no_bid          numeric check (no_bid is null or (no_bid >= 0 and no_bid <= 1)),
  no_ask          numeric check (no_ask is null or (no_ask >= 0 and no_ask <= 1)),
  yes_ask_size    numeric check (yes_ask_size is null or yes_ask_size >= 0),
  yes_bid_size    numeric check (yes_bid_size is null or yes_bid_size >= 0),
  last_price      numeric check (last_price is null or (last_price >= 0 and last_price <= 1)),
  volume          numeric,
  open_interest   numeric,
  close_time      timestamptz,
  rules_sha256    text,
  host            text,
  raw             jsonb not null default '{}'::jsonb
);
create index if not exists sim_futures_quotes_ticker_idx on public.sim_futures_quotes (market_ticker, captured_at desc);

create table if not exists public.sim_futures_edges (
  comparison_id        uuid not null references public.sim_market_comparisons (comparison_id) on delete restrict,
  run_id               uuid not null references public.sim_runs (run_id),
  market_ticker        text not null,
  event_ticker         text,
  series_ticker        text,
  mapping_id           text not null,
  entity_id            text not null,
  outcome              text not null,
  settlement_basis     text not null,
  quote_id             bigint references public.sim_futures_quotes (quote_id),
  quote_at             timestamptz,
  quote_age_minutes    double precision,
  yes_bid              numeric,
  yes_ask              numeric,
  yes_ask_size         numeric,
  -- A. reference comparison
  reference_basis      text check (reference_basis is null or reference_basis in ('yes_mid', 'last_price', 'yes_bid', 'yes_ask')),
  reference_prob       double precision check (reference_prob is null or (reference_prob >= 0 and reference_prob <= 1)),
  normalization        text not null default 'none' check (normalization in ('none', 'proportional_complete_set')),
  normalized_ref_prob  double precision check (normalized_ref_prob is null or (normalized_ref_prob >= 0 and normalized_ref_prob <= 1)),
  normalization_note   text,
  research_prob        double precision not null check (research_prob >= 0 and research_prob <= 1),
  research_mcse        double precision not null check (research_mcse >= 0),
  research_fair_decimal double precision,
  reference_edge_pp    double precision,
  -- B. executable comparison (buy YES at the ask, at a stated quantity)
  exec_quantity        integer check (exec_quantity is null or exec_quantity > 0),
  exec_price           numeric check (exec_price is null or (exec_price > 0 and exec_price < 1)),
  fee_per_contract     numeric check (fee_per_contract is null or fee_per_contract >= 0),
  fee_basis            text,
  fee_verified         boolean not null default false,
  exec_cost_prob       double precision check (exec_cost_prob is null or (exec_cost_prob > 0 and exec_cost_prob <= 1)),
  exec_edge_pp         double precision,
  expected_net_return  double precision,
  stale                boolean not null,
  eligible             boolean not null,
  actionable           boolean not null default false,
  block_reasons        text[] not null default '{}',
  provenance           jsonb not null default '{}'::jsonb,
  primary key (comparison_id, market_ticker),
  check (not actionable or (eligible and not stale and fee_verified and exec_price is not null and exec_cost_prob is not null and cardinality(block_reasons) = 0)),
  check (normalization = 'none' or normalized_ref_prob is not null)
);

create table if not exists public.sim_flag_snapshots (
  flag_id        bigint generated always as identity primary key,
  comparison_id  uuid not null references public.sim_market_comparisons (comparison_id),
  run_id         uuid not null references public.sim_runs (run_id),
  market_ticker  text not null,
  entity_id      text not null,
  outcome        text not null,
  flagged_at     timestamptz not null default now(),
  payload        jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  unique (comparison_id, market_ticker)
);

create table if not exists public.sim_closing_observations (
  flag_id            bigint primary key references public.sim_flag_snapshots (flag_id),
  close_basis        text not null,
  close_window       text not null,
  status             text not null check (status in ('observed', 'missing')),
  close_quote_id     bigint references public.sim_futures_quotes (quote_id),
  close_quote_at     timestamptz,
  close_reference_prob double precision,
  close_exec_price   numeric,
  clv_reference_pp   double precision,
  clv_exec_pp        double precision,
  note               text,
  observed_at        timestamptz not null default now(),
  check (status = 'missing' or (close_quote_id is not null and close_quote_at is not null)),
  check (status = 'observed' or (close_reference_prob is null and close_exec_price is null and clv_reference_pp is null and clv_exec_pp is null))
);

create table if not exists public.sim_alerts (
  id          bigint generated always as identity primary key,
  run_id      uuid references public.sim_runs (run_id),
  comparison_id uuid references public.sim_market_comparisons (comparison_id),
  sport       text,
  severity    text not null check (severity in ('FAILURE', 'DEGRADED', 'WARNING', 'INFO')),
  code        text not null check (code ~ '^[a-z0-9_.]{3,64}$'),
  message     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.sim_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- immutability
-- rows of a run may be written only while the run is 'running'
create or replace function public.sim_rows_guard()
returns trigger language plpgsql as $$
declare st text;
begin
  if tg_op = 'DELETE' then
    raise exception 'public.%: delete refused (history is kept)', tg_table_name;
  end if;
  select status into st from public.sim_runs where run_id = new.run_id;
  if st is distinct from 'running' then
    raise exception 'public.%: run % is %, its rows are frozen', tg_table_name, new.run_id, coalesce(st, 'missing');
  end if;
  return new;
end $$;
-- edges may be written only while their comparison is 'running'
create or replace function public.sim_edges_guard()
returns trigger language plpgsql as $$
declare st text;
begin
  if tg_op = 'DELETE' then raise exception 'public.sim_futures_edges: delete refused (history is kept)'; end if;
  select status into st from public.sim_market_comparisons where comparison_id = new.comparison_id;
  if st is distinct from 'running' then raise exception 'public.sim_futures_edges: comparison % is %, its rows are frozen', new.comparison_id, coalesce(st, 'missing'); end if;
  return new;
end $$;
-- a run moves running -> completed | superseded | failed, once; nothing else changes after
create or replace function public.sim_runs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.sim_runs: delete refused (history is kept)'; end if;
  if old.status <> 'running' then raise exception 'public.sim_runs: run % is %, it is frozen', old.run_id, old.status; end if;
  if new.run_id <> old.run_id or new.idempotency_key <> old.idempotency_key or new.seed <> old.seed or new.n_sims <> old.n_sims
     or new.input_hash <> old.input_hash or new.config_hash <> old.config_hash or new.model_version <> old.model_version then
    raise exception 'public.sim_runs: the identity of run % cannot change', old.run_id;
  end if;
  return new;
end $$;
create or replace function public.sim_comparisons_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.sim_market_comparisons: delete refused (history is kept)'; end if;
  if old.status <> 'running' then raise exception 'public.sim_market_comparisons: comparison % is %, it is frozen', old.comparison_id, old.status; end if;
  if new.run_id <> old.run_id then raise exception 'public.sim_market_comparisons: the run of a comparison cannot change'; end if;
  return new;
end $$;

do $trg$
declare t text;
begin
  foreach t in array array['sim_team_results', 'sim_entity_summary', 'sim_trace_samples'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.sim_rows_guard()', t || '_guard', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.sim_keep()', t || '_no_truncate', t);
  end loop;
  drop trigger if exists sim_futures_edges_guard on public.sim_futures_edges;
  create trigger sim_futures_edges_guard before insert or update or delete on public.sim_futures_edges for each row execute function public.sim_edges_guard();
  drop trigger if exists sim_published_no_delete on public.sim_published;
  create trigger sim_published_no_delete before delete on public.sim_published for each row execute function public.sim_keep();
  drop trigger if exists sim_runs_guard on public.sim_runs;
  create trigger sim_runs_guard before update or delete on public.sim_runs for each row execute function public.sim_runs_guard();
  drop trigger if exists sim_market_comparisons_guard on public.sim_market_comparisons;
  create trigger sim_market_comparisons_guard before update or delete on public.sim_market_comparisons for each row execute function public.sim_comparisons_guard();
  foreach t in array array['sim_input_snapshots', 'sim_futures_quotes', 'sim_flag_snapshots', 'sim_closing_observations', 'sim_alerts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.sim_keep()', t || '_frozen', t);
  end loop;
  foreach t in array array['sim_runs', 'sim_input_snapshots', 'sim_published', 'sim_market_comparisons', 'sim_futures_quotes', 'sim_futures_edges', 'sim_flag_snapshots', 'sim_closing_observations', 'sim_alerts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.sim_keep()', t || '_no_truncate', t);
  end loop;
end $trg$;

-- ---------------------------------------------------------------- the job's functions (service_role only)
create or replace function public.sim_alert(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare i bigint;
begin
  insert into public.sim_alerts (run_id, comparison_id, sport, severity, code, message, detail)
  values (nullif(p ->> 'run_id', '')::uuid, nullif(p ->> 'comparison_id', '')::uuid, p ->> 'sport', p ->> 'severity', p ->> 'code', p ->> 'message', p -> 'detail')
  returning id into i;
  return i;
end $$;

-- begin a run; the same idempotency key returns the existing live attempt
create or replace function public.sim_begin_run(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.sim_runs; stale interval := coalesce(nullif(p ->> 'stale_after', '')::interval, interval '3 hours');
begin
  perform pg_advisory_xact_lock(hashtextextended('sim:' || (p ->> 'sport') || ':' || (p ->> 'competition') || ':' || (p ->> 'season'), 0));
  select * into r from public.sim_runs where idempotency_key = p ->> 'idempotency_key' and status <> 'failed';
  if found then
    if r.status = 'running' and r.created_at < now() - stale then
      update public.sim_runs set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'abandoned', 'message', 'a running attempt older than ' || stale || ' was abandoned')
       where run_id = r.run_id;
      perform public.sim_alert(jsonb_build_object('run_id', r.run_id, 'sport', r.sport, 'severity', 'WARNING', 'code', 'run.abandoned', 'message', 'an abandoned attempt was marked failed before a retry'));
    elsif r.status = 'running' then
      raise exception 'sim_begin_run: a run with these inputs is already in progress (%)', r.run_id;
    else
      return jsonb_build_object('run_id', r.run_id, 'status', r.status, 'existing', true);
    end if;
  end if;
  insert into public.sim_runs (sport, competition, season, idempotency_key, seed, prng_version, n_sims, model_version, engine_version, source_commit,
    rules_version, config_hash, input_snapshot_at, input_ref, input_hash, expected, gates, validation_summary, diagnostics, limitations, runtime, started_at, finished_at)
  values (p ->> 'sport', p ->> 'competition', p ->> 'season', p ->> 'idempotency_key', p ->> 'seed', p ->> 'prng_version', (p ->> 'n_sims')::int,
    p ->> 'model_version', p ->> 'engine_version', nullif(p ->> 'source_commit', ''), p ->> 'rules_version', p ->> 'config_hash',
    (p ->> 'input_snapshot_at')::timestamptz, p ->> 'input_ref', p ->> 'input_hash', coalesce(p -> 'expected', '{}'), coalesce(p -> 'gates', '[]'),
    coalesce(p -> 'validation_summary', '{}'), coalesce(p -> 'diagnostics', '{}'), coalesce(p -> 'limitations', '[]'), coalesce(p -> 'runtime', '{}'),
    nullif(p ->> 'started_at', '')::timestamptz, nullif(p ->> 'finished_at', '')::timestamptz)
  returning * into r;
  return jsonb_build_object('run_id', r.run_id, 'status', r.status, 'existing', false);
end $$;

create or replace function public.sim_put_snapshot(p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.sim_input_snapshots (input_hash, sport, schema, data, meta)
  values (p ->> 'input_hash', p ->> 'sport', p ->> 'schema', p -> 'data', coalesce(p -> 'meta', '{}'))
  on conflict (input_hash) do nothing;
  return p ->> 'input_hash';
end $$;

-- result rows of a running run (re-sending a chunk is harmless)
create or replace function public.sim_put_results(p_run uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.sim_team_results (run_id, entity_id, entity_name, entity_groups, outcome, category, applicable, outcome_count, n_sims,
    probability, mcse, wilson_lo, wilson_hi, interval_method, fair_decimal, provenance)
  select p_run, x ->> 'entity_id', x ->> 'entity_name', coalesce(x -> 'entity_groups', '{}'), x ->> 'outcome', x ->> 'category',
    coalesce((x ->> 'applicable')::boolean, true), (x ->> 'outcome_count')::bigint, (x ->> 'n_sims')::int, (x ->> 'probability')::double precision,
    (x ->> 'mcse')::double precision, (x ->> 'wilson_lo')::double precision, (x ->> 'wilson_hi')::double precision,
    coalesce(x ->> 'interval_method', 'wilson_95'), (x ->> 'fair_decimal')::double precision, coalesce(x ->> 'provenance', 'Research')
  from jsonb_array_elements(p_rows) x
  on conflict (run_id, entity_id, outcome) do update set
    entity_name = excluded.entity_name, entity_groups = excluded.entity_groups, category = excluded.category, applicable = excluded.applicable,
    outcome_count = excluded.outcome_count, n_sims = excluded.n_sims, probability = excluded.probability, mcse = excluded.mcse,
    wilson_lo = excluded.wilson_lo, wilson_hi = excluded.wilson_hi, interval_method = excluded.interval_method,
    fair_decimal = excluded.fair_decimal, provenance = excluded.provenance;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sim_put_entities(p_run uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.sim_entity_summary (run_id, entity_id, entity_name, entity_groups, record, mean_wins, wins_hist_x2, math_status)
  select p_run, x ->> 'entity_id', x ->> 'entity_name', coalesce(x -> 'entity_groups', '{}'), x -> 'record', (x ->> 'mean_wins')::double precision,
    x -> 'wins_hist_x2', x -> 'math_status'
  from jsonb_array_elements(p_rows) x
  on conflict (run_id, entity_id) do update set entity_name = excluded.entity_name, entity_groups = excluded.entity_groups, record = excluded.record,
    mean_wins = excluded.mean_wins, wins_hist_x2 = excluded.wins_hist_x2, math_status = excluded.math_status;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sim_put_traces(p_run uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if jsonb_array_length(p_rows) + (select count(*) from public.sim_trace_samples t where t.run_id = p_run
       and not exists (select 1 from jsonb_array_elements(p_rows) y where (y ->> 'run_index')::int = t.run_index)) > 5 then
    raise exception 'sim_put_traces: at most 5 traces per run';
  end if;
  insert into public.sim_trace_samples (run_id, run_index, trace)
  select p_run, (x ->> 'run_index')::int, x -> 'trace' from jsonb_array_elements(p_rows) x
  on conflict (run_id, run_index) do update set trace = excluded.trace;
  get diagnostics n = row_count;
  return n;
end $$;

-- THE PUBLICATION: verify everything, then swap the pointer, in one transaction
create or replace function public.sim_publish_run(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.sim_runs; cur public.sim_published; had_cur boolean; e jsonb := '[]'::jsonb;
  n_res bigint; n_ent bigint; n_out int; n_entities int; rule jsonb; bad bigint; g jsonb;
begin
  select * into r from public.sim_runs where run_id = p_run;
  if not found then raise exception 'sim_publish_run: no run %', p_run; end if;
  perform pg_advisory_xact_lock(hashtextextended('sim:' || r.sport || ':' || r.competition || ':' || r.season, 0));
  select * into r from public.sim_runs where run_id = p_run for update;
  if r.status <> 'running' then raise exception 'sim_publish_run: run % is %, only a running run can be published', p_run, r.status; end if;

  n_out := coalesce((r.expected ->> 'outcomes')::int, -1);
  n_entities := coalesce((r.expected ->> 'entities')::int, -1);
  select count(*) into n_res from public.sim_team_results where run_id = p_run;
  select count(*) into n_ent from public.sim_entity_summary where run_id = p_run;
  if n_out < 1 or n_entities < 1 then e := e || jsonb_build_array('the run declares no expected entities/outcomes'); end if;
  if n_res <> n_out * n_entities then e := e || jsonb_build_array('result rows ' || n_res || ' != ' || n_entities || ' x ' || n_out); end if;
  if n_ent <> n_entities then e := e || jsonb_build_array('entity rows ' || n_ent || ' != ' || n_entities); end if;
  select count(*) into bad from public.sim_team_results where run_id = p_run and n_sims <> r.n_sims;
  if bad > 0 then e := e || jsonb_build_array(bad || ' result rows carry another N'); end if;
  select count(*) into bad from (select entity_id from public.sim_team_results where run_id = p_run group by entity_id having count(*) <> n_out) z;
  if bad > 0 then e := e || jsonb_build_array(bad || ' entities without every outcome'); end if;
  if not exists (select 1 from public.sim_input_snapshots s where s.input_hash = r.input_hash) and r.input_ref !~ '^(artifact|url):' then
    e := e || jsonb_build_array('no stored input snapshot and no durable input reference');
  end if;
  -- the competition format's sums, on the stored counts
  for rule in select * from jsonb_array_elements(coalesce(r.expected -> 'sum_rules', '[]')) loop
    select count(*) into bad from (
      select coalesce(case when rule ->> 'by' = 'league' then 'league' else entity_groups ->> (rule ->> 'by') end, '?') as grp, sum(outcome_count) as s
        from public.sim_team_results where run_id = p_run and outcome = rule ->> 'outcome' and applicable
       group by 1) z
     where z.s <> (rule ->> 'perGroup')::bigint * r.n_sims or z.grp = '?';
    if bad > 0 then e := e || jsonb_build_array('sum rule ' || (rule ->> 'outcome') || ' per ' || (rule ->> 'by') || ' fails in ' || bad || ' group(s)'); end if;
  end loop;
  -- every gate the job recorded must block nothing
  for g in select * from jsonb_array_elements(r.gates) loop
    if coalesce(g ->> 'blocks', 'none') <> 'none' then e := e || jsonb_build_array('gate ' || (g ->> 'id') || ' blocks ' || (g ->> 'blocks')); end if;
  end loop;

  if jsonb_array_length(e) > 0 then
    update public.sim_runs set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'publish_verification_failed', 'errors', e)
     where run_id = p_run;
    perform public.sim_alert(jsonb_build_object('run_id', p_run, 'sport', r.sport, 'severity', 'FAILURE', 'code', 'run.publish_refused', 'message', 'publication verification failed; the published run is unchanged', 'detail', e));
    return jsonb_build_object('published', false, 'status', 'failed', 'errors', e);
  end if;

  select * into cur from public.sim_published where sport = r.sport and competition = r.competition and season = r.season for update;
  had_cur := found;
  if had_cur and cur.input_snapshot_at > r.input_snapshot_at then
    update public.sim_runs set status = 'superseded', completed_at = now() where run_id = p_run;
    perform public.sim_alert(jsonb_build_object('run_id', p_run, 'sport', r.sport, 'severity', 'WARNING', 'code', 'run.superseded', 'message', 'a run with newer inputs is already published; this run is kept but not shown'));
    return jsonb_build_object('published', false, 'status', 'superseded', 'current_run_id', cur.run_id);
  end if;
  update public.sim_runs set status = 'completed', completed_at = now() where run_id = p_run;
  insert into public.sim_published (sport, competition, season, run_id, input_snapshot_at, published_at, previous_run_id, comparison_id)
  values (r.sport, r.competition, r.season, p_run, r.input_snapshot_at, now(), null, null)
  on conflict (sport, competition, season) do update set run_id = excluded.run_id, input_snapshot_at = excluded.input_snapshot_at,
    published_at = excluded.published_at, previous_run_id = public.sim_published.run_id, comparison_id = null;
  return jsonb_build_object('published', true, 'status', 'completed', 'run_id', p_run, 'previous_run_id', case when had_cur then cur.run_id end);
end $$;

create or replace function public.sim_fail_run(p_run uuid, p_error jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.sim_runs;
begin
  select * into r from public.sim_runs where run_id = p_run for update;
  if not found then raise exception 'sim_fail_run: no run %', p_run; end if;
  if r.status <> 'running' then return jsonb_build_object('run_id', p_run, 'status', r.status, 'changed', false); end if;
  update public.sim_runs set status = 'failed', failed_at = now(), error_summary = coalesce(p_error, jsonb_build_object('code', 'unknown')) where run_id = p_run;
  perform public.sim_alert(jsonb_build_object('run_id', p_run, 'sport', r.sport, 'severity', 'FAILURE', 'code', 'run.failed', 'message', coalesce(p_error ->> 'message', 'simulation run failed'), 'detail', p_error));
  return jsonb_build_object('run_id', p_run, 'status', 'failed', 'changed', true);
end $$;

-- ---------------------------------------------------------------- market comparisons (service_role only)
create or replace function public.sim_begin_comparison(p jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.sim_runs; id uuid;
begin
  select * into r from public.sim_runs where run_id = (p ->> 'run_id')::uuid;
  if not found or r.status <> 'completed' then raise exception 'sim_begin_comparison: run % is not a completed run', p ->> 'run_id'; end if;
  insert into public.sim_market_comparisons (run_id, sport, competition, season, mapping_version, methodology, expected)
  values (r.run_id, r.sport, r.competition, r.season, p ->> 'mapping_version', coalesce(p -> 'methodology', '{}'), coalesce(p -> 'expected', '{}'))
  returning comparison_id into id;
  return id;
end $$;

create or replace function public.sim_put_quotes(p_comparison uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  with ins as (
    insert into public.sim_futures_quotes (comparison_id, market_ticker, event_ticker, series_ticker, captured_at, status, yes_bid, yes_ask, no_bid, no_ask,
      yes_ask_size, yes_bid_size, last_price, volume, open_interest, close_time, rules_sha256, host, raw)
    select p_comparison, x ->> 'market_ticker', x ->> 'event_ticker', x ->> 'series_ticker', (x ->> 'captured_at')::timestamptz, x ->> 'status',
      (x ->> 'yes_bid')::numeric, (x ->> 'yes_ask')::numeric, (x ->> 'no_bid')::numeric, (x ->> 'no_ask')::numeric,
      (x ->> 'yes_ask_size')::numeric, (x ->> 'yes_bid_size')::numeric, (x ->> 'last_price')::numeric, (x ->> 'volume')::numeric, (x ->> 'open_interest')::numeric,
      (x ->> 'close_time')::timestamptz, x ->> 'rules_sha256', x ->> 'host', coalesce(x -> 'raw', '{}')
    from jsonb_array_elements(p_rows) x
    returning quote_id, market_ticker)
  select coalesce(jsonb_object_agg(market_ticker, quote_id), '{}'::jsonb) into out from ins;
  return out;
end $$;

create or replace function public.sim_put_edges(p_comparison uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; rid uuid;
begin
  select run_id into rid from public.sim_market_comparisons where comparison_id = p_comparison;
  insert into public.sim_futures_edges (comparison_id, run_id, market_ticker, event_ticker, series_ticker, mapping_id, entity_id, outcome, settlement_basis,
    quote_id, quote_at, quote_age_minutes, yes_bid, yes_ask, yes_ask_size, reference_basis, reference_prob, normalization, normalized_ref_prob, normalization_note,
    research_prob, research_mcse, research_fair_decimal, reference_edge_pp, exec_quantity, exec_price, fee_per_contract, fee_basis, fee_verified,
    exec_cost_prob, exec_edge_pp, expected_net_return, stale, eligible, actionable, block_reasons, provenance)
  select p_comparison, rid, x ->> 'market_ticker', x ->> 'event_ticker', x ->> 'series_ticker', x ->> 'mapping_id', x ->> 'entity_id', x ->> 'outcome', x ->> 'settlement_basis',
    (x ->> 'quote_id')::bigint, (x ->> 'quote_at')::timestamptz, (x ->> 'quote_age_minutes')::double precision, (x ->> 'yes_bid')::numeric, (x ->> 'yes_ask')::numeric,
    (x ->> 'yes_ask_size')::numeric, x ->> 'reference_basis', (x ->> 'reference_prob')::double precision, coalesce(x ->> 'normalization', 'none'),
    (x ->> 'normalized_ref_prob')::double precision, x ->> 'normalization_note', (x ->> 'research_prob')::double precision, (x ->> 'research_mcse')::double precision,
    (x ->> 'research_fair_decimal')::double precision, (x ->> 'reference_edge_pp')::double precision, (x ->> 'exec_quantity')::int, (x ->> 'exec_price')::numeric,
    (x ->> 'fee_per_contract')::numeric, x ->> 'fee_basis', coalesce((x ->> 'fee_verified')::boolean, false), (x ->> 'exec_cost_prob')::double precision,
    (x ->> 'exec_edge_pp')::double precision, (x ->> 'expected_net_return')::double precision, (x ->> 'stale')::boolean, (x ->> 'eligible')::boolean,
    coalesce((x ->> 'actionable')::boolean, false), coalesce(array(select jsonb_array_elements_text(x -> 'block_reasons')), '{}'), coalesce(x -> 'provenance', '{}')
  from jsonb_array_elements(p_rows) x
  on conflict (comparison_id, market_ticker) do update set quote_id = excluded.quote_id, reference_prob = excluded.reference_prob,
    normalized_ref_prob = excluded.normalized_ref_prob, research_prob = excluded.research_prob, exec_price = excluded.exec_price, exec_edge_pp = excluded.exec_edge_pp,
    stale = excluded.stale, eligible = excluded.eligible, actionable = excluded.actionable, block_reasons = excluded.block_reasons;
  get diagnostics n = row_count;
  return n;
end $$;

-- publish a comparison: verify, freeze, snapshot every actionable flag, point at it
create or replace function public.sim_publish_comparison(p_comparison uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.sim_market_comparisons; cur public.sim_published; n bigint; expect int; flags int;
begin
  select * into c from public.sim_market_comparisons where comparison_id = p_comparison;
  if not found then raise exception 'sim_publish_comparison: no comparison %', p_comparison; end if;
  perform pg_advisory_xact_lock(hashtextextended('sim:' || c.sport || ':' || c.competition || ':' || c.season, 0));
  select * into c from public.sim_market_comparisons where comparison_id = p_comparison for update;
  if c.status <> 'running' then raise exception 'sim_publish_comparison: comparison % is %', p_comparison, c.status; end if;
  select count(*) into n from public.sim_futures_edges where comparison_id = p_comparison;
  expect := coalesce((c.expected ->> 'edges')::int, -1);
  if n <> expect then
    update public.sim_market_comparisons set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'edge_count', 'rows', n, 'expected', expect) where comparison_id = p_comparison;
    perform public.sim_alert(jsonb_build_object('comparison_id', p_comparison, 'sport', c.sport, 'severity', 'FAILURE', 'code', 'market.publish_refused', 'message', 'edge rows ' || n || ' != expected ' || expect));
    return jsonb_build_object('published', false, 'status', 'failed');
  end if;
  select * into cur from public.sim_published where sport = c.sport and competition = c.competition and season = c.season for update;
  if not found or cur.run_id <> c.run_id then
    update public.sim_market_comparisons set status = 'failed', failed_at = now(), error_summary = jsonb_build_object('code', 'run_not_current', 'message', 'the compared run is not the published run') where comparison_id = p_comparison;
    return jsonb_build_object('published', false, 'status', 'failed', 'reason', 'run_not_current');
  end if;
  insert into public.sim_flag_snapshots (comparison_id, run_id, market_ticker, entity_id, outcome, payload, payload_sha256)
  select e.comparison_id, e.run_id, e.market_ticker, e.entity_id, e.outcome, to_jsonb(e) || jsonb_build_object('methodology', c.methodology, 'mapping_version', c.mapping_version),
         encode(sha256(convert_to((to_jsonb(e) || jsonb_build_object('methodology', c.methodology, 'mapping_version', c.mapping_version))::text, 'UTF8')), 'hex')
    from public.sim_futures_edges e where e.comparison_id = p_comparison and e.actionable
  on conflict (comparison_id, market_ticker) do nothing;
  get diagnostics flags = row_count;
  update public.sim_market_comparisons set status = 'completed', completed_at = now(), counts = counts || jsonb_build_object('edges', n, 'flags', flags) where comparison_id = p_comparison;
  update public.sim_published set comparison_id = p_comparison where sport = c.sport and competition = c.competition and season = c.season;
  return jsonb_build_object('published', true, 'status', 'completed', 'edges', n, 'flags', flags);
end $$;

create or replace function public.sim_fail_comparison(p_comparison uuid, p_error jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.sim_market_comparisons;
begin
  select * into c from public.sim_market_comparisons where comparison_id = p_comparison for update;
  if not found or c.status <> 'running' then return jsonb_build_object('changed', false); end if;
  update public.sim_market_comparisons set status = 'failed', failed_at = now(), error_summary = coalesce(p_error, '{}'::jsonb) || jsonb_build_object('code', coalesce(p_error ->> 'code', 'market_failure'))
   where comparison_id = p_comparison;
  perform public.sim_alert(jsonb_build_object('comparison_id', p_comparison, 'sport', c.sport, 'severity', 'DEGRADED', 'code', 'market.failed',
    'message', coalesce(p_error ->> 'message', 'market comparison failed; the simulation stays published'), 'detail', p_error));
  return jsonb_build_object('changed', true);
end $$;

-- the close of a flagged market: observed, or recorded as missing (never the settled 0/1)
create or replace function public.sim_put_close(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.sim_closing_observations (flag_id, close_basis, close_window, status, close_quote_id, close_quote_at, close_reference_prob,
    close_exec_price, clv_reference_pp, clv_exec_pp, note)
  values ((p ->> 'flag_id')::bigint, p ->> 'close_basis', p ->> 'close_window', p ->> 'status', (p ->> 'close_quote_id')::bigint, (p ->> 'close_quote_at')::timestamptz,
    (p ->> 'close_reference_prob')::double precision, (p ->> 'close_exec_price')::numeric, (p ->> 'clv_reference_pp')::double precision, (p ->> 'clv_exec_pp')::double precision, p ->> 'note')
  on conflict (flag_id) do nothing;
  return (p ->> 'flag_id')::bigint;
end $$;

-- grade every flag whose market has closed: the LAST quote EdgeDesk itself
-- captured inside [close_time - window, close_time] is the close (reference =
-- its YES mid when two-sided with spread <= 0.06; executable = its ask). No
-- such quote: the close is recorded as 'missing'. A settled 0/1 is never used.
--   reference CLV (points) = close reference - the flag's reference
--   executable CLV (points) = close reference - the flag's executable price
create or replace function public.sim_grade_closes(p_window_minutes integer default 1560)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare f record; q record; ref double precision; n_obs int := 0; n_miss int := 0;
begin
  if not (p_window_minutes between 1 and 10080) then raise exception 'sim_grade_closes: window must be 1..10080 minutes'; end if;
  for f in
    select fs.flag_id, fs.market_ticker, (fs.payload ->> 'reference_prob')::double precision as flag_ref, (fs.payload ->> 'exec_price')::double precision as flag_exec, fq.close_time
      from public.sim_flag_snapshots fs
      join public.sim_futures_quotes fq on fq.quote_id = (fs.payload ->> 'quote_id')::bigint
     where fq.close_time is not null and fq.close_time <= now()
       and not exists (select 1 from public.sim_closing_observations o where o.flag_id = fs.flag_id)
  loop
    select * into q from public.sim_futures_quotes x
     where x.market_ticker = f.market_ticker and x.captured_at <= f.close_time and x.captured_at >= f.close_time - make_interval(mins => p_window_minutes)
     order by x.captured_at desc limit 1;
    if not found then
      insert into public.sim_closing_observations (flag_id, close_basis, close_window, status, note)
      values (f.flag_id, 'last EdgeDesk-captured quote before close_time', p_window_minutes || ' minutes', 'missing', 'no quote was captured inside the window');
      n_miss := n_miss + 1;
    else
      ref := case when q.yes_bid > 0 and q.yes_ask < 1 and q.yes_ask >= q.yes_bid and q.yes_ask - q.yes_bid <= 0.06 then (q.yes_bid + q.yes_ask) / 2 end;
      insert into public.sim_closing_observations (flag_id, close_basis, close_window, status, close_quote_id, close_quote_at, close_reference_prob, close_exec_price,
        clv_reference_pp, clv_exec_pp, note)
      values (f.flag_id, 'last EdgeDesk-captured quote before close_time', p_window_minutes || ' minutes', 'observed', q.quote_id, q.captured_at, ref, q.yes_ask,
        case when ref is not null and f.flag_ref is not null then round(((ref - f.flag_ref) * 100)::numeric, 4) end,
        case when ref is not null and f.flag_exec is not null then round(((ref - f.flag_exec) * 100)::numeric, 4) end,
        case when ref is null then 'the closing quote was one-sided or wide: no closing reference' end);
      n_obs := n_obs + 1;
    end if;
  end loop;
  return jsonb_build_object('observed', n_obs, 'missing', n_miss);
end $$;

-- ---------------------------------------------------------------- what anyone may know (no probability)
create or replace function public.sim_public_status()
returns table (sport text, competition text, season text, published_run_id uuid, published_at timestamptz, input_snapshot_at timestamptz,
  n_sims integer, model_version text, last_attempt_status text, last_attempt_at timestamptz, comparison_status text, comparison_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p.sport, l.sport), coalesce(p.competition, l.competition), coalesce(p.season, l.season), p.run_id, p.published_at, r.input_snapshot_at, r.n_sims, r.model_version,
         l.status, coalesce(l.failed_at, l.completed_at, l.created_at), mc.status, coalesce(mc.completed_at, mc.failed_at, mc.created_at)
    from (select distinct on (x.sport, x.competition, x.season) x.* from public.sim_runs x order by x.sport, x.competition, x.season, x.created_at desc) l
    full join public.sim_published p on p.sport = l.sport and p.competition = l.competition and p.season = l.season
    left join public.sim_runs r on r.run_id = p.run_id
    left join lateral (select y.* from public.sim_market_comparisons y where y.sport = coalesce(p.sport, l.sport) and y.competition = coalesce(p.competition, l.competition)
                         and y.season = coalesce(p.season, l.season) order by y.created_at desc limit 1) mc on true;
$$;

-- ---------------------------------------------------------------- row level security
alter table public.sim_runs enable row level security;
alter table public.sim_input_snapshots enable row level security;
alter table public.sim_team_results enable row level security;
alter table public.sim_entity_summary enable row level security;
alter table public.sim_trace_samples enable row level security;
alter table public.sim_published enable row level security;
alter table public.sim_market_comparisons enable row level security;
alter table public.sim_futures_quotes enable row level security;
alter table public.sim_futures_edges enable row level security;
alter table public.sim_flag_snapshots enable row level security;
alter table public.sim_closing_observations enable row level security;
alter table public.sim_alerts enable row level security;
alter table public.sim_config enable row level security;

drop policy if exists sim_runs_read on public.sim_runs;
create policy sim_runs_read on public.sim_runs for select to authenticated
  using (status in ('completed', 'superseded') and public.sim_viewer_entitled());
drop policy if exists sim_published_read on public.sim_published;
create policy sim_published_read on public.sim_published for select to authenticated using (public.sim_viewer_entitled());
do $pol$
declare t text;
begin
  foreach t in array array['sim_team_results', 'sim_entity_summary', 'sim_trace_samples'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.sim_viewer_entitled() and exists (select 1 from public.sim_runs r where r.run_id = %I.run_id and r.status in (''completed'', ''superseded'')))', t || '_read', t, t);
  end loop;
end $pol$;
drop policy if exists sim_input_snapshots_read on public.sim_input_snapshots;
create policy sim_input_snapshots_read on public.sim_input_snapshots for select to authenticated
  using (public.sim_viewer_entitled() and exists (select 1 from public.sim_runs r where r.input_hash = sim_input_snapshots.input_hash and r.status in ('completed', 'superseded')));
drop policy if exists sim_market_comparisons_read on public.sim_market_comparisons;
create policy sim_market_comparisons_read on public.sim_market_comparisons for select to authenticated using (status = 'completed' and public.sim_viewer_entitled());
drop policy if exists sim_futures_edges_read on public.sim_futures_edges;
create policy sim_futures_edges_read on public.sim_futures_edges for select to authenticated
  using (public.sim_viewer_entitled() and exists (select 1 from public.sim_market_comparisons c where c.comparison_id = sim_futures_edges.comparison_id and c.status = 'completed'));
drop policy if exists sim_futures_quotes_read on public.sim_futures_quotes;
create policy sim_futures_quotes_read on public.sim_futures_quotes for select to authenticated using (public.sim_viewer_entitled());
drop policy if exists sim_flag_snapshots_read on public.sim_flag_snapshots;
create policy sim_flag_snapshots_read on public.sim_flag_snapshots for select to authenticated using (public.sim_viewer_entitled());
drop policy if exists sim_closing_observations_read on public.sim_closing_observations;
create policy sim_closing_observations_read on public.sim_closing_observations for select to authenticated using (public.sim_viewer_entitled());
-- sim_alerts and sim_config: no client policy at all (service role and operators only)

-- no client role writes anything, ever (Supabase grants DML on public by default; RLS
-- with no write policy already refuses it, and the grants are removed as well)
revoke insert, update, delete, truncate on public.sim_runs, public.sim_input_snapshots, public.sim_team_results, public.sim_entity_summary, public.sim_trace_samples,
  public.sim_published, public.sim_market_comparisons, public.sim_futures_quotes, public.sim_futures_edges, public.sim_flag_snapshots,
  public.sim_closing_observations, public.sim_alerts, public.sim_config from anon, authenticated;
revoke select on public.sim_alerts, public.sim_config from anon, authenticated;
grant select on public.sim_runs, public.sim_input_snapshots, public.sim_team_results, public.sim_entity_summary, public.sim_trace_samples, public.sim_published,
  public.sim_market_comparisons, public.sim_futures_quotes, public.sim_futures_edges, public.sim_flag_snapshots, public.sim_closing_observations to authenticated;
revoke all on public.sim_runs, public.sim_input_snapshots, public.sim_team_results, public.sim_entity_summary, public.sim_trace_samples, public.sim_published,
  public.sim_market_comparisons, public.sim_futures_quotes, public.sim_futures_edges, public.sim_flag_snapshots, public.sim_closing_observations from anon;

-- the reader's views: the published run of each competition only (as the reader: RLS applies)
create or replace view public.sim_current_runs with (security_invoker = true) as
  select r.*, p.published_at, p.comparison_id
    from public.sim_published p join public.sim_runs r on r.run_id = p.run_id;
create or replace view public.sim_current_results with (security_invoker = true) as
  select t.* from public.sim_team_results t join public.sim_published p on p.run_id = t.run_id;
create or replace view public.sim_current_entities with (security_invoker = true) as
  select e.* from public.sim_entity_summary e join public.sim_published p on p.run_id = e.run_id;
create or replace view public.sim_current_edges with (security_invoker = true) as
  select e.* from public.sim_futures_edges e join public.sim_published p on p.comparison_id = e.comparison_id and p.run_id = e.run_id;
revoke all on public.sim_current_runs, public.sim_current_results, public.sim_current_entities, public.sim_current_edges from anon;
revoke insert, update, delete, truncate on public.sim_current_runs, public.sim_current_results, public.sim_current_entities, public.sim_current_edges from authenticated;
grant select on public.sim_current_runs, public.sim_current_results, public.sim_current_entities, public.sim_current_edges to authenticated;

-- function grants: the job's functions to service_role only; the two read helpers to readers
do $g$
declare f text;
begin
  foreach f in array array['public.sim_alert(jsonb)', 'public.sim_begin_run(jsonb)', 'public.sim_put_snapshot(jsonb)', 'public.sim_put_results(uuid,jsonb)',
    'public.sim_put_entities(uuid,jsonb)', 'public.sim_put_traces(uuid,jsonb)', 'public.sim_publish_run(uuid)', 'public.sim_fail_run(uuid,jsonb)',
    'public.sim_begin_comparison(jsonb)', 'public.sim_put_quotes(uuid,jsonb)', 'public.sim_put_edges(uuid,jsonb)', 'public.sim_publish_comparison(uuid)',
    'public.sim_fail_comparison(uuid,jsonb)', 'public.sim_put_close(jsonb)', 'public.sim_grade_closes(integer)', 'public.sim_keep()', 'public.sim_rows_guard()', 'public.sim_edges_guard()',
    'public.sim_runs_guard()', 'public.sim_comparisons_guard()'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') and f !~ '(keep|guard)\(\)$' then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  execute 'revoke all on function public.sim_viewer_entitled() from public';
  execute 'grant execute on function public.sim_viewer_entitled() to anon, authenticated';
  execute 'revoke all on function public.sim_public_status() from public';
  execute 'grant execute on function public.sim_public_status() to anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sim_viewer_entitled(), public.sim_public_status() to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- report
select 1 as row, 'tables exist' as check,
       case when to_regclass('public.sim_runs') is not null and to_regclass('public.sim_team_results') is not null and to_regclass('public.sim_published') is not null
             and to_regclass('public.sim_futures_edges') is not null and to_regclass('public.sim_flag_snapshots') is not null and to_regclass('public.sim_closing_observations') is not null
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'row level security on every sim table',
       case when (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sim\_%') then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role can write a sim table',
       case when not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'sim\_%'
                              and g.grantee in ('anon', 'authenticated') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) then 'ok' else 'CHECK THIS' end
union all select 4, 'the job functions are not callable by clients',
       case when not has_function_privilege('anon', 'public.sim_publish_run(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.sim_publish_run(uuid)', 'execute')
             and not has_function_privilege('authenticated', 'public.sim_put_results(uuid,jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
union all select 5, 'the entitlement gate defers to the project rule',
       case when to_regprocedure('public.community_is_entitled(uuid)') is not null then 'ok' else 'CHECK THIS: public.community_is_entitled(uuid) is not installed — nobody can read simulator results (fail closed) until it is' end
union all select 6, 'an anonymous caller is not entitled',
       case when not public.sim_viewer_entitled() then 'ok' else 'CHECK THIS' end;
