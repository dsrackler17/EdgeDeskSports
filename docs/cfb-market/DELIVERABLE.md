# CFB market intelligence, price discovery and bet timing — the §84 deliverable

## Verdict

**Market Intelligence V1 does not earn control of production BET decisions.** It stays a Model Lab research and
shadow layer. The pure football model is untouched by it (tested), and nothing it computes changes a football
number, a status or a stake.

- **What it adds that holds up out of sample (holdout 2024-2025, scored once):**
  - the key-number distribution predicts pushes better than the pure t (push log loss −0.021 [−0.035, −0.007]) at
    no cost to cover calibration (+0.0005 [−0.0008, 0.0018]);
  - betting at the opener beats the final pre-kick price in the market's own closing view (+1.2 pp of EV
    [0.7, 1.7]; DEV +2.0 [1.7, 2.3]);
  - the market still moves toward EdgeDesk (0.08 pts per point of gap [0.05, 0.12]; DEV 0.14 [0.12, 0.16]);
  - opener disagreement between books predicts a larger opener→close move (>1 pt apart: 1.68 [1.55, 1.82] vs
    1.35 [1.26, 1.44] pts);
  - the pure model's P4-vs-G5 bias (it underrates the P4 side by 4.3 [2.2, 6.3] pts) and its bias against large
    favourites replicate.
- **What does not hold up:**
  - the market-informed selection that was positive in the market's own view on DEV (+1.5 pp EV [0.6, 2.4];
    +2.3 [1.1, 3.5] at real 2017-2019 prices) is not on the holdout (−0.3 [−1.7, 1.2]);
  - the market-informed challenger does not beat the opener (holdout MAE +0.009 [−0.03, 0.05]; DEV −0.008
    [−0.031, 0.016]);
  - no ladder arm has an ATS or ROI interval that excludes zero, on DEV or the holdout.
- **The largest measurable lever is line shopping.** At 2016-2019 closes, the best price-adjusted quote among
  ~20 books adds +6.3 pp of EV [5.9, 6.9] and +7.5% ROI [6.3, 8.7] over the consensus; three books add +2.4 pp and
  +2.7%; one book adds nothing. The Lab captures one sportsbook today, so this value is not yet available.
- **Recommendation (item 45):** keep V1 in SHADOW. Promote only the key-number push/alternate-line distribution,
  through the decision owner's governed change, as a replacement for the bucketed push table. Turn on multi-book
  capture before anything else.

This agrees with the decision system's own study (docs/cfb-decision/DELIVERABLE.md): no policy earns BET, WAIT is
disabled, the opener beats the close, and its market shrinkage w = 0.228 in logit space matches the challenger's
w = 0.227 in points found here independently.

## The 45 items

"decision system" = `football/cfb_decision/decision.js` + `cfb_decision_calibration_v1` + `cfb_decision_policy_v1`
(docs/cfb-decision/). "integrity" = `football/cfb_lab/integrity.js` (docs/cfb-production/MARKET_INTEGRITY.md). Section
numbers in BACKTEST.md / METHODS.md.

