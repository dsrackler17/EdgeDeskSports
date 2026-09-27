# CFB wagering calibration and decision science — design contract

The football model asks what a game is worth. The market engine asks what is offered. The calibration engine
asks how much to trust EdgeDesk's probability. The decision engine asks whether the difference is large enough
to justify risk. A BET requires all four to agree. Otherwise the answer is PASS, and PASS is a first-class answer
with a reason.

## Layers (nothing below changes a football number)

| layer | where | what it may change |
|---|---|---|
| pure projection | `football/cfb_v2/engine.js pure()` (frozen `edgedesk_cfb_v2.1.0`) | nothing here touches it |
| decision calibration | `artifacts/decision/cfb_decision_calibration_v1/` (fit walk-forward on 2016–2023) | `decision_cover_probability` only |
| decision policy | `artifacts/decision/cfb_decision_policy_v*/policy.json` | which prices qualify |
| decision engine | `football/cfb_decision/decision.js` | status, timing, reasons, price targets |
| risk layer | `stake()`, `applyExposure()` | stake size only, never eligibility |

The frozen starting point is `cfb_decision_baseline_001`
(`artifacts/decision/cfb_decision_baseline_001/MANIFEST.json`): V2.1's `engine.decide()` with its dev-selected
rule and BET disabled.

## Two probabilities, never merged

- `pure_cover_probability`: the football model's distribution, a Student-t with the frozen sigma and df, at the
  book's line, conditional on no push. This is EdgeDesk's independent opinion.
- `decision_cover_probability`: the pure probability after the validated calibration map (conditional where
  the evidence supports it), then shrunk toward the de-vigged market probability with a weight learned walk-forward.
  This is what the wager is judged on.

Both are stored and shown. The difference is never hidden.

- `probability_edge = decision_cover_probability − break_even(price)`.
- EV is per unit risked, with the push probability returning the stake.
- `empirical_ev` maps that EV through the heavily shrunk historical EV curve.

## Statuses and reasons

| status | meaning |
|---|---|
| **BET** | the captured price clears every validated threshold: probability edge, calibrated EV, price limit, freshness, dispersion, confidences, integrity. Timing: BET_NOW, or WAIT only when the policy validated that waiting pays |
| **LEAN** | a positive decision edge over break-even and at least 1 point of line disagreement, below the BET thresholds. Also a price that clears while betting is disabled (`NO_BET_BETTING_DISABLED`) |
| **RESEARCH** | a potential edge with unresolved uncertainty: the QB is unresolved (`RESEARCH_QB`), the market is immature (`RESEARCH_MARKET_IMMATURE`), inputs are incomplete (`RESEARCH_DATA_INCOMPLETE`), or the edge is extreme (`RESEARCH_EXTREME_EDGE`). Monitor; never bet now |
| **PASS** | `PASS_PRICE`, `PASS_INSUFFICIENT_EV`, `PASS_MODEL_UNCERTAINTY`, `PASS_MODEL_DISAGREEMENT`, `PASS_MARKET_STALE`, `PASS_MARKET_DISPERSION`, `PASS_LINE_MOVED`, `PASS_DATA_QUALITY` |
| **NO_BET** | fail closed: `NO_BET_CALIBRATION` (artifact missing or invalid), `NO_BET_VERSION_MISMATCH` (calibrated for another model version), `NO_BET_POLICY`, `NO_BET_COMPUTATION`. Predictions still display; recommendations do not |

Statuses are **per sportsbook quote**, because price matters. A game's summary names the best validated quote and
BETTABLE TO. If no book qualifies, the game has no BET.

## Fail closed

A missing or unrecognised calibration artifact, or one validated for a different football model version, gives
NO BET. So does a missing policy, a failed probability computation, or a non-finite number. The following give
PASS:
- a stale quote;
- an uncaptured price (a price is never assumed in a live decision);
- books that disagree beyond the policy.

An extreme apparent edge runs integrity checks before it is believed:
- sign orientation;
- game mapping;
- team join;
- schedule;
- model version;
- quarterback status;
- a quote younger than 60 minutes.

A failed check gives PASS_DATA_QUALITY. Passing every check still gives RESEARCH, never an automatic BET.

## Price targets and moves

