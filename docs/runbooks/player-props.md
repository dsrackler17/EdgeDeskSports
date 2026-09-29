# Runbook — Player Props

## What runs

`.github/workflows/player-props.yml` runs **hourly, August–January**, on `main`:

1. `npm run props:test`. Nothing publishes if the props rules fail.
2. **Capture.** Only when the repository variable `PROPS_CAPTURE=on` **and** the
   secret `ODDS_API_KEY` exist.
3. `node football/props/build.js --league all`. This is deterministic, so an
   unchanged slate writes nothing.
4. `record.js freeze` then `record.js grade`, for NFL and CFB.
5. `record.js verify --base HEAD`. The ledger must only have grown.
6. `tools/ci/push_generated.sh` publishes `football/props/**`,
   `football/props/ledger/**` and `record/props/**`.
7. Supabase mirror, when `SB_URL` / `SB_SERVICE_ROLE` exist. Insert-only; a
   failure is a warning.

**Tuesdays** (`mode=validate`): the walk-forward validation refits the
calibration and re-derives every stage (~3 min at 2,000 sims).

PR CI (`player-props-tests.yml`) runs every suite, the SQL against a real
PostgreSQL, and the browser test.

## Turning on sportsbook capture

1. Add the secret `ODDS_API_KEY` (The Odds API; player props need a paid plan).
2. Set the repository variable `PROPS_CAPTURE` to `on`.
3. Optionally run the workflow by hand (`mode=hourly`) and read the step summary.
   It shows events, calls, credits remaining and unmapped names.

Budget: roughly (events × markets × regions) credits per pass. The defaults
(16 NFL / 20 CFB events, a 3 h cadence tightening to 45 min near kickoff, and a
floor of 500 credits) keep an in-season week in the low thousands. Tune with
`--max-events`, `--window-h`, `--markets` and `--bookmakers`.

## Common tasks

| Task | Command |
|---|---|
| Rebuild both boards | `npm run props:build` (NFL ≈ 30 s, CFB ≈ 60 s; first run downloads ~300 MB into `football/props/.cache/`) |
| Re-price after a capture without re-simulating | `npm run props:reprice` |
| Build as of a time | `node football/props/build.js --league nfl --now 2026-10-04T12:00:00Z` |
| Freeze / grade / verify | `npm run props:freeze` · `npm run props:grade` · `npm run props:verify` |
| Walk-forward validation | `npm run props:validate` (writes `nfl/validation.json`, `nfl/calibration.json`) |
| Tests | `npm run props:test` · `npm run props:sql` · `npm run props:e2e` |
| Apply the schema | paste `supabase/player_props.sql` into the SQL editor; read the CHECK THIS report |
| Deploy the desk | the edge function is generated: `node tools/presentation/inline.js`, then deploy `supabase/functions/edgedesk_ai/index.ts` as usual |

## When something is wrong

- **The board says PROJECTION ONLY.** No capture is on file (no key, capture
  off, or the budget stopped it). This is the honest state, not a bug.
- **A player is not priced / BAD MAPPING.** Read `football/props/<league>/market.json`
  `unmapped`. Add the pair to `football/props/identity_overrides.json`
  (`"NFL|team|compactname": "edp_…"`), then run `npm run props:reprice`.
- **An unexpected player status.** The NFL injury report is carried forward as
  UNRESOLVED until the week's report publishes. That is by design; the drawer
  says so.
- **`verify` failed.** A committed prediction was edited or removed, or frozen
  after kickoff. Do **not** force it: find the commit that rewrote the ledger
  and revert that commit.
- **A market's stage changed.** It follows the Tuesday validation and the live
  record. Read the gates in the Lab (*Player props validation*).

## Rollback

The props surfaces are additive. To disable them, revert the app.html and
index.html changes. The edge function falls through to the desk when
`propsTurn` returns null, and deleting the `EDPROPSDESK` block from
`tools/presentation/inline.js` and re-inlining removes it. The ledger and record
files are append-only history: leave them.
