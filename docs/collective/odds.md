# NFL odds infrastructure

The Collective keeps its own copy of the NFL market. One ingestion path fills
it, one read surface serves it, and every page — the wall, the board, the
market page, model pages, the embed on a member's site, the admin console, the
research assistant — renders from that one copy.

Nothing in a browser ever calls an odds provider. The provider credential
lives in a single Supabase edge function secret and is read by one module.

```
                      OddsBlaze
                          │  HTTPS, key in the query string
                          ▼
             collective_odds_ingest   (edge function, JWT enforced)
                          │  normalize → validate → report what did not map
                          ▼
                collective.odds_ingest RPC
                          │
                          ▼
                 odds schema  (Postgres)
       events · snapshots · opening · closing · runs · settings
                          │
                          ▼
               collective_odds   (edge function, public read)
                          │  every payload carries a freshness envelope
        ┌─────────────────┼─────────────────┬──────────────────┐
        ▼                 ▼                 ▼                  ▼
   collective/odds.js   admin console   embed.js on a      app.html
   (site components)    (operations)    member's site      research sources
```

## Providers

Two are registered. Which one runs is the `provider.default` setting, not a
deploy.

| | OddsBlaze | The Odds API |
| --- | --- | --- |
| Module | `_shared/oddsblaze.ts` | `_shared/theoddsapi.ts` |
| id | `oddsblaze` | `theoddsapi` |
| Billing | per book request | per `[markets] x [regions]` |
| Books per request | one | every book in the region |
| Alternate lines | yes | no (per-event endpoint, billed per event) |
| Sharp books | Pinnacle, Circa, BookMaker | Pinnacle only, and only in `eu` |

That billing difference drives everything else. OddsBlaze scales with how many
books you ask for; The Odds API returns every book for a flat cost, so the
adapter keeps them all — filtering to a shorter list would throw away data
already paid for without saving a credit.

### Attribution

Every payload's `source.provider` names the provider of the **most recent
successful run** — the same run `last_updated` refers to — read from
`odds.last_poll_provider()`. Not `provider.default`, which answers a different
question: who will poll *next*. The two differ from the moment you switch
providers until the first run on the new one finishes, and during that window
the stored prices still came from the old one.

If neither is known the field reads `unknown`. It is never defaulted to a
vendor name, because `/v1/nfl/assistant` hands this field to a research model
as fact, and a confident wrong attribution is worse than an absent one.

### Credit budget

The Odds API reports its own accounting on every response:
`x-requests-remaining`, `x-requests-used`, `x-requests-last`. The ingest
function stores that in the `provider.quota` setting after each run and checks
it before the next one, refusing to poll when the request would drop the
balance below `provider.credit_reserve`.

The check has to work this way round because the balance only ever arrives in a
response — that is, after the credit is already spent. Reading last run's
number before this run is what makes it a guard instead of a report. An
*unknown* balance is allowed through, never treated as unlimited, or a fresh
deployment could never make its first request.

**A 500-credit free plan is about 166 polls a month** at three markets in one
region. That is a grading board — opens, movement, closing lines, CLV — not a
live in-play ticker. `nfl.refresh_seconds.*` ship re-tuned for it, and the
freshness horizons ship widened to match, because a 15-minute staleness
threshold against a 4-hour cadence would mark a healthy feed stale within
minutes of every poll.

Check the budget any time:

```
GET /functions/v1/collective_odds_ingest/v1/status
  -> credits: { remaining, used, last_cost, estimated_cost_per_poll,
                reserve, polls_affordable }
     diagnosis: { healthy, state, detail, fix }
```

## The secret

Stored in Supabase → Edge Functions → Secrets. Each provider reads its own, in
exactly one module, and never writes it to the database, returns it in a
response, or logs it. Outbound URLs pass through `redactUrl` and error text
through `redactSecret` before reaching a log line, an `odds.ingest_runs` row,
or a probe response.

| Name | Used by | Required |
| --- | --- | --- |
| `NFL_ODDS_API_KEY` | OddsBlaze; also the fallback for The Odds API | yes |
| `THE_ODDS_API_KEY` | The Odds API, taking precedence over the above | only to run both providers with separate keys |

