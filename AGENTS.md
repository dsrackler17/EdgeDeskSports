# Engineering rules for EdgeDesk Sports

These rules bind every contributor: people, Claude Code, and any other coding
agent. `CLAUDE.md` imports this file, so Claude Code loads it every session.
They exist because of what happened on 2026-10-26
([docs/ci/INCIDENT-2026-10-26.md](docs/ci/INCIDENT-2026-10-26.md)). Four pull
requests merged into `main` with a check red or not yet reported, one of them
ten seconds after a web-editor conflict resolution that left a library
unparseable. Sixteen failed runs followed, from three root causes.

Generating code is not the deliverable. The deliverable is a change that is
verified, reviewed, and honestly reported.

## 1. Before you edit

- **Read the code you are about to change**, and the tests that cover it.
  Find who reads its output: `grep` the module's name across `lib/`,
  `football/`, `tools/`, `app.html` and `.github/workflows/`.
- **Check whether someone is already fixing it.** Look at open pull requests
  and recent `claude/*` branches before you start on a failure. On
  2026-10-26, #799 and #800 fixed the same σ bug in parallel. The duplicate
  made the conflict whose hand resolution broke `main`.
- **When `main` is red, find out why before you blame your branch.** Run the
  failing suite on `origin/main`. Scheduled jobs push data to `main`, and
  those pushes start no workflow, so `main` can go red with no pull request
  involved.

## 2. While you work

- **Use one isolated feature branch per task.** Never push to `main`
  yourself. Only the scheduled data jobs push to `main` directly.
- **Make no unrelated changes:** no drive-by refactors, reformatting, renames
  or dependency bumps. A finding outside your task becomes its own issue or
  pull request.
- **Every bug fix gets a regression test, and you show it failing.** Run it
  against the old code and record the failure in the pull request. Then
  show it passing.
- **Run the affected tests after each meaningful change.**
  `npm run verify:plan` lists them and `npm run verify:affected` runs them.
- **Add no dependency.** Every script runs on a bare Node install, by design.
  A new package, CDN script or binary needs a written justification in the
  pull request and the owner's explicit approval.

## 3. Integrity: never change these to get a test to pass

- Historical forecast records, ledgers, settlement records, and the
  hash-chained performance records (append-only by design).
- Model grading rules, calibration methodology, fitted bounds (for example
  `football/validation/ev_plausibility.json`), and the frozen Market
  Foresight methodology.
- Expected-value safety requirements: the implausible-EV guard, the
  large-EV brake, and the integrity gate.
- Market contract matching and the odds gateway's budget and bypass guards.
- Simulator results and committed artifacts, except by re-running their own
  build (see §5).
- Authorization checks, RLS policies and secret handling.

If the evidence says one of these must change, make that change in its own
pull request, titled as a methodology change, with the evidence and a
before/after on the committed data. Then ask for explicit review. Never fold
it into a fix.

A test fixture may change only when it is wrong. That means stale, invalid,
nondeterministic, or inconsistent with the schema. Say which in the commit
message. Never change a fixture so that a failure goes away.

## 4. Never suppress a check

- No `continue-on-error: true` on a step that tests anything, and no
  `|| true` after a test command.
- No skipped, disabled or quarantined test, and no `if: false`.
- No assertion weakened or threshold raised to make a red test green.
- No `exit 0` path that reports success without running the check.
- A suite that prints SKIPPED, because its browser, database or secret is
  missing, has not passed. Report it as **not verified**.

## 5. Conflicts and generated files

- **Resolve conflicts locally**, never in GitHub's web editor for code or
  JSON. Then run `npm run verify:core`, which parses every tracked file in
  about 20 seconds.
- **Regenerate generated artifacts with their own build. Never hand-merge
  them.** For example: `node football/cfb_terminal/build.js --now <the
  artifact's own generated_at>`, then `node football/cfb_validation/build.js
  --now …`. Then check with `--check`.
- **For `CHANGELOG.md` conflicts, keep both sides' entries.** On 2026-10-26
  conflict resolutions dropped entries more than once, and #799 and then
  #802 each had to restore them.
- **After "Update branch", wait for that new commit's checks.** The merge
  commit is new code that no check has seen. #800 was merged ten seconds
  after its update commit.

## 6. Before you open a pull request

Do all of these, in order, and put the results in the pull request:

1. **List the changed files:** `git diff --name-only origin/main...HEAD`,
   plus anything uncommitted.
2. **Find the affected modules.** `npm run verify:plan` prints the workflows
   your change starts, from their own `paths:` filters.
3. **Run the targeted tests.** These are the suites of the code you touched.
4. **Run the shared safety tests:** `npm run verify:core` (the integrity gate)
   and `npm run verify:affected`.
5. **Run the full required suite:** `npm run verify`. When your change
   touches only one area, the narrower `verify:cfb`, `verify:odds` and
   `verify:research` help you iterate, but they do not replace the full run.
6. **Review the final diff, every hunk:** `git diff origin/main...HEAD`.
7. **Check for accidental changes:** stray files, rebuilt artifacts you did
   not intend, debug output, secrets.
8. **Report** exact counts of passed, failed, and **not verified here**
   (verify lists each one with its reason), and any known failure, whether
   or not your change caused it.

If anything fails, keep debugging. A pull request with a red check is not
finished.

## 7. Merging and claims

- **Never merge, or ask anyone to merge, while any check is red or still
  running**, required or not.
- **Never enable auto-merge, and never merge your own pull request** unless
  the owner says to in that conversation.
- **Never call a change "production-ready", "green" or "done" while a
  required check is failing**, or while a check you could not run is
  unreported.
- **Never claim a deployment succeeded without verifying it.** Check the
  deployed function's response, the published page, or the workflow run's
  own result.
- **A check you could not run is not verified.** Say "not verified (needs
  X)". Never say "passed".

## Where things are

| What | Where |
|---|---|
| Pre-PR gate | `npm run verify` (full), `verify:affected`, `verify:plan`, `verify:core`, `verify:cfb`, `verify:odds`, `verify:research` ([docs/ci/README.md](docs/ci/README.md)) |
| Integrity gate | `tools/ci/integrity.js`, run on every pull request by `Core validation` |
| All checks | `tools/ci/gate.js`, run on every pull request by `all-checks.yml`: passes only when every workflow the change started has passed. After re-running a failed workflow, re-run it too |
| Check categories | `tools/ci/checks.json` (every PR workflow must be in exactly one) |
| Branch protection | [docs/ci/BRANCH_PROTECTION.md](docs/ci/BRANCH_PROTECTION.md) |
| The 2026-10-26 incident | [docs/ci/INCIDENT-2026-10-26.md](docs/ci/INCIDENT-2026-10-26.md) |
