-- =============================================================================
-- cfb_lab_cron — the primary scheduler of the CFB Live Model Lab.
--
-- WHAT IT IS
--   One pg_cron job and the poke it uses:
--     cfb_lab_hourly  '7 * * * *'     select public.cfb_lab_poke('hourly');
--                     asks GitHub to run .github/workflows/cfb-lab.yml on main
--                     with input mode=hourly (the checkpoint job: METRICS.md §2
--                     takes each checkpoint at the first run inside its window,
--                     so the lab needs a run every hour, and GitHub's own
--                     scheduler is the backup, not the clock).
--   cfb_lab_poke takes any short lower-case mode, so the other modes the
--   workflow accepts (run, report, verify) can be poked by hand.
--
-- WHY THERE IS NO LINES JOB. The repository ledger is the single source of
--   truth, and cfb_lab_market_lines in Postgres is filled only by its
--   insert-only mirror (football/cfb_lab/sync_supabase.js). A database job
--   deriving lines every 15 minutes would write rows with the same line_ids as
--   the ledger's (h(game_id, kind, book, market_type, rule_version)) and would
--   usually land first, so the mirror's ignore-duplicates would keep the
--   Postgres version wherever the two differ. They can: the ledger and the
--   database do not always hold the same quotes at the moment of derivation
--   (an Odds API event's earliest quotes reach Postgres before the lab has
--   mapped the event). public.cfb_lab_derive_lines stays in cfb_lab.sql,
--   parity-tested against fixtures/market_rules.json and useful ad hoc; this
--   file only UNSCHEDULES a cfb_lab_lines job an earlier install created.
--
-- DEPENDS ON supabase/cfb_lab.sql (refuses to run without it), pg_cron and
--   pg_net. Where either extension cannot be enabled the file does NOT fail: it
--   creates the poke, schedules nothing, and its report says what was skipped.
--
-- THE TOKEN. The same Vault secret as supabase/editorial_dispatch_sql.sql:
--   edgedesk_gh_token (a fine-grained PAT on this repository with
--   "Actions: read and write"), falling back to the database setting
--   edgedesk.gh_token. If editorial_dispatch_sql.sql is already set up there is
--   nothing to add. Otherwise, once, in the SQL editor:
--       select vault.create_secret('ghp_xxx', 'edgedesk_gh_token',
--         'GitHub PAT with actions:write, used to dispatch workflows');
--   A missing token is reported, never treated as success.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Re-running replaces the
-- function and the job rather than adding a second of either.
-- Tested by football/cfb_lab/sql.test.js (on a server without pg_cron).
-- =============================================================================

do $blk$
begin
  if to_regclass('public.cfb_lab_market_lines') is null
     or to_regprocedure('public.cfb_lab_derive_lines(timestamptz)') is null then
    raise exception 'cfb_lab_cron.sql needs supabase/cfb_lab.sql first (public.cfb_lab_market_lines and public.cfb_lab_derive_lines are missing)';
  end if;
  -- Enable the extensions where the server offers them. A server without them
  -- (or one that refuses) is reported below rather than failing the file.
  begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
      execute 'create extension if not exists pg_cron';
    end if;
  exception when others then
    raise notice 'cfb_lab_cron: pg_cron could not be enabled here (%); the schedule is skipped', sqlerrm;
  end;
  begin
    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      execute 'create extension if not exists pg_net';
    end if;
  exception when others then
    raise notice 'cfb_lab_cron: pg_net could not be enabled here (%); the hourly poke is skipped', sqlerrm;
  end;
end $blk$;

