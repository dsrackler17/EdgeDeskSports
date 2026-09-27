# CFB deployment: staged release, release checklist, migration safety

## 1. Staged deployment: BUILD → TEST → MIGRATE → SHADOW → VERIFY → PROMOTE

A model change and a database migration are never shipped in the same step:
every migration here is additive and backwards compatible, applied (MIGRATE)
before the code that relies on it runs, and a model is promoted (PROMOTE) only
after it has run in shadow on production data.

| stage | what happens | command / where | gate to pass |
|---|---|---|---|
| **BUILD** | a new model version is its own artifact directory with a MANIFEST.json (retrain mode never overwrites a manifested one); the compatibility entry and manifest are regenerated | `bash run_all.sh retrain` (offseason, `CFB_V2_MODEL_VERSION=<new>`); `node football/cfb_production/manifest.js --write-compat` (reviewed by a person) and `--write` | the artifact verifies; the version bump is sufficient (VERSIONING.md §2) |
| **TEST** | every suite, including the real-Postgres ones and the weekly engine's python suites | PR checks: `CFB production tests`, `CFB weekly engine tests`, `CFB Model Lab tests`, `CFB decision engine tests`; locally `node tools/cfb/release_check.js --with-sql --with-python` | release-check items 1–7 PASS |
| **MIGRATE** | apply the SQL (idempotent, additive, no ACCESS EXCLUSIVE in cfb_production.sql; the manifest is recorded right after) | GitHub → Actions → *Deploy intelligence* → `apply_cfb_lab` (cfb_lab → cfb_lab_cron → cfb_weekly → cfb_personnel → cfb_decision → **cfb_production** → manifest push) | every report row `ok`; `select * from public.cfb_health(now());` answers |
| **SHADOW** | the new version runs beside the champion: the weekly engine projects it, the Model Lab snapshots it at every checkpoint, the decision engine decides on it with betting disabled | scheduled jobs (cfb-v2-shadow.yml, cfb-lab.yml) | the gate passes; ops.json OK/WARNING, no CRITICAL |
| **VERIFY** | live evidence accumulates: settled official snapshots, the lab's promotion evaluation, anomaly rules quiet, decisions fail closed where they should | `admin/cfb-lab/` comparison, `admin/cfb-ops/` | lab promotion evaluation ELIGIBLE; release check `--strict` PASS |
| **PROMOTE** | a person promotes, with reason and evidence; a new manifest is recorded | `node football/cfb_lab/governance.js promote --model <v> --reason "..." --actor <name>`; commit; *Deploy intelligence* (records the manifest) | VERSIONING.md §4 |

Rollback at any stage: [ROLLBACK.md](ROLLBACK.md).

## 2. The release checklist (`tools/cfb/release_check.js`)

```sh
node tools/cfb/release_check.js --with-sql --with-python --strict   # a release candidate
node tools/cfb/release_check.js --skip-tests                         # a quick look
```

