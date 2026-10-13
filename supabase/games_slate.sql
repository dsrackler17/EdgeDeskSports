-- ============================================================================
-- EdgeDesk — Today's Games: the live layer of the daily slate, and the
-- subscriber's read of captured prices for it. docs/games/README.md
--
-- The slate itself is a static file (today/slate.json, built every half hour
-- by .github/workflows/games-slate.yml). This file adds what a static file
-- cannot do: minute-level status, score and clock while games are being
-- played, written by ONE poller (tools/slate/live_poll.js, games-live.yml)
-- and read by every visitor from here, so no visitor ever reaches a provider.
--
--   public.slate_live          one row per event the poller has read
--   public.slate_feed_state    one row per (feed, Eastern day) read: when,
--                              whether it answered, what it said went wrong
--   slate_live_ingest()        the poller's only door (service role)
--   public_slate_live()        the anonymous read: status, score, clock and
--                              ESPN's pregame quote. No Odds API price.
--   slate_markets()            the SUBSCRIBER read of the prices capture has
--                              already bought (odds_api_snapshots, featured):
--                              every book, its own update time. Entitled
--                              callers only (edp_entitled), never anon.
--
-- Pasted into the SQL editor (supabase/README.md): idempotent, additive, no
-- psql meta-command, ends in a report. Nothing here buys a price or calls a
-- provider; nothing here changes an existing table.
-- ============================================================================
begin;

-- ── 1. the live rows ────────────────────────────────────────────────────────
create table if not exists public.slate_live (
  event_id    text primary key,
  sport       text not null,
  feed        text not null,
  sb_day      date not null,
  start_utc   timestamptz not null,
  status      text not null,
  event       jsonb not null,
  market      jsonb,
  source      text not null default 'espn',
  updated_at  timestamptz not null,
  written_at  timestamptz not null default now(),
  constraint slate_live_id_shape check (event_id ~ '^[a-z]+:[a-z]+:[A-Za-z0-9_.:|-]{1,80}$'),
  constraint slate_live_status check (status in ('SCHEDULED','DELAYED','LIVE','FINAL','SUSPENDED','POSTPONED','CANCELED'))
);
create index if not exists slate_live_day_idx on public.slate_live (sb_day, sport);
create index if not exists slate_live_start_idx on public.slate_live (start_utc);
alter table public.slate_live enable row level security;
revoke all on public.slate_live from anon, authenticated;

create table if not exists public.slate_feed_state (
  feed        text not null,
  sport       text not null,
  day         date not null,
  ok          boolean not null,
  fetched_at  timestamptz,
  event_count integer,
  last_error  text,
  checked_at  timestamptz not null default now(),
  primary key (feed, day)
);
alter table public.slate_feed_state enable row level security;
revoke all on public.slate_feed_state from anon, authenticated;