-- ------------------------------------------------------------------ the poke
-- Returns what it did: dispatched | no_token | error. pg_net is fire and
-- forget: 'dispatched' means queued; GitHub's answer lands in
-- net._http_response (204 = accepted, 401/403 = token, 404 = repo or workflow,
-- 422 = the workflow on main does not accept the `mode` input).
create or replace function public.cfb_lab_poke(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_token   text;
  v_request bigint;
begin
  if p_mode is null or p_mode !~ '^[a-z][a-z0-9_]{0,31}$' then
    return jsonb_build_object('ok', false, 'action', 'error', 'reason', 'mode must be a short lower-case word, e.g. hourly');
  end if;

  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_token using 'edgedesk_gh_token';
  exception when others then
    v_token := null;                          -- no Vault in this project
  end;
  if v_token is null or v_token = '' then
    v_token := nullif(current_setting('edgedesk.gh_token', true), '');
  end if;
  if v_token is null then
    raise warning 'cfb_lab_poke: no GitHub token. Set vault secret edgedesk_gh_token, or edgedesk.gh_token. Nothing was dispatched.';
    return jsonb_build_object('ok', false, 'action', 'no_token',
      'reason', 'no edgedesk_gh_token in vault and no edgedesk.gh_token setting, so cfb-lab.yml cannot be dispatched');
  end if;

  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return jsonb_build_object('ok', false, 'action', 'error', 'reason', 'pg_net is not installed: nothing was dispatched');
  end if;

  execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
    into v_request
    using 'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/cfb-lab.yml/dispatches',
          jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('mode', p_mode)),
          '{}'::jsonb,
          jsonb_build_object(
            'authorization', 'Bearer ' || v_token,
            'accept',        'application/vnd.github+json',
            'content-type',  'application/json',
            'user-agent',    'edgedesk-cfb-lab-cron'),
          10000;

  return jsonb_build_object('ok', true, 'action', 'dispatched',
    'reason', format('cfb-lab.yml dispatched on main with mode=%s', p_mode), 'request_id', v_request);
exception when others then
  return jsonb_build_object('ok', false, 'action', 'error', 'reason', sqlerrm);
end $fn$;

