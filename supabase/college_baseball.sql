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
create or replace function cbb.promote_cbb_import(
  p_import_id text,
  p_allow_shrink boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = cbb, public
as $$
declare
  staged_games   int;
  staged_teams   int;
  dupes          int;
  season_breaks  int;
  score_breaks   int;
  nameless       int;
  live_span      int;
  staged_span    int;
  span_lo        date;
  span_hi        date;
  refusals       jsonb := '[]'::jsonb;
  counts         jsonb;
begin
  select count(*) into staged_games from cbb.stg_games where import_id = p_import_id;
  select count(*) into staged_teams from cbb.stg_teams where import_id = p_import_id;

  if staged_games = 0 then
    refusals := refusals || jsonb_build_object('code','EMPTY_IMPORT',
      'detail','No staged games. An empty answer from the source is not an empty season, and it is never promoted.');
  end if;

  /* one row per game, or the union did not actually union */
  select count(*) into dupes from (
    select game_id from cbb.stg_games where import_id = p_import_id
     group by game_id having count(*) > 1) d;
  if dupes > 0 then
    refusals := refusals || jsonb_build_object('code','DUPLICATE_GAME_IDS',
      'detail', dupes || ' game id(s) staged more than once. The team walk is a union keyed on game id; '
        || 'duplicates mean it stopped being one.');
  end if;

  /* a game's season has to be the season its date falls in. College baseball
     runs February to June, so the season is simply the calendar year — a row
     claiming otherwise would put games in the wrong archive silently. */
  select count(*) into season_breaks
    from cbb.stg_games
   where import_id = p_import_id
     and season <> extract(year from game_date)::int;
  if season_breaks > 0 then
    refusals := refusals || jsonb_build_object('code','SEASON_DATE_MISMATCH',
      'detail', season_breaks || ' game(s) carry a season that is not the year of their own date.');
  end if;

  /* A finished game with no score is a contradiction, and it is the shape a
     half-written row takes. Postponed and cancelled games are finished
     without a score legitimately, so they are excluded by name. */
  select count(*) into score_breaks
    from cbb.stg_games
   where import_id = p_import_id
     and completed
     and (away_score is null or home_score is null)
     and coalesce(status_detail,'') !~* 'postpon|cancel|suspend|forfeit';
  if score_breaks > 0 then
    refusals := refusals || jsonb_build_object('code','COMPLETED_WITHOUT_SCORE',
      'detail', score_breaks || ' game(s) are marked complete with a missing score and are not postponed, '
        || 'cancelled, suspended or forfeited.');
  end if;

  select count(*) into nameless
    from cbb.stg_games
   where import_id = p_import_id
     and (coalesce(away_name,'') = '' or coalesce(home_name,'') = '');
  if nameless > 0 then
    refusals := refusals || jsonb_build_object('code','UNNAMED_SIDE',
      'detail', nameless || ' game(s) are missing a side. A board row that cannot say who is playing is not a row.');
  end if;

  /* ── THE SHRINKAGE REFUSAL ──────────────────────────────────────────────
     Measured, not imagined: the source answers 200 with an empty slate when
     asked too quickly. Writing that would delete a day's card and leave a
     screen that reads like a quiet Tuesday rather than a broken job. So an
     import that covers the same span with materially fewer games has to say
     so out loud. Ten per cent is the tolerance — schedules do lose games to
     weather, and a handful of cancellations is not a broken import. */
  select min(game_date), max(game_date) into span_lo, span_hi
    from cbb.stg_games where import_id = p_import_id;
  if span_lo is not null then
    select count(*) into live_span   from cbb.games where game_date between span_lo and span_hi;
    select count(*) into staged_span from cbb.stg_games
      where import_id = p_import_id and game_date between span_lo and span_hi;
    if live_span > 0 and staged_span < (live_span * 0.9) and not p_allow_shrink then
      refusals := refusals || jsonb_build_object('code','IMPORT_SHRANK',
        'detail','This import carries ' || staged_span || ' games for ' || span_lo || '..' || span_hi
          || ' where the live table already holds ' || live_span
          || '. The source returns an empty or partial slate when it is asked too fast, and promoting that '
          || 'would delete games a reader can currently see. Re-run the walk; if the loss is real, '
          || 'promote again with p_allow_shrink => true.');
    end if;
  end if;

  if jsonb_array_length(refusals) > 0 then
    update cbb.import_runs
       set status = 'failed', failed_at = now(), refusals = refusals, updated_at = now(),
           failure_reason = (refusals -> 0 ->> 'code')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', refusals);
  end if;

  /* ── the promote itself: one transaction, live tables replaced wholesale ── */
  delete from cbb.games;
  insert into cbb.games select (g).* from (
    select g from cbb.stg_games g where g.import_id = p_import_id) s(g);

  if staged_teams > 0 then
    delete from cbb.teams;
    insert into cbb.teams select (t).* from (
      select t from cbb.stg_teams t where t.import_id = p_import_id) s(t);
  end if;

  perform cbb.rebuild_team_seasons();

  select jsonb_build_object(
      'games',        (select count(*) from cbb.games),
      'teams',        (select count(*) from cbb.teams),
      'team_seasons', (select count(*) from cbb.team_seasons))
    into counts;

  update cbb.import_runs
     set status = 'superseded', updated_at = now()
   where status = 'promoted' and coalesce(dataset,'games') = 'games' and import_id <> p_import_id;

  update cbb.import_runs
     set status = 'promoted', promoted_at = now(), row_counts = counts,
         refusals = '[]'::jsonb, updated_at = now()
   where import_id = p_import_id;

  delete from cbb.stg_games where import_id = p_import_id;
  delete from cbb.stg_teams where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', counts);
end $$;

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
