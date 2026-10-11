-- =============================================================================
-- ai_usage — the AI desk's shared, per-reader daily allowance and its ledger.
--
-- WHY
--   edgedesk_ai limited a reader to 30 questions a minute and 300 an hour, in
--   a Map held by ONE isolate: two isolates gave a reader twice the allowance,
--   a cold start reset it, and nothing recorded what the desk spent. This
--   file is the shared half: one row per question, claimed atomically before
--   the work is done, settled with the tokens afterwards.
--
-- THE TWO ROUTES (supabase/functions/edgedesk_ai, docs/linemaker/DESIGN.md §AI)
--   LITE  every question: answered from EdgeDesk's cached research, the
--         deterministic desk and the committed artifacts; no outside lookup.
--   PRO   a question that runs the full research pipeline: the live
--         investigation providers and the larger answer.
--   Every question claims LITE first (one LITE unit per question). Only a
--   question that reaches the full pipeline also claims PRO. When the PRO
--   allowance is spent that claim is recorded DOWNGRADED (it counts against
--   nothing) and the desk answers the question the LITE way; a question is
--   never refused for PRO alone. When the LITE allowance is spent the LITE
--   claim is REFUSED and the question is not answered.
--
-- THE RULES, ENFORCED HERE
--   1. A reader claims and settles only for themselves (auth.uid()); there is
--      no insert, update or delete policy, so the table is reachable only
--      through the two functions.
--   2. A claim is atomic per reader: concurrent questions from one reader
--      serialise on an advisory lock, so two isolates cannot both take the
--      last unit.
--   3. A settled row cannot be settled again, and nothing is ever deleted.
--   4. The limits live in one row (ai_usage_policy) the service role edits;
--      readers cannot read or change it except through my_ai_usage().
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Rollback: supabase/ai_usage_rollback.sql (removes the functions; keeps the
-- ledger, which is never dropped by a script).
-- =============================================================================

create table if not exists public.ai_usage_policy (
  id                 int primary key default 1 check (id = 1),
  enabled            boolean not null default true,
  pro_daily_limit    int not null default 100 check (pro_daily_limit >= 0),
  lite_daily_limit   int not null default 600 check (lite_daily_limit >= 0),
  updated_at         timestamptz not null default now(),
  note               text
);
insert into public.ai_usage_policy (id) values (1) on conflict (id) do nothing;
comment on table public.ai_usage_policy is
  'One row. The AI desk''s daily allowances per reader. Edit with the service role; the edge function reads them through ai_usage_claim().';

create table if not exists public.ai_usage_events (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid(),
  usage_day      date not null default ((now() at time zone 'utc')::date),
  created_at     timestamptz not null default now(),
  route          text not null check (route in ('LITE','PRO')),
  status         text not null check (status in ('CLAIMED','DOWNGRADED','REFUSED')),
  question_chars int check (question_chars is null or question_chars >= 0),
  settled_at     timestamptz,
  outcome        text check (outcome is null or outcome in ('answered','deterministic','narration_failed','timed_out','error')),
  model          text,
  tokens_in      int check (tokens_in is null or tokens_in >= 0),
  tokens_out     int check (tokens_out is null or tokens_out >= 0),
  ms             int check (ms is null or ms >= 0)
);
create index if not exists ai_usage_events_user_day_idx on public.ai_usage_events (user_id, usage_day, route);
create index if not exists ai_usage_events_day_idx on public.ai_usage_events (usage_day);
comment on table public.ai_usage_events is
  'One row per AI desk claim. Written only by ai_usage_claim(), settled once by ai_usage_settle(), never deleted.';

-- NOTHING IS DELETED, AND A SETTLED ROW STAYS AS IT WAS SETTLED.
create or replace function public.ai_usage_events_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_usage_events rows are never deleted (row %)', old.id using errcode = 'restrict_violation';
  end if;
  if old.settled_at is not null then
    raise exception 'ai_usage_events row % is already settled', old.id using errcode = 'restrict_violation';
  end if;
  if new.user_id is distinct from old.user_id or new.route is distinct from old.route or new.status is distinct from old.status
     or new.usage_day is distinct from old.usage_day or new.created_at is distinct from old.created_at then
    raise exception 'ai_usage_events: only the settlement columns of row % may be written', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists ai_usage_events_guard_trg on public.ai_usage_events;
