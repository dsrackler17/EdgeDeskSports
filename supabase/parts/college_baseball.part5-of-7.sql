-- college_baseball -- part 5 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ═══════════════════════════════════════════════════════════════════════════
   THE SAME ACCESS RULES, APPLIED TO THE STATS HALF

   A separate block only because these tables are declared below the first one.
   The rules are identical and deliberately so: a reader's browser holds a
   publishable key, so anything it can reach is effectively public.

   cbb.player_games is readable, which is a decision rather than an oversight.
   A brief showing a game's box score has to read that game's lines, and the
   same is already true of cbb.games. What keeps that from being "ship the
   whole dataset to the browser" is the query layer, which asks for one game or
   one player at a time under an explicit row cap — not this grant. The grant
   makes the archive readable; the limits in lib/college_baseball.js make it
   bounded, and neither is a substitute for the other.

   Staging stays unreadable by anyone, and the gates stay uncallable by
   anyone but the importer's service role.
   ═══════════════════════════════════════════════════════════════════════════ */
alter table cbb.player_games      enable row level security;
alter table cbb.player_seasons    enable row level security;
alter table cbb.team_stat_seasons enable row level security;
alter table cbb.stg_player_games  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['player_games','player_seasons','team_stat_seasons'] loop
    execute format('drop policy if exists %I on cbb.%I', t || '_read', t);
    execute format('create policy %I on cbb.%I for select to anon, authenticated using (true)',
                   t || '_read', t);
    execute format('grant select on cbb.%I to anon, authenticated', t);
  end loop;
  /* no policy at all, so RLS denies everything by default */
  execute 'revoke all on cbb.stg_player_games from anon, authenticated';
end $$;

revoke all on function cbb.promote_cbb_stats(text, boolean, int) from public, anon, authenticated;
revoke all on function cbb.rebuild_player_seasons(int)           from public, anon, authenticated;

/* ── how complete is the stats archive for a season? ──────────────────────
   A reader should be able to see the gap rather than infer it from a club
   whose hitting line looks oddly light. */
create or replace view cbb.stats_coverage as
select g.season,
       count(distinct g.game_id)                                  as completed_games,
       count(distinct pg.game_id)                                 as games_with_lines,
       case when count(distinct g.game_id) > 0
            then count(distinct pg.game_id)::double precision
                 / count(distinct g.game_id) end                  as coverage,
       (select count(*) from cbb.player_seasons ps where ps.season = g.season) as players
  from cbb.games g
  left join cbb.player_games pg on pg.game_id = g.game_id
 where g.completed
 group by g.season
 order by g.season desc;


/* ═══════════════════════════════════════════════════════════════════════════
   THE SEASON ARCHIVE — NCAA'S OWN PUBLISHED SEASON STATISTICS

   A SECOND SOURCE, AND A CORRECTION. Everything above folds season numbers out
   of ESPN box scores, which was the best available when it was written and is
   still the only way to get PER-GAME lines. But I reported that both open-source
   college baseball packages were dead ends from CI because the NCAA site they
   wrap answers 403 to a datacenter address. For ncaa_bbStats that was wrong, and
   wrong in a way worth recording: it does not scrape at read time. It SHIPS the
   parsed data in its repository, so the 403 never enters the picture. My 404 on
   it was a guessed repository owner, and I generalised a real finding about a
   different package onto this one.

   What that mistake cost is visible in the columns below. The box-score labels
   carry no doubles, triples, hit-by-pitch or sacrifice flies, so this project
   documented — correctly, for that source — that on-base and slugging could not
   be computed and had to be carried from the source's own figure. THIS source
   publishes all four. So OBP and SLG here are computed, from the definitions,
   and they are the real ones:

     OBP = (H + BB + HBP) / (AB + BB + HBP + SF)
     SLG = (H + 2B + 2*3B + 3*HR) / AB

   HOW THE TWO SOURCES RELATE, because a reader must never have to guess:
     cbb.player_seasons       per-game box scores, folded. Current season, live,
                              partial coverage, no 2B/3B/HBP/SF.
     cbb.ncaa_player_seasons  NCAA's published season totals. 2021-2026,
                              complete seasons, every counting column.
   They are separate tables carrying a source column, and nothing merges them.
   Two sources that disagree must be able to be seen disagreeing.

   PROVENANCE, since this is somebody else's work:
     package   ncaa_bbStats 1.4.2, MIT, Copyright (c) 2025 Mateo Biggs
               https://github.com/CodeMateo15/ncaa_bbStats
     dataset   src/data/player_stats_cache_ncaa/batting/batting.csv and
               src/data/player_stats_cache_ncaa/pitching/pitching.csv
     upstream  NCAA's own published season statistics. The package is explicit
               that this cache passed through no third-party export at any
               point, which is why it is the one used here and the FanGraphs-
               sourced cache beside it is not.

   VERIFIED BEFORE TRUSTING, not assumed:
     32,161 batting and 31,368 pitching player-seasons, 311 teams, 2021-2026.
     2026 is a COMPLETE season, not the truncated mirror the package warns
     about: mean at-bats 106.5 against 105.2 in 2025, mean games 34.7 against
     34.4. A mid-season cut would have shown roughly half.
     Innings are written as thirds-in-tenths — only .0, .1 and .2 appear across
     4,000 sampled rows — so they are stored as OUTS here for the same reason
     they are everywhere else in this schema.
     One row is corrupt: Roberto Pena, USF, 2021, 450 at-bats with no games
     recorded, where the highest total among all 32,161 rows that do record
     games is 296. IMPOSSIBLE_AB below exists because of that row.
   ═══════════════════════════════════════════════════════════════════════════ */

