-- =============================================================================
-- research_engine.sql — the research engine's run memory, its graded outcomes
-- and its dollar budget. docs/research-engine/ARCHITECTURE.md §2, §5
--
-- REQUIRES supabase/research_intel.sql (research_provider_quota, research_usage,
-- prediction_snapshots). Apply that first; this file refuses to run without it.
--
-- WHAT IT ADDS (additive only: no existing table, column or function changes)
--   research_runs            one write-once row per research turn: the question,
--                            the plan and what actually ran, the sources
--                            consulted, the model and market snapshots, the
--                            conclusions (classification, challenge outcome,
--                            research confidence), the calculation check, the
--                            cost (actual and estimated), the engine versions,
--                            and the prediction_snapshots it froze. The
--                            reader's own memory (row level security).
--   research_run_outcomes    what happened afterwards, kept APART from the
--                            prediction: the result, the closing line and fair,
--                            the CLV — one row per frozen snapshot, written only
--                            by the service role, only after the event started,
--                            never rewritten. research_runs_grade() fills it from
--                            the signals the existing pipeline already graded.
--   research_run_calibration a view: each graded prediction's probability and
--                            outcome, for Brier, log loss and CLV (computed by
--                            lib/edgedesk_calibration.js, walk-forward, so no
--                            later result can inform an earlier prediction).
--   research_budget_policy   the operator's dollar caps: per request, per
--                            subscriber per day, all subscribers per day
--                            (service-written; defaults $0.25 / $1 / $20).
--   research_cost_ledger     append-only dollar claims; research_cost_claim()
--                            is the one door to spend, atomically against the
--                            caps, and research_cost_settle() records the actual.
--   two search providers in research_provider_quota (claude_web_search,
--   perplexity_search), paid and DISABLED.
--
-- WHAT IT DOES NOT DO
--   It does not retrain or change any model. The outcomes table records what
--   happened so calibration can be MEASURED; nothing reads it to adjust a
--   probability. No row claims the AI improves from outcomes.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Runs and outcomes are write-once; readers never delete; retention runs
--      through research_engine_prune() (service role, at least 180 days).
--   2. No look-ahead: an outcome is accepted only after its event started and
--      only for a snapshot frozen before it; a run carries no outcome column.
--   3. A dollar is claimed BEFORE a paid call is made, against the operator's
--      caps; a reader cannot raise a cap and sees only their own claims; an
--      estimate over the per-request cap is refused outright.
--   4. Keys are per user.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.research_provider_quota') is null or to_regclass('public.prediction_snapshots') is null then
    raise exception 'apply supabase/research_intel.sql first: research_engine.sql builds on research_provider_quota and prediction_snapshots';
  end if;
end $req$;

/* Preflight, before anything is written: each table this file creates must be
   absent or already carry every column this file gives it. Production holds
   older tables under research_* names (research_intel.sql, section 0, says
   why this matters); any other table under one of these names stops the file
   here, with nothing changed. */
do $pre$
declare tbl text; kind text; cols text[]; gone text[];
begin
  for tbl, kind, cols in select * from (values
    ('research_runs', 'r', array['id', 'run_id', 'user_id', 'created_at', 'question', 'route', 'path', 'research_level', 'plan', 'plan_actual', 'sources', 'model_snapshot', 'market_snapshot', 'conclusions', 'final_status', 'verification', 'snapshot_ids', 'cost_usd', 'cost_estimate_usd', 'providers', 'engine_versions', 'latency_ms', 'earliest_event_start']),
    ('research_run_outcomes', 'r', array['id', 'snapshot_id', 'user_id', 'event_start', 'result', 'closing_fair', 'closing_line', 'clv', 'graded_at', 'source']),
    ('research_budget_policy', 'r', array['scope', 'per_request_usd', 'per_user_daily_usd', 'global_daily_usd', 'updated_at', 'note']),
    ('research_cost_ledger', 'r', array['id', 'user_id', 'provider', 'claimed_at', 'state', 'estimate_usd', 'actual_usd', 'reason', 'settled_at']),
    ('research_run_calibration', 'v', array['snapshot_id', 'user_id', 'predicted_at', 'event_start', 'sport', 'market', 'selection', 'classification', 'fair_probability', 'fair_kind', 'model_tier', 'odds_decimal', 'net_ev_per_dollar', 'result', 'outcome', 'closing_fair', 'clv', 'graded_at'])
  ) as v(t, k, c) loop
    if to_regclass('public.' || tbl) is not null then
      if (select relkind::text from pg_class where oid = ('public.' || tbl)::regclass) <> kind then
        raise exception 'research_engine.sql stopped before changing anything: public.% already exists and is not a %. Another object holds the name; rename one of them.', tbl, case kind when 'v' then 'view' else 'table' end;
      end if;
      select array_agg(w order by w) into gone from unnest(cols) as w
       where not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || tbl)::regclass and a.attname = w and a.attnum > 0 and not a.attisdropped);
      if gone is not null then
        raise exception 'research_engine.sql stopped before changing anything: public.% already exists and is not the one this file creates (it has no %). Another table holds the name; rename one of them. Do not drop it without a backup.', tbl, array_to_string(gone, ', ');
      end if;
    end if;
  end loop;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. RESEARCH RUNS — one per research turn, frozen when written
