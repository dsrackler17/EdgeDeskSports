# CFB versions: the manifest, compatibility and version semantics

## 1. The production manifest

`node football/cfb_production/manifest.js --write` builds
`football/cfb_production/manifest.json` from what is on disk, hashed — never
from what someone typed — and `--push` records it write-once in
`cfb_production_model_manifest` (the Deploy intelligence workflow does this
right after applying `supabase/cfb_production.sql`, so `deployed_at` is the
deployment time). It answers "what exact model produced this prediction?":

| field | value today | derived from |
|---|---|---|
| champion_model_version | `edgedesk_cfb_p4_v1.0.0` (V1) | governance model_roles.jsonl (last event per model) |
| **champion_selection** | **`NOT_RUN`** | no Model Championship has been run; `SELECTED` needs `championship_evidence` (refused by the table otherwise) |
| production_model_version / status | `edgedesk_cfb_v2.1.0`, `ELIGIBLE_FOR_PROMOTION; governance role challenger` | config.py = params.js = models.json (must agree) |
| git_commit, git_dirty, git_dirty_paths | HEAD and the working-tree state | git |
| migration_version, migrations | `cfbmig_<16 hex>` over every `supabase/cfb_*.sql` (sha256 + git blob each) | the files |
| feature_version | `cfb_v2_fv2` | params.js = models.json = config.py |
| training_data_version | `trained_through_2025/dev2016-2023/holdout2024-2025/seed20260927:<hash>` | meta.json windows, seed, garbage rule, decision-baseline data hashes |
| team_rating_version | `cfb_team_state_v1+ratings:<hash>` | team_state.py rule + rating prior scales / half-life |
| player_model_version | `qb_level:<hash>+cfb_qb_state_v1` (personnel units: research, not an input) | params.qb / qb_common / injury, meta qb_shrinkage |
| matchup_model_version | `D_gbm:<gbm hash>` (matchup residual: research, not an input) | the GBM file |
| ensemble_version | `edgedesk_cfb_v2.1.0:e105ca1727a6` | models.json `stack_weights` {C_ridge 0.5, D_gbm 0.5} |
| calibration_version | `edgedesk_cfb_v2.1.0:97cadb764756` | params calibration.win + cover (= the Model Lab's value) |
| uncertainty_version | `edgedesk_cfb_v2.1.0:<hash>` | distribution, reliability, sigma model, |z| quantiles, injury / weather variance |
| market_engine_version | `edgedesk_cfb_v2.1.0:market:<hash>` | params.market (bet_enabled false) |
| decision_policy_version | `cfb_decision_policy_v1` (SHADOW, betting disabled) | the directory the shadow engine loads |
| decision_engine_version | `cfb_decision_engine_v1` | decision.js |
| artifact_hashes | sha256 + git blob + bytes of 14 files: the V2.1 artifact, params.js, engine.js, the weekly expected-margin artifact, the decision policy, baseline and calibration, decision.js, V1 params.js, compatibility.json | the files |
| compatibility | the matrix entry and the result of every check | compat.js |
| fallback_hierarchy | FULL → DEGRADED → FALLBACK_MODEL (V1) → UNAVAILABLE | ARCHITECTURE.md §4 |
| deployed_at | the deployment instant | `--deployed-at` or now |

`content_sha256` hashes everything except deployment time and git fields;
`manifest_id = cfbm_ + sha256(content_sha256 | deployed_at)[0:24]`. So the same
system redeployed is a new row with the same content hash, and `--check` can
tell "the files changed and nobody regenerated the manifest" (stale) from "same
system, new commit". Every artifact is recoverable byte-for-byte from git via
its recorded blob (`verifyFromGit`, the disaster-recovery test).

**A Model Lab bug this exposed (fixed).** The lab recorded `ensemble_version` as
`<model>:` + sha256 of `P.stack_weights || P.ensemble || {}` from params.js,
which carries no stack weights, so every V2 version recorded `…:44136fa355b3`,
the hash of `{}`: V2.0 (a five-model stack) and V2.1 (C_ridge + D_gbm, 50/50)
had the same "ensemble version". `football/cfb_lab/models.js` `ensembleVersion()`
now derives it from the artifact's `models.json` (`stack_weights`, else the model
list), hashed with the same canonical form the manifest uses:
V2.1 → `edgedesk_cfb_v2.1.0:e105ca1727a6` (equal to the manifest's),
V2.0 → `edgedesk_cfb_v2.0.0:f7e3da3f8a7c`. Rows already in the ledger keep the
old value (append-only; never rewritten); new rows carry the real one.
`compat.js` records `lab_ensemble_version` from the same function and
`tests.js` asserts it equals the manifest's; `canonical.test.js` asserts V2.0 ≠
V2.1 and that the value is stable.

## 2. Version semantics (`versioning.js`)

`edgedesk_cfb_v<MAJOR>.<MINOR>.<PATCH>`

* **MAJOR** — predictive architecture: a new submodel family, stack, target or
  feature schema.
* **MINOR** — a validated component change: retrain, recalibration, new
  ensemble weights, a new decision policy or decision calibration.
* **PATCH** — a bug fix with the intended prediction logic unchanged; outputs
  on the golden inputs must not move.

`requiredBump(kinds)` and `sufficient(from, to, kinds)` encode it (a
recalibration shipped as a patch is refused; a downgrade is never sufficient).
**No unversioned hotfixes:** `unversionedChanges(manifest, facts)` compares
every model file the manifest pins with the disk under the same model version;
any difference FAILs release-check item 7. A real fix is a new version: new
artifact directory with its MANIFEST.json (export.py refuses to overwrite a
manifested one), new compatibility entry, new manifest (its insert writes a
`MANIFEST_RECORDED` row to the hash-chained audit log).

## 3. The compatibility matrix (`compatibility.json`, `cfb_compatibility_matrix`)

An inference, calibration, decision policy or market engine runs only as an
explicitly COMPATIBLE tuple. Today:

| model | role | status | pins |
|---|---|---|---|
| `edgedesk_cfb_v2.1.0` | PRODUCTION_PATHWAY | COMPATIBLE | feature `cfb_v2_fv2`; artifact MANIFEST.json sha; params.js sha (calibration, market rule); engine.js sha; calibration / ensemble / market versions; decision policy `cfb_decision_policy_v1` + its sha; decision baseline `cfb_decision_baseline_001`; decision calibration `cfb_decision_calibration_v1` + its MANIFEST sha; decision engine `cfb_decision_engine_v1`; `bet_enabled_allowed: false` |
| `edgedesk_cfb_p4_v1.0.0` | FALLBACK | COMPATIBLE | V1 params.js sha, feature `cfb_p4_fv1` |
| `edgedesk_cfb_v2.0.0` | CANDIDATE | INCOMPATIBLE | reads feature schema `cfb_v2_fv1`; never a fallback |

**Enforced at inference, not only documented:**
* the weekly engine (`v2/weekly/run.py`, stage PURE_SUBMODELS) calls
  `verify_artifact` and then `verify_compatibility` (project.py) and fails the
  stage (runlog SCHEMA) when the artifact's feature schema, its MANIFEST, or
  params.js differ from the COMPATIBLE entry — new feature code against an old
  artifact, or another version's calibration, never runs;
* `gate.js` runs `compat.check()` before every scheduled job: a pure-model
  failure fails the job before anything is appended; a decision-side failure
  (policy, baseline, decision calibration, engine version) switches the
  decision step off while the lab keeps snapshotting;
* the decision engine itself refuses a calibration built for another model
  version (`NO_BET_VERSION_MISMATCH`).

Why the policy is pinned by directory and content (fixed): `football/cfb_decision/shadow.js`
used to load the *lexically newest* `cfb_decision_policy_*` directory — `v2` sorts
after `v10`, and any newly committed directory would have become live on the next
hourly run. It now loads the PINNED policy and calibration through
`compat.decisionArtifacts()`: the directories the active compatibility entry
names (`decision_policy_version`, `decision_calibration_version`), verified
against the pinned content hashes; a missing or mismatched file throws, and the
decision step fails closed. `compat.facts()` still records the lexically newest
directory (`decision_policy_newest_dir`) so the gate reports a newer, unpinned
policy directory as a disagreement; `tests.js` covers both.

Changing the matrix is a governed act: `node football/cfb_production/manifest.js
--write-compat` regenerates it from the verified files (it refuses an artifact,
baseline or calibration that does not verify); a person reviews the diff; the
push writes a `COMPATIBILITY_CHANGE` audit row.

## 4. The promotion guard (`promotion.js`, enforced)

Promotion is explicit and never automatic. `node football/cfb_lab/governance.js
promote --model <version> --reason "..." --actor <name>` runs the guard first
(`football/cfb_production/promotion.js`, rule `cfb_promotion_guard_v1`) and
refuses unless every check passes; the guard's verdict is written into the
`MODEL_PROMOTED` audit row. Latest never means production.

| # | check | what refuses |
|---|---|---|
| 1 | explicit version | anything but a full `edgedesk_cfb_[p4_]vMAJOR.MINOR.PATCH` ("latest", a label, a prefix) |
| 2 | registered | no governance role; already champion; straight from retired |
| 3 | compatible | no COMPATIBLE entry in compatibility.json (PRODUCTION_PATHWAY; FALLBACK only with `--rollback`, the documented return to V1) |
| 4 | artifact | the artifact is missing or does not verify against its MANIFEST and the pinned hash |
| 5 | schema + calibration | any compatibility check of the tuple fails (feature schema, calibration, ensemble, market engine, decision policy / calibration / engine) |
| 6 | tests | the release checklist's test item is not PASS (run by the guard, or a recorded result passed in) |
| 7 | shadow complete | the Model Lab's promotion evaluation for the version is not ELIGIBLE on a sufficient live sample (skipped only for `--rollback` to the previous champion) |

**V2.1 today** (`node football/cfb_production/promotion.js --model edgedesk_cfb_v2.1.0`):
checks 1-6 PASS; check 7 FAILS, `INSUFFICIENT_SAMPLE (n 0 of 150)`: the live season
has not produced enough graded snapshots. The guard refuses. V2.1 is
`ELIGIBLE_FOR_PROMOTION` on its backtests only; a person promotes it, after check 7
passes, with the command above.

After a promotion: a new manifest is recorded (the champion changes; the
manifest insert writes `MANIFEST_RECORDED` to `cfb_audit_log`), the lab's
governance ledger records `MODEL_PROMOTED` with the guard's verdict, and the
person records the act itself: `select public.cfb_audit('MODEL_PROMOTION',
'edgedesk_cfb_v2.1.0', '{"role":"challenger"}', '{"role":"champion"}', '<why, evidence>', '<name>');`.

The weekly engine runs `PRODUCTION_MODEL_VERSION` (config.py), retrains write new
challenger versions only, and the matrix must name a version before anything runs it.
