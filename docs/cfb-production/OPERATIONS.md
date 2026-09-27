# CFB operations: transactions, health, alerts, load, storage, recovery, cost

## 1. Database transaction audit (every CFB write path)

| writer | when | tables | transaction shape | locks taken | finding |
|---|---|---|---|---|---|
| `football/cfb_lab/sync_supabase.js` | hourly (lab job) | 12 `cfb_lab_*` + the two market-integrity tables (optional) | one POST per ≤ 500-row chunk **per key set**, `ON CONFLICT (id) DO NOTHING` | ROW EXCLUSIVE, index tuples | **was failing every run in production** (runs 36328364895 15:07Z and 36332033317 16:07Z, 2026-09-27: PostgREST `PGRST102 All object keys must match` on `cfb_lab_evaluations`, whose rows carry `tie_vs_open/close` only sometimes). Fixed in `db.js` (a chunk is split into runs of identical key sets). It also had no retry at all; now classified bounded retry |
| `football/cfb_decision/sync_supabase.js` | hourly | 11 `cfb_decision_*` | same | same | retried every HTTP 500 blindly (a 500 is also 25P02 / P0 errors); now by SQLSTATE |
| `football/cfb_weekly/sync_supabase.js` | weekly engine runs | 14 weekly tables | same, run row **last** (commit marker), under the weekly lease | same | wrote the run row FIRST (a mirror cut short left a PUBLISHED run without its state) and never mirrored `upcoming_game_features` (projections named feature snapshots the database did not have); both fixed |
| `football/cfb_v2/sync_supabase.js` | weekly engine runs | 4 V2 tables | parent (`cfb_predictions`) before children (FK) | same | no retry; now db.js |
| `football/cfb_personnel/sync_supabase.js` | **never scheduled** | 10 personnel tables | same | same | no workflow runs it (JOBS.md §1) |
| capture → `cfb_lab_ingest_quotes(jsonb)` | pg_cron, every 10 min | `cfb_lab_market_quotes` | one call = one transaction, row by row in `observed_at` order | `pg_advisory_xact_lock(hashtext('cfb_lab_ingest_quotes'))` for the whole call, then row inserts | serialises ingests (correct: the dedupe reads the latest row); lock hold = one batch |
| `cfb_lab_derive_lines`, `cfb_lab_set_role`, `cfb_market_admin_set_role`, `cfb_market_ingest_quotes` | ad hoc / by a person | lines, roles, audit | one call = one transaction | one advisory xact lock each, then rows | no two of them take two locks: no lock-order cycle is possible |
| `cfb_production.sql` functions (locks, heartbeats, incidents, flags, corrections, audit) | every gated job | one row each | one call = one transaction | advisory xact lock (two-int key space) → one row | the audit chain serialises its writers on purpose (rare events) |
| migrations (SQL editor / Deploy intelligence) | deploys | all | the whole file is one transaction in the editor | **ACCESS EXCLUSIVE on every table of the older CFB files** (DEPLOYMENT.md §3) | not in a routine flow; bounded by `lock_timeout` only in cfb_production.sql |
| weekly engine (python) | — | none (writes the repository ledger) | file lock `.weekly.lock` | — | no database connection |

**No routine flow** runs a table-wide UPDATE or DELETE (every CFB table is
append-only), holds a transaction longer than one ≤ 500-row insert or one
ingest batch, changes schema, or locks rows it does not insert. **Lock order is
deterministic**: rows go in ledger order (append-only files, so every re-run
sends them in the same order), key-set groups keep that order, and every
function takes its single advisory lock before its row. Two runs of one mirror
wait for each other rather than cycle, and the concurrency group / job lock keeps
them apart anyway. The mirror and capture write disjoint rows of
`cfb_lab_market_quotes` (non-odds_api vs odds_api sources).

## 2. Deadlock and lock-timeout protection

`football/cfb_production/db.js`, used by all five mirrors:

* **Classify** every failure (`taxonomy.js`): the SQLSTATE in PostgREST's body
  decides (40P01 / 55P03 / 57014 are all HTTP 500).
* **Deadlock (40P01, 40001):** the server has already rolled the chunk back;
  wait `d/2 + U(0, d/2)` with `d = min(4 s, 200 ms · 2^(n-1))` and retry, up to
  5 attempts; every occurrence is an incident (`cfb_record_incident`, one open
  incident per job × table × day, occurrences counted).
