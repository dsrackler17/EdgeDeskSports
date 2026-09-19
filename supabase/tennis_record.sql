-- ===========================================================================
-- EdgeDesk Tennis — the RESEARCH RECORD contract (ATP + WTA).
--
-- WHY THIS FILE EXISTS. app.html has read `tennis.players`, `tennis.matches`,
-- `tennis.rankings_current` and the five record views since the Tennis panel
-- shipped, tools/tennis/db.js resolves identity against them, and
-- build_baselines.js counts career, surface and form from them. None of it was
-- ever installed: the module's own comment points at a migration
-- ("migrations/020_tennis_schema.sql") that is in no repository, and the panel
-- has rendered its honest empty state ever since — "The database refuses to
-- store any source not cleared for commercial use, so this module is empty
-- until a licensed feed is loaded."
--
-- This is that schema, and it is that refusal made real. The claim on screen
-- was a promise about a database that did not exist yet; every table below
-- that stores a match carries a source key, and a trigger checks that key
-- against tennis.source_licenses before the row is allowed in. The historical
-- archive EdgeDesk holds is CC BY-NC-SA 4.0 — research, non-commercial,
-- share-alike — so it is registered as exactly that, admitted for research,
-- and REFUSED wherever a row claims commercial clearance it does not have.
-- Replacing it later with a licensed feed is one row in one table, and every
-- contract downstream of it is unchanged.
--
-- THE LAYERS, and the rule each one obeys:
--
--   0  licensing       tennis.source_licenses + tennis.enforce_source_license
--                      No match, feature or rating may name a source that is
--                      not registered. Nothing is "unknown provenance".
--   1  raw / staging   tennis.stg_archive_matches — the 108-column import
--                      surface, every column text, nothing typed or trusted
--                      yet. PRIVATE: no client role may read it.
--   2  entities        tennis.players, tennis.tournaments (extended, not
--                      replaced), tennis.venues
--   3  history         tennis.matches — one canonical row per match, keyed by
--                      a deterministic match_uid so a re-import updates
--   4  point-in-time   tennis.player_match_features — what was knowable
--                      BEFORE the match and nothing else. PRIVATE.
--   5  current rating  tennis.player_ratings_current, tennis.rankings_current
--   6  market          tennis.odds_snapshots
--   7  model           tennis.model_registry, tennis.model_predictions
--                      (append-only; a prediction cannot be rewritten)
--   8  research        tennis.research_opportunities
--   9  AI context      tennis.ai_* secure functions — bounded, typed, and the
--                      only door the assistant reads tennis through
--  10  public record   tennis.prediction_record + the calibration views
--  11  operations      tennis.ingestion_runs, tennis.data_quality_issues,
--                      tennis.weather_observations
--
-- NOTHING EXISTING IS TOUCHED. tennis.tournaments already exists and is
-- already multi-provider (`provider` + unique (provider, provider_tournament_id),
-- ids shaped '<provider>:<id>'), so the archive's events are ADDED to it under
-- provider 'archive' rather than given a second table that would mean the same
-- thing. Every read the live centre makes is either keyed by tournament_id or
-- filtered `state in ('scheduled','live')`; an archived event is 'final', so
-- it is invisible to all of them. The live tables, the provider directory and
-- the baselines are not altered by a single statement in this file.
--
-- RESEARCH, NOT PICKS. Nothing here stores a recommendation, a stake or a
-- verb. A model probability is stored beside the market's, with the gap named
-- and the reason it might be wrong named with it.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor, or with psql:
--
--     psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql
--
-- Every report row must read ok. Tested against a real PostgreSQL by
-- tools/tennis/record_sql.test.js (`npm run tennis:record:sql`), which applies
-- it twice, applies it on top of tennis_live_center.sql, and attacks it as
-- anon, as a signed-in free account and as an entitled subscriber.
-- ===========================================================================

create schema if not exists tennis;
grant usage on schema tennis to anon, authenticated, service_role;

-- The live contract creates this too. Both files are idempotent and both need
-- it, so each carries it rather than depending on an apply order.
create table if not exists tennis.meta (
  key   text primary key,
  value text
);
grant select, insert, update on tennis.meta to service_role;
grant select on tennis.meta to anon, authenticated;

create or replace function tennis.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ===========================================================================
-- LAYER 0 — LICENSING. The gate the product already claims to have.
-- ===========================================================================

-- Every source of tennis facts EdgeDesk holds, and what it is allowed to be
-- used for. `commercial_use` is the one that matters: the archive is false,
-- and the trigger below refuses any row that claims otherwise.
create table if not exists tennis.source_licenses (
  source_key       text primary key,
  title            text not null,
  licence          text not null,
  licence_url      text,
  attribution      text,
  commercial_use   boolean not null default false,
  research_use     boolean not null default true,
  redistribution   boolean not null default false,
  share_alike      boolean not null default false,
  -- What the row is allowed to reach. 'research' rows may fill the record and
  -- feed the model; only a 'commercial' source may be sold, which in this
  -- product means: surfaced to a paying subscriber as a priced research
  -- opportunity. The check below is what enforces it.
  allowed_uses     text[] not null default array['research']::text[],
  notes            text,
  cleared_by       text,
  cleared_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tennis_source_licence_uses_shape
    check (allowed_uses <@ array['research','commercial','internal','display']::text[]),
  -- A source cannot be marked commercially usable without saying who cleared
  -- it and when. "Somebody probably checked" is how a licence breach happens.
  constraint tennis_source_licence_commercial_needs_clearance
    check (commercial_use = false or (cleared_by is not null and cleared_at is not null))
);
drop trigger if exists tennis_source_licenses_touch on tennis.source_licenses;
create trigger tennis_source_licenses_touch before update on tennis.source_licenses
  for each row execute function tennis.touch_updated_at();

-- The sources this build knows about. Inserted, never overwritten: an operator
-- who clears a feed commercially has updated the row by hand, and a re-run of
-- this file must not undo that.
insert into tennis.source_licenses
  (source_key, title, licence, licence_url, attribution, commercial_use, research_use,
   redistribution, share_alike, allowed_uses, notes, cleared_by, cleared_at)
values
  ('archive',
   'Sackmann-format ATP/WTA match archive, 1968-2026',
   'CC BY-NC-SA 4.0',
   'https://creativecommons.org/licenses/by-nc-sa/4.0/',
   'Jeff Sackmann / tennis_atp and tennis_wta',
   false, true, false, true,
   array['research']::text[],
   'NON-COMMERCIAL. Research and model development only. This source may not '
   'fund a commercial research product without separate permission; replace it '
   'with a licensed feed before any paid tennis surface ships. Share-alike '
   'applies to derived datasets that are redistributed.',
   null, null),
  ('espn',
   'ESPN public tennis scoreboard (draws, live scores, athletes)',
   'Publisher terms',
   null, 'ESPN', false, true, false, false,
   array['research','display']::text[],
   'Public scoreboard used for fixtures, live state and identity. Not a '
   'licensed statistical feed and not cleared for commercial redistribution.',
   null, null),
  ('open-meteo',
   'Open-Meteo historical reanalysis',
   'CC BY 4.0 (non-commercial API tier)',
   'https://open-meteo.com/en/license',
   'Open-Meteo', false, true, false, false,
   array['research']::text[],
   'Tournament-week reanalysis. The free tier is non-commercial; a commercial '
   'plan is required before weather reaches a paid surface.',
   null, null),
  ('odds_api',
   'EdgeDesk odds capture (public.signals)',
   'Commercial data agreement',
   null, null, true, true, false, false,
   array['research','commercial','display']::text[],
   'The market prices EdgeDesk already licenses for every other sport.',
   'edgedesk-ops', now()),
  ('edgedesk',
   'EdgeDesk-derived values (features, ratings, model output)',
   'Proprietary',
   null, 'EdgeDesk / Rackler Tech Ventures LLC', true, true, false, false,
   array['research','commercial','internal','display']::text[],
   'Values EdgeDesk computed itself. Derived FROM a non-commercial source, '
   'so a derived row still carries the source key it was derived from and is '
   'gated by that source, not by this row.',
   'edgedesk-ops', now())
on conflict (source_key) do nothing;

update tennis.source_licenses
   set cleared_by = coalesce(cleared_by, 'edgedesk-ops'),
       cleared_at = coalesce(cleared_at, now())
 where commercial_use = true and (cleared_by is null or cleared_at is null);

-- Is this source allowed to be used this way? Fixed search path, no default
-- public execute: the two rules every privileged function in this project
-- follows.
create or replace function tennis.license_allows(p_source_key text, p_use text)
returns boolean
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select exists (
    select 1 from tennis.source_licenses l
     where l.source_key = p_source_key
       and p_use = any (l.allowed_uses)
  );
$$;
revoke all on function tennis.license_allows(text, text) from public;
grant execute on function tennis.license_allows(text, text) to anon, authenticated, service_role;

-- THE GATE. Every table that stores a tennis fact carries `source_key`, and
-- this refuses a row whose source is not registered. It is a trigger rather
-- than a foreign key on purpose: the message is the point. A foreign-key
-- violation says "23503"; this says which source was refused and what to do.
create or replace function tennis.enforce_source_license()
returns trigger
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare
  ok boolean;
begin
  if new.source_key is null then
    raise exception using
      errcode = 'check_violation',
      message = 'tennis.' || tg_table_name || ': source_key is null',
      hint = 'Every stored tennis fact names its source. Register it in '
             'tennis.source_licenses and set source_key.';
  end if;
  select true into ok from tennis.source_licenses where source_key = new.source_key;
  if not found then
    raise exception using
      errcode = 'foreign_key_violation',
      message = 'tennis.' || tg_table_name || ': unregistered source "' || new.source_key || '"',
      hint = 'Insert the source into tennis.source_licenses first, with its '
             'licence and what it is allowed to be used for. EdgeDesk stores '
             'no fact of unknown provenance.';
  end if;
  return new;
end $$;
revoke all on function tennis.enforce_source_license() from public, anon, authenticated;

-- ===========================================================================
-- LAYER 11a — INGESTION RUNS and DATA QUALITY. Declared early because every
-- table below references a run id, and because an import that cannot say what
-- it did is not an import.
-- ===========================================================================

