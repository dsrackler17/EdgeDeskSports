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
| nflverse (GitHub) | NFL schedule + closing consensus, team-week EPA, rosters, official injury report | public, keyless, CORS-open | none | `retrieved_at` on the injuries artifact; release date per CSV | browser NFL board, `football/injuries`, `football/starters` |
| ESPN (public endpoints) | rosters, depth (CFB endpoint 404s), finals | public | none | sync `generated_at` | rosters, availability collectors, settlers |
| CollegeFootballData | the `cfb` schema mirror (games, teams, SP+, records, rankings, season stats, roster, recruiting, lines) | API key | `CFBD_API_KEY` (deployed `cfb_ingest`; adapters dark without it) | ingest time (not on every row) | `Dal` reads via `Accept-Profile: cfb` |
| open-meteo | forecasts per venue | keyless | none | `observed_at` per forecast; carried forecasts keep their original time | `football/venues/forecasts.json` (not yet read by the function) |
| MLB Stats API, Baseball Savant | MLB modules | keyless | none | per call | MLB retrieval |
| Anthropic | the writing model | API | `ANTHROPIC_API_KEY` (server) | n/a | `edgedesk_ai` narration only |

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
