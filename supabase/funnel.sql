-- =============================================================================
-- funnel — where people stop using EdgeDesk.
--
-- visitor → understands EdgeDesk → sees value → starts a trial → opens the
-- terminal → finds useful research → comes back → pays. Every step is a row
-- here, so the admin can see exactly which step each cohort stops at.
--
-- WHAT IT IS
--   user_event_kinds    the registry: every event name the funnel knows, who
--                       may send it (a page, or only the database), how it is
--                       deduplicated, and its place in the funnel. An unknown
--                       name is refused, so a typo cannot invent a step.
--   user_events         one row per funnel event:
--                         id, user_id, anonymous_session_id, session_id,
--                         event_name, event_properties, created_at, page_path,
--                         referrer, utm_source, utm_medium, utm_campaign,
--                         dedupe_key
--                       NO client role can read it. anonymous_session_id is
--                       the same one-way hash of the page's random visitor id
--                       that acquisition_visitors keys on (growth.sql), so a
--                       visitor's source and their events join; the raw id
--                       never leaves the browser. referrer is a host name,
--                       page_path has no query string, and event_properties
--                       keeps only short scalar values (nothing that looks
--                       like an email address, a token or a name).
--   user_event_links    which (hashed) visitors became which accounts — the
--                       first time a signed-in page sends an event with the
--                       visitor id it already had. Landing events stitch to
--                       the account through it.
--   ed_track()          THE door for the pages. Anonymous or signed in, a
--                       batch of up to 25 events per call, deduplicated HERE
--                       by the registry's rule (a re-render, a double click
--                       or a second tab cannot double count), rate limited,
--                       and it never raises. user_id is auth.uid() — never a
--                       parameter, so nobody can write an event as somebody
--                       else.
--   server events       account_created (a trigger on auth.users),
--                       trial_started / subscription_started /
--                       subscription_cancelled (triggers on subscriptions
--                       and on the Stripe ledger), and the derived
--                       second_session and return_day_1 / _3 / _7. A page can
--                       send none of them. A trigger here can NEVER fail the
--                       signup, the webhook or the write it rides on: any
--                       error becomes a warning.
--   first run           user_preferences gains research_focus (game lines /
--                       player props / both), favorite_teams, trial_emails
--                       and the first-run stamps. ed_first_run_state()
--                       returns the five onboarding steps as the reader's OWN
--                       events say they happened — nothing is ticked by hand.
--   funnel_admin_report()  the admin's funnel, day-1/3/7 retention,
--                       trial-to-paid, cancellation, the last step each trial
--                       reached, and cohorts by signup week, traffic source,
--                       sport, stated research focus and what readers
--                       actually opened (game lines, player props, both).
--
-- DEFINITIONS (stated once; the admin page prints them)
--   visitor          a distinct hashed visitor with a landing_view
--   return_day_N     a signed-in terminal event N or more days after the
--                    account was created ("rolling" retention: came back on
--                    or after day N). Emitted once per reader per N.
--   second_session   a terminal_opened in a different browser session from
--                    an earlier one.
--   trial            what Stripe's own records say (growth_customer_facts:
--                    a subscription event that was trialing, or a trialing
--                    row), plus trial_started events from this file. Comps
--                    (owner_comp, comp_trial) are not funnel trials.
--   paid             a real charge: a paid invoice with amount_paid > 0 (a $0
--                    trial invoice is not), or trialing → active.
--   cancelled        cancel_at_period_end switched on, or the subscription
--                    ended. During-trial cancels are flagged.
--
-- WHAT IT IS NOT
--   * It changes no research number and no entitlement.
--   * It never touches the affiliate ledger, activation_events or
--     acquisition attribution (growth.sql); it reads them.
--
-- RUN ORDER. billing.sql, stripe_webhook.sql, referral_codes.sql,
-- personal_research.sql, affiliates.sql, growth.sql, then this file. The
-- guard says so.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null or to_regclass('public.stripe_events') is null then
    raise exception 'Run supabase/billing.sql and supabase/stripe_webhook.sql first.';
  end if;
  if to_regclass('public.user_preferences') is null or to_regclass('public.game_research_state') is null then
    raise exception 'Run supabase/personal_research.sql first (preferences and the research state live there).';
  end if;
  if to_regprocedure('public.affiliate_stripe_object(jsonb)') is null then
    raise exception 'Run supabase/affiliates.sql first (the Stripe payload helpers and the operator list live there).';
  end if;
  if to_regclass('public.acquisition_visitors') is null or to_regprocedure('public.growth_customer_facts()') is null then
    raise exception 'Run supabase/growth.sql first (acquisition sources and customer facts live there).';
  end if;
end
$guard$;

-- ── re-running this file on a live site ─────────────────────────────────────
-- The same rule growth.sql follows: every lock taken first, all at once or not
-- at all (NOWAIT, retried for 30 seconds). This file adds triggers to
-- subscriptions and the Stripe ledger, which the webhook may be writing.
do $locks$
declare
  v_list text;
  v_try int := 0;
begin
  select string_agg(t, ', ') into v_list from unnest(array[
    'public.subscriptions',
    'public.stripe_events',
    'public.user_preferences',
    'public.user_event_kinds',
    'public.user_events',
    'public.user_event_links']) t
  where to_regclass(t) is not null;
  if v_list is null then return; end if;
  loop
    begin
      execute 'lock table ' || v_list || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 150 then
        raise exception 'could not lock % within 30 seconds; something kept one of them busy. Nothing was changed: run this file again in a minute.', v_list;
      end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end
$locks$;

