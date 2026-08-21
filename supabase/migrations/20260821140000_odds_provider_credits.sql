-- NFL odds: a second provider, and a cadence that fits a metered plan.
--
-- WHY THIS EXISTS
--
-- The odds layer shipped configured for OddsBlaze, whose plan bills per book
-- request. The Odds API bills differently: one request returns every book in a
-- region, and the cost is [number of markets] x [number of regions]. On a
-- 500-credit free plan with three markets in one region that is 3 credits per
-- poll, so about 166 polls per MONTH.
--
-- The cadence the layer shipped with — 60s live, 300s pregame, 1800s idle —
-- would spend all 500 credits in well under a day and then fail with 429s for
-- the rest of the month. So this migration does three things:
--
--   1. adds the credit budget settings the ingest function now enforces,
--   2. re-times the poll cadence to fit ~166 polls a month, and
--   3. widens the freshness horizons to match, because a 15-minute staleness
--      threshold against a 4-hour poll cadence would mark a perfectly healthy
--      feed stale within minutes of every poll, and a 90-minute book horizon
--      would drop every book out of consensus between polls.
--
-- (3) is not cosmetic. Without it the board would ingest correctly and still
-- render "Odds unavailable", which is the exact failure this is meant to fix.
--
-- WHAT THIS TRADES AWAY, STATED PLAINLY
--
-- At 166 polls a month this is a GRADING board, not a live in-play ticker.
-- It captures opens, intraday movement and closing lines well enough to grade
-- models and compute CLV. It cannot follow a number minute by minute during a
-- game. "live" in the freshness envelope means "polled within the plan's
-- cadence", not "within the last minute". Raising the plan is the only thing
-- that changes that, and every value below is a settings row, so raising the
-- plan is an UPDATE, not a deploy.

begin;

-- ------------------------------------------------- register the provider
--
-- MUST come before the provider.default switch below. odds.event_providers
-- and odds.snapshots both carry `provider text not null references
-- odds.providers(id)`, so pointing provider.default at an id with no row here
-- does not degrade gracefully: EVERY ingest fails on a foreign key violation
-- and the board stays exactly as empty as it was, with the cause buried in a
-- run record. Verified by running an ingest without this row and watching
-- event_providers_provider_fkey reject it.

insert into odds.providers (id, name, notes) values
  ('theoddsapi', 'The Odds API',
   'REST pull, api.the-odds-api.com/v4. One request returns every book in a region; billed [markets] x [regions]. Credential lives only in the THE_ODDS_API_KEY (or NFL_ODDS_API_KEY) edge function secret.')
on conflict (id) do nothing;

-- --------------------------------------------------- who last polled us
--
-- The freshness envelope pairs "when we last polled" with "who we polled",
-- so the provider has to come from the same run as last_poll_at rather than
-- from a constant in the edge function. With two providers registered, a
-- hardcoded name is a payload that misstates where its own numbers came
-- from — and /v1/nfl/assistant hands that field to a research model as fact.

create or replace function odds.last_poll_provider()
returns text language sql stable as $$
  select provider from odds.ingest_runs
  where status in ('ok','partial')
  order by coalesce(finished_at, started_at) desc, id desc
  limit 1;
$$;

-- ------------------------------------------------------------ new settings

insert into odds.settings (key, value, description) values
  ('provider.credit_reserve', '40'::jsonb,
   'Credits the ingest function refuses to spend below, so end-of-period closing captures stay affordable'),
  ('provider.quota', 'null'::jsonb,
   'Last credit balance the provider reported. Written by the ingest function after each run; read before the next one to enforce the budget')
on conflict (key) do nothing;

-- ----------------------------------------------- switch to a working feed
--
-- Guarded on "has an ingest run ever succeeded". If OddsBlaze is working,
-- nothing here touches it. If nothing has ever succeeded there is no working
-- configuration to protect, and leaving the default pointed at a provider with
-- no usable credential just keeps the board empty.

do $mig$
declare
  ever_worked boolean;
