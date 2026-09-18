-- college_baseball -- part 3 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ═══════════════════════════════════════════════════════════════════════════
   THE STATS HALF — PLAYER LINES, AND THE SEASONS FOLDED OUT OF THEM

   Everything above this point is a game log: who played whom, where, and what
   the final score was. It supports a record and a run rate and nothing else.
   This adds the per-player lines, and the season archive folded out of them.

   THE COLUMNS HERE ARE NOT INVENTED. They are exactly the labels the source
   returns, read off a live payload rather than assumed:

     batting   H-AB AB R H RBI HR BB K #P AVG OBP SLG
     pitching  IP H R ER BB K HR PC-ST ERA PC

   Which means three things have to be said out loud rather than papered over.

   ── TRAP 1: AVG, OBP, SLG AND ERA ON A BOX SCORE ARE SEASON-TO-DATE ──
   They are not that game's rates. A hitter who went 1-for-4 does not have a
   .250 line in the AVG column; he has whatever his season average was after
   that game. Summing or averaging those columns across games produces a
   number that means nothing at all. So they are stored under names that say
   what they are — season_avg_at_game, not avg — and the fold NEVER touches
   them. Season rates are computed from the counting stats, or they come from
   the source's own last reported figure, and the two are kept apart.

   ── TRAP 2: INNINGS PITCHED IS NOT A DECIMAL ──
   "6.2" means six innings and two outs, which is 20 outs. It does not mean
   6.2 innings. Adding 6.2 + 6.2 as decimals gives 12.4, which is not a
   possible innings figure in baseball. So the spine stores OUTS as an
   integer, and innings are formatted back out for display. This is the single
   most common arithmetic bug in a baseball dataset and it is designed out
   rather than tested for.

   ── TRAP 3: WHAT THIS SOURCE DOES NOT CARRY ──
   The box-score labels have no 2B, no 3B, no HBP and no SF. Stolen bases are
   NOT in that list either, but they are not missing from the payload: the
   separate `rosters` branch carries stolenBases per player, along with atBats,
   hits, RBIs, homeRuns and avg. So SB is available and is stored — from the
   other branch, which is why it is the only counting column here whose source
   is not the box-score line. Two consequences remain, both stated rather than
   fudged:
     - SLG cannot be computed, because total bases needs doubles and triples.
     - OBP cannot be computed, because it needs hit-by-pitch and sacrifice
       flies. (H+BB)/(AB+BB) is a different statistic, and calling it OBP
       would be a lie of the most ordinary and damaging kind.
   Both therefore come from the source's own season-to-date figure as of the
   club's last game, carried under a name that says so. Where even that is
   missing, the column is null. A null means unknown. It never means zero.
   ═══════════════════════════════════════════════════════════════════════════ */

/* The ledger already exists; it just has to admit a second kind of import. */
alter table cbb.import_runs drop constraint if exists cbb_import_runs_dataset_ck;
alter table cbb.import_runs add constraint cbb_import_runs_dataset_ck
  check (dataset in ('games','stats'));

/* ── the spine: one row per player per game per role ──────────────────────
   A two-way player gets two rows for the same game, one batting and one
   pitching, which is why line_type is part of the key. Folding either half
   never has to know the other exists. */
create table if not exists cbb.player_games (
  game_id            text not null,
  athlete_id         text not null,
  /* batting | pitching. THE SOURCE DOES NOT RELIABLY NAME ITS OWN GROUPS: in
     games that carry athletes the group's `name` comes back undefined, while
     in games with empty groups it is spelled out. So the importer decides
     which kind of line it is from the LABELS (AB and RBI mean batting, IP and
     ER mean pitching) and never from the group name. */
  line_type          text not null,
  season             int  not null,
  game_date          date not null,
  team_id            text,
  team_name          text not null,
  opponent_team_id   text,
  athlete_name       text not null,
  position           text,
  jersey             text,
  starter            boolean,

  /* batting, counting only — every one of these is safe to add up */
  ab                 int,
  runs               int,
  hits               int,
  rbi                int,
  hr                 int,
  bb                 int,
  so                 int,
  pitches_seen       int,
  /* from the rosters branch rather than the box-score line — see TRAP 3 */
  stolen_bases       int,

  /* pitching, counting only. outs, NOT innings — see TRAP 2. */
  outs               int,
  p_hits             int,
  p_runs             int,
  earned_runs        int,
  p_bb               int,
  p_so               int,
  p_hr               int,
  pitch_count        int,
  strikes            int,

  /* the source's season-to-date rates AS OF THIS GAME. Never summed, never
     averaged. Kept because the last one in a season is the source's own
     season figure, which is the only honest OBP and SLG available. */
  season_avg_at_game double precision,
  season_obp_at_game double precision,
  season_slg_at_game double precision,
  season_era_at_game double precision,

  source             text not null default 'espn_summary',
  updated_at         timestamptz not null default now(),
  primary key (game_id, athlete_id, line_type),
  constraint cbb_player_games_type_ck check (line_type in ('batting','pitching')),
  /* Outs come in thirds of an innings; a negative count is a parse error that
     should stop an import rather than reach a reader. */
  constraint cbb_player_games_outs_ck check (outs is null or outs >= 0),
  constraint cbb_player_games_ab_ck   check (ab   is null or ab   >= 0),
  /* A hitter cannot have more hits than at-bats. If this ever fires, the
     column order was misread, which is the failure mode of a labelled array. */
  constraint cbb_player_games_hits_ck check (ab is null or hits is null or hits <= ab)
);
create index if not exists cbb_pg_season_idx  on cbb.player_games (season, line_type);
create index if not exists cbb_pg_athlete_idx on cbb.player_games (athlete_id, season);
create index if not exists cbb_pg_team_idx    on cbb.player_games (team_id, season, line_type);
create index if not exists cbb_pg_game_idx    on cbb.player_games (game_id);

