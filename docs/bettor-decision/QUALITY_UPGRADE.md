# EdgeDesk decision quality — one market, an execution layer, and a way to prove it

This upgrade makes EdgeDesk **more statistically honest, internally consistent,
easier to use, harder to fool with bad market data, and able to measure whether
its own decisions are worth anything**. It is not a redesign. Every existing
system is kept and read: model fair lines, market comparison, sportsbook
quotes, alternate spreads, raw and calibrated EV,
BET / LEAN / WATCH / PASS / NO DECISION, unit sizing, bankroll exposure,
research, confidence, reliability, QB and availability, sensitivity,
watchlists, alerts, decision logging, Compare My Number, share cards, public
grading, CLV, exports and the Collective.

| Module | Global / require | What it owns | § |
|---|---|---|---|
| `lib/edgedesk_market.js` | `EDMarket` | the one canonical market object: consensus, verification, outliers, quality index, movement | §2 |
| `lib/edgedesk_execution.js` | `EDExecution` | price-value curve, transition ladder, best execution, empirical key numbers | §3 |
| `lib/edgedesk_explain.js` | `EDExplain` | the one-line answer, why-not, what-changes-my-mind, sensitivity, provenance, meaningful alerts | §4 |
| `lib/edgedesk_validation.js` | `EDValidation` | evaluation modes, sample-size states, segmentation, calibration, CLV, expectation tests, leakage audit | §5 |
| `lib/edgedesk_decision.js` | `EDDecision` | unchanged contract; now builds the canonical market, the execution blocks and the versions on every decision | §6 |
| `lib/edgedesk_bankroll.js` | `EDBankroll` | exposure limits per game / day / sport / kickoff window | §7 |

All four new modules follow the house style: ES5 UMD, no dependencies, pure
functions, deterministic output. None of them changes a threshold, a
calibration or a model.

## 1. Principles held throughout

- **Descriptive before prescriptive.** Every rate prints its `n` and a sample
  state. A sample too small to judge is labelled so, never hidden and never
  acted on.
- **Modes are never blended.** Backtest, walk-forward, live-reconstructed and
  live evidence are separate rows in every report. A summary asked to mix
  them refuses (`MIXED_MODES`).
- **Research alerts, never automatic changes.** When BET does not beat LEAN,
  or a probability bucket misses, EdgeDesk says so with the sample size and
  changes nothing.
- **No closing information in a pregame decision.** Every decision records
  the time of its newest input; the leakage audit flags anything captured
  after evaluation, after kickoff, or a close captured before the decision.
- **A single anomalous quote cannot create a BET.** It is named, measured
  against the consensus, and capped until it verifies.
- **Indices are not probabilities.** Market quality, decision confidence and
  reliability are 0–100 indices and every surface says so.
- **Missing is missing.** Unmeasured components are left out and the weights
  renormalised; nothing is filled with zero.

## 2. The canonical market (`EDMarket`)

Before this upgrade, "the current line" was decided in four places: the
research card's consensus, the quote-EV board's best price per number, the
decision engine's modal home line and whatever the share card carried. They
usually agreed. Now the decision engine builds **one** market object per
decision (`EDMarket.canonical`) and every surface reads it:

```
event_id, sport, market_type, selection, line, odds, sportsbook, captured_at,
age_seconds, orientation, verification_status, market_depth, book_count,
consensus_line, sharp_reference_line, best_execution_price, source, quality,
movement, consensus{median, mean, weighted_mean, modal, dispersion,
book_agreement, outliers[], unresolved}
```

**Consensus.** The latest main quote per book. The line is the modal number
when most books deal it, otherwise the median snapped to the half point — the
same rule as `lib/market_consensus.js`, pinned by a parity test. A
freshness-and-sharp-weighted mean (sharp books ×2, aging ×0.5, outliers
excluded) is reported beside it and never used as the line.

