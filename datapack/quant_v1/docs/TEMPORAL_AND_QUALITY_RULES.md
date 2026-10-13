# Time, quality and exposure rules

Store occurred_at, known_at, retrieved_at and revision separately. A game on 2024-10-01 downloaded in 2026 is not evidence that today's revised stats existed before its 2024 kickoff. Shipped historical known_at values are blank unless observed; therefore these data are retrospective research assets, not certified point-in-time training data.

For a prediction at cutoff T, use the latest version of each record with known_at <= T. Exclude target-event statistics and any future events. If known_at is absent, flag retrospective-only or exclude from strict historical evaluation. The included asof_versions function fails closed for unknown known_at. Lagged NFL features exclude the target game, but still carry the retrospective limitation of current EPA/model revisions.

Preserve raw values and source field names, then map to canonical units explicitly. ESPN shot coordinate systems must be documented per sport before geometric conversion; raw x/y are not assumed feet. Native hockey TOI is a clock string. NCAA, WNBA and NBA game lengths differ. Baseball innings are represented as outs. Fighter rates use active fight seconds. Tennis retirements and walkovers are distinct statuses.

Never treat absent stats as zero, invent tracking, infer routes from targets, infer xG from goals, or treat current injury news as historical availability. Retain missing values and exposure counts. Provider-supplied EPA/xG/expected stats require model-version provenance; the expected stat is a modeled input, not an observed fact.

Complete market grouping requires same book, timestamp, line, period and settlement rules. NHL regulation 3-way is distinct from overtime-inclusive moneyline. Soccer 3-way/draw-no-bet/Asian lines differ. A quarter Asian handicap is two half-stakes, not a binary bet. Pushes, voids, dead heats, abandoned games and prop participation rules must be explicit.

Quality checks: key uniqueness at native grain; identity conflicts; timestamp order; monotone period/sequence when ordering is reliable; nonnegative opportunity counts; probability bounds; missingness by source/season; duplicate player groups; count reconciliation; API truncation/filtering; source-revision changes. Raw scoreboard query ranges are not proof of complete league coverage.

ESPN goalie/skater groups may repeat players: use (game_id, team_id, player_id, stat) plus explicit category policy, not sum every row. YTD/season stats in a historical box response can be snapshots rather than contemporaneous inputs and must not enter a target-event pregame feature row.
