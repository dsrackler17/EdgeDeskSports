-- Read-only. Find the sanctioned way to change a graded-candidate flag.
--
-- collective.projections is append-only, enforced by collective.block_mutation
-- (rule 8.3), which refused the update in 023 and told us to "use the service
-- maintenance path". Rather than guess what that path is, read it.
--
-- ONE statement, plain SQL, catalog-only. It names no column of yours and
-- writes nothing.
--
--   A  the block_mutation source - shows whether there is an escape hatch
--      (a session setting, a role check) and exactly what it looks for
--   B  the triggers on projections - what is guarded, and on which operations
--   C  every function in the collective schema, so the maintenance entry
--      point can be identified by name rather than assumed

select 'A block_mutation' as section,
       lpad(l.i::text, 5, '0') as item,
       l.ln as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral unnest(string_to_array(pg_get_functiondef(p.oid), chr(10)))
       with ordinality as l(ln, i)
where n.nspname = 'collective' and p.proname = 'block_mutation'

union all

select 'B triggers',
       t.tgname,
       pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class k on k.oid = t.tgrelid
join pg_namespace n on n.oid = k.relnamespace
where n.nspname = 'collective' and k.relname = 'projections' and not t.tgisinternal

union all

select 'C functions',
       'all in collective',
       string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                  ', ' order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'collective'

order by 1, 2;
