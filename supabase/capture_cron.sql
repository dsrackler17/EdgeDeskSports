-- ============================================================================
-- THE ODDS CAPTURE SCHEDULER — pg_cron calling the `capture` edge function on
-- three cadences.
--
-- WHY THIS FILE EXISTS. `supabase/functions/capture/index.ts` has said
-- "TYPE: Edge Function (deployed) - cron job" at the top since it was written.
-- There was no cron. Not in this repository, not in pg_cron, not in GitHub
-- Actions -- a search of .github/workflows for anything that invokes capture
-- returns nothing. The function is the most carefully built thing in the
-- estate and nothing has been calling it.
--
-- THE COST OF THAT, MEASURED. On 2026-09-14 a customer asked EdgeDesk about a
-- college football game and was shown a FanDuel quote captured 2,345 minutes
-- earlier -- thirty-nine hours. The answer opened by warning them the price
-- was provisional, which was honest and useless: a research product whose
-- prices are a day and a half old is a history product. Everything downstream
-- was working correctly. The board was empty because nothing filled it.
--
-- ---------------------------------------------------------------------------
-- WHY pg_cron AND NOT GITHUB ACTIONS
--
-- Because GitHub's scheduler does not fire reliably for this repository, and
-- that is measured rather than assumed: on 2026-09-13 every scheduled workflow
-- here showed the same ~4.5 hour gap, settle-finals included, which is hourly.
-- supabase/editorial_cron.sql documents the same finding and reaches the same
-- conclusion. A price whose whole value is that it is current cannot be built
-- on a scheduler that skips four hours.
--
-- .github/workflows/capture.yml is the BACKUP and is deliberately kept: two
-- independent schedulers, one idempotent job. A duplicate capture costs one
-- odds request and writes the same rows.
--
-- ---------------------------------------------------------------------------
-- THE THREE CADENCES, AND WHY EACH ONE IS THE NUMBER IT IS
--
-- The reader (edgedesk_ai/_intelligence.js, `quote_ttl_buckets`) decides how
-- old a price may be from HOW CLOSE THE GAME IS: 5 minutes inside half an hour
-- of kickoff, 15 inside two hours, 45 inside six, 90 inside a day, 180 inside
-- three days, 360 beyond. Those are the same numbers capture enforces on the
-- write side. A cadence is chosen to sit inside the rung it feeds.
--
--   near   */10      Sports with an event inside 8 hours. On a day with none,
--                    this costs the FREE event index per sport and not one
--                    billed request -- which is what makes a ten-minute
--                    cadence affordable at all.
--   day    4,34      Anything kicking off inside 30 hours: the board somebody
--                    researches the night before and the morning of. Thirty
--                    minutes sits inside the 45-minute rung.
--   board  18 */4    The whole 14-day horizon, nothing skipped. Four hours
--                    sits inside the 360-minute rung with room. Every sport
--                    costs a billed request here, which is why it is six runs
--                    a day and not sixty.
--
-- WHAT THIS DOES NOT COVER, SAID PLAINLY. A ten-minute cadence cannot keep a
-- price inside the five-minute rung that applies within half an hour of
-- kickoff. In that window EdgeDesk does not know the current number to the
-- accuracy it requires before calling anything actionable, and the reader
-- reports those quotes as aging rather than presenting them as current. That
-- is the system working. To close it, change the `near` schedule to '*/5' AND
-- change CADENCE_TIERS.near.cadenceMin in the function to 5 -- the test suite
-- fails if you change one without the other. It doubles the billed requests in
-- every hour that has a game inside eight hours, so make it with the quota
-- number in front of you: every run reports `quota_remaining`.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS. This file cannot complete itself.
--
--   1  Enable the extensions (dashboard -> Database -> Extensions):
--          pg_cron   scheduling
--          pg_net    outbound HTTP from the database
--
--   2  Deploy the function, if it is not already deployed:
--          supabase functions deploy capture --no-verify-jwt
--
--   3  Tell the DATABASE the three things the job body reads. None of them is
--      in this file, and none of them should ever be:
--          alter database postgres set edgedesk.project_url = 'https://<project>.supabase.co';
--          alter database postgres set edgedesk.service_key = '<service-role-key>';
--          alter database postgres set edgedesk.cron_secret = '<the same value as the function''s CRON_SECRET>';
--
--      `edgedesk.cron_secret` must equal the CRON_SECRET the function itself
--      holds (`supabase secrets list`). Capture refuses every caller whose
--      x-cron-secret header does not match, INCLUDING its own scheduler, and
--      says so in the 401 body rather than failing quietly. If capture has
--      been deployed without CRON_SECRET set, every one of these runs will be
--      refused until it is -- check with the verification block at the bottom
--      of this file, which reports what the database holds without printing
--      any of it.
--
--   4  Run this file.
--
-- Idempotent: re-running replaces each schedule rather than adding a second.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception
      'pg_cron is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb)') is null then
    raise exception
      'pg_net is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE JOB BODY, WRITTEN ONCE.
