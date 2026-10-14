# EdgeDesk NBA quantitative data pack

Actual 2025–26 NBA public-source game records and detailed game observations, plus reproducible derived features and implementation instructions. Read COVERAGE.json for measured counts and missing detail IDs. This is a dataset foundation, not a trained or validated betting model.

## Open in Claude

Upload this ZIP and instruct Claude to follow CLAUDE_NBA_START_HERE.md against my existing repository. It contains the full implementation prompt. Unzip before loading data. Install pyarrow; pandas.read_parquet or pyarrow.parquet.read_table can read the files. All columns use strings to preserve native IDs, compound values and missing observations. Parse numeric fields explicitly. Null is unknown. 'True'/'False' are text booleans.

## Actual tables

- games: final scoreboard records, teams, scores, native season/competition metadata, venue and detail-availability flag.
- team_boxscores: every native team statistic supplied by the detailed boxscore, preserved under source field names.
- player_boxscores: supplied player minutes, shooting tuples, scoring, boards, assists, turnovers, steals, blocks, fouls, +/- and starter/DNP flags.
- play_by_play: all returned ordered actions, period/clock, scoring, teams, actor references, native attempted points, factual action descriptions and coordinates.
- shots_and_free_throws: native shootingPlay subset, including free throws. Not an independent source. Do not add it to play-by-play as additional observations.
- substitutions: native substitution subset of play-by-play. Not verified complete lineup stints.
- period_scores: native scoreboard period scoring.
- officials: final-game officials when supplied, not pregame assignment history.
- team_measured_features: four-factor inputs and rates, possession/rating proxies, scoring reconciliation.
- team_pregame_lags: strictly prior games only, 5/10/20-game unweighted means and elapsed days between starts. These are warm-start features with short opening windows, not opponent-adjusted trained ratings.
- player_measured_features: native minutes, parsed attempts/makes, per-36 rates and true-shooting proxy. Native whole-minute reporting is not second-precise exposure.
- player_pregame_lags: prior 5/10/20 positive-minute games, mean minutes, pooled per-36 rates and prior different-team game counts. DNP rows are retained in observations, excluded from rate denominators.
- core_supplement_* (when needed): alternate-source factual plays, shooting actions and long-format team/player statistics for games whose site summaries failed. Use sources/core_supplement.json and COVERAGE.json to resolve game coverage. This supplement is not included in the primary measured/lagged features; re-normalize native core definitions before extending those features. Do not treat omitted primary rows as zero statistics.

sources/inventory.json lists exact columns, rows and checksums. sources/field_inventory.json records each field's actual null coverage. schemas/ contains broader future table contracts; it is not additional measured data. scripts/collect.py is a cache-first collection/rebuild program for the selected season, with up to 20 concurrent public requests and recorded failures. Caches outside this ZIP are optional; new runs refetch them. Scripts are not a continuously running live feed. Build in order: python scripts/collect.py, python scripts/player_features.py, python scripts/core_supplement.py, python scripts/package.py. Run the feature/supplement scripts once after each fresh collector run, which resets the inventory.

## Methods and constraints

Use (provider=ESPN, league=NBA, game_id) for identity; player/team IDs are also provider-native. Games join detailed tables on game_id; player rows additionally use player_id/team_id. Sort event sequence numerically within game, not lexical event IDs. Participants may not specify roles: never assume the first participant is the shooter. Native scoring flags can be reconciled to descriptions but are not tracking labels. Invalid large coordinate sentinels are null; remaining coordinate orientation/units are unverified.

Possession proxy = mean of each side's FGA - offensive rebounds + total turnovers + .44*FTA. Ratings divide final points by this proxy, times 100. This is an approximation, not an official possession count. eFG=(FGM+.5*3PM)/FGA; offensive rebound fraction=ORB/(ORB+opponent DRB); defensive rebound fraction=DRB/(DRB+opponent ORB); FT rate=FTA/FGA. Zero denominators remain null. Pace proxy scales estimated possessions to 48 minutes using 48+5*(last_period-4), where period score coverage is present. Player TS proxy=points/[2*(FGA+.44*FTA)]. Native percentage boxscore strings use the provider's display scale (typically 0–100); computed fractions use 0–1. Native FG, 3PT and FT player cells are made-attempted tuples, not decimals. Team lagged rate features are arithmetic means of game rates, not pooled counts. Player per-36 lags pool count/minute exposure. Game features become usable after those games finish and source publication is established, not at their tipoff.

Native season type 2 can include a Cup final; final tables identify its scope separately using native competition type CC/39. Play-In uses native type 5 and playoffs type 3. All-Star/preseason and non-club teams are excluded. Prior-game histories include all measured club competition scopes as performance exposure, not official regular-season aggregates. Filter scopes for official records and investigate competition-regime differences before modeling. Public source pagination/metadata and missing summaries mean coverage must be assessed from the manifest, not assumed complete.

Historical known_at is missing. Source wallclock is action time, not first publication or guaranteed receipt. Collection timestamp is recorded in sources/collection.json. No live odds, licensed tracking, confirmed availability history, exact stints or trained shot-quality probabilities are included. MISSING_DATA.md prioritizes acquisition.

## Sources

Factual game observations: public ESPN site API, base https://site.api.espn.com/apis/site/v2/sports/basketball/nba/ ; per-game source is summary?event=GAME_ID and monthly selection is scoreboard?dates=YYYYMM&limit=1000. Endpoint is undocumented and may change. Public availability does not establish a redistribution/commercial license; review provider terms before deployment. No private proprietary quant methodology is claimed.

Alternate public factual source for missing details: https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/ . Exact request URLs are in sources/core_supplement.json; this remains the same provider, not independent verification.

Terminology reference: NBA statistical glossary https://www.nba.com/stats/help/glossary . Competition scope reference: https://www.nba.com/news/nba-cup-101 . The supplied proxies and source-derived calculations are explicitly distinguished from official NBA advanced/tracking products. See scripts for exact formulas.
