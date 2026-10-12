-- =============================================================================
-- research_intel.sql — the research system's memory and its cost ledger.
-- docs/research-intel/DESIGN.md
--
-- WHAT IT ADDS
--   research_chain_findings  one write-once row per sourced finding the
--                            researcher used: source URL, published and
--                            retrieved times, event / team / player, the
--                            claim, its reliability class, whether it was
--                            verified or speculative, its conflicts. A
--                            reader's own memory (row level security): the
--                            next question about the same game reads these
--                            rows before any provider is asked again.
--   prediction_snapshots     one write-once row per candidate the research
--                            chain classified, frozen BEFORE the event:
--                            the price and book, the fair probability and its
--                            kind, the model version and tier, the net EV,
--                            the audit classification and its reasons, the
--                            finding ids it rested on. Graded later against
--                            the close and the result by sig_key — never
--                            rewritten.
--   research_provider_quota  the operator's daily, monthly and per-user caps
--                            per research provider (service-written).
--   research_usage           the append-only call ledger, and the one door to
--                            spend a paid research call: research_usage_claim()
--                            decides atomically against the caps.
--   NOT added, because the schema already holds it: board candidates
--   (research_packets), audits (opportunity_audits), price checks
--   (fair_price_estimates), the CFB terminal's snapshots (research_snapshots),
--   the desk's frozen predictions (desk_prediction_history), the reader's
--   journal and watchlist (personal_research.sql), and bet history
--   (portfolio.sql).
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Findings and snapshots are write-once and never deleted by a reader;
--      findings and usage rows age out through research_intel_prune()
--      (service role, at least 90 days). Snapshots are kept.
--   2. No look-ahead: a snapshot must be taken before its event starts, and
--      it carries no outcome column (grading joins the close later).
--   3. A conclusion EdgeDesk wrote is not evidence: a finding whose provider
--      or kind is EdgeDesk's own narrative is refused, and every finding needs
--      an https source and a retrieval time.
--   4. Keys are per user, so one reader's rows can never collide with or
--      pre-empt another's.
--   5. A paid call is claimed BEFORE it is made, against the operator's caps;
--      a reader cannot raise a cap (the caps live in a table only the service
--      role writes) and can only see their own usage.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT — before anything is written
--    Each table this file creates must be absent, or already carry every
--    column this file gives it. Any other table under one of these names
--    stops the file here, with nothing changed.
--
--    Why: production already holds an older desk table named
--    research_findings (written by rememberSession() in edgedesk_ai), with
--    other columns. An earlier version of this file used that name; run #19
--    of Deploy intelligence (12 Oct 2026) stopped on it, part-way through.
--    The findings table here is therefore research_chain_findings.
-- ---------------------------------------------------------------------------
do $pre$
declare tbl text; kind text; cols text[]; gone text[];
begin
  for tbl, kind, cols in select * from (values
    ('research_chain_findings', 'r', array['id', 'finding_id', 'user_id', 'created_at', 'provider', 'sport', 'event_ref', 'team', 'player', 'topic', 'claim', 'status', 'source_url', 'source_title', 'publisher', 'published_at', 'retrieved_at', 'reliability', 'verified', 'speculative', 'verification', 'conflicts', 'cost_class']),
    ('prediction_snapshots', 'r', array['id', 'snapshot_id', 'user_id', 'created_at', 'sport', 'event_id', 'event_start', 'market', 'selection', 'line', 'sig_key', 'book', 'odds_american', 'odds_decimal', 'quote_captured_at', 'fair_probability', 'fair_kind', 'model_version', 'model_tier', 'net_ev_per_dollar', 'classification', 'reasons', 'finding_ids', 'disagreement', 'research_level', 'calc_version', 'agents_version', 'question']),
    ('research_provider_quota', 'r', array['provider', 'paid', 'enabled', 'daily_limit', 'monthly_limit', 'per_user_daily', 'cost_estimate_usd', 'cost_basis', 'updated_at']),
    ('research_usage', 'r', array['id', 'user_id', 'provider', 'claimed_at', 'state', 'reason', 'cost_estimate_usd', 'settled_at', 'latency_ms']),
    ('prediction_snapshot_grades', 'v', array['snapshot_id', 'user_id', 'created_at', 'sport', 'event_id', 'market', 'selection', 'line', 'book', 'odds_american', 'odds_decimal', 'fair_probability', 'fair_kind', 'classification', 'net_ev_per_dollar', 'sig_key', 'closing_fair', 'clv', 'result', 'graded_at'])
  ) as v(t, k, c) loop
    if to_regclass('public.' || tbl) is not null then
      if (select relkind::text from pg_class where oid = ('public.' || tbl)::regclass) <> kind then
        raise exception 'research_intel.sql stopped before changing anything: public.% already exists and is not a %. Another object holds the name; rename one of them.', tbl, case kind when 'v' then 'view' else 'table' end;
      end if;
      select array_agg(w order by w) into gone from unnest(cols) as w
       where not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || tbl)::regclass and a.attname = w and a.attnum > 0 and not a.attisdropped);
      if gone is not null then
        raise exception 'research_intel.sql stopped before changing anything: public.% already exists and is not the one this file creates (it has no %). Another table holds the name; rename one of them. Do not drop it without a backup.', tbl, array_to_string(gone, ', ');
      end if;
    end if;
  end loop;
