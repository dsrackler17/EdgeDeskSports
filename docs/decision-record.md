# The Decision Record

What a reader knew, saw and planned at the moment of a decision, kept exactly as it was, and everything learned from it afterwards.

- **Schema:** `supabase/portfolio_decision.sql`, applied after `portfolio.sql`, `portfolio_journal.sql` and `portfolio_connect.sql`.
- **Rules for the page:** `lib/edgedesk_decision_record.js`.
- **Views:** `lib/edgedesk_portfolio_journal_ui.js`, under "THE DECISION RECORD".
- **Tests:**
  - `tools/portfolio/decision_sql.test.js` (103 checks, against a real PostgreSQL)
  - `tools/portfolio/decision_record.test.js` (29 checks)
  - the Card → Record → Decision Record journey in `tools/portfolio/portfolio_ui.e2e.js`

EdgeDesk records positions the reader placed themselves. It never accepts or executes a wager, holds funds, places a prediction-market trade, or asks for a sportsbook password.

## 1. What was already there, and is reused

| Existing | Used for |
|---|---|
| `portfolio_journal_entries` DECISION and CLOSE blocks, write-once field by field (`portfolio_journal_guard`) | The entry's own decision fields. The snapshot fills the empty ones (research price, line and time; model probability, version and fair price). Nothing recorded is ever replaced. |
| `portfolio_facts` / `portfolio_facts_cache` and the process components | Every grade, CLV, slip and model edge in the record. The record recomputes none of them. |
| `portfolio_rules`, `portfolio_experiments` (frozen metric, condition and window) | Extended with success criteria, a frozen baseline, a write-once result and conclusion, and a write-once reflection. |
| `portfolio_clv_pct`, `portfolio_model_ev`, `portfolio_price_slip`, `portfolio_line_gain`, `portfolio_american_to_decimal`, `portfolio_div_round` | Edge capture is built from these. It has no formula of its own for any of them. |
| `card_opportunities` (write-once Card entries, with their frozen `snapshot`) | The source of the decision snapshot when a position is recorded from the Card. |
| `book_quote_ticks` (per-book price history, appended by trigger) | The only feed the market path reads, and only by exact capture key. |
| `user_alerts` and `alert_preferences` | Two new notice kinds (`decision_review`, `experiment_ready`), each with its own preference. |
| `portfolio_is_admin()` | The operator gate for moat metrics. |
| `portfolio_svc_ingest` and `portfolio_import_classify` | Reconciliation (§12). |

## 2. Schema added

| Table | Kind | Written by |
|---|---|---|
| `portfolio_methodology` | Published methods, never edited or deleted | This file's seed only |
| `portfolio_decision_snapshots` | **Immutable**, one per position | The reader's insert. A trigger cleans it and computes `user_state`, freshness and hash. |
| `portfolio_market_path` | Append-only | Triggers (snapshot, journal) and `portfolio_svc_attach_feed_path`. Never a reader. |
| `portfolio_reflections` | Append-only | A trigger on the journal's REVIEW block |
| `portfolio_outcome_classes` | Append-only, a new row per new inputs or methodology | `portfolio_classify_outcomes()` only |
| `portfolio_baselines` | Frozen once | `portfolio_baseline()` only |
| `portfolio_insights` / `portfolio_insight_observations` | Identity fixed / append-only | `portfolio_observe_insight()` only |
| `portfolio_card_events` | Append-only | The reader (ADDED, RESEARCH_VIEWED, CONSIDERED, REMOVED); the snapshot trigger alone writes RECORDED |
| `portfolio_experiments` (+ columns) | Criteria and baseline frozen at insert; result and reflection written once | `portfolio_conclude_experiment()`; the reader writes the reflection |

**"Written only by its function"** is enforced. Each function sets a transaction-local marker (`portfolio.writer`) that a request through the API cannot set. A table's guard refuses inserts without it, except from the service role.

**Reader functions.** Every reader function runs AS THE CALLER, so row level security applies inside it:

