# CFB jobs, locks, errors and logs

The registry is code: `football/cfb_production/jobs.json` (seeded into
`cfb_job_registry` by supabase/cfb_production.sql; `tests.js` proves every
cron below is the cron actually in its workflow or pg_cron file, and that the
SQL seed is generated from the JSON). `node football/cfb_production/jobs.js`
prints drift and the collision analysis.

## 1. Every scheduled job the CFB pathway depends on

| job | where | schedule (UTC) | purpose | duration (basis) / timeout min | lock | deadline, alert |
|---|---|---|---|---|---|---|
| `cfb_lab_hourly` | cfb-lab.yml | pg_cron `7 * * * *` (primary) + GitHub `37 * * 8-12,1 *` (backup) | Model Lab: market capture, checkpoint snapshots, settlement, reports; decision shadow; mirror | ~0.5 min (measured: runs 36328364895, 36332033317) / 30 | gate lease `cfb_lab_hourly/<season>` + concurrency group | 150 min, CRITICAL |
| `cfb_weekly_refresh` | cfb-v2-shadow.yml | pg_cron Sun/Mon 10:05, Tue 12:07, Wed–Sat 10:47 + GitHub Sun/Mon 10:05, Tue 12:17, Wed–Sat 10:47 (Aug–Jan) | weekly engine: finals, PBP, team/QB/unit state, V2.1 projections, EARLY freeze, mirror | ~35 min (estimate: no completed run yet) / 90 | gate lease `cfb_weekly_refresh/<season>`, re-entered by the mirror | 26 h, CRITICAL |
| `cfb_v1_board_build` | football-weekly-build.yml | `40 9 * 8-12,1 *`, `20 */2 * 8-12,1 *`, Tue `40 9` off season | V1 champion board `football/fbs/slate.json` (the fallback) | 1–4 min (measured, 15 runs) / 90 | concurrency group `football-weekly-build` | 26 h, WARNING |
| `cfb_enrichment` | football-enrichment.yml | Sat hourly, Sun 00–05, Fri every 2 h, Sun–Thu every 6 h (Sep–Jan) | V1 board enrichment | ~10 min (estimate) / 30 | group `football-weekly-build` (shared with the board) | 8 h, WARNING |
| `cfb_odds_capture` | supabase/capture_cron.sql | `*/10`, `4,34 * * * *`, `18 */4 * * *` | per-book odds into `cfb_lab_market_quotes` via `cfb_lab_ingest_quotes()` | < 1 min (estimate) / 5 | advisory xact lock `cfb_lab_ingest_quotes`, row-level inserts | 60 min via `odds_freshness` (no heartbeat: edge function) |
| `cfb_football_record` | football-model-record.yml | `47 * * 8-12,1 *`, Mon `47 12` off season | public V1 record | ~5 min (estimate) / 30 | group `football-model-record` | 150 min, WARNING |
| `cfb_availability_sync` | availability-sync.yml | hourly Fri/Sat, 3-hourly Tue–Thu, 6-hourly Sun/Mon (+ evening extras) | injury / availability reports | ~10 min (estimate) / 30 | group `availability-sync` | 8 h, WARNING |
| `cfb_starter_context` | starter-context.yml | Sun/Mon 07:20, 19:20; Tue–Fri 13:20; Sat 13:20, 21:20 | QB starter context (the QB-status source) | ~15 min (estimate) / 45 | group `starter-context` | 26 h, WARNING |
| `cfb_roster_sync` | roster-sync.yml | Mon 10:00 | rosters (8-day freshness bound) | ~10 min (estimate) / 360 (no timeout set) | group `roster-sync` | 8 d, INFO |

**Retry behavior.** Provider calls: bounded jittered retries per provider
policy (PROVIDERS.md); the weekly engine's fetch: `runlog.retry` (4 attempts,
TRANSIENT / RATE_LIMIT only); every Postgres write: `db.js` (below). A job
itself is never re-run automatically: the next scheduled run is the retry, and
every job is idempotent (§6). **Failure alert.** A red GitHub run; the gate's
finish step opens an incident (`JOB_FAILED:<job>:<date>`, severity from the
registry); a missed heartbeat deadline turns `cfb_health.cron_heartbeats`
WARNING / CRITICAL. Only the two gated jobs send heartbeats today; the others
show as "never reported (not wired)" and are watched through the freshness of
what they produce.