-- ---------------------------------------------------------------------------
create table if not exists public.research_runs (
  id                  bigint generated always as identity primary key,
  run_id              text not null check (run_id ~ '^rr_[0-9a-f]{16}$'),
  user_id             uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  question            text not null check (char_length(question) between 1 and 300),
  route               text check (route is null or route ~ '^[A-Z_]{2,40}$'),
  path                text check (path is null or path in ('DATABASE', 'ENGINE', 'ENGINE_RESEARCH', 'ENGINE_SEARCH', 'MODEL_DESK', 'UNSUPPORTED')),
  research_level      text check (research_level is null or research_level in ('L1', 'L2', 'L3')),
  plan                jsonb check (plan is null or jsonb_typeof(plan) = 'object'),
  plan_actual         jsonb not null default '[]'::jsonb check (jsonb_typeof(plan_actual) = 'array'),
  sources             jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 60),
  model_snapshot      jsonb not null default '[]'::jsonb check (jsonb_typeof(model_snapshot) = 'array'),
  market_snapshot     jsonb not null default '[]'::jsonb check (jsonb_typeof(market_snapshot) = 'array'),
  conclusions         jsonb not null default '[]'::jsonb check (jsonb_typeof(conclusions) = 'array'),
  final_status        text check (final_status is null or final_status in ('VERIFIED CANDIDATE', 'WATCHLIST', 'PASS', 'NO CANDIDATE')),
  verification        jsonb check (verification is null or jsonb_typeof(verification) = 'object'),
  snapshot_ids        text[] not null default '{}',
  cost_usd            numeric not null default 0 check (cost_usd >= 0 and cost_usd < 25),
  cost_estimate_usd   numeric not null default 0 check (cost_estimate_usd >= 0 and cost_estimate_usd < 25),
  providers           text[] not null default '{}',
  engine_versions     jsonb not null default '{}'::jsonb check (jsonb_typeof(engine_versions) = 'object'),
  latency_ms          int check (latency_ms is null or latency_ms >= 0),
  /* a run is a set of predictions and the evidence for them; its earliest event start bounds when it may be written */
  earliest_event_start timestamptz
);
comment on table public.research_runs is
  'Write-once research turns: question, plan vs actual, sources, model and market snapshots, conclusions, cost, engine versions. No outcome column by design; outcomes live in research_run_outcomes.';
create index if not exists research_runs_user_idx on public.research_runs (user_id, created_at desc);

/* no look-ahead: a run with predictions is written before the earliest event it predicts */
create or replace function public.research_runs_pregame()
returns trigger language plpgsql as $$
begin
  if new.earliest_event_start is not null and new.earliest_event_start <= now() and coalesce(array_length(new.snapshot_ids, 1), 0) > 0 then
    raise exception 'research run % predicts an event that has started (%): a run with predictions is frozen before the event', new.run_id, new.earliest_event_start using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists research_runs_pregame_trg on public.research_runs;
create trigger research_runs_pregame_trg before insert on public.research_runs for each row execute function public.research_runs_pregame();

