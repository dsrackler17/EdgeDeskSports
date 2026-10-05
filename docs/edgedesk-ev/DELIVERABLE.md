# EdgeDesk EV Intelligence Engine — deliverable

This report answers the 50 items the implementation prompt asked for. The method is in
[`DESIGN.md`](DESIGN.md), the pre-registered rules are in [`PREREG.md`](PREREG.md), and the
screenshots are in [`demo/`](demo/).

## The result first

- **The engine works, and it is honest about what it finds.** It prices every
  supported quote from the champion's frozen distribution. It reports raw,
  calibrated and robust EV, Pr(EV>0), break-even with pushes, the de-vig benchmark,
  the price curve, the juice panel, targets, timing, and a fail-closed decision.
  Each read becomes an immutable snapshot, and every snapshot is graded later.
- **The champion's cover probability at the market line has no out-of-sample
  information.** On 2022–2025 walk-forward data at the close, identity scores log loss 0.7334 against
  0.6931 for a coin flip. Its calibration slope is −0.13 (95% CI −0.29 to 0.04) and its AUC is 0.486. The
  tournament therefore promoted a temperature map with T ≈ 10⁶, which maps every raw cover
  probability to 50% at the market line. The opener task is almost the same (T = 40.9). The 2026
  holdout (n = 162) confirms it. **At the consensus price, calibrated EV is
  therefore the vig.** A positive calibrated EV can appear only at a price or line that
  differs from the market (a BOOK-SPECIFIC price edge). It never comes from the model's football
  opinion at the market number.
- **On the current slate (62 games), no read has a positive calibrated EV.** 21 are PASS
  (negative EV). 41 are NO DECISION: 20 stale quotes, 7 market checks, 6 distribution faults,
  5 INVESTIGATE and 3 MARKET FAULT.
- **Raw EV is badly overstated, and the engine labels it EXPERIMENTAL.** In the historical
  replay, spread quotes with raw EV ≥ +10% (n = 35,502, 2015–2019, in sample) stated
  +22.9% and realized −6.7%. Moneylines with raw EV ≥ +10% in 2023–2025 (n = 2,612) stated +36.2%
  and realized −5.7%.
- **The EV policy is in SHADOW, betting is off, and staking is disabled.** A policy BET is
  recorded as such and shown to the reader as RESEARCH ONLY until the prospective
  next-100 evaluation and a person promote it.

---

## 1. Existing-system audit

| Area | What exists | Where |
|---|---|---|
| Pure predictive distribution | The V1 champion's `margin_pmf_by_spread`: an empirical margin PMF conditioned on the closing spread (bandwidth 6, fitted 2006–2021) and re-centred on the model mean by reweighting the row in place (an integer shift until 2026-10-04) | `football/cfb_p4/engine.js` (`coverProbSpread`) |
| Stored probability curve | `read_inputs.curve`: win[] and push[] by home line, step 0.5, 1e-6 precision, built by the production path | `football/cfb_terminal/build.js` → `lib/edgedesk_read.js buildCurve` |
| Fair spread / total / win probability | `model_home_margin`, `fair_total`, `home_win_prob` | `football/fbs/slate.json` (champion `edgedesk_cfb_p4_v1.0.0`) |
| Simulation outputs | None. The champion is analytical (a PMF), not simulated | — |
| Confidence / reliability | The Read's reliability, between-model SD, and model uncertainty | `lib/edgedesk_read.js`, `lib/cfb_terminal.js` |
| Model versions and governance | The champion/challenger registry and `cfb_decision_policy_v1` (betting off) | `football/cfb_lab/governance*`, `football/cfb_decision/` |
| Research statuses, integrity gates | WORTH RESEARCHING, MARKET ALIGNED, INVESTIGATE, MARKET FAULT, DATA FAULT, VERIFIED MAJOR, LIMITED DATA; the market-check gate | `lib/cfb_terminal.js`, `football/cfb_decision/integrity_gates.test.js` |
| Odds ingestion | The Supabase capture (The Odds API: h2h, spreads, totals); the CFBD consensus (lines without prices); the ESPN / DraftKings feed (lines and prices) | `supabase/functions/capture`, `football/cfb_lab/market.js`, `football/cfb_market/` |
| Quote history | Model Lab snapshots with `observed_at` and `quote_id` | `football/cfb_lab/ledger` |
| Selected book / best price | The Read's line shopping (best line, then price) | `lib/edgedesk_read.js` |
| Open / current / close | The opener from the Lab's first snapshot (a line, usually without a price); the current Lab quotes; the close from the Lab consensus | `football/cfb_lab/checkpoint.js`, `settle.js` |
| Alternate spreads | An opt-in, unscheduled capture into its own ledger | `football/cfb_terminal/alternates.js` |
| Record snapshots | The champion history (append-only) and the Read ledger with grades | `football/cfb_terminal/history`, `read/` |
| Decision math | `americanToPayout`, `breakEven`, proportional de-vig, `expectedValue`, `applyMap` (identity / Platt / beta / isotonic / logit PWL); the V2.1 decision probability | `football/cfb_decision/decision.js` |
| AI / game pages | The research terminal and the EdgeDesk AI explain function with a number audit | `research/cfb/`, `supabase/functions/edgedesk_ai/_cfb_explain.js` |
| Exports / Collective | `read.csv` and the record page. The Collective ingests member picks and is not a model consumer | `football/cfb_terminal/`, `collective/` |
| Model Lab validation | Snapshots, settlement, calibration and governance reports | `football/cfb_lab/` |

