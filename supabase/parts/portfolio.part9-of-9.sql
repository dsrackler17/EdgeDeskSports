-- portfolio -- part 9 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the six portfolio tables and the credentials table exist' as item,
    case when (select count(*) from pg_tables where schemaname = 'public' and tablename in ('platform_accounts', 'portfolio_positions',
      'portfolio_transactions', 'portfolio_imports', 'portfolio_import_rows', 'portfolio_sync_logs')) = 6
      and to_regclass('portfolio_private.platform_credentials') is not null then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'row level security is on everywhere',
    case when (select count(*) from pg_tables where ((schemaname = 'public' and tablename in ('platform_accounts', 'portfolio_positions',
      'portfolio_transactions', 'portfolio_imports', 'portfolio_import_rows', 'portfolio_sync_logs'))
      or (schemaname = 'portfolio_private' and tablename = 'platform_credentials')) and rowsecurity) = 7 then 'ok' else 'CHECK THIS — RLS is off on a table' end
  union all select 3, 'every reader policy is keyed to auth.uid()',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename like any (array['platform_accounts', 'portfolio\_%'])
      and coalesce(qual, with_check) like '%user_id = auth.uid()%') = 22 then 'ok' else 'CHECK THIS — a policy is missing or not owner-scoped' end
  union all select 4, 'anon can read nothing',
    case when not has_table_privilege('anon', 'public.portfolio_positions', 'select') and not has_table_privilege('anon', 'public.platform_accounts', 'select')
      and not has_table_privilege('anon', 'public.portfolio_transactions', 'select') and not has_table_privilege('anon', 'public.portfolio_sync_logs', 'select')
      then 'ok' else 'CHECK THIS — anon holds a privilege' end
  union all select 5, 'no client role can reach the credentials schema',
    case when not has_schema_privilege('authenticated', 'portfolio_private', 'usage') and not has_schema_privilege('anon', 'portfolio_private', 'usage')
      then 'ok' else 'CHECK THIS — the credentials schema is reachable' end
  union all select 6, 'a manual or CSV account can never read "connected"',
    case when exists (select 1 from pg_constraint where conname = 'platform_accounts_status_honest') then 'ok' else 'CHECK THIS' end
  union all select 7, 'readers cannot change an account''s connection state',
    case when has_column_privilege('authenticated', 'public.platform_accounts', 'display_name', 'update')
      and not has_column_privilege('authenticated', 'public.platform_accounts', 'status', 'update')
      and not has_column_privilege('authenticated', 'public.platform_accounts', 'sync_cursor', 'update') then 'ok' else 'CHECK THIS' end
  union all select 8, 'P&L is derived by trigger, and fills are checked at commit',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_positions_derive_trg' and not tgisinternal)
      and exists (select 1 from pg_trigger where tgname = 'portfolio_positions_fills_trg' and tgdeferrable and tginitdeferred)
      and exists (select 1 from pg_trigger where tgname = 'portfolio_transactions_rollup_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select 9, 'a record is stored once: by platform id, else by fingerprint',
    case when (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('portfolio_positions_external_once',
      'portfolio_positions_fingerprint_once', 'portfolio_transactions_external_once', 'portfolio_transactions_fingerprint_once')) = 4
      then 'ok' else 'CHECK THIS' end
  union all select 10, 'fills and positions cannot point at another reader''s rows',
    case when (select count(*) from pg_constraint where conname in ('portfolio_transactions_position_fk', 'portfolio_positions_account_fk',
      'portfolio_import_rows_import_fk', 'platform_credentials_account_fk') and array_length(conkey, 1) = 2) = 4 then 'ok' else 'CHECK THIS' end
  union all select 11, 'the account summary runs as the caller',
    case when (select coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'portfolio_account_summary') = 'true'
      then 'ok' else 'CHECK THIS — the view would read every reader''s rows' end
  union all select 12, 'sync logs: readers append their own CSV and manual entries only',
    case when not has_table_privilege('authenticated', 'public.portfolio_sync_logs', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_sync_logs', 'delete') then 'ok' else 'CHECK THIS' end
  union all select 13, 'the arithmetic: $100 at -110 wins $90.91; $100 at +150 wins $150',
    case when public.portfolio_wager_profit(100, -110, null) = 90.91 and public.portfolio_wager_profit(100, 150, null) = 150
      and public.portfolio_wager_profit(100, null, 1.91) = 91 and public.portfolio_div_round(-5, 2, 0) = -3 then 'ok' else 'CHECK THIS' end
  union all select 14, 'the fingerprint text rule: "Chiefs vs. Bills" = "chiefs @ bills"',
    case when public.portfolio_norm_text('  Chiefs  vs. Bills ') = 'chiefs @ bills' and public.portfolio_norm_text('Mbappé') = 'mbappe'
      then 'ok' else 'CHECK THIS — the server encoding must be UTF8' end
  union all select 15, 'the operator view and the entry points are closed to anon',
    case when not has_function_privilege('anon', 'public.portfolio_admin_sync_health(integer)', 'execute')
      and not has_function_privilege('anon', 'public.portfolio_import_commit(uuid,integer)', 'execute')
      and has_function_privilege('authenticated', 'public.portfolio_import_commit(uuid,integer)', 'execute') then 'ok' else 'CHECK THIS' end
) r order by 1;

