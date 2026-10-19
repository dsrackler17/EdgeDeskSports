-- ===========================================================================
-- THE DESK'S SCHEDULE — pg_cron pokes supabase/functions/desk_cron.
--
-- Paste into the Supabase SQL editor after supabase/desk_articles.sql and
-- after deploying the function. Safe to run again.
--
--   desk_generate  daily 14:23 UTC (09:23 Central under CDT): asks GitHub to
--                  run desk-drafts.yml, which drafts whatever is due. Drafting
--                  twice is harmless: an unchanged draft adds no row.
--   desk_notify    every 30 minutes: tells the owner about drafts that have
--                  not been announced (Discord DM, owner webhook, or the
--                  dashboard badge alone).
--
-- BEFORE RUNNING: store the shared secret in Vault, the same value as the
-- function's DESK_CRON_SECRET:
--   select vault.create_secret('<a long random string>', 'desk_cron_secret');
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout).';
  end if;
  if to_regclass('public.article_drafts') is null then
    raise exception 'Apply supabase/desk_articles.sql first.';
  end if;
end $$;

create or replace function public.desk_poke(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_secret text;
  v_req bigint;
begin
  if p_action is null or p_action not in ('generate', 'notify') then
    raise exception 'desk_poke: action must be generate or notify';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'desk_cron_secret';
  if nullif(v_secret, '') is null then
    raise exception 'desk_poke: Vault desk_cron_secret is missing -- nothing was sent. Set it to the function''s DESK_CRON_SECRET.';
  end if;
  select net.http_post(
    url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/desk_cron',
    body                 := jsonb_build_object('source', 'supabase_cron', 'action', p_action),
    headers              := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000
  ) into v_req;
  return jsonb_build_object('queued', true, 'action', p_action, 'request_id', v_req);
end $fn$;
revoke all on function public.desk_poke(text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.desk_poke(text) from service_role';
  end if;
end $g$;

select cron.unschedule('desk_generate') where exists (select 1 from cron.job where jobname = 'desk_generate');
select cron.unschedule('desk_notify')   where exists (select 1 from cron.job where jobname = 'desk_notify');

select cron.schedule('desk_generate', '23 14 * * *',  $job$ select public.desk_poke('generate'); $job$);
select cron.schedule('desk_notify',   '7,37 * * * *', $job$ select public.desk_poke('notify'); $job$);

with checks as (
  select 1 as n, 'desk_generate: daily 14:23 UTC' as check_name,
         (select count(*) from cron.job where jobname = 'desk_generate' and schedule = '23 14 * * *' and active)::int as got, 1 as want
  union all select 2, 'desk_notify: every 30 minutes',
         (select count(*) from cron.job where jobname = 'desk_notify' and schedule = '7,37 * * * *' and active)::int, 1
  union all select 3, 'each job calls desk_poke, which no API role can call',
         (select count(*) from cron.job where jobname in ('desk_generate', 'desk_notify') and command like '%public.desk_poke(%')::int
         + (case when not has_function_privilege('anon', 'public.desk_poke(text)', 'execute')
                  and not has_function_privilege('authenticated', 'public.desk_poke(text)', 'execute')
                 then 1 else 0 end), 3
  union all select 4, 'the Vault secret desk_cron_secret is present',
         (select count(*) from vault.secrets where name = 'desk_cron_secret')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;
