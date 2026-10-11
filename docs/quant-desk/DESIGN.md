# The quant desk — design

A reader types "What's the best bet right now?", "Is Rays at 61¢ positive
EV?" or "Which sports couldn't be scanned?" and gets a direct answer whose
every number comes from a deterministic service, with the evidence one tap
away. No language model writes these answers.

```
question ─▶ EDQUANT.classify          SCAN · CONTRACT · PRICE · COVERAGE · OUTAGE · EXPLAIN_EV  (else: unchanged pipeline)
  SCAN ─▶ sweepBoard (every sport in season, EDBOARD rules R0–R7, LITE: no capture refresh)
       ─▶ EDADAPT.coverageStatus     NOT_CAPTURED / NO_PRICES / EVALUATED … per sport
       ─▶ EDAUDIT.run (top 3)        fresh signal re-read + per-book quotes + availability → 15 checks,
                                     correct → recalculate → re-audit, at most 2 rounds
       ─▶ EDFAIR.evaluateWager       exact EV, max entry, verdict caps (audit, freshness, liquidity, …)
       ─▶ EDQUANT.renderScan         BEST VERIFIED OPPORTUNITY — or "No verified positive-EV trade…" + the strongest candidate
       ─▶ research_packets + opportunity_audits (write-once)
  CONTRACT / PRICE ─▶ the captured market for the named selection ─▶ EDFAIR.evaluateContract / evaluateWager
       ─▶ EDFAIR.compareVenues (every captured book + the contract, all-in cost per $1)
       ─▶ fair_price_estimates (write-once)
```

## 1. The fair-odds engine (`lib/edgedesk_fairodds.js`, EDFAIR)

**Exact arithmetic.** Prices, fees and EV are decimals held as a BigInt and
a scale (the convention `lib/edgedesk_portfolio.js` uses for the reader's
ledger). Probabilities and odds ratios carry 12 places. Nothing is a binary
float until it is printed.

