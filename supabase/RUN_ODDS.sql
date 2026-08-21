-- Paste into the Supabase SQL editor. No terminal, no curl, no keys to handle.
--
-- Run migrations 20260821090000 and 20260821140000 FIRST.

-- =========================================================================
-- 1. WHERE AM I?  Run this alone first. It answers every question at once.
-- =========================================================================

select
  trim(both '"' from (odds.get_setting('provider.default'))::text)  as provider,
  (select count(*) from odds.providers
    where id = trim(both '"' from (odds.get_setting('provider.default'))::text))
                                                                    as provider_registered,
  (select count(*) from odds.ingest_runs)                           as runs_total,
  (select count(*) from odds.ingest_runs where status in ('ok','partial'))
                                                                    as runs_succeeded,
  odds.last_poll_at()                                               as last_poll,
  (select count(*) from odds.snapshots)                             as prices_stored,
  (select count(*) from pg_extension where extname='pg_net')         as pg_net_on,
  (select count(*) from pg_extension where extname='pg_cron')        as pg_cron_on,
  (select count(*) from cron.job where jobname='collective_nfl_odds') as scheduled;

-- How to read it:
--   provider_registered = 0  -> the migration did not finish. Re-run it.
--   runs_total       = 0     -> nothing has EVER called the function. Go to 2.
--   runs_succeeded   = 0     -> it was called and failed. Go to 3, read the error.
--   prices_stored    = 0 but runs_succeeded > 0 -> it polled and mapped nothing. Go to 4.
--   pg_net_on / pg_cron_on = 0 -> enable under Database > Extensions, re-run migration.
--   scheduled        = 0     -> nothing recurring. Re-run the migration after enabling pg_cron.


-- =========================================================================
-- 2. RUN ONE INGEST RIGHT NOW
-- =========================================================================

select odds.run_ingest();          -- returns a request id immediately
-- select odds.run_ingest(true);   -- same, but skips the cadence throttle.
--                                 Use this while setting up: the idle cadence
--                                 is 12h, so an unforced retry right after a
--                                 change returns "skipped: too_soon" without
--                                 ever reaching the provider — which tells you
--                                 nothing about whether the change worked.

-- Wait ~5 seconds, then ask the question that has ONE right answer:
-- did our function run? odds.ingest_runs is written by our function and
-- nothing else, so it cannot be confused with another job's activity.

select id, provider, trigger, status, started_at, finished_at,
       books_ok, events_seen, snapshots_written,
       error_code, left(coalesce(error_message,''), 300) as error_message
from odds.ingest_runs
order by id desc
limit 3;

--   a row with status ok or partial  -> IT WORKED. Go to 5.
--   a row with status error          -> read error_message, that is the cause.
--   NO ROW AT ALL                    -> the request never reached the function.
--                                       Check the HTTP response below.

-- The raw HTTP response, looked up by OUR request id. Do not read
-- net._http_response directly and take the newest row: that table is project
-- wide and carries no URL, so on a project with any other pg_net job the
-- newest row is somebody else's response wearing ours.
select odds.last_ingest_response();

--   status_code 200                  -> the function ran; ingest_runs has the detail.
--   status_code 401                  -> the DEPLOYED function predates the cron token.
--                                       Redeploy collective_odds_ingest.
--   status_code 404                  -> ingest.function_url points at the wrong route.
--   status_code 503 not_configured   -> NFL_ODDS_API_KEY missing on the function.
--   "no response is recorded yet"    -> pg_net has not finished. Wait, run again.

--   body "skipped": "too_soon"       -> throttled, not broken. It never reached
--                                       the provider. Force one:
--     select odds.run_ingest(true);


-- =========================================================================
-- 3. WHAT DID THE LAST RUN SAY?
-- =========================================================================

select id, provider, trigger, status, started_at, finished_at,
       books_ok, books_failed, events_seen, snapshots_written,
       error_code, left(coalesce(error_message,''), 400) as error_message
from odds.ingest_runs
order by id desc
limit 5;


-- =========================================================================
-- 4. IT POLLED BUT STORED NOTHING — what could it not read?
-- =========================================================================
-- unmatched.provider_rows carries the KEY NAMES of every row the adapter
-- refused, so a wire-format change is diagnosable without guessing.

select id, status,
       jsonb_pretty(coalesce(unmatched, '{}'::jsonb)) as unmatched
from odds.ingest_runs
where status in ('ok','partial','error')
order by id desc
limit 2;


-- =========================================================================
-- 5. DID IT ACTUALLY LAND?
-- =========================================================================

select e.away_code || ' @ ' || e.home_code as game,
       e.commence_time,
       count(distinct c.book_id) as books,
       count(*)                  as prices
from odds.events e
left join odds.current_main c on c.event_id = e.id
where e.league = 'nfl'
group by 1, 2
order by e.commence_time
limit 20;

-- And what the site itself will now render:
select jsonb_pretty(collective.odds_status('nfl'));


-- =========================================================================
-- 6. CREDIT BUDGET
-- =========================================================================

select jsonb_pretty(odds.get_setting('provider.quota')) as last_reported_balance,
       trim(both '"' from (odds.get_setting('ingest.cron_schedule'))::text) as schedule,
       (odds.get_setting('provider.credit_reserve'))::text as reserve;

-- Change how often it polls (takes effect on the next fire, no redeploy):
--   select cron.unschedule('collective_nfl_odds');
--   select cron.schedule('collective_nfl_odds','*/15 * * * *','select odds.run_ingest();');
--
-- The function throttles itself to nfl.refresh_seconds.* and to the credit
-- reserve regardless, so scheduling more often than needed costs nothing: an
-- early call returns "skipped" without touching the provider.
