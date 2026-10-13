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
| [`METHODS.md`](METHODS.md) | Every sport's researched method, with sources and why it fits |
| [`DATA.md`](DATA.md) | Schemas, sources, licensing, update cadence, cost, quotas, provenance |

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
| 8 | Readiness registry for 12 sports, computed from evidence | done |
| 9 | Cross-sport board: shrinkage, selection-adjusted bar, sanity, correlation, PASS | done |
| 10 | NHL price capture through the gateway, disabled by default | done — **needs authorisation** to spend |
| 11 | UI: NHL and Engine panels, filters, reasoning, sources, readiness | done (Chromium, desktop + 390 px) |
| 11b | The AI desk answers NHL questions from the slate (`hockey/desk.js` → `nhlTurn`, deterministic, no model call) | done in code; **needs a redeploy** of `edgedesk_ai` |
| 12 | CI: tests on every PR, 3-hourly build, weekly validation | done (`.github/workflows/nhl.yml`) |
| 13 | Other sports' brains | researched and designed; **not built** (see the registry) |

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
| NHL | **Validated vs outcomes** | Moneyline and puck line pass every pre-registered rule on 7,945 held-out games and beat a tuned Elo; totals and 3-way are provisional; **never tested against the close** |
| NFL | Validated vs outcomes | Spread calibrated vs outcomes; against the close LEAN (break-even), not ahead |
| College football | Validated vs outcomes | Total calibrated vs outcomes; behind the close |
| MLB | Experimental | A model exists, never validated out of sample |
| College baseball | Research only | Data, no validated model |
| UFC / MMA | Research only | Data, no model (the only probability is the market's) |
| NBA, WNBA, men's and women's college basketball, soccer | Unavailable | No data or model wired |
| Tennis | Retired | Outcome-validated model archived; product retired |

**No sport may claim betting value today.** A value claim needs a market
that beat the no-vig close out of sample (`MARKET_VALIDATED`). The board
therefore answers **PASS** and says why; it lists the closest research
candidate and the price it would need.

## How to run

```
npm run nhl:backfill     # every season since 2010-11 (≈300 MB parquet, pyarrow), xG, team games
npm run nhl:tune         # ratings hyperparameters, SELECTION window only
npm run nhl:validate     # walk-forward record + market test (NO_ARCHIVE until one is added)
npm run nhl:ingest       # the season in progress only
npm run nhl:quotes       # NHL prices — spends nothing unless NHL_PRICES=on
npm run nhl:slate        # fair prices for the next 72 h, ledger, grades
npm run engine:board     # registry + cross-sport board
npm run nhl:test && npm run engine:test && npm run nhl:sql && npm run engine:e2e   # nhl:test includes the desk through the real handler
npm run nhl:check && npm run engine:check
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
5. **Other sports.** Each registry entry lists its blockers and enable steps;
   none can be built responsibly from this environment (no reachable data).

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

## Rollback

The panels are inert without their two `app.html` registrations; the NHL
artifacts and the board are read-only files. Removing `nhl` from
`EDSPORTS.RESEARCH_COVERAGE` (and re-running `node tools/presentation/inline.js`)
restores the previous coverage sentence. The gateway row stays disabled until
someone enables it.
