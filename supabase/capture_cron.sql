-- Odds capture scheduler. Production uses a dedicated Vault credential.
-- Set Vault capture_cron_secret to the deployed capture function's CRON_SECRET.
-- GitHub's CAPTURE_CRON_SECRET must independently match that same credential.
-- Missing credentials raise an error instead of reporting a successful no-op.
-- HTTP requests are asynchronous: queued=true is NOT proof of capture success.
-- Inspect net._http_response using the returned request_id.
-- The function implements x-cron-secret authentication and has verify_jwt=false;
-- a service-role credential is not needed by this caller.
--
-- 2026-10-10 (docs/odds-api-incident-2026-10/INCIDENT.md): THESE ARE POKES,
-- NOT PURCHASES. Capture buys nothing itself any more: every board goes
-- through supabase/functions/odds_gateway, which serves the stored snapshot
-- until the sport's event-aware cadence is due (20 min inside 3 h of its next
-- kickoff, 60 min inside 24 h, 2 h inside 72 h, 6 h beyond), applies the shared
-- credit budget and the circuit breaker, and only then buys. The cadences were
-- loosened to the gateway's tightest interval (near 10 -> 20 min, day 30 ->
-- 60 min, board 4 -> 6 h), and a poke sends nothing while the breaker is off.
-- Re-running this file re-creates the jobs ACTIVE: if the emergency stop is in
-- force, run public.odds_api_emergency_stop(...) again afterwards (it pauses
-- them and records them for public.odds_api_resume_schedules()).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.capture_poke(p_tier text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
begin
  if p_tier is null or p_tier not in ('near', 'day', 'board') then
    raise exception 'capture_poke: invalid tier';
  end if;
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'capture_cron_secret';
  if nullif(v_secret, '') is null then
    raise exception 'capture_poke: Vault capture_cron_secret is missing -- nothing was sent. Set it in Vault before this schedule can call capture.';
  end if;
  -- The Odds API circuit breaker (supabase/odds_api_gateway.sql). Off, the
  -- gateway would refuse every board anyway; not waking capture saves the run.
  if to_regprocedure('public.odds_api_enabled()') is not null then
    if not public.odds_api_enabled() then
      return jsonb_build_object('queued', false, 'tier', p_tier, 'reason', 'odds_api_enabled is false: capture not woken');
    end if;
  end if;
  select net.http_post(
    url := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/capture?tier=' || p_tier,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('source', 'supabase_cron', 'tier', p_tier),
    timeout_milliseconds := 180000
  ) into v_req;
  return jsonb_build_object('queued', true, 'tier', p_tier, 'request_id', v_req);
end $fn$;
revoke all on function public.capture_poke(text) from public, anon, authenticated;

select cron.unschedule('capture_near') where exists (select 1 from cron.job where jobname = 'capture_near');
select cron.unschedule('capture_day') where exists (select 1 from cron.job where jobname = 'capture_day');
select cron.unschedule('capture_board') where exists (select 1 from cron.job where jobname = 'capture_board');

-- CADENCE CONTRACT: must match CADENCE_TIERS in capture/index.ts.
select cron.schedule('capture_near', '*/20 * * * *', $job$ select public.capture_poke('near'); $job$);
select cron.schedule('capture_day', '4 * * * *', $job$ select public.capture_poke('day'); $job$);
select cron.schedule('capture_board', '18 */6 * * *', $job$ select public.capture_poke('board'); $job$);

select jobname, schedule, active from cron.job
where jobname in ('capture_near', 'capture_day', 'capture_board');
select exists(select 1 from vault.secrets where name = 'capture_cron_secret') as capture_credential_present;
