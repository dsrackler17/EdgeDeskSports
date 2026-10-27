-- =============================================================================
-- sharp_lag.sql — the Sharp-lag research pipeline (EXPERIMENTAL).
-- docs/sharp-lag/README.md.
--
-- WHAT IT IS. A measurement, run in the open: where a slow market (a Kalshi
-- game-winner YES price, a DraftKings line) sits at least 2.5 percentage
-- points below Pinnacle's de-vigged (Shin) fair for the same outcome after its
-- own fees, a flag is written, and every flag is graded against the closing
-- line, losses included. Research only: nothing here is a recommendation.
--
-- WHO WRITES. Only the service role, through two Edge Functions:
--   supabase/functions/sharp_lag    FREE: never calls the odds gateway or the
--                                   provider. Every 10 minutes it copies the
--                                   Pinnacle and DraftKings prices out of every
--                                   new gateway snapshot (A), detects triggers
--                                   (B), writes flags (C) and grades started
--                                   games (D).
--   supabase/functions/sharp_check  PAID, hourly: one single-event request per
--                                   triggered game through odds_gateway, in its
--                                   own capped category (B). The emergency
--                                   stop pauses it (odds_api_spend_patterns).
--
-- TABLES. Every one APPEND-ONLY: an update, a delete or a truncate is refused
-- by a trigger, for the service role and the owner too.
--   sharp_price_snapshots   (A) Pinnacle and DraftKings prices, one row per
--                           book, market, side and point per gateway snapshot
--   sharp_lag_runs          (A) one row per function run
--   sharp_lag_config_log    (A) every change of a switch in sharp_lag_config
--   sharp_triggers          (B) an NBA starter's status change, an NHL goalie
--                           change, a Kalshi move of 3c+, an NBA role shift
--   sharp_check_requests    (B) every ask the dispatcher made, and the answer
--   sharp_flags             (C) the flags, both registered models
--   sharp_flag_grades       (D) the grade of each flag: close, CLV, lag
-- sharp_lag_config holds the operator's switches (dispatch shadow / live,
-- flags on / off, public_display off / on) and the registry links: the one
-- table that changes, and every change of it is logged.
--
-- WHO READS. Prices, triggers, requests and runs: the service role only.
-- Flags and grades: subscribers (has_active_sub(), as public.signals), every
-- flag, live, through public.sharp_lag_flags(). Everyone: the counts in
-- public.sharp_lag_progress() (no price), and, once an operator has read The
-- Odds API's terms and switched public_display on, every flag and grade of a
-- game that has STARTED.
--
-- THE RULES live in public.sharp_lag_rule(), frozen like kalshi_rule(): a
-- change is a reviewed code change, and lib/edgedesk_sharp_lag.js RULES must
-- match (tools/sharp_lag/core.test.js).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261027120000_sharp_lag.sql.
-- =============================================================================

begin;

-- ---------------------------------------------------------------- guards and rules
create or replace function public.sharp_lag_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;

create or replace function public.sharp_lag_rule(p_key text)
returns numeric language sql immutable as $r$
  select case p_key
    when 'gap_pp'                  then 2.5   -- Pinnacle fair minus the target's all-in cost, percentage points
    when 'role_shift_gap_pp'       then 2.5   -- the role-shift fair probability minus the posted price's
    when 'converge_pp'             then 1.0   -- the lag is over once the gap is under this
    when 'reference_max_age_min'   then 90    -- an older Pinnacle observation is a past price: no flag
    when 'book_target_max_age_min' then 90    -- an older DraftKings price is a past price
    when 'kalshi_max_age_min'      then 15    -- kalshi_rule('stale_snapshot_minutes')
    when 'kalshi_max_spread'       then 0.06  -- kalshi_rule('max_spread')
    when 'kalshi_move'             then 0.03  -- a trigger: the Kalshi mid moved this far between snapshots
    when 'kalshi_pair_max_min'     then 10    -- consecutive snapshots are at most this far apart
    when 'close_max_lead_min'      then 90    -- the close: the last observation at most this long before the start
    when 'check_window_hours'      then 24    -- triggered checks only inside 24 h of the start
    when 'validation_min_graded'   then 200   -- and the 95% lower bound on mean CLV above zero, both
    when 'ci_level'                then 0.95
    when 'past_price_min'          then 90    -- the existing display rule (lib/edgedesk_games.js market_limit_min)
  end
$r$;

