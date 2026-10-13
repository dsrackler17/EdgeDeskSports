# Data contract — schemas, sources, licensing, cadence, cost

## Sources

| Source | Used for | Access | Licence / terms | Cadence | Cost |
|---|---|---|---|---|---|
| `sportsdataverse/fastRhockey-nhl-data` (GitHub raw) | NHL play-by-play, goalie box, game info, 2010-11 → today | keyless | repository MIT; the game data is the NHL's (NHL.com terms restrict commercial use — **owner review required before paid use**) | daily in season | free |
| `sportsdataverse/fastRhockey-nhl-raw` (GitHub raw) | NHL season schedule incl. future games | keyless | as above | daily | free |
| NHL web API `api-web.nhle.com` | today's schedule and game states | keyless, undocumented | no published terms for automated use; called politely (≤ 4/s, cached 10 min) | each build | free |
| The Odds API, only via `supabase/functions/odds_gateway` | NHL book prices (`featured`: h2h, spreads, totals) | gateway service credentials | commercial API | only when authorised | ≈3 credits per call; **0 by default** |
| `sportsdataverse/fastRhockey-nhl-data` skater box | NHL lineups (who dressed, TOI) | keyless | as above | daily | free |
| `sportsdataverse` hoopR / wehoop data (GitHub raw) | NBA, WNBA, men's and women's college schedules and results | keyless | MIT repositories; ESPN's data — owner review before paid use | daily | free |
| `openfootball/football.json` | five soccer leagues' fixtures and results | keyless | public domain (CC0) | daily | free |
| Retrosheet game logs (`chadwickbureau/retrosheet`) | MLB results, starters, parks 2010-2023, 2025 | keyless | free with the Retrosheet notice | yearly | free |
| `nflverse/nfldata` games.csv | the data pack's NFL labels cross-check (the football engine's own source) | keyless | CC-BY-4.0 | weekly | free |
| The EdgeDesk Quant Data Pack (`datapack/quant_v1`) | one ESPN season per sport, NFL derived tables, MLB 2024, UFC 2024, contracts | imported | research copies; each source's terms (`sources/source_registry.json`) | one-off | — |
| The EdgeDesk NFL Data Pack (`datapack/nfl_v1`) | nflverse 2025-2026 play-by-play (2026 partial), snaps, rosters, depth charts, injuries, PFR advanced, NGS; derived 2022-2026 tables | imported (Parquet read by my own helpers with pyarrow) | nflverse CC-BY-4.0; NGS/PFR/ESPN upstream terms not certified | one-off | — |
| The EdgeDesk NHL Data Pack (`datapack/nhl_v1`) | ESPN's full 2024-25 NHL season: games, events, shot attempts, player and goalie boxes, officials, lagged features | imported (the two largest tables gzipped, verified on their uncompressed bytes) | ESPN public responses; redistribution rights not certified — research copy | one-off | — |
| Licensed closing archive (not present) | the market test | — | must be licensed | weekly | depends on source |

Market-definition assumption (documented, not verified against the provider's
docs from this environment): the provider's NHL `h2h` is the two-way
moneyline including OT/SO, `spreads` the puck line including OT/SO, and
`totals` include OT with the shootout winner credited one goal.

## Spend and quota controls

- `engine/http.js` (free sources): disk cache with TTL and ETag/Last-Modified
  revalidation, stale-if-error, in-flight dedupe, per-provider per-run and
  per-day quotas, a circuit breaker (4 consecutive failures → 15 min open),
  bounded retries with backoff and jitter honouring Retry-After, per-provider
  concurrency and spacing. A paid provider has a zero quota unless
  configured; an unregistered host is refused; the odds host is not
  registered at all.
- Paid odds: one gateway (`odds_api_acquire`), the NHL sport row created
  **disabled** (`supabase/nhl_odds_sport.sql`), and a second switch in the job
  (`NHL_PRICES=on`). `tools/odds/no_bypass.test.js` §10 fails the build if any
  engine file calls a spending function.

## Schemas (all versioned)

### Time, for every table (the data pack's rule)
`known_at` is when the source first published a fact. It was never recorded
for history, so it is **blank** on every historical row — never backdated,
never replaced by the retrieval time or the scheduled start. Models use an
explicit, named assumption instead (`assumed_available_at`), and every row is
`pit = RETRO`: retrieved after the fact from a source that can revise. Every
walk-forward record therefore says `point_in_time: RETROSPECTIVE`.

