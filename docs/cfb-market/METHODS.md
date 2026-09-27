# CFB market intelligence — methods

The football model says what a game is worth. This layer says what the market is offering, how it got there, and
how good each price is for EdgeDesk's distribution. The decision engine (`football/cfb_decision/decision.js`,
docs/cfb-decision/DESIGN.md) decides whether to act. The integrity layer (`football/cfb_lab/integrity.js`,
docs/cfb-production/MARKET_INTEGRITY.md) decides whether a quote may be trusted at all. This layer reuses both and
never re-implements their rules.

- Audit and the canonical format: [`AUDIT.md`](AUDIT.md) · results: [`BACKTEST.md`](BACKTEST.md) · map: [`DELIVERABLE.md`](DELIVERABLE.md)
- Code: `football/cfb_market/market_intel.js` (production, ES5, browser + node), `football/cfb_market/run.js`
  (over the Lab ledger), `football/cfb_v2/research/v2/market_intel/` (research), `supabase/cfb_market.sql`.

## 1. Separation (brief §71, §76)

- The pure projection (`engine.js pure()`) never reads a sportsbook number. The market layer receives the frozen,
  deep-frozen pure object and reads `projected_margin`, `sigma`, `t_df` only.
- **Mandatory test** (`football/cfb_market/tests.js`, "PURE NEVER FOLLOWS MARKET"): `pure()` is computed, every
  market function is run under two very different markets (home -3 vs home -10), `pure()` is recomputed; the fair
  spread, projected score and win probability are byte-identical, the pure object is frozen, the market layer's
  source never assigns into a pure field, and the cover probability DOES change with the market.
- Research side: `v2.contract.assert_pure` refuses every market column (`tests_market.market_columns_can_never_be_pure_inputs`
  covers the new ones: `implied_margin`, `consensus_margin`, `market_adjusted_projection`, `line_velocity`,
  `coordinated_move_score`, `expected_close_margin`, `book_price_edge`).
- The weekly engine's shadow replay (`football/cfb_v2/research/v2/weekly/replay.py`) perturbs the season's market
  file from the freeze on (lines +7, totals +10) and requires the model inputs to be bit-identical.
- The market-informed CHALLENGER is a separate Lab model with its own label and a Postgres constraint that it is
  never role `pure` and never called the fair line.

## 2. Consensus snapshot (brief §4, §6)

`consensusSnapshot(quotes, asOf, kickoff)`:
1. **Selection** (the Lab's `marketAt`): each (source, book)'s latest ordinary pregame spread quote observed by
   `asOf` and within 36 h; provider averages drop out when a real book quotes.
2. **Integrity** (reused): `integrity.assessMarket` over the same set. A quote it finds invalid, quarantined, or a
   MAD outlier (three or more books) is listed and never enters the consensus. Its verdict (status,
   `actionable_status`, reasons) is carried unchanged.
3. **Staleness**: a book whose TRUE age (`integrity.quoteAgeH`: the older of our observation and the provider's
   update) exceeds `integrity.FRESHNESS.odds` (6 h inside 48 h of kickoff, else 36 h) is counted as stale and never
   moves the consensus.
4. **Numbers** over the fresh, valid books: median (the consensus: `consensus_margin = -median home line`),
   weighted median, mean, 20% trimmed mean, IQR and SD, best number and price for each side, median price per side
   (decimal space, the Lab's rule), and `consensus_uncertainty` = 0.5 pt for one book, else max(IQR/1.349,
   SD/sqrt(n)), plus 0.25 pt per stale book.

**Weights are inactive.** `book_quality_v1.json` carries information weights, but none of the weighted, trimmed or
Pinnacle-only rules beat the plain median on the DEV walk-forward by a margin the CIs support (BACKTEST §3); the
weighted median is computed and shown, the median is the consensus.

## 3. Openers and closes (brief §7, §8)

- The Lab's derived lines stay canonical for grading (write-once, `cfb_lab_open_v1` / `cfb_lab_close_v1`).
- `trueOpener` adds the brief's two definitions: the **first individual opener** of each book (its earliest ordinary
  quote), and the **first robust consensus opener** = the earliest snapshot with at least `min_books` (2) fresh,
  valid books from reliable sources whose IQR is at most 1.5 pts. It is computed from quotes observed by each
  snapshot's time, so a later quote can never replace it. A one-book market never has one.
- `closingLine` = the last valid consensus snapshot whose newest quote is inside [kickoff - 180 min, kickoff):
  closing consensus margin, median closing price per side, best closing number per side, quote count, timestamp;
  else the provider-declared close, labelled; else MISSING. The kickoff to anchor to is the Lab's authoritative
  kickoff (MARKET_INTEGRITY §7).

