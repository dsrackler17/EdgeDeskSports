-- ===========================================================================
-- CAN THIS COLLECTIVE TAKE AN NFL SLATE, EVERY WEEK? A read-only answer.
--
-- WHY THIS IS NOT ABOUT INDEXES. The obvious suspect, after
-- collective_model_autocreate.sql, is the unique index on
-- (creator, normalised sport) -- so this checks it first and says exactly what
-- it is built on. But an index has never been what stops a slate: it exists to
-- stop a DUPLICATE model, and a duplicate model was never the failure anybody
-- saw. The failure anybody saw is thirty rows posted and thirty rows
-- quarantined, and that has four possible causes, only one of which any index
-- could touch:
--
--   1. the contributor has no model for the sport      -- fixed: auto-created
--   2. two models for one sport, so nothing can choose -- what the index stops
--   3. the server does not list the sport at all       -- checked here, row 3
--   4. THE SCHEDULE FOR THAT WEEK IS NOT LOADED        -- checked here, row 5
--
-- Four is the one that actually recurs, and it is the one an index cannot
-- reach. A slate resolves by matching each row against a GAME the Collective
-- already holds for that sport, season and week. No games, no matches --
-- every row quarantines, the model is fine, the file is fine, and nothing
-- about the upload says which of the four it was. That is what this file is
-- for: it names which link is broken instead of leaving it to be inferred
-- from a receipt full of quarantined rows.
--
-- NOTHING IS WRITTEN. Not a row, not an index, not a grant. It is safe to run
-- on production at any time, as often as you like, including mid-slate. The
-- repairs it points at are at the bottom, commented out, so that running this
-- can never be the thing that changes something.
--
-- Column names are DISCOVERED, the same way collective_model_autocreate.sql
-- discovers them, so this reads whatever shape your deployment actually has.
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report.
-- Every row of the report says ok or CHECK THIS, and a CHECK THIS names the
-- fix.
-- ===========================================================================

-- NO psql META-COMMANDS IN THIS FILE. It is pasted into the Supabase SQL
-- editor, like every other file in this folder, and the editor sends raw SQL
-- to the server. A backslash-set line is psql's own syntax, not SQL, and the
-- server answers with a syntax error at the backslash. Nothing else in this
-- folder carries one. It is not needed here either: this is one temp table,
-- one temp helper, one DO block and one select, and the DO block already
-- returns early on anything it cannot read.

create temp table if not exists nfl_report (n serial, step text, outcome text, detail text);
truncate nfl_report;

create or replace function pg_temp.nfl_col(p_rel regclass, p_names text[])
returns text language sql stable as $fn$
  select a.attname::text
    from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
     and a.attname::text = any (p_names)
   order by array_position(p_names, a.attname::text)
   limit 1;
$fn$;

do $do$
declare
  -- ==== THE ONE THING TO CHANGE ========================================== --
  -- The sport this run is about, and the season to check the schedule for.
  -- Leave p_season null to use whatever the Collective calls current.
  p_sport  text := 'NFL';
  p_season int  := null;
  -- ====================================================================== --
  v_cre    regclass; v_mod regclass; v_gam regclass; v_sports regclass; v_seasons regclass;
  v_teams  regclass;
  s        text;
  c_pk text; c_slug text; c_status text;
  m_fk text; m_slug text; m_name text; m_sport text;
  g_sport text; g_season text; g_week text; g_kick text;
  sp_code text; sp_active text;
  ss_sport text; ss_season text;
  canon    text; fam text; fam_expr text;
  n        int; n2 int; txt text; idx text;