-- ── 1. the registry ─────────────────────────────────────────────────────────
-- dedupe: how many times an event counts for one actor (a signed-in reader, or
-- else a hashed visitor):
--   session         once per browser session
--   session_entity  once per session per entity (props.entity or props.cta)
--   entity_day      once per entity per UTC day (a game, a prop, a market)
--   day             once per UTC day
--   entity          once per entity, ever (a subscription id)
--   once            once, ever
-- source: 'client' may arrive through ed_track(); 'server' only from this file.
create table if not exists public.user_event_kinds (
  event_name   text primary key check (event_name ~ '^[a-z][a-z0-9_]{2,40}$'),
  source       text not null check (source in ('client', 'server')),
  dedupe       text not null check (dedupe in ('session', 'session_entity', 'entity_day', 'day', 'entity', 'once')),
  stage        int  not null,
  signed_in    boolean not null default false,   -- only counts with a signed-in reader
  description  text not null
);
insert into public.user_event_kinds (event_name, source, dedupe, stage, signed_in, description) values
  -- THE PUBLIC SITE BEFORE THE LANDING PAGE (2026-10, the growth engine):
  -- research articles, the free tools, the newsletter page. A Google visitor
  -- usually meets EdgeDesk on one of these, not on the landing page.
  -- props.entity names the page (kind:slug) or the tool or the CTA.
  ('public_page_view',        'client', 'session_entity',  5, false, 'A public page outside the landing page was opened (props.entity = kind:slug).'),
  ('tool_used',               'client', 'session_entity',  6, false, 'A free tool produced a result (props.entity = tool key).'),
  ('public_cta_clicked',      'client', 'session_entity',  7, false, 'A call to action on a public page was pressed (props.cta names which).'),
  -- EdgeDesk's own articles (2026-10, first-party features): the reader
  -- stayed. Reported by supabase/first_party_funnel.sql.
  ('article_engaged',         'client', 'session_entity',  6, false, 'A reader stayed with an EdgeDesk article: 30 seconds visible and half of it read (props.entity = article:slug). Never sent under Global Privacy Control or Do Not Track.'),
  ('newsletter_signup',       'client', 'session',         8, false, 'The public newsletter form was accepted (a confirmation email was requested).'),
  ('landing_view',            'client', 'session',        10, false, 'The landing page was opened.'),
  ('landing_live_board_view', 'client', 'session',        11, false, 'The live board on the landing page scrolled into view with live data.'),
  ('pricing_view',            'client', 'session',        12, false, 'The pricing section scrolled into view.'),
  ('cta_clicked',             'client', 'session_entity', 13, false, 'A landing call to action was pressed (props.cta names which).'),
  ('signup_started',          'client', 'session',        20, false, 'The sign-up form was opened or submitted.'),
  ('account_created',         'server', 'once',           21, true,  'An account exists (auth.users insert).'),
  ('checkout_started',        'client', 'session',        22, true,  'Renewal terms accepted; the reader was sent to Stripe checkout.'),
  ('trial_started',           'server', 'entity',         23, true,  'Stripe says the subscription is trialing.'),
  ('terminal_opened',         'client', 'session',        30, true,  'The terminal loaded for an entitled reader.'),
  ('first_run_viewed',        'client', 'once',           31, true,  'The first-run "what EdgeDesk found today" screen was shown.'),
  ('preferences_saved',       'client', 'day',            31, true,  'First-run or settings preferences were saved.'),
  ('onboarding_skipped',      'client', 'once',           31, true,  'The reader skipped the optional preferences.'),
  ('board_viewed',            'client', 'session',        32, true,  'A research board (game or card) was viewed.'),
  ('game_opened',             'client', 'entity_day',     33, true,  'A game research card was opened (props.entity = league|game id).'),
  ('prop_board_opened',       'client', 'session',        34, true,  'The Player Props board was opened.'),
  ('prop_opened',             'client', 'entity_day',     35, true,  'A player prop research card was opened (props.entity = prop id).'),
  ('ev_viewed',               'client', 'entity_day',     36, true,  'An EdgeDesk EV / price check was viewed.'),
  ('custom_price_checked',    'client', 'entity_day',     37, true,  'The reader priced a line and odds of their own.'),
  ('research_saved',          'client', 'entity_day',     38, true,  'Research was saved or watched (watchlist, Card, prop watchlist).'),
  ('brief_copied',            'client', 'entity_day',     39, true,  'A research brief or card was copied or shared.'),
  -- navigation evidence: which of the five destinations readers open, and where
  -- they go from inside one (props.entity, e.g. 'more:collective',
  -- 'research:props', 'portfolio:calendar', 'process:timing', 'ai:game').
  -- One row per session per seat / per entity; the raw taps go to gtag.
  ('primary_nav_research',    'client', 'session',        60, true,  'The Research seat in the primary navigation was tapped.'),
  ('primary_nav_card',        'client', 'session',        60, true,  'The Card seat in the primary navigation was tapped.'),
  ('primary_nav_portfolio',   'client', 'session',        60, true,  'The Portfolio seat in the primary navigation was tapped.'),
  ('primary_nav_process',     'client', 'session',        60, true,  'The Process seat in the primary navigation was tapped.'),
  ('primary_nav_more',        'client', 'session',        60, true,  'The More seat in the primary navigation was tapped.'),
  ('secondary_nav_opened',    'client', 'session_entity', 61, true,  'A destination inside a primary one was opened (props.entity names it).'),
  -- Portfolio time to value (lib/edgedesk_portfolio_ui.js): from the first
  -- look at setting up a portfolio to a portfolio with real history in it.
  -- props.entity is a platform key, or an import id — never a figure.
  ('portfolio_onboarding_started', 'client', 'once',      70, true,  'The Portfolio setup checklist was first shown.'),
  ('platform_selected',       'client', 'session_entity', 71, true,  'A platform was chosen during Portfolio setup (props.entity = platform key).'),
  ('connection_started',      'client', 'session_entity', 72, true,  'An automatic connection was submitted (props.entity = platform key).'),
  ('connection_completed',    'client', 'entity',         73, true,  'An automatic connection was validated and stored (props.entity = platform key).'),
  ('import_started',          'client', 'session_entity', 74, true,  'A file was dropped on Import (props.entity = platform key or detect).'),
  ('import_detected',         'client', 'session_entity', 75, true,  'The import named the file''s platform (props.entity = how: chosen, column, file_name, remembered).'),
  ('import_reviewed',         'client', 'entity',         76, true,  'The server counted the file against the portfolio (props.entity = import id).'),
  ('import_completed',        'client', 'entity',         77, true,  'An import committed (props.entity = import id).'),
  ('first_position_created',  'client', 'once',           78, true,  'The reader''s portfolio holds its first position.'),
  ('portfolio_ready',         'client', 'once',           79, true,  'Setup reached a portfolio with history in it.'),
  ('first_process_insight_ready', 'client', 'once',       80, true,  'The first Decision Grade or supported process finding was shown.'),
  ('second_session',          'server', 'once',           40, true,  'A terminal session in a different browser session from an earlier one.'),
  ('return_day_1',            'server', 'once',           41, true,  'Back in the terminal 1+ days after the account was created.'),
  ('return_day_3',            'server', 'once',           42, true,  'Back in the terminal 3+ days after the account was created.'),
  ('return_day_7',            'server', 'once',           43, true,  'Back in the terminal 7+ days after the account was created.'),
  ('subscription_started',    'server', 'entity',         50, true,  'A real charge: the first paid invoice, or trialing became active.'),
  ('subscription_cancelled',  'server', 'entity',         51, true,  'The subscription was set to cancel, or ended.')
