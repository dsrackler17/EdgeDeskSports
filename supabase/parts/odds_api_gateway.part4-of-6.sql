-- odds_api_gateway -- part 4 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ── 7. SETTLE: reconcile against the provider's own headers ────────────────
-- p: { request_id, ok, http_status, requests_used, requests_remaining,
--      requests_last, duration_ms, error, body, quota_exhausted }
create or replace function public.odds_api_settle(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.odds_api_config;
  r public.odds_api_requests;
  v_now timestamptz;
  v_id bigint;
  v_ok boolean;
  v_http integer; v_last integer; v_used integer; v_rem integer; v_dur integer;
  v_err text := nullif(p->>'error', '');
  v_body jsonb := p->'body';
  v_quota boolean;
  v_actual integer; v_cycle date; v_events integer; v_markets integer; v_books integer;
  v_ledger bigint; v_untracked integer; st jsonb; v_pct numeric;
begin
  begin
    v_id := nullif(p->>'request_id', '')::bigint;
    v_ok := coalesce((p->>'ok')::boolean, false);
    v_http := nullif(p->>'http_status', '')::int;
    v_last := nullif(p->>'requests_last', '')::int;
    v_used := nullif(p->>'requests_used', '')::int;
    v_rem := nullif(p->>'requests_remaining', '')::int;
    v_dur := nullif(p->>'duration_ms', '')::int;
    v_quota := coalesce((p->>'quota_exhausted')::boolean, false);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'malformed settle payload');
  end;

  select * into c from public.odds_api_config where id = 1 for update;
  v_now := clock_timestamp();
  select * into r from public.odds_api_requests where id = v_id for update;
  if not found or r.status not in ('reserved', 'expired') then
    return jsonb_build_object('ok', false, 'reason', 'not a settleable lease');
  end if;

  -- NEVER A CREDENTIAL IN THE LEDGER, whatever an upstream error echoed.
  v_err := regexp_replace(coalesce(v_err, ''), '(api_?key)=[^&[:space:]"'']*', '\1=REDACTED', 'gi');
  -- What the provider says it charged; without the header, the reservation.
  v_actual := case when v_last is not null then greatest(v_last, 0) else r.reserved_credits end;
  update public.odds_api_requests set
    status = case when v_ok then 'settled' else 'failed' end,
    actual_credits = v_actual, cost_is_exact = v_last is not null,
    http_status = v_http, requests_used = v_used, requests_remaining = v_rem, requests_last = v_last,
    duration_ms = v_dur, error = nullif(left(v_err, 400), ''), settled_at = v_now
  where id = v_id;

  v_cycle := public.odds_api_cycle_start(v_now);
  if v_used is not null and v_rem is not null and (c.provider_observed_at is null
       or c.provider_observed_at < (v_cycle::timestamp at time zone 'utc')
       or v_used >= coalesce(c.provider_requests_used, 0)) then
    update public.odds_api_config set provider_requests_used = v_used, provider_requests_remaining = v_rem,
           provider_observed_at = v_now, provider_observed_source = left('header: ' || r.caller, 120)
     where id = 1;
    -- USAGE THE GATEWAY DID NOT SEE: the provider counting more than the
    -- ledger, beyond the cycle's baseline, means something else holds the key.
    select coalesce(sum(coalesce(actual_credits, reserved_credits)), 0) into v_ledger
      from public.odds_api_requests where dispatched and cycle_start = v_cycle;
    if c.untracked_baseline_cycle is distinct from v_cycle then
      update public.odds_api_config set untracked_baseline = v_used - v_ledger, untracked_baseline_cycle = v_cycle where id = 1;
    else
      v_untracked := (v_used - v_ledger) - coalesce(c.untracked_baseline, 0);
      if v_untracked > greatest(25, ceil(0.02 * greatest(v_used, 1))) then
        perform public.odds_api_alert('critical', 'untracked_provider_usage',
          format('The provider counts %s more credits this cycle than the gateway ledger: something is spending the key outside odds_gateway.', v_untracked),
          jsonb_build_object('provider_used', v_used, 'ledger', v_ledger, 'baseline', c.untracked_baseline));
      end if;
    end if;
  end if;

  if v_ok then
    update public.odds_api_config set consecutive_failures = 0 where id = 1;
  else
    update public.odds_api_config set consecutive_failures = consecutive_failures + 1 where id = 1;
    if v_http = 401 then
      perform public.odds_api_trip('auto: the provider rejected the key (401)', 'odds_api_settle');
    elsif v_http = 429 and (v_quota or coalesce(v_rem, 1) <= 0) then
      perform public.odds_api_trip('auto: provider quota exhausted (429)', 'odds_api_settle');
    elsif v_http = 429 then
      update public.odds_api_config set provider_cooldown_until = v_now + interval '5 minutes',
             cooldown_reason = 'provider rate limit (429)' where id = 1;
      perform public.odds_api_alert('warning', 'provider_rate_limited', 'The provider answered 429; paid calls cool down for 5 minutes.', null);
    elsif c.consecutive_failures + 1 >= 5 then
      update public.odds_api_config set provider_cooldown_until = v_now + interval '15 minutes',
             cooldown_reason = 'five consecutive provider failures' where id = 1;
      perform public.odds_api_alert('warning', 'provider_failing', 'Five consecutive provider failures; paid calls cool down for 15 minutes.', null);
    end if;
  end if;
  if v_rem is not null and v_rem <= 0 then
    perform public.odds_api_trip('auto: the provider reports zero credits remaining', 'odds_api_settle');
  end if;

  if v_ok and v_body is not null and jsonb_typeof(v_body) in ('array', 'object') then
    begin
      if jsonb_typeof(v_body) = 'array' then
        v_events := jsonb_array_length(v_body);
        select count(distinct m->>'key'), count(distinct b->>'key') into v_markets, v_books
          from jsonb_array_elements(v_body) e, jsonb_array_elements(coalesce(e->'bookmakers', '[]'::jsonb)) b,
               jsonb_array_elements(coalesce(b->'markets', '[]'::jsonb)) m;
      else
        v_events := 1;
        select count(distinct m->>'key'), count(distinct b->>'key') into v_markets, v_books
          from jsonb_array_elements(coalesce(v_body->'bookmakers', '[]'::jsonb)) b,
               jsonb_array_elements(coalesce(b->'markets', '[]'::jsonb)) m;
      end if;
    exception when others then v_markets := null; v_books := null;
    end;
    insert into public.odds_api_snapshots (fingerprint, category, sport_key, event_id, endpoint, markets, selection,
      odds_format, last_request_id, last_attempt_at, last_status, last_http_status, last_success_at, body,
      events_count, markets_returned, bookmakers_returned, cost_last, updated_at)
    values (r.fingerprint, r.category, r.sport_key, r.event_id, r.endpoint, r.markets, r.selection, r.odds_format,
      r.id, v_now, 'ok', v_http, v_now, case when c.store_snapshot_bodies then v_body end,
      v_events, v_markets, v_books, v_actual, v_now)
    on conflict (fingerprint) do update set
      category = excluded.category, last_request_id = excluded.last_request_id, last_attempt_at = excluded.last_attempt_at,
      last_status = 'ok', last_http_status = excluded.last_http_status, last_success_at = excluded.last_success_at,
      body = excluded.body, events_count = excluded.events_count, markets_returned = excluded.markets_returned,
      bookmakers_returned = excluded.bookmakers_returned, cost_last = excluded.cost_last, updated_at = excluded.updated_at;
    begin
      if r.endpoint in ('odds', 'events') and jsonb_typeof(v_body) = 'array' then
        insert into public.odds_api_events (event_id, sport_key, commence_time, home_team, away_team, last_seen_at)
        -- the REQUESTED sport, never the body's own label: the clock of a sport
        -- must not be fed by a response that says it is about another one
        select distinct on (e->>'id') e->>'id', r.sport_key, (e->>'commence_time')::timestamptz,
               e->>'home_team', e->>'away_team', v_now
          from jsonb_array_elements(v_body) e
         where coalesce(e->>'id', '') <> '' and coalesce(e->>'commence_time', '') <> ''
        on conflict (event_id) do update set commence_time = excluded.commence_time, home_team = excluded.home_team,
          away_team = excluded.away_team, last_seen_at = excluded.last_seen_at;
      elsif r.endpoint = 'event_odds' and jsonb_typeof(v_body) = 'object' and coalesce(v_body->>'commence_time', '') <> '' then
        insert into public.odds_api_events (event_id, sport_key, commence_time, home_team, away_team, last_seen_at)
        values (r.event_id, r.sport_key,
                (v_body->>'commence_time')::timestamptz, v_body->>'home_team', v_body->>'away_team', v_now)
        on conflict (event_id) do update set commence_time = excluded.commence_time, last_seen_at = excluded.last_seen_at;
      end if;
    exception when others then null;   -- a malformed commence time costs the clock, never the settle
    end;
  else
    insert into public.odds_api_snapshots (fingerprint, category, sport_key, event_id, endpoint, markets, selection,
      odds_format, last_request_id, last_attempt_at, last_status, last_http_status, updated_at)
    values (r.fingerprint, r.category, r.sport_key, r.event_id, r.endpoint, r.markets, r.selection, r.odds_format,
      r.id, v_now, 'failed', v_http, v_now)
    on conflict (fingerprint) do update set last_attempt_at = excluded.last_attempt_at, last_status = 'failed',
      last_http_status = excluded.last_http_status, updated_at = excluded.updated_at;
  end if;

  st := public.odds_api_budget_state(v_now);
  if c.monthly_budget > 0 then
    v_pct := (st->>'spent_cycle')::numeric / c.monthly_budget;
    if v_pct >= c.critical_pct then
      perform public.odds_api_alert('critical', 'monthly_critical', format('%s%% of the monthly operational budget is used.', round(v_pct * 100)), st);
    elsif v_pct >= c.warning_pct then
      perform public.odds_api_alert('warning', 'monthly_warning', format('%s%% of the monthly operational budget is used.', round(v_pct * 100)), st);
    end if;
    if nullif(st->>'projected_cycle', '')::numeric > c.monthly_budget then
      perform public.odds_api_alert('warning', 'pace_over_budget', 'At the current pace this cycle will exceed its operational budget.', st);
    end if;
  end if;
  if coalesce((st->>'daily_allowance')::int, 0) > 0 and (st->>'spent_today')::bigint > (st->>'daily_allowance')::int then
    perform public.odds_api_alert('warning', 'daily_allowance_exceeded', 'Today''s spend is above today''s allowance; optional polling is being shed.', st);
  end if;

  return jsonb_build_object('ok', true, 'request_id', v_id, 'actual_credits', v_actual, 'cost_is_exact', v_last is not null,
    'provider_remaining', v_rem);
