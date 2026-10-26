# Research OS — repository audit (2026-10-26)

Written before any production feature changed. Every row below was read from
the repository at `0536b76a8` (main + editorial commits). Production could
not be reached from the build environment (the network policy refused
`edgedesksports.com` and the Supabase project host), so **nothing in this
audit was verified against production rows**. Where the repository's own docs
state a deployment status, that status is quoted with its date.

## What the terminal is

`app.html` (4.6 MB, ~66,500 lines, 116 script tags) plus `lib/*.js`. No
framework and no build step: ES5-style UMD modules attached to `window.*`,
tested with plain Node scripts (`tools/**/*.test.js`) and Playwright e2e
scripts (`tools/**/*.e2e.js`) against a local PostgreSQL plus a PostgREST
stand-in (`tools/personal/_pg.js`, `tools/billing/_pgrest.js`). The site is a
static deployment (`CNAME` = `edgedesksports.com`); data comes from committed
JSON artifacts rebuilt by GitHub Actions (172 workflows) and from Supabase
(RLS everywhere; security-definer "doors" for anything gated).

### Navigation before this change

One router, `show(v)`, plus a hash router (`navHashRoute`) and the Research
shell's own `researchGo(sub)` / `#research/<module>[/<entity>]`. A seven-seat
bottom bar (`<nav class="bottomnav">`): Signals · Research · Card · Portfolio
· Process · Simulator · More (docs/ia/NAVIGATION_AUDIT.md). There was no
desktop sidebar: the same bottom bar is drawn on every width, and `.view` is
capped at 960 px. Market Foresight was a More row that opened `/foresight/`
in a new tab. Landing: a deep link wins; a new account sees Setup; a reader
with no prefs lands on Signal Center (handing off to Research while Signal
Center is not live); otherwise the remembered tab.

### The shared context that already exists

* `window.edScreenSet / edScreenGet` (`ED_SCREEN`): what game the reader is
  looking at, **identifiers only**. The AI drawer's `carriedContext()` sends it
  as `screen`; the server re-verifies the id against the published card.
* Canonical ids already exist and agree: the slate id
  `<sport>:<provider>:<provider id>` (`lib/edgedesk_games.js`), and the
  research key the slate carries per game (`research.game_key`,
  `nfl|2026_07_DAL_PHI`, `cfb|401871071`) — the same key the game research
  snapshot (`football/game_research/current.json`), the watchlist
  (`watchlist_games.game_key`) and the performance ledger (`event_id`) use.
  No feature joins on team-name strings where a key exists.

## Architecture inventory

