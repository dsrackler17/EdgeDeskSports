# Pre-split copies of the Supabase contracts

The Supabase dashboard SQL editor does not reliably accept a paste the size of
`supabase/college_baseball.sql` (97 KB) or `supabase/mlb_pitcher_history.sql`
(47 KB); a truncated paste comes back as

    ERROR: 42601: syntax error at end of input
    LINE 0:

which is the parser reaching the end of a statement that was cut off in the
browser, not a fault in the file. These are the same files split into pieces
small enough to paste.

Run the parts IN ORDER within a file, and the files in this order:

1. `mlb_pitcher_history.part1-of-3.sql` … `part3-of-3.sql`
2. `mlb_offense_history.part1-of-4.sql` … `part4-of-4.sql`  (refuses to run
   until the pitching archive exists)
3. `college_baseball.part1-of-*.sql` … the last part

Then, on a database that already has the three above, the amendments:

4. `cbb_service_role_grants.sql` — unsplit; `college_baseball.sql` granted the
   readers everything and `service_role` nothing, so no import could write
5. `fix_promote_deletes_mlb.part1-of-*.sql` … and then
   `fix_promote_deletes_cbb.part1-of-*.sql` — Supabase loads the `safeupdate`
   guard for the roles PostgREST connects as, which refuses a `DELETE` with no
   `WHERE`; every promote cleared its live table with a bare one

Independent of all of the above, the CFB Live Model Lab:

6. `cfb_lab.part1-of-*.sql` … the last part (then `cfb_lab_cron.sql`, unsplit,
   if the hourly poke is wanted)
7. `cfb_weekly.part1-of-*.sql` … the last part (the CFB weekly learning and
   rating refresh engine: run table, state tables and its pg_cron dispatch;
   independent of `cfb_lab`)

Independent of all of the above, the CFB + NFL player-prop factory:

8. `props_factory.part1-of-*.sql` … the last part, then `expose_schemas.sql`
   (unsplit) so PostgREST serves the `props` schema

Independent of all of the above, the Portfolio (the reader's own bets and
prediction-market positions; `docs/portfolio-architecture.md`):

9. `portfolio.part1-of-*.sql` … the last part. Every report row
   should read `ok`. Do **not** add `portfolio_private` to the exposed schemas:
   it holds connector credentials and is meant to stay unreachable. Prefer the
   *Deploy Portfolio schema* workflow, which applies the whole file in one
   transaction. Regenerate with `npm run portfolio:parts`; the SQL suite fails
   if these parts drift from `supabase/portfolio.sql`.

The last part of each file prints that file's report. Every row of the
`guarantee` column must read `ok` (for `cfb_lab`, every row of `status`).

Nothing is cut in the middle of a statement: the splitter tracks line comments,
nested block comments, quoted strings, quoted identifiers and dollar-quoted
function bodies, and only breaks at a top-level `;`. It also proves the
statements it emits concatenate back to the source byte for byte before it
writes anything.

Prefer `psql` if you have it — it has no size limit and needs no splitting.
Take the connection string from Supabase → Connect → Session pooler:

    psql "$SUPABASE_DB_URL" -f supabase/mlb_pitcher_history.sql

## Regenerating

These are generated. After editing any of the three source files, rebuild with:

    npm run sql:split -- supabase/mlb_pitcher_history.sql supabase/parts 18000
    npm run sql:split -- supabase/mlb_offense_history.sql supabase/parts 18000
    npm run sql:split -- supabase/college_baseball.sql   supabase/parts 18000
    npm run sql:split -- supabase/fix_promote_deletes_mlb.sql supabase/parts 18000
    npm run sql:split -- supabase/fix_promote_deletes_cbb.sql supabase/parts 18000
    npm run sql:split -- supabase/cfb_lab.sql            supabase/parts 18000
    npm run sql:split -- supabase/cfb_weekly.sql         supabase/parts 18000
    npm run portfolio:parts

The part count changes as a file grows, so delete the old
`<name>.part*-of-*.sql` for that file first.

## Running the SQL is only half of it

The tables exist in Postgres once these run, but PostgREST still cannot see
them until `mlbhist` and `cbb` are added under
**Supabase → Project Settings → API → Exposed schemas**. Until then every write
comes back `PGRST106 Invalid schema: mlbhist`, and the app keeps reporting the
contract as not installed.
