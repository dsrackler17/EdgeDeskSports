# Today's Games

Open EdgeDesk and the first thing on the Research screen is what is being played
today, in every sport EdgeDesk lists, on your own calendar day. Each game is one tap
from the research EdgeDesk already has on it.

| Where | What |
|---|---|
| Terminal, Research screen (`app.html`, `#gamesStrip`) | The strip: sport pills, compact cards, **View all games**. A swipeable rail on a phone, a grid on a desktop. |
| Terminal, `#games[/<sport>[/<date>]][?status=…&q=…]` | The full slate: Yesterday / Today / Tomorrow and a date picker, sport and status filters, team search. Live first, then scheduled by start time, then final, then postponed and canceled. The state lives in the hash, so research opened from here comes **Back** to the same slate. |
| Public `/today/` | The same slate for a signed-out visitor: schedule, status, scores, the free published research and the public read for up to eight games. **No prices and no EdgeDesk numbers.** |

Research, not picks. An available game is not a recommendation.

## The pieces

| File | Role |
|---|---|
| `lib/edgedesk_games.js` (`EDGames`) | The kernel, browser and Node: the reader's day (DST-safe, America/Chicago fallback), ESPN normalisation, statuses, ordering, doubleheaders, dedupe, the live overlay, market formatting and the integrity check, The Odds API orientation, research links, readiness through `lib/edgedesk_readiness.js`, the URL state. |
| `lib/edgedesk_games_ui.js` (`EDGamesUI`) + `lib/edgedesk_games.css` | The strip, the page and the matchup dialog, for both hosts. Polling, the device copy, local-midnight rollover. |
| `tools/slate/espn.js` | The ESPN scoreboard adapter: one plain request per feed per day. Odds only before the game, only from a named book, only through the football record's orientation-checked line reader. |
| `tools/slate/artifacts.js` | The fallback: the schedules this repository already builds (`football/home/schedule.json`, `hockey/slate.json`, `soccer/slate.json`, `basketball/slate.json`). |
| `tools/slate/research.js` | Which research each game already has (module + entity, free article, model, the board's read, a certified signal). |
| `tools/slate/build.js` | Builds `today/slate.json`. |
| `tools/slate/live_poll.js` | The live poller (gate + poll), writing through `slate_live_ingest()`. |
| `supabase/games_slate.sql` | The live layer and the subscriber's read of captured prices. |
| `.github/workflows/games-slate.yml` · `games-live.yml` · `deploy-games-slate.yml` · `slate-tests.yml` | Build, live, deploy (manual), CI. |

## Data, in order of authority

1. **`today/slate.json`**: the slate. It is static, so every visitor reads the same file and nobody reaches a provider. It holds every game on the US-Eastern days `[today − 2, today + 3]`, so any reader in any zone has yesterday, today and tomorrow. It also holds each sport's next games beyond that window, for **Upcoming**. Each game carries its research reference. Prices sit in a separate `markets` map.
2. **`public_slate_live()`**: the live layer, written by the poller about every 45 seconds while games are on. The page lays it over the slate only for the (feed, day) pairs it read *more recently* than the slate did. A game the live read no longer lists for a day it covered has moved or been dropped, and it leaves that day.
3. **`slate_markets()`**: the subscriber's prices. These are the `featured` snapshots capture has already bought, with every book and each book's own update time. The terminal picks one book per game (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, …, in that order), so both sides of every number come from the same book. Entitled readers only. It is never called from `/today/`.

**The schedule never depends on odds.** The builder reads schedules from ESPN's scoreboard, not from the odds pipeline. It spends no credit, and the slate is complete while capture is paused or the quota is exhausted (the state since 2026-10-10, `docs/odds-api-incident-2026-10/INCIDENT.md`).

## Coverage, sport by sport

The cells below describe the code paths. The real ESPN feed has **not** been read from the environment this was built in, because its network policy refuses `site.api.espn.com`. Run `npm run slate:verify` (or the workflow's *verify* input) on a runner to see what each feed answers today.

| Sport | Schedule, status, score | Fallback in the repo | Prices on the card | One-tap research |
|---|---|---|---|---|
| NFL | ESPN `football/nfl` | `football/home/schedule.json` (nflverse) | ESPN's pregame book quote; The Odds API capture for subscribers (when capture runs) | `#research/football/nfl\|<nflverse id>`, plus the free article |
| College football | ESPN `football/college-football`, `groups=80` (FBS) | `football/home/schedule.json` | as NFL | `#research/football/<ESPN id>`, the free article, the CFB board's read |
| NBA | ESPN `basketball/nba` | `basketball/slate.json` (72 h) | ESPN quote only (capture does not buy NBA) | **No research page yet.** Opens the matchup view, with the NBA model's fair prices when the 72-hour slate has the game. |
| College basketball | ESPN `basketball/mens-college-basketball`, `groups=50` (Division I) | `basketball/slate.json` | ESPN quote only | as NBA |
| NHL | ESPN `hockey/nhl` | `hockey/slate.json` (72 h) | ESPN quote (puck line); NHL capture is registered but disabled | `#research/nhl/<NHL id>` (ESPN `NJ`/`TB`/`LA`/`SJ`/`UTAH` mapped to the NHL's codes) |
| MLB | ESPN `baseball/mlb` | none in the repo (the MLB card lives in Supabase) | ESPN quote (run line); The Odds API capture for subscribers | `#research/baseball/g:mlb:<ET date>\|<away>\|<home>\|<game #>`, the MLB card's own key, for today and tomorrow |
| College baseball | ESPN `baseball/college-baseball` | none in the repo (`cbb.games` in Supabase) | ESPN quote only | `#research/baseball/g:cbb:<ESPN id>` |
| Soccer | ESPN `soccer/eng.1`, `esp.1`, `ger.1`, `ita.1`, `fra.1`, `usa.1`, `uefa.champions`, `uefa.europa` | `soccer/slate.json` (openfootball, CC0; the local kick-off is read in the league's own zone) | ESPN quote: 1X2 with the draw, total | **No research page yet.** The matchup view, with the league model's fair 1X2 (PROVISIONAL) for the five modelled leagues. |
| UFC / MMA | ESPN `mma/ufc`: a card is one event, its headline bout named by the card | none in the repo (`ufc.events` in Supabase) | none (the card has no single price) | `#research/ufc`: the UFC panel and its live fight center. There is no per-card route. |

**What a card says when something is missing.** "Odds unavailable" means no current captured price for the game. "Research not available yet" means EdgeDesk has no research page for it. "No model" means no EdgeDesk projection is on file. A card never shows a projection, a price, a score or a confidence it does not hold.

## Providers and permitted use

- **ESPN's public site API** (`site.api.espn.com`) is undocumented, keyless and carries **no published licence**. This repository already relies on it for football schedules and finals, college baseball, UFC and the CFB lab's quotes. Its pregame quotes name the book they come from. For a licensed production feed, the replacements are Sportradar or SportsDataIO for schedules and live scores, or The Odds API's `/scores` endpoint. The gateway can already build that endpoint's request (`supabase/functions/odds_gateway`), but it costs credits.
- **Team logos** are ESPN CDN URLs (`a.espncdn.com`), hotlinked from the reader's browser with `referrerpolicy="no-referrer"` and a monogram fallback. Pass `logos: false` to `EDGamesUI` to show monograms only.
- **openfootball/football.json** (soccer fallback) is CC0.
- **The Odds API** prices are shown only to entitled subscribers, from what capture already stored. Nothing here buys a price.

## Refresh

| What | How often | Who reaches the provider |
|---|---|---|
| The slate, yesterday and today | every 20 min (the workflow runs at :07 and :37) | the builder, one request per feed per day |
| The slate, tomorrow / later days / Upcoming | hourly / every 3 h / every 6 h | the builder |
| A past day whose games are all final | never again | nobody |
| A read that failed | retried after its interval, at most every 20 min | the builder |
| Live status, score and clock | about every 45 s while a game is live or within 45 min of its start | the poller (one job, all sports) |
| The page's own reads | slate every 10 min; live layer every 60 s while a game on the reader's day is live or about to start, every 5 min otherwise on today, never for a finished day; nothing while the tab is hidden | nobody: the page reads the static file and the database |
| The subscriber's prices | every 10 min while the page is open | nobody: `slate_markets()` reads stored captures |

A steady half hour costs a few dozen scoreboard requests for every sport together. A cold start (no previous slate) costs a few hundred once, spaced 120 ms apart.

## Failure and freshness

- **A failed read never empties a day.** The builder carries the previous read forward with its age. With no previous read, it uses the repo's own schedule, labelled "without live status or scores". With neither, it marks the day failed. The page then says **"Unable to load …"**, shows a dash on the sport's pill, and never says "No games scheduled".
- **"No games scheduled"** appears only when the source answered and the day is empty. When a sport has nothing on the day, its next games appear separately under **Upcoming** with their own dates, never under Today.
- **Stale data says so.** The slate's age is printed. Past six hours it is marked *(stale)*. A live read older than ten minutes shows *Last live update … ago*. A game past its start with no update since shows **Started**, with no score, and never Live. A price older than 90 minutes is shown as a past price, never as current.
- **The slate file cannot be loaded.** The page shows the copy saved on this device, labelled with its age. With no saved copy it shows "Unable to load games" and a **Try again** button.

## Readiness and signals

Each card's readiness is the five existing states from `lib/edgedesk_readiness.js` (`EDREADY.assess`): games available, research available, market verified, model ready, actionable signal. The game supplies the inputs it actually holds. The card shows them simply (*Research*, *Model*, *Odds verified*); the matchup view lists all five with the reason for each.

**A signal appears only when the owning engine certified one.** That means:

- the CFB decision engine's `BET` (`football/cfb_terminal/board.json`);
- the NFL pricer's `PLAY` under a `VALIDATED` tier (`football/nfl/slate.json`);
- the cross-sport engine's `BEST_SUPPORTED` pick (`engine/board.json`).

EDREADY then still requires a current market price and a valid model. The slate restates no threshold. A board read such as RESEARCH, INVESTIGATE, LEAN_PLAY or PASS is shown as *Read: …* and is never a signal. Today no sport is certified (the engine's verdict is PASS), so no card shows one.

## Deployment

1. **Merge the pull request.** GitHub Pages serves `today/slate.json` (a bootstrap built from the repo's own schedule files) and the new pages at once. The strip and `/today/` work immediately, without live scores.
2. **Turn on the slate job.** `games-slate.yml` runs on its own schedule. Run it once by hand (*Actions → Today's Games slate → Run workflow*) with **verify** checked to see what each ESPN feed answers from a runner. Then run it with **force** checked for the first full build. It commits `today/slate.json` through `tools/ci/push_generated.sh`.
3. **Apply the SQL.** Run *Deploy Today's Games (SQL)*, which needs the `SB_DB_URL` secret. Or paste `supabase/games_slate.sql` into the Supabase SQL editor; its last statement prints eight rows that must all say `ok`. The file needs no other file first. `slate_markets()` answers "not entitled" until `personal_research.sql`'s `edp_entitled()` exists (it already does in production).
4. **Live scores.** `games-live.yml` uses the `SB_SERVICE_ROLE` and `SB_URL` secrets every writer here already uses. Once step 3 is done it starts on its own schedule. Run it by hand to confirm.
5. **Nothing else.** No new secret and no new provider key is needed. The public page's anonymous door is `public_slate_live`, registered in `lib/edgedesk_plans.js`.

Rollback: revert the merge. The SQL is additive: drop `public.slate_live`, `public.slate_feed_state` and the three functions if you want them gone. No existing table is touched.

## Tests

| Command | What |
|---|---|
| `npm run slate:test` | The kernel (106 checks: DST and midnight, selection, statuses, doubleheaders, overlay, markets, readiness, URL) and the pipeline (59: adapter, builder carry-forward and fallback, research join, poller). |
| `npm run slate:sql` | `supabase/games_slate.sql` on a real PostgreSQL (23), with Supabase's own default grants in place. |
| `npm run slate:e2e` | Chromium at 390 px and 1280 px (86): the strip, the page, the dialog, the live overlay, the reader's prices, failure and the device copy, staleness, local midnight, `/today/`, and the terminal's own navigation. |

## Known limits

- The real ESPN feed has not been read from the build environment. The adapter is tested against a recorded ESPN odds block and constructed payloads in ESPN's shape. `npm run slate:verify` on a runner is the first live check.
- The MLB research link is the MLB card's own key, built from ESPN's club names and Eastern date. It opens the card's brief when the card (Supabase `mlb_game_cards`) holds that game, and the Baseball panel otherwise.
- NBA, college basketball and soccer have models (`basketball/`, `soccer/`) but no research page. Their cards open the matchup view and say so.
- UFC has no per-card research route. The link opens the UFC panel.
- The date picker covers the slate's window (two days back, three ahead). Later dates say they are outside it.