-- ── 2. the poller's door ────────────────────────────────────────────────────
-- p_feeds:  [{feed, sport, day, ok, fetched_at, count, error}]
-- p_events: [{id, sport, feed, sb_day, start_utc, status, updated_at, event, market}]
-- A (feed, day) that answered is the truth for that day: an event it no
-- longer lists has moved or been dropped by the source and leaves the day.
-- A newer row is never overwritten by an older read.
create or replace function public.slate_live_ingest(p_events jsonb, p_feeds jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_up integer := 0; v_gone integer := 0; v_feeds integer := 0; v_pruned integer := 0;
begin
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_feeds, '[]'::jsonb)) <> 'array' then
    raise exception 'slate_live_ingest: p_events and p_feeds must be arrays';
  end if;
  if jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 3000 then
    raise exception 'slate_live_ingest: at most 3000 events per call';
  end if;

  insert into public.slate_feed_state as s (feed, sport, day, ok, fetched_at, event_count, last_error, checked_at)
  select f->>'feed', f->>'sport', (f->>'day')::date, coalesce((f->>'ok')::boolean, false),
         nullif(f->>'fetched_at', '')::timestamptz, nullif(f->>'count', '')::integer, left(f->>'error', 300), now()
  from jsonb_array_elements(coalesce(p_feeds, '[]'::jsonb)) f
  where f->>'feed' is not null and f->>'day' ~ '^\d{4}-\d{2}-\d{2}$'
  on conflict (feed, day) do update set
    ok = excluded.ok,
    fetched_at = case when excluded.ok then excluded.fetched_at else s.fetched_at end,
    event_count = case when excluded.ok then excluded.event_count else s.event_count end,
    last_error = excluded.last_error, checked_at = now();
  get diagnostics v_feeds = row_count;

  -- moved or dropped: gone from a (feed, day) that answered
  delete from public.slate_live l
  using jsonb_array_elements(coalesce(p_feeds, '[]'::jsonb)) f
  where coalesce((f->>'ok')::boolean, false)
    and l.feed = f->>'feed' and l.sb_day = (f->>'day')::date
    and not exists (select 1 from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e where e->>'id' = l.event_id);
  get diagnostics v_gone = row_count;

  insert into public.slate_live as l (event_id, sport, feed, sb_day, start_utc, status, event, market, source, updated_at, written_at)
  select e->>'id', e->>'sport', e->>'feed', (e->>'sb_day')::date, (e->>'start_utc')::timestamptz, e->>'status',
         e->'event', nullif(e->'market', 'null'::jsonb), coalesce(e->>'source', 'espn'), (e->>'updated_at')::timestamptz, now()
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
  where e->>'id' is not null and e->>'start_utc' is not null and e->>'updated_at' is not null
  on conflict (event_id) do update set
    sport = excluded.sport, feed = excluded.feed, sb_day = excluded.sb_day, start_utc = excluded.start_utc,
    status = excluded.status, event = excluded.event, market = excluded.market, source = excluded.source,
    updated_at = excluded.updated_at, written_at = now()
  where l.updated_at <= excluded.updated_at;
  get diagnostics v_up = row_count;

  -- a live layer, not an archive: four days back is all the slate shows
  delete from public.slate_live where sb_day < (now() at time zone 'America/New_York')::date - 4;
  get diagnostics v_pruned = row_count;
  delete from public.slate_feed_state where day < (now() at time zone 'America/New_York')::date - 4;

  return jsonb_build_object('upserted', v_up, 'removed', v_gone, 'feeds', v_feeds, 'pruned', v_pruned);