on conflict (event_name) do update
  set source = excluded.source, dedupe = excluded.dedupe, stage = excluded.stage,
      signed_in = excluded.signed_in, description = excluded.description;
alter table public.user_event_kinds enable row level security;
revoke all on public.user_event_kinds from anon, authenticated;

-- ── 2. the events ────────────────────────────────────────────────────────────
create table if not exists public.user_events (
  id                    bigint generated always as identity primary key,
  user_id               uuid references auth.users(id) on delete cascade,
  anonymous_session_id  text,
  session_id            text,
  event_name            text not null references public.user_event_kinds(event_name),
  event_properties      jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  page_path             text,
  referrer              text,
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  dedupe_key            text
);
alter table public.user_events add column if not exists session_id text;
alter table public.user_events add column if not exists dedupe_key text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_events_shape') then
    alter table public.user_events add constraint user_events_shape check (
          (anonymous_session_id is null or anonymous_session_id ~ '^[0-9a-f]{32}$')
      and (session_id is null or session_id ~ '^[A-Za-z0-9_-]{8,64}$')
      and (page_path is null or (length(page_path) <= 160 and page_path like '/%'))
      and (referrer is null or referrer ~ '^[a-z0-9.-]{1,120}$')
      and (utm_source is null or utm_source ~ '^[a-z0-9_.-]{1,64}$')
      and (utm_medium is null or utm_medium ~ '^[a-z0-9_.-]{1,64}$')
      and (utm_campaign is null or utm_campaign ~ '^[a-z0-9_.-]{1,64}$')
      and jsonb_typeof(event_properties) = 'object'
      and length(event_properties::text) <= 2048
      and (user_id is not null or anonymous_session_id is not null));
  end if;
end $c$;
create unique index if not exists user_events_dedupe on public.user_events (dedupe_key) where dedupe_key is not null;
create index if not exists user_events_user_time on public.user_events (user_id, created_at) where user_id is not null;
create index if not exists user_events_anon_time on public.user_events (anonymous_session_id, created_at) where anonymous_session_id is not null;
create index if not exists user_events_name_time on public.user_events (event_name, created_at);
alter table public.user_events enable row level security;
revoke all on public.user_events from anon, authenticated;

create table if not exists public.user_event_links (
  anonymous_session_id text not null check (anonymous_session_id ~ '^[0-9a-f]{32}$'),
  user_id              uuid not null references auth.users(id) on delete cascade,
  linked_at            timestamptz not null default now(),
  primary key (anonymous_session_id, user_id)
);
create index if not exists user_event_links_user on public.user_event_links (user_id);
alter table public.user_event_links enable row level security;
revoke all on public.user_event_links from anon, authenticated;

-- the anonymous traffic door is capped per hour, so rotating visitor ids
-- cannot fill the table
create table if not exists public.user_event_buckets (
  bucket  timestamptz primary key,
  n       int not null default 0
);
alter table public.user_event_buckets enable row level security;
revoke all on public.user_event_buckets from anon, authenticated;

-- ── 3. the cleaners: what may be stored at all ──────────────────────────────
-- the same one-way hash growth.sql stores for a visitor (acquisition_visitors)
create or replace function public.ed_visitor_hash(p text)
returns text language sql immutable as $$
  select case when p ~ '^[A-Za-z0-9_-]{16,64}$' then md5('edgedesk-acq:' || p) end;