* **Lock timeout / statement timeout (55P03, 57014):** 3 attempts, same jitter.
* **Exhausted:** a CRITICAL `retries_exhausted` incident, then a `CfbError`
  carrying the code: the job's step fails; the failed chunk left nothing; the
  chunks before it are write-once and idempotent; the next run completes the
  mirror; readers of `*_published` never see the half.
* **Never retried:** constraint refusals, auth, schema, malformed requests, an
  unmapped SQLSTATE.

Proven on a real PostgreSQL (`sql.test.js` §H–I): two sessions locking rows in
opposite order → exactly one 40P01 victim whose earlier insert in the same
transaction is rolled back; the weekly mirror as the victim → retried once
after jitter, incident recorded, final state complete and identical; a lock held
past `lock_timeout` → retried then complete; held for good → exactly 3 attempts,
DATABASE_TIMEOUT, CRITICAL incident, nothing written.

## 3. Load, latency and indexes (`perf.js`, `reports/perf.json`)

The real schema, one full season of synthetic volume shaped like the ledgers
(312 000 spread quotes, 624 000 decision snapshots, the real lab ledger copied
across the season, 5 seasons of team state and projections), PostgreSQL 16;
30 timed runs of each read path fetching every row; "under load" = a writer
mirroring 40 000 decision rows and ingesting quotes while 6 other readers run.

| read path | p50 / p95 ms at rest | p50 / p95 ms under load | plan |
|---|---|---|---|
| `cfb_health()` (all 14 checks) | 90 / 105 | 96 / 285 | function |
| V2.1 projections of a week (published view) | 2.8 / 4.4 | 2.7 / 4.0 | seq scans (32 500 rows) |
| team state of a week (published view) | 1.6 / 2.0 | 1.4 / 2.3 | seq scans (13 600 rows) |
| latest quote per book for a game | 0.4 / 0.7 | 0.5 / 1.1 | `cfb_lab_quote_game_idx` |
| `cfb_lab_game_quotes(game)` | 0.7 / 1.0 | 0.7 / 1.2 | function |
| decisions of a game | 0.1 / 0.3 | 0.1 / 0.2 | `cfb_decision_snapshots_game` |
| **decision summary of a week** | 9 / 17 | 20 / 28 | `cfb_prod_decision_week_idx` (**added**) |
| lab predictions of a week | 0.7 / 1.2 | 0.8 / 1.0 | `cfb_lab_pred_week_idx` |
| newest odds_api quote (health) | 50 / 58 | 49 / 61 | seq scan |

**Budgets** (a regression is a change that breaks them at one season's
volume): user read paths p95 ≤ 50 ms under load; weekly summaries p95 ≤ 200 ms
under load; health / dashboard builders p95 ≤ 500 ms. **Writes never block
reads**: append-only inserts take ROW EXCLUSIVE; every user path stayed within
2× of its at-rest time under load.

**Index audit.** One index added, on evidence: the weekly decision summary
(Model Lab scorecard, dashboards) seq-scanned 624 000 rows, p95 **299 ms under
load** (budget 200) → `cfb_prod_decision_week_idx (season, week)` → **28 ms**.
Not added: the health check's newest-quote scan (50 ms at one season, ~250 ms
at five; add `(source, observed_at desc)` on `cfb_lab_market_quotes` past ~2 M
rows); the week views' seq scans (tables too small to benefit).

## 4. Storage growth and retention

Measured bytes per row in PostgreSQL (with indexes) × one season:

| data | rows / season | bytes / row | per season | 5 seasons |
|---|---|---|---|---|
| decision snapshots (2 engines × 8 books × ~30 quotes × 65 games × 20 weeks) | ~624 000 | 491 | **~300 MB** | ~1.5 GB |
| market quotes (spread; totals and moneyline would triple it) | ~312 000 | 372 | ~110 MB (~330 MB all markets) | 0.55–1.7 GB |
| Model Lab predictions (3 models × 8 checkpoints × 65 × 20) | ~31 000 | 2 254 | ~70 MB | ~350 MB |
| weekly projections / team state | ~6 500 / ~2 700 | 416 / 333 | ~3 MB / ~1 MB | small |
| heartbeats, incidents, audit, lock events | < 20 000 | < 1 000 | < 20 MB | small |

