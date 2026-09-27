-- tennis_record -- part 2 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- What was wrong with a row, kept rather than discarded. A quarantined row is
-- evidence: it says the source changed shape, or that a player id collided, or
-- that a "match" lasted four minutes. Silence would say nothing changed.
create table if not exists tennis.data_quality_issues (
  issue_id       bigserial primary key,
  run_id         uuid references tennis.ingestion_runs (run_id) on delete set null,
  source_key     text,
  issue_type     text not null,
  severity       text not null default 'warn',
  entity_type    text,                              -- 'match','player','tournament','venue','rating'
  entity_key     text,
  field          text,
  observed       text,
  expected       text,
  detail         text,
  payload        jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  occurrences    integer not null default 1,
  resolved_at    timestamptz,
  constraint tennis_dq_severity_shape check (severity in ('info','warn','error','fatal')),
  constraint tennis_dq_type_shape check (issue_type in (
    'malformed_record','unresolved_player','duplicate_identifier','impossible_statistic',
    'missing_surface','ambiguous_venue','stale_rating','missing_feature','score_unparsed',
    'out_of_range','source_conflict','license_refused','reconciliation_gap'))
);
create index if not exists tennis_dq_type_idx on tennis.data_quality_issues (issue_type, last_seen_at desc);
create index if not exists tennis_dq_run_idx  on tennis.data_quality_issues (run_id);
create index if not exists tennis_dq_open_idx on tennis.data_quality_issues (resolved_at) where resolved_at is null;
-- One open issue per (type, entity, field): a second sighting bumps the count
-- rather than writing a second row, so a recurring fault is one line with a
-- number on it instead of ten thousand.
create unique index if not exists tennis_dq_dedup_idx
  on tennis.data_quality_issues (issue_type, coalesce(entity_type,''), coalesce(entity_key,''), coalesce(field,''))
  where resolved_at is null;

-- ===========================================================================
-- LAYER 1 — RAW / STAGING. The import surface. PRIVATE: no client role reads
-- it, ever. Every column is text because a staging table that types its input
-- has already made a decision about data it has not validated.
-- ===========================================================================

create table if not exists tennis.stg_archive_matches (
  stg_id            bigserial primary key,
  run_id            uuid not null references tennis.ingestion_runs (run_id) on delete cascade,
  row_number        bigint,
  -- the 108-column source contract, verbatim, in source order
  tourney_id text, tourney_name text, surface text, draw_size text, tourney_level text,
  tourney_date text, match_num text,
  winner_id text, winner_seed text, winner_entry text, winner_name text, winner_hand text,
  winner_ht text, winner_ioc text, winner_age text,
  loser_id text, loser_seed text, loser_entry text, loser_name text, loser_hand text,
  loser_ht text, loser_ioc text, loser_age text,
  score text, best_of text, round text, minutes text,
  w_ace text, w_df text, w_svpt text, w_1stin text, w_1stwon text, w_2ndwon text,
  w_svgms text, w_bpsaved text, w_bpfaced text,
  l_ace text, l_df text, l_svpt text, l_1stin text, l_1stwon text, l_2ndwon text,
  l_svgms text, l_bpsaved text, l_bpfaced text,
  winner_rank text, winner_rank_points text, loser_rank text, loser_rank_points text,
  tour text, source_year text,
  winner_elo_pre text, winner_surface_elo_pre text,
  winner_win_pct_30d_pre text, winner_win_pct_90d_pre text, winner_win_pct_365d_pre text,
  winner_matches_7d_pre text, winner_matches_14d_pre text, winner_rest_days_pre text,
  winner_career_surface_win_pct_pre text, winner_career_surface_matches_pre text,
  loser_elo_pre text, loser_surface_elo_pre text,
  loser_win_pct_30d_pre text, loser_win_pct_90d_pre text, loser_win_pct_365d_pre text,
  loser_matches_7d_pre text, loser_matches_14d_pre text, loser_rest_days_pre text,
  loser_career_surface_win_pct_pre text, loser_career_surface_matches_pre text,
  winner_ace_rate text, winner_double_fault_rate text, winner_first_serve_in_pct text,
  winner_first_serve_won_pct text, winner_second_serve_won_pct text, winner_break_points_saved_pct text,
  loser_ace_rate text, loser_double_fault_rate text, loser_first_serve_in_pct text,
  loser_first_serve_won_pct text, loser_second_serve_won_pct text, loser_break_points_saved_pct text,
  elo_prob_winner_pre text, surface_elo_prob_winner_pre text,
  weather_query text, venue_name text, venue_country text, latitude text, longitude text,
  timezone text, geocode_confidence text, environment text, event_end_date text,
  weather_temp_mean_f text, weather_temp_max_f text, weather_temp_min_f text,
  weather_humidity_mean_pct text, weather_precip_week_in text, weather_wind_mean_mph text,
  weather_gust_max_mph text, weather_solar_week_mj_m2 text, weather_days_covered text,
  weather_precision text,
  match_uid text, surface_group text, data_source text, weather_source text,
  -- what the loader decided about it
  reject_reason     text,
  loaded_at         timestamptz not null default now()
);
create index if not exists tennis_stg_run_idx on tennis.stg_archive_matches (run_id);
create index if not exists tennis_stg_uid_idx on tennis.stg_archive_matches (match_uid);
create index if not exists tennis_stg_reject_idx on tennis.stg_archive_matches (run_id) where reject_reason is not null;

