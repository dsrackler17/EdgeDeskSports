# The EdgeDesk Read — methodology

> Read the price, not just the team. EdgeDesk is not saying "I like Minnesota."
> It is saying "at Minnesota +6.5 −110 this price clears — or does not clear —
> the research threshold, for these reasons." At Minnesota +3 the same football
> opinion can be a pass.

`lib/edgedesk_read.js` (`window.EDRead`) turns what EdgeDesk already produces
into one price-specific read per game. It adds no predictive model, retunes
nothing, and never lets a sportsbook price into the fair line. This document is
the methodology; [DELIVERABLE.md](DELIVERABLE.md) maps the brief to the code,
the tests and the current-slate demonstrations.

## 1. Where every number comes from

| Number | Source | Computed where |
|---|---|---|
| EdgeDesk fair, projected score | the governance champion (`edgedesk_cfb_p4_v1.0.0`, `football/fbs/slate.json`) | the champion engine, unchanged |
| P(win / push / loss) at any line | the champion's empirical, key-number-aware margin PMF, conditioned on the current market spread exactly as `football/cfb_terminal/build.js v1Dist` already conditions it | stored once per build as the **probability curve** (`read_inputs.curve`): P(margin > t) and P(margin = t) at every half point t on the home-margin axis, ±30–60 points around the market |
| Break-even, EV, de-vig, calibration, market confidence | `football/cfb_decision/decision.js` (`americanToPayout`, `payoutToAmerican`, `breakEven`, `devig`, `expectedValue`, `decisionProbability`, `marketConfidence`) | called, never copied (one EV formula; parity with decision.js and lib/cfb_terminal.js is tested over 240 cases) |
| Quotes, opener, freshness | the Model Lab ledger (`football/cfb_lab/ledger/<season>/quotes`, `lines.jsonl`), the alternates ledger (`football/cfb_terminal/read/<season>/alternates.jsonl`) | normalised in the Read |
| Consensus outlier screen | `football/cfb_lab/integrity.js assessMarket` (MAD rule) | called |
| Governed BET | `decision.js decideGame` per exact quote, with the pinned policy and calibration (build.js) | stored as `read_inputs.governed.by_quote` |
| Research status, model agreement, risks, decomposition, edge decay | the research object (`lib/cfb_terminal.js`) | read through `EDRead.fromTerminal` |

The page never runs a model. It re-prices the stored curve through the same
`EDRead.fromTerminal → EDRead.read` path the build uses, so switching the book,
typing a quote or moving a line is instant arithmetic on stored numbers. The
test suite rebuilds every published read from its stored inputs and requires a
byte-identical result.

**Sign convention.** Home margin + = home wins by that many. A book line is
what the book prints for a side: home −7 = home lays 7 (covers when margin > 7);
away +7 covers when margin < 7. A side's P(win) at line L is `curve.win` at
threshold −L (home) or `1 − win − push` at threshold L (away).

## 2. Odds

Every quote is normalised to American, decimal, the exact payout per unit and
the break-even probability. Break-even for −a is a/(a+100), for +a 100/(a+100)
— the exact price, never an assumed −110. A source that publishes an implied
percentage (DraftKings-style "53%") keeps it: break-even is the source's own
53%, and the American equivalent (−113) is marked approximate (≈).

## 3. Cover, push, loss — and pushes

For each option (one side, one line, one price, one book, one moment) the Read
reads P(win), P(push), P(loss) straight from the curve. Integer lines carry the
champion PMF's own mass on that exact margin; half-point lines push with
probability 0. `+7` and `+7.5` differ by exactly P(margin = 7), which the tests
pin. Cover probability is P(win | no push) = win / (win + loss), the quantity
break-even is compared with.

## 4. EV

EV per unit risked = P(win) × payout − P(loss) (a push returns the stake). It is
reported three ways and never merged:

- `raw_ev` — the raw champion probability;
- `decision_ev` — the calibrated decision probability, when a calibration is
  validated for the model version;
- `ev_after_buffer` — the EV at the calibration's conservative probability (§6).

A probability above 50% is not +EV: 52% at −130 is negative, and the test says so.

## 5. Calibration

A decision calibration exists (`cfb_decision_calibration_v1`) — but it is
validated for `edgedesk_cfb_v2.1.0`, and the champion that sets EdgeDesk fair is
V1. `decision.js validateArtifact` refuses the mismatch, and so does the Read:
every read today is **CALIBRATION PENDING**, its cover probability is the raw
champion distribution, and nothing it says is a certified bet. The raw
probability is shown (labelled RAW) because the terminal already shows it; EV is
shown as research, never as a decision number. When the champion has a
validated calibration, the same code path applies it: the calibrated
probability is `decision.js decisionProbability` (the map, then shrinkage toward
the de-vigged market at that exact line).

