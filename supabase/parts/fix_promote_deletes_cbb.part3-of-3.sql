-- fix_promote_deletes_cbb -- part 3 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

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

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'all six cbb gates exist after being replaced' as guarantee,
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'cbb'
                  and p.proname in ('promote_cbb_import','rebuild_team_seasons','promote_cbb_stats',
                                    'rebuild_player_seasons','promote_ncaa_seasons','promote_club_map')) = 6
         then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'no cbb function still carries a DELETE without a WHERE',
    case when not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'cbb'
             and p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+[a-z_.]+[[:space:]]*;')
         then 'ok' else 'CHECK THIS — safeupdate will refuse this gate' end
  union all select 3, 'a reader still cannot call any of them',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'cbb'
                  and p.proname in ('promote_cbb_import','rebuild_team_seasons','promote_cbb_stats',
                                    'rebuild_player_seasons','promote_ncaa_seasons','promote_club_map')
                  and (has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;

