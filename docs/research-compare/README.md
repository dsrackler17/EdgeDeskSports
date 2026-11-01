# Research compare: one comparison path for the Research Queue and Smart Money Tonight

`lib/edgedesk_research_compare.js` (`window.EDResearchCompare`) is the one place that decides
whether an EdgeDesk number and a price can be set side by side, whether both are current, and
by how much they differ. The Research Queue (`lib/edgedesk_overview.js`) and the Smart Money
Tonight cards (`lib/edgedesk_radar_ui.js`) both compare through it. For NHL it delegates to
`EDNHLCompare`, which the matchup page already uses, so all three surfaces show the same gap.

It computes no probability, selects no wallet, and changes nothing in Radar's selection,
publication or grading (H-RADAR-01 and H-RADAR-02 are untouched: `supabase/radar*.sql`,
`research/radar/**` and `lib/edgedesk_radar.js` are unchanged).

## The data path

| Step | Queue (games) | Smart Money cards |
|---|---|---|
| provider | ESPN public scoreboard (schedule and one book's line) | Polymarket holders and prices (`polymarket_sync`), Pinnacle via the odds gateway |
| ingestion | `games-slate.yml` → `tools/slate/build.js` → `today/slate.json` | `poly_holder_snapshots`, `poly_price_snapshots`, `signals` |
| canonical ids | `<sport>:espn:<id>`; `EDGames.sameEvent` and `sameSide` | `poly_markets.event_id` (`signals.event_id`), matched to the slate by `RC.matchEvent` |
| model output | `tools/slate/research.js` attaches each sport's model block (now with `generated_at`) | the same slate model block, through the match |
| comparison | `RC.fromSlate` | `RC.fromRadarCard` |
| API and cache | committed file, read by `EDGamesUI` | `radar_tonight()`, `X.memo('ov:radar', 2 min)` |
| UI | `O.rowV2HTML`, `O.priorityHTML` | `U.cardV2HTML` |
| published snapshot and grading | none (the queue publishes nothing) | `radar_cards` and `radar_card_results` (`supabase/radar_record.sql`), unchanged; `RC.snapshot` freezes a client-side copy |

## Root causes of the reported symptoms

| Symptom | Evidence | Cause | Change |
|---|---|---|---|
| Most queue prices read "past price, 2 h ago" | `games-slate.yml` is scheduled at `7,37 * * * *` (48 runs a day). Its run list shows 18 runs from Oct 28 to Nov 1, 3.5 to 7.5 h apart (13:11, 05:51, 23:40, 20:15, 16:17 UTC). Every run committed. | GitHub runs scheduled workflows best-effort, and this one has run every few hours, not every 30 minutes. Every slate price is read by that job, so prices age past the 90-minute limit. Labelling them "past price" was correct. | `supabase/games_slate_dispatch.sql` is an opt-in pg_cron wake-up that dispatches the workflow every 30 minutes, using the existing Vault token. **This is not fixed until an owner installs it.** |
| Smart Money "fair value" more than 90 minutes old | `radar_tonight_cards()` sets `fair` = `signals.sharp_fair`, which is Pinnacle's Shin de-vigged price (`supabase/bet_checker.sql`, the SHARP-LAG registration). That registration says no Pinnacle observation exists after 2026-10-10 and that the provider cycle resumes 2026-11-01. | The number was labelled "EdgeDesk fair", but it is a market reference whose feed is out. The card also printed it even when `fair_current` was false. | The card now shows it as "Pinnacle de-vigged reference" in the detail, marks it stale and does not compare it. "Model fair" is now EdgeDesk's own model probability for the exact contract. |
| Utah–Philadelphia: model moneyline beside a market puck line | `today/slate.json`: the model block has `fair.ml_home 126` and no spread; the market has a moneyline and a spread of +1.5. `O.rowHTML` picks the model value and the market value through separate fallback chains (spread, then win%, then ML; and spread, then ML). | Two independent selections set two different markets side by side. | One selection: `RC.fromSlate` picks the first market both sides price, and both numbers are labelled with that market. |
| EST, ET and CST mixed | `lib/edgedesk_radar_ui.js` `U.when` hard-codes `America/New_York` with an "ET" suffix. The queue uses the reader's zone, falling back to America/Chicago. 2026-11-01 is the fall-back day, so CDT becomes CST. | Two formatters. | Cards use `EDGames.timeText` in the reader's zone (`U.whenIn`). |
| High Point–Liberty at 10:59 PM CST | ESPN event 401920409: `start_utc 2026-11-02T04:59Z`, `time_tbd:false`, `status_detail "11/1 - 11:59 PM EST"`. It is part of the "Field of 68 Opening Day Marathon", an overnight event. | **Valid.** 11:59 PM EST is 10:59 PM CST. | None. A test pins it. |
| Games out of chronological order | `O.compare` orders by status, then watchlist or Card, then research completeness (0–3), and only then by start time. | Order by design, but the queue is read as a schedule. | The default view is now **Starting soon**: status group, then start time, then id. The old order remains behind the flag. |
| 50¢ entry, 54¢ now, "up 3¢" | `U.cents` rounds each number on its own: an average entry of 0.5049 shows as 50¢, a price of 0.535 as 54¢, and the movement of 0.0301 as 3¢. | Rounding each number independently. | Prices are shown to the tenth of a cent when not whole (50.5¢ → 53.5¢), and each printed difference is the difference of the printed prices. |
| Methodology dominates on mobile | Three paragraphs of method and the observed-activity list come before or between the cards. | Layout. | The method and observed activity are in disclosures below the cards. Each card's detail sits behind "Details and sources". |

## Rules

* **Comparability.** Sport, canonical event, side, market type, period, line and settlement must
  all match (`RC.compatible`). NCAAM and NCAAW are different sports. A settlement rule that is
  not stated (for example, how the NFL model's `home_win` treats ties) is never assumed. A
  projected margin is never turned into a win probability: a card on a spread the model does not
  price says "Comparable model unavailable".
* **Freshness** (`RC.POLICY`). Each source has its own limit: twice its build schedule, or the
  source's written rule.

  | Source | Limit | Clock |
  |---|---|---|
  | NHL and NBA models | 6 h | built every 3 h |
  | NFL model | 12 h | |
  | Basketball lab and CFB models | 30 h | daily |
  | Scoreboard line | 90 min | EdgeDesk's read time (the source gives none) |
  | Polymarket displayed price | 30 min | |
  | Polymarket ask | 15 min | the quote's own time |
  | Pinnacle reference | 90 min | |

  Model inputs count separately. Stale inputs (`data_state`) or limited data quality make a model
  stale however recently it ran, and unconfirmed goalies are named. A started game's comparison is
  `PREGAME_ONLY`: there is no live model.
* **Statuses.** Active: Below, Above or Near model fair value, or Compared. Suppressed, each with
  its reason: Model refresh needed, Model time not recorded, Price refresh needed, No current
  price, Comparable model unavailable, Not comparable, Pregame comparison.
* **Sign and units.** `diff = price − model fair` for the named side, in cents. pp is a
  probability difference, % is a return, ¢ is a price. "Near fair" applies only when the printed
  difference is 0.0¢.
* **EV** is shown only at an executable ask with a recorded fee: `p / (ask + fee) − 1`, per $1,
  top of book. An indicative price gets no EV, and the card says why. Depth is reported as full,
  partial, insufficient or unknown.
* **Agreement.** Wallets and the model favouring the same side changes nothing. Dollars are
  labelled as cost basis, not skill. Wallets are not claimed to be independent people.
* **Research priority** ranks only active, non-zero comparisons of upcoming games, within one
  sport and market group. A point is not a percentage point, and an NFL point is not an NBA
  point. Everything else is listed apart with its reason. It is research priority, not a ranked
  recommendation.
* **Snapshots.** Every result carries `calc: edgedesk_research_compare/1`. `RC.snapshot` deep-freezes
  what was shown. Radar's published cards remain the database's append-only `radar_cards`.

## Refresh

* The queue reads the committed slate, so no provider is called on a page view. The Smart Money
  door is memoised for 2 minutes. An older `radar_tonight()` answer that lands after a newer one
  is discarded (`RC.newer` on `as_of`).
* `supabase/games_slate_dispatch.sql` dispatches `games-slate.yml` at :12 and :42.
  * Debounce is 10 minutes, and an advisory lock prevents racing pokes.
  * The workflow's own concurrency group prevents overlapping builds.
  * The builder reads only the buckets that are due, and failed reads keep their backoff.
  * `push_generated.sh` never rebases.
  * A missing token reports `no_token`, never success. Every decision is logged in
    `games_slate_pokes`, which only the owner can read.

## Observability

`window.EDOverview.debug()` in the console (operators only, never drawn) returns:

* the slate's age and refresh plan, and the last successful read per provider feed;
* counts by comparison status and suppression reason, for the queue and for the cards;
* quote and model ages;
* Smart Money cards that matched no game on the schedule, with why;
* closing-price coverage (graded, with a close, no close, pending, void).

## Rollout and rollback

* **Flag:** `EDResearchCompare.FLAG.on` (default on). `?rc=0` on the URL shows the previous queue
  and cards for that page view; `?rc=1` forces the new ones. The terminal loads no `EDFlags`
  (`tools/site/free_access.test.js`), so the switch lives in the module.
* **Roll back without a revert:** set `RC.FLAG.on = false`. The previous renderers
  (`O.rowHTML`, `O.order`, `U.cardHTML`) are untouched and still tested.
* **Refresh:** install `supabase/games_slate_dispatch.sql` from the SQL editor (after
  `editorial_dispatch_sql.sql` steps 1 and 2). To roll back, run
  `select cron.unschedule('games_slate_dispatch');`.

## Known limitations

* `radar_tonight()` returns Polymarket's displayed price (an outcome price or midpoint), not the
  order book's ask, so cards compare against an indicative price and show no EV. The card
  renderer already accepts `ask_price`, `ask_size`, `ask_at` and `fee_per_share`. Adding them to
  the door is an additive SQL change to the experiment's surface, so it belongs in its own
  reviewed pull request.
* Polymarket settlement per sport (`RC.SETTLE.venue.polymarket`) is read from Polymarket's
  standard sports rules: overtime included, and an NFL tie settles at 50/50. Check it against
  each market's rules text before relying on it.
* The NHL matchup page's `price_fresh` gate uses a 30-minute limit for a value claim. The queue
  uses the board's 90-minute past-price rule for a comparison. These are different questions,
  and both are labelled.
* Model blocks get `generated_at` from the next slate build onward. Until then, models other
  than NHL and basketball (whose source times are in the slate's `sources` list) read "Model
  time not recorded" and are not ranked.