begin
  -- 0 ---- the tables, found rather than assumed -----------------------------
  select c.oid::regclass into v_cre from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p') and c.relname = any(array['creators','members','contributors'])
     and nn.nspname not in ('pg_catalog','information_schema')
   order by (nn.nspname='collective') desc limit 1;
  select c.oid::regclass into v_mod from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p') and c.relname = any(array['models','collective_models'])
     and nn.nspname not in ('pg_catalog','information_schema')
   order by (nn.nspname='collective') desc limit 1;
  if v_cre is null or v_mod is null then
    insert into nfl_report(step,outcome,detail) values
      ('0 tables','CHECK THIS','No creators/models table found. This file is for a Collective database.');
    return;
  end if;
  select nn.nspname into s from pg_class c join pg_namespace nn on nn.oid=c.relnamespace where c.oid=v_cre;

  select c.oid::regclass into v_gam from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p','v','m') and c.relname='games' and nn.nspname=s limit 1;
  select c.oid::regclass into v_sports from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p','v','m') and c.relname='sports' and nn.nspname=s limit 1;
  select c.oid::regclass into v_seasons from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p','v','m') and c.relname='sport_seasons' and nn.nspname=s limit 1;
  select c.oid::regclass into v_teams from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
   where c.relkind in ('r','p','v','m') and c.relname='teams' and nn.nspname=s limit 1;

  c_pk    := coalesce((select a.attname::text from pg_constraint con
                         join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
                        where con.contype='p' and con.conrelid=v_cre and array_length(con.conkey,1)=1 limit 1),
                      pg_temp.nfl_col(v_cre, array['id']));
  c_slug  := pg_temp.nfl_col(v_cre, array['slug','creator_slug','handle']);
  c_status:= pg_temp.nfl_col(v_cre, array['status','account_status','state']);
  m_fk    := pg_temp.nfl_col(v_mod, array['creator_id','creator']);
  m_slug  := pg_temp.nfl_col(v_mod, array['slug','model_slug']);
  m_name  := pg_temp.nfl_col(v_mod, array['name','model_name','title']);
  m_sport := pg_temp.nfl_col(v_mod, array['sport_code','sport','league']);
  if v_gam is not null then
    g_sport  := pg_temp.nfl_col(v_gam, array['sport_code','sport','league']);
    g_season := pg_temp.nfl_col(v_gam, array['season','season_year','year']);
    g_week   := pg_temp.nfl_col(v_gam, array['week','week_no','game_week']);
    g_kick   := pg_temp.nfl_col(v_gam, array['kickoff_at','kickoff','starts_at','commence_time']);
  end if;
  if v_sports is not null then
    sp_code   := pg_temp.nfl_col(v_sports, array['code','sport_code','sport']);
    sp_active := pg_temp.nfl_col(v_sports, array['active','is_active','enabled']);
  end if;
  if v_seasons is not null then
    ss_sport  := pg_temp.nfl_col(v_seasons, array['sport_code','sport','code']);
    ss_season := pg_temp.nfl_col(v_seasons, array['season','season_year','year']);
  end if;

  insert into nfl_report(step,outcome,detail) values
    ('0 tables', case when m_sport is null then 'CHECK THIS' else 'ok' end,
     v_mod::text || '(' || coalesce(m_sport,'?') || ')' ||
     ' games=' || coalesce(v_gam::text,'NOT FOUND') ||
     ' sports=' || coalesce(v_sports::text,'none') ||
     ' teams=' || coalesce(v_teams::text,'none'));

  -- 1 ---- is the self-serve layer installed at all? -------------------------
  if to_regprocedure(format('%I.get_or_create_model(uuid,text,text)', s)) is null then
    insert into nfl_report(step,outcome,detail) values
      ('1 self-serve models','CHECK THIS',
       'collective.get_or_create_model is NOT installed. Run supabase/collective_model_autocreate.sql. '
       || 'Without it a contributor can still post -- the edge functions write the row directly -- but '
       || 'two simultaneous posts are only as safe as the models table''s own uniqueness.');
  else
    insert into nfl_report(step,outcome,detail) values
      ('1 self-serve models','ok',
       'get_or_create_model + '
       || case when to_regprocedure('public.collective_model_ensure(text,text)') is null
               then 'collective_model_ensure MISSING (the browser door)'
               else 'collective_model_ensure' end
       || ' installed.');
  end if;

  -- 2 ---- THE INDEX, and what it is actually built on ------------------------
  select i.indexrelid::regclass::text || ' on ' || pg_get_indexdef(i.indexrelid)
    into idx
    from pg_index i
   where i.indrelid = v_mod and i.indisunique
     and pg_get_indexdef(i.indexrelid) ~ 'sport'
   limit 1;
  if idx is null then
    -- No expression index. Is there at least a plain one?
    select i.indexrelid::regclass::text || ' on ' || pg_get_indexdef(i.indexrelid)
      into idx from pg_index i where i.indrelid = v_mod and i.indisunique limit 1;
    insert into nfl_report(step,outcome,detail) values
      ('2 one model per sport','CHECK THIS',
       'No unique index mentioning the sport column on ' || v_mod::text || '. ' ||
       coalesce('Closest: ' || idx || '. ', '') ||
       'Re-run supabase/collective_model_autocreate.sql -- it creates it, and reports why if it cannot '
       || '(the usual reason is a creator who already has two models in one sport; step 4 below names them).');
  else
    insert into nfl_report(step,outcome,detail) values
      ('2 one model per sport','ok', idx ||
       case when idx ~ 'sport_family' then '  -- the full expression index: two SPELLINGS of one sport cannot become two models'
            else '  -- plain column index: duplicates of the same code are blocked, two spellings are not (an enum sport column cannot carry the expression form)' end);
  end if;

  -- 3 ---- does this server carry the sport at all? --------------------------
  if to_regprocedure(format('%I.sport_canonical(text)', s)) is not null then
    execute format('select %I.sport_canonical($1), %I.sport_family($1)', s, s)
      into canon, fam using p_sport;
  else
    canon := upper(p_sport); fam := upper(p_sport);
  end if;
  if v_sports is not null and sp_code is not null then
    execute format('select string_agg(%I::text, '', '' order by %I::text) from %s %s',
      sp_code, sp_code, v_sports::text,
      case when sp_active is null then '' else format('where coalesce(%I,true)', sp_active) end)
      into txt;
    execute format('select count(*) from %s where upper(%I::text) = upper($1) %s',
      v_sports::text, sp_code,
      case when sp_active is null then '' else format('and coalesce(%I,true)', sp_active) end)
      into n using canon;
    insert into nfl_report(step,outcome,detail) values
      ('3 the server''s sport list', case when n > 0 then 'ok' else 'CHECK THIS' end,
       p_sport || ' normalises to ' || coalesce(canon,'(nothing)') ||
       ' (family ' || coalesce(fam,'?') || '). Active sports: ' || coalesce(txt,'NONE') ||
       case when n > 0 then '.'
            else '. ' || canon || ' IS NOT ONE OF THEM -- a slate for it can never resolve, whatever '
                 || 'model it is attached to. The repair is at the bottom of this file.' end);
  else
    insert into nfl_report(step,outcome,detail) values
      ('3 the server''s sport list','CHECK THIS',
       'No sports table found, so the vocabulary cannot be checked. ' || p_sport ||
       ' would be written back as ' || coalesce(canon,'(nothing)') || '.');
  end if;

  -- 4 ---- who can post it, and is anybody ambiguous? ------------------------
  -- The expression that normalises a stored sport code. sport_family() where
  -- the migration installed it; the raw column where it did not, so this file
  -- still answers on a database that has not been migrated yet.
  if to_regprocedure(format('%I.sport_family(text)', s)) is null then
    fam_expr := format('upper(m.%I::text)', m_sport);
  else
    fam_expr := format('upper(%I.sport_family(m.%I::text))', s, m_sport);
  end if;

  execute format($q$
    select count(*) from %s m
     where m.%I is not null and %s = upper($1) $q$,
    v_mod::text, m_sport, fam_expr)
    into n using fam;
  execute format($q$
    select string_agg(c.%I || ' -> ' || m.%I::text, ', ' order by c.%I)
      from %s m join %s c on c.%I = m.%I
     where m.%I is not null and %s = upper($1) $q$,
    c_slug, m_name, c_slug, v_mod::text, v_cre::text, c_pk, m_fk, m_sport, fam_expr)
    into txt using fam;
  insert into nfl_report(step,outcome,detail) values
    ('4 who covers ' || fam, case when n > 0 then 'ok' else 'ok, none yet' end,
     case when n > 0 then n || ' model(s): ' || coalesce(txt,'')
          else 'Nobody has one yet. That is not a blocker any more -- the first slate posted for '
               || fam || ' creates the model with the submission.' end);

  -- duplicates: the one thing the index exists to stop, named if present
  execute format($q$
    select string_agg(t, '; ') from (
      select c.%I || ' has ' || count(*) || ' models in ' || %s as t
        from %s m join %s c on c.%I = m.%I
       where m.%I is not null
       group by c.%I, %s
      having count(*) > 1) x $q$,
    c_slug, fam_expr, v_mod::text, v_cre::text, c_pk, m_fk, m_sport, c_slug, fam_expr)
    into txt;
  insert into nfl_report(step,outcome,detail) values
    ('4 duplicate models', case when txt is null then 'ok' else 'CHECK THIS' end,
     coalesce('Two models in one sport, so no upload can choose between them without naming one: '
              || txt || '. Merge or rename before the unique index can be created.',
              'No creator has two models in one sport.'));

  -- 5 ---- THE SCHEDULE. This is the one that recurs. ------------------------
  if v_gam is null or g_sport is null or g_season is null then
    insert into nfl_report(step,outcome,detail) values
      ('5 the schedule','CHECK THIS','No games table (or no sport/season column on it) to check.');
  else
    if p_season is null and v_seasons is not null and ss_season is not null then
      execute format('select max(%I) from %s where upper(%I::text) = upper($1)',
        ss_season, v_seasons::text, ss_sport) into p_season using canon;
    end if;
    if p_season is null then
      execute format('select max(%I) from %s where upper(%I::text) = upper($1)',
        g_season, v_gam::text, g_sport) into p_season using canon;
    end if;

    execute format('select count(*) from %s where upper(%I::text) = upper($1) and %I = $2',
      v_gam::text, g_sport, g_season) into n using canon, p_season;

    if g_week is not null and g_kick is not null then
      execute format($q$
        select string_agg(w::text || ':' || c::text, '  ' order by w) from (
          select %I as w, count(*) as c from %s
           where upper(%I::text) = upper($1) and %I = $2 and %I is not null
           group by %I order by %I) x $q$,
        g_week, v_gam::text, g_sport, g_season, g_week, g_week, g_week)
        into txt using canon, p_season;
      -- the week a slate posted right now would be matched against
      execute format($q$
        select count(*) from %s
         where upper(%I::text) = upper($1) and %I = $2
           and %I >= now() - interval '36 hours' $q$,
        v_gam::text, g_sport, g_season, g_kick) into n2 using canon, p_season;
    else
      txt := '(no week column)'; n2 := n;
    end if;

    insert into nfl_report(step,outcome,detail) values
      ('5 the schedule', case when n > 0 and n2 > 0 then 'ok'
                              when n > 0 then 'CHECK THIS' else 'CHECK THIS' end,
       canon || ' ' || coalesce(p_season::text,'(no season)') || ': ' || n || ' game(s) loaded, ' ||
       n2 || ' still ahead of kickoff. Games per week -> ' || coalesce(txt,'none') ||
       case when n = 0 then
              '. NOTHING IS LOADED. Every row of an upload would quarantine -- not because the file '
              || 'or the model is wrong, but because there is no game to attach to. Load it with '
              || 'tools/collective/sync_schedule.js (the Sync the Collective schedule workflow runs '
              || 'it daily; a blank sport does every sport).'
            when n2 = 0 then
              '. Every loaded game has already kicked off, so a slate posted now has nothing ahead '
              || 'of it to match. Next week has not been ingested yet -- run the schedule sync.'
            else '.' end);
  end if;

  -- 6 ---- teams, because a game cannot reference one the backend lacks ------
  if v_teams is not null then
    execute format('select count(*) from %s where upper(%I::text) = upper($1)',
      v_teams::text, pg_temp.nfl_col(v_teams, array['sport_code','sport','league'])) into n using canon;
    insert into nfl_report(step,outcome,detail) values
      ('6 teams', case when n >= 2 then 'ok' else 'CHECK THIS' end,
       n || ' ' || canon || ' team(s) known.' ||
       case when n < 2 then ' A game cannot reference a team the backend has never been given, so the '
                            || 'schedule sync loads teams first. If this stays at 0 the sync is not running.'
            else '' end);
  end if;
