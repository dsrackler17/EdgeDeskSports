# EdgeDesk CFB Power 4 Intelligence Model

A projection and betting-research engine built for the SEC, Big Ten, Big 12 and
ACC — deliberately **not** the NFL model with college logos on it.

```
football/cfb_p4/
  engine.js     the five-layer engine (browser + node, ES5)
  params.js     GENERATED trained parameters, provenance and the record
  goldens.json  GENERATED python-parity vectors
  tests.js      65 checks: maths, python parity at 1e-9, honesty invariants
  research/     the fully reproducible pipeline + report/BACKTEST.md
```

## The record, first

Held out on **2022–2025**, seasons no layer of the model was tuned on:

| | model | closing market |
|---|---|---|
| spread MAE | 12.99 | **12.03** |
| total MAE | 12.89 | **12.50** |

**It does not beat the closing line.** Against the close, its win rate is
47.3–50.0% at every disagreement threshold, and it gets *worse* as it disagrees
more — the signature of a projection noisier than the market. So `classifyEdge`
never returns anything above `RESEARCH_LEAN`, every projection carries
`unproven: true`, and nothing here is counted anywhere until this model's own
graded CLV beats the close.

That result exists at all because of a correction: the v1 engine in `football/`
states that no public historical CFB line archive exists. It does —
`sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz`, 1.18M rows,
2006–2025, spread + total + moneyline, **opening and closing**, multiple books
including Pinnacle, covering 94–100% of FBS-vs-FBS games from 2012. This model
is held to it.

## Why college football gets its own architecture

The portal is not a footnote, it is the ecosystem, and it is measurable. Mean
incoming transfers per Power 4 team, observed by diffing `athlete_id` across
consecutive rosters:

| 2016 | 2019 | 2021 | 2023 | 2025 |
|---|---|---|---|---|
| 1.9 | 5.0 | 6.8 | 15.7 | **25.1** |

Returning production over the same window fell from 0.67 to **0.43**. A model
that treats a college roster as a stable professional organisation is pricing a
continuity that stopped existing.

## The five layers, kept separate

| layer | what it answers | never collapsed into |
|---|---|---|
| 1 strength | what has this team actually done, opponent-adjusted | — |
| 2 talent | who is actually available to play | one team-talent number |
| 3 situation | venue, travel, schedule, rivalry, conference, weather | one blanket adjustment |
| 4 matchup | how do these two interact stylistically | linear team quality |
| 5 uncertainty | how much should the model trust itself | the point estimate |

Every quantity is a typed measurement:

```js
{ value, available, confidence, n, source, as_of, basis, reason }
```

## The rule that makes it honest

**A missing input contributes exactly 0.0 to the mean and instead widens the
distribution.** No substitution, no league-average stand-in, no quiet default.
An unknown starting quarterback is *maximum* QB uncertainty, not average. An
unsupplied injury report is *maximum* injury uncertainty, not zero. Absence of
off-field reporting is not read as calm. `tests.js` asserts all of this.

Confidence and volatility are deliberately orthogonal: confidence measures
information completeness, volatility measures outcome spread. A veteran
mismatch in a dome can be high confidence and moderate volatility at once.

## What is measured, and what is refused

Measured out of sample, with permutation tests:

* **Home-field advantage** — a single league constant of 4.08 points. The
  spec asks for a per-venue number; the pipeline built one and then rejected
  it (see below). This is what "measure it, then believe the measurement"
  costs.
* **Quarterback** — 10.1 points of spread per 1.0 EPA/dropback of QB edge
  (tune r² 0.0066, **test** r² 0.0081, permutation p 0.0).
* **Quarterback absence** — 3.90 points, over 2,846 games where a team's
  primary QB took no dropbacks. This is the only injury effect public data can
  observe, so it is the only position weight that ships.
* **Schedule stress** — 1.13 points on average.
* **Conference strength** — 0.50 points per point of *prior-season*
  cross-conference differential, applied to cross-conference games only and
  decayed to zero by six games played (tune r² 0.094, **test** r² 0.079,
  permutation p 0.0). After the ratings themselves this is the largest
  validated effect in the model — and it is leak-free by construction: the
  current season's cross-conference record is never used to price a current
  season game.
* **Stylistic matchup** — explains 2.0% of what the ratings leave behind.
* **Regression constants** — each statistic's own measured game-to-game
  persistence. Turnovers repeat at r = 0.077; anyone reading turnover margin as
  skill is reading noise.

Offered to the model and **rejected by it**:

* **Per-venue home-field advantage.** The obvious estimator correlates **0.77**
  with the home team's own rating — a team plays every home game at one
  stadium, so whatever the ratings have not absorbed about the team lands on
  the venue, and the "loudest stadiums" come out reading like a top-25 poll.
  It improved held-out MAE by 0.018 points. The league constant ships instead.
* **Player development (Section VII).** A program's efficiency above what its
  experience, continuity and returning production predict does **not repeat**
  — year-over-year correlation 0.044 over 690 program pairs. "This staff
  develops players" is not visible in this data, so no per-program development
  value ships.
* **Travel** — r² 0.0018 over 6,419 road games. Distance, time zones and
  altitude barely move the mean once strength is accounted for.
* **Rivalry volatility** — 467 detected pairs, only **43%** more volatile than
  a typical game. Rivalry games are not reliably wilder.
* **Roster turnover, youth, rivalry, travel, scoring environment and mismatch**
  as volatility drivers — all seven were offered to a maximum-likelihood sigma
  fit, which kept exactly one (how early in the season it is) and drove the
  rest to zero. The surviving model is only *directionally* correct out of
  sample (rank correlation 0.044), and is labelled a research signal.
* **The roster feed's class column.** It is a static per-athlete value
  carrying a player's EVENTUAL class — 65.6% of players on three or more
  rosters never see it change, and Will Rogers reads "4" in his 2020
  sophomore file. Using it would leak the future, so experience is derived
  from first roster appearance instead, and the browser board publishes no
  youth score at all.

Not shipped at all, because nothing earned it: weather coefficients (no
historical weather series exists in this corpus), non-QB injury weights,
coaching tenure, NIL, per-player recruiting stars. Each has a declared
injection point so the layer switches on the day real data arrives.

## Running the tests

```
node football/cfb_p4/tests.js      # exit 0 = green (65 checks)
```

The parity block replays python-generated goldens through the JS recursions and
requires agreement to 1e-9. If the engine and the training pipeline ever drift,
the shipped seeds stop meaning what they say, so that check is build-breaking.

## Regenerating the parameters

See `research/README.md`. Parameters are trained through the 2025 season; the
data-quality gate BLOCKS projections for seasons beyond
`trained_through_season + 1` rather than going quietly stale.

## Honest notes

* Research and information only. Not betting advice. No guaranteed results.
  21+. Gamble responsibly — 1-800-GAMBLER.
* The model is worse than the market. That is the finding, not a bug to be
  tuned away, and tuning it away on the test window would destroy the only
  reason to believe any of the rest.