- `portfolio_decision_record`
- `portfolio_search`
- `portfolio_export`
- `portfolio_classify_outcomes`
- `portfolio_baseline`
- `portfolio_observe_insight`
- `portfolio_insight_memory`
- `portfolio_experiment_evidence`
- `portfolio_conclude_experiment`

**Owner-run functions.** Only these run as their owner, and the report checks the list:

- the triggers that write append-only rows
- the two notices
- `portfolio_delete_everything` (it must reach connector-owned rows), which checks the caller and filters by their id
- the operator metrics

## 3. The canonical Decision Record

`portfolio_decision_record(position, tz)` returns one document. The Portfolio sheet renders it, and search and notifications open it.

| Section | Contents |
|---|---|
| **BEFORE** | **The snapshot (frozen):** origin, when it was saved from research and when it was recorded, the time between them, EdgeDesk's state, the market's state with its freshness, the reader's state, and the content hash. **The journal's decision fields:** thesis, planned, tags, research price and whether each was recorded before the event. **The Card entry's events.** |
| **ENTRY** | Placed time, price, line, stake, units, timing bucket. |
| **MARKET PATH** | Every recorded price in time order. Each has its kind (OPEN · DECISION · RESEARCH · ENTRY · QUOTE · CLOSE), its source, and whether its time was OBSERVED (a capture time) or only RECORDED (when EdgeDesk learned it). |
| **RESULT** | Status, result, P&L, and the close with its source and book. |
| **GRADE** | The seven process components, score, letter, CLV, model edge, slip, edge capture with its limitations, and the persisted outcome class. Each item names the methodology version that produced it. |
| **REFLECTION** | The current review, plus every earlier version, each stamped before or after the result. |
| **FOLLOW-UP** | Whether it needs a review, the experiments it fell in (and whether it followed the change), the patterns it belongs to, and broken rules. |

## 4. Snapshot immutability

A snapshot is the moment of the decision, not a reconstruction.

**When it is refused:**

- the position is settled
- the event has started
- it is more than 6 hours after the position was placed

**What it stores:**

- **EdgeDesk:** model, calibration and pricing versions; probability and its source; fair price and line; EV, edge, confidence; the decision; stage; evaluation time.
- **Market:** best price, line, consensus, book count, range, and up to 30 per-book prices, each with its capture time.
- Only listed keys are kept. A value of the wrong type or out of range is dropped, never coerced.

**The reader's state is computed by the server, never taken from the client.** It covers:

- the unit, bankroll and caps on file
- positions and units in the 24 hours before
- the rules and experiments in force at the placed time

**Freshness** is computed against the recording time with `lib/edgedesk_market.js`'s thresholds:

| State | Rule |
|---|---|
| FRESH | ≤ 30 min |
| AGING | ≤ 90 min |
| STALE | > 90 min |
| FUTURE | more than 5 min ahead (a clock fault) |
| UNKNOWN | no capture time |

A saved Card price hours old is stored as STALE, and the page says so. EdgeDesk never implies a price is current when its freshness cannot be verified.

**Protection:** an UPDATE raises for every caller, the service role included. There is no delete policy, so a snapshot goes only with its position (or its account).

## 5. Model versioning

The snapshot keeps whatever versions the research carried:

- `model_version`, `calibration_version`, `pricing_version`, `engine`
- `research_id` (the decision id)

`lib/edgedesk_opportunity.js` now carries a game decision's `model_version`, `calibration_version` and `pricing_model_version` into the Card entry, so a Card snapshot names its model. When no version was carried, the record says "version not recorded" rather than inventing one.

## 6. Methodology versioning and recalculation rules

Every method is a row in `portfolio_methodology`:

- `process_v1`
- `snapshot_v1`
- `context_quality_v1`
- `edge_capture_v1`
- `outcome_class_v1`
- `baseline_v1`
- `insight_v1`
- `experiment_v1`

Each row has an effective date, a summary and a recalculation rule. A published row can never be edited or deleted.

