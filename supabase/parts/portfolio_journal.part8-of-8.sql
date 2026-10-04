-- portfolio_journal -- part 8 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

create policy portfolio_facts_cache_own on public.portfolio_facts_cache for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_facts_cache_state_own on public.portfolio_facts_cache_state;
create policy portfolio_facts_cache_state_own on public.portfolio_facts_cache_state for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.portfolio_facts_cache, public.portfolio_facts_cache_state from anon, authenticated;
grant select, insert, delete on public.portfolio_facts_cache to authenticated;
grant select, insert, update on public.portfolio_facts_cache_state to authenticated;
grant select, insert, update, delete on public.portfolio_facts_cache, public.portfolio_facts_cache_state to service_role;
-- re-running this file changes the arithmetic the cache was built with
delete from public.portfolio_facts_cache_state;

revoke all on public.portfolio_journal_entries, public.portfolio_rules, public.portfolio_experiments from anon;
revoke all on public.portfolio_journal_entries from authenticated;
grant select, insert, update on public.portfolio_journal_entries to authenticated;
grant select, insert, update, delete on public.portfolio_rules, public.portfolio_experiments to authenticated;
grant select, insert, update, delete on public.portfolio_journal_entries, public.portfolio_rules, public.portfolio_experiments to service_role;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname like 'portfolio\_%' and p.proname not like 'portfolio\_svc\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the journal, rules and experiments tables exist' as item,
    case when (select count(*) from pg_tables where schemaname = 'public'
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments')) = 3 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'row level security is on for all three',
    case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments')) = 3 then 'ok' else 'CHECK THIS — RLS is off' end
  union all select 3, 'every reader policy is keyed to auth.uid()',
    case when (select count(*) from pg_policies where schemaname = 'public'
      and tablename in ('portfolio_journal_entries', 'portfolio_rules', 'portfolio_experiments', 'portfolio_facts_cache', 'portfolio_facts_cache_state')
      and coalesce(qual, with_check) like '%user_id = auth.uid()%') = 13 then 'ok' else 'CHECK THIS — a policy is missing or not owner-scoped' end
  union all select 4, 'anon can read nothing and call nothing',
    case when not has_table_privilege('anon', 'public.portfolio_journal_entries', 'select') and not has_table_privilege('anon', 'public.portfolio_rules', 'select')
      and not has_function_privilege('anon', 'public.portfolio_summary(timestamptz,timestamptz,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_cells(timestamptz,timestamptz,text,text,boolean)', 'execute') then 'ok' else 'CHECK THIS — anon holds a privilege' end
  union all select 5, 'a recorded decision cannot be rewritten (the journal guard is installed)',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_journal_guard_trg' and not tgisinternal)
      and exists (select 1 from pg_trigger where tgname = 'portfolio_positions_journal_ins_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select 6, 'every position has its journal entry',
    case when not exists (select 1 from public.portfolio_positions p where not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id))
      then 'ok' else 'CHECK THIS — run this file again' end
  union all select 7, 'the grade never reads profit or loss (the analytics run as the caller)',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('portfolio_facts', 'portfolio_summary', 'portfolio_cells', 'portfolio_calendar', 'portfolio_periods', 'portfolio_list', 'portfolio_pre_bet')
      and p.prosecdef) and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
      and p.proname in ('portfolio_facts', 'portfolio_summary', 'portfolio_cells', 'portfolio_calendar', 'portfolio_periods', 'portfolio_list', 'portfolio_pre_bet')) = 7
      then 'ok' else 'CHECK THIS — an analytics function is missing or runs as its owner' end
  union all select 8, 'the grade arithmetic: CLV 80 alone grades 80 (A-); a sizing score alone is not a grade',
    case when public.portfolio_process_score(80, null, null, null, null, null, null) = 80 and public.portfolio_grade_letter(80) = 'A-'
      and public.portfolio_process_score(null, null, null, 100, null, null, 80) is null
      and public.portfolio_process_score(70, 60, null, null, null, null, 80) = round((30 * 70 + 20 * 60 + 5 * 80) / 55.0, 1) then 'ok' else 'CHECK THIS' end
  union all select 9, 'CLV: −110 taken, −120 at the close is +4.13% of price; 40¢ taken, 50¢ at the close is +25%',
    case when public.portfolio_clv_pct('SPORTSBOOK', public.portfolio_american_to_decimal(-110), public.portfolio_american_to_decimal(-120)) = 0.041323
      and public.portfolio_clv_pct('PREDICTION_MARKET', 0.40, 0.50) = 0.25 then 'ok' else 'CHECK THIS' end
) r order by 1;

