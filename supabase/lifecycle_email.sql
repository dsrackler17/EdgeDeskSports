-- =============================================================================
-- lifecycle_email — the four emails a trial reader gets, and nothing more.
--
--   trial_welcome     right after the trial starts: "Your EdgeDesk terminal is
--                     live." — what is on the board now, three first steps,
--                     the date the trial ends and how to cancel
--   trial_day1        a day in: current, real research from the board
--   trial_day3        three days in: what is new or re-priced since the
--                     reader's previous visit
--   renewal_reminder  before the trial converts: the exact date the card
--                     will be charged and the amount — the reminder the
--                     landing page, the renewal terms and terms.html promise
--
-- WHAT IT IS
--   lifecycle_settings   ONE row. sending_enabled defaults to FALSE: nothing is
--                        sent until an operator switches it on in
--                        /admin/funnel/, after the sender's secrets exist.
--   lifecycle_messages   one row per (reader, kind, reference) — the unique
--                        key is the "at most once" guarantee, so a re-run, a
--                        retry or two overlapping jobs can never send the
--                        same email twice. The body is not stored; the
--                        sender builds it at send time from the CURRENT board
--                        (a stored body would carry stale prices).
--   lifecycle_tokens     one random unsubscribe token per reader.
--   lifecycle_plan()     service role: schedules the rows that are due to
--                        exist (trials started in the last 10 days, trials
--                        about to convert), idempotently.
--   lifecycle_due(n)     service role: CLAIMS up to n due rows (skip-locked,
--                        so two jobs never take the same row), re-checks each
--                        against the reader's state NOW (cancelled, converted,
--                        opted out, bounced, charge date moved) and marks the
--                        ones that no longer apply as skipped with the reason;
--                        returns the rest with only what the email needs.
--   lifecycle_mark()     service role: sent / failed, with the provider id.
--   lifecycle_unsubscribe(token)  anon: turns off the trial tips (welcome,
--                        day 1, day 3). The renewal reminder is a billing
--                        notice and is still sent: nobody should be charged
--                        without being told when.
--   lifecycle_admin_summary() / lifecycle_admin_set(jsonb)  the admin's view
--                        and switches, under the operator list.
--
-- NOT SPAM, BY CONSTRUCTION: four emails in a 7-day trial, each once; tips
-- stop on opt-out, on cancellation and on conversion; a bounced or
-- complained address (newsletter_suppressions, when present) gets nothing;
-- no urgency, no countdown — the reminder states a date.
--
-- RUN ORDER. funnel.sql first (trial_started events, user_preferences
-- .trial_emails). newsletter.sql is optional (its suppressions are honoured
-- when present).
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.user_events') is null or to_regprocedure('public.ed_event_record(uuid, text, text, text, jsonb, text, text, text, text, text, timestamp with time zone)') is null then
    raise exception 'Run supabase/funnel.sql first (trial events and reader preferences live there).';
  end if;
end
$guard$;

create table if not exists public.lifecycle_settings (
  id                 int primary key default 1 check (id = 1),
  sending_enabled    boolean not null default false,
  welcome_enabled    boolean not null default true,
  day1_enabled       boolean not null default true,
  day3_enabled       boolean not null default true,
  renewal_enabled    boolean not null default true,
  renewal_lead_hours int not null default 48 check (renewal_lead_hours between 24 and 120),
  from_email         text not null default 'EdgeDesk <research@edgedesksports.com>',
  reply_to           text not null default 'support@edgedesksports.com',
  site_url           text not null default 'https://edgedesksports.com',
  mailing_address    text not null default 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423',
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
insert into public.lifecycle_settings (id) values (1) on conflict (id) do nothing;
alter table public.lifecycle_settings enable row level security;
revoke all on public.lifecycle_settings from anon, authenticated;

create table if not exists public.lifecycle_messages (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('trial_welcome', 'trial_day1', 'trial_day3', 'renewal_reminder')),
  ref          text not null,
  due_at       timestamptz not null,
  trial_at     timestamptz,
  charge_at    timestamptz,
  status       text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts     int not null default 0,
  skip_reason  text,
  last_error   text,
  provider_id  text,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint lifecycle_messages_once unique (user_id, kind, ref)
);
create index if not exists lifecycle_messages_due on public.lifecycle_messages (status, due_at);
alter table public.lifecycle_messages enable row level security;
revoke all on public.lifecycle_messages from anon, authenticated;

create table if not exists public.lifecycle_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now()
);
alter table public.lifecycle_tokens enable row level security;
revoke all on public.lifecycle_tokens from anon, authenticated;