Twelve items, each PASS / WARN / FAIL with its evidence; any FAIL exits 1:
tests green · migrations present (apply path, a suite that applies it, editor
parts) · migration safety (no destructive statement) · manifest valid (verifies,
not stale, NOT_RUN unless a championship's evidence exists) · artifacts
hash-verified and recoverable from git · compatibility · no unversioned hotfix ·
shadow checks (V2.1 projecting and snapshotted, betting disabled) · rollback
ready (V1 pinned as fallback, ROLLBACK.md, a previous manifest) · jobs (registry
= workflows / pg_cron, gates wired) · sources healthy now · clean tree + docs.
`--strict` turns the operational WARNs (dirty tree, unhealthy sources, a pinned
blob missing from git) into FAILs. The PR workflow runs it informationally.

## 3. Migration safety review (`migration_review.js`, `reports/migration_review.json`)

Static: every top-level statement (split_sql.js, so function bodies are never
mistaken for DDL) and the dynamic SQL in DO blocks. Measured: each file applied
to a throwaway PostgreSQL 16 in dependency order, then **re-applied as one
transaction** (the SQL editor) with `pg_locks` read before commit.

| file | stmts | destructive | DROP TRIGGER/POLICY + recreate | unguarded ENABLE RLS | plain CREATE INDEX | lock_timeout | apply ms | re-apply ms | tables in ACCESS EXCLUSIVE on re-apply |
|---|---|---|---|---|---|---|---|---|---|
| cfb_lab.sql | 72 | 0 | 8 | 1 (loop) | 17 | no | 153 | 93 | **13 (every lab table)** |
| cfb_lab_cron.sql | 10 | 0 | 0 | 0 | 0 | no | 43 | 35 | 0 |
| cfb_weekly.sql | 38 | 0 | 4 | 1 (loop) | 8 | no | 109 | 48 | **14** |
| cfb_personnel.sql | 27 | 0 | 4 | 1 (loop) | 8 | no | 89 | 47 | **10** |
| cfb_decision.sql | 26 | 0 | 4 | 1 (loop) | 7 | no | 94 | 48 | **11** |
| cfb_v2_model.sql | 49 | 0 | 7 | 4 | 7 | no | 119 | 48 | **18** |
| cfb_market_integrity.sql | 21 | 0 | 5 | 1 | 3 | no | 80 | 57 | **3 (incl. cfb_lab_results)** |
| cfb_matchup.sql | 24 | 0 | 4 | 1 | 6 | no | 79 | 44 | **6** |
| cfb_market.sql | 19 | 0 | 4 | 1 | 4 | no | 92 | 48 | **7** |
| **cfb_production.sql** | 67 | 0 | **0** | **0** | 10 (new tables; one evidence-based on cfb_decision_snapshots, created once) | **yes (5 s)** | 145 | 71 | **0** |

Findings and rules:

* **No destructive statement** in any CFB migration (no DROP TABLE / COLUMN,
  TRUNCATE, DELETE, type change). Defaults are constants or `now()` on new
  tables; no `ADD COLUMN ... NOT NULL` without a default; no volatile default on
  an existing table.
* **Every older CFB file takes ACCESS EXCLUSIVE on all of its tables when it is
  re-applied** (DROP TRIGGER IF EXISTS + CREATE TRIGGER, ALTER TABLE ... ENABLE
  ROW LEVEL SECURITY, DROP / CREATE POLICY) and holds it to the end of the
  transaction. At today's sizes that is ~50–100 ms, but without a lock timeout a
  re-apply that meets a long-running reader queues — and every later reader and
  writer of that table queues behind it. **cfb_production.sql** creates
  triggers, RLS and policies only when missing and sets `lock_timeout = 5s`; its
  re-apply takes no table lock above ROW EXCLUSIVE (sql.test.js asserts it).
  **Recommendation to the owners of the other files** (not changed here): the
  same guards, and `PGOPTIONS='-c lock_timeout=5s'` on their Deploy intelligence
  apply steps (the cfb_production step has it).
* **Indexes** are created with plain `CREATE INDEX IF NOT EXISTS` (SHARE lock
  while building; readers are not blocked, inserts wait). Fine at current
  sizes; for a table past a few million rows build it `CONCURRENTLY` by hand
  first (outside a transaction), after which the file's `IF NOT EXISTS` is a
  no-op.
* **Large changes are phased**: add (nullable / new table) → backfill in
  batches → switch readers → only then constrain. Nothing in this release needed it.
* **Dry run**: the measured table above is the dry run against a clean
  database; the Supabase staging path is the same workflow pointed at a
  staging project's `SB_DB_URL`.

## 4. For the owner (one-time actions)

1. Run *Deploy intelligence* with `apply_cfb_lab` (applies cfb_production.sql
   last and records the first manifest). `supabase/cfb_market_integrity.sql`
   is still applied by hand (the lab mirror fails soft until it is).
2. After it succeeds, set the repository variable `CFB_REQUIRE_JOB_LOCK=1`
   (Settings → Secrets and variables → Actions → Variables).
3. `supabase/cfb_v2_model.sql` has no apply path in *Deploy intelligence* (the
   V2 mirror posts to its tables); it is pasted by hand per
   docs/cfb-v2/RUNBOOK.md. Add a step when convenient.
