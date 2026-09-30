# CFB board market integrity — Step 1 audit (read-only)

Audited 2026-09-30 against the repository at `94110a1` and the hourly Lab commit
of **19:36 UTC** (board build `2026-09-30T19:36:54Z`). Nothing in the pricing
model, ratings, calibration, EV math, thresholds, labels or ranking was touched.
Nothing was changed at all: this step adds read-only tools and this report.

| Tool | What it reads | Where the output is |
|---|---|---|
| `tools/football/cfb_board_audit.js` | the committed Lab quote ledger, `football/cfb_terminal/board.json`, `football/fbs/slate.json`, the schedule feed, every committed hourly snapshot of the board | [`audit_2026-09-30T1936Z.md`](audit_2026-09-30T1936Z.md) (+ `.json`) |
| `supabase/audits/cfb_board_market_audit.sql` | **production**: `public.signals`, `cfb.games`, `cfb.lines`, `cfb_lab_market_quotes`, `cfb_lab_event_map` — one `SELECT`, safe to paste into the SQL editor | run it; it prints sections A–G + spot checks |
| `tools/football/cfb_board_repro_app.js` | the board's own functions lifted verbatim from `app.html` | [`repro_app_2026-09-30.txt`](repro_app_2026-09-30.txt) |

Tests: `node tools/football/cfb_board_audit.test.js` (15 checks),
`node tools/football/cfb_board_audit_sql.test.js` (32 checks — runs the SQL audit
on a real PostgreSQL with the real `supabase/cfb_lab.sql` contract, inside a
`READ ONLY` transaction, against a replica seeded with one case of every failure
below; every one surfaces in its section).

**What could not be measured from here.** This environment's network policy denies
the Supabase host, so the live `signals` rows behind the in-app FBS board (and your
113-game / 83 NO MARKET screen) could not be read. Everything on the committed data
is measured below; everything on the live browser path is proved by running the
board's own code on seeded rows, and `supabase/audits/cfb_board_market_audit.sql`
gives the live numbers when you run it.

---

## 1. Where the board's market comes from

There are **two boards and three market paths**, and none of them agree on a rule.

| Board | Game list | Market source | Staleness clock |
|---|---|---|---|
| In-app FBS board (`app.html` `fbP4Render`) — the one with *Live line guard*, *Decision priced*, *Top Research Priorities* | cfbfastR schedule CSV (fallback `cfb.games`) → `EDFbs.buildSlate({now, lookaheadDays: 10})` | `public.signals` (Odds API via `supabase/functions/capture`, one row per event × market × selection × **point**, kept forever) joined **in the browser** by team names; fallback `cfb.lines` (CFBD, **no timestamp**) | `EDINTEL.quoteState` TTL ladder on each row's `last_seen_at` (5/15/45/90/180/360 min) |
| Research terminal (`research/cfb/`, `football/cfb_terminal/board.json`) | `football/fbs/slate.json` (the same 10-day window) | the Model Lab quote ledger `football/cfb_lab/ledger/<season>/quotes/*.jsonl` (ESPN → DraftKings, CFBD provider mean) | `lib/cfb_terminal.js latestPerBook`, 180 min, heartbeats **dropped** |
| (Lab / Postgres) | `cfb_lab_predictions` | `cfb_lab_market_quotes` (+ `cfb_lab_event_map`), where capture forwards Odds API per-book quotes | `cfb_lab_consensus_now` — only rows with a `game_id` |

Tables, views and functions involved (all paths repo-relative):

