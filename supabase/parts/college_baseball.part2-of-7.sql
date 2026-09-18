-- college_baseball -- part 2 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
