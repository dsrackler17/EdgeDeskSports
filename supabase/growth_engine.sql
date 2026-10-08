-- =============================================================================
-- growth_engine — the owner's acquisition dashboard, measured revenue, the
-- Search Console import, the weekly growth report and referral review flags.
--
-- WHAT IT ADDS (everything else it reads already exists):
--   search_console_pages / _queries / _runs
--                      daily clicks, impressions, CTR and position by page and
--                      by query, written by tools/growth/gsc_import.js (a
--                      GitHub job holding a Google service account and the
--                      Supabase service role). Empty until that is configured,
--                      and the dashboard says "not connected" rather than 0.
--   growth_invoice_payments()   every paid invoice Stripe told the webhook
--                      about, one row per invoice, resolved to an account.
--   growth_mrr()       MRR from the price Stripe has on file for each live
--                      subscription. MEASURED where a price is on file; the
--                      net-of-discount and if-every-trial-converts figures
--                      are labelled ESTIMATES. Comps are never revenue.
--   growth_acquisition_payload(from, to)
--                      the whole report for a window: visitors by channel,
--                      landing pages, campaigns, public pages, free tools,
--                      calls to action, newsletter signups, trials, paid
--                      conversions and cash collected by first-touch channel,
--                      MRR, outbound performance by landing page, Search
--                      Console, and the partner program with review flags.
--   growth_admin_acquisition(p_days)        operators only (growth_is_admin)
--   growth_weekly_snapshot()                the service role / pg_cron only:
--                      freezes last week's report into growth_weekly_reports
--   growth_admin_weekly_reports(p_limit)    operators only
--
-- WHAT IT NEVER DOES: write to the affiliate ledger, approve or pay a
-- commission, change a subscription, or send anything. Referral flags are
-- for a person to review; nothing acts on them.
--
-- MEASURED vs ESTIMATED. Every figure in the payload is a count or a sum of
-- rows that exist. The two that are not — net MRR after discounts, and MRR if
-- every trial converts — carry "_estimate" in their names and a note.
--
-- RUN ORDER: billing.sql, stripe_webhook.sql, affiliates.sql, growth.sql,
-- funnel.sql (and newsletter.sql, growth_outbound.sql where installed — the
-- report reads them when they exist and says "not installed" when not).
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, ends in a report. Safe to run again. Nothing is dropped.
-- =============================================================================

do $guard$
begin
  if to_regprocedure('public.growth_is_admin()') is null or to_regclass('public.acquisition_visitors') is null then
    raise exception 'Run supabase/growth.sql first (acquisition and the operator check live there).';
  end if;
  if to_regclass('public.user_events') is null then
    raise exception 'Run supabase/funnel.sql first (the page events live there).';
  end if;
  if to_regclass('public.stripe_events') is null or to_regclass('public.subscriptions') is null then
    raise exception 'Run supabase/billing.sql and supabase/stripe_webhook.sql first.';
  end if;
  if to_regprocedure('public.affiliate_stripe_object(jsonb)') is null then
    raise exception 'Run supabase/affiliates.sql first.';
  end if;
end
$guard$;

-- ── 1. Search Console, as imported ───────────────────────────────────────────
create table if not exists public.search_console_pages (
  day          date not null,
  page         text not null,
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  ctr          numeric,
  position     numeric,
  imported_at  timestamptz not null default now(),
  primary key (day, page)
);
create table if not exists public.search_console_queries (
  day          date not null,
  query        text not null,
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  ctr          numeric,
  position     numeric,
  imported_at  timestamptz not null default now(),
  primary key (day, query)
);
create table if not exists public.search_console_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  site        text,
  start_day   date,
  end_day     date,
  pages       integer,
  queries     integer,
  ok          boolean not null default false,
  note        text
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'search_console_pages_shape') then
    alter table public.search_console_pages add constraint search_console_pages_shape check (
      clicks >= 0 and impressions >= 0 and length(page) <= 600 and page ~ '^https?://');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'search_console_queries_shape') then
    alter table public.search_console_queries add constraint search_console_queries_shape check (
      clicks >= 0 and impressions >= 0 and length(query) <= 300);
  end if;
end $c$;
create index if not exists search_console_pages_day on public.search_console_pages (day);
create index if not exists search_console_queries_day on public.search_console_queries (day);
alter table public.search_console_pages enable row level security;
alter table public.search_console_queries enable row level security;
alter table public.search_console_runs enable row level security;
revoke all on public.search_console_pages from anon, authenticated;
revoke all on public.search_console_queries from anon, authenticated;
revoke all on public.search_console_runs from anon, authenticated;
grant select, insert, update, delete on public.search_console_pages to service_role;
grant select, insert, update, delete on public.search_console_queries to service_role;
grant select, insert on public.search_console_runs to service_role;

