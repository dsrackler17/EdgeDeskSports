-- ============================================================================
-- EdgeDesk cron audit + fix — 2026-08-12
--
-- Run PART A first and read the output. It answers the open questions before
-- you change anything. PART B is the fix. Do not run B blind.
--
-- No credentials appear in this file by design. Everything reads from vault.
-- ============================================================================


-- ============================================================================
-- PART A — DIAGNOSTICS  (read-only, safe to run anytime)
-- ============================================================================

-- A1. Do the vault secrets exist? Jobs 86/87 silently produce a NULL header if
--     'service_role_key' is missing. Expect two rows.
select name, created_at, updated_at
from vault.decrypted_secrets
where name in ('service_role_key', 'cron_secret')
order by name;


-- A2. Do the SQL functions jobs 77/78/79 depend on actually exist?
--     Missing ones DO show up as errors in job_run_details (unlike HTTP 401s).
select n.nspname as schema, p.proname as function,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('invoke_edge', 'settle_and_recalibrate')
order by 1, 2;


-- A3. THE IMPORTANT ONE — actual HTTP status codes.
--     cron.job_run_details reports 'succeeded' even when the request 401s,
--     because net.http_post only enqueues. This is the only place the truth is.
--     Note: pg_net expires _http_response rows (default ~6h), so this shows the
--     recent window only. The url join is best-effort — http_request_queue rows
--     are deleted once processed, so url will be null for older responses.
select r.id,
       q.url,
       r.status_code,
       r.error_msg,
       r.timed_out,
       r.created,
       left(r.content, 300) as body_head
from net._http_response r
left join net.http_request_queue q on q.id = r.id
order by r.created desc
limit 200;


-- A4. Same data, collapsed — how many non-2xx in the retained window?
select coalesce(r.status_code::text, 'no-response') as status,
       count(*) as n,
       min(r.created) as first_seen,
       max(r.created) as last_seen
from net._http_response r
group by 1
order by n desc;


-- A5. SQL-level failures. This catches missing functions and vault errors.
--     It does NOT catch HTTP failures — that is A3's job.
select jobid, runid, job_pid, status, return_message, start_time, end_time
from cron.job_run_details
where status <> 'succeeded'
order by start_time desc
limit 100;


-- A6. Jobs that send no Authorization header at all. Each of these requires
--     verify_jwt = false on its function, or the gateway 401s before your code
--     runs. Cross-check the survivors against the dashboard function settings.
select jobid, jobname, schedule
from cron.job
where active
  and command not ilike '%Authorization%'
  and command ilike '%net.http_post%'
order by jobname;



-- ============================================================================
-- PART B — FIXES
--
-- Prerequisite: rotate the service-role key and the cron secret FIRST (both
-- were sitting in plaintext in cron.job.command), then store the new values:
--
--   select vault.create_secret('<new service role jwt>', 'service_role_key');
--   select vault.create_secret('<new cron secret>',      'cron_secret');
--
-- If they already exist, update instead:
--   select vault.update_secret(id, '<new value>')
--   from vault.secrets where name = 'service_role_key';
-- ============================================================================


-- ============================================================================
-- READ THIS BEFORE RUNNING ANY OF PART B
--
-- 1. PROVE BOTH VAULT SECRETS EXIST FIRST. Query A1. edge_call RAISES when one
--    is missing, so switching a job to it without checking converts a working
--    job into one that throws on every fire. Six jobs resolving through
--    edge_call proves `cron_secret` exists; it does NOT prove `service_role_key`
--    does. Those are two separate facts and they need two separate checks.
--
-- 2. NEVER REWRITE A WORKING JOB'S AUTH AND ITS SCHEDULE IN ONE STATEMENT.
--    If a job is firing successfully, its header shape is correct by
--    observation, whatever the audit thinks of it. Change the cadence alone,
--    confirm it still fires, and only then touch the headers — separately, one
--    job at a time, checking cron.job_run_details after each.
--
-- 3. THE BROKEN JOBS ARE THE ONES TO CONVERT. B2 targets the five that are
--    already failing, where edge_call cannot make anything worse. B3 and B6
--    touch jobs that already work; treat them with more caution, not less.
-- ============================================================================

-- B1. One helper for every edge call. Centralising this means the next key
--     rotation is one vault update instead of 35 job edits.
--
--     It sends BOTH auth forms: Bearer JWT satisfies the gateway whether or not
--     verify_jwt is on, and x-cron-secret satisfies the function's own gate.
--
--     It RAISES if a vault secret is missing. That is deliberate — it converts a
--     silent 401 into a loud failure that shows up in cron.job_run_details.
create or replace function public.edge_call(
  slug        text,
  body        jsonb default '{}'::jsonb,
  timeout_ms  int   default 120000,
  query       text  default null
) returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  jwt     text;
  secret  text;
  req_id  bigint;