-- ---------------------------------------------------------------- switches
create table if not exists public.sharp_lag_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);
create table if not exists public.sharp_lag_config_log (
  id         bigint generated always as identity primary key,
  key        text not null,
  old_value  text,
  new_value  text,
  note       text,
  changed_at timestamptz not null default now(),
  changed_by text not null default current_user
);
create or replace function public.sharp_lag_config_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $a$
begin
  insert into public.sharp_lag_config_log (key, old_value, new_value, note)
  values (coalesce(new.key, old.key), case when tg_op = 'INSERT' then null else old.value end,
          case when tg_op = 'DELETE' then null else new.value end, case when tg_op = 'DELETE' then old.note else new.note end);
  return coalesce(new, old);
end $a$;
drop trigger if exists sharp_lag_config_audit on public.sharp_lag_config;
create trigger sharp_lag_config_audit after insert or update or delete on public.sharp_lag_config
  for each row execute function public.sharp_lag_config_audit();
insert into public.sharp_lag_config (key, value, note) values
  ('dispatch', 'shadow', 'shadow: triggers are recorded and nothing is bought. live: the hourly sharp_check asks odds_gateway (whose sharp_check and nba_role_props categories must also be enabled).'),
  ('flags', 'on', 'on: flags are written whenever the data allows (a Pinnacle observation under 90 minutes old). off: nothing is flagged.'),
  ('public_display', 'off', 'off until a person has read The Odds API terms and they permit publishing prices derived from it. on: started games'' flags and the record are public. Record who and when in this note.')
on conflict (key) do nothing;
create or replace function public.sharp_lag_setting(p_key text)
returns text language sql stable security definer set search_path = public, pg_temp as $s$
  select value from public.sharp_lag_config where key = p_key
$s$;


-- SEALED: append-only (update, delete, truncate refused by a trigger), row
-- level security on, no client grant; the service role may read and insert.
create or replace function public.sharp_lag_seal(p_tables text[])
returns void language plpgsql as $s$
declare t text;
begin
  foreach t in array p_tables loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.sharp_lag_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.sharp_lag_keep()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert on public.%I to service_role', t);
    end if;
  end loop;
end $s$;
-- from anon and authenticated too: Supabase grants new functions in public to both by default
revoke all on function public.sharp_lag_seal(text[]) from public, anon, authenticated;

alter table public.sharp_lag_config enable row level security;
revoke all on public.sharp_lag_config from anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.sharp_lag_config to service_role';
  end if;
