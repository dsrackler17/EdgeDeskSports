# Research OS — delivery report (2026-10-26)

Branch `claude/edgedesk-sports-research-os-o6vqxg`, started from `main` at
`0536b76a8` and merged with `main` up to `1c3b5c07a`. **Not merged into `main`,
not deployed.** Production could not be reached
from the build environment, so every result below comes from this repository,
a local PostgreSQL 16 and Chromium (§10).

## 1. Architecture audit

The full inventory is [`AUDIT.md`](AUDIT.md), written before any feature
changed. In short:

* **The terminal is `app.html`** (4.6 MB, ~66,500 lines, 116 script tags) plus
  `lib/*.js` UMD modules: no framework and no build step.
* **Data:** committed JSON artifacts, plus Supabase behind row security and
  security-definer doors.
* **Routing:** one router (`show(v)`), a hash router and the Research shell's
  `researchGo`.
* **Navigation before this change:** a seven-seat bottom bar on every width.
  Market Foresight was a More row that opened a new tab.
* **Ids already agreed across features:** the slate id and the research key
  (`nfl|2026_07_DAL_PHI`), used by research, the watchlist, the performance
  ledger and Market Foresight. A shared-context mechanism already existed for
  the AI desk (`edScreenSet`, ids only).
* **Seven integration risks were found and designed around:**
  1. Foresight's isolation test;
  2. `sbGet` painting database faults;
  3. tests encoding the seven-seat bar;
  4. the analytics allow-lists;
  5. the first-run wrappers;
  6. boot order;
  7. two undeployed layers.

## 2. What was built

| Brief | Delivered | Where |
|---|---|---|
| App shell | sidebar ≥ 1024 px; a five-seat bar + Menu sheet below; groups Research · Your workspace · More; deep links for every place; seat taps are history steps | `lib/edgedesk_shell.js`, `lib/edgedesk_shell.css`, `app.html` nav + router |
| Shared research context | one game carried by ids between every feature; recently viewed; "changed since your last visit" from snapshots this device stored | `lib/edgedesk_context.js` |
| Overview | header and sport filter, Ask box, today's summary, research queue (Today / Next 7 days / Changed / Saved / Recent), captured price changes, Signals, Simulator, Market Foresight, your workspace; honest states for every optional layer | `lib/edgedesk_overview.js` |
| Game workspace | "Keep researching this game": Signals, Foresight preview + record, Simulator, Ask AI, Add to Card, Record a position | `lib/edgedesk_game_view.js` hook, `EDContext.railHTML` |
| Market Foresight, first-class | a seat; the public page's own controller mounted in the app, with in-app deep links, the same doors and session, and shadow-safe; `/foresight/` unchanged | `foresight/service.js`, `foresight/app.js`, `foresight/app.css`, `foresight/foresight.js` (boot export) |
| Signals | the Overview reads its real state and pulse counts; the game rail links the game's sport | read-only |
| Simulator | the Overview reads what is published; the game rail opens the game's sport | read-only |
| Context-aware AI | Ask AI in the header, on the Overview and on the game rail; the existing drawer, given the game's ids | existing `edAsk` / `edScreenSet` |
| Card / Portfolio / Performance | Performance is a new seat: model record and your record on one page, never combined; Process sits under it | `lib/edgedesk_perf_hub.js` |
| Universal search | Ctrl/⌘ K or `/`: games, teams, saved items, recently viewed, places, Simulator sports, your positions | `lib/edgedesk_search.js` |
| Design, responsive, a11y | branding kept; 44 px seats; dialog semantics, focus traps, Escape; `aria-current`; no horizontal scroll at 390 / 768 / 1280 / 1440 | `lib/edgedesk_shell.css` |
| Data trust, security | no new table, policy or grant; every read through an existing door under the reader's token; quiet reads; nothing ordered by a model–market gap | §6, `DESIGN.md` §10 |

## 3. Navigation map

