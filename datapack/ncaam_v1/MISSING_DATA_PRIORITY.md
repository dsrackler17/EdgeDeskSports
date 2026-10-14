# Remaining acquisition priorities

This list identifies missing inputs and verification work. It does not represent measured feature importance or populated observations. Use chronological ablations to establish value.

| Priority | Dataset | Required content and use |
|---|---|---|
| P0 | Timestamped executable odds and limits | provider, book, game, market, participant, selection, line, odds, quote_at, observed_at, expiry, suspension, limit; exact expected return and feasible prices |
| P0 | Historical first-publication and revision archive | source entity, published_at, observed_at, corrected_at, version and evidence; certify features available at decision time |
| P0 | Confirmed public availability and starting fives | effective-dated public status, source, published_at, observed_at, confirmed starter and anticipated participation; no private medical records |
| P0 | Eligibility and roster transactions | season-specific athlete IDs, transfer/commitment/enrollment dates, eligibility/redshirt/waiver status, suspensions, graduation and effective dates; participation-name tables do not supply this |
| P0 | Source identity and membership verification | season-specific school/team/player crosswalks with confidence, conflicting mappings, conference membership and division; quarantine ambiguous names and IDs |
| P0 | Lineup/possession reconciliation | action-level ordered events, substitutions and corrections; independently verify reconstructed counts, five-player identities, clock coverage and player minutes |
| P0 | Settlement rules/results | market-specific overtime, push/void, cancellation, abandonment, listed-player and book rules, settled_at; truthful expected value and backtests |
| P1 | Preseason and player-development context | verified age/class/experience, returning minute share, recruiting and transfer cohorts, coaching/style changes; use licensed/public permitted data and information dates |
| P1 | Opportunity and defensive tracking | potential assists, rebound chances, touches, shot-clock context, defender distance, matchup coverage, screen assists and play types; not inferred from simple box scores |
| P1 | Travel and local environment | exact venue coordinates, timezone, elevation, flight/travel schedule if public, neutral/campus identity, time-zone change and true rest intervals |
| P1 | More history with consistent definitions | additional seasons, conference/division changes, rule regimes, corrections and changing event coverage; current native core covers only 2024–2026 end-years |
| P1 | Historical bookmaker closing prices | synchronized line/odds timestamps, market rules and source latency; evaluate closing-price comparisons without future inputs |
| P1 | Registered roster profile history | height, weight, position, jersey and effective dates; avoid assuming publisher name-only participation rosters are full roster/profile data |
| P2 | Officials and coaching context | verified assignment publication time, crew, foul/free-throw tendencies with shrinkage, coaching tenure/style and public announcements |
| P2 | Full raw play-by-play/reconstruction internals | publisher parser version, inferred substitution logs, dropped events, QA/error flags and complete event text; shots/possessions/stints alone do not prove reconstruction correctness |
| P2 | Market microstructure | ordered quote changes, limits, suspension windows and latency; do not label movement as sharp money without evidence |

Extended schema files are contracts, not extra observations. Never populate absent fields with fabricated values or zeros. Current data coverage and discrepancies are measured in COVERAGE.json.
