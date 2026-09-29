# Player Props — data

All inputs are public and keyless. They are cached under `football/props/.cache/`
(git-ignored; `PROPS_CACHE_DIR` overrides it) and streamed through a quote-aware
CSV reader (`football/props/sources.js`).

## NFL (`football/props/nfl_data.js`)

| Input | Source | Used for |
|---|---|---|
| Players | nflverse `players` | identity (GSIS anchor, ESPN / PFR / PFF / … ids), position, headshot |
| Schedule / results | nflverse `nfldata/games.csv` | games, kickoffs (ET → UTC), finals |
| Weekly player stats | nflverse `stats_player_week_<season>` | box scores (targets, receptions, yards, carries, TDs, passing) |
| Snap counts | nflverse `snap_counts_<season>` (PFR ids → GSIS) | snap share |
| Play-by-play | nflverse `play_by_play_<season>` | per-play gains (the empirical pools, **timestamped**), red-zone and third-down usage, team plays / dropbacks / neutral pass rate |
| Depth charts | nflverse `depth_charts_<season>` (timestamped) | role order as of a time (`depthAsOf`) |
| Injury reports | nflverse `injuries_<season>` | availability designations |
| Rosters | nflverse weekly rosters | team membership, jersey, status |

## FBS (`football/props/cfb_data.js`)

Data comes from cfbfastR-data: rosters, schedules and play-by-play. Multi-row
plays are merged per `play_id`. Availability comes from EdgeDesk's own reports
(`football/availability/reports.bundle.json`). The gaps are declared, not
papered over: **no snap or route participation is published** for college, and
there is **no provider depth chart** (roles come from usage order). Team-games
with pass attempts and zero recorded completions are **excluded as source
faults**; they are listed in `board.gaps`.

## Normalised shape

Both loaders return:

```
{ players: Map, games: Map, playerGames: [...], teamGames: Map, depth, injuries, roster,
  pools: { rec: {WR,TE,RB}, rush_rb, rush_qb_designed, scramble, rush_wr } — [[kickoff_ms, gain], …],
  positions: Map, sources: [...], gaps: [...] }
```

These map onto the schema tables (`player_game_logs`, `player_usage_history`
and its snap / route / target / carry / red-zone views, `player_depth_chart`,
`player_injuries`, `player_availability`; see [SCHEMA.md](SCHEMA.md)).

## As-of discipline (no leakage)

- Every estimator reads only rows with `kickoff < asOf` (`model.before`).
- The gain pools are filtered by timestamp (`poolsAsOf`).
- League priors are rebuilt as of the time (`priors.priorsAsOf`).
- The backtest projects each game at **kickoff − 3 h** from rows strictly
  earlier, and audits every row. The committed validation reports **0 leakage
  violations**.
