# The Odds API credit exhaustion — 2026-10-10

**Status:** paid retrieval is paused by the emergency stop once
`supabase/odds_api_emergency_stop.sql` is applied. Stored data keeps serving.
Every caller now goes through one gateway. It re-enables on 2026-11-01 under a
60,000-credit operational budget, using the runbook in §9.

**Plan:** $59/month, 100,000 credits. On 2026-10-10 at 12:24Z the provider
reported **99,336 used and 664 remaining**. By 13:55Z it reported **100,000
used and 0 remaining** (the CFB props capture's own `capture_state.json`): the
October quota is spent, and every paid call is refused until the reset at
**2026-11-01 00:00 UTC**. The stop and the gateway must be in place before
then. Otherwise every old path resumes at its old rate the moment the quota
returns.

**Constraints kept:**
- No plan upgrade, no credit purchase, and the application stays up.
- No job was deleted: jobs are paused, recorded and resumable.
- No paid call was made while doing this work. Every suite mocks the provider.

Notation used below:
- **[obs]** means read from provider headers in job logs or committed `capture_state.json` snapshots.
- **[derived]** means arithmetic on observed numbers.
- **[est]** means an estimate from the configuration.

---

## 1. Root cause

October spent **99,336 credits in 9.52 days, about 10,440/day [obs]**. The
plan affords about 3,226/day.

| Path | October credits | Per day | Share | Basis |
|---|---|---|---|---|
| All callers (provider `x-requests-used`) | 99,336 | ~10,440 | 100% | [obs] |
| Player-props workflow (`football/props/capture.js`) | 54,958 (NFL 19,027 / CFB 35,931) | ~5,775 | 55% | [obs], sum of each run's `credits_spent` |
| Everything on the Supabase side (`capture`, `close`, `collective_odds_ingest`, anything deployed) | ~44,378 | ~4,660 | 45% | [derived], total minus props |

The weekend multiplier is large:
- Fri–Sun (10/02, 10/03, 10/04, 10/09) averaged about **16,430/day**.
- Mon–Thu (10/05–10/08) averaged about **5,370/day [derived]**.
- September ran at about 2,950–3,340/day [obs] before player props existed.

### The five largest causes

1. **Player-prop capture launched on 2026-09-29 with a cost-blind shape.**
   - Shape: 20 NFL and 17 CFB markets per event, a 96-hour window, and a 15/30/60/120/360-minute cadence.
   - It was dispatched by a 5-minute pg_cron job (`player_props_dispatch` → `props_cron` → `player-props.yml`), plus four GitHub cron runs an hour.
   - Observed volume: 57–201 workflow runs a day. CFB runs alone cost 477–479 credits, about hourly on 10/03 [obs].
   - **55% of October.**
2. **`capture` v11, also 2026-09-29, multiplied the Supabase side.**
   - Day-tier runs went from 6–18 credits in September to **95–124 credits in October [obs]**.
   - Each run added alternate ladders per event (to 30 h). It also added its own player-prop pass (on by default, 33 + 26 markets at `us,eu`), which bought the same events as path 1 a second time.
   - The game lines themselves used `regions=us,eu`, which bills double.
   - Triggers: pg_cron fired it at `*/10`, `4,34 * * * *` and `18 */4 * * *`. `capture.yml` fired it again hourly.
3. **No shared budget.**
   - Six paths held the same key, each with a private guard or none:
     - props stopped at 200 remaining;
     - capture's prop pass stopped at 5,000;
     - `collective_odds_ingest` read its own stale copy of the quota;
     - `close` had no guard, no timeout, and threw the quota header away.
   - Nothing could see the aggregate, so nothing stopped it.
4. **Retries and triggers that multiplied whole runs.**
   - `capture.yml` used `curl --retry 2`, which re-invoked a complete capture after a 504 wall-clock timeout (10/10 01:02 [obs]).
   - The props capture retried timeouts, so a billed request could be billed twice.
   - A reader's Refresh dispatched a **forced** capture that skipped both the debounce and the low-credit pacing.
   - `edgedesk_ai`'s quote refresh called `capture` with no tier, which captured every sport at the full horizon.
   - The props cadence clock lived in a git commit that a failed earlier step could skip, so the next run re-bought everything.
5. **Request shape and scope.**
   - `us,eu` costs twice what a 10-bookmaker list costs.
   - Alternate and long prop markets were bought by default.
   - Prop windows were 96 h for both leagues.
   - Inactive sports were discovered and bought via `/sports`.

There was no single bad deploy: two features shipped on the same day (1 and
2), and no control plane existed to notice their sum (3).

---

## 2. Consumption audit (Phase 2)

Cost rules:
- `/odds` bills **markets × region-equivalents**. A bookmaker list counts as one region per 10 keys, rounded up.
- `/events/{id}/odds` bills **markets returned × region-equivalents**.
- `/sports` and `/events` are free.

### Before

| Caller | Trigger / schedule | Sports | Endpoint | Markets | Regions / books | Cost per call | Calls / day | Credits / day | Necessary? | Replacement |
|---|---|---|---|---|---|---|---|---|---|---|
| `player-props.yml` → `football/props/capture.js` | pg_cron `*/5` dispatch through `props_cron` (57–201 runs/day [obs]), GH cron `8,23,38,53 * * 8-12,1 *`, reader Refresh (forced) | NFL, NCAAF | `/events/{id}/odds` | NFL 20 (core+long+alt), CFB 17 | 10 books (1) | markets returned: CFB 1–14 [obs], NFL ~20 | every event in 96 h, per cadence | **~5,775 [obs]** | Yes: props board, projections, grades | Gateway `props` category, 11 core markets; windows NFL 48 h / CFB 24 h; cadence 60/120/360 (CFB 180); no in-run retry; cron `8,38` |
| `capture` game lines | pg_cron near `*/10`, day `4,34`, board `18 */4`; `capture.yml` `26 *` and `41 1,7,13,19` with `curl --retry 2` | NFL, NCAAF + discovered active sports | `/odds` | h2h, spreads, totals | `us,eu` (2) | 6 per sport | up to ~200 ticks | part of ~4,660 [derived] | Yes: board, signals, CLV | Gateway `featured` category, 3 credits per sport; event-aware cadence; fixed sport list |
| `capture` alternates | day / near ticks | NFL, NCAAF | `/events/{id}/odds` | alternate_spreads, alternate_totals | `us,eu` (2) | ≤ 4 per event | up to 80 events per sport per run, to 30 h | part of ~4,660 | Useful, not critical | `alternates` category, 24 h only, priority 4 (shed first) |
| `capture` player props | day / near ticks (on by default) | NFL, NCAAF | `/events/{id}/odds` | 33 + 26 alternates | `us,eu` (2) | ≤ 118 per event | to 30 h, 20-min near interval | part of ~4,660 | **No: a duplicate of row 1** | Off by default; when on, it shares the `props` fingerprint, so it gets a cache hit |
| `close` | pg_cron (schedule in the database only) | sports with pending signals | `/odds` | h2h, spreads, totals | `us,eu` (2) | 6 per sport | ≤ every 35 min while games are pending | part of ~4,660 | Yes: closing lines | `close` category, the same fingerprint as `featured`, so a fresh board snapshot serves it free |
| `collective_odds_ingest` | its own pg_cron, admin "Run now" / "Probe" | NFL, NCAAF | `/odds` | h2h, spreads, totals | `us` (1) | 3 | 60 s live, 300 s pregame (NFL), **only if `provider.default='theoddsapi'`** | unknown (default provider is OddsBlaze) | Optional | `collective` category through the gateway; the probe is the free quota probe |
| `edgedesk_ai` quote refresh → untiered `capture` | a signed-in reader's board question, only with `EDGEDESK_QUOTE_REFRESH=1` | every sport | as `capture` | as `capture` | as `capture` | a full capture | per question per sport | unknown | Optional | An untiered call is now the **day** tier narrowed to the asked sport, served from cache inside its cadence |
| `cfb-lab.yml` → `alternates.js` | hourly, gated by `READ_ALT_CAPTURE` | NCAAF, NFL | `/events/{id}/odds` | alternates | 1 | ≤ 2 | 0 (skipped in 33/33 sampled runs [obs]) | 0 [obs] | Optional | `alternates` category |
| `props-factory.yml` backfill | manual | NFL, NCAAF | historical event odds | 17 | 1 | 10× | 0 [obs] | 0 | Research only | `historical_*` categories, **off**, never part of polling |
| Deployed-only functions (`odds`, `wta_odds`, `wta_close`, `cfb_close`, `close_backfill`, `capture_boards`, `model_conf_odds`, `ingest_multisport`, `run_slate`, `scores_diag`) | the database's `cron.job` | ? | ? | ? | ? | ? | ? | **not auditable from the repo** | — | Their jobs are paused by the emergency stop and never auto-resumed; unset `ODDS_API_KEY` (§9) |

The props path's cost per call is observed. The split of the ~4,660/day
Supabase-side spend across `capture`, `close` and `collective_odds_ingest` is
not observable from GitHub. From now on the gateway's ledger records it per
caller.

---

## 3. What changed

### Phase 1 — emergency stop (`supabase/odds_api_emergency_stop.sql`)

Standalone, under 18 KB, safe to paste first:

- `odds_api_config` holds the circuit breaker `odds_api_enabled`, created **false** (fail closed), with the monthly budget and daily target at **zero**.
- `odds_api_emergency_stop(reason)` pauses (`cron.alter_job(..., active := false)`) every pg_cron job whose command can reach a paid path:
  - capture, capture_poke, close, collective_odds_ingest, props_cron;
  - plus every deployed-only odds function listed in §2.
  - Each job is recorded in `odds_api_paused_jobs`. **Nothing is unscheduled or deleted.**
- `odds_api_resume_schedules(by)` resumes only the jobs whose functions now go through the gateway. The deployed-only ones stay paused.
- Its report prints 4 rows; every row should say `ok`.

### Phase 3 — one gateway

- **`supabase/functions/odds_gateway/index.ts`** is the only code that reads the provider key (`ODDS_GATEWAY_PROVIDER_KEY`, falling back to `ODDS_API_KEY`) or names `api.the-odds-api.com`.
  - It asks the control plane for a decision before every request.
  - It settles every request with the provider's `x-requests-used / -remaining / -last`.
  - It redacts the key from every message.
  - Retries happen only for network errors and 500/502/503/504: at most 2, with backoff of 1 s → 2 s plus jitter, capped at 4 s. Each retry is a new budget check.
  - It **never** retries a timeout (it may have been billed), a 429 or a 401.
  - A quota 429 or a 401 trips the breaker.
- **`supabase/odds_api_gateway.sql`** is the control plane, with SQL-editor parts in `supabase/parts/odds_api_gateway.part*-of-6.sql`.
  - `odds_api_acquire` locks the single config row `FOR UPDATE`, then returns one of:
    - `cache_hit`, a snapshot inside the event-aware interval;
    - `in_flight`, the same fingerprint already leased (single flight);
    - `skipped_live`, `skipped_completed`, `skipped_window`;
    - `denied_*`: breaker, category, cooldown, no budget, unconfirmed quota, ceiling, emergency, reserve, daily budget;
    - `granted`, which reserves an upper-bound cost.
  - `odds_api_settle` reconciles the reservation against `x-requests-last`. It stores the snapshot, learns event kickoffs, raises alerts and trips the breaker.
  - Tables:
    - `odds_api_requests` is the ledger: one row per decision, secrets never stored.
    - `odds_api_snapshots` holds the latest body per fingerprint.
    - `odds_api_events`, `odds_api_alerts`, `odds_api_job_locks` and `odds_api_consumer_marks`.
  - Retention runs through `odds_api_prune()` (pg_cron `37 4 * * *`). It calls no provider.
- **Every caller was rewired.**

  | Caller | Category |
  |---|---|
  | `capture` | `featured`, `alternates`, `props` / `props_alt` |
  | `close` | `close` |
  | `collective_odds_ingest` | `collective`; OddsBlaze untouched |
  | `football/props/capture.js` | `events_index`, `props` |
  | `football/cfb_terminal/alternates.js` | `alternates` |
  | `football/props/factory/odds.js` | `historical_*`, off |

  - `football/enrichment/providers/market.js` no longer makes any network call.
  - The Node jobs share one client, `tools/lib/odds_gateway.js`, which has no retry loop.
- **Fingerprints are shared:** endpoint | sport | event | canonical markets | bookmakers | format | date.
  - A category always asks for its full canonical market set, so two callers of one category share one fetch.
  - `close` shares `featured`'s fingerprint.
- **Job locks** (`odds_api_job_lock`) stop overlapping capture runs of the same tier (`skipped_overlap`).

### Phase 4 / 7 — event-aware polling and cheaper requests

These are **upper limits** on how often a snapshot may be re-bought. Ticks
inside the interval are free cache hits.

| Category | < 3 h | 3–24 h | 24–72 h | beyond |
|---|---|---|---|---|
| Main markets (`featured`, `close`, `collective`) | 20 min | 60 min | 120 min | 360 min |
| NFL props (11 core markets) | 60 min | 120 min | 360 min to 48 h | not polled |
| CFB props | 60 min | 180 min | not polled | not polled |
| Alternates, extra props, alt props | 120 min | 360 min | not polled | not polled |

Other rules:
- Live and completed events are never polled. A completed event stops 5 h after kickoff.
- A sport-level request uses the sport's nearest kickoff.
- **Every interval stretches with the shed level** (×1 / 1.5 / 2 / 3 / 4).
- **Each category and sport can be disabled:** `odds_api_set_category`, `odds_api_set_sport`.
- **Bookmakers:** a 10-book list (pinnacle, betonlineag, draftkings, fanduel, betmgm, williamhill_us, betrivers, bovada, espnbet, hardrockbet) bills as 1 region instead of `us,eu`'s 2, and keeps Pinnacle.
- **Props:** 11 core markets by default. `props_extra` and `props_alt` are off.
- **Historical:** `historical_*` is off and never part of polling.
- **Sports:** a fixed list (NFL and NCAAF at priority 1; MMA and MLB at priority 3) replaces the discovery of every active sport.
- **No fetch is triggered by user activity:**
  - a reader's Refresh is never forced, and is answered from the feed state while paused;
  - `edgedesk_ai`'s untiered capture call is the day tier narrowed to one sport;
  - model recalculation reads stored snapshots only.

Schedules:

| Schedule | Before | After |
|---|---|---|
| `capture_cron.sql` near | `*/10` | `*/20` |
| `capture_cron.sql` day | `4,34` | `4 * * * *` |
| `capture_cron.sql` board | `18 */4` | `18 */6` |
| `capture.yml` day | `26 * * * *` with `curl --retry 2` | `26 */3 * * *`, no retry |
| `player_props_cron.sql` | `*/5` | `*/15` |
| `player-props.yml` | `8,23,38,53` | `8,38` |

### Phase 5 — cache first

- Every snapshot carries `fetched_at`, `last_attempt_at`, `last_status` and its fingerprint.
- Callers keep their own stores as before: `signals`, the props `quotes.json`, `odds.events`. What they now receive from the gateway is the snapshot and its age. A consumer mark tells each consumer whether that fetch is new to it, so one fetch is processed once per consumer.
- **The frontend never calls the gateway or the provider.**
  - `app.html` reads the public `rpc/odds_feed_status`, which reports live / paused / degraded, each sport's `last_verified_at`, age, next kickoff and expected refresh interval.
  - It shows an amber "refresh paused" banner and cadence-aware stale thresholds. A paused feed is never presented as current.

### Phase 6 — the monthly budget (after recovery)

- `odds_api_apply_recovery_budget()` sets **60,000 operational, 40,000 reserve, 1,500/day initial**.
- **Spend** is `greatest(ledger, provider_used + open reservations)`, so provider usage from outside the gateway still counts. The `untracked_provider_usage` alert flags it.
- **A new cycle's quota is never assumed.** Paid calls wait for a provider header observed in the current cycle, from the free quota probe or `odds_api_confirm_quota`.
- **Daily allowance** = `min(daily_target × day_weight, remaining_budget × day_weight / Σ remaining day weights)`.
  - Day weights: Sat 1.6, Sun 1.5, Tue/Wed 0.6, other days 1.0.
- **Shedding**, measured against today's allowance:

  | Share of allowance | Shed level | What is admitted |
  |---|---|---|
  | 60% | 1 | optional (alternates) off |
  | 80% | 2 | props and far events off |
  | 100% | 3 | only priority-1 main markets inside 24 h |
  | 125% | 4 | nothing paid; cache only |

  - Past 80% of the month, the shed level is at least 2.
- **Alerts** at 50% (warning) and 80% (critical).
- **At 95%** the breaker trips. It latches until a person turns it back on.
- **The ceiling fails closed:** a request that would cross it is refused and trips the breaker.
- **The reservation is atomic:** the config row lock serialises every decision. It is tested with 12 concurrent sessions on one fingerprint (one fetch) and 16 on separate events (reservations stop at the shedding line).

### Phase 8 — observability

**`admin/odds-usage/`** is the operator console. It calls only `rpc/odds_api_dashboard`, which is restricted to admins and the service role, so it never calls the provider. It shows:
- breaker state;
- today's and the month's spend, remaining credits, projected cycle spend and the next reset;
- a budget meter and a daily credits chart;
- spend by caller, sport and endpoint, and props spend;
- cache hit rate and duplicates collapsed;
- freshness per sport and category;
- recent decisions;
- alerts, with an acknowledge button;
- a **Pause paid retrieval** button. Turning retrieval back on is never a click: it is a SQL-editor act.

**`.github/workflows/odds-budget-watch.yml`** runs hourly and spends zero credits. It fails on an unacknowledged critical or emergency alert, or on a day past its overdraft while the breaker is on.

### Phase 9 — validation (all mocked; zero paid calls)

| Suite | What it proves |
|---|---|
| `tools/odds/gateway_sql.test.js` (71) | The control plane on a real PostgreSQL: fail-closed defaults; single flight across 12 concurrent sessions; reservations across 16; single flight; shedding order; stretch; emergency and ceiling trips; reserve; unconfirmed quota; live and completed skips; event clock; RLS and grants; the emergency stop pauses and never deletes |
| `tools/odds/gateway_fn.test.js` (49) | The deployed gateway end to end against a mock provider: concurrent users collapse to one fetch; overlapping cron; props windows; 429 trips with no retry; 401; timeout with no retry; 503 retried at most twice; key redaction; kill switch; cache hits cost zero; expired games skipped |
| `tools/odds/no_bypass.test.js` (27) | Static guard over the whole repository: only `odds_gateway` holds the key or names the host; no workflow maps the key; no browser file reaches the gateway; every former caller asks the gateway; the emergency stop covers every spender; a reader cannot buy odds |
| `tools/odds/budget_watch.test.js` (12) | What turns the watch red, and that it reads the ledger only |
| Rewired callers | `capture.test.js` (342), `pricer_parity` (56), `capture_feed` (19), `props_cron` (37), `props_freshness` (110), `props/pipeline` (153), `alternates` (49), `factory/odds` (17) |

These suites run on every pull request in `.github/workflows/odds-gateway-tests.yml`.

---

## 4. Before and after

Per-day averages for an in-season NFL + CFB week. "After" is the most the
cadence admits [est]. The budget caps it again: shedding begins at 60% of each
day's allowance.

| Path | Before [obs / derived] | After, cadence-bounded [est] | How it was estimated |
|---|---|---|---|
| Player props | 5,775 | ~850 | NFL ~15 games × ~17 polls × ~10 credits/week; CFB ~45 games × ~10 polls × ~7.5 credits/week |
| Game lines (`featured`; `close` shares the fingerprint) | (in 4,660) | ~185 | 3 credits per sport request; NFL ~150 and NCAAF ~185 requests/week; MMA and MLB ~40/day |
| Alternates | (in 4,660) | ~130 | ~5–6 polls × 2 markets per event inside 24 h |
| `capture`'s duplicate prop pass | (in 4,660) | 0 | off; a cache hit if turned on |
| `collective_odds_ingest` | (in 4,660) | 0 unless switched to The Odds API | then ≤ the `featured` cadence at 3 credits |
| Retries and duplicate runs | (in 4,660) | ~0 | no whole-run retries; single flight; job locks |
| **Total** | **~10,440/day** | **~1,165/day** (Saturday peak bounded by its 2,400 allowance + 25%) | |
| **Month** | **~100K in 9.5 days** | **~35K/month** expected; **60K hard operational ceiling**; 40K reserve untouched | |

**Savings:** about **89%** per day (10,440 → ~1,165). The worst case is
bounded by construction: 60,000 a month, and the breaker latches at 57,000.

### Freshness tradeoffs

| What | Before | After |
|---|---|---|
| Game lines inside 3 h | ≤ 10 min | ≤ 20 min |
| Game lines 3–24 h | ≤ 30 min | ≤ 60 min |
| Game lines beyond 72 h | ≤ 4 h | ≤ 6 h |
| Closing lines (CLV) | close's own fetch at the window | the latest board snapshot, ≤ 20 min old at kickoff |
| Player props inside 3 h | 15 min | 60 min. A prop EV is executable for 30 min after each refresh, then labelled aging, never shown as current |
| Player props 3–24 h | 30–60 min | 120 min (NFL), 180 min (CFB) |
| Props windows | 96 h both leagues | NFL 48 h, CFB 24 h. Earlier props show the last stored price, labelled with its age |
| Prop markets | 20 / 17 incl. alternates and longest | 11 core. Extra and alternate ladders are off (`odds_api_set_category` turns them on) |
| Alternate spread / total ladders | to 30 h | to 24 h; the first thing shed on a heavy day |
| Book coverage | `us,eu` | a 10-book list including Pinnacle (same anchor, half the cost) |
| Live odds | polled | not polled (pregame research product) |
| Manual Refresh | forced capture of anything older than 10 min | a gateway-cadence capture of anything older than 60 min; answered from stored data while paused |

Until 2026-11-01 nothing is re-bought. Every page serves the last stored
snapshot with its true age, and the amber banner says refresh is paused.

---

## 5. Files

| File | Change |
|---|---|
| `supabase/odds_api_emergency_stop.sql` | **new**: breaker, zero budget, pause or resume jobs |
| `supabase/odds_api_gateway.sql` (+ `supabase/parts/odds_api_gateway.part1..6-of-6.sql`) | **new**: control plane, ledger, snapshots, budget, alerts, dashboard, feed status |
| `supabase/functions/odds_gateway/index.ts` | **new**: the only holder of the key |
| `tools/lib/odds_gateway.js` | **new**: the shared Node client |
| `supabase/functions/capture/index.ts` | gateway; fixed sports; job lock; untiered = day; prop pass off; alternates to 24 h |
| `supabase/functions/close/index.ts` | gateway (`close` category) |
| `supabase/functions/collective_odds_ingest/index.ts` | The Odds API provider goes through the gateway |
| `supabase/functions/props_cron/index.ts` | feed-state aware; never forces a capture |
| `football/props/capture.js`, `config.js` | gateway; core markets; 48 h / 24 h windows; 1 attempt |
| `lib/edgedesk_props.js` | cadence 60/120/360; manual 60 min; `PROVIDER_PAUSED` health |
| `football/cfb_terminal/alternates.js`, `football/props/factory/odds.js`, `run.js` | gateway |
| `football/enrichment/providers/market.js` | no network |
| `supabase/capture_cron.sql`, `supabase/player_props_cron.sql` | slower schedules; `capture_poke` respects the breaker |
| `.github/workflows/capture.yml`, `player-props.yml`, `cfb-lab.yml`, `props-factory.yml` | no provider key on any runner; no curl retry; slower crons |
| `.github/workflows/odds-gateway-tests.yml`, `odds-budget-watch.yml`, `deploy-odds-gateway.yml` | **new** |
| `app.html` | paused banner; cadence-aware staleness |
| `admin/odds-usage/index.html` | **new** operator console |
| `tools/odds/*.test.js`, `tools/odds/budget_watch.js` | **new** |

---

## 6. Migrations

Apply them in this order. Each one is idempotent and additive, and ends in a
report where every row should say `ok`.

1. `supabase/odds_api_emergency_stop.sql`. **Apply now.** It re-pauses on every run, which is its purpose, so do not re-run it after recovery unless you mean to stop again.
2. `supabase/odds_api_gateway.sql` (or its six parts, in order). It leaves the breaker and any operator settings as they are.
3. `supabase/capture_cron.sql` and `supabase/player_props_cron.sql`. These are the new cadences. As they always have, they replace their jobs by name (unschedule, then schedule) and the new jobs are **active**. That is harmless while paused, because `capture_poke` and `props_cron` check the breaker before doing anything. The runbook applies them at step 10.

The **Deploy odds gateway** workflow applies 1 (opt-in) and 2 when the
`SB_DB_URL` secret exists. Otherwise paste them into the SQL editor.

## 7. Cron changes

- Paused by the emergency stop (recorded in `odds_api_paused_jobs`): every
  `cron.job` whose command matches `odds_api_spend_patterns()`.
- Re-schedules come from the files above (§3, Phase 4 / 7 schedules table).
- `odds_api_prune` is added at `37 4 * * *`. It makes no provider call.
- Jobs reported but not paused (`settle`, `tennis_ingest`,
  `mark_provider_exhausted`) appear in `odds_api_suspect_patterns()`. Inspect
  them by hand.

## 8. Predicted use

| | Daily | Monthly |
|---|---|---|
| Expected (cadence-bounded, in season) | ~1,000–1,400 (Sat up to ~2,400) | ~30–42K |
| Allowed | 1,500 × day weight (+25% overdraft before nothing is bought) | 60,000 operational |
| Never touched | — | 40,000 reserve for spikes |

---

## 9. Safe re-enable procedure

### Now (2026-10-10)

1. Paste `supabase/odds_api_emergency_stop.sql` into the SQL editor and run it. Every report row should say `ok`.
2. Find anything the repository cannot see:

   ```sql
   select jobid, jobname, schedule, active, command from cron.job
   where command ilike any (array['%odds%','%close%','%capture%','%props%','%collective%']);
   ```

   Pause anything still active that can spend:
   `select cron.alter_job(<jobid>, active := false);`
3. Paste `supabase/odds_api_gateway.sql` (or its parts) and run it. Every report row should say `ok`.
4. Supabase secrets (dashboard → Edge Functions → Secrets, or the CLI):
   - `ODDS_GATEWAY_PROVIDER_KEY=<the The Odds API key>`. If the provider account lets you regenerate the key, do it, and give the new key **only** to this secret.
   - Optional: `ODDS_GATEWAY_SECRET=<random>`, for callers without the service role.
5. Run **Actions → Deploy odds gateway** with the defaults: gateway SQL, `odds_gateway`, then the callers. Every caller now refuses to buy while the breaker is off.
6. Remove the key from everywhere else:
   - `supabase secrets unset ODDS_API_KEY THE_ODDS_API_KEY`;
   - delete the GitHub secret `ODDS_API_KEY`.

   Any deployed-only function that still held it stops. If anything still spends, the provider's `x-requests-used` grows past the ledger and `untracked_provider_usage` fires.

### On or after 2026-11-01 00:00 UTC

7. Set the budget, then turn the breaker on. Paid calls stay refused until the quota is confirmed in step 8.

   ```sql
   select public.odds_api_apply_recovery_budget();   -- 60,000 / 40,000 / 1,500
   select public.odds_api_set_enabled(true, 'November cycle: 60K operational budget', '<your name>');
   ```

8. Confirm the new cycle's quota. Either:
   - call the free probe with the service role:

     ```
     curl -sS -X POST "$SB_URL/functions/v1/odds_gateway" -H "authorization: Bearer $SERVICE_ROLE" \
       -H 'content-type: application/json' -d '{"action":"quota_probe"}'
     ```

     It makes one free `/v4/sports` call and records the headers;
   - or read the provider's account page and run
     `select public.odds_api_confirm_quota(<used>, <remaining>, 'provider account page');`.

9. Open `admin/odds-usage/`. Check that `quota_confirmed` is true, the threshold is `normal` and the breaker is ON.
10. Resume the schedules, then apply the new cadences:

    ```sql
    select public.odds_api_resume_schedules('<your name>');
    ```

    Only gateway-routed jobs come back. Then apply `supabase/capture_cron.sql` and `supabase/player_props_cron.sql`, which replace the capture and props jobs with the slower schedules. A job those files already replaced is reported under `kept` by the resume, which is expected.
11. Watch the first hour on `admin/odds-usage/`:
    - the cache hit rate should climb above 80%;
    - spend should match the cadence table;
    - nothing should come from an unknown caller.

    The budget watch runs at :41 every hour.

### No October bridge

The provider reported 0 credits remaining at 13:55Z on 2026-10-10, so nothing
can be bought before the reset. Every page serves its last stored prices,
labelled with their age.

### To stop again at any time

Use the **Pause paid retrieval** button on `admin/odds-usage/`, or run:

```sql
select public.odds_api_set_enabled(false, '<reason>', '<you>');
```

For the full stop including schedules, re-run
`supabase/odds_api_emergency_stop.sql`.

---

## 10. Open items to check in production

- **`EDGEDESK_QUOTE_REFRESH`** on `edgedesk_ai` (`GET edgedesk_ai?probe=1` → `board.quote_refresh.enabled`). It is now safe either way, because an untiered capture is the day tier for one sport, served from cache. It is still worth knowing.
- **`odds.settings` `provider.default`** for `collective_odds_ingest`. If it is `theoddsapi`, its polls now spend from the shared budget at the `collective` cadence.
- **The deployed-only functions listed in §2.** Their source is not in the repository. Download them with `tools/supabase/download_functions.sh` and either route them through the gateway or retire them. Their jobs stay paused.
- **`collective_odds_ingest`'s clock-based live state.** It never writes `final`. Through the gateway, live and completed events are refused regardless.
