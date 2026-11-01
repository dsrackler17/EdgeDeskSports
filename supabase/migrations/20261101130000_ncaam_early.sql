-- =============================================================================
-- ncaam_early.sql — NCAAM-EARLY (edgedesk_ncaam_early_v1): the T0 observation
-- store of the early-season men's college basketball research model.
-- basketball/ncaam_early/README.md.
--
-- WHAT IT ADDS (every object named ncaam_es_*; `cbb` is college BASEBALL here)
--   ncaam_es_runs               one sync attempt per part (teams, games,
--                               box_team, player_seasons, rosters, portal,
--                               recruits, lines, coaches, availability, moves)
--   ncaam_es_alerts             failures, degradations, refusals (append-only)
--   ncaam_es_config             thresholds the readiness KPIs read
--   ncaam_es_teams, _conferences, _conference_members, _venues
--   ncaam_es_games              schedule and final scores
--   ncaam_es_box_team           per game per team box lines, possessions
--   ncaam_es_player_seasons     player season (and "as of" date) statistics
--   ncaam_es_rosters            POINT-IN-TIME rosters: a team's whole roster is
--   ncaam_es_roster_captures    stored again only when it changes, so the
--                               roster known at any moment is the capture with
--                               the latest captured_at at or before it
--   ncaam_es_portal, _recruits  transfer portal and recruiting entries, a new
--   ncaam_es_lines              row only when an entry changes (append-only)
--   ncaam_es_player_moves       DERIVED: returning / transfer / freshman, with
--   ncaam_es_departed           source level and previous minutes share
--   ncaam_es_team_features      DERIVED T2 features per team per season
--                               (features.js, config/model_v0.json by sha256)
--   ncaam_es_coaches            hand-entered coach records (manual/coaches.json)
--   ncaam_es_availability       hand-entered availability (append-only)
--
-- DATA TERMS. CollegeBasketballData.com forbids publishing its data "as a
-- standalone dataset or bulk download". Every table here is readable ONLY by
-- service_role: row level security is on with no policy, and the client
-- roles' default grants are revoked. Anyone may call ncaam_es_readiness(),
-- which returns KPIs (counts, ages, states), never a row of data.
--
-- WRITES go only through the service-role functions ncaam_es_begin_run,
-- ncaam_es_put, ncaam_es_put_rosters, ncaam_es_replace_derived,
-- ncaam_es_alert and ncaam_es_finish_run.
--
-- CONVENTION (supabase/README.md): idempotent, additive, no psql
-- meta-commands, ends in a report. Mirrored byte for byte in
-- supabase/migrations/20261101130000_ncaam_early.sql.
-- =============================================================================

create extension if not exists pgcrypto;

-- ── 1. runs, alerts, config ──────────────────────────────────────────────────
create table if not exists public.ncaam_es_runs (
  run_id          uuid primary key default gen_random_uuid(),
  part            text not null,
  season          int,
  mode            text not null default 'scheduled' check (mode in ('scheduled', 'backfill', 'manual', 'test')),
  status          text not null default 'running' check (status in ('running', 'ok', 'warn', 'error')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  rows_in         int,
  rows_rejected   int,
  rows_stored     int,
  calls           int,
  quota_remaining int,
  code_sha        text,
  detail          jsonb not null default '{}'::jsonb
);
create index if not exists ncaam_es_runs_part_idx on public.ncaam_es_runs (part, finished_at desc);

create table if not exists public.ncaam_es_alerts (
  id         bigserial primary key,
  run_id     uuid references public.ncaam_es_runs (run_id),
  created_at timestamptz not null default now(),
  severity   text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code       text not null,
  message    text not null
);
create index if not exists ncaam_es_alerts_time_idx on public.ncaam_es_alerts (created_at desc);

create table if not exists public.ncaam_es_config (
  key   text primary key,
  value text not null,
  note  text
);
insert into public.ncaam_es_config (key, value, note) values
  ('games_max_age_hours', '36', 'games and box_team must have an ok run this recent in season'),
  ('box_coverage_min', '0.97', 'share of the season''s finals with a usable box line for both teams'),
  ('quota_warn', '600', 'warn when the shared CBBD/CFBD quota reported remaining falls below this'),
  ('in_season_from', '11-01', 'MM-DD the season''s freshness KPIs start applying'),
  ('in_season_to', '04-15', 'MM-DD they stop applying')
on conflict (key) do nothing;

-- ── 2. reference ─────────────────────────────────────────────────────────────
create table if not exists public.ncaam_es_teams (
  season int not null, team_id int not null, source_id text, school text, display_name text, abbreviation text,
  conference_id int, conference text, venue_id int, venue text, city text, state text,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, team_id)
);
create table if not exists public.ncaam_es_conferences (
  conference_id int primary key, source_id text, name text, abbreviation text, short_name text,
  run_id uuid, updated_at timestamptz not null default now()
);
create table if not exists public.ncaam_es_conference_members (
  conference_id int not null, team_id int not null, team_source_id text, school text, start_season int not null, end_season int,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (conference_id, team_id, start_season)
);
create table if not exists public.ncaam_es_venues (
  venue_id int primary key, source_id text, name text, city text, state text, country text,
  run_id uuid, updated_at timestamptz not null default now()
);

