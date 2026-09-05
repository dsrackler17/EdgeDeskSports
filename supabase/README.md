# Server side

Everything in this folder is **pasted, not installed**. There is no migration
runner and no ordering table: each `.sql` file is written to be run by hand in
the Supabase SQL editor, and every one of them follows the same three rules.

**The convention, stated once.**

1. **Idempotent.** Safe to run again, and again. `add column if not exists`,
   `create table if not exists`, `create or replace function`, guarded
   `create index`. Running a file twice must be indistinguishable from running
   it once.
2. **Additive.** Nothing is dropped and no existing value is rewritten. Where a
   file does need to write to existing rows it says so, touches only rows whose
   target column is still NULL, and changes no measurement — labelling history
   is allowed, editing it is not.
3. **It ends in a report.** The last statement is a `select` whose rows each say
   `ok` or `CHECK THIS`. A migration you cannot verify from its own output is a
   migration you have to trust, and the point of these files is not having to.

The edge functions in `functions/` are pasted the same way: one file per
function, **zero imports**, because the dashboard bundles only the folder you
are editing and an import that cannot resolve fails the bundle, gets the deploy
rejected, and leaves the previous version serving — indistinguishable from a
deploy that worked and changed nothing.

---

## The files

### `capture_v9_qualification.sql` — the qualification state
Adds the columns `capture-v9` writes: the tier, the reason, the reference type,
the evidence behind each decision, and the corroboration and raw two-way price
columns that several UI panels have read since they were written and that
nothing ever wrote. Labels flags made before v9 as `pre-v9-legacy` so the record
can report the current policy separately instead of averaging two different
systems and calling the result one number. Rebuilds `preserve_anchor_entry()` so
the entry-price freeze derives its column list from the row rather than a
hardcoded list that had already fallen out of date. Creates `book_families` and
`book_quality` **empty**, with the reason they are empty in the table comment.

Run it **before** deploying capture v9. Capture degrades safely without it —
it drops the columns the database lacks and names them in `schema_gaps` — but
until it runs, persistence streaks cannot be stored, so a Tier B candidate can
never reach its second confirmation and the actionable board stays empty.

See `functions/capture/README.md` for the environment variables and the deploy
sequence.

### `lock_rule.sql` — the Collective's 30-minute lock
Every game locks 30 minutes before kickoff. Each model's latest live submission
received before the lock is the one the board, the consensus and the grader use.
Earlier ones stay stored. Anything received at or after the lock is stored late
and never counts. Rows 1–9 of its report should each say `ok`.

Pairs with `functions/collective_ingest/index.ts`, the deployed ingest bundle
with the rule's wording corrected — paste as `index.ts` for the function
`collective_ingest`, "Enforce JWT verification" off. The client
(`collective/index.html`, `app.html`) already states and enforces the rule and
collapses the games feed to the counting row.

### `publisher_briefs.sql` — shareable snapshots of a decision
Two tables, because the boundary between what is publishable and what is
privileged should be a structural fact rather than a policy that has to stay
correct. `publisher_briefs` holds the publishable payload and is readable by
anyone once `is_public` is true; `publisher_brief_internal` holds the engine
internals and is owner-only, always. Refreshing a brief inserts a NEW row with
`version_no + 1` and a `parent_id`; old rows and old share slugs stay exactly as
published.

### `brief_record.sql` — the closing line behind every published brief
`public_brief_closes`, an owner-run view that admits only rows whose game has
already kicked off, so the keyless grader
(`tools/record/grade_briefs.js`, run from a scheduled GitHub Action with the
same anon key every page ships) can read a close without the live board being
readable. A live price never leaves through it. The paywall is the live board,
not the history.

### `close_v7_parity.sql` — label how each close was measured
Adds `closing_reference_type`, `closing_ref_book`, `closing_n_families`,
`closing_ref_age_s` and `closing_policy`, and — separately — the six columns
`close` has always written and that **no file here ever created**
(`closing_dec`, `closing_book`, `closing_has_sharp`, `closing_n_books`,
`closing_source`, `closing_at_observed`); they existed only because someone
added them by hand in the dashboard, so a database rebuilt from this checkout
had a close job whose every update failed.

