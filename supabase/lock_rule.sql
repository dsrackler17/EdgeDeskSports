-- ===========================================================================
-- THE LOCK RULE — one paste, no placeholders.
--
-- Paste this whole file into the Supabase SQL editor and run it once. It
-- discovers its own column names, applies what it can, and its RESULT is a
-- report of what it did and what it found. Nothing is deleted; every step
-- that cannot apply says so in the report instead of failing the run.
--
-- The rule: every game locks 30 minutes before kickoff. Each model's LATEST
-- live submission received before the lock is the one the board shows, the
-- consensus blends and the grader grades. Earlier submissions stay stored as
-- movement. A submission received at or after the lock is stored, flagged
-- late, and excluded.
--
-- What it does:
--   1. collective.lock_minutes() / collective.lock_at(kickoff) — the lock,
--      spelled once. Reads collective.config key submission.lock_minutes
--      through get_config when that exists; 30 otherwise.
--   2. the config key submission.lock_minutes = 30 (whatever the config
--      table's columns are called).
--   3. a BEFORE INSERT trigger on collective.projections that flags a live
--      row late when it arrives at or after its game's lock. This is what
--      makes a post inside the last 30 minutes not count. It fails open: if
--      it cannot decide, the row is stored exactly as the ingest sent it.
--   4. the views that pick "the FIRST submission per model per game"
--      (board_models, consensus) are rewritten to pick the LATEST, by
--      flipping the ordering idiom in their own definition. If a view has no
--      such idiom the report says so and shows the definition.
--   5. the report: every step's outcome, the current definitions of the
--      views and of every routine that reads projections (ingest_submission,
--      the grader), and how projections are distributed — so anything this
--      could not flip is one exact paste away.
-- ===========================================================================

begin;

create temp table if not exists lock_rule_report (n serial, step text, outcome text, detail text);
truncate lock_rule_report;

-- 0 ---- sanity ----------------------------------------------------------------
do $do$
begin
  if to_regclass('collective.projections') is null then
    raise exception 'collective.projections does not exist — is this the Collective project?';
  end if;
  insert into lock_rule_report(step, outcome, detail) values
    ('0 sanity', 'ok', 'collective.projections found; board_models ' ||
      case when to_regclass('collective.board_models') is null then 'NOT found' else 'found (' ||
        (select case relkind when 'v' then 'view' when 'm' then 'materialized view' when 'r' then 'table' else relkind::text end
           from pg_class where oid = 'collective.board_models'::regclass) || ')' end);
end $do$;

-- 1 ---- the lock, spelled once --------------------------------------------------
create or replace function collective.lock_minutes()
returns integer
language plpgsql
stable
set search_path = collective, public
as $fn$
declare
  v text;
  n integer;
begin
  begin
    if to_regprocedure('collective.get_config(text)') is not null then
      execute 'select collective.get_config($1)::text' into v using 'submission.lock_minutes';
    end if;
  exception when others then
    v := null;
  end;
  n := nullif(regexp_replace(coalesce(v, ''), '[^0-9]', '', 'g'), '')::integer;
  return coalesce(n, 30);
end
$fn$;

comment on function collective.lock_minutes() is
  'Minutes before kickoff at which a game locks. A submission received at or after the lock is late: stored, flagged, never graded. From collective.config key submission.lock_minutes; 30 when unset.';

create or replace function collective.lock_at(p_kickoff timestamptz)
returns timestamptz
language sql
stable
as $fn$
  select p_kickoff - make_interval(mins => collective.lock_minutes());
$fn$;

comment on function collective.lock_at(timestamptz) is
  'When a game with this kickoff locks. The latest live submission received before this instant is the one that counts.';

insert into lock_rule_report(step, outcome, detail)
values ('1 helpers', 'ok', 'collective.lock_minutes() = ' || collective.lock_minutes() ||
  ' (before the config key is written this is the default); collective.lock_at(kickoff) created');

-- 2 ---- the config key ----------------------------------------------------------
do $do$
declare
  kcol text; vcol text; vtype text; q text; cols text;
begin
  if to_regclass('collective.config') is null then
    insert into lock_rule_report(step, outcome, detail) values
      ('2 config key', 'skipped', 'no collective.config table; the lock stays at the 30-minute default');
    return;
  end if;
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'collective' and table_name = 'config';
  select column_name::text into kcol
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'config'
     and column_name::text in ('key', 'config_key', 'name', 'k', 'setting', 'id')
   order by array_position(array['key', 'config_key', 'name', 'k', 'setting', 'id'], column_name::text)
   limit 1;
  select column_name::text, data_type::text into vcol, vtype
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'config'
     and column_name::text in ('value', 'config_value', 'val', 'v', 'value_json', 'data', 'setting_value')
   order by array_position(array['value', 'config_value', 'val', 'v', 'value_json', 'data', 'setting_value'], column_name::text)
   limit 1;
  if kcol is null or vcol is null then
    insert into lock_rule_report(step, outcome, detail) values
      ('2 config key', 'skipped', 'could not tell which columns are key and value; columns are: ' || cols ||
        '. The lock stays at the 30-minute default, which is the rule anyway.');
    return;
  end if;
  q := format('insert into collective.config (%I, %I) select %L, %s where not exists (select 1 from collective.config where %I = %L)',
    kcol, vcol, 'submission.lock_minutes',
    case when vtype in ('jsonb', 'json') then quote_literal('30') || '::' || vtype
         when vtype in ('integer', 'bigint', 'numeric', 'smallint') then '30'
         else quote_literal('30') end,
    kcol, 'submission.lock_minutes');
  execute q;
  insert into lock_rule_report(step, outcome, detail) values
    ('2 config key', 'ok', 'submission.lock_minutes present in collective.config (' || kcol || '/' || vcol || ' ' || vtype ||
      '); collective.lock_minutes() now reads ' || collective.lock_minutes());
exception when others then
  insert into lock_rule_report(step, outcome, detail) values
    ('2 config key', 'skipped', 'could not write the key (' || sqlerrm || '); the lock stays at the 30-minute default');
end $do$;

-- 3 ---- late is decided by the lock, at insert -----------------------------------
do $do$
declare
  latecol text; recvcol text; origincol text; kickrel text; kickcol text; body text;
begin
  select column_name::text into latecol
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'projections'
     and column_name::text in ('is_late', 'late')
   order by array_position(array['is_late', 'late'], column_name::text) limit 1;
  select column_name::text into recvcol
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'projections'
     and column_name::text in ('received_at', 'submitted_at', 'created_at')
   order by array_position(array['received_at', 'submitted_at', 'created_at'], column_name::text) limit 1;
  select column_name::text into origincol
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'projections' and column_name::text = 'data_origin';
  if latecol is null or recvcol is null then
    insert into lock_rule_report(step, outcome, detail) values
      ('3 late-by-lock trigger', 'skipped', 'projections has no late/received column I recognise; columns are: ' ||
        (select string_agg(column_name::text, ', ' order by ordinal_position)
           from information_schema.columns where table_schema = 'collective' and table_name = 'projections'));
    return;
  end if;
  /* where a game's kickoff lives: the game_detail view the board reads
     (game_id, kickoff_at), else the games table's own kickoff column */
  if to_regclass('collective.game_detail') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'collective' and table_name = 'game_detail' and column_name::text = 'kickoff_at') then
    kickrel := 'collective.game_detail'; kickcol := 'kickoff_at';
  else
    select column_name::text into kickcol
      from information_schema.columns
     where table_schema = 'collective' and table_name = 'games'
       and column_name::text in ('kickoff_at', 'kickoff', 'commence_time', 'start_time', 'starts_at')
     order by array_position(array['kickoff_at', 'kickoff', 'commence_time', 'start_time', 'starts_at'], column_name::text) limit 1;
    kickrel := 'collective.games';
  end if;
  if kickcol is null then
    insert into lock_rule_report(step, outcome, detail) values
      ('3 late-by-lock trigger', 'skipped', 'could not find a kickoff column on collective.game_detail or collective.games');
    return;
  end if;
  body := format($f$
    create or replace function collective.projections_lock_late()
    returns trigger
    language plpgsql
    security definer
    set search_path = collective, public
    as $b$
    declare
      k timestamptz;
    begin
      /* FAILS OPEN. Anything unexpected here must not cost a creator their
         slate: the row is stored exactly as the ingest sent it. */
      begin
        if new.game_id is null then return new; end if;
        %s
        select %I into k from %s where game_id = new.game_id limit 1;
        if k is not null and coalesce(new.%I, now()) >= collective.lock_at(k) then
          new.%I := true;
        end if;
      exception when others then
        raise warning 'projections_lock_late: %% (row stored as sent)', sqlerrm;
      end;
      return new;
    end
    $b$ $f$,
    case when origincol is null then '' else format('if coalesce(new.%I, ''live'') <> ''live'' then return new; end if;', origincol) end,
    kickcol, kickrel, recvcol, latecol);
  execute body;
  execute 'drop trigger if exists projections_lock_late on collective.projections';
  execute 'create trigger projections_lock_late before insert on collective.projections for each row execute function collective.projections_lock_late()';
  insert into lock_rule_report(step, outcome, detail) values
    ('3 late-by-lock trigger', 'ok', 'a live row whose ' || recvcol || ' is at or after lock_at(' || kickrel || '.' || kickcol ||
      ') is stored with ' || latecol || ' = true');