See [`DESIGN.md` §1](DESIGN.md#1-navigation-and-the-shell) for the full
table. In brief:

* **Research:** Overview `#overview` · Research `#research/…`, `#game/…` ·
  Signals `#signals…` · Market Foresight `#foresight[/game|/model/…]` ·
  Simulator `#simulator[/<sport>]`.
* **Your workspace:** My Card `#card` · Portfolio `#portfolio[/<tab>]` ·
  Performance `#performance` (Process `#process` under it; Record still at
  `#record` / `#pnl`).
* **More:** `#more`.

Every earlier hash still resolves to the same view.

## 4. The unified journey, with real records

Checked in Chromium by `tools/research_os/journey.e2e.js` at 1440 × 900 and
390 × 844. The game and slate are the repository's committed records, with
the browser clock pinned 20 minutes after the slate was built.

**The journey game:** Dallas Cowboys at Philadelphia Eagles.

* Slate id `nfl:espn:401873009`, research key `nfl|2026_07_DAL_PHI`.
* Kickoff 2026-10-27 00:15 UTC.
* One of 14 games on 2026-10-26 (America/Chicago).

| Step | The reader does | What carries the game | What they see (checked) |
|---|---|---|---|
| 1 Overview | lands on the terminal | — | the queue lists the game; "Games today" equals the slate's 14; "Saved needs a look" equals the watchlist's server-side `changed` |
| 2 Research | taps the row | `#game/nfl/2026_07_DAL_PHI` | the game's own research page and the "Keep researching" rail; the AI desk is handed `game_id` = the research key |
| 3 Signals | rail → Signals | `#signals/nfl` | Signal Center on NFL; Back returns to the same game |
| 4 Market Foresight | rail → preview → record | `#foresight/game/nfl:2026_07_DAL_PHI` | "Not in the record yet" (the game has not kicked off), from Foresight's own door |
| 4b | a measured game | `#foresight/game/cfb:<event>` | the record drawn in the app: 3 timelines with Full Access, findings, coverage |
| 5 Simulator | rail → Simulator | `#simulator/nfl` | NFL selected; the published run (100,000 seasons, model `edgedesk_nfl_v2`, "published 3 h ago") read through its doors |
| 6 My Card | seat | `#card` | the Card |
| 7 Portfolio | seat | `#portfolio` | the reader's own book: +$170.00, 3 settled, 2–1 |
| 8 Performance | seat | `#performance` | the model record (from the public ledger, nothing under `min_n`) beside the reader's record (`portfolio_summary`), never combined |

The journey also checks:

* Back / Forward through the whole path, and a refresh on the Foresight
  record.
* Search: typing the two teams' short names lists the game first, and Enter
  opens its research and sets the context again.
* No page error, and no listener added twice.
* Access as a free account (paywall, no door gives up held-back rows), as an
  operator (shadow record) and as a subscriber in shadow ("In review").

**What is test-seeded.** The watchlist row, the three settled positions and
the Simulator run are test-seeded, in a throwaway database only. So are the
Foresight scenario's Kalshi quotes and Collective models (its DraftKings
quotes and EdgeDesk forecasts are the committed ledgers;
`docs/market-foresight/README.md`).

## 5. Files changed

