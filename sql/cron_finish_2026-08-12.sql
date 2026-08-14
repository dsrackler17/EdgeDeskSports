-- ============================================================================
--  cron_finish_2026-08-12.sql
--  Follow-up to cron_fix_2026-08-12.sql, written against the ACTUAL verification
--  output rather than against expectations. Idempotent.
--
--  What the B7 verification showed had landed:
--    capture back to */10, market_residual scheduled (job 94), and
--    capture_boards / mlb_sync / weather_sync / bullpen_sync / ingest-mlb /
--    learn-nightly all routed through edge_call.
--
--  What it showed had NOT:
--    three jobs still carrying a plaintext service-role JWT, and three pairs of
--    duplicate jobs still both active.
-- ============================================================================


-- ============================================================================
-- PART A — UNDO MY REDUNDANT INDEX
--
-- research_outcomes.user_id already had DEFAULT auth.uid() and NOT NULL, and
-- research_outcomes_signal_uniq already covered (event_id, market, selection,
-- user_id). The index the previous script added is an exact duplicate of it:
-- same columns, same uniqueness. Two identical unique indexes cost write
-- throughput on every upsert and buy nothing.
-- ============================================================================

drop index if exists public.research_outcomes_user_event_market_sel_key;

-- Confirm one unique index remains on that column set (expect exactly one row).
select i.relname as index_name, array_agg(a.attname order by a.attname) as columns
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class t on t.oid = ix.indrelid
join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
where t.relname = 'research_outcomes' and ix.indisunique
group by i.relname
having array_agg(a.attname order by a.attname) = array['event_id','market','selection','user_id'];


-- ============================================================================
-- PART B — WHY research_outcomes IS STILL EMPTY
--
-- The schema is correct, so the cause is upstream of it. Two candidates, and
-- these queries separate them. Do NOT skip to a fix: the two have different
-- repairs and picking wrong wastes the next two weeks the same way the last two
-- were wasted.
-- ============================================================================

-- B1. Are sessions being written at all? edgedesk_ai writes research_sessions
--     first and research_outcomes second, under the same JWT. Sessions present
--     with outcomes absent isolates the failure to the outcome write.
--     Sessions ALSO absent means the whole memory write is failing — most
--     likely auth, which B2 tests.
select
  (select count(*) from public.research_sessions)  as sessions,
  (select max(created_at) from public.research_sessions) as last_session,
  (select count(*) from public.research_outcomes)  as outcomes;

-- B2. THE LIKELY CAUSE. user_id is NOT NULL with DEFAULT auth.uid(), and
--     edgedesk_ai reads and writes under the CALLER's JWT. If the browser calls
--     the function with the anon key rather than a signed-in user's token,
--     auth.uid() returns null and the insert is rejected by the NOT NULL
--     constraint — on every single request, silently, inside the catch.
--     Any session row whose user_id is null proves the caller was anonymous.
select user_id, count(*) as n, min(created_at) as first, max(created_at) as last
from public.research_sessions
group by user_id
order by n desc
limit 10;

-- B3. The other candidate: the write condition was never met.
--     edgedesk_ai only opens an outcome when it has a focused signal WITH an
--     edge. Before the r2 build, `focus` was left null at SLATE depth — which
--     is most questions, including "best bets" — so no outcome was ever
--     recorded for them. r2 attaches a deterministic candidate for best_bets,
--     why, price, attack, what_changed, compare, postmortem and traps.
--     This counts how many sessions COULD have produced an outcome.
select intent, count(*) as sessions, count(event_id) as sessions_with_focus
from public.research_sessions
group by intent
order by sessions desc
limit 20;

-- B4. Fastest check of all, no SQL: ask the app one question, then
--       curl '<project>/functions/v1/edgedesk_ai?probe=1' | jq .last_memory_write
--     The r2 build records the HTTP status of its own outcome write.
--       {"ok":false, detail:"...null value in column \"user_id\"..."}  -> B2
--       null after a real question                                     -> B3
--       {"ok":true}                                                    -> fixed


-- ============================================================================
-- PART C — THE LAST THREE PLAINTEXT SERVICE-ROLE KEYS
--
-- B7 reported has_hardcoded_jwt=true for jobs 10, 11 and 12. These three still
-- carry the full service-role JWT in cron.job.command, readable by anyone who
-- can select from the cron schema. The previous script only repointed job 9.
-- Requires public.edge_call() and both vault secrets, which are already in
-- place — the six jobs already using the helper prove it.
-- ============================================================================

select cron.schedule('edgedesk_grade_faults', '5 */6 * * *',
  $$select public.edge_call('grade_faults', timeout_ms => 120000)$$);

select cron.schedule('edgedesk_capture_news', '0 13 * * *',
  $$select public.edge_call('capture_news', timeout_ms => 120000)$$);

select cron.schedule('edgedesk_healthcheck', '*/30 * * * *',
  $$select public.edge_call('healthcheck', timeout_ms => 60000)$$);

-- Verify: expect zero rows.
select jobid, jobname from cron.job
where active and command ilike '%eyJhbGci%';


-- ============================================================================
-- PART D — THE DUPLICATE PAIRS
--
-- Three functions are still scheduled twice. Each pair is a DECISION, which is
-- why none of these ran automatically. Uncomment the one you want.
-- ============================================================================

-- D1. settle runs at */5 (job 7) AND */15 (job 85). Two settle passes overlap
--     every fifteen minutes. The */5 job is the older, faster one.
-- select cron.unschedule('settle-every-15min');

-- D2. learn runs hourly at :30 (job 8) AND nightly at 08:00 (job 86).
--     Hourly learn is expensive and the nightly job's name says someone
--     intended nightly. Keep ONE.
-- select cron.unschedule('edgedesk_learn');      -- keep nightly
-- select cron.unschedule('learn-nightly');       -- keep hourly

-- D3. MLB ingest runs via job 77 (invoke_edge('ingest-mlb'), daily 12:00) AND
--     job 87 (edge_call('ingest_mlb'), */30). The two use DIFFERENT SLUGS —
--     underscore vs hyphen — and only one function can exist.
--     Resolve the slug FIRST:
--       select proname from pg_proc where proname = 'invoke_edge';
--       -- and check the Edge Functions list in the dashboard for which of
--       -- ingest_mlb / ingest-mlb is actually deployed.
--     Then drop the loser:
-- select cron.unschedule('edgedesk-ingest');     -- keep the */30 edge_call path
-- select cron.unschedule('ingest-mlb');          -- keep the daily invoke_edge path


-- ============================================================================
-- PART E — STILL UNANSWERED FROM THE ORIGINAL PART A
--
-- These were never reported back and each one is a job that may be erroring on
-- every fire. Unlike HTTP failures, a missing SQL function DOES surface in
-- cron.job_run_details, so E2 is the fast way to see it.
-- ============================================================================

-- E1. Do the functions jobs 77, 78 and 79 depend on actually exist?
select n.nspname as schema, p.proname as function
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('invoke_edge', 'settle_and_recalibrate', 'edge_call')
order by 2;

-- E2. SQL-level failures in the last day. A missing function shows up here.
select jobid, status, return_message, start_time
from cron.job_run_details
where status <> 'succeeded' and start_time > now() - interval '1 day'
order by start_time desc
limit 40;

-- E3. The real HTTP status codes — the only place the truth about the repaired
--     jobs lives. Run this at least 20 minutes after PART C so mlb_sync,
--     weather_sync and the rest have fired through edge_call at least once.
select r.status_code, count(*) as n, max(r.created) as last_seen
from net._http_response r
where r.created > now() - interval '2 hours'
group by r.status_code
order by n desc;
