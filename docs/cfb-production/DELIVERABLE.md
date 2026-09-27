# CFB production hardening: the final deliverable

This document maps every item of the hardening brief's final deliverable (§123)
to where it lives and its status. It also records the audit findings F-22 and
F-23, the bugs found, and what only the owner can do.

**Status words.**

| status | meaning |
|---|---|
| DONE | implemented and tested in this repository |
| PARTIAL | built, with the missing part named |
| NOT POSSIBLE HERE | needs something outside this repository or this environment |

The claims of the two earlier hardening passes were checked against the code by
running their suites on this branch. Market, identity and settlement came from
H1; infrastructure and operations from H2. See "Suites run" at the end.

## The selected system, stated plainly

- **No Model Championship has been run in this project.** Every production manifest
  records `champion_selection: NOT_RUN`. The current manifest is
  `cfbm_f86ae717dfd4dd772a89c995`.
- **The governance champion is still V1, `edgedesk_cfb_p4_v1.0.0`**
  (`football/cfb_lab/governance/model_roles.jsonl`).
- **V2.1, `edgedesk_cfb_v2.1.0`, is the hardened production pathway.** It runs in
  shadow and is `ELIGIBLE_FOR_PROMOTION` on its backtests only.
- **Promoting V2.1 is a person's act:**
  `node football/cfb_lab/governance.js promote --model edgedesk_cfb_v2.1.0 --reason "..." --actor <name>`.
  That command now runs the promotion guard. The guard refuses today on one check:
  `INSUFFICIENT_SAMPLE (n 0 of 150)`. The live season has no graded V2.1 sample yet.
- **Betting is disabled** (`bet_enabled: false`). Nothing here changes that.
- **The model is unchanged.** No feature was added and no threshold was retuned.
  The pinned files were not edited: `engine.js`, `params.js`, `config.py`,
  `market.py`, `artifacts/`, `compatibility.json` and the decision thresholds.

## The 63 items

