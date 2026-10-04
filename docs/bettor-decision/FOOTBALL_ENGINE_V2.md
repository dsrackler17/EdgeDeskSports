# The unified football decision engine (v2) — NFL and CFB

`lib/edgedesk_decision.js` · `edgedesk_football_decision_v2` · config
`football_decision_config_v2` · entry points `EDDecision.decide(input)` and its
alias `EDDecision.footballDecisionEngine(input)`.

> **Consistency pass (config `football_decision_config_v2.1`):** every decision
> now carries its **market state** (LIVE / THIN / STALE / NO MARKET / MARKET
> FAULT) and the **canonical quote** its EV was computed from; the words come
> from `lib/edgedesk_vocab.js`; a MODEL–MARKET DISAGREEMENT WATCH needs a
> realistic BET trigger (else PASS); off-market spread rows are priced as
> alternates, and BEST CURRENT PRICE / BEST PLAYABLE ALTERNATE / SAFER
> ALTERNATE replace the old "best available". See
> [`CONSISTENCY.md`](CONSISTENCY.md).

**If EdgeDesk has enough information to calculate the wager, it makes a
decision about the wager.** That decision is BET, LEAN, WATCH or PASS. NO
DECISION means EdgeDesk genuinely cannot evaluate the wager — never that the
model is still accumulating validation history.

## 1. Why v2

The v1 layer (still described in `DESIGN.md` §§2–17 for history) computed the
fair spread, market spread, gap, cover and push probabilities, the price,
break-even, edge, EV, alternates, confidence and QB state — and then printed
**NO DECISION · "EdgeDesk does not currently have enough verified information
to evaluate this wager"** far more often than it should have. The root causes:

| Cause | Where | v1 behaviour | v2 behaviour |
|---|---|---|---|
| Calibration treated as essential | `decide` step 4 (`CALIBRATION_UNAVAILABLE`) | NO DECISION whenever no validated calibrator existed — **every NFL game** | decides on the raw model probability, labelled **MODEL-ESTIMATED**, stake ≤ 0.25U |
| NFL stub | `app.html` `fbQevGameNfl` | `D = {status:'NO_DECISION', short:'no NFL decision engine'}` on every NFL quote panel | the quote panel prints the engine's own decision |
| Optional facts as blockers | `RELIABILITY_UNMEASURED`, `INSUFFICIENT_MODEL_DATA` (football confidence < 35), `NO_TWO_SIDED_MARKET`, `MARKET_FAULT`, `UNVERIFIED_LARGE_GAP` | NO DECISION | lower decision confidence and a class cap (LEAN / WATCH) |
| Per-book mirror check on best-price-per-number rows | `mirrorFault` | a book that moved (−3 at 10:00, +3.5 at 10:40) read as "the home/away orientation or spread sign failed its check" for the whole game | the older number is superseded; a mislabelled sign is repaired from the other books; only a genuinely unresolvable book is dropped |
| A sign heuristic killed team-labelled quotes | `fbQevCtx` (`spread_fault` → `orientation.ok=false`), build `quoteEvOf` (circuit breaker `SIGN_ORIENTATION`) | every quote EV unavailable → ORIENTATION_FAULT | quotes are priced (their side comes from the team name); the sign doubt is a **price anomaly** to verify (`SIGN_SUSPECT` flag, WATCH · PRICE ANOMALY) |
| The gap guard called a suspicion corruption | research `DATA_FAULT` (rule `guard` / `orientation`), NFL `FB_GUARD` | NO DECISION | WATCH · PRICE ANOMALY (only an integrity DATA FAULT still blocks). A published-board (canonical) label keeps the build's fault kind (`decision_facts.integrity.data_fault_kind`, read by `EDDecisionInputs.labelFaultKind`), so the page and the build agree, and the quote-EV board withholds EV on exactly the FAULT kind |
| NFL kickoff parsed in the viewer's time zone | `app.html` NFL loader | a UTC browser closed 8:15 PM ET games four hours early (GAME_STARTED) | `fbNflKickMs` parses nflverse `gameday`/`gametime` as US Eastern |

