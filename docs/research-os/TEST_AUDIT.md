# Research OS — the test compatibility audit

#807 (Research OS) replaced the seven-seat bottom bar with one navigation in
two shapes, made the Overview the default landing, and changed the script
order and version stamps in `app.html`. Eight workflows went red on its pull
request's last commit (Collective suites, Today's Games tests, Player props,
Matchup graphics, Funnel, Simulator suites, Market Foresight, Signal Center).
The Signal Center run on the merge was cancelled, not passed. This is the
audit of
every test that could depend on the old navigation, and what was done about
each, in one change.

## How a browser suite navigates now

**`tools/app/nav_helper.js`.** Every browser suite that moves between
destinations taps what a reader can see at the page's width:

| Width | What is drawn | How `NAV.go(page, seat)` reaches a seat |
|---|---|---|
| ≥ 1024 px | the sidebar, every seat | taps it in the sidebar |
| < 1024 px | the bar: Overview · Research · Signals · Card · Portfolio · Menu | taps a bar seat; any other seat (Market Foresight, Simulator, Performance, Process, More) through **Menu**'s sheet |

* `NAV.research(page, sub)` opens a Research panel the way a reader does: the
  Research seat, then Football · Props · Edges, or **Other** and the panel in
  its second row.
* `NAV.seatShown(page, seat)` is true when the reader can see where they are:
  the seat is lit and `aria-current`, and either drawn, or off the phone's
  bar with **Menu** drawn and lit for it.
* `NAV.state(page)` returns the navigation's state, for a check's detail.
* Nothing is clicked through, forced, or routed around with `show()`.
* Each call waits until the destination is drawn, and fails by name when a
  seat cannot be reached.

The suites that use it list `tools/app/nav_helper.js` in their workflow's
`paths:`, so a change to the helper starts them.

**A suite that tests one view may still open it by deep link or by `show()`.**
That is a route, and it is valid. A suite that tests *getting there* uses the
helper.

## What was searched

Every tracked test file was searched (63 files drive Playwright) for:

* navigation selectors: `.bottomnav`, `nav [data-v`, `[data-v="…"]` on a seat,
  `#navMenuBtn`;
* Research's sub-navigation: `.research-sub`, `data-sub=`, `#rsOther`;
* direct seat clicks;
* route assumptions: bare `/app.html` loads, `show(`, `researchGo(`, hashes;
* onboarding visibility: `edFirstRun`, setup, the guide's introduction, the
  welcome modal, the onboarding modal;
* script order and versions: `?v=`, `indexOf('/lib/…') < …`, and version
  equality between scripts.

No test pins a literal `?v=` stamp. Every script-order assertion found is a
real dependency contract.

## 1. Broken by #807: red on its last commit, now fixed