### `edgedesk_nhl_team_games_v2` — `hockey/data/team_games/<season>/<YYYY-MM>.csv`
Two rows per completed game. Keys: `game_id, season, type (R|P), date,
start_utc, known_at (blank), assumed_available_at (start + 4 h), pit (RETRO),
team, opp, home, decided (REG|OT|SO)`. Results:
`gf, ga, gf_reg, ga_reg, win, so`. Time on ice (s) by state from the team's
side: `toi_ev5, toi_evo, toi_pp, toi_sh, toi_enf, toi_ena` and 5v5 by score
`toi_ev5_lead/tie/trail`. For-metrics by state: goals `*_gf`, unblocked
attempts `*_ff`, all attempts `ev5_cf`, xG `*_xgf`, and 5v5 xG/attempts by
score. Penalties: `pen_minors, pen_majors, pim`. Goalies: `g_start` and up to
two goalies with `fa, ga, xga`. Provenance: `xg_model` (the model that scored
the row), `src` (hash of the source file). Against-metrics are the opponent's
row. A model may use a row only for a game whose prediction time is later than
its `assumed_available_at` AND whose date is later.

### NHL lineups — `.cache/nhl_work/lineups_<season>.json.gz` (`edgedesk_nhl_lineups_v1`)
`{ names: {player_id: name}, games: {game_id: {date, home: [[player_id, toi_s, pos]], away: [...]}} }`.
A duplicated player counts once; an unparsed TOI is null and counted.

### Basketball — `basketball/data/<league>/<season>.csv` (`edgedesk_bb_games_v1`)
`game_id, season, type (R|P), date (North American game day = UTC start − 10 h),
start_utc, neutral, home_id, away_id (ESPN ids; names in teams.json), hs, as,
ot, status (FINAL|SCHEDULED), src (S source | P data pack), known_at,
assumed_available_at, pit`.

### Soccer — `soccer/data/<league>/<season>.csv` (`edgedesk_soccer_matches_v1`)
`match_id, season, date (local), time_local (no zone), home, away (club keys;
display names in manifest.json), hg, ag, ht_hg, ht_ag, status (FINAL |
SCHEDULED | RESULT_MISSING), known_at, assumed_available_at (match day 23:59
UTC), pit`.

### MLB — `mlb/history/data/<season>.csv` (`edgedesk_mlb_games_v1`)
`game_id, season, date, game_no, dn, home, away (franchise keys), hs, as, outs,
park, sp_home, sp_away (blank for 2024), source, known_at,
assumed_available_at (08:00 UTC next day), pit`.

### Walk-forward records — `edgedesk_lab_walkforward_v1`
`basketball/validation/<league>_walkforward.json`,
`soccer/validation/<league>_walkforward.json`,
`mlb/history/validation/mlb_walkforward.json`, `engine/lab/ufc_elo.json`:
protocol, data (with `temporal`), leakage audit, tuning, selection,
comparisons (block bootstrap), markets (status, failed rules,
`market_status: NOT_TESTED`), windows.

### Research slates — `edgedesk_lab_slate_v1`
`basketball/slate.json`, `soccer/slate.json`: each league's model, validation
status per market, `value_claims: DISABLED` with the reason, the data state
(soccer leagues with recent missing results are STALE), and per game the
fair prices with their settlement rules (quarter Asian lines as five
outcomes), inputs and invalidators.

### Quality reports
`datapack/quant_v1/EDGEDESK_VERIFICATION.json` (the pack verified),
`datapack/nhl_v1/EDGEDESK_VERIFICATION.json` (the NHL pack verified: 34
checks and the facts it found),
`datapack/quant_v1/EDGEDESK_CROSSCHECK.json` (the pack against each brain's
source), `hockey/validation/nhl_crosscheck_espn.json` (`edgedesk_nhl_crosscheck_v2`:
the NHL pack's full 2024-25 season against my feed — games, every shot
attempt, goalies, skaters, officials),
`hockey/validation/nhl_blocked_attribution.json` (who shot a blocked attempt,
every season), `hockey/validation/nhl_contracts.json` (canonical contracts and
per-field missingness), `engine/missingness.json` (per sport and season).

