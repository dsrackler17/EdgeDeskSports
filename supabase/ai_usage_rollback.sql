-- =============================================================================
-- ROLLBACK of supabase/ai_usage.sql.
--
-- Removes the three functions and the operator's view. With the claim
-- function gone, edgedesk_ai answers a claim's 404 as "unmetered" and falls
-- back to its per-isolate rate limit (30/min, 300/h) exactly as before the
-- file was applied.
--
-- THE LEDGER IS KEPT. ai_usage_events and ai_usage_policy hold records, and
-- no script in this repository deletes records; drop them by hand only after
-- deciding they are not wanted. Re-applying ai_usage.sql picks them up again.
-- Idempotent, no psql meta-commands, ends in a report.
-- =============================================================================

drop function if exists public.ai_usage_claim(text, int);
drop function if exists public.ai_usage_settle(bigint, text, text, int, int, int);
drop function if exists public.my_ai_usage();
drop view if exists public.ai_usage_daily;

notify pgrst, 'reload schema';

select 'claim function removed' as piece, case when to_regprocedure('public.ai_usage_claim(text,integer)') is null then 'ok' else 'CHECK THIS' end as state
union all select 'settle function removed', case when to_regprocedure('public.ai_usage_settle(bigint,text,text,integer,integer,integer)') is null then 'ok' else 'CHECK THIS' end
union all select 'ledger kept (ai_usage_events is never dropped by a script)', 'ok';
