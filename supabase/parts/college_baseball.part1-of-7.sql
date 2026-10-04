-- college_baseball -- part 1 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ===========================================================================
   COLLEGE BASEBALL — the game log, and what is derived from it.

   WHAT THIS IS FOR. Research → Baseball carries MLB. This adds the college
   game alongside it: every game on the card, each one opening the same kind of
   brief, over a season that runs February to June.

   THE ONE DESIGN DECISION THAT MATTERS, and it was measured rather than
   assumed. ESPN's day scoreboard is NOT the whole card. Forty of its own 437
   teams, sampled across the alphabet, turned up a game on 2026-04-18 that the
   eighty-one-game scoreboard did not have at all. So the importer walks every
   team's schedule and unions them: a game appears on both its teams'
   schedules, so a union cannot lose a game that either side knows about.
   cbb.games is that union, and it is the spine of everything here.

   TEAM SEASONS ARE DERIVED, NEVER FETCHED. Records, runs for and against,
   home and away splits, conference form and streaks are all computed from
   cbb.games inside the promote. A club's record therefore cannot disagree
   with the games underneath it, because there is no second source for it to
   disagree with. It also means the archive extends as far back as the game
   log does, from one endpoint family rather than several.

   THE REFUSAL THAT EXISTS BECAUSE OF A MEASUREMENT. The source answers 200
   with an EMPTY slate when it is asked too quickly — twelve paced requests
   returned 81 games every time, while an unpaced burst returned zero. An
   importer that wrote that zero would delete a day's card and leave a screen
   that looked like a quiet Tuesday. So promote_cbb_import refuses an import
   that carries materially fewer games than the live table already holds for
   the same span, unless it is told in as many words that the shrinkage is
   real. An empty answer is not an empty day.

   Apply:  psql "$DATABASE_URL" -f supabase/college_baseball.sql
   Safe to re-run; it ends with a report of what it checked.
   =========================================================================== */

create schema if not exists cbb;

/* ── the ledger ───────────────────────────────────────────────────────────
   One row per import attempt. Nothing reads a staged row; the live tables are
   only ever written by the promote, in one transaction. */
create table if not exists cbb.import_runs (
  import_id        text primary key,
  dataset          text not null default 'games',
  status           text not null default 'staging',   -- staging | promoted | failed | superseded
  first_season     int,
  last_season      int,
  seasons          int[]        not null default '{}',
  row_counts       jsonb        not null default '{}',
  source           text,
  source_note      text,
  refusals         jsonb        not null default '[]',
  started_at       timestamptz  not null default now(),
  promoted_at      timestamptz,
  failed_at        timestamptz,
  failure_reason   text,
  updated_at       timestamptz  not null default now(),
  constraint cbb_import_runs_status_ck
    check (status in ('staging','promoted','failed','superseded')),
  constraint cbb_import_runs_dataset_ck
    check (dataset in ('games'))
);
alter table cbb.import_runs add column if not exists dataset text not null default 'games';

/* ── identity ─────────────────────────────────────────────────────────────
   The team ids are the source's own. A club that changes its name keeps its
   id, so the game log never has to be rewritten to follow a rename. */
create table if not exists cbb.teams (
  team_id          text primary key,
  name             text not null,
  short_name       text,
  abbreviation     text,
  slug             text,
  conference_id    text,
  conference_name  text,
  logo             text,
  color            text,
  first_seen_season int,
  last_seen_season  int,
  updated_at       timestamptz not null default now()
);

/* ── the game log: the union, and the spine ──────────────────────────────
   away_name/home_name are carried beside the ids on purpose. A game whose
   opponent is not in the team list — a non-Division-I visitor, most often —
   still has to be able to render, and a board that drops those games would be
   exactly the silent incompleteness this whole design exists to avoid. */