**Dependencies.** capture → lab (quotes); weekly engine (Tue freeze) → lab
(`gh workflow run cfb-lab.yml` hand-off); board build → lab (V1 adapter),
record; starter context / availability / rosters → weekly engine source health
and the board.

**Not scheduled (findings).** `football/cfb_personnel/sync_supabase.js` is run
by no workflow: the personnel tables in Postgres are never filled by
automation. `cfb_lab_lines` (a database-side lines job of an earlier install) is
unscheduled by cfb_lab_cron.sql: rejected, it raced the ledger mirror.

## 2. Collisions and staggering (week of 2026-10-04, GitHub start delay allowance 60 min)

GitHub's scheduler starts late: in the measured runs of 2026-09-25..27 the
board build started 29–51 minutes after its cron. The analysis therefore
widens every GitHub window by 60 minutes; pg_cron windows are exact.

| pair | class | overlapping windows | verdict |
|---|---|---|---|
| lab × lab, weekly × weekly (two clocks) | SERIALIZED | 334 / 7 | concurrency group queues the second; both idempotent (checkpoint slots, write-once freeze) |
| board build × enrichment | SERIALIZED | 64 | same group `football-weekly-build`; both write `football/fbs/slate.json` |
| lab × capture | DB_CONCURRENT | 1 379 | disjoint rows of `cfb_lab_market_quotes` (the mirror sends non-odds_api sources, capture odds_api), append-only inserts, no shared lock order |
| lab × football record | WRITE_COLLISION (pathspec) | 502 | the record job stages `record/football/`, which contains the lab's `cfb_model_lab.json`; its scripts never write that file (grep of tools/record), so the overlap is benign; runs ≤ 1 min apart in practice (:07/:37 vs :47) |
| **board build × starter context** | **WRITE_COLLISION** | 20 | starter-context stages all of `football/fbs/` (slate.json, coverage.json) outside the `football-weekly-build` group: the later push wins those files. Mitigation for the V1 owners: put starter-context in the `football-weekly-build` concurrency group or narrow its pathspec. Not changed here (not a CFB production workflow). |
| enrichment × starter context | WRITE_COLLISION | 15 | the same `football/fbs/` overlap |
| weekly × starter context / availability / rosters / board | READ_RACE | 1–22 | the weekly run checks out main at its start; a concurrent source update is seen next run. Roster sync (Mon 10:00) and the Monday weekly run (10:05) overlap, but rosters are not a pure-model input and their bound is 8 days: no stagger needed |
| lab × board / enrichment / starter context | READ_RACE | 30–272 | the lab reads the committed slate; the V1 snapshot is from the previous board |

No CFB production schedule was moved: the only write collisions are in the
V1 pipeline (above) and in pathspecs that do not write the shared file.

## 3. Locks

* **Weekly refresh: one writer of team state.** `gate.js start` takes
  `cfb_job_lock('cfb_weekly_refresh', <season>, holder, 6000 s)`; a second run
  gets `acquired: false` and exits cleanly (heartbeat `SKIPPED_LOCKED`,
  `PIPELINE_CONFLICT`). The lease id and holder are exported to the job's later
  steps, so the mirror's own `withJobLock` re-enters the same lease instead of
  competing. A lease whose holder crashed expires and is taken over (logged
  WARNING, `TAKEOVER_EXPIRED`); renew and release need the lease id (fencing).
  The engine's file lock (`runlog.RunLock`) remains for local runs.
* **Per-game refreshes.** `locks.withGameLocks({ job: 'cfb_game_refresh' },
  gameIds, fn)` locks games in sorted order (no opposite-order waits between
  two multi-game jobs), skips a game another job holds (e.g. a QB-news refresh)
  and releases in `finally`. No event-driven per-game refresh job exists today;
  any new one must use this.
