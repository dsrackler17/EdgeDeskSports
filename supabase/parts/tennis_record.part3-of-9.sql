-- tennis_record -- part 3 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
