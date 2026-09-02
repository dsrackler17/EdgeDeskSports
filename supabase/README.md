# Server-side change set: the lock rule

The Edge Functions and SQL for this project live in the Supabase project
(`iattxbkbufslbauoumga`) and are **not** in this repository. This directory is
the server-side half of a rule the client already enforces, written so it can
be applied by pasting.

## The rule

**Every game locks 30 minutes before kickoff. Each model's latest live
submission received before the lock is the one that counts** — the one the
board shows, the consensus blends and the grader grades. Every earlier
submission stays stored as movement. A submission received at or after the
lock is stored, flagged late, and excluded, whoever posts it.

This replaces the first-submission rule, under which a corrected re-upload
could never reach the wall. Nothing is ever deleted and the store stays
append-only.

## How to apply it

### 1. `lock_rule.sql` — paste it, run it, read the result

One file, **no placeholders**. Paste the whole thing into the Supabase SQL
editor and run it once. It discovers its own column names and does what it
can; its **result is a report** of what it did and what it found. Nothing is
deleted; a step that cannot apply says so in the report instead of failing
the run. It is safe to run again.

What it does:

| step | what | if it cannot |
|---|---|---|
| 1 | `collective.lock_minutes()` and `collective.lock_at(kickoff)` — the lock, spelled once | never fails |
| 2 | config key `submission.lock_minutes = 30` in `collective.config` | the lock stays at 30 |
| 3 | a `BEFORE INSERT` trigger on `projections`: a live row received at or after its game's lock is stored with the late flag set. **This is what makes a post inside the last 30 minutes not count.** It fails open. | says why |
| 4 | `board_models` and `consensus` rewritten from "first submission" to "latest submission" by flipping the `received_at` ordering in their own definitions. **This is what makes a re-upload reach the wall.** | says so and prints the definition |
| 5 | the report: every step's outcome, the current definitions of the views and of every routine that reads `projections` (`ingest_submission`, the grader), and how projections are distributed | — |

If step 4 reports a view as **unchanged** or **FAILED**, or you want the
grader's routine changed too, copy the whole report back into the chat: the
definitions in it are what the next exact paste is written from.

### 2. `functions/collective_public.PATCH.md` — the games feed

Patch 2 makes the function itself collapse to the latest pre-lock row, one
row per model per game, so the site renders correctly even if the view returns
every submission. Patch 5 publishes `lock_minutes` on `/v1/meta`. Patches 1, 3
and 4 are independent fixes that were already written down.

### 3. `functions/collective_ingest.PATCH.md` — wording

Three wording edits in the deployed bundle (the rules text, the `/v1/me` note,
the retract notes), plus the two changes `ingest_submission` needs once its
definition is in hand from the report.

## What the client already does

`collective/index.html` ships the rule and works against the server as it is
today: every `/v1/games` response is collapsed on arrival to the latest live
row received before the lock; a row received after the lock that the server
did not flag is flagged late on the page; the lock length is read from
`/v1/meta` `lock_minutes` (30 when absent); the dashboard says before a post
which games it will replace numbers on and which have already locked; the
rules page, the legend, the game header chip and the `+n` beside a pick all
state the lock rule. `app.html`'s *Sync to Collective (API)* is a dry run, one
confirmation and a post — no retract.

But the wall is built from what `board_models` returns. Until step 4 above
lands, the page never sees a re-upload and cannot show it.

## `migrations/00_preflight.sql`

Read-only and optional. `lock_rule.sql` reports everything it would tell you.