**Outliers.** A book is an outlier only when an agreeing majority sits
elsewhere, beyond the league tolerance (NFL: 1.0 pt spread, 1.5 total, 3 pp
moneyline; CFB: 1.5 / 2.0 / 4 pp). A 2–2 split is `unresolved`, not two
outliers. With two books, a sharp book (Pinnacle, Circa, Bookmaker, BetCris)
breaks the tie. The sentence is fixed:

> PRICE ANOMALY — Caesars: Chicago +3.5. Consensus: Chicago +1. The quote is
> 2.5 points away from consensus. EdgeDesk will not promote this to BET until
> verified.

**Verification status.** `NO_QUOTE · STALE · UNVERIFIED · OUTLIER ·
UNRESOLVED · SINGLE_SOURCE · VERIFIED · CORROBORATED`.

**Freshness.** One rule: FRESH ≤ 30 min, AGING ≤ 90 min (the decision
limit), STALE after, research-stale after 180 min. A caller's own
`fresh:false` is honoured.

**Quality index (0–100).** From measured components only (freshness, depth,
agreement, dispersion, outliers, orientation, two-sidedness, liquidity; the
weights sum to 1 and an unmeasured component is dropped and the rest
renormalised), with hard caps: a selected outlier
≤ 45, stale ≤ 30, ambiguous orientation ≤ 40, a single book ≤ 64. It is
labelled "an index, not a probability" wherever it prints.

**Movement.** Opening, current, high, low and velocity, described and never
attributed: `LINE_MOVED_TOWARD_MODEL / AGAINST_MODEL`,
`MARKET_CONFIRMING / REJECTING`, `CROSSED_KEY_NUMBER`, `KEY_NUMBER_TOUCHED`,
and `STEAM_LIKE_MOVE` — "A fast move: 1 point in 20 minutes. EdgeDesk describes
the move; it does not know who caused it." (NFL: 1 pt within 30 minutes; CFB:
1.5 pts).

## 3. The execution layer (`EDExecution`)

**Price-value curve** (`curve`). The decision engine's own classifier
(`EDDecision.hypoClassifier`) is run at every nearby line (4 below, 3 above)
and price (−20 to +30 cents). Each point carries the class, the stake, the
edge and the EV. `price_curve.self_check` re-classifies the current quote and
must agree with the decision actually issued; a sweep test pins this.

**Transition ladder** (`ladder`). Only the rungs where the decision or the
stake changes, plus the current one, capped at 7 rows:

```
At -110: +8 WATCH · +8.5 BET 0.25U · +10 BET 0.25U (now)
At +6.5: -122 WATCH · -117 LEAN · -107 BET 0.50U · -102 BET 0.50U (now)
```

A flat ladder says so ("no nearby price changes the decision"). Each ladder
carries the caveat that it holds the rest of the market where it is.

**Best execution** (`bestExecution`). Among executable quotes only (price
verified, on-market, fresh, inside the validated tail), ranked by class, then
risk-adjusted EV, then main line, then EV. The decision's own selected quote
wins ties. The reason is one sentence: "+6.5 is more points at no worse a
price (+10.8% calibrated EV vs +4.3% calibrated EV).", or that the better
number crosses a key number and produces higher EV despite the additional
juice.

**Empirical key numbers** (`tools/validation/build_key_numbers.js` →
`football/validation/key_numbers.json`). Built from final margins, not
assumed: NFL (n = 7,323 games, 1999–2026) primary 3 and 7, secondary 6 and
10; CFB (n = 11,502, 2006–2025) primary 3 and 7, secondary 10, 14 and 21.
Primary is at least 2× the average margin frequency and at least 6%;
secondary at least 1.25×.

## 4. Explanations and the three information levels (`EDExplain`)

**One line** (`oneLine`). Deterministic for every reason code:

- "Miami +10.5 at -105 clears EdgeDesk's current threshold with +9.5% calibrated EV."
- "Iowa +13.5 is close, but EdgeDesk wants +14 or a better price."
- "The model likes Cleveland more than the market, but calibration removes the apparent edge."
- "No current market quote is reliable enough to price."

**Why not?** (`whyNot`, `gates`). Every gate — evaluable, market verified,
quote fresh, price, probability source, reliability, QB, availability, market
quality, decision confidence, price verification, sizing — with the binding
one marked: "PASS because…", "WATCH because the price is 0.5 pts short",
"WATCH because the quote is inconsistent with the consensus" (one off-market
book in a live market), and "MARKET FAULT because…" only when the decision's
market state is MARKET FAULT, so the phrase carries one meaning.

**What changes my mind?** (`whatChanges`). Price (the playable-to and the
first rung that turns it into a BET), QB, availability, the model (the
break-the-number cushion) and the market.

**Break the number** (`sensitivity`, `scenarios`). How far EdgeDesk's number
can move before the edge, and then the BET, disappears, measured against the
published input uncertainty (rating SDs, the reconcile combination SD).
`SURVIVES_CONSERVATIVE` needs a cushion of at least 1.28 SD. When no input
uncertainty is published, it says so and makes no claim of plausibility.
Scenarios (±1 SD) are labelled "not a forecast".

**Provenance** (`provenance`). For each input — model, market, QB, roster,
matchup — its source, as-of time, and whether it feeds the price or is
research only.

**Meaningful alerts** (`alerts(prev, next)`). Only state changes a bettor acts
on: `BET_TRIGGERED`, `BET_INVALID`, `QB_CONFIRMED`, `QB_OUT`, `AVAILABILITY`,
`FAIR_MOVED` (NFL 1 pt, CFB 2 pts), `KEY_NUMBER`, `ANOMALY_RESOLVED`,
`RELIABILITY` (≥ 10 points). Each carries a dedupe key.

**Levels** (`lib/edgedesk_decision_ui.js`). One card, three depths, remembered
per device (`edgedesk_info_level_v1`):

| Level | Question | Shows |
|---|---|---|
| Beginner | What should I do? | the pick, price and book, the stake in dollars, playable-to, one line, three cells (EV, edge, confidence), WHY and MAIN RISK |
| Research | Why? | + why not, the canonical market, price alternatives (best execution and both ladders), what changes my mind, reliability breakdown, break the number |
| Lab | How was it calculated? | + the probability model, every gate with the binding one, the price curve and its self-check, the decision history, every version |

The watchlist row carries the same decision line (`EDExplain.watchRow`).
Decisions export as CSV from the Card page.

## 5. Validation (`EDValidation`), the ledger and model health

**Modes** — `BACKTEST`, `WALK_FORWARD`, `LIVE_RECONSTRUCTED`, `LIVE` — and the
maturity ladder BACKTEST → WALK_FORWARD → LIVE_DECISIONS → LIVE_CLV →
LIVE_PROFITABILITY, reported stage by stage with `n`, never as a verdict.

**Sample-size states** (`sampleState`):

| n | State | Label | Recalibration |
|---|---|---|---|
| < 50 | `DESCRIPTIVE_ONLY` | Too early to evaluate | not allowed |
| 50–199 | `EARLY_SIGNAL` | Early signal | not allowed |
| 200–499 | `MODERATE_EVIDENCE` | Developing evidence | proposal only |
| 500+ | `STRONGER_EVIDENCE` | Meaningful sample | proposal only |

**Segmentation** (`segment`). An extensible registry (`DIMENSIONS`): mode,
sport, decision, unit tier, market, confidence band, calibration source,
reliability band, price-edge band, calibrated-EV band, gap band, favourite,
home/away, division, key-number exposure, market quality, book depth, quote
freshness, and the model, calibration and rules versions. Rows missing a
dimension are counted as `not_measured`, never dropped silently.

