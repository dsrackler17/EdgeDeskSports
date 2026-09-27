# CFB V2 hardening: pre-registered decision rules

**Status:** committed **before** any hardened model was built or scored. The
[`report/redteam`](../../football/cfb_v2/research/report/redteam) results that
exist at this commit describe **candidate 001** only.

**Scope:** every change from `cfb_v2_candidate_001` to the hardened candidate
follows the mechanical rules below, applied to the **development window
(2016–2023)** alone.

**What this does and does not protect against:**
- The 2024–2025 holdout was already scored for candidate 001, and the red-team
  diagnostics report it next to dev. It is therefore **not a pristine**
  holdout for choosing between candidate 001 and a hardened version.
- These rules are the mitigation. No threshold below was chosen after seeing
  how the hardened model scores, and no rule refers to holdout numbers.
- The 2026 live season (small) is the only untouched out-of-sample evidence
  left.

## R1 Correctness fixes (always applied)

These fix things that are wrong, not things that score badly:
- the point-in-time leaks found by `tests_poison`:
  - batch-median fills in the error model and the cover design;
  - the whole-season volatility fill;
- the market QA that used the closing line to drop openers;
- the missing orientation guard in the backtest decision.

## R2 Components

- **Drop:** a submodel is removed if taking it out of the dev stack changes dev
  MAE by **≤ +0.005 points** (`phase06_ensembles.drop_one_component`).
- **Floor:** at least one efficiency model must remain.

## R3 Combining the survivors

- **Simplest wins:** the equal-weight mean is used if its dev MAE is within
  **0.01 points** of the non-negative sum-to-one stack.
- **Otherwise:** the stack is used.

## R4 Feature groups

The ablation rule is in `redteam.ablation_decision`. All deltas are
*ablated − baseline*, on dev:

| Decision | Condition |
|---|---|
| **KEEP** | Removing the group worsens dev MAE with the 95% CI above 0, **or** it worsens MAE in ≥ 6 of 8 dev seasons. |
| **REMOVE** | Removing it does not worsen dev MAE (point estimate ≤ 0) **and** does not worsen dev Brier. |
| **RETEST** | Anything else. The group is kept in this candidate. |

**Joint check:** REMOVE groups are dropped together.
- If the joint model's dev MAE is worse than candidate 001's dev MAE by more
  than **0.01**, groups are restored one at a time, largest dev harm first,
  until it is not.

**Prior-input rebuilds** (talent, returning production, coaching, last-season
ratings) follow the same rule against a same-code baseline rebuild.

## R5 Rating update speed

Candidate 001 under-reacts to efficiency evidence: phase 17 found positive
next-game residuals after sustainable dominance and negative ones after
sustained poor play. The variants that make ratings update faster are:
- prior strength ×2;
- prior strength ×4;
- recent half-life of 4 weeks.

**Adopt** a variant only if it improves dev MAE of the *final* architecture:
- by **≥ 0.02 points**;
- with a paired-bootstrap 95% CI entirely below 0;
- against the same-code baseline rebuild.

**Tie-break:** if several qualify, take the one with the largest dev
improvement.

## R6 Probabilities

- **Win probability:** use whichever of raw / Platt / isotonic / beta has the
  lowest dev log loss.
- **Cover probability:** use whichever of raw / Platt / isotonic / beta has the
  lowest dev log loss.

## R7 Betting

BET stays **disabled** unless all four conditions hold:
1. The dev-selected rule passes the coin-flip reality check at **p < 0.05**.
2. On the holdout, graded at the **closing** number (the fill that is always
   achievable), it has ROI > 0.
3. On the same holdout grading, mean CLV > 0.
4. It has at least 100 holdout bets.

## R8 QB overlay (live)

- **Mean shift for a reported starter change:** the dev-measured mean
  team-oriented residual of *unexpected* starter changes.
  - Applied only if its dev 95% CI excludes 0.
  - First-time starters get their own estimate under the same test.
- **Variance:** the dev residual variance of changed-starter games, in excess
  of settled games.
- **Retired:** the rating-gap coefficient (7.74 pts per EPA/dropback) is
  replaced if it is not supported by the dev surprise-change regression.

## R9 Bias corrections

- **Not applied:** systematic biases found by phase 12 (for example the P4
  side in P4-vs-G5 games) would need a new feature, and the brief says not to
  add features yet.
- **Reported instead:** each is sized and listed as a next-iteration
  candidate.

## R10 Promotion

The hardened candidate replaces candidate 001 as the shadow model only if
both hold:
- On the holdout, its MAE is no worse than candidate 001's by more than
  **0.05 points**.
- It passes the same pre-registered gates G1–G7 against V1 that candidate 001
  passed.

A person still decides whether any V2 becomes the champion.

## R11 Scoring order

1. Commit this file.
2. Build the hardened candidate from the rules above.
3. Score it on the holdout **once**, and report the result whatever it is.