- **Capture** `supabase/functions/capture/index.ts` — `fetchOdds` (`:2292`), `cfbLabQuotes` (`:2809-2862`, builds `common` with **`game_id: null`, no `season`, no `week`** at `:2820-2825`, spread `home_line` = the *provider's* home outcome point at `:2834-2840`), `sendCfbLab` → `rpc/cfb_lab_ingest_quotes` (`:3452-3471`); `signals` / `book_quotes` / `signal_ticks` writes (`:3209-3760`).
- **Lab SQL** `supabase/cfb_lab.sql` — `cfb_lab_market_quotes` (`:309`), `cfb_lab_event_map` (`:381`), `cfb_lab_game_quotes()` (`:711`), `cfb_lab_ingest_quotes()` (`:897`; resolves `game_id` only from the event map, `:949-955`), `cfb_lab_consensus_now` (`:1425`, `game_id is not null` only).
- **Lab JS** `football/cfb_lab/market.js` (`quotesFromEspn` `:94`, `mapOddsEvents` `:168`), `lab_core.js` (`dedupeDecision` `:200` — a row only on **change**, plus 6 h heartbeats), `sync_supabase.js` (`pullQuotes` `:123-143`, filters **`season=eq.<season>`**).
- **Terminal** `football/cfb_terminal/build.js` (`loadLedger` `:199-214`, drops `is_heartbeat` rows at `:211`), `lib/cfb_terminal.js` (`latestPerBook` `:296`, `marketView` `:308`).
- **Browser** `app.html` — `fbSignals` `:47687`, `fbMarketFromEvent` `:47729`, `fbP4Market` `:50482`, `fbQevQuotes` `:53986`, `fbLiveLineGaps` `:48342`, `fbSystemHTML` `:57379`, "Decision priced" `:54306`; `football/fbs/fbs.js` (`TEAM_ALIASES` `:580`, `resolveTeam` `:700`, `matchesEvent` `:736`, `buildSlate` `:493`); `lib/edgedesk_quote_ev.js`, `lib/edgedesk_decision.js`, `lib/edgedesk_canon.js`, `lib/cfb_research_view.js`.
- **Slate builder** `football/fbs/build_coverage.js` (`normRows` `:157` — drops `start_time_tbd`).

---

## 2. The audit, this week (Tue 09/29 → Tue 10/06, America/Chicago)

From [`audit_2026-09-30T1936Z.md`](audit_2026-09-30T1936Z.md) (terminal board + Lab ledger):

| Measure | Value |
|---|---|
| rows on the board | **109** (59 are this week with a confirmed kickoff; **50** are not) |
| board NO MARKET | **98** · STALE flag 48 · MARKET FAULT 0 · DATA FAULT 1 |
| research labels | INVESTIGATE 3 · WORTH RESEARCHING 5 · MARKET ALIGNED 2 · NO MARKET 98 · DATA FAULT 1 |
| week games with a **current** DraftKings quote (reference rule) | **56** |
| board games shown with a market | **10** |
| **A** provider events pulled (24 h, kickoff in week) → matched → shown with a market | ESPN/DraftKings **56 → 56 → 10**; CFBD provider mean 26 → 26 → 5; **Odds API 0 → 0 → 0** |
| **B** unmatched ledger events / unresolved provider names | 0 / 0 (ESPN and CFBD are keyed by the schedule's own game id) |
| **C** Market field ≠ latest consensus (≥1 pt, other favourite, or a live line hidden) | **47** games (45 are "NO MARKET while the line is live") |
| **D** flagged stale / NO MARKET with a quote **< 60 min** old | **5** (and **46** within the 6 h window) |
| **E** board games outside the week / TBD / null kickoff | **50** (37 TBD placeholders at `04:00Z` = **FRI 11:00p CT**, 13 confirmed week-6 kickoffs) |
| **F** teams on the board more than once | **80** |
| **H** games that flipped priced ↔ NO MARKET across today's 8 hourly snapshots with no line move | **22** |

Your screen said 113 games / 83 NO MARKET; this committed build says 109 / 98. Same
failure, a different hour: 22 games flip between priced and NO MARKET hour to hour.

---

## 3. The seven bugs — reproduced, and the root causes

### 1 · Missing joins (games with live quotes show NO MARKET)

Four independent causes, in order of size:

1. **The Odds API per-book path is dead end to end.** Capture forwards every book's
   quote with `game_id`, `season` and `week` all NULL (`capture/index.ts:2820-2825`)
   and does no team resolution. `cfb_lab_ingest_quotes` can only fill `game_id` from
   `cfb_lab_event_map`, which is written only by the Lab's own mirror. The Lab's pull
   filters `season=eq.2026` (`sync_supabase.js:128`), which matches **none** of those
   rows. Evidence: `reports/2026/last_run.json` → `supabase_pull.quotes: 0`,
   `market.supabase.candidates: 0`; 0 `odds_api` rows in the ledger. So every
   sportsbook except DraftKings (via ESPN) is pulled from the provider and then
   dropped before either board sees it. This is "odds are pulled, the board says
   they aren't".
2. **False staleness hides the one book that does arrive** (bug 3 below). **45 of the
   98** NO MARKET rows have a live DraftKings quote under the same `game_id`.
3. **In-app board:**
   - `fbSignals` reads `signals` 5 pages × 1,000 rows, ordered by `event_id`
     (`app.html:47692-47699`). `signals` keeps a row per point forever (alternate
     ladders, look-ahead lines, old openers), so on a full slate the events whose ids
     sort last are silently cut off.
   - `matchesEvent` refuses a provider that lists home/away the other way round
     (`fbs.js:742-744`).
   - The event's teams come from its **first** row (`app.html:47701`).
   - The SQL audit's section B prints the live count of each (TRUNCATED, ORIENTATION,
     NAME MISS, DATE MISS, ID MISS).
4. **Names.** The browser resolver places every provider form of the ten games you
   listed, and every ESPN/CFBD name in the ledger (0 misses). Real misses do exist:
   - `"Cal Golden Bears"` (no alias) resolves to nothing.
   - With Kentucky off the card, `"Kentucky Wildcats"` resolves to **Kent State** through
     the alias `kent` (`fbs.js:619`).
   - There is no persistent unmatched-names log anywhere; misses are only counted in
     memory.

The ten games you named: all ten have a live DraftKings line in the ledger and all
ten are NO MARKET or flapping on the committed board. The ledger lines are OSU −14.5,
USF −6.5, JMU −18.5, ILL −10, UVA −2.5, SC −3, BYU −6.5, TTU −12.5, HAW −3 and
MIA(OH) −13.5 (see *G. Spot checks*).

### 2 · The "Market" field is not built from the latest quotes, and disagrees with "Best price"

- **In-app board.** Reproduced with the board's own code (`cfb_board_repro_app.js`).
  - The Market column (`fbMarketFromEvent`) prefers rows flagged `point_is_modal`. A
    modal flag set yesterday and still refreshed by one book outvotes seven books at
    the current number.
  - The price line (`EDQuoteEV.mainLineOf` + `best_ev_quote`) ignores the modal flag.
    It counts any point within 3.5 of an all-rows mode as "main". "Best price" is the
    best-**EV** quote, not the best odds.
  - Same rows, three answers: **Market VT −6.5**, price-line main **VT −3.5**,
    "Best price" **Pitt +6.5**.
  - When no captured row exists, the Market is `cfb.lines`, which has no timestamp,
    is often the opener, and whose sign is read through a per-browser switch (bug 4).
- **Terminal.** When no book is fresh, `marketView` still prints the median of stale
  books, **including the CFBD provider average**. For example:
  - `New Mexico State −1.9` = median(DK −2.5, CFBD −1.25).
  - `Nebraska −13.9` against a live DK −14.5.
- The research gap, the labels and *Top Research Priorities* read that field:
  - `fbWrCandidate` uses `mk.spread_line`, and its `/^captured/` test also matches
    "captured consensus (stale)".
  - `fbP4Counts` counts an untimed `cfb.lines` number as "with a market quote".
- Your numbers (VT −6.5, MICH −4.5, ALA −4.0, PSU −6.5) sit in the range of this
  week's declared openers and early lines (VT −5.5, MICH −8.5, ALA −3, PSU −7 per
  ESPN/CFBD). That is the signature of old point rows standing as "the market".

