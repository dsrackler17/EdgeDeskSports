# EdgeDesk Tennis pipeline

GitHub Actions → Node → Supabase (PostgREST, service role) → `app.html` (anon key, RLS reads).
**No Edge Function is involved in any of it.** The privileged credential lives only in
repository secrets (`SB_SERVICE_ROLE`, `SB_URL`) and is read by the runner; the browser
gets the anon key and the public `select` policies the migration grants.

| file | what it is |
|---|---|
| `../../supabase/tennis_live_center.sql` | the data contract. Idempotent and additive: paste it into the Supabase SQL editor, re-run it any time, and read the report at the end — every row says `ok` or `CHECK THIS`. |
| `../../lib/tennis_research.js` | the shared deterministic engine. One UMD file loaded by **both** the Node jobs and the browser, so a rule the tests prove is the rule the page draws. |
| `espn.js` | the provider adapter. Parses the public tennis scoreboard; a field the feed does not carry is left null and named in `unmapped`, never invented. |
| `db.js` / `../lib/pgrest.js` | the PostgREST client, the run ledger and the meta ledger. |
| `sync_events.js` | every few hours: the draw, identity resolution, market links, price history, staleness. |
| `build_baselines.js` | the licensed record → one baseline row per player, plus EdgeDesk's own observed serve baselines. |
| `live_gate.js` | which tour-days are worth a runner right now. |
| `live_poll.js` | the long-running poller for one tour-day. |
| `fake_db.js` / `fixtures/make_day.js` | the in-memory database and the synthetic provider documents the tests drive the whole pipeline with. |

## The three rules the pipeline is built around

**A doubles pair is a team, never a player.** A side with a roster of two, or a slashed
name, is stored whole, marked `is_doubles`, and never resolved to one of its players. A
doubles fixture may only link to a doubles match. This is the tennis analogue of the UFC
rule that a Draw is a market row and never a fighter.

**A price after the first ball is a LIVE price.** `first_point_at` is the last poll that
still saw the match *not* started, so a capture at or before it is provably pre-match.
A poller that only ever saw the match live cannot claim that moment: it stores the weaker
`scheduled_start` bound and `close_bound_source` says which one was used. A LIVE capture
can never become a pre-match close.

**Serve data is observed or it is absent.** The licensed record carries results, surfaces
and rankings — no point-level serve numbers. So every `obs_*` baseline accumulates only
from matches this pipeline itself watched, starts empty, and is always reported beside its
sample. A player EdgeDesk has never watched gets no serve label rather than a guessed one.

## Running them

```bash
node tools/tennis/sync_events.js --verify              # prove the source answers, write nothing
node tools/tennis/sync_events.js                       # dry run: say what it would write
node tools/tennis/sync_events.js --commit              # write
node tools/tennis/build_baselines.js --upcoming --commit
node tools/tennis/live_gate.js                         # which tour-days are on court
node tools/tennis/live_poll.js --tour atp --once
node tools/tennis/fixtures/make_day.js                 # regenerate the synthetic scoreboard
```

`EDGD_SB_SERVICE` and `EDGD_SB_URL` must both be set for anything that touches the database.
Without them the jobs say so and exit rather than pretending to write.

## Why a tour-day and not a tournament

The provider files tennis as one scoreboard per tour per day carrying every tournament's
live matches together. One poller therefore covers a whole tour-day, and the lock is keyed
the same way (`atp:2026-05-28`) so two runners can never both drive it. Polling per
tournament would fetch the same document five times over.

## What a runner had to teach us

None of this could be settled from a laptop. A pull-request probe against the live feed
returned the following, and three things in it changed the design:

| tour | shape | tournaments | matches |
|---|---|---|---|
| ATP | day | 1 | 478 |
| ATP | range | 5 | 820 |
| WTA | day | 4 | 601 |
| WTA | range | 17 | 1349 |

**The same event answers under both tours.** The US Open came back from the ATP scoreboard
and the WTA scoreboard as the same provider id carrying the same 478 competitions. Two rows
would collide on one primary key and flip the tournament's tour on every run. So a match
takes its tour from the draw bucket it is filed under (`Men's Singles` → ATP), a tournament
whose matches span both is `MIXED`, and the two answers are merged into one row.

**Exactly one poller owns each row.** Otherwise the ATP and WTA runners would write the
same 478 matches over each other twenty seconds apart. Ownership follows the match's own
tour; a mixed-doubles match belongs to no single tour, so one is named as its owner by
convention rather than left to a race.

**A poller writes what moved.** A slam day carries hundreds of matches, nearly all of them
unchanged between polls. A content hash over the mutable fields decides, and the poll clock
is deliberately not part of it.

**The sync asks for a range; the poller asks for a day.** The range returned five times the
tournaments over the same window, so discovery tries it first.
