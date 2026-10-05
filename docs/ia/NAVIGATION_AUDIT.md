# Authenticated app — information architecture audit (2026-10-04)

The authenticated product is `app.html` plus `lib/*.js`. This audit inventories
every destination a signed-in reader can reach, classifies each one against the
new five-destination model, and lists the dependencies that made a change
dangerous. It was written before any code moved.

## The model

| Destination | The reader's question |
|---|---|
| **Research** | What does EdgeDesk see? |
| **Card** | What am I researching / considering right now? |
| **Portfolio** | What have I actually done, and am I up or down? |
| **Process** | What does my history say about how I decide? |
| **More** | Everything secondary. |

Loop: Research → Decide (Card) → Track (Portfolio) → Review / Improve (Process).

## What the code actually holds (facts that decided the classifications)

* **Record is model performance, never the reader's.** Its first block is
  "Is the model up or down?" — EdgeDesk's graded recommendations, the flagged-edge
  closing-line record and the football model record (`record/pnl/`, `signals`,
  `record/football/`). The only reader input is the unit size used to print
  dollars. It must not merge into Portfolio.
* **Ledger is the reader's own bets** (localStorage `edgedesk_bets`, logged by
  hand or tracked from an edge, auto-settled against `signals`) **plus a
  system feed** of line moves on watched boards (`board_moves`). A hidden
  "Your book right now" exposure block (`#portfolio`) already lived inside it.
* **The reader's positions are split across stores that never read each
  other:** the Ledger (`edgedesk_bets`, device only), the Card's BET PLACED
  (`edgedesk_bets_placed_v1` + write-only `public.user_bets`), and the research
  journal (`public.research_journal`, decisions including passes).
* **There was no sportsbook connection or bet import** at the audit's base
  commit. Portfolio Phase A (#491/#494) landed on main while this change was
  in review: a server-backed book of every sportsbook bet and
  prediction-market position, with CSV import and a connector contract
  (`docs/portfolio-architecture.md`). It is now *the* Portfolio destination;
  see "Reconciled with Portfolio Phase A" below.
* **Process Coach did not exist yet** when this audit was written. The nearest
  real material: the journal's decision-quality analytics (`EDPersonal.analytics`,
  beat-close rate with a Wilson interval, CLV by league / market / reliability),
  the Ledger's CLV, and the Card's CLV on placed bets. The hidden Bet Discipline
  engine reads tables that are not in this repository. *Since then:* #504 built
  the Process Coach over `supabase/portfolio_journal.sql`, and it now leads the
  Process seat (see "Reconciled with Portfolio Phase A").
* **AI is an overlay**, not a view. `show('ai')` only opens the drawer. It had
  two entry points from outside the drawer (the nav seat and Edges receipts).

## Inventory and classification

### Bottom navigation (before: 7 seats)

| Seat | Classification | Where it goes | Why |
|---|---|---|---|
| Research | **KEEP PRIMARY** | Research | The research terminal; the product's front door. |
| Card | **KEEP PRIMARY** | Card | The active decision queue (BET / LEAN / WATCH / PASS, saved opportunities, exposure). Before the decision, not after. |
| Props (`pprops`) | **MOVE UNDER PRIMARY** | Research › Props | Props are a kind of research. Every `#playerprops/…` link and `show('pprops')` still lands on the same terminal. |
| Edges | **MOVE UNDER PRIMARY** | Research › Edges | An edge is an output of research. `show('edges')` and every "Edges" link still land there. |
| AI | **REMOVE FROM NAVIGATION** (contextual) | "Ask EdgeDesk" in the Research header, on game research, on the Card | A technology, not a workflow. The drawer, its desk, its research runs and every in-receipt "Analyze" button are unchanged. |
| Record | **MOVE TO MORE** (renamed) | More › Transparency › Model performance | It is EdgeDesk's record, not the reader's. Renamed so nobody reads it as their P&L. |
| More | **KEEP PRIMARY** | More | Reorganised into sections. |
| — | **NEW PRIMARY** | Portfolio | Portfolio Phase A's book (was a More row), with the old Ledger and the Card's placed bets as one section under it. |
| — | **NEW PRIMARY** | Process | Process profile over the reader's own graded history, with an honest "building" state. |

