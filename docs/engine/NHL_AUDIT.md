# NHL engine — audit and dependency map (2026-10-13)

> Written before any change in this build, from the repository and a fresh
> rebuild of its data. It records what already existed and was validated, what
> was missing, and what needed improvement. The build that followed is
> described in [`NHL_LAB.md`](NHL_LAB.md), [`NHL_SOURCES.md`](NHL_SOURCES.md)
> and [`NHL_OPERATIONS.md`](NHL_OPERATIONS.md).

## 1. Reproducibility check (before touching anything)

| Check | Result |
|---|---|
| Re-download every season 2010-11 → 2026-27 from the public mirror and re-run the ingest | 17 seasons, 20,676 games, 0 flagged, 0 duplicates, no missing columns |
| Rebuild the committed team-game table from that ingest | **byte-identical** for all 16 completed seasons (0 of 145 files changed); only the season in progress changed (3 new finals) |
| Re-run the walk-forward (`hockey/model/walkforward.js`) | selection and confirmation figures identical to the committed record; only live-season rows changed; 0 leakage violations in 17,239 scored games; 1 min 39 s |
| Existing suites | `nhl:test` 97 + 7 + 27, `engine:test` 37, every `--check`: all green |

The pipeline is deterministic and the committed record is reproducible.

## 2. What existed and is validated (kept; not rebuilt)

| Layer | Where | State |
|---|---|---|
| Ingest: play-by-play, goalie box, schedule, provenance (sha256, fetch time), `known_at` blank, `assumed_available_at`, `pit = RETRO` | `hockey/ingest/season.js`, `game.js` | correct; blocked-shot attribution fixed and verified |
| Team-game table (41,352 rows, 2 per game) | `hockey/data/team_games/` | reproducible |
| Lineups (who dressed, TOI) | `hockey/ingest/lineups.js` | every game since 2010-11 |
| Second source (ESPN, full 2024-25) reconciled event by event | `hockey/crosscheck/espn.js` | 1,398/1,398 games |
| xG (shot-level logistic, walk-forward) | `hockey/xg/` | beats distance-only every season |
| Ratings: opponent- and score-adjusted 5v5 xG, goals, PP/PK, finishing, goalie GSAx, starter projection | `hockey/model/ratings.js` | — |
| Goal model: Poisson GLM + pair recalibration | `hockey/model/glm.js` | chosen `xg_no_goalie` |
| Score distribution: exact 30-s DP with score effects, empty net, OT, shootout | `hockey/model/distribution.js` | browser + Node |
| Markets: 2-way ML, 60-min 3-way, PL ±1.5, totals 5–7, team totals 2.5–3.5 | same | ML and PL **OUTCOME_VALIDATED**; totals, 3-way, team totals **PROVISIONAL** |
| Walk-forward record, leakage audit, block bootstrap, calibration bins | `hockey/model/walkforward.js` | beats Elo by 0.0038 (95% −0.0056 to −0.0021) |
| Market test harness (no-vig close, ROI with pushes, CLV) | `hockey/model/market_test.js` | **no archive** |
| Gateway row `icehockey_nhl` (disabled) + `NHL_PRICES` switch | `supabase/nhl_odds_sport.sql`, `hockey/market/fetch_quotes.js` | spends 0 by default |
| Pregame ledger (append-only, hashed) + grader | `hockey/build_slate.js`, `grade_ledger.js` | 2026-27 in progress |
| Panel (list + game detail) | `lib/edgedesk_engine_ui.js` | — |
| Desk turn | `hockey/desk.js` | — |
| CI: tests, 3-hourly build, weekly validation | `.github/workflows/nhl.yml` | — |

## 3. What was missing or needed improvement

| # | Directive phase | Gap | Severity |
|---|---|---|---|
| 1 | 3 (E, G) | No machine-learning challenger (regularised logistic, gradient-boosted trees) and no ensemble had ever been evaluated against the GLM | model selection incomplete |
| 2 | 3 (F), 5 | Totals over-confident (calibration slope 0.81 / 0.80) and the 60-minute draw under-priced (20.5% vs 22.4%): only the bivariate-Poisson common shock had been tried | two markets PROVISIONAL |
| 3 | 4 | No feature ablation; travel, time zones, schedule congestion, short-term form and special-teams interaction never measured | feature set unexamined |
| 4 | 5 | No alternate puck lines (±2.5, ±3.5), alternate totals, regulation totals, first-period markets; no split solver for consistent repricing | market coverage |
| 5 | 6 | No discrimination metric (AUC), no early/late-season or by-team error, no starter-projection accuracy, no drift monitor, no totals interval coverage | evaluation gaps |
| 6 | 7 | No market-comparison engine with explicit VERIFIED VALUE / PROVISIONAL / RESEARCH ONLY / PASS gates; the price check printed EV with a blanket "not a value call" | decision layer |
| 7 | 8 | No NHL player-prop research at all (box scores with shots, goals, assists, saves are in the public mirror but unused) | missing |
| 8 | 9 | The game page shows a number without the reasons for it (no decomposition of "why 57.6%"), no model comparison, no interactive goalie scenarios, no market comparison | explanation |
| 9 | 2, 13 | No NHL tables in Supabase; no source registry with authorisation status; no reconciliation of play-by-play against the official box score; no access requests for licensed providers | warehouse / provenance |
| 10 | 10 | No scheduled drift, starter, staleness or registry jobs | operations |

Unchanged and out of scope here: the cross-sport board's rules, the odds
gateway, every other sport's brain.

## 4. Environment findings that shape the build

This build environment's egress policy refuses `api-web.nhle.com`,
`api.nhle.com`, `moneypuck.com`, `naturalstattrick.com`,
`hockey-reference.com`, `evolving-hockey.com`, `hockeyviz.com`, ESPN and the
odds provider (HTTP 403 at the proxy). It reaches `raw.githubusercontent.com`,
which serves the public sportsdataverse mirror of the NHL's own feeds — every
dataset this build uses. The GitHub Actions runners that operate the engine are
not under this policy; the NHL API client already runs there. Nothing was
scraped through a side door, and no proprietary dataset was mirrored.

The mirror holds more than the engine used: per-game skater and goalie box
scores (shots on goal, goals, assists, points, saves, TOI), team box scores,
shift charts, rosters and penalties, every season since 2010-11. The play-by-play
carries on-ice player ids for every event.

## 5. Dependency map (build order)

```
public mirror (pbp, goalie box, skater box, team box, schedule)
  └─ ingest cache ─┬─ team-game table ─┬─ ratings ─┬─ GLM (A, B, C, D) ─┐
                   │                   │           └─ context features ─┼─ lab: LR, GBDT (E), ensemble (G)
                   │                   └─ boxscore reconciliation       │
                   ├─ period goals ──────────────────────── distribution variants (F) ── market sheet
                   └─ skater/goalie box ── prop research (8)              │
                                                                          ├─ explanation, scenarios
source registry ── access requests                                        ├─ market comparison (7)
Supabase warehouse ◄── sync (guarded)                                     └─ slate ── panel, desk, ledger
```