### 3 · False staleness

It is **not** `MIN(captured_at)`. Every "latest" in the code uses `max`/`desc`/`last_seen_at`; `min`/`asc` appear only for openers.

1. **Terminal: heartbeats are dropped.**
   - The Lab writes a quote row only when the line **changes**. An unchanged line gets
     a heartbeat row every 6 h (`lab_core.js:174-209`).
   - `build.js:211` throws heartbeats away, so a quote's age is the time since its
     last **change**.
   - Example: WKU @ NMSU, DK −2.5, last changed 25.5 h ago, heartbeat-confirmed
     **29 min** before the build → NO MARKET.
   - The same rule makes games flap hour to hour (Pitt @ VT: priced at 17:07, 18:07
     and 19:07, NO MARKET at 19:36).
2. **In-app board: a join to an old row.**
   - The quote list includes every point `signals` has ever held.
   - The stale reason shown is the **first** stale quote in list order
     (`edgedesk_quote_ev.js:783-791`).
   - Reproduced exactly: "**Clemson +7 — quote stale — captured 37184 min ago**"
     beside current Miami −16.5 rows. The −7 row is the look-ahead/opener point, last
     seen 25.8 days ago.
3. **In-app board: the clock outruns the data.**
   - Quotes are re-read only on reload or every 6 h (`FB_RELEARN_MS`,
     `app.html:61656`).
   - Their age is judged against `Date.now()` with a 5–45 min TTL near kickoff.