end $pre$;

/* Run #19 got as far as one statement on the older desk table: it replaced
   that table's comment with the findings table's. Put a true description
   back, only where the comment is still the one this file wrote. */
do $legacy$ begin
  if obj_description(to_regclass('public.research_findings'), 'pg_class') = 'Write-once sourced findings the research chain used (supabase/functions/edgedesk_ai/_agents.js). A reader''s own research memory.' then
    comment on table public.research_findings is
      'Structured findings the matchup desk extracted from its evidence records, written by rememberSession() in supabase/functions/edgedesk_ai/index.ts. Not the research chain''s findings (research_chain_findings).';
  end if;
end $legacy$;

-- ---------------------------------------------------------------------------
-- 1. RESEARCH FINDINGS
-- ---------------------------------------------------------------------------
create table if not exists public.research_chain_findings (
  id                bigint generated always as identity primary key,
  finding_id        text not null check (finding_id ~ '^f_[0-9a-f]{8}$'),
  user_id           uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  provider          text not null check (provider ~ '^[a-z0-9_]{2,40}$' and provider not in ('edgedesk_ai', 'edgedesk_narrative', 'model_prose')),
  sport             text,
  event_ref         text,
  team              text,
  player            text,
  topic             text not null check (topic in ('availability', 'starter', 'lineup', 'weather', 'travel', 'venue', 'statistic', 'scheme', 'coaching', 'market', 'news', 'other')),
  claim             text not null check (char_length(claim) between 1 and 400),
  status            text,
  source_url        text not null check (source_url ~ '^https://'),
  source_title      text,
  publisher         text,
  published_at      timestamptz,
  retrieved_at      timestamptz not null,
  reliability       text not null check (reliability in ('OFFICIAL', 'STATISTICAL_DATA', 'CREDIBLE_JOURNALISM', 'UNKNOWN', 'SPECULATION', 'OPINION')),
  verified          boolean not null default false,
  speculative       boolean not null default false,
  verification      text,
  conflicts         jsonb not null default '[]'::jsonb check (jsonb_typeof(conflicts) = 'array'),
  cost_class        text not null default 'free' check (cost_class in ('free', 'paid', 'cached')),
  /* a speculative finding is never stored as verified */
  constraint research_chain_findings_speculation_unverified check (not (speculative and verified)),
  constraint research_chain_findings_retrieved_after_published check (published_at is null or retrieved_at >= published_at - interval '5 minutes')
);
comment on table public.research_chain_findings is
  'Write-once sourced findings the research chain used (supabase/functions/edgedesk_ai/_agents.js). A reader''s own research memory.';
create index if not exists research_chain_findings_user_event_idx on public.research_chain_findings (user_id, event_ref, retrieved_at desc);

