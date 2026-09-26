-- =============================================================================
-- growth — trial activation, acquisition attribution and public sample
-- research: what a trial reader DID, where they CAME FROM, and which games a
-- visitor may read without an account.
--
-- WHAT IT IS
--   activation_settings   ONE row: the weight of every trial action and the
--                         thresholds of the four activation states. The admin
--                         edits it in /admin/growth/; nothing is hard-coded.
--   activation_events     one row per MEANINGFUL action, deduplicated
--                         (matchup viewed, repeat visit, watchlist save, AI
--                         research used, Compare My Number used, journal entry
--                         created, Top 5 opened, alert configured, share card
--                         generated). Actions that already write a row of
--                         their own (watchlist, journal, alerts, share cards)
--                         are recorded BY TRIGGER on that row — the client
--                         cannot forget them and cannot invent them. The rest
--                         arrive through edp_track(), which accepts only those
--                         kinds.
--   user_activation       the derived state per reader: NOT_ACTIVATED,
--                         EXPLORING, ACTIVATED, POWER_USER, and WHEN each was
--                         first reached — replayed from the events in order,
--                         so changing a threshold recomputes history honestly.
--                         INTERNAL: no client role can read it, and nothing in
--                         the product shows a reader their score.
--   acquisition_visitors  one row per (hashed) visitor: the first ATTRIBUTABLE
--                         touch (a direct visit is a placeholder the first
--                         attributable one replaces, then it is frozen) and
--                         the latest attributable touch, classified into
--                         organic_x, x_dm, creator_affiliate, linkedin,
--                         search, direct, referral, other.
--   user_acquisition      the same two touches for an ACCOUNT, as of signup:
--                         first touch write-once, last touch kept separately.
--   public_sample_games   the games an admin made publicly readable. A
--                         signed-out visitor reads them through
--                         public_sample_research(), which returns a SUBSET of
--                         the shared research state — never the whole row.
--
-- WHAT IT IS NOT
--   * It never touches the affiliate ledger. Who a creator is paid for is
--     decided by affiliate_attributions alone (affiliates.sql: first valid
--     attribution wins, never overwritten). Acquisition attribution is a
--     marketing measurement beside it; the funnel shows both and lets them
--     disagree.
--   * It computes no research number. Public samples read the shared state
--     the football module wrote (personal_research.sql).
--
-- RUN ORDER. billing.sql, stripe_webhook.sql, referral_codes.sql,
-- personal_research.sql, affiliates.sql, then this file. The guard says so.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null or to_regclass('public.stripe_events') is null then
    raise exception 'Run supabase/billing.sql and supabase/stripe_webhook.sql first.';
  end if;
  if to_regclass('public.research_journal') is null or to_regclass('public.share_cards') is null then
    raise exception 'Run supabase/personal_research.sql first (this file records actions on its tables).';
  end if;
  if to_regclass('public.affiliate_campaigns') is null then
    raise exception 'Run supabase/affiliates.sql first (the operator list and creator codes live there).';
  end if;
end
$guard$;

-- ── re-running this file on a live site ─────────────────────────────────────
-- Every lock the file needs, taken first, all at once or not at all (NOWAIT,
-- retried for 30 seconds) — the same rule personal_research.sql and
-- affiliates.sql follow, for the same reason: this file adds triggers to the
-- watchlist, journal, alert and share-card tables a reader may be writing.
do $locks$
declare
  v_list text;
  v_try int := 0;
begin
  select string_agg(t, ', ') into v_list from unnest(array[
    'public.watchlist_games',
    'public.research_journal',
    'public.alert_preferences',
    'public.share_cards',
    'public.activation_settings',
    'public.activation_events',
    'public.user_activation',
    'public.acquisition_visitors',
    'public.user_acquisition',
    'public.public_sample_games']) t
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

-- The operator list for the business consoles is the partner program's
-- (public.affiliate_admins): one list, not a second one to keep in step.
create or replace function public.growth_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.affiliate_is_admin();
$$;
revoke all on function public.growth_is_admin() from public, anon;
grant execute on function public.growth_is_admin() to authenticated;

-- ── 1. activation_settings ───────────────────────────────────────────────────
-- The kinds, stated once. 'visit' carries no weight: it marks an active day.
create or replace function public.growth_kinds()
returns text[] language sql immutable as $$
  select array['visit','matchup_viewed','repeat_visit','top5_opened','watchlist_save','alert_configured',
               'ai_research_used','compare_my_number','journal_entry_created','share_card_generated']::text[];
