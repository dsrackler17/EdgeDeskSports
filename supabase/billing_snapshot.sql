-- ===========================================================================
-- EdgeDesk — billing SNAPSHOT: the before-state a billing deployment is
-- compared against, and the reference a rollback starts from
-- (docs/billing-hardening.md §9a).
--
-- WHY IN THE DATABASE. The deploy workflow's logs are public (so is this
-- repository), and a rollback reference that is any good holds every account's
-- row in full. So the full copy lives HERE, in a private schema no client role
-- can reach, and the logs carry only counts and masked ids.
--
-- It writes ONLY to schema billing_ops: one row in billing_ops.snapshots. It
-- reads public.subscriptions, public.stripe_events and the catalogs, and never
-- writes to them. Idempotent; run it as often as you like.
--
--   set billing.snapshot_label = 'pre-apply';   -- optional, default 'manual'
--
-- The deploy workflow also passes billing.deployed_functions, the Edge Function
-- versions it read from the Supabase Management API; in the SQL editor that is
-- simply left empty.
-- ===========================================================================

create schema if not exists billing_ops;
revoke all on schema billing_ops from public;
do $r$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema billing_ops from anon, authenticated';
  end if;
end
$r$;
comment on schema billing_ops is
  'Billing deployment records (snapshots, verification runs). Private: no client role has usage; '
  'not in PostgREST''s exposed schemas. Written by supabase/billing_snapshot.sql and billing_postflight.sql.';

create table if not exists billing_ops.snapshots (
  id            bigint      generated always as identity primary key,
  taken_at      timestamptz not null default now(),
  label         text        not null,
  taken_by      text        not null default current_user,
  summary       jsonb       not null,
  subscriptions jsonb       not null,   -- every row of public.subscriptions, every column
  schema_state  jsonb       not null,   -- indexes, policies, client privileges, functions, cron jobs
  deployed      jsonb                   -- Edge Function versions, when the workflow passes them
);
create table if not exists billing_ops.check_runs (
  id      bigint      generated always as identity primary key,
  run_id  bigint      not null,
  at      timestamptz not null default now(),
  kind    text        not null,
  n       integer     not null,
  item    text        not null,
  verdict text        not null,
  detail  text
);
create index if not exists check_runs_by_run on billing_ops.check_runs (run_id, n);
-- The SOURCE of an Edge Function as production was running it, saved by
-- tools/billing/deploy_stage.sh immediately before it deploys over it. This is
-- what rollback_stripe_webhook restores: production's webhook was pasted in by
-- hand and is not a build that exists anywhere in git.
create table if not exists billing_ops.function_backups (
  id        bigint      generated always as identity primary key,
  saved_at  timestamptz not null default now(),
  slug      text        not null,
  build     text,
  version   integer,
  sha256    text        not null,
  source    text        not null
);
create index if not exists function_backups_by_slug on billing_ops.function_backups (slug, id desc);
create sequence if not exists billing_ops.run_seq;
alter table billing_ops.snapshots  enable row level security;
alter table billing_ops.check_runs enable row level security;
alter table billing_ops.function_backups enable row level security;
revoke all on all tables in schema billing_ops from public;
revoke all on all sequences in schema billing_ops from public;
do $r$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema billing_ops from anon, authenticated';
    execute 'revoke all on all sequences in schema billing_ops from anon, authenticated';
  end if;
end
$r$;

