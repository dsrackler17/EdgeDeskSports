# System-wide data integrity audit — Phase 1 (read-only)

Audited 2026-10-08 against `claude/serene-fermat-qibuu8` at `8c46beaf`, the
committed CFB terminal build of **2026-10-08T19:07:42Z**, the committed FBS
slate of **19:18:16Z**, and the cfbfastR 2026 schedule feed fetched at 19:41Z.
Nothing was changed while auditing. Production Supabase is not reachable from
this environment (the proxy answers `403` for `iattxbkbufslbauoumga.supabase.co`),
so the in-app board's live `signals` rows could not be read. Everything below is
either measured on committed data or proved by reading the code that renders
the board. Each finding cites the file and line.

The reproduction commands are at the end. Everything the audit measured is also
pinned by `tools/integrity/regression.test.js`.

---

## 0. The October 8 snapshot reconciles arithmetically; three of its definitions are wrong

| Figure on the board | Value | How the board computes it (`app.html fbP4Counts`, :57405) |
|---|---|---|
| games displayed | 117 | every pregame game in a **rolling 10-day window** (`FBP4_LOOKAHEAD_D = 10`, :50526) |
| with a market quote | 73 | `mkt.spread_line != null`, **stale and faulted quotes included** |
| research-grade | 49 | RESEARCH + **INVESTIGATE** + VERIFIED MAJOR |
| Worth Researching | 20 | canonical `WORTH_RESEARCHING` |
| Investigate | 29 | canonical `INVESTIGATE` |
| Market Aligned | 23 | board word AGREEMENT = `MARKET_ALIGNED` **+ `NEAR_PICKEM`** |
| Market Fault | 1 | canonical `MARKET_FAULT` |
| No Market | 44 | board word NO MARKET (STALE QUOTE is a separate word) |

The arithmetic holds:

- 20 + 29 + 23 + 1 + 44 = 117;
- 73 = 117 − 44;
- 49 = 20 + 29.

The definitions do not:

1. **"Research-grade" counts INVESTIGATE.** INVESTIGATE means a 7+ point gap that
   has *not* cleared the integrity gate (`lib/edgedesk_canon.js:299`). Elsewhere
   the product defines research-grade as "games that clear every research gate"
   (`lib/edgedesk_personal_ui.js:591`). So 29 of the 49 "research-grade" games
   are, by EdgeDesk's own definition, unverified. Under the corrected definition
   the snapshot has **20** research-grade games (WORTH RESEARCHING + VERIFIED
   MAJOR) and **29** needing investigation.
2. **"With a market quote" counts the one MARKET FAULT** (and any STALE QUOTE).
   A faulted quote is not a usable market comparison. Under the corrected
   definition the snapshot has **72** games with a usable market (if none were
   stale), 1 faulted, and 44 with none.
3. **The 117 spans two weeks.** The board is a 10-day window, not a week. In the
   committed build an hour earlier, **62 of 117** rows were week 7, and **43** of
   those carried placeholder kickoffs (§2).

A fourth number deserves attention, but no code change: **29 of 73 priced games
(40%) show a 7+ point model–market gap**. A calibrated college model sits well
under that rate. The causes this audit found push the rate up:

- comparisons against opener and look-ahead lines;
- week-7 games priced before week-6 results;
- regime-change programmes (§4).

They are fixed at the source below. **No threshold was moved to bring the count
down.**

---

## 1. Problem A — contradictory model-market gaps

### 1a. Ole Miss at Vanderbilt: "Ole Miss -1.0 · market -9.5 · gap 9.3"

**Root cause: a display floor.** For a near pick'em (|raw margin| < 1), the
engine publishes `display_fair_spread = ±1` (`football/cfb_p4/engine.js:2396-2414`).
The board prints that floor through `fbFairDisp` (`app.html:48091`), and the
page's own comment says "every gap … keeps reading fair_spread". The gap is
measured from the **raw** margin (`lib/cfb_research_view.js:136`). The model's
real number was Ole Miss −0.2:

- the gap is |9.5 − 0.2| = **9.3**;
- the reader sees −1.0 and computes **8.5**.

This is a display bug, not rounding, stale data or a mixed market. The same
pattern appears at every site that prints `fbFairDisp` beside a gap
(`app.html:57640`, `57913`, `57950`, `57962`, `57970`, `58509`, `61199`, `61323`).
Four near-pick'em games carry a gap in the committed build. In one of them the
floor *hides* a threshold crossing:

| Game | Raw margin | Floored display | Market | Shown gap | Gap from displayed figures |
|---|---|---|---|---|---|
| Boise State @ Fresno State | Fresno −0.1 | Fresno −1.0 | Boise −6.5 | 6.6 | **7.5** |
| Ole Miss @ Vanderbilt | Ole Miss −0.2 | Ole Miss −1.0 | Ole Miss −9.6 | 9.5 | 8.6 |

### 1b. Independent rounding (the terminal)

`lib/cfb_terminal.js:372-379` rounds the fair line, the consensus and the
full-precision gap **separately**. Measured: **11 of the 69** priced rows that print all three figures (70 priced) show a gap
that cannot be reproduced from the two displayed lines. Examples:

| Game | Fair (shown) | Market (shown) | Gap (shown) | Gap from displayed figures |
|---|---|---|---|---|
| Ole Miss @ Vanderbilt | −0.2 | −9.6 | 9.5 | 9.4 |
| Hawai'i @ Arizona State | −11.9 | −20.9 | 8.9 | 9.0 |
| Wyoming @ San José State | −5.9 | −5.4 | 0.6 | 0.5 |

### 1c. Projected scores

The projected score line is rounded separately from the margin and the total.
Measured: **65 of 114** score lines do not reconcile with the fair line at
display precision. Examples:

- "South Carolina 25.3 — Florida 32.6" (a 7.3 margin) beside "Florida −7.4";
- "Ole Miss 29.1 — Vanderbilt 29" (0.1) beside "Ole Miss −0.2".

### 1d. Totals

No CFB market total is carried into the content engine. The only total there
is the model's (`lib/content_engine.js` `cfbPacket`). No total gap is printed
anywhere, so there was no mismatch to measure. The new calculation layer
covers totals with the same rule anyway.

**Fix (Phase 2).**

- `lib/edgedesk_calc.js` is now the one calculation layer, with one rounding
  policy (half away from zero, 0.1 pt) and one rule: **a displayed difference is
  the difference of the displayed inputs**.
- Comparisons show the model's real number. The one-point floor survives only as
  the `near pick'em` tag. The engine output is untouched.

---

## 2. Problem B — games in the wrong time window

**Root cause: the feed's TBD flag is dropped.** The cfbfastR schedule carries a
`start_time_tbd` column.

- `football/fbs/build_coverage.js normRows` (:157-167) drops it, and the browser's
  row mapping does the same.
- So a placeholder midnight-Eastern time (`T04:00:00Z` = **FRI 11:00p Central**)
  becomes a confirmed kickoff.

Measured against the feed:

| Slate rows | Feed `start_time_tbd` | Kickoff |
|---|---|---|
| 55 week 6 | FALSE | real |
| 19 week 7 | FALSE | real |
| **43 week 7** | **TRUE** | **04:00Z placeholder** |

A clock rule alone would be wrong. The feed also carries a real 04:00Z kickoff:
Sacramento State @ Hawai'i, 2026-11-29T04:00Z, `start_time_tbd = FALSE`.

**Second cause: no week scoping.**

- The terminal takes every future slate game (`football/cfb_terminal/build.js:1063`).
- The board uses a 10-day window.
- Week 7 games, including **Florida @ Texas** and **Wisconsin @ UCLA** (both
  placeholders), are priced and labelled INVESTIGATE on the current-week board.

**What is not the cause.** The audit found no timezone conversion error: every
real kickoff round-trips. It found no wrongly joined event in the committed
ledger, which is keyed by the schedule's own game id. The in-app board's browser
join is a separate risk (`docs/cfb-board-integrity/AUDIT.md` §3.1, still open).

