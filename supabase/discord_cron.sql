-- ============================================================================
-- THE DISCORD SCHEDULES — pg_cron poking the discord_cron edge function.
--
-- WHAT THIS SCHEDULES (all times America/Chicago; pg_cron runs in UTC).
--   discord_scorecard  Mondays 10:00 CT: the weekly CLV scorecard to
--                      #clv-results (per sport, the past 7 days and the
--                      season, plus the free-sample record).
--   discord_slate      daily 10:00 CT: the slate to each sport's channel, on
--                      days with games; skipped and logged when there are no
--                      games or a data sync failed.
--   discord_samples    every 15 minutes: records new INVESTIGATE / MONITOR
--                      sightings, makes each CFB / NFL slate's sample
--                      selection (from 08:00 CT), posts samples when due and
--                      posts the follow-up after each sampled game closes.
--
-- CENTRAL TIME AND DST. 10:00 CT is 15:00 UTC under daylight time and 16:00
-- UTC under standard time, so the scorecard and slate jobs fire at :00 and :30
-- in BOTH UTC hours and the function decides, from the America/Chicago zone
-- database, whether it is the 10 o'clock hour there. The other hour answers
-- not_due. The :30 tick is the retry: a slate skipped at 10:00 because a sync
-- was late is tried once more. Nothing is posted twice either way: every post
-- is claimed per type, channel and date (supabase/discord.sql).
--
-- HOW THE CALL IS AUTHENTICATED. As capture_cron.sql: a security-definer
-- wrapper reads the Vault secret discord_cron_secret and sends it as the
-- x-cron-secret header; the function compares it with its own
-- DISCORD_CRON_SECRET. The function is deployed with --no-verify-jwt (pg_cron
-- sends no JWT), so without that header it posts nothing.
--
-- OPERATOR STEPS.
--   1  Enable pg_cron and pg_net (Database -> Extensions).
--   2  Run supabase/discord.sql and supabase/discord_samples.sql.
--   3  Deploy the function:  supabase functions deploy discord_cron --no-verify-jwt
--   4  Set the function's secrets (docs/discord/README.md has the commands),
--      including DISCORD_CRON_SECRET, and put the SAME value in Vault:
--        select vault.create_secret('<value>', 'discord_cron_secret');
--   5  Run this file. Re-running replaces the jobs rather than adding more.
-- Without step 4 every poke raises "Vault discord_cron_secret is missing".
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout). Enable or upgrade it (Database -> Extensions).';
  end if;
  if to_regclass('public.discord_posts') is null or to_regclass('public.discord_samples') is null then
    raise exception 'Apply supabase/discord.sql and supabase/discord_samples.sql first: discord_cron logs, claims and samples through them.';
  end if;
end $$;

create or replace function public.discord_poke(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
begin
  if p_action is null or p_action not in ('scorecard', 'slate', 'samples') then
    raise exception 'discord_poke: action must be scorecard, slate or samples';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'discord_cron_secret';
  if nullif(v_secret, '') is null then
    raise exception 'discord_poke: Vault discord_cron_secret is missing -- nothing was sent. Set it to the function''s DISCORD_CRON_SECRET.';
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/discord_cron',
    body                 := jsonb_build_object('source', 'supabase_cron', 'action', p_action),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 150000
  ) into v_req;
  return jsonb_build_object('queued', true, 'action', p_action, 'request_id', v_req);
end $fn$;
revoke all on function public.discord_poke(text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.discord_poke(text) from service_role';
  end if;
end $g$;

select cron.unschedule('discord_scorecard') where exists (select 1 from cron.job where jobname = 'discord_scorecard');
select cron.unschedule('discord_slate')     where exists (select 1 from cron.job where jobname = 'discord_slate');
select cron.unschedule('discord_samples')   where exists (select 1 from cron.job where jobname = 'discord_samples');

select cron.schedule('discord_scorecard', '0,30 15,16 * * 1', $job$ select public.discord_poke('scorecard'); $job$);
select cron.schedule('discord_slate',     '0,30 15,16 * * *', $job$ select public.discord_poke('slate'); $job$);
select cron.schedule('discord_samples',   '4,19,34,49 * * * *', $job$ select public.discord_poke('samples'); $job$);

-- THE REPORT. Every row should say ok. Whether the pokes ARRIVE is proven by
-- the function's answers, not here:
--   select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 10;
--   select * from public.discord_posts order by sent_at desc limit 20;
with checks as (
  select 1 as n, 'discord_scorecard: Mondays at :00 and :30, 15:00-16:59 UTC (10:00 CT under CDT and CST)' as check_name,
         (select count(*) from cron.job where jobname = 'discord_scorecard' and schedule = '0,30 15,16 * * 1' and active)::int as got, 1 as want
  union all select 2, 'discord_slate: daily at :00 and :30, 15:00-16:59 UTC',
         (select count(*) from cron.job where jobname = 'discord_slate' and schedule = '0,30 15,16 * * *' and active)::int, 1
  union all select 3, 'discord_samples: every 15 minutes',
         (select count(*) from cron.job where jobname = 'discord_samples' and schedule = '4,19,34,49 * * * *' and active)::int, 1
  union all select 4, 'each job calls discord_poke, which no API role can call',
         (select count(*) from cron.job where jobname in ('discord_scorecard', 'discord_slate', 'discord_samples')
            and command like '%public.discord_poke(%')::int
         + (case when not has_function_privilege('anon', 'public.discord_poke(text)', 'execute')
                  and not has_function_privilege('authenticated', 'public.discord_poke(text)', 'execute')
                 then 1 else 0 end), 4
  union all select 5, 'the Vault secret discord_cron_secret is present',
         (select count(*) from vault.secrets where name = 'discord_cron_secret')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
