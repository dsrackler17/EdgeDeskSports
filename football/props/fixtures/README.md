# Player-props test fixtures

**Test data, not market data.** Every price in this directory was written by
hand to exercise the parser, the identity join, the pricing and the decision
paths (both sides, one-sided markets, alternates, duplicates, impossible
prices, an unknown player name). None of it is ever read by a production build:
`build_board.js` reads only `football/props/<league>/quotes.json`, which only
`capture.js` writes from The Odds API.

- `odds_event_nfl.json` — one `/v4/sports/americanfootball_nfl/events/{id}/odds`
  response in the provider's documented shape (`bookmakers[].markets[].outcomes[]`
  with `name`, `description`, `price`, `point`, `last_update`), for the week-4
  Falcons at Saints game.
- `events_nfl.json` — the matching `/events` index response.