| # | item | where | status |
|---|---|---|---|
| 1 | production manifest | `football/cfb_production/manifest.js`, `manifest.json`; VERSIONING.md §1 | DONE |
| 2 | canonical prediction service | `football/cfb_production/canonical.js`; CANONICAL.md §1 | DONE |
| 3 | prediction immutability architecture | Model Lab ledger (`football/cfb_lab/ledger.js`), weekly `FREEZE_EARLY`, SQL append-only triggers, event-triggered ADHOC versions; CANONICAL.md §2 | DONE |
| 4 | database transaction audit | OPERATIONS.md §1; `db.js` | DONE |
| 5 | deadlock protections | `db.js` (classified bounded retry, 40P01), `sql.test.js` (a real two-session deadlock); OPERATIONS.md §2 | DONE |
| 6 | job locking | `locks.js`, `gate.js`, `cfb_job_lock()` in cfb_production.sql; JOBS.md §3 | PARTIAL |
| 7 | idempotency results | `sql.test.js` section J (1x/2x/3x); lab rerun writes nothing (`chaos.test.js`, `canonical.test.js`); replay second settlement adds 0 | DONE |
| 8 | external provider policies | `football/cfb_lab/providers.js`; PROVIDERS.md | DONE |
| 9 | source freshness rules | `cfb_freshness_rules` (SQL), `integrity.js` FRESHNESS, `health.js` | DONE |
| 10 | source health dashboard | `admin/cfb-ops` (source health, odds age, PBP age), `provider_health.json` | DONE |
| 11 | schema validation | `providers.js` schema checks; the weekly engine's validate stages; the input contract | DONE |
| 12 | team/player/game identity protections | `football/cfb_lab/identity.js`; IDENTITY.md | DONE |
| 13 | sign-convention tests | `football/cfb_lab/sign_suite.test.js`; `numeric.js` consistency; the app panel's sign contract | DONE |
| 14 | odds normalization | `integrity.js`; MARKET_INTEGRITY.md §1-3 | DONE |
| 15 | outlier/stale quote protection | `integrity.js` OUTLIER / FRESHNESS, quarantine; MARKET_INTEGRITY.md §4-8 | DONE |
| 16 | kickoff/postponement/cancellation handling | `settle.js`, `integrity.rescheduled`, ADHOC reschedule rows; SETTLEMENT.md §3-4; golden cases | DONE |
| 17 | PBP fail-safe behavior | weekly engine DEGRADED_PBP (cap 60), the canonical NO_ADVANCED_PBP mode | DONE |
| 18 | feature input contracts | `contract/input_contract.json`, `v2/weekly/contract.py`, `canonical.checkRow`; CANONICAL.md §3-4 | DONE |
| 19 | artifact hashing | artifact MANIFEST.json + `verify_artifact`; manifest `artifact_hashes` with git blobs | DONE |
| 20 | version compatibility protections | `compatibility.json`, `compat.js`, `gate.js`; pinned decision artifacts (`compat.decisionArtifacts`) | DONE |
| 21 | deployment strategy | DEPLOYMENT.md §1 | DONE (as a procedure) |
| 22 | migration safety | `migration_review.js`; release check item 3 | DONE |
| 23 | rollback procedure | ROLLBACK.md | DONE |
| 24 | feature flags | `cfb_feature_flags`, `cfb_set_feature_flag()`; ARCHITECTURE.md §5 | PARTIAL |
| 25 | champion fallback policy | manifest `fallback_hierarchy`, `canonical.resolve`; CANONICAL.md §11 | DONE |
| 26 | degraded modes | `canonical.modes`, stored on every projection and lab snapshot; CANONICAL.md §11 | DONE |
| 27 | caching strategy | stored reads; CANONICAL.md §6 | DONE |
| 28 | job/cron architecture | `jobs.js`, `jobs.json`; JOBS.md | DONE |
| 29 | error taxonomy | `taxonomy.js` (mirrored in SQL `cfb_error_codes()`); JOBS.md §4 | DONE |
| 30 | structured logging | `log.js` (correlation ids, redaction); JOBS.md §5 | DONE |
| 31 | health checks | `health.js` → `ops.json`; `cfb_health()`; OPERATIONS.md §5 | DONE (database half PARTIAL) |
| 32 | alerts | ops.json warnings, incidents, red GitHub runs; OPERATIONS.md §5 | PARTIAL |
| 33 | anomaly detection | `anomaly.js`; the feature-distribution monitor | DONE |
| 34 | reproducibility tests | `reproduce.js` (in `canonical.test.js`) | DONE |
| 35 | deterministic inference | `canonical.snapshot` determinism; replay byte-identical ledgers | DONE |
| 36 | timezone protections | `numeric.utc` / `requireAsOf`; CANONICAL.md §5 | DONE |
| 37 | security/secret audit | `tools/cfb/secret_audit.js`, `security.test.js`, `cfb-security.yml`; SECURITY.md | DONE |
| 38 | settlement safety | `settle.js`; SETTLEMENT.md; `reproduce.js` settlement | DONE |
| 39 | financial-math tests | `football/cfb_decision/tests.js`, SETTLEMENT.md §7, `canonical.test.js` properties | DONE |
| 40 | frontend contract tests | `frontend_contract.test.js`, `tools/football/cfb_v2_panel.test.js`, `ui.test.js`, `debug_ui.test.js` | DONE |
| 41 | explanation-layer protections | `supabase/functions/edgedesk_ai/_cfb_explain.js`, `explain_guard.test.js`; SECURITY.md §5 | PARTIAL |
| 42 | load test | `perf.js`, `reports/perf.json`; OPERATIONS.md §3 | DONE |
| 43 | database/index audit | `perf.js`, `migration_review.js`; OPERATIONS.md §3 | DONE |
| 44 | storage strategy | OPERATIONS.md §4 | DONE (as a plan) |
| 45 | backup/recovery | `sql.test.js` §M (DR restore), `manifest.verifyFromGit`; OPERATIONS.md §6 | PARTIAL |
| 46 | staging/shadow validation | Model Lab shadow, decision shadow, `MATCHUP_SHADOW`, the promotion guard; CANONICAL.md §13 | PARTIAL |
| 47 | golden-game tests | `golden.js`, `golden/`; CANONICAL.md §7 | DONE |
| 48 | chaos/failure tests | `canonical.test.js`, `final_hardening.test.js`, `football/cfb_lab/chaos.test.js`, `sql.test.js` | DONE |
| 49 | historical week replay | `replay_week.js`, `replay.test.js`; CANONICAL.md §8 | DONE |
| 50 | full-season replay where practical | `replay_week.js --weeks 1-4` | PARTIAL |
| 51 | release checklist | `tools/cfb/release_check.js`; DEPLOYMENT.md §2 | DONE |
| 52 | model-version policy | `versioning.js`, `promotion.js`; VERSIONING.md §2, §4 | DONE |
| 53 | operational dashboard | `admin/cfb-ops` | DONE |
| 54 | game-debug view | `admin/cfb-debug`; CANONICAL.md §10 | DONE |
| 55 | prediction tracing | `trace.js` → `reports/traces.json`; CANONICAL.md §10 | DONE |
| 56 | extreme-edge integrity system | `integrity.extremeReview` + `betGate` (lab), `decision.js` extreme checks, BET-volume guards | DONE |
| 57 | cost audit | OPERATIONS.md §7; CANONICAL.md §14 | DONE |
| 58 | rejected-infrastructure cleanup | OPERATIONS.md §8; CANONICAL.md §14 | DONE (nothing removed) |
| 59 | production documentation | `docs/cfb-production/` | DONE |
| 60 | operational runbook | RUNBOOK.md | DONE |
| 61 | files/functions/tables changed | below | DONE |
| 62 | unresolved production risks | below | DONE |
| 63 | final readiness status | below | DONE |