**Content engine.** It copies kickoffs unverified and has no TBD handling
(`lib/content_engine.js:278`). Its week choice is "the earliest week with a
future kickoff" (:622), so one postponed game can pin it to an old week.

**Every other path drops the flag too:**

- `app.html fbP4Schedule` (:51038-51066), both the CSV branch and the Supabase
  fallback;
- `football/health/daily_check.js p4NormSchedRow` (:341);
- every script that reuses `normRows`.

**Displays.** `fbP4KickLabel` (:57163) and `research/cfb/terminal.js when()`
(:25) print browser-local times with no zone label. There is no time-zone
selector. Downstream, a TBD placeholder is mislabelled:

- the content engine prints it as "Sat., Oct. 17, 12 a.m. ET"
  (`lib/content_engine.js:258-278`);
- the editorial featured selector files it as "Saturday morning"
  (`tools/editorial/featured.js:123`).

**No canonical game status.** At least seven classifiers exist:

- `collective/week.js`;
- `football/cfb_lab/market.js`;
- `football/cfb_lab/settle.js`;
- `lib/football_grading.js`;
- `lib/edgedesk_decision.js`;
- `football/props/grade.js`;
- the V2 Python.

None of them has a tentative state.

**Week boundaries disagree.** Three date rules are in use:

| Rule | Where |
|---|---|
| Tue 00:00 America/Chicago | the audit tools |
| Tue 07:00 UTC | `games/lib/week.js` |
| Tue 12:00 UTC freeze | the replay |

At least seven feed-week pickers also disagree. One of them,
`football/cfb_terminal/build.js:1100`, sorts week numbers **as strings**, so a
week 9–10 slate is labelled week 10.

**Fix (Phase 2).**

- `lib/edgedesk_schedule.js` gives every game a kickoff verification state, a
  game status, a UTC instant, a local display in the reader's time zone, and a
  current/future-week scope.
- The week is the **feed's own `week` field**, the authoritative event record.
- The current week is the lowest week that still has a verified, unstarted
  game inside its own schedule cluster, so one rescheduled game cannot pin the
  board to an old week.
- The slate keeps `start_time_tbd`.
- An unverified time renders as "time TBA" and is blocked from publication.

---

## 3. Problem C — research labels vs decisions

Two systems already exist and are kept apart:

- **research status**, from `lib/edgedesk_canon.js researchStatus`;
- **the bettor decision**, from `lib/edgedesk_decision.js`.

A third, the governed engine (`football/cfb_decision`), maps WAIT onto WATCH.
None of them merges the two answers. What is missing is the explanation: the
row shows two chips and no sentence saying why they differ.

| Combination | What actually happens |
|---|---|
| WORTH RESEARCHING + PASS | A 2–7 pt gap, but the price fails the decision rules (typically calibrated EV ≤ 0). |
| INVESTIGATE + WATCH | An unverified 7+ gap. The decision engine caps anything unverified, or any implausible EV, at WATCH. |
| MARKET ALIGNED + WATCH | No research-sized gap, but one book's price is off consensus (a price-anomaly WATCH). |
| WORTH RESEARCHING + NO DECISION | Research reads the consensus spread. The decision layer needs a fresh *two-sided priced* quote and found none (Layer A). |

All four are legitimate. None of them is explained on screen.

**Fix (Phase 3).** `EDIntegrity.explainStatuses` returns both answers. Each comes
with the rules that passed and failed, and the reason the two differ, in one
sentence each. Research-grade no longer includes INVESTIGATE.

---

## 4. Problem D — raw vs calibrated EV

- **The two EV layers price different selections.** The `ev` layer (`lib/edgedesk_ev.js`
  via `football/cfb_terminal/build.js:869`) selects the side with the best
  *calibrated* EV. `quote_ev` (`lib/edgedesk_quote_ev.js`) selects the best *raw*
  quote. Measured: **4 of the 7** priced games have the two layers on opposite
  sides. One build row reads:
  - Tulane @ Army: `ev` = Tulane +3 −105, raw −27.2%, calibrated −2.2%;
  - `quote_ev` = Army −3 −115, raw **+17.8%**, calibrated −6.1%.

  Printing "raw +17.8% / calibrated −2.2%" would pair two different bets.
