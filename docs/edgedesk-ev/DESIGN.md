# EdgeDesk EV Intelligence Engine — design

EV is arithmetic on a calibrated probability and an exact, executable price:

```
EV = Σ over settlement states [ P(state) × net payoff(state) ]
```

This document gives the method, and says where each rule lives in the code. Its
sections use the numbers of the implementation prompt, so a comment that says
"DESIGN.md §65" points here. For the results, see [`DELIVERABLE.md`](DELIVERABLE.md). The rules that
were fixed before the first tournament run are in [`PREREG.md`](PREREG.md).

| Layer | File | Role |
|---|---|---|
| Engine | `lib/edgedesk_ev.js` (`window.EDEV`, ES5; Node `require`) | odds, settlement, probabilities at a line, calibration, EV, robust EV, decisions, snapshots, grading, validation, AI facts |
| Odds math (existing, reused) | `football/cfb_decision/decision.js` | `americanToPayout`, `payoutToAmerican`, `applyMap` |
| Curve lookup (existing, reused) | `lib/edgedesk_read.js` | `buildCurve`, `sideProb`, quote freshness, book keys |
| Calibration data | `football/cfb_ev/dataset.js` | 27,870 rows through the production curve path |
| Calibrators | `football/cfb_ev/calibrators.js` | identity, temperature, Platt, beta, isotonic, Venn-Abers, rolling Platt; metrics |
| Tournament | `football/cfb_ev/tournament.js` | walk-forward, promotion, audits, one-time holdout → `artifacts/cfb_ev_calibration_v1/` |
| Market studies | `football/cfb_ev/market_study.js` | de-vig benchmark, favourite-longshot, historical replay |
| Staking | `football/cfb_ev/staking_sim.js` | Kelly stress test (staking stays disabled) |
| Freeze | `football/cfb_ev/freeze.js` | prospective next-100 freeze, PATCH log |
| Demo | `football/cfb_ev/demo.js` | the §77 demonstrations → `reports/demo_v1.json` |
| Policy | `football/cfb_ev/policy/cfb_ev_policy_v1.json` | the pre-registered decision thresholds |
| Pins | `football/cfb_ev/current.json` | the calibrator, policy and engine the terminal reads |
| Integration | `football/cfb_terminal/build.js`, `research/cfb/terminal.js`, `supabase/functions/edgedesk_ai/_cfb_explain.js` | ledger, page, EV lab, AI facts |
| Tests | `football/cfb_ev/ev.test.js` | 232 checks: formulas, fixtures, fail-closed, properties, governance, the real slate |

## §1 Audit

See `DELIVERABLE.md` items 1–2 for the coverage map. One rule came out of the audit: **the
engine never computes a football number.** It reads the champion's frozen
probability curve (`read_inputs.curve`, stored by `football/cfb_terminal/build.js`
at 1e-6 precision), through the same `EDRead.sideProb` the game page uses. The
engine and the page therefore cannot disagree about a cover probability. A test
recomputes all 20 slate pages byte for byte.

## §2 EV definition · §3 the canonical snapshot

`EDEV.snapshot(read)` builds the `game_ev_snapshot` (schema `edgedesk_ev_snapshot_v1`).
The P0 identifiers are `game_id, selection_id, market_type, line_value, american_odds,
decimal_odds, book_id, quote_ts, prediction_ts, model_version, calibrator_version,
settlement_rules, decision_policy_version, quote_id`. If one is missing, `production_grade` is false and the missing
fields are listed. A pending calibration is never production-grade either. The snapshot also
carries the P1 fields: raw, calibrated and robust EV, Pr(EV>0), break-even on both bases, the de-vig benchmark and
its method, consensus line, book count, research status, integrity, extreme
level, decision, policy decision, timing, blockers, bettable-to, target, edge
kind, edge decay, labels and alternate rows. The id is
`edev_` + a hash of the identifying fields, and the object is deep-frozen.
`build.js` appends each new snapshot to `football/cfb_terminal/ev/<season>/ev_snapshots.jsonl`
and never rewrites one.

