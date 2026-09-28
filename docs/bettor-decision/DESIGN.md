# The bettor decision layer

> **v2 (current): the unified football decision engine — BET / LEAN / WATCH /
> PASS / NO DECISION for the NFL and CFB alike.** See
> [`FOOTBALL_ENGINE_V2.md`](FOOTBALL_ENGINE_V2.md). It supersedes the v1
> hierarchy (§4), sizing (§13), anomaly review (§15) and configuration (§16)
> below: calibration, reliability, football confidence, a one-sided market, a
> market fault and an unverified gap no longer produce NO DECISION; NO DECISION
> is reserved for missing or invalid essential data and always names its
> blocker. The v1 text below is kept as the record of what shipped first.

EdgeDesk is research, not picks. Once the research and pricing engines hold
enough validated information, the product also says, in one word, whether the
**current price** qualifies: **BET / LEAN / WATCH / PASS / NO DECISION** (v1:
BET / WAIT / PASS / NO DECISION). That answer lives in one place
(`lib/edgedesk_decision.js`) and every surface prints it.

```
research engines ──► research status (how interesting?)        ─┐
pricing engines  ──► quote EV, calibrated EV, playable search    ├─► lib/edgedesk_decision.js ─► ONE decision object ─► every surface
integrity, QB, availability, reliability, market facts ──────────┘
```

## 1. Two questions, never merged

| | Research status | Bet decision |
|---|---|---|
| Question | Does the matchup deserve investigation? | Does the current price qualify for action? |
| Values | VERIFIED MAJOR · WORTH RESEARCHING · INVESTIGATE · MARKET ALIGNED · MARKET FAULT · DATA FAULT · NO MARKET · LIMITED DATA | BET · LEAN · WATCH · PASS · NO DECISION |
| Source | `lib/edgedesk_canon.js` (unchanged) | `lib/edgedesk_decision.js` |

A model–market gap is not a BET; a positive raw EV is not a BET; WORTH
RESEARCHING is not a BET; VERIFIED never implies BET (all pinned by tests).

The page hierarchy: **Level 1** what do I do · **Level 2** what exactly (side,
line, price, book, units, dollars, playable to) · **Level 3** why (calibrated
EV, fair line, reliability, market quality, stability) · **Level 4** the full
existing research, below the card, untouched.

## 2. The canonical object

`decide(input)` returns (abridged; `tools/bettor/decision.test.js` pins it):

```
decision, decision_label, headline, action_reason_code, action_reason_text,
side, side_key, market_type, selected_line, selected_odds, selected_book, selected_is_alternate,
recommended_units, shadow_units, strength, strength_label,
max_playable_line, max_acceptable_odds, playable {mode, min_line, max_odds, at_current_line_max_odds, frontier[], text},
model_fair_line/_text, consensus_market_line/_text, model_market_gap, market_movement_pts,
best_available, bet_price, reference_quote,                      (EDQuoteEV quote summaries)
cover_probability, push_probability, break_even_probability, calibrated_cover_probability,
raw_ev_pct, calibrated_ev_pct, risk_adjusted_score,
reliability_score/_label, confidence_score/_label, projection_stability, market_quality, independent_support_count,
research_status, research_label,
blockers[], warnings[], invalidation_conditions[], waiting_on[], next_check, bet_trigger,
alternatives {main, safer, better_value, aggressive}, anomaly {triggered, cleared, triggers[], checks[]}, sizing {…},
first_qualified_at, evaluated_at, quote_captured_at,
model_version, pricing_model_version, calibration_version, decision_engine_version, config_version, validation_state,
governance, decision_id (content hash)
```

Deterministic: the same input returns the same object and the same
`decision_id`. Units and dollars are never on a non-BET object.

## 3. Inputs: facts and pricing (`lib/edgedesk_decision_inputs.js`)

- **Facts** — everything apart from the price: research status and
  verification, integrity gates, market facts, reliability, confidence,
  stability, QB, availability, independent support per side, anomaly context,
  governance. `factsFromTerminal()` reads the research-terminal object; the
  build stores the result on every `board.json` row as `decision_facts`.
- **Pricing** — the `EDQuoteEV` model (the champion's curve; CFB's calibrated
  `side_prob` from `EDEV.shiftedSide`), the quotes and their evaluation. The
  build passes `quoteEvOf`'s; the page passes the live ones it already priced.