-- ── 3. games and box lines ───────────────────────────────────────────────────
create table if not exists public.ncaam_es_games (
  game_id int primary key, source_id text, season int not null, season_type text, start_utc timestamptz not null, start_tbd boolean,
  status text not null check (status in ('SCHEDULED', 'IN_PROGRESS', 'FINAL', 'POSTPONED', 'CANCELED', 'OTHER')),
  neutral boolean, conf_game boolean, game_type text, tournament text,
  home_team_id int not null, away_team_id int not null, home_conference_id int, away_conference_id int,
  home_points numeric, away_points numeric, venue_id int, venue text, city text, state text, assumed_available_at timestamptz,
  run_id uuid, updated_at timestamptz not null default now()
);
create index if not exists ncaam_es_games_season_idx on public.ncaam_es_games (season, start_utc);

create table if not exists public.ncaam_es_box_team (
  game_id int not null, team_id int not null, season int not null, start_utc timestamptz, opponent_id int,
  is_home boolean, neutral boolean, conf_game boolean, game_minutes numeric, pace_src numeric,
  pts numeric, fgm numeric, fga numeric, tpm numeric, tpa numeric, ftm numeric, fta numeric, orb numeric, drb numeric, tov numeric,
  ast numeric, stl numeric, blk numeric, pf numeric, poss_src numeric,
  opp_pts numeric, opp_fga numeric, opp_fta numeric, opp_orb numeric, opp_drb numeric, opp_tov numeric,
  possessions numeric, opp_possessions numeric, box_ok boolean not null, box_issues text,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (game_id, team_id)
);
create index if not exists ncaam_es_box_team_season_idx on public.ncaam_es_box_team (season, team_id);

-- ── 4. players ───────────────────────────────────────────────────────────────
create table if not exists public.ncaam_es_player_seasons (
  season int not null, team_id int not null, athlete_id int not null, athlete_source_id text, name text, position text,
  as_of date, as_of_key int generated always as (coalesce(as_of - date '2000-01-01', -1)) stored,   -- -1 = the whole season
  games numeric, starts numeric, minutes numeric, points numeric, rebounds numeric, orb numeric, drb numeric,
  assists numeric, steals numeric, blocks numeric, turnovers numeric, fouls numeric,
  fgm numeric, fga numeric, tpm numeric, tpa numeric, ftm numeric, fta numeric,
  usage numeric, ortg numeric, drtg numeric, net_rtg numeric, porpag numeric, efg numeric, ts numeric, ftr numeric, orb_pct numeric,
  ws numeric, ows numeric, dws numeric,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, team_id, athlete_id, as_of_key)
);
create index if not exists ncaam_es_player_seasons_athlete_idx on public.ncaam_es_player_seasons (athlete_id, season);

create table if not exists public.ncaam_es_roster_captures (
  season int not null, team_id int not null, captured_at timestamptz not null, pit text not null check (pit in ('LIVE', 'RETRO')),
  n_players int not null, content_sha text not null,
  run_id uuid, stored_at timestamptz not null default now(),
  primary key (season, team_id, captured_at)
);
create table if not exists public.ncaam_es_rosters (
  season int not null, team_id int not null, player_id int not null, player_source_id text, name text, position text, jersey text,
  height_in numeric, weight_lb numeric, dob text, start_season int, end_season int,
  home_city text, home_state text, home_country text, home_lat numeric, home_lon numeric,
  captured_at timestamptz not null, pit text not null check (pit in ('LIVE', 'RETRO')),
  run_id uuid, stored_at timestamptz not null default now(),
  primary key (season, team_id, player_id, captured_at),
  foreign key (season, team_id, captured_at) references public.ncaam_es_roster_captures (season, team_id, captured_at)
);

