-- =============================================================================
-- EdgeDesk — the Content Engine's football-evidence floor.
--
-- APPLY BY HAND, in the Supabase SQL editor, AFTER supabase/content_engine.sql
-- (and again after any re-application of it). Idempotent; ends in a report in
-- which every row should read ok. No workflow applies it.
--
-- WHY. A publisher showed us an article that put EdgeDesk's number next to a
-- market line nine points away and gave no football reason for the gap. The
-- fix lives in lib/football_evidence.js (one evidence packet per matchup, the
-- model-versus-market explanation, the editorial gate) and lib/content_engine.js
-- (the journalist-first writer). This file is the database's part:
--
--   1  the new topic (matchup_analysis) and formats (matchup_analysis for a
--      publisher, edgedesk_analysis for EdgeDesk's own pages) are allowed;
--   2  THE FLOOR: an article cannot be approved unless its stored checks
--      include the football evidence gate and the gate did not block it. A
--      browser running an old copy of the page cannot approve an article the
--      gate never saw. (Held-for-review articles may be approved: the owner's
--      source-verification point is the confirmation the hold asks for.)
--   3  an optional MONTHLY cap on Claude calls (null = not enforced; the daily
--      cap stays as it is), and a log of tokens and estimated cost per call,
--      priced with growth_outbound.model_price() where it exists;
--   4  content_engine_editorial_metrics(): editorial acceptance and traffic,
--      reported separately, from what the database already records. Nothing
--      is estimated: a figure that is not measured is null and says so.
-- =============================================================================

do $guard$ begin
  if to_regclass('content_engine.articles') is null then
    raise exception 'apply supabase/content_engine.sql first';
  end if;
end $guard$;

-- 1 ── topics and formats ──────────────────────────────────────────────────────
do $k$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'content_engine.opportunities'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%weekly_preview%' and pg_get_constraintdef(oid) like '%upset_watch%' loop
    execute format('alter table content_engine.opportunities drop constraint %I', c);
  end loop;
  alter table content_engine.opportunities add constraint opportunities_kind_check
    check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'matchup_analysis'));

  for c in select conname from pg_constraint
            where conrelid = 'content_engine.articles'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%cfb_weekly_preview%' and pg_get_constraintdef(oid) like '%publisher_custom%' loop
    execute format('alter table content_engine.articles drop constraint %I', c);
  end loop;
  alter table content_engine.articles add constraint articles_format_check
    check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom', 'matchup_analysis', 'edgedesk_analysis'));
end $k$;

-- 2 ── the floor ───────────────────────────────────────────────────────────────
create or replace function content_engine.evidence_floor()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    if not (coalesce(new.checks -> 'checks', '[]'::jsonb) @> '[{"gate": "evidence"}]'::jsonb) then
      raise exception 'approval needs the football evidence gate: re-run the checks in the current Content Engine page and save'
        using errcode = 'check_violation';
    end if;
    if coalesce(new.checks ->> 'readiness', '') = 'BLOCKED' then
      raise exception 'the football evidence gate blocks this article' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
-- BEFORE triggers fire in name order: this one runs before articles_guard
drop trigger if exists articles_evidence_floor on content_engine.articles;
create trigger articles_evidence_floor before update on content_engine.articles
  for each row execute function content_engine.evidence_floor();

-- 3 ── the monthly cap and the cost log ────────────────────────────────────────
alter table content_engine.settings add column if not exists llm_calls_per_month int;
do $c$ begin
  alter table content_engine.settings drop constraint if exists settings_llm_month_ck;
  alter table content_engine.settings add constraint settings_llm_month_ck check (llm_calls_per_month is null or llm_calls_per_month between 0 and 5000);
end $c$;

create table if not exists content_engine.ai_usage (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  model          text check (model is null or length(model) <= 80),
  purpose        text check (purpose is null or purpose ~ '^[a-z_]{3,40}$'),
  article_id     uuid,
  input_tokens   int not null default 0 check (input_tokens >= 0),
  output_tokens  int not null default 0 check (output_tokens >= 0),
  cost_usd       numeric(12, 6) check (cost_usd is null or cost_usd >= 0)
);
alter table content_engine.ai_usage enable row level security;
drop trigger if exists ai_usage_append_only on content_engine.ai_usage;
create trigger ai_usage_append_only before update or delete on content_engine.ai_usage
  for each row execute function content_engine.append_only();

