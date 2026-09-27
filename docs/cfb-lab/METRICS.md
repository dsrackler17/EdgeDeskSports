# CFB Live Model Lab — exact definitions

These definitions were written **before** the first live prediction was graded. Changing any of them is a
governed act: bump the rule's version, keep the old one for the rows it produced, and append a
`RULE_CHANGED` event to the audit log (`football/cfb_lab/governance/audit_log.jsonl`). The code that
implements them is `football/cfb_lab/lab_core.js` (JavaScript, one copy shared by the jobs, the tests and
the pages) and `supabase/cfb_lab.sql` (the Postgres functions for openers, closes and quote
de-duplication). `football/cfb_lab/tests.js` checks that the two agree.

Rule versions in force: `cfb_lab_ledger_v1`, `cfb_lab_checkpoint_v1`, `cfb_lab_official_v1`,
`cfb_lab_open_v1`, `cfb_lab_close_v1`, `cfb_lab_quote_dedupe_v1`, `cfb_lab_eval_v1`, `cfb_lab_dq_v1`,
`cfb_lab_miss_v1`, `cfb_lab_promotion_v1`.

---

## 1. Signs (the one convention)

- **Home margin**: home points − away points. Positive means the home team wins by that many.
  Every `*_margin` field, every model projection and every error uses it.
- **Home line**: the number a book prints for the home side. Negative means the home team is favoured
  (`-7` = home lays 7). Every `*_home_line` / `*_spread` field uses it.
