-- odds_api_gateway -- part 5 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.odds_api_set_sport(p_sport text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_sports set enabled = p_enabled where sport_key = p_sport;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown sport'); end if;
  return jsonb_build_object('ok', true, 'sport_key', p_sport, 'enabled', p_enabled);
end $$;

create or replace function public.odds_api_enabled()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select odds_api_enabled from public.odds_api_config where id = 1), false)
$$;

-- ── 9. JOB LOCKS: overlapping runs of one job collapse into one ────────────
create or replace function public.odds_api_job_lock(p_job text, p_holder text, p_ttl_seconds integer default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  insert into public.odds_api_job_locks (job, holder, acquired_at, expires_at)
  values (left(p_job, 120), left(p_holder, 120), now(), now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 3600))))
  on conflict (job) do update set holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
   where public.odds_api_job_locks.expires_at <= now() or public.odds_api_job_locks.holder = excluded.holder
  returning true into v;
  return coalesce(v, false);
end $$;

create or replace function public.odds_api_job_unlock(p_job text, p_holder text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.odds_api_job_locks where job = p_job and holder = p_holder;
  return found;
end $$;

-- ── 10. WHAT A READER MAY KNOW: the feed's state and its last verified prices
create or replace function public.odds_feed_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; st jsonb; v_state text; v_level smallint;
begin
  select * into c from public.odds_api_config where id = 1;
  st := public.odds_api_budget_state(now());
  v_level := public.odds_api_shed_level(coalesce((st->>'spent_today')::bigint, 0), 0, (st->>'daily_allowance')::int,
               coalesce(c.daily_overdraft_pct, 0.25), nullif(st->>'budget_used_pct', '')::numeric, coalesce(c.critical_pct, 0.8));
  v_state := case when c.id is null or not c.odds_api_enabled then 'paused'
                  when c.provider_cooldown_until > now() or v_level >= 3 then 'degraded' else 'live' end;
  return jsonb_build_object(
    'state', v_state,
    'paid_refresh', v_state <> 'paused',
    'message', case v_state
      when 'paused' then 'Sportsbook price refresh is paused. Prices shown are the last verified prices, with the time they were captured.'
      when 'degraded' then 'Sportsbook prices are refreshing less often than usual. Check each price''s capture time.'
      else 'Sportsbook prices refresh on an event-aware schedule: more often as kickoff approaches.' end,
    'checked_at', now(),
    /* per sport: when its prices were last verified, its next kickoff, and the
       longest the board may now go between refreshes (the event-aware cadence,
       stretched under budget pressure) — so a reader can tell "on schedule"
       from "behind" without assuming a fixed 30-minute capture */
    'sports', coalesce((select jsonb_agg(jsonb_build_object('sport_key', s.sport_key, 'label', s.label,
        'last_verified_at', f.last_ok, 'age_minutes', round(extract(epoch from (now() - f.last_ok)) / 60),
        'next_kickoff', k.next_ko,
        'expected_refresh_minutes', round((public.odds_api_interval('featured', s.sport_group,
            case when k.next_ko is null then null else extract(epoch from (k.next_ko - now())) / 3600 end)->>'interval')::numeric
            * public.odds_api_level_stretch(v_level)))
        order by s.priority, s.sport_key)
      from public.odds_api_sports s
      left join lateral (select max(last_success_at) as last_ok from public.odds_api_snapshots n
                          where n.sport_key = s.sport_key and n.category in ('featured', 'close', 'collective')) f on true
      left join lateral (select min(commence_time) as next_ko from public.odds_api_events e
                          where e.sport_key = s.sport_key and e.commence_time > now() and e.last_seen_at > now() - interval '4 days') k on true
      where s.enabled), '[]'::jsonb),
    'props', coalesce((select jsonb_agg(jsonb_build_object('sport_key', x.sport_key, 'last_verified_at', x.last_ok))
      from (select n.sport_key, max(n.last_success_at) as last_ok from public.odds_api_snapshots n
             where n.category like 'props%' and n.last_success_at is not null group by n.sport_key) x), '[]'::jsonb));
end $$;

-- ── 11. THE COST DASHBOARD: local records only, never a provider call ──────
create or replace function public.odds_api_dashboard(p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.odds_api_config; st jsonb; v_from date; v_today date := (now() at time zone 'utc')::date;
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_dashboard: operators only' using errcode = '42501';
  end if;
  v_from := v_today - greatest(1, least(coalesce(p_days, 14), 62));
  select * into c from public.odds_api_config where id = 1;
  st := public.odds_api_budget_state(now());
  return jsonb_build_object(
    'generated_at', now(),
    'breaker', jsonb_build_object('enabled', c.odds_api_enabled, 'reason', c.breaker_reason, 'changed_at', c.breaker_changed_at,
      'changed_by', c.breaker_changed_by, 'free_endpoints_enabled', c.free_endpoints_enabled,
      'cooldown_until', c.provider_cooldown_until, 'cooldown_reason', c.cooldown_reason, 'consecutive_failures', c.consecutive_failures),
    'budget', st,
    'shed_level_now', public.odds_api_shed_level(coalesce((st->>'spent_today')::bigint, 0), 0, (st->>'daily_allowance')::int,
       c.daily_overdraft_pct, nullif(st->>'budget_used_pct', '')::numeric, c.critical_pct),
    'today', (select jsonb_build_object(
        'credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched), 0),
        'dispatched', count(*) filter (where dispatched),
        'cache_hits', count(*) filter (where decision = 'cache_hit'),
        'collapsed_in_flight', count(*) filter (where decision = 'in_flight'),
        'skipped_live_or_completed', count(*) filter (where decision in ('skipped_live', 'skipped_completed')),
        'denied', count(*) filter (where decision like 'denied%'),
        'decisions', count(*),
        'cache_hit_rate', round((count(*) filter (where decision in ('cache_hit', 'in_flight')))::numeric
                               / nullif(count(*) filter (where decision in ('cache_hit', 'in_flight', 'granted')), 0), 4),
        'props_credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched and category like 'props%'), 0))
      from public.odds_api_requests where usage_day = v_today),
    'daily', coalesce((select jsonb_agg(d order by d->>'day') from (
        select jsonb_build_object('day', usage_day,
          'credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched), 0),
          'dispatched', count(*) filter (where dispatched), 'cache_hits', count(*) filter (where decision = 'cache_hit'),
          'collapsed', count(*) filter (where decision = 'in_flight'), 'denied', count(*) filter (where decision like 'denied%')) as d
        from public.odds_api_requests where usage_day >= v_from group by usage_day) x), '[]'::jsonb),
    'by_caller', coalesce((select jsonb_agg(x order by x->>'day', x->>'caller') from (
        select jsonb_build_object('day', usage_day, 'caller', caller, 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits))) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, caller) y), '[]'::jsonb),
    'by_sport', coalesce((select jsonb_agg(x order by x->>'day', x->>'sport_key') from (
        select jsonb_build_object('day', usage_day, 'sport_key', coalesce(sport_key, '(none)'), 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits))) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, sport_key) y), '[]'::jsonb),
    'by_endpoint', coalesce((select jsonb_agg(x order by x->>'day', x->>'endpoint', x->>'category') from (
        select jsonb_build_object('day', usage_day, 'endpoint', endpoint, 'category', category, 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits)),
          'avg_cost', round(avg(coalesce(actual_credits, reserved_credits)), 2)) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, endpoint, category) y), '[]'::jsonb),
    'freshness', coalesce((select jsonb_agg(jsonb_build_object('sport_key', sport_key, 'category', category,
        'snapshots', n, 'last_success_at', last_ok, 'age_minutes', round(extract(epoch from (now() - last_ok)) / 60),
        'last_attempt_at', last_try, 'failing', failing) order by sport_key, category)
      from (select sport_key, category, count(*) as n, max(last_success_at) as last_ok, max(last_attempt_at) as last_try,
                   count(*) filter (where last_status = 'failed') as failing
              from public.odds_api_snapshots group by sport_key, category) f), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'level', level, 'code', code,
        'message', message, 'acknowledged_at', acknowledged_at) order by created_at desc)
      from (select * from public.odds_api_alerts order by created_at desc limit 50) a), '[]'::jsonb),
    'open_alerts', (select count(*) from public.odds_api_alerts where acknowledged_at is null and level in ('warning', 'critical', 'emergency')),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'caller', caller, 'category', category,
        'sport_key', sport_key, 'event_id', event_id, 'decision', decision, 'status', status, 'reserved', reserved_credits,
        'actual', actual_credits, 'exact', cost_is_exact, 'http', http_status, 'remaining', requests_remaining,
        'reason', reason, 'error', error) order by id desc)
      from (select * from public.odds_api_requests order by id desc limit 60) r), '[]'::jsonb),
    'categories', (select jsonb_agg(to_jsonb(k) order by k.priority, k.category) from public.odds_api_categories k),
    'sports', (select jsonb_agg(to_jsonb(s) order by s.priority, s.sport_key) from public.odds_api_sports s),
    'cadence', (select jsonb_agg(to_jsonb(d) order by d.category, d.sport_group, d.max_hours_to_start) from public.odds_api_cadence d));
