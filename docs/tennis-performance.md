# EdgeDesk Tennis — measured query performance

All measurements are `EXPLAIN (ANALYZE, BUFFERS)` against **PostgreSQL 16.13**
with stock settings (`work_mem = 4MB`) on a production-cardinality database:

| table | rows |
|---|---:|
| `tennis.matches` | 290,280 |
| `tennis.player_match_features` | 715,245 |
| `tennis.players` | 106,887 |
| `tennis.player_ratings_current` | 78,838 |
| `tennis.rankings_current` | 42,107 |
| `tennis.model_predictions` | 40 |
| `tennis.odds_snapshots` | 80 |

The match, feature, player and rating counts are at or above the real archive's
361,571 matches / ~723,000 feature rows / ~15,500 players. **Players are
over-dispersed** in this fixture — 106,887 players averaging ~5 matches each,
where production has ~15,500 averaging ~47 — so the per-player numbers below are
optimistic in absolute terms. What they do establish is the shape: every one is
an **index scan keyed on the player**, so the cost scales with *that player's*
match count and not with the size of the table.

---

## User-facing targets, and what was measured

| # | query | target | measured | plan |
|---|---|---|---|---|
| 1 | research board, first load (`board_current`, 100 rows) | < 500 ms | **1.6 ms** | nested loops over small live tables + `tournaments_pkey` |
| 2 | public board, anonymous (`board_public`, 7-day window) | < 500 ms | **0.5 ms** | index on `scheduled_at` |
| 3 | player summary (`player_profile`) | < 300 ms | **0.25 ms** | `players_pkey` + `tennis_prc` pkey |
| 4 | match context (`match_context`) | < 500 ms | **0.11 ms** | `tennis_pred_match_idx` |
| 5 | player form strip, last 20 | < 300 ms | **0.31 ms** | `tennis_matches_winner_date_idx` / `..._loser_date_idx` bitmap |
| 6 | head to head | < 300 ms | **0.16 ms** | same pair of indexes |
| 7 | surface splits | < 300 ms | **0.13 ms** | same |
| 8 | AI: strongest on a surface | bounded | **21.7 ms** | `tennis_prc_tour_clay_idx`, capped at 50 rows in SQL |
| 9 | record health (board header) | < 500 ms | **96–103 ms** | one aggregate pass over `matches` |
| 10 | rankings page, 300 rows | < 300 ms | **1.3 ms** | `tennis_rankings_tour_rank_idx` |
| 11 | results, cursor-paginated | < 300 ms | **0.20 ms** | `tennis_matches_tour_date_idx` |
| 12 | open research opportunities | < 500 ms | **0.04 ms** | partial index `where status='open'` |
| 13 | public record summary | < 500 ms | **0.09 ms** | aggregate over `prediction_record` |
| 14 | AI player context (one bounded read) | bounded | **3.5 ms** | per-player indexes |
| 15 | AI data health | bounded | **137 ms** | `record_health` + capped issue/run reads |

**Every target is met.** Pagination is by cursor (`match_date < $1 order by
match_date desc limit N`), never by a large `OFFSET`.

---

## Two things this measurement actually found

### 1. The rating build was O(n²) — 9 minutes to 17 seconds

`tools/tennis/build_ratings.js` originally assembled a player's surface splits
with a correlated subquery in the SELECT list:

```sql
(select json_agg(...) from surface_last s where s.player_id = lf.player_id) as surfaces
```

`surface_last` is a CTE, so that re-scanned it **once per output row** — 106,887
times. The `EXPLAIN ANALYZE` of the query did not finish inside **nine minutes**,
and the job itself was killed after twelve.

Pre-aggregating the splits into their own CTE and `LEFT JOIN`ing once:

| | before | after |
|---|---|---|
| the state query | > 540,000 ms (timed out) | **9,411 ms** |
| the whole rating build, 78,838 players | did not finish | **17.5 s** |

It also drops two window functions over a 580k-row join — at 4MB `work_mem`
those were spilling to disk — in favour of one `distinct on` and one `GROUP BY`.
Output is byte-identical: the same five players in the same order with the same
ratings on the development database, before and after.

### 2. `record_health` was six sequential scans — 334 ms to ~100 ms

The board loads it on **every render**, and it asked for the row count, the ATP
count, the WTA count, the first date, the last date and the unknown-surface
count as six separate scalar subqueries — six sequential scans of the same
290,280-row table. Folded into one aggregate with `FILTER` clauses:

| | before | after |
|---|---|---|
| `select * from tennis.record_health` | 334 ms | **96–103 ms** |

Same values, one pass.

---

## Batch job timings at this scale

| job | rows | wall clock |
|---|---:|---:|
| archive import (`--chunk 20000 --fast`) | 362,112 source rows | **3 m 11 s** (~1,900 rows/s) |
| feature build (rolling serve/return/SOS) | 715,245 feature rows | **1 m 28 s** |
| rating build | 78,838 players | **17.5 s** |
| model train + evaluate | 201,276 train / 43,131 test | **1 m 4 s** |
| board price | 40 fixtures | **< 1 s** |

The import drops the expensive secondary indexes for the backfill
(`tennis.drop_backfill_indexes()`) and rebuilds them at the end
(`tennis.rebuild_backfill_indexes()`) when given `--fast`.

---

## Indexes, and the query each one is for

| index | query it serves |
|---|---|
| `tennis_matches_tour_date_idx` | results list, per tour |
| `tennis_matches_winner_date_idx` / `_loser_date_idx` | a player's matches, form strip, head to head, surface splits |
| `tennis_matches_surface_date_idx` | surface-filtered history |
| `tennis_matches_season_idx` | season browsing |
| `tennis_matches_tournament_idx` | a draw, in round order |
| `tennis_pmf_player_date_idx` | a player's feature history (private) |
| `tennis_pmf_train_idx` | the model's training scan, by feature version and date |
| `tennis_prc_tour_power_idx` / `_clay_` / `_hard_` / `_grass_` | leaderboards and the AI's surface question |
| `tennis_rankings_tour_rank_idx` | the rankings page |
| `tennis_pred_match_idx` | the match page |
| `tennis_odds_match_idx` | the freshest price per match |
| `tennis_ro_open_idx` (partial, `where status='open'`) | the research layer |
| `tennis_rec_open_idx` (partial, `where settled_at is null`) | settlement |

---

## Reproducing this

```bash
export EDGD_PG='-h 127.0.0.1 -p 5432 -U postgres'
psql $EDGD_PG -d <db> -f supabase/tennis_record.sql
npm run tennis:record:import -- --file <archive> --chunk 20000 --fast
npm run tennis:features:build && npm run tennis:ratings:build && npm run tennis:model:build
psql $EDGD_PG -d <db> -c 'analyze tennis.matches; analyze tennis.player_match_features;'
psql $EDGD_PG -d <db> -c 'explain (analyze, buffers) select * from tennis.board_current order by scheduled_at limit 100;'
```