* **Order.** Inside Postgres every routine write takes its advisory lock first
  (two-int key space `hashtext('cfb_job_lock' | 'cfb_production')`, never
  colliding with the lab's one-key locks), then touches one row.
* **Before the migration is applied** the lock RPC answers 404; jobs then run
  under their concurrency group only and log it.
* **A Supabase outage never stops capture or the freeze.** When the kill switch
  or the lock cannot be *read* (network error, DATABASE_UNAVAILABLE, a 5xx after
  the retries — not a 404 / schema answer), the gate proceeds under the workflow
  concurrency group with `decisions=false`, `lock=none (unavailable: <code>)`,
  a WARNING log line and a best-effort incident: market capture and the weekly
  freeze are append-only observations that can never be re-taken, while
  decisions are the only output that must fail closed. A flag that *reads* off
  still stops the job. The weekly workflow mirrors to Supabase only after the
  git publish and the Model Lab hand-off, so an outage never costs a freeze.
* **Strict mode.** Set the repository variable `CFB_REQUIRE_JOB_LOCK=1` once
  `cfb_production.sql` is applied: from then on a missing or unreadable lock or
  flag fails closed (the job does not proceed).

## 4. Error taxonomy (`taxonomy.js`, mirrored in SQL `cfb_error_codes()`)

| code | runlog class | retried (attempts) | default severity |
|---|---|---|---|
| DATA_STALE, DATA_MISSING, TEAM_MAPPING, PLAYER_MAPPING, MODEL_INPUT, MARKET_INVALID | DATA_QUALITY | no | WARNING |
| PROVIDER_TRANSIENT (timeout, 5xx, network) | TRANSIENT | yes (4) | WARNING |
| PROVIDER_RATE_LIMIT (429, Retry-After honoured) | RATE_LIMIT | yes (4) | WARNING |
| PROVIDER_REJECTED (permanent 4xx), PROVIDER_SCHEMA, MODEL_ARTIFACT, CALIBRATION, DATABASE_SCHEMA | SCHEMA | no | WARNING / CRITICAL |
| AUTH (401/403, 28xxx, 42501) | AUTH | no | CRITICAL |
| DATABASE_DEADLOCK (40P01, 40001) | DATABASE | yes (5) | WARNING, CRITICAL when exhausted |
| DATABASE_TIMEOUT (55P03, 57014) | DATABASE | yes (3) | WARNING |
| DATABASE_UNAVAILABLE (08, 53, 57P0x, PGRST000-002) | TRANSIENT | yes (8, about 1.5-3 min) | WARNING |
| DATABASE_CONSTRAINT (23xxx, 22xxx, P0001, append-only refusals) | DATABASE | no | WARNING |
| PIPELINE_CONFLICT (lock held) | DATABASE (as `RunLock`) | no — clean exit | INFO |
| UNKNOWN | UNKNOWN | no | WARNING |

PostgREST answers 40P01, 55P03, 57014 and 25P02 all with HTTP 500: the body's
SQLSTATE decides, and a 500 naming an unmapped SQLSTATE is UNKNOWN (never
retried as transient). The provider layer's classes (PROVIDERS.md §2) map onto
these codes. `runlog.classify_error` was fixed to stop reading numbers inside
ids as HTTP statuses (an ESPN game id `401628374` was AUTH, team `2503` was a
retryable TRANSIENT); `tests_weekly.py` and `tests.js` hold the cases.

## 5. Structured logging and correlation ids

One JSON object per line (`log.js`): `ts, level, job, correlation_id, run_id,
stage, event` plus `game_id, model_version, provider, error_code, runlog_class,
duration_ms` where they apply. `correlation_id` is set once per workflow run
(`CFB_CORRELATION_ID = cfb-<workflow>-<run_id>-<attempt>`, job-level env of
cfb-lab.yml and cfb-v2-shadow.yml) and is carried into heartbeats, incidents
and lock events, so ingestion → features → prediction → decision of one run
share it; the weekly engine's own `run_id` (`cfbw_…`) is in its run record.
Keys naming a credential and bearer tokens / JWTs / `apikey=` values inside any
string are redacted before a line is written.

## 6. Idempotency (run 1×, 2×, 3× — `sql.test.js` section J)

| write path | result |
|---|---|
| weekly mirror (13 tables incl. feature snapshots, stage log, source health) | identical state after 1, 2, 3 runs; no duplicate natural key |
| personnel mirror (players, aliases, transfers) | identical |
| decision mirror (snapshots, eligibility, results) | identical |
| Model Lab mirror, the real committed ledger (predictions, quotes, lines, results, evaluations, governance) | identical |
| V2 mirror (331 replayed predictions, intervals, components) | identical |
| `cfb_lab_ingest_quotes` same payload 3× | written once, then duplicates |
| `cfb_lab_derive_lines` same instant 3× | identical lines |
| manifest push 3× | one row |
| a second weekly mirror while one holds the lock | exits with PIPELINE_CONFLICT, writes nothing |

Heartbeats, incident occurrences and lock events are run metadata and differ by
design.
