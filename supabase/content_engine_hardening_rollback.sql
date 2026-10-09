-- =============================================================================
-- ROLLBACK: the content engine's hardening and EdgeDesk's first-party features
-- (the editorial gate, the AI budget ledger, measurement and the scorecard,
-- the first_party table). Paste into the Supabase SQL editor.
--
-- ORDER MATTERS. The current doors call the objects this file drops, so:
--   1  run the PREVIOUS release of supabase/content_engine.sql first:
--        git show 007ac82a:supabase/content_engine.sql
--      It restores the earlier bodies of the doors, the overview and the
--      article guard, none of which reference anything below;
--   2  then run this file. It refuses to run (and changes nothing) if step 1
--      has not been done;
--   3  redeploy the previous Edge Function (supabase/functions/content_engine
--      at 007ac82a) and the previous admin page, and disable
--      .github/workflows/edgedesk-features.yml.
--
-- WHAT IS LOST, by design of a rollback:
--   * content_engine.ai_calls     the AI ledger (estimated spend, cache)
--   * content_engine.costs        billed and other costs you entered
--   * content_engine.first_party  held, dry-run and scheduled EdgeDesk
--                                 articles and your decisions on them
--   * the gate reports and your written reviews on each article
-- Published EdgeDesk features are files in the repository
-- (features/records/) and are NOT removed here: unpublish them by deleting
-- the record files, so their pages leave the site at the next build.
-- The activity log (content_engine.events) is append-only and is kept.
-- =============================================================================
do $guard$
begin
  if to_regprocedure('public.content_engine_article_approve(uuid, text)') is not null
     and pg_get_functiondef('public.content_engine_article_approve(uuid, text)'::regprocedure) like '%gate_problem%' then
    raise exception 'run the previous release of supabase/content_engine.sql first (git show 007ac82a:supabase/content_engine.sql): the current doors still use the gate';
  end if;
  if to_regprocedure('public.content_engine_overview()') is not null
     and pg_get_functiondef('public.content_engine_overview()'::regprocedure) like '%ai_month%' then
    raise exception 'run the previous release of supabase/content_engine.sql first: the overview still reads the AI ledger';
  end if;
end
$guard$;

-- first-party features
drop function if exists public.content_engine_fp_state(date);
drop function if exists public.content_engine_fp_record(jsonb);
drop function if exists public.content_engine_fp_list(int);
drop function if exists public.content_engine_fp_decide(text, text, text, text);
drop function if exists public.content_engine_fp_settings_save(jsonb);
drop function if exists content_engine.fp_all_gates(jsonb);
drop table if exists content_engine.first_party;
alter table content_engine.settings drop constraint if exists settings_fp_shape;
alter table content_engine.settings drop column if exists fp_mode, drop column if exists fp_publish_hour_ct, drop column if exists fp_max_per_week;

-- measurement, targets and the scorecard
drop function if exists public.content_engine_scorecard(int);
drop function if exists public.content_engine_weekly_data(int);
drop function if exists public.content_engine_cost_add(jsonb);
drop function if exists public.content_engine_targets_save(jsonb);
drop function if exists content_engine.attribution(timestamptz, timestamptz);
drop function if exists content_engine.user_revenue();
drop table if exists content_engine.costs;
alter table content_engine.settings drop constraint if exists settings_measurement_shape;
alter table content_engine.settings drop column if exists attribution_window_days, drop column if exists assisted_window_days,
  drop column if exists program_started_at, drop column if exists targets;

-- the AI budget ledger
drop function if exists public.content_engine_ai_reserve(text, uuid, text, text, int, int, int);
drop function if exists public.content_engine_ai_settle(bigint, jsonb, text, jsonb, jsonb);
drop function if exists public.content_engine_ai_budget();
drop function if exists public.content_engine_ai_budget_save(jsonb);
drop function if exists content_engine.ai_month(date);
drop function if exists content_engine.ai_cost(text, jsonb, numeric);
drop function if exists content_engine.ai_price(text);
drop function if exists content_engine.usage_sum(jsonb, text);
drop table if exists content_engine.ai_calls;
drop function if exists content_engine.ai_calls_guard();
drop function if exists content_engine.no_truncate();
alter table content_engine.settings drop constraint if exists settings_ai_budget_shape;
alter table content_engine.settings drop column if exists ai_monthly_budget_usd, drop column if exists ai_prices;

-- the editorial gate
drop function if exists public.content_engine_article_gate(uuid, text, jsonb);
drop function if exists public.content_engine_article_ack(uuid, text, text);
drop function if exists content_engine.gate_problem(content_engine.articles);
alter table content_engine.articles drop constraint if exists articles_gate_shape;
alter table content_engine.articles drop column if exists gate, drop column if exists gate_verdict, drop column if exists gate_hash,
  drop column if exists gate_at, drop column if exists acks, drop column if exists first_gate_verdict, drop column if exists first_gate_blocked;

-- the kinds and formats go back to the first release's lists only if no row uses a newer one
do $kinds$
begin
  if not exists (select 1 from content_engine.opportunities where kind in ('matchup_preview', 'postgame_review'))
     and not exists (select 1 from content_engine.articles where format in ('matchup_deep_dive', 'conference_race', 'model_vs_market', 'postgame_review')) then
    alter table content_engine.opportunities drop constraint if exists opportunities_kind_check;
    alter table content_engine.opportunities add constraint opportunities_kind_check check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story'));
    alter table content_engine.articles drop constraint if exists articles_format_check;
    alter table content_engine.articles add constraint articles_format_check check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom'));
  else
    raise notice 'kept the wider kind/format lists: rows use the newer templates (archive them first to narrow the lists)';
  end if;
end
$kinds$;

notify pgrst, 'reload schema';

select check_name, case when passed then 'ok' else 'CHECK THIS' end as result from (
  select 'the gate is gone' as check_name, to_regprocedure('public.content_engine_article_gate(uuid, text, jsonb)') is null as passed
  union all select 'the AI ledger is gone', to_regclass('content_engine.ai_calls') is null
  union all select 'measurement is gone', to_regprocedure('public.content_engine_scorecard(integer)') is null
  union all select 'first-party features are gone', to_regclass('content_engine.first_party') is null
  union all select 'the doors still answer (previous release)', to_regprocedure('public.content_engine_article_approve(uuid, text)') is not null
) r;
