# Market Foresight

**Which forecasts, and which observed venues, preceded subsequent market movement?**

`/foresight/` is an observational research record. It matches each timestamped, identifiable
forecast (EdgeDesk's own models and the Model Collective's) to the DraftKings and Kalshi prices
EdgeDesk recorded before and after the forecast's publication. It reports what the timestamps
support and nothing more. A reader can open a game and see:
- what each source showed, and when;
- how uncertain each change's timing is;
- where nothing was observed;
- why a forecast was or was not measured.

It is a **separate layer**. It reads stored records and never writes back into them. It changes
no forecast, ranking, grade, evaluation window, eligibility rule or model input, and nothing
reads it (`tools/foresight/isolation.test.js`). It publishes separate measurements, never a
composite score, and it promotes no one.

The rules: [METHODOLOGY.md](METHODOLOGY.md), frozen as
[`mf-v1`](../../research/foresight/methodology/mf-v1.json) before any measurement existed.

## Status (2026-10-25)

**Built and tested, not deployed.**
- The migration has not been applied to production.
- The hourly job is off (`MARKET_FORESIGHT_WORKER`).
- The layer starts in **shadow** mode, where only operators see results.
- This session could not reach the production database: the cloud environment's network policy
  refused `iattxbkbufslbauoumga.supabase.co`. So nothing was verified against production rows.

## In the terminal

The record also opens inside the terminal, at `app.html#foresight`,
`#foresight/game/<sport>:<event id>` and `#foresight/model/<source>:<key>[/<version>]`.
It is a seat in the Research group, and the game page shows a preview under "Keep researching
this game". It is the same controller and renderers (`foresight/foresight.js`, booted with
`inApp`), reading the same doors under the reader's own session. `foresight/service.js` is all
the rest of the terminal can reach: status and per-game counts for display, through
`EDShell.provide('foresight', …)`. `/foresight/` is unchanged. See
[`docs/research-os/DESIGN.md` §5](../research-os/DESIGN.md).

## Sources, and what each can support

| Source | Connected how | Collecting | Measurable historically |
|---|---|---|---|
| DraftKings via ESPN (`record/football/quotes/`) | committed ledger, no credential | yes, hourly, by the football record job (write on change plus a heartbeat) | from **2026-10-03**: NFL 72 games, CFB 256 games (both sides of spread, total and moneyline) |
| EdgeDesk forecasts (`performance/ledger/forecasts/`) | committed, hash-chained | yes, hourly | live capture times from **2026-10-16**; earlier rows are `reconstructed_from_git` and excluded from measurement |
| Kalshi (`kalshi_price_snapshots`) | database, service role | every 5 minutes, NFL and CFB game winners (since the Kalshi layer was deployed, 2026-10-21) | only after an operator verifies each series' settlement rules; until then shown, never compared |
| Model Collective (`collective.projections`) | database, service role | as creators post | from the first live projection; retracted pre-kickoff rows are deleted by the Collective and cannot be seen |
| A broader market benchmark | not used | — | `signals.sharp_fair` is a composite consensus (Pinnacle or a trimmed median), subscriber-gated and not per-book. It is not a venue and is not presented as one |

**What a dry run over the committed sources found** (2026-10-25 06:00 UTC, no credentials, so
Kalshi and the Collective were recorded as not configured):
- 544 finished games, 2,897 forecast–venue units, 395 measured.
- Units not measured, by reason:

  | Reason | Units |
  |---|---|
  | `publication_time_reconstructed` | 2,176 |
  | `settlement_unverified` (Kalshi) | 181 |
  | `no_fresh_baseline` | 126 |
  | `no_valid_close` | 16 |
  | `no_market_contract` | 3 |

- DraftKings' actual cadence is a median of about 6.5 h between stored rows (the heartbeat),
  with about one interval in four longer than the heartbeat plus 90 minutes. Those are
  reported as coverage gaps, not smoothed over.
- A valid close was observed for 81% of CFB and 93% of NFL markets.
- The T3 check found no evidence on the CFB holdout that disagreement added information; the
  NFL sample is insufficient.

## Architecture

```
committed ledgers ─┐
                   ├─ tools/foresight/sources.js ─ lib/edgedesk_foresight.js (pure) ─ tools/foresight/run.js ─ mf_job_* doors ─ PostgreSQL (mf_*)
database (read) ───┘        (normalize)               (measure, under mf-v1)            (changed rows only)
readers ── /foresight/ (foresight.js + lib/edgedesk_foresight_ui.js) ── mf_status / mf_overview / mf_games_list / mf_game / mf_model / mf_embed
```

