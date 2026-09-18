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
create or replace function cbb.promote_cbb_import(
  p_import_id text,
  p_allow_shrink boolean default false,
  /* THE WINDOW THE IMPORT MEANT TO COVER, not the span it happened to return.
     Those are the same thing only when the import worked. An import throttled
     down to a single day has a one-day span, so comparing it against the live
     table over ITS OWN span compares one day with one day and always passes —
     which is precisely the failure this refusal exists to catch. The importer
     knows the window it asked for, so it says so. */
  p_from date default null,
  p_through date default null
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
  v_refusals     jsonb := '[]'::jsonb;
  counts         jsonb;
begin
  select count(*) into staged_games from cbb.stg_games where import_id = p_import_id;
  select count(*) into staged_teams from cbb.stg_teams where import_id = p_import_id;

  if staged_games = 0 then
    v_refusals := v_refusals || jsonb_build_object('code','EMPTY_IMPORT',
      'detail','No staged games. An empty answer from the source is not an empty season, and it is never promoted.');
  end if;

  /* one row per game, or the union did not actually union */
  select count(*) into dupes from (
    select game_id from cbb.stg_games where import_id = p_import_id
     group by game_id having count(*) > 1) d;
  if dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','DUPLICATE_GAME_IDS',
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
    v_refusals := v_refusals || jsonb_build_object('code','SEASON_DATE_MISMATCH',
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
    v_refusals := v_refusals || jsonb_build_object('code','COMPLETED_WITHOUT_SCORE',
      'detail', score_breaks || ' game(s) are marked complete with a missing score and are not postponed, '
        || 'cancelled, suspended or forfeited.');
  end if;

  select count(*) into nameless
    from cbb.stg_games
   where import_id = p_import_id
     and (coalesce(away_name,'') = '' or coalesce(home_name,'') = '');
  if nameless > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','UNNAMED_SIDE',
      'detail', nameless || ' game(s) are missing a side. A board row that cannot say who is playing is not a row.');
  end if;

  /* ── THE SHRINKAGE REFUSAL ──────────────────────────────────────────────
     Measured, not imagined: the source answers 200 with an empty slate when
     asked too quickly. Writing that would delete a day's card and leave a
     screen that reads like a quiet Tuesday rather than a broken job. So an
     import that covers the same span with materially fewer games has to say
     so out loud. Ten per cent is the tolerance — schedules do lose games to
     weather, and a handful of cancellations is not a broken import. */
  select coalesce(p_from, min(game_date)), coalesce(p_through, max(game_date))
    into span_lo, span_hi
    from cbb.stg_games where import_id = p_import_id;
  if span_lo is not null then
    select count(*) into live_span   from cbb.games where game_date between span_lo and span_hi;
    select count(*) into staged_span from cbb.stg_games
      where import_id = p_import_id and game_date between span_lo and span_hi;
    if live_span > 0 and staged_span < (live_span * 0.9) and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object('code','IMPORT_SHRANK',
        'detail','This import carries ' || staged_span || ' games for ' || span_lo || '..' || span_hi
          || ' where the live table already holds ' || live_span
          || '. The source returns an empty or partial slate when it is asked too fast, and promoting that '
          || 'would delete games a reader can currently see. Re-run the walk; if the loss is real, '
          || 'promote again with p_allow_shrink => true.');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs
       set status = 'failed', failed_at = now(), refusals = v_refusals, updated_at = now(),
           failure_reason = (v_refusals -> 0 ->> 'code')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  /* ── the promote itself: one transaction, live tables replaced wholesale ── */
  /* The columns are named rather than splatted. Staging carries an import_id
     that the live table does not, so a (row).* here would be one column too
     wide — and a schema change later would break it silently rather than
     loudly. */
  delete from cbb.games where true;
  insert into cbb.games (
    game_id, season, game_date, start_time, start_time_tbd,
    away_team_id, home_team_id, away_name, home_name, away_abbr, home_abbr,
    venue, venue_city, venue_state, neutral_site, conference_game,
    status_state, status_detail, completed, away_score, home_score, innings,
    away_rank, home_rank, notes, seen_by, first_seen_at, last_seen_at)
  select game_id, season, game_date, start_time, start_time_tbd,
         away_team_id, home_team_id, away_name, home_name, away_abbr, home_abbr,
         venue, venue_city, venue_state, neutral_site, conference_game,
         status_state, status_detail, completed, away_score, home_score, innings,
         away_rank, home_rank, notes, seen_by,
         coalesce(first_seen_at, now()), now()
    from cbb.stg_games where import_id = p_import_id;

  if staged_teams > 0 then
    delete from cbb.teams where true;
    insert into cbb.teams (
      team_id, name, short_name, abbreviation, slug,
      conference_id, conference_name, logo, color,
      first_seen_season, last_seen_season, updated_at)
    select team_id, name, short_name, abbreviation, slug,
           conference_id, conference_name, logo, color,
           first_seen_season, last_seen_season, now()
      from cbb.stg_teams where import_id = p_import_id;
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
  delete from cbb.team_seasons where true;

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

/* ═══════════════════════════════════════════════════════════════════════════
   THE STATS PROMOTE GATE

   Same contract as the games promote: it either takes the whole import or it
   refuses and leaves the previous one untouched. Each refusal is named,
   because "the stats import failed" is not an operational message.

   p_season is THE SEASON THE IMPORT MEANT TO COVER, not the one it happened
   to return — the same distinction the games promote needed. An import
   throttled down to a handful of games has a narrow span, and judging it
   against the live table over its own span compares a handful with a handful
   and always passes, which is exactly the failure the shrink refusal exists
   to catch.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.promote_cbb_stats(
  p_import_id    text,
  p_allow_shrink boolean default false,
  p_season       int     default null
) returns jsonb
language plpgsql
as $$
declare
  v_refusals  jsonb := '[]'::jsonb;
  v_staged    bigint;
  v_live      bigint;
  v_dupes     bigint;
  v_orphans   bigint;
  v_badhits   bigint;
  v_badseason bigint;
  v_season    int := p_season;
  v_players   bigint;
  v_teams     bigint;
begin
  select count(*) into v_staged from cbb.stg_player_games where import_id = p_import_id;

  /* EMPTY_IMPORT — the source answers 200 with an empty slate when hurried,
     and an empty import must never be allowed to erase a real one. */
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','EMPTY_IMPORT',
      'detail','no staged player lines for this import id');
  end if;

  /* DUPLICATE_LINES — one player, one game, one role. A duplicate means the
     same box score was read twice, and folding it would double a season. */
  select count(*) into v_dupes from (
    select game_id, athlete_id, line_type
      from cbb.stg_player_games where import_id = p_import_id
     group by 1,2,3 having count(*) > 1) d;
  if v_dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','DUPLICATE_LINES',
      'detail', v_dupes || ' (game, athlete, role) combinations appear more than once');
  end if;

  /* ORPHAN_GAME — a line for a game the log has never heard of. Either the
     game log is stale or the ids do not match; both mean the fold would
     attribute numbers to a game nobody can look up. */
  select count(*) into v_orphans
    from cbb.stg_player_games s
   where s.import_id = p_import_id
     and not exists (select 1 from cbb.games g where g.game_id = s.game_id);
  if v_orphans > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','ORPHAN_GAME',
      'detail', v_orphans || ' lines reference a game that is not in cbb.games');
  end if;

  /* HITS_EXCEED_AB — the labelled-array failure mode. A box score arrives as
     a bare list of numbers whose meaning comes from a parallel list of
     labels, so an off-by-one in the column mapping produces numbers that are
     individually plausible and collectively impossible. A hitter with more
     hits than at-bats is the cheapest way to catch that, and it is checked
     here as well as in the table constraint because a refusal that names the
     problem is worth more than a constraint violation that does not. */
  select count(*) into v_badhits
    from cbb.stg_player_games
   where import_id = p_import_id and line_type = 'batting'
     and ab is not null and hits is not null and hits > ab;
  if v_badhits > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','HITS_EXCEED_AB',
      'detail', v_badhits || ' batting lines have more hits than at-bats — the '
        || 'column mapping is off, not the source');
  end if;

  /* SEASON_MISMATCH — a line whose season does not match the year of its own
     date. College baseball runs February to June, so season and calendar year
     are the same thing, and a disagreement means one of the two was invented. */
  select count(*) into v_badseason
    from cbb.stg_player_games
   where import_id = p_import_id
     and season <> extract(year from game_date)::int;
  if v_badseason > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','SEASON_MISMATCH',
      'detail', v_badseason || ' lines carry a season that is not the year of their date');
  end if;

  /* IMPORT_SHRANK — judged against the season the import MEANT to cover. */
  if v_season is not null then
    select count(*) into v_live from cbb.player_games where season = v_season;
    if v_live > 0 and v_staged < v_live * 0.9 and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object(
        'refusal','IMPORT_SHRANK',
        'detail','staged ' || v_staged || ' lines for season ' || v_season
          || ' against ' || v_live || ' live; pass p_allow_shrink to override');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs
       set status='failed', failed_at=now(), refusals=v_refusals, updated_at=now(),
           failure_reason = (v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  /* One transaction. A reader never lands on a half-imported season. */
  if v_season is not null then
    delete from cbb.player_games where season = v_season;
  else
    delete from cbb.player_games where true;
  end if;

  insert into cbb.player_games (
    game_id, athlete_id, line_type, season, game_date, team_id, team_name,
    opponent_team_id, athlete_name, position, jersey, starter,
    ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr, pitch_count, strikes,
    season_avg_at_game, season_obp_at_game, season_slg_at_game, season_era_at_game,
    source, updated_at)
  select
    game_id, athlete_id, line_type, season, game_date, team_id, team_name,
    opponent_team_id, athlete_name, position, jersey, starter,
    ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr, pitch_count, strikes,
    season_avg_at_game, season_obp_at_game, season_slg_at_game, season_era_at_game,
    source, now()
    from cbb.stg_player_games where import_id = p_import_id;

  perform cbb.rebuild_player_seasons(v_season);

  select count(*) into v_players from cbb.player_seasons
   where v_season is null or season = v_season;
  select count(*) into v_teams from cbb.team_stat_seasons
   where v_season is null or season = v_season;

  update cbb.import_runs
     set status='promoted', promoted_at=now(), refusals='[]'::jsonb, updated_at=now(),
         row_counts = jsonb_build_object(
           'player_games', v_staged, 'player_seasons', v_players,
           'team_stat_seasons', v_teams)
   where import_id = p_import_id;

  update cbb.import_runs
     set status='superseded', updated_at=now()
   where dataset='stats' and status='promoted' and import_id <> p_import_id;

  delete from cbb.stg_player_games where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'player_games', v_staged,
    'player_seasons', v_players, 'team_stat_seasons', v_teams);
