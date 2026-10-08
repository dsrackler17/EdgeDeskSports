# The research data contract

**Schema:** `edgedesk_research_record_v1`, built by `EDIntegrity.record()` in
`lib/edgedesk_integrity.js`.

**Calculations:** `edgedesk_calc/1`, rounding policy `display_rounding_v1`
(`lib/edgedesk_calc.js`).

**Schedule truth:** `lib/edgedesk_schedule.js`.

**Availability:** `lib/edgedesk_availability.js`.

One record describes one game at one moment: the projection EdgeDesk made,
the market it was compared with, the comparison itself, and the verdicts.
Every surface that shows a number builds this record and renders from it:

- the CFB terminal;
- the in-app board;
- the public brief;
- the content engine's packets;
- the exports.

A field that is missing is carried as `null`, and the rules say so. **Unknown is
never treated as PASS.**

## 1. The record

| Field | Type | Source | Notes |
|---|---|---|---|
| `record_id` | `rr_<fingerprint>` | computed | fingerprint of the game, model version and snapshot, model margin, market snapshot, market margin, capture time and calc version. **The same inputs give the same id.** |
| `schema`, `integrity_version`, `calc_version` | string | constants | each version changes when its meaning does |
| `game.game_id` | string | the schedule feed's own id (cfbfastR / ESPN event id) | the join key for every artifact; odds attach to it, never to team names alone |
| `game.season`, `game.season_type`, `game.week` | number / string | the feed's own fields | the week is the **feed's**, not a date window |
| `game.home`, `game.away`, `game.home_id`, `game.away_id` | string | the schedule | ids are the stable identity; names are display |
| `game.home_conference`, `game.away_conference` | string | `football/fbs` coverage | conference claims are checked against these |
| `game.venue`, `game.neutral_site` | string / bool | the schedule | |
| `kickoff.state` | `CONFIRMED` · `TBA` · `SUSPECT_PLACEHOLDER` · `MISSING` | `EDSchedule.kickoffOf` | only `CONFIRMED` is verified (§3) |
| `kickoff.utc`, `kickoff.game_date`, `kickoff.basis`, `kickoff.source_flag` | ISO / date / text / bool | | the instant is always UTC; display converts |
| `model.version`, `model.snapshot_id`, `model.projected_at` | string / ISO | the projection artifact | the snapshot id is `<version>@<as_of>` |
| `model.home_margin`, `model.total`, `model.home_win_prob`, `model.away_win_prob` | number | the champion projection, **never altered** | home margin = home points − away points |
| `model.confidence`, `model.reliability`, `model.completeness` | 0–100 | `scores.confidence`, `lib/cfb_reliability.js` | what they measure is in `RELIABILITY.md` |
| `market.snapshot_id`, `market.captured_at` | string / ISO | the captured quote or consensus | |
| `market.market_type`, `market.is_main_line`, `market.home_margin` | string / bool / number | | only main spread is compared with the fair spread |
| `market.book`, `market.source`, `market.method` | string | | `MEDIAN` = consensus of N books; `REFERENCE` = a published line with no price |
| `market.stale`, `market.fault`, `market.mapping_ok`, `market.orientation_ok`, `market.quarantined_in_consensus`, `market.reference` | | the market screen | |
| `comparison` | `EDCalc.spreadComparison` | computed | model, market, gap, signed gap, toward, the reconcile formula and both snapshot ids |
| `projected_scores` | `EDCalc.projectedScores` | computed from margin + total | adds to the total and differs by the margin, exactly |
| `research` | `{ key, label, reason, rule, flags }` | `lib/edgedesk_canon.js` | the research classification (§4) |
| `decision` | `{ key, reason, bettor, engine_status }` | `lib/edgedesk_decision.js` | the betting decision (§4) |
| `ev` | `{ raw, calibrated, quote_raw, quote_calibrated, calibration }` | `lib/edgedesk_ev.js`, `lib/edgedesk_quote_ev.js` | each figure carries its own selection |
| `availability` | `{ home, away }` | `EDAvailability.classify` | the seven classes (§5) |
| `displayed` | `{ fair_text, market_text, gap, market_claim, edge_claim, ev_pair }` | what a surface is about to print | checked against `comparison` before it prints |
| `provenance` | `[{ source, as_of, url }]` | | |
| `built_at` | ISO | | |

