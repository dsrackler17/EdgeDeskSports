# Quant desk — PASS 1 inventory (2026-10-11)

What existed before this change, read from the repository, and what was done
with each piece. KEEP = working and left alone; IMPROVE = kept and extended
in place; ADD = new; REPLACE / REMOVE = nothing, see the end.

The short version: EdgeDesk already had a disciplined football research desk
(research packets, a pricing kernel with validation tiers, a multi-sport
board, a staking engine, a critic that rejects invented numbers, a budgeted
odds gateway). What it lacked was a way to price a **prediction-market
contract**, an **independent second check** on the board's top candidates,
an honest account of **which sports were actually scanned**, and a route for
the cross-sport "best bet" question that did not end at the football desk.

## Baseline

`npm run ai:test` and the related suites were run before any change: 69 of 71
suite files passed. The two that failed were already failing and are outside
this change: `tools/integrity/regression.test.js` (content-engine article
approval workflow, 10 cases) and `tools/validation/explain.test.js` (one
terminal-data assertion).

## Components

| Component | Where | Verdict | Notes |
|---|---|---|---|
| Single-game research packet, critic, structured answer | `supabase/functions/edgedesk_ai/_research.js` | KEEP | Untouched. |
| Decision layer (fair-price provenance, freshness ladder, EV floor, gates) | `_intelligence.js` (EDINTEL) | KEEP (+1 field) | The football resolver now reports `known_teams` on an unknown "A vs B" pair, so the browser can hand a non-football pair to the server. Nothing else changed. |
| Pricing kernel and validation tiers (NFL spread LEAN; everything else RESEARCH) | `_pricing.js`, `football/validation/pricing_*.json` | KEEP | Read by the new sport registry for tiers. |
| Board (multi-sport scan, qualification rules R0–R7, coverage) | `_board.js` (EDBOARD) | IMPROVE | `resolveScope` understands "the next N hours". The host sweep accepts an underdog/favorite filter and reports captured-price counts per sport. |
| Football desk (short answers, CFB + NFL) | `_desk.js` (EDDESK) | KEEP | A best-bet question that names **no league** now goes to the audited cross-sport scan instead. Football-scoped questions still reach the desk (pinned in `desk_host.test.js`). |
| Staking engine | `_stake.js` (EDSTAKE) | KEEP | Staking questions are deliberately left to it. |
| Odds gateway, quota, emergency stop | `supabase/functions/odds_gateway`, `supabase/odds_api_gateway.sql` | KEEP | No new path calls the odds API. The quant desk runs LITE and never asks capture to refresh (`quant_host.test.js` proves it with refresh switched on). |
| Capture / close | `supabase/functions/capture`, `close` | KEEP | Captures NFL, CFB, MLB, UFC only (the allowlist). Not changed. |
| Portfolio (Kalshi/Polymarket fills, exact BigInt money) | `lib/edgedesk_portfolio*.js` | KEEP | The fair-odds engine uses the same `{n, s}` decimal convention. |
| EV helpers across the repo (~30 copies, see `docs/odds-helpers-audit.md`) | `lib/research_core.js` `R.odds` and others | KEEP | The new engine is exact-decimal and is checked for parity against `R`'s strict helpers in its tests. |
| Player-prop ledgers with closes | `football/props/<league>/2026/*.jsonl` | KEEP | Now also the input to the calibration report. |
| Auth, subscriptions, billing, entitlements, AI usage allowance | `lib/edgedesk_auth.js`, `supabase/billing*.sql`, `ai_usage.sql` | KEEP | Not touched. The new turn runs after the rate limit, the subscription gate and the LITE usage claim. |
| Prediction-market contract pricing | — | **ADD** | `lib/edgedesk_fairodds.js` (EDFAIR). |
| Venue fee schedules | — | **ADD** | EDFAIR `VENUES` + `market_execution_costs` table for operator-verified schedules. |
| Typed units (probability / cents / dollars / American / decimal) | — | **ADD** | EDFAIR `T`. |
| Independent second-stage audit of top candidates | — | **ADD** | `_audit.js` (EDAUDIT). |
| Sport capability registry (capture, model tier, settlement, key roles) | — | **ADD** | `lib/edgedesk_sport_adapters.js` (EDADAPT). |
| Contract / price / coverage / outage / explain-EV routing and answers | — | **ADD** | `_quant.js` (EDQUANT) + `quantTurn` in `index.ts`. |
| Generic calibration and backtest metrics with a look-ahead guard | — | **ADD** | `lib/edgedesk_calibration.js` (EDCALIB) + `tools/intelligence/calibration_report.js`. |
| Ledgers for audits, price checks, backtests | — | **ADD** | `supabase/quant_desk.sql`. |
| Browser routing for MLB/contract questions | `app.html` `matchupRoute` | IMPROVE | The football resolver used to answer "Rays vs. Guardians" as a football game missing from the card, and read "Cleveland +1.5 at 61¢" as the Browns, without calling the server. Quant questions now go straight to the server, and a pair naming no football team is handed on. |

## Defects found during the audit (fixed in this change)

1. **The flagship question was answered from football only.** The browser
   always sends `desk: true`; the football desk ran first and answered "what's
   the best bet today?" from CFB and NFL alone.
2. **Uncaptured sports looked like empty slates.** NBA, WNBA and NHL are on
   the board's list but are not captured; the board reported them `NO_GAMES`.
3. **No route for a contract price.** "61¢" was ignored; "41¢" would have
   been read by the desk as a spread of 41.
4. **No route for "which sports couldn't be scanned?"**
5. **The browser's football resolver intercepted MLB and contract questions**
   (above).

## Data and access blockers (not fixed here; documented)

- No Supabase, Odds API, Kalshi, Polymarket or Anthropic credentials exist in
  the build environment, and the egress policy refuses the Odds API, Kalshi
  and Polymarket hosts. Live market access was **not** verified; every
  end-to-end run used the repository's fixture network through the real
  handler.
- Kalshi's and Polymarket's fee schedules could not be read from their own
  sites. Kalshi's formula ships as UNVERIFIED (it caps the verdict at
  POTENTIAL EDGE); Polymarket's sports parameters ship as UNKNOWN (net EV is
  not computed). An operator row in `market_execution_costs` verifies either.
- MLB has no pitcher-scratch feed (`mlb_game_cards` carries probable starters
  with no change history), and capture stores no starter with a price, so an
  MLB price cannot pass the audit's availability check: the honest result for
  MLB is POTENTIAL EDGE at best.
- Soccer has no schedule source, no captured prices and no model; tennis was
  retired as a product on 2026-09-27; golf has no data. All three are named
  as not covered in every scan answer.
- `research_sessions` is written by the function but has no DDL in the
  repository; it was not redefined.

## REPLACE / REMOVE

Nothing was replaced or removed. Every working component above is unchanged
apart from the IMPROVE rows.
