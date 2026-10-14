/* ===========================================================================
   SERVER-ONLY FUNCTIONS — take back what PUBLIC was given by default.

   WHERE THIS COMES FROM. The August ship-gate audit (PR #14, closed; its
   BACKEND_RLS_VERIFICATION.md is on branch
   claude/edgedesk-production-audit-icfcmp) read the live catalog and found
   anon and authenticated holding EXECUTE on:

     * public.edge_call — SECURITY DEFINER, reads the service-role key and the
       cron secret from the vault, and calls any Edge Function with them. Any
       visitor holding the public anon key could drive settle, close, ingest
       and the AI functions.
     * every function in schema collective — get_config leaks admin.user_ids,
       which turns the admin RPCs' is_admin(p_admin) check into a formality,
       and billing_upsert_subscriber / billing_post_invoice /
       billing_post_refund have no check at all.
     * five public helpers that write shared state with no caller check.

   It also found three financial views SELECTable by anon. Views run as their
   owner, so they read past the RLS on the tables under them.

   The fix written then (BACKEND_FIX_ship_gate.sql) never reached this
   repository, and nothing records whether it was ever run. This file is that
   fix brought up to date, with one correction.

   THE CORRECTION. Revoking from anon and authenticated is not enough on its
   own. PostgreSQL grants EXECUTE on every new function to PUBLIC, and PUBLIC
   means every role, so a function revoked from anon and authenticated by name
   is still callable by both through PUBLIC. This file revokes from PUBLIC too.
   service_role is granted EXECUTE explicitly first, because it may also be
   reaching these functions only through PUBLIC, and the Collective edge
   functions and settle-finals.yml call them as service_role.

   WHAT IT TOUCHES. Functions are looked up by name, every overload, and any
   that no longer exist are skipped. Nothing is dropped, and no data changes.
     * every routine in schema collective. Only the collective_* edge functions
       (service-role key) and settle-finals.yml (SB_SERVICE_ROLE) call these.
       The browser reaches the Collective through public.collective_model_ensure
       and public.collective_my_models, which are SECURITY DEFINER and are left
       alone (report row 8).
     * public.edge_call. pg_cron runs as postgres, its owner, and keeps it.
     * public.guarantee_sweep, research_set_status, research_rebuild_patterns,
       research_register_validation, research_complete_validation.
     * views public.ai_cost_per_user, guarantee_refunds_due, partner_rollup.
   Checked against every rpc the pages and the admin consoles call (Oct 2026):
   none of the above is one of them.

   WHAT IT LEAVES ALONE. has_active_sub, which RLS policies call as the user
   (report row 7), every table and its policies, and every other schema.

   A NEW collective FUNCTION IS PUBLIC-EXECUTABLE AGAIN the moment it is
   created. PostgreSQL's built-in default cannot be revoked per schema, only
   globally, and revoking it globally would also strip the public-schema
   functions the browser calls. Re-run this file after adding one; rows 1 and
   2 of the report say when that is needed.

   Idempotent: running it twice is the same as running it once. Paste it into
   the SQL editor whole. Every report row should read ok.

   Tested against a real PostgreSQL by tools/app/server_only_lockdown_sql.test.js.
   =========================================================================== */

begin;

do $lock$
declare
  r        record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for r in
    select p.oid::regprocedure as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'collective'
        or (n.nspname = 'public'
            and p.proname in ('edge_call', 'guarantee_sweep',
                              'research_set_status', 'research_rebuild_patterns',
                              'research_register_validation',
                              'research_complete_validation'))
  loop
    if has_srv then execute format('grant execute on routine %s to service_role', r.fn); end if;
    execute format('revoke execute on routine %s from public', r.fn);
    if has_anon then execute format('revoke execute on routine %s from anon', r.fn); end if;
    if has_auth then execute format('revoke execute on routine %s from authenticated', r.fn); end if;
  end loop;

  if has_srv and to_regnamespace('collective') is not null then
    execute 'grant usage on schema collective to service_role';
  end if;

  for r in
    select c.oid::regclass as rel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('ai_cost_per_user', 'guarantee_refunds_due', 'partner_rollup')
       and c.relkind in ('v', 'm')
  loop
    if has_srv then execute format('grant select on %s to service_role', r.rel); end if;
    execute format('revoke all on %s from public', r.rel);
    if has_anon then execute format('revoke all on %s from anon', r.rel); end if;
    if has_auth then execute format('revoke all on %s from authenticated', r.rel); end if;
  end loop;