alter table cbb.import_runs drop constraint if exists cbb_import_runs_dataset_ck;
alter table cbb.import_runs add constraint cbb_import_runs_dataset_ck
  check (dataset in ('games','stats','ncaa_seasons'));

create table if not exists cbb.ncaa_player_seasons (
  season             int  not null,
  player_id          text not null,          -- the package's own stable id
  person_id          text,                   -- anchored to the MLB Stats API where known
  name               text not null,
  team_code          text,
  team_name          text,
  division           int,
  class_year         text,                   -- Fr / So / Jr / Sr, as published
  /* FALSE where the upstream identity resolution failed and the key was made
     from season, club and name instead. 269 rows of 60,983 — real players with
     real statistics whose id was lost upstream, most of them to a comma in the
     name. They are kept because a leaderboard quietly missing them is worse
     than one that includes them and says which they are. Such a player cannot
     be followed across a transfer, because his key contains his club. */
  identity_resolved  boolean not null default true,

  /* ── batting, counting ─────────────────────────────────────────────────── */
  bats               boolean not null default false,
  b_games            int,                    -- NULLABLE ON PURPOSE: 145 rows in
                                             -- the source record real at-bats
                                             -- with no games figure. Unknown is
                                             -- not zero, and a rate over a zero
                                             -- denominator is not a rate.
  pa                 int, ab int, h int, doubles int, triples int, hr int,
  r                  int, rbi int, bb int, so int, hbp int, sf int, sh int,
  gdp                int, sb int, cs int,
  qualified_batting  boolean,

  /* ── batting, computed in the promote from the columns above ───────────── */
  total_bases        int,
  batting_avg        double precision,
  obp                double precision,       -- the real one; see the header
  slg                double precision,
  ops                double precision,
  iso                double precision,

  /* ── pitching, counting ────────────────────────────────────────────────── */
  pitches            boolean not null default false,
  p_games            int, gs int, w int, l int, cg int, sho int, sv int,
  outs               int,                    -- NOT innings. "83.2" is 251 outs.
  tbf                int, p_h int, p_r int, er int, p_hr int, p_bb int,
  p_hbp              int, wp int, bk int, p_so int,
  qualified_pitching boolean,

  /* ── pitching, computed ────────────────────────────────────────────────── */
  era                double precision,
  whip               double precision,
  k_per_9            double precision,
  bb_per_9           double precision,
  k_pct              double precision,       -- of batters faced, which this source has

  source             text not null default 'ncaa_bbStats',
  source_sha256      text,                   -- the exact file this row came from
  updated_at         timestamptz not null default now(),
  primary key (season, player_id),
  constraint cbb_nps_hits_ck check (ab is null or h is null or h <= ab),
  constraint cbb_nps_outs_ck check (outs is null or outs >= 0),
  /* THE ROBERTO PENA CONSTRAINT. 296 is the highest at-bat total among every
     row in the source that also records games played; 450 is the one that does
     not. A cap at 400 admits any real season and refuses that row. */
  constraint cbb_nps_ab_ck   check (ab is null or ab <= 400)
);
create index if not exists cbb_nps_season_idx on cbb.ncaa_player_seasons (season);
create index if not exists cbb_nps_team_idx   on cbb.ncaa_player_seasons (team_code, season);
create index if not exists cbb_nps_name_idx   on cbb.ncaa_player_seasons (lower(name));
create index if not exists cbb_nps_person_idx on cbb.ncaa_player_seasons (person_id);

create table if not exists cbb.stg_ncaa_player_seasons
  (like cbb.ncaa_player_seasons including defaults);
alter table cbb.stg_ncaa_player_seasons add column if not exists import_id text;
/* The staging table deliberately does NOT inherit the check constraints: a row
   that violates one has to be able to land here so the gate can COUNT it and
   name it, rather than the insert dying on the first bad row with a message
   about a constraint instead of a message about the import. */
alter table cbb.stg_ncaa_player_seasons drop constraint if exists stg_ncaa_player_seasons_ab_check;
create index if not exists cbb_stg_nps_import_idx on cbb.stg_ncaa_player_seasons (import_id);