- **Conversion**: `margin = -home_line`, done once, where a line enters the lab
  (`lab_core.conv.bookToMargin`, the same function as the V2 engine's).
- **Away line**: `away_line = -home_line`. A side's own number (`recommended_line`, `best_available_spread_*`)
  is written in that side's convention: HOME at `-3.5` means home lays 3.5, AWAY at `+3.5` means the away
  team receives 3.5.
- **Model–market gap**: `pure_home_margin - market_margin`. Positive means the model likes the home team
  more than the market does. The side a gap points to is HOME when positive, AWAY when negative.

## 2. Checkpoints (`cfb_lab_checkpoint_v1`)

The lab job runs every hour (pg_cron dispatch, with a GitHub schedule as backup). At each run, for each
game with `0 < hours_to_kickoff` and each tracked model that has a projection for the game, it takes at
most one snapshot. Which checkpoint it records is decided only by `hours_to_kickoff` at that moment:

| checkpoint | window (hours to kickoff) |
|---|---|
| `T72` | 48 < h ≤ 72 |
| `T48` | 24 < h ≤ 48 |
| `T24` | 12 < h ≤ 24 |
| `T12` | 6 < h ≤ 12 |
| `T6` | 2 < h ≤ 6 |
| `T2` | 1 < h ≤ 2 |
| `FINAL` | 0 < h ≤ 1 |
| `OPEN` | h > 72, only for the model's first snapshot of the game |

- A checkpoint is taken at the **first run inside its window** and never again (one row per
  game × model × checkpoint).
- If no run happened inside a window, that checkpoint **does not exist**. It is never back-filled with a
  later or earlier snapshot.
- `is_first_snapshot` marks a model's first snapshot of a game, whichever window it fell in.
- `WEEKLY_FREEZE` is the V2 pipeline's Tuesday 12:00 UTC write-once snapshot, imported as it was frozen.
- `ADHOC` is a manual snapshot (`checkpoint.js --adhoc`). It is kept, and it never counts as official.
- A game or line that does not exist yet is never invented. Without a projection there is no snapshot.
  Without a market, the market fields are null and the snapshot still counts for accuracy.

## 3. Snapshot families and the OFFICIAL prediction (`cfb_lab_official_v1`)

| family | definition |
|---|---|
| `EARLY_MODEL` | the snapshot with `is_first_snapshot = true` |
| `MIDWEEK_MODEL` | the `T48` snapshot |
| **`OFFICIAL`** | **the `T24` snapshot**: the first snapshot taken when 12 < hours to kickoff ≤ 24 |
| `FINAL_MODEL` | the `FINAL` snapshot |

- The public record and every "official" metric use **only the OFFICIAL snapshot of the model that was
  champion when the snapshot was taken**, with origin `LIVE`.
- A game without a `T24` snapshot has **no official prediction**. It is counted in `official_coverage`
  and never replaced by a better-looking snapshot.
- Every other snapshot is kept for research: timing analysis, betting research and challenger comparison.
- `GIT_RECONSTRUCTED` and `REPLAY` rows are never official, whatever their checkpoint.

## 4. Market history

### Quote de-duplication (`cfb_lab_quote_dedupe_v1`)

Quotes are stored per `(source, book, game, market_type)`. A newly observed quote is written when:

1. there is no earlier row for the key, or
2. its values (line, total, prices) differ from the latest row's, or
3. the latest row is **6 hours or more** older (a heartbeat), or
4. kickoff is **3 hours or less** away and the latest row is **50 minutes or more** older (a close-zone
   heartbeat).

Otherwise it is dropped as a duplicate. A quote observed at or after kickoff is never written as pregame.
Live (in-play) odds are never read. The one exception is a provider's own declared closing number (for
example ESPN's line frozen at kickoff), stored once with `is_provider_close = true, is_pregame = false`.

Details that both implementations (`lab_core.js` / `market.js` and `supabase/cfb_lab.sql`) apply exactly,
pinned by the shared cases in `football/cfb_lab/fixtures/market_rules.json`:

- **Refused** (never written, never a duplicate, and it does not start a series): an unknown source
  (only `espn`, `cfbd`, `odds_api`, `record`), an unknown market type (`spread`, `total`, `moneyline`),
  no game and no provider event, a spread without `home_line`, a total without `total_points`, a
  moneyline without a price, `is_pregame` not the opposite of `is_provider_close`, both provider flags,
  and any quote that is not a provider close observed at or after kickoff.
- **Provider-declared rows** (`is_provider_open` or `is_provider_close`) are kept once per key and flag;
  a second one is a duplicate whatever its value. They are not part of the ordinary series: an ordinary
  quote is compared only with the latest *ordinary* row of its key.
- **Provider events.** A quote that arrives with only a provider event id (an Odds API event) is resolved
  through the event map first (the newest map row for that source and event wins), so it gets the same
  key and id it would have had with the game id already set. An unmapped event stays keyed by its
  provider event id and cannot enter a game's market until it is mapped. Events are mapped by the
  board's own join (both teams, in this orientation, and the kickoff within 36 h); a swapped or
  ambiguous match is refused, never guessed.
- A written quote with the same values as the previous row is a heartbeat (`is_heartbeat = true`).

### Opening line (`cfb_lab_open_v1`)

- **Per-book opener**: that book's earliest observed ordinary pregame quote for the game
  (provider-declared rows excluded; ties broken by `quote_id` ascending). A book is keyed by
  `(source, book)`, and its line row's `book` column is `source:book` (for example
  `odds_api:draftkings`) with `n_books = 1`.
- **Consensus opener** (`book = CONSENSUS`, quality `OBSERVED`):
  - Let `t0` be the earliest per-book opener time.
  - Take the books whose opener was observed no later than `t0 + 24h`. When any real sportsbook is among
    them, provider averages (`book = consensus`) are left out.
  - `home_line` is the median of their opener lines; prices are the medians of their prices, taken in
    decimal-odds space and rounded half away from zero.
  - `observed_at` is the earliest opener time among the books actually used; `n_books` is the count.
  - A consensus spread row also carries `best_line_home = max(home_line)` and
    `best_line_away = -min(home_line)` over the books used.
