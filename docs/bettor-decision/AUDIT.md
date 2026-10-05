# Bettor decision layer — the audit before building

What existed on 2026-09-28, before `lib/edgedesk_decision.js`. Every line
below is a file the decision layer now reads or deliberately leaves alone.
The short version: EdgeDesk already had every number a bettor needs, spread
across **four separate verdicts** that a reader had to reconcile alone.

## 1. The four verdicts a reader faced

| Verdict | Where | Vocabulary | Status |
|---|---|---|---|
| Terminal status | `lib/cfb_terminal.js` `T.status` | BET, RESEARCH, WAIT, INVESTIGATE, PASS, DATA_FAULT, NO_MARKET | mixes research and decision words |
| Governed decision | `football/cfb_decision/decision.js` via `lib/edgedesk_canon.js` `C.decisionStatus` | BET, WAIT, PASS, NO_DECISION (engine: BET/LEAN/RESEARCH/PASS/NO_BET) | SHADOW, `bet_enabled: false`; calibrated EV flat at −3.17% → empty BET region (docs/cfb-decision/POLICY.md) |
| EV read | `lib/edgedesk_ev.js` `decide()` | NO_DECISION, RESEARCH_ONLY, WAIT, PASS, PRICE_GONE, BET, BET_EARLY | policy `cfb_ev_policy_v1` SHADOW |
| Quote EV decision | `lib/edgedesk_quote_ev.js` `decisionFor()` | the governed verdict on one exact quote, NOT_EVALUATED elsewhere | arithmetic only |

Board rows (`football/cfb_terminal/board.json`) carried `status`,
`research_status`, `decision_status`, `read.decision`, `ev.decision` and
`quote_ev.decision_status` side by side. On the slate built 2026-09-28 17:07Z
they read, for one game, RESEARCH / WORTH RESEARCHING / PASS / RESEARCH_ONLY /
PASS / NOT_EVALUATED.

## 2. Pricing (reused, never duplicated)

| Piece | Canonical home |
|---|---|
| Odds conversion, break-even, `expectedRoi`, `clvPoints` | `lib/research_core.js` |
| Win / push / loss at an exact quote, raw EV, fair odds, sanity flags, alternate ladder, frontier | `lib/edgedesk_quote_ev.js` (`priceQuote`, `evaluateGame`, `ladder`) |
| The stored probability curve (every half point) | `lib/edgedesk_read.js` `sideProb`, `buildCurve`; stored per game in `games.json` `read_inputs.curve` |
| Calibrated probability | `lib/edgedesk_ev.js` `calibrationFor` → `anchorOf` → `recentredSide`; artifact `football/cfb_ev/artifacts/cfb_ev_calibration_v1` (temperature, PROMOTED, maturity SHADOW) |
| CFB distribution | champion PMF conditioned on the market spread (`EDQuoteEV.cfbConditionedCover`) |
| NFL distribution | `football/engine.js` `dist.coverProbSpread('nfl', …)`; **no calibration exists** |
| Existing boundaries | `EDEV.priceTargets` / `worstClearingPrice` (EV policy), `EDRead.bettableTo`, `decision.js priceTargets` |

**Finding that shapes everything:** the promoted CFB calibrator maps every raw
cover near 50% at the market line, so the calibrated EV at a main-line price
is roughly minus the vig. Of 60 priced CFB quotes on the committed slate, **0**
had a positive calibrated EV (best −0.5%, San José State +2.5 +100).

## 3. Research statuses, reliability, integrity

- Research status: `lib/edgedesk_canon.js` `C.researchStatus` (VERIFIED_MAJOR,
  INVESTIGATE, MARKET_FAULT, WORTH_RESEARCHING, NEAR_PICKEM, MARKET_ALIGNED,
  LIMITED_DATA, NO_MARKET, DATA_FAULT); the app's legacy labels (STALE QUOTE,
  THIN DATA) map through `C.LEGACY`.
- The 7+ point integrity gate: `lib/cfb_disagreement.js` (GAME, MARKET,
  TEAM_STATE, QB, ROSTER, COMPONENT, MODEL checks).
- Reliability 0–100 with hard caps: `lib/cfb_reliability.js` (grades
  VERY_STRONG … VERY_LOW; stability tiers VERY_STABLE … VERY_UNSTABLE).
- Confidence: engine 0–100; `C.THRESHOLDS.min_confidence` 35.
- QB: terminal `qb.{home,away}` (`status`, `confirmed`, `contested`), Read
  `qb_status` (`resolved`, `unresolved[]`, `unconfirmed[]`).
- Market quote rules: `football/cfb_lab/integrity.js` (REJECT/QUARANTINE
  codes), `EDRead.consensusOf`.
- Freshness is not one number: 180 min (policy, canon, Read), EV TTLs 180/90/60,
  the app's kickoff ladder 5–360 min (`EDINTEL.quoteState`). The decision layer
  uses the freshness verdict the pricing layer already attached to each quote.
- Cancellation/postponement lives only in the Lab (`market.js`, `settle.js`).

## 4. Bankroll, bets, CLV, storage

- `public.bankroll_settings` (`supabase/bankroll_and_stakes.sql`): bankroll,
  base unit, caps; read by the AI desk staking engine
  (`supabase/functions/edgedesk_ai/_stake.js`), which defaulted to a $25 unit.
- `stake_recommendations` (write-once), `stake_recommendation_responses`,
  `external_positions` (never graded), `research_journal` (write-once snapshot,
  server-graded CLV), the device-local `edgedesk_bets` CLV ledger.
- Supabase access is raw PostgREST (`sbGet`, `sbPost`, `sbUpsert`); local keys
  use the `edgedesk_` prefix so sign-out purges them.
- SQL tests run a real throwaway PostgreSQL (`tools/personal/_pg.js`).
- Collective: independent creators' projections, graded separately; not a
  consumer of decisions.

## 5. Frontend

- `app.html` views are `<section id="v-X" class="view">` toggled by `show(v)`;
  the Research shell hosts Football; the FBS board is a Football segment.
- CFB game panel `fbP4Card`, summary `fbGxSummary` (already had separate
  Research status and Decision cells); FBS board rows `fbP4Row` with the
  quote-EV line `fbP4QevSub`; NFL card `fbGameCardNfl` (decision hard-coded
  NO_DECISION); overview `fbOverviewHTML`.
- The page computes CFB projections and quote EV live in the browser
  (`fbQevGameCfb`, `fbQevGameNfl`), with live captured quotes.
- Second frontend: `research/cfb/terminal.js` (reads board.json/games.json).
- Tooltips were `title=""` attributes; no beginner mode; onboarding existed for
  account preferences only.

## 6. What the decision layer changes and what it leaves alone

Changed: one canonical decision object per game, consumed by the new action
card, the board chip, the summary's Decision cell, the research terminal's
decision chip and the EdgeDesk Card page. Unchanged: every model, every
calibration, every research status, every existing EV surface, the governed
engine (still SHADOW, still logged), and the research below the card.