## Evidence for each item

**1. Production manifest.**
- `manifest.js --check` passes on this branch.
- The manifest was regenerated twice: once because the lab ensemble fix changed its
  lab note, and once because main added `cfb_terminal_analytics.sql`, which changed
  the migration hash. Each regeneration names the manifest it supersedes and its
  reason.
- It records: the governance champion (V1), `champion_selection: NOT_RUN`, V2.1 as the
  production pathway, every artifact by sha256 and git blob, the migration hash, the
  compatibility result and the fallback hierarchy.
- Tests: `tests.js` (120 checks); release check item 4.

**2. Canonical prediction service.** `canonical.test.js` (117 checks) scans the
repository. It fails when:
- any file outside `canonical.js` calls the engine's `pure()` through any receiver;
- `engine.decide()` runs outside the three stored-research producers;
- a page loads the engine;
- a node consumer bypasses `canonical.pure`.

Consumers audited:

| consumer | how it now gets V2 numbers |
|---|---|
| Model Lab adapters | `CANON.pure` |
| decision shadow | `CANON.pure` |
| V2 mirror | `CANON.pure` |
| shadow decisions | `CANON.pure` |
| V1 board's v2_shadow block | `CANON.pure` |
| research terminal build (arrived from main; it called `E2.pure` directly and is now routed) | `CANON.pure` |
| stored projections | `CANON.snapshot` |
| app V2 panel (it used to load `engine.js` and compute in the browser) | reads `projections.json`; loads no engine |
| debug view | reads the stored files |
| AI explanation | stored facts only |

`generateCfbPredictionSnapshot(row, { as_of_ts })` requires the time; nothing inside
reads the clock.

**3. Prediction immutability.**
- A lab snapshot is written once per window. `ledger.verify` checks ids, hashes and
  one row per window.
- A changed input within 72 h of kickoff is a new ADHOC version naming what it
  supersedes. The earlier row is kept byte for byte (`canonical.test.js` "lab:").
- The weekly engine's freeze refuses overwrites.
- The Postgres tables are append-only by trigger (`sql.test.js`).
- Corrections are separate rows (`cfb_record_correction`).

**4-5. Transactions and deadlocks** (H2, verified).
- `football/cfb_production/sql.test.js` runs a real two-session deadlock, lock
  timeouts and lock contention on a throwaway PostgreSQL: 133 checks green.
- One of those checks, the V2 mirror fixture, was broken by an H3 fix and is
  corrected; see the bug list.

**6. Job locking. PARTIAL.** What exists:
- `cfb_job_lock()` leases behind an advisory lock;
- the gate acquires them;
- workflow concurrency groups.

What is missing: without the database, the gate reports `lock: none (no database:
workflow concurrency group only)`. Strict mode (`CFB_REQUIRE_JOB_LOCK=1`, fail
closed) is the owner's switch once `cfb_production.sql` is applied.

**7. Idempotency.**
- `sql.test.js` J: every mirror run 1x, 2x and 3x gives identical tables.
- The lab: an unchanged hour writes nothing.
- Replay: a second settlement adds 0 rows.

**8-11. Providers, freshness, source health, schema** (H1 and H2, verified).
- Suites: `providers.test.js` (69), `integrity.test.js` (82), `chaos.test.js` (50),
  `tests.js`, `ui.test.js` (40).
- Circuit-breaker state is published hourly (`provider_health.json`).
- A missing field is never read as zero (PROVIDERS.md §4).

**12-16. Identity, signs, odds, outliers, schedule changes** (H1, verified).
- Suites: `sign_suite.test.js` (67), `integrity.test.js`, `integrity_sql.test.js`
  (52), `football/cfb_market/tests.js` (129), `sql.test.js`.
- The golden set adds postponed / canceled → VOID, a stale market failing closed in
  both engines, and a road favourite naming the AWAY team.

**17. PBP fail-safe.**
- The weekly engine caps DEGRADED_PBP at 60.
- The canonical service names NO_ADVANCED_PBP when the engine flags it or PBP
  completeness is < 0.9. It is shown in words and never as a confidence score.

**18. Feature input contracts.**
- 60 model inputs are declared, with ranges from the artifact's own training rows
  (2012-2025, 10,555 rows; they reproduce the stored training means).
- Enforced before inference in the weekly engine: CRITICAL withholds the game, and
  more than 5% of a week withheld holds the week.
- Enforced on every row in node (`checkRow`).
- The feature-distribution monitor flags and never refits.
- Tests: `tests_contract.py` (51 fast, 54 on the real build), `canonical.test.js`.