end;
$$;

/* ═══════════════════════════════════════════════════════════════════════════
   THE FOLD

   Both season tables are sums over cbb.player_games and nothing else. Nothing
   in here is fetched, and nothing in here touches the season-to-date rate
   columns except to carry the last one, which is the only place an honest OBP
   or SLG can come from.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.rebuild_player_seasons(p_season int default null)
returns void
language plpgsql
as $$
begin
  if p_season is null then
    delete from cbb.player_seasons where true;
    delete from cbb.team_stat_seasons where true;
  else
    delete from cbb.player_seasons    where season = p_season;
    delete from cbb.team_stat_seasons where season = p_season;
  end if;

  /* ── players ──
     A player's identity for a season is his last club, not his first: a
     transfer's line belongs where he finished. */
  with bat as (
    select season, athlete_id,
           count(*)                     as games_batting,
           sum(coalesce(ab,0))          as ab,
           sum(coalesce(runs,0))        as runs,
           sum(coalesce(hits,0))        as hits,
           sum(coalesce(rbi,0))         as rbi,
           sum(coalesce(hr,0))          as hr,
           sum(coalesce(bb,0))          as bb,
           sum(coalesce(so,0))          as so,
           sum(coalesce(pitches_seen,0)) as pitches_seen,
           sum(coalesce(stolen_bases,0)) as stolen_bases
      from cbb.player_games
     where line_type='batting' and (p_season is null or season=p_season)
     group by 1,2
  ), pit as (
    select season, athlete_id,
           count(*)                     as games_pitching,
           sum(coalesce(outs,0))        as outs,
           sum(coalesce(p_hits,0))      as p_hits,
           sum(coalesce(p_runs,0))      as p_runs,
           sum(coalesce(earned_runs,0)) as earned_runs,
           sum(coalesce(p_bb,0))        as p_bb,
           sum(coalesce(p_so,0))        as p_so,
           sum(coalesce(p_hr,0))        as p_hr,
           sum(coalesce(pitch_count,0)) as pitch_count,
           sum(coalesce(strikes,0))     as strikes
      from cbb.player_games
     where line_type='pitching' and (p_season is null or season=p_season)
     group by 1,2
  ), ident as (
    /* one row per player-season: the last line he appears in */
    select distinct on (season, athlete_id)
           season, athlete_id, athlete_name, team_id, team_name, position,
           game_date as last_game
      from cbb.player_games
     where p_season is null or season=p_season
     order by season, athlete_id, game_date desc, line_type
  ), firsts as (
    select season, athlete_id, min(game_date) as first_game
      from cbb.player_games
     where p_season is null or season=p_season
     group by 1,2
  ), rates as (
    /* the source's own season figures, taken from the LAST game that reported
       them. This is the only OBP and SLG that exists here. */
    select distinct on (season, athlete_id)
           season, athlete_id, season_obp_at_game, season_slg_at_game, game_date
      from cbb.player_games
     where line_type='batting' and season_obp_at_game is not null
       and (p_season is null or season=p_season)
     order by season, athlete_id, game_date desc
  ), erarep as (
    select distinct on (season, athlete_id)
           season, athlete_id, season_era_at_game
      from cbb.player_games
     where line_type='pitching' and season_era_at_game is not null
       and (p_season is null or season=p_season)
     order by season, athlete_id, game_date desc
  )
  insert into cbb.player_seasons (
    season, athlete_id, athlete_name, team_id, team_name, position,
    games_batting, ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    batting_avg, obp_reported, slg_reported, rates_as_of,
    games_pitching, outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr,
    pitch_count, strikes, era, whip, k_per_9, bb_per_9, era_reported,
    first_game, last_game, updated_at)
  select i.season, i.athlete_id, i.athlete_name, i.team_id, i.team_name, i.position,
    coalesce(b.games_batting,0), coalesce(b.ab,0), coalesce(b.runs,0),
    coalesce(b.hits,0), coalesce(b.rbi,0), coalesce(b.hr,0), coalesce(b.bb,0),
    coalesce(b.so,0), coalesce(b.pitches_seen,0), coalesce(b.stolen_bases,0),
    /* a hitter with no at-bats has no average; he does not have .000 */
    case when coalesce(b.ab,0) > 0 then b.hits::double precision / b.ab end,
    r.season_obp_at_game, r.season_slg_at_game, r.game_date,
    coalesce(p.games_pitching,0), coalesce(p.outs,0), coalesce(p.p_hits,0),
    coalesce(p.p_runs,0), coalesce(p.earned_runs,0), coalesce(p.p_bb,0),
    coalesce(p.p_so,0), coalesce(p.p_hr,0), coalesce(p.pitch_count,0),
    coalesce(p.strikes,0),
    /* ERA, WHIP and the per-nine rates all divide by innings, and innings is
       outs/3. With no outs recorded these are a division by zero, which is a
       null rather than an infinity dressed up as a statistic. */
    case when coalesce(p.outs,0) > 0
         then p.earned_runs * 27.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then (p.p_hits + p.p_bb) * 3.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then p.p_so * 27.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then p.p_bb * 27.0 / p.outs end,
    e.season_era_at_game,
    f.first_game, i.last_game, now()
    from ident i
    left join bat    b on b.season=i.season and b.athlete_id=i.athlete_id
    left join pit    p on p.season=i.season and p.athlete_id=i.athlete_id
    left join firsts f on f.season=i.season and f.athlete_id=i.athlete_id
    left join rates  r on r.season=i.season and r.athlete_id=i.athlete_id
    left join erarep e on e.season=i.season and e.athlete_id=i.athlete_id;

  /* ── clubs ──
     games_with_lines counts distinct games this club has ANY line for, which
     is not the number of games it played. games_played comes from
     cbb.team_seasons, which folds the game log, and the ratio of the two is
     the coverage figure the brief shows instead of hiding. */
  with tb as (
    select season, team_id, max(team_name) as team_name,
           count(distinct game_id)       as games_with_lines,
           count(distinct athlete_id)    as batters_used,
           sum(coalesce(ab,0))           as ab,
           sum(coalesce(runs,0))         as runs,
           sum(coalesce(hits,0))         as hits,
           sum(coalesce(rbi,0))          as rbi,
           sum(coalesce(hr,0))           as hr,
           sum(coalesce(bb,0))           as bb,
           sum(coalesce(so,0))           as so,
           sum(coalesce(stolen_bases,0)) as stolen_bases,
           min(game_date) as first_game, max(game_date) as last_game
      from cbb.player_games
     where line_type='batting' and team_id is not null
       and (p_season is null or season=p_season)
     group by 1,2
  ), tp as (
    select season, team_id,
           count(distinct athlete_id)   as pitchers_used,
           sum(coalesce(outs,0))        as outs,
           sum(coalesce(p_hits,0))      as p_hits,
           sum(coalesce(earned_runs,0)) as earned_runs,
           sum(coalesce(p_bb,0))        as p_bb,
           sum(coalesce(p_so,0))        as p_so,
           sum(coalesce(p_hr,0))        as p_hr,
           count(distinct game_id)      as pgames
      from cbb.player_games
     where line_type='pitching' and team_id is not null
       and (p_season is null or season=p_season)
     group by 1,2
  ), allteams as (
    select coalesce(tb.season, tp.season) as season,
           coalesce(tb.team_id, tp.team_id) as team_id
      from tb full outer join tp on tb.season=tp.season and tb.team_id=tp.team_id
  ), gamecount as (
    /* THE UNION OF THE TWO SETS, NOT THE LARGER OF THEM. A club that batted in
       games 1 and 2 and pitched in games 1 and 3 has lines in THREE games; the
       greater of the two counts says two. Counting distinct game ids across
       both line types is the only thing that gets this right, and it matters
       because this figure is the denominator of the coverage a reader is shown. */
    select season, team_id, count(distinct game_id) as games_with_lines
      from cbb.player_games
     where team_id is not null and (p_season is null or season=p_season)
     group by 1,2
  )
  insert into cbb.team_stat_seasons (
    season, team_id, team_name, games_with_lines, games_played, line_coverage,
    ab, runs, hits, rbi, hr, bb, so, stolen_bases, batting_avg,
    outs, p_hits, earned_runs, p_bb, p_so, p_hr, era, whip,
    batters_used, pitchers_used, first_game, last_game, updated_at)
  select a.season, a.team_id,
    coalesce(tb.team_name, ts.team_name, a.team_id),
    coalesce(gc.games_with_lines, 0),
    coalesce(ts.games, 0),
    case when coalesce(ts.games,0) > 0
         then coalesce(gc.games_with_lines,0)::double precision / ts.games end,
    coalesce(tb.ab,0), coalesce(tb.runs,0), coalesce(tb.hits,0), coalesce(tb.rbi,0),
    coalesce(tb.hr,0), coalesce(tb.bb,0), coalesce(tb.so,0), coalesce(tb.stolen_bases,0),
    case when coalesce(tb.ab,0) > 0 then tb.hits::double precision / tb.ab end,
    coalesce(tp.outs,0), coalesce(tp.p_hits,0), coalesce(tp.earned_runs,0),
    coalesce(tp.p_bb,0), coalesce(tp.p_so,0), coalesce(tp.p_hr,0),
    case when coalesce(tp.outs,0) > 0 then tp.earned_runs * 27.0 / tp.outs end,
    case when coalesce(tp.outs,0) > 0 then (tp.p_hits + tp.p_bb) * 3.0 / tp.outs end,
    coalesce(tb.batters_used,0), coalesce(tp.pitchers_used,0),
    tb.first_game, tb.last_game, now()
    from allteams a
    left join tb on tb.season=a.season and tb.team_id=a.team_id
    left join tp on tp.season=a.season and tp.team_id=a.team_id
    left join gamecount gc on gc.season=a.season and gc.team_id=a.team_id
    left join cbb.team_seasons ts on ts.season=a.season and ts.team_id=a.team_id;