What the audit found:

- Only one book (DraftKings via ESPN) carries prices on the live slate. The CFBD
  consensus has lines but no prices.
- Openers carry a line and almost never a price.
- Alternate quotes are not captured on a schedule.
- No total or team-total distribution is published.
- The V1 PMF's integer re-centring moves the key-number spikes off 3 and 7 (see §20).

## 2. Field / source coverage report

| Field | Coverage | Source / note |
|---|---|---|
| game_id, teams, kickoff, season, week | AVAILABLE | slate / terminal object |
| selection_id, market_type | DERIVABLE | `game:market:side` |
| line_value, american_odds, book_id, quote_ts, quote_id | AVAILABLE | Lab quotes. Priced only at DraftKings; the CFBD consensus is unpriced and therefore never an EV quote |
| decimal_odds, implied probability | DERIVABLE | `normalizeOdds` at full precision |
| prediction_ts | DERIVABLE (newly threaded) | the slate build time, now carried in `read_inputs.model.prediction_ts` |
| model_version | AVAILABLE | governance |
| calibrator_version, calibration_status | NEW | `football/cfb_ev/artifacts/cfb_ev_calibration_v1` |
| settlement_rules | NEW | `MARKETS` / `twoWayStates` |
| decision_policy_version | NEW | `cfb_ev_policy_v1` |
| raw cover / win / push / loss | DERIVABLE | the stored curve (`probabilityAt`) |
| calibrated cover / win / push / loss | NEW | the market-line anchor (`calibratedAt`) |
| break-even (both bases), raw / calibrated / robust EV, Pr(EV>0), interval | NEW | `evaluateOption`, `sampleStates` |
| market fair probability (de-vig) | DERIVABLE when both sides are priced | `devig`; labelled BENCHMARK |
| consensus line, book count, dispersion | AVAILABLE | the Read's consensus |
| opener line | AVAILABLE | Lab first snapshot |
| opener price | UNSUPPORTED (mostly) | the Lab opener is a line; PRICE GONE uses earlier EV snapshots instead |
| closing line / same-book closing price | AVAILABLE | used by `grade()` |
| alternate quotes | UNSUPPORTED in live data (capture unscheduled) | the price ladder is labelled REFERENCE; users can type an alternate |
| moneyline price | AVAILABLE | DraftKings; EV is RESEARCH (not validated) |
| total / team total distribution | UNSUPPORTED | no curve is published → NOT_ACTIVATED |
| limits / max stake | UNSUPPORTED | shown as UNKNOWN |
| live game state | UNSUPPORTED | live is BLOCKED |
| exchange / pari-mutuel / Asian feeds | UNSUPPORTED | CONTRACT_ONLY / BLOCKED |

## 3. Files, functions and tables changed

New:

- `lib/edgedesk_ev.js`: the engine (`window.EDEV`). The main entry points are `evRead`, `evaluateOption`,
  `decide`, `whatIf`, `manual`, `compareLines`, `snapshot`, `grade`, `validation`, `ask`,
  plus the odds, settlement and de-vig functions (see DESIGN.md).
- `football/cfb_ev/`: `dataset.js`, `calibrators.js`, `tournament.js`, `market_study.js`,
  `staking_sim.js`, `freeze.js`, `demo.js`, `ev.test.js`, `policy/cfb_ev_policy_v1.json`,
  `current.json`, `data/cfb_ev_calibration_rows_v1.csv.gz` (+ manifest),
  `artifacts/cfb_ev_calibration_v1/{calibration,tournament,MANIFEST}.json` and `holdout_access.jsonl`,
  and `reports/{market_study,replay,staking_sim,demo}_v1.json`.
- `football/cfb_terminal/ev/<season>/ev_snapshots.jsonl` and `ev_grades.jsonl` (append-only),
  `ev_validation.json`, `ev.csv`.
- `docs/edgedesk-ev/`: PREREG, DESIGN, this report, and the screenshots.

Changed:

- `football/cfb_terminal/build.js`: `loadEv`, EV per game, `evLedger`, `next100Progress`,
  `evRow`, the EV fields in board, games and record, and five new build refusals. The Read model now carries `prediction_ts`.
- `lib/edgedesk_read.js`: exports `latestQuotes`, `sidePriceOf` and `bookKey`. No behaviour change.
- `research/cfb/terminal.js`, `index.html`, `terminal.css`: the EV card, price curve, juice
  panel, what-if, user books, manual quote, the EV lab route `#/ev`, EV export, and EV answers in Ask.