- **Calibration is compatible within each layer.** Each layer's raw and
  calibrated figures use the same quote, price, timestamp and push model
  (`edgedesk_quote_ev.js:505-600`, push-aware; break-even = 1/decimal, checked).
- **The calibrator is PROMOTED, and it maps the model's cover probability close
  to 50% at the market line.** For example, Army −3: raw 63.6% becomes about
  50%. That says the out-of-sample record shows no skill in the raw cover
  probability at these gaps. It is the honest reason a large raw EV is
  rejected, and the board does not say so in words.
- **The bettor decision engine already refuses raw EV as an edge** (Layer B
  ranks on risk-adjusted EV, and an implausible raw EV is capped at WATCH ·
  PRICE ANOMALY). Not changed.

**Fix (Phase 3).**

- `EDCalc.evPair` refuses to pair raw and calibrated EV unless the selection,
  line, price, book and capture time are identical.
- `EDIntegrity` rule `DEC.EV_PAIR` blocks a raw/calibrated pair *within one
  layer* that describes different selections, everywhere but the research
  dashboard; `DEC.EV_LAYERS` warns whenever the two layers chose different bets
  and blocks the moment a surface prints them as one pair.
- `EDIntegrity.explainEv` states why a large raw edge was rejected.

---

## 5. Problem E — market anomalies

`football/cfb_lab/integrity.js` already detects most of Problem E:

- impossible values;
- wrong game (teams, orientation, kickoff);
- MAD outliers (quarantined, not discarded);
- one book's spread and moneyline naming different favourites;
- a two-way market below fair or above a 30% hold;
- identical side prices;
- uncorroborated jumps;
- stale and degraded consensus.

Missing:

- **duplicate quotes**;
- **alternate lines misfiled as main lines**;
- **suspended markets**;
- **non-equivalent market definitions compared** (main vs alternate, a game vs
  a half, a spread vs a total).

The in-app board's market path is still separate from the Lab's: its consensus
comes from `public.signals` in the browser. Its root causes are listed in
`docs/cfb-board-integrity/AUDIT.md`. They need a production RPC that was
proposed on 2026-09-30 and never approved. That remains the largest open item
(§10).

**Fix (Phase 2).**

- The four missing checks are added to `football/cfb_lab/integrity.js`. They
  quarantine, never delete.
- `EDIntegrity` rule `MKT.QUARANTINE` blocks a quarantined quote inside the
  consensus from decisions and publisher-facing surfaces (it warns on the
  research dashboard).

---

## 6. Quarterbacks and availability

The CFB QB status has two values, both **inferred from play-by-play
attribution, not from any report**:

| Status | Rows | Meaning |
|---|---|---|
| PREVIOUS_GAME | 215 | started the last game, nothing announced |
| COMPETITION | 19 | two QBs shared recent dropbacks (e.g. 57% / 38%) |

The content engine then prints:

- "neither starting quarterback is confirmed … no starter has been announced"
  for every PREVIOUS_GAME pair (`lib/content_engine.js:1299-1301`);
- "the quarterback job is unsettled" for every COMPETITION.

That is the Week 6 article's repeated claim. The absence of an announcement
became a claim of uncertainty. The terminal does the same: it lists "expected,
not confirmed" as a *moderate* risk on every game (`lib/cfb_terminal.js:897`).

**Fix (Phase 4).**

- `lib/edgedesk_availability.js` classifies every player as Confirmed active,
  Expected starter, Genuine competition, Questionable, Ruled out, Unknown or Not
  verified.
- A classification other than Expected starter needs a sourced report.
- Prose may assert uncertainty only for a sourced Genuine competition,
  Questionable or Ruled out. A dropback split is printed as a measured fact,
  never as a controversy.

---

