# M. Odds and Market Data

How market data enters the Collective, what it is normalized into, and how a
model, a page, or a grader consumes it. One store, one write path, one set of
read views. Nothing calls an odds provider from a page.

---

## 1. The shape of it

```
provider (any)  ->  adapter  ->  record_market_snapshots()  ->  market_snapshots
                                                                     |
                                       +-----------------------------+
                                       |              |              |
                                current_market   market_consensus  closing_lines
                                       |              |              |
                                      board        research       grading
```

The provider is replaceable. Everything above `record_market_snapshots` is
provider-specific and lives in an adapter; everything below it never learns
where a number came from beyond the `source` and `book` columns it carries.

## 2. Credentials

Provider keys are Edge Function secrets, set in the Supabase dashboard under
Edge Functions, never in a migration, never in the repository, never in a
page. The Collective site is static HTML: anything it can read, the public can
read. That is why collection runs server side and pages read only the
normalized tables.

```
ODDS_API_KEY          the provider key
ODDS_API_BASE_URL     provider base url
ODDS_REFRESH_SECONDS  polling interval, default 300
```

## 3. Storage

`collective.market_snapshots` is append-only and enforced by trigger. A
snapshot is never edited; a new price is a new row. The unique index on
`(game_id, market, book, source, captured_at)` means a retry or a double run
cannot duplicate a capture, while a genuine price change at a later timestamp
is always kept. Line movement is therefore recoverable in full:

```
12:00  KC -3.5  -110
12:05  KC -3.5  -115
12:14  KC -4    -110
```

Columns: `home_line, home_price, away_line, away_price, total_line,
over_price, under_price, home_ml_price, away_ml_price, book, source,
captured_at`. Spreads are home convention throughout, negative meaning the
home team is favored, identical to projections. An adapter that reads an
away-side number flips it before writing, never after.

## 4. Event matching

Snapshots resolve to canonical games through `resolve_game_ref`, the same
function projections use: sport, season, home team, away team, and a kickoff
within 48 hours. Team strings resolve through `team_aliases`, so a provider
writing `LA Chargers`, `Los Angeles Chargers`, or `LAC` lands on one team.
A row that does not resolve is reported as unmatched and dropped. Collectors
cannot create games, so a provider naming a team unexpectedly can never split
one fixture into two.

## 5. Reads

**`current_market`** one row per game, the most recent snapshot, with the book
and capture time so a reader can judge freshness.

**`market_consensus`** per game: the median line across books (a median, so a
single outlier cannot drag it), and the average de-vigged home probability.
Pinnacle is excluded from that aggregate and reported separately, because a
sharp reference diluted into a generic average stops being a sharp reference.

**`best_spread_price(game_id, side)`** the best price for each line, one row
per line. Prices are ranked in decimal, which is the only ordering correct
across the sign boundary. Nothing here compares -4 at -105 against -3.5 at
-110: those are different bets, and choosing between them needs a value for a
half point, which is a judgement the Collective does not make silently.

**De-vig.** `devig_two_way` strips the margin proportionally so a two-way
market sums to one. A -110/-110 pair is exactly 0.5, not the 0.5238 the raw
price implies. Averaging American prices averages the bookmaker's margin along
with the market's opinion, so consensus probability is always computed from
de-vigged prices.

## 6. Attachment and closing

At ingest, a projection records `market_snapshot_id`: the most recent
canonical-book snapshot at or before the moment the server received it. Set
once, never revised, so a pick keeps the number its author could actually have
seen. Not the newest snapshot, and not a different book.

The closing line is written once into `closing_lines`, naming the snapshot it
came from, so any graded pick traces back to the market that produced it. It
is the last canonical-book snapshot strictly before kickoff. Where the
canonical book never appeared for that game the closing line is reported
unavailable; another book is never substituted, and grading is left null
rather than fed a market the pick never faced. The canonical book is
`market.canonical_book` in config, default Pinnacle.

CLV therefore has what it needs without inventing anything: the line and price
the pick was posted into, the closing line and price, the book, and both
timestamps. A closing number exists only once a game has actually closed.

## 7. Adding a provider

Write an adapter that returns rows in the `record_market_snapshots` shape:

```json
{ "sport": "NFL", "season": 2026, "market": "spread",
  "home_team": "Seattle Seahawks", "away_team": "New England Patriots",
  "kickoff": "2026-09-10T00:20:00Z",
  "book": "Pinnacle", "source": "your_provider",
  "captured_at": "2026-09-08T18:00:00Z",
  "home_line": -3.5, "home_price": -110,
  "away_line": 3.5,  "away_price": -108,
  "total_line": 44.5, "over_price": -110, "under_price": -105,
  "home_ml_price": -190, "away_ml_price": 165 }
```

Nothing else changes. `tools/collective/parse_odds.py` is a worked example
that reads a saved odds page and emits exactly this.

## 8. Failure behavior

A provider being down is not a site outage. Pages read the stored tables, so
the board keeps rendering the last capture with its timestamp. Nothing is ever
presented as current when it is not: every surface has `captured_at`, and a
game with no snapshot shows no line rather than a guess. There is no mock odds
path anywhere in the system; the absence of a number is displayed as an
absence.