**19-20. Artifacts and compatibility.**
- The gate still prints `proceed=true` and `decisions=true` (checked on this branch,
  no `SB_URL`).
- The decision shadow now loads the PINNED policy and calibration (it used to load
  the lexically newest directory), and fails closed on a missing or changed file.
- `tests.js` and `canonical.test.js` cover both.

**21-23. Deployment, migrations, rollback.**
- DEPLOYMENT.md, `migration_review.js` and ROLLBACK.md from H2 were verified.
- ROLLBACK.md now names `--rollback`, which the promotion guard needs to return to V1.
- Deploys are the owner's.

**24. Feature flags. PARTIAL.**
- The flags exist in SQL and are changed only through an audited function.
- The gate reads the two kill switches.
- Missing: the component flags are declarations. No code path reads them
  (ARCHITECTURE.md §5).

**25-26. Fallback and degraded modes.**
- The modes FULL / NO_PLAYER_DATA / NO_ADVANCED_PBP / QB_UNCERTAIN / MARKET_DEGRADED /
  FALLBACK_MODEL are real fields of every stored projection and lab snapshot.
- The fallback order is V2.1 FULL → V2.1 DEGRADED → V1 → UNAVAILABLE.
- The internal views show modes by name and the level: `admin/cfb-debug` (every game)
  and `admin/cfb-ops` "Degraded games", which now carries the stored canonical modes
  and fallback level (`debug_ui.test.js`).
- The public panel shows words, withholds a degraded confidence score, and says a
  degraded 85%+ favourite in words ("strong favourite (...)").
- Current build (2026-09-28): 2 games FULL, 55 DEGRADED, 3 NOT_PRICED.

**27. Caching strategy.**
- Precomputed hourly; the app reads with a 10 s timeout and reuses the file for an hour.
- A failed read is retried after 5 minutes.
- A file older than 3 h is labelled STALE; games past kickoff are not in the next build.
- Tested in `cfb_v2_panel.test.js` (20 checks).

**28-30. Jobs, taxonomy, logging** (H2, verified by `tests.js`).
- JOBS.md lists every schedule. Log lines carry correlation ids and redact credentials
  (`security.test.js` checks the masking).

**31. Health checks.**
- `health.js` and `ops.json` are built hourly.
- Missing (PARTIAL): the database checks (`cfb_health()`) run only where the SQL is
  applied and the job has credentials.

**32. Alerts. PARTIAL.**
- Severities and rules exist, and an alert surfaces as a red run, an incident row and
  the dashboard.
- Missing: there is no paging channel (no Slack or e-mail integration in the
  repository; OPERATIONS.md §5).

**33. Anomaly detection.** `anomaly.js` rules (sign, bounds, spread shift, market gap,
probability collapse, BET spike, missing conference), plus the feature monitor.

**34-36. Reproducibility, determinism, time.**
- 174 of 174 preserved LIVE snapshots re-run to the stored numbers from the input
  file they name. 510 of 510 evaluations re-grade identically.
- Two replays give byte-identical ledgers.
- UTC normalisation is enforced and the DST change is tested.
- The pinned engine's rounding before `decide()` moves a cover probability by at most
  1.8e-4. This is recorded, not fixable without editing `engine.js`.

**37. Security.** See SECURITY.md. Result:
- The secret audit found no secret: 2,735 files including 20 page files and 15 log
  files, and 47 workflows.
- It flagged 9 test fixtures and 2 INFO items (a project ref on a `run:` line).
- Least privilege is enforced by test on every PR: every security-definer CFB function
  is revoked from anon, with the terminal's guarded analytics writer as the one
  documented exception, and RLS is on every CFB table.
- No public endpoint can start a CFB refresh.
- Admin validation is checked for the newsletter dispatch.
- The promotion guard is enforced (item 52).

**38-39. Settlement and financial math** (H1, verified).
- `football/cfb_decision/tests.js` (101) and `sql.test.js` (44), and SETTLEMENT.md §7.
- Property tests over every live row found 0 violations of each rule:
  - a better spread never lowers the cover probability;
  - a worse price never improves EV;
  - a price-only change never moves the pure fair spread.

**40. Frontend contract tests.** `frontend_contract.test.js` (38): signs, the official
status vs research, and the display wording.

**41. Explanation layer. PARTIAL.**
- The fact boundary is inlined into `supabase/functions/edgedesk_ai/index.ts` by
  `tools/presentation/inline.js`. That is source only: the function is not deployed.
- The official status is the governed policy's (F-22), and "edge quality" wording is
  refused (F-23).
- The research terminal's page words cross as a labelled research status.
- 48 checks in `explain_guard.test.js`.
- Missing: the chat's CFB answers still explain V1 (the champion). A V2 path must call
  `cfbFacts` → `buildPrompt` → `explain`.

