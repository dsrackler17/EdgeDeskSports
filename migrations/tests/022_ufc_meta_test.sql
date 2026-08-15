-- ============================================================================
-- 022_ufc_meta_test.sql — behaviour test for the UFC build ledger.
--
-- Run against a scratch database AFTER 022_ufc_meta.sql:
--   psql -f migrations/022_ufc_meta.sql -f migrations/tests/022_ufc_meta_test.sql
--
-- Step 6 MUST fail with a check-constraint error. Every other step must
-- succeed. Read the output — this file asserts nothing on its own.
-- ============================================================================

\echo '=== 1) a fresh install publishes NO build time (app must say so) ==='
truncate ufc.meta;
truncate ufc.build_log;
select count(*) as meta_rows_expect_0 from ufc.meta;

\echo '=== 2) a FAILED run records the failure and publishes no built_at ==='
select ufc.stamp_build('ufcstats_sync', null, 'UFCStats', '{}'::jsonb, 'HTTP 503 from upstream');
select key, value from ufc.meta order by key;
select 'built_at present after failure (expect f)' as check,
       exists(select 1 from ufc.meta where key='built_at') as result;

\echo '=== 3) a SUCCESSFUL run publishes built_at, row count and source ==='
select ufc.stamp_build('ufcstats_sync', 4679, 'UFCStats', '{"schema_version":"1"}'::jsonb);
select key, value from ufc.meta order by key;

\echo '=== 4) built_at is ISO-8601 UTC, i.e. parseable by every JS engine ==='
select 'built_at is ISO-8601Z' as check,
       value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$' as result
  from ufc.meta where key='built_at';

\echo '=== 5) a later FAILING job must not roll built_at back ==='
select value as built_at_before from ufc.meta where key='built_at';
select ufc.stamp_build('ufc_fighters_sync', null, 'Kaggle backfill', '{}'::jsonb, 'timeout');
select value as built_at_after from ufc.meta where key='built_at';
select job, status, rows_written, error from ufc.pipeline_health order by job;

\echo '=== 6) MUST ERROR — an unknown status is rejected by the constraint ==='
insert into ufc.build_log(job, status) values ('bogus', 'banana');

\echo '(step 6 passes only if an ERROR line appears directly above this one)'

\echo '=== 7) the live poller records its run WITHOUT advancing built_at ==='
select value as built_at_before from ufc.meta where key='built_at';
select ufc.stamp_build('ufc_live', 12, 'ESPN + capture', '{}'::jsonb, null, false);
select value as built_at_after_live_run from ufc.meta where key='built_at';
select key, value from ufc.meta where key like 'ufc_live%' order by key;

\echo '=== 8) the app role cannot stamp a build time (execute is revoked) ==='
select has_function_privilege('authenticated',
  'ufc.stamp_build(text,integer,text,jsonb,text,boolean)', 'execute') as authenticated_can_stamp_expect_f;