-- ── 2. the weekly report, frozen ─────────────────────────────────────────────
create table if not exists public.growth_weekly_reports (
  week_start  date primary key,
  week_end    date not null,
  built_at    timestamptz not null default now(),
  payload     jsonb not null
);
alter table public.growth_weekly_reports enable row level security;
revoke all on public.growth_weekly_reports from anon, authenticated;

-- ── 3. paid invoices, one row per invoice ────────────────────────────────────
-- Resolved to an account the way growth_customer_facts() resolves them (the
-- event's own user, else the subscription, else the customer). A $0 invoice
-- (a trial's) is not a payment. Test-mode events are marked, never mixed.
create or replace function public.growth_invoice_payments()
returns table (user_id uuid, invoice_id text, amount_cents bigint, currency text, paid_at timestamptz, livemode boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with ev as (
    select coalesce(e.stripe_created, e.created_at) as at, public.affiliate_stripe_object(e.payload) as o,
           e.user_id as uid0, e.customer_id, e.subscription_id,
           case when e.payload ->> 'livemode' in ('true', 'false') then (e.payload ->> 'livemode')::boolean end as live
      from public.stripe_events e
     where e.type in ('invoice.payment_succeeded', 'invoice.paid')
  ), res as (
    select ev.*, coalesce(ev.uid0,
             (select s.user_id from public.subscriptions s
               where s.stripe_subscription_id = coalesce(ev.subscription_id, public.affiliate_stripe_id(ev.o -> 'subscription'),
                       public.affiliate_stripe_id(ev.o -> 'parent' -> 'subscription_details' -> 'subscription')) limit 1),
             (select s.user_id from public.subscriptions s
               where s.stripe_customer_id = coalesce(ev.customer_id, public.affiliate_stripe_id(ev.o -> 'customer')) limit 1)) as uid
      from ev
  )
  select distinct on (o ->> 'id') uid, o ->> 'id', (o ->> 'amount_paid')::bigint, lower(coalesce(o ->> 'currency', 'usd')), at, live
    from res
   where (o ->> 'amount_paid') ~ '^[0-9]{1,12}$' and (o ->> 'amount_paid')::bigint > 0 and coalesce(o ->> 'id', '') <> ''
   order by o ->> 'id', at asc;
$$;
revoke all on function public.growth_invoice_payments() from public, anon, authenticated;

-- ── 4. MRR ──────────────────────────────────────────────────────────────────
-- From the price on the latest customer.subscription.* event for each live
-- subscription (the same read my_subscription_price() makes for one reader).
--   mrr_list_cents          active + past_due, priced, live mode, USD:
--                           unit_amount × quantity, as a monthly amount
--   mrr_net_cents_estimate  the same less a recurring coupon on file (an
--                           ESTIMATE: a repeating coupon ends on its own date)
--   trial_mrr_list_cents_estimate  what the trialing subscriptions would add
--                           at list price if every one converted (an ESTIMATE)
-- A subscription with no price event on file is counted, not guessed.
create or replace function public.growth_mrr()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select s.user_id, s.status, s.price_id, s.stripe_subscription_id
      from public.subscriptions s
     where s.status in ('active', 'past_due', 'trialing')
       and coalesce(s.price_id, '') not in ('owner_comp', 'comp_trial')
  ), ev as (
    select s.*, x.o, x.live
      from s
      left join lateral (
        select public.affiliate_stripe_object(e.payload) as o,
               case when e.payload ->> 'livemode' in ('true', 'false') then (e.payload ->> 'livemode')::boolean end as live
          from public.stripe_events e
         where s.stripe_subscription_id is not null and e.subscription_id = s.stripe_subscription_id
           and e.type in ('customer.subscription.created', 'customer.subscription.updated')
         order by e.stripe_created desc nulls last, e.created_at desc
         limit 1) x on true
  ), it as (
    select ev.*, case when jsonb_typeof(ev.o -> 'items' -> 'data') = 'array' then ev.o -> 'items' -> 'data' -> 0 end as item
      from ev
  ), pr as (
    select it.*,
           case when (it.item -> 'price' ->> 'unit_amount') ~ '^[0-9]{1,9}$' then (it.item -> 'price' ->> 'unit_amount')::numeric end as unit,
           case when (it.item ->> 'quantity') ~ '^[0-9]{1,6}$' then (it.item ->> 'quantity')::numeric else 1 end as qty,
           it.item -> 'price' -> 'recurring' ->> 'interval' as iv,
           case when (it.item -> 'price' -> 'recurring' ->> 'interval_count') ~ '^[0-9]{1,4}$'
                then greatest(1, (it.item -> 'price' -> 'recurring' ->> 'interval_count')::numeric) else 1 end as ivc,
           lower(coalesce(it.item -> 'price' ->> 'currency', 'usd')) as cur,
           case when jsonb_typeof(it.o -> 'discount' -> 'coupon') = 'object' then it.o -> 'discount' -> 'coupon'
                when jsonb_typeof(it.o -> 'discounts' -> 0 -> 'coupon') = 'object' then it.o -> 'discounts' -> 0 -> 'coupon' end as coupon
      from it
  ), m as (
    select pr.*,
           case pr.iv when 'month' then pr.unit * pr.qty / pr.ivc
                      when 'year' then pr.unit * pr.qty / (12 * pr.ivc)
                      when 'week' then pr.unit * pr.qty * 52 / (12 * pr.ivc)
                      when 'day' then pr.unit * pr.qty * 365 / (12 * pr.ivc) end as monthly,
           case when (pr.coupon ->> 'percent_off') ~ '^[0-9]+(\.[0-9]+)?$' then (pr.coupon ->> 'percent_off')::numeric else 0 end as pct_off,
           case when (pr.coupon ->> 'amount_off') ~ '^[0-9]{1,9}$' then (pr.coupon ->> 'amount_off')::numeric else 0 end as amt_off
      from pr
  ), k as (
    select m.*, (m.status in ('active', 'past_due')) as paying, coalesce(m.live, true) as is_live, (m.cur = 'usd') as usd from m
  )
  select jsonb_build_object(
    'paying_subscriptions', count(*) filter (where paying and is_live),
    'paying_priced', count(*) filter (where paying and is_live and monthly is not null and usd),
    'paying_price_not_on_file', count(*) filter (where paying and is_live and monthly is null),
    'past_due', count(*) filter (where status = 'past_due' and is_live),
    'mrr_list_cents', round(coalesce(sum(monthly) filter (where paying and is_live and usd), 0)),
    'mrr_net_cents_estimate', round(coalesce(sum(case when coupon ->> 'duration' in ('forever', 'repeating')
        then greatest(0, monthly * (1 - pct_off / 100) - amt_off) else monthly end)
        filter (where paying and is_live and usd and monthly is not null), 0)),
    'trialing', count(*) filter (where status = 'trialing' and is_live),
    'trial_mrr_list_cents_estimate', round(coalesce(sum(monthly) filter (where status = 'trialing' and is_live and usd), 0)),
    'test_mode_excluded', count(*) filter (where not is_live),
    'currency', 'usd',
    'basis', 'the price on the latest customer.subscription.* event Stripe delivered for each subscription; comps excluded')
  from k;
$$;
revoke all on function public.growth_mrr() from public, anon, authenticated;

-- ── 5. referral review flags (for a person; nothing acts on them) ────────────
create or replace function public.growth_referral_flags(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out jsonb := '[]'::jsonb;
begin
  if to_regclass('public.affiliate_attributions') is null then return out; end if;
  -- one browser, several attributed accounts
  out := out || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'same_browser_multiple_accounts', 'code', a.code,
             'accounts', a.n, 'detail', 'one visitor id claimed ' || a.n || ' attributed accounts'))
      from (select max(code) as code, count(*)::int as n from public.affiliate_attributions
             where visitor_hash is not null and attributed_at >= p_from and attributed_at < p_to
             group by visitor_hash having count(*) > 1) a), '[]'::jsonb);
  -- a burst: many attributions to one code inside an hour
  out := out || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'attribution_burst', 'code', b.code, 'accounts', b.n,
             'detail', b.n || ' attributions to one code inside an hour starting ' || to_char(b.h, 'YYYY-MM-DD HH24:00') || ' UTC'))
      from (select code, date_trunc('hour', attributed_at) as h, count(*)::int as n from public.affiliate_attributions
             where attributed_at >= p_from and attributed_at < p_to group by 1, 2 having count(*) >= 5) b), '[]'::jsonb);
  -- the same Stripe customer behind more than one attributed account
  out := out || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'shared_stripe_customer', 'code', c.code, 'accounts', c.n,
             'detail', c.n || ' attributed accounts share one Stripe customer'))
      from (select max(a.code) as code, count(*)::int as n
              from public.affiliate_attributions a join public.subscriptions s on s.user_id = a.user_id
             where s.stripe_customer_id is not null and a.attributed_at >= p_from and a.attributed_at < p_to
             group by s.stripe_customer_id having count(*) > 1) c), '[]'::jsonb);
  -- the same card behind more than one attributed account (needs charge events
  -- with a card fingerprint in the webhook ledger; empty without them)
  out := out || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'shared_card', 'code', f.code, 'accounts', f.n,
             'detail', f.n || ' attributed accounts paid with the same card fingerprint'))
      from (select max(a.code) as code, count(distinct a.user_id)::int as n
              from public.stripe_events e
              join public.affiliate_attributions a on a.user_id = e.user_id
              cross join lateral (select public.affiliate_stripe_object(e.payload) -> 'payment_method_details' -> 'card' ->> 'fingerprint' as fp) x
             where e.type in ('charge.succeeded', 'charge.updated') and x.fp is not null
               and a.attributed_at >= p_from and a.attributed_at < p_to
             group by x.fp having count(distinct a.user_id) > 1) f), '[]'::jsonb);
  -- refunded after an attributed payment
  if to_regclass('public.affiliate_conversions') is not null then
    out := out || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'refund_after_attribution', 'code', r.code, 'accounts', r.n,
               'detail', r.n || ' attributed account(s) refunded in the window'))
        from (select max(a.code) as code, count(distinct c.user_id)::int as n
                from public.affiliate_conversions c join public.affiliate_attributions a on a.user_id = c.user_id
               where c.kind = 'refunded' and c.occurred_at >= p_from and c.occurred_at < p_to
               group by a.affiliate_id) r), '[]'::jsonb);
  end if;
  return out;
