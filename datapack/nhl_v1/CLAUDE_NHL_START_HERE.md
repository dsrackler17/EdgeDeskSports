# Integrate this NHL pack into my EdgeDesk Linemaker AI

Read README.md, COVERAGE.json, docs/MISSING_DATA_PRIORITY.csv and sources/ACCESS_AND_RIGHTS.md first. This package contains NHL historical facts and measured/lagged features; it is not a trained or validated oddsmaker.

Inspect my existing repository and preserve working infrastructure. Integrate the factual data, canonical schemas and NHL features. Reuse existing caches before adding provider calls. Keep measured facts, engineered features, learned probabilities and AI explanations separate. I am the sole founder; use I/my.

1. Import stable source player/team IDs and source provenance. Audit the 32-club scope and game-type counts. The NHL endpoint can include national-team exhibition events; those do not belong in club models. Never count a shootout conversion as a normal team/goalie goal.
2. Use shooting_team_id on shot records, not always the native event team: on blocked attempts the provider's native team can be the defending team. Preserve multiple assister roles. Strength labels such as Even Strength do not prove five-on-five. Source shot type extracted from description is an engineered text label, not a structured provider value.
3. Map native units explicitly and preserve nulls. TOI has measured seconds parsed from native mm:ss. Do not invent xG, GSAx, starting goalie confirmation, shifts, tracking, injuries or bookmaker prices.
4. Fill P0 gaps in priority order with authorized sources or transparent own models. Required goalie and lineup reports need pregame timestamps. Build a regularized, out-of-sample-calibrated shot model if no authorized xG feed is available. Freeze its version and training interval. Build strength-state scoring/exposure models after sufficient shifts/manpower data exist.
5. Train a separate NHL regulation scoring distribution and OT/shootout component. Produce fair regulation 3-way and incl-OT moneyline prices separately, then puck lines/totals. Player props require separate validated opportunity/TOI models.
6. Evaluate on chronological heldout games, with all ratings/feature transforms trained on past data only. Shipped lagged tables exclude target-event stats but are retrospective because publication/revision times are unknown. Do not claim strict historical availability certification or validated betting performance.
7. Add current odds only from verified fresh quotes under my existing API budget. Return independently useful research without odds; no verified price means no current EV claim. Select a bet only if supported probability, price, uncertainty and settlement rules justify it; otherwise PASS.
8. Put actual NHL research and readiness states into the existing Linemaker interface. Work through implementation and verification, not a plan. Finish with evidence, remaining access gaps and deployment requirements.

Do not declare NHL complete merely because these files exist. Never show a stale 2024-25 projection as a current-season bet.
