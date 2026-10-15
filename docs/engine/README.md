# The multi-sport engine — NHL first, every sport honest

> Research, not picks. EdgeDesk prices games with its own sport-specific
> models, says exactly how far each one has been validated, and names the
> strongest supported opportunity across sports — or says PASS and why.

This build adds a shared engine (`engine/`, `lib/edgedesk_sport_brains.js`,
`lib/edgedesk_xboard.js`), a complete NHL brain (`hockey/`), and two research
panels in the app (Research → Other → **NHL** and → **Engine**). It reuses
the existing pieces unchanged: the odds gateway and its quota
(`supabase/functions/odds_gateway`), the calibration library
(`lib/edgedesk_calibration.js`), the parquet bridge pattern, the research
shell, the sports config (`lib/edgedesk_sports.js`, now with NHL in coverage)
and the artifact-commit procedure (`tools/ci/push_generated.sh`).

| Document | What it covers |
|---|---|
| [`NHL.md`](NHL.md) | The NHL model card: data, method, the walk-forward record, limits |
| [`NBA.md`](NBA.md) | The dedicated NBA engine: model card and build report (data, seventeen candidates, the sealed walk-forward, props, pricing, panel, limits) |
| [`NBA_RESEARCH.md`](NBA_RESEARCH.md) | The NBA source review: Rithmm, the AnzaAbbasi repository as anti-patterns, nba_api and data rights, formulas, literature |
| [`METHODS.md`](METHODS.md) | Every sport's researched method, with sources and why it fits |
| [`DATA.md`](DATA.md) | Schemas, sources, licensing, update cadence, cost, quotas, provenance |
| [`DATAPACK.md`](DATAPACK.md) | How the EdgeDesk Quant Data Pack was integrated, step by step, and what it could not supply |
| [`NHL_AUDIT.md`](NHL_AUDIT.md) | The NHL audit and dependency map that preceded the research-engine build (2026-10-13) |
| [`NHL_LAB.md`](NHL_LAB.md) | Every NHL challenger (A–G) against production, the feature ablation, the score-distribution tests, two amendments, every market's held-out status, diagnostics |
| [`NHL_PROPS.md`](NHL_PROPS.md) | NHL player-prop research: model, record, disclosures |
| [`NHL_SOURCES.md`](NHL_SOURCES.md) | The data-source registry, authorisation, the box-score reconciliation, what each dataset adds |
| [`NHL_OPERATIONS.md`](NHL_OPERATIONS.md) | Jobs, switches, costs, deployment, model versioning, rollback, monitoring |

## Implementation checklist

| # | Item | State |
|---|---|---|
| 1 | Inspect the repository, data access and existing models | done (findings below) |
| 2 | NHL ingestion: versioned schema, backfill 2010-11 → today, provenance, `known_at`, dedupe, freshness, retries, quotas, breaker | done |
| 3 | NHL xG model, walk-forward | done |
| 4 | NHL ratings, goal model, score distribution, every market's fair price | done |
| 5 | Walk-forward validation with leakage audit, baselines, calibration, bootstrap intervals | done |
| 6 | Market test harness (no-vig close, ROI with pushes, CLV) | done — **blocked on data**: no licensed closing archive |
| 7 | Live slate with goalie scenarios, uncertainty, invalidators; append-only ledger and grader | done |
| 8 | Readiness registry for 11 sports (soccer removed 2026-10-15), computed from evidence | done |
| 9 | Cross-sport board: shrinkage, selection-adjusted bar, sanity, correlation, PASS | done |
| 10 | NHL price capture through the gateway, disabled by default | done — **needs authorisation** to spend |
| 11 | UI: NHL and Engine panels, filters, reasoning, sources, readiness | done (Chromium, desktop + 390 px) |
| 11b | The AI desk answers NHL questions from the slate (`hockey/desk.js` → `nhlTurn`, deterministic, no model call) | done in code; **needs a redeploy** of `edgedesk_ai` |
| 12 | CI: tests on every PR, 3-hourly build, weekly validation | done (`.github/workflows/nhl.yml` tests, `nhl-build.yml`, `nhl-validate.yml`) |
| 13 | The Quant Data Pack imported and verified (44/45 tables; NFL 2022 play-by-play arrived empty) | done (`datapack/quant_v1`, `tools/datapack/verify.js`) |
| 14 | NHL temporal rule (blank `known_at`, explicit availability, RETRO), lineups, ESPN cross-check, canonical contracts | done |
| 15 | Basketball ×4, soccer ×5 (removed 2026-10-15), MLB brains walk-forward on multi-season free sources, reconciled with the pack | done |
| 16 | UFC, college baseball, tennis | measured or recorded as insufficient — **no model claimed** |
| 17 | Board v2: pushes, voids, split settlement, sensitivity gate; the six-rung readiness ladder in the UI | done |
| 18 | Missingness diagnostics; CI for the lab (`.github/workflows/lab.yml` tests, `lab-build.yml`, `lab-validate.yml`) | done |
| 19 | The NHL Data Pack (ESPN, full 2024-25) imported and verified (11/11 tables, 34/34 checks); reconciled event by event against my feed; the blocked-shot attribution error it exposed fixed across every season; officials and the pack's lagged features measured | done (`datapack/nhl_v1`, `tools/datapack/verify_nhl.js`, `hockey/crosscheck/`, `hockey/research/`) |
| 20 | The NFL Data Pack (nflverse 2025-2026, 2026 partial) imported and verified (42/42 files, 18/18 checks, every derived table recomputed from play-by-play); reconciled with games.csv and my live team-week input; GSIS↔PFR↔ESPN crosswalk; offseason carryover and QB-change research | done (`datapack/nfl_v1`, `tools/datapack/verify_nfl.js`, `football/nfl/pack_crosscheck.js`, `football/nfl/research/`) |
| 21 | NHL research engine: audit; box scores, periods and reconciliation; model lab (logistic, trees, ensembles, distribution shape, ablation, promotion rule); two amendments (period profile, parsimony); full market sheet incl. alternates and the first period; exact explanation of every price; market-comparison labels; diagnostics and drift; player-prop research; source registry and access requests; Supabase warehouse (off until authorised); tabbed game page with in-browser scenarios | done (`NHL_LAB.md`, `NHL_PROPS.md`, `NHL_SOURCES.md`, `NHL_OPERATIONS.md`) |
| 22 | The dedicated NBA engine (`nba/`): warehouse 2002-03 → today, lineups and shots from play-by-play, seventeen candidates on a sealed walk-forward, one distribution for every market, props, scenarios, the panel, the desk, the `nbahist` schema, CI | done (docs/engine/NBA.md); prices and value **need authorisation and a market archive** |