| | Files |
|---|---|
| New: product | `lib/edgedesk_context.js`, `lib/edgedesk_shell.js`, `lib/edgedesk_shell.css`, `lib/edgedesk_overview.js`, `lib/edgedesk_search.js`, `lib/edgedesk_perf_hub.js`, `foresight/service.js`, `foresight/app.js`, `foresight/app.css` |
| Changed: product | `app.html` (nav markup, router maps, three views, header buttons, script tags, cache tokens, landing), `index.html` (the landing page's #desk now lists the terminal's nine places, Market Foresight marked in review; the `edgedesk_track.js` stamp), `foresight/foresight.js` (boot export, in-app option), `foresight/index.html` (cache token), `lib/edgedesk_game_view.js` (workspace hook), `lib/edgedesk_games_ui.js` (`snapshot()`, `subscribe()`), `lib/edgedesk_track.js` (four event names), `lib/edgedesk_workspace_ui.js` (Setup's destinations), `lib/edgedesk_guide_content.js` (the Process step's target) |
| New: database | `supabase/research_os.sql`, `supabase/migrations/20261026120000_research_os.sql` (identical), `supabase/research_os_rollback.sql`; `supabase/funnel.sql` gains the same four rows |
| New: tests | `tools/research_os/research_os.test.js`, `tools/research_os/journey.e2e.js`, and the journey's Foresight helper (`_terminal.js` in Foresight's own test directory, so the layer stays named only there) |
| Changed: tests | `tools/app/navigation.test.js` / `.e2e.js`, `tools/portfolio/portfolio_ui.test.js` / `.e2e.js`, `tools/signal_center/ui.e2e.js`, `tools/slate/games_ui.e2e.js`, `tools/presentation/landing_positioning.test.js`: assertions about the seven-seat bar (and the landing page's "six seats") rewritten for the new IA, none deleted; `tools/presentation/landing_asset_stamps.json` records the new stamp. `tools/billing/_pgrest.js` (the shared PostgREST stand-in) learns multi-column `order=`, `offset=` and `col::text`, as PostgREST has them. |
| CI, docs | `.github/workflows/research-os-tests.yml` (new); `market-foresight-tests.yml` (adds the journey); `package.json` (`ros:test`, `ros:e2e`); `README.md`, `CHANGELOG.md`; `docs/research-os/{AUDIT,DESIGN,REPORT}.md`; `docs/market-foresight/GO_LIVE_CHECKLIST.md`, README link |

## 6. Database changes and rollback

`supabase/research_os.sql` (mirrored in `supabase/migrations/`) adds **no
table, column, function, policy, role or grant**. It inserts four rows into
`public.user_event_kinds`:

* `primary_nav_overview`
* `primary_nav_foresight`
* `primary_nav_performance`
* `primary_nav_simulator`

This uses `on conflict do nothing`, and the file does nothing where the funnel
is not deployed. The new seats' taps are then recorded like every other seat's.
Until it is applied, those taps are dropped by the server exactly as unknown
events were before. Nothing else depends on it.

* **Apply:** paste into the SQL editor. It is safe to run twice; the report
  row reads `ok`.
* **Rollback:** `supabase/research_os_rollback.sql`. It removes only the names
  that have no recorded events. Recorded taps are history and are kept,
  together with the name they need.
* **Verified:** applied twice, rolled back and applied again on PostgreSQL 16
  (journey e2e).

Nothing in this change writes to any other table. Market Foresight's and
Signal Center's modes are untouched, and both start in shadow.

## 7. Testing

The pull request carries `npm run verify` (every workflow a pull request can
start) for its final commit, with the SUMMARY line and the NOT VERIFIED list
verbatim. This section records what was built and checked by hand.

**New suites.**

| Suite | What it holds |
|---|---|
| `tools/research_os/research_os.test.js` (142 checks, offline) | context ids and links per sport, the last-visit diff (same book, two capture times, else "not comparable"), the queue order (never by a model–market gap), the Overview's copy rules, the AI suggestions (only routes the desk answers), search, the Performance hub's "never combined" rule, and the `app.html` wiring: script order, routes, landing, the bare `#research` bookmark |
| `tools/research_os/journey.e2e.js` (126 checks, Chromium + PostgreSQL 16) | the whole journey of §4 at 1440 px and 390 px; access as a subscriber, a free account, an operator and anon at the doors; Back / Forward; search; the AI desk's ids; listeners; widths; no door the journey serves answers an error; the System pill never names one; the SQL apply / rollback / apply |

**Regression tests shown failing on the old code, then passing.**

| Defect found while verifying | Test | Old code | Fixed |
|---|---|---|---|
| The PostgREST stand-in rejected the Simulator's `order=entity_id,outcome` and Portfolio's `col::text`, so the journey's Simulator showed "db 400" | the journey: "reads the published run through its own doors", "no door … answered with an error" | 122 passed, 4 failed (stand-in from `0536b76a8`) | 126 of 126 |
| A bare `app.html#research` bookmark reached Research only because Research was the default landing page | `navigation.e2e.js`: "a bare #research opens Research for a reader with nothing saved" | lands on the Overview (`a4ed530e4`) | 188 of 188 |
| The phone Menu sheet's Close button was 38 px | `navigation.e2e.js`: "every seat in the sheet is a 44px tap target" | 38 | passes |
| The journey left its PostgreSQL cluster running after every run | checked by listing `postgres -D` processes after each run | 10 clusters left | none |

**Tests changed with the IA (assertions rewritten, none removed):**
`tools/app/navigation.test.js` / `.e2e.js`,
`tools/portfolio/portfolio_ui.test.js` / `.e2e.js`,
`tools/signal_center/ui.e2e.js`, `tools/slate/games_ui.e2e.js` and
`tools/presentation/landing_positioning.test.js`. The last one now requires
the landing page's list to be exactly `app.html`'s `NAV_PRIMARY`, not six.

**Rendered-page audit** (Chromium; the final code against `main` at
`1c3b5c07a`). Conditions:

* the same committed slate (sha256 identical) and a pinned clock;
* a signed-in subscriber;
* every Supabase door answering 404 "not deployed";
* 14 routes at 1440 × 900 and 390 × 844.

| | This branch | `main` |
|---|---|---|
| Page errors | 0 | 0 |
| Console errors other than the browser's "Failed to load resource: 404" | 0 | 0 |
| Routes with horizontal scroll | 0 of 14 (both widths) | 0 of 14 |
| Linked files that do not exist | 0 | 0 |
| In-app hash links the router does not take | 0 of 29 | 0 |
| Listeners added on a second and third loop of every seat | 0 | 0 |
| Same-origin files that 404 | `football/injuries/nfl_0.json`, `football/nfl/qbs_0.csv` | the same two (pre-existing) |

* **What the 404 lines are.** Every 404 console line is a browser network
  log for a stubbed door, plus the two pre-existing files above.
* **One extra read on the game page:** Foresight's status door (`status()` in
  `foresight/service.js`), for the Foresight preview on the "Keep researching"
  rail, memoized for a minute. Until Foresight is deployed it answers 404 and
  the rail says "not deployed".