- The page overlays its live research view (`factsFromView`) and live market
  (`marketFromEvaluation`) on the build's facts. Without a build row the QB
  state is **unknown**, which the engine treats as unresolved (WAIT when the
  price is attractive), never as clean.

## 4. The hierarchy (first failure wins)

| Stage | Condition | Decision · code |
|---|---|---|
| Game state | no id · cancelled · postponed · suspended · started · duplicate · unresolved mapping · unsupported market | NO DECISION · `INVALID_GAME` `GAME_CANCELLED` `GAME_POSTPONED` `GAME_SUSPENDED` `GAME_STARTED` `DUPLICATE_GAME` `UNSUPPORTED_MARKET` |
| Integrity | data fault · orientation flag · no model · malformed projection · failed self-check · confidence unmeasured or < 35 | NO DECISION · `DATA_FAULT` `ORIENTATION_FAULT` `MODEL_UNAVAILABLE` `MALFORMED_PROJECTION` `SELF_CHECK_FAILED` `INSUFFICIENT_MODEL_DATA` |
| Market quality | no quotes · only stale quotes · a book whose two sides do not mirror · line off the board · no two-sided number · market fault · unverified 7+ gap | NO DECISION `NO_MARKET` `STALE_QUOTE` `ORIENTATION_FAULT` `NO_TWO_SIDED_MARKET` `MARKET_FAULT` `UNVERIFIED_LARGE_GAP` — or WAIT `QUOTE_REFRESH_PENDING` (a BET gone stale) `LINE_SUSPENDED` `MARKET_FAULT_UNDER_REVIEW` `MARKET_VERIFICATION_PENDING` when the raw signal is large (raw EV ≥ 3% and gap ≥ 2 pts) |
| Calibration | required and missing (all NFL today; CFB without a fresh anchor) | NO DECISION · `CALIBRATION_UNAVAILABLE` |
| Price | every two-sided quote priced; candidate = best risk-adjusted qualifying quote | — |
| Information | QB unresolved or unknown · major availability uncertainty | WAIT `QB_UNRESOLVED` `AVAILABILITY_PENDING` — only when the price qualifies; otherwise a warning on the PASS |
| Anomaly | triggered and not every check cleared | WAIT · `ANOMALY_REVIEW` (only when the price qualifies) |
| Calibrated advantage | nothing clears the calibrated-EV floor | PASS `CALIBRATED_EV_NEGATIVE` (raw > 0, calibrated ≤ 0) `CALIBRATED_EV_BELOW_THRESHOLD` `NO_MODEL_EDGE` `ALT_TAIL_ONLY` `PRICE_MOVED` (was BET, price changed) `PROJECTION_CHANGED` (was BET, same price) |
| Reliability etc. | reliability unmeasured / < 60 · unstable projection · market quality < ACCEPTABLE | NO DECISION `RELIABILITY_UNMEASURED` · PASS `LOW_RELIABILITY` `UNSTABLE_PROJECTION` `THIN_MARKET` |
| Sizing | nothing sizes | PASS · `SIZING_ZERO` |
| Governance | market's BET authority is a governed policy that has not enabled betting | PASS · `BET_AUTHORITY_DISABLED` |
| — | everything clears | **BET · `QUALIFIES`** |

WAIT always means **do not bet yet**. A huge EV never overrides an integrity
failure: integrity is checked before any price.

## 5. Bankroll and units (`lib/edgedesk_bankroll.js`)

Units are EdgeDesk's; dollars are the reader's. `unit_mode: 'percent'` (default:
1 unit = 1% of bankroll — $250 → $2.50, $2,500 → $25) or `'fixed'` (a typed
unit). A bankroll never changes a classification; the engine has no bankroll
input. Stored in `localStorage` (`edgedesk_bankroll_v1`) when signed out and in
`public.bankroll_settings` (new columns) when signed in — the same row the AI
desk's staking engine reads, which now honours `unit_mode = 'percent'`.

## 6. Transitions (`lib/edgedesk_decision_track.js` `transition`)

