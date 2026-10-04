-- Schedule the daily NFL feature refresh
--
-- What runs: ingest_nfl_features (deployed, ACTIVE v3). It fetches the public
-- nflverse schedule and weekly team stats, replays the opponent-adjusted EPA
-- rating recursion, and upserts 32 rows into public.nfl_team_features - the
-- table model_predict's nfl_game_v1 module reads. Without it those features
-- go stale and the server-side NFL model has nothing current to predict from.
--
-- It authenticates with the existing CRON_SECRET and accepts it either as an
-- x-cron-secret header or a ?secret= query parameter, so it fits whichever
-- pattern your other crons already use.
--
-- STEP 1 changes nothing. Run it first.

-- ---------------------------------------------------------------- STEP 1
-- Three things: how your existing crons are written (copy the secret
-- mechanism from these, do not invent one), whether the target table exists,
-- and whether the scheduling extensions are installed.

select 'A existing cron jobs' as section,
       coalesce(j.jobname, j.jobid::text) as item,
       j.schedule || '   |   ' || left(j.command, 240) as detail
from cron.job j

union all

select 'B nfl_team_features table',
       coalesce(max(t.table_name), 'MISSING - apply football/sql/010 first'),
       coalesce(string_agg(c.column_name, ', ' order by c.ordinal_position), 'no columns')
from information_schema.tables t
left join information_schema.columns c
       on c.table_schema = t.table_schema and c.table_name = t.table_name
where t.table_schema = 'public' and t.table_name = 'nfl_team_features'

union all

select 'C extensions', e.extname, 'installed'
from pg_extension e
where e.extname in ('pg_cron','pg_net')

order by 1, 2;

-- Read the output before continuing:
--   B says MISSING  -> apply football/sql/010_nfl_team_features.sql first,
--                      or the job will compute correctly and fail on write.
--   A shows how each job passes CRON_SECRET. Mirror it exactly in STEP 2.
--   A also shows model_predict's schedule. Put this job BEFORE it so the
--      features are fresh when the model runs.

-- ---------------------------------------------------------------- STEP 0
-- Before scheduling anything, prove it works, read-only. In a browser or
-- curl, with your real secret. It computes everything and writes NOTHING:
--
--   https://iattxbkbufslbauoumga.supabase.co/functions/v1/ingest_nfl_features?dry=1&secret=YOUR_CRON_SECRET
--
-- Expect ok:true, a diag block, and "NOTHING was written." A 401 means
-- CRON_SECRET is not set on this function. A 422 means its own sanity gate
-- refused the batch - read sanity_failures rather than overriding it.

-- ---------------------------------------------------------------- STEP 2
-- Schedule it. Replace the headers argument with the same construction your
-- other jobs use, from STEP 1 section A, so the secret is handled the same
-- way here as everywhere else. Do not paste a literal secret if your other
-- jobs read it from a setting or from Vault.
--
-- 09:00 UTC daily = 4am CT: after the overnight nflverse refresh, before the
-- day's slate. Adjust so it lands before model_predict runs.

select cron.schedule(
  'ingest_nfl_features_daily',
  '0 9 * * *',
  $job$
    select net.http_post(
      url     := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/ingest_nfl_features',
      headers := jsonb_build_object(
                   'content-type',   'application/json',
                   'x-cron-secret',  current_setting('app.cron_secret', true)
                 ),
      timeout_milliseconds := 120000
    );
  $job$
);

-- ---------------------------------------------------------------- STEP 3
-- Confirm it is registered, and check runs after the first firing.

select jobid, jobname, schedule, active
from cron.job
where jobname = 'ingest_nfl_features_daily';

-- After it has fired at least once:
--   select jobid, status, return_message, start_time, end_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'ingest_nfl_features_daily')
--   order by start_time desc limit 5;
--
-- Rerunning STEP 2 with the same job name replaces the schedule rather than
-- creating a duplicate.
--
-- To remove: select cron.unschedule('ingest_nfl_features_daily');
--
-- Rollback beyond that: the job only writes public.nfl_team_features. Stop the
-- job and those rows simply stop refreshing; nothing else reads or writes it.
