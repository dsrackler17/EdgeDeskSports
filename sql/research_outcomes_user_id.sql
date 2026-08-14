-- ============================================================================
--  research_outcomes_user_id.sql
--  Additive, idempotent, safe to run more than once.
--
--  Closes the write half of the learning loop.
--
--  edgedesk_ai upserts an open outcome on (user_id, event_id, market, selection)
--  but has never sent user_id in the payload — it depends entirely on the column
--  carrying a DEFAULT of auth.uid(). If that default is absent the insert is
--  rejected, the rejection happens inside a catch after the response has already
--  gone out, and nothing anywhere reports it. settle only UPDATEs rows that
--  already exist, so a missing open outcome means every graded result has
--  nothing to attach to and the loop can never accumulate.
--
--  This was flagged as UNVERIFIED rather than fixed blind, because the repair
--  depends on database state that could not be inspected. PART A tells you
--  whether you need PART B.
-- ============================================================================


-- ============================================================================
-- PART A — DIAGNOSE (read-only)
-- ============================================================================

-- A1. Does user_id have a default? A null column_default is the bug.
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name  = 'research_outcomes'
  and column_name = 'user_id';


-- A2. Is there a unique constraint matching the ON CONFLICT target?
--     PostgREST's on_conflict=user_id,event_id,market,selection requires a
--     unique index on exactly those four columns, in any order. Without it the
--     upsert fails regardless of the default.
select i.relname as index_name, ix.indisunique as is_unique,
       array_agg(a.attname order by a.attname) as columns
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class t on t.oid = ix.indrelid
join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
where t.relname = 'research_outcomes'
group by i.relname, ix.indisunique
order by ix.indisunique desc;


-- A3. Has anything ever been written? Zero open outcomes alongside a healthy
--     research_sessions count is the signature of this exact failure.
select
  (select count(*) from public.research_outcomes)                        as outcomes_total,
  (select count(*) from public.research_outcomes where graded_at is null) as outcomes_open,
  (select count(*) from public.research_outcomes where graded_at is not null) as outcomes_graded,
  (select count(*) from public.research_sessions)                        as sessions_total;


-- A4. Rows that never got linked back to the session that produced them.
--     Without that link a graded result cannot be traced to the reasoning that
--     preceded it, which is the entire point of the loop.
select count(*) as outcomes_without_session
from public.research_outcomes
where session_id is null;



-- ============================================================================
-- PART B — REPAIR
-- Run only what PART A showed you need.
-- ============================================================================

-- B1. The default. This is the fix if A1 returned a null column_default.
alter table public.research_outcomes
  alter column user_id set default auth.uid();

-- B2. The unique constraint the upsert targets. Created concurrently-safe and
--     idempotent; if a duplicate set already exists this will error and tell you
--     which rows to reconcile first, which is the correct outcome — silently
--     collapsing duplicate outcomes would destroy history.
create unique index if not exists research_outcomes_user_event_market_sel_key
  on public.research_outcomes (user_id, event_id, market, selection);

-- B3. Backfill guard. Any pre-existing row with a null user_id can never match
--     the conflict target, so it will be duplicated forever. This does NOT
--     invent an owner — it only reports them, because guessing which user owned
--     a historical research outcome is exactly the kind of fabrication this
--     system exists to prevent.
select id, event_id, market, selection, created_at
from public.research_outcomes
where user_id is null
order by created_at desc
limit 50;


-- ============================================================================
-- PART C — VERIFY
-- ============================================================================

-- C1. Ask edgedesk_ai a real question through the app, then run this. It should
--     be non-zero and rising.
select count(*) as open_outcomes_now,
       max(created_at) as most_recent
from public.research_outcomes
where graded_at is null;

-- C2. Or check without touching SQL at all — the function now reports the
--     status of its own last memory write:
--     curl -s '<project>/functions/v1/edgedesk_ai?probe=1' | jq .last_memory_write
--     null            -> no question has run in this isolate yet
--     {"ok":true}     -> the loop is writing
--     {"ok":false}    -> read `detail`; if it mentions user_id, PART B is needed