end $$;

-- An admin may PAUSE paid retrieval from the dashboard. Turning it back on is
-- a SQL-editor / service-role act (odds_api_set_enabled), never a click.
create or replace function public.odds_api_admin_pause(p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_admin_pause: operators only' using errcode = '42501';
  end if;
  update public.odds_api_config set odds_api_enabled = false, breaker_reason = left('dashboard: ' || coalesce(p_reason, 'paused'), 300),
         breaker_changed_at = now(), breaker_changed_by = 'dashboard', updated_at = now() where id = 1;
  perform public.odds_api_alert('warning', 'breaker_off', 'Paid retrieval paused from the dashboard: ' || coalesce(p_reason, ''), null);
  return jsonb_build_object('ok', true, 'enabled', false);
end $$;

create or replace function public.odds_api_ack_alert(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_ack_alert: operators only' using errcode = '42501';
  end if;
  update public.odds_api_alerts set acknowledged_at = now(), acknowledged_by = coalesce(current_setting('request.jwt.claims', true)::jsonb->>'sub', session_user)
   where id = p_id and acknowledged_at is null;
  return jsonb_build_object('ok', found);
end $$;

-- ── 12. RETENTION ───────────────────────────────────────────────────────────
-- Event-level snapshot bodies go after snapshot_retention_hours; the latest
-- sport-level board is always kept (it is the last verified price when the
-- breaker is off). Refusals and cache hits go after decision_retention_days;
-- dispatched (billed) rows after ledger_retention_days.
create or replace function public.odds_api_prune()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; a integer; b integer; d integer; e integer;
begin
  select * into c from public.odds_api_config where id = 1;
  delete from public.odds_api_snapshots where event_id is not null and updated_at < now() - make_interval(hours => c.snapshot_retention_hours);
  get diagnostics a = row_count;
  delete from public.odds_api_requests where not dispatched and created_at < now() - make_interval(days => c.decision_retention_days);
  get diagnostics b = row_count;
  delete from public.odds_api_requests where dispatched and created_at < now() - make_interval(days => c.ledger_retention_days);
  get diagnostics d = row_count;
  delete from public.odds_api_events where commence_time < now() - interval '30 days';
  get diagnostics e = row_count;
  delete from public.odds_api_alerts where acknowledged_at is not null and created_at < now() - interval '90 days';
  delete from public.odds_api_job_locks where expires_at < now() - interval '1 day';
  delete from public.odds_api_consumer_marks where consumed_at < now() - interval '30 days';
  return jsonb_build_object('snapshots', a, 'decisions', b, 'ledger', d, 'events', e);
end $$;

-- ── 13. WHO MAY CALL WHAT ───────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'public.odds_api_acquire(jsonb)', 'public.odds_api_settle(jsonb)', 'public.odds_api_snapshot(text)',
    'public.odds_api_consume(text,text,bigint)',
    'public.odds_api_set_budget(integer,integer,integer)', 'public.odds_api_apply_recovery_budget()',
    'public.odds_api_set_enabled(boolean,text,text)', 'public.odds_api_confirm_quota(integer,integer,text)',
    'public.odds_api_set_category(text,boolean)', 'public.odds_api_set_sport(text,boolean)',
    'public.odds_api_job_lock(text,text,integer)', 'public.odds_api_job_unlock(text,text)',
    'public.odds_api_prune()', 'public.odds_api_budget_state(timestamptz)', 'public.odds_api_enabled()',
    'public.odds_api_trip(text,text)', 'public.odds_api_alert(text,text,text,jsonb)',
    'public.odds_api_dashboard(integer)', 'public.odds_api_admin_pause(text)', 'public.odds_api_ack_alert(bigint)',
    'public.odds_feed_status()', 'public.odds_api_is_admin()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  -- signed-in operators: the dashboard, pause and acknowledge (each checks the operator list itself)
  execute 'grant execute on function public.odds_api_dashboard(integer), public.odds_api_admin_pause(text), public.odds_api_ack_alert(bigint), public.odds_api_is_admin() to authenticated';
  -- everyone: whether prices are refreshing, and when each sport was last verified
  execute 'grant execute on function public.odds_feed_status() to anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.odds_api_config, public.odds_api_requests, public.odds_api_snapshots, public.odds_api_events,
             public.odds_api_alerts, public.odds_api_categories, public.odds_api_sports, public.odds_api_cadence to service_role';
  end if;
end $g$;
alter table public.odds_api_categories enable row level security;
alter table public.odds_api_sports enable row level security;
alter table public.odds_api_cadence enable row level security;
revoke all on public.odds_api_categories, public.odds_api_sports, public.odds_api_cadence from anon, authenticated;

-- Daily retention, where pg_cron exists. It calls no provider.
do $c$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null and to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'odds_api_prune') then
      perform cron.schedule('odds_api_prune', '37 4 * * *', 'select public.odds_api_prune();');
    end if;
  end if;
end $c$;

notify pgrst, 'reload schema';