**42-44. Load, indexes, storage** (H2, verified). `reports/perf.json`: 624,000 decision
snapshots, p95 of each hot query in milliseconds. Storage is about 0.5 GB per season.

**45. Backup and recovery. PARTIAL.**
- The disaster-recovery restore test passes (`sql.test.js` §M), and artifacts are
  recoverable from git.
- Missing: Supabase's managed backups and point-in-time recovery are project settings
  outside the repository. The weekly `pg_dump` of the operational tables is a
  recommendation (OPERATIONS.md §6).

**46. Staging and shadow validation. PARTIAL.**
- Shadow validation is real: V2.1 and V2.0 are snapshotted hourly beside V1 and graded
  identically; the decision engine runs in shadow; the matchup challenger is recorded
  by `MATCHUP_SHADOW`.
- Missing: there is no separate staging database. The SQL suites build a throwaway
  PostgreSQL instead. The weekly engine has not recorded a 2026 run yet (see risks),
  so its contract enforcement has run only in tests.

**47-49. Golden games, chaos, the historical week.**
- The golden games are 15 cases on real rows. Among them:
  - a road favourite;
  - a neutral site;
  - a QB change;
  - an FCS game;
  - huge favourites;
  - a stale market;
  - postponed and canceled games;
  - multiple injuries;
  - an impossible margin;
  - degraded evidence.
- Week 3 of 2026 was replayed from schedule to settlement:
  - 75 games: 57 PREDICTED and 18 NOT_PRICED;
  - 455 snapshots, with no duplicate window and none after kickoff;
  - 455 evaluations;
  - the result is deterministic.

**50. Full-season replay. PARTIAL.**
- The 2026 season to date (weeks 1-4) is replayed: 331 games and 1,720 snapshots and
  evaluations, deterministic.
- NOT POSSIBLE HERE for earlier seasons: preserved pregame rows exist only for 2026,
  and the 2012-2025 walk-forward backtests belong to the research pathway.

**51. Release checklist.** `release_check.js --skip-tests` returns
RELEASABLE_WITH_WARNINGS. Its warnings:
- tests were skipped in that invocation (they were run separately; see below);
- five migrations have no automated apply step;
- health is CRITICAL: `last_weekly_run`, because no weekly-engine run is recorded
  for 2026.

**52. Model-version policy.** The promotion guard (`cfb_promotion_guard_v1`) runs
inside `governance.js promote`. Its seven checks:
- an explicit version;
- registration;
- compatibility;
- the artifact;
- the full compatibility tuple;
- tests;
- a complete shadow.

"latest" is refused.

**53-55. Dashboard, debug view, trace.**
- `admin/cfb-ops` (H2) shows the official and research roles.
- `admin/cfb-debug` is new: noindex, escaped, and it reads the stored files only.
- `admin/cfb-ops` "Degraded games" shows each game's stored canonical modes and level.
- The trace runs from raw inputs → features → submodels → ensemble → calibration →
  market → decision → outcome.

**56. Extreme-edge integrity.** Wired and tested:
- the lab `betGate` keeps a BET only with an ACTIONABLE market and a passed
  `extremeReview` (a gap of 10+ or a cover probability of 0.60+ triggers the sign,
  mapping, QB, injury, freshness and version checks);
- `decision.js` raises RESEARCH_EXTREME_EDGE and a diagnostic for extreme
  probability;
- the BET-volume guards: `report.js` `betVolume`, the SQL view
  `cfb_market_bet_volume`, and `anomaly.js` BET_SPIKE.

Note: `health.js` passes no BET-count baseline, so BET_SPIKE uses its floor of 3.
That errs toward review.

**57-58. Cost and rejected infrastructure.**
- H2's audit (OPERATIONS.md §7-8) was verified.
- The steps added here cost about 2 s per hourly run.
- No scheduled job runs a rejected model. Candidate 001 is a governance
  *candidate*; retiring it is recommended once V2.1 has its sample.
- Nothing was deleted.

## F-22 and F-23

**F-22: two decision engines, one official status.**
- The official status and its wording now come from exactly one definition: the
  governed policy `cfb_decision_policy_v1` (`football/cfb_decision/decision.js`, run
  by the decision shadow as CHALLENGER rows).
- The stage-8 `engine.decide()` output is shown only as a labelled RESEARCH field:
  - `projections.json` `research`;
  - the app's "Research only" line;
  - the Lab's "Research class" and "Research position";
  - the ops roles "CURRENT: RESEARCH only";
  - the explanation boundary, which states NO BET without a governed decision.
- `engine.js` was not edited and no ledger row was rewritten.
- `canonical.test.js` and `frontend_contract.test.js` fail if a consumer shows the
  stage-8 status as official. Today every game's official decision is `NO_DECISION`:
  no LIVE freeze has produced a governed decision yet.