--
-- Every schedule below calls this with its own tier, so a cadence change is a
-- cron expression and nothing else, and the three jobs cannot drift apart in
-- how they authenticate or what they send.
--
-- SECURITY DEFINER because the settings it reads are database-level and the
-- caller is the cron worker. It takes no user input: the tier is one of three
-- literals supplied by the schedules in this file, and it is checked against
-- that list before it reaches a URL.
--
-- The call is fire-and-forget by design -- pg_net queues the request and
-- returns immediately -- so a slow odds API can never hold a database worker
-- open past its cadence.
-- ---------------------------------------------------------------------------
create or replace function public.capture_poke(p_tier text)
returns jsonb
language plpgsql
security definer
set search_path = public, net, pg_temp
as $fn$
declare
  v_url    text := nullif(current_setting('edgedesk.project_url', true), '');
  v_key    text := nullif(current_setting('edgedesk.service_key', true), '');
  v_secret text := nullif(current_setting('edgedesk.cron_secret', true), '');
  v_req    bigint;
begin
  if p_tier is null or p_tier not in ('near', 'day', 'board') then
    raise warning 'capture_poke: unknown tier %; nothing was sent.', p_tier;
    return jsonb_build_object('ok', false, 'reason', 'unknown tier');
  end if;

  -- A missing setting is reported as a missing setting. It is never treated as
  -- a reason to send the request anyway and let the function decide, because
  -- an unauthenticated capture is a 401 that looks exactly like a working
  -- schedule in the pg_cron log.
  if v_url is null or v_key is null or v_secret is null then
    raise warning 'capture_poke(%): missing % -- nothing was sent. See supabase/capture_cron.sql step 3.',
      p_tier,
      concat_ws(', ',
        case when v_url    is null then 'edgedesk.project_url' end,
        case when v_key    is null then 'edgedesk.service_key' end,
        case when v_secret is null then 'edgedesk.cron_secret' end);
    return jsonb_build_object('ok', false, 'reason', 'a required database setting is not set');
  end if;

  select net.http_post(
    url     := v_url || '/functions/v1/capture?tier=' || p_tier,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'authorization', 'Bearer ' || v_key,
                 'x-cron-secret', v_secret
               ),
    body    := jsonb_build_object('source', 'supabase_cron', 'tier', p_tier)
  ) into v_req;

  return jsonb_build_object('ok', true, 'tier', p_tier, 'request_id', v_req);
end
$fn$;

revoke all on function public.capture_poke(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- THE THREE SCHEDULES.
-- ---------------------------------------------------------------------------
select cron.unschedule('capture_near')  where exists (select 1 from cron.job where jobname = 'capture_near');
select cron.unschedule('capture_day')   where exists (select 1 from cron.job where jobname = 'capture_day');
select cron.unschedule('capture_board') where exists (select 1 from cron.job where jobname = 'capture_board');

-- CADENCE CONTRACT: these three expressions must agree with
-- CADENCE_TIERS[tier].cadenceMin in supabase/functions/capture/index.ts.
-- tools/capture/capture.test.js parses this file and fails if they do not, so
-- a cadence can never be changed here alone and leave the function describing
-- a schedule it is not on.
select cron.schedule('capture_near',  '*/10 * * * *', $job$ select public.capture_poke('near');  $job$);
select cron.schedule('capture_day',   '4,34 * * * *', $job$ select public.capture_poke('day');   $job$);
select cron.schedule('capture_board', '18 */4 * * *', $job$ select public.capture_poke('board'); $job$);

-- ---------------------------------------------------------------------------
-- VERIFICATION. Reports whether each precondition is met WITHOUT printing any
-- secret -- `set` or `NOT SET`, never the value.
-- ---------------------------------------------------------------------------
do $$
declare
  u text := nullif(current_setting('edgedesk.project_url', true), '');
  k text := nullif(current_setting('edgedesk.service_key', true), '');
  c text := nullif(current_setting('edgedesk.cron_secret', true), '');
  j record;
begin
  raise notice '--- odds capture scheduler ---';
  for j in select jobname, schedule from cron.job
            where jobname in ('capture_near', 'capture_day', 'capture_board') order by jobname loop
    raise notice '  job           : % (%)', j.jobname, j.schedule;
  end loop;
  if not exists (select 1 from cron.job where jobname like 'capture\_%') then
    raise notice '  job           : NONE SCHEDULED -- the statements above did not take';
  end if;
  raise notice '  project_url   : %', coalesce(u, 'NOT SET -- every run will be skipped');
  raise notice '  service_key   : %', case when k is null then 'NOT SET -- every run will be skipped' else 'set' end;
  raise notice '  cron_secret   : %', case when c is null then 'NOT SET -- every run will be skipped' else 'set' end;
  raise notice '  reminder      : edgedesk.cron_secret must EQUAL the function''s own CRON_SECRET,';
  raise notice '                  or capture answers 401 to its own scheduler.';
  raise notice '  check a run   : select * from cron.job_run_details order by start_time desc limit 5;';
end $$;