The only evidence on file about a raw model's cover probability (V2.1's) is that
it is overconfident: the validated shrinkage keeps 23% of the model's logit.
Under that calibration Minnesota +6.5 −113 falls from 65% raw to about 54%.

## 6. The uncertainty buffer

A tiny positive EV is not a bet. A price **clears** only when both hold:

1. **probability edge** — cover probability − break-even ≥ the policy's
   `min_probability_edge` (1.0 pp, the DEV plateau choice of
   `cfb_decision_policy_v1`);
2. **EV after the buffer** ≥ the policy's `min_ev` (0). With a validated
   calibration the buffered EV uses the smaller decision probability at the two
   ends of the calibration's own 95% interval on the model weight
   (`w_ci95_profile_dev`, 0.073–0.383 for v1). Raw (pending), it is the raw EV,
   and nothing raw can be actionable anyway.

Model disagreement, data reliability and market quality are gates, not extra
buffers: model SD past `max_ensemble_sd`, reliability under 60 or confidence
under 35 (LIMITED DATA), thin or stale markets, and the integrity gate each
block an actionable read with their own reason.

## 7. Main vs alternate

For each alternate at a book, against that book's main line on the same side:
line change, P(win) change, cover change, break-even change, juice in cents, EV
change after the buffer, and the key numbers crossed. The verdict:

- `TOO_EXPENSIVE` — the extra points add less cover probability than the extra
  break-even the price demands: **PASS — protection costs too much**, even if the
  alternate still clears on the main line's edge (that edge is available without
  paying for the points);
- `BETTER_VALUE` — the alternate clears and its EV after the buffer beats the
  main line's;
- `VALUE_BUT_MAIN_BETTER`, `PASS`.

