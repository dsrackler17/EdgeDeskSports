-- odds_api_gateway -- part 2 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create table if not exists public.odds_api_alerts (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  cycle_start     date,
  level           text not null,
  code            text not null,
  message         text not null,
  details         jsonb,
  acknowledged_at timestamptz,
  acknowledged_by text
);
alter table public.odds_api_alerts add column if not exists alert_day date not null default ((now() at time zone 'utc')::date);
-- One alert per code per cycle per day: a hot loop raises it once, not a thousand times.
create unique index if not exists odds_api_alerts_once_idx on public.odds_api_alerts (code, cycle_start, alert_day);
alter table public.odds_api_alerts enable row level security;
revoke all on public.odds_api_alerts from anon, authenticated;

-- One holder per job at a time: an overlapping cron run of the same job skips.
create table if not exists public.odds_api_job_locks (
  job         text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table public.odds_api_job_locks enable row level security;
revoke all on public.odds_api_job_locks from anon, authenticated;

-- ── 4. HELPERS ──────────────────────────────────────────────────────────────
create or replace function public.odds_api_cycle_start(p_at timestamptz default now())
returns date language sql stable as $$ select date_trunc('month', p_at at time zone 'utc')::date $$;

create or replace function public.odds_api_sorted(p text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct m order by m), '{}'::text[])
  from unnest(coalesce(p, '{}'::text[])) m where m is not null and m <> ''
$$;

create or replace function public.odds_api_fingerprint(p_endpoint text, p_sport text, p_event text, p_markets text[],
  p_selection text, p_format text, p_date text)
returns text language sql immutable as $$
  select md5(concat_ws('|', coalesce(p_endpoint, ''), coalesce(p_sport, ''), coalesce(p_event, ''),
    array_to_string(public.odds_api_sorted(p_markets), ','), coalesce(p_selection, ''), coalesce(p_format, ''), coalesce(p_date, '')))
$$;

create or replace function public.odds_api_day_weight(p_weights jsonb, p_day date)
returns numeric language sql immutable as $$
  select coalesce(nullif(p_weights->>(extract(dow from p_day)::int::text), '')::numeric, 1)
$$;

-- A caller holding the service role, or a direct database session (the SQL
-- editor, psql with the database URL). Never a signed-in browser.
create or replace function public.odds_api_privileged()
returns boolean language plpgsql stable as $$
declare v text;
begin
  begin v := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'; exception when others then v := null; end;
  if v = 'service_role' then return true; end if;
  return session_user not in ('authenticator', 'anon', 'authenticated');
end $$;

-- The business consoles' operator list (billing_is_admin, else the partner
-- program's), checked against the caller's own token.
create or replace function public.odds_api_is_admin()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean := false;
begin
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v; return coalesce(v, false);
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v; return coalesce(v, false);
  end if;
  return false;
exception when others then return false;
end $$;

