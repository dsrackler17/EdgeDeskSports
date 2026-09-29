-- =============================================================================
-- player_props_pipeline — the Player Props price pipeline's own health record,
-- its run log, and the reader's manual refresh requests.
--
-- Paste into the Supabase SQL editor (or apply with the Deploy intelligence
-- workflow's apply_player_props_pipeline input). Idempotent, additive, no psql
-- meta-commands, ends in a report whose rows say ok. Tested against a real
-- PostgreSQL by tools/props/props_pipeline_sql.test.js.
--
-- WHY. On 2026-09-29 the Props page sat on "Sportsbook prices: STALE" for
-- hours and nothing said why (GitHub's cron fired twice in eight hours; the
-- capture then skipped every game on its 3 h / 8 h clock). These tables say
-- why in one query, and props_cron reads them to know when a capture is due.
--
--   1. player_props_pipeline_runs     one row per (run, league): asked,
--      returned, duration, provider answer, rate limit, health verdict.
--   2. player_props_pipeline_health   one row per league: the latest verdict
--      (HEALTHY / DEGRADED / DELAYED / OUTAGE), next due, scheduler ticks.
--   3. player_props_refresh_requests  a reader's "refresh prices now", admitted
--      atomically by player_props_refresh_admit() under cool-downs.
--   4. player_props_executable_max_minutes() mirrors EDProps
--      FRESHNESS.executable_max_minutes (a test pins them), and view
--      player_prop_executable_quotes is the best CURRENT pregame price per
--      selection from capture v11 (player_prop_best_quotes stays history).
--
-- Nothing here deletes a quote, a tick or a run. History is kept.
-- =============================================================================

begin;

-- ── 1. THE RUN LOG ───────────────────────────────────────────────────────────
create table if not exists public.player_props_pipeline_runs (
  id                   bigserial primary key,
  run_key              text not null,
  league               text not null,
  trigger              text,
  refresh_request_id   uuid,
  started_at           timestamptz not null,
  completed_at         timestamptz,
  status               text,
  reason               text,
  skipped              text,
  health               text,
  health_reason        text,
  events_in_window     integer,
  events_requested     integer,
  events_succeeded     integer,
  events_failed        integer,
  events_no_markets    integer,
  markets_received     integer,
  quotes_received      integer,
  quotes_usable        integer,
  quotes_refused       integer,
  provider_http        text,
  rate_limited_until   timestamptz,
  requests_remaining   integer,
  credits_spent        numeric,
  duration_ms          integer,
  consecutive_failures integer,
  error_message        text,
  next_due_at          timestamptz,
  detail               jsonb,
  recorded_at          timestamptz not null default now()
);
create unique index if not exists player_props_pipeline_runs_once_idx on public.player_props_pipeline_runs (run_key, league);
create index if not exists player_props_pipeline_runs_recent_idx on public.player_props_pipeline_runs (league, started_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_props_pipeline_runs_league_chk') then
    alter table public.player_props_pipeline_runs add constraint player_props_pipeline_runs_league_chk check (league in ('nfl', 'cfb'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_props_pipeline_runs_health_chk') then
    alter table public.player_props_pipeline_runs add constraint player_props_pipeline_runs_health_chk
      check (health is null or health in ('HEALTHY', 'DEGRADED', 'DELAYED', 'OUTAGE'));
  end if;
end $$;

comment on table public.player_props_pipeline_runs is
  'One row per Player Props workflow run and league: requested / succeeded / failed events, markets and quotes '
  'received and usable, the provider HTTP answer, rate-limit window, credits, duration, consecutive failures, '
  'the health verdict and why. Written by football/props/health_sync.js. Never edited, never deleted.';

-- ── 2. THE LATEST VERDICT, PER LEAGUE ────────────────────────────────────────
create table if not exists public.player_props_pipeline_health (
  league                text primary key,
  health                text,
  health_reason         text,
  health_text           text,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_full_success_at  timestamptz,
  last_status           text,
  last_reason           text,
  last_error            text,
  provider_http         text,
  rate_limited_until    timestamptz,
  consecutive_failures  integer,
  requests_remaining    integer,
  events_in_window      integer,
  events_on_target      integer,
  events_failed         integer,
  next_due_at           timestamptz,
  board_built_at        timestamptz,
  last_run_key          text,
  scheduler_tick_at     timestamptz,
  scheduler_action      text,
  scheduler_reason      text,
  last_dispatch_at      timestamptz,
  updated_at            timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_props_pipeline_health_chk') then
    alter table public.player_props_pipeline_health add constraint player_props_pipeline_health_chk
      check (league in ('nfl', 'cfb') and (health is null or health in ('HEALTHY', 'DEGRADED', 'DELAYED', 'OUTAGE')));
  end if;
end $$;
comment on table public.player_props_pipeline_health is
  'The latest Player Props pipeline verdict per league and when the capture is next due. Upserted by '
  'football/props/health_sync.js after each run; the scheduler columns are written by supabase/functions/props_cron.';

-- ── 3. A READER'S "REFRESH PRICES NOW" ───────────────────────────────────────
create table if not exists public.player_props_refresh_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,
  league        text not null,
  event_ids     text[],
  requested_at  timestamptz not null default now(),
  status        text not null default 'queued',
  reason        text,
  retry_after_s integer,
  dispatched_at timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  run_key       text,
  result        jsonb
);
create index if not exists player_props_refresh_requests_recent_idx on public.player_props_refresh_requests (requested_at desc);
create index if not exists player_props_refresh_requests_user_idx on public.player_props_refresh_requests (user_id, requested_at desc);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_props_refresh_requests_status_chk') then
    alter table public.player_props_refresh_requests add constraint player_props_refresh_requests_status_chk
      check (status in ('queued', 'dispatched', 'running', 'completed', 'failed', 'rejected') and league in ('nfl', 'cfb', 'all'));
  end if;
end $$;

-- Admit a refresh, atomically. One at a time (an advisory lock), a per-reader
-- cool-down and a global one: a double click, two tabs or a script get one
-- capture, and the rest are told exactly how long to wait. A request already
-- in flight for the league is returned instead of a new one (idempotent).
create or replace function public.player_props_refresh_admit(
  p_user uuid, p_league text, p_event_ids text[] default null,
  p_user_cooldown_s integer default 300, p_global_cooldown_s integer default 120)
returns table (admitted boolean, request_id uuid, status text, reason text, retry_after_s integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inflight public.player_props_refresh_requests;
  v_last_user timestamptz;
  v_last_any timestamptz;
  v_wait integer;
  v_id uuid;
begin
  if p_league not in ('nfl', 'cfb', 'all') then
    return query select false, null::uuid, 'rejected'::text, 'unknown league'::text, null::integer; return;
  end if;
  perform pg_advisory_xact_lock(hashtext('player_props_refresh'));
  select * into v_inflight from public.player_props_refresh_requests r
   where r.status in ('queued', 'dispatched', 'running') and (r.league = p_league or r.league = 'all' or p_league = 'all')
     and r.requested_at > now() - interval '20 minutes'
   order by r.requested_at desc limit 1;
  if found then
    return query select true, v_inflight.id, v_inflight.status, 'a refresh is already in progress'::text, null::integer; return;
  end if;
  select max(r.requested_at) into v_last_user from public.player_props_refresh_requests r
   where r.user_id is not distinct from p_user and r.status <> 'rejected';
  if v_last_user is not null and v_last_user > now() - make_interval(secs => p_user_cooldown_s) then
    v_wait := ceil(extract(epoch from (v_last_user + make_interval(secs => p_user_cooldown_s) - now())))::integer;
    return query select false, null::uuid, 'rejected'::text, 'you refreshed recently'::text, v_wait; return;
  end if;
  select max(r.requested_at) into v_last_any from public.player_props_refresh_requests r where r.status <> 'rejected';
  if v_last_any is not null and v_last_any > now() - make_interval(secs => p_global_cooldown_s) then
    v_wait := ceil(extract(epoch from (v_last_any + make_interval(secs => p_global_cooldown_s) - now())))::integer;
    return query select false, null::uuid, 'rejected'::text, 'prices were refreshed moments ago'::text, v_wait; return;
  end if;
  insert into public.player_props_refresh_requests (user_id, league, event_ids) values (p_user, p_league, p_event_ids) returning id into v_id;
  return query select true, v_id, 'queued'::text, null::text, null::integer;
end $$;
revoke all on function public.player_props_refresh_admit(uuid, text, text[], integer, integer) from public;

-- ── 4. THE EXECUTION WINDOW, AND THE CURRENT BEST PRICE ─────────────────────
create or replace function public.player_props_executable_max_minutes()
returns integer language sql immutable as $$ select 30 $$;
comment on function public.player_props_executable_max_minutes() is
  'Mirror of lib/edgedesk_props.js FRESHNESS.executable_max_minutes: the oldest a player-prop quote may be and '
  'still price an EV, a decision or a stake. tools/props/props_pipeline_sql.test.js pins the two equal.';

-- only where capture v11's quote table exists (capture_v11_player_props.sql)
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'player_prop_quotes' and column_name = 'quote_key') then
    execute $v$
      create or replace view public.player_prop_executable_quotes with (security_invoker = true) as
      select distinct on (event_id, market, player_key, side, point)
             event_id, sport_key, commence_time, home_team, away_team, player_name, player_key,
             market, side, point, book_key, book_title, source_market, decimal_odds,
             book_fair_probability, captured_at,
             round(extract(epoch from (now() - captured_at)) / 60.0, 1) as age_minutes
        from public.player_prop_quotes
       where captured_at >= now() - make_interval(mins => public.player_props_executable_max_minutes())
         and captured_at <= now() + interval '5 minutes'
         and (commence_time is null or commence_time > now())
       order by event_id, market, player_key, side, point, decimal_odds desc, captured_at desc, book_key
    $v$;
    execute 'comment on view public.player_prop_executable_quotes is ''The best CURRENT price per selection: pregame, captured inside the execution window. player_prop_best_quotes keeps every price for history; it is not executable.''';
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'grant select on public.player_prop_executable_quotes to authenticated';
    end if;
  end if;
end $$;

-- ── 5. ACCESS: signed-in readers read health; a reader reads only their own
--      requests; only the service role (health_sync, props_cron) writes ─────
alter table public.player_props_pipeline_runs     enable row level security;
alter table public.player_props_pipeline_health   enable row level security;
alter table public.player_props_refresh_requests  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['player_props_pipeline_runs', 'player_props_pipeline_health', 'player_props_refresh_requests'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete on public.%I from authenticated', t);
      execute format('grant select on public.%I to authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'drop policy if exists player_props_pipeline_runs_read on public.player_props_pipeline_runs';
    execute 'create policy player_props_pipeline_runs_read on public.player_props_pipeline_runs for select to authenticated using (true)';
    execute 'drop policy if exists player_props_pipeline_health_read on public.player_props_pipeline_health';
    execute 'create policy player_props_pipeline_health_read on public.player_props_pipeline_health for select to authenticated using (true)';
    execute 'drop policy if exists player_props_refresh_requests_own on public.player_props_refresh_requests';
    execute 'create policy player_props_refresh_requests_own on public.player_props_refresh_requests for select to authenticated using (user_id = auth.uid())';
  end if;
  -- Supabase's default privileges grant execute on new functions to anon and
  -- authenticated: a reader must never admit their own refresh (it would skip
  -- the cool-down props_cron applies), so only the service role may
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.player_props_refresh_admit(uuid, text, text[], integer, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.player_props_refresh_admit(uuid, text, text[], integer, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.player_props_refresh_admit(uuid, text, text[], integer, integer) to service_role';
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- ── 6. THE REPORT ────────────────────────────────────────────────────────────
-- Every row should say ok.
with checks as (
  select 1 as n, 'player_props_pipeline_runs exists, one row per run and league' as check_name,
         (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'player_props_pipeline_runs_once_idx')::int as got, 1 as want
  union all select 2, 'player_props_pipeline_health exists with league as its key',
         (select count(*) from pg_constraint where conrelid = 'public.player_props_pipeline_health'::regclass and contype = 'p')::int, 1
  union all select 3, 'player_props_refresh_requests exists',
         (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'player_props_refresh_requests')::int, 1
  union all select 4, 'the league / health / status rules are in place',
         (select count(*) from pg_constraint where conname in ('player_props_pipeline_runs_league_chk', 'player_props_pipeline_runs_health_chk',
            'player_props_pipeline_health_chk', 'player_props_refresh_requests_status_chk'))::int, 4
  union all select 5, 'refresh admission is one function, security definer, not callable by a reader',
         (select count(*) from pg_proc where proname = 'player_props_refresh_admit' and prosecdef
            and not exists (select 1 from pg_roles where rolname = 'authenticated'
                             and has_function_privilege('authenticated', 'public.player_props_refresh_admit(uuid, text, text[], integer, integer)', 'execute')))::int, 1
  union all select 6, 'the execution window is 30 minutes (EDProps FRESHNESS)',
         (select public.player_props_executable_max_minutes()), 30
  union all select 7, 'RLS is on for all three tables',
         (select count(*) from pg_class where relrowsecurity and oid in ('public.player_props_pipeline_runs'::regclass,
            'public.player_props_pipeline_health'::regclass, 'public.player_props_refresh_requests'::regclass))::int, 3
  union all select 8, 'the executable-quote view exists where capture v11 is installed',
         (select count(*) from information_schema.views where table_schema = 'public' and table_name = 'player_prop_executable_quotes')::int,
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'player_prop_quotes' and column_name = 'quote_key')::int
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