create table if not exists public.ncaam_es_portal (
  portal_id int not null, source_id text, year int not null, first_name text, last_name text, position text,
  origin_team_id int, origin_name text, origin_conference text, dest_team_id int, dest_name text, dest_conference text,
  eligibility text, years_remaining int, stars int, rating numeric,
  captured_at timestamptz not null, run_id uuid, stored_at timestamptz not null default now(),
  primary key (portal_id, captured_at)
);
create table if not exists public.ncaam_es_recruits (
  recruit_id int not null, source_id text, year int not null, athlete_id int, name text, position text, school text,
  committed_team_id int, committed_name text, committed_conference text, height_in numeric, weight_lb numeric,
  stars int, rating numeric, ranking int,
  captured_at timestamptz not null, run_id uuid, stored_at timestamptz not null default now(),
  primary key (recruit_id, captured_at)
);
create table if not exists public.ncaam_es_lines (
  game_id int not null, season int not null, provider text not null, spread numeric, over_under numeric, home_ml numeric, away_ml numeric,
  spread_open numeric, over_under_open numeric, tip_utc timestamptz,
  captured_at timestamptz not null, pit text not null check (pit in ('LIVE', 'RETRO')),
  run_id uuid, stored_at timestamptz not null default now(),
  primary key (game_id, provider, captured_at)
);

-- ── 5. derived moves ─────────────────────────────────────────────────────────
create table if not exists public.ncaam_es_player_moves (
  season int not null, player_id int not null, to_team_id int not null, name text, to_conference_id int,
  kind text not null check (kind in ('RETURNING', 'TRANSFER_D1', 'TRANSFER_PORTAL', 'FRESHMAN', 'NEW_UNKNOWN_SOURCE', 'RETURNING_NO_STATS', 'UNKNOWN')),
  evidence text not null, from_team_id int, from_name text,
  from_level text check (from_level is null or from_level in ('D1', 'D2', 'D3', 'NAIA', 'JUCO', 'INTERNATIONAL', 'PREP', 'NON_D1_UNCLASSIFIED')),
  from_level_basis text, from_conference_id int, portal_id int, recruit_id int, stars int, rating numeric, ranking int,
  prev_season int, prev_games numeric, prev_minutes numeric, prev_minutes_share numeric, prev_usage numeric, prev_porpag numeric, prev_points numeric,
  roster_captured_at timestamptz, roster_pit text,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, player_id, to_team_id)
);
create table if not exists public.ncaam_es_departed (
  season int not null, player_id int not null, from_team_id int not null, name text, to_team_id int,
  destination text not null check (destination in ('D1_ROSTER', 'LEFT_OR_UNKNOWN')),
  prev_games numeric, prev_minutes numeric, prev_minutes_share numeric, prev_points numeric, prev_usage numeric, prev_porpag numeric,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, player_id, from_team_id)
);

create table if not exists public.ncaam_es_team_features (
  season int not null, team_id int not null, as_of_key text not null default 'PRESEASON',
  config_version text not null, config_sha256 text not null,
  roster_off numeric, roster_def numeric, roster_net numeric,
  prev_off numeric, prev_allow numeric, prev_net numeric, prev_tempo numeric,
  returning_minutes_share numeric, returning_value_share numeric,
  minutes_share_returning numeric, minutes_share_transfer_d1 numeric, minutes_share_non_d1 numeric, minutes_share_freshman numeric, minutes_share_unknown numeric,
  departed_minutes_share numeric, departed_points numeric, departed_value_lost numeric,
  coach_change boolean, coach_tenure_years int, coach_prior_level text, coach_tempo_resid numeric,
  height_in_avg numeric, blk_rate numeric, orb_pct numeric, player_uncertainty numeric, variance_multiplier numeric,
  flags jsonb not null default '[]'::jsonb, detail jsonb not null default '{}'::jsonb,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, team_id, as_of_key)
);

