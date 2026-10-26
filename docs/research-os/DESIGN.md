# Research OS — design

The terminal (`app.html`) is one research workspace. A reader starts on the
Overview, opens a game's research, and carries that game, by its identifiers,
into Signals, Market Foresight, the Simulator, the AI desk, My Card, Portfolio
and Performance, without finding it again.

This change adds **no** new data source, pick table, portfolio store,
simulation engine, scoring pipeline, AI backend, auth system, framework or
Foresight calculation. Each new view reads what an existing feature already
publishes, through that feature's own access checks, and links to the feature
that owns the answer. The audit that preceded it is
[`AUDIT.md`](AUDIT.md); the verified results are in [`REPORT.md`](REPORT.md).

Principles the code holds to (each one has a test in
`tools/research_os/research_os.test.js` or `tools/research_os/journey.e2e.js`):

* **Identifiers, never names.** A game travels as the slate id
  (`nfl:espn:401873009`) and its research key (`nfl|2026_07_DAL_PHI`). Team
  names are display labels and nothing joins on them.
* **No number is made up.** Every count is a count of rows that exist. A source
  that cannot be read says so where its number would be. A layer that is not
  deployed reads "not deployed", never zero.
* **Order is not advice.** No list is ordered by a model–market difference, a
  signal score or an edge.
* **Shadow stays shadow.** Nothing in the terminal can change Market
  Foresight's mode or Signal Center's.
* **Model accuracy and a reader's money are never combined.**

## 1. Navigation and the shell

`lib/edgedesk_shell.js` (`window.EDShell`), `lib/edgedesk_shell.css`, the
`<nav class="bottomnav" id="edNav">` block in `app.html`.

One navigation element, two shapes:

| Width | Shape |
|---|---|
| ≥ 1024 px | a persistent **sidebar** (236 px). Groups: Research · Your workspace · More. |
| < 1024 px | a **bottom bar** with the five most-used places (Overview, Research, Signals, Card, Portfolio) plus **Menu**. Menu opens the full list as a modal sheet (`role=dialog`, `aria-modal`, focus trap, Escape, scrim). |

Every seat is still a `.bottomnav button[data-v]`, and `show(v)` is still the
one router. So the click binding, `aria-current`, analytics
(`primary_nav_<seat>`), the first-run guide's wrappers and every existing test
selector keep working. Seats are at least 44 px tall.

### Navigation map

| Group | Seat | Deep link | Answers |
|---|---|---|---|
| Research | **Overview** (new, the default landing) | `#overview` (`#home`, `#dashboard` alias) | What deserves my attention today? |
| Research | Research | `#research/<module>[/<entity>]`, `#game/<nfl\|cfb>/<id>` | Why: the full research on a game |
| Research | Signals | `#signals…` | What changed, and is the evidence still valid? |
| Research | **Market Foresight** (now in the app) | `#foresight`, `#foresight/game/<sport>:<event>`, `#foresight/model/<source>:<key>[/<version>]` | Which forecasts preceded market movement? |
| Research | Simulator | `#simulator[/<sport>]` | What the season looks like in simulation |
| Your workspace | My Card | `#card` | What I am considering |
| Your workspace | Portfolio | `#portfolio[/<tab>]` | What I actually placed |
| Your workspace | **Performance** (new) | `#performance` (`#record`, `#pnl` keep opening Record) | How the models did, and how I did — separately |
| Your workspace | Process (under Performance) | `#process` | How I decide |
| More | More | `#more` | Account, settings, Collective, news, terms |

Compatibility:

* Every pre-existing hash still resolves to the same view:
  `#signals`, `#research/…`, `#game/…`, `#card`, `#portfolio/…`, `#process`,
  `#simulator/…`, `#record`, `#pnl`, `#ledger`, `#bets`, `#props`, `#edges`,
  `#settings`, `#collective`, `#news`, `#terms`, `#ai`.
* `/foresight/` (the public page) is unchanged; its links still work, and in
  the app they are rewritten to in-app hashes.
* Record keeps its own view; Performance is now its owner in the navigation.
* A seat tap pushes a history entry (it used to replace the current one), so
  Back and Forward walk the reader's own path.
