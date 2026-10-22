# ESPN backfill stopped

only 0 of 5 games could be verified (40 read). Nothing was filled.

The rule: ESPN must list an official explicitly as Referee on 5 games that already have an NCAA referee, and that Referee must match after normalization. A game with no Referee listed is inconclusive and another game is read.

What ESPN returned, by season:

- 2026: 14 games inconclusive_no_referee_listed (gameInfo has no officials list (gameInfo keys: attendance,venue); no officials anywhere in the summary)
- 2025: 13 games inconclusive_no_referee_listed (gameInfo has no officials list (gameInfo keys: attendance,venue); no officials anywhere in the summary)
- 2024: 13 games inconclusive_no_referee_listed (gameInfo has no officials list (gameInfo keys: attendance,venue); no officials anywhere in the summary)

Every game read is in espn_validation.csv. Coverage stays as the NCAA data has it (coverage_by_season.csv).