- `supabase/functions/edgedesk_ai/_cfb_explain.js` (+ the regenerated `index.ts`): `evFacts`, the EV
  prompt rules, and the audit codes `EV_VALIDATED_CLAIM` and `EV_BASIS_MISMATCH`.
- `package.json` (`cfb:ev:*` scripts; ev.test in `npm test`) and `.github/workflows/cfb-terminal.yml`
  (EV tests and `tournament.js --check`).

Tables: **no database table was added.** The EV ledger follows the Read ledger's
pattern, append-only JSONL committed by the hourly Lab job. A Supabase mirror is on the
backlog.

## 4. Canonical EV snapshot schema

`edgedesk_ev_snapshot_v1` (`EDEV.snapshot`). The P0 fields, all required for `production_grade` (which also
needs a PROMOTED or IDENTITY_VALIDATED calibration):
`game_id, selection_id, market_type, line_value, american_odds, decimal_odds, book_id, quote_ts,
prediction_ts, model_version, calibrator_version, settlement_rules, decision_policy_version, quote_id`.

The P1 fields:

- Probabilities: `p_{cover,win,push,loss}_{raw,calibrated}`, `break_even_probability`, `break_even_unconditional`, `probability_edge`, `raw_probability_edge`.
- EV: `raw_model_ev`, `calibrated_ev`, `conservative_ev`, `ev_ci_low/high`, `prob_ev_positive`, `ev_roi_pct`.
- Market: `market_fair_probability`, `devig_method`, `consensus_line`, `book_count_same_market`, `is_main_line`, `pure_fair_line`, `pure_margin_mean`, `distribution_artifact_id`, `price_curve_id`.
- Research and integrity: `research_status`, `integrity_gate_pass`, `favorite_flip`, `extreme_level`.
- Decision: `policy_clears`, `raw_clears`, `decision_status`, `policy_decision`, `timing_status`, `decision_reason_code`, `actionable`, `blockers`.
- Targets and decay: `bettable_to_line/odds`, `target_line/odds`, `price_gone`, `edge_kind`, `initial_probability_edge`, `edge_decay_pct/state`.
- Labels and alternates: `best_ev`, `best_main_line`, `best_alt_value`, `safest_line`, `alt_rows`.
- Quote: `quote_age_seconds`, `quote_fresh`, `ttl_minutes`, `odds_precision`, `origin`, `market_checkpoint`.

The id is `edev_<hash>` of the identifying fields, and the object is deep-frozen.

## 5. Odds conversion engine

American ↔ decimal (exact; rounded for display only), fractional, Hong Kong, Malay,
Indonesian and implied probability. `parseOdds` reads text and `normalizeOdds` returns
`{american, decimal, implied_raw, precision}`. Invalid prices (between −100 and +100, non-finite) are rejected.
A book's decimal price is kept at its own precision. Tested: F01–F05 and the round trips.

## 6. Settlement engine

State-based: `expectedValue([{state, p, payoff}])`. Two-way spread (half point: win/loss;
integer: win/push/loss), moneyline (void declared 0), Asian quarter (a split stake),
exchange back and lay (commission; lay per unit of liability). It fails closed if a probability
leaves [0, 1] or the states do not sum to 1. `MARKETS` registers M01–M14 with a status and a reason for each.

## 7. Cover / push / loss derivation

`probabilityAt(curve, side, line)` reads the stored curve. Win, push and loss come from the
curve's win[] and push[] at the home line, and cover = win / (1 − push). Alternates read the same curve.
The calibrated version shifts the curve's location so the cover probability at the market line equals the
calibrator's value. A fractional shift is a mixture of two integer shifts, which keeps pushes on
integers.

## 8. Calibration dataset construction

`dataset.js` rebuilds the champion's distribution for every FBS game from 2015 to 2026. It uses
the build's own `v1Dist`, `EDRead.buildCurve` and `sideProb`, so the rows are exactly what production
would have shown. It reads the raw P(home covers | no push) at the close, the open and close ±3/±7, the
win probability, and the outcomes. That gives 27,870 rows (`data/cfb_ev_calibration_rows_v1.csv.gz`,
sha256 `cc536025…`). Windows: IN_SAMPLE 2015–2021 (diagnostic), OOS 2022–2025 (walk-forward) and
HOLDOUT 2026 (the published record, read once). Swapped-id archive games and faulty openers are dropped.

## 9. Calibration tournament results

Walk-forward (2022→2023, 2022–23→2024, 2022–24→2025), pooled out-of-fold, with a 2,000-draw
week-clustered bootstrap against identity.

**cfb | spread | close** (n = 2,339 OOF):

