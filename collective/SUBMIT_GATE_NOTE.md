# The submit endpoint's spread/probability check rejects correct numbers

Found while posting a 16-game NFL Week 1 slate: eight rows came back

    REJECTED <ref>: home_win_probability contradicts projected_spread;
    check that the probability is moneyline and the spread is home convention

The uploaded rows were correct. This note records what the check is doing,
why it misfires, and the one-line fix. Nothing in the client was changed to
work around it beyond an explicit, creator-initiated retry.

## What the check appears to do

Reverse-engineered from which rows passed and which failed:

    implied = 0.50 + 0.025 * (-projected_spread)     // 2.5 points per point
    reject if |home_win_probability - implied| > ~0.043

Largest gap among accepted rows: 3.60pp. Smallest among rejected: 4.95pp.

## Why it misfires

The straight line is a good approximation of the spread-to-win-probability
map near a pick'em and drifts badly past about four points, where the real
map is a normal CDF and starts to bend. Every rejected row was a favourite of
4.4 points or more.

The decisive test: feed the check the **closing market's own** spread and
no-vig moneyline for the same sixteen games.

| game | ref line | market no-vig | check says | gap |
|---|---|---|---|---|
| TB @ CIN | -3.5 | 63.7% | 58.8% | 4.94 → rejected |
| NO @ DET | -7.0 | 72.6% | 67.5% | 5.08 → rejected |
| CLE @ JAX | -7.5 | 75.7% | 68.8% | 6.97 → rejected |
| ARI @ LAC | -10.5 | 82.2% | 76.2% | 5.98 → rejected |
| MIA @ LV | -3.5 | 64.5% | 58.8% | 5.72 → rejected |
| WAS @ PHI | -4.5 | 65.7% | 61.2% | 4.50 → rejected |

**The check contradicts the market itself on 6 of 16 games.** Any model whose
probabilities agree with the closing moneyline is refused on its best games —
the heavy favourites, where models and market agree most.

## The fix

Compare through a normal margin model instead of a straight line, and widen
the tolerance to what the check is actually for: catching a flipped sign or a
percent/fraction mixup, not disagreeing with a rule of thumb.

```ts
// home convention: projected_spread negative = home favoured
const SIGMA = 13.0;                       // NFL margin scale
const implied = normCdf(-projected_spread / SIGMA);
if (Math.abs(home_win_probability - implied) > 0.12) {
  reject('home_win_probability contradicts projected_spread');
}

function normCdf(z: number) {             // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
```

Against this rule: all sixteen market rows pass, all sixteen model rows pass,
and a genuinely inverted submission (spread -5 with a 35% home probability)
misses by 30 points and is still rejected.

## On the probabilities that were rejected

They are calibrated. Measured on 6,232 walk-forward out-of-sample games,
none of which the model trained on:

| model says | actual |
|---|---|
| 50-60% | 53.3% (n=1467) |
| 60-70% | 62.7% (n=1546) |
| 70-80% | 74.3% (n=1037) |
| 80-90% | 84.4% (n=358) |

Model 5-point favourites won 69.7% (n=964); the model said 68.0%; the
rejected straight line says 62.5%.