## 4. Movement, velocity, disagreement, stale lines (brief §9-11, §21, §35, §37, §38, §58, §59)

- **Movement** per snapshot: from open, from previous, raw and smoothed velocity (exponential smoothing,
  time constant 3 h: `v <- v(1-a) + a*raw`, `a = 1 - exp(-dt/3h)`), books moving and books moving with the
  consensus inside a 60-minute lookback, key-number crossings (onto / through / off 3, 7, 10, 14), dispersion
  change, and a class: `NO_MOVE`, `ONE_BOOK_MOVED`, `MARKET_MOVED` (the consensus moved over the window and at
  least two books, half the market, moved with it) or `SINGLE_BOOK_MARKET_MOVED` (cannot be told apart).
- **Coordinated move**: books changing their number in the same direction within 30 minutes;
  `coordinated_move_score = share of active books x min(1, median move / 0.5)`; labelled `COORDINATED_MOVE` at
  three or more books and half the market. Never "steam", never "sharp": prices do not identify bettors.
- **Resistance**: a number is `RESISTANCE` only after three approaches that retreat without crossing; otherwise
  `INSUFFICIENT_EVIDENCE`. No chart patterns.
- **Disagreement**: IQR <= 0.5 `AGREE`, <= 1.5 `MINOR`, above `HIGH` (the decision policy's 1.5); one book
  `UNKNOWN_SINGLE_BOOK`. High dispersion inflates market uncertainty (IQR/1.349) and lists candidate causes
  (stale quotes, a fast market, a provider conflict, differing views). It is never an edge.
- **Stale line** (`staleQuotes`): per book a deterministic score over three facts — true age beyond the odds
  limit; the other books' consensus moved >= 0.5 pt since this book's quote; two-thirds of the other books updated
  since. Two of three = `STALE`. A fresh book that simply disagrees is `DIVERGENT_NOT_STALE`; a quote integrity
  excluded is `INTEGRITY_EXCLUDED`. The score is labelled unvalidated.
- **Provider conflict**: the same book from two feeds within 60 minutes with different numbers: both are
  preserved, the difference and the likely fresher feed (newer provider/observation time) are recorded, >= 1 pt is
  major.
- **Stale-data failsafe**: the TRUE age of the newest usable quote against `integrity.FRESHNESS.odds_bet` (3 h,
  the decision policy's `stale_minutes` 180). Codes are integrity's: `ACTIONABLE`, `MARKET_STALE` (shown as
  "MARKET DATA STALE"), `MARKET_MISSING`, and a snapshot keeps integrity's `MARKET_DEGRADED` / `MARKET_INVALID`.

## 5. The key-number distribution (brief §14, §23-26)

EdgeDesk's distribution of the final home margin M for a game: the pure Student t (mean = the pure margin, the
frozen sigma and df) discretised to integers at k +/- 0.5, then
1. **no ties**: the discretised mass at 0 goes to the margins overtime games actually end on (DEV: 42% by 3, 21%
   by 7, 14% by 6, 11% by 1, 8% by 2, 3% by 8), half to each team;
2. **local key masses**: bin k gains Delta_k = (r_|k| - 1) P(k), paid by the integers within three points of it
   (shares 3:2:1 by distance, half on each side; an inner payer below 1 is replaced by the outer one). The CDF more
   than three points from a key is the t's own and the mean is (all but) preserved.

`r` is fit on DEV 2017-2023 (5,194 games with a frozen sigma; 204 overtime games) by ridge-regularised least
squares on the pooled landing counts at every |k| <= 35 (weight 1/observed count; ridge 0.01 x E_k (r_k - 1)^2,
pre-set). The redistribution operator is Laplacian-like and nearly singular for smooth patterns, so the ridge is
required: the exact solve gave r ~ 20 across 1-14. Individual r values are not interpretable (neighbours pay each
other); the resulting masses are. The mean and width stay the pure model's; the market never enters.

**Method choice (DEV walk-forward only)**, recorded in order:
1. A GLOBAL multiplicative reweighting (renormalised) matches the landing counts exactly, but it moves cover
   probabilities between key numbers (mean 1.8 pp at the close; at a pure margin of 6.2 it moved P(cover -6.5) by
   1.9 pp). Rejected on that ground before any betting result was looked at.
2. A +/-1 neighbour kernel was fit first; its exact solve was degenerate. The first selection rule (smallest
   cover-probability shift) would have chosen it; the rule was replaced before the alternate-ladder check was run.
3. **Rule used**: a method is eligible if it improves the push log loss at integer closing lines and does not
   worsen the alternate-line ladder log loss (the market-centred cover probability at close + d, d = +/-0.5 ...
   +/-3) with a CI above zero; the lowest ladder log loss wins. LOCAL won (ladder change +0.00003 [-0.00035,
   0.00044]; push change -0.0058 [-0.0120, 0.0001]).
4. **Holdout** (scored once): push log loss -0.0206 [-0.0347, -0.0073], cover log loss +0.0005 [-0.0008, 0.0018],
   ladder -0.0001 [-0.0007, 0.0005]. The key masses predict pushes better out of sample at no cost to cover
   calibration.

The same distribution drives, in JavaScript and Python identically (parity fixture `football/cfb_market/fixtures/parity.json`,
max difference 3e-13):
- **Half-point value**: the probability that changes class when a number moves half a point is the landing mass
  on the integer inside the step; its EV at -110 and its **price equivalent** (the price at the worse number with
  the same EV as -110 at the better number; `cents` on the continuous ladder -110 -> -10, -100/+100 -> 0,
  +105 -> +5). Market-centred: mean = the line, sigma = the median frozen sigma of games near that line.
- **Price vs point**: the exact EV of each quote under EdgeDesk's distribution (`comparePricePoint`,
  `bestEvQuote`); no rule of thumb.
