# EdgeDesk Player Quality + Scheme — walk-forward record

Generated 2026-09-04T12:30:20.334Z.
Tune window: 2022, 2023. **Holdout: 2024, 2025** — seasons no
scalar in this layer was fitted on.

3132 FBS-vs-FBS games replayed cold in kickoff order across
2022-2025. The table below scores the
**1606** of them that fall in the holdout window; the market row covers the
444 of those the public closing-line archive reaches.

## The result, first

the player-quality layer did NOT improve holdout spread MAE. It ships with points_applied:false: it is published as research, it moves no projection, and the Football board’s existing numbers are unchanged by it.

| arm | n | spread MAE | Brier | ATS vs close |
|---|---|---|---|---|
| baseline (Power 4 rating core) | 1606 | 12.826 | 0.1882 | 51.1% |
| + player quality | 1606 | 12.808 | 0.1877 | 50.9% |
| + player quality + scheme | 1606 | 12.813 | 0.1877 | 51.4% |
| closing market | 444 | 11.770 | — | — |

**baseline + recruiting was NOT run.** no recruiting feed is wired in (see recruiting_adapter.js). The "baseline + recruiting" arm the spec asks for cannot be run, and running it with fabricated or placebo pedigree would be worse than not running it.

## Calibration

| scalar | value | applied? | why |
|---|---|---|---|
| player points per matchup point | 0.2948 | **no** | the layer did not clear the bar (pooled MAE fell by only 0.018 points; paired p = 0.403; it is worse in 2024), so this scalar moves NO line. The gap is still published, because knowing which team is better on player quality is useful research even when it does not price the game better than the rating core already does. |
| scheme points per matchup point | 1.4367 | **no** | the scheme layer did not clear the bar (pooled holdout MAE did not fall; paired p = 0.701; it is worse in 2025), so it moves NO line and is published as research context only. |

## How leakage is prevented

* player ratings for a game in season Y week W are rebuilt from plays in seasons < Y plus season Y weeks < W, and the rebuild is real rather than a filter over finished ratings
* the baseline is the Power 4 rating recursion replayed cold in kickoff order: every game predicted before it is absorbed
* the scalars are fitted on a tune window and scored on a holdout window the fit never saw
* the market is never an input to any model number in this file; it is a benchmark column

## What "improves" has to mean here

A layer moves a line only if it clears all three of:

1. lower pooled holdout spread MAE, **and**
2. a paired test over the per-game absolute errors at **p < 0.05**, **and**
3. lower MAE in **every** holdout season separately.

With sixteen hundred games, "lower pooled MAE" alone is cleared by a coin flip
about half the time. Per-season detail:

| arm | 2024 | 2025 |
|---|---|---|
| baseline | 13.032 | 12.622 |
| + player quality | 13.058 ✗ | 12.562 ✓ |

## Reproducing this

```
node football/players/validate.js --first 2022 --last 2025 \
     --tune 2022,2023 --hold 2024,2025 --write-params
```
