-- Read-only schema readout. Run this whole file and paste the output.
--
-- Every query here reads system catalogs only. It references no column of
-- yours by name, so it cannot fail the way the last two attempts did
-- ("column p.game_ref does not exist"). It writes nothing.
--
-- The output is what is needed to write the actual fixes: which columns the
-- projections table really has, how board_models chooses the single row it
-- serves per model and game, and the exact coherence check inside
-- ingest_submission.

\echo '=== A. columns, per table ==='
select table_name,
       string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as columns
from information_schema.columns
where table_schema = 'collective'
  and table_name in ('projections','submissions','games','board_models',
                     'game_detail','consensus','models','creators')
group by table_name
order by table_name;

\echo '=== B. how board_models picks its row (look at the ORDER BY) ==='
select pg_get_viewdef(c.oid, true) as board_models_definition
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'collective' and c.relname = 'board_models';

\echo '=== C. the spread/probability check inside ingest_submission ==='
select l.i as line_no, l.ln as source
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral unnest(string_to_array(pg_get_functiondef(p.oid), chr(10)))
       with ordinality as l(ln, i)
where n.nspname = 'collective'
  and p.proname = 'ingest_submission'
  and (l.ln ilike '%prob%' or l.ln ilike '%0.025%' or l.ln ilike '%contradict%')
order by l.i;
