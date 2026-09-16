# EdgeDesk data providers — what feeds the research desk

The per-feed detail for the football pipeline (URLs, fields, failure
behaviour) is `docs/football-data-sources.md`. This page is the provider
view: who supplies what, under what terms, how it is timestamped, and how a
lower-quality source is kept from overwriting a better one.

## Standing rules

- No source is scraped in violation of its terms. Per-user-key APIs are
  called server-side only and their responses are never committed as data.
- Every stored fact carries `source` and, where the provider supplies one,
  `observed_at`. A field with no observation time is UNKNOWN freshness and is
  never actionable.
- Kinds are distinguished in every packet's source manifest
  (`EDRESEARCH.sourceKind`): `market_capture`, `edgedesk_artifact`,
  `licensed_or_public_feed`, `reference_number`, `calculated`,
  `user_supplied`, `other`. A reader's own quote is `user_supplied` and never
  enters coverage.
- A consensus number (`cfb.lines`) is a `reference_number`: it may be
  compared against, never priced against.
- Higher-quality data wins: `EDINTEL.fairMethod` labels a fair price by the
  reference that produced it, and a consensus can never be described as a
  sharp reference; `TRUST` in `index.ts` orders owned sources per field when
  two disagree, and an unresolved conflict lowers confidence rather than
  picking one.

## Providers

| provider | supplies | terms | credential | observed_at | consumer |
|---|---|---|---|---|---|
| The Odds API | book prices, multi-book | commercial API | `ODDS_API_KEY` (capture) | `last_update` per book, `last_seen_at` per row | `capture` → `signals`, `book_quotes`, `signal_ticks` |
| cfbfastR-data / sportsdataverse (GitHub) | schedules, play attribution, player box, QB EPA corpus | public, keyless | none | file `generated_at`; corpus commit hash | slate, rankings, players, profiles, EPA |
| nflverse (GitHub) | NFL schedule + closing consensus, team-week EPA, rosters, official injury report | public, keyless, CORS-open | none | `retrieved_at` on the injuries artifact; release date per CSV | browser NFL board, `football/injuries`, `football/starters`, `football/nfl/slate.json` (Slice 2) |
| ESPN (public endpoints) | rosters, depth (CFB endpoint 404s), finals | public | none | sync `generated_at` | rosters, availability collectors, settlers |
| CollegeFootballData | the `cfb` schema mirror (games, teams, SP+, records, rankings, season stats, roster, recruiting, lines) | API key | `CFBD_API_KEY` (deployed `cfb_ingest`; adapters dark without it) | ingest time (not on every row) | `Dal` reads via `Accept-Profile: cfb` |
| open-meteo | forecasts per venue | keyless | none | `observed_at` per forecast; carried forecasts keep their original time | `football/venues/forecasts.json` → `Dal.getFootballContext()` for a college game (Slice 2) |
| MLB Stats API, Baseball Savant | MLB modules | keyless | none | per call | MLB retrieval |
| Anthropic | the writing model | API | `ANTHROPIC_API_KEY` (server) | n/a | `edgedesk_ai` narration only |

## The desk's own artifacts (Slice 2)

| artifact | from | freshness category | read by |
|---|---|---|---|
| `football/matchup/metrics.json` | rankings, profiles, starters (CFB and NFL), coaching, NFL injuries | rating 7 d; injury 24 h (each record keeps its own `as_of` / `retrieved_at`) | `Dal.getMatchupMetrics()` |
| `football/nfl/slate.json` | nflverse schedule, team-week EPA and rosters through the browser's own engine, in Node | projection 24 h | `Dal.getNflSlateArtifact()` |

Both are copies with a `generated_at` and a `sources` block naming the file
each field came from; a missing upstream (a club with no report, a team
with no profile) is absent from the artifact, and the packet names it
missing.

## The research loop's providers (Slice 3)

| provider | answers | live | credential | ttl | how a refusal is reported |
|---|---|---|---|---|---|
| `nflverse_injury_report` | NFL availability, line, personnel, starter on the report | yes (public CSV) | none | 30 min | UNAVAILABLE with the HTTP status |
| `open_meteo_forecast` | the kickoff forecast | yes | none | 60 min | BLOCKED when no venue geography is on file (NFL); SKIPPED under a roof |
| `cfbd_advanced_stats` | opponent-adjusted efficiency (college) | yes | `CFBD_API_KEY` | 6 h | BLOCKED naming the key |
| `book_quotes_recheck` | a fresher captured price | no (EdgeDesk's own capture) | caller's JWT | none | UNAVAILABLE: capture runs on cadence; no live book feed |
| `web_search` | starter confirmation, line and personnel news | yes (Brave Search API) | `EDGEDESK_SEARCH_API_KEY` | 30 min | BLOCKED naming the key; results are reputable-media tier and never override an official feed |

Free and official providers run first; paid search only for what they
could not answer, and never past `EDGEDESK_INVESTIGATE_SEARCH_CALLS`. The
log of every question and outcome rides in the packet, and the prose may
claim a check only for a question in it.

| artifact | from | freshness category | read by |
|---|---|---|---|
| `football/identity/teams/<key>.json` | rankings, profiles, starters and the depth chart, coaching, talent, the NFL report, the team-week feed, venue geography | rating 7 d (each block keeps its own `as_of`) | `Dal.getIdentity()` (two small budget-free reads per game) |

## The pricer's artifacts (Slice 4)

| artifact | from | freshness category | read by |
|---|---|---|---|
| `football/pricing/lines_nfl.json` | nflverse/nfldata games.csv (consensus close, results, context) via `tools/football/build_lines_archive.js`; sign convention in the file | weekly | the pricing validation, the CLV scorecard |
| `football/validation/pricing_nfl.json` | the shipped NFL engine replayed cold 2006-2025 against the archive by `tools/football/validate_pricing.js` | weekly | `EDPRICE` (tiers, blend, sigma, required edge), the NFL slate's priced board |
| `football/validation/pricing_cfb.json` | the Power 4 backtest report (`football/cfb_p4/research/report/`), copied | with the research run | `EDPRICE` |
| `football/validation/feature-status-nfl.json` | the held-out feature intake in the same script | weekly | reviewers; nothing reads it into a price |
| `football/nfl/slate.json` → `pricing` | the kernel over the slate's reference market at an assumed −110 | with the slate | the Desk's board panel, `get_ranked_slate` |
| `football/nfl/.cache/stats_player_week_<season>.csv` | nflverse player-week (cached by `tools/football/fetch_nfl_feeds.js`, gitignored) | weekly | the identity build (per-quarterback EPA) |

## Provider interfaces and fallbacks

- `EXTERNAL_ADAPTERS` in `index.ts` declares every credentialed adapter with
  `configured()` and `unconfigured_reason`; an unconfigured adapter emits an
  UNAVAILABLE evidence item that names the credential, never a substitute.
- The capability matrix (`SPORT_INTELLIGENCE[sport].capabilities`) declares
  per sport what exists, from where, and with what freshness; `?probe=1`
  prints it.
- The research kernel's data tools read the packet, so a provider that fails
  produces a named missing field in the packet and a failure envelope from
  the tool — never a filled value.

## Lineage from the interface

The structured answer's **Sources** disclosure lists each source with its
kind, observed time and freshness badge; the packet id and hash under it tie
the answer to the `research_packets` row that snapshotted it.