- **Fallback**: if nothing was observed, use the median of provider-declared openers
  (`is_provider_open`, each book's latest; same provider-average rule), quality `PROVIDER_DECLARED`,
  `observed_at` null (the provider's own time is not known). If there is none, quality `MISSING`: every
  value null, `n_books = 0`.
- **Values by market.** Spread: `home_line`, `price_home`, `price_away`. Total: `total_points`, with the
  over price in `price_home` and the under price in `price_away`. Moneyline: `price_home`, `price_away`.
  The spread is always derived (a game known only from a LIVE prediction gets `MISSING` consensus rows);
  total and moneyline only when the game has a quote of that market. Lines are stored at 2 decimals.
- **Never replaced by a later line.** The raw quotes behind every opener are kept (`quote_ids`).
- **Two timings.** A snapshot records the opener as known at its own time (`opening_spread`,
  `opening_market_ts`, `opening_quality`). The write-once `OPEN` row in `cfb_lab_market_lines` is derived
  once, with the close.

### Closing line (`cfb_lab_close_v1`)

- **Per-book close**: that book's **latest ordinary pregame quote observed in [kickoff − 180 minutes,
  kickoff)** (ties by `quote_id` ascending). Heartbeats count, because they confirm the number was still
  up. A book with nothing in that window has no close.
- **Consensus close** (`CONSENSUS`, quality `OBSERVED`):
  - `home_line` is the median of the per-book closes. When any real sportsbook has a close, provider
    averages are left out.
  - Prices are medians; `observed_at` is the latest quote time used; `n_books` is the count.
  - `best_line_home = max(home_line)` and `best_line_away = -min(home_line)`, each in its own side's
    convention.
- **Fallback**: if no book closed inside the window, use the median of provider-declared closes
  (`is_provider_close`, each book's latest; provider averages left out when a real book declared one),
  quality `PROVIDER_DECLARED`, `observed_at` null, best lines over the declared numbers. If there is
  none, quality `MISSING`.
- **Derived once**, at the first run at least **3 hours after kickoff**, so late quote syncs can land
  first. After that it is write-once.
- In-play odds are never used.

## 5. Settlement

- **FINAL** is written only when every result source that carries the game agrees on both scores:
  ESPN's scoreboard, with its `completed` flag, and the cfbfastR schedule. A disagreement writes nothing
  and raises a data-quality alert.
- **Overtime**: the ESPN period count exceeds 4. When no source says, `overtime` is null.
- **Postponed, canceled or no contest**: status `POSTPONED` / `CANCELED` / `NO_CONTEST`. Every snapshot
  of that game is graded `VOID`: it is not a win, not a loss and not a push, it adds no error and no
  units, and it is excluded from every denominator.
- **Corrections**: a later disagreement or scoring change writes a new result row with `supersedes`, and
  evaluations are recomputed as new rows. Nothing is edited.

## 6. Error metrics (`cfb_lab_eval_v1`)

For a settled, non-void snapshot:

| metric | definition |
|---|---|
| `margin_error` | actual home margin − predicted home margin (positive = home did better than predicted) |
| `abs_margin_error` | \|margin_error\| |
| `squared_margin_error` | margin_error² |
| `home_points_error`, `away_points_error` | actual − projected points, when points are projected |
| `total_error` | actual total − projected total |
| `winner_correct` | sign(predicted margin) = sign(actual margin); null when the prediction is exactly 0 |
| MAE / RMSE / median AE | mean, root-mean-square and median of the errors above over a set |
| bias | mean `margin_error` over a set (positive = the model under-rates home teams) |
| P90 / P95 | 90th / 95th percentile of `abs_margin_error` (linear interpolation) |
| favourite bias | mean of `margin_error × sign(predicted margin)`; negative = the model over-rates its favourites |

## 7. Probability scoring and calibration

- `home_won` is 1 when the actual margin > 0, else 0. College football has no ties.
- **Brier (win)** = `(p_home − home_won)²`. The set Brier is the mean.
- **Log loss (win)** = `−[y·ln p + (1−y)·ln(1−p)]`, with p clipped to [1e−6, 1 − 1e−6].
- **Calibration buckets (win)**:
  - Each prediction is folded to its favourite: `p_fav = max(p_home, 1 − p_home)`, and the outcome is
    whether the favourite won.
  - Buckets: 50–55, 55–60, 60–65, 65–70, 70–75, 75–80, 80+ (lower bound inclusive).
  - Per bucket: n, mean predicted, observed rate, and difference (observed − predicted).
- **Cover calibration**: the same buckets on `cover_probability` for the snapshot's side, with the
  outcome "covered at the graded line". Pushes are excluded.
- **ECE** = Σ_b (n_b / N) · |observed_b − predicted_b| over the buckets above.
- **Calibration slope**: logistic regression of the outcome on logit(p). Reported only when n ≥ 200;
  otherwise "insufficient sample".
- **Sample sizes are printed beside every number.** Anything with n < 30 is labelled *small sample*, and
  anything with n < 100 *provisional*.

## 8. Prediction intervals

`in_interval_k` is true when `interval_k_low ≤ actual margin ≤ interval_k_high` (inclusive), for k in
50/80/95. Coverage is the share true.

- **Alert**: coverage falls outside the binomial 95% band around the nominal rate for its n. At
  n = 100 the 80% band is about 72%–88%.
- **Direction**: under the band means overconfident; over it means underconfident.

## 9. Market discovery and CLV

**Edge versus the opener**
- `edge_vs_open` = pure margin − opening margin (`-opening_home_line`).
- The opener used is the game's write-once consensus `OPEN` line, falling back to the opener known at the
  snapshot when the derived line is missing. A projection made before any line existed is compared with
  the first line the market posted, which is the cleanest test of discovery.
- `open_abs_error` and `edgedesk_beat_open` (§10) use the same opener.
- `market_move_points` = (closing margin − opening margin) × sign(`edge_vs_open`): the points the market
  moved **toward** the model between open and close.
- `market_move_toward_model` = `market_move_points > 0`. Null when `edge_vs_open` = 0 or a line is
  missing. It is recorded whatever the result of any wager.
- `move_since_snapshot` = (closing margin − the snapshot's market margin) × sign(`model_market_gap`).

**CLV** (every snapshot with a side; the headline CLV is for BET and LEAN decisions)
- Points: `clv_points = (L_snapshot − L_close) × (+1 for HOME, −1 for AWAY)`, where `L` is the home line
  at the snapshot's graded number and at the consensus close.
  - Worked example: bet on the home team at −3 that closed −5. CLV = (−3 − (−5)) × 1 = +2.
  - For the away side at +3 (home −3) that closed +5 (home −5): CLV = (−3 − (−5)) × (−1) = −2.
- Price: `clv_price` = implied probability at the close minus implied probability at the bet, in
  percentage points, for the same side. Defined only when both prices exist and the two lines are equal;
  otherwise null.
- `positive_clv` = `clv_points > 0`, or, when the lines are equal, `clv_price > 0`.
- Reported as positive-CLV %, mean and median. Segments: edge size, reliability, decision class, week,
  checkpoint.

## 10. Model versus market (accuracy, not betting)

For every settled snapshot:
- `open_abs_error` = |actual margin − opening margin|
- `close_abs_error` = |actual margin − closing margin|
- `edgedesk_beat_open` = model absolute error < opening absolute error (ties are not a win and are
  counted separately); `edgedesk_beat_close` is the same against the close.
- `error_diff_vs_open` = model absolute error − opening absolute error (negative = EdgeDesk was closer);
  `error_diff_vs_close` is the same against the close.

## 11. Decisions and wagers

**Status and decision class**
- V2 models: the engine's `decide()` statuses. `BET → BET`, `LEAN → LEAN`, `REVIEW → RESEARCH` (a
  disagreement big enough to need a person), `PASS → PASS`.
- V1: the board publishes no decision, so the lab applies `lab_rule:v1_gap_v1`, the football record's
  lean rule: LEAN when |gap| ≥ 2 points, else PASS. V1 never gets BET.
- **Data-quality gate**: a snapshot whose data quality is `RED` is `PASS` with
  `pass_reason = "data quality RED: …"`, whatever the model said. The engine's own status is kept in
  `status`.

**Grading an ATS result** at home line `L` on final margin `m`
- HOME side: `m + L > 0` is WIN, `< 0` is LOSS, `= 0` is PUSH.
- AWAY side: the reverse.
- `ats_result` grades at the snapshot's number (`recommended_line`).
- `ats_result_at_close` grades the same side at the consensus close.

**Units and ROI**
- Only BET decisions carry a stake (`stake_units`). BET is disabled today, so the stake is 0.
- Units: WIN = stake × payout(price); LOSS = −stake; PUSH = 0; VOID excluded.
- `hypothetical_units` grades one unit on every snapshot's side, BET or not, for the PASS and threshold
  analysis. It uses the captured price; without one it assumes −110 and sets `price_assumed = true`.
- **ATS %** = wins / (wins + losses). Pushes are shown but are not in the denominator.
- **ROI** = Σ profit / Σ stake over WIN, LOSS and PUSH (pushes risk the stake and return it). VOID is
  excluded.
- **Max drawdown**: the largest peak-to-trough fall of cumulative units in kickoff order.

**Process versus outcome** (bad beat versus bad model)
- `process_quality`:
  - `GOOD` when `clv_points > 0`, or when `move_since_snapshot > 0` and there is no close price to judge.
  - `POOR` when `clv_points < 0`.
  - `UNKNOWN` otherwise.
- `outcome_quadrant`: `GOOD_PROCESS_WIN`, `GOOD_PROCESS_LOSS` (a bad beat), `POOR_PROCESS_WIN` (a lucky
  win at a poor number), `POOR_PROCESS_LOSS`, or `UNKNOWN`.

## 12. Near misses

`threshold_distance` stores, for each condition of the BET/LEAN rule, the value minus the threshold:
- `ev_minus_lean_ev`
- `ev_minus_bet_ev`
- `gap_minus_bet_gap`
- `reliability_minus_bet_min`

`near_miss` = the snapshot is PASS or LEAN, and its failing conditions are all within:
- 0.01 units of EV,
- 0.5 points of gap,
- 5 reliability points.

Near misses are tracked, not treated as failures.

## 13. Model state

- `football_confidence_raw`: the model's own reliability score. For V2 this is the engine's
  `football_prediction_confidence`; for V1 it is the board's `reliability_score`.
- `football_confidence`: `football_confidence_raw` capped by data quality. `RED` caps it at 40, `YELLOW`
  at 75, and `GREEN` leaves it uncapped.
- `ensemble_disagreement`: the standard deviation across the model's active component margins.
- `internal_consensus_score` = round(100 × max(0, 1 − ensemble_disagreement / 6)). A 6-point SD or more
  scores 0. It is null without components.
- `expected_model_error`: the expected absolute margin error implied by the model's distribution.
  - V2: σ × E|T|, where T is a unit-variance Student t with the model's df.
  - V1 has no σ, so its is implied from the win probability, σ = margin / Φ⁻¹(p_home), when
    0.02 < p < 0.98 and |margin| ≥ 1; otherwise null.
- `qb_certainty` (0–100), from the board's quarterback evidence, taking the lower of the two teams:
  - 100: a confirmed starter, or an official report listing him available;
  - 70: last game's starter with no announcement;
  - 40: unsettled;
  - 20: unknown.
- `injury_certainty` (0–100), taking the lower of the two teams:
  - 100: a comprehensive official availability report read within 72 hours;
  - 60: no report was required, or a partial report;
  - 30: no report could be read.
- `data_completeness`: the board's `data_completeness` (0–1).
- `pbp_completeness`: the board's team-data coverage (0–1).

## 14. Data quality (`cfb_lab_dq_v1`)

Checks per game at snapshot time. Each is `GREEN`, `YELLOW` or `RED`.

| check | RED | YELLOW |
|---|---|---|
| schedule integrity | kickoff or either team missing | — |
| team mapping | the model's teams do not match the schedule's for the game id | — |
| duplicate game | the same pair appears twice in the week | — |
| model input | the model's row is missing its projection or error scale | — |
| odds freshness | — | newest quote older than 6 h when h ≤ 48, or older than 36 h otherwise |
| QB status freshness | — | the board's QB evidence is older than 72 h |
| injury freshness | — | a required availability report is older than 72 h when h ≤ 72 |
| weather freshness | — | the forecast is older than 12 h when h ≤ 48 |
| PBP freshness | — | a team's completed games lack play-by-play |

The game's status is the worst of its checks.

## 15. Buckets

| analysis | buckets |
|---|---|
| model–market gap (\|gap\|, points) | 0–1, 1–2, 2–3, 3–4, 4–5, 5–7, 7+ |
| reliability (`football_confidence`) | 90–100, 80–89, 70–79, 60–69, <60 |
| edge quality | 0–19, 20–39, 40–59, 60–79, 80–100 |
| disagreement (`ensemble_disagreement`, points) | very low < 1, low 1–2, moderate 2–3, high 3–4.5, very high ≥ 4.5 |
| timing | checkpoint type |

A bucket prints its n and carries the small-sample / provisional label (§7).

## 16. Windows and drift (alerts never retrain anything)

**Windows**: the last 25, 50 and 100 settled official predictions in kickoff order, season to date, and
all live.

| alert | fires when |
|---|---|
| `mae_rising` | last-50 MAE exceeds the model's holdout reference MAE by more than 2 standard errors (SE = SD(abs error) / √n) |
| `calibration_worse` | last-100 win ECE > 0.06, or 80% coverage outside its binomial 95% band (n ≥ 50) |
| `favorite_heavy` | \|last-100 favourite bias\| > 2 SE |
| `variance_shift` | last-100 variance of predicted margins is below 0.67× or above 1.5× the reference |
| `missing_data` | more than 10% of the last run's snapshots are data-quality RED |
| `qb_source_stale`, `pbp_source_stale`, `market_source_stale`, `injury_source_stale` | the matching freshness check is not GREEN for more than 25% of the games within 72 h |
| `results_backlog` | a game more than 24 h past kickoff is still unsettled |
| `checkpoint_missed` | a game reached kickoff without its OFFICIAL (T24) snapshot |

## 17. Miss reviews (`cfb_lab_miss_v1`)

- **When**: every official snapshot with |error| ≥ 10 gets a review record. Its severity is the highest
  threshold crossed (10, 14 or 21).
- **What it stores**:
  - the projection, the close and both errors;
  - the components, drivers and data quality;
  - the QB and availability evidence at the snapshot;
  - the post-game factors (turnovers, explosive plays, special teams, garbage time) where the V2 learning
    pass has them.

**Automatic classification** (first match wins). "High variance" is never assumed; it needs evidence.

| class | evidence required |
|---|---|
| `DATA_FAILURE` | snapshot data quality RED, a result-source disagreement, or a team-mapping fault |
| `INFORMATION_CHANGE` | the starting QB differed from the one expected at the snapshot, or the market moved ≥ 3 points after the snapshot in the direction of the result |
| `HIGH_VARIANCE_OUTCOME` | post-game luck factors present (turnover margin ≥ 3, special-teams swing ≥ 7, or garbage time), **and** the close missed by at least 80% as much |
| `MODEL_FAILURE` | the close's absolute error was at least 7 points smaller than the model's, with none of the above |
| `UNKNOWN` | none of the above could be established |

A person can re-classify; that adds a row with `supersedes`.

## 18. Reliability and edge-quality validation

- **Reliability buckets** (§15): n, MAE, median AE, win Brier, win ECE, 80% coverage, ATS and CLV where
  decisions exist.
  - `RECALIBRATE` is flagged when, among buckets with n ≥ 30, a higher-reliability bucket has a higher
    MAE than a lower one by more than 1 SE.
- **Edge-quality buckets**: decisions, ATS, ROI, CLV, mean market move toward the model, MAE and cover
  calibration.
  - `DOES_NOT_SORT` is flagged when, among buckets with n ≥ 30, a higher bucket has a lower ATS than a
    lower one by more than 1 SE.
- **Disagreement buckets**: MAE and 80% coverage.
  - `DISAGREEMENT_PREDICTS_ERROR` is flagged (and a research item opened) when very-high MAE − very-low
    MAE > 2 SE with n ≥ 30 in each.

## 19. Champion / challenger promotion (`cfb_lab_promotion_v1`)

**Common set**: a promotion evaluation compares models on the same LIVE settled games where every model
has an OFFICIAL-window (`T24`) snapshot. It runs when that set reaches 150 games, and every 50 after.

**A challenger is ELIGIBLE only when all of these hold:**
1. MAE is lower, with the paired bootstrap 95% CI of the difference entirely below 0.
2. Win Brier is lower or equal.
3. Win ECE is no more than champion + 0.01.
4. 80% interval coverage is within [0.75, 0.85].
5. P95 absolute error is no more than champion + 1.0.
6. The challenger has the lower MAE in at least 60% of the weeks in the set.

**Reported, but not gating**: CLV, model-vs-market accuracy and ROI. Prediction quality comes first.

**Eligibility never changes the champion.** Only a person, through `governance.js promote`, does that.
It writes a `cfb_lab_model_roles` event and an audit-log entry.

## 20. Contamination control

| pool | contents |
|---|---|
| `live_observation_pool` | every LIVE prediction and result from 2026-09-27 on. Evaluation only; tuning may not read it. |
| `development_pool` | seasons 2016–2023 plus any live season formally released into it |
| `future_holdout_pool` | the next season not yet played (2027). Untouched until a pre-registered evaluation. |

- A live season is released to development only after its promotion evaluation has been recorded, by a
  `PARTITION_RELEASED` audit event.
- `lab_core.partitions.canUseForTuning()` and the V2 research config (`assert_dev_only`) refuse
  everything else.

## 21. Major disagreements (`lab.json` → `major_disagreement`)

Every V1 snapshot taken against a market carries the integrity gate's verdict
(`football/cfb_lab/checkpoint.js` → `lib/cfb_disagreement.js`). One snapshot per
game — the latest LIVE V1 snapshot with a market — is counted
(`football/cfb_lab/disagreement.js`):

| measure | definition |
|---|---|
| raw major disagreements | \|pure margin − market margin\| ≥ 7, whatever the gate said |
| verified / investigate / data fault / market fault | the gate's verdicts; `verification_not_run` for snapshots taken before the gate existed |
| average raw gap | mean \|gap\| over every game with a market, and over the 7+ ones |
| market movement toward verified gaps | share of settled verified snapshots whose close moved toward EdgeDesk (\|move\| ≥ 0.25; unchanged counts half), beside the same for unverified 7+ |
| verified-gap MAE / CLV | the snapshot's graded absolute error; (close − snapshot line) in EdgeDesk's direction, points |
| false-extreme rate | the close did NOT move toward EdgeDesk AND the result landed on the market's side of the gap or within its first quarter (`falseExtreme`). A losing ticket alone is never counted. |

VERIFIED is never a bet and the counts are never a quota. Page: `admin/cfb-lab` §8.
