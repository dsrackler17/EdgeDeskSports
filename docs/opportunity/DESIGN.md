# The connected research and decision system

> One object for a game market and for a player prop, so a reader can go from
> **game research** to **player-prop research** to **one combined Card**
> without rebuilding the relationship by hand. Research, not picks.

The code is [`lib/edgedesk_opportunity.js`](../../lib/edgedesk_opportunity.js)
(`EDOpportunity`, browser + Node + the AI edge function). It is a **connecting
layer**: every probability, EV, decision and unit it shows was produced by an
engine that already existed, and it never classifies anything a second way.

| Question | Answered by (unchanged) |
|---|---|
| Is there a wager at this game price? | `lib/edgedesk_decision.js` `EDDecision.decide` |
| What is this prop worth at this price? BET / LEAN / WATCH / PASS / NO DECISION? | `lib/edgedesk_props.js` `EDProps.evaluate` |
| Units → dollars, limits | `lib/edgedesk_bankroll.js` `EDBankroll` |
| Which game to open first? | `lib/research_priority.js` `EDResearchPriority.rank` |

## 1. Identity: one canonical event

A game and its props join on **`<league>|<game_id>`**: the research state's
`game_key` and the prop board's `game_id` are the same schedule id (nflverse
for the NFL, e.g. `2026_04_PIT_CLE`; ESPN for college, e.g. `401858245`).
Displayed team names are never the join. The sportsbook's own event id
(The Odds API) rides along as `provider_event_id` (`board.games[].event_id`).
Verified on the committed data: 16/16 NFL and 59/59 college board games match
the slate ids.

## 2. The Opportunity

```
type             GAME | PLAYER_PROP
sport / league   NFL | CFB
event            event_key, game_id, provider_event_id, home, away, kickoff
market           kind, key, label (a prop: category, yes/no)
selection        side, line, text
price            american, book, captured_at, age_minutes, fresh, books_at_line
model            probability, p_win, p_push, fair_american, projection, fair_line
market_view      consensus line, no-vig probability of the side, books
break_even, ev, edge_pp, disagreement_toward_pp, confidence (reliability for games)
decision         BET | LEAN | WATCH | PASS | NO_DECISION  (+ code, reason, caps, warnings)
units            calculateOpportunityUnits()
probability_source / probability_label / stage
player           (props only) id, name, team, position, status, sample, role
research         (props only) the research score and its parts
evaluated_at
```