## §4 Odds normalization

`americanToDecimal`, `decimalToAmerican` (exact) and `decimalToAmericanRounded`
(display only), plus `fractionalToDecimal`, `hongKongToDecimal`, `malayToDecimal`,
`indonesianToDecimal`, `impliedProbability`, `normalizeOdds` and `parseOdds`. Internally a price is
its gross decimal and its net payout b = decimal − 1, kept at the source's full
precision (`sourcePrice` keeps a book's decimal rather than routing it through a rounded
American price). American prices between −100 and +100 are invalid.

## §5 Settlement engine · §79 global extensibility

A market is a list of `{state, p, payoff}`, and `expectedValue(states)` sums them.
It fails closed (returns null) when a probability is outside [0, 1] or the probabilities do not sum to 1 (±1e-6). The states are FULL_WIN,
HALF_WIN, PUSH, VOID, HALF_LOSS and FULL_LOSS.

- `twoWayStates(pWin, pPush, decimal)`: half-point spreads (no push) and integer spreads (push = stake back).
- The moneyline declares P(void) = 0, because a college football tie cannot happen.
- `asianQuarterStates(line, pmf, decimal)` / `asianQuarterEv` split the stake across the two neighbouring lines.
- `exchangeBackStates(p, decimal, commission)`; `exchangeLayStates` is per unit of liability.

`MARKETS` is the registry (M01–M14), and each market has a status:
ACTIVE (spread, alternate spread), RESEARCH (moneyline), NOT_ACTIVATED (totals,
team totals: no total curve is published), CONTRACT_ONLY (1X2, Asian half/whole/quarter,
exchange back/lay: the settlement is implemented and tested, but no distribution or feed exists) or
BLOCKED (pari-mutuel, live, SGP, futures, promos). `marketSupport(type)`
returns `decides: false` for every status other than ACTIVE.

## §6 Probabilities from the production distribution

`probabilityAt(curve, side, line)` → `{win, push, loss, cover}`, where cover is
P(side covers | no push). Alternate lines are read from **the same frozen curve**.
Nothing is refitted per line.

**Market-line anchor.** The calibrator maps the raw P(home covers | no push). It
is evaluated **only at the fresh consensus market line**, because that is where
it was trained. To carry the calibrated distribution to other lines, the engine
reweights the frozen curve in place (`solveRecentre`). It reads P(M = k) off the
curve's push mass at every whole margin and tilts it by exp(θ·k). θ is solved so
the cover probability at the market line equals the calibrated one, and the move
is reported as the shift δ of the mean. It then reads every other line off the
reweighted curve (`recentredHome`). Every margin keeps its own mass: the spikes
stay on 3 and 7, a tie keeps none, and the curve stays monotone. This is the tilt
the champion itself uses to re-centre its row (`cfbRecentre`). This is `anchorOf`
/ `calibratedAt`. It is a post-registration change, disclosed in PREREG
(changes 1 and 4). Until 2026-10-05 the anchor moved the curve's location instead,
a mixture of the two neighbouring integer shifts, which carried the spikes off
their margins. Without the anchor, a temperature map applied line by line
would squash every alternate toward 50%.

`curveSane(curve)` checks monotonicity, bounds and the push range. An incoherent
curve is `DISTRIBUTION_FAULT` → NO DECISION.

## §7 Calibration tournament · §8 market-specific calibration

The dataset (`dataset.js`) builds each row through the production path:
`build.js v1Dist → EDRead.buildCurve → sideProb`. Each row carries the raw
P(home covers | no push) at the close, at the open, and at close ±3/±7 (the
alternate-line audit), plus the champion's win probability. There are 27,870 rows across
IN_SAMPLE 2015–2021 (diagnostic only), OOS 2022–2025 and HOLDOUT 2026. Archive games with swapped
ids and faulty openers are dropped.

