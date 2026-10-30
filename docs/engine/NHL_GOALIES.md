# NHL starting goalies — an Observed input, and a card that changes with it

> Starters are an Observed (T0) input with a status and a source. The sync
> refreshes them close to puck drop. A game's card gets a new version when a
> starter, a status or a conflict changes.
>
> This is a data-correctness fix. The goalie effect weights, the xG core and
> the way edges are ranked are unchanged.
>
> **Since 2026-10-29 (§11, a methodology change)**, once the NHL lists both
> dressed lineups and both starters are Confirmed, the card's headline is
> priced by the variant that knows tonight's lineups and goalies.

## 1. What went wrong on 2026-10-25

On the morning of 2026-10-25 the Minnesota at Vancouver card named Kevin
Lankinen. That name came from EdgeDesk's usage projection
(`hockey/model/ratings.js` `projectStarters`): Lankinen 51.5%, Leevi
Meriläinen 48.5%. Meriläinen started.

Two things kept the card wrong all day:
- the projection reads completed games only, so it could not move before
  puck drop;
- the only way to confirm a starter was a hand entry in
  `hockey/data/confirmed_starters.json`.

**What the starter moves, and what it does not.** The production price is
`edgedesk_nhl_v1:xg_core`, and it has no goalie term. Vancouver's 41.7% and its
fair +140 were the same whoever started; a different starter does not move
them. The goalie enters through these:
- the goalie-aware variant (`xg_goalie_confirmed`). It prices each pairing:
  Lankinen against Pickard 41.2%, Meriläinen against Pickard 42.4%;
- the uncertainty spread;
- the evidence row "Projected goalie";
- the graphic's goalie line;
- the board's goalie note;
- the market evaluator's robustness gate.

Those are the numbers that were built on the wrong goalie. This change makes
them follow the real starter. It does not change the headline model.

## 2. The starter sync (`supabase/functions/nhl_goalie_sync`)

**Sources.** No scraper or client for starting goalies existed in the repo.
The `confirmed_starters` registry entry was manual-only. The NHL API client
(`hockey/sources/nhl_api.js`) reads schedules only.

| Source | What it gives | Status mapping | Tier |
|---|---|---|---|
| Daily Faceoff starting-goalies page (`/starting-goalies/<ET date>`, its Next.js `__NEXT_DATA__` JSON) | each game's named goalies, each with a strength word and a news time | Confirmed → Confirmed, Likely / Expected → Likely, Unconfirmed → Projected, nothing → Unknown | T0, third party |
| ESPN's public NHL scoreboard (`site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=<ET date>`), since 2026-10-30 (§10) | each team's `probableStartingGoalie`, with ESPN's status word; no update time | Confirmed → Confirmed, Expected → Likely, no probable → Unknown | T0, third party |
| NHL API game boxscore (`api-web.nhle.com/v1/gamecenter/{id}/boxscore`), read in the last three hours | the goalie flagged `starter: true`, by player id, once lineups post | Confirmed | T0, the league |
| `hockey/data/confirmed_starters.json` (unchanged, carried in the goalie inputs) | a hand entry with its source and time | Confirmed | T0 |
| EdgeDesk's usage projection | the likeliest goalie, with his start probability | Projected (labelled "EdgeDesk usage projection") | T2, the fallback only |

**Matching.** A reported name is matched to EdgeDesk's goalie registry on
the surname and the first initial, with accents folded. The club's own
goalies are tried first, then the league, which catches trades and call-ups,
but only when exactly one goalie fits. Anything else is kept as reported, as
`unmatched` or `ambiguous`. A goalie with no rating is priced at the
replacement-level prior and the card says so.

**The merge (one status per team).**
- **Sources agree:** the higher status, from the source that gave it.
- **Sources name different goalies:**
  - both observations stay on file;
  - the lead source's goalie is shown (the NHL, then a manual entry, then
    Daily Faceoff, then ESPN);
  - the status is the **lower** of the two, and never Confirmed (two
    confirmations of different goalies are not a confirmation);
  - the conflict is flagged.
- **No source names anyone:** the usage projection, labelled Projected.

**Cadence.** pg_cron pokes the function every five minutes, and the function
decides whether a run is due (`nhlgIsDue`):
- every two hours from 8:00 AM Eastern until the day's last puck drop;
- every 15 minutes in the final three hours before each puck drop;
- a final pass at T−30 for each game, recorded in the run's
  `final_pass_games`.