- **Alternate lines**: every line from one distribution; the fair price is EV 0 with the push returning the
  stake; an offered alternate is judged on its EV only.
- **Price-adjusted implied margin**: the home margin at which a quote's no-vig probability (proportional de-vig,
  `decision.devig`) is fair under the key distribution centred there with the market's own width (sigma 15.705 =
  the DEV SD of margin - close). Makes -3 -120 and -3.5 +100 comparable.

Totals have no dominant key number (the most common final total carries 3.9%), so totals use the plain t.

## 6. Book quality: information vs price (brief §5)

- **Information**: for each book (2016-2019 closes, games with >= 5 books), the slope of the outcome residual
  (margin - the other books' median) on the book's price-adjusted deviation from that median. 1 = the book's
  disagreement is all information; 0 = noise; < 0 = stale or contrarian. Slopes are shrunk (empirical Bayes,
  DerSimonian-Laird between-book variance) toward their precision-weighted mean;
  `market_information_weight = max(0, shrunk slope)`, `consensus_weight = 1 + 2 x max(0, shrunk - mean)`.
- **Price**: hold, the share of games in which the book had the best number or the best price-adjusted number.
- **Accuracy**: closing MAE minus the leave-one-out consensus MAE; share of games off the consensus by >= 1 pt.
- Weights exist only for books in the 2016-2019 archive; the US books the Lab captures weigh 1 until their own
  timestamped history supports another number.

## 7. The challenger and the market residual (brief §42-44)

`market_adjusted_projection = market + w (pure - market)`, w by least squares on earlier seasons, clipped to
[0, 1]; market = the consensus opener at the Tuesday freeze (live: the consensus at the snapshot). A conditional w
(early season, reliability, QB unsettled, ensemble SD; pre-registered) is used only if it beats the single w on
the DEV walk-forward with a CI below zero (it did not). The market residual (margin - market) is regressed on
EdgeDesk's gap, with a walk-forward out-of-sample R^2, at the opener and at the close. The same w is the answer to
"how much information does the market hold beyond EdgeDesk".

## 8. Movement model and expected close (brief §27, §28, §68)

`expected_close = opener + b1 gap + b2 gap x [opener on 3/7/10/14] + b3 gap x early season`, fit walk-forward;
scored against "close = opener" by MAE, direction accuracy among lines that moved, and calibration by predicted
move. The production `expected_clv_pts` and `p_positive_clv` are the decision engine's artifact models
(`cfb_decision_calibration_v1`); this is the market-specific research check (key-number position, early season).

## 9. Bias audit (brief §75)

From each group's side (favourites, underdogs, home, road, P4/G5 in cross-tier games, each conference in
non-conference games, a PRE-REGISTERED list of national brands, spread buckets, totals): the market's cover rate
and residual at the close; EdgeDesk's mean error; the share of EdgeDesk's picks (vs the opener) that are the group's
side and their ATS against its other picks. A lean is "supported" only when the ATS CI of the group picks lies
above 50%. With 30+ group rows, about one statistic in twenty excludes its null by chance.

## 10. Replay, execution, timing and the ladder (brief §53-56, §65, §72-73)

- **Replay**: a decision at the Tuesday 12:00 UTC freeze sees only the consensus opener (assumed available then:
  an optimistic fill, the convention of v2/market.py and REDTEAM.md). The close is used only as the outcome-side
  benchmark or as the explicitly LATER execution.
