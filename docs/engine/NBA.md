# NBA — model card and build report (`edgedesk_nba_v1`)

> Status: **Validated against outcomes on the sealed test window (moneyline, spread, total: see §8), not tested against the market.** Fair lines are published; value claims are off.
> Research, not picks.

This is the NBA engine the brief asked for (sections 1–12). It sits beside the
other sports and changes none of them. The football, MLB, NHL and lab code is
untouched. The shared files gained one NBA entry each, and the tests that pin
those files were updated (§13). The research review behind the method choices
is [`NBA_RESEARCH.md`](NBA_RESEARCH.md).

Every number below comes from a committed artifact:

- `nba/validation/nba_walkforward.json`: the game record.
- `nba/validation/summary.json`: the slice of that record the panel reads.
- `nba/validation/nba_props_walkforward.json`: the props record.
- `nba/validation/holdout_log.json`: every time the test window was opened.
- `nba/params/`: the tuning and the live parameters.

Running `npm run nba:check` re-verifies the committed record, the props record and the slate.

---

## 1. Datasets and coverage

| Table | Source | Coverage | Where |
|---|---|---|---|
| Games (one row per game) | sportsdataverse `hoopR-nba-data` schedules (public parquet on raw.githubusercontent.com, compiled from ESPN's NBA feeds) | 2002-03 → 2026-27: 30,930 final club games (regular season, NBA Cup final, Play-In, playoffs: `scope`); 1,200 scheduled 2026-27 games | `nba/data/games/<season>.csv` |
| Team games (two per game) | hoopR team box + play-by-play | 61,860 rows: box score, possessions (BBRef estimator), five shot zones, transition proxy, rest, back-to-back, games in 7 days, travel km, time-zone shift, altitude, road trip / home stand | `nba/data/team_games/<season>.csv` |
| Player games | hoopR player box | 642,419 appearances (a 0-minute entry on court counts); starter flag; DNP reason category from 2012-13 | `.cache/nba_work` (rebuilt by `npm run nba:backfill`), `nbahist.player_games` |
| Lineup stints | reconstructed from play-by-play substitutions | 935,727 stints in 30,581 games; every on-court five with seconds, possessions and points | `.cache/nba_work`; five-man units per team-season in `nba/data/lineups/<season>.json` |
| Shots | play-by-play | 5,130,625 field-goal attempts with zone and distance | `.cache/nba_work` |
| ESPN displayed spread | play-by-play `game_spread` | 18,080 games, 2012-13 on | `games.ref_line_home`: **a diagnostic only** (no timestamp, no book, no price) |
| Rosters | hoopR rosters | 2025-26 and 2026-27 snapshots | used only for the labelled preseason roster scenario |
| Second retrieval | the NBA Data Pack (`datapack/nba_v1`: ESPN's site API read directly, 2025-26) | verified 30/30 (`tools/datapack/verify_nba.js`), reconciled game by game (`nba/crosscheck/pack.js`) | `docs/engine/DATAPACK.md` |

**Integrity, measured per season** (`nba/data/manifest.json`):

- **Period scores.** From 2019-20 they come from the schedule's linescores. Before that they come from the play-by-play, and a game is dropped from half and quarter scoring when its periods do not sum to the final. That happened in about 25% of games from 2002-03 to 2005-06 (burn-in only) and in fewer than 30 games a season after 2006-07.
- **Minutes from the stints.** The reconstructed stints reproduce the box-score minutes with a mean absolute error of 0.25 minutes per player-game.
- **Team box points** match the final in every game kept.
- **Against the NBA Data Pack** (2025-26, `docs/engine/DATAPACK.md`):
  - All 1,322 games, every final, overtime and period score agree.
  - Every player stat on 28,617 played rows agrees.
  - Stint minutes match the box to 0.25 minutes.
- **Three ingest errors the reconciliation exposed are fixed for every season:**
  - the NBA Cup final is now its own `scope`;
  - a 0-minute garbage-time entry is an appearance;
  - club games only: an unnoted 2003 All-Star game and TBD Cup placeholders are dropped.

**Time.** The NHL rule is used unchanged.

- `known_at` is blank on every row, because first publication was never recorded and nothing is backdated.
- `assumed_available_at` is the scheduled start plus 4 hours.
- `pit` is `RETRO`.
- Every game is predicted at tip − 30 minutes from the games available by then. The leakage audit over 24,440 predictions found 0 violations.

## 2. Authorisation and limits

**Licensing.**

- **The data is public but not licensed for commercial use.** The `hoopR-nba-data` repository is MIT-licensed, but its game data is ESPN's and the NBA's, and the repository's licence grants no rights to it. ESPN's and NBA.com's terms restrict commercial use. **The owner must review before NBA output is sold in a paid tier.** The licence notice is printed on every NBA artifact (`nba/config.js` LICENSE).
- **NBA Stats (stats.nba.com) and `swar/nba_api` are not used.** NBA Stats was unreachable from this build, and its terms restrict automated and commercial use. `nba_api`'s MIT licence covers the client only.
- **No proprietary model was copied.** Rithmm's posts could not be fetched (DNS refused). Nothing of theirs is used.

**Spending.**

- **No paid feed was activated.** NBA prices are captured only when **both** of these are set: the repository variable `NBA_PRICES=on`, and the gateway row `basketball_nba` (inserted **disabled** by `supabase/nba_odds_sport.sql`). Until then `nba/market/quotes.json` reads DISABLED and every market block says so.
- **The Supabase copy is not written** unless `NBA_SUPABASE=on`.
- **Only the static site ships on merge.** The owner merged the engine into `main`, and GitHub Pages serves the panel from there. No migration was applied, the edge function was not redeployed, and nothing was bought (§14).

## 3. Models trained

Seventeen candidates are scored on the same games, in seven families plus two baselines. All are point-in-time.

| Id | Family | What it is |
|---|---|---|
| `home_only` | baseline | home court only |
| `lab_points` | baseline | **the existing NBA model** (basketball lab points ratings) |
| `A_elo`, `A_glicko` | A | Elo in FiveThirtyEight's NBA form, and Glicko with rating deviation. Both tuned on the selection window (K, home court and carry; c, summer RD inflation, scale and home court) |
| `B_eff` | B | opponent-adjusted offence, defence and pace, plus the four factors and shooting luck (actual minus location-expected eFG), by recency-weighted least squares |
| `F_kalman` | F | Bayesian dynamic linear model: each team's offence and defence as a random walk with full covariance, between-season carry, and the posterior sd as uncertainty |
| `C_players_P` / `_C` | C | RAPM: ridge on every lineup stint (preconditioned conjugate gradient), weighted by recency. Team strength is impact × expected minutes, scaled to 240 minutes. P = projected availability (the previous game's rotation), C = confirmed (who played) |
| `C_team_avail_P` / `_C` | C | Kalman team rating plus the change in player strength from the team's usual rotation |
| `D_sim` | D | possession simulation: four-factor rates, pace, end-game fouling and overtime, with the level anchored to B's points per possession |
| `E_ridge`, `E_logit`, `E_gbdt` (× P, C) | E | ridge regression, ridge logistic, and gradient-boosted trees (own histogram implementation, early stopping on the season before) on 50+ point-in-time features. Calibrated by the shared rule below |
| `G_stack_P` / `_C` | G | ridge stack of Elo, B, Kalman, availability, ridge and GBDT, fitted only on out-of-sample predictions |

**Hyperparameters** (`nba/params/tuning.json`, with each family's full grid) were chosen on the **selection window only**, each family by its own signal's walk-forward log loss:

- **Elo:** K 16, home court 60, carry 0.6.
- **Glicko:** c 6, summer 80, scale 0.7, home court 90.
- **Adjusted ratings:** half-life 120 days, 16 prior games, carry 0.7.
- **Kalman:** q 0.02, summer 4, carry 0.7.
- **RAPM:** λ 1500, half-life 365 days.
- **ML:** ridge and ridge-logistic penalty 300 (of 3, 30, 300); boosted trees depth 2, learning rate 0.08, minimum leaf 150 (12-point grid; depth 3 tied and the simpler tree was kept), early stopping on the season before.

## 4. Methodology

**Windows.** These were written into `nba/config.js` before any candidate was scored, and never moved.

- **Burn-in, 2003–2007:** used to train ratings, never scored.
- **Selection, 2008–2017:** every choice is made here.
- **Test, 2018–2026:** sealed until every choice was frozen, then scored once on 2026-10-14 by the frozen specification. The game models and the props were each scored once, and both scorings are logged with their specification's hash in `nba/validation/holdout_log.json`. If the specification changes, the weekly job seals the window again.
- **Live, 2027.**

**Nesting.** For each scored season S:

- Each candidate's calibration is fitted on the out-of-sample rows of S−3…S−1. That covers location and slope on the margin, with a stage interaction for early-season games, plus the total and the halves.
- The end-game shape and the overtime parameters are fitted on the same rows.
- The ML models are trained on the seasons before S.
- GBDT early stopping uses S−1 and then refits.

There is no random split anywhere. There is one row per game (no mirrored team rows), so a game's mirror can never leak its label.

**One distribution per game** (`nba/model/distribution.js`). Every market is read from the same probability mass function: moneyline, spread and alternates, total and alternates, team totals, first half, first quarter, overtime, and the score ranges.

- **Regulation margin.** A discretised normal with σ = s0 + s1·min(|μ|, 10). It is reshaped by fitted end-game weights oriented to the favourite: the tie mass, and the favourite's and the underdog's margins of 1–10.
- **Overtime.** Entered from a regulation tie. The overtime margin is N(κμ, sd), with κ fitted (the favourite's measured edge).
- **Total.** A normal mixture over the number of overtimes.
- **Team totals.** From the joint margin–total pmf.
- **Halves and quarters.** Scaled from the full-game mean with fitted fractions.
- **Pushes.** Whole-number lines carry their push probability. Ladders step in half points.

**Choice.** Per track, the lowest selection moneyline log loss wins. A challenger must beat the simpler incumbent by ≥ 0.001 (`engine/lab/protocol`), so the ensemble is kept only if it earns its complexity.

**Scoring.**

- Moneyline: log loss, Brier, calibration slope and calibration-in-the-large, with bins.
- Margin and total: CRPS, PIT and 80% coverage.
- Threshold calibration for the alternate lines.
- First half and first quarter: CRPS.
- Comparisons: a date-blocked paired bootstrap with 95% intervals.

**Market.** No licensed archive of timestamped NBA prices exists here, so:

- Every market is **NOT_TESTED**.
- There is no ROI and no CLV.
- ESPN's displayed spread is reported only as the labelled diagnostic it is.
- No "no-vig consensus" baseline is computed, because there are no timestamped quotes to build one from.

**The price adapter, ready for authorised quotes** (`nba/market/`, the slate's market block):

- **The model's view, priced at each book's own line.** For each quote: the model's probability at that line, with pushes priced; the book's break-even; and EV at the exact price.
- **The market's view, beside the model.** The no-vig market probability comes from four methods (multiplicative, additive, power, Shin), with their spread shown as the method's sensitivity. It is labelled `MARKET_DERIVED` and never blended into the `MARKET_INDEPENDENT` model.
- **Quote hygiene.**
  - A quote older than 60 minutes is STALE.
  - A quote after tip is STARTED and never compared.
  - A book listed twice keeps its latest update.
  - Two provider events for one game are reported, never merged.
- **PASS gates.** Every game carries seven gates and a decision: a market-tested model, an outcome record, fresh prices, confirmed availability, settlement rules per book, identity mapping and sample size. A game can be called only when all seven pass. Today the first gate fails everywhere, so every decision is PASS. Nothing ranks a failed game, and no game is forced.

## 5. Model comparison

**Selection window 2008–2017** (every choice was made here; it is optimistic by construction):

| Candidate | n | ML log loss | Brier | Cal. slope | Margin CRPS | 80% cov. | Total CRPS | 80% cov. | Margin MAE model / ESPN line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `home_only` | 12,897 | 0.67446 | 0.2407 | 0.490 | 7.500 | 0.802 | 11.470 | 0.804 | 10.87 / 9.51 |
| `lab_points` | 11,581 | 0.59497 | 0.2046 | 1.023 | 6.726 | 0.806 | 9.917 | 0.807 | 9.70 / 9.51 |
| `A_elo` | 12,897 | 0.59526 | 0.2048 | 1.073 | 6.747 | 0.803 | 9.938 | 0.806 | 9.71 / 9.51 |
| `A_glicko` | 12,897 | 0.59451 | 0.2044 | 1.069 | 6.742 | 0.803 | 9.938 | 0.806 | 9.70 / 9.51 |
| `B_eff` | 12,897 | 0.59468 | 0.2045 | 1.065 | 6.733 | 0.802 | 9.938 | 0.806 | 9.71 / 9.51 |
| `F_kalman` | 12,897 | 0.59360 | 0.2040 | 1.071 | 6.725 | 0.803 | 9.956 | 0.805 | 9.71 / 9.51 |
| `D_sim` | 12,897 | 0.60705 | 0.2093 | 1.601 | 6.906 | 0.898 | 10.013 | 0.764 | 9.74 / 9.51 |
| `C_players_P` | 12,897 | 0.59639 | 0.2052 | 1.080 | 6.745 | 0.801 | 9.956 | 0.805 | 9.73 / 9.51 |
| `C_team_avail_P` | 12,897 | 0.59123 | 0.2031 | 1.068 | 6.699 | 0.803 | 9.956 | 0.804 | 9.66 / 9.51 |
| `E_ridge_P` | 12,897 | 0.59021 | 0.2028 | 1.057 | 6.684 | 0.802 | 9.916 | 0.805 | 9.64 / 9.51 |
| `E_logit_P` | 12,897 | 0.59041 | 0.2028 | 1.043 | 6.688 | 0.802 | 9.916 | 0.805 | 9.65 / 9.51 |
| `E_gbdt_P` | 12,897 | 0.59016 | 0.2025 | 1.038 | 6.692 | 0.801 | 10.017 | 0.803 | 9.61 / 9.51 |
| `G_stack_P` **(chosen)** | 12,897 | 0.58888 | 0.2022 | 1.041 | 6.676 | 0.799 | 9.917 | 0.803 | 9.63 / 9.51 |
| `C_players_C` | 12,897 | 0.58894 | 0.2018 | 1.112 | 6.711 | 0.801 | 9.956 | 0.805 | 9.69 / 9.51 |
| `C_team_avail_C` | 12,897 | 0.58673 | 0.2011 | 1.084 | 6.680 | 0.803 | 9.956 | 0.804 | 9.64 / 9.51 |
| `E_ridge_C` | 12,897 | 0.58536 | 0.2006 | 1.071 | 6.654 | 0.801 | 9.918 | 0.803 | 9.60 / 9.51 |
| `E_logit_C` | 12,897 | 0.58454 | 0.2002 | 1.058 | 6.656 | 0.801 | 9.918 | 0.803 | 9.61 / 9.51 |
| `E_gbdt_C` | 12,897 | 0.58621 | 0.2007 | 1.032 | 6.655 | 0.803 | 10.012 | 0.803 | 9.55 / 9.51 |
| `G_stack_C` **(chosen)** | 12,897 | 0.58421 | 0.2001 | 1.040 | 6.642 | 0.800 | 9.917 | 0.803 | 9.57 / 9.51 |

**Test window 2018–2026** (scored once with the frozen specification; 1 unsealing logged in `nba/validation/holdout_log.json`):

| Candidate | n | ML log loss | Brier | Cal. slope | Margin CRPS | 80% cov. | Total CRPS | 80% cov. | Margin MAE model / ESPN line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `home_only` | 11,543 | 0.68660 | 0.2467 | 0.148 | 8.403 | 0.794 | 11.803 | 0.788 | 12.02 / 10.49 |
| `lab_points` | 11,543 | 0.62391 | 0.2173 | 1.029 | 7.681 | 0.793 | 10.566 | 0.794 | 10.90 / 10.49 |
| `A_elo` | 11,543 | 0.62377 | 0.2173 | 1.053 | 7.684 | 0.795 | 10.623 | 0.794 | 10.90 / 10.49 |
| `A_glicko` | 11,543 | 0.62403 | 0.2174 | 1.052 | 7.685 | 0.795 | 10.623 | 0.794 | 10.91 / 10.49 |
| `B_eff` | 11,543 | 0.62481 | 0.2177 | 1.028 | 7.692 | 0.793 | 10.622 | 0.793 | 10.91 / 10.49 |
| `F_kalman` | 11,543 | 0.62404 | 0.2174 | 1.020 | 7.681 | 0.794 | 10.617 | 0.795 | 10.90 / 10.49 |
| `D_sim` | 11,543 | 0.63146 | 0.2205 | 1.417 | 7.805 | 0.871 | 10.652 | 0.756 | 10.95 / 10.49 |
| `C_players_P` | 11,543 | 0.62172 | 0.2164 | 1.011 | 7.648 | 0.796 | 10.617 | 0.795 | 10.86 / 10.49 |
| `C_team_avail_P` | 11,543 | 0.62143 | 0.2162 | 1.004 | 7.645 | 0.794 | 10.617 | 0.795 | 10.84 / 10.49 |
| `E_ridge_P` | 11,543 | 0.61681 | 0.2142 | 1.021 | 7.584 | 0.796 | 10.548 | 0.795 | 10.76 / 10.49 |
| `E_logit_P` | 11,543 | 0.61710 | 0.2143 | 1.036 | 7.592 | 0.796 | 10.549 | 0.795 | 10.77 / 10.49 |
| `E_gbdt_P` | 11,543 | 0.61832 | 0.2148 | 1.003 | 7.608 | 0.793 | 10.682 | 0.792 | 10.79 / 10.49 |
| `G_stack_P` **(chosen)** | 11,543 | 0.61779 | 0.2145 | 0.999 | 7.594 | 0.794 | 10.560 | 0.794 | 10.77 / 10.49 |
| `C_players_C` | 11,543 | 0.61303 | 0.2124 | 1.038 | 7.589 | 0.794 | 10.618 | 0.795 | 10.78 / 10.49 |
| `C_team_avail_C` | 11,543 | 0.61561 | 0.2135 | 1.018 | 7.607 | 0.793 | 10.618 | 0.795 | 10.79 / 10.49 |
| `E_ridge_C` | 11,543 | 0.61104 | 0.2116 | 1.032 | 7.538 | 0.794 | 10.535 | 0.794 | 10.70 / 10.49 |
| `E_logit_C` | 11,543 | 0.61059 | 0.2114 | 1.044 | 7.544 | 0.793 | 10.536 | 0.795 | 10.71 / 10.49 |
| `E_gbdt_C` | 11,543 | 0.61205 | 0.2120 | 0.994 | 7.542 | 0.793 | 10.648 | 0.793 | 10.69 / 10.49 |
| `G_stack_C` **(chosen)** | 11,543 | 0.61164 | 0.2118 | 0.994 | 7.539 | 0.793 | 10.545 | 0.794 | 10.68 / 10.49 |

The last column puts the model's margin error beside the error of ESPN's displayed spread on the same games (2012-13 on). That spread has no timestamp, names no book and carries no price: a **diagnostic** of accuracy, never a market test and never a basis for ROI. The line is the better margin forecaster — it knows the injury report.

`lab_points` is scored on fewer games because the existing lab model covers fewer seasons. Labels: `home_only` Home court only; `lab_points` Basketball lab points ratings (the existing NBA model); `A_elo` Elo (FiveThirtyEight NBA form, tuned); `A_glicko` Glicko (rating deviation, tuned); `B_eff` Adjusted possession efficiency and pace; `F_kalman` Bayesian dynamic model (Kalman); `D_sim` Possession simulation (four factors, pace, end-game fouling, overtime; level anchored to B); `C_players_P` Player impact (RAPM) × projected minutes; `C_team_avail_P` Kalman team rating + projected availability adjustment; `E_ridge_P` Ridge regression on all projected features; `E_logit_P` Ridge logistic on all projected features; `E_gbdt_P` Gradient-boosted trees on all projected features; `G_stack_P` Stacked ensemble (projected); `C_players_C` Player impact (RAPM) × confirmed availability; `C_team_avail_C` Kalman team rating + confirmed availability adjustment; `E_ridge_C` Ridge regression with confirmed availability; `E_logit_C` Ridge logistic with confirmed availability; `E_gbdt_C` Gradient-boosted trees with confirmed availability; `G_stack_C` Stacked ensemble (confirmed).

## 6. Selected model and justification

Chosen by the rule written before scoring: per track, the lowest **selection** moneyline log loss, a challenger replacing the incumbent only by ≥ 0.001 (simplest first: Elo → Glicko → B → Kalman → simulation → players → availability → ridge → logistic → trees → stack).

- **Projected track (the published price): `G_stack_P`.** Selection log loss 0.58888 against tuned Elo 0.59526, the best single learner `E_gbdt_P` 0.59016 and Kalman availability `C_team_avail_P` 0.59123.
- **Confirmed track (who actually played; the ceiling a lineup feed could reach): `G_stack_C`** at 0.58421. The confirmed track is never used for a published price.
- **Held out (2018–2026, 11,543 games, scored once):**
  - `G_stack_P` has log loss 0.61779, Brier 0.2145 and calibration slope 0.999.
  - That compares with Elo at 0.62377 and the existing lab model at 0.62391.
  - It beats Elo in 8 of 9 test seasons.
  - Every candidate scores worse on 2018–2026 than on 2008–2017 (log loss about 0.60–0.64 a season, against 0.57–0.62).
  - The later seasons are harder to call for all of them. The record measures this but does not explain it.

On the **test window**, paired by date (date-blocked bootstrap, 95% intervals; negative favours the chosen model):

| Projected `G_stack_P` against | ML log loss | Margin CRPS | Total CRPS |
|---|---|---|---|
| `A_elo` | -0.0060 (-0.0086 to -0.0033) | -0.090 (-0.114 to -0.064) | -0.063 (-0.086 to -0.038) |
| `lab_points` | -0.0061 (-0.0088 to -0.0034) | -0.087 (-0.111 to -0.062) | -0.006 (-0.034 to +0.024) |
| `F_kalman` | -0.0063 (-0.0088 to -0.0037) | -0.087 (-0.111 to -0.063) | -0.057 (-0.080 to -0.030) |
| `C_team_avail_P` | -0.0036 (-0.0054 to -0.0018) | -0.051 (-0.069 to -0.033) | -0.057 (-0.080 to -0.031) |
| `E_ridge_P` | +0.0010 (+0.0001 to +0.0018) | +0.009 (+0.001 to +0.017) | +0.012 (+0.005 to +0.018) |
| `E_gbdt_P` | -0.0005 (-0.0016 to +0.0007) | -0.015 (-0.025 to -0.003) | -0.123 (-0.157 to -0.088) |

| Confirmed `G_stack_C` against | ML log loss | Margin CRPS | Total CRPS |
|---|---|---|---|
| `A_elo` | -0.0121 (-0.0153 to -0.0088) | -0.145 (-0.174 to -0.115) | -0.078 (-0.104 to -0.052) |
| `lab_points` | -0.0123 (-0.0157 to -0.0089) | -0.142 (-0.171 to -0.112) | -0.021 (-0.050 to +0.010) |
| `C_team_avail_C` | -0.0040 (-0.0062 to -0.0018) | -0.068 (-0.090 to -0.047) | -0.073 (-0.098 to -0.046) |
| `E_ridge_C` | +0.0006 (-0.0006 to +0.0018) | +0.001 (-0.010 to +0.012) | +0.010 (+0.002 to +0.017) |
| `E_logit_C` | +0.0011 (-0.0002 to +0.0024) | -0.006 (-0.018 to +0.007) | +0.009 (+0.002 to +0.016) |
| `E_gbdt_C` | -0.0004 (-0.0013 to +0.0006) | -0.003 (-0.014 to +0.006) | -0.103 (-0.135 to -0.071) |

## 7. Ensemble contribution

The stack is a ridge regression (penalty 10) of the regulation margin on 6 out-of-sample inputs — `elo_z`, `eff_m`, `kal_m`, `adj_proj`, `mlP_ridge_m`, `mlP_gbdt_m` — each with an early-season interaction, refitted for every season on the three before it (no input is ever its own training data).

| Stack against the best single learners | Selection 2008–2017 | Test 2018–2026 |
|---|---|---|
| `G_stack_P` − `E_ridge_P` (log loss) | -0.0013 (-0.0023 to -0.0004) | +0.0010 (+0.0001 to +0.0018) |
| `G_stack_P` − `E_logit_P` (log loss) | -0.0015 (-0.0025 to -0.0005) | +0.0007 (-0.0004 to +0.0018) |
| `G_stack_P` − `E_gbdt_P` (log loss) | -0.0013 (-0.0027 to +0.0000) | -0.0005 (-0.0016 to +0.0007) |
| `G_stack_C` − `E_ridge_C` (log loss) | -0.0012 (-0.0023 to +0.0000) | +0.0006 (-0.0006 to +0.0018) |
| `G_stack_C` − `E_logit_C` (log loss) | -0.0003 (-0.0015 to +0.0009) | +0.0011 (-0.0002 to +0.0024) |
| `G_stack_C` − `E_gbdt_C` (log loss) | -0.0020 (-0.0034 to -0.0007) | -0.0004 (-0.0013 to +0.0006) |

**The ensemble did not earn its complexity out of sample.**

- **Selection window.** It cleared the pre-registered 0.001 margin over the incumbent ridge in both tracks.
- **Test seasons.** Plain ridge was slightly *better* in the projected track (+0.0010 (+0.0001 to +0.0018)). Every other learner difference is inside its interval.
- **Against the rating systems,** the gain is large and holds out of sample (§6).

The brief says to keep the simpler model if the ensemble does not help. But that call is made on the selection window. Switching to ridge now would be choosing on the test set, which the protocol forbids. So the published price stays the stack, whose test calibration slope is 0.999, and the result is recorded. **The next specification should start from ridge as the incumbent and be judged on a fresh holdout**: the 2026-27 season, as the ledger grades it.

- **Weights** (the 2026 fit, on 2023–2025, margin points per unit of each input, before the stage interactions): `elo_z` -0.58, `eff_m` -0.30, `kal_m` 0.57, `adj_proj` 0.09, `mlP_ridge_m` 0.48, `mlP_gbdt_m` 0.30.
  - The inputs are strongly collinear, so no single weight can be read alone. The Elo term turns negative once the others carry the same signal.
  - The weights move from season to season, which is why each season is refitted only on its own past.
- **The simulation (D)** is not in the stack. It is the weakest candidate (test log loss 0.63146, calibration slope 1.42), because it omits and-ones and bonus free throws and its spread of outcomes is too wide.

## 8. Moneyline, spread and total calibration

**Moneyline** (`G_stack_P`, test window): log loss 0.61779, Brier 0.2145, calibration slope 0.999, calibration in the large +0.0071.

| Priced at | n | Model | Observed | 95% (Wilson) |
|---|---:|---:|---:|---:|
| 0–10% | 4 | 8.2% | 0.0% | 0.0–49.0% |
| 10–20% | 206 | 17.2% | 11.7% | 8.0–16.8% |
| 20–30% | 748 | 25.5% | 23.9% | 21.0–27.1% |
| 30–40% | 1334 | 35.5% | 34.6% | 32.1–37.2% |
| 40–50% | 1746 | 45.1% | 45.5% | 43.1–47.8% |
| 50–60% | 2134 | 55.1% | 55.1% | 52.9–57.2% |
| 60–70% | 2355 | 65.0% | 63.9% | 61.9–65.8% |
| 70–80% | 1915 | 74.6% | 73.8% | 71.8–75.7% |
| 80–90% | 994 | 84.2% | 83.5% | 81.1–85.7% |
| 90–100% | 107 | 91.8% | 90.6% | 83.7–94.8% |

One bin falls outside its 95% interval. Games priced 10–20% for the home side won 11.7% of the time (206 games), so long home underdogs are priced a little too high. Every other bin's observed rate sits inside its interval.

**Spread** (the margin distribution, overtime included): CRPS 7.594, mean bias +0.230 points, 80% interval coverage 0.794.
**Total**: CRPS 10.560, mean bias +0.056 points, 80% coverage 0.794.
**First half / first quarter**: margin CRPS 6.130 / 4.615, total CRPS 6.909 / 4.686.
**Overtime**: mean predicted P(OT) 0.0538 against 0.0522 observed.

**Status by market** (the protocol's rules, `engine/lab/protocol`): P: moneyline OUTCOME_VALIDATED, spread OUTCOME_VALIDATED, total OUTCOME_VALIDATED · C: moneyline OUTCOME_VALIDATED, spread OUTCOME_VALIDATED, total OUTCOME_VALIDATED. Against the market: **NOT_TESTED** everywhere.

## 9. Prop validation

**Model** (`nba/props/model.js`): expected minutes × per-minute rate × context, never a fixed bump for an absent star.

- **Minutes.** A ridge regression of minutes on:
  - recent and season minutes, and start rate;
  - blowout risk (|expected margin| × role);
  - teammates missing (their usual usage);
  - whether he played the last game;
  - rest, back-to-back and foul rate.
- **Production.** A Poisson GLM per stat, with a log(expected minutes) offset, on:
  - shrunk recent, season and long-run rates;
  - the opponent's allowed factor and pace;
  - teammates' missing usage × own usage;
  - home, back-to-back and blowout risk.
- **Stats.** Points, rebounds, assists, threes made, steals, blocks, turnovers, field-goal attempts and three-point attempts. The combos are P+R+A, P+R, P+A and R+A.
- **Distribution: a mixture over his minutes.**
  - The minutes nodes are the minutes model's empirical residual quantiles in his minutes band: eleven equal-weight nodes, keeping the left tail of early exits and blowouts.
  - At each node the count has mean rate × minutes and variance a·μ + b·μ², fitted *given the minutes actually played*.
  - The count is a negative binomial on a lattice of step a: a ≈ 1 for counts, a ≈ 2.1 for points, which arrive in 2s and 3s. Each lattice point's mass is spread over the integers its step covers.
- **Dependence.**
  - **The shared minutes node:** every count rises and falls with his minutes.
  - **Residual correlations given minutes** between the nine stats.
  - **Combos:** priced at each node from the exact mean and the correlated variance, then mixed. They are never built from independent marginals.
  - **Double-doubles and triple-doubles:** draw a node, then the five counts through a Gaussian copula.
- **P(plays).** A ridge logistic over every player who appeared for the team in its last 10 games. Its inputs:
  - did he play the last game, and how many in a row he has missed;
  - why he sat (coach's decision, injury, illness, rest, personal, suspension, assignment, or not listed);
  - his appearance rate, minutes and start rate;
  - back-to-back.

  Rates absorb appearances only, so a DNP never enters a denominator. The props are priced conditional on playing, because a prop on a player who does not play is void.
- **Training.** Season S is trained on S−4…S−1.

**Validation** (`nba/props/walkforward.js`):

- **Rows.** Every player-game with at least 3 earlier games and at least 12 recent minutes, scored in both tracks.
- **Distribution scores.**
  - CRPS.
  - The PIT histogram and 80% coverage, using the *expected coverage of the randomised PIT*. A mid-point PIT puts most low counts inside any central interval.
- **Over/under calibration.** No historical prop prices are licensed, so these are calibration probes, not a market test. Two kinds of line are probed:
  - the main line: the half-point nearest the mean, where a book sets it;
  - a fixed alternate-line ladder per family (points 9.5 / 14.5 / 19.5 / 24.5 / 29.5, and so on).
- **Baselines.** The season average and the last-10 average, each with its own fitted dispersion.
- **Status rules.** A family is validated only on the test window, and only if:
  - n ≥ 1,000;
  - 80% coverage is within 0.77–0.83;
  - CRPS beats the season average with a 95% interval below zero;
  - the main-line and ladder slopes are within 0.85–1.15;
  - |calibration in the large| ≤ 0.02.

**Results — projected track (the published props), test window 2018–2026 (scored once; logged).** CRPS model / season average / last 10 (lower is better); coverage is the expected coverage of the randomised PIT; line columns are calibration slope / calibration in the large.

| Family | n | CRPS model / season avg / last 10 | 80% cov. | Main line | Ladder (pooled) | Status |
|---|---:|---|---:|---|---|---|
| pts | 213,010 | 3.345 / 3.505 / 3.441 | 0.771 | 1.06 / +0.012 | 0.93 / -0.001 | OUTCOME_VALIDATED |
| reb | 213,010 | 1.363 / 1.409 / 1.383 | 0.799 | 1.01 / +0.006 | 0.98 / +0.001 | OUTCOME_VALIDATED |
| ast | 213,010 | 0.938 / 0.966 / 0.947 | 0.810 | 1.04 / +0.019 | 1.00 / +0.007 | OUTCOME_VALIDATED |
| fg3m | 213,010 | 0.596 / 0.610 / 0.599 | 0.805 | 1.12 / +0.015 | 0.99 / +0.008 | OUTCOME_VALIDATED |
| stl | 213,010 | 0.454 / 0.470 / 0.461 | 0.804 | 0.99 / -0.001 | 1.01 / +0.002 | OUTCOME_VALIDATED |
| blk | 213,010 | 0.314 / 0.324 / 0.318 | 0.802 | 0.95 / -0.002 | 1.02 / +0.002 | OUTCOME_VALIDATED |
| tov | 213,010 | 0.611 / 0.633 / 0.622 | 0.805 | 1.02 / -0.002 | 1.02 / -0.000 | OUTCOME_VALIDATED |
| fga | 213,010 | 2.019 / 2.113 / 2.071 | 0.790 | 1.02 / +0.011 | 0.95 / +0.002 | OUTCOME_VALIDATED |
| fg3a | 213,010 | 1.047 / 1.071 / 1.048 | 0.806 | 1.14 / +0.024 | 0.98 / +0.005 | PROVISIONAL — main: the half-point nearest the mean: calibration in the large 0.0242 |
| pra | 213,010 | 4.390 / 4.628 / 4.539 | 0.767 | 1.04 / +0.012 | 0.92 / -0.002 | PROVISIONAL — 80% interval covers 0.7666 |
| pr | 213,010 | 4.039 / 4.241 / 4.162 | 0.768 | 1.06 / +0.011 | 0.92 / -0.002 | PROVISIONAL — 80% interval covers 0.7682 |
| pa | 213,010 | 3.681 / 3.869 / 3.796 | 0.769 | 0.98 / +0.013 | 0.93 / -0.002 | PROVISIONAL — 80% interval covers 0.7691 |
| ra | 213,010 | 1.870 / 1.944 / 1.908 | 0.794 | 1.01 / +0.015 | 0.98 / +0.004 | OUTCOME_VALIDATED |

Confirmed track (tonight's starters known): pts validated, reb validated, ast validated, fg3m validated, stl validated, blk validated, tov validated, fga validated, fg3a provisional, pra provisional, pr provisional, pa validated, ra validated.

**Double-double / triple-double** (copula, subsample): log loss 0.2853, calibration slope 0.83, predicted 12.7% against 12.7% observed.

**P(plays)** — every player who appeared for the team in its last 10 games: n 375,357, log loss 0.3826 against 0.4446 for the played-last-game rate (-0.0620 (-0.0640 to -0.0600)), calibration slope 0.951 — **OUTCOME_VALIDATED**. No injury report is in it.

What changed on the way (all decided on the selection window before the test window was opened): a single negative-binomial dispersion per stat gave points 80% coverage of 0.72 and a calibration slope of 0.51 at low lines; mixing each count over the player's minutes and fitting each stat's variance function (points arrive in 2s and 3s: a ≈ 2.1) brought coverage to 0.77–0.81 and the ladder slopes to 0.92–1.04. Probes one sd either side of each player's own mean were replaced by a fixed alternate-line ladder, because a slope fitted on near-constant probabilities is noise.

## 10. Frontend tests

The panel is Research → Other → **NBA** (`lib/edgedesk_nba_ui.js`, `lib/edgedesk_nba.css`, registered in `app.html`). It has four tabs.

- **Games.** For every upcoming game:
  - **The matchup graphic** leads the page (see below).
  - **Price:** win probability, fair moneyline, spread, total, team scores, team totals, alternates, first half and first quarter.
  - **Model comparison:** every model's number side by side, and how far they disagree.
  - **Matchup and context:** pace, the four factors, rest, travel and altitude.
  - **Availability:** each player's impact, "if he sits / returns" scenarios priced by the same model, and the labelled roster-adjusted scenario at a season's start.
  - **Explanation:** the features that moved the number.
  - **Uncertainty.**
  - **Reasons to pass.**
  - **The market:** shown beside the model, never inside it, with a price check.
- **Props.** Fair lines per player and stat, with each stat's walk-forward status.
- **Record.** Every candidate, the comparisons with their intervals, the calibration bins, the seal and the leakage audit.
- **Methods.** Data, licences, protocol and limits.

### The matchup graphic, and every game keeps its research

**The graphic.** Every NBA game page opens with the same shareable graphic the football research page draws (square 1080×1080 or portrait 1080×1350, with Download PNG, Share and Copy link). `lib/edgedesk_nba_graphic.js` fills the football template (`lib/edgedesk_game_graphic.js`, on a court instead of yard lines) from the slate's own numbers, so the three numbers to set against a sportsbook are the first thing on the page:

- **Fair spread**, for the team it favours, with the model win probability;
- **Projected score:** each team's expected points, overtime included, with the win-probability bar;
- **Fair total**, with the expected total beside it.

The strip under them is either:

- **The market**, when Today's Games holds a price from a named book captured in the last 180 minutes and before tip (DraftKings via ESPN, labelled a reference): its spread, total and moneyline as received, the no-vig win split, and the gap between the book's line and the fair line printed above it ("Spread: EdgeDesk 4.0 pts toward DET", "Total: EdgeDesk 4.0 pts lower"); or
- **EdgeDesk's own detail:** the 80% range of the final margin, the model moneyline and the overtime chance.

What to watch for is the slate's own evidence: each offence against this defence, the ridge model's largest matchup factor (never a note on the data's state), rest or pace, and who is playing (the largest "if he sits" swing, or that the rotation is last season's). The footer carries the research grade when the ledger has one, and says "early season" while either team has fewer than 10 games. Nothing on it is re-estimated, and the copy rule runs over every string. The data, model and market status now folds under the game instead of leading the page.

**Started games.** The slate keeps a game for three hours after tip, prices it again, then drops it, so a game used to lose its research page. Now each build moves every game the previous slate priced before its tip that has started, exactly as it was priced, to `nba/recent.json` (`carryRecent` in `nba/build_slate.js`), with `frozen_at` before the start. Each game stays there for `RECENT_HOURS` (96: the two Eastern days Today's Games lists back, plus the gaps between builds). The panel lists started games under their own heading, opens a started game from its frozen research and says so. `build_slate.js --check` refuses a frozen game whose `frozen_at` is not before its start.

**Today's Games.** Every NBA game the engine has priced now links to its page here (`#research/nba/<ESPN id>`, `tools/slate/research.js`), live and final games to their frozen research, and the matchup view shows this panel's fair moneyline, spread and total (it used to show the lab model's, a different number from the one on this page). A game further out than the slate's 72 hours links once a build prices it.

Tests: `node tools/nba/nba_graphic.test.js` (236), `tools/nba/nba_ui.e2e.js`, `tools/slate/build.test.js`.

`tools/nba/nba_ui.e2e.js` runs `app.html` in real Chromium, at desktop width and at a 390 px phone width, against the committed artifacts, with the clock pinned to the slate's build time. **74 of 74 checks pass.** They cover:

- **The games.** The game list; a game's every market table and section; the URL it writes; the numbers matching the slate; Back.
- **The graphic.** Drawn on every game before the numbers and tables, read aloud in words, square and portrait at full size, with its buttons; the status folded under the game.
- **A started game.** Listed under its own heading, opening the research frozen before tip with its graphic.
- **The price check.** A valid quote and a malformed one.
- **The other tabs.** Props, Record and Methods.
- **Failure states.**
  - The slate failing, then coming back on *Try again*.
  - A stale slate.
  - A slate that fails its integrity check.
- **Layout and errors.** No page error, and no horizontal page scroll, at either width.

The desk (`tools/nba/nba_desk.test.js`, 25/25) runs through the real edge-function handler with a stubbed site. It checks that:

- **It answers NBA questions only.** Shared nicknames and cities need basketball context. Season-long futures and certainty requests are left to the research plan.
- **It places games correctly.** It never prices a different game.
- **Quoted prices are checked properly.** Quoted prices are checked at break-even, with pushes.
- **It never recommends a bet.**
- **It makes no model call.**

## 11. Costs

| Item | Cost |
|---|---|
| Data (sportsdataverse parquet) | $0. About 545 MB the first time, cached between CI runs |
| Odds | **$0 by default.** If authorised: one `featured` request per 3-hourly run, ≈3 credits, served from the gateway's stored snapshot inside its cadence window. At most ≈24 credits a day, about 720 a month |
| GitHub Actions | $0: the repository is public, and GitHub-hosted runners are free for public repositories. Roughly 2,500 runner-minutes a month: the 3-hourly build is ≈ 8–10 min and the weekly validation ≈ 1.5–2 h. On a private repository's free plan (2,000 minutes) the build cadence would need to drop to 6-hourly |
| Supabase | $0 until `NBA_SUPABASE=on`. Then about one season of rows (≈1,300 games, ≈28,000 player-games) per sync, well inside the free tier's storage |
| AI desk | $0: NBA answers are deterministic from the slate, with no model call |

## 11b. The roster and injury layer (2026-10-21)

The baseline described in this card is unchanged. Beside it, the league's injury report and current rosters (T0) are synced by `supabase/functions/nba_injury_sync`, and a separate research model — the Roster-Adjusted Projection, NBA-ROSTER-ADJ v0.1, registered EXPERIMENTAL before any evaluation — re-prices each game from them. That model resets the baseline's availability features and shifts the means by the minutes-weighted RAPM change, priced by this engine's own distribution (`nba/injury/core.js`). It does not replace the baseline. See the README's §NBA roster and injury layer for the sources, the tables, the cron, the status mapping, the promotion criteria and the decisions made.

## 12. Missing data and limitations

**Blocked.** Each of these needs a decision or a resource from the owner.

1. **The market test.** No licensed archive of timestamped NBA closing prices exists here. Until there is one:
   - every market is NOT_TESTED;
   - value claims are DISABLED;
   - there is no ROI and no CLV.

   ESPN's displayed spread (2012-13 on) has no timestamp, no book and no price, so it is used only as an accuracy diagnostic.
2. **Live prices.** These need the owner to authorise spend: run `supabase/nba_odds_sport.sql`, enable the gateway row, and set `NBA_PRICES=on` (§11).
3. **Commercial data rights.** ESPN- and NBA-derived data must be reviewed before NBA output is sold (§2).
4. **The Rithmm posts and the NBA.com glossary and terms.** Both are unreachable from this build. `NBA_RESEARCH.md` §7 lists what to verify from an open network.

**Provisional.** These limit how far the numbers can be trusted.

- **No injury report or confirmed lineup feed.** The published price uses the **projected** track: each team's previous-game rotation, or last season's closing rotation for its first game. The confirmed track (who played) is scored in the walk-forward as the upper bound a lineup feed could reach. It is never used for a published price.
- **Retrospective data.** When a result was first published is unknown. Every game is assumed known four hours after tip, and `pit = RETRO`.
- **Rosters at a season's start.** The opening price carries last season's closing rotation. The roster-adjusted scenario (the 2026-27 preseason roster) is shown beside it, labelled. Its timing cannot be reproduced historically, so it is never scored.
- **The possession simulation (D)** omits and-ones and bonus free throws. Its level is anchored to B, and its spread of outcomes is wider than the data. It stays a candidate and is not the published price.
- **Older data.** Play-by-play before 2006-07 has period-score mismatches. These seasons are burn-in only, and half and quarter scoring drops those games. DNP reasons start in 2012-13.
- **Props** are validated on synthetic lines; no historical prop prices are licensed. Minutes carry most of the uncertainty, and the minutes model has no injury feed. The probability of playing is learned from appearance history only; no injury report is in it. On the test window, P+R+A and P+R cover 0.767–0.769 of outcomes with their 80% intervals (the bar is 0.77), and three-point attempts run about two points over at the main line. These families stay PROVISIONAL.
- **Play-by-play completeness.** The play-by-play misses scoring in about 0.8% of games: 10 of 1,318 in 2025-26, in both retrievals. Possessions and points rebuilt from events are therefore reconciled to the box. The box, not the events, is the record of points.
- **Possessions are an estimator.** One canonical estimator (Basketball-Reference) is used everywhere. Its mean sits 2.7 below the 0.44-FTA proxy, with correlation 0.99. Event-level possession counting is not built.
- **The cross-sport registry** (`engine/registry.json`) still reads the basketball lab's NBA record. Switching it to this engine is a separate, reviewable change; this build leaves the registry and the board untouched.

## 13. Files changed and tests executed

**New: the engine (`nba/`).**

| Path | What it does |
|---|---|
| `nba/config.js` | Windows, sources, licences, paths, schemas |
| `nba/ingest/season.js`, `nba/ingest/pbp.js` | Schedule, team and player box, play-by-play: period scores, lineup stints, shots, possessions, the transition proxy; rest, travel, altitude and time zone |
| `nba/lib/io.js`, `nba/lib/data.js`, `nba/lib/venues.js` | Cached fetch, the parquet bridge, tables, arenas |
| `nba/tools/parquet_select.py` | pyarrow column selection; CR/LF inside strings is flattened |
| `nba/tools/fetch_all.js` | Download every season's parquet into the cache |
| `nba/tools/lineups.js` | Five-man units per team-season |
| `nba/tools/sync_supabase.js` | The `nbahist` copy (service role, off by default) |
| `nba/model/ratings.js` | Elo, Glicko, adjusted ratings, Kalman |
| `nba/model/players.js` | RAPM and availability |
| `nba/model/simulate.js` | The possession simulation |
| `nba/model/learn.js` | Ridge, logistic, GBDT, Platt |
| `nba/model/ml.js` | The E models per track |
| `nba/model/pass.js` | The point-in-time pass |
| `nba/model/distribution.js`, `nba/model/dist_fit.js` | One distribution for every market, and its fitting |
| `nba/model/walkforward.js` | The record, the seal, the choice |
| `nba/model/tune.js` | Selection-window tuning, with parallel parts |
| `nba/model/live.js` | The live parameters |
| `nba/props/state.js`, `nba/props/model.js`, `nba/props/walkforward.js`, `nba/props/build_props.js` | Props: features, model, record, slate |
| `nba/build_slate.js` | The slate, scenarios and the ledger |
| `nba/grade_ledger.js` | Grades the ledger |
| `nba/market/quotes.js`, `nba/market/fetch_quotes.js` | Gated price capture |
| `nba/desk.js` | The desk module |

**New: committed data and artifacts.** `nba/data/**`, `nba/params/**`, `nba/validation/**`, `nba/slate.json`, `nba/props_slate.json`, `nba/ledger/**`, `nba/market/quotes.json`.

**New: everything else.**

- **App:** `lib/edgedesk_nba_ui.js`, `lib/edgedesk_nba.css`.
- **SQL:** `supabase/nba_engine.sql`, `supabase/nba_engine_rollback.sql`, `supabase/nba_odds_sport.sql`, `supabase/migrations/20261014120000_nba_odds_sport_row.sql`.
- **CI:** `.github/workflows/nba.yml` (tests), `nba-build.yml` and `nba-validate.yml` (the scheduled jobs).
- **Tests:** `tools/nba/nba.test.js`, `nba_desk.test.js`, `nba_sql.test.js`, `nba_ui.e2e.js`.
- **Docs:** `docs/engine/NBA.md`, `docs/engine/NBA_RESEARCH.md`.

**Changed shared files.** Each has one NBA entry added.

| File | Change |
|---|---|
| `app.html` | The NBA button, panel host, stylesheet and registration |
| `lib/edgedesk_sports.js` | NBA in `RESEARCH_COVERAGE` |
| Inlined copies: `record.html`, `supabase/functions/{edgedesk_ai,capture,close}/index.ts` | Synced with `tools/presentation/inline.js` |
| `supabase/functions/edgedesk_ai/index.ts` | The `nbaTurn` after the NHL turn |
| `tools/presentation/inline.js` | The `EDNBADESK` entry |
| `supabase/expose_schemas.sql` | `nbahist` listed |
| `package.json` | `nba:*` scripts |
| `README.md`, `docs/engine/README.md` | NBA sections |

**Tests updated** because they pin the coverage list or the Other row. These are dated changes, not loosened checks: `tools/app/navigation.test.js`, `tools/app/sports_config.test.js`, `tools/intelligence/support_boundary.test.js`.

**Untouched:** football, MLB, NHL, the basketball lab, the registry and the board, the odds gateway code, and every other workflow.

**Tests executed.** The four NBA suites and the five checks were rerun locally on this branch after the test window was opened and the slate rebuilt. The shared-list rows and the wider sweep are from the build merged in #570–#574, whose CI was green; none of those files changed since.

| Suite | What it proves | Result |
|---|---|---|
| `tools/nba/nba.test.js` | Ingest parsers, lineups, distribution, markets, learners, ledger, quotes, desk, loader; scope and club-only data; zero-minute appearances; the streamed caches; props variance functions, lattice, mixture and P(plays); de-vig methods and duplicate quotes; PASS gates; builders refuse with a season's work tables missing; the pack's verification and reconciliation reproduce, and a tampered pack fails | 92 passed |
| `tools/nba/nba_desk.test.js` | The desk module, and the real `edgedesk_ai` handler with no model call | 25 passed |
| `tools/nba/nba_ui.e2e.js` | The panel in Chromium, desktop and 390 px | 52 passed |
| `tools/nba/nba_sql.test.js` | The `nbahist` schema on a real PostgreSQL: RLS, roles, the before-tip ledger rule, the per-scope views against hand arithmetic, the Cup final's scope, rollback | 25 passed |
| `nba/model/walkforward.js --check`, `nba/props/walkforward.js --check`, `nba/build_slate.js --check` | The committed record, props record and slate keep their rules | pass |
| `tools/datapack/verify_nba.js --check`, `nba/crosscheck/pack.js --check` | The pack's verification (30/30) and reconciliation reproduce | pass |
| `tools/datapack/verify.js`, `verify_nhl.js`, `verify_nfl.js --check`, `datapack.test.js` | The other packs are unaffected by `nba_v1` | pass (54/54) |
| Shared lists and routing: `tools/app/navigation.test.js`, `tools/app/sports_config.test.js`, `tools/intelligence/support_boundary.test.js`, `tools/presentation/presentation_sync.test.js`, `tools/intelligence/benchmark.test.js`, `tools/odds/no_bypass.test.js`, `tools/hockey/nhl_desk.test.js` | NBA in coverage, the Other row, inlined copies in sync, routing, no path around the odds gateway, the NHL desk unaffected | 248, 67, 40, 55 pairs, 24, 91, 27 — all pass |

**The wider sweep.** Every unit test of every workflow that reads a shared file this build touched was run: 231 test files from 23 workflows. 230 passed on the first run.

The one failure was a real regression. The NBA desk answered "Who will win the NBA Finals?", which the benchmark expects the research plan to decline, and it now passes after the fix. The desk leaves season-long futures and certainty requests alone.

**CI history.**

- **The tests job.** On the first PR, the NBA tests job failed in CI because it read tables the ingest rebuilds and never commits. The tests job now rebuilds 2025-26 first.
- **The first scheduled build priced on one season of player data.** The first scheduled build after #574 merged started from an empty cache.
  - The offline ingest of the history failed for 2002-03 to 2024-25 but exited 0, so the online fallback never ran.
  - The slate and the props were priced with 2025-26 player data only. Against the full-history rebuild, the published home-win probabilities were off by up to 0.015 (0.008 on average), the expected margin by up to 0.52 points and the fair spread by up to 2 points. Team-only ratings were unaffected.
  - **Fix:** the ingest now exits non-zero when a season fails, so the fallback runs. The slate and props builders refuse to price while any completed season's player-game or stint table is missing.
  - The 14 sheets that run recorded stay in the append-only ledger. The rebuilt sheets follow them.

## 14. Deployment and rollback status

**What is merged, and what is not deployed.**

| Change | State |
|---|---|
| [#570](https://github.com/dsrackler17/EdgeDeskSports/pull/570): the engine, data, NBA Data Pack, panel, desk code, SQL files, CI | merged |
| [#572](https://github.com/dsrackler17/EdgeDeskSports/pull/572): the CI rebuild of 2025-26 and the sealed props record | merged |
| [#574](https://github.com/dsrackler17/EdgeDeskSports/pull/574): the sealed game record, live parameters, slate, props slate, ledger | merged |
| The test-window scoring and this card | the PR that carries this file |
| `supabase/nba_engine.sql`, `supabase/nba_odds_sport.sql` | **not applied** (by hand, when the owner decides) |
| `edgedesk_ai` with the NBA desk turn | **not redeployed** (`BUILD` unchanged; `Deploy intelligence` is manual) |
| NBA price capture, the Supabase copy | **off** (`NBA_PRICES`, `NBA_SUPABASE` unset) |

**What merging does.**

- **The panel goes live.** GitHub Pages serves `app.html`, so the panel ships on merge. It reads only committed files.
- **The SQL does not run.** `supabase/nba_engine.sql` (the `nbahist` schema) and `supabase/nba_odds_sport.sql` (the disabled gateway row) are applied by hand in the SQL editor. The odds-row migration in `supabase/migrations/` mirrors the NHL's and inserts the row **disabled**. The schema is deliberately not a migration.
- **The desk does not change yet.** The NBA desk turn is in `supabase/functions/edgedesk_ai/index.ts`. It reaches readers only when the function is redeployed (`Deploy intelligence`, manual). Its `BUILD` tag is unchanged, so the Intelligence doctor does not redeploy it on its own. `EDGEDESK_NBA=0` switches the turn off without a code change.
- **Scheduled jobs start.** `.github/workflows/nba-build.yml` and `nba-validate.yml` run on `main` after merge: the build every 3 hours, the sealed validation weekly. They spend nothing (`NBA_PRICES` and `NBA_SUPABASE` are unset), and they commit through `tools/ci/push_generated.sh` only when the checks pass.

**Rollback.** Each layer can be withdrawn on its own.

- **The panel:** remove the NBA button and `researchRegister({id:'nba'…})` from `app.html`, or revert the merge. The panel holds no state.
- **The coverage list:** remove `{ id: 'nba' }` from `EDSPORTS.RESEARCH_COVERAGE` and run `node tools/presentation/inline.js`. That restores the previous coverage sentence everywhere it is inlined.
- **The desk:** set `EDGEDESK_NBA=0` in the function's secrets, or redeploy the previous build.
- **The database:** `supabase/nba_engine_rollback.sql` drops `nbahist` (nothing outside it depends on it). `select public.odds_api_set_sport('basketball_nba', false);` withdraws price capture.
- **The jobs:** disable the `NBA engine` workflow.