**Typed units.** `T.probability`, `T.percent`, `T.contractPrice` (dollars per
$1 of payout), `T.cents`, `T.american`, `T.decimalOdds`, `T.dollars`. A value
that looks like the wrong unit is refused with a UNIT error naming the likely
mistake — 61 as a probability ("looks like a percent"), 0.61 as cents ("looks
like dollars"), 61 as a dollar contract price ("looks like cents"), -50 as
American odds, 150 as decimal odds.

**Expected value.**

| | formula (per $1 or per contract) |
|---|---|
| Sportsbook, risk $1 at decimal D | `EV = p·(D − 1) − (1 − p − push)`; break-even `(1 − push)/D` |
| Binary contract (YES or NO), price c | gross `= p − c`; net `= p − c − fee − slippage`; break-even = all-in cost `c + fee + slippage`; net per $1 = net ÷ all-in cost |
| No-vig | multiplicative (default, as the board), additive, power; every outcome of one market at one book, n ≥ 2 (three-way soccer works); a single side is refused |

**Maximum entry price.** The highest tick (contracts) or the worst whole
American price (wagers) at which net EV per $1 still clears EDINTEL's own
`ev_floor` (0.5%), fees and slippage included; also the edge-bar price
(`candidate_ev`, 2%) and the break-even price. The thresholds are read from
`EDINTEL.config()` at run time, so the desk and this engine cannot disagree.

**Venue fees.** Each venue has its own model; none is applied to another, and
an unknown venue is refused.

| venue | model | status shipped | effect |
|---|---|---|---|
| sportsbooks | margin inside the price, no explicit fee | VERIFIED (structural) | — |
| Kalshi | `round_up_to_cent(coef × contracts × P × (1 − P))` per order; taker 0.07, maker 0.0175 on maker-fee markets | **UNVERIFIED** (secondary sources; kalshi.com unreachable from the build environment) | caps the verdict at POTENTIAL EDGE |
| Polymarket | `contracts × P × rate × (P(1 − P))^exponent` per category | **UNKNOWN** for sports (sources disagree) | net EV not computed; the fee headroom is stated |
| unnamed exchange ("61¢" with no venue) | none assumed | UNKNOWN | the Kalshi case is shown as a labelled scenario |
| back/lay and peer-to-peer exchanges quoting odds (`betfair_ex_*`, `matchbook`, `novig`, `prophetx`, `betopenly`, `sporttrade`, `smarkets`, `betdaq`) | commission on net winnings | UNKNOWN (no rate on file) | gross EV only; the commission it could absorb is stated; never ranked as a zero-fee book |
| any book key not on the explicit sportsbook list | not assumed | UNKNOWN | as an exchange: an unknown key is never treated as fee-free |

An operator row in `market_execution_costs` (https source, verifier, effective
window) turns a venue's fees VERIFIED; the desk reads it on every contract
question. A per-request override (`fee_override`) is labelled OVERRIDE.

**Slippage and liquidity.** With an order book (`orderbook.asks`) the engine
walks it for the order size; an order larger than the book, or a book with no
resting size, is INSUFFICIENT (caps at WATCH). A slippage *estimate* is
ESTIMATED and with no depth on file liquidity is UNKNOWN (both cap a contract
at POTENTIAL EDGE). A stake is sized at what the order would actually pay (the
walked book, or the quote plus the slippage estimate, plus fees). A sportsbook
price stands on its confirmation: two or more independent books clearing the
floor; one book, or no confirmation data at all, caps at POTENTIAL EDGE.

**Freshness.** The same bands as `EDINTEL.quoteState`: LIVE under half the
limit, AGING to the limit, STALE at it. Given the market and kickoff (as the
scan passes them) the decision layer's `quoteState` decides outright,
including its two-minute kickoff guard. A fair reference has its own limit (a
model output lives longer than a quote); an AGING fair caps at POTENTIAL EDGE.

**The verdict.** `UNVERIFIED_DATA` (no fair, stale or untimed quote) → `PASS`
(net EV ≤ 0 or under the floor; also any price negative before unknown fees)
→ `WATCH` (floor ≤ EV < edge bar, or fees unknown) → `POTENTIAL_EDGE` →
`VERIFIED_EDGE`. Caps, each named, each only lowering the class: a research-tier
or user-supplied fair (WATCH), EV past the sanity ceiling (WATCH), an
unverified fee schedule, an aging quote, an aging or stale fair, unknown or
estimated contract liquidity, a single or unconfirmed book, a negative EV at
the low end of the fair's interval, unverified settlement, and **no audit**
(all POTENTIAL EDGE); a material settlement mismatch, insufficient liquidity or
the operator's `decisions_enabled = false` kill switch (WATCH); an audit
rejection (PASS). Decision: VERIFIED EDGE → BUY; POTENTIAL EDGE / WATCH
→ WATCH; PASS / UNVERIFIED DATA → PASS. Research confidence is a category from
named conditions, never a fitted score.

**What a fair may be called.** `SHARP_NO_VIG` and `CONSENSUS_NO_VIG` are
market-derived: they can show a book is out of line with the sharp market,
not that the market is wrong, and their record is the closing-line ledger.
`MODEL` prices only under a VALIDATED, LEAN or PROBABILITY tier. `USER` is
arithmetic only.

## 2. The sport adapters (`lib/edgedesk_sport_adapters.js`, EDADAPT)

Per sport: captured by default (NFL, CFB, MLB, UFC — the capture allowlist;
`EDGEDESK_CAPTURED_SPORTS` overrides), the independent model, where it runs
and its tier per market, settlement terms per market (overtime, listed
pitchers, three-way, draws and no-contests), and the roles whose availability
can invalidate a price (QB, SP, G, a star, a fighter). `coverageStatus` turns
"no prices" into NOT_CAPTURED for an uncaptured sport and NO_PRICES for a
captured one with games but no quotes; data wins over configuration.

| sport | independent model | tier | priced by the desk |
|---|---|---|---|
| NFL | edgedesk_football engine (server) | spread LEAN; total, moneyline RESEARCH | spread only, as LEAN (break-even history, not a profit) |
| CFB | edgedesk_cfb_p4 / FBS engine (server) | RESEARCH | no |
| MLB | edgedesk_baseball_v1.0.0 run model (**browser only**) | RESEARCH, never validated | no — market comparison only |
| NBA, WNBA, NCAAB, NHL | none | — | not captured: not scanned |
| UFC | none (market de-vig only) | — | market comparison only |
| Soccer, golf | none | — | not covered |
| Tennis | retired 2026-09-27 | — | not covered |

## 3. The adversarial auditor (`_audit.js`, EDAUDIT)

The board's candidates come from the decision layer reading capture's stored
fair. The auditor does not re-read that copy: the host makes **fresh,
uncached reads** at audit time (the signal row, the per-book quotes, and the
availability sources that exist), and the auditor recomputes EV with a
**different implementation** (EDFAIR, exact) and a **different de-vig method**
(multiplicative on the sharp book's two sides, against capture's Shin fair).
It never falls back to the candidate's own fair: a fresh read with no fair is
"no fresh fair" (A4 cannot pass, the audit cannot confirm).

| check | critical | fails when |
|---|---|---|
| A1 game status | ✓ | the game has started, or starts inside EDINTEL's kickoff guard (2 minutes) |
| A2 quote freshness (EDINTEL's kickoff ladder) | ✓ | stale or untimed — *correctable* by a fresher read |
| A3 still offered | ✓ | suspended or removed; a worse price — *correctable* |
| A4 independent EV | ✓ | the candidate's own arithmetic does not reproduce (INTEGRITY), or the fresh read's EV is under the floor (VALUE) |
| A5 method robustness | | the edge falls under the floor under either de-vig method (WARN) |
| A6 sharp vs consensus | | the references contradict each other (WARN) |
| A7 independent books | | fewer than two books clear the floor, or one off-market book carries the edge (WARN) |
| A8 availability news after the quote | ✓ | a key player (the starting QB, SP, G…) ruled out after the price was captured (FAIL); an empty list not read for both teams, or a key player ruled out with no report time (NOT_CHECKED); a report older than 72 hours (WARN) |
| A9 starter | ✓ for a model price | the starter the price assumed is not the one listed now |
| A10 settlement | ✓ | the contract settles differently from the fair's market |
| A11 fees / A12 liquidity | | unknown fees (FAIL), unverified (WARN), insufficient depth (FAIL) |
| A13 sharp movement | | the sharp fair moved against the selection (WARN) |
| A14 model disagreement | | a gap at or past EDINTEL's `disagreement_points_hard` (7) — a suspected data fault, explained or not (FAIL); an 8-pp gap with no written explanation (FAIL), with one (WARN, carried) |
| A15 sanity | ✓ | EV past the ceiling, or an outlier flag |

Verdicts: CONFIRMED (every critical check passed), DOWNGRADED (a warning, or a
critical check that could not run — never confirmed on missing data),
NEEDS_RECHECK (news or a price after the quote), REJECTED (integrity,
market, value or settlement). **The loop**: a correctable failure is applied
to a copy of the candidate (the fresh price, time, book **and** fair — capture's
stored sharp fair, else the sharp book's two sides de-vigged; a fresher read
with no fair is not a correction and the candidate stays NEEDS_RECHECK; the
re-read fair is relabelled `SHARP_REREAD`, never left under a model's name),
recalculated by EDFAIR, and audited again — at most `max_rounds` (default 2,
never more than 3). A read that throws is a failed read, never a pass. What is
still failing ends NEEDS_RECHECK or REJECTED with `exhausted`. Every step is
in the trail (AUDIT, VERDICT, CORRECT, RECALCULATE, RE-AUDIT, PUBLISH) and in
`opportunity_audits`. The scan never promotes a candidate the board withheld,
unless the only thing it failed was freshness and the audit replaced the stale
price with a fresh read. **The verdict is priced on the fair the audit
re-read** (`independent_fair`), not only on the candidate's older copy: a
market candidate takes the re-read fair; a model candidate takes whichever of
the two gives the lower EV.

## 4. Calibration (`lib/edgedesk_calibration.js`, EDCALIB)

Brier, log loss, Wilson-interval buckets, CLV (EV of the entry at the no-vig
close), ROI after fees with a 95% interval, maximum drawdown, by sport,
market, model version, odds range and any custom group — always beside the
**no-vig closing probability of the same side** on the same rows. Rows with a
prediction at or after the event, or an input observed after the prediction,
are rejected and counted. `CALIBRATED` needs 500+ rows **and 500+ of them
carrying a closing probability**, a Brier no worse than the close on those
rows, and every well-filled bucket inside its interval; a profit claim needs
500+ bets and an ROI interval wholly above zero. A push is not scored for
calibration but counts in the ROI denominator (money was at risk). Walk-forward
trains only on rows *settled* by the cutoff (`settled_at`, else start + 6 h).

**Measured on EdgeDesk's own 2026 settled player-prop ledgers**
(`football/validation/calibration_props_2026.json`, `npm run quant:calibrate`):

| league | settled | vs close (n) | Brier | close Brier | status | ROI after fees (95%) | CLV mean |
|---|---|---|---|---|---|---|---|
| NFL | 4,691 | 1,163 | 0.2602 | 0.2469 | NOT_CALIBRATED | −0.94% (−4.29% to +2.40%) | −3.89% |
| CFB | 5,529 | 779 | 0.2537 | 0.2467 | NOT_CALIBRATED | −1.40% (−4.85% to +2.04%) | −4.92% |

Zero look-ahead violations; 554 / 954 rows without a published probability
were excluded. The prop probabilities do not beat the close, and no profit
claim is supported. Sub-groups with fewer than 500 closes now read
INSUFFICIENT_SAMPLE rather than NOT_CALIBRATED.

## 5. The ledgers (`supabase/quant_desk.sql`)

`market_execution_costs` (service-written, readable when signed in),
`opportunity_audits` and `fair_price_estimates` (write-once, reader-owned
RLS, no reader deletes, one service-role retention door `quant_desk_prune`,
≥ 90 days), `model_backtests` (chronology and zero look-ahead enforced by
constraints), and `opportunity_audit_grades` (security-invoker view joining
the close by `sig_key`). The audit and estimate ids are deterministic hashes,
unique **per user** (`unique (user_id, audit_id)`), so a repeat dedupes but one
user can never swallow or pre-empt another's row. `authenticated` holds only
SELECT and INSERT on the ledgers (SELECT on the fee and backtest tables): the
file revokes the rest, because Supabase's default privileges grant ALL and
TRUNCATE would bypass the row triggers. An earlier apply's global keys are
replaced in place. Idempotent, additive, ends in a report; applied by
`deploy-intelligence.yml` → `apply_quant_desk` (manual).

## 6. Switches and probe

| env | default | effect |
|---|---|---|
| `EDGEDESK_QUANT` | 1 | 0 turns the quant desk off (every question takes the previous route) |
| `EDGEDESK_AUDIT_TOP` | 3 | how many top candidates the second stage audits (1–6) |
| `EDGEDESK_CAPTURED_SPORTS` | capture defaults | which sports count as captured for coverage |

`?probe=1 → quant_kernel` reports the kernel versions, the captured sports,
each venue's fee verification, the thresholds in force and the last audit and
estimate writes (status only: the database's error text, which can quote a
row, goes to the function log, not to callers).

## 7. Tests

| suite | what it proves |
|---|---|
| `tools/intelligence/fairodds.test.js` | units, conversions (parity with `R`), no-vig, Kalshi rounding (incl. the published 100 @ 55¢ = $1.74 example), contract/wager EV, pushes, max entry, stale/missing data, every cap, sizing, order book, cross-venue ranking, price parsing, 700 random invariants |
| `tools/intelligence/audit.test.js` | the registry; a clean CONFIRMED; stale → correct → recalculate → re-audit; recalculation that rejects; calculation disagreement; injury invalidation; incorrect starting pitcher; method dependence; off-market book; model disagreement; settlement; fees; liquidity; the bounded loop; async reads |
| `tools/intelligence/quant.test.js` | routing of every phrasing in the brief, the "next 24 hours" window, coverage scope, the board-withheld rule, filters, state sanitising, the answers, the prose critic |
| `tools/intelligence/quant_host.test.js` | the acceptance questions through the real handler (fixture network): the scan, the verified NFL path, the starter-conflict rejection, contracts, follow-ups, coverage, outage, verified fee schedules, the estimate and audit writes, no odds spend with refresh switched on, and what the desk leaves alone |
| `tools/intelligence/quant_sql.test.js` | the migration against PostgreSQL 16, applied twice and attacked |
| `tools/intelligence/calibration.test.js` | metrics, look-ahead rejection, the calibration and profit gates, groups, walk-forward separation, the backtest row, the committed report |
| `tools/intelligence/quant_ui.e2e.js` | the real handler's answers rendered by `app.html` in Chromium at 1280 px and 390 px |

`npm run quant:test`, `npm run quant:sql`, `npm run quant:e2e`, `npm run quant:calibrate`.

## 8. Routing guardrails

The quant desk answers only what it can price, and hands everything else on:

- **Contract price**: a cents number counts only with a venue, the ¢ sign or
  `$0.61`, the word contract, a YES/NO side followed by a price, or "cents" in
  a price question. "My 2 cents" and "12c kickoff temperature" are not prices;
  two different cents values are refused, not resolved by order; "161c" is not
  61¢.
- **Which team**: the subject of "A to beat B" / "will A beat B"; else the
  team named right before the price; else the only team named. Both named and
  the price attached to neither → nothing is priced and the answer asks which
  side.
- **Which market**: totals, team totals, futures, player props and
  partial-game markets are named and not priced (never as the moneyline).
- **NO contracts** are priced on the complement and compared with the other
  side's sportsbook prices.
- **Not the quant desk's**: a sportsbook price on a football team (the
  football desk has the matchup model), a best-bet question about one game (a
  named matchup, "this game", a game packet, or a team with captured prices —
  unless it says "across all sports"), football "coverage" (pass coverage,
  man or zone), and injury or line-movement questions ("if Allen is ruled
  out" is not an odds outage).
- **Coverage** is always re-read live; a coverage list carried by the client
  is used only when that read returns nothing, and is labelled as the earlier
  scan.

## 9. Independent audits (2026-10-11)

Two separate reviews ran against the first version: one quantitative (the
engine, the auditor, the calibration gates) and one security/integration
(routing through the real handler, RLS, ledgers, the browser). Every finding
was reproduced, fixed, and pinned by a test that fails on the earlier code
(checked by running the new tests against it: 41 fair-odds, 21 audit, 5
calibration and 28 host assertions fail there).

| id | finding | fix |
|---|---|---|
| Q-H1 | the auditor confirmed on the candidate's own fair when the fresh read had none; a correction with no fresh fair kept the stale fair | no fallback; held as NEEDS_RECHECK |
| Q-H2 | the scan's BUY was computed on the candidate's fair, not the audited one | priced on the audited fair (the lower EV for a model) |
| Q-H3 | a NO contract was priced with the YES probability | complement; same-outcome comparison |
| Q-M1–M8 | unknown confirmation uncapped; A7 passed on one book; A8 passed on empty/untimed/old data; cents parser boundaries; false NO sides; exchanges as zero-fee books; CALIBRATED on 3 closes; freshness bands disagreed with EDINTEL | as in §1, §3, §4 |
| Q-L1–L10 | estimated liquidity uncapped; sizing at the quote; −100 max entry; 1/p crash; kickoff guard; model relabel; thresholds and kill switch; walk-forward settle time and pushes; parser trailing period and Unicode minus | fixed (the auditor's stricter A15 sanity ceiling outside moneylines is kept on purpose) |
| S1–S2 | wrong team in "A to beat B"; totals and futures priced as moneylines | §8 |
| S3–S7 | football coverage, injury, one-game best-bet, "2 cents" and football price questions captured by the quant desk | §8 |
| S8 | audit and estimate ids were random (EDINTEL has no fnv1a), keys global | deterministic hash, per-user keys |
| S9 | "New conversation" kept the quant state | reset |
| S10 | a forged carried coverage echoed as fact | live re-read |
| S11 | `known_teams` came from the first card checked | maximum across cards |
| S12 | `authenticated` kept UPDATE/DELETE/TRUNCATE under Supabase defaults | revoked; reported by the migration |
| S13 | write errors (which can quote a row) shown to callers | redacted in the scan response and the probe's quant section |

Not changed here, reported: the probe's older `board`/`stake`/`desk` write
fields predate this change and carry up to 200 characters of PostgREST error
text in the same way.
