-- ===========================================================================
-- EdgeDesk — billing PREFLIGHT. READ-ONLY. Run it before, and as often as you
-- like around, supabase/billing_hardening.sql (docs/billing-hardening.md §9).
--
-- It changes nothing: one SELECT, no function, no temp table, so it runs inside
-- a READ ONLY transaction (the deploy workflow runs it that way). It reads only
-- columns every installation has, and anything the migration adds through
-- to_jsonb(row) or a guarded lookup, so the same file answers before the
-- migration and after it.
--
-- Every row is one check:  verdict  PASS | FAIL | WARN | INFO
--   FAIL  stop: the next deployment stage must not run until this is fixed
--   WARN  a human should read it; it does not block the deployment
--   INFO  the state, for the before/after record
--
-- CUSTOMER DATA IS MASKED BY DEFAULT (c***@example.com, 1a2b3c4d…), because the
-- deploy workflow prints this into GitHub Actions logs and this repository is
-- public. In the Supabase SQL editor, which only you can see, put this line
-- above the file to see full emails and ids:
--
--     set billing.unmasked = 'on';
--
-- Sections: 0 prerequisites · 1 the data (Phase 2 items 1–13) · 2 schema
-- (14–18) · 3 security · 4 integrity (Phase 3) · 5 fingerprint (Phase 4).
-- Items 19–20 (deployed Edge Function versions, the webhook's configuration)
-- are read from the Supabase Management API by the workflow, not from SQL.
-- ===========================================================================
with
opt as (
  select coalesce(current_setting('billing.unmasked', true), '') = 'on' as unmasked
),
-- every subscriptions row, with the columns the migration may or may not have
-- added read through to_jsonb so a missing one is null rather than an error
s as (
  select s.user_id, s.status, s.price_id, s.current_period_end, s.cancel_at_period_end,
         s.stripe_customer_id, s.stripe_subscription_id, s.created_at, s.updated_at,
         (to_jsonb(s) ->> 'last_event_id')                    as last_event_id,
         (to_jsonb(s) ->> 'last_event_at')::timestamptz      as last_event_at,
         (to_jsonb(s) ->> 'stripe_synced_at')::timestamptz   as stripe_synced_at,
         u.email,
         -- THE RULE, inlined (billing_row_grants_access may not exist yet)
         coalesce((s.status = 'active' and coalesce(s.price_id, '') = 'owner_comp')
                  or (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end >= now()))
                  or (s.status = 'past_due' and (s.current_period_end is null or now() - s.current_period_end < interval '21 days')),
                  false) as entitled
    from public.subscriptions s
    left join auth.users u on u.id = s.user_id
),
m as (  -- masked presentation of one row
  select s.*,
         case when o.unmasked then s.user_id::text else left(s.user_id::text, 8) || '…' end as uid,
         case when s.email is null then null when o.unmasked then s.email
              else left(s.email, 1) || '***' || coalesce(substring(s.email from '@.*$'), '') end as em,
         case when s.stripe_customer_id is null then null when o.unmasked then s.stripe_customer_id
              else left(s.stripe_customer_id, 8) || '…' || right(s.stripe_customer_id, 4) end as cus,
         case when s.stripe_subscription_id is null then null when o.unmasked then s.stripe_subscription_id
              else left(s.stripe_subscription_id, 8) || '…' || right(s.stripe_subscription_id, 4) end as sub
    from s cross join opt o
),
mj as (  -- one row as a compact json object for the detail column
  select m.*, jsonb_build_object(
           'user', m.uid, 'email', m.em, 'status', m.status, 'price', m.price_id,
           'period_end', to_char(m.current_period_end at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'cancel_at_end', m.cancel_at_period_end, 'customer', m.cus, 'subscription', m.sub,
           'access_now', m.entitled,
           'created', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD'),
           'updated', to_char(m.updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'last_event', case when m.last_event_id is null then null
                              when (select unmasked from opt) then m.last_event_id
                              else left(m.last_event_id, 8) || '…' || right(m.last_event_id, 4) end,
           'last_event_at', to_char(m.last_event_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')) as j
    from m
),
e as (
  select e.id, e.type, e.created_at, e.stripe_created, e.customer_id, e.subscription_id, e.user_id,
         e.resolved, e.applied, e.note,
         (to_jsonb(e) ->> 'last_error')         as last_error,
         ((to_jsonb(e) ->> 'attempts'))::int    as attempts,
         e.payload -> 'data' -> 'object' ->> 'client_reference_id' as client_reference_id,
         coalesce(e.payload -> 'data' -> 'object' -> 'customer_details' ->> 'email',
                  e.payload -> 'data' -> 'object' ->> 'customer_email') as stripe_email
    from public.stripe_events e
),
-- duplicates the migration's unique index and customer backfill care about
dup_sub as (
  select stripe_subscription_id, count(*) n from public.subscriptions
   where stripe_subscription_id is not null group by 1 having count(*) > 1
),
dup_cus as (
  select stripe_customer_id, count(distinct user_id) n from public.subscriptions
   where stripe_customer_id is not null group by 1 having count(distinct user_id) > 1
),
-- security: the functions this deployment owns or depends on
billing_fns as (
  select p.oid, p.proname, p.oid::regprocedure::text as sig, p.prosecdef,
         exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') as has_path,
         (select substr(c, 13) from unnest(p.proconfig) c where c like 'search_path=%' limit 1) as path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'billing\_%' or p.proname like 'stripe\_%' or p.proname in ('my_billing_access', 'community_is_entitled'))
),
-- the functions only the service role may run (installed by the migration)
writers(sig) as (values
  ('public.billing_apply_subscription_state(uuid,text,text,text,text,timestamp with time zone,boolean,timestamp with time zone,text,boolean,boolean,text,timestamp with time zone,boolean)'),
  ('public.billing_link_customer(text,uuid,text,boolean,text)'),
  ('public.billing_resolve_user(text,text,text,text,text,text)'),
  ('public.billing_record_event(text,text,timestamp with time zone,text,text,jsonb,text)'),
  ('public.billing_raise_alert(text,text,uuid,text,text,text,jsonb,boolean)'),
  ('public.billing_clear_alerts(uuid,text[],text)'),
  ('public.billing_access_for(uuid,timestamp with time zone)'),
  ('public.billing_sync_admit(uuid,text,integer,integer,text)'),
  ('public.billing_sweep_admit(integer)'),
  ('public.billing_sweep_candidates(integer)'),
  ('public.billing_unresolved_events(integer)'),
  ('public.billing_user_report(uuid)'),
  ('public.stripe_user_by_email(text)')
),
writer_state as (
  select w.sig, to_regprocedure(w.sig) as oid,
         case when to_regprocedure(w.sig) is null then null
              else has_function_privilege('anon', to_regprocedure(w.sig), 'execute')
                or has_function_privilege('authenticated', to_regprocedure(w.sig), 'execute') end as client_can_run
    from writers w
),
-- service-only relations: no client grant at all
service_only(rel) as (values
  ('public.stripe_events'), ('public.stripe_events_unresolved'),
  ('public.billing_customers'), ('public.billing_checkout_sessions'), ('public.billing_sync_log'),
  ('public.billing_alerts'), ('public.billing_sweep_state'), ('public.billing_diagnostics'),
  ('public.billing_open_alerts')
),
service_only_state as (
  select so.rel, to_regclass(so.rel) as oid,
         case when to_regclass(so.rel) is null then null
              else has_table_privilege('anon', to_regclass(so.rel), 'select,insert,update,delete')
                or has_table_privilege('authenticated', to_regclass(so.rel), 'select,insert,update,delete') end as client_access,
         (select c.relkind from pg_class c where c.oid = to_regclass(so.rel)) as relkind,
         (select c.relrowsecurity from pg_class c where c.oid = to_regclass(so.rel)) as rls
    from service_only so
),
sub_policies as (
  select policyname, cmd, roles::text[] as roles, qual, with_check
    from pg_policies where schemaname = 'public' and tablename = 'subscriptions'
),
checks(n, section, item, verdict, detail) as (
  -- ── 0. prerequisites ───────────────────────────────────────────────────────
  select 1, '0 prerequisites', 'connected as / server',
         'INFO', current_user || ' on PostgreSQL ' || current_setting('server_version') ||
                 ' · may act as authenticated: ' || pg_has_role(current_user, 'authenticated', 'member')::text ||
                 ' · masked: ' || (not (select unmasked from opt))::text
  union all
  select 2, '0 prerequisites', 'base billing objects exist (billing.sql, stripe_webhook.sql)',
         case when to_regclass('public.subscriptions') is not null and to_regclass('public.stripe_events') is not null
                   and to_regclass('public.billing_consents') is not null
                   and to_regprocedure('public.stripe_user_by_email(text)') is not null
                   and to_regproc('gen_random_uuid') is not null then 'PASS' else 'FAIL' end,
         'subscriptions ' || (to_regclass('public.subscriptions') is not null)::text ||
         ', stripe_events ' || (to_regclass('public.stripe_events') is not null)::text ||
         ', billing_consents ' || (to_regclass('public.billing_consents') is not null)::text ||
         ', stripe_user_by_email ' || (to_regprocedure('public.stripe_user_by_email(text)') is not null)::text ||
         ', gen_random_uuid ' || (to_regproc('gen_random_uuid') is not null)::text
  union all
  select 3, '0 prerequisites', 'billing_hardening.sql already installed?',
         'INFO', case when to_regprocedure('public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean)') is not null
                      then 'yes — this is an after-state' else 'no — this is a before-state' end
  union all
  select 4, '0 prerequisites', 'pg_cron / pg_net (needed by billing_reconcile_cron.sql later)',
         'INFO', 'pg_cron ' || exists (select 1 from pg_extension where extname = 'pg_cron')::text ||
                 ', pg_net ' || exists (select 1 from pg_extension where extname = 'pg_net')::text

  -- ── 1. the data (Phase 2, items 1–13) ─────────────────────────────────────
  union all
  select 101, '1 data', '1. subscriptions rows by status', 'INFO',
         coalesce((select jsonb_object_agg(coalesce(status, '(null)'), n)::text from (
                    select status, count(*) n from s group by 1 order by 1) t), '{}') ||
         ' · total ' || (select count(*) from s)::text ||
         ' · granting access now ' || (select count(*) from s where entitled)::text ||
         ' (Stripe-backed ' || (select count(*) from s where entitled and stripe_subscription_id is not null)::text || ')'
  union all
  select 102, '1 data', '2. active rows', 'INFO',
         (select count(*) from s where status = 'active')::text || ' · ' ||
         coalesce((select jsonb_agg(j order by created_at)::text from mj where status = 'active'), '[]')
  union all
  select 103, '1 data', '3. trialing rows', 'INFO',
         (select count(*) from s where status = 'trialing')::text || ' · ' ||
         coalesce((select jsonb_agg(j order by created_at)::text from mj where status = 'trialing'), '[]')
  union all
  select 104, '1 data', '4. comp_trial rows', 'INFO',
         (select count(*) from s where price_id = 'comp_trial')::text || ' (still valid ' ||
         (select count(*) from s where price_id = 'comp_trial' and entitled)::text || ') · ' ||
         coalesce((select jsonb_agg(j order by created_at)::text from mj where price_id = 'comp_trial'), '[]')
  union all
  select 105, '1 data', '5. owner_comp rows', 'INFO',
         (select count(*) from s where price_id = 'owner_comp')::text || ' · ' ||
         coalesce((select jsonb_agg(j order by created_at)::text from mj where price_id = 'owner_comp'), '[]')
  union all
  select 106, '1 data', '6. canceled rows', 'INFO', (select count(*) from s where status = 'canceled')::text
  union all
  select 107, '1 data', '7. past_due rows', 'INFO',
         (select count(*) from s where status = 'past_due')::text || ' (inside the 21-day grace ' ||
         (select count(*) from s where status = 'past_due' and entitled)::text || ') · ' ||
         coalesce((select jsonb_agg(j)::text from mj where status = 'past_due'), '[]')
  union all
  select 108, '1 data', '8. rows with no stripe_customer_id', 'INFO',
         (select count(*) from s where stripe_customer_id is null)::text || ' (of them comps ' ||
         (select count(*) from s where stripe_customer_id is null and price_id in ('owner_comp', 'comp_trial'))::text ||
         ', granting access without being a comp ' ||
         (select count(*) from s where stripe_customer_id is null and entitled and coalesce(price_id, '') not in ('owner_comp', 'comp_trial'))::text || ')'
  union all
  select 109, '1 data', '9. rows with no stripe_subscription_id', 'INFO',
         (select count(*) from s where stripe_subscription_id is null)::text || ' (of them comps ' ||
         (select count(*) from s where stripe_subscription_id is null and price_id in ('owner_comp', 'comp_trial'))::text ||
         ', granting access without being a comp ' ||
         (select count(*) from s where stripe_subscription_id is null and entitled and coalesce(price_id, '') not in ('owner_comp', 'comp_trial'))::text || ')'
  union all
  select 110, '1 data', '10. a stripe_customer_id on more than one account',
         case when (select count(*) from dup_cus) = 0 then 'PASS' else 'FAIL' end,
         case when (select count(*) from dup_cus) = 0 then 'none'
              else 'see row 401 — a human decides the owner before the migration runs' end
  union all
  select 111, '1 data', '11. a stripe_subscription_id on more than one account',
         case when (select count(*) from dup_sub) = 0 then 'PASS' else 'FAIL' end,
         case when (select count(*) from dup_sub) = 0 then 'none — the unique index will be created'
              else 'see row 402 — the unique index would be skipped; a human decides the owner first' end
  union all
  select 112, '1 data', '12. unresolved stripe_events', 'INFO',
         'all time ' || (select count(*) from e where not resolved)::text ||
         ' · 30 days ' || (select count(*) from e where not resolved and created_at > now() - interval '30 days')::text ||
         ' · 14 days ' || (select count(*) from e where not resolved and created_at > now() - interval '14 days')::text ||
         ' · deliveries total ' || (select count(*) from e)::text ||
         ' · last delivery ' || coalesce(to_char((select max(created_at) from e) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), 'never')
  union all
  select 113, '1 data', '13. failed or unresolved deliveries, last 30 days',
         case when exists (select 1 from e where created_at > now() - interval '30 days'
                             and (not resolved or last_error is not null)) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(x)::text from (
           select jsonb_build_object(
                    'event', case when (select unmasked from opt) then e.id else left(e.id, 8) || '…' || right(e.id, 4) end,
                    'type', e.type, 'at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                    'resolved', e.resolved, 'applied', e.applied, 'attempts', e.attempts,
                    'customer', case when e.customer_id is null then null when (select unmasked from opt) then e.customer_id
                                     else left(e.customer_id, 8) || '…' || right(e.customer_id, 4) end,
                    'has_client_reference_id', e.client_reference_id is not null,
                    'client_reference_id_is_an_account', e.client_reference_id is not null and exists (
                        select 1 from auth.users u where u.id::text = lower(e.client_reference_id)),
                    'stripe_email', case when e.stripe_email is null then null when (select unmasked from opt) then e.stripe_email
                                         else left(e.stripe_email, 1) || '***' || coalesce(substring(e.stripe_email from '@.*$'), '') end,
                    'note', left(e.note, 120), 'error', left(e.last_error, 160)) as x
             from e where created_at > now() - interval '30 days' and (not resolved or last_error is not null)
            order by created_at desc limit 40) t), 'none')

  -- ── 2. schema (Phase 2, items 14–18) ──────────────────────────────────────
  union all
  select 201, '2 schema', '14. constraints on public.subscriptions', 'INFO',
         coalesce((select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' · ' order by conname)
                     from pg_constraint where conrelid = 'public.subscriptions'::regclass), 'none')
  union all
  select 202, '2 schema', '15. indexes on the billing tables', 'INFO',
         coalesce((select string_agg(tablename || '.' || indexname || case when indexdef ilike '%unique%' then ' (unique)' else '' end,
                                     ' · ' order by tablename, indexname)
                     from pg_indexes where schemaname = 'public'
                      and (tablename in ('subscriptions', 'stripe_events', 'billing_consents') or tablename like 'billing\_%')), 'none')
  union all
  select 203, '2 schema', '16. RLS policies on the billing tables', 'INFO',
         coalesce((select string_agg(tablename || '.' || policyname || ' [' || cmd || ' to ' || array_to_string(roles::text[], ',') || '] using ' ||
                                     coalesce(qual, '-') || coalesce(' check ' || with_check, ''), ' · ' order by tablename, policyname)
                     from pg_policies where schemaname = 'public'
                      and (tablename in ('subscriptions', 'stripe_events', 'billing_consents') or tablename like 'billing\_%')), 'none')
  union all
  select 204, '2 schema', '17. client privileges on the billing tables (anon / authenticated)', 'INFO',
         coalesce((select string_agg(t.rel || ': anon ' ||
                     coalesce(nullif(concat_ws('', case when has_table_privilege('anon', t.oid, 'select') then 'S' end,
                       case when has_table_privilege('anon', t.oid, 'insert') then 'I' end,
                       case when has_table_privilege('anon', t.oid, 'update') then 'U' end,
                       case when has_table_privilege('anon', t.oid, 'delete') then 'D' end), ''), '-') ||
                     ', authenticated ' ||
                     coalesce(nullif(concat_ws('', case when has_table_privilege('authenticated', t.oid, 'select') then 'S' end,
                       case when has_table_privilege('authenticated', t.oid, 'insert') then 'I' end,
                       case when has_table_privilege('authenticated', t.oid, 'update') then 'U' end,
                       case when has_table_privilege('authenticated', t.oid, 'delete') then 'D' end), ''), '-') ||
                     ', RLS ' || (select case when c.relkind in ('v', 'm') then 'n/a (view)' else c.relrowsecurity::text end
                                    from pg_class c where c.oid = t.oid),
                     ' · ' order by t.rel)
                     from (select x.rel, to_regclass(x.rel) as oid from (values ('public.subscriptions'), ('public.billing_consents')) x(rel)
                           union all select rel, oid from service_only_state) t where t.oid is not null), 'none') ||
         ' · function EXECUTE for authenticated: ' ||
         coalesce((select string_agg(proname || case when has_function_privilege('anon', oid, 'execute') then ' (+anon)' else '' end, ', ' order by proname)
                     from billing_fns where has_function_privilege('authenticated', oid, 'execute')), 'none')
  union all
  select 205, '2 schema', '18. pg_cron jobs related to billing', 'INFO',
         case when to_regclass('cron.job') is null then 'pg_cron not installed'
              when not has_table_privilege(to_regclass('cron.job'), 'select') then 'cron.job is not readable as ' || current_user
              else coalesce((select string_agg(x::text, ' · ') from unnest(xpath('//row/x/text()',
                     query_to_xml('select jobname || '' ['' || schedule || '', active '' || active::text || '']'' as x from cron.job ' ||
                                  'where jobname ilike ''%billing%'' or command ilike ''%sync_subscription%'' or command ilike ''%stripe%''',
                                  false, false, ''))) x), 'none') end

  -- ── 3. security (Phase 2, the explicit verifications) ─────────────────────
  union all
  select 301, '3 security', 'signed-in readers cannot INSERT / UPDATE / DELETE subscriptions',
         case when not has_table_privilege('authenticated', 'public.subscriptions', 'insert,update,delete')
                   and not has_table_privilege('anon', 'public.subscriptions', 'insert,update,delete')
                   and not has_any_column_privilege('authenticated', 'public.subscriptions', 'insert,update')
                   and not has_any_column_privilege('anon', 'public.subscriptions', 'insert,update')
                   and not exists (select 1 from sub_policies where cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
                                     and roles && array['authenticated', 'anon', 'public'])
              then 'PASS' else 'FAIL' end,
         'table privileges and write policies for anon / authenticated / public'
  union all
  select 302, '3 security', 'signed-in readers can read only their own subscriptions row',
         case when (select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass)
                   and not has_table_privilege('anon', 'public.subscriptions', 'select')
                   and exists (select 1 from sub_policies where cmd in ('SELECT', 'ALL'))
                   and not exists (select 1 from sub_policies where cmd in ('SELECT', 'ALL')
                                     and roles && array['authenticated', 'anon', 'public']
                                     and coalesce(qual, '') !~ 'auth\.uid\(\)')
              then 'PASS' else 'FAIL' end,
         coalesce((select string_agg(policyname || ' [' || cmd || '] ' || coalesce(qual, '-'), ' · ') from sub_policies
                    where cmd in ('SELECT', 'ALL')), 'no read policy') ||
         ' — behaviourally re-checked by tools/billing/sql/rls_probe.psql'
  union all
  select 303, '3 security', 'service-only billing tables and views are not exposed to anon / authenticated',
         case when exists (select 1 from service_only_state where oid is not null and client_access) then 'FAIL'
              when exists (select 1 from service_only_state where oid is not null and relkind = 'r' and not rls) then 'FAIL'
              else 'PASS' end,
         coalesce((select string_agg(rel || case when client_access then ' CLIENT ACCESS' else '' end ||
                                     case when relkind = 'r' and not rls then ' RLS OFF' else '' end, ', ' order by rel)
                     from service_only_state where oid is not null), 'none installed') ||
         coalesce(' · not installed yet: ' || (select string_agg(rel, ', ') from service_only_state where oid is null), '')
  union all
  select 304, '3 security', 'my_billing_access() is callable by signed-in readers only, about themselves',
         case when to_regprocedure('public.my_billing_access()') is null then 'INFO'
              when has_function_privilege('authenticated', to_regprocedure('public.my_billing_access()'), 'execute')
                   and not has_function_privilege('anon', to_regprocedure('public.my_billing_access()'), 'execute')
                   and (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.my_billing_access()'))
              then 'PASS' else 'FAIL' end,
         case when to_regprocedure('public.my_billing_access()') is null then 'not installed yet (the migration adds it: no arguments, authenticated only)'
              else 'takes no argument (it can only describe the caller); authenticated ' ||
                   has_function_privilege('authenticated', to_regprocedure('public.my_billing_access()'), 'execute')::text ||
                   ', anon ' || has_function_privilege('anon', to_regprocedure('public.my_billing_access()'), 'execute')::text end
  union all
  select 305, '3 security', 'billing writers and resolvers cannot be run by any client role',
         case when exists (select 1 from writer_state where client_can_run) then 'FAIL' else 'PASS' end,
         coalesce('CLIENT CAN RUN: ' || (select string_agg(sig, ', ') from writer_state where client_can_run), 'none callable') ||
         ' · installed ' || (select count(*) from writer_state where oid is not null)::text || ' of ' || (select count(*) from writer_state)::text
  union all
  select 306, '3 security', 'every SECURITY DEFINER billing function pins its search_path',
         case when exists (select 1 from billing_fns where prosecdef and not has_path) then 'FAIL' else 'PASS' end,
         coalesce('NO search_path: ' || (select string_agg(sig, ', ') from billing_fns where prosecdef and not has_path), '') ||
         coalesce(' · pinned: ' || (select string_agg(proname || ' (' || path || ')', ', ' order by proname)
                                      from billing_fns where prosecdef and has_path), '')
  union all
  select 307, '3 security', 'only the service role (and the owner) can write subscriptions',
         case when has_table_privilege('public', 'public.subscriptions', 'insert,update,delete,truncate')
                   or has_table_privilege('anon', 'public.subscriptions', 'truncate')
                   or has_table_privilege('authenticated', 'public.subscriptions', 'truncate') then 'FAIL' else 'PASS' end,
         'roles with write privileges: ' ||
         coalesce((select string_agg(distinct grantee, ', ') from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'subscriptions'
                      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')), 'none')
  union all
  select 308, '3 security', 'community_is_entitled(uuid) answers for ANY account id to any caller who may run it',
         case when to_regprocedure('public.community_is_entitled(uuid)') is not null
                   and has_function_privilege('authenticated', to_regprocedure('public.community_is_entitled(uuid)'), 'execute')
              then 'WARN' else 'PASS' end,
         case when to_regprocedure('public.community_is_entitled(uuid)') is null then 'not installed'
              when has_function_privilege('authenticated', to_regprocedure('public.community_is_entitled(uuid)'), 'execute')
              then 'pre-existing (community_posts.sql): callable by signed-in readers' ||
                   case when has_function_privilege('anon', to_regprocedure('public.community_is_entitled(uuid)'), 'execute')
                        then ' AND by anonymous callers (anon)' else '' end ||
                   '; whoever knows another account''s id can learn one boolean, whether it has access. ' ||
                   'Not changed by this deployment (billing_hardening.sql keeps its grants). ' ||
                   'Follow-up: answer only for auth.uid() unless the caller is the service role, and revoke it from anon.'
              else 'not callable by clients' end

  -- ── 4. integrity (Phase 3) ───────────────────────────────────────────────
  union all
  select 401, '4 integrity', 'customer ids on more than one account (blocks: billing_customers maps a customer to ONE account)',
         case when (select count(*) from dup_cus) = 0 then 'PASS' else 'FAIL' end,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'customer', (select cus from m where m.stripe_customer_id = d.stripe_customer_id limit 1),
                     'accounts', (select jsonb_agg(j order by created_at) from mj where mj.stripe_customer_id = d.stripe_customer_id),
                     'classification', case
                        when (select count(distinct coalesce(stripe_subscription_id, '-')) from s where s.stripe_customer_id = d.stripe_customer_id) = 1
                          then 'the same customer AND subscription on several accounts: one person, several accounts (or a row copied by hand)'
                        else 'one Stripe customer, different subscriptions on different accounts: a shared payer, or a resolution to the wrong account' end,
                     'proposed_fix', 'look the customer up in Stripe (email, metadata.supabase_user_id); keep the id on the owner''s row; ' ||
                                     'on the other row set stripe_customer_id (and a copied stripe_subscription_id) to null — status untouched — ' ||
                                     'then let Refresh access / the sweep re-read Stripe for both'))::text
                     from dup_cus d), 'none')
  union all
  select 402, '4 integrity', 'subscription ids on more than one account (blocks: the unique index needs one row per subscription)',
         case when (select count(*) from dup_sub) = 0 then 'PASS' else 'FAIL' end,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'subscription', (select sub from m where m.stripe_subscription_id = d.stripe_subscription_id limit 1),
                     'accounts', (select jsonb_agg(j order by created_at) from mj where mj.stripe_subscription_id = d.stripe_subscription_id),
                     'classification', 'one Stripe subscription is ONE purchase by ONE person; every extra row is a copy or a mis-resolution',
                     'proposed_fix', 'confirm the buyer in Stripe (the subscription''s customer email / metadata); on every other row set ' ||
                                     'stripe_subscription_id = null (keep status, so nobody is locked out by the cleanup itself); re-run this preflight'))::text
                     from dup_sub d), 'none')
  union all
  select 403, '4 integrity', 'accounts the ledger saw with more than one Stripe subscription (possible duplicate purchase)',
         case when exists (select 1 from e where resolved and user_id is not null and subscription_id is not null
                            group by user_id having count(distinct subscription_id) > 1) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(x)::text from (
           select jsonb_build_object('user', (select uid from m where m.user_id = e.user_id limit 1),
                    'subscriptions_seen', count(distinct e.subscription_id),
                    'row_describes', (select sub from m where m.user_id = e.user_id limit 1),
                    'next', 'after deploy: /admin/billing/ shows which are live; the reconciler keeps the best and alerts on duplicates') as x
             from e where e.resolved and e.user_id is not null and e.subscription_id is not null
            group by e.user_id having count(distinct e.subscription_id) > 1 limit 25) t), 'none')
  union all
  select 404, '4 integrity', 'subscriptions the ledger resolved to more than one account',
         case when exists (select 1 from e where resolved and user_id is not null and subscription_id is not null
                            group by subscription_id having count(distinct user_id) > 1) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(x)::text from (
           select jsonb_build_object('subscription', case when (select unmasked from opt) then e.subscription_id
                                                         else left(e.subscription_id, 8) || '…' || right(e.subscription_id, 4) end,
                    'accounts', count(distinct e.user_id)) as x
             from e where e.resolved and e.user_id is not null and e.subscription_id is not null
            group by e.subscription_id having count(distinct e.user_id) > 1 limit 25) t), 'none')
  union all
  select 405, '4 integrity', 'comp rows carrying Stripe identifiers',
         case when exists (select 1 from s where price_id in ('owner_comp', 'comp_trial')
                             and (stripe_customer_id is not null or stripe_subscription_id is not null)) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(j || jsonb_build_object('classification', case
                     when price_id = 'owner_comp' then 'owner_comp is never written by Stripe (the comp guard), so the ids are inert; clear them by hand for clarity'
                     when stripe_subscription_id is not null then 'a comp_trial on a row that ALSO has a Stripe subscription: the first live read replaces the sentinel with that subscription''s real state'
                     else 'a comp_trial with a customer id: harmless; the reconciler reads that customer''s subscriptions' end))::text
                     from mj where price_id in ('owner_comp', 'comp_trial')
                      and (stripe_customer_id is not null or stripe_subscription_id is not null)), 'none')
  union all
  select 406, '4 integrity', 'Stripe ids that are not Stripe ids (cus_… / sub_…)',
         case when exists (select 1 from s where (stripe_customer_id is not null and stripe_customer_id !~ '^cus_[A-Za-z0-9]+$')
                             or (stripe_subscription_id is not null and stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$')) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(j)::text from mj
                    where (stripe_customer_id is not null and stripe_customer_id !~ '^cus_[A-Za-z0-9]+$')
                       or (stripe_subscription_id is not null and stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$')),
                  'none') || ' — billing_link_customer ignores a malformed customer; the reconciler treats a 4xx for one customer as "nothing there"'
  union all
  select 407, '4 integrity', 'rows granting access with no period end (never expire) that are not owner_comp',
         case when exists (select 1 from s where entitled and current_period_end is null and coalesce(price_id, '') <> 'owner_comp') then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(j)::text from mj where entitled and current_period_end is null and coalesce(price_id, '') <> 'owner_comp'), 'none')
  union all
  select 408, '4 integrity', 'hand-made rows granting access with no Stripe subscription (protected: Stripe never revokes them)',
         case when exists (select 1 from s where entitled and stripe_subscription_id is null
                             and coalesce(price_id, '') not in ('owner_comp', 'comp_trial')) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(j)::text from mj where entitled and stripe_subscription_id is null
                     and coalesce(price_id, '') not in ('owner_comp', 'comp_trial')), 'none') ||
         ' — after deploy each raises db_active_stripe_inactive if Stripe disagrees; convert to owner_comp / comp_trial or leave'
  union all
  select 409, '4 integrity', 'rows with no status (a locked-out customer)',
         case when exists (select 1 from s where status is null) then 'WARN' else 'PASS' end,
         coalesce((select jsonb_agg(j)::text from mj where status is null), 'none')
  union all
  select 410, '4 integrity', 'accounts that went to checkout and have no subscriptions row (the reported failure''s shape)',
         case when exists (select 1 from public.billing_consents c where not exists (select 1 from s where s.user_id = c.user_id))
              then 'WARN' else 'PASS' end,
         (select count(distinct c.user_id) from public.billing_consents c where not exists (select 1 from s where s.user_id = c.user_id))::text ||
         ' accounts; most recent consents: ' ||
         coalesce((select jsonb_agg(x)::text from (
           select jsonb_build_object(
                    'user', case when (select unmasked from opt) then c.user_id::text else left(c.user_id::text, 8) || '…' end,
                    'last_consent', to_char(max(c.created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI')) as x
             from public.billing_consents c where not exists (select 1 from s where s.user_id = c.user_id)
            group by c.user_id order by max(c.created_at) desc limit 15) t), '[]') ||
         ' — after deploy: the sweep (3 days back) or the reader''s Refresh access asks Stripe for each'

  -- ── 5. the fingerprint (Phase 4) ─────────────────────────────────────────
  -- md5 over every billing-meaningful column of every row, in user order. The
  -- migration must leave it unchanged; supabase/billing_postflight.sql
  -- compares row by row against the snapshot billing_snapshot.sql stores.
  union all
  select 501, '5 fingerprint', 'subscriptions billing columns, md5 over all rows', 'INFO',
         coalesce(md5(string_agg(concat_ws('|', user_id, status, price_id, current_period_end, cancel_at_period_end,
                                           stripe_customer_id, stripe_subscription_id, last_event_id, last_event_at),
                                 E'\n' order by user_id)), 'empty') ||
         ' over ' || count(*)::text || ' rows'
    from s
)
select n, section, item, verdict, detail from checks order by n;
