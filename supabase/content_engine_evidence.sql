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
--   1  THE FLOOR: an article cannot be approved unless its stored checks
--      include the football evidence gate and the gate did not block it. A
--      browser running an old copy of the page cannot approve an article the
--      gate never saw. (Held-for-review articles may be approved: the owner's
--      source-verification point is the confirmation the hold asks for.)
--   2  content_engine_editorial_metrics(): editorial acceptance (including the
--      unsupported claims the gate caught), traffic and cost, reported
--      separately, from what the database already records. Cost reads the AI
--      ledger content_engine.sql keeps (content_engine.ai_calls); nothing is
--      estimated here: a figure that is not measured is null and says so.
--
-- The matchup_analysis topic and format, and the monthly AI budget, live in
-- supabase/content_engine.sql itself.
-- =============================================================================

do $guard$ begin
  if to_regclass('content_engine.articles') is null then
    raise exception 'apply supabase/content_engine.sql first';
  end if;
end $guard$;

-- 1 ── the floor ───────────────────────────────────────────────────────────────
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

-- 2 ── editorial metrics ───────────────────────────────────────────────────────
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
    'matchup_analyses', count(*) filter (where a.format = 'matchup_analysis'))
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
  /* cost: the AI ledger's settled calls (estimated at list prices from the API's own token counts) */
  select sum(est_usd) into usd from content_engine.ai_calls where created_at >= since and status in ('completed', 'failed');
  cost := jsonb_build_object(
    'llm_calls', (select count(*) from content_engine.ai_calls where created_at >= since and status in ('completed', 'failed')),
    'cache_hits', (select count(*) from content_engine.ai_calls where created_at >= since and status = 'cache_hit'),
    'input_tokens', (select sum(input_tokens) from content_engine.ai_calls where created_at >= since),
    'output_tokens', (select sum(output_tokens) from content_engine.ai_calls where created_at >= since),
    'cost_usd_estimated', usd,
    'cost_per_published_article', case when usd is null or coalesce(published, 0) = 0 then null else round(usd / published, 4) end,
    'cost_per_paid_conversion', case when usd is null or coalesce(paid, 0) = 0 then null else round(usd / paid, 4) end,
    'monthly_budget_usd', (select ai_monthly_budget_usd from content_engine.settings where id = 1));
  return jsonb_build_object('since', since, 'editorial', ed, 'traffic', tr, 'cost', cost,
    'note', 'Editorial acceptance and traffic are reported separately. A null figure is not measured (no tagged visits yet, no settled AI call, or no published article), never an estimate. Cost is the AI ledger''s estimate at list prices, not the invoice (billed amounts are entered under Costs).');
end $$;

-- who may call the new door: the owner only
do $grants$ begin
  revoke all on function public.content_engine_editorial_metrics(int) from public;
  begin
    revoke all on function public.content_engine_editorial_metrics(int) from anon, authenticated, service_role;
    grant execute on function public.content_engine_editorial_metrics(int) to authenticated;
  exception when undefined_object then null; end;
end $grants$;
revoke all on all functions in schema content_engine from public;

notify pgrst, 'reload schema';

-- REPORT: every row should say ok.
select check_name, case when passed then 'ok' else 'CHECK THIS' end as result, detail from (
  select 'the evidence floor guards approval' as check_name,
         exists (select 1 from pg_trigger where tgname = 'articles_evidence_floor' and tgrelid = 'content_engine.articles'::regclass) as passed,
         'no approval without the football evidence gate in the checks, and never when it blocks' as detail
  union all
  select 'the metrics door is owner-only',
         not has_function_privilege('service_role', 'public.content_engine_editorial_metrics(int)', 'execute')
         and not has_function_privilege('anon', 'public.content_engine_editorial_metrics(int)', 'execute'),
         'content_engine_editorial_metrics()'
) r;
