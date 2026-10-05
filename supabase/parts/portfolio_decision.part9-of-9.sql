-- portfolio_decision -- part 9 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the Decision Record tables exist' as item,
    case when (select count(*) from pg_tables where schemaname = 'public' and tablename in ('portfolio_methodology', 'portfolio_decision_snapshots',
      'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines', 'portfolio_insights',
      'portfolio_insight_observations', 'portfolio_card_events')) = 9 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'row level security is on for every one',
    case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in ('portfolio_methodology',
      'portfolio_decision_snapshots', 'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines',
      'portfolio_insights', 'portfolio_insight_observations', 'portfolio_card_events')) = 9 then 'ok' else 'CHECK THIS — RLS is off' end
  union all select 3, 'every reader policy on reader data is keyed to auth.uid()',
    case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('portfolio_decision_snapshots', 'portfolio_market_path',
      'portfolio_reflections', 'portfolio_outcome_classes', 'portfolio_baselines', 'portfolio_insights', 'portfolio_insight_observations', 'portfolio_card_events')
      and coalesce(qual, with_check) not like '%user_id = auth.uid()%') then 'ok' else 'CHECK THIS — a policy is not owner-scoped' end
  union all select 4, 'no reader can update or delete a snapshot, a path point, a reflection or a class',
    case when not has_table_privilege('authenticated', 'public.portfolio_decision_snapshots', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_decision_snapshots', 'delete')
      and not has_table_privilege('authenticated', 'public.portfolio_market_path', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_reflections', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_outcome_classes', 'update') then 'ok' else 'CHECK THIS — a reader holds a write' end
  union all select 5, 'anon can read nothing and call nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_decision_snapshots', 'select')
      and not has_function_privilege('anon', 'public.portfolio_decision_record(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_export()', 'execute') then 'ok' else 'CHECK THIS — anon holds a privilege' end
  union all select 6, 'the immutability triggers are installed',
    case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('portfolio_snapshot_guard_trg', 'portfolio_path_guard_trg',
      'portfolio_reflections_guard_trg', 'portfolio_outcome_guard_trg', 'portfolio_baseline_guard_trg', 'portfolio_insight_obs_guard_trg',
      'portfolio_card_events_guard_trg', 'portfolio_methodology_guard_trg', 'portfolio_experiments_record_trg')) = 9 then 'ok' else 'CHECK THIS' end
  union all select 7, 'every method in use is published',
    case when (select count(*) from public.portfolio_methodology where version in ('process_v1', 'snapshot_v1', 'context_quality_v1', 'edge_capture_v1',
      'outcome_class_v1', 'baseline_v1', 'insight_v1', 'experiment_v1')) = 8 then 'ok' else 'CHECK THIS — a methodology row is missing' end
  union all select 8, 'the reader functions run as the caller (row level security applies inside them)',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef
      and p.proname in ('portfolio_decision_record', 'portfolio_search', 'portfolio_export', 'portfolio_classify_outcomes', 'portfolio_baseline',
        'portfolio_observe_insight', 'portfolio_insight_memory', 'portfolio_context', 'portfolio_conclude_experiment', 'portfolio_experiment_evidence'))
      then 'ok' else 'CHECK THIS — a reader function runs as its owner' end
  union all select 9, 'context quality: a full snapshot is FULL; reasoning with a price is STRONG; a close alone is PARTIAL; nothing is RESULT_ONLY',
    case when public.portfolio_context_quality(true, true, true, true, true, true) = 'FULL'
      and public.portfolio_context_quality(false, false, false, true, true, false) = 'STRONG'
      and public.portfolio_context_quality(false, false, false, false, false, true) = 'PARTIAL'
      and public.portfolio_context_quality(false, false, false, false, false, false) = 'RESULT_ONLY' then 'ok' else 'CHECK THIS' end
  union all select 10, 'a win at a poor process is a BAD_WIN; a loss at a good one a GOOD_LOSS; no grade is never classified',
    case when public.portfolio_outcome_class('WON', 'WIN', 40, 'STRONG') = 'BAD_WIN' and public.portfolio_outcome_class('LOST', 'LOSS', 80, 'FULL') = 'GOOD_LOSS'
      and public.portfolio_outcome_class('WON', 'WIN', null, 'PARTIAL') = 'NOT_CLASSIFIED' then 'ok' else 'CHECK THIS' end
) r order by 1;