* **The Overview landing makes fewer reads than main's Research landing.**

**Pre-existing failures** (red on `main` too, not caused by this change) are
listed in the pull request with the run that shows them on `main`.

## 8. Load cost

`app.html` against `main` at `1c3b5c07a`, same machine, idle, Chromium,
1440 × 900. Conditions match the audit: a signed-in subscriber with nothing
saved, every Supabase door 404 except the subscription. Each figure is the
median of 9 loads. Times are the navigation timing entry's
`domContentLoadedEventEnd` and `loadEventEnd`; the read count covers the
first 5 seconds.

| Landing for that reader | DOMContentLoaded | load | JS heap | DOM nodes | requests | JS | CSS | JSON | Supabase reads |
|---|---|---|---|---|---|---|---|---|---|
| `main`: Research → Football | 1168 ms | 1421 ms | 30 MB | 2040 | 138 | 98 files, 5,029 KB | 18, 284 KB | 21, 11,134 KB | 25 |
| this branch: **Overview** | 1046 ms | 1049 ms | 18 MB | 1844 | 127 | 95, 4,571 KB | 21, 319 KB | 10, 1,463 KB | 21 |

| The same view (`#research/football`) | DOMContentLoaded | load | JS heap | DOM nodes | requests | JS | CSS |
|---|---|---|---|---|---|---|---|
| `main` | 1101 ms | 1398 ms | 30 MB | 2024 | 138 | 98 files, 5,029 KB | 18, 284 KB |
| this branch | 1121 ms | 1383 ms | 30 MB | 2107 | 147 | 104, 5,157 KB | 21, 319 KB |

* **What the shell costs on every page:** six scripts and three stylesheets,
  163 KB uncompressed and 52.7 KB gzipped. `app.html` itself grows 10 KB
  (2.8 KB gzipped). The Foresight record's controller and renderers load only
  when it is opened.
