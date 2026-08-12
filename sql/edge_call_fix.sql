-- ============================================================================
--  edge_call_fix.sql
--
--  OUTAGE FIX. Run top to bottom. Idempotent. Safe to re-run.
--
--  WHAT BROKE
--    public.edge_call() required BOTH vault secrets and raised if either was
--    missing. It checks service_role_key FIRST, that secret does not exist, so
--    every call raised at line 14 before issuing any HTTP request:
--
--      ERROR: edge_call(capture): vault secret service_role_key is missing
--
--    Seven jobs are pointed at this helper, so seven jobs have been throwing on
--    every fire — including edgedesk_capture, which is why the board went stale.
--    Affected: 5 capture, 9 capture_boards, 81 mlb_sync, 82 weather_sync,
--    83 bullpen_sync, 86 learn-nightly, 87 ingest-mlb, 94 market_residual.
--
--  WHY THE REQUIREMENT WAS WRONG
--    These functions deploy with --no-verify-jwt and authorise on the
--    x-cron-secret header alone. capture's own source is explicit:
--
--      function authorized(req) {
--        return CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET;
--      }
--
--    No Authorization header is read. Making a service-role JWT mandatory
--    invented a dependency the functions do not have, then enforced it with a
--    RAISE — converting seven working jobs into seven that could not run.
--
--  THE FIX
--    cron_secret stays REQUIRED, because without it the call would 401 anyway
--    and a loud failure beats a silent one. service_role_key becomes OPTIONAL:
--    the Authorization header is attached when the secret exists and omitted
--    when it does not. No job definitions change; all seven pick this up on
--    their next scheduled fire.
-- ============================================================================


-- ---------------------------------------------------------------- 1. THE FIX
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
  -- REQUIRED. Every one of these functions gates on this header.
  select decrypted_secret into secret
  from vault.decrypted_secrets where name = 'cron_secret';

  -- OPTIONAL. Attached when present, omitted when absent. Never fatal.
  select decrypted_secret into jwt
  from vault.decrypted_secrets where name = 'service_role_key';

  if secret is null then
    raise exception
      'edge_call(%): vault secret cron_secret is missing. Create it with the same value as the CRON_SECRET env var on the edge functions: select vault.create_secret(''<value>'', ''cron_secret'');',
      slug;
  end if;

  select net.http_post(
    url := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/'
           || slug || coalesce('?' || query, ''),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', secret
               )
               || case
                    when jwt is null then '{}'::jsonb
                    else jsonb_build_object('Authorization', 'Bearer ' || jwt)
                  end,
    body := body,
    timeout_milliseconds := timeout_ms
  ) into req_id;

  return req_id;
end;
$$;

revoke all on function public.edge_call(text, jsonb, int, text) from public, anon, authenticated;


-- --------------------------------------------------- 2. IS cron_secret THERE?
-- The fix above still requires this one. If the query returns no row, the jobs
-- will now raise naming cron_secret instead — create it and they recover.
--   select vault.create_secret('<CRON_SECRET env value>', 'cron_secret');
select name, created_at
from vault.decrypted_secrets
where name in ('cron_secret', 'service_role_key')
order by name;


-- ------------------------------------------------------------- 3. FIRE IT NOW
-- Do not wait ten minutes for the schedule. This runs capture immediately and
-- returns a net request id; a raise here means the fix has not taken.
select public.edge_call('capture', timeout_ms => 120000) as capture_request_id;


-- ----------------------------------------------------------- 4. DID IT LAND?
-- Run ~15 seconds after step 3. pg_net is asynchronous, so the row appears
-- shortly after the request id is returned.
-- 200 = capture ran. 401 = the cron secret is wrong (not missing). 5xx = the
-- function itself errored, which is capture's problem, not the scheduler's.
select r.id, r.status_code, r.error_msg, r.created,
       left(r.content, 400) as body_head
from net._http_response r
order by r.created desc
limit 5;


-- ------------------------------------------------- 5. THE SCHEDULED RUN, LATER
-- Run ~10 minutes after step 1. Expect 'succeeded' and no return_message.
select jobid, status, return_message, start_time
from cron.job_run_details
where jobid in (5, 9, 81, 82, 83, 86, 87, 94)
  and start_time > now() - interval '20 minutes'
order by start_time desc
limit 20;


-- ----------------------------------------------- 6. AND THE BOARD ITSELF
-- The only check that matters. last_seen_at should be within a few minutes.
select max(last_seen_at) as newest_capture,
       round(extract(epoch from (now() - max(last_seen_at))) / 60) as minutes_stale,
       count(*) filter (where last_seen_at > now() - interval '15 minutes') as fresh_rows
from public.signals;