end $$;
revoke all on function public.growth_referral_flags(timestamptz, timestamptz) from public, anon, authenticated;

-- ── 6. the report ────────────────────────────────────────────────────────────
-- Internal: no operator check, so it is callable only by the two doors below.
create or replace function public.growth_acquisition_payload(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to   timestamptz := coalesce(p_to, now());
  v_trial_days int := 7;
  channels jsonb; landing jsonb; campaigns jsonb; pages jsonb; tools jsonb; ctas jsonb; nl jsonb;
  funnel jsonb; revenue jsonb; mrr jsonb; outbound jsonb := jsonb_build_object('installed', false);
  search jsonb; refs jsonb := jsonb_build_object('installed', false); totals jsonb;
begin
  begin select coalesce(trial_days, 7) into v_trial_days from public.activation_settings where id = 1;
  exception when others then v_trial_days := 7; end;
  v_trial_days := coalesce(v_trial_days, 7);

  -- accounts, with their first touch and what Stripe says they did
  create temporary table if not exists pg_temp.ge_acc (user_id uuid, signup_at timestamptz, trial_at timestamptz,
    paid_at timestamptz, paid_invoices int, source text, landing text, campaign text, utm_source text, utm_medium text) on commit drop;
  truncate pg_temp.ge_acc;
  insert into pg_temp.ge_acc
  select g.user_id, g.signup_at, g.trial_started_at, g.paid_at, g.paid_invoices,
         coalesce(ua.first_source, '(untracked)'), ua.first_landing, ua.first_utm_campaign, ua.first_utm_source, ua.first_utm_medium
    from public.growth_customer_facts() g
    left join public.user_acquisition ua on ua.user_id = g.user_id;

  create temporary table if not exists pg_temp.ge_pay (user_id uuid, amount_cents bigint, paid_at timestamptz) on commit drop;
  truncate pg_temp.ge_pay;
  insert into pg_temp.ge_pay select p.user_id, p.amount_cents, p.paid_at from public.growth_invoice_payments() p
   where coalesce(p.livemode, true) and p.currency = 'usd';

  -- VISITORS BY CHANNEL (first touch), with what those channels' accounts did
  with src(source, ord) as (
    select * from unnest(array['search','organic_x','x_dm','creator_affiliate','linkedin','newsletter','outbound_email',
                               'direct','referral','other','(untracked)']) with ordinality
  ), vis as (
    select first_source as source, count(*)::int as n from public.acquisition_visitors
     where first_seen_at >= v_from and first_seen_at < v_to group by 1
  ), r as (
    select src.source, src.ord,
           coalesce((select n from vis where vis.source = src.source), 0) as visitors,
           (select count(*) from pg_temp.ge_acc a where a.source = src.source and a.signup_at >= v_from and a.signup_at < v_to)::int as signups,
           (select count(*) from pg_temp.ge_acc a where a.source = src.source and a.trial_at >= v_from and a.trial_at < v_to)::int as trials,
           (select count(*) from pg_temp.ge_acc a where a.source = src.source and a.paid_at >= v_from and a.paid_at < v_to)::int as paid,
           (select coalesce(sum(p.amount_cents), 0) from pg_temp.ge_pay p join pg_temp.ge_acc a on a.user_id = p.user_id
             where a.source = src.source and p.paid_at >= v_from and p.paid_at < v_to)::bigint as collected_cents
      from src
  )
  select jsonb_agg(to_jsonb(r) - 'ord' order by r.ord) into channels from r;

  -- LANDING PAGES: where first touches arrived, and what came of them
  select coalesce(jsonb_agg(x order by (x ->> 'visitors')::int desc), '[]'::jsonb) into landing from (
    select jsonb_build_object('landing', l.landing, 'visitors', l.n,
             'signups', (select count(*) from pg_temp.ge_acc a where a.landing = l.landing and a.signup_at >= v_from and a.signup_at < v_to),
             'trials', (select count(*) from pg_temp.ge_acc a where a.landing = l.landing and a.trial_at >= v_from and a.trial_at < v_to),
             'paid', (select count(*) from pg_temp.ge_acc a where a.landing = l.landing and a.paid_at >= v_from and a.paid_at < v_to),
             'top_source', l.top_source) as x
      from (select first_landing as landing, count(*)::int as n, mode() within group (order by first_source) as top_source
              from public.acquisition_visitors
             where first_seen_at >= v_from and first_seen_at < v_to and first_landing is not null
             group by 1 order by 2 desc limit 25) l) q;

  -- CAMPAIGNS (utm_campaign on the first touch)
  select coalesce(jsonb_agg(x order by (x ->> 'visitors')::int desc), '[]'::jsonb) into campaigns from (
    select jsonb_build_object('campaign', c.campaign, 'source', c.src, 'medium', c.med, 'visitors', c.n,
             'signups', (select count(*) from pg_temp.ge_acc a where a.campaign = c.campaign and a.signup_at >= v_from and a.signup_at < v_to),
             'trials', (select count(*) from pg_temp.ge_acc a where a.campaign = c.campaign and a.trial_at >= v_from and a.trial_at < v_to),
             'paid', (select count(*) from pg_temp.ge_acc a where a.campaign = c.campaign and a.paid_at >= v_from and a.paid_at < v_to),
             'collected_cents', (select coalesce(sum(p.amount_cents), 0) from pg_temp.ge_pay p join pg_temp.ge_acc a on a.user_id = p.user_id
                                  where a.campaign = c.campaign and p.paid_at >= v_from and p.paid_at < v_to)) as x
      from (select first_utm_campaign as campaign, max(first_utm_source) as src, max(first_utm_medium) as med, count(*)::int as n
              from public.acquisition_visitors
             where first_seen_at >= v_from and first_seen_at < v_to and first_utm_campaign is not null
             group by 1 order by 4 desc limit 25) c) q;

  -- PUBLIC PAGES, FREE TOOLS, CALLS TO ACTION (first-party events; one per
  -- session per page, so these are visits, not reloads)
  select coalesce(jsonb_agg(x order by (x ->> 'views')::int desc), '[]'::jsonb) into pages from (
    select jsonb_build_object('page', event_properties ->> 'entity', 'views', count(*)::int,
             'visitors', count(distinct coalesce(anonymous_session_id, user_id::text))::int) as x
      from public.user_events
     where event_name = 'public_page_view' and created_at >= v_from and created_at < v_to
     group by event_properties ->> 'entity' order by count(*) desc limit 30) q;
  -- a tool's key (no_vig) and its page (tool:no-vig-calculator) are paired so
  -- each tool shows uses beside the visits to its page
  select coalesce(jsonb_agg(jsonb_build_object('tool', t.tool, 'uses', t.uses, 'visitors', t.visitors,
           'page_views', (select count(*) from public.user_events v where v.event_name = 'public_page_view'
                           and v.created_at >= v_from and v.created_at < v_to
                           and v.event_properties ->> 'entity' = 'tool:' || replace(t.tool, '_', '-')
                             || case when t.tool in ('no_vig', 'fair_odds') then '-calculator' else '' end)::int)
           order by t.uses desc), '[]'::jsonb) into tools
    from (select e.event_properties ->> 'entity' as tool, count(*)::int as uses,
                 count(distinct coalesce(e.anonymous_session_id, e.user_id::text))::int as visitors
            from public.user_events e
           where e.event_name = 'tool_used' and e.created_at >= v_from and e.created_at < v_to
           group by 1) t;
  select coalesce(jsonb_agg(x order by (x ->> 'clicks')::int desc), '[]'::jsonb) into ctas from (
    select jsonb_build_object('cta', event_properties ->> 'cta', 'clicks', count(*)::int) as x
      from public.user_events
     where event_name = 'public_cta_clicked' and created_at >= v_from and created_at < v_to
     group by event_properties ->> 'cta' order by count(*) desc limit 30) q;

  -- NEWSLETTER
  if to_regclass('public.newsletter_subscribers') is not null then
    execute $nl$
      select jsonb_build_object('installed', true,
        'signups', (select count(*) from public.newsletter_subscribers where created_at >= $1 and created_at < $2),
        'confirmed_in_window', (select count(*) from public.newsletter_subscribers where confirmed_at >= $1 and confirmed_at < $2),
        'confirmed_total', (select count(*) from public.newsletter_subscribers where status = 'confirmed'),
        'by_source', (select coalesce(jsonb_agg(jsonb_build_object('source', s, 'signups', n, 'confirmed', c) order by n desc), '[]'::jsonb)
                        from (select coalesce(consent_source, '(none)') as s, count(*)::int as n,
                                     count(*) filter (where status = 'confirmed')::int as c
                                from public.newsletter_subscribers where created_at >= $1 and created_at < $2 group by 1) z),
        'topics_confirmed', jsonb_build_object(
          'cfb', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_cfb),
          'nfl', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_nfl),
          'findings', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_findings),
          'product_updates', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_product)),
        'unsubscribed_in_window', (select count(*) from public.newsletter_subscribers where unsubscribed_at >= $1 and unsubscribed_at < $2))
    $nl$ into nl using v_from, v_to;
  else
    nl := jsonb_build_object('installed', false);
  end if;
  nl := nl || jsonb_build_object('form_submissions',
    (select count(*) from public.user_events where event_name = 'newsletter_signup' and created_at >= v_from and created_at < v_to));

  -- THE FUNNEL, measured
  select jsonb_build_object(
    'visitors', (select count(*) from public.acquisition_visitors where first_seen_at >= v_from and first_seen_at < v_to),
    'public_page_visitors', (select count(distinct coalesce(anonymous_session_id, user_id::text)) from public.user_events
                              where event_name = 'public_page_view' and created_at >= v_from and created_at < v_to),
    'landing_visitors', (select count(distinct coalesce(anonymous_session_id, user_id::text)) from public.user_events
                          where event_name = 'landing_view' and created_at >= v_from and created_at < v_to),
    'signups', (select count(*) from pg_temp.ge_acc where signup_at >= v_from and signup_at < v_to),
    'trials', (select count(*) from pg_temp.ge_acc where trial_at >= v_from and trial_at < v_to),
    'paid_conversions', (select count(*) from pg_temp.ge_acc where paid_at >= v_from and paid_at < v_to),
    -- trial-to-paid only over trials whose free days are over, so an open trial is never counted as lost
    'matured_trials', (select count(*) from pg_temp.ge_acc where trial_at >= v_from - interval '60 days' and trial_at < v_to
                         and trial_at + make_interval(days => v_trial_days + 1) <= now()),
    'matured_trials_paid', (select count(*) from pg_temp.ge_acc where trial_at >= v_from - interval '60 days' and trial_at < v_to
                         and trial_at + make_interval(days => v_trial_days + 1) <= now() and paid_at is not null),
    'retained', (select count(*) from pg_temp.ge_acc where paid_at >= v_from and paid_at < v_to and paid_invoices >= 2),
    'collected_cents', (select coalesce(sum(amount_cents), 0) from pg_temp.ge_pay where paid_at >= v_from and paid_at < v_to)
  ) into funnel;

  -- REVENUE BY CHANNEL: cash Stripe collected in the window, by the payer's
  -- first touch (measured). It is attribution by first touch, not causation.
  select coalesce(jsonb_agg(jsonb_build_object('source', s, 'collected_cents', c, 'payers', n) order by c desc), '[]'::jsonb) into revenue
    from (select coalesce(a.source, '(untracked)') as s, sum(p.amount_cents)::bigint as c, count(distinct p.user_id)::int as n
            from pg_temp.ge_pay p left join pg_temp.ge_acc a on a.user_id = p.user_id
           where p.paid_at >= v_from and p.paid_at < v_to group by 1) z;

  mrr := public.growth_mrr();

  -- OUTBOUND: approved, real sends in the window, by the landing page each
  -- email carried, and what the engine has matched back to them
  if to_regclass('growth_outbound.sends') is not null and to_regclass('growth_outbound.conversions') is not null then
    execute $ob$
      with s as (
        select se.*, coalesce(substring(d.body_text from 'https://edgedesksports\.com(/[A-Za-z0-9/_.-]*)'), '/') as landing
          from growth_outbound.sends se join growth_outbound.drafts d on d.id = se.draft_id
         where not se.is_test and se.sent_at >= $1 and se.sent_at < $2
      ), c as (
        select cv.stage, cv.prospect_id from growth_outbound.conversions cv where cv.occurred_at >= $1 and cv.occurred_at < $2
      )
      select jsonb_build_object('installed', true,
        'sent', (select count(*) from s), 'delivered', (select count(*) from s where delivered_at is not null),
        'bounced', (select count(*) from s where bounced_at is not null),
        'prospects', (select count(distinct prospect_id) from s),
        'conversions', (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb) from (select stage, count(distinct prospect_id) as n from c group by 1) z),
        'by_landing', (select coalesce(jsonb_agg(jsonb_build_object('landing', l.landing, 'sent', l.n,
              'visited', (select count(distinct c.prospect_id) from c where c.stage = 'visited' and c.prospect_id in (select prospect_id from s where s.landing = l.landing)),
              'signed_up', (select count(distinct c.prospect_id) from c where c.stage = 'signed_up' and c.prospect_id in (select prospect_id from s where s.landing = l.landing)),
              'trial', (select count(distinct c.prospect_id) from c where c.stage = 'trial' and c.prospect_id in (select prospect_id from s where s.landing = l.landing)),
              'paid', (select count(distinct c.prospect_id) from c where c.stage = 'paid' and c.prospect_id in (select prospect_id from s where s.landing = l.landing)))
              order by l.n desc), '[]'::jsonb)
            from (select landing, count(*)::int as n from s group by 1) l))
    $ob$ into outbound using v_from, v_to;
  end if;

  -- SEARCH CONSOLE, when imported
  if exists (select 1 from public.search_console_pages where day >= v_from::date and day < v_to::date) then
    select jsonb_build_object('connected', true,
      'last_import', (select max(ran_at) from public.search_console_runs where ok),
      'clicks', coalesce(sum(clicks), 0), 'impressions', coalesce(sum(impressions), 0),
      'ctr', case when sum(impressions) > 0 then round(sum(clicks)::numeric / sum(impressions), 4) end,
      'avg_position', case when sum(impressions) > 0 then round(sum(position * impressions) / sum(impressions), 2) end,
      'first_day', min(day), 'last_day', max(day),
      'top_pages', (select coalesce(jsonb_agg(jsonb_build_object('page', page, 'clicks', c, 'impressions', i,
                       'position', case when i > 0 then round(pw / i, 1) end) order by c desc, i desc), '[]'::jsonb)
                      from (select page, sum(clicks) as c, sum(impressions) as i, sum(position * impressions) as pw
                              from public.search_console_pages where day >= v_from::date and day < v_to::date
                             group by page order by sum(clicks) desc, sum(impressions) desc limit 20) z),
      'top_queries', (select coalesce(jsonb_agg(jsonb_build_object('query', query, 'clicks', c, 'impressions', i,
                       'position', case when i > 0 then round(pw / i, 1) end) order by c desc, i desc), '[]'::jsonb)
                      from (select query, sum(clicks) as c, sum(impressions) as i, sum(position * impressions) as pw
                              from public.search_console_queries where day >= v_from::date and day < v_to::date
                             group by query order by sum(clicks) desc, sum(impressions) desc limit 20) z))
      into search
      from public.search_console_pages where day >= v_from::date and day < v_to::date;
  else
    search := jsonb_build_object('connected', false,
      'last_import', (select max(ran_at) from public.search_console_runs where ok),
      'note', 'No Search Console data for this window. Configure tools/growth/gsc_import.js (docs/growth-engine/README.md).');
  end if;

  -- THE PARTNER PROGRAM, and what a person should look at
  if to_regclass('public.affiliate_attributions') is not null then
    select jsonb_build_object('installed', true,
      'attributed_accounts', (select count(*) from public.affiliate_attributions where attributed_at >= v_from and attributed_at < v_to and status = 'active'),
      'by_code', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'accounts', n, 'trials', t, 'paid', p) order by n desc), '[]'::jsonb)
                    from (select a.code, count(*)::int as n,
                                 count(*) filter (where acc.trial_at is not null)::int as t,
                                 count(*) filter (where acc.paid_at is not null)::int as p
                            from public.affiliate_attributions a left join pg_temp.ge_acc acc on acc.user_id = a.user_id
                           where a.attributed_at >= v_from and a.attributed_at < v_to and a.status = 'active'
                           group by a.code) z),
      'flags', public.growth_referral_flags(v_from, v_to),
      'note', 'Flags are for review. Nothing here approves, voids or pays a commission.') into refs;
  end if;

  return jsonb_build_object(
    'schema', 'edgedesk_growth_acquisition/1',
    'as_of', now(), 'from', v_from, 'to', v_to,
    'channels', channels, 'landing_pages', landing, 'campaigns', campaigns,
    'public_pages', pages, 'tools', tools, 'ctas', ctas, 'newsletter', nl,
    'funnel', funnel, 'revenue_by_channel', revenue, 'mrr', mrr,
    'outbound', outbound, 'search', search, 'referrals', refs,
    'notes', jsonb_build_array(
      'Every figure is a count or sum of stored rows (measured), except fields named *_estimate.',
      'Channels are the FIRST attributable touch (supabase/growth.sql acq_classify). Revenue by channel is cash collected, credited to the payer''s first touch: attribution, not causation.',
      'Visitors are counted where the first-party tracker runs: the landing page, research articles and hubs, free tools, newsletter, methodology, record and partners pages (since 2026-10).',
      'Trial-to-paid uses only trials whose free days are over.'));