| File | Role |
|---|---|
| `research/foresight/methodology/mf-v1.json`, `FROZEN.json` | the frozen rules and their digest |
| `lib/edgedesk_foresight.js` | the engine: contracts, de-vig, interval series and gaps, M0 and C, metrics, debounced moves, lead–lag pairing, as-of consensus, Wilson and seeded bootstrap intervals, the T3 check. UMD, ES5, no clock, no I/O |
| `lib/edgedesk_foresight_ui.js` | the pure renderers: tables, findings, step-plot SVG, the "what each source showed at t" readout, the event table |
| `foresight/index.html`, `foresight.js`, `foresight.css` | the page (overview, `?game=`, `?model=`) |
| `foresight/embed.js` | a model's top line for other sites, linking to its complete record |
| `tools/foresight/run.js`, `sources.js`, `db.js` | the worker |
| `supabase/market_foresight.sql` (= `migrations/20261025120000_market_foresight.sql`), `market_foresight_rollback.sql` | the database |
| `.github/workflows/market-foresight-tests.yml`, `market-foresight.yml`, `deploy-market-foresight.yml` | CI, the hourly run (off until switched on), the manual deploy |

### The database

Row level security is on every table, with no client policy. SELECT is revoked from `anon`
and `authenticated`, and table DML is revoked from `service_role` too, so every write goes
through a door.

| Table | Holds |
|---|---|
| `mf_config` / `mf_config_log` | `mode` (`off` / `shadow` / `live`) and `public_timeline`; every change logged |
| `mf_methodologies` | append-only: each version with its sha256 (a second digest under a version is refused) |
| `mf_runs` | one per run (a lease); counts, sources, a bounded log of mapping failures, exclusions and stale data, coverage, lead–lag, T3 |
| `mf_games` / `mf_game_versions` | the current derived game payload; every distinct input hash kept, append-only |
| `mf_units` / `mf_unit_versions` | the current measurement per unit; every distinct input hash kept, append-only |
| `mf_summaries` | the latest complete summary set (re-derivable from the units) for the whole record, 30 days and 7 days |
| `mf_settlement_verifications` | append-only operator readings of Kalshi rules texts, by sha256 |

**Doors.**

| Who | Doors |
|---|---|
| anyone | `mf_status()`: mode, methodology, last run, coverage and freshness, with no forecast and no price |
| anyone, when live | `mf_overview`, `mf_games_list`, `mf_game`, `mf_model`, `mf_embed`: derived measurements of **publishable** models (rules below) |
| Full Access (`community_is_entitled`, fail closed) | the full per-game timeline: every observation segment with raw prices. An operator can open it to everyone with `mf_admin_set_public_timeline(true)` |
| operators (`billing_is_admin`) | everything in shadow mode, consensus member names, `mf_admin_set_mode`, `mf_admin_runs`, `mf_admin_pending_rules`, `mf_admin_verify_settlement` |
| the database owner | `mf_owner_set_mode(mode, reason)`: no API role can call it |
| the job | `mf_job_begin`, `mf_job_known`, `mf_job_verifications`, `mf_job_put_games`, `mf_job_put_units`, `mf_job_put_summaries`, `mf_job_finish` |

**What a public reader sees.**
- A Collective model is publishable while the model and its creator are listed and the creator
  is active and not removed. This is checked **at read time** against
  `collective.models` / `creators`, through whatever columns production has, and fails closed.
  An unlisted creator disappears at once.
- Consensus members are never named outside the operators' view.
- Fixture ids (`SYN_` events, `syn_` models) are refused by the database.

Keyset paging: games by kickoff, units by kickoff and key, at most 100 and 200 a page.

### The job

`node tools/foresight/run.js --write` (hourly in `.github/workflows/market-foresight.yml`,
gated on `MARKET_FORESIGHT_WORKER`):
1. Checks the methodology digest.
2. Reads the committed ledgers; with `SB_URL` / `SB_SERVICE_ROLE` it also reads the Kalshi
   layer and the Collective, read only, through an allowlist with a request budget of 1,500.
3. Computes everything.
4. Writes only rows whose input hash changed. A re-run on the same records writes nothing.

A finished game's Kalshi snapshots are cached between runs (actions/cache), because they never
change after kickoff. A source that cannot be read makes the run **partial**: games it would
affect are left as stored, and the previous summaries are kept rather than replaced with an
incomplete set. A run that exhausts its budget still releases its lease and says why.

The job adds no odds-provider request, no capture request and no capture cadence. Improving
collection cadence is the capture jobs' business. A better future cadence would narrow future
intervals only; historical records keep the timing they were collected with.

## Deploy