### Research sub-navigation (before: Desk · Football · UFC · Baseball · Stats · Lab)

| Tab | Classification | Where it goes |
|---|---|---|
| Football | **KEEP** (first) | Research › Football |
| Props (Player Props terminal) | **MOVE IN** | Research › Props |
| Edges | **MOVE IN** | Research › Edges |
| UFC | **MOVE** (deeper) | Research › Other › UFC |
| Baseball | **MOVE** (deeper) | Research › Other › Baseball |
| Stats | **MOVE** (deeper) | Research › Other › Stats (tool) |
| Lab | **MOVE** (deeper) | Research › Other › Lab (advanced / R&D) |
| Desk (research desk) | **MOVE** (deeper) | Research › Other › Desk. Overlaps Edges' "Today's desk" — see concerns. |

Football's own segments, reordered for football readers:
**NFL · CFB · Players · Rankings · Rosters** (were NFL Matchups · CFB Rosters ·
FBS Football · Players · Rankings — "FBS Football" *is* the college matchups
board and is now labelled CFB; "CFB Rosters" became Rosters and moved last).

Hidden research panels: `v-cfb` (legacy, already aliased to Football) — keep the
alias; `v-props` (season-rate projections, surfaced inside Stats) — **REMOVE
FROM NAVIGATION** (it already had none); `#research/props` now lands on the
Player Props terminal, which is what anyone following a "props" link wants.

### More (before: Collective · Ledger · News, then System & help)

| Row | Classification | Where it goes |
|---|---|---|
| Collective | **MOVE TO MORE** (kept) | More › Community & tools |
| Ledger | **MERGE** | Portfolio › *Tracked from EdgeDesk* (tracked prices, bets logged by hand, quick add, exposure, CLV). The system line-move feed → Research › Edges › Market activity. |
| Portfolio (Phase A, More row) | **KEEP PRIMARY** (promoted) | Its own seat; More no longer lists it. |
| News | **MOVE** + contextual | More › System › News & moat alerts (it is the structural-rule early-warning feed behind Faults), plus a contextual "Relevant news" section on college game research. The `news` pipeline is untouched. |
| Model & data health | **KEEP** | More › System |
| Faults | **KEEP** | More › System (and the header status control) |
| Methodology | **KEEP** | More › Transparency, plus "How is this calculated?" links on Portfolio and Process |
| Data sources | **KEEP** | More › Transparency |
| Settings & account | **KEEP** | More › Account (profile, billing, display, odds format, preferences) |
| EdgeDesk Games | **KEEP** | More › Community & tools |
| Terms & disclaimer | **KEEP** | More › Legal |
| Model performance (was Record) | **MOVE TO MORE** | More › Transparency |

### Views with no seat

| View | Classification | Note |
|---|---|---|
| Settings | **KEEP** | More › Account and the avatar menu. Portfolio-connected accounts are **not** here: they belong to Portfolio › Accounts. |
| Terms | **KEEP** | More › Legal and the footer link. |
| Pulse (`v-social`) | **HIDE** (unchanged) — delete candidate | Unreachable since before this change; its `social_*` tables are not defined in this repository. Not deleted: production tables cannot be verified from here and the route is held by tests. |
| Discipline (`v-discipline`) | **HIDE** (unchanged) — delete candidate | Unreachable; reads ~11 tables not in this repository. Its intent (process over outcome) is what Process now delivers from data that does exist. Not deleted for the same reason. |

### Features inside views

| Feature | Classification | Where |
|---|---|---|
| Ledger "Your bets" (`edgedesk_bets`) | **MERGE** | Portfolio › Tracked from EdgeDesk (open and settled apart) |
| Card BET PLACED bets | **MERGE (read)** | Portfolio › Tracked from EdgeDesk; still recorded from the Card |
| Ledger quick add + custom bet form | **MOVE** | Portfolio › Tracked from EdgeDesk ("Track or log") |
| Exposure "Your book right now" | **MOVE** | Portfolio › Tracked from EdgeDesk |
| Ledger desk summary | **DELETE** (duplicate) | Its element; the book's Overview answers "am I up or down?" |
| Market activity (`board_moves`) | **MOVE** | Research › Edges, collapsed |
| Record P&L, Verified P&L, proof layer, football model record | **KEEP** | More › Model performance (unchanged content) |
| Journal + Decision quality (My research drawer) | **KEEP** + link | Drawer unchanged; Process links to it as its deep "decision journal" section |
| Watchlist (stars) / Saved research | **KEEP** + link | Linked from the Card ("Watching") |
| Today's research run (3 buttons for one action) | **KEEP** | Unchanged — see concerns |
| Bet import / sportsbook connection | **KEEP** (Phase A) | Portfolio › Import and › Accounts. No platform syncs yet, and the page says so. |
| Header (logo, System status, bell, avatar) | **KEEP** | Compact; no navigation added to it |
| Responsible-gambling bar | **KEEP** (compacted) | One line on phones; every element kept; helpline is now a tap-to-call link |