begin
  select exists (
    select 1 from odds.ingest_runs where status in ('ok','partial')
  ) into ever_worked;

  if ever_worked then
    raise notice 'odds: a previous ingest run succeeded; leaving provider and cadence untouched';
    return;
  end if;

  raise notice 'odds: no ingest run has ever succeeded; switching to theoddsapi with a metered cadence';

  perform collective.odds_set_setting('provider.default', '"theoddsapi"'::jsonb);

  -- Cadence sized for ~166 polls/month. Roughly 28 polls a week:
  --   idle    12h  -> 2/day midweek
  --   pregame  4h  -> ~6 across the 24h before the next kickoff
  --   live     1h  -> ~14 across Sunday and Monday night
  perform collective.odds_set_setting('nfl.refresh_seconds.idle',    '43200'::jsonb);
  perform collective.odds_set_setting('nfl.refresh_seconds.pregame', '14400'::jsonb);
  perform collective.odds_set_setting('nfl.refresh_seconds.live',    '3600'::jsonb);
  perform collective.odds_set_setting('nfl.pregame_window_hours',    '24'::jsonb);

  -- Freshness horizons follow the cadence, not the other way round.
  -- stale_after must exceed the slowest cadence a healthy feed can sit at, or
  -- the read API calls a working feed stale. book_stale must span several
  -- polls, or books drop out of consensus in the gaps between them.
  perform collective.odds_set_setting('nfl.stale_after_seconds', '54000'::jsonb);  -- 15h
  perform collective.odds_set_setting('nfl.book_stale_seconds',  '43200'::jsonb);  -- 12h

  -- Books actually carried by The Odds API's `us` region. Pinnacle, Circa and
  -- BookMaker are not in it: Pinnacle is `eu`, which would double the credit
  -- cost of every poll, and the other two are not offered at all. The sharp
  -- column on the site is built to render as absent rather than to invent a
  -- number, so it simply stays empty until the plan justifies adding `eu`.
  perform collective.odds_set_setting('nfl.books',
    '["draftkings","fanduel","betmgm","caesars","betrivers","espnbet","fanatics","hardrock","bovada","betonline","lowvig"]'::jsonb);

  -- One request returns every book, so the per-run book cap is not a cost
  -- control here; it only bounds how many are named in the run record.
  perform collective.odds_set_setting('nfl.max_books_per_run', '24'::jsonb);
end $mig$;

-- --------------------------------------------------------------- new books
--
-- Registered up front with correct consensus flags. Ingest auto-registers an
-- unknown book, but it defaults to include_in_consensus = true, and the
-- reduced-juice offshore books belong in best-price without being allowed to
-- drag the consensus median away from the regulated US market.

insert into odds.books (id, name, is_sharp, include_in_consensus, priority) values
  ('bovada',    'Bovada',      false, false, 60),
  ('betonline', 'BetOnline',   false, false, 61),
  ('lowvig',    'LowVig',      false, false, 62),
  ('mybookie',  'MyBookie',    false, false, 63),
  ('betus',     'BetUS',       false, false, 64),
  ('superbook', 'SuperBook',   false, true,  45),
  ('unibet',    'Unibet',      false, true,  46),
  ('ballybet',  'Bally Bet',   false, true,  47),
  ('betfair',   'Betfair',     true,  false, 25)
on conflict (id) do nothing;

-- =========================================================================
-- MAKE IT ACTUALLY RUN
-- =========================================================================
--
-- Deploying the ingest function does not poll anything. Something has to CALL
-- it, and nothing did — which is the entire reason the board has been empty.
-- Triggering it by hand needs a POST carrying the service role key, so the
-- schedule lives here instead, in the database, where pg_cron can drive it
-- without a human in the loop.
--
-- pg_cron runs inside Postgres and cannot read an edge function secret, so it
-- authenticates with a token kept in odds.settings: both sides read the same
-- value from the one place that is already service-role-only. No new secret to
-- distribute, and nothing sensitive written into a cron job definition.

-- ------------------------------------------------------- the shared token

do $mig$
declare v_existing text;
begin
  v_existing := trim(both '"' from coalesce((odds.get_setting('ingest.cron_token'))::text, ''));
  if v_existing is null or v_existing = '' or v_existing = 'null' then
    -- Two UUIDs, hyphens stripped: 64 hex characters from the same source
    -- Postgres uses for primary keys, with no extension dependency.
    perform collective.odds_set_setting('ingest.cron_token', to_jsonb(
      replace(gen_random_uuid()::text, '-', '') ||
      replace(gen_random_uuid()::text, '-', '')));
    raise notice 'odds: generated ingest.cron_token';
  else
    raise notice 'odds: ingest.cron_token already set, left alone';
  end if;
