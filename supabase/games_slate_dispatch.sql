-- ============================================================================
-- TODAY'S GAMES SLATE: A RELIABLE HALF-HOURLY WAKE-UP, FROM POSTGRES.
-- docs/research-compare/README.md ("Refresh")
--
-- WHY. games-slate.yml is scheduled at :07 and :37 every hour, but GitHub runs
-- scheduled workflows best-effort. Between 2026-10-28 and 2026-11-01 it ran
-- the slate 18 times instead of ~190: every 3.5 to 7.5 hours (13:11, 05:51,
-- 23:40, 20:15, 16:17 UTC …). Every price on the slate is read by that job,
-- so most of the Research Queue showed "past price, 2 h ago" or older: a real
-- data gap, not a display bug. The page now labels it honestly; this file is
-- what makes it current again.
--
-- WHAT IT DOES. Every 30 minutes (at :12 and :42, off the hour and off the
-- workflow's own cron minutes) it asks GitHub to run games-slate.yml on main
-- (workflow_dispatch, no inputs: the normal, cheap build). It never runs the
-- builder and never writes the slate:
--   - the builder already reads only the (feed, day) buckets that are due, so
--     an extra run costs a few requests and rewrites nothing that did not change;
--   - the workflow's concurrency group (games-slate, cancel-in-progress: false)
--     keeps two runs from overlapping; GitHub keeps at most one queued;
--   - tools/ci/push_generated.sh puts the slate on top of the remote tip, never
--     a rebase, so an older run cannot overwrite a newer commit's history;
--   - a poke inside the debounce window (default 10 minutes) is not sent.
-- Each decision is logged in public.games_slate_pokes (internal, not readable
-- by anon or authenticated) so "the scheduler is not firing" can be told apart
-- from "the build ran and found nothing to change".
--
-- INSTALL (Supabase SQL editor), after supabase/editorial_dispatch_sql.sql's
-- steps 1 and 2 (pg_cron and pg_net on; the GitHub token in Vault as
-- edgedesk_gh_token, a fine-grained PAT with "Actions: read and write" on this
-- repository only). Then run this whole file. Idempotent.
--
-- ROLL BACK:  select cron.unschedule('games_slate_dispatch');
-- Nothing else depends on it; GitHub's own schedule keeps running regardless.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not available. Enable it (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not available, or lacks net.http_post(url, body, params, headers, timeout). Enable or upgrade it (Database -> Extensions).';
  end if;
end $$;

-- every decision, one row: dispatched | debounced | no_token | error
create table if not exists public.games_slate_pokes (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  source      text not null,
  action      text not null check (action in ('dispatched', 'debounced', 'no_token', 'error')),
  reason      text,
  request_id  bigint
);
create index if not exists games_slate_pokes_at_idx on public.games_slate_pokes (at desc);
alter table public.games_slate_pokes enable row level security;
revoke all on public.games_slate_pokes from public, anon, authenticated;

create or replace function public.games_slate_poke(
  p_source           text    default 'supabase_cron',
  p_debounce_seconds integer default 600,
  p_repo             text    default 'dsrackler17/EdgeDeskSports',
  p_workflow         text    default 'games-slate.yml',
  p_ref              text    default 'main'
) returns jsonb
language plpgsql
security definer
set search_path = public, net, vault, pg_temp
as $fn$
declare
  v_token   text;
  v_last    timestamptz;
  v_request bigint;
  v_out     jsonb;
begin
  -- ONE AT A TIME. Two ticks (or a tick and a manual poke) racing each other
  -- would both pass the debounce; the transaction lock serialises them.
  perform pg_advisory_xact_lock(hashtext('games_slate_poke'));

  select max(at) into v_last from public.games_slate_pokes where action = 'dispatched';
  if v_last is not null and v_last > now() - make_interval(secs => p_debounce_seconds) then
    v_out := jsonb_build_object('ok', true, 'action', 'debounced',
      'reason', format('dispatched at %s, inside the %ss debounce', v_last, p_debounce_seconds));
    insert into public.games_slate_pokes (source, action, reason) values (p_source, 'debounced', v_out ->> 'reason');
    return v_out;
  end if;

  -- THE TOKEN: Vault first, then the database setting (editorial_dispatch_sql.sql's fallback).
  -- It is read here and sent to GitHub only; it is never logged or returned.
  begin
    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'edgedesk_gh_token';
  exception when others then
    v_token := null;
  end;
  if v_token is null or v_token = '' then
    v_token := nullif(current_setting('edgedesk.gh_token', true), '');
  end if;
  if v_token is null then
    -- a missing token is NOT a success: nothing would ever refresh, and it must not look healthy
    raise warning 'games_slate_poke: no GitHub token (vault secret edgedesk_gh_token or edgedesk.gh_token). Nothing was dispatched.';
    insert into public.games_slate_pokes (source, action, reason) values (p_source, 'no_token', 'no GitHub token in vault or settings');
    return jsonb_build_object('ok', false, 'action', 'no_token', 'reason', 'no GitHub token in vault or settings, so games-slate.yml cannot be dispatched');
  end if;

  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches', p_repo, p_workflow),
    body    := jsonb_build_object('ref', p_ref),
    headers := jsonb_build_object(
                 'authorization', 'Bearer ' || v_token,
                 'accept',        'application/vnd.github+json',
                 'content-type',  'application/json',
                 'user-agent',    'edgedesk-slate-cron'),
    timeout_milliseconds := 10000
  ) into v_request;

  insert into public.games_slate_pokes (source, action, reason, request_id)
  values (p_source, 'dispatched', format('%s on %s', p_workflow, p_ref), v_request);
  return jsonb_build_object('ok', true, 'action', 'dispatched', 'reason', format('%s dispatched on %s as %s', p_workflow, p_ref, p_source), 'request_id', v_request);
exception when others then
  return jsonb_build_object('ok', false, 'action', 'error', 'reason', sqlerrm);
end;
$fn$;

-- it reads a GitHub token and can start a workflow: never reachable from a browser
revoke all on function public.games_slate_poke(text, integer, text, text, text) from public, anon, authenticated;

-- keep the log short: a week is plenty to see whether the wake-up fires
create or replace function public.games_slate_pokes_prune()
returns integer language sql security definer set search_path = public, pg_temp as $f$
  with d as (delete from public.games_slate_pokes where at < now() - interval '7 days' returning 1) select count(*)::int from d;
$f$;
revoke all on function public.games_slate_pokes_prune() from public, anon, authenticated;

select cron.unschedule('games_slate_dispatch') where exists (select 1 from cron.job where jobname = 'games_slate_dispatch');
select cron.schedule('games_slate_dispatch', '12,42 * * * *',
  $job$ select public.games_slate_poke('supabase_cron'); select public.games_slate_pokes_prune(); $job$);

-- ---------------------------------------------------------------------------
-- VERIFY (SQL editor):
--   select public.games_slate_poke('manual');                 -- expect action dispatched
--   select status_code, content from net._http_response order by id desc limit 3;   -- 204 = accepted
--   select at, source, action, reason from public.games_slate_pokes order by at desc limit 10;
-- and on GitHub: Actions -> "Today's Games slate", event workflow_dispatch, every ~30 min.
-- ---------------------------------------------------------------------------