There are three separate tasks: `cfb|spread|close`, `cfb|spread|open` and `cfb|moneyline|close`.
The candidates are identity, temperature, Platt, beta, rolling Platt, isotonic
(PAV) and Venn-Abers, in `calibrators.js` `ORDER`, simplest first. Each is fitted
walk-forward (2022 → evaluated on 2023, 2022–23 → 2024, 2022–24 → 2025), so no season is ever scored by a map fitted
on it. The metrics are Brier, log loss, calibration slope and CITL with Wald CIs, ECE (with the binning
caveat), a Wilson reliability curve, the Murphy decomposition and AUC. A 2,000-draw
week-clustered bootstrap compares each candidate to identity.

**Promotion (PREREG §5).** A candidate is eligible when its log loss and Brier are below identity's, the 95% CI
of Δ log loss is below 0, and every season is no worse. The simplest eligible
candidate within one bootstrap SD of the best wins. The final map is refitted on
2022–2025. The 2026 holdout is read **once** (`holdout_access.jsonl`; a second read is
refused) and can confirm or revoke the promotion. `tournament.js --check` rebuilds the artifact and
fails CI if it differs from the committed `calibration.json`.

`checkpoint_map` routes quotes by checkpoint: OPEN and EARLY_WEEK (>72 h out) use the opener calibrator, and every later
checkpoint uses the close calibrator. A typed, hypothetical or consensus quote uses the
calibrator for the current time.

## §9 Break-even · §10 exact EV · §11 raw vs calibrated · §13 probability edge

`breakEven(decimal, pPush)` returns both bases:
`conditional_nonpush = 1/decimal` (the cover probability needed), and
`unconditional = (1 − pPush)/decimal` (the win probability needed). For each option,
`evaluateOption` stores the raw and calibrated win/push/loss/cover probabilities,
`raw_model_ev`, `calibrated_ev`, `ev_roi_pct` and `ev_dollars_per_100`. The
probability edge is `cover − 1/decimal` on the conditional basis, which is the basis of
`cfb_decision_policy_v1.min_probability_edge`. The unconditional pair is also stored. Raw EV
is always shown, labelled EXPERIMENTAL. Only calibrated EV can clear the policy.

## §12 Robust EV · Pr(EV>0)

`sampleStates` draws 500 samples from a seeded mulberry32 generator. The seed is a hash of the game, model
version and calibrator version, so a read is reproducible, and every line of a game uses the same draws, which makes
the juice panel's comparisons paired. Each sample combines two layers:

1. **Calibration uncertainty.** 200 week-clustered bootstrap Platt refits
   (`calibration.json …uncertainty.platt_draws`). Each draw's deviation from the centre
   Platt map is added to the promoted map's value at the anchor, and the anchor is re-solved.
2. **Model location uncertainty.** τ = sqrt(max(0, sd² − sd_ref²)) × the map's
   local logit slope at the anchor. sd is this game's between-model SD. sd_ref = 2.15 pts is the
   median OOS disagreement, which the calibrator has already absorbed. The slope factor
   prevents double counting: a map that ignores the raw probability also
   ignores the location noise.

The summary gives the median, the **10th-percentile (conservative) EV**, the 5–95% interval, and
Pr(EV>0) as the share of samples with EV > 0. The quantile, interval and sample count
were declared in PREREG §7 before any EV was seen. `kellyFraction` and `robustKelly`
exist for the staking study only.

## §14 De-vig benchmark · §15 market bias diagnostics · §71–72 studies

`devig(decimals, method)` implements proportional, power, additive (guarded: it fails if any
probability leaves (0, 1)) and Shin. Overround outside −2%…+50% is refused. Each option's
`market_benchmark` is the de-vigged probability of the same book's two sides. It is labelled
BENCHMARK and **never enters EdgeDesk's probability**. `market_study.js`
measured the methods on 134,644 archive rows (`reports/market_study_v1.json`).
Proportional stays the display method: the best alternative (additive) was not
better at 95% on the moneyline, and proportional won on spreads. The favourite-longshot
buckets, favourite/underdog split and book-level ROI are in the same report and the EV lab.