## What I found in the repository first

- **Football is mature**: NFL and CFB engines, the linemaker's held-out
  calibration, a pricing kernel with tiers against the close, a staking
  engine. Against the close, only the NFL spread is LEAN (break-even history),
  and the staking engine keeps it in SHADOW.
- **MLB** has a browser-only run model with no walk-forward validation
  (`mlb/params.js`: `walk_forward: false`).
- **Tennis** has an outcome-validated model but was retired as a product on
  2026-09-27; its archive licence is non-commercial.
- **UFC** has research but no model of its own.
- **NBA, WNBA, both college basketball, NHL, soccer** had no data and no model.
- The odds account spent 99% of a month's credits in 9.5 days in October
  (`docs/odds-api-incident-2026-10/INCIDENT.md`); every paid request now goes
  through one gateway. Nothing in this build adds spend by default.
- This build environment can reach `raw.githubusercontent.com` only: the NHL
  API, MoneyPuck, the Odds API, ESPN and Kaggle are refused by its egress
  policy. The history therefore comes from the public sportsdataverse mirror
  of the NHL's own feeds; the NHL API client is wired for CI and degrades to
  the mirror when unreachable.

## Readiness today (computed, `engine/registry.json`)

| Sport | State | Why |
|---|---|---|
| NHL | **Validated vs outcomes** — moneyline, puck line | 7,945 held-out games, beats a tuned Elo; totals and 3-way provisional; **never tested against the close** |
| NBA | **Validated vs outcomes** — moneyline, spread, total | 11,546 held-out games (2018-2026); beats Elo (−0.0023, 95% −0.0043 to −0.0003) |
| Men's college basketball | **Validated vs outcomes** — all three | 47,123 held-out games; beats Elo by 0.033 log loss |
| Women's college basketball | **Validated vs outcomes** — all three | 44,014 held-out games; beats Elo by 0.049 |
| WNBA | Validated vs outcomes — spread, total | the moneyline does not beat Elo with a clean interval |
| NFL | Validated vs outcomes — spread | against the close LEAN (break-even), not ahead |
| College football | Validated vs outcomes — total | behind the close |
| MLB | Validated vs outcomes — run line only | **the moneyline does not beat Elo out of sample** (worse by 0.0016); totals over-confident; 2024 has no starters |
| College baseball | Research only | a 313-game sample: no model |
| UFC / MMA | Research only | one year (138 scorable bouts): Elo indistinguishable from a coin flip |
| Tennis | Retired | outcome-validated model archived |

**No sport may claim betting value today.** Nothing has beaten a closing
market, because no licensed closing archive exists here. The board therefore
answers **PASS**; the ladder in the Engine panel shows, sport by sport, which
rungs are reached (data loaded · model trained · validation passed · tested
against the close · a fresh verified price now · an actionable signal).

## How to run