**Calibration** (`calibration`). Bins, Brier, log loss, ECE, MCE and the base
rate. Measurement only.

**CLV — the primary signal** (`clv`, `clvSummary`). For spreads, points and
price-equivalent: the cover-probability difference between the entry line and
the close line on one close-centred distribution, where the close is treated
as a fair coin flip. Moneylines use implied probability; totals use points.
Opening, evaluated, bet and closing consensus are all recorded, and the sharp
close when one is captured.

**Expectations** (`expectations`). BET should beat LEAN, LEAN should beat
PASS, and higher tiers should beat lower ones. A miss is a research alert
with its `n`: "WARNING: 0.75U BET tier is not separating from 0.50U tier
after 83 settled decisions. This is a research alert, not an automatic
change."

**Leakage audit** (`leakageAudit`). `POST_KICKOFF`, `QUOTE_AFTER_EVALUATION`,
`INPUT_AFTER_EVALUATION`, `CLOSE_BEFORE_EVALUATION`,
`TRAINED_ON_TEST_SEASON`, `NO_EVALUATION_TIME`.

**The ledger grades every class.** `football/cfb_terminal/decisions.js` now
grades the first snapshot per game × market × decision class
(`EDDecisionTrack.firstPerClass` and `gradeEvaluation`, schema
`edgedesk_bettor_decision_evaluation_v1`) — PASS and WATCH as well as BET —
into `decisions/<season>/evaluations.jsonl`, using the Lab's opening and
closing consensus. Each row records points CLV, sharp CLV when available,
price-equivalent CLV, the result, BET units, a flat 1U hypothetical and
every version. A losing decision is never removed, and no prediction is
rewritten.

**Database** (`supabase/decision_validation.sql`, apply after
`bettor_decisions.sql`). Generated stored columns on
`bettor_decision_snapshots` (`evaluation_mode`, `data_snapshot_at`,
`version_key`, `pricing_model_version`) and a write-once
`bettor_decision_evaluations` table with RLS. An honesty trigger refuses
post-kickoff decisions and a close captured at or before evaluation. Checks
enforce that a BET has units and a bet line. The view
`bettor_decision_validation` groups by mode × sport × decision with `n` and
the sample state. `decisions_sync.js` sends the evaluations and fails soft
until the file is applied.

**Model health** (`tools/validation/model_health.js` →
`football/validation/model_health.json`). A cached report the Card page reads
and never recomputes on render. It contains:

- the live decision ledger;
- the CFB Lab by mode;
- walk-forward pricing validation;
- the published model record, labelled model-level;
- a distribution audit;
- key numbers and the maturity ladder;
- every research alert.

It fingerprints each input: `--check` fails when the same inputs build a
different report (the code changed without a rebuild), and `--strict` also
fails when the data has moved on. The hourly Lab job rebuilds it.

Alerts it raises today include:

- the NFL walk-forward Brier not beating the base rate;
- NFL raw-model calibration misses by bucket;
- the NFL learned margin distribution sitting off-centre at 17 of 37 closing numbers;
- the CFB model record of 104-125-2 against the spread, whose whole 95% interval (39.1–51.9%, n = 229) sits below the −110 break-even.

## 6. Decision engine changes (`EDDecision`)

- **Canonical market on every decision.** `d.market` comes from
  `EDMarket.canonical`. The engine's consensus is that consensus (the old
  modal home line is kept as `mode_home_line`), and `market_quality` reads the
  canonical fresh-book count, so the card and the engine cannot disagree.
- **Outlier protection.** `priceReview` adds the `QUOTE_OUTLIER` trigger and a
  book-on-market check. Dispersion is computed without the named outlier, so
  one bad book does not fail agreement for every book. Totals and moneylines
  prefer on-market quotes and cap an off-market selection at WATCH ·
  `PRICE_ANOMALY` with the outlier sentence.
