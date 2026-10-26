# Research OS — regression inventory and test compatibility audit

#807 (Research OS) replaced the seven-seat bottom bar with one navigation in
two shapes:
- a sidebar at ≥ 1024 px;
- below that, a bar of five seats plus **Menu**.

It also made the Overview the default landing, and changed script version
stamps in `app.html`. It merged at `7192d098` (merge `afe9815a`) 17 seconds
after it was opened, before any check had reported.

This document records:
- every failure that followed;
- each failure's root cause and repair;
- every test that could depend on the old navigation, and what was done about
  it.

## 0. The failure inventory

**Where the runs came from:**
- **#807's pull request.** Its last commit `7192d098` ran 40 workflows against
  the proposed merge `aa6db1d9` ("Merge 7192d098 into 8024372b").
- **`main`.** Pushes to `afe9815a` and `e57d2e9f` ran 17 and 5 workflows.

**Categories:** **A** an outdated test (an old UI assumption), **B** a genuine
regression, **C** infrastructure.

| # | Workflow · job | Commit | Failing assertion (verbatim) | Root cause | Introduced by #807? | Cat. | Repair | Verification |
|---|---|---|---|---|---|---|---|---|
| 1 | Collective suites · suites; Today's Games tests · browser | `7192d098` (PR), `afe9815a`, `e57d2e9f` (main) | `intel_ui.e2e.js:478` `page.click: Timeout … nav [data-v="process"] … element is not visible` | **RC1.** Process is in Menu on a phone. The suite clicked the hidden seat, threw, and never reached its desktop half. | yes | A | §2 helper; step 9 goes Card → Process → Research through what is drawn | 62 / 1 → **164 / 0** |
| 2 | Player props tests · suites | `7192d098` | `props_ui.e2e.js:171` `waiting for locator('.research-sub button[data-sub="pprops"]') to be visible — 65 × locator resolved to hidden` | **RC2.** The suite assumed Research was the landing. The Overview is, and Research's row is drawn only on Research. | yes | A | the Research seat, then Props (1440 and 390 px) | 0 / 1 → **140 / 0** |
| 3 | Funnel tests · browser | `7192d098` | `1280: the NFL game the state did not grade is WATCH ["…Buffalo BillsWATCHNFL…"]`, then `first_run.e2e.js:282 page.click: … input[name="lg"][value="cfb"] … element is not visible` | **RC3.** New accounts landed on the Overview while the first-run panel sat in the hidden Research view. The "queue mismatch" was the panel's unrendered `innerText`. | yes | **B** | production landing rule (§1) | old code 9 / 7 → **61 / 0** |
| 4 | Matchup graphic tests · suites | `7192d098` | `FAIL app.html loads the module after the renderer, with the renderer's version` | **RC4.** The merge moved the renderer to `?v=…ros2` and left `edgedesk_sport_graphic.js` at `sg1`. | yes (merge) | **B** (cache contract) | the module's stamp joins the renderer's; checked from a real load | 1501 / 1 → **1502 / 0**; browser 56 / 1 → **57 / 0** |
| 5 | Simulator suites · e2e | `7192d098`, `afe9815a` | `FAIL a failed refresh keeps the last good results on screen, marked stale` | **RC5.** The fixture failed the *second* status read. The Overview landing makes the first, so the Simulator's own first load failed instead of its refresh. | yes | A | the failure is armed after the Simulator's own first draw | 144 / 1 → **145 / 0** |
| 6 | Market Foresight tests · suites | `7192d098`, `afe9815a` | `FAIL no file outside the allowlist references Market Foresight … ["docs/research-os/REPORT.md"]` (engine 121 / 0; its database job passed) | **RC6.** REPORT.md named the Foresight status door by its database name, which only the layer's own files may use. | yes | **B** (boundary) | the sentence reworded; **the allowlist is unchanged** | 35 / 1 → **36 / 0** |
| 7 | Signal Center tests · browser (failure); · database (**cancelled**) | `7192d098`; `afe9815a` cancelled | `FAIL landing: …whose Signals tile reads the server's own 24-hour count when live (53) — "SIGNALS 53 published in 24 h · 8 major"` | **RC7.** A formatting assertion: `innerText` returns the label CSS uppercases (`.ov-tk`). It was not a race, because the reader waits until the tile leaves "Checking". It was not a data mismatch: the tile showed 53 and the server's count was 53. | yes (a check #807 added) | A | the exact server count is asserted, label case-insensitive | 125 / 1 → **126 / 0**. The cancelled database job is re-run in this pull request's CI and in `npm run verify` |
| 8 | Guide CI · browser | not run on `main` pushes; reproduced on `main` at `2a1bcf00` | `FAIL no page errors ["the injury layer answered without a state"]` | **RC8.** `lib/edgedesk_nba_ui.js` threw inside `.then(ok, fail)`'s success handler, which `fail` never sees: an unhandled rejection. It surfaced when today's NBA slate put games in the walkthrough's window. | **no, pre-existing** | B | `.then(ok).catch(fail)`; cache token bumped (§6) | NBA 74 / 2 → **76 / 0**; guide 73 / 1 → **74 / 0** |