* Landing, in order:
  1. A deep link wins.
  2. A new account sees Setup once. Setup hands over by rule 4.
  3. Otherwise the remembered tab.
  4. With none, `EDShell.landing()` decides. A new account (its first 14
     days, before it puts the first-run panel away) starts on Research, where
     `lib/edgedesk_first_run.js` puts "Here's what EdgeDesk found today" above
     the board. Every other reader starts on the Overview. The window is the
     first-run module's own, and `tools/research_os/research_os.test.js`
     holds the two equal. The welcome modal and the six-step onboarding
     modal stand aside for that panel, so an Overview landing left a new
     account with no onboarding at all (#807; owner decision 2026-10-26).
     `tools/funnel/first_run.e2e.js` holds it in a browser.

Keyboard: Ctrl/⌘ K or `/` opens search. `/` is ignored while typing or while a
visible dialog is open.

## 2. The research context

`lib/edgedesk_context.js` (`window.EDContext`).

```
{ sport, gameId, researchKey, module, entity, season, home, away, start,
  marketType, marketSide, selectedModel, researchTimestamp }
```

* **Built only from ids the slate already carries.** `fromSlateEvent`,
  `fromResearchKey`; `p4` keys map to `cfb`.
* **`links(ctx)` returns only what each feature can answer for that sport:**
  the research page (NFL, FBS), Signals, Market Foresight (NFL and FBS
  pregame), and the Simulator (the sports its registry lists).
* **The AI desk gets the same ids** through the existing `edScreenSet()`; the
  server re-verifies them against the published card.
* **No account data, no price, no model number.** So a context can ride a URL
  hash and device storage without exposing anything. Sensitive data is never
  put in a URL.
* **Recently viewed:** up to 12 games, this device only
  (`edgedesk_recent_games_v1`).
* **"Changed since your last visit"** compares two snapshots this device
  actually stored: the reference from the *previous* browser session, and now.
  - What it compares: the model's fair line, the captured quote and its
    capture time, and the game status.
  - A quote counts as moved only from the same book and market, at two
    different capture times. Anything else is "not comparable", never
    movement.
  - The watchlist's server-side seen-hash (`my_watchlist.changed`) stays the
    authority for saved games.

## 3. Overview

`lib/edgedesk_overview.js` (`window.EDOverview`), `#overviewHost`.

| Section | Source | Notes |
|---|---|---|
| Header + sport filter | the slate the Research strip already loaded (`EDGamesUI.snapshot()`) | one fetch shared with Research |
| Ask EdgeDesk | the existing AI drawer (`edAsk`) | suggestions are only questions the desk has a route for |
| Today's summary | slate + the doors below | tiles: games today, with research, priced now, Signals, saved games that need a look |
| Research queue | slate, the reader's watchlist (`my_watchlist`), Card entries, recently viewed | tabs: Today · Next 7 days · Changed · Saved · Recent |
| Captured price changes | the quotes already on the slate rows, against this device's last-visit snapshot | same book, same market, two capture times; otherwise "not comparable"; none before a first earlier visit |
| Signals | `sc_status()`, `sc_pulse(24)` | counts only; "Not live" when not deployed; "In review" in shadow |
| Simulator | `sim_public_status()` | what is published, when and by which model version; no probability |
| Market Foresight | the Foresight service's `status()` | mode and last run only |
| Your workspace | Card entries, the watchlist, recently viewed | counts link to their owners (Card, watchlist, Portfolio, Performance); "saving a game or adding it to your Card never records a bet" |

**Queue order** (documented, deterministic, not a recommendation):

1. status: live, scheduled, final, then postponed or canceled;
2. the reader's interest: games on the watchlist or the Card first;
3. research completeness (a research page, a model projection, a current
   price), most first;
4. start time, then slate id.

A model–market difference is shown only between the same contract (full-game
home spread, in points), labelled "model not tested against the market", and is
**never** used to order.

All reads are quiet (`EDShell.rpc/get`). They never paint the header's System
pill, and they are memoized: Signals 5 min, Simulator 10 min, watchlist 2 min.

## 4. The game workspace

`lib/edgedesk_game_view.js` gained one hook (`opts.workspace`). `app.html`
passes a **"Keep researching this game"** rail (`EDContext.railHTML/railFill`,
`gw-` classes) under the market section:

* **Signals** for the game's sport.
* **Market Foresight's preview** (the Foresight service's `game()` counts) and
  a link to the in-app record.
* **The Simulator** on the game's sport, when it covers it.
* **Ask AI** about this game, through `edAsk` with the game's ids.
* **Add to Card**, through `EDDecisionUI.addGame`, the existing path.
* **Record a position**, through `edRecordPosition`, the existing Portfolio form.