In git, the lab ledger costs ~3.4 KB per prediction row as JSON (2.3 MB for the
first 684 rows) → **~105 MB per season** of hourly commits; evaluations ~1.9 KB
per row. The PBP and research data (~2.1 GB under
`football/cfb_v2/research/data`, ~2.6 GB of `out_*` experiment outputs) are
gitignored runner / local scratch, not production storage.

**Retention.** Nothing required to reproduce a prediction is ever deleted:
frozen snapshots, feature snapshots, team state, projections, model inputs,
quotes (open / close reconstruction and staleness evidence), decisions and
results stay. Seasons older than the current + previous may be **archived**:
export the season's rows with a row-count and content-hash manifest, restore
the export into a scratch database and re-derive openers / closes and grades
from it (the replay proof), and only then move the rows to a per-season
partition or cold storage. Logs: GitHub Actions keeps run logs 90 days; the
structured incidents and heartbeats live in Postgres.

**Market quote compaction.** Compaction already happens at ingest:
`cfb_lab_ingest_quotes` stores a quote only when its price/line fingerprint
changed, plus a heartbeat every 6 h (every 50 min within 3 h of kickoff). The
remaining heartbeats are the evidence that a quote was still live at a moment —
the MARKET_STALE rule and a close replay need them — so no further deletion is
proposed. The biggest lever is upstream: a decision row per *changed* input
rather than per captured quote (owner: the decision engine).

## 5. Health checks, heartbeats, alerts, anomalies

`cfb_health(p_now)` returns one row per check (status OK / WARNING / CRITICAL):
`database`, `contracts`, `model_manifest`, `latest_team_state`,
`odds_freshness`, `pbp_freshness`, `prediction_freshness`, `cron_heartbeats`,
`open_incidents`, `deadlock_storm`, `job_locks`, `partial_sync`,
`fail_closed_betting`, `feature_flags`. Thresholds come from
`cfb_freshness_rules` — the engines' own bounds gathered, not retuned (odds 180
min = the decision policy's `stale_minutes`, critical 360 = the weekly
engine's market bound, only with a game inside 48 h; QB 36 h; injury 12 h;
roster 8 d; team state and projections 8 d / 15 d).

