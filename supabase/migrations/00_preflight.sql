-- ===========================================================================
-- PREFLIGHT — read-only. Run this FIRST, in the Supabase SQL editor, and keep
-- the output. It changes nothing.
--
-- Why it exists: the Edge Functions and SQL for this project are not in this
-- repository (football/INTEGRATION.md says so), so the exact column names on
-- collective.projections cannot be read from here. Everything the supersede
-- migration needs beyond the table name is confirmed by this script rather
-- than guessed at, because a migration that guesses a column name against a
-- live projections table is how you lose a season of picks.
--
-- Run all five blocks. Paste the output back and 01_supersede.sql can be
-- completed exactly, with no placeholders left in it.
-- ===========================================================================

-- 1 ---- the table's real shape ---------------------------------------------
--    Confirms: the primary key column and its TYPE (the supersede function's
--    signature depends on it), and which of the columns the client already
--    evidences -- received_at, data_origin, late, movement_n -- are real
--    columns rather than things the API computes on the way out.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'collective'
   and table_name   = 'projections'
 order by ordinal_position;

-- 2 ---- the primary key, and how a row points at its model and its game ----
--    The reader's "first pre-kickoff submission per model per game" rule is
--    an index on exactly these columns, so their real names decide it.
select tc.constraint_type,
       tc.constraint_name,
       kcu.column_name,
       kcu.ordinal_position
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name
   and kcu.table_schema    = tc.table_schema
 where tc.table_schema = 'collective'
   and tc.table_name   = 'projections'
   and tc.constraint_type in ('PRIMARY KEY','FOREIGN KEY','UNIQUE')
 order by tc.constraint_type, tc.constraint_name, kcu.ordinal_position;

-- 3 ---- the append-only trigger, in its own words -------------------------
--    It raises P0001 on DELETE. What matters for supersede is whether it also
--    fires on UPDATE: if it does, marking a row superseded is refused by the
--    same rule that refuses deleting it, and the function in 01 has to be the
--    carve-out rather than an ordinary update.
select t.tgname,
       pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'collective'
   and c.relname = 'projections'
   and not t.tgisinternal;

-- 4 ---- what already reads projections ------------------------------------
--    Every view and function naming this table is a place the "ignore
--    superseded rows" predicate may also have to be added. Grading, the games
--    feed, consensus and the coverage counts are the four that matter.
select n.nspname   as schema,
       p.proname   as routine,
       p.prokind   as kind          -- 'f' function, 'p' procedure
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('collective','public')
   and pg_get_functiondef(p.oid) ilike '%projections%'
 order by 1, 2;

select schemaname, viewname
  from pg_views
 where definition ilike '%projections%'
 order by 1, 2;

-- 5 ---- how big is the problem, right now ---------------------------------
--    Counts only. How many games already carry more than one live pre-kickoff
--    submission from the same model -- i.e. how many rows a supersede feature
--    would have anything to say about. Replace the two >>>NAMES<<< with the
--    model and game columns block 2 just named, or skip this block; it is
--    diagnostic, not required.
--
-- select count(*) as games_with_revisions
--   from (
--     select >>>MODEL_COL<<<, >>>GAME_COL<<<
--       from collective.projections
--      where coalesce(data_origin,'live') = 'live'
--        and coalesce(late,false) = false
--      group by 1,2
--     having count(*) > 1
--   ) x;

-- 6 ---- the config table, for the lock ------------------------------------
--    01_lock_rule.sql adds one key, submission.lock_minutes, to the same
--    table admin.user_ids and econ.founder_count already live in. Its column
--    names and the value column's type decide how that insert is written.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'collective'
   and table_name   = 'config'
 order by ordinal_position;

select * from collective.config
 where >>>CONFIG_KEY_COL<<< in ('admin.user_ids', 'econ.founder_count', 'embed.upcoming_per_sport');

-- 7 ---- the games table's kickoff column and primary key ------------------
--    The lock is computed from kickoff, so every reader joins projections to
--    games on these two names.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'collective'
   and table_name   = 'games'
   and (column_name ilike '%kick%' or column_name ilike '%start%' or column_name ilike '%id')
 order by ordinal_position;