## 2. Two layers

### Layer A — can we evaluate? (`evaluation_status`)

`EVALUABLE` needs: a valid game identity, a resolvable home/away orientation,
a model projection with an outcome distribution and a version, a current
sportsbook quote inside the freshness limit with a sane price, and sane
probabilities. Anything else is `NOT_EVALUABLE` → **NO DECISION**, always with
`blocker_codes`:

`INVALID_GAME · MAPPING_FAILED · DUPLICATE_GAME · GAME_CANCELLED ·
GAME_POSTPONED · GAME_SUSPENDED · GAME_STARTED · UNSUPPORTED_MARKET ·
DATA_FAULT (integrity only) · MODEL_UNAVAILABLE · DISTRIBUTION_MISSING ·
MODEL_VERSION_UNKNOWN · MALFORMED_PROJECTION · SELF_CHECK_FAILED ·
IMPOSSIBLE_PROBABILITY · QB_PROJECTION_INVALID · NO_MARKET · MARKET_SUSPENDED ·
STALE_QUOTE · FRESHNESS_UNKNOWN · CORRUPTED_ODDS · NO_VALID_QUOTE ·
ORIENTATION_FAULT`

`tools/bettor/football_decision.test.js` pins that this is the complete set.

### Layer B — should we bet? (`bet_decision`)

Every quote on both sides — main and alternate, every book — is priced by
`EDQuoteEV.priceQuote` and classified at its own line and price on the
**decision probability** (§3). The recommendation is the best RISK-ADJUSTED
quote (decision EV per unit of return volatility) among the highest class,
provided its price verifies (§6); then the class is capped by uncertainty (§5).

| Class | Price rule (configurable, `thresholds`) | Stake |
|---|---|---|
| **BET** | edge ≥ **+4.0 pp** and EV ≥ **+5%** | 0.25–1.00U (§7) |
| **LEAN** | edge ≥ +2.0 pp, EV > 0, the model and the price point the same way: the decision model's fair line (blended / calibrated when it has one) sits on this side of the market. A plus-money alternate on the model's side agrees even though its cover is under 50%; a far alternate on the other side does not. A moneyline agrees when its edge is positive (the break-even carries the vig) | 0 |
| **WATCH** | a potential edge that is not yet a bet: the BET trigger is within the league's watch window (CFB 1 pt / 15¢, NFL 0.5 pt / 10¢), or a meaningful model–market disagreement (CFB ≥ 2, NFL ≥ 1 pt; spreads only) whose BET trigger is realistic (a line move ≤ 3 pts CFB / 2 pts NFL, or a price move ≤ 50¢), or a BET/LEAN-quality price held by unresolved QB / availability information or an unverified price anomaly. Totals and moneylines use the same trigger window: a small edge far from it is PASS | 0 |
| **PASS** | evaluable, not worth a wager: `CALIBRATED_EV_NEGATIVE`, `MARKET_ALIGNED`, `JUICE_CONSUMES_EDGE`, `NO_MODEL_EDGE`, `EDGE_TOO_SMALL`, `PRICE_MOVED`, `PROJECTION_CHANGED` | 0 |

Edge = decision cover probability (pushes excluded) − break-even; its sign
always equals EV's. Every non-BET names its **BET trigger**: the line at the
same price, or the price at the same line, at which this side clears the BET
thresholds (`WATCH — Chicago Bears becomes BET at -2.5 (-110) or -3 (-106) or
better`). Only a realistic option is named (`trigger.realistic_points`,
`trigger.realistic_cents`); with none, the trigger reads NO REALISTIC BET
TRIGGER AT CURRENT MODEL STATE and the options stay in the audit. When the price already clears and a cap holds the class back (a thin
market, low reliability, QB information), the trigger says so
(`already_clears`) and names no price to wait for.

Research status (MARKET ALIGNED, WORTH RESEARCHING, VERIFIED MAJOR,
INVESTIGATE…) is carried apart as `research_status` and never decides:
MARKET ALIGNED with a positive price can be a BET; WORTH RESEARCHING with no
priced edge is a PASS.