$$;
create or replace function public.ed_clean_token(p text, p_max int default 64)
returns text language sql immutable as $$
  select nullif(left(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9_.-]', '', 'g'), p_max), '');
$$;
-- a host name only, whether a URL or a bare host arrived
create or replace function public.ed_clean_host(p text)
returns text language sql immutable as $$
  select nullif(left(regexp_replace(
           lower(split_part(split_part(regexp_replace(coalesce(p, ''), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '/', 1), ':', 1)),
           '[^a-z0-9.-]', '', 'g'), 120), '');
$$;
-- a path only: no query string, no fragment
create or replace function public.ed_clean_path(p text)
returns text language sql immutable as $$
  select case when left(coalesce(p, ''), 1) = '/'
              then left(regexp_replace(split_part(split_part(p, '?', 1), '#', 1), '[^A-Za-z0-9/_.~-]', '', 'g'), 160) end;
$$;
-- short scalar values only; nothing that looks like contact details or a secret
create or replace function public.ed_clean_props(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select key as k,
           case jsonb_typeof(value)
             when 'string' then to_jsonb(left(value #>> '{}', 120))
             when 'number' then value
             when 'boolean' then value end as v
      from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end)
     where key ~ '^[a-z][a-z0-9_]{0,31}$'
       and key not in ('email', 'password', 'token', 'access_token', 'refresh_token', 'name', 'full_name', 'phone', 'address', 'card')
       and jsonb_typeof(value) in ('string', 'number', 'boolean')
       and not (jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '@|eyJ[A-Za-z0-9_-]{10,}')
     order by key
     limit 16) q
  where v is not null;
$$;
-- an entity key: a game (nfl|2026_04_PIT_CLE), a prop id, a market, a cta name
create or replace function public.ed_clean_entity(p text)
returns text language sql immutable as $$
  select nullif(left(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9_|.:-]', '', 'g'), 120), '');
$$;
revoke all on function public.ed_visitor_hash(text) from public, anon, authenticated;
revoke all on function public.ed_clean_token(text, int) from public, anon, authenticated;
revoke all on function public.ed_clean_host(text) from public, anon, authenticated;
revoke all on function public.ed_clean_path(text) from public, anon, authenticated;
revoke all on function public.ed_clean_props(jsonb) from public, anon, authenticated;
revoke all on function public.ed_clean_entity(text) from public, anon, authenticated;

-- ── 4. one event, deduplicated; never raises ────────────────────────────────
create or replace function public.ed_event_record(
  p_user uuid, p_anon text, p_session text, p_event text, p_props jsonb,
  p_page text default null, p_referrer text default null,
  p_utm_source text default null, p_utm_medium text default null, p_utm_campaign text default null,
  p_at timestamptz default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k public.user_event_kinds%rowtype;
  v_actor text; v_entity text; v_day text; v_key text; v_props jsonb; n int;
  v_session text := case when p_session ~ '^[A-Za-z0-9_-]{8,64}$' then p_session end;
  v_anon text := case when p_anon ~ '^[0-9a-f]{32}$' then p_anon end;
begin
  select * into k from public.user_event_kinds where event_name = p_event;
  if not found then return false; end if;
  if k.signed_in and p_user is null then return false; end if;
  v_actor := case when p_user is not null then 'u:' || p_user::text when v_anon is not null then 'a:' || v_anon end;
  if v_actor is null then return false; end if;
  v_props := public.ed_clean_props(p_props);
  v_entity := public.ed_clean_entity(coalesce(p_props ->> 'entity', p_props ->> 'cta'));
  v_day := to_char((coalesce(p_at, now()) at time zone 'utc')::date, 'YYYY-MM-DD');
  v_key := p_event || '|' || v_actor || '|' || case k.dedupe
      when 'session'        then coalesce('s:' || v_session, 'd:' || v_day)
      when 'session_entity' then coalesce('s:' || v_session, 'd:' || v_day) || '|' || coalesce(v_entity, '-')
      when 'entity_day'     then coalesce(v_entity, '-') || '|' || v_day
      when 'day'            then v_day
      when 'entity'         then coalesce(v_entity, '-')
      else 'once' end;
  begin
    insert into public.user_events (user_id, anonymous_session_id, session_id, event_name, event_properties, created_at,
                                    page_path, referrer, utm_source, utm_medium, utm_campaign, dedupe_key)
    values (p_user, v_anon, v_session, p_event, v_props, coalesce(p_at, now()),
            public.ed_clean_path(p_page), public.ed_clean_host(p_referrer),
            public.ed_clean_token(p_utm_source), public.ed_clean_token(p_utm_medium), public.ed_clean_token(p_utm_campaign),
            left(v_key, 300))
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
    get diagnostics n = row_count;
    return n > 0;
  exception when others then
    raise warning 'ed_event_record: % (%)', sqlerrm, p_event;
    return false;
  end;
end $$;
revoke all on function public.ed_event_record(uuid, text, text, text, jsonb, text, text, text, text, text, timestamptz) from public, anon, authenticated;

-- ── 5. what a signed-in terminal event means about coming back ─────────────
-- second_session: a terminal_opened in a different browser session than an
-- earlier one. return_day_N: terminal activity N+ days after the account was
-- created (rolling). Each once per reader.
create or replace function public.ed_derive_return(p_user uuid, p_session text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_created timestamptz; v_days int; d int;
begin
  if p_user is null then return; end if;
  if p_session is not null and exists (
       select 1 from public.user_events
        where user_id = p_user and event_name = 'terminal_opened'
          and session_id is not null and session_id <> p_session) then
    perform public.ed_event_record(p_user, null, p_session, 'second_session', '{}'::jsonb);
  end if;
  select created_at into v_created from auth.users where id = p_user;
  if v_created is null then return; end if;
  v_days := floor(extract(epoch from (now() - v_created)) / 86400)::int;
  foreach d in array array[1, 3, 7] loop
    if v_days >= d then
      perform public.ed_event_record(p_user, null, p_session, 'return_day_' || d, jsonb_build_object('days_since_signup', v_days));
    end if;
  end loop;
exception when others then
  raise warning 'ed_derive_return: %', sqlerrm;
end $$;
revoke all on function public.ed_derive_return(uuid, text) from public, anon, authenticated;

-- ── 6. THE door for the pages ────────────────────────────────────────────────
-- p_events: [{event, props, page_path, referrer, utm_source, utm_medium,
-- utm_campaign}], at most 25. p_visitor is the page's random visitor id (only
-- its hash is stored); p_session the tab's random session id. Returns counts
-- only — never another reader's anything.
create or replace function public.ed_track(p_events jsonb, p_visitor text default null, p_session text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_anon text := public.ed_visitor_hash(p_visitor);
  v_session text := case when p_session ~ '^[A-Za-z0-9_-]{8,64}$' then p_session end;
  v_n int := 0; v_rec int := 0; v_recent int; v_bucket timestamptz := date_trunc('hour', now()); v_total int;
  v_terminal boolean := false; e jsonb; k public.user_event_kinds%rowtype;
begin
  if jsonb_typeof(p_events) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'not_a_list'); end if;
  if v_uid is null and v_anon is null then return jsonb_build_object('ok', false, 'reason', 'no_actor'); end if;
  v_n := least(jsonb_array_length(p_events), 25);
  if v_n = 0 then return jsonb_build_object('ok', true, 'recorded', 0); end if;

  -- one reader or visitor: at most 600 events an hour
  select count(*) into v_recent from public.user_events
   where created_at > now() - interval '1 hour'
     and ((v_uid is not null and user_id = v_uid) or (v_uid is null and anonymous_session_id = v_anon));
  if v_recent >= 600 then return jsonb_build_object('ok', true, 'capped', true, 'recorded', 0); end if;
  -- signed-out traffic as a whole: at most 60,000 events an hour
  if v_uid is null then
    insert into public.user_event_buckets as b (bucket, n) values (v_bucket, v_n)
    on conflict (bucket) do update set n = b.n + excluded.n
    returning n into v_total;
    if v_total > 60000 then return jsonb_build_object('ok', true, 'capped', true, 'recorded', 0); end if;
  end if;

  -- the visitor this signed-in page already was
  if v_uid is not null and v_anon is not null then
    insert into public.user_event_links (anonymous_session_id, user_id) values (v_anon, v_uid) on conflict do nothing;
  end if;

  for e in select value from jsonb_array_elements(p_events) with ordinality as x(value, i) where i <= 25 loop
    select * into k from public.user_event_kinds where event_name = e ->> 'event';
    continue when not found or k.source <> 'client';
    if public.ed_event_record(v_uid, v_anon, v_session, k.event_name,
         case when jsonb_typeof(e -> 'props') = 'object' then e -> 'props' else '{}'::jsonb end,
         e ->> 'page_path', e ->> 'referrer', e ->> 'utm_source', e ->> 'utm_medium', e ->> 'utm_campaign') then
      v_rec := v_rec + 1;
    end if;
    if v_uid is not null and k.stage >= 30 then v_terminal := true; end if;
  end loop;

  if v_terminal then perform public.ed_derive_return(v_uid, v_session); end if;
  return jsonb_build_object('ok', true, 'recorded', v_rec);
exception when others then
  raise warning 'ed_track: %', sqlerrm;
  return jsonb_build_object('ok', false, 'reason', 'error');
end $$;
revoke all on function public.ed_track(jsonb, text, text) from public;
grant execute on function public.ed_track(jsonb, text, text) to anon, authenticated;

-- ── 7. server events ─────────────────────────────────────────────────────────
-- ACCOUNT CREATED. On auth.users itself, so every signup path counts (email
-- confirmation on or off, any page). It can never fail a signup.
create or replace function public.ed_on_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.ed_event_record(new.id, null, null, 'account_created', '{}'::jsonb, null, null, null, null, null, coalesce(new.created_at, now()));
  exception when others then
    raise warning 'ed_on_auth_user: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.ed_on_auth_user() from public, anon, authenticated;
drop trigger if exists ed_on_auth_user_trg on auth.users;
create trigger ed_on_auth_user_trg after insert on auth.users
  for each row execute function public.ed_on_auth_user();

-- TRIAL, PAID, CANCELLED from the subscription row the webhook keeps.
-- Comps (owner_comp, comp_trial) are granted by hand and are not funnel events.
create or replace function public.ed_on_subscription()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sub text; v_old_status text; v_old_cancel boolean;
begin
  begin
    if coalesce(new.price_id, '') in ('owner_comp', 'comp_trial') or new.user_id is null then return null; end if;
    v_sub := coalesce(new.stripe_subscription_id, '-');
    v_old_status := case when tg_op = 'UPDATE' then old.status end;
    v_old_cancel := case when tg_op = 'UPDATE' then coalesce(old.cancel_at_period_end, false) else false end;
    if new.status = 'trialing' and v_old_status is distinct from 'trialing' then
      perform public.ed_event_record(new.user_id, null, null, 'trial_started', jsonb_build_object('entity', v_sub));
    end if;
    if new.status = 'active' and v_old_status = 'trialing' then
      perform public.ed_event_record(new.user_id, null, null, 'subscription_started', jsonb_build_object('entity', v_sub, 'from', 'trial'));
    end if;
    if (coalesce(new.cancel_at_period_end, false) and not v_old_cancel)
       or (new.status = 'canceled' and v_old_status is distinct from 'canceled') then
      perform public.ed_event_record(new.user_id, null, null, 'subscription_cancelled', jsonb_build_object(
        'entity', v_sub,
        'during_trial', coalesce(v_old_status, new.status) = 'trialing' or new.status = 'trialing',
        'immediate', new.status = 'canceled'));
    end if;
  exception when others then
    raise warning 'ed_on_subscription: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.ed_on_subscription() from public, anon, authenticated;
drop trigger if exists ed_on_subscription_trg on public.subscriptions;
create trigger ed_on_subscription_trg after insert or update on public.subscriptions
  for each row execute function public.ed_on_subscription();

-- PAID from the Stripe ledger: the first invoice that actually charged money.
-- Fires on the insert and on the webhook's later patch of user_id (the same
-- trigger shape affiliates.sql uses), deduplicated per subscription.
create or replace function public.ed_on_stripe_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o jsonb; v_uid uuid; v_sub text; v_amt bigint;
begin
  begin
    if new.type not in ('invoice.payment_succeeded', 'invoice.paid') then return null; end if;
    o := public.affiliate_stripe_object(new.payload);
    if not ((o ->> 'amount_paid') ~ '^[0-9]+$') then return null; end if;
    v_amt := (o ->> 'amount_paid')::bigint;
    if v_amt <= 0 then return null; end if;
    v_sub := coalesce(new.subscription_id, public.affiliate_stripe_id(o -> 'subscription'),
                      public.affiliate_stripe_id(o -> 'parent' -> 'subscription_details' -> 'subscription'));
    v_uid := coalesce(new.user_id,
      (select s.user_id from public.subscriptions s where v_sub is not null and s.stripe_subscription_id = v_sub limit 1),
      (select s.user_id from public.subscriptions s
        where s.stripe_customer_id = coalesce(new.customer_id, public.affiliate_stripe_id(o -> 'customer')) limit 1));
    if v_uid is null then return null; end if;
    perform public.ed_event_record(v_uid, null, null, 'subscription_started',
      jsonb_build_object('entity', coalesce(v_sub, '-'), 'amount_cents', v_amt, 'from', 'invoice'),
      null, null, null, null, null, coalesce(new.stripe_created, new.created_at, now()));
  exception when others then
    raise warning 'ed_on_stripe_event: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.ed_on_stripe_event() from public, anon, authenticated;
drop trigger if exists ed_on_stripe_event_trg on public.stripe_events;
create trigger ed_on_stripe_event_trg after insert or update of user_id, resolved, payload on public.stripe_events
  for each row execute function public.ed_on_stripe_event();

-- ── 8. what already happened before this file existed ───────────────────────
-- Idempotent through the same dedupe keys the triggers use. Client-only
-- events (landing views, games opened…) were never stored and are not
-- invented here; the funnel starts at deploy for those and says so.
do $backfill$
declare r record;
begin
  for r in select id, created_at from auth.users loop
    perform public.ed_event_record(r.id, null, null, 'account_created', '{}'::jsonb, null, null, null, null, null, r.created_at);
  end loop;
  for r in select g.user_id, g.trial_started_at, g.paid_at, s.stripe_subscription_id, s.status, s.cancel_at_period_end, s.updated_at, s.price_id
             from public.growth_customer_facts() g
             left join public.subscriptions s on s.user_id = g.user_id
            where coalesce(g.price_id, '') not in ('owner_comp', 'comp_trial') loop
    if r.trial_started_at is not null then
      perform public.ed_event_record(r.user_id, null, null, 'trial_started', jsonb_build_object('entity', coalesce(r.stripe_subscription_id, '-')),
        null, null, null, null, null, r.trial_started_at);
    end if;
    if r.paid_at is not null then
      perform public.ed_event_record(r.user_id, null, null, 'subscription_started',
        jsonb_build_object('entity', coalesce(r.stripe_subscription_id, '-'), 'from', 'backfill'), null, null, null, null, null, r.paid_at);
    end if;
    if coalesce(r.cancel_at_period_end, false) or r.status = 'canceled' then
      perform public.ed_event_record(r.user_id, null, null, 'subscription_cancelled',
        jsonb_build_object('entity', coalesce(r.stripe_subscription_id, '-'), 'immediate', r.status = 'canceled', 'from', 'backfill'),
        null, null, null, null, null, coalesce(r.updated_at, now()));
    end if;
  end loop;
end
$backfill$;

-- ── 9. first run: the reader's preferences and their own progress ───────────
alter table public.user_preferences add column if not exists research_focus    text;
alter table public.user_preferences add column if not exists favorite_teams    text[] not null default '{}';
alter table public.user_preferences add column if not exists trial_emails      boolean not null default true;
alter table public.user_preferences add column if not exists first_run_seen_at timestamptz;
alter table public.user_preferences add column if not exists first_run_done_at timestamptz;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_research_focus') then
    alter table public.user_preferences add constraint user_prefs_research_focus
      check (research_focus is null or research_focus in ('game_lines', 'player_props', 'both'));
  end if;
  -- '<league>:<team key>', e.g. nfl:buf, cfb:texastech — at most 12
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_favorite_teams_shape') then
    alter table public.user_preferences add constraint user_prefs_favorite_teams_shape
      check (public.edp_text_array_ok(favorite_teams, '^(nfl|cfb):[a-z0-9_.-]{2,40}$', 12));
  end if;
end $c$;
create or replace function public.ed_prefs_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.favorite_teams := array(select distinct lower(x) from unnest(coalesce(new.favorite_teams, '{}')) x order by 1);
  return new;
end $$;
drop trigger if exists ed_prefs_guard_trg on public.user_preferences;
create trigger ed_prefs_guard_trg before insert or update on public.user_preferences
  for each row execute function public.ed_prefs_guard();

-- The five first-run steps, as the reader's own events say they happened:
--   1 view today's board     board_viewed or first_run_viewed
--   2 open a game            game_opened
--   3 open a player prop     prop_opened
--   4 compare a price        ev_viewed or custom_price_checked
--   5 save / watch research  research_saved, or a watchlist row
-- plus when the reader was last here before this session (for "new since
-- your last visit"). Nothing about anybody else.
create or replace function public.ed_first_run_state(p_session text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); p public.user_preferences%rowtype; v_prev timestamptz; v_steps jsonb; v_created timestamptz;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select * into p from public.user_preferences where user_id = v_uid;
  select created_at into v_created from auth.users where id = v_uid;
  select max(created_at) into v_prev from public.user_events
   where user_id = v_uid and event_name = 'terminal_opened'
     and (p_session is null or session_id is distinct from p_session);
  with e as (select distinct event_name from public.user_events where user_id = v_uid and event_name in
               ('board_viewed', 'first_run_viewed', 'game_opened', 'prop_opened', 'ev_viewed', 'custom_price_checked', 'research_saved'))
  select jsonb_build_object(
    'board', exists (select 1 from e where event_name in ('board_viewed', 'first_run_viewed')),
    'game', exists (select 1 from e where event_name = 'game_opened'),
    'prop', exists (select 1 from e where event_name = 'prop_opened'),
    'price', exists (select 1 from e where event_name in ('ev_viewed', 'custom_price_checked')),
    'save', exists (select 1 from e where event_name = 'research_saved')
         or (to_regclass('public.watchlist_games') is not null and exists (select 1 from public.watchlist_games w where w.user_id = v_uid)))
    into v_steps;
  return jsonb_build_object('ok', true, 'steps', v_steps,
    'done', (select count(*) from jsonb_each(v_steps) where value = 'true'::jsonb), 'total', 5,
    'previous_visit_at', v_prev, 'account_created_at', v_created,
    'prefs', case when p.user_id is null then null else jsonb_build_object(
       'leagues', p.leagues, 'books', p.books, 'research_focus', p.research_focus, 'favorite_teams', p.favorite_teams,
       'onboarding_status', p.onboarding_status, 'trial_emails', p.trial_emails,
       'first_run_seen_at', p.first_run_seen_at, 'first_run_done_at', p.first_run_done_at) end);
end $$;
revoke all on function public.ed_first_run_state(text) from public, anon;
grant execute on function public.ed_first_run_state(text) to authenticated;

-- ── 10. the admin's funnel ───────────────────────────────────────────────────
-- For visitors first seen and accounts created in the last p_days. Every
-- figure is a count of rows that exist; a rate with no denominator is null,
-- never 0%.
create or replace function public.funnel_admin_report(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d int := greatest(1, least(coalesce(p_days, 30), 365));
  t0 timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  v_trial_days int := 7; out jsonb;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  begin select trial_days into v_trial_days from public.activation_settings where id = 1; exception when others then null; end;
  v_trial_days := coalesce(v_trial_days, 7);

  with vis as (
    select anonymous_session_id as a,
           bool_or(event_name = 'landing_view') as lv, bool_or(event_name = 'landing_live_board_view') as lb,
           bool_or(event_name = 'pricing_view') as pv, bool_or(event_name = 'cta_clicked') as cta,
           bool_or(event_name = 'signup_started') as ss
      from public.user_events
     where created_at >= t0 and anonymous_session_id is not null
       and event_name in ('landing_view', 'landing_live_board_view', 'pricing_view', 'cta_clicked', 'signup_started')
     group by 1
  ), acc as (
    select u.id as uid, u.created_at as signup_at from auth.users u where u.created_at >= t0
  ), ev as (
    select e.user_id, e.event_name, min(e.created_at) as first_at, bool_or(coalesce((e.event_properties ->> 'during_trial')::boolean, false)) as in_trial
      from public.user_events e join acc on acc.uid = e.user_id
     group by 1, 2
  ), f as (
    select a.uid, a.signup_at,
           coalesce(max(ev.first_at) filter (where ev.event_name = 'trial_started'), max(g.trial_started_at)) as trial_at,
           max(ev.first_at) filter (where ev.event_name = 'checkout_started') as checkout_at,
           max(ev.first_at) filter (where ev.event_name = 'terminal_opened') as terminal_at,
           max(ev.first_at) filter (where ev.event_name in ('board_viewed', 'first_run_viewed')) as board_at,
           max(ev.first_at) filter (where ev.event_name = 'game_opened') as game_at,
           max(ev.first_at) filter (where ev.event_name = 'prop_board_opened') as prop_board_at,
           max(ev.first_at) filter (where ev.event_name = 'prop_opened') as prop_at,
           max(ev.first_at) filter (where ev.event_name in ('ev_viewed', 'custom_price_checked')) as price_at,
           max(ev.first_at) filter (where ev.event_name = 'research_saved') as saved_at,
           max(ev.first_at) filter (where ev.event_name = 'second_session') as second_at,
           max(ev.first_at) filter (where ev.event_name = 'return_day_1') as d1_at,
           max(ev.first_at) filter (where ev.event_name = 'return_day_3') as d3_at,
           max(ev.first_at) filter (where ev.event_name = 'return_day_7') as d7_at,
           coalesce(max(ev.first_at) filter (where ev.event_name = 'subscription_started'), max(g.paid_at)) as paid_at,
           max(ev.first_at) filter (where ev.event_name = 'subscription_cancelled') as cancel_at,
           bool_or(ev.event_name = 'subscription_cancelled' and ev.in_trial) as cancel_in_trial,
           coalesce(max(ua.first_source), '(untracked)') as source,
           max(case when cardinality(p.leagues) = 0 or p.leagues is null then null
                    when p.leagues @> array['nfl','cfb'] then 'both' when p.leagues @> array['nfl'] then 'nfl'
                    when p.leagues @> array['cfb'] then 'cfb' end) as sport,
           max(p.research_focus) as focus
      from acc a
      left join ev on ev.user_id = a.uid
      left join public.growth_customer_facts() g on g.user_id = a.uid and coalesce(g.price_id, '') not in ('owner_comp', 'comp_trial')
      left join public.user_acquisition ua on ua.user_id = a.uid
      left join public.user_preferences p on p.user_id = a.uid
     group by a.uid, a.signup_at
  ), fx as (
    select f.*,
           coalesce(f.sport, 'unset') as sport_key,
           coalesce(f.focus, 'unset') as focus_key,
           case when f.game_at is not null and f.prop_at is not null then 'both'
                when f.game_at is not null then 'game_lines' when f.prop_at is not null then 'player_props'
                else 'neither' end as used,
           case when f.paid_at is not null then 'paid'
                when f.second_at is not null then 'came back'
                when f.saved_at is not null then 'saved research'
                when f.price_at is not null then 'compared a price'
                when f.prop_at is not null then 'opened a prop'
                when f.game_at is not null then 'opened a game'
                when f.board_at is not null then 'viewed the board'
                when f.terminal_at is not null then 'opened the terminal'
                when f.trial_at is not null then 'started a trial'
                when f.checkout_at is not null then 'reached checkout'
                else 'created an account' end as last_step
      from f
  ), t as (select * from fx where trial_at is not null)
  -- landing visitors who became one of the window's accounts (the page links
  -- its visitor to the account when a signed-in page first reports): the
  -- signup rate's numerator, so it can never pass 100%
  , linked as (
    select distinct v.a, l.user_id from vis v
      join public.user_event_links l on l.anonymous_session_id = v.a
      join acc on acc.uid = l.user_id
     where v.lv
  )
  , cohort as (
    select dim, key, count(*)::int as accounts,
           count(*) filter (where trial_at is not null)::int as trials,
           count(*) filter (where trial_at is not null and terminal_at is not null)::int as terminal,
           count(*) filter (where trial_at is not null and game_at is not null)::int as game,
           count(*) filter (where trial_at is not null and prop_at is not null)::int as prop,
           count(*) filter (where signup_at <= now() - interval '1 day')::int as d1_eligible,
           count(*) filter (where signup_at <= now() - interval '1 day' and d1_at is not null)::int as d1,
           count(*) filter (where signup_at <= now() - interval '3 days')::int as d3_eligible,
           count(*) filter (where signup_at <= now() - interval '3 days' and d3_at is not null)::int as d3,
           count(*) filter (where signup_at <= now() - interval '7 days')::int as d7_eligible,
           count(*) filter (where signup_at <= now() - interval '7 days' and d7_at is not null)::int as d7,
           count(*) filter (where paid_at is not null)::int as paid,
           count(*) filter (where cancel_at is not null)::int as cancelled
      from (
        select 'signup_week' as dim, to_char(date_trunc('week', signup_at), 'YYYY-MM-DD') as key, fx.* from fx
        union all select 'source', source, fx.* from fx
        union all select 'sport', sport_key, fx.* from fx
        union all select 'stated_focus', focus_key, fx.* from fx
        union all select 'research_type', used, fx.* from fx
      ) c
     group by dim, key
  )
  select jsonb_build_object(
    'as_of', now(), 'window_days', d, 'trial_days', v_trial_days,
    'steps', jsonb_build_array(
      jsonb_build_object('key', 'visitors',         'label', 'Visitors',                       'n', (select count(*) from vis where lv)),
      jsonb_build_object('key', 'live_board',       'label', 'Saw the live board',             'n', (select count(*) from vis where lb)),
      jsonb_build_object('key', 'pricing',          'label', 'Saw pricing',                    'n', (select count(*) from vis where pv)),
      jsonb_build_object('key', 'landing_cta',      'label', 'Pressed a landing CTA',          'n', (select count(*) from vis where cta)),
      jsonb_build_object('key', 'signup_started',   'label', 'Started sign-up',                'n', (select count(*) from vis where ss)),
      jsonb_build_object('key', 'signed_up',        'label', 'Visitors who created an account', 'n', (select count(distinct a) from linked)),
      jsonb_build_object('key', 'accounts',         'label', 'All new accounts',               'n', (select count(*) from fx)),
      jsonb_build_object('key', 'checkout',         'label', 'Reached Stripe checkout',        'n', (select count(*) from fx where checkout_at is not null)),
      jsonb_build_object('key', 'trials',           'label', 'Started a trial',                'n', (select count(*) from t)),
      jsonb_build_object('key', 'terminal',         'label', 'Opened the terminal (trials)',   'n', (select count(*) from t where terminal_at is not null)),
      jsonb_build_object('key', 'board',            'label', 'Viewed a board (trials)',        'n', (select count(*) from t where board_at is not null)),
      jsonb_build_object('key', 'game',             'label', 'Opened a game (trials)',         'n', (select count(*) from t where game_at is not null)),
      jsonb_build_object('key', 'prop',             'label', 'Opened a player prop (trials)',  'n', (select count(*) from t where prop_at is not null)),
      jsonb_build_object('key', 'price',            'label', 'Compared a price (trials)',      'n', (select count(*) from t where price_at is not null)),
      jsonb_build_object('key', 'saved',            'label', 'Saved research (trials)',        'n', (select count(*) from t where saved_at is not null)),
      jsonb_build_object('key', 'second_session',   'label', 'Came back (trials)',             'n', (select count(*) from t where second_at is not null)),
      jsonb_build_object('key', 'paid',             'label', 'Paid',                           'n', (select count(*) from fx where paid_at is not null))),
    'rates', jsonb_build_object(
      'landing_cta',         (select case when count(*) filter (where lv) > 0 then round((count(*) filter (where lv and cta))::numeric / count(*) filter (where lv), 4) end from vis),
      'signup',              (select case when (select count(*) from vis where lv) > 0 then round((select count(distinct a) from linked)::numeric / (select count(*) from vis where lv), 4) end),
      'trial_start',         (select case when count(*) > 0 then round((count(*) filter (where trial_at is not null))::numeric / count(*), 4) end from fx),
      'terminal_activation', (select case when count(*) > 0 then round((count(*) filter (where terminal_at is not null))::numeric / count(*), 4) end from t),
      'game_open',           (select case when count(*) filter (where terminal_at is not null) > 0 then round((count(*) filter (where game_at is not null and terminal_at is not null))::numeric / count(*) filter (where terminal_at is not null), 4) end from t),
      'prop_open',           (select case when count(*) filter (where terminal_at is not null) > 0 then round((count(*) filter (where prop_at is not null and terminal_at is not null))::numeric / count(*) filter (where terminal_at is not null), 4) end from t),
      'trial_to_paid',       (select case when count(*) filter (where trial_at <= now() - make_interval(days => v_trial_days)) > 0
                                      then round((count(*) filter (where trial_at <= now() - make_interval(days => v_trial_days) and paid_at is not null))::numeric
                                                 / count(*) filter (where trial_at <= now() - make_interval(days => v_trial_days)), 4) end from t),
      'cancellation',        (select case when count(*) > 0 then round((count(*) filter (where cancel_at is not null))::numeric / count(*), 4) end from t)),
    'retention', jsonb_build_object(
      'd1', (select jsonb_build_object('eligible', count(*), 'returned', count(*) filter (where d1_at is not null),
               'rate', case when count(*) > 0 then round((count(*) filter (where d1_at is not null))::numeric / count(*), 4) end)
               from t where signup_at <= now() - interval '1 day'),
      'd3', (select jsonb_build_object('eligible', count(*), 'returned', count(*) filter (where d3_at is not null),
               'rate', case when count(*) > 0 then round((count(*) filter (where d3_at is not null))::numeric / count(*), 4) end)
               from t where signup_at <= now() - interval '3 days'),
      'd7', (select jsonb_build_object('eligible', count(*), 'returned', count(*) filter (where d7_at is not null),
               'rate', case when count(*) > 0 then round((count(*) filter (where d7_at is not null))::numeric / count(*), 4) end)
               from t where signup_at <= now() - interval '7 days')),
    'coverage', jsonb_build_object(
      'accounts', (select count(*) from fx),
      'accounts_from_tracked_visitors', (select count(distinct user_id) from linked),
      'untracked_accounts', (select count(*) from fx) - (select count(distinct user_id) from linked)),
    'trial_outcomes', jsonb_build_object(
      'trials', (select count(*) from t),
      'trials_ended', (select count(*) from t where trial_at <= now() - make_interval(days => v_trial_days)),
      'paid', (select count(*) from t where paid_at is not null),
      'cancelled', (select count(*) from t where cancel_at is not null),
      'cancelled_in_trial', (select count(*) from t where cancel_in_trial)),
    'last_step', (select coalesce(jsonb_agg(jsonb_build_object('step', last_step, 'trials', n) order by n desc), '[]'::jsonb)
                    from (select last_step, count(*)::int as n from t group by 1) q),
    'cohorts', (select coalesce(jsonb_object_agg(dim, rows), '{}'::jsonb) from (
                  select dim, jsonb_agg(to_jsonb(c) - 'dim' order by c.key) as rows from cohort c group by dim) q),
    'definitions', jsonb_build_object(
      'visitor', 'a distinct hashed visitor with a landing_view in the window',
      'signup', 'landing visitors later linked to an account created in the window, over landing visitors; accounts with no tracked visit are counted under All new accounts only',
      'retention', 'rolling: a terminal event N or more days after the account was created, among trials whose account is at least N days old',
      'trial', 'Stripe''s own records (comps excluded)',
      'paid', 'a paid invoice with amount_paid > 0, or trialing became active',
      'trial_to_paid', 'paid among trials whose ' || v_trial_days || '-day trial has ended',
      'starts_at_deploy', 'landing, terminal and research events exist only from the day funnel.sql was applied'))
    into out;
  return out;
end $$;
revoke all on function public.funnel_admin_report(int) from public, anon;
grant execute on function public.funnel_admin_report(int) to authenticated;

notify pgrst, 'reload schema';

-- ── report ───────────────────────────────────────────────────────────────────
select 1 as n, 'the funnel knows ' || (select count(*) from public.user_event_kinds)::text || ' event names' as check_name,
  case when (select count(*) from public.user_event_kinds) >= 26 then 'ok' else 'CHECK THIS' end as outcome
union all
select 2, 'no client role can read or write the events directly',
  case when not has_table_privilege('anon', 'public.user_events', 'select')
        and not has_table_privilege('authenticated', 'public.user_events', 'select')
        and not has_table_privilege('anon', 'public.user_events', 'insert')
        and not has_table_privilege('authenticated', 'public.user_events', 'insert') then 'ok' else 'CHECK THIS' end
union all
select 3, 'pages record events only through ed_track (signed in or out)',
  case when has_function_privilege('anon', 'public.ed_track(jsonb, text, text)', 'execute')
        and has_function_privilege('authenticated', 'public.ed_track(jsonb, text, text)', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 4, 'no internal function is callable by a client role',
  case when not exists (
    select 1 from unnest(array[
      'public.ed_event_record(uuid, text, text, text, jsonb, text, text, text, text, text, timestamp with time zone)',
      'public.ed_derive_return(uuid, text)', 'public.ed_on_auth_user()', 'public.ed_on_subscription()', 'public.ed_on_stripe_event()',
      'public.ed_clean_props(jsonb)', 'public.ed_visitor_hash(text)']) f
    cross join unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, f, 'execute')) then 'ok' else 'CHECK THIS' end
union all
select 5, 'the admin report is closed to signed-out visitors',
  case when not has_function_privilege('anon', 'public.funnel_admin_report(integer)', 'execute')
        and not has_function_privilege('anon', 'public.ed_first_run_state(text)', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 6, 'signup, subscription and Stripe-ledger triggers are installed',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in
    ('ed_on_auth_user_trg', 'ed_on_subscription_trg', 'ed_on_stripe_event_trg')) = 3 then 'ok' else 'CHECK THIS' end
union all
select 7, 'every account has an account_created event (' || (select count(*) from auth.users)::text || ' account(s))',
  case when not exists (select 1 from auth.users u where not exists (
    select 1 from public.user_events e where e.user_id = u.id and e.event_name = 'account_created')) then 'ok' else 'CHECK THIS' end
union all
select 8, 'first-run preference columns exist',
  case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'user_preferences'
               and column_name in ('research_focus', 'favorite_teams', 'trial_emails', 'first_run_seen_at', 'first_run_done_at')) = 5
       then 'ok' else 'CHECK THIS' end
order by 1;