-- one call counted BEFORE it is made, against the day's cap and (if set) the month's
create or replace function public.content_engine_spend(p_provider text, p_n int default 1)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); cap int; used int; mcap int; mused int; d date := (now() at time zone 'utc')::date;
begin
  if p_provider not in ('llm', 'fetch') or coalesce(p_n, 0) < 1 or p_n > 20 then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  select case when p_provider = 'llm' then llm_calls_per_day else fetch_calls_per_day end, case when p_provider = 'llm' then llm_calls_per_month end
    into cap, mcap from content_engine.settings where id = 1;
  insert into content_engine.usage (day, provider, calls) values (d, p_provider, 0) on conflict do nothing;
  select calls into used from content_engine.usage where day = d and provider = p_provider for update;
  if used + p_n > cap then
    perform content_engine.log(who, 'budget_exhausted', null, null, null, jsonb_build_object('provider', p_provider, 'cap', cap, 'used', used));
    return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'cap', cap, 'used', used);
  end if;
  if mcap is not null then
    select coalesce(sum(calls), 0) into mused from content_engine.usage where provider = p_provider and day >= date_trunc('month', d)::date;
    if mused + p_n > mcap then
      perform content_engine.log(who, 'budget_exhausted', null, null, null, jsonb_build_object('provider', p_provider, 'period', 'month', 'cap', mcap, 'used', mused));
      return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'period', 'month', 'cap', mcap, 'used', mused);
    end if;
  end if;
  update content_engine.usage set calls = calls + p_n where day = d and provider = p_provider;
  return jsonb_build_object('ok', true, 'cap', cap, 'used', used + p_n, 'month_cap', mcap, 'month_used', case when mcap is null then null else mused + p_n end);
end $$;

-- the job and the function record what a call cost, after it is made
create or replace function public.content_engine_ai_usage_record(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); price jsonb; cost numeric; i int; o int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  i := greatest(0, coalesce((p ->> 'input_tokens')::int, 0)); o := greatest(0, coalesce((p ->> 'output_tokens')::int, 0));
  if to_regprocedure('growth_outbound.model_price(text)') is not null then
    execute 'select growth_outbound.model_price($1)' into price using p ->> 'model';
  end if;
  cost := case when price is null then null else round((i * (price ->> 'in')::numeric + o * (price ->> 'out')::numeric) / 1000000, 6) end;
  insert into content_engine.ai_usage (model, purpose, article_id, input_tokens, output_tokens, cost_usd)
  values (left(p ->> 'model', 80), nullif(p ->> 'purpose', ''), nullif(p ->> 'article_id', '')::uuid, i, o, cost);
  return jsonb_build_object('ok', true, 'cost_usd', cost, 'priced', price is not null, 'by', who);
exception when invalid_text_representation or check_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid');
end $$;

-- 4 ── editorial metrics ───────────────────────────────────────────────────────
-- the checks the evidence gate and the number check count as "unsupported claims caught"
create or replace function content_engine.unsupported_ids()
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select array['numbers_in_evidence', 'teams_in_evidence', 'football_evidence', 'qb_discussed', 'injuries_addressed', 'contrary_evidence',
               'unexplained_disclosed', 'causal_supported', 'injury_status_correct', 'historical_dated', 'gap_arithmetic', 'no_edge_language',
               'sources_known', 'reported_attributed', 'evidence_packet'];
$$;

create or replace function public.content_engine_editorial_metrics(p_days int default 90)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 3650)));
  ed jsonb; tr jsonb; cost jsonb; caught jsonb; paid int; published int; usd numeric;
