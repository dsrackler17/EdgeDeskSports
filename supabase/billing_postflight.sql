-- ===========================================================================
-- EdgeDesk — billing POSTFLIGHT: did supabase/billing_hardening.sql do exactly
-- what it promised, and nothing else? (docs/billing-hardening.md §9a, Phase 5
-- checks A–I.)
--
-- Run AFTER billing_hardening.sql, against a snapshot billing_snapshot.sql took
-- BEFORE it (the newest one labelled 'pre-apply', or set billing.snapshot_id).
-- The deploy workflow runs snapshot → migration → this file → the role probe in
-- ONE transaction and commits only if no row here says FAIL; in the SQL editor
-- it is simply the report.
--
-- It writes only its own result rows, to billing_ops.check_runs, and returns
-- them. Customer data is masked unless `set billing.unmasked = 'on';`.
-- ===========================================================================
with
opt as (
  select coalesce(current_setting('billing.unmasked', true), '') = 'on' as unmasked
),
snap as (
  select * from billing_ops.snapshots
   where id = coalesce(nullif(current_setting('billing.snapshot_id', true), '')::bigint,
                       (select max(id) from billing_ops.snapshots where label = 'pre-apply'),
                       (select max(id) from billing_ops.snapshots))
),
-- the row as it was, and as it is
was as (
  select (r ->> 'user_id')::uuid as user_id, r ->> 'status' as status, r ->> 'price_id' as price_id,
         (r ->> 'current_period_end')::timestamptz as current_period_end,
         (r ->> 'cancel_at_period_end')::boolean as cancel_at_period_end,
         r ->> 'stripe_customer_id' as stripe_customer_id, r ->> 'stripe_subscription_id' as stripe_subscription_id,
         r ->> 'last_event_id' as last_event_id, (r ->> 'last_event_at')::timestamptz as last_event_at,
         (r ->> 'updated_at')::timestamptz as updated_at
    from snap, jsonb_array_elements(snap.subscriptions) r
),
now_ as (
  select s.user_id, s.status, s.price_id, s.current_period_end, s.cancel_at_period_end, s.stripe_customer_id,
         s.stripe_subscription_id, s.last_event_id, s.last_event_at, s.updated_at
    from public.subscriptions s
),
cmp as (
  select coalesce(w.user_id, n.user_id) as user_id,
         w.user_id is not null as in_snapshot, n.user_id is not null as in_table,
         (w.status, w.price_id, w.current_period_end, w.cancel_at_period_end, w.stripe_customer_id,
          w.stripe_subscription_id, w.last_event_id, w.last_event_at)
           is not distinct from
         (n.status, n.price_id, n.current_period_end, n.cancel_at_period_end, n.stripe_customer_id,
          n.stripe_subscription_id, n.last_event_id, n.last_event_at) as same,
         -- a changed row whose updated_at moved was written by the application
         -- (a webhook delivery between the snapshot and now); one that changed
         -- with the same updated_at was rewritten by something that is not the
         -- application — which is what this check exists to catch
         n.updated_at is distinct from w.updated_at as app_wrote,
         w.price_id as was_price, w.status as was_status, w.current_period_end as was_pe,
         w.cancel_at_period_end as was_cancel, n.status as now_status, n.price_id as now_price,
         n.current_period_end as now_pe, n.cancel_at_period_end as now_cancel
    from was w full join now_ n on n.user_id = w.user_id
),
masked as (
  select c.*, case when (select unmasked from opt) then c.user_id::text else left(c.user_id::text, 8) || '…' end as uid
    from cmp c
),
-- D. the business rule, case by case
rule_cases(k, status, price_id, pe, expect) as (values
  ('active, period ahead',          'active',     'price_x',    now() + interval '1 day',     true),
  ('active, period ended',          'active',     'price_x',    now() - interval '1 second',  false),
  ('trialing, period ahead',        'trialing',   'price_x',    now() + interval '1 day',     true),
  ('trialing, period ended',        'trialing',   'price_x',    now() - interval '1 second',  false),
  ('comp_trial, still valid',       'trialing',   'comp_trial', now() + interval '3 days',    true),
  ('comp_trial, ended',             'trialing',   'comp_trial', now() - interval '1 second',  false),
  ('owner_comp, no end',            'active',     'owner_comp', null::timestamptz,            true),
  ('owner_comp, old date',          'active',     'owner_comp', now() - interval '400 days',  true),
  ('past_due, inside 21-day grace', 'past_due',   'price_x',    now() - interval '20 days',   true),
  ('past_due, outside the grace',   'past_due',   'price_x',    now() - interval '22 days',   false),
  ('canceled',                      'canceled',   'price_x',    now() + interval '9 days',    false),
  ('unpaid',                        'unpaid',     'price_x',    now() + interval '9 days',    false),
  ('incomplete',                    'incomplete', 'price_x',    now() + interval '9 days',    false),
  ('incomplete_expired',            'incomplete_expired', 'price_x', now() + interval '9 days', false),
  ('paused',                        'paused',     'price_x',    now() + interval '9 days',    false),
  ('no status',                     null,         null,         null::timestamptz,            false)
),
rule_results as (
  select k, expect, public.billing_row_grants_access(status, price_id, pe, now()) as got from rule_cases
),
expected_fns(sig) as (values
  ('public.billing_row_grants_access(text,text,timestamptz,timestamptz)'),
  ('public.billing_access_for(uuid,timestamptz)'), ('public.my_billing_access()'),
  ('public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean)'),
  ('public.billing_resolve_user(text,text,text,text,text,text)'), ('public.billing_link_customer(text,uuid,text,boolean,text)'),
  ('public.billing_record_event(text,text,timestamptz,text,text,jsonb,text)'),
  ('public.billing_raise_alert(text,text,uuid,text,text,text,jsonb,boolean)'), ('public.billing_clear_alerts(uuid,text[],text)'),
  ('public.billing_sync_admit(uuid,text,integer,integer,text)'), ('public.billing_sweep_admit(integer)'),
  ('public.billing_sweep_candidates(integer)'), ('public.billing_unresolved_events(integer)'),
  ('public.billing_is_admin()'), ('public.billing_user_report(uuid)'), ('public.billing_admin_lookup(text)'),
  ('public.billing_admin_overview()'), ('public.billing_admin_link_customer(uuid,text)'),
  ('public.billing_admin_resolve_alert(bigint,text)')
),
service_only_fns(sig) as (values
  ('public.billing_access_for(uuid,timestamptz)'),
  ('public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean)'),
  ('public.billing_resolve_user(text,text,text,text,text,text)'), ('public.billing_link_customer(text,uuid,text,boolean,text)'),
  ('public.billing_record_event(text,text,timestamptz,text,text,jsonb,text)'),
  ('public.billing_raise_alert(text,text,uuid,text,text,text,jsonb,boolean)'), ('public.billing_clear_alerts(uuid,text[],text)'),
  ('public.billing_sync_admit(uuid,text,integer,integer,text)'), ('public.billing_sweep_admit(integer)'),
  ('public.billing_sweep_candidates(integer)'), ('public.billing_unresolved_events(integer)'),
  ('public.billing_user_report(uuid)'), ('public.stripe_user_by_email(text)')
),
service_tables(rel) as (values
  ('public.billing_customers'), ('public.billing_checkout_sessions'), ('public.billing_sync_log'),
  ('public.billing_alerts'), ('public.billing_sweep_state'), ('public.billing_diagnostics'),
  ('public.billing_open_alerts'), ('public.stripe_events'), ('public.stripe_events_unresolved')
),
checks(n, item, verdict, detail) as (
  select 0, 'compared against snapshot',
         case when (select count(*) from snap) = 1 then 'INFO' else 'FAIL' end,
         coalesce((select '#' || id || ' "' || label || '" taken ' || to_char(taken_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') ||
                          ' UTC, ' || (summary ->> 'rows') || ' rows' from snap),
                  'no snapshot — run supabase/billing_snapshot.sql before the migration')

  -- A. the migration completed
  union all
  select 10, 'A. every function the migration installs exists',
         case when (select count(*) from expected_fns where to_regprocedure(sig) is null) = 0 then 'PASS' else 'FAIL' end,
         coalesce('missing: ' || (select string_agg(sig, ', ') from expected_fns where to_regprocedure(sig) is null),
                  (select count(*) from expected_fns)::text || ' of ' || (select count(*) from expected_fns)::text)
  union all
  select 11, 'A. every table, column and view the migration installs exists',
         case when to_regclass('public.billing_customers') is not null and to_regclass('public.billing_checkout_sessions') is not null
                   and to_regclass('public.billing_sync_log') is not null and to_regclass('public.billing_alerts') is not null
                   and to_regclass('public.billing_sweep_state') is not null and to_regclass('public.billing_diagnostics') is not null
                   and to_regclass('public.billing_open_alerts') is not null
                   and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions'
                         and column_name in ('stripe_synced_at', 'sync_source', 'livemode', 'last_event_at', 'last_event_id')) = 5
                   and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'stripe_events'
                         and column_name in ('attempts', 'last_delivery_at', 'processed_at', 'last_error', 'resolved_how', 'livemode')) = 6
              then 'PASS' else 'FAIL' end,
         'billing_customers, billing_checkout_sessions, billing_sync_log, billing_alerts, billing_sweep_state, ' ||
         'billing_diagnostics, billing_open_alerts; subscriptions +5 columns; stripe_events +6 columns'

  -- B. no existing row rewritten
  union all
  select 20, 'B. no subscriptions row was rewritten',
         case when (select count(*) from snap) = 0 then 'FAIL'
              when exists (select 1 from cmp where in_snapshot and not in_table) then 'FAIL'
              when exists (select 1 from cmp where in_snapshot and in_table and not same and not app_wrote) then 'FAIL'
              when exists (select 1 from cmp where in_snapshot and in_table and not same and app_wrote) then 'WARN'
              else 'PASS' end,
         'unchanged ' || (select count(*) from cmp where in_snapshot and in_table and same)::text ||
         ' · changed by the application since the snapshot ' || (select count(*) from cmp where in_snapshot and in_table and not same and app_wrote)::text ||
         ' · changed WITHOUT the application ' || (select count(*) from cmp where in_snapshot and in_table and not same and not app_wrote)::text ||
         ' · gone ' || (select count(*) from cmp where in_snapshot and not in_table)::text ||
         ' · new since the snapshot ' || (select count(*) from cmp where in_table and not in_snapshot)::text ||
         coalesce(' · rows: ' || (select string_agg(uid, ', ') from masked where in_snapshot and (not in_table or not same)), '')
  union all
  select 21, 'B. accounts granted access: before vs after (the paying-users count)',
         case when (select (summary ->> 'granting_access')::int from snap)
                   = (select count(*) from public.subscriptions where public.billing_row_grants_access(status, price_id, current_period_end, now()))
              then 'PASS'
              when exists (select 1 from cmp where not same and app_wrote) or exists (select 1 from cmp where in_table and not in_snapshot)
              then 'WARN' else 'FAIL' end,
         'before ' || coalesce((select summary ->> 'granting_access' from snap), '?') ||
         ' (Stripe-backed ' || coalesce((select summary ->> 'paying_stripe_backed' from snap), '?') || ')' ||
         ' · after ' || (select count(*) from public.subscriptions where public.billing_row_grants_access(status, price_id, current_period_end, now()))::text ||
         ' (Stripe-backed ' || (select count(*) from public.subscriptions where stripe_subscription_id is not null
                                  and public.billing_row_grants_access(status, price_id, current_period_end, now()))::text || ')'

  -- C. every comp row (the hand-made comp_trial included) keeps its meaning
  union all
  select 30, 'C. every comp_trial / owner_comp row is unchanged and grants exactly what it granted',
         case when not exists (select 1 from cmp where was_price in ('comp_trial', 'owner_comp')) then 'INFO'
              when exists (select 1 from cmp where was_price in ('comp_trial', 'owner_comp')
                             and (not in_table or not same
                                  or public.billing_row_grants_access(now_status, now_price, now_pe, now())
                                     is distinct from coalesce((was_status = 'active' and coalesce(was_price, '') = 'owner_comp')
                                        or (was_status in ('active', 'trialing') and (was_pe is null or was_pe >= now()))
                                        or (was_status = 'past_due' and (was_pe is null or now() - was_pe < interval '21 days')), false)))
              then 'FAIL' else 'PASS' end,
         coalesce((select string_agg(m.uid || ' ' || coalesce(m.now_status, '(gone)') || '/' || coalesce(m.now_price, '-') ||
                                     ' until ' || coalesce(to_char(m.now_pe at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), 'no end') ||
                                     ' cancel_at_end ' || coalesce(m.now_cancel::text, '-') ||
                                     ' → access ' || coalesce(public.billing_row_grants_access(m.now_status, m.now_price, m.now_pe, now())::text, 'false'),
                                     ' · ' order by m.uid)
                     from masked m where m.was_price in ('comp_trial', 'owner_comp')), 'no comp rows')

  -- D. the rule
  union all
  select 40, 'D. billing_row_grants_access() answers every business case correctly',
         case when not exists (select 1 from rule_results where got is distinct from expect) then 'PASS' else 'FAIL' end,
         (select string_agg(k || ' → ' || coalesce(got::text, 'null') || case when got is distinct from expect then ' (EXPECTED ' || expect::text || ')' else '' end,
                            ' · ' order by k) from rule_results)
  union all
  select 41, 'D. the rule is immutable (pure: same row, same instant, same answer)',
         case when (select provolatile from pg_proc where oid = to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)')) = 'i'
              then 'PASS' else 'FAIL' end, ''

  -- E. the other copy of the rule agrees
  union all
  select 50, 'E. community_is_entitled() agrees with the rule for every account',
         case when to_regprocedure('public.community_is_entitled(uuid)') is null then 'INFO'
              when (select count(*) from public.subscriptions s
                     where public.community_is_entitled(s.user_id)
                           is distinct from public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())) = 0
                   and pg_get_functiondef(to_regprocedure('public.community_is_entitled(uuid)')) like '%billing_row_grants_access%'
              then 'PASS' else 'FAIL' end,
         case when to_regprocedure('public.community_is_entitled(uuid)') is null then 'not installed on this project'
              else 'disagreements ' || (select count(*) from public.subscriptions s
                     where public.community_is_entitled(s.user_id)
                           is distinct from public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))::text ||
                   ' of ' || (select count(*) from public.subscriptions)::text ||
                   '; defers to billing_row_grants_access: ' ||
                   (pg_get_functiondef(to_regprocedure('public.community_is_entitled(uuid)')) like '%billing_row_grants_access%')::text end

  -- F. the reader's door
  union all
  select 60, 'F. my_billing_access(): no argument, security definer, signed-in readers only',
         case when to_regprocedure('public.my_billing_access()') is not null
                   and (select prosecdef and pronargs = 0 from pg_proc where oid = to_regprocedure('public.my_billing_access()'))
                   and has_function_privilege('authenticated', to_regprocedure('public.my_billing_access()'), 'execute')
                   and not has_function_privilege('anon', to_regprocedure('public.my_billing_access()'), 'execute')
              then 'PASS' else 'FAIL' end,
         'behaviour as a signed-in reader (own decision only, never another account''s) is checked by tools/billing/sql/rls_probe.psql'
  union all
  select 61, 'F. the decision agrees with the rule for every account (billing_access_for)',
         case when (select count(*) from public.subscriptions s
                     where (public.billing_access_for(s.user_id, now()) ->> 'has_access')::boolean
                           is distinct from public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())) = 0
              then 'PASS' else 'FAIL' end,
         'disagreements ' || (select count(*) from public.subscriptions s
                     where (public.billing_access_for(s.user_id, now()) ->> 'has_access')::boolean
                           is distinct from public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))::text

  -- G. nobody else can call the writers
  union all
  select 70, 'G. no client role can run a billing writer, resolver or service function',
         case when exists (select 1 from service_only_fns where to_regprocedure(sig) is not null
                             and (has_function_privilege('anon', to_regprocedure(sig), 'execute')
                                  or has_function_privilege('authenticated', to_regprocedure(sig), 'execute')))
              then 'FAIL' else 'PASS' end,
         coalesce('CALLABLE BY A CLIENT: ' || (select string_agg(sig, ', ') from service_only_fns where to_regprocedure(sig) is not null
                             and (has_function_privilege('anon', to_regprocedure(sig), 'execute')
                                  or has_function_privilege('authenticated', to_regprocedure(sig), 'execute'))),
                  (select count(*) from service_only_fns)::text || ' functions, service role only')
  union all
  select 71, 'G. operator functions refuse anon and check the operator list inside',
         case when not exists (select 1 from (values ('public.billing_admin_lookup(text)'), ('public.billing_admin_overview()'),
                                     ('public.billing_admin_link_customer(uuid,text)'), ('public.billing_admin_resolve_alert(bigint,text)')) x(sig)
                                where has_function_privilege('anon', to_regprocedure(x.sig), 'execute')
                                   or pg_get_functiondef(to_regprocedure(x.sig)) not like '%billing_is_admin()%')
              then 'PASS' else 'FAIL' end, 'billing_admin_lookup, _overview, _link_customer, _resolve_alert'
  union all
  select 72, 'G. every SECURITY DEFINER billing function pins its search_path',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prosecdef
                              and (p.proname like 'billing\_%' or p.proname like 'stripe\_%' or p.proname in ('my_billing_access', 'community_is_entitled'))
                              and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
              then 'FAIL' else 'PASS' end,
         coalesce((select 'NO search_path: ' || string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prosecdef
                      and (p.proname like 'billing\_%' or p.proname like 'stripe\_%' or p.proname in ('my_billing_access', 'community_is_entitled'))
                      and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')), 'all pinned')

  -- H. the new records are service-only
  union all
  select 80, 'H. billing tables and views: RLS on, no anon / authenticated privilege',
         case when exists (select 1 from service_tables t join pg_class c on c.oid = to_regclass(t.rel)
                            where has_table_privilege('anon', c.oid, 'select,insert,update,delete')
                               or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
                               or (c.relkind = 'r' and not c.relrowsecurity))
              then 'FAIL' else 'PASS' end,
         coalesce('EXPOSED: ' || (select string_agg(t.rel, ', ') from service_tables t join pg_class c on c.oid = to_regclass(t.rel)
                            where has_table_privilege('anon', c.oid, 'select,insert,update,delete')
                               or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
                               or (c.relkind = 'r' and not c.relrowsecurity)), 'none exposed')
  union all
  select 81, 'H. subscriptions: still read-own-row only, still unwritable by clients',
         case when not has_table_privilege('authenticated', 'public.subscriptions', 'insert,update,delete')
                   and not has_table_privilege('anon', 'public.subscriptions', 'select,insert,update,delete')
                   and (select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass)
              then 'PASS' else 'FAIL' end, ''
  union all
  select 82, 'H. the billing_ops records are private',
         case when not has_schema_privilege('anon', 'billing_ops', 'usage')
                   and not has_schema_privilege('authenticated', 'billing_ops', 'usage')
              then 'PASS' else 'FAIL' end, 'schema billing_ops: no usage for anon / authenticated'

  -- I. the unique index
  union all
  select 90, 'I. one row per Stripe subscription (subscriptions_stripe_subscription_uk)',
         case when to_regclass('public.subscriptions_stripe_subscription_uk') is not null then 'PASS' else 'FAIL' end,
         case when to_regclass('public.subscriptions_stripe_subscription_uk') is not null
              then 'created: unique on stripe_subscription_id where not null'
              else 'NOT created — some subscription id sits on two accounts (see the preflight, row 402)' end

  -- what the migration linked and resolved on its own
  union all
  select 95, 'backfill: customers linked, deliveries resolved retroactively, alerts open', 'INFO',
         'billing_customers ' || (select count(*) from public.billing_customers)::text ||
         ' (accounts ' || (select count(distinct user_id) from public.billing_customers)::text || ')' ||
         ' · deliveries resolved retroactively ' || (select count(*) from public.stripe_events where resolved_how like 'retroactive%')::text ||
         ' · unresolved (14 days) ' || (select count(*) from public.stripe_events where not resolved and created_at > now() - interval '14 days')::text ||
         ' · open alerts ' || coalesce((select jsonb_object_agg(kind, n)::text from (
                                 select kind, count(*) n from public.billing_alerts where resolved_at is null group by kind) t), '{}')
),
run as (select nextval('billing_ops.run_seq') as id),
saved as (
  insert into billing_ops.check_runs (run_id, kind, n, item, verdict, detail)
  select run.id, 'postflight', c.n, c.item, c.verdict, c.detail from checks c, run
  returning run_id, n, item, verdict, detail
)
select run_id, n, item, verdict, detail from saved order by n;
