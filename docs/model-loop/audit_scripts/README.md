# Audit evidence scripts

These scripts reproduced the numbers in `../audit_report.md`. They are evidence, not production code:
they read the committed engines and artifacts read-only and never write to the repo.

| Folder | What it reproduces |
|---|---|
| `nfl/` | The leak-free 2026 replay of the shipped NFL engine (`replay.js`, matches 71/100 published picks exactly; the rest differ only by the reconciled starter), the per-game decomposition with the exact 2025-prior vs 2026-data split (`decompose.js <game_id>...`), the card-consistency checks over `football/nfl/slate.json` (`card_check.js`), and the defensive-mirror counterfactual (`bugfix_replay.js`). Run from the repo root after `python3 -m model_loop.adapters.nfl.ingest --fetch` (they read nflverse `games.csv` from `.cache/model_loop/nfl/raw/`, or `NFL_GAMES_CSV`). |
| `cfb/` | Reconstruction of published V1 picks and components, the measured prior decay, card consistency, season replays. |
| `mlb/` | Point-in-time replay of `mlb/engine.js` on Retrosheet 2023/2025 and the item-5 model-vs-model decompositions. |
| `wnba/` | Replay of the live points-ratings engine, card decompositions, early-season and MAE checks. |
| `cbb/` | Incumbent vs research engine replays, the ESPN pickcenter close join (external, labelled), decompositions, card wiring checks. |
| `ufc/` | The Elo lab re-run against a point-in-time base rate. |
| `tennis/` | Decomposition on the synthetic pipeline run and the `sharp_fair` unit check. |

Scripts in the non-NFL folders were written by the per-sport audit passes and reference scratch paths
used during the audit; they are kept for traceability of the numbers quoted, and need their inputs
re-fetched (each sport section of the report says from where) to run again.
