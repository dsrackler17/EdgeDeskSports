# Remaining useful NHL data, important first

These are acquisition requirements, not empty files pretending to contain observations.

## P0 — Timestamped executable odds

Status: Not included.

Needed: Moneyline incl OT, regulation 3-way, puck line, totals, props, line/rules/time/book.

Source: Existing EdgeDesk odds cache or authorized odds feed.

Purpose: Required for EV, CLV and actual bet selection; no fresh price means research only.

## P0 — Confirmed starting goalies

Status: Not included as pregame reports.

Needed: goalie_id, announcement time, source, confidence/status, expected replacement.

Source: Official team announcements / authorized goalie confirmation feed.

Purpose: Native boxscore flags are retrospective and cannot prove pregame confirmation.

## P0 — Historical injury and lineup reports

Status: Not included.

Needed: player_id, team_id, reported_at, status, role, expected TOI, replacement.

Source: Official timestamped archive / authorized news feed.

Purpose: Current availability cannot be used as historical availability.

## P0 — Shift charts / on-ice player counts

Status: Native endpoint returned 403.

Needed: player_id, shift start/end, period, goalie pulls, penalties, on-ice skaters.

Source: Authorized NHL shifts / licensed tracking.

Purpose: Needed to distinguish 5v5 from 4v4/3v3 and calculate strength-state exposure.

## P0 — Calibrated shot expected goals

Status: Not included; xg stays blank.

Needed: Shot model inputs/version, goal probability, uncertainty, heldout calibration.

Source: Own leakage-audited shot model or approved commercial xG feed.

Purpose: MoneyPuck commercial permission required; native attempt counts are not xG.

## P0 — Goalie assignment for every shot and goal

Status: Partially observed; missed/goal records may lack goalie participant.

Needed: goalie_id at every goal/attempt, goalie-pulled state, exposure.

Source: Shift/goalie-change timeline or authorized complete shot feed.

Purpose: Do not assign every goal to the first goalie or infer empty net from missing ID.

## P0 — Complete time-stamped team-line combinations

Status: Not included.

Needed: line_id, players, projected vs confirmed, report_at, deployment.

Source: Official practice/game lineup archive / authorized lineup feed.

Purpose: Use for minutes and availability scenarios, not roster-name guesses.

## P0 — Historical first publication/model revisions

Status: Not reconstructed.

Needed: known_at, retrieved_at, revision, model_version, source training period.

Source: Source archive / original timestamped snapshots.

Purpose: Current download time is not historical known_at; lagged features remain retrospective.

## P0 — Current-season and multi-season form

Status: This collection targets 2024-25 only.

Needed: 2022-23 onward plus current completed games; roster continuity and revisions.

Source: Same authorized feeds with verified competition coverage.

Purpose: One season supports exploration, not robust live calibration for 2026.

## P1 — Venue coordinates and travel

Status: Venue labels collected; coordinates/trips not verified.

Needed: lat/lon, previous venue, distance, timezone shifts, travel schedule.

Source: Verified venue registry + actual travel information.

Purpose: Do not infer actual travel itinerary from scheduled venues alone.

## P1 — Shot geometry units and rink orientation

Status: Native coordinates present; physical frame not certified.

Needed: units, axis origin, attacking direction by period/team, goal location.

Source: Provider coordinate documentation.

Purpose: Do not silently use x/y as feet or assign nearest goal for own-zone attempts.

## P1 — Penalty timing and strength exposure

Status: Penalty events and team totals present; full manpower timeline missing.

Needed: penalty type, duration, coincidental/double-minor/major, expiry, goal termination.

Source: NHL native penalty/shift feed.

Purpose: Penalty minutes alone cannot reconstruct PP/PK exposure correctly.

## P1 — Rebound/rush/one-timer flags

Status: Not supplied as verified labels.

Needed: prior-shot relation, possession/team switch, goalie rebound, lateral puck motion.

Source: Authorized event/optical feed or explicitly validated reconstruction.

Purpose: A short shot interval is a candidate proxy, not a verified rebound.

## P1 — Player impact and replacement level

Status: Not trained.

Needed: Offense/defense impact, uncertainty, TOI-weighted replacement scenario.

Source: Own regularized on-ice model using complete shifts.

Purpose: Point totals and plus/minus are not isolated player impact.

## P1 — Shot-level empty-net flags

Status: Source flag retained where supplied; otherwise missing.

Needed: goalie present, attacking team, skater counts, pull timestamp.

Source: Goalie-pull/shift feed.

Purpose: Empty-net rates must be separated from normal goalie shots.

## P1 — Outcome settlement rules and limits

Status: Not included.

Needed: OT/SO inclusion, push/void/participation rules, max stake, line availability.

Source: Bookmaker rules and authorized quote metadata.

Purpose: Cannot compare regulation and incl-OT prices as the same market.

## P2 — Controlled entries/exits, pass events and screens

Status: Not included.

Needed: entry outcome, possession, pass coordinates, screen/deflection, forecheck.

Source: Authorized tracking/charting.

Purpose: High-value optional features after baseline validation.

## P2 — NHL EDGE tracking export

Status: Not collected as a bulk dataset.

Needed: Skating/shot speed, distance, zone time, starts and coverage definitions.

Source: Authorized NHL EDGE/Sportradar access.

Purpose: Public dashboards are not assumed to grant commercial bulk export rights.

## P2 — Faceoff matchup deployment

Status: Native faceoff events/box totals collected; detailed context incomplete.

Needed: taker/opponent, zone, strength, score state, possession outcome.

Source: Authorized event/shift feed.

Purpose: Faceoff percentage alone should not dominate model selection.

