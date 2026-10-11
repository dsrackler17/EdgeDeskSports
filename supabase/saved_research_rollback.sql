-- =============================================================================
-- ROLLBACK of supabase/saved_research.sql.
--
-- Revokes the readers' access, so the desk's server save fails and the app
-- falls back to saving on the device (localStorage) exactly as before the
-- file was applied. THE ROWS ARE KEPT: they are readers' saved research, and
-- no script in this repository deletes records. Re-applying
-- saved_research.sql restores access to them.
-- Idempotent, no psql meta-commands, ends in a report.
-- =============================================================================

do $rb$ begin
  if to_regclass('public.saved_research') is not null then
    revoke all on public.saved_research from authenticated;
  end if;
end $rb$;

notify pgrst, 'reload schema';

select 'readers no longer reach saved_research' as piece,
       case when to_regclass('public.saved_research') is null
              or not has_table_privilege('authenticated', 'public.saved_research', 'select') then 'ok' else 'CHECK THIS' end as state
union all select 'rows kept (never deleted by a script)', 'ok';