- **LIVE** (process score, context quality, edge capture). Derived on read from the recorded inputs. A new version applies to all history at once, and every output names the version that produced it.
- **APPEND** (snapshot, outcome class, baseline, insight, experiment). A persisted conclusion keeps the version it was made under. A new version writes new rows beside the old ones and never over them. For example, an outcome class row is unique by `(position, methodology_version, inputs_hash)`.

**Migrating to a new version:**

1. Insert the new row with `supersedes`.
2. Change the function.
3. Let new rows accrue.

Old rows stay as history. A recalculation never deletes a conclusion.

## 7. The market path

**What it is built from:**

- the snapshot (DECISION, at its capture time)
- the position (ENTRY)
- the journal (OPEN, RESEARCH, CLOSE)
- one legitimate feed: `book_quote_ticks`

**How the feed is read.** `portfolio_svc_attach_feed_path` is service-only and scheduled every 15 minutes in `portfolio_sync_cron.sql`. It runs only for positions whose snapshot names an exact capture key (`sig_key`) at the position's own line. It reads the reader's own book's ticks between the decision and the start. When the journal has no close, it records the last tick at or before the start as an `EDGEDESK_CAPTURE` close, and only if that tick is within 6 hours of the start. It never matches by name, and never uses another book, another line or a live tick.

**What is not on the path:**

- A researched price that was filled from the snapshot is not listed twice.
- A price the reader typed has no observation time, so it is stamped RECORDED.

**Limitation.** Football and props Card entries carry no `sig_key` today. Their path holds the decision, entry and recorded prices only, and the page says that no later prices were observed.

## 8. Edge Capture (`edge_capture_v1`)

All values are positive when they favour the reader.

**Inputs.** Prices are decimal odds for a sportsbook and contract prices (0–1) for a prediction market. The decision price is the snapshot's; otherwise it is the journal's research price, if recorded before the event.

**Definitions:**

| Measure | Definition |
|---|---|
| edge at decision | Model probability × decision price − 1. For a contract: probability ÷ price − 1. Uses the same `portfolio_model_ev`. |
| edge at entry | The same at the entry price. |
| capture ratio | Edge at entry ÷ edge at decision, only when the decision edge is positive. Above 1 means a better price than at the decision. |
| slip / CLV | In % of price when the line is unchanged; in points when it moved (`portfolio_line_gain`). |

A line has moved only when both lines are known and differ, which is the journal's convention.

**Basis:**

- **PRICE:** sportsbook, same line
- **POINTS:** a line moved
- **CONTRACT:** prediction market
- **NONE:** a parlay, a live entry, or no entry price

**Limitations,** each returned as a code and shown in words:

- **American odds** are converted exactly; implied probabilities include the book margin, and no-vig is not computed without the other side.
- **Points are never converted into probability.**
- **A contract price is read as a probability,** without fees.
- **Props** close in thinner markets, so their close is a weaker reference.
- **Parlays** are not decomposed.
- **Live entries** are not comparable with pre-event prices.
- **A missing model probability, decision price or close** leaves that figure null. It is never estimated.

Parity: 400 random positions, SQL = JS, every field and limitation.

## 9. Evidence lineage

**Each process-memory observation stores:**

- the group and comparison moments (n, sum, sum of squares)
- the same group split at the moment of first detection (`before_first`, `since_first`)
- **the exact positions used** (ids, up to 1,000, plus the count)
- **those excluded, with the reason:** `NO_CLOSING_PRICE`, `LINE_MOVED_CLV_IN_POINTS`, `NOT_GRADED`, `NOT_SETTLED`, `NO_RETURN`
- the window, the time zone, the confidence and `methodology_version`
- the generated timestamp

**How groups are assigned.** The page only names the group (dimension and key) and the window. The server computes every number. `portfolio_fact_key` is held equal to `portfolio_cells()` dimension by dimension (a test checks every cell).

**Other lineage:**