$$;
-- A weights object: every key a known kind, every value a number 0-100.
create or replace function public.growth_weights_ok(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
     where not (e.key = any(public.growth_kinds()))
        or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric < 0 or (e.value #>> '{}')::numeric > 100);
$$;

create table if not exists public.activation_settings (
  id                          int primary key default 1,
  weights                     jsonb not null default '{"matchup_viewed":1,"repeat_visit":2,"top5_opened":1,"watchlist_save":2,"alert_configured":2,"ai_research_used":2,"compare_my_number":3,"journal_entry_created":3,"share_card_generated":2}'::jsonb,
  per_kind_cap                int not null default 5,
  exploring_min_points        numeric not null default 1,
  activated_min_points        numeric not null default 8,
  activated_min_kinds         int not null default 3,
  activated_min_active_days   int not null default 2,
  activated_requires_core     boolean not null default true,
  core_kinds                  text[] not null default array['watchlist_save','alert_configured','compare_my_number','journal_entry_created','share_card_generated']::text[],
  power_min_points            numeric not null default 25,
  power_min_kinds             int not null default 5,
  power_min_active_days       int not null default 5,
  trial_days                  int not null default 7,
  retained_min_paid_invoices  int not null default 2,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'activation_settings_singleton') then
    alter table public.activation_settings add constraint activation_settings_singleton check (id = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activation_settings_ranges') then
    alter table public.activation_settings add constraint activation_settings_ranges check (
          public.growth_weights_ok(weights)
      and core_kinds <@ public.growth_kinds()
      and per_kind_cap between 1 and 100
      and exploring_min_points > 0 and exploring_min_points <= activated_min_points
      and activated_min_points <= power_min_points and power_min_points <= 10000
      and activated_min_kinds between 1 and 9 and power_min_kinds between activated_min_kinds and 9
      and activated_min_active_days between 1 and 60 and power_min_active_days between activated_min_active_days and 120
      and trial_days between 1 and 60
      and retained_min_paid_invoices between 2 and 24);
  end if;
end $c$;
insert into public.activation_settings (id) values (1) on conflict (id) do nothing;
alter table public.activation_settings enable row level security;
revoke all on public.activation_settings from anon, authenticated;

-- ── 2. activation_events ─────────────────────────────────────────────────────
create table if not exists public.activation_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,
  dedupe_key   text not null,
  game_key     text,
  source       text not null default 'client',
  occurred_at  timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'activation_events_once') then
    alter table public.activation_events add constraint activation_events_once unique (user_id, kind, dedupe_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activation_events_shape') then
    alter table public.activation_events add constraint activation_events_shape check (
          kind = any(public.growth_kinds())
      and length(dedupe_key) between 1 and 160
      and source in ('client', 'db')
      and (game_key is null or game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$'));
  end if;
end $c$;
create index if not exists activation_events_user_idx on public.activation_events (user_id, occurred_at);
alter table public.activation_events enable row level security;
revoke all on public.activation_events from anon, authenticated;

-- ── 3. user_activation (derived; internal) ───────────────────────────────────
create table if not exists public.user_activation (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  state            text not null default 'NOT_ACTIVATED',
  points           numeric not null default 0,
  kinds            int not null default 0,
  active_days      int not null default 0,
  events           int not null default 0,
  first_event_at   timestamptz,
  exploring_at     timestamptz,
  activated_at     timestamptz,
  power_user_at    timestamptz,
  computed_at      timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_activation_state') then
    alter table public.user_activation add constraint user_activation_state check (
      state in ('NOT_ACTIVATED', 'EXPLORING', 'ACTIVATED', 'POWER_USER'));
  end if;
end $c$;
create index if not exists user_activation_state_idx on public.user_activation (state);
alter table public.user_activation enable row level security;
revoke all on public.user_activation from anon, authenticated;

-- THE STATE, replayed from the reader's events in the order they happened.
-- Points: each kind's weight, counted at most per_kind_cap times. Kinds: the
-- distinct weighted kinds. Active days: distinct UTC days with any event.
-- A state's time is the moment of the event that first met it, so "time to
-- activation" is measured, not estimated, and a threshold change recomputes it.
create or replace function public.activation_compute(p_user uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.activation_settings%rowtype; r record;
  pts numeric := 0; kinds text[] := '{}'; days date[] := '{}'; cnt jsonb := '{}'::jsonb; core boolean := false;
  n int; w numeric; d date; total int := 0; first_at timestamptz; exp_at timestamptz; act_at timestamptz; pow_at timestamptz; st text;
begin
  if p_user is null then return null; end if;
  select * into s from public.activation_settings where id = 1;
  for r in select kind, occurred_at from public.activation_events where user_id = p_user order by occurred_at, id loop
    total := total + 1;
    if first_at is null then first_at := r.occurred_at; end if;
    d := (r.occurred_at at time zone 'utc')::date;
    if not (d = any(days)) then days := days || d; end if;
    w := coalesce((s.weights ->> r.kind)::numeric, 0);
    n := coalesce((cnt ->> r.kind)::int, 0) + 1;
    cnt := cnt || jsonb_build_object(r.kind, n);
    if w > 0 and n <= s.per_kind_cap then pts := pts + w; end if;
    if w > 0 and not (r.kind = any(kinds)) then kinds := kinds || r.kind; end if;
    if r.kind = any(s.core_kinds) then core := true; end if;
    if exp_at is null and pts >= s.exploring_min_points then exp_at := r.occurred_at; end if;
    if act_at is null and pts >= s.activated_min_points and cardinality(kinds) >= s.activated_min_kinds
       and cardinality(days) >= s.activated_min_active_days and (not s.activated_requires_core or core) then
      act_at := r.occurred_at;
    end if;
    if pow_at is null and act_at is not null and pts >= s.power_min_points and cardinality(kinds) >= s.power_min_kinds
       and cardinality(days) >= s.power_min_active_days then
      pow_at := r.occurred_at;
    end if;
  end loop;
  st := case when pow_at is not null then 'POWER_USER' when act_at is not null then 'ACTIVATED'
             when exp_at is not null then 'EXPLORING' else 'NOT_ACTIVATED' end;
  insert into public.user_activation (user_id, state, points, kinds, active_days, events, first_event_at, exploring_at, activated_at, power_user_at, computed_at)
  values (p_user, st, pts, cardinality(kinds), cardinality(days), total, first_at, exp_at, act_at, pow_at, now())
  on conflict (user_id) do update set state = excluded.state, points = excluded.points, kinds = excluded.kinds,
    active_days = excluded.active_days, events = excluded.events, first_event_at = excluded.first_event_at,
    exploring_at = excluded.exploring_at, activated_at = excluded.activated_at, power_user_at = excluded.power_user_at,
    computed_at = excluded.computed_at;
  return st;
end $$;
revoke all on function public.activation_compute(uuid) from public, anon, authenticated;

create or replace function public.activation_events_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.activation_compute(new.user_id);
  return null;
end $$;
drop trigger if exists activation_events_after_trg on public.activation_events;
create trigger activation_events_after_trg after insert on public.activation_events
  for each row execute function public.activation_events_after();

-- one row, deduplicated; never raises
create or replace function public.growth_record(p_user uuid, p_kind text, p_dedupe text, p_game_key text, p_source text default 'db')
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null or not (p_kind = any(public.growth_kinds())) then return false; end if;
  insert into public.activation_events (user_id, kind, dedupe_key, game_key, source)
  values (p_user, p_kind, left(coalesce(nullif(p_dedupe, ''), '-'), 160),
          case when p_game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$' then p_game_key end, p_source)
  on conflict on constraint activation_events_once do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.growth_record(uuid, text, text, text, text) from public, anon, authenticated;

-- ── 4. the client's door: the actions that write no row of their own ───────
-- Dedupe is decided HERE, not by the page: a visit is one per UTC day, a
-- matchup view or a comparison one per game per day, an AI question or the
-- Top 5 one per day. Nothing about the reader's score is returned.
create or replace function public.edp_track(p_kind text, p_game_key text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_day text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  v_game text; v_today int; v_new boolean;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if p_kind is null or p_kind not in ('visit', 'matchup_viewed', 'ai_research_used', 'compare_my_number', 'top5_opened') then
    return jsonb_build_object('ok', false, 'reason', 'not_a_client_event');
  end if;
  v_game := case when p_game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$' then p_game_key end;
  select count(*) into v_today from public.activation_events
   where user_id = v_uid and occurred_at >= (now() at time zone 'utc')::date::timestamp at time zone 'utc';
  if v_today >= 400 then return jsonb_build_object('ok', true, 'capped', true); end if;
  v_new := public.growth_record(v_uid, p_kind,
    case when p_kind in ('matchup_viewed', 'compare_my_number') then coalesce(v_game, '-') || '|' || v_day else v_day end,
    v_game, 'client');
  -- a visit on a later day than the first is a repeat visit
  if p_kind = 'visit' and v_new and exists (
       select 1 from public.activation_events where user_id = v_uid and kind = 'visit' and dedupe_key < v_day) then
    perform public.growth_record(v_uid, 'repeat_visit', v_day, null, 'client');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.edp_track(text, text) from public, anon;
grant execute on function public.edp_track(text, text) to authenticated;

-- ── 5. actions that already write a row: recorded by trigger ────────────────
-- A trigger here can NEVER fail the reader's own write: a watchlist save is
-- worth more than an analytics row, so any error is a warning.
create or replace function public.growth_on_product_row()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    if tg_table_name = 'watchlist_games' then
      if coalesce(new.source, 'app') <> 'import' then
        perform public.growth_record(new.user_id, 'watchlist_save', new.game_key, new.game_key);
      end if;
    elsif tg_table_name = 'research_journal' then
      perform public.growth_record(new.user_id, 'journal_entry_created', new.entry_id::text, new.game_key);
      if new.my_home_line is not null or new.my_total is not null then
        perform public.growth_record(new.user_id, 'compare_my_number',
          new.game_key || '|' || to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD'), new.game_key);
      end if;
    elsif tg_table_name = 'alert_preferences' then
      perform public.growth_record(new.user_id, 'alert_configured', 'alert_preferences', null);
    elsif tg_table_name = 'share_cards' then
      perform public.growth_record(new.user_id, 'share_card_generated', new.card_id::text, new.game_key);
    end if;
  exception when others then
    raise warning 'growth: % action not recorded: %', tg_table_name, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists growth_watchlist_trg on public.watchlist_games;
create trigger growth_watchlist_trg after insert on public.watchlist_games
  for each row execute function public.growth_on_product_row();
drop trigger if exists growth_journal_trg on public.research_journal;
create trigger growth_journal_trg after insert on public.research_journal
  for each row execute function public.growth_on_product_row();
drop trigger if exists growth_alert_prefs_trg on public.alert_preferences;
create trigger growth_alert_prefs_trg after insert or update on public.alert_preferences
  for each row execute function public.growth_on_product_row();
drop trigger if exists growth_share_cards_trg on public.share_cards;
create trigger growth_share_cards_trg after insert on public.share_cards
  for each row execute function public.growth_on_product_row();

-- ── 5b. what readers already did, before this file ───────────────────────────
-- The rows that already exist are the same actions the triggers above record
-- from now on, stamped with the time each row was made. Idempotent (the
-- dedupe keys are the triggers' own), so re-running the file adds nothing.
-- Client-only actions (visits, matchup views, AI questions, the Top 5) were
-- never stored before this file and are not invented.
insert into public.activation_events (user_id, kind, dedupe_key, game_key, source, occurred_at)
select w.user_id, 'watchlist_save', w.game_key, w.game_key, 'db', w.created_at
  from public.watchlist_games w where coalesce(w.source, 'app') <> 'import'
on conflict on constraint activation_events_once do nothing;
insert into public.activation_events (user_id, kind, dedupe_key, game_key, source, occurred_at)
select j.user_id, 'journal_entry_created', j.entry_id::text, j.game_key, 'db', j.created_at
  from public.research_journal j
on conflict on constraint activation_events_once do nothing;
insert into public.activation_events (user_id, kind, dedupe_key, game_key, source, occurred_at)
select distinct on (j.user_id, j.game_key, (j.created_at at time zone 'utc')::date)
       j.user_id, 'compare_my_number', j.game_key || '|' || to_char((j.created_at at time zone 'utc')::date, 'YYYY-MM-DD'), j.game_key, 'db', j.created_at
  from public.research_journal j where j.my_home_line is not null or j.my_total is not null
 order by j.user_id, j.game_key, (j.created_at at time zone 'utc')::date, j.created_at
on conflict on constraint activation_events_once do nothing;
insert into public.activation_events (user_id, kind, dedupe_key, game_key, source, occurred_at)
select a.user_id, 'alert_configured', 'alert_preferences', null, 'db', a.created_at
  from public.alert_preferences a
on conflict on constraint activation_events_once do nothing;
insert into public.activation_events (user_id, kind, dedupe_key, game_key, source, occurred_at)
select c.user_id, 'share_card_generated', c.card_id::text, c.game_key, 'db', c.created_at
  from public.share_cards c
on conflict on constraint activation_events_once do nothing;

-- ── 6. acquisition attribution ───────────────────────────────────────────────
-- THE SOURCES, and the rule that assigns one, stated once:
--   1  an explicit utm_source that IS a source key (?utm_source=x_dm) wins;
--   2  a ?ref= code that belongs to a creator (an account or a campaign) is
--      creator_affiliate; any other ref is referral;
--   3  a paid medium (cpc, ppc, paid, paid_social, ads, display) is other;
--   4  utm_source x / twitter is organic_x, or x_dm with utm_medium=dm;
--      linkedin is linkedin; a search engine (or utm_medium=organic) is
--      search; any other utm_source is other;
--   5  with no utm and no ref, the referrer host decides: t.co / x.com /
--      twitter.com organic_x, linkedin linkedin, a search engine search,
--      EdgeDesk itself or Stripe checkout direct, anything else referral;
--   6  nothing at all is direct.
-- An X direct message usually arrives with the t.co referrer an X post does,
-- so x_dm is only ever what a link TAGGED as one says (utm_medium=dm).
create or replace function public.acq_classify(p_ref text, p_utm_source text, p_utm_medium text, p_referrer text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare src text := lower(btrim(coalesce(p_utm_source, ''))); med text := lower(btrim(coalesce(p_utm_medium, '')));
  ref text := upper(btrim(coalesce(p_ref, ''))); host text := lower(btrim(coalesce(p_referrer, '')));
begin
  host := regexp_replace(host, '^(www|m|mobile|l|lm)\.', '');
  if src in ('organic_x', 'x_dm', 'creator_affiliate', 'linkedin', 'search', 'direct', 'referral', 'other') then return src; end if;
  if ref <> '' then
    if exists (select 1 from public.affiliate_accounts where upper(code) = ref)
       or exists (select 1 from public.affiliate_campaigns where upper(code) = ref) then
      return 'creator_affiliate';
    end if;
    return 'referral';
  end if;
  if med in ('cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'ads', 'display') then return 'other'; end if;
  if src in ('x', 'twitter', 't.co', 'x.com', 'twitter.com') then
    return case when med in ('dm', 'dms', 'direct_message', 'message', 'messages') then 'x_dm' else 'organic_x' end;
  end if;
  if src in ('linkedin', 'lnkd', 'linkedin.com', 'lnkd.in') then return 'linkedin'; end if;
  if src in ('google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave', 'kagi', 'yandex', 'baidu') or med = 'organic' then return 'search'; end if;
  if src <> '' then return 'other'; end if;
  if host = '' or host ~ '(^|\.)edgedesksports\.com$' or host in ('localhost', '127.0.0.1') or host ~ '(^|\.)stripe\.com$' then return 'direct'; end if;
  if host in ('t.co', 'x.com', 'twitter.com') then return 'organic_x'; end if;
  if host ~ '(^|\.)linkedin\.com$' or host = 'lnkd.in' then return 'linkedin'; end if;
  if host ~ '(^|\.)google\.[a-z.]+$' or host ~ '(^|\.)yandex\.[a-z.]+$'
     or host in ('bing.com', 'duckduckgo.com', 'search.yahoo.com', 'yahoo.com', 'ecosia.org', 'search.brave.com', 'kagi.com', 'baidu.com') then
    return 'search';
  end if;
  return 'referral';
end $$;
revoke all on function public.acq_classify(text, text, text, text) from public, anon, authenticated;

-- A touch as the server keeps it: cleaned, classified, timed. p is what a
-- page sends ({ref, utm_source, utm_medium, utm_campaign, referrer_host,
-- landing, seen_at}); a missing or future time becomes p_default_at.
create or replace function public.acq_touch(p jsonb, p_default_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t jsonb; at timestamptz;
begin
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  begin at := nullif(p ->> 'seen_at', '')::timestamptz; exception when others then at := null; end;
  if at is null or at > now() + interval '5 minutes' or at < now() - interval '400 days' then at := p_default_at; end if;
  t := jsonb_build_object(
    'ref',          nullif(left(regexp_replace(lower(coalesce(p ->> 'ref', '')), '[^a-z0-9_-]', '', 'g'), 32), ''),
    'utm_source',   nullif(left(regexp_replace(lower(coalesce(p ->> 'utm_source', '')), '[^a-z0-9_.-]', '', 'g'), 64), ''),
    'utm_medium',   nullif(left(regexp_replace(lower(coalesce(p ->> 'utm_medium', '')), '[^a-z0-9_.-]', '', 'g'), 64), ''),
    'utm_campaign', nullif(left(regexp_replace(lower(coalesce(p ->> 'utm_campaign', '')), '[^a-z0-9_.-]', '', 'g'), 64), ''),
    'referrer_host',nullif(left(regexp_replace(lower(coalesce(p ->> 'referrer_host', p ->> 'referrer', '')), '[^a-z0-9._-]', '', 'g'), 120), ''),
    'landing',      nullif(left(regexp_replace(coalesce(p ->> 'landing', ''), '[^A-Za-z0-9/_.-]', '', 'g'), 120), ''),
    'seen_at',      at);
  return t || jsonb_build_object('source', public.acq_classify(t ->> 'ref', t ->> 'utm_source', t ->> 'utm_medium', t ->> 'referrer_host'));
end $$;
revoke all on function public.acq_touch(jsonb, timestamptz) from public, anon, authenticated;

create table if not exists public.acquisition_visitors (
  visitor_hash          text primary key,
  first_source          text not null,
  first_ref             text,
  first_utm_source      text,
  first_utm_medium      text,
  first_utm_campaign    text,
  first_referrer_host   text,
  first_landing         text,
  first_seen_at         timestamptz not null,
  direct_first_seen_at  timestamptz,
  last_source           text not null,
  last_ref              text,
  last_utm_source       text,
  last_utm_medium       text,
  last_utm_campaign     text,
  last_referrer_host    text,
  last_landing          text,
  last_seen_at          timestamptz not null,
  last_visit_at         timestamptz not null default now(),
  touches               int not null default 1,
  user_id               uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create table if not exists public.user_acquisition (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  visitor_hash          text,
  signup_at             timestamptz,
  first_source          text not null,
  first_ref             text,
  first_utm_source      text,
  first_utm_medium      text,
  first_utm_campaign    text,
  first_referrer_host   text,
  first_landing         text,
  first_seen_at         timestamptz,
  last_source           text not null,
  last_ref              text,
  last_utm_source       text,
  last_utm_medium       text,
  last_utm_campaign     text,
  last_referrer_host    text,
  last_landing          text,
  last_seen_at          timestamptz,
  claimed_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'acquisition_visitors_sources') then
    alter table public.acquisition_visitors add constraint acquisition_visitors_sources check (
          first_source in ('organic_x','x_dm','creator_affiliate','linkedin','search','direct','referral','other')
      and last_source  in ('organic_x','x_dm','creator_affiliate','linkedin','search','direct','referral','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_acquisition_sources') then
    alter table public.user_acquisition add constraint user_acquisition_sources check (
          first_source in ('organic_x','x_dm','creator_affiliate','linkedin','search','direct','referral','other')
      and last_source  in ('organic_x','x_dm','creator_affiliate','linkedin','search','direct','referral','other'));
  end if;
end $c$;
create index if not exists acquisition_visitors_first_idx on public.acquisition_visitors (first_seen_at);
create index if not exists acquisition_visitors_user_idx on public.acquisition_visitors (user_id) where user_id is not null;
alter table public.acquisition_visitors enable row level security;
alter table public.user_acquisition enable row level security;
revoke all on public.acquisition_visitors from anon, authenticated;
revoke all on public.user_acquisition from anon, authenticated;

-- FIRST TOUCH IS WRITE-ONCE: a direct placeholder may become the first
-- attributable touch, once; after that nobody changes it.
create or replace function public.user_acquisition_guard()
returns trigger language plpgsql as $$
begin
  if old.first_source <> 'direct'
     and (new.first_source, new.first_ref, new.first_utm_source, new.first_utm_medium, new.first_utm_campaign,
          new.first_referrer_host, new.first_landing, new.first_seen_at)
         is distinct from
         (old.first_source, old.first_ref, old.first_utm_source, old.first_utm_medium, old.first_utm_campaign,
          old.first_referrer_host, old.first_landing, old.first_seen_at) then
    raise exception 'user_acquisition: the first touch is write-once' using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists user_acquisition_guard_trg on public.user_acquisition;
create trigger user_acquisition_guard_trg before update on public.user_acquisition
  for each row execute function public.user_acquisition_guard();

-- A VISIT, from any public page, without an account. One row per visitor;
-- only a hash of the page's random visitor id is kept.
create or replace function public.acq_track_visit(p_visitor text, p_touch jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hash text; t jsonb; v public.acquisition_visitors%rowtype; v_new int;
begin
  if p_visitor is null or p_visitor !~ '^[A-Za-z0-9_-]{16,64}$' then return jsonb_build_object('ok', false); end if;
  v_hash := md5('edgedesk-acq:' || p_visitor);
  t := public.acq_touch(coalesce(p_touch, '{}'::jsonb) - 'seen_at', now());
  select * into v from public.acquisition_visitors where visitor_hash = v_hash for update;
  if not found then
    -- a flood of new visitor ids is capped rather than stored without limit
    select count(*) into v_new from public.acquisition_visitors where created_at > now() - interval '1 day';
    if v_new >= 200000 then return jsonb_build_object('ok', true, 'capped', true); end if;
    insert into public.acquisition_visitors (visitor_hash, first_source, first_ref, first_utm_source, first_utm_medium, first_utm_campaign,
      first_referrer_host, first_landing, first_seen_at, last_source, last_ref, last_utm_source, last_utm_medium, last_utm_campaign,
      last_referrer_host, last_landing, last_seen_at)
    values (v_hash, t ->> 'source', t ->> 'ref', t ->> 'utm_source', t ->> 'utm_medium', t ->> 'utm_campaign', t ->> 'referrer_host',
      t ->> 'landing', (t ->> 'seen_at')::timestamptz, t ->> 'source', t ->> 'ref', t ->> 'utm_source', t ->> 'utm_medium',
      t ->> 'utm_campaign', t ->> 'referrer_host', t ->> 'landing', (t ->> 'seen_at')::timestamptz)
    on conflict (visitor_hash) do nothing;
    return jsonb_build_object('ok', true);
  end if;
  if t ->> 'source' = 'direct' then
    update public.acquisition_visitors set last_visit_at = now(), touches = least(touches + 1, 1000000) where visitor_hash = v_hash;
    return jsonb_build_object('ok', true);
  end if;
  update public.acquisition_visitors set
    first_source        = case when v.first_source = 'direct' then t ->> 'source' else first_source end,
    first_ref           = case when v.first_source = 'direct' then t ->> 'ref' else first_ref end,
    first_utm_source    = case when v.first_source = 'direct' then t ->> 'utm_source' else first_utm_source end,
    first_utm_medium    = case when v.first_source = 'direct' then t ->> 'utm_medium' else first_utm_medium end,
    first_utm_campaign  = case when v.first_source = 'direct' then t ->> 'utm_campaign' else first_utm_campaign end,
    first_referrer_host = case when v.first_source = 'direct' then t ->> 'referrer_host' else first_referrer_host end,
    first_landing       = case when v.first_source = 'direct' then t ->> 'landing' else first_landing end,
    direct_first_seen_at= case when v.first_source = 'direct' then v.first_seen_at else direct_first_seen_at end,
    first_seen_at       = case when v.first_source = 'direct' then (t ->> 'seen_at')::timestamptz else first_seen_at end,
    last_source = t ->> 'source', last_ref = t ->> 'ref', last_utm_source = t ->> 'utm_source', last_utm_medium = t ->> 'utm_medium',
    last_utm_campaign = t ->> 'utm_campaign', last_referrer_host = t ->> 'referrer_host', last_landing = t ->> 'landing',
    last_seen_at = (t ->> 'seen_at')::timestamptz, last_visit_at = now(), touches = least(touches + 1, 1000000)
  where visitor_hash = v_hash;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.acq_track_visit(text, jsonb) from public;
grant execute on function public.acq_track_visit(text, jsonb) to anon, authenticated;

-- AN ACCOUNT CLAIMS ITS TOUCHES, once signed in. The candidates are the
-- visitor row's touches and the ones the page kept in first-party storage;
-- only touches made up to an hour after the account was created count
-- (acquisition is what brought the account, not what it did afterwards).
--   first = the earliest attributable candidate, else direct; write-once
--           (a direct first touch is upgraded once, then frozen)
--   last  = the latest attributable candidate, kept separately
-- It writes nothing to the affiliate ledger. Returns ok, nothing else.
create or replace function public.acq_claim(p_visitor text default null, p_first jsonb default null, p_last jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_created timestamptz; v_horizon timestamptz; v_hash text; v public.acquisition_visitors%rowtype;
  cands jsonb := '[]'::jsonb; c jsonb; f jsonb; l jsonb; cur public.user_acquisition%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select created_at into v_created from auth.users where id = v_uid;
  v_created := coalesce(v_created, now());
  v_horizon := v_created + interval '1 hour';
  if p_visitor is not null and p_visitor ~ '^[A-Za-z0-9_-]{16,64}$' then
    v_hash := md5('edgedesk-acq:' || p_visitor);
    select * into v from public.acquisition_visitors where visitor_hash = v_hash;
    if found then
      cands := cands || jsonb_build_array(
        jsonb_build_object('source', v.first_source, 'ref', v.first_ref, 'utm_source', v.first_utm_source, 'utm_medium', v.first_utm_medium,
          'utm_campaign', v.first_utm_campaign, 'referrer_host', v.first_referrer_host, 'landing', v.first_landing, 'seen_at', v.first_seen_at),
        jsonb_build_object('source', v.last_source, 'ref', v.last_ref, 'utm_source', v.last_utm_source, 'utm_medium', v.last_utm_medium,
          'utm_campaign', v.last_utm_campaign, 'referrer_host', v.last_referrer_host, 'landing', v.last_landing, 'seen_at', v.last_seen_at));
      if v.direct_first_seen_at is not null then
        cands := cands || jsonb_build_array(jsonb_build_object('source', 'direct', 'seen_at', v.direct_first_seen_at));
      end if;
      update public.acquisition_visitors set user_id = v_uid where visitor_hash = v_hash and user_id is null;
    end if;
  end if;
  if p_first is not null and jsonb_typeof(p_first) = 'object' then cands := cands || jsonb_build_array(public.acq_touch(p_first, v_created)); end if;
  if p_last is not null and jsonb_typeof(p_last) = 'object' then cands := cands || jsonb_build_array(public.acq_touch(p_last, v_created)); end if;

  select x into f from jsonb_array_elements(cands) x
   where x ->> 'source' <> 'direct' and (x ->> 'seen_at')::timestamptz <= v_horizon
   order by (x ->> 'seen_at')::timestamptz asc limit 1;
  select x into l from jsonb_array_elements(cands) x
   where x ->> 'source' <> 'direct' and (x ->> 'seen_at')::timestamptz <= v_horizon
   order by (x ->> 'seen_at')::timestamptz desc limit 1;
  if f is null then
    select x into f from jsonb_array_elements(cands) x
     where (x ->> 'seen_at')::timestamptz <= v_horizon order by (x ->> 'seen_at')::timestamptz asc limit 1;
    f := jsonb_build_object('source', 'direct', 'seen_at', coalesce(f ->> 'seen_at', v_created::text));
  end if;
  l := coalesce(l, f);

  select * into cur from public.user_acquisition where user_id = v_uid for update;
  if not found then
    insert into public.user_acquisition (user_id, visitor_hash, signup_at, first_source, first_ref, first_utm_source, first_utm_medium,
      first_utm_campaign, first_referrer_host, first_landing, first_seen_at, last_source, last_ref, last_utm_source, last_utm_medium,
      last_utm_campaign, last_referrer_host, last_landing, last_seen_at)
    values (v_uid, v_hash, v_created, f ->> 'source', f ->> 'ref', f ->> 'utm_source', f ->> 'utm_medium', f ->> 'utm_campaign',
      f ->> 'referrer_host', f ->> 'landing', (f ->> 'seen_at')::timestamptz, l ->> 'source', l ->> 'ref', l ->> 'utm_source',
      l ->> 'utm_medium', l ->> 'utm_campaign', l ->> 'referrer_host', l ->> 'landing', (l ->> 'seen_at')::timestamptz)
    on conflict (user_id) do nothing;
    return jsonb_build_object('ok', true);
  end if;
  if cur.first_source = 'direct' and f ->> 'source' <> 'direct' then
    update public.user_acquisition set first_source = f ->> 'source', first_ref = f ->> 'ref', first_utm_source = f ->> 'utm_source',
      first_utm_medium = f ->> 'utm_medium', first_utm_campaign = f ->> 'utm_campaign', first_referrer_host = f ->> 'referrer_host',
      first_landing = f ->> 'landing', first_seen_at = (f ->> 'seen_at')::timestamptz
     where user_id = v_uid;
  end if;
  if l ->> 'source' <> 'direct' and (cur.last_seen_at is null or (l ->> 'seen_at')::timestamptz > cur.last_seen_at or cur.last_source = 'direct') then
    update public.user_acquisition set last_source = l ->> 'source', last_ref = l ->> 'ref', last_utm_source = l ->> 'utm_source',
      last_utm_medium = l ->> 'utm_medium', last_utm_campaign = l ->> 'utm_campaign', last_referrer_host = l ->> 'referrer_host',
      last_landing = l ->> 'landing', last_seen_at = (l ->> 'seen_at')::timestamptz
     where user_id = v_uid;
  end if;
  update public.user_acquisition set visitor_hash = coalesce(visitor_hash, v_hash) where user_id = v_uid;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.acq_claim(text, jsonb, jsonb) from public, anon;
grant execute on function public.acq_claim(text, jsonb, jsonb) to authenticated;

-- ── 7. what each account did in Stripe ───────────────────────────────────────
-- Trial start, first payment and paid-invoice count per account, read from
-- the webhook's ledger (the WHOLE event, whichever shape it was stored in) and
-- the subscription row. Nothing is estimated: an account with no trial event
-- and no trialing row did not start a trial as far as EdgeDesk can prove.
create or replace function public.growth_customer_facts()
returns table (user_id uuid, signup_at timestamptz, trial_started_at timestamptz, paid_at timestamptz, paid_invoices int,
               sub_status text, price_id text)
language sql stable security definer set search_path = public, pg_temp as $$
  with ev as (
    select e.type, coalesce(e.stripe_created, e.created_at) as at, public.affiliate_stripe_object(e.payload) as o,
           e.user_id as uid0, e.customer_id, e.subscription_id
      from public.stripe_events e
     where e.type in ('customer.subscription.created', 'customer.subscription.updated', 'invoice.payment_succeeded', 'invoice.paid')
  ), ev2 as (
    select ev.*, coalesce(ev.uid0,
             (select s.user_id from public.subscriptions s
               where s.stripe_subscription_id = coalesce(ev.subscription_id, public.affiliate_stripe_id(ev.o -> 'subscription'),
                       public.affiliate_stripe_id(ev.o -> 'parent' -> 'subscription_details' -> 'subscription'),
                       case when ev.type like 'customer.subscription.%' then ev.o ->> 'id' end) limit 1),
             (select s.user_id from public.subscriptions s
               where s.stripe_customer_id = coalesce(ev.customer_id, public.affiliate_stripe_id(ev.o -> 'customer')) limit 1)) as uid
      from ev
  ), trials as (
    select uid, min(case when (o ->> 'trial_start') ~ '^[0-9]+$' then to_timestamp((o ->> 'trial_start')::bigint) else at end) as t
      from ev2
     where uid is not null and type like 'customer.subscription.%'
       and (o ->> 'status' = 'trialing' or (o ->> 'trial_start') ~ '^[0-9]+$')
     group by uid
  ), paid as (
    select uid, min(at) as t, count(distinct o ->> 'id')::int as n
      from ev2
     where uid is not null and type in ('invoice.payment_succeeded', 'invoice.paid')
       and (o ->> 'amount_paid') ~ '^[0-9]+$' and (o ->> 'amount_paid')::bigint > 0
     group by uid
  )
  select u.id, u.created_at,
         coalesce(t.t, case when s.status = 'trialing' and coalesce(s.price_id, '') <> 'owner_comp' then s.created_at end),
         p.t, coalesce(p.n, 0), s.status, s.price_id
    from auth.users u
    left join trials t on t.uid = u.id
    left join paid p on p.uid = u.id
    left join public.subscriptions s on s.user_id = u.id;
$$;
revoke all on function public.growth_customer_facts() from public, anon, authenticated;

-- ── 8. the admin's reports ───────────────────────────────────────────────────
-- ACTIVATION, for trials started in the last p_days. An ACTIVATED trial
-- reached ACTIVATED inside its trial (trial_days, plus a day's grace).
create or replace function public.growth_admin_activation(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.activation_settings%rowtype; d int := greatest(1, least(coalesce(p_days, 90), 730)); out jsonb;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  select * into s from public.activation_settings where id = 1;
  with f as (
    select g.*, ua.state, ua.activated_at, ua.power_user_at, ua.points,
           (ua.activated_at is not null and ua.activated_at <= g.trial_started_at + make_interval(days => s.trial_days + 1)) as act_in_trial
      from public.growth_customer_facts() g
      left join public.user_activation ua on ua.user_id = g.user_id
     where g.trial_started_at >= now() - make_interval(days => d)
  ), k as (
    select count(*)::int as trials,
           count(*) filter (where act_in_trial)::int as activated,
           count(*) filter (where activated_at is not null)::int as activated_ever,
           count(*) filter (where paid_at is not null)::int as paid,
           count(*) filter (where act_in_trial and paid_at is not null)::int as activated_paid,
           count(*) filter (where not act_in_trial and paid_at is not null)::int as other_paid,
           percentile_cont(0.5) within group (order by greatest(0, extract(epoch from activated_at - trial_started_at) / 3600))
             filter (where act_in_trial) as tta_median_h,
           percentile_cont(0.75) within group (order by greatest(0, extract(epoch from activated_at - trial_started_at) / 3600))
             filter (where act_in_trial) as tta_p75_h
      from f
  )
  select jsonb_build_object(
    'as_of', now(), 'window_days', d,
    'trials', k.trials, 'activated_trials', k.activated, 'activated_ever', k.activated_ever,
    'activation_rate', case when k.trials > 0 then round(k.activated::numeric / k.trials, 4) end,
    'paid_conversions', k.paid,
    'trial_to_paid_rate', case when k.trials > 0 then round(k.paid::numeric / k.trials, 4) end,
    'activated_paid', k.activated_paid,
    'activated_to_paid_rate', case when k.activated > 0 then round(k.activated_paid::numeric / k.activated, 4) end,
    'not_activated_paid', k.other_paid,
    'not_activated_to_paid_rate', case when k.trials - k.activated > 0 then round(k.other_paid::numeric / (k.trials - k.activated), 4) end,
    'time_to_activation_hours', jsonb_build_object('median', round(k.tta_median_h::numeric, 1), 'p75', round(k.tta_p75_h::numeric, 1), 'n', k.activated),
    'states', (select jsonb_object_agg(st, n) from (
                 select x.st, (select count(*) from f where coalesce(f.state, 'NOT_ACTIVATED') = x.st)::int as n
                   from unnest(array['NOT_ACTIVATED','EXPLORING','ACTIVATED','POWER_USER']) x(st)) q),
    'actions', (select coalesce(jsonb_object_agg(kd, n), '{}'::jsonb) from (
                  select x.kd, (select count(distinct e.user_id) from public.activation_events e join f on f.user_id = e.user_id
                                  where e.kind = x.kd)::int as n
                    from unnest(public.growth_kinds()) x(kd)) q),
    'cohorts', (select coalesce(jsonb_agg(c order by c ->> 'week'), '[]'::jsonb) from (
                  select jsonb_build_object('week', to_char(date_trunc('week', trial_started_at), 'YYYY-MM-DD'),
                           'trials', count(*), 'activated', count(*) filter (where act_in_trial), 'paid', count(*) filter (where paid_at is not null)) c
                    from f group by date_trunc('week', trial_started_at)) q),
    'settings', to_jsonb(s) - 'updated_by')
    into out from k;
  return out;
end $$;
revoke all on function public.growth_admin_activation(int) from public, anon;
grant execute on function public.growth_admin_activation(int) to authenticated;

-- THE FUNNEL by source: visitor -> account -> trial -> activated trial ->
-- paid -> retained, for visitors first seen and accounts created in the last
-- p_days. p_touch 'first' (default) or 'last'. RETAINED = at least
-- retained_min_paid_invoices paid invoices, i.e. renewed at least once.
-- creator_credited counts accounts the AFFILIATE LEDGER credits to a creator,
-- whatever their acquisition source: the two measurements are shown side by
-- side and neither overwrites the other.
create or replace function public.growth_admin_funnel(p_days int default 90, p_touch text default 'first')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.activation_settings%rowtype; d int := greatest(1, least(coalesce(p_days, 90), 730)); v_last boolean := p_touch = 'last'; out jsonb;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  select * into s from public.activation_settings where id = 1;
  with src(source, ord) as (
    select * from unnest(array['organic_x','x_dm','creator_affiliate','linkedin','search','direct','referral','other','(untracked)'])
      with ordinality
  ), vis as (
    select case when v_last then last_source else first_source end as source, count(*)::int as n
      from public.acquisition_visitors where first_seen_at >= now() - make_interval(days => d) group by 1
  ), acc as (
    select coalesce(case when v_last then ua.last_source else ua.first_source end, '(untracked)') as source, g.*,
           (u.activated_at is not null and g.trial_started_at is not null
             and u.activated_at <= g.trial_started_at + make_interval(days => s.trial_days + 1)) as act_in_trial,
           exists (select 1 from public.affiliate_attributions a where a.user_id = g.user_id and a.status = 'active') as credited
      from public.growth_customer_facts() g
      left join public.user_acquisition ua on ua.user_id = g.user_id
      left join public.user_activation u on u.user_id = g.user_id
     where g.signup_at >= now() - make_interval(days => d)
  ), fr as (
    select src.source, src.ord,
           coalesce((select n from vis where vis.source = src.source), 0) as visitors,
           (select count(*) from acc where acc.source = src.source)::int as signups,
           (select count(*) from acc where acc.source = src.source and trial_started_at is not null)::int as trials,
           (select count(*) from acc where acc.source = src.source and act_in_trial)::int as activated_trials,
           (select count(*) from acc where acc.source = src.source and paid_at is not null)::int as paid,
           (select count(*) from acc where acc.source = src.source and paid_invoices >= s.retained_min_paid_invoices)::int as retained,
           (select count(*) from acc where acc.source = src.source and credited)::int as creator_credited
      from src
  )
  select jsonb_build_object('as_of', now(), 'window_days', d, 'touch', case when v_last then 'last' else 'first' end,
    'retained_rule', 'at least ' || s.retained_min_paid_invoices || ' paid invoices',
    'rows', (select jsonb_agg(to_jsonb(r) - 'ord' order by r.ord) from fr r),
    'totals', (select jsonb_build_object('visitors', sum(visitors), 'signups', sum(signups), 'trials', sum(trials),
                 'activated_trials', sum(activated_trials), 'paid', sum(paid), 'retained', sum(retained), 'creator_credited', sum(creator_credited))
                 from fr))
    into out;
  return out;
end $$;
revoke all on function public.growth_admin_funnel(int, text) from public, anon;
grant execute on function public.growth_admin_funnel(int, text) to authenticated;

-- every reader's state, replayed under the settings now in force
create or replace function public.growth_recompute_all()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select distinct user_id from public.activation_events loop
    perform public.activation_compute(r.user_id); n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.growth_recompute_all() from public, anon, authenticated;

create or replace function public.growth_admin_update_activation_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text; n int;
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  begin
    update public.activation_settings set
      weights = coalesce(p -> 'weights', weights),
      per_kind_cap = coalesce((p ->> 'per_kind_cap')::int, per_kind_cap),
      exploring_min_points = coalesce((p ->> 'exploring_min_points')::numeric, exploring_min_points),
      activated_min_points = coalesce((p ->> 'activated_min_points')::numeric, activated_min_points),
      activated_min_kinds = coalesce((p ->> 'activated_min_kinds')::int, activated_min_kinds),
      activated_min_active_days = coalesce((p ->> 'activated_min_active_days')::int, activated_min_active_days),
      activated_requires_core = coalesce((p ->> 'activated_requires_core')::boolean, activated_requires_core),
      core_kinds = case when jsonb_typeof(p -> 'core_kinds') = 'array'
                        then coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'core_kinds') x), '{}'::text[])
                        else core_kinds end,
      power_min_points = coalesce((p ->> 'power_min_points')::numeric, power_min_points),
      power_min_kinds = coalesce((p ->> 'power_min_kinds')::int, power_min_kinds),
      power_min_active_days = coalesce((p ->> 'power_min_active_days')::int, power_min_active_days),
      trial_days = coalesce((p ->> 'trial_days')::int, trial_days),
      retained_min_paid_invoices = coalesce((p ->> 'retained_min_paid_invoices')::int, retained_min_paid_invoices),
      updated_at = now(), updated_by = auth.uid()
    where id = 1;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range or datatype_mismatch then
    get stacked diagnostics v_msg = message_text;
    return jsonb_build_object('ok', false, 'reason', 'invalid_settings', 'detail', left(v_msg, 300));
  end;
  n := public.growth_recompute_all();
  return jsonb_build_object('ok', true, 'recomputed', n, 'settings', (select to_jsonb(s) - 'updated_by' from public.activation_settings s where id = 1));
end $$;
revoke all on function public.growth_admin_update_activation_settings(jsonb) from public, anon;
grant execute on function public.growth_admin_update_activation_settings(jsonb) to authenticated;

-- ── 9. public sample research ────────────────────────────────────────────────
create table if not exists public.public_sample_games (
  game_key    text primary key,
  enabled     boolean not null default true,
  note        text,
  expires_at  timestamptz,
  added_at    timestamptz not null default now(),
  added_by    uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'public_sample_games_shape') then
    alter table public.public_sample_games add constraint public_sample_games_shape check (
          game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$'
      and (note is null or length(note) <= 300));
  end if;
end $c$;
alter table public.public_sample_games enable row level security;
revoke all on public.public_sample_games from anon, authenticated;

-- THE PUBLIC SUBSET of one game's research state: the fair line, the market
-- it was compared to, the gap, reliability, the key reason, at most three of
-- the engine's measured drivers, quarterback confirmation and availability
-- COUNTS. Win probability, the research-priority rank, the full driver list,
-- line movement, warnings and everything personal stay behind the account;
-- `locked` names them so the page can say so rather than pretend they do not
-- exist. Only for a game the admin made public.
create or replace function public.public_sample_research(p_game_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.public_sample_games%rowtype; r public.game_research_state%rowtype; st jsonb;
begin
  select * into g from public.public_sample_games where game_key = p_game_key;
  if not found or not g.enabled or (g.expires_at is not null and g.expires_at <= now()) then
    return jsonb_build_object('ok', false, 'reason', 'not_public');
  end if;
  select * into r from public.game_research_state where game_key = p_game_key;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_research_state'); end if;
  st := r.state;
  return jsonb_build_object('ok', true, 'game_key', r.game_key, 'sport', r.sport, 'home', r.home, 'away', r.away,
    'kickoff_at', r.kickoff_at, 'started', r.kickoff_at is not null and r.kickoff_at <= now(),
    'computed_at', r.computed_at, 'model_version', r.model_version,
    'fair', jsonb_build_object('home_line', r.fair_home_line, 'text', st -> 'fair' ->> 'text', 'total', r.fair_total),
    'market', jsonb_build_object('home_line', r.market_home_line, 'text', st -> 'market' ->> 'text', 'total', r.market_total,
      'kind', r.market_kind, 'book', r.market_book, 'captured_at', r.market_captured_at, 'stale', r.market_stale,
      'books', st -> 'market' -> 'books'),
    'gap', jsonb_build_object('points', r.gap_pts, 'toward', st -> 'gap' ->> 'toward'),
    'reliability', jsonb_build_object('score', r.reliability_score, 'grade', r.reliability_grade,
      'scored', coalesce((st -> 'reliability' ->> 'scored')::boolean, false),
      'main_deduction', st -> 'reliability' ->> 'main_deduction', 'note', st -> 'reliability' ->> 'note'),
    'research_label', r.research_label, 'research_grade', r.research_grade, 'key_reason', r.key_reason,
    'drivers', (select coalesce(jsonb_agg(jsonb_build_object('text', x.d ->> 'text', 'points', x.d -> 'points') order by x.i), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(st -> 'drivers') = 'array' then st -> 'drivers' else '[]'::jsonb end)
                       with ordinality x(d, i) where x.i <= 3),
    'qb', jsonb_build_object(
      'home', jsonb_build_object('name', st -> 'qb' -> 'home' ->> 'name', 'confirmed', st -> 'qb' -> 'home' -> 'confirmed'),
      'away', jsonb_build_object('name', st -> 'qb' -> 'away' ->> 'name', 'confirmed', st -> 'qb' -> 'away' -> 'confirmed'),
      'confirmed_both', st -> 'qb' -> 'confirmed_both'),
    'availability', jsonb_build_object(
      'home', jsonb_build_object('known', st -> 'injuries' -> 'home' -> 'known',
        'out', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'home' -> 'out') = 'array' then st -> 'injuries' -> 'home' -> 'out' else '[]'::jsonb end),
        'doubtful', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'home' -> 'doubtful') = 'array' then st -> 'injuries' -> 'home' -> 'doubtful' else '[]'::jsonb end),
        'questionable', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'home' -> 'questionable') = 'array' then st -> 'injuries' -> 'home' -> 'questionable' else '[]'::jsonb end)),
      'away', jsonb_build_object('known', st -> 'injuries' -> 'away' -> 'known',
        'out', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'away' -> 'out') = 'array' then st -> 'injuries' -> 'away' -> 'out' else '[]'::jsonb end),
        'doubtful', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'away' -> 'doubtful') = 'array' then st -> 'injuries' -> 'away' -> 'doubtful' else '[]'::jsonb end),
        'questionable', jsonb_array_length(case when jsonb_typeof(st -> 'injuries' -> 'away' -> 'questionable') = 'array' then st -> 'injuries' -> 'away' -> 'questionable' else '[]'::jsonb end))),
    'locked', jsonb_build_array('win probability', 'the research-priority ranking and why', 'the full driver breakdown',
      'line movement since the open', 'the rest of the board', 'watchlist, alerts and journal', 'the AI research desk'));
end $$;
revoke all on function public.public_sample_research(text) from public;
grant execute on function public.public_sample_research(text) to anon, authenticated;

create or replace function public.public_sample_list()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('game_key', r.game_key, 'sport', r.sport, 'home', r.home, 'away', r.away,
           'kickoff_at', r.kickoff_at, 'fair_text', r.state -> 'fair' ->> 'text', 'fair_home_line', r.fair_home_line,
           'market_text', r.state -> 'market' ->> 'text', 'market_home_line', r.market_home_line, 'gap_pts', r.gap_pts,
           'reliability_score', r.reliability_score, 'computed_at', r.computed_at) order by r.kickoff_at), '[]'::jsonb)
    from public.public_sample_games g join public.game_research_state r on r.game_key = g.game_key
   where g.enabled and (g.expires_at is null or g.expires_at > now()) and (r.kickoff_at is null or r.kickoff_at > now() - interval '1 day');
$$;
revoke all on function public.public_sample_list() from public;
grant execute on function public.public_sample_list() to anon, authenticated;

create or replace function public.growth_admin_samples()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'samples', (select coalesce(jsonb_agg(jsonb_build_object('game_key', g.game_key, 'enabled', g.enabled, 'note', g.note, 'expires_at', g.expires_at,
                  'added_at', g.added_at, 'home', r.home, 'away', r.away, 'kickoff_at', r.kickoff_at, 'fair_text', r.state -> 'fair' ->> 'text',
                  'market_text', r.state -> 'market' ->> 'text', 'gap_pts', r.gap_pts, 'reliability_score', r.reliability_score,
                  'computed_at', r.computed_at, 'has_state', r.game_key is not null) order by g.added_at desc), '[]'::jsonb)
                  from public.public_sample_games g left join public.game_research_state r on r.game_key = g.game_key),
    'candidates', (select coalesce(jsonb_agg(jsonb_build_object('game_key', r.game_key, 'sport', r.sport, 'home', r.home, 'away', r.away,
                  'kickoff_at', r.kickoff_at, 'fair_text', r.state -> 'fair' ->> 'text', 'market_text', r.state -> 'market' ->> 'text',
                  'gap_pts', r.gap_pts, 'reliability_score', r.reliability_score, 'research_grade', r.research_grade,
                  'priority_rank', r.priority_rank) order by r.research_grade desc, r.priority_rank nulls last, r.kickoff_at), '[]'::jsonb)
                  from (select * from public.game_research_state r0
                         where r0.projected and r0.kickoff_at > now()
                           and not exists (select 1 from public.public_sample_games g where g.game_key = r0.game_key and g.enabled)
                         order by r0.kickoff_at limit 80) r),
    'as_of', now());
end $$;
revoke all on function public.growth_admin_samples() from public, anon;
grant execute on function public.growth_admin_samples() to authenticated;

create or replace function public.growth_admin_sample_set(p_game_key text, p_enabled boolean, p_note text default null, p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.growth_is_admin() then raise exception 'not an admin' using errcode = 'insufficient_privilege'; end if;
  if p_game_key is null or p_game_key !~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_game_key');
  end if;
  if p_enabled and not exists (select 1 from public.game_research_state where game_key = p_game_key) then
    return jsonb_build_object('ok', false, 'reason', 'no_research_state_for_that_game');
  end if;
  insert into public.public_sample_games (game_key, enabled, note, expires_at, added_by, updated_by)
  values (p_game_key, p_enabled, nullif(left(btrim(coalesce(p_note, '')), 300), ''), p_expires_at, auth.uid(), auth.uid())
  on conflict (game_key) do update set enabled = excluded.enabled, note = coalesce(excluded.note, public_sample_games.note),
    expires_at = excluded.expires_at, updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true, 'game_key', p_game_key, 'enabled', p_enabled);
end $$;
revoke all on function public.growth_admin_sample_set(text, boolean, text, timestamptz) from public, anon;
grant execute on function public.growth_admin_sample_set(text, boolean, text, timestamptz) to authenticated;

notify pgrst, 'reload schema';

-- ── REPORT ───────────────────────────────────────────────────────────────────
select 1 as step, 'the growth tables exist' as item,
  case when (select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('activation_settings','activation_events','user_activation','acquisition_visitors','user_acquisition','public_sample_games')) = 6
       then 'ok' else 'CHECK THIS — a table is missing' end as outcome
union all
select 2, 'row level security is on everywhere and no client reads a growth table directly',
  case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in
    ('activation_settings','activation_events','user_activation','acquisition_visitors','user_acquisition','public_sample_games')) = 6
        and not has_table_privilege('authenticated', 'public.user_activation', 'select')
        and not has_table_privilege('authenticated', 'public.activation_events', 'select')
        and not has_table_privilege('anon', 'public.acquisition_visitors', 'select') then 'ok' else 'CHECK THIS' end
union all
select 3, 'the activation thresholds live in one settings row (activated at '
  || (select activated_min_points::text from public.activation_settings where id = 1) || ' points)',
  case when exists (select 1 from public.activation_settings where id = 1) then 'ok' else 'CHECK THIS' end
union all
select 4, 'watchlist, journal, alert and share-card actions are recorded by trigger',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in
    ('growth_watchlist_trg','growth_journal_trg','growth_alert_prefs_trg','growth_share_cards_trg')) = 4 then 'ok' else 'CHECK THIS' end
union all
select 5, 'the first touch of an account is write-once',
  case when exists (select 1 from pg_trigger where tgname = 'user_acquisition_guard_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 6, 'visits and public samples are callable without an account; tracking and claims only when signed in',
  case when has_function_privilege('anon', 'public.acq_track_visit(text, jsonb)', 'execute')
        and has_function_privilege('anon', 'public.public_sample_research(text)', 'execute')
        and not has_function_privilege('anon', 'public.edp_track(text, text)', 'execute')
        and not has_function_privilege('anon', 'public.acq_claim(text, jsonb, jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
union all
-- Supabase grants EXECUTE on every new public function to anon directly
select 7, 'no admin or internal function is callable by a signed-out visitor',
  case when not exists (
    select 1 from unnest(array[
      'public.growth_is_admin()', 'public.growth_admin_activation(integer)', 'public.growth_admin_funnel(integer, text)',
      'public.growth_admin_update_activation_settings(jsonb)', 'public.growth_admin_samples()',
      'public.growth_admin_sample_set(text, boolean, text, timestamp with time zone)', 'public.activation_compute(uuid)',
      'public.growth_record(uuid, text, text, text, text)', 'public.growth_customer_facts()', 'public.growth_recompute_all()',
      'public.acq_classify(text, text, text, text)', 'public.acq_touch(jsonb, timestamp with time zone)']) f
    where has_function_privilege('anon', f, 'execute')) then 'ok' else 'CHECK THIS' end
union all
select 8, 'the internal functions are not callable by a signed-in reader either',
  case when not has_function_privilege('authenticated', 'public.activation_compute(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.growth_customer_facts()', 'execute')
        and not has_function_privilege('authenticated', 'public.growth_record(uuid, text, text, text, text)', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 9, 'the operator list is the partner program''s (' || (select count(*) from public.affiliate_admins)::text || ' admin(s))',
  'ok'
union all
select 10, 'earlier watchlist, journal, alert and card actions are on record ('
  || (select count(*) from public.activation_events where source = 'db')::text || ' action(s))',
  case when not exists (select 1 from public.watchlist_games w where coalesce(w.source, 'app') <> 'import'
                          and not exists (select 1 from public.activation_events e where e.user_id = w.user_id and e.kind = 'watchlist_save' and e.dedupe_key = w.game_key))
       then 'ok' else 'CHECK THIS' end
order by 1;