-- ── scheduling ───────────────────────────────────────────────────────────────
create or replace function public.lifecycle_plan()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.lifecycle_settings%rowtype; n0 int; n1 int;
begin
  select * into s from public.lifecycle_settings where id = 1;
  select count(*) into n0 from public.lifecycle_messages;
  -- the three trial emails, from the funnel's own trial_started events (comps
  -- are not trials there), for trials that started in the last 10 days;
  -- a welcome is only ever sent within two days of the trial
  with t as (
    select e.user_id, min(e.created_at) as trial_at, coalesce(max(e.event_properties ->> 'entity'), '-') as sub
      from public.user_events e
     where e.event_name = 'trial_started' and e.created_at > now() - interval '10 days'
     group by e.user_id
  )
  insert into public.lifecycle_messages (user_id, kind, ref, due_at, trial_at)
  select t.user_id, k.kind, t.sub, t.trial_at + k.after, t.trial_at
    from t cross join (values ('trial_welcome', interval '0'), ('trial_day1', interval '24 hours'), ('trial_day3', interval '72 hours')) k(kind, after)
   where (k.kind <> 'trial_welcome' or t.trial_at > now() - interval '2 days')
     and (k.kind <> 'trial_day1' or t.trial_at + interval '24 hours' > now() - interval '1 day')
     and (k.kind <> 'trial_day3' or t.trial_at + interval '72 hours' > now() - interval '1 day')
  on conflict on constraint lifecycle_messages_once do nothing;
  -- the reminder before a trial converts: one per subscription per charge date
  insert into public.lifecycle_messages (user_id, kind, ref, due_at, charge_at)
  select sb.user_id, 'renewal_reminder',
         coalesce(sb.stripe_subscription_id, '-') || ':' || to_char(sb.current_period_end at time zone 'utc', 'YYYY-MM-DD'),
         greatest(now(), sb.current_period_end - make_interval(hours => s.renewal_lead_hours)), sb.current_period_end
    from public.subscriptions sb
   where sb.status = 'trialing'
     and coalesce(sb.price_id, '') not in ('owner_comp', 'comp_trial')
     and not coalesce(sb.cancel_at_period_end, false)
     and sb.current_period_end > now() + interval '6 hours'
     and sb.current_period_end < now() + interval '30 days'
  on conflict on constraint lifecycle_messages_once do nothing;
  select count(*) into n1 from public.lifecycle_messages;
  return jsonb_build_object('ok', true, 'scheduled', n1 - n0);
end $$;
revoke all on function public.lifecycle_plan() from public, anon, authenticated;
grant execute on function public.lifecycle_plan() to service_role;

-- ── claiming what is due, re-checked NOW ─────────────────────────────────────
create or replace function public.lifecycle_due(p_limit int default 25)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.lifecycle_settings%rowtype; out jsonb := '[]'::jsonb; r record; v_skip text; v_email text; v_conf boolean;
  v_sub record; v_prefs record; v_prev timestamptz; v_tok text; v_amt bigint; v_supp boolean;