end $$;
revoke all on function public.growth_acquisition_payload(timestamptz, timestamptz) from public, anon, authenticated;

-- ── 7. the doors ─────────────────────────────────────────────────────────────
create or replace function public.growth_admin_acquisition(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d int := greatest(1, least(coalesce(p_days, 30), 730));
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  return public.growth_acquisition_payload(now() - make_interval(days => d), now()) || jsonb_build_object('window_days', d);
end $$;
revoke all on function public.growth_admin_acquisition(int) from public, anon;
grant execute on function public.growth_admin_acquisition(int) to authenticated;

-- THE WEEKLY REPORT: last full week, Monday 00:00 UTC to Monday 00:00 UTC,
-- frozen once. The service role (pg_cron, supabase/growth_engine_cron.sql) or
-- the SQL editor runs it; a re-run for a week already frozen changes nothing
-- unless p_force. Nothing is emailed and nothing is printed to a public log.
create or replace function public.growth_weekly_snapshot(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_start date := (date_trunc('week', now() at time zone 'utc') - interval '7 days')::date; v_end date; v_payload jsonb;
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') in ('anon', 'authenticated') then
    raise exception 'growth_weekly_snapshot is a server-side job' using errcode = '42501';
  end if;
  v_end := v_start + 7;
  if not p_force and exists (select 1 from public.growth_weekly_reports where week_start = v_start) then
    return jsonb_build_object('ok', true, 'week_start', v_start, 'state', 'already_frozen');
  end if;
  v_payload := public.growth_acquisition_payload(v_start::timestamptz, v_end::timestamptz);
  insert into public.growth_weekly_reports (week_start, week_end, payload) values (v_start, v_end, v_payload)
  on conflict (week_start) do update set payload = excluded.payload, built_at = now(), week_end = excluded.week_end;
  return jsonb_build_object('ok', true, 'week_start', v_start, 'state', 'frozen');
end $$;
revoke all on function public.growth_weekly_snapshot(boolean) from public, anon, authenticated;
grant execute on function public.growth_weekly_snapshot(boolean) to service_role;

create or replace function public.growth_admin_weekly_reports(p_limit int default 12)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('week_start', week_start, 'week_end', week_end, 'built_at', built_at,
                     'funnel', payload -> 'funnel', 'mrr', payload -> 'mrr', 'channels', payload -> 'channels',
                     'newsletter', payload -> 'newsletter', 'search', (payload -> 'search') - 'top_queries' - 'top_pages')
                     order by week_start desc)
                     from (select * from public.growth_weekly_reports order by week_start desc limit greatest(1, least(coalesce(p_limit, 12), 104))) w),
                  '[]'::jsonb);
