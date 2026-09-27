# CFB wagering calibration and decision science — the §87 deliverable

The brief's 42 required items, each with where it lives and what it found. Two studies produced them:
- the **calibration study** (frozen `cfb_decision_calibration_v1`: [CALIBRATION.md](CALIBRATION.md), [DATASET.md](DATASET.md));
- the **policy study** (frozen `cfb_decision_policy_v1`: [POLICY.md](POLICY.md), pre-registered in
  [POLICY_PREREG.md](POLICY_PREREG.md)).

The engine is `football/cfb_decision/decision.js`, with its contract in [DESIGN.md](DESIGN.md).

## Status

**No policy earns BET status.** This holds on the walk-forward DEV seasons and on the 2024–2025 holdout, which was read
once.

- The production policy is `cfb_decision_policy_v1`, with `bet_enabled: false`.
  - Its BET region is empty at every price. The frozen calibrated-EV curve is −0.0317 per bet everywhere, and the policy
    requires `min_ev = 0` on that curve.
  - The §86 gate fails G3 to G9, so betting stays disabled.
- What the policy does is sort quotes into LEAN, RESEARCH and PASS by closing-line evidence.
  - LEAN beats the close by 0.81 points on DEV and by 0.62 points on the holdout. PASS beats it by 0.29 and 0.20.
  - That CLV does not cover the −110 vig.
- *A missing BET is preferable to a false BET.*

## The 42 items