Optional:

| Name | Default | Purpose |
| --- | --- | --- |
| `NFL_ODDS_BASE_URL` | `https://odds.oddsblaze.com/` | Override the OddsBlaze endpoint without a deploy |
| `THE_ODDS_API_BASE_URL` | `https://api.the-odds-api.com/v4/` | Same, for The Odds API |
| `THE_ODDS_API_REGIONS` | `us` | Regions to request. **Each one multiplies the credit cost of every poll.** `eu` buys Pinnacle at double the price |

Never put a key in a repository, a page, a bundle, or a database row. The one
place it belongs is the edge function secret. If a key is ever shown on screen
— a screenshot, a shared terminal, a support thread — regenerate it in the
provider's dashboard rather than assuming nobody read it.

## "Odds unavailable" on the site

The site says only "unavailable": it will not speculate about a cause in front
of a visitor. The cause is named at
`GET /functions/v1/collective_odds_ingest/v1/status`, under `diagnosis`:

| state | Means | Fix |
| --- | --- | --- |
| `disabled` | `nfl.enabled` is false | set it true |
| `no_credential` | the active provider has no key in this function's env | add the secret |
| `never_run` | no ingest run has ever been recorded | `POST /v1/ingest?force=1`, then schedule it |
| `never_succeeded` | runs exist, none reached ok or partial | `/v1/probe` shows what the provider returned |
| `no_current_prices` | a poll succeeded, no book has a current price | `/v1/probe`, read the `mapping` section |
| `out_of_credit` | the plan is exhausted for the period | wait for reset, or raise the plan |

`never_run` is the one that produces an empty board on a correctly deployed
stack: everything is in place and nothing has ever called the provider.

## Deploying

1. **Migration.** Apply `supabase/migrations/20260821090000_nfl_odds.sql`. It
   is idempotent, so re-running it is safe. It creates the `odds` schema and
   adds `collective.odds_*` views and RPCs to the already-exposed `collective`
   schema, so no PostgREST schema setting has to change.

2. **Edge functions.** The dashboard editor takes one file per function, so
   the split sources are bundled:

   ```
   python3 tools/collective/bundle_functions.py
   ```

   That writes `supabase/functions/_bundles/*.bundle.ts`. Paste each into the
   dashboard as `index.ts` for a function of the same name.

   | Function | Enforce JWT verification | Why |
   | --- | --- | --- |
   | `collective_odds` | **OFF** | Public read surface for the site and the embed. The odds tables themselves are still server-side only: `anon` has no grant. |
   | `collective_odds_ingest` | **ON** | Writer. Additionally requires the service role key (how pg_cron calls it) or an admin account. |