create or replace function public.odds_api_alert(p_level text, p_code text, p_message text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.odds_api_alerts (cycle_start, level, code, message, details)
  values (public.odds_api_cycle_start(now()), p_level, p_code, left(p_message, 600), p_details)
  on conflict (code, cycle_start, alert_day) do nothing;
end $$;

-- Trip the breaker from inside the gateway: latching, so turning paid
-- retrieval back on is always a deliberate operator act.
create or replace function public.odds_api_trip(p_reason text, p_by text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_config set odds_api_enabled = false, breaker_reason = left(p_reason, 300),
         breaker_changed_at = now(), breaker_changed_by = left(p_by, 120), updated_at = now()
   where id = 1 and odds_api_enabled;
  if found then perform public.odds_api_alert('emergency', 'breaker_tripped', p_reason, jsonb_build_object('by', p_by)); end if;
end $$;

-- ── 5. THE BUDGET PICTURE ───────────────────────────────────────────────────
-- Spend this cycle is the larger of what the ledger reserved/settled and what
-- the provider's own x-requests-used says (plus leases still open), so usage
-- outside the gateway still counts. The daily allowance paces what is left of
-- the monthly budget over the days left, weighted toward football days, and
-- never above daily_target x today's weight.
create or replace function public.odds_api_budget_state(p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.odds_api_config;
  v_cycle date := public.odds_api_cycle_start(p_now);
  v_next date := (public.odds_api_cycle_start(p_now) + interval '1 month')::date;
  v_today date := (p_now at time zone 'utc')::date;
  v_cycle_ts timestamptz := (public.odds_api_cycle_start(p_now)::timestamp at time zone 'utc');
  v_next_ts timestamptz := ((public.odds_api_cycle_start(p_now) + interval '1 month')::timestamp at time zone 'utc');
  v_ledger bigint; v_today_spent bigint; v_open bigint; v_spent bigint; v_rem bigint; v_confirmed boolean;
  v_wt numeric; v_ws numeric; v_before bigint; v_allow integer; v_elapsed numeric; v_proj numeric; v_pct numeric;
begin
  select * into c from public.odds_api_config where id = 1;
  if not found then return jsonb_build_object('configured', false); end if;
  select coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where cycle_start = v_cycle), 0),
         coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where usage_day = v_today), 0),
         coalesce(sum(reserved_credits) filter (where status = 'reserved'), 0)
    into v_ledger, v_today_spent, v_open
    from public.odds_api_requests where dispatched and (cycle_start = v_cycle or status = 'reserved');
  v_confirmed := c.provider_observed_at is not null and c.provider_observed_at >= v_cycle_ts;
  if v_confirmed then
    v_spent := greatest(v_ledger, coalesce(c.provider_requests_used, 0) + v_open);
    v_rem := coalesce(c.provider_requests_remaining, 0) - v_open;
  else
    v_spent := v_ledger; v_rem := null;
  end if;
  v_before := greatest(0, v_spent - v_today_spent);
  v_wt := public.odds_api_day_weight(c.day_weights, v_today);
  select coalesce(sum(public.odds_api_day_weight(c.day_weights, d::date)), 1) into v_ws
    from generate_series(v_today::timestamp, (v_next - 1)::timestamp, interval '1 day') d;
  v_allow := floor(greatest(0, least(c.daily_target * v_wt,
               greatest(0, c.monthly_budget - v_before) * v_wt / greatest(v_ws, 0.0001))))::int;
  v_elapsed := extract(epoch from (p_now - v_cycle_ts)) / extract(epoch from (v_next_ts - v_cycle_ts));
  v_proj := case when v_elapsed >= 0.02 then round(v_spent / v_elapsed) end;
  v_pct := case when c.monthly_budget > 0 then round(v_spent::numeric / c.monthly_budget, 4) end;
  return jsonb_build_object(
    'configured', true, 'cycle_start', v_cycle, 'next_reset', v_next_ts, 'today', v_today,
    'monthly_budget', c.monthly_budget, 'monthly_reserve', c.monthly_reserve, 'daily_target', c.daily_target,
    'spent_cycle', v_spent, 'spent_cycle_ledger', v_ledger, 'spent_today', v_today_spent, 'open_reservations', v_open,
    'budget_used_pct', v_pct, 'budget_remaining', greatest(0, c.monthly_budget - v_spent),
    'quota_confirmed', v_confirmed, 'provider_used', c.provider_requests_used, 'provider_remaining', c.provider_requests_remaining,
    'provider_remaining_effective', v_rem, 'provider_observed_at', c.provider_observed_at,
    'day_weight', v_wt, 'daily_allowance', v_allow, 'projected_cycle', v_proj,
    'warning_at', floor(c.warning_pct * c.monthly_budget), 'critical_at', floor(c.critical_pct * c.monthly_budget),
    'emergency_at', floor(c.emergency_pct * c.monthly_budget),
    'threshold', case when c.monthly_budget <= 0 then 'no_budget'
                      when v_pct >= c.emergency_pct then 'emergency' when v_pct >= c.critical_pct then 'critical'
                      when v_pct >= c.warning_pct then 'warning' else 'normal' end);
end $$;

-- Shedding: 0 everything enabled · 1 optional (priority >= 4) off · 2 props off,
-- far events off · 3 only priority-1 main markets inside 24 h · 4 nothing paid.
-- The critical monthly threshold forces at least level 2 for the rest of the cycle.
create or replace function public.odds_api_shed_level(p_spent_today bigint, p_est integer, p_allowance integer,
  p_overdraft numeric, p_month_pct numeric, p_critical numeric)
returns smallint language sql immutable as $$
  select greatest(
    case when p_allowance is null or p_allowance <= 0 then 4
         when (p_spent_today + p_est)::numeric / p_allowance <= 0.60 then 0
         when (p_spent_today + p_est)::numeric / p_allowance <= 0.80 then 1
         when (p_spent_today + p_est)::numeric / p_allowance <= 1.00 then 2
         when (p_spent_today + p_est)::numeric / p_allowance <= 1 + p_overdraft then 3
         else 4 end,
    case when coalesce(p_month_pct, 1) >= p_critical then 2 else 0 end)::smallint
$$;

create or replace function public.odds_api_level_admits(p_level smallint, p_priority smallint, p_hours numeric)
returns boolean language sql immutable as $$
  select case p_level
    when 0 then true
    when 1 then p_priority <= 3
    when 2 then (p_priority <= 1 and coalesce(p_hours, 1e9) <= 72) or (p_priority = 2 and coalesce(p_hours, 1e9) <= 24)
    when 3 then p_priority <= 1 and coalesce(p_hours, 1e9) <= 24
    else false end
$$;

-- Under pressure the cadence stretches before anything is refused outright.
create or replace function public.odds_api_level_stretch(p_level smallint)
returns numeric language sql immutable as $$
  select (case p_level when 0 then 1 when 1 then 1.5 when 2 then 2 when 3 then 3 else 4 end)::numeric
$$;

create or replace function public.odds_api_interval(p_category text, p_group text, p_hours numeric)
returns jsonb language sql stable as $$
  with r as (
    select sport_group, max_hours_to_start, interval_minutes from public.odds_api_cadence
     where category = p_category and sport_group in (p_group, '*')
  ), g as (
    select case when exists (select 1 from r where sport_group = p_group) then p_group else '*' end as grp
  )
  select coalesce((
    select jsonb_build_object('found', true, 'interval', r.interval_minutes, 'bucket', r.max_hours_to_start)
      from r, g where r.sport_group = g.grp and coalesce(p_hours, 999999) <= r.max_hours_to_start
     order by r.max_hours_to_start limit 1), jsonb_build_object('found', false))
$$;
