# Kalshi on the matchup card — display rules and judgment calls

The NFL and college football matchup card (`lib/edgedesk_game_graphic.js`, the
square "EDGEDESK vs KALSHI" graphic with Fair Spread, Projected Score, Fair
Total and What To Watch For) sets Kalshi's price beside EdgeDesk's model. This
file records the display rules the card follows and the judgment calls made
when they were written down (2026-10-22).

**Display and labelling only.** None of this changes a model output, a
projection, a fair line, a ranking or any research logic. The model and
snapshot modules (`lib/edgedesk_game_snapshot.js`, `lib/edgedesk_calc.js`,
`lib/edgedesk_football_lines.js`, `football/`) and the committed research
data (`football/game_research/`) are untouched. A test checks that the card's
model numbers are identical with and without a Kalshi block.

## Revision, 2026-10-22 (later the same day): the nearest price is always shown

The owner's call: a Kalshi price is never withheld for its age or its spread.
The card shows the **nearest two-sided quote** to the model snapshot and says
how near it is. Rules 1 and 2 and the matching notes below are superseded
where they say "unavailable":

- `G.kalshiAtModel` takes each market's nearest **two-sided** quote (a
  one-sided book has no price; the page and `npm run game:graphics` ask
  `kalshi_price_snapshots` for `yes_bid > 0 and yes_ask < 1` on each side of
  the model time). Every two-sided quote carries its mid; its state still says
  OK, TIME_GAP (over 15 minutes from the model) or WIDE_SPREAD (over 6¢).
- `EDGameSnapshot.kalshi` places every side with a mid whatever its row
  state, and labels the read `nearest quote` when any side is not OK.
- `G.content` compares it and prints the caveat beside the times line, e.g.
  `Nearest Kalshi quote: 2 h 1 min after the model` or `wide 9¢ Kalshi
  spread`; the large-gap note follows it.
- Only a game with no two-sided quote at all says `No two-sided Kalshi quote
  on record`.
- The constants keep their values: they now decide the caveat, not a refusal.

The same revision adds the edge strip (`G.pickMarket`, `G.edgeOf`): the
market beside the model is a LIVE book quote, else the newer of the page's
last captured quote and the snapshot's own market line (`consensus`: the CFB
terminal's latest book quote, nflverse's consensus line for the NFL), each
labelled with its book and time. The strip's title names the side the
unrounded projection leans to at 1.5+ points on the spread and 2+ on the total
(`EDGE: NE +3 · UNDER 50.5`).

## The rules (as first written)

All four live in `lib/edgedesk_game_graphic.js`, so every caller follows them:
the research page's graphic, its Download PNG and Share, and
`npm run game:graphics`.

| Rule | Constant | Value |
|---|---|---|
| A Kalshi price is compared only if it was quoted this close to the model snapshot | `G.KALSHI_MATCH_MINUTES` | 15 minutes |
| A Kalshi price is compared only if its YES spread is at most | `G.KALSHI_MAX_SPREAD` | 0.06 (6¢) |
| A win-probability gap this large adds the large-gap note | `G.LARGE_GAP_PP` | 7 percentage points |

1. **Matching timestamps.** The model snapshot time is
   `spec.model.built_at`, the time the footer prints. For each linked Kalshi
   market, `G.kalshiAtModel` takes the `kalshi_price_snapshots` quote nearest
   that time. If it is more than 15 minutes away, the card says **"Kalshi price
   unavailable at model time"** and compares nothing. Both times are always
   printed: `Model 2:04 PM ET · Kalshi 2:05 PM ET`.
2. **Kalshi price type.** The price is the mid, `(yes_bid + yes_ask) / 2`,
   labelled **KALSHI MID**. A spread over 0.06 is handled like rule 1: the
   price is unavailable.
3. **Difference label.** One sentence computed from the numbers printed above
   it: `EdgeDesk 9.5 pts higher on NE than Kalshi`. Here "pts" means
   percentage points of win probability. The team is picked from the data.
4. **Big gap note.** When the absolute gap is 7.0 points or more, the card adds
   `Large gap vs market. Checking injuries, QB status, and weather before
   trusting it.`
5. **Home field wording.** The home-field watch item is rewritten from the
   numbers. The neutral-site margin is the projected margin minus home field.

## Judgment calls