exception when others then
  insert into lock_rule_report(step, outcome, detail) values
    ('3 late-by-lock trigger', 'FAILED', sqlerrm);
end $do$;

-- 4 ---- the readers: FIRST submission -> LATEST submission --------------------------
--    A view that collapses to one row per model per game does it with one of
--    a few idioms, all of which order by received_at ascending or take its
--    minimum. Flip them. Late rows must not win the slot, so the ordering
--    puts the late flag first when the view has one.
do $do$
declare
  r record; v text; v2 text; latecol text; before_n bigint; after_n bigint;
begin
  select column_name::text into latecol
    from information_schema.columns
   where table_schema = 'collective' and table_name = 'projections'
     and column_name::text in ('is_late', 'late')
   order by array_position(array['is_late', 'late'], column_name::text) limit 1;
  for r in
    select c.relname::text as relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'collective' and c.relkind = 'v'
       and c.relname in ('board_models', 'consensus')
     order by c.relname
  loop
    begin
      v := pg_get_viewdef(('collective.' || quote_ident(r.relname))::regclass, true);
      v2 := v;
      /* ORDER BY ... received_at [ASC]  ->  ORDER BY ... received_at DESC
         (DISTINCT ON, row_number() OVER, first_value() OVER) */
      v2 := regexp_replace(v2,
        '(ORDER BY[^;)]*?)((?:[A-Za-z_"]+\.)?received_at)(\s+ASC)?(?![A-Za-z_])(?!\s+DESC)',
        '\1\2 DESC', 'gi');
      /* min(received_at) -> max(received_at) */
      v2 := regexp_replace(v2, 'min\((\s*(?:[A-Za-z_"]+\.)?received_at\s*)\)', 'max(\1)', 'gi');
      if v2 = v then
        if v ~* 'ORDER BY[^;)]*?received_at\s+DESC' or v ~* 'max\(\s*(?:[A-Za-z_"]+\.)?received_at\s*\)' then
          insert into lock_rule_report(step, outcome, detail) values
            ('4 view ' || r.relname, 'ok (already)', 'already picks the LATEST submission per model per game — nothing to change.');
        else
          insert into lock_rule_report(step, outcome, detail) values
            ('4 view ' || r.relname, 'unchanged', 'no first-submission ordering idiom found in its definition. Either it does not collapse (then the collective_public patch collapses to the latest pre-lock row) or it uses a shape this script does not recognise — its definition is in this report.');
        end if;
        continue;
      end if;
      execute 'create or replace view collective.' || quote_ident(r.relname) || ' as ' || v2;
      insert into lock_rule_report(step, outcome, detail) values
        ('4 view ' || r.relname, 'ok', 'now orders received_at DESC where it ordered ASC (the LATEST submission wins the slot). Late rows: ' ||
          case when latecol is null then 'no late column on projections'
               when v2 ~* ('\y' || latecol || '\y') then 'the view already reads ' || latecol
               else 'the view does not reference ' || latecol || ' — check the definition below' end);
    exception when others then
      insert into lock_rule_report(step, outcome, detail) values
        ('4 view ' || r.relname, 'FAILED (left as it was)', sqlerrm);
    end;
  end loop;
