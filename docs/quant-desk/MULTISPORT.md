# The multi-sport quant desk — model first, market second (2026-10-15)

"What's the best researched opportunity tonight?" used to be answered from NFL
and college football alone. This document records why, what was rebuilt, how the
new pipeline keeps EdgeDesk's own projections independent of sportsbook prices,
and what the acceptance runs measured. Everything here is checked by
`tools/intelligence/multisport.test.js`, `multisport_host.test.js` and
`projections_sql.test.js`.

## 1. Why only NFL and college football were scanned

The Quant Desk's cross-sport scan (`quantScan` in
`supabase/functions/edgedesk_ai/index.ts`) was a **price scanner**. Its only input was
`sweepBoard`, which builds the board from captured sportsbook prices, so a sport with
no captured prices could not be researched at all. The causes, in code order:

| # | Where | What it did |
|---|---|---|
| 1 | `Dal.getSlateIndex` | Had a schedule source only for the NFL (`football/nfl/slate.json`), CFB (`football/fbs/slate.json` + `cfb.games`) and MLB (`games`). Every other sport read `games?sport_key=…`. `games` is the MLB table and has no `sport_key`, so the read failed, and the code **fell back to the captured `signals` as the schedule**. |
| 2 | capture allowlist | `signals` hold only NFL, CFB, MLB and UFC (`capture/index.ts DEFAULT_SPORTS`). The NHL and NBA gateway rows are inserted disabled. NHL/NBA/WNBA/NCAAB therefore had zero "games" and read `NOT_CAPTURED`. |
| 3 | `sweepBoard` | Model pricing (`priceBoardGames`, EDPRICE) only ran for NFL and CFB. Every other sport could only be `MARKET_DEVIG`, which needs a captured price. |
| 4 | `EDQUANT.candidatesFromBoard` | Dropped every candidate without an executable quote. Research needed a price. |
| 5 | `lib/edgedesk_sport_adapters.js` (EDADAPT) | Listed `model: null` for NBA, WNBA, NCAAB and NHL. Those engines had since been built and are scheduled (`nhl.yml`, `nba.yml`, `lab.yml`), but the registry never caught up. |
| 6 | `nhlTurn` / `nbaTurn` | The NHL and NBA engines were wired to the desk only as single-sport question answerers, never into the cross-sport scan. |
| 7 | `today/slate.json` | The multi-sport ESPN schedule, which already linked each event to its engine, was never read by the desk. |

On 2026-10-15 the effect was exact. The legacy answer read "Scanned: NFL (1 game),
college football (3 games) … NOT scanned: NHL (prices not captured)", while NHL had
11 games and an outcome-validated model. `multisport_host.test.js` reproduces this on
the day's committed data.

## 2. Where sportsbook prices were used, and what changed

| Use of a price | Location | Now |
|---|---|---|
| **Triggered research**: a game existed only if a price did | `getSlateIndex` fallback to `signals`; `candidatesFromBoard` | Events come from the schedule (`today/slate.json`, ESPN scoreboard) and each engine's own slate (`EDMULTI.discover`). Prices are read only after the projections are frozen. |
| **Generated a "fair" probability** | `MARKET_DEVIG` (sharp/consensus no-vig); EDPRICE `MODEL_BLEND` (`football/nfl/slate.json pricing.rows[].fair_line` ≈ −0.38 + 1.157·market + 0.232·(model − market)); `lib/edgedesk_xboard.js` posterior; card feed `k·model + (1−k)·market` | EdgeDesk's fair price is the engine's own number only (`model_*`, `prices.*`). A no-vig number is a `SHARP_MARKET_REFERENCE`, reported beside the model and never in its slot. The captured-price audit survives as a section labelled **MARKET BENCHMARK (market-derived)**. The card feed now says "Model–market blend X% (EdgeDesk model Y%, …)" and carries `probability_basis: MODEL_MARKET_BLEND`. |
| **Decided the initial favourite** | board candidates ranked by market EV | The favoured side is the engine's (`EDMULTI.researchFor`). |
| **Stood in for a missing model** | `MARKET_DEVIG` for MLB/UFC/NHL | No model means `MODEL_UNAVAILABLE` with the reason. Nothing is filled in. |
| **Influenced a "projection"** | NFL pricing rows (blend); xboard posterior | The adapters never read those blocks. The contamination test (§7) removes them, or replaces them with absurd prices, and every projection hash stays identical. |
| **Excluded sports** | `coverageStatus` → `NOT_CAPTURED` | Price coverage and research coverage are separate. "Which sports couldn't be scanned?" now reports both. |

