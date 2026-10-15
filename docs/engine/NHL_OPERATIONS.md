# NHL engine: operations, deployment and rollback

## What runs, and when (`.github/workflows/nhl.yml` tests, `nhl-build.yml`, `nhl-validate.yml`)

| Job | Trigger | What it does | Runner time |
|---|---|---|---|
| tests | every PR and push touching the NHL | brain, market test, desk, v2 suite (pricing, explanation, market labels, lab, props, warehouse sync, registry, artifacts), registry/board, both SQL suites on a real PostgreSQL, gateway guard, navigation, the panels in Chromium (desktop + 390 px) | ≈ 6 min |
| build | every 3 h | ingests the season in progress; refreshes lineups, periods and box scores; requests prices only if authorised; prices the slate for the next 120 hours, so every day Today's Games lists has research (explanations, full sheet, re-pricing inputs, challengers, market check); grades the ledger; builds player research, diagnostics/drift and the source registry; runs the suites; syncs the warehouse only if `NHL_WAREHOUSE=on`; commits only on change | ≈ 4–5 min (was ≈ 2) |
| validate | weekly (Tue 10:23 UTC) | every season since 2010-11: xG refit, the production record, the market test, the lab (A–G, ablation, promotion rule), the prop record, the box-score reconciliation; rebuilds everything; commits only if every suite passes | ≈ 35–45 min (timeout raised to 120) |

**Cost.** No paid service was added. GitHub Actions use rises by roughly
15 minutes a day for the build and 15 a week for validation. The odds
provider spends **0 credits** unless authorised (below). With the warehouse
on, Supabase storage is about 40–60 MB (games, team games, periods, two
seasons of player games, predictions), well inside the free tier.

## Switches (all off until the owner turns them on)

| Switch | What it enables | How |
|---|---|---|
| `NHL_PRICES=on` + gateway row | NHL book prices (≈3 credits a call; the gateway cadence caps it near 24 a day) | `select public.odds_api_set_sport('icehockey_nhl', true);` and set the repository variable |
| `NHL_WAREHOUSE=on` | the Supabase `nhl` schema is kept in sync | apply `supabase/nhl_warehouse.sql` (or its migration), add `nhl` to the exposed schemas (Dashboard → API → Exposed schemas, or `supabase/expose_schemas.sql` with `nhl` appended), then set the repository variable. The job reuses the `SB_URL` / `SB_SERVICE_ROLE` secrets the other jobs hold. |
| `EDGEDESK_NHL=0` | turns the desk's NHL turn off | Edge Function environment |
| Confirmed starters | replace the projected starter | add entries to `hockey/data/confirmed_starters.json` with source and time |

Value claims stay off whatever the switches say. Only a market test with
`TESTED_AHEAD` (n ≥ 500) on a licensed closing archive can enable them
(`lib/edgedesk_nhl_market.js`, gate `market_tested`).

## Deploying this change

1. **Merge.** The panels, the slate and the record are static files. GitHub
   Pages serves them, and the next `nhl-build.yml` build regenerates the slate with
   the new code.
2. **Edge Function.** `edgedesk_ai` now explains NHL numbers from the slate's
   decomposition. It reaches readers after the usual deploy
   (`deploy-intelligence.yml`), as before.
3. **Optional: the warehouse.** Apply the SQL, expose the schema, set
   `NHL_WAREHOUSE=on` (above).
4. **Optional: access requests.** Review `docs/engine/access-requests/`,
   confirm each provider's current terms, and send from the owner's address.

## Model versioning

The production model's id is in every ledger record and slate:
`edgedesk_nhl_v1:<candidate>`, now `edgedesk_nhl_v1:xg_core`. When the model
changes, the ledger writes a new record for every upcoming game (its rule:
model change). Training windows are fixed per season (the five seasons
before), and so are the parameter files (`hockey/model/params/`). Every fit is
deterministic: IRLS, and seeded PRNGs for the trees and bootstraps
(seed 20261013).

## Rollback

| To undo | Do |
|---|---|
| The parsimony amendment (back to `xg_no_goalie`) | remove `'xg_core'` from the selection chain in `hockey/model/walkforward.js` (rule 4) and run `npm run nhl:validate && npm run nhl:slate`. Nothing else changes. |
| The period profile | in `walkforward.js effectsFor`, drop `{ t_buckets: DIST.T_BUCKETS_FINE }`, then re-run as above. Effects files without `t_buckets` still price. |
| The new game page | revert `lib/edgedesk_engine_ui.js`, `lib/edgedesk_engine.css` and the two `?v=` strings in `app.html`. The slate's new fields are additive, and the old panel ignores them. |
| Player research, diagnostics, registry | delete their files; the panel says "could not load" in their tabs only. |
| The warehouse | set `NHL_WAREHOUSE` to anything but `on` (nothing writes); `drop schema nhl cascade;` removes it entirely. |
| The desk's "why" sentence | revert `hockey/desk.js` and run `node tools/presentation/inline.js`. |

## Monitoring

- **Drift.** `hockey/validation/nhl_diagnostics.json` holds a CUSUM and a
  z-test of the season's log loss against the confirmation window. The Record
  tab shows the status (OK / WATCH / ALERT).
- **Freshness.** The slate's `readiness.data` is FRESH within 48 hours of the
  latest result. Before this change it always read STALE: it looked up a
  field the game objects do not carry, a bug fixed here.
- **Reconciliation.** `nhl_crosscheck_box.json --check` fails the weekly job
  if any quantity drops below its bar.
- **Quotes.** When prices flow, each check carries its quote's age, and
  `price_fresh` fails after 30 minutes.