end
$do$;

select n, step, outcome, detail from nfl_report order by n;

-- ===========================================================================
-- THE REPAIRS. Commented out on purpose: running the diagnostic must never be
-- the thing that changes something. Uncomment only the line a CHECK THIS above
-- actually asked for.
--
-- Row 1 or 2 (the self-serve layer, or the index):
--     run supabase/collective_model_autocreate.sql -- it is idempotent and
--     ends in its own report.
--
-- Row 3 (the server does not list the sport). This is the only repair that is
-- a plain insert, and it is additive: it adds the code and the season window
-- the rest of the system reads. Set the dates to the real season.
--
--     insert into collective.sports (code, name, active)
--     values ('NFL', 'Football', true)
--     on conflict (code) do update set active = true;
--
--     insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
--     values ('NFL', 2026, date '2026-09-01', date '2027-02-15')
--     on conflict do nothing;
--
-- Row 5 (the schedule). NOT a SQL repair -- games come from the schedule feed,
-- and loading them by hand is how a slate ends up attached to a fixture nobody
-- checked. Use the loader, which reads ESPN, compares, and writes only what is
-- missing:
--
--     node tools/collective/sync_schedule.js --sport NFL            # dry run
--     node tools/collective/sync_schedule.js --sport NFL --commit   # load it
--
--     or run the "Sync the Collective schedule" workflow, which does every
--     sport daily at 09:20 UTC. It needs COLLECTIVE_ADMIN_REFRESH_TOKEN set as
--     a repository secret; without it the job warns and loads nothing, which
--     looks exactly like a working sync that had nothing to do.
--
-- Row 6 (teams) is loaded by the same sync, before the games.
-- ===========================================================================
