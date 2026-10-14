# Method

This engine implements public, defensible approaches in its own way and
tests them. It does not reproduce KenPom, Torvik or EvanMiya; their exact
formulas are private. `basketball/ncaam_research/methodology.js` records,
topic by topic, what is publicly documented, what EdgeDesk chose and what is
unknown. The pages show that table under **Method**.

Source review: [METHODOLOGY_SOURCES.md](METHODOLOGY_SOURCES.md). Most original
pages (kenpom.com, barttorvik.com, evanmiya.com and others) could not be
fetched from the build environment, so claims about them rest on search
excerpts of the authors' own pages and are tagged that way. Sill (2010) was
read in full.

## Team strength

For each D1-v-D1 game, with possessions `poss = mean over both teams of FGA − ORB + TOV + c·FTA`:

```
100·home points / poss = μ + off[home] + allow[away] + η·v      v = 1 (campus) or 0 (neutral)
100·away points / poss = μ + off[away] + allow[home] − η·v
possessions per 40     = τ + ½(pace_off[h] + pace_allow[a] + pace_off[a] + pace_allow[h])
```

- **Fit.** Each team-side is weighted by possessions and fitted by ridge
  least squares toward per-team priors, solved by warm-started Gauss-Seidel
  (`lib/additive.js`).
- **Ratings.** Adjusted offense = μ + off and adjusted defense = μ + allow,
  in points per 100 against an average D1 team at a neutral site. Net = off −
  allow. Overtime is removed from tempo (minutes = 40 + 5 × overtimes).
- **Prior.** Last season's final rating × carry (chosen: 1.0), worth λ
  possessions (chosen: 150). Its weight fades as games accumulate.
- **Transfers.** Incoming transfers add β × (share of their old team's
  minutes × old team's net). β = 0.25 was chosen on 2025 and is
  experimental. New programs start at the bottom-quartile prior.
- **Uncertainty.** `var(off) ≈ s² / (Σ weights + λ)`, the diagonal of the
  ridge posterior.
- **Distributions.** Raw margin and total are recalibrated weekly on earlier
  out-of-sample games: `margin ~ N(a + b·m, s0 + k·var_param)`, same form for
  the total. `P(win) = Φ(mean / sd)`, overtime included.
- **Non-D1 opponents.** Teams outside the season's D1 reference are one
  pooled opponent, fitted against fixed D1 ratings. They never enter the D1
  fit.

## Style

Every rate (eFG%, 2P%, 3P%, FT%, 3PA/rim/mid shares, rim/mid FG%, TOV%,
steal %, ORB%, FTA/FGA, assisted share, block %, fast-break points per 100,
seconds per possession; transition share and transition / half-court PPP in
2026) is fitted with the same additive opponent adjustment, weighted by its
own denominator.

- **Reliability.** Split-half reliability across 2024-25 team-seasons gives
  a shrinkage weight `k = n̄ (1 − ρ) / ρ`.
- **Observed** is the plain rate. **Sustainable** is the opponent-adjusted
  rate shrunk by k.
- **Four factors to points.** A regression of points per 100 on eFG%, TOV%,
  ORB% and FTA/FGA (2024-25, R² 0.96) turns factor edges into points per
  100. It explains a rating; it is not the rating.

## Player impact

```
100·points on a possession = μ + Σ O[offense five] − Σ D[defense five] + η·v
O_p ~ N(b_O · x_p, s²/λ),  D_p ~ N(b_D · x_p, s²/λ)
```

- **Rows.** One per 2026 possession with ten identified NCAA ids in a
  reconciled D1-v-D1 game (status EXACT or WITHIN_3), collapsed into units.
- **Prior.** x_p are box-score rates per 100 possessions on the floor (NCAA
  player box, same id space) plus last season's publisher RAPM where the
  publisher id chain links the player. b is fitted by least squares of the
  zero-prior RAPM on x inside the training window.
- **Solver.** Jacobi-preconditioned conjugate gradients. λ (2000) and the
  variant were chosen on a later window.
- **Uncertainty.** Exact inversion of each team's block of the posterior
  precision gives SDs and teammate correlations.
- **Separability.** A player is flagged "not separable" when one teammate
  shares more than 85% of his possessions or their posterior correlation is
  below −0.5.
- **Questions.** Best player = highest impact with 500+ possessions. Most
  productive = impact × share of the game played. Hardest to replace =
  largest loss when his minutes go to the teammates who would take them.

## Minutes, participation and scenarios

- **Minutes when playing.** EWMA over games played (2-game half-life, chosen
  on 2025).
- **Baseline minutes.** Season average per team game, absences included:
  what the team rating contains.
- **Redistribution.** A scenario moves minutes, not points. An absent or
  capped player's minutes go to teammates in proportion to their usual
  minutes × positional similarity, each capped at his season high. The team
  still plays 200 player-minutes.
- **Closing five.** Each of the five chosen to close gains up to
  5 × (1 − his minutes / 40) minutes, within his cap. The others give up the
  same total in proportion to their minutes.
- **Added player.** A player from another team (a transfer, or anyone)
  enters with his own impact and the minutes chosen. The team still plays
  200 player-minutes, so the others give up time in proportion.
- **Pricing.** Δ net = Σ (minutes′ − minutes) / 40 × impact.
  - The pages price changes against the usual rotation, so no change = 0.
  - The validation priced them against the rating's own minutes, so nothing
    a rating already contains is counted twice.
- **In a matchup.** A scenario moves the team's offense and defense by
  its Δ, and the margin and total SDs widen by its SD. The report says a
  scenario is applied and shows the game without it alongside.

## Lineups

```
lineup = Σ players' impacts + w · (adjusted lineup result − Σ impacts),   w = τ² / (τ² + sampling variance)
```

τ² is estimated by moments across lineups with 40+ possessions each way.

## Market layer

`compareMarket()` prices exact quotes:

- **Markets.** Moneyline; spread and total with integer-line pushes;
  overtime included.
- **De-vig.** Two-way prices are de-vigged multiplicatively, for reference.
- **Gates.** Every quote is PASS unless all of these hold:
  - a fresh, open, unexpired price;
  - a supported full-game market;
  - stated overtime rules;
  - confirmed availability;
  - a model validated against the market;
  - adequate data and identity;
  - expected return above the bar.

Without quotes the section says "market comparison unavailable" and nothing
else changes.
