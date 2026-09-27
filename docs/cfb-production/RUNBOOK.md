# CFB production runbook

Concise, operational. Every scenario: what you see, what the system already did
on its own, the exact investigation steps, and how to recover. Background:
[ARCHITECTURE.md](ARCHITECTURE.md), [JOBS.md](JOBS.md), [OPERATIONS.md](OPERATIONS.md).
Related runbooks from the market-integrity work: [PROVIDERS.md](PROVIDERS.md),
[MARKET_INTEGRITY.md](MARKET_INTEGRITY.md), [IDENTITY.md](IDENTITY.md).

**Ground rules, every time.** A missing BET is preferable to a false BET: never
switch betting on to "get something out". Never edit a ledger or an append-only
table; fixes are new rows (corrections, supersedes, new versions). Every manual
change goes through a function that audits it (`cfb_set_feature_flag`,
`cfb_record_correction`, `cfb_resolve_incident`, `governance.js`).

**First look, whatever the symptom** (SQL editor, or the dashboard
`admin/cfb-ops/`, which reads `football/cfb_production/reports/ops.json`):

```sql
select * from public.cfb_health(now());                       -- every check, one row each
select * from public.cfb_incidents_current where status = 'OPEN' order by last_at desc;
select * from public.cfb_job_heartbeat_status order by overdue desc, job;
select * from public.cfb_production_manifest_current;          -- what is deployed
```

```sh
node football/cfb_production/health.js --stdout | head -80   # the same report from the repository
node tools/cfb/release_check.js --skip-tests                 # manifest, artifacts, compatibility, jobs
```

Every structured log line carries `correlation_id` =
`cfb-<workflow>-<github run id>-<attempt>`; search the run's log for it.

---

## MONDAY REFRESH FAILED

**Symptom.** The Sunday/Monday 10:05 UTC run of `CFB V2 shadow`
(`.github/workflows/cfb-v2-shadow.yml`) is red; `cfb_health` shows
`cron_heartbeats` CRITICAL for `cfb_weekly_refresh` (26 h deadline) and an OPEN
incident `JOB_FAILED:cfb_weekly_refresh:<date>` (CRITICAL); the dashboard's LAST
WEEKLY RUN is CRITICAL.

**Automatic behavior.** Nothing half-done is published: the engine writes state
only after its release gate (`WRITE_STATE` needs `FREEZE_EARLY` needs
`RELEASE_GATE`), stages after a FAILED stage are BLOCKED, the Postgres mirror
writes the run row last, and `cfb_team_week_state_published` hides any state
whose run row never landed. The previous week's published state and frozen
snapshots keep serving. The weekly lock is released by the gate's finish step
(or expires after 100 min).

**Investigation.**
1. Open the failed run; find the first failed step. If it is `Production gate`:
   the artifact or compatibility check failed — go to MODEL ARTIFACT MISSING.
2. If the engine ran: `football/cfb_weekly/<season>/runs/<run_id>.json` (published
   even on failure) lists every stage with `status`, `error_class` and `error`.
   `error_class` is the runlog class; TRANSIENT / RATE_LIMIT were already retried
   4 times (`runlog.retry`), SCHEMA / DATA_QUALITY are permanent.
3. `RELEASE_GATE` FAILED = a sanity check refused the projections (NaN margin, a
   team in two games, probability 1): read `gate` in the run record. That is the
   system protecting the board, not an outage.
4. A mirror failure (step `Insert-only copy`) prints JSON lines with
   `error_code` (taxonomy.js). `DATABASE_DEADLOCK` / `DATABASE_TIMEOUT` exhausted
   → DEADLOCK STORM; `DATABASE_SCHEMA` → the migration is missing (DATABASE ERROR).

**Recovery.** Fix the cause, then re-run: `gh workflow run cfb-v2-shadow.yml -f
mode=weekly --ref main` (or `select public.cfb_weekly_poke('weekly');`). Re-runs
are idempotent (exactly-once keys, write-once freeze). Close the incident:
`select public.cfb_resolve_incident('JOB_FAILED:cfb_weekly_refresh:<date>', '<you>', '<what fixed it>');`.
If Tuesday's 12:00 freeze would be missed, the projections stay PROVISIONAL; never
back-date a freeze.

## ODDS STALE