1. **Actions → Deploy Market Foresight schema** (`deploy-market-foresight.yml`, manual). It runs
   the SQL and worker suites, checks the mirror, applies the file in one transaction, and fails
   on any `CHECK THIS`. Or paste `supabase/market_foresight.sql` into the SQL editor. The report
   should read `ok`, plus two `pending` rows until Kalshi is verified and the Collective schema
   is reachable.
2. **A first run by hand.** Actions → Market Foresight run → Run workflow, with `dry_run` first
   and then without it. Check the run in `mf_admin_runs(5)` or
   `select * from public.mf_runs order by started_at desc limit 3;`.
3. **Review in shadow** as an operator at `/foresight/`.
4. **Verify Kalshi's rules** (optional, unlocks Kalshi comparisons and venue lead–lag). As an
   operator, `select public.mf_admin_pending_rules();` lists each linked series' rules text
   with its sha256. Read each text, then record what it says, for example:
   ```sql
   select public.mf_admin_verify_settlement('{"series_ticker":"KXNCAAFGAME","sport":"cfb","rules_sha256":"<digest>","overtime":"included","tie":"impossible","note":"read <date>"}');
   ```
   Then run the job again. A tie that settles NO rather than as a push is recorded as
   `"tie":"no"`; it stays a mismatch and is not compared with the DraftKings moneyline.
5. **Go live** only after [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md) is ticked, by hand:
   `select public.mf_admin_set_mode('live', 'reason');`. Switch on the hourly job by
   setting the repository variable `MARKET_FORESIGHT_WORKER` to `on`. Add `/foresight/` to
   `sitemap-pages.xml` and change the page's robots meta to `index,follow`.

## Rollback (non-destructive first)

- **Hide everything:** `select public.mf_owner_set_mode('off', 'reason');` (owner) or
  `mf_admin_set_mode('off', …)` (operator). Every reader door answers `{mode: off}` and the page
  says so. Every stored row is kept, and switching back restores it.
- **Stop computing:** set `MARKET_FORESIGHT_WORKER` to anything but `on`.
- **Remove the layer:** `supabase/market_foresight_rollback.sql`. It drops `mf_*` objects only
  and touches no source data: the ledgers, `kalshi_*` and `collective.*` are not referenced.
  Every derived row can be recomputed from the sources. Operator settlement verifications
  cannot, so export `mf_settlement_verifications` first.

## Tests

| Suite | What it proves |
|---|---|
| `node tools/foresight/engine.test.js` | the frozen digest; every metric on a hand-worked synthetic world (convergence, divergence, overshoot, reversal, flicker, no movement, outage, missing baseline and close, postponement, revisions, duplicates, as-of consensus, no future leakage, lead–lag without reuse, ties, unresolved overlap, Wilson, seeded bootstrap, the T3 check) |
| `node tools/foresight/isolation.test.js` | nothing outside an allowlist references the layer; the frozen ranking and grading files and every model tree are checked by name; the engine requires only `edgedesk_calc.js` and reads no clock or I/O |
| `node tools/foresight/sql.test.js` | the layer on a real PostgreSQL: roles, doors, history, idempotency, the fixture namespace, shadow / live / off, Full Access, Collective visibility at read time, paging, forged cursors, operators, the rollback |
| `node tools/foresight/worker.test.js` | the job end to end over the committed ledgers through a PostgREST stand-in: idempotent re-runs, the Kalshi cache, settlement verification, a partial run, the request budget, secret scrubbing |
| `node tools/foresight/ui.test.js` | the renderers and the page's static rules |
| `node tools/foresight/pages.e2e.js` | the pages in Chromium at 1280 px and 390 px: every state, the readout on hover and keyboard, the embed |

`npm run foresight:test` runs the offline suites; `npm run foresight:sql` the database ones; `npm run foresight:e2e` the browser.

## Known limitations

- **Sampling resolution.** DraftKings is recorded on change plus a heartbeat (6 h, or 50 min
  inside 3 h), from an hourly poll that GitHub often runs late. So most move intervals are hours
  wide, and most venue orderings are UNRESOLVED. That is reported, not narrowed.
- **No source update times.** ESPN and Kalshi rows carry the collector's read time only. A
  trade's time is unknown, so a last trade is never a fresh quote.
- **EdgeDesk's forecast history before 2026-10-16** has reconstructed timestamps. Adding a
  capture now does not verify those rows retroactively; they are shown in tables and excluded
  from measurement.
- **The Collective has no model version column and no hash chain**, and its retract route
  deletes pre-kickoff rows. A forecast retracted before this job first read it cannot be counted.
- **Kalshi is compared with nothing** until an operator verifies each series' rules text. Fees
  are not applied: the repository's Kalshi fee schedule is unverified, so no execution cost is
  shown.
- **Only DraftKings and Kalshi are tracked venues.** No statement is made about the whole market.
- **NFL and college football only**, pregame only.
