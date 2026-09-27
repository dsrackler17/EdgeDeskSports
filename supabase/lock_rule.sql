-- ===========================================================================
-- THE LOCK RULE — one paste, no placeholders. Safe to run again.
--
-- Every game locks 30 minutes before kickoff. Each model's LATEST live
-- submission received before the lock is the one that counts: the board, the
-- consensus, the grader and the record all read the row that carries
-- is_graded_candidate, so this moves that flag to the newest pre-lock row.
-- Earlier submissions stay stored (nothing is deleted). A submission received
-- at or after the lock is stored with is_late = true and never counts.
--
--   1. collective.lock_minutes() / collective.lock_at(kickoff)
--   2. config key submission.lock_minutes = 30
--   3. trigger on projections: a live row arriving before the lock takes the
--      is_graded_candidate slot from the row that held it (through the
--      maintenance switch the append-only trigger already honours); a row
--      arriving at or after the lock is stored late. Fails open.
--   4. backfill for games that have NOT kicked off yet: the newest pre-lock
--      row becomes the candidate, rows inside the lock window become late.
--      Games already kicked off keep the grade they have.
--   5. ingest_submission and admin_resolve_quarantine decide "late" by the
--      lock instead of by kickoff (their own definitions, one line each).
--   6. any view that still orders by first submission is flipped to latest.
--   7. the report.
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
    ('0 sanity', 'ok', 'collective.projections found; is_graded_candidate ' ||
      case when exists (select 1 from information_schema.columns where table_schema = 'collective' and table_name = 'projections' and column_name = 'is_graded_candidate')
           then 'found' else 'NOT found' end ||
      '; board_models ' || case when to_regclass('collective.board_models') is null then 'NOT found' else 'found' end);
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
values ('1 helpers', 'ok', 'collective.lock_minutes() and collective.lock_at(kickoff) in place');

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
    ('2 config key', 'ok', 'submission.lock_minutes present in collective.config; collective.lock_minutes() reads ' || collective.lock_minutes());
exception when others then
  insert into lock_rule_report(step, outcome, detail) values
    ('2 config key', 'skipped', 'could not write the key (' || sqlerrm || '); the lock stays at the 30-minute default');
end $do$;

-- 3 ---- the trigger: the newest pre-lock live row holds the slot -----------------
do $do$
declare
  has_late boolean; has_status boolean;
begin
  select bool_or(column_name = 'is_late'), bool_or(column_name = 'resolution_status')
    into has_late, has_status
    from information_schema.columns where table_schema = 'collective' and table_name = 'projections';
  if not coalesce(has_late, false) then
    insert into lock_rule_report(step, outcome, detail) values
      ('3 lock trigger', 'skipped', 'projections has no is_late column; nothing to set');
    return;
  end if;

  create or replace function collective.projections_lock_rule()
  returns trigger
  language plpgsql
  security definer
  set search_path = collective, public
  as $b$
  declare
    k timestamptz;
    prev_id uuid;
    prev_at timestamptz;
  begin
    /* FAILS OPEN. Anything unexpected here must not cost a creator their
       slate: the row is stored exactly as the ingest sent it. */
    begin
      if new.game_id is null then return new; end if;
      if new.data_origin::text <> 'live' then return new; end if;
      if new.resolution_status::text <> 'resolved' then return new; end if;
      select kickoff_at into k from collective.games where id = new.game_id;
      if k is null then return new; end if;

      if coalesce(new.received_at, now()) >= collective.lock_at(k) then
        /* at or after the lock: stored, late, never the counting row */
        new.is_late := true;
        new.is_graded_candidate := false;
        return new;
      end if;
      if coalesce(new.is_late, false) then return new; end if;

      /* before the lock: this is the newest live row on the game, so it
         takes the slot from whichever row held it. The old row stays
         stored as movement. The update goes through the maintenance
         switch the append-only trigger already honours. */
      select id, received_at into prev_id, prev_at
        from collective.projections
       where model_id = new.model_id and game_id = new.game_id
         and is_graded_candidate and id <> new.id
       limit 1;
      if prev_id is null then
        new.is_graded_candidate := true;
      elsif prev_at <= coalesce(new.received_at, now()) then
        perform set_config('collective.maintenance', 'on', true);
        update collective.projections set is_graded_candidate = false where id = prev_id;
        perform set_config('collective.maintenance', '', true);
        new.is_graded_candidate := true;
      end if;
    exception when others then
      raise warning 'projections_lock_rule: % (row stored as sent)', sqlerrm;
    end;
    return new;
  end
  $b$;

  execute 'drop trigger if exists projections_lock_late on collective.projections';
  execute 'drop function if exists collective.projections_lock_late()';
  execute 'drop trigger if exists projections_lock_rule on collective.projections';
  execute 'create trigger projections_lock_rule before insert on collective.projections for each row execute function collective.projections_lock_rule()';
  /* a quarantined row that an admin resolves later is an insert in all but
     name: it gets the same rule. This only fires when the resolution
     changes, so the flag update above never re-enters it. */
  execute 'drop trigger if exists projections_lock_rule_upd on collective.projections';
  if coalesce(has_status, false) then
    execute $t$create trigger projections_lock_rule_upd before update of resolution_status, game_id on collective.projections
      for each row when (new.resolution_status::text = 'resolved' and (old.resolution_status::text is distinct from 'resolved' or old.game_id is distinct from new.game_id))
      execute function collective.projections_lock_rule()$t$;
  end if;
  insert into lock_rule_report(step, outcome, detail) values
    ('3 lock trigger', 'ok', 'projections_lock_rule installed (insert' || case when coalesce(has_status, false) then ' + quarantine resolve' else '' end ||
      '): a live row received before lock_at(kickoff) takes is_graded_candidate; at or after it is stored is_late');