3. **Confirm the provider.** In the admin console, **Odds → Probe the
   provider**. This makes one real request and reports the response
   *structure* plus whether the adapter could map the sample. See
   [Confirming the wire format](#confirming-the-wire-format).

4. **Schedule it.** See [Refresh schedule](#refresh-schedule).

## Refresh schedule

The cadence is data-driven, not compiled in. `collective_odds_ingest` picks an
interval each run and **returns without making a provider request** if it was
called before that interval elapsed. Calling it every minute is therefore
safe: it self-throttles.

| Setting | Default | When it applies |
| --- | --- | --- |
| `nfl.refresh_seconds.live` | 60 | At least one NFL game is in progress |
| `nfl.refresh_seconds.pregame` | 300 | A kickoff is inside the pregame window |
| `nfl.refresh_seconds.idle` | 1800 | Nothing is near |
| `nfl.pregame_window_hours` | 36 | Width of the pregame window |
| `nfl.stale_after_seconds` | 900 | Age of the last successful poll at which the feed stops counting as current |
| `nfl.book_stale_seconds` | 5400 | How far behind the freshest price on a game a book may be and still count |
| `nfl.books` | 8 books | Sportsbooks requested each run, in priority order |
| `nfl.max_books_per_run` | 12 | Hard ceiling on provider requests per run |
| `nfl.markets` | moneyline, spread, total | Canonical markets stored |
| `nfl.enabled` | true | Master switch |

Change any of them without a deploy:

```sql
select collective.odds_set_setting('nfl.refresh_seconds.live', '30'::jsonb);
select collective.odds_set_setting('nfl.books',
  '["pinnacle","draftkings","fanduel","betmgm","caesars"]'::jsonb);
```

**Cost note.** One run makes one request per book, so eight books is eight
requests. At the live cadence that is ~480 requests/hour. On a trial plan,
trim `nfl.books` before you raise the cadence.

Wiring it to pg_cron (requires `pg_cron` and `pg_net`):

```sql
select cron.schedule('collective-odds-nfl', '* * * * *', $$
  select net.http_post(
    url     := 'https://<project>.supabase.co/functions/v1/collective_odds_ingest/v1/ingest',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body    := '{}'::jsonb);
$$);
```

Any scheduler works — the function is a plain HTTPS endpoint. Send the service
role key as the bearer token, and store that key wherever your scheduler keeps
secrets, never in a migration committed to the repo.

## The data model

All storage lives in the `odds` schema. Nothing there is exposed through
PostgREST; the API surface is the `collective.odds_*` views and functions,
granted to `service_role` only, with `anon` and `authenticated` explicitly
revoked.

Revoked on the **functions** as well as the views, and that is not a detail.
Postgres grants `EXECUTE` on a new function to `PUBLIC` by default, and these
are `SECURITY DEFINER` functions in a PostgREST-exposed schema — so without an
explicit revoke the view grants are decorative, and `odds_set_setting`,
`odds_ingest` and `odds_finalize_closing` are reachable by anyone who can
reach the schema. The migration revokes `PUBLIC` from every function in `odds`
and every `collective.odds_*` function, as its last statement so it covers
functions defined anywhere in the file, and `tests/collective/odds_schema_test.sql`
asserts it.

| Table | What it holds |
| --- | --- |
| `odds.events` | Canonical NFL game. Identity is our own uuid, derived from league + teams + league-day. |
| `odds.event_providers` | `(provider, provider_event_id) → event_id`. A mapping, never the identity. |
| `odds.snapshots` | Append-only price history. One row per real change. |
| `odds.current_main_state` | The newest main-line price per series, maintained on write. |
| `odds.closing_lines` | Written once, after kickoff, from the last pre-kickoff price. |
| `odds.books` | Sportsbook registry. `is_sharp` marks reference books. |
| `odds.markets` | Market registry. `kind` separates game lines from prop and futures families. |
| `odds.team_aliases` | Every spelling of a team → one code. |
| `odds.ingest_runs` | Per-run counts, timings and sanitized errors. |
| `odds.settings` | Every tunable above. |

`odds.current_main_state` is a cache of what `odds.snapshots` already says.
Deriving it with `DISTINCT ON` is correct but scans the whole history, and a
board render asks for it once per game per market — roughly 450ms on one NFL
week of movement, against 100ms with the state kept. History is untouched:
still append-only, still complete. After a backfill or a manual edit, resync
with `select odds.rebuild_current();` (the migration runs it, so applying it
to a database that already holds snapshots is correct rather than empty).

Views: `odds.current_main` (over that state table),
`odds.current_odds` (newest per line, including alternates),
`odds.opening_lines` (first stored price per series — immutable by
construction, so it needs no writer and cannot drift).

### Why event identity is ours

If the provider's event id were the identity, changing providers or adding a
second one would fork every game in two. Instead the identity is
`(league, home_code, away_code, commence_date)` with `commence_date` in league
time (`America/New_York`) — a Sunday night kickoff is filed under that Sunday,
not the Monday it falls on in UTC. Provider ids map onto that identity, and an
existing mapping wins even if the kickoff moves. A game rescheduled within a
few days updates rather than duplicating.

### Why history is append-only

A re-poll that finds no change writes nothing: the ingest RPC compares a
content hash against the newest row for that series first. So every row in
`odds.snapshots` is a real move, and this sequence stays fully recoverable:

```
Chiefs -3.5 -110
Chiefs -3.5 -115
Chiefs -4.0 -110
Chiefs -4.0 -105
```

## Normalization rules

**Teams.** Provider team strings go to the database as written; `odds.resolve_team`
maps them through `odds.team_aliases`. All 32 clubs are seeded with their full
name, city, nickname, abbreviations and relocations (`OAK → LV`, `SD → LAC`,
`STL → LAR`). If `collective.team_aliases` exists, its rows are imported too,
so the alias an admin added through the quarantine flow also resolves here.
A team that resolves to nothing is **reported as unmatched, not guessed**.

**Prices.** American only. A value in the impossible band between -99 and +99
is rejected rather than stored, because it means the field was not American
odds and a fabricated probability would follow it everywhere.

**Spreads.** Home convention throughout: negative means the home team is
favoured. This is the same convention the Collective already uses for
`projected_spread`, which is the only reason a model number and a market
number can be subtracted.

**Consensus.**
- Spread and total: median of the main lines across retail books.
- Moneyline: median of the **de-vigged** two-way probabilities. American odds
  are never averaged.
- Sharp books (Pinnacle, Circa, BookMaker) are reported separately under
  `consensus.sharp` and are never folded into the retail consensus.

**Best price.** Grouped by line. Within one line the better price is
unambiguous and is marked. Across lines nothing is ranked: `-4 -105` and
`-3.5 -108` are different bets, and the payload has no cross-line "best"
field for a UI to reach for. The "primary line" is the one the most books are
on, ties broken toward the median.

**Opening and closing.** Both are medians of each book's own opener/closer
across retail books, computed the same way, so they are comparable. Each
book's individual opener is kept under `opening[…].by_book`.

**A book that stops quoting stops counting.** `odds.current_main_state` keeps
each book's last price forever, so without a horizon a book that takes a
market down would go on voting in the consensus and offering a best price
nobody can take. A price more than `nfl.book_stale_seconds` behind the
freshest price *on that game* drops out of the consensus, the best price and
the book grid. Measured against that game's freshest price rather than against
now, so a settled game whose prices are all equally old keeps its whole book
list.

**Closing the market is not ending the game.** `odds.finalize_closing` sets
`closing_finalized` and nothing else. Kickoff means the market closed; the
game is still being played, and status and liveness stay the feed's to report.

**Closing is not "current".** `odds.closing_lines` is written only after
kickoff, only from prices captured before it. Until then a game's `closing`
object is empty and `market_closed` is false. A game that kicked off with
nothing captured beforehand reports `no_pregame_capture` rather than
borrowing a later price.

## Event matching against the Collective slate

`odds.events` and `collective.games` are separate on purpose: the slate is
authored by an admin, the feed by a provider. `collective.odds_link_games`
joins them where they describe the same game, reading `collective.game_detail`
and matching on resolved team codes plus league-day. The link populates
`odds.events.collective_game_id`, which is what lets a model page ask for the
market by the Collective's own game id.

It runs at the end of every ingest, and on demand from **Odds → Link games**.

## Reading it

`collective_odds`, all GET, all public, all carrying a freshness envelope:

| Route | Returns |
| --- | --- |
| `/v1/nfl/status` | Feed health: last capture, books current, live games, last run |
| `/v1/nfl/games` | The slate, light (no book grid) |
| `/v1/nfl/odds` | The slate with the full book grid |
| `/v1/nfl/odds/:eventId` | One game (also accepts a Collective game id) |
| `/v1/nfl/game/:gameId` | One game by Collective game id |
| `/v1/nfl/odds/:eventId/history` | Every stored state, filterable by market/book/outcome |
| `/v1/nfl/odds/best` | Best price per line, one game or the slate |
| `/v1/nfl/consensus` | Consensus only |
| `/v1/nfl/closing/:gameId` | The captured closing line for a Collective game |
| `/v1/nfl/assistant` | Compact market snapshot with instructions, for a research assistant |

Query params: `days` (default 8), `from`, `to`, `week`, `limit`, `books=0`.

**Light versus detailed.** `/v1/nfl/games`, and `/v1/nfl/odds?books=0`, return
the consensus, the best price at each line, opening and closing, and a compact
`book_names` map — everything a summary line needs, without the per-book grid.
`/v1/nfl/odds` returns the full grid. On a sixteen-game slate that is roughly
120KB against 420KB, so the site requests the light form everywhere except the
Market page, which is the only surface that renders the grid.
`MCOdds.board()` defaults to light; pass `{ books: true }` for the grid.

Every payload begins with:

```json
{
  "source": { "provider": "oddsblaze", "league": "nfl" },
  "last_updated":   "2026-09-20T14:31:07Z",
  "last_change_at": "2026-09-20T11:02:44Z",
  "age_seconds": 42,
  "state": "live",
  "stale_after_seconds": 900
}
```

`last_updated` is the **last successful poll**. `last_change_at` is when a
price last actually moved. They answer different questions and freshness is
judged on the first: unchanged polls write nothing by design, so keying
staleness on the newest price made a perfectly healthy feed read "stale"
through any quiet midweek stretch — and a staleness label that cries wolf
teaches people to ignore the one label that is supposed to mean something.

`state` is `live`, `stale`, or `unavailable`. A stale payload still carries its
prices, labelled and aged — it is never relabelled current. An unavailable one
carries no prices at all.

A game with no stored price is a separate condition from a stale feed, and the
UI says so separately: "No market posted for this game yet" against "Odds
unavailable".

## Stale and unavailable in the UI

`collective/odds.js` enforces the three display rules rather than documenting
them:

1. Nothing renders without its capture time. `MCOdds.freshChip()` is on every
   market block.
2. `LIVE` appears only when the payload says a game is live.
3. No price means the markup says so — "Market unavailable", "no price
   posted" — never a blank that reads as zero.

Age is recomputed in the browser from the timestamp, not read from
`age_seconds`, which was correct when the response was cached and is not
correct a minute later.

If the read function itself fails it still answers 200 with an `unavailable`
envelope and an empty `games` array, so a page shows "odds unavailable"
instead of breaking. A failed fetch in `odds.js` does the same.

## Frontend

`collective/odds.js` is the only place the front end reads odds. It holds no
provider URL and no credential.

```js
MCOdds.configure({ api: 'https://<project>.supabase.co/functions/v1' });
MCOdds.injectCss(document.head);          // or a shadow root
const board = await MCOdds.board({ days: 8 });

board.find({ game_id, home, away });      // Collective game → market
MCOdds.marketLine(game, board);           // one-line summary
MCOdds.marketCard(game, board);           // full book grid
MCOdds.edgeHtml(modelSpread, marketSpread, home, away);
```

Where it is wired:

| Surface | What it shows |
| --- | --- |
| Wall (`#`) | Market line under each game header, above the model numbers |
| Board (`#board`) | Market line per game, plus model-vs-market per model row |
| Market (`#market`) | The research page: every book, consensus, sharp reference, open/current/close, models on each game |
| Market game (`#market/<eventId>`) | One game with full line movement |
| Model page (`#/model/<creator>/<model>`) | "Against the current market" for that model's live numbers |
| Performance explorer (`#performance`) | Two models and the market, side by side on the same games |
| Creator dashboard | The market a creator is about to submit against |
| Member dashboard | Upcoming games with the current market |
| `collective/embed.js` | Market line inside each game block on a member's site |
| `collective/admin.html` | Odds operations, plus a captured-close prefill on Results |
| `app.html` | `nfl_odds` research source (`SOURCES.nfl_odds`, adapter `nflOdds`) |

The embed loads `odds.js` from its own origin and publishes its palette as CSS
variables into the shadow root, so the market matches the host's theme and is
rendered by the same code as the site.

## Model versus market

`MCOdds.edge(modelSpread, marketSpread, home, away)` returns null unless both
numbers exist. Both are home-convention spreads, which is the only reason they
can be subtracted.

```
model KC -6.2, market KC -3.5  →  2.7 points toward KC
model KC -1.5, market KC -3.5  →  2.0 points toward BUF
model KC -3.5, market KC -3.5  →  "in line with the market"
```

A model that published only a pick side has no comparison, and the UI renders
a dash rather than deriving one.

## CLV

The pieces are stored, and the calculation is deliberately not run off a
current price:

| Need | Where it is |
| --- | --- |
| Line and price when the bet was taken | `odds.snapshots` (every state, with `captured_at`) |
| Closing line and price | `odds.closing_lines` (written once, after kickoff) |
| Book | `book_id` on both |
| Whether the market has closed | `odds.events.closing_finalized` |

A closing number is only ever read from `odds.closing_lines`. If that is empty
the market has not closed, and the honest answer is that there is no CLV yet.

## Confirming the wire format

The OddsBlaze endpoint, parameters and response shape used by the adapter come
from the OddsBlaze API documentation (`docs.oddsblaze.com`): a GET carrying
`key`, `sportsbook`, `league`, and optionally `market`, `price`, `live` and
`main`, answering with `updated`, `league`, `sportsbook` and an `events` array
whose entries carry `id`, `teams.home` / `teams.away`, `date`, `live` and an
`odds` array of `{ id, market, name, price, main, selection }`.

Confirm it against the live API before trusting a run:

**Admin console → Odds → Probe the provider**, or:

```
POST /functions/v1/collective_odds_ingest/v1/probe
Authorization: Bearer <service role key or an admin session>
```

The response reports the redacted URL, the HTTP status, the observed key paths
(`observed_shape`), a sample event and odds row, and — the part that matters —
`mapping`, which is the real adapter run over the real sample:

```json
{ "ok": true,
  "observed_shape": ["events[].odds[].price", "events[].teams.home.name", "…"],
  "mapping": { "mapped": 18, "unmapped": [] } }
```

`mapped > 0` with an empty `unmapped` means the adapter reads the live feed.
If `unmapped` has entries, each names the reason and the row's **key names**:

```json
{ "book": "draftkings", "reason": "unrecognised market \"Alt Spread\"",
  "keys": ["id", "market", "name", "price", "main", "selection"] }
```

That tells you exactly what to add — usually one alias in `MARKET_ALIASES` or
one candidate field in `readOdd`, both in `_shared/oddsblaze.ts`. Rows are
reported rather than force-fitted precisely so an API change shows up as a
diagnosable report instead of silently wrong numbers.

## Adding another provider

1. Write `supabase/functions/_shared/<vendor>.ts` exporting an `OddsProvider`:
   `isConfigured()`, `fetchSlate()` returning a `NormalizedSlate`, and
   `probe()`. Read its credential from its own secret, and pass every outbound
   URL and error through `redactUrl` / `redactSecret`.
2. `registerProvider(yourProvider)` in `collective_odds_ingest/index.ts`.
3. `select collective.odds_set_setting('provider.default', '"<vendor>"'::jsonb);`
4. Add a row to `odds.providers`.
5. **Insert the row into `odds.providers` before pointing `provider.default`
   at it.** `odds.event_providers.provider` and `odds.snapshots.provider` are
   both foreign keys to that table, so a missing row does not degrade — every
   ingest dies on the FK and the board stays empty with the cause buried in a
   run record. There is a schema test for exactly this.
6. Give every module-level name in the new file a prefix unique to that
   provider. Bundling flattens all providers into one scope, so a second
   `DEFAULT_BASE` or `apiKey` is a redeclaration error — `theoddsapi.ts` uses
   `TA_` / `ta`. `sh tools/collective/typecheck.sh` catches this; the
   module-level check alone does not.

Nothing else changes. The schema, the read API, the components and every page
are already vendor-agnostic: `odds.events` identity is ours, and provider event
ids are a mapping. Two providers can feed the same event side by side.

## Adding markets

Props, alternates and futures were designed for, not deferred:

- `odds.markets.kind` already separates `game`, `team_prop`, `player_prop`,
  `future`.
- `odds.snapshots.outcome` is free text with `outcome_label`, so a player or a
  team name is a value, not a schema change.
- `is_main` already distinguishes main lines from alternates, and alternates
  are already stored — `odds.current_main` just filters them out of the
  main-line view.
- A market the feed sends that we have never seen is auto-registered as
  `auto_added, enabled=false`, so it appears in the registry rather than being
  dropped silently.

To turn one on: add it to `GAME_MARKETS` or its own family in
`_shared/odds_normalize.ts`, map its vendor label in `MARKET_ALIASES`, add its
provider id to `PROVIDER_MARKET` in the adapter, and add it to the
`nfl.markets` setting.

## Errors

| Condition | Behaviour |
| --- | --- |
| `NFL_ODDS_API_KEY` missing | `503 not_configured`. No request is attempted. |
| Invalid or unauthorized key | Run recorded `error` with `invalid_or_unauthorized_key`. No body is echoed. |
| Trial or plan expired | `plan_or_trial_expired` |
| Rate limited | `rate_limited`. Back off by raising the interval or trimming `nfl.books`. |
| Timeout | `timeout` after 12s per book |
| Malformed JSON | `malformed_json`. Nothing is written. |
| Every book failed | `502 provider_unavailable`, recorded as an error — **not** as a slate with zero games. |
| Some books failed | Run recorded `partial`, with the failures listed. The books that answered are stored. |
| Empty NFL slate | A genuine empty week: run is `ok` with `events_seen: 0`. |
| Unknown team | Event reported in `unmatched` with reason `unknown_team`. Nothing stored under a guessed identity. |
| Unparsable kickoff | `unparsable_commence_time`, same treatment. |
| Unexpected market | Registered disabled, `auto_added=true`, and reported. |
| Price not American odds | Row rejected and counted in `rows_rejected`. |
| Database failure | `500 server_error`, run marked `error` with a redacted message. |
| Read function fails | 200 with an `unavailable` envelope, so the site stays usable. |

## Troubleshooting

**Every page says "odds unavailable."**
Admin → Odds. Check `Provider: credential present`. If not, the secret is
missing. If present, run **Probe the provider**.

**The probe returns `ok` but ingestion writes nothing.**
Look at the last run's `rows_rejected` and the `unmapped` sample. If
`snapshots_written` is 0 and `snapshots_unchanged` is high, that is correct
behaviour: the market did not move.

**A game shows model numbers but no market.**
The odds event is not linked to the Collective game. Run **Odds → Link games**.
If it still does not link, the team codes on the slate did not resolve —
add an alias:

```sql
insert into odds.team_aliases (league, alias_norm, team_code, source)
values ('nfl', odds.norm_text('Your Spelling'), 'KC', 'manual');
```

**A market shows for one book only.**
Check the last run's `books_failed`. A single book failing is normal and
recorded per book.

**Results shows "no price was captured before kickoff."**
Ingestion was not running in the window before that game. The closing line is
genuinely unavailable for it; settle with your own number.

**Prices look stale even though ingestion is running.**
Freshness is judged on the last successful poll, so this means runs are not
completing, not that the market is quiet. Check Admin → Odds → Last run.
If runs are completing, compare `nfl.stale_after_seconds` against the
effective interval: at the idle cadence (1800s) with a 900s window the feed
will read stale between runs. Either shorten the interval or widen the window.

**A book vanished from the consensus.**
It has not quoted inside `nfl.book_stale_seconds` of the freshest price on
that game. That is deliberate — a price a book has taken down is not a price
you can get. Widen the setting if the poll interval is longer than the
window.

## Verification

```
sh tests/collective/run_all.sh          # everything below except the type check
sh tools/collective/typecheck.sh        # modules and deployed bundles
```

`run_all.sh` runs five stages, and the first one matters more than it looks:

1. **deploy artifact matches source** — `bundle_functions.py --check`. The
   bundles under `_bundles/` are what actually gets deployed; the split
   sources never are. A fix that lands in `_shared/` and is not regenerated
   ships as nothing at all, and every other test here would still pass while
   production ran the old code. Nothing else can see that, so it runs first
   and fails the suite.
2. schema behaviour against a real Postgres 16
3. adapter unit tests
4. the end-to-end pipeline
5. the browser components, plus a parse check of every inline page script

`run_all.sh` needs a local Postgres and applies
`tests/collective/odds_schema_fixture.sql`, which stands in for the parts of
the deployed project the migration touches. The end-to-end test puts an
OddsBlaze-shaped fixture through the real adapter into the real SQL and asserts
on what landed, including that nothing stored carries a credential.

The only synthetic odds in the repository are in
`tests/collective/fixtures/oddsblaze_nfl_sample.json`, read by tests alone. No
production path reads a fixture, and no page contains a hardcoded price.