- **Experiments** store the window's and the baseline's moments and positions.
- **The baseline** stores its 30 position ids.

**Status (`insight_v1`).** Positions placed after first detection are compared with those before it, using Welch's test at 95%:

| Status | Rule |
|---|---|
| IMPROVING | The interval excludes zero in the reader's favour |
| DECLINED | The interval excludes zero against the reader |
| UNCHANGED | The interval includes zero |
| INSUFFICIENT NEW EVIDENCE | Fewer than 10 new positions |

It is never a comparison of two letters.

## 10. Context quality (`context_quality_v1`)

| Quality | Rule |
|---|---|
| FULL | A pre-event snapshot with both EdgeDesk's model state and a market price |
| STRONG | Pre-event decision context with a price reference: a snapshot with one of the two, or journal reasoning plus a research or opening price recorded before the event |
| PARTIAL | Pre-event reasoning without a price reference, or market context (a close, an opening price, a feed price) without pre-event reasoning |
| RESULT_ONLY | The wager and its result |

**Imported history is valued but nothing is invented.** A CSV or synced position placed in the past cannot take a snapshot (it would be after the fact). Without a close it is RESULT_ONLY: ungraded and never classified.

The facts' older `evidence` field (FULL_CONTEXT / PARTIAL_CONTEXT / RESULT_ONLY) is unchanged. `context_quality` refines it, and FULL_CONTEXT splits into FULL and STRONG.

## 11. Outcome classes (`outcome_class_v1`)

These use the same bands as the process matrix: GOOD ≥ 66, AVERAGE 45–66, POOR < 45.

| Result | Class |
|---|---|
| A settled WIN or LOSS with a grade | GOOD_WIN, GOOD_LOSS, BAD_WIN, BAD_LOSS, or AVERAGE_PROCESS |
| No grade, or result-only context | NOT_CLASSIFIED (never from the result alone) |
| Push, void or cash-out | NOT_APPLICABLE |

Classes are persisted by `portfolio_classify_outcomes()`, which the Film Room calls. A close recorded later changes the grade, so it writes a new row and keeps the earlier one.

## 12. Reconciliation without duplicates

- **CSV import.** A row matching a bet the reader already recorded in EdgeDesk becomes NEEDS_REVIEW, with a `MATCHES_RECORDED_POSITION` issue naming that position. To match, it must have the same platform, selection and line, the same price and stake, and be placed within 36 hours. It is not imported unless the reader chooses to. Skipping it keeps the recorded bet with its decision record.
- **Kalshi / Polymarket sync.** When exactly one hand-recorded position has the same normalized contract (platform, event, market, side) and no platform id, the synced record ADOPTS it. The position takes the platform's id and fills; its journal, snapshot and path stay. Two or more matches are never guessed between: both stay, the synced one arrives, and a `POSSIBLE_DUPLICATE` issue is reported.

## 13. Privacy

**Personal Decision Records are private user data:**

- Every table is owner-only under row level security.
- No function shares one reader's activity with another.
- Nothing here is used to train a shared model.

**Export.** `portfolio_export()`, from Portfolio → Accounts → Your data → *Download everything (JSON)*. It contains every Portfolio and Decision Record table the reader owns: positions, fills, journal, snapshots, path, reflections, classes, baseline, patterns and observations, rules, experiments, Card events, imports and their rows, accounts, and the methodology. Stored credentials and sync cursors are never included. The CSV export stays as well. Nothing is held hostage.

**Delete.** `portfolio_delete_everything('DELETE MY PORTFOLIO')`, from *Delete my Portfolio…*, which requires the typed phrase. It removes every row above, the stored platform credentials and this file's notices. Deleting the account in `auth.users` cascades through every Decision Record table, and a test proves both.

**Analytics** carries no position content. The only new events are navigation labels (`record:card`, `ai:portfolio:record`).

**Ask EdgeDesk about this decision** builds its answer on the page from the record (`EDDecisionRecord.explain`) and sends nothing anywhere.