exception when others then
  insert into lock_rule_report(step, outcome, detail) values
    ('3 lock trigger', 'FAILED', sqlerrm);
end $do$;

-- 4 ---- backfill: games that have not kicked off yet ------------------------------
do $do$
declare
  r record; chosen uuid; n_pairs int := 0; n_moved int := 0; n_late int := 0; k int;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'collective' and table_name = 'projections' and column_name = 'is_graded_candidate') then
    insert into lock_rule_report(step, outcome, detail) values ('4 backfill', 'skipped', 'no is_graded_candidate column');
    return;
  end if;
  perform set_config('collective.maintenance', 'on', true);
  for r in
    select p.model_id, p.game_id, collective.lock_at(g.kickoff_at) as lk
      from collective.projections p
      join collective.games g on g.id = p.game_id
     where g.kickoff_at > now()
       and p.data_origin::text = 'live' and p.resolution_status::text = 'resolved'
     group by p.model_id, p.game_id, g.kickoff_at
  loop
    n_pairs := n_pairs + 1;
    /* rows inside the lock window are late and never the counting row */
    update collective.projections
       set is_late = true, is_graded_candidate = false
     where model_id = r.model_id and game_id = r.game_id
       and data_origin::text = 'live' and resolution_status::text = 'resolved'
       and received_at >= r.lk and (not coalesce(is_late, false) or is_graded_candidate);
    get diagnostics k = row_count;
    n_late := n_late + k;
    /* the newest pre-lock row is the counting row */
    select id into chosen
      from collective.projections
     where model_id = r.model_id and game_id = r.game_id
       and data_origin::text = 'live' and resolution_status::text = 'resolved'
       and received_at < r.lk and not coalesce(is_late, false)
     order by received_at desc limit 1;
    if chosen is not null and not exists (select 1 from collective.projections where id = chosen and is_graded_candidate) then
      update collective.projections set is_graded_candidate = false
       where model_id = r.model_id and game_id = r.game_id and is_graded_candidate;
      update collective.projections set is_graded_candidate = true where id = chosen;
      n_moved := n_moved + 1;
    end if;
  end loop;
  perform set_config('collective.maintenance', '', true);
  insert into lock_rule_report(step, outcome, detail) values
    ('4 backfill', 'ok', n_pairs || ' model/game pairs on games not yet kicked off; the counting row moved to the latest pre-lock upload on ' ||
      n_moved || ' of them; ' || n_late || ' rows inside the lock window marked late. Games already kicked off keep the grade they have.');
exception when others then
  perform set_config('collective.maintenance', '', true);
  insert into lock_rule_report(step, outcome, detail) values ('4 backfill', 'FAILED (nothing changed)', sqlerrm);
end $do$;

-- 5 ---- the ingest and the admin resolve decide "late" by the lock -----------------
do $do$
declare
  def text; def2 text; oid_ oid; hits int := 0;
begin
  for oid_ in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'collective' and p.proname in ('ingest_submission', 'admin_resolve_quarantine') and p.prokind = 'f'
  loop
    def := pg_get_functiondef(oid_);
    def2 := def;
    def2 := replace(def2, 'select v_received > g.kickoff_at into v_late', 'select v_received >= collective.lock_at(g.kickoff_at) into v_late');
    def2 := replace(def2, 'v_late := p.received_at > v_kick;', 'v_late := p.received_at >= collective.lock_at(v_kick);');
    if def2 <> def then
      execute def2;
      hits := hits + 1;
    end if;
  end loop;
  insert into lock_rule_report(step, outcome, detail) values
    ('5 late by the lock in the routines', case when hits > 0 then 'ok' else 'ok (already)' end,
     hits || ' routine(s) changed: ingest_submission counts a row inside the lock window as late (it is stored late by the trigger either way), admin_resolve_quarantine likewise');