| Candidate | Log loss | Brier | Slope [95% CI] | ECE | Δ log loss vs identity [95% CI] | Seasons no worse | Eligible |
|---|---|---|---|---|---|---|---|
| identity | 0.7334 | 0.2680 | −0.126 [−0.288, 0.035] | 0.104 | — | — | — |
| **temperature** | **0.6931** | **0.2500** | (flat) | 0.025 | −0.0403 [−0.0565, −0.0255] | 3/3 | ✔ **chosen** |
| platt | 0.6933 | 0.2501 | 0.468 [−0.30, 1.23] | 0.021 | −0.0401 | 3/3 | ✔ |
| beta | 0.7042 | 0.2555 | −0.093 | 0.070 | −0.0292 | 3/3 | ✔ |
| rolling_platt | 0.6930 | 0.2499 | 0.553 | 0.024 | −0.0404 | 3/3 | ✔ (best; tie within 1 SD) |
| isotonic | 0.7085 | 0.2565 | −0.177 | 0.047 | −0.0249 | 3/3 | ✔ |
| venn_abers | 0.6951 | 0.2510 | −3.39 | 0.029 | −0.0383 | 3/3 | ✔ |
| *coin flip (market benchmark)* | 0.6931 | 0.2500 | | | | | |

**cfb | spread | open** (n = 2,352): identity 0.7227. Temperature 0.6931 (T = 40.9) was
chosen, with Δ −0.0296 [−0.0462, −0.0156], 3/3 seasons.

**cfb | moneyline | close** (n = 2,388): identity 0.5471 (slope 0.886 [0.80, 0.97], CITL −0.107).
The best challenger was rolling Platt at 0.5453, but its Δ CI [−0.0064, +0.0026] reaches 0 and only 2/3
seasons were no worse. **No candidate was eligible.**

The in-sample 2015–2021 identity scores are shown as diagnostics only (close log loss 0.7295, slope −0.07).

## 10. Promoted calibrator, or explicit NO PROMOTION

- **Spread, close: PROMOTED temperature (T ≈ 10⁶).** It is the simplest candidate within one bootstrap SD of the best
  (rolling Platt). In words: *at the closing line the champion's cover
  probability should be read as 50%.* The 2026 holdout (n = 162) gave Δ log loss −0.064
  [−0.122, +0.011] against identity: **CONFIRMED** (it does not contradict the promotion).
- **Spread, open: PROMOTED temperature (T = 40.9).** The effect is almost the same: a raw 80% maps to 50.8%.
  There is no open-checkpoint holdout, because the record has no opener prices.
- **Moneyline: NO PROMOTION.** Identity is NOT calibrated (slope and CITL CIs exclude 1 and 0).
  Moneyline EV is RESEARCH only, and the page shows its raw EV as experimental.
- The maturity of both spread maps is **SHADOW**: promoted by the backtest, and not yet
  prospectively validated.

## 11. Break-even implementation

`breakEven(decimal, pPush)` → `conditional_nonpush = 1/decimal` (the cover probability needed)
and `unconditional = (1 − pPush)/decimal` (the win probability needed). Both are stored and both are shown. For example, at
South Carolina −3 −102 with a 2.6% push, break-even is 50.5% of non-push outcomes and 49.2% of all outcomes.

## 12. Raw EV implementation

The raw curve's win, push and loss go into the settlement states at the exact decimal price. The result is always stored
and always shown, labelled **EXPERIMENTAL**. It never clears a policy.

## 13. Calibrated EV implementation

The same arithmetic runs on the anchored calibrated distribution (see §7). It exists only when the calibrator
for the quote's checkpoint is PROMOTED or IDENTITY_VALIDATED and a fresh market line
exists to anchor at. Otherwise the result is `CALIBRATION_UNAVAILABLE` → NO DECISION, and raw EV is labelled
experimental.

## 14. Robust EV / uncertainty implementation

There are 500 seeded samples per game. Each combines a calibration draw (one of 200 week-clustered bootstrap Platt
refits, taken as a deviation from the centre and re-anchored) with location noise
τ = sqrt(max(0, sd² − 2.15²)) × the map's slope at the anchor. The robust EV is the pre-declared 10th percentile.
The interval runs from the 5th to the 95th percentile.

## 15. Pr(EV>0) methodology

Pr(EV>0) is the share of the 500 samples whose EV at the exact price is above 0. That is the posterior-predictive
probability under the two declared uncertainty layers. It is not a frequentist p-value, and it is
not the probability of winning the bet. The policy requires the 10th-percentile EV to be ≥ 0, which is the same as
Pr(EV>0) ≥ 0.90. That threshold was declared in PREREG §7 before any EV was computed.

## 16. Market de-vig benchmark implementation

The methods are proportional, power, additive (guarded) and Shin, with overround bounds. Each option stores
its `market_benchmark`: the de-vigged probability of the same book's two sides, labelled
BENCHMARK. **It never enters EdgeDesk's probability.** In the study on 134,644 archive rows,
proportional stays the display method. On the moneyline close, additive/Shin beat it by 0.00065 log loss, with a
95% CI [−0.0014, +0.0002] that reaches 0. On spreads, proportional was best.

## 17. Favourite-longshot diagnostic

On moneyline closes (63,541 rows, 25 books), realized ROI after vig by implied-probability bucket was:

| Bucket | 0–10% | 10–20% | 20–30% | 30–40% | 40–50% | 50–60% | 60–70% | 70–80% | 80–90% | 90–100% |
|---|---|---|---|---|---|---|---|---|---|---|
| ROI | −26.8% | −19.0% | −12.2% | +1.5% | +2.3% | −10.4% | −2.7% | −4.6% | −0.1% | −1.9% |

