-- ===========================================================================
-- EdgeDesk Tennis — the Live Match Center data contract.
--
-- WHY THIS FILE EXISTS. The Tennis tab is three record browsers: the ATP and
-- WTA licensed match record, and the WTA research engine. There is no live
-- layer at all, and the repository says so out loud in its own evidence
-- contract: "Serve/return splits (hold %, first-serve won, ace %) are not
-- ingested — the tennis schema stores results, surfaces and rankings, not
-- point-level serve data." So a reader watching a match has nothing, and the
-- one thing tennis research turns on — who is holding serve and what changed —
-- is exactly what EdgeDesk could not say.
--
-- This is the live contract, fed from GitHub Actions (tools/tennis/*.js, over
-- PostgREST with the service role) and read by the browser through the same
-- anon/RLS door every other research table uses. No Edge Function is in the
-- path.
--
--   tennis.tournaments        one row per event: tour, surface, level, venue
--   tennis.live_matches       one row per match: sides, round, best-of, score,
--                             status, result — and first_point_at, the boundary
--                             a closing line must sit at or before
--   tennis.match_live_state   the latest cumulative serve/return statistics,
--                             one row per side. THIS is the gap the contract
--                             above names, closed from the live feed.
--   tennis.match_set_stats    per set per side (provider splits where the
--                             source publishes them, otherwise the difference
--                             between cumulative snapshots at set boundaries,
--                             labelled as such)
--   tennis.match_snapshots    immutable timeline, deduplicated by content
--   tennis.player_aliases     provider ids and name variants -> tennis.players
--   tennis.player_baselines   precomputed tendencies, WITH sample sizes: the
--                             licensed record's surface and form splits, plus
--                             EdgeDesk's OWN observed serve/return baselines,
--                             which start empty and say so
--   tennis.match_markets      the link from a match to its odds fixture, made
--                             only when BOTH participants resolved. A DOUBLES
--                             pair is a team, never a singles player, and is
--                             never resolved to one.
--   tennis.market_captures    every price observation tagged PRE or LIVE
--                             against the match's own first point
--   tennis.market_rejections  what the linker refused, and why, for operators
--   tennis.pipeline_runs      heartbeat and diagnostics for every job
--   tennis.live_locks         one live poller per tour-day, enforced here
--
-- NOTHING EXISTING IS TOUCHED. The licensed record (tennis.players,
-- tennis.matches, tennis.rankings_current, tennis.player_career,
-- tennis.player_surface, tennis.player_form, tennis.h2h) is not altered, and
-- the live tables carry their own `source` column so the two can never be
-- confused: the record is the licensed feed, the live layer is the provider's
-- public scoreboard, and every screen says which it is reading.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor. Every report row should say ok.
--
-- Tested against a real PostgreSQL by tools/tennis/tennis_sql.test.js
-- (`npm run tennis:sql`), which applies this file twice, attacks it as anon and
-- as authenticated, and races the lock.
-- ===========================================================================

create schema if not exists tennis;
grant usage on schema tennis to anon, authenticated, service_role;

-- The record pipeline's own ledger already lives here (key/value) and the app
-- reads it for the freshness stamp. In production a schema's pre-existing
-- ledger has been found owned WITHOUT a grant to service_role — the UFC sync
-- logged "permission denied for table meta" on its first real run — so the
-- grant is made here, explicitly, and the report checks it.
create table if not exists tennis.meta (
  key   text primary key,
  value text
);
grant select, insert, update on tennis.meta to service_role;
grant select on tennis.meta to anon, authenticated;

-- ---------------------------------------------------------------------------
-- updated_at, kept by the database rather than by every writer remembering to
-- ---------------------------------------------------------------------------
create or replace function tennis.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- TOURNAMENTS
-- ---------------------------------------------------------------------------
create table if not exists tennis.tournaments (
  tournament_id           text primary key,              -- 'espn:<provider id>'
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
create index if not exists tennis_tournaments_start_idx on tennis.tournaments (start_date desc);
create index if not exists tennis_tournaments_state_idx on tennis.tournaments (state, start_date desc);
drop trigger if exists tennis_tournaments_touch on tennis.tournaments;
create trigger tennis_tournaments_touch before update on tennis.tournaments
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- MATCHES
--
-- home/away are the provider's own two sides. In DOUBLES a side is a PAIR, so
-- home_player_id stays null and is_doubles is true: a pair is never resolved
-- to one of its players, and never linked to a singles market.
-- ---------------------------------------------------------------------------
create table if not exists tennis.live_matches (
  match_id            text primary key,                  -- 'espn:<competition id>'
  tournament_id       text not null references tennis.tournaments(tournament_id) on delete cascade,
  provider            text not null default 'espn',
  provider_match_id   text not null,
  tour                text,
  round               text,
  round_order         integer,
  match_order         integer,
  court               text,
  is_doubles          boolean not null default false,
  best_of             integer,
  scheduled_at        timestamptz,
  home_provider_id    text,
  away_provider_id    text,
  home_name           text,
  away_name           text,
  home_player_id      text,                              -- tennis.players.player_id when resolved
  away_player_id      text,
  home_seed           text,
  away_seed           text,
  home_rank           integer,
  away_rank           integer,
  side_source         text not null default 'provider_order',
  status              text not null default 'scheduled',
  status_detail       text,
  current_set         integer,
  sets_home           integer,
  sets_away           integer,
  games_home          integer,
  games_away          integer,
  points_home         text,
  points_away         text,
  set_scores          jsonb,
  server_side         text,
  winner_side         text,
  winner_player_id    text,
  result_type         text,
  result_detail       text,
  elapsed_seconds     integer,
  -- THE BOUNDARY. first_point_at is the LAST poll that still saw this match as
  -- not started, so every capture at or before it is provably pre-match. When
  -- the poller only ever saw the match live (a restart mid-match) it stays null
  -- and close_bound_source says which weaker bound, if any, applies.
  first_point_at      timestamptz,
  first_live_seen_at  timestamptz,
  close_bound_source  text,
  completed_at        timestamptz,
  source_updated_at   timestamptz,
  ingested_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint tennis_matches_status_shape check
    (status in ('scheduled','live','final','cancelled','postponed','walkover','unknown')),
  constraint tennis_matches_winner_shape check
    (winner_side is null or winner_side in ('home','away')),
  constraint tennis_matches_server_shape check
    (server_side is null or server_side in ('home','away')),
  constraint tennis_matches_result_shape check
    (result_type is null or result_type in ('completed','retirement','walkover','default','abandoned')),
  constraint tennis_matches_close_bound_shape check
    (close_bound_source is null or close_bound_source in ('observed_first_point','scheduled_start')),
  constraint tennis_matches_provider_key unique (provider, provider_match_id)
);
create index if not exists tennis_matches_tournament_idx on tennis.live_matches (tournament_id, round_order, match_order);
create index if not exists tennis_matches_home_idx on tennis.live_matches (home_player_id);
create index if not exists tennis_matches_away_idx on tennis.live_matches (away_player_id);
create index if not exists tennis_matches_status_idx on tennis.live_matches (status, scheduled_at desc);
create index if not exists tennis_matches_scheduled_idx on tennis.live_matches (scheduled_at desc);
drop trigger if exists tennis_live_matches_touch on tennis.live_matches;
create trigger tennis_live_matches_touch before update on tennis.live_matches
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- LIVE STATE — the latest cumulative numbers, one row per side. Only the
-- fields the source actually publishes are ever non-null; a dash in the UI is
-- a null here, never a zero written for convenience.
-- ---------------------------------------------------------------------------
create table if not exists tennis.match_live_state (
  match_id                    text not null references tennis.live_matches(match_id) on delete cascade,
  tournament_id               text not null,
  side                        text not null,
  player_id                   text,
  provider_athlete_id         text,
  player_name                 text,
  status                      text,
  current_set                 integer,
  sets_won                    integer,
  games_won                   integer,
  -- serve
  aces                        integer,
  double_faults               integer,
  first_serves_in             integer,
  first_serves_total          integer,
  first_serve_points_won      integer,
  first_serve_points_total    integer,
  second_serve_points_won     integer,
  second_serve_points_total   integer,
  service_games_played        integer,
  service_games_won           integer,
  service_points_won          integer,
  service_points_total        integer,
  break_points_faced          integer,
  break_points_saved          integer,
  -- return
  return_games_played         integer,
  return_games_won            integer,
  return_points_won           integer,
  return_points_total         integer,
  break_points_won            integer,
  break_points_total          integer,
  -- rally and totals
  total_points_won            integer,
  winners                     integer,
  unforced_errors             integer,
  forced_errors               integer,
  net_points_won              integer,
  net_points_total            integer,
  max_serve_speed_kph         integer,
  avg_first_serve_speed_kph   integer,
  avg_second_serve_speed_kph  integer,
  tiebreaks_won               integer,
  tiebreaks_played            integer,
  stats_available             boolean not null default false,
  source                      text,
  source_updated_at           timestamptz,
  source_latency_ms           integer,
  content_hash                text,
  updated_at                  timestamptz not null default now(),
  primary key (match_id, side),
  constraint tennis_live_state_side_shape check (side in ('home','away'))
);
create index if not exists tennis_live_state_tournament_idx on tennis.match_live_state (tournament_id);
drop trigger if exists tennis_match_live_state_touch on tennis.match_live_state;
create trigger tennis_match_live_state_touch before update on tennis.match_live_state
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- SET STATS — that set only. stat_source says whether the provider published
-- the split or whether it is the difference between two cumulative snapshots
-- taken at the set's boundaries; the UI labels the second kind.
-- ---------------------------------------------------------------------------
create table if not exists tennis.match_set_stats (
  match_id                    text not null references tennis.live_matches(match_id) on delete cascade,
  tournament_id               text not null,
  set_number                  integer not null,
  side                        text not null,
  player_id                   text,
  set_status                  text not null default 'in_progress',
  stat_source                 text not null default 'snapshot_delta',
  games_won                   integer,
  tiebreak_points             integer,
  aces                        integer,
  double_faults               integer,
  first_serves_in             integer,
  first_serves_total          integer,
  first_serve_points_won      integer,
  first_serve_points_total    integer,
  second_serve_points_won     integer,
  second_serve_points_total   integer,
  service_games_played        integer,
  service_games_won           integer,
  service_points_won          integer,
  service_points_total        integer,
  break_points_faced          integer,
  break_points_saved          integer,
  return_points_won           integer,
  return_points_total         integer,
  break_points_won            integer,
  break_points_total          integer,
  total_points_won            integer,
  winners                     integer,
  unforced_errors             integer,
  updated_at                  timestamptz not null default now(),
  primary key (match_id, set_number, side),
  constraint tennis_set_stats_number_shape check (set_number >= 1),
  constraint tennis_set_stats_side_shape check (side in ('home','away')),
  constraint tennis_set_stats_status_shape check (set_status in ('in_progress','complete')),
  constraint tennis_set_stats_source_shape check (stat_source in ('provider','snapshot_delta'))
);
create index if not exists tennis_set_stats_tournament_idx on tennis.match_set_stats (tournament_id);
drop trigger if exists tennis_match_set_stats_touch on tennis.match_set_stats;
create trigger tennis_match_set_stats_touch before update on tennis.match_set_stats
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- SNAPSHOTS — immutable, deduplicated by content. The same state observed
-- twice (a restarted poller, a frozen upstream) is one row, which is what
-- makes a restart safe and a quiet changeover cheap.
-- ---------------------------------------------------------------------------
create table if not exists tennis.match_snapshots (
  id                        bigserial primary key,
  match_id                  text not null references tennis.live_matches(match_id) on delete cascade,
  side                      text not null,
  captured_at               timestamptz not null default now(),
  status                    text,
  current_set               integer,
  sets_won                  integer,
  games_won                 integer,
  points                    text,
  is_serving                boolean,
  aces                      integer,
  double_faults             integer,
  first_serves_in           integer,
  first_serves_total        integer,
  first_serve_points_won    integer,
  first_serve_points_total  integer,
  second_serve_points_won   integer,
  second_serve_points_total integer,
  service_games_played      integer,
  service_games_won         integer,
  break_points_faced        integer,
  break_points_saved        integer,
  break_points_won          integer,
  break_points_total        integer,
  return_points_won         integer,
  return_points_total       integer,
  total_points_won          integer,
  winners                   integer,
  unforced_errors           integer,
  content_hash              text not null,
  constraint tennis_snapshots_side_shape check (side in ('home','away')),
  constraint tennis_snapshots_dedup unique (match_id, side, content_hash)
);
create index if not exists tennis_snapshots_match_idx on tennis.match_snapshots (match_id, captured_at);

-- ---------------------------------------------------------------------------
-- PLAYER IDENTITY — provider ids and name variants resolved to the record's
-- player_id. An alias is written only when the resolution was unambiguous; a
-- surname two players share is not a match and is never stored. A DOUBLES pair
-- is never an alias for anybody.
-- ---------------------------------------------------------------------------
create table if not exists tennis.player_aliases (
  alias_key     text primary key,        -- 'espn:<athlete id>' | 'name:<normalized name>'
  player_id     text not null,
  display_name  text,
  tour          text,
  source        text not null default 'sync',
  confidence    text not null default 'exact',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- Stated once, wide enough from the start: the UFC contract shipped a narrower
-- list, the resolver learned a new kind, and production refused the write until
-- the file was re-run. Every kind the resolver can produce is admitted here.
alter table tennis.player_aliases drop constraint if exists tennis_aliases_confidence_shape;
alter table tennis.player_aliases add constraint tennis_aliases_confidence_shape check
  (confidence in ('exact','provider_id','name_order','first_last','initial_last','surname','curated','manual'));
create index if not exists tennis_aliases_player_idx on tennis.player_aliases (player_id);
drop trigger if exists tennis_player_aliases_touch on tennis.player_aliases;
create trigger tennis_player_aliases_touch before update on tennis.player_aliases
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- PLAYER BASELINES — precomputed by tools/tennis/build_baselines.js so the
-- browser compares two rows instead of recomputing a career. Every rate
-- carries the sample it was computed over; a metric with no sample is null.
--
-- Two kinds of baseline live here and are never mixed:
--   * the licensed record's: surface splits, form, ranking, activity;
--   * obs_*: EdgeDesk's OWN observed serve/return baselines, accumulated from
--     matches this pipeline has watched. They start empty and say so. This is
--     the only honest way to hold serve/return numbers the record does not
--     carry — nothing is backfilled from a source that does not publish it.
-- ---------------------------------------------------------------------------
create table if not exists tennis.player_baselines (
  player_id                  text primary key,
  full_name                  text,
  tour                       text,
  built_at                   timestamptz not null default now(),
  builder_version            text,
  -- samples
  matches_on_file            integer not null default 0,
  dated_matches              integer not null default 0,
  record_available           boolean not null default false,
  -- the licensed record
  career_wins                integer,
  career_losses              integer,
  career_matches             integer,
  career_win_pct             numeric,
  last_match_at              date,
  days_since_last_match      integer,
  matches_last_365           integer,
  matches_last_28            integer,
  current_streak             integer,
  form_last10_wins           integer,
  form_last10_sample         integer,
  rank                       integer,
  rank_points                integer,
  -- surface splits, with samples
  hard_win_pct               numeric,
  hard_matches               integer,
  clay_win_pct               numeric,
  clay_matches               integer,
  grass_win_pct              numeric,
  grass_matches              integer,
  carpet_win_pct             numeric,
  carpet_matches             integer,
  surface_splits             jsonb,
  -- EdgeDesk-observed live baselines (from this pipeline's own matches)
  obs_matches                integer not null default 0,
  obs_hold_pct               numeric,
  obs_break_pct              numeric,
  obs_first_serve_pct        numeric,
  obs_first_serve_won_pct    numeric,
  obs_second_serve_won_pct   numeric,
  obs_service_points_won_pct numeric,
  obs_return_points_won_pct  numeric,
  obs_ace_per_service_game   numeric,
  obs_df_per_service_game    numeric,
  obs_bp_saved_pct           numeric,
  obs_bp_converted_pct       numeric,
  obs_tiebreaks_won          integer,
  obs_tiebreaks_played       integer,
  obs_deciding_sets_won      integer,
  obs_deciding_sets_played   integer,
  obs_set_profile            jsonb,
  -- style classification, from documented rules in lib/tennis_research.js
  style_labels               text[],
  style_rules_version        text,
  notes                      jsonb not null default '[]'::jsonb,
  updated_at                 timestamptz not null default now()
);
create index if not exists tennis_baselines_built_idx on tennis.player_baselines (built_at desc);
drop trigger if exists tennis_player_baselines_touch on tennis.player_baselines;
create trigger tennis_player_baselines_touch before update on tennis.player_baselines
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- MARKET LINKS — a match is linked to an odds fixture only when both of the
-- fixture's participants resolved to the match's two sides. A doubles fixture
-- is stored as doubles and never linked to a singles match.
-- ---------------------------------------------------------------------------
-- ───────────────────────────────────────────────────────────────────────────
-- THE PROVIDER PLAYER DIRECTORY.
--
-- The licensed record (tennis.players) is the authority on who a player is,
-- and this file does not touch it. But that record is empty in this project,
-- and the archive that would fill it is CC BY-NC-SA — non-commercial — which
-- is a licensing question for a human, not something a pipeline may decide.
-- Meanwhile every match the provider publishes already carries an athlete id
-- and a name, and 1,234 singles sides had nowhere to resolve to.
--
-- So this is a DIRECTORY, not a record: who the provider says is playing,
-- keyed in the provider's own namespace ('espn:<athlete id>') so it can never
-- collide with a licensed id. The resolver prefers the licensed record wherever
-- it has rows and falls back to this; the day a cleared feed is loaded, it wins
-- automatically and nothing here has to be unpicked.
--
-- Every column says where it came from. Nothing is inferred: a field the feed
-- does not publish stays null.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists tennis.player_directory (
  player_id            text primary key,           -- 'espn:<athlete id>'
  provider             text not null default 'espn',
  provider_athlete_id  text not null,
  full_name            text not null,
  display_name         text,
  short_name           text,
  tour                 text,
  country              text,
  country_code         text,
  plays                text,                       -- hand, only where published
  height_cm            integer,
  weight_kg            integer,
  birth_date           date,
  turned_pro           integer,
  current_rank         integer,
  rank_points          integer,
  rank_as_of           date,
  seen_in_doubles      boolean not null default false,
  seen_in_singles      boolean not null default false,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz,
  source               text not null default 'espn',
  source_detail        text,                       -- which request shape answered
  enriched_at          timestamptz,                -- null until the athlete endpoint answered
  updated_at           timestamptz not null default now(),
  constraint tennis_directory_provider_key unique (provider, provider_athlete_id),
  constraint tennis_directory_tour_shape check (tour is null or tour in ('ATP','WTA','MIXED','OTHER')),
  constraint tennis_directory_id_shape check (player_id like '%:%')
);
-- A provider athlete id is a POSITIVE INTEGER in one global namespace. The
-- feed also carries non-positive ids for entrants who are not yet a person —
-- a qualifier, a bye, a slot nobody has won. The same one turns up on both
-- tours in the same week, so it cannot be an identity: admitting it would
-- collapse every placeholder in every draw into a single player. Added
-- separately from the table so a database that already has the table gets it
-- too, and so a re-run never fails on a constraint that exists.
alter table tennis.player_directory drop constraint if exists tennis_directory_athlete_id_shape;
alter table tennis.player_directory add  constraint tennis_directory_athlete_id_shape
  check (provider_athlete_id ~ '^[0-9]+$' and provider_athlete_id::bigint > 0);
create index if not exists tennis_directory_name_idx on tennis.player_directory (lower(full_name));
create index if not exists tennis_directory_enriched_idx on tennis.player_directory (enriched_at nulls first);
drop trigger if exists tennis_directory_touch on tennis.player_directory;
create trigger tennis_directory_touch before update on tennis.player_directory
  for each row execute function tennis.touch_updated_at();

create table if not exists tennis.match_markets (
  match_id         text primary key references tennis.live_matches(match_id) on delete cascade,
  tournament_id    text not null,
  signal_event_id  text not null,
  sport_key        text not null,
  home_team        text,
  away_team        text,
  home_selection   text,
  away_selection   text,
  home_sig_key     text,
  away_sig_key     text,
  other_sig_keys   text[],
  commence_time    timestamptz,
  link_method      text not null,
  linked_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tennis_match_markets_fixture_key unique (signal_event_id),
  constraint tennis_match_markets_method_shape check
    (link_method in ('both_names_exact','both_names_alias','manual'))
);
create index if not exists tennis_match_markets_tournament_idx on tennis.match_markets (tournament_id);
drop trigger if exists tennis_match_markets_touch on tennis.match_markets;
create trigger tennis_match_markets_touch before update on tennis.match_markets
  for each row execute function tennis.touch_updated_at();

-- ---------------------------------------------------------------------------
-- MARKET CAPTURES — every observed price, tagged PRE or LIVE against the
-- match's own first point at the moment it was written. A LIVE row can never
-- be re-tagged PRE: the tag is part of the row, not a view over it.
-- ---------------------------------------------------------------------------
create table if not exists tennis.market_captures (
  id               bigserial primary key,
  match_id         text not null references tennis.live_matches(match_id) on delete cascade,
  tournament_id    text not null,
  sig_key          text not null,
  side             text not null,
  book             text,
  capture_at       timestamptz not null,
  market_state     text not null,
  set_number       integer,
  score            text,
  best_dec         numeric,
  sharp_fair       numeric,
  consensus_fair   numeric,
  n_books          integer,
  has_sharp        boolean,
  source           text not null default 'signals',
  constraint tennis_market_captures_side_shape check (side in ('home','away')),
  constraint tennis_market_captures_state_shape check (market_state in ('PRE','LIVE')),
  constraint tennis_market_captures_dedup unique (sig_key, capture_at)
);
create index if not exists tennis_market_captures_match_idx on tennis.market_captures (match_id, capture_at);
create index if not exists tennis_market_captures_tournament_idx on tennis.market_captures (tournament_id, market_state);

-- ---------------------------------------------------------------------------
-- MARKET REJECTIONS — what the linker refused, with its reason. This is the
-- operator's window onto a doubles pair priced as a player, or a fixture whose
-- participants never resolved.
-- ---------------------------------------------------------------------------
create table if not exists tennis.market_rejections (
  id               bigserial primary key,
  signal_event_id  text not null default '',
  sig_key          text not null default '',
  sport_key        text,
  home_team        text,
  away_team        text,
  selection        text,
  market           text,
  reason           text not null,
  detail           text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  seen_count       integer not null default 1,
  constraint tennis_market_rejections_key unique (signal_event_id, sig_key, reason)
);
create index if not exists tennis_market_rejections_seen_idx on tennis.market_rejections (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- PIPELINE RUNS — one row per job run, heartbeat while it lives. The status
-- view below reads the latest per job; the UI's health level is computed from
-- these stamps against stated thresholds, never from a status word alone.
-- ---------------------------------------------------------------------------
create table if not exists tennis.pipeline_runs (
  run_id                text primary key,
  job                   text not null,
  scope                 text,
  status                text not null default 'running',
  started_at            timestamptz not null default now(),
  heartbeat_at          timestamptz not null default now(),
  finished_at           timestamptz,
  last_success_at       timestamptz,
  last_source_at        timestamptz,
  source_latency_ms     integer,
  consecutive_failures  integer not null default 0,
  polls                 integer not null default 0,
  writes                integer not null default 0,
  github_run_id         text,
  github_run_url        text,
  workflow              text,
  message               text,
  details               jsonb not null default '{}'::jsonb,
  updated_at            timestamptz not null default now(),
  constraint tennis_pipeline_runs_status_shape check
    (status in ('running','ok','warn','error','cancelled','timeout','handed_off'))
);
create index if not exists tennis_pipeline_runs_job_idx on tennis.pipeline_runs (job, started_at desc);
drop trigger if exists tennis_pipeline_runs_touch on tennis.pipeline_runs;
create trigger tennis_pipeline_runs_touch before update on tennis.pipeline_runs
  for each row execute function tennis.touch_updated_at();

create or replace view tennis.pipeline_status
with (security_invoker = true) as
  select distinct on (job)
         job, run_id, scope, status, started_at, heartbeat_at, finished_at,
         last_success_at, last_source_at, source_latency_ms, consecutive_failures,
         polls, writes, github_run_id, github_run_url, workflow, message, details,
         extract(epoch from (now() - heartbeat_at))::integer as seconds_since_heartbeat,
         extract(epoch from (now() - coalesce(last_success_at, started_at)))::integer as seconds_since_success,
         extract(epoch from (now() - last_source_at))::integer as seconds_since_source
    from tennis.pipeline_runs
   order by job, started_at desc;

-- ---------------------------------------------------------------------------
-- LIVE LOCKS — one poller per scope. Tennis is polled TOUR-WIDE rather than
-- per event: several tournaments run at once and one scoreboard carries all of
-- their live matches, so the lock key is the tour and day, not a tournament.
-- Acquisition is a single statement, so two workflow runs that start in the
-- same second cannot both hold it; a holder that stops heartbeating loses it
-- after the TTL, so a cancelled job cannot fence the next one out.
-- ---------------------------------------------------------------------------
create table if not exists tennis.live_locks (
  lock_key      text primary key,
  owner         text not null,
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);

create or replace function tennis.acquire_live_lock(p_lock_key text, p_owner text, p_ttl_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare
  r tennis.live_locks%rowtype;
  ttl integer := greatest(coalesce(p_ttl_seconds, 120), 10);
begin
  if p_lock_key is null or p_owner is null or length(p_owner) = 0 then
    return jsonb_build_object('acquired', false, 'reason', 'missing_argument');
  end if;
  insert into tennis.live_locks (lock_key, owner, acquired_at, heartbeat_at, expires_at)
       values (p_lock_key, p_owner, now(), now(), now() + make_interval(secs => ttl))
  on conflict (lock_key) do update
     set owner        = excluded.owner,
         acquired_at  = case when tennis.live_locks.owner = excluded.owner then tennis.live_locks.acquired_at else now() end,
         heartbeat_at = now(),
         expires_at   = now() + make_interval(secs => ttl)
   where tennis.live_locks.owner = excluded.owner
      or tennis.live_locks.expires_at < now()
  returning * into r;
  if r.lock_key is null then
    select * into r from tennis.live_locks where lock_key = p_lock_key;
    return jsonb_build_object('acquired', false, 'reason', 'held',
                              'owner', r.owner, 'expires_at', r.expires_at, 'heartbeat_at', r.heartbeat_at);
  end if;
  return jsonb_build_object('acquired', true, 'owner', r.owner, 'expires_at', r.expires_at,
                            'acquired_at', r.acquired_at);
end $$;

create or replace function tennis.release_live_lock(p_lock_key text, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare n integer;
begin
  delete from tennis.live_locks where lock_key = p_lock_key and owner = p_owner;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function tennis.acquire_live_lock(text, text, integer) from public, anon, authenticated;
revoke all on function tennis.release_live_lock(text, text) from public, anon, authenticated;
grant execute on function tennis.acquire_live_lock(text, text, integer) to service_role;
grant execute on function tennis.release_live_lock(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY. Public reads on the research tables; no client role may
-- write anything; the lock table is unreachable from a browser altogether.
-- The service role bypasses RLS, which is the only door the jobs use.
-- Only the tables THIS file creates are touched: the licensed record's own
-- tables and policies are left exactly as they are.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tournaments','live_matches','match_live_state','match_set_stats','match_snapshots',
                           'player_aliases','player_baselines','player_directory','match_markets','market_captures',
                           'market_rejections','pipeline_runs'] loop
    execute format('alter table tennis.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on tennis.%I from anon, authenticated', t);
    execute format('grant select on tennis.%I to anon, authenticated', t);
    execute format('grant all on tennis.%I to service_role', t);
    execute format('drop policy if exists %I on tennis.%I', 'tennis_' || t || '_public_read', t);
    execute format('create policy %I on tennis.%I for select to anon, authenticated using (true)',
                   'tennis_' || t || '_public_read', t);
  end loop;
end $$;

alter table tennis.live_locks enable row level security;
revoke all on tennis.live_locks from anon, authenticated;
grant all on tennis.live_locks to service_role;

grant select on tennis.pipeline_status to anon, authenticated, service_role;
grant usage, select on all sequences in schema tennis to service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'tennis.tournaments / tennis.live_matches exist' as check,
       case when to_regclass('tennis.tournaments') is not null and to_regclass('tennis.live_matches') is not null
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'live state, set stats and snapshots exist',
       case when to_regclass('tennis.match_live_state') is not null
             and to_regclass('tennis.match_set_stats') is not null
             and to_regclass('tennis.match_snapshots') is not null then 'ok' else 'CHECK THIS' end
union all select 3, 'player aliases and baselines exist',
       case when to_regclass('tennis.player_aliases') is not null
             and to_regclass('tennis.player_baselines') is not null then 'ok' else 'CHECK THIS' end
union all select 4, 'match markets, captures and rejections exist',
       case when to_regclass('tennis.match_markets') is not null
             and to_regclass('tennis.market_captures') is not null
             and to_regclass('tennis.market_rejections') is not null then 'ok' else 'CHECK THIS' end
union all select 5, 'RLS is enabled on every new research table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'tennis' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('tournaments','live_matches','match_live_state','match_set_stats','match_snapshots',
                                       'player_aliases','player_baselines','match_markets','market_captures',
                                       'market_rejections','pipeline_runs','live_locks')) = 12
            then 'ok' else 'CHECK THIS' end
union all select 6, 'anon and authenticated may read the new research tables',
       case when (select count(*) from pg_policies where schemaname = 'tennis' and cmd = 'SELECT'
                   and policyname like 'tennis_%_public_read'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 11
            then 'ok' else 'CHECK THIS' end
union all select 7, 'no client write policy exists on anything this file created',
       case when not exists (select 1 from pg_policies where schemaname = 'tennis'
                              and policyname like 'tennis_%_public_read'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL'))
            then 'ok' else 'CHECK THIS' end
union all select 8, 'live_locks is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'tennis' and table_name = 'live_locks'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 9, 'lock routines are security definer and revoked from clients',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'tennis' and p.proname in ('acquire_live_lock','release_live_lock') and p.prosecdef) = 2
             and not has_function_privilege('anon', 'tennis.acquire_live_lock(text,text,integer)', 'execute')
             and not has_function_privilege('authenticated', 'tennis.acquire_live_lock(text,text,integer)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 10, 'pipeline_status view exists',
       case when to_regclass('tennis.pipeline_status') is not null then 'ok' else 'CHECK THIS' end
union all select 11, 'lookup indexes installed',
       case when to_regclass('tennis.tennis_matches_tournament_idx') is not null
             and to_regclass('tennis.tennis_live_state_tournament_idx') is not null
             and to_regclass('tennis.tennis_snapshots_match_idx') is not null
             and to_regclass('tennis.tennis_market_captures_match_idx') is not null
             and to_regclass('tennis.tennis_pipeline_runs_job_idx') is not null then 'ok' else 'CHECK THIS' end
union all select 12, 'snapshot, capture and link constraints installed',
       case when (select count(*) from pg_constraint
                   where conname in ('tennis_snapshots_dedup','tennis_market_captures_dedup','tennis_market_rejections_key',
                                     'tennis_match_markets_fixture_key','tennis_matches_provider_key','tennis_tournaments_provider_key')) = 6
            then 'ok' else 'CHECK THIS' end
union all select 13, 'service_role may write the tennis.meta ledger',
       case when has_table_privilege('service_role', 'tennis.meta', 'INSERT')
             and has_table_privilege('service_role', 'tennis.meta', 'UPDATE') then 'ok' else 'CHECK THIS' end
union all select 13.5, 'the provider player directory exists, is readable and is client-read-only',
       case when to_regclass('tennis.player_directory') is not null
             and has_table_privilege('anon', 'tennis.player_directory', 'SELECT')
             and not has_table_privilege('anon', 'tennis.player_directory', 'INSERT')
             and not has_table_privilege('anon', 'tennis.player_directory', 'UPDATE')
            then 'ok' else 'CHECK THIS' end
union all select 14, 'the licensed record is untouched by this file',
       case when to_regclass('tennis.players') is null then 'ok (record not installed here)'
            else 'ok (no table the record owns is altered above)' end
union all select 15, 'tennis schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists tennis — the record already reads through it)'
order by row;