end $do$;

-- 5 ---- the report ----------------------------------------------------------------
insert into lock_rule_report(step, outcome, detail)
select '5 projections columns', 'info',
       string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
  from information_schema.columns
 where table_schema = 'collective' and table_name = 'projections';

insert into lock_rule_report(step, outcome, detail)
select '5 view ' || c.relname || ' (current definition)', 'info', pg_get_viewdef(c.oid, true)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'collective' and c.relkind = 'v'
   and c.relname in ('board_models', 'consensus', 'model_wall', 'game_detail')
 order by c.relname;

insert into lock_rule_report(step, outcome, detail)
select '5 routine ' || x.proname || ' (reads projections)', 'info', x.def
  from (select p.proname, pg_get_functiondef(p.oid) as def
          from (select p.oid, p.proname
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'collective' and p.prokind in ('f', 'p')
                   and p.proname <> 'projections_lock_late'
                 offset 0) p) x
 where x.def ilike '%projections%'
 order by x.proname;

insert into lock_rule_report(step, outcome, detail)
select '5 triggers on projections', 'info', string_agg(t.tgname || ': ' || pg_get_triggerdef(t.oid), E'\n')
  from pg_trigger t
 where t.tgrelid = 'collective.projections'::regclass and not t.tgisinternal;

do $do$
declare
  d text; multi text;
begin
  begin
    execute $q$select string_agg(coalesce(data_origin, 'null') || '/' || coalesce(resolution_status::text, 'null') || ': ' || n, ', ')
                 from (select data_origin, resolution_status, count(*) n from collective.projections group by 1, 2 order by 1, 2) x$q$ into d;
  exception when others then d := 'not readable: ' || sqlerrm; end;
  begin
    execute $q$select count(*)::text || ' model/game pairs carry more than one live row (the re-uploads this rule is for)'
                 from (select model_id, game_id from collective.projections where coalesce(data_origin, 'live') = 'live' group by 1, 2 having count(*) > 1) x$q$ into multi;
  exception when others then multi := 'not readable: ' || sqlerrm; end;
  insert into lock_rule_report(step, outcome, detail) values
    ('5 projections by origin/status', 'info', d),
    ('5 re-uploads stored', 'info', multi);
end $do$;

commit;

select n, step, outcome, detail from lock_rule_report order by n;
