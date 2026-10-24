# EdgeDesk market intelligence and model validation — master plan

**Objective.** Find out, with evidence, whether EdgeDesk's forecasts carry information the market does not, and show readers the answer: what the model says, what the market says, why they differ, what the record says about trusting either, and what would change the reading. *Research, not picks.* This program builds no feature whose only purpose is to look sophisticated, and it promotes no model change without its pre-registered evidence.

**Documents.**

| file | what | kept by |
|---|---|---|
| `MASTER_PLAN.md` | this plan: design, phases, acceptance criteria, release gates | hand |
| [`AUDIT.md`](AUDIT.md) | Phases 1–2: capability matrix, model audit, market data, defect register, concept → code matrix | hand |
| [`VALIDATION.md`](VALIDATION.md), `validation.json` | model vs market on every committed live ledger, with intervals; hypotheses judged | `npm run market-intel:validate` |
| [`hypotheses.json`](hypotheses.json) | the pre-registered hypotheses (rejected ones stay) | hand, before a test runs |
| [`MARKET_INTEL_BACKTEST.md`](MARKET_INTEL_BACKTEST.md), `market_intel_backtest.json` | what each market-intelligence finding was worth on 2026 football | `npm run market-intel:backtest` |
| [`FCS_UNCAPPED.md`](FCS_UNCAPPED.md), `football/validation/fcs_uncapped_cfb.json` | the FBS-vs-FCS repair experiment (H-014) | `npm run cfb:fcs:uncapped` |
| `model_registry.json` | every published model identity, label problems, live same-game comparisons | `npm run market-intel:registry` |
| [`PROGRESS.md`](PROGRESS.md) | what is done, tested, open and blocked; where to resume | hand, each checkpoint |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | the ranked next actions (Phase 11 scoring) | hand |

---

## 1. What was built, and how it fits what existed

Everything new is a library under `lib/` (ES5, browser + Node, the house style) with a tool under `tools/market_intel/` that runs it on committed data. Nothing new is a navigation item, a service or a scheduled job.

```
committed ledgers ──► lib/edgedesk_validation_lab.js ──► tools/market_intel/validation_report.js ──► VALIDATION.md
 (record/football,     clusterBootstrap, pairedDifference,   (model vs market, by sport and slice;      validation.json
  performance/ledger,  informationTest, calibrationFit,       hypotheses judged on their own windows)
  cfb_lab ledger)      adjust (BH/Holm), marketAt, folds,
                       judge (pre-registered, robust)
quotes ───────────────► lib/edgedesk_market_intel.js ──────► tools/market_intel/market_intel_backtest.js ─► MARKET_INTEL_BACKTEST.md
 (any source)           9 finding kinds, eligibility rules,    (as of 60 min before every kickoff,
  via market_state       7-part explanation, NO_MYTH guard      walk-forward history and fit)
  normalize/check)
everything above ─────► lib/edgedesk_replay.js ─────────────► tools/market_intel/replay.js (CLI)
                        stateAt(event, t): nothing after t; result withheld unless asked
ledgers ──────────────► tools/market_intel/model_registry.js ─► model_registry.json (Model Exchange foundation)
```

**Reused, not rebuilt:** `research_core` (Brier, log loss, Wilson, quantiles), `edgedesk_validation` (sample states), `edgedesk_market_state` (quote normalisation and checks, the 180-minute freshness rule), `edgedesk_calc` (no-vig), the performance ledger and football record (the point-in-time data), the CFB Lab ledgers. Existing validated work was preserved: the 2026-10-19 CFB home-field fix (v1.0.1) is now tested forward (H-013) rather than redone; the FCS-bridge shadow and its promotion rule stand.

---

## 2. Phase status

Status words: **DONE** (acceptance criteria passed, tests executed), **PARTIAL** (done as far as data allows; the gap is named), **BLOCKED** (needs data, an owner decision or a deploy), **NOT STARTED**.

