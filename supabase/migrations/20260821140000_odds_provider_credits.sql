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