### Things this audit decided NOT to delete

Nothing working was deleted. Every view id, loader and route that existed
before still exists; every old link resolves (see the route map in the PR).

## Dangerous dependencies found before changing anything

1. **The AI drawer injects its own nav button** when no `[data-v="ai"]` seat
   exists (`app.html`, end of the EDAI block). Removing the seat without removing
   that fallback would have put a sixth button back at runtime.
2. **`lib/edgedesk_first_run.js` wraps `window.show` / `window.researchGo`** to
   emit `board_viewed`. Navigation must keep calling those globals by name.
3. **`trackSignal` navigated to `show('ledger')`**, and five call sites test
   `$('v-edges').classList.contains('hide')` as "Edges is on screen" (one of them
   drives a 60-second auto-refresh). Once Edges is a Research panel that test is
   only true if panels are hidden when the reader leaves Research.
4. **`researchGo` rewrites the hash** to `#research/<sub>`. Player Props owns
   `#playerprops/…`; folding Props into Research must not clobber it.
5. **Remembered state:** `lastTab` / `defaultTab` hold `pprops`, `edges`,
   `ledger`, `record`, `news`, `faults`, `collective` for existing readers.
6. **Analytics names are allow-listed twice** — `EDTrack.CLIENT` and the
   `user_event_kinds` registry in `supabase/funnel.sql` — and a parity test
   holds them equal. New events need both, and the SQL must be re-applied in
   production before they record.
7. **Tests that encode the old bar:** `tools/app/navigation.test.js`,
   `sports_config.test.js`, `research_landing.test.js`, `operator_gate.test.js`,
   `tools/props/props_ui.e2e.js` (clicks the Props seat) and
   `tools/record/pnl_ui.test.js` (needs `#recPnlWrap` directly under the Record
   header).
8. **The Record share link `#receipt=<id>`** only opened when the landing tab was
   already Record, and boot overwrote it — a real deep link that did not work.

## Reconciled with Portfolio Phase A

Phase A arrived on main with a More row, a `#portfolio` link and the seven-seat
bar untouched. This change keeps every line of its engine, importer, connector
contract, SQL and page, and changes only where it sits and what surrounds it:

* **Seat, not More row.** `show('portfolio')` → `pfOpen()` mounts the same
  `EDPortfolioUI.show(#pfoHost)`; `#portfolio/<tab>` opens a tab
  (overview · open · history · analytics · accounts · import).
* **One Portfolio.** The old Ledger is no longer a page: its tracked prices
  and the Card's placed bets are one folded section under the book, *Tracked
  from EdgeDesk*. They are kept apart from the book on purpose: they are the
  positions graded against a closing line, which Process reads; Phase A's
  positions carry P&L but no closing line yet.
* **The empty book says how to build one** — "Build your portfolio", Connect
  accounts first, then Import a CSV or record by hand — instead of
  "No positions yet".
* **Setup's "your portfolio" step hands over to it**: Import a CSV → Portfolio
  › Import; Connect accounts → Portfolio › Accounts.
* The pre-merge prototype of a device-only Portfolio (its own CSV import,
  overview and calendar) was dropped in favour of Phase A's; the position
  normaliser Process needs became `lib/edgedesk_positions.js` (`EDPositions`).