**Symptom.** `cfb_health` `odds_freshness` WARNING (newest `odds_api` quote older
than 180 min — the decision policy's `stale_minutes`) or CRITICAL (> 360 min),
only while a game kicks off within 48 h; dashboard ODDS AGE; decisions show
`MARKET_STALE` / PASS.

**Automatic behavior.** Football projections keep displaying. Every decision on a
stale quote fails closed (PASS / UNAVAILABLE with the reason); no price older than
the policy allows is ever recommended, and no older quote is substituted. The
lab's `odds_freshness` data-quality check turns the snapshot YELLOW. When valid
quotes return, the next decision run uses them.

**Investigation.**
1. Is capture running? `select jobname, schedule, active from cron.job where jobname like 'capture_%';`
   and `select start_time, status, return_message from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'capture_%') order by start_time desc limit 10;`
2. The provider breakers: `football/cfb_lab/reports/<season>/provider_health.json`
   (state OPEN = the lab stopped calling a failing provider; `last_error_class`).
3. Quotes refused rather than missing: `select reasons, count(*) from public.cfb_market_quote_quarantine where detected_at > now() - interval '6 hours' group by 1;`
   (see MARKET_INTEGRITY.md).
4. Odds API quota / key: PROVIDERS.md.

**Recovery.** Restore the feed (key, quota, capture deploy). Do not insert quotes
by hand; do not relax `stale_minutes`. Nothing needs to be re-run: freshness
recovers with the next captured quote.

## MODEL UNAVAILABLE

**Symptom.** The V2.1 projection is missing or stale for upcoming games
(`prediction_freshness` WARNING/CRITICAL, dashboard PREDICTIONS), or the gate
refused to run (`proceed=false`, reason `incompatible` / `kill switch`).

**Automatic behavior.** The explicit fallback hierarchy (VERSIONING.md, the
manifest's `fallback_hierarchy`): V2.1 FULL → V2.1 validated degraded mode (the
mode is shown, reliability capped, never BET) → V1 `edgedesk_cfb_p4_v1.0.0`, the
governance champion (football/fbs/slate.json) → "prediction unavailable". No
other model (never candidate 001) and no invented number is substituted.

**Investigation.**
1. `select flag, enabled, updated_by, reason, updated_at from public.cfb_feature_flags;`
   — a kill switch (`cfb_weekly_engine_enabled`, `cfb_v21_pure_model_enabled`) may be off, on purpose.
2. The gate's output in the last `CFB V2 shadow` run (`reason=`).
3. `node tools/cfb/release_check.js --skip-tests` — items 4-7.
4. V1's board: the `Football weekly build` workflow must be green (it builds the fallback).

**Recovery.** If a flag was switched off deliberately, leave it until the
reason is resolved; switch back with
`select public.cfb_set_feature_flag('cfb_weekly_engine_enabled', true, '<you>', '<why it is safe again>');`.
Otherwise fix the cause (MODEL ARTIFACT MISSING, MONDAY REFRESH FAILED) and re-run the weekly job.

## DATABASE ERROR

**Symptom.** A mirror or gate step logs `error_code` `DATABASE_SCHEMA` (a table,
column or function missing), `DATABASE_CONSTRAINT` (a row refused), `AUTH`, or
`DATABASE_UNAVAILABLE`; `cfb_health` may not answer at all.

**Automatic behavior.** If Supabase is unreachable when a job starts, the gate
lets capture and the weekly freeze proceed (the git ledgers are the source of
truth) with decisions switched off (`decisions=false`, a WARNING and a
best-effort incident); in strict mode (`CFB_REQUIRE_JOB_LOCK=1`) it stops the
job instead. The weekly workflow mirrors only after publishing to git. For the
mirror itself: permanent errors are never retried; the step fails with
its code; the chunk that failed was rolled back (one POST = one transaction), the
rows before it are write-once and idempotent, so nothing is half-written and the
next run completes the mirror. The repository ledgers are the source of truth
and are published before the mirror runs. Transient connection failures are
retried 4 times with jitter.

**Investigation.**
1. `DATABASE_SCHEMA`: which object? The message names it. Compare with
   `supabase/README.md` apply order; check `select * from public.cfb_health(now()) where check_name = 'contracts';`.
2. `DATABASE_CONSTRAINT`: the constraint name in the message (e.g.
   `cfb_weekly_projections_prob`) says which rule refused which row: that is a
   data bug upstream — find the row in the ledger by its id.
3. `AUTH`: the service-role secret (`SB_SERVICE_ROLE`) or its rotation.
4. `DATABASE_UNAVAILABLE`: Supabase status; connection limits (`53300`).

**Recovery.** Apply the missing migration (Deploy intelligence, `apply_cfb_lab`),
fix the refused data upstream (a new corrected ledger row, never an edit), rotate
the secret, then re-run the job. Never disable a trigger to "let it through".

## DEADLOCK STORM

**Symptom.** `cfb_health` `deadlock_storm` WARNING (≥ 3 deadlocks in an hour) or
CRITICAL (≥ 10); incidents `DATABASE_DEADLOCK:<job>:<table>:<date>` with rising
`occurrences`; a mirror finally failing with `retries_exhausted`.

**Automatic behavior.** Postgres rolls back the victim transaction (no partial
write — proven in `sql.test.js` with two sessions locking in opposite order).
The mirror retries that chunk up to 5 times with bounded jitter (wait n in
[d/2, d], d = min(4 s, 200 ms·2^(n-1))), records every occurrence as an incident,
and after the budget fails the stage (CRITICAL incident). Lock waits beyond
`lock_timeout` (55P03) are retried 3 times.

**Investigation.**
1. Who is fighting? `select pid, state, wait_event_type, wait_event, now() - xact_start as xact_age, left(query, 120) from pg_stat_activity where datname = current_database() and state <> 'idle' order by xact_age desc;`
2. `select * from pg_locks where not granted;` and the `DETAIL:` of the 40P01 in
   the Postgres log (it names both processes and relations).
3. Two jobs overlapping that should not: `select * from public.cfb_job_locks;`,
   `select * from public.cfb_job_lock_events order by at desc limit 20;`, and JOBS.md §2.
4. A migration applied during live traffic (it takes ACCESS EXCLUSIVE on every
   table of the older CFB files: DEPLOYMENT.md §3).

**Recovery.** Stop the offender (let the scheduled job finish; do not kill the
mirror mid-chunk — it is safe either way, but a kill forfeits its retries).
Re-run the failed job (idempotent). If a new code path takes locks in a
different order, fix the order (JOBS.md §3: advisory lock first, then rows, rows
in ledger order). Resolve the incidents with the cause.

## MODEL ARTIFACT MISSING

**Symptom.** The gate step fails with `incompatible` (exit 2) and a CRITICAL
incident `MODEL_ARTIFACT:<job>:<date>` or `CALIBRATION:<job>:<date>`; or the
weekly engine's `PURE_SUBMODELS` stage fails with `artifact does not verify` /
`not a COMPATIBLE tuple` (runlog class SCHEMA).

**Automatic behavior.** Fail closed: no inference, no snapshot, no decision is
produced with an unverified or unpinned artifact; the previous published outputs
stay; the fallback hierarchy applies (MODEL UNAVAILABLE).

**Investigation.**
1. `node -e "const C=require('./football/cfb_production/compat.js');C.check(C.facts(),C.loadMatrix()).filter(c=>!c.ok).forEach(c=>console.log(c))"`
   — names the file and the pinned vs on-disk hash.
2. `git log -3 -- football/cfb_v2/artifacts football/cfb_v2/params.js football/cfb_v2/engine.js football/cfb_v2/artifacts/decision`
   — who changed what, and whether the version was bumped (VERSIONING.md §2).
3. `node football/cfb_production/manifest.js --check`.

**Recovery.** An accidental change: restore the files from the manifest's git
blobs (`git cat-file blob <git_blob> > <path>`, the blob ids are in
`manifest.json` `artifact_hashes`) or `git revert`. A deliberate model change: it
must be a new version — new artifact directory with its MANIFEST.json, then
`node football/cfb_production/manifest.js --write-compat` reviewed by a person,
`--write`, the release checklist, then deploy (DEPLOYMENT.md). Never edit
compatibility.json to match an unreviewed file.

## TEAM MAPPING ERROR

**Symptom.** Games missing from the V2.1 slate or the lab; the anomaly rule
`HOME_EQUALS_AWAY` or `CONFERENCE_MISSING` in WARNINGS; weekly `UPCOMING_FEATURES`
failing with `scheduled target games without a feature row`; lab snapshots
data-quality RED `team_mapping`; `unmapped_events` in the lab's market log.

**Automatic behavior.** An unmapped team fails that game safely (no projection,
no decision) — never a guessed join by name; a quote from the wrong game is
quarantined, not priced (MARKET_INTEGRITY.md). The rest of the slate proceeds.

**Investigation.**
1. `football/cfb_lab/reports/<season>/last_run.json` → `steps.market.log.supabase.unmapped_events` / `unresolved_names`.
2. IDENTITY.md for the canonical team ids and aliases.
3. `select game_id, reasons from public.cfb_market_quote_quarantine where reasons && array['WRONG_GAME_KICKOFF','TEAM_UNVERIFIED'] order by detected_at desc limit 20;`

**Recovery.** Add the alias / provider id to the identity master (IDENTITY.md),
commit, and let the next hourly run map it. A raw feed row with a wrong team is
corrected through `cfb_record_correction` (it keeps the original), never edited.

## QB SOURCE STALE

**Symptom.** The weekly source health shows `qb_status` STALE (older than 36 h)
or `injury` STALE (older than 12 h); lab snapshots YELLOW `qb_status_freshness`
(> 72 h); games listed QB_UNSETTLED / QB_MISSING under DEGRADED GAMES.

**Automatic behavior.** The last known status is kept and marked stale; it is
never assumed healthy. The pure model derives the expected starter from
play-by-play (a QB report is not a pure-model input), the reliability caps for
QB uncertainty apply (`qb_unknown` 65, `qb_unsettled` 75), and the decision
engine's football-confidence floor turns uncertain games to PASS.

**Investigation.**
1. The `Starter context` and `Availability sync` workflows: last green run.
2. `football/starters/cfb_<season>.json` `generated_at`; `football/availability/current.json` `generated_at`, `failed_sources`.
3. `select * from public.cfb_job_heartbeat_status where job in ('cfb_starter_context','cfb_availability_sync');` (once those jobs send heartbeats).

**Recovery.** Re-run the source workflow (`gh workflow run starter-context.yml`);
fix the provider per PROVIDERS.md. A wrong QB status from a provider is a
correction (`cfb_record_correction` on `cfb_player_events` / `cfb_qb_events`),
never an overwrite.