### Data source and matching
- **`kalshi_live_quotes` does not exist.** No migration or SQL file in
  `supabase/` defines it, so the card uses `kalshi_price_snapshots`, which is
  written every 5 minutes. No code path guesses at a table that isn't there. If
  `kalshi_live_quotes` is added later, it can feed `G.kalshiAtModel` rows of the
  same shape (`ticker, captured_at, yes_bid, yes_ask`).
- **"Closest" means closest in either direction.** The nearest quote before
  the model time and the nearest after it are both read, and the closer one
  wins. The user's own example (Model 2:04, Kalshi 2:05) is a quote after the
  model. When the two are equally close, the earlier one wins, so a quote taken
  after the model is never preferred to one already known at that time.
- **The nearest quote is used as it is.** If the nearest quote is one-sided or
  wider than 6¢, the card says the price is unavailable. It does not reach for a
  slightly older, tighter quote, because that would be shopping for a number.
- **Exactly 15 minutes counts as matched**, and so does a spread of exactly
  0.06. A spread of 0.0601 does not; spreads are rounded to 4 decimals first,
  as `public.kalshi_snapshot_mid` rounds them.
- **Two-sided means** a bid above 0, an ask below 1, and an ask not below the
  bid. These are the conditions `public.kalshi_snapshot_mid` uses for a mid.