begin
  select * into s from public.lifecycle_settings where id = 1;
  if not s.sending_enabled then return jsonb_build_object('ok', true, 'sending_enabled', false, 'messages', '[]'::jsonb); end if;
  -- a row claimed by a job that died is released after 30 minutes
  update public.lifecycle_messages set status = 'pending', updated_at = now()
   where status = 'sending' and claimed_at < now() - interval '30 minutes';
  for r in
    update public.lifecycle_messages m set status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
     where m.id in (select id from public.lifecycle_messages
                     where status in ('pending', 'failed') and due_at <= now() and attempts < 3
                     order by due_at for update skip locked limit greatest(1, least(coalesce(p_limit, 25), 100)))
    returning m.*
  loop
    v_skip := null;
    select u.email, u.email_confirmed_at is not null into v_email, v_conf from auth.users u where u.id = r.user_id;
    select * into v_sub from public.subscriptions where user_id = r.user_id;
    select * into v_prefs from public.user_preferences where user_id = r.user_id;
    v_supp := false;
    if to_regclass('public.newsletter_suppressions') is not null and v_email is not null then
      begin
        execute 'select exists (select 1 from public.newsletter_suppressions where lower(email) = lower($1) and reason in (''bounce'', ''complaint''))'
          into v_supp using v_email;
      exception when others then v_supp := false;
      end;
    end if;
    if v_email is null or v_email !~ '@' then v_skip := 'no deliverable address';
    elsif v_supp then v_skip := 'address bounced or complained';
    elsif r.kind = 'trial_welcome' and not s.welcome_enabled then v_skip := 'welcome switched off';
    elsif r.kind = 'trial_welcome' and (v_sub.user_id is null or v_sub.status not in ('trialing', 'active')) then v_skip := 'no longer an active trial';
    elsif r.kind = 'trial_day1' and not s.day1_enabled then v_skip := 'day-1 email switched off';
    elsif r.kind = 'trial_day3' and not s.day3_enabled then v_skip := 'day-3 email switched off';
    elsif r.kind = 'renewal_reminder' and not s.renewal_enabled then v_skip := 'renewal reminder switched off';
    elsif r.kind in ('trial_day1', 'trial_day3') and v_prefs.user_id is not null and not coalesce(v_prefs.trial_emails, true) then v_skip := 'reader turned trial tips off';
    elsif r.kind in ('trial_day1', 'trial_day3') and (v_sub.user_id is null or v_sub.status <> 'trialing' or coalesce(v_sub.cancel_at_period_end, false)) then v_skip := 'no longer an active trial';
    elsif r.kind in ('trial_day1', 'trial_day3') and r.due_at < now() - interval '1 day' then v_skip := 'too late to be useful';
    elsif r.kind = 'renewal_reminder' and (v_sub.user_id is null or v_sub.status <> 'trialing' or coalesce(v_sub.cancel_at_period_end, false)) then v_skip := 'nothing will be charged';
    elsif r.kind = 'renewal_reminder' and (v_sub.current_period_end is distinct from r.charge_at) then v_skip := 'the charge date moved';
    elsif r.kind = 'renewal_reminder' and r.charge_at <= now() + interval '2 hours' then v_skip := 'too close to the charge to be a reminder';
    end if;
    if v_skip is not null then
      update public.lifecycle_messages set status = 'skipped', skip_reason = v_skip, updated_at = now() where id = r.id;
      continue;
    end if;
    insert into public.lifecycle_tokens (user_id) values (r.user_id) on conflict (user_id) do nothing;
    select token into v_tok from public.lifecycle_tokens where user_id = r.user_id;
    select max(created_at) into v_prev from public.user_events
     where user_id = r.user_id and event_name = 'terminal_opened' and created_at < now() - interval '10 minutes';
    -- what Stripe will charge, when its own subscription event says so
    v_amt := null;
    begin
      select nullif(coalesce(public.affiliate_stripe_object(e.payload) #>> '{items,data,0,price,unit_amount}',
                             public.affiliate_stripe_object(e.payload) #>> '{plan,amount}'), '')::bigint
        into v_amt
        from public.stripe_events e
       where e.type like 'customer.subscription.%' and v_sub.stripe_subscription_id is not null and e.subscription_id = v_sub.stripe_subscription_id
       order by coalesce(e.stripe_created, e.created_at) desc limit 1;
    exception when others then v_amt := null;
    end;
    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'user_id', r.user_id, 'email', v_email, 'due_at', r.due_at,
      'trial_at', r.trial_at, 'charge_at', coalesce(r.charge_at, case when v_sub.status = 'trialing' then v_sub.current_period_end end),
      'amount_cents', v_amt, 'previous_visit_at', v_prev, 'unsubscribe_token', v_tok,
      'leagues', to_jsonb(v_prefs.leagues), 'research_focus', v_prefs.research_focus, 'favorite_teams', to_jsonb(v_prefs.favorite_teams))));
  end loop;
  return jsonb_build_object('ok', true, 'sending_enabled', true, 'from', s.from_email, 'reply_to', s.reply_to,
    'site_url', s.site_url, 'mailing_address', s.mailing_address, 'messages', out);
end $$;
revoke all on function public.lifecycle_due(int) from public, anon, authenticated;
grant execute on function public.lifecycle_due(int) to service_role;