BET → BET / PRICE IMPROVED · BET → BET / STILL PLAYABLE · BET → PASS / PRICE
MOVED · BET → WAIT / NEW INFORMATION · WAIT → BET or PASS / INFORMATION
RESOLVED · NO DECISION → WAIT/BET/PASS / MARKET AVAILABLE · PASS → BET / PRICE
IMPROVED. Each carries from, to, kind, time, reason and both quotes
("Line moved from +6.5 (−102) to +4.5 (−102) and crossed EdgeDesk's playable
threshold").

## 7. Tracks

Per game: first qualified (set once, at the first BET, never moved), best
observed (only improves), current, current and previous decision, last
evaluated, last changed, closing (set once), and the append-only transitions.
The build replays them from its snapshot ledger; the page keeps a per-device
copy. A decision made while the calibration is still loading is shown as
provisional and never recorded.

## 8. Snapshots, CLV, performance

- `snapshot(d)` freezes everything needed to reconstruct the call (quote,
  probabilities, EVs, versions, gates, QB and availability state, anomaly
  checks, sizing trail, playable frontier) with a content id.
  `appendSnapshot` refuses duplicates, out-of-order and post-kickoff rows.
- CLV in points goes through `EDResearch.clvPoints` (+6.5 entry, +4.5 close →
  +2.0).
- The reader's entry is compared with the recommendation **as it was frozen at
  placement** (`compareEntry`: AT_EDGEDESK_PRICE / INSIDE_RANGE / OUTSIDE_RANGE /
  OTHER_SIDE).
- `performance(rows)`: per unit tier, sport, model version, market type and
  strength — bets, units risked and won, ROI, average CLV, observed vs expected
  cover — every group under 50 settled bets labelled "not evidence".

## 9. Exposure and guardrails

Total recommended units and dollars; grouped by sport, kickoff window, game,
team and market; a correlation note when two positions ride one game outcome;
a warning above the reader's maximum active exposure (default 5U). Nothing is
suppressed unless the reader turns exposure limiting on. No martingale, no
loss-chasing: nothing reads a past result.

## 10. The build stage (`football/cfb_terminal/decisions.js`)

`build.js` calls `decideGame` for every game on the same model, quotes and
evaluation as quote EV, adds `decision_facts` and the compact `bettor` to
every board row, writes `decisions.json` (decisions, tracks, counts, exposure,
per-tier performance, config, validation labels) and — on a normal build —
appends to `decisions/<season>/snapshots.jsonl` (one frozen snapshot per
material change) and `grades.jsonl` (once per BET snapshot, after the Lab's
consensus close and a FINAL). The build refuses to write a BET without an
exact quote, a playable boundary or a calibrated EV above the floor; a BET on
INVESTIGATE / MARKET FAULT / DATA FAULT; units above the unvalidated cap; or a
BET on an unvalidated alternate tail. `decisions_sync.js` mirrors the ledger
into Supabase (insert-only).

## 11. Storage (`supabase/bettor_decisions.sql`)

`bankroll_settings` + unit_mode, unit_percent, max_active_exposure_units,
exposure_limit_enabled, beginner_mode, decision_onboarding_at · `user_bets`
(owner-only RLS; the entry and its recommendation snapshot write-once; notes
and void status editable; grades service-role only) · `bettor_decision_snapshots`
and `bettor_decision_grades` (write-once, never deleted, pregame only, readable
by signed-in readers) · views `bettor_decision_transitions`,
`bettor_decision_performance`, `user_bet_clv`. The hourly personal job
(`tools/personal/research_state.js --only bets`) grades placed bets from the
committed record.

## 12. Surfaces (`lib/edgedesk_decision_ui.js`, `lib/edgedesk_decision.css`)

- **EDGEDESK ACTION** card on every CFB game panel and NFL card, above the
  research; the summary's Decision cell and the research terminal's decision
  chip read the same object.
- A decision chip on every FBS board row; an EdgeDesk Card banner on the
  Football overview.
- **EDGEDESK CARD** page (`#card`, More → EdgeDesk Card): header counts and
  exposure, filters (All, Bets, Watching, Pass, No decision, NFL, CFB, 0.25U …
  1.00U), sorts (kickoff, strongest qualified edge, calibrated EV, latest
  change, line movement), BET / WATCHING / PASS (collapsed) / NO DECISION
  (collapsed), exposure and correlation, the reader's recorded bets with CLV,
  per-tier performance, the validation note.
- Bankroll & units, a four-page onboarding (first visit), beginner mode,
  tooltips (the spec's definitions, verbatim, in `EDDecision.TOOLTIP`), BET
  PLACED with the entry compared against the frozen recommendation.
- Tones: BET the only filled badge and green rule; WAIT amber with DO NOT BET
  YET; PASS subdued; NO DECISION dashed and neutral. No tout words (a test
  scans every rendered card).

## 13. Sizing

Units = the minimum of (a) the calibrated-EV tier, (b) the tier whose
requirements all hold, (c) the composite-score tier, and (d) every cap —
rounded down. Raw EV never enters; nothing reads a result.

| Tier | Calibrated EV | Reliability | Market | Stability | Independent support | Composite | Other |
|---|---|---|---|---|---|---|---|
| 0.25U QUALIFIED | ≥ 1.5% | ≥ 60 | ACCEPTABLE | any measured-or-not (LOW is a PASS) | — | — | — |
| 0.50U STRONG | ≥ 3% | ≥ 70 | STRONG | MEDIUM | ≥ 1 | ≥ 55 | no material warning |
| 0.75U VERY STRONG | ≥ 5% | ≥ 80 | VERIFIED | HIGH | ≥ 2 | ≥ 70 | no material warning |
| 1.00U VERY STRONG | ≥ 7% | ≥ 85 | VERIFIED | HIGH | ≥ 2 | ≥ 82 | QB and availability certain, no anomaly, **tier validated** |

The composite (0–100) weights calibrated EV 25%, reliability 15%, market
quality 12%, stability 10%, independent support 8%, uncertainty 8%, integrity
completeness 8%, quote quality 6%, calibration maturity 5%, validation state
3%. Caps: 0.75U while no tier is validated (the 1.00U tier is recorded as
`shadow_units`); 0.50U after a cleared anomaly; 0.25U on a SEVERE extreme;
1.00U absolute. Strength = the final tier's label (Qualified / Strong / Very
strong), never the gap.

## 14. Playable to

For a BET at line L₀ and price P₀: walk the line toward fewer points while P₀
still clears (within the validated tail, at most 3 points), then find the worst
whole-cent price at each line (bisection on the decimal, rounded toward the
bettor). The corner (worst line, worst price there) clears; so does every
better line and price. Output: `+6.5 to +5.5 · up to −115`, `… or better ·
maximum −112`, or `CURRENT PRICE ONLY`. The boundary holds the rest of the
market where it is — the calibrated probability is anchored at the market line,
so if the consensus itself moves EdgeDesk re-prices every number (the card says
so). A PASS gets the mirror image: the **bet trigger** (the number or price
that would qualify).

## 15. Anomaly review

Triggers: gap ≥ 7, raw EV ≥ 20%, a sanity flag (EV over 25%, cover over 75%…),
favourite flip, large rating divergence, fewer than two fresh books, FCS, a
smaller-market team, a 3+ point move, inconsistent quotes (arbitrage, both
sides positive, non-monotone cover), book dispersion above 1.5 points, the EV
circuit breaker. Checks (PASS / FAIL / UNKNOWN — unknown never clears):
correct teams, orientation, spread sign, fresh quote, two-sided, multiple books
(required when calibrated EV ≥ 5%, raw ≥ 20% or gap ≥ 7), QB, availability,
model version, schedule, current season, adjustment bounds, independent
submodels, consistent quotes, book agreement, calibration survival, and the
circuit breaker's own verification. A cleared anomaly proceeds, capped; it is
never a bigger stake.

## 16. Configuration and validation state

`EDDecision.DEFAULT_CONFIG` (`bettor_decision_config_v1`) holds every
threshold, labelled `CONSERVATIVE_DEFAULT_UNVALIDATED`. Per market,
`bet_authority` is `BETTOR_RULES` (default for CFB and NFL spreads — BET when
these rules clear), `GOVERNED_POLICY` (BET only when the governed policy has
`bet_enabled`), or `NONE`. Totals and moneylines are unsupported until a
calibration exists.

## 17. Shadow and unvalidated (stated on every card)

- Every decision threshold and stake tier: configurable, conservative, **not
  empirically validated**.
- The 1.00U tier: shadow-only (`shadow_units`), until its own live validation is
  recorded in `sizing.validated_tiers`.
- The CFB calibrator is PROMOTED with maturity SHADOW; the governed CFB policy
  (`cfb_decision_policy_v1`) is SHADOW with `bet_enabled: false` and is still
  logged beside the new decision.
- NFL: no EV calibration exists, so NFL is NO DECISION.
- The per-tier record (`decisions.json` `performance`, Supabase
  `bettor_decision_performance`) is how the tiers will be recalibrated; under
  50 settled bets per tier it is descriptive only.
