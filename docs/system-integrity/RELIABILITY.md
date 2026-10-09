# What each confidence and reliability number means

These descriptions come from the code that computes each number, not from its
label. **No score was relabelled or rescaled by this work.** Each one is
described as it is.

| Term | Computed by | In plain English | It is NOT |
|---|---|---|---|
| **Model win probability** | `football/cfb_p4/engine.js` `winProb`: Φ(margin / σ) | "Under EdgeDesk's own model, team A wins this often." | A calibrated forecast. It has not been shown to beat the market, and it is never a bet signal. |
| **Statistical uncertainty** | σ (about 14.6–15.7 points, clamped) and the 80% interval | "Outcomes this far apart are normal for a college game: the 80% range is A −17 to B −25." | A confidence in the pick. A wide range is football, not a model failure. |
| **Input data quality / football confidence** (0–100) | `scores.confidence` | "How many of the inputs the model wants are on file for this game, weighted by importance." | A probability of being right. 91/100 means the inputs are mostly present, not that the projection is 91% accurate. |
| **Research reliability** (0–100) | `lib/cfb_reliability.js`: six components with hard gates | "How much the inputs can be trusted: complete, fresh, consistent with each other and stable week to week." | Evidence that the prediction will be correct. A high score is not proof. The live record shows the 80+ band at 53.1% ATS on 98 games (interval 43–63%), indistinguishable from a coin flip. |
| **Market freshness** | quote age against the 180-minute rule (`EDIntegrity.THRESHOLDS.stale_minutes`) | "A price exists right now," or "this is the last line EdgeDesk saw, N hours ago." | Price quality. A fresh line can still be one book's outlier (the market screen handles that). |
| **Probability calibration** | `football/cfb_ev` calibrator; quality read by `EDIntegrity.calibrationQuality` | "Out of sample, how the model's cover probability maps to how often it actually covered." | Evidence of an edge. Today it is **DEGENERATE**: it maps every cover probability to about 50% (log loss 0.693, Brier 0.250 on 2,339 out-of-sample games). A calibrated EV from it is the price's vig, not a measurement. The artifact calls it PROMOTED / SHADOW. The in-app board now tags it "no skill shown", with the explanation on hover, and the terminal's game page prints the explanation beside every raw EV. |
| **Decision readiness** | Layer A of `lib/edgedesk_decision.js` | "A wager can be evaluated at all: a fresh, two-sided priced quote and a valid projection exist." | Whether it should be made. That is Layer B, at the exact price. |

## How a large raw edge is explained

`EDIntegrity.explainEv` writes one paragraph per game:

- the raw EV and the cover probability it came from;
- the calibrated EV at the same price;
- the calibration state;
- why the large raw number was rejected.

`DEC.RAW_EV_NOT_EDGE` blocks any surface that calls a raw EV an edge unless the
calibration is VALIDATED and the calibrated EV is positive. The audit found the
two EV layers (calibrated selection vs best raw quote) on opposite sides in 4
of 7 priced games. `DEC.EV_LAYERS` warns on every such game, and blocks a
surface that prints the two as one pair.

## Monitoring: live-forward and backtest, never blended

`node tools/integrity/performance.js` writes `docs/system-integrity/PERFORMANCE.md`
and `football/validation/integrity_performance.json`.

**Live-forward** (`football/cfb_terminal/record.json`):

- It uses the last pregame number EdgeDesk froze **before kickoff**. A
  look-ahead guard excludes anything frozen at or after kickoff.
- Each game is graded against the close and the final.
- Model versions are never merged.
- Tracked:
  - spread forecast error (model MAE vs the closing line's MAE);
  - against-the-spread rate with a 95% Wilson interval;
  - closing-line value in points;
  - win-probability Brier score.
- Broken down by:
  - reliability band;
  - model–market gap at the close;
  - conference;
  - week.
- Every row carries a sample label: TOO EARLY (<50), EARLY SIGNAL (50–199),
  DEVELOPING (200–499), MEANINGFUL (500+).

**Backtest** (`football/validation/pricing_cfb.json`): the shipped
time-separated walk-forward validation, quoted as it stands and never re-fitted
here. It is printed in its own section.

**Totals** are not measured yet. The live record freezes the spread only, so
total forecast error is an open item, not a zero.

**What the evidence says today** (live, 293 graded games):

- The model's MAE is 13.0 against the close's 11.2.
- ATS is 47.6% [41.9–53.3].
- Games with a 7+ point gap at the close went 42.7% ATS with a model MAE of
  15.4. **The large discrepancies are the model's worst cases, not its best.**

That is why a 7+ gap is INVESTIGATE (check the data) and never promoted as a
prediction.

## The rules this work follows

- No threshold, calibrator or confidence formula was tuned to create BET
  decisions or to change these counts.
- A theoretical EV is never presented as profitability. A figure is evidence of
  an edge only if its interval excludes break-even on a meaningful sample, and
  none does today.
- A high reliability or confidence score is always shown with its plain-English
  meaning beside it.
