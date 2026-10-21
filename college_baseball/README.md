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
| Sportsbook prices, kept from the first game of a season (only when `CBASE_PRICES` and the gateway's `baseball_ncaa` row are on) | `market/fetch_quotes.js`, `market/quotes.js`, `market/aliases.json` → `data/market/<season>/` |
| The forward test against the closing line (EXPERIMENTS.md CBASE-H1, read once) | `../research/clv/cbase.py` → `validation/market_clv.json` |
| The one rule for a value claim | `lib/market_gate.js` (MARKET_VALIDATED for the served configuration, release gates, a live board) |
| Terminal | `../lib/edgedesk_cbase_ui.js`, `../lib/edgedesk_cbase.css` |
| Delivery report (generated from the evidence) | `report.js` → `docs/college-baseball/REPORT.md` |
| Research workspace | `research/` (protocol, questions, registry, sources, licensing, matrix, dictionary, features, hypotheses, findings, decisions, versions, failed experiments, assumptions, unresolved, reproduce) |
| Tests | `../tools/college_baseball/` |

**Value claims.** None until the model has beaten the closing line on prices captured after it was frozen (`research/PROTOCOL.md`, amendment 2026-10-21 b). Until then the board shows probabilities only.

Reproduce everything: `research/REPRODUCE.md`.
