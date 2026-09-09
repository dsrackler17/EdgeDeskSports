# UFC — the Live Fight Center pipeline

GitHub Actions → `tools/ufc/*.js` → Supabase (`ufc.*`, over PostgREST with the
service role) → `app.html` (anon / RLS reads). No Edge Function is involved.

| file | job | what it does |
|---|---|---|
| `sync_events.js` | `ufc-sync.yml`, every 6h | discovers cards from ESPN's public scoreboard, stores events and bouts by provider id, resolves fighters, links odds fixtures (both participants or nothing; a Draw is never a corner), writes pre-fight price history, marks stale cards |
| `build_baselines.js` | `ufc-sync.yml` (upcoming after every sync; everyone on Mondays) | deterministic fighter baselines from the fight history and career rates already on file, with sample sizes; EdgeDesk-observed target/position/round-pace baselines from fights this pipeline watched |
| `live_gate.js` | `ufc-live.yml`, every 30 min | reads the cards on file and answers "is a card in its live window?" (−45m … +9h) |
| `live_poll.js` | `ufc-live.yml`, the poll job | takes the per-event lock, polls the provider every ~20s while a bout is live, writes bouts / live state / snapshots / round rows / market captures / heartbeat, exits when the card is final, hands off at the runner's time limit |
| `espn.js` | — | the source adapter: URLs, event/bout parsing, the statistics normaliser (`STAT_ALIASES`; unknown keys are counted, never guessed) |
| `db.js` | — | the PostgREST client and the run ledger |
| `../../lib/ufc_research.js` | — | every rule, shared with the page: names, the draw rule, the first bell, health thresholds, baselines, live rates, flags, style labels |

## Secrets

`SB_SERVICE_ROLE` and `SB_URL` — the repository secrets the settle and
schedule jobs already use — are passed to the scripts as `EDGD_SB_SERVICE` /
`EDGD_SB_URL`. Nothing privileged reaches the browser: the page keeps the anon
key and reads through RLS.

## Running by hand

```bash
node tools/ufc/sync_events.js --verify              # prove the source answers, no credential needed; prints every request shape's status
node tools/ufc/sync_events.js                       # dry run: says what it would write
node tools/ufc/sync_events.js --commit              # write
node tools/ufc/build_baselines.js --upcoming --commit
node tools/ufc/live_gate.js                         # which card, if any, is in its window
node tools/ufc/live_poll.js --event espn:<id> --once   # one poll
node tools/ufc/live_poll.js --event espn:<id>          # fight night
```

Recovery is a `workflow_dispatch` of **UFC live** with the event id: the gate
confirms the card, the poll job re-syncs its bouts and takes the lock. A poller
that died without releasing the lock loses it after 150 seconds.

## Tests

```bash
npm run ufc:test    # engine + pipeline (fake database, synthetic provider documents) and the Fight Center UI
npm run ufc:sql     # supabase/ufc_live_center.sql against a real PostgreSQL (skips loudly without one)
```

Both run before either workflow is allowed to write.