- **Prices**: 2016-2019 real (the 5Dimes opening price of the opener bet; the median closing price of the books
  at the consensus close); otherwise ASSUMED -110, labelled on every table.
- **EV (market view)**: an entry's EV under the market's own closing distribution (key-number distribution centred
  on the consensus close, sigma 15.705): CLV in EV units, with no outcome noise. It is the primary quality measure;
  ATS and ROI are reported beside it.
- **Line shopping** (2016-2019 closes): consensus (median number, median price) vs one book vs the best number /
  best EdgeDesk EV / best price-adjusted quote among three books (5Dimes, Bovada, BetOnline: the enabled-books
  filter) and among all books.
- **Ladder** (fixed thresholds, never tuned on results): A1 |gap| >= 3; A2' pure cover p >= 0.57; A3' pure EV >= 9%
  at the actual price with key-number pushes; A4' EV >= 2% under the challenger mean (key numbers, the 14-pt review
  gap); A5 timing = A4' executed at the opener when the walk-forward expected close move is toward the side, else
  re-decided at the close. REGISTRATION 1 (cumulative arms, P >= 0.55, EV >= 3%) was fixed first and turned out
  degenerate (A1 = A2 = A3: once |gap| >= 3 the raw pure probability always clears them); registration 2 was fixed
  after that was seen and before any of its arms was computed. Both are reported. The OLD arm is the frozen
  stage-8 rule, which was selected on these same DEV seasons.
- **Latency**: `decisionLatency(observed, decided, stored)` -> `decision_latency_ms`; historically unmeasurable.

## 11. Events and words (brief §40, §60-62, §70, §80)

`marketEvents(prev, cur)`: MODEL_EDGE_APPEARS / DISAPPEARS (EV >= 3% when a price exists, else |gap| >= 3 as a
labelled proxy), STALE_PRICE, MARKET_MOVES_TOWARD_MODEL / AWAY (>= 0.5 pt), KEY_NUMBER_CROSSED, and
QB_NEWS_REPRICES_MARKET only when the news came after the previous state and before the move ("timing
consistent, not proof of cause"); each type at most once per 60 minutes. `informationEvent` records the market
before and after and an attribution of TIMING_CONSISTENT / NO_MOVE / MOVED_BEFORE_EVENT / INSUFFICIENT_DATA —
never CAUSED. `auditMarketLanguage` refuses "sharps are", "sharp/smart money", "syndicate", "steam move", "RLM
proves", "lock", "guaranteed"; Postgres refuses the same words in event and information-event details.

## 12. What the data cannot answer (and what is built anyway)

| question | why not knowable today | built |
|---|---|---|
| public betting %, handle, RLM | no ticket or money data exists | `reverseLineMovement` (inert), `cfb_market_public_betting` (never usable by a decision) |
| sharp action / who bet | prices never identify bettors | measurable language only; `COORDINATED_MOVE` |
| steam across books, velocity, books moving | archive has no intraday path; the Lab has one book | `coordinatedMoves`, `movement`, `lineVelocity` over the Lab ledger |
| line resistance (repeated touches) | same | `lineResistance` (opener-on-key stickiness is measured historically) |
| stale books, provider conflicts | one book, one feed per book live; no archive timestamps | `staleQuotes`, `providerConflicts` |
| 72/48/24/12/6/2 h timing, bet-now-vs-wait at 6/12/24 h | no timestamps before 2026 | `timingScorecard`, `waitComparison` over the Lab ledger |
| market maturity, time since opener | opener timestamps exist only live | `marketMaturity` (descriptive, `validated: false`) |
| information events vs the market | QB/injury timestamps exist only live | `informationEvent` |
| multi-book line shopping today | the Lab has one book | measured on 2016-2019 offshore closes (BACKTEST §8) |

## 13. Leakage (brief §76)

- Football model training: `assert_pure` refuses every market column (tests_leakage.py, tests_market.py).
- Decisions before close: `replay.arm_masks` reads only pre-decision columns; `tests_market.decisions_never_read_the_close_or_the_result`
  moves the close by 7 points and flips every result and checks that no decision changes.
- Movement features before their timestamp: the expected-close model is fit on seasons before the one it predicts,
  and the holdout's fit is capped at the last DEV season (`tests_market.expected_move_respects_the_training_cap`).
- Timing beyond the available time: every snapshot uses quotes observed by its own time and before kickoff
  (`tests.js`: "point in time"); Postgres refuses a snapshot, event or prediction at or after kickoff.
- The holdout is scored once (`tests_market.holdout_is_scored_once`).
