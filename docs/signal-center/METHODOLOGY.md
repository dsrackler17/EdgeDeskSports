# Signal Center — methodology

The rules `lib/edgedesk_signal_engine.js` enforces, in the order a candidate
meets them. The engine version is `edgedesk_signal_engine/1`, the payload schema
`edgedesk_signal_v1`, and the scoring specification `sc_importance_v1`
(adopted 2026-10-23). The terminal's **Method** view prints the specification
from the engine itself, so the page and the code cannot disagree.

## 1. Only comparable numbers

Two numbers are compared only when they answer the same question. Otherwise there is no signal.

- **The same event**, by its event key.
- **The same outcome**: the same team's win probability, or the same Simulator outcome definition.
- **The same model identity**: a change across a model version is still recorded, but as a
  *model version change* (§3), never as news.
- **The same market definition**: a named book, a two-way price and the same side. Each quote is oriented by team
  name (or by the ledger's own `oriented_by`) before anything is compared. A swapped or unknown orientation is
  refused.
- **In time order, before the event**: the later record is after the earlier one, and both precede kickoff. A
  signal detected after its event started is stored as EXPIRED, never as current.
- **One pipeline per comparison**: a performance-ledger row is never compared with a game-research snapshot, and
  one capture path supplies each sport's prices (NFL and CFB: the football quote record; NBA and NHL: the
  performance ledger).

What a candidate fails is recorded in the run's `refused` list with its reason, for example "quote is 279 min old
(live window 180 min): not a current price". Nothing is filled in.

## 2. The categories

| Category | Detected when | Thresholds |
| --- | --- | --- |
| Forecast shift | Two consecutive snapshots of the same game's win probability, same model | floor 3 pp; full scale 10 pp; rarity needs 30 earlier same-version moves in the league |
| Model–market disagreement | EdgeDesk's current probability vs a named book's de-vigged price | floor 8 pp; full scale 20 pp; quote ≤ 180 min old; model ≤ 36 h old; rarity needs 10 earlier gaps |
| Market convergence | An active disagreement of ≥ 8 pp has closed to ≤ 4 pp | says who moved (model or market) |
| Market movement | The same book's de-vigged price moved between two captures | floor 4 pp; full scale 12 pp; captures ≤ 30 h apart |
| Simulator change | Two published runs, same outcome definition and provenance | floor 3 pp; full scale 15 pp; \|z\| ≥ 4 using both runs' Monte Carlo errors; ≥ 10,000 simulations each |
| Availability change | A dated report changes a player's designation inside 7 days of the game | CFB: QB only; an effect on the forecast is printed only when the model computed one |
| Model reliability warning | Live grading shows a calibration band off by ≥ 5 pp (≥ 20 games), or the model behind the market on the same games (≥ 20), or a serving version with no live record | sample state must not be TOO_EARLY |
| Data freshness warning | A source the signals read is older than its window (research 180 min, ledger 360 min) | scored down, never shown as live |

Empirical context behind the floors, from the committed history. Non-zero same-version NFL moves have a median of
2.0 pp and a 95th percentile of 7.5. CFB's are 0.95 and 11.2. Board model–market gaps have a median of 4.2 pp (NFL)
and 5.0 (CFB), with 90th percentiles of 9.5 and 10.7. A floor sits above the routine noise, and full scale is
roughly where a move becomes unusual.

## 3. The evidence ladder

Every signal carries exactly one evidence class. The class says what the records establish about **why** the number
changed, and no more.

| Class | Requires | What a reader is told |
| --- | --- | --- |
| **Confirmed cause** | A controlled computation changed one input and isolated its effect on this number | The cause, with the isolated effect |
| **Supported association** | A verified, source-dated event (a record, a rank, availability) between the two snapshots | The event is associated with the change; its share has not been isolated |
| **Observed** | Both values are on record from named sources at stated times (divergences, market moves, designations) | What is on record; nothing establishes why |
| **Unexplained movement** | The model re-ran and the number moved, but the snapshots do not record which input changed | "EdgeDesk does not know yet why this number moved" |
| **Model version change** | The model itself changed between the snapshots | A methodology change, not new sports information |