## 3. Probability source (always printed)

| Source | When | Label | Max stake |
|---|---|---|---|
| `calibrated` | a calibrator whose maturity is VALIDATED / PRODUCTION / LIVE | CALIBRATED | 1.00U |
| `partially_calibrated` | CFB: the out-of-sample (SHADOW) calibrator, anchored at the fresh main line. NFL: the held-out-validated **pricing blend** (`football/validation/pricing_nfl.json`, tier LEAN): fair margin = −0.381 + 1.157×market + 0.232×(model − market), re-centring the league's own learned margin distribution (parity with `supabase/functions/edgedesk_ai/_pricing.js` is tested) | PARTIALLY CALIBRATED | 0.50U |
| `model_estimated` | no usable calibration | MODEL-ESTIMATED (UNVALIDATED CALIBRATION) | 0.25U |

Raw EV and calibrated EV are always both reported; the decision uses the
calibrated one when it exists. A raw EV never sizes a stake.

## 4. One orientation canon

Every spread quote carries its own side and line; its home-stated line is
`line` (home) or `−line` (away). The canonical block on every decision:

```
canonical: { away_team, home_team, fair_home_spread, decision_fair_home_spread,
  market_home_spread, gap_toward_home_pts (= market − fair; > 0 = value on home),
  gap_toward_side, gap_toward_team, selected_side, selected_team, selected_spread,
  selected_home_spread, opposite: {side, team, spread}, orientation, invariant_ok }
```

Chicago fair −2.4, Chicago +1 → `fair_home_spread −2.4`, `market_home_spread
+1`, gap +3.4 toward Chicago; CHI +1 ⇔ PHI −1; JAX +2.5 ⇔ CIN −2.5 — all
tested. `normalizeQuotes` reads a side from a team name, a home-stated line
into the side's own, supersedes a moved book's older number, repairs a
mislabelled sign from the other books' consensus, and drops only a book whose
two sides contradict at one moment with nothing to resolve them. The model
never decides an orientation. Only when no quote survives is it
ORIENTATION_FAULT.

## 5. Missing optional data lowers confidence and caps the class

| Fact | Effect |
|---|---|
| calibration immature / missing | source label, stake cap (§3), confidence |
| reliability unmeasured | warning `RELIABILITY_UNMEASURED`, confidence |
| reliability < 60 · football confidence < 35 · decision confidence < 40 · unstable projection · one-sided market · governed policy without betting | class capped at **LEAN** |
| QB unknown / unresolved · availability pending | class capped at **WATCH** (a projection built on a QB who is OUT is `QB_PROJECTION_INVALID`, a blocker) |
| personnel / availability not loaded | warning `PERSONNEL_LOW_CONFIDENCE`, confidence |
| unverified price anomaly | class capped at **WATCH · PRICE ANOMALY** |
| alternate beyond the validated tail, or with no main line on file for its side to measure from (tail `UNKNOWN`) | that quote capped at LEAN; the build refuses to publish a BET on either |
| totals / moneylines (no validated skill) | market capped at LEAN; each market decides alone (`markets.total`, `markets.moneyline`) |

`decision_confidence` (0–100, High ≥ 80 · Moderate ≥ 60 · Low ≥ 40 · Very
low) weights model confidence .14, reliability .14, stability .08, quote
freshness .08, market quality .12, QB certainty .12, availability .08,
calibration maturity .12, price consistency .06, anomaly checks .06. It is not
a win probability.

## 6. Extreme numbers get more scrutiny