begin
  perform content_engine.require_owner();
  /* editorial acceptance: what the gate and the owner did with the drafts */
  select jsonb_build_object(
    'articles', count(*),
    'passed_initial_checks', count(*) filter (where exists (select 1 from content_engine.revisions r where r.article_id = a.id and r.revision = 1 and coalesce((r.checks ->> 'ok')::boolean, false))),
    'held_for_review', count(*) filter (where a.checks ->> 'readiness' = 'HOLD_FOR_REVIEW' and a.status in ('draft', 'in_review')),
    'blocked_now', count(*) filter (where a.checks ->> 'readiness' = 'BLOCKED' and a.status in ('draft', 'in_review')),
    'approved_or_later', count(*) filter (where a.status in ('approved', 'ready_to_send', 'sent', 'published')),
    'revisions_before_approval_avg', round(avg(a.revision) filter (where a.approved_at is not null), 2),
    'sent', count(*) filter (where a.status in ('sent', 'published')),
    'published', count(*) filter (where a.status = 'published'),
    'publisher_acceptance_rate', case when count(*) filter (where a.status in ('sent', 'published')) = 0 then null
      else round(count(*) filter (where a.status = 'published')::numeric / count(*) filter (where a.status in ('sent', 'published')), 3) end,
    'first_party_articles', count(*) filter (where a.format = 'edgedesk_analysis'))
    into ed from content_engine.articles a where a.created_at >= since;
  select count(*) filter (where a.status = 'published') into published from content_engine.articles a where a.created_at >= since;
  /* unsupported claims caught: every failing evidence or number check, in every saved revision */
  select coalesce(jsonb_object_agg(id, n), '{}'::jsonb) into caught from (
    select f.id, count(*) as n from content_engine.revisions r
      cross join lateral jsonb_array_elements_text(coalesce(r.checks -> 'failed', '[]'::jsonb)) as f(id)
     where r.created_at >= since and f.id = any (content_engine.unsupported_ids())
     group by f.id) q;
  ed := ed || jsonb_build_object('unsupported_claims_caught', caught,
    'unsupported_claims_caught_total', (select coalesce(sum(value::int), 0) from jsonb_each_text(caught)),
    'ai_drafts_discarded', (select count(*) from content_engine.events e where e.kind = 'ai_discarded' and e.at >= since));
  /* traffic: EdgeDesk's own measurement through each sent article's tagged link */
  select jsonb_build_object(
    'visits', sum(nullif(fp ->> 'visits', '')::int), 'sessions', sum(nullif(fp ->> 'sessions', '')::int),
    'signups', sum(nullif(fp ->> 'signups', '')::int), 'trials', sum(nullif(fp ->> 'trials', '')::int), 'paid', sum(nullif(fp ->> 'paid', '')::int),
    'publisher_reported_page_views', (select sum(m.value) from content_engine.performance m join content_engine.articles a2 on a2.id = m.article_id
                                        where a2.created_at >= since and m.metric = 'page_views'))
    into tr from (select content_engine.first_party(a.campaign_code) as fp from content_engine.articles a
                   where a.created_at >= since and a.status in ('sent', 'published')) q;
  paid := nullif(tr ->> 'paid', '')::int;
  /* cost: only what was recorded */
  select sum(cost_usd) into usd from content_engine.ai_usage where at >= since;
  cost := jsonb_build_object(
    'llm_calls', (select coalesce(sum(calls), 0) from content_engine.usage where provider = 'llm' and day >= since::date),
    'input_tokens', (select sum(input_tokens) from content_engine.ai_usage where at >= since),
    'output_tokens', (select sum(output_tokens) from content_engine.ai_usage where at >= since),
    'cost_usd', usd,
    'cost_per_published_article', case when usd is null or coalesce(published, 0) = 0 then null else round(usd / published, 4) end,
    'cost_per_paid_conversion', case when usd is null or coalesce(paid, 0) = 0 then null else round(usd / paid, 4) end,
    'month_cap', (select llm_calls_per_month from content_engine.settings where id = 1));
  return jsonb_build_object('since', since, 'editorial', ed, 'traffic', tr, 'cost', cost,
    'note', 'Editorial acceptance and traffic are reported separately. A null figure is not measured (no tagged visits yet, no token log, or no published article), never an estimate. Cost is the token log priced with growth_outbound.model_price(); calls made before this file was applied have no tokens on record.');
end $$;

-- who may call the new doors: the owner, and the job for the usage record
do $grants$ begin
  revoke all on function public.content_engine_editorial_metrics(int) from public;
  revoke all on function public.content_engine_ai_usage_record(jsonb) from public;
  revoke all on function public.content_engine_spend(text, int) from public;
  begin
    revoke all on function public.content_engine_editorial_metrics(int) from anon, authenticated, service_role;
    revoke all on function public.content_engine_ai_usage_record(jsonb) from anon;
    revoke all on function public.content_engine_spend(text, int) from anon;
    grant execute on function public.content_engine_editorial_metrics(int) to authenticated;
    grant execute on function public.content_engine_ai_usage_record(jsonb) to authenticated, service_role;
    grant execute on function public.content_engine_spend(text, int) to authenticated, service_role;
  exception when undefined_object then null; end;
end $grants$;
revoke all on all functions in schema content_engine from public;

notify pgrst, 'reload schema';

-- REPORT: every row should say ok.
select check_name, case when passed then 'ok' else 'CHECK THIS' end as result, detail from (
  select 'matchup analysis is an allowed topic' as check_name,
         exists (select 1 from pg_constraint where conrelid = 'content_engine.opportunities'::regclass and conname = 'opportunities_kind_check'
                  and pg_get_constraintdef(oid) like '%matchup_analysis%') as passed,
         'opportunities.kind' as detail
  union all
  select 'the two analysis formats are allowed',
         exists (select 1 from pg_constraint where conrelid = 'content_engine.articles'::regclass and conname = 'articles_format_check'
                  and pg_get_constraintdef(oid) like '%edgedesk_analysis%'),
         'articles.format: matchup_analysis (publisher), edgedesk_analysis (first-party)'
  union all
  select 'the evidence floor guards approval',
         exists (select 1 from pg_trigger where tgname = 'articles_evidence_floor' and tgrelid = 'content_engine.articles'::regclass),
         'no approval without the football evidence gate in the checks, and never when it blocks'
  union all
  select 'the monthly cap is available (null = off)',
         exists (select 1 from information_schema.columns where table_schema = 'content_engine' and table_name = 'settings' and column_name = 'llm_calls_per_month'),
         coalesce((select 'set to ' || llm_calls_per_month from content_engine.settings where id = 1 and llm_calls_per_month is not null), 'not set: the daily cap alone applies')
  union all
  select 'the metrics door is owner-only',
         not has_function_privilege('service_role', 'public.content_engine_editorial_metrics(int)', 'execute')
         and not has_function_privilege('anon', 'public.content_engine_editorial_metrics(int)', 'execute'),
         'content_engine_editorial_metrics()'
) r;
