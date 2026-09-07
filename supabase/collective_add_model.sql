-- ===========================================================================
-- Add a model for one creator, in one sport.
--
-- WHY THIS IS A FILE AND NOT A BUTTON. The Collective's API exposes no model
-- creation at all -- not to a creator, not to an admin -- so the only way a
-- contributor gets a second sport is somebody running a statement against the
-- database. The creator dashboard already prints one; this is the same thing
-- as a file, so an operator adding a sport for somebody who asked does not
-- have to go and find their dashboard first.
--
-- WHY A CONTRIBUTOR NEEDS IT. A slate is attached to a MODEL, and the
-- Collective resolves that slate's games in that model's sport. A creator with
-- a CFB model and no NFL model cannot post an NFL slate at all: there is
-- nothing to attach it to, and posting it under the college model would look
-- up NFL games in the college schedule and match none of them. The uploader
-- stops rather than doing that, which is correct and reads, from the outside,
-- as "it isn't letting me submit anything".
--
-- WHAT IT WRITES. One row in `models`, for one creator, in one sport. It never
-- touches the creator row, another creator's models, a projection, or a
-- record. Running it twice adds nothing the second time.
--
-- WHAT IT REFUSES. It finds the creator by slug, then by display name, and
-- then STOPS. It does not fall back to "whoever owns a model already": on a
-- shared Collective that is not a fallback, it is a cross-account write, and
-- the person whose dashboard grows a stranger's model has no way to tell.
--
-- COLUMN NAMES ARE DISCOVERED. `collective/admin.html` reads `sport` where
-- `collective_ingest` reads `sport_code`; both shapes exist in the wild, so
-- this finds the one this deployment has instead of guessing.
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report.
-- ===========================================================================

begin;

create temp table if not exists cam_report (n serial, step text, outcome text, detail text);
truncate cam_report;

create or replace function pg_temp.cam_col(p_rel regclass, p_names text[])
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
  -- ==== THE THREE VALUES THIS FILE IS ABOUT ============================== --
  -- The contributor's slug, as it appears on the wall and in step 2 below.
  p_slug   text := 'edgedesksports';
  -- The sport code THIS server uses. Step 2 lists what the schedule carries;
  -- use one of those, not a code from somewhere else.
  p_sport  text := 'NFL';
  -- Leave empty to name the model "<Creator> <Sport>", which is what the
  -- dashboard would have called it.
  p_name   text := '';
  -- ====================================================================== --
  v_cre    regclass;
  v_mod    regclass;
  s        text;
  c_pk     text; c_slug text; c_name text;
  m_fk     text; m_slug text; m_name text; m_sport text; m_listed text;
  cid      uuid;
  who      text;
  mslug    text; mname text;
  n        int;