with
s as (
  select s.*,
         coalesce((s.status = 'active' and coalesce(s.price_id, '') = 'owner_comp')
                  or (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end >= now()))
                  or (s.status = 'past_due' and (s.current_period_end is null or now() - s.current_period_end < interval '21 days')),
                  false) as entitled
    from public.subscriptions s
),
summary as (
  select jsonb_build_object(
    'rows', (select count(*) from s),
    'by_status', coalesce((select jsonb_object_agg(coalesce(status, '(null)'), n) from (
                   select status, count(*) n from s group by 1) t), '{}'::jsonb),
    'granting_access', (select count(*) from s where entitled),
    'paying_stripe_backed', (select count(*) from s where entitled and stripe_subscription_id is not null),
    'comp_trial', (select count(*) from s where price_id = 'comp_trial'),
    'comp_trial_valid', (select count(*) from s where price_id = 'comp_trial' and entitled),
    'owner_comp', (select count(*) from s where price_id = 'owner_comp'),
    'unresolved_events_all', (select count(*) from public.stripe_events where not resolved),
    'unresolved_events_14d', (select count(*) from public.stripe_events where not resolved and created_at > now() - interval '14 days'),
    'last_delivery', (select max(created_at) from public.stripe_events),
    'fingerprint', (select md5(string_agg(concat_ws('|', user_id, status, price_id, current_period_end, cancel_at_period_end,
                                                     stripe_customer_id, stripe_subscription_id,
                                                     to_jsonb(s) ->> 'last_event_id', (to_jsonb(s) ->> 'last_event_at')::timestamptz),
                                           E'\n' order by user_id)) from s),
    'hardening_installed', to_regprocedure('public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean)') is not null
  ) as j
),
schema_state as (
  select jsonb_build_object(
    'indexes', coalesce((select jsonb_agg(jsonb_build_object('table', tablename, 'index', indexname, 'def', indexdef) order by tablename, indexname)
                           from pg_indexes where schemaname = 'public'
                            and (tablename in ('subscriptions', 'stripe_events', 'billing_consents') or tablename like 'billing\_%')), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'cmd', cmd,
                            'roles', roles, 'using', qual, 'check', with_check) order by tablename, policyname)
                            from pg_policies where schemaname = 'public'
                             and (tablename in ('subscriptions', 'stripe_events', 'billing_consents') or tablename like 'billing\_%')), '[]'::jsonb),
    'client_privileges', coalesce((select jsonb_object_agg(c.relname, jsonb_build_object(
                            'rls', c.relrowsecurity,
                            'anon', has_table_privilege('anon', c.oid, 'select,insert,update,delete'),
                            'authenticated_select', has_table_privilege('authenticated', c.oid, 'select'),
                            'authenticated_write', has_table_privilege('authenticated', c.oid, 'insert,update,delete')))
                            from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind in ('r', 'v')
                             and (c.relname in ('subscriptions', 'stripe_events', 'billing_consents', 'stripe_events_unresolved')
                                  or c.relname like 'billing\_%')), '{}'::jsonb),
    'functions', coalesce((select jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text, 'security_definer', p.prosecdef,
                            'config', p.proconfig, 'anon', has_function_privilege('anon', p.oid, 'execute'),
                            'authenticated', has_function_privilege('authenticated', p.oid, 'execute'), 'md5', md5(p.prosrc))
                            order by p.oid::regprocedure::text)
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public'
                             and (p.proname like 'billing\_%' or p.proname like 'stripe\_%'
                                  or p.proname in ('my_billing_access', 'community_is_entitled'))), '[]'::jsonb),
    'cron_jobs', case when to_regclass('cron.job') is null then null
                      when not has_table_privilege(to_regclass('cron.job'), 'select') then null
                      else (select coalesce(jsonb_agg(x::text), '[]'::jsonb) from unnest(xpath('//row/x/text()',
                              query_to_xml('select jobname || '' ['' || schedule || '', active '' || active::text || '']'' as x from cron.job ' ||
                                           'where jobname ilike ''%billing%'' or command ilike ''%sync_subscription%'' or command ilike ''%stripe%''',
                                           false, false, ''))) x) end
  ) as j
)
insert into billing_ops.snapshots (label, summary, subscriptions, schema_state, deployed)
select coalesce(nullif(current_setting('billing.snapshot_label', true), ''), 'manual'),
       (select j from summary),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.user_id) from public.subscriptions x), '[]'::jsonb),
       (select j from schema_state),
       nullif(current_setting('billing.deployed_functions', true), '')::jsonb
returning id as snapshot_id, taken_at, label,
          summary ->> 'rows' as rows, summary ->> 'granting_access' as granting_access,
          summary ->> 'paying_stripe_backed' as paying_stripe_backed, summary ->> 'comp_trial_valid' as comp_trial_valid,
          summary ->> 'owner_comp' as owner_comp, summary ->> 'unresolved_events_14d' as unresolved_14d,
          summary ->> 'fingerprint' as fingerprint;
