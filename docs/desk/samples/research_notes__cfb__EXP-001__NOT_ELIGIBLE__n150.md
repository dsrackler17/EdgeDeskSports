# Research note: V2.1 hardened vs V1 champion after 173 live games

**After 173 live college games, CFB V2.1 challenger misses the final margin by 12.267 points on average, against 12.172 for CFB production pricing model (V1), the model that prices my games now. The challenger is not ahead.**

> Experimental. This is a registered study running beside my published numbers. Nothing in it moves a number I publish until it passes every gate below and I promote it by hand.

## The study

- Study: EXP-001, V2.1 hardened vs V1 champion.
- Status: RUNNING since Sep 27.
- What it tests: V2 architecture (whole model generation).
- The hypothesis, as I registered it on Sep 27: The V2 architecture (opponent-adjusted play-by-play ensemble) predicts margins more accurately than V1 on live 2026 games, as it did on the 2024-25 holdout (-0.28 MAE).
- Evaluation window: LIVE 2026, promotion evaluation at 150 common official games.

## What it shows so far

| Measure | CFB V2.1 challenger | CFB production pricing model (V1) |
|---|---|---|
| Average margin miss (MAE) | 12.267 | 12.172 |
| Root mean square miss | 15.654 | 15.437 |
| Win probability error (Brier) | 0.2005 | 0.2057 |
| Calibration error (ECE) | 0.0737 | 0.0843 |
| Bad-game miss (one game in twenty is worse) | 31.23 | 33.37 |

So the challenger is behind on average margin error and ahead on win probability, calibration and its worst misses. A model can be better calibrated and still miss the margin by more.

The difference in margin error is +0.095 points (challenger minus champion), and its interval runs from -0.494 to +0.692. That interval includes zero, so on margin error this sample cannot tell the two models apart.

Across 3 weeks the challenger won 33% of the weekly comparisons. Its middle ranges, meant to hold four results in five, held 80.3% of results.

## The gates

- margin error clearly better (the interval sits below zero): not passed.
- win probability no worse (Brier): passed.
- calibration within tolerance: passed.
- its middle ranges hold about four results in five, as they claim to: passed.
- its worst misses no worse: passed.
- better week after week, not just on average: not passed.

The sample reached the 150-game minimum at 173 games, so the promotion check ran. Its answer: not eligible.

## What it does not show yet

- Whether CFB V2.1 challenger is more accurate than CFB production pricing model (V1) on margin. The interval above says this sample cannot answer that.
- Whether it beats the closing line. My pipeline’s CLV status for it: NOT APPLICABLE.
- Its maturity: SHADOW.
- Anything about betting. This study grades forecasts, not prices.

What changes because of it today: nothing. My CFB production pricing model (V1) still prices every college number I publish, and the study keeps running.

[My CFB Model Lab record](https://edgedesksports.com/record.html#cfb-model-lab) grades the lab’s numbers in public as the games finish, and [my live CLV record](https://edgedesksports.com/record.html) carries everything I publish.

## Next on the list

- EXP-003, Prior-by-week fade: Letting preseason priors fade by week fixes under-use in weeks 0-2 and over-use in weeks 7-10 (development dMAE -0.023). Not built yet.
- EXP-004, P4 tier term: A P4-tier term removes the systematic under-rating of the P4 side in P4-vs-G5 games (development dMAE -0.030). Not built yet.
