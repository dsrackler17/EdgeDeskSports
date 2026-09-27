# CFB research terminal — canonical terminology

One definition per word, used identically on the research page, the queue, the
brief, the record, the assistant and the LLM explanation boundary. The source of
truth is `lib/cfb_terminal.js` (`T.TERMS`, `T.STATUS`, `T.LEGACY_MAP`). The page's
**Terms** tab renders the same objects, so this document and the product cannot
drift.

## The words

| Term | Definition |
|---|---|
| **EDGEDESK FAIR** | The spread the governance champion model makes the game from football information alone. The market never enters it. Today the champion is V1 (`edgedesk_cfb_p4_v1.0.0`); the build reads the champion from `football/cfb_lab/governance/model_roles.jsonl`, so a promotion flows through without a code change. |
| **MARKET CONSENSUS** | The median current spread across the sportsbooks the Model Lab captured for the game, from quotes inside the freshness window (`cfb_decision_policy_v1.stale_minutes`, 180 min). |
| **MODEL GAP** | EdgeDesk fair minus market consensus, in points, stated toward the team EdgeDesk likes more than the market does. |
| **COVER PROBABILITY** | The chance a side covers a specific line, from the champion's own empirical college margin distribution (pushes excluded; the push chance is printed beside it). It is about the spread, not about who wins. |
| **WIN PROBABILITY** | The chance a team wins outright. Not the chance a spread bet wins. |
| **BREAK-EVEN** | The cover probability a price needs to break even: 52.4% at -110. |
| **EV** | Expected value per unit risked at a specific price, from the cover and push probabilities. EdgeDesk's model EV is research until the decision engine validates a calibration for the model that produced it (today it has not: see below). |
| **RELIABILITY** | How much EdgeDesk trusts the completeness, freshness and consistency of the inputs (0-100, `lib/cfb_reliability.js`). **Not a probability.** |
| **FOOTBALL CONFIDENCE** | How good EdgeDesk's football information is, weighted by how much each input matters (0-100). **Not a probability.** |
| **BET QUALITY** | Whether the decision engine (`football/cfb_decision/decision.js`) certifies a wager at a named price. Only the engine sets it; it fails closed. |
| **CLV** | Closing-line value in points: how far the market moved toward the side EdgeDesk took, from the recorded number to the close. Positive = the recorded number beat the close. Not the same as winning. |
| **VERIFIED DISAGREEMENT** | A 7+ point gap that passed every check of the integrity gate (`lib/cfb_disagreement.js`). Still not a bet. |
| **RESEARCH INTEREST** | How worth opening a game is (0-100). `100 × (0.35 disagreement + 0.20 price + 0.20 information quality + 0.15 model agreement + 0.10 movement)`, capped at 10 for DATA FAULT / NO MARKET and at 25 under reliability 60; an unverified major gap earns half disagreement and half price credit. Never a bet ranking. |
| **DATA QUALITY** | How complete and fresh the inputs are. Kept apart from every probability. |

## The status: seven words

The first rule that holds wins (`T.status`). Fail closed: anything that cannot be
established falls to the less actionable word.

| Status | Means | Rule, in order |
|---|---|---|
| **DATA FAULT** | EdgeDesk's number is unsafe until a data problem is explained. | engine refused the game; the integrity gate found a GAME/data fault; an unverified gap past the 21-pt guard |
| **NO MARKET** | No usable current quote. | no quote; or only quotes older than 180 min (a stale quote is never priced) |
| **INVESTIGATE** | A 7+ gap that has not passed the integrity checks — including a gap the market is too thin to verify. | gap ≥ 7 and not VERIFIED |
| **BET** | The decision engine certified a wager at a named price. | decision engine status BET (impossible today: policy `bet_enabled: false`) |
| **PASS** | Nothing worth acting on at this price, or EdgeDesk cannot trust its number. Always with the reason. | confidence < 35; reliability < 60; gap < 2; model SD > 6; cover ≤ break-even; edge < 1 pp with no reachable target |
| **WAIT** | A real disagreement, but not at this state: a named piece of information resolves first, or the price must reach a named number. **Never** a forecast that the line will move. | contested QB job on a research gap; fresh quotes carry no odds; edge under 1 pp but the 2 pp number is inside ordinary open-to-close movement (1.6 pts, `football/validation/movement_cfb.json`) |
| **RESEARCH** | A research-sized disagreement at a live price with usable confidence and reliability. Worth opening — not a certified bet. | otherwise |

**VERIFIED MAJOR DISAGREEMENT** is a badge, not an eighth status: it is the
strongest visual treatment on the page and is reserved for gaps that passed the
integrity gate.

## Older labels, and what they are now

| Older label (where) | Canonical |
|---|---|
| WORTH RESEARCHING (`lib/cfb_research_view.js`) | RESEARCH |
| MARKET ALIGNED, NEAR PICK'EM, LOW RELIABILITY | PASS |
| LIMITED DATA | PASS, or NO MARKET when the market is missing |
| MARKET FAULT | INVESTIGATE (a 7+ gap the market is too thin to verify) |
| VERIFIED MAJOR DISAGREEMENT | RESEARCH + the verified badge |
| LEAN (decision engine; the record's gap rule) | RESEARCH |
| NO_BET (decision engine, fail closed) | PASS, with the engine's reason as the first "why not bet" line |
| STALE QUOTE (app board) | NO MARKET |
| THIN DATA, AWAITING DATA (app board) | PASS |

The in-app board still prints its legacy labels (they feed CSV exports, articles,
the newsletter and ~15 test suites); every card now also carries the canonical
status beside the link to its research page. Converging the board is listed as a
remaining gap in `DELIVERABLE.md`.
