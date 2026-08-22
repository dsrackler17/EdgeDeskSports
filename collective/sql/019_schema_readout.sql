-- Read-only schema readout. Paste this whole thing into the Supabase SQL
-- Editor and paste the result back.
--
-- ONE statement, plain SQL. No psql meta-commands: the last version opened
-- its sections with a client-only directive that the SQL Editor rejects.
-- It reads system catalogs only and names no column of the collective schema,
-- so it cannot fail on a column that does not exist. It writes nothing.
--
-- Three sections come back in one grid:
--   A  the real columns on the tables involved
--   B  the board_models definition - its ORDER BY is the line that decides
--      which single row per model and game the wall renders
--   C  the spread/probability check inside ingest_submission

select 'A columns'   as section,
       c.table_name  as item,
       string_agg(c.column_name || ' ' || c.data_type, ', ' order by c.ordinal_position) as detail
from information_schema.columns c
where c.table_schema = 'collective'
  and c.table_name in ('projections','submissions','games','board_models',
                       'game_detail','consensus','models','creators')
group by c.table_name

union all

select 'B board_models',
       'definition',
       pg_get_viewdef(k.oid, true)
from pg_class k
join pg_namespace n on n.oid = k.relnamespace
where n.nspname = 'collective' and k.relname = 'board_models'

union all

select 'C ingest check',
       lpad(l.i::text, 5, '0'),
       l.ln
from pg_proc p
join pg_namespace n2 on n2.oid = p.pronamespace
cross join lateral unnest(string_to_array(pg_get_functiondef(p.oid), chr(10)))
       with ordinality as l(ln, i)
where n2.nspname = 'collective'
  and p.proname = 'ingest_submission'
  and (l.ln ilike '%prob%' or l.ln ilike '%0.025%' or l.ln ilike '%contradict%')

order by 1, 2;
