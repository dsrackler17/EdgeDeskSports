# Player Props — the audit before building

What existed on 2026-09-29, before the Player Props terminal. Every row is a
file the new product reads, reuses, or deliberately leaves alone. The short
version: EdgeDesk already had the **arithmetic** a prop bettor needs (odds,
de-vig, EV, units, freshness, validation) and the **game context** (NFL and FBS
slates, weather, injuries, QB starters). It had **no prop prices, no
per-player game logs committed, no prop projection, and no prop grading.**

## 1. Available sports data

| Data | Where | State for props |
|---|---|---|
| NFL schedule, kickoff, consensus spread/total, roof, surface | nflverse `games.csv` (browser + `tools/football/fetch_nfl_feeds.js`) | reusable; game id `2026_04_PIT_CLE` |
| NFL game model (fair margin, fair total, forecast, QB starters) | `football/nfl/slate.json` (`tools/football/build_nfl_slate.js`) | reusable for team implied points and weather |
| NFL team defence (EPA/play, pass EPA/db, rush EPA/att, explosive rates, sack rate) | `football/nfl/slate.json teams[].ratings/ranks`, `football/identity/teams/*.json` | reusable, but no *by-position* allowed numbers |
| NFL player week stats | nflverse `stats_player_week_<season>.csv` — fetched into a gitignored cache, **only QB columns read** | **gap**: no committed per-player logs |
| NFL snaps, depth charts, weekly rosters, play-by-play | nflverse `snap_counts`, `depth_charts`, `roster_weekly`, `pbp` — pbp and depth charts downloaded for QB1 only | **gap**: snap share, RB/WR depth, red-zone and goal-line usage never extracted |
| NFL injuries | `football/injuries/nfl_<season>.json` (every 6 h, `injury-sync.yml`) — latest week per team, status + practice | reusable as is |
| CFB schedule + game model | `football/fbs/slate.json` (ESPN ids, fair margin/total, QB starters) | reusable |
| CFB player box | sportsdataverse ESPN player box (`football/data/build_box.js`) — **season totals only**, defence/special teams | **gap**: per-game pass/rush/receiving lines not emitted |
| CFB QB game logs | `football/fbs_epa/qb_epa_<season>.json` | reusable for QB context |
| CFB rosters / positions | `football/rosters/fbs_<season>_espn.json` (ESPN athlete ids) | reusable for positions |
| CFB injuries / depth charts | `football/availability/current.json` — 0 official reports, ESPN depth endpoints 403/404 | **gap, external**: no CFB availability feed exists |
| Routes, route participation, YPRR | nowhere; nflverse `pbp_participation` is not published for 2026 | **gap, external** (§ Missing dependencies) |

## 2. Odds providers and identity

- **The Odds API** (`ODDS_API_KEY`). `supabase/functions/capture` asks the bulk
  `/v4/sports/{sport}/odds` endpoint for `h2h,spreads,totals` only; the event id
  is the provider event id; books are the provider's lowercase keys
  (`draftkings`, `fanduel`, …); there is no sportsbooks table.
- Player props exist only on the **per-event** endpoint
  `/v4/sports/{sport}/events/{eventId}/odds`; nothing calls it for props.
  `football/cfb_terminal/alternates.js` is the one per-event runner (alternate
  spreads): opt-in, budgeted, change-only JSONL ledger + browser feed — the
  template the prop capture follows.
- `public.model_props` (season-rate "projections" with a nominal line) is read by
  a hidden research panel (`#v-props`) and written by a deployed-only function;
  it carries no price and no id. It is left untouched.
- `supabase/functions/edgedesk_ai/_board.js` declares `player_prop`
  UNSUPPORTED and `_stake.js` lists `player_props` as CONDITIONAL (needs a
  validated artifact). Both remain true for the AI desk; the Player Props
  terminal carries its own, stricter, probability-source caps.

## 3. Existing EV / decision functions (reused, never duplicated)