Fields that do not apply are absent, never filled. `fromPropRow()` reads one
board row and its compact evaluation (the build's `row.e`, or the Props
page's re-priced one); `fromGameDecision()` reads the canonical decision.

## 3. The shared services (one implementation each)

| Function | What it is |
|---|---|
| `calculatePropEV(pWin, american, pPush)` | EV, break-even, edge at the exact price — `EDProps.expectedValue`, never −110 |
| `classifyPropDecision(prop, opts)` | `EDProps.evaluate`: the one prop classifier |
| `calculatePropResearchScore(opp, ctx)` | "what should a researcher open first?" (§4) — not the bet decision |
| `getEventPropSummary(board, gameId)` | one game's counts, capture state, best candidates (§5) |
| `getTopEventProps(board, gameId, n)` | its research-grade props, best first |
| `calculateOpportunityUnits(opp)` | the engine's units, capped for props by validation stage (§7) |

Research, the Props page, the Card and the AI desk all call these.

## 4. The prop research score

0–100, returned with every part so the order is debuggable. It orders
**reading**, not money.

| Part | Weight | Full credit at |
|---|---|---|
| EV | 20 | the engine's STRONG EV (`thresholds.strong.min_ev`, 10 %) |
| Probability edge | 15 | the engine's STRONG edge (7 pp) |
| Decision confidence | 20 | 100 |
| Market confirmation | 15 | four two-sided books (the kernel's liquidity basis) |
| Model vs no-vig, toward the side | 10 | `EDProps.CONFIG.strong_disagreement_pp` (5 pp) |
| Decision | 20 | BET 1 · LEAN 0.75 · WATCH 0.5 · PASS / NO DECISION 0 |

Multiplied by the kernel's own discounts, applied only at its cap thresholds
so confidence is not charged twice: an AGING price 0.85, a STALE price 0.5,
fewer than 3 games 0.6, an unstable role 0.75, a QUESTIONABLE or DOUBTFUL
player 0.7 (OUT 0), and the research view's reliability trust factor for the
game where one is scored. Minus: an uncorroborated extreme price 15, a tail
alternate 10, a single book 10, an unresolved QB 10, thin data completeness 5.

**Research grade** — a prop "worth researching" — needs a fresh price
(FRESH or AGING), positive EV, at least the engine's LEAN edge (2 pp),
decision confidence at the kernel's floor (40), a BET / LEAN / WATCH decision,
and a score of 60+. Only the weights and the 60 are new; every other number
is an existing EdgeDesk threshold.

## 5. Server-side aggregation

`football/props/build_summary.js` runs after every board build and writes
`football/props/<league>/summary.json` (NFL ≈ 90 KB, college ≈ 170 KB, against
1.3 / 2.2 MB boards). Per event: `total_props`, `projected_props`,
`priced_props`, `evaluated_props`, `research_grade_count`, `bet_count`,
`lean_count`, `watch_count`, `pass_count`, `no_decision_count`, `top_score`,
the best ≤ 4 `top_opportunities` with their explanation, `more`, the game
context, and the **capture state**:

| State | Meaning | What the page says |
|---|---|---|
| `PRICED` | at least one prop carries a captured price | the candidates, or "N props evaluated. No player props currently meet EdgeDesk's research threshold. This is a valid result." |
| `NOT_RELEASED` | EdgeDesk asked; no book has posted player markets | "Sportsbooks have not released enough player markets for this game yet. EdgeDesk projections are available." |
| `NOT_CAPTURED_YET` | outside the capture window, or never polled | "EdgeDesk has not asked the sportsbooks … yet" — never "not released" |
| `CAPTURE_FAILED` | the request or the run errored | "PLAYER PROP PRICING UNAVAILABLE — the capture pipeline encountered an error" |
| `CAPTURE_OFF` | capture is not running for the league | said as such |

The page reads the summary through `eventFromSummary(summary, gid, now)`,
which re-judges each price's age **now**: a price past the 90-minute window
takes the decision DOWN to NO DECISION · STALE_QUOTE (the kernel's own rule)
and the prop leaves the research grade. The full board is loaded only when a
reader opens a game's prop research.

## 6. Game model → prop context (no double counting)

The audit found the prop projection already consumes the game: the market
spread and total set team implied points and the script (dropback rate falls
0.6 pp per point of expected margin, `football/props/model.js`), plus pace,
weather and starters. Where no market existed (most college games) the
projection already used **EdgeDesk's own** margin and total.

So EdgeDesk's game model is **not** fed into the projection again. It is shown
beside it (`propGameLink`):

- **IN_PROJECTION** — the script already came from EdgeDesk's game model; said,
  not counted twice.
- **ALIGNED** — the game model and the market script agree within the research
  threshold (2 points).
- **SENSITIVITY** — they disagree: the sentence names both scripts, then the
  size by the prop model's own rule (e.g. "about +1.2 dropbacks"), whether it
  supports or cuts against the side, and that it is a sensitivity only. A
  volume market is read as dropbacks / designed runs, a scoring market as
  implied points; without the rule on hand no size or direction is claimed.

`gameContext()` collects EdgeDesk's and the market's projected score, spread
and total, pace, weather, starters, and — when the page holds the research
state — reliability, QB and availability. What EdgeDesk does not publish
(game-script probability, team pass-rate expectation, efficiency ranks, OL
status, coaching tendencies) is listed as not available.

## 7. Units

GAME: the decision engine's units, unchanged. PLAYER PROP: the prop kernel's
units (tiers, the MODEL-ESTIMATED 0.25U cap, quarter-Kelly, single book,
material uncertainty, the 1U player and 2U correlated-game caps), then a
ceiling by the market's validation stage, always rounded down:

| Stage | Ceiling |
|---|---|
| EXPERIMENTAL | 0 (the kernel caps it at LEAN) |
| TRACKING | the model-estimated cap (0.25U) |
| RESEARCH GRADE | the partially-calibrated cap (0.50U) |
| PRODUCTION | the probability source's own cap |

A prop therefore never sizes above a mature game market until its own graded
record promotes it.

## 8. Research surfaces

- **Top Research Priorities** (the desk) and **Today's Research Board**:
  `fbWrCandidate` attaches the game's prop signal (`propSignal`: count and the
  best prop's research score). `research_priority.rank` keeps a game's score
  and adds up to 30 % of the headroom above it for its best prop; a game with
  no game signal can be listed on its props alone at 0.75 × that score. Only
  quality scores — a game is not ranked higher for carrying many props. A
  DATA FAULT game is never listed on its props. The research state carries a
  `props` block (`stateProps`) so the server's stored Top 5 has it too.
- Each desk card shows **GAME SIGNAL · PROP SIGNALS · RESEARCH SCORE**, then
  **PLAYER PROPS TO RESEARCH** (up to three, "View all N props →"), and
  **Add to Card** for the game.
- **TOP PLAYER PROP RESEARCH** on the Research board and the desk: the league
  leaders from the same ranking.
- **Matchup → PLAYER PROP RESEARCH**: the top opportunities in full, then QB,
  RB, WR / TE and TD groups; every row has Research prop · Add to Card ·
  Compare books · View player.

## 9. The Card

One bankroll, two kinds of position: EdgeDesk's live **game decisions** (as
before) and the reader's **saved opportunities** — game markets and player
props — frozen at the moment they were added (`cardEntry`: id, type,
decision, sport, event, market, line, side, price, book, probability, EV,
edge, confidence, units, time; the player and prop type for a prop).

- Exposure is `EDBankroll.exposure` over both, split GAMES / PLAYER PROPS.
- Filters: All · Games (Spread / ML / Total) · Props (Passing / Rushing /
  Receiving / TD) · and every earlier filter. **Group by game** shows each
  game's market, its props and the total game exposure.
- **Correlated exposure**: two props — the measured same-game correlation
  (`football/props/correlation.js`, signed by side); a game market with a prop
  — a structural direction from the prop model's script rule, never a number;
  otherwise "shares the game environment". The warning states the gross units
  tied to the game. Nothing is reduced automatically.
- **Price moved**: a saved prop is re-priced by the same kernel against the
  board now. The saved line, price and EV are never edited; the current EV is
  its own number.
- **Record**: GAME and PLAYER PROP kept apart, ALL beside them (W-L-P, units,
  ROI, average EV at decision, CLV).

Storage: the device (`edgedesk_card_opportunities_v1`) and, signed in,
`public.card_opportunities` (`supabase/card_opportunities.sql`): owner-only,
pregame-only, write-once (only `status` changes; the grade is the grading
job's), with the `card_record_by_type` view.

## 10. The AI desk

`opportunityTurn` (edge function, before the props turn), deterministic:

- "What should I research in Buffalo vs Miami?" → the game (by the teams on
  the summary's own game rows; a generic word never matches), the **GAME**
  signal, and the **PLAYER PROPS** signal with the top candidates and their
  why and concerns — every price is one the summary holds, re-judged now.
- "What are the best opportunities on my card?" → the reader's Card as the
  client sends it (only with a card question): types, exposure, correlated
  games. "Build my card" stays with the staking engine.

## 11. Tests

| Suite | What |
|---|---|
| `tools/opportunity/opportunity.test.js` | shared services, the real boards (NFL and college), scenarios A–J, the Card page, the record split, the AI turn through the real edge handler |
| `tools/opportunity/card_sql.test.js` | the table against a real PostgreSQL, as real readers |
| `tools/opportunity/opportunity_ui.e2e.js` | the journey in Chromium on the committed boards, desktop and phone |

## 12. Limits (today)

- Player-prop probabilities are MODEL-ESTIMATED (UNVALIDATED CALIBRATION);
  college markets are all EXPERIMENTAL and never stake.
- A saved prop grades only once `football/props/<lg>/<season>/results.jsonl`
  carries its game; a saved game market grades against the committed record
  for spreads (totals and moneylines wait for a record of their own).
- Game ↔ prop correlation is directional, not measured.
- The desk's Card answer uses what the client sends; the server does not read
  `card_opportunities` itself yet.