* **The Process Coach is the Process seat, not a Portfolio tab.** #504 shipped
  it as Portfolio › Coach. Portfolio answers "what do I hold and how did it go",
  and Process answers "how do I decide", so the Coach moved to Process.
  * **The page.** Process mounts the same Phase A controller coach-only
    (`EDPortfolioUI.show(#pcoHost, { tabs: ['coach'], bare: true, name:
    'Process' })`). It shows the Decision Grade, process against outcome, leaks,
    strengths, timing, edge capture, rules, experiments and the weekly Film Room.
  * **Under it.** What EdgeDesk tracked (tracked prices and Card bets graded
    against the close, `lib/edgedesk_process.js`) is folded underneath, as
    Portfolio folds it under the book.
  * **Links.** The Overview's Decision Grade links to Process. Process's
    "Connect accounts" and "Import a CSV" lead back to Portfolio, through a
    `pfo-route` event the app routes.
  * **An empty book** asks for nothing from the server and says
    "Nothing to grade yet".
  * **Old links.** `#portfolio/coach` and `pfSetTab('coach')` land on Process.
    Each page of the Coach has its own link, `#process/<page>`.

## Old → new route map

Every row is held by `tools/app/navigation.e2e.js` in a real browser.

| Old link or call | Lands on | Seat lit |
|---|---|---|
| bottom-nav **Props** · `show('pprops')` · `#playerprops[/…]` · `#props` | Research › Props (`#playerprops/…` kept, owned by the terminal) | Research |
| bottom-nav **Edges** · `show('edges')` · `#edges` · `#research/edges` | Research › Edges | Research |
| bottom-nav **AI** · `show('ai')` · `#ai` | the EdgeDesk Intelligence drawer, over whatever is open | unchanged |
| bottom-nav **Record** · `show('record')` · `#record` · `#pnl` | More › Model performance | More |
| `#receipt=<id>` (Record share link) | Model performance, receipt opened — now also on a cold load | More |
| More › **Ledger** · `show('ledger')` · `#ledger` · remembered `lastTab:'ledger'` | Portfolio (`#portfolio/tracked` opens its section) | Portfolio |
| More › **Portfolio** (Phase A) · `#portfolio` | Portfolio | Portfolio |
| More › News · `show('news')` · `#news` | More › System › News & moat alerts | More |
| `#research/props` | Research › Props (was Stats) | Research |
| `#research/football|ufc|baseball|stats|lab|rdesk|cfb|tennis/…` | unchanged (tennis → Football, cfb → Football) | Research |
| `#card` | Card | Card |
| `#settings` (newsletter link; was ignored) | Settings | More |
| `#faults` · `#collective` · `#terms` | the same views | More |
| `show('social')` · `show('discipline')` (hidden before this change) | Research › Edges | Research |
| new: `#portfolio/overview|calendar|journal|open|history|analytics|accounts|import|tracked` · `#process` · `#more` | those destinations | themselves |
| `#portfolio/coach` (#504's Coach tab) · `pfSetTab('coach')` | Process, on the Coach page last read | Process |
| new: `#process/report|leaks|strengths|timing|edge|rules|experiments|film` | that page of the Process Coach | Process |

## Reading the navigation evidence

Every seat tap is `primary_nav_<seat>`; everything reached from inside a
destination is `secondary_nav_opened` with `event_properties->>'entity'`
naming it (`more:collective`, `research:props`, `portfolio:calendar`,
`process:timing`, `card:watch`, `ai:game`, `setup:skip` …). The server keeps
one row per session per seat (per entity for secondary), so counts read as
"sessions that reached it". gtag receives every tap for raw frequency.

```sql
-- share of signed-in terminal sessions that reached each destination, last 30 days
with s as (
  select distinct session_id from public.user_events
  where event_name = 'terminal_opened' and created_at > now() - interval '30 days'
)
select coalesce(e.event_properties->>'entity', e.event_name) as destination,
       count(distinct e.session_id) as sessions,
       round(100.0 * count(distinct e.session_id) / nullif((select count(*) from s), 0), 1) as pct_of_sessions
from public.user_events e
where e.session_id in (select session_id from s)
  and (e.event_name like 'primary_nav_%' or e.event_name = 'secondary_nav_opened')
group by 1 order by sessions desc;
```

A destination that almost no session reaches is a candidate to remove; a
secondary one that most sessions reach is a candidate for more room. Neither
is decided by this query alone — it is the evidence the decision needs.