`health.js` writes `football/cfb_production/reports/ops.json` every hourly lab
run (with the database's `cfb_health()` when credentials exist), and
`admin/cfb-ops/` renders it (SYSTEM HEALTH, MODEL VERSION, LAST WEEKLY RUN,
SOURCE HEALTH, ODDS AGE, PBP AGE, FAILED JOBS, DEGRADED GAMES, PREDICTIONS,
BET DECISIONS, WARNINGS, INCIDENTS).

**Alerts and severities.**

| severity | raised when |
|---|---|
| **CRITICAL** | production model unavailable (incompatible tuple / artifact mismatch — the gate fails the job); a wrong sign (`SIGN_CONVENTION`); odds stale across the slate (> 360 min with games inside 48 h); weekly pipeline failure (`JOB_FAILED:cfb_weekly_refresh`); a missed heartbeat of a CRITICAL job; ≥ 10 deadlocks in an hour; a BET while betting is disabled; retries exhausted; output shapes of a broken pipeline (`AVG_SPREAD_SHIFT`, `MARKET_GAP_WIDESPREAD`, `PROB_NEAR_50`, `PROB_NEAR_90`, `OUT_OF_BOUNDS`, `HOME_EQUALS_AWAY`); the audit chain failing to verify |
| **WARNING** | odds 180–360 min old; PBP DEGRADED / STALE; a missed WARNING-job heartbeat; 3–9 deadlocks in an hour; an expired lease; a partial mirror older than 2 h; a kill switch off; `BET_SPIKE` (review; never auto-cancels); `CONFERENCE_MISSING`; quarantined quotes |
| **INFO** | a run skipped because another holds the lock (`PIPELINE_CONFLICT`) |

Minor warnings are not alerts: retries are log lines; an incident is opened
once per key and day and repeats only count occurrences. There is no paging
integration in this repository (no Slack / e-mail secrets): alerts surface as
a red GitHub run (e-mailed to watchers), an OPEN row in `cfb_incidents_current`
and the dashboard.

**Anomaly rules** (`anomaly.js`, run on V2.1's live rows every hour): sign
convention, home = away, out-of-bounds, average |margin| outside ½×–2× the
prior-week median, ≥ 50 % of priced games > 10 pts off the market, ≥ 90 % of
probabilities within 3 points of 50 %, ≥ 90 % beyond 88/12, BET count ≥ max(3,
3× median), an FBS conference with no game. Distribution rules need ≥ 10
games. They flag; they never change a number.

## 6. Backup, recovery and the disaster-recovery test

Recovery priorities, in order:

1. **The repository** — the source of truth for every ledger (lab, weekly,
   decisions), the frozen snapshots and every artifact; pushed by the jobs
   hourly; GitHub is its backup.
2. **The manifest and its artifacts** — every artifact file is pinned by git
   blob in `manifest.json`; `MF.verifyFromGit()` restores / proves them byte for byte.
3. **The Postgres mirror** — rebuildable from the ledgers by re-running the
   mirrors (idempotent, proven 1×/2×/3×).
4. **Operational state that exists only in Postgres** — `cfb_feature_flags`,
   `cfb_audit_log`, `cfb_incidents`, `cfb_data_corrections`, heartbeats,
   manifest rows: covered by Supabase's managed backups. Recommendation: a
   weekly `pg_dump -t 'public.cfb_*'` of these into artifact storage.

**The DR test** (`sql.test.js` §M, run in CI): the whole database is dumped
with `pg_dump -Fc` and restored into a new database; the manifest, the
compatibility matrix, the audit log, the flags, recent team state, feature
snapshots, projections, pipeline runs, lab predictions, quotes and incidents
are identical; the restored manifest still hashes to its content and says
NOT_RUN; every artifact it names is recoverable from git byte for byte; the
restored audit chain verifies; the append-only triggers still refuse a
rewrite; `cfb_health()` answers on the restored database.

## 7. Cost audit

| resource | measured / derived | note |
|---|---|---|
| GitHub Actions, Model Lab | ~0.5 min per run (2 measured runs), ~48 runs/day in season (pg_cron :07 + GitHub :37) → ~48 billed min/day | **pg_cron `cfb_lab_hourly` is `7 * * * *` all year** (the GitHub backup is Aug–Jan only): ~720 useless runs per off-season month. Recommendation for supabase/cfb_lab_cron.sql's owner: `7 * * 8-12,1 *` |
| GitHub Actions, weekly engine | 7 runs/week, ≤ 90 min each (no completed run yet to measure) | the dominant compute; the raw data cache is one per ISO week |
| GitHub Actions, V1 board build | 1–4 min × ~13 runs/day | currently failing on a live-data test (JOBS.md, findings) |
| Postgres storage | ~0.5 GB per season, decision snapshots ~60 % of it | §4 |
| Postgres load from the mirrors | every hourly lab mirror re-sends the whole ledger (~3 400 rows today, ignore-duplicates) | kept on purpose: it makes the mirror self-healing; a cursor would save egress but lose that |
| external calls | ESPN scoreboard ~12 calls per lab run (~580/day); capture 198 invocations/day across sports; CFBD / cfbfastR per weekly run | provider limits and breakers: PROVIDERS.md |

## 8. Rejected / idle infrastructure (listed, not deleted)

| item | status | recommendation |
|---|---|---|
| candidate 001 `edgedesk_cfb_v2.0.0` | snapshotted hourly by the lab (a third of lab prediction rows, ~35 MB/season in git); in current.json's shadow block; INCOMPATIBLE as a fallback | retire through governance once V2.1's live comparison no longer needs it |
| `cfb_lab_lines` pg_cron job | unscheduled by cfb_lab_cron.sql (it raced the ledger mirror) | nothing |
| `cfb_lab_derive_lines()` | kept ad hoc, parity-tested | keep |
| 11 of 18 tables of `cfb_v2_model.sql` (team week features, team ratings, availability, market snapshots, game feature snapshots, market decisions, backtest runs, calibration results, model monitoring, prediction misses, data dictionary) | no writer in the repository | leave (additive, empty, harmless); drop only after a person confirms nothing external writes them |
| `football/cfb_personnel/sync_supabase.js` | never scheduled | schedule it (with the weekly job) or retire the tables |
| personnel units, matchup residual | research; flags `cfb_player_model_enabled`, `cfb_matchup_correction_enabled` off | a new validated model version, if ever |
| `football/cfb_v2/research/out_*` (~2.6 GB) | gitignored local experiment outputs | not production; clean locally at will |