**Seven distinct root causes came with #807 (RC1–RC7), plus one that was
already on `main` (RC8).** Odds gateway tests and CFB security were cancelled
on `afe9815a` by the next push, and passed on `e57d2e9f`.

**Local only (C), no repair needed:** `lab.yml` and `nba.yml` need Python's
`pyarrow`, and the NCAAM typecheck needs `npm ci --prefix simulator`. CI
installs both, and they were installed here.

## 1. First-time onboarding (RC3)

What a brand-new trialing account saw after #807, verified in Chromium at
1280 and 390 px:

* it landed on `#overview`, both after Setup and on a load with nothing saved;
* "Here's what EdgeDesk found today." was mounted inside the **hidden**
  Research view;
* the welcome modal was suppressed and the six-step onboarding modal held,
  both for that panel;
* yet `first_run_viewed` was recorded and `first_run_seen_at` stored.

A new account got no onboarding at all, and the funnel counted a view that
never happened.

**Owner decision (2026-10-26).** An account in its first two weeks that has
not put the panel away lands on Research, where the panel is. Everyone else
lands on the Overview.

* **The rule:** `EDShell.landing()` in `lib/edgedesk_shell.js`, asked by
  `edLandDefault()` in `app.html`.
* **Where it applies:** the boot's "nothing saved" and "no usable memory"
  branches, and Setup's hand-off.
* **What it reads:** the session user's creation time against the first-run
  module's own 14-day window, and the panel's "put away" mark on this device
  (`done_at`).

**How it is held:**
* `research_os.test.js`:
  * a new account lands on Research, until it puts the panel away;
  * an account 30 days old lands on the Overview;
  * no user, or no creation time, lands on the Overview;
  * the window equals the first-run module's, an hour either side of its
    edge.
* `first_run.e2e.js` (browser):
  * the panel is drawn in the view the reader lands on, and that view is
    Research, its seat lit;
  * Setup's Enter goes to Research with the panel drawn;
  * a new account that put the panel away lands on the Overview;
  * an account past the window lands on the Overview.
* `navigation.e2e.js` repeats the Setup and past-the-window cases at 390 and
  1440 px.

## 2. The shared navigation driver

**`tools/app/nav_helper.js`.** A browser suite that moves between
destinations taps what a reader can see at the page's width:

| Width | What is drawn | How `NAV.go(page, seat)` reaches a seat |
|---|---|---|
| ≥ 1024 px | the sidebar, every seat | taps it in the sidebar |
| < 1024 px | the bar: Overview · Research · Signals · Card · Portfolio · Menu | taps a bar seat; reaches any other seat (Market Foresight, Simulator, Performance, Process, More) through **Menu**'s sheet |

* `NAV.research(page, sub)` opens a Research panel through its row: Football,
  Props or Edges directly, everything else through **Other** (which is a
  toggle, so it is tapped only while closed).
* `NAV.seatShown(page, seat)` is true when the seat is lit and
  `aria-current`, and either drawn, or off the phone's bar with **Menu** lit.
* Nothing is clicked through, forced, or routed with `show()`.
* Every call waits until the destination is drawn, and fails by name.

**Who uses it.** Nine suites use it, and three hand-written seat helpers are
gone. Every workflow that runs one of those suites starts on a change to
the helper: six list it in `paths:`, the rest through `tools/app/**`.

**A suite that tests one view may still open it by deep link or `show()`.**
That is a valid route. A suite that tests *getting there* uses the helper.

## 3. The audit: every test that could depend on the old navigation

