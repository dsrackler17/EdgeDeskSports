-- cfb_personnel -- part 1 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- cfb_personnel — the Postgres half of the CFB player-level roster
-- intelligence system (docs/cfb-personnel/DESIGN.md).
--
-- WHAT IT IS
--   The canonical player registry (players, aliases, transfers), player-game
--   performance, player-week state, the usage-derived depth chart, unit
--   personnel state (baseline lineup, expected lineup, lineup delta), player
--   events, the per-game personnel snapshot (lineup scenarios) and the
--   personnel model versions. The repository (football/cfb_personnel/<season>/
--   *.jsonl) is the source of truth; football/cfb_personnel/sync_supabase.js
--   mirrors it here insert-only. Each table has typed columns for what is
--   queried and `payload jsonb` holding the complete row as written.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE / DELETE / TRUNCATE triggers on every table
--      raise restrict_violation (the service role included). A correction is
--      a new state_version that names what it supersedes; a registry change
--      is a new registry_version.
--   2. Exactly once. One row per natural key and version, by unique index.
--   3. Point in time. A player-week state, a unit state and a game snapshot
--      carry their as_of instant; a game snapshot's as_of precedes kickoff; a
--      player event's known_at is recorded and never precedes the source's
--      publication; a transfer is knowledge only from known_from.
--   4. Probabilities are probabilities (starter, availability, scenario).
--   5. Who reads what. authenticated may SELECT; anon nothing; writes only
--      from the service role (insert). Player-level rows are internal: there
--      is no anon view.
--
-- DEPENDENCIES: none. CONVENTION (supabase/README.md): idempotent, additive,
-- pasted into the SQL editor, no psql meta-commands, ends in a report. Safe to
-- run again. Tested against a real PostgreSQL by football/cfb_personnel/sql.test.js.
-- =============================================================================

-- ================================================================ registry
create table if not exists public.cfb_players (
  player_row_id      text primary key,
  player_id          text not null,
  espn_id            bigint,
  registry_version   text not null,
  full_name          text,
  team_id            text,
  first_season       int,
  last_season        int,
  active_status      text,
  n_transfers        int,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_players_id check (player_id ~ '^espn:[0-9]+$'),
  constraint cfb_players_seasons check (first_season is null or last_season is null or first_season <= last_season)
);
create unique index if not exists cfb_players_key on public.cfb_players (player_id, registry_version);

create table if not exists public.cfb_player_aliases (
  alias_id           text primary key,
  player_id          text not null,
  name               text not null,
  alias_key          text not null,
  season             int,
  team_id            text,
  source             text not null,
  registry_version   text not null,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now()
);
create index if not exists cfb_player_aliases_lookup on public.cfb_player_aliases (alias_key, season, team_id);

create table if not exists public.cfb_transfer_history (
  transfer_id        text primary key,
  player_id          text not null,
  event_type         text not null,
  from_team          text,
  to_team            text,
  from_season        int,
  to_season          int,
  known_from         timestamptz,
  known_from_basis   text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_transfer_type check (event_type in ('TRANSFER','TRANSFER_AFTER_GAP')),
  constraint cfb_transfer_order check (from_season is null or to_season is null or from_season < to_season)
);

-- ============================================================ performance
create table if not exists public.cfb_player_performance (
  performance_id     text primary key,
  game_id            text not null,
  team_id            text not null,
  player_id          text not null,
  season             int not null,
  week               int,
  kickoff_ts         timestamptz not null,
  code_version       text not null,
  position_family    text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now()
);
create unique index if not exists cfb_player_performance_key
  on public.cfb_player_performance (game_id, team_id, player_id, code_version);