- The research terminal that arrived from main keeps its seven page words. Its BET
  requires `decision.js`'s BET, and the explanation boundary accepts its other words
  only as a labelled research status.

**F-23: the P(positive CLV) tiers are not edge quality.**
- The 0.52 / 0.58 tiers of `policy.json` (unchanged) rank closing-line movement.
  Close-implied EV is ≤ 0 in every tier.
- They are shown as "Closing-line tendency", with the note "ranks how the close tends
  to move, not bet quality".
- The stage-8 `betting_edge_strength` is shown only as "Stage-8 EV strength · research
  only".
- The explanation audit refuses "edge quality" and "bet quality" wording.
- Covered by `canonical.test.js`, `explain_guard.test.js` and `debug_ui.test.js`.

## Bugs found

| bug | evidence | fixed |
|---|---|---|
| The lab's V2 `ensemble_version` was sha256("{}") for every version: params.js carries no stack weights | V2.0 and V2.1 both recorded `…:44136fa355b3` | Yes. It is derived from the artifact's models.json: V2.1 `e105ca1727a6` (equals the manifest), V2.0 `f7e3da3f8a7c`. Old ledger rows are kept as written |
| The decision shadow loaded the lexically newest policy directory (`v2` sorts after `v10`) | `shadow.js` newest() | Yes. It loads the pinned directory through `compat.decisionArtifacts`, verified by hash, and fails closed |
| The app's V2 panel loaded `engine.js` and computed in the browser | `app.html` fbScript of engine/params | Yes. It reads `projections.json` |
| The V2 Postgres mirror would run another version's frozen rows through the V2.1 engine and publish them under the old label | the `sql.test.js` fixture wrapped v2.0.0 rows and the mirror published V2.1 numbers for them | Yes (the canonical service refuses them). The fixture now uses V2.1 rows, and a check proves the refusal |
| The research terminal build (from main) called `E2.pure` directly, and the pathway scan missed it: it matched only named receivers | `football/cfb_terminal/build.js:237` | Yes. The build is routed through `CANON.pure`, and the scan now catches any receiver |
| The V1 board failing to read silently removed fallback level 3 | `projections.js` catch | Yes. `sources.v1_error` and a workflow warning |
| A secret-audit rule fingerprinted a capture group instead of the value | STRIPE rule fingerprint "2 chars" | Yes |
| The debug view crashed on a non-array field | hostile-file test | Yes |
| The V2 panel showed a degraded strong favourite as a precise "96.0%" | `app.html` | Yes. It uses the stored display wording |
| The contract's documented monitor rule described phase buckets; the code uses week-of-season envelopes | `input_contract.json` rules.monitor | Yes. The text now states the rule that runs |

These are not fixed, and are owned by someone else or need a decision:

| issue | why not fixed here |
|---|---|
| `engine.decide()` reads rounded margin and sigma: a cover probability moves by at most 1.8e-4 | `engine.js` is pinned |
| `editorial_cron` and `newsletter_cron` accept any gateway-authorised caller; they dispatch non-CFB workflows, debounced | changing them without the matching pg_cron change would stop the schedulers (SECURITY.md §3) |
| `health.js` BET_SPIKE has no baseline, so the floor of 3 applies | errs toward review. Wiring the baseline needs the governed decision history, which does not exist yet |
| `models.js` `v1Adapter` labels V1 `edgedesk_cfb_p4_v1.0.0` when `football/cfb_p4/params.js` is unreadable | unreachable while the file is committed; noted for the Model Lab's owner |
| pg_cron `cfb_lab_hourly` runs all year | `supabase/cfb_lab_cron.sql` needs the owner to apply the change (OPERATIONS.md §7) |

## 61. Files, functions and tables changed by this work

This is H3 relative to `origin/main`. H1 and H2 list theirs in MARKET_INTEGRITY.md,
PROVIDERS.md, IDENTITY.md, SETTLEMENT.md, ARCHITECTURE.md §7 and OPERATIONS.md.

**New:**
- `football/cfb_production/`:
  - `canonical.js`, `numeric.js`, `projections.js`, `trace.js`, `promotion.js`;
  - `golden.js`, `golden/`, `reproduce.js`, `replay_week.js`;
  - `contract/feature_reference_edgedesk_cfb_v2.1.0.json` (regenerated) and
    `contract/input_contract.json` (monitor rule);
  - the suites `canonical.test.js`, `final_hardening.test.js`, `replay.test.js`,
    `debug_ui.test.js`, `security.test.js`.
- `football/cfb_v2/research/v2/weekly/`: `contract.py` (training window 2012-2025,
  monitor), `matchup_shadow.py`, `tests_contract.py`.
- `football/cfb_market/sync_supabase.js`, `sync.test.js`.
- `admin/cfb-debug/index.html`.
- `tools/cfb/secret_audit.js`.
- `.github/workflows/cfb-security.yml`.
- `docs/cfb-production/CANONICAL.md` and this file.