A review triggers on raw EV ≥ 20%, decision EV ≥ 15%, edge ≥ 12 pp, a
model–market gap ≥ the league's major gap (CFB 7, NFL 4), sanity flags, a
favourite flip, a large rating divergence, movement ≥ 3 pts, inconsistent
quotes, book dispersion > 1.5 pts, the EV circuit breaker, a sign suspicion,
the gap guard, a market fault or an unverified gap. The checks (PASS / FAIL /
UNKNOWN): same game, orientation, spread sign, fresh quote, consensus
agreement, ladder consistency (monotone cover, no book pricing more points at
a better price), neighbouring alternate prices, book corroboration, book
agreement, no arbitrage, market integrity, gap verified, gap plausible (UNKNOWN
beyond the league outlier band), circuit breaker verified. Any FAIL → the next
candidate is tried; if none verifies → **WATCH · PRICE ANOMALY**. A quote that
failed is marked `price_unverified`: the board reads it WATCH, and it is never
offered as BEST PRICE, SAFER VALUE or MAIN. UNKNOWN never blocks; it lowers
confidence. A cleared review proceeds, capped at 0.50U
(0.25U when severe) — never boosted.

## 7. Units

| Tier | Units | Needs |
|---|---|---|
| BET SMALL | 0.25 | edge ≥ 4 pp, EV ≥ 5%, decision confidence ≥ 40 |
| BET | 0.50 | … and decision confidence ≥ 60 |
| BET STRONG | 0.75 | edge ≥ 7 pp, EV ≥ 10%, confidence ≥ 70, disagreement toward the side ≥ league strong gap (CFB 3, NFL 1.5) |
| BET MAX | 1.00 | … confidence ≥ 85, a CALIBRATED probability, a VERIFIED market, no open uncertainty |

Then the minimum of every cap: the probability source (§3), an ACCEPTABLE
(one-book) market 0.50U, a cleared anomaly 0.50U, a severe extreme 0.25U,
material warnings 0.25U, and a quarter-Kelly ceiling at the quoted price;
always rounded down onto 0.25 / 0.50 / 0.75 / 1.00, never above 1.00U, never
from a past result.

## 8. The exact action and the audit record

Every decision carries `action` (headline, `selection` "Chicago Bears -3 (-102)
· DraftKings", units, model cover, break-even, edge, raw and calibrated EV,
probability source, decision confidence, trigger), `whyText` ("Model makes
Chicago Bears -11.9; Chicago Bears -3 (-102) sits 8.9 pts inside the model
number…"), `best_value` / `safer_value` / `best_price`, every evaluated
`candidates[]` quote with its own class, `reasons` (POSITIVE_EV,
EDGE_THRESHOLD_PASSED, QUOTE_FRESH, MODEL_MARKET_DISAGREEMENT, …),
`warning_codes`, `caps`, `blocker_codes`, and `EDDecision.auditRecord(d)`
returns the compact record:

```
{ decision, tier, units, selectedQuote, probability, breakEven, edgePP, rawEV,
  calibratedEV, decisionConfidence, probabilitySource, evaluationStatus,
  reasonCode, reasons, warnings, blockers, caps, researchStatus }
```

## 9. Storage and compatibility

`supabase/bettor_decisions.sql` accepts `BET / LEAN / WATCH / WAIT / PASS /
NO_DECISION` (WAIT kept for v1 rows) and still allows units only on a BET.
The v1 WAIT reads as WATCH everywhere (track, card, chips). Snapshots carry the
v2 fields (`evaluation_status`, `blocker_codes`, `tier`, `probability_source`,
`edge_pp`, `decision_ev_pct`, `decision_confidence`, `reasons`,
`warning_codes`). Grading (`decisions.js` grades, `user_bets`, per-tier
performance) is unchanged.

## 10. Honest limits

- Every threshold is a conservative default, **not validated on live
  results**; the per-tier record is how it will be.
- The CFB calibrator currently reads every captured main-line price at about
  minus the vig, so the honest CFB output is mostly PASS.
- The NFL blend is tier LEAN: its held-out Brier (0.2502) does not beat the
  base rate; it is used as a market-anchored centre, which is why the NFL
  stake cap is 0.50U and most NFL games read PASS or LEAN.
- Totals and moneylines are decided but capped at LEAN until their
  probabilities show validated skill.
- NFL captured book prices live in Supabase and are joined at read time; the
  repository tests the NFL path on the committed slate's real model and real
  consensus line at −110.
