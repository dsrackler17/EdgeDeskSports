-- =============================================================================
-- ROLLBACK for supabase/odds_quota.sql. Drops exactly what that file created.
--
-- Effect: the capture and close functions find no odds_quota_acquire RPC and
-- fall back to their in-run guards (credit floor, per-run cap, stop on 429 /
-- 401 / repeated timeouts), reporting "quota ledger not installed". No other
-- table is touched. The request ledger's history is lost with it: export it
-- first if you want to keep it, e.g.
--   create table public.odds_quota_requests_archive as table public.odds_quota_requests;
--
-- CONVENTION: idempotent, no psql meta-commands, ends in a report.
-- =============================================================================
drop view if exists public.odds_quota_daily;
drop function if exists public.odds_quota_reset(text, text);
drop function if exists public.odds_quota_status();
drop function if exists public.odds_quota_settle(uuid, text, int, int, int, int, text);
drop function if exists public.odds_quota_acquire(text, text, int, text, text, text, int);
drop function if exists public.odds_quota_interval(text, jsonb);
drop table if exists public.odds_quota_requests;
drop function if exists public.odds_quota_requests_guard();
drop table if exists public.odds_quota_state;
drop table if exists public.odds_quota_config;
notify pgrst, 'reload schema';

select 'odds_quota removed' as piece,
       case when to_regclass('public.odds_quota_requests') is null and to_regclass('public.odds_quota_config') is null
             and to_regprocedure('public.odds_quota_acquire(text,text,int,text,text,text,int)') is null then 'ok' else 'CHECK THIS' end as state;