This is the classic longshot bias: favourites lose 4.0% after vig and underdogs lose 8.4%. The bias is
shown in the EV lab as a diagnostic. **It is not applied to EdgeDesk's probability.** Any use
would have to be validated on EdgeDesk data first.

## 18. Main-vs-alt price curve

`price_curve` combines the offered quotes with a REFERENCE ladder at −110 (hypothetical, labelled). It has a `coherent`
flag and the labels BEST EV, BEST MAIN, BEST ALT and SAFEST. The default sort is BEST EV, and SAFEST is never the default.
See the screenshot `demo/ev_price_curve.png`.

## 19. Incremental juice / protection analysis

`juice(a, b)` reports the extra points, the extra calibrated cover and win probability, the extra required break-even, the EV change,
the juice cents, the key numbers crossed with the game's mass beside the FBS empirical share, and a paired
Pr(ΔEV>0). The verdict is BETTER VALUE, WORSE VALUE (both need paired Pr ≥ 0.80), TOO CLOSE or NO DECISION. Real examples:

- Minnesota +7.5 −178 vs +5.5 −110 is **WORSE VALUE**: +4.4 pp cover against +11.6 pp break-even, and EV goes from
  −3.9% to −14.4%.
- Minnesota +6.5 −112 is **BETTER VALUE**, with EV going from −3.9% to −0.3%. Both are negative, and the panel says so.

## 20. Key-number treatment

The engine adds no manual bonus. The audit (anchored, OOF 2022–2025) measured two things:

- **Pushes.** At integer market lines, the predicted push rate is 3.2% against 5.25% observed (95% 4.0–6.9%). At 3 it is 5.6% against 9.6%, and at 7 it is 2.1% against 11.1%.
- **Margin mass.** |margin| = 3 is 10.5% of games but only 4.6% of the model's mass. |margin| = 7 is 8.7% against 4.1%.

The cause is the V1 integer re-centring. The consequence: `KEY_NUMBER_MASS_UNVALIDATED` means an option that crosses 3 or 7
relative to the market line is never actionable. Main lines are not blocked. At −110, the EV at an integer line moves by
about 0.1 pt per 2 pp of push error.

## 21. Quote freshness policy

The TTLs are: spread 180 min, alternate 90, moneyline 180, total 180, user quote 30. The TTL drops to 60 within 6 h of kickoff,
and to 60 for an extreme EV. A stale quote is never actionable (STALE QUOTE → NO DECISION). Before any
decision, `recheck` looks at the same book's latest quote.

## 22. Best-available price logic

Among fresh, priced quotes at accessible books, the best price is the one with the highest robust (10th-percentile)
EV, with calibrated EV breaking ties. An option with only a raw EV ranks below every calibrated one. The best price is never
chosen by the best line alone. The broader market is shown separately.
`edge_kind` classifies the edge as MODEL_EDGE, BOOK_SPECIFIC_PRICE_EDGE, BOTH or NONE by comparing EV at the consensus
with EV at the book.

## 23. User-book filtering

The engine reuses the page's existing **My books** selection (view mode `mine`, stored per viewer in
`edcfb_books_v1`). `optionsFrom` restricts the selected quote to those books. If none of the user's books has a fresh price, the result is `NO_ACCESSIBLE_PRICE`, and the
broader market stays visible as context.

## 24. Manual quote entry

The user types a quote such as `Minnesota +7.5 -105`. `EDEV.manual` parses it and re-prices it from the stored curve,
without re-running the model. It is labelled **USER QUOTE**, has a 30-minute TTL, and is never certified (its best result is RESEARCH ONLY).
A line without a price is refused.

## 25. Bettable-to engine

Two values are found by bisection: the worst line that still clears at the current price, and the worst price that
still clears at the current line. They are shown as "bettable to". When calibration is pending, a raw threshold is
shown instead, labelled experimental.

## 26. Target price engine

The target reads `CURRENT <quote> → TARGET <line> OR <price>`, together with the EV-zero price. A target is a
WAIT only if it is reachable (§30). Otherwise it is printed as a **SHOPPING TARGET**: "would clear
at one book while the market stays where it is — not a reason to wait."

## 27. Price-gone logic

PRICE_GONE applies when an earlier eligible snapshot for the same selection cleared the policy and the current
quote does not. The earlier read is re-evaluated with its own anchor and its own checkpoint's calibrator, and
the frozen read stays exactly as it was.

## 28. Edge-decay logic

`edgeDecay(initial, current)` returns GREW, RETAINED, PARTIAL, MOSTLY_GONE, VANISHED or REVERSED. The
percentage is null on a sign flip, because "−140% decay" has no meaning.

## 29. BET EARLY logic

BET EARLY requires the policy to clear, plus a **measured** urgency: either the market has moved toward EdgeDesk since the
open, or losing half a point would cross a key number. Movement is described as informative, not proof.
While the policy is in SHADOW, a BET EARLY is shown as RESEARCH ONLY, and `policy_decision` keeps BET_EARLY for
validation.

