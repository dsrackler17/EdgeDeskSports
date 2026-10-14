# Research workspace — NCAA Division I baseball

This directory is the engine's memory. Read `PROGRESS_LEDGER.md` first after any
interruption; it says what is complete and what comes next. Model results live
in the experiment registry (`experiments.jsonl`), never in prose, so a page here
cannot disagree with the evidence.

| File | What it holds |
|---|---|
| `PROGRESS_LEDGER.md` | milestones, the next dependency, the commands that rebuild each artifact |
| `PROTOCOL.md` | the evaluation protocol, committed before any model was scored; amendments are dated |
| `QUESTIONS.md` | the research questions the build set out to answer, with where each answer lives |
| `SOURCES.md` | every source considered, what it carries, whether it was used |
| `LICENSING.md` | terms of each source and what they permit (gate G1) |
| `RESEARCH_MATRIX.md` | Phase 1: every candidate method classified A/B/C/D |
| `DATA_DICTIONARY.md` | every warehouse table and column, with units and availability time |
| `FEATURES.md` | every model feature: definition, when it is known, which model uses it, status |
| `HYPOTHESES.md` | hypotheses written before their tests, mapped to registry ids |
| `experiments.jsonl` | the machine-readable experiment registry: append-only, hash-chained |
| `EXPERIMENTS.md`, `FAILED_EXPERIMENTS.md` | generated from the registry by `research_docs.js` |
| `FINDINGS.md` | measured facts about college baseball itself |
| `ASSUMPTIONS.md` | every assumption, why, and what would test it |
| `DATA_QUALITY.md`, `COVERAGE.md` | reconciliation findings and the coverage ledger (COVERAGE is generated) |
| `DECISIONS.md` | design and modelling decisions, with the reason and the evidence |
| `VERSIONS.md` | model versions, what changed, which evidence each was promoted on |
| `UNRESOLVED.md` | open questions, time-boxed, with what would resolve each |
| `REPRODUCE.md` | the exact commands that rebuild every number |

## Repository audit (M0) and what was reused

The repository already carried college baseball as **descriptive data only**:
`lib/college_baseball.js` and `supabase/college_baseball.sql` are a query layer
over an ESPN game-log union (`cbb.*`) that deliberately refuses to publish a
projection, a fair line or a starter. Nothing there was changed. The new engine
sits beside it in `college_baseball/` and is reached from Research → Baseball →
**NCAA engine**.

| Reused, unchanged | Used for |
|---|---|
| `engine/lab/fetch.js` | the guarded HTTP client (per-host quota, cache, no paid hosts) |
| `engine/validation.js` | log loss, Brier, calibration slope / in-the-large, reliability bins, leakage audit, date-block bootstrap |
| `engine/stats.js` | Poisson / logistic GLMs with L2 and offsets |
| `engine/csv.js` | RFC 4180 reading of the warehouse |
| `hockey/tools/parquet_select.py` | the parquet bridge (pyarrow) for baseballr-data files |
| `engine/build_registry.js`, `lib/edgedesk_sport_brains.js` | the 12-sport readiness registry; college baseball now reads its state from this engine's own evidence |
| `tools/odds/no_bypass.test.js` | proves no new file reaches a paid odds host |

| Considered and not reused | Why |
|---|---|
| `mlb/` run models | MLB constants (9 innings always, the automatic runner, DH rules, park factors) are wrong for college; every college constant is measured from college data |
| `basketball/` ratings | the pattern (offence/defence ratings, calibration fitted on earlier seasons) was followed; the code is sport-specific |
| the `cbb` ESPN union | it has no box scores, no pitchers and no history before its import began; the engine uses baseballr-data (stats.ncaa.org-derived) for 2012–2026 |