-- It reads a GitHub token and can start a workflow: no client role may call it.
revoke all on function public.cfb_lab_poke(text) from public;
do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.cfb_lab_poke(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.cfb_lab_poke(text) from authenticated';
  end if;
end $blk$;

comment on function public.cfb_lab_poke(text) is
  'Asks GitHub to run cfb-lab.yml on main with input mode=p_mode. Reports a missing token or a missing pg_net instead of returning success. Never runs the lab itself.';

-- -------------------------------------------------------------- the schedule
-- Unschedule-if-exists, then schedule, so a re-run replaces the hourly job;
-- cfb_lab_lines (an earlier install's database-side lines job) is only
-- unscheduled. Dynamic SQL, so a server without pg_cron parses this file and
-- skips the block.
do $blk$
declare
  v_has_cron boolean := to_regprocedure('cron.schedule(text,text,text)') is not null and to_regclass('cron.job') is not null;
  v_has_net  boolean := to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null;
  v_exists   boolean;
begin
  if not v_has_cron then
    raise notice 'cfb_lab_cron: pg_cron is not available: no job was scheduled (skipped)';
    return;
  end if;

  execute 'select exists (select 1 from cron.job where jobname = $1)' into v_exists using 'cfb_lab_hourly';
  if v_exists then
    execute 'select cron.unschedule($1)' using 'cfb_lab_hourly';
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1)' into v_exists using 'cfb_lab_lines';
  if v_exists then
    execute 'select cron.unschedule($1)' using 'cfb_lab_lines';
  end if;

  if v_has_net then
    execute 'select cron.schedule($1, $2, $3)'
      using 'cfb_lab_hourly', '7 * * * *', 'select public.cfb_lab_poke(''hourly'');';
  else
    raise notice 'cfb_lab_cron: pg_net is not available: cfb_lab_hourly was not scheduled (skipped)';
  end if;
end $blk$;

-- ------------------------------------------------------------------ report
-- A function, because a plain select naming cron.job would not even parse on
-- a server without pg_cron. Safe to call any time:
--   select * from public.cfb_lab_cron_status();
create or replace function public.cfb_lab_cron_status()
returns table (check_name text, status text, detail text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_has_cron boolean := to_regprocedure('cron.schedule(text,text,text)') is not null and to_regclass('cron.job') is not null;
  v_has_net  boolean := to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null;
  v_sched    text;
  v_active   boolean;
  v_vault    boolean := false;
  v_setting  boolean := nullif(current_setting('edgedesk.gh_token', true), '') is not null;
begin
  check_name := 'supabase/cfb_lab.sql is applied';
  status := case when to_regprocedure('public.cfb_lab_derive_lines(timestamptz)') is not null then 'ok' else 'CHECK THIS' end;
  detail := null;
  return next;

  check_name := 'pg_cron';
  status := case when v_has_cron then 'ok' else 'CHECK THIS' end;
  detail := case when v_has_cron then 'installed' else 'not available here: skipped, no job was scheduled' end;
  return next;

  check_name := 'pg_net';
  status := case when v_has_net then 'ok' else 'CHECK THIS' end;
  detail := case when v_has_net then 'installed' else 'not available here: skipped, cfb_lab_poke cannot dispatch' end;
  return next;

  v_sched := null; v_active := null;
  if v_has_cron then
    execute 'select schedule, active from cron.job where jobname = $1 limit 1' into v_sched, v_active using 'cfb_lab_hourly';
  end if;
  check_name := 'job cfb_lab_hourly';
  status := case when v_sched = '7 * * * *' and v_active then 'ok' else 'CHECK THIS' end;
  detail := case when not v_has_cron then 'skipped: pg_cron is not available'
                 when v_sched is null then 'not scheduled'
                 else 'schedule ' || v_sched || case when v_active then ', active' else ', INACTIVE' end end;
  return next;

  v_sched := null;
  if v_has_cron then
    execute 'select schedule from cron.job where jobname = $1 limit 1' into v_sched using 'cfb_lab_lines';
  end if;
  check_name := 'no database-side lines job (cfb_lab_lines): lines come from the ledger mirror';
  status := case when v_sched is null then 'ok' else 'CHECK THIS' end;
  detail := case when not v_has_cron then 'pg_cron is not available'
                 when v_sched is null then 'not scheduled'
                 else 'still scheduled (' || v_sched || '): re-run this file to remove it' end;
  return next;

  begin
    execute 'select exists (select 1 from vault.decrypted_secrets where name = $1)' into v_vault using 'edgedesk_gh_token';
  exception when others then
    v_vault := false;
  end;
  check_name := 'GitHub token for the poke';
  status := case when v_vault or v_setting then 'ok' else 'CHECK THIS' end;
  detail := case when v_vault then 'vault secret edgedesk_gh_token'
                 when v_setting then 'edgedesk.gh_token database setting'
                 else 'NOT SET: every hourly tick returns no_token and dispatches nothing' end;
  return next;

  check_name := 'cfb_lab_poke is not callable by anon or authenticated';
  status := case
    when not exists (select 1 from pg_roles where rolname = 'anon')
      or not exists (select 1 from pg_roles where rolname = 'authenticated') then 'CHECK THIS'
    when coalesce(has_function_privilege('anon', to_regprocedure('public.cfb_lab_poke(text)'), 'execute'), true)
      or coalesce(has_function_privilege('authenticated', to_regprocedure('public.cfb_lab_poke(text)'), 'execute'), true)
      then 'CHECK THIS'
    else 'ok' end;
  detail := null;
  return next;
end $fn$;

revoke all on function public.cfb_lab_cron_status() from public;
do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.cfb_lab_cron_status() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.cfb_lab_cron_status() from authenticated';
  end if;
end $blk$;

-- ---------------------------------------------------------------------------
-- VERIFYING IT, from the SQL editor:
--   select public.cfb_lab_poke('hourly');                 -- expect action dispatched
--   select id, status_code, content from net._http_response order by id desc limit 5;
--   select start_time, status, return_message from cron.job_run_details
--    where jobid in (select jobid from cron.job where jobname like 'cfb_lab_%')
--    order by start_time desc limit 10;
-- TURNING IT OFF:
--   select cron.unschedule('cfb_lab_hourly');
-- ---------------------------------------------------------------------------
select check_name, status, detail from public.cfb_lab_cron_status();