* **The same view:** the timings differ by +20 ms and −15 ms, within the run
  to run spread. The DOM gains 83 nodes (the sidebar's labels and groups).
* **The Overview landing:** it reads the slate the Research strip loads and
  the light status doors, not Football's boards. So a reader's first screen
  costs less than `main`'s: 9.7 MB less JSON, a 12 MB smaller heap and 4
  fewer database reads.
* **Not measured:** a physical phone, a slow network and production's CDN.

## 9. Deployment states

| Layer | State | What turns it on |
|---|---|---|
| The terminal changes (shell, Overview, search, Performance, game rail, in-app Foresight) | in this PR; **not merged** | merging to `main` publishes `app.html` and `lib/` (static site) |
| `supabase/research_os.sql` (four event names) | **not applied** | the SQL editor; optional, analytics only |
| Market Foresight | built and tested, **not deployed**; starts in **shadow** | its own deploy steps, then [GO_LIVE_CHECKLIST.md](../market-foresight/GO_LIVE_CHECKLIST.md); **not switched live by this work** |
| Signal Center | built and tested, **not deployed** (README, 2026-10-23); starts in shadow | its own deploy steps |
| Simulator | NFL ACTIVE (2026-10-23); other sports blocked, coming soon or adapters | unchanged |
| The terminal's reading of undeployed layers | Foresight → "not deployed" / "In review"; Signals → "Not live" | nothing: it follows each layer's real state |

## 10. Production verification limitations

* **Production was not reachable.** The build environment's network policy
  refused `edgedesksports.com` and the Supabase project host. No production
  row, deployed door, live slate or real account was read.
* **Access was checked against the shipped SQL, not against production.**
  Every access statement in this report holds for the shipped migrations on a
  local PostgreSQL 16, read through a PostgREST stand-in
  (`tools/billing/_pgrest.js`). It does not prove what production has applied.
* **The AI desk's server was stubbed.** The function is not part of this
  change. The test checks what the terminal sends it (ids only), not its
  answers.
* **Reads the journey does not serve answer "not part of this test" (404).**
  These are the reads outside the shipped migrations it applies. One example
  is the System-health heartbeat's `signals` read, which is why the header
  pill shows a failure in the screenshots. The journey checks that the pill
  never names a door the journey serves.
* **Fixed data and one browser.** The run uses the committed slate at a pinned
  clock, with Chromium only (Playwright 1.63 here; CI pins 1.49.1). No
  physical phone and no Safari or Firefox were tested.

## 11. Known limitations

* **Coverage of the game page and Foresight.** The research page and the
  "Keep researching" rail exist for NFL and FBS only, and so does Market
  Foresight. Other sports' queue rows open their Research module
  (`EDGames.researchTarget`).
* **Device-local history.** "Changed since your last visit" for unsaved games
  and "recently viewed" are per device. Saved games use the server's seen
  hash.
* **Signals.** The Overview's tile reads "Not live" until Signal Center is
  deployed.
* **Record and Performance.** Record remains its own view (P&L and proof
  layer). Performance links to it rather than absorbing it.
* **One slate fetch remains duplicated, and it predates this change:**
  `EDCardFeed` still reads `slate.json` itself. The Overview reuses the
  Research strip's load.

## 12. Next improvements

1. Apply `research_os.sql`, then read the `primary_nav_*` events for two weeks
   before changing which seats the phone bar holds.
2. Deploy Signal Center and Market Foresight through their own checklists. The
   Overview and the game rail pick them up with no change.
3. Server-side "last visit" per reader for unsaved games, to replace the
   device snapshot (a small table under row security). Not done here: no new
   tables without a decision.
4. Game pages for the sports whose Research modules already hold per-game
   research (NBA, NHL), so the rail can follow.
5. Retire `EDCardFeed`'s second `slate.json` read by giving it
   `EDGamesUI.snapshot()`.

## 13. Market Foresight go-live

Market Foresight **stays in shadow**. The go-live checklist is in
[`docs/market-foresight/GO_LIVE_CHECKLIST.md`](../market-foresight/GO_LIVE_CHECKLIST.md).
The switch is one operator statement, run by hand, and no workflow, script or
test runs it.