-- ---------------------------------------------------------------------------
-- 2. OUTCOMES — what happened, apart from what was predicted
-- ---------------------------------------------------------------------------
create table if not exists public.research_run_outcomes (
  id                  bigint generated always as identity primary key,
  snapshot_id         text not null check (snapshot_id ~ '^ps_[0-9a-f]{16}$'),
  user_id             uuid not null,
  event_start         timestamptz not null,
  result              text not null check (result in ('WIN', 'LOSS', 'PUSH', 'VOID')),
  closing_fair        numeric check (closing_fair is null or (closing_fair > 0 and closing_fair < 1)),
  closing_line        numeric,
  clv                 numeric check (clv is null or abs(clv) < 1),
  graded_at           timestamptz not null default now(),
  source              text not null check (char_length(source) between 3 and 120)
);
comment on table public.research_run_outcomes is
  'Results and closing information for frozen prediction snapshots, written by the service role after the event. Never rewritten. Nothing here adjusts a model.';
create index if not exists research_run_outcomes_user_idx on public.research_run_outcomes (user_id, graded_at desc);

create or replace function public.research_outcome_after_start()
returns trigger language plpgsql as $$
declare snap record;
begin
  if new.graded_at < new.event_start then
    raise exception 'outcome for % is graded before its event started', new.snapshot_id using errcode = 'check_violation';
  end if;
  select created_at, event_start into snap from public.prediction_snapshots where snapshot_id = new.snapshot_id and user_id = new.user_id;
  if not found then
    raise exception 'outcome for % has no frozen snapshot of that user', new.snapshot_id using errcode = 'foreign_key_violation';
  end if;
  if snap.created_at >= snap.event_start or snap.event_start <> new.event_start then
    raise exception 'outcome for % does not match a snapshot frozen before its event', new.snapshot_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists research_run_outcomes_after_start_trg on public.research_run_outcomes;
create trigger research_run_outcomes_after_start_trg before insert on public.research_run_outcomes for each row execute function public.research_outcome_after_start();

/* Grade from what the existing pipeline already graded (prediction_snapshot_grades over public.signals). Service role only. */
create or replace function public.research_runs_grade(p_limit int default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if to_regclass('public.prediction_snapshot_grades') is null then
    return jsonb_build_object('ok', false, 'why', 'prediction_snapshot_grades is missing (it needs public.signals and research_intel.sql)', 'graded', 0);
  end if;
  insert into public.research_run_outcomes (snapshot_id, user_id, event_start, result, closing_fair, clv, graded_at, source)
  select g.snapshot_id, g.user_id, p.event_start,
         case lower(g.result) when 'win' then 'WIN' when 'won' then 'WIN' when 'loss' then 'LOSS' when 'lost' then 'LOSS' when 'push' then 'PUSH' else 'VOID' end,
         case when g.closing_fair > 0 and g.closing_fair < 1 then g.closing_fair end,
         case when abs(g.clv) < 1 then g.clv end,
         greatest(coalesce(g.graded_at, now()), p.event_start), 'signals (graded by the capture pipeline)'
  from public.prediction_snapshot_grades g
  join public.prediction_snapshots p on p.snapshot_id = g.snapshot_id and p.user_id = g.user_id
  where g.result is not null and p.event_start < now()
    and not exists (select 1 from public.research_run_outcomes o where o.snapshot_id = g.snapshot_id and o.user_id = g.user_id)
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'graded', n);
end $$;

/* Each graded prediction beside its outcome: the input to Brier, log loss and CLV. Readers see their own. */
create or replace view public.research_run_calibration with (security_invoker = true) as
select p.snapshot_id, p.user_id, p.created_at as predicted_at, p.event_start, p.sport, p.market, p.selection, p.classification,
       p.fair_probability, p.fair_kind, p.model_tier, p.odds_decimal, p.net_ev_per_dollar,
       o.result, case o.result when 'WIN' then 1 when 'LOSS' then 0 end as outcome, o.closing_fair, o.clv, o.graded_at
from public.prediction_snapshots p
join public.research_run_outcomes o on o.snapshot_id = p.snapshot_id and o.user_id = p.user_id
where p.created_at < p.event_start and o.graded_at >= p.event_start;

-- ---------------------------------------------------------------------------
-- 3. THE DOLLAR BUDGET
-- ---------------------------------------------------------------------------
create table if not exists public.research_budget_policy (
  scope               text primary key check (scope = 'global'),
  per_request_usd     numeric not null check (per_request_usd >= 0 and per_request_usd <= 5),
  per_user_daily_usd  numeric not null check (per_user_daily_usd >= 0 and per_user_daily_usd <= 50),
  global_daily_usd    numeric not null check (global_daily_usd >= 0 and global_daily_usd <= 2000),
  updated_at          timestamptz not null default now(),
  note                text
);
comment on table public.research_budget_policy is
  'The operator''s dollar caps for paid research. Change these rows to change the worst-case spend (default about $600 a month).';
