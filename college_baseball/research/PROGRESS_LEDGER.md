# Implementation progress ledger

**Read this first after any interruption.** It records what is complete,
what is in progress, the next dependency, and the exact commands that rebuild
each artifact. Update it at every milestone; never rely on conversation
history.

Branch: `claude/charming-albattani-amtoze`

## Environment notes (re-check on resume)

- Parquet needs `python3` with `pyarrow` (`pip install pyarrow`). In the build
  container I used a venv: `export PATH=<scratchpad>/venv/bin:$PATH`.
- Only `raw.githubusercontent.com` (and GitHub release assets) are reachable;
  stats.ncaa.org, ESPN, WarrenNolan are blocked from the container.
- Source downloads are cached in `.cache/lab_src` (gitignored). `--offline`
  rebuilds from cache only.

## Milestones

| # | Milestone | State | Artifact / command |
|---|---|---|---|
| M0 | Repository audit; reuse map | DONE | research/README.md §Reuse |
| M1 | Research workspace, protocol, registry module | DONE | research/*.md, lib/registry.js |
| M2 | Ingestion connectors (teams, schedules both shapes, 2023 union, pbp, box, linescore) | DONE | `node college_baseball/ingest/build.js --all` |
| M3 | Warehouse built 2012–2026 + provenance + quarantine | IN PROGRESS | data/games, data/box, data/innings, data/provenance, data/quarantine |
| M4 | Coverage ledger + data-quality audit | TODO | `node college_baseball/coverage.js` |
| M5 | Rules evidence (scheduled length, run rule, extra innings) | TODO | validation/rules_evidence.json |
| M6 | Team quality engine + baselines | TODO | lib/team_quality.js, lib/baselines.js |
| M7 | Run distribution engine | TODO | lib/distribution.js, validation/run_distribution.json |
| M8 | Walk-forward harness (team window) | TODO | walkforward.js |
| M9 | Starter / bullpen / offense / defense / environment engines | TODO | lib/*.js |
| M10 | Pitcher-aware walk-forward + starter projection accuracy | TODO | validation/pitcher_walkforward.json |
| M11 | Simulator + convergence | TODO | lib/simulator.js |
| M12 | ML + ensemble + ablations | TODO | |
| M13 | Pricing + readiness + batch inference | TODO | lib/pricing.js, build_slate.js |
| M14 | Auditor + release gates | TODO | audit.js, release_gates.js |
| M15 | Terminal UI | TODO | lib/edgedesk_cbase_ui.js |
| M16 | CI workflow + registry wiring | TODO | .github/workflows/college-baseball-research.yml |
| M17 | Delivery report | TODO | docs/college-baseball/REPORT.md |

## Next dependency

M3 → M4 (coverage reads the committed warehouse).

## Log

- 2026-10-13: audited repo; found existing `cbb` ESPN pipeline, unvalidated
  browser projection, no odds key. Data source chosen: baseballr-data.
- 2026-10-13: warehouse 2024 built; found NCAA-tournament host-not-batting-last
  games (64 in 2024) — modelled as `bats_last` instead of quarantining; removed
  an incorrect team-ER-equals-sum-of-pitcher-ER check.
