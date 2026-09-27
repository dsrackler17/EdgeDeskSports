-- cfb_lab -- part 7 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ================================================================= report
with tables(t) as (
  values ('cfb_lab_predictions'),('cfb_lab_market_quotes'),('cfb_lab_market_lines'),('cfb_lab_event_map'),
         ('cfb_lab_results'),('cfb_lab_evaluations'),('cfb_lab_miss_reviews'),('cfb_lab_model_roles'),
         ('cfb_lab_experiments'),('cfb_lab_audit_log'),('cfb_lab_partitions'),('cfb_lab_research_queue'),
         ('cfb_lab_reports')
), roles as (
  select exists (select 1 from pg_roles where rolname = 'anon') as has_anon,
         exists (select 1 from pg_roles where rolname = 'authenticated') as has_auth
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only (update/delete/truncate triggers), row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg
                     where tg.tgrelid = to_regclass('public.' || t)
                       and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'validation triggers (prediction clock, CLOSE timing, result supersedes, one champion)',
         case when (select count(*) from pg_trigger where tgname in ('cfb_lab_predictions_guard_trg',
                     'cfb_lab_market_lines_guard_trg','cfb_lab_results_guard_trg','cfb_lab_model_roles_guard_trg')) = 4
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'one prediction per game, model, checkpoint and origin (ADHOC excepted)',
         case when to_regclass('public.cfb_lab_pred_checkpoint_slot') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'functions: cfb_lab_h, cfb_lab_ts, cfb_lab_num, cfb_lab_ingest_quotes, cfb_lab_derive_lines, cfb_lab_set_role',
         case when to_regprocedure('public.cfb_lab_h(text[])') is not null
               and to_regprocedure('public.cfb_lab_ts(timestamptz)') is not null
               and to_regprocedure('public.cfb_lab_num(numeric)') is not null
               and to_regprocedure('public.cfb_lab_ingest_quotes(jsonb)') is not null
               and to_regprocedure('public.cfb_lab_derive_lines(timestamptz)') is not null
               and to_regprocedure('public.cfb_lab_set_role(text,text,text,text,text)') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'views: current_roles, official_predictions, current_results, current_evaluations, consensus_now, public_record, public_summary',
         case when to_regclass('public.cfb_lab_current_roles') is not null
               and to_regclass('public.cfb_lab_official_predictions') is not null
               and to_regclass('public.cfb_lab_current_results') is not null
               and to_regclass('public.cfb_lab_current_evaluations') is not null
               and to_regclass('public.cfb_lab_consensus_now') is not null
               and to_regclass('public.cfb_lab_public_record') is not null
               and to_regclass('public.cfb_lab_public_summary') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 6, 'anon can read cfb_lab_public_record and cfb_lab_public_summary (owner-run views)',
         case when not (select has_anon from roles) then 'CHECK THIS'
              when coalesce(has_table_privilege('anon', to_regclass('public.cfb_lab_public_record'), 'select'), false)
               and coalesce(has_table_privilege('anon', to_regclass('public.cfb_lab_public_summary'), 'select'), false)
               and (select count(*) from pg_class c
                     where c.oid in (to_regclass('public.cfb_lab_public_record'), to_regclass('public.cfb_lab_public_summary'))
                       and coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=false%') = 2
              then 'ok' else 'CHECK THIS' end
  union all
  select 7, 'anon can read no cfb_lab_ table and no internal view',
         case when not (select has_anon from roles) then 'CHECK THIS'
              when not exists (select 1 from tables
                                where coalesce(has_table_privilege('anon', to_regclass('public.' || t), 'select'), true))
               and not exists (select 1 from unnest(array['cfb_lab_current_roles','cfb_lab_official_predictions',
                                 'cfb_lab_current_results','cfb_lab_current_evaluations','cfb_lab_consensus_now',
                                 'cfb_lab_major_disagreements']) v
                                where coalesce(has_table_privilege('anon', to_regclass('public.' || v), 'select'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 8, 'authenticated reads every cfb_lab_ table and writes none',
         case when not (select has_auth from roles) then 'CHECK THIS'
              when not exists (select 1 from tables
                                where not coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'select'), false)
                                   or coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'insert,update,delete,truncate'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 9, 'the writer functions are not callable by anon or authenticated',
         case when not (select has_anon and has_auth from roles) then 'CHECK THIS'
              when not exists (
                select 1 from unnest(array['public.cfb_lab_ingest_quotes(jsonb)','public.cfb_lab_derive_lines(timestamptz)',
                                           'public.cfb_lab_set_role(text,text,text,text,text)']) f, unnest(array['anon','authenticated']) r
                 where coalesce(has_function_privilege(r, to_regprocedure(f), 'execute'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 10, 'id hash self-check: cfb_lab_h(''a'', null, ''-3.5'') = 899792685a3d892fa74c18f2 (sha256 of ''a||-3.5'')',
         case when public.cfb_lab_h('a', null, '-3.5') = '899792685a3d892fa74c18f2' then 'ok' else 'CHECK THIS' end
  union all
  select 11, 'rendering self-check: -3.50 -> -3.5, 110.00 -> 110, 0.00 -> 0, timestamps in UTC with milliseconds',
         case when public.cfb_lab_num(-3.50) = '-3.5' and public.cfb_lab_num(110.00) = '110' and public.cfb_lab_num(0.00) = '0'
               and public.cfb_lab_ts('2025-10-04 15:30:00-04'::timestamptz) = '2025-10-04T19:30:00.000Z'
              then 'ok' else 'CHECK THIS' end
  union all
  select 12, 'median self-check: lines -3 and -3.5 -> -3.25; prices -105 and +105 -> +100, -110 and -105 -> -107 (decimal-odds space)',
         case when public.cfb_lab_median(array[-3, -3.5]::numeric[]) = -3.25
               and public.cfb_lab_median_price(array[-105, 105]) = 100
               and public.cfb_lab_median_price(array[-110, -105]) = -107
              then 'ok' else 'CHECK THIS' end
  union all
  select 13, 'the major-disagreement verdict: columns on cfb_lab_predictions, their constraints, and the cfb_lab_major_disagreements view',
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'cfb_lab_predictions'
                     and column_name in ('disagreement_version','disagreement_status','disagreement_tier','verified_market_gap',
                                         'calibrated_market_gap','disagreement_root_cause','disagreement_checks')) = 7
               and (select count(*) from pg_constraint where conname in ('cfb_lab_pred_disagreement_status','cfb_lab_pred_verified_gap')) = 2
               and to_regclass('public.cfb_lab_major_disagreements') is not null
              then 'ok' else 'CHECK THIS' end
) x
order by ord, check_name;

