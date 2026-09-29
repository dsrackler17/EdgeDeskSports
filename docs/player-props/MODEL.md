# Player Props — the model (NFL_PLAYER_PROPS_V1.0 · CFB_PLAYER_PROPS_V1.0)

Code: `football/props/model.js` (the estimators), `priors.js` (league priors as
of a time), `project.js` (one game → projection records), `engine.js` (the
Monte Carlo), `calibrate.js` (the per-prop calibration).

## Opportunity is separated from efficiency

A prop outcome is **opportunity × efficiency**, and each is estimated on its
own, shrunk toward its own prior.

| Layer | Estimate | Shrunk toward |
|---|---|---|
| Game environment | EdgeDesk's own game model: fair home margin, fair total, their σ | none; it *is* the game model |
| Team volume | plays, pass rate, dropbacks from **fitted OLS regressions** on the environment (script and total effects), plus a defence-plays prior | the team's recency-weighted history (half-life 6 games) |
| Player share | target share, carry share, red-zone share, recency-weighted (half-life 5 games, previous season × 0.65) | a **role prior**: the league share for the player's depth / usage rank at his position (`shrinkShare`, strength ≈ 2 games of team volume) |
| Efficiency | catch rate (beta-binomial, strength 60 targets), yards per catch (30), yards per carry (90), INT rate (300), sack rate (180) | position priors, times opponent factors (recency-weighted defence rates, themselves shrunk to the league) |
| Gains | per-catch / per-carry gains drawn from **empirical league pools** (timestamped plays strictly before the as-of time), rescaled so their mean is the player's shrunk efficiency | n/a |

The last three games are **shown, never chased**. They enter only through the
recency weights, and a hot streak moves a share by what the shrinkage allows
(`props_engine.test.js`: three 35% games after thirteen 15% games project well
under 30%).

## The Monte Carlo (engine.js)

Each of 10,000 simulations runs these steps:

1. Draw one margin shock and one total shock, shared by both teams.
2. Draw plays and pass rate from them, then dropbacks → sacks → scrambles →
   attempts → targeted attempts.
3. Draw each player's share from its posterior (Beta), then allocate targets and
   carries by Dirichlet(α·w)–multinomial. α is the fitted game-to-game
   dispersion, so shares vary game to game as they do in reality.
4. Draw catches as binomials on a posterior catch rate, then draw yards
   per catch from the empirical pool.
5. The QB's completions and yards are the sum of his receivers' catches and
   yards, so QB and WR outcomes are one game, not two models.
6. Touchdowns follow a Poisson that scales with the simulated offence. They are
   split pass/rush by the realised pass rate, then allocated by red-zone share.
7. Longest plays are the maxima of the simulated plays (order statistics).

**Seeded:** the seed is `hash(game | model version | inputs hash)`, so a
projection reproduces exactly. The same draws give the stored same-game
**Spearman correlations** (QB yards with WR1 yards, an RB's carries with the
opposing QB's attempts) and the copula `EDProps.jointProb`. Correlated props are
never multiplied as if independent.

Outcomes are stored as **integer pmfs** at a resolution of 1/2000, with mass exact
by largest remainder. The **fair line is the median**, never the mean: a
right-skewed yardage median sits below its mean, and the median is the line that
splits outcomes 50/50.

## Availability and redistribution

- **Questionable, doubtful, unresolved.** These players are a *scenario inside the
  simulation*: active with `p_active`, the league's measured play-through rate
  for that designation.
  - A player with no report yet this week carries forward as UNRESOLVED,
    priced at the measured next-week play rate for his last designation
    (for example, Doubtful the week before → 34% played, n=32).
  - His own props are recorded only in the simulations where he plays, because
    a book voids a DNP.
- **OUT.** The player's share is redistributed by `redistributionPlan`:
  - The plan blends a **structural plan** with the team's own games without him
    when there are any. The empirical weight is games/(games+3).
  - Structural targets: next man up at the same position 35%, spread by share and
    positional affinity 50%, and at least 15% left unassigned.
  - Structural carries: 55 / 30 / 15.
  - The total is capped at 95%, so no backup ever inherits 100% of a share.
  - Confidence is HIGH (3+ games without him), MEDIUM (1–2) or LOW (structural).

## Calibration (calibrate.js)

This is a per-prop, zero-preserving transform:

- The **centre** is blended toward the Marcel baseline by λ.
- The positive outcomes are **spread** by κ around their own mean.
- The zero atom (a no-catch game) does not move.

λ and κ are fitted by grid search on the tuning fold (2025 weeks 3–12). They are
judged only on the untouched holdout ([VALIDATION.md](VALIDATION.md)).

## Decisions

The decision probability is the **risk-adjusted probability**:

`p = no-vig + κ·(model − no-vig)`, where `κ = stage_trust × (0.35 + 0.65·reliability/100)`.

κ is floored at 0.20 for the NFL and 0.15 for CFB. The class comes from
`EDDecision.priceClass`, the same rule a spread uses:

- **NFL.** BET needs edge ≥ 4 pp and EV ≥ 5%. LEAN needs ≥ 2 pp and EV > 0.
- **CFB.** BET needs 6 pp and 8%; LEAN needs 3 pp.

Caps then apply:

| Cap | Effect |
|---|---|
| EXPERIMENTAL stage | LEAN at most |
| Reliability below the floor | LEAN |
| Availability pending, QB unresolved, unverified price anomaly | WATCH |
| One book, one-sided market, alternate in the tail | LEAN |

**Sizing** is quarter-Kelly on the risk-adjusted probability, rounded down onto
the 0.25U grid.

- Source caps: model-estimated 0.25U, partially calibrated 0.5U, calibrated 1U.
- Reliability caps apply on top.
- Card exposure caps: player 0.5U, game 1.25U, team 1.5U, day 4U, and 0.75U per
  correlated same-game group.

## Missing-data states

- **NO DECISION.** Each has a named blocker: PROJECTION ONLY (no quote), MARKET
  ONLY (unmodeled prop type), INSUFFICIENT DATA (names what is missing), BAD
  MAPPING (a book name that did not resolve), STALE QUOTE, GAME STARTED,
  PLAYER OUT.
- **WATCH.** Carries the price or line that would change it.