end;
$$;

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

/* ═══════════════════════════════════════════════════════════════════════════
   THE GATE
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.promote_ncaa_seasons(
  p_import_id    text,
  p_allow_shrink boolean default false,
  p_season       int     default null
) returns jsonb
language plpgsql
as $$
declare
  v_refusals jsonb := '[]'::jsonb;
  v_staged   bigint;
  v_live     bigint;
  v_dupes    bigint;
  v_badhits  bigint;
  v_badab    bigint;
  v_badseason bigint;
  v_rows     bigint;
begin
  select count(*) into v_staged from cbb.stg_ncaa_player_seasons where import_id = p_import_id;
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','EMPTY_IMPORT',
      'detail','no staged rows for this import id');
  end if;

  select count(*) into v_dupes from (
    select season, player_id from cbb.stg_ncaa_player_seasons
     where import_id = p_import_id group by 1,2 having count(*) > 1) d;
  if v_dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','DUPLICATE_PLAYER_SEASON',
      'detail', v_dupes || ' (season, player) pairs appear more than once; the two '
        || 'source files were merged wrongly');
  end if;

  select count(*) into v_badhits from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and ab is not null and h is not null and h > ab;
  if v_badhits > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','HITS_EXCEED_AB',
      'detail', v_badhits || ' rows have more hits than at-bats');
  end if;

  /* IMPOSSIBLE_AB — see the Roberto Pena note in the header. A season total
     above 400 at-bats is not a college season; it is an aggregate or a parse
     fault, and importing it would put a .236 hitter on a leaderboard with
     half again the plate appearances anyone else had. */
  select count(*) into v_badab from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and ab is not null and ab > 400;
  if v_badab > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','IMPOSSIBLE_AB',
      'detail', v_badab || ' rows carry more than 400 at-bats in one season; the '
        || 'highest real total in this source is 296');
  end if;

  select count(*) into v_badseason from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and (season < 2002 or season > 2100);
  if v_badseason > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','SEASON_OUT_OF_RANGE',
      'detail', v_badseason || ' rows carry a season outside 2002..2100');
  end if;

  if p_season is not null then
    select count(*) into v_live from cbb.ncaa_player_seasons where season = p_season;
    if v_live > 0 and v_staged < v_live * 0.9 and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object('refusal','IMPORT_SHRANK',
        'detail','staged ' || v_staged || ' rows for season ' || p_season
          || ' against ' || v_live || ' live');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs set status='failed', failed_at=now(), refusals=v_refusals,
           updated_at=now(), failure_reason=(v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  if p_season is not null then
    delete from cbb.ncaa_player_seasons where season = p_season;
  else
    delete from cbb.ncaa_player_seasons where true;
  end if;

  insert into cbb.ncaa_player_seasons (
    season, player_id, person_id, name, team_code, team_name, division, class_year,
    identity_resolved,
    bats, b_games, pa, ab, h, doubles, triples, hr, r, rbi, bb, so, hbp, sf, sh,
    gdp, sb, cs, qualified_batting,
    total_bases, batting_avg, obp, slg, ops, iso,
    pitches, p_games, gs, w, l, cg, sho, sv, outs, tbf, p_h, p_r, er, p_hr,
    p_bb, p_hbp, wp, bk, p_so, qualified_pitching,
    era, whip, k_per_9, bb_per_9, k_pct,
    source, source_sha256, updated_at)
  select
    s.season, s.player_id, s.person_id, s.name, s.team_code, s.team_name,
    s.division, s.class_year,
    /* CARRIED EXPLICITLY. This column was added to the table and left out of
       this list, so every row took the default and claimed its identity was
       resolved — including the 269 whose whole purpose is to say otherwise. A
       flag that cannot say "no" is worse than no flag. */
    s.identity_resolved,
    s.bats, s.b_games, s.pa, s.ab, s.h, s.doubles, s.triples, s.hr, s.r, s.rbi,
    s.bb, s.so, s.hbp, s.sf, s.sh, s.gdp, s.sb, s.cs, s.qualified_batting,

    /* ── the derived batting figures, in ONE place ──────────────────────────
       Total bases counts each hit once for the base it reached: singles are
       H - 2B - 3B - HR, so TB = H + 2B + 2*3B + 3*HR. Writing it that way means
       a missing doubles column understates rather than silently double-counts. */
    case when s.h is not null then
      s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0) + 3*coalesce(s.hr,0)
    end,
    /* Every rate below is null when its denominator is zero. A hitter with no
       at-bats has no average; he does not have .000. */
    case when coalesce(s.ab,0) > 0 then s.h::double precision / s.ab end,
    case when coalesce(s.ab,0) + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0) > 0
         then (coalesce(s.h,0) + coalesce(s.bb,0) + coalesce(s.hbp,0))::double precision
              / (s.ab + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0)) end,
    case when coalesce(s.ab,0) > 0
         then (s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,
    /* OPS is the sum of the two above, and is null if either is. Adding a null
       to a number in SQL gives null, which is the behaviour wanted here. */
    case when coalesce(s.ab,0) > 0
          and coalesce(s.ab,0) + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0) > 0
         then (coalesce(s.h,0) + coalesce(s.bb,0) + coalesce(s.hbp,0))::double precision
              / (s.ab + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0))
            + (s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,
    /* Isolated power: slugging minus average, i.e. extra bases per at-bat. */
    case when coalesce(s.ab,0) > 0
         then (coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,

    s.pitches, s.p_games, s.gs, s.w, s.l, s.cg, s.sho, s.sv, s.outs, s.tbf,
    s.p_h, s.p_r, s.er, s.p_hr, s.p_bb, s.p_hbp, s.wp, s.bk, s.p_so,
    s.qualified_pitching,

    /* Nine innings is 27 outs, so ERA is ER * 27 / outs. Null over zero outs,
       because an ERA over no innings is a division by zero and not an infinity
       to put on a card. */
    case when coalesce(s.outs,0) > 0 then s.er * 27.0 / s.outs end,
    case when coalesce(s.outs,0) > 0
         then (coalesce(s.p_h,0) + coalesce(s.p_bb,0)) * 3.0 / s.outs end,
    case when coalesce(s.outs,0) > 0 then s.p_so * 27.0 / s.outs end,
    case when coalesce(s.outs,0) > 0 then s.p_bb * 27.0 / s.outs end,
    /* Strikeout rate per batter faced. This source publishes TBF, so this is
       the real denominator rather than the at-bats approximation. */
    case when coalesce(s.tbf,0) > 0 then s.p_so::double precision / s.tbf end,

    s.source, s.source_sha256, now()
    from cbb.stg_ncaa_player_seasons s
   where s.import_id = p_import_id;

  select count(*) into v_rows from cbb.ncaa_player_seasons
   where p_season is null or season = p_season;

  update cbb.import_runs
     set status='promoted', promoted_at=now(), refusals='[]'::jsonb, updated_at=now(),
         row_counts = jsonb_build_object('ncaa_player_seasons', v_staged)
   where import_id = p_import_id;
  update cbb.import_runs set status='superseded', updated_at=now()
   where dataset='ncaa_seasons' and status='promoted' and import_id <> p_import_id;
  delete from cbb.stg_ncaa_player_seasons where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', v_staged, 'live', v_rows);
end;
$$;

/* What the archive holds, per season, so a reader is never guessing. */
create or replace view cbb.ncaa_archive_status as
select season,
       count(*)                                         as players,
       count(*) filter (where bats)                     as batters,
       count(*) filter (where pitches)                  as pitchers,
       count(distinct team_code)                        as teams,
       count(*) filter (where qualified_batting)        as qualified_batters,
       min(division)                                    as lowest_division,
       max(division)                                    as highest_division,
       max(updated_at)                                  as imported_at
  from cbb.ncaa_player_seasons
 group by season
 order by season desc;

/* ── access: same rules as everything else here ─────────────────────────── */
alter table cbb.ncaa_player_seasons     enable row level security;
alter table cbb.stg_ncaa_player_seasons enable row level security;
do $$
begin
  drop policy if exists ncaa_player_seasons_read on cbb.ncaa_player_seasons;
  create policy ncaa_player_seasons_read on cbb.ncaa_player_seasons
    for select to anon, authenticated using (true);
  execute 'grant select on cbb.ncaa_player_seasons to anon, authenticated';
  execute 'revoke all on cbb.stg_ncaa_player_seasons from anon, authenticated';
end $$;
revoke all on function cbb.promote_ncaa_seasons(text, boolean, int) from public, anon, authenticated;


/* ═══════════════════════════════════════════════════════════════════════════
   THE CLUB MAP — NCAA CODES TO ESPN IDS

   The games board keys clubs on ESPN's numeric ids. The season archive keys them
   on NCAA's own codes. There is no shared identifier, so putting a club's season
   archive on its game needs a mapping, and a mapping is where a whole club's
   numbers get silently attached to the wrong club.

   BUILT FROM A MEASUREMENT, NOT A GUESS. 276 of 311 archive clubs match an ESPN
   club on name once abbreviations are expanded — 88.7%. The remaining 35 are a
   hand-written alias list in tools/cbb/team_aliases.js, which exists only
   because 35 was short enough for a person to read. Nothing here is fuzzy: no
   similarity score, no edit distance, no best-effort nearest match.

   THE REASON THAT MATTERS. In the archive, USC is Southern California and UPST
   is USC Upstate. Every similarity scorer worth the name maps "USC" onto "USC
   Upstate", and the result is a Trojans brief carrying a Spartanburg batting
   line with nothing anywhere to indicate it. The pair is spelled out in the
   alias table and the unique constraint below makes the collision impossible to
   promote even if someone later tries.

   A CLUB MISSING FROM THIS TABLE IS FINE. Its brief shows no season archive and
   says so. A club present but wrong is not fine, which is why every column here
   is a statement someone verified and `via` records which kind.
   ═══════════════════════════════════════════════════════════════════════════ */
alter table cbb.import_runs drop constraint if exists cbb_import_runs_dataset_ck;
alter table cbb.import_runs add constraint cbb_import_runs_dataset_ck
  check (dataset in ('games','stats','ncaa_seasons','club_map'));

create table if not exists cbb.club_map (
  ncaa_code     text primary key,
  ncaa_name     text not null,
  espn_team_id  text not null,
  espn_name     text,
  /* 'name' where the two spellings agreed once abbreviations were expanded;
     'alias' where a person wrote the mapping down. Worth keeping apart: an
     alias is a claim with an author and a name match is a derivation. */
  via           text not null,
  resolved_at   timestamptz not null default now(),
  constraint cbb_club_map_via_ck check (via in ('name','alias')),
  /* ONE ESPN CLUB, ONE NCAA CODE. This is the USC/UPST guard in the schema
     rather than only in the importer: two codes on one club would double a
     roster and put one programme's season on another programme's game, and no
     amount of care in JavaScript should be the only thing preventing it. */
  constraint cbb_club_map_espn_uq unique (espn_team_id)
);
create index if not exists cbb_club_map_espn_idx on cbb.club_map (espn_team_id);

create table if not exists cbb.stg_club_map (like cbb.club_map including defaults);
alter table cbb.stg_club_map add column if not exists import_id text;

create or replace function cbb.promote_club_map(p_import_id text)
returns jsonb
language plpgsql
as $$
declare
  v_refusals jsonb := '[]'::jsonb;
  v_staged bigint;
  v_dupe_espn bigint;
  v_dupe_code bigint;
  v_orphan bigint;
begin
  select count(*) into v_staged from cbb.stg_club_map where import_id = p_import_id;
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','EMPTY_IMPORT',
      'detail','no staged club mappings');
  end if;

  /* THE COLLISION THAT WOULD MIS-ATTRIBUTE A SEASON. */
  select count(*) into v_dupe_espn from (
    select espn_team_id from cbb.stg_club_map where import_id = p_import_id
     group by 1 having count(*) > 1) d;
  if v_dupe_espn > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','ESPN_CLUB_CLAIMED_TWICE',
      'detail', v_dupe_espn || ' ESPN club(s) are claimed by more than one NCAA code; '
        || 'that would put one programme''s players on another programme''s game');
  end if;

  select count(*) into v_dupe_code from (
    select ncaa_code from cbb.stg_club_map where import_id = p_import_id
     group by 1 having count(*) > 1) d;
  if v_dupe_code > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','NCAA_CODE_TWICE',
      'detail', v_dupe_code || ' NCAA code(s) appear more than once');
  end if;

  /* A MAPPING TO A CLUB THE BOARD HAS NEVER HEARD OF is not useful and is
     probably a stale ESPN id. Checked only when the teams table is populated,
     so a fresh database can still be seeded in either order. */
  if (select count(*) from cbb.teams) > 0 then
    select count(*) into v_orphan
      from cbb.stg_club_map s
     where s.import_id = p_import_id
       and not exists (select 1 from cbb.teams t where t.team_id = s.espn_team_id);
    if v_orphan > 0 then
      v_refusals := v_refusals || jsonb_build_object('refusal','UNKNOWN_ESPN_CLUB',
        'detail', v_orphan || ' mapping(s) point at an ESPN club that is not in cbb.teams');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs set status='failed', failed_at=now(), refusals=v_refusals,
           updated_at=now(), failure_reason=(v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  delete from cbb.club_map where true;
  insert into cbb.club_map (ncaa_code, ncaa_name, espn_team_id, espn_name, via, resolved_at)
  select ncaa_code, ncaa_name, espn_team_id, espn_name, via, now()
    from cbb.stg_club_map where import_id = p_import_id;

  update cbb.import_runs set status='promoted', promoted_at=now(), refusals='[]'::jsonb,
         updated_at=now(), row_counts = jsonb_build_object('club_map', v_staged)
   where import_id = p_import_id;
  update cbb.import_runs set status='superseded', updated_at=now()
   where dataset='club_map' and status='promoted' and import_id <> p_import_id;
  delete from cbb.stg_club_map where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', v_staged);
end;
$$;

/* A club's season archive, reachable by the id the games board uses. The join
   is the whole point of the table above, and it is an INNER join: a club with
   no mapping produces no rows rather than somebody else's. */
create or replace view cbb.archive_by_espn_club as
select m.espn_team_id, m.ncaa_code, m.via as mapped_via, p.*
  from cbb.club_map m
  join cbb.ncaa_player_seasons p on p.team_code = m.ncaa_code;

alter table cbb.club_map     enable row level security;
alter table cbb.stg_club_map enable row level security;
do $$
begin
  drop policy if exists club_map_read on cbb.club_map;
  create policy club_map_read on cbb.club_map for select to anon, authenticated using (true);
  execute 'grant select on cbb.club_map to anon, authenticated';
  execute 'revoke all on cbb.stg_club_map from anon, authenticated';
end $$;
revoke all on function cbb.promote_club_map(text) from public, anon, authenticated;

/* ═══════════════════════════════════════════════════════════════════════════
   THE REPORT

   Every SQL file here ends by saying what it just guaranteed, so applying it
   is not an act of faith. A row reading anything but ok is a thing to chase.
   ═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   THE IMPORTER'S OWN GRANTS.

   This file named service_role exactly zero times while mlb_pitcher_history.sql
   named it ten, so the college importer could not write this schema under any
   configuration. Once the schema was exposed to PostgREST the first insert came
   straight back as

     INSERT cbb.import_runs -> 403 {"code":"42501",
       "message":"permission denied for schema cbb"}

   after a clean walk of all 437 teams. The 23 guarantees above did not catch it
   because every one of them checks that a READER cannot write, and none checked
   that the WRITER can. Row 25 is that missing check.
   ═══════════════════════════════════════════════════════════════════════════ */
grant usage on schema cbb to service_role;
grant usage, select on all sequences in schema cbb to service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'import_runs','teams','games','team_seasons',
    'player_games','player_seasons','team_stat_seasons',
    'ncaa_player_seasons','club_map',
    'stg_teams','stg_games','stg_player_games',
    'stg_ncaa_player_seasons','stg_club_map'
  ] loop
    if to_regclass('cbb.' || t) is not null then
      execute format('grant all on cbb.%I to service_role', t);
    end if;
  end loop;