exception when others then
  insert into lock_rule_report(step, outcome, detail) values ('5 late by the lock in the routines', 'FAILED (routines unchanged)', sqlerrm);
end $do$;

-- 6 ---- any view still ordering by FIRST submission ----------------------------------
do $do$
declare
  r record; v text; v2 text;
begin
  for r in
    select c.relname::text as relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'collective' and c.relkind = 'v'
       and c.relname in ('board_models', 'consensus', 'first_submissions', 'model_records', 'model_coverage_totals')
     order by c.relname
  loop
    begin
      v := pg_get_viewdef(('collective.' || quote_ident(r.relname))::regclass, true);
      v2 := regexp_replace(v,
        '(ORDER BY[^;)]*?)((?:[A-Za-z_"]+\.)?received_at)(\s+ASC)?(?![A-Za-z_])(?!\s+DESC)',
        '\1\2 DESC', 'gi');
      v2 := regexp_replace(v2, 'min\((\s*(?:[A-Za-z_"]+\.)?received_at\s*)\)', 'max(\1)', 'gi');
      if v2 = v then
        insert into lock_rule_report(step, outcome, detail) values
          ('6 view ' || r.relname, 'ok', case when v ~* 'is_graded_candidate' then 'reads is_graded_candidate — follows the flag, nothing to change'
                                              else 'has no first-submission ordering; nothing to change' end);
        continue;
      end if;
      execute 'create or replace view collective.' || quote_ident(r.relname) || ' as ' || v2;
      insert into lock_rule_report(step, outcome, detail) values
        ('6 view ' || r.relname, 'ok', 'ordered by first submission; now orders by latest');
    exception when others then
      insert into lock_rule_report(step, outcome, detail) values
        ('6 view ' || r.relname, 'FAILED (left as it was)', sqlerrm);
    end;
  end loop;
end $do$;

-- 7 ---- the report ----------------------------------------------------------------
insert into lock_rule_report(step, outcome, detail)
select '7 view ' || c.relname || ' (current definition)', 'info', pg_get_viewdef(c.oid, true)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'collective' and c.relkind = 'v'
   and c.relname in ('first_submissions', 'model_records', 'model_coverage_totals')
 order by c.relname;

insert into lock_rule_report(step, outcome, detail)
select '7 routine ' || x.proname, 'info', x.def
  from (select p.proname, pg_get_functiondef(p.oid) as def
          from (select p.oid, p.proname
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'collective' and p.prokind in ('f', 'p')
                   and p.proname in ('block_mutation', 'projections_lock_rule')
                 offset 0) p) x
 order by x.proname;

insert into lock_rule_report(step, outcome, detail)
select '7 triggers on projections', 'info', string_agg(t.tgname || ': ' || pg_get_triggerdef(t.oid), E'\n')
  from pg_trigger t
 where t.tgrelid = 'collective.projections'::regclass and not t.tgisinternal;

do $do$
declare
  d text; multi text; cand text;
begin
  begin
    execute $q$select string_agg(coalesce(data_origin::text, 'null') || '/' || coalesce(resolution_status::text, 'null') || ': ' || n, ', ')
                 from (select data_origin, resolution_status, count(*) n from collective.projections group by 1, 2 order by 1, 2) x$q$ into d;
  exception when others then d := 'not readable: ' || sqlerrm; end;
  begin
    execute $q$select count(*)::text || ' model/game pairs carry more than one live row'
                 from (select model_id, game_id from collective.projections where data_origin::text = 'live' group by 1, 2 having count(*) > 1) x$q$ into multi;
  exception when others then multi := 'not readable: ' || sqlerrm; end;
  begin
    execute $q$select count(*)::text || ' of those pairs on games not yet kicked off now count their NEWEST pre-lock row'
                 from (select p.model_id, p.game_id
                         from collective.projections p join collective.games g on g.id = p.game_id
                        where g.kickoff_at > now() and p.data_origin::text = 'live' and p.resolution_status::text = 'resolved'
                        group by 1, 2 having count(*) > 1
                           and bool_or(p.is_graded_candidate and p.received_at = (select max(px.received_at) from collective.projections px
                                 where px.model_id = p.model_id and px.game_id = p.game_id and px.data_origin::text = 'live'
                                   and px.resolution_status::text = 'resolved' and not coalesce(px.is_late, false)))) x$q$ into cand;
  exception when others then cand := 'not readable: ' || sqlerrm; end;
  insert into lock_rule_report(step, outcome, detail) values
    ('7 projections by origin/status', 'info', d),
    ('7 re-uploads stored', 'info', multi),
    ('7 re-uploads now counting', 'info', cand);
end $do$;

commit;

select n, step, outcome, detail from lock_rule_report order by n;
