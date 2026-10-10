-- =============================================================================
-- odds_quota — ONE request budget for every caller of The Odds API.
-- docs/market-resilience/README.md (§ Quota protection)
--
-- WHAT IT IS
--   Before a billed odds request, a caller (the capture function, the close
--   function, an AI-triggered refresh, a scheduled job) asks
--   odds_quota_acquire(): may I spend about N credits on this key now? The
--   answer is decided in ONE place, atomically, from:
--     - the operating mode (LIVE, or RESEARCH_ONLY = no live requests at all);
--     - the circuit breaker (opened by a 429, a 401, repeated timeouts);
--     - quota exhaustion reported by the provider (held until the reset);
--     - in-flight coalescing (an identical request already running is not
--       bought twice);
--     - cache-first (a key refreshed inside its minimum interval is fresh
--       enough: read the stored data);
--     - the daily and monthly credit limits, with a RESERVE only critical
--       work (near-kickoff and closing-line refreshes) may spend;
--     - the provider's own reported balance against a floor.
--   After the request the caller settles it with what the provider actually
--   charged and reported (x-requests-last / -remaining / -used) and how it
--   ended. A 429 opens the breaker with exponential back-off; exhaustion
--   holds every caller until the reset; nothing is retried by the ledger.
--
-- WHY IT EXISTS
--   Before this file, four pipelines bought the same boards with no shared
--   memory: capture game lines and alternate ladders had no floor and no
--   breaker, overlapping schedules re-bought the same board minutes apart,
--   and a 429 did not stop the next sport from being requested. The quota is
--   a major operating expense; this ledger spends it only where a request
--   creates new information.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Only the service role may acquire, settle or reset (security definer
--      functions; the tables are not exposed to anon or authenticated).
--   2. The request ledger is append-only: a row is written IN_FLIGHT (or
--      DENIED), settled exactly once, and never deleted.
--   3. A stale IN_FLIGHT row (the caller died) is closed as ABANDONED and its
--      estimate still counts against the budget (spend is never under-counted).
--   4. FAIL-OPEN BY DESIGN AT THE CALLER: when this file is not applied the
--      callers keep their in-run guards (floor, per-run cap, stop on 429) and
--      report "quota ledger not installed". Applying it only ever tightens.
--
-- ROLLBACK: supabase/odds_quota_rollback.sql drops exactly what this file
-- creates (the callers fall back to their in-run guards).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

create table if not exists public.odds_quota_config (
  id                    int primary key default 1 check (id = 1),
  mode                  text not null default 'LIVE' check (mode in ('LIVE', 'RESEARCH_ONLY')),
  daily_limit           int not null default 2500 check (daily_limit >= 0),
  monthly_limit         int not null default 60000 check (monthly_limit >= 0),
  reserve_credits       int not null default 500 check (reserve_credits >= 0),
  min_remaining         int not null default 1000 check (min_remaining >= 0),
  critical_min_remaining int not null default 100 check (critical_min_remaining >= 0),
  breaker_failures      int not null default 3 check (breaker_failures >= 1),
  breaker_cooldown_s    int not null default 1800 check (breaker_cooldown_s >= 60),
  rate_limit_backoff_s  int not null default 900 check (rate_limit_backoff_s >= 60),
  auth_backoff_s        int not null default 21600 check (auth_backoff_s >= 60),
  max_backoff_s         int not null default 21600 check (max_backoff_s >= 60),
  inflight_ttl_s        int not null default 300 check (inflight_ttl_s >= 30),
  /* minimum seconds between successful refreshes of one key; the longest
     matching prefix wins. A caller may ask for longer, never for shorter. */
  intervals             jsonb not null default '{"capture:near": 480, "capture:day": 1500, "capture:board": 10800, "capture:untiered": 900, "close": 240, "collective": 300, "props": 600, "alternates": 10800}'::jsonb,
  updated_at            timestamptz not null default now(),
  updated_by            text
);
insert into public.odds_quota_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.odds_quota_state (
  id                     int primary key default 1 check (id = 1),
  breaker                text not null default 'CLOSED' check (breaker in ('CLOSED', 'OPEN', 'HALF_OPEN')),
  breaker_reason         text,
  open_until             timestamptz,
  consecutive_failures   int not null default 0,
  provider_remaining     int,
  provider_used          int,
  provider_reported_at   timestamptz,
  quota_exhausted_until  timestamptz,
  updated_at             timestamptz not null default now()
);
insert into public.odds_quota_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.odds_quota_requests (
  request_id   uuid primary key default gen_random_uuid(),
  caller       text not null check (length(caller) between 1 and 64),
  request_key  text not null check (length(request_key) between 1 and 200),
  sport        text,
  endpoint     text,
  priority     text not null default 'normal' check (priority in ('critical', 'normal', 'low')),
  est_cost     int not null default 0 check (est_cost >= 0),
  status       text not null default 'IN_FLIGHT' check (status in ('IN_FLIGHT', 'DENIED', 'OK', 'PARTIAL', 'FAILED', 'RATE_LIMITED',
                 'QUOTA_EXHAUSTED', 'AUTH_FAILED', 'TIMEOUT', 'ABANDONED', 'SKIPPED')),
  reason       text,
  acquired_at  timestamptz not null default now(),
  settled_at   timestamptz,
  cost         int check (cost is null or cost >= 0),
  remaining    int,
  used         int,
  http_status  int,
  detail       text
);
create index if not exists odds_quota_requests_key_idx on public.odds_quota_requests (request_key, acquired_at desc);
create index if not exists odds_quota_requests_acquired_idx on public.odds_quota_requests (acquired_at desc);
create index if not exists odds_quota_requests_inflight_idx on public.odds_quota_requests (request_key) where status = 'IN_FLIGHT';

