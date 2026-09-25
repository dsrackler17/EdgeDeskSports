# EdgeDesk football data enrichment

This layer makes EdgeDesk **know more** before it scores how much it trusts a
college projection. It moves no projection: nothing here is read by the
engine, the input contract or the pricing request. The board-and-build parity
test (`tools/football/page_build_parity.test.js`) holds that line.

It feeds three things:

- `lib/cfb_reliability.js`, the reliability score;
- the research card (the DATA COVERAGE block);
- the diagnostics (`admin/data-health/`, `npm run cfb:reliability`).

## The pipeline

```
RAW SOURCES          providers/*.js — one adapter per source, each with its own health
  -> NORMALIZATION   one availability vocabulary, one QB evidence shape, one quote shape
  -> IDENTITY        players to ESPN athlete ids on the current roster; teams to the engine key
  -> SOURCE AGREEMENT  the availability and QB hierarchies; conflicts detected, resolved only where permitted
  -> FRESHNESS       each value on its own clock; last-known values carried and marked STALE
  -> EVIDENCE        coverage classes, confirmation levels, importance/impact, FCS bridge, market quality
  -> GAME PACKAGE    football/enrichment/current.json games[id]  (read by lib/game_evidence.js)
  -> PROJECTION      untouched
  -> RELIABILITY     football/fbs/build_coverage.js and the board score each game from its package
```

`build_enrichment.js` runs before `football/fbs/build_coverage.js`, in:

- `.github/workflows/football-weekly-build.yml`, the full build;
- `.github/workflows/football-enrichment.yml`, the refresh on the scheduler's windows.

## Never fake coverage

These rules are enforced in code and pinned in `enrichment.test.js`:

| Is not | The same as |
|---|---|
| a provider failure | a healthy roster (`PROVIDER_FAILED`, coverage 0, each failure named) |
| a missing record | an available player (UNKNOWN, unless a fresh **comprehensive** official report for **this fixture** omits him) |
| no conflicting source | a confirmed starter (CONFIRMED needs fresh Tier 1) |
| one quote | a consensus |
| an unrated player | a replacement-level player (impact UNKNOWN, charged by role importance) |
| a missing FCS rating | an average FCS team |
| this run's egress refusal | the provider's auth failure (`EGRESS_BLOCKED`, attributed to the run) |

## The pieces

| File | What it owns |
|---|---|
| `config.js` | every rule: vocabularies, source tiers, QB hierarchy, TTLs, refresh windows, coverage scale, importance, FCS thresholds, ROI costs |
| `core/lineage.js` | a value with its provenance: source, tier, `observed_at` / `retrieved_at`, TTL, stale, carried |
| `core/health.js` | call classification and the seven provider states, plus NOT_CHECKED |
| `core/cache.js` | the persistent evidence cache (`cache/evidence_cache.json`): current and previous value, clocks, TTL, carry limits |
| `core/scheduler.js` | refresh windows: >72h, 24–72h, 6–24h, <6h, <90 min (final pass), FROZEN after kickoff |
| `core/provider.js` | the provider contract (`configured`, `healthCheck`, `fetchTeam`/`fetchGame`, `normalize`) and the one bounded HTTP call |
| `providers/availability.js` | the conference reports, team releases, beat reporting, ESPN injuries/depth/participation, and operator adapters |
| `providers/qb.js` | observed starts, the EPIR ranking, operator announcements, provider depth chart, team news, and beat adapters |
| `providers/market.js` | `cfb.lines` (every provider), the capture's signals, The Odds API, and the lines archive adapters |
| `availability/status.js` | the ten states: AVAILABLE … UNKNOWN |
| `availability/aggregator.js` | `injury_evidence` → `player_availability` → `team_availability_summary` |
| `qb/resolver.js` | `away_qb_expected` / `home_qb_expected`: sources, conflict, resolution, confirmation, calibrated probability or null |
| `impact/starters.js` | projected starters (a base 11+11+K/P formation), key contributors, `player_quality_coverage_pct` |
| `impact/player_impact.js` | `absence_importance_score` and category; impact KNOWN or UNKNOWN |
| `fcs/bridge.js`, `fcs/build_fcs.js` | FCS teams on EdgeDesk's scale through cross-division games; walk-forward against the floor |
| `../../lib/market_consensus.js` | consensus, median, modal, best available, dispersion, outliers, market quality (UMD: board and build) |
| `../../lib/game_evidence.js` | the game evidence package and the DATA COVERAGE view (UMD: board and build) |
| `roi.js` | the reliability improvement planner: ENRICHMENT ROI |
| `audit.js` | the self-audit after every refresh: twelve counts, what improved or degraded, and why |