## §16 price curve · §17 price of protection · §18 best value ≠ safest

`price_curve` lists each offered quote at its own price, plus a reference ladder of
hypothetical lines at −110 (labelled REFERENCE, never a quote). It has a `coherent`
flag (cover must be monotone in the line) and sort options BEST_EV (the default),
BEST_MAIN, BEST_ALT and SAFEST. Labels: BEST EV, BEST MAIN, BEST ALT, SAFEST, and SAFEST is never the
default. `juice(ctx, a, b)` compares two lines. It reports the extra points, the extra calibrated cover
and win probability, the extra required break-even, the EV change and the juice cents, plus a paired Pr(ΔEV>0) from the
same samples. The verdict is BETTER VALUE, WORSE VALUE (both need paired Pr ≥ 0.80),
TOO CLOSE, or NO DECISION.

## §19 Key numbers

The engine adds no manual key-number bonus. The audit (tournament `audits.key_numbers`, `anchored`)
found that the champion's curve under-states |margin| = 3 and 7. Anchored, 3 carries 4.6% of the mass
against 10.5% empirical. The cause is the V1 engine's integer re-centring of its PMF. So the engine flags
`key_number_unvalidated` when an option crosses 3 or 7 relative to the market
line. Such an option is never actionable (`KEY_NUMBER_MASS_UNVALIDATED`), and the juice
panel prints the empirical share beside the model mass.

## §20 Freshness · §21 fresh-quote recheck

`ttlFor` sets the TTL by market: spread 180 min, alternate 90, moneyline 180,
user quote 30. Within 6 h of kickoff the TTL is 60, and an extreme EV also gets 60. A stale quote is never
actionable. `recheck` compares the chosen quote with the latest one from the same
book: CONFIRMED, STALE, REQUOTED (re-evaluated; if the new price fails, the read is PASS), UNAVAILABLE
or USER_QUOTE.

## §22 Consensus vs book-specific · §23 best price · §24 user books · §25 manual quotes

`edge_kind` evaluates the side at the consensus line and price and at the chosen
book. The result is MODEL_EDGE (both clear), BOOK_SPECIFIC_PRICE_EDGE (only the
off-market book clears), BOTH, or NONE. The best price is chosen by robust EV (then calibrated EV; raw-only options rank
last) among fresh quotes at the reader's books (`optionsFrom`; the page's existing My books view), not by line or
price alone. The broader market is still shown as context. `manual(input, text)` parses
`"Minnesota +7.5 -105"`, marks it USER QUOTE, and refuses a line without a price. A USER QUOTE is
evaluated but never certified.

## §26 Bettable-to · §27 target price · §28 price gone · §29 edge decay

`priceTargets` reports the worst line that still clears at the current price, the worst
price that still clears at the current line (both found by bisection), the EV-zero price, and a target
text (`CURRENT … → TARGET … OR …`). `PRICE_GONE` applies when an earlier eligible snapshot for the
same selection cleared and the current quote does not. The earlier read is evaluated with
its own anchor and checkpoint calibrator. `edgeDecay` returns GREW, RETAINED,
PARTIAL, MOSTLY_GONE, VANISHED or REVERSED. `decay_pct` is null on a sign flip.

## §30 BET EARLY vs WAIT · §31 timing validation