-- ================================================================== state
create table if not exists public.cfb_player_week_state (
  player_week_state_id text primary key,
  player_id          text not null,
  team_id            text not null,
  season             int not null,
  as_of              timestamptz not null,
  rule_version       text not null,
  position_family    text,
  unit               text,
  role               text,
  expected_usage_share numeric,
  starter_probability numeric,
  expected_availability numeric,
  availability_status text,
  player_value_mean  numeric,
  player_value_sd    numeric,
  replacement_value  numeric,
  value_model        text,
  source_quality     text,
  state_version      int not null default 1,
  supersedes         text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pws_prob check ((starter_probability is null or starter_probability between 0 and 1)
    and (expected_availability is null or expected_availability between 0 and 1)
    and (expected_usage_share is null or expected_usage_share between 0 and 1)),
  constraint cfb_pws_sd check (player_value_sd is null or player_value_sd >= 0),
  constraint cfb_pws_version check ((state_version = 1 and supersedes is null) or (state_version > 1 and supersedes is not null)),
  constraint cfb_pws_quality check (source_quality is null or source_quality in ('HIGH','MEDIUM','LOW'))
);
create unique index if not exists cfb_player_week_state_key
  on public.cfb_player_week_state (player_id, team_id, season, as_of, rule_version, state_version);

create table if not exists public.cfb_depth_chart_state (
  depth_chart_state_id text primary key,
  team_id            text not null,
  season             int not null,
  as_of              timestamptz not null,
  position_family    text not null,
  unit               text,
  source             text not null,
  ordering           text,
  confidence         numeric,
  confidence_label   text,
  rule_version       text not null,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  -- no provider depth chart exists: the only source is observed usage
  constraint cfb_depth_source check (source = 'usage_derived'),
  constraint cfb_depth_conf check (confidence is null or confidence between 0 and 1)
);
create unique index if not exists cfb_depth_chart_state_key
  on public.cfb_depth_chart_state (team_id, season, as_of, position_family, rule_version);

-- Unit personnel state: the lineup the rating represents (baseline), the
-- expected lineup for the next game, and the delta in points with its SD.
-- knowledge: KNOWN (an official report), INFERRED (usage only) or UNKNOWN
-- (no report: not healthy, missing information). NOT_ESTIMATED marks a unit
-- with no player data (the offensive line): uncertainty only.
create table if not exists public.cfb_personnel_unit_state (
  unit_state_id      text primary key,
  team_id            text not null,
  season             int not null,
  as_of              timestamptz not null,
  game_id            text,
  unit               text not null,
  rule_version       text not null,
  knowledge          text not null,
  value_status       text,
  baseline_value     numeric,
  expected_value     numeric,
  lineup_delta_pts   numeric,
  lineup_delta_sd    numeric,
  variance_inflation_pts2 numeric,
  state_version      int not null default 1,
  supersedes         text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pus_knowledge check (knowledge in ('KNOWN','INFERRED','UNKNOWN')),
  constraint cfb_pus_value_status check (value_status is null or value_status in ('ESTIMATED','NOT_ESTIMATED','UNRELIABLE_DATA')),
  constraint cfb_pus_sd check ((lineup_delta_sd is null or lineup_delta_sd >= 0)
    and (variance_inflation_pts2 is null or variance_inflation_pts2 >= 0)),
  constraint cfb_pus_version check ((state_version = 1 and supersedes is null) or (state_version > 1 and supersedes is not null))
);
create unique index if not exists cfb_personnel_unit_state_key
  on public.cfb_personnel_unit_state (team_id, season, as_of, unit, rule_version, state_version);

-- ================================================================= events
create table if not exists public.cfb_player_events (
  event_id           text primary key,
  player_id          text,
  team_id            text not null,
  season             int not null,
  event_type         text not null,
  event_ts           timestamptz,
  known_at           timestamptz not null,
  source             text not null,
  source_tier        int,
  triggers_refresh   boolean not null default false,
  refresh_reason     text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_player_events_type check (event_type in (
    'AVAILABILITY_REPORTED','AVAILABILITY_CHANGE','AVAILABILITY_CLEARED',
    'NEW_STARTER','RETURNING_STARTER','INJURED_STARTER','BENCHING','TRANSFER_STARTER','MULTI_QB_ROTATION','AMBIGUOUS_STARTER',
    'TRANSFER','ROLE_CHANGE','FIRST_APPEARANCE')),
  constraint cfb_player_events_source check (source in ('official_report','play_by_play','registry','qb_state')),
  constraint cfb_player_events_tier check (source_tier is null or source_tier between 1 and 3),
  -- a report is knowledge only once published; a play-by-play fact only after its game
  constraint cfb_player_events_pit check (event_ts is null or known_at >= event_ts),
  constraint cfb_player_events_reason check (not triggers_refresh or refresh_reason is not null)
);
create index if not exists cfb_player_events_team on public.cfb_player_events (team_id, season, known_at);