## Artifacts

| File | What it holds |
|---|---|
| `current.json` | the per-game packages, provider health, coverage summary and refresh schedule. This is what the board and the build read. |
| `current.full.json` | every evidence record: `injury_evidence` by team, `player_availability` and absences by fixture side, the full QB resolution |
| `fcs_ratings.json` | every FCS team: `fcs_team_rating`, `rating_sd`, `fcs_rating_confidence`, `fcs_games_sample`, `fcs_fbs_bridge_sample`, `data_completeness`, `last_updated` |
| `../validation/fcs_bridge_cfb.json` | the walk-forward, bridge against floor, game by game |
| `audit.json` | the latest audit, the previous counts and 60 runs of history |
| `cache/evidence_cache.json` | the last value actually observed for each key, with its original clocks |

## The QB hierarchy

The tiers live in `config.js QB_TIERS` and are configurable:

| Tier | Evidence |
|---|---|
| 1 | an official announcement, an official depth chart, a coach's announcement |
| 2 | trusted beat reporting, a conference or team availability report |
| 3 | a major sports-data provider's depth chart |
| 4 | a depth-chart aggregator |
| 5 | the observed start in the previous game; below it, EdgeDesk's own quality ranking. The ranking is an opinion about who is *better*, not evidence about who *starts*. |

A disagreement is resolved automatically only in these cases:

- **AUTHORITY:** a higher tier, fresh;
- **OBSERVED_OVER_MODEL:** a decisive observed start, 65%+ of the dropbacks, is the only thing the quality ranking disagrees with;
- **INJURY:** the higher-ranked name is ruled out;
- **LATER_FILING:** two filings at the same tier, an hour or more apart.

Anything else is **CONFLICTED**. Both sides are published, and reliability applies the contested cap.

A stale Tier 1 never beats a fresh observation, and Tier 5 never beats a fresh Tier 1.

`starter_probability` comes only from the measured persistence rates (`football/starters/persistence.json`). A confirmation label is never read as a probability.

## The FCS bridge

The model is estimated one season at a time:

- **Scale:** FBS teams are fixed at EdgeDesk's own ratings, so the scale is not refit.
- **Structure:** FCS teams sit within conferences, which sit within the FCS.
- **Data:** cross-division games carry the scale across; FCS-vs-FCS games order the field.
- **Engine constants:** margins use the engine's cap, home field is the engine's, and the season carry is the engine's.
- **Posterior:** it is solved exactly, so every team has its own standard deviation.

The rating is **shadow**. Two things keep it that way:

- **Pricing:** the engine still prices every FCS side from the shared floor (-28). Promoting the bridge into pricing is a decision for a person, made on `football/validation/fcs_bridge_cfb.json`.
- **Reliability:** it reads the floor's *measured* error, √(gap² + sd²).
  - The perturbation uses that error in place of the flat ±8.
  - THIN DATA lifts only when a STRONG rating corroborates the priced floor, which means the floor sits within one standard deviation.

## Running it

```
npm run cfb:fcs              # FCS bridge + walk-forward (reads GitHub-hosted schedules)
npm run cfb:enrich           # evidence packages (live provider checks)
npm run cfb:enrich:offline   # from committed artifacts and the evidence cache only
npm run cfb:fbs              # re-score reliability from the packages (+ self-audit)
npm run cfb:enrich:audit     # print the self-audit
npm run cfb:enrich:test      # the rules
npm run cfb:reliability      # the dashboard, with the ROI plan
```

## Adding a source

- **Availability:** register an official team release or a beat source in `football/availability/sources.overrides.json`. The `team_official` and `beat_reporting` adapters stop reading NOT_CONFIGURED as soon as a URL exists.
- **A person's verified fact:** record it with `football/availability/record_correction.js` (`operator.json`). Use kind AVAILABILITY for a player's status, or STARTER for a quarterback.
  - A confirmed entry from an official source is Tier 1 (QB) or a manual verified override (availability).
- **Market:**
  - set `ODDS_API_KEY` for the build to enable per-book quotes;
  - `cfb.lines` and the capture are read with the board's public read-only key.