-- ---------------------------------------------------------------------------
-- 2. PREDICTION SNAPSHOTS — frozen before the event
-- ---------------------------------------------------------------------------
create table if not exists public.prediction_snapshots (
  id                    bigint generated always as identity primary key,
  snapshot_id           text not null check (snapshot_id ~ '^ps_[0-9a-f]{16}$'),
  user_id               uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  sport                 text not null,
  event_id              text not null,
  event_start           timestamptz not null,
  market                text not null check (market in ('h2h', 'spreads', 'totals', 'contract')),
  selection             text not null,
  line                  numeric,
  sig_key               text,
  book                  text,
  odds_american         int check (odds_american is null or abs(odds_american) >= 100),
  odds_decimal          numeric check (odds_decimal is null or odds_decimal > 1),
  quote_captured_at     timestamptz,
  fair_probability      numeric check (fair_probability is null or (fair_probability > 0 and fair_probability < 1)),
  fair_kind             text check (fair_kind is null or fair_kind in ('MODEL', 'SHARP_NO_VIG', 'CONSENSUS_NO_VIG')),
  model_version         text,
  model_tier            text,
  net_ev_per_dollar     numeric check (net_ev_per_dollar is null or abs(net_ev_per_dollar) < 5),
  classification        text not null check (classification in ('VERIFIED_CANDIDATE', 'RESEARCH_REQUIRED', 'WATCHLIST', 'REJECTED', 'UNVERIFIED')),
  reasons               jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  finding_ids           text[] not null default '{}',
  disagreement          jsonb,
  research_level        text check (research_level in ('L1', 'L2', 'L3')),
  calc_version          text,
  agents_version        text,
  question              text check (question is null or char_length(question) <= 300)
);
comment on table public.prediction_snapshots is
  'Write-once candidate classifications frozen before the event; graded later against signals by sig_key. No outcome column by design.';
create index if not exists prediction_snapshots_user_idx on public.prediction_snapshots (user_id, created_at desc);
create index if not exists prediction_snapshots_event_idx on public.prediction_snapshots (sport, event_id, created_at desc);

/* no look-ahead: a snapshot is taken before its event, and before now() is past it */
create or replace function public.research_intel_pregame()
returns trigger language plpgsql as $$
begin
  if new.event_start <= now() then
    raise exception 'prediction snapshot % is for an event that has started (%): a snapshot must be frozen before the event', new.snapshot_id, new.event_start using errcode = 'check_violation';
  end if;
  if new.quote_captured_at is not null and new.quote_captured_at >= new.event_start then
    raise exception 'prediction snapshot % prices a quote captured at or after the start', new.snapshot_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists prediction_snapshots_pregame_trg on public.prediction_snapshots;
create trigger prediction_snapshots_pregame_trg before insert on public.prediction_snapshots for each row execute function public.research_intel_pregame();

-- ---------------------------------------------------------------------------
-- 3. PROVIDER QUOTAS AND THE USAGE LEDGER
-- ---------------------------------------------------------------------------
create table if not exists public.research_provider_quota (
  provider          text primary key check (provider ~ '^[a-z0-9_]{2,40}$'),
  paid              boolean not null default false,
  enabled           boolean not null default false,
  daily_limit       int not null check (daily_limit >= 0),
  monthly_limit     int not null check (monthly_limit >= 0),
  per_user_daily    int not null check (per_user_daily >= 0),
  cost_estimate_usd numeric not null default 0 check (cost_estimate_usd >= 0 and cost_estimate_usd < 10),
  cost_basis        text,
  updated_at        timestamptz not null default now()
);
comment on table public.research_provider_quota is
  'Operator caps per research provider. A paid provider is disabled until the operator enables it here.';
insert into public.research_provider_quota (provider, paid, enabled, daily_limit, monthly_limit, per_user_daily, cost_estimate_usd, cost_basis) values
  ('brave_search', true, false, 200, 2000, 10, 0.005, 'estimate; check the Brave plan in use'),
  ('perplexity_sonar', true, false, 100, 1000, 5, 0.008, 'estimate from secondary sources (Oct 2026); the official rate card was not reachable from the build environment'),
  ('anthropic_narration', true, false, 2000, 30000, 60, 0.004, 'estimate per ~1,500-token turn'),
  ('nflverse_injuries', false, true, 500, 10000, 60, 0, 'keyless public feed'),
  ('open_meteo', false, true, 2000, 40000, 100, 0, 'keyless public API')
