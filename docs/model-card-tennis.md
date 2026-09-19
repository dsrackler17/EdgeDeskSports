# Model card — EdgeDesk tennis match winner

**Family** `tennis_match_winner` · **Engine** `lib/tennis_model.js` ·
**Builder** `tools/tennis/build_model.js` · **Registry** `tennis.model_registry`

---

## What it predicts

The probability that a named player beats a named opponent in a **singles**
match, on a named surface, before the match starts. Nothing else. It does not
predict a score, a set count, a retirement, or whether anyone should act on the
number.

## What it is not

It is **not a betting recommendation**. EdgeDesk publishes the probability, the
fair price it implies, the market's own number beside it, and the reasons the
gap between them might not be real. There is no stake, no unit and no selection
anywhere in the system.

It has **not been shown to beat a market price.** No historical tennis odds are
captured, so the only baselines it has been measured against are the official
ranking, overall Elo and surface Elo. The build output says this explicitly on
every run rather than passing over it.

---

## Inputs

All differences between the two players, all knowable **before** the match:

| feature | source |
|---|---|
| `d_elo` | overall pre-match Elo, ÷100 |
| `d_surface_elo` | surface-specific pre-match Elo, ÷100 |
| `d_rank_log` | log of official ranking |
| `d_rank_points_log` | log of ranking points |
| `d_form_90`, `d_form_365` | win rate over trailing 90 / 365 days |
| `d_rest` | days since last match, **capped at 14** — a fortnight off is a layoff, not freshness |
| `d_workload_14d` | matches in the last 14 days |
| `d_surface_experience` | career surface win rate, shrunk toward 0.5 with k=30 matches |
| `d_age` | age in years, ÷10 |
| `d_serve_strength` | rolling service points won ÷ played, over **earlier** matches only |
| `d_return_strength` | rolling return points won ÷ played, likewise |
| `d_sos` | mean pre-match Elo of **earlier** opponents |
| `best_of_5` | format |
| `level_weight` | tournament level (`lib/tennis_model.js:LEVELS`) |
| `elo_x_bo5` | Elo edge × best-of-five |

### Never inputs

The row's own serve statistics, score, duration, or result. Those are the
outcome. `tools/tennis/leakage.test.js` proves it arithmetically, and
`lib/tennis_model.js` asserts mechanically that no feature name intersects
`POST_MATCH_COLUMNS`.

### Missing inputs

A missing input becomes the **neutral value for a difference** (zero, because
"no difference" is the honest statement when one side is unknown) and is
**recorded by name** in `missing_fields`. Completeness falls, uncertainty
widens, and below `GATES.minCompleteness = 0.55` the match is refused a price
entirely. A null is never read as a zero measurement.

---

## Training

- **Algorithm** L2-regularised logistic regression, fitted by gradient descent
  with no dependencies (`M.fitLogistic`). Coefficients are stored on the
  registry row, so a version is reproducible and rollback needs no deploy.
- **Splits** chronological: train / validation / test are three consecutive
  windows in time. Never random. The windows are stored on the registry row.
- **Symmetry** every match enters training twice, `(winner, loser) → 1` and
  `(loser, winner) → 0`, forcing anti-symmetry.
- **Evaluation** one deterministic orientation per match (`sha1(match_id)`
  parity), so metrics describe a real 50/50 decision rather than a doubled one.
- **Exclusions** walkovers. Nobody struck a ball.

---

## Evaluation

Reported on the test window, and broken down by tour, surface, tournament
level, best-of, favourite/underdog, confidence bucket and season — **every slice
with its own n**, and flagged `small_sample` under 200.

- **log loss** and **Brier** — the primary measures
- **accuracy** — secondary; a model can be more accurate and worse calibrated
- **calibration curve** and **expected calibration error**
- **ROI** — *not published.* A return figure without the price actually
  available and the sample it came from is not a measurement.

Calibration error is computed over bins holding at least 30 matches, with the
excluded matches counted and printed. A five-match bin has a binomial standard
error near 22 points; because ECE is a weighted mean of *absolute* gaps, that
noise can only push it up, so including such a bin makes a well-calibrated model
look miscalibrated and never the reverse.

### Promotion gate

A candidate becomes `active` only if **all** hold:

1. beats overall Elo on test log loss;
2. beats surface Elo;
3. beats the official-ranking baseline;
4. ECE ≤ 0.05 over at least 200 measurable matches;
5. beats the currently active model.

Otherwise it is registered as a `candidate` and production does not move.
`--force` is available and records the override on the row.

---

## Uncertainty and confidence

`confidence` (0–1) combines feature completeness, rating uncertainty, the
smaller of the two rating samples, and whether the surface is known. It is
**not** the probability and never becomes one.

The **power rating** (0–100) is shrunk toward the tour median in proportion to
how little is known: 50 is the median rated player on that tour on the day the
rating was built, ten points is roughly one standard deviation of tour Elo, and
a player with fewer than 40 matches on file is pulled toward 50. It is never
displayed without its sample and its uncertainty.

---

## Known limitations

- No injury, withdrawal or fitness input exists. None.
- No point-by-point data.
- Doubles is not modelled at all.
- The archive dates a match to its **tournament week**, so within-week ordering
  uses the draw's round order, and weather is a week profile rather than
  conditions at first serve.
- Retirements are included as matches (they were played); walkovers are not.
- The historical source is **CC BY-NC-SA 4.0 — non-commercial.** Every rating
  and every probability here is derived from it.
