## 2026-10-26 — Merge safety: a required integrity gate, changelog fragments, bot attestation and one session per subsystem

On 2026-10-26 two merges broke main. #800 was merged 10 seconds after a conflict was resolved in GitHub's web editor. The resolution deleted both sides, leaving `lib/edgedesk_quote_ev.js` unparseable and `football/cfb_validation/slate_audit.json` invalid JSON. #801 was merged while one of its suites was still running, and that suite failed a minute later. Nothing required a check, and the suites are path-filtered. Main changed every ~4 minutes, 8 of 10 PRs edited the top of `CHANGELOG.md`, and two sessions fixed the same function. These changes make that sequence fail at the pull request ([docs/engineering/MERGE_SAFETY.md](docs/engineering/MERGE_SAFETY.md)).

- **One required check, `integrity-gate`** (`.github/workflows/integrity-gate.yml`), with no path filter.
  - It merges the PR head into main's tip **as read when the job runs** (`git merge-tree`) and checks every changed file: JS, JSON, JSONL, `.gz`, inline HTML scripts and JSON-LD, Python, shell, YAML and XML must parse, and no conflict markers may remain.
  - It waits for every other workflow the commit triggered and fails if any did not pass. Path-filtered suites become required exactly when they run.
  - `integrity-revalidate.yml` re-runs every open PR's gate when another PR merges or closes.
- **Generated files belong to their jobs.**
  - `tools/integrity/ownership.js` reads each job's outputs from its workflow: 18,600 of 23,165 tracked files.
  - A PR may change one only together with the code that produces it. #800's accidental `football/venues/forecasts.json` is refused; its regenerated `slate_audit.json` is allowed.
  - Inventory and recommendations: [docs/engineering/GENERATED_FILES.md](docs/engineering/GENERATED_FILES.md).
- **Changelog fragments.** Entries go in `changelog.d/`. The Changelog job renders them into the marked block of this file. Hand edits are refused.
- **Bot attestation.** A ruleset's required check also blocks direct pushes, and `GITHUB_TOKEN` cannot bypass one. So every bot commit to main is checked, marked `integrity-gate=success`, and only then pushed (`tools/integrity/attest.js`). A broken artifact is never published. Every publishing job has `statuses: write`. The two jobs that commit into PR branches dispatch the gate on their commit, which a `GITHUB_TOKEN` push would otherwise leave unchecked.
- **One session per subsystem** (`tools/integrity/lock.js`, `subsystems.json`). The oldest open PR holds a subsystem, file or `app.html` region. #800 would have been held at open by #799.
- **Main runs every commit to the end.** 30 validation workflows now cancel only superseded PR runs.
- **Agent rules** in `CLAUDE.md`, `AGENTS.md` and `.claude/skills/steward`.

Tests:
- `tools/integrity/integrity.test.js` (71). Covers #800's broken files byte for byte, a re-enacted web-editor merge, a PR clean against an older main that conflicts with the latest, #801's timeline, the subsystem lock and workflow lints.
- `tools/integrity/attest.test.js` (11). Bot publishing against a mock API.
- `tools/changelog/assemble.test.js` (22). Includes the dropped-entries merge.
- `tools/ci/push_generated.test.js` (32). Its aggregate fixture is now a `.txt` manifest, since a `.json` must parse.

The required check takes effect when the ruleset is created (Settings steps in MERGE_SAFETY.md).