-- append-only: settle once (IN_FLIGHT -> final), never edit a settled row, never delete
create or replace function public.odds_quota_requests_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'odds_quota_requests is append-only: rows are never deleted'; end if;
  if tg_op = 'TRUNCATE' then raise exception 'odds_quota_requests is append-only: never truncated'; end if;
  if old.status <> 'IN_FLIGHT' then raise exception 'odds_quota_requests row % is settled (%): it is never edited', old.request_id, old.status; end if;
  if new.request_id <> old.request_id or new.caller <> old.caller or new.request_key <> old.request_key or new.est_cost <> old.est_cost
     or new.acquired_at <> old.acquired_at or new.priority <> old.priority then
    raise exception 'odds_quota_requests: only the settlement columns may change';
  end if;
  if new.status = 'IN_FLIGHT' then raise exception 'odds_quota_requests: a settlement must name a final status'; end if;
  if new.settled_at is null then new.settled_at := now(); end if;
  return new;
end $$;
drop trigger if exists odds_quota_requests_guard_trg on public.odds_quota_requests;
create trigger odds_quota_requests_guard_trg before update or delete on public.odds_quota_requests
  for each row execute function public.odds_quota_requests_guard();
drop trigger if exists odds_quota_requests_truncate_trg on public.odds_quota_requests;
create trigger odds_quota_requests_truncate_trg before truncate on public.odds_quota_requests
  for each statement execute function public.odds_quota_requests_guard();

alter table public.odds_quota_config enable row level security;
alter table public.odds_quota_state enable row level security;
alter table public.odds_quota_requests enable row level security;
revoke all on public.odds_quota_config, public.odds_quota_state, public.odds_quota_requests from anon, authenticated;

-- the minimum interval for a key: the longest configured prefix that matches
create or replace function public.odds_quota_interval(p_key text, p_intervals jsonb) returns int
language sql immutable as $$
  select coalesce((select (value)::int from jsonb_each_text(coalesce(p_intervals, '{}'::jsonb))
                   where p_key = key or p_key like key || ':%' order by length(key) desc limit 1), 0)
$$;