| # | item | where | finding / status |
|---|---|---|---|
| 1 | odds-infrastructure audit | AUDIT.md | Five sources. The archive has per-book closes 2006-2025, with prices to 2019. There is one opener book per era and no timestamps. The live Lab holds 846 quotes, one sportsbook (DraftKings), 116 priced. |
| 2 | normalized market schema | AUDIT.md §4; `canonicalQuote`; view `cfb_market_quotes_canonical` | The Lab quote row is canonical; side-level fields are derived. `home_market_margin = -home_line`. Sign tests in JS, SQL and Python. |
| 3 | immutable quote history | reused: `cfb_lab_market_quotes` (append-only), Lab de-dup + heartbeats, integrity quarantine | Nothing overwritten. The new market tables are append-only too (SQL test). |
| 4 | consensus methodology | METHODS §2; `consensusSnapshot`; BACKTEST §3 | The consensus is the median of each (source, book)'s latest quote. Stale books and integrity-excluded quotes never move it. Weighted, trimmed and Pinnacle-only rules all tie the median (±0.012 pts, every CI includes 0). |
| 5 | book-quality methodology | METHODS §6; `books.py`; `book_quality_v1.json` | Information and price quality are kept apart. The pooled information slope is 0.09 [−0.16, 0.35]: disagreement between books at the close is not demonstrably information. Empirical-Bayes weights span 1.0-1.35 and are inactive. |
| 6 | opener definition | METHODS §3; `trueOpener` | Two openers are recorded: each book's first individual opener, and the first robust consensus opener (≥ 2 fresh valid books within 1.5 pts IQR, point in time, never replaced). Grading keeps the Lab's `cfb_lab_open_v1`. |
| 7 | close definition | METHODS §3; `closingLine` | The last valid consensus snapshot within 180 min of kickoff: margin, prices, best numbers, count, timestamp. Falls back to the provider-declared close, then MISSING. The Lab's `cfb_lab_close_v1` stays canonical for grading. |
| 8 | movement engine | METHODS §4; `movement`, `snapshotSeries` | Reports from-open and from-previous moves, books moving, key crossings, direction and dispersion change. Classes: NO_MOVE, ONE_BOOK_MOVED, MARKET_MOVED, SINGLE_BOOK_MARKET_MOVED. Historical: 88% of lines move; mean \|move\| 1.73 pts. |
| 9 | market velocity | `lineVelocity` (smoothed pts/h, books moving the same way, time since first move, size) | Live only: the archive has no path. |
| 10 | dispersion model | `marketDisagreement`; BACKTEST §3-4 | Dispersion inflates market uncertainty and is never an edge. Closing dispersion does not predict the size of the market's error. Opener dispersion predicts the size of the move (2023 DEV and holdout). |
| 11 | stale-line detection | `staleQuotes` (deterministic, 2-of-3 rule; DIVERGENT_NOT_STALE kept apart) | Not validatable: no timestamped multi-book history. In the archive, off-consensus rates at the close range from 0.4% to 29% by book. |
| 12 | model-vs-market gap | `modelMarketGap`; BACKTEST §5 | Signed, absolute, toward, favourite/underdog. DEV mean \|gap\| is 3.08 pts; the model sides with the underdog in 53.7% of games. |
| 13 | vig removal | **decision system** `devig` (proportional, overround reported); capture: Shin for multi-way | Reused; the market layer's implied margins use it. |
| 14 | break-even math | **decision system** `breakEven` (exact at any price) | Reused. |
| 15 | EV engine | **decision system** `decideQuote` / `expectedValue` (push-aware) + `evAt` on the key-number distribution | The key-number distribution supplies line-exact win/push/loss. |
| 16 | price-edge system | `modelEdgeVsPriceEdge` (model_edge vs book_price_edge, optionally price-adjusted); `bestEvQuote`; decision per-book statuses | Brief example reproduced (0.5 model edge, 1.0 price edge). |
| 17 | key-number research | BACKTEST §1; `keynumbers.py` | \|margin\| = 3: 10.1% [9.3, 10.8]; 7: 8.8%; 10 and 14: 4.5%. The rate varies with spread size (P(3) 14.1% at ≤ 3 pts vs 2.5% above 21; p < 0.001) and overtime (46.5% of OT games end by 3). It does not vary by era (p = 0.44), OT-rule era (p = 0.37) or total (p = 0.10). |
| 18 | half-point valuation | BACKTEST §2; `halfPointValue` | On 3: 13-14 cents. On 7: 12-13. On 10: 8. On 14: 9. On 17: 8. On 21: 10. Off key numbers: 2-5 cents. Books price 3 and 7 at about half the empirical landing mass (4.0% vs 7.5%): a lower bound (cross-book pairs mix opinions). |
| 19 | alternate-line pricing | `altLinePrices`; BACKTEST §2 | Every line comes from one distribution, and offered alternates are judged on EV only. The alternate-line ladder is calibrated (DEV walk-forward and holdout). |
| 20 | market-movement model | `movement.expected_close`; BACKTEST §4 | Direction is right 58.9% [57.2, 60.6] of the time when the line moves. MAE does not beat "close = opener" (+0.020 [−0.004, 0.045]), and predicted moves are 1.5-1.8× too large. The production CLV models are the decision system's. |
| 21 | CLV prediction | **decision system** `p_positive_clv` (AUC 0.559), `clv_magnitude` | Research complement here: the market absorbs 0.14 pts per point of gap on DEV, least early in the season (0.05) and least in P4-vs-G5 games (0.05). |
| 22 | bet-now/wait logic | **decision system** `timing` (WAIT disabled by policy v1); `waitComparison`; ladder A5 | WAIT never triggers historically: the expected move is always toward the model's side. The opener beats the close (see the verdict). |
| 23 | target-entry calculation | **decision system** `priceTargets` (bettable-to line and price, ideal entry) | Reused. `priceForEv` / `halfPointValue` give the exact price equivalents. |
| 24 | market maturity | `marketMaturity` (descriptive, `validated: false`) | Cannot be validated before timestamped openers accumulate. |
| 25 | market-adjusted challenger | `challenger.py`; `challenger_v1.json`; `challengerMargin`; `cfb_market_predictions` | DEV walk-forward: hybrid − opener MAE −0.008 [−0.031, 0.016]. Holdout: +0.009 [−0.03, 0.05]. The pure model is worse than the opener by 0.25 (DEV) and 0.27 (holdout). It remains a separate Lab challenger. |
| 26 | learned market weighting | BACKTEST §6 | w(pure) is 0.23 at the opener and 0.09 at the close. The market's weight rises toward kickoff (−0.14 [−0.21, −0.08]). w = 0 in weeks 0-3 and 0.57 late in the season. The conditional w is not better. |
| 27 | edge segmentation | BACKTEST §5 (absorption by segment), §7 (bias), §8 (ladder); **decision system** POLICY.md | No segment was cherry-picked. The groups were fixed in advance and multiplicity is stated. |
| 28 | no-bet zone | **decision system** (PASS_PRICE / PASS_INSUFFICIENT_EV; the BET region of policy v1 is empty) | In the market's own view, entry EV is negative or indistinguishable from zero in every arm except A4' on DEV, and A4' does not replicate on the holdout. PASS is the norm. |
| 29 | staking constraints | **decision system** `stake` (flat; ≤ 0.25 Kelly, hard cap) | Reused. |
| 30 | correlated exposure protections | **decision system** `applyExposure` | Reused. |
| 31 | historical market replay | `replay.py`; METHODS §10 | Point in time: the opener at the Tuesday freeze, with the close used only as the benchmark or as the later execution. `arm_masks` never reads the close (tested). |
| 32 | execution simulation | `replay.py` | Real prices 2016-2019 (the 5Dimes opener's own price; the median closing price). ASSUMED −110 otherwise, labelled. |
| 33 | CLV reporting | `clvScorecard`, `clvBySignal`; **decision system** results; BACKTEST §8 | Side-adjusted points, positive rate, mean, median, distribution, and price CLV at the same number. |
| 34 | timing analysis | BACKTEST §8; `timingScorecard` (OPEN / 72-2 h over the Lab ledger); `waitComparison` | Historically only opener vs close is measurable; the opener wins. Horizons fill in as the Lab records. |
| 35 | decision policy | **decision system** (`cfb_decision_policy_v1`) | The market layer supplies inputs only (key-number EV, integrity verdict, movement). |
| 36 | bias audit | BACKTEST §7, §9; `bias.py` | The pure model underrates favourites (+0.62 [0.18, 1.07] pts, growing to +1.90 at 21.5+) and P4 sides against G5 (+3.35 [2.17, 4.51]). Both replicate on the holdout (+0.93, +4.26). The G5 lean (62.6% of picks) is not supported: G5 picks go 48.6% ATS vs 59.4% for its P4 picks. The market's own biases do not replicate. |
| 37 | leakage audit | METHODS §13; `tests_market.py`; `tests.js`; the weekly replay | Every point-in-time rule has a test that fails if it breaks. |
| 38 | database migrations | `supabase/cfb_market.sql` | New tables: consensus snapshots, events, book quality, predictions, provider conflicts, information events and public betting. New views: the Lab panel and the canonical quotes. Reused tables are listed in the file header. Tested on real Postgres. |
| 39 | Model Lab integration | `football/cfb_market/run.js` (panel + four ledgers); view `cfb_market_lab_panel`; **decision system** `cfb_decision_lab_view` | The runner covers CURRENT, BEST PRICE, MODEL EDGE (gap), MOVEMENT SINCE OPEN and TOWARD MODEL. EV, EXPECTED CLV, BET NOW/WAIT/PASS, BETTABLE TO and the CLV RECORD come from the decision views, joined by game_id. Not yet wired into `cfb-lab.yml` (integration notes). |
| 40 | tests | see Tests | JS 129, SQL 44, Python 19 (16 synthetic + 3 artifact). |
| 41 | files/functions changed | see Files | New files only. |
| 42 | old vs new market-decision backtest | BACKTEST §8-9 (OLD = the frozen stage-8 rule) | The OLD rule's 60.3% DEV ATS is in-sample (selected on DEV), and its market-view EV is +0.3% [−1.0, 1.7]. It is inert on the holdout (1 bet). The new arms are pre-registered. Neither earns promotion (§82: CLV and price quality do not improve on the holdout). |
| 43 | shadow-mode implementation | **decision system** `shadow.js` (CURRENT vs CHALLENGER per quote) + `run.js` (market snapshots, events, challenger margins; append-only, deterministic) | `run.js` is dry-run by default; `--write` appends. |
| 44 | remaining limitations | below | |
| 45 | production promotion recommendation | Verdict; below | Keep V1 in SHADOW. Promote only the key-number push/alternate distribution, via the decision owner. |

## Headline tables (details and CIs: BACKTEST.md)

| key number | DEV share of games | half point worth (cents at −110, fav / dog) |
|---|---|---|
| 3 | 10.1% [9.3, 10.8] | 13.4 / 13.8 |
| 7 | 8.8% [8.0, 9.5] | 12.9 / 12.5 |
| 10 | 4.5% [4.0, 5.0] | 8.3 / 7.9 |
| 14 | 4.5% [4.0, 5.0] | 9.0 / 9.0 |
| 17 | 3.5% [3.1, 4.0] | 8.3 / 8.5 |
| 21 | 3.9% [3.4, 4.4] | 10.2 / 10.4 |

| book weighting (2016-2019 closes) | result |
|---|---|
| Pinnacle MAE − the other books' median | +0.002 [−0.012, 0.016] |
| results side with Pinnacle when it differs by ≥ 0.25 | 51.9% [49.3, 54.5] |
| pooled information slope of book disagreement | 0.09 [−0.16, 0.35] |
| close vs opener (MAE) | −0.147 [−0.228, −0.065]; the move is fully information (0.98 [0.71, 1.24]) |

| challenger vs pure vs market (MAE, DEV 2017-2023) | MAE − opener |
|---|---|
| pure | +0.247 [0.123, 0.374] |
| hybrid (w walk-forward) | −0.008 [−0.031, 0.016] |
| close (not available at the freeze) | −0.124 [−0.182, −0.059] |

| replay (DEV; holdout) | EV in the market's closing view | CLV pts | ROI |
|---|---|---|---|
| every game, model side, at the opener | −2.5%; −3.5% | 0.43; 0.25 | −1.9%; −3.2% |
| A4' market intelligence (EV ≥ 2% under the challenger) | **+1.5% [0.6, 2.4]; −0.3% [−1.7, 1.2]** | 0.87; 0.44 | −0.9%; −0.3% (CIs ±8-12 pp) |
| opener minus close, same side | +2.0% [1.7, 2.3]; +1.2% [0.7, 1.7] | | +2.3% [1.3, 3.3]; +0.6% [−1.1, 2.2] |
| line shopping, best of ~20 books vs consensus (2016-2019) | +6.3 pp [5.9, 6.9] | +0.55 pts | +7.5% [6.3, 8.7] |

## Tests

| suite | command | result |
|---|---|---|
| market JS (synthetic known answers; Python parity; the mandatory pure-model separation test; the live Lab ledger; the runner) | `node football/cfb_market/tests.js` | ALL GREEN 129 passed, 0 failed |
| market SQL (real Postgres) | `node football/cfb_market/sql.test.js` | ALL GREEN 44 passed, 0 failed |
| market research | `python3 -m v2.market_intel.tests_market --fast` / without `--fast` | 16 / 19 passed |
| unchanged, still green | `node football/cfb_lab/tests.js` (275), `node football/cfb_decision/tests.js` (98), both `sync_supabase.js --dry-run` | green |

## Files (new only)

- `football/cfb_market/market_intel.js` exposes `EDCfbMarket`. It needs `EDCfbDecision` and `EDCfbIntegrity`.
  - Canonical quotes and key numbers: `canonicalQuote`, `sideToHomeMargin`, `keyPmf`, `outcomeProbs`, `evAt`,
    `fairPrice`, `priceForEv`, `keyNumbers`.
  - Price and line comparison: `halfPointValue`, `altLinePrices`, `comparePricePoint`, `bestEvQuote`,
    `impliedMargin`.
  - Consensus and movement: `consensusSnapshot`, `snapshotSeries`, `trueOpener`, `closingLine`, `keyCrossings`,
    `movement`, `lineVelocity`, `coordinatedMoves`, `reverseLineMovement`, `lineResistance`,
    `marketDisagreement`.
  - Quote quality: `providerConflicts`, `staleQuotes`, `staleDataFailsafe`.
  - Model vs market: `modelMarketGap`, `modelEdgeVsPriceEdge`, `keyNumberCrossingAlert`, `priceDeterioration`,
    `doNotChase`.
  - Alerts and review: `marketEvents`, `contradictionAlert`, `largeGapChecks`, `informationEvent`,
    `marketMaturity`.
  - Challenger and latency: `challengerMargin`, `decisionLatency`.
  - Scorecards: `clvScorecard`, `clvBySignal`, `timingScorecard`, `waitComparison`.
  - Output: `auditMarketLanguage`, `marketCard`.
- `football/cfb_market/run.js` (`build`, `write`, `plan`), `tests.js`, `sql.test.js`, `fixtures/parity.json`,
  `artifacts/{key_numbers_v1,book_quality_v1,challenger_v1}.json`.
- `football/cfb_v2/research/v2/market_intel/`: `data.py`, `keynumbers.py`, `books.py`, `movement.py`,
  `challenger.py`, `bias.py`, `replay.py`, `report.py`, `tests_market.py`.
  - Outputs go to `$CFB_V2_OUT/market_intel/`. `holdout.json` was scored 2026-09-27T16:53:10Z; a re-run is refused.
- `supabase/cfb_market.sql`.
- `docs/cfb-market/{AUDIT,METHODS,BACKTEST,DELIVERABLE}.md`. BACKTEST.md is generated.

## Integration notes

- **Model Lab:** add one step to `.github/workflows/cfb-lab.yml` after `market`:
  `node football/cfb_market/run.js --write`.
  - It writes `football/cfb_market/ledger/<season>/{snapshots,events,conflicts,predictions}.jsonl`, append-only,
    with deterministic ids; a re-run is a no-op.
  - Add a mirror of those four files into `supabase/cfb_market.sql`'s tables. `run.plan()` gives PostgREST-ready
    rows; the SQL test inserts them.
  - The admin page can show `cfb_market_lab_panel` beside `cfb_decision_lab_view`.
- **Decision engine:**
  - `market_intel.keyPmf` + `outcomeProbs` can replace `decision.pushProb`'s bucket table (the push probability
    at the exact line and the pure mean). That is a decision-owner change through a new calibration/policy
    version, and its parity fixture already exists.
  - `consensusSnapshot(...).integrity` is exactly the `integrity.assessMarket` verdict `decideGame` computes, so
    passing it avoids a second computation.