end
$lock$;

commit;

-- ── report ─────────────────────────────────────────────────────────────────
with client as (
  select rolname from pg_roles where rolname in ('anon', 'authenticated')
), coll as (
  select p.oid, p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'collective'
), helpers as (
  select p.oid, p.oid::regprocedure::text as fn, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('edge_call', 'guarantee_sweep',
                       'research_set_status', 'research_rebuild_patterns',
                       'research_register_validation',
                       'research_complete_validation')
), views as (
  select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('ai_cost_per_user', 'guarantee_refunds_due', 'partner_rollup')
     and c.relkind in ('v', 'm')
), open_coll as (
  select distinct coll.fn from coll, client
   where has_function_privilege(client.rolname, coll.oid, 'EXECUTE')
)
select 1 as row, 'no collective function is callable by anon' as check,
       case when not exists (
              select 1 from coll
               where exists (select 1 from pg_roles where rolname = 'anon')
                 and has_function_privilege('anon', coll.oid, 'EXECUTE'))
            then 'ok'
            else 'CHECK THIS — re-run this file; still open: '
                 || (select string_agg(fn, ', ' order by fn) from open_coll) end as result
union all select 2, 'no collective function is callable by authenticated',
       case when not exists (
              select 1 from coll
               where exists (select 1 from pg_roles where rolname = 'authenticated')
                 and has_function_privilege('authenticated', coll.oid, 'EXECUTE'))
            then 'ok'
            else 'CHECK THIS — re-run this file; still open: '
                 || (select string_agg(fn, ', ' order by fn) from open_coll) end
union all select 3, 'service_role can still call every collective function',
       case when not exists (select 1 from pg_roles where rolname = 'service_role')
              or not exists (select 1 from coll where not has_function_privilege('service_role', coll.oid, 'EXECUTE'))
            then 'ok (' || (select count(*) from coll)::text || ' functions)'
            else 'CHECK THIS — the Collective edge functions cannot call: '
                 || (select string_agg(fn, ', ' order by fn) from coll
                      where not has_function_privilege('service_role', coll.oid, 'EXECUTE')) end
union all select 4, 'public.edge_call is not callable by anon or authenticated',
       case when not exists (
              select 1 from helpers, client
               where helpers.proname = 'edge_call'
                 and has_function_privilege(client.rolname, helpers.oid, 'EXECUTE'))
            then case when exists (select 1 from helpers where proname = 'edge_call')
                      then 'ok' else 'ok (not installed)' end
            else 'CHECK THIS — re-run this file' end
union all select 5, 'the guarantee and research helpers are not callable by anon or authenticated',
       case when not exists (
              select 1 from helpers, client
               where helpers.proname <> 'edge_call'
                 and has_function_privilege(client.rolname, helpers.oid, 'EXECUTE'))
            then 'ok (' || (select count(*) from helpers where proname <> 'edge_call')::text || ' installed)'
            else 'CHECK THIS — still open: '
                 || (select string_agg(distinct helpers.fn, ', ') from helpers, client
                      where helpers.proname <> 'edge_call'
                        and has_function_privilege(client.rolname, helpers.oid, 'EXECUTE')) end
union all select 6, 'the three financial views are not readable by anon or authenticated',
       case when not exists (
              select 1 from views, client
               where has_table_privilege(client.rolname, views.oid, 'SELECT'))
            then 'ok (' || (select count(*) from views)::text || ' installed)'
            else 'CHECK THIS — still readable: '
                 || (select string_agg(distinct views.relname, ', ') from views, client
                      where has_table_privilege(client.rolname, views.oid, 'SELECT')) end
union all select 7, 'has_active_sub is untouched: authenticated can still call it',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'has_active_sub')
            then 'ok (not installed)'
            when not exists (select 1 from pg_roles where rolname = 'authenticated')
              or exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'has_active_sub'
                 and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
            then 'ok'
            else 'CHECK THIS — RLS policies call has_active_sub as the user' end
union all select 8, 'the browser''s Collective wrappers are untouched: authenticated can still call them',
       case when not exists (select 1 from pg_roles where rolname = 'authenticated')
              or not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and p.proname in ('collective_model_ensure', 'collective_my_models')
                 and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
            then 'ok'
            else 'CHECK THIS — the model picker calls these as the signed-in user' end
order by row;
