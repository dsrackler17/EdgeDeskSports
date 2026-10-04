# CFB production architecture

What runs in production, where each number comes from, and which guard stops a
wrong one. Companion documents: [DEPLOYMENT](DEPLOYMENT.md) (staged release,
migration safety), [ROLLBACK](ROLLBACK.md), [JOBS](JOBS.md) (schedules, locks,
taxonomy, logging), [VERSIONING](VERSIONING.md) (manifest, compatibility,
semantics), [OPERATIONS](OPERATIONS.md) (transactions, health, alerts, load,
storage, cost), [RUNBOOK](RUNBOOK.md), [CANONICAL](CANONICAL.md) (the one prediction
pathway, input contract, numeric safety, stored reads, trace, replay). The market-integrity layer is documented
by its own set: [MARKET_INTEGRITY](MARKET_INTEGRITY.md),
[PROVIDERS](PROVIDERS.md), [IDENTITY](IDENTITY.md), [SETTLEMENT](SETTLEMENT.md),
[SECURITY](SECURITY.md).

## 1. The selected system, stated truthfully

**No Model Championship has been run in this project.** The governance record
(`football/cfb_lab/governance/model_roles.jsonl`) names the champion:

| role | model | where its numbers come from |
|---|---|---|
| **champion** (governance) and **fallback** | V1 `edgedesk_cfb_p4_v1.0.0` | `football/fbs/slate.json` (Football weekly build) |
| **production pathway** (hardened here), challenger, `ELIGIBLE_FOR_PROMOTION` | V2.1 `edgedesk_cfb_v2.1.0` | the frozen artifact `football/cfb_v2/artifacts/edgedesk_cfb_v2.1.0/` (MANIFEST.json) run by the weekly engine |
| candidate, shadow only (never a fallback) | V2.0 `edgedesk_cfb_v2.0.0` | current.json's shadow block |

V2.1 becomes champion only when a person runs
`node football/cfb_lab/governance.js promote --model edgedesk_cfb_v2.1.0 --reason "..." --actor <name>`
after the promotion guard (VERSIONING.md §4). Every production manifest records
`champion_selection: NOT_RUN`; the database refuses a `SELECTED` manifest
without the championship's evidence.

## 2. Components and data flow

```
 CFBD / cfbfastR PBP + schedule ─┐
 football/starters (QB context) ─┤   WEEKLY ENGINE  (python -m v2.weekly.run, cfb-v2-shadow.yml)
 football/availability, rosters ─┤     validate finals + PBP ─► team / QB / unit state ─► upcoming features
                                 │     ─► PURE inference with the FROZEN V2.1 artifact
                                 │        (verify_artifact + verify_compatibility, else stage FAILED)
                                 │     ─► calibration, uncertainty, degraded modes ─► RELEASE GATE
                                 │     ─► FREEZE (Tue 12:00 UTC, write-once snapshots) ─► WRITE_STATE
                                 │   outputs: football/cfb_v2/current.json, snapshots/<season>/,
                                 │            football/cfb_weekly/<season>/*.jsonl (ledger)
                                 ▼
 The Odds API ─► capture (edge fn, pg_cron) ─► cfb_lab_ingest_quotes() ─► cfb_lab_market_quotes
                                 ▼
 MODEL LAB (run.js hourly, cfb-lab.yml): market capture + integrity screen ─► checkpoint snapshots of
   V1 / V2.1 / V2.0 (append-only ledger) ─► settlement ─► reports (lab.json, provider_health.json)
   ─► DECISION ENGINE in shadow (football/cfb_decision, policy cfb_decision_policy_v1, betting OFF)
                                 ▼
 MIRRORS (sync_supabase.js x5) ─► Postgres (insert-only, write-once tables)
 OPERATIONS: gate.js (every scheduled job) · health.js ─► reports/ops.json ─► admin/cfb-ops/
             cfb_health() · heartbeats · incidents · job locks · manifest · flags · audit log
```