- **Multi-book capture:** the Odds API path (`capture` → `cfb_lab_ingest_quotes` → `sync_supabase.js` pull) is
  built and fail-soft, but has delivered no quotes to the ledger. Enabling it is the single change that makes
  line shopping, stale-book detection, steam, provider conflicts and the timing horizons measurable.

## Remaining limitations (item 44)

- There are no historical opener timestamps and no intraday path. Timing beyond opener vs close, velocity,
  resistance, steam and stale books are live-only.
- There are no prices after 2019. The DEV 2021-2023 rows and the whole holdout are graded at an ASSUMED −110.
- There is one live sportsbook, so every live market is `MARKET_DEGRADED` (integrity) and nothing live is
  actionable.
- Book weights come from 2016-2019 offshore books; the US books the Lab captures weigh 1.
- The key-number multipliers are pooled over all spreads. The landing rate varies strongly with spread size,
  handled only through the pure mean and sigma.
- Public betting data does not exist, so RLM is inert.
- The line-shopping value assumes access to every archived book at its closing price. A real bettor's enabled
  books and limits are fewer (the 3-book row is the realistic floor).
- The research consensus in the archive uses its own feed-error screen (a book ≥ 10 pts from the game's median).
  The production path uses integrity.js.

## Contradictions and corrections found

1. **decision.js `auditLanguage` flags the brand name.** `/value|edge|advantage/i` matches "EdgeDesk", so "the
   market moved toward EdgeDesk" is reported as "claims value without a supporting number". `auditMarketLanguage`
   neutralises the brand before delegating. The decision owner should anchor the pattern (`\bedge\b`).
2. The brief's snapshot says 604 quotes and zero prices. The ledger now has 846 quotes, 116 of them priced
   (ESPN's DraftKings rows). There is still one sportsbook.
3. The brief cites `docs/cfb-weekly/REPLAY.md`, which does not exist. The market-perturbation replay is
   `football/cfb_v2/research/v2/weekly/replay.py`.
4. "MARKET DATA STALE" (brief §59) is shown as display text only. The stored code is integrity's `MARKET_STALE`, and
   Postgres refuses any other actionable code.
5. REDTEAM §12 reports 0.202 pts of move per point of gap (hardened, DEV); this study finds 0.141 [0.122, 0.159].
   The populations differ: this study excludes sign-flipped openers and opener→close jumps over 14 pts, and uses
   the V2.1 build. The direction and the conclusion agree.
