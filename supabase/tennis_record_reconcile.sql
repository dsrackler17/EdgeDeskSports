-- ===========================================================================
-- EdgeDesk Tennis — RECONCILE A PRE-CONTRACT SCHEMA WITH THE RECORD CONTRACT.
--
-- WHY THIS FILE EXISTS.
--
-- supabase/tennis_record.sql is idempotent over a database whose tables IT
-- created. It is not idempotent over a database that already carries an
-- EARLIER draft of the same names, and production did:
--
--     tennis.players           player_id, tour, full_name, country, plays,
--                              height_cm, birth_date, source_key, retrieved_at
--     tennis.matches           match_id, tour, match_date, season, tourney_id,
--                              tourney_name, surface, level, round, best_of, ...
--     tennis.rankings_current  a VIEW, over an older tennis.rankings table
--
-- `create table if not exists` skips a name that is taken, whatever shape is
-- behind it, and the next statement is an index that assumes the columns the
-- file would have created. So an apply against production stopped at
--
--     NOTICE:  relation "players" already exists, skipping
--     ERROR:   column "name_norm" does not exist
--
-- and, because psql runs a -f script statement by statement, everything above
-- that line had already committed. The database was left further in than it
-- started and still broken. Re-running gets to the same line and stops again.
--
-- WHAT THIS FILE DOES. It removes ONLY the relations that are in the way:
-- a name the contract needs as a table that is held by something else, or a
-- table carrying the earlier draft's columns instead of this contract's. Then
-- supabase/tennis_record.sql is applied again and creates them properly.
--
-- WHAT IT WILL NOT DO, and this is the point of writing it as a file rather
-- than as three DROPs typed into a console:
--
--   * It refuses to drop a table that holds a single row. If one does, it
--     RAISES and nothing is dropped — the rows are someone's decision, not
--     this file's.
--   * It refuses to drop a table any VIEW depends on, and names the views.
--   * It leaves a table alone once it carries the contract's own columns, so
--     running this after tennis_record.sql has succeeded is a no-op. It is
--     safe to leave in the deploy workflow and safe to run twice.
--   * It touches nothing in the live centre. tennis.live_matches,
--     tennis.player_directory, tennis.player_baselines, tennis.match_* and
--     tennis.tournaments are not named here. tennis.tournaments in particular
--     is the live centre's table and tennis_record.sql brings it up to the
--     contract with `alter table ... add column if not exists`, which is why
--     it must NOT be dropped.
--   * It leaves tennis.rankings and tennis.sources alone. They are the older
--     draft's names, the contract does not use them, so they are not in the
--     way of anything. Superseded is not the same as blocking.
--
-- RUN IT FROM Deploy intelligence, BEFORE apply_tennis_record, once. After
-- that it will report that there is nothing to reconcile.
-- ===========================================================================

do $$
declare
  r      record;
  n      bigint;
  k      "char";
  deps   text;
  did    int := 0;
begin
  -- ---- 1. a name the contract needs as a TABLE, held by something else ----
  for r in
    select * from (values
      ('rankings_current'), ('players'), ('matches'), ('venues'),
      ('player_match_features'), ('player_ratings_current'), ('weather_observations'),
      ('odds_snapshots'), ('model_registry'), ('model_predictions'),
      ('research_opportunities'), ('prediction_record'), ('source_licenses'),
      ('ingestion_runs'), ('data_quality_issues'), ('stg_archive_matches')
    ) as v(tbl)
  loop
    if to_regclass('tennis.' || r.tbl) is null then continue; end if;
    select c.relkind into k from pg_class c where c.oid = to_regclass('tennis.' || r.tbl);
    if k = 'r' then continue; end if;           -- an ordinary table: handled below
    if k = 'v' then
      execute format('drop view tennis.%I', r.tbl);
      raise notice 'dropped the pre-contract VIEW tennis.% — the contract needs a table of that name', r.tbl;
      did := did + 1;
    else
      raise exception 'tennis.% is a % and the record contract needs an ordinary table of that name. '
                      'Nothing has been dropped. Remove or rename it by hand and run this again.',
                      r.tbl, case k when 'm' then 'materialized view' when 'f' then 'foreign table'
                                    when 'p' then 'partitioned table' else k::text end;
    end if;
  end loop;

  -- ---- 2. a table carrying the EARLIER draft's columns --------------------
  -- The sentinel is a column this contract's own indexes stand on. Its absence
  -- is what makes the apply stop; its presence means the table is already this
  -- contract's and must be left exactly as it is.
  for r in
    select * from (values
      ('players', 'name_norm'),
      ('matches', 'source_match_uid')
    ) as v(tbl, sentinel)
  loop
    if to_regclass('tennis.' || r.tbl) is null then continue; end if;
    select c.relkind into k from pg_class c where c.oid = to_regclass('tennis.' || r.tbl);
    if k <> 'r' then continue; end if;

    if exists (select 1 from pg_attribute a
               where a.attrelid = to_regclass('tennis.' || r.tbl)
                 and a.attname = r.sentinel and a.attnum > 0 and not a.attisdropped) then
      raise notice 'tennis.% already carries this contract''s columns — left exactly as it is', r.tbl;
      continue;
    end if;

    -- ROWS ARE NOT THIS FILE'S TO THROW AWAY.
    execute format('select count(*) from tennis.%I', r.tbl) into n;
    if n > 0 then
      raise exception 'tennis.% predates the record contract AND holds % row(s). Nothing has been '
                      'dropped. Those rows have to be moved or migrated by a person before this '
                      'contract can own the name.', r.tbl, n;
    end if;

    -- NOR IS ANYTHING BUILT ON TOP OF IT.
    select string_agg(distinct dv.relname, ', ') into deps
    from pg_depend d
      join pg_rewrite rw on rw.oid = d.objid
      join pg_class  dv  on dv.oid = rw.ev_class
    where d.refobjid = to_regclass('tennis.' || r.tbl)
      and d.classid = 'pg_rewrite'::regclass
      and dv.oid <> to_regclass('tennis.' || r.tbl);
    if deps is not null then
      raise exception 'tennis.% predates the record contract but % depends on it. Nothing has been '
                      'dropped. Remove or repoint those first.', r.tbl, deps;
    end if;

    execute format('drop table tennis.%I cascade', r.tbl);
    raise notice 'dropped the EMPTY pre-contract table tennis.% — tennis_record.sql will create it properly', r.tbl;
    did := did + 1;
  end loop;

  if did = 0 then
    raise notice 'nothing to reconcile: no pre-contract relation is standing in this contract''s way';
  else
    raise notice '% relation(s) reconciled. Apply supabase/tennis_record.sql next.', did;
  end if;
end $$;

-- The last statement is a report, as every other file in this directory ends
-- with one: what is now in the way, if anything.
select 'tennis.' || t as relation,
       case
         when to_regclass('tennis.' || t) is null then 'absent — tennis_record.sql will create it'
         when (select c.relkind from pg_class c where c.oid = to_regclass('tennis.' || t)) <> 'r'
           then 'STILL IN THE WAY — not an ordinary table'
         else 'ok — an ordinary table'
       end as state
from unnest(array['players', 'matches', 'rankings_current', 'venues',
                  'player_match_features', 'player_ratings_current', 'source_licenses',
                  'ingestion_runs', 'data_quality_issues', 'stg_archive_matches',
                  'weather_observations', 'odds_snapshots', 'model_registry',
                  'model_predictions', 'research_opportunities', 'prediction_record']) t
order by 1;