end $$;
revoke all on function public.growth_admin_weekly_reports(int) from public, anon;
grant execute on function public.growth_admin_weekly_reports(int) to authenticated;

notify pgrst, 'reload schema';

-- ── report ───────────────────────────────────────────────────────────────────
select 1 as row, 'the Search Console tables exist and no client role can read them' as check,
  case when to_regclass('public.search_console_pages') is not null
        and not has_table_privilege('anon', 'public.search_console_pages', 'select')
        and not has_table_privilege('authenticated', 'public.search_console_queries', 'select')
       then 'ok' else 'CHECK THIS' end as result
union all select 2, 'the acquisition report is for operators: no anon grant',
  case when not has_function_privilege('anon', 'public.growth_admin_acquisition(integer)', 'execute')
       then 'ok' else 'CHECK THIS' end
union all select 3, 'the internal report builder has no client grant',
  case when not has_function_privilege('anon', 'public.growth_acquisition_payload(timestamp with time zone,timestamp with time zone)', 'execute')
        and not has_function_privilege('authenticated', 'public.growth_acquisition_payload(timestamp with time zone,timestamp with time zone)', 'execute')
       then 'ok' else 'CHECK THIS' end
union all select 4, 'revenue helpers have no client grant',
  case when not has_function_privilege('authenticated', 'public.growth_mrr()', 'execute')
        and not has_function_privilege('authenticated', 'public.growth_invoice_payments()', 'execute')
       then 'ok' else 'CHECK THIS' end
union all select 5, 'the weekly snapshot is a server-side job',
  case when not has_function_privilege('authenticated', 'public.growth_weekly_snapshot(boolean)', 'execute')
        and has_function_privilege('service_role', 'public.growth_weekly_snapshot(boolean)', 'execute')
       then 'ok' else 'CHECK THIS' end
union all select 6, 'the new sources are allowed on acquisition rows',
  case when exists (select 1 from pg_constraint where conname = 'acquisition_visitors_sources'
                     and pg_get_constraintdef(oid) like '%outbound_email%')
       then 'ok' else 'CHECK THIS — re-run supabase/growth.sql (2026-10) first' end
union all select 7, 'the public-page events are registered',
  case when (select count(*) from public.user_event_kinds where event_name in ('public_page_view', 'tool_used', 'public_cta_clicked', 'newsletter_signup')) = 4
       then 'ok' else 'CHECK THIS — re-run supabase/funnel.sql (2026-10) first' end
order by 1;