create trigger ai_usage_events_guard_trg
  before update or delete on public.ai_usage_events
  for each row execute function public.ai_usage_events_guard();

alter table public.ai_usage_events enable row level security;
alter table public.ai_usage_policy enable row level security;
drop policy if exists ai_usage_events_select_own on public.ai_usage_events;
create policy ai_usage_events_select_own on public.ai_usage_events
  for select to authenticated using (user_id = auth.uid());
revoke all on public.ai_usage_events from anon;
revoke insert, update, delete, truncate on public.ai_usage_events from authenticated;
grant select on public.ai_usage_events to authenticated;
revoke all on public.ai_usage_policy from anon, authenticated;
grant select, update on public.ai_usage_policy to service_role;
grant select on public.ai_usage_events to service_role;

-- THE CLAIM. p_route 'LITE' or 'PRO'. Returns
--   { ok, route, status, used, limit, event_id, reason }
-- ok=false only when the question may not be answered at all (no account,
-- LITE spent, or a bad route). A spent PRO allowance is ok=true with
-- route 'LITE' and status 'DOWNGRADED' (recorded as a PRO row with status
-- DOWNGRADED, which counts against neither allowance: the question's LITE
-- unit was already claimed).
create or replace function public.ai_usage_claim(p_route text, p_question_chars int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pol public.ai_usage_policy;
  day date := (now() at time zone 'utc')::date;
  used_pro int; used_lite int; eid bigint; lim int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'no signed-in reader'); end if;
  if p_route not in ('LITE','PRO') then return jsonb_build_object('ok', false, 'reason', 'unknown route ' || coalesce(p_route, 'null')); end if;
  select * into pol from public.ai_usage_policy where id = 1;
  if not found or not pol.enabled then
    return jsonb_build_object('ok', true, 'route', p_route, 'status', 'UNMETERED', 'reason', 'the allowance is switched off (ai_usage_policy.enabled)');
  end if;
  /* one reader at a time: two isolates cannot both take the last unit */
  perform pg_advisory_xact_lock(hashtext('ai_usage:' || uid::text));
  select count(*) filter (where route = 'PRO' and status = 'CLAIMED'),
         count(*) filter (where route = 'LITE' and status = 'CLAIMED')
    into used_pro, used_lite
    from public.ai_usage_events where user_id = uid and usage_day = day;
  if p_route = 'PRO' then
    if used_pro < pol.pro_daily_limit then
      insert into public.ai_usage_events (user_id, usage_day, route, status, question_chars) values (uid, day, 'PRO', 'CLAIMED', p_question_chars) returning id into eid;
      return jsonb_build_object('ok', true, 'route', 'PRO', 'status', 'CLAIMED', 'used', used_pro + 1, 'limit', pol.pro_daily_limit, 'event_id', eid);
    end if;
    /* PRO spent: the same question is answered the LITE way. Recorded, and
       counted against nothing: its LITE unit was claimed when it arrived. */
    insert into public.ai_usage_events (user_id, usage_day, route, status, question_chars) values (uid, day, 'PRO', 'DOWNGRADED', p_question_chars) returning id into eid;
    return jsonb_build_object('ok', true, 'route', 'LITE', 'status', 'DOWNGRADED', 'used', used_pro, 'limit', pol.pro_daily_limit, 'event_id', eid,
      'reason', 'the daily allowance of ' || pol.pro_daily_limit || ' full-research questions is spent; this one is answered from EdgeDesk''s cached research');
  else
    if used_lite < pol.lite_daily_limit then
      insert into public.ai_usage_events (user_id, usage_day, route, status, question_chars) values (uid, day, 'LITE', 'CLAIMED', p_question_chars) returning id into eid;
      return jsonb_build_object('ok', true, 'route', 'LITE', 'status', 'CLAIMED', 'used', used_lite + 1, 'limit', pol.lite_daily_limit, 'event_id', eid);
    end if;
    lim := pol.lite_daily_limit;
  end if;
  insert into public.ai_usage_events (user_id, usage_day, route, status, question_chars) values (uid, day, p_route, 'REFUSED', p_question_chars);
  return jsonb_build_object('ok', false, 'route', p_route, 'status', 'REFUSED', 'limit', lim,
    'reason', 'the daily allowance of ' || lim || ' questions is spent; it resets at 00:00 UTC');
