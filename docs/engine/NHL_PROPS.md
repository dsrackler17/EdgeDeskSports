# NHL player props: research, not value

> Model: `hockey/props/model.js`. Record: `hockey/validation/nhl_props.json`
> (`node hockey/props/validate.js`; `--check`). Research slate:
> `hockey/props/slate.json` (`node hockey/props/slate.js`). Shown in the game
> page's **Players** tab.

**No NHL prop price is captured, so nothing here is compared with a book or
called value.** `value_claims` is DISABLED in both files, and `--check`
fails if that ever changes without captured prices and a market test.

## Data

The official box score for every game since 2010-11 (skater goals, assists,
shots on goal, power-play goals, time on ice; goalie shots against, saves,
starter) comes from `hockey/ingest/boxscores.js`. Individual expected goals
come from the play-by-play, scored by EdgeDesk's walk-forward xG model. The
box score agrees with the play-by-play on 99.999% of player goals and
assists and 99.96% of player shots on goal (`nhl_crosscheck_box.json`).

## Model

- **Point-in-time state.** Before each game date the state holds, for each
  player: recent-weighted time on ice; shot, individual-xG, goal and assist
  rates per second, decayed by game and shrunk toward his position's current
  league rate; each club's shots on goal for and against and goals for; and
  each goalie's save percentage, shrunk toward the league's. League reference
  levels decay with a one-season half-life.
- **One joint distribution per skater.**
  - **Shots on goal:** negative binomial, mean = projected TOI × rate ×
    opponent's shots-allowed factor.
  - **Goals:** every goal is its scorer's shot on goal, so goals are a binomial
    thinning of shots. Goals inherit the shots' overdispersion, and P(goal and
    3+ shots) is defined.
  - **Assists:** Poisson, scaled by the club's scoring.
  - **Points:** goals plus assists.
- **Goalie saves:** shots against are negative binomial for the starter;
  saves are binomial given shots.
- **Nested recalibration.** Each statistic's mean is recalibrated
  (μ′ = c·μᵇ), and then the dispersions are fitted. Both are fitted by
  likelihood on the three seasons before the one predicted.
- **Participation.** A prop is void when the player does not play, so every
  priced row is a player who dressed (or a goalie who started).

## The record (confirmation 2020-21 to 2025-26)

The rules are the game model's: n ≥ 1000, |mean p − mean y| ≤ 0.02 and a
calibration slope from 0.85 to 1.15. In addition, the model must **beat a fair
naive baseline** with a block-bootstrap interval wholly below zero. The
baseline is the player's season-to-date average, shrunk by 10 games of his
position's average, as a Poisson mean.

| Market | n | Log loss | Baseline | Δ | Slope | Mean p − mean y | Status |
|---|---|---|---|---|---|---|---|
| Shots on goal over 0.5 | 285,941 | 0.5119 | 0.5251 | −0.0133 | 1.02 | +0.006 | OUTCOME_VALIDATED |
| Shots on goal over 1.5 | 285,941 | 0.6133 | 0.6274 | −0.0140 | 1.01 | +0.003 | OUTCOME_VALIDATED |
| Shots on goal over 2.5 | 285,941 | 0.4803 | 0.4909 | −0.0105 | 0.99 | −0.000 | OUTCOME_VALIDATED |
| Shots on goal over 3.5 | 285,941 | 0.3062 | 0.3134 | −0.0071 | 0.96 | −0.000 | OUTCOME_VALIDATED |
| Shots on goal over 4.5 | 285,941 | 0.1723 | 0.1777 | −0.0054 | 0.93 | +0.000 | OUTCOME_VALIDATED |
| Anytime goal | 285,941 | 0.3913 | 0.3976 | −0.0063 | 0.99 | +0.003 | OUTCOME_VALIDATED |
| Assist | 285,941 | 0.5174 | 0.5242 | −0.0068 | 1.03 | +0.003 | OUTCOME_VALIDATED |
| Point | 285,941 | 0.5948 | 0.6020 | −0.0072 | 1.09 | +0.007 | OUTCOME_VALIDATED |
| 2+ points | 285,941 | 0.2643 | 0.2692 | −0.0049 | 1.04 | −0.001 | OUTCOME_VALIDATED |
| Goalie saves over 22.5 | 15,890 | 0.5890 | 0.6244 | −0.0354 | 0.99 | −0.014 | OUTCOME_VALIDATED |
| Goalie saves over 25.5 | 15,890 | 0.6551 | 0.6815 | −0.0264 | 1.04 | −0.015 | OUTCOME_VALIDATED |
| Goalie saves over 28.5 | 15,890 | 0.6190 | 0.6471 | −0.0281 | 1.08 | −0.009 | OUTCOME_VALIDATED |
| Goalie saves over 31.5 | 15,890 | 0.5025 | 0.5364 | −0.0339 | 1.08 | +0.003 | OUTCOME_VALIDATED |

Against the close: **NOT_TESTED** for every market.

## How this record was reached (disclosure)

The model's settings were fixed before the first run and were never tuned on
the record. The first run found three defects, each read on both windows and
then corrected:

1. **Over-shrunk projections** (slopes 1.1–1.4). Fixed by the nested mean
   recalibration above.
2. **League reference levels that never decayed** (2011 scoring anchored 2026
   projections). This was a bug and was fixed.
3. **A straw-man baseline.** An unshrunk season average prices a scoreless
   start at exactly 0, and its log loss explodes on the first goal. The
   baseline was replaced by the shrunk one above, which cut every margin to a
   realistic size.

A fourth fix was mechanical: the dispersion likelihood had read P(S ≥ y) for
P(S = y).

Because these changes followed a look at the confirmation window, the
2026-27 season is the clean test for props too.

## Limits

- **Projected lineups** are each club's most recent game; no injury, scratch
  or line-rush feed is wired. A scratch voids the prop; it does not make it a
  loss.
- **Deployment** (power-play unit, line) enters only through time on ice.
- **Goalie saves** assume the projected starter starts. A pulled starter is
  in the distribution through the shots-against dispersion, not as a
  separate state.
- **Cross-game dependence** (two props on the same game) is not modelled
  beyond shots and goals for one player.