insert into public.research_budget_policy (scope, per_request_usd, per_user_daily_usd, global_daily_usd, note)
values ('global', 0.25, 1.00, 20.00, 'defaults: $0.25 per request, $1 per subscriber per day, $20 per day across subscribers')
on conflict (scope) do nothing;

create table if not exists public.research_cost_ledger (
  id                  bigint generated always as identity primary key,
  user_id             uuid default auth.uid(),
  provider            text not null references public.research_provider_quota(provider),
  claimed_at          timestamptz not null default now(),
  state               text not null default 'CLAIMED' check (state in ('CLAIMED', 'DENIED', 'SETTLED', 'RELEASED')),
  estimate_usd        numeric not null check (estimate_usd >= 0 and estimate_usd < 25),
  actual_usd          numeric check (actual_usd is null or (actual_usd >= 0 and actual_usd < 25)),
  reason              text,
  settled_at          timestamptz
);
create index if not exists research_cost_ledger_day_idx on public.research_cost_ledger (claimed_at desc);
create index if not exists research_cost_ledger_user_idx on public.research_cost_ledger (user_id, claimed_at desc);

/* what a row costs against the day: the actual once settled, the estimate while open, nothing once released or denied */
create or replace function public.research_cost_committed(p_user uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(case state when 'SETTLED' then coalesce(actual_usd, estimate_usd) when 'CLAIMED' then estimate_usd else 0 end), 0)
  from public.research_cost_ledger
  where claimed_at >= date_trunc('day', now()) and (p_user is null or user_id = p_user)
$$;

/* The one door to spend research dollars: atomically against the per-request, per-subscriber and global caps. */
create or replace function public.research_cost_claim(p_provider text, p_estimate_usd numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pol public.research_budget_policy; uid uuid := auth.uid(); mine numeric; everyone numeric; why text; rid bigint;
begin
  if uid is null then return jsonb_build_object('ok', false, 'why', 'sign in to use research'); end if;
  if p_estimate_usd is null or p_estimate_usd < 0 or p_estimate_usd >= 25 then return jsonb_build_object('ok', false, 'why', 'the estimate must be a dollar amount between 0 and 25'); end if;
  if not exists (select 1 from public.research_provider_quota where provider = p_provider) then return jsonb_build_object('ok', false, 'why', 'unknown research provider ' || coalesce(p_provider, 'null')); end if;
  select * into pol from public.research_budget_policy where scope = 'global' for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'no research budget policy is set'); end if;
  mine := public.research_cost_committed(uid);
  everyone := public.research_cost_committed(null);
  why := case when p_estimate_usd > pol.per_request_usd then 'the estimate ($' || round(p_estimate_usd, 4) || ') is over the per-request budget ($' || pol.per_request_usd || ')'
              when mine + p_estimate_usd > pol.per_user_daily_usd then 'your research budget for today ($' || pol.per_user_daily_usd || ') would be exceeded'
              when everyone + p_estimate_usd > pol.global_daily_usd then 'today''s research budget across subscribers ($' || pol.global_daily_usd || ') would be exceeded'
              else null end;
  insert into public.research_cost_ledger (user_id, provider, state, estimate_usd, reason)
    values (uid, p_provider, case when why is null then 'CLAIMED' else 'DENIED' end, p_estimate_usd, why)
    returning id into rid;
  return jsonb_build_object('ok', why is null, 'why', why, 'claim_id', rid, 'committed_today_usd', mine + case when why is null then p_estimate_usd else 0 end,
    'per_user_daily_usd', pol.per_user_daily_usd, 'global_committed_today_usd', everyone + case when why is null then p_estimate_usd else 0 end, 'global_daily_usd', pol.global_daily_usd);
end $$;
/* Settle one's own open claim once: SETTLED with the actual cost read from the provider's response, or RELEASED (no call made). */
create or replace function public.research_cost_settle(p_claim_id bigint, p_actual_usd numeric, p_state text default 'SETTLED')
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_state not in ('SETTLED', 'RELEASED') then return jsonb_build_object('ok', false, 'why', 'state must be SETTLED or RELEASED'); end if;
  if p_state = 'SETTLED' and (p_actual_usd is null or p_actual_usd < 0 or p_actual_usd >= 25) then return jsonb_build_object('ok', false, 'why', 'a settled claim needs the actual cost'); end if;
  update public.research_cost_ledger set state = p_state, actual_usd = case when p_state = 'SETTLED' then p_actual_usd end, settled_at = now()
    where id = p_claim_id and user_id = auth.uid() and state = 'CLAIMED' and settled_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1, 'why', case when n = 1 then null else 'no open claim of yours with that id' end);