- **`MODEL_CONFLICT`.** When the quote sits on the other side of EdgeDesk's
  own fair line but the model's own (raw) probability still says it covers,
  the class is capped at WATCH. A validated calibration that moves the
  probability across the raw fair line is not capped: calibrated EV decides. The cause is the off-centre NFL margin distribution (§5 model
  health); the example message is "(Miami Dolphins +10 against a fair +11.5,
  model cover 59.3%)". The ladder applies the same cap at every rung.
- **Versions on every decision** (`d.versions`, `EDDecision.versionsOf`):
  model, calibration, pricing engine, decision engine, rules, market engine,
  execution engine, the newest and oldest quote times, the projection time,
  `facts_as_of`, `data_snapshot_at`, `pregame`, `inputs_after_evaluation`,
  `leakage_ok`, and a `version_key` (`dv_` + hash) that is also part of each
  snapshot id.
- **Execution blocks** on every evaluable decision: `best_execution`,
  `ladder` and `price_curve` (a summary only in the published artifact).
- `evaluation_mode` (default `LIVE`) and `data_snapshot_at` on every decision
  and snapshot.
- Transition text names the book and the EV: "DraftKings moved from +10
  (-110) to +10.5 (-105), pushing calibrated EV above the betting threshold
  (+9.5%)."

## 7. Exposure limits (`EDBankroll`)

Conservative defaults of 1U per game, 3U per day, 3U per sport and 2U per
kickoff window. Each limit reports `OK / NEAR (≥ 80%) / AT_LIMIT / EXCEEDED`
with warnings on the Card page. Holding positions past a limit is opt-in
(`bucket_limits_enabled`). A remote settings row never resets the device's
limits.

## 8. Tests and CI

| Suite | Checks |
|---|---|
| `tools/validation/market_execution.test.js` | 93 |
| `tools/validation/validation_engine.test.js` | 88 |
| `tools/validation/ledger_health.test.js` | 37 |
| `tools/validation/explain.test.js` | 64 |
| `tools/validation/info_levels_ui.test.js` | 147 |
| `tools/validation/decision_validation_sql.test.js` (real PostgreSQL) | 32 |
| `tools/bettor/decision_ui.e2e.js` (Chromium, desktop and 390 px phone) | 50 |

- `npm run validation:test` — the five offline suites
- `npm run validation:sql` — the evaluations contract against PostgreSQL
- `npm run validation:health` / `:write` / `:check` — the model health report
- `npm run validation:keys` — rebuild the empirical key numbers

`.github/workflows/decision-quality.yml` runs these on every PR that touches
the modules, alongside the existing bettor decision suites.

## 9. Known limitations

- **No live evidence yet.** Zero live decisions are graded. The first graded
  rows arrive after the first slate that the build ledger decides. Until
  then every live figure is "Too early to evaluate".
- **CFB only in the ledger.** The build ledger (`football/cfb_terminal`) is
  CFB. NFL decisions are made and versioned in the browser but not persisted
  as graded evaluations.
- **No sharp close.** Neither football ledger captures a sharp close yet;
  sharp CLV is recorded as null (not measured), never as zero.
- **NFL distribution drift is flagged, not fixed.** The NFL margin
  distribution drift is reported and guarded (`MODEL_CONFLICT`), not
  corrected in the model. Re-centring it is a model change that needs its
  own walk-forward.
- **Legacy surfaces keep their own rules.** The legacy share card and board
  CSV exports still read their own fields. A canonical decision CSV was
  added beside them. Older duplicate logic in `app.html` (EDINTEL) remains.
- **Local limits and thresholds.** Exposure limits are device-local. The
  staleness thresholds are documented in one place (`EDMarket.CONFIG`) but
  not yet consolidated with every older reader.
- **Larger artifacts.** The published decision artifacts grew (gzipped
  board 35 → 51 KB, decisions 32 → 45 KB). `lean()` keeps only the curve
  summary.