end $$;

-- THE SETTLEMENT: once, by the reader who claimed.
create or replace function public.ai_usage_settle(p_event_id bigint, p_outcome text, p_model text default null,
  p_tokens_in int default null, p_tokens_out int default null, p_ms int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'no signed-in reader'); end if;
  update public.ai_usage_events
     set settled_at = now(), outcome = p_outcome, model = left(p_model, 80),
         tokens_in = greatest(0, p_tokens_in), tokens_out = greatest(0, p_tokens_out), ms = greatest(0, p_ms)
   where id = p_event_id and user_id = uid and settled_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1, 'reason', case when n = 1 then null else 'no unsettled claim of yours with that id' end);
end $$;

-- A READER'S OWN DAY, for the desk's footer.
create or replace function public.my_ai_usage()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'day', (now() at time zone 'utc')::date,
    'enabled', coalesce((select enabled from public.ai_usage_policy where id = 1), false),
    'pro_used', (select count(*) from public.ai_usage_events where user_id = auth.uid() and usage_day = (now() at time zone 'utc')::date and route = 'PRO' and status = 'CLAIMED'),
    'pro_limit', (select pro_daily_limit from public.ai_usage_policy where id = 1),
    'lite_used', (select count(*) from public.ai_usage_events where user_id = auth.uid() and usage_day = (now() at time zone 'utc')::date and route = 'LITE' and status = 'CLAIMED'),
    'lite_limit', (select lite_daily_limit from public.ai_usage_policy where id = 1))
  where auth.uid() is not null
$$;

-- THE OPERATOR'S VIEW: per day and route, counts and tokens; service role only.
create or replace view public.ai_usage_daily with (security_invoker = true) as
select usage_day, route, status, count(*) as questions, count(distinct user_id) as readers,
       sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,
       count(*) filter (where outcome = 'timed_out') as timed_out,
       count(*) filter (where outcome = 'narration_failed') as narration_failed
from public.ai_usage_events group by usage_day, route, status;
revoke all on public.ai_usage_daily from anon, authenticated;
grant select on public.ai_usage_daily to service_role;

revoke all on function public.ai_usage_claim(text, int) from public, anon;
revoke all on function public.ai_usage_settle(bigint, text, text, int, int, int) from public, anon;
revoke all on function public.my_ai_usage() from public, anon;
grant execute on function public.ai_usage_claim(text, int) to authenticated;
grant execute on function public.ai_usage_settle(bigint, text, text, int, int, int) to authenticated;
grant execute on function public.my_ai_usage() to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'ai_usage_events table' as piece, case when to_regclass('public.ai_usage_events') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'policy row', case when exists (select 1 from public.ai_usage_policy where id = 1) then 'ok' else 'CHECK THIS' end
union all select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.ai_usage_events'::regclass) then 'ok' else 'CHECK THIS' end
union all select 'no-delete / settle-once trigger', case when exists (select 1 from pg_trigger where tgname = 'ai_usage_events_guard_trg') then 'ok' else 'CHECK THIS' end
union all select 'claim function', case when to_regprocedure('public.ai_usage_claim(text,integer)') is not null then 'ok' else 'CHECK THIS' end
union all select 'settle function', case when to_regprocedure('public.ai_usage_settle(bigint,text,text,integer,integer,integer)') is not null then 'ok' else 'CHECK THIS' end
union all select 'reader usage function', case when to_regprocedure('public.my_ai_usage()') is not null then 'ok' else 'CHECK THIS' end;