### 4 · Orientation / bad quotes

- `cfb.lines.spread` is turned into a margin by **a per-browser switch**
  (`fbP4LinesConv`, localStorage, `app.html:51637-51714`), not by a named team.
  - Reproduced in the SQL test: a `cfb.lines` row stored the other way round prints
    **"West Virginia −2.5"** for a game every book has at **Iowa State −3.5**.
  - The row's own best price is ISU −3.5.
- Browser event home/away come from the first `signals` row. Capture's Odds API
  `home_line` is relative to the **provider's** home team. A provider listing the
  game the other way round is either dropped (`matchesEvent`) or, once mapped, would
  be stored with the wrong sign.
- CFBD carries `T04:00Z` placeholder kickoffs for 4 games that ESPN has real times for.
- The ESPN reader *is* orientation-safe (three independent readings, dropped on
  disagreement; `football_record_sources.js:100-133`). The DraftKings ledger's signs
  are trustworthy.
- **Tulsa −25.5 exists in no committed data.** The live paths that can produce it are
  an alternate-ladder row under `spreads`, a zombie row, or `cfb.lines`. Section G of
  the SQL audit names which one.

> **Please check North Texas @ Tulsa.** DraftKings (via ESPN) currently has **Tulsa −1.5**,
> and its moneyline agrees: Tulsa −120, UNT +100. ESPN's *declared opener* was UNT −1.5.
> If your screen showed UNT −1.5 at the same time, that was a different book or the opener.

### 5 · Slate contamination

- Both boards use a **rolling 10-day window**, not a week: `FBP4_LOOKAHEAD_D = 10`
  (`app.html:49400`) and `slate.json` `lookahead_days: 10`.
- Both drop the feed's `start_time_tbd` column:
  - `build_coverage.js normRows`;
  - the browser's row mapping at `app.html:49915-49923`.
- The feed marks **37 week-6 games** TBD at `04:00Z` (midnight ET). That renders as
  **FRI 11:00p** in Central.
- They include every duplicate you listed: Georgia @ Alabama (Oct 10), North
  Carolina @ Pittsburgh, Syracuse @ Virginia, UCF @ Oklahoma State, Maryland @ Ohio
  State, Iowa State @ BYU, Wyoming @ San José State, and more.
- 50 of 109 rows are outside the week, and 80 teams appear twice.

### 6 · "Live line guard: a gap beyond the bound", with no reason

- `fbLiveLineGaps` fails when any game's |fair − market| > 21 (`app.html:48342-48381`).
- The system line only says "Live line guard: a gap beyond the bound"
  (`app.html:57385`).
- The full panel names up to three games, but not the quote behind the gap (book,
  point, age, source).
- The gaps come from the bad inputs above: modal/alt/zombie rows and flipped
  `cfb.lines`.

### 7 · "Decision priced" on alternate-ladder lines

- `decideSpread` builds its candidates from **every** clean quote, alternates and
  off-market points included (`edgedesk_decision.js:1338-1348`).