| Capability | Existing location | Data source | Status (repo evidence) | Access level | Integration in this change |
|---|---|---|---|---|---|
| Today's slate | `lib/edgedesk_games.js`, `lib/edgedesk_games_ui.js`, `#games`, Research strip | `today/slate.json` (ESPN, every 30 min), `public_slate_live()`, `slate_markets()` | Operational (file refreshed 2026-10-26 07:44Z: 158 events, 35 priced) | schedule public; prices via `slate_markets()` for entitled logins | Overview queue reads the same loaded slate (one fetch, shared) |
| Research (football) | `v-football`, `#game/<nfl|cfb>/<id>` (`lib/edgedesk_game_view.js`) | `football/game_research/current.json` (91 snapshots), board build, Kalshi section | Operational for NFL + FBS | subscriber terminal; market layer per reader | Game workspace gains a "Keep researching" rail (Signals, Foresight, Simulator, AI, Card, Portfolio) |
| Research (other sports) | Research modules `nba`, `nhl`, `baseball`, `ufc`, `lines`, `engine`, `stats`, `lab`, `rdesk`, `pprops`, `edges` | per-module artifacts (`nba/slate.json`, `hockey/slate.json`, …) | Operational; maturity varies (NBA/NHL fair lines "value claims off") | subscriber terminal | Linked from the queue via `EDGames.researchTarget` (module + entity) |
| Signals | `lib/edgedesk_signal_center.js`, `#signals…`, `/signals/`, `/admin/signals/` | `sc_*` doors (`supabase/signal_center.sql`) | **Built and tested, not deployed** (README, 2026-10-23); starts in shadow | `sc_status`/`sc_pulse` anon counts; numbers need Full Access | Overview shows its real status and pulse counts; no threshold, ranking or eligibility touched |
| Market Foresight | `/foresight/` (`foresight/foresight.js` and its engine and renderers in `lib/`) | its own database doors (see `docs/market-foresight/README.md`) | **Built and tested, not deployed**; shadow mode; PR #770 | status for anyone; measurements only when live; full timeline with Full Access; operators everything | First-class seat; the page's controller mounts natively inside the app (same doors, same session); `/foresight/` unchanged |
| Simulator | `lib/edgedesk_simulator*.js`, `#simulator[/<sport>]`, `simulator/` (TS engines) | `sim_*` (`supabase/simulator.sql`) | NFL ACTIVE (2026-10-23); other sports Blocked / Coming Soon / adapters | `sim_public_status` anon (no numbers); runs need entitlement | Overview shows real publish status; seat kept; no simulation is run by navigation |
| EdgeDesk AI | drawer in `app.html` (`EDAI`), `lib/edgedesk_intel_ui.js`, `supabase/functions/edgedesk_ai` | research packets, desk, personal desk (`_mine.js`) | Operational (server function) | signed-in; rate-limited by the function | Overview "Ask" box; context carried through the existing `edScreenSet` identifiers; suggestions limited to routes the desk answers |
| My Card | `lib/edgedesk_decision_ui.js` (`EDDecisionUI`), `v-card` | localStorage `card_opportunities` mirror + `public.card_opportunities` | Operational | per reader (RLS) | Overview workspace summary; game rail "Add to Card" uses the existing add path |
| Watchlist / research alerts | `lib/edgedesk_personal_ui.js` (`EDMine`) | `watchlist_games`, `my_watchlist` (`changed` = seen hash ≠ current hash) | Operational where `supabase/personal_research.sql` is applied | per reader (RLS) | "Changed since last visit" for saved games uses the server's persisted seen hash |
| Saved research | `lib/edgedesk_saved_research.js` | `public.saved_research` | Operational | per reader | Search lists saved items already loaded; no new store |
| Portfolio | `lib/edgedesk_portfolio*.js`, `v-portfolio`, `#portfolio/<tab>` | `supabase/portfolio*.sql` (NUMERIC, triggers) | Operational (Phase A); no automatic sync | per reader (RLS) | Unchanged; Performance reads `portfolio_summary` (the server's own figures) |
| Process | `v-process` (Process Coach), `lib/edgedesk_process.js` | `portfolio_journal.sql` | Operational | per reader | Kept at `#process`; now owned by the Performance seat ("how you decide") |
| Model performance | `v-record` (Record, P&L), `/performance/`, `/performance/grades/` | `performance/data/summary.json` (hash-chained ledger) | Operational (236 verified graded forecasts, 2026-10-26) | public | Performance hub reads the same summary, prints `n` and nothing under `min_n` |
| Model Collective | `v-collective` (`loadCollective`), `/collective/` | `collective.*` via `collective_public` | Operational | public discovery | Stays in More; reachable from search |
| Auth & entitlement | `edToken`, `edUser`, paywall (`#payGate`), `lib/edgedesk_access.js` | `my_billing_access()`; door-level checks (`community_is_entitled`, `sc_viewer_entitled`, `sim_viewer_entitled`) | Operational | — | No new gate; every new read goes through an existing door under the reader's token |
| Feature flags | `lib/edgedesk_flags.js` | — | Used by public pages, not loaded by `app.html` | — | Not used; rollback is the revert of this change |
| Admin / operator | `/admin/*`, `billing_is_admin`, operator gate (`tools/app/operator_gate.test.js`) | — | Operational | operators | Never listed by the new search or Overview; operator diagnostics stay in System health |

## Dependencies and integration risks found

1. **Market Foresight isolation.** Foresight's isolation test fails if any
   tracked file outside an allowlist (`foresight/`, its libs and tests,
   `app.html`, its docs) names one of its database objects, its globals or its
   methodology. So
   the in-app Foresight code lives under `foresight/` and reaches the shell
   through a neutral service hook; no other `lib/` file names the layer, and
   nothing ranks or grades by it.
2. **`sbGet` paints database faults.** Any `sbGet` failure (a door that is not
   deployed answers 404) is recorded by `edNoteDbError` and turns the header's
   System status amber. Signal Center and the games strip use quiet fetches
   for exactly this reason; the Overview must too, or an undeployed optional
   layer would read as an outage.
3. **Tests encode the seven-seat bar.** `tools/app/navigation.test.js` (+ e2e),
   `tools/portfolio/portfolio_ui.e2e.js`, `tools/signal_center/ui.e2e.js`,
   `simulator/tests/ui.e2e.ts`, `tools/guide/guide_ui.e2e.js`,
   `tools/slate/games_ui.e2e.js`, `tools/props/props_ui.e2e.js` click
   `.bottomnav button[data-v=…]`. Keeping the element and its buttons (a
   sidebar on desktop, a bar plus a menu sheet on phones) keeps those selectors
   meaningful; assertions about the old seven-seat order change with the IA and
   are rewritten, never deleted.
4. **Analytics allow-lists.** `primary_nav_*` events are allow-listed in
   `lib/edgedesk_track.js` and `supabase/funnel.sql` with a parity test. New
   seats either reuse that path (registering the new names in both places) or
   are recorded under `secondary_nav_opened`.
5. **`lib/edgedesk_first_run.js` wraps `window.show` / `researchGo`** by
   name; routing must keep calling the globals.
6. **Boot order.** `loadMore`, `hiwOpen` and the AI drawer are defined in later
   script blocks; new code is late-bound through `window.*` at call time.
7. **Signal Center and Foresight are not deployed.** Their honest states ("not
   deployed", "in review") must reach the Overview as such, never as zeros.

## Baseline (before any change)

Run in this environment on 2026-10-26 (Node 22, PostgreSQL 16, Chromium):
the unit, SQL and e2e suites listed in `docs/research-os/REPORT.md` §7, all
recorded there with their results before and after.
