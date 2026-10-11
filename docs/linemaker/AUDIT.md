# Linemaker build — repository audit (2026-10-11)

This audit came before the linemaker build. It was made by reading the
repository at `0a93d07` and running its suites. It covers what each of the 14
requested phases needs, what already exists, and what was actually missing.
Each claim names the file it comes from. Anything this environment could not
check is marked UNVERIFIED. The environment had no Supabase credentials, no
Anthropic key and no production access.

The short answer: **most of the request already exists and is tested.** That
includes the AI research desk, the odds gateway, the pricing kernel, the
decision engine, the props lab, the prediction ledgers and model health. The
build reuses all of it. It adds only the pieces listed under "Gaps".

## 1. Baseline (untouched code, before any change)

| suite | result |
|---|---|
| `odds:test`, `props:test`, `validation:test`, `bettor:test`, `intel:lint`, `site:test`, `integrity:test` | all green |
| `ai:test`, file by file | 37 of 38 files green. `tools/intelligence/intelligence.test.js` fails 2 cases (572 pass): the "North Texas / Texas State" name-trimming fixture |
| `resilience:test`, file by file | `resilience.test.js` crashes because its UCF @ Oklahoma State fixture is gone from the regenerated slate. `research_snapshots_sql.test.js` fails 1 case for the same game. `quota_guard` and `odds_quota_sql` are green |

All three failures depend on live, committed artifacts that the hourly jobs
regenerate (data drift), and the build does not touch them. They are reported
as pre-existing, not repaired here.

## 2. Phase by phase: what exists

| phase | already in the repository | evidence |
|---|---|---|
| 1 audit | `docs/intelligence-audit.md`, `docs/research-terminal.md`, `docs/odds-helpers-audit.md` | — |
| 2 AI research engine | `supabase/functions/edgedesk_ai`, with the following parts. A typed tool registry with runtime input/output schemas (`_research.js` `TOOLS`, `runTool`). The research packet, with every fact `{value, source, observed_at, freshness}` or `{missing, reason}`. A critic that rejects invented numbers, people and movement causes. Labels PASS / RESEARCH LEAD / PRICE DEPENDENT / MODEL DISAGREEMENT / STALE MARKET / INSUFFICIENT DATA. NFL and CFB matchup, spread, total, moneyline, props (`propsTurn`), board, staking and follow-ups. No model-written SQL: every read is a fixed PostgREST path under the caller's JWT | `docs/intelligence-architecture.md` §1–15 |
| 3 independent linemaker | NFL `football/engine.js` (spread, total, moneyline; empirical margin PMF by spread, pooled total PMF). CFB `football/cfb_p4/engine.js` (per-game sigma, re-centred PMF). CFB v2 is in shadow. The pricing validation runs walk-forward against the close (`football/validation/pricing_*.json`): NFL spread LEAN, everything else RESEARCH. A market-free research engine (`lib/edgedesk_research_engine.js`) | pricing audit |
| 4 matchup analysis | Ten interaction modules with mechanism, counter-case, uncertainty and `in_model` (`_analyst.js`). Identity profiles (`football/identity/`). Opponent-adjusted unit metrics (`football/matchup/metrics.json`). A football evidence packet (`lib/football_evidence.js`) | §10 |
| 5 edge finder | The decision layer `lib/edgedesk_decision.js` (BET/LEAN/WATCH/PASS/NO DECISION, which can return none). The canonical market (`lib/edgedesk_market.js`). The execution ladder (`lib/edgedesk_execution.js`). Quote EV (`lib/edgedesk_quote_ev.js`). The Edges panel and the Card page | — |
| 6 props lab | `lib/edgedesk_props.js` (Normal / Poisson / NB / gamma-compound / longest-play distributions). `football/props/` pipeline. The data factory, with walk-forward validated per-prop models. The `#playerprops` page | `docs/player-props/DESIGN.md` |
| 7 Pro / Lite | **Partly.** The deterministic desk turn (`deskTurn`, `_desk.js`) and the full pipeline exist, but nothing routes between them by cost, and there is no per-tier quota | gap G3 |
| 8 odds cost protection | `odds_gateway` with `odds_api_gateway.sql`, which provides: DB cache, single-flight, leases, budgets (daily/monthly/reserve), cadence, a breaker, a cooldown, a stale fallback, a dashboard, alerts and an emergency stop. Tests cover 25 concurrent requests → 1 fetch, provider outage, 429/401 trips and the stale snapshot. `no_bypass.test.js` | odds audit |
| 9 UI | The Desk drawer, the Edges panel, Football (NFL/CFB), `#playerprops`, the Card, the Record (model performance), Portfolio, and the personal research (watchlist, journal) | UI audit |
| 10 accountability | `research_packets` (write-once), `desk_prediction_history` (pregame only), `recommendation_ledger`, `bettor_decision_evaluations`, `model_pnl`, `cfb_lab` (Brier, log loss, RMSE, interval coverage), `lib/edgedesk_validation.js`, `model_health.json` | accountability audit |
| 11 security | A subscription gate (refuses anon, 402 when not entitled), RLS on per-user tables, service-role functions behind `security definer`, a secret scan in `intel:lint`, retrieved text treated as data | — |
| 12 tests | About 400 npm scripts, about 70 workflows. A throwaway PostgreSQL harness (`tools/personal/_pg.js`) and Chromium e2e | — |
| 13 release | Additive idempotent SQL with `_rollback.sql` files. Edge functions deployed by workflow | `supabase/README.md` |