- An alternate is only capped at LEAN. When no main line ranks above LEAN, a long-odds
  alternate with a higher risk-adjusted EV wins; that is how New Mexico State −21.5
  +960 happens.
- The display (`app.html:54306-54308`) prints `dq` without checking `is_alternate`.

---

## 4. Proposed fix (Step 2) — for your approval

Additive migrations only. No existing quote, close, CLV or settled result is updated,
deleted or re-derived; new rules apply going forward and to the open slate; historical
mis-matches go to a findings table with the proposed correction, never applied.

1. **`supabase/cfb_board_integrity.sql`** (+ a timestamped copy in `supabase/migrations/`). It starts by snapshotting every table it reads into a dated backup schema and refuses to run twice into the same snapshot. Then:
   - `cfb_team_aliases` (provider name → `team_id`) seeded from `fbs.js`, every name the ledger has carried, the book "school + nickname" forms and every miss above.
   - `cfb_unmatched_names` (a log, never a silent drop).
   - `cfb_event_links`: match on the provider event id first, else on (home `team_id`, away `team_id`, kickoff ±36 h) with the orientation recorded. Links are also written to `cfb_lab_event_map` so the existing Lab pull sees them.
   - `cfb_market_spread_quotes` (`team_id`, `line`, `price` per side, written going forward).
   - `cfb_board_market(week_of)`, **one query**: the latest quote per book inside the freshness window, heartbeats included, then the sanity guard. A book more than 7 from the cross-book median, or naming the other favourite, is excluded and logged to `cfb_market_data_faults` as a DATA FAULT. Then the median consensus, and **best price from those same quotes**; staleness = now − `MAX(captured_at)` of the quotes used.
   - `cfb_board_week(week_of)`: confirmed kickoffs inside Tue→Tue Chicago only, TBD excluded.
   - `cfb_match_findings`.
   - Readiness metrics and a coverage alert (Step 4).
2. **Capture**: call a new `cfb_board_ingest_odds` RPC that links events and logs misses *before* handing quotes to `cfb_lab_ingest_quotes` with `game_id`, `season` and `week` filled. Fix the Lab pull's `season` filter.
3. **One shared market function** (`lib/cfb_board_market.js`) with a SQL parity test. The terminal build uses it (heartbeats count, openers excluded, one window). The browser board displays the RPC's row, so Market and Best price are the same quotes by construction. `cfb.lines` becomes an untimed reference, never the market.
4. **Week scoping** in `buildSlate` and `normRows`, with `start_time_tbd` kept.
5. **Decision priced** shows main-market lines only. The engine's selection is unchanged; an alternate selection is labelled, not shown as the price.
6. **Live line guard** names the game, the quote, the book, its age and its source.

### Decisions I need from you

1. **Freshness window.** Your message was cut off at "a quote counts as current if
   captured within the last 6 hours, **or since …**". The Lab only writes an unchanged
   line every 6 h (heartbeat), so a strict 6 h window can flap by a few minutes
   between heartbeats. If the rest of the sentence was "or since the last successful
   sync run that re-confirmed it", I would record that confirmation explicitly.
2. **"Opposite favourite" near pick'em.** As written, a −0.5 / +0.5 split is a
   DATA FAULT. I propose requiring both the book and the median to name a favourite by
   at least 1 point. It is configurable.
3. **Week boundary.** Tuesday 00:00 → Tuesday 00:00 America/Chicago keeps Monday
   games and Tuesday MACtion in their own week. OK?
4. **Production access.** I cannot reach Supabase from here. I will ship the
   migration with its backup step and a test run against a real PostgreSQL. The
   backup/PITR confirmation and a staging run are yours. To let me run the audit
   against live data, add `iattxbkbufslbauoumga.supabase.co` to this environment's
   allowed hosts.

---

## 5. The cover-probability width

See [`FINDING_cover_probability_sd.md`](FINDING_cover_probability_sd.md). In short: no
row of the model implies an 8-point SD at its own line. V1's σ is clamped to
14.63–15.68, and every conditioned PMF bucket is 14–17 wide. Readings near 8 come
from pairing the cover probability of one line with the gap to another, which is
bug 2. **Not changed; written up only.**
