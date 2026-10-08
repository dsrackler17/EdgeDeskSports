-- =============================================================================
-- EdgeDesk — the READER FUNNEL for EdgeDesk's own articles (Growth Console).
--
-- Search impressions → organic visits → visits → engaged readers → clicks to
-- the matchup research → registrations → trials → paid → revenue, per
-- first-party article and in total, against the 90-day targets.
--
-- WHAT EACH NUMBER IS (nothing here is estimated):
--   impressions, organic visits   Google Search Console's own rows for the
--                                 page (search_console_pages, growth_engine.sql).
--                                 Google only; days Google has not reported
--                                 yet are absent, not zero.
--   visits                        public_page_view events for the page, one
--                                 per browser session (funnel.sql).
--   engaged readers               article_engaged: 30 seconds visible AND half
--                                 the article read (lib/edgedesk_public.js).
--                                 NEVER sent by a browser with Global Privacy
--                                 Control or Do Not Track: those readers are
--                                 not counted here, by design.
--   research clicks               the article's one call to action
--                                 (public_cta_clicked, cta feature_research).
--   registrations                 confirmed accounts whose LAST touch landed
--                                 on the article (direct) — and, shown apart
--                                 and never added, whose FIRST touch did and
--                                 last did not (assisted). Owners excluded.
--   trials, paid                  Stripe's own events (growth_customer_facts),
--                                 for the direct registrations.
--   revenue                       Stripe invoices less refunds, de-duplicated
--                                 (content_engine.user_revenue), direct only.
-- Counts and sums only. No email, no name, no visitor id leaves this function.
--
-- Requires funnel.sql, growth.sql and growth_engine.sql; content_engine.sql
-- (for the list of EdgeDesk's own articles and for revenue) is optional.
-- Idempotent. Rollback: supabase/first_party_funnel_rollback.sql.
-- =============================================================================

-- the engagement event (client-sent; once per article per session)
insert into public.user_event_kinds (event_name, source, dedupe, stage, signed_in, description) values
  ('article_engaged', 'client', 'session_entity', 6, false,
   'A reader stayed with an EdgeDesk article: 30 seconds visible and half of it read (props.entity = article:slug). Never sent under Global Privacy Control or Do Not Track.')
on conflict (event_name) do nothing;

create or replace function public.growth_admin_article_funnel(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d int := greatest(7, least(coalesce(p_days, 30), 180)); f timestamptz := now() - make_interval(days => greatest(7, least(coalesce(p_days, 30), 180)));
  scale numeric; has_fp boolean := to_regclass('content_engine.first_party') is not null;
  has_gsc boolean := to_regclass('public.search_console_pages') is not null;
  has_bill boolean := to_regprocedure('public.growth_customer_facts()') is not null and to_regclass('public.stripe_events') is not null;
  has_rev boolean := to_regprocedure('content_engine.user_revenue()') is not null;
  arts jsonb := '[]'::jsonb; rows jsonb; tot jsonb; gsc_rows int := 0;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  scale := d / 30.0;
  if has_fp then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'title', title, 'kind', kind, 'published_at', published_at) order by published_at desc), '[]'::jsonb)
                from content_engine.first_party where status = 'published' and slug is not null$q$ into arts;
  end if;
  if has_gsc then select count(*) into gsc_rows from public.search_console_pages where day >= (f at time zone 'utc')::date; end if;

  create temp table if not exists fp_funnel_users (user_id uuid primary key, slug text, direct boolean) on commit drop;
  truncate fp_funnel_users;
  insert into fp_funnel_users
  select ua.user_id, a ->> 'slug',
         coalesce(ua.last_landing, '') ~ ('^/articles/' || (a ->> 'slug') || '/?$')
    from jsonb_array_elements(arts) a
    join public.user_acquisition ua on (coalesce(ua.last_landing, '') ~ ('^/articles/' || (a ->> 'slug') || '/?$')
                                     or coalesce(ua.first_landing, '') ~ ('^/articles/' || (a ->> 'slug') || '/?$'))
    join auth.users au on au.id = ua.user_id and au.email_confirmed_at is not null
   where coalesce(ua.signup_at, au.created_at) >= f
     and (to_regclass('growth_outbound.owners') is null or not exists (select 1 from growth_outbound.owners o where o.user_id = ua.user_id))
  on conflict (user_id) do nothing;

  select coalesce(jsonb_agg(r order by r ->> 'published_at' desc), '[]'::jsonb) into rows from (
    select jsonb_build_object(
      'slug', a ->> 'slug', 'title', a ->> 'title', 'kind', a ->> 'kind', 'published_at', a ->> 'published_at',
      'impressions', case when has_gsc then (select coalesce(sum(impressions), 0) from public.search_console_pages
                         where day >= (f at time zone 'utc')::date and page in ('https://edgedesksports.com/articles/' || (a ->> 'slug') || '/', 'https://edgedesksports.com/articles/' || (a ->> 'slug'))) end,
      'organic_visits', case when has_gsc then (select coalesce(sum(clicks), 0) from public.search_console_pages
                         where day >= (f at time zone 'utc')::date and page in ('https://edgedesksports.com/articles/' || (a ->> 'slug') || '/', 'https://edgedesksports.com/articles/' || (a ->> 'slug'))) end,
      'visits', (select count(*) from public.user_events e where e.event_name = 'public_page_view' and e.created_at >= f and e.event_properties ->> 'entity' = 'article:' || (a ->> 'slug')),
      'engaged', (select count(*) from public.user_events e where e.event_name = 'article_engaged' and e.created_at >= f and e.event_properties ->> 'entity' = 'article:' || (a ->> 'slug')),
      'research_clicks', (select count(*) from public.user_events e where e.event_name = 'public_cta_clicked' and e.created_at >= f
                           and e.event_properties ->> 'cta' = 'feature_research' and e.event_properties ->> 'page' = 'article:' || (a ->> 'slug')),
      'registrations', (select count(*) from fp_funnel_users u where u.slug = a ->> 'slug' and u.direct),
      'registrations_assisted', (select count(*) from fp_funnel_users u where u.slug = a ->> 'slug' and not u.direct),
      'trials', case when has_bill then (select count(*) from fp_funnel_users u join public.growth_customer_facts() c on c.user_id = u.user_id
                         where u.slug = a ->> 'slug' and u.direct and c.trial_started_at is not null) end,
      'paid', case when has_bill then (select count(*) from fp_funnel_users u join public.growth_customer_facts() c on c.user_id = u.user_id
                         where u.slug = a ->> 'slug' and u.direct and c.paid_at is not null) end) as r
      from jsonb_array_elements(arts) a) x;

  select jsonb_build_object(
    'articles', jsonb_array_length(rows),
    'impressions', case when has_gsc then (select coalesce(sum((r ->> 'impressions')::int), 0) from jsonb_array_elements(rows) r) end,
    'organic_visits', case when has_gsc then (select coalesce(sum((r ->> 'organic_visits')::int), 0) from jsonb_array_elements(rows) r) end,
    'visits', (select coalesce(sum((r ->> 'visits')::int), 0) from jsonb_array_elements(rows) r),
    'engaged', (select coalesce(sum((r ->> 'engaged')::int), 0) from jsonb_array_elements(rows) r),
    'research_clicks', (select coalesce(sum((r ->> 'research_clicks')::int), 0) from jsonb_array_elements(rows) r),
    'registrations', (select count(*) from fp_funnel_users where direct),
    'registrations_assisted', (select count(*) from fp_funnel_users where not direct),
    'trials', case when has_bill then (select count(*) from fp_funnel_users u join public.growth_customer_facts() c on c.user_id = u.user_id where u.direct and c.trial_started_at is not null) end,
    'paid', case when has_bill then (select count(*) from fp_funnel_users u join public.growth_customer_facts() c on c.user_id = u.user_id where u.direct and c.paid_at is not null) end,
    'revenue_usd', case when has_rev then (select round(coalesce(sum(r.collected_cents - r.refunded_cents), 0) / 100.0, 2)
                         from content_engine.user_revenue() r join fp_funnel_users u on u.user_id = r.user_id where u.direct) end) into tot;

  return jsonb_build_object('window', jsonb_build_object('days', d, 'from', f, 'to', now()),
    'measured', jsonb_build_object('first_party_list', has_fp, 'search_console', has_gsc and gsc_rows > 0, 'billing', has_bill, 'revenue', has_rev),
    'articles', rows, 'totals', tot,
    'targets', jsonb_build_array(
      jsonb_build_object('key', 'organic_visits', 'label', 'Organic visits a month (Google, Search Console)', 'target', 500, 'actual', case when has_gsc and gsc_rows > 0 then round((tot ->> 'organic_visits')::numeric / scale) end),
      jsonb_build_object('key', 'research_clicks', 'label', 'Article-to-research visits a month', 'target', 100, 'actual', round((tot ->> 'research_clicks')::numeric / scale)),
      jsonb_build_object('key', 'registrations', 'label', 'Registrations a month (direct)', 'target', 25, 'actual', round((tot ->> 'registrations')::numeric / scale, 1)),
      jsonb_build_object('key', 'paid', 'label', 'Paid subscribers a month (direct)', 'target', 3, 'actual', case when has_bill then round((tot ->> 'paid')::numeric / scale, 1) end)),
    'note', 'Counts only, owners excluded. Organic visits are Google Search Console clicks (other search engines are not measured). Engaged readers exclude every browser that sends Global Privacy Control or Do Not Track. Assisted registrations are shown apart and never added.');
end $$;
revoke all on function public.growth_admin_article_funnel(int) from public, anon;
grant execute on function public.growth_admin_article_funnel(int) to authenticated;

notify pgrst, 'reload schema';

select check_name, case when passed then 'ok' else 'CHECK THIS' end as result, detail from (
  select 'engagement event registered' as check_name, exists (select 1 from public.user_event_kinds where event_name = 'article_engaged') as passed,
         'article_engaged: client, once per article per session' as detail
  union all
  select 'the funnel is admin-only', not has_function_privilege('anon', 'public.growth_admin_article_funnel(integer)', 'execute'),
         'growth_is_admin() is checked inside'
  union all
  select 'EdgeDesk''s own articles are listed', to_regclass('content_engine.first_party') is not null,
         'without content_engine.sql the funnel lists no articles'
) r;