For the chosen side, every snapshot recomputes:
- the **bettable-to price** at the current line: the worst price that still clears the EV floor, bounded by the
  policy's price limit;
- the **bettable-to line** at the reference price: the worst line that still clears both thresholds;
- the **ideal entry**, the **minimum-EV entry**, and **do not bet** (worse than either).

A line that moves through the previous bettable-to number gives `PASS_LINE_MOVED`, whatever similar games did
historically. Hysteresis holds a BET only inside a small buffer. It never holds one that fails integrity or
freshness, or whose line moved through BETTABLE TO. A hold is labelled `HELD_BY_HYSTERESIS`.

## Risk layer (after selection)

- **Flat 1u** is the baseline of every backtest.
- **Fractional Kelly** (at most 0.25) is used only when the policy marks the calibration validated. Its input is the
  decision probability capped at an edge-saturation probability, with a hard stake cap.
- **Exposure:** every position on one game counts together through the policy's correlation assumption
  (the correlated sum). A slate cap and a cluster cap scale stakes down, never up.

Eligibility never depends on bankroll.

## Words

- Explanations are generated from reason codes and numbers.
- `auditLanguage` refuses promises of profit ("guaranteed", "lock", "risk-free"), bet language on a
  non-BET ("strong bet", "best bet", "hammer"), and value claims without a number.
- An LLM narrative is attached after the decision (`attachNarrative`) and cannot change it.
- A person's own wager is a `manualDecision`: stored apart (`cfb_manual_decisions`), never official
  (`assertOfficial`).
- Nothing implies profit: every public card says an edge is an expected value and any single game can lose.

## What the data allows

- **Historical market archive:** opening and closing consensus lines for 2013–2025 (no openers in 2020), a book
  count and closing dispersion, and Pinnacle for 2013–2019. It carries **no prices**, so the historical study
  prices every decision at an explicitly labelled assumed −110 (`price_source = ASSUMED_-110`), and CLV is
  opener → close.
- **Live 2026 Model Lab capture:** 604 quotes so far, all from one book, none with a price.
  - Every priced live rule (the price limit, bettable-to price, vig removal, per-book statuses) is implemented and
    tested, but it cannot be validated until priced quotes accumulate.
  - Until then no live decision can be a BET (`PASS_PRICE`).
  - That is the intended behavior, not a gap to paper over.

## Shadow mode (brief §68)

`football/cfb_decision/shadow.js` runs hourly inside the Model Lab job. For every LIVE frozen V2 projection and every
pregame spread quote the Lab captured for it, it decides twice at the moment the quote arrived:
- `CURRENT`: the frozen baseline `engine.decide()`;
- `CHALLENGER`: this engine, with the newest calibration artifact and policy, failing closed without them.

It appends both to `football/cfb_decision/<season>/decisions.jsonl` with deterministic ids. After settlement it
grades each decision once (`results.jsonl`):
- every status gets its side's ATS result (hypothetical for non-BETs, so PASS quality is measurable);
- units are recorded only for a BET at a captured price;
- CLV is measured against the Lab's consensus close;
- a process grade (the price) is kept apart from the outcome grade.

Replayed projections are never used, because they were computed after the quotes. The Postgres view
`cfb_decision_shadow_compare` pairs the two engines quote by quote.

## Files

- `football/cfb_decision/decision.js`: the engine, ES5 for the browser and node.
- `football/cfb_decision/tests.js`: 80 checks plus parity with the Python reference once the artifact exists.
- `supabase/cfb_decision.sql`: 11 append-only tables and the Model Lab views.
- `football/cfb_decision/sql.test.js`: 44 checks on a real Postgres.
- `football/cfb_decision/sync_supabase.js`: the insert-only mirror.
- `football/cfb_decision/shadow.js`: the current vs challenger record, run hourly by `cfb-lab.yml`.
- `football/cfb_v2/artifacts/decision/`:
  - `cfb_decision_baseline_001` (frozen);
  - `cfb_decision_policy_v0` (the fail-safe default: betting disabled);
  - `cfb_decision_calibration_v1` and the decision policy (from the calibration and policy studies:
    `CALIBRATION.md`, `DATASET.md`, `POLICY.md`).
