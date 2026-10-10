-- odds_api_gateway -- part 3 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ── 6. ACQUIRE: the one door before any provider request ───────────────────
-- p: { caller, trigger, category, sport_key, event_id, odds_format,
--      max_age_seconds, commence_time (hint), date (historical), attempt,
--      parent_request_id }. Markets, books and regions are NOT the caller's to
-- choose: the category decides them, which is what lets every caller of a
-- category share one fingerprint, one snapshot and one fetch.
create or replace function public.odds_api_acquire(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.odds_api_config;
  cat public.odds_api_categories;
  sp public.odds_api_sports;
  snap public.odds_api_snapshots;
  v_now timestamptz;
  v_caller text := left(coalesce(nullif(trim(p->>'caller'), ''), 'unknown'), 80);
  v_trigger text := left(nullif(trim(p->>'trigger'), ''), 40);
  v_category text := lower(coalesce(p->>'category', ''));
  v_sport text := coalesce(p->>'sport_key', '');
  v_event text := coalesce(p->>'event_id', '');
  v_date text := nullif(p->>'date', '');
  v_max_age numeric := 0;
  v_attempt smallint := 1;
  v_parent bigint;
  v_endpoint text; v_format text; v_markets text[]; v_books text[]; v_selection text := ''; v_regeq integer;
  v_fp text; v_est integer := 0; v_priority smallint; v_group text := '*';
  v_hint timestamptz; v_commence timestamptz; v_hours numeric; v_iv jsonb; v_interval numeric; v_eff_age numeric;
  st jsonb; v_level smallint; v_level_now smallint := 0; v_stretch numeric := 1;
  v_spent_today bigint; v_allow integer; v_spent bigint; v_rem bigint; v_confirmed boolean; v_pct numeric;
  v_open_id bigint; v_id bigint; v_decision text; v_reason text; v_tripped boolean := false;
begin
  begin
    v_max_age := greatest(0, coalesce(nullif(p->>'max_age_seconds', '')::numeric, 0));
    v_attempt := greatest(1, least(5, coalesce(nullif(p->>'attempt', '')::int, 1)))::smallint;
    v_parent := nullif(p->>'parent_request_id', '')::bigint;
    v_hint := nullif(p->>'commence_time', '')::timestamptz;
  exception when others then v_hint := null;
  end;

  -- ONE LOCK FOR EVERY WORKER. The budget check and the reservation are one
  -- step: two gateways cannot both see the last credits as free.
  select * into c from public.odds_api_config where id = 1 for update;
  if not found then
    return jsonb_build_object('decision', 'denied_unconfigured', 'granted', false,
      'reason', 'odds_api_config has no row: fail closed');
  end if;
  v_now := clock_timestamp();

  -- A lease whose holder never settled is charged at its reservation.
  update public.odds_api_requests
     set status = 'expired', actual_credits = reserved_credits, cost_is_exact = false, settled_at = v_now,
         error = coalesce(error, 'lease expired before settle; charged at the reservation')
   where status = 'reserved' and lease_expires_at <= v_now;

  <<decide>>
  begin
    select * into cat from public.odds_api_categories where category = v_category;
    if not found then
      v_decision := 'denied_category'; v_reason := 'unknown category: ' || v_category; exit decide;
    end if;
    v_endpoint := cat.endpoint;
    if v_endpoint = 'sports' then
      v_sport := ''; v_event := '';
    else
      select * into sp from public.odds_api_sports where sport_key = v_sport;
      if not found or not sp.enabled then
        v_decision := 'denied_sport'; v_reason := 'sport not enabled for paid retrieval: ' || v_sport; exit decide;
      end if;
      v_group := sp.sport_group;
    end if;
    if v_endpoint in ('event_odds', 'historical_event_odds') and v_event = '' then
      v_decision := 'denied_bad_request'; v_reason := 'event_id is required for ' || v_endpoint; exit decide;
    end if;
    if v_endpoint not in ('event_odds', 'historical_event_odds') then v_event := ''; end if;
    if v_endpoint like 'historical%' and v_date is null then
      v_decision := 'denied_bad_request'; v_reason := 'historical requests need a date'; exit decide;
    end if;
    if v_endpoint not like 'historical%' then v_date := null; end if;

    v_priority := greatest(cat.priority, coalesce(sp.priority, 0));
    v_format := lower(coalesce(nullif(p->>'odds_format', ''), cat.default_format));
    if v_format not in ('decimal', 'american') then v_format := cat.default_format; end if;
    v_markets := public.odds_api_sorted(cat.markets);
    if v_endpoint in ('odds', 'event_odds', 'historical_odds', 'historical_event_odds') then
      v_books := public.odds_api_sorted(coalesce(cat.bookmakers, c.bookmakers));
      if coalesce(array_length(v_books, 1), 0) > 0 then
        v_selection := 'bookmakers:' || array_to_string(v_books, ',');
        v_regeq := greatest(1, ceil(array_length(v_books, 1) / 10.0))::int;
      else
        v_books := null;
        v_selection := 'regions:' || c.regions;
        v_regeq := greatest(1, coalesce(array_length(string_to_array(c.regions, ','), 1), 1));
      end if;
      -- UPPER BOUND: every market returned. The provider bills markets
      -- RETURNED, so settle usually gives some of this back.
      v_est := coalesce(array_length(v_markets, 1), 0) * v_regeq * greatest(cat.cost_multiplier, 1);
      if v_est <= 0 then v_decision := 'denied_bad_request'; v_reason := 'category has no markets'; exit decide; end if;
    elsif v_endpoint in ('historical_events', 'scores') then
      v_est := greatest(cat.cost_multiplier, 1);
    else
      v_est := 0;
    end if;
    v_fp := public.odds_api_fingerprint(v_endpoint, v_sport, v_event, v_markets, v_selection, v_format, v_date);
    select * into snap from public.odds_api_snapshots where fingerprint = v_fp;

    -- THE EVENT'S CLOCK, learned from earlier answers (free).
    if v_event <> '' then
      select commence_time into v_commence from public.odds_api_events where event_id = v_event;
      v_commence := coalesce(v_commence, v_hint);
    elsif v_endpoint in ('odds', 'events', 'scores') then
      select min(commence_time) into v_commence from public.odds_api_events
       where sport_key = v_sport and commence_time > v_now and last_seen_at > v_now - interval '4 days';
    end if;
    v_hours := case when v_commence is null then null else extract(epoch from (v_commence - v_now)) / 3600 end;
    if v_event <> '' and v_commence is not null and v_endpoint not like 'historical%' then
      if v_now >= v_commence + make_interval(secs => (c.completed_after_hours * 3600)::int) then
        v_decision := 'skipped_completed'; v_reason := 'event has finished: completed events are never polled'; exit decide;
      end if;
      if v_now >= v_commence then
        v_decision := 'skipped_live'; v_reason := 'event is in progress: regular odds polling stops at kickoff'; exit decide;
      end if;
    end if;

    st := public.odds_api_budget_state(v_now);
    v_spent_today := (st->>'spent_today')::bigint;
    v_allow := (st->>'daily_allowance')::int;
    v_spent := (st->>'spent_cycle')::bigint;
    v_confirmed := (st->>'quota_confirmed')::boolean;
    v_rem := nullif(st->>'provider_remaining_effective', '')::bigint;
    v_pct := case when c.monthly_budget > 0 then v_spent::numeric / c.monthly_budget end;
    v_level_now := public.odds_api_shed_level(v_spent_today, 0, v_allow, c.daily_overdraft_pct, v_pct, c.critical_pct);
    v_stretch := public.odds_api_level_stretch(v_level_now);

    v_iv := public.odds_api_interval(v_category, v_group, v_hours);
    if not coalesce((v_iv->>'found')::boolean, false) or jsonb_typeof(v_iv->'interval') is distinct from 'number' then
      v_decision := 'skipped_window'; v_reason := 'outside this category''s polling window'; exit decide;
    end if;
    v_interval := (v_iv->>'interval')::numeric;

    -- CACHE FIRST. A snapshot inside the (stretched) cadence window is the
    -- answer, whoever asks and however often.
    if snap.last_success_at is not null then
      v_eff_age := greatest(v_interval * 60 * v_stretch, v_max_age);
      if v_endpoint = 'event_odds' and coalesce(snap.markets_returned, 0) = 0 then
        v_eff_age := greatest(v_eff_age, c.empty_market_recheck_minutes * 60);
      end if;
      if v_now - snap.last_success_at < make_interval(secs => v_eff_age::double precision) then
        v_decision := 'cache_hit'; v_reason := 'stored snapshot is inside the cadence window'; exit decide;
      end if;
    end if;

    -- SINGLE FLIGHT. The same fingerprint already leased: collapse into it.
    select id into v_open_id from public.odds_api_requests
     where fingerprint = v_fp and status = 'reserved' and lease_expires_at > v_now order by id desc limit 1;
    if v_open_id is not null then
      v_decision := 'in_flight'; v_reason := 'the same request is already in flight'; exit decide;
    end if;

    if not c.odds_api_enabled and not (v_est = 0 and c.free_endpoints_enabled) then
      v_decision := 'denied_breaker'; v_reason := 'circuit breaker is off: ' || coalesce(c.breaker_reason, 'no reason recorded'); exit decide;
    end if;
    if not cat.enabled then
      v_decision := 'denied_category'; v_reason := 'category disabled: ' || v_category; exit decide;
    end if;

    if v_est > 0 then
      if c.provider_cooldown_until is not null and v_now < c.provider_cooldown_until then
        v_decision := 'denied_cooldown'; v_reason := 'provider cooling down: ' || coalesce(c.cooldown_reason, ''); exit decide;
      end if;
      if c.monthly_budget <= 0 or c.daily_target <= 0 then
        v_decision := 'denied_no_budget'; v_reason := 'paid budget is zero'; exit decide;
      end if;
      if not v_confirmed then
        v_decision := 'denied_unconfirmed_quota';
        v_reason := 'this cycle''s quota is not confirmed by a provider header yet (free quota probe, or odds_api_confirm_quota)';
        exit decide;
      end if;
      if v_spent + v_est > c.monthly_budget then
        perform public.odds_api_trip('auto: monthly paid-provider ceiling reached', 'odds_api_acquire');
        v_tripped := true; v_decision := 'denied_ceiling'; v_reason := 'monthly ceiling would be crossed: fail closed'; exit decide;
      end if;
      if v_spent + v_est > floor(c.emergency_pct * c.monthly_budget) then
        perform public.odds_api_trip(format('auto: %s%% of the monthly operational budget used', round(c.emergency_pct * 100)), 'odds_api_acquire');
        v_tripped := true; v_decision := 'denied_emergency'; v_reason := 'emergency threshold reached: breaker tripped'; exit decide;
      end if;
      if v_rem is not null and v_rem - v_est < c.monthly_reserve then
        perform public.odds_api_alert('warning', 'reserve_floor', 'A request was refused to protect the provider reserve.',
          jsonb_build_object('provider_remaining_effective', v_rem, 'reserve', c.monthly_reserve));
        v_decision := 'denied_reserve'; v_reason := 'provider reserve would be crossed'; exit decide;
      end if;
      v_level := public.odds_api_shed_level(v_spent_today, v_est, v_allow, c.daily_overdraft_pct, v_pct, c.critical_pct);
      if not public.odds_api_level_admits(v_level, v_priority, v_hours) then
        v_decision := 'denied_daily_budget';
        v_reason := format('daily shedding level %s drops priority %s (spent today %s of %s)', v_level, v_priority, v_spent_today, v_allow);
        exit decide;
      end if;
    end if;
    v_decision := 'granted';
  end decide;

  if snap.fingerprint is null and v_fp is not null then
    select * into snap from public.odds_api_snapshots where fingerprint = v_fp;
  end if;

  insert into public.odds_api_requests (cycle_start, usage_day, caller, trigger, category, sport_key, event_id, endpoint,
    markets, selection, odds_format, region_equivalents, fingerprint, decision, reason, dispatched, status, priority,
    shed_level, hours_to_start, interval_minutes, reserved_credits, attempt, parent_request_id, served_request_id,
    lease_expires_at)
  values (public.odds_api_cycle_start(v_now), (v_now at time zone 'utc')::date, v_caller, v_trigger, v_category,
    nullif(v_sport, ''), nullif(v_event, ''), v_endpoint, v_markets, nullif(v_selection, ''), v_format, v_regeq, v_fp,
    v_decision, left(v_reason, 400), v_decision = 'granted',
    case when v_decision = 'granted' then 'reserved' else 'not_dispatched' end,
    v_priority, coalesce(v_level, v_level_now), round(v_hours, 3), v_interval,
    case when v_decision = 'granted' then v_est else 0 end, v_attempt, v_parent,
    case when v_decision = 'in_flight' then v_open_id when v_decision = 'cache_hit' then snap.last_request_id end,
    case when v_decision = 'granted' then v_now + make_interval(secs => c.lease_seconds) end)
  returning id into v_id;

  return jsonb_build_object(
    'decision', v_decision, 'granted', v_decision = 'granted', 'reason', v_reason, 'request_id', v_id,
    'fingerprint', v_fp, 'category', v_category, 'endpoint', v_endpoint,
    'sport_key', nullif(v_sport, ''), 'event_id', nullif(v_event, ''), 'date', v_date,
    'markets', to_jsonb(v_markets), 'bookmakers', to_jsonb(v_books),
    'regions', case when v_selection like 'regions:%' then c.regions end,
    'odds_format', v_format, 'est_credits', v_est, 'lease_seconds', c.lease_seconds,
    'hours_to_start', round(v_hours, 2), 'interval_minutes', v_interval,
    'shed_level', coalesce(v_level, v_level_now), 'priority', v_priority,
    'in_flight_request_id', v_open_id,
    'breaker', case when c.odds_api_enabled and not v_tripped then 'on' else 'off' end,
    'snapshot', case when snap.last_success_at is not null then jsonb_build_object(
        'request_id', snap.last_request_id, 'fetched_at', snap.last_success_at,
        'age_seconds', round(extract(epoch from (v_now - snap.last_success_at))),
        'has_body', snap.body is not null, 'events_count', snap.events_count,
        'markets_returned', snap.markets_returned) end);
end $$;
