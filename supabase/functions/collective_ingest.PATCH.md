# `collective_ingest` — the lock rule

## In the deployed bundle (`index.ts`): three wording edits

The bundle decides nothing about which submission counts — that is
`ingest_submission` in SQL and the views. It does state the rule in three
places, and those now say the wrong thing.

**Find** (in `RULES`):

```ts
    "First submission: each model is graded on its first pre-kickoff live submission per game, timestamped on server receipt. Later revisions are stored and shown as movement, never regraded. Post-kickoff receipts are stored, marked late, and excluded. Backfill and test data are stored, shown separately, and excluded from records, rankings, and consensus.",
```

**Replace with:**

```ts
    "The lock: every game locks 30 minutes before kickoff. Each model is graded on its latest live submission received before the lock, timestamped on server receipt; earlier submissions are stored and shown as movement, never regraded. Receipts at or after the lock are stored, marked late, and excluded. Backfill and test data are stored, shown separately, and excluded from records, rankings, and consensus.",
```

**Find** (the `/v1/me` note):

```ts
          : "Only the first pre-kickoff submission per game counts toward the record.",
```

**Replace with:**

```ts
          : "Your latest submission per game received before the lock (30 minutes before kickoff) is the one that counts; earlier ones are stored as movement.",
```

**Find** (the retract route's dry-run note) and replace the sentence
`your next post for these games becomes the first submission` with
`posting again replaces these rows on the wall by itself, so this is rarely needed`.
The route otherwise stays as it is: it has never succeeded against the
append-only store and nothing needs it any more.

## In `ingest_submission` (SQL): two changes

`ingest_submission` is the RPC both doors — the browser's `/v1/dashboard/submit`
and the API key's `/v1/projections` — hand the envelope to. Its definition is
printed in the report `supabase/lock_rule.sql` produces; the two changes are
written against that. `lock_rule.sql` also installs a `BEFORE INSERT` trigger
that sets the late flag by the lock regardless, so change 1 below only makes
the receipt's own `late` count agree with what was stored.

## 1. `late` is decided by the lock, not by kickoff

Today a row is late when it is received after the game's kickoff. Under the
lock rule a row is late when it is received at or after **the lock**, 30
minutes before kickoff (`collective.lock_at()` comes from `lock_rule.sql`):

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
somewhere the board does not read (a different `resolution_status`, say),
because it is a revision, remove it: every submission is written the same way,
and *which* row is shown is decided only by the views.

## What does not change

* `/v1/projections/retract` — untouched. It has never succeeded against the
  append-only store and it no longer needs to: nothing has to be removed for a
  correction to count.
* The dry run answers from the same path as the confirmed call, as before, so
  `first` / `movement` / `late` on a dry run are what the post would produce.
* `marketSnapshot`, the sport→league map and the per-sport model resolution
  from `football/INTEGRATION.md` are separate and still apply.
