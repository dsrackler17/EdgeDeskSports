# Unresolved research questions

Time-boxed: each was investigated far enough to state what would resolve it.

| # | Question | Status | What would resolve it |
|---|---|---|---|
| U-01 | Commercial rights to NCAA-derived statistics | OWNER DECISION | owner review of the NCAA terms; `research/authorizations.json` signed (gate G1) |
| U-02 | Sportsbook market for college baseball | BLOCKED | authorise `baseball_ncaa` in `public.odds_api_sports` with a quota; capture closes for a season before any market test |
| U-03 | Does the first listed pitcher always start? | OPEN | parse "X to p for Y" in play-by-play descriptions for 2024–2026 and compare the first Y with the box score's first pitcher |
| U-04 | Run rules per conference and per series (Friday/Saturday/Sunday differ in some conferences) | OPEN | conference handbooks (not reachable here), or a per-conference measurement once enough games accumulate per context |
| U-05 | Separate starter and bullpen elasticities; lineup quality vs the starter | OPEN | refit the hybrid with two elasticities on 2024–2025 and test on 2026+ |
| U-06 | Historical weather as forecast at prediction time | BLOCKED | an authorised forecast archive plus venue coordinates; realised weather would leak |
| U-07 | Base-out run expectancy (RE24) | OPEN | reconstruct base states from runner-advance text; measure the reconstruction error on games whose linescores are known |
| U-08 | Pitcher identity before 2024 | OPEN | track pitchers through play-by-play substitutions (2017–2022) to extend the pitcher window |
| U-09 | Did the 2023 season's missing results exist elsewhere? | OPEN | the EdgeDesk `cbb` ESPN union, if it was running in 2023, or another archive |
| U-10 | Does the NCAA use the automatic extra-inning runner in any context? | MEASURED NO (pooled) | extra-inning scoring is below regulation scoring (rules_evidence R07); a per-season or per-event check if a rule change is announced |
| U-11 | Starter confirmation sources | BLOCKED | a timestamped, authorised feed of announced starters; until then every starter is PROJECTED or UNKNOWN |
| U-12 | Is the optimum beyond the grid? After the time-boxed third round, carryover sits at the top of every grid (1.0 for hier, flat Poisson, Elo; 0.95 for Massey, Bradley-Terry), and hier sigma_conf 0.05, phi 1.25, half-life 180 days, flat-Poisson sigma 0.15 and phi 1.8, Elo home 45 and Bradley-Terry sigma 0.45 are edges too | OPEN (deliberately not chased) | a fourth tuning round on SELECTION with wider grids, released as a new model version with its own holdout look |
| U-13 | Can the first-five prices be calibrated? | OPEN | fit a logit (or run-space) map for the simulator's first-five probabilities on 2017–2022 inning lines, test on VALIDATION; until then first-five prices are research only |
| U-14 | Home run lines at −1.5 are over-predicted by about 2.5 points | OPEN | the closed form gives home wins margins that are too large (it does not model the unplayed bottom ninth or regulation walk-offs); measure home-win margins by context and fit a margin-shape correction on 2014–2022, test on VALIDATION |
| U-15 | One side scoring 15+ is over-predicted (7.7% vs 6.6% observed on VALIDATION), failing the critical TAILS check by 0.1 point | OPEN; promotion refused | test a mean-dependent dispersion (NB-P) or a run-rule truncation of the closed form as a challenger family in run_distribution.js (fit 2014–18, choose 2019–22), as a new model version |