What the engines themselves do was audited (2026-10-15):

- **No market input in the projection:** NHL (`hockey/build_slate.js:166-172`), NBA
  (`nba/model/*`; the ESPN reference line is used only in a walk-forward MAE
  diagnostic), the basketball lab, soccer, the NFL engine (`fbPredict` is called with an
  empty market) and the CFB engine.
- **One disclosed caveat:** the NFL and CFB margin distributions take their *shape* from
  historical closing spreads and are re-centred on the model's own margin. This is
  stated on every NFL projection (`distribution.shape_note`).

## 3. The pipeline

```
sports data → each sport's engine (scheduled builds) → EDPROJ: one contract per event
            → FREEZE (SHA-256 per projection and per snapshot) → projection_snapshots row
            → only now: prices (capture's signals, the scoreboard snapshot)
            → EDMKT: compare the frozen snapshot, re-check its hash → market_comparisons rows
            → EDMULTI: rank research and execution separately → the answer
```

| File | Role |
|---|---|
| `lib/edgedesk_projections.js` (EDPROJ) | The universal research registry (`SPORTS`: discovery, providers, stats, availability, simulation, markets, freshness limit, key role, unsupported reasons), one adapter per engine, the **model output contract** (`edgedesk_independent_projection_v1`), research assessment, freeze/hash, the capability matrix. |
| `lib/edgedesk_market_compare.js` (EDMKT) | The quote taxonomy, identity verification, freshness, EV / break-even / no-vig / max entry (exact, through EDFAIR), the conservative probability, the seven execution outcomes, the execution gates. |
| `lib/edgedesk_multisport.js` (EDMULTI) | Calendar windows in the reader's zone, discovery, fundamental research per matchup, the two rankings, coverage, the answer. `prepare()` (no price) and `complete()` (prices) are separate calls. |
| `engine/build_projections.js` | Scheduled (`.github/workflows/projections.yml`, every 3 h after the NHL/NBA builds). Freezes every engine's projections into `engine/projections.json` and appends new hashes to `engine/projections_ledger/<YYYY-MM>.jsonl`. Its reader **refuses** any non-engine path. |
| `supabase/independent_projections.sql` | `projection_snapshots` and `market_comparisons`: write-once, reader-owned, RLS. A trigger refuses a comparison unless the same reader stored, earlier, a snapshot holding that projection id **and hash**. A projection carrying any market input is refused. `VERIFIED_POSITIVE_EV` needs a live, timestamped quote. Rollback: `independent_projections_rollback.sql`. |

**Model output contract.** Every projection carries:

- event id, sport, league or competition, UTC start and its basis;
- `model {id, version, artifact, artifact_generated_at, predicted_at, inputs_known_at, kind: INDEPENDENT, market_inputs: []}`;
- outcome probabilities, fair moneyline / spread / total, projected score;
- the distribution's own spread and total lines (only lines the engine publishes; an alternate line keeps its own validation);
- simulation method and convergence;
- uncertainty (model, calibration, lineup);
- validation per market from `engine/registry.json` and the engine's own record;
- availability assumptions and conflicts, matchup factors and context;
- provenance with authority (`OFFICIAL` only for a league's own feed; nflverse is `THIRD_PARTY`, its injury data a `THIRD_PARTY_MIRROR`);
- freshness, invalidators, limitations, sensitivity (the engine's own one-input re-runs) and integrity.

**Research outcomes:** `RESEARCH_READY`, `RESEARCH_CONDITIONAL` (key roles unconfirmed, an
experimental primary market, early season, a starter conflict), `DATA_INSUFFICIENT` (an
expired build, stale inputs, low completeness) and `MODEL_UNAVAILABLE`. Model confidence
(validation state, n, held-out log loss, calibration σ) and freshness (build age, inputs
known through) are reported separately.

**Quote kinds** (never interchangeable): `LIVE_SPORTSBOOK_QUOTE`,
`CAPTURED_SPORTSBOOK_QUOTE`, `SHARP_MARKET_REFERENCE`, `CONSENSUS_REFERENCE`,
`HISTORICAL_CLOSING_PRICE`, `INDEPENDENT_MODEL_PROJECTION`, `ESTIMATED_FAIR_PRICE`.

- Only the first two are executable.
- A "live" read older than 10 minutes is downgraded to captured.
- The scoreboard's lines are always captured, because their `captured_at` is the fetch time.

**Execution outcomes**, checked in this order:

1. `NO_CURRENT_ODDS`
2. `STALE_PRICE` (past 60 min, untimed, or inside the 2-minute start guard)
3. `INSUFFICIENT_MODEL_RELIABILITY` (not independent, invalidated, an expired build, or a market or line not outcome-validated)
4. `NO_VERIFIED_EDGE` (EV ≤ 0)
5. `MARKET_WATCH` (positive only at the point estimate, or past the 15% sanity ceiling)
6. `CONDITIONAL_EDGE` (clears 2% on the conservative probability with at least one gate open)
7. `VERIFIED_POSITIVE_EV`

The `VERIFIED_POSITIVE_EV` gates are: a market validated against the close, the key role
confirmed, a live quote, two or more books clearing the floor, and an adversarial audit
that **completed and verified** the evidence.

**Ranking** (published with every answer):

- **Research:** READY or CONDITIONAL projections that are not invalidated. Tier 1 (primary
  market outcome- or market-validated) ranks before tier 2. Within a tier, rank by the
  conservative probability p − z·σ, with σ = √(model² + calibration² + lineup²) from the
  projection's own validation and z = Φ⁻¹(1 − 0.10/N). Ties go to READY, then the larger
  sample.
- **Execution:** by outcome, then by EV at the conservative probability. Never by
  headline EV.
- **Three separate measurements:** research outcome, modeled probability with its σ, and
  executable edge. No "confidence %" exists.

**Switches:**

- `EDGEDESK_ODDS_DISABLED=1` turns off every price read by the quant desk: no signals, no
  scoreboard prices, no audit re-reads, no capture refresh. The research still runs.
- `EDGEDESK_MULTISPORT=0` restores the captured-price scan alone.
- The paid feed itself stays governed by `ODDS_GATEWAY_DISABLED` and the database
  `odds_api_enabled` flag.

## 4. The 2026-10-15 Seahawks @ Broncos starter

**Trace:**

1. nflverse `games.csv` named Drew Lock for SEA in weeks 2–6, but play-by-play shows Sam
   Darnold took the first dropback in weeks 3, 4 and 5.
2. `tools/football/build_nfl_slate.js` `starterOf()` took the starter from `games.csv` and
   never read `football/starters/nfl_2026.json`, even though `starter-context.yml` builds
   that file before the slate.
3. The engine therefore priced Lock: `qb_adj_diff` 0.1295, +0.74 points to Denver.
4. The depth chart reached the desk through `football/matchup/metrics.json`.
   `turnResearchPacket` let the schedule feed win (`feed ?? depth`), with the basis
   "nflverse fills it close to kickoff", which `app.html` itself contradicts. Its only
   flag was a `.conflict` string that nothing read.
5. `_analyst.js` ranks `SCHEDULE_FEED` above `DEPTH_CHART`.

**Fixes:**

- **The slate builder:** `reconcileQb()` re-runs the engine on the depth chart's QB1 when
  he took the last game's first dropback (`RECONCILED`). An uncorroborated disagreement
  is `CONFLICT`: priced on the feed and flagged, never resolved silently. A live build
  on 2026-10-15 moves DEN from +0.07 to +1.01 (win probability 0.4975 → 0.4623) and
  flags CHI@ATL and PIT@TB as unresolved conflicts. The committed `football/nfl/slate.json`
  is rebuilt by `starter-context.yml` on its next run.
- **The research layer (EDPROJ):** checks the slate's assumed starter against the depth
  chart and the first-dropback history. A disagreement **invalidates the projection for
  pricing** and holds it back from the ranking, naming both sources and their publication
  times.
- **The research packet:** a disagreement is now a `STARTER_CONFLICT` with both sources,
  never the feed winning silently.
- **Labels:** nflverse data is never called "official" by default. Injuries read "the NFL
  injury report via nflverse (third-party mirror)".

**"Unverified … final status PASS":** `_agents.js` printed `Final status: PASS (audit:
UNVERIFIED)`. Each candidate now prints three separate lines:

- `Audit execution: COMPLETED | FAILED | NOT RUN`
- `Evidence verification: VERIFIED | PARTIALLY VERIFIED | NOT VERIFIED | REJECTED`
- `Trade execution eligibility: ELIGIBLE | NOT ELIGIBLE — decision: …`

`classify()` returns the same three fields, and the narration critic guards the
eligibility line.

## 5. Coverage matrix (2026-10-15, measured)

| Sport | Engine (artifact) | Status | Primary-market validation (held-out) | Events on 10-15 (Chicago) | Researched | Prices | Notes and blockers |
|---|---|---|---|---|---|---|---|
| NHL | edgedesk_nhl_v1:xg_core (`hockey/slate.json`) | OPERATIONAL | moneyline OUTCOME_VALIDATED, n 7,945, LL 0.663 vs 0.691 climatology; puck line validated; totals PROVISIONAL | 11 | 11 | scoreboard snapshot only (stale by 8 AM); NHL capture off | goalies projected (32/33 uncertain), no injury feed |
| NBA | edgedesk_nba_v1:G_stack_P (`nba/slate.json`) | OPERATIONAL | ML/spread/total OUTCOME_VALIDATED (test n 11,543, LL 0.618 vs 0.687) | 2 (preseason) | 0 | — | preseason not modelled; regular season from 10-20 (14 projected) |
| WNBA | edgedesk_bb_points_v1 (`basketball/slate.json`) | OPERATIONAL, no events | ML PROVISIONAL; spread/total validated | 0 | — | — | next game 10-17 |
| NCAAM / NCAAW | edgedesk_bb_points_v1 | OPERATIONAL, no events | OUTCOME_VALIDATED | 0 | — | — | season starts 11-02 |
| NFL | edgedesk_football_v1.0.0 (`football/nfl/slate.json`) | OPERATIONAL | spread OUTCOME_VALIDATED (break-even vs close); ML/total EXPERIMENTAL | 1 | 1 (held back) | stale | SEA@DEN starter conflict |
| CFB (FBS) | edgedesk_cfb_p4 (`football/fbs/slate.json`) | OPERATIONAL | ML EXPERIMENTAL (behind close) | 3 | 3 | stale | spread/total distributions not published |
| Soccer | edgedesk_soccer_dc_v1 (`soccer/slate.json`, 5 leagues) | OPERATIONAL, inputs stale | 1X2 PROVISIONAL | 18 (Europa League) | 0 | — | UEL/UCL/MLS not modelled; league results stale since 09-20 → DATA_INSUFFICIENT |
| MLB | none per game | MODEL_UNAVAILABLE | (history engine RL validated through 2025) | 2 (postseason) | 0 | scoreboard | no 2026/postseason inputs; browser run model unvalidated |
| College baseball | cbase_v1 | out of season | ML OUTCOME_VALIDATED (holdout) | 0 | — | — | release gates closed |
| UFC / MMA | none | MODEL_UNAVAILABLE | Elo does not beat a coin flip (n 138) | 0 | — | capture | — |
| FCS | none | NOT SUPPORTED | — | — | — | — | FBS-vs-FCS games are on the FBS slate |
| Tennis | retired 2026-09-27 | RETIRED | — | — | — | — | — |
| Golf | none | NOT SUPPORTED | — | — | — | — | no data source |

`engine/projections.json` carries the same matrix (`capability_matrix`), rebuilt every
three hours.

## 6. Acceptance (`docs/quant-desk/acceptance/*.json`)

**Commands:**

- `npm run quant:replay` — a point-in-time replay: every artifact as committed at or
  before 2026-10-15T13:00Z (8 AM CDT), with any artifact generated later refused.
- `node tools/quant/multisport_run.js --tz America/Chicago [--odds off]` — the committed
  artifacts at run time. No network: this environment cannot reach the site or any odds
  provider.

| Measure | Replay 13:00Z | Live 14:45Z | Live, odds off |
|---|---|---|---|
| Sports discovered (events in window) | 6 | 6 | 6 |
| Sports with operational models | 8 | 8 | 8 |
| Eligible games | NHL 11, NBA 2, NFL 1, CFB 3, soccer 18, MLB 2 | same | same |
| Research evaluations / independent projections | 15 / 15 | 15 / 15 | 15 / 15 |
| Valid sportsbook price captures | 0 (62 seen, all stale) | 0 (62, stale) | 0 (none read) |
| Verified positive EV | 0 | 0 | 0 |
| Best researched | NHL CGY@VGK, VGK 66.4% (σ 1.9%, conservative 61.8%) | same | same |
| Snapshot hash | fbb6ff59… | fbb6ff59… | fbb6ff59… (prices never move a projection) |

The replay and live runs agree because no artifact changed between 13:00Z and 14:45Z.
No verified edge is possible today on any sport. No EdgeDesk model has been tested
against a licensed closing archive (`value_claims` is false everywhere), and no live
quote is reachable from this environment. That is reported, not papered over.

## 7. Tests

| Suite | Proves |
|---|---|
| `tools/intelligence/multisport.test.js` (108) | Discovery, routing, events without prices, prices without a model, stale quotes, missing lineups, conflicting starters (slate and builder), injuries, expired builds, provider outages, quota exhaustion, no-event days, EV / break-even / no-vig / max price (exact, EDFAIR parity), ranking consistency, audit semantics, time zones (Chicago, New York, DST, European kick-offs), market contamination, freeze immutability, identity, the VERIFIED gates. |
| `tools/intelligence/multisport_host.test.js` (35) | The real handler on the 10-15 fixture. The legacy desk reproduces all four Oct 15 defects (NFL-only focus, no independent projection, stale quote, starter disagreement) and the new desk shows none. The snapshot is written **before** the first price read. Comparisons carry the frozen hashes. With `EDGEDESK_ODDS_DISABLED=1` no price endpoint is touched, all 15 projections are produced with the identical snapshot hash, and every market reads NO CURRENT ODDS. |
| `tools/intelligence/projections_sql.test.js` (43) | The migration on PostgreSQL 16, applied twice, attacked and rolled back. |
| `tools/intelligence/quant_ui.e2e.js` (59) | The real handler's answers in Chromium at 1280 px and 390 px, including the Oct 15 multi-sport answer. The chip is the multi-sport verdict (research only), with the captured-price status on a separate labelled "Benchmark:" chip. The per-sport coverage list is open, and the page never scrolls sideways. |
| Existing suites | `npm run ai:test` (47 suites, the two above included), `npm run quant:sql`: green. |
