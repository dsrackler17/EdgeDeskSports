# Player Props — the market

## Capture (`football/props/capture.js`)

Capture uses The Odds API per-event endpoint (`/v4/sports/{sport}/events/{id}/odds`).
Player props bill **per market per region**, so capture is budgeted:

| Setting | NFL | CFB |
|---|---|---|
| Window | next 96 h | next 48 h |
| Events per run | 16 | 20 |
| Cadence per event | every 3 h, tightening to every 45 min inside 3 h of kickoff | same |
| Credit floor | stop below 500 remaining; stop on 401/429 | same |
| Books | DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, BetRivers, Fanatics, Hard Rock | same |
| Markets | tier 1–2 mains and their alternates, anytime TD, longest reception/rush | same |

Capture runs only when the repository variable `PROPS_CAPTURE` is `on` **and**
the `ODDS_API_KEY` secret exists. Without both, the board says PROJECTION ONLY.

Every quote is normalised to:

```
{ quote_id, league, game_id, kickoff, player_id, player_name, mapping, position, team, opponent,
  home_away, prop_type, market_key, is_alternate, book, line, over, under, two_sided,
  book_updated_at, captured_at, provider, market_status }
```

- `captured_at` is when EdgeDesk observed the quote, not the book's stamp.
- `player_id` is an EdgeDesk id or null. An unresolved name is written to
  `market.json` `unmapped` with the reason ([IDENTITY.md](IDENTITY.md)).
- Outcomes pair into two-sided quotes by player and line (`EDProps.pairOutcomes`).
  Yes/No props pair at 0.5, and a price conflict is flagged.

## Market files

`football/props/<league>/markets/<game>.json` holds:

- the latest quote per (book, main | alternate line) per prop, **change-only**:
  an unchanged re-capture only moves `captured_at`;
- the consensus **history**, which gets a point whenever the line, the no-vig
  probability or the book count moves;
- the **open**, EdgeDesk's first capture, never overwritten and labelled as
  such.

The full tick history goes to Supabase (`player_prop_quotes`, append-only) when
`SB_URL` and `SB_SERVICE_ROLE` exist.

## Market math (`EDProps`, through `research_core`)

- **Per quote.** Implied probability, hold, and the no-vig two-way probability.
- **Consensus.** Uses main lines only, one per book.
  - The **consensus line** is a line books actually deal: the majority line if
    there is one. Otherwise it is the dealt line nearest the median, with ties
    going to the no-vig closest to 50%. It is never an undealt 71.0.
  - It also reports: the median line; the no-vig probability at the consensus line
    (averaged across the books dealing it); the median hold; best Over / Under
    price at the consensus line; best line at any price; dispersion; and a
    sharp-book reference beside the consensus (never substituted for it).
- **Movement.** Opening → current in line points and no-vig points, with the
  high and low.
- **Freshness.** Uses the one rule (`EDMarket.freshness`): FRESH ≤ 30 min,
  AGING ≤ 90 min, STALE beyond.
  - A stale or undated quote never decides. EV is still *shown*, with a warning.

## Pricing and price sensitivity

Every (book, side, line), main and alternate, is priced on the distribution:

- P(win), P(push) on whole lines, and the cover probability;
- fair odds and break-even;
- edge in points and EV at the exact price;
- the market probability, and the risk-adjusted probability and EV.

The **ladder** tags BEST PRICE, BEST EV, SAFER LINE and HIGHER UPSIDE, and dims
dominated quotes. The highest-probability line is not automatically the
highest-EV one.

`EDProps.breakEvenLine` gives the **zero-EV line** at any price. The drawer's
calculator prices any line and price the reader types, on the same distribution.
