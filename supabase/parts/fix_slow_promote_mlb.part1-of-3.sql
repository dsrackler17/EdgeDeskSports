-- fix_slow_promote_mlb -- part 1 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ===========================================================================
   THE OFFENSIVE PROMOTE NEEDED 47 SECONDS AND POSTGREST STOPPED IT AT 36.

   Every scheduled run of the MLB refresh from 2026-10-06 rebuilt the
   offensive dataset, validated it, staged all of it — 10,849 batter-seasons,
   11,868 player-team rows — and then died in the gate, 36 seconds in:

     RPC mlbhist.promote_offense_import -> 500: {"code":"57014",
       "message":"canceling statement due to statement timeout"}

   The pitching gate beside it promotes the same night in 3.5 seconds.

   NOT A SIZING PROBLEM, AND NOT A TIMEOUT TO RAISE. The two gates do the same
   linear work; the offensive one has one statement the pitching one does not,
   the GRAIN check, and that statement was the whole 47 seconds. Raising the
   timeout would not have fixed it — a function's own SET statement_timeout
   does not extend the request PostgREST is already timing — and the work grows
   with the square of the archive, so the wall would only have moved.

   THE CAUSE. The grain check joined the staged seasons to an aggregate of the
   staged splits. How long that takes depends on what the planner believes
   staging holds, and staging is the table whose statistics are least likely
   to be right: it is bulk-filled and bulk-emptied, so they describe an
   earlier import, or an empty table, and rarely the one being promoted. Told
   to expect one row a side, the planner chose a nested loop and re-ran the
   aggregate once per player-season. Against a local PostgreSQL 16 holding
   the committed 2016–2025 dataset, with staging's statistics as a run leaves
   them:

     Nested Loop  (rows=1)  (actual rows=0 loops=1)
       Rows Removed by Join Filter: 101,969,604      -- 10,098 squared
       ->  Index Scan on stg_batter_seasons  (rows=1)  (actual rows=10,098)
       ->  GroupAggregate  (rows=1)  (actual rows=10,098 loops=10,098)

   And the whole gate, timed at production's volume (10,863 batter-seasons and
   11,883 splits: the package plus a 2026 cloned from 2025), by what staging's
   statistics described when it was called:

     staging's statistics described               before      after
     only an earlier import that never promoted   46,863 ms   1,811 ms
     the empty table the last promote left        46,981 ms     955 ms
     this import (autovacuum got there first)      1,124 ms   1,239 ms
     nothing (never gathered)                        781 ms   1,657 ms

   Production gave up at 36 s: that is where its statement timeout fell, not
   where the work ended. And that plan's work grows with the SQUARE of the
   archive — every in-season night adds player-seasons to both sides of the
   loop.

   No index fixes this. Staging is already indexed on import_id, and both
   scans in the plan above use it; the cost is the loop around them.

   A FAILED RUN THEN KEPT IT FAILING. A gate cancelled by a timeout rolls back,
   so its staged rows stay — and tools/mlb/refresh_offense.js never abandoned
   a failed import (it does now). Each night left about 40,000 more rows under
   an import id that can never be promoted, staging's statistics came to
   describe those dead imports, and whenever the next night's promote reached
   the planner before autovacuum reached staging, the estimate was one row
   again — the first row of the table above.

   THE FIX. The same question asked without a join: stack the two grains and
   group once. A key counts only when it has a combined row AND at least one
   split — exactly what the inner join kept — and the duplicate check before it
   has already proved the combined row unique, so the count is the same count.
   There is no plan to get wrong: whatever staging's statistics say, it is one
   sort of about 21,000 rows. The grain check alone, on the same misestimated
   staging: 58,832 ms under EXPLAIN ANALYZE before, 28 ms after.

   AND IT IS THE SAME ANSWER, not a faster different one. Both forms were run
   against the same staged import in seven cases — untouched; combined
   rows off by one; one split of a traded player off by three; null PA against
   zero and null splits; non-zero splits nulled; mismatches with orphans on
   both sides; another import's rows mutated — and agreed every time, on counts
   of 0, 25, 40, 0, 1,253, 313 and 0 rather than a column of zeros that would
   agree trivially.

   STILL ONE TRANSACTION. Nothing about the gate's shape changed: one call,
   every refusal before any live row moves, and a gate that fails for any
   reason leaves the previously promoted dataset exactly where it was. The
   gate was not split into several calls to fit the timeout, because once the
   quadratic statement is gone it does not need to be.

   PROVED, NOT REASONED. tools/mlb/offense_import.test.js puts a database in
   exactly this state — a cancelled import's rows left in staging and
   analyzed, the next import staged on top — checks that the planner really
   does expect one row, and calls the gate through the shipped importer under
   a 10 s statement timeout. Against the previous gate it fails with this same
   57014; against this one it promotes.

   Also here: the staged rows the timed-out runs left behind are cleared (see
   below), because they are what kept the estimate wrong night after night.

   HOW TO APPLY. psql against the Session pooler connection string:

       psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/fix_slow_promote_mlb.sql

   or paste supabase/parts/fix_slow_promote_mlb.part1-of-*.sql and the parts
   after it, in order, into the SQL editor. Every row of the report the last
   part prints must read ok. Then re-run the "MLB historical archives" workflow
   by hand (Run workflow, commit checked).

   Safe to run more than once. It replaces one function, re-states its grants
   and clears only staging that belongs to an offensive import that never
   promoted and was opened more than six hours ago. No live table is written.
   =========================================================================== */

-- This amends the offensive contract; it cannot stand in for it.
do $$
begin
  if to_regclass('mlbhist.stg_batter_seasons') is null
     or to_regprocedure('mlbhist.abandon_offense_import(text,text)') is null then
    raise exception 'the offensive archive is not installed — run supabase/mlb_offense_history.sql first';
  end if;
end $$;