**What was searched.** All 63 tracked files that drive Playwright, plus the
static suites that parse `app.html`, for:
- navigation selectors (`.bottomnav`, `nav [data-v`, `#navMenuBtn`) and
  Research's row (`.research-sub`, `data-sub=`, `#rsOther`);
- direct seat clicks;
- landing assumptions (bare `/app.html` loads, `show(`, `researchGo(`, hashes);
- onboarding visibility (`edFirstRun`, setup, the guide's introduction, the
  welcome and onboarding modals);
- script order and version contracts (`?v=`, `indexOf('/lib/…') < …`).

**What was found.**
- No test pins a literal `?v=` stamp.
- Every script-order assertion is a real dependency contract.

**Passing, but asserting the old navigation: updated.**

| Suite | What was outdated | Now |
|---|---|---|
| `simulator/tests/ui.e2e.ts` | "the Simulator seat is in the bottom bar and active". At 390 px it is in Menu. The check passed by reading a class on a hidden button. | reached through Menu (390) or the sidebar (1440), and `seatShown` |
| `tools/portfolio/portfolio_ui.e2e.js` | its own seat helper; seat-lit checks read a class whether the seat was drawn or not | `NAV.go`, `NAV.seatShown` |
| `tools/app/navigation.e2e.js`, `tools/research_os/journey.e2e.js` | their own copies of the seat helper; a "seven seats" heading over a ten-seat check | `NAV.go`; heading corrected |
| `tools/signal_center/ui.e2e.js`, `tools/slate/games_ui.e2e.js`, `tools/guide/guide_ui.e2e.js` | direct `.bottomnav button[data-v=…]` clicks | `NAV.go` |
| `tools/app/navigation.test.js`, `tools/research_os/research_os.test.js` | pinned the old boot string; the order checks anchored on it | the `edLandDefault()` boot branch |

**Reviewed, valid under the new navigation: unchanged.**

* **Deep links to the view under test:**
  * `#research/…` and `#game/…`: `decision_ui`, `cbase_ui`, `fbs_board`,
    `market_structure_ui`, `price_refresh`, `quote_ev_ui`,
    `game_research_ui`, `matchup_props`, `ref_flags_ui`, `altitude/ui`,
    `engine_ui`, `linemaker_ui`, `nba_ui`;
  * `#simulator/…`: `ncaam_ui`, `ncaaw_ui`;
  * `#portfolio`: `bet_history`, `bet_import`, `juicereel_ui`,
    `sharpsports_ui`;
  * `#games`: `grades_ui`, `sport_graphic_ui`.
* **A bare `/app.html`, then a route or an overlay:**
  * the AI drawer: `chat`, `desk_ui`, `intelligence/journey`, `quant_ui`;
  * the onboarding modal: `personal_ui`;
  * hosts injected by the suite: `opportunity_ui`;
  * `researchGo()`: `baseball_ui`, `cbb_ui`;
  * `show('record')`: `pnl_ui`, `signal_pnl_ui`.
* **Suites that hold the new landing themselves:**
  * `navigation.e2e`, `research_os/journey`;
  * `signal_center/ui`'s fresh-reader cases, whose sessions carry no
    creation date;
  * `slate/games_ui`, which seeds a returning Research reader.
* **Pages other than `app.html`:** `checkout_flow`, the Foresight public
  pages, `admin_funnel`, the growth pages, `home/landing`, `content_engine`,
  `signal_center/pages`, `performance_ui`, `research_ui` (NCAAM).
* **Script-order contracts:** `cfb_terminal/read`, `football/game_brief`,
  `games/franchise`, `portfolio/bet_import`, `portfolio/portfolio_ui`,
  `ufc/fight_center_ui`, `validation/ui`, `research_os`, `sport_graphic`.

**Never run on #807.** `baseball_ui.e2e.js` and `cbb_ui.e2e.js` run only in
`games-sql.yml`, which does not start on an `app.html` change. They were run
here against a local PostgreSQL 16.

**The Matchup graphic contract, from a real load (RC4).**
`sport_graphic_ui.e2e.js` reads:
- both script responses (one each, 200);
- their equal `?v=`;
- the order the browser defines `EDGameGraphic`, then `EDSportGraphic`;
- that the module finds the renderer's `layout`.

## 4. Two sessions, one repair

After #807 merged, the original Research OS session pushed eight fix commits
to `claude/edgedesk-sports-research-os-o6vqxg` (tip `7371dc9d`). They fix the
same failures as this branch. This branch merged that tip and kept **one
implementation of each**:

