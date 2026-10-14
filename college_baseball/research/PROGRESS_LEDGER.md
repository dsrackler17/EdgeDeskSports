# Implementation progress ledger

**Read this first after any interruption.** It records what is complete,
what is in progress, the next dependency, and the exact commands that rebuild
each artifact. Update it at every milestone; never rely on conversation
history.

Branch: `claude/charming-albattani-amtoze` · warehouse merged in dsrackler17/EdgeDeskSports#566; engine in dsrackler17/EdgeDeskSports#569

## Environment notes (re-check on resume)

- Parquet needs `python3` with `pyarrow`. In the build container: a venv on PATH
  (`export PATH=<scratchpad>/venv/bin:$PATH`); in CI `pip install pyarrow`.
- Only `raw.githubusercontent.com` (and GitHub release assets) are reachable;
  stats.ncaa.org, ESPN, WarrenNolan are blocked from the container.
- Source downloads are cached in `.cache/lab_src` (gitignored). `--offline`
  rebuilds from cache only. The walk-forward cache is `.cache/cbase_work/wf_rows.json`
  (rebuilt by `walkforward.js`; every downstream research script needs it).

## Milestones

| # | Milestone | State | Artifact / command |
|---|---|---|---|
| M0 | Repository audit; reuse map | DONE | research/README.md |
| M1 | Research workspace, protocol, registry module | DONE | research/*.md, lib/registry.js |
| M2 | Ingestion connectors | DONE | `node college_baseball/ingest/build.js --all` |
| M3 | Warehouse 2012–2026 + provenance + quarantine | DONE | data/ |
| M4 | Coverage ledger + data-quality audit | DONE | `node college_baseball/coverage.js` |
| M5 | Rules evidence | DONE | `node college_baseball/rules_evidence.js` |
| M6 | Team quality engine + baselines | DONE | lib/team_quality.js, lib/baselines.js, lib/models.js |
| M7 | Run distribution engine + study | DONE | lib/distribution.js, run_distribution.js (fit 2014–18, choose 2019–22) |
| M8 | Walk-forward harness, tuning rounds 1–3 | DONE | walkforward.js; round 3 time-boxed (edges: U-12) |
| M9 | Starter / bullpen / workload / projection engines | DONE | lib/pitchers.js |
| M10 | Pitcher-aware walk-forward | DONE, HOLDOUT LOOKED | pitcher_walkforward.js (hybrid not significant) |
| M11 | Pricing engine study: closed form vs simulator, construction | DONE | sim_eval.js (closed form prices full game; simulator first five, research only) |
| M12 | ML + ensemble + feature research + ablations | DONE | ml_ensemble.js, feature_research.js, ablations.js |
| M13 | Pricing + readiness + batch inference | DONE | lib/pricing.js, lib/readiness.js, build_slate.js |
| M14 | Auditor + release gates | DONE | audit.js, release_gates.js |
| M15 | Terminal (Research → Baseball → NCAA engine) | DONE, TESTED | lib/edgedesk_cbase_ui.js, lib/edgedesk_cbase.css, app.html segment |
| M16 | CI workflow + registry wiring | DONE | .github/workflows/college-baseball-research.yml, lib/edgedesk_sport_brains.js, engine/build_registry.js |
| M17 | Final pipeline, holdout once, docs, report, PR | DONE | PR dsrackler17/EdgeDeskSports#569; report: `node college_baseball/report.js` |

## Next dependency

The engine is complete for model version cbase_v1.0.0. Next work, each a new
model version with its own holdout look: U-14 (home −1.5 margin shape),
U-13 (first-five calibration), U-12 (wider tuning grids). Owner decisions:
G1 (data rights), G12 (market feed).

## Decisions taken during the build (also in DECISIONS.md)

- Run-space calibration replaced the logit calibration for run models so all
  markets of a game stay coherent (the logit map fixed only the moneyline).
- Distribution families are fitted on 2014–2018 and chosen on 2019–2022 by the
  protocol's incumbent/challenger rule; the first version chose on the rows it
  had fitted, which favoured the most flexible family.
- The terminal is a segment of Research → Baseball, not a new Research tab:
  adding to RESEARCH_COVERAGE would have changed what the deployed AI desk
  claims to cover.
- A team's net rating is off + def (def lowers runs allowed); a sign error in
  the first version was caught by the planted-league test.

## Log

- 2026-10-13: audited repo; found existing `cbb` ESPN pipeline, unvalidated
  browser projection, no odds key. Data source chosen: baseballr-data.
- 2026-10-13: warehouse built; reconciliation findings DQ-01..DQ-18
  (research/DATA_QUALITY.md).
- 2026-10-14: tuning rounds 1–2; first walk-forward: hier_cal beats calibrated
  Elo on VALIDATION (Δ −0.0054, 95% −0.0087 to −0.0024); pitcher hybrid not
  significant on 2025 (Δ −0.0003, interval includes 0).
- 2026-10-14: round-3 tuning; final walk-forward: hier_cal chosen and pricing;
  ensemble and rest layer not adopted. Simulator found double-counting the home
  side's last inning; full-game markets moved to the closed form (re-weighted
  construction). HOLDOUT 2025–26 looked at once: hier_cal 0.6026, vs calibrated
  Elo −0.0055 (95% −0.0074 to −0.0035), OUTCOME_VALIDATED on outcomes.