- **The rules are checked twice.** `G.kalshiAtModel` marks each market OK,
  TIME_GAP, WIDE_SPREAD, NO_TWO_SIDED_QUOTE or NO_SNAPSHOT. `G.content` then
  checks every placed price again against the model time and the spread. A
  caller that hands the card the latest `kalshi_card_current` price (for
  example a page that didn't read the snapshots) therefore gets "unavailable at
  model time", never a comparison across times.
- **Per-team columns.** Each team's market is judged on its own. If one team's
  quote passes and the other's doesn't, only the passing team gets a column.
  Nothing is derived from the other side; that rule was already in place. If
  neither passes, the card shows the unavailable message.
- **When a game has no Kalshi market at all**, the card is model-only, exactly
  as before (the EdgeDesk model detail strip). The unavailable message is
  shown only for a game Kalshi lists whose price can't be used at the model's
  time. A failed read also leaves the card model-only, and the tool says so.

### What the card prints
- **Times line.** It reads `Model h:mm PM ET · Kalshi h:mm PM ET`. When the two
  times fall on different days (Eastern), both carry the date:
  `Model Oct 21, 2:04 PM ET · Kalshi Oct 22, 4:10 PM ET`. With no Kalshi quote
  on record it reads `Kalshi no quote`.
- **The unavailable state gives a reason** in one small line under the message:
  the distance in time (`Closest Kalshi quote is 2 h 6 min from the model
  snapshot`), the spread (`Kalshi spread 7¢ is over the 6¢ limit`), or no
  quote. Without it, a spread refusal next to two matching times would read as
  a contradiction.
- **The row labels changed.** The Kalshi row is `KALSHI MID` (`KALSHI CLOSE
  MID` for a close). The market row no longer carries the time, because the
  times line does.
- **Which team the sentence names.** It names the team with the larger
  absolute gap. On a tie it names the team EdgeDesk is higher on, then the away
  team. For NE at CHI (EdgeDesk 50.0 / 50.0, Kalshi 40.5 / 59.5) that gives
  `EdgeDesk 9.5 pts higher on NE than Kalshi`, the wording asked for. A zero gap
  reads `EdgeDesk matches Kalshi on NE`.
- **"pts" is kept as asked.** The column heads still say `WIN % · ML`, so the
  points read as win-probability points. The alt text spells out "percentage
  points".
- **The large-gap threshold** compares the rounded tenth (7.0 counts, 6.9 does
  not), using the same named team's gap that the sentence prints.
- **Placement.** The large-gap note sits on the bottom line of the comparison
  block, beside the times, in amber. On the square card that line is 13–14 px
  so the block keeps its height and What To Watch For keeps its room.
- **The live sportsbook's columns are unchanged.** On the research page, when
  a live sportsbook quote is shown (SPREAD and TOTAL columns), those columns
  keep their old difference labels (`1.5 TOWARD NE`, `2.0 HIGHER`). Rules 1–4
  were written for Kalshi. The book's quote is still the one live quote with
  its own capture time, so it is not matched to the model time. If Kalshi is
  unavailable, the message takes Kalshi's place beside the book's columns.

### Home field
- **Where the numbers come from.** The projected margin is
  `spec.model.home_margin` (unrounded). The home-field value is the one the
  watch item already prints (`+3.1 pts for playing at home`), read with
  `G.HOME_FIELD_RE`. The graphic spec carries no other home-field number, and
  adding one would mean changing `EDGameSnapshot.graphicSpec`. That would change
  every graphic key and append a history row for every game, which is a
  research-data change. A test checks, for every committed game with a
  home-field item, that the printed value is within 0.05 of the snapshot's own
  driver row, and that the item is always restated.
- **The three cases**, each rounded to one decimal:
  - projected margin ≥ 0 and neutral margin ≤ 0, so home field flips or erases
    the edge: `Home field is the whole game. Neutral site, NE is about a 3-pt
    favorite.` (or `…it’s a pick’em.` when the neutral margin is 0.0);
  - neutral margin > 0, so home field neither flips nor erases the edge:
    `Home field adds 3.1 pts to CHI’s edge.`;
  - the away team is favoured even at home. This case wasn't specified, and
    "adds to CHI's edge" would be wrong because CHI has no edge. It reads
    `Home field takes 3.1 pts off NE’s edge.`
- **Number formatting.** One decimal with a trailing `.0` dropped, so a
  neutral margin of 3.0 prints `3-pt`, as in the example, and 2.6 prints
  `2.6-pt`. One point prints `1 pt`.
- **Team abbreviations and the typographic apostrophe** (`CHI’s`) match the
  card's other watch items (`Bears’ pass rush`).
- **Titles.** `HOME FIELD DECIDES IT` goes with the first case and `HOME
  FIELD` with the other two.
- **The research page's long text is unchanged.** Its home-field paragraph
  ("That is more than the projected margin of 0.1: without it, the projection
  would lean New England Patriots by 3.0") comes from the snapshot builder.
  It is accurate in full sentences, and changing it would change the research
  snapshot. Only the card's short item contradicted the PK on the card.

### Plumbing
- **The research page now reads Kalshi at the model's time.** The view passes
  the snapshot's `model.built_at` to `opts.kalshi`. app.html's
  `window.fbKalshiAtModel` reads, for each linked market, the nearest
  `kalshi_price_snapshots` quote before and after that time, then hands them
  to `G.kalshiAtModel`. Without this, the page's card would almost always show
  "unavailable at model time", because the page used to read the latest price
  and the model is built hours earlier. The page's "EdgeDesk vs Kalshi" table
  under Market comparison uses the same model-time prices.
- **Fixed a race on the research page.** The page draws the graphic up to
  three times: first, when the market arrives, and when Kalshi arrives. Those
  draws could finish out of order, so an earlier graphic without Kalshi
  overwrote the newer one. Only the latest draw now reaches the screen. The
  extra Kalshi reads changed the timing enough to expose it in the browser
  test.
- **Export file names carry the template version.** `__g2` now appears after
  the snapshot id. Without it, a model-only card already on disk under the old
  name would never be redrawn, and it would keep the old home-field wording.
  A Kalshi-unavailable card is tagged `__kalshi-na-<time of the nearest
  quote>`.
- **The renderer version moved to `edgedesk_game_graphic/2`.** The script tags
  in app.html moved to `?v=20261022km1` (the snapshot, graphic and view files
  share one stamp, as a test requires), and the landing page's loader moved
  with them.
- **The football board's Kalshi section is unchanged.** That section on each
  game card shows the latest Kalshi price and its gap to the book fair, by
  design; it is not the matchup graphic. So is the research page table's
  `+9.5 pp` difference column.

## Verification

- `node tools/football/game_research.test.js` covers section 13 (updated) and
  section 14 (new): timestamp matching (nearest, ties, the 15-minute edge),
  mid and spread, the unavailable state (time gap, wide spread, no quote, a
  caller handing the latest price), both times on the card, the difference
  sentence, the 7-point threshold (6.9 and 7.0, the absolute value, the
  constant), and home field (the five cases, NE at CHI word for word, and
  every committed game).
- `node tools/football/game_research_ui.e2e.js` runs the research page in
  Chromium. Kalshi is compared at the model's time, and a too-wide market says
  "Kalshi price unavailable at model time".