**Verdicts.** `EDIntegrity.evaluate(record, boundary)` attaches them. It returns
`{ status, checks[], blocking[], warnings[] }`, and the CFB terminal stores the
result per row:

- `board.json` → `integrity { record_id, calc_version, dashboard, decision, publication, why_differ, ev_rejected, ev_text }`;
- `games.json` → `record` and `integrity`.

## 2. Numbers: one calculation layer

| Quantity | Function | Rule |
|---|---|---|
| Rounding | `EDCalc.round(x, dp)` | half away from zero, with a 1e-9 guard (9.45 → 9.5, −9.45 → −9.5) |
| A spread line | `EDCalc.spread(margin, names)` | the favourite and the line at 0.1; `Pick’em` at 0. The engine's ±1 near-pick'em display floor is **never** a printed or compared number |
| Model–market gap | `EDCalc.spreadComparison` | computed in integer tenths **from the two displayed lines**, so the printed gap is always their difference. `gap_exact` keeps full precision beside it |
| Total gap | `EDCalc.totalComparison` | same rule |
| Projected score | `EDCalc.projectedScores` | derived from margin and total. Shown to two decimals when the parities differ, so it reconciles exactly |
| Probabilities, EV | `EDCalc.impliedFromAmerican`, `noVigTwoWay`, `expectedValue`, `evPair` | `evPair` refuses to pair raw and calibrated EV unless selection, line, price, book and capture time are identical |
| Formatting | `EDCalc.fmt.{spread, total, gap, prob, ev, pp, american, rank, score100, age}` | HTML, Markdown, Word and publisher exports all use these |

## 3. Time