-- ======================================================= game snapshots
-- One per game x as_of x personnel version: the lineup scenarios for both
-- teams (probabilities summing to 1), the mixture and the personnel delta
-- relative to the plain pure projection. Written before kickoff, never after.
create table if not exists public.cfb_personnel_game_snapshot (
  snapshot_id        text primary key,
  game_id            text not null,
  season             int not null,
  week               int,
  as_of              timestamptz not null,
  kickoff_ts         timestamptz not null,
  personnel_version  text not null,
  base_model_version text not null,
  input_hash         text not null,
  n_scenarios        int not null,
  scenario_p_sum     numeric not null,
  base_margin        numeric,
  personnel_margin   numeric,
  personnel_sigma    numeric,
  p_home             numeric,
  delta_margin       numeric,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pgs_pit check (as_of < kickoff_ts),
  constraint cfb_pgs_scenarios check (n_scenarios >= 1 and abs(scenario_p_sum - 1) < 1e-6),
  constraint cfb_pgs_prob check (p_home is null or (p_home > 0 and p_home < 1)),
  constraint cfb_pgs_sigma check (personnel_sigma is null or personnel_sigma > 0)
);
create unique index if not exists cfb_personnel_game_snapshot_key
  on public.cfb_personnel_game_snapshot (game_id, as_of, personnel_version, input_hash);

-- ======================================================= model versions
-- Every personnel component is versioned. A status change is a new row
-- (append-only); the current status is the newest row per version.
create table if not exists public.cfb_personnel_model_versions (
  version_row_id     text primary key,
  personnel_version  text not null,
  component          text not null,
  status             text not null,
  base_model_version text,
  decided_at         timestamptz not null,
  decided_by         text,
  evidence           text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_pmv_status check (status in ('RESEARCH','CANDIDATE','CHALLENGER','CHAMPION','RETIRED','REJECTED')),
  constraint cfb_pmv_component check (component in ('identity','usage','player_week_state','qb','skill','defense',
    'special_teams','offensive_line','units','lineup','challenger')),
  -- nothing becomes the champion without a person and the evidence it was judged on
  constraint cfb_pmv_champion check (status <> 'CHAMPION' or (decided_by is not null and evidence is not null))
);

-- ===================================================== append-only + access
create or replace function public.cfb_personnel_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction is a new version)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_players','cfb_player_aliases','cfb_transfer_history','cfb_player_performance',
    'cfb_player_week_state','cfb_depth_chart_state','cfb_personnel_unit_state','cfb_player_events',
    'cfb_personnel_game_snapshot','cfb_personnel_model_versions']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_personnel_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_personnel_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_personnel_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- ================================================================= views
-- The newest version of every player-week state and unit state, the current
-- registry row of every player, and the current status of every personnel
-- component version.
create or replace view public.cfb_player_week_state_current as
select distinct on (s.player_id, s.team_id, s.season, s.as_of, s.rule_version) s.*
  from public.cfb_player_week_state s
 order by s.player_id, s.team_id, s.season, s.as_of, s.rule_version, s.state_version desc;

create or replace view public.cfb_personnel_unit_state_current as
select distinct on (u.team_id, u.season, u.as_of, u.unit, u.rule_version) u.*
  from public.cfb_personnel_unit_state u
 order by u.team_id, u.season, u.as_of, u.unit, u.rule_version, u.state_version desc;

create or replace view public.cfb_players_current as
select distinct on (p.player_id) p.*
  from public.cfb_players p
 order by p.player_id, p.recorded_at desc, p.registry_version desc;

create or replace view public.cfb_personnel_model_status as
select distinct on (v.personnel_version, v.component) v.*
  from public.cfb_personnel_model_versions v
 order by v.personnel_version, v.component, v.decided_at desc, v.recorded_at desc;

do $blk$
declare
  v text;
begin
  foreach v in array array['cfb_player_week_state_current','cfb_personnel_unit_state_current','cfb_players_current',
    'cfb_personnel_model_status']
  loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
    end if;
  end loop;
end $blk$;

notify pgrst, 'reload schema';
