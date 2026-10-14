# Missing data, in implementation priority order

This is an acquisition backlog, not populated observations or measured feature importance. Validate usefulness with chronological ablation.

| Priority | Missing input | Required fields / use |
|---|---|---|
| P0 | Executable odds history and live quotes | provider, book, game, market, participant, side, line, decimal odds, quoted_at, observed_at, valid_until, limit, suspended; price comparisons and actual expected return |
| P0 | Historical publication chronology | entity_id, source, first_published_at, observed_at, correction_at, revision; certify information available at prediction time |
| P0 | Confirmed player availability | player_id, game_id, status, reason category, source, published_at, observed_at, confirmation; public professional reports, not private medical records |
| P0 | Starting five and minute projections | game, player, team, starter_confirmed, minute_distribution, role, published_at; availability-weighted rotations |
| P0 | Correct possession/stint reconstruction | ordered actions, corrections, jump balls, technical free throws, team rebounds, substitution actor roles, five active players, exact clock; possession counts and on-court denominators |
| P0 | Additional seasons | same normalized tables across multiple seasons, rule/team identity versions and roster chronology; the shipped single season is insufficient to establish durable edge |
| P0 | Settlement definitions/results | regulation vs OT, push/void, abandoned game, listed participant, book-specific rules, settled_at; honest backtests |
| P1 | Tracking opportunities | touches, time of possession, potential assists, rebound chances, contested/uncontested rebounds, drives, passes, paint touches, screen assists, distance/speed, official definitions and source timestamps |
| P1 | Shot context | verified court frame, distance/angle, shot clock, nearest defender, dribbles, touch time, assisted flag, catch-and-shoot/pull-up, shot zone, expected shot quality; not available in basic event coordinates |
| P1 | Play types and matchups | transition, isolation, pick-and-roll handler/roller, post-up, spot-up, cuts, handoffs, off-screen, putbacks; possessions, efficiency, opponent and coverage |
| P1 | Regularized player impacts | possession-level lineups, opponent, score state, home court, garbage time; fit adjusted plus-minus with shrinkage, not raw +/- as causal impact |
| P1 | Travel and schedule burden | prior venue, geocoded location, local time zone, tipoff, travel distance, rest hours, back-to-back and consecutive road games |
| P1 | Coach/roster/transaction history | effective_at and published_at for trades, signings, coaching changes, assignments, two-way status; avoid current-roster backfilling |
| P2 | Referee effects | assignments published before tip, crew, fouls/free throws by context, hierarchical shrinkage; final observed officials are not proof of prior availability |
| P2 | Market microstructure | ordered quote changes, limits, suspensions, source coverage and quote latency; no unsupported sharp-money labels |
| P2 | Context splits | score state, clutch, garbage time, bench/starter, zone, lineup, opponent strength; minimum sample thresholds and pooled estimates |

Extended schemas in schemas/ are integration specifications. Their presence does not mean those observations were collected.