-- ===========================================================================
-- LAYER 2 — ENTITIES.
-- ===========================================================================

-- PLAYERS. The licensed record's identity table, and the one tools/tennis/db.js
-- has always preferred over the provider directory. player_id is the stable
-- source id namespaced by its source and tour, so two archives can never
-- collide and so a provider id can never be mistaken for a licensed one.
create table if not exists tennis.players (
  player_id          text primary key,                  -- 'archive:ATP:104925'
  player_uuid        uuid not null default gen_random_uuid(),
  tour               text not null,
  source_key         text not null default 'archive',
  source_player_id   text not null,
  full_name          text not null,
  -- the folded key identity is compared on; lib/tennis_research.js normName()
  -- produces the same string in JavaScript and the two are tested against
  -- each other, so a name resolves the same on the server and on the page
  name_norm          text not null,
  country            text,
  plays              text,                              -- 'R' / 'L' / 'U' / null
  height_cm          integer,
  birth_date         date,
  latest_age         numeric(5,2),                      -- the archive publishes age, not birth date
  latest_age_on      date,
  first_match        date,
  last_match         date,
  matches_on_file    integer not null default 0,
  active             boolean,
  source_version     text,
  ingestion_run_id   uuid references tennis.ingestion_runs (run_id) on delete set null,
  source_updated_at  timestamptz,
  ingested_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint tennis_players_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_players_id_shape check (player_id like '%:%'),
  constraint tennis_players_plays_shape check (plays is null or plays in ('R','L','A','U')),
  constraint tennis_players_height_shape check (height_cm is null or (height_cm between 120 and 250)),
  -- THE UNIQUENESS RULE: one player per (source, tour, source id). The same
  -- person appearing on two tours is two rows because the archives are two
  -- archives; the same person appearing twice in one archive is a bug and the
  -- database says so rather than storing both.
  constraint tennis_players_source_key_unique unique (source_key, tour, source_player_id),
  constraint tennis_players_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_players_name_idx on tennis.players (name_norm);
create index if not exists tennis_players_tour_name_idx on tennis.players (tour, name_norm);
create index if not exists tennis_players_lastmatch_idx on tennis.players (tour, last_match desc nulls last);
create index if not exists tennis_players_uuid_idx on tennis.players (player_uuid);
drop trigger if exists tennis_players_touch on tennis.players;
create trigger tennis_players_touch before update on tennis.players
  for each row execute function tennis.touch_updated_at();
drop trigger if exists tennis_players_license on tennis.players;
create trigger tennis_players_license before insert or update on tennis.players
  for each row execute function tennis.enforce_source_license();

-- VENUES. Identity, separated from the weather observed at it. The archive
-- resolves a venue by NAME, which is a guess of known quality, so the quality
-- is stored with it and nothing downstream may use a venue without seeing it.
create table if not exists tennis.venues (
  venue_id           text primary key,                  -- 'archive:<folded tourney name>'
  source_key         text not null default 'archive',
  venue_name         text,
  tourney_name       text,
  city               text,
  country            text,
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  timezone           text,
  environment        text not null default 'unknown',
  resolution_method  text,                              -- 'name_inferred', 'geocoded', 'manual'
  resolution_confidence text not null default 'unknown',
  weather_query      text,
  ingestion_run_id   uuid references tennis.ingestion_runs (run_id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint tennis_venues_env_shape check (environment in ('indoor','outdoor','unknown')),
  constraint tennis_venues_conf_shape
    check (resolution_confidence in ('exact','high','name_inferred','low','unknown')),
  constraint tennis_venues_lat_shape check (latitude is null or (latitude between -90 and 90)),
  constraint tennis_venues_lon_shape check (longitude is null or (longitude between -180 and 180)),
  constraint tennis_venues_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_venues_name_idx on tennis.venues (lower(coalesce(tourney_name, venue_name)));
create index if not exists tennis_venues_geo_idx on tennis.venues (latitude, longitude)
  where latitude is not null and longitude is not null;
drop trigger if exists tennis_venues_touch on tennis.venues;
create trigger tennis_venues_touch before update on tennis.venues
  for each row execute function tennis.touch_updated_at();

-- TOURNAMENTS — EXTENDED, NOT REPLACED.
--
-- tennis.tournaments already exists (supabase/tennis_live_center.sql) and is
-- already multi-provider. The archive's events are the same kind of thing, so
-- they are added to it under provider 'archive' with ids 'archive:<TOUR>:<id>'.
-- Every existing read is keyed by tournament_id or filtered to
-- state in ('scheduled','live'); an archived event is 'final', so nothing the
-- live centre does can see one. These columns are what the archive carries and
-- the live feed does not.
--
-- If the live contract has not been applied yet, the table is created here in
-- the shape that file defines, so either apply order works.
create table if not exists tennis.tournaments (
  tournament_id           text primary key,
  provider                text not null default 'espn',
  provider_tournament_id  text not null,
  tour                    text not null,
  name                    text,
  short_name              text,
  level                   text,
  surface                 text,
  indoor                  boolean,
  venue                   text,
  city                    text,
  country                 text,
  timezone                text,
  start_date              date,
  end_date                date,
  draw_size               integer,
  state                   text not null default 'scheduled',
  matches_total           integer,
  matches_completed       integer,
  matches_live            integer,
  source                  text,
  source_url              text,
  source_updated_at       timestamptz,
  ingested_at             timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint tennis_tournaments_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_tournaments_state_shape check
    (state in ('scheduled','live','final','cancelled','postponed','stale')),
  constraint tennis_tournaments_surface_shape check
    (surface is null or surface in ('hard','clay','grass','carpet','unknown')),
  constraint tennis_tournaments_provider_key unique (provider, provider_tournament_id)
);

alter table tennis.tournaments add column if not exists season            integer;
alter table tennis.tournaments add column if not exists surface_group     text;
alter table tennis.tournaments add column if not exists environment       text;
alter table tennis.tournaments add column if not exists venue_id          text;
alter table tennis.tournaments add column if not exists latitude          numeric(9,6);
alter table tennis.tournaments add column if not exists longitude         numeric(9,6);
alter table tennis.tournaments add column if not exists venue_confidence  text;
alter table tennis.tournaments add column if not exists source_key        text;
alter table tennis.tournaments add column if not exists source_version    text;
alter table tennis.tournaments add column if not exists ingestion_run_id  uuid;

-- Constraints added separately so a re-run never fails on one that exists, and
-- so this file can be applied to a table the live contract already populated.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tennis_tournaments_env_shape') then
    alter table tennis.tournaments add constraint tennis_tournaments_env_shape
      check (environment is null or environment in ('indoor','outdoor','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tennis_tournaments_venue_fk') then
    alter table tennis.tournaments add constraint tennis_tournaments_venue_fk
      foreign key (venue_id) references tennis.venues (venue_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tennis_tournaments_source_fk') then
    alter table tennis.tournaments add constraint tennis_tournaments_source_fk
      foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tennis_tournaments_run_fk') then
    alter table tennis.tournaments add constraint tennis_tournaments_run_fk
      foreign key (ingestion_run_id) references tennis.ingestion_runs (run_id) on delete set null;
  end if;
end $$;

create index if not exists tennis_tournaments_season_idx on tennis.tournaments (tour, season desc);
create index if not exists tennis_tournaments_provider_idx on tennis.tournaments (provider, start_date desc);
create index if not exists tennis_tournaments_surface_date_idx on tennis.tournaments (surface, start_date desc);
