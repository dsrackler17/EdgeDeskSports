# EdgeDesk CLV programme: final report

**Date:** 2026-10-21.

**Question asked of every model:** when it disagrees with the OPENING (or earliest available) line, does the market move toward it by the close?

**Measurement:**
- One shared harness: `model_loop/clv/harness.py`, with tests in `model_loop/tests/test_clv_harness.py`.
- Every experiment was pre-registered in `EXPERIMENTS.md` before it ran, and every run is logged in `research/clv/results/attempts.jsonl`.
- Data coverage and its limits: `DATA_AUDIT.md`. The models themselves: `SPORTS_INVENTORY.md`.

**How to read the numbers:**
- **CLV (pp):** the mean no-vig probability the bet gained from open to close, in percentage points, with a 95% cluster-bootstrap interval. Clusters are weeks for football and game dates for everything else.
- **pts:** the same in points, for spreads and totals.
- **Verdict:** PASS means all of these hold on the holdout:
  - the one-sided lower bound of mean CLV at α = 0.05 / k is above zero, where k = every attempt for that sport, failures included;
  - the mean points CLV is positive;
  - there are at least 50 bets.
- **`clv_ev`:** the expected return of the opening bet at the closing no-vig price, after paying the opening vig.
  - CLV > 0 means the model beats the close.
  - `clv_ev` > 0 means it beats the close by more than the vig. That is the bar for making money at the opening price.
  - The pre-registered gate is CLV, so `clv_ev` is reported beside it, not as a gate.

## Summary: sports ranked by demonstrated edge

Ranked by the strongest holdout CLV that is also out of sample and on trustworthy lines, then by `clv_ev`.

| Rank | Sport | Best holdout candidate | Holdout CLV (pp) | α/k lower bound | `clv_ev` | k | Data confidence | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | NFL | W2 totals market-residual | +3.48 [+2.74, +4.30], n = 448 | +2.43 | **+2.1%** [+0.7, +3.6] | 13 | Medium. SBR lines; the proxy holdout sits inside the base models' tuning windows. 2026 out of sample: +2.91 pp, n = 54 | **PASS**; beats the vig on totals |
| 2 | CFB | R2 spread market-residual | +1.91 [+1.39, +2.40], n = 751 | +1.20 | -0.9% [-1.9, +0.0] | 16 | High. Multi-book archive; mandated holdout 2025 + 2026 | **PASS**; does not clear the vig |
| 3 | NHL | W2 moneyline market-residual on back-to-backs | +2.24 [+1.70, +2.77], n = 272 | +1.52 | +1.6% [-0.3, +4.2] | 12 | Medium. SBR moneylines, proxy holdout | **PASS**; borderline vig |
| 4 | NCAAM | production lab model, total | +1.58 [+1.26, +1.89], n = 2,552 | +1.24 | -1.5% | 3 | Medium. One holdout season of DraftKings; no tuning was possible | **PASS**; does not clear the vig |
| 5 | NBA | lab model total (and its totals residual) | +1.40 [+0.86, +1.98], n = 644 | +0.64 | -1.9% | 12 | Medium. SBR 2012–22 walk-forward; holdout is one DraftKings season. The production `nba/` engine could not be reproduced, so it was not tested | **PASS on totals only**; spread and moneyline FAIL after the penalty |
| 6 | WNBA | production lab model, total | +2.19 [+1.21, +3.17], n = 231 | +1.14 | -0.4% | 3 | Low. One season, 231 bets; spread and moneyline FAIL | **PASS on totals only** |
| 7 | MLB | R2 moneyline market-residual | +0.90 [+0.68, +1.17], n = 1,451 | +0.59 | -1.8% | 8 | Low. SBR MLB needed a pairing repair | **PASS**; far below the vig |
| — | NCAAW, UFC, college baseball, tennis | — | — | — | — | 0 | No opener data exists | **UNTESTED** |

**Player props (NFL and CFB, 2026 only):** the production props model beats the props opener (+0.58 / +0.55 pp) but sits about 5% below the props vig.

**Not counted as edge:** NHL totals (H2 / H4) pass at +3.25 / +2.63 pp. They are graded on the line alone, and SBR keeps no totals juice, so they are overstated by construction (`EXPERIMENTS.md`, NHL).

**Five things hold across sports:**

