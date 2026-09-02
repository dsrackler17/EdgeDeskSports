# `collective_ingest` — the lock rule

Two changes, both in `ingest_submission` (the RPC both doors — the browser's
`/v1/dashboard/submit` and the API key's `/v1/projections` — hand the envelope
to) or in the function that calls it, wherever `late` and the receipt counts are
decided today. Apply after `migrations/01_lock_rule.sql`, which supplies
`collective.lock_at()`.

## 1. `late` is decided by the lock, not by kickoff

Today a row is late when it is received after the game's kickoff. Under the
lock rule a row is late when it is received at or after **the lock**, 30
minutes before kickoff:

```sql
-- was:  late := v_received_at >= v_kickoff
late := v_received_at >= collective.lock_at(v_kickoff);
```

Everything downstream of `late` — stored but never graded, flagged on the wall,
excluded from consensus and coverage — is unchanged. A late row is still
stored: nothing is ever refused for being late, and the receipt says which rows
were.

## 2. `first` and `movement` count against the new rule

The receipt's counts keep their names on the wire — the client already reads
them as *new* and *replaced* — but what they count changes:

* `first`: the model held **no live pre-lock row** on this game before this
  submission. The row is new on the wall.
* `movement`: the model already held a live pre-lock row on this game. This
  submission **replaces it** on the wall (it is the newest pre-lock row), and
  the earlier one stays stored as movement.
* `late`: received at or after the lock. Stored, flagged, does not count, and
  does not replace anything.

Under the old rule `movement` meant "stored, will never be shown". If the
function has a branch that skips writing the row's numbers, or writes them
somewhere the board does not read, because it is a revision, remove it: every
submission is written the same way, and *which* row is shown is decided only by
the reader's predicate (`01_lock_rule.sql` section 4).

## What does not change

* `/v1/projections/retract` — untouched. It has never succeeded against the
  append-only store and it no longer needs to: nothing has to be removed for a
  correction to count.
* The dry run answers from the same path as the confirmed call, as before, so
  `first` / `movement` / `late` on a dry run are what the post would produce.
* `marketSnapshot`, the sport→league map and the per-sport model resolution
  from `football/INTEGRATION.md` are separate and still apply.
