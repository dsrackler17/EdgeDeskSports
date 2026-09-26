-- =============================================================================
-- personal_research — the reader's own research terminal: preferences, the
-- watchlist, research-condition alerts, the decision journal and the shared
-- slate-level research state they are all measured against.
--
-- WHAT IT IS
--   Until this file, everything personal in EdgeDesk lived in ONE BROWSER:
--   the Desk watchlist (ed_research_watch_v1), the follow timeline
--   (ed_research_follow_v1), the CLV ledger (edgedesk_bets) and every
--   preference (edgedesk_prefs). A second device saw none of it, the research
--   desk (edgedesk_ai) could read none of it, and nothing could notice a
--   change while the page was closed. This file gives each of those a row per
--   reader, under row level security, plus one SHARED table the server fills:
--
--     research_leagues       the leagues a reader can pick (cfb, nfl today;
--                            a new league is a row, not a migration)
--     user_preferences       onboarding answers: leagues, books, interests
--     alert_preferences      research-condition thresholds, all editable
--     watchlist_games        one row per (reader, game), never two
--     game_research_state    the latest research state of every game on the
--                            slate, computed server-side by the SAME football
--                            module the browser runs (tools/personal/
--                            research_state.js boots app.html's module
--                            headlessly). One row per game, shared by every
--                            reader, so nothing slate-level is recomputed per
--                            user. Service role writes; entitled readers read.
--     game_research_history  every DISTINCT state a game has had, appended by
--                            trigger whenever the state hash changes — the
--                            "what changed", the close for CLV, and the
--                            evidence the desk cites
--     user_alerts            the in-app notification centre. One row per
--                            (reader, dedupe key): a condition that is still
--                            true on the next run cannot alert twice
--     research_journal       the decision journal. The information set at
--                            decision time is WRITE-ONCE: a trigger refuses
--                            any change to it, whoever asks, so a journal
--                            entry can never be silently re-read through
--                            today's model. The close and the grade are
--                            written later by the service role only.
--
-- WHAT IT IS NOT
--   Nothing here is a pick, a stake recommendation or a bet placed anywhere.
--   An alert says a RESEARCH CONDITION changed; the copy check below refuses
--   tout language at the database, so a bug in a job cannot publish "LOCK".
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. A reader reads and writes only their own personal rows (RLS on
--      auth.uid()). Nothing in this file takes a user id as an argument.
--   2. One watchlist row per (reader, game): a unique constraint, not a
--      client-side check.
--   3. One alert per (reader, dedupe key): a unique constraint.
--   4. The journal snapshot is write-once (trigger). The close and the grade
--      are writable by the service role only (trigger + column grants), and
--      a client cannot pre-fill them on insert (trigger clears them).
--   5. The shared research state is written by the service role only.
--
-- RUN ORDER. Stands alone. If supabase/community_posts.sql has been run, the
-- shared research state is readable by ENTITLED readers only (the same rule
-- as the paywall, community_is_entitled); otherwise by any signed-in reader,
-- and report row 12 says which one is in force.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- ── re-running this file on a live site ─────────────────────────────────────
-- The SQL editor runs the file as one transaction, and each statement below
-- would take its lock as it reached it and hold it to the end. Saving a journal
-- entry holds research_journal and then reads game_research_state (the insert
-- trigger copies it); this file locks them in the other order, and the two
-- deadlocked (40P01) when the file was re-run.
-- So every lock the file needs is taken here, first, all at once or not at
-- all (NOWAIT, retried for up to 30 seconds): the file never waits while it
-- holds a lock, and what it would have deadlocked with waits a moment instead.
do $locks$
declare
  v_list text;
  v_try int := 0;
begin
  select string_agg(t, ', ') into v_list from unnest(array[
    'public.research_leagues',
    'public.user_preferences',
    'public.alert_preferences',
    'public.watchlist_games',
    'public.game_research_state',
    'public.game_research_history',
    'public.user_alerts',
    'public.research_journal',
    'public.my_watchlist']) t
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

-- ── helpers ──────────────────────────────────────────────────────────────────
-- A text[] whose every element matches a pattern and is at most n long.
-- Immutable, so it can sit inside a CHECK.
create or replace function public.edp_text_array_ok(p text[], p_pattern text, p_max int)
returns boolean language sql immutable as $$
  select p is null or (cardinality(p) <= p_max
    and not exists (select 1 from unnest(p) x where x is null or x !~ p_pattern));
$$;

-- The copy rule, stated once for every table below that stores words a
-- reader will see. Research, not picks: these phrases are never ours.
create or replace function public.edp_copy_ok(p text)
returns boolean language sql immutable as $$
  select p is null or p !~* '(bet this|\mlocks?\M|guarantee|\msmash|must[- ]bet|can''?t lose|best bets?|winning plays?|free money|sure thing)';
$$;