Labels every already-closed row `pre-v7-legacy` and touches no measurement, so
the pre-parity and post-parity populations can be segmented and never averaged.
Rows still open are left alone. Report rows 1-8 should each say `ok`.

### `book_quote_ticks.sql` — a stamped history of every book's price
`book_quotes` is upserted per `(sig_key, book_key)`, so it holds the latest pass
only and every earlier price at every book was overwritten. This adds a trigger
that appends every insert and every changed update to `book_quote_ticks` with a
timestamp, and `public_brief_book_closes`, the owner-run door giving the grader
the last tick per book at or before kickoff. A tick after kickoff is a live
price and is never a close.

Capture v9 is the first build that actually writes `book_quotes` — for
actionable signals only, since the whole board at every book would be tens of
thousands of rows per run and the actionable set is exactly the population a
book-behaviour study is about.

### `games_social.sql` — Head-to-Head and Groups
The social layer of EdgeDesk Games: challenges whose predictions are sealed
until both players lock, private groups, Elo ratings and the settlement path
that only the service role can reach. Tested against a real PostgreSQL by
`tools/games/sql_security.test.js`. See `games/README.md`.

### `games_franchise.sql` — the franchise layer
Run **after** `games_social.sql`. One fictional football franchise per
account: `franchises`, `franchise_seasons`, `game_players` (generated on the
server from a seed the server derives), `franchise_activity` (one row per real
thing that happened), `franchise_ledger` (append-only, keyed once per thing,
the source of every resource total), Pick 5 cards and selections, achievement
definitions and awards, and `game_board` — a published COPY of
`games/data/challenges.json` written only by the service role, so Price It is
scored and Pick 5 settled against the server's numbers and never a browser's.
RLS is on everywhere with owner-only reads and no client writes; every
mutation is a security-definer function that derives identity from
`auth.uid()` or the hash of the device secret presented. A trigger on
`game_challenges` turns a settled Head-to-Head into Coach Points without
changing `games_social.sql`.

Phase 2 adds the weekly game to the same file: `franchise_opponents` (a
seeded pool of twenty-four fictional clubs), `franchise_games` (one row per
scheduled game, the opponent frozen on it, the box written when it is
played), `franchises.rival_key`, four activity kinds, six achievement rows,
and the functions `franchise_start_season`, `franchise_play_week`,
`franchise_schedule` and `franchise_game`. The simulator (`franchise_sim`),
the scheduler and the writer are internal and granted to no client role.
Safe to re-run over a Phase 1 installation. Report rows 1–12 should each
say `ok`. Tested against a real PostgreSQL by
`tools/games/franchise_sql.test.js`. See `games/README.md`.

Two trusted functions, `game_board_upsert` and `franchise_settle_pick5`, are
granted to no client role; `games/publish_board.js` calls them from the
existing games workflows with `SB_SERVICE_ROLE` / `SB_URL`. No new secret is
needed.

---

## Not in this repository

`public_record.sql` is referenced by the app and by capture's comments but has
never been committed here, so the definitions of `result` and `beat_close` are
still written by code no checkout can review. Worth fixing the same way `close`
and `learn` now are.

---

### `functions/close/index.ts` — the closing line and CLV
Transcribed from the Supabase dashboard, where it had lived unreviewed since it
was written. **Diff this against the deployed function before treating it as
authoritative** — it was pasted in, not exported, and a transcription error here
would be indistinguishable from a real difference.

It carries its own copy of `devig`, `priceEvent` and `sigKey`, because the
dashboard bundles only one folder and a `../_shared` import fails the bundle
silently. Those copies had drifted from capture v9 in four ways, all fixed in
`close-v7-parity` and all pinned by `tools/capture/pricer_parity.test.js`; the
audit is in `tools/capture/pricer_parity.md`.

Run `close_v7_parity.sql` **before** deploying it. close degrades safely without
it — the new columns are probed and omitted — but until it runs there is no way
to tell a Pinnacle-anchored close from a consensus one, or a v7 row from a
pre-parity row.

### `functions/learn/index.ts` — patterns and calibration
Pre-registered hypotheses, chronological holdout, Benjamini-Hochberg across the
family, an effect floor, and expiry for patterns that stop holding. It learns on
CLV rather than win/loss, which means everything it concludes inherits whatever
`close` wrote. Same transcription caveat.