-- ---------------------------------------------------------------- ACQUIRE
create or replace function public.odds_quota_acquire(
  p_caller text, p_key text, p_est_cost int default 0, p_priority text default 'normal',
  p_sport text default null, p_endpoint text default null, p_min_interval_s int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg public.odds_quota_config;
  st  public.odds_quota_state;
  v_est int := greatest(coalesce(p_est_cost, 0), 0);
  v_pri text := case when p_priority in ('critical', 'normal', 'low') then p_priority else 'normal' end;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_spent_day int; v_spent_month int; v_interval int; v_last timestamptz; v_inflight record;
  v_reason text := null; v_retry timestamptz := null; v_id uuid; v_floor int; v_allow_day int; v_allow_month int;
begin
  perform pg_advisory_xact_lock(hashtext('edgedesk_odds_quota'));
  select * into cfg from public.odds_quota_config where id = 1;
  if not found then insert into public.odds_quota_config (id) values (1) returning * into cfg; end if;
  select * into st from public.odds_quota_state where id = 1 for update;
  if not found then insert into public.odds_quota_state (id) values (1) returning * into st; end if;

  -- an exhaustion hold that has run out: the reported zero balance is stale
  -- (the quota renewed), so it is forgotten until the provider reports again
  if st.quota_exhausted_until is not null and st.quota_exhausted_until <= now() then
    update public.odds_quota_state set quota_exhausted_until = null, provider_remaining = null, breaker = 'CLOSED', breaker_reason = null,
      open_until = null, consecutive_failures = 0, updated_at = now() where id = 1 returning * into st;
  end if;

  -- a caller that died never holds a key forever; its estimate still counts
  update public.odds_quota_requests set status = 'ABANDONED', reason = 'in flight past ' || cfg.inflight_ttl_s || ' s', settled_at = now()
   where status = 'IN_FLIGHT' and acquired_at < now() - make_interval(secs => cfg.inflight_ttl_s);

  select coalesce(sum(coalesce(cost, est_cost)), 0) into v_spent_day from public.odds_quota_requests
   where acquired_at >= v_day_start and status not in ('DENIED', 'SKIPPED');
  select coalesce(sum(coalesce(cost, est_cost)), 0) into v_spent_month from public.odds_quota_requests
   where acquired_at >= v_month_start and status not in ('DENIED', 'SKIPPED');
  v_allow_day := cfg.daily_limit - case when v_pri = 'critical' then 0 else cfg.reserve_credits end;
  v_allow_month := cfg.monthly_limit - case when v_pri = 'critical' then 0 else cfg.reserve_credits end;
  v_floor := case when v_pri = 'critical' then cfg.critical_min_remaining else cfg.min_remaining end;
  v_interval := greatest(coalesce(p_min_interval_s, 0), public.odds_quota_interval(p_key, cfg.intervals));

  if cfg.mode = 'RESEARCH_ONLY' then
    v_reason := 'research_only';
  elsif st.quota_exhausted_until is not null and st.quota_exhausted_until > now() then
    v_reason := 'quota_exhausted'; v_retry := st.quota_exhausted_until;
  elsif st.breaker = 'OPEN' and st.open_until is not null and st.open_until > now() then
    v_reason := 'circuit_open'; v_retry := st.open_until;
  end if;

  if v_reason is null and st.breaker in ('OPEN', 'HALF_OPEN') then
    -- the cool-down has passed: HALF_OPEN lets exactly one probe through (a
    -- request still in flight from before the breaker changed does not count)
    if exists (select 1 from public.odds_quota_requests where status = 'IN_FLIGHT' and acquired_at >= st.updated_at) then
      v_reason := 'circuit_half_open_probe_in_flight';
    else
      update public.odds_quota_state set breaker = 'HALF_OPEN', updated_at = now() where id = 1;
    end if;
  end if;

  if v_reason is null then
    select request_id, acquired_at, caller into v_inflight from public.odds_quota_requests
     where request_key = p_key and status = 'IN_FLIGHT' order by acquired_at desc limit 1;
    if found then v_reason := 'coalesced'; v_retry := v_inflight.acquired_at + make_interval(secs => cfg.inflight_ttl_s); end if;
  end if;

  if v_reason is null and v_interval > 0 then
    select max(coalesce(settled_at, acquired_at)) into v_last from public.odds_quota_requests
     where request_key = p_key and status in ('OK', 'PARTIAL');
    if v_last is not null and v_last > now() - make_interval(secs => v_interval) then
      v_reason := 'cache_fresh'; v_retry := v_last + make_interval(secs => v_interval);
    end if;
  end if;

  if v_reason is null and v_spent_day + v_est > v_allow_day then
    v_reason := case when v_pri <> 'critical' and v_spent_day + v_est <= cfg.daily_limit then 'reserve_held' else 'daily_budget' end;
    v_retry := v_day_start + interval '1 day';
  end if;
  if v_reason is null and v_spent_month + v_est > v_allow_month then
    v_reason := case when v_pri <> 'critical' and v_spent_month + v_est <= cfg.monthly_limit then 'reserve_held' else 'monthly_budget' end;
    v_retry := v_month_start + interval '1 month';
  end if;
  if v_reason is null and st.provider_remaining is not null and st.provider_remaining - v_est < v_floor then
    v_reason := 'quota_floor';
  end if;

  insert into public.odds_quota_requests (caller, request_key, sport, endpoint, priority, est_cost, status, reason, settled_at)
  values (left(coalesce(p_caller, 'unknown'), 64), left(p_key, 200), p_sport, p_endpoint, v_pri, v_est,
          case when v_reason is null then 'IN_FLIGHT' else 'DENIED' end, v_reason, case when v_reason is null then null else now() end)
  returning request_id into v_id;

  return jsonb_build_object(
    'allowed', v_reason is null, 'reason', coalesce(v_reason, 'allowed'), 'request_id', case when v_reason is null then v_id else null end,
    'retry_after', v_retry, 'mode', cfg.mode, 'priority', v_pri, 'min_interval_s', v_interval,
    'budget', jsonb_build_object('spent_today', v_spent_day, 'daily_limit', cfg.daily_limit, 'spent_month', v_spent_month,
      'monthly_limit', cfg.monthly_limit, 'reserve', cfg.reserve_credits, 'provider_remaining', st.provider_remaining, 'floor', v_floor),
    'breaker', st.breaker);
end $$;

-- ----------------------------------------------------------------- SETTLE
create or replace function public.odds_quota_settle(
  p_request_id uuid, p_status text, p_cost int default null, p_remaining int default null, p_used int default null,
  p_http int default null, p_detail text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg public.odds_quota_config;
  st  public.odds_quota_state;
  v_status text := upper(coalesce(p_status, 'FAILED'));
  v_back int; v_row public.odds_quota_requests;
begin
  if v_status not in ('OK', 'PARTIAL', 'FAILED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_FAILED', 'TIMEOUT', 'SKIPPED') then
    raise exception 'odds_quota_settle: unknown status %', p_status;
  end if;
  perform pg_advisory_xact_lock(hashtext('edgedesk_odds_quota'));
  select * into cfg from public.odds_quota_config where id = 1;
  select * into st from public.odds_quota_state where id = 1 for update;
  select * into v_row from public.odds_quota_requests where request_id = p_request_id;
  if not found then return jsonb_build_object('settled', false, 'reason', 'unknown request'); end if;
  if v_row.status <> 'IN_FLIGHT' then return jsonb_build_object('settled', false, 'reason', 'already ' || v_row.status); end if;
  -- a provider that reports a zero balance is exhausted whatever the HTTP status said
  if p_remaining is not null and p_remaining <= 0 and v_status in ('OK', 'PARTIAL', 'FAILED') then v_status := 'QUOTA_EXHAUSTED'; end if;

  update public.odds_quota_requests set status = v_status, settled_at = now(), cost = greatest(coalesce(p_cost, est_cost), 0),
    remaining = p_remaining, used = p_used, http_status = p_http, detail = left(p_detail, 500)
   where request_id = p_request_id;

  if p_remaining is not null then
    update public.odds_quota_state set provider_remaining = p_remaining, provider_used = coalesce(p_used, provider_used),
      provider_reported_at = now() where id = 1;
  end if;

  if v_status in ('OK', 'PARTIAL', 'SKIPPED') then
    update public.odds_quota_state set breaker = 'CLOSED', breaker_reason = null, open_until = null, consecutive_failures = 0, updated_at = now() where id = 1;
  elsif v_status = 'RATE_LIMITED' then
    v_back := least(cfg.max_backoff_s, cfg.rate_limit_backoff_s * (2 ^ least(st.consecutive_failures, 8))::int);
    update public.odds_quota_state set breaker = 'OPEN', breaker_reason = 'HTTP 429 from the provider', open_until = now() + make_interval(secs => v_back),
      consecutive_failures = st.consecutive_failures + 1, updated_at = now() where id = 1;
  elsif v_status = 'QUOTA_EXHAUSTED' then
    update public.odds_quota_state set breaker = 'OPEN', breaker_reason = 'quota exhausted', open_until = null,
      quota_exhausted_until = date_trunc('month', now() at time zone 'utc') at time zone 'utc' + interval '1 month',
      consecutive_failures = st.consecutive_failures + 1, updated_at = now() where id = 1;
  elsif v_status = 'AUTH_FAILED' then
    update public.odds_quota_state set breaker = 'OPEN', breaker_reason = 'HTTP 401: the API key was refused', open_until = now() + make_interval(secs => cfg.auth_backoff_s),
      consecutive_failures = st.consecutive_failures + 1, updated_at = now() where id = 1;
  else
    update public.odds_quota_state set consecutive_failures = st.consecutive_failures + 1, updated_at = now(),
      breaker = case when st.consecutive_failures + 1 >= cfg.breaker_failures or st.breaker = 'HALF_OPEN' then 'OPEN' else st.breaker end,
      breaker_reason = case when st.consecutive_failures + 1 >= cfg.breaker_failures or st.breaker = 'HALF_OPEN' then (st.consecutive_failures + 1) || ' consecutive failures (' || v_status || ')' else st.breaker_reason end,
      open_until = case when st.consecutive_failures + 1 >= cfg.breaker_failures or st.breaker = 'HALF_OPEN' then now() + make_interval(secs => cfg.breaker_cooldown_s) else st.open_until end
     where id = 1;
  end if;
  select * into st from public.odds_quota_state where id = 1;
  return jsonb_build_object('settled', true, 'status', v_status, 'breaker', st.breaker, 'open_until', st.open_until,
    'quota_exhausted_until', st.quota_exhausted_until, 'provider_remaining', st.provider_remaining);
end $$;

-- ----------------------------------------------------------------- STATUS
create or replace function public.odds_quota_status() returns jsonb
language sql security definer set search_path = public as $$
  with c as (select * from public.odds_quota_config where id = 1), s as (select * from public.odds_quota_state where id = 1),
  d as (select coalesce(sum(coalesce(cost, est_cost)) filter (where status not in ('DENIED', 'SKIPPED')), 0) as spent,
               count(*) filter (where status = 'DENIED') as denied
          from public.odds_quota_requests where acquired_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
  m as (select coalesce(sum(coalesce(cost, est_cost)) filter (where status not in ('DENIED', 'SKIPPED')), 0) as spent
          from public.odds_quota_requests where acquired_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'),
  r as (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) as by_reason from (
          select reason, count(*) as n from public.odds_quota_requests where status = 'DENIED' and acquired_at > now() - interval '24 hours' group by reason) x)
  select jsonb_build_object(
    'mode', c.mode,
    'status', case when c.mode = 'RESEARCH_ONLY' then 'DISABLED'
                   when s.quota_exhausted_until > now() then 'QUOTA_EXHAUSTED'
                   when s.breaker = 'OPEN' and s.open_until > now() and s.breaker_reason like 'HTTP 429%' then 'RATE_LIMITED'
                   when s.breaker = 'OPEN' and s.open_until > now() then 'OUTAGE'
                   when d.spent >= c.daily_limit or m.spent >= c.monthly_limit then 'BUDGET_HOLD'
                   else 'OK' end,
    'breaker', s.breaker, 'breaker_reason', s.breaker_reason, 'open_until', s.open_until, 'consecutive_failures', s.consecutive_failures,
    'quota_exhausted_until', s.quota_exhausted_until, 'provider_remaining', s.provider_remaining, 'provider_used', s.provider_used,
    'provider_reported_at', s.provider_reported_at, 'spent_today', d.spent, 'daily_limit', c.daily_limit, 'spent_month', m.spent,
    'monthly_limit', c.monthly_limit, 'reserve', c.reserve_credits, 'min_remaining', c.min_remaining,
    'denied_today', d.denied, 'denied_24h_by_reason', r.by_reason, 'checked_at', now())
  from c, s, d, m, r
$$;

-- ------------------------------------------------------------------ RESET
-- the owner clears a breaker or an exhaustion hold after fixing its cause
create or replace function public.odds_quota_reset(p_what text default 'breaker', p_by text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_what not in ('breaker', 'exhaustion', 'all') then raise exception 'odds_quota_reset: breaker | exhaustion | all'; end if;
  perform pg_advisory_xact_lock(hashtext('edgedesk_odds_quota'));
  update public.odds_quota_state set
    breaker = case when p_what in ('breaker', 'all') then 'CLOSED' else breaker end,
    breaker_reason = case when p_what in ('breaker', 'all') then null else breaker_reason end,
    open_until = case when p_what in ('breaker', 'all') then null else open_until end,
    consecutive_failures = case when p_what in ('breaker', 'all') then 0 else consecutive_failures end,
    quota_exhausted_until = case when p_what in ('exhaustion', 'all') then null else quota_exhausted_until end,
    provider_remaining = case when p_what in ('exhaustion', 'all') then null else provider_remaining end,
    updated_at = now() where id = 1;
  update public.odds_quota_config set updated_at = now(), updated_by = coalesce(p_by, updated_by) where id = 1;
  return public.odds_quota_status();
end $$;

revoke all on function public.odds_quota_acquire(text, text, int, text, text, text, int) from public, anon, authenticated;
revoke all on function public.odds_quota_settle(uuid, text, int, int, int, int, text) from public, anon, authenticated;
revoke all on function public.odds_quota_status() from public, anon, authenticated;
revoke all on function public.odds_quota_reset(text, text) from public, anon, authenticated;
grant execute on function public.odds_quota_acquire(text, text, int, text, text, text, int) to service_role;
grant execute on function public.odds_quota_settle(uuid, text, int, int, int, int, text) to service_role;
grant execute on function public.odds_quota_status() to service_role;
grant execute on function public.odds_quota_reset(text, text) to service_role;

-- what the ledger saved: denials by reason per day (owner reporting)
create or replace view public.odds_quota_daily as
select date_trunc('day', acquired_at at time zone 'utc')::date as day, caller,
       count(*) filter (where status <> 'DENIED') as requests,
       count(*) filter (where status = 'DENIED') as denied,
       coalesce(sum(coalesce(cost, est_cost)) filter (where status not in ('DENIED', 'SKIPPED')), 0) as credits,
       coalesce(sum(est_cost) filter (where status = 'DENIED'), 0) as credits_not_spent,
       count(*) filter (where status in ('RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_FAILED', 'TIMEOUT', 'FAILED')) as failures
  from public.odds_quota_requests group by 1, 2;
revoke all on public.odds_quota_daily from anon, authenticated;
grant select on public.odds_quota_daily to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'odds_quota_config row' as piece, case when exists (select 1 from public.odds_quota_config where id = 1) then 'ok' else 'CHECK THIS' end as state
union all
select 'odds_quota_state row', case when exists (select 1 from public.odds_quota_state where id = 1) then 'ok' else 'CHECK THIS' end
union all
select 'request ledger', case when to_regclass('public.odds_quota_requests') is not null then 'ok' else 'CHECK THIS' end
union all
select 'append-only trigger', case when exists (select 1 from pg_trigger where tgname = 'odds_quota_requests_guard_trg') then 'ok' else 'CHECK THIS' end
union all
select 'no-truncate trigger', case when exists (select 1 from pg_trigger where tgname = 'odds_quota_requests_truncate_trg') then 'ok' else 'CHECK THIS' end
union all
select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.odds_quota_requests'::regclass) then 'ok' else 'CHECK THIS' end
union all
select 'acquire function', case when to_regprocedure('public.odds_quota_acquire(text,text,int,text,text,text,int)') is not null then 'ok' else 'CHECK THIS' end
union all
select 'settle function', case when to_regprocedure('public.odds_quota_settle(uuid,text,int,int,int,int,text)') is not null then 'ok' else 'CHECK THIS' end
union all
select 'status function', case when to_regprocedure('public.odds_quota_status()') is not null then 'ok' else 'CHECK THIS' end
union all
select 'daily view', case when to_regclass('public.odds_quota_daily') is not null then 'ok' else 'CHECK THIS' end;