end $$;
revoke all on function public.slate_live_ingest(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.slate_live_ingest(jsonb, jsonb) to service_role;

-- ── 3. the anonymous read ───────────────────────────────────────────────────
-- At most four days per call. `covered` lists every (feed, day) the poller
-- read successfully, with when, so the page can lay the live read over the
-- static snapshot only where the live read is the newer of the two.
create or replace function public.public_slate_live(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d0 date; d1 date;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '4 days' then
    return jsonb_build_object('schema', 'edgedesk_slate_live/1', 'error', 'the window must be one to four days', 'events', '[]'::jsonb, 'covered', '[]'::jsonb);
  end if;
  d0 := (p_from at time zone 'America/New_York')::date - 1;
  d1 := (p_to at time zone 'America/New_York')::date;
  return jsonb_build_object(
    'schema', 'edgedesk_slate_live/1',
    'as_of', now(),
    'covered', coalesce((select jsonb_agg(jsonb_build_object('feed', s.feed, 'sport', s.sport, 'day', s.day, 'fetched_at', s.fetched_at) order by s.feed, s.day)
                         from public.slate_feed_state s where s.day between d0 and d1 and s.ok and s.fetched_at is not null), '[]'::jsonb),
    'failed', coalesce((select jsonb_agg(jsonb_build_object('feed', s.feed, 'sport', s.sport, 'day', s.day, 'checked_at', s.checked_at, 'last_ok_at', s.fetched_at))
                        from public.slate_feed_state s where s.day between d0 and d1 and not s.ok), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(l.event || jsonb_build_object('market', l.market) order by l.start_utc, l.event_id)
                        from (select * from public.slate_live where sb_day between d0 and d1 order by start_utc limit 3000) l), '[]'::jsonb)
  );
end $$;
revoke all on function public.public_slate_live(timestamptz, timestamptz) from public;
grant execute on function public.public_slate_live(timestamptz, timestamptz) to anon, authenticated;

-- ── 4. the subscriber's prices ──────────────────────────────────────────────
-- What capture already stored (the gateway's `featured` snapshots: h2h,
-- spreads, totals, every book with its own last_update). Read-only, no
-- purchase, at most four days per call, entitled readers only.
create or replace function public.slate_markets(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  -- the entitlement check lives in personal_research.sql; without it nobody is
  -- entitled here (two statements: plpgsql resolves a function when it first
  -- runs the statement that names it, so the missing case must return first)
  if to_regprocedure('public.edp_entitled(uuid)') is null then
    return jsonb_build_object('schema', 'edgedesk_slate_markets/1', 'entitled', false, 'events', '[]'::jsonb);
  end if;
  if not public.edp_entitled(auth.uid()) then
    return jsonb_build_object('schema', 'edgedesk_slate_markets/1', 'entitled', false, 'events', '[]'::jsonb);
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '4 days' then
    return jsonb_build_object('schema', 'edgedesk_slate_markets/1', 'entitled', true, 'error', 'the window must be one to four days', 'events', '[]'::jsonb);
  end if;
  if to_regclass('public.odds_api_snapshots') is null then
    return jsonb_build_object('schema', 'edgedesk_slate_markets/1', 'entitled', true, 'available', false, 'events', '[]'::jsonb);
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object(
             'event_id', ev->>'id', 'sport_key', coalesce(ev->>'sport_key', s.sport_key), 'commence_time', ev->>'commence_time',
             'home_team', ev->>'home_team', 'away_team', ev->>'away_team', 'snapshot_at', s.last_success_at,
             'odds_format', s.odds_format, 'bookmakers', ev->'bookmakers')), '[]'::jsonb)
    from public.odds_api_snapshots s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s.body) = 'array' then s.body else '[]'::jsonb end) ev
    where s.category = 'featured' and s.last_success_at > now() - interval '72 hours'
      and (ev->>'commence_time')::timestamptz >= $1 and (ev->>'commence_time')::timestamptz < $2
  $q$ into v using p_from, p_to;
  return jsonb_build_object('schema', 'edgedesk_slate_markets/1', 'entitled', true, 'available', true, 'as_of', now(), 'events', v);
end $$;
revoke all on function public.slate_markets(timestamptz, timestamptz) from public, anon;
grant execute on function public.slate_markets(timestamptz, timestamptz) to authenticated;

commit;

-- ── report ──────────────────────────────────────────────────────────────────
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select 'slate_live exists, RLS on' as check_name,
         (select coalesce(bool_and(relrowsecurity), false)::text from pg_class where oid = to_regclass('public.slate_live')) as got, 'true' as want
  union all
  select 'slate_feed_state exists, RLS on',
         (select coalesce(bool_and(relrowsecurity), false)::text from pg_class where oid = to_regclass('public.slate_feed_state')), 'true'
  union all
  select 'anon cannot read the tables directly',
         (has_table_privilege('anon', 'public.slate_live', 'select') or has_table_privilege('anon', 'public.slate_feed_state', 'select'))::text, 'false'
  union all
  select 'anon may call public_slate_live', has_function_privilege('anon', 'public.public_slate_live(timestamptz, timestamptz)', 'execute')::text, 'true'
  union all
  select 'anon may NOT call slate_live_ingest', has_function_privilege('anon', 'public.slate_live_ingest(jsonb, jsonb)', 'execute')::text, 'false'
  union all
  select 'authenticated may NOT call slate_live_ingest', has_function_privilege('authenticated', 'public.slate_live_ingest(jsonb, jsonb)', 'execute')::text, 'false'
  union all
  select 'anon may NOT call slate_markets', has_function_privilege('anon', 'public.slate_markets(timestamptz, timestamptz)', 'execute')::text, 'false'
  union all
  select 'authenticated may call slate_markets (entitlement checked inside)', has_function_privilege('authenticated', 'public.slate_markets(timestamptz, timestamptz)', 'execute')::text, 'true'
) r;
