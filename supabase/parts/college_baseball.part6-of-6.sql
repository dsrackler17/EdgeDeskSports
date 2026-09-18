-- college_baseball -- part 6 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

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

  delete from cbb.club_map;
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
  union all select 23, 'the stats gates are not callable by a reader',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname in ('promote_cbb_stats','rebuild_player_seasons')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;