| Need | Canonical home | Used by props as |
|---|---|---|
| American ↔ decimal, implied, break-even, proportional no-vig, `expectedRoi`, `priceAssessment` | `lib/research_core.js` (`EDResearch`) | the odds arithmetic |
| Push-aware fair odds | `lib/edgedesk_quote_ev.js` `fairAmerican` (when loaded); identical formula otherwise | fair price |
| Power / Shin de-vig | `lib/edgedesk_ev.js` `devig` (pure) | optional methods |
| Decision thresholds and unit ladder | `lib/edgedesk_decision.js` `config()` — BET edge ≥ 4.0 pp and EV ≥ 5 %, LEAN ≥ 2.0 pp, strong 7 pp / 10 %, units 0.25–1.00 rounded down, quarter-Kelly, source caps 1.00 / 0.50 / 0.25 | read at run time (props never fork the numbers) |
| Decision words and tones | `lib/edgedesk_vocab.js` | every label |
| Units → dollars, bankroll storage | `lib/edgedesk_bankroll.js` (`edgedesk_bankroll_v1`, `public.bankroll_settings`) and `EDDecisionUI.settings()` | stake and EV in dollars |
| Quote freshness | `lib/edgedesk_market.js` `freshness` (FRESH ≤ 30 min, STALE > 90 min) | stale warnings |
| Sample states, calibration (Brier / ECE), modes | `lib/edgedesk_validation.js` | performance & calibration |
| Units won | `lib/edgedesk_decision_track.js` `unitsWon` | grading |

`EDDecision.decide()` itself is **not** reusable for props: it rejects every
market other than spread/total/moneyline (`UNSUPPORTED_MARKET`), orients by
home/away, and caps totals at LEAN. Props get their own evaluator
(`lib/edgedesk_props.js`) that reads the decision engine's thresholds and unit
ladder from `EDDecision.config()` so the two cannot drift.

## 4. Player databases and ids

- NFL: gsis id (`00-0036389`) across stats, snaps (via pfr id in weekly
  rosters), depth charts, injuries, pbp. The props pipeline keys NFL players by
  gsis id.
- CFB: ESPN athlete id (`a:<id>` in `football/players/`), the same id in the
  sportsdataverse player box. The props pipeline keys CFB players by ESPN id.
- Sportsbook prop outcomes name players by display name only
  (`description: "Bijan Robinson"`), so quotes are matched to ids **within the
  two teams of the event**; an ambiguous or unknown name is kept but marked
  UNMAPPED and never priced.

## 5. Injury infrastructure

NFL: official report via nflverse every six hours (`status`, `practice`,
`injury`). The app loads it with `fetch('football/injuries/nfl_'+season+'.json')`.
CFB: no official feed (276 failed sources recorded); props state it.

## 6. Game ids, sportsbook ids, historical odds, settlement

- Game ids: NFL nflverse `season_week_AWAY_HOME`; CFB ESPN event id. Odds API
  event → game: NFL by team names + kickoff; CFB by
  `_intelligence.js joinSignalsToGames` over `football/cfb_lab/market.js
  scheduleGames` (the Lab's join).
- Historical odds: consensus game lines only (`football/pricing/*`); per-book
  ticks for actionable game signals (`book_quote_ticks`). **No prop history.**
- Settlement: game level only (`lib/football_grading.js`,
  `tools/collective/settle_finals.js`, `tools/record/football_record.js`).
  **Nothing settles a player prop**, and no prop close is archived.

## 7. UI system

- Top-level views: `<section class="view" id="v-…">` toggled by `show(v)`;
  bottom nav is the only primary nav (6 seats pinned by
  `tools/app/navigation.test.js`). `props` is already a hidden research
  sub-module id (`#v-props`, `researchGo('props')` → Stats), so the new view is
  **`pprops`** (`#v-pprops`), leaving the old module untouched.
- Tokens: dark theme only (`--bg --surface --surface2 --border --text --dim
  --faint --accent --pos --neg --warn --gold`), Inter + JetBrains Mono.
- Data access: `sbGet`, `sbPost`, `sbUpsert`, `edUser()`, `edToken()`; static
  JSON by relative path with `cache:'no-cache'`; libs as
  `<script src="/lib/x.js?v=YYYYMMDDx">`.
- Tests: string/vm tests over app.html, Playwright e2e against a local static
  server (`tools/bettor/decision_ui.e2e.js` harness).
- Found in passing: `lib/edgedesk_decision.css` has an unclosed comment and a
  stray `=======` merge marker (lines 160 and 192) that silently drop the
  `.edd-levels` / `.edd-layers` rules. Fixed in this change (two lines).

## 8. Network reality of the build container

nflverse release assets (GitHub) and the sportsdataverse player box are
reachable and keyless. The Odds API, CollegeFootballData and ESPN's site API are
blocked from the development container (proxy 403) and `ODDS_API_KEY` is not
set there — prop **prices** can therefore only be captured by the scheduled
workflow that holds the secret. Everything that does not need a price (logs,
usage, matchups, projections, distributions, backtests) was built and run on
real data here.
