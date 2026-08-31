# Server-side change set: making a correction actually correct

The Edge Functions and SQL for this project live in the Supabase project
(`iattxbkbufslbauoumga`) and are **not** in this repository — `football/INTEGRATION.md`
has said so from the start. This directory is not a deployable Supabase project.
It is the change set for the one server-side gap the client cannot close,
written down and version-controlled so it is reviewable, applied deliberately,
and not lost in a chat log.

## The problem it closes

`collective.projections` is append-only in the database. A trigger refuses any
`DELETE`:

```
P0001  collective.projections is append-only (rule 8.3); use the service maintenance path
```

`collective_ingest`'s `/v1/projections/retract` issues an ordinary PostgREST
`DELETE`, so it has never once succeeded against this database. The consequence
a creator sees is that a corrected slate is stored as movement and the wall
keeps the number it already had — for good.

## What it does not do

It does **not** turn re-uploading into open replacement.

Creators can read each other's numbers before kickoff. That is the entire
reason the first pre-kickoff submission is the graded one, and it is the reason
the record is worth anything. If any number could be revised after seeing the
others, the record stops being evidence of a model and starts being evidence of
patience.

So supersede is bounded:

* a **creator** may supersede their own row inside a correction window
  (30 minutes, one constant in `01_supersede.sql`) — enough to fix a slate they
  have just noticed was mapped wrong, and nothing else;
* an **admin** may supersede any pre-kickoff row through the maintenance path,
  which is what the trigger's own error message has always pointed at;
* **nobody** may supersede anything once the game has kicked off.

Widening the window to `infinity` is one line and gives open replacement. It is
a decision about what the record claims, not a technical one.

Nothing is ever deleted. A superseded row stays in the table, stays auditable,
and stops counting — so the store is still genuinely append-only and no delete
privilege is needed anywhere.

## How to apply it

1. **`migrations/00_preflight.sql`** — read-only, changes nothing. Run it in the
   Supabase SQL editor and keep the output. It reports the real column names,
   the primary key's type, whether the append-only trigger also fires on
   `UPDATE`, and every routine that reads `projections`.

   These cannot be read from this repository, so `01` leaves them as
   `>>>PLACEHOLDERS<<<` rather than guessing. A migration that guesses a column
   name against a live projections table is how a season of picks gets lost.

2. **`migrations/01_supersede.sql`** — fill in the four names from step 1, then
   run. It adds two columns, one partial index, and one `security definer`
   function. It refuses to run against a schema without
   `collective.projections`, and every statement is idempotent.

   At this point nothing has changed for anybody: no reader looks at the new
   column yet.

3. **The three readers** — `/v1/games` in `collective_public`, the grader /
   settlement run, and the consensus + coverage counts. Each needs
   `superseded_at is null` added to the predicate that already picks the first
   pre-kickoff live submission. Section 4 of `01_supersede.sql` names them and
   says why each one matters. Still inert: nothing writes the column yet.

4. **`collective_ingest`'s `/v1/projections/retract`** — stop issuing the
   `DELETE`; call `collective.supersede_projection(id)` per row. Make the **dry
   run answer from the same path**, so `would_remove` can never again count
   rows the confirmed call is not allowed to touch — that mismatch is
   `INTEGRATION.md` item 3 and is what made the old dry run worse than useless.

   Corrections take effect from here.

Reversible at every step. Rolling back is
`update collective.projections set superseded_at = null` — every row is still
there, which is the point of doing it this way.

## `functions/collective_public.bundle.ts` — the whole fixed function

Paste as `index.ts`. `collective_public.PATCH.md` is the same four changes as
individual find-and-replace blocks if you would rather apply them by hand.

## The four fixes

Separate from the migration, and applicable on their own today. From reading
the deployed `collective_public` bundle:

1. **`/v1/games` carries no `sport` and no `week`.** The `collective_embed`
   copy of the same "shared" `buildGames` carries both; this one drifted. It is
   why `collective/index.html` works around `Wundefined` on the model page.
2. **One row per model per game, and a real `movement_n`.** The function maps
   every row `board_models` returns and has no opinion of its own, so the site's
   new `+n` marker renders only if that view happens to expose the column. The
   patch states the rule in the function, counts submissions when it sees them,
   falls back to the view when it does not, and filters `superseded_at` — inert
   until the migration lands, so deploy order stays free.
3. **The free-tier hole.** `isEntitled` still returns `true` for any signed-in
   account while billing is off. `collective_embed` lists this as its own
   defect 3 and removed it, so the embed and the site now disagree about the
   same reader. **Read that patch before applying it** — closing it is a
   product decision about who sees pre-kickoff numbers today.
4. **`?season=` empties the board.** `""` survives `??`, `Number("")` is `0`,
   `0` is finite — so the season becomes 0, nothing matches, and the response is
   a valid empty board with no error. The site builds exactly that URL.

## What the client already does

No client change is needed for this to work, and none is included here.

`collective/index.html` states the *current* rule in three places — the
pre-post revision scan, the receipt's movement note, and the `+n` beside a pick
on the wall. All three are driven by the server's own `movement` / `first`
counts and by `movement_n`, not by anything the page decides. When step 4
lands, a correction inside the window stops being movement and those surfaces
stop firing on it on their own. Nothing has to be un-shipped.

## Status

Specified and reviewable; **not applied and not tested against the live
schema** — applying it needs Supabase project access, which the session that
wrote it did not have and did not seek. Treat step 1 as the next action.