## 30. WAIT logic

A WAIT needs three things: a model–market gap of at least 2 pts; a target within ordinary open-to-close movement
(1.9 pts); and a price that **still clears after the calibrator is re-anchored at the target line**. The price-only case
needs a target price no better than −110. QB uncertainty that is unresolved on a clearing price gives WAIT
(information pending). There is no "wait for sharps" wording. The live slate has no WAIT. Under the promoted
calibrator, a market move carries the calibrated probability with it, so this is the correct result.

## 31. Timing-validation plan

`grade()` records, per snapshot:

- for BET EARLY: whether the line deteriorated later;
- for WAIT: whether the target was reached, the best later line or price, and close-vs-wait in points;
- CLV in points and in same-line price.

`validation()` aggregates these by version boundary and shows rates at n ≥ 30. `researchTriggers`
raises BET_EARLY_LOSES_CLV when BET EARLY reads see the line improve more often than deteriorate.

## 32. Research-status / action-status interaction

Research status overrides EV. DATA FAULT, INVESTIGATE, MARKET FAULT and MARKET CHECK all give NO DECISION,
and any EV shown is "research context, never actionable before the gap is verified". LIMITED DATA or
reliability under 60 caps a clearing price at RESEARCH ONLY. Real example: Syracuse @ UConn has a raw EV of **+63.3%**,
an 18-point gap and 1 book → MARKET FAULT → NO DECISION.

## 33. Extreme-EV circuit breaker

The thresholds come from the OOS extremes: |raw cover − 0.5| has p95 0.238 and p99 0.314, and the gap has p95 10.2 and p99 14.7 pts.
The checks are quote verification, sign orientation, favourite flip, distribution sanity, component
disagreement, and the calibration domain at the anchor. An extreme EV that has not been verified is RESEARCH ONLY, with a 60-minute TTL.

## 34. Favourite-flip handling

`favorite_flip` flags a model favourite that is the market underdog, or the reverse. It routes the read through the circuit
breaker's review. It is shown, and never turned into a bet on its own.

## 35. UI EV card

The card sits under the Read card on each game page. It shows the exact quote, book, age and TTL; the settlement structure;
cover and push (calibrated and raw); break-even on both bases; the probability edge; calibrated EV, raw EV (EXPERIMENTAL)
and robust EV; the 5–95% interval; Pr(EV>0); the de-vig BENCHMARK; the decision, with the policy decision and
blockers; bettable-to; the target; edge kind; decay; versions; and the exact tooltip. There is no LOCK, HAMMER or
similar wording: `auditText` checks it and the build refuses to write text that fails. Screenshots:
`demo/ev_card_pass.png`, `ev_market_fault.png`, `ev_stale.png`, `ev_integer_push.png`, `ev_mobile.png` (390 px, no horizontal
scroll).

## 36. Main-vs-alt UI

The table columns are LINE | ODDS | COVER | PUSH | BREAK-EVEN | MODEL EDGE | EV | ROBUST EV | READ. The sorts are BEST EV
(default), BEST MAIN, BEST ALT and SAFEST. The juice panel compares any two rows. See `demo/ev_price_curve.png` and `ev_juice_and_whatif.png`.

## 37. What-if calculator

The user types a line and price, and the engine returns cover, push, break-even, EV, robust EV and the status, from the stored curve
(the model is not re-run). It shows two readings: **one book at this price** (the market stays put), and **if the whole market moves
here** (re-anchored). Example: at Minnesota +4.5 −110, one book gives EV −12.4%, and a market move there gives calibrated cover
50.3% and EV −4.0%.

## 38. AI integration

`evFacts` gives the assistant the structured EV object: quote id, timestamp and source, basis, probabilities, EVs,
versions, blockers, and validation or `UNKNOWN`. The prompt allows only those numbers. The audit rejects
invented numbers, "validated" claims (`EV_VALIDATED_CLAIM`) and a basis mismatch (`EV_BASIS_MISMATCH`). On the page,
`EDEV.ask` answers the EV questions deterministically, with provenance: juice, bet or wait, worst price, missed number,
why not bet, and why positive. A question about sharp action, handle or public splits bypasses the EV path and goes
to the Read's existing answer path. The EV engine never states any of them.

## 39. Immutable record integration

`build.js` appends each new snapshot (`edev_…`) to `ev/<season>/ev_snapshots.jsonl` and each grade to
`ev_grades.jsonl`. It grades against the Lab consensus close and the same book's closing price, at the recorded line and price.
It never uses a better historical line. `record.json.ev_record` and `ev.csv` publish the ledger. 24 snapshots are recorded so far.

## 40. Model Lab EV dashboard

The route `research/cfb/#/ev` shows:

- the tournament table for every task, and the promotion reason;
- the push and key-number audits, and the alternate-line transport audit;
- the replays, the de-vig and favourite-longshot studies;
- live validation by version boundary, next-100 progress, and the frozen EV reads.

See `demo/ev_lab.png`.

