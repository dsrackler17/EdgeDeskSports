-- college_baseball -- part 2 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ═══════════════════════════════════════════════════════════════════════════
   THE DERIVATION

   Every figure in cbb.team_seasons is a fold over cbb.games. Nothing here is
   fetched, so a club's record cannot disagree with the games listed beneath
   it. Only completed games with both scores count toward a record; scheduled
   and abandoned games are counted separately rather than silently dropped, so
   a reader can see that the difference exists.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.rebuild_team_seasons()
returns void
language plpgsql
security definer
set search_path = cbb, public
as $$
begin
  delete from cbb.team_seasons;

  /* one row per team per game, from both sides of the fixture */
  with sides as (
    select season, game_date, home_team_id as team_id, home_name as team_name,
           home_score as rs, away_score as ra, completed, neutral_site, conference_game,
           'home'::text as venue_side
      from cbb.games where home_team_id is not null
    union all
    select season, game_date, away_team_id, away_name,
           away_score, home_score, completed, neutral_site, conference_game,
           'away'
      from cbb.games where away_team_id is not null
  ),
  played as (
    select *, (rs > ra) as won, (rs < ra) as lost, (rs = ra) as tied
      from sides where completed and rs is not null and ra is not null
  ),
  ranked as (
    select *, row_number() over (partition by season, team_id order by game_date desc) as recency
      from played
  ),
  /* the streak is the run of like results ending at the most recent game */
  streaks as (
    select season, team_id,
           sum(case when won then 1 when lost then -1 else 0 end) filter (
             where recency <= (
               select coalesce(min(r2.recency), 1e9)
                 from ranked r2
                where r2.season = r.season and r2.team_id = r.team_id
                  and r2.won is distinct from (select r3.won from ranked r3
                        where r3.season = r.season and r3.team_id = r.team_id and r3.recency = 1)
             ) - 1
           ) as streak
      from ranked r group by season, team_id
  ),
  agg as (
    select p.season, p.team_id,
           max(p.team_name) as team_name,
           count(*) as games,
           count(*) filter (where p.won)  as wins,
           count(*) filter (where p.lost) as losses,
           count(*) filter (where p.tied) as ties,
           sum(p.rs) as runs_for, sum(p.ra) as runs_against,
           count(*) filter (where p.won  and p.venue_side='home' and not p.neutral_site) as home_wins,
           count(*) filter (where p.lost and p.venue_side='home' and not p.neutral_site) as home_losses,
           count(*) filter (where p.won  and p.venue_side='away' and not p.neutral_site) as away_wins,
           count(*) filter (where p.lost and p.venue_side='away' and not p.neutral_site) as away_losses,
           count(*) filter (where p.won  and p.neutral_site) as neutral_wins,
           count(*) filter (where p.lost and p.neutral_site) as neutral_losses,
           count(*) filter (where p.won  and p.conference_game) as conf_wins,
           count(*) filter (where p.lost and p.conference_game) as conf_losses,
           min(p.game_date) as first_game, max(p.game_date) as last_game
      from played p group by p.season, p.team_id
  ),
  last10 as (
    select season, team_id,
           count(*) filter (where won)  as last10_wins,
           count(*) filter (where lost) as last10_losses
      from ranked where recency <= 10 group by season, team_id
  ),
  scheduled as (
    select season, team_id, count(*) as scheduled_games
      from sides where not completed or rs is null or ra is null
     group by season, team_id
  )
  insert into cbb.team_seasons (
    season, team_id, team_name, games, wins, losses, ties, runs_for, runs_against,
    home_wins, home_losses, away_wins, away_losses, neutral_wins, neutral_losses,
    conf_wins, conf_losses, last10_wins, last10_losses, streak,
    runs_per_game, runs_allowed_per_game, run_diff_per_game, pythag_win_pct,
    scheduled_games, first_game, last_game, updated_at)
  select a.season, a.team_id, a.team_name, a.games, a.wins, a.losses, a.ties,
         a.runs_for, a.runs_against,
         a.home_wins, a.home_losses, a.away_wins, a.away_losses,
         a.neutral_wins, a.neutral_losses, a.conf_wins, a.conf_losses,
         coalesce(l.last10_wins,0), coalesce(l.last10_losses,0),
         coalesce(s.streak,0),
         case when a.games > 0 then a.runs_for::double precision / a.games end,
         case when a.games > 0 then a.runs_against::double precision / a.games end,
         case when a.games > 0 then (a.runs_for - a.runs_against)::double precision / a.games end,
         /* Pythagorean expectation, exponent 1.83 — the figure baseball
            research settles on. Descriptive only: it states what the runs
            imply, never what will happen, and nothing converts it to a price. */
         case when (a.runs_for + a.runs_against) > 0
              then power(a.runs_for, 1.83) / (power(a.runs_for, 1.83) + power(a.runs_against, 1.83))
         end,
         coalesce(sc.scheduled_games,0), a.first_game, a.last_game, now()
    from agg a
    left join last10 l    on l.season = a.season and l.team_id = a.team_id
    left join streaks s   on s.season = a.season and s.team_id = a.team_id
    left join scheduled sc on sc.season = a.season and sc.team_id = a.team_id;
end $$;

create or replace function cbb.abandon_cbb_import(p_import_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = cbb, public as $$
begin
  delete from cbb.stg_games where import_id = p_import_id;
  delete from cbb.stg_teams where import_id = p_import_id;
  update cbb.import_runs
     set status='failed', failed_at=now(), failure_reason=coalesce(p_reason,'abandoned'), updated_at=now()
   where import_id = p_import_id;
  return jsonb_build_object('ok', true, 'abandoned', p_import_id);
end $$;

/* ═══════════════════════════════════════════════════════════════════════════
   ACCESS

   The same shape the historical MLB archive uses, and for the same reason: a
   reader's browser holds a publishable key, so anything it can reach is
   effectively public. The live tables are readable, staging is not, and the
   gates are not callable by anyone but the importer's service role.
   ═══════════════════════════════════════════════════════════════════════════ */
grant usage on schema cbb to anon, authenticated;

alter table cbb.games        enable row level security;
alter table cbb.teams        enable row level security;
alter table cbb.team_seasons enable row level security;
alter table cbb.import_runs  enable row level security;
alter table cbb.stg_games    enable row level security;
alter table cbb.stg_teams    enable row level security;

do $$
declare t text;
begin
  /* the record is public to read and nobody's to write */
  foreach t in array array['games','teams','team_seasons','import_runs'] loop
    execute format('drop policy if exists %I on cbb.%I', t || '_read', t);
    execute format('create policy %I on cbb.%I for select to anon, authenticated using (true)',
                   t || '_read', t);
    execute format('grant select on cbb.%I to anon, authenticated', t);
  end loop;
  /* staging has no policy at all, so RLS denies everything by default */
  foreach t in array array['stg_games','stg_teams'] loop
    execute format('revoke all on cbb.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on function cbb.promote_cbb_import(text, boolean, date, date) from public, anon, authenticated;
revoke all on function cbb.abandon_cbb_import(text, text)     from public, anon, authenticated;
revoke all on function cbb.rebuild_team_seasons()             from public, anon, authenticated;


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