begin
  -- 1 ---- the tables, and what their columns are called -------------------
  select c.oid::regclass into v_cre
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p') and c.relname = any (array['creators','members','contributors'])
   order by (n.nspname = 'collective') desc limit 1;
  select c.oid::regclass into v_mod
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p') and c.relname = any (array['models','collective_models'])
   order by (n.nspname = 'collective') desc limit 1;
  if v_cre is null or v_mod is null then
    insert into cam_report(step, outcome, detail)
    values ('1 tables', 'CHECK THIS',
            'creators=' || coalesce(v_cre::text,'NOT FOUND') ||
            ' models=' || coalesce(v_mod::text,'NOT FOUND') || '. Nothing below can run.');
    return;
  end if;
  select n.nspname into s from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = v_cre;

  c_pk    := coalesce((select a.attname::text from pg_constraint con
                         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
                        where con.contype='p' and con.conrelid = v_cre
                          and array_length(con.conkey,1)=1 limit 1),
                      pg_temp.cam_col(v_cre, array['id']));
  c_slug  := pg_temp.cam_col(v_cre, array['slug','creator_slug','handle']);
  c_name  := pg_temp.cam_col(v_cre, array['display_name','name','title']);
  m_fk    := pg_temp.cam_col(v_mod, array['creator_id','creator']);
  m_slug  := pg_temp.cam_col(v_mod, array['slug','model_slug']);
  m_name  := pg_temp.cam_col(v_mod, array['name','model_name','title']);
  m_sport := pg_temp.cam_col(v_mod, array['sport_code','sport','league']);
  m_listed:= pg_temp.cam_col(v_mod, array['is_listed','listed','is_public']);

  insert into cam_report(step, outcome, detail)
  values ('1 tables',
          case when c_pk is null or c_slug is null or m_fk is null or m_slug is null
                 or m_name is null or m_sport is null then 'CHECK THIS' else 'ok' end,
          v_cre::text || ' (' || coalesce(c_slug,'?') || ') + ' || v_mod::text ||
          ' (' || coalesce(m_fk,'?') || ', ' || coalesce(m_slug,'?') ||
          ', ' || coalesce(m_sport,'?') || ')');
  if c_pk is null or c_slug is null or m_fk is null or m_slug is null
     or m_name is null or m_sport is null then
    insert into cam_report(step, outcome, detail)
    values ('1 tables', 'CHECK THIS', 'A column this file needs is named something it does not know.');
    return;
  end if;

  -- 2 ---- who is already here, and what sports exist ----------------------
  execute format('select string_agg(%I, '', '' order by %I) from %s', c_slug, c_slug, v_cre::text)
    into who;
  insert into cam_report(step, outcome, detail) values ('2 contributors', 'ok', coalesce(who,'none'));

  execute format($q$
    select string_agg(t, ', ' order by t) from (
      select distinct %I::text as t from %s where %I is not null) x $q$, m_sport, v_mod::text, m_sport)
    into who;
  insert into cam_report(step, outcome, detail)
  values ('2 sport codes already in models', 'ok', coalesce(who, 'none yet'));

  -- 3 ---- the creator, found and not guessed ------------------------------
  execute format('select %I, %s from %s where %I = $1', c_pk,
    coalesce(quote_ident(c_name), 'null::text'), v_cre::text, c_slug)
    into cid, who using p_slug;
  if cid is null and c_name is not null then
    execute format('select %I, %I from %s where %I = $1', c_pk, c_name, v_cre::text, c_name)
      into cid, who using p_slug;
  end if;
  if cid is null then
    insert into cam_report(step, outcome, detail)
    values ('3 creator', 'CHECK THIS',
            'No contributor matched ' || p_slug || '. Pick one from step 2 and set p_slug. ' ||
            'Not guessing: a model attached to the wrong creator appears in a stranger''s ' ||
            'dashboard and they cannot tell it is not theirs.');
    return;
  end if;
  insert into cam_report(step, outcome, detail)
  values ('3 creator', 'ok', p_slug || ' = ' || coalesce(who, '(no display name)') || ' [' || cid::text || ']');

  -- 4 ---- the model --------------------------------------------------------
  mslug := p_slug || '-' || lower(regexp_replace(p_sport, '[^A-Za-z0-9]+', '', 'g'));
  mname := case when coalesce(p_name,'') <> '' then p_name
                else coalesce(who, p_slug) || ' ' || p_sport end;

  execute format('select count(*) from %s where %I = $1 and upper(%I::text) = upper($2)',
    v_mod::text, m_fk, m_sport) into n using cid, p_sport;
  if n > 0 then
    insert into cam_report(step, outcome, detail)
    values ('4 model', 'ok, already',
            p_slug || ' already has a ' || p_sport || ' model. Nothing written.');
  else
    execute format('insert into %s (%I, %I, %I, %I%s) values ($1, $2, $3, $4%s)',
      v_mod::text, m_fk, m_slug, m_name, m_sport,
      case when m_listed is null then '' else ', ' || quote_ident(m_listed) end,
      case when m_listed is null then '' else ', true' end)
      using cid, mslug, mname, p_sport;
    insert into cam_report(step, outcome, detail)
    values ('4 model', 'ok', 'added "' || mname || '" (' || mslug || ') for ' || p_slug ||
                             ' in ' || p_sport || ' — they can post that slate now');
  end if;

  -- 5 ---- read it back off the table --------------------------------------
  execute format('select string_agg(%I::text || '' ('' || %I::text || '')'', '', '') from %s where %I = $1',
    m_name, m_sport, v_mod::text, m_fk) into who using cid;
  insert into cam_report(step, outcome, detail)
  values ('5 what this contributor covers now', 'ok', coalesce(who, 'no models'));
end
$do$;

commit;

-- The report runs after the commit, so reading it can never roll the file back.
select n, step, outcome, detail from cam_report order by n;
