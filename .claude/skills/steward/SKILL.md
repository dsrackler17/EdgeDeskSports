---
name: steward
description: How to drive an EdgeDesk pull request to mergeable without breaking main. Covers the integrity gate, conflicts, generated files, the subsystem lock and the changelog. Use when fixing CI, answering review, or updating a pull request's branch in this repository.
---

# Driving an EdgeDesk pull request

Follow [CLAUDE.md](../../../CLAUDE.md). This skill adds what to do when the gate speaks.

## Ground rules

- **Never merge.** Never enable auto-merge. Never push to `main`. Never add the `generated-files-ok` or `parallel-ok` labels; those are a person's call.
- **Never resolve conflicts in the GitHub web editor** or with "Update branch" when it reports conflicts.
- **Never skip, disable or weaken a test or a check.** That includes path filters on `integrity-gate.yml`, `continue-on-error`, and new entries in `tools/integrity/baseline.json`.

## When `integrity-gate` fails

Open the failing part's job summary. It names the rule, the file and the line.

| Part | Rule | What to do |
|---|---|---|
| verify | `js`, `json`, `jsonl`, `html-script`, `html-json`, `gzip`, `py`, `sh`, `yaml`, `xml` | The file does not parse in the merge with the latest main. Fix it at the named line, run `node tools/integrity/gate.js local`, then push. |
| verify | `conflict-marker` | A resolution left `<<<<<<<` / `=======` / `>>>>>>>` in the file. Resolve it properly. |
| verify | `merge-conflict` | Your branch conflicts with the current main. Merge `origin/main` locally (CLAUDE.md, "Updating your branch"). For generated files, take main's version. |
| verify | `generated-file` | You committed a scheduled job's output without changing its generator. Run `git checkout origin/main -- <path>`, then commit. If you did change its generator, `node tools/integrity/ownership.js --explain <path>` shows which files count. |
| verify | `changelog` | Fix the fragment's name or heading (`changelog.d/README.md`). For `CHANGELOG.md` edits, move the entry to a fragment. |
| subsystem-lock | | An older pull request is changing the same subsystem, file or `app.html` region. Do not work around it. Tell the user which pull request holds it. The check re-runs when that pull request merges or closes. |
| ci-complete | | Another workflow on your head commit failed or did not finish. That suite's failure is the work: root-cause it the way the repo's CI rules say. |

## Before every push

1. `git status`: restore generated files your local runs rewrote (`git checkout origin/main -- <path>`).
2. `node tools/integrity/gate.js local`
3. The suites for the code you touched.

A new commit, a conflict resolution included, is checked from scratch. Expect `integrity-gate` to go pending again.