| phase | status | acceptance criteria | evidence |
|---|---|---|---|
| 1 Quantitative audit | DONE | every sport inspected; model table with the ten required columns; actions classified | `AUDIT.md` §1–2 |
| 1.3 Forecast evaluation | DONE for the live ledgers | Brier, log loss, calibration slope/intercept, reliability, MAE, conditional bias, market-relative scores, all with dependence-aware intervals | `VALIDATION.md` |
| 2 Theory compliance | DONE | concept → code matrix with the eight questions | `AUDIT.md` §5 |
| 2.4 Odds arithmetic | DONE | cross-implementation parity, methods checked | `AUDIT.md` §3 |
| 3 Market Intelligence engine | PARTIAL | 9 kinds, written eligibility, explanations from computed numbers only, no-myth guard, deterministic ids, tests | `lib/edgedesk_market_intel.js`, 49 tests. Gap: no Supabase store yet (Phase 6) |
| 3.4 Reference quality | BLOCKED | needs multi-book timestamped history | paid capture paused to 2026-11-01; free data is one book |
| 4 Validation lab | DONE (library) / PARTIAL (data) | point-in-time benchmark, walk-forward folds with embargo and a separation check, clustered intervals, multiplicity, pre-registration, rejected hypotheses kept | `lib/edgedesk_validation_lab.js`, 64 tests; `hypotheses.json`. Data: one partial live season |
| 5 Model improvement | PARTIAL | hypothesis → baseline → isolated change → walk-forward → decision → record | FBS-vs-FCS stage 1 run as pre-registered and REJECTED (H-014, [`FCS_UNCAPPED.md`](FCS_UNCAPPED.md)); the record stays (`football/cfb_p4/fcs_margin_map.js`, `survived: false`); stage 2 is NEXT_STEPS #1 |
| 6 Signal Center integration | BLOCKED (by evidence) | only validated findings reach subscribers | no finding kind has shown value beyond data warnings; integration point designed (`AUDIT.md` §6) |
| 6.1 Graphics | NOT STARTED | — | D-7 (the "EDGE" headline) needs an owner decision first |
| 7 Replay | PARTIAL (foundation) | point-in-time reconstruction, result withheld, coverage windows, no future leakage | `lib/edgedesk_replay.js`, 16 tests (every committed football game replayed, 0 leaks). Gap: no UI; history from 2026-09-11 (forecasts) / 2026-10-03 (quotes) only |
| 8 Model Exchange foundation | PARTIAL | stable identities, versions, label problems, same-games comparisons, no invented scores | `model_registry.json` |
| 9 Subscriber experience | NOT STARTED | — | depends on 6/7 |
| 10 Research reports | PARTIAL | reports reflect observed data only | the three generated documents are the report; scheduling is NEXT_STEPS |
| 12 Testing | DONE for this change | executed, counts recorded | `PROGRESS.md` |
| 13 Release gates | see §4 | | |

---

## 3. Design rules every component follows

1. **Point in time.** A record stamped after the moment being evaluated is never read (`marketAt`, `stateAt`, the backtest's as-of). A reconstructed record is labelled so (`LIVE_RECONSTRUCTED`, `RECORDED`).
2. **Benchmarks fixed before outcomes.** The close is the record's close; the probability-sport benchmark is the last DraftKings quote before the start. No best book is chosen afterwards.
3. **Dependence.** Intervals resample whole weeks or slate days; fewer than 10 clusters is flagged †; an estimate whose sign flips when one cluster is dropped is flagged ‡ and can never be ACCEPTED.
4. **Minimums.** No verdict below 30 games in 4 clusters (50 for calibration).
5. **Multiplicity.** Information tests are adjusted together (Benjamini–Hochberg).
6. **Exploratory vs confirmatory.** A hypothesis formed after looking at its data is EXPLORATORY; its CONFIRMATORY twin runs on games played after registration.
7. **Words.** No finding, explanation or label says who moved a price or why, calls a difference an edge, or implies a wager (`NO_MYTH`, enforced by a thrown error and a test).

---

## 4. Release gates (Phase 13) for this branch

| gate | status | note |
|---|---|---|
| 1 Mathematical correctness | PASS | odds parity, lab statistics against closed forms and simulations |
| 2 Data integrity | PASS for what ships | D-1 and D-2 fixed with regression tests; D-3 fixed in code (deploy pending) |
| 3 Statistical validity | PASS | every claim in the generated docs carries n, clusters and an interval; nothing below the minimums is a verdict |
| 4 Integration integrity | PASS | the suites that read the changed modules were run (`PROGRESS.md`) |
| 5 Access control | UNCHANGED | no RLS or entitlement change; D-6 recorded for the owner |
| 6 Operational readiness | PASS | no new job, no paid call; tools read committed files in seconds |
| 7 Product clarity | NOT APPLICABLE / OPEN | no reader-facing change; D-7 open |