/* ── the fold: a player's season, derived and nothing else ─────────────────
   Every counting column is a sum over cbb.player_games. Every rate is either
   computed from those sums, or carried from the source and named for it.
   There is no third category and nothing here is fetched. */
create table if not exists cbb.player_seasons (
  season             int  not null,
  athlete_id         text not null,
  athlete_name       text not null,
  team_id            text,
  team_name          text,
  position           text,

  /* batting */
  games_batting      int not null default 0,
  ab                 int not null default 0,
  runs               int not null default 0,
  hits               int not null default 0,
  rbi                int not null default 0,
  hr                 int not null default 0,
  bb                 int not null default 0,
  so                 int not null default 0,
  pitches_seen       int not null default 0,
  stolen_bases       int not null default 0,
  /* computed from the sums above: hits over at-bats, and nothing more
     ambitious than that. Null when there are no at-bats, because a hitter
     with no at-bats has no average — he does not have .000. */
  batting_avg        double precision,
  /* the source's own season figures, carried from the club's last game. These
     are the only OBP and SLG that exist here; see TRAP 3. */
  obp_reported       double precision,
  slg_reported       double precision,
  rates_as_of        date,

  /* pitching */
  games_pitching     int not null default 0,
  outs               int not null default 0,
  p_hits             int not null default 0,
  p_runs             int not null default 0,
  earned_runs        int not null default 0,
  p_bb               int not null default 0,
  p_so               int not null default 0,
  p_hr               int not null default 0,
  pitch_count        int not null default 0,
  strikes            int not null default 0,
  /* nine times earned runs over innings, where innings is outs/3. Null with
     no outs recorded: an ERA over zero innings is a division by zero, not an
     infinity to display. */
  era                double precision,
  whip               double precision,
  k_per_9            double precision,
  bb_per_9           double precision,
  era_reported       double precision,

  first_game         date,
  last_game          date,
  updated_at         timestamptz not null default now(),
  primary key (season, athlete_id)
);
create index if not exists cbb_ps_season_idx on cbb.player_seasons (season);
create index if not exists cbb_ps_team_idx   on cbb.player_seasons (team_id, season);

/* ── the club's batting and pitching season, folded over the same rows ─────
   Deliberately a separate table from cbb.team_seasons, which folds the GAME
   LOG. That one knows every game a club played. This one knows only the games
   whose box score carried player lines, and those two sets are not the same.
   Merging them into one row would let a club's record silently start
   disagreeing with its own hitting line, with nothing to point at. The
   coverage columns below exist so a reader can see the gap instead of
   inheriting it. */
create table if not exists cbb.team_stat_seasons (
  season             int  not null,
  team_id            text not null,
  team_name          text not null,

  games_with_lines   int not null default 0,   -- games whose box score had players
  games_played       int not null default 0,   -- from cbb.team_seasons, for comparison
  /* games_with_lines / games_played. A club at 1.0 has a complete hitting
     line; a club at 0.4 does not, and its rates are a sample rather than a
     season. The brief shows this number rather than hiding behind it. */
  line_coverage      double precision,

  ab                 int not null default 0,
  runs               int not null default 0,
  hits               int not null default 0,
  rbi                int not null default 0,
  hr                 int not null default 0,
  bb                 int not null default 0,
  so                 int not null default 0,
  stolen_bases       int not null default 0,
  batting_avg        double precision,

  outs               int not null default 0,
  p_hits             int not null default 0,
  earned_runs        int not null default 0,
  p_bb               int not null default 0,
  p_so               int not null default 0,
  p_hr               int not null default 0,
  era                double precision,
  whip               double precision,

  batters_used       int not null default 0,
  pitchers_used      int not null default 0,
  first_game         date,
  last_game          date,
  updated_at         timestamptz not null default now(),
  primary key (season, team_id)
);
create index if not exists cbb_tss_season_idx on cbb.team_stat_seasons (season);

/* ── staging for the stats import ───────────────────────────────────────── */
create table if not exists cbb.stg_player_games (like cbb.player_games including defaults);
alter table cbb.stg_player_games add column if not exists import_id text;
create index if not exists cbb_stg_pg_import_idx on cbb.stg_player_games (import_id);
