-- ===========================================================================
-- SELF-SERVE MODELS. A contributor gets a model for a sport by asking for one.
--
-- WHAT WAS WRONG. A slate attaches to a MODEL, and the Collective resolves that
-- slate's games in that model's sport. The API exposed no model creation at
-- all, so a contributor with a CFB model who wanted to post an NFL slate had
-- nothing to attach it to, and the only cure was somebody with database access
-- running a statement. The dashboard said so out loud -- "self-serve model
-- creation is not deployed on this backend yet" -- which is a product telling a
-- paying contributor that the next step is not theirs to take. Worse, when they
-- posted anyway the ingest picked their ONLY model, so NFL rows were looked up
-- in the college schedule and every game came back unmatched.
--
-- WHY THIS IS A DATABASE FILE. collective_join, collective_public and
-- collective_admin are deployed from the Supabase dashboard and are not in this
-- repository, so a fix that lives in one of them cannot be reviewed, tested, or
-- relied on by the others -- and the three of them would each need their own
-- copy. collective_member_removal.sql already answered this question: put the
-- whole capability in the DATABASE, so the guarantee does not depend on which
-- edge function happens to be deployed. This is the same move.
--
--   collective.get_or_create_model(creator, sport, name)
--       THE single source of truth. Every caller goes through it.
--   public.collective_model_ensure(sport, name)
--       The door a signed-in contributor's browser knocks on. The creator is
--       auth.uid()'s own and THERE IS NO ARGUMENT FOR IT, so nothing the page
--       sends can claim to be somebody else.
--   public.collective_my_models()
--       Read your own models back. Yours only, same rule.
--
-- collective_ingest calls the first one with the service role; the dashboard
-- calls the second with the contributor's own token. One function, one set of
-- rules, one place a bug can be.
--
-- IDEMPOTENT BY CONSTRUCTION, NOT BY LUCK. A unique index on
-- (creator, normalised sport) plus insert ... on conflict do nothing, under a
-- transaction-scoped advisory lock. Two tabs, two API calls and two schedulers
-- firing at the same instant get the same row back. There is no
-- select-then-insert window to lose.
--
-- ALIASES COLLAPSE. NFL / "National Football League" / "pro football" are one
-- sport. CFB / NCAAF / "college football" / CFB-P4 are one sport. The alias
-- table is the same map collective/index.html's SPORTS registry carries, so a
-- file detected as college football and a code typed as NCAAF cannot become two
-- models. The SERVER still owns the vocabulary: a family is written back using
-- whichever code THIS deployment's sports table uses.
--
-- RLS IS NOT TOUCHED. Nothing here disables a policy or grants a client role
-- access to a table. The two public wrappers are SECURITY DEFINER, derive the
-- caller from auth.uid(), and are granted to `authenticated` only; `anon` is
-- revoked explicitly.
--
-- COLUMN NAMES ARE DISCOVERED. collective/admin.html reads `sport` where
-- collective_ingest reads `sport_code`; both shapes exist in the wild. This
-- file finds the ones this deployment has and BUILDS the function around them,
-- then reports which it bound to, rather than guessing and failing at 3am.
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report.
-- ===========================================================================

begin;

create temp table if not exists cma_report (n serial, step text, outcome text, detail text);
truncate cma_report;