on conflict (provider) do nothing;

create table if not exists public.research_usage (
  id                bigint generated always as identity primary key,
  user_id           uuid default auth.uid(),
  provider          text not null references public.research_provider_quota(provider),
  claimed_at        timestamptz not null default now(),
  state             text not null default 'CLAIMED' check (state in ('CLAIMED', 'DENIED', 'OK', 'ERROR', 'CACHED')),
  reason            text,
  cost_estimate_usd numeric not null default 0,
  settled_at        timestamptz,
  latency_ms        int
);
create index if not exists research_usage_provider_day_idx on public.research_usage (provider, claimed_at desc);
create index if not exists research_usage_user_idx on public.research_usage (user_id, claimed_at desc);

/* The one door to a research call: atomically against the operator's caps. */
create or replace function public.research_usage_claim(p_provider text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.research_provider_quota; uid uuid := auth.uid(); d_used int; m_used int; u_used int; why text; rid bigint;
begin
  if uid is null then return jsonb_build_object('ok', false, 'why', 'sign in to use research'); end if;
  select * into q from public.research_provider_quota where provider = p_provider for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'unknown research provider ' || coalesce(p_provider, 'null')); end if;
  select count(*) into d_used from public.research_usage where provider = p_provider and state in ('CLAIMED', 'OK', 'ERROR') and claimed_at >= date_trunc('day', now());
  select count(*) into m_used from public.research_usage where provider = p_provider and state in ('CLAIMED', 'OK', 'ERROR') and claimed_at >= date_trunc('month', now());
  select count(*) into u_used from public.research_usage where provider = p_provider and user_id = uid and state in ('CLAIMED', 'OK', 'ERROR') and claimed_at >= date_trunc('day', now());
  why := case when not q.enabled then q.provider || ' is not enabled by the operator'
              when d_used >= q.daily_limit then q.provider || ' daily limit (' || q.daily_limit || ') reached'
              when m_used >= q.monthly_limit then q.provider || ' monthly limit (' || q.monthly_limit || ') reached'
              when u_used >= q.per_user_daily then 'your daily allowance for ' || q.provider || ' (' || q.per_user_daily || ') is used'
              else null end;
  insert into public.research_usage (user_id, provider, state, reason, cost_estimate_usd)
    values (uid, p_provider, case when why is null then 'CLAIMED' else 'DENIED' end, why, case when why is null then q.cost_estimate_usd else 0 end)
    returning id into rid;
  return jsonb_build_object('ok', why is null, 'why', why, 'claim_id', rid, 'used_today', d_used + case when why is null then 1 else 0 end, 'daily_limit', q.daily_limit, 'monthly_used', m_used, 'cost_estimate_usd', q.cost_estimate_usd);
end $$;
/* Settle one's own claim once: OK, ERROR or CACHED, with the latency. */
create or replace function public.research_usage_settle(p_claim_id bigint, p_state text, p_latency_ms int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_state not in ('OK', 'ERROR', 'CACHED') then return jsonb_build_object('ok', false, 'why', 'state must be OK, ERROR or CACHED'); end if;
  update public.research_usage set state = p_state, settled_at = now(), latency_ms = p_latency_ms
    where id = p_claim_id and user_id = auth.uid() and state = 'CLAIMED' and settled_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1, 'why', case when n = 1 then null else 'no open claim of yours with that id' end);
end $$;

-- ---------------------------------------------------------------------------
-- 4. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR
-- ---------------------------------------------------------------------------
create or replace function public.research_intel_immutable()
returns trigger language plpgsql as $$
begin
  /* the usage ledger's only permitted update is a claim's single settlement (the settle function);
     nested, because plpgsql does not short-circuit and the other tables have no state column */
  if tg_table_name = 'research_usage' then
    if old.state = 'CLAIMED' and old.settled_at is null and new.settled_at is not null
       and new.id = old.id and new.user_id is not distinct from old.user_id and new.provider = old.provider and new.claimed_at = old.claimed_at
       and new.cost_estimate_usd = old.cost_estimate_usd and new.state in ('OK', 'ERROR', 'CACHED') then
      return new;
    end if;
  end if;
  raise exception '% is write-once: row % cannot be updated', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
