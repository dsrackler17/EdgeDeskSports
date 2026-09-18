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
3. `college_baseball.part1-of-6.sql` … `part6-of-6.sql`

The last part of each file prints that file's report. Every row of the
`guarantee` column must read `ok`.

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

    npm run sql:split -- supabase/mlb_pitcher_history.sql supabase/parts 20000
    npm run sql:split -- supabase/mlb_offense_history.sql supabase/parts 20000
    npm run sql:split -- supabase/college_baseball.sql   supabase/parts 20000

The part count changes as a file grows, so delete the old
`<name>.part*-of-*.sql` for that file first.

## Running the SQL is only half of it

The tables exist in Postgres once these run, but PostgREST still cannot see
them until `mlbhist` and `cbb` are added under
**Supabase → Project Settings → API → Exposed schemas**. Until then every write
comes back `PGRST106 Invalid schema: mlbhist`, and the app keeps reporting the
contract as not installed.
