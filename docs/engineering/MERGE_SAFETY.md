# Merge safety: how main stays green with many jobs and sessions writing at once

## What broke, and why "be more careful" was never going to fix it

On 2026-10-26:

| Time (UTC) | What happened |
|---|---|
| 12:35:15 | #801's branch merged main. Conflicts in `app.html` and `CHANGELOG.md` were resolved by hand. |
| 12:36:32 | #801 merged, 77 s later. Two of its checks then failed on that commit: Model performance tests and CFB validation. |
| 12:37 | #799 merged. Its own update merge (`ffc4047085`) had dropped four `CHANGELOG.md` entries, including #801's. |
| 12:47:25 | #800's conflict with #799 was resolved in GitHub's web editor (`2ad15afadd`). The resolution deleted both sides, so `lib/edgedesk_quote_ev.js` stopped parsing and `slate_audit.json` became invalid JSON. |
| 12:47:35 | #800 merged, 10 s later, before any check had run. Main went red in three workflows. |

Five things lined up:

- **Nothing was required.** Main had no protection. Almost every suite is path-filtered, so none of them could be made required: a required check that never runs blocks every pull request forever.
- **Conflicts were constant.** In the history available here, main took 83 commits in about 5½ hours. 73 were bot pushes and 10 were PR merges. Pull requests committed files the bots rewrite, and 8 of 10 PRs edited the top of `CHANGELOG.md`.
- **Two sessions fixed the same function at once** (#799 and #800). The conflict was guaranteed.
- **Conflicts were resolved by hand, in the browser,** and merged at once.
- **Main's own runs were cancelled.** 27 of the last 100 were cancelled by the next push, so main was often never fully tested.

Each piece below closes one of these at the structural level.

## The pieces

| Problem | Mechanism | Where |
|---|---|---|
| Nothing required | One required check, `integrity-gate`, from a workflow with no path filter | `.github/workflows/integrity-gate.yml` |
| Broken files land | Every file the merge changes must parse: JS, JSON, JSONL, `.gz`, inline HTML scripts and JSON-LD, Python, shell, YAML, XML. No conflict markers. | `tools/integrity/checks.js`, `gate.js` |
| Checked against an old main | The gate merges the PR head into main's tip **as read when the job runs** (`git merge-tree`) and checks that result, again if main moves mid-run. `integrity-revalidate.yml` re-runs every open PR's gate when another PR merges or closes. | `gate.js pr`, `revalidate.js` |
| A fix-up commit inherits a pass | Checks belong to a commit. A conflict-resolution commit is a new head SHA, and the gate (no path filter) runs on it from scratch. The gate's summary lists the PR's merge commits and flags those made in the web UI. A job that commits into a PR branch (`simulator-sports-data`, `nfl-coaching-staff-validation`) dispatches the gate with `pr=<n>`, because a `GITHUB_TOKEN` push starts no workflow and the new head would otherwise never get the check. | `integrity-gate.yml`, `gate.js` |
| Path-filtered suites can't be required | `ci-complete` waits for every workflow the head commit triggered and fails if any did not pass. Suites become required exactly when they run. | `tools/integrity/wait_ci.js` |
| PRs commit bot artifacts | A generated file may change only with the code that produces it, or under the `generated-files-ok` label. Ownership is read from the workflows. | `ownership.js`, [GENERATED_FILES.md](GENERATED_FILES.md) |
| `CHANGELOG.md` conflicts | One fragment file per change in `changelog.d/`. The Changelog job renders them on main, and the gate refuses hand edits. | `tools/changelog/assemble.js`, `.github/workflows/changelog.yml` |
| Two sessions on one subsystem | The oldest open PR holds each subsystem, file, or `app.html` region. A newer overlapping PR fails `subsystem-lock` until the holder merges or closes. Override with the `parallel-ok` label. | `tools/integrity/lock.js`, `subsystems.json` |
| Main's validation cancelled | Validation workflows group by commit on main and cancel only on pull requests. | 30 workflows; linted in `integrity.test.js` |
| Bots blocked by required checks | A bot commit is checked, marked `integrity-gate=success` through the commit-status API, then pushed. A broken artifact is never pushed. | `tools/integrity/attest.js`, `tools/ci/push_generated.sh`, `tools/ci/attest_head.sh` |

### Why bots attest instead of bypassing

A ruleset's required status check applies to direct pushes as well as merges. The bots push with the workflow's `GITHUB_TOKEN`, and GitHub does not allow that token on a bypass list.

The alternatives are a GitHub App or a personal token. Either one would make every bot push trigger workflows, which risks loops (the App version job reacts to pushes).

So a bot commit does what the ruleset asks of any commit: it is pushed to another branch (`integrity-attest/…`), checked, and given the status. Then it is pushed to main. Every publishing job has `statuses: write`, and a lint test keeps it that way.

### What the gate does not do

- **It does not re-run the full test suites on the merge result.** It makes the suites the PR already triggered required, and it re-checks file integrity against the latest main.
- **It does not see semantic breakage between two PRs that each passed.** If PR A changes a function and PR B adds a new caller, both can pass. After A merges, the revalidator re-runs B's gate against the new main, but it re-runs only the integrity checks, not B's suites. The `push`-triggered suites on main, which now always run to the end, catch the rest. The subsystem lock prevents most such pairs from existing at the same time.
- **Strict mode ("require branches to be up to date") is off by default** (see the settings below). The revalidator closes most of that gap. One window remains: the seconds between a merge and the start of the next revalidation.

## Turning it on: GitHub settings

Do these in order.

### Step 0: merge this PR, then confirm the bots attest

1. Merge the stabilization PR.
2. Wait for any bot run: `Editorial system` runs every 10 minutes.
3. In its log, find the publish step. It should print `integrity: <sha> checked and marked integrity-gate=success`. On the commit page on main, the status shows as **integrity-gate ✓**.

If a run instead prints `could not set the integrity-gate status … (HTTP 403)`, that job lacks `statuses: write`. Fix that before step 2.

### Step 1: let the check exist

The `integrity-gate` check must have run at least once in the last 7 days before you can pick it in a ruleset. This PR's own run and any merge to main both satisfy that.

### Step 2: create the ruleset

**Settings → Rules → Rulesets → New ruleset → New branch ruleset**

| Field | Value |
|---|---|
| Ruleset name | `main: integrity gate` |
| Enforcement status | **Active** |
| Bypass list | **Leave empty.** `GITHUB_TOKEN` cannot be added anyway, and bots attest instead. In an emergency, set Enforcement status to *Disabled* temporarily. That is a visible, deliberate act. |
| Target branches | **Add target → Include default branch** |
| Restrict deletions | ✅ (default) |
| Block force pushes | ✅ (default) |
| Require a pull request before merging | ❌ **Leave off.** The bots push directly. People and sessions still cannot land anything without the check: a direct push needs the status too. |
| Require status checks to pass | ✅ **Add checks → type `integrity-gate` → select it.** Leave **source** on **"Any source"**: bot attestations are commit statuses, while the PR result is a check run, and both must count. |
| ↳ Require branches to be up to date before merging | ❌ **Leave off** (see below) |
| ↳ Do not require status checks on creation | leave default |
| Require linear history, signed commits, deployments, code scanning | leave off |

Click **Create**.

Why strict mode stays off: bots push to main about 13 times an hour. Strict mode would make every PR update its branch, then wait for the gate, often more than once, while a bot pushes again. The gate already merges with the latest main itself, and the revalidator re-checks every open PR whenever another one merges. Bot commits touch only files the gate keeps pull requests away from, so they cannot change a PR's textual merge.

If you want the stronger guarantee anyway, tick it. Everything here works with it on; it just costs branch updates.

### Step 3: the rest of Settings

- **Settings → General → Pull Requests:** leave **Allow auto-merge** off. Optionally turn on **Always suggest updating pull request branches**.
- **Settings → Actions → General → Workflow permissions:** no change needed. Every publishing job requests `contents: write` and `statuses: write` explicitly.

### Step 4: verify

- **On a pull request:** the checks list shows *Integrity gate / integrity-gate* as **Required**. The merge button stays disabled until it passes. The checks *verify*, *subsystem-lock* and *ci-complete* show what each part found.
- **On the next bot run:** the publish succeeds and the commit shows **integrity-gate ✓**. A bot that prints `Required status check "integrity-gate" is expected` is pushing without attesting; it needs `bash tools/ci/attest_head.sh &&` before its `git push`. The lint in `tools/integrity/integrity.test.js` is meant to make that impossible.
- **Labels:** create two labels, `generated-files-ok` and `parallel-ok`. They are deliberate human overrides.

## Day-to-day commands

```sh
node tools/integrity/gate.js local          # before pushing: your HEAD merged into origin/main, checked
node tools/integrity/lock.js --keys <paths> # what these paths would claim
node tools/integrity/ownership.js <path>    # is this file generated? by whom?
node tools/changelog/assemble.js --new "Headline"   # a changelog fragment
node tools/integrity/integrity.test.js      # the gate's own regression suite
```
