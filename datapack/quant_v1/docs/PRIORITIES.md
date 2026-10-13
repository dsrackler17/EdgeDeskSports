# Important data first

P0 is the minimum evidence needed to price a sport: accurate identities and event rules, pre-event availability, sport-specific opportunity/exposure, verified historical results, and timestamped executable quotes for betting value. P1 improves resolution: opponent adjustment, role, fatigue, detailed event geometry, and stable splits. P2 is costly or sparse tracking/charting.

Do not try to buy every stat before establishing an out-of-sample baseline. Collection priority is a hypothesis; measured predictive value is determined by chronological ablation, calibration, uncertainty and cost. Additional fields can hurt if sparse, redundant, retrospectively revised or a source of leakage.

1. Establish IDs, season/competition, scheduled and actual times, final status, overtime/regulation/retirement rules.
2. Collect raw opportunity denominators before percentage stats. Preserve attempts, minutes, possessions, outs and active fight time.
3. Capture official availability/lineups with report timestamps. Never backfill current roster status into earlier games.
4. Collect sport-specific event facts and build prior-event aggregates with exposure weights and shrinkage learned on training folds.
5. Collect reliable quotes without exhausting the existing odds budget. Market value is unavailable when fresh quotes are absent.
6. Add P1/P2 only if source rights, coverage and validation justify it.

NHL first: five-on-five shot/chance data, confirmed goalie, PP/PK exposure, rest/travel and current line combinations. Boxscore save percentage cannot substitute for a calibrated shot-quality goalie model. This package supplies native sample event/boxscore facts, not invented expected goals.