end $$;

do $$
declare f record;
begin
  /* The gates, to the writer only. Iterating pg_proc rather than listing
     signatures keeps this right when an argument list changes. */
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cbb'
      and p.proname in ('promote_cbb_import','abandon_cbb_import','rebuild_team_seasons',
                        'promote_cbb_stats','rebuild_player_seasons',
                        'promote_ncaa_seasons','promote_club_map')
  loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

/* ═══════════════════════════════════════════════════════════════════════════
   THE VIEWS, GRANTED AND MADE TO HONOUR RLS.

   Every grant above is a loop over TABLE names, so all four views were left
   ungranted and the college card answered db 403 while the MLB panels, whose
   contract grants mlbhist.dataset_status by name, came up fine. Granted here
   as one list rather than inside the loops, so adding a view cannot silently
   skip its grant again.

   security_invoker makes a view read as whoever called it. Without it a view
   runs as its owner and reads straight past the policies on the tables under
   it — which changes nothing while every one of those tables has a read-all
   policy, and becomes an invisible hole the first time one is narrowed.
   ═══════════════════════════════════════════════════════════════════════════ */
do $$
declare v text;
begin
  foreach v in array array['season_status','stats_coverage',
                           'ncaa_archive_status','archive_by_espn_club'] loop
    if to_regclass('cbb.' || v) is not null then
      execute format('alter view cbb.%I set (security_invoker = true)', v);
      execute format('grant select on cbb.%I to anon, authenticated, service_role', v);
    end if;
  end loop;