end $$;

-- the two search adapters, paid and disabled until an operator enables them
insert into public.research_provider_quota (provider, paid, enabled, daily_limit, monthly_limit, per_user_daily, cost_estimate_usd, cost_basis) values
  ('claude_web_search', true, false, 300, 6000, 5, 0.084, 'estimate: 3 searches ($0.03) + ~10K input and ~700 output tokens at Opus 5.5 list prices; actual cost is read from each response'),
  ('perplexity_search', true, false, 500, 10000, 10, 0.010, 'estimate: $5 per 1,000 requests as quoted from the pricing page, two queries counted as two; schema unverified until a live check')
on conflict (provider) do nothing;

-- ---------------------------------------------------------------------------
-- 4. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR
-- ---------------------------------------------------------------------------
create or replace function public.research_engine_immutable()
returns trigger language plpgsql as $$
begin
  /* the cost ledger's only permitted update is a claim's single settlement; nested because plpgsql does not short-circuit */
  if tg_table_name = 'research_cost_ledger' then
    if old.state = 'CLAIMED' and old.settled_at is null and new.settled_at is not null and new.state in ('SETTLED', 'RELEASED')
       and new.id = old.id and new.user_id is not distinct from old.user_id and new.provider = old.provider and new.claimed_at = old.claimed_at and new.estimate_usd = old.estimate_usd then
      return new;
    end if;
  end if;
  raise exception '% is write-once: row % cannot be updated', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
create or replace function public.research_engine_no_delete()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('edgedesk.research_engine_prune', true), '') = 'on' then return old; end if;
  raise exception '% rows are not deleted (row %); retention runs through research_engine_prune()', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