## 7. Content engine

| Finding | Where |
|---|---|
| A number passes the check if it appears **anywhere** in the evidence, not in the game it is attached to | `validate` numbers check, lib:1739, `evidenceOf` lib:1650 |
| The database accepts the client's `checks_ok` without re-running anything | `supabase/content_engine.sql:778, 823` |
| Approval and send never compare `research_hash`; changed research after approval is a banner only | SQL:724-732, 883-902, 1282-1339 |
| A packet's "current" market is frozen at discovery and never re-judged | `cfbPacket` |
| Budget is calls per UTC day; no monthly cap, no dollars, no tokens; a failed call is not refunded | SQL:1067-1082, lib:2222 |
| No in-flight lock on AI drafting (two concurrent drafts both spend) | SQL article doors |
| Formats: CFB weekly, NFL weekly, trending, market discrepancy, custom. Missing: storylines, deep dive, performance review | lib:84-115 |

---

## 8. Reliability and confidence — what each number actually measures

From the code, not from the labels:

| Term | Source | What it is | What it is not |
|---|---|---|---|
| Model win probability | `engine.js winProb` (normal CDF of margin / σ) | the model's probability under its own distribution | calibrated: it has not been shown to beat the market |
| Statistical uncertainty | σ (14.6–15.7 pts, clamped), interval_80 | the model's own spread of outcomes | a confidence in the pick |
| Football confidence (0–100) | `scores.confidence` | how complete the inputs are, weighted by importance | a probability of being right |
| Reliability (0–100) | `lib/cfb_reliability.js`, six components with hard gates | trust in input completeness, freshness, consistency and stability | a probability; a high score is **not** evidence the prediction is correct |
| Market freshness | quote age vs the 180-min rule | whether a price exists now | price quality |
| Calibration | `football/cfb_ev` calibrator, status PROMOTED | out-of-sample mapping of the model's cover probability | evidence of an edge (it maps to about 50%) |
| Decision readiness | Layer A of `lib/edgedesk_decision.js` | whether a wager can be evaluated at all | whether it should be made |

These are written out in plain English in `docs/system-integrity/RELIABILITY.md`.

---

## 9. Calculation paths inventoried

| Quantity | Paths found | Consistent before? |
|---|---|---|
| Model-market spread gap | `cfb_research_view.marketGap` (raw), `cfb_terminal` disagreement (raw, rounded separately), `app.html fbP4Row` (raw), `content_engine gapOf` (own), `edgedesk_canon.researchStatusFromProjection` (raw) | **No**: display floor and independent rounding |
| Displayed fair line | engine `display_fair_spread` (floored), `fbFairDisp`, `cfb_research_view.fairLine`, terminal `fair_text` (raw 0.1), content `modelDisplay` | **No**: floored in the app, raw in the terminal |
| Projected score | engine score, terminal `projected_score.text`, content `scoreLine` | **No** (65 of 114) |
| No-vig / EV | `edgedesk_quote_ev` (push-aware), `research_core`, `edgedesk_ev`, `edgedesk_market` | per layer, yes; **across layers, different selections** |
| Kickoff | feed → slate (TBD dropped) → terminal → content (`whenText`) | **No** (TBD lost) |
| Week | feed `week`; board 10-day window; terminal none; content `chooseWeek` | **No** |

---

## 10. What this audit could not settle

- **The live in-app board.** Its consensus is formed in the browser from
  `public.signals` (`docs/cfb-board-integrity/AUDIT.md` §1–3). The 73 / 44 split
  and the single MARKET FAULT come from that path. The production RPC proposed
  there (`cfb_board_market`) is still unapproved and undeployed. This change
  gives the board the canonical calculation and the integrity warnings. It does
  **not** move the board's quote join into the database.
- **Calibration quality on live data.** It can only be measured on graded live
  games. The backtest-only calibration report is printed as backtest.

---

## Reproduce

```
node tools/integrity/audit.js            # every figure in §0–§6 from committed data
node tools/integrity/regression.test.js  # the regression cases, including these findings
```