-- ── 6. hand-entered observations ─────────────────────────────────────────────
create table if not exists public.ncaam_es_coaches (
  season int not null, team_id int not null, team_name text not null, coach text not null, first_season_at_school int not null,
  prior_job jsonb not null, career jsonb not null default '[]'::jsonb, source_urls jsonb not null,
  confidence text not null check (confidence in ('confirmed', 'reported')), entered_by text not null, entered_at timestamptz not null,
  run_id uuid, updated_at timestamptz not null default now(),
  primary key (season, team_id)
);
create table if not exists public.ncaam_es_availability (
  id text primary key, season int not null, team_id int not null, game_id int, game_date date, player_id int, player_name text not null,
  status text not null, source_url text not null, published_at timestamptz not null, entered_at timestamptz not null, entered_by text not null,
  confidence_note text not null, supersedes text,
  run_id uuid, stored_at timestamptz not null default now()
);

-- ── 7. append-only and immutability guards ───────────────────────────────────
create or replace function public.ncaam_es_refuse_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % is refused (a correction is a new row)', tg_table_name, lower(tg_op);
end $$;
do $t$
declare t text;
begin
  foreach t in array array['ncaam_es_alerts', 'ncaam_es_roster_captures', 'ncaam_es_rosters', 'ncaam_es_portal', 'ncaam_es_recruits', 'ncaam_es_lines', 'ncaam_es_availability'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_append_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before update or delete on public.%I for each row execute function public.ncaam_es_refuse_change()', t || '_append_only', t);
    end if;
    if not exists (select 1 from pg_trigger where tgname = t || '_no_truncate' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.ncaam_es_refuse_change()', t || '_no_truncate', t);
    end if;
  end loop;
end $t$;

create or replace function public.ncaam_es_run_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'ncaam_es_runs: a run is never deleted'; end if;
  if old.status <> 'running' then raise exception 'ncaam_es_runs: run % is finished (%) and cannot change', old.run_id, old.status; end if;
  return new;
end $$;
do $t$
begin
  if not exists (select 1 from pg_trigger where tgname = 'ncaam_es_runs_guard' and tgrelid = 'public.ncaam_es_runs'::regclass) then
    create trigger ncaam_es_runs_guard before update or delete on public.ncaam_es_runs for each row execute function public.ncaam_es_run_guard();
  end if;
end $t$;

-- ── 8. no client reads: RLS on, no policy, default grants revoked ────────────
do $g$
declare t text;
begin
  foreach t in array array['ncaam_es_runs', 'ncaam_es_alerts', 'ncaam_es_config', 'ncaam_es_teams', 'ncaam_es_conferences', 'ncaam_es_conference_members', 'ncaam_es_venues',
                           'ncaam_es_games', 'ncaam_es_box_team', 'ncaam_es_player_seasons', 'ncaam_es_roster_captures', 'ncaam_es_rosters', 'ncaam_es_portal',
                           'ncaam_es_recruits', 'ncaam_es_lines', 'ncaam_es_player_moves', 'ncaam_es_departed', 'ncaam_es_team_features', 'ncaam_es_coaches', 'ncaam_es_availability'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
  revoke all on sequence public.ncaam_es_alerts_id_seq from public, anon, authenticated;
  grant usage, select on sequence public.ncaam_es_alerts_id_seq to service_role;
end $g$;

-- ── 9. writes (service_role only) ────────────────────────────────────────────
create or replace function public.ncaam_es_begin_run(p_part text, p_season int, p_mode text, p_code_sha text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if p_part is null or p_part !~ '^[a-z_]+$' then raise exception 'ncaam_es_begin_run: a part name (a-z, _) is required'; end if;
  insert into public.ncaam_es_runs (part, season, mode, code_sha) values (p_part, p_season, coalesce(p_mode, 'scheduled'), p_code_sha) returning run_id into r;
  return r;
end $$;

/* the tables ncaam_es_put accepts, with how it writes them:
     upsert    insert, or update the row with the same primary key
     snapshot  append a row only when it differs from the latest row of its key */
create or replace function public.ncaam_es_put_kind(p_table text) returns text language sql immutable as $$
  select case p_table
    when 'ncaam_es_teams' then 'upsert' when 'ncaam_es_conferences' then 'upsert' when 'ncaam_es_conference_members' then 'upsert'
    when 'ncaam_es_venues' then 'upsert' when 'ncaam_es_games' then 'upsert' when 'ncaam_es_box_team' then 'upsert'
    when 'ncaam_es_player_seasons' then 'upsert' when 'ncaam_es_coaches' then 'upsert'
    when 'ncaam_es_player_moves' then 'upsert' when 'ncaam_es_departed' then 'upsert' when 'ncaam_es_team_features' then 'upsert'
    when 'ncaam_es_portal' then 'snapshot' when 'ncaam_es_recruits' then 'snapshot' when 'ncaam_es_lines' then 'snapshot'
    when 'ncaam_es_availability' then 'append'
    else null end
$$;
create or replace function public.ncaam_es_snapshot_key(p_table text) returns text[] language sql immutable as $$
  select case p_table when 'ncaam_es_portal' then array['portal_id'] when 'ncaam_es_recruits' then array['recruit_id']
                      when 'ncaam_es_lines' then array['game_id', 'provider'] end
$$;

create or replace function public.ncaam_es_put(p_run uuid, p_table text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text := public.ncaam_es_put_kind(p_table);
  cols text; sel text; pk text; setl text; diff text; keyc text[]; keyeq text; content text; n int := 0; ins int := 0; upd int := 0;
begin
  if k is null then raise exception 'ncaam_es_put: % is not a table it writes', p_table; end if;
  if not exists (select 1 from public.ncaam_es_runs where run_id = p_run and status = 'running') then raise exception 'ncaam_es_put: run % is not running', p_run; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ncaam_es_put: rows must be a JSON array'; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         /* a key the row does not carry takes the column's own default (jsonb_populate_recordset
            would otherwise write null over it) */
         string_agg(case a.attname when 'run_id' then quote_literal(p_run) || '::uuid' when 'updated_at' then 'now()' when 'stored_at' then 'now()'
                      else case when d.adbin is not null then 'coalesce(r.' || quote_ident(a.attname) || ', ' || pg_get_expr(d.adbin, d.adrelid) || ')' else 'r.' || quote_ident(a.attname) end end, ', ' order by a.attnum)
    into cols, sel
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  select string_agg(quote_ident(a.attname), ', ' order by array_position(i.indkey::int2[], a.attnum))
    into pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = ('public.' || p_table)::regclass and i.indisprimary;
  if k = 'upsert' then
    /* an unchanged row is left alone and counted unchanged; a DERIVED row
       (moves, departed) is always claimed by this run (run_id), so that
       ncaam_es_replace_derived can tell a stale row from a current one */
    select string_agg(quote_ident(a.attname) || ' = excluded.' || quote_ident(a.attname), ', ' order by a.attnum),
           string_agg('t.' || quote_ident(a.attname) || ' is distinct from excluded.' || quote_ident(a.attname), ' or ' order by a.attnum)
           filter (where a.attname <> 'updated_at' and (a.attname <> 'run_id' or p_table in ('ncaam_es_player_moves', 'ncaam_es_departed', 'ncaam_es_team_features')))
      into setl, diff
      from pg_attribute a
     where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname not in (select a2.attname from pg_index i join pg_attribute a2 on a2.attrelid = i.indrelid and a2.attnum = any (i.indkey) where i.indrelid = ('public.' || p_table)::regclass and i.indisprimary);
    execute format('with w as (insert into public.%I as t (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) r on conflict (%s) do update set %s where %s returning (xmax = 0) as inserted) select count(*) filter (where inserted), count(*) filter (where not inserted) from w',
                   p_table, cols, sel, p_table, pk, setl, coalesce(diff, 'false'))
      using p_rows into ins, upd;
  elsif k = 'snapshot' then
    keyc := public.ncaam_es_snapshot_key(p_table);
    select string_agg('l.' || quote_ident(x) || ' = r.' || quote_ident(x), ' and ') into keyeq from unnest(keyc) x;
    select string_agg('l.' || quote_ident(a.attname) || ' is not distinct from r.' || quote_ident(a.attname), ' and ' order by a.attnum)
      into content
      from pg_attribute a
     where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname not in ('captured_at', 'pit', 'run_id', 'stored_at') and not (a.attname = any (keyc));
    execute format('with w as (insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) r '
                   || 'where not exists (select 1 from (select * from public.%I l where %s order by l.captured_at desc limit 1) l where %s) '
                   || 'on conflict (%s) do nothing returning 1) select count(*) from w',
                   p_table, cols, sel, p_table, p_table, keyeq, content, pk)
      using p_rows into ins;
  else
    execute format('with w as (insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) r on conflict (%s) do nothing returning 1) select count(*) from w',
                   p_table, cols, sel, p_table, pk)
      using p_rows into ins;
  end if;
  n := jsonb_array_length(p_rows);
  return jsonb_build_object('table', p_table, 'received', n, 'inserted', ins, 'updated', upd, 'unchanged', n - ins - upd);
end $$;

/* a team's whole roster, stored again only when it differs from the team's
   latest stored capture (same players, same fields) */
create or replace function public.ncaam_es_put_rosters(p_run uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; latest text; teams_new int := 0; teams_same int := 0; players int := 0;
begin
  if not exists (select 1 from public.ncaam_es_runs where run_id = p_run and status = 'running') then raise exception 'ncaam_es_put_rosters: run % is not running', p_run; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ncaam_es_put_rosters: rows must be a JSON array'; end if;
  for g in
    select r.season, r.team_id, min(r.captured_at) as captured_at, min(r.pit) as pit, max(r.pit) as pit2, count(distinct r.captured_at) as n_at, count(*) as n,
           md5(string_agg(md5(row(r.player_id, r.player_source_id, r.name, r.position, r.jersey, r.height_in, r.weight_lb, r.dob, r.start_season, r.end_season,
                                  r.home_city, r.home_state, r.home_country, r.home_lat, r.home_lon)::text), ',' order by r.player_id)) as sha
      from jsonb_populate_recordset(null::public.ncaam_es_rosters, p_rows) r
     group by r.season, r.team_id
  loop
    if g.n_at <> 1 or g.pit <> g.pit2 then raise exception 'ncaam_es_put_rosters: team % season % has more than one capture time or pit in one call', g.team_id, g.season; end if;
    select c.content_sha into latest from public.ncaam_es_roster_captures c where c.season = g.season and c.team_id = g.team_id order by c.captured_at desc limit 1;
    if latest is not distinct from g.sha then teams_same := teams_same + 1; continue; end if;
    insert into public.ncaam_es_roster_captures (season, team_id, captured_at, pit, n_players, content_sha, run_id) values (g.season, g.team_id, g.captured_at, g.pit, g.n, g.sha, p_run)
      on conflict do nothing;
    insert into public.ncaam_es_rosters (season, team_id, player_id, player_source_id, name, position, jersey, height_in, weight_lb, dob, start_season, end_season,
                                         home_city, home_state, home_country, home_lat, home_lon, captured_at, pit, run_id)
      select r.season, r.team_id, r.player_id, r.player_source_id, r.name, r.position, r.jersey, r.height_in, r.weight_lb, r.dob, r.start_season, r.end_season,
             r.home_city, r.home_state, r.home_country, r.home_lat, r.home_lon, r.captured_at, r.pit, p_run
        from jsonb_populate_recordset(null::public.ncaam_es_rosters, p_rows) r where r.season = g.season and r.team_id = g.team_id
      on conflict do nothing;
    teams_new := teams_new + 1; players := players + g.n;
  end loop;
  return jsonb_build_object('table', 'ncaam_es_rosters', 'received', jsonb_array_length(p_rows), 'teams_changed', teams_new, 'teams_unchanged', teams_same, 'inserted', players);
end $$;

/* derived rows of one season: the rows this run did not write are stale
   (a player who left the roster since the last derivation, a team no longer
   derived) and are removed. A moves run replaces moves and departures; a
   features run replaces that season's features. */
create or replace function public.ncaam_es_replace_derived(p_run uuid, p_season int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m int; d int; f int; pt text;
begin
  select part into pt from public.ncaam_es_runs where run_id = p_run and status = 'running' and part in ('moves', 'features') and season = p_season;
  if pt is null then
    raise exception 'ncaam_es_replace_derived: run % is not a running moves or features run for season %', p_run, p_season;
  end if;
  if pt = 'features' then
    delete from public.ncaam_es_team_features where season = p_season and run_id is distinct from p_run;
    get diagnostics f = row_count;
    return jsonb_build_object('stale_features_removed', f);
  end if;
  delete from public.ncaam_es_player_moves where season = p_season and run_id is distinct from p_run;
  get diagnostics m = row_count;
  delete from public.ncaam_es_departed where season = p_season and run_id is distinct from p_run;
  get diagnostics d = row_count;
  return jsonb_build_object('stale_moves_removed', m, 'stale_departed_removed', d);
end $$;

create or replace function public.ncaam_es_alert(p_run uuid, p_severity text, p_code text, p_message text)
returns bigint language plpgsql security definer set search_path = public as $$
declare i bigint;
begin
  insert into public.ncaam_es_alerts (run_id, severity, code, message) values (p_run, p_severity, p_code, left(p_message, 2000)) returning id into i;
  return i;
end $$;

create or replace function public.ncaam_es_finish_run(p_run uuid, p_status text, p_rows_in int, p_rows_rejected int, p_rows_stored int, p_calls int, p_quota_remaining int, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('ok', 'warn', 'error') then raise exception 'ncaam_es_finish_run: status must be ok, warn or error'; end if;
  update public.ncaam_es_runs set status = p_status, finished_at = now(), rows_in = p_rows_in, rows_rejected = p_rows_rejected, rows_stored = p_rows_stored,
         calls = p_calls, quota_remaining = p_quota_remaining, detail = coalesce(p_detail, '{}'::jsonb)
   where run_id = p_run and status = 'running';
  if not found then raise exception 'ncaam_es_finish_run: run % is not running', p_run; end if;
end $$;

-- ── 10. readiness (anyone; KPIs only, never a row of data) ───────────────────
create or replace function public.ncaam_es_cfg(p_key text) returns text language sql stable security definer set search_path = public as $$
  select value from public.ncaam_es_config where key = p_key
$$;

create or replace function public.ncaam_es_readiness()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  season_now int; in_season boolean; parts jsonb; fin int; box2 int; cov numeric; quota int; reasons text[] := '{}'; state text;
  age_games numeric; age_box numeric; f24 int; ros_live int; ros_any int; teams_n int; coach_n int; avail_n int; last_final timestamptz; md text := to_char(now() at time zone 'utc', 'MM-DD');
begin
  if not exists (select 1 from public.ncaam_es_runs) then
    return jsonb_build_object('checked_at', now(), 'state', 'not_started', 'reasons', jsonb_build_array('no sync has run yet'));
  end if;
  in_season := case when public.ncaam_es_cfg('in_season_from') <= public.ncaam_es_cfg('in_season_to') then md between public.ncaam_es_cfg('in_season_from') and public.ncaam_es_cfg('in_season_to')
                    else md >= public.ncaam_es_cfg('in_season_from') or md <= public.ncaam_es_cfg('in_season_to') end;
  select max(season) into season_now from public.ncaam_es_games where start_utc <= now() + interval '14 days';
  select coalesce(jsonb_agg(p order by p->>'part'), '[]'::jsonb) into parts from (
    select jsonb_build_object('part', r.part,
             'last_ok_at', max(r.finished_at) filter (where r.status in ('ok', 'warn')),
             'age_hours', round(extract(epoch from now() - max(r.finished_at) filter (where r.status in ('ok', 'warn'))) / 3600.0, 1),
             'last_status', (array_agg(r.status order by r.started_at desc))[1],
             'failures_24h', count(*) filter (where r.status = 'error' and r.started_at > now() - interval '24 hours'),
             'consecutive_failures', (select count(*) from public.ncaam_es_runs x where x.part = r.part and x.status = 'error'
                                       and x.started_at > coalesce((select max(y.started_at) from public.ncaam_es_runs y where y.part = r.part and y.status in ('ok', 'warn')), '-infinity'::timestamptz)),
             'rows_stored_last', (array_agg(r.rows_stored order by r.started_at desc) filter (where r.status in ('ok', 'warn')))[1]) as p
      from public.ncaam_es_runs r where r.mode <> 'test' group by r.part) s;
  select (p->>'age_hours')::numeric into age_games from jsonb_array_elements(parts) p where p->>'part' = 'games';
  select (p->>'age_hours')::numeric into age_box from jsonb_array_elements(parts) p where p->>'part' = 'box_team';
  select count(*) into fin from public.ncaam_es_games where season = season_now and status = 'FINAL' and assumed_available_at <= now();
  select count(*) into box2 from public.ncaam_es_games g where g.season = season_now and g.status = 'FINAL' and g.assumed_available_at <= now()
     and (select count(*) from public.ncaam_es_box_team b where b.game_id = g.game_id and b.box_ok) = 2;
  cov := case when fin > 0 then round(box2::numeric / fin, 4) end;
  select max(start_utc) into last_final from public.ncaam_es_games where season = season_now and status = 'FINAL';
  select quota_remaining into quota from public.ncaam_es_runs where quota_remaining is not null and mode <> 'test' order by finished_at desc nulls last limit 1;
  select count(*) into f24 from public.ncaam_es_alerts where severity = 'FAILURE' and created_at > now() - interval '24 hours';
  select count(distinct team_id) filter (where pit = 'LIVE'), count(distinct team_id) into ros_live, ros_any from public.ncaam_es_roster_captures where season = season_now;
  select count(*) into teams_n from public.ncaam_es_teams where season = season_now;
  select count(*) into coach_n from public.ncaam_es_coaches where season = season_now;
  select count(*) into avail_n from public.ncaam_es_availability where season = season_now;
  if in_season and (age_games is null or age_games > public.ncaam_es_cfg('games_max_age_hours')::numeric) then reasons := reasons || ('games: no ok sync in ' || public.ncaam_es_cfg('games_max_age_hours') || ' h'); end if;
  if in_season and (age_box is null or age_box > public.ncaam_es_cfg('games_max_age_hours')::numeric) then reasons := reasons || ('box_team: no ok sync in ' || public.ncaam_es_cfg('games_max_age_hours') || ' h'); end if;
  if f24 > 0 then reasons := reasons || (f24 || ' failure alert(s) in 24 h'); end if;
  if cov is not null and cov < public.ncaam_es_cfg('box_coverage_min')::numeric then reasons := reasons || ('box coverage ' || cov || ' < ' || public.ncaam_es_cfg('box_coverage_min')); end if;
  if quota is not null and quota < public.ncaam_es_cfg('quota_warn')::int then reasons := reasons || ('shared CBBD/CFBD quota: ' || quota || ' calls remaining'); end if;
  if exists (select 1 from jsonb_array_elements(parts) p where (p->>'consecutive_failures')::int >= 2) then reasons := reasons || 'a part failed twice in a row'::text; end if;
  state := case when array_length(reasons, 1) is null then 'ok'
                when exists (select 1 from jsonb_array_elements(parts) p where (p->>'consecutive_failures')::int >= 2) or f24 > 0 then 'down'
                else 'warn' end;
  return jsonb_build_object('checked_at', now(), 'state', state, 'reasons', to_jsonb(reasons), 'season', season_now, 'in_season', in_season,
    'parts', parts,
    'completeness', jsonb_build_object('finals_available', fin, 'finals_with_both_box_lines', box2, 'box_coverage', cov,
                                       'teams', teams_n, 'teams_with_roster', ros_any, 'teams_with_live_roster', ros_live,
                                       'coach_records', coach_n, 'availability_entries', avail_n),
    'latency', jsonb_build_object('latest_final_tip', last_final, 'games_age_hours', age_games, 'box_age_hours', age_box),
    'quota_remaining', quota);
end $$;

-- execute: writers to service_role only; readiness to everyone
do $x$
declare f text;
begin
  foreach f in array array['public.ncaam_es_begin_run(text,int,text,text)', 'public.ncaam_es_put(uuid,text,jsonb)', 'public.ncaam_es_put_rosters(uuid,jsonb)',
                           'public.ncaam_es_replace_derived(uuid,int)', 'public.ncaam_es_alert(uuid,text,text,text)',
                           'public.ncaam_es_finish_run(uuid,text,int,int,int,int,int,jsonb)', 'public.ncaam_es_cfg(text)',
                           'public.ncaam_es_put_kind(text)', 'public.ncaam_es_snapshot_key(text)', 'public.ncaam_es_refuse_change()', 'public.ncaam_es_run_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  revoke all on function public.ncaam_es_readiness() from public;
  grant execute on function public.ncaam_es_readiness() to anon, authenticated, service_role;
end $x$;

-- ── report ───────────────────────────────────────────────────────────────────
select check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status from (
  select '1 the twenty ncaam_es tables exist' as check_name,
         (select count(*) from pg_tables where schemaname = 'public' and tablename like 'ncaam\_es\_%')::text as got, '20' as want
  union all
  select '2 row level security is on for every one of them',
         (select count(*) from pg_tables where schemaname = 'public' and tablename like 'ncaam\_es\_%' and rowsecurity)::text, '20'
  union all
  select '3 no client role can read or write any of them',
         (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name like 'ncaam\_es\_%' and grantee in ('anon', 'authenticated'))::text, '0'
  union all
  select '4 the append-only guards are in place',
         (select count(*) from pg_trigger where tgname like 'ncaam\_es\_%\_append\_only')::text, '7'
  union all
  select '5 no client role can call a writer',
         (select count(*) from information_schema.role_routine_grants where routine_schema = 'public' and routine_name like 'ncaam\_es\_%' and routine_name <> 'ncaam_es_readiness' and grantee in ('anon', 'authenticated'))::text, '0'
  union all
  select '6 the readiness function answers', case when (public.ncaam_es_readiness() ? 'state') then 'yes' else 'no' end, 'yes'
) r;