create or replace function public.research_intel_no_delete()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('edgedesk.research_prune', true), '') = 'on' then return old; end if;
  raise exception '% rows are not deleted (row %); retention runs through research_intel_prune()', tg_table_name, old.id using errcode = 'restrict_violation';
end $$;
do $trg$
declare t text;
begin
  foreach t in array array['research_chain_findings','prediction_snapshots','research_usage'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.research_intel_immutable()', t || '_immutable_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.research_intel_no_delete()', t || '_no_delete_trg', t);
  end loop;
end $trg$;

create or replace function public.research_intel_prune(p_days int default 180)
returns table (table_name text, removed bigint)
language plpgsql security definer set search_path = public as $$
declare d int := greatest(90, coalesce(p_days, 180)); n bigint;
begin
  perform set_config('edgedesk.research_prune', 'on', true);
  delete from public.research_chain_findings where created_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'research_chain_findings'; removed := n; return next;
  delete from public.research_usage where claimed_at < now() - make_interval(days => d);
  get diagnostics n = row_count; table_name := 'research_usage'; removed := n; return next;
  perform set_config('edgedesk.research_prune', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. KEYS, ROW LEVEL SECURITY, PRIVILEGES
-- ---------------------------------------------------------------------------
do $keys$ begin
  if not exists (select 1 from pg_constraint where conname = 'research_chain_findings_user_finding_key' and conrelid = 'public.research_chain_findings'::regclass) then
    alter table public.research_chain_findings add constraint research_chain_findings_user_finding_key unique (user_id, finding_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prediction_snapshots_user_snapshot_key' and conrelid = 'public.prediction_snapshots'::regclass) then
    alter table public.prediction_snapshots add constraint prediction_snapshots_user_snapshot_key unique (user_id, snapshot_id);
  end if;
end $keys$;

alter table public.research_chain_findings enable row level security;
alter table public.prediction_snapshots enable row level security;
alter table public.research_usage enable row level security;
alter table public.research_provider_quota enable row level security;
drop policy if exists research_chain_findings_insert_own on public.research_chain_findings;
create policy research_chain_findings_insert_own on public.research_chain_findings for insert to authenticated with check (user_id = auth.uid());
drop policy if exists research_chain_findings_select_own on public.research_chain_findings;
create policy research_chain_findings_select_own on public.research_chain_findings for select to authenticated using (user_id = auth.uid());
drop policy if exists prediction_snapshots_insert_own on public.prediction_snapshots;
create policy prediction_snapshots_insert_own on public.prediction_snapshots for insert to authenticated with check (user_id = auth.uid());
drop policy if exists prediction_snapshots_select_own on public.prediction_snapshots;
create policy prediction_snapshots_select_own on public.prediction_snapshots for select to authenticated using (user_id = auth.uid());
drop policy if exists research_usage_select_own on public.research_usage;
create policy research_usage_select_own on public.research_usage for select to authenticated using (user_id = auth.uid());
drop policy if exists research_provider_quota_read on public.research_provider_quota;
create policy research_provider_quota_read on public.research_provider_quota for select to authenticated using (true);

-- revoke first: Supabase's default privileges grant ALL, and TRUNCATE bypasses the row triggers
revoke all on public.research_chain_findings from authenticated;
revoke all on public.prediction_snapshots from authenticated;
revoke all on public.research_usage from authenticated;
revoke all on public.research_provider_quota from authenticated;
grant select, insert on public.research_chain_findings to authenticated;
grant select, insert on public.prediction_snapshots to authenticated;
grant select on public.research_usage to authenticated;
grant select on public.research_provider_quota to authenticated;
grant usage, select on sequence public.research_chain_findings_id_seq to authenticated;
grant usage, select on sequence public.prediction_snapshots_id_seq to authenticated;
revoke all on function public.research_usage_claim(text) from public;
revoke all on function public.research_usage_settle(bigint, text, int) from public;
revoke all on function public.research_intel_prune(int) from public;
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.research_usage_claim(text) to authenticated;
    grant execute on function public.research_usage_settle(bigint, text, int) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.research_intel_prune(int) to service_role;
    grant execute on function public.research_usage_claim(text) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.research_intel_prune(int) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.research_intel_prune(int) from anon;
    revoke all on function public.research_usage_claim(text) from anon;
    revoke all on function public.research_usage_settle(bigint, text, int) from anon;
    revoke all on public.research_chain_findings from anon;
    revoke all on public.prediction_snapshots from anon;
    revoke all on public.research_usage from anon;
    revoke all on public.research_provider_quota from anon;
  end if;
end $grant$;

-- ---------------------------------------------------------------------------
-- 6. THE GRADE — a snapshot beside the close and the result of the signal it priced
-- ---------------------------------------------------------------------------
do $view$ begin
  if to_regclass('public.signals') is not null then
    execute $v$
      create or replace view public.prediction_snapshot_grades with (security_invoker = true) as
      select p.snapshot_id, p.user_id, p.created_at, p.sport, p.event_id, p.market, p.selection, p.line, p.book,
             p.odds_american, p.odds_decimal, p.fair_probability, p.fair_kind, p.classification, p.net_ev_per_dollar, p.sig_key,
             (to_jsonb(s) ->> 'closing_sharp_fair')::numeric as closing_fair,
             (to_jsonb(s) ->> 'clv')::numeric as clv,
             to_jsonb(s) ->> 'result' as result,
             (to_jsonb(s) ->> 'graded_at')::timestamptz as graded_at
      from public.prediction_snapshots p
      left join public.signals s on s.sig_key = p.sig_key
    $v$;
    execute 'grant select on public.prediction_snapshot_grades to authenticated';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.prediction_snapshot_grades from anon'; end if;
  end if;
end $view$;

notify pgrst, 'reload schema';

-- THE REPORT.
select 'research_chain_findings table' as piece, case when to_regclass('public.research_chain_findings') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'prediction_snapshots table', case when to_regclass('public.prediction_snapshots') is not null then 'ok' else 'CHECK THIS' end
union all select 'research_usage ledger', case when to_regclass('public.research_usage') is not null and to_regclass('public.research_provider_quota') is not null then 'ok' else 'CHECK THIS' end
union all select 'paid providers disabled until enabled', case when not exists (select 1 from public.research_provider_quota where paid and enabled) then 'ok' else 'ok (an operator enabled a paid provider)' end
union all select 'pregame trigger', case when exists (select 1 from pg_trigger where tgname = 'prediction_snapshots_pregame_trg') then 'ok' else 'CHECK THIS' end
union all select 'write-once triggers', case when (select count(*) from pg_trigger where tgname in ('research_chain_findings_immutable_trg','prediction_snapshots_immutable_trg','research_usage_immutable_trg')) = 3 then 'ok' else 'CHECK THIS' end
union all select 'per-user keys', case when (select count(*) from pg_constraint where conname in ('research_chain_findings_user_finding_key','prediction_snapshots_user_snapshot_key')) = 2 then 'ok' else 'CHECK THIS' end
union all select 'row level security', case when (select count(*) from pg_class where oid in ('public.research_chain_findings'::regclass, 'public.prediction_snapshots'::regclass, 'public.research_usage'::regclass, 'public.research_provider_quota'::regclass) and relrowsecurity) = 4 then 'ok' else 'CHECK THIS' end
union all select 'readers cannot write beyond insert', case when not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'
    and ((table_name in ('research_chain_findings','prediction_snapshots') and privilege_type not in ('SELECT','INSERT'))
      or (table_name in ('research_usage','research_provider_quota') and privilege_type <> 'SELECT'))) then 'ok' else 'CHECK THIS' end
union all select 'snapshot grades view (needs public.signals)', case when to_regclass('public.prediction_snapshot_grades') is not null then 'ok' when to_regclass('public.signals') is null then 'ok (signals absent: view skipped)' else 'CHECK THIS' end;