```
npm run nhl:backfill     # every season since 2010-11 (≈300 MB parquet, pyarrow), xG, team games
npm run nhl:tune         # ratings hyperparameters, SELECTION window only
npm run nhl:validate     # walk-forward record + market test (NO_ARCHIVE until one is added)
npm run nhl:ingest       # the season in progress only
npm run nhl:quotes       # NHL prices — spends nothing unless NHL_PRICES=on
npm run nhl:slate        # fair prices for the next 72 h, ledger, grades
npm run engine:board     # registry + cross-sport board
npm run datapack:check   # the pack verifies (and npm run datapack:test)
npm run lab:ingest       # basketball, MLB history (free sources, cached)
npm run lab:validate     # every lab walk-forward record (tuning files kept)
npm run lab:slates       # basketball fair prices, missingness, registry, board
npm run lab:test         # the lab suite (protocol, brains, settlement, ladder)
npm run nhl:test && npm run engine:test && npm run nhl:sql && npm run engine:e2e   # nhl:test includes the desk through the real handler
npm run nhl:check && npm run engine:check
npm run nba:backfill     # every NBA season since 2002-03 (≈545 MB parquet, pyarrow), lineups
npm run nba:tune         # ratings, players and ML hyperparameters, SELECTION window only
npm run nba:validate     # the sealed walk-forward record, the props record, the live parameters
npm run nba:ingest       # the season in progress only
npm run nba:quotes       # NBA prices — spends nothing unless NBA_PRICES=on
npm run nba:slate        # fair prices, props, ledger, grades
npm run nba:test && npm run nba:sql && npm run nba:e2e && npm run nba:check
```

## Blocked, and the exact steps to unblock

1. **NHL prices (spend).** Run in the Supabase SQL editor:
   `supabase/nhl_odds_sport.sql` (registers `icehockey_nhl` disabled), then
   `select public.odds_api_set_sport('icehockey_nhl', true);` and set the
   repository variable `NHL_PRICES=on`. One `featured` call is ≈3 credits; the
   gateway's cadence reuses its snapshot (20 min within 3 h of a game, up to
   6 h further out), so the 3-hourly job costs at most ≈24 credits a day.
   Withdraw with `odds_api_set_sport('icehockey_nhl', false)`.
2. **NHL market test.** Obtain a licensed archive of timestamped NHL closing
   prices (e.g. The Odds API historical odds, ≈10 credits per snapshot per
   market, only with explicit authorisation — or a licensed dataset), write
   it to `hockey/market/closing/<season>.csv` (schema in `DATA.md`) and run
   `npm run nhl:validate`. The record, the registry and the board pick up the
   result automatically; only `TESTED_AHEAD` with n ≥ 500 enables NHL value.
3. **Confirmed goalies.** No confirmed-starter feed is wired. Record a
   confirmed starter, with its source and time, in
   `hockey/data/confirmed_starters.json` (schema in `DATA.md`); the slate
   replaces the projection.
4. **Licensing.** The NHL data originates from the NHL's public feeds; NHL.com
   terms restrict commercial use. Review before NHL output is sold in a paid tier.
5. **Market tests for every sport.** Add a licensed, timestamped closing
   archive per sport; until then every market stays `NOT_TESTED` and value
   claims stay off. Basketball prices are not captured at all (the
   gateway allowlist has no row for them).
6. **Lineups and availability.** No injury or lineup feed exists for any
   sport. NHL confirmed lineups measurably help (−0.0009 log loss) but arrive
   only at warmups; wiring a pregame lineup feed would let the price use them.
7. **NFL 2022 play-by-play.** The upload was empty; re-send the archive or run
   `npm run datapack:fetch` (accepted only if nflverse still serves the exact
   bytes).
8. **UFC.** An authorised fight-statistics feed or a multi-year results archive
   (UFCStats refuses automated access and is not bypassed).

## The desk

`hockey/desk.js` is inlined into `supabase/functions/edgedesk_ai/index.ts`
(`node tools/presentation/inline.js`). `nhlTurn` answers any NHL question —
"What's your price on Devils at Red Wings?", "Is Detroit −140 any good in
hockey?", "Penguins −1.5 +180", "Best NHL bet tonight?" — from
`hockey/slate.json`: my fair prices, the goalie situation, the record, and for
a quoted price the break-even and EV, always with "value claims are off". It
runs before the research plan's out-of-scope answer, whose sport list
predates the NHL brain. A shared nickname (Rangers, Jets, Kings, Panthers) or
a city counts only with hockey context or an NHL game on screen; a
cross-sport question stays with the all-sports scan. `EDGEDESK_NHL=0` turns
it off. It reaches readers only after the function is redeployed.

## The data pack

`datapack/quant_v1` is the pack as shipped (minus the out-of-git NFL
play-by-play); `DATAPACK.md` maps each of its instructions to the code and the
evidence. `EDGEDESK_VERIFICATION.json` and `EDGEDESK_CROSSCHECK.json` are its
quality record.

## Rollback

The panels are inert without their two `app.html` registrations; the NHL
artifacts and the board are read-only files. Removing `nhl` from
`EDSPORTS.RESEARCH_COVERAGE` (and re-running `node tools/presentation/inline.js`)
restores the previous coverage sentence. The gateway row stays disabled until
someone enables it.
