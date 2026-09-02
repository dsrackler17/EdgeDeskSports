# Server-side change set: the lock rule

The Edge Functions and SQL for this project live in the Supabase project
(`iattxbkbufslbauoumga`) and are **not** in this repository — `football/INTEGRATION.md`
has said so from the start. This directory is not a deployable Supabase project.
It is the change set for the server-side half of a rule the client already
enforces, written down and version-controlled so it is reviewable, applied
deliberately, and not lost in a chat log.

## The rule

**Every game locks 30 minutes before kickoff. Each model's latest live
submission received before the lock is the one that counts** — the one the
board shows, the consensus blends and the grader grades. Every earlier
submission stays stored as movement. A submission received at or after the
lock is stored, flagged late, and excluded, whoever posts it.

This replaces the first-submission rule. That rule stopped anyone moving a
number after reading the room — and it also stopped every creator who fixed a
mapping, or adjusted for weather, injuries or a line move, from ever correcting
the wall. Two creators reported the uploader as broken in one week
("my upload from 5d ago is still showing on the wall"; "tried reuploading but
no change"). The group decided: the latest upload is the master, and a lock-out
before kickoff protects the record. The lock is the anti-anchoring rule now.

Nothing is ever deleted. The store stays append-only, no delete privilege is
needed anywhere, and the retract endpoint that the append-only trigger has
always refused no longer has to work for a correction to count.

The earlier change set here (`01_supersede.sql`, a 30-minute correction window
*after* posting plus a maintenance function) is withdrawn. It solved a narrower
problem with more machinery; this needs no new column.

## What the client already does

`collective/index.html` ships the rule now, and works against the server as it
is today:

* every `/v1/games` response is collapsed on arrival to one row per model per
  game — the latest live row received before the lock. A feed that already
  collapsed passes through unchanged; a feed that returns every row is
  collapsed on the page. So the wall, the model page, the record and the
  coverage all agree whether the server has adopted the predicate yet or not;
* a row received after the lock that the server did not flag is flagged late
  on the client, on a copy, so it is shown as `LATE` and never graded there;
* the lock length is read from `/v1/meta` `lock_minutes` when present and is
  30 otherwise; every surface that states the rule prints that number;
* the dashboard says, before a post, which games it will replace numbers on
  and which have already locked; the receipt says the same from the server's
  own `first` / `movement` / `late` counts; the rules page, the legend, the
  game header (`LOCKS IN 2H` / `LOCKED`) and the `+n` beside a pick all state
  the lock rule;
* `app.html`'s *Sync to Collective (API)* no longer retracts anything: a dry
  run, one confirmation, and a post.

**But the wall is built from what `board_models` returns.** If that view still
collapses to the first submission, the page never sees the later rows and
cannot show them. That is the server change below, and it is the one that
makes a re-upload actually reach the wall.

## How to apply it

1. **`migrations/00_preflight.sql`** — read-only, changes nothing. Run it in the
   Supabase SQL editor and keep the output. It reports the real column names
   on `projections`, `games` and `config`, whether the append-only trigger also
   fires on `UPDATE`, and every routine and view that reads `projections`.

2. **`migrations/01_lock_rule.sql`** — fill in the names from step 1, then run.
   It adds the config key `submission.lock_minutes = 30`, two helper functions
   (`collective.lock_minutes()`, `collective.lock_at(kickoff)`), and one index.
   It refuses to run against a schema without `collective.projections`, and
   every statement is idempotent. At this point nothing has changed for
   anybody: no reader uses the helpers yet.

3. **The readers** — section 4 of `01_lock_rule.sql` writes the predicate out
   once. Apply it to `board_models` (what `/v1/games` reads), the grader /
   settlement run, consensus and the coverage counts. In words: *the latest
   live row per model per game with `received_at < lock_at(kickoff)`*, and
   `movement_n` counted over all of that model's rows on the game.

   **`board_models` is the one that matters for the creators who reported the
   uploader as broken.** `select pg_get_viewdef('collective.board_models'::regclass, true);`
   shows the current definition; the change is `received_at asc` → `desc` in
   its per-model pick, plus the lock predicate.

4. **`functions/collective_public.PATCH.md`** — Patch 2's `collapseModels` now
   states the same rule in the function (latest pre-lock row wins, one row per
   model per game, `movement_n` counted), so the site renders correctly even
   if the view returns every row. Patch 5 publishes `lock_minutes` on
   `/v1/meta`.

5. **`functions/collective_ingest.PATCH.md`** — `late` is decided by the lock
   rather than by kickoff, and `first` / `movement` are counted against the
   new rule. This is where a row posted 20 minutes before kickoff stops
   counting.

Reversible at every step: the helpers and the config key can stay, and putting
`asc` back in `board_models` restores the old rule exactly. No row is touched.

## Status

Specified and reviewable; **not applied and not tested against the live
schema** — applying it needs Supabase project access, which the session that
wrote it did not have. The client half is shipped and tested. Treat step 1 as
the next action, and step 3's `board_models` change as the one that makes the
creators' re-uploads land.