do $trg$
declare t text;
begin
  foreach t in array array['research_runs','research_run_outcomes','research_cost_ledger'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.research_engine_immutable()', t || '_immutable_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.research_engine_no_delete()', t || '_no_delete_trg', t);
  end loop;
end $trg$;

create or replace function public.research_engine_prune(p_days int default 365)
returns table (table_name text, removed bigint)
language plpgsql security definer set search_path = public as $$
declare d int := greatest(180, coalesce(p_days, 365)); n bigint;
begin
  perform set_config('edgedesk.research_engine_prune', 'on', true);
  delete from public.research_runs where created_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'research_runs'; removed := n; return next;
  delete from public.research_cost_ledger where claimed_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'research_cost_ledger'; removed := n; return next;
  perform set_config('edgedesk.research_engine_prune', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. KEYS, ROW LEVEL SECURITY, PRIVILEGES
-- ---------------------------------------------------------------------------
do $keys$ begin
  if not exists (select 1 from pg_constraint where conname = 'research_runs_user_run_key' and conrelid = 'public.research_runs'::regclass) then
    alter table public.research_runs add constraint research_runs_user_run_key unique (user_id, run_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_run_outcomes_user_snapshot_key' and conrelid = 'public.research_run_outcomes'::regclass) then
    alter table public.research_run_outcomes add constraint research_run_outcomes_user_snapshot_key unique (user_id, snapshot_id);
  end if;
end $keys$;

alter table public.research_runs enable row level security;
alter table public.research_run_outcomes enable row level security;
alter table public.research_budget_policy enable row level security;
alter table public.research_cost_ledger enable row level security;
drop policy if exists research_runs_insert_own on public.research_runs;
create policy research_runs_insert_own on public.research_runs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists research_runs_select_own on public.research_runs;
create policy research_runs_select_own on public.research_runs for select to authenticated using (user_id = auth.uid());
drop policy if exists research_run_outcomes_select_own on public.research_run_outcomes;
create policy research_run_outcomes_select_own on public.research_run_outcomes for select to authenticated using (user_id = auth.uid());
drop policy if exists research_budget_policy_read on public.research_budget_policy;
create policy research_budget_policy_read on public.research_budget_policy for select to authenticated using (true);
drop policy if exists research_cost_ledger_select_own on public.research_cost_ledger;
create policy research_cost_ledger_select_own on public.research_cost_ledger for select to authenticated using (user_id = auth.uid());

-- revoke first: Supabase's default privileges grant ALL, and TRUNCATE bypasses the row triggers
revoke all on public.research_runs from authenticated;
revoke all on public.research_run_outcomes from authenticated;
revoke all on public.research_budget_policy from authenticated;
revoke all on public.research_cost_ledger from authenticated;
grant select, insert on public.research_runs to authenticated;
grant select on public.research_run_outcomes to authenticated;
grant select on public.research_budget_policy to authenticated;
grant select on public.research_cost_ledger to authenticated;
grant select on public.research_run_calibration to authenticated;
grant usage, select on sequence public.research_runs_id_seq to authenticated;
revoke all on function public.research_cost_claim(text, numeric) from public;
revoke all on function public.research_cost_settle(bigint, numeric, text) from public;
revoke all on function public.research_cost_committed(uuid) from public;
revoke all on function public.research_runs_grade(int) from public;
revoke all on function public.research_engine_prune(int) from public;
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.research_cost_claim(text, numeric) to authenticated;
    grant execute on function public.research_cost_settle(bigint, numeric, text) to authenticated;
    revoke all on function public.research_runs_grade(int) from authenticated;
    revoke all on function public.research_engine_prune(int) from authenticated;
    revoke all on function public.research_cost_committed(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.research_runs_grade(int) to service_role;
    grant execute on function public.research_engine_prune(int) to service_role;
    grant execute on function public.research_cost_committed(uuid) to service_role;
    grant select, insert on public.research_run_outcomes to service_role;
    grant select, insert, update on public.research_budget_policy to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.research_runs from anon;
    revoke all on public.research_run_outcomes from anon;
    revoke all on public.research_budget_policy from anon;
    revoke all on public.research_cost_ledger from anon;
    revoke all on public.research_run_calibration from anon;
    revoke all on function public.research_cost_claim(text, numeric) from anon;
    revoke all on function public.research_cost_settle(bigint, numeric, text) from anon;
    revoke all on function public.research_runs_grade(int) from anon;
    revoke all on function public.research_engine_prune(int) from anon;
    revoke all on function public.research_cost_committed(uuid) from anon;
  end if;
end $grant$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'research_runs table' as piece, case when to_regclass('public.research_runs') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'research_run_outcomes table', case when to_regclass('public.research_run_outcomes') is not null then 'ok' else 'CHECK THIS' end
union all select 'calibration view', case when to_regclass('public.research_run_calibration') is not null then 'ok' else 'CHECK THIS' end
union all select 'budget policy row', case when exists (select 1 from public.research_budget_policy where scope = 'global') then 'ok' else 'CHECK THIS' end
union all select 'cost ledger and claim door', case when to_regclass('public.research_cost_ledger') is not null and exists (select 1 from pg_proc where proname = 'research_cost_claim') then 'ok' else 'CHECK THIS' end
union all select 'search providers present and disabled', case when (select count(*) from public.research_provider_quota where provider in ('claude_web_search','perplexity_search') and paid and not enabled) = 2 then 'ok'
    when (select count(*) from public.research_provider_quota where provider in ('claude_web_search','perplexity_search')) = 2 then 'ok (an operator enabled a search provider)' else 'CHECK THIS' end
union all select 'pregame and after-start triggers', case when (select count(*) from pg_trigger where tgname in ('research_runs_pregame_trg','research_run_outcomes_after_start_trg')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'write-once triggers', case when (select count(*) from pg_trigger where tgname in ('research_runs_immutable_trg','research_run_outcomes_immutable_trg','research_cost_ledger_immutable_trg')) = 3 then 'ok' else 'CHECK THIS' end
union all select 'per-user keys', case when (select count(*) from pg_constraint where conname in ('research_runs_user_run_key','research_run_outcomes_user_snapshot_key')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'row level security', case when (select count(*) from pg_class where oid in ('public.research_runs'::regclass, 'public.research_run_outcomes'::regclass, 'public.research_budget_policy'::regclass, 'public.research_cost_ledger'::regclass) and relrowsecurity) = 4 then 'ok' else 'CHECK THIS' end
union all select 'readers cannot write beyond inserting their own runs', case when not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'
    and ((table_name = 'research_runs' and privilege_type not in ('SELECT','INSERT'))
      or (table_name in ('research_run_outcomes','research_budget_policy','research_cost_ledger') and privilege_type <> 'SELECT'))) then 'ok' else 'CHECK THIS' end;