**Known gap, outside this file.** Some older reader tables carry `user_id` without a foreign key to `auth.users`: `card_opportunities`, `user_bets`, `stake_recommendations`, `recommendation_ledger`, `research_packets`, `stake_recommendation_responses` and `external_positions`. Account deletion leaves them orphaned. `stake_recommendations` and `recommendation_ledger` have no-delete audit rules. Closing this needs a retention decision, so it is listed under deferred work rather than changed here.

## 14. Aggregate intelligence — designed, not enabled

**Nothing aggregates across readers except the operator metrics below.** If cross-reader intelligence is ever built, it must:

1. **Have a documented privacy basis, opt-in consent per purpose, and legal review before any code reads across readers.**
2. **Use only `portfolio_methodology`-versioned, de-identified aggregates.** Each cell needs at least k = 20 readers and 100 positions, with small cells suppressed.
3. **Never expose an individual position, a reader's activity, or a crowd-direction signal** ("72% of EdgeDesk users are on Team X"). Nothing is shown to readers as a betting signal.
4. **Be computed in a separate, audited function.** It must not reuse the reader functions above.

## 15. Moat metrics (operator only)

`portfolio_admin_moat_metrics(days)` is restricted to `portfolio_is_admin()`. It returns counts and shares only, and withholds any figure drawn from fewer than 5 readers:

- readers with positions
- the share with a decision snapshot, with pre-event context, and with a FULL snapshot
- the share of settled positions with a close, and reviewed
- snapshots by origin
- path points per snapshot
- the share of Card entries recorded
- experiments concluded
- readers at 10 / 30 / 100 positions with context

These are internal measures of data depth. They are never shown to readers and never sent to analytics.

## 16. Continuity (what the page does with it)

- **The Card.** Every saved entry has **View research**, **Before you enter**, **Record position** and **Remove**.
- **Record position** opens Portfolio's record sheet:
  - prefilled from what the Card froze: book → platform, event, pick, line, price, market type, start, and stake as units × the reader's unit when known;
  - where the values came from, and how old the saved price is;
  - **Before You Enter** first, from the reader's own record.
- **On save:** the position, its journal, the snapshot, the path, and the Card's RECORDED event. The calendar and Process read it at once.
- **Search** (Research's search) lists the reader's Card entries and recorded positions beside research. A position opens its Decision Record.
- **Notifications.** A settled position puts one "decision record ready to review" notice in the bell, and an ended experiment one "result can be recorded". Each has its own switch under Settings › Research alerts › *Your decisions*. They never prompt a wager.
- **Process:**
  - The Overview's patterns carry FIRST DETECTED · THEN · NOW · STATUS.
  - *Since your baseline* tests change against the frozen first 30 graded decisions.
  - *Analysis depth* says what 10 / 30 / 100 graded decisions make possible. It is phrased as what becomes possible, never as a target, and says depth comes from recording and importing, not from placing more.
  - Up to three *Questions from your own record*, each with its WHY.
- **Experiments** freeze their success criteria and baseline. *Record the result* runs the pre-registered test on the evidence the server froze, and the server refuses a conclusion that evidence does not allow. The reader's reflection is written once.

## 17. Deferred, on purpose

- **A server-side assistant turn grounded in the record.** "Ask about this decision" is answered on the page. Follow-up questions go to the research desk, which does not see the record. Grounding them means inlining `lib/edgedesk_decision_record.js` into `supabase/functions/edgedesk_ai` and adding a deterministic turn.
- **Feed keys for Card entries.** Football and props entries need an exact `sig_key` before `book_quote_ticks` can extend their path and capture their close.
- **Merge for sportsbook sync.** No sportsbook connector exists; CSV review covers sportsbooks today.
- **Safe automatic settlement** from EdgeDesk's graded results, as a proposal the reader confirms, never silent.
- **Push and email delivery** of the two notices (in-app only today).
- **Account erasure across the older reader tables** listed in §13.
- **Cross-reader intelligence** (§14).