* **The landing rule.** The fix branch's `EDShell.landing()` and
  `edLandDefault()` were kept; this branch's duplicate was removed. Setup's
  hand-off goes through `edLandDefault()`, so the rule ("not put the panel
  away") also holds after Setup.
* **A missing cache bump.** The fix branch changed `lib/edgedesk_shell.js`
  without bumping its `?v=` in `app.html`. Returning browsers would have kept
  the old shell and never asked the rule. It is bumped (`20261026nav1`).
* **From the fix branch:** REPORT.md and the Signal Center tile assertion.
* **From this branch:** the browser suites keep the shared driver instead of
  a fourth hand-written seat helper.
* **Funnel:** both branches' new cases are kept.

That session was told this, and this branch never pushed to it.

## 5. Recurrence guards

* **Every place, reached through what is drawn**
  (`navigation.e2e.js` §10). From the landing, at 390 and 1440 px, these are
  reached the way a reader at that width reaches them, and each draws with
  its seat lit where the reader sees it:
  * all ten seats, with the Process Coach drawn;
  * all twelve Research panels: Football, Props, Edges, UFC, Baseball, NHL,
    NBA, Lines, Engine, Stats, Lab and Desk.
* **No blind taps** (`navigation.test.js` §9). No browser suite clicks, waits
  for or locates a seat, Menu or a Research tab by selector:
  * only the helper and the two suites that test the navigation's own
    controls are exempt;
  * run over `main`'s files, it flags exactly the lines that broke
    (`intel_ui.e2e.js:478`, `props_ui.e2e.js:171`) and the other direct taps;
  * it lets helper calls and state reads through, and samples of both are
    checked;
  * `research-os-tests.yml` now also starts on any `**/*.e2e.js` or
    `**/*.e2e.ts` change, so the guard sees a new suite.
* **Onboarding:** §1.
* **Script order and cache versions:** §3. Every changed front-end file
  carries a new stamp: `edgedesk_shell.js`, `edgedesk_workspace_ui.js` and
  `edgedesk_nba_ui.js`. `edgedesk_sport_graphic.js` is unchanged in content
  but now shares its renderer's stamp.
* **Back / Forward, and the shared game context:** `research_os/journey.e2e.js`
  holds both at 1440 and 390 px. Back from Performance returns to Portfolio
  and Forward returns, and the game's research key survives the moves to
  Signals and back.

## 6. The pre-existing failure fixed here (RC8)

Guide CI runs on this pull request and failed on `main` the same way, so it
is fixed here, in a commit of its own.

* **The bug.** `injLoad` in `lib/edgedesk_nba_ui.js` threw "answered without
  a state" inside `.then(ok, fail)`'s success handler. A handler in the same
  `.then` never sees that throw, so the rejection reached the page and the
  card stayed on "Reading the injury report…".
* **The fix.** It is now `.then(ok).catch(fail)`, and the card says "Injury
  report not yet available", with the reason. The lazy-load token
  `NB_SCRIPT` is bumped.
* **The test.** `nba_ui.e2e.js` checks this outside its Hornets @ Nets block.
  That block runs only while its fixture game is on the committed slate, and
  it is not today.
* **The same pattern in the NHL goalie loader** (`lib/edgedesk_nhl_goalies.js`,
  done here at the owner's request). An answer with no state made `load()`
  reject: the engine panel's `GL.load(id).then(render)` left that unhandled,
  and the cache kept the rejected promise as "loading". The goalie block then
  spun until a reload; even a forced re-read returned the same rejection.
  * **The fix:** `.then(ok).catch(fail)`, as above. The engine fetches this
    file with an hourly cache token (`bust()`), so no stamp to bump.
  * **The test:** `tools/hockey/nhl_goalie_ui.test.js` checks that an answer
    with no state resolves, is the card's error, and is no longer loading;
    that the next good answer is read; that an HTTP 404 names the missing
    layer; and that nothing goes unhandled.
  * **Result:** old code 34 passed, 4 failed; now 38 / 0. Engine UI
    (browser): 148 / 0.

## Found, outside this change

`signals/index.html` and `admin/signals/index.html` still load
`edgedesk_game_graphic.js?v=20261025pd1`. The file changed in b9846a46,
before #807, so a returning browser there can keep the old renderer.