end $mig$;

insert into odds.settings (key, value, description) values
  ('ingest.function_url',
   '"https://iattxbkbufslbauoumga.supabase.co/functions/v1/collective_odds_ingest/v1/ingest"'::jsonb,
   'Where the scheduled job POSTs to. Change this and the schedule follows, with no redeploy.'),
  ('ingest.cron_schedule', '"*/30 * * * *"'::jsonb,
   'How often the scheduler fires. The function throttles itself to the nfl.refresh_seconds cadence and to the credit budget, so firing more often than needed is cheap: an early call returns skipped without touching the provider.')
on conflict (key) do nothing;

-- --------------------------------------------------------- the caller

-- Late bound on purpose: net.http_post is resolved when this RUNS, not when
-- it is created, so the migration still applies cleanly on a database where
-- pg_net is not installed. The failure then lands on the caller, with a
-- readable message, instead of aborting the whole migration.
create or replace function odds.run_ingest()
returns bigint language plpgsql security definer set search_path = odds, public as $$
declare
  v_url   text;
  v_token text;
  v_req   bigint;
begin
  v_url   := trim(both '"' from coalesce((odds.get_setting('ingest.function_url'))::text, ''));
  v_token := trim(both '"' from coalesce((odds.get_setting('ingest.cron_token'))::text, ''));
  if v_url is null or v_url = '' or v_url = 'null' then
    raise exception 'odds.run_ingest: ingest.function_url is not set';
  end if;
  if v_token is null or v_token = '' or v_token = 'null' then
    raise exception 'odds.run_ingest: ingest.cron_token is not set';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'odds.run_ingest: pg_net is not installed, so the database cannot make an HTTP call. Enable it under Database > Extensions, then re-run this migration.';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-odds-cron-token', v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into v_req;

  -- Remember WHICH request this was. net._http_response is project wide and
  -- carries no URL, so without this the only way to find our response is
  -- "the newest row" — which in a project with any other pg_net traffic is
  -- somebody else's job, reported as ours.
  perform collective.odds_set_setting('ingest.last_request_id', to_jsonb(v_req));
  return v_req;
end $$;

-- Reads back what OUR call returned. pg_net is asynchronous: run_ingest()
-- hands back a request id immediately and the response lands a moment later.
--
-- Looked up BY THAT ID, never as "the newest row". net._http_response is
-- project wide and stores no URL, so on a project running any other pg_net
-- job — a scoreboard fetch, a scores backfill, anything on a cron — "newest"
-- is somebody else's response presented as this one's. That misreporting sent
-- a real debugging session chasing another function's 403.
create or replace function odds.last_ingest_response(p_request_id bigint default null)
returns jsonb language plpgsql security definer set search_path = odds, public as $$
declare
  v_id  bigint;
  v     jsonb;
begin
  -- Two nullifs, not one. An absent setting reaches here as the empty string,
  -- and ''::bigint raises — which the handler at the bottom would then report
  -- as "pg_net is not installed", sending the reader after the wrong problem.
  v_id := coalesce(
    p_request_id,
    nullif(nullif(trim(both '"' from coalesce((odds.get_setting('ingest.last_request_id'))::text, '')), ''), 'null')::bigint);

  if v_id is null then
    return jsonb_build_object(
      'note', 'odds.run_ingest() has not been called yet, so there is no request to look up');
  end if;

  select jsonb_build_object(
           'request_id', r.id, 'status_code', r.status_code,
           'created', r.created, 'timed_out', r.timed_out, 'error', r.error_msg,
           'body', left(coalesce(r.content, ''), 4000))
    into v
  from net._http_response r
  where r.id = v_id;

  if v is null then
    return jsonb_build_object(
      'request_id', v_id,
      'note', 'the request was sent but no response is recorded yet. pg_net is asynchronous — wait a few seconds and run this again. If it never appears, the call did not complete.');
  end if;
  return v;
exception
  when undefined_table or invalid_schema_name then
    return jsonb_build_object(
      'error', 'pg_net is not installed, so there is no response table to read. Enable it under Database > Extensions.');
  when others then
    -- Report what actually went wrong rather than a stock guess.
    return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end $$;

