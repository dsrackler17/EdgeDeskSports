# EdgeDesk men's college basketball quantitative data pack

Actual public-source data for NCAA men's college basketball, with 2024–2026 end-year core history (2023–24 through 2025–26), richer 2026 event/lineup statistics, prior-game features, source QA and a Claude implementation prompt. This is a data foundation, not a trained or validated betting brain.

## Upload and use

Keep all three ZIPs. Each is under 30,000,000 bytes. Upload them to Claude together or one at a time; all are parts of this same sport. Ask Claude to extract them into the same parent folder and follow CLAUDE_COLLEGE_BASKETBALL_START_HERE.md in my existing EdgeDesk repository. Shared documentation is repeated; the data files are partitioned, not duplicated across ZIPs. PARTS.json lists the exact table assignment. Python with pyarrow/pandas can read Parquet directly; do not paste whole datasets into chat context.

All native source fields and types are retained through lossless Parquet recompression, with exact-value roundtrip checks and hashes. Numbers remain numbers, timestamps retain their source types, null means unknown. Native percentage scales and IDs vary by table. Inspect sources/inventory.json and sources/field_inventory.json before joins or interpretation.

## What is populated

| Dataset family | Seasons | Actual contents |
|---|---|---|
| ESPN team box scores | 2024, 2025, 2026 | 59 native fields: shooting makes/attempts, points, rebounds, assists, blocks, steals, fouls, turnovers, paint/fast-break/turnover points and opponent context |
| ESPN player box scores | 2024, 2025, 2026 | 55 native fields: minutes, shots, scoring, boards, assists, steals, blocks, turnovers, fouls, starter/DNP/ejection/status and provider IDs |
| ESPN schedules | 2024, 2025, 2026 | Native results, time, venue, neutral/conference context, native conference IDs, periods, tournament/status fields and source availability markers |
| ESPN shot archive | 2026 | Event type, period/clock, raw/transformed coordinates, native scoring flag/value, participant references and team context |
| NCAA-derived team details | 2024, 2025, 2026 | 81 fields: offensive/defensive possession counts, efficiencies, rim/midrange/three mix, rebounding, assist/turnover/block rates, possession lengths and crosswalks |
| NCAA-derived player details | 2026 | 125 fields: rim/midrange/three and putback counts, transition/half-court, assisted/unassisted splits, shooting efficiency, opportunities, minutes and provider IDs |
| NCAA-derived lineup units | 2026 | 77 fields: five-player names, interval exposure, own/opponent shot mix, possession and scoring/factor counts; reconstruction requires QA |
| NCAA-derived matchup stints | 2026 | Paired lineups, period, clock interval, duration, possessions and start/end scores |
| NCAA-derived possessions | 2026 | Offensive team, scoring, lineup slots/IDs, timing, transition/assist/garbage-time classifications and ESPN crosswalks |
| Publisher RAPM | 2024, 2025, 2026 | Season-level offensive/defensive/net regularized adjusted plus-minus, exposure and estimand; full-season fits are not historical pregame features |
| NCAA name-based participation rosters | 2024, 2025, 2026 | Player/team names and games; not a confirmed registered/current roster or eligibility feed |
| NCAA schedule and team references | 2024, 2025, 2026 | Contest IDs/results and season-specific school/conference references |
| EdgeDesk measured/lagged tables | All core seasons; player lags 2026 | Team four factors, possession/pace proxies, neutral/D1-reference context, prior 5/10/20-game histories, player pooled per-40 rates and minute exposure |
| Cross-source audit | All core seasons | Game/team shooting-score discrepancies between publisher reconstructions and ESPN box scores; do not silently overwrite either source |

See COVERAGE.json for actual row/game counts and source gaps. Table/field existence is not a guarantee of complete observations. The archives include D1 teams playing other opponents: independently verify division membership for the intended modeling universe. No fabricated sample rows or invented expected-shot probabilities are included.

## Important interpretation rules

Men's regulation is 40 minutes in two halves; overtime is 5 minutes. The native period-count distribution is audited. Do not use NBA quarter/48-minute logic or assume a publisher documentation sentence applies correctly across men's/women's data.

The possession proxy is the average of each side's FGA-ORB+totalTOV+.44*FTA. This is a generic boxscore approximation, not an official/fitted NCAA possession count. Offense/defense ratings are points per 100 proxy possessions. eFG=(FGM+.5*3PM)/FGA; ORB%=ORB/(ORB+opponent DRB); DRB%=DRB/(DRB+opponent ORB); FT rate=FTA/FGA. Pace proxy scales to 40 minutes using native regulation/OT period counts. Null/zero denominators remain null.

Team lagged features are unweighted means of prior valid game rates within the same season; they are not opponent-adjusted ratings. Player lags pool prior positive-minute counts per 40 minutes, exclude DNP/zero-minute/ambiguous identity history, retain small-window sample counts and flag prior different-team games. Current/future games are excluded. Historical publication times are absent: chronological tipoff order is not point-in-time certification. Complete game stats become usable only after game completion and source publication.

The lineup player_count_error field is all-null, so it proves nothing about lineup quality. Slot/name/duration checks are provided, not independent confirmation of correct substitutions or exposure. NCAA detailed tables are derived by the publisher's parser/aggregation/modeling pipeline; transition, rim, assists, garbage time, possessions and RAPM are not direct optical-tracking measurements. Inspect source discrepancy and QA reports before modeling.

In the shot archive, score_value may be positive on a missed shot. Scoring_play and event semantics must gate scored points; even that requires verification before reconstructing score. Coordinate transforms/raw court frames and the roles of athlete_id_1/2 require validation. Do not assume the second athlete is always an assister or the first is always a correctly mapped shooter.

Never use final-season RAPM, records, rankings, source backfilled context or end-of-season rosters as pregame predictors for earlier games in that season. Refit within folds or use a subsequent-season prior with verified identity and roster alignment. Source team_year and provider team-season IDs are not universal school identities.

## Rebuild and remaining inputs

Install requirements.txt. Run scripts/compact_sources.py, scripts/build_features.py, then scripts/audit_and_package.py. The source manifest pins released byte hashes: source release assets can change, so a hash mismatch should stop and require an explicit version review. The compactor downloads missing assets; it does not continuously refresh live feeds. For earlier-season player lags, use --player-seasons 2024 2025 2026; doing so changes output/upload size and requires repartitioning.

Missing executable odds, publication chronology, confirmed availability/lineups, eligibility/transfers, true tracking and settlement history are prioritized in MISSING_DATA_PRIORITY.md. No bet probability, edge, profit or model validation is implied by this archive.
