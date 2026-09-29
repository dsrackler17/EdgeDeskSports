# Player Props — validation (Validation_Eval, as release gates)

`node football/props/backtest.js --from 2025-3 --to 2026-3 --sims 2000 --write`
writes `football/props/nfl/validation.json` and `nfl/calibration.json`. It runs on
Tuesdays in the hourly workflow.

- **Walk-forward.** One fold per week; every game is projected at kickoff − 3 h
  from rows strictly earlier. The environment comes from EdgeDesk's leak-free
  points history (no archive holds the game model's pregame numbers for these
  games), and no archived forecast is used.
- **Split.** Tuning fold 2025 weeks 3–12 (the calibration's λ/κ are fitted
  here). **Untouched holdout**: after 2025 week 12, through 2026 week 3. Every
  stage gate is judged on the holdout only.
- **Baselines.** CRPS is compared with the player's **own last-8-game
  empirical distribution** (V003/V010). MAE is compared with a **Marcel-style
  regressed baseline**.
- **Probability quality** is measured at a **synthetic line**: the Marcel mean on
  the half point. No archive holds historical prop lines, so market Brier, CLV
  and ROI begin with live captures.
- **Leakage violations: 0.** n = 39,609 scored (19,473 on the holdout), 19
  weekly folds.

## Holdout results (calibrated)

| Prop | n | CRPS | last-8 CRPS | MAE | Marcel MAE | 80% cov. | PIT dev | slope | Brier | Stage |
|---|---|---|---|---|---|---|---|---|---|---|
| Receiving yards | 2709 | 10.71 | 12.04 | 15.45 | 15.61 | 0.790 | 0.021 | 1.04 | 0.229 | **TRACKING** |
| Receptions | 2709 | 0.82 | 0.91 | 1.19 | 1.19 | 0.801 | 0.017 | 1.16 | 0.232 | **TRACKING** |
| Targets | 2709 | 1.07 | 1.19 | 1.52 | 1.53 | 0.790 | 0.025 | 1.02 | 0.239 | **TRACKING** |
| Rush attempts | 1077 | 2.02 | 2.23 | 2.83 | 2.83 | 0.791 | 0.032 | 0.77 | 0.245 | **TRACKING** |
| Rush + rec yards | 845 | 14.93 | 16.97 | 21.05 | 21.34 | 0.790 | 0.027 | 0.89 | 0.237 | **TRACKING** |
| Rushing yards | 1077 | 11.45 | 12.86 | 16.36 | 16.30 | 0.814 | 0.041 | 0.53 | 0.235 | EXPERIMENTAL (slope) |
| Longest reception | 2709 | 5.39 | 6.13 | 7.77 | 7.93 | 0.788 | 0.024 | 1.15 | 0.227 | EXPERIMENTAL (tier 3) |
| Longest rush | 816 | 4.24 | 4.89 | 6.21 | 6.29 | 0.842 | 0.036 | 0.74 | 0.224 | EXPERIMENTAL (tier 3) |
| Anytime TD | 2995 | 0.14 | 0.15 | 0.24 | 0.25 | 0.773 | 0.034 | 0.60 | 0.138 | EXPERIMENTAL (slope) |
| Passing yards | 261 | 42.86 | 48.37 | 59.73 | 59.76 | 0.751 | 0.072 | 0.36 | 0.251 | EXPERIMENTAL (slope, n) |
| Pass attempts | 261 | 4.86 | 5.46 | 6.72 | 6.64 | 0.805 | 0.043 | 0.20 | 0.255 | EXPERIMENTAL (slope, n) |
| Completions | 261 | 3.28 | 3.68 | 4.59 | 4.49 | 0.797 | 0.049 | −0.11 | 0.260 | EXPERIMENTAL (slope, n) |
| Passing TDs | 261 | 0.66 | 0.72 | 0.95 | 0.95 | 0.785 | 0.054 | 0.99 | 0.245 | EXPERIMENTAL (n) |
| Interceptions | 261 | 0.37 | 0.45 | 0.62 | 0.63 | 0.793 | 0.034 | 0.95 | 0.242 | EXPERIMENTAL (n) |
| Pass + rush yards | 261 | 44.27 | 49.82 | 61.98 | 61.99 | 0.778 | 0.049 | 0.27 | 0.251 | EXPERIMENTAL (slope, n) |
| Longest completion | 261 | 7.91 | 8.98 | 11.52 | 11.46 | 0.724 | 0.092 | 0.82 | 0.241 | EXPERIMENTAL (tier 3) |

What this says:

- **Distributions beat the empirical baseline everywhere.** CRPS is 10–18% better
  than the last-8 distribution, and PIT is near uniform.
- **Point accuracy matches, but does not beat, a regressed baseline.** MAE ≈
  Marcel. The value is in the *shape* (tails, zero atom, skew), not the mean.
- **Receiver props and RB workload pass every gate.**
- **QB props fail:** the synthetic-line slope is 0.2–0.4 on n = 261 (under the
  300 the gate needs). **Rushing yards fails** on slope 0.53.

  These stay EXPERIMENTAL, which means LEAN at most, never a stake, until they
  pass.

**Injury redistribution** is measured on teammates of an absent player, as the
MAE of their projected share against the naive pre-absence share:

- targets: **0.0485 vs 0.0512** (n = 3,011);
- carries: **0.1128 vs 0.1438** (n = 505).

## The gates (EDProps.stageOf)

**TRACKING** requires all of:

- walk-forward (V001) with 0 leakage (V002);
- CRPS ≤ baseline (V003/V010);
- PIT max decile deviation ≤ 0.12 (V009);
- 80% coverage in [0.72, 0.88] (V022);
- synthetic-line slope in [0.7, 1.3] (V008s);
- holdout n ≥ 300;
- tier ≤ 2.

**RESEARCH GRADE** adds:

- ≥ 200 settled live predictions;
- live slope in [0.8, 1.2];
- Brier no worse than the no-vig market by more than 0.005;
- mean CLV ≥ 0;
- edge buckets monotone (V016).

**PRODUCTION** adds:

- ≥ 500 settled;
- the CLV bootstrap interval above zero (V015);
- held-out calibration (V021).

The gates are shown pass/fail in the drawer, on the Props tab's *Validation &
record* segment, and in the Lab's *Player props validation* tool.

**CFB** has no backtest yet, so every CFB market is EXPERIMENTAL ([CFB.md](CFB.md)).
