# EdgeDesk: rules for coding agents

Many scheduled jobs and several coding sessions write to this repository at the same time. Main changes every few minutes. These rules exist because a merge resolved by hand broke main on 2026-10-26 (#800, #801). Each rule is enforced by a check. The check is the backstop, not the plan. Background: [docs/engineering/MERGE_SAFETY.md](docs/engineering/MERGE_SAFETY.md).

## Never

- **Never merge a pull request,** and never enable auto-merge. A person merges.
- **Never push to `main`.** Work on your branch and open a pull request.
- **Never resolve a merge conflict in GitHub's web editor,** and never click "Update branch" when it reports conflicts. Resolve locally (below).
- **Never disable, skip, weaken or delete a test or a check to get green.** That includes `continue-on-error`, path filters on `integrity-gate.yml`, entries added to `tools/integrity/baseline.json`, and loosened assertions. Fix the cause. If a failure is not yours, say so on the pull request with the evidence.
- **Never edit `CHANGELOG.md`.** It is generated (below).
- **Never commit a file a scheduled job writes** unless your change is to the code that writes it (below).
- **Never add the `generated-files-ok` or `parallel-ok` labels yourself.** They are a person's decision.

## Before you start: claim your subsystem

Two sessions changing the same code at once guarantee a conflict. #799 and #800 both fixed `distributionSpread`, and resolving that conflict broke main.

1. List the open pull requests into `main` and the files each changes (GitHub MCP: `list_pull_requests`, then `pull_request_read` with `get_files`).
2. Run `node tools/integrity/lock.js --keys <the paths you will change>` and `--keys <their paths>`. If any key matches, the area is taken. Stop and tell the user which pull request holds it. Do not work around it.
3. Open your **draft pull request as soon as you have a first commit.** An open pull request is what claims the subsystem for you.

`subsystem-lock` in the integrity gate enforces this. The older pull request holds the claim, and a newer one fails until the holder merges or closes. The check re-runs by itself when that happens.

## Changelog: one new file per change

```sh
node tools/changelog/assemble.js --new "The headline, in the house style"
# edit changelog.d/<date>-<slug>.md: "## YYYY-MM-DD — Headline", a blank line, then the body
```

The Changelog job renders fragments into `CHANGELOG.md` on main. Two pull requests that each add a fragment never conflict. To change a published entry, edit its fragment.

## Generated files

18,600 tracked files are written by scheduled jobs (inventory: [docs/engineering/GENERATED_FILES.md](docs/engineering/GENERATED_FILES.md)). Ownership is read from the workflows:

```sh
node tools/integrity/ownership.js <path>             # generated? which job owns it?
node tools/integrity/ownership.js --explain <path>   # which code justifies changing it
```

- **Test runs and builds rewrite generated files locally,** for example `football/venues/forecasts.json`. Before every commit, run `git status` and restore anything you did not mean to change: `git checkout origin/main -- <path>`.
- **A generated file may be in your pull request only if you changed the code that produces it.** That code is the owning workflow, a script it runs, or a module that script loads. Otherwise the gate refuses the pull request.
- **A new job that publishes** goes through `tools/ci/push_generated.sh`, or puts `bash tools/ci/attest_head.sh &&` before a raw `git push` to main. It also needs `contents: write` and `statuses: write`. The lint in `tools/integrity/integrity.test.js` enforces both.

## Updating your branch and resolving conflicts

1. `git fetch origin main && git merge origin/main`. Use rebase only on a branch only you have pushed to, and only if the repo's history there allows it.
2. **For a generated file, take main's version** (`git checkout origin/main -- <path>`), or regenerate it with its own script. Never merge it by hand.
3. **For source, keep both sides' intent.** Deleting both sides of a conflict is exactly what broke #800.
4. Run `node tools/integrity/gate.js local`. It merges your HEAD into the current `origin/main` and checks every changed file, as CI will.
5. Run the suites for what you touched, then push. The new commit is checked from scratch. A conflict-resolution commit gets no credit for earlier passes.

## The checks

`integrity-gate` is the one check main requires (`.github/workflows/integrity-gate.yml`). It passes only when all three of these pass:

- **verify:** your head merged into the **latest** main, with every changed file parsing; no conflict markers; no hand-edited generated files; valid changelog fragments. It also runs the gate's own tests.
- **subsystem-lock:** no older open pull request holds what you change.
- **ci-complete:** every other workflow your commit triggered finished green. Path-filtered suites become required exactly when they run.

When another pull request merges, `integrity-revalidate.yml` re-runs your gate against the new main. A failing gate on your pull request is your work. Read the job summary; it names the file and line.

## Workflows

- **Validation workflows that run on push to main** use this concurrency pattern, so main runs every commit to the end (linted):

  ```yaml
  concurrency:
    group: <name>-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

- **Never give `integrity-gate.yml` a path filter,** and never let its `integrity-gate` job be skipped. A skipped required check counts as passing.
- **A job that commits into a pull request branch** must then run `gh workflow run integrity-gate.yml --ref <branch> -f pr=<number>` and have `actions: write`. A `GITHUB_TOKEN` push starts no workflow, so without it the new head never gets its check (linted).