| # | item | where | finding / status |
|---|---|---|---|
| 1 | decision dataset | DATASET.md; `v2/decision/dataset.py`; `out_h/decision/decision_dataset.parquet` | 15,780 rows × 114 columns. Grain: game × snapshot × quote. Point in time. Historical prices are labelled ASSUMED −110. 29 live priced quotes, none settled. |
| 2 | probability calibration analysis | CALIBRATION.md §4 | The pure cover probability is overconfident: log loss 0.7025 vs 0.6931 for a coin flip, on DEV walk-forward. |
| 3 | conditional calibration analysis | CALIBRATION.md §6-9 | None supported (football confidence, disagreement, timing, gap). One map is kept. |
| 4 | EV calibration analysis | CALIBRATION.md §10 | The theoretical EV averages +9.6% per bet while realized is −1.7%. The decision EV is the best predictor of realized EV. |
| 5 | empirical EV curve | CALIBRATION.md §11; `ev_curve`, `ev_curve_decision` | Heavily shrunk. The decision-EV curve is flat at −0.0317 and never reaches zero. |
| 6 | market shrinkage analysis | CALIBRATION.md §12-13 | Weight on the model w = 0.228 [0.073, 0.383] in logit space. Stable across seasons. |
| 7 | actionable probability methodology | DESIGN.md; CALIBRATION.md | `pure_cover_probability` and `decision_cover_probability` are both kept and shown. `probability_edge` = decision p − break-even. |
| 8 | probability-edge thresholds | POLICY.md §69; prereg §3 | Grid 0–5%, chosen walk-forward from a plateau → **0.01**. Its region is not BET-VALID: DEV OOS ROI +0.028 [−0.077, 0.131]; holdout −0.062 [−0.207, 0.082]. |
| 9 | EV thresholds | POLICY.md §69 | Decision EV grid 1–5% → 0.01. At a single price this is the same ordering as the edge rule. Production reads the calibrated EV with a declared floor of `min_ev = 0`, so the BET region is empty. |
| 10 | multivariate eligibility rules | POLICY.md §69 (`multivariate`) | Forward gate selection with a 1-SE rule adopted only "not early season". Result: 191 DEV bets, ROI +0.041 [−0.090, 0.170], not BET-VALID. The other gates (reliability, disagreement, QB, gap < 10) were rejected. |
| 11 | positive-CLV model | CALIBRATION.md §19; `p_positive_clv` | AUC 0.559. It ranks CLV. The §18 challenger (AUC 0.570) was not adopted: its gain CI was [−0.0004, 0.022]. |
| 12 | CLV magnitude model | CALIBRATION.md §20; `clv_magnitude` | Correlation with realized CLV 0.15. Read it as a ranking. |
| 13 | BET NOW / WAIT / PASS logic | decision.js `timing`; POLICY.md §21-23 | WAIT is disabled: no quote in the edge region had a negative expected CLV. Betting the opener beat betting the close by +0.067 [0.038, 0.098] ROI on the LEAN set (DEV). |
| 14 | football / market / bet confidence separation | CALIBRATION.md §24-27 | Football and market confidence carry no measurable signal among FBS games. Bet confidence ranks CLV. |
| 15 | PASS analysis | POLICY.md §28-29 | PASS rows: CLV 0.29, close-implied EV −0.029. Every status is graded hypothetically. A counterfactual replay exposes every gate. |
| 16 | LEAN definition | policy `lean`; POLICY.md §30 | Decision edge > 0 and \|gap\| ≥ 0.5. LEAN − PASS CLV is +0.52 [0.25, 0.78] on DEV and +0.42 [0.08, 0.76] on the holdout. LEAN is directional information, not a wager. |
| 17 | RESEARCH definition | decision.js; POLICY.md §31 | A LEAN-level decision edge with an unresolved QB, fewer than 3 books, incomplete inputs, or an extreme edge. The old pure-probability trigger was a bug and is fixed. |
| 18 | selectivity analysis | POLICY.md §32 | CLV rises with selectivity: 0.33 → 0.87 at the top 10%. Close-implied EV stays ≤ 0 at every level with n ≥ 100. |
| 19 | ranking monotonicity | POLICY.md §33-34; CALIBRATION.md | Edge, EV, gap and P(+CLV) deciles rise monotonically in CLV and close-implied EV. In ROI they rise only for the gap. |
| 20 | bootstrap confidence intervals | every table | Game-clustered percentile bootstrap, 2,000 resamples, seed 20260927. |
| 21 | bankroll policy | policy `stake`, `exposure` | Flat 1 u, max 1 u, game 1 u, slate 10 u, cluster 5 u. Eligibility never depends on bankroll (tested). |
| 22 | flat staking results | POLICY.md §39 | `edge` region, DEV OOS: +8.8 u over 317 bets, ROI +0.028 [−0.077, 0.131]. |
| 23 | fractional Kelly results | POLICY.md §40-41 | Every 0.10 and 0.25 Kelly variant lost units while flat 1 u won them: the larger edges did worse. Kelly is not validated. |
| 24 | stake caps | policy `stake`; decision.js `stake` | ≤ 0.25 Kelly, a hard cap, and the input capped at saturation probability 0.55. |
| 25 | correlated exposure controls | POLICY.md §44-46; decision.js `applyExposure` | Same-game correlation 1 (the same side at two books is one bet). Spread vs moneyline 0.52; alternate ±3 pts 0.87; favourite spread vs over 0.05. Cross-game ICC ≈ 0. |
| 26 | portfolio simulations | POLICY.md §47 | Week-block bootstrap seasons: +2.2 u mean, SD 10.4, 5th percentile −15.2. |
| 27 | drawdown analysis | POLICY.md §48 | 95th-percentile season drawdown 21.4 u. Historical: 16.9 u, a losing streak of 8, and 145 bets to recover. |
| 28 | risk-of-ruin analysis | POLICY.md §49 | Probability of a 50% loss within 3 seasons: 3.5% with a 100 u bankroll and 43% with 50 u, both at the 2.5th-percentile cover. |
| 29 | price targets | decision.js `priceTargets`; POLICY.md §51-52 | Bettable-to is null at every price under the frozen artifact. The research "fair price" is shown for 29 live quotes. The bettable-to bug is fixed. |
| 30 | decision stability | POLICY.md §53 | From open to close, 37% of LEAN quotes became PASS. The flip rate out of the edge region is 34%. |
| 31 | threshold robustness | POLICY.md §55 | Neighbouring thresholds share the sign of the close-implied EV. None collapses and none is positive. |
| 32 | production threshold choices | `cfb_decision_policy_v1/policy.json` | sha256 `cb9019a2…`. Frozen 2026-09-27 with provenance for each field. |
| 33 | historical walk-forward tournament | POLICY.md §69 | 9 candidates evaluated on 2019 and 2021–2023. None is BET-VALID. |
| 34 | untouched holdout results | POLICY.md §70; `holdout_access.jsonl`; `post_freeze_changes.jsonl` | Read once at 2026-09-27T16:30:11Z; a second run is refused. The `edge` candidate: ROI −0.062, CLV 0.61, calibrated in the large. Every post-freeze change is disclosed, and the pre-read manifest hash is rebuilt by the tests. |
| 35 | shadow-mode implementation | `football/cfb_decision/shadow.js`, hourly in `cfb-lab.yml` | CURRENT (the frozen baseline) vs CHALLENGER (this engine, newest artifact and policy: `cfb_decision_policy_v1`) on every LIVE frozen projection's quotes. Each quote carries the market-integrity verdict (`integrity.assessMarket`), so a one-book market can never be a BET. No LIVE projection exists yet, so there are no shadow decisions. |
| 36 | database migrations | `supabase/cfb_decision.sql` (existing) | The policy satisfies the `cfb_decision_policies` and `cfb_bankroll_policy` constraints (tested). |
| 37 | Model Lab additions | existing views; `v2/decision/scorecard.py --shadow` | The §73 scorecard runs on the live shadow record. |
| 38 | tests | `tests_policy.py` (20 with `--full`), `tests_decision.py` (23), `tests.js` (98) | Includes parity of every status, reason code, stake and exposure between Python and JS. |
| 39 | files/functions changed | this document and the report | See the list below. |
| 40 | current vs new engine comparison | POLICY.md §37 (paired columns) | baseline_001 has 68 DEV OOS bets and 2 holdout bets. The paired unit difference vs the new candidates is within ±0.013 per quote. |
| 41 | remaining limitations | POLICY.md "Limitations" | Assumed −110. Opener timing. Small samples. Declared market gates. One live book. |
| 42 | production promotion recommendation | POLICY.md §86 | **Do not enable betting.** Keep v1 in SHADOW and accumulate priced, settled live quotes (G7 needs ≥ 200). Re-open only with priced history that lifts the calibrated EV curve above zero. |