## 41. Version / maturity taxonomy

Promotion ladder: RESEARCH → CHALLENGER → SHADOW → PRODUCTION, per submodule. The current stages:

- Odds and settlement arithmetic: PRODUCTION (tested).
- Spread calibrators: SHADOW.
- Moneyline calibrator: PENDING / RESEARCH.
- EV decision policy: SHADOW, with betting off.
- Staking: DISABLED.
- Totals: NOT_ACTIVATED.
- Global markets: CONTRACT_ONLY or BLOCKED.

The validation boundaries are LEGACY, CURRENT EV VERSION, CURRENT SEASON and LAST N.

## 42. Prospective next-100 freeze

`football/cfb_ev/next100_freeze.json` freezes the engine, calibrator and policy by name and SHA-256.
The population is the first 100 distinct (game, selection) EV reads after the freeze, with a fresh quote and a calibrated
probability, **every status included** (so PASS reads are graded as counterfactuals). The metrics were declared up front:
calibration, EV monotonicity, CLV, freshness failures, robust EV, timing and alternates. Any change to a frozen file
needs a version bump or a PATCH row in `versions.jsonl`, and the test suite fails on unrecorded drift.

## 43. Automated tests

`football/cfb_ev/ev.test.js` has **232 checks, all green**, in 15 sections: odds; settlement; de-vig; staking arithmetic;
CLV, decay and juice; curve signs, pushes and moves; calibration maps, artifact and anchor; uncertainty; EV read fixtures;
fail-closed; snapshot, grade, validation and ask; properties; tournament governance; the real slate (all 20 pages recomputed byte
for byte, and parity with the Read); page, explanation boundary and freeze. It covers the applicable formula library entries F01–F30
and the worked examples W01–W07. It runs in `npm test`, `npm run cfb:terminal:test` and the CFB terminal CI workflow, together with
`tournament.js --check`.

## 44. Property tests

There are 60 randomized distributions × both sides × lines from −20 to +20. The properties checked:

- probabilities sum to 1 and stay in [0, 1];
- P(win) is monotone in the line (within the 1e-6 storage tolerance);
- decimal > 1, and break-even is in [0, 1];
- a read recomputes identically;
- the price curve is coherent;
- a better price at the same line never lowers EV.

## 45. Historical replay results

Each quote is replayed at its own book and price, never the best price in hindsight (`reports/replay_v1.json`).

| Replay | Stated EV bucket | n | Avg stated EV | Realized ROI [95% CI] |
|---|---|---|---|---|
| Spread close 2015–19 (in sample) | ≥ +10% | 35,502 | +22.9% | −6.7% [−7.7, −5.7] |
| | +5–10% | 10,653 | +7.5% | −4.9% |
| | 0–2% | 4,320 | +0.9% | −8.9% |
| Spread open 2015–19 (5Dimes) | ≥ +10% | 1,648 | +22.4% | −6.1% [−10.7, −1.5] (CLV +0.43 pts, 50.8% positive) |
| Moneyline 2023–25 raw | ≥ +10% | 2,612 | +36.2% | −5.7% [−11.3, −0.0] |
| Moneyline 2023–25 all raw-positive | > 0 | 4,692 | | −3.6% |

Spreads for 2022–2025 are **NOT REPLAYED**: the archive has no spread prices after 2019, and −110 is never assumed.
The probability-level evaluation at the close is the tournament (§9). The replay shows that stated raw EV is not
monotone in realized ROI, which is why raw EV is never decision-grade.

## 46. Current-slate demonstrations

From `reports/demo_v1.json` (slate built 2026-09-28T03:07Z). Real data was used wherever the slate has the case, and fixtures,
labelled FIXTURE, where it cannot:

| # | Case | Kind | Result |
|---|---|---|---|
| 1 | Positive main-line EV | REAL game + USER QUOTE (the slate has none) | Minnesota +7.5 −105: calibrated EV +7.0%, robust +4.8%, Pr 100% → RESEARCH ONLY (USER QUOTE; crosses 7; it exists only at a price 2 pts off the market: BOOK-SPECIFIC) |
| 1b | Raw EV that does not survive calibration | REAL | NC State +5.5 −108: raw +29.4% → calibrated −2.9% → PASS |
| 2 | Negative main-line EV | REAL | Minnesota +5.5 −110: calibrated −3.9%, robust −6.7% → PASS |
| 3 | Main beats the safer alternate | REAL + typed alt | +7.5 −178 is WORSE VALUE (EV −3.9% → −14.4%) |
| 4 | An alternate has better EV | REAL + typed alt | +6.5 −112 is BETTER VALUE (−3.9% → −0.3%, both negative) |
| 5 | Integer line with push | REAL | South Carolina −3 −102: push 2.6%, break-even 50.5% / 49.2% → PASS |
| 6 | Stale quote suppressed | REAL | Arkansas @ Texas A&M → NO DECISION (STALE QUOTE) |
| 7 | INVESTIGATE / MARKET FAULT with an attractive raw EV | REAL | Syracuse @ UConn raw +63.3% → NO DECISION |
| 8 | VERIFIED MAJOR that still PASSes | FIXTURE | calibrated −4.4% → PASS |
| 9 | BET EARLY | FIXTURE (production policy) | BET EARLY: the market moved 1.5 pts toward EdgeDesk; the same read in SHADOW → RESEARCH ONLY (policy BET_EARLY) |
| 10 | WAIT with a target price | FIXTURE | CURRENT +5.5 −130 → TARGET +6.5 −130 OR +5.5 −119 |
| 11 | PRICE GONE | FIXTURE | +8.5 −110 cleared; +6.5 −140 does not |
| — | What-if | REAL | Minnesota +4.5 −110: one book −12.4%; market-wide −4.0% |