## 3. Gaps the build fills (verified by reading the code)

| id | gap | phase | evidence |
|---|---|---|---|
| G1 | **Cross-user read.** The views `research_packet_grades` and `research_packet_pricing` are created without `security_invoker`. A view owned by `postgres` runs with its owner's rights, so RLS on `research_packets` does not apply through the view, and any signed-in reader can see every reader's packets | 11 | `supabase/research_packets.sql`; reproduced on PostgreSQL in `tools/intelligence/research_packets_rls_sql.test.js` |
| G2 | **The Anthropic call has no timeout.** `callModel` calls `fetch` with no AbortController, so a hung upstream holds the request open until the platform kills it | 11 | `edgedesk_ai/index.ts` `callModel` |
| G3 | **AI usage limits are per isolate only.** The 30/min and 300/h map is in memory and not shared. There is no daily quota, no persisted usage and no cost-based routing between the deterministic answer and the model | 7, 11 | `rateVerdict` |
| G4 | **The desk does not know the current screen.** The chat sends the question, a loaded signal and carried ids, but not the open panel, the game on screen or the selected prop | 2 | UI audit §5 |
| G5 | **Saved AI research is browser-only** (`localStorage` `ed_research_snapshots_v1`). Nothing is saved on the server per user | 9 | UI audit §2 |
| G6 | **No team-total pricer and no alternate-totals ladder.** The moneyline is not taken from the distribution that prices the spread. The total distribution is pooled, not conditioned. `validate_extra_markets.js` refuses team totals because there is no closing team-total line to validate against | 3, 5 | pricing audit §5 |
| G7 | **No fair-line dashboard.** Fair numbers are spread over five surfaces, and none shows one game's full sheet (main lines, team totals, alternates) with each probability's calibration | 9 | UI audit §2 |
| G8 | **No probability calibration of the derived markets against outcomes**, and no immutable ledger of a published fair-line sheet | 10 | — |
| G9 | `no_bypass.test.js` does not cover `app.html`'s `oddsFetch`, which can reach the deployed-only `odds` function with caller-chosen markets. Nothing in the app invokes it today | 8 | odds audit §5 |

## 4. Risks found and left as they are (owner decisions or outside the repository)

- **Deployed-only functions** (`odds`, `run_slate`, `wta_odds`, `cfb_close`, …) are not in the repository and cannot be audited from here. `odds_gateway` still falls back to `ODDS_API_KEY`, so a deployed-only function holding that key can spend credits. The only check is the `untracked_provider_usage` alert, which fires after the fact.
- **OddsBlaze** (`collective_odds_ingest`) has its own per-league throttle, but no shared ledger, no budget and no breaker.
- The **`subscriptionGate` fails open** when the subscriptions table is unreachable. This is deliberate and documented: an outage must not lock out paying readers. It is unchanged here, and rule 3 forbids changing billing behaviour.
- **`recommendation_ledger`**: the owner can rewrite the grading columns (`clv`, `closing_*`). Changing that would change a production grading flow, so it is reported, not altered.
- **Same-slate leakage** in the existing CFB replay (`docs/research-terminal.md` §4.7). The new calibration replays are batched by week (slate-blind), so they do not inherit it.
- **The engines' linear weights and residual tables were fitted through 2025.** A cold replay rebuilds the team state, but those parameters are partly in-sample for 2016–2025. The new reports say so, and also report the 2026 season, which no parameter has seen.

## 5. Dependency map of the build

```
football/pricing/lines_nfl.json  ─┐   (archive: scores, closes)
nflverse stats_team_week (cache) ─┼─▶ tools/football/linemaker_calibrate.js ─▶ football/validation/linemaker_nfl.json
cfbfastR schedules (cache)       ─┘        (slate-blind replay of the SHIPPED engines,      football/validation/linemaker_cfb.json
football/engine.js, cfb_p4/engine.js        walk-forward fit, pre-declared method choice)
                                                         │
football/nfl/slate.json, football/fbs/slate.json ────────┼─▶ tools/football/build_fair_lines.js ─▶ football/linemaker/fair_lines.json
lib/research_core.js (odds) ─▶ lib/edgedesk_fairline.js ─┘                                     football/linemaker/ledger/<season>/sheets.jsonl (append-only)
                                        │
                     app.html Linemaker panel (#research/linemaker) · edgedesk_ai (fair-line tool, desk answers)
```
