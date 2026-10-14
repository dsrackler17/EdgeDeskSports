# Decisions

Each decision with its reason and the evidence it rests on. A decision that
was later reversed stays here, with the reversal.

## Data

| # | Decision | Reason / evidence |
|---|---|---|
| D-01 | Source: sportsdataverse **baseballr-data** (stats.ncaa.org-derived) for 2012–2026 | The only source in reach with schedules, box scores and play-by-play for every D-I team over many seasons; stats.ncaa.org, ESPN and WarrenNolan are blocked from the build container. Commercial rights are unverified, so gate G1 fails (LICENSING.md). |
| D-02 | Canonical program id = the NCAA organisation id | Season-team ids change every season; box-score per-contest ids are mapped through the team total row's name. |
| D-03 | Reconcile, never "last ingested wins" | Every game field records which sources agree (VERIFIED … CONFLICT); a CONFLICT is quarantined, not resolved by order. |
| D-04 | `bats_last` only when two independent sources agree | NCAA-tournament hosts sometimes bat first (F-14). A single source's home flag cannot be trusted for who bats last. |
| D-05 | Runs per inning from score deltas, not per-play `runs_scored` | The per-play field is unreliable; inning lines are accepted only when they reconcile to the official final. |
| D-06 | Innings pitched converted to outs (5.1 = 16 outs) everywhere | Box scores use baseball notation; arithmetic on it is wrong. |
| D-07 | Roster people re-identified by name + hometown + high school | Player ids are re-issued every season (F-05). |

## Time and evaluation

| # | Decision | Reason / evidence |
|---|---|---|
| D-08 | Predict at 14:00 UTC; results available 06:00 UTC next day; `known_at` blank, `pit = RETRO` | No row carries a publication timestamp; nothing is backdated. Moved from 16:00 before any scoring (PROTOCOL.md amendment). |
| D-09 | Windows: SELECTION 2014–22, VALIDATION 2023–24, HOLDOUT 2025–26 (pitchers: 2024 / 2025 / 2026) | Written before the first run; the holdout is looked at once per model version, at most three looks per family. |
| D-10 | Challenger must beat the incumbent by ≥ 0.001 log loss, and adoption needs a date-block bootstrap 95% interval below zero | Protects against picking noise on ~30k-game windows. |
| D-11 | Tuning stopped after round 3 (time-boxed) with some values on grid edges | Each further round spends SELECTION evidence; edges are listed in UNRESOLVED.md, not chased. |

## Models

| # | Decision | Reason / evidence |
|---|---|---|
| D-12 | Team model: hierarchical quasi-Poisson MAP (team ⊂ conference ⊂ division), parks, carryover, Laplace uncertainty | College schedules are unequal and weakly connected; pooling toward the conference is the hypothesis H-TEAM-2, tested by ablation. |
| D-13 | Net rating = off + def | A sign error in the first version was caught by the planted-league test. |
| D-14 | Run distribution: negative binomial, fitted on 2014–18 and chosen on 2019–22 | The first version chose on its own fit rows and favoured the most flexible family; the fix separated fit and choice (CBX-DIST-FAMILY revisions). |
| D-15 | Calibration in **run space** (L' = a·[non-neutral] + b·L, product kept), fitted on seasons S−3..S−1 | A logit map on P(home) fixed the moneyline and left the run line and totals priced from uncalibrated runs, so a game's markets disagreed. |
| D-16 | Ensemble probability made coherent by shifting the run ratio until the closed form matches it | A stacked P(home) alone cannot price a total or a run line; shifting the runs carries it into every market. |
| D-17 | Rest layer (H-ENV-1) is a challenger (`hier_rest_cal`), not silently added | It was accepted on VALIDATION in the feature study; it enters the price only by beating the incumbent under the protocol. |
| D-18 | Component offense (H-OFF-1) accepted as a finding, not wired into the price | Its only test season (2025) is the pitcher-window SELECTION; it needs a fresh season before it can price. |
| D-19 | Pitcher hybrid not in the price | CBX-PITCHER-HYBRID: the improvement on 2025 is not significant. Starters are shown as PROJECTED scenarios, never CONFIRMED. |
| D-20 | GLM and GBM rejected | They did not beat the chosen model on VALIDATION (CBX-ML-GLM, CBX-ML-GBM). |
| D-21 | ~~Every market of a game is priced from one simulated joint distribution~~ — **reversed 2026-10-14**: every FULL-GAME market is priced from one closed-form distribution (negative binomial mixed over rating uncertainty and scheduled length); the simulator prices only the first five | The simulator's first full evaluation (CBX-SIMULATOR) found it favouring the home side by 3.7 points and worse than the closed form on the moneyline (−0.0032, 95% −0.0050 to −0.0016) and totals (−0.064 log score), level on the run line (CBX-PRICING-ENGINE). The closed form's P(home) is the validated probability by construction, and one distribution still keeps the markets coherent. |

## Product

| # | Decision | Reason / evidence |
|---|---|---|
| D-22 | The terminal is a segment of Research → Baseball ("NCAA engine"), not a new Research tab | Adding to `RESEARCH_COVERAGE` would have changed what the deployed AI desk claims to cover; the first attempt broke its tests and was reverted. |
| D-23 | Board split into a compact day summary and a gzipped per-day detail | The full board was 148 MB; the summary loads the all-games view, the detail loads on opening a game. |
| D-24 | No EV, no edge, no "bet" anywhere | No authorised market feed; settlement profiles are unverified templates; release gates fail. Research, not picks. |
| D-25 | Production = last version with no critical audit failure | `audit.js --promote` refuses and keeps the previous production record on any critical failure (audit_log.jsonl). |
| D-26 | The simulator is fed the run model's own expectations, not the calibrated ones | The run-space calibration moves the expectations so the closed form's P(home) is right, leaving them biased in level (home 7.71 vs 7.36 scored on VALIDATION); the simulator models the home side's last inning itself and counted the effect twice. On the raw expectations it is better by −0.0056 log loss. |
| D-27 | First-five prices are RESEARCH ONLY | Calibrated in level (−0.001) but too extreme (slope 0.72, tolerance 0.75–1.33; CBX-SIMULATOR-F5 REJECT). A first-five calibration map fitted on earlier seasons is the next step (research/UNRESOLVED.md U-13). |
| D-28 | `hier_cal` prices; the ensemble and the rest layer stay challengers | Final walk-forward: the ensemble is not distinguishable from `hier_cal` on VALIDATION (−0.0003, interval includes 0) and the rest layer is slightly worse on the moneyline (+0.0001, interval above 0), although rest helps run log scores (H-ENV-1). |
| D-29 | The weekly refit carries this version's holdout look forward instead of erasing it | A refit without `--holdout` restates the registered look for the same model version and pricing model, labelled; any change withholds it until a deliberate new look. |
| D-30 | Promotion of cbase_v1.0.0 refused by the auditor (TAILS), and not tuned away | The critical TAILS check fails by 0.1 point (U-15). The board still shows the version's prices, all labelled provisional research; `params/production.json` stays empty and the refusal is in `research/audit_log.jsonl`. A fix is a new family tested under the protocol, not a looser threshold. |
