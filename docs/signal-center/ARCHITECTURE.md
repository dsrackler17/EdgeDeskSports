# Signal Center — architecture

## 1. What it was built on (the inventory)

Signal Center adds no data source. It reads what EdgeDesk already records and
compares records that answer the same question.

| Source | What it holds | Used for |
| --- | --- | --- |
| `football/game_research/history/<season>.jsonl` | Append-only NFL and CFB game-research snapshots: win probability, fair spread and total, model version, inputs (records, ranks, kickoff, venue, availability, model run time) | Forecast shifts, their input changes, the rarity reference |
| `football/game_research/current.json` | The current research per game, with the QB context | Model identity, availability context |
| `performance/ledger/forecasts/<sport>-2026.jsonl` | Hash-chained pregame forecasts (NBA, NHL, WNBA, NFL, CFB…). Rows imported from earlier records carry `recorded_at` (from the record's git history) instead of `captured_at` | Forecast shifts outside football research. For NFL and CFB, the stretch before research covered a game (from 2026-09-11), as its own series. The model side of divergences |
| `performance/ledger/quotes/<sport>-2026.jsonl` | ESPN-relayed DraftKings two-way prices with `captured_at` | NBA and NHL divergence, convergence, line movement |
| `record/football/quotes/<sport>_2026.jsonl` | Every DraftKings reading EdgeDesk captured through ESPN since 2026-10-03, with the teams as ESPN printed them | NFL and CFB divergence (replayed point in time), convergence, line movement |
| `performance/data/summary.json` | Live grading: Brier, log loss, calibration bands with Wilson intervals, market comparison | Model DNA, reliability warnings |
| `engine/registry.json` | Out-of-sample backtest readiness per model and market | Model DNA backtest rows |
| `football/availability/reports/*.json` | Dated CFB availability reports (`published_at`) | Availability changes (CFB, QB only) |
| `today/slate.json` | Team names per slate | Orienting a quote's teams before any comparison |
| `public.sim_published`, `sim_runs`, `sim_team_results` | Published Simulator runs with Monte Carlo standard errors | Simulator shifts (re-checked by the server at ingest) |
| `public.nba_injury_report_snapshots` | Official NBA injury report snapshots | NBA availability changes (shadow) |
| `public.kalshi_card_current` | Kalshi mids | Consensus references (read-only) |
| `public.user_alerts` | The existing research-alerts bell | Notices |

The existing `public.signals` and `public.signal_ticks` tables are the odds
capture. Signal Center's tables use the `sc_` prefix so nothing collides.

## 2. The flow

```
committed sources ──┐
                    ├─ tools/signal_center/sources.js ─ evaluate.js ─ lib/edgedesk_signal_engine.js ─┐
database (service) ─┘          (read)                    (two-pass rarity)   (detect, verify, score) │
                                                                                                    ▼
                         tools/signal_center/run.js ── job doors (sc_begin_run … sc_finish_run) ── PostgreSQL
                                   │                                                                │
                     render_graphics.js (Chromium) ─ lib/edgedesk_signal_graphic.js                  │
                                                                                                    ▼
              readers ── reader doors (sc_status, sc_pulse, sc_public_feed, sc_feed, sc_signal …) ──┘
              operators ── operator doors (sc_admin_*), checked against billing_is_admin()
```

1. **Read.** `sources.js` loads the committed files and orients every quote
   by team name before anything is compared. `db.js` reads only the tables
   above, through the service role, with retries and a request budget of 400.
2. **Detect.** `evaluate.js` runs the engine twice. The first pass builds each
   league's reference distribution of comparable changes. The second scores each
   candidate against changes recorded *before* it (point in time). Past
   model–market boards are rebuilt at each capture pass from the records stamped
   by then (`replayMarket`). A change found more than 180 minutes after its record
   is scored as of that record and marked backfilled (METHODOLOGY.md §3).
3. **Verify.** Every payload carries its checks. A failed check makes it
   UNVERIFIED, and an unverified signal never reaches a reader. The server
   re-checks simulator signals against `sim_team_results` at ingest.
4. **Store.** `sc_ingest` upserts by `signal_key`. It writes a new version only
   for a new `version_hash`, takes a per-key advisory lock, and supersedes or
   expires signals. Versions and events are append-only.
5. **Draw.** `sc_graphics_due` lists what needs a graphic. `render_graphics.js` draws each in Chromium and
   re-measures it with real font metrics. `sc_put_graphics` stores the content, which is immutable.
6. **Tell.** `sc_notify` writes `public.user_alerts` rows for entitled readers who asked. Rows are deduplicated,
   cooled down per subject and capped per reader.
7. **Read back.** The terminal, `/signals/` and `/admin/signals/` reach the data only through the doors.

## 3. Files

| File | Role |
| --- | --- |
| `lib/edgedesk_signal_engine.js` | Detection, comparability, the evidence ladder, verification, the importance score, identity (`signal_key`) and versioning (`version_hash`), copy rule. UMD, ES5. |
| `lib/edgedesk_model_dna.js` | Model DNA records from the audit, the live grading and the serving model |
| `lib/edgedesk_signal_registry.js` | Per-sport capabilities and which signals each sport may produce, with sources and blockers. It reads the Simulator's own registry. |
| `lib/edgedesk_signal_graphic.js` | The six graphic templates on the matchup renderer (`lib/edgedesk_game_graphic.js` layouts) |
| `lib/edgedesk_signal_center.js` + `.css` | The terminal seat: renderers (pure, tested in Node) and the browser shell |
| `signals/index.html` | The public preview |
| `admin/signals/index.html` | The operator console |
| `tools/signal_center/run.js`, `sources.js`, `evaluate.js`, `db.js`, `render_graphics.js` | The worker |
| `supabase/signal_center.sql` (= `supabase/migrations/20261024120000_signal_center.sql`) | The database |
| `supabase/signal_center_rollback.sql` | Removal |
| `.github/workflows/signal-center-tests.yml`, `signal-center.yml`, `deploy-signal-center.yml` | CI, the hourly run (off until switched on), the manual deploy |

## 4. The database

Every table is row-level secured with no client policy. SELECT is revoked from
`anon` and `authenticated` on every table except a reader's own `sc_preferences`
row. Table DML is revoked from `service_role` too, so every write goes through
a door and every invariant lives in one place.

| Table | Holds |
| --- | --- |
| `sc_config` / `sc_config_log` | mode (`shadow`/`live`), live sports, free-tier limits, notice and graphic rules; every change logged |
| `sc_runs` | one row per evaluation (a lease: one at a time) |
| `sc_signals` | one row per signal identity: current version, lifecycle, publication, and the columns the feed filters and sorts on. `signal_at` (the moment it describes) and `backfilled` are fixed at the first version |
| `sc_signal_versions` | **append-only** full payloads with SHA-256 |
| `sc_signal_events` | **append-only** audit trail (detected, versioned, published, held, withdrawn, superseded, expired, invalidated, graphic and notice events, server checks) |
| `sc_graphics` | render content per (version, template, template version, format). Content is immutable; only status (READY/FAILED/OUTDATED/WITHDRAWN) and operator approval (NONE/APPROVED/REVOKED) move. Outdating a graphic revokes its approval. |
| `sc_model_dna` | **append-only** Model DNA snapshots |
| `sc_preferences` | a reader's sports, teams, categories, level, notices on/off |
| `sc_notification_log` | who was told about what (dedupe, cooldown, per-reader caps; `held` rows are never retried) |
| `sc_failures` | dead letters |

**Doors.**

| Who | Doors |
| --- | --- |
| anyone (`anon`, `authenticated`) | `sc_status()`, `sc_pulse(hours)` (counts only), `sc_public_feed(limit)` (number-free headlines, at most `free.feed_limit`, plus example graphics of events that passed ≥ 72 h ago) |
| a signed-in account | `sc_feed(filters, cursor, limit)`, `sc_signal(id)`, `sc_signal_version(id, version)`, `sc_model_dna_current(sport)`, `sc_my_preferences()`, `sc_save_preferences(p)`, `sc_unread_count()`. Each decides inside: Full Access (`sc_viewer_entitled()` → `community_is_entitled`, fail closed) gets the numbers; anyone else gets the preview or "locked". |
| operators | `sc_admin_queue`, `sc_admin_act` (publish, hold, withdraw, preview pin, regenerate), `sc_admin_graphic` (approve/revoke external, withdraw), `sc_admin_set_mode`, `sc_admin_runs`, `sc_admin_failures`, `sc_admin_resolve_failure`. Each calls `sc_require_admin()` → `billing_is_admin()`. |
| the database owner (connection string; no API role) | `sc_owner_set_mode(mode, sports, reason)`: the same switch as `sc_admin_set_mode`, for *Signal Center mode* (`.github/workflows/signal-center-mode.yml`) and the SQL editor. Going live publishes the eligible shadow signals (`sc_promote_shadow`). |
| the job (`service_role` only) | `sc_begin_run`, `sc_current`, `sc_prior_divergences`, `sc_active`, `sc_graphics_due`, `sc_ingest`, `sc_publish_pending`, `sc_put_graphics`, `sc_put_dna`, `sc_fail`, `sc_expire`, `sc_notify`, `sc_finish_run` |

The feed is keyset-paged. The cursor is base64 `{sort, v, id}`, and a cursor from
another sort is refused. Sorts: recent (by `signal_at`), largest shift, largest
disagreement, evidence quality, rarity, score. Scopes: `active` (the door's
default), `timeline` (the latest per subject, current and past; the terminal's
default), `history` and `all`. At 5,000 signals the first page, a filtered page
and the 7-day pulse each answer in about 30–55 ms, including the psql round trip
(`tools/signal_center/sql.test.js`). The recent sort uses `sc_signals_time_idx`.

**Publication rule.** A signal is published only when the run began in
`live` mode, its sport is in `live_sports`, it is VERIFIED and not a fixture, it is
not withdrawn, and its label is at least `publish.min_label` (Routine). History is
published as history: expired, or superseded by a newer record. A convergence is
recorded once per disagreement (`sc_prior_divergences` leaves out a disagreement whose
closing is on record). A live run also
publishes, by the same rule, what was stored while in shadow (`sc_publish_pending`).
An operator's hold or withdrawal sticks across later versions. Notices go only to
fresh, active signals that were not found later.

## 5. Per-sport capabilities

Generated from `lib/edgedesk_signal_registry.js`. A sport supports a signal
because a dated source exists, not because it is in a menu. **Operational**:
sourced and tested. **Experimental**: sourced, but the model or the source is
not yet proven enough to lead with. Only NFL and college football are live
candidates: the Rollout column is the review plan. What production publishes is
`sc_config.live_sports` (every sport since 2026-10-24, the owner's switch), and
the terminal's Coverage view shows that column from the database.

| Sport | Rollout | forecast shift | market divergence | line movement | simulation shift | injury impact | reliability warning | data quality | convergence |
|---|---|---|---|---|---|---|---|---|---|
| NFL | live candidate | operational | operational | operational | experimental | experimental (QB, dated by EdgeDesk) | operational | operational | operational |
| College football | live candidate | operational | experimental | operational | experimental | operational (QB) | operational | operational | experimental |
| NBA | shadow | operational | experimental | experimental | experimental | experimental | operational | operational | experimental |
| NHL | shadow | operational | experimental | experimental | experimental | **blocked** | operational | operational | experimental |
| MLB | shadow | — | — | — | experimental | — | — | operational | — |
| WNBA | shadow | operational | — | — | experimental | — | operational | — | — |
| Men's college basketball | shadow | coming soon | — | — | **blocked** | — | — | operational | — |
| UFC | shadow | coming soon | — | — | experimental | — | — | operational | — |
| College baseball | shadow | coming soon | — | — | — | — | — | operational | — |
| Women's college basketball | shadow | — | — | — | — | — | — | — | — |
| Tennis | shadow | — | — | — | experimental | — | — | — | — |
| Golf | shadow | — | — | — | experimental | — | — | — | — |

Blockers worth knowing:

- **NFL injuries are dated by EdgeDesk, not the league.** nflverse's copy of the official report carries no per-row
  publication time. The injury sync (every six hours) appends each game designation new or changed since its last
  row for that player-week to `football/injuries/history/nfl_<season>.jsonl`, stamped with its own retrieval time.
  Signal Center reads quarterbacks from it, prints the time as "first seen by EdgeDesk" (never "published"), flags
  `PUBLICATION_TIME_UNKNOWN`, and keeps the category experimental. The first run's rows are a baseline (already
  listed when the ledger began) and are never news. A designation that disappears is not recorded.
- **Simulator changes follow the Simulator's own registry** (`lib/edgedesk_simulator_sports.js`) and never override
  it. They also need outcome definitions in the engine (`E.SIM_OUTCOMES`: NFL, college football, NHL, NBA, MLB,
  WNBA, golf, tennis, UFC). For golf a run is one tournament (win, top 5/10/20, the cut until it is made); for tennis
  one draw (title, final, semifinal, quarterfinal); for UFC the title path within the Simulator's horizon
  (Estimated: matchmaking is modelled). An outcome whose meaning changes between runs is never compared: tennis's
  "win the next match" and UFC's next-bout outcomes name a different match once one is played. Golfers, players and
  fighters are people, so their signals are about a player and their graphics use initials in neutral colours.
  Men's college basketball's Simulator module is blocked by the Simulator itself (the 2027 tournament format is
  not verified).
- **Men's college basketball forecast shifts** read the published daily runs (`ncaam_fc_runs` with status
  `completed`, the runs that took the published pointer, and their `ncaam_fc_forecasts`), D-I against D-I, for games
  not yet started. A run that lost the race (`superseded`) was never shown and is never read. A game rated in between
  two runs is the shift's source-dated support; availability is not modelled, and every signal carries the
  forecast's data-quality flags. **Held at coming soon:** the forecast tables (`supabase/ncaam_forecast.sql`) are not
  deployed in production (2026-10-24: "table not found"), and the daily job publishes only with `NCAAM_FC_PUBLISH`
  on. Deploying them (Actions → Deploy NCAAM forecast SQL) and switching the publication on are the owner's
  decisions; the registry entry then becomes operational.
- **MLB has no forecast history to compare.**
- **Not supported anywhere yet:** roster movement (no source-dated transaction feed), model disagreement (no
  independent models published side by side), historical anomaly (the ledgers start in 2026). The Coverage view
  states each reason.

## 6. The terminal integration

- A seventh seat, **Signals** (`aria-label="Signal Center"`), first in the primary navigation. It is recorded as
  `primary_nav_signals`, registered in `supabase/funnel.sql` and by the Signal Center migration.
- Routes: `#signals`, `#signals/<sport>`, `#signals/s/<id>`, `#signals/dna[/<sport>]`, `#signals/coverage`,
  `#signals/alerts`, `#signals/method`. `#signal-center[/…]` is rewritten to `#signals[/…]`. Back and forward work.
  Leaving clears the hash, and every old route still lands where it did.
- **Landing.** A reader with no saved preferences lands on Signal Center, but only once it is live (or they are
  an operator). Otherwise they are handed on to Research. Remembered tabs, the default-landing setting and deep
  links still win, and Signal Center is offered there as a landing choice.
- A bell notice from Signal Center carries **Open in Signal Center**, which opens its signal.
- The engine and the graphic renderer load on demand (Method, a graphic). The seat itself loads the registry and
  the reader (~80 KB).