- **Kickoff states** (`EDSchedule.kickoffOf`):
  - the feed's `start_time_tbd` decides;
  - with no flag, midnight Eastern (the feed's placeholder instant) is `SUSPECT_PLACEHOLDER`;
  - a carried verdict can only keep a time unverified: it never confirms a time the source marks TBA;
  - a real 04:00Z kickoff the source marks as set (Sacramento State at Hawai'i) stays `CONFIRMED`.
- **Game status:** SCHEDULED, TENTATIVE (an unverified time), POSTPONED,
  CANCELED, LIVE and COMPLETED (`EDSchedule.statusOf`).
- **Display.** Every instant is stored in UTC and shown in the reader's
  selected zone with its abbreviation: "Sat, Oct 10 · 2:30 PM CDT". An
  unverified time is shown as "time TBA", never as a clock time.
  - The zone is chosen with the selector on the board and the terminal (`ed_tz_v1`).
  - The default zone is America/Chicago.
  - Naive timestamps are refused.
- **The current week** (`EDSchedule.currentWeek`) is the earliest feed week
  that still has an open game inside its own schedule cluster. Every other
  game is in one of two scopes:
  - `FUTURE_WEEK`: look-ahead research, badged "WK n" on the board and blocked
    from this week's publications;
  - `PAST_WEEK`.
- **Odds join** (`EDSchedule.eventMatch`). A quote attaches only to the same
  two teams in the same orientation, on the same game date (for a TBA game) or
  within 36 hours of kickoff. A reversed orientation is reported, never
  silently matched.

## 4. Two classifications, never merged

| | Research status | Decision |
|---|---|---|
| Question | Is further investigation useful? | Do the decision rules approve this exact price? |
| Values (brief's names → keys) | Worth Researching (`WORTH_RESEARCHING`, plus `VERIFIED_MAJOR`), Investigate (`INVESTIGATE`), Market Aligned (`MARKET_ALIGNED`, `NEAR_PICKEM`), Market Fault (`MARKET_FAULT`, `DATA_FAULT`), No Market (`NO_MARKET`), Insufficient Data (`LIMITED_DATA`, shown "LIMITED DATA") | BET, WATCH, PASS, NO DECISION. The engine also has **LEAN**, a sized-down class between BET and WATCH that the existing engine already ships (unchanged here). The terminal's **WAIT** is a WATCH-class hold |
| Source | `lib/edgedesk_canon.js researchStatus` | `lib/edgedesk_decision.js` (the only producer of BET) |
| Explained by | `EDIntegrity.explainStatuses`: the rules that passed and failed for each, and `whyDiffer`, one sentence on why they differ | |

**Research-grade** means WORTH RESEARCHING or VERIFIED MAJOR only. INVESTIGATE
(an unverified 7+ gap) is counted separately. `EDIntegrity.COUNT_DEFINITIONS`
holds the written definition of every board count, and `countBoard` checks
that the counts reconcile three ways.

## 5. Availability

`EDAvailability.classify` assigns one of seven classes:

- CONFIRMED_ACTIVE;
- EXPECTED_STARTER;
- GENUINE_COMPETITION;
- QUESTIONABLE;
- RULED_OUT;
- UNKNOWN;
- NOT_VERIFIED.

Each class is recorded with its source, publication time, effective date,
verification (`SOURCED`, `INFERRED`, `UNVERIFIED_SOURCE`, `NO_TIMESTAMP`,
`STALE`, `NONE`), whether revalidation is required (a report within 24 hours of
kickoff, or one that arrived after approval), and `may_assert_uncertainty`.

**Uncertainty may be written only for a sourced GENUINE_COMPETITION,
QUESTIONABLE or RULED_OUT.** A dropback split with no report is NOT_VERIFIED: a
measured fact, never a controversy. `EDAvailability.guardProse` checks the prose.

## 6. Artifact fields added (additive; no field removed or renamed)

| Artifact | Added |
|---|---|
| `football/fbs/slate.json` (via `build_coverage.js normRows`) | `season_type`, `start_time_tbd` (`null` when the feed omits it), `kickoff_tbd`, `kickoff_state`, `kickoff_basis`, `game_date`; artifact `current_week` |
| `football/cfb_terminal/board.json` | per row: `kickoff_tbd`, `kickoff_state`, `kickoff_basis`, `game_date`, `week_scope`, `integrity {…}`; `current_week`; `counts.integrity` (`countBoard` + `by_boundary`) |
| `football/cfb_terminal/games.json` | per game: `record`, `integrity`; `projected_score` is now derived (`engine_points` keeps the engine's own) |
| `football/cfb_terminal/brief.json` | current-week games only |
| `football/validation/integrity_performance.json` | new: live-forward vs backtest monitoring (`tools/integrity/performance.js`) |

These artifacts are regenerated hourly by the existing pipeline. This change
does **not** commit regenerated copies; the next scheduled build writes them.

## 7. Database fields added (`supabase/content_engine.sql`, idempotent)

| Object | Change |
|---|---|
| `content_engine.articles.approved_research_hash` | new column: the research an approval was given on |
| `articles.status` | adds `rejected` |
| `articles.format` | adds `weekend_storylines`, `game_deep_dive`, `conference_race`, `upset_watch`, `model_performance_review` |
| `opportunities.kind` | adds `weekend_storylines`, `game_deep_dive`, `model_performance` |
| `settings` | `monthly_budget_usd` (default 10.00, owner-configurable to at most 50), `job_budget_usd` (2.00), `ai_max_attempts` (2) |
| `content_engine.ai_months`, `content_engine.ai_spend` | new tables: the month's committed and reserved spend, and one row per Claude call (request key, purpose, article, run, model, tokens, estimate, actual, billing source) |
| functions | `integrity_ok`, `research_current`, `revoke_for_research`, `ai_month_now`, `ai_sweep`, and the doors `content_engine_ai_reserve`, `content_engine_ai_settle`, `content_engine_cost_report`, `content_engine_budget_update`, `content_engine_acquisition_report` |

Rollout and rollback: `MIGRATION.md`.
