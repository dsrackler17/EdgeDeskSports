# Measured findings

Facts this build measured from the data, each with where it comes from. Model
results (log loss, calibration, holdout) live in the registry and
`docs/college-baseball/REPORT.md`; this page is about college baseball itself.

| # | Finding | Value | Source |
|---|---|---|---|
| F-01 | D-I contests per season | ~8,000–8,800 (2020: 2,505; 2023 results end 2023-03-28) | research/COVERAGE.md |
| F-02 | Runs per team-game, 2017–2022 | 5.87 | params/constants.json |
| F-03 | Overdispersion of team runs | variance/mean 3.1 unconditionally; Pearson dispersion 2.7–2.9 around the model's expectation | params/constants.json, validation/run_distribution.json |
| F-04 | Score dependence | correlation of the two sides' standardised residuals +0.07 to +0.08 | validation/run_distribution.json |
| F-05 | Roster player ids are re-issued every season | 0 ids shared 2024→2025; 7,078 players re-identified by name + hometown + high school | ingest/box.js |
| F-06 | Pitcher-rate reliability (BF of prior to halve the noise), 2024 | K 63 · BB 53 · HBP 113 · HR 334 · H 195 | lib/pitchers.js |
| F-07 | Pitches per batter faced | 4.21 (sd 1.65 per PA; game means 3.25–3.93 + the in-play pitch), from 384k sequenced PAs | research note in lib/pitchers.js |
| F-08 | Starter length | 12.5 outs (sd 5.7); starters with 5+ starts 13.4 | 2024 box scores |
| F-09 | Doubleheader games scheduled for seven | 21% (game 1 24%, game 2 18%); single games ~2–3% end after seven without a ten-run lead | validation/rules_evidence.json |
| F-10 | Ten-run lead after seven complete innings ends the game | ~30% overall (conference 27%, non-conference 32%), 0 of 94 in the inferred NCAA tournament | validation/rules_evidence.json |
| F-11 | Extra-inning scoring | 0.52 runs per extra half vs 0.72 in innings 1–9: no automatic runner | validation/rules_evidence.json |
| F-12 | Extra-inning games won by the home side | 51.9% (2,201 games) | params/constants.json |
| F-13 | Walk-off margins | 91% by one run | params/constants.json |
| F-14 | NCAA-tournament hosts batting first | 64 (2024), 50 (2025), 53 (2026) games | validation/data_quality.json |
| F-15 | Share of runs by inning | innings 1–8 ≈ 10.6–12.1% each; 9th 7.1% (unplayed bottom halves) | params/constants.json |
| F-16 | College pitching linear weights (2024 team-games) | fitted per batter faced in validation/pitcher_walkforward.json | pitcher_walkforward.js |
| F-17 | College batting linear weights (2024) | 1B 0.61 · 2B 0.90 · 3B 1.22 · HR 1.43 · BB+HBP 0.49 · SB +0.20 · CS −0.35 · out −0.14 (R² 0.82) | validation/feature_research.json |
| F-18 | Season-to-season persistence | tuned carryover of team strength at the top of every grid (1.0 for the hierarchical model, flat Poisson and Elo; 0.95 for Massey and Bradley-Terry) — college programs are far more stable year to year than roster turnover suggests | params/team_tuning.json |
| F-19 | Starter projection from rotation patterns | ~53% top-1 accuracy; 66% when projected with ≥ 50% confidence (stated 66%: calibrated); ~20% of starts by someone not in the recent rotation | validation/pitcher_walkforward.json |