create or replace function public.lifecycle_mark(p_id bigint, p_status text, p_provider_id text default null, p_error text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_status not in ('sent', 'failed', 'skipped', 'release') then return false; end if;
  -- a dry run gives the row back exactly as it was: pending, attempt uncounted
  if p_status = 'release' then
    update public.lifecycle_messages set status = 'pending', attempts = greatest(0, attempts - 1), claimed_at = null, updated_at = now()
     where id = p_id and status = 'sending';
    get diagnostics n = row_count;
    return n > 0;
  end if;
  update public.lifecycle_messages
     set status = p_status, provider_id = left(p_provider_id, 120), last_error = left(p_error, 400),
         skip_reason = case when p_status = 'skipped' then left(p_error, 200) else skip_reason end,
         sent_at = case when p_status = 'sent' then now() else sent_at end, updated_at = now()
   where id = p_id and status = 'sending';
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.lifecycle_mark(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.lifecycle_mark(bigint, text, text, text) to service_role;

-- the link in every tip email; anyone holding it may only turn tips OFF
create or replace function public.lifecycle_unsubscribe(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select user_id into v_uid from public.lifecycle_tokens where token = p_token;
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  insert into public.user_preferences (user_id, trial_emails) values (v_uid, false)
  on conflict (user_id) do update set trial_emails = false;
  update public.lifecycle_messages set status = 'skipped', skip_reason = 'reader turned trial tips off', updated_at = now()
   where user_id = v_uid and status = 'pending' and kind in ('trial_day1', 'trial_day3');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.lifecycle_unsubscribe(text) from public;
grant execute on function public.lifecycle_unsubscribe(text) to anon, authenticated;

-- ── the admin's view and switches ────────────────────────────────────────────
create or replace function public.lifecycle_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.lifecycle_settings%rowtype;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  select * into s from public.lifecycle_settings where id = 1;
  return jsonb_build_object('as_of', now(), 'settings', to_jsonb(s) - 'updated_by',
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'status', status, 'n', n) order by kind, status), '[]'::jsonb)
                 from (select kind, status, count(*)::int as n from public.lifecycle_messages
                        where created_at > now() - interval '30 days' group by 1, 2) q),
    'skips', (select coalesce(jsonb_agg(jsonb_build_object('reason', skip_reason, 'n', n) order by n desc), '[]'::jsonb)
                from (select skip_reason, count(*)::int as n from public.lifecycle_messages
                       where status = 'skipped' and created_at > now() - interval '30 days' group by 1) q),
    'next_due', (select min(due_at) from public.lifecycle_messages where status = 'pending'),
    'opted_out', (select count(*) from public.user_preferences where not trial_emails));
end $$;
revoke all on function public.lifecycle_admin_summary() from public, anon;
grant execute on function public.lifecycle_admin_summary() to authenticated;

create or replace function public.lifecycle_admin_set(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  update public.lifecycle_settings set
    sending_enabled    = coalesce((p ->> 'sending_enabled')::boolean, sending_enabled),
    welcome_enabled    = coalesce((p ->> 'welcome_enabled')::boolean, welcome_enabled),
    day1_enabled       = coalesce((p ->> 'day1_enabled')::boolean, day1_enabled),
    day3_enabled       = coalesce((p ->> 'day3_enabled')::boolean, day3_enabled),
    renewal_enabled    = coalesce((p ->> 'renewal_enabled')::boolean, renewal_enabled),
    renewal_lead_hours = coalesce((p ->> 'renewal_lead_hours')::int, renewal_lead_hours),
    updated_at = now(), updated_by = auth.uid()
   where id = 1;
  return public.lifecycle_admin_summary();
end $$;
revoke all on function public.lifecycle_admin_set(jsonb) from public, anon;
grant execute on function public.lifecycle_admin_set(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ── report ───────────────────────────────────────────────────────────────────
select 1 as n, 'sending is off until an operator switches it on (' || case when (select sending_enabled from public.lifecycle_settings where id = 1) then 'ON' else 'off' end || ')' as check_name,
  'ok' as outcome
union all
select 2, 'no client role can read or write the messages, tokens or settings',
  case when not has_table_privilege('anon', 'public.lifecycle_messages', 'select') and not has_table_privilege('authenticated', 'public.lifecycle_messages', 'select')
        and not has_table_privilege('anon', 'public.lifecycle_tokens', 'select') and not has_table_privilege('authenticated', 'public.lifecycle_settings', 'select')
       then 'ok' else 'CHECK THIS' end
union all
select 3, 'scheduling, claiming and marking are the sender''s alone',
  case when not exists (select 1 from unnest(array['public.lifecycle_plan()', 'public.lifecycle_due(integer)', 'public.lifecycle_mark(bigint, text, text, text)']) f
                         cross join unnest(array['anon', 'authenticated']) r where has_function_privilege(r, f, 'execute')) then 'ok' else 'CHECK THIS' end
union all
select 4, 'a reader can turn tips off from the email link, signed out',
  case when has_function_privilege('anon', 'public.lifecycle_unsubscribe(text)', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 5, 'each email can exist once per reader, kind and reference',
  case when exists (select 1 from pg_constraint where conname = 'lifecycle_messages_once') then 'ok' else 'CHECK THIS' end
order by 1;