create table if not exists tennis.ingestion_runs (
  run_id             uuid primary key default gen_random_uuid(),
  job                text not null,                 -- 'archive_import', 'incremental_results', ...
  source_key         text not null,
  source_version     text,                          -- the build id / release the rows came from
  source_checksum    text,                          -- sha256 of the file actually read
  source_file        text,
  build_version      text,                          -- the EdgeDesk code version that ran
  scope              text,                          -- 'ATP 2024', 'all', a cursor window
  cursor_from        timestamptz,
  cursor_to          timestamptz,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  rows_read          bigint not null default 0,
  rows_inserted      bigint not null default 0,
  rows_updated       bigint not null default 0,
  rows_unchanged     bigint not null default 0,
  rows_rejected      bigint not null default 0,
  rows_quarantined   bigint not null default 0,
  reconciled         boolean,                       -- read = accepted + rejected?
  status             text not null default 'running',
  error_summary      text,
  details            jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now(),
  constraint tennis_ingestion_runs_status_shape
    check (status in ('running','ok','warn','error','cancelled','dry_run','resumed')),
  constraint tennis_ingestion_runs_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_ingestion_runs_job_idx
  on tennis.ingestion_runs (job, started_at desc);
create index if not exists tennis_ingestion_runs_status_idx
  on tennis.ingestion_runs (status, started_at desc);
create index if not exists tennis_ingestion_runs_source_idx
  on tennis.ingestion_runs (source_key, started_at desc);
drop trigger if exists tennis_ingestion_runs_touch on tennis.ingestion_runs;
create trigger tennis_ingestion_runs_touch before update on tennis.ingestion_runs
  for each row execute function tennis.touch_updated_at();

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

-- ===========================================================================
-- LAYER 3 — HISTORICAL MATCHES. One canonical row per match.
-- ===========================================================================
--
-- THE IDEMPOTENCY RULE, and why it is not the source's own match_uid.
--
-- The archive's `match_uid` is TOUR_tourney_matchnum_winnerid_loserid. It
-- identifies a RESULT, not a match: correct a mis-recorded winner upstream and
-- the uid changes, so a re-import would store the correction as a SECOND match
-- and the record would carry both. The identity of a match is the draw slot it
-- was played in — tour, tournament, match number — and that is what is unique
-- here. The source uid is kept beside it as provenance, and a row whose uid
-- changed is a CORRECTION, detected and logged rather than duplicated.
create table if not exists tennis.matches (
  match_id            text primary key,            -- 'archive:ATP:2023-2843:274'
  source_key          text not null default 'archive',
  tour                text not null,
  source_tourney_id   text not null,
  match_num           integer not null,
  source_match_uid    text,                        -- the archive's own uid, as provenance
  tournament_id       text references tennis.tournaments (tournament_id) on delete set null,
  tourney_name        text,
  season              integer,
  -- The archive dates a match to its TOURNAMENT WEEK, not to the day it was
  -- played. Both are stored and they are not the same claim: match_date is the
  -- best date EdgeDesk has, date_precision says how good it is, and
  -- scheduled_at is null until a source publishes an actual start time.
  match_date          date,
  tourney_date        date,
  date_precision      text not null default 'tournament_week',
  scheduled_at        timestamptz,
  level               text,
  round               text,
  round_order         integer,
  best_of             integer,
  surface             text,
  surface_group       text,
  environment         text,
  draw_size           integer,
  winner_id           text references tennis.players (player_id) on delete restrict,
  loser_id            text references tennis.players (player_id) on delete restrict,
  winner_seed         integer,
  loser_seed          integer,
  winner_entry        text,
  loser_entry         text,
  score               text,
  sets_played         integer,
  retirement          boolean not null default false,
  walkover            boolean not null default false,
  minutes             integer,
  winner_rank         integer,
  winner_rank_points  integer,
  loser_rank          integer,
  loser_rank_points   integer,
  winner_age          numeric(5,2),
  loser_age           numeric(5,2),
  -- POST-MATCH statistics. Stored because they are the record; NEVER read as a
  -- pre-match feature. tennis.player_match_features is the only table the
  -- model reads, and nothing in it is derived from this block for its own
  -- match. tools/tennis/leakage.test.js proves it.
  w_ace integer, w_df integer, w_svpt integer, w_1st_in integer, w_1st_won integer,
  w_2nd_won integer, w_sv_gms integer, w_bp_saved integer, w_bp_faced integer,
  l_ace integer, l_df integer, l_svpt integer, l_1st_in integer, l_1st_won integer,
  l_2nd_won integer, l_sv_gms integer, l_bp_saved integer, l_bp_faced integer,
  stats_available     boolean not null default false,
  venue_id            text references tennis.venues (venue_id) on delete set null,
  source_version      text,
  ingestion_version   text,
  ingestion_run_id    uuid references tennis.ingestion_runs (run_id) on delete set null,
  quality_flags       text[] not null default '{}'::text[],
  quality_score       numeric(4,3),
  source_updated_at   timestamptz,
  ingested_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint tennis_matches_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_matches_id_shape check (match_id like '%:%'),
  constraint tennis_matches_surface_shape
    check (surface is null or surface in ('hard','clay','grass','carpet','unknown')),
  constraint tennis_matches_env_shape
    check (environment is null or environment in ('indoor','outdoor','unknown')),
  constraint tennis_matches_date_precision_shape
    check (date_precision in ('exact','day','tournament_week','unknown')),
  constraint tennis_matches_bestof_shape check (best_of is null or best_of in (3,5)),
  constraint tennis_matches_minutes_shape check (minutes is null or (minutes between 1 and 900)),
  constraint tennis_matches_sides_differ check (winner_id is null or loser_id is null or winner_id <> loser_id),
  constraint tennis_matches_quality_shape check (quality_score is null or (quality_score between 0 and 1)),
  -- THE IDEMPOTENT KEY. A second import of the same source updates this row.
  -- The slot-unique constraint that used to live here has moved below, to a
  -- unique INDEX. It has to: it now includes the UNORDERED player pair, and an
  -- expression cannot appear in a table constraint. See the index for why.

  constraint tennis_matches_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_matches_tour_date_idx     on tennis.matches (tour, match_date desc);
create index if not exists tennis_matches_date_idx          on tennis.matches (match_date desc);
create index if not exists tennis_matches_tournament_idx    on tennis.matches (tournament_id, round_order);
create index if not exists tennis_matches_winner_date_idx   on tennis.matches (winner_id, match_date desc);
create index if not exists tennis_matches_loser_date_idx    on tennis.matches (loser_id, match_date desc);
create index if not exists tennis_matches_surface_date_idx  on tennis.matches (surface, match_date desc);
create index if not exists tennis_matches_season_idx        on tennis.matches (tour, season desc, match_date desc);
create index if not exists tennis_matches_uid_idx           on tennis.matches (source_match_uid);

-- IDENTITY: THE DRAW SLOT **AND WHO PLAYED IN IT**, never the result.
--
-- This was (source_key, tour, source_tourney_id, match_num) alone, and that is
-- not unique in the real archive. Five WTA events restart match_num inside what
-- the source calls one tourney_id — combined draws and satellite series like
-- 1973-W-SL-USA-01A-1973 — giving 16 slots that each hold two DIFFERENT
-- matches. Under the old key the second silently replaced the first: 16 real
-- matches vanished while every import total still reconciled, because they had
-- been read and accepted. They simply never became rows.
--
-- least()/greatest() make the pair UNORDERED, which is what preserves the
-- original property this key exists for: a CORRECTED result swaps winner and
-- loser, the pair is unchanged, and the correction updates the match it
-- corrects instead of creating a second one. Two genuinely different matches in
-- one slot now get two rows, which is what the source actually says.
-- NULLS NOT DISTINCT, because the default would weaken the guarantee exactly
-- where it is needed most: with both players unknown, every row's index entry
-- would be distinct from every other and a slot could be filled any number of
-- times. Two rows in the same slot with no players identified are the same
-- match as far as anything can tell, and are deduped as one.
create unique index if not exists tennis_matches_slot_unique_idx
  on tennis.matches (source_key, tour, source_tourney_id, match_num,
                     least(winner_id, loser_id), greatest(winner_id, loser_id))
  nulls not distinct;
drop trigger if exists tennis_matches_touch on tennis.matches;
create trigger tennis_matches_touch before update on tennis.matches
  for each row execute function tennis.touch_updated_at();
drop trigger if exists tennis_matches_license on tennis.matches;
create trigger tennis_matches_license before insert or update on tennis.matches
  for each row execute function tennis.enforce_source_license();

-- ===========================================================================
-- LAYER 4 — POINT-IN-TIME FEATURES. PRIVATE.
--
-- One row per (match, player). Everything in it was knowable BEFORE the match
-- started, and the table's whole reason for existing is that the boundary is
-- visible: a column here is a pre-match fact, a column in tennis.matches may
-- be a post-match one, and no join can blur the two because the model reads
-- only this table.
--
-- NOT EXPOSED TO ANY CLIENT ROLE. It is training data at 720,000+ rows and it
-- is the one place where a leak would be invisible on screen.
-- ===========================================================================
create table if not exists tennis.player_match_features (
  feature_id            bigserial primary key,
  match_id              text not null references tennis.matches (match_id) on delete cascade,
  player_id             text not null references tennis.players (player_id) on delete cascade,
  opponent_id           text references tennis.players (player_id) on delete set null,
  tour                  text not null,
  match_date            date,
  surface               text,
  -- 'winner'/'loser' is the RESULT and is the label, not a feature. It is here
  -- so a training set can be assembled from this table alone; every consumer
  -- treats it as y, and the leakage suite fails if it is read as x.
  player_role           text not null,
  won                   boolean,
  elo_pre               numeric(8,3),
  surface_elo_pre       numeric(8,3),
  win_pct_30d_pre       numeric(5,4),
  win_pct_90d_pre       numeric(5,4),
  win_pct_365d_pre      numeric(5,4),
  matches_7d_pre        integer,
  matches_14d_pre       integer,
  rest_days_pre         integer,
  career_surface_win_pct_pre  numeric(5,4),
  career_surface_matches_pre  integer,
  rank_pre              integer,
  rank_points_pre       integer,
  age_pre               numeric(5,2),
  height_cm             integer,
  plays                 text,
  best_of               integer,
  tourney_level         text,
  environment           text,
  -- Rolling serve/return strength computed STRICTLY from matches before this
  -- one. Null where the history is too thin; never zero. A zero would say
  -- "this player never lands a first serve", which is a different claim from
  -- "EdgeDesk does not know".
  serve_strength_pre    numeric(5,4),
  return_strength_pre   numeric(5,4),
  serve_sample_pre      integer,
  sos_elo_pre           numeric(8,3),
  sos_sample_pre        integer,
  -- What is missing, named. A model that treats a null as a zero is wrong in a
  -- way nobody sees; a model that is told which inputs were absent can widen
  -- its own uncertainty instead.
  missing_fields        text[] not null default '{}'::text[],
  completeness          numeric(4,3),
  feature_version       text not null,
  feature_source_key    text not null default 'edgedesk',
  computed_at           timestamptz not null default now(),
  ingestion_run_id      uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_pmf_role_shape check (player_role in ('winner','loser')),
  constraint tennis_pmf_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_pmf_completeness_shape check (completeness is null or (completeness between 0 and 1)),
  constraint tennis_pmf_sides_differ check (opponent_id is null or player_id <> opponent_id),
  -- one row per player per match per feature version
  constraint tennis_pmf_unique unique (match_id, player_id, feature_version)
);
create index if not exists tennis_pmf_player_date_idx on tennis.player_match_features (player_id, match_date desc);
create index if not exists tennis_pmf_match_idx       on tennis.player_match_features (match_id);
create index if not exists tennis_pmf_train_idx       on tennis.player_match_features (feature_version, tour, match_date);
create index if not exists tennis_pmf_surface_idx     on tennis.player_match_features (surface, match_date);

-- ===========================================================================
-- LAYER 5 — CURRENT RATINGS. The fast table the website reads.
--
-- THE POWER RATING IS NOT A CERTAINTY. A player with nine matches on file and
-- a player with nine hundred do not get the same confidence, and the rating is
-- shrunk toward the tour's own mean in proportion to how little is known.
-- `uncertainty` (0..1, higher = less known) and `rating_sample` are stored with
-- it and the page is required to show them: a 0-100 number with no sample
-- beside it is exactly the kind of false precision this product exists to
-- refuse.
-- ===========================================================================
create table if not exists tennis.player_ratings_current (
  player_id           text primary key references tennis.players (player_id) on delete cascade,
  tour                text not null,
  elo                 numeric(8,3),
  hard_elo            numeric(8,3),
  clay_elo            numeric(8,3),
  grass_elo           numeric(8,3),
  carpet_elo          numeric(8,3),
  elo_sample          integer not null default 0,
  hard_sample         integer not null default 0,
  clay_sample         integer not null default 0,
  grass_sample        integer not null default 0,
  carpet_sample       integer not null default 0,
  form_30d            numeric(5,4),
  form_90d            numeric(5,4),
  form_365d           numeric(5,4),
  form_sample_365d    integer,
  matches_7d          integer,
  matches_14d         integer,
  matches_28d         integer,
  rest_days           integer,
  official_rank       integer,
  official_rank_points integer,
  official_rank_as_of date,
  -- EdgeDesk power rating, 0-100. DOCUMENTED SCALE:
  --   50 is the tour's median rated player on the day the rating was built.
  --   Each 10 points is roughly one standard deviation of tour Elo.
  --   0 and 100 are clamps, not achievements.
  --   A player with fewer than RATING_FULL_SAMPLE matches is shrunk toward 50
  --   in proportion to what is missing, so a 3-match phenomenon cannot read 96.
  -- tennis.power_rating_scale() returns this text so the page and the AI
  -- quote the same definition rather than two paraphrases of it.
  power_rating        numeric(5,2),
  power_rating_surface jsonb not null default '{}'::jsonb,
  rating_sample       integer not null default 0,
  uncertainty         numeric(4,3),
  last_match_date     date,
  days_since_last_match integer,
  active              boolean,
  rating_version      text not null,
  source_key          text not null default 'edgedesk',
  computed_at         timestamptz not null default now(),
  ingestion_run_id    uuid references tennis.ingestion_runs (run_id) on delete set null,
  updated_at          timestamptz not null default now(),
  constraint tennis_prc_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_prc_power_shape check (power_rating is null or (power_rating between 0 and 100)),
  constraint tennis_prc_uncertainty_shape check (uncertainty is null or (uncertainty between 0 and 1)),
  constraint tennis_prc_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_prc_tour_power_idx on tennis.player_ratings_current (tour, power_rating desc nulls last);
create index if not exists tennis_prc_tour_clay_idx  on tennis.player_ratings_current (tour, clay_elo desc nulls last);
create index if not exists tennis_prc_tour_hard_idx  on tennis.player_ratings_current (tour, hard_elo desc nulls last);
create index if not exists tennis_prc_tour_grass_idx on tennis.player_ratings_current (tour, grass_elo desc nulls last);
create index if not exists tennis_prc_rank_idx       on tennis.player_ratings_current (tour, official_rank asc nulls last);
create index if not exists tennis_prc_last_idx       on tennis.player_ratings_current (last_match_date desc nulls last);
drop trigger if exists tennis_prc_touch on tennis.player_ratings_current;
create trigger tennis_prc_touch before update on tennis.player_ratings_current
  for each row execute function tennis.touch_updated_at();

create or replace function tennis.power_rating_scale()
returns text language sql immutable as $$
  select 'EdgeDesk power rating, 0-100. 50 is the median rated player on this '
         'tour on the day the rating was built. Ten points is about one '
         'standard deviation of tour Elo. A player with a thin record is '
         'shrunk toward 50 in proportion to what is missing, so the number '
         'always carries its sample and its uncertainty beside it. It is a '
         'description of the record on file, not a forecast of a match.';
$$;
grant execute on function tennis.power_rating_scale() to anon, authenticated, service_role;

-- OFFICIAL RANKINGS. The contract app.html has always read.
create table if not exists tennis.rankings_current (
  player_id     text primary key references tennis.players (player_id) on delete cascade,
  tour          text not null,
  rank          integer,
  points        integer,
  as_of         date,
  source_key    text not null default 'archive',
  movement      integer,
  previous_rank integer,
  ingestion_run_id uuid references tennis.ingestion_runs (run_id) on delete set null,
  updated_at    timestamptz not null default now(),
  constraint tennis_rankings_tour_shape check (tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_rankings_rank_shape check (rank is null or rank > 0),
  constraint tennis_rankings_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_rankings_tour_rank_idx on tennis.rankings_current (tour, rank asc nulls last);
drop trigger if exists tennis_rankings_touch on tennis.rankings_current;
create trigger tennis_rankings_touch before update on tennis.rankings_current
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- THE RECORD VIEWS. These are the contract app.html:12874-12877 and
-- tools/tennis/build_baselines.js:148-151 have always called. They are counts
-- over tennis.matches and nothing else — no model, no projection — which is
-- what lets the Tennis panel keep saying every figure on it is a published
-- fact or a count over published facts.
--
-- security_invoker = true: the caller's own RLS decides what they see, so a
-- view can never become a way around a policy.
-- ---------------------------------------------------------------------------
create or replace view tennis.player_match_rows
with (security_invoker = true) as
  select m.match_id, m.tour, m.match_date, m.season, m.surface, m.surface_group,
         m.level, m.round, m.tourney_name, m.tournament_id, m.best_of, m.minutes,
         m.score, m.retirement, m.walkover,
         m.winner_id as player_id, m.loser_id as opponent_id, true as won
    from tennis.matches m
   where m.winner_id is not null
  union all
  select m.match_id, m.tour, m.match_date, m.season, m.surface, m.surface_group,
         m.level, m.round, m.tourney_name, m.tournament_id, m.best_of, m.minutes,
         m.score, m.retirement, m.walkover,
         m.loser_id as player_id, m.winner_id as opponent_id, false as won
    from tennis.matches m
   where m.loser_id is not null;

create or replace view tennis.player_career
with (security_invoker = true) as
  select player_id,
         count(*) filter (where won)          ::integer as wins,
         count(*) filter (where not won)      ::integer as losses,
         count(*)                             ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct,
         min(match_date) as first_match,
         max(match_date) as last_match
    from tennis.player_match_rows
   group by player_id;

create or replace view tennis.player_season
with (security_invoker = true) as
  select player_id, season,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct
    from tennis.player_match_rows
   where season is not null
   group by player_id, season;

create or replace view tennis.player_surface
with (security_invoker = true) as
  select player_id, surface, season,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct
    from tennis.player_match_rows
   where surface is not null and surface <> 'unknown'
   group by player_id, surface, season;

create or replace view tennis.player_form
with (security_invoker = true) as
  select player_id, match_date, opponent_id, won, surface, tourney_name, round,
         match_id, tour, level, score, minutes
    from tennis.player_match_rows
   where match_date is not null;

create or replace view tennis.h2h
with (security_invoker = true) as
  select player_id, opponent_id,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         max(match_date) as last_meeting,
         min(match_date) as first_meeting
    from tennis.player_match_rows
   where opponent_id is not null
   group by player_id, opponent_id;

-- ===========================================================================
-- LAYER 11b — WEATHER. Separated from venue identity on purpose.
--
-- THE ARCHIVE'S WEATHER IS A TOURNAMENT-WEEK PROFILE, NOT MATCH-TIME WEATHER.
-- The source dates a match to its tournament week, so the reanalysis attached
-- to it covers seven days around an event, not the hour of first serve.
-- `temporal_precision` says so on every row, and nothing downstream may present
-- a 'tournament_week' observation as conditions at the toss. Indoor events get
-- no weather at all — not a null that looks like missing data, but an explicit
-- 'indoor' precision saying weather is irrelevant rather than absent.
-- ===========================================================================
create table if not exists tennis.weather_observations (
  observation_id      bigserial primary key,
  venue_id            text references tennis.venues (venue_id) on delete cascade,
  tournament_id       text references tennis.tournaments (tournament_id) on delete cascade,
  source_key          text not null default 'open-meteo',
  observed_on         date not null,
  window_start        date,
  window_end          date,
  temporal_precision  text not null default 'tournament_week',
  temp_mean_f         numeric(5,2),
  temp_max_f          numeric(5,2),
  temp_min_f          numeric(5,2),
  humidity_mean_pct   numeric(5,2),
  precip_in           numeric(6,3),
  wind_mean_mph       numeric(5,2),
  gust_max_mph        numeric(5,2),
  solar_mj_m2         numeric(7,3),
  days_covered        integer,
  venue_confidence    text,
  quality             text not null default 'unknown',
  ingestion_run_id    uuid references tennis.ingestion_runs (run_id) on delete set null,
  ingested_at         timestamptz not null default now(),
  constraint tennis_weather_precision_shape
    check (temporal_precision in ('hourly','daily','tournament_week','indoor','unknown')),
  constraint tennis_weather_quality_shape
    check (quality in ('high','usable','low','unusable','unknown')),
  constraint tennis_weather_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create unique index if not exists tennis_weather_unique_idx on tennis.weather_observations
  (coalesce(venue_id, ''), coalesce(tournament_id, ''), source_key, observed_on);
create index if not exists tennis_weather_venue_idx on tennis.weather_observations (venue_id, observed_on desc);
create index if not exists tennis_weather_tournament_idx on tennis.weather_observations (tournament_id);

-- Is this weather observation fit to influence a model or a screen? One rule,
-- in one place, so the importer, the model and the page cannot disagree.
create or replace function tennis.weather_is_usable(
  p_environment text, p_precision text, p_confidence text, p_quality text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_environment, 'unknown') = 'outdoor'
     and coalesce(p_precision, 'unknown') in ('hourly','daily','tournament_week')
     and coalesce(p_confidence, 'unknown') in ('exact','high','name_inferred')
     and coalesce(p_quality, 'unknown') in ('high','usable');
$$;
grant execute on function tennis.weather_is_usable(text, text, text, text) to anon, authenticated, service_role;

-- ===========================================================================
-- LAYER 6 — MARKET ODDS.
--
-- The live contract already stores tennis price observations in
-- tennis.market_captures, tagged PRE or LIVE against the match's own first
-- point. That table is not replaced and not altered. This one is the
-- NORMALISED market surface the model and the research layer read: one row per
-- (match, book, market, selection, capture), with both American and decimal
-- odds and the implied probability spelled out, so nothing downstream has to
-- re-derive a price format.
-- ===========================================================================
create table if not exists tennis.odds_snapshots (
  snapshot_id      bigserial primary key,
  match_scope      text not null default 'live',   -- 'live' (a fixture) or 'archive' (a settled match)
  match_ref        text not null,                  -- tennis.live_matches.match_id or tennis.matches.match_id
  event_id         text,                           -- the odds feed's own fixture id
  tour             text,
  sportsbook       text not null,
  book_trusted     boolean,
  market_type      text not null,
  selection        text not null,
  selection_player_id text references tennis.players (player_id) on delete set null,
  line             numeric(7,2),                   -- spread in games / total games
  odds_american    integer,
  odds_decimal     numeric(10,4),
  implied_prob     numeric(6,5),
  no_vig_prob      numeric(6,5),
  market_state     text not null default 'current',
  market_status    text not null default 'open',
  captured_at      timestamptz not null default now(),
  source_key       text not null default 'odds_api',
  source_updated_at timestamptz,
  ingestion_run_id uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_odds_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_odds_market_shape check (market_type in
    ('match_winner','game_spread','total_games','set_betting','set_spread','player_prop')),
  constraint tennis_odds_state_shape check (market_state in ('opening','current','closing')),
  constraint tennis_odds_status_shape check (market_status in ('open','suspended','settled','void')),
  constraint tennis_odds_prob_shape check (implied_prob is null or (implied_prob > 0 and implied_prob < 1)),
  constraint tennis_odds_decimal_shape check (odds_decimal is null or odds_decimal > 1),
  constraint tennis_odds_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
-- A price is a price AT A MOMENT. Re-capturing the same moment is a no-op; a
-- new moment is a new row, and nothing is ever overwritten. This is a unique
-- INDEX rather than a table constraint because `line` is nullable and a plain
-- UNIQUE treats two nulls as distinct — which would let the same match-winner
-- price be captured twice at the same instant.
create unique index if not exists tennis_odds_unique_idx on tennis.odds_snapshots
  (match_scope, match_ref, sportsbook, market_type, selection, coalesce(line, -99999), captured_at);
create index if not exists tennis_odds_match_idx on tennis.odds_snapshots (match_scope, match_ref, captured_at desc);
create index if not exists tennis_odds_market_idx on tennis.odds_snapshots (market_type, captured_at desc);
create index if not exists tennis_odds_state_idx on tennis.odds_snapshots (match_ref, market_state, captured_at desc);
create index if not exists tennis_odds_book_idx on tennis.odds_snapshots (sportsbook, captured_at desc);

-- ===========================================================================
-- LAYER 7 — MODEL REGISTRY and PREDICTIONS.
--
-- A model version is IMMUTABLE. Its evaluation is what it scored on the window
-- it was measured over; rewriting that later would make every published number
-- unverifiable. The registry's mutable surface is exactly two columns —
-- `status` and `rollback_target` — and a trigger refuses every other change.
-- ===========================================================================
create table if not exists tennis.model_registry (
  model_version      text primary key,              -- 'tennis-baseline-1.0.0'
  family             text not null default 'tennis_match_winner',
  feature_version    text not null,
  algorithm          text,
  description        text,
  training_cutoff    date not null,
  train_from         date,
  train_to           date,
  valid_from         date,
  valid_to           date,
  eval_from          date,
  eval_to            date,
  train_rows         bigint,
  valid_rows         bigint,
  eval_rows          bigint,
  coefficients       jsonb not null default '{}'::jsonb,
  eval_results       jsonb not null default '{}'::jsonb,
  calibration        jsonb not null default '{}'::jsonb,
  baseline_comparison jsonb not null default '{}'::jsonb,
  status             text not null default 'candidate',
  rollback_target    text references tennis.model_registry (model_version) on delete set null,
  activated_at       timestamptz,
  retired_at         timestamptz,
  deployed_at        timestamptz,
  created_by         text,
  build_version      text,
  source_key         text not null default 'edgedesk',
  created_at         timestamptz not null default now(),
  constraint tennis_model_status_shape
    check (status in ('candidate','shadow','active','retired','rejected')),
  constraint tennis_model_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_model_status_idx on tennis.model_registry (family, status, created_at desc);
-- AT MOST ONE ACTIVE MODEL PER FAMILY. Two active versions would mean two fair
-- prices for the same match with nothing to say which one the record is kept
-- against.
create unique index if not exists tennis_model_one_active_idx
  on tennis.model_registry (family) where status = 'active';

create or replace function tennis.freeze_model_version()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.model_registry rows are immutable: a model version cannot be deleted',
      hint = 'Set status = ''retired'' instead. The published record is kept against this version.';
  end if;
  if new.model_version is distinct from old.model_version
     or new.feature_version is distinct from old.feature_version
     or new.training_cutoff is distinct from old.training_cutoff
     or new.train_from is distinct from old.train_from
     or new.train_to is distinct from old.train_to
     or new.eval_from is distinct from old.eval_from
     or new.eval_to is distinct from old.eval_to
     or new.coefficients is distinct from old.coefficients
     or new.eval_results is distinct from old.eval_results
     or new.calibration is distinct from old.calibration then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.model_registry: version, features, windows, coefficients and evaluation are immutable',
      hint = 'Register a NEW model_version. Only status, rollback_target, '
             'activated_at, retired_at and deployed_at may change.';
  end if;
  return new;
end $$;
drop trigger if exists tennis_model_freeze on tennis.model_registry;
create trigger tennis_model_freeze before update or delete on tennis.model_registry
  for each row execute function tennis.freeze_model_version();

-- PREDICTIONS. Append-only. A prediction is a claim made at a moment with the
-- information available then; editing one after the result is known is how a
-- public record becomes fiction.
create table if not exists tennis.model_predictions (
  prediction_id        uuid primary key default gen_random_uuid(),
  match_scope          text not null default 'live',
  match_ref            text not null,
  tour                 text,
  model_version        text not null references tennis.model_registry (model_version) on delete restrict,
  feature_version      text,
  generated_at         timestamptz not null default now(),
  -- sides, named rather than positional
  player_a_id          text references tennis.players (player_id) on delete set null,
  player_b_id          text references tennis.players (player_id) on delete set null,
  player_a_name        text,
  player_b_name        text,
  prob_a               numeric(6,5),
  prob_b               numeric(6,5),
  fair_odds_a_decimal  numeric(10,4),
  fair_odds_b_decimal  numeric(10,4),
  fair_odds_a_american integer,
  fair_odds_b_american integer,
  projected_spread     numeric(6,2),
  projected_total      numeric(6,2),
  confidence           numeric(4,3),
  uncertainty          numeric(4,3),
  feature_snapshot_at  timestamptz,
  market_snapshot_id   bigint references tennis.odds_snapshots (snapshot_id) on delete set null,
  market_prob_a        numeric(6,5),
  market_prob_b        numeric(6,5),
  edge_a               numeric(7,5),
  edge_b               numeric(7,5),
  ev_a                 numeric(8,5),
  ev_b                 numeric(8,5),
  research_grade       text not null default 'ungraded',
  exclusion_reasons    text[] not null default '{}'::text[],
  calibration_bucket   text,
  inputs               jsonb not null default '{}'::jsonb,
  missing_inputs       text[] not null default '{}'::text[],
  source_key           text not null default 'edgedesk',
  ingestion_run_id     uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_pred_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_pred_prob_shape check (prob_a is null or (prob_a > 0 and prob_a < 1)),
  constraint tennis_pred_probs_sum check
    (prob_a is null or prob_b is null or abs((prob_a + prob_b) - 1) < 0.0005),
  constraint tennis_pred_grade_shape
    check (research_grade in ('ungraded','research','provisional','excluded')),
  constraint tennis_pred_conf_shape check (confidence is null or (confidence between 0 and 1)),
  constraint tennis_pred_unc_shape check (uncertainty is null or (uncertainty between 0 and 1)),
  constraint tennis_pred_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
-- Re-running the same model over the same features and the same market snapshot
-- is a no-op rather than a second row. A unique INDEX with coalesce, not a
-- UNIQUE constraint: both snapshot columns are nullable and two nulls would
-- otherwise be distinct, so a model re-run before any market existed would
-- write a second prediction every time.
create unique index if not exists tennis_pred_unique_idx on tennis.model_predictions
  (match_scope, match_ref, model_version,
   coalesce(feature_snapshot_at, '-infinity'::timestamptz),
   coalesce(market_snapshot_id, -1));
create index if not exists tennis_pred_match_idx  on tennis.model_predictions (match_scope, match_ref, generated_at desc);
create index if not exists tennis_pred_model_idx  on tennis.model_predictions (model_version, generated_at desc);
create index if not exists tennis_pred_grade_idx  on tennis.model_predictions (research_grade, generated_at desc);
create index if not exists tennis_pred_tour_idx   on tennis.model_predictions (tour, generated_at desc);

create or replace function tennis.freeze_prediction()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = 'restrict_violation',
    message = 'tennis.model_predictions is append-only: a prediction cannot be '
              || lower(tg_op) || 'd after it is written',
    hint = 'Write a new prediction row. The research layer '
           '(tennis.research_opportunities) is the mutable surface; the '
           'prediction that produced it is evidence and stays as it was.';
end $$;
drop trigger if exists tennis_pred_freeze on tennis.model_predictions;
create trigger tennis_pred_freeze before update or delete on tennis.model_predictions
  for each row execute function tennis.freeze_prediction();

-- ===========================================================================
-- LAYER 8 — RESEARCH OPPORTUNITIES. The mutable surface.
--
-- Separate from predictions on purpose: a prediction is what the model said,
-- an opportunity is what is still worth reading right now. It expires, it gets
-- superseded, it gets withdrawn when the data behind it goes stale — and none
-- of that may rewrite the prediction that produced it.
--
-- RESEARCH, NOT PICKS. There is no stake column, no "play" column and no
-- ranking by expected profit. `reason_codes` says why a row is here and
-- `exclusion_reasons` says what would stop a careful reader trusting it.
-- ===========================================================================
create table if not exists tennis.research_opportunities (
  opportunity_id     uuid primary key default gen_random_uuid(),
  match_scope        text not null default 'live',
  match_ref          text not null,
  tour               text,
  prediction_id      uuid references tennis.model_predictions (prediction_id) on delete set null,
  model_version      text references tennis.model_registry (model_version) on delete set null,
  market_type        text not null,
  selection          text not null,
  selection_player_id text references tennis.players (player_id) on delete set null,
  sportsbook         text,
  line               numeric(7,2),
  model_prob         numeric(6,5),
  market_prob        numeric(6,5),
  fair_odds_decimal  numeric(10,4),
  fair_odds_american integer,
  market_odds_decimal numeric(10,4),
  market_odds_american integer,
  estimated_edge     numeric(7,5),
  expected_value     numeric(8,5),
  confidence         numeric(4,3),
  data_quality_score numeric(4,3),
  market_quality_score numeric(4,3),
  reason_codes       text[] not null default '{}'::text[],
  exclusion_reasons  text[] not null default '{}'::text[],
  research_grade     text not null default 'research',
  status             text not null default 'open',
  generated_at       timestamptz not null default now(),
  expires_at         timestamptz,
  superseded_at      timestamptz,
  superseded_by      uuid references tennis.research_opportunities (opportunity_id) on delete set null,
  source_key         text not null default 'edgedesk',
  updated_at         timestamptz not null default now(),
  constraint tennis_ro_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_ro_status_shape
    check (status in ('open','expired','superseded','withdrawn','settled')),
  constraint tennis_ro_grade_shape
    check (research_grade in ('research','provisional','excluded')),
  constraint tennis_ro_dq_shape check (data_quality_score is null or (data_quality_score between 0 and 1)),
  constraint tennis_ro_mq_shape check (market_quality_score is null or (market_quality_score between 0 and 1)),
  constraint tennis_ro_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_ro_open_idx on tennis.research_opportunities (status, generated_at desc)
  where status = 'open';
create index if not exists tennis_ro_match_idx on tennis.research_opportunities (match_scope, match_ref, generated_at desc);
create index if not exists tennis_ro_tour_idx on tennis.research_opportunities (tour, status, generated_at desc);
create index if not exists tennis_ro_edge_idx on tennis.research_opportunities (status, estimated_edge desc nulls last);
drop trigger if exists tennis_ro_touch on tennis.research_opportunities;
create trigger tennis_ro_touch before update on tennis.research_opportunities
  for each row execute function tennis.touch_updated_at();

-- ===========================================================================
-- LAYER 10 — PUBLIC RECORD and CALIBRATION.
--
-- A published prediction is written here AT PUBLICATION TIME and is never
-- edited afterwards except to record what actually happened. That is the whole
-- promise of a public record: the claim is frozen before the result exists, and
-- settlement writes the result beside it rather than over it.
--
-- This is the tennis half of the boundary public.public_brief_closes already
-- draws for every other sport: the live board is behind the paywall, the
-- history is public.
-- ===========================================================================
create table if not exists tennis.prediction_record (
  record_id          uuid primary key default gen_random_uuid(),
  prediction_id      uuid references tennis.model_predictions (prediction_id) on delete set null,
  match_scope        text not null default 'live',
  match_ref          text not null,
  archive_match_id   text references tennis.matches (match_id) on delete set null,
  tour               text,
  tournament_name    text,
  surface            text,
  round              text,
  model_version      text not null references tennis.model_registry (model_version) on delete restrict,
  feature_version    text,
  published_at       timestamptz not null default now(),
  scheduled_at       timestamptz,
  player_a_id        text,
  player_b_id        text,
  player_a_name      text,
  player_b_name      text,
  prob_a             numeric(6,5) not null,
  fair_odds_a_decimal numeric(10,4),
  market_prob_a      numeric(6,5),
  market_odds_a_decimal numeric(10,4),
  market_book        text,
  closing_prob_a     numeric(6,5),
  closing_odds_a_decimal numeric(10,4),
  confidence         numeric(4,3),
  confidence_bucket  text,
  calibration_bucket text,
  research_grade     text not null default 'research',
  -- settlement, written once the match is final
  settled_at         timestamptz,
  winner_id          text,
  outcome_a          boolean,                     -- did player A win?
  brier              numeric(8,6),
  log_loss           numeric(10,6),
  clv                numeric(8,5),
  beat_close         boolean,
  settle_source      text,
  constraint tennis_rec_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_rec_prob_shape check (prob_a > 0 and prob_a < 1),
  constraint tennis_rec_grade_shape check (research_grade in ('research','provisional','excluded')),
  -- one published record per match per model version. A second publication of
  -- the same claim is the same claim.
  constraint tennis_rec_unique unique (match_scope, match_ref, model_version)
);
create index if not exists tennis_rec_published_idx on tennis.prediction_record (published_at desc);
create index if not exists tennis_rec_settled_idx   on tennis.prediction_record (settled_at desc nulls last);
create index if not exists tennis_rec_model_idx     on tennis.prediction_record (model_version, settled_at desc nulls last);
create index if not exists tennis_rec_tour_idx      on tennis.prediction_record (tour, surface, settled_at desc nulls last);
create index if not exists tennis_rec_open_idx      on tennis.prediction_record (scheduled_at) where settled_at is null;

-- A published claim cannot be edited. Settlement may fill the result columns
-- exactly once; nothing may change the probability, the price or the model
-- that produced them.
create or replace function tennis.freeze_published_record()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record is immutable: a published prediction cannot be deleted';
  end if;
  if new.prob_a is distinct from old.prob_a
     or new.model_version is distinct from old.model_version
     or new.published_at is distinct from old.published_at
     or new.match_ref is distinct from old.match_ref
     or new.player_a_id is distinct from old.player_a_id
     or new.player_b_id is distinct from old.player_b_id
     or new.fair_odds_a_decimal is distinct from old.fair_odds_a_decimal
     or new.market_prob_a is distinct from old.market_prob_a then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record: the published claim is immutable',
      hint = 'Settlement may write winner_id, outcome_a, settled_at, brier, '
             'log_loss, clv, beat_close and the closing price. Nothing else.';
  end if;
  if old.settled_at is not null and new.settled_at is distinct from old.settled_at then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.prediction_record: this record is already settled',
      hint = 'A settled result is not re-settled. Correct it by recording a '
             'data-quality issue, not by rewriting history.';
  end if;
  return new;
end $$;
drop trigger if exists tennis_rec_freeze on tennis.prediction_record;
create trigger tennis_rec_freeze before update or delete on tennis.prediction_record
  for each row execute function tennis.freeze_published_record();

-- The published performance surface. Counts and scores only — no ROI, because
-- ROI without the price that was actually available and the sample it came
-- from is a number that flatters whoever publishes it. CLV is published where
-- a closing price exists and says how often it does.
create or replace view tennis.public_record_summary
with (security_invoker = true) as
  select r.model_version,
         r.tour,
         r.surface,
         r.confidence_bucket,
         count(*)::integer                                        as predictions,
         count(*) filter (where r.settled_at is not null)::integer as settled,
         round(avg(r.brier) filter (where r.settled_at is not null)::numeric, 5)    as brier,
         round(avg(r.log_loss) filter (where r.settled_at is not null)::numeric, 5) as log_loss,
         round(avg(case when r.outcome_a then 1.0 else 0.0 end)
               filter (where r.settled_at is not null)::numeric, 4)                 as outcome_rate,
         round(avg(r.prob_a) filter (where r.settled_at is not null)::numeric, 4)   as mean_prob,
         count(*) filter (where r.clv is not null)::integer                         as clv_sample,
         round(avg(r.clv) filter (where r.clv is not null)::numeric, 5)             as mean_clv,
         count(*) filter (where r.beat_close)::integer                              as beat_close,
         min(r.published_at) as first_published,
         max(r.published_at) as last_published,
         -- a sample below this is not a measurement and the page must say so
         (count(*) filter (where r.settled_at is not null) < 100) as small_sample
    from tennis.prediction_record r
   group by r.model_version, r.tour, r.surface, r.confidence_bucket;

create or replace view tennis.public_record_calibration
with (security_invoker = true) as
  select r.model_version,
         r.tour,
         width_bucket(r.prob_a, 0, 1, 10) as bucket,
         round((width_bucket(r.prob_a, 0, 1, 10) - 0.5) / 10.0, 3) as bucket_midpoint,
         count(*)::integer as n,
         round(avg(r.prob_a)::numeric, 4) as mean_predicted,
         round(avg(case when r.outcome_a then 1.0 else 0.0 end)::numeric, 4) as observed_rate
    from tennis.prediction_record r
   where r.settled_at is not null
   group by r.model_version, r.tour, width_bucket(r.prob_a, 0, 1, 10);

-- ===========================================================================
-- ENTITLEMENT. One authority, reused rather than re-implemented.
--
-- public.community_is_entitled(uuid) is the project's entitlement rule: the
-- owner comp, the active/trialing period, and Stripe's 21-day past_due grace.
-- This delegates to it wherever it is installed, so tennis can never drift
-- from what the rest of the product means by "subscriber". The fallback exists
-- only so this file applies to a database that has tennis but not yet the
-- community contract — and it evaluates the identical predicate against
-- public.subscriptions rather than inventing a second rule.
-- ===========================================================================
create or replace function tennis.viewer_is_entitled()
returns boolean
language plpgsql
stable
security definer
set search_path = public, tennis, pg_temp
as $$
declare
  uid uuid;
  ok  boolean;
begin
  begin
    uid := auth.uid();
  exception when others then
    return false;
  end;
  if uid is null then return false; end if;

  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;

  if to_regclass('public.subscriptions') is null then return false; end if;
  execute $q$
    select exists (
      select 1 from public.subscriptions s
       where s.user_id = $1
         and ( (s.status = 'active' and coalesce(s.price_id, '') in ('owner_comp'))
            or (s.status in ('active','trialing')
                and (s.current_period_end is null or s.current_period_end >= now()))
            or (s.status = 'past_due'
                and (s.current_period_end is null or now() - s.current_period_end < interval '21 days')) )
    )
  $q$ into ok using uid;
  return coalesce(ok, false);
end $$;
revoke all on function tennis.viewer_is_entitled() from public;
grant execute on function tennis.viewer_is_entitled() to anon, authenticated, service_role;

-- ===========================================================================
-- LAYER 9 — THE EXPOSED SURFACE. Narrow views, and nothing else.
--
-- Everything above is a base table with RLS on it. What the website reads is
-- these: a fixed projection of exactly the columns a screen needs, so a column
-- added to a base table later is not silently published, and so "never send
-- unused columns to the frontend" is a property of the contract rather than a
-- habit of the caller.
--
-- security_invoker = true on every one of them: the reader's own policies
-- decide what comes back, so a view can never be a way around a policy.
-- ===========================================================================

-- What ANYONE may see about an upcoming or live match: who is playing, where,
-- on what, and what EdgeDesk knows about the two players' records. No price,
-- no fair price, no edge, no EV. That is the paywall, drawn where every other
-- sport in this product draws it.
--
-- The fixtures come from the LIVE contract (tennis.live_matches), which may or
-- may not be installed yet — this file and tennis_live_center.sql are designed
-- to apply in either order. When it is absent the view is still created, with
-- the same column shape over no rows, so every caller downstream compiles and
-- reports "no fixtures" rather than "contract missing".
do $view$
begin
  if to_regclass('tennis.live_matches') is not null then
    execute $v$
      create or replace view tennis.board_public
      with (security_invoker = true) as
        select lm.match_id               as match_ref,
               'live'::text              as match_scope,
               lm.tour,
               lm.tournament_id,
               t.name                    as tournament_name,
               t.level                   as tournament_level,
               coalesce(t.surface, 'unknown') as surface,
               case when t.indoor is true then 'indoor'
                    when t.indoor is false then 'outdoor'
                    else coalesce(t.environment, 'unknown') end as environment,
               lm.round,
               lm.best_of,
               lm.scheduled_at,
               lm.status,
               lm.home_player_id         as player_a_id,
               lm.away_player_id         as player_b_id,
               lm.home_name              as player_a_name,
               lm.away_name              as player_b_name,
               ra.power_rating           as player_a_power,
               rb.power_rating           as player_b_power,
               ra.uncertainty            as player_a_uncertainty,
               rb.uncertainty            as player_b_uncertainty,
               ra.official_rank          as player_a_rank,
               rb.official_rank          as player_b_rank,
               ra.form_90d               as player_a_form_90d,
               rb.form_90d               as player_b_form_90d,
               ra.rest_days              as player_a_rest_days,
               rb.rest_days              as player_b_rest_days,
               ra.matches_14d            as player_a_matches_14d,
               rb.matches_14d            as player_b_matches_14d,
               greatest(coalesce(ra.computed_at, 'epoch'::timestamptz),
                        coalesce(rb.computed_at, 'epoch'::timestamptz)) as ratings_computed_at
          from tennis.live_matches lm
          left join tennis.tournaments t on t.tournament_id = lm.tournament_id
          left join tennis.player_ratings_current ra on ra.player_id = lm.home_player_id
          left join tennis.player_ratings_current rb on rb.player_id = lm.away_player_id
         where coalesce(lm.is_doubles, false) = false
    $v$;
  else
    execute $v$
      create or replace view tennis.board_public
      with (security_invoker = true) as
        select null::text as match_ref, 'live'::text as match_scope, null::text as tour,
               null::text as tournament_id, null::text as tournament_name,
               null::text as tournament_level, null::text as surface, null::text as environment,
               null::text as round, null::integer as best_of, null::timestamptz as scheduled_at,
               null::text as status, null::text as player_a_id, null::text as player_b_id,
               null::text as player_a_name, null::text as player_b_name,
               null::numeric as player_a_power, null::numeric as player_b_power,
               null::numeric as player_a_uncertainty, null::numeric as player_b_uncertainty,
               null::integer as player_a_rank, null::integer as player_b_rank,
               null::numeric as player_a_form_90d, null::numeric as player_b_form_90d,
               null::integer as player_a_rest_days, null::integer as player_b_rest_days,
               null::integer as player_a_matches_14d, null::integer as player_b_matches_14d,
               null::timestamptz as ratings_computed_at
         where false
    $v$;
  end if;
end $view$;

-- The research board itself. Every priced column lives here and nowhere else,
-- and the base tables underneath admit only an entitled reader — so an
-- unentitled caller reading this view gets zero rows from the database rather
-- than a redacted row from the application.
create or replace view tennis.board_research
with (security_invoker = true) as
  select p.prediction_id,
         p.match_scope,
         p.match_ref,
         p.tour,
         p.model_version,
         p.feature_version,
         p.generated_at,
         p.player_a_id, p.player_b_id, p.player_a_name, p.player_b_name,
         p.prob_a, p.prob_b,
         p.fair_odds_a_decimal, p.fair_odds_b_decimal,
         p.fair_odds_a_american, p.fair_odds_b_american,
         p.market_prob_a, p.market_prob_b,
         (p.prob_a - p.market_prob_a) as probability_gap_a,
         p.edge_a, p.edge_b, p.ev_a, p.ev_b,
         p.confidence, p.uncertainty,
         p.research_grade, p.exclusion_reasons, p.missing_inputs,
         p.feature_snapshot_at, p.market_snapshot_id,
         o.captured_at            as market_captured_at,
         o.sportsbook             as market_book,
         o.market_type            as market_type,
         o.market_state           as market_state
    from tennis.model_predictions p
    left join tennis.odds_snapshots o on o.snapshot_id = p.market_snapshot_id;

-- THE BOARD THE WEBSITE ACTUALLY READS: the LATEST prediction per match, with
-- the fixture beside it. Predictions are append-only, so a match accumulates a
-- row every time the board is rebuilt; the page wants the current one, and
-- PostgREST cannot express `distinct on`. So the contract does.
create or replace view tennis.board_current
with (security_invoker = true) as
  select distinct on (b.match_ref)
         b.prediction_id, b.match_scope, b.match_ref, b.tour, b.model_version, b.feature_version,
         b.generated_at, b.player_a_id, b.player_b_id, b.player_a_name, b.player_b_name,
         b.prob_a, b.prob_b, b.fair_odds_a_decimal, b.fair_odds_b_decimal,
         b.fair_odds_a_american, b.fair_odds_b_american,
         b.market_prob_a, b.market_prob_b, b.probability_gap_a,
         b.edge_a, b.edge_b, b.ev_a, b.ev_b, b.confidence, b.uncertainty,
         b.research_grade, b.exclusion_reasons, b.missing_inputs,
         b.feature_snapshot_at, b.market_captured_at, b.market_book, b.market_state,
         bp.tournament_name, bp.tournament_level, bp.surface, bp.environment, bp.round,
         bp.best_of, bp.scheduled_at, bp.status,
         bp.player_a_power, bp.player_b_power,
         bp.player_a_uncertainty, bp.player_b_uncertainty,
         bp.player_a_rank, bp.player_b_rank,
         bp.player_a_form_90d, bp.player_b_form_90d,
         bp.player_a_rest_days, bp.player_b_rest_days,
         bp.player_a_matches_14d, bp.player_b_matches_14d,
         bp.ratings_computed_at
    from tennis.board_research b
    join tennis.board_public bp on bp.match_ref = b.match_ref
   order by b.match_ref, b.generated_at desc;

-- Everything the match research page needs about one match, in one read.
create or replace view tennis.match_context
with (security_invoker = true) as
  select b.*,
         r.opportunity_id,
         r.market_type          as opportunity_market,
         r.selection            as opportunity_selection,
         r.sportsbook           as opportunity_book,
         r.estimated_edge,
         r.expected_value,
         r.data_quality_score,
         r.market_quality_score,
         r.reason_codes,
         r.status               as opportunity_status,
         r.expires_at           as opportunity_expires_at
    from tennis.board_research b
    left join tennis.research_opportunities r
           on r.match_scope = b.match_scope
          and r.match_ref = b.match_ref
          and r.prediction_id = b.prediction_id
          and r.status = 'open';

-- The public player profile. Indexable, anonymous, and every number on it is a
-- count over the stored record or a rating with its sample attached.
create or replace view tennis.player_profile
with (security_invoker = true) as
  select p.player_id,
         p.tour,
         p.full_name,
         p.name_norm,
         p.country,
         p.plays,
         p.height_cm,
         p.birth_date,
         p.latest_age,
         p.first_match,
         p.last_match,
         p.matches_on_file,
         p.active,
         r.power_rating,
         r.power_rating_surface,
         r.uncertainty,
         r.rating_sample,
         r.elo, r.hard_elo, r.clay_elo, r.grass_elo, r.carpet_elo,
         r.hard_sample, r.clay_sample, r.grass_sample, r.carpet_sample,
         r.form_30d, r.form_90d, r.form_365d, r.form_sample_365d,
         r.matches_7d, r.matches_14d, r.matches_28d, r.rest_days,
         r.days_since_last_match,
         r.rating_version,
         r.computed_at as rating_computed_at,
         k.rank as official_rank,
         k.points as official_rank_points,
         k.as_of as official_rank_as_of,
         c.wins, c.losses, c.matches, c.win_pct
    from tennis.players p
    left join tennis.player_ratings_current r on r.player_id = p.player_id
    left join tennis.rankings_current k on k.player_id = p.player_id
    left join tennis.player_career c on c.player_id = p.player_id;

-- THE OPERATIONAL NUMBERS, through a narrow door.
--
-- tennis.ingestion_runs and tennis.data_quality_issues are PRIVATE: they are the
-- pipeline's own diary and no browser reads them. But the board header has to be
-- able to say "the last ingest succeeded four hours ago" and "two data-quality
-- issues are open", or a reader cannot tell fresh from stale.
--
-- So exactly three AGGREGATE numbers come out, through a security-definer
-- function with a fixed search path. No row, no job name, no error text, no
-- entity id. A `security_invoker` view cannot do this — it would need the
-- caller to hold SELECT on the private tables, which is the thing being avoided.
--
-- This is also a bug this file previously had and did not notice: the earlier
-- record_health read those tables directly as an invoker view, which worked
-- only because `select count(*) from tennis.record_health` lets the planner skip
-- the scalar subqueries entirely. A reader doing `select *` — which is what the
-- page actually does — got "permission denied for table ingestion_runs".
create or replace function tennis.ops_health()
returns table (last_successful_ingest timestamptz, failed_runs_7d bigint,
               open_data_issues bigint, last_prediction_at timestamptz,
               open_opportunities bigint)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select (select max(finished_at) from tennis.ingestion_runs where status = 'ok'),
         (select count(*) from tennis.ingestion_runs
           where status = 'error' and started_at > now() - interval '7 days'),
         (select count(*) from tennis.data_quality_issues where resolved_at is null),
         -- WHEN the last prediction was made and HOW MANY opportunities are open.
         -- Both are freshness facts: they say the system is alive. Neither says
         -- what the model thinks or what any price is, so both are safe for an
         -- anonymous header while the tables behind them stay subscriber-gated.
         (select max(generated_at) from tennis.model_predictions),
         (select count(*) from tennis.research_opportunities where status = 'open');
$$;
revoke all on function tennis.ops_health() from public;
grant execute on function tennis.ops_health() to anon, authenticated, service_role;

-- Data freshness and coverage, for the page header and for the AI's "what is
-- missing" answer. One row.
--
-- ONE PASS OVER tennis.matches, NOT FOUR. The obvious version asks for the row
-- count, the ATP count, the WTA count, the first date, the last date and the
-- unknown-surface count as six separate scalar subqueries — six sequential
-- scans of the same table. Measured against 290,280 matches that took 334 ms,
-- and this view is loaded on EVERY research-board render, so it was the slowest
-- thing a reader waited for. Folding them into one aggregate with FILTER
-- clauses does the same work in a single pass.
create or replace view tennis.record_health
with (security_invoker = true) as
  with m as (
    select count(*)                                              as matches,
           count(*) filter (where tour = 'ATP')                  as atp_matches,
           count(*) filter (where tour = 'WTA')                  as wta_matches,
           count(*) filter (where surface is null or surface = 'unknown') as matches_without_surface,
           min(match_date)                                       as first_match_date,
           max(match_date)                                       as last_match_date
      from tennis.matches
  ), r as (
    select count(*) as rated_players, max(computed_at) as ratings_computed_at
      from tennis.player_ratings_current
  ), i as (
    -- through the narrow definer door above, so the private tables stay private
    select * from tennis.ops_health()
  )
  select m.matches, m.atp_matches, m.wta_matches,
         (select count(*) from tennis.players)                   as players,
         m.first_match_date, m.last_match_date, m.matches_without_surface,
         r.rated_players, r.ratings_computed_at,
         (select model_version from tennis.model_registry
           where family = 'tennis_match_winner' and status = 'active')  as active_model_version,
         i.last_prediction_at, i.open_opportunities,
         i.last_successful_ingest, i.failed_runs_7d, i.open_data_issues,
         -- is EVERY source behind the stored record cleared for commercial use?
         -- Today this is false, deliberately, and the board says so on screen.
         (select bool_and(l.commercial_use) from tennis.source_licenses l
           where exists (select 1 from tennis.matches mm where mm.source_key = l.source_key))
                                                                 as record_cleared_for_commercial_use
    from m, r, i;

-- ===========================================================================
-- LAYER 9b — THE AI CONTEXT DOOR.
--
-- EdgeDesk Intelligence answers tennis questions from THESE and nothing else.
-- Each one is a bounded, typed read with a hard row cap, so a retrieval budget
-- is a property of the database rather than a promise the caller makes. Each
-- returns its own provenance — the rating's computed_at, the model version, the
-- market's captured_at — because an answer about a live match that cannot say
-- when its inputs were true is not an answer.
--
-- SECURITY DEFINER with a fixed search_path, execute revoked from public, and
-- the priced ones check tennis.viewer_is_entitled() inside. A signed-out
-- visitor asking the assistant about tennis gets record and rating facts, and
-- is told plainly that prices are a subscriber surface.
-- ===========================================================================

-- "Who is the strongest player on clay right now?"
create or replace function tennis.ai_surface_leaders(
  p_tour text default null, p_surface text default 'clay', p_limit integer default 10)
returns table (
  player_id text, full_name text, tour text, country text,
  surface_elo numeric, surface_sample integer, power_rating numeric,
  uncertainty numeric, official_rank integer, form_90d numeric,
  last_match_date date, rating_version text, computed_at timestamptz)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select r.player_id, p.full_name, r.tour, p.country,
         case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_elo
           when 'grass'  then r.grass_elo
           when 'carpet' then r.carpet_elo
           when 'hard'   then r.hard_elo
           else r.elo end,
         case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_sample
           when 'grass'  then r.grass_sample
           when 'carpet' then r.carpet_sample
           when 'hard'   then r.hard_sample
           else r.elo_sample end,
         r.power_rating, r.uncertainty, r.official_rank, r.form_90d,
         r.last_match_date, r.rating_version, r.computed_at
    from tennis.player_ratings_current r
    join tennis.players p on p.player_id = r.player_id
   where (p_tour is null or r.tour = upper(p_tour))
     -- a rating built on almost nothing is not a leader, it is a gap
     and case lower(coalesce(p_surface,'hard'))
           when 'clay'   then r.clay_sample
           when 'grass'  then r.grass_sample
           when 'carpet' then r.carpet_sample
           when 'hard'   then r.hard_sample
           else r.elo_sample end >= 15
   order by case lower(coalesce(p_surface,'hard'))
              when 'clay'   then r.clay_elo
              when 'grass'  then r.grass_elo
              when 'carpet' then r.carpet_elo
              when 'hard'   then r.hard_elo
              else r.elo end desc nulls last
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- "Which ATP or WTA matches show the largest model/market disagreement?"
-- Priced: entitled callers only, and it says so by returning nothing rather
-- than by throwing, so the assistant can report the boundary instead of an error.
create or replace function tennis.ai_market_disagreement(
  p_tour text default null, p_limit integer default 10)
returns table (
  match_ref text, tour text, tournament_name text, surface text, round text,
  scheduled_at timestamptz, player_a_name text, player_b_name text,
  model_prob_a numeric, market_prob_a numeric, probability_gap numeric,
  fair_odds_a_decimal numeric, confidence numeric, uncertainty numeric,
  research_grade text, exclusion_reasons text[], model_version text,
  feature_snapshot_at timestamptz, market_captured_at timestamptz, market_book text)
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select b.match_ref, b.tour, bp.tournament_name, bp.surface, bp.round, bp.scheduled_at,
         b.player_a_name, b.player_b_name,
         b.prob_a, b.market_prob_a, abs(b.prob_a - b.market_prob_a),
         b.fair_odds_a_decimal, b.confidence, b.uncertainty,
         b.research_grade, b.exclusion_reasons, b.model_version,
         b.feature_snapshot_at, b.market_captured_at, b.market_book
    from tennis.board_research b
    left join tennis.board_public bp on bp.match_ref = b.match_ref
   where tennis.viewer_is_entitled()
     and b.market_prob_a is not null and b.prob_a is not null
     and b.research_grade in ('research','provisional')
     and (p_tour is null or b.tour = upper(p_tour))
     and b.generated_at > now() - interval '2 days'
   order by abs(b.prob_a - b.market_prob_a) desc
   limit greatest(1, least(coalesce(p_limit, 10), 25));
$$;

-- Everything the assistant may know about one player, in one bounded read.
create or replace function tennis.ai_player_context(p_player_id text)
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'player', to_jsonb(pp) - 'name_norm',
    'surface_record', coalesce((
      select jsonb_agg(jsonb_build_object('surface', s.surface, 'wins', s.wins,
                       'losses', s.losses, 'matches', s.matches, 'win_pct', s.win_pct))
        from (select surface, sum(wins)::int wins, sum(losses)::int losses,
                     sum(matches)::int matches,
                     round((sum(wins)::numeric / nullif(sum(matches),0)), 4) win_pct
                from tennis.player_surface where player_id = p_player_id
               group by surface) s), '[]'::jsonb),
    'recent_matches', coalesce((
      select jsonb_agg(jsonb_build_object('match_date', f.match_date, 'won', f.won,
                       'opponent_id', f.opponent_id, 'surface', f.surface,
                       'tourney_name', f.tourney_name, 'round', f.round, 'score', f.score)
                       order by f.match_date desc)
        from (select * from tennis.player_form where player_id = p_player_id
               order by match_date desc limit 20) f), '[]'::jsonb),
    'rating_scale', tennis.power_rating_scale(),
    'record_source', (select jsonb_build_object('source_key', l.source_key,
                        'licence', l.licence, 'commercial_use', l.commercial_use)
                        from tennis.source_licenses l
                        join tennis.players pl on pl.source_key = l.source_key
                       where pl.player_id = p_player_id),
    'retrieved_at', now())
    from tennis.player_profile pp
   where pp.player_id = p_player_id;
$$;

-- Everything the assistant may know about one upcoming match. The priced half
-- is present only for an entitled caller; the record half always is, and
-- `missing` names what nobody has rather than leaving a hole.
create or replace function tennis.ai_match_context(p_match_ref text)
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'match', (select to_jsonb(bp) from tennis.board_public bp where bp.match_ref = p_match_ref),
    'entitled', tennis.viewer_is_entitled(),
    'prediction', case when tennis.viewer_is_entitled() then (
        select to_jsonb(b) from tennis.model_predictions b
         where b.match_ref = p_match_ref
         order by b.generated_at desc limit 1) else null end,
    'opportunities', case when tennis.viewer_is_entitled() then coalesce((
        select jsonb_agg(to_jsonb(r)) from tennis.research_opportunities r
         where r.match_ref = p_match_ref and r.status = 'open'), '[]'::jsonb) else null end,
    'market', case when tennis.viewer_is_entitled() then coalesce((
        select jsonb_agg(jsonb_build_object('sportsbook', o.sportsbook, 'market_type', o.market_type,
                         'selection', o.selection, 'odds_decimal', o.odds_decimal,
                         'implied_prob', o.implied_prob, 'captured_at', o.captured_at,
                         'market_state', o.market_state) order by o.captured_at desc)
          from (select * from tennis.odds_snapshots
                 where match_ref = p_match_ref order by captured_at desc limit 40) o), '[]'::jsonb)
      else null end,
    'weather', (
        select jsonb_build_object('temporal_precision', w.temporal_precision,
                 'usable', tennis.weather_is_usable(v.environment, w.temporal_precision,
                                                    v.resolution_confidence, w.quality),
                 'temp_mean_f', w.temp_mean_f, 'wind_mean_mph', w.wind_mean_mph,
                 'humidity_mean_pct', w.humidity_mean_pct, 'precip_in', w.precip_in,
                 'observed_on', w.observed_on, 'venue_confidence', v.resolution_confidence,
                 'environment', v.environment)
          from tennis.board_public bp2
          join tennis.tournaments t on t.tournament_id = bp2.tournament_id
          join tennis.venues v on v.venue_id = t.venue_id
          join tennis.weather_observations w on w.tournament_id = t.tournament_id
         where bp2.match_ref = p_match_ref
         order by w.observed_on desc limit 1),
    'health', (select to_jsonb(h) from tennis.record_health h),
    'retrieved_at', now());
$$;

-- "What information is missing?" — asked of the whole tennis surface.
create or replace function tennis.ai_data_health()
returns jsonb
language sql
stable
security definer
set search_path = tennis, pg_temp
as $$
  select jsonb_build_object(
    'health', (select to_jsonb(h) from tennis.record_health h),
    'licences', (select jsonb_agg(jsonb_build_object('source_key', source_key, 'licence', licence,
                   'commercial_use', commercial_use, 'allowed_uses', allowed_uses))
                   from tennis.source_licenses),
    'open_issues', coalesce((select jsonb_agg(jsonb_build_object('issue_type', issue_type,
                     'severity', severity, 'occurrences', occurrences, 'detail', detail))
                     from (select * from tennis.data_quality_issues where resolved_at is null
                            order by occurrences desc limit 20) d), '[]'::jsonb),
    'last_runs', coalesce((select jsonb_agg(jsonb_build_object('job', job, 'status', status,
                    'finished_at', finished_at, 'rows_read', rows_read,
                    'rows_rejected', rows_rejected, 'reconciled', reconciled))
                    from (select distinct on (job) * from tennis.ingestion_runs
                           order by job, started_at desc) r), '[]'::jsonb),
    'retrieved_at', now());
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'tennis.ai_surface_leaders(text, text, integer)',
    'tennis.ai_market_disagreement(text, integer)',
    'tennis.ai_player_context(text)',
    'tennis.ai_match_context(text)',
    'tennis.ai_data_health()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end $$;

-- ===========================================================================
-- ROW LEVEL SECURITY, GRANTS, AND THE DOOR EACH TABLE HAS.
--
-- Four postures, and every table below is in exactly one of them:
--
--   PRIVATE      staging, point-in-time features, ingestion runs, data-quality
--                issues. RLS on, NO grant to any client role. Not readable by
--                a browser under any session, entitled or not. These are the
--                model's training inputs and the pipeline's own diary.
--   PUBLIC       the record: players, matches, tournaments, rankings, ratings,
--                venues, weather, licences. Readable by anyone, writable by
--                nobody but the service role.
--   SUBSCRIBER   predictions, odds snapshots, research opportunities. Readable
--                only by a signed-in account that public.community_is_entitled
--                says is entitled.
--   RECORD       tennis.prediction_record — public once the match has started
--                or settled, subscriber-only before then. Exactly the boundary
--                public.public_brief_closes already draws: the live board is
--                the paywall, the history is not.
--
-- No client role gets INSERT, UPDATE or DELETE on anything. The pipeline writes
-- as service_role, which bypasses RLS, and that is the only write door.
-- Only tables THIS file creates are touched: the live contract's own tables and
-- policies are left exactly as they are.
-- ===========================================================================

-- ---- PRIVATE ---------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['stg_archive_matches','player_match_features',
                           'ingestion_runs','data_quality_issues'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke all on tennis.%I from anon, authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    -- no policy: RLS with no policy denies every row to every non-bypassing role
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_public_read', t);
  end loop;
end $$;

-- ---- PUBLIC ----------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['players','matches','venues','weather_observations',
                           'rankings_current','player_ratings_current','source_licenses',
                           'model_registry'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on tennis.%I from anon, authenticated', t);
    execute format('grant select on tennis.%I to anon, authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_public_read', t);
    execute format('create policy %I on tennis.%I for select to anon, authenticated using (true)',
                   'tennis_' || t || '_public_read', t);
  end loop;
end $$;

-- tennis.tournaments is the live contract's table. It already carries RLS, a
-- public read policy and the service-role grant; this file adds columns to it
-- and must not restate its door. The report checks the door is still there.
do $$
begin
  if to_regclass('tennis.tournaments') is not null
     and not exists (select 1 from pg_policies
                      where schemaname = 'tennis' and tablename = 'tournaments') then
    -- only when nothing has granted it yet (this file applied first)
    execute 'alter table tennis.tournaments enable row level security';
    execute 'revoke insert, update, delete, truncate, references, trigger on tennis.tournaments from anon, authenticated';
    execute 'grant select on tennis.tournaments to anon, authenticated';
    execute 'grant all on tennis.tournaments to service_role';
    execute 'create policy tennis_tournaments_public_read on tennis.tournaments for select to anon, authenticated using (true)';
  end if;
end $$;

-- ---- SUBSCRIBER ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['model_predictions','odds_snapshots','research_opportunities'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke all on tennis.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on tennis.%I from authenticated', t);
    execute format('grant select on tennis.%I to authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_subscriber_read', t);
    execute format('create policy %I on tennis.%I for select to authenticated using (tennis.viewer_is_entitled())',
                   'tennis_' || t || '_subscriber_read', t);
  end loop;
end $$;

-- ---- THE PUBLIC RECORD -----------------------------------------------------
alter table tennis.prediction_record enable row level security;
revoke insert, update, delete, truncate, references, trigger on tennis.prediction_record from anon, authenticated;
grant select on tennis.prediction_record to anon, authenticated;
grant all on tennis.prediction_record to service_role;
drop policy if exists tennis_record_public_read on tennis.prediction_record;
-- A claim becomes public when the match it is about has started. Before then it
-- is a live research surface and follows the subscriber rule.
create policy tennis_record_public_read on tennis.prediction_record
  for select to anon, authenticated
  using (settled_at is not null
         or (scheduled_at is not null and scheduled_at <= now()));
drop policy if exists tennis_record_subscriber_read on tennis.prediction_record;
create policy tennis_record_subscriber_read on tennis.prediction_record
  for select to authenticated
  using (tennis.viewer_is_entitled());

-- ---- VIEWS -----------------------------------------------------------------
-- Every one is security_invoker, so these grants hand out no authority the
-- caller's own policies do not already give them.
grant select on tennis.player_match_rows, tennis.player_career, tennis.player_season,
                tennis.player_surface, tennis.player_form, tennis.h2h,
                tennis.player_profile, tennis.board_public, tennis.record_health,
                tennis.public_record_summary, tennis.public_record_calibration
  to anon, authenticated, service_role;
grant select on tennis.board_research, tennis.board_current, tennis.match_context to authenticated, service_role;
revoke all on tennis.board_research from anon;
revoke all on tennis.board_current from anon;
revoke all on tennis.match_context from anon;

grant usage, select on all sequences in schema tennis to service_role;

-- ===========================================================================
-- MAINTENANCE HELPERS. Used by the importer; not reachable from a browser.
-- ===========================================================================

-- Expensive secondary indexes are built AFTER a bulk backfill, not during it.
-- These two calls are what the importer brackets its COPY with.
create or replace function tennis.drop_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare i text;
begin
  foreach i in array array['tennis_matches_winner_date_idx','tennis_matches_loser_date_idx',
                           'tennis_matches_surface_date_idx','tennis_matches_season_idx',
                           'tennis_matches_uid_idx','tennis_matches_tournament_idx',
                           'tennis_pmf_player_date_idx','tennis_pmf_surface_idx'] loop
    execute format('drop index if exists tennis.%I', i);
  end loop;
end $$;

create or replace function tennis.rebuild_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
begin
  create index if not exists tennis_matches_winner_date_idx  on tennis.matches (winner_id, match_date desc);
  create index if not exists tennis_matches_loser_date_idx   on tennis.matches (loser_id, match_date desc);
  create index if not exists tennis_matches_surface_date_idx on tennis.matches (surface, match_date desc);
  create index if not exists tennis_matches_season_idx       on tennis.matches (tour, season desc, match_date desc);
  create index if not exists tennis_matches_uid_idx          on tennis.matches (source_match_uid);
  create index if not exists tennis_matches_tournament_idx   on tennis.matches (tournament_id, round_order);
  create index if not exists tennis_pmf_player_date_idx      on tennis.player_match_features (player_id, match_date desc);
  create index if not exists tennis_pmf_surface_idx          on tennis.player_match_features (surface, match_date);
  analyze tennis.matches;
  analyze tennis.player_match_features;
  analyze tennis.players;
end $$;

revoke all on function tennis.drop_backfill_indexes() from public, anon, authenticated;
revoke all on function tennis.rebuild_backfill_indexes() from public, anon, authenticated;
grant execute on function tennis.drop_backfill_indexes() to service_role;
grant execute on function tennis.rebuild_backfill_indexes() to service_role;

-- Record one data-quality issue, deduplicated. The importer calls this rather
-- than writing the table, so the dedup rule lives in one place.
create or replace function tennis.record_quality_issue(
  p_run_id uuid, p_source_key text, p_issue_type text, p_severity text,
  p_entity_type text, p_entity_key text, p_field text,
  p_observed text, p_expected text, p_detail text, p_payload jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare id bigint;
begin
  insert into tennis.data_quality_issues
    (run_id, source_key, issue_type, severity, entity_type, entity_key, field,
     observed, expected, detail, payload)
  values (p_run_id, p_source_key, p_issue_type, coalesce(p_severity,'warn'),
          p_entity_type, p_entity_key, p_field, p_observed, p_expected, p_detail, p_payload)
  on conflict (issue_type, coalesce(entity_type,''), coalesce(entity_key,''), coalesce(field,''))
    where resolved_at is null
  do update set occurrences = tennis.data_quality_issues.occurrences + 1,
                last_seen_at = now(),
                run_id = excluded.run_id,
                detail = excluded.detail
  returning issue_id into id;
  return id;
end $$;
revoke all on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- The freshness stamp the Tennis panel reads. Written here so a database that
-- has the contract but no rows yet still says which contract it has.
-- ---------------------------------------------------------------------------
insert into tennis.meta (key, value)
values ('record_contract', 'tennis_record.sql')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- ===========================================================================
-- THE REPORT. Every row must read ok.
-- ===========================================================================
with checks as (
select 1::numeric as row, 'the licensing gate exists and the archive is registered non-commercial' as check,
       case when to_regclass('tennis.source_licenses') is not null
             and exists (select 1 from tennis.source_licenses
                          where source_key = 'archive' and commercial_use = false)
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'an unregistered source cannot be stored',
       case when (select count(*) from pg_trigger
                   where tgname in ('tennis_matches_license','tennis_players_license')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the record tables exist (players, matches, rankings)',
       case when to_regclass('tennis.players') is not null
             and to_regclass('tennis.matches') is not null
             and to_regclass('tennis.rankings_current') is not null then 'ok' else 'CHECK THIS' end
union all select 4, 'the five record views app.html has always read exist',
       case when to_regclass('tennis.player_career') is not null
             and to_regclass('tennis.player_season') is not null
             and to_regclass('tennis.player_surface') is not null
             and to_regclass('tennis.player_form') is not null
             and to_regclass('tennis.h2h') is not null then 'ok' else 'CHECK THIS' end
union all select 5, 'the point-in-time feature table exists and is PRIVATE',
       case when to_regclass('tennis.player_match_features') is not null
             and not has_table_privilege('anon', 'tennis.player_match_features', 'SELECT')
             and not has_table_privilege('authenticated', 'tennis.player_match_features', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 6, 'staging is private too',
       case when to_regclass('tennis.stg_archive_matches') is not null
             and not has_table_privilege('anon', 'tennis.stg_archive_matches', 'SELECT')
             and not has_table_privilege('authenticated', 'tennis.stg_archive_matches', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 7, 'ratings, venues and weather exist',
       case when to_regclass('tennis.player_ratings_current') is not null
             and to_regclass('tennis.venues') is not null
             and to_regclass('tennis.weather_observations') is not null then 'ok' else 'CHECK THIS' end
union all select 8, 'the market, model and research layers exist',
       case when to_regclass('tennis.odds_snapshots') is not null
             and to_regclass('tennis.model_registry') is not null
             and to_regclass('tennis.model_predictions') is not null
             and to_regclass('tennis.research_opportunities') is not null then 'ok' else 'CHECK THIS' end
union all select 9, 'a prediction cannot be rewritten and a model version cannot be edited',
       case when (select count(*) from pg_trigger
                   where tgname in ('tennis_pred_freeze','tennis_model_freeze','tennis_rec_freeze')) = 3
            then 'ok' else 'CHECK THIS' end
union all select 10, 'at most one active model per family',
       case when to_regclass('tennis.tennis_model_one_active_idx') is not null then 'ok' else 'CHECK THIS' end
union all select 11, 'operations tables exist (runs, data quality)',
       case when to_regclass('tennis.ingestion_runs') is not null
             and to_regclass('tennis.data_quality_issues') is not null then 'ok' else 'CHECK THIS' end
union all select 12, 'anon may READ the public record layer',
       case when has_table_privilege('anon', 'tennis.players', 'SELECT')
             and has_table_privilege('anon', 'tennis.matches', 'SELECT')
             and has_table_privilege('anon', 'tennis.player_ratings_current', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 13, 'anon may NOT read predictions, prices or opportunities',
       case when not has_table_privilege('anon', 'tennis.model_predictions', 'SELECT')
             and not has_table_privilege('anon', 'tennis.odds_snapshots', 'SELECT')
             and not has_table_privilege('anon', 'tennis.research_opportunities', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 14, 'no client role may WRITE anything in this contract',
       case when not exists (
              select 1 from information_schema.role_table_grants
               where table_schema = 'tennis'
                 and grantee in ('anon','authenticated')
                 and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
                 and table_name in ('players','matches','rankings_current','player_ratings_current',
                                    'venues','weather_observations','odds_snapshots','model_registry',
                                    'model_predictions','research_opportunities','prediction_record',
                                    'player_match_features','stg_archive_matches','ingestion_runs',
                                    'data_quality_issues','source_licenses'))
            then 'ok' else 'CHECK THIS' end
union all select 15, 'row level security is on for every table this file creates',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'tennis' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('players','matches','rankings_current','player_ratings_current',
                                       'venues','weather_observations','odds_snapshots','model_registry',
                                       'model_predictions','research_opportunities','prediction_record',
                                       'player_match_features','stg_archive_matches','ingestion_runs',
                                       'data_quality_issues','source_licenses')) = 16
            then 'ok' else 'CHECK THIS' end
union all select 16, 'the subscriber policies use the project entitlement rule',
       case when (select count(*) from pg_policies
                   where schemaname = 'tennis'
                     and policyname like '%subscriber_read'
                     and qual like '%viewer_is_entitled%') >= 3
            then 'ok' else 'CHECK THIS' end
union all select 17, 'the exposed views are security_invoker',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'tennis' and c.relkind = 'v'
                     and c.relname in ('player_career','player_surface','player_form','h2h',
                                       'player_profile','board_public','board_research',
                                       'board_current','match_context','record_health')
                     and c.reloptions::text like '%security_invoker=true%') = 10
            then 'ok' else 'CHECK THIS' end
union all select 18, 'anon cannot reach the priced views',
       case when not has_table_privilege('anon', 'tennis.board_research', 'SELECT')
             and not has_table_privilege('anon', 'tennis.board_current', 'SELECT')
             and not has_table_privilege('anon', 'tennis.match_context', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 19, 'every privileged function has a fixed search_path and no public execute',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                                  where c like 'search_path=%'))
            and not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and has_function_privilege('public', p.oid, 'EXECUTE'))
            then 'ok' else 'CHECK THIS' end
union all select 19.5, 'the health line is readable WITHOUT reading a private table',
       case when (select count(*) from tennis.record_health) = 1
             and to_regprocedure('tennis.ops_health()') is not null
             and has_function_privilege('anon', 'tennis.ops_health()', 'EXECUTE')
             and not has_table_privilege('anon', 'tennis.ingestion_runs', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 20, 'the AI context functions exist',
       case when to_regprocedure('tennis.ai_surface_leaders(text, text, integer)') is not null
             and to_regprocedure('tennis.ai_market_disagreement(text, integer)') is not null
             and to_regprocedure('tennis.ai_player_context(text)') is not null
             and to_regprocedure('tennis.ai_match_context(text)') is not null
             and to_regprocedure('tennis.ai_data_health()') is not null then 'ok' else 'CHECK THIS' end
union all select 21, 'the public record and calibration views exist',
       case when to_regclass('tennis.prediction_record') is not null
             and to_regclass('tennis.public_record_summary') is not null
             and to_regclass('tennis.public_record_calibration') is not null then 'ok' else 'CHECK THIS' end
union all select 22, 'the LIVE contract is untouched by this file',
       case when to_regclass('tennis.live_matches') is null then 'ok (live contract not installed)'
            when (select count(*) from pg_policies
                   where schemaname = 'tennis' and tablename = 'live_matches') >= 1
            then 'ok (live tables keep their own policies)' else 'CHECK THIS' end
union all select 22.5, 'match identity is the draw slot AND the unordered player pair',
       case when exists (select 1 from pg_indexes where schemaname = 'tennis'
                          and indexname = 'tennis_matches_slot_unique_idx')
             and not exists (select 1 from pg_constraint where conname = 'tennis_matches_slot_unique')
            then 'ok' else 'CHECK THIS' end
union all select 23, 'tennis.tournaments gained the archive columns and kept its own door',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'tennis' and table_name = 'tournaments'
                            and column_name = 'season')
             and has_table_privilege('anon', 'tennis.tournaments', 'SELECT')
             and not has_table_privilege('anon', 'tennis.tournaments', 'INSERT')
            then 'ok' else 'CHECK THIS' end
union all select 24, 'the schema is served by the Data API',
       case when exists (select 1 from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) c
                          where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%'
                            and c like '%tennis%')
            then 'ok'
            when not exists (select 1 from pg_roles where rolname = 'authenticator')
            then 'ok (no authenticator role — not a Supabase project)'
            else 'CHECK THIS — add tennis under Project Settings > API > Exposed schemas' end
)
select "row"::text as row, "check", result from checks order by "row";