A missed slot is chased for up to 90 minutes. After a run that ends in
error (a source refusing every read, a database failure), the sync runs again
10 minutes later, then 20, then every 40 while it keeps failing, besides the
slots above (`retry_after_error` in the run's `due_kinds`). The error run's
`next_due_at` says when. Before this, one refused read held readiness in error
until the next slot. A declined poke is written as a
`skipped` row at most hourly, so the KPIs can tell a quiet morning from a dead
scheduler. Cards are kept for games starting within 30 hours.

**What the function reads.** It reads `hockey/goalie_inputs.json` (schema
`edgedesk_nhl_goalie_inputs_v1`), which the three-hourly NHL build now writes.
Per game, it holds:
- the goalie-aware variant's log expected goals with its goalie term at
  zero;
- the goalie coefficient (−0.709) and the pair calibration;
- the rating, at the game date, of every goalie who could start;
- the usage projection;
- the production headline, copied unchanged.

From these the function prices any pairing exactly as the slate prices its
goalie scenarios. `node hockey/build_slate.js --check` re-prices every
scenario from the file and fails on any difference. On the 2026-10-25 slate,
a build with this change is byte-identical to a build without it at the same
instant, apart from the new per-pairing market fields.

## 3. Tables (`supabase/nhl_goalie_layer.sql`, mirrored in `migrations/20261025230000_nhl_goalie_layer.sql`)

All are append-only. An update, delete or truncate is refused, for
service_role too. The one exception is `nhl_goalie_starters.is_current`, which
only the insert trigger may turn off.

| Table / view | One row per | Notes |
|---|---|---|
| `nhl_goalie_starters` | game, team and source, each time it changes; `source = 'consensus'` is the merged row the card uses | `game_id, team, goalie_id, goalie_name, status` (enum `projected / likely / confirmed / unknown`), `source, source_updated_at, fetched_at, is_current`, `conflict`, `conflict_detail`, `match_method`, `merged_from`. A new observation supersedes the current one (`is_current` false, `superseded_at` set). One current row per game, team and source. Confirmed needs a name, and a conflict is never Confirmed |
| `nhl_game_cards` | card version | versions 1, 2, 3 … per game, each superseding the latest, generated before puck drop. Every version records `goalie_pairing_used`, `goalie_status_home` / `_away` and `generated_at`, plus the starter rows it used, the headline, the pairing used, the full `pairing_range`, the edge gate, `known_limitations`, `change_note`, the model and variant. The table refuses an unconfirmed card without the range and the line "Starter not confirmed. Numbers may change.", and any card priced by a goalie variant other than `nhl_goalie_config.live_goalie_variant` |
| `nhl_card_edge_events` | an edge seen against a price | names the card version that was current at `detected_at`. A trigger refuses a superseded version or one not yet posted. A GATED card is never `BOTH_CONFIRMED` |
| `nhl_card_edge_clv` | the closing grade of an edge | rides the edge event, so CLV names that same version (`nhl_card_edge_clv_detail`) |
| `nhl_goalie_sync_runs`, `nhl_goalie_alerts` | run; alert (FAILURE / DEGRADED / DRIFT / WARNING) | |
| `nhl_goalie_readiness` | — | the KPIs (§6) |
| `nhl_goalie_card(game_id)` | — | the latest version and version 1, every source's current row, and freshness (FRESH; STALE past 30 minutes inside three hours of puck drop, past 150 minutes otherwise; FAILED; NO_RUN; PREGAME) |

**CLV in the file pipeline.** Each `hockey/ledger/<season>.jsonl` record and
each `research/clv/live/models_2026.jsonl` capture now carries the goalie
pairing it led with (and the certainty). A grade therefore reads the sheet
that existed. When the pairing changes, the ledger also writes a new record.

## 4. The card

The engine page's Overview opens with **Starting goalies**
(`lib/edgedesk_nhl_goalies.js`, from `rpc/nhl_goalie_card`):
- **Each starter:** a badge (Confirmed / Likely / Projected / Unknown), the
  source with its tier (T0 for a report, T2 for EdgeDesk's projection) and
  the "as of" time.
- **Unless both are Confirmed and no source disagrees:**
  - the full pairing range, with the win % and fair line for every realistic
    pairing;
  - the Known Limitations line **"Starter not confirmed. Numbers may change."**
  - A realistic pairing combines, for each side, the current pick, any goalie
    another source names, and the projection's alternates at 15% or more,
    with up to three per side.
- **If the starter changed after the card first posted:** "Updated: starter
  changed from X to Y", with both versions' win % (each under the pairing it
  used).
- **The headline:** before lineup lock, the block says it carries no goalie
  term. At lineup lock (§11) it shows the lock price, with the slate's price
  before lock beside it.

Without the live layer, the page shows the slate's own goalie block in the same
shape, labelled as such. A single goalie is never shown as fact unless he is
Confirmed.

## 5. The edge gate

No EDGE is flagged on a moneyline, puck line or total unless one of these
holds:
- both starters are Confirmed (with no conflict);
- the edge holds under **every** realistic pairing.

A line that some pairing has no price for cannot pass while a starter is
unconfirmed.

The gate is in three places:
- `hockey/goalies/core.js` `nhlgEdgeGate`, used by the sync's edge events;
- `lib/edgedesk_nhl_market.js`, a new `goalie_gate` gate on every label;
- `lib/edgedesk_nhl_compare.js` and the price check, which pass each side's
  probability under every pairing at its own line.

The slate's scenarios now carry each pairing's puck lines (±1.5, ±2.5) and
totals (5–7), so the gate can ask every pairing.

The edge itself is judged as before, at the production probability.

**Example.** Vancouver at +150 is an edge at the headline: EV +4.35%. It stays
gated through versions 1–3:
- with Lankinen against Wallstedt it is −1.6%;
- with Meriläinen against Wallstedt it is +1.5%.

The gate opens only at the T−30 confirmation of both starters.

## 6. Readiness (System health)

No dashboard has the name "Research Readiness Dashboard". As with the NBA and
Kalshi layers, the KPIs are in `public.nhl_goalie_readiness` and in System
health, in three rows:

- **NHL goalie sync:**
  - the state;
  - failed runs, degraded and drift in 24 h, and consecutive failures;
  - whether Daily Faceoff and the NHL boxscore read.
- **NHL starters confirmed by T-30:** the share of games in 7 days with both
  starters Confirmed by T−30. It counts observations fetched by T−25, for the
  five-minute poke grid. The target is 90%; below it is a warning once at
  least 5 games have played.
- **NHL goalie source conflicts:**
  - conflicts open on upcoming games, in 24 h and in 7 days;
  - starters inside three hours not yet Confirmed;
  - unmatched names.

A failed check, a silent scheduler or a sync that never ran is an error, and
turns the header pill red. A conflict, a drift or a source outage is a
warning.

## 7. Goalie quality: v1 is unchanged, v2 is registered EXPERIMENTAL

**How quality enters v1.** v1 uses `goalieRating`: goals saved above
expected per xG faced. It is one exponentially decayed accumulation over the
goalie's whole history (half-life 200 days), shrunk toward a replacement
level of −3% by 250 xG faced (`hockey/model/params/live.json`). Six games
into a season it is mostly prior seasons.

On 2026-10-25 Lankinen's v1 rating was −7.6% of xG faced, while this season he
was reported at −10.7 GSAx in 6 games. The spec says to leave v1 alone when its
numbers are season-long or prior-season, so v1 is unchanged.

**v2 (`NHL-GOALIE-V2` v0.1).** v2 shrinks the current-season GSAx toward the
goalie's own record over the previous three seasons, by 100 xG faced. That
three-season record is weighted 1 / 0.6 / 0.3 and shrunk toward replacement by
150 xG.

It is registered EXPERIMENTAL by `supabase/nhl_goalie_v2_registry.sql`. That
file is generated from `hockey/research/goalie_v2/registration.json` before
any backtest, and has no result row.

The promotion criteria are fixed in advance:
- **C1:** confirmation-window log loss at least 0.0005 better, with the 95%
  upper bound below 0;
- **C2:** no worse on the 2026-27 holdout of games Confirmed by T−30, from
  2026-10-26, with at least 500 games;
- **C3:** calibration;
- **C4:** a totals guard;
- **C5:** zero leakage.

v2 cannot reach a live card. `nhl_goalie_config.live_goalie_variant` stays
`xg_goalie_confirmed`, and the card table refuses any other variant. No v2
evaluator has been written yet: the registration precedes it.

## 8. Tests

| Suite | Checks |
|---|---|
| `node tools/hockey/nhl_goalie_core.test.js` | 104. Statuses, team identity, name matching, both parsers and their drift cases, the merge (agree, conflict, the lower status, projection fallback), exact re-pricing of the real MIN @ VAN scenarios, the card, change detection, the edge gate on all three markets, the cadence across the DST change, the inline copy. The lineup lock (§11): the boxscore's dressed skaters, the lock price against its formula, a call-up lowering his club's price, no lock with fewer than 12 skaters, a starter not Confirmed or a conflict, the new version and its trigger, the lock kept from the card's own lineups, and `build_slate --check` passing real lock inputs and failing tampered ones |
| `node tools/hockey/nhl_goalie_sync.test.js` | 94. The deployed function under Node with an in-memory PostgREST that enforces the triggers' rules. **The 2026-10-25 MIN @ VAN replay:** v1 at 8 AM ET names Lankinen as Projected (usage projection). Daily Faceoff's Meriläinen (Likely) writes v2 with "Updated: starter changed from K. Lankinen to L. Meriläinen" and 41.2% → 42.4%. Vancouver Confirmed writes v3, still GATED. Both Confirmed at the T−30 final pass write v4 and open the gate. The headline is 0.4174 on every version, and each edge names v1, v2, v3 and v4 in turn. Also: a conflict, outages, drift, unmatched names, dry runs and auth, and the GitHub jobs' summary and verdict (`tools/hockey/nhl_goalie_run_summary.js`) on the function's real answers, its own 401 told from the gateway's, and pg_cron's pokes refused. After v4, the timing probe at T−30 (no lineup yet), then v5 at T−10 when both lineups post: priced at lineup lock, lower than v4 for Vancouver with a regular scratched, the gate open, and the edge judged at the lock price; T−5 writes nothing new, nor does a run with the NHL API down after lock. A database read that times out once is sent again and the run completes; the same read timing out twice is a named sync error; a write that times out is never sent twice. A failed check is tried again: a forced off-slot run refused by Daily Faceoff (HTTP 403) runs again 10 minutes later and recovers, and a source that stays down is retried 10, 20, then 40 minutes apart. The job summary shows the lock price as the headline, marked "(lineup lock)". The cards table: each row's version, T−minutes, statuses, gate, headline, what priced it and when the boxscore listed its lineups (before, after or never), the counts of started games locked and listed before puck drop, and cards that cannot be read failing the job |
| `NHL_SQL_REQUIRED=1 node tools/hockey/nhl_goalie_sql.test.js` | 82. The layer on a real PostgreSQL: roles, append-only, the supersede, card versions, the confirmation and variant rules, edges attached to the version that existed, CLV, the KPIs (confirmed by T−30 with the grace, conflicts, failures, a silent scheduler), the card's freshness, the v2 registry, cron (each poke's answer kept and read back), a re-apply over live rows, and rollback, and the two queries the GitHub job reads (`tools/hockey/sql/`), and a lineup-lock version under `inputs_changed`, and the cards query the job reads (each game's current version once, the lock at lineup lock with its price before lock, nothing over a day ahead, and each game's own boxscore reads from the runs' timing probe) |
| `node tools/hockey/nhl_goalie_ui.test.js` | 46. The block's badges, sources, times, range, limitations and change note; the slate fallback; the market gate; compare with and without the live card; at lineup lock, the block's lock line, compare's lock price (full and compact) and the EV at it |
| `node tools/hockey/nhl_goalie_core.test.js` | 113. Statuses, team identity, name matching, both parsers and their drift cases, the merge (agree, conflict, the lower status, projection fallback), exact re-pricing of the real MIN @ VAN scenarios, the card, change detection, the edge gate on all three markets, the cadence across the DST change, the inline copy. The lineup lock (§11): the boxscore's dressed skaters, the lock price against its formula, a call-up lowering his club's price, no lock with fewer than 12 skaters, a starter not Confirmed or a conflict, the new version and its trigger, the lock kept from the card's own lineups, and `build_slate --check` passing real lock inputs and failing tampered ones. ESPN's parser on its real 2026-10-30 response (three games, six probable goalies, "NJ" read as NJD, Confirmed and Expected kept apart), a side with no probable, a response that is not a scoreboard, and ESPN agreeing or disagreeing with Daily Faceoff in the merge |
| `node tools/hockey/nhl_goalie_sync.test.js` | 104. The deployed function under Node with an in-memory PostgREST that enforces the triggers' rules. **The 2026-10-25 MIN @ VAN replay:** v1 at 8 AM ET names Lankinen as Projected (usage projection). Daily Faceoff's Meriläinen (Likely) writes v2 with "Updated: starter changed from K. Lankinen to L. Meriläinen" and 41.2% → 42.4%. Vancouver Confirmed writes v3, still GATED. Both Confirmed at the T−30 final pass write v4 and open the gate. The headline is 0.4174 on every version, and each edge names v1, v2, v3 and v4 in turn. Also: a conflict, outages, drift, unmatched names, dry runs and auth, and the GitHub jobs' summary and verdict (`tools/hockey/nhl_goalie_run_summary.js`) on the function's real answers, its own 401 told from the gateway's, and pg_cron's pokes refused. After v4, the timing probe at T−30 (no lineup yet), then v5 at T−10 when both lineups post: priced at lineup lock, lower than v4 for Vancouver with a regular scratched, the gate open, and the edge judged at the lock price; T−5 writes nothing new, nor does a run with the NHL API down after lock. A database read that times out once is sent again and the run completes; the same read timing out twice is a named sync error; a write that times out is never sent twice. The job summary shows the lock price as the headline, marked "(lineup lock)". The cards table: each row's version, T−minutes, statuses, gate, headline, what priced it and when the boxscore listed its lineups (before, after or never), the counts of started games locked and listed before puck drop, and cards that cannot be read failing the job. ESPN (§10): with Daily Faceoff refusing (HTTP 403), ESPN's probable goalies are observations (Vancouver Confirmed, Minnesota Expected → Likely), the run is `warn`, not `sources_down`, and both Confirmed by ESPN at T−30 open the gate; ESPN naming another goalie than Daily Faceoff is a conflict that Daily Faceoff leads; a response that changed shape is a DRIFT; `sources_down` now needs Daily Faceoff and ESPN both down (three DEGRADED with the NHL API) |
| `NHL_SQL_REQUIRED=1 node tools/hockey/nhl_goalie_sql.test.js` | 85. The layer on a real PostgreSQL: roles, append-only, the supersede, card versions, the confirmation and variant rules, edges attached to the version that existed, CLV, the KPIs (confirmed by T−30 with the grace, conflicts, failures, a silent scheduler), the card's freshness, the v2 registry, cron (each poke's answer kept and read back), a re-apply over live rows, and rollback, and the two queries the GitHub job reads (`tools/hockey/sql/`), and a lineup-lock version under `inputs_changed`, and the cards query the job reads (each game's current version once, the lock at lineup lock with its price before lock, nothing over a day ahead, and each game's own boxscore reads from the runs' timing probe), and the `espn` source: a table created before it refuses its rows until the layer is applied again, then stores them current beside Daily Faceoff's, and an unknown source is still refused |
| `node tools/hockey/nhl_goalie_ui.test.js` | 48. The block's badges, sources, times, range, limitations and change note; the slate fallback; the market gate; compare with and without the live card; at lineup lock, the block's lock line, compare's lock price (full and compact) and the EV at it; ESPN's goalie labelled as an Observed (T0) source, and named by its label when it disagrees with Daily Faceoff |
| `node tools/engine/engine_ui.e2e.js` | +24, in Chromium on desktop and a 390 px phone: the block on the slate fallback, and a live card's version, change note and range. At lineup lock: the Overview headline, the block, the Markets banner, Check a price and the list card |

The Daily Faceoff and NHL boxscore pages in the tests are **constructed** in
each source's documented shape (`tools/hockey/fixtures/nhl_goalie_sources.js`).
The build environment's network policy denied both hosts, so no live page was
captured. ESPN's scoreboard is a **real response**, captured on 2026-10-30 and
trimmed to the fields the parser reads
(`tools/hockey/fixtures/espn_nhl_scoreboard_2026-10-30.json`); the replay's ESPN
answers are constructed in its shape. The goalie inputs fixture is the real build output for the
2026-10-25 slate.

## 9. Deploy

1. Merge. Let **NHL engine build** run once on main so that
   `hockey/goalie_inputs.json` is published.
2. Run **Deploy NHL goalie layer** (`.github/workflows/deploy-nhl-goalie.yml`)
   with `deploy_function` and `apply_sql`, leaving `set_cron_secret` and
   `first_run` on. In order, it:
   - runs the suites;
   - deploys the function;
   - applies the layer and the registry;
   - makes the function's `NHL_GOALIE_CRON_SECRET` and Vault
     `nhl_goalie_cron_secret` exist and agree. When Vault has none, a new
     secret is generated on the runner, masked and never printed. A dry,
     forced run proves the function accepts it;
   - schedules the five-minute poke;
   - once the site serves the inputs, runs the sync once, forced. The cards it
     wrote and the readiness KPIs go to the job summary.

   **Never set one side of the cron secret by hand.** pg_cron sends Vault's
   value, so a new `NHL_GOALIE_CRON_SECRET` set on the function alone refuses
   every poke. To change it, delete the Vault secret and run the deploy with
   `set_cron_secret`. With both present, the deploy gives the function Vault's
   value and proves it. The SQL can still be pasted by hand, in order:
   `nhl_goalie_layer.sql`, `nhl_goalie_v2_registry.sql` and
   `nhl_goalie_cron.sql`.
3. Verify at any time:
   - `GET` the function: it returns the build;
   - `POST {"dry":true,"force":true}` with the secret: it reads both sources
     and returns the cards without writing;
   - `POST {"simulate_outage":["daily_faceoff","nhl_api"],"force":true}`:
     System health shows a failure.
4. **NHL goalie sync** (`.github/workflows/nhl-goalie-sync.yml`) is the sync's
   GitHub job, beside the other syncs:
   - **Run workflow** calls the sync now (forced by default; `dry` writes
     nothing; `simulate_outage` treats one source as down);
   - **on a schedule**, every half hour from 8 AM ET to about midnight ET
     (September to June), it is the watchdog. It reads pg_cron's last call
     and what the function answered its last three pokes
     (`tools/hockey/sql/nhl_goalie_cron_check.sql`). Each poke's pg_net request
     id is kept in `public.nhl_goalie_pokes`, and its answer in pg_net's
     `net._http_response`. While pg_cron is calling,
     it leaves the sync alone, since two callers in one minute would race each
     other's writes. When pg_cron has not called for 15 minutes, the job calls
     the sync itself, unforced so the function still decides what is due, and
     fails so the miss is seen;
   - either way, the job summary shows what the run wrote (each card version,
     its starters, statuses, gate, the pairing's home win %, its change note, and
     the headline's home win %, marked "(lineup lock)" once locked), pg_cron's last
     call and the readiness KPIs (`tools/hockey/sql/nhl_goalie_readiness_check.sql`,
     the view plus the last check's alert codes);
   - **the cards** (`tools/hockey/sql/nhl_goalie_cards_check.sql`): every game's
     current version, from 6 hours ago to 24 hours ahead, whoever wrote it. Each
     row has the puck drop, the version and when it was written (T−minutes), both
     statuses, the gate, the headline's home win %, and what priced it: "lineup
     lock" with the skaters listed and the slate's price before lock, or "slate"
     with its model. The last column is the timing probe (§11): when the NHL
     boxscore first listed both dressed lineups ("listed T−22 min"; after puck
     drop, "T+4"), or what the last read before puck drop saw ("not listed by
     T−3 (PRE, 0 / 0 skaters, 2 starters flagged; 7 reads)"). Above the table is
     a count of the started games, how many were priced at lineup lock before
     puck drop, and for how many the boxscore listed both lineups before puck
     drop. So the watchdog shows,
     every half hour, whether pg_cron's runs locked each game; a card a run did
     not change appears there too. Cards that cannot be read fail the job.

   `tools/hockey/nhl_goalie_run_summary.js` writes the summary and gives the
   verdict, for this job and for the deploy's first run. **The job fails for
   anything EdgeDesk runs:**
   - the sync refusing the cron secret, or erroring. The summary prints what
     the answer said, and tells the function's own 401 from the Supabase
     gateway's (a function deployed without `--no-verify-jwt`);
   - pg_cron not calling, or missing, or its pokes answered with anything but
     200 or 500 (a refused secret is a 401);
   - the slate's inputs unreadable;
   - a parser that no longer reads a source's page (DRIFT);
   - readiness in error for any of those.

   **It only warns when an outside source does not answer:** `sources_down`,
   Daily Faceoff refused and the NHL API down or not yet in its window. The
   function still records that run as an error, the cards keep the starters on
   file and stay gated, and System health shows it. It needs the deploy's
   secrets, `SUPABASE_PROJECT_REF` and `SB_DB_URL`. Like every workflow, it
   appears under Actions, and its schedule runs, once it is on main.

Rollback: `supabase/nhl_goalie_layer_rollback.sql`.

**The first deploy (2026-10-26, from `claude/nhl-goalie-starter-sync-rp0xvl`).**
The function, the layer, the registry, the cron secret and the five-minute poke
are live. The first forced run (00:35 UTC) answered 200 with status `warn`. It
wrote 8 observations, 8 consensus rows and version 1 of the four cards inside
the horizon: MIN @ VAN, LAK @ NYR, TOR @ CGY and DET @ EDM. All four are
Projected / Projected and GATED, with MIN @ VAN at 41.2% for Vancouver. The NHL
API read. **Daily Faceoff answered HTTP 403** for both dates (§10).

**The secret mismatch (2026-10-26, 00:36–02:06 UTC).** After that first run,
the function's `NHL_GOALIE_CRON_SECRET` stopped matching Vault's. No workflow
changed it, so it was most likely set by hand, as an older version of the ops
note told people to. Every pg_cron poke for about 85 minutes was refused
(401), while pg_cron's own record showed each call as succeeded. The first run
by hand of NHL goalie sync (02:00) failed on the 401. Deploy NHL goalie layer
with `set_cron_secret` (run 2) found the two disagreeing and gave the function
Vault's value. Its forced run answered 200, status `ok`, and Daily Faceoff
read. The watchdog now reads what the function answered each poke, so the next
mismatch fails within half an hour, not after a 90-minute silence.

## 10. Limits

- **A slow database answer.** On 2026-10-30 at 12:10 UTC one database request
  ran past its 20-second deadline ("Signal timed out."). The function failed the
  whole run as `sync_error`, and readiness kept that error until the next due
  slot (14:00 UTC), so NHL goalie sync failed in between. A forced run at 13:23
  restored readiness. Since build `nhl_goalie_sync@2026-10-30.1`, a read that
  times out or loses its connection is sent once more. A write is never sent
  twice: it may have landed, and every table is append-only. A write that times
  out still fails the run, and readiness says so until a run succeeds; a forced
  run of NHL goalie sync records one at once.
- **Daily Faceoff refuses the function at times (HTTP 403).** On the first
  deployed runs (2026-10-26, 00:31 and 00:35 UTC) Daily Faceoff refused the
  request from Supabase's network for both dates, with a browser's headers.
  At 02:06 it answered, and its parser read the live page (six observations,
  no drift). The refusal comes and goes on Daily Faceoff's side. While it
  lasts:
  - starters stay Projected, from the usage projection or the manual file
    (`hockey/data/confirmed_starters.json`), until the NHL boxscore names
    them near puck drop;
  - cards stay GATED unless an edge holds under every pairing;
  - "Confirmed by T−30" reads low;
  - every run more than three hours out is a `sources_down` error, because
    Daily Faceoff is its only source; System health shows it, and NHL goalie
    sync warns.

  On 2026-10-30 at 16:34 UTC both pages answered 403 again, with Cloudflare's
  "Attention Required!" page, 34 minutes after a run that read them. Since
  build `nhl_goalie_sync@2026-10-30.2` each page is tried at most twice more
  in the same run: after a refusal (403), a rate limit (429, its Retry-After
  honored up to 8 seconds), a server error (5xx), a timeout or a lost
  connection. The waits are about 2 and then 4 seconds, plus up to a second
  of jitter. All the retries of one run share a 45-second budget. A 404 is
  not retried, and neither is a page that changed shape (DRIFT). An empty
  200, or a Cloudflare challenge served as 200, is never parsed into
  starters. Cloudflare's block page (its title, or a `cf-mitigated` header)
  is named "blocked by Cloudflare bot protection (HTTP 403)" in the alert,
  and the run row keeps each page's attempts. Nothing carries over: the next
  run tries afresh.

  The NHL API parser read live boxscores on the first run. Routing requests
  around the refusal is not a fix. A licensed starter feed is (see Daily
  Faceoff's terms below), or manual entries until then.

  **Since build `nhl_goalie_sync@2026-10-30.3`, ESPN is a second source.** On
  2026-10-30 Daily Faceoff refused the function from 16:34 UTC (the 16:00 run
  had read it), so every run more than three hours out was a `sources_down`
  error and tonight's starters could only be confirmed by hand. ESPN's public
  NHL scoreboard answered a plain request with each team's probable goalie and
  ESPN's status word. On that day it named all six starters (two Confirmed,
  four Expected), and every name matched a rated goalie. The sync now reads it
  on the same cadence, for each Eastern date, from the function's own network;
  nothing is routed around anyone.
  - Its "Confirmed" is Confirmed, its "Expected" is Likely, exactly as Daily
    Faceoff's words are read. A goalie only Expected never opens the gate or
    the lineup lock.
  - It is a source of its own (`espn` in `nhl_goalie_starters`; the layer's
    source check names it, so `supabase/nhl_goalie_layer.sql` must be applied
    before the function is deployed, or every insert with an ESPN row is
    refused).
  - When it names another goalie than Daily Faceoff, that is a conflict, and
    Daily Faceoff leads, at Likely at most.
  - `sources_down` now means Daily Faceoff and ESPN were both unreadable (and
    the NHL API too, inside three hours). ESPN down alone is DEGRADED; a
    response that changed shape is a DRIFT, which fails NHL goalie sync like
    Daily Faceoff's.
- **Daily Faceoff's and ESPN's terms.** Daily Faceoff is a third-party
  aggregator with its own terms, and ESPN's scoreboard is a public but
  unlicensed response (like the ESPN NHL pack). The owner should review both,
  or license a starter feed, before NHL output is sold in a paid tier
  (`hockey/sources/registry.js`).
- **The NHL boxscore confirms late.** It usually names starters only near
  puck drop. For most games the confirmation before T−30 comes from Daily
  Faceoff or ESPN (above).
- **Edge events wait for NHL prices.** They need captured NHL prices
  (`NHL_PRICES`), which are off. Until then the gate shapes the price check
  and the market labels, and the event table stays empty. The CLV grade table
  has no writer yet.
- **The static slate does not read the sync.** The slate's own goalie block
  (and the board and graphic built from it) still uses the usage projection
  and the manual file between builds. The engine page's live block replaces
  it when the layer answers. So do the lineup-lock prices (§11): Today's Games
  and the graphic show the slate's price.

## 11. Lineup lock: the headline at the dressed lineups (2026-10-29, methodology change)

**What changes.** Until now the headline was `edgedesk_nhl_v1:xg_core` until
puck drop. It has no goalie term and no lineup term, so a starter or a scratch
moved the pairing numbers and the gate, never the headline. Now a card's
headline is priced by `edgedesk_nhl_v1:xg_all_confirmed` once all of these
hold:
- the NHL lists both dressed lineups;
- both starters are Confirmed;
- no source disagrees on a starter.

`xg_all_confirmed` is the xG core plus the confirmed goalie and both clubs'
confirmed lineup value. The card gets a new version (reason `lineup_locked`,
under the table's existing `inputs_changed` trigger). From then on these read
that price:
- the engine page;
- EdgeDesk vs the market;
- Check a price;
- the sync's edge events.

**Where the lineups come from.** In the last three hours the sync already
reads the NHL boxscore (`api-web.nhle.com/v1/gamecenter/{id}/boxscore`) for
the starters. Once lineups post, the same answer lists each side's dressed
forwards and defence (`playerByGameStats`). `nhlgParseNhlBoxscore` now keeps
those player ids, goalies excluded. A side with fewer than 12 skaters listed
has no lineup yet. There is no new source and no new request.

**The price** (`hockey/goalies/core.js` `nhlgLockPrice`):

    λ_home = exp(η_home + β_goalie × r_away goalie + β_own × Δ_home + β_opp × Δ_away)
    λ_away = exp(η_away + β_goalie × r_home goalie + β_own × Δ_away + β_opp × Δ_home)

Both are then pair-calibrated with `xg_all_confirmed`'s own calibration
(a 0.525, b 1.125, c 6.0154) and priced with the same distribution as every
other number.
- **Δ** is ln(lineup value / typical), from `hockey/model/lineups.js`:
  - a skater's value is his recent time on ice a game, shrunk toward a
    10-minute prior worth 3 games (a call-up with no history is the prior);
  - a lineup's value is the sum over its dressed skaters;
  - typical is the club's mean over its last 10 lineups, each re-valued
    today.
- **β:** goalie −0.694668, own lineup 0.870723, opponent's lineup −0.368072.
- The slate build writes these to `hockey/goalie_inputs.json`: η (the
  variant's linear predictor without those three terms), each club's typical
  value and last lineup, every skater's value, and the betas. The function
  fits nothing.

**The check.** `node hockey/build_slate.js --check` re-prices every game at
lock from the inputs, with each club's last dressed lineup and the likeliest
starters. It fails unless the result matches the slate's own GLM path within
0.00015. So the function's arithmetic and the build's cannot drift apart. All
33 games on the 2026-10-29 slate pass. A club with fewer than 3 lineups on
file has no typical value and never locks.

**When.** After the T−30 final pass the sync checks every 5 minutes until
puck drop (T−25, −20, −15, −10, −5). A lock that holds is not a new version.
A new listing (a late scratch) re-prices it as a new version.

**A failed read never unlocks.** The card is the only place the dressed
lineups are kept (`headline.lineup.ids`). A run whose boxscore read fails, or
lists no lineup, prices from the current card's lineups
(`nhlgLockedLineups`), so the lock holds. Only a goalie-source conflict, or a
starter no longer Confirmed, takes it off.

**The timing probe.** Every boxscore read records these in the run's
`sources` (`nhl.games`):
- the minutes to the start;
- the game state;
- the skaters listed for each side;
- whether the starters were flagged.

No live boxscore could be read from the build environment (§8), so when
lineups post relative to the T−30 pass has not been measured yet. The probe
measures it from the first deployed night. The walk-forward assumed about
30 minutes before puck drop.

**Evidence** (`hockey/validation/nhl_walkforward.json`, moneyline log loss,
lower is better):

| Window | Games | `xg_core` (production) | `xg_all_confirmed` (at lock) | Δ |
|---|---|---|---|---|
| Selection, 2014–2020 | 9,205 | 0.67459 | 0.67429 | −0.00030 |
| Confirmation, 2021–2026 | 7,945 | 0.66286 | 0.66167 | −0.00119 |
| Live, 2026-27 | 198 | 0.66309 | 0.66317 | +0.00008 |

- On confirmation, against the goalie-only variant it would replace:
  −0.00088 (95% −0.00167 to −0.00004).
- Rule 1 of the lab (`docs/engine/NHL_LAB.md` §1) needs a challenger to beat
  production by 0.001 on selection. At −0.00030 this fails it.
- The lab also kept it out of production because its inputs exist only at
  warmups ("not available pregame"). This change uses it only then.
- On 198 live games it is level with production. That is within the noise of
  198 games.

**The decision.** Pricing the headline with it at lock, despite rule 1, is
the owner's decision (2026-10-29), recorded here.

**Before and after on the committed slate** (the 2026-10-29 build, 33 games;
each club's last dressed lineup and the likeliest starters stand in for
tonight's):
- the lock moves the home win probability by 1.7 pp on average (median 1.2);
- the largest move is OTT @ LAK: Los Angeles 47.6% → 42.5%;
- it does not pull favourites away from even. The mean distance from 50% is
  8.34 pp before and 8.46 pp after. The favourite compression measured on
  2026-10-29 is the split factor's problem (`NHL_LAB.md` §6.3), and this
  change does not fix it.

**What does not change.**
- The slate, its ledger and the public record: the ledger still freezes the
  slate's `xg_core` price before puck drop, and the record grades that. The
  lock price lives on the card version, which is append-only, and an edge
  event at lock attaches to that version.
- The gate: a lock needs both starters Confirmed, so the gate is already
  open.
- Before lock, everything is as in §§2–5.

**Where it shows** (`lib/edgedesk_nhl_compare.js` rule 7):
- the engine page Overview's big number and total;
- the Starting goalies block: "Priced at lineup lock", with the slate's price
  before lock, and no second goalie-only number;
- EdgeDesk vs the market and the board row, each with an "at lineup lock"
  chip;
- the game's list card;
- Markets: a banner. Its tables stay the slate's;
- Check a price: the moneyline, puck lines and totals. Team totals stay the
  slate's.

**Limits.**
- Today's Games, the matchup graphic and the slate's other readers do not
  read live cards. They show the slate's price.
- The board loads live cards only for games that start within an hour.
- A goalie-source conflict blocks the lock even with both lineups in.
- The lock needs a `goalie_inputs.json` built with this change. Until NHL
  engine build runs on main, the function finds no lineup block and behaves
  as before.
- A skater's value is his ice time only. It knows nothing about his quality
  beyond his minutes.

**Deploy.** Merge, then run NHL engine build once, so the inputs carry the
lineup block. Then run Deploy NHL goalie layer with `deploy_function`. The
SQL is unchanged: the card's trigger values and columns are the same. A `GET`
of the function answers build `nhl_goalie_sync@2026-10-29.1` or later once
the lock is deployed. In the job summaries of NHL goalie sync and of the
deploy's first run, a card the run wrote shows its headline, marked "(lineup
lock)" once locked. NHL goalie sync also lists every game's current card,
whoever wrote it, with what priced its headline (§9), so whether a game locked
before puck drop can be read from GitHub.

**The first deploy (2026-10-29, run 4 of Deploy NHL goalie layer).** It
deployed `main` at 0e148dc6d, after NHL engine build had published the
lineup block (all 33 games). That build still answered
`nhl_goalie_sync@2026-10-25.1`: #902 did not bump the stamp. The first forced
run read the site's previous inputs (slate 15:32 UTC) because the site had
not yet published the new file, so no card could lock on it. Later pokes read
the new file once it is published.