### NFL pack reports and crosswalk
`datapack/nfl_v1/EDGEDESK_VERIFICATION.json` (18 checks and the facts found),
`football/validation/nfl_pack_crosscheck.json` (the pack against games.csv and
my live 2026 team-week table), `football/validation/nfl_pack_research.json`
(offseason carryover and starting-QB change, held out), and
`football/nfl/crosswalk/players_2024_2026.csv`: `gsis_id, pfr_id, espn_id,
full_name, position, seasons, teams, status` — `status` is OK or
`CONFLICT: …`, and a conflicting id is left blank.

### NHL crosswalks and officials — `hockey/data/crosswalk/`, `hockey/data/officials/`
- `espn_nhl_2025.csv`: `espn_game_id, nhl_game_id, home, away, espn_start,
  nhl_start, minutes_apart, basis` — one row per matched 2024-25 game.
- `espn_nhl_players_2025.csv`: `espn_player_id, nhl_player_id, espn_name,
  nhl_name, role, espn_games, basis` — the basis is the count of matched events
  that carried both ids, or "name within the team-game" for a player with no
  attempt, or UNMAPPED.
- `officials/2025.csv`: `nhl_game_id, espn_game_id, date, home, away,
  referees, linesmen, referees_listed, known_at, assumed_available_at, pit,
  src` — `known_at` and `assumed_available_at` are blank (no assignment time
  is recorded), `pit = RETRO`. Research only.

### NHL research — `hockey/validation/nhl_officials_research.json`, `nhl_pack_features.json`
Referee split-half reliability with a permutation null; the NHL pack's lagged
features tested against my model's out-of-sample probability on a later
hold-out. Neither enters a price; both say why.

### `edgedesk_nhl_slate_v1` — `hockey/slate.json`
Upcoming games: λ, prices for every market with settlement text, goalie
projections and scenarios, evidence, uncertainty (variant spread + the
held-out calibration bin), data quality, invalidators; a readiness block
(data / model / market / value claims); the record; attribution.

### `edgedesk_nhl_ledger_v1` — `hockey/ledger/<season>.jsonl`
Append-only, hash-identified pregame records written only when a price moves
(1 pp moneyline, 0.1 goals total), the model changes, or the goalie certainty
changes; never at or after the start (`build_slate.js --check`). When prices
are captured each record also freezes the best book price and the no-vig
consensus, so `grade_ledger.js` can report CLV.

### `edgedesk_market_quotes_v1` — `hockey/market/quotes.json`
`status` LIVE | CACHED | UNAVAILABLE | DISABLED with `reason`; gateway
provenance (`decision, source, fetched_at, request_id, cost, quota`);
`events[]` matched to games by both clubs and a start within 6 h; `unmatched[]`
with reasons.

### Closing archive — `hockey/market/closing/<season>.csv` (licensed; not shipped)
```
game_id,source,book,captured_at,close_home_ml,close_away_ml[,open_home_ml,open_away_ml,opened_at]
[,close_total_line,close_over,close_under][,close_pl_home_line,close_pl_home,close_pl_away]
```
Rows without `source`/`captured_at`, or captured at or after the start, are
rejected and counted.

### Confirmed starters — `hockey/data/confirmed_starters.json`
```
{ "starters": { "<game_id>": { "home": <goalie id>, "away": <goalie id>, "source": "...", "url": "...", "recorded_at": "ISO" } } }
```

### My own quotes — `engine/market/manual_quotes.json`
```
{ "schema": "edgedesk_manual_quotes_v1", "quotes": [ { "event_key": "NHL|2026020123", "market": { "kind": "moneyline", "side": "DET", "line": null },
  "book": "...", "american": -125, "captured_at": "ISO", "note": "..." } ] }
```
Labelled USER_SUPPLIED on the board; judged by the same rules as captured prices.

### `edgedesk_engine_registry_v1` / `edgedesk_engine_board_v1` — `engine/`
The registry is rebuilt from validation files: per sport a state, its scope
(the markets that carry it), per-market states, the readiness ladder's first
four rungs (data loaded, model trained, validation passed, tested against the
close) and the known data gaps. The board (`lib/edgedesk_xboard.js` v2) adds
the last two rungs per sport (a fresh verified price now, an actionable
signal), keeps every actionable row and, per sport, 24 research rows, with
counts for all; each candidate carries its settlement (split / void) and its
sensitivity checks.