| Workflow (suite) | What broke | Root cause | Fix | Before → after |
|---|---|---|---|---|
| Collective suites, Today's Games tests (`tools/intelligence/intel_ui.e2e.js:478`) | `nav [data-v="process"]` never became visible | Process is in Menu on a phone. The suite clicked the hidden seat and threw, so the desktop half never ran. | Step 9 goes Card, then Process, then Research through `NAV.go`: Card on the bar or sidebar, Process through Menu on a phone and in the sidebar on a desktop. It also checks that the Process seat is lit where the reader sees it and that the method is drawn in the Process view. | 62 passed, 1 failed → 164 passed, 0 failed |
| Player props (`tools/props/props_ui.e2e.js:171`) | `.research-sub button[data-sub="pprops"]` hidden | The suite assumed a Research landing. A reader now lands on the Overview, inside which Research's row is not drawn. | Research seat, then Props, through `NAV.research`, at 1440 px and now at 390 px too | 0 passed, 1 failed → 140 passed, 0 failed |
| Funnel (`tools/funnel/first_run.e2e.js:282`) | the first-run panel's controls not visible | **A product regression, not a selector.** See §1a. | Production: a new account's first weeks land on Research. Test: the panel must be *drawn* in the view the reader lands on. | the CI run threw at its 1280 px preferences step. Against the old code the updated suite reads 9 passed, 7 failed; with the fix, 57 passed, 0 failed |
| Matchup graphics (`tools/sport_graphic/sport_graphic.test.js:230`) | "loads the module after the renderer, with the renderer's version" | #807's merge moved `edgedesk_game_graphic.js` to `?v=20261026ros2` and left `edgedesk_sport_graphic.js` at `sg1`. The module fills the renderer's layout, so a cached module could meet a newer renderer. | `app.html`: the module joins the renderer's stamp. The browser suite now proves the contract from a real load (§1b). | 1501 passed, 1 failed → 1502 passed, 0 failed. Browser: 56 passed, 1 failed (red on the old stamps) → 57 passed, 0 failed |
| Simulator suites (`simulator/tests/ui.e2e.ts`) | "a failed refresh keeps the last good results on screen" | The fixture failed the *second* `sim_public_status` call. The Overview landing makes the first, so the Simulator's own first load failed instead of its refresh. | The failure is armed once the Simulator has drawn its first results, whatever else read the door. | 144 passed, 1 failed → 145 passed, 0 failed |
| Signal Center tests (`tools/signal_center/ui.e2e.js`, the landing cases #807 added) | "the Overview's Signals tile reads the server's own 24-hour count" | The tile's label is uppercased by CSS, and `innerText` reads what is drawn, so it saw "SIGNALS 53 published in 24 h" against `/Signals 53 …/` | Read each part of the tile as text, as `journey.e2e.js` already does; the expected count and wording are unchanged | 125 passed, 1 failed → 126 passed, 0 failed |
| Market Foresight tests (`tools/foresight/isolation.test.js`) | "no file outside the allowlist references Market Foresight" | `docs/research-os/REPORT.md` named the `mf_*` status door | The sentence names "the Foresight service's status door", as DESIGN.md already does. The allowlist is unchanged: widening it would weaken an integrity guard. | 35 passed, 1 failed → 36 passed, 0 failed |

### 1a. First-time onboarding (Funnel)

What a brand-new trialing account saw after #807, verified in Chromium at
1280 and 390 px:

* it landed on `#overview`, both after Setup and on a load with nothing saved;
* "Here's what EdgeDesk found today." was mounted inside the **hidden**
  Research view;
* the welcome modal was suppressed and the six-step onboarding modal held,
  both for that panel;
* yet `first_run_viewed` was recorded and `first_run_seen_at` stored.

A new account got no onboarding at all, and the funnel counted a view that
never happened. The old suite passed its first check because it read the
panel's text from the DOM, not from the screen. Its innerText was the
unrendered `Buffalo BillsWATCHNFL`, which is what failed next.

**Owner decision (2026-10-26).** An account in its first two weeks that has
not hidden the panel lands on Research, where the panel is. Everyone else
lands on the Overview, as designed.

* **The rule:** `edFirstWeek()` in `lib/edgedesk_workspace_ui.js`.
* **Where it applies:** Setup's hand-off and the boot's "nothing saved"
  branch.
* **What it reads:** the panel's own 14-day window and its own device record
  (hidden, or every step done more than a day ago).

The suite now checks that:

* the panel is drawn in the view the reader lands on;
* that view is Research, with its seat lit;
* Setup's Enter hands a new account to Research with the panel drawn;
* an account past its first weeks lands on the Overview.

`navigation.e2e.js` and `navigation.test.js` hold the same rule. The unit
checks cover the 14-day boundary, a hidden panel, all steps done, signed
out and an unreadable session.

### 1b. The Matchup Graphics script contract

`tools/sport_graphic/sport_graphic_ui.e2e.js` now reads, from the browser
loading `app.html`:

* the two script responses (one each, both 200) and their `?v=`, which must
  match;
* the order in which the browser defines `EDGameGraphic` and then
  `EDSportGraphic`;
* that the module finds the renderer's `layout`.

The static check in `sport_graphic.test.js` (order and equal stamps in the
markup) is unchanged.

## 2. Passing, but asserting the old navigation: updated

| Suite | What was outdated | Now |
|---|---|---|
| `simulator/tests/ui.e2e.ts:242` | "the Simulator seat is in the bottom bar and active". At 390 px it is in Menu. The check passed because it read a class on a hidden button. | Reached through Menu (390) or the sidebar (1440), and `seatShown` |
| `tools/portfolio/portfolio_ui.e2e.js` | its own copy of a seat helper; seat-lit checks that read a class whether drawn or not | `NAV.go`, `NAV.seatShown` |
| `tools/app/navigation.e2e.js` | its own copy of the seat helper; "the seven seats" heading over a ten-seat check | `NAV.go`; heading corrected; two first-week cases added |
| `tools/research_os/journey.e2e.js` | its own copy of the seat helper | `NAV.go` |
| `tools/signal_center/ui.e2e.js`, `tools/slate/games_ui.e2e.js`, `tools/guide/guide_ui.e2e.js` | direct `.bottomnav button[data-v=…]` clicks | `NAV.go` |
| `tools/app/navigation.test.js`, `tools/research_os/research_os.test.js` | pinned the old boot string; the order checks anchored on it | the new boot branch, plus `edgedesk_workspace_ui.js` in the list that must load before the boot |

## 3. Reviewed, valid under the new navigation: unchanged

* **Deep links to the view under test.** These do not depend on the landing:
  * `#research/…` and `#game/…`: `decision_ui`, `cbase_ui`, `fbs_board`,
    `market_structure_ui`, `price_refresh`, `quote_ev_ui`,
    `game_research_ui`, `matchup_props`, `ref_flags_ui`, `altitude/ui`,
    `engine_ui`, `linemaker_ui`, `nba_ui`, `intel_ui`. The last four's
    "Other seat names …" checks follow a hash that opens Research.
  * `#simulator/…`: `ncaam_ui`, `ncaaw_ui`.
  * `#portfolio`: `bet_history`, `bet_import`, `juicereel_ui`,
    `sharpsports_ui`.
  * `#games`: `grades_ui`, `sport_graphic_ui`.
  * `#signals`: `signal_center/ui`.
* **A bare `/app.html`, then a route or an overlay.** These do not depend on
  the landing:
  * the AI desk drawer: `chat`, `desk_ui`, `intelligence/journey`,
    `quant_ui`;
  * the onboarding modal: `personal_ui`;
  * hosts injected by the suite: `opportunity_ui`;
  * `researchGo()`: `baseball_ui`, `cbb_ui`;
  * `show('record')`: `pnl_ui`, `signal_pnl_ui`.
* **Suites that hold the new landing themselves:**
  * `navigation.e2e` and `research_os/journey`;
  * `signal_center/ui`'s fresh-reader cases, whose sessions carry no
    creation date, so the first-week rule does not apply;
  * `slate/games_ui`, which seeds a returning Research reader.
* **Pages other than `app.html`:** `checkout_flow`, `foresight/pages`,
  `admin_funnel`, the growth pages, `home/landing`, `content_engine`,
  `signal_center/pages`, `performance_ui`, `research_ui` (NCAAM).
* **Script-order contracts, all real dependencies:** `cfb_terminal/read`,
  `football/game_brief`, `games/franchise`, `portfolio/bet_import`,
  `portfolio/portfolio_ui`, `ufc/fight_center_ui`, `validation/ui`,
  `research_os`.

`baseball_ui.e2e.js` and `cbb_ui.e2e.js` run only in `games-sql.yml`, which
does not start on an `app.html` change, so #807 never ran them. They were
run here against a real PostgreSQL 16: 245 passed and 59 passed, on `main`
and on this branch.

## Found, outside this change

`signals/index.html` and `admin/signals/index.html` still load
`edgedesk_game_graphic.js?v=20261025pd1`. That file changed in b9846a46
(before #807), so a returning browser on those two pages can keep the old
renderer. It is not a navigation issue and is left for its own change.