end $g$;
revoke all on function public.sharp_lag_setting(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- A. prices
create table if not exists public.sharp_price_snapshots (
  id                 bigint generated always as identity primary key,
  captured_at        timestamptz not null,            -- the gateway snapshot's fetch time: when the price was observed
  source             text not null default 'odds_api' check (source in ('odds_api')),
  source_request_id  bigint not null,                 -- odds_api_requests.id that bought it
  source_category    text not null check (source_category in ('featured', 'close', 'sharp_check', 'nba_role_props')),
  odds_format        text,
  sport_key          text not null,
  event_id           text not null,
  home_team          text,
  away_team          text,
  commence_time      timestamptz,
  book               text not null,
  book_last_update   timestamptz,
  market             text not null,
  side               text not null,
  participant        text,                            -- a player market's player
  point              numeric,
  price_dec          numeric not null check (price_dec > 1),
  ingested_at        timestamptz not null default now(),
  -- the once-only key needs plain columns (PostgREST's on_conflict names columns)
  participant_key    text generated always as (coalesce(participant, '')) stored,
  point_key          numeric generated always as (coalesce(point, -999999)) stored
);
create unique index if not exists sharp_price_snapshots_once_idx on public.sharp_price_snapshots
  (source_request_id, event_id, book, market, side, participant_key, point_key);
create index if not exists sharp_price_snapshots_event_idx on public.sharp_price_snapshots (event_id, book, captured_at desc);
create index if not exists sharp_price_snapshots_captured_idx on public.sharp_price_snapshots (captured_at desc);

-- ---------------------------------------------------------------- runs
create table if not exists public.sharp_lag_runs (
  run_id       uuid primary key default gen_random_uuid(),
  fn           text not null check (fn in ('sharp_lag', 'sharp_check')),
  status       text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  message      text,
  details      jsonb not null default '{}'::jsonb
);
create index if not exists sharp_lag_runs_finished_idx on public.sharp_lag_runs (fn, finished_at desc);

select public.sharp_lag_seal(array['sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log']);
comment on table public.sharp_price_snapshots is 'Sharp lag (A): Pinnacle and DraftKings prices copied out of odds_gateway snapshots (featured, close, sharp_check, nba_role_props). Append-only.';

-- ---------------------------------------------------------------- B. triggers and checks (append-only)
create table if not exists public.sharp_triggers (
  id               bigint generated always as identity primary key,
  detected_at      timestamptz not null default now(),
  trigger_type     text not null check (trigger_type in ('nba_injury', 'nhl_goalie', 'kalshi_move', 'role_shift')),
  sport_key        text not null,
  league_game_id   text,                              -- ESPN (NBA), NHL API (NHL), the card's id (NFL/CFB)
  event_id         text,                              -- the provider event, when it could be matched
  home_team        text,
  away_team        text,
  commence_time    timestamptz,
  mode             text not null check (mode in ('shadow', 'live')),
  dedupe_key       text not null,
  detail           jsonb not null default '{}'::jsonb
);
create unique index if not exists sharp_triggers_once_idx on public.sharp_triggers (dedupe_key);
create index if not exists sharp_triggers_detected_idx on public.sharp_triggers (detected_at desc);

create table if not exists public.sharp_check_requests (
  id                  bigint generated always as identity primary key,
  requested_at        timestamptz not null default now(),
  purpose             text not null check (purpose in ('trigger', 'close', 'role_shift', 'role_shift_close')),
  trigger_id          bigint references public.sharp_triggers (id),
  category            text not null check (category in ('sharp_check', 'nba_role_props')),
  sport_key           text not null,
  event_id            text not null,
  decision            text not null,                  -- the gateway's answer (granted, cache_hit, denied_category_cap ...)
  source              text,                           -- provider / cache / stale_cache / none
  cost                integer not null default 0,
  gateway_request_id  bigint,
  fetched_at          timestamptz,
  detail              jsonb not null default '{}'::jsonb
);
create unique index if not exists sharp_check_requests_trigger_once_idx on public.sharp_check_requests (trigger_id) where trigger_id is not null;
create index if not exists sharp_check_requests_event_idx on public.sharp_check_requests (event_id, requested_at desc);

select public.sharp_lag_seal(array['sharp_triggers', 'sharp_check_requests']);
comment on table public.sharp_triggers is 'Sharp lag (B): what started a check: an NBA starter''s status change, an NHL goalie change, a Kalshi move of 3c+, an NBA role shift. Recorded in the dispatch mode of the moment. Append-only.';

-- ---------------------------------------------------------------- C. flags (append-only)
create table if not exists public.sharp_flags (
  flag_id                bigint generated always as identity primary key,
  flagged_at             timestamptz not null,
  model_key              text not null check (model_key in ('SHARP-LAG', 'NBA-ROLE-SHIFT')),
  model_version          text not null,
  trigger_type           text not null check (trigger_type in ('scheduled', 'nba_injury', 'nhl_goalie', 'kalshi_move', 'role_shift')),
  trigger_id             bigint references public.sharp_triggers (id),
  sport_key              text not null,
  event_id               text not null,
  home_team              text,
  away_team              text,
  commence_time          timestamptz not null,
  market                 text not null,
  side                   text not null,
  participant            text,
  point                  numeric,
  target_venue           text not null,               -- kalshi, draftkings, or the prop book
  target_ref             text not null,               -- the Kalshi ticker, or the book key
  target_price           numeric not null,            -- Kalshi YES ask (dollars) or the book's decimal price
  target_price_american  integer,
  target_cost_prob       numeric not null check (target_cost_prob > 0 and target_cost_prob < 1.5),
  fee_per_contract       numeric,
  fee_basis              text not null check (fee_basis in ('none', 'verified', 'highest_plausible')),
  fee_unverified         boolean not null,
  target_observed_at     timestamptz not null,
  target_snapshot_id     bigint,
  target_request_id      bigint,
  reference_kind         text not null check (reference_kind in ('pinnacle_shin', 'role_shift_model')),
  reference_prob         numeric not null check (reference_prob > 0 and reference_prob < 1),
  devig_method           text,
  pinnacle_price_dec     numeric,
  pinnacle_opp_dec       numeric,
  reference_observed_at  timestamptz not null,
  reference_request_id   bigint,
  reference_category     text,
  gap_pp                 numeric not null,
  threshold_pp           numeric not null,
  seconds_since_reference integer not null check (seconds_since_reference >= 0),
  reference_resolution_s integer,
  target_resolution_s    integer,
  snapshot_resolution_s  integer,                     -- lag is measured only to this cadence
  episode_key            text not null,
  -- role shift (F)
  absent_player_id       text,
  absent_player_name     text,
  minutes_delta          numeric,
  sample_games           integer,
  sample_stints          integer,
  fair_line              numeric,
  posted_line            numeric,
  fair_price_american    integer,
  detail                 jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  check (commence_time > flagged_at),
  check (gap_pp >= threshold_pp),
  check (fee_basis = 'verified' or target_venue <> 'kalshi' or fee_unverified),
  check (reference_kind <> 'pinnacle_shin' or (pinnacle_price_dec is not null and pinnacle_opp_dec is not null)),
  check (model_key <> 'NBA-ROLE-SHIFT' or (trigger_type = 'role_shift' and absent_player_id is not null and minutes_delta is not null))
);
create unique index if not exists sharp_flags_episode_idx on public.sharp_flags (episode_key);
create index if not exists sharp_flags_event_idx on public.sharp_flags (event_id, flagged_at);
create index if not exists sharp_flags_start_idx on public.sharp_flags (commence_time);
create index if not exists sharp_flags_flagged_idx on public.sharp_flags (flagged_at desc);

-- the rules the database holds, not only the function
create or replace function public.sharp_flags_guard()
returns trigger language plpgsql as $g$
declare registered numeric := public.sharp_lag_rule(case when new.model_key = 'NBA-ROLE-SHIFT' then 'role_shift_gap_pp' else 'gap_pp' end);
begin
  if new.threshold_pp < registered then
    raise exception 'sharp_flags: threshold % is below the registered threshold', new.threshold_pp;
  end if;
  if new.reference_kind = 'pinnacle_shin' and new.seconds_since_reference > public.sharp_lag_rule('reference_max_age_min') * 60 then
    raise exception 'sharp_flags: the Pinnacle observation is % s old: a past price is never flagged', new.seconds_since_reference;
  end if;
  -- the absent player's own unders void if he sits: never flagged
  if new.model_key = 'NBA-ROLE-SHIFT' and new.side ilike 'under'
     and (lower(coalesce(new.participant, '')) = lower(coalesce(new.absent_player_name, '')) or coalesce(new.detail ->> 'participant_id', '') = new.absent_player_id) then
    raise exception 'sharp_flags: the absent player''s own under is never flagged (it voids if he does not play)';
  end if;
  return new;
end $g$;
drop trigger if exists sharp_flags_guard on public.sharp_flags;
create trigger sharp_flags_guard before insert on public.sharp_flags for each row execute function public.sharp_flags_guard();

select public.sharp_lag_seal(array['sharp_flags']);
comment on table public.sharp_flags is 'Sharp lag (C, F): a measured gap between a slow market and its reference, at one moment. Experimental research, never a recommendation. Append-only.';

-- ---------------------------------------------------------------- D. grades (append-only, once per flag)
create table if not exists public.sharp_flag_grades (
  flag_id                    bigint primary key references public.sharp_flags (flag_id),
  graded_at                  timestamptz not null default now(),
  model_key                  text not null,
  registry_ref               text not null,           -- the research_model_versions row the grade counts toward
  close_status               text not null check (close_status in ('graded', 'no_close')),
  no_close_reason            text,
  closing_reference_prob     numeric,
  closing_pinnacle_price_dec numeric,
  closing_pinnacle_opp_dec   numeric,
  closing_reference_at       timestamptz,
  close_lead_min             numeric,
  closing_target_price       numeric,
  closing_target_cost        numeric,
  closing_target_at          timestamptz,
  clv_pp                     numeric,
  hit                        boolean,
  converged                  boolean not null,
  converged_at               timestamptz,
  lag_to_converge_s          integer,
  lag_censored               boolean not null,
  lag_resolution_s           integer,
  actual_stat                numeric,                 -- role shift: the player's stat in the game
  actual_outcome             text check (actual_outcome is null or actual_outcome in ('over', 'under', 'push', 'void')),
  detail                     jsonb not null default '{}'::jsonb,
  check ((close_status = 'graded') = (clv_pp is not null)),
  check (close_status = 'graded' or no_close_reason is not null),
  check (hit is null or hit = (clv_pp > 0)),
  check (converged = (converged_at is not null) and converged = not lag_censored)
);
create index if not exists sharp_flag_grades_model_idx on public.sharp_flag_grades (model_key, close_status);

-- REGISTERED BEFORE GRADED. A grade names the registry version it counts
-- toward, and the registry SQL (supabase/sharp_lag_registry.sql) is the only
-- writer of those links: no link, no grade. A grade is refused before the
-- game starts, and for any model but the flag's own.
create or replace function public.sharp_flag_grades_guard()
returns trigger language plpgsql as $g$
declare f public.sharp_flags; ref text;
begin
  select * into f from public.sharp_flags where flag_id = new.flag_id;
  if not found then raise exception 'sharp_flag_grades: no flag %', new.flag_id; end if;
  if new.model_key <> f.model_key then raise exception 'sharp_flag_grades: flag % belongs to %, not %', new.flag_id, f.model_key, new.model_key; end if;
  if f.commence_time > now() then raise exception 'sharp_flag_grades: flag %''s game has not started', new.flag_id; end if;
  select value into ref from public.sharp_lag_config where key = 'registry_ref:' || f.model_key;
  if ref is null then
    raise exception 'sharp_flag_grades: % is not registered in the research registry (apply supabase/sharp_lag_registry.sql): no grade before registration', f.model_key;
  end if;
  if new.registry_ref is distinct from ref then raise exception 'sharp_flag_grades: registry_ref must be %', ref; end if;
  return new;
end $g$;
drop trigger if exists sharp_flag_grades_guard on public.sharp_flag_grades;
create trigger sharp_flag_grades_guard before insert on public.sharp_flag_grades for each row execute function public.sharp_flag_grades_guard();

select public.sharp_lag_seal(array['sharp_flag_grades']);

-- a subscriber is whoever public.signals admits (has_active_sub()); without
-- that function nobody but the service role reads a live flag
create or replace function public.sharp_lag_is_subscriber()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $s$
declare v boolean := false;
begin
  if to_regprocedure('public.has_active_sub()') is null then return false; end if;
  execute 'select public.has_active_sub()' into v;
  return coalesce(v, false);
exception when others then return false;
end $s$;

-- one flag and its grade, as every reader sees it
create or replace view public.sharp_lag_rows with (security_invoker = true) as
select f.flag_id, f.flagged_at, f.model_key, f.model_version, f.trigger_type, f.sport_key, f.event_id, f.home_team, f.away_team, f.commence_time,
       f.market, f.side, f.participant, f.point, f.target_venue, f.target_ref, f.target_price, f.target_price_american, f.target_cost_prob,
       f.fee_per_contract, f.fee_basis, f.fee_unverified, f.target_observed_at, f.reference_kind, f.reference_prob, f.devig_method,
       f.pinnacle_price_dec, f.pinnacle_opp_dec, f.reference_observed_at, f.gap_pp, f.threshold_pp, f.seconds_since_reference,
       f.reference_resolution_s, f.target_resolution_s, f.snapshot_resolution_s,
       f.absent_player_id, f.absent_player_name, f.minutes_delta, f.sample_games, f.sample_stints, f.fair_line, f.posted_line, f.fair_price_american,
       f.detail as flag_detail,
       g.graded_at, g.close_status, g.no_close_reason, g.closing_reference_prob, g.closing_reference_at, g.close_lead_min,
       g.closing_target_price, g.closing_target_cost, g.closing_target_at, g.clv_pp, g.hit, g.converged, g.converged_at,
       g.lag_to_converge_s, g.lag_censored, g.lag_resolution_s, g.actual_stat, g.actual_outcome
  from public.sharp_flags f
  left join public.sharp_flag_grades g on g.flag_id = f.flag_id;
revoke all on public.sharp_lag_rows from anon, authenticated;

-- FLAGS FOR A READER. A subscriber: every flag in the window, live. Anyone
-- else: only games that have started, and only once public_display is on.
create or replace function public.sharp_lag_flags(p_sport text default null, p_from timestamptz default null, p_to timestamptz default null)
returns setof jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare sub boolean := public.sharp_lag_is_subscriber();
        pub boolean := coalesce(public.sharp_lag_setting('public_display'), 'off') = 'on';
begin
  if not sub and not pub then return; end if;
  return query
    select to_jsonb(r) || jsonb_build_object('access', case when sub then 'subscriber' else 'public' end)
      from public.sharp_lag_rows r
     where (p_sport is null or r.sport_key = p_sport)
       and r.commence_time >= coalesce(p_from, now() - interval '400 days') and r.commence_time <= coalesce(p_to, now() + interval '10 days')
       and (sub or r.commence_time <= now())
     order by r.flagged_at desc
     limit 5000;
end $f$;

-- VALIDATION PROGRESS, for everyone: counts only, no price
create or replace function public.sharp_lag_progress()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $p$
  select jsonb_build_object(
    'threshold', public.sharp_lag_rule('validation_min_graded'),
    'public_display', coalesce(public.sharp_lag_setting('public_display'), 'off'),
    'models', coalesce((select jsonb_agg(jsonb_build_object('model_key', m.k, 'flags', coalesce(x.flags, 0), 'graded', coalesce(x.graded, 0),
                                                       'no_close', coalesce(x.no_close, 0), 'pending', coalesce(x.pending, 0),
                                                       'registered', exists (select 1 from public.sharp_lag_config c where c.key = 'registry_ref:' || m.k)) order by m.k)
                          from (values ('SHARP-LAG'), ('NBA-ROLE-SHIFT')) m(k)
                          left join (select model_key, count(*)::int as flags,
                                            count(*) filter (where close_status = 'graded')::int as graded,
                                            count(*) filter (where close_status = 'no_close')::int as no_close,
                                            count(*) filter (where close_status is null)::int as pending
                                       from public.sharp_lag_rows group by model_key) x on x.model_key = m.k), '[]'::jsonb),
    'access', case when public.sharp_lag_is_subscriber() then 'subscriber'
                   when coalesce(public.sharp_lag_setting('public_display'), 'off') = 'on' then 'public' else 'none' end,
    'as_of', now())
$p$;

do $g$ begin
  execute 'revoke all on function public.sharp_lag_flags(text, timestamptz, timestamptz) from public';
  execute 'revoke all on function public.sharp_lag_progress() from public';
  -- anonymous doors (lib/edgedesk_plans.js DOORS.anon): the database decides what each reader gets
  execute 'grant execute on function public.sharp_lag_flags(text, timestamptz, timestamptz) to anon, authenticated';
  execute 'grant execute on function public.sharp_lag_progress() to anon, authenticated';
  execute 'revoke all on function public.sharp_lag_setting(text), public.sharp_lag_is_subscriber() from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sharp_lag_flags(text, timestamptz, timestamptz), public.sharp_lag_progress(), public.sharp_lag_setting(text) to service_role';
    execute 'grant select on public.sharp_lag_rows to service_role';
  end if;
end $g$;
comment on table public.sharp_flag_grades is 'Sharp lag (D): the close, CLV and lag of one flag, written once after the start, only for a registered model. Append-only.';

notify pgrst, 'reload schema';
commit;

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 every Sharp-lag table is append-only (update, delete and truncate refused)' as piece,
         case when (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log', 'sharp_triggers', 'sharp_check_requests', 'sharp_flags', 'sharp_flag_grades')
                      and exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = c.relname || '_frozen')
                      and exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = c.relname || '_no_truncate'))
                 = (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log', 'sharp_triggers', 'sharp_check_requests', 'sharp_flags', 'sharp_flag_grades'))
              then 'ok' else 'CHECK THIS' end as state
  union all select '2 no Sharp-lag table is readable by anon or a signed-in browser',
         case when not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
               and relname in ('sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log', 'sharp_triggers', 'sharp_check_requests', 'sharp_flags', 'sharp_flag_grades', 'sharp_lag_config')
               and (has_table_privilege('anon', oid, 'select') or has_table_privilege('authenticated', oid, 'select'))) then 'ok' else 'CHECK THIS' end
  union all select '3 subscribers are recognised (public.has_active_sub exists)',
         case when to_regprocedure('public.has_active_sub()') is not null then 'ok' else 'CHECK THIS: without has_active_sub() no reader sees a live flag' end
  union all select '4 dispatch is shadow or live (nothing is bought until an operator says live)',
         case when public.sharp_lag_setting('dispatch') in ('shadow', 'live') then 'ok' else 'CHECK THIS' end
  union all select '5 public display is off until the terms are read, or on',
         case when public.sharp_lag_setting('public_display') in ('off', 'on') then 'ok' else 'CHECK THIS' end
) r order by 1;
