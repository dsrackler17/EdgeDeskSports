# NHL starting goalies — an Observed input, and a card that changes with it

> Starters are an Observed (T0) input with a status and a source. The sync
> refreshes them close to puck drop. A game's card gets a new version when a
> starter, a status or a conflict changes.
>
> This is a data-correctness fix. The goalie effect weights, the xG core and
> the way edges are ranked are unchanged.

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
    Daily Faceoff);
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

A missed slot is chased for up to 90 minutes. A declined poke is written as a
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
- **The headline:** the block says it carries no goalie term.

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
| `node tools/hockey/nhl_goalie_core.test.js` | 83. Statuses, team identity, name matching, both parsers and their drift cases, the merge (agree, conflict, the lower status, projection fallback), exact re-pricing of the real MIN @ VAN scenarios, the card, change detection, the edge gate on all three markets, the cadence across the DST change, the inline copy |
| `node tools/hockey/nhl_goalie_sync.test.js` | 61. The deployed function under Node with an in-memory PostgREST that enforces the triggers' rules. **The 2026-10-25 MIN @ VAN replay:** v1 at 8 AM ET names Lankinen as Projected (usage projection). Daily Faceoff's Meriläinen (Likely) writes v2 with "Updated: starter changed from K. Lankinen to L. Meriläinen" and 41.2% → 42.4%. Vancouver Confirmed writes v3, still GATED. Both Confirmed at the T−30 final pass write v4 and open the gate. The headline is 0.4174 on every version, and each edge names v1, v2, v3 and v4 in turn. Also: a conflict, outages, drift, unmatched names, dry runs and auth, and the GitHub jobs' summary and verdict (`tools/hockey/nhl_goalie_run_summary.js`) on the function's real answers |
| `NHL_SQL_REQUIRED=1 node tools/hockey/nhl_goalie_sql.test.js` | 71. The layer on a real PostgreSQL: roles, append-only, the supersede, card versions, the confirmation and variant rules, edges attached to the version that existed, CLV, the KPIs (confirmed by T−30 with the grace, conflicts, failures, a silent scheduler), the card's freshness, the v2 registry, cron and rollback, and the two queries the GitHub job reads (`tools/hockey/sql/`) |
| `node tools/hockey/nhl_goalie_ui.test.js` | 32. The block's badges, sources, times, range, limitations and change note; the slate fallback; the market gate; compare with and without the live card |
| `node tools/engine/engine_ui.e2e.js` | +12, in Chromium on desktop and a 390 px phone: the block on the slate fallback, and a live card's version, change note and range |

The Daily Faceoff and NHL boxscore pages in the tests are **constructed** in
each source's documented shape (`tools/hockey/fixtures/nhl_goalie_sources.js`).
The build environment's network policy denies both hosts, so no live page was
captured. The goalie inputs fixture is the real build output for the
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

   By hand instead: `supabase secrets set NHL_GOALIE_CRON_SECRET=<value>` and
   `select vault.create_secret('<value>', 'nhl_goalie_cron_secret');`, then
   paste, in order, `nhl_goalie_layer.sql`, `nhl_goalie_v2_registry.sql` and
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
     (`tools/hockey/sql/nhl_goalie_cron_check.sql`). While pg_cron is calling,
     it leaves the sync alone, since two callers in one minute would race each
     other's writes. When pg_cron has not called for 15 minutes, the job calls
     the sync itself, unforced so the function still decides what is due, and
     fails so the miss is seen;
   - either way, the job summary shows what the run wrote (each card version,
     its starters, statuses, gate, home win % and change note), pg_cron's last
     call and the readiness KPIs (`tools/hockey/sql/nhl_goalie_readiness_check.sql`,
     the view plus the last check's alert codes).

   `tools/hockey/nhl_goalie_run_summary.js` writes the summary and gives the
   verdict, for this job and for the deploy's first run. **The job fails for
   anything EdgeDesk runs:**
   - the sync refusing the cron secret, or erroring;
   - pg_cron not calling, or missing;
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

## 10. Limits

- **Daily Faceoff refuses the function (HTTP 403).** On the first deployed
  run (2026-10-26) Daily Faceoff refused the request from Supabase's network
  for both dates, with a browser's headers. The block is on Daily Faceoff's
  side, so its parser has still not read a live page. Until a starter source
  answers:
  - starters stay Projected, from the usage projection or the manual file
    (`hockey/data/confirmed_starters.json`), until the NHL boxscore names
    them near puck drop;
  - cards stay GATED unless an edge holds under every pairing;
  - "Confirmed by T−30" reads low;
  - every run more than three hours out is a `sources_down` error, because
    Daily Faceoff is its only source; System health shows it, and NHL goalie
    sync warns.

  The NHL API parser read live boxscores on that run. Routing requests around
  the block is not a fix: a licensed starter feed is (see Daily Faceoff's
  terms below), or manual entries until then.
- **Daily Faceoff's terms.** Daily Faceoff is a third-party aggregator with
  its own terms. The owner should review them, or license a starter feed,
  before NHL output is sold in a paid tier (`hockey/sources/registry.js`).
- **The NHL boxscore confirms late.** It usually names starters only near
  puck drop. For most games the confirmation before T−30 was meant to come
  from Daily Faceoff, which is refusing the function for now (above).
- **Edge events wait for NHL prices.** They need captured NHL prices
  (`NHL_PRICES`), which are off. Until then the gate shapes the price check
  and the market labels, and the event table stays empty. The CLV grade table
  has no writer yet.
- **The static slate does not read the sync.** The slate's own goalie block
  (and the board and graphic built from it) still uses the usage projection
  and the manual file between builds. The engine page's live block replaces
  it when the layer answers.