-- The caller's entitlement, read through the paywall's own function when it
-- is installed. Security definer so a policy can call it; it answers only for
-- the uuid it is given and exposes nothing but a boolean.
create or replace function public.edp_entitled(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if p_user is null then return false; end if;
  if to_regprocedure('public.community_is_entitled(uuid)') is null then return true; end if;
  execute 'select public.community_is_entitled($1)' into v using p_user;
  return coalesce(v, false);
end $$;
revoke all on function public.edp_entitled(uuid) from public, anon;
grant execute on function public.edp_entitled(uuid) to authenticated, service_role;

-- ── 1. research_leagues ──────────────────────────────────────────────────────
create table if not exists public.research_leagues (
  key        text primary key check (key ~ '^[a-z0-9]{2,12}$'),
  label      text not null,
  active     boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);
insert into public.research_leagues (key, label, sort_order) values
  ('cfb', 'College Football', 10),
  ('nfl', 'NFL', 20)
on conflict (key) do nothing;
alter table public.research_leagues enable row level security;
drop policy if exists research_leagues_read on public.research_leagues;
create policy research_leagues_read on public.research_leagues for select to anon, authenticated using (true);
revoke insert, update, delete on public.research_leagues from anon, authenticated;
grant select on public.research_leagues to anon, authenticated;

-- ── 2. user_preferences ──────────────────────────────────────────────────────
create table if not exists public.user_preferences (
  user_id                 uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  leagues                 text[] not null default '{}',
  books                   text[] not null default '{}',
  interests               text[] not null default '{}',
  onboarding_status       text not null default 'pending',
  onboarding_completed_at timestamptz,
  onboarding_version      int not null default 1,
  timezone                text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
alter table public.user_preferences add column if not exists leagues                 text[] not null default '{}';
alter table public.user_preferences add column if not exists books                   text[] not null default '{}';
alter table public.user_preferences add column if not exists interests               text[] not null default '{}';
alter table public.user_preferences add column if not exists onboarding_status       text not null default 'pending';
alter table public.user_preferences add column if not exists onboarding_completed_at timestamptz;
alter table public.user_preferences add column if not exists onboarding_version      int not null default 1;
alter table public.user_preferences add column if not exists timezone                text;
alter table public.user_preferences add column if not exists updated_at              timestamptz not null default now();

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_onboarding_status') then
    alter table public.user_preferences add constraint user_prefs_onboarding_status
      check (onboarding_status in ('pending', 'completed', 'skipped'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_books_shape') then
    alter table public.user_preferences add constraint user_prefs_books_shape
      check (public.edp_text_array_ok(books, '^[a-z0-9_]{2,40}$', 40));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_interests_valid') then
    alter table public.user_preferences add constraint user_prefs_interests_valid
      check (interests <@ array['model_vs_market','matchup','line_movement','reliability','clv','ai','all']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_leagues_shape') then
    alter table public.user_preferences add constraint user_prefs_leagues_shape
      check (public.edp_text_array_ok(leagues, '^[a-z0-9]{2,12}$', 12));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_timezone_shape') then
    alter table public.user_preferences add constraint user_prefs_timezone_shape
      check (timezone is null or timezone ~ '^[A-Za-z0-9_+/-]{1,64}$');
  end if;
end $c$;

-- A league must be one the product offers. A trigger rather than a foreign
-- key because the column is an array; adding a league is a row in
-- research_leagues and nothing else.
create or replace function public.user_preferences_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from unnest(new.leagues) l
              where not exists (select 1 from public.research_leagues r where r.key = l and r.active)) then
    raise exception 'user_preferences: unknown league in %', new.leagues using errcode = 'check_violation';
  end if;
  new.leagues := array(select distinct x from unnest(new.leagues) x order by 1);
  new.books := array(select distinct x from unnest(new.books) x order by 1);
  new.interests := array(select distinct x from unnest(new.interests) x order by 1);
  if new.onboarding_status in ('completed', 'skipped') and new.onboarding_completed_at is null then
    new.onboarding_completed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists user_preferences_guard_trg on public.user_preferences;
create trigger user_preferences_guard_trg before insert or update on public.user_preferences
  for each row execute function public.user_preferences_guard();

alter table public.user_preferences enable row level security;
drop policy if exists user_preferences_select_own on public.user_preferences;
create policy user_preferences_select_own on public.user_preferences for select to authenticated using (user_id = auth.uid());
drop policy if exists user_preferences_insert_own on public.user_preferences;
create policy user_preferences_insert_own on public.user_preferences for insert to authenticated with check (user_id = auth.uid());
drop policy if exists user_preferences_update_own on public.user_preferences;
create policy user_preferences_update_own on public.user_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.user_preferences from anon;
grant select, insert, update on public.user_preferences to authenticated;

-- ── 3. alert_preferences ─────────────────────────────────────────────────────
-- Every threshold is the reader's to change. The defaults are the product's
-- existing research thresholds where one exists (the 2-point research gap is
-- lib/research_priority.js RESEARCH_GAP; 80 is the STRONG reliability grade
-- in lib/cfb_reliability.js), and a stated presentation default otherwise.
create table if not exists public.alert_preferences (
  user_id                 uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  enabled                 boolean not null default true,
  scope                   text    not null default 'watchlist',
  reliability_min         numeric not null default 80,
  on_reliability_min      boolean not null default true,
  gap_min_pts             numeric not null default 3,
  on_gap_min              boolean not null default true,
  on_qb_confirmed         boolean not null default true,
  on_injury_change        boolean not null default true,
  market_move_pts         numeric not null default 1,
  on_market_move          boolean not null default true,
  on_key_number           boolean not null default true,
  fair_move_pts           numeric not null default 1,
  on_fair_move            boolean not null default true,
  converge_pts            numeric not null default 1,
  on_converge             boolean not null default true,
  diverge_pts             numeric not null default 1.5,
  on_diverge              boolean not null default true,
  on_research_grade       boolean not null default true,
  reliability_change_pts  numeric not null default 8,
  on_reliability_change   boolean not null default true,
  email_digest            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'alert_prefs_ranges') then
    alter table public.alert_preferences add constraint alert_prefs_ranges check (
          scope in ('watchlist', 'leagues')
      and reliability_min between 0 and 100
      and gap_min_pts between 0.5 and 21
      and market_move_pts between 0.5 and 14
      and fair_move_pts between 0.25 and 14
      and converge_pts between 0 and 7
      and diverge_pts between 0.5 and 14
      and reliability_change_pts between 1 and 50);
  end if;
end $c$;
create or replace function public.alert_preferences_touch()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists alert_preferences_touch_trg on public.alert_preferences;
create trigger alert_preferences_touch_trg before update on public.alert_preferences
  for each row execute function public.alert_preferences_touch();

alter table public.alert_preferences enable row level security;
drop policy if exists alert_preferences_select_own on public.alert_preferences;
create policy alert_preferences_select_own on public.alert_preferences for select to authenticated using (user_id = auth.uid());
drop policy if exists alert_preferences_insert_own on public.alert_preferences;
create policy alert_preferences_insert_own on public.alert_preferences for insert to authenticated with check (user_id = auth.uid());
drop policy if exists alert_preferences_update_own on public.alert_preferences;
create policy alert_preferences_update_own on public.alert_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.alert_preferences from anon;
grant select, insert, update on public.alert_preferences to authenticated;

-- ── 4. watchlist_games ───────────────────────────────────────────────────────
-- game_key is '<league>|<schedule feed id>': 'cfb|401862779' (ESPN id, as the
-- cfbfastR schedule carries it) or 'nfl|2026_04_NYJ_CHI' (nflverse). The same
-- key lib/research_priority.js already orders games by.
create table if not exists public.watchlist_games (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_key     text not null,
  home         text,
  away         text,
  kickoff_at   timestamptz,
  note         text,
  source       text not null default 'app',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  seen_state   jsonb,
  seen_hash    text
);
alter table public.watchlist_games add column if not exists home         text;
alter table public.watchlist_games add column if not exists away         text;
alter table public.watchlist_games add column if not exists kickoff_at   timestamptz;
alter table public.watchlist_games add column if not exists note         text;
alter table public.watchlist_games add column if not exists source       text not null default 'app';
alter table public.watchlist_games add column if not exists last_seen_at timestamptz;
alter table public.watchlist_games add column if not exists seen_state   jsonb;
alter table public.watchlist_games add column if not exists seen_hash    text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'watchlist_games_one_per_game') then
    alter table public.watchlist_games add constraint watchlist_games_one_per_game unique (user_id, game_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'watchlist_games_shape') then
    alter table public.watchlist_games add constraint watchlist_games_shape check (
          game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$'
      and (home is null or length(home) <= 80) and (away is null or length(away) <= 80)
      and (note is null or length(note) <= 500)
      and source in ('app', 'import', 'ai')
      and (seen_state is null or pg_column_size(seen_state) <= 32000)
      and (seen_hash is null or length(seen_hash) <= 80));
  end if;
end $c$;
create index if not exists watchlist_games_game_idx on public.watchlist_games (game_key);
create index if not exists watchlist_games_user_idx on public.watchlist_games (user_id, created_at desc);

-- A watchlist is a short list by nature; a runaway client is refused.
create or replace function public.watchlist_games_cap()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (select count(*) from public.watchlist_games where user_id = new.user_id) >= 200 then
    raise exception 'watchlist_games: a watchlist holds at most 200 games' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists watchlist_games_cap_trg on public.watchlist_games;
create trigger watchlist_games_cap_trg before insert on public.watchlist_games
  for each row execute function public.watchlist_games_cap();

alter table public.watchlist_games enable row level security;
drop policy if exists watchlist_games_select_own on public.watchlist_games;
create policy watchlist_games_select_own on public.watchlist_games for select to authenticated using (user_id = auth.uid());
drop policy if exists watchlist_games_insert_own on public.watchlist_games;
create policy watchlist_games_insert_own on public.watchlist_games for insert to authenticated with check (user_id = auth.uid());
drop policy if exists watchlist_games_update_own on public.watchlist_games;
create policy watchlist_games_update_own on public.watchlist_games for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists watchlist_games_delete_own on public.watchlist_games;
create policy watchlist_games_delete_own on public.watchlist_games for delete to authenticated using (user_id = auth.uid());
revoke all on public.watchlist_games from anon;
revoke update on public.watchlist_games from authenticated;
grant select, insert, delete on public.watchlist_games to authenticated;
grant update (home, away, kickoff_at, note, last_seen_at, seen_state, seen_hash) on public.watchlist_games to authenticated;
grant usage, select on sequence public.watchlist_games_id_seq to authenticated;

-- ── 5. game_research_state + game_research_history ───────────────────────────
-- The slate-level research state, one row per game. `state` is the whole
-- edgedesk_research_state/1 object (lib/edgedesk_personal.js documents it);
-- the columns beside it are that object's own fields, lifted out so the
-- watchlist, the alerts, the metrics and the desk can filter and join
-- without parsing JSON. Nothing here is computed in SQL.
create table if not exists public.game_research_state (
  game_key            text primary key,
  sport               text not null,
  game_id             text not null,
  season              int,
  week                int,
  home                text,
  away                text,
  kickoff_at          timestamptz,
  status              text,
  projected           boolean not null default false,
  fair_home_line      numeric,
  fair_total          numeric,
  model_version       text,
  market_home_line    numeric,
  market_total        numeric,
  market_kind         text,
  market_book         text,
  market_captured_at  timestamptz,
  market_stale        boolean,
  gap_pts             numeric,
  normalized_gap      numeric,
  win_prob_home       numeric,
  reliability_score   numeric,
  reliability_grade   text,
  research_label      text,
  research_grade      boolean not null default false,
  qb_confirmed        boolean,
  qb_unknown          boolean,
  priority_eligible   boolean not null default false,
  priority_score      numeric,
  priority_rank       int,
  priority_why        text,
  key_reason          text,
  state               jsonb not null,
  state_hash          text not null,
  computed_at         timestamptz not null,
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'game_research_state_shape') then
    alter table public.game_research_state add constraint game_research_state_shape check (
          game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$'
      and game_key = sport || '|' || game_id
      and (reliability_score is null or reliability_score between 0 and 100)
      and (win_prob_home is null or win_prob_home between 0 and 1)
      and (priority_rank is null or priority_rank between 1 and 1000)
      and pg_column_size(state) <= 64000);
  end if;
end $c$;
create index if not exists game_research_state_kickoff_idx on public.game_research_state (kickoff_at);
create index if not exists game_research_state_priority_idx on public.game_research_state (sport, priority_rank) where priority_rank is not null;

create table if not exists public.game_research_history (
  id           bigint generated always as identity primary key,
  game_key     text not null references public.game_research_state(game_key) on delete cascade,
  computed_at  timestamptz not null,
  state_hash   text not null,
  state        jsonb not null,
  recorded_at  timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'game_research_history_once') then
    alter table public.game_research_history add constraint game_research_history_once unique (game_key, state_hash, computed_at);
  end if;
end $c$;
create index if not exists game_research_history_game_idx on public.game_research_history (game_key, computed_at desc);

-- A DISTINCT state is appended to the history the moment it lands, by the
-- database, so the history cannot depend on a job remembering to write it.
create or replace function public.game_research_state_track()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.first_seen_at := old.first_seen_at;
    if new.state_hash is not distinct from old.state_hash then return new; end if;
  end if;
  return new;
end $$;
create or replace function public.game_research_state_history()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.state_hash is distinct from old.state_hash then
    insert into public.game_research_history (game_key, computed_at, state_hash, state)
    values (new.game_key, new.computed_at, new.state_hash, new.state)
    on conflict on constraint game_research_history_once do nothing;
  end if;
  return null;
end $$;
drop trigger if exists game_research_state_track_trg on public.game_research_state;
create trigger game_research_state_track_trg before insert or update on public.game_research_state
  for each row execute function public.game_research_state_track();
drop trigger if exists game_research_state_history_trg on public.game_research_state;
create trigger game_research_state_history_trg after insert or update on public.game_research_state
  for each row execute function public.game_research_state_history();

alter table public.game_research_state enable row level security;
alter table public.game_research_history enable row level security;
drop policy if exists game_research_state_read on public.game_research_state;
create policy game_research_state_read on public.game_research_state for select to authenticated
  using ((select public.edp_entitled(auth.uid())));
drop policy if exists game_research_history_read on public.game_research_history;
create policy game_research_history_read on public.game_research_history for select to authenticated
  using ((select public.edp_entitled(auth.uid())));
revoke all on public.game_research_state from anon;
revoke all on public.game_research_history from anon;
revoke insert, update, delete on public.game_research_state from authenticated;
revoke insert, update, delete on public.game_research_history from authenticated;
grant select on public.game_research_state to authenticated;
grant select on public.game_research_history to authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.game_research_state to service_role';
    execute 'grant select, insert, update, delete on public.game_research_history to service_role';
    execute 'grant usage, select on sequence public.game_research_history_id_seq to service_role';
  end if;
end $g$;

-- ── 6. user_alerts ───────────────────────────────────────────────────────────
create table if not exists public.user_alerts (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  game_key      text,
  kind          text not null,
  title         text not null,
  body          text,
  severity      text not null default 'info',
  payload       jsonb not null default '{}'::jsonb,
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  dismissed_at  timestamptz,
  email_status  text not null default 'not_sent'
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_alerts_once') then
    alter table public.user_alerts add constraint user_alerts_once unique (user_id, dedupe_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_alerts_shape') then
    alter table public.user_alerts add constraint user_alerts_shape check (
          kind in ('fair_move','market_move','key_number','gap_min','converge','diverge','reliability_min',
                   'reliability_change','qb_confirmed','qb_change','injury_change','research_grade','research_grade_lost')
      and severity in ('info','notable','caution')
      and email_status in ('not_sent','queued','sent','suppressed')
      and length(title) between 1 and 160 and (body is null or length(body) <= 600)
      and length(dedupe_key) between 1 and 200
      and pg_column_size(payload) <= 8000
      and public.edp_copy_ok(title) and public.edp_copy_ok(body));
  end if;
end $c$;
create index if not exists user_alerts_user_idx on public.user_alerts (user_id, created_at desc);
create index if not exists user_alerts_unread_idx on public.user_alerts (user_id) where read_at is null and dismissed_at is null;

alter table public.user_alerts enable row level security;
drop policy if exists user_alerts_select_own on public.user_alerts;
create policy user_alerts_select_own on public.user_alerts for select to authenticated using (user_id = auth.uid());
drop policy if exists user_alerts_update_own on public.user_alerts;
create policy user_alerts_update_own on public.user_alerts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.user_alerts from anon;
revoke insert, update, delete on public.user_alerts from authenticated;
grant select on public.user_alerts to authenticated;
grant update (read_at, dismissed_at) on public.user_alerts to authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.user_alerts to service_role';
    execute 'grant usage, select on sequence public.user_alerts_id_seq to service_role';
  end if;
end $g$;

-- ── 7. research_journal ──────────────────────────────────────────────────────
create table if not exists public.research_journal (
  id                        bigint generated always as identity primary key,
  entry_id                  uuid not null default gen_random_uuid(),
  user_id                   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at                timestamptz not null default now(),
  game_key                  text not null,
  home                      text,
  away                      text,
  kickoff_at                timestamptz,
  decision                  text not null,
  market_type               text,
  selection                 text,
  sportsbook                text,
  line                      numeric,
  price_american            int,
  stake                     numeric,
  notes                     text,
  -- THE INFORMATION SET AT DECISION TIME. Write-once.
  snap_fair_home_line       numeric,
  snap_fair_total           numeric,
  snap_market_home_line     numeric,
  snap_market_total         numeric,
  snap_market_book          text,
  snap_market_captured_at   timestamptz,
  snap_gap_pts              numeric,
  snap_win_prob_home        numeric,
  snap_reliability_score    numeric,
  snap_reliability_grade    text,
  snap_research_label       text,
  snap_qb                   jsonb,
  snap_injuries             jsonb,
  snap_model_version        text,
  snapshot                  jsonb not null,
  snapshot_hash             text not null,
  server_state              jsonb,
  server_state_hash         text,
  server_state_at           timestamptz,
  after_kickoff             boolean not null default false,
  -- THE CLOSE AND THE GRADE. Service role only.
  close_home_line           numeric,
  close_total               numeric,
  close_ml_home             int,
  close_ml_away             int,
  close_captured_at         timestamptz,
  close_source              text,
  close_fair_home_line      numeric,
  clv_points                numeric,
  clv_price                 numeric,
  beat_close                boolean,
  market_moved_toward_edgedesk boolean,
  fair_moved_toward_market  boolean,
  home_score                int,
  away_score                int,
  result                    text,
  graded_at                 timestamptz,
  grade_note                text
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'research_journal_entry_unique') then
    alter table public.research_journal add constraint research_journal_entry_unique unique (entry_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_journal_shape') then
    alter table public.research_journal add constraint research_journal_shape check (
          game_key ~ '^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$'
      and decision in ('researching','passed','leaned','wagered')
      and (market_type is null or market_type in ('spread','total','moneyline'))
      and (selection is null or selection in ('home','away','over','under'))
      and (sportsbook is null or length(sportsbook) <= 60)
      and (line is null or line between -100 and 400)
      and (price_american is null or price_american <= -100 or price_american >= 100)
      and (price_american is null or price_american between -100000 and 100000)
      and (stake is null or (stake >= 0 and stake <= 10000000))
      and (notes is null or length(notes) <= 4000)
      and (home is null or length(home) <= 80) and (away is null or length(away) <= 80)
      and pg_column_size(snapshot) <= 64000
      and (result is null or result in ('win','loss','push','void')));
  end if;
  -- a wager says what was taken; the pieces must agree with each other
  if not exists (select 1 from pg_constraint where conname = 'research_journal_wager_complete') then
    alter table public.research_journal add constraint research_journal_wager_complete check (
      decision <> 'wagered' or (
            market_type is not null and selection is not null
        and ((market_type = 'spread'    and selection in ('home','away') and line is not null)
          or (market_type = 'total'     and selection in ('over','under') and line is not null)
          or (market_type = 'moneyline' and selection in ('home','away') and price_american is not null))));
  end if;
end $c$;
create index if not exists research_journal_user_idx on public.research_journal (user_id, created_at desc);
create index if not exists research_journal_game_idx on public.research_journal (game_key);
create index if not exists research_journal_ungraded_idx on public.research_journal (kickoff_at)
  where decision = 'wagered' and graded_at is null;

-- ON INSERT: the server decides the time, the owner, what the shared state
-- said at that moment, and that no close or grade arrives with the entry.
create or replace function public.research_journal_on_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; recent int;
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.created_at := now();
  new.after_kickoff := (new.kickoff_at is not null and now() >= new.kickoff_at);
  select count(*) into recent from public.research_journal
   where user_id = new.user_id and created_at > now() - interval '24 hours';
  if recent >= 300 then
    raise exception 'research_journal: at most 300 entries per 24 hours' using errcode = 'check_violation';
  end if;
  -- the shared research state as it stood when the entry was made — a second,
  -- server-held copy of the information set beside the one the page sent
  select state, state_hash, computed_at into s from public.game_research_state where game_key = new.game_key;
  if found then
    new.server_state := s.state; new.server_state_hash := s.state_hash; new.server_state_at := s.computed_at;
  else
    new.server_state := null; new.server_state_hash := null; new.server_state_at := null;
  end if;
  new.close_home_line := null; new.close_total := null; new.close_ml_home := null; new.close_ml_away := null;
  new.close_captured_at := null; new.close_source := null; new.close_fair_home_line := null;
  new.clv_points := null; new.clv_price := null; new.beat_close := null;
  new.market_moved_toward_edgedesk := null; new.fair_moved_toward_market := null;
  new.home_score := null; new.away_score := null; new.result := null; new.graded_at := null; new.grade_note := null;
  return new;
end $$;
drop trigger if exists research_journal_on_insert_trg on public.research_journal;
create trigger research_journal_on_insert_trg before insert on public.research_journal
  for each row execute function public.research_journal_on_insert();

-- ON UPDATE: the information set never changes, for anybody. Notes are the
-- reader's; the close and the grade belong to the grading job.
create or replace function public.research_journal_on_update()
returns trigger language plpgsql as $$
begin
  if (new.entry_id, new.user_id, new.created_at, new.game_key, new.home, new.away, new.kickoff_at,
      new.decision, new.market_type, new.selection, new.sportsbook, new.line, new.price_american, new.stake,
      new.snap_fair_home_line, new.snap_fair_total, new.snap_market_home_line, new.snap_market_total,
      new.snap_market_book, new.snap_market_captured_at, new.snap_gap_pts, new.snap_win_prob_home,
      new.snap_reliability_score, new.snap_reliability_grade, new.snap_research_label, new.snap_qb,
      new.snap_injuries, new.snap_model_version, new.snapshot, new.snapshot_hash,
      new.server_state, new.server_state_hash, new.server_state_at, new.after_kickoff)
     is distinct from
     (old.entry_id, old.user_id, old.created_at, old.game_key, old.home, old.away, old.kickoff_at,
      old.decision, old.market_type, old.selection, old.sportsbook, old.line, old.price_american, old.stake,
      old.snap_fair_home_line, old.snap_fair_total, old.snap_market_home_line, old.snap_market_total,
      old.snap_market_book, old.snap_market_captured_at, old.snap_gap_pts, old.snap_win_prob_home,
      old.snap_reliability_score, old.snap_reliability_grade, old.snap_research_label, old.snap_qb,
      old.snap_injuries, old.snap_model_version, old.snapshot, old.snapshot_hash,
      old.server_state, old.server_state_hash, old.server_state_at, old.after_kickoff) then
    raise exception 'research_journal: entry % is write-once — the decision and the information set behind it cannot be edited', old.entry_id
      using errcode = 'restrict_violation';
  end if;
  if current_user in ('anon', 'authenticated')
     and (new.close_home_line, new.close_total, new.close_ml_home, new.close_ml_away, new.close_captured_at,
          new.close_source, new.close_fair_home_line, new.clv_points, new.clv_price, new.beat_close,
          new.market_moved_toward_edgedesk, new.fair_moved_toward_market, new.home_score, new.away_score,
          new.result, new.graded_at, new.grade_note)
         is distinct from
         (old.close_home_line, old.close_total, old.close_ml_home, old.close_ml_away, old.close_captured_at,
          old.close_source, old.close_fair_home_line, old.clv_points, old.clv_price, old.beat_close,
          old.market_moved_toward_edgedesk, old.fair_moved_toward_market, old.home_score, old.away_score,
          old.result, old.graded_at, old.grade_note) then
    raise exception 'research_journal: the close and the grade are written by the grading job only'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists research_journal_on_update_trg on public.research_journal;
create trigger research_journal_on_update_trg before update on public.research_journal
  for each row execute function public.research_journal_on_update();

alter table public.research_journal enable row level security;
drop policy if exists research_journal_select_own on public.research_journal;
create policy research_journal_select_own on public.research_journal for select to authenticated using (user_id = auth.uid());
drop policy if exists research_journal_insert_own on public.research_journal;
create policy research_journal_insert_own on public.research_journal for insert to authenticated with check (user_id = auth.uid());
drop policy if exists research_journal_update_own on public.research_journal;
create policy research_journal_update_own on public.research_journal for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists research_journal_delete_own on public.research_journal;
create policy research_journal_delete_own on public.research_journal for delete to authenticated using (user_id = auth.uid());
revoke all on public.research_journal from anon;
revoke update on public.research_journal from authenticated;
grant select, insert, delete on public.research_journal to authenticated;
grant update (notes) on public.research_journal to authenticated;
grant usage, select on sequence public.research_journal_id_seq to authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, update on public.research_journal to service_role';
  end if;
end $g$;

-- ── 8. the reader's watchlist, joined to the shared state ────────────────────
-- security_invoker: the view runs as the caller, so RLS on both tables
-- decides what it returns. `changed` compares the state the reader last
-- acknowledged with the latest one, by hash — never by re-deriving anything.
create or replace view public.my_watchlist with (security_invoker = true) as
  select w.id, w.game_key, split_part(w.game_key, '|', 1) as sport, split_part(w.game_key, '|', 2) as game_id,
         coalesce(s.home, w.home) as home, coalesce(s.away, w.away) as away,
         coalesce(s.kickoff_at, w.kickoff_at) as kickoff_at,
         w.created_at, w.last_seen_at, w.seen_hash, w.note,
         s.status, s.fair_home_line, s.market_home_line, s.gap_pts, s.win_prob_home,
         s.reliability_score, s.reliability_grade, s.research_grade, s.qb_confirmed, s.qb_unknown,
         s.key_reason, s.computed_at, s.state_hash, s.state,
         (w.seen_hash is not null and s.state_hash is not null and w.seen_hash is distinct from s.state_hash) as changed
    from public.watchlist_games w
    left join public.game_research_state s on s.game_key = w.game_key
   where w.user_id = auth.uid();
grant select on public.my_watchlist to authenticated;
revoke all on public.my_watchlist from anon;

-- ── 9. live proof metrics — counts of what the system is doing, nothing else
-- Every figure is a COUNT or an AVERAGE of rows that exist. No user count, no
-- accuracy, no profit, no ROI: those are not the system's activity, and a
-- metric that cannot be counted is returned as null and not shown.
create or replace function public.edgedesk_proof_metrics()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out jsonb; q int; b int; qat timestamptz;
begin
  select jsonb_build_object(
    'as_of', now(),
    'games_on_slate', count(*),
    'games_analyzed', count(*) filter (where projected),
    'games_next_24h', count(*) filter (where projected and kickoff_at between now() and now() + interval '24 hours'),
    'research_grade', count(*) filter (where research_grade),
    'qb_confirmed', count(*) filter (where qb_confirmed),
    'with_current_market', count(*) filter (where market_home_line is not null and not coalesce(market_stale, false)),
    'reliability_scored', count(*) filter (where reliability_score is not null),
    'avg_reliability', round(avg(reliability_score))::int,
    'model_updated_at', max(computed_at),
    'market_updated_at', max(market_captured_at)
  ) into out
  from public.game_research_state
  where kickoff_at > now() - interval '4 hours' and kickoff_at < now() + interval '8 days';

  -- the captured market itself, where the capture tables exist on this project
  if to_regclass('public.signals') is not null then
    begin
      execute $q$select count(*)::int, max(last_seen_at) from public.signals
                 where commence_time > now() and last_seen_at > now() - interval '6 hours'
                   and sport_key in ('americanfootball_ncaaf','americanfootball_nfl')$q$ into q, qat;
      out := out || jsonb_build_object('active_market_quotes', q, 'quotes_updated_at', qat);
    exception when others then null;
    end;
  end if;
  if to_regclass('public.book_quotes') is not null and to_regclass('public.signals') is not null then
    begin
      execute $q$select count(distinct bq.book_key)::int from public.book_quotes bq
                 join public.signals s on s.sig_key = bq.sig_key
                where s.commence_time > now() and s.last_seen_at > now() - interval '6 hours'
                  and s.sport_key in ('americanfootball_ncaaf','americanfootball_nfl')$q$ into b;
      out := out || jsonb_build_object('books_represented', b);
    exception when others then null;
    end;
  end if;
  return out;
end $$;
revoke all on function public.edgedesk_proof_metrics() from public;
grant execute on function public.edgedesk_proof_metrics() to anon, authenticated;

notify pgrst, 'reload schema';

-- ── REPORT ───────────────────────────────────────────────────────────────────
select 1 as step, 'the eight tables exist' as item,
  case when (select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('research_leagues','user_preferences','alert_preferences','watchlist_games','game_research_state',
     'game_research_history','user_alerts','research_journal')) = 8 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
union all
select 2, 'row level security is on everywhere',
  case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in
    ('research_leagues','user_preferences','alert_preferences','watchlist_games','game_research_state',
     'game_research_history','user_alerts','research_journal')) = 8 then 'ok' else 'CHECK THIS — RLS is off on a table' end
union all
select 3, 'one watchlist row per reader per game',
  case when exists (select 1 from pg_constraint where conname = 'watchlist_games_one_per_game') then 'ok' else 'CHECK THIS' end
union all
select 4, 'one alert per reader per dedupe key',
  case when exists (select 1 from pg_constraint where conname = 'user_alerts_once') then 'ok' else 'CHECK THIS' end
union all
select 5, 'the journal snapshot is write-once',
  case when exists (select 1 from pg_trigger where tgname = 'research_journal_on_update_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 6, 'a journal entry cannot arrive with a close or a grade',
  case when exists (select 1 from pg_trigger where tgname = 'research_journal_on_insert_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 7, 'readers cannot write the shared research state',
  case when not has_table_privilege('authenticated', 'public.game_research_state', 'insert')
        and not has_table_privilege('authenticated', 'public.game_research_state', 'update')
        and not has_table_privilege('anon', 'public.game_research_state', 'select') then 'ok' else 'CHECK THIS' end
union all
select 8, 'readers cannot create alerts, only read and dismiss their own',
  case when not has_table_privilege('authenticated', 'public.user_alerts', 'insert')
        and has_column_privilege('authenticated', 'public.user_alerts', 'read_at', 'update')
        and not has_column_privilege('authenticated', 'public.user_alerts', 'title', 'update') then 'ok' else 'CHECK THIS' end
union all
select 9, 'readers may edit a journal entry''s notes and nothing else',
  case when has_column_privilege('authenticated', 'public.research_journal', 'notes', 'update')
        and not has_column_privilege('authenticated', 'public.research_journal', 'clv_points', 'update')
        and not has_column_privilege('authenticated', 'public.research_journal', 'snapshot', 'update') then 'ok' else 'CHECK THIS' end
union all
select 10, 'the state history is appended by trigger',
  case when exists (select 1 from pg_trigger where tgname = 'game_research_state_history_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 11, 'the watchlist view runs as the caller',
  case when (select coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false')
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'my_watchlist') = 'true' then 'ok' else 'CHECK THIS — the view would read every reader''s rows' end
union all
select 12, 'the shared research state is gated on '
  || case when to_regprocedure('public.community_is_entitled(uuid)') is not null then 'the paywall''s entitlement' else 'sign-in only (community_posts.sql not run)' end,
  'ok'
union all
select 13, 'the tout-language check is on alert copy',
  case when exists (select 1 from pg_constraint where conname = 'user_alerts_shape') and not public.edp_copy_ok('LOCK of the week')
        and public.edp_copy_ok('Model-market disagreement is now 3.2 points.') then 'ok' else 'CHECK THIS' end
union all
select 14, 'the proof metrics are callable without an account',
  case when has_function_privilege('anon', 'public.edgedesk_proof_metrics()', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 15, 'the entitlement check is not callable without an account',
  case when not has_function_privilege('anon', 'public.edp_entitled(uuid)', 'execute') then 'ok' else 'CHECK THIS' end
order by 1;