The engine never writes a sentence like "the injury caused a 7.2-point movement" unless the effect was computed by
isolating that input. In the committed data no forecast shift reaches Confirmed cause. In a dry run over the committed sources
(2026-10-23) the four supported associations are win–loss record changes between snapshots. The 98
unexplained forecast shifts are reported as unexplained.

Each signal also separates **facts** (dated, sourced) from **estimates** (the model's). Its **timing** is kept as
separate facts: the event, source published, forecast calculated, recorded by EdgeDesk, detected by Signal Center,
published. An earlier source timestamp never proves EdgeDesk knew earlier.

**Found in the ledger later** (`E.SPEC.backfill`). Signal Center reads every record back to the start of each
ledger, so most of the season is found after the fact. A change found more than 180 minutes after its source record
is:

- **scored as of that record**: freshness and relevance at that moment, which is the score the hourly evaluation
  would have given it when the record appeared. It is not marked down as stale for having been found late;
- **placed at that record** (`signal_at`): the feed sorts by it and the pulse counts it on the day it happened;
- **marked** *found in the ledger later*, with its true detection time kept beside it. EdgeDesk did not show it at
  the time, and the page never suggests it did.

**Past model–market boards are replayed, never reconstructed from later data.** At each capture pass the board is
rebuilt from records stamped at or before that moment: each game's latest snapshot and its latest named price (live
window 180 minutes, model at most 36 hours old). The engine judges it with now set to the pass. A disagreement is
kept the first time it crossed the floor. A refreshed snapshot with the same gap is the same story, so a new card
needs the gap to move at least 2 pp (the rule for a new version). A convergence is kept once, when the gap closed.
Prices without team names are not replayed, because only today's slate could orient them.

## 4. Verification

| State | Meaning |
| --- | --- |
| VERIFIED | Every number was re-read from its source record and every comparability check passed |
| UNVERIFIED | At least one check failed. It never appears in the verified feed. |
| INVALIDATED | A later run could not reproduce it from its sources. It is withdrawn, and its history is kept. |

The checks travel with the payload and the detail page lists them. Examples: `same_event`, `same_outcome`,
`probabilities_in_range`, `ordered_in_time`, `pregame`, `model_identity_recorded`, `distinct_snapshots`,
`source_consistent`, quote age, and orientation. Each run re-verifies the active signals (`sc_active`) and
withdraws, as INVALIDATED, any whose source record vanished. The server also re-checks every simulator signal
against `sim_team_results` before storing it.

## 5. Identity and versions

- `signal_key` (`sc1-…`) is a fingerprint of the identity: category, event, outcome, model and the two records.
  The same change found twice is one signal.
- `version_hash` (`sv1-…`) covers the payload minus volatile fields (detection time, run id, score, relevance,
  ages). A new version is written only when something material changed. `E.materialUpdate` decides, and the
  reason is stored.
- **Lifecycle:** ACTIVE → SUPERSEDED (a newer signal about the same subject and outcome), EXPIRED (the event
  started) or WITHDRAWN (invalidated or by an operator, with a reason). Supersession follows the records' time,
  not the order things were found: an older record found after a newer one is stored SUPERSEDED at once. **Publication:** SHADOW, PUBLISHED, HELD
  or WITHDRAWN. An operator's decision sticks.
- Versions, events and Model DNA snapshots are append-only. The database refuses updates and deletes, so the
  point-in-time history is real.

## 6. The importance score (`sc_importance_v1`)

> A transparent, rules-based ranking of what to read first. It is not a probability, it has not been validated
> against outcomes, and it says nothing about whether a bet would be profitable.

