# One meaning per state — the consistency pass

`lib/edgedesk_vocab.js` · `tools/bettor/consistency.test.js`

EdgeDesk answers a chain of questions. Every surface keeps them apart, in this
order:

| Layer | Question | Where it is decided |
|---|---|---|
| RESEARCH | What deserves investigation? | research status — `lib/edgedesk_canon.js`, `lib/cfb_research_view.js` |
| MODEL | What does EdgeDesk make the game? | the engines' fair line and distribution |
| MARKET | What prices are actually available? | **market state** — `EDDecision.marketStateOf`, from the quotes the decision priced |
| PRICING | Does the current price have value after calibration? | edge, calibrated EV — `lib/edgedesk_quote_ev.js` |
| DECISION | BET / LEAN / WATCH / PASS / NO DECISION | `lib/edgedesk_decision.js` only |
| SIZING | If BET, how much exposure is justified? | units, capped; `lib/edgedesk_bankroll.js` exposure |
| MONITORING | What change would alter the decision? | BET trigger, playable to |
| GRADING | What happened versus the close? | CLV, observed vs expected cover |

## The words

`lib/edgedesk_vocab.js` is the one home for what a reader sees: the five
decisions, the five market states, the help text, the raw-vs-calibrated EV
labels, the status line, the unit-tier rule and the positioning copy. The
decision engine's `DECISIONS` and `TOOLTIP` are built from it; the renderers,
the page and the Top-5 heading read it. Internal enums keep their names where
renaming would force a storage migration (the v1 `WAIT` row, the research
canon's `NO_MARKET` key for a stale capture) — the vocabulary maps each to the
one word a reader sees (`WAIT` → WATCH; a stale capture → STALE MARKET).

### Decisions

| | Means | Never means |
|---|---|---|
| **BET** | The current verified price clears every decision gate. | a research status, a raw EV, a model–market gap |
| **LEAN** | Positive edge on the model's side of the market, below the betting threshold (a pricing decision, not a directional opinion). Names its BET trigger when one exists. | a stake |
| **WATCH** | Close enough that a realistic change in price or data could produce a BET. Always names its reason; names the BET trigger whenever one can be computed. | "interesting" with nothing to wait for |
| **PASS** | The current price does not justify action. Names why, and the realistic BET trigger — or **NO REALISTIC BET TRIGGER AT CURRENT MODEL STATE**. | a failure to find anything |
| **NO DECISION** | Required information does not exist or cannot be evaluated; always names a Layer-A blocker. | young model, accumulating calibration, caution |

### Market states (from the quotes the decision priced)

| | When |
|---|---|
| **LIVE MARKET** | a current, usable quote exists (market quality ACCEPTABLE or better) |
| **THIN MARKET** | a usable quote exists but only one side of the number is priced (market quality THIN) |
| **STALE MARKET** | quotes exist, none inside the freshness limit (`STALE_QUOTE`, `FRESHNESS_UNKNOWN`) |
| **NO MARKET** | no quote for the market evaluated (`NO_MARKET`, `MARKET_SUSPENDED`, a closed pregame market) |
| **MARKET FAULT** | quotes exist but cannot be trusted: `CORRUPTED_ODDS`, `ORIENTATION_FAULT`, `NO_VALID_QUOTE`, or the selected quote failed a market-integrity check (orientation, spread sign, consensus, ladder, book agreement, arbitrage, market integrity) |

Only a LIVE MARKET can carry a BET; the build refuses to publish one that does
not (`football/cfb_terminal/decisions.js`).

Every decision carries `market_state` and `quote`, the canonical quote the EV
was computed from: `event_id, market_type, selection, line, odds, sportsbook,
captured_at, freshness, orientation, verification_state, source` plus the raw,
calibrated and decision EV. Snapshots freeze both.

## Root causes fixed

1. **NO MARKET beside a priced quote.** The FBS card's research status came
   from the published `board.json` build (up to 3 h old, built on the Model
   Lab ledger), while the decision priced the page's live captured board. When
   the two disagree about whether a usable market exists, `fbCanonApply` now
   keeps the page's own label (`market_reconciled`), and the summary's Market
   and EV cells read the decision's market state and quote. The board status
   read NO MARKET when the orientation check dropped a line (now DATA FAULT, as
   the market join already said), and `fbMarketFromEvent` ignored an event that
   captured only the away side. The NFL card said "no market number" whenever
   the reference join was empty, even while the decision priced a captured
   quote.
2. **Stale read as NO MARKET** in the research view and the canon: a stale
   capture now reads STALE MARKET (same internal key).
3. **Best Available could be +28.5 (−10000).** Every captured `spreads` row was
   a main line wherever it sat, and "best line" meant most points. A spread row
   more than 3.5 pts (CFB) / 2.5 pts (NFL) from its side's consensus is now
   priced as an alternate (tail-checked, never best line/price/EV); the
   decision's **BEST CURRENT PRICE** is the best book at the exact line
   evaluated; **BEST PLAYABLE ALTERNATE** and **SAFER ALTERNATE** must be
   within 3 pts at −300…+300 (a safer alternate is a different, more-cushioned
   line, never the same number at a worse price); the research view's best
   available line applies the same band.
4. **WATCH with nothing to wait for.** A MODEL–MARKET DISAGREEMENT WATCH needs a
   realistic BET trigger (line move ≤ 3 pts CFB / 2 pts NFL, or price ≤ 50¢);
   without one it is PASS. Trigger options beyond those bounds stay in the
   audit and are never shown as the trigger.
5. **"?" artifacts.** The tooltip glyph rendered inline ("not yet validated on
   live results?"); tooltips now use a dotted underline, and the status line is
   text: *Decision rules · Conservative defaults · Live validation · In
   progress · Calibration · Partially calibrated · Research status · Separate
   from the bet decision*.
6. **Positioning.** "Research tool only — not betting advice" / "EdgeDesk never
   tells you what to bet" sat beside BET decisions with unit sizes. The product
   line is now *Research and decision-support tool. Signals can be wrong. 21+.
   Bet responsibly. 1-800-GAMBLER.*; "Research, not picks" stays on research
   and shareable surfaces.

## Cards

- **BET** leads with an execution summary: WHAT · WHERE · PRICE · HOW MUCH
  (units, dollars, the tier's rule) · PLAYABLE TO · EDGE · CALIBRATED EV (or
  MODEL-ESTIMATED EV) · CONFIDENCE · WHY (one sentence) · WHAT COULD
  INVALIDATE IT (important warnings only).
- **WATCH**: DO NOT BET YET · CURRENT PRICE · REASON · BET TRIGGER (options, OR)
  · WAITING ON · NEXT CHECK.
- **LEAN**: CURRENT PRICE · WHY NOT A BET · BET AT.
- **PASS**: BEST AVAILABLE · WHY · BET TRIGGER or NO REALISTIC BET TRIGGER.
- Above the reasoning: the market state and the research status, each labelled,
  the research status dotted and marked *not a bet signal*.
- **Raw vs calibrated EV**: beside a calibration, `RAW MODEL EV · Diagnostic
  only` (dashed) and `CALIBRATED EV · Used by the decision engine`; without
  one, `MODEL-ESTIMATED EV`. A raw EV ≥ 20% prints why it is not actionable.
- **Beginner mode** shows the decision block only (decision, selection, price,
  book, units, playable to, calibrated EV, edge, confidence, why, important
  warning, BET trigger) and an *Advanced view* button; raw EV, verification
  checks, stake-tier trails, reason codes and versions are absent.
- **Advanced mode** keeps every diagnostic, plus the evaluated quote and the
  full BET-trigger search.

## The EdgeDesk Card page

Header: BETs and total exposure first (largest), LEAN and WATCHING second,
PASS and NO DECISION as one subdued line. Exposure counts active BET decisions
only (`EDBankroll.countsAsExposure`) — TOTAL, BY SPORT, BY KICKOFF WINDOW, BY
MARKET. Each unit tier reads *Current conservative sizing rule · n of 50
settled bets* until its own sample validates it. With no settled BET, the
performance table is replaced by **NO SETTLED BETS YET**.

## Tests

`tools/bettor/consistency.test.js` pins A–S (a live quote never reads NO
MARKET; stale, market-fault and unverified-anomaly prices never BET; WATCH
reasons and triggers; NO DECISION only on Layer A; only BET is exposure; raw
EV never decides; the shown quote is the priced quote; PLAYABLE TO inside the
threshold; beginner/advanced; extreme alternates; research ranking
independent of the decision), on the real engine, the real renderers and the
functions cut out of `app.html`.

## Known remaining inconsistencies

- The EdgeDesk Intelligence desk, the brief and the MLB verdicts (the
  `EDPresent` "call" vocabulary shared by `app.html`, `brief.html` and
  `supabase/functions/edgedesk_ai/_presentation.js`) still say **WAIT** for
  their information-pending verdict. It is a separate engine whose words are
  also an LLM prompt contract; renaming it is a coordinated change across the
  edge function, both page mirrors and their sync tests.
- `terms.html`, `disclaimer.html` and the sign-up consent line keep their
  existing legal wording ("not betting advice"); legal copy is for the owner
  to revise.
- The published artifacts (`board.json`, `decisions.json`) pick up the market
  state, the canonical quote and the STALE MARKET label on the next scheduled
  build; until then the page reconciles live.
- The FBS board keeps its internal `STALE QUOTE` status key (exports and the
  research ranking read it) and shows it as STALE MARKET.
