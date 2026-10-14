# EdgeDesk college baseball — NCAA Division I research engine

Independent fair prices for every Division I baseball game, from models fitted
and validated on college data, with every limitation shown. Research, not picks.

**Start here after an interruption:** `research/PROGRESS_LEDGER.md`.
The full delivery report is `docs/college-baseball/REPORT.md`.

| Layer | Files |
|---|---|
| Sources, seasons, windows | `config.js` |
| Ingestion (connectors, reconciliation, quarantine, provenance) | `ingest/` → `data/` |
| Coverage ledger and data-quality audit | `coverage.js` → `validation/coverage.json`, `validation/data_quality.json`, `research/COVERAGE.md` |
| Rules registry and measured rule evidence | `lib/rules.js`, `rules_evidence.js` → `validation/rules_evidence.json` |
| Team quality (Models 1, 3) and baselines | `lib/team_quality.js`, `lib/baselines.js`, `lib/models.js` |
| Run distributions (Model 4) | `lib/distribution.js`, `run_distribution.js` |
| Simulator (Model 5) | `lib/simulator.js`, `sim_eval.js` |
| Starters, bullpen, workload, starter projection (Model 7, Phase 7) | `lib/pitchers.js`, `pitcher_walkforward.js` |
| Offense, defence, environment features (Model 2) | `feature_research.js` |
| Machine learning and ensemble (Models 6, 8) | `lib/gbm.js`, `ml_ensemble.js` |
| Walk-forward validation | `walkforward.js` (+ `--tune`, `--holdout`) |
| Ablations | `ablations.js` |
| Adversarial auditor, promotion | `lib/audit.js`, `audit.js` |
| Release gates | `release_gates.js` |
| Pricing and settlement | `lib/pricing.js` |
| Readiness states | `lib/readiness.js` |
| Batch inference and the board | `build_slate.js` → `board/` |
| Terminal | `../lib/edgedesk_cbase_ui.js`, `../lib/edgedesk_cbase.css` |
| Delivery report (generated from the evidence) | `report.js` → `docs/college-baseball/REPORT.md` |
| Research workspace | `research/` (protocol, questions, registry, sources, licensing, matrix, dictionary, features, hypotheses, findings, decisions, versions, failed experiments, assumptions, unresolved, reproduce) |
| Tests | `../tools/college_baseball/` |

Reproduce everything: `research/REPRODUCE.md`.