The repository ledgers are the source of truth; Postgres is an insert-only
mirror. Every V2 number passes through ONE service, `football/cfb_production/canonical.js`
(the input contract, the engine, the numeric checks, the degraded modes, the
fallback level, the public display policy); the hourly job stores its output in
`football/cfb_production/reports/projections.json` (and the per-game trace in
`traces.json`). Pages read stored artifacts (projections.json, current.json,
lab.json, ops.json) and compute nothing; no user request triggers a model
computation. `canonical.test.js` fails when any consumer calls the engine itself
(CANONICAL.md §1).

## 3. The guards, by failure

| failure the brief assumes | what stops a wrong number | where |
|---|---|---|
| model artifacts incompatible | artifact hash vs MANIFEST.json; the pinned tuple in compatibility.json (model × feature schema × calibration × decision policy × decision calibration × engine) | `v2/weekly/project.py` verify_artifact + verify_compatibility (inference); `gate.js` (every job) |
| database jobs overlap / cron runs twice | workflow concurrency groups; `cfb_job_lock(job, key)` lease behind an advisory lock; write-once keys | `gate.js`, `locks.js`, cfb_production.sql |
| database locks conflict | short one-chunk transactions, deterministic order, classified bounded retry, incidents | `db.js` |
| a mirror dies half way | run row written last; `*_published` views show committed runs only | `cfb_weekly/sync_supabase.js`, cfb_production.sql |
| someone flips a switch | flags only through `cfb_set_feature_flag` (audited); betting cannot be enabled while the policy says no | cfb_production.sql |
| provider data wrong | `cfb_record_correction` keeps the original, never mutates raw rows; outputs are re-versioned, never corrected | cfb_production.sql |
| outputs go strange | anomaly rules (sign, bounds, spread shift, market gap, probability collapse, BET spike, conference missing) | `anomaly.js` → ops.json |
| stale odds / PBP / QB | freshness rules in `cfb_freshness_rules` (the engines' own bounds) and fail-closed decisions | cfb_health, decision engine |
| a model file changed silently | the manifest pins it; the release check FAILs an unversioned change | `versioning.js`, `tools/cfb/release_check.js` |

## 4. Fallback hierarchy and degraded modes

Explicit, in the manifest (`fallback_hierarchy`):

1. **FULL** — V2.1, artifact verified, inputs pass, sources fresh.
2. **DEGRADED** — a validated degraded mode of the weekly engine
   (`DEGRADED_PBP` cap 60, `DEGRADED_AVAILABILITY` cap 75, `DEGRADED_MARKET`;
   `project.py` MODE_CAPS): the mode is displayed, reliability capped, never BET.
3. **FALLBACK_MODEL** — V1, the previous stable (and governance) champion.
4. **UNAVAILABLE** — "prediction unavailable"; never a substitute number.

The canonical service names the modes the brief lists — FULL, NO_PLAYER_DATA,
NO_ADVANCED_PBP, QB_UNCERTAIN, MARKET_DEGRADED, FALLBACK_MODEL — from the weekly
engine's modes and the snapshot's own evidence, and stores them with each
projection and each Model Lab snapshot. MARKET_DEGRADED never lowers the football
level (it gates actionability); a public page shows a degraded mode in words and
never its confidence score (CANONICAL.md §11).

The weekly engine's own `FALLBACK` mode (cap 0) marks an artifact failure: the
inference stage fails and nothing is published from it. Candidate 001 is never
in the hierarchy (compatibility.json marks it INCOMPATIBLE).

## 5. Feature flags (`cfb_feature_flags`)

| flag | initial | kind | effect today |
|---|---|---|---|
| `cfb_weekly_engine_enabled` | on | KILL_SWITCH | read by the gate: off skips the weekly engine and its mirror |
| `cfb_model_lab_enabled` | on | KILL_SWITCH | read by the gate: off skips the hourly lab |
| `cfb_v21_pure_model_enabled` | on | COMPONENT | declares the V2.1 pathway on; off = serve the fallback (a person's decision, see ROLLBACK.md) |
| `cfb_v1_fallback_enabled` | on | COMPONENT | declares the fallback available |
| `cfb_decision_engine_enabled` | on | COMPONENT | declares shadow decisions on |
| `cfb_player_model_enabled` | off | COMPONENT, guarded | personnel units are research, not a V2.1 input |
| `cfb_matchup_correction_enabled` | off | COMPONENT, guarded | the matchup residual is research, not a V2.1 input |
| `cfb_bet_actionable_enabled` | off | BETTING, guarded | cannot go on while the manifest's decision policy has betting off |

Only the two kill switches are read by code today (the gate); the component
flags record the state a person must change deliberately, with the audit
trail, when a component is switched. Adding a code path that reads a flag is a
versioned change.

## 6. Tables (Postgres)

`supabase/cfb_production.sql` adds, beside the CFB contracts (cfb_lab,
cfb_weekly, cfb_personnel, cfb_decision, cfb_v2_model, cfb_market_integrity,
cfb_matchup, cfb_market): `cfb_production_model_manifest`,
`cfb_compatibility_matrix`, `cfb_feature_flags`, `cfb_audit_log`,
`cfb_data_corrections`, `cfb_job_registry`, `cfb_job_heartbeats`,
`cfb_job_locks`, `cfb_job_lock_events`, `cfb_incidents`, `cfb_freshness_rules`;
views `cfb_production_manifest_current`, `cfb_compatibility_current`,
`cfb_incidents_current`, `cfb_job_heartbeat_status`,
`cfb_data_corrections_current`, `cfb_team_week_state_published`,
`cfb_weekly_projections_published`; functions listed in supabase/README.md.

## 7. Code map (football/cfb_production/)

| file | role |
|---|---|
| `taxonomy.js` | the one error taxonomy, mapped to runlog classes |
| `db.js` | the one Postgres write path: chunks, classified bounded retry, incidents |
| `log.js` | structured logging, correlation id, redaction |
| `locks.js` | job-lock and per-game-lock client |
| `compat.js`, `compatibility.json` | facts on disk and the explicit compatibility matrix |
| `manifest.js`, `manifest.json` | the immutable production manifest |
| `versioning.js` | MAJOR / MINOR / PATCH, unversioned-change detection |
| `gate.js` | start / finish of every scheduled CFB job |
| `jobs.js`, `jobs.json` | the job registry, cron drift, collision analysis |
| `health.js`, `anomaly.js`, `reports/ops.json` | the operations report and its anomaly rules |
| `migration_review.js`, `perf.js`, `reports/*.json` | migration safety and load / index / storage evidence |
| `tests.js`, `sql.test.js`, `ui.test.js`, `pgrest.js` | the suites (pgrest.js: a PostgREST stand-in for real-Postgres tests) |
| `canonical.js`, `contract/` | THE prediction service: input contract, engine, numeric checks, modes, fallback, display |
| `numeric.js` | bounds, consistency, precision, UTC and explicit as_of_ts |
| `projections.js`, `trace.js`, `reports/projections.json`, `reports/traces.json` | the stored canonical projections and the per-game prediction trace |
| `promotion.js` | the promotion guard `governance.js promote` runs |
| `golden.js`, `golden/` | the golden-game set (CI) |
| `reproduce.js`, `replay_week.js` | re-running stored predictions from their inputs; a played week replayed schedule to settlement |
| `canonical.test.js`, `final_hardening.test.js`, `replay.test.js`, `debug_ui.test.js`, `security.test.js` | the pathway, final hardening, replay, debug view and security suites |
| `../../tools/cfb/release_check.js` | the release checklist |
| `../../tools/cfb/secret_audit.js` | the secret audit (every PR) |
| `../../admin/cfb-ops/index.html` | the operational dashboard |
| `../../admin/cfb-debug/index.html` | the internal game-level debug view |

## 8. Where the rest lives

The canonical prediction service, snapshot immutability, the input contract and
feature monitor, numeric safety, stored reads, golden games, property tests,
replay, the trace and debug view, and the final hardening test are documented in
[CANONICAL](CANONICAL.md). Providers, identity, market integrity, settlement and
security have their own documents (listed at the top). This document covers the
manifest, transactions, locks, idempotency, versioning, deployment, rollback,
flags, fallback, jobs, taxonomy, logging, health, alerts, anomalies, audit,
corrections, load, indexes, storage, backup, release checks, the dashboard, cost
and the runbook. [DELIVERABLE](DELIVERABLE.md) maps every item of the hardening
brief to where it lives and its status.
