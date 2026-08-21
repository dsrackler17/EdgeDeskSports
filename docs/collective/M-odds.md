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
ODDSBLAZE_API_KEY       the provider key. ODDS_API_KEY and NFL_ODDS_API_KEY are
                        accepted as older names, in that order of preference.
ODDS_API_BASE_URL       optional. Pins the endpoint if the account is served
                        somewhere other than the documented one.
ODDS_COLLECTOR_SECRET   optional. Lets a scheduler with no Supabase session call
                        the collector. Absent, only a signed-in admin can.
```

`GET /v1/odds/health` reports which of those names the key was found under. It
never reports the value, and neither does any log line, error body, or probe
response: the URL the adapter hands back always has `key=REDACTED` in it.

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

## 6a. The live provider: OddsBlaze

`supabase/functions/collective_odds` is the only thing in the system that
calls a provider, and `_shared/oddsblaze.ts` is the only file that knows what
its JSON looks like. The adapter was written against a captured response, not
against a schema description, and that capture is committed at
`tools/collective/fixtures/oddsblaze_mlb_draftkings.json` so the reader can be
re-proved offline: `node --experimental-strip-types tools/collective/test_oddsblaze.ts`.

The feed serves one sportsbook and one league per call, with the key as the
`key` query parameter. Three things about the response are worth writing down,
because each one is a way to be silently wrong:

**`selection` is an object.** The team is `selection.name`, the over/under
side is `selection.side`, and the handicap or total is `selection.line`. There
is no top-level `points` field. A reader that expects a string gets `null`,
finds no side for any selection, and stores a row with every price missing —
without erroring.

**Market names are the sport's own vocabulary, and prefixes change the bet.**
MLB prints `Run Line`, `Total Runs`, `Moneyline`. It also prints
`1st 5 Innings Run Line`, `3rd Inning Run Line`, `Team Total Runs`,
`Team Total Runs Odd/Even`, and two dozen player props. Classification is
therefore by *exact* normalized name against three explicit sets. A substring
rule would file an inning's line as the game line, and nothing downstream —
not the board, not consensus, not CLV — could tell that it had.

**`main` separates primary from alternate within a market, not game lines from
props.** Player props carry `main: true` too. Alternates carry `main: false`
and are skipped. Where a book hangs more than one primary line — the capture
shows DraftKings offering both a -1.5 and a -1 run line, both marked main —
the first in feed order is stored and the rest are left alone.

Everything the adapter cannot read with confidence is reported as a skip with
a reason (`league_not_mapped_to_sport`, `kickoff_outside_configured_seasons`,
`spread_sides_disagree`, `no_main_line_only_alternates`, `live_game`) rather
than guessed at. In-progress games are excluded by default: a live price is a
different market from the pregame one, and the closing line is defined as the
last snapshot before kickoff.

What to poll, and how a feed league id becomes a sport code, are config rows
(`odds.collect`, `odds.league_sports`, `odds.include_live`), so a second book
or a new league is a row rather than a deploy.

`collective.provider_events` records which canonical game each provider event
id resolved to, along with the ids the feed carries for other systems (the
official league id, Kalshi, Sofascore). It is a cache and a ledger, never an
authority: a row there can never create a game and grading never consults it.

### When the feed changes

`GET /v1/odds/probe` prints the shape of the live response and every market
name in it with the adapter's verdict on each. A provider renaming a field or
a market shows up there as a diff, before it shows up as a board that quietly
stopped updating. `GET /v1/odds/sources` answers the only question worth
asking of a collector: is it running, and how old is the newest price.

### The canonical book

The closing line is only ever written from a book that was actually collected.
Migration 15 defaulted `market.canonical_book` to Pinnacle as a placeholder;
migration 21 moves it to DraftKings, which is the feed that actually runs,
because leaving Pinnacle in place would mean every game closes "unavailable"
and CLV silently never computes. An installation that does collect Pinnacle
keeps it: the update only fires where no Pinnacle snapshot exists.

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
