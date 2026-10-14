# Assumptions and known limitations

Each assumption is stated so it can be tested or retired. "Tested" points at
the evidence; "untested" says so.

## Time

- **A-01** A game is predicted at 14:00 UTC on its date; the earliest plausible
  first pitch is 15:00 UTC. First-pitch times are mostly absent from the source.
  *Untested per game*; a West-coast 9 a.m. local start would violate it (none
  observed in the start times the source does carry).
- **A-02** A game's result is available by 06:00 UTC the next day. *Reasonable
  for final scores; box-score corrections can come later and are invisible here
  (the walk-forward is labelled RETROSPECTIVE for this reason).*
- **A-03** Same-date games never inform each other, including the two games of a
  doubleheader. This loses real information (the game-1 starter cannot start game
  2) and is accepted to keep the pipeline causal.

## Data

- **A-04** The NCAA organisation id is a stable program identity. *Tested*: no
  season-team id maps to two programs (validation/data_quality.json).
- **A-05** The first pitcher listed in a box score started. *Tested* indirectly:
  exactly one per team-game (audit STARTERS); a play-by-play cross-check of the
  first pitching change is listed in UNRESOLVED U-03.
- **A-06** A pitcher who changed schools is the same person when name, hometown and
  high school match exactly. Pitchers without both bio fields are linked only
  within a program. *Limitation*: a transfer without bio fields starts from the
  population prior.
- **A-07** 2023 results after 2023-03-28 are missing in the source for most
  programs. 2024 priors therefore lean on a partial 2023 and a full 2022.
- **A-08** Games against non-NCAA opponents (NAIA, junior colleges) carry no
  opponent id and are not rated or scored; they are listed on the board as
  research-blocked.

## Models

- **A-09** Runs follow the fitted run distribution given the team model's
  expectations; tested in validation/run_distribution.json (dispersion, tails,
  coverage).
- **A-10** The pitcher adjustment is multiplicative on the opponent's run
  expectation with one elasticity fitted on 2024. *Tested* by the pitcher
  walk-forward; a richer form (separate starter and bullpen elasticities, the
  opponent's lineup) is in UNRESOLVED U-05.
- **A-11** A starter's outing length is normal around his shrunk mean outs with
  his own spread; pitch counts are unavailable, so no fatigue curve is modelled.
- **A-12** Pitches ≈ 4.2 per batter faced (measured, F-07); workload figures carry
  that uncertainty.
- **A-13** Park effects are per home program across seasons; a program that
  moved or renovated its park mid-window is not detected before 2024.
- **A-14** League constants (half-inning shapes, extra-inning resolution, inning
  run shares) are measured on 2017–2022 and held fixed for later seasons.
- **A-15** The 2024 doubleheader seven-inning share (measured on 2024 only) is used
  for 2024–2026 doubleheader games; 2017–2023 carry no doubleheader flag.
- **A-16** The ten-run rule ends a game with the measured probability for its
  context (conference / non-conference / inferred NCAA tournament). The true rule
  is set per conference and per series; that granularity is UNRESOLVED U-04.

## Markets

- **A-17** Settlement profiles are templates, not verified book rules. No expected
  value is computed (gate G12).
- **A-18** No market price exists for any game. The model's quality is judged only
  against outcomes and baselines, never against the market.

## Known limitations (not assumptions)

- No weather, altitude or travel distance (no authorised archive; no venue
  coordinates).
- No pitcher handedness, no lineups, no injuries.
- No base-out run expectancy (outs-only RE is computed).
- The 10-run rule and seven-inning games before 2017 cannot be told apart from
  nine-inning games (no inning lines).