1. **The models carry information the opener does not.** Every served model that could be tested beats the opener on at least one market, out of sample: CFB, NFL, NHL, MLB (the loop's lab model) and NCAAM. The market moves 10–20% of a good model's disagreement toward it by the close. Fitted market-residual slopes: CFB 0.10 per model, NFL 0.14, NHL 0.21 on the projected-goalie model.

2. **The market-residual model is the best design everywhere it could be built.** "Opener as the prior, model disagreement as the evidence" earned more CLV per bet than its base models in CFB, NFL, NHL and MLB, both before the holdout and on it. In CFB the holdout went from +1.19 to +1.91 pp.

3. **Beating the close is not the same as beating the vig.** Only NFL totals (and, at the margin, NFL spreads and NHL back-to-backs) clear -110 on average at the pre-registered thresholds. Elsewhere the opening bet earns CLV of 0.7–1.9 pp against a 2.4 pp vig. In the descriptive buckets, the largest-disagreement bets clear the vig in CFB and NFL. Those buckets were not pre-registered, so they are the next experiment, not a result.

4. **Several weak-spot hypotheses failed:**
   - CFB non-Power games: no more CLV than other games.
   - NHL projected-goalie filter: no clear gain.
   - MLB rotation disruption: no CLV (FAIL).
   - NBA spreads and moneylines: positive, but they FAIL after the penalty.
   - NFL backup-QB games: only marginally more CLV.
   - The information blocks helped in CFB, NHL and MLB and hurt in NFL.

5. **Leakage mattered.** NFL's committed backtests price the QB who actually started and the game-day weather. Replacing those with the previous starter and no weather moved v2.1.0 by 0.76 pts on average. The CFB loop's backtest, the NBA tip-off timing and MLB's actual starters had the same class of leak. Every number above uses opener-time inputs only.

## Production was not touched

- No live slate, params file, `current` pointer or board number was changed.
- Base models were replayed read-only, through their own exported functions or in a scratch git worktree.
- Two engines rewrite committed files when run (`hockey/model/walkforward.js`, `npm run nba:backfill`). Neither touched this branch: the hockey run was in a worktree, and the NBA data rewrites were restored with git.

**Passing candidates go to live tracking only:**
- Every one is recorded in `research/clv/live/registry.json`.
- Every challenger is also an entry in its sport's existing version history (`docs/model-loop/{cfb,nfl,mlb,nba}/versions.json`, status `CANDIDATE (CLV live tracking)`, `current` unchanged). That history is mirrored to Supabase `research_model_versions` by the existing `db_sync`, which now labels these entries correctly.
- `research/clv/live.py`, run every two hours by `.github/workflows/clv-live.yml`, captures each candidate's opener-time inputs from the numbers EdgeDesk already publishes and grades them against the close into `research/clv/live/summary.json`.
- Promotion to the board stays with the existing promotion systems and their owner.

---

## CFB

**Data:**
- cfbfastR multi-book archive, with the opener books' same-book open → close:
  - 5Dimes 2012–19;
  - Bovada / DraftKings / ESPN Bet 2021–25;
  - no openers in 2020.
- Walk-forward: 2012–19 and 2021–24 (about 9,500 games).
- Holdout: 2025 (938 games) + 2026 (251 games, the CFB Lab's DraftKings first-seen open → close).

**Tried (16 attempts):**
- Production cfb_p4 v1.0.1, spread and total.
- Loop v2.0.0, re-run with the previous game's QB because its backtest priced the actual starter.
- Shadow cfb_v2 candidate 001.
- Market-residual models R1 and R2 (R2 adds an information block).
- Non-Power filter (W1) and totals residual (W3).
- Two drift diagnostics.
- One player-props holdout run (CFB-P1).

**What worked (pre-holdout):**
- Every spread model: +0.72 (production) to +1.44 pp (R2). Positive in every season, roughly halved in the US-retail opener era.
- Loop v2 totals: +1.69 pp.
- Totals residual: +2.07 pp.

**What failed:**
- Production totals pre-holdout: +0.07 pp, p = 0.30.
- The non-Power hypothesis: +1.13 pp vs +1.27 overall, so not more.
- Constant drift explains none of it: 0 bets.

**Holdout:**

| ID | Bets | CLV pts | CLV prob (pp) | α/16 LB | 2025 / 2026 | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|---|
| H1 production spread | 795 | +0.475 [+0.271, +0.688] | +1.19 [+0.66, +1.73] | +0.45 | +1.21 / +1.07 | -2.3% | PASS |
| H2 production total | 590 | +0.415 [+0.202, +0.632] | +0.99 [+0.50, +1.50] | +0.29 | +1.02 / +0.87 | -2.6% | PASS |
| H3 R2 residual spread | 751 | +0.761 [+0.558, +0.953] | +1.91 [+1.39, +2.40] | +1.20 | +2.10 / +1.13 | -0.9% [-1.9, +0.0] | PASS |
| H4 W3 residual total | 757 | +0.616 [+0.432, +0.783] | +1.48 [+1.03, +1.89] | +0.88 | +1.50 / +1.41 | -1.7% | PASS |
| P1 production props model, player props (2026, same-line bets) | 537 | – | +0.55 [+0.35, +0.78] | +0.28 | – / +0.55 | -5.0% | PASS on CLV. Where the line moved, it moved toward the model 61.9% of the time (596 bets) |

**Verdict.** CFB models find real early-line value.
- The best form is R2: open + 0.10 × each model's disagreement, adjusted early in the season.
- None clears the -110 vig on average.
- **Caveat:** production's coefficients were fitted on 2001–2025 outcomes, so its clean out-of-sample evidence is 2026 alone (+1.07 / +0.87 pp).
- **Next:** pre-register a large-disagreement threshold (|predicted move| ≥ 1.0). In the descriptive buckets that is where CLV exceeds the vig: +2.8 pp, `clv_ev` +1%.

## NFL

**Data:**
- Openers exist only in the SBR archive (2011–2021) and EdgeDesk's 2026 first-seen ledger (77 games).
- The mandated 2025 holdout has no openers, so the gate is a **proxy holdout, SBR 2020–21**, locked before any result.
- Line check: SBR closes agree with the nflverse close within 1 point on 96.6% of games.

**Tried (13 attempts):**
- Production v2.1.0 and loop v2.0.0, spread and total. Both replayed with the previous starter and no game-day weather; the committed backtests use the actual starter and the observed weather.
- R1 and R2 market-residual models.
- Backup-QB games (W1) and totals residual (W2).
- First-half: no 1H lines exist, so it was not run.
- One player-props holdout run (NFL-P1).

**What worked (pre-holdout, 2011–19):**
- Every rule was positive in every season: production spread +1.39, production total +2.08, R1 +1.96, W2 +2.54 pp.

**What failed:**
- R2: the information block (rest, backup QB, early season, favourite level) made R1 worse on the same games, +1.74 vs +1.96 pp.
- The backup-QB filter added little: +1.54 vs +1.39 pp.

**Holdout:**

| ID | Proxy bets | CLV pts | CLV prob (pp) | α/13 LB | 2020 / 2021 | `clv_ev` | 2026 (out of sample) | Verdict |
|---|---|---|---|---|---|---|---|---|
| H1 production spread | 384 | +0.578 [+0.272, +0.900] | +1.79 [+0.81, +2.80] | +0.45 | +1.24 / +2.35 | -1.1% | +2.16 pp, n = 52 | PASS |
| H2 production total | 422 | +0.995 [+0.746, +1.266] | +2.97 [+2.23, +3.77] | +1.93 | +2.67 / +3.31 | +1.1% | +2.83 pp, n = 48 | PASS |
| H3 R1 residual spread | 290 | +0.898 [+0.571, +1.251] | +2.94 [+1.92, +4.02] | +1.51 | +2.67 / +3.20 | +1.0% | +3.44 pp, n = 37 | PASS |
| H4 W2 residual total | 448 | +1.162 [+0.911, +1.439] | +3.48 [+2.74, +4.30] | +2.43 | +3.43 / +3.52 | **+2.1%** [+0.7, +3.6] | +2.91 pp, n = 54 | PASS |
| P1 production props model, player props (2026, same-line bets) | 773 | – | +0.58 [+0.46, +0.70] | +0.43 | – | -4.9% | (2026 only) | PASS on CLV. Where the line moved, it moved toward the model 53.7% of the time (497 bets) |

**Verdict.** NFL shows the strongest edge in the programme, and the only rule whose interval clears the vig: W2 totals.
- The NFL market moved about 14% of production's disagreement and about 20% of the loop's total disagreement toward them.

**Caveats:**
- The proxy-holdout seasons lie inside the base models' hyperparameter windows (selected on final scores, not line moves).
- The fully clean evidence is 2026: n ≈ 50 per rule, all positive.
- SBR openers are a single reference book. Opening limits are small, so this is value at the opener, not at volume.

## NHL

**Data:**
- SBR moneyline open and close (two-way) for repo 2014–2022.
- Totals have one price per row and rarely move: graded on the line alone, low confidence.
- The mandated 2026–27 holdout has no opener with a close, so the gate is a **proxy holdout, repo 2021–22**.

**Tried (12 attempts):**
- Production xg_core (moneyline and total line).
- The projected-goalie candidate.
- R1 and R2 market-residual models.
- Projected-goalie games (W1), back-to-backs (W2) and totals residual (W3).
- **Not testable:** the confirmed goalie (post-game), and confirmation timing (no timestamps).

**What worked:**
- Production moneyline: +0.83 pp, every season positive.
- R2 beat R1: +0.94 vs +0.81.
- One-team back-to-backs: +1.12 pp.
- The residual puts its weight on the projected-goalie model (0.21) and almost none on the goalie-blind production model (0.04). The market moves toward the likely goalie.

**What failed:**
- The projected-goalie filter (W1) alone was no better than baseline: +0.91 vs +0.84.

**Holdout:**

| ID | Bets | CLV prob (pp) | α/12 LB | 2021 / 2022 | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| H1 production moneyline | 1,475 | +0.77 [+0.57, +0.97] | +0.50 | +0.27 / +1.12 | -2.0% | PASS |
| H2 production total (line only) | 951 | +3.25 [+2.88, +3.63] | +2.74 | +1.85 / +4.21 | +1.4% | PASS, low confidence |
| H3 W2 back-to-back residual | 272 | +2.24 [+1.70, +2.77] | +1.52 | +1.74 / +2.36 | +1.6% [-0.3, +4.2] | PASS |
| H4 W3 totals residual (line only) | 1,452 | +2.63 [+2.35, +2.92] | +2.25 | +1.46 / +3.52 | +0.3% | PASS, low confidence |

**Verdict.** Production beats the moneyline opener, but not by enough to clear the vig. The goalie-aware residual on back-to-backs is the strongest NHL rule and is borderline on the vig.
- **Next:** archive goalie confirmation times (`hockey/data/confirmed_starters.json`) and timestamped closes. Confirmation timing is the NHL information-timing factor this archive cannot test.

## MLB

**Data:**
- SBR MLB pairs each game's home side with another game's away side (every game). Repaired exactly by matching team rows to Retrosheet; repaired pairs pass the overround check 99.85% of the time.
- Totals cannot be attributed to games, so totals are infeasible.
- Walk-forward 2012–19; **proxy holdout 2020–21**.

**Tried (8 attempts):**
- The lab model with a rotation-projected starter. Probables were never archived; the projection matches the actual starter 66% of the time.
- The lab model with no starter.
- R1 and R2 market-residual models.
- Rotation-disruption filter (W1).
- Favourite-drift diagnostic.
- **Infeasible:** the live browser engine (season-level pitcher tables), bullpen fatigue (no data), weather (no archive).

**What worked:** small but positive CLV everywhere. Production +0.19 pp pre-holdout. R2 +0.70 pp, and better than R1 on the same games. Favourite drift alone places no bets.

**What failed:** W1, rotation disruption: +0.17 pp, p = 0.23.

**Holdout:**

| ID | Bets | CLV prob (pp) | α/8 LB | 2020 / 2021 | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| H1 lab model, projected starter | 2,117 | +0.69 [+0.52, +0.89] | +0.45 | +0.89 / +0.62 | -2.2% | PASS |
| H2 R2 residual | 1,451 | +0.90 [+0.68, +1.17] | +0.59 | +0.98 / +0.86 | -1.8% | PASS |

**Verdict.** Real but small, far below the moneyline vig.
- The model that prices the live card (`mlb/engine.js`) cannot be tested at all.
- **Next:** archive probable starters with timestamps, and a second book's openers.

## WNBA

**Data:** DraftKings open and close exist only for 2026, inside the mandated holdout. Phases 3–5 were infeasible, so this is one pre-registered run of the production lab model (3 attempts).

| ID | Bets | CLV prob (pp) | α/3 LB | `clv_ev` | Verdict |
|---|---|---|---|---|---|
| H1 spread | 198 | +0.61 [-0.37, +1.59] | -0.45 | -3.4% | **FAIL** |
| H2 total | 231 | +2.19 [+1.21, +3.17] | +1.14 | -0.4% | PASS |
| H3 moneyline | 271 | +0.55 [-0.11, +1.17] | -0.15 | -2.9% | **FAIL** |

**Verdict.** No demonstrated spread or moneyline edge. Totals pass on one small season.
- **Next:** start capturing WNBA lines. Neither the odds gateway nor Today's Games covers the WNBA.

## NCAAM

**Data:** DraftKings open and close exist only for 2025-26, the mandated holdout. Phases 3–5 were infeasible; one pre-registered run of the production lab model (3 attempts).

| ID | Bets | CLV pts | CLV prob (pp) | α/3 LB | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| H1 spread | 2,862 | +0.336 [+0.258, +0.424] | +1.03 [+0.76, +1.34] | +0.72 | -2.5% | PASS |
| H2 total | 2,552 | +0.661 [+0.540, +0.784] | +1.58 [+1.26, +1.89] | +1.24 | -1.5% | PASS |
| H3 moneyline | 3,363 | – | +0.77 [+0.64, +0.91] | +0.62 | -2.5% | PASS |

**Verdict.** The production model beats DraftKings openers on every market in a large sample, but by less than the vig.
- No market-residual model could be trained: there are no earlier openers.
- **Next:** capture this season's openers. 2026-27 starts 2026-11-02 and the live tracker logs the DraftKings line from Today's Games. With a second season, a residual model becomes possible.

## NBA

**Data:**
- SBR spread and total open and close, repo 2012–2022 (13,883 games; the archive has no moneyline opener).
- Holdout: ESPN DraftKings open and close with prices for 2025-26 (1,068 games).

**Models.** The production `nba/` engine (`G_stack_P`) was replayed through its exported walk-forward. It **failed its pre-registered reproduction check**:
- selection log loss 0.58910 vs the committed 0.59239;
- its non-ML member reproduces exactly; the stacked ML members do not.

Per the fallback written before any result:
- the production engine has no CLV verdict;
- every experiment used the model loop's served lab model, `edgedesk_bb_points_v1` / `points_rest`, predicted at 09:00 UTC on game day.

**Tried (12 attempts):**
- Lab spread and total.
- R1 and R2 market-residual models.
- One-team back-to-backs (W2), totals residual (W3), early season (W4).
- Five holdout runs.
- **Not testable:** late scratches (no injury timestamps exist) and the production engine's star-absence filter (W1).

**What worked (pre-holdout):**
- Totals: +1.55 pp, every season positive.
- Residual spreads: +2.10 pp, on few bets.
- Back-to-backs: +3.02 pp on 97 bets.

**What failed:**
- R2: the information block lowered per-bet CLV, although its back-to-back term (-0.5 pts toward the rested side) is real market structure.
- The lab spread is barely positive: +0.33 pp.

**Holdout:**

| ID | Bets | CLV pts | CLV prob (pp) | α/12 LB | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| H1 lab spread | 806 | +0.190 [+0.044, +0.333] | +0.57 [+0.13, +0.99] | -0.01 | -3.5% | FAIL |
| H2 lab total | 644 | +0.657 [+0.402, +0.935] | +1.40 [+0.86, +1.98] | +0.64 | -1.9% | PASS |
| H3 lab moneyline | 846 | – | +0.52 [+0.13, +0.95] | -0.03 | -2.9% | FAIL |
| H4 R1 residual spread | 88 | +0.273 [-0.198, +0.810] | +0.74 [-0.76, +2.39] | -1.35 | -3.1% | FAIL |
| H5 W3 residual total | 740 | +0.584 [+0.345, +0.833] | +1.24 [+0.72, +1.77] | +0.52 | -2.2% | PASS |

**Verdict.**
- NBA totals beat the DraftKings opener; no NBA rule clears the vig.
- Spreads and moneylines show positive CLV that does not survive the multiple-testing penalty.

**Next:**
- Make the production engine's ML stage reproducible (seeded GBDT, or the run's tuning recorded), then test `G_stack_P`.
- Pre-register the back-to-back rule on a second DraftKings season.

## NCAAW, UFC, college baseball, tennis

No opener with a matching close exists for any of them, so every phase after the audit was infeasible: 0 attempts, **UNTESTED**. `EXPERIMENTS.md` lists what would unlock each one.

Opening-line collection for NCAAW, UFC and college baseball, and for NHL 2026-27 and MLB, started on 2026-10-21. It writes to `research/clv/openers/`, and `research/clv/openers/summary.json` counts how many games each sport can be tested on so far.