Slate counts: PASS 21; NO DECISION 41 (STALE QUOTE 20, MARKET CHECK 7, DISTRIBUTION FAULT 6, INVESTIGATE 5,
MARKET FAULT 3). **Calibrated-positive EV on the slate: 0.**

## 47. Unsupported markets, explicitly blocked

Each of these is registered in `MARKETS` with a reason, and `decides: false`:

- Totals and team totals: NOT_ACTIVATED (no total distribution).
- European 1X2, Asian half/whole/quarter, exchange back/lay: CONTRACT_ONLY (settlement implemented and tested; no distribution or feed).
- Pari-mutuel, live, same-game parlay, futures, promos/boosts: BLOCKED.
- Moneyline: RESEARCH (not validated).

## 48. Known limitations

1. The champion's cover probability at the market line is uninformative out of sample, so calibrated EV can only find
   book-specific price differences. It cannot find a football edge at the market number.
2. Only one priced book is on the live slate, so line shopping and consensus-vs-book are thin.
3. Alternate quotes are not captured on a schedule, so the alternate ladder is a REFERENCE at −110.
4. Key-number mass is under-stated by the V1 PMF's integer re-centring, so alternates that cross 3 or 7 are never actionable.
5. Six slate games have incoherent build curves (the no-market fallback). The engine fails closed on them (DISTRIBUTION FAULT), and the fix belongs upstream.
6. There is no spread price history for 2022–2025, so the prices of calibrated EV cannot be replayed out of sample.
7. The moneyline calibrator is not validated.
8. The open-checkpoint calibrator has no holdout.
9. Limits are UNKNOWN, and execution is not modelled beyond a quote recheck.
10. The uncertainty model has two declared layers. Other error sources (for example QB news after the snapshot) are handled by status, not by sampling.
11. The EV ledger lives in the repo, not yet in Supabase.

## 49. Production-readiness classification

**SHADOW overall. Not production for betting decisions.**

- The arithmetic (odds, settlement, break-even, de-vig), snapshots, grading, fail-closed logic and UI are production-quality and tested.
- The spread calibrators are promoted by backtest and confirmed by the 2026 holdout, but have not been prospectively validated.
- The policy is SHADOW, with betting off. Staking is disabled.

Moving to PRODUCTION needs the next-100 evaluation plus a person's promotion, recorded as a new policy version.

## 50. Remaining research backlog

1. ~~Fix the V1 PMF re-centring so key-number mass and pushes are right. Then re-audit, re-run the tournament, and cut a new calibrator version.~~ **Done 2026-10-04**, with two departures. The re-centring reweights the row in place rather than mixing shifts, which keeps every spike and the tie hole on its own margin. And the re-fit promoted the same methods, so it is a recorded PATCH of `cfb_ev_calibration_v1` rather than a new version. A new version would have stopped the next-100 count, which keys on the calibrator version. See PREREG.md, post-registration change 3.
   - ~~Still open: the calibration anchor (`lib/edgedesk_ev.js` `shiftedHome`) carries the curve to the calibrated probability by a location move, which moves the spikes again.~~ **Done 2026-10-05**: the anchor now reweights the curve in place (`recentredHome`), so a tie keeps no mass and the spikes stay on 3 and 7. The anchored push rate at integer lines rose from 2.9% to 3.4%, against 5.3% observed (95% 4.0–6.9%), so key-number mass stays NOT VALIDATED. The shortfall left is the PMF's own at the market's number. The alternate-line slopes all moved inside 0.6–1.6, so the validated tail is ±7. See PREREG.md, post-registration change 4.
2. Fix the incoherent no-market curve fallback in the terminal build.
3. Schedule the alternate-spread capture (it needs an Odds API budget decision) and add more priced books.
4. Validate a moneyline calibrator. The Platt / rolling Platt challengers were close.
5. A market-aware challenger (football × market blend) in SHADOW, kept separate from the pure fair line.
6. Capture opener prices, so open-checkpoint holdouts and PRICE GONE from openers become possible.
7. Mirror the EV ledger to Supabase, with RLS, like the Read analytics.
8. Evaluate the live-checkpoint calibrators (T24/T6) separately once enough graded snapshots exist.
9. Revisit Kelly and portfolio correlation only after EV is validated prospectively.
10. A totals distribution, which would activate totals EV through the same settlement engine.