## Files and functions changed by the policy study

- **New modules** in `football/cfb_v2/research/v2/decision/`:
  - `policy.py`: the Python mirror of decision.js and the parity fixture;
  - `tournament.py`: the DEV study, the policy freeze and the §86 gate;
  - `portfolio.py`: correlations, simulation and risk of ruin;
  - `scorecard.py`: the §73 scorecard and the live shadow adapter;
  - `holdout.py`: the one-time holdout;
  - `tests_policy.py`.
- **Extended:** `render.py`, with `policy_main` and `live_price_targets`.
- **Artifacts:**
  - `football/cfb_v2/artifacts/decision/cfb_decision_policy_v1/{policy.json, evidence.json, MANIFEST.json, holdout_access.jsonl}`;
  - `fixtures/policy_parity.json`.
- **decision.js**, bug fixes, each with a test in `tests.js`:
  - the empirical EV read by the thresholds now maps the decision EV through `ev_curve_decision` (it had mapped it through the theoretical-EV curve; found by the calibration study);
  - `priceTargets`: the bettable-to price now reads the same gates as the decision;
  - `decideQuote`: RESEARCH is now triggered by the decision edge, not the pure probability;
  - `decideGame`: ties go to the better price, and `summary_index` is added;
  - `publicCard`: shows the decision behind the game's status;
  - `features`: an explicit `early_season` 0 is honoured;
  - `applyExposure`: scaled stakes round down so a cap is never exceeded;
  - the helpers `decisionEvFloor`, `nextBetterPrice` and `down3` are new.
- **Docs:** POLICY_PREREG.md, POLICY.md and this file.