create table if not exists cbb.games (
  game_id          text primary key,
  season           int  not null,
  game_date        date not null,
  start_time       timestamptz,
  start_time_tbd   boolean not null default false,
  away_team_id     text,
  home_team_id     text,
  away_name        text not null,
  home_name        text not null,
  away_abbr        text,
  home_abbr        text,
  venue            text,
  venue_city       text,
  venue_state      text,
  neutral_site     boolean not null default false,
  conference_game  boolean not null default false,
  status_state     text,                 -- pre | in | post
  status_detail    text,
  completed        boolean not null default false,
  away_score       int,
  home_score       int,
  innings          int,
  away_rank        int,
  home_rank        int,
  notes            text,                 -- "Men's College World Series", a tournament name
  /* WHICH SOURCES SAW THIS GAME. A game only the scoreboard knows and a game
     only its teams' schedules know are different levels of confidence, and a
     reader is entitled to the difference. */
  seen_by          text[] not null default '{}',
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  constraint cbb_games_state_ck check (status_state is null or status_state in ('pre','in','post')),
  constraint cbb_games_sides_ck check (away_name <> '' and home_name <> '')
);
create index if not exists cbb_games_date_idx    on cbb.games (game_date, start_time);
create index if not exists cbb_games_season_idx  on cbb.games (season);
create index if not exists cbb_games_home_idx    on cbb.games (home_team_id, season);
create index if not exists cbb_games_away_idx    on cbb.games (away_team_id, season);

/* ── derived from the game log, inside the promote, never fetched ─────────
   Every column here is a fold over cbb.games. If a number on a club's page
   disagrees with the games listed under it, that is a bug in one place rather
   than a disagreement between two sources. */
create table if not exists cbb.team_seasons (
  season            int  not null,
  team_id           text not null,
  team_name         text not null,
  games             int  not null default 0,
  wins              int  not null default 0,
  losses            int  not null default 0,
  ties              int  not null default 0,
  runs_for          int  not null default 0,
  runs_against      int  not null default 0,
  home_wins         int  not null default 0,
  home_losses       int  not null default 0,
  away_wins         int  not null default 0,
  away_losses       int  not null default 0,
  neutral_wins      int  not null default 0,
  neutral_losses    int  not null default 0,
  conf_wins         int  not null default 0,
  conf_losses       int  not null default 0,
  last10_wins       int  not null default 0,
  last10_losses     int  not null default 0,
  streak            int  not null default 0,   -- positive = won N, negative = lost N
  runs_per_game     double precision,
  runs_allowed_per_game double precision,
  run_diff_per_game double precision,
  /* Pythagorean expectation at the exponent baseball research settles on for
     college scoring. It is descriptive: it says what the run record implies,
     not what will happen, and it is never turned into a price. */
  pythag_win_pct    double precision,
  scheduled_games   int not null default 0,     -- rows that exist but are not final
  first_game        date,
  last_game         date,
  updated_at        timestamptz not null default now(),
  primary key (season, team_id)
);
create index if not exists cbb_team_seasons_season_idx on cbb.team_seasons (season);

/* ── staging: written freely, read by nothing but the gate ───────────────── */
create table if not exists cbb.stg_teams (like cbb.teams including defaults);
alter table cbb.stg_teams add column if not exists import_id text;
create table if not exists cbb.stg_games (like cbb.games including defaults);
alter table cbb.stg_games add column if not exists import_id text;
create index if not exists cbb_stg_games_import_idx on cbb.stg_games (import_id);
create index if not exists cbb_stg_teams_import_idx on cbb.stg_teams (import_id);

/* ── which import is live ────────────────────────────────────────────────── */
create or replace view cbb.season_status as
select r.import_id, r.status, r.first_season, r.last_season, r.seasons,
       r.source, r.source_note, r.promoted_at, r.row_counts,
       (select count(*) from cbb.games)        as games,
       (select count(*) from cbb.teams)        as teams,
       (select count(*) from cbb.team_seasons) as team_seasons
  from cbb.import_runs r
 where r.status = 'promoted' and coalesce(r.dataset,'games') = 'games'
 order by r.promoted_at desc nulls last
 limit 1;

/* ═══════════════════════════════════════════════════════════════════════════
   THE PROMOTE GATE

   Everything above is inert until this runs, and this is the only thing that
   writes a live table. It either promotes the whole import or it refuses and
   leaves the previous one exactly where it was; there is no half-imported
   state for a reader to land on.

   Each refusal below is named, because "the import failed" is not an
   operational message. p_allow_shrink is the single deliberate override, and
   it exists so that the one refusal a human might legitimately need to
   overrule cannot be overruled by accident.
   ═══════════════════════════════════════════════════════════════════════════ */
drop function if exists cbb.promote_cbb_import(text, boolean);