**Changed:**
- `football/cfb_v2/research/v2/weekly/run.py`: contract before inference, monitor,
  withhold gate, matchup shadow stage.
- `football/cfb_lab/`:
  - `models.js`: `CANON.pure` and `ensembleVersion`;
  - `checkpoint.js`: the canonical verdict, ADHOC events, a BET gated on complete
    decision inputs;
  - `governance.js`: the promotion guard;
  - `report.js`: decision basis and modes;
  - `sync_supabase.js`: default season.
- `football/cfb_decision/shadow.js`: pinned artifacts, `CANON.pure`.
- `football/cfb_v2/sync_supabase.js`, `football/cfb_v2/shadow_decisions.js`,
  `football/fbs/build_coverage.js`, `football/cfb_terminal/build.js`: `CANON.pure`.
- `football/cfb_production/`:
  - `compat.js`: `decisionArtifacts`, `lab_ensemble_version`;
  - `health.js`: roles, and the canonical modes and level in "Degraded games";
  - `manifest.json`: regenerated;
  - `sql.test.js`: the V2 mirror fixture;
  - `tests.js`.
- `football/cfb_market/run.js`: default season.
- `app.html`: the V2 panel reads stored projections, with the stored-read policy,
  official vs research, and the closing-line tendency.
- `admin/cfb-lab/index.html`: research labels.
- `admin/cfb-ops/index.html`: roles, and a level column in "Degraded games".
- `supabase/functions/edgedesk_ai/_cfb_explain.js` (`cfb_explanation_boundary_v2`),
  `supabase/functions/edgedesk_ai/index.ts` (inlined), `tools/presentation/inline.js`.
- The workflows `cfb-lab.yml`, `cfb-production-tests.yml`, `cfb-lab-tests.yml`,
  `cfb-weekly-tests.yml`, and `package.json`.
- The tests `frontend_contract.test.js`, `explain_guard.test.js`,
  `cfb_v2_panel.test.js`.
- The docs ARCHITECTURE.md, VERSIONING.md, ROLLBACK.md and SECURITY.md.

**Functions (new):**
- `canonical.pure / snapshot (generateCfbPredictionSnapshot) / checkRow / modes / resolve / display`;
- `numeric.sanity / consistency / coverConsistency / policyConsistency / utc / requireAsOf`;
- `projections.build / officialDecision`, `trace.build`;
- `promotion.guard`, `compat.decisionArtifacts`, `models.ensembleVersion`;
- `contract.enforce / monitor / build_reference`, `matchup_shadow.run_stage`;
- `secret_audit.audit`.

**Tables:** none added or altered by H3. No SQL was applied anywhere.

**Stored files the hourly job now publishes:**
- `football/cfb_production/reports/projections.json`;
- `football/cfb_production/reports/traces.json`;
- `football/cfb_market/ledger/`.

## 62. Unresolved production risks

1. **The weekly engine has not recorded a 2026 run** (`football/cfb_weekly/2026/runs.jsonl` is
   absent; ops health CRITICAL `last_weekly_run`). `current.json`'s V2.1 rows are PROVISIONAL,
   and the input contract, monitor and withhold gate have run only in tests. The first real run
   is the first real enforcement.
2. **No governed decision exists yet.** Every official decision is NO_DECISION until a LIVE freeze
   and captured quotes feed the decision shadow. The promotion guard's shadow sample is 0 of 150.
3. **The database half is unverified from here.** Whether `cfb_production.sql`, `cfb_market.sql`,
   `cfb_market_integrity.sql`, `cfb_v2_model.sql` and `cfb_terminal_analytics.sql` are applied in
   the real project cannot be checked here. Until they are, job locks are the workflow concurrency
   group only, `cfb_health()` does not run, and the market mirror warns and skips.
4. **No paging.** A CRITICAL alert is a red run, an incident row and the dashboard; nobody is paged.
5. **The explanation boundary is not deployed**, and the chat does not yet explain V2 games through it.
6. **Precision:** the pinned engine's rounding before `decide()` (≤ 1.8e-4 in a cover probability)
   stays.
7. **The feature monitor flags 9 of 13 live 2026 weeks**, mostly `exp_plays_total`, which moved
   with the 2023 clock rule. That is a known, reported drift. It needs a person's judgement, not a
   refit.
8. **Degraded is the norm today:** 55 of 60 games are level 2 (availability data and QB
   certainty). The public panel says so in words.
9. **`editorial_cron` and `newsletter_cron`** can be poked by any gateway-authorised caller (not
   CFB; debounced).

## 63. Final readiness status

**The V2.1 pathway is ready to operate in SHADOW. It is not promoted, and it is not ready for
betting.** The evidence:

- **Code: green.** Every required suite passes on this branch (below).
  `manifest.js --check` passes. The gate prints `proceed=true` and `decisions=true`.
  The release checklist says RELEASABLE_WITH_WARNINGS; its only substantive warning is that
  there is no weekly-engine run.
- **Governance: unchanged.**
  - V1 is the champion.
  - No Model Championship was run (NOT_RUN).
  - V2.1 is ELIGIBLE_FOR_PROMOTION, pending a person's `governance.js promote`.
  - The promotion guard refuses today for want of a live sample, as it should.
- **Trustworthiness: enforced.**
  - Every V2 number passes one service, with an input contract and numeric checks.
  - Every stored projection carries its modes and fallback level.
  - The official status has one definition.
  - Snapshots are immutable.
  - Stored outputs reproduce from their inputs.
  - A played week replays deterministically.
  - Injected failures fail closed.
- **Not yet proven in production:**
  - a weekly-engine run under the contract;
  - a governed decision;
  - the database half (risks 1-3).
- **Betting stays disabled.** Nothing here enables it, and nothing should until the governed
  decision has a validated live record.

## What needs the owner

1. Apply the migrations through *Deploy intelligence* (`apply_cfb_lab`, which applies
   `cfb_production.sql` last). Apply by hand `cfb_market_integrity.sql`, `cfb_market.sql`,
   `cfb_v2_model.sql` and `cfb_terminal_analytics.sql`. None has an automated step.
2. Then set the repository variable `CFB_REQUIRE_JOB_LOCK=1`.
3. Decide whether to deploy `edgedesk_ai`: the inlined boundary is source only.
4. Limit pg_cron `cfb_lab_hourly` to August-January (OPERATIONS.md §7).
5. Let the weekly engine complete a 2026 run (`cfb-v2-shadow.yml`), and review its
   `feature_monitor.json`.
6. Optional:
   - a paging channel for CRITICAL incidents;
   - an `x-cron-secret` on `editorial_cron` and `newsletter_cron`;
   - retire candidate 001 once V2.1 has its sample.
7. Promote V2.1 only when the promotion guard passes, and only as a person.

No new secret is needed.

## Suites run on this branch

All of these are green:

| suite | result |
|---|---|
| `football/cfb_production/tests.js` | 120 |
| `football/cfb_production/sql.test.js` (real PostgreSQL) | 133 |
| `ui.test.js` | 40 |
| `canonical.test.js` | 117 |
| `debug_ui.test.js` | 32 |
| `golden.js` | 15 cases |
| `final_hardening.test.js` | 23 |
| `replay.test.js` | 7 |
| `security.test.js` | 55 |
| `npm run cfb:lab:test` | 14 suites: tests 275, backfill 7, capture feed 19, sql 443, ui 83, record 42, integrity 82, chaos 50, providers 69, sign 67, frontend contract 38, explain guard 48, integrity sql 52, integrity gates 23, market sync 13 |
| `football/cfb_market/tests.js` | 129 |
| `football/cfb_market/sql.test.js` | 44 |
| `football/cfb_decision/tests.js` | 101 |
| `football/cfb_decision/sql.test.js` | 44 |
| `football/cfb_v2/tests.js` | 100 |
| `tools/sql/split_sql.test.js` | 172 |
| `football/cfb_weekly/sql.test.js` | 31 |
| `football/cfb_matchup/sql.test.js` | 77 |
| `football/cfb_personnel/sql.test.js` | 42 |
| `football/cfb_terminal/tests.js` | 113 |
| `football/cfb_terminal/user_test.js` | pass |
| `football/cfb_terminal/build.js --check` | pass |
| `tools/app/game_research.test.js` | 186 |
| `tools/presentation/presentation_sync.test.js` | 26 pairs |
| `tools/presentation/edgedesk_ai.test.js` | 38 |
| `tools/presentation/presentation.test.js` | 155 |
| `tools/football/cfb_v2_panel.test.js` | 20 |
| `npm run cfb:test` | exit 0 |
| `python3 -m v2.weekly.tests_weekly --fast` | 89 |
| `python3 -m v2.tests_finality` | 11 |
| `python3 -m v2.weekly.tests_games --fast` | 74 |
| `python3 -m v2.weekly.tests_contract --fast` | 51 (54 on the real build) |
| `python3 -m v2.personnel.tests_qb --fast` | 64 |
| `python3 -m v2.personnel.tests_units --fast` | 73 |
| `python3 -m v2.matchup.tests_matchup --fast` | 40 |
| `football/cfb_lab/ledger.js verify` | intact |
| `football/cfb_production/manifest.js --check` | ok |
| `gate.js start --job cfb_lab_hourly` (no `SB_URL`) | proceed, decisions true |

The Python suites were run with empty temporary `CFB_V2_DATA` and `CFB_V2_OUT`.