begin
  select decrypted_secret into jwt
  from vault.decrypted_secrets where name = 'service_role_key';

  select decrypted_secret into secret
  from vault.decrypted_secrets where name = 'cron_secret';

  if jwt is null then
    raise exception 'edge_call(%): vault secret service_role_key is missing', slug;
  end if;
  if secret is null then
    raise exception 'edge_call(%): vault secret cron_secret is missing', slug;
  end if;

  select net.http_post(
    url := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/'
           || slug || coalesce('?' || query, ''),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || jwt,
      'x-cron-secret', secret
    ),
    body := body,
    timeout_milliseconds := timeout_ms
  ) into req_id;

  return req_id;
end;
$$;

revoke all on function public.edge_call(text, jsonb, int, text) from public, anon, authenticated;


-- B2. Repair the five jobs with malformed Authorization headers.
--     cron.schedule() upserts by jobname on pg_cron >= 1.4, so these replace
--     the existing jobs in place rather than creating duplicates.

select cron.schedule('mlb_sync_20min', '*/20 * * * *',
  $$select public.edge_call('mlb_sync', timeout_ms => 60000)$$);

select cron.schedule('weather_sync_hourly', '10 * * * *',
  $$select public.edge_call('weather_sync', timeout_ms => 60000)$$);

select cron.schedule('bullpen_sync_daily', '0 10,16 * * *',
  $$select public.edge_call('bullpen_sync', timeout_ms => 120000)$$);

-- learn-nightly: only keep this if nightly is the intent. See B4 — you are
-- currently running learn hourly via job 8 as well, and one of them is wrong.
select cron.schedule('learn-nightly', '0 8 * * *',
  $$select public.edge_call('learn', timeout_ms => 300000)$$);

-- ingest-mlb: CONFIRM THE SLUG FIRST. Job 87 posted to 'ingest_mlb' (underscore)
-- while job 77 invoked 'ingest-mlb' (hyphen). Only one is real. Fix the string
-- below to match the deployed function before running this line.
select cron.schedule('ingest-mlb', '*/30 * * * *',
  $$select public.edge_call('ingest_mlb', timeout_ms => 120000)$$);


-- B3. Restore capture to the intended cadence.
--
--     THIS LINE PREVIOUSLY ROUTED capture THROUGH edge_call AND TOOK IT DOWN.
--     capture was NOT broken — it was on the wrong cadence. It had been working
--     for months on `x-cron-secret` alone with NO Authorization header, which
--     means its function has verify_jwt disabled. Rewriting its auth in the same
--     statement that changed its schedule made one edit carry two risks, and the
--     risky half hit the most important job in the stack: edge_call RAISES when
--     a vault secret is missing, so every run threw before issuing any HTTP call
--     and the board went stale for hours.
--
--     A job that works keeps the header shape that works. Only the schedule
--     changes here. The secret still moves out of plaintext and into vault,
--     which was the actual security goal.
--
--     Raises capture from 24 to 144 runs/day — a cost decision, so run it
--     deliberately.
select cron.schedule('edgedesk_capture', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/capture',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    timeout_milliseconds := 120000)
$$);


-- B4. Remove duplicates. Uncomment the ones you have decided on.

-- settle runs at */5 (job 7) AND */15 (job 85). Drop the redundant one:
-- select cron.unschedule('settle-every-15min');

-- learn runs hourly (job 8) AND nightly (job 86, repaired in B2).
-- If nightly is correct, drop the hourly:
-- select cron.unschedule('edgedesk_learn');

-- MLB ingest runs via job 77 (invoke_edge, 0 12) AND job 87 (*/30).
-- If the */30 path is correct, drop the daily one:
-- select cron.unschedule('edgedesk-ingest');


-- B5. Missing job — market_residual, intended hourly, currently does not exist.
select cron.schedule('edgedesk_market_residual', '25 * * * *',
  $$select public.edge_call('market_residual', timeout_ms => 120000)$$);


-- B6. Cosmetic: job 9 has a trailing space inside its JWT literal. Repointing it
--     at the helper fixes that and de-hardcodes the service-role key.
select cron.schedule('edgedesk_capture_boards', '0 */6 * * *',
  $$select public.edge_call('capture_boards', timeout_ms => 120000)$$);


-- B7. Verify. Every job should now route through edge_call and no command
--     should contain a literal token.
select jobid, jobname, schedule, active,
       command ilike '%eyJhbGci%' as has_hardcoded_jwt,
       command ilike '%edge_call%' as uses_helper
from cron.job
where active
order by jobname;
