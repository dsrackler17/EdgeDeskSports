# Phase 2 — Research Intelligence: inventory (PASS 1)

What existed before Phase 2, what Phase 2 reuses, what it adds, and what is
still missing. Written from the repository on 2026-10-12; every path is real.

## 1. What already existed (reused, not rewritten)

| Capability | Where | Phase 2 use |
|---|---|---|
| Cross-sport board (eligibility, qualification, ranking) | `supabase/functions/edgedesk_ai/_board.js` (EDBOARD), `sweepBoard()` in `index.ts` | The candidate list and the "this weekend" window for the scan and the slate investigation |
| Exact fair-odds / EV / fee engine | `lib/edgedesk_fairodds.js` (EDFAIR) | The oddsmaker prices every candidate through `evaluateWager` / `evaluateContract`. Each venue keeps its own fee formula |
| Adversarial auditor (fresh re-read, 15 checks, bounded re-audit) | `_audit` kernel (EDAUDIT), `quantAuditGather()` | Runs first; its evidence (NFL injury report, depth-chart starters) is what the researcher reads |
| Sport adapters / model capability | `lib/edgedesk_sport_adapters.js` (EDADAPT) | `modelCapability()` decides whether a model may price ("the MLB model runs in the browser only") |
| Pricing kernel + validation tiers | EDPRICE (`football/validation/pricing_{nfl,cfb}.json`) | Model tier (LEAN / RESEARCH / VALIDATED) and the residual sigma for scenario conversion |
| NFL slate engine scenarios | `football/nfl/slate.json` → `scenarios.home_qb_out / away_qb_out` | The ONLY way a finding can move a number: the engine's own re-run delta |
| NFL injury / depth chart build | `football/matchup/metrics.json` (nflverse mirror) | Official / statistical findings with URLs and timestamps |
| MLB probable starters | `mlb_game_cards` (statsapi.mlb.com) | Official starter findings; the "priced starters" for an MLB game |
| Desk notebook | `football/notes/current.json` | Operator-recorded findings with a source URL, kind and time |
| Investigation layer (Brave search, open-meteo, nflverse live) | `RESEARCH_PROVIDERS`, `INVESTIGATION_CACHE` in `index.ts` | Unchanged; the scan's research uses the new ledger instead |
| Portfolio (RLS own rows, exact decimals, CSV import) | `lib/edgedesk_portfolio*.js`, `supabase/portfolio.sql` | Betting-history analytics read `portfolio_positions` under the caller's JWT |
| Write-once ledgers | `supabase/opportunity_audits` (quant_desk.sql), `research_packets.sql` | Pattern copied for `research_findings` / `prediction_snapshots` |

## 2. What Phase 2 adds

| New | File | Tests |
|---|---|---|
| Evidence graph EVENT→TEAM→PLAYER→SOURCE→STATISTIC→MODEL INPUT→PROJECTION→MARKET→AUDIT | `lib/edgedesk_evidence_graph.js` (EDGRAPH) | `tools/intelligence/research_agents.test.js` |
| Model-disagreement engine (9 causes, ranked, verdict) | `lib/edgedesk_disagreement.js` (EDDISAGREE) | same |
| Research levels L1/L2/L3 + ledger (quotas, single flight, cache, breaker, cost) | `lib/edgedesk_research_budget.js` (EDBUDGET) | same |
| Five roles: researcher, oddsmaker, strategist, auditor's classification, communicator (+ critic) | `supabase/functions/edgedesk_ai/_agents.js` (EDAGENTS) | same + `research_host.test.js` |
| Host wiring: research on every audited scan candidate; slate investigation; betting-history route; optional critic-gated narration | `index.ts` (`researchChain`, `researchAudited`, `quantResearchSlate`, `quantBets`, `narrateResearch`) | `research_host.test.js`, `quant_host.test.js` |
| Research memory + pregame snapshots + provider quota ledger | `supabase/research_intel.sql` | `tools/intelligence/research_intel_sql.test.js` (PG16) |
| Betting-history intelligence (leg-row CSV import, EDBETS, dashboard) | `lib/edgedesk_bet_history.js`, `lib/edgedesk_portfolio_import.js` (`leg_rows_sportsbook_v1`), `lib/edgedesk_portfolio_ui.js` | `tools/portfolio/bet_history*.js`, `portfolio_import.test.js` |
| Desk UI for the new answer format | `app.html` (`qdLines`, `qdStrategistHTML`, `qdSlateHTML`, `qdBetsHTML` …) | `tools/intelligence/quant_ui.e2e.js` (Chromium, desktop + phone) |

## 3. Data providers, as they stand

| Provider | Cost | Wired into | Notes |
|---|---|---|---|
| EdgeDesk captured prices (`signals`, `book_quotes`) | existing | board, audit | The only executable prices. The desk never asks capture for fresh quotes (LITE route) |
| nflverse injuries / depth charts (via the metrics build) | free | audit + researcher | Official league report mirror; timestamps carried |
| nflverse live injuries CSV | free, keyless | researcher at L3, through the ledger | Breaker opens after 3 failures |
| MLB statsapi (via `mlb_game_cards`) | free | researcher | Probables only. **No scratch feed**: a late change is seen only if a desk note records it |
| Desk notes | free | researcher | Operator-entered, with a source URL |
| Brave Search | paid (estimate in the ledger) | investigation layer only | Not called by the scan. `EDGEDESK_RESEARCH_PAID_OK` gates it |
| Perplexity Sonar | paid | **not wired** | Evaluated in `DESIGN.md` §9; registered disabled in the ledger and the quota table |
| Anthropic (narration) | paid (existing key) | optional communicator | Off by default (`EDGEDESK_RESEARCH_NARRATE=1` **and** `EDGEDESK_RESEARCH_PAID_OK=1`) |

## 4. Gaps that remain (honest list)

- **MLB starters change history.** There is no pitcher-scratch feed. MLB candidates stay RESEARCH REQUIRED unless availability is otherwise read.
- **College availability.** It is operator-entered only; no official feed is wired.
- **Model-line uncertainty.** The validation records model error against *results* and the outcome sigma. It does not record the model line's error against the close, so "model uncertainty" stays NOT ASSESSED rather than being guessed.
- **Live web research in the scan.** Paid search is not wired into the scan, by design (cost, and unverifiable claims). The researcher reads official, statistical and operator-recorded sources only.
- **Closing-line value for parlays.** EDBETS computes CLV for singles only.
- **Real Juice Reel export.** The leg-row adapter is matched by header names; it has not been checked against a real export.