When the policy clears, BET_EARLY needs a **measured** reason the number may not last:
either the market has moved toward EdgeDesk (the Read's movement summary), or losing half a point would cross a key
number. Otherwise the decision is BET. WAIT needs a target that can actually be reached. The model–market gap must be at least 2 pts,
the target line must be within ordinary open-to-close movement (1.9 pts), and the price must **still clear
after re-anchoring the calibrator at the target line**. A move the model has no view on
carries the calibrated probability with it. A WAIT on price alone needs the
target price to be no better than −110. Anything else is PASS, with a "SHOPPING TARGET"
line. There is no "wait for sharps" wording. `grade()` measures BET_EARLY deterioration,
WAIT target reached, best later price and close-vs-wait.

## §32–35 Research status, verified major, circuit breaker, favourite flip

`decide()` fails closed in this order: model artifact missing → distribution
fault → sign orientation → DATA FAULT → any research status that blocks action
(INVESTIGATE, MARKET FAULT, …) → market check → no price → stale → no
accessible price → calibration unavailable. Then, if the price clears: LIMITED DATA /
low reliability → extreme EV not verified → QB unresolved (WAIT, information
pending) → price unavailable or requoted → price limit (−125) → key number
unvalidated → USER QUOTE → BET EARLY / BET, **capped to RESEARCH ONLY while the
EV policy is in SHADOW or betting is disabled** (`policy_decision` keeps the uncapped result). If
the price does not clear: RAW_EV_NOT_CALIBRATED, VERIFIED_MAJOR_IS_NOT_A_BET,
PRICE GONE, WAIT, or PASS.

`circuitBreaker` sets its thresholds from the OOS extremes (p95/p99 of |raw cover − 0.5|
and of the model–market gap). It runs these checks: quote verification, sign orientation
(gap > 21 while |fair − market| ≤ 7 after a flip), favourite flip, distribution sanity,
component disagreement, and the calibration domain at the anchor. An extreme EV that has not been verified
is RESEARCH ONLY. `favorite_flip` shows the flip and never turns it into a bet.

## §36 Market maturity · §53 promotion ladder · §64 version boundaries

`maturityOf` gives each submodule its stage: RESEARCH → CHALLENGER → SHADOW → PRODUCTION.
The spread calibrator is SHADOW (PROMOTED, but not yet prospectively validated). The
moneyline is PENDING/RESEARCH. The policy is SHADOW, and staking is disabled. Validation
groups follow version boundaries: CURRENT EV VERSION, LEGACY, CURRENT SEASON and LAST N.

## §37–41 Scoring, EV calibration, CLV · §73–76

`validation()` groups graded snapshots. For each group it reports Brier and log loss (raw and calibrated), the calibration
slope, CLV (line and same-line price), EV buckets with realized ROI and Wilson/normal intervals,
a monotonicity check, a shadow-policy drawdown and timing grades. Rates are shown
only at n ≥ 30. `grade()` records CLV as process and the result as outcome,
separately (the four quadrants). CLV is not ground truth, EV is not CLV, EV is
not confidence, and EV is not the point gap. The card shows each of these separately and
never merges them.

## §42 Execution · §43 limits

Limits are UNKNOWN: no book limit feed exists. The card says so, and the execution text says the
EV is for the quoted price only. Execution-adjusted EV is the EV at a re-checked quote. It is
never extrapolated to a size.

## §44–49 Global markets

See §5. Every non-ACTIVE market is registered with a reason, and `marketSupport`
blocks decisions on it. Each contract (Asian quarter, exchange back/lay) has a
tested settlement function, so a future distribution can plug in without
changing any EV arithmetic.

## §50–52 Staking, Kelly, portfolio

Staking is disabled (`policy.staking.enabled = false`), and no Kelly stake is shown.
`staking_sim.js` shows why: 4 scenarios × 4,000 seasons × 12 weeks × 8
correlated positions (a one-factor copula with ρ). When the stated edge is overstated, full Kelly loses
half the bankroll in 1.8–25% of seasons. Robust quarter Kelly (at the 10th-percentile probability) and flat
staking degrade gracefully. Correlated same-slate exposure is modelled, not
assumed away.

## §54–59 UI

`research/cfb/terminal.js` renders the EV card below the Read card (`evCard`). It shows the
exact quote and its age, the book, the settlement structure, raw and calibrated cover and push, break-even on both bases,
the probability edge, calibrated / raw (EXPERIMENTAL) / robust EV, the 5–95% interval, Pr(EV>0),
the de-vig benchmark labelled BENCHMARK, the decision with its policy decision and blockers,
bettable-to, the target, edge kind and edge decay. The exact tooltip is `EDEV.TOOLTIP`.
The price curve table has the columns LINE | ODDS | COVER | PUSH | BREAK-EVEN | MODEL
EDGE | EV | ROBUST EV | READ, with sorts BEST EV (default), BEST MAIN, BEST ALT and SAFEST.
The chosen sort is remembered per viewer. The juice panel compares any two lines. The what-if
calculator re-prices a typed quote from the stored curve, without re-running the model, and
shows both "one book at this price" and "the whole market moves here". `auditText`
bans LOCK, HAMMER, free money, max bet, guarantee, sharp/smart money, steam
and "wait for sharps". The build refuses to write any wording that fails the audit.

## §60–61 AI

`_cfb_explain.js evFacts` passes the structured EV object to the model, with
quote id, timestamp and source, basis, probabilities, EVs, versions, blockers,
and validation or `UNKNOWN`. The prompt tells the model to cite those facts only.
The output audit rejects a number that is not in the facts, a validated claim
(`EV_VALIDATED_CLAIM`) and a basis mismatch (`EV_BASIS_MISMATCH`).
`EDEV.ask` answers the deterministic EV intents on the page (juice, bet-or-wait,
worst price, missed number, why-not-bet, why-positive) with provenance.

## §62 Record · §63 live validation · §65 next-100 · §66 triggers

`record.json.ev_record`, `ev_validation.json`, `ev.csv` and the EV lab route
(`#/ev`) show the ledger, the validation groups and next-100 progress. `freeze.js --init`
freezes the engine, calibrator and policy by name and SHA-256. After that, any
change needs a version bump or a PATCH row in `versions.jsonl`, and the test suite
checks for drift. `researchTriggers` raises a research candidate, never a production change, in four cases: high stated EV
underperforms moderate EV in both ROI and CLV, EV-vs-CLV is non-monotone, the live calibration slope leaves
0.6–1.6, or BET EARLY reads see the line improve more often than deteriorate. Each needs n ≥ 30.

## §67 Fail-closed rules

Each of these returns NO DECISION and never a guess: a missing model artifact or curve, an incoherent
curve, a sign fault, a data fault, a blocking research status, a market check, no
price, a stale quote, no accessible price, an unavailable or unanchored calibration, an unsupported
market, or probabilities that do not sum to 1.

## §68–69 Tests

`node football/cfb_ev/ev.test.js`, also run in `npm test` and CI
`.github/workflows/cfb-terminal.yml`. The suite covers every applicable formula in
`ev_formula_library.csv` (F01–F30) and the worked examples W01–W07, plus the listed fixtures,
fail-closed paths, snapshot/grade/validation/ask, and 60 randomized property cases (states sum to 1 and
stay in [0, 1]; P(win) is monotone as the line improves, with a 2.5e-6 tolerance because the stored curve is
at 1e-6 precision; decimal > 1; break-even in [0, 1]; a read recomputes identically; the price curve is
coherent; a better price at the same line never lowers EV). It also covers tournament
governance (the holdout is read once, `--check` reproduces), the real slate (byte-for-byte
page recomputation, Read parity), the page boundaries and freeze drift.

## §70 Historical replay

`market_study.js` replays each quote that existed at its time, at its own book and
price. It never uses the best price in hindsight. Spread prices exist only for 2015–2019, which is in sample
for the champion. That replay shows the mechanics and the overstatement of raw EV, never an edge.
Moneylines are replayed for 2023–2025. Spreads for 2022–2025 are **not replayed**: the archive has no
spread prices, and −110 is never assumed.

## §78 Source traceability

The research pack's `source_manifest.csv` is used as conceptual background only.
No paper coefficient is used in production. Every threshold is either inherited from a
governed EdgeDesk policy (with its provenance in the policy file) or declared in
PREREG before the data was seen.