-- --------------------------------------------------------- the schedule

do $mig$
declare
  v_sched text;
begin
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'odds: could not create extension pg_net (%). Enable it under Database > Extensions.', sqlerrm;
  end;

  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'odds: could not create extension pg_cron (%). Enable it under Database > Extensions, then re-run this migration.', sqlerrm;
  end;

  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'odds: pg_cron unavailable; NOTHING IS SCHEDULED. Enable it and re-run.';
    return;
  end if;

  v_sched := trim(both '"' from coalesce((odds.get_setting('ingest.cron_schedule'))::text, '"*/30 * * * *"'));

  if exists (select 1 from cron.job where jobname = 'collective_nfl_odds') then
    perform cron.unschedule('collective_nfl_odds');
  end if;
  perform cron.schedule('collective_nfl_odds', v_sched, 'select odds.run_ingest();');
  raise notice 'odds: scheduled collective_nfl_odds at %', v_sched;
exception when others then
  raise notice 'odds: scheduling failed (%). The pipeline still works; it just has nothing driving it.', sqlerrm;
end $mig$;

-- ------------------------------------------- expose the provider on reads
--
-- Re-issued verbatim from the base migration with one field added, so the
-- edge function can stop naming a provider from a constant.

create or replace function collective.odds_status(p_league text default 'nfl')
returns jsonb language sql stable security definer set search_path = odds, collective, public as $$
  select jsonb_build_object(
    'league', p_league,
    -- last_poll_at: the feed is current as of this moment.
    -- last_odds_at: a price last changed at this moment. A quiet market is
    -- not a stale feed, so freshness is judged on the first.
    'last_poll_at',   odds.last_poll_at(),
    'last_odds_at',   (select max(captured_at) from odds.snapshots),
    'provider',       odds.last_poll_provider(),
    'stale_after_seconds', coalesce((odds.get_setting('nfl.stale_after_seconds'))::text::int, 900),
    'events_upcoming', (select count(*) from odds.events
                        where league = p_league and commence_time > now()),
    'events_live',     (select count(*) from odds.events
                        where league = p_league and is_live),
    'books_current',   (select count(distinct book_id) from odds.current_main),
    'snapshots_total', (select count(*) from odds.snapshots),
    'last_run', (select to_jsonb(r) - 'unmatched' from odds.ingest_runs r
                 order by started_at desc limit 1)
  );
$$;

create or replace function collective.odds_board(
  p_league text default 'nfl',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_include_books boolean default true,
  p_limit integer default 40
) returns jsonb language sql stable security definer set search_path = odds, collective, public as $$
  select jsonb_build_object(
    'league', p_league,
    'generated_at', now(),
    'last_poll_at', odds.last_poll_at(),
    'last_odds_at', (select max(s.captured_at) from odds.snapshots s
                     join odds.events e on e.id = s.event_id where e.league = p_league),
    'provider', odds.last_poll_provider(),
    'stale_after_seconds',
      coalesce((odds.get_setting('nfl.stale_after_seconds'))::text::int, 900),
    'games', coalesce((
      select jsonb_agg(odds.event_payload(e.id, p_include_books) order by e.commence_time)
      from (
        select id, commence_time from odds.events
        where league = p_league
          and (p_from is null or commence_time >= p_from)
          and (p_to   is null or commence_time <= p_to)
        order by commence_time
        limit greatest(1, least(coalesce(p_limit, 40), 200))
      ) e), '[]'::jsonb));
$$;

-- ------------------------------------------------------------ privileges
--
-- Postgres grants EXECUTE to PUBLIC on every new function by default, and
-- these are SECURITY DEFINER, so a function created above without this block
-- is an anon-callable back door into the odds schema. Re-run over everything
-- the base migration covers, because create-or-replace does not restore the
-- grants the base migration set.

do $mig$
declare r record; has_sr boolean;
begin
  select exists (select 1 from pg_roles where rolname = 'service_role') into has_sr;
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'odds')
       or (n.nspname = 'collective' and p.proname like 'odds\_%')
  loop
    execute format('revoke all on function %s from public', r.sig);
    if has_sr then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;
end $mig$;

commit;
