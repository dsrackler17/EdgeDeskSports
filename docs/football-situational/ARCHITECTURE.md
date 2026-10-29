# Football Situational Intelligence Engine — architecture map

Written from the Phase Zero audit on 2026-10-29, before any integration code
was added. This file describes the system as it was found and where the engine
attaches to it. `football/situational/README.md` covers how to operate it.

## What already existed, and what the engine reuses

| Concern | Existing system | How FSIE uses it |
|---|---|---|
| NFL play-by-play | nflverse release assets (`pbp/play_by_play_<Y>.csv.gz`, `ftn_charting`, `pbp_participation`, `schedules/games.csv`, `injuries`, `depth_charts`, `weekly_rosters`), read by `football/props/sources/nfl.js`, `football/starters`, `model_loop` | The same keyless release assets. Streaming CSV through `football/props/factory/lib/io.js`'s `readCsv`. |
| CFB play-by-play | sportsdataverse `espn_cfb_pbp/play_by_play_<Y>.parquet` (2014→2026), read by `cfb_v2` and `model_loop` through pyarrow | The same file, read column-selectively through `hockey/tools/parquet_select.py` (pyarrow, already installed by 26 workflows). |
| CFB schedule / FBS universe | cfbfastR-data `cfb_schedules_<Y>.csv`; `football/fbs/fbs.js` `buildUniverse`/`classifyGame` | The same schedule is the expected-games spine; `football/fbs_epa/teams.json` maps ESPN team id ↔ slug. The eligible team universe is derived each run from the season's schedule (`*_division == 'fbs'`), never from a stored list. |
| Cache freshness | `football/data/feed_cache.js` (completed season permanent, current season volatile) | The same rule decides whether a cached download may be reused. |
| Player props | `football/props/` (Odds API capture through the `odds_gateway` Supabase function; `quotes.json`, `closes.jsonl`, ledger) and `lib/edgedesk_props.js` (`clv`, `noVig`, `normName`) | Read-only. FSIE never calls The Odds API: it reads the committed quotes and close archive, and grades CLV with `EDProps.clv` so the definition is the project's own. |
| Research registry | `research_models` / `research_model_versions` / `research_model_results` (DDL in production only); generated, idempotent registration SQL (`tools/sharp_lag/build_registry_sql.js` pattern) | Four EXPERIMENTAL registrations, generated SQL with a `--check` mode. |
| NFL projection | `football/engine.js` + `football/nfl_model.js` (pace enters the total through `pace_sum`); published by `tools/football/build_nfl_slate.js` → `football/nfl/slate.json` | SHADOW block on each slate row (the `coaching_staff` precedent): `affects_projection:false`, `adjustment_points:0`. |
| CFB projection | `football/cfb_p4/engine.js` (pace term `points_per_pace`), `cfb_v2` (Python possessions model, shadow); published by `football/fbs/build_coverage.js` → `football/fbs/slate.json` | SHADOW block on each slate row (the `v2_shadow` precedent). |
| Simulators | `simulator/src/sports/{nfl,cfb}` — margins only; no possessions or plays | A situational SHADOW sampler in FSIE that conditions possessions and play allocation on the simulator's own margin model, with its own PRNG stream; the simulator's results are untouched. |
| Game cards | `app.html` `fbGameCardNfl` (52077), `fbP4Card` (58818); outside-module glue pattern (`window.fbMarketStructureHTML`) | A new glue block `window.fbSituationalHTML` with its own `.fsie-*` CSS, reading one committed artifact keyed by each league's own game id. |
| CI | `npm run verify`, `tools/ci/checks.json`, `tools/ci/push_generated.sh` | A PR test workflow in `sports-models`; the scheduled job commits through `push_generated.sh`. |

## Data flow

```
nflverse (pbp, FTN, participation, schedules, injuries, rosters)      sportsdataverse ESPN pbp + cfbfastR schedules
                 │                                                                     │
                 ▼                                                                     ▼
        nfl/source.js  ──────────────►  core/normalize (one play schema)  ◄────────  cfb/source.js
                                                  │
                                         core/quality (play, game, source gates; versioned thresholds)
                                                  │  accepted / rejected-with-reasons
                                         core/aggregate (team-game situational counts, player-game usage)
                                                  │
                     ┌────────────────────────────┼─────────────────────────────┐
              core/features                 core/volume_model              core/player_model
          (point-in-time tendencies,     (script-mixture team volume,     (coherent team→player
           shrinkage, coverage tiers)     correlated possession sim)       opportunity allocation)
                     │                            │                             │
                     ▼                            ▼                             ▼
         data/<sport>/<season>/tendencies   projections.jsonl (append-only)   player_projections.jsonl
                                                  │
                         core/market (props quotes + closes → disagreement, CLV via EDProps.clv)
                                                  │
                         adapter.js (OFF / SHADOW / ACTIVE) → NFL slate row, FBS slate row, simulator shadow
                                                  │
                         data/cards.json → app.html game cards (Situational Intelligence + Research Models)
```

## Reachability from the build container (2026-10-29)

| Host | Here | In GitHub Actions |
|---|---|---|
| github.com release assets, raw.githubusercontent.com | reachable | reachable |
| api.collegefootballdata.com | **blocked (403 by egress policy)** | reachable with `CFBD_API_KEY`, but CFBD's terms forbid a committed mirror; not used |
| site.api.espn.com | **blocked** | reachable; not needed (the ESPN pbp arrives through sportsdataverse) |
| api.the-odds-api.com | **blocked** | only through the `odds_gateway` function; FSIE reads committed quotes instead |
| Supabase | no credentials here | `SB_URL`, `SB_SERVICE_ROLE`, `SB_DB_URL` secrets |

## Boundaries FSIE does not cross

- No edit to `football/engine.js`, `nfl_model.js`, `params.js`, `nfl_params_v2.js`, `cfb_p4/engine.js`, `cfb_p4/params.js`, `rankings/`, ETSR or any EPA formula.
- No edit to frozen research (`research/foresight/**`, `football/market_structure/preregistration.json`) or to any committed ledger.
- No Odds API call and no change to the gateway, its budget or its bypass guard.
- No new npm, CDN or binary dependency.