**Best value** is the option with the strongest EV after the buffer among fresh
options that clear, excluding lower-confidence alternates (one-sided, not
refreshed with the book's main line, or aging). **Safest** is the alternate with
the highest P(win), named and never preferred for being safer. A one-sided
alternate's market probability is de-vigged with the same book's main-line
overround (proportional); without one, the vig-inclusive break-even is used,
which can only shrink an edge.

## 8. Key numbers

The key numbers are the terminal's primary set — the four largest FBS
final-margin shares: 3 (9.3%), 7 (8.5%), 10 (4.6%), 14 (4.6%). A comparison
that crosses one says KEY NUMBER CROSSED with two numbers: this game's PMF mass
on exactly that margin, and the historical FBS share. Crossing 4 says nothing.
The probability used in EV is the champion PMF's; the key-number line explains
it, it does not add to it (§ limitations: the PMF's integer re-centring).

## 9. Bettable to, target, price gone

- **Bettable to** — walking down from ten points better, the worst line at the
  policy's reference price (−110) that still clears (the "−110 equivalent"), and
  the worst price at the current line that still clears (the market probability
  held fixed, as `decision.js minimumPrice` holds it). When the current number
  does not clear, the same numbers are labelled **NEEDS**.
- **Target (WAIT FOR A NUMBER)** — the first clearing number, when EdgeDesk
  disagrees by 2+ points and that number is within the held-out mean
  open-to-close move (`football/validation/movement_cfb.json`, 1.6 pts on the
  current build). Beyond it: PASS. **WAIT FOR A PRICE** — the number clears at
  the reference price but the book's juice does not; the target is this number at
  the price that clears, no better than the standard −110 (93.8% of archived
  openers were −110 both ways).
- **Price gone** — the first number (the opener, else the first capture) and the
  current main number are judged by the same current EdgeDesk distribution, so
  only the price changed. First cleared, current does not: PRICE GONE. Still
  clears but with ≤ 40% of the first edge: PRICE MOSTLY GONE (the terminal's
  edge-decay band).

## 10. Timing (deterministic, first rule that holds)

| Read | When |
|---|---|
| NO DECISION | no model, no curve, no market, only stale quotes, no priced quote, malformed odds |
| INVESTIGATE | the integrity gate: DATA FAULT, MARKET FAULT, an unverified 7+ gap; or two current quotes for one book that disagree by 1+ pt |
| PASS | EdgeDesk matches the market; or a raw read with a gap under 2 pts and no book-price edge |
| WAIT | the price clears but a quarterback job is contested or no starter is identified; with a validated calibration, a market of fewer than 3 books |
| RESEARCH (decision RESEARCH ONLY) | the price clears but it is not certified: calibration pending, the governed engine did not return BET (its reason is printed), LIMITED DATA, or outside the policy's −125 price limit |
| BET | the governed engine certified this exact, fresh, captured quote; the calibration is validated; betting is enabled |
| BET EARLY | BET, plus a measured reason the number may not last: the market moved ≥ 0.5 pt toward EdgeDesk since the open, or losing half a point from the current number crosses a key number. The cushion over bettable-to is shown as support |
| PRICE GONE | §9 |
| PRICE TARGET (decision WAIT) | §9 |
| PASS | the current price does not clear and no reachable target exists |

EdgeDesk never waits "for sharps", never infers sharp action from movement,
percentages or social posts, and never promises a better line. WAIT always names
its reason or its target; the tests fail on a bare "maybe wait". The policy's
own WAIT rule stays disabled (no evidence that waiting pays), so timing is
labelled EXPERIMENTAL until the record validates it (§12).

**Research status is not decision status.** `research_status` (VERIFIED MAJOR
DISAGREEMENT, WORTH RESEARCHING, MARKET ALIGNED, INVESTIGATE, MARKET FAULT, DATA
FAULT, LIMITED DATA) and `decision_status` (BET EARLY, BET, WAIT, PASS, RESEARCH
ONLY, NO DECISION) are separate fields. INVESTIGATE, DATA FAULT and MARKET FAULT
override any action; LIMITED DATA caps at RESEARCH ONLY; a VERIFIED MAJOR can
still be a PASS.

## 11. Market

- **Consensus** — each real book once (duplicate feeds of one book merged, the
  freshest kept), stale quotes (> 180 min, the policy's `stale_minutes`)
  excluded, robust outliers excluded by the Lab's MAD rule with 3+ books, a
  provider's own "consensus" kept as a reference, equal weights (no validated
  book-quality weights), a USER QUOTE never included. The consensus price is the
  median price books charge at the consensus number.
- **Views** — best available (every book), one selected book, the reader's books
  (BEST PRICE FOR YOU, from the watchlist's saved books), or the consensus.
- **Line shopping** — every book's option on EdgeDesk's side ranked by EV after
  the buffer at its own line and price, never by the biggest number or the lowest
  juice alone.
- **Model edge vs book edge** — model edge = EdgeDesk vs the consensus; book edge
  = the best book vs the consensus. MODEL EDGE (2+ pts, no book 1+ pt off),
  BOOK-SPECIFIC PRICE EDGE, BOTH, NONE (the terminal's thresholds).
- **Movement** — open (or first capture, labelled), consensus, best, selected;
  TOWARD / AWAY / STABLE on a 0.5-pt move. The words are "MARKET MOVED 1.0 POINT
  TOWARD EDGEDESK … Movement is informative, not proof."
- **Edge decay** — the terminal's initial vs current model gap, with the decay %.
- **Quote freshness** — every quote's book, source, capture time, provider
  update time, true age, line and price, FRESH / AGING / STALE. A number another
  EdgeDesk artifact displayed (today: `projections.json`'s market, shown in the
  app's V2 panel) or a typed quote that differs from the newest capture of the
  same book by 1+ pt raises MARKET QUOTE CHECK. A stored number older than the
  capture is replaced and EV recomputed at the current quote; two current numbers
  that disagree block action (INVESTIGATE).
- **Market freshness score** — `decision.js marketConfidence` (age, breadth,
  agreement, two-sided prices), kept apart from football confidence.
- **Page clock** — the page re-prices at the reader's clock, so a quote that
  ages past 180 minutes stops being a price the moment it does.

## 12. Record and validation

A read snapshot is frozen when a game's read changes to a recordable state
(BET EARLY, BET, WAIT, PRICE TARGET, RESEARCH, PRICE GONE, and PASS when there
was an apparent disagreement): book, source, quote id and time, line, odds,
precision, fair, market, cover (and its basis), break-even, EV, statuses,
bettable-to, target, the main and alternate lines with their EVs. It is written
once to `football/cfb_terminal/read/<season>/reads.jsonl` (append-only,
deterministic ids) and graded once into `grades.jsonl` against the Model Lab's
consensus close and the final — CLV at the recorded number, W/L at the recorded
line and price, never a better later line. BET EARLY: later-worse rate and line
preserved. WAIT: best later number, target reached, close vs the wait price
(wait success). Alternates: each alternate's own result at its own price. PASS
and PRICE GONE are counterfactuals, never wagers. Rates print only at n ≥ 30,
and timing is validated by CLV and entry quality — never because BET EARLY
reads happened to win.

## 13. Words

Every sentence is built from a reason code and the numbers that triggered it.
The build refuses to write when any read contains lock, hammer, max bet, sharp
money, steam or a promise (`auditText`, plus decision.js and market_intel's
audits in the tests). The AI boundary (`supabase/functions/edgedesk_ai/_cfb_explain.js`)
now carries the Read as facts; an explanation that calls the read certified, a
bet, or states a number the Read did not produce is refused and replaced by the
deterministic text.