end $$;

create or replace function public.odds_api_snapshot(p_fingerprint text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('fingerprint', s.fingerprint, 'request_id', s.last_request_id, 'fetched_at', s.last_success_at,
           'age_seconds', round(extract(epoch from (now() - s.last_success_at))), 'body', s.body,
           'events_count', s.events_count, 'markets_returned', s.markets_returned, 'cost_last', s.cost_last)
    from public.odds_api_snapshots s where s.fingerprint = p_fingerprint and s.last_success_at is not null
$$;

-- ONE FETCH, EVERY CONSUMER, EACH ONCE. capture, close, the GitHub prop
-- capture and collective_odds_ingest share snapshots; each records the last
-- snapshot it processed, so a fetch bought by one is processed by the others
-- exactly once (a cache hit carrying data a consumer has not seen yet is NEW
-- for that consumer) and never twice.
create table if not exists public.odds_api_consumer_marks (
  consumer    text not null,
  fingerprint text not null,
  request_id  bigint not null,
  consumed_at timestamptz not null default now(),
  primary key (consumer, fingerprint)
);
alter table public.odds_api_consumer_marks enable row level security;
revoke all on public.odds_api_consumer_marks from anon, authenticated;

create or replace function public.odds_api_consume(p_consumer text, p_fingerprint text, p_request_id bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if p_consumer is null or p_fingerprint is null or p_request_id is null then return false; end if;
  insert into public.odds_api_consumer_marks (consumer, fingerprint, request_id, consumed_at)
  values (left(p_consumer, 80), p_fingerprint, p_request_id, now())
  on conflict (consumer, fingerprint) do update set request_id = excluded.request_id, consumed_at = excluded.consumed_at
   where public.odds_api_consumer_marks.request_id < excluded.request_id
  returning true into v;
  return coalesce(v, false);
end $$;

-- ── 8. OPERATOR CONTROLS (service role / SQL editor) ───────────────────────
create or replace function public.odds_api_set_budget(p_monthly integer, p_reserve integer, p_daily integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config;
begin
  select * into c from public.odds_api_config where id = 1 for update;
  if p_monthly is null or p_reserve is null or p_daily is null or p_monthly < 0 or p_reserve < 0 or p_daily < 0 then
    return jsonb_build_object('ok', false, 'reason', 'budget values must be non-negative integers');
  end if;
  if p_monthly + p_reserve > c.plan_monthly_credits then
    return jsonb_build_object('ok', false, 'reason', format('budget %s + reserve %s exceeds the plan''s %s credits', p_monthly, p_reserve, c.plan_monthly_credits));
  end if;
  update public.odds_api_config set monthly_budget = p_monthly, monthly_reserve = p_reserve, daily_target = p_daily, updated_at = now() where id = 1;
  perform public.odds_api_alert('info', 'budget_changed', format('Budget set: monthly %s, reserve %s, daily %s.', p_monthly, p_reserve, p_daily), null);
  return jsonb_build_object('ok', true, 'monthly_budget', p_monthly, 'monthly_reserve', p_reserve, 'daily_target', p_daily);
end $$;

-- The post-recovery targets: 60,000 operational, 40,000 reserve, 1,500/day.
create or replace function public.odds_api_apply_recovery_budget()
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.odds_api_set_budget(60000, 40000, 1500)
$$;

-- Turning the breaker ON is refused without a budget. It does not by itself
-- spend anything: paid calls still wait for a provider-confirmed quota.
create or replace function public.odds_api_set_enabled(p_enabled boolean, p_reason text, p_by text default 'operator')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; st jsonb;
begin
  select * into c from public.odds_api_config where id = 1 for update;
  if p_enabled and (c.monthly_budget <= 0 or c.daily_target <= 0) then
    return jsonb_build_object('ok', false, 'reason', 'set a budget first: select public.odds_api_apply_recovery_budget();');
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'a reason is required');
  end if;
  update public.odds_api_config set odds_api_enabled = p_enabled, breaker_reason = left(p_reason, 300),
         breaker_changed_at = now(), breaker_changed_by = left(coalesce(p_by, 'operator'), 120),
         provider_cooldown_until = case when p_enabled then null else provider_cooldown_until end,
         consecutive_failures = case when p_enabled then 0 else consecutive_failures end, updated_at = now()
   where id = 1;
  perform public.odds_api_alert(case when p_enabled then 'info' else 'warning' end, 'breaker_' || case when p_enabled then 'on' else 'off' end,
    format('Breaker turned %s by %s: %s', case when p_enabled then 'ON' else 'OFF' end, coalesce(p_by, 'operator'), p_reason), null);
  st := public.odds_api_budget_state(now());
  return jsonb_build_object('ok', true, 'enabled', p_enabled, 'quota_confirmed', st->'quota_confirmed',
    'note', case when p_enabled and not coalesce((st->>'quota_confirmed')::boolean, false)
                 then 'Paid calls wait until this cycle''s quota is confirmed (odds_api_confirm_quota or a free quota probe).' end);
end $$;

-- Record the account's usage as read from the provider's dashboard (or a free
-- /v4/sports header). This is what "confirmed" means for a new cycle.
create or replace function public.odds_api_confirm_quota(p_used integer, p_remaining integer, p_source text default 'operator')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_used is null or p_remaining is null or p_used < 0 or p_remaining < 0 then
    return jsonb_build_object('ok', false, 'reason', 'used and remaining must be non-negative');
  end if;
  update public.odds_api_config set provider_requests_used = p_used, provider_requests_remaining = p_remaining,
         provider_observed_at = now(), provider_observed_source = left('manual: ' || coalesce(p_source, 'operator'), 120),
         untracked_baseline = null, untracked_baseline_cycle = null, updated_at = now()
   where id = 1;
  perform public.odds_api_alert('info', 'quota_confirmed', format('Quota confirmed: %s used, %s remaining (%s).', p_used, p_remaining, coalesce(p_source, 'operator')), null);
  return jsonb_build_object('ok', true, 'used', p_used, 'remaining', p_remaining);
end $$;

create or replace function public.odds_api_set_category(p_category text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_categories set enabled = p_enabled where category = p_category;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown category'); end if;
  return jsonb_build_object('ok', true, 'category', p_category, 'enabled', p_enabled);
end $$;