## 5. Market Foresight in the terminal

`foresight/service.js` (always loaded, small), `foresight/app.js` and
`foresight/app.css` (loaded on first use).

* **Isolation.** Foresight is kept isolated by its own test, so nothing outside
  `foresight/` and `app.html` names it. The service registers itself with
  `EDShell.provide('foresight', …)`, and the Overview and the game page ask
  `EDShell.service('foresight')`. Without the service they draw nothing.
* **The same page, mounted in the app.** The in-app record is the public page's
  own controller (`foresight/foresight.js`, now exported as a boot function,
  with an in-app option) mounted in `#mfHost`:
  - the same database doors and the same reader session;
  - the same renderers and the same frozen methodology.
  - Only the routing differs: in-app hashes instead of `?game=`.
* **The public page is unchanged.** `/foresight/` still auto-boots, and its
  share links still point to it.
* **Modes are the database's.** Shadow shows operators the record and everyone
  else "In review". `off` says so. Nothing here can change the mode. The go-live
  steps are in [`docs/market-foresight/GO_LIVE_CHECKLIST.md`](../market-foresight/GO_LIVE_CHECKLIST.md).

## 6. Card, Portfolio and Performance

* **My Card** is what a reader is *considering* (unchanged).
* **Portfolio** is what they *placed* (unchanged).
* **Performance** (`lib/edgedesk_perf_hub.js`, `#perfHost`) is new. It shows
  two records on one page, side by side and never combined:
  - **EdgeDesk's models:** the public ledger's own summary
    (`/performance/data/summary.json`), with each sport's n and sample state,
    and nothing under its `min_n`. "Accuracy is not profit."
  - **Your record:** `portfolio_summary` all-time, under the reader's token,
    plus the Process Coach. Nothing EdgeDesk simulated or recommended is
    counted, and closing-line value is "not a realised result".

## 7. Search

`lib/edgedesk_search.js` (`window.EDSearch`). One box, opened from the header,
the Overview, Ctrl/⌘ K or `/`. It searches only what the page already holds:

* games in the slate's window (−1 to +15 days) and their teams;
* the reader's watchlist, Card entries and recently viewed;
* destinations, research modules, Simulator sports and tools;
* the reader's own positions, through `portfolio_search` under their token,
  after a pause, signed in only.

Nothing new is indexed and operator pages are never listed. The box is a
combobox and listbox: arrow keys, Enter, Escape and a focus trap.

## 8. The AI desk

No new provider or endpoint. The header's **Ask AI**, the Overview's box and
the game rail all open the existing drawer. The context is the existing
`edScreenSet({panel, sport, game_id, home, away, market})`, ids only.

## 9. Signals and the Simulator

Read, never changed. The Overview shows Signal Center's real state and pulse
counts, and the Simulator's real publication status. No threshold, ranking,
eligibility rule, simulation or model was touched, and navigation never starts
a simulation.

## 10. Data trust, access and security

* **No new table, policy, role or grant.** `supabase/research_os.sql` only
  registers four analytics event names (see `REPORT.md` §6).
* **Every read goes through an existing door, under the reader's own token.**
  The browser test reads those doors as a subscriber, a free account, an
  operator and anon, and checks what each gets back:
  - `community_is_entitled`, `sc_viewer_entitled` and `sim_viewer_entitled`;
  - the Foresight doors;
  - `my_watchlist` row security;
  - `portfolio_summary`, which returns the reader's own rows only.
* **No service-role key is used or shipped.**
* **No sensitive data in URLs.** Hashes hold public ids.
* **Admin places are never listed** in navigation or search.

## 11. Load

* The five new scripts load after `games_ui`, in dependency order:
  context → shell → overview → search → perf_hub, then the Foresight service.
  `EDShell.install()` runs once.
* Foresight's renderers and controller load only when the record is opened.
* The Overview reuses the Research strip's slate load and reads no second
  `slate.json`.
* Every new view binds its listeners once per host. The browser test counts
  listeners on `document`, `window` and every view host across a full loop of
  the navigation.

## 12. Rollback

Revert the change. Nothing it adds holds data, and old bookmarks resolve as
before. The SQL rollback (`supabase/research_os_rollback.sql`) removes only the
four event names that have no recorded events.
