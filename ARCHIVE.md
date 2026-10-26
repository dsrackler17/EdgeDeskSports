# ARCHIVE: merge-safety work, 2026-10-26 (not for merge)

This branch preserves an unmerged design. **Do not merge it, open a pull request from it, or base work on it.** The work itself is the parent commit `5590845b5` ("wip: merge safety"), built on `main` at `9e4eb47a9`. This tip commit only makes the branch inert:

- every workflow file is moved from `.github/workflows/` to `archived-workflows/`, contents unchanged;
- this file is added.

GitHub runs only the workflows defined in the pushed tip commit, and this tip holds none. A push of this branch therefore starts no workflow: no deploy, no data job, nothing that pushes to `main`. To read the original layout, check out `5590845b5`.

## What it contains, and where each part went

It was written in parallel with #805 and #806, which merged first. The owner chose those as the one CI system. Parts that duplicated them were dropped; three were carried into the reduced pull request; the rest are on hold.

| Part (in `5590845b5`) | Status |
|---|---|
| `tools/integrity/checks.js`, `gate.js`, `integrity-gate.yml` verify job: file parsing, conflict markers | **Superseded.** It duplicates `tools/ci/integrity.js` and Core validation (#805). |
| `tools/integrity/workflows.js`: workflow reader | **Superseded** by `tools/ci/workflows.js` (#805). |
| Concurrency on 30 validation workflows | **Carried** into the reduced PR, with #805's `run_id` pattern and a test in `tools/ci/workflows.test.js`. |
| #800 fixtures (`tools/integrity/fixtures/pr800_*`) | **Carried** into `tools/ci/fixtures/2ad15afadd/` and `tools/ci/integrity.test.js`. |
| `tools/integrity/ownership.js`, `inventory.js`: the generated-file classifier | Findings carried into `docs/ci/GENERATED_FILES.md`. Enforcing them is **on hold** (D2). |
| `tools/integrity/wait_ci.js`: every triggered workflow must pass | **On hold** (D1). |
| `tools/changelog/assemble.js`, `changelog.d/`, `.github/workflows/changelog.yml` | **On hold** (D3). |
| Gate dispatch from the two jobs that commit into PR branches | **On hold** (D4). |
| `tools/integrity/attest.js`, `tools/ci/attest_head.sh`, the `push_generated.sh` attestation, `statuses: write` on 64 jobs | **On hold.** Needed only if the GitHub Actions ruleset bypass proves not to work (docs/ci/BRANCH_PROTECTION.md, step 1a). |
| `tools/integrity/lock.js`, `subsystems.json`: one session per subsystem | **Not adopted.** `AGENTS.md` §1 covers it as a rule. |
| `integrity-revalidate.yml`: re-check open PRs when main moves | **Not adopted.** |
| `CLAUDE.md`, `AGENTS.md`, `docs/engineering/*` | **Superseded** by #805's `AGENTS.md` and `docs/ci/`. |

Known incompatibilities with `main` after #805 (do not cherry-pick blindly):

- `checks.json` has no category for the gate workflows;
- the old concurrency lint rejects #805's valid `run_id` pattern;
- `NaN` JSON is rejected here, while #805 accepts Python's dialect;
- `AGENTS.md`, `CLAUDE.md` and `CHANGELOG.md` conflict.
