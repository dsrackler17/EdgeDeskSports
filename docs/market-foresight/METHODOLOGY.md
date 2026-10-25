# Market Foresight — methodology mf-v1

The rules `lib/edgedesk_foresight.js` applies. They are frozen in
[`research/foresight/methodology/mf-v1.json`](../../research/foresight/methodology/mf-v1.json).
That file was committed before any measurement was computed, and its sha256 is in
[`FROZEN.json`](../../research/foresight/methodology/FROZEN.json). The worker refuses to
compute a version whose file no longer has its frozen digest, and the database refuses a second
digest under the same version. A changed rule is a new version (`mf-v2`); the results of earlier
versions are kept beside it.

**Question.** Which forecasts, and which observed venues, preceded subsequent market movement?

**Tiers** (the repository's vocabulary, unchanged):
- **T0 Observed**: venue prices and forecasts exactly as recorded.
- **T2 Computed**: the measurements below.
- **T3 Experimental**: the incremental-information check.

## 1. What it says, and never says

**It says:**
- "Forecast preceded observed movement."
- "First observed among tracked venues."
- "Market moved toward this forecast."
- "Timing unresolved at available sampling resolution."

**It never says:**
- that a model caused a move;
- who led the whole market (only the tracked venues are observed);
- that convergence toward a forecast means the forecast was right about the outcome;
- that a timing advantage is a profitable or executable trade;
- that this is the first or only product of its kind.

## 2. Sources

| Source | Where | Time used | Evidence label |
|---|---|---|---|
| EdgeDesk models | `performance/ledger/forecasts/<sport>-2026.jsonl` (hash-chained; a chain that does not verify is refused) | `capture.captured_at`, the moment the ledger recorded the published number. It is the later, conservative bound; `model.predicted_at` is shown beside it | `ledger_captured` (eligible) for `ledger_capture` rows. `import:*` rows carry `recorded_at` from git history: `reconstructed_from_git`, never eligible and never drawn on a time axis |
| Model Collective | `collective.projections` (service role, read only) | `received_at`, stamped by the server | `server_received`. Only `data_origin = live`, `resolution_status = resolved` rows received before the lock (kickoff − 30 min) are eligible |
| DraftKings | `record/football/quotes/<sport>_2026.jsonl` (ESPN's DraftKings prices, both sides) | `observed_at`, the collector's read time. No provider update time exists, and none is invented | — |
| Kalshi | `public.kalshi_price_snapshots` and `kalshi_game_links` (service role, read only) | `captured_at`, the collector's run time. `last_price` carries no trade time | — |

## 3. Comparable contracts

The contract key is sport, event, phase (pregame), measure, market, selection, orientation,
period (full game), threshold, overtime and tie treatment. Two measures exist, and they never
mix:

- **Line points.** A forecast's fair home line against DraftKings' home line
  (negative = home favoured), and a fair total against DraftKings' total. A line change is
  movement in this measure.
- **Probability.** P(home team wins, full game including overtime), compared only across
  exactly matched outcome contracts:
  - the forecast's `p_home` / `home_win_prob`;
  - DraftKings' moneyline de-vigged;
  - Kalshi's home-team YES mid. Kalshi's home probability is never derived from the away
    team's market.

  A spread or total cover probability belongs to one threshold. It is shown as its own series
  and never spliced into another.

A point forecast is never read as a probability of covering a threshold, because no source
supplies a documented predictive distribution.

**Settlement.** Two probability contracts are compared only when their overtime and tie
treatment are compatible and the venue's profile is verified.

| Profile | NFL | CFB |
|---|---|---|
| DraftKings moneyline | overtime included, tie = push | overtime included, no tie possible |
| EdgeDesk `p_home` (from `forecast.settles`; missing = undocumented) | two-way, conditional on no tie | no tie possible |
| Collective `home_win_prob` | two-way, conditional on no tie | no tie possible |
| Kalshi game winner | **unverified** | **unverified** |

Kalshi stays unverified until an operator reads a series' `rules_primary` text and records a
profile for that text's sha256 (`mf_admin_verify_settlement`). If Kalshi changes the text, the
new text needs a new record. Postponed, cancelled and forfeited games are excluded everywhere,
so cancellation rules never decide a comparison.

## 4. Prices

- **Sportsbook.** Multiplicative two-way de-vig, using both sides of the same observation. With
  one side missing, an invalid price, or an overround outside [0, 0.2], the observation keeps
  its raw prices and is flagged, and no fair probability is computed.
- **Kalshi quotes.** Bid, ask, last trade, top-of-book sizes, volume and open interest are kept
  separately. Metrics use the **YES mid**, a research reference and never an executable price,
  and only when the quote is two-sided with a spread of at most 6¢ (`kalshi_rule('max_spread')`).
- **Kalshi last trade.** It is "fresh" only when volume rose since the previous snapshot,
  otherwise "stale" (or "unknown"). It is never used as a quote.
- **Kalshi depth.** Depth beyond the top of the book is not recorded, and missing sizes are
  flagged.
- **Fees.** None are applied. The repository's Kalshi fee schedule is UNVERIFIED, so no
  execution cost is computed anywhere.

## 5. Timing

- **When a change happened.** In (the last observation of the old value, the first
  observation of the new value]. The interval is never narrowed.
- **Coverage gap.** Consecutive observations further apart than the collector's own rule
  allows:
  - DraftKings: the heartbeat due time (6 h, or 50 min inside 3 h of kickoff) plus 90 minutes
    for a late run;
  - Kalshi: 20 minutes.

  Nothing is carried across a gap, and an interval spanning one is flagged.
- **Ordering.** Asserted only when intervals do not overlap. An overlap is UNRESOLVED, never
  a forced winner.

## 6. One forecast against one venue

**The unit.** It is the **first eligible published forecast** per (source, model, model version,
event, market, venue). Eligibility is decided on the forecast side only:
- publication evidence;
- published before the cutoff;
- live origin;
- resolved to a game;
- a value in range;
- a documented settlement, for probabilities.

A unit whose market evidence is missing is excluded with its reason. The job never moves on to
a later revision that happens to have better market data. Revisions are shown on the timeline
and never measured.

**The baseline and the close.**
- **M0**: the latest observation at or before publication that is still current under the
  venue's gap rule and carries a comparable value. It is never a later quote.
- **C**: the venue's last pregame observation, valid only within 120 minutes of kickoff
  (DraftKings) or 10 minutes (Kalshi). It is never replaced by an earlier one.

With F the forecast:

| Measure | Definition |
|---|---|
| Disagreement | F − M0 |
| Closing convergence | \|M0 − F\| − \|C − F\| (positive: the close was closer to the forecast) |
| Directional movement | sign(F − M0) × (C − M0) (positive: toward the forecast; can exceed \|F − M0\| on an overshoot) |
| Horizon movement | sign(F − M0) × (M_h − M0) at 1, 6 and 24 hours after publication; a horizon past kickoff is censored, a stale one unavailable |
| Qualifying move | the first observation after publication whose displacement toward F reaches 0.5 pts (spread, total) or 0.02 (probability) **and** still does at the next observation (or is the closing observation). A crossing undone at the next observation is flicker |
| Time to that move | its interval measured from publication, as a lower and an upper bound (never a midpoint) |
| Precedence | PRECEDED when an observation after publication still showed the unmoved market; UNRESOLVED when the move's interval straddles publication |
| Overshoot | sign(F − M0) × (C − F) > 0 |
| Reversal | a qualifying move whose close no longer reaches the threshold |

**Outcome classes:**
- TOWARD_HELD
- TOWARD_REVERSED
- NO_QUALIFYING_MOVE
- MOVED_AWAY (closed at least the threshold away)
- NO_MATERIAL_DISAGREEMENT (|F − M0| below the threshold). These units are counted, never
  dropped.

## 7. Venue lead–lag (DraftKings and Kalshi, probability only)

**Moves.** From an anchor (the first comparable observation), a move is the first observation
at least 0.02 away, confirmed by the next observation or by being the last pregame one. The
anchor then moves to it. An unconfirmed crossing is flicker and leaves the anchor where it was.

**Pairing.**
- Moves are taken in order of (interval start, interval end, venue).
- Each is paired with the earliest unpaired same-direction move of the other venue within
  180 minutes either side.
- A move is paired at most once.
- There is no retrospective choice of the pairing that tells the better story.

**Ordering.**
- LEADER when one interval ends before the other begins, with the lead time as an interval.
- TIE when the intervals are identical.
- UNRESOLVED otherwise.
- An unpaired move is UNMATCHED when the other venue covered the window, and
  INSUFFICIENT_COVERAGE when it had a gap.

**Segments.** By sport and time before start (<1 h, 1–6 h, 6–24 h, >24 h).

**Label.** "First observed among tracked venues more often" needs at least 20 resolved pairs
and a Wilson 95% lower bound above 0.5. This is temporal precedence only: both venues may be
reacting to a third source or to public news.

## 8. Collective consensus

**Membership** is strictly as of each evaluation time (48, 24, 6 and 2 hours before kickoff):
- one vote per model: its latest eligible forecast published by then;
- a forecast withdrawn later still counts before its withdrawal;
- nothing published later is read;
- at least three contributors are needed.

**What is reported:**
- the equal-weight mean, with the median beside it;
- the spread of views: sd, IQR, minimum and maximum;
- shared model families only where they are recorded.

Contributors are not assumed to be independent. The membership is hashed and stored with
every consensus unit, and it is measured by the same rules as any model.

## 9. Uncertainty and summaries

- **Summaries.** One per (source, model, version, sport, market, venue, forecast horizon
  bucket), plus "all buckets". There is never a pool across sports, markets or venues, and
  never a composite score.
- **Proportions.** Wilson 95%.
- **Means and medians.** A percentile bootstrap, 95%, 2,000 resamples, resampling events, with
  a seed derived from the methodology version and the summary group, so the same data give the
  same interval.
- **Sample thresholds.** No interval below n = 10. Below n = 5 a summary reads "insufficient
  evidence".
- **Denominators** are explicit: measured, excluded by reason, material, closes closer (and
  equal), qualifying moves, preceded and unresolved, time-to-move bounds, and no-move, reversal
  and moved-away rates.

## 10. Incremental information (T3, research)

Does disagreement (F − M0) predict later movement (C − M0) beyond the market at publication and
its recent movement R = M0 − M(T_pub − 6 h)?
- **Models.** Ordinary least squares: the baseline is [1, R]; the full model adds F − M0.
- **Split.** Chronological by event: the earliest 70% train, the rest is the holdout. Nothing
  is fitted on the holdout.
- **Metric.** The holdout mean squared error of the baseline minus that of the full model,
  with an event-level bootstrap 95% interval.
- **Minimum sample.** 60 training units and 30 holdout units, below which the result reads
  "insufficient evidence".

## 11. Isolation

No ranking, grade, evaluation window, eligibility rule, model, model input or historical
forecast reads or is changed by this layer. That includes the Collective's football-v2 grading
and rankings, the lock rule, EdgeDesk's performance grading and the Record. Results live under
`mf_` only. `tools/foresight/isolation.test.js` checks this against every tracked file.
