# Reproducing every number

Requirements: Node 20+, Python 3 with `pyarrow` (parquet bridge), network
access to raw.githubusercontent.com for ingestion only. Everything after
ingestion is deterministic: the same committed inputs give the same outputs
byte for byte (seeds are fixed; `--check` modes prove it).

```bash
# 1. warehouse (one process per season; cached sources make re-runs fast)
node college_baseball/ingest/build.js --all            # or --season 2026, add --offline to use the cache only
node college_baseball/coverage.js                      # coverage ledger + data-quality audit
node college_baseball/rules_evidence.js                # seven-inning games, run rule, extra innings

# 2. tuning (SELECTION window only; slow; a deliberate act recorded in the registry)
for m in elo pythag hier poisson_flat massey bt; do node college_baseball/walkforward.js --tune $m; done

# 3. validation (SELECTION + VALIDATION; HOLDOUT only with --holdout, which is registered)
node college_baseball/walkforward.js
node college_baseball/run_distribution.js              # fits the pricing distribution, then:
node college_baseball/walkforward.js
node college_baseball/pitcher_walkforward.js
node college_baseball/sim_eval.js
node college_baseball/ml_ensemble.js
node college_baseball/feature_research.js
node college_baseball/ablations.js
node college_baseball/walkforward.js --holdout         # once per model version; later runs without --holdout carry
                                                       # this version's registered look forward, labelled
node college_baseball/pitcher_walkforward.js --holdout

# 4. board, audit, gates
node college_baseball/build_slate.js                   # a live slate in season, a retrospective replay otherwise
node college_baseball/audit.js --promote
node college_baseball/release_gates.js                 # also refreshes board/research.json (as does audit.js)
node college_baseball/build_slate.js --research        # research.json alone, if anything else changed after the board
node college_baseball/research_docs.js                 # regenerates EXPERIMENTS.md / FAILED_EXPERIMENTS.md from the registry

# 5. tests, then the report (it includes the test record)
node tools/college_baseball/run_tests.js
node college_baseball/report.js                        # docs/college-baseball/REPORT.md, every number read from the evidence
```

The experiment registry (`research/experiments.jsonl`) is append-only and
hash-chained; `node -e "console.log(require('./college_baseball/lib/registry').verify())"`
proves no record was edited.