end $$;

with checks as (
  select 1 as n, 'cbb.games is the union spine and is keyed on the source game id' as guarantee,
    case when exists (select 1 from information_schema.table_constraints
                       where table_schema='cbb' and table_name='games' and constraint_type='PRIMARY KEY')
         then 'ok' else 'CHECK THIS — no primary key on cbb.games' end as result
  union all select 2, 'a game can render even when a side is not a known team',
    case when (select is_nullable from information_schema.columns
                where table_schema='cbb' and table_name='games' and column_name='away_team_id') = 'YES'
          and (select is_nullable from information_schema.columns
                where table_schema='cbb' and table_name='games' and column_name='away_name') = 'NO'
         then 'ok (ids may be absent, names never are — a non-D1 visitor still appears)'
         else 'CHECK THIS — a game with an unknown opponent would be dropped' end
  union all select 3, 'team_seasons is derived from the game log, not fetched',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='cbb' and p.proname='rebuild_team_seasons')
         then 'ok (rebuild_team_seasons folds cbb.games; there is no second source to disagree with)'
         else 'CHECK THIS — no derivation function' end
  union all select 4, 'the promote refuses an import that shrank',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%IMPORT_SHRANK%'
         then 'ok (the source answers 200 with an empty slate when hurried; that is never written)'
         else 'CHECK THIS — a partial answer could delete a day of games' end
  union all select 5, 'an empty import is refused outright',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%EMPTY_IMPORT%'
         then 'ok' else 'CHECK THIS' end
  union all select 6, 'a finished game cannot carry no score unless it was abandoned',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%COMPLETED_WITHOUT_SCORE%'
         then 'ok (postponed, cancelled, suspended and forfeited are excluded by name)'
         else 'CHECK THIS' end
  union all select 7, 'the union is actually a union',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%DUPLICATE_GAME_IDS%'
         then 'ok (a duplicated game id means the walk stopped being a union)'
         else 'CHECK THIS' end
  union all select 8, 'anon and authenticated may read the record',
    case when (select count(*) from pg_policies
                where schemaname='cbb' and tablename in ('games','teams','team_seasons','import_runs')) >= 4
         then 'ok' else 'CHECK THIS — a reader cannot see the board' end
  union all select 9, 'staging is readable by nobody',
    case when (select count(*) from pg_policies
                where schemaname='cbb' and tablename in ('stg_games','stg_teams')) = 0
         then 'ok (RLS with no policy denies by default)' else 'CHECK THIS — staging is exposed' end
  union all select 10, 'the gates are not callable by a reader',
    case when has_function_privilege('anon','cbb.promote_cbb_import(text, boolean, date, date)','EXECUTE') = false
         then 'ok' else 'CHECK THIS — anon can promote an import' end
  union all select 11, 'the season is the calendar year of the date',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%SEASON_DATE_MISMATCH%'
         then 'ok (February to June, so the year is the season)' else 'CHECK THIS' end
  union all select 12, 'cbb is exposed to the API (a project setting, not checkable here)',
    'ok (confirm Supabase > API > Exposed schemas lists cbb)'

  /* ── the stats half ── */
  union all select 13, 'innings pitched is stored as outs, not as a decimal',
    case when exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_games' and column_name='outs')
          and not exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_games'
                         and column_name in ('innings','ip'))
         then 'ok ("6.2" is 20 outs, not 6.2 innings; adding decimals gives 12.4, '
              || 'which is not a possible innings figure)'
         else 'CHECK THIS — a decimal innings column will be summed wrongly sooner or later' end
  union all select 14, 'the season-to-date rates on a box score are never folded',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_player_seasons')
              like '%order by season, athlete_id, game_date desc%'
         then 'ok (AVG/OBP/SLG/ERA on a line are the player''s SEASON figures as of '
              || 'that game; the fold carries the last one and never averages them)'
         else 'CHECK THIS — averaging a season-to-date column produces a meaningless number' end
  union all select 15, 'a rate over zero denominator is null, never zero',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_player_seasons')
              like '%case when coalesce(b.ab,0) > 0%'
         then 'ok (a hitter with no at-bats has no average; he does not have .000)'
         else 'CHECK THIS' end
  union all select 16, 'OBP and SLG are the source''s own, not computed from what is missing',
    case when exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_seasons'
                         and column_name='obp_reported')
          and not exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_seasons'
                         and column_name in ('obp','slg'))
         then 'ok (the box score has no HBP, SF, 2B or 3B, so neither can be computed; '
              || 'calling (H+BB)/(AB+BB) "OBP" would be a lie)'
         else 'CHECK THIS — an obp column here would have to be a fabrication' end
  union all select 17, 'a stats import that shrank is refused',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%IMPORT_SHRANK%'
         then 'ok (judged against the season the import MEANT to cover, not the span it returned)'
         else 'CHECK THIS' end
  union all select 18, 'a misread column mapping is caught before it is promoted',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%HITS_EXCEED_AB%'
         then 'ok (a box score is a bare list of numbers plus a list of labels, so an '
              || 'off-by-one yields individually plausible, collectively impossible lines)'
         else 'CHECK THIS' end
  union all select 19, 'a line cannot belong to a game the log has never heard of',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%ORPHAN_GAME%'
         then 'ok' else 'CHECK THIS' end
  union all select 20, 'the stats archive says how much of the season it covers',
    case when exists (select 1 from information_schema.views
                       where table_schema='cbb' and table_name='stats_coverage')
          and exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='team_stat_seasons'
                         and column_name='line_coverage')
         then 'ok (not every college box score carries players; the gap is shown, not inherited)'
         else 'CHECK THIS — a partial archive that looks whole is worse than no archive' end
  union all select 21, 'the club hitting line is kept apart from the club record',
    case when exists (select 1 from information_schema.tables
                       where table_schema='cbb' and table_name='team_stat_seasons')
          and exists (select 1 from information_schema.tables
                       where table_schema='cbb' and table_name='team_seasons')
         then 'ok (team_seasons folds every game played; team_stat_seasons folds only the '
              || 'games with box-score lines, and those two sets differ)'
         else 'CHECK THIS' end
  union all select 22, 'the stats staging table is readable by nobody',
    case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='cbb' and c.relname='stg_player_games' and c.relrowsecurity)
          and not exists (select 1 from pg_policies
                       where schemaname='cbb' and tablename='stg_player_games')
         then 'ok (RLS with no policy denies by default)'
         else 'CHECK THIS' end
  union all select 24, 'a reader may read the four views the panels actually ask for',
    case when (select bool_and(has_table_privilege('anon','cbb.'||v,'SELECT'))
               from unnest(array['season_status','stats_coverage',
                                 'ncaa_archive_status','archive_by_espn_club']) v
               where to_regclass('cbb.'||v) is not null)
         then 'ok (an ungranted view is a db 403 on the card, not an empty one)'
         else 'CHECK THIS — the college card will answer 403' end
  union all select 25, 'the importer may write this schema',
    case when has_schema_privilege('service_role','cbb','usage')
          and has_table_privilege('service_role','cbb.import_runs','INSERT')
         then 'ok (checking only that a READER cannot write leaves nobody holding a key)'
         else 'CHECK THIS — no import can reach this schema' end
  union all select 23, 'the stats gates are not callable by a reader',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname in ('promote_cbb_stats','rebuild_player_seasons')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;