| Component | Weight | Rule |
| --- | --- | --- |
| magnitude | 0.35 | min(1, \|change\| / the category's full scale) |
| rarity | 0.25 | share of earlier comparable changes (same league and category, recorded before this one) that were smaller; 0 when fewer than the minimum reference exist |
| evidence | 0.15 | confirmed cause 1; supported association or observed 0.6; unexplained 0.25; model version change 0.1 |
| freshness | 0.10 | 1 inside 180 minutes of detection, falling linearly to 0 at 72 hours |
| reliability | 0.10 | the model's audit grade: validated 1, partial 0.6, early 0.4, unvalidated or experimental 0.25, unknown 0 |
| relevance | 0.05 | 1 when the event is inside 7 days (or a season outcome still open); 0.5 later; 0 once started |

Penalties: a LIMITED source record −10; a source with no publication or capture time −10; a model version change
between the records −15 (and no rarity at all, since such a move is not comparable). A signal found in the ledger
later is scored at its record's time (§3).

Labels: **Major** 70+, **Notable** 50+, **Routine** 30+, **Monitor** below. The detail page shows every component,
its value, its points and the rule. Rarity is a point-in-time percentile among the league's own earlier changes. It
is reported as "larger than N% of M earlier comparable changes", never as a probability.

## 7. Model DNA

One record per sport's serving model, from `engine/registry.json` (out-of-sample backtests),
`performance/data/summary.json` (live grading) and the newest forecast's model identity.

| Grade | Means |
| --- | --- |
| Validated | Calibrated out of sample, and the live record agrees so far |
| Partial | Calibrated out of sample; the live record is still short or shows a band to watch |
| Early | Calibrated out of sample; too few live games to judge it live |
| Experimental | Its out-of-sample evidence is provisional: treat its probabilities as research |
| Unvalidated | No out-of-sample evidence is on file |

Each record shows the serving version and how many of its games are graded live, plus the Brier score and log loss
(printed only from 20 games). It also shows calibration by band (said vs saw, with Wilson intervals) and the market
comparison on the same games. Where available it adds margin error, recent-window degradation, the out-of-sample
backtest per market, and the known limitations. It closes with a plain answer to "can I trust it here?"

**Raw win rate is not a measure of model quality and is never shown as one.** Today's records, from the committed
data: NFL Early (the serving v2.1.0 has no graded live games yet), college football Experimental (live Brier 0.237
vs the market's 0.223 on 59 games, an early signal that the market is ahead), NHL Partial, NBA Early.

## 8. Uncertainty

- **Monte Carlo error is sampling error only.** A Simulator change must exceed four combined standard errors. The
  intervals describe how precisely the simulation measured its own model, not how uncertain the forecast is.
- **CFB playoff selection and seeding are Estimated** (a committee proxy). A Simulator signal about them says so and
  never presents a committee outcome as a known selection probability.
- **Small samples are said out loud.** Rarity is not scored under its minimum reference; reliability warnings need
  20 games per band; Model DNA prints "not printed under 20 games".

## 9. Consensus Breaker

For a model–market disagreement, every compatible estimate of the same outcome is shown side by side: EdgeDesk's
model, the named book (de-vigged) and the Kalshi mid where one is mapped (before fees). Each comes with its time
and its group (model or market). The range and the number of independent groups are shown. No consensus number is computed: the
references are correlated, and the page says so instead of averaging them. No synthetic model is ever built to fill
the table.

## 10. Relationship to the market-intelligence program

`docs/market-intelligence/` (a separate program, merged to `main` on 2026-10-23) asks whether EdgeDesk's forecasts
carry information the market does not. It keeps its market-intelligence *findings* out of subscriber alerts until a
finding kind shows value (its Phase 6 is "BLOCKED by evidence"). Signal Center does not consume those findings.
It reports **changes** in EdgeDesk's own records and makes no value claim. A model–market disagreement here is a
question to research, never evidence of an advantage, and that framing agrees with that program's result: in the
CFB live record, model–market disagreement carries no information beyond the close (its hypothesis H-001).
Model DNA shows the same thing from the grading: the CFB model is behind the market on the same games. CFB
divergences are EXPERIMENTAL in the registry. If that program later validates a finding kind, the integration point
is the same `sc_` store and the same doors.

## 11. Copy

Every headline, summary and graphic string passes the copy rule (`E.copyOk`). It refuses betting-recommendation
language ("bet this", "lock", "guarantee", "edge", "+EV", "profitable", "value play" …). The public headline
(`E.publicHeadline`) carries no number. A disagreement is "a question to research, never a recommendation".
