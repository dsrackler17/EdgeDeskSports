# Server side of the lock rule

Every game locks 30 minutes before kickoff. Each model's latest live
submission received before the lock is the one the board, the consensus and
the grader use. Earlier ones stay stored. Anything received at or after the
lock is stored late and never counts.

Two files. Both are pasted, not installed.

1. **`lock_rule.sql`** — paste into the Supabase SQL editor and run. Its result
   is a report; rows 1–9 should each say `ok`. It moves the `is_graded_candidate`
   flag to the newest pre-lock row (trigger for new posts, backfill for games
   that have not kicked off), makes the ingest decide "late" by the lock, and
   never deletes anything. Safe to run again.
2. **`functions/collective_ingest/index.ts`** — the deployed ingest bundle with
   the rule's wording corrected. Paste as `index.ts` for the function
   `collective_ingest`, "Enforce JWT verification" off.

The client (`collective/index.html`, `app.html`) already states and enforces
the rule and collapses the games feed to the counting row.