-- ---------------------------------------------------------------------------
-- 0. Where the Collective lives, and what its columns are called.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.cma_col(p_rel regclass, p_names text[])
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
  v_cre     regclass;
  v_mod     regclass;
  v_sports  regclass;
  s         text;            -- the schema the Collective lives in
  c_pk      text; c_slug text; c_name text; c_user text; c_status text; c_removed text;
  m_pk      text; m_fk text; m_slug text; m_name text; m_sport text; m_listed text;
  m_sport_t text;           -- the sport column's OWN type: text on most
                            -- deployments, an enum on some, and a text value
                            -- assigned to an enum column is a hard error
                            -- ("column is of type sp but expression is of type
                            -- text"), so the insert casts to whatever it is.
  sp_code   text; sp_active text;
  dupes     text;
  n         int;
  body      text;
  alias_vals text;          -- the alias map, compiled into a VALUES list
  fam_src   text;           -- the sport_family() body this run installs
  fam_was   text;           -- the one it found (null on a first install)
begin
  -- ---- the two tables everything here is about ----------------------------
  select c.oid::regclass into v_cre
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p') and c.relname = any (array['creators','members','contributors'])
     and n.nspname not in ('pg_catalog','information_schema')
   order by (n.nspname = 'collective') desc, c.relname limit 1;
  select c.oid::regclass into v_mod
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p') and c.relname = any (array['models','collective_models'])
     and n.nspname not in ('pg_catalog','information_schema')
   order by (n.nspname = 'collective') desc, c.relname limit 1;

  if v_cre is null or v_mod is null then
    insert into cma_report(step, outcome, detail)
    values ('0 tables', 'CHECK THIS',
            'creators=' || coalesce(v_cre::text,'NOT FOUND') ||
            ' models='  || coalesce(v_mod::text,'NOT FOUND') ||
            '. Nothing below can be installed. This file is for a Collective database.');
    return;
  end if;
  select n.nspname into s
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = v_cre;

  -- The sports table is OPTIONAL. Where it exists it owns the vocabulary; where
  -- it does not, the codes already on models do, and failing that the family
  -- name itself. A deployment without it must still be able to self-serve.
  select c.oid::regclass into v_sports
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p','v','m') and c.relname = 'sports'
     and n.nspname not in ('pg_catalog','information_schema')
   order by (n.nspname = s) desc, (n.nspname = 'collective') desc limit 1;

  c_pk     := coalesce((select a.attname::text from pg_constraint con
                          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
                         where con.contype='p' and con.conrelid = v_cre
                           and array_length(con.conkey,1)=1 limit 1),
                       pg_temp.cma_col(v_cre, array['id']));
  c_slug   := pg_temp.cma_col(v_cre, array['slug','creator_slug','handle']);
  c_name   := pg_temp.cma_col(v_cre, array['display_name','name','title']);
  c_user   := pg_temp.cma_col(v_cre, array['user_id','auth_user_id','uid','owner_id']);
  c_status := pg_temp.cma_col(v_cre, array['status','account_status','state']);
  c_removed:= pg_temp.cma_col(v_cre, array['removed_at']);

  m_pk     := coalesce((select a.attname::text from pg_constraint con
                          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
                         where con.contype='p' and con.conrelid = v_mod
                           and array_length(con.conkey,1)=1 limit 1),
                       pg_temp.cma_col(v_mod, array['id']));
  m_fk     := pg_temp.cma_col(v_mod, array['creator_id','creator']);
  m_slug   := pg_temp.cma_col(v_mod, array['slug','model_slug']);
  m_name   := pg_temp.cma_col(v_mod, array['name','model_name','title']);
  m_sport  := pg_temp.cma_col(v_mod, array['sport_code','sport','league']);
  m_listed := pg_temp.cma_col(v_mod, array['is_listed','listed','is_public']);
  select format_type(a.atttypid, a.atttypmod) into m_sport_t
    from pg_attribute a where a.attrelid = v_mod and a.attname = m_sport;

  if v_sports is not null then
    sp_code   := pg_temp.cma_col(v_sports, array['code','sport_code','sport']);
    sp_active := pg_temp.cma_col(v_sports, array['active','is_active','enabled']);
    if sp_code is null then v_sports := null; end if;
  end if;

  insert into cma_report(step, outcome, detail)
  values ('0 tables',
          case when c_pk is null or c_slug is null or c_user is null or m_pk is null
                 or m_fk is null or m_slug is null or m_name is null or m_sport is null
               then 'CHECK THIS' else 'ok' end,
          v_cre::text || '(' || coalesce(c_pk,'?') || ',' || coalesce(c_slug,'?') ||
          ',user=' || coalesce(c_user,'NONE') || ',status=' || coalesce(c_status,'none') || ') + ' ||
          v_mod::text || '(' || coalesce(m_fk,'?') || ',' || coalesce(m_slug,'?') ||
          ',' || coalesce(m_sport,'?') || ' ' || coalesce(m_sport_t,'?') ||
          ') + sports=' || coalesce(v_sports::text,'none'));

  if c_pk is null or c_slug is null or m_pk is null or m_fk is null
     or m_slug is null or m_name is null or m_sport is null then
    insert into cma_report(step, outcome, detail)
    values ('0 tables', 'CHECK THIS',
            'A column this file needs is named something it has never seen. Add the real name to '
            || 'the candidate list at the top of this file and re-run; nothing has been installed.');
    return;
  end if;

  -- A creators table with no link to auth.users cannot answer "which creator is
  -- this signed-in person", so the browser door is not installable. The
  -- service-role door still is, and collective_ingest uses that one -- so the
  -- API path self-serves even here. Say which half was installed.
  if c_user is null then
    insert into cma_report(step, outcome, detail)
    values ('0 tables', 'CHECK THIS',
            'creators has no user_id-shaped column, so public.collective_model_ensure() cannot '
            || 'know who is calling and is NOT installed. collective.get_or_create_model() is, '
            || 'so the API and ingest paths still self-serve.');
  end if;

  -- ---- 1. the sport vocabulary -------------------------------------------
  -- Aliases are DATA, not a CASE expression, so adding the next sport is an
  -- insert here and a registry entry in collective/index.html -- not a new
  -- branch in three functions.
  execute format($f$
    create table if not exists %I.sport_aliases (
      alias      text primary key,
      family     text not null,
      created_at timestamptz not null default now()
    ) $f$, s);
  execute format($f$
    comment on table %I.sport_aliases is
      'Every spelling of a sport that must collapse onto one family. Keep in step with the SPORTS registry in collective/index.html. alias is stored NORMALISED: upper case, alphanumerics only.'
    $f$, s);

  -- The seed. Every alias collective/index.html knows, normalised the same way.
  execute format($f$
    insert into %I.sport_aliases (alias, family) values
      ('NFL','NFL'), ('NATIONALFOOTBALLLEAGUE','NFL'), ('PROFOOTBALL','NFL'),
      ('NFLFOOTBALL','NFL'), ('AMERICANFOOTBALLNFL','NFL'),
      ('CFB','CFB'), ('NCAAF','CFB'), ('CFBP4','CFB'), ('COLLEGE','CFB'),
      ('NCAAFOOTBALL','CFB'), ('COLLEGEFOOTBALL','CFB'), ('NCAAFB','CFB'),
      ('CFP','CFB'), ('AMERICANFOOTBALLNCAAF','CFB')
    on conflict (alias) do nothing $f$, s);

  -- collective.sport_family(text) -> the stable internal key.
  -- Normalisation is upper-case + strip everything that is not A-Z0-9, so
  -- "College Football", "college-football", "COLLEGE_FOOTBALL" and
  -- "collegefootball" are one lookup. An unknown code is its own family: two
  -- unknown sports must never silently merge.
  --
  -- WHY THE MAP IS COMPILED IN rather than read from the table at call time.
  -- The uniqueness rule below is an INDEX on this function, and PostgreSQL will
  -- only index an IMMUTABLE expression -- a function that reads a table cannot
  -- be one. So sport_aliases stays the reviewable source of truth and this file
  -- compiles it into the function. Editing the table therefore takes a re-run
  -- of this file to take effect, which is correct rather than merely
  -- convenient: changing what counts as one sport can merge two models that
  -- already exist, and the index has to be rebuilt to notice. The re-run
  -- detects the change itself and rebuilds it (step 2).
  execute format('select string_agg(format(''(%%L,%%L)'', alias, family), '','' order by alias) from %I.sport_aliases', s)
    into alias_vals;
  if alias_vals is null then
    insert into cma_report(step, outcome, detail)
    values ('1 sport vocabulary', 'CHECK THIS', 'sport_aliases is empty after seeding.');
    return;
  end if;
  fam_src := format($fn$
      with norm as (
        select nullif(upper(regexp_replace(coalesce(p_sport,''), '[^A-Za-z0-9]+', '', 'g')), '') as k
      )
      select coalesce(
        (select a.family from (values %s) as a(alias, family), norm where a.alias = norm.k),
        (select k from norm));
    $fn$, alias_vals);

  -- What is installed right now, if anything. prosrc is stored verbatim
  -- including the whitespace either side of the dollar quotes, so both sides of
  -- the comparison are trimmed: a difference has to be a real one.
  select btrim(p.prosrc) into fam_was
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = s and p.proname = 'sport_family' and p.pronargs = 1;
  fam_src := btrim(fam_src);

  execute format($f$
    create or replace function %I.sport_family(p_sport text)
    returns text
    language sql
    immutable
    parallel safe
    as $fn$ %s $fn$ $f$, s, fam_src);

  -- collective.sport_canonical(text) -> the code THIS deployment writes.
  -- A family is resolved to whichever spelling the server already uses, so a
  -- file detected as CFB becomes NCAAF on a server that says NCAAF. Preference
  -- order: the sports table, then codes already on models, then the family.
  if v_sports is not null then
    body := format($f$
      with fam as (select %I.sport_family(p_sport) as f)
      select coalesce(
        (select sp.%I::text from %s sp, fam
          where %I.sport_family(sp.%I::text) = fam.f %s
          order by sp.%I::text limit 1),
        (select m.%I::text from %s m, fam
          where m.%I is not null and %I.sport_family(m.%I::text) = fam.f
          order by m.%I::text limit 1),
        (select f from fam));
    $f$, s, sp_code, v_sports::text, s, sp_code,
         case when sp_active is null then '' else format('and coalesce(sp.%I, true)', sp_active) end,
         sp_code,
         m_sport, v_mod::text, m_sport, s, m_sport, m_sport);
  else
    body := format($f$
      with fam as (select %I.sport_family(p_sport) as f)
      select coalesce(
        (select m.%I::text from %s m, fam
          where m.%I is not null and %I.sport_family(m.%I::text) = fam.f
          order by m.%I::text limit 1),
        (select f from fam));
    $f$, s, m_sport, v_mod::text, m_sport, s, m_sport, m_sport);
  end if;

  execute format($f$
    create or replace function %I.sport_canonical(p_sport text)
    returns text
    language sql
    stable
    set search_path = %I, public, pg_temp
    as $fn$ %s $fn$ $f$, s, s, body);

  execute format('select count(*) from %I.sport_aliases', s) into n;
  insert into cma_report(step, outcome, detail)
  values ('1 sport vocabulary', case when n >= 14 then 'ok' else 'CHECK THIS' end,
          n || ' aliases; sport_family() and sport_canonical() installed. '
          || 'A bare "football" is NOT an alias of either code on purpose: it names both sports '
          || 'and guessing which one would file a slate against the wrong schedule.');

  -- ---- 2. one model per creator per sport, structurally ------------------
  -- The unique index is what makes the get-or-create safe under concurrency.
  -- It cannot be created over a table that already holds duplicates, so those
  -- are found and NAMED first: this file never merges or deletes a creator's
  -- models to make an index fit.
  execute format($f$
    select string_agg(t, '; ') from (
      select c.%I || ' has ' || count(*) || ' models in ' || %I.sport_family(m.%I::text) as t
        from %s m join %s c on c.%I = m.%I
       where m.%I is not null
       group by c.%I, %I.sport_family(m.%I::text)
      having count(*) > 1) x $f$,
    c_slug, s, m_sport, v_mod::text, v_cre::text, c_pk, m_fk, m_sport, c_slug, s, m_sport)
    into dupes;

  if dupes is null then
    -- An index over sport_family() means what sport_family() meant when it was
    -- built. If the compiled alias map just changed, the entries in it are
    -- stale -- two codes that now collapse onto one family would still sit
    -- there as two -- so it is rebuilt. An index is derived, never data.
    if fam_was is distinct from fam_src then
      execute format('drop index if exists %I.models_creator_sport_family_uniq', s);
    end if;

    -- WHICH INDEX IS EVEN POSSIBLE depends on the column's type. PostgreSQL
    -- only indexes an IMMUTABLE expression, and the cast from an ENUM to text
    -- is STABLE, not immutable -- enum labels can be renamed. So on a
    -- deployment whose sport column is an enum, sport_family(sport::text) is
    -- not indexable at all and asking for it aborts the whole file.
    --
    -- That deployment gets the plain (creator, sport) index instead, which is
    -- the same guarantee narrowed: an enum column can only hold the labels the
    -- server itself declared, and get_or_create_model always writes the
    -- canonical one, so the case the wider index adds -- an enum carrying BOTH
    -- 'CFB' and 'NCAAF' as separate labels -- is the only gap, and the advisory
    -- lock plus canonicalisation still closes it for anything going through
    -- this function. The report says which of the two is in place rather than
    -- letting the difference be invisible.
    if m_sport_t in ('text','character varying','character','name','citext') then
      execute format($f$
        create unique index if not exists models_creator_sport_family_uniq
          on %s (%I, (%I.sport_family(%I::text)))
         where %I is not null $f$, v_mod::text, m_fk, s, m_sport, m_sport);
      insert into cma_report(step, outcome, detail)
      values ('2 one model per sport', 'ok',
              'unique index models_creator_sport_family_uniq on (' || m_fk ||
              ', sport_family(' || m_sport || '))' ||
              case when fam_was is null then ' -- created'
                   when fam_was is distinct from fam_src then ' -- REBUILT: the alias map changed'
                   else ' -- already correct' end ||
              '. Two simultaneous creations cannot both insert, and two spellings '
              || 'of one sport cannot become two models.');
    else
      execute format($f$
        create unique index if not exists models_creator_sport_uniq
          on %s (%I, %I)
         where %I is not null $f$, v_mod::text, m_fk, m_sport, m_sport);
      insert into cma_report(step, outcome, detail)
      values ('2 one model per sport', 'ok',
              'unique index models_creator_sport_uniq on (' || m_fk || ', ' || m_sport ||
              ') -- ' || m_sport || ' is ' || m_sport_t || ', and casting that to text is '
              || 'STABLE rather than immutable, so it cannot carry an expression index. Two '
              || 'simultaneous creations still cannot both insert. Aliases are collapsed by '
              || 'get_or_create_model rather than by the index, which is enough here because '
              || 'the column can only hold labels this server declared.');
    end if;
  else
    insert into cma_report(step, outcome, detail)
    values ('2 one model per sport', 'CHECK THIS',
            'NOT created, because rows already violate it: ' || dupes ||
            '. Nothing was merged or deleted -- that is a decision about somebody''s record, '
            || 'not a migration''s call. get_or_create_model still serialises on an advisory '
            || 'lock and returns the OLDEST matching model, so it is correct meanwhile; '
            || 're-run this file once the duplicates are resolved to add the index.');
  end if;

  -- ---- 3. THE function ----------------------------------------------------
  -- Get-or-create, and the only place in the system that creates a model.
  --
  --   * The sport is normalised FIRST, so NCAAF and CFB reach the same row.
  --   * An advisory lock on (creator, family) serialises concurrent callers
  --     even where the unique index could not be created.
  --   * The insert is ON CONFLICT DO NOTHING and the row is read back after,
  --     so losing the race is not an error -- it is the caller getting exactly
  --     what they asked for.
  --   * It never reads WHOSE model to make from anything but its argument.
  execute format($f$
    create or replace function %I.get_or_create_model(
      p_creator_id uuid,
      p_sport      text,
      p_model_name text default null
    )
    returns table (model_id uuid, model_slug text, model_name text, sport text, created boolean)
    language plpgsql
    security definer
    set search_path = %I, public, pg_temp
    as $fn$
    declare
      v_canon   text;
      v_family  text;
      v_slug    text;
      v_base    text;
      v_name    text;
      v_cslug   text;
      v_cname   text;
      v_try     int := 0;
    begin
      if p_creator_id is null then
        raise exception 'get_or_create_model: no creator' using errcode = '22023';
      end if;
      v_canon  := %I.sport_canonical(p_sport);
      v_family := %I.sport_family(v_canon);
      if coalesce(v_family, '') = '' then
        raise exception 'get_or_create_model: no sport' using errcode = '22023';
      end if;

      -- Serialise every caller asking for the same (creator, sport) so the two
      -- of them cannot both find nothing and both insert. Transaction-scoped:
      -- it lifts on commit AND on rollback, so a failure never holds the lock.
      perform pg_advisory_xact_lock(
        hashtextextended(p_creator_id::text || '|' || v_family, 42));

      -- Already there? Oldest first, so a database that predates the unique
      -- index answers the same way every time.
      select m.%I, m.%I::text, m.%I::text, m.%I::text
        into model_id, model_slug, model_name, sport
        from %s m
       where m.%I = p_creator_id
         and m.%I is not null
         and %I.sport_family(m.%I::text) = v_family
       order by m.%I
       limit 1;
      if found then
        created := false;
        return next;
        return;
      end if;

      select c.%I::text, %s into v_cslug, v_cname
        from %s c where c.%I = p_creator_id;
      if v_cslug is null then
        raise exception 'get_or_create_model: no such creator %%', p_creator_id using errcode = '23503';
      end if;

      v_base := v_cslug || '-' || lower(regexp_replace(v_canon, '[^A-Za-z0-9]+', '', 'g'));
      v_slug := v_base;
      v_name := nullif(btrim(coalesce(p_model_name, '')), '');
      if v_name is null then
        v_name := coalesce(nullif(btrim(coalesce(v_cname, '')), ''), v_cslug) || ' ' || v_canon;
      end if;
      v_name := left(v_name, 60);

      -- A slug is unique per creator in every shape of this schema seen so far,
      -- and a creator may already own one that collides (a renamed model, a
      -- sport re-added under a different code). Walk until it is free rather
      -- than failing on a name.
      while exists (select 1 from %s m where m.%I = p_creator_id and m.%I = v_slug) loop
        v_try := v_try + 1;
        exit when v_try > 50;
        v_slug := v_base || '-' || (v_try + 1)::text;
      end loop;

      insert into %s (%I, %I, %I, %I%s)
      values (p_creator_id, v_slug, v_name, v_canon::%s%s)
      on conflict do nothing;

      -- Read it back rather than trusting the insert: on conflict do nothing
      -- returns no row when somebody else won the race, and that caller's row
      -- is the right answer for this one too.
      select m.%I, m.%I::text, m.%I::text, m.%I::text, (m.%I = v_slug)
        into model_id, model_slug, model_name, sport, created
        from %s m
       where m.%I = p_creator_id
         and m.%I is not null
         and %I.sport_family(m.%I::text) = v_family
       order by m.%I
       limit 1;
      if not found then
        raise exception 'get_or_create_model: the model could not be created for %% in %%',
          p_creator_id, v_canon using errcode = 'P0001';
      end if;
      return next;
    end $fn$ $f$,
    s, s, s, s,
    m_pk, m_slug, m_name, m_sport, v_mod::text, m_fk, m_sport, s, m_sport, m_pk,
    c_slug, case when c_name is null then 'null::text' else format('c.%I::text', c_name) end,
    v_cre::text, c_pk,
    v_mod::text, m_fk, m_slug,
    v_mod::text, m_fk, m_slug, m_name, m_sport,
    case when m_listed is null then '' else ', ' || quote_ident(m_listed) end,
    coalesce(m_sport_t, 'text'),
    case when m_listed is null then '' else ', true' end,
    m_pk, m_slug, m_name, m_sport, m_slug, v_mod::text, m_fk, m_sport, s, m_sport, m_pk);

  execute format($f$
    comment on function %I.get_or_create_model(uuid, text, text) is
      'THE single source of truth for model creation. Idempotent: safe to call on every submission. Normalises the sport, serialises on (creator, family), inserts on conflict do nothing and reads the row back. Never creates a duplicate and never guesses whose model to make.'
    $f$, s);

  -- Client roles have no business calling this one: it takes a creator id.
  execute format('revoke all on function %I.get_or_create_model(uuid, text, text) from public, anon, authenticated', s);
  execute format('grant execute on function %I.get_or_create_model(uuid, text, text) to service_role', s);

  insert into cma_report(step, outcome, detail)
  values ('3 get_or_create_model', 'ok',
          s || '.get_or_create_model(uuid, text, text) -- security definer, advisory-locked, '
          || 'on conflict do nothing. service_role only; anon and authenticated revoked.');

  -- ---- 4. the door a signed-in contributor knocks on ---------------------
  -- The acting creator is derived from auth.uid() and there is NO ARGUMENT for
  -- it, which is the same rule collective_member_removal.sql applies to admin
  -- actions and the rule collective_ingest applies to a key: a body that could
  -- name a creator would be a way to grow a model on somebody else's account.
  if c_user is not null then
    execute format($f$
      create or replace function public.collective_model_ensure(
        p_sport text,
        p_model_name text default null
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = %I, public, pg_temp
      as $fn$
      declare
        v_cid   uuid;
        v_canon text;
        r       record;
      begin
        if auth.uid() is null then
          return jsonb_build_object('ok', false, 'code', 'not_signed_in',
            'message', 'Sign in first.');
        end if;

        select c.%I into v_cid from %s c
         where c.%I = auth.uid() %s %s
         limit 1;
        if v_cid is null then
          return jsonb_build_object('ok', false, 'code', 'no_creator',
            'message', 'This account has no active contributor profile, so there is nothing to add a model to.');
        end if;

        v_canon := %I.sport_canonical(p_sport);
        if coalesce(v_canon, '') = '' then
          return jsonb_build_object('ok', false, 'code', 'invalid_sport',
            'message', 'Name the sport to create a model for.');
        end if;
        if length(coalesce(p_model_name, '')) > 60 then
          return jsonb_build_object('ok', false, 'code', 'invalid_name',
            'message', 'Model name must be 60 characters or fewer.');
        end if;

        select * into r from %I.get_or_create_model(v_cid, v_canon, p_model_name);
        return jsonb_build_object(
          'ok', true,
          'created', r.created,
          'already', not r.created,
          'model', jsonb_build_object(
            'model_slug', r.model_slug,
            'model_name', r.model_name,
            'sport', r.sport));
      end $fn$ $f$,
      s, c_pk, v_cre::text, c_user,
      case when c_status is null then ''
           else format('and coalesce(c.%I, ''active'') = ''active''', c_status) end,
      case when c_removed is null then '' else format('and c.%I is null', c_removed) end,
      s, s);

    execute $f$
      comment on function public.collective_model_ensure(text, text) is
        'Get-or-create the SIGNED-IN contributor''s model for a sport. The creator comes from auth.uid() and cannot be named by the caller. Idempotent; returns { ok, created, model }.'
    $f$;
    revoke all on function public.collective_model_ensure(text, text) from public, anon;
    grant execute on function public.collective_model_ensure(text, text) to authenticated, service_role;

    -- Read your own models back, so the dashboard can refresh from the same
    -- source that just wrote. Yours only: there is no creator argument here
    -- either, and no row from another account can come out of it.
    execute format($f$
      create or replace function public.collective_my_models()
      returns jsonb
      language sql
      stable
      security definer
      set search_path = %I, public, pg_temp
      as $fn$
        select coalesce(jsonb_agg(jsonb_build_object(
                 'model_slug', m.%I::text,
                 'model_name', m.%I::text,
                 'sport',      m.%I::text) order by m.%I), '[]'::jsonb)
          from %s m
         where auth.uid() is not null
           and m.%I in (select c.%I from %s c where c.%I = auth.uid());
      $fn$ $f$, s, m_slug, m_name, m_sport, m_pk, v_mod::text, m_fk, c_pk, v_cre::text, c_user);

    execute $f$
      comment on function public.collective_my_models() is
        'The signed-in contributor''s own models. No creator argument: another account''s models cannot come out of it.'
    $f$;
    revoke all on function public.collective_my_models() from public, anon;
    grant execute on function public.collective_my_models() to authenticated, service_role;

    insert into cma_report(step, outcome, detail)
    values ('4 the contributor''s own door', 'ok',
            'public.collective_model_ensure(text, text) and public.collective_my_models() -- '
            || 'creator derived from auth.uid() via ' || v_cre::text || '.' || c_user ||
            ', no creator argument on either. authenticated granted, anon revoked.');
  else
    insert into cma_report(step, outcome, detail)
    values ('4 the contributor''s own door', 'CHECK THIS',
            'Not installed: creators has no user_id-shaped column to resolve auth.uid() against.');
  end if;

  -- ---- 5. what this changes for the people already here ------------------
  execute format('select count(*) from %s', v_mod::text) into n;
  insert into cma_report(step, outcome, detail)
  values ('5 existing models', 'ok',
          n || ' model(s) untouched. Nothing was renamed, re-slugged, re-sported or deleted: '
          || 'every existing model keeps its id, so every projection, grade and record still '
          || 'points at the same row.');
end
$do$;

commit;

-- The report runs after the commit, so reading it can never roll the file back.
select n, step, outcome, detail from cma_report order by n;
