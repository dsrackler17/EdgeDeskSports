# Quote-level expected value and the alternate spread value engine

EdgeDesk prices every usable sportsbook quote, both sides, at its **exact
line, exact price and exact book**. It never prices a −110 reference, and it
never derives a probability from a spread gap. A decision attaches only to
the quote the decision layer actually evaluated. Every other quote is
priced, not decided.

## The pipeline

```
pure model (fair spread; the market never enters it)
  → outcome distribution (the champion's own margin PMF)
  → the exact quote (line, American price, book, capture time)
  → win / push / loss at that line
  → break-even = 1 / decimal
  → probability edge = cover − break-even
  → EV = win·(d − 1) − loss            (a push returns the stake: 0)
  → decision layer (separate; never inferred from EV)
```

`cover` is the no-push share `win / (win + loss)`, so `probability edge` and
`EV` always have the same sign. `fair decimal = (1 − push) / win`, which gives
the identity `EV = win · (d − d_fair)`.

| Piece | Where |
|---|---|
| Arithmetic, gates, ladders, sanity guards, history | `lib/edgedesk_quote_ev.js` (`window.EDQuoteEV`, UMD, no dependencies beyond `lib/research_core.js`) |
| CFB distribution | the champion's PMF from `football/cfb_p4/engine.js`, its shape conditioned **once** on the market spread and centred on the pure fair margin (`EDQuoteEV.cfbConditionedCover`, the same function `build.js` uses). One shape serves every alternate line, so the ladder is coherent. |
| NFL distribution | `football/engine.js` `dist.coverProbSpread('nfl', fair, t)`, keyed by EdgeDesk's own fair spread |
| CFB calibrated EV | the SHADOW calibrator the EV tournament promoted (`football/cfb_ev`), applied through the frozen engine (`lib/edgedesk_ev.js` `anchorOf` / `shiftedSide`); shown beside the raw EV, never in place of it |
| Page | `app.html`, the "QUOTE-LEVEL EXPECTED VALUE" block (the board's loaders sit beside `fbP4Ensure`) |
| Offline build / API | `football/cfb_terminal/build.js`: `board.json` rows carry `quote_ev`, `games.json` carries every priced quote and the ladder, `quote_ev.csv`, and `ev_validation.json` → `validation.quote_ev_buckets` |

## Availability: never 0.0% for "unknown"

EV is shown only when every gate passes. The first failure wins, and the page
prints `EV —` with the reason. The reasons are:

- `INVALID_GAME`
- `DATA_FAULT`
- totals and moneylines → `CALIBRATION`
- `NO_MODEL`
- `MODEL_VERSION`
- `ORIENTATION`
- `MARKET_INTEGRITY`
- `NO_LINE`
- `NO_PRICE` or `INVALID_PRICE`
- `QUOTE_TIME_UNKNOWN`
- `STALE` (the page's own `EDINTEL.quoteState` freshness)
- `LINE_UNSUPPORTED`
- `DISTRIBUTION_FAULT`

Research states change how an available EV is labelled:

- **INVESTIGATE** → `RAW PRICE EV … INTEGRITY CHECK NOT CLEARED`.
- **MARKET FAULT** → the EV is kept for audit only.

**Totals and moneylines** stay `UNAVAILABLE · probability calibration not
validated` until a calibration exists. There is no totals task in the
tournament, and the moneyline calibrator is `NOT_VALIDATED`. The code path is
ready: `EDQuoteEV.otherMarkets` prices them once `total_calibration.validated`
or a validated moneyline calibrator is supplied.

**NFL** gets RAW EV only. No NFL EV calibration exists, and no NFL decision
engine is published.

## Decisions (why "NO DECISION" and a quote EV can both be true)

Two different questions get two different answers:

- **Quote EV** is arithmetic at one exact quote.
- **Decision** is the decision layer's verdict, attached only to the quote
  that layer evaluated. That means the same side, line, book and (when known)
  price. The engine's `HOME`/`AWAY` and quote EV's `home`/`away` are matched
  without regard to case.

When the governed engine (`football/cfb_decision`) fails closed before
choosing a side (for example, the artifact was validated for a different
model version), the verdict belongs to the exact quote the EV engine
selected.

Every other quote reads `NOT_EVALUATED`. Its text is "The decision engine
evaluated X; this exact quote has not been decided on and does not inherit
that verdict."

"NO DECISION: no fresh two-sided priced quote" explains itself on the card.
The engine only decides on a fresh quote with both sides priced at one line
by one book, and the quote-level EV shown is arithmetic, not a decision.
Alternates never inherit the main-line decision.

## Surfaces

- **FBS board.** A pricing line under every game shows the best quote, cover,
  break-even, edge, raw EV, calibrated EV (CFB), quote age and the decision,
  or `EV —` with its reason.
  - New sorts: **Highest EV**, **Lowest EV** and **Freshest quote**. Games
    with no EV sort last.
  - Sorting is informational and never changes a research status.
- **Worth researching board.** An EV cell per candidate.
- **Game card, "Price evaluation · expected value":**
  - the full field grid;
  - fair odds, market odds and the price advantage in cents (push-aware);
  - the plain-language sentence;
  - RAW EV, uncertainty-adjusted EV and DECISION as three separate answers;
  - flags;
  - both sides;
  - a price-sensitivity table, where hypothetical prices are labelled "not
    offered by any book" and kept in their own table;
  - TOTAL EV and MONEYLINE EV, marked UNAVAILABLE.
- **Game card, "Alternate spread value".** The ladder (below).
- **VERIFIED MAJOR forensic rows.** These add the best quote, EV, calibrated
  EV and the decision.
- **NFL cards.** A "Price · expected value" row, with the card and ladder
  under a disclosure.
- **Exports.**
  - The CFB and NFL CSVs append `best_spread`, `best_price`, `best_book`,
    `best_quote_timestamp`, `model_cover_probability`,
    `model_push_probability`, `break_even_probability`,
    `probability_edge_pp`, `expected_value_pct`,
    `calibrated_expected_value_pct`, `model_fair_odds`, `ev_available`,
    `ev_unavailable_reason`, `ev_state`, `quote_decision_status`,
    `best_ev_team` and `ev_source`.
  - "EV quotes CSV" exports every priced quote.
  - `football/cfb_p4/export_csv.js` writes the same columns offline.
- **Journal.** A logged spread entry is priced once at save time and frozen
  (`snap_ev_*`, write-once in `supabase/personal_research.sql`). It matches
  a captured quote, or it is the reader's own typed quote
  (`USER_ENTERED_QUOTE`).
  - Personal analytics bucket entries by EV at entry, with no profit figures
    (the journal's rule).
  - ROI per bucket lives in the build's EV ledger
    (`validation.quote_ev_buckets`, with buckets <0, 0–2, 2–5, 5–10, 10–15
    and 15%+).

## Sanity guards

**Per quote:**

- `EV_OVER_25`, `EV_UNDER_NEG_50`, `ALT_EV_OVER_35`, `COVER_OVER_75`
- `LARGE_EV_LOW_RELIABILITY`, `LARGE_EV_QB_UNRESOLVED`,
  `LARGE_EV_STALE_MARKET`, `LARGE_EV_MARKET_FAULT`
- `BREAK_EVEN_MISMATCH`, `EV_INCONSISTENT` (checked against
  `research_core.expectedRoi`), `EV_EDGE_SIGN`
- `BOOK_MISMATCH`, `UNEXPECTED_PUSH`, `INTEGER_PUSH_MISSING`,
  `TAIL_UNVALIDATED`, `ORIENTATION_MISMATCH`

**Per ladder and game:**

- `COVER_NON_MONOTONE`, `ALT_DISCONTINUITY`, `CONTRADICTORY_PROBABILITY`
- `BETTER_LINE_AND_PRICE_ELSEWHERE`, `STALE_BETTER_PRICE`, `ALT_IMPLAUSIBLE`
- `BOTH_SIDES_POSITIVE`, `ARBITRAGE_CONDITION`

## The alternate spread value engine

- **Ladder.** One row per spread, showing the best price at that number. The
  other quotes at the number are kept for audit.
  - Columns: Spread, Best price, Book, Cover %, Push %, Break-even %, Edge pp,
    EV %, Fair odds, Quote age.
  - It sorts safest → most aggressive by default, and also by cover, EV,
    edge and price.
  - Each team has its own tab.
- **Value frontier.** These are the quotes that no other quote beats on both
  cover and EV. The rest are marked dominated, and a toggle switches between
  Frontier, Best per spread and All quotes.
- **MAX EV and SAFEST +EV.**
  - MAX EV is the largest raw EV.
  - SAFEST +EV is the highest cover among positive-EV quotes that carry no
    HIGH flag and sit inside the validated tail. The unvalidated candidate is
    shown with its reasons.
  - **No BEST BALANCE score is shown**, because no validated rule exists. The
    comparison card shows SAFER +EV / MAIN LINE / MAX EV and a PRICE TRADEOFF
    sentence. It never says "bet X because EV is highest".
- **Buying points.** Each adjacent step shows the cover gained, the push
  added or removed, the break-even cost, the juice in cents and the EV
  change.
  - The verdict follows the **EV change**, which counts the push a whole
    number adds. The no-push cover gain alone does not.
  - Key margins come from `research_core.KEY_NUMBERS` and show the model's
    mass beside the league's historical share
    (`abs_margin_key_mass`, e.g. 3 → 9.3%, 7 → 8.5%). Neither is hardcoded
    into a verdict.
- **Chart.** EV by spread on a single axis. Dominated quotes are hollow, and
  each point has a tooltip.
- **Tail safeguard.** The EV tournament's `alternate_line_domain` audits the
  calibrated slope at ±3 and ±7 pts from the market line. The slopes are:

  | Offset | Slope |
  |---|---|
  | −7 | 0.4432 (fail) |
  | −3 | 0.8875 |
  | +3 | 1.2386 |
  | +7 | 0.6702 |

  Inside the 0.6–1.6 band the validated domain is **±3 pts**. Beyond it, a
  quote is `LOW CONFIDENCE / TAIL CALIBRATION NOT VALIDATED` and cannot be
  SAFEST +EV. The NFL has no audit, so every NFL alternate is NOT_VALIDATED.
- **Alternate totals** are not captured and not priced (no validated totals
  probability).

### Alternate capture (provider audit and ingestion)

**The provider supports alternates.** The Odds API serves `alternate_spreads`
from the per-event endpoint only, one event per request. The bulk `/odds`
endpoint refuses them. The production capture function requests `h2h`,
`spreads` and `totals` only, so no alternate has ever been ingested.

`football/cfb_terminal/alternates.js` is the budgeted, opt-in capture for CFB
(`--league cfb`) and NFL (`--league nfl`). Its controls:

- **Window.** Games not yet kicked off, inside 72 h, nearest first, and at
  most 12 events per run per league.
- **Frequency.** At most once every 3 h. The clock moves only after a run
  that priced at least one event, so a run where every call failed does not
  lock the next one out.
- **Credits.** It stops below 25 remaining credits, and at once on a 401 or
  429. It requests one market and one bookmakers list (counted as one
  region), so each event costs 1 credit. The event index is free.
- **Deduplication.** Duplicated outcomes, strangers, quarter lines,
  impossible prices and out-of-bounds holds are all refused and counted.
  Nothing is repaired.
- **Change-only.** A (game, book, number) is appended only when its prices
  changed.
- **Storage.** The CFB ledger is
  `football/cfb_terminal/read/<season>/alternates.jsonl` (read by
  `build.js`). The NFL ledger is
  `football/markets/ledger/nfl/<season>/alternates.jsonl`.
- **Browser feed** (`football/markets/alternates_<league>.json`, schema
  `edgedesk_alternates_feed_v1`). It holds one quote per (book, side,
  number), each side in its own team's terms.
  - A polled event carries its poll time. A number the book pulled is gone.
  - An event not polled keeps its older time and ages into STALE.
  - `--feed-only` rebuilds the feed from the ledger without spending
    anything.
- **Provider-neutral schema.** Every quote carries `source`,
  `provider_event_id`, `book`, `home_line`, both prices, `observed_at`,
  `provider_updated_at` and `quote_id`. A second provider writes the same
  rows.
- **Scheduling.** The "Alternate spreads (opt-in, budgeted; CFB and NFL)"
  step in `.github/workflows/cfb-lab.yml` runs before the research terminal.
  **It is off** until the owner:
  1. adds an `ODDS_API_KEY` repository secret;
  2. sets the repository variable `READ_ALT_CAPTURE` to `on`.

  With the variable on and the key missing, the step prints a `::warning::`
  and a run-summary line and spends nothing.

Until the capture is enabled, every surface says: "Alternate spread pricing
is not captured yet … No alternate line is ever manufactured."

## Examples

### Live CFB quotes

This is the committed slate as built at 2026-09-28 12:15Z, eight minutes after
the DraftKings capture:

```
node football/cfb_terminal/build.js --now 2026-09-28T12:15:00Z --out <dir>
```

7 of 62 games have a fresh priced quote. The other 55 read `EV —`:

- 41 are stale;
- 8 fail the market integrity check;
- 6 have no priced quote.

| Game | Best-EV quote | Cover | Push | Break-even | Edge | Raw EV | Calibrated EV | Fair odds | Research | Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| Temple @ South Florida | South Florida −5.5 −112 DK | 75.1% | 0.0% | 52.8% | +22.2 pp | +42.10% | −4.08% | −301 | VERIFIED MAJOR | PASS · flags EV_OVER_25, COVER_OVER_75 |
| West Virginia @ Iowa State | Iowa State −3 −105 DK | 68.8% | 2.1% | 51.2% | +17.6 pp | +33.67% | −1.35% | −221 | INVESTIGATE (raw price EV, integrity check not cleared) | PASS · EV_OVER_25 |
| Michigan @ Minnesota | Minnesota +6 −112 DK | 63.9% | 0.5% | 52.8% | +11.1 pp | +20.88% | −4.57% | −177 | WORTH RESEARCHING | PASS* |
| Ohio @ Kent State | Ohio −4 −105 DK | 59.2% | 0.0% | 51.2% | +8.0 pp | +15.58% | −1.84% | −145 | WORTH RESEARCHING | PASS* · INTEGER_PUSH_MISSING |
| Pittsburgh @ Virginia Tech | Pittsburgh +3.5 −110 DK | 56.8% | 0.0% | 52.4% | +4.4 pp | +8.38% | −4.23% | −131 | WORTH RESEARCHING | PASS |
| UCF @ Houston | UCF +10.5 −108 DK | 55.9% | 0.0% | 51.9% | +4.0 pp | +7.70% | −3.42% | −127 | WORTH RESEARCHING | PASS |
| Virginia @ Florida State | Virginia −3 −108 DK | 53.8% | 2.7% | 51.9% | +1.9 pp | +3.49% | −3.41% | −116 | MARKET ALIGNED | PASS* |

\* PASS is the decision the EV engine reached on this exact DraftKings quote.
It comes from the build without fixture alternates. In the fixture build
below, the EV engine selected a fixture alternate for these three games, so
the DraftKings quote reads `NOT_EVALUATED` there, which is correct.

**Raw vs calibrated.** Every raw EV is large and positive, and every
calibrated EV is about minus the vig. The promoted CFB calibrator
(temperature, T ≈ 10⁶) puts the cover at the market line near 50%.
**The raw EV is what the model says. The calibrated EV is what the validated
out-of-sample record supports.** The page shows both, labelled, and the
decision layer governs action.

### Alternate ladders (three live games, TEST FIXTURE alternates)

No real alternate has been captured, so no real ladder exists. To exercise
the whole path, the same build was run with **fixture alternates** for the
three games above. Those alternates were:

- provider-shaped Odds API responses, "fixturebook";
- priced off a market-centred normal (σ 14.5) with a 4.5% two-way hold;
- parsed by `alternates.js`, then priced by the production champion curve.

The DraftKings rows are real. Every `fixturebook` price is **invented for the
demonstration**.

**Michigan @ Minnesota (Minnesota side).** EdgeDesk fair is Michigan −1.3;
DraftKings has Minnesota +6.

| Spread | Best price | Book | Cover | Push | BE | Edge pp | Raw EV | Cal EV | Fair | Tail | |
|---|---|---|---|---|---|---|---|---|---|---|---|
| +10 | −171 | fixturebook | 70.8 | 1.4 | 63.1 | 7.7 | +12.01 | −0.33 | −242 | NOT VALIDATED | frontier |
| +9 | −153 | fixturebook | 69.5 | 1.0 | 60.5 | 9.0 | +14.74 | −1.72 | −228 | validated | frontier |
| +7 | −122 | fixturebook | 66.2 | 3.1 | 55.0 | 11.2 | +19.74 | −3.95 | −195 | validated | frontier |
| +6.5 | −116 | fixturebook | 64.1 | 0.0 | 53.7 | 10.4 | +19.37 | −3.83 | −179 | validated | dominated |
| **+6** | **−112** | **DraftKings** | 63.9 | 0.5 | 52.8 | 11.1 | +20.88 | −4.57 | −177 | main line | frontier |
| +4.5 | +108 | fixturebook | 61.8 | 0.0 | 48.1 | 13.8 | +28.64 | −10.64 | −162 | validated | frontier |
| +3 | +127 | fixturebook | 54.9 | 2.2 | 44.1 | 10.9 | +24.20 | −9.46 | −122 | validated | dominated |

The comparison card reads:

- **SAFER +EV:** Minnesota +9 −153, cover 69.5%, raw EV +14.74% (cal −1.72%).
- **MAIN:** Minnesota +6 −112, cover 63.9%, raw EV +20.88%.
- **MAX EV:** Minnesota +4.5 +108, cover 61.8%, raw EV +28.64% (cal −10.64%).
- **Buying points:** +9.5 → +10 adds +1.0 pp cover plus 1.4 pp push for 9
  cents; EV falls 0.8 points, so the protection costs more than the model
  says it is worth. The key margin is 10 (model 1.4%, league 4.6%).

**Ohio @ Kent State (Ohio side).** EdgeDesk fair is Ohio −7.3; DraftKings has
Ohio −4.

- **SAFER +EV:** Ohio −1 −153, cover 67.1%, raw EV +10.32%.
- **MAIN:** Ohio −4 −105, cover 59.2%, raw EV +15.58%. It is *dominated* by
  −4.5 −104, because the champion PMF carries no mass at a 4-point margin
  (`INTEGER_PUSH_MISSING`).
- **MAX EV:** Ohio −6.5 +120, cover 54.9%, raw EV +20.86%.
- The EV engine selected Ohio −2.5 −129 (fixturebook), so the board's PASS
  sits on that row. Every other row reads NOT_EVALUATED.

**Virginia @ Florida State (Virginia side).** EdgeDesk fair is Virginia −4.2;
DraftKings has Virginia −3.

- **SAFER +EV:** Virginia −2.5 −116, cover 55.0%, raw EV +2.48%.
- **MAIN:** Virginia −3 −108, raw EV +3.49%.
- **MAX EV:** Virginia −4.5 +108, raw EV +5.42% (cal −9.49%).
- **Buying points:** −3 → −2.5 adds +1.3 pp cover, less 2.7 pp push, for 8
  cents; EV falls 1.0 points. The key margin is 3 (model 2.7%, league 9.3%).

The calibrated column is uneven across numbers (e.g. Michigan −4.5 reads
+1.26% calibrated while −5.5 reads −5.10%). That unevenness comes from the
champion PMF's lumpy integer masses carried through the calibrator. It is why
the tail audit and the LOW CONFIDENCE label exist.

## Tests

| Suite | What it pins |
|---|---|
| `tools/football/quote_ev.test.js` (182) | every price format; 50–60% at −110; pushes; fail-closed gates; sides and orientation; exact-quote association; pure-model independence; best line / price / EV; ladders, frontier, steps (including a push-driven step); the real tournament tail; sanity; per-quote decisions (engine case, re-priced quotes); history and buckets; parity with `research_core`, `edgedesk_ev`, `decision.js` and the pre-move `build.js` conditioned PMF (805 thresholds); totals / ML gating |
| `football/cfb_terminal/alternates.test.js` (47) | parse, refusals, the unchanged CFB fingerprint, change-only ledger, the browser feed (poll times, pulled numbers, first-seen), window / cap / interval / credit floor / 429 / failed-run clock, the CFB join, `--feed-only` |
| `tools/football/quote_ev_ui.e2e.js` (34, Chromium) | board pricing lines, sorts, the price card, the ladder and its toggles, alternates from a provider-shaped fixture through `alternates.js`, NFL cards, a 390 px phone |
| `football/cfb_terminal/tests.js` | on a fresh build of the real slate: EV identity at the stored price, null-with-reason when unavailable, the decision attached only to the evaluated quote |
| `tools/research/cockpit_ui.test.js`, `tools/football/fbs_board_ui.test.js`, `tools/app/game_research.test.js`, `tools/app/worth_researching_ui.test.js`, `tools/personal/*.test.js`, `tools/games/builder.test.js` | the card prices the captured quote (never a −110 reference), the export columns, the card fetches nothing of its own, no pick language, the journal snapshot is write-once, the workflow secret allowlist |

Run: `npm run football:ev:test` (the unit and capture suites),
`npm run football:ev:e2e` (the browser suite) and `npm test` (everything).
